/**
 * Checks the review decks' scheduling and matching in utils/review.ts.
 * Run with: node test-review.mjs
 *
 * Bundles the real module (same as the other test-*.mjs) so this fails when
 * that file drifts. The IndexedDB layer isn't exercised here; the browser run is.
 */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = join(tmpdir(), `review-${process.pid}.mjs`);
await build({ entryPoints: ['utils/review.ts'], bundle: true, format: 'esm', outfile: out });
const R = await import(out);

const DAY = 86400000;
const now = Date.parse('2026-09-24T10:00:00Z');
const base = { id: 'v1|1.00', deck: 'line', videoId: 'v1', videoName: 'a.mp4', text: 'Hello there, friend.', start: 1, end: 3 };

// Grades come from the dictation, never from the learner.
assert.equal(R.gradeOf({ correct: false, helped: false }), 1); // Again
assert.equal(R.gradeOf({ correct: false, helped: true }), 1);
assert.equal(R.gradeOf({ correct: true, helped: true }), 2);   // Hard
assert.equal(R.gradeOf({ correct: true, helped: false }), 3);  // Good

// A new card is due at once; no minute steps, so every answer pushes it to another day.
const fresh = R.newCard(base, 'wrong', now);
assert.ok(R.isDue(fresh, now));
for (const o of [{ correct: false, helped: false }, { correct: true, helped: true }, { correct: true, helped: false }]) {
  const next = R.schedule(fresh, o, now);
  assert.ok(next.fsrs.due >= now + DAY * 0.9, `answer ${JSON.stringify(o)} is due again the same day`);
  assert.ok(!R.isDue(next, now + 60000));
  assert.equal(next.fsrs.reps, 1);
}
// Getting it right grows the gap; getting it wrong again shrinks it back.
let c = fresh, t = now;
const gaps = [];
for (let i = 0; i < 4; i++) { c = R.schedule(c, { correct: true, helped: false }, t); gaps.push(c.fsrs.due - t); t = c.fsrs.due; }
assert.ok(gaps[3] > gaps[0] * 3, `gaps don't grow: ${gaps.map(g => (g / DAY).toFixed(1))}`);
const lapsed = R.schedule(c, { correct: false, helped: false }, t);
assert.ok(lapsed.fsrs.due - t < gaps[3], 'a miss should come back sooner');
assert.equal(lapsed.fsrs.lapses, 1);

// Stored form round-trips as plain numbers (IndexedDB-safe, no Date objects).
assert.equal(typeof lapsed.fsrs.due, 'number');
assert.ok(lapsed.fsrs.last_review === undefined || typeof lapsed.fsrs.last_review === 'number');

// Meeting the card again only adds a reason; the schedule stays.
const again = R.withReason(lapsed, 'peek');
assert.deepEqual(again.reasons, ['wrong', 'peek']);
assert.equal(again.fsrs.due, lapsed.fsrs.due);
assert.equal(R.withReason(again, 'peek').reasons.length, 2);
assert.equal(R.withReason(again, 'saved').saved, true);

// Queue: this deck only, due only, has audio, oldest first, capped.
const mk = (id, deck, due, start = 1) => ({ ...R.newCard({ ...base, id, deck, start }, 'wrong', now), fsrs: { ...fresh.fsrs, due } });
const cards = [
  mk('b', 'line', now - 10), mk('a', 'line', now - 20), mk('future', 'line', now + DAY),
  mk('w', 'word', now - 30), mk('mute', 'line', now - 40, -1),
  ...Array.from({ length: 20 }, (_, i) => mk(`n${i}`, 'line', now - 1)),
];
const q = R.dueQueue(cards, 'line', now);
assert.equal(q.length, R.SESSION_SIZE);
assert.deepEqual(q.slice(0, 2).map(x => x.id), ['a', 'b']);
assert.ok(!q.some(x => x.id === 'future' || x.id === 'w' || x.id === 'mute'));
assert.deepEqual(R.deckCounts(cards, now), { line: { due: 22, total: 24, remembered: 0 }, word: { due: 1, total: 1, remembered: 0 } });

// Ids: one sentence card per video line; word cards hang off it.
assert.equal(R.lineCardId('v1', 12.3), 'v1|12.30');
assert.equal(R.wordCardId('v1', 12.3, 'Friend'), 'v1|12.30|w|friend');

// Which word to blank.
assert.equal(R.wordIndexIn(['Hello', 'there,', 'friend.'], 'friend'), 2);
assert.equal(R.wordIndexIn(['I', "don't", 'know'], "Don't"), 1);
// Japanese: a word kept under another split still finds its box; English does not guess.
assert.equal(R.wordIndexIn(['今日は', 'いい', '天気ですね'], '天気'), 2);
assert.equal(R.wordIndexIn(['今日は', 'いい天気', 'ですね'], '天気ですね'), 1);
assert.equal(R.wordIndexIn(['Hello', 'there'], 'the'), 0);
assert.deepEqual(R.wordBoxes(['今日は', 'いい天気', 'ですね'], '天気ですね'), [1, 2]);
assert.deepEqual(R.wordBoxes(['今日は', 'いい', '天気ですね'], '今日はいい天気ですね'), [0, 1, 2], 'an older whole-line card blanks the whole line');
assert.deepEqual(R.wordBoxes(['Hello', 'there,', 'friend.'], 'friend'), [2]);

// Old bookmarks find their line by file name + text, nearest mm:ss wins.
const srt = '1\n00:00:01,000 --> 00:00:02,000\nYeah.\n\n2\n00:01:05,000 --> 00:01:07,500\nYeah.\n\n3\n00:01:10,000 --> 00:01:12,000\nOther line.\n';
const records = [
  { id: 'r1', videoFileName: 'a.mp4', displayName: 'a', videoPath: '/v/a.mp4', subtitleText: srt },
  { id: 'r2', videoFileName: 'b.mp4', displayName: 'b', subtitleText: srt },
];
const hit = R.matchLegacy({ text: 'Yeah.', videoName: 'a.mp4', timeDisplay: '01:04' }, records);
assert.equal(hit.record.id, 'r1');
assert.equal(hit.start, 65);
assert.equal(hit.end, 67.5);
assert.equal(R.matchLegacy({ text: 'Yeah.', videoName: 'gone.mp4', timeDisplay: '00:01' }, records), null);
assert.equal(R.matchLegacy({ text: 'Nope.', videoName: 'a.mp4', timeDisplay: '00:01' }, records), null);

// "Remembered" on the home screen: a line stable for a week or more; words and silent lines never count.
const stable = { ...fresh, fsrs: { ...fresh.fsrs, stability: R.REMEMBERED_DAYS } };
assert.ok(R.isRemembered(stable));
assert.ok(!R.isRemembered({ ...stable, fsrs: { ...stable.fsrs, stability: R.REMEMBERED_DAYS - 0.1 } }));
assert.ok(!R.isRemembered({ ...stable, deck: 'word' }));
assert.ok(!R.isRemembered({ ...stable, start: -1 }));
assert.ok(!R.isRemembered(fresh));
assert.equal(R.deckCounts([stable, fresh], now).line.remembered, 1);

// Language decks (utils/deckLang.ts): a card's language is its video's — set by hand,
// else guessed from the whole subtitle file; orphans by their siblings' lines.
const outL = join(tmpdir(), `decklang-${process.pid}.mjs`);
await build({ entryPoints: ['utils/deckLang.ts'], bundle: true, format: 'esm', outfile: outL });
const L = await import(outL);
const toSrt = lines => lines.map((t, i) => `${i + 1}\n00:00:0${i},000 --> 00:00:0${i},900\n${t}\n`).join('\n');
const esSrt = toSrt(['¿Qué es lo que quieres?', 'Yo no sé por qué está aquí.', 'Pero la casa es muy grande.']);
const jaSrt = toSrt(['今日はいい天気ですね。', 'それはちょっと難しいかもしれない。']);
const card = (id, videoId, text) => ({ ...base, id, videoId, text });
const langs = L.cardLangs([
  card('a', 'es1', 'Hola'),
  card('b', 'ja1', 'はい'),
  card('c', 'fixed', 'the cat'),              // guessed Spanish, set to English by hand
  card('d', 'zh', '你好'),                     // no dictionary language → Unsorted
  card('e', 'gone', 'Yo no sé qué es esto.'), // video deleted: judged by its siblings together
  card('f', 'gone', 'Pero la casa es muy grande.'),
  card('g', '', 'これは古いブックマークです'),     // old bookmark with no video: its own line
], [
  { id: 'es1', subtitleText: esSrt }, { id: 'ja1', subtitleText: jaSrt },
  { id: 'fixed', subtitleText: esSrt, lang: 'en' }, { id: 'zh', subtitleText: toSrt(['你好，我是小明。']) },
]);
assert.deepEqual(Object.fromEntries(langs), { a: 'es', b: 'ja', c: 'en', d: 'other', e: 'es', f: 'es', g: 'ja' });
// Unreadable / empty subtitles are Unsorted, never a crash.
assert.equal(L.videoLang({ id: 'x' }), 'other');

console.log('test-review: all passed');
