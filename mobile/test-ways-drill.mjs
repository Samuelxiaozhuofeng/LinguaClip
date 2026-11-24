/**
 * M2.2 phone drill ways unit checks:
 * - drillCommon helpers (position resolution, nextHintIndex, aroundOf, slotWidthEm, stripLookupPunct)
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
      "export { computeKeyboardInset } from './mobile/ways/useKeyboardInset';",
      "export { pickBlanks } from './utils/aiDrills';",
      "export { pickCustom } from './utils/customPick';",
    ].join('\n'),
    resolveDir: '.',
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: out,
  logLevel: 'error',
});

const {
  sortedLines,
  startIndexForSec,
  aroundOf,
  nextHintIndex,
  slotWidthEm,
  stripLookupPunct,
  computeKeyboardInset,
  pickBlanks,
  pickCustom,
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

// 4. Slot widths & lookup punctuation stripping
assert.ok(slotWidthEm('a') >= 1.5);
assert.ok(slotWidthEm('supercalifragilisticexpialidocious') <= 9);
assert.ok(slotWidthEm('日本語') > slotWidthEm('cat'));
assert.equal(stripLookupPunct('"café,"'), 'café');
assert.equal(stripLookupPunct('don’t!'), 'don’t');

// 5. visualViewport keyboard inset calculation
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

// 6. Cloze & Custom reuse checks
assert.deepEqual(pickBlanks([3, 1, 4, 0, 2], 5, 'easy'), [3, 1, 4]);
assert.deepEqual(pickBlanks([3, 1, 4, 0, 2], 5, 'medium'), [3, 1, 4]);
const pickedNoAi = pickCustom(lines, null, { minutes: 15, level: null, others: 'skip' }, 0, 'dictation');
assert.deepEqual(pickedNoAi?.practise, [0, 1], 'worthByRule skips single-word "Yeah."');
const pickedB1 = pickCustom(lines, ['A2', 'B1', 'x'], { minutes: 15, level: 'B1', others: 'skip' }, 0, 'dictation');
assert.deepEqual(pickedB1?.practise, [1], 'level B1 selects B1/B2 and skips A2 and x');

console.log('mobile ways drill ok');
