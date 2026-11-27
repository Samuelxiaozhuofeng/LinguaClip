// Stands in for utils/desktop.ts in the mobile build (vite.mobile.config.ts). Only
// what the phone really uses; anything else imported from utils/desktop.ts fails
// the build ("not exported"), on purpose.
import type { CacheKind, MergePackContents, RekeyFilesResult, RemoteEntry, UploadedSyncAudio, WebDavTestResult } from '../../utils/desktop';
import type { WebDavConfig } from '../../utils/syncConfig';
import { deleteCache, getAudio, readCache, writeCache } from '../store';
import { blobId } from '../backup';

export type { MergePackContents, RekeyFilesResult, RemoteEntry, UploadedSyncAudio, WebDavTestResult };

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

// Android-only native clip / desktop-zip backup & restore hooks (no-ops on web/PWA).
export const resolveCardClipSrc = async (_clipFile: string): Promise<string | null> => null;
export const exportAndroidBackupZip = async (_includeKeys: boolean): Promise<{ videos: number; cards: number; path: string } | null> => null;
export const pickAndroidBackup = async (): Promise<{ kind: 'zip'; manifest: unknown; data: unknown; stagedZip: string; appVersion: string } | { kind: 'json'; text: string } | null> => null;
export const unpackAndroidZip = async (_stagedZip: string): Promise<number> => 0;
export const cleanupAndroidStagedZip = async (): Promise<void> => {};
export const prepareAndroidRestore = async (): Promise<void> => {};

// Cross-device sync stubs for PWA (zero @tauri-apps/* imports; offline JSON merge only).
const unsupportedSync = () => Promise.reject(new Error('sync:unsupported'));
export const syncWebdavSupported = (): boolean => false;
export const syncWebdavTest = (_config: WebDavConfig): Promise<WebDavTestResult> => unsupportedSync();
export const syncWebdavList = (
  _config: WebDavConfig,
  _subpath: 'devices' | 'subs' | 'caches' | 'clip-packs' | 'audio',
): Promise<RemoteEntry[]> => unsupportedSync();
export const syncWebdavGetGz = (_config: WebDavConfig, _relPath: string): Promise<string> => unsupportedSync();
export const syncWebdavPutGz = (_config: WebDavConfig, _relPath: string, _content: string): Promise<string | null> =>
  unsupportedSync();
export const syncWebdavDelete = (_config: WebDavConfig, _relPath: string): Promise<void> => unsupportedSync();
export const syncUploadAudio = (
  _config: WebDavConfig,
  _srcPath: string,
  _relPath: string,
  _maxBytes?: number,
): Promise<UploadedSyncAudio> => unsupportedSync();
export const syncDownloadAudio = (
  _config: WebDavConfig,
  _relPath: string,
  _videoId: string,
  _expectedSha256: string,
): Promise<string> => unsupportedSync();
export const syncUploadClipPack = (
  _config: WebDavConfig,
  _relPath: string,
  _files: string[],
  _maxBytes?: number,
  _maxFileBytes?: number,
): Promise<string[]> => unsupportedSync();
export const syncDownloadClipPack = (
  _config: WebDavConfig,
  _relPath: string,
  _wantedFiles: string[],
): Promise<string[]> => unsupportedSync();
export const syncWriteMergePack = (
  _dest: string | null,
  _snapshotJson: string,
  _subs: [string, string][],
  _clipFiles: string[],
): Promise<string> => unsupportedSync();
export const syncWriteMergeJson = (_dest: string | null, _content: string): Promise<string> => unsupportedSync();
export const syncReadMergePack = (_path: string): Promise<MergePackContents> => unsupportedSync();
export const syncUnpackMergePack = (_path: string, _wantedFiles: string[]): Promise<string[]> => unsupportedSync();
export const syncRekeyFiles = async (_fromId: string, _toId: string): Promise<RekeyFilesResult> => ({ moved: 0, mediaPaths: [] });
export const syncClipNetworkOk = async (_wifiOnly: boolean): Promise<boolean> => true;
export const pickSyncPackDest = async (_defaultName: string, _ext?: 'zip' | 'json'): Promise<string | null> => null;
export const pickSyncPackFile = async (): Promise<
  | { kind: 'zip'; path: string; cleanup?: () => Promise<void> }
  | { kind: 'json'; text: string }
  | null
> => null;
export const shareSyncPackFile = async (_path: string, _title: string, _mime?: string): Promise<void> => {};
