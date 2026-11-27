// Android Tauri replacement for utils/desktop.ts (used by vite.android.config.ts).
// Combines real Tauri Rust commands (paths, cache, Yomitan dicts, Edge TTS, cloud ASR, backup)
// with the existing mobile/ IndexedDB audio & cache contract so mobile/ views work seamlessly.
import { getVersion } from '@tauri-apps/api/app';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { readFile, readTextFile, remove } from '@tauri-apps/plugin-fs';
import { callAndroid, isAndroidNative } from './androidBridge';
import type {
  CacheKind,
  DictCheck,
  DictProgress,
  JaDictStatus,
  LocalDict,
  MergePackContents,
  RemoteEntry,
  UploadedSyncAudio,
  WebDavTestResult,
} from '../../utils/desktop';
import type { WebDavConfig } from '../../utils/syncConfig';
import { getAllVideosFromDB } from '../../utils/fileSystemAccess';
import { readAll } from '../../utils/review';
import { t } from '../../utils/i18n';
import { deleteCache, getAudio, readCache, writeCache } from '../store';
import { BackupProblem, blobId, buildAndroidZipPayload } from '../backup';
import { cancelAndroidImport } from './importAndroid';

const MAX_JSON_BACKUP_BYTES = 50 * 1024 * 1024;

export type { DictCheck, DictProgress, JaDictStatus, LocalDict, MergePackContents, RemoteEntry, UploadedSyncAudio, WebDavTestResult };

const urls = new Map<string, string>();
let cachedOwnDir: string | null = null;

export interface AndroidPaths {
  ownDir: string;
  mediaDir: string;
  clipsDir: string;
  tmpDir: string;
}

export async function getAndroidPaths(): Promise<AndroidPaths> {
  const res = await invoke<AndroidPaths>('android_paths');
  cachedOwnDir = res.ownDir;
  return res;
}

export async function prepareSrc(path: string): Promise<void> {
  const id = blobId(path);
  if (id) {
    if (urls.has(id)) return;
    const a = await getAudio(id);
    if (!a) throw new Error('audio:missing');
    if (!urls.has(id)) urls.set(id, URL.createObjectURL(a.blob));
    return;
  }
  if (/^https?:\/\//i.test(path)) return;
  if (isAndroidNative()) {
    const info = await callAndroid<{ exists: boolean }>('media.fileInfo', { path });
    if (!info.exists) throw new Error('audio:missing');
  }
}

export async function resolveCardClipPath(clipFile: string): Promise<string | null> {
  if (!clipFile || clipFile.includes('/') || clipFile.includes('\\') || clipFile.includes('..')) return null;
  const { clipsDir } = await getAndroidPaths();
  const full = `${clipsDir}/${clipFile}`;
  const info = await callAndroid<{ exists: boolean }>('media.fileInfo', { path: full });
  return info.exists ? full : null;
}

export async function resolveCardClipSrc(clipFile: string): Promise<string | null> {
  const full = await resolveCardClipPath(clipFile);
  return full ? convertFileSrc(full) : null;
}

export function videoSrcFromPath(path: string): string {
  const id = blobId(path);
  if (id) {
    const url = urls.get(id);
    if (!url) throw new Error(`audio not prepared: ${path}`);
    return url;
  }
  if (/^https?:\/\//i.test(path)) return path;
  return convertFileSrc(path);
}

export function releaseSrc(id: string): void {
  const url = urls.get(id);
  if (url) URL.revokeObjectURL(url);
  urls.delete(id);
}

async function cacheFilePath(id: string, kind: CacheKind): Promise<string> {
  if (!cachedOwnDir) await getAndroidPaths();
  return `${cachedOwnDir}/${id}.${kind}.json`;
}

export async function readCacheText(id: string, kind: CacheKind): Promise<string | null> {
  try {
    const p = await cacheFilePath(id, kind);
    return await readTextFile(p);
  } catch {
    try { return await readCache(id, kind); } catch { return null; }
  }
}

export async function writeCacheText(id: string, kind: CacheKind, text: string): Promise<void> {
  await invoke('write_cache', { id, kind, text });
  await writeCache(id, kind, text).catch(() => {});
}

export async function deleteCacheTexts(id: string): Promise<void> {
  const kinds: CacheKind[] = ['words', 'cloze', 'breakdown', 'segments', 'levels', 'trans', 'keywords', 'phrases'];
  await Promise.all(kinds.map(async k => {
    try { await remove(await cacheFilePath(id, k)); } catch { /* absent */ }
  }));
  await deleteCache(id).catch(() => {});
}

export const jaDictStatus = (): Promise<JaDictStatus> => invoke<JaDictStatus>('ja_dict_status');
export const installJaDict = (): Promise<void> => invoke('install_ja_dict');
export const removeJaDict = (): Promise<void> => invoke('remove_ja_dict');
export const onJaDictProgress = (cb: (pct: number) => void): Promise<() => void> =>
  listen<number>('ja-dict-progress', e => cb(e.payload));
export const readBinaryFile = (path: string): Promise<Uint8Array> => readFile(path);

// Local Yomitan dictionaries (src-tauri/src/dicts.rs)
export const dictList = () => invoke<LocalDict[]>('dict_list');
export const dictCheck = (path: string) => invoke<DictCheck>('dict_check', { path });
export const dictImport = (path: string, replace?: string) => invoke<LocalDict[]>('dict_import', { path, replace });
export const dictDownload = (urls: string[], replace?: string) => invoke<LocalDict[]>('dict_download', { urls, replace });
export const dictUpdate = (id: string, change: { enabled?: boolean; lang?: string }) => invoke<LocalDict[]>('dict_update', { id, ...change });
export const dictMove = (id: string, dirStep: -1 | 1) => invoke<LocalDict[]>('dict_move', { id, dirStep });
export const dictRemove = (id: string) => invoke<LocalDict[]>('dict_remove', { id });
export const dictLookup = <R>(ids: string[], keys: string[]) => invoke<R[]>('dict_lookup', { ids, keys });
export const onDictProgress = (fn: (p: DictProgress) => void) => listen<DictProgress>('dict-import-progress', e => fn(e.payload));
export async function pickDictZip(): Promise<string | null> {
  const selected = await open({ multiple: false, filters: [{ name: 'Yomitan', extensions: ['zip'] }] });
  if (typeof selected !== 'string') return null;
  if (selected.startsWith('content://') && isAndroidNative()) {
    const { tmpDir } = await getAndroidPaths();
    const copied = await callAndroid<{ path: string }>('media.copyUriToPath', {
      uri: selected,
      // One fixed staging name: each pick replaces the last copy instead of piling up full dictionaries.
      destPath: `${tmpDir}/dict-import.zip`,
    });
    return copied.path;
  }
  return selected;
}

// Edge TTS via Rust WebSocket proxy (tts.rs)
export async function synthesizeSpeech(text: string, voice: string): Promise<ArrayBuffer | null> {
  try {
    const bytes = await invoke<ArrayBuffer | null>('tts', { text, voice });
    return bytes && bytes.byteLength > 0 ? bytes : null;
  } catch {
    return null;
  }
}

// Rust cloud ASR planning & upload helpers
export interface CutPiece { index: number; fromSample: number; toSample: number; offsetMs: number }
export const planWavCuts = (wavPath: string, pieceSecs = 3600): Promise<CutPiece[]> =>
  invoke<CutPiece[]>('plan_wav_cuts', { wavPath, pieceSecs });

export const transcribePreparedPieces = (args: {
  id: string;
  provider: 'groq' | 'bailian' | 'custom';
  apiKey: string;
  baseUrl?: string;
  model?: string;
  lang: string;
  pieces: { path: string; offsetMs: number }[];
}) => invoke<{ subtitleText: string; words: { w: string; from: number; to: number }[] }>('transcribe_prepared_pieces', args);

export const downloadPodcastAudio = (id: string, url: string, stem: string): Promise<string> =>
  invoke<string>('download_podcast_audio', { id, url, stem });

export const getDeviceInfo = () => invoke<{ id: string; name: string }>('device_info');

// Android native .zip backup writer & system share sheet export (src-tauri/src/backup.rs)
export async function exportAndroidBackupZip(includeKeys: boolean): Promise<{ videos: number; cards: number; path: string } | null> {
  const [videos, review, appVersion, paths] = await Promise.all([
    getAllVideosFromDB(),
    readAll(),
    getVersion().catch(() => '0.10.0'),
    getAndroidPaths(),
  ]);
  const local: Record<string, string> = {};
  for (const k of Object.keys(localStorage)) {
    const v = localStorage.getItem(k);
    if (v !== null) local[k] = v;
  }
  const createdAt = Date.now();
  const { manifest, data } = buildAndroidZipPayload({
    videos,
    cards: review.cards,
    meta: review.meta,
    local,
    appVersion,
    ownDir: paths.ownDir,
    includeKeys,
    createdAt,
  });
  const date = new Date(createdAt).toLocaleDateString('sv-SE');
  // Unique per-export subfolder so a previous FileProvider URI grant can never read a later export
  // (e.g. first sharing without keys, then exporting with keys on the same day).
  const dest = `${paths.tmpDir}/exports/${crypto.randomUUID()}/${t('backup.fileName', { date })}`;
  const zipPath = await invoke<string>('backup_write', {
    dest,
    kind: 'auto',
    manifest: JSON.stringify(manifest),
    data: JSON.stringify(data),
    files: true,
  });
  await callAndroid('system.shareFile', {
    path: zipPath,
    mime: 'application/zip',
    title: t('m.bkExportZip'),
  });
  return { videos: manifest.videos, cards: manifest.cards, path: zipPath };
}

// Android native backup picker & desktop .zip staging/unpacking helpers (src-tauri/src/backup.rs)
export async function stageAndroidZip(localPath: string): Promise<{ manifest: unknown; data: unknown; stagedZip: string; appVersion: string }> {
  const stagedZip = await invoke<string>('backup_stage', { path: localPath });
  try {
    const raw = await invoke<{ manifest: string; data: string }>('backup_read', { path: stagedZip });
    const appVersion = await getVersion().catch(() => '0.10.0');
    return {
      manifest: JSON.parse(raw.manifest),
      data: JSON.parse(raw.data),
      stagedZip,
      appVersion,
    };
  } catch (e) {
    await cleanupAndroidStagedZip().catch(() => {});
    throw e;
  }
}

export async function pickAndroidBackup(): Promise<
  | { kind: 'zip'; manifest: unknown; data: unknown; stagedZip: string; appVersion: string }
  | { kind: 'json'; text: string }
  | null
> {
  const selected = await open({
    multiple: false,
    filters: [{ name: 'LinguaClip Backup', extensions: ['zip', 'json'] }],
  });
  if (typeof selected !== 'string') return null;
  const { tmpDir } = await getAndroidPaths();
  const isZip = selected.toLowerCase().endsWith('.zip');
  let localPath = selected;
  if (selected.startsWith('content://') && isAndroidNative()) {
    const ext = isZip ? 'zip' : 'tmp';
    const copied = await callAndroid<{ path: string }>('media.copyUriToPath', {
      uri: selected,
      destPath: `${tmpDir}/picked-backup-${Date.now()}.${ext}`,
    });
    localPath = copied.path;
  }
  try {
    // Inspect only the first 2 bytes on native side so multi-GB desktop ZIPs never enter WebView RAM.
    const info = await callAndroid<{ exists: boolean; sizeBytes?: number; isZip?: boolean }>('media.fileInfo', { path: localPath });
    if (!info.exists) return null;
    if (info.isZip) {
      const staged = await stageAndroidZip(localPath);
      return { kind: 'zip', ...staged };
    }
    if ((info.sizeBytes ?? 0) > MAX_JSON_BACKUP_BYTES) {
      throw new BackupProblem('bad', 'tooBig');
    }
    return { kind: 'json', text: await readTextFile(localPath) };
  } finally {
    if (localPath !== selected && isAndroidNative()) {
      await callAndroid('media.removeFile', { path: localPath }).catch(() => {});
    }
  }
}

export const unpackAndroidZip = (stagedZip: string): Promise<number> =>
  invoke<number>('backup_unpack', { path: stagedZip });

export const cleanupAndroidStagedZip = async (): Promise<void> => {
  await invoke('backup_remove', { names: ['restore-staged.zip'] }).catch(() => {});
};

// Stop active imports & pause player before clearing native last-pos ahead of staging/running a restore.
export const prepareAndroidRestore = async (): Promise<void> => {
  await cancelAndroidImport(undefined, false).catch(() => {});
  if (isAndroidNative()) {
    await callAndroid('playback.pause').catch(() => {});
    await callAndroid('playback.clearLastPos').catch(() => {});
  }
};

// --- Review cards' standalone audio clips (M2.5, same signatures as utils/desktop.ts) ---
const SAFE_CLIP_NAME = /^[A-Za-z0-9._-]+$/;

async function resolveLocalMediaPath(path: string): Promise<string | null> {
  if (!path || /^https?:\/\//i.test(path) || path.startsWith('blob:') || path.startsWith('content://')) {
    return null;
  }
  if (path.startsWith('/')) return path;
  const { ownDir } = await getAndroidPaths();
  return `${ownDir}/${path.replace(/^\/+/, '')}`;
}

// Streamed starter / podcast episodes: MediaBridge cuts straight from the URL (HTTP range reads).
const REMOTE_MEDIA = /^https:\/\//i;
const REMOTE_CUT_MS = 45_000;

export async function pathExists(path: string): Promise<boolean> {
  if (!isAndroidNative()) return false;
  if (REMOTE_MEDIA.test(path)) return true;
  const local = await resolveLocalMediaPath(path).catch(() => null);
  if (!local) return false;
  const info = await callAndroid<{ exists: boolean }>('media.fileInfo', { path: local }).catch(() => null);
  return !!info?.exists;
}

export async function clipPath(file: string): Promise<string> {
  const { clipsDir } = await getAndroidPaths();
  return `${clipsDir}/${file}`;
}

// Android always cuts audio-only .m4a via MediaBridge.cutAudioClip regardless of desktop `kind`
// (without mutating practice_config.clipKind so moving back to desktop preserves the user's choice).
export async function cutClip(
  src: string,
  from: number,
  to: number,
  name: string,
  _kind: 'video' | 'audio',
): Promise<{ file: string; image: string | null }> {
  if (!isAndroidNative()) throw new Error('android:unavailable');
  if (!name || name.length > 200 || name.startsWith('.') || !SAFE_CLIP_NAME.test(name)) {
    throw new Error(`clip:bad_name:${name}`);
  }
  const remote = REMOTE_MEDIA.test(src);
  const localSrc = remote ? src : await resolveLocalMediaPath(src);
  if (!localSrc) throw new Error('missing:video');
  if (!remote) {
    const srcInfo = await callAndroid<{ exists: boolean }>('media.fileInfo', { path: localSrc }).catch(() => null);
    if (!srcInfo?.exists) throw new Error('missing:video');
  }

  const { clipsDir } = await getAndroidPaths();
  const file = `${name}.m4a`;
  const outM4aPath = `${clipsDir}/${file}`;
  const existing = await callAndroid<{ exists: boolean; sizeBytes?: number }>('media.fileInfo', { path: outM4aPath }).catch(() => null);
  if (existing?.exists && (existing.sizeBytes ?? 0) > 0) {
    return { file, image: null };
  }

  const startMs = Math.max(0, Math.round(from * 1000));
  const endMs = Math.max(startMs + 100, Math.round(to * 1000));
  try {
    const cut = callAndroid<{ path: string; sizeBytes: number; durationMs: number }>('media.cutAudioClip', {
      input: localSrc,
      startMs,
      endMs,
      outM4aPath,
    });
    // A stalled server can hold a streamed cut forever: give up on this line, the batch goes on.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await (remote
      ? Promise.race([cut, new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error('clip:timeout')), REMOTE_CUT_MS); })])
      : cut
    ).finally(() => clearTimeout(timer));
    return { file, image: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/^(clip|missing|ffmpeg):/.test(msg)) throw new Error(msg);
    throw new Error(`clip:${msg}`);
  }
}

export const sweepClips = (keep: string[]): Promise<number> => invoke<number>('sweep_clips', { keep });
export const clipsInfo = (): Promise<{ dir: string; bytes: number }> => invoke<{ dir: string; bytes: number }>('clips_info');
export const backupKeptClips = (): Promise<string[] | null> => invoke<string[] | null>('backup_kept_clips');
// Stub for utils/anki.ts top-level import (Android uses AnkiDroidBridge instead of AnkiConnect HTTP).
export const ankiRequest = async (_url: string, _body: string): Promise<string> => {
  throw new Error('anki:desktop_only');
};

// M2.5 aliases & Android-only runtime loaders (resolved via vite.android.config.ts SWAP; absent on PWA).
export const deviceInfo = getDeviceInfo;
export async function openExternal(url: string): Promise<void> {
  try {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}
export const loadClipsRuntime = () => import('../../utils/clips');
export const loadAnkiDroidExport = () => import('../ankiDroidExport');
export const loadSupporterLicense = () => import('../../pro/license');

// Cross-device serverless sync (docs/sync.md, same signatures as utils/desktop.ts).
export const syncWebdavSupported = (): boolean => isAndroidNative();
export const syncWebdavTest = (config: WebDavConfig): Promise<WebDavTestResult> =>
  invoke<WebDavTestResult>('sync_webdav_test', { config });
export const syncWebdavList = (
  config: WebDavConfig,
  subpath: 'devices' | 'subs' | 'caches' | 'clip-packs' | 'audio',
): Promise<RemoteEntry[]> => invoke<RemoteEntry[]>('sync_webdav_list', { config, subpath });
export const syncWebdavGetGz = (config: WebDavConfig, relPath: string): Promise<string> =>
  invoke<string>('sync_webdav_get_gz', { config, relPath });
export const syncWebdavPutGz = (config: WebDavConfig, relPath: string, content: string): Promise<string | null> =>
  invoke<string | null>('sync_webdav_put_gz', { config, relPath, content });
export const syncWebdavDelete = (config: WebDavConfig, relPath: string): Promise<void> =>
  invoke<void>('sync_webdav_delete', { config, relPath });
export const syncUploadAudio = (
  config: WebDavConfig,
  srcPath: string,
  relPath: string,
  maxBytes?: number,
): Promise<UploadedSyncAudio> => invoke<UploadedSyncAudio>('sync_upload_audio', { config, srcPath, relPath, maxBytes });
export const syncDownloadAudio = (
  config: WebDavConfig,
  relPath: string,
  videoId: string,
  expectedSha256: string,
): Promise<string> => invoke<string>('sync_download_audio', { config, relPath, videoId, expectedSha256 });
export const syncUploadClipPack = (
  config: WebDavConfig,
  relPath: string,
  files: string[],
  maxBytes?: number,
  maxFileBytes?: number,
): Promise<string[]> => invoke<string[]>('sync_upload_clip_pack', { config, relPath, files, maxBytes, maxFileBytes });
export const syncDownloadClipPack = (
  config: WebDavConfig,
  relPath: string,
  wantedFiles: string[],
): Promise<string[]> => invoke<string[]>('sync_download_clip_pack', { config, relPath, wantedFiles });
export const syncWriteMergePack = (
  dest: string | null,
  snapshotJson: string,
  subs: [string, string][],
  clipFiles: string[],
): Promise<string> => invoke<string>('sync_write_merge_pack', { dest, snapshotJson, subs, clipFiles });
export const syncWriteMergeJson = (dest: string | null, content: string): Promise<string> =>
  invoke<string>('sync_write_merge_json', { dest, content });
export const syncReadMergePack = (path: string): Promise<MergePackContents> =>
  invoke<MergePackContents>('sync_read_merge_pack', { path });
export const syncUnpackMergePack = (path: string, wantedFiles: string[]): Promise<string[]> =>
  invoke<string[]>('sync_unpack_merge_pack', { path, wantedFiles });
export const syncRekeyFiles = (fromId: string, toId: string): Promise<{ moved: number; mediaPaths: [string, string][] }> =>
  invoke<{ moved: number; mediaPaths: [string, string][] }>('sync_rekey_files', { fromId, toId });

export async function syncClipNetworkOk(wifiOnly: boolean): Promise<boolean> {
  if (!wifiOnly || !isAndroidNative()) return true;
  const res = await callAndroid<{ wifi?: boolean; metered?: boolean }>('system.networkState').catch(() => null);
  return !!res?.wifi;
}

export const pickSyncPackDest = async (_defaultName: string, _ext?: 'zip' | 'json'): Promise<string | null> => null;

export async function pickSyncPackFile(): Promise<
  | { kind: 'zip'; path: string; cleanup?: () => Promise<void> }
  | { kind: 'json'; text: string }
  | null
> {
  const selected = await open({
    multiple: false,
    filters: [{ name: 'LinguaClip Sync', extensions: ['zip', 'json'] }],
  });
  if (typeof selected !== 'string') return null;
  let localPath = selected;
  let copiedTmp = false;
  if (selected.startsWith('content://') && isAndroidNative()) {
    const { tmpDir } = await getAndroidPaths();
    const copied = await callAndroid<{ path: string }>('media.copyUriToPath', {
      uri: selected,
      destPath: `${tmpDir}/picked-sync-${Date.now()}.tmp`,
    });
    localPath = copied.path;
    copiedTmp = true;
  }
  const removeTmp = async () => {
    if (copiedTmp && isAndroidNative()) {
      await callAndroid('media.removeFile', { path: localPath }).catch(() => {});
    }
  };
  try {
    if (isAndroidNative()) {
      // Inspect only the first 2 bytes on native side so large sync ZIPs never enter WebView RAM.
      const info = await callAndroid<{ exists: boolean; sizeBytes?: number; isZip?: boolean }>('media.fileInfo', { path: localPath });
      if (!info.exists) {
        await removeTmp();
        return null;
      }
      if (info.isZip) {
        return { kind: 'zip', path: localPath, cleanup: copiedTmp ? removeTmp : undefined };
      }
      if ((info.sizeBytes ?? 0) > MAX_JSON_BACKUP_BYTES) {
        throw new BackupProblem('bad', 'tooBig');
      }
    } else if (localPath.toLowerCase().endsWith('.zip')) {
      return { kind: 'zip', path: localPath };
    }
    const text = await readTextFile(localPath);
    await removeTmp();
    return { kind: 'json', text };
  } catch (e) {
    await removeTmp();
    throw e;
  }
}

export async function shareSyncPackFile(path: string, title: string, mime?: string): Promise<void> {
  if (!isAndroidNative()) return;
  const resolved = mime ?? (path.toLowerCase().endsWith('.json') ? 'application/json' : 'application/zip');
  await callAndroid('system.shareFile', { path, mime: resolved, title });
}
