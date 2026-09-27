/**
 * Which language deck a video, and so each of its review cards, belongs to.
 *
 * Nothing is stored on the cards: a card's language is its video's, worked out
 * on the fly — what the user picked in the video's "…" menu (`record.lang`),
 * else guessed from all the video's subtitle lines. So correcting a video moves
 * all its cards, and old cards need no migration.
 */
import { detectLang, type DictLang } from './dictionary';
import { parseSRT } from './srtParser';
import type { ReviewCard } from './review';

export type DeckLang = DictLang | 'other'; // 'other' = couldn't tell ("Unsorted")
export const DECK_LANGS: DeckLang[] = ['ja', 'es', 'en', 'fr', 'de', 'other'];

export interface LangSource { id: string; lang?: DictLang; subtitleText?: string }

// Guessing parses the whole subtitle file, so remember it per id + text length.
const guessed = new Map<string, DictLang | null>();
export const videoLang = (r: LangSource): DeckLang => {
  if (r.lang) return r.lang;
  const key = `${r.id}|${r.subtitleText?.length ?? 0}`;
  if (!guessed.has(key)) guessed.set(key, r.subtitleText ? detectLang(parseSRT(r.subtitleText).map(s => s.text)) : null);
  return guessed.get(key) ?? 'other';
};

// Card id → language. A card whose video record is gone is judged by all the
// cards it shares a video with; an old bookmark with no video, by its own line.
export const cardLangs = (cards: ReviewCard[], records: LangSource[]): Map<string, DeckLang> => {
  const byVideo = new Map<string, DeckLang>(records.map(r => [r.id, videoLang(r)]));
  const orphanTexts = new Map<string, string[]>();
  for (const c of cards) if (c.videoId && !byVideo.has(c.videoId)) orphanTexts.set(c.videoId, [...(orphanTexts.get(c.videoId) ?? []), c.text]);
  for (const [id, texts] of orphanTexts) byVideo.set(id, detectLang(texts) ?? 'other');
  return new Map(cards.map(c => [c.id, byVideo.get(c.videoId) ?? detectLang([c.text]) ?? 'other']));
};

// The language's name in the interface language ("日语" / "Japanese").
export const langName = (lang: DeckLang, ui: string, unsorted: string) => {
  if (lang === 'other') return unsorted;
  try { return new Intl.DisplayNames([ui === 'zh' ? 'zh-CN' : 'en'], { type: 'language' }).of(lang) ?? lang; } catch { return lang; }
};
