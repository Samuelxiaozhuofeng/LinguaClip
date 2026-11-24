// Android native replacement for mobile/importAudio.ts (swapped in vite.android.config.ts).
// Routes podcast & local imports through MediaProcessingService + resumable cloud ASR (importAndroid.ts)
// and deletes records strictly in the Android-safe order (deleteAndroid.ts).
import type { PodcastImport } from '../../utils/importJob';
import {
  cancelAndroidImport,
  markAndroidInterrupted,
  notifyAndroidImports,
  retryAndroidImport,
  startAndroidEpisodeImport,
  subscribeAndroidImports,
} from './importAndroid';
import { deleteAndroidRecord } from './deleteAndroid';

export type { PodcastImport };
export const INTERRUPTED = 'interrupted';
export const AUDIO_MISSING = 'audio:missing';

export const subscribeImports = subscribeAndroidImports;

export function cancelImport(id?: string): void {
  void cancelAndroidImport(id, false);
}

// Local files on Android use pickAndroidMediaFile + ImportSheet + startAndroidLocalImport.
export async function importFile(_file: File, _lang: string): Promise<string> {
  throw new Error('audio:reimport');
}

export function importEpisode(ep: PodcastImport): Promise<string> {
  return startAndroidEpisodeImport(ep);
}

export function retryImport(id: string): Promise<void> {
  return retryAndroidImport(id);
}

export function markInterrupted(): Promise<void> {
  return markAndroidInterrupted();
}

export async function deleteRecord(id: string): Promise<void> {
  await deleteAndroidRecord(id, {
    stopJob: jobId => cancelAndroidImport(jobId, true),
  });
  notifyAndroidImports();
}
