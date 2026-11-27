// The in-app YouTube window (docs/youtube.md): whether home shows its entry, the
// quality a pick downloads at, and opening the window with the pill's wording.
// localStorage `linguaclip_youtube_entry` ('0' = off, default on) and
// `linguaclip_youtube_quality` (1080 / 720 / 480, default 1080).
import { useSyncExternalStore } from 'react';
import { installYouTubeTool, onYouTubeToolProgress, openYouTubeWindow } from './desktop';
import { loadConvertTool } from './convertTool';
import { t } from './i18n';
import { IMPORT_LANGS, loadImportLang } from './importLangs';

const ENTRY_KEY = 'linguaclip_youtube_entry';
const QUALITY_KEY = 'linguaclip_youtube_quality';
export const YOUTUBE_QUALITIES = [1080, 720, 480] as const;
export type YouTubeQuality = (typeof YOUTUBE_QUALITIES)[number];

const listeners = new Set<() => void>();
const read = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key: string, v: string) => {
  try { localStorage.setItem(key, v); } catch { /* localStorage unavailable */ }
  listeners.forEach(fn => fn());
};
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

export const youtubeEntryOn = () => read(ENTRY_KEY) !== '0';
export const setYouTubeEntry = (on: boolean) => write(ENTRY_KEY, on ? '1' : '0');
export const useYouTubeEntry = () => useSyncExternalStore(subscribe, youtubeEntryOn);

export const getYouTubeQuality = (): YouTubeQuality => {
  const n = Number(read(QUALITY_KEY));
  return (YOUTUBE_QUALITIES as readonly number[]).includes(n) ? (n as YouTubeQuality) : 1080;
};
export const setYouTubeQuality = (q: YouTubeQuality) => write(QUALITY_KEY, String(q));
export const useYouTubeQuality = () => useSyncExternalStore(subscribe, getYouTubeQuality);

// Settings' "download the YouTube parts": kept here, not in the component, so leaving the
// tab and coming back still shows the progress. pct: null = not downloading.
let download: { pct: number | null; failed: boolean } = { pct: null, failed: false };
const setDownload = (patch: Partial<typeof download>) => {
  download = { ...download, ...patch };
  listeners.forEach(fn => fn());
};
export const useYouTubeToolDownload = () => useSyncExternalStore(subscribe, () => download);

export async function downloadYouTubeTool(): Promise<void> {
  if (download.pct !== null) return;
  setDownload({ pct: 0, failed: false });
  const off = await onYouTubeToolProgress(pct => setDownload({ pct })).catch(() => () => {});
  try {
    await installYouTubeTool();
  } catch (err) {
    console.error('YouTube parts download failed:', err);
    setDownload({ failed: true });
  } finally {
    off();
    setDownload({ pct: null });
    loadConvertTool(); // ffmpeg came with it: the converter row above is ready too
  }
}

export function openYouTube(): Promise<void> {
  return openYouTubeWindow(
    loadImportLang(),
    IMPORT_LANGS.map(l => ({ code: l.value, label: t(l.key) })),
    {
      practice: t('youtube.practice'),
      langHint: t('youtube.langHint'),
      confirmTitle: t('youtube.confirmTitle'),
      confirmBody: t('youtube.confirmBody'),
      install: t('youtube.install'),
      notNow: t('youtube.notNow'),
      installing: t('youtube.installing'),
      failed: t('youtube.failed'),
      retry: t('youtube.retry'),
      adding: t('youtube.adding'),
      added: t('youtube.added'),
      notAdded: t('youtube.notAdded'),
      tryAgain: t('youtube.tryAgain'),
      backHome: t('youtube.backHome'),
    },
  );
}
