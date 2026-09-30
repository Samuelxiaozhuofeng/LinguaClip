import { useEffect, useRef, useState } from 'react';
import * as AI from '../utils/ai';
import { DefinitionState, emptyDefinition } from '../components/DefinitionPanel';
import { useT } from '../utils/i18n';
import { DictLang, lookupWord, senseList, DictEntry } from '../utils/dictionary';
import { lookupJa } from '../utils/jaLookup';

// Word lookup behind the definition popup, shared by the practice page and review.
// Dictionary first. AI answers instead when the dictionary has nothing (or no
// dictionary covers the language).
export const useLookup = (dictLang: DictLang | null, currentContext: string) => {
  const t = useT();
  const [def, setDef] = useState<DefinitionState>(emptyDefinition);
  const seqRef = useRef(0);
  // Every lookup starts from a click on a word: remember where, so the card opens beside
  // it — across from the word, but clear of the whole line above and below.
  const lastPress = useRef<DOMRect | null>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const btn = (e.target as Element)?.closest?.('button');
      const w = btn?.getBoundingClientRect(), l = btn?.closest('[data-lookup-line]')?.getBoundingClientRect() ?? w;
      lastPress.current = w && l ? new DOMRect(w.left, l.top, w.width, l.height) : null;
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, []);

  // `line` overrides the hook's context: a word looked up again from a list, not from the line on screen.
  const lookup = async (word: string, line?: string) => {
    const context = line ?? currentContext;
    const seq = ++seqRef.current;
    const mine = () => seq === seqRef.current;
    const ai = AI.aiReady();
    const anchor = lastPress.current ?? undefined;
    setDef({ ...emptyDefinition, word, anchor, loading: true });
    let dict: DictEntry[] | null = null;
    let offline = false;
    if (dictLang) {
      try { dict = dictLang === 'ja' ? await lookupJa(word) : await lookupWord(word, dictLang); } catch (e) { offline = true; console.error('Dictionary lookup failed:', e); }
    }
    if (!mine()) return;
    if (dict) return setDef({ ...emptyDefinition, word, anchor, dict, context });
    if (!ai) {
      const error = t(offline ? 'definition.dictOffline' : dictLang ? 'definition.notFound' : 'definition.noDictLang');
      return setDef({ ...emptyDefinition, word, anchor, failed: true, error });
    }
    try {
      const data = await AI.getWordDefinition(word, context);
      if (mine()) setDef({ ...emptyDefinition, word, anchor, data });
    } catch (e) {
      if (mine()) setDef({ ...emptyDefinition, word, anchor, failed: true, error: (e as Error).message });
    }
  };

  // AI points at the dictionary meaning this sentence uses.
  const explain = async () => {
    const seq = seqRef.current;
    const { word, context: ctx, dict } = def;
    if (!word || !dict) return;
    setDef(d => ({ ...d, aiLoading: true, aiError: undefined }));
    try {
      const pick = await AI.pickSense(word, ctx ?? '', senseList(dict).map(s => s.line));
      if (seq === seqRef.current) setDef(d => ({ ...d, pick, aiLoading: false }));
    } catch (e) {
      if (seq === seqRef.current) setDef(d => ({ ...d, aiLoading: false, aiError: (e as Error).message }));
    }
  };

  const closeDef = () => { seqRef.current++; setDef(emptyDefinition); };

  return { def, lookup, explain: AI.aiReady() ? explain : undefined, closeDef };
};
