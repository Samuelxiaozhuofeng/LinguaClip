/**
 * Checks utils/wordAudio.ts locateWord: where a word sits in its line's sound (docs/word-audio.md).
 * Run with: node test-wordaudio.mjs
 *
 * Bundles the real module (Tauri stubbed out) instead of re-typing the logic.
 */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = join(tmpdir(), `wordaudio-${process.pid}.mjs`);
await build({
  entryPoints: ['utils/wordAudio.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: out,
  plugins: [{
    name: 'stub-desktop',
    setup(b) {
      b.onResolve({ filter: /\/desktop$/ }, a => ({ path: a.path, namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        contents: `export const readCacheText = async () => null; export const readBinaryFile = async () => new Uint8Array();
          export const clipPath = async f => f; export const cutClip = async () => ({ file: '', image: null });
          export const jaDictStatus = async () => ({ installed: false }); export const installJaDict = async () => {};
          export const removeJaDict = async () => {}; export const onJaDictProgress = async () => () => {};`,
      }));
    },
  }],
});
const { locateWord } = await import(out);

// Line 10s–12s, "I like the red car": whisper times in seconds.
const line = { text: 'I like the red car', startTime: 10, endTime: 12 };
const words = [
  { w: 'I', from: 10000, to: 10200 }, { w: 'like', from: 10200, to: 10600 }, { w: 'the', from: 10600, to: 10800 },
  { w: 'red', from: 10800, to: 11300 }, { w: 'car', from: 11300, to: 11900 },
];

// Matched to the word times: exact, around 10.8–11.3 with the lead / tail.
const red = locateWord(line, 'red', words);
assert.equal(red.exact, true);
assert.ok(Math.abs(red.from - (10.8 - 0.08)) < 1e-6 && Math.abs(red.to - (11.3 + 0.12)) < 1e-6, JSON.stringify(red));

// No word times: by letters, not exact.
const guess = locateWord(line, 'red', null);
assert.equal(guess.exact, false);
assert.ok(guess.from > 10.5 && guess.to < 12, JSON.stringify(guess));

// Hand-edited line that no longer spells the timed words: by letters.
assert.equal(locateWord({ ...line, text: 'I like a red car' }, 'red', words).exact, false);

// Not in the line: null.
assert.equal(locateWord(line, 'blue', words), null);

// Twice in the line: the first one.
const twice = { text: 'go on go', startTime: 0, endTime: 3 };
const tw = [{ w: 'go', from: 0, to: 500 }, { w: 'on', from: 1000, to: 1500 }, { w: 'go', from: 2000, to: 2500 }];
const g = locateWord(twice, 'go', tw);
assert.equal(g.exact, true);
assert.ok(g.from < 0.5, JSON.stringify(g));

// A phrase: the whole stretch, case and punctuation aside (its tail held to the line end).
const ph = locateWord({ ...line, text: 'I like the Red car.' }, 'red car', words);
assert.equal(ph.exact, true);
assert.ok(Math.abs(ph.from - (10.8 - 0.08)) < 1e-6 && ph.to === 12, JSON.stringify(ph));

// A known place (the keyword card's `at`) is used as given.
assert.equal(locateWord(line, 'red', words, 11).exact, true);

// A word inside one timed token (「今日」 of 「今日は」): its ends are shared out by letters, so not exact.
const ja = { text: '今日は晴れ', startTime: 0, endTime: 2 };
const jw = [{ w: '今日は', from: 0, to: 900 }, { w: '晴れ', from: 900, to: 1800 }];
const kyo = locateWord(ja, '今日', jw);
assert.equal(kyo.exact, false, JSON.stringify(kyo));
assert.ok(kyo.from < 0.6, JSON.stringify(kyo)); // still placed inside 今日は, for in-app playing
assert.equal(locateWord(ja, '晴れ', jw).exact, true);

console.log('wordaudio: ok');
