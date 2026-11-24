// Word lookup on the phone (docs/mobile-web.md 7, docs/android-roadmap.md M1.4):
// Web/PWA uses Wiktionary via wordPlatform.ts; Android native swaps in wordPlatform.android.ts
// for the full desktop dictionary suite (CORS-free) and aux-channel pronunciation.
// Not found → AI answers by itself when configured; found → optional auto-pick and "let AI explain".
import { useEffect, useRef, useState } from 'react';
import type { Subtitle } from '../types';
import * as AI from '../utils/ai';
import { clean } from '../utils/cleanHtml';
import { getDictSources, senseList, senseToAnki, type DictEntry, type DictLang, type Seg, type Sense } from '../utils/dictionary';
import { addWord } from '../utils/review';
import { lookupOnlineWord, stopWordAux, type LookupError } from './platform/wordPlatform';
import { isPhraseText } from './reader/phrasePick';

export type Def = {
  word: string; line: Subtitle; around: string; lang: DictLang | null;
  phrase?: boolean;
  loading: boolean; dict: DictEntry[] | null;
  ai: AI.WordDefinition | null; aiBusy: boolean; aiError: string;
  picked?: number | null; pickNote?: string; pickCulture?: string;
  error: LookupError;
};
export type Keep = { definition: string; example: string; ai: string };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Only https:// glyph URLs are permitted for Eudic anti-scraping character images.
export const isSafeImgUrl = (url: string): boolean => {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
};

export const sanitizeSegs = (segs: Seg[]): Seg[] =>
  segs.flatMap<Seg>(p => (typeof p === 'string' || 'ruby' in p ? [p] : isSafeImgUrl(p.img) ? [{ img: new URL(p.img).href }] : []));

const sanitizeHtml = (html: string): string => (typeof DOMParser !== 'undefined' ? clean(html) : html);

// The AI's answer as a card's meaning (plain text, escaped + whitelist cleaned), the same shape as the desktop's.
export const aiFields = (d: AI.WordDefinition): Keep => ({
  definition: sanitizeHtml(`<b>${esc(d.word)}</b> <i>(${esc(d.partOfSpeech)})</i><br/>${esc(d.definition)}`),
  example: '',
  ai: d.culture ?? '',
});

export const senseFields = (e: DictEntry, s: Sense, ai: AI.WordDefinition | null, extraAi = ''): Keep => {
  const safeSense: Sense = { ...s, text: sanitizeSegs(s.text), examples: s.examples.map(sanitizeSegs) };
  const aiText = ai ? [ai.definition, ai.culture].filter(Boolean).join('\n') : extraAi;
  const raw = senseToAnki(e, safeSense);
  return { definition: sanitizeHtml(raw.definition), example: sanitizeHtml(raw.example), ai: aiText };
};

// What a word kept from a list gets: the AI-picked sense if any, else the first meaning, else the AI's answer.
export const firstFields = (d: Def): Keep | null => {
  const pickAi = [d.pickNote, d.pickCulture].filter(Boolean).join('\n');
  if (d.dict) {
    if (d.picked != null) {
      let n = 0;
      for (const e of d.dict) {
        for (const s of e.senses) {
          if (++n === d.picked) return senseFields(e, s, d.ai, pickAi);
        }
      }
    }
    const e = d.dict[0];
    if (e?.senses[0]) return senseFields(e, e.senses[0], d.ai, pickAi);
  }
  return d.ai ? aiFields(d.ai) : null;
};

export function useWordLookup(lang: DictLang | null, ja: boolean) {
  const [def, setDef] = useState<Def | null>(null);
  const seq = useRef(0);

  useEffect(() => () => stopWordAux(), []);

  const askAI = (base: Def, n: number) => {
    setDef({ ...base, aiBusy: true, aiError: '' });
    AI.getWordDefinition(base.word, base.line.text, base.around, getDictSources().aiCulture).then(
      ai => { if (n === seq.current) setDef(d => d && { ...d, ai, aiBusy: false }); },
      (e: unknown) => { if (n === seq.current) setDef(d => d && { ...d, aiBusy: false, aiError: e instanceof Error ? e.message : String(e) }); },
    );
  };

  const runPick = (base: Def, n: number, culture: boolean) => {
    if (!base.dict) return;
    setDef(d => d && { ...d, aiBusy: true, aiError: '' });
    AI.pickSense(base.word, base.line.text, senseList(base.dict).map(s => s.line), base.around, culture).then(
      pick => {
        if (n === seq.current) {
          setDef(d => d && { ...d, picked: pick.index, pickNote: pick.note, pickCulture: pick.culture, aiBusy: false });
        }
      },
      (e: unknown) => {
        if (n === seq.current) {
          setDef(d => d && { ...d, aiBusy: false, aiError: e instanceof Error ? e.message : String(e) });
        }
      },
    );
  };

  const lookup = async (word: string, line: Subtitle, around = '', phrase?: boolean) => {
    stopWordAux();
    const n = ++seq.current;
    const isPhrase = phrase ?? isPhraseText(word, ja);
    const base: Def = {
      word, line, around, lang, phrase: isPhrase, loading: true, dict: null,
      ai: null, aiBusy: false, aiError: '', picked: null, error: '',
    };
    setDef(base);
    const { dict, error } = await lookupOnlineWord(word, lang, ja);
    if (n !== seq.current) return;
    const done: Def = { ...base, loading: false, dict, error: dict ? '' : error };
    setDef(done);
    if (!dict && AI.aiReady()) {
      askAI(done, n);
      return;
    }
    if (dict && AI.aiReady()) {
      const { autoPick, aiAlways, aiCulture } = getDictSources();
      if (autoPick && (aiAlways || isPhrase || senseList(dict).length > 3)) {
        runPick(done, n, aiCulture);
      }
    }
  };

  const explain = () => { if (def && !def.aiBusy) askAI(def, seq.current); };
  const close = () => { seq.current++; stopWordAux(); setDef(null); };
  // A meaning into the word deck (cards as utils/review.ts writes them; a write that fails is only logged).
  const keep = (k: Keep, ref: { videoId: string; videoName: string }) => {
    if (!def) return;
    const l = def.line;
    addWord({ ...ref, text: l.text, start: l.startTime, end: l.endTime }, def.word, k.definition, k.example, k.ai).catch(console.error);
  };

  return { def, lookup, explain: AI.aiReady() ? explain : undefined, close, keep };
}
