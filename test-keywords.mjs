/**
 * Checks "this episode's keywords": the AI's references are checked against the lines
 * (English, Chinese, Japanese), broken answers throw, and the saved file must still fit
 * the subtitles. utils/keywordPrep.ts (docs/keywords.md). Run with: node test-keywords.mjs
 *
 * Bundles the real module (stubbing Tauri) instead of re-typing the logic.
 */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = join(tmpdir(), `keywords-${process.pid}.mjs`);
await build({
  stdin: {
    contents: `export { findWord, parseKeywordResponse, parseKeywordCache, keywordPrompt } from './utils/keywordPrep.ts'; export { hashSrt } from './utils/aiDrills.ts';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  outfile: out,
  define: { 'process.env.ROUTER9_BASE_URL': '""', 'process.env.ROUTER9_BASE_KEY': '""' },
  plugins: [{
    name: 'stub-tauri',
    setup(b) {
      b.onResolve({ filter: /^@tauri-apps\// }, a => ({ path: a.path, namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        contents: `const no = () => { throw new Error('tauri'); };
          export const fetch = globalThis.fetch, invoke = no, convertFileSrc = no, open = no, save = no, readTextFile = no,
            exists = no, readFile = no, listen = no, homeDir = no, join = no, getCurrentWebview = no, getCurrentWindow = no, openUrl = no, revealItemInDir = no,
            check = no, relaunch = no, getVersion = no;`,
      }));
    },
  }],
});
const { findWord, parseKeywordResponse, parseKeywordCache, keywordPrompt, hashSrt } = await import(out);

const lines = [
  { text: 'Running late again, she ran to the station.', startTime: 1, endTime: 4 },
  { text: '今日はとても忙しかったです。', startTime: 5, endTime: 7 },
  { text: '这个问题其实很复杂。', startTime: 8, endTime: 10 },
];
const ask = words => JSON.stringify({ summary: 'Two sentences.', words });

// Whole words only for Latin letters, any case; substrings for CJK.
assert.equal(findWord(lines[0].text, 'ran'), 24);
assert.equal(findWord(lines[0].text, 'running'), 0);
assert.equal(findWord(lines[0].text, 'run'), -1);
assert.equal(findWord(lines[1].text, '忙しかった'), 6);
assert.equal(findWord(lines[2].text, '复杂'), 7);

// 1. Words are checked against their own line; made-up words, wrong line numbers and repeats go.
{
  const res = parseKeywordResponse('```json\n' + ask([
    { line: 0, word: 'running late', meaning: '要迟到', note: '口语' },
    { line: 0, word: 'sprinted', meaning: '冲刺' },         // not in the line
    { line: 2, word: '忙しかった', meaning: 'busy' },      // wrong line
    { line: 9, word: 'station' },                           // out of range
    { line: 1.5, word: 'とても' },                          // not an integer
    { line: 1, word: '忙しかった', meaning: '很忙', note: '形容词过去式' },
    { line: 2, word: '复杂', meaning: '复杂' },
    { line: 0, word: 'Running Late' },                      // same word again
  ]) + '\n```', lines);
  assert.equal(res.summary, 'Two sentences.');
  assert.deepEqual(res.words.map(w => [w.line, w.word, w.at, w.start]), [[0, 'Running late', 0, 1], [1, '忙しかった', 6, 5], [2, '复杂', 7, 8]]);
  assert.equal(res.words[0].meaning, '要迟到');
  assert.equal(res.words[2].note, '');
}

// 2. Broken answers throw — never "no keywords".
assert.throws(() => parseKeywordResponse('not json', lines));
assert.throws(() => parseKeywordResponse(JSON.stringify({ words: [{ line: 0, word: 'ran' }] }), lines)); // no summary
assert.throws(() => parseKeywordResponse(ask([{ line: 0, word: 'flew' }]), lines)); // nothing left
assert.throws(() => parseKeywordResponse(JSON.stringify({ summary: 'x', words: 'ran' }), lines));

// 3. At most 15, long texts cut.
{
  const many = Array.from({ length: 30 }, (_, i) => ({ line: 0, word: ['Running', 'late', 'again', 'she', 'ran', 'to', 'the', 'station'][i % 8] + (i < 8 ? '' : 'x') }));
  const longText = 'a'.repeat(200);
  const res = parseKeywordResponse(JSON.stringify({ summary: longText + longText, words: [{ line: 0, word: 'ran', meaning: longText, note: longText }, ...many] }), lines);
  assert.ok(res.words.length <= 15);
  assert.equal(res.summary.length, 300);
  assert.equal(res.words[0].meaning.length, 40);
  assert.equal(res.words[0].note.length, 80);
}

// 4. The saved file must fit these subtitles.
{
  const srt = hashSrt(lines.map(l => l.text).join('\n'));
  const words = parseKeywordResponse(ask([{ line: 0, word: 'ran' }, { line: 2, word: '复杂' }]), lines).words;
  const file = { v: 1, srt, lang: 'zh', summary: 's', words };
  assert.equal(parseKeywordCache(JSON.stringify(file), lines).words.length, 2);
  assert.equal(parseKeywordCache(JSON.stringify({ ...file, srt: 'other' }), lines), null);
  assert.equal(parseKeywordCache(JSON.stringify({ ...file, v: 2 }), lines), null);
  assert.equal(parseKeywordCache('{broken', lines), null);
  assert.equal(parseKeywordCache(null, lines), null);
  const moved = { ...file, words: [{ ...words[0], at: 3 }, words[1]] }; // one no longer where it was
  assert.deepEqual(parseKeywordCache(JSON.stringify(moved), lines).words.map(w => w.word), ['复杂']);
  assert.equal(parseKeywordCache(JSON.stringify({ ...file, words: [{ ...words[0], start: 2 }] }), lines), null);
  // Wrong field types (a hand-edited or damaged file): that item goes; none left = no file.
  const bad = [{ ...words[0], meaning: { x: 1 } }, { ...words[0], note: null }, { ...words[0], line: '0' }, { ...words[0], at: 1.5 },
    { ...words[0], start: '1' }, { ...words[0], word: 7 }, null, 'ran', words[1]];
  assert.deepEqual(parseKeywordCache(JSON.stringify({ ...file, words: bad }), lines).words.map(w => w.word), ['复杂']);
  assert.equal(parseKeywordCache(JSON.stringify({ ...file, words: bad.slice(0, 8) }), lines), null);
  assert.equal(parseKeywordCache(JSON.stringify({ ...file, summary: { a: 1 } }), lines), null);
  assert.equal(parseKeywordCache(JSON.stringify({ ...file, words: [{ ...words[0], extra: '<b>' }] }), lines).words[0].extra, undefined);
}

// 5. The prompt numbers lines in subtitle order and asks for the interface language.
assert.match(keywordPrompt(lines, 'zh'), /\n0\tRunning late again/);
assert.match(keywordPrompt(lines, 'zh'), /简体中文/);
assert.match(keywordPrompt(lines, 'en'), /English/);

console.log('keywords ok');
