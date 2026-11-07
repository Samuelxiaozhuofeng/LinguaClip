/**
 * Dictation judging, 宽松判对 and 差一点 (utils/textTokenizer.ts, docs/dictation-judge.md).
 * Run with: node test-judge.mjs
 *
 * Bundles the real module; the Tauri side is stubbed (only Japanese reading lookups need it).
 */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = join(tmpdir(), `judge-${process.pid}.mjs`);
await build({
  stdin: { contents: "export * from './utils/textTokenizer.ts';", resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error',
  plugins: [{
    name: 'stub-desktop',
    setup(b) {
      b.onResolve({ filter: /\/desktop$|^@tauri-apps\/plugin-http$/ }, a => ({ path: a.path, namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        contents: `export const jaDictStatus = async () => ({ installed: false });
          export const readBinaryFile = async () => new Uint8Array(); export const installJaDict = async () => {};
          export const removeJaDict = async () => {}; export const onJaDictProgress = async () => () => {};
          export const readCacheText = async () => null; export const writeCacheText = async () => {};
          export const fetch = globalThis.fetch;`,
        loader: 'js',
      }));
    },
  }],
});
const { isInputCorrectFlexibleCase: ok, judgeWord: judge, nearMarks, letters, compareWords, areAllWordsCorrectFlexibleCase: allOk, tokenizeText } = await import(out);

// 1. 宽松判对: punctuation at either end and the whole word's case don't count.
for (const [typed, target] of [['hello,', 'hello'], ['"hello', 'Hello'], ['Iphone', 'iPhone'], ['IPHONE', 'iPhone'], ['MARY', 'Mary'], ['¿qué?', 'qué']]) {
  assert.ok(ok(typed, target, undefined, true), `lenient: ${typed} = ${target}`);
  assert.ok(!ok(typed, target), `strict: ${typed} ≠ ${target}`);
  assert.equal(judge(typed, target, undefined, true), 'right');
}
assert.ok(!ok(',', 'hello', undefined, true), 'only punctuation is not a word');
assert.ok(!ok('', 'hello', undefined, true));
assert.ok(!ok('hel-lo', 'hello', undefined, true), 'punctuation inside the word still counts');
assert.ok(ok("don't", 'don’t', undefined, true), 'straight and curly apostrophe');

// 2. 差一点 (only lenient), each rule: accents, an English ending, one letter in 6+.
const near = (typed, target) => judge(typed, target, undefined, true);
assert.equal(near('esta', 'está'), 'near');
assert.equal(near('cafe', 'Café'), 'near');
assert.equal(near('walk', 'walked'), 'near');
assert.equal(near('walked', 'walk'), 'near');
assert.equal(near('walk', 'walks'), 'near');
assert.equal(near('box', 'boxes'), 'near');
assert.equal(near('love', 'loved'), 'near');
assert.equal(near('elephant', 'elephants'), 'near');
assert.equal(near('recieve', 'receive'), 'wrong', 'two letters swapped = two changes');
assert.equal(near('becausee', 'because'), 'near', 'one letter added, target of 7');
assert.equal(near('bcause', 'because'), 'near', 'one letter dropped');
assert.equal(near('bacause', 'because'), 'near', 'one letter changed');
assert.equal(near('hause', 'house'), 'wrong', 'one letter off in a word under 6 letters');
assert.equal(near('a', 'as'), 'wrong', 'a stem under 3 letters is not an ending');
assert.equal(near('walking', 'walked'), 'wrong');
assert.equal(near('', 'walked'), 'wrong', 'an empty box is not near');
assert.equal(near('walk,', 'walked'), 'near', 'edge punctuation dropped first');
assert.equal(judge('walk', 'walked'), 'wrong', 'strict: no near misses');
assert.equal(judge('esta', 'está'), 'wrong');
assert.equal(near('きのうは', '今日は'), 'wrong', 'Japanese is never near');
assert.equal(judge('すし', 'すしい', 'すしい', true), 'wrong', 'a box with a reading is never near');

// 3. Which letters of the answer turn accent: only those that differ, never a right letter between them.
const red = (typed, target) => { const m = nearMarks(typed, target); return m ? letters(target).filter((_, k) => m[k]).join('') : null; };
assert.equal(red('walk', 'walked'), 'ed');
assert.equal(red('esta', 'está'), 'á');
assert.equal(red('walks', 'walk'), '', 'only added letters: nothing red, the dashed line alone');
assert.equal(red('bacause', 'Because'), 'e');
assert.equal(red('resume', 'résumé'), 'éé', 'two accents apart: sum between them stays plain');
assert.equal(red('eleve', 'élève'), 'éè');

assert.equal(red('reél', 'réel'), 'ée', 'accent moved: both letters at the two places differ');

// 5. Composed (NFC) and decomposed (NFD) accents are the same letter: in judging, in marks, in splitting.
const nfd = s => s.normalize('NFD');
for (const lenient of [false, true]) {
  assert.ok(ok(nfd('résumé'), 'résumé', undefined, lenient), `NFD typed, NFC answer (lenient ${lenient})`);
  assert.ok(ok('résumé', nfd('résumé'), undefined, lenient), `NFC typed, NFD answer (lenient ${lenient})`);
}
assert.equal(judge(nfd('esta'), nfd('está'), undefined, true), 'near');
assert.equal(red('resume', nfd('résumé')), nfd('éé'), 'marks follow the NFD answer letter by letter');
assert.equal(red(nfd('reél'), 'réel'), 'ée');
const words = text => tokenizeText(text).filter(t => t.type === 'WORD').map(t => t.value);
assert.deepEqual(words(nfd('Le résumé est là, élève.')), [nfd('Le'), nfd('résumé'), 'est', nfd('là'), nfd('élève')], 'NFD line: an accent stays in its word');
assert.equal(tokenizeText(nfd('Él está aquí.')).map(t => t.value).join(''), nfd('Él está aquí.'), 'tokens still spell the line exactly');
assert.deepEqual(words('Él está aquí, ¿no? I don’t know.'), ['Él', 'está', 'aquí', 'no', 'I', 'don’t', 'know'], 'NFC line split as before');

const { targetWords } = await import(out);
assert.deepEqual(targetWords(['Mon', nfd('résumé'), 'est'], 'résumé'), [1], 'a looked-up NFC word marks its NFD box');
assert.deepEqual(targetWords(['Mon', 'résumé', 'est'], nfd('résumé')), [1]);

// 4. The whole line: near is still wrong; lenient makes the edge / case cases right.
const line = tokenizeText('I walked home, Mary.');
assert.ok(allOk(line, ['i', 'walked', 'home,', 'MARY'], true));
assert.ok(!allOk(line, ['i', 'walked', 'home,', 'MARY']), 'strict: home, and MARY are wrong');
assert.ok(!allOk(line, ['I', 'walk', 'home', 'Mary'], true), 'a near miss is wrong');
const res = compareWords(line, ['I', 'walk', 'hom', 'Mary'], true);
assert.deepEqual(res.map(r => [r.isCorrect, r.near]), [[true, false], [false, true], [false, false], [true, false]]);
assert.deepEqual(compareWords(line, ['I', 'walk', 'home', 'Mary']).map(r => r.near), [false, false, false, false], 'strict: no near');

console.log('judge ok');
