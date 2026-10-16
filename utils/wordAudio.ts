// "Just this word" (docs/word-audio.md): where a word sits in its line's sound, and its Anki clip.
import type { Word } from './resegment';
import type { Source } from './clips';
import { getWordTokens, targetWords, tokenizeText, TokenType } from './textTokenizer';
import { hasKana } from './japanese';
import { playSpan, wordSpans, wordsInLine } from './wordTimes';
import { clipPath, cutClip, readBinaryFile } from './desktop';

export type LineTimes = { text: string; startTime: number; endTime: number };
export type WordSpot = { from: number; to: number; exact: boolean };

const letters = (s: string) => s.replace(/[^\p{L}\p{M}\p{N}]/gu, '').length;

// Which letters of the line are `word`, as the marked word on a card (sentenceParts):
// Japanese lines and Chinese words as written, else the words targetWords picks.
// ponytail: a word twice in the line = its first time.
const charRange = (text: string, word: string): [number, number] | null => {
  const at = word && (hasKana(text) || /\p{Script=Han}/u.test(word)) ? text.indexOf(word) : -1;
  if (at >= 0) return [at, at + word.length];
  const spans: [number, number][] = [];
  let off = 0;
  for (const tk of tokenizeText(text)) {
    if (tk.type === TokenType.WORD) spans.push([off, off + tk.value.length]);
    off += tk.value.length;
  }
  const picked = targetWords(getWordTokens(tokenizeText(text)).map(w => w.value), word);
  return picked.length ? [spans[picked[0]][0], spans[picked[picked.length - 1]][1]] : null;
};

// The word's stretch in video seconds: whisper's word times when the line matches them
// (exact), else by letters. `at`: where the caller already knows the word starts. null = not in the line.
export function locateWord(line: LineTimes, word: string, words: Word[] | null, at?: number): WordSpot | null {
  const range = at !== undefined ? [at, at + word.length] : charRange(line.text, word);
  if (!range) return null;
  const pieces = [line.text.slice(0, range[0]), line.text.slice(range[0], range[1]), line.text.slice(range[1])];
  const parts = pieces.map((p, i) => ({ p, i })).filter(x => letters(x.p) > 0);
  const edges: boolean[] = [];
  const spans = wordSpans(parts.map(x => x.p), wordsInLine(words, line.startTime, line.endTime), edges);
  const own = parts.findIndex(x => x.i === 1);
  let from: number, to: number;
  // exact = both ends are whisper's own word ends; a word inside one timed token ("今日" of "今日は") is shared out by letters.
  const exact = !!spans && own >= 0 && edges[own];
  if (spans && own >= 0) [from, to] = spans[own];
  else {
    const all = letters(line.text) || 1;
    from = letters(pieces[0]) / all;
    to = (letters(pieces[0]) + letters(pieces[1])) / all;
  }
  const [a, b] = playSpan(line.startTime, line.endTime, from, to);
  return { from: a, to: b, exact };
}

const b64 = (bytes: Uint8Array) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
export const readClipB64 = async (file: string) => b64(await readBinaryFile(await clipPath(file)));

// The word's own sound for an Anki card (base64 m4a), cut like the batch cuts a line.
// Only when its place is exact; anything failing = no word sound, never a stopped card.
export const wordClipB64 = async (src: Source, line: LineTimes, word: string, words: Word[] | null, name: string): Promise<string | undefined> => {
  try {
    const spot = locateWord(line, word, words);
    if (!spot?.exact) return undefined;
    const cut = await cutClip(src.path, Math.max(0, spot.from - src.offset), spot.to - src.offset, name, 'audio');
    return await readClipB64(cut.file);
  } catch (e) {
    console.error(e);
    return undefined;
  }
};
