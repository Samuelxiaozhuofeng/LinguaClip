// System back closes the top sheet first (mobile/backClose.ts).
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = join(tmpdir(), `back-close-${process.pid}.mjs`);
await build({ entryPoints: ['mobile/backClose.ts'], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent' });
const M = await import(out);

assert.equal(M.closeTopOnBack(), false, 'nothing open: the page handles back');

const closed = [];
M.pushBackClose(() => closed.push('word sheet'));
const offBreakdown = M.pushBackClose(() => closed.push('breakdown'));
assert.equal(M.closeTopOnBack(), true);
assert.deepEqual(closed, ['breakdown'], 'the sheet on top closes first');
offBreakdown(); // its own unmount after closing: harmless
assert.equal(M.closeTopOnBack(), true);
assert.deepEqual(closed, ['breakdown', 'word sheet']);
assert.equal(M.closeTopOnBack(), false, 'all closed: back goes to the page again');

// A sheet closed by its own button leaves the stack.
const off = M.pushBackClose(() => closed.push('more'));
off();
assert.equal(M.closeTopOnBack(), false);
console.log('back-close ok');
