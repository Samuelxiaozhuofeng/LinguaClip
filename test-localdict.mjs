/**
 * Checks the local-dictionary lookups (utils/yomitanContent.ts): what is tried
 * for a clicked word, forms followed to their lemma, and Yomitan rows turned
 * into our meanings — on rows cut from the real wty / Jitendex / JMdict
 * (dev/fixtures/dict-sample.json, 2026-09-30).
 * Run with: node test-localdict.mjs
 *
 * Bundles the real module rather than re-typing the logic.
 */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = join(tmpdir(), `yomitan-${process.pid}.mjs`);
await build({ entryPoints: ['utils/yomitanContent.ts'], bundle: true, format: 'esm', outfile: out });
const { candidates, lemmasToFollow, toEntries, sensesOf, segs, plain, posOf } = await import(out);
const fx = JSON.parse(readFileSync('dev/fixtures/dict-sample.json', 'utf8'));
const rowsOf = (id, ...words) => fx.rows[id].filter(r => words.includes(r[0]) || words.includes(r[1]));
const text = s => plain(s.text);

// --- what is tried (⑥: the word as clicked comes first) ---
assert.deepEqual(candidates('Haus', 'de'), [['Haus', 'haus'], []]);
assert.deepEqual(candidates('Straße', 'de')[0], ['Straße', 'straße', 'Strasse', 'strasse']);
assert.deepEqual(candidates('Llegué', 'es')[0], ['Llegué', 'llegué']);
assert.deepEqual(candidates('essen', 'de')[0].slice(0, 2), ['essen', 'Essen'], 'Swiss ss → ß variants come after the real spelling');
assert.deepEqual(candidates('l’homme', 'fr'), [["l’homme", "l'homme", "L'homme"], ['homme', 'Homme']], 'elision only in the second round');
assert.deepEqual(candidates("aujourd'hui", 'fr')[1], [], 'aujourd is no elision');
assert.deepEqual(candidates("c'est", 'fr')[1], ['est', 'Est'], "c' is — but only tried when c'est itself is missing");
assert.deepEqual(candidates('食べました', 'ja', '食べる'), [['食べました', '食べる'], ['食べまし', '食べま', '食べ', '食']]);
assert.deepEqual(candidates('esta', 'es')[0], ['esta', 'Esta'], 'no accent stripping: esta is not está');

// --- forms → lemmas ---
assert.deepEqual(lemmasToFollow(rowsOf('fixture-es', 'llegué'), 'llegué'), [{ lemma: 'llegar', note: 'first-person singular indicative preterite of llegar' }]);
assert.deepEqual(lemmasToFollow(rowsOf('fixture-es', 'fue'), 'fue').map(l => l.lemma).slice(0, 2), ['ir', 'ser'], 'fue: both ir and ser');
assert.deepEqual(lemmasToFollow(rowsOf('fixture-en', 'right'), 'right'), [], 'right has entries of its own: spelling variants are not followed');
assert.deepEqual(lemmasToFollow(rowsOf('fixture-en', 'elephants'), 'elephants').map(l => l.lemma), ['elephant']);
const guys = lemmasToFollow(rowsOf('fixture-en', 'guys'), 'guys');
assert.equal(guys[0].lemma, 'guy', 'inflection before spelling variant');
const ete = lemmasToFollow(rowsOf('fixture-fr', 'été'), 'été');
assert.ok(ete.some(l => l.lemma === 'être'), 'été (a noun) still leads to être');
assert.deepEqual(lemmasToFollow(rowsOf('fixture-de', 'ging'), 'ging').map(l => l.lemma), ['gehen']);
assert.match(lemmasToFollow(rowsOf('fixture-de', 'ging'), 'ging')[0].note, /^first\/third-person singular indicative preterite; .* of gehen$/, 'at most two ways, joined');

// --- rows → entries: wty ---
const [llegar] = toEntries(rowsOf('fixture-es', 'llegar'), fx.tags['fixture-es'], 'wty-es-en', 'x of llegar');
assert.equal(llegar.word, 'llegar');
assert.equal(llegar.source, 'local');
assert.equal(llegar.dictName, 'wty-es-en');
assert.equal(llegar.note, 'x of llegar');
assert.equal(text(llegar.senses[0]), 'to arrive, get (to)', 'etymology, grammar and the examples switch stay out of the meaning');
assert.equal(llegar.senses[0].pos, 'verb, intransitive verb');
assert.equal(plain(llegar.senses[0].examples[0]), 'Cuando llegues a casa, mándame un mensaje.\nWhen you get home, send me a message.');
assert.ok(llegar.senses.length >= 4);
const [pan] = toEntries(rowsOf('fixture-es', 'pan'), fx.tags['fixture-es'], 'wty-es-en');
const money = pan.senses.find(x => text(x) === 'money, dough');
assert.equal(money?.pos, 'noun, masculine, figurative', "a meaning's own label joins its part of speech, not its text");
assert.equal(toEntries(rowsOf('fixture-es', 'llegué'), fx.tags['fixture-es'], 'wty-es-en').length, 0, 'form rows are no entries');
const cool = toEntries(rowsOf('fixture-en', 'cool'), fx.tags['fixture-en'], 'wty-en-en');
assert.equal(cool[0].word, 'cool');
assert.equal(text(cool[0].senses[0]), 'Of a mildly low temperature.');
assert.ok(cool.every(e => e.senses.every(s => !text(s).includes('Wiktionary'))), 'backlinks dropped');

// --- Jitendex: one meaning per sense, examples keep their furigana ---
const [taberu] = toEntries(rowsOf('fixture-ja', '食べる').filter(r => r[0] === '食べる'), fx.tags['fixture-ja'], 'Jitendex.org');
assert.equal(taberu.reading, 'たべる');
assert.equal(taberu.phonetic, 'たべる');
assert.equal(text(taberu.senses[0]), 'to eat');
assert.equal(text(taberu.senses[1]), 'to live on (e.g. a salary); to live off; to subsist on');
assert.equal(taberu.senses[0].pos, 'Ichidan verb, transitive verb');
const ex = taberu.senses[0].examples[0];
assert.deepEqual(ex.slice(0, 3), ['もっと', { ruby: '果', rt: 'くだ' }, { ruby: '物', rt: 'もの' }]);
assert.equal(plain(ex), 'もっと果物を食べるべきです。\nYou should eat more fruit.', 'the [1] footnote is dropped');

// --- JMdict: a row per meaning, same entry ---
const jm = toEntries(fx.jmdict.rows.filter(r => r[0] === '食べる'), fx.jmdict.tags, 'JMdict');
assert.equal(jm.length, 1, 'rows of one sequence number are one entry');
assert.deepEqual(jm[0].senses.map(text), ['to eat', 'to live on (e.g. a salary); to live off; to subsist on']);
assert.equal(jm[0].senses[0].pos, 'Ichidan verb, transitive verb');
const sumimasen = toEntries(fx.jmdict.rows.filter(r => r[1] === 'すみません'), fx.jmdict.tags, 'JMdict');
assert.match(text(sumimasen[0].senses[0]), /^excuse me; pardon me; I'm sorry; I beg your pardon\nused to apologize/, 'notes on their own line');

// --- anything else: one meaning, lines kept, never HTML ---
const unknown = { type: 'structured-content', content: [
  { tag: 'div', content: ['first line', { tag: 'img', path: 'x.png' }] },
  { tag: 'ul', content: [{ tag: 'li', content: '<script>alert(1)</script>' }, { tag: 'li', content: { tag: 'a', href: 'javascript:alert(1)', content: 'link text' } }] },
  { tag: 'table', content: { tag: 'tr', content: [{ tag: 'td', content: 'a' }, { tag: 'td', content: 'b' }] } },
] };
const [only] = sensesOf(unknown, 'n');
assert.equal(text(only), 'first line\n<script>alert(1)</script>\nlink text\na b', 'text stays text; links and images give only their words');
assert.ok(only.text.every(p => typeof p === 'string' || 'ruby' in p), 'no image segments');
assert.deepEqual(sensesOf('plain gloss', ''), [{ pos: '', text: ['plain gloss'], examples: [] }]);
assert.deepEqual(sensesOf(['llegar', ['preterite']], ''), [], 'a form pointer is no meaning');
assert.deepEqual(segs({ tag: 'ruby', content: ['漢', { tag: 'rp', content: '(' }, { tag: 'rt', content: 'かん' }, { tag: 'rp', content: ')' }] }), [{ ruby: '漢', rt: 'かん' }]);
assert.equal(posOf(['x', '', 'n fem non-lemma', '', 0, [], 0, ''], fx.tags['fixture-es']), 'noun, feminine');

console.log('localdict: all good');
