/**
 * Checks custom practice: picking lines (utils/customPick.ts) and reading the
 * AI's level answers / cache (utils/levelPrep.ts).
 * Run with: node test-custom.mjs
 *
 * Bundles the real modules (Tauri stubbed) instead of re-typing the logic.
 */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = join(tmpdir(), `custom-${process.pid}.mjs`);
await build({
  stdin: { contents: "export * from './utils/customPick'; export * from './utils/levelPrep';", resolveDir: '.', loader: 'ts' },
  bundle: true,
  format: 'esm',
  outfile: out,
  plugins: [{
    name: 'stub-tauri',
    setup(b) {
      b.onResolve({ filter: /^@tauri-apps\/plugin-http$/ }, a => ({ path: a.path, namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, a => ({
        contents: 'export const fetch = globalThis.fetch;',
      }));
    },
  }],
  logLevel: 'error',
});
const { pickCustom, worthByRule, lineCost, parseCustomConfig, parseLevelResponse, parseLevelCache, levelPrompt } = await import(out);

// 10 lines, each 2 s long, starting every 10 s. Dictation cost per line = 2*3+4 = 10 s.
const subs = Array.from({ length: 10 }, (_, i) => ({ startTime: i * 10, endTime: i * 10 + 2, text: `line number ${i} here` }));
const cfg = (o = {}) => ({ minutes: 1, level: 'B1', others: 'skip', ...o });

// 1. Junk rule.
assert.equal(worthByRule('Yeah.'), false);
assert.equal(worthByRule('[Music]'), false);
assert.equal(worthByRule('♪ la ♪'), false);
assert.equal(worthByRule('Mike!'), false);
assert.equal(worthByRule('I told you so.'), true);
assert.equal(worthByRule('[laughs] Oh come on'), true);
assert.equal(worthByRule('はい'), false);
assert.equal(worthByRule('初めまして'), true);
assert.equal(lineCost(2, 'dictation'), 10);

// 2. Level band: B1 takes B1 and B2, not A2 or C1; 'x' never; null falls back to the rule.
{
  const labels = ['A2', 'B1', 'B2', 'C1', 'x', null, 'B1', 'B1', 'B1', 'B1'];
  const p = pickCustom(subs, labels, cfg({ minutes: 100 }), 0, 'dictation');
  assert.deepEqual(p.practise, [1, 2, 5, 6, 7, 8, 9]);
  assert.deepEqual(p.lines, p.practise, 'skip mode plays only practised lines');
}

// 3. Budget: 1 minute at 10 s a line = 6 lines, from the saved position.
{
  const p = pickCustom(subs, null, cfg({ level: null }), 30, 'dictation');
  assert.deepEqual(p.practise, [3, 4, 5, 6, 7, 8]);
}

// 4. Play mode: watched lines cost their real time (start to next start) and are
//    kept between practised ones; trailing watched lines are dropped.
{
  const labels = ['B1', 'x', 'x', 'B1', 'x', 'x', 'x', 'x', 'x', 'x'];
  const p = pickCustom(subs, labels, cfg({ minutes: 100, others: 'play' }), 0, 'dictation');
  assert.deepEqual(p.practise, [0, 3]);
  assert.deepEqual(p.lines, [0, 1, 2, 3]);
  // 1 minute: line0 10 + line1 10 + line2 10 + line3 10 + 4..5 watch 20 = 60 → stops, last practised is 3.
  const q = pickCustom(subs, ['B1', 'x', 'x', 'B1', 'x', 'x', 'B1', 'B1', 'B1', 'B1'], cfg({ others: 'play' }), 0, 'dictation');
  assert.deepEqual(q.practise, [0, 3]);
  assert.deepEqual(q.lines, [0, 1, 2, 3]);
}

// 5. Nothing left after the position: wrap to the start. Nothing anywhere: null.
{
  const labels = ['B1', 'x', 'x', 'x', 'x', 'x', 'x', 'x', 'x', 'x'];
  assert.deepEqual(pickCustom(subs, labels, cfg(), 50, 'dictation').practise, [0]);
  assert.equal(pickCustom(subs, subs.map(() => 'x'), cfg(), 0, 'dictation'), null);
  assert.equal(pickCustom(subs, subs.map(() => 'C2'), cfg(), 0, 'dictation'), null);
  // Position past the end: from the start.
  assert.deepEqual(pickCustom(subs, labels, cfg(), 9999, 'dictation').practise, [0]);
}

// 6. Config parsing: junk falls back to defaults.
assert.deepEqual(parseCustomConfig(undefined), { on: false, minutes: 15, level: null, others: 'play' });
assert.deepEqual(parseCustomConfig({ on: true, minutes: 20, level: 'C1', others: 'skip' }), { on: true, minutes: 20, level: 'C1', others: 'skip' });
assert.deepEqual(parseCustomConfig({ on: 1, minutes: 7, level: 'b1', others: 'x' }), { on: false, minutes: 15, level: null, others: 'play' });

// 7. AI answers: wrong length throws (batch retry); a bad code nulls one line.
assert.deepEqual(parseLevelResponse('```json\n{"lines":["B1","x","Z9"]}\n```', 3), ['B1', 'x', null]);
assert.throws(() => parseLevelResponse('{"lines":["B1"]}', 2));
assert.throws(() => parseLevelResponse('sorry', 1));

// 8. Cache: other subtitles (hash) or other line count = no cache.
{
  const raw = JSON.stringify({ v: 1, srt: 'abc', lines: ['B1', null, 'q'] });
  assert.deepEqual(parseLevelCache(raw, 'abc', 3), ['B1', null, null]);
  assert.equal(parseLevelCache(raw, 'zzz', 3), null);
  assert.equal(parseLevelCache(raw, 'abc', 4), null);
  assert.equal(parseLevelCache('{broken', 'abc', 3), null);
}

// 9. The prompt lists every line with its index, length and pace.
{
  const p = levelPrompt([{ text: 'Hello there friend', startTime: 0, endTime: 1.5 }, { text: '初めまして', startTime: 2, endTime: 3 }]);
  assert.match(p, /0\t1\.5 秒\t2\.0 词\/秒\tHello there friend/);
  assert.match(p, /1\t1\.0 秒\t5\.0 字\/秒\t初めまして/);
  assert.match(p, /长度必须等于 2/);
}

// 10. A click on the card goes on the last way (components/CustomPanel.tsx resumeChoice,
// docs/watch.md 点视频直接开播), including reading. `@pro` is a stub whose Reader / Listen
// are switched per case, so "no Pro reader" is checked too.
{
  const store = {};
  globalThis.localStorage = { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
  globalThis.__pro = { Reader: null, Listen: null };
  const out2 = join(tmpdir(), `custom-resume-${process.pid}.mjs`);
  await build({
    stdin: { contents: "export { resumeChoice } from './components/CustomPanel'; export { getLastWay, setLastWay } from './utils/storage';", resolveDir: '.', loader: 'ts' },
    bundle: true, format: 'esm', outfile: out2, platform: 'node', jsx: 'automatic', logLevel: 'error',
    plugins: [{
      name: 'stubs',
      setup(b) {
        b.onResolve({ filter: /^@pro$|^@tauri-apps\/plugin-http$/ }, a => ({ path: a.path, namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, a => ({
          contents: a.path === '@pro'
            ? 'export const Reader = globalThis.__pro.Reader, Listen = globalThis.__pro.Listen, cancelTrans = async () => {};'
            : 'export const fetch = globalThis.fetch;',
        }));
      },
    }],
  });
  const load = async (pro) => { globalThis.__pro = pro; return import(`${out2}?${Math.random()}`); };
  const rec = { id: 'v1', subtitleText: '1\n00:00:01,000 --> 00:00:02,000\nhi\n', videoPath: '/a.mp4' };
  const withReader = await load({ Reader: () => null, Listen: null });
  const { resumeChoice, getLastWay, setLastWay } = withReader;

  assert.equal(await resumeChoice(rec, 'dictation'), null, 'never started: the panel asks');
  setLastWay('v1', 'read');
  assert.equal(getLastWay('v1'), 'read', 'read is kept');
  assert.deepEqual(await resumeChoice(rec, 'dictation'), { kind: 'read', by: 'all' }, 'last read: reading again, the saved way to read');
  store.linguaclip_watch_prefs = JSON.stringify({ readBy: 'section' });
  assert.deepEqual(await resumeChoice(rec, 'dictation'), { kind: 'read', by: 'section' }, 'reads by section when that was chosen');
  assert.deepEqual(await resumeChoice(rec, 'dictation', true), { kind: 'all' }, '"practise with dictation / blur": section by section, not the reader');
  setLastWay('v1', 'watch');
  assert.deepEqual(await resumeChoice(rec, 'dictation'), { kind: 'watch' }, 'watch still watches');
  setLastWay('v1', 'all');
  assert.deepEqual(await resumeChoice(rec, 'dictation'), { kind: 'all' }, 'a practice picked after reading replaces read');
  store.linguaclip_last_way = JSON.stringify({ v1: 'bogus' });
  assert.equal(getLastWay('v1'), null, 'an unknown way = never started');

  const noReader = await load({ Reader: null, Listen: null });
  noReader.setLastWay('v1', 'read');
  assert.equal(await noReader.resumeChoice(rec, 'dictation'), null, 'last read but no Pro reader: the panel asks');
}

console.log('test-custom: all passed');
