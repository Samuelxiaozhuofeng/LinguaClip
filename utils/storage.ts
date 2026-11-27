import { Subtitle, PracticeConfig, AudioPaddingConfig, ClozeLevel, WordFront } from '../types';
import { CustomConfig, parseCustomConfig } from './customPick';
import { forgetPosAt, notifySyncDirty, touchPosAt, touchSyncSetting } from './syncMeta';

const STORAGE_KEY_PRACTICE = 'linguaclip_practice_config';
const STORAGE_KEY_AUDIO_PADDING = 'linguaclip_audio_padding';
export const STORAGE_KEY_LIBRARY_FILTER = 'linguaclip_library_filter';

export type LibraryFilter = 'all' | 'video' | 'podcast';

export const getLibraryFilter = (): LibraryFilter => {
  try {
    const v = localStorage.getItem(STORAGE_KEY_LIBRARY_FILTER);
    return v === 'video' || v === 'podcast' ? v : 'all';
  } catch {
    return 'all';
  }
};

// Local-only UI filter preference for the merged Learn shelf (never touches sync timestamps).
export const saveLibraryFilter = (filter: LibraryFilter) => {
  try { localStorage.setItem(STORAGE_KEY_LIBRARY_FILTER, filter); } catch { /* stays for this session only */ }
};

// Helper to format seconds to MM:SS
export const formatTimeCode = (seconds: number): string => {
  if (!seconds || isNaN(seconds)) return "00:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
};

// --- Practice Config Storage ---

// A practice session should have an end you can see from the start: four
// minutes of video is already 20-30 minutes of dictation. 0 (the whole video)
// stays available in Settings, it just is not what you get by default.
export const DEFAULT_SECTION_LENGTH = 4;

const parseClozeLevel = (value: unknown): ClozeLevel =>
  value === 'easy' || value === 'medium' || value === 'full' ? value : 'full';

export const getPracticeConfig = (): PracticeConfig => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY_PRACTICE);
    if (!stored) return { sectionLength: DEFAULT_SECTION_LENGTH, clozeLevel: 'full' };
    const parsed = JSON.parse(stored);
    return {
      ...parsed,
      sectionLength: parsed.sectionLength ?? DEFAULT_SECTION_LENGTH,
      clozeLevel: parseClozeLevel(parsed.clozeLevel),
    };
  } catch (e) {
    return { sectionLength: DEFAULT_SECTION_LENGTH, clozeLevel: 'full' };
  }
};

export const savePracticeConfig = (config: PracticeConfig) => {
  localStorage.setItem(STORAGE_KEY_PRACTICE, JSON.stringify(config));
  touchSyncSetting(STORAGE_KEY_PRACTICE);
};

// Local-only auto-enable of `saveClips` when enabling sync: writes raw JSON without filling
// defaults (`sectionLength`/`clozeLevel`) or bumping sync `settingAt`, so a fresh device
// never overwrites another device's practice settings on first sync.
export const enableLocalSaveClipsIfUnset = (): boolean => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PRACTICE);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    if ((parsed as PracticeConfig).saveClips !== undefined) return false;
    localStorage.setItem(STORAGE_KEY_PRACTICE, JSON.stringify({ ...parsed, saveClips: true }));
    return true;
  } catch {
    return false;
  }
};

export const getWordFront = (): WordFront => getPracticeConfig().wordFront === 'sentence' ? 'sentence' : 'word';
export const getWordVoice = (): 'clip' | 'tts' => getPracticeConfig().wordVoice === 'clip' ? 'clip' : 'tts';
export const getMasteredBtn = () => getPracticeConfig().masteredBtn !== false;
export const getWeekStats = () => getPracticeConfig().weekStats !== false;
export const getTodayBar = () => getPracticeConfig().todayBar !== false;
export const getLooseJudge = () => getPracticeConfig().looseJudge !== false;
export const getSubtitleMaskOn = () => getPracticeConfig().subtitleMask !== false;
export const getSlowReplay = () => getPracticeConfig().slowReplay !== false;
export const setPracticeFlag = (key: 'masteredBtn' | 'weekStats' | 'todayBar' | 'looseJudge' | 'subtitleMask' | 'slowReplay', on: boolean) => savePracticeConfig({ ...getPracticeConfig(), [key]: on });

// --- Audio Padding Config Storage ---

export const getAudioPaddingConfig = (): AudioPaddingConfig => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY_AUDIO_PADDING);
    // Default: 100ms start, 200ms end
    return stored ? JSON.parse(stored) : { startPadding: 100, endPadding: 200 };
  } catch (e) {
    return { startPadding: 100, endPadding: 200 };
  }
};

export const saveAudioPaddingConfig = (config: AudioPaddingConfig) => {
  localStorage.setItem(STORAGE_KEY_AUDIO_PADDING, JSON.stringify(config));
  touchSyncSetting(STORAGE_KEY_AUDIO_PADDING);
};
// --- Custom practice (utils/customPick.ts) ---

export const getCustomConfig = (): CustomConfig => parseCustomConfig(getPracticeConfig().custom);

export const saveCustomConfig = (custom: CustomConfig) => {
  savePracticeConfig({ ...getPracticeConfig(), custom });
};

// Where each video's next custom session starts, in seconds. Kept apart from the
// record's section progress, which custom practice never touches.
const STORAGE_KEY_CUSTOM_POS = 'linguaclip_custom_pos';

const readCustomPos = (): Record<string, number> => {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE_KEY_CUSTOM_POS) || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
};

export const getCustomPos = (videoId: string): number => {
  const n = readCustomPos()[videoId];
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0;
};

const writeCustomPos = (edit: (all: Record<string, number>) => void) => {
  try {
    const all = readCustomPos();
    edit(all);
    localStorage.setItem(STORAGE_KEY_CUSTOM_POS, JSON.stringify(all));
  } catch { /* only costs where the next session starts */ }
};

export const getAllCustomPos = (): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(readCustomPos())) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v;
  }
  return out;
};

export const setCustomPos = (videoId: string, sec: number) => {
  writeCustomPos(all => { all[videoId] = sec; });
  touchPosAt(videoId, 'custom');
  notifySyncDirty();
};
export const forgetCustomPos = (videoId: string) => {
  writeCustomPos(all => { delete all[videoId]; });
  forgetPosAt(videoId, 'custom');
  notifySyncDirty();
};

// --- Watch mode (components/WatchPage.tsx) ---
// Where each video's watching stopped, in seconds; its own map, so watching never
// moves the section progress or the next custom set.
const STORAGE_KEY_WATCH_POS = 'linguaclip_watch_pos';
const STORAGE_KEY_WATCH_PREFS = 'linguaclip_watch_prefs';

const readWatchPos = (): Record<string, number> => {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE_KEY_WATCH_POS) || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
};

export const getWatchPos = (videoId: string): number => {
  const n = readWatchPos()[videoId];
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0;
};

export const getAllWatchPos = (): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(readWatchPos())) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v;
  }
  return out;
};

const writeWatchPos = (edit: (all: Record<string, number>) => void) => {
  try {
    const all = readWatchPos();
    edit(all);
    localStorage.setItem(STORAGE_KEY_WATCH_POS, JSON.stringify(all));
  } catch { /* only costs where watching resumes */ }
};

export const setWatchPos = (videoId: string, sec: number) => {
  writeWatchPos(all => { all[videoId] = sec; });
  touchPosAt(videoId, 'watch');
  notifySyncDirty();
};
export const forgetWatchPos = (videoId: string) => {
  writeWatchPos(all => { delete all[videoId]; });
  forgetPosAt(videoId, 'watch');
  notifySyncDirty();
};

// How each video was last started (docs/watch.md): clicking it starts that again, no panel.
// Unreadable or unknown = never started = the panel asks.
export type LastWay = 'all' | 'custom' | 'watch' | 'read';
const STORAGE_KEY_LAST_WAY = 'linguaclip_last_way';
const readLastWay = (): Record<string, unknown> => {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE_KEY_LAST_WAY) || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
};
export const getLastWay = (videoId: string): LastWay | null => {
  const w = readLastWay()[videoId];
  return w === 'all' || w === 'custom' || w === 'watch' || w === 'read' ? w : null;
};
export const getAllLastWay = (): Record<string, LastWay> => {
  const out: Record<string, LastWay> = {};
  for (const [k, w] of Object.entries(readLastWay())) {
    if (w === 'all' || w === 'custom' || w === 'watch' || w === 'read') out[k] = w;
  }
  return out;
};
export const setLastWay = (videoId: string, way: LastWay | null) => {
  try {
    const all = readLastWay();
    if (way) all[videoId] = way; else delete all[videoId];
    localStorage.setItem(STORAGE_KEY_LAST_WAY, JSON.stringify(all));
  } catch { /* only costs a panel next time */ }
  if (way) touchPosAt(videoId, 'lastWay');
  else forgetPosAt(videoId, 'lastWay');
  notifySyncDirty();
};

// How subtitles show, whether each line pauses at its end, whether the
// start-of-practice panel last chose "watch", whether the controls are pinned,
// and whether the subtitle list is open and how wide (% of the window). The reader
// (pro/ReaderPage.tsx) keeps here how the panel last chose to read and whether
// furigana shows and whether looking a word up also plays its line; choosing to read
// is never kept as `chosen`.
export type WatchSubs = 'show' | 'blur' | 'hide';
export type ReadBy = 'all' | 'section';
export type ReaderSize = 's' | 'm' | 'l'; // the reader's video column (docs/reader.md「右侧视频大小」)
// listenSubs / podLang / listenThrough: the podcast page's (docs/private/podcast.md) — how much text shows, which
// language's shows are listed, whether a section's end plays on (free listening). listenIntro: the four-step card was seen.
// listenTries: step 2 plays each hard line this many times blind before showing its text.
export type WatchPrefs = { subs: WatchSubs; autoPause: boolean; chosen: boolean; pin: boolean; list: boolean; listPct: number; readBy: ReadBy; kana: boolean; autoClip: boolean; listenSubs: WatchSubs; podLang: string; listenThrough: boolean; listenIntro: boolean; listenTries: number; readerSize: ReaderSize; phraseMarks: boolean };
export const LISTEN_TRIES = [2, 3, 4, 5];
export const LIST_PCT = { min: 20, max: 50, def: 30 };

export const getWatchPrefs = (): WatchPrefs => {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE_KEY_WATCH_PREFS) || '{}') ?? {};
    const pct = typeof v.listPct === 'number' && Number.isFinite(v.listPct) ? Math.min(LIST_PCT.max, Math.max(LIST_PCT.min, v.listPct)) : LIST_PCT.def;
    return {
      subs: v.subs === 'blur' || v.subs === 'hide' ? v.subs : 'show', autoPause: v.autoPause === true, chosen: v.chosen !== false, pin: v.pin === true, list: v.list === true, listPct: pct, readBy: v.readBy === 'section' ? 'section' : 'all', kana: v.kana !== false, autoClip: v.autoClip === true,
      listenSubs: v.listenSubs === 'blur' || v.listenSubs === 'show' ? 'show' : 'hide', podLang: typeof v.podLang === 'string' ? v.podLang : '', listenThrough: v.listenThrough === true, listenIntro: v.listenIntro === true, listenTries: LISTEN_TRIES.includes(v.listenTries) ? v.listenTries : 3,
      readerSize: v.readerSize === 's' || v.readerSize === 'l' ? v.readerSize : 'm', phraseMarks: v.phraseMarks === true,
    };
  } catch {
    return { subs: 'show', autoPause: false, chosen: true, pin: false, list: false, listPct: LIST_PCT.def, readBy: 'all', kana: true, autoClip: false, listenSubs: 'hide', podLang: '', listenThrough: false, listenIntro: false, listenTries: 3, readerSize: 'm', phraseMarks: false };
  }
};

export const saveWatchPrefs = (patch: Partial<WatchPrefs>) => {
  try { localStorage.setItem(STORAGE_KEY_WATCH_PREFS, JSON.stringify({ ...getWatchPrefs(), ...patch })); } catch { /* stays for this session only */ }
  touchSyncSetting(STORAGE_KEY_WATCH_PREFS);
};

// Local-only write for `chosen` (never synced): writes raw JSON without filling
// defaults (`subs`/`autoPause`/etc.) or bumping `settingAt`, so switching ways on a
// fresh device never overwrites another device's watch/listen preferences on first sync.
export const saveLocalWatchChosen = (chosen: boolean) => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_WATCH_PREFS);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      localStorage.setItem(STORAGE_KEY_WATCH_PREFS, JSON.stringify({ chosen }));
      return;
    }
    localStorage.setItem(STORAGE_KEY_WATCH_PREFS, JSON.stringify({ ...parsed, chosen }));
  } catch { /* stays for this session only */ }
};
