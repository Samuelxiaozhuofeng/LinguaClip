// Checks whether a VideoRecord has playable audio on this phone (docs/android.md「手机学习闭环」· 没音频也能学).
// Shared by Study.tsx (read-only fallback when audio is absent) and Home.tsx (missing-audio badge & repick).
import { useEffect, useState } from 'react';
import type { VideoRecord } from '../types';
import { blobId } from './backup';
import { callAndroid, isAndroidNative } from './platform/androidBridge';
import { HOME_PLATFORM } from './platform/homePlatform';
import { getAudio } from './store';

export type AudioRecordLike = Pick<VideoRecord, 'id' | 'videoPath' | 'importJob'>;

const isAndroidEnv = (override?: boolean): boolean =>
  override ?? (HOME_PLATFORM === 'android' || isAndroidNative());

/** Web URLs or starter assets playable directly without local storage lookup. */
export function isPlayableAudioUrl(path?: string): boolean {
  if (!path) return false;
  return /^https?:\/\//i.test(path) || path.startsWith('data:') || path.startsWith('/starter/');
}

/** Local filesystem path (Android private media dir or desktop path from a backup). */
export function isLocalAudioPath(path?: string): path is string {
  return !!path && !isPlayableAudioUrl(path) && !path.startsWith('blob:') && !path.startsWith('content://');
}

/** Effective audio path for a record (an active/failed import job uses extractedPath / source). */
export function audioPathOf(record: AudioRecordLike): string {
  if (record.importJob) return record.importJob.extractedPath ?? record.importJob.source ?? '';
  return record.videoPath ?? '';
}

/**
 * Synchronous availability check when blob/android existence sets are already known (e.g. Home.tsx).
 * Returns null only when an async lookup is still needed and no sets were provided.
 */
export function syncAudioAvail(
  record: AudioRecordLike,
  opts?: { android?: boolean; haveBlobs?: Set<string> | null; missingAndroid?: Set<string> },
): boolean | null {
  const android = isAndroidEnv(opts?.android);
  if (android && record.importJob?.error === 'audio:reimport') return false;
  const path = audioPathOf(record);
  if (!path) return false;
  if (isPlayableAudioUrl(path)) return true;

  const bid = blobId(path);
  if (bid) {
    if (android) return false;
    if (opts?.haveBlobs) return opts.haveBlobs.has(bid);
    return null;
  }
  if (path.startsWith('blob:')) return !android;
  if (path.startsWith('content://')) return android;

  if (isLocalAudioPath(path)) {
    if (!android) return false;
    if (opts?.missingAndroid) return !opts.missingAndroid.has(record.id);
    return null;
  }
  return false;
}

/** Convenience boolean check for lists that already loaded `haveBlobs` and `missingAndroid`. */
export function hasPlayableAudio(
  record: AudioRecordLike,
  opts?: { android?: boolean; haveBlobs?: Set<string> | null; missingAndroid?: Set<string> },
): boolean {
  const res = syncAudioAvail(record, opts);
  return res !== false;
}

/** Async ground-truth check for a single record (queries IndexedDB on web, media.fileInfo on Android). */
export async function checkRecordAudio(record: AudioRecordLike): Promise<boolean> {
  const sync = syncAudioAvail(record);
  if (sync !== null) return sync;

  const android = isAndroidEnv();
  const path = audioPathOf(record);
  const bid = blobId(path);
  if (bid && !android) {
    try {
      return (await getAudio(bid)) !== null;
    } catch {
      return false;
    }
  }
  if (android && isLocalAudioPath(path)) {
    if (!isAndroidNative()) return false;
    try {
      const info = await callAndroid<{ exists: boolean }>('media.fileInfo', { path });
      return !!info?.exists;
    } catch {
      return false;
    }
  }
  return false;
}

/** React hook: returns true (playable), false (missing on this phone), or null (checking). */
export function useRecordAudio(record: AudioRecordLike): boolean | null {
  const path = audioPathOf(record);
  const jobErr = record.importJob?.error;
  const [avail, setAvail] = useState<boolean | null>(() => syncAudioAvail(record));

  useEffect(() => {
    const sync = syncAudioAvail(record);
    setAvail(sync);
    if (sync !== null) return;
    let live = true;
    checkRecordAudio(record).then(
      ok => { if (live) setAvail(ok); },
      () => { if (live) setAvail(false); },
    );
    return () => { live = false; };
  }, [record.id, path, jobErr]); // eslint-disable-line react-hooks/exhaustive-deps

  return avail;
}
