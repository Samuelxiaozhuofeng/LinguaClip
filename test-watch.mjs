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
const { lineAt, parseSRT } = await import(out);

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
assert.equal(lineAt([], 3), -1, 'no lines');
console.log('test-watch: ok');
