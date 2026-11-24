/**
 * Unit checks for mobile/phoneWays.ts & utils/today.ts playing probe (Android M2.1):
 * way toggles (MAIN_WAYS cannot be disabled, MORE_WAYS toggle + subscribe), last-way fallback
 * when disabled, lineNumberAt / resolveLineStartSec, and setPlayingProbe behavior.
 * Run with: node mobile/test-phone-ways.mjs
 */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let store = {};
globalThis.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; },
};

const outWays = join(tmpdir(), `mobile-phone-ways-${process.pid}.mjs`);
await build({
  stdin: { contents: "export * from './mobile/phoneWays';", resolveDir: '.', loader: 'ts' },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: outWays,
  logLevel: 'error',
});
const W = await import(outWays);

// 1. Default state: all MORE_WAYS on, last way defaults to 'listen'
assert.deepEqual(W.getWaysOff(), []);
assert.deepEqual(W.moreWaysOn(), ['blur', 'cloze', 'custom', 'read']);
assert.equal(W.isWayOn('listen'), true);
assert.equal(W.isWayOn('dict'), true);
assert.equal(W.getPhoneLastWay('v1'), 'listen');

// 2. MAIN_WAYS cannot be switched off
let hits = 0;
const unsub = W.subscribeWays(() => { hits += 1; });
W.setWayOn('listen', false);
W.setWayOn('dict', false);
assert.equal(W.isWayOn('listen'), true);
assert.equal(W.isWayOn('dict'), true);
assert.equal(hits, 0);

// 3. MORE_WAYS switch off/on notifies subscribers and persists under linguaclip_phone_ways_off
W.setWayOn('cloze', false);
assert.equal(hits, 1);
assert.equal(W.isWayOn('cloze'), false);
assert.deepEqual(W.moreWaysOn(), ['blur', 'custom', 'read']);
assert.deepEqual(JSON.parse(store.linguaclip_phone_ways_off), ['cloze']);

// 4. Last way persists and falls back to 'listen' when that way is switched off
W.setPhoneLastWay('v1', 'cloze');
assert.equal(W.getPhoneLastWay('v1'), 'listen', 'disabled way falls back to listen');
W.setWayOn('cloze', true);
assert.equal(W.getPhoneLastWay('v1'), 'cloze', 're-enabling restores saved last way');
W.setPhoneLastWay('v1', 'dict');
assert.equal(W.getPhoneLastWay('v1'), 'dict');
W.forgetPhoneLastWay('v1');
assert.equal(W.getPhoneLastWay('v1'), 'listen');

// 5. Turning all MORE_WAYS off yields empty moreWaysOn()
for (const w of ['blur', 'cloze', 'custom', 'read']) W.setWayOn(w, false);
assert.deepEqual(W.moreWaysOn(), []);
unsub();

// 6. Broken storage does not throw
store.linguaclip_phone_ways_off = '{broken';
store.linguaclip_phone_last_way = '{broken';
assert.deepEqual(W.getWaysOff(), []);
assert.equal(W.getPhoneLastWay('v2'), 'listen');

// 7. lineNumberAt & resolveLineStartSec
const lines = [
  { id: 1, startTime: 1.0, endTime: 3.0, text: 'One' },
  { id: 2, startTime: 3.5, endTime: 6.0, text: 'Two' },
  { id: 3, startTime: 6.5, endTime: 10.0, text: 'Three' },
];
assert.equal(W.lineNumberAt([], 5), 0);
assert.equal(W.lineNumberAt(lines, 0), 1, 'before first line maps to line 1');
assert.equal(W.lineNumberAt(lines, 1.0), 1);
assert.equal(W.lineNumberAt(lines, 4.2), 2);
assert.equal(W.lineNumberAt(lines, 6.2), 2, 'gap between line 2 and 3 stays on line 2');
assert.equal(W.lineNumberAt(lines, 7.0), 3);

assert.equal(W.resolveLineStartSec([], 5), 0);
assert.equal(W.resolveLineStartSec(lines, 0), 0);
assert.equal(W.resolveLineStartSec(lines, 2.0), 1.0);
assert.equal(W.resolveLineStartSec(lines, 4.8), 3.5);
assert.equal(W.resolveLineStartSec(lines, 6.5), 6.5, 'exact start of last line stays on last line');
assert.equal(W.resolveLineStartSec(lines, 8.0), 6.5, 'middle of last line stays on last line');
assert.equal(W.resolveLineStartSec(lines, 9.8), 0, 'within 0.5s of EOF wraps to 0');

// 8. utils/today.ts setPlayingProbe export sanity check
const outToday = join(tmpdir(), `mobile-today-probe-${process.pid}.mjs`);
await build({
  entryPoints: ['utils/today.ts'],
  bundle: true,
  format: 'esm',
  outfile: outToday,
  logLevel: 'error',
});
const T = await import(outToday);
assert.equal(typeof T.setPlayingProbe, 'function');
T.setPlayingProbe(() => true);
T.setPlayingProbe(null);

console.log('mobile phone-ways ok');
