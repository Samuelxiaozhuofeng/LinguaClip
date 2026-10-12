// Grading a sentence typed on the phone's keyboard (review, docs/mobile-web.md 8): one
// box for the whole line instead of the desktop's one box per word, so the typed words
// are lined up with the line's words (longest common run, judged word by word with the
// desktop's own rule, isInputCorrectFlexibleCase) and every stretch that differs counts
// as one mistake. Japanese, typed without spaces, is judged as a whole: the line or its
// reading in kana.
import { TokenType, getWordTokens, isInputCorrectFlexibleCase, tokenizeText } from '../utils/textTokenizer';
import { hasKana, kanaFold, readingOf } from '../utils/japanese';

// ok: heard right; miss: the line's word, not (rightly) typed; extra: typed, not in the line; text: punctuation / space.
export type Piece = { s: string; kind: 'ok' | 'miss' | 'extra' | 'text' };
export type Checked = { pieces: Piece[]; wrong: number; correct: boolean };

const bare = (s: string) => s.replace(/[\s\p{P}\p{S}]+/gu, '');

export function checkDictation(target: string, typed: string): Checked {
  if (hasKana(target)) {
    const got = kanaFold(bare(typed));
    const reading = readingOf(bare(target));
    const correct = !!got && (got === kanaFold(bare(target)) || (!!reading && got === kanaFold(reading)));
    return correct
      ? { pieces: [{ s: target, kind: 'ok' }], wrong: 0, correct }
      : { pieces: [...(typed.trim() ? [{ s: typed.trim(), kind: 'extra' as const }] : []), { s: target, kind: 'miss' }], wrong: 1, correct };
  }
  const tokens = tokenizeText(target);
  const want = getWordTokens(tokens);
  const got = getWordTokens(tokenizeText(typed)).map(t => t.value);
  const eq = (i: number, j: number) => isInputCorrectFlexibleCase(got[j], want[i].value, want[i].reading);
  // lcs[i][j]: the longest common run of want[i..] and got[j..].
  const lcs = Array.from({ length: want.length + 1 }, () => new Array<number>(got.length + 1).fill(0));
  for (let i = want.length - 1; i >= 0; i--) {
    for (let j = got.length - 1; j >= 0; j--) lcs[i][j] = eq(i, j) ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  // Walk it: before each word of the line, the typed words that were extra there.
  const before = want.map(() => [] as string[]);
  const status = want.map(() => false);
  let i = 0, j = 0;
  const tail: string[] = [];
  while (i < want.length || j < got.length) {
    if (i < want.length && j < got.length && eq(i, j) && lcs[i][j] === lcs[i + 1][j + 1] + 1) { status[i] = true; i++; j++; }
    else if (j < got.length && (i >= want.length || lcs[i][j + 1] >= lcs[i + 1][j])) { (i < want.length ? before[i] : tail).push(got[j]); j++; }
    else i++;
  }
  const pieces: Piece[] = [];
  let w = 0, wrong = 0, inErr = false;
  const err = (bad: boolean) => { if (bad && !inErr) wrong++; inErr = bad; };
  for (const t of tokens) {
    if (t.type !== TokenType.WORD) { pieces.push({ s: t.value, kind: 'text' }); continue; }
    for (const x of before[w]) { err(true); pieces.push({ s: x, kind: 'extra' }, { s: ' ', kind: 'text' }); }
    err(!status[w]);
    pieces.push({ s: t.value, kind: status[w] ? 'ok' : 'miss' });
    w++;
  }
  for (const x of tail) { err(true); pieces.push({ s: ' ', kind: 'text' }, { s: x, kind: 'extra' }); }
  return { pieces, wrong, correct: wrong === 0 && got.length > 0 };
}
