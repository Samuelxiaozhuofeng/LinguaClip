/**
 * M2.2 + W2 phone drill ways unit checks:
 * - drillCommon helpers (position resolution, nextHintIndex incl. Japanese chunks, sectionRangesOf,
 *   aroundOf, slotWidthEm, stripLookupPunct)
 * - useKeyboardInset visualViewport calculation (iOS overlay vs Android adjustResize vs pinch zoom)
 * - Cloze pickBlanks & Custom pickCustom integration
 * Run with: node mobile/test-ways-drill.mjs
 */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = join(tmpdir(), `mobile-ways-drill-${process.pid}.mjs`);
await build({
  stdin: {
    contents: [
      "export * from './mobile/ways/drillCommon';",
      "export { computeKeyboardInset, shouldRegisterKeyboardBackClose } from './mobile/ways/useKeyboardInset';",
      "export { pickBlanks } from './utils/aiDrills';",
      "export { pickCustom } from './utils/customPick';",
      "export { buildSections } from './utils/sections';",
      "export { loadJa } from './utils/japanese';",
    ].join('\n'),
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
          export const writeCacheText = async () => {};
          export const fetch = globalThis.fetch;`,
        resolveDir: process.cwd(),
      }));
    },
  }],
});

const {
  sortedLines,
  startIndexForSec,
  aroundOf,
  nextHintIndex,
  sectionRangesOf,
  sectionForLine,
  prevLineInSection,
  getSectionStats,
  recordSectionIndependent,
  recordSectionStuck,
  clearSectionStats,
  dictCorrectKind,
  hasAnyClozeInput,
  slotWidthEm,
  stripLookupPunct,
  computeKeyboardInset,
  shouldRegisterKeyboardBackClose,
  pickBlanks,
  pickCustom,
  buildSections,
  loadJa,
} = await import(out);

const sampleSrt = `1
00:00:01,000 --> 00:00:03,500
Hello world, I walked home.

2
00:00:04,000 --> 00:00:07,000
We arrived yesterday at the café.

3
00:00:08,000 --> 00:00:10,500
Yeah.
`;

// 1. Line sorting & startSec continuity (switching ways resumes on the same line)
const lines = sortedLines(sampleSrt);
assert.equal(lines.length, 3);
assert.equal(startIndexForSec(lines, 0), 0);
assert.equal(startIndexForSec(lines, 1.0), 0);
assert.equal(startIndexForSec(lines, 4.2), 1);
assert.equal(startIndexForSec(lines, 8.0), 2);
// Past EOF wraps back to 0.
assert.equal(startIndexForSec(lines, 10.4), 0);
assert.equal(startIndexForSec([], 5), 0);

// 2. Context around line (for WordSheet / BreakdownSheet)
assert.equal(aroundOf(lines, 0), 'We arrived yesterday at the café.');
assert.equal(aroundOf(lines, 1), 'Hello world, I walked home.\nYeah.');
assert.equal(aroundOf(lines, 2), 'We arrived yesterday at the café.');

// 3. nextHintIndex: skips already-right and already-hinted words
const line0 = lines[0].text; // Hello(0) world(1) I(2) walked(3) home(4)
assert.equal(nextHintIndex(line0, '', new Set(), true), 0);
assert.equal(nextHintIndex(line0, '', new Set([0]), true), 1);
assert.equal(nextHintIndex(line0, 'hello', new Set(), true), 1);
assert.equal(nextHintIndex(line0, 'hello world', new Set([2]), true), 3);
// Near miss is NOT right, so hint still offers it!
assert.equal(nextHintIndex(line0, 'hello world I walk home', new Set(), true), 3);
// All right -> -1
assert.equal(nextHintIndex(line0, 'hello world I walked home', new Set(), true), -1);

// 3b. nextHintIndex for Japanese chunks: skips already-right chunks (including 良い for いい)
assert.equal(await loadJa(), true);
const jaLine = '今日はいい天気ですね。'; // 今日は(0) いい(1) 天気ですね(2)
assert.equal(nextHintIndex(jaLine, '', new Set(), true), 0);
assert.equal(nextHintIndex(jaLine, 'きょうは', new Set(), true), 1);
assert.equal(nextHintIndex(jaLine, '今日は良い', new Set(), true), 2);
assert.equal(nextHintIndex(jaLine, '今日は良い天気ですね', new Set(), true), -1);

// 4. Section range mapping for dictation per-section summaries
const multiSecSrt = `1
00:00:05,000 --> 00:00:10,000
First line of section one.

2
00:00:30,000 --> 00:00:35,000
Second line of section one.

3
00:02:05,000 --> 00:02:10,000
First line of section two.

4
00:02:20,000 --> 00:02:25,000
Second line of section two.
`;
const multiLines = sortedLines(multiSecSrt);
const secs = buildSections(multiLines, 2); // 2-minute sections -> [0..2), [2..4)
const ranges = sectionRangesOf(multiLines, secs);
assert.equal(ranges.length, 2);
assert.deepEqual(ranges[0], { index: 0, startIdx: 0, endIdx: 2 });
assert.deepEqual(ranges[1], { index: 1, startIdx: 2, endIdx: 4 });
assert.equal(sectionForLine(ranges, 0)?.index, 0);
assert.equal(sectionForLine(ranges, 1)?.index, 0);
assert.equal(sectionForLine(ranges, 2)?.index, 1);
assert.equal(sectionForLine(ranges, 3)?.index, 1);

// 5. Slot widths & lookup punctuation stripping
assert.ok(slotWidthEm('a') >= 1.5);
assert.ok(slotWidthEm('supercalifragilisticexpialidocious') <= 9);
assert.ok(slotWidthEm('日本語') > slotWidthEm('cat'));
assert.equal(stripLookupPunct('"café,"'), 'café');
assert.equal(stripLookupPunct('don’t!'), 'don’t');

// 6. visualViewport keyboard inset calculation
// Overlay keyboard (iOS PWA): innerHeight=844, vv.height=500 -> 344
assert.equal(computeKeyboardInset(844, { height: 500, offsetTop: 0, scale: 1 }), 344);
// Android adjustResize: innerHeight=500, vv.height=500 -> 0 (flex container already shrank)
assert.equal(computeKeyboardInset(500, { height: 500, offsetTop: 0, scale: 1 }), 0);
// Pinch zoom: scale=1.5 -> 0
assert.equal(computeKeyboardInset(844, { height: 560, offsetTop: 0, scale: 1.5 }), 0);
// Small browser chrome jitter (<= 40px) -> 0
assert.equal(computeKeyboardInset(844, { height: 810, offsetTop: 0, scale: 1 }), 0);
// No visualViewport API (older WebView) -> 0
assert.equal(computeKeyboardInset(844, null), 0);

// 7. Cloze & Custom reuse checks
assert.deepEqual(pickBlanks([3, 1, 4, 0, 2], 5, 'easy'), [3, 1, 4]);
assert.deepEqual(pickBlanks([3, 1, 4, 0, 2], 5, 'medium'), [3, 1, 4]);
const pickedNoAi = pickCustom(lines, null, { minutes: 15, level: null, others: 'skip' }, 0, 'dictation');
assert.deepEqual(pickedNoAi?.practise, [0, 1], 'worthByRule skips single-word "Yeah."');
const pickedB1 = pickCustom(lines, ['A2', 'B1', 'x'], { minutes: 15, level: 'B1', others: 'skip' }, 0, 'dictation');
assert.deepEqual(pickedB1?.practise, [1], 'level B1 selects B1/B2 and skips A2 and x');

// 8. Independent vs helped-correct classification (wrong-then-right is NOT celebratory all-right)
assert.equal(dictCorrectKind({ everRevealed: false, usedHint: false, wrongTries: 0 }), 'independent');
assert.equal(dictCorrectKind({ everRevealed: false, usedHint: false, wrongTries: 1 }), 'wrong');
assert.equal(dictCorrectKind({ everRevealed: false, usedHint: false, wrongTries: 3 }), 'wrong');
assert.equal(dictCorrectKind({ everRevealed: false, usedHint: false, wrongTries: 0, alreadyStuck: true }), 'wrong');
assert.equal(dictCorrectKind({ everRevealed: false, usedHint: true, wrongTries: 0 }), 'hint');
assert.equal(dictCorrectKind({ everRevealed: true, usedHint: true, wrongTries: 2 }), 'reveal');

// 9. Prev stays inside current section & per-section stats do not bleed across sections
assert.equal(prevLineInSection(0, ranges[0]), null);
assert.equal(prevLineInSection(1, ranges[0]), 0);
assert.equal(prevLineInSection(2, ranges[1]), null, 'section 2 start cannot step back into section 1');
assert.equal(prevLineInSection(3, ranges[1]), 2);

let secStats = {};
secStats = recordSectionIndependent(secStats, 0, 1);
secStats = recordSectionStuck(secStats, 0, 2);
secStats = recordSectionIndependent(secStats, 0, 2); // already stuck in section 0 -> stays stuck
secStats = recordSectionIndependent(secStats, 1, 3);
secStats = recordSectionStuck(secStats, 1, 4);
assert.equal(getSectionStats(secStats, 0).independent.size, 1);
assert.equal(getSectionStats(secStats, 0).stuck.size, 1);
assert.equal(getSectionStats(secStats, 1).independent.size, 1);
assert.equal(getSectionStats(secStats, 1).stuck.size, 1);
// Retry section 1 clears ONLY section 1; section 0 stats remain intact.
secStats = clearSectionStats(secStats, 1);
assert.equal(getSectionStats(secStats, 0).independent.size, 1);
assert.equal(getSectionStats(secStats, 0).stuck.size, 1);
assert.equal(getSectionStats(secStats, 1).independent.size, 0);
assert.equal(getSectionStats(secStats, 1).stuck.size, 0);

// 10. Cloze requires at least one blank with non-whitespace input
assert.equal(hasAnyClozeInput([0, 2], {}), false);
assert.equal(hasAnyClozeInput([0, 2], { 0: '   ', 2: '\t' }), false);
assert.equal(hasAnyClozeInput([0, 2], { 1: 'ignored' }), false);
assert.equal(hasAnyClozeInput([0, 2], { 0: '', 2: 'home' }), true);

// 11. Keyboard back-close only registers when kbInset > 0 (never on focus alone)
assert.equal(shouldRegisterKeyboardBackClose(0), false);
assert.equal(shouldRegisterKeyboardBackClose(320), true);

// 12. Pure-kanji Japanese nextHintIndex respects lang='ja'
assert.equal(nextHintIndex('大丈夫。', 'だいじょうぶ', new Set(), true, 'ja'), -1);

console.log('mobile ways drill ok');
