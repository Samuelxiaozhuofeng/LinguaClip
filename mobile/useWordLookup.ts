// Word lookup on the phone (docs/mobile-web.md 7): Wiktionary is the only dictionary a
// web page can reach (Youdao / Cambridge / Eudic / Jisho refuse other sites), for every
// language. Not found → the AI answers by itself when one is set up (as the desktop's
// hooks/useLookup.ts does); found → "let AI explain" is offered on top. Japanese groups
// are looked up in dictionary form (jaLemma), as on the desktop.
import { useRef, useState } from 'react';
import type { Subtitle } from '../types';
import * as AI from '../utils/ai';
import { getDictSources, lookupWiktionary, senseToAnki, type DictEntry, type DictLang, type Sense } from '../utils/dictionary';
import { jaLemma } from '../utils/japanese';
import { addWord } from '../utils/review';

export type Def = {
  word: string; line: Subtitle; around: string; loading: boolean; dict: DictEntry[] | null;
  ai: AI.WordDefinition | null; aiBusy: boolean; aiError: string; error: 'notFound' | 'offline' | 'noDict' | '';
};
export type Keep = { definition: string; example: string; ai: string };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// The AI's answer as a card's meaning (plain text, escaped), the same shape as the desktop's.
export const aiFields = (d: AI.WordDefinition): Keep =>
  ({ definition: `<b>${esc(d.word)}</b> <i>(${esc(d.partOfSpeech)})</i><br/>${esc(d.definition)}`, example: '', ai: d.culture ?? '' });
export const senseFields = (e: DictEntry, s: Sense, ai: AI.WordDefinition | null): Keep =>
  ({ ...senseToAnki(e, s), ai: ai ? [ai.definition, ai.culture].filter(Boolean).join('\n') : '' });
// What a word kept from a list gets: its first meaning, else the AI's answer.
export const firstFields = (d: Def): Keep | null => {
  const e = d.dict?.[0];
  return e?.senses[0] ? senseFields(e, e.senses[0], d.ai) : d.ai ? aiFields(d.ai) : null;
};

export function useWordLookup(lang: DictLang | null, ja: boolean) {
  const [def, setDef] = useState<Def | null>(null);
  const seq = useRef(0);

  const askAI = (base: Def, n: number) => {
    setDef({ ...base, aiBusy: true, aiError: '' });
    AI.getWordDefinition(base.word, base.line.text, base.around, getDictSources().aiCulture).then(
      ai => { if (n === seq.current) setDef(d => d && { ...d, ai, aiBusy: false }); },
      (e: unknown) => { if (n === seq.current) setDef(d => d && { ...d, aiBusy: false, aiError: e instanceof Error ? e.message : String(e) }); },
    );
  };

  const lookup = async (word: string, line: Subtitle, around = '') => {
    const n = ++seq.current;
    const base: Def = { word, line, around, loading: true, dict: null, ai: null, aiBusy: false, aiError: '', error: '' };
    setDef(base);
    let dict: DictEntry[] | null = null;
    let error: Def['error'] = lang ? '' : 'noDict';
    if (lang) {
      try { dict = await lookupWiktionary(ja ? jaLemma(word) : word, lang); } catch (e) { console.warn('Wiktionary unreachable:', e); error = 'offline'; }
      if (!dict && !error) error = 'notFound';
    }
    if (n !== seq.current) return;
    const done: Def = { ...base, loading: false, dict, error: dict ? '' : error };
    setDef(done);
    if (!dict && AI.aiReady()) askAI(done, n);
  };

  const explain = () => { if (def && !def.aiBusy) askAI(def, seq.current); };
  const close = () => { seq.current++; setDef(null); };
  // A meaning into the word deck (cards as utils/review.ts writes them; a write that fails is only logged).
  const keep = (k: Keep, ref: { videoId: string; videoName: string }) => {
    if (!def) return;
    const l = def.line;
    addWord({ ...ref, text: l.text, start: l.startTime, end: l.endTime }, def.word, k.definition, k.example, k.ai).catch(console.error);
  };

  return { def, lookup, explain: AI.aiReady() ? explain : undefined, close, keep };
}
