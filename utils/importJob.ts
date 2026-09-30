import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { VideoRecord } from '../types';
import { dialog } from '../components/Dialog';
import { fileNameFromPath, needsConvert, pathExists, trashFile } from './desktop';
import { getLang, t } from './i18n';
import { getAIConfig } from './aiConfig';
import { canCloze } from './aiDrills';
import { prepareBreakdowns } from './breakdownPrep';
import { linesOf, prepareCloze } from './clozePrep';
import { jaCheckOn, prepareSegments } from './jaSegments';
import { hasKana } from './japanese';
import { parseSRT } from './srtParser';
import { resegment, Word } from './resegment';
import { engineArgs, getTranscribeConfig } from './transcribeConfig';
import * as VideoStorage from './videoStorage';
import { getAllVideosFromDB } from './fileSystemAccess';

type ImportProgressPayload = {
  id: string;
  stage: 'queued' | 'setup' | 'download' | 'convertSetup' | 'convert' | 'extract' | 'transcribe' | 'cloud' | 'done' | 'error';
  percent?: number;
  error?: string;
  videoPath?: string;
  subtitleText?: string;
  words?: Word[];
};

const listeners = new Set<() => void>();

export function subscribeImportJobs(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function notify(): void {
  listeners.forEach(fn => fn());
}

export const IMPORT_QUALITIES = [1080, 720, 480] as const;
export type ImportQuality = (typeof IMPORT_QUALITIES)[number];

export type QualitySizes = Record<ImportQuality, number | null>;

export function isYouTubeUrl(input: string): boolean {
  try {
    const u = new URL(input.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    return host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be';
  } catch {
    return false;
  }
}

// YouTube's bot gate has several wordings; they all mean "cookies missing or stale".
export function isCookieError(raw: string): boolean {
  return /Sign in to confirm|needs to be reloaded|confirm you.re not a bot|not a bot/i.test(raw);
}

export async function openYouTubeLogin(): Promise<void> {
  await invoke('open_youtube_login');
}

// Records store the RAW error and translate here at render time, so switching
// language re-translates it. Pre-existing records already hold a translated
// sentence; it matches nothing below and falls through unchanged.
export function formatImportError(raw: string): string {
  if (isCookieError(raw)) return t('import.needCookies');
  if (raw.startsWith('missing-model:')) {
    return t('import.missingModel', { name: raw.slice('missing-model:'.length) });
  }
  if (raw.startsWith('missing:')) {
    return t('import.missingTool', { name: raw.slice('missing:'.length) });
  }
  if (raw.startsWith('convertSetup:')) {
    return t('import.failedConvertSetup', { detail: raw.slice('convertSetup:'.length) });
  }
  if (raw.startsWith('setup:')) {
    return t('import.failedSetup', { detail: raw.slice('setup:'.length) });
  }
  if (raw.startsWith('download:')) {
    return t('import.failedDownload', { detail: raw.slice('download:'.length) });
  }
  // Codecs our Windows decoder lacks (Opus, AC-3…): the raw text is jargon.
  if (/^extract:.*unsupported codec/.test(raw)) return t('import.extractCodec');
  if (raw === 'extract:no audio track') return t('import.extractNoAudio');
  if (raw === 'convert:nosubs') return t('import.convertNoSubs');
  if (raw.startsWith('convert:')) return t('import.failedConvert', { detail: raw.slice('convert:'.length) });
  if (raw.startsWith('extract:')) {
    return t('import.failedExtract', { detail: raw.slice('extract:'.length) });
  }
  if (raw === 'cloud:key') return t('import.cloudKey');
  if (raw === 'cloud:toolarge') return t('import.cloudTooLarge');
  if (raw === 'cloud:empty') return t('import.cloudEmpty');
  if (raw.startsWith('cloud:quota:')) return t('import.cloudQuota', { detail: raw.slice('cloud:quota:'.length) });
  if (raw.startsWith('cloud:network:')) return t('import.cloudNetwork', { detail: raw.slice('cloud:network:'.length) });
  if (raw.startsWith('cloud:denied:')) return t('import.cloudDenied', { detail: raw.slice('cloud:denied:'.length) });
  if (raw.startsWith('cloud:')) return t('import.cloudFailed', { detail: raw.slice('cloud:'.length) });
  if (raw.startsWith('transcribe:')) {
    return t('import.failedTranscribe', { detail: raw.slice('transcribe:'.length) });
  }
  return raw;
}

// A local import's extras (all optional; none = convert only what will not play, transcribe).
export type LocalImportOptions = {
  // Subtitles the user brought: track N inside the video, or their own .srt.
  subs?: number | { text: string; fileName: string; count: number };
  trashOriginal?: boolean;
};

function pendingRecord(
  id: string,
  source: string,
  fromUrl: boolean,
  lang: string,
  quality: ImportQuality,
  opts: LocalImportOptions = {},
): VideoRecord {
  const now = Date.now();
  const label = fromUrl ? source : fileNameFromPath(source);
  const own = typeof opts.subs === 'object' ? opts.subs : null;
  return {
    id,
    displayName: label,
    videoFileName: label,
    subtitleFileName: own?.fileName ?? '',
    subtitleText: own?.text ?? '',
    currentSubtitleIndex: 0,
    currentSectionIndex: 0,
    totalSubtitles: own?.count ?? 0,
    completionRate: 0,
    dateAdded: now,
    lastPracticed: now,
    totalPracticeTime: 0,
    importJob: {
      stage: fromUrl ? 'download' : 'extract',
      percent: 0,
      source,
      lang,
      quality,
      ...(opts.subs !== undefined && { subs: own ? 'own' as const : opts.subs as number }),
      ...(opts.trashOriginal && { trashOriginal: true }),
    },
  };
}

// start_import's arguments for a job's own choices.
const jobArgs = (job: NonNullable<VideoRecord['importJob']>) => ({
  convert: !!job.convert,
  subs: job.subs === undefined ? null : String(job.subs),
});

async function startImport(
  source: string,
  lang: string,
  fromUrl: boolean,
  quality: ImportQuality,
  opts: LocalImportOptions = {},
): Promise<void> {
  const id = crypto.randomUUID();
  const record = pendingRecord(id, source, fromUrl, lang, quality, opts);
  await VideoStorage.updateVideoRecord(record);
  notify();
  try {
    await invoke('start_import', { id, source, lang, quality, ...engineArgs(), ...jobArgs(record.importJob!) });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await VideoStorage.updateVideoWith(id, rec => rec.importJob
      ? { ...rec, importJob: { ...rec.importJob, error: formatImportError(detail) } }
      : null);
    notify();
  }
}

// Stops a queued or running import (the record is being deleted). Nothing to
// stop is fine: the job may have just finished.
export function cancelImport(id: string): Promise<void> {
  return invoke('cancel_import', { id });
}

export function startUrlImport(url: string, lang: string, quality: ImportQuality = 1080): Promise<void> {
  return startImport(url.trim(), lang, true, quality);
}

export function startLocalImport(path: string, lang: string, opts: LocalImportOptions = {}): Promise<void> {
  return startImport(path, lang, false, 1080, opts);
}

// A local video whose sound could not be read: converting it to a plain mp4
// usually fixes that. Not offered when it was converted already.
export function canConvertRetry(job: NonNullable<VideoRecord['importJob']>): boolean {
  return !!job.error?.startsWith('extract:') && job.error !== 'extract:video not found'
    && !job.convert && !isYouTubeUrl(job.source) && !needsConvert(job.source);
}

// Retry a failed import on the same record: no second card in the history, and the
// language and quality the user originally picked are reused. Two clicks in the
// moment before the card repaints would start two runs writing the same file, so a
// click is ignored while its retry is in flight.
const retrying = new Set<string>();

// `convert`: the "convert and retry" button, for a video whose sound could not be read.
export async function retryImport(id: string, convert = false): Promise<void> {
  if (retrying.has(id)) return;
  const rec = await VideoStorage.getVideoRecord(id);
  const job = rec?.importJob;
  if (!rec || !job) return;
  retrying.add(id);
  const lang = job.lang ?? 'en';
  const quality = (job.quality ?? 1080) as ImportQuality;
  const stage = isYouTubeUrl(job.source) ? 'download' as const : 'extract' as const;
  // Everything the user chose at the start (own subtitles, conversion, trashing
  // the original) carries over; only the progress starts again.
  const next = { ...job, stage, percent: 0, error: undefined, lang, quality, ...(convert && { convert: true }) };
  delete next.error;
  // Already converted: start from that mp4. Not when a subtitle track is still to
  // be read out of the original.
  const reuse = !!next.converted && typeof next.subs !== 'number' && await pathExists(next.converted);
  if (!reuse) delete next.converted;
  const source = reuse ? next.converted! : job.source;
  const args = reuse ? { convert: false, subs: jobArgs(next).subs } : jobArgs(next);
  // Deleted while we looked for the converted file: nothing to retry.
  const saved = await VideoStorage.updateVideoWith(id, r => r.importJob ? { ...r, importJob: next } : null)
    .catch(err => { console.error(err); return null; });
  if (!saved) {
    retrying.delete(id);
    return;
  }
  notify();
  try {
    // Uses the engine picked in Settings now, not the one this card started
    // with: switching to the cloud after a failed download is a way out.
    await invoke('start_import', { id, source, lang, quality, ...engineArgs(), ...args });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await VideoStorage.updateVideoWith(id, r => r.importJob ? { ...r, importJob: { ...r.importJob, error: detail } } : null);
    notify();
  } finally {
    retrying.delete(id);
  }
}

export type ImportTools = { whisper: boolean; youtube: boolean };

// whisper: the transcription parts for the model picked in Settings are on this
// machine (else the first local import downloads them). youtube: yt-dlp is
// installed by hand, so the link box is worth showing.
export async function importTools(): Promise<ImportTools> {
  const { model, gpu } = engineArgs();
  return invoke('import_tools', { model: model ?? getTranscribeConfig().localModel, gpu });
}

export async function probeImportSizes(url: string): Promise<QualitySizes> {
  return invoke('probe_import_sizes', { url: url.trim() });
}

function srtNameFromVideo(videoPath: string): string {
  const name = fileNameFromPath(videoPath);
  return name.replace(/\.[^.]+$/, '') + '.srt';
}

let applyChain: Promise<void> = Promise.resolve();

async function applyProgress(payload: ImportProgressPayload): Promise<void> {
  const rec = await VideoStorage.getVideoRecord(payload.id);
  if (!rec) return;
  if (!rec.importJob) return;

  if (payload.stage === 'done') {
    const videoPath = payload.videoPath;
    if (!videoPath) return;
    // Last step of an import: re-cut whisper's lines into short, sensible ones.
    // It can fail (no router, model hiccup); then we keep what whisper gave us.
    await VideoStorage.updateVideoWith(rec.id, r => r.importJob
      ? { ...r, importJob: { ...r.importJob, stage: 'segment', percent: undefined } }
      : null);
    notify();
    const recut = payload.words ? await resegment(payload.words) : null;
    // Their own .srt came with the record and stays as it is.
    const own = rec.importJob.subs === 'own';
    const name = fileNameFromPath(videoPath);
    // The re-cut can take a minute; a record deleted meanwhile must stay deleted.
    const finished = await VideoStorage.updateVideoWith(rec.id, r => {
      if (!r.importJob) return null;
      const subtitleText = own ? r.subtitleText : recut ?? payload.subtitleText ?? '';
      const rest = { ...r };
      delete rest.importJob;
      return {
        ...rest,
        displayName: name,
        videoFileName: name,
        videoPath,
        subtitleText,
        subtitleFileName: own ? r.subtitleFileName : srtNameFromVideo(videoPath),
        totalSubtitles: parseSRT(subtitleText).length,
        lastPracticed: Date.now(),
      };
    });
    if (!finished) return;
    const { subtitleText } = finished;
    if (rec.importJob.trashOriginal) await trashOriginal(rec.id, rec.importJob.source, videoPath);
    // Opted-in AI prep starts in the background; the shelf shows its progress.
    const ai = getAIConfig();
    if (ai.autoBreakdown && canCloze()) prepareBreakdowns(rec.id, subtitleText, getLang()).catch(err => console.error(err));
    if (ai.autoCloze && canCloze()) prepareCloze(rec.id, linesOf(subtitleText)).catch(err => console.error(err));
    // Japanese: the AI check of phrase splits (auto blanks above wait for it anyway).
    else if (jaCheckOn() && hasKana(subtitleText)) {
      prepareSegments(rec.id, linesOf(subtitleText)).catch(err => console.error(err));
    }
    return;
  }

  if (payload.stage === 'error') {
    await VideoStorage.updateVideoWith(rec.id, r => r.importJob
      ? { ...r, importJob: { ...r.importJob, error: payload.error ?? '' } }
      : null);
    return;
  }

  const stage = payload.stage;
  await VideoStorage.updateVideoWith(rec.id, r => r.importJob ? {
    ...r,
    importJob: {
      ...r.importJob,
      stage,
      percent: payload.percent ?? r.importJob.percent,
      // The last conversion event carries the new mp4.
      ...(stage === 'convert' && payload.videoPath && { converted: payload.videoPath }),
    },
  } : null);
}

// Only once the whole import has succeeded, and never while any other record
// (finished or still importing) uses the same file.
async function trashOriginal(id: string, source: string, videoPath: string): Promise<void> {
  if (!source || source === videoPath) return;
  // The throwing read: an unreadable list must not pass for "no one else uses it".
  const records = await getAllVideosFromDB().catch(err => { console.error(err); return null; });
  if (!records) return;
  const inUse = records.some(r => r.id !== id && (r.videoPath === source || r.importJob?.source === source || r.importJob?.converted === source));
  if (inUse) return;
  try {
    await trashFile(source);
  } catch (err) {
    console.error(err);
    dialog.alert(t('import.trashFailTitle'), t('import.trashFailBody', { name: fileNameFromPath(source) }));
  }
}

function enqueueProgress(payload: ImportProgressPayload): void {
  const run = applyChain
    .then(() => applyProgress(payload))
    .then(() => notify())
    .catch(err => console.error(err));
  // Finishing an import waits on the re-cut, which can take a minute. It still
  // runs after everything already queued, but a second import's progress must
  // not queue up behind it.
  if (payload.stage !== 'done') applyChain = run;
}

export async function startImportListener(): Promise<() => void> {
  return listen<ImportProgressPayload>('import-progress', event => {
    enqueueProgress(event.payload);
  });
}

export async function markInterruptedJobs(): Promise<void> {
  const records = await VideoStorage.getAllVideoRecords();
  let changed = false;
  for (const rec of records) {
    if (!rec.importJob || rec.importJob.error) continue;
    await VideoStorage.updateVideoWith(rec.id, r => r.importJob && !r.importJob.error
      ? { ...r, importJob: { ...r.importJob, error: t('import.errorInterrupted') } }
      : null);
    changed = true;
  }
  if (changed) notify();
}
