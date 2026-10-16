import { useEffect, useMemo, useState } from 'react';
import type { Word } from './resegment';
import { readCacheText } from './desktop';

// Per-word timings (App-generated subtitles only, saved at import as
// <id>.words.json) let "play this word" and "play from this word" land on the
// word itself. Without them, or when a line's words do not match its text
// (hand-edited, other subtitle file), callers fall back to a letter-count guess.

// Sub-second nudges around what whisper reports; its word edges run a touch tight.
export const PLAY_FROM_LEAD_SEC = 0.35;
export const WORD_LEAD_SEC = 0.08;
export const WORD_TAIL_SEC = 0.12;
// Some words come back a few ms long; played as is, that is a click or nothing.
export const WORD_MIN_SEC = 0.3;

const loaded = new Map<string, Promise<Word[] | null>>();

// A record's word list, read once per session. Missing or unreadable = null.
export function loadWords(recordId: string): Promise<Word[] | null> {
  let p = loaded.get(recordId);
  if (!p) {
    p = readCacheText(recordId, 'words').then(parseWords, () => null);
    loaded.set(recordId, p);
  }
  return p;
}

// The timed words of one line of a record, ready for DictationLine's timedWords.
export function useTimedWords(recordId: string | null | undefined, start: number, end: number): Word[] | undefined {
  const [words, setWords] = useState<{ id: string; list: Word[] | null } | null>(null);
  useEffect(() => {
    if (!recordId) return;
    let live = true;
    loadWords(recordId).then(list => { if (live) setWords({ id: recordId, list }); });
    return () => { live = false; };
  }, [recordId]);
  return useMemo(() => words && words.id === recordId ? wordsInLine(words.list, start, end) : undefined, [words, recordId, start, end]);
}

export function parseWords(raw: string | null): Word[] | null {
  try {
    const list = JSON.parse(raw ?? 'null');
    if (!Array.isArray(list)) return null;
    const ok = list.every(w => w && typeof w.w === 'string' && Number.isFinite(w.from) && Number.isFinite(w.to));
    return ok && list.length ? list : null;
  } catch { return null; }
}

// The words spoken around a line (whisper's edges drift past the line's by a
// few hundred ms), their times turned into 0..1 of the line so they mean the
// same thing wherever the line is played. wordSpans picks the line's own run.
const AROUND_MS = 800;
export function wordsInLine(words: Word[] | null, start: number, end: number): Word[] | undefined {
  const dur = (end - start) * 1000;
  if (!words || dur <= 0) return undefined;
  const a = start * 1000;
  const near = words.filter(w => w.to > a - AROUND_MS && w.from < a + dur + AROUND_MS);
  return near.length ? near.map(w => ({ w: w.w, from: (w.from - a) / dur, to: (w.to - a) / dur })) : undefined;
}

const letters = (s: string) => Array.from(s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, ''));

// Where each typed word (the line's own split) sits in the timed words, matched
// letter by letter: whisper's "well-being" covers the boxes "well" and "being",
// each getting its share of the word by letters. The line is the run of timed
// words spelling exactly its letters, the one starting nearest the line's start;
// null if there is none (hand-edited line, other subtitles). `onEdge`, when given,
// gets per token whether both its ends are timed-word ends (not shared out by letters).
export function wordSpans(tokens: string[], around: Word[] | undefined, onEdge?: boolean[]): [number, number][] | null {
  if (!around) return null;
  const tokenLetters = tokens.map(letters);
  const target = tokenLetters.flat().join('');
  if (!target || tokenLetters.some(l => l.length === 0)) return null;
  const words = runSpelling(around, target);
  if (!words) return null;
  const owner: { k: number; at: number; of: number }[] = [];
  words.forEach((w, k) => { const n = letters(w.w).length; for (let at = 0; at < n; at++) owner.push({ k, at, of: n }); });
  const time = (c: { k: number; at: number; of: number }, edge: 0 | 1) => {
    const w = words[c.k];
    return w.from + ((c.at + edge) / c.of) * (w.to - w.from);
  };
  let pos = 0;
  return tokenLetters.map(l => {
    const first = owner[pos], last = owner[pos + l.length - 1];
    const span: [number, number] = [time(first, 0), time(last, 1)];
    onEdge?.push(first.at === 0 && last.at + 1 === last.of);
    pos += l.length;
    return span;
  });
}

function runSpelling(words: Word[], target: string): Word[] | null {
  const starts = words.map((w, k) => k).sort((x, y) => Math.abs(words[x].from) - Math.abs(words[y].from));
  for (const k of starts) {
    let got = '';
    for (let j = k; j < words.length && got.length < target.length; j++) {
      got += letters(words[j].w).join('');
      if (got === target) return words.slice(k, j + 1);
    }
  }
  return null;
}

// What to play of a line [start, end] seconds: from fromRatio (a little early,
// so the onset is not clipped) to toRatio (a little late, and at least
// WORD_MIN_SEC in all), or on to the line's end. Word times can lie just
// outside the line (whisper drift); they are pulled back onto it first.
export function playSpan(start: number, end: number, fromRatio = 0, toRatio?: number): [number, number] {
  const at = (r: number) => start + Math.min(1, Math.max(0, r)) * (end - start);
  if (toRatio === undefined) return [Math.max(start, at(fromRatio) - (fromRatio > 0 ? PLAY_FROM_LEAD_SEC : 0)), end];
  const from = Math.max(start, at(fromRatio) - WORD_LEAD_SEC);
  const to = Math.min(end, Math.max(from + WORD_MIN_SEC, at(toRatio) + WORD_TAIL_SEC));
  return [Math.max(start, Math.min(from, to - WORD_MIN_SEC)), to];
}
