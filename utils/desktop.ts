/**
 * Tauri desktop helpers: pick files, read subtitles, check paths, listen for drops.
 */
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { homeDir, join } from '@tauri-apps/api/path';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener';
import { exists, readFile, readTextFile } from '@tauri-apps/plugin-fs';
import { IS_WINDOWS } from './platform';

const VIDEO_FILTER = { name: 'Video', extensions: ['mp4', 'mov', 'm4v'] };
const SUBTITLE_FILTER = { name: 'Subtitles', extensions: ['srt'] }; // parseSRT reads nothing else

export function fileNameFromPath(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

export function videoSrcFromPath(path: string): string {
  return convertFileSrc(path);
}

export async function pickVideoPath(): Promise<string | null> {
  const selected = await open({ multiple: false, filters: [VIDEO_FILTER] });
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

export type CacheKind = 'words' | 'cloze' | 'breakdown' | 'segments' | 'levels';

// ~/Movies/LinguaClip on macOS, ~/Videos/LinguaClip on Windows; must match
// own_dir() in src-tauri/src/paths.rs.
async function ownDir(): Promise<string> {
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
// word/cloze/breakdown/segments/levels caches. Only paths that exist.
export async function relatedFilePaths(id: string, videoPath: string, subtitleFileName: string): Promise<string[]> {
  const ours = await ownDir();
  const videoDir = videoPath.slice(0, Math.max(videoPath.lastIndexOf('/'), videoPath.lastIndexOf('\\')));
  return existing([
    ...await cachePaths(id),
    ...(subtitleFileName ? [await join(ours, subtitleFileName), await join(videoDir, subtitleFileName)] : []),
  ]);
}

// Just our word/cloze/breakdown/segments/levels caches for a record, the ones that exist.
export async function cacheFilePaths(id: string): Promise<string[]> {
  return existing(await cachePaths(id));
}

const cachePaths = (id: string) => Promise.all((['words', 'cloze', 'breakdown', 'segments', 'levels'] as const).map(k => cacheFilePath(id, k)));

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
