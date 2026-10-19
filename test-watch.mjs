/**
 * Checks watch mode's "which line is on screen" lookup (lineAt in utils/srtParser.ts).
 * Run with: node test-watch.mjs
 */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = join(tmpdir(), `watch-${process.pid}.mjs`);
await build({ entryPoints: ['utils/srtParser.ts'], bundle: true, format: 'esm', outfile: out, logLevel: 'error' });
const { lineAt, lineEnded, passed, parseSRT } = await import(out);

const lines = parseSRT(`1
00:00:01,000 --> 00:00:02,000
one

2
00:00:03,000 --> 00:00:04,500
two

3
00:00:04,500 --> 00:00:06,000
three
`);
assert.equal(lineAt(lines, 0), -1, 'before the first line');
assert.equal(lineAt(lines, 1), 0, 'exactly at a start');
assert.equal(lineAt(lines, 2.5), 0, 'in the gap: the line just said');
assert.equal(lineAt(lines, 4.5), 2, 'back to back: the new line wins');
assert.equal(lineAt(lines, 99), 2, 'after the last');

// parseSRT: the messy files people actually bring
const got = (srt) => parseSRT(srt).map(l => [l.id, l.startTime, l.endTime, l.text]);
assert.deepEqual(got('1\n00:00:05,000 --> 00:00:02,000\nbackwards\n\n2\n00:00:06,000 --> 00:00:07,000\nok\n'), [[1, 6, 7, 'ok']], 'end before start: dropped');
assert.deepEqual(got('1\n00:00:10,000 --> 00:00:12,000\nB\n\n2\n00:00:01,000 --> 00:00:03,000\nA\n'), [[1, 1, 3, 'A'], [2, 10, 12, 'B']], 'out of order: sorted, ids follow');
assert.deepEqual(got('1\n00:00:01,000 --> 00:00:02,000\nA\n  \t\n2\n00:00:03,000 --> 00:00:04,000\nB\n'), [[1, 1, 2, 'A'], [2, 3, 4, 'B']], 'blank line with spaces still splits');
assert.deepEqual(got('1\r\n00:00:01.5 --> 00:00:02.250\r\nA\r\n\r\n\r\n2\r\n01:03,000 --> 01:04,000 X1:10 Y1:20\r\nB\r\n'), [[1, 1.5, 2.25, 'A'], [2, 63, 64, 'B']], 'dot millis, no hours, position after the time, CRLF, extra blank lines');
assert.deepEqual(got('1\n00:00:01,000 --> 00:00:01,000\nzero\n'), [[1, 1, 1, 'zero']], 'zero length kept');
assert.deepEqual(got('garbage --> nope\ntext\n'), [], 'no times: skipped');
assert.equal(lineAt([], 3), -1, 'no lines');

// lineEnded: a frame landing in the sliver where lineAt has already moved on still ends the line
const two = lines[1]; // 3 → 4.5, three starts at 4.5
assert.equal(lineEnded(two, 4.49, 4.4995), true, 'into the sliver before a back-to-back line: ended');
assert.equal(lineAt(lines, 4.4995), 2, '(lineAt has moved on there)');
assert.equal(lineEnded(two, 4.4995, 4.51), false, 'not ended twice');
assert.equal(lineEnded(two, 4.0, 4.4), false, 'still inside');
assert.equal(lineEnded(two, 4.48, 4.6), true, 'plain crossing');
// a drill line's / section's end in the same sliver: caught on the same frame as the line's end
assert.equal(passed(4.5, 4.49, 4.4995), lineEnded(two, 4.49, 4.4995), 'same slack as lineEnded');
console.log('test-watch: ok');
