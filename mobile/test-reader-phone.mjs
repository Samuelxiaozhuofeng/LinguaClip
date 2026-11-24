/**
 * Unit tests for mobile M2.3 reader & touch long-press phrase selection pure logic
 * (mobile/reader/phrasePick.ts) and picked-sense card extraction (mobile/useWordLookup.ts).
 * Run with: node mobile/test-reader-phone.mjs
 */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = join(tmpdir(), `mobile-reader-phone-${process.pid}.mjs`);
await build({
  stdin: {
    contents: `
      export * from './mobile/reader/phrasePick';
      export { tokenizeText, TokenType } from './utils/textTokenizer';
      export { firstFields } from './mobile/useWordLookup';
    `,
    resolveDir: '.',
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: out,
  logLevel: 'error',
  alias: {
    '@tauri-apps/plugin-http': './mobile/platform/http.ts',
  },
});

const {
  normalizeRange,
  expandRangeByHandle,
  extractPhraseText,
  selectedWordCount,
  isIndexInRange,
  isPhraseText,
  sliceTextByMarks,
  tokenizeText,
  TokenType,
  firstFields,
} = await import(out);

const toPickTokens = line =>
  tokenizeText(line).map(t => ({ text: t.value, isWord: t.type === TokenType.WORD }));

// 1. normalizeRange bounds & ordering
assert.deepEqual(normalizeRange(4, 2, 10), [2, 4]);
assert.deepEqual(normalizeRange(-3, 99, 5), [0, 4]);
assert.equal(normalizeRange(0, 1, 0), null);
assert.equal(normalizeRange(1.5, 2, 5), null);

// 2. expandRangeByHandle normal drag & crossing flip
assert.deepEqual(expandRangeByHandle([2, 4], 'end', 6, 8), [2, 6]);
assert.deepEqual(expandRangeByHandle([2, 4], 'start', 0, 8), [0, 4]);
assert.deepEqual(expandRangeByHandle([2, 4], 'start', 6, 8), [4, 6], 'start dragged past end flips cleanly');
assert.deepEqual(expandRangeByHandle([2, 4], 'end', 0, 8), [0, 2], 'end dragged before start flips cleanly');
assert.deepEqual(expandRangeByHandle([2, 4], 'end', 99, 5), [2, 4], 'clamped to token count');

// 3. extractPhraseText preserves exact original substring (spaces, apostrophes, punctuation inside)
const enLine = "I couldn't figure it out, honestly.";
const enTokens = toPickTokens(enLine);
// Tokens: 0:"I", 1:" ", 2:"couldn't", 3:" ", 4:"figure", 5:" ", 6:"it", 7:" ", 8:"out", 9:",", 10:" ", 11:"honestly", 12:"."
assert.equal(extractPhraseText(enTokens, 4, 8), 'figure it out');
assert.equal(extractPhraseText(enTokens, 8, 4), 'figure it out', 'reversed indices produce same phrase');
assert.equal(extractPhraseText(enTokens, 2, 4), "couldn't figure");
assert.equal(selectedWordCount(enTokens, 4, 8), 3);
assert.equal(selectedWordCount(enTokens, 4, 4), 1);
assert.equal(isIndexInRange(6, [4, 8]), true);
assert.equal(isIndexInRange(2, [4, 8]), false);
assert.equal(isIndexInRange(4, null), false);

// 4. Japanese substring extraction without inserting spaces
const jaTokens = [
  { text: '気', isWord: true },
  { text: 'を', isWord: true },
  { text: 'つけて', isWord: true },
  { text: 'ね', isWord: true },
];
assert.equal(extractPhraseText(jaTokens, 0, 2), '気をつけて');
assert.equal(selectedWordCount(jaTokens, 0, 2), 3);

// 5. isPhraseText detection
assert.equal(isPhraseText('figure out', false), true);
assert.equal(isPhraseText('figure', false), false);
assert.equal(isPhraseText('  pick up  ', false), true);
assert.equal(isPhraseText('', false), false);

// 6. sliceTextByMarks: hot phrase + passive mark + partial overlap
const segs = sliceTextByMarks('picked it up quickly', 10, [
  { from: 10, to: 22, hot: true },
  { from: 23, to: 30, hot: false },
]);
assert.deepEqual(segs, [
  { text: 'picked it up', hot: true, marked: true },
  { text: ' ', hot: false, marked: false },
  { text: 'quickly', hot: false, marked: true },
]);
assert.deepEqual(sliceTextByMarks('hello', 0, []), [{ text: 'hello', hot: false, marked: false }]);

// 7. firstFields prefers AI-picked sense over sense #1, and falls back to AI when dict is null
const mockLine = { id: 1, startTime: 0, endTime: 2, text: 'We have to figure it out.' };
const mockDict = [{
  word: 'figure out',
  source: 'youdao',
  senses: [
    { pos: 'v.', text: ['to calculate'], examples: [] },
    { pos: 'v.', text: ['to understand or solve'], examples: [] },
  ],
}];
const pickedCard = firstFields({
  word: 'figure out',
  line: mockLine,
  around: '',
  lang: 'en',
  phrase: true,
  loading: false,
  dict: mockDict,
  ai: null,
  aiBusy: false,
  aiError: '',
  picked: 2,
  pickNote: '这里是“弄明白、解决”的意思',
  pickCulture: '口语常用短语。',
  error: '',
});
assert.ok(pickedCard.definition.includes('understand or solve'), 'picked sense #2 chosen');
assert.ok(pickedCard.ai.includes('弄明白') && pickedCard.ai.includes('口语常用短语'));

const aiOnlyCard = firstFields({
  word: 'break a leg',
  line: mockLine,
  around: '',
  lang: 'en',
  phrase: true,
  loading: false,
  dict: null,
  ai: { word: 'break a leg', partOfSpeech: 'idiom', definition: '祝你好运', culture: '源自戏剧界迷信说法。' },
  aiBusy: false,
  aiError: '',
  picked: null,
  error: 'notFound',
});
assert.ok(aiOnlyCard.definition.includes('祝你好运'));
assert.equal(aiOnlyCard.ai, '源自戏剧界迷信说法。');

console.log('mobile reader phone ok');
