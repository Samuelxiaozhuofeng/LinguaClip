/**
 * Checks in-place study-way switching and slow-replay helpers (utils/studyWays.ts,
 * docs/watch.md「页内切换练法与重听自动放慢」).
 * Run with: node test-study-ways.mjs
 */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const store = {};
globalThis.localStorage = {
  getItem: k => store[k] ?? null,
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; },
};

const out = join(tmpdir(), `study-ways-${process.pid}.mjs`);
await build({
  stdin: { contents: "export * from './utils/studyWays'; export { lastWayName } from './utils/lastWayCard';", resolveDir: '.', loader: 'ts' },
  bundle: true,
  format: 'esm',
  outfile: out,
  platform: 'node',
  logLevel: 'error',
  plugins: [{
    name: 'stub-tauri',
    setup(b) {
      b.onResolve({ filter: /^@tauri-apps\// }, a => ({ path: a.path, namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        contents: 'export const convertFileSrc = p => p, invoke = async () => {}, homeDir = async () => "", join = async (...p) => p.join("/"), getCurrentWebview = () => ({}), getCurrentWindow = () => ({}), listen = async () => () => {}, open = async () => null, save = async () => null, openUrl = async () => {}, revealItemInDir = async () => {}, exists = async () => false, readFile = async () => new Uint8Array(), readTextFile = async () => "", check = async () => null, relaunch = async () => {}, getVersion = async () => "0.0.0";',
      }));
    },
  }],
});

const { waysForRecord, sectionSubAt, defaultChoiceForNew, replayRate, SLOW_REPLAY_RATE, lastWayName } = await import(out);

// 1. waysForRecord: regular video vs podcast vs no Pro reader.
const video = { videoPath: '/a.mp4', videoFileName: 'a.mp4' };
const pod = { videoPath: '/ep.mp3', videoFileName: 'ep.mp3', podcast: { show: 'S', feed: 'f', guid: 'g', name: 'ep' } };
const audio = { videoPath: '/talk.m4a', videoFileName: 'talk.m4a' };

assert.deepEqual(waysForRecord(video, true), ['read', 'watch', 'blur', 'dict'], 'video with reader gets all 4 ways');
assert.deepEqual(waysForRecord(video, false), ['watch', 'blur', 'dict'], 'video without reader omits read');
assert.deepEqual(waysForRecord(pod, true), ['watch', 'blur', 'dict'], 'podcast omits read even when reader exists');
assert.deepEqual(waysForRecord(pod, false), ['watch', 'blur', 'dict'], 'podcast without reader keeps 3 ways');

// 2. sectionSubAt: cross-section, line start, mid-line, gap, leading silence, empty subtitles, unsorted input.
assert.deepEqual(sectionSubAt([], 42, 4), { sectionIndex: 0, subtitleIndex: 0 }, 'empty subtitles');

const subs = [
  { id: 1, startTime: 5, endTime: 10, text: 's0 line 0' },
  { id: 2, startTime: 30, endTime: 35, text: 's0 line 1' },
  { id: 3, startTime: 65, endTime: 70, text: 's1 line 0' },
  { id: 4, startTime: 90, endTime: 95, text: 's1 line 1' },
  { id: 5, startTime: 125, endTime: 130, text: 's2 line 0' },
];
// 1-minute sections: [0..60) -> ids 1,2; [60..120) -> ids 3,4; [120..180) -> id 5.
assert.deepEqual(sectionSubAt(subs, 0, 1), { sectionIndex: 0, subtitleIndex: 0 }, 'leading silence -> first line');
assert.deepEqual(sectionSubAt(subs, 2.5, 1), { sectionIndex: 0, subtitleIndex: 0 }, 'still before first line -> first line');
assert.deepEqual(sectionSubAt(subs, 5, 1), { sectionIndex: 0, subtitleIndex: 0 }, 'exact line start');
assert.deepEqual(sectionSubAt(subs, 7.2, 1), { sectionIndex: 0, subtitleIndex: 0 }, 'mid-sentence stays on same line');
assert.deepEqual(sectionSubAt(subs, 20, 1), { sectionIndex: 0, subtitleIndex: 0 }, 'gap after line 0 stays on line 0');
assert.deepEqual(sectionSubAt(subs, 32, 1), { sectionIndex: 0, subtitleIndex: 1 }, 'mid-line 1 in section 0');
assert.deepEqual(sectionSubAt(subs, 65, 1), { sectionIndex: 1, subtitleIndex: 0 }, 'section 1 exact start');
assert.deepEqual(sectionSubAt(subs, 92.5, 1), { sectionIndex: 1, subtitleIndex: 1 }, 'section 1 mid-line');
assert.deepEqual(sectionSubAt(subs, 128, 1), { sectionIndex: 2, subtitleIndex: 0 }, 'section 2 mid-line');
assert.deepEqual(sectionSubAt(subs, 999, 1), { sectionIndex: 2, subtitleIndex: 0 }, 'past end -> last line');
assert.deepEqual(sectionSubAt([...subs].reverse(), 92.5, 1), { sectionIndex: 1, subtitleIndex: 1 }, 'unsorted subtitles are sorted first');
assert.deepEqual(sectionSubAt(subs, 92.5, 0), { sectionIndex: 0, subtitleIndex: 3 }, 'sectionLength=0 puts all lines in section 0');

// 3. defaultChoiceForNew: video watch/all, audio listen/watch fallback, podcast listen/watch.
assert.deepEqual(defaultChoiceForNew(video, true, true), { kind: 'watch' }, 'new video defaults to watch when chosenWatch=true');
assert.deepEqual(defaultChoiceForNew(video, true, false), { kind: 'watch' }, 'new video defaults to watch without Listen');
assert.deepEqual(defaultChoiceForNew(video, false, true), { kind: 'all' }, 'new video follows explicit chosenWatch=false');
assert.deepEqual(defaultChoiceForNew(audio, true, true), { kind: 'listen' }, 'audio defaults to listen when Listen exists');
assert.deepEqual(defaultChoiceForNew(audio, false, true), { kind: 'listen' }, 'audio still defaults to listen even when chosenWatch=false');
assert.deepEqual(defaultChoiceForNew(audio, false, false), { kind: 'watch' }, 'audio falls back to watch when Listen absent');
assert.deepEqual(defaultChoiceForNew(pod, false, true), { kind: 'listen' }, 'podcast defaults to listen when Listen exists');
assert.deepEqual(defaultChoiceForNew(pod, true, false), { kind: 'watch' }, 'podcast falls back to watch when Listen absent');

// 4. replayRate: 1st replay normal, 2nd+ replay 0.75x, never speed up <=0.75x, disabled stays normal.
assert.equal(SLOW_REPLAY_RATE, 0.75);
assert.deepEqual(replayRate(1.0, 0, true), { rate: 1.0, slowed: false }, 'initial play at base speed');
assert.deepEqual(replayRate(1.0, 1, true), { rate: 1.0, slowed: false }, '1st manual replay stays at base speed');
assert.deepEqual(replayRate(1.0, 2, true), { rate: 0.75, slowed: true }, '2nd manual replay slows to 0.75x');
assert.deepEqual(replayRate(1.5, 4, true), { rate: 0.75, slowed: true }, '3rd+ manual replay from 1.5x slows to 0.75x');
assert.deepEqual(replayRate(0.75, 2, true), { rate: 0.75, slowed: false }, 'base speed 0.75x is not flagged slowed');
assert.deepEqual(replayRate(0.5, 3, true), { rate: 0.5, slowed: false }, 'base speed 0.5x is never sped up');
assert.deepEqual(replayRate(1.0, 2, false), { rate: 1.0, slowed: false }, 'disabled flag keeps base speed');
assert.deepEqual(replayRate(1.25, 5, false), { rate: 1.25, slowed: false }, 'disabled flag keeps faster base speed');

// 5. lastWayName matches defaultChoiceForNew when a record has never been started (way === null).
assert.equal(lastWayName(video, null), 'custom.watch', 'fresh video card label matches default Watch entry');
assert.equal(lastWayName(audio, null), 'custom.listen', 'fresh audio card label matches default Listen entry');
store.linguaclip_watch_prefs = JSON.stringify({ chosen: false });
assert.equal(lastWayName(video, null), 'home.dictate', 'when user chose dictation globally, fresh video card says dictate');
assert.equal(lastWayName(audio, null), 'custom.listen', 'audio still defaults to listen even when chosen=false');
assert.equal(lastWayName(video, 'watch'), 'custom.watch', 'explicit watch lastWay wins');
assert.equal(lastWayName(video, 'all'), 'home.dictate', 'explicit all lastWay wins');

console.log('test-study-ways: all passed');
