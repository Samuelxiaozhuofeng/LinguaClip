// How hard an episode is for this listener: the
// speaking rate worked out from its transcript, and what the listener said they understood
// after listening blind — two "little" in a row suggests an easier show, three "most" a
// harder one, picked from the recommended list.
import type { Subtitle, VideoRecord } from '../types';
import { parseSRT } from '../utils/srtParser';
import { videoLang } from '../utils/deckLang';
import { SHOWS, SHOW_LANGS, type Level, type Pick, type ShowLang } from './podcastShows';

export type Rate = { n: number; unit: 'word' | 'char'; tier?: 'slow' | 'mid' | 'fast' };
export type Heard = 'most' | 'half' | 'little';
export type Way = 'easier' | 'harder';

// Words a minute where a word is spaced out; characters where it isn't (ja / zh / ko), which
// gets no tier — character counts don't line up with any usual speaking-rate scale.
const SLOW = 120, FAST = 170; // ponytail: one rough scale for every spaced language
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
export const speechRate = (lines: Subtitle[]): Rate | null => {
  const text = lines.map(l => l.text).join(' ');
  const secs = lines.reduce((s, l) => s + Math.max(0, l.endTime - l.startTime), 0); // speaking time only
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  if (secs < 30 || !letters) return null;
  const cjk = text.match(CJK)?.length ?? 0;
  if (cjk / letters >= 0.5) return { n: Math.round(cjk / (secs / 60)), unit: 'char' };
  const n = Math.round((text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0) / (secs / 60));
  return { n, unit: 'word', tier: n < SLOW ? 'slow' : n > FAST ? 'fast' : 'mid' };
};

const pickOf = (feed?: string) => (feed ? SHOWS.find(s => s.feed === feed) : undefined);

// A card's rate: parsing a whole transcript per card is slow, so once per record + text length.
// Shows taught in English get none: half the transcript isn't the language being learnt.
const rates = new Map<string, Rate | null>();
export const recordRate = (r: VideoRecord): Rate | null => {
  if (!r.subtitleText || pickOf(r.podcast?.feed)?.english) return null;
  const key = `${r.id}|${r.subtitleText.length}`;
  if (!rates.has(key)) rates.set(key, speechRate(parseSRT(r.subtitleText)));
  return rates.get(key) ?? null;
};

// --- What the listener said, per show (a podcast's feed; a sound file's record id) ---
const KEY = 'linguaclip_listen_level';
const read = (): Record<string, Heard[]> => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; } // unreadable: start over, never in the way
};
export const showKey = (r: VideoRecord) => r.podcast?.feed ?? r.id;

// Records one answer; returns the way to suggest when the last answers agree, and then
// forgets this show's answers so the next hint needs as many again.
export const noteHeard = (key: string, a: Heard): Way | null => {
  const all = read();
  const list = [...(Array.isArray(all[key]) ? all[key] : []), a].slice(-5);
  const way: Way | null = list.slice(-2).length === 2 && list.slice(-2).every(x => x === 'little') ? 'easier'
    : list.slice(-3).length === 3 && list.slice(-3).every(x => x === 'most') ? 'harder' : null;
  all[key] = way ? [] : list;
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* not kept: no hint later, nothing else */ }
  return way;
};

// The show's language: the recommended list says it; a pasted show's is guessed from its transcript.
export const showLang = (r: VideoRecord): ShowLang | null => {
  const p = pickOf(r.podcast?.feed);
  if (p) return p.lang;
  const text = (r.subtitleText ?? '').slice(0, 4000);
  if ((text.match(/\p{Script=Hangul}/gu)?.length ?? 0) > 20) return 'ko';
  const l = videoLang(r);
  return (SHOW_LANGS as string[]).includes(l) ? (l as ShowLang) : null;
};

// Up to two recommended shows one level easier / harder than this one (a pasted show's level
// is unknown: easier = beginner, harder = intermediate then advanced). With none a level
// away, easier falls back to the same level's slow shows.
const LEVELS: Level[] = ['beginner', 'intermediate', 'advanced'];
export const suggestShows = (way: Way, feed: string | undefined, lang: ShowLang | null): Pick[] => {
  if (!lang) return [];
  const cur = pickOf(feed);
  const others = SHOWS.filter(s => s.lang === lang && s.feed !== feed);
  const at = cur ? LEVELS.indexOf(cur.level) : -1;
  const want: Level[] = way === 'easier'
    ? (at > 0 ? [LEVELS[at - 1]] : at < 0 ? ['beginner'] : [])
    : (at >= 0 ? LEVELS.slice(at + 1, at + 2) : ['intermediate', 'advanced']);
  let found = others.filter(s => want.includes(s.level));
  if (!found.length && way === 'easier' && cur) found = others.filter(s => s.level === cur.level && s.slow);
  if (way === 'easier') found.sort((a, b) => Number(b.slow) - Number(a.slow));
  return found.slice(0, 2);
};
