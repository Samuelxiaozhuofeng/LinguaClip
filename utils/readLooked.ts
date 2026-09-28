import { useSyncExternalStore } from 'react';
import { jaLemma, jaMorphs, jaReady } from './japanese';

// What the reader (components/ReaderPage.tsx) keeps per video, in localStorage:
// - `linguaclip_read_looked`: words looked up while reading, so the watch page can mark
//   them on the subtitle. Word keys: Japanese in dictionary form (食べました → 食べる, and
//   passive / causative dropped too: 頼まれた → 頼む, so 頼むから matches), other
//   languages lowercased without punctuation.
// - `linguaclip_read_gloss`: the first meaning found for each of those words (plain
//   text, 40 chars), shown when pointing at a marked word while watching.
// - `linguaclip_read_pos`: where reading stopped (start second of the top line).
// Losing any of it only loses the marks, the hints or the place.

const LOOKED = 'linguaclip_read_looked';
const GLOSS = 'linguaclip_read_gloss';
const POS = 'linguaclip_read_pos';
const MAX = 500; // words per video; the oldest drop off
const GLOSS_LEN = 40;

type Store = Record<string, unknown>;
const read = (key: string): Store => {
  try {
    const v = JSON.parse(localStorage.getItem(key) || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
};

let version = 0;
const listeners = new Set<() => void>();
// `quiet`: nothing on screen shows it (the reading place), so nothing re-renders.
const write = (key: string, edit: (all: Store) => void, quiet = false) => {
  try {
    const all = read(key);
    edit(all);
    localStorage.setItem(key, JSON.stringify(all));
  } catch { /* only the marks / hints / place are lost */ }
  if (quiet) return;
  version++;
  listeners.forEach(fn => fn());
};

// `ja`: the video is Japanese. null = not a word that can be kept: without the splitting
// dictionary a Japanese line is one whole-line "word", and marking that marks nothing useful.
export const lookedKey = (word: string, ja: boolean): string | null => {
  if (ja) return jaReady() ? jaKey(word).trim() || null : null;
  const k = word.toLowerCase().replace(/[^\p{L}\p{N}'’-]/gu, '');
  return k || null;
};

// jaLemma keeps a verb's れる / させる (頼まれた → 頼まれる, which is what gets looked
// up); a mark wants the verb itself.
const jaKey = (word: string): string => {
  const ms = jaMorphs(word)?.filter(m => !m.punct) ?? [];
  const cut = ms.findIndex((m, i) => i > 0 && m.pos === '動詞' && m.d1 === '接尾' && ms[i - 1].pos === '動詞');
  return cut > 0 ? ms.slice(0, cut - 1).map(m => m.s).join('') + ms[cut - 1].base : jaLemma(word);
};

export const getLooked = (videoId: string): string[] => {
  const v = read(LOOKED)[videoId];
  return Array.isArray(v) ? v.filter((w): w is string => typeof w === 'string') : [];
};

export const addLooked = (videoId: string, word: string, ja: boolean) => {
  const key = lookedKey(word, ja);
  if (!key) return;
  write(LOOKED, all => {
    const list = getLooked(videoId).filter(w => w !== key);
    all[videoId] = [...list, key].slice(-MAX);
  });
};

// word key → meaning, for this video's looked-up words.
export const getGloss = (videoId: string): Record<string, string> => {
  const v = read(GLOSS)[videoId];
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string'));
};

// Kept only for words still on the looked-up list, so it never outgrows it.
export const setGloss = (videoId: string, word: string, ja: boolean, meaning: string) => {
  const key = lookedKey(word, ja);
  const text = meaning.replace(/\s+/g, ' ').trim();
  if (!key || !text) return;
  const kept = new Set(getLooked(videoId));
  if (!kept.has(key)) return;
  write(GLOSS, all => {
    const now = Object.fromEntries(Object.entries(getGloss(videoId)).filter(([k]) => kept.has(k)));
    now[key] = text.length > GLOSS_LEN ? `${text.slice(0, GLOSS_LEN)}…` : text;
    all[videoId] = now;
  });
};

export const getReadPos = (videoId: string): number => {
  const n = read(POS)[videoId];
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
};
export const setReadPos = (videoId: string, sec: number) => write(POS, all => { all[videoId] = Math.max(0, sec); }, true);

export const forgetLooked = (videoId: string) => {
  for (const key of [LOOKED, GLOSS, POS]) write(key, all => { delete all[videoId]; });
};

const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
// Re-renders when anything here changes.
export const useLookedVersion = () => useSyncExternalStore(subscribe, () => version);
