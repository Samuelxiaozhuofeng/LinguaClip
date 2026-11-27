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
  stdin: {
    contents: `
      export * from './mobile/phoneWays';
      export * from './mobile/resumePos';
      export { setWatchPos, forgetWatchPos, setLastWay, savePracticeConfig } from './utils/storage';
      export { syncAudioAvail, hasPlayableAudio, isLocalAudioPath, isPlayableAudioUrl } from './mobile/audioAvail';
    `,
    resolveDir: '.',
    loader: 'ts',
  },
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

// 8. resumeSecOf: phone watch_pos wins; else desktop currentSectionIndex / currentSubtitleIndex
store = {};
W.savePracticeConfig({ sectionLength: 4, clozeLevel: 'full' });
const multiSecLines = [
  // Section 0: [0, 240)
  { id: 1, startTime: 2.0, endTime: 5.0, text: 'S0 L0' },
  { id: 2, startTime: 10.5, endTime: 14.0, text: 'S0 L1' },
  { id: 3, startTime: 120.0, endTime: 125.0, text: 'S0 L2' },
  // Section 1: [240, 480)
  { id: 4, startTime: 245.0, endTime: 250.0, text: 'S1 L0' },
  { id: 5, startTime: 260.25, endTime: 265.0, text: 'S1 L1' },
  { id: 6, startTime: 300.0, endTime: 305.0, text: 'S1 L2' },
];
const mkRec = (id, extra = {}) => ({
  id, displayName: id, videoFileName: `${id}.mp4`, subtitleFileName: `${id}.srt`, subtitleText: '',
  totalSubtitles: multiSecLines.length, currentSubtitleIndex: 0, currentSectionIndex: 0,
  completionRate: 0, dateAdded: 1, lastPracticed: 1, totalPracticeTime: 0, ...extra,
});
assert.equal(W.resumeSecOf(mkRec('r0'), multiSecLines), 0, 'brand new record resumes at 0');
assert.equal(
  W.resumeSecOf(mkRec('r1', { currentSectionIndex: 0, currentSubtitleIndex: 2 }), multiSecLines),
  120.0,
  'section 0 line 2 resolves to 120.0s',
);
assert.equal(
  W.resumeSecOf(mkRec('r2', { currentSectionIndex: 1, currentSubtitleIndex: 1 }), multiSecLines),
  260.25,
  'section 1 line 1 resolves to 260.25s (in-section index)',
);
assert.equal(
  W.resumeSecOf(mkRec('r2u', { currentSectionIndex: 1, currentSubtitleIndex: 1 }), [...multiSecLines].reverse()),
  260.25,
  'unsorted lines still resolve accurately',
);
assert.equal(
  W.resumeSecOf(mkRec('r3', { currentSectionIndex: 99, currentSubtitleIndex: 99 }), multiSecLines),
  300.0,
  'out-of-range indices clamp to last line of last section',
);
assert.equal(
  W.resumeSecOf(mkRec('r4', { currentSectionIndex: 1, currentSubtitleIndex: 1, completionRate: 100 }), multiSecLines),
  0,
  'completed desktop record resumes from 0 when watch_pos is empty',
);
W.setWatchPos('r2', 11.0);
assert.equal(
  W.resumeSecOf(mkRec('r2', { currentSectionIndex: 1, currentSubtitleIndex: 1 }), multiSecLines),
  11.0,
  'phone watch_pos > 0 wins over desktop indices',
);
W.setWatchPos('r2', 0);
assert.equal(
  W.resumeSecOf(mkRec('r2', { currentSectionIndex: 1, currentSubtitleIndex: 1 }), multiSecLines),
  0,
  'explicitly stored watch_pos = 0 wins over desktop indices',
);
W.forgetWatchPos('r2');
assert.equal(
  W.resumeSecOf(mkRec('r2', { currentSectionIndex: 1, currentSubtitleIndex: 1 }), multiSecLines),
  260.25,
  'absent watch_pos after forget falls back to desktop indices',
);
assert.equal(W.resumeSecOf(mkRec('r5', { currentSectionIndex: 1, currentSubtitleIndex: 1 }), []), 0);

// 9. resumeWayOf: phone last way wins; else desktop linguaclip_last_way mapped with disabled-way fallback
store = {};
W.setLastWay('d-all', 'all');
W.setLastWay('d-custom', 'custom');
W.setLastWay('d-read', 'read');
W.setLastWay('d-watch', 'watch');
assert.equal(W.resumeWayOf(mkRec('d-all')), 'dict');
assert.equal(W.resumeWayOf(mkRec('d-custom')), 'custom');
assert.equal(W.resumeWayOf(mkRec('d-read')), 'read');
assert.equal(W.resumeWayOf(mkRec('d-watch')), 'listen');
assert.equal(W.resumeWayOf(mkRec('d-none')), 'listen');

// Disabling custom falls back to dict; disabling read falls back to listen
W.setWayOn('custom', false);
W.setWayOn('read', false);
assert.equal(W.resumeWayOf(mkRec('d-custom')), 'dict', 'desktop custom falls back to dict when custom is off');
assert.equal(W.resumeWayOf(mkRec('d-read')), 'listen', 'desktop read falls back to listen when read is off');

// Phone last way overrides desktop last way, and disabled phone way falls back to listen
W.setWayOn('read', true);
W.setPhoneLastWay('d-all', 'read');
assert.equal(W.resumeWayOf(mkRec('d-all')), 'read', 'phone last way overrides desktop last way');
W.setWayOn('read', false);
assert.equal(W.resumeWayOf(mkRec('d-all')), 'listen', 'disabled phone way falls back to listen');

// 10. audioAvail pure checks (web & android)
assert.equal(W.isPlayableAudioUrl('https://example.com/a.mp3'), true);
assert.equal(W.isPlayableAudioUrl('/starter/en.mp3'), true);
assert.equal(W.isPlayableAudioUrl('data:audio/wav;base64,AA=='), true);
assert.equal(W.isPlayableAudioUrl('/Users/alice/video.mp4'), false);
assert.equal(W.isLocalAudioPath('/Users/alice/video.mp4'), true);
assert.equal(W.isLocalAudioPath('https://example.com/a.mp3'), false);
assert.equal(W.syncAudioAvail({ id: 'a1', videoPath: '' }, { android: false }), false);
assert.equal(W.syncAudioAvail({ id: 'a2', videoPath: 'https://x/a.mp3' }, { android: false }), true);
assert.equal(W.syncAudioAvail({ id: 'a3', videoPath: '/Users/x/a.mp4' }, { android: false }), false, 'desktop path not playable on web');
assert.equal(W.syncAudioAvail({ id: 'a4', videoPath: 'blob:b1' }, { android: false, haveBlobs: new Set(['b1']) }), true);
assert.equal(W.syncAudioAvail({ id: 'a5', videoPath: 'blob:b2' }, { android: false, haveBlobs: new Set(['b1']) }), false);
assert.equal(W.syncAudioAvail({ id: 'a6', videoPath: 'blob:b1' }, { android: true }), false, 'PWA blob not playable on Android');
assert.equal(W.syncAudioAvail({ id: 'a7', videoPath: '/data/media/a7.m4a' }, { android: true, missingAndroid: new Set(['a7']) }), false);
assert.equal(W.syncAudioAvail({ id: 'a8', videoPath: '/data/media/a8.m4a' }, { android: true, missingAndroid: new Set() }), true);
assert.equal(W.hasPlayableAudio({ id: 'a9', videoPath: '/data/media/a9.m4a', importJob: { stage: 'cloud', source: 'x', error: 'audio:reimport' } }, { android: true }), false);

// 11. utils/today.ts setPlayingProbe export sanity check
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
