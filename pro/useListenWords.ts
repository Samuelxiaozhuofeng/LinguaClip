import { useEffect, useMemo, useRef, useState } from 'react';
import type { Subtitle, VideoRecord } from '../types';
import { keepFields } from '../components/DefinitionPanel';
import type { Looked } from '../components/WatchSummary';
import { useLookup, aroundOf } from '../hooks/useLookup';
import { addLine, addWord, lineCardsFor, type ReviewCard } from '../utils/review';
import type { DictLang } from '../utils/dictionary';
import { addLooked, getLooked, lookedKey, useLookedVersion } from '../utils/readLooked';

// What the listening page sends to review: words looked up (kept from the card or the summary)
// and the hard lines ticked in the summary — added as "missed", then dictated.

export type Word = Looked & { key: string; fields?: { definition: string; example: string; ai: string } | null };

export function useListenWords(record: VideoRecord, lines: Subtitle[], dictLang: DictLang, ja: boolean, marks: Map<number, unknown>) {
  const lookedVersion = useLookedVersion();
  const looked = useMemo(() => new Set(getLooked(record.id)), [record.id, lookedVersion]);
  const { def, lookup, explain, closeDef } = useLookup(dictLang, '');
  const lookLine = useRef<Subtitle | null>(null);
  const [words, setWords] = useState<Word[]>([]); // since the last summary
  const [kept, setKept] = useState<Set<string>>(new Set());
  const keyOf = (word: string) => lookedKey(word, ja) ?? word.toLowerCase();
  const lookUp = (word: string, line: Subtitle) => { lookLine.current = line; lookup(word, line.text, aroundOf(lines, lines.indexOf(line))); };
  const noteWord = (word: string, line: Subtitle) => { // a word clicked in the text: looked up, and listed for the summary
    addLooked(record.id, word, ja);
    const key = keyOf(word);
    setWords(ws => (ws.some(w => w.key === key) ? ws : [...ws, { word, line, key }]));
    lookUp(word, line);
  };
  useEffect(() => {
    if (!def.word || def.loading) return;
    const k = keyOf(def.word);
    const fields = keepFields(def, lookedKey(def.word, ja));
    setWords(ws => ws.map(w => (w.key === k && (!w.fields || (fields && fields.ai !== w.fields.ai && def.context === w.line.text)) ? { ...w, fields } : w)));
  }, [def]); // eslint-disable-line react-hooks/exhaustive-deps
  const keep = (word: string, l: Subtitle, definition: string, example: string, ai = '') => {
    const k = keyOf(word);
    setKept(s => new Set(s).add(k));
    addWord({ videoId: record.id, videoName: record.videoFileName, text: l.text, start: l.startTime, end: l.endTime }, word, definition, example, ai)
      .catch(e => { console.error(e); setKept(s => { const n = new Set(s); n.delete(k); return n; }); });
  };
  const keepOne = (w: Word) => { if (w.fields) keep(w.word, w.line, w.fields.definition, w.fields.example, w.fields.ai); };

  // The hard lines ticked go into review first (one at a time: a failure leaves the rest for "again", which adds nothing twice).
  const [adding, setAdding] = useState(false);
  const [addFail, setAddFail] = useState(false);
  const [drill, setDrill] = useState<ReviewCard[] | null>(null);
  const [drillMissing, setDrillMissing] = useState(false);
  const addMissed = async (picked: Subtitle[]) => {
    setAdding(true); setAddFail(false);
    try {
      for (const l of picked) if (marks.has(l.id)) await addLine({ videoId: record.id, videoName: record.videoFileName, text: l.text, start: l.startTime, end: l.endTime }, 'missed');
      return true;
    } catch (e) { console.error(e); setAddFail(true); setAdding(false); return false; }
  };
  const startDrill = async (picked: Subtitle[]) => {
    setDrillMissing(false);
    if (!(await addMissed(picked))) return;
    const cards = await lineCardsFor(record.id, picked).catch(() => [] as ReviewCard[]);
    setAdding(false);
    if (cards.length < picked.length) setDrillMissing(true); // a star whose write failed has no card
    if (cards.length) setDrill(cards);
  };
  const clearNotes = () => { setAddFail(false); setDrillMissing(false); }; // a summary opening afresh

  return { looked, def, explain, closeDef, lookLine, lookUp, noteWord, words, setWords, kept, keep, keepOne, adding, addFail, addMissed, drill, setDrill, drillMissing, startDrill, clearNotes };
}
