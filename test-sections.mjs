/**
 * Checks the video-into-sections maths in utils/sections.ts.
 * Run with: node test-sections.mjs
 *
 * Bundles the real module rather than re-typing the logic, so this fails
 * when that file drifts.
 */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = join(tmpdir(), `sections-${process.pid}.mjs`);
await build({ entryPoints: ['utils/sections.ts'], bundle: true, format: 'esm', outfile: out });
const { buildSections } = await import(out);

// One line every 10s for 20 minutes: 120 lines.
const subs = Array.from({ length: 120 }, (_, i) => ({
  id: i + 1, startTime: i * 10, endTime: i * 10 + 8, text: `line ${i + 1}`,
}));

// 0 means the whole video, as one section.
const whole = buildSections(subs, 0);
assert.equal(whole.length, 1);
assert.equal(whole[0].subtitles.length, 120);

// 4 minutes => 5 sections of 24 lines, and every line lands in exactly one.
const parts = buildSections(subs, 4);
assert.equal(parts.length, 5);
assert.deepEqual(parts.map(p => p.subtitles.length), [24, 24, 24, 24, 24]);
assert.deepEqual(
  parts.flatMap(p => p.subtitles.map(s => s.id)),
  subs.map(s => s.id),
  'every line appears once, in order',
);

// A section starts where its first line starts, so playback never opens on silence.
assert.equal(parts[1].subtitles[0].startTime, 240);

// A gap in the middle drops the empty window instead of showing an empty section.
const gapped = buildSections(
  [{ id: 1, startTime: 0, endTime: 5, text: 'a' }, { id: 2, startTime: 900, endTime: 905, text: 'b' }],
  4,
);
assert.equal(gapped.length, 2, 'two lines 15 minutes apart => two sections, not four');
assert.equal(gapped.every(s => s.subtitles.length > 0), true);

// No subtitles at all: no sections (the caller bails out before this).
assert.deepEqual(buildSections([], 4), []);

// A single line still gets a section to live in.
assert.equal(buildSections([subs[0]], 4).length, 1);

// Degenerate SRT (everything at time 0) still yields a section to stand on.
assert.equal(buildSections([{ id: 1, startTime: 0, endTime: 0, text: 'a' }], 4).length, 1);

console.log('sections: all checks passed');

// sectionAt: the section a second falls in — before the first line → 0, in a gap → the one before, past the end → the last.
{
  const { sectionAt, sectionStart } = await import(out);
  const secs = [0, 60, 120].map((s, i) => ({ id: i, startTime: s, subtitles: [{ startTime: s + 2 }] }));
  assert.equal(sectionStart(secs[1]), 62);
  assert.equal(sectionAt(secs, 0), 0);
  assert.equal(sectionAt(secs, 61), 0);
  assert.equal(sectionAt(secs, 62), 1);
  assert.equal(sectionAt(secs, 999), 2);
  assert.equal(sectionAt([], 5), 0);
  console.log('ok sectionAt');
}
