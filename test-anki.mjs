/**
 * Checks utils/anki.ts: old saved settings (word + audio cards) collapse into
 * the one card the app uses now, and the looked-up word gets bolded in its sentence.
 * Run with: node test-anki.mjs
 *
 * Bundles the real module rather than re-typing the logic.
 */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = join(tmpdir(), `anki-${process.pid}.mjs`);
await build({ entryPoints: ['utils/anki.ts'], bundle: true, format: 'esm', outfile: out, logLevel: 'error' });
const store = {};
globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } };
const { getAnkiConfig, saveAnkiConfig, boldWord, LINGUACLIP_FIELDS, rubySentence, linguaClipFront } = await import(out);

const KEY = 'linguaclip_anki_config';
const word = { deckName: 'W', modelName: 'Basic', fieldMapping: { Front: 'word' } };
const audio = { deckName: 'A', modelName: 'Audio', fieldMapping: { Front: 'audio' } };
const load = (v) => { store[KEY] = JSON.stringify(v); return getAnkiConfig(); };

// --- old settings keep working ---
assert.equal(getAnkiConfig(), null, 'nothing saved');
assert.deepEqual(load({ url: 'u', wordCard: word, audioCard: audio }), { url: 'u', card: audio }, 'audio card wins, as both buttons already used it');
assert.deepEqual(load({ url: 'u', wordCard: word, audioCard: null }), { url: 'u', card: word }, 'only a word card → keep it');
assert.deepEqual(load({ url: 'u', wordCard: null, audioCard: null }), { url: 'u', card: null });
assert.deepEqual(load({ deckName: 'D', modelName: 'M', fieldMapping: { F: 'sentence' } }).card, { deckName: 'D', modelName: 'M', fieldMapping: { F: 'sentence' } }, 'oldest single-template shape');
assert.equal(load({ url: '' , card: audio }).url, 'http://127.0.0.1:8765', 'empty url → default');
saveAnkiConfig({ url: 'x', card: word });
assert.deepEqual(getAnkiConfig(), { url: 'x', card: word }, 'new shape round-trips');
store[KEY] = '{broken';
assert.equal(getAnkiConfig(), null);

// --- bold the word in its sentence ---
assert.equal(boldWord('I want a coffee.', 'a'), 'I want <b>a</b> coffee.', 'whole word, not inside "want"');
assert.equal(boldWord('Wander around.', 'wander'), '<b>Wander</b> around.', 'case-insensitive, keeps original casing');
assert.equal(boldWord('¿Qué está pasando?', 'está'), '¿Qué <b>está</b> pasando?', 'accented letters');
assert.equal(boldWord('Die Straße ist groß.', 'straße'), 'Die <b>Straße</b> ist groß.');
assert.equal(boldWord('明日あなたと話したいです', '話したい'), '明日あなたと<b>話したい</b>です', 'no spaces → plain match');
assert.equal(boldWord('Is it (really) true?', '(really)'), 'Is it <b>(really)</b> true?', 'regex characters are literal');
assert.equal(boldWord('Hello there.', 'bye'), 'Hello there.', 'not in sentence → unchanged');
assert.equal(boldWord('Hello.', '  '), 'Hello.');
// Subtitle text is text: tags and & in the line come out escaped, the word still bolded.
assert.equal(boldWord('Tom & <b>Jerry</b> "run"', 'jerry'), 'Tom &amp; &lt;b&gt;<b>Jerry</b>&lt;/b&gt; &quot;run&quot;', 'escaped, word bolded');
assert.equal(boldWord('<img src=x onerror="alert(1)">', 'img'), '&lt;<b>img</b> src=x onerror=&quot;alert(1)&quot;&gt;', 'no live tag');
assert.equal(boldWord('a & b', 'amp'), 'a &amp; b', 'never matches inside an entity');
assert.equal(boldWord('R&D <x>', ''), 'R&amp;D &lt;x&gt;', 'no word: still escaped');

// --- LinguaClip note type: first field is the sentence (Anki rejects an empty first field) ---
assert.equal(Object.values(LINGUACLIP_FIELDS)[0], 'sentence');
assert.ok(Object.values(LINGUACLIP_FIELDS).includes('audio'));


// --- LinguaClip notes: the kept word in <b>; no dictionary here, so no kana ---
assert.equal(rubySentence('I want a coffee.', 'a'), 'I want <b>a</b> coffee.');
assert.equal(rubySentence('Hello there.', 'bye'), 'Hello there.', 'not in the line → unchanged');
assert.equal(rubySentence('Tom & <b>Jerry</b>', 'Jerry'), 'Tom &amp; &lt;b&gt;<b>Jerry</b>&lt;/b&gt;', 'own card escapes too');
assert.equal(rubySentence('明日あなたと話したいです', '話したい'), '明日あなたと<b>話したい</b>です');
assert.equal(rubySentence('何か[笑]', undefined), '何か[笑]', 'brackets stay text: no Anki furigana syntax');
// --- the card: a word note keeps its sound and picture for the back ---
for (const f of ['word', 'sentence']) {
  const wordPart = linguaClipFront(f).split('{{/Word}}')[0];
  assert.ok(!wordPart.includes('{{Audio}}') && !wordPart.includes('{{Image}}'), `${f}: word front gives nothing away`);
  assert.ok(linguaClipFront(f).includes('{{^Word}}{{Audio}}'), `${f}: sentence notes keep sound on the front (else Anki refuses them)`);
}
assert.ok(linguaClipFront('word').includes('{{Word}}') && !linguaClipFront('word').split('{{/Word}}')[0].includes('{{Sentence}}'));
assert.ok(linguaClipFront('sentence').split('{{/Word}}')[0].includes('{{Sentence}}'));

console.log('test-anki: all passed');
