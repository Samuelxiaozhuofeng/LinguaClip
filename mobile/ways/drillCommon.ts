// Shared pure helpers for the phone's drill ways (Dictation, Blur, Cloze, Custom).
import type { Subtitle } from '../../types';
import { lineAt, parseSRT } from '../../utils/srtParser';
import { getAudioPaddingConfig } from '../../utils/storage';
import { getWordTokens, tokenizeText } from '../../utils/textTokenizer';
import { checkDictation } from '../dictation';

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
): number {
  const checked = checkDictation(target, typed, lenient);
  const wordCount = getWordTokens(tokenizeText(target)).length;
  if (checked.words.length === wordCount) {
    for (let i = 0; i < checked.words.length; i++) {
      if (checked.words[i].verdict !== 'right' && !hinted.has(i)) return i;
    }
    return -1;
  }
  // Japanese whole-line check with splitting dictionary loaded: reveal unhinted chunks in order.
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
