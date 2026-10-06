/**
 * Checks the reader's "this episode's phrases": batches split on whole lines, the AI's
 * references are checked against their line and batch, broken answers throw, and the saved
 * file must still fit the subtitles. utils/phrasePrep.ts (docs/phrases.md). Run with: node test-phrases.mjs
 *
 * Bundles the real module (stubbing Tauri) instead of re-typing the logic.
 */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = join(tmpdir(), `phrases-${process.pid}.mjs`);
await build({
  stdin: {
    contents: `export { phraseBatches, parsePhraseResponse, parsePhraseCache, phrasePrompt } from './utils/phrasePrep.ts'; export { hashSrt } from './utils/aiDrills.ts';`,
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
const { phraseBatches, parsePhraseResponse, parsePhraseCache, phrasePrompt, hashSrt } = await import(out);

const lines = [
  { text: "We'll speak no more of it and let's crack on with the show.", startTime: 99, endTime: 102 },
  { text: 'I picked it up on the way.', startTime: 104, endTime: 106 },
  { text: '他终于把这件事搞定了。', startTime: 107, endTime: 109 },
  { text: 'Pick it up!', startTime: 110, endTime: 111 },
];
const ask = items => JSON.stringify({ items });

// Batches: whole lines, about n words each, covering every line once.
{
  assert.deepEqual(phraseBatches(lines, 1000), [[0, 4]]);
  // 13 words; 7 + 6 (11 CJK chars); then a 3-word tail: under a quarter of 13 joins the batch before, of 8 it stays.
  assert.deepEqual(phraseBatches(lines, 13), [[0, 1], [1, 4]]);
  assert.deepEqual(phraseBatches(lines, 8), [[0, 1], [1, 3], [3, 4]]);
  const many = Array.from({ length: 30 }, (_, i) => ({ text: 'one two three four five', startTime: i, endTime: i + 1 }));
  const bs = phraseBatches(many, 50);
  assert.equal(bs.length, 3);
  assert.equal(bs[0][0], 0);
  assert.equal(bs.at(-1)[1], 30);
  bs.slice(1).forEach((x, i) => assert.equal(x[0], bs[i][1]));
  assert.deepEqual(phraseBatches([], 50), []);
}

// Items are checked against their own line and batch; split phrases come as the whole stretch.
{
  const res = parsePhraseResponse('```json\n' + ask([
    { line: 0, text: 'crack on with', base: 'crack on with', meaning: '继续', note: '英式口语' },
    { line: 1, text: 'PICKED IT UP', base: 'pick up', meaning: '买到' },
    { line: 1, text: 'picked up', base: 'pick up' },          // not as written: dropped
    { line: 2, text: '搞定', base: '搞定', meaning: 'sort out' },
    { line: 3, text: 'Pick it up', base: 'pick up' },         // outside this batch
    { line: 0, text: 'crack on with', base: 'x' },             // same place twice
    { line: 0.5, text: 'show' },
    { line: 0, text: '' },
    { line: 0, text: 'x'.repeat(61) },
  ]) + '\n```', lines, 0, 3);
  assert.deepEqual(res.map(p => [p.line, p.text, p.at, p.base]), [
    [0, 'crack on with', 36, 'crack on with'],
    [1, 'picked it up', 2, 'pick up'],
    [2, '搞定', 7, '搞定'],
  ]);
  assert.equal(res[0].start, 99);
  assert.equal(res[0].note, '英式口语');
  // No base: the text itself; long words cut.
  const [one] = parsePhraseResponse(ask([{ line: 3, text: 'pick it up', meaning: 'm'.repeat(90), note: 'n'.repeat(200) }]), lines, 3, 4);
  assert.equal(one.base, 'Pick it up');
  assert.equal(one.meaning.length, 40);
  assert.equal(one.note.length, 80);
  // None at all is an answer, not an error.
  assert.deepEqual(parsePhraseResponse('{"items":[]}', lines, 0, 4), []);
  assert.deepEqual(parsePhraseResponse(ask([{ line: 0, text: 'nowhere here' }]), lines, 0, 4), []);
  // Broken answers throw (retried, then the job fails and nothing is saved).
  assert.throws(() => parsePhraseResponse('sorry, no', lines, 0, 4));
  assert.throws(() => parsePhraseResponse('{"items": "none"}', lines, 0, 4));
  assert.throws(() => parsePhraseResponse('{"items": [', lines, 0, 4));
}

// The same stretch twice in one line: each item takes the next place; a third has none left.
{
  const two = [{ text: 'Pick it up, then pick it up again.', startTime: 0, endTime: 2 }];
  const res = parsePhraseResponse(ask([{ line: 0, text: 'pick it up' }, { line: 0, text: 'pick it up' }, { line: 0, text: 'pick it up' }]), two, 0, 1);
  assert.deepEqual(res.map(p => [p.at, p.text]), [[0, 'Pick it up'], [17, 'pick it up']]);
}

// The saved file: only while the subtitles are the same, item by item still in place.
{
  const items = parsePhraseResponse(ask([{ line: 1, text: 'picked it up', base: 'pick up', meaning: '买到', note: '' }, { line: 0, text: 'crack on with' }]), lines, 0, 4);
  const srt = hashSrt(lines.map(l => l.text).join('\n'));
  const file = { v: 1, srt, lang: 'zh', items };
  assert.equal(parsePhraseCache(JSON.stringify(file), lines).items.length, 2);
  assert.deepEqual(parsePhraseCache(JSON.stringify({ ...file, items: [] }), lines).items, []);
  assert.equal(parsePhraseCache(JSON.stringify({ ...file, srt: 'other' }), lines), null);
  assert.equal(parsePhraseCache(JSON.stringify({ ...file, v: 2 }), lines), null);
  assert.equal(parsePhraseCache('{broken', lines), null);
  assert.equal(parsePhraseCache(null, lines), null);
  const moved = [{ ...items[0], at: 3 }, { ...items[1], start: 1 }, { ...items[0], meaning: 5 }, null, items[0]];
  assert.equal(parsePhraseCache(JSON.stringify({ ...file, items: moved }), lines).items.length, 1);
}

// The prompt numbers lines globally and holds only this batch.
{
  const p = phrasePrompt(lines, 1, 3, 'zh');
  assert.ok(p.includes('1\tI picked it up on the way.'));
  assert.ok(p.includes('2\t他终于把这件事搞定了。'));
  assert.ok(!p.includes('crack on with the show'));
  assert.ok(p.includes('简体中文'));
  assert.ok(phrasePrompt(lines, 0, 1, 'en').includes('English'));
}

console.log('phrases: all checks passed');
