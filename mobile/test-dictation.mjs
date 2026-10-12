/**
 * The phone's review dictation check (mobile/dictation.ts): typed words lined up with the line's.
 * Run with: node mobile/test-dictation.mjs
 */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = join(tmpdir(), `mobile-dictation-${process.pid}.mjs`);
await build({ stdin: { contents: "export * from './mobile/dictation';", resolveDir: '.', loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error' });
const { checkDictation: check } = await import(out);
const show = r => r.pieces.filter(p => p.kind !== 'text').map(p => `${p.kind}:${p.s}`).join(' ');

let r = check('Me encanta la paella, pero mi abuela hace un guiso increíble.', 'me encanta la paella pero mi abuela hace un guisó increíble');
assert.equal(r.wrong, 1);
assert.equal(r.correct, false);
assert.match(show(r), /extra:guisó miss:guiso ok:increíble/);

r = check("It's a nice day.", 'it’s a nice day');
assert.ok(r.correct, show(r));
assert.equal(r.wrong, 0);

r = check('I really like it.', 'I like it');
assert.equal(r.wrong, 1);
assert.match(show(r), /ok:I miss:really ok:like/);

r = check('I like it.', 'I do like it a lot');
assert.equal(r.wrong, 2);

r = check('Hello there.', '');
assert.equal(r.correct, false);
assert.equal(r.wrong, 1);

// Japanese without the splitting dictionary: the whole line, kana folded.
r = check('すみません。', 'スミマセン');
assert.ok(r.correct);
r = check('すみません。', 'すいません');
assert.equal(r.correct, false);
console.log('mobile dictation ok');
