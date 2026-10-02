/**
 * Tauri desktop helpers: pick files, read subtitles, check paths, listen for drops.
 */
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { homeDir, join } from '@tauri-apps/api/path';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { open, save } from '@tauri-apps/plugin-dialog';
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener';
import { exists, readFile, readTextFile } from '@tauri-apps/plugin-fs';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { getVersion } from '@tauri-apps/api/app';
import { IS_WINDOWS } from './platform';

// What the player opens as is; the rest of VIDEO_EXTS gets converted to mp4 on
// import (src-tauri/src/convert.rs `plays_natively` must agree on the first list).
// Sound-only files play too: a podcast episode, or an mp3 of one.
const AUDIO = ['mp3', 'm4a'];
const PLAYABLE = ['mp4', 'mov', 'm4v', ...AUDIO];
export const VIDEO_EXTS = [...PLAYABLE, 'mkv', 'avi', 'webm', 'wmv', 'flv', 'rmvb', 'rm', 'ts', 'mts', 'm2ts', 'mpg', 'mpeg', 'vob', '3gp', 'ogv'];
const extOf = (path: string) => (/\.([^./\\]+)$/.exec(path)?.[1] ?? '').toLowerCase();
export const isVideoFile = (path: string) => VIDEO_EXTS.includes(extOf(path));
export const needsConvert = (path: string) => isVideoFile(path) && !PLAYABLE.includes(extOf(path));
export const isAudioPath = (path: string) => AUDIO.includes(extOf(path));
// No picture to show: a podcast episode or a sound file. The one place that decides.
export const isAudioRecord = (r: { podcast?: unknown; videoPath?: string; videoFileName: string }) =>
  !!r.podcast || isAudioPath(r.videoPath || r.videoFileName);
const SUBTITLE_FILTER = { name: 'Subtitles', extensions: ['srt'] }; // parseSRT reads nothing else

export function fileNameFromPath(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

export function videoSrcFromPath(path: string): string {
  return convertFileSrc(path);
}

// `any`: also the formats an import converts. Re-linking a record's video takes
// only what plays as is, since nothing converts it there.
export async function pickVideoPath(any = false): Promise<string | null> {
  const selected = await open({ multiple: false, filters: [{ name: 'Video', extensions: any ? VIDEO_EXTS : PLAYABLE }] });
  return typeof selected === 'string' ? selected : null;
}

export async function pickSubtitlePath(): Promise<string | null> {
  const selected = await open({ multiple: false, filters: [SUBTITLE_FILTER] });
  return typeof selected === 'string' ? selected : null;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    return await exists(path);
  } catch {
    return false;
  }
}

export async function readSubtitleFile(path: string): Promise<File> {
  const text = await readTextFile(path);
  return new File([text], fileNameFromPath(path), { type: 'text/plain' });
}

export async function readBinaryFile(path: string): Promise<Uint8Array> {
  return readFile(path);
}

// Japanese word-splitting dictionary (src-tauri/src/ja_dict.rs).
export type JaDictStatus = { installed: boolean; dir: string; bytes: number };
export const jaDictStatus = () => invoke<JaDictStatus>('ja_dict_status');
export const installJaDict = () => invoke<void>('install_ja_dict');
export const removeJaDict = () => invoke<void>('remove_ja_dict');
export const onJaDictProgress = (fn: (pct: number) => void) => listen<number>('ja-dict-progress', e => fn(e.payload));

// Local dictionaries (src-tauri/src/dicts.rs, docs/yomitan.md). Every change returns the new list.
export type LocalDict = {
  id: string; title: string; revision: string; lang: string | null; enabled: boolean; order: number;
  bytes: number; attribution: string; downloadUrl: string | null; broken: boolean; needsReimport: boolean;
};
export type DictCheck = { title: string; revision: string; same: LocalDict | null };
export type DictProgress = { stage: 'download' | 'import'; pct: number };
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
  return typeof selected === 'string' ? selected : null;
}

// The video converter (ffmpeg): path = the one in use, null = not downloaded yet.
export type ConvertToolStatus = { path: string | null; dir: string; bytes: number };
export const convertToolStatus = () => invoke<ConvertToolStatus>('convert_tool_status');
export const installConvertTool = () => invoke<void>('install_convert_tool');
export const onConvertToolProgress = (fn: (pct: number) => void) => listen<number>('convert-tool-progress', e => fn(e.payload));
// index: among the subtitle tracks only. text: false for picture subtitles (unreadable).
// Review cards' own clips (src-tauri/src/clips.rs), in <own dir>/clips.
export const cutClip = (src: string, from: number, to: number, name: string, kind: 'video' | 'audio') =>
  invoke<{ file: string; image: string | null }>('cut_clip', { src, from, to, name, kind });
export const sweepClips = (keep: string[]) => invoke<number>('sweep_clips', { keep });
export const clipsInfo = () => invoke<{ dir: string; bytes: number }>('clips_info');
export const clipPath = async (file: string) => join(await ownDir(), 'clips', file);

// Backups (src-tauri/src/backup.rs, docs/backup.md). `dest` set = a backup the user saves by hand;
// unset = into <own dir>/backups as today's automatic one ("auto") or a before-restore one ("pre").
export const backupWrite = (dest: string | null, kind: 'auto' | 'pre', manifest: string, data: string, files: boolean) =>
  invoke<string>('backup_write', { dest, kind, manifest, data, files });
export const backupStage = (path: string) => invoke<string>('backup_stage', { path });
export const backupList = () => invoke<{ path: string; manifest: string }[]>('backup_list');
export const backupRead = (path: string) => invoke<{ manifest: string; data: string }>('backup_read', { path });
export const backupUnpack = (path: string) => invoke<number>('backup_unpack', { path });
export const backupKeptClips = () => invoke<string[] | null>('backup_kept_clips');
export const backupRemove = (names: string[]) => invoke<void>('backup_remove', { names });
const BACKUP_FILTER = { name: 'LinguaClip', extensions: ['zip'] };
export async function pickBackupDest(name: string): Promise<string | null> {
  return save({ defaultPath: name, filters: [BACKUP_FILTER] });
}
export async function pickBackupFile(): Promise<string | null> {
  const selected = await open({ multiple: false, filters: [BACKUP_FILTER] });
  return typeof selected === 'string' ? selected : null;
}

// Stable per-computer id (hash of the hardware UUID) + display name, for license seats.
export const deviceInfo = () => invoke<{ id: string; name: string }>('device_info');

export type SubTrack = { index: number; lang: string | null; title: string | null; codec: string; text: boolean };
export type VideoProbe = { duration: number | null; video: string | null; audio: string | null; subtitles: SubTrack[] };
export const probeVideo = (path: string) => invoke<VideoProbe>('probe_video', { path });

export type DragDropHandler = {
  onHover?: () => void;
  onLeave?: () => void;
  onDrop?: (paths: string[]) => void;
};

export async function listenDragDrop(handler: DragDropHandler): Promise<UnlistenFn> {
  return getCurrentWebview().onDragDropEvent((event) => {
    const { type } = event.payload;
    if (type === 'enter' || type === 'over') handler.onHover?.();
    else if (type === 'leave') handler.onLeave?.();
    else if (type === 'drop') handler.onDrop?.(event.payload.paths);
  });
}

export type CacheKind = 'words' | 'cloze' | 'breakdown' | 'segments' | 'levels' | 'trans';

// ~/Movies/LinguaClip on macOS, ~/Videos/LinguaClip on Windows; must match
// own_dir() in src-tauri/src/paths.rs.
export async function ownDir(): Promise<string> {
  return join(await homeDir(), IS_WINDOWS ? 'Videos' : 'Movies', 'LinguaClip');
}

export async function cacheFilePath(id: string, kind: CacheKind): Promise<string> {
  return join(await ownDir(), `${id}.${kind}.json`);
}

export async function readCacheText(id: string, kind: CacheKind): Promise<string | null> {
  try {
    const path = await cacheFilePath(id, kind);
    if (!(await exists(path))) return null;
    return await readTextFile(path);
  } catch {
    return null;
  }
}

export async function writeCacheText(id: string, kind: CacheKind, text: string): Promise<void> {
  await invoke('write_cache', { id, kind, text });
}

// Files that belong to a record besides the video: its .srt (generated ones sit
// in ~/Movies/LinguaClip, hand-picked ones usually beside the video) and our
// word/cloze/breakdown/segments/levels/trans caches. Only paths that exist.
export async function relatedFilePaths(id: string, videoPath: string, subtitleFileName: string): Promise<string[]> {
  const ours = await ownDir();
  const videoDir = videoPath.slice(0, Math.max(videoPath.lastIndexOf('/'), videoPath.lastIndexOf('\\')));
  return existing([
    ...await cachePaths(id),
    ...(subtitleFileName ? [await join(ours, subtitleFileName), await join(videoDir, subtitleFileName)] : []),
  ]);
}

// Just our word/cloze/breakdown/segments/levels/trans caches for a record, the ones that exist.
export async function cacheFilePaths(id: string): Promise<string[]> {
  return existing(await cachePaths(id));
}

const cachePaths = (id: string) => Promise.all((['words', 'cloze', 'breakdown', 'segments', 'levels', 'trans'] as const).map(k => cacheFilePath(id, k)));

async function existing(paths: string[]): Promise<string[]> {
  const unique = [...new Set(paths)];
  const found = await Promise.all(unique.map(pathExists));
  return unique.filter((_, i) => found[i]);
}

// Moves the file to the Trash / Recycle Bin (user can put it back).
export async function trashFile(path: string): Promise<void> {
  await invoke('trash_file', { path });
}

// Edge "Read aloud" voice through Rust (src-tauri/src/tts.rs). MP3 bytes, or
// null when it fails (offline, blocked, Microsoft changed the check).
export async function synthesizeSpeech(text: string, voice: string): Promise<ArrayBuffer | null> {
  try {
    const bytes = await invoke<ArrayBuffer | null>('tts', { text, voice });
    return bytes && bytes.byteLength > 0 ? bytes : null;
  } catch {
    return null;
  }
}

// AnkiConnect through Rust (src-tauri/src/anki.rs), which skips the system
// proxy. Resolves to the raw response text; rejects with "HTTP 502: …" etc.
export async function ankiRequest(url: string, body: string): Promise<string> {
  return invoke<string>('anki_request', { url, body });
}

// A web page in the user's browser (e.g. where to get a Groq key).
export async function openExternal(url: string): Promise<void> {
  await openUrl(url);
}

// Finder / Explorer with the file selected.
export async function revealInFolder(path: string): Promise<void> {
  await revealItemInDir(path);
}

// Where local transcription keeps its parts, and the model file this size
// actually uses (null = not downloaded yet). src-tauri/src/whisper_setup.rs.
export async function transcribeLocation(model: string): Promise<{ dir: string; model: string | null }> {
  return invoke('transcribe_location', { model });
}

// Window fullscreen (watch mode). The window's own, not the page's: Esc stays with the page.
export const isFullscreen = (): Promise<boolean> => getCurrentWindow().isFullscreen();
export const setFullscreen = (on: boolean): Promise<void> => getCurrentWindow().setFullscreen(on);

// One-click update (docs/update.md): the manifest is linguaclipapp.com/download/latest.json.
export type { Update };
export const appVersion = (): Promise<string> => getVersion();
export const checkForUpdate = (): Promise<Update | null> => check({ timeout: 20000 });
export const relaunchApp = (): Promise<void> => relaunch();
