// Phone imports (docs/mobile-web.md): an audio file from the phone or a podcast
// episode → Groq → tidy-up (cleanup.ts) → short lines (utils/resegment.ts) → a
// practice record in linguaclip_db, written the way the desktop finishes an import
// (utils/importJob.ts applyProgress). One import runs at a time; starting another,
// or deleting, stops the one in flight. A record mid-import carries `importJob`
// (stage / error), so a page closed halfway shows "not finished → retry".
import type { VideoRecord } from '../types';
import type { PodcastImport } from '../utils/importJob';
import { getAllVideosFromDB } from '../utils/fileSystemAccess';
import { deleteVideoCards } from '../utils/review';
import { resegment } from '../utils/resegment';
import { parseSRT } from '../utils/srtParser';
import * as VideoStorage from '../utils/videoStorage';
import { cleanUp, writeSrt } from './cleanup';
import { deleteCacheTexts, releaseSrc, writeCacheText } from './platform/desktop';
import { deleteAudio, getAudio, outsideRestore, putAudio } from './store';
import { MAX_BYTES, groqKey, transcribe, type Source } from './transcribe';

export type { PodcastImport };
// Error codes on importJob.error besides the transcribe.ts ones.
export const INTERRUPTED = 'interrupted'; // page closed / switched away mid-import
export const AUDIO_MISSING = 'audio:missing'; // the phone no longer has the file

const listeners = new Set<() => void>();
export const subscribeImports = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const notify = () => listeners.forEach(fn => fn());

let current: { id: string; ctrl: AbortController } | null = null;

// Stops the import in flight for this record (any record when id is omitted).
export function cancelImport(id?: string): void {
  if (current && (id === undefined || current.id === id)) {
    current.ctrl.abort();
    current = null;
  }
}

const setJob = (id: string, job: Partial<NonNullable<VideoRecord['importJob']>>) =>
  VideoStorage.updateVideoWith(id, r => {
    if (!r.importJob) return null;
    const next = { ...r.importJob, ...job };
    if (job.error === undefined) delete next.error;
    return { ...r, importJob: next };
  });

function pending(id: string, label: string, source: string, lang: string, podcast?: VideoRecord['podcast']): VideoRecord {
  const now = Date.now();
  return {
    id, displayName: label, videoFileName: label, subtitleFileName: '', subtitleText: '',
    currentSubtitleIndex: 0, currentSectionIndex: 0, totalSubtitles: 0, completionRate: 0,
    dateAdded: now, lastPracticed: now, totalPracticeTime: 0,
    ...(podcast && { podcast }),
    importJob: { stage: 'cloud', source, lang },
  };
}

// Throws file:toolarge / cloud:nokey before anything is saved. Resolves with the
// record id once the record and the file are stored; transcription goes on.
export async function importFile(file: File, lang: string): Promise<string> {
  if (file.size > MAX_BYTES) throw new Error('file:toolarge');
  if (!groqKey()) throw new Error('cloud:nokey');
  const id = crypto.randomUUID();
  const source = `blob:${id}`;
  // Record first, then the file: a sweep never sees a file without its record.
  await VideoStorage.updateVideoRecord(pending(id, file.name, source, lang));
  try {
    await putAudio(id, { blob: file, name: file.name, type: file.type });
  } catch (err) {
    await VideoStorage.deleteVideoRecord(id).catch(console.error);
    throw err;
  }
  notify();
  void run(id);
  return id;
}

export async function importEpisode(ep: PodcastImport): Promise<string> {
  if (!groqKey()) throw new Error('cloud:nokey');
  await VideoStorage.updateVideoRecord(pending(ep.id, ep.title, ep.audio, ep.lang, ep.podcast));
  notify();
  void run(ep.id);
  return ep.id;
}

// A failed or unfinished import again, on the same record.
export async function retryImport(id: string): Promise<void> {
  if (current?.id === id) return;
  await run(id);
}

async function run(id: string): Promise<void> {
  cancelImport();
  const ctrl = new AbortController();
  current = { id, ctrl };
  const { signal } = ctrl;
  try {
    const rec = await setJob(id, { stage: 'cloud', error: undefined });
    notify();
    if (!rec?.importJob) return;
    const job = rec.importJob;
    const lang = job.lang ?? 'en';
    let source: Source;
    if (job.source.startsWith('blob:')) {
      const a = await getAudio(id);
      if (!a) throw new Error(AUDIO_MISSING);
      source = { file: a.blob, name: a.name };
    } else {
      source = { url: job.source };
    }
    const { cues, words } = cleanUp(await transcribe(source, lang, signal));
    if (signal.aborted) throw signal.reason;
    if (cues.length === 0 && !words) throw new Error('cloud:empty');
    await setJob(id, { stage: 'segment' });
    notify();
    const srt = (words ? await resegment(words) : null) ?? writeSrt(cues);
    if (!srt.trim()) throw new Error('cloud:empty');
    if (signal.aborted) throw signal.reason;
    const name = 'file' in source ? source.name : rec.displayName;
    const done = await VideoStorage.updateVideoWith(id, r => {
      if (!r.importJob) return null;
      const rest = { ...r };
      delete rest.importJob;
      return {
        ...rest,
        videoFileName: name,
        videoPath: job.source,
        subtitleText: srt,
        subtitleFileName: `${id}.srt`, // a title may hold '/', which a backup refuses
        totalSubtitles: parseSRT(srt).length,
        lastPracticed: Date.now(),
      };
    });
    // Word times for "break it down" etc., like the desktop's <id>.words.json; optional.
    if (done && words) writeCacheText(id, 'words', JSON.stringify(words)).catch(console.error);
  } catch (err) {
    const code = signal.aborted ? INTERRUPTED : err instanceof Error ? err.message : String(err);
    if (!signal.aborted) console.error(err);
    // A deleted record stays deleted (setJob writes nothing then).
    await setJob(id, { error: code }).catch(console.error);
  } finally {
    if (current?.ctrl === ctrl) current = null;
    notify();
  }
}

// Records left mid-import by a closed page: marked so they show "retry". Run once at start.
export async function markInterrupted(): Promise<void> {
  const records = await getAllVideosFromDB() as VideoRecord[];
  for (const r of records) {
    if (!r.importJob || r.importJob.error || current?.id === r.id) continue;
    await VideoStorage.updateVideoWith(r.id, x => x.importJob && !x.importJob.error && current?.id !== x.id
      ? { ...x, importJob: { ...x.importJob, error: INTERRUPTED } }
      : null);
  }
  notify();
}

// Record → its cards → its audio file → its caches. Never the file first: a failure
// after the record is gone leaves at most an orphan file, swept on the next start.
export const deleteRecord = (id: string): Promise<void> => outsideRestore(() => remove(id), undefined);
async function remove(id: string): Promise<void> {
  cancelImport(id);
  await VideoStorage.deleteVideoRecord(id);
  notify();
  await deleteVideoCards(id);
  releaseSrc(id);
  await deleteAudio(id).catch(console.error);
  await deleteCacheTexts(id).catch(console.error);
}
