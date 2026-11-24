// Android native local media & podcast import pipeline (M1.2):
// - Media/SRT file picking & multi-track probing via Kotlin MediaBridge
// - Foreground dataSync service protection (MediaProcessingService) with notification progress & cancel
// - Resumable chunked cloud ASR (transcribe_plan / transcribe_piece / transcribe_finalize)
// - Own .srt attachment fast-path (skips cloud ASR & saves quota)
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { readTextFile } from '@tauri-apps/plugin-fs';
import type { VideoRecord } from '../../types';
import type { PodcastImport } from '../../utils/importJob';
import { getAllVideosFromDB } from '../../utils/fileSystemAccess';
import { t } from '../../utils/i18n';
import { resegment, type Word } from '../../utils/resegment';
import { splitLongLines } from '../../utils/splitLong';
import { parseSRT } from '../../utils/srtParser';
import { androidCloudArgs, getTranscribeConfig } from '../../utils/transcribeConfig';
import * as VideoStorage from '../../utils/videoStorage';
import { errText } from '../ui';
import {
  callAndroid,
  isAndroidNative,
  onAndroidEvent,
  type AudioTrackInfo,
  type ExtractedAudio,
  type ProbeTracksResult,
} from './androidBridge';
import { writeCacheText } from './desktop';

export interface CutPiece {
  index: number;
  fromSample: number;
  toSample: number;
  offsetMs: number;
}

export interface TranscribePlan {
  planId: string;
  lang: string;
  pieceSecs: number;
  wavSamples: number;
  pieces: CutPiece[];
  doneIndices: number[];
}

export interface PickedMedia {
  uri: string;
  probe: ProbeTracksResult;
}

export interface PickedSrt {
  name: string;
  text: string;
  count: number;
}

export interface LocalImportArgs {
  uri: string;
  displayName: string;
  trackIndex: number;
  lang: string;
  srtText?: string;
  srtName?: string;
}

interface AndroidPaths {
  ownDir: string;
  mediaDir: string;
  clipsDir: string;
  tmpDir: string;
}

// ---- Pure helpers (unit-tested in mobile/test-import-android.mjs) ----------

/** Picks the first default supported track, else the first supported track, else -1. */
export function selectDefaultTrack(tracks: AudioTrackInfo[]): number {
  let firstSupported = -1;
  for (const tr of tracks) {
    const supported = tr.supported !== false;
    if (!supported) continue;
    if (firstSupported < 0) firstSupported = tr.index;
    if (tr.isDefault) return tr.index;
  }
  return firstSupported;
}

/** Validates an attached .srt file and optionally splits over-long non-CJK lines. */
export function validateAndPrepareSrt(rawText: string, splitLong: boolean): { text: string; count: number } {
  const cleaned = rawText.replace(/^\uFEFF/, '');
  const initial = parseSRT(cleaned);
  if (initial.length === 0) throw new Error('srt:empty');
  const text = splitLong ? splitLongLines(cleaned) : cleaned;
  const count = parseSRT(text).length;
  if (count === 0) throw new Error('srt:empty');
  return { text, count };
}

/** Computes remaining pieces to upload from a resumable TranscribePlan. */
export function computePendingPieces(plan: TranscribePlan): {
  pending: CutPiece[];
  doneSet: Set<number>;
  doneCount: number;
  totalCount: number;
} {
  const validIndices = new Set(plan.pieces.map(p => p.index));
  const doneSet = new Set<number>();
  for (const idx of plan.doneIndices ?? []) {
    if (validIndices.has(idx)) doneSet.add(idx);
  }
  const pending = plan.pieces.filter(p => !doneSet.has(p.index));
  return {
    pending,
    doneSet,
    doneCount: doneSet.size,
    totalCount: plan.pieces.length,
  };
}

/** Normalizes an arbitrary error thrown during Android import into a stable error code. */
export function parseAndroidImportError(err: unknown): { code: string; codec?: string } {
  const raw = (err instanceof Error ? err.message : String(err ?? '')).trim();
  if (!raw) return { code: 'cloud:unknown' };
  if (raw.startsWith('audio:unsupported_codec:')) {
    const codec = raw.slice('audio:unsupported_codec:'.length).trim() || 'unknown';
    return { code: raw, codec };
  }
  if (raw === 'audio:no_track') return { code: 'audio:no_track' };
  if (raw === 'audio:reimport') return { code: 'audio:reimport' };
  if (raw === 'srt:empty') return { code: 'srt:empty' };
  if (raw === 'cancelled') return { code: 'cancelled' };
  if (raw === 'interrupted') return { code: 'interrupted' };
  if (raw === 'cloud:nokey') return { code: 'cloud:nokey' };
  if (raw === 'cloud:missing-url') return { code: 'cloud:missing-url' };
  if (raw.startsWith('download:')) return { code: raw };
  return { code: raw };
}

/** Formats Android-specific and shared cloud import error codes into user-facing copy. */
export function formatAndroidImportError(code: string): string {
  const parsed = parseAndroidImportError(code);
  if (parsed.codec) return t('m.errUnsupportedCodec', { codec: parsed.codec });
  if (parsed.code === 'audio:no_track') return t('m.errNoTrack');
  if (parsed.code === 'audio:reimport') return t('m.errReimportFile');
  if (parsed.code === 'cloud:missing-url') return t('m.errCustomUrl');
  if (parsed.code === 'cancelled') return t('m.errCancelled');
  if (parsed.code === 'srt:empty') return t('m.srtEmpty');
  if (parsed.code.startsWith('download:')) {
    return t('m.errDownload', { msg: parsed.code.slice('download:'.length).slice(0, 120) });
  }
  return errText(parsed.code);
}

// ---- Subscription & native event singleton ---------------------------------

const listeners = new Set<() => void>();
const activeJobs = new Set<string>();
const cancelledJobs = new Set<string>();
const interruptedJobs = new Set<string>();
let nativeListenersInstalled = false;

const MAX_SRT_BYTES = 10 * 1024 * 1024;

const notify = () => listeners.forEach(fn => {
  try { fn(); } catch (e) { console.error('[importAndroid listener]', e); }
});

function ensureNativeEventListeners() {
  if (nativeListenersInstalled || !isAndroidNative()) return;
  nativeListenersInstalled = true;
  onAndroidEvent<{ jobId?: string }>('processingCancelled', payload => {
    const id = payload?.jobId;
    if (!id) return;
    cancelledJobs.add(id);
    invoke('android_cancel_job', { id, permanent: false }).catch(() => {});
    setJob(id, { error: 'cancelled' }).then(notify, console.error);
  });
  onAndroidEvent<{ jobIds?: string[] }>('processingTimeout', payload => {
    const ids = Array.isArray(payload?.jobIds) ? payload.jobIds : [...activeJobs];
    for (const id of ids) {
      interruptedJobs.add(id);
      invoke('android_cancel_job', { id, permanent: false }).catch(() => {});
      setJob(id, { error: 'interrupted' }).then(notify, console.error);
    }
  });
}

export function notifyAndroidImports(): void {
  notify();
}

export function subscribeAndroidImports(fn: () => void): () => void {
  ensureNativeEventListeners();
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// ---- Internal helpers ------------------------------------------------------

const setJob = (id: string, patch: Partial<NonNullable<VideoRecord['importJob']>>) =>
  VideoStorage.updateVideoWith(id, r => {
    if (!r.importJob) return null;
    const next = { ...r.importJob, ...patch };
    if (patch.error === undefined && 'error' in patch) delete next.error;
    return { ...r, importJob: next };
  });

function requireCloudConfig() {
  const cfg = getTranscribeConfig();
  const args = androidCloudArgs(cfg);
  if (args) return args;
  if (cfg.mode === 'custom' && !cfg.customUrl.trim()) {
    throw new Error('cloud:missing-url');
  }
  throw new Error('cloud:nokey');
}

async function getPaths(): Promise<AndroidPaths> {
  return invoke<AndroidPaths>('android_paths');
}

async function fileExistsNonEmpty(path: string, minBytes = 1): Promise<boolean> {
  try {
    const info = await callAndroid<{ exists: boolean; sizeBytes: number }>('media.fileInfo', { path });
    return !!info.exists && (info.sizeBytes ?? 0) >= minBytes;
  } catch {
    return false;
  }
}

async function removeSafe(path: string): Promise<void> {
  await callAndroid('media.removeFile', { path }).catch(() => {});
}

async function cleanupJobTmpFiles(id: string, tmpDir: string, pieceCount: number): Promise<void> {
  const paths = [
    `${tmpDir}/${id}.wav`,
    `${tmpDir}/${id}.wav.tmp`,
    `${tmpDir}/${id}.plan.json`,
    `${tmpDir}/${id}.plan.json.tmp`,
    `${tmpDir}/${id}.collapse.srt.tmp`,
  ];
  for (let i = 0; i < pieceCount; i++) {
    paths.push(
      `${tmpDir}/${id}.piece.${i}.m4a`,
      `${tmpDir}/${id}.piece.${i}.m4a.tmp`,
      `${tmpDir}/${id}.piece.${i}.json`,
      `${tmpDir}/${id}.piece.${i}.json.tmp`,
    );
  }
  await Promise.all(paths.map(removeSafe));
}

function baseName(uriOrPath: string): string {
  const clean = uriOrPath.split('?')[0].split('#')[0];
  const seg = clean.split(/[\\/]/).pop() || 'subtitles.srt';
  try { return decodeURIComponent(seg); } catch { return seg; }
}

// ---- Public pickers --------------------------------------------------------

export async function pickAndroidMediaFile(): Promise<PickedMedia | null> {
  const selected = await open({
    multiple: false,
    filters: [{
      name: 'Audio / Video',
      extensions: ['mp4', 'mkv', 'mov', 'webm', 'm4v', 'avi', 'mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus'],
    }],
  });
  if (typeof selected !== 'string' || !selected) return null;
  const probe = await callAndroid<ProbeTracksResult>('media.probeTracks', { input: selected });
  const tracks = Array.isArray(probe?.tracks) ? probe.tracks : [];
  if (tracks.length === 0) throw new Error('audio:no_track');
  const defIdx = typeof probe.defaultTrackIndex === 'number' && probe.defaultTrackIndex >= 0
    ? probe.defaultTrackIndex
    : selectDefaultTrack(tracks);
  if (defIdx < 0) {
    throw new Error(`audio:unsupported_codec:${tracks[0]?.mime || 'unknown'}`);
  }
  return { uri: selected, probe: { ...probe, tracks, defaultTrackIndex: defIdx } };
}

export async function pickAndroidSrtFile(): Promise<PickedSrt | null> {
  const selected = await open({
    multiple: false,
    filters: [{ name: 'Subtitles', extensions: ['srt'] }],
  });
  if (typeof selected !== 'string' || !selected) return null;
  let localPath = selected;
  let tempCopy: string | null = null;
  if (selected.startsWith('content://') && isAndroidNative()) {
    const { tmpDir } = await getPaths();
    const copied = await callAndroid<{ path: string }>('media.copyUriToPath', {
      uri: selected,
      destPath: `${tmpDir}/picked-srt-${Date.now()}.srt`,
    });
    localPath = copied.path;
    tempCopy = copied.path;
  }
  try {
    if (isAndroidNative()) {
      const info = await callAndroid<{ exists: boolean; sizeBytes: number }>('media.fileInfo', { path: localPath });
      if (!info.exists || (info.sizeBytes ?? 0) > MAX_SRT_BYTES) throw new Error('srt:empty');
    }
    const raw = await readTextFile(localPath);
    const { text, count } = validateAndPrepareSrt(raw, getTranscribeConfig().splitLong);
    return { name: baseName(selected), text, count };
  } finally {
    if (tempCopy) await removeSafe(tempCopy);
  }
}

// ---- Public import launchers & controls ------------------------------------

export async function startAndroidLocalImport(opts: LocalImportArgs): Promise<string> {
  ensureNativeEventListeners();
  const hasOwnSrt = !!opts.srtText && opts.srtText.trim().length > 0;
  if (!hasOwnSrt) requireCloudConfig();

  const id = crypto.randomUUID();
  const now = Date.now();
  const srtCount = hasOwnSrt ? parseSRT(opts.srtText!).length : 0;
  if (hasOwnSrt && srtCount === 0) throw new Error('srt:empty');

  const rec: VideoRecord = {
    id,
    displayName: opts.displayName || baseName(opts.uri),
    videoFileName: opts.displayName || baseName(opts.uri),
    subtitleFileName: hasOwnSrt ? `${id}.srt` : '',
    subtitleText: hasOwnSrt ? opts.srtText! : '',
    currentSubtitleIndex: 0,
    currentSectionIndex: 0,
    totalSubtitles: srtCount,
    completionRate: 0,
    dateAdded: now,
    lastPracticed: now,
    totalPracticeTime: 0,
    importJob: {
      stage: 'extract',
      source: opts.uri,
      lang: opts.lang || 'auto',
      trackIndex: opts.trackIndex,
      ...(hasOwnSrt ? { subs: 'own' as const } : {}),
    },
  };
  await VideoStorage.updateVideoRecord(rec);
  notify();
  void runAndroidJob(id, { isRetry: false });
  return id;
}

export async function startAndroidEpisodeImport(
  ep: PodcastImport,
  downloadFn?: (id: string, url: string) => Promise<string>,
): Promise<string> {
  ensureNativeEventListeners();
  requireCloudConfig();

  const now = Date.now();
  const rec: VideoRecord = {
    id: ep.id,
    displayName: ep.title,
    videoFileName: ep.title,
    subtitleFileName: '',
    subtitleText: '',
    currentSubtitleIndex: 0,
    currentSectionIndex: 0,
    totalSubtitles: 0,
    completionRate: 0,
    dateAdded: now,
    lastPracticed: now,
    totalPracticeTime: 0,
    podcast: ep.podcast,
    importJob: {
      stage: 'download',
      source: ep.audio,
      lang: ep.lang || 'auto',
    },
  };
  await VideoStorage.updateVideoRecord(rec);
  notify();
  void runAndroidJob(ep.id, { isRetry: false, downloadFn });
  return ep.id;
}

export async function retryAndroidImport(id: string): Promise<void> {
  ensureNativeEventListeners();
  if (activeJobs.has(id)) return;
  await invoke('android_reset_job', { id, clearTmp: false }).catch(() => {});
  await runAndroidJob(id, { isRetry: true });
}

export async function cancelAndroidImport(id?: string, permanent = false): Promise<void> {
  const targets = id ? [id] : [...activeJobs];
  for (const jobId of targets) {
    cancelledJobs.add(jobId);
    await callAndroid('processing.cancel', { jobId }).catch(() => {});
    await invoke('android_cancel_job', { id: jobId, permanent }).catch(() => {});
    if (!permanent) {
      await setJob(jobId, { error: 'cancelled' }).catch(() => {});
    }
  }
  notify();
}

export async function markAndroidInterrupted(): Promise<void> {
  ensureNativeEventListeners();
  const records = await getAllVideosFromDB() as VideoRecord[];
  let changed = false;
  for (const r of records) {
    if (!r.importJob || r.importJob.error || activeJobs.has(r.id)) continue;
    await VideoStorage.updateVideoWith(r.id, x =>
      x.importJob && !x.importJob.error && !activeJobs.has(x.id)
        ? { ...x, importJob: { ...x.importJob, error: 'interrupted' } }
        : null,
    );
    changed = true;
  }
  if (changed) notify();
  if (isAndroidNative()) {
    await callAndroid('processing.reconcile', { keepIds: [...activeJobs] }).catch(() => {});
  }
}

// ---- Core background pipeline ----------------------------------------------

async function runAndroidJob(
  id: string,
  opts: { isRetry: boolean; downloadFn?: (id: string, url: string) => Promise<string> },
): Promise<void> {
  if (activeJobs.has(id)) return;
  activeJobs.add(id);
  cancelledJobs.delete(id);
  interruptedJobs.delete(id);

  let pieceTotalForCleanup = 0;
  let tmpDirForCleanup = '';

  const checkAlive = async (): Promise<VideoRecord> => {
    if (interruptedJobs.has(id)) throw new Error('interrupted');
    if (cancelledJobs.has(id)) throw new Error('cancelled');
    const cur = await VideoStorage.getVideoRecord(id);
    if (!cur || !cur.importJob) {
      await invoke('android_cancel_job', { id, permanent: true }).catch(() => {});
      throw new Error('cancelled');
    }
    return cur;
  };

  try {
    const initial = await setJob(id, { error: undefined });
    notify();
    if (!initial?.importJob) return;

    const paths = await getPaths();
    tmpDirForCleanup = paths.tmpDir;
    const job = initial.importJob;
    const lang = job.lang || 'auto';

    await callAndroid('processing.begin', {
      jobId: id,
      title: initial.displayName,
      detail: t(initial.podcast ? 'm.stageQueued' : 'm.stageExtract'),
      percent: -1,
    });

    // Step 1: Ensure private-storage audio exists (download podcast or extract local media track)
    let extractedPath = job.extractedPath || '';
    const hasExtracted = !!extractedPath && await fileExistsNonEmpty(extractedPath);

    if (!hasExtracted) {
      if (initial.podcast && /^https?:\/\//i.test(job.source)) {
        await setJob(id, { stage: 'download', percent: undefined, downloadBytes: 0, error: undefined });
        notify();
        await callAndroid('processing.update', {
          jobId: id,
          detail: t('m.stageDownload', { pct: 0 }),
          percent: -1,
        });
        let unlisten: (() => void) | null = null;
        try {
          if (!opts.downloadFn) {
            unlisten = await listen<{ id: string; stage: 'queued' | 'download'; percent: number | null; bytes: number }>(
              'podcast-download',
              ev => {
                const p = ev.payload;
                if (!p || p.id !== id) return;
                const detail = p.stage === 'queued'
                  ? t('m.stageQueued')
                  : typeof p.percent === 'number'
                    ? t('m.stageDownload', { pct: p.percent })
                    : t('m.stageDownloadBytes', { mb: (p.bytes / 1048576).toFixed(1) });
                void setJob(id, {
                  stage: p.stage,
                  percent: typeof p.percent === 'number' ? p.percent : undefined,
                  downloadBytes: p.bytes,
                }).then(notify, () => {});
                void callAndroid('processing.update', {
                  jobId: id,
                  detail,
                  percent: typeof p.percent === 'number' ? p.percent : -1,
                }).catch(() => {});
              },
            );
          }
          const downloaded = opts.downloadFn
            ? await opts.downloadFn(id, job.source)
            : await invoke<string>('download_podcast_audio_stream', {
              id,
              url: job.source,
            });
          extractedPath = downloaded;
          await setJob(id, { extractedPath, source: extractedPath, downloadBytes: undefined });
          notify();
        } finally {
          unlisten?.();
        }
      } else {
        if (opts.isRetry && job.source.startsWith('content://')) {
          throw new Error('audio:reimport');
        }
        await setJob(id, { stage: 'extract', error: undefined });
        notify();
        await callAndroid('processing.update', {
          jobId: id,
          detail: t('m.stageExtract'),
          percent: -1,
        });
        const res = await callAndroid<ExtractedAudio>('processing.runExtract', {
          jobId: id,
          input: job.source,
          outStemPath: `${paths.mediaDir}/${id}`,
          trackIndex: typeof job.trackIndex === 'number' ? job.trackIndex : -1,
        });
        extractedPath = res.path;
        // Persist private path immediately so retries never depend on transient content:// permissions.
        await setJob(id, { extractedPath, source: extractedPath });
        notify();
      }
    }

    await checkAlive();

    // Step 2: Fast-path when user attached their own .srt subtitles (zero cloud quota spent)
    if (job.subs === 'own') {
      const done = await VideoStorage.updateVideoWith(id, r => {
        if (!r.importJob) return null;
        if (!r.subtitleText.trim()) return null;
        const rest = { ...r };
        delete rest.importJob;
        return {
          ...rest,
          videoPath: extractedPath,
          subtitleFileName: `${id}.srt`,
          totalSubtitles: parseSRT(r.subtitleText).length,
          lastPracticed: Date.now(),
        };
      });
      if (!done) throw new Error('srt:empty');
      return;
    }

    // Step 3: Validate cloud config before spending CPU on WAV decode
    const cloud = requireCloudConfig();

    // Step 4: Decode to 16kHz mono WAV (reuse existing WAV on retry)
    const wavPath = `${paths.tmpDir}/${id}.wav`;
    if (!(await fileExistsNonEmpty(wavPath, 45))) {
      await setJob(id, { stage: 'extract', error: undefined });
      notify();
      await callAndroid('processing.update', {
        jobId: id,
        detail: t('m.stageExtract'),
        percent: -1,
      });
      await callAndroid('processing.runDecodeWav', {
        jobId: id,
        input: extractedPath,
        outWavPath: wavPath,
      });
    }

    await checkAlive();

    // Step 5: Load or create resumable chunk plan
    const plan = await invoke<TranscribePlan>('transcribe_plan', {
      id,
      mediaPath: extractedPath,
      wavPath,
      lang,
      pieceSecs: 3600,
    });
    const { pending, doneCount: initialDone, totalCount } = computePendingPieces(plan);
    pieceTotalForCleanup = totalCount;
    let doneCount = initialDone;

    await setJob(id, {
      stage: 'cloud',
      pieceDone: doneCount,
      pieceTotal: totalCount,
      percent: totalCount > 0 ? Math.round((doneCount * 100) / totalCount) : 0,
      error: undefined,
    });
    notify();

    // Step 6: Compress & upload only pending pieces (already-finished pieces stay cached on disk)
    for (const piece of pending) {
      await checkAlive();
      const stepPct = totalCount > 0 ? Math.round((doneCount * 100) / totalCount) : 0;
      await callAndroid('processing.update', {
        jobId: id,
        detail: t('m.stageChunk', { done: Math.min(doneCount + 1, totalCount), total: totalCount }),
        percent: stepPct,
      });

      const piecePath = `${paths.tmpDir}/${id}.piece.${piece.index}.m4a`;
      if (!(await fileExistsNonEmpty(piecePath))) {
        await callAndroid('processing.runCompressPiece', {
          jobId: id,
          wavPath,
          fromSample: piece.fromSample,
          toSample: piece.toSample,
          outM4aPath: piecePath,
          bitrate: 32_000,
        });
      }

      await checkAlive();
      await invoke<boolean>('transcribe_piece', {
        id,
        planId: plan.planId,
        idx: piece.index,
        piecePath,
        offsetMs: piece.offsetMs,
        provider: cloud.provider,
        apiKey: cloud.apiKey,
        baseUrl: cloud.baseUrl ?? null,
        model: cloud.model ?? null,
        lang,
      });

      doneCount += 1;
      const pct = totalCount > 0 ? Math.round((doneCount * 100) / totalCount) : 100;
      await setJob(id, { stage: 'cloud', pieceDone: doneCount, pieceTotal: totalCount, percent: pct });
      await callAndroid('processing.update', {
        jobId: id,
        detail: t('m.stageChunk', { done: doneCount, total: totalCount }),
        percent: pct,
      });
      notify();
    }

    await checkAlive();

    // Step 7: Stitch, collapse repetitions, resegment, commit record, and clean up tmp
    const finalized = await invoke<{ subtitleText: string; words: Word[] }>('transcribe_finalize', { id });
    await setJob(id, { stage: 'segment', percent: 100 });
    await callAndroid('processing.update', { jobId: id, detail: t('m.segmenting'), percent: 100 });
    notify();

    const recut = finalized.words?.length ? await resegment(finalized.words) : null;
    const finalSrt = recut && recut.trim() ? recut : finalized.subtitleText;
    if (!finalSrt || !finalSrt.trim()) throw new Error('cloud:empty');
    const cues = parseSRT(finalSrt);
    if (cues.length === 0) throw new Error('cloud:empty');

    await checkAlive();
    const finished = await VideoStorage.updateVideoWith(id, r => {
      if (!r.importJob) return null;
      const rest = { ...r };
      delete rest.importJob;
      return {
        ...rest,
        videoPath: extractedPath,
        subtitleText: finalSrt,
        subtitleFileName: `${id}.srt`,
        totalSubtitles: cues.length,
        lastPracticed: Date.now(),
      };
    });
    if (finished && finalized.words?.length) {
      writeCacheText(id, 'words', JSON.stringify(finalized.words)).catch(console.error);
    }
    if (tmpDirForCleanup) {
      await cleanupJobTmpFiles(id, tmpDirForCleanup, pieceTotalForCleanup);
    }
  } catch (err) {
    const reason = interruptedJobs.has(id) ? 'interrupted' : cancelledJobs.has(id) ? 'cancelled' : err;
    const parsed = parseAndroidImportError(reason);
    if (parsed.code !== 'cancelled') console.error('[importAndroid]', err);
    await setJob(id, { error: parsed.code }).catch(console.error);
  } finally {
    activeJobs.delete(id);
    cancelledJobs.delete(id);
    interruptedJobs.delete(id);
    await callAndroid('processing.end', { jobId: id }).catch(() => {});
    notify();
  }
}
