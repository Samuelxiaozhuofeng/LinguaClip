// In-memory store keeping a local or shared import's chosen file, track, language, and optional .srt
// when the user is sent to Settings for a missing transcription key, so returning resumes cleanly.
import type { ImportSheetConfirm } from './ImportSheet';
import type { ProbeTracksResult } from './platform/androidBridge';

export interface SavedAndroidImport {
  kind: 'android';
  uri: string;
  probe: ProbeTracksResult;
  trackIndex: number;
  lang: string;
  srt?: { name: string; text: string; count: number };
  waitingForKey: boolean;
}

export interface SavedWebImport {
  kind: 'web';
  file: File;
  lang: string;
  waitingForKey: boolean;
}

export type SavedPendingImport = SavedAndroidImport | SavedWebImport;

let current: SavedPendingImport | null = null;

export const getPendingImport = (): SavedPendingImport | null => current;
export const setPendingImportStore = (next: SavedPendingImport | null): void => { current = next; };
export const clearPendingImport = (): void => { current = null; };

/** Builds and saves a pending Android local/shared import before navigating to Settings for a key. */
export function savePendingAndroidImport(
  uri: string,
  probe: ProbeTracksResult,
  opts: Pick<ImportSheetConfirm, 'trackIndex' | 'lang' | 'srtText' | 'srtName'>,
): SavedAndroidImport {
  const entry: SavedAndroidImport = {
    kind: 'android',
    uri,
    probe,
    trackIndex: opts.trackIndex,
    lang: opts.lang,
    ...(opts.srtText ? { srt: { name: opts.srtName ?? '', text: opts.srtText, count: 1 } } : {}),
    waitingForKey: true,
  };
  current = entry;
  return entry;
}
