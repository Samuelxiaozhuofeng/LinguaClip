/**
 * Text Tokenizer Utility
 * Separates text into words and punctuation tokens for practice input
 */
import { hasKana, jaGroups, jaLemma, kanaFold, furigana, type Ruby } from './japanese';

export enum TokenType {
  WORD = 'WORD',
  PUNCTUATION = 'PUNCTUATION',
  SPACE = 'SPACE'
}

export interface Token {
  type: TokenType;
  value: string;
  index: number; // Position in the token array
  reading?: string; // Japanese: the word's reading, typing it in kana counts
}

/**
 * Tokenize text into words, punctuation, and spaces
 * Words need to be typed by user, punctuation is displayed automatically
 * Supports Unicode characters (Spanish ñ, ó, á, etc., Chinese, Arabic, etc.)
 */
export const tokenizeText = (text: string): Token[] => {
  // Japanese has no spaces: once the dictionary is loaded, split by phrase.
  const ja = hasKana(text) ? jaGroups(text) : null;
  if (ja) {
    return ja.flatMap(g => g.punct
      ? [...g.value].map(ch => ({ type: /\s/.test(ch) ? TokenType.SPACE : TokenType.PUNCTUATION, value: ch }))
      : [{ type: TokenType.WORD, value: g.value, reading: g.reading }],
    ).map((t, index) => ({ ...t, index }));
  }
  const tokens: Token[] = [];
  let index = 0;

  // Regex to match words with Unicode letter support
  // \p{L} matches any Unicode letter (including ñ, ó, á, é, í, ú, ü, etc.)
  // \p{N} matches any Unicode number
  // Supports apostrophes within words, straight or curly (don't, don’t, it's)
  // A combining accent (U+0300–036F: a decomposed é, from an NFD subtitle) stays on its letter,
  // so token values still spell the line exactly; other marks split as before.
  const pattern = /((?:[\p{L}\p{N}][\u0300-\u036f]*)+(?:['’](?:\p{L}[\u0300-\u036f]*)+)?)|([^\p{L}\p{N}\s])|(\s+)/gu;

  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (match[1]) {
      // Word token (includes Unicode letters and numbers)
      tokens.push({
        type: TokenType.WORD,
        value: match[1],
        index: index++
      });
    } else if (match[2]) {
      // Punctuation token (anything that's not a letter, number, or space)
      tokens.push({
        type: TokenType.PUNCTUATION,
        value: match[2],
        index: index++
      });
    } else if (match[3]) {
      // Space token
      tokens.push({
        type: TokenType.SPACE,
        value: match[3],
        index: index++
      });
    }
  }

  return tokens;
};

/**
 * Get only word tokens (for input fields)
 */
export const getWordTokens = (tokens: Token[]): Token[] => {
  return tokens.filter(t => t.type === TokenType.WORD);
};

/**
 * Check if input matches target (case-insensitive)
 */
// A keyboard types ' where subtitles often have ’; both count. A composed é and e + ◌́ are
// the same letter (NFC), whichever the keyboard or the subtitle file used.
const foldQuote = (s: string) => s.trim().normalize('NFC').replace(/’/g, "'");

export const isInputCorrect = (input: string, target: string): boolean => {
  return foldQuote(input).toLowerCase() === foldQuote(target).toLowerCase();
};

/**
 * Check if input matches target with flexible first letter case
 * First letter can be different case, but rest must match exactly
 * lenient (宽松判对, docs/dictation-judge.md): punctuation at either end is dropped and
 * case is ignored for the whole word.
 */
export const isInputCorrectFlexibleCase = (input: string, target: string, reading?: string, lenient = false): boolean => {
  if (reading !== undefined && input.trim()) {
    const typed = kanaFold(input);
    if (typed === kanaFold(target) || typed === kanaFold(reading)) return true;
  }
  if (lenient) {
    const a = looseForm(input);
    return !!a && a === looseForm(target);
  }
  const trimmedInput = foldQuote(input);
  const trimmedTarget = foldQuote(target);

  if (trimmedInput.length !== trimmedTarget.length) {
    return false;
  }

  if (trimmedInput.length === 0) {
    return false;
  }

  // Compare first letter (case-insensitive)
  if (trimmedInput[0].toLowerCase() !== trimmedTarget[0].toLowerCase()) {
    return false;
  }

  // Compare rest of the word (case-sensitive)
  if (trimmedInput.length > 1) {
    return trimmedInput.slice(1) === trimmedTarget.slice(1);
  }

  return true;
};

// --- 宽松判对 and 差一点 (docs/dictation-judge.md) ---

const looseForm = (s: string) => foldQuote(s).replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, '').toLowerCase();
const stripMarks = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '');
// A word's letters: each base character with the accents on it (NFC é, or NFD e + ◌́).
export const letters = (s: string): string[] => s.match(/\P{M}\p{M}*/gu) ?? [];
const looseLetters = (s: string) => letters(looseForm(s));
const accentOnly = (a: string[], b: string[]) => a.length === b.length && a.every((x, k) => stripMarks(x) === stripMarks(b[k]));
const ENDINGS = ['s', 'es', 'ed', 'd'];
// One word is the other plus an English ending; the shorter has at least 3 letters (not a / as).
const endingOnly = (a: string[], b: string[]) => {
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  return s.length >= 3 && l.slice(0, s.length).join('') === s.join('') && ENDINGS.includes(l.slice(s.length).join(''));
};
// Exactly one letter added, dropped or changed.
const oneEdit = (a: string[], b: string[]) => {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1).join('') === b.slice(i + 1).join('');
  return a.length > b.length ? a.slice(i + 1).join('') === b.slice(i).join('') : a.slice(i).join('') === b.slice(i + 1).join('');
};

export type Verdict = 'right' | 'near' | 'wrong';

// right: the box is right. near (only when lenient): wrong, but only by accents, an English
// ending, or one letter of a word of 6+ letters. Japanese boxes are never near.
export const judgeWord = (input: string, target: string, reading?: string, lenient = false): Verdict => {
  if (isInputCorrectFlexibleCase(input, target, reading, lenient)) return 'right';
  if (!lenient || reading !== undefined || hasKana(target)) return 'wrong';
  const a = looseLetters(input), b = looseLetters(target);
  if (!a.length) return 'wrong';
  return nearKind(a, b) ? 'near' : 'wrong';
};

// Which rule makes a and b a near miss, if any (the rules in docs/dictation-judge.md).
const nearKind = (a: string[], b: string[]): 'accent' | 'ending' | 'edit' | null =>
  accentOnly(a, b) ? 'accent' : endingOnly(a, b) ? 'ending' : b.length >= 6 && oneEdit(a, b) ? 'edit' : null;

// Which letters of a near-miss target differ from what was typed, one flag per letter of
// the target (letters()), each rule lined up its own way: accents letter by letter at the
// same place (résumé / resume → both é; réel / reél → é and e); an ending → its letters
// (walk / walked → e, d); one edit → the letter changed or left out. None set when the
// typed word only has letters added. null when not a near miss.
export const nearMarks = (input: string, target: string): boolean[] | null => {
  const a = looseLetters(input), b = looseLetters(target);
  const kind = nearKind(a, b);
  if (!kind || b.length !== letters(target).length) return null;
  if (kind === 'accent') return b.map((x, k) => x !== a[k]);
  if (kind === 'ending') return b.map((_, k) => k >= a.length);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  return b.map((_, k) => k === p && a.length <= b.length);
};

/**
 * Reconstruct full text from tokens and user inputs
 * @param tokens - All tokens (words, punctuation, spaces)
 * @param wordInputs - User inputs for word tokens only
 */
export const reconstructText = (tokens: Token[], wordInputs: string[]): string => {
  let wordIndex = 0;
  return tokens.map(token => {
    if (token.type === TokenType.WORD) {
      return wordInputs[wordIndex++] || '';
    }
    return token.value;
  }).join('');
};

/**
 * Check if all words are correctly filled
 */
export const areAllWordsCorrect = (tokens: Token[], wordInputs: string[]): boolean => {
  const wordTokens = getWordTokens(tokens);

  if (wordInputs.length !== wordTokens.length) {
    return false;
  }

  return wordTokens.every((token, index) => {
    const input = wordInputs[index];
    return input && isInputCorrect(input, token.value);
  });
};

/**
 * Check if all words are correctly filled with flexible case matching
 * First letter case-insensitive, rest case-sensitive
 */
export const areAllWordsCorrectFlexibleCase = (tokens: Token[], wordInputs: string[], lenient = false): boolean => {
  const wordTokens = getWordTokens(tokens);

  if (wordInputs.length !== wordTokens.length) {
    return false;
  }

  return wordTokens.every((token, index) => {
    const input = wordInputs[index];
    return input && isInputCorrectFlexibleCase(input, token.value, token.reading, lenient);
  });
};

/**
 * Word comparison result for detailed feedback
 */
export interface WordComparisonResult {
  targetWord: string;
  inputWord: string;
  isCorrect: boolean;
  near: boolean; // wrong, but only just (docs/dictation-judge.md)
  tokenIndex: number; // Index in the full token array
}

/**
 * Compare user inputs with target words and return detailed results
 * Uses flexible case matching (first letter case-insensitive, rest case-sensitive)
 * @param tokens - All tokens (words, punctuation, spaces)
 * @param wordInputs - User inputs for word tokens only
 * @returns Array of comparison results for each word
 */
export const compareWords = (tokens: Token[], wordInputs: string[], lenient = false): WordComparisonResult[] => {
  const wordTokens = getWordTokens(tokens);
  const results: WordComparisonResult[] = [];

  for (let i = 0; i < wordTokens.length; i++) {
    const targetWord = wordTokens[i].value;
    const inputWord = wordInputs[i] || '';
    const verdict = inputWord ? judgeWord(inputWord, targetWord, wordTokens[i].reading, lenient) : 'wrong';

    results.push({
      targetWord,
      inputWord,
      isCorrect: verdict === 'right',
      near: verdict === 'near',
      tokenIndex: wordTokens[i].index
    });
  }

  return results;
};


// Which word tokens are `word` in the line, to mark it: the same word ignoring case
// and punctuation; else (Japanese) every group the word overlaps; else the group
// looked up as it (諦めた → 諦める). Not in the line: none, so nothing is marked wrongly.
export const targetWords = (words: string[], word: string): number[] => {
  const norm = (w: string) => w.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}'’-]/gu, ''); // NFC: a decomposed accent is not dropped
  // A phrase (figure it out): its words in a row — before single words, or "can not" would find "cannot".
  const parts = getWordTokens(tokenizeText(word)).map(t => norm(t.value));
  if (parts.length > 1) {
    const s = words.findIndex((_, k) => parts.every((p, j) => words[k + j] !== undefined && norm(words[k + j]) === p));
    if (s >= 0) return parts.map((_, j) => s + j);
  }
  const i = words.findIndex(w => norm(w) === norm(word));
  if (i >= 0 || !word.trim()) return i >= 0 ? [i] : [];
  if (!hasKana(word + words.join(''))) return [];
  const at = words.join('').indexOf(word);
  if (at < 0) {
    const k = words.findIndex(w => jaLemma(w) === word);
    return k >= 0 ? [k] : [];
  }
  let start = 0;
  return words.flatMap((w, k) => {
    const hit = start < at + word.length && start + w.length > at;
    start += w.length;
    return hit ? [k] : [];
  });
};

// A line laid out for a word card: its words (clickable to look up) in pieces, each
// piece with its furigana (Japanese, dictionary loaded) and whether it is the kept word.
// Found as written, exactly those letters are marked (Japanese lines, and Chinese words: a run
// of Chinese is one token, the word may be part of it); else the whole word targetWords picks.
export type Piece = Ruby & { target: boolean };
export type Group = { word?: string; pieces: Piece[] };
export const sentenceParts = (text: string, word = ''): Group[] => {
  const tokens = tokenizeText(text);
  const at = word && (hasKana(text) || /\p{Script=Han}/u.test(word)) ? text.indexOf(word) : -1;
  const [a, b] = at >= 0 ? [at, at + word.length] : [-1, -1];
  const picked = at >= 0 ? new Set<number>() : new Set(targetWords(getWordTokens(tokens).map(w => w.value), word));
  let offset = 0, ord = 0;
  return tokens.map(tk => {
    if (tk.type !== TokenType.WORD) { offset += tk.value.length; return { pieces: [{ s: tk.value, target: false }] }; }
    const whole = picked.has(ord++);
    const pieces = furigana(tk.value, tk.reading).flatMap((p): Piece[] => {
      const from = offset;
      offset += p.s.length;
      if (at < 0) return [{ ...p, target: whole }];
      if (p.rt) return [{ ...p, target: from < b && offset > a }];
      // Kana cut at the word's edges: 諦める|しか.
      const cuts = [0, Math.min(Math.max(a - from, 0), p.s.length), Math.min(Math.max(b - from, 0), p.s.length), p.s.length];
      return [0, 1, 2].map(k => ({ s: p.s.slice(cuts[k], cuts[k + 1]), target: k === 1 })).filter(x => x.s);
    });
    return { word: tk.value, pieces };
  });
};
