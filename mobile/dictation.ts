// Grading a sentence typed on the phone's keyboard (review & touch dictation,
// docs/mobile-web.md 8, docs/dictation-judge.md, docs/android-roadmap.md M2.2):
// one box for the whole line instead of the desktop's one box per word, so typed
// words are aligned with the target words via LCS (exact matches first via
// isInputCorrectFlexibleCase), then unmatched gaps pair near misses (judgeWord === 'near'
// + nearMarks when lenient is on). Japanese, typed without spaces, is judged as a whole:
// the line or its reading in kana (never a near miss).
import {
  TokenType,
  getWordTokens,
  isInputCorrectFlexibleCase,
  judgeWord,
  nearMarks,
  tokenizeText,
  type Token,
  type Verdict,
} from '../utils/textTokenizer';
import { hasKana, kanaFold, readingOf } from '../utils/japanese';

// ok: heard right; miss: the line's word, not (rightly) typed; extra: typed, not in the line; text: punctuation / space.
export type Piece = {
  s: string;
  kind: 'ok' | 'miss' | 'extra' | 'text';
  wordIndex?: number;
  near?: boolean;
  marks?: boolean[];
  typed?: string;
};

export type WordCheck = {
  target: string;
  typed: string;
  verdict: Verdict;
  marks: boolean[] | null;
};

export type Checked = {
  pieces: Piece[];
  words: WordCheck[];
  wrong: number;
  near: number;
  correct: boolean;
};

const bare = (s: string) => s.replace(/[\s\p{P}\p{S}]+/gu, '');

// Order-preserving maximum near-miss pairing inside one unmatched gap between exact LCS anchors.
function pairNearGap(
  wantSlice: Token[],
  gotSlice: string[],
): Map<number, { typed: string; marks: boolean[] }> {
  const m = wantSlice.length;
  const n = gotSlice.length;
  const paired = new Map<number, { typed: string; marks: boolean[] }>();
  if (m === 0 || n === 0) return paired;

  const isNear = (a: number, b: number) =>
    judgeWord(gotSlice[b], wantSlice[a].value, wantSlice[a].reading, true) === 'near';

  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = isNear(i, j)
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (isNear(i, j) && dp[i][j] === dp[i + 1][j + 1] + 1) {
      const marks = nearMarks(gotSlice[j], wantSlice[i].value) ?? [];
      paired.set(i, { typed: gotSlice[j], marks });
      i++;
      j++;
    } else if (dp[i][j + 1] >= dp[i + 1][j]) {
      j++;
    } else {
      i++;
    }
  }
  return paired;
}

export function checkDictation(target: string, typed: string, lenient = true): Checked {
  if (hasKana(target)) {
    const got = kanaFold(bare(typed));
    const reading = readingOf(bare(target));
    const correct = !!got && (got === kanaFold(bare(target)) || (!!reading && got === kanaFold(reading)));
    const words: WordCheck[] = [{ target, typed: typed.trim(), verdict: correct ? 'right' : 'wrong', marks: null }];
    return correct
      ? { pieces: [{ s: target, kind: 'ok', wordIndex: 0 }], words, wrong: 0, near: 0, correct }
      : {
          pieces: [
            ...(typed.trim() ? [{ s: typed.trim(), kind: 'extra' as const }] : []),
            { s: target, kind: 'miss', wordIndex: 0 },
          ],
          words,
          wrong: 1,
          near: 0,
          correct,
        };
  }

  const tokens = tokenizeText(target);
  const want = getWordTokens(tokens);
  const got = getWordTokens(tokenizeText(typed)).map(t => t.value);
  const eq = (i: number, j: number) => isInputCorrectFlexibleCase(got[j], want[i].value, want[i].reading, lenient);

  // lcs[i][j]: the longest common run of exact-matched words in want[i..] and got[j..].
  const lcs = Array.from({ length: want.length + 1 }, () => new Array<number>(got.length + 1).fill(0));
  for (let i = want.length - 1; i >= 0; i--) {
    for (let j = got.length - 1; j >= 0; j--) {
      lcs[i][j] = eq(i, j) ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  // Walk LCS to collect exact anchors and extra typed words before each target word.
  const before = want.map(() => [] as string[]);
  const status = want.map(() => false);
  const matchedTyped = want.map(() => '');
  const anchors: { wi: number; gi: number }[] = [];
  let i = 0;
  let j = 0;
  const tail: string[] = [];
  while (i < want.length || j < got.length) {
    if (i < want.length && j < got.length && eq(i, j) && lcs[i][j] === lcs[i + 1][j + 1] + 1) {
      status[i] = true;
      matchedTyped[i] = got[j];
      anchors.push({ wi: i, gi: j });
      i++;
      j++;
    } else if (j < got.length && (i >= want.length || lcs[i][j + 1] >= lcs[i + 1][j])) {
      (i < want.length ? before[i] : tail).push(got[j]);
      j++;
    } else {
      i++;
    }
  }

  // Pair near misses inside every unmatched gap between consecutive exact anchors.
  const nearByWord = new Map<number, { typed: string; marks: boolean[] }>();
  if (lenient && want.length > 0 && got.length > 0) {
    let prevW = -1;
    let prevG = -1;
    const bounds = [...anchors, { wi: want.length, gi: got.length }];
    for (const b of bounds) {
      const wStart = prevW + 1;
      const gStart = prevG + 1;
      if (wStart < b.wi && gStart < b.gi) {
        const gapPaired = pairNearGap(want.slice(wStart, b.wi), got.slice(gStart, b.gi));
        gapPaired.forEach((info, localIdx) => {
          nearByWord.set(wStart + localIdx, info);
        });
      }
      prevW = b.wi;
      prevG = b.gi;
    }
  }

  const words: WordCheck[] = want.map((tk, idx) => {
    if (status[idx]) {
      return { target: tk.value, typed: matchedTyped[idx], verdict: 'right', marks: null };
    }
    const nearInfo = nearByWord.get(idx);
    if (nearInfo) {
      return { target: tk.value, typed: nearInfo.typed, verdict: 'near', marks: nearInfo.marks };
    }
    return { target: tk.value, typed: before[idx][0] ?? '', verdict: 'wrong', marks: null };
  });

  const pieces: Piece[] = [];
  let w = 0;
  let wrong = 0;
  let inErr = false;
  const err = (bad: boolean) => { if (bad && !inErr) wrong++; inErr = bad; };

  for (const t of tokens) {
    if (t.type !== TokenType.WORD) {
      pieces.push({ s: t.value, kind: 'text' });
      continue;
    }
    for (const x of before[w]) {
      err(true);
      pieces.push({ s: x, kind: 'extra' }, { s: ' ', kind: 'text' });
    }
    err(!status[w]);
    const nearInfo = nearByWord.get(w);
    pieces.push(
      status[w]
        ? { s: t.value, kind: 'ok', wordIndex: w }
        : nearInfo
          ? { s: t.value, kind: 'miss', wordIndex: w, near: true, marks: nearInfo.marks, typed: nearInfo.typed }
          : { s: t.value, kind: 'miss', wordIndex: w },
    );
    w++;
  }
  for (const x of tail) {
    err(true);
    pieces.push({ s: ' ', kind: 'text' }, { s: x, kind: 'extra' });
  }

  return {
    pieces,
    words,
    wrong,
    near: nearByWord.size,
    correct: wrong === 0 && got.length > 0,
  };
}
