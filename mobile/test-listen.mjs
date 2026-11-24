/**
 * Pure boundary state machine, loop/drill transitions, section-end stops, and lockscreen
 * mark sync tests for mobile/listenBoundaries.ts (M1.1).
 * Run with: node mobile/test-listen.mjs
 */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = join(tmpdir(), `mobile-listen-${process.pid}.mjs`);
await build({
  stdin: { contents: "export * from './mobile/listenBoundaries';", resolveDir: '.', loader: 'ts' },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: out,
  logLevel: 'error',
});

const {
  sectionEndOf,
  buildSectionStops,
  lineStopTime,
  evaluateWebBoundary,
  drillProgressFromLoops,
  resolveBgMarkLineId,
  mergeBgMarks,
} = await import(out);

const lines = [
  { id: 1, startTime: 0.0, endTime: 2.0, text: 'First sentence.' },
  { id: 2, startTime: 2.2, endTime: 4.5, text: 'Second sentence.' },
  { id: 3, startTime: 4.5, endTime: 7.0, text: 'Third sentence (section 2 start).' },
  { id: 4, startTime: 7.5, endTime: 10.0, text: 'Fourth sentence.' },
];

const sections = [
  { id: 1, label: 'Section 1', startTime: 0, endTime: 4.5, subtitleIndices: [], subtitles: [lines[0], lines[1]] },
  { id: 2, label: 'Section 2', startTime: 4.5, endTime: 10.0, subtitleIndices: [], subtitles: [lines[2], lines[3]] },
];
const sectionOf = new Map(sections.flatMap((s, i) => s.subtitles.map(l => [l.id, i])));

// 1. Section boundaries and stops
assert.equal(sectionEndOf(sections, 0), 4.5);
assert.equal(sectionEndOf(sections, 1), 10.0);
assert.deepEqual(buildSectionStops(sections), [4.5, 10.0]);
assert.equal(lineStopTime(lines[1], sections, sectionOf), 4.5);

// Overlapping last line of section 0 is clamped to section 1's startTime
const overlapSections = [
  { id: 1, label: 'S1', startTime: 0, endTime: 5, subtitleIndices: [], subtitles: [{ id: 10, startTime: 0, endTime: 5.2, text: 'A' }] },
  { id: 2, label: 'S2', startTime: 5, endTime: 10, subtitleIndices: [], subtitles: [{ id: 11, startTime: 5.0, endTime: 9.0, text: 'B' }] },
];
assert.equal(sectionEndOf(overlapSections, 0), 5.0);
assert.deepEqual(buildSectionStops(overlapSections), [5.0, 9.0]);

// 2. Edge-triggered section-end stop (no infinite loop after pullback)
const base = {
  lines,
  paused: false,
  holdTo: null,
  loop: null,
  stops: [4.5, 10.0],
  autoPause: false,
  heldBoundary: null,
};

// Before crossing: no trigger
assert.equal(evaluateWebBoundary({ ...base, before: 4.3, now: 4.49 }).kind, 'none');
// Already past boundary: edge-triggered, does NOT fire
assert.equal(evaluateWebBoundary({ ...base, before: 4.55, now: 4.7 }).kind, 'none');
// Paused: does NOT fire
assert.equal(evaluateWebBoundary({ ...base, paused: true, before: 4.45, now: 4.55 }).kind, 'none');

// Crossing 4.5s: triggers sectionEnd and pulls back 20ms to 4.48s (still inside section 0!)
const secHit = evaluateWebBoundary({ ...base, before: 4.46, now: 4.52 });
assert.equal(secHit.kind, 'sectionEnd');
assert.equal(secHit.stopTime, 4.5);
assert.ok(Math.abs(secHit.pullBack - 4.48) < 1e-6);

// Resuming from 4.48s with heldBoundary = 4.5s does NOT re-trigger sectionEnd (prevents infinite stop loop)
assert.equal(evaluateWebBoundary({ ...base, before: 4.48, now: 4.53, heldBoundary: 4.5 }).kind, 'none');

// Free through mode (stops = []): never triggers sectionEnd
assert.equal(evaluateWebBoundary({ ...base, stops: [], before: 4.46, now: 4.55 }).kind, 'none');

// 3. holdAt ("listen again" in peek) takes precedence over loop & stops
const holdHit = evaluateWebBoundary({
  ...base,
  holdTo: 2.0,
  loop: { start: 0, end: 2.0, remaining: 2, completedLoops: 0, gapMs: 1000 },
  before: 1.95,
  now: 2.03,
});
assert.equal(holdHit.kind, 'holdEnd');
assert.ok(Math.abs(holdHit.pullBack - 1.98) < 1e-6);

// 4. Loop boundary (3-pass drill + infinite loop + EOF forceEnded)
const loop1 = evaluateWebBoundary({
  ...base,
  stops: [],
  loop: { start: 0, end: 2.0, remaining: 3, completedLoops: 0, gapMs: 1000 },
  before: 1.96,
  now: 2.02,
});
assert.equal(loop1.kind, 'loopEnd');
assert.equal(loop1.done, false);
assert.equal(loop1.completedLoops, 1);
assert.equal(loop1.nextRemaining, 2);
assert.ok(Math.abs(loop1.pullBack - 1.98) < 1e-6);

// Final pass (remaining === 0) finishes loop
const loopDone = evaluateWebBoundary({
  ...base,
  stops: [],
  loop: { start: 0, end: 2.0, remaining: 0, completedLoops: 3, gapMs: 1000 },
  before: 1.96,
  now: 2.01,
});
assert.equal(loopDone.kind, 'loopEnd');
assert.equal(loopDone.done, true);
assert.equal(loopDone.completedLoops, 4);

// Infinite loop (remaining === -1) stays -1 forever
const loopInf = evaluateWebBoundary({
  ...base,
  stops: [],
  loop: { start: 2.2, end: 4.5, remaining: -1, completedLoops: 7, gapMs: 1000 },
  before: 4.47,
  now: 4.51,
});
assert.equal(loopInf.kind, 'loopEnd');
assert.equal(loopInf.done, false);
assert.equal(loopInf.nextRemaining, -1);
assert.equal(loopInf.completedLoops, 8);

// EOF-aligned last line loop via forceEnded (even when paused / ended slightly before end)
const eofLoop = evaluateWebBoundary({
  ...base,
  stops: [],
  paused: true,
  forceEnded: true,
  loop: { start: 7.5, end: 10.0, remaining: 1, completedLoops: 2, gapMs: 1000 },
  before: 9.95,
  now: 9.98,
});
assert.equal(eofLoop.kind, 'loopEnd');
assert.equal(eofLoop.done, false);
assert.equal(eofLoop.completedLoops, 3);
assert.ok(Math.abs(eofLoop.pullBack - 9.96) < 1e-6);

// 5. Auto-pause (free mode sentence-end pause)
const ap1 = evaluateWebBoundary({
  ...base,
  stops: [],
  autoPause: true,
  before: 1.97,
  now: 2.02,
});
assert.equal(ap1.kind, 'sentencePause');
assert.equal(ap1.lineIndex, 0);
assert.equal(ap1.lineId, 1);
assert.ok(Math.abs(ap1.pullBack - 1.98) < 1e-6);

// Resuming after auto-pause with heldBoundary = 2.0 does not re-pause on line 0
assert.equal(
  evaluateWebBoundary({ ...base, stops: [], autoPause: true, heldBoundary: 2.0, before: 1.98, now: 2.03 }).kind,
  'none',
);

// 6. Drill progress mapping (tries = 3 -> armed with count = 4: 3 blind passes + 1 revealed pass)
assert.deepEqual(drillProgressFromLoops(0, 3), { play: 1, shown: false });
assert.deepEqual(drillProgressFromLoops(1, 3), { play: 2, shown: false });
assert.deepEqual(drillProgressFromLoops(2, 3), { play: 3, shown: false });
assert.deepEqual(drillProgressFromLoops(3, 3), { play: 3, shown: true });
assert.deepEqual(drillProgressFromLoops(4, 3), { play: 3, shown: true });

// 7. Lockscreen bg-mark resolution & merge into in-memory marks
// Exact lineId match
assert.equal(resolveBgMarkLineId(lines, { lineId: 3, startMs: 4500, text: 'Third sentence (section 2 start).' }), 3);
// Fallback to startMs when lineId is -1 (legacy event)
assert.equal(resolveBgMarkLineId(lines, { lineId: -1, startMs: 2210, text: 'Second sentence.' }), 2);
// Fallback to positionMs in gap between line 1 (end 2.0) and line 2 (start 2.2) -> resolves to line 1
assert.equal(resolveBgMarkLineId(lines, { startMs: 99999, positionMs: 2100 }), 1);

// mergeBgMarks adds new marks as 'open', preserves existing 'ok'/'more', avoids unnecessary copy
const initial = new Map([[1, 'ok'], [2, 'more']]);
const merged = mergeBgMarks(initial, [1, 2, 3]);
assert.equal(merged.get(1), 'ok');
assert.equal(merged.get(2), 'more');
assert.equal(merged.get(3), 'open');
assert.equal(mergeBgMarks(merged, [3]), merged, 'no-op merge returns identical Map reference');

console.log('mobile listen ok');
