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
  const pattern = /([\p{L}\p{N}]+(?:['’][\p{L}]+)?)|([^\p{L}\p{N}\s])|(\s+)/gu;

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
// A keyboard types ' where subtitles often have ’; both count.
const foldQuote = (s: string) => s.trim().replace(/’/g, "'");

export const isInputCorrect = (input: string, target: string): boolean => {
  return foldQuote(input).toLowerCase() === foldQuote(target).toLowerCase();
};

/**
 * Check if input matches target with flexible first letter case
 * First letter can be different case, but rest must match exactly
 * @param input - User input word
 * @param target - Target word
 * @returns true if words match with flexible first letter case
 */
export const isInputCorrectFlexibleCase = (input: string, target: string, reading?: string): boolean => {
  if (reading !== undefined && input.trim()) {
    const typed = kanaFold(input);
    if (typed === kanaFold(target) || typed === kanaFold(reading)) return true;
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
export const areAllWordsCorrectFlexibleCase = (tokens: Token[], wordInputs: string[]): boolean => {
  const wordTokens = getWordTokens(tokens);

  if (wordInputs.length !== wordTokens.length) {
    return false;
  }

  return wordTokens.every((token, index) => {
    const input = wordInputs[index];
    return input && isInputCorrectFlexibleCase(input, token.value, token.reading);
  });
};

/**
 * Word comparison result for detailed feedback
 */
export interface WordComparisonResult {
  targetWord: string;
  inputWord: string;
  isCorrect: boolean;
  tokenIndex: number; // Index in the full token array
}

/**
 * Compare user inputs with target words and return detailed results
 * Uses flexible case matching (first letter case-insensitive, rest case-sensitive)
 * @param tokens - All tokens (words, punctuation, spaces)
 * @param wordInputs - User inputs for word tokens only
 * @returns Array of comparison results for each word
 */
export const compareWords = (tokens: Token[], wordInputs: string[]): WordComparisonResult[] => {
  const wordTokens = getWordTokens(tokens);
  const results: WordComparisonResult[] = [];

  for (let i = 0; i < wordTokens.length; i++) {
    const targetWord = wordTokens[i].value;
    const inputWord = wordInputs[i] || '';
    const isCorrect = inputWord && isInputCorrectFlexibleCase(inputWord, targetWord, wordTokens[i].reading);

    results.push({
      targetWord,
      inputWord,
      isCorrect,
      tokenIndex: wordTokens[i].index
    });
  }

  return results;
};


// Which word tokens are `word` in the line, to mark it: the same word ignoring case
// and punctuation; else (Japanese) every group the word overlaps; else the group
// looked up as it (諦めた → 諦める). Not in the line: none, so nothing is marked wrongly.
export const targetWords = (words: string[], word: string): number[] => {
  const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}'’-]/gu, '');
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
// Found as written, exactly those letters are marked; else the whole word targetWords picks.
export type Piece = Ruby & { target: boolean };
export type Group = { word?: string; pieces: Piece[] };
export const sentenceParts = (text: string, word = ''): Group[] => {
  const tokens = tokenizeText(text);
  const at = word && hasKana(text) ? text.indexOf(word) : -1;
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
