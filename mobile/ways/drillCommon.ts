// Shared pure helpers for the phone's drill ways (Dictation, Blur, Cloze, Custom).
import type { Subtitle, VideoSection } from '../../types';
import { lineAt, parseSRT } from '../../utils/srtParser';
import { getAudioPaddingConfig } from '../../utils/storage';
import { getWordTokens, tokenizeText } from '../../utils/textTokenizer';
import { checkDictation, tokenizeDictation } from '../dictation';

export interface SectionRange {
  index: number;
  startIdx: number;
  endIdx: number;
}

export type SectionStats = { independent: Set<number>; stuck: Set<number> };
export type SectionStatsMap = Record<number, SectionStats>;

export const emptySectionStats = (): SectionStats => ({ independent: new Set(), stuck: new Set() });

export function getSectionStats(map: SectionStatsMap, secIdx: number): SectionStats {
  return map[secIdx] ?? emptySectionStats();
}

export function recordSectionStuck(map: SectionStatsMap, secIdx: number, lineId: number): SectionStatsMap {
  const prev = getSectionStats(map, secIdx);
  const stuck = new Set(prev.stuck);
  stuck.add(lineId);
  const independent = new Set(prev.independent);
  independent.delete(lineId);
  return { ...map, [secIdx]: { independent, stuck } };
}

export function recordSectionIndependent(map: SectionStatsMap, secIdx: number, lineId: number): SectionStatsMap {
  const prev = getSectionStats(map, secIdx);
  if (prev.stuck.has(lineId)) return map;
  const independent = new Set(prev.independent);
  independent.add(lineId);
  return { ...map, [secIdx]: { independent, stuck: prev.stuck } };
}

/** Clear only `secIdx` stats (used by "Retry section"); other sections keep their records. */
export function clearSectionStats(map: SectionStatsMap, secIdx: number): SectionStatsMap {
  if (!(secIdx in map)) return map;
  const next: SectionStatsMap = { ...map };
  delete next[secIdx];
  return next;
}

/** Previous line index within the same section, or null when already at section start. */
export function prevLineInSection(idx: number, range?: SectionRange): number | null {
  const start = range?.startIdx ?? 0;
  return idx > start ? idx - 1 : null;
}

export type CorrectKind = 'independent' | 'reveal' | 'hint' | 'wrong';

/**
 * Only a first-try independent correct counts as celebratory "all right".
 * Any prior reveal, hint, wrong submission, or earlier stuck mark on this line yields a neutral status.
 */
export function dictCorrectKind(opts: {
  everRevealed: boolean;
  usedHint: boolean;
  wrongTries: number;
  alreadyStuck?: boolean;
}): CorrectKind {
  if (opts.everRevealed) return 'reveal';
  if (opts.usedHint) return 'hint';
  if (opts.wrongTries > 0 || opts.alreadyStuck) return 'wrong';
  return 'independent';
}

/** Cloze submission requires at least one blank with non-whitespace input. */
export function hasAnyClozeInput(blanks: number[], inputs: Record<number, string>): boolean {
  return blanks.some(bi => (inputs[bi] ?? '').trim().length > 0);
}

/** Map buildSections() output onto half-open [startIdx, endIdx) index ranges in `lines`. */
export function sectionRangesOf(lines: Subtitle[], sections: VideoSection[]): SectionRange[] {
  if (lines.length === 0) return [];
  const idToIdx = new Map<number, number>();
  lines.forEach((l, i) => idToIdx.set(l.id, i));
  const out: SectionRange[] = [];
  for (const sec of sections) {
    if (sec.subtitles.length === 0) continue;
    let first = Number.POSITIVE_INFINITY;
    let last = -1;
    for (const sub of sec.subtitles) {
      const i = idToIdx.get(sub.id);
      if (i !== undefined) {
        if (i < first) first = i;
        if (i > last) last = i;
      }
    }
    if (last >= first) {
      out.push({ index: out.length, startIdx: first, endIdx: last + 1 });
    }
  }
  return out.length > 0 ? out : [{ index: 0, startIdx: 0, endIdx: lines.length }];
}

/** Find the SectionRange containing `lineIdx` (clamped to first/last). */
export function sectionForLine(ranges: SectionRange[], lineIdx: number): SectionRange | undefined {
  if (ranges.length === 0) return undefined;
  return ranges.find(r => lineIdx >= r.startIdx && lineIdx < r.endIdx) ?? ranges[ranges.length - 1];
}

export const AUTO_NEXT_MS = 900;

export function sortedLines(subtitleText: string): Subtitle[] {
  return [...parseSRT(subtitleText || '')].sort((a, b) => a.startTime - b.startTime);
}

/** 0-based index of the line holding `startSec` (wraps back to 0 past EOF). */
export function startIndexForSec(lines: Subtitle[], startSec: number): number {
  if (lines.length === 0) return 0;
  if (!Number.isFinite(startSec) || startSec <= 0) return 0;
  const last = lines[lines.length - 1];
  if (last.endTime > 0 && startSec >= last.endTime - 0.5 && startSec > last.startTime + 0.05) {
    return 0;
  }
  const idx = lineAt(lines, startSec);
  return idx >= 0 ? idx : 0;
}

/** Neighbouring lines for AI word lookup & breakdown (matches hooks/useLookup aroundOf). */
export function aroundOf(lines: Subtitle[], idx: number): string {
  return [lines[idx - 1]?.text, lines[idx + 1]?.text].filter(Boolean).join('\n');
}

/** Audio padding in seconds for useLinePlayer.playLine(i, pad). */
export function padSecOf(): number {
  const { startPadding, endPadding } = getAudioPaddingConfig();
  const ms = Math.max(0, startPadding || 0, endPadding || 0);
  return Math.min(1, ms / 1000);
}

/** Next target word index that is neither typed right nor already hinted (-1 when none). */
export function nextHintIndex(
  target: string,
  typed: string,
  hinted: ReadonlySet<number>,
  lenient = true,
  lang?: string,
): number {
  const checked = checkDictation(target, typed, lenient, lang);
  const wordCount = getWordTokens(tokenizeDictation(target, lang)).length;
  if (checked.words.length === wordCount) {
    for (let i = 0; i < checked.words.length; i++) {
      if (checked.words[i].verdict !== 'right' && !hinted.has(i)) return i;
    }
    return -1;
  }
  // Japanese whole-line check without splitting dictionary: reveal unhinted chunks in order.
  if (checked.correct) return -1;
  for (let i = 0; i < wordCount; i++) {
    if (!hinted.has(i)) return i;
  }
  return -1;
}

/** Width (in em) of a blank underline slot for one word on a narrow phone screen. */
export function slotWidthEm(word: string): number {
  const raw = [...word].reduce(
    (n, ch) => n + (/[\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(ch) ? 1.05 : 0.56),
    0,
  );
  return Math.min(9, Math.max(1.5, Number(raw.toFixed(2))));
}

/** Word text stripped of outer punctuation, matching desktop BlurLine bareWord. */
export function stripLookupPunct(raw: string): string {
  return raw.replace(/[.,/#!$%^&*;:{}=\-_`~()?"'\u3000-\u303f\uff01-\uff0f\uff1a-\uff20]/g, '');
}

/** Count of word tokens in a line. */
export function wordCountOf(text: string): number {
  return getWordTokens(tokenizeText(text)).length;
}
