/**
 * The phone's review & touch dictation check (mobile/dictation.ts):
 * typed words lined up with the line's, plus lenient near-miss pairing & letter marks.
 * Run with: node mobile/test-dictation.mjs
 */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = join(tmpdir(), `mobile-dictation-${process.pid}.mjs`);
await build({
  stdin: { contents: "export * from './mobile/dictation';", resolveDir: '.', loader: 'ts' },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: out,
  logLevel: 'error',
});
const { checkDictation: check } = await import(out);
const show = r => r.pieces.filter(p => p.kind !== 'text').map(p => `${p.kind}:${p.s}`).join(' ');

let r = check('Me encanta la paella, pero mi abuela hace un guiso increíble.', 'me encanta la paella pero mi abuela hace un guisó increíble');
assert.equal(r.wrong, 1);
assert.equal(r.correct, false);
assert.match(show(r), /extra:guisó miss:guiso ok:increíble/);
// Accent-only difference is paired as a near miss on "guiso" (last letter 'o' differs).
assert.equal(r.near, 1);
const guisoWord = r.words.find(w => w.target === 'guiso');
assert.equal(guisoWord?.verdict, 'near');
assert.deepEqual(guisoWord?.marks, [false, false, false, false, true]);

r = check("It's a nice day.", 'it’s a nice day');
assert.ok(r.correct, show(r));
assert.equal(r.wrong, 0);
assert.equal(r.near, 0);

r = check('I really like it.', 'I like it');
assert.equal(r.wrong, 1);
assert.equal(r.near, 0);
assert.match(show(r), /ok:I miss:really ok:like/);

r = check('I like it.', 'I do like it a lot');
assert.equal(r.wrong, 2);

r = check('Hello there.', '');
assert.equal(r.correct, false);
assert.equal(r.wrong, 1);
assert.equal(r.near, 0);

// Lenient (default on): case of the whole word doesn't count.
r = check('I bought an iPhone.', 'i bought an IPHONE');
assert.ok(r.correct, show(r));

// Ending near miss: walk vs walked -> still wrong, marked near with 'ed' highlighted.
r = check('I walked home.', 'I walk home');
assert.equal(r.correct, false, 'a near miss is still wrong');
assert.equal(r.wrong, 1);
assert.equal(r.near, 1);
assert.equal(r.words[1].verdict, 'near');
assert.deepEqual(r.words[1].marks, [false, false, false, false, true, true]);
const walkedPiece = r.pieces.find(p => p.kind === 'miss' && p.s === 'walked');
assert.equal(walkedPiece?.near, true);
assert.deepEqual(walkedPiece?.marks, [false, false, false, false, true, true]);

// Missing word next to a near miss in the same gap: "really" is wrong, "walked" still pairs as near!
r = check('I really walked home.', 'I walk home');
assert.equal(r.correct, false);
assert.equal(r.near, 1);
assert.equal(r.words[0].verdict, 'right');
assert.equal(r.words[1].verdict, 'wrong');
assert.equal(r.words[2].verdict, 'near');
assert.deepEqual(r.words[2].marks, [false, false, false, false, true, true]);
assert.equal(r.words[3].verdict, 'right');

// 6+ letter word with single-letter edit: "yestarday" vs "yesterday" -> near, marks 5th letter 'e'.
r = check('We arrived yesterday.', 'We arrived yestarday');
assert.equal(r.correct, false);
assert.equal(r.near, 1);
assert.equal(r.words[2].verdict, 'near');
assert.deepEqual(r.words[2].marks, [false, false, false, false, true, false, false, false, false]);

// Strict mode (lenient = false): no near misses, whole-word case mismatch is wrong.
r = check('I bought an iPhone.', 'i bought an IPHONE', false);
assert.equal(r.correct, false);
assert.equal(r.near, 0);
r = check('I walked home.', 'I walk home', false);
assert.equal(r.correct, false);
assert.equal(r.near, 0);
assert.equal(r.words[1].verdict, 'wrong');

// A decomposed (NFD) subtitle against the phone keyboard's composed letters.
r = check('Él está aquí.'.normalize('NFD'), 'él está aquí');
assert.ok(r.correct, show(r));

// Japanese without the splitting dictionary: the whole line, kana folded, never near.
r = check('すみません。', 'スミマセン');
assert.ok(r.correct);
assert.equal(r.near, 0);
r = check('すみません。', 'すいません');
assert.equal(r.correct, false);
assert.equal(r.near, 0);
console.log('mobile dictation ok');
