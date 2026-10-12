// Stands in for utils/desktop.ts in the mobile build (vite.mobile.config.ts). Only
// what the phone really uses; anything else imported from utils/desktop.ts fails
// the build ("not exported"), on purpose.
import type { CacheKind } from '../../utils/desktop';
import { deleteCache, getAudio, readCache, writeCache } from '../store';
import { blobId } from '../backup';

// A record's videoPath on the phone: the episode's web address, or `blob:<id>` for
// an audio file kept in linguaclip_audio. Blob ones need prepareSrc first.
const urls = new Map<string, string>();

export async function prepareSrc(path: string): Promise<void> {
  const id = blobId(path);
  if (!id || urls.has(id)) return;
  const a = await getAudio(id);
  if (!a) throw new Error('audio:missing');
  if (!urls.has(id)) urls.set(id, URL.createObjectURL(a.blob));
}

export function videoSrcFromPath(path: string): string {
  const id = blobId(path);
  if (!id) return path;
  const url = urls.get(id);
  if (!url) throw new Error(`audio not prepared: ${path}`);
  return url;
}

// The record is gone: its object URL too.
export function releaseSrc(id: string): void {
  const url = urls.get(id);
  if (url) URL.revokeObjectURL(url);
  urls.delete(id);
}

// Same contract as the desktop: null when missing or unreadable.
export async function readCacheText(id: string, kind: CacheKind): Promise<string | null> {
  try {
    return await readCache(id, kind);
  } catch {
    return null;
  }
}

export const writeCacheText = (id: string, kind: CacheKind, text: string): Promise<void> => writeCache(id, kind, text);
export const deleteCacheTexts = (id: string): Promise<void> => deleteCache(id);

// The Japanese splitting dictionary: Cache Storage instead of files on disk.
export { jaDictStatus, installJaDict, removeJaDict, onJaDictProgress, readBinaryFile, type JaDictStatus } from './jaDict';
