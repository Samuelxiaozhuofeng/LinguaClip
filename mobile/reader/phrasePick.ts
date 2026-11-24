// Pure logic for touch long-press phrase selection & subtitle mark slicing (docs/phrase.md, M2.3).
// Shared by mobile/reader/usePhrasePick.ts, ReadLine.tsx, LineView.tsx, and mobile/test-reader-phone.mjs.
import { hasKana, jaGroups } from '../../utils/japanese';

export type PickRange = [number, number];
export type PickHandle = 'start' | 'end';
export type PickToken = { text: string; isWord: boolean };
export type TextMark = { from: number; to: number; hot: boolean };
export type TextSegment = { text: string; hot: boolean; marked: boolean };

/** Clamp and order a token index range [a, b] within [0, count - 1]. */
export function normalizeRange(a: number, b: number, count: number): PickRange | null {
  if (count <= 0 || !Number.isInteger(a) || !Number.isInteger(b)) return null;
  const lo = Math.max(0, Math.min(a, b, count - 1));
  const hi = Math.max(0, Math.min(Math.max(a, b), count - 1));
  return [lo, hi];
}

/** Update [start, end] when dragging either the start or end handle to targetIdx (flips cleanly if crossed). */
export function expandRangeByHandle(range: PickRange, handle: PickHandle, targetIdx: number, count: number): PickRange {
  const clamped = Math.max(0, Math.min(targetIdx, Math.max(0, count - 1)));
  const [start, end] = range;
  if (handle === 'start') {
    return clamped <= end ? [clamped, end] : [end, clamped];
  }
  return clamped >= start ? [start, clamped] : [clamped, start];
}

/**
 * Extract the exact original substring spanning tokens [from..to] inclusive.
 * Trims outer spaces while keeping internal spaces, apostrophes, and Japanese characters untouched.
 */
export function extractPhraseText(tokens: readonly PickToken[], from: number, to: number): string {
  const norm = normalizeRange(from, to, tokens.length);
  if (!norm) return '';
  const [lo, hi] = norm;
  return tokens.slice(lo, hi + 1).map(t => t.text).join('').trim();
}

/** Count how many word tokens fall inside [from..to] inclusive. */
export function selectedWordCount(tokens: readonly PickToken[], from: number, to: number): number {
  const norm = normalizeRange(from, to, tokens.length);
  if (!norm) return 0;
  let n = 0;
  for (let i = norm[0]; i <= norm[1]; i++) {
    if (tokens[i]?.isWord) n++;
  }
  return n;
}

/** True when a token index falls within the active selection [from..to]. */
export function isIndexInRange(index: number, range: PickRange | null): boolean {
  return !!range && index >= range[0] && index <= range[1];
}

/** True when a lookup string should open in phrase mode (multi-word Latin/space or multi-group Japanese). */
export function isPhraseText(word: string, ja: boolean): boolean {
  const s = word.trim();
  if (!s) return false;
  if (/\s/.test(s)) return true;
  if (ja && hasKana(s)) {
    const groups = jaGroups(s);
    if (groups && groups.filter(g => !g.punct).length > 1) return true;
  }
  return false;
}

/**
 * Split a piece of text covering [pieceFrom, pieceFrom + text.length) by phrase marks.
 * Mirrors pro/ReaderLine.tsx so hot phrases highlight in vermilion and passive marks underline cleanly.
 */
export function sliceTextByMarks(text: string, pieceFrom: number, marks?: readonly TextMark[]): TextSegment[] {
  if (!text) return [];
  if (!marks || marks.length === 0) return [{ text, hot: false, marked: false }];
  const pieceTo = pieceFrom + text.length;
  const relevant = marks.filter(m => m.from < pieceTo && m.to > pieceFrom);
  if (relevant.length === 0) return [{ text, hot: false, marked: false }];

  const cutSet = new Set<number>([pieceFrom, pieceTo]);
  for (const m of relevant) {
    if (m.from > pieceFrom && m.from < pieceTo) cutSet.add(m.from);
    if (m.to > pieceFrom && m.to < pieceTo) cutSet.add(m.to);
  }
  const edges = [...cutSet].sort((a, b) => a - b);
  const out: TextSegment[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const a = edges[i];
    const b = edges[i + 1];
    const hit = relevant.filter(m => m.from < b && m.to > a);
    out.push({
      text: text.slice(a - pieceFrom, b - pieceFrom),
      hot: hit.some(m => m.hot),
      marked: hit.length > 0,
    });
  }
  return out;
}
