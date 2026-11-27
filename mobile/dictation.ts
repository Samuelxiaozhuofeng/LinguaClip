// Grading a sentence typed on the phone's keyboard (review & touch dictation,
// docs/mobile-web.md 8, docs/dictation-judge.md, docs/android.md「手机学习闭环」):
// one box for the whole line instead of the desktop's one box per word, so typed
// words are aligned with the target words via LCS (exact matches first via
// isInputCorrectFlexibleCase), then unmatched gaps pair near misses (judgeWord === 'near'
// + nearMarks when lenient is on). Japanese: when the kuromoji dictionary is loaded,
// align chunk by chunk accepting surface, kana reading, or alternate kanji with the same
// reading (e.g. 良い / いい); without the dictionary, fall back to whole-line matching.
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
import { hasKana, jaGroups, jaReady, kanaFold, readingOf } from '../utils/japanese';

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

// Normalized kana forms accepted for one Japanese chunk: surface, kuromoji reading,
// and everyday kanji/kana reading variants (ipadic reads 良い as よい while subtitles write いい).
function jaForms(surface: string, reading?: string): Set<string> {
  const out = new Set<string>();
  const clean = bare(surface);
  if (!clean) return out;
  const sf = kanaFold(clean);
  if (sf) out.add(sf);
  if (reading) {
    const rf = kanaFold(bare(reading));
    if (rf) out.add(rf);
  }
  const ro = readingOf(clean);
  if (ro) {
    const rof = kanaFold(bare(ro));
    if (rof) out.add(rof);
  }
  if (clean.includes('良い')) {
    for (const f of [...out]) {
      if (f.includes('よい')) out.add(f.replaceAll('よい', 'いい'));
    }
    const altRo = readingOf(clean.replaceAll('良い', 'いい'));
    if (altRo) out.add(kanaFold(bare(altRo)));
  }
  return out;
}

function jaFormsOverlap(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

/**
 * Tokenize a line for dictation, forcing kuromoji phrase splitting when the material
 * language is Japanese (even for pure-kanji lines like "大丈夫。" that have no kana).
 */
export function tokenizeDictation(text: string, lang?: string): Token[] {
  if ((lang === 'ja' || hasKana(text)) && jaReady()) {
    const ja = jaGroups(text);
    if (ja) {
      return ja.flatMap(g => g.punct
        ? [...g.value].map(ch => ({ type: /\s/.test(ch) ? TokenType.SPACE : TokenType.PUNCTUATION, value: ch }))
        : [{ type: TokenType.WORD, value: g.value, reading: g.reading }],
      ).map((t, index) => ({ ...t, index }));
    }
  }
  return tokenizeText(text);
}

type JaGapMatch = { localW: number; sStart: number; sEnd: number; origText: string };

function foldWithMap(raw: string): { folded: string; origChars: string[]; charIndex: number[] } {
  const norm = bare(raw).normalize('NFKC');
  const origChars = [...norm];
  let folded = '';
  const charIndex: number[] = [];
  for (let idx = 0; idx < origChars.length; idx++) {
    const f = kanaFold(origChars[idx]);
    for (let k = 0; k < f.length; k++) {
      folded += f[k];
      charIndex.push(idx);
    }
  }
  charIndex.push(origChars.length);
  return { folded, origChars, charIndex };
}

// Re-sync target chunks inside an unmatched gap against the raw gap text (e.g. a pure-kana run
// where a wrong particle caused kuromoji to glue all remaining kana into one unknown token).
// Uses DP maximizing (matchedChunks, matchedChars) so an error in one chunk never cascades
// onto later chunks that were typed correctly.
function alignJaGap(
  wSlice: Token[],
  wantForms: Set<string>[],
  rawGap: string,
): { matches: JaGapMatch[]; origSlice: (a: number, b: number) => string; foldedLen: number } {
  const { folded, origChars, charIndex } = foldWithMap(rawGap);
  const origSlice = (a: number, b: number) => origChars.slice(charIndex[a], charIndex[b]).join('');
  const M = wSlice.length;
  const L = folded.length;
  if (M === 0 || L === 0 || M * L > 200_000) {
    return { matches: [], origSlice, foldedLen: L };
  }

  const formsList = wantForms.map(s => [...s].filter(f => f.length > 0).sort((a, b) => b.length - a.length));
  const canStartAt: boolean[][] = Array.from({ length: M }, (_, wi) => {
    const row = new Array<boolean>(L + 1).fill(false);
    for (let p = 0; p < L; p++) {
      row[p] = formsList[wi].some(f => folded.startsWith(f, p));
    }
    return row;
  });

  const CHUNK_W = 1_000_000;
  // dp[i][p][prev]: best score aligning wSlice[i..] to folded[p..] (prev=1 if chunk i-1 ended at p).
  const dp: [number, number][][] = Array.from({ length: M + 1 }, () =>
    Array.from({ length: L + 1 }, (): [number, number] => [0, 0]),
  );

  const allowForm = (i: number, p: number, f: string, prev: number) => {
    if (f.length > 1 || !hasKana(f)) return true;
    return prev === 1 || (i === 0 && p === 0) || (i === M - 1 && p + 1 === L) || (i + 1 < M && canStartAt[i + 1][p + 1]);
  };

  for (let i = M - 1; i >= 0; i--) {
    for (let p = L - 1; p >= 0; p--) {
      for (let prev = 0; prev <= 1; prev++) {
        let best = dp[i + 1][p][0];
        if (dp[i][p + 1][0] > best) best = dp[i][p + 1][0];
        for (const f of formsList[i]) {
          if (!folded.startsWith(f, p) || !allowForm(i, p, f, prev)) continue;
          const cand = CHUNK_W + f.length + dp[i + 1][p + f.length][1];
          if (cand > best) best = cand;
        }
        dp[i][p][prev] = best;
      }
    }
  }

  const matches: JaGapMatch[] = [];
  let i = 0;
  let p = 0;
  let prev = 0;
  while (i < M && p < L) {
    const cur = dp[i][p][prev];
    if (cur === 0) break;
    let matchedForm: string | null = null;
    for (const f of formsList[i]) {
      if (!folded.startsWith(f, p) || !allowForm(i, p, f, prev)) continue;
      if (CHUNK_W + f.length + dp[i + 1][p + f.length][1] === cur) {
        matchedForm = f;
        break;
      }
    }
    if (matchedForm) {
      const sEnd = p + matchedForm.length;
      matches.push({ localW: i, sStart: p, sEnd, origText: origSlice(p, sEnd) });
      i++;
      p = sEnd;
      prev = 1;
    } else if (dp[i + 1][p][0] === cur) {
      i++;
      prev = 0;
    } else {
      p++;
      prev = 0;
    }
  }

  return { matches, origSlice, foldedLen: L };
}

function checkJapaneseChunked(target: string, typed: string): Checked {
  const tokens = tokenizeDictation(target, 'ja');
  const want = getWordTokens(tokens);
  const gotTokens = getWordTokens(tokenizeDictation(typed, 'ja'));

  const wantForms = want.map(tk => jaForms(tk.value, tk.reading));
  const gotForms = gotTokens.map(tk => jaForms(tk.value, tk.reading));
  const eq = (i: number, j: number) => jaFormsOverlap(wantForms[i], gotForms[j]);

  // LCS on Japanese chunks (accepting surface, kana reading, or same-reading kanji variants).
  const lcs = Array.from({ length: want.length + 1 }, () => new Array<number>(gotTokens.length + 1).fill(0));
  for (let i = want.length - 1; i >= 0; i--) {
    for (let j = gotTokens.length - 1; j >= 0; j--) {
      lcs[i][j] = eq(i, j) ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const status = want.map(() => false);
  const matchedTyped = want.map(() => '');
  const anchors: { wi: number; gi: number }[] = [];
  let i = 0;
  let j = 0;
  while (i < want.length && j < gotTokens.length) {
    if (eq(i, j) && lcs[i][j] === lcs[i + 1][j + 1] + 1) {
      status[i] = true;
      matchedTyped[i] = gotTokens[j].value;
      anchors.push({ wi: i, gi: j });
      i++;
      j++;
    } else if (lcs[i][j + 1] >= lcs[i + 1][j]) {
      j++;
    } else {
      i++;
    }
  }

  // Reconcile unmatched gaps (handles AI-overridden cuts or kana runs where kuromoji mis-split
  // after a typo) and collect genuinely extra slices right before their corresponding target chunk.
  const before = want.map(() => [] as string[]);
  const tail: string[] = [];
  const pushExtra = (targetIdx: number, text: string) => {
    if (!text) return;
    (targetIdx < want.length ? before[targetIdx] : tail).push(text);
  };

  let prevW = -1;
  let prevG = -1;
  const bounds = [...anchors, { wi: want.length, gi: gotTokens.length }];
  for (const b of bounds) {
    const wStart = prevW + 1;
    const gStart = prevG + 1;
    const wSlice = want.slice(wStart, b.wi);
    const gSlice = gotTokens.slice(gStart, b.gi);
    if (gSlice.length > 0) {
      const joined = gSlice.map(g => g.value).join('');
      if (wSlice.length > 0) {
        const { matches, origSlice, foldedLen } = alignJaGap(wSlice, wantForms.slice(wStart, b.wi), joined);
        if (matches.length > 0) {
          let prevLocalW = -1;
          let prevSEnd = 0;
          for (const m of matches) {
            if (m.sStart > prevSEnd) {
              pushExtra(wStart + prevLocalW + 1, origSlice(prevSEnd, m.sStart));
            }
            status[wStart + m.localW] = true;
            matchedTyped[wStart + m.localW] = m.origText;
            prevLocalW = m.localW;
            prevSEnd = m.sEnd;
          }
          if (prevSEnd < foldedLen) {
            pushExtra(wStart + prevLocalW + 1, origSlice(prevSEnd, foldedLen));
          }
        } else {
          pushExtra(wStart, joined);
        }
      } else {
        for (const g of gSlice) pushExtra(wStart, g.value);
      }
    }
    prevW = b.wi;
    prevG = b.gi;
  }

  const words: WordCheck[] = want.map((tk, idx) =>
    status[idx]
      ? { target: tk.value, typed: matchedTyped[idx], verdict: 'right', marks: null }
      : { target: tk.value, typed: before[idx][0] ?? '', verdict: 'wrong', marks: null },
  );

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
    pieces.push(status[w] ? { s: t.value, kind: 'ok', wordIndex: w } : { s: t.value, kind: 'miss', wordIndex: w });
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
    near: 0,
    correct: wrong === 0 && gotTokens.length > 0,
  };
}

export function checkDictation(target: string, typed: string, lenient = true, lang?: string): Checked {
  if (lang === 'ja' || hasKana(target)) {
    const got = kanaFold(bare(typed));
    const reading = readingOf(bare(target));
    const correct = !!got && (got === kanaFold(bare(target)) || (!!reading && got === kanaFold(reading)));
    if (jaReady()) {
      const r = checkJapaneseChunked(target, typed);
      // A whole-sentence match (as written or as its reading) is always right, even when the
      // chunk alignment can't pair repeated pieces: show it as the all-right chunks.
      return r.correct || !correct ? r : checkJapaneseChunked(target, target);
    }
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
