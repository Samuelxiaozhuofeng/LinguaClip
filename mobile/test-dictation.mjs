/**
 * The phone's review & touch dictation check (mobile/dictation.ts):
 * - English / Spanish / NFD word alignment, lenient near-miss pairing & letter marks
 * - Japanese fallback (whole-line) when the splitting dictionary is not loaded
 * - Japanese chunk-by-chunk alignment (良い / いい, kana reading, single wrong particle) once loaded
 * Run with: node mobile/test-dictation.mjs
 */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = join(tmpdir(), `mobile-dictation-${process.pid}.mjs`);
await build({
  stdin: {
    contents: "export * from './mobile/dictation'; export { loadJa, jaReady } from './utils/japanese';",
    resolveDir: '.',
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: out,
  logLevel: 'error',
  plugins: [{
    name: 'stub-desktop',
    setup(b) {
      b.onResolve({ filter: /\/desktop$|^@tauri-apps\/plugin-http$/ }, a => ({ path: a.path, namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        contents: `import { readFileSync } from 'node:fs';
          export const jaDictStatus = async () => ({ installed: true, dir: 'node_modules/kuromoji/dict', bytes: 0 });
          export const readBinaryFile = async p => new Uint8Array(readFileSync(p));
          export const installJaDict = async () => {};
          export const removeJaDict = async () => {};
          export const onJaDictProgress = async () => () => {};
          export const readCacheText = async () => null;
          export const writeCacheText = async () => {};`,
        resolveDir: process.cwd(),
      }));
    },
  }],
});
const { checkDictation: check, loadJa, jaReady } = await import(out);
const show = r => r.pieces.filter(p => p.kind !== 'text').map(p => `${p.kind}:${p.s}`).join(' ');

let r = check('Me encanta la paella, pero mi abuela hace un guiso increíble.', 'me encanta la paella pero mi abuela hace un guisó increíble');
assert.equal(r.wrong, 1);
assert.equal(r.correct, false);
assert.match(show(r), /extra:guisó miss:guiso ok:increíble/);
// Accent-only difference is paired as a near miss on "guiso" (last letter 'o' differs).
assert.equal(r.near, 1);
const guisoWord = r.words.find(w => w.target === 'guiso');
assert.equal(guisoWord?.verdict, 'near');
assert.deepEqual(guisoWord?.marks, [false, false, false, false, true]);

r = check("It's a nice day.", 'it’s a nice day');
assert.ok(r.correct, show(r));
assert.equal(r.wrong, 0);
assert.equal(r.near, 0);

r = check('I really like it.', 'I like it');
assert.equal(r.wrong, 1);
assert.equal(r.near, 0);
assert.match(show(r), /ok:I miss:really ok:like/);

r = check('I like it.', 'I do like it a lot');
assert.equal(r.wrong, 2);
assert.match(show(r), /ok:I extra:do ok:like ok:it extra:a extra:lot/);

r = check('Hello there.', '');
assert.equal(r.correct, false);
assert.equal(r.wrong, 1);
assert.equal(r.near, 0);

// Lenient (default on): case of the whole word doesn't count.
r = check('I bought an iPhone.', 'i bought an IPHONE');
assert.ok(r.correct, show(r));

// Ending near miss: walk vs walked -> still wrong, marked near with 'ed' highlighted.
r = check('I walked home.', 'I walk home');
assert.equal(r.correct, false, 'a near miss is still wrong');
assert.equal(r.wrong, 1);
assert.equal(r.near, 1);
assert.equal(r.words[1].verdict, 'near');
assert.deepEqual(r.words[1].marks, [false, false, false, false, true, true]);
const walkedPiece = r.pieces.find(p => p.kind === 'miss' && p.s === 'walked');
assert.equal(walkedPiece?.near, true);
assert.deepEqual(walkedPiece?.marks, [false, false, false, false, true, true]);

// Missing word next to a near miss in the same gap: "really" is wrong, "walked" still pairs as near!
r = check('I really walked home.', 'I walk home');
assert.equal(r.correct, false);
assert.equal(r.near, 1);
assert.equal(r.words[0].verdict, 'right');
assert.equal(r.words[1].verdict, 'wrong');
assert.equal(r.words[2].verdict, 'near');
assert.deepEqual(r.words[2].marks, [false, false, false, false, true, true]);
assert.equal(r.words[3].verdict, 'right');

// 6+ letter word with single-letter edit: "yestarday" vs "yesterday" -> near, marks 5th letter 'e'.
r = check('We arrived yesterday.', 'We arrived yestarday');
assert.equal(r.correct, false);
assert.equal(r.near, 1);
assert.equal(r.words[2].verdict, 'near');
assert.deepEqual(r.words[2].marks, [false, false, false, false, true, false, false, false, false]);

// Strict mode (lenient = false): no near misses, whole-word case mismatch is wrong.
r = check('I bought an iPhone.', 'i bought an IPHONE', false);
assert.equal(r.correct, false);
assert.equal(r.near, 0);
r = check('I walked home.', 'I walk home', false);
assert.equal(r.correct, false);
assert.equal(r.near, 0);
assert.equal(r.words[1].verdict, 'wrong');

// A decomposed (NFD) subtitle against the phone keyboard's composed letters.
r = check('Él está aquí.'.normalize('NFD'), 'él está aquí');
assert.ok(r.correct, show(r));

// --- Japanese BEFORE the splitting dictionary is loaded: falls back to whole-line matching ---
assert.equal(jaReady(), false);
r = check('すみません。', 'スミマセン');
assert.ok(r.correct);
assert.equal(r.words.length, 1);
assert.equal(r.near, 0);
r = check('すみません。', 'すいません');
assert.equal(r.correct, false);
assert.equal(r.words.length, 1);
assert.equal(r.near, 0);
// Without dictionary, alternate kanji (良い vs いい) and pure-kanji readings fall back to whole-line mismatch.
r = check('今日はいい天気ですね。', '今日は良い天気ですね');
assert.equal(r.correct, false);
assert.equal(r.words.length, 1);
r = check('大丈夫。', '大丈夫', true, 'ja');
assert.ok(r.correct);
assert.equal(r.words.length, 1);
r = check('大丈夫。', 'だいじょうぶ', true, 'ja');
assert.equal(r.correct, false);
assert.equal(r.words.length, 1);

// --- Japanese AFTER loading kuromoji splitting dictionary: chunk-by-chunk alignment ---
assert.equal(await loadJa(), true);
assert.equal(jaReady(), true);

// 1. Alternate kanji with same meaning/reading: 良い vs いい (both directions) -> all right!
r = check('今日はいい天気ですね。', '今日は良い天気ですね');
assert.ok(r.correct, show(r));
assert.equal(r.wrong, 0);
assert.equal(r.words.length, 3);
assert.deepEqual(r.words.map(w => w.verdict), ['right', 'right', 'right']);

r = check('今日は良い天気ですね。', '今日はいい天気ですね');
assert.ok(r.correct, show(r));
assert.equal(r.words.length, 3);

// 2. Pure kana reading for kanji chunks -> all right!
r = check('今日はいい天気ですね。', 'きょうはいいてんきですね');
assert.ok(r.correct, show(r));
assert.equal(r.words.length, 3);

// 2a. Repeated phrase typed as the whole reading stays right (chunk alignment can't pair repeats).
r = check('お気を付けて、お気を付けて', 'おきをつけておきをつけて', true, 'ja');
assert.ok(r.correct, show(r));

// 2b. Pure kanji target (no kana in target) enters Japanese branch when lang='ja'.
r = check('大丈夫。', 'だいじょうぶ', true, 'ja');
assert.ok(r.correct, show(r));
assert.equal(r.wrong, 0);
assert.equal(r.words.length, 1);
assert.equal(r.words[0].verdict, 'right');
// Without lang (or non-ja lang like 'zh'), pure kanji keeps legacy behavior and does not accept kana.
r = check('大丈夫。', 'だいじょうぶ');
assert.equal(r.correct, false);
r = check('大丈夫。', 'だいじょうぶ', true, 'zh');
assert.equal(r.correct, false);

// 3. Alternate kanji sharing the same reading: 分かります vs 解ります / わかります
r = check('分かります。', '解ります');
assert.ok(r.correct, show(r));
r = check('分かります。', 'わかります');
assert.ok(r.correct, show(r));

// 4. Single wrong particle only marks that one chunk red (the other 4 stay right).
r = check('昨日友達と新宿で映画を見てきました', '昨日友達と新宿に映画を見てきました');
assert.equal(r.correct, false);
assert.equal(r.wrong, 1);
assert.equal(r.words.length, 5);
assert.deepEqual(r.words.map(w => w.verdict), ['right', 'right', 'wrong', 'right', 'right']);
assert.equal(r.words[2].target, '新宿で');
assert.match(show(r), /ok:昨日 ok:友達と extra:新宿に miss:新宿で ok:映画を ok:見てきました/);

// 4b. Pure-kana input with a single wrong particle re-syncs after the wrong chunk (does NOT cascade).
r = check('昨日友達と新宿で映画を見てきました', 'きのうともだちとしんじゅくにえいがをみてきました', true, 'ja');
assert.equal(r.correct, false);
assert.equal(r.wrong, 1);
assert.equal(r.words.length, 5);
assert.deepEqual(r.words.map(w => w.verdict), ['right', 'right', 'wrong', 'right', 'right']);
assert.equal(r.words[2].target, '新宿で');
assert.match(show(r), /ok:昨日 ok:友達と extra:しんじゅくに miss:新宿で ok:映画を ok:見てきました/);

// 4c. Pure-kana input with all right chunks matches completely.
r = check('昨日友達と新宿で映画を見てきました', 'きのうともだちとしんじゅくでえいがをみてきました', true, 'ja');
assert.ok(r.correct, show(r));
assert.equal(r.wrong, 0);

// 4d. Pure-kana input with two separated errors still keeps the middle right chunk ok.
r = check('昨日友達と新宿で映画を見てきました', 'きのうともだちとしんじゅくにえいがをみてきませんでした', true, 'ja');
assert.equal(r.correct, false);
assert.equal(r.wrong, 2);
assert.deepEqual(r.words.map(w => w.verdict), ['right', 'right', 'wrong', 'right', 'wrong']);

// 4e. Other single-chunk kana mistakes & alternate kanji readings (from review probe).
r = check('東京に行きます', 'とうきょうでいきます', true, 'ja');
assert.equal(r.correct, false);
assert.equal(r.wrong, 1);
assert.deepEqual(r.words.map(w => w.verdict), ['wrong', 'right']);

r = check('東京で', '東京に', true, 'ja');
assert.equal(r.correct, false);
assert.equal(r.wrong, 1);
assert.deepEqual(r.words.map(w => w.verdict), ['wrong']);

r = check('今日はいい天気ですね。', 'きょうわいいてんきですね', true, 'ja');
assert.equal(r.correct, false);
assert.equal(r.wrong, 1);
assert.deepEqual(r.words.map(w => w.verdict), ['wrong', 'right', 'right']);

r = check('明日は雨が降るでしょう', 'あしたはあめがふるでしょ', true, 'ja');
assert.equal(r.correct, false);
assert.equal(r.wrong, 1);
assert.deepEqual(r.words.map(w => w.verdict), ['right', 'right', 'wrong']);

r = check('明日は雨が降るでしょう', '明日は雨が振るでしょう', true, 'ja');
assert.ok(r.correct, show(r));

// 5. Extra typed chunk shows up as extra without marking target chunks wrong.
r = check('今日はいい天気ですね。', '今日は本当にいい天気ですね');
assert.equal(r.correct, false);
assert.equal(r.wrong, 1);
assert.deepEqual(r.words.map(w => w.verdict), ['right', 'right', 'right']);
assert.match(show(r), /ok:今日は extra:本当に ok:いい ok:天気ですね/);

// 6. Empty typed input -> all chunks miss.
r = check('今日はいい天気ですね。', '');
assert.equal(r.correct, false);
assert.deepEqual(r.words.map(w => w.verdict), ['wrong', 'wrong', 'wrong']);

console.log('mobile dictation ok');
