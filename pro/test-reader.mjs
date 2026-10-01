/**
 * Checks the reader's data: words looked up while reading (utils/readLooked.ts) and
 * how the watch page finds them again in another form, plus the AI translation's
 * answer / cache checks and its background job (pro/transPrep.ts).
 * Run with: node pro/test-reader.mjs
 *
 * Bundles the real modules; the dictionary is read from node_modules/kuromoji/dict,
 * the cache and the AI are in-memory stubs.
 */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const store = new Map();
globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
store.set('linguaclip_ai_config', JSON.stringify({ baseUrl: 'https://ai.test/v1', apiKey: 'sk-test-123456', model: 'm' }));

const out = join(tmpdir(), `reader-${process.pid}.mjs`);
await build({
  stdin: { contents: "export * from './utils/readLooked.ts'; export * from './pro/transPrep.ts'; export * from './utils/textTokenizer.ts'; export { loadJa, jaMorphs } from './utils/japanese.ts';", resolveDir: process.cwd(), loader: 'ts' },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: out,
  plugins: [{
    name: 'stub-desktop',
    setup(b) {
      b.onResolve({ filter: /\/desktop$|^@tauri-apps\/plugin-http$/ }, a => ({ path: a.path, namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        contents: `import { readFileSync } from 'node:fs';
          export const jaDictStatus = async () => ({ installed: true, dir: 'node_modules/kuromoji/dict', bytes: 0 });
          export const readBinaryFile = async p => new Uint8Array(readFileSync(p));
          export const installJaDict = async () => {}; export const removeJaDict = async () => {};
          export const onJaDictProgress = async () => () => {};
          export const readCacheText = async (id, kind) => globalThis.__cache.get(id + '.' + kind) ?? null;
          export const writeCacheText = async (id, kind, text) => { globalThis.__writes.push(id + '.' + kind); globalThis.__cache.set(id + '.' + kind, text); };
          export const fetch = (...a) => globalThis.__fetch(...a);`,
        resolveDir: process.cwd(),
      }));
    },
  }],
  logLevel: 'error',
});
globalThis.__cache = new Map();
globalThis.__writes = [];
const R = await import(out);

// 1. Without the dictionary a Japanese "word" is the whole line: not kept.
assert.equal(R.lookedKey('今日はいい天気ですね', true), null);
R.addLooked('v1', '今日はいい天気ですね', true);
assert.deepEqual(R.getLooked('v1'), []);

// 2. Other languages: lowercased, punctuation dropped; kept once, newest last.
assert.equal(R.lookedKey('Hello,', false), 'hello');
R.addLooked('v2', 'Went', false);
R.addLooked('v2', 'there', false);
R.addLooked('v2', 'went', false);
assert.deepEqual(R.getLooked('v2'), ['there', 'went']);
assert.equal(R.lookedKey("Don't", false), "don't"); // the apostrophe stays: the watch page keys the same raw word

// 3. Japanese with the dictionary: kept in dictionary form, so the watch page finds
// the word again conjugated differently (頼まれた while reading, 頼む on screen).
assert.equal(await R.loadJa(), true);
assert.equal(R.lookedKey('頼まれた', true), '頼む');
assert.equal(R.lookedKey('食べました', true), '食べる');
assert.equal(R.lookedKey('食べさせられた', true), '食べる');
assert.equal(R.lookedKey('勉強させて', true), '勉強する');
assert.equal(R.lookedKey('付き合って', true), '付き合う');
assert.equal(R.lookedKey('お茶を', true), 'お茶');
R.addLooked('v1', '頼まれた', true);
R.addLooked('v1', '古本屋に', true);
const keys = new Set(R.getLooked('v1'));
const onScreen = R.getWordTokens(R.tokenizeText('友達に頼むから、古本屋で待ってて。')).filter(w => keys.has(R.lookedKey(w.value, true))).map(w => w.value);
assert.deepEqual(onScreen, ['頼むから', '古本屋で']);

// 4. Capped per video; forgetting a video leaves the others.
for (let i = 0; i < 520; i++) R.addLooked('v3', `w${i}`, false);
assert.equal(R.getLooked('v3').length, 500);
assert.equal(R.getLooked('v3')[0], 'w20');
R.forgetLooked('v3');
assert.deepEqual(R.getLooked('v3'), []);
assert.deepEqual(R.getLooked('v2'), ['there', 'went']);

// 5. Broken storage reads as empty, never throws.
store.set('linguaclip_read_looked', '{oops');
assert.deepEqual(R.getLooked('v1'), []);
store.set('linguaclip_read_looked', JSON.stringify({ v1: 'nope' }));
assert.deepEqual(R.getLooked('v1'), []);

// 5b. Meanings: only for words on the list, under the same key, cut to 40 chars; words
// that fell off the list lose theirs; bad data reads as none.
store.delete('linguaclip_read_looked');
R.addLooked('g1', '頼まれた', true);
R.setGloss('g1', '頼まれた', true, '请求，拜托，委托');
R.setGloss('g1', '食べる', true, '吃'); // never looked up here: not kept
assert.deepEqual(R.getGloss('g1'), { '頼む': '请求，拜托，委托' });
R.addLooked('g1', 'x', false);
R.setGloss('g1', 'X', false, 'a'.repeat(60));
assert.equal(R.getGloss('g1').x, 'a'.repeat(40) + '…');
store.set('linguaclip_read_looked', JSON.stringify({ g1: ['x'] })); // 頼む fell off the list
R.setGloss('g1', 'x', false, 'b');
assert.deepEqual(R.getGloss('g1'), { x: 'b' });
store.set('linguaclip_read_gloss', JSON.stringify({ g1: { x: 3, y: 'ok' } }));
assert.deepEqual(R.getGloss('g1'), { y: 'ok' });

// 5c. Reading place: bad data is the top; forgetting a video clears words, meanings and place.
R.setReadPos('g1', 192.5);
assert.equal(R.getReadPos('g1'), 192.5);
store.set('linguaclip_read_pos', JSON.stringify({ g1: 'soon', g2: -3 }));
assert.equal(R.getReadPos('g1'), 0);
assert.equal(R.getReadPos('g2'), 0);
R.setReadPos('g1', 12);
R.forgetLooked('g1');
assert.equal(R.getReadPos('g1'), 0);
assert.deepEqual(R.getGloss('g1'), {});
assert.deepEqual(R.getLooked('g1'), []);

// 6. AI answers: wrong length throws (batch retry); a non-string line is just missing.
assert.deepEqual(R.parseTransResponse('{"lines":["一","  二 "]}', 2), ['一', '二']);
assert.deepEqual(R.parseTransResponse('```json\n{"lines":["一",3]}\n```', 2), ['一', null]);
assert.throws(() => R.parseTransResponse('{"lines":["一"]}', 2));
assert.throws(() => R.parseTransResponse('sorry', 2));

// 7. The cache only counts for the same subtitles, target language and line count.
const file = JSON.stringify({ v: 1, srt: 'abc', to: 'zh', lines: ['一', null] });
assert.deepEqual(R.parseTransCache(file, 'abc', 'zh', 2), ['一', null]);
assert.equal(R.parseTransCache(file, 'abc', 'en', 2), null);
assert.equal(R.parseTransCache(file, 'xyz', 'zh', 2), null);
assert.equal(R.parseTransCache(file, 'abc', 'zh', 3), null);
assert.equal(R.parseTransCache('{bad', 'abc', 'zh', 2), null);

// 8. The job: translations land by index; a failed batch stays null (not ""), and
// the next run asks only for what is missing. Saved to the cache.
const answer = n => ({ ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ lines: Array.from({ length: n }, (_, i) => `译${i}`) }) } }] }) });
const texts = ['a b', 'c d', 'e f'];
let calls = 0;
globalThis.__fetch = async (_url, init) => {
  calls++;
  const n = (JSON.parse(init.body).messages[0].content.match(/^\d+\t/gm) ?? []).length;
  return answer(n);
};
const got = await R.prepareTrans('t1', texts, 'zh');
assert.deepEqual(got, ['译0', '译1', '译2']);
assert.ok(globalThis.__writes.includes('t1.trans'));
calls = 0;
assert.deepEqual(await R.prepareTrans('t1', texts, 'zh'), ['译0', '译1', '译2']);
assert.equal(calls, 0); // all from the cache

globalThis.__fetch = async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => '' });
assert.deepEqual(await R.prepareTrans('t2', texts, 'zh'), [null, null, null]);
assert.ok(!globalThis.__writes.includes('t2.trans')); // nothing came back: nothing saved

// 9. Deleting the video mid-job: nothing is written after the cancel.
let release;
globalThis.__fetch = (_u, init) => new Promise(r => { release = () => r(answer((JSON.parse(init.body).messages[0].content.match(/^\d+\t/gm) ?? []).length)); });
globalThis.__writes.length = 0;
const running = R.prepareTrans('t3', texts, 'zh');
await new Promise(r => setTimeout(r, 20));
await R.cancelTrans('t3');
release();
await running;
assert.ok(!globalThis.__writes.includes('t3.trans'));

console.log('reader: all checks passed');
