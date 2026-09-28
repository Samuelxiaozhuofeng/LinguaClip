import { useSyncExternalStore } from 'react';
import { jaLemma, jaMorphs, jaReady } from './japanese';

// Words looked up while reading a video's subtitles (components/ReaderPage.tsx), so
// the watch page can mark them on the subtitle. Kept per video in localStorage
// `linguaclip_read_looked` as word keys: Japanese in dictionary form (食べました →
// 食べる, and passive / causative dropped too: 頼まれた → 頼む, so 頼むから matches),
// other languages lowercased without punctuation. Losing it only loses the marks.

const KEY = 'linguaclip_read_looked';
const MAX = 500; // per video; the oldest drop off

const read = (): Record<string, string[]> => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
};

let version = 0;
const listeners = new Set<() => void>();
const write = (edit: (all: Record<string, string[]>) => void) => {
  try {
    const all = read();
    edit(all);
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch { /* only the marks are lost */ }
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
  const v = read()[videoId];
  return Array.isArray(v) ? v.filter((w): w is string => typeof w === 'string') : [];
};

export const addLooked = (videoId: string, word: string, ja: boolean) => {
  const key = lookedKey(word, ja);
  if (!key) return;
  write(all => {
    const list = (Array.isArray(all[videoId]) ? all[videoId] : []).filter(w => w !== key);
    all[videoId] = [...list, key].slice(-MAX);
  });
};

export const forgetLooked = (videoId: string) => write(all => { delete all[videoId]; });

const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
// Re-renders when the list changes; the set itself is rebuilt per version.
export const useLookedVersion = () => useSyncExternalStore(subscribe, () => version);
