import { parseSRT } from './srtParser';
import { MAX_WORDS, MIN_PIECE, Word, enforceCeiling, mostlyCjk, ruleStarts, stamp } from './resegment';

// Subtitles the user brings (their own .srt, a track inside the video) often hold a
// 30-word line. On a new import, every line over MAX_WORDS is cut the way transcripts
// are (utils/resegment.ts), without asking the AI: after a sentence end, then after
// in-line punctuation, then evenly. There are no word times, so each piece's share of
// the line's time goes by its letters. docs/import.md「自带字幕自动切长句」.

type Line = { start: number; end: number; text: string };

// "Mr." "Dr." "Yes." "U.S.": a full stop here is no sure sentence end, so no cut after it.
// Judged without what wraps the word: quotes, brackets, a leading ellipsis ("Mr. / (U.S.) / …Dr.).
const ABBREV = /^(?:[A-Z][a-z]{0,2}|(?:[A-Za-z]\.)+[A-Za-z])\.$/;
const WRAP_HEAD = /^(?:["'“”‘’「」『』«»‹›(\[{¿¡]|…|\.{2,})+/u;
const WRAP_TAIL = /["'“”‘’「」『』«»‹›)\]}]+$/u;
const abbrev = (w: string) => ABBREV.test(w.replace(WRAP_HEAD, '').replace(WRAP_TAIL, ''));
const letters = (w: string) => Math.max(1, w.replace(/[^\p{L}\p{N}]/gu, '').length);

// Writing systems told apart; Chinese characters, kana and Hangul count as one (Japanese mixes them).
const SCRIPTS = [
  /\p{Script=Latin}/u, /\p{Script=Cyrillic}/u, /\p{Script=Greek}/u, /\p{Script=Arabic}/u, /\p{Script=Hebrew}/u,
  /\p{Script=Thai}/u, /\p{Script=Devanagari}/u, /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u,
];
// A bilingual entry (the original and its translation): two writing systems with 2+ letters each.
// One letter of another (a symbol, one character of a name) does not count.
function bilingual(text: string): boolean {
  const counts = SCRIPTS.map(() => 0);
  for (const ch of text) {
    const i = SCRIPTS.findIndex(re => re.test(ch));
    if (i >= 0) counts[i]++;
  }
  return counts.filter(n => n >= 2).length >= 2;
}

// The pieces of one line, or null when it stays as it is (short enough, Chinese / Japanese, bilingual).
function splitLine(start: number, end: number, text: string): Line[] | null {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length <= MAX_WORDS || bilingual(text)) return null;
  const total = tokens.reduce((n, w) => n + letters(w), 0);
  const at: number[] = [];
  let sum = 0;
  for (const w of tokens) { at.push(start + (end - start) * sum / total); sum += letters(w); }
  const words: Word[] = tokens.map((w, i) => ({ w, from: at[i], to: i + 1 < tokens.length ? at[i + 1] : end }));
  if (mostlyCjk(words)) return null;
  // Every cut, whichever rule picks it, stays off a word like "Mr.".
  const ok = (i: number) => !abbrev(tokens[i - 1]);
  const cuts = [0];
  for (const i of ruleStarts(words)) {
    if (i - cuts[cuts.length - 1] >= MIN_PIECE && tokens.length - i >= MIN_PIECE && ok(i)) cuts.push(i);
  }
  const starts = enforceCeiling(cuts, words, ok);
  return starts.map((a, k) => {
    const b = k + 1 < starts.length ? starts[k + 1] : tokens.length;
    return { start: words[a].from, end: b < tokens.length ? words[b].from : end, text: tokens.slice(a, b).join(' ') };
  });
}

// The whole file back as it came when no line needs cutting; else rewritten from parseSRT's reading.
export function splitLongLines(srt: string): string {
  let changed = false;
  const lines = parseSRT(srt).flatMap(s => {
    const parts = splitLine(s.startTime, s.endTime, s.text);
    if (parts) changed = true;
    return parts ?? [{ start: s.startTime, end: s.endTime, text: s.text }];
  });
  if (!changed) return srt;
  return lines.map((l, i) => `${i + 1}\n${stamp(l.start * 1000)} --> ${stamp(l.end * 1000)}\n${l.text}\n`).join('\n');
}
