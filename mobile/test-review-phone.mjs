/**
 * Pure-logic checks for phone review & card library (mobile/review/cardFilter.ts, utils/review.ts,
 * utils/reviewDefer.ts, utils/deckLang.ts): language deck pills, search & filter, queue delete
 * & finished count, defer-to-back ordering, AnkiDroid status classification & export summary.
 * Run with: node mobile/test-review-phone.mjs
 */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = join(tmpdir(), `mobile-review-phone-${process.pid}.mjs`);
await build({
  stdin: {
    contents: [
      "export * from './mobile/review/cardFilter';",
      "export { cardLangs } from './utils/deckLang';",
      "export { dueQueue, newCard } from './utils/review';",
      "export { deferCard, readDeferred } from './utils/reviewDefer';",
    ].join('\n'),
    resolveDir: '.',
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: out,
  logLevel: 'error',
});

// Minimal localStorage stub for reviewDefer.ts
const ls = new Map();
globalThis.localStorage = {
  getItem: k => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => { ls.set(k, String(v)); },
  removeItem: k => { ls.delete(k); },
};

const {
  buildLangPills,
  resolveLangFilter,
  filterLibraryCards,
  unsentAnkiCount,
  removeCardFromQueue,
  shouldDeferCard,
  finishedCardCount,
  classifyAnkiStatus,
  buildExportSummary,
  cardScheduleLabel,
  stripHtmlPlain,
  cardLangs,
  dueQueue,
  newCard,
  deferCard,
  readDeferred,
} = await import(out);

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

const mk = (id, more = {}) => ({
  ...newCard(
    {
      id,
      deck: 'line',
      videoId: 'v-en',
      videoName: 'English Pod',
      text: 'Hello world today',
      start: 10,
      end: 13,
      ...more,
    },
    'saved',
    NOW - DAY,
  ),
  ...more,
});

const records = [
  { id: 'v-en', lang: 'en' },
  { id: 'v-ja', lang: 'ja' },
  { id: 'v-other' },
];

const cEn1 = mk('c-en-1', { videoId: 'v-en', videoName: 'Daily English', text: 'I love coffee in the morning.', fsrs: { ...mk('t').fsrs, due: NOW - 5000 } });
const cEn2 = mk('c-en-2', { videoId: 'v-en', videoName: 'Daily English', text: 'Take a rain check.', ankiAt: NOW - 1000, fsrs: { ...mk('t').fsrs, due: NOW + 2 * DAY } });
const cJa1 = mk('c-ja-1', { videoId: 'v-ja', videoName: 'NHK News', text: '今日はいい天気ですね。', fsrs: { ...mk('t').fsrs, due: NOW - 2000 } });
const cOther = mk('c-other', { videoId: 'v-other', videoName: 'Misc', text: '12345 67890', fsrs: { ...mk('t').fsrs, due: NOW - 1000 } });
const cWordJa = mk('w-ja-1', {
  deck: 'word',
  videoId: 'v-ja',
  videoName: 'NHK News',
  word: '天気',
  text: '今日はいい天気ですね。',
  definition: '<b>weather</b>',
  fsrs: { ...mk('t').fsrs, due: NOW - 3000 },
});
const cSilent = mk('c-silent', { videoId: '', videoName: 'Old Bookmark', start: -1, end: -1, text: 'Legacy bookmark' });

const all = [cEn1, cEn2, cJa1, cOther, cWordJa, cSilent];
const langs = cardLangs(all, records);

// 1. Language deck pills & fallback when switching deck
const linePills = buildLangPills(all, langs, 'line');
assert.deepEqual(
  linePills,
  [
    { lang: 'all', count: 5 },
    { lang: 'ja', count: 1 },
    { lang: 'en', count: 2 }, // cEn1, cEn2
    { lang: 'other', count: 2 }, // cOther ('12345 67890') + cSilent (short text with no video)
  ],
);
const wordPills = buildLangPills(all, langs, 'word');
assert.deepEqual(wordPills, [{ lang: 'all', count: 1 }, { lang: 'ja', count: 1 }]);
assert.equal(resolveLangFilter('en', wordPills), 'all', 'falls back to all when picked lang absent in deck');
assert.equal(resolveLangFilter('ja', wordPills), 'ja');

// 2. Filter by deck, language, search query (sentence / word / videoName) and sort (audio first, then due)
const allLines = filterLibraryCards(all, { deck: 'line', lang: 'all', langs, query: '' });
assert.equal(allLines[allLines.length - 1].id, 'c-silent', 'silent card sorted last');
const enLines = filterLibraryCards(all, { deck: 'line', lang: 'en', langs, query: '' });
assert.deepEqual(enLines.map(c => c.id), ['c-en-1', 'c-en-2']);
const searchedLine = filterLibraryCards(all, { deck: 'line', lang: 'all', langs, query: 'COFFEE' });
assert.deepEqual(searchedLine.map(c => c.id), ['c-en-1']);
const searchedWord = filterLibraryCards(all, { deck: 'word', lang: 'all', langs, query: '天気' });
assert.deepEqual(searchedWord.map(c => c.id), ['w-ja-1']);
assert.equal(unsentAnkiCount(enLines), 1, 'cEn1 unsent; cEn2 already sent');

// 3. Delete in review: removes later in-round repeats and excludes deleted card from finished count
const queue = [cEn1, cJa1, cEn1, cOther];
const afterDel = removeCardFromQueue(queue, 0, 'c-en-1');
assert.deepEqual(afterDel.map(c => c.id), ['c-en-1', 'c-ja-1', 'c-other'], 'later repeat of c-en-1 removed');
assert.equal(finishedCardCount(afterDel, new Set(['c-en-1'])), 2);
assert.equal(finishedCardCount(afterDel, new Set()), 3, 'restoring brings count back to 3');

// 4. Defer on skip / mid-session exit + dueQueue ordering
assert.equal(shouldDeferCard(cEn1, false, new Set()), true);
assert.equal(shouldDeferCard(cEn1, false, new Set(['c-en-1'])), false, 'already graded Again this round is not deferred');
assert.equal(shouldDeferCard(cEn1, true, new Set()), false, 'done screen does not defer');

deferCard('c-en-1', NOW + 10);
deferCard('c-ja-1', NOW + 20);
const ordered = dueQueue([cEn1, cJa1, cOther], 'line', NOW, 15, readDeferred());
assert.deepEqual(
  ordered.map(c => c.id),
  ['c-other', 'c-en-1', 'c-ja-1'],
  'non-deferred first, then deferred in defer order',
);

// Grading a deferred card invalidates its older defer timestamp
const gradedEn1 = { ...cEn1, fsrs: { ...cEn1.fsrs, due: NOW - 6000, last_review: NOW + 100 } };
const orderedAfterGrade = dueQueue([gradedEn1, cJa1, cOther], 'line', NOW, 15, readDeferred());
assert.deepEqual(orderedAfterGrade.map(c => c.id), ['c-en-1', 'c-other', 'c-ja-1']);

// 5. AnkiDroid status classification (including installed + permitted but uninitialized)
assert.equal(classifyAnkiStatus(null), 'loading');
assert.equal(classifyAnkiStatus({ installed: false, permitted: false, apiAvailable: false }), 'not_installed');
assert.equal(classifyAnkiStatus({ installed: true, permitted: false, apiAvailable: false }), 'no_permission');
assert.equal(classifyAnkiStatus({ installed: true, permitted: true, apiAvailable: false }), 'not_initialized');
assert.equal(classifyAnkiStatus({ installed: true, permitted: true, apiAvailable: true, version: '2.19.0' }), 'ready');

// 6. Export summary formatting
const summary = buildExportSummary({
  sent: ['a', 'b'],
  skipped: 1,
  silent: 1,
  refused: 2,
  unmarked: 1,
  stopped: { why: 'anki', error: 'anki:api_unavailable' },
});
assert.equal(summary.headlineKey, 'm.ankiSentSummary');
assert.equal(summary.sentCount, 2);
assert.deepEqual(summary.notes.map(n => [n.key, n.n]), [
  ['m.ankiNoteSkipped', 1],
  ['m.ankiNoteSilent', 1],
  ['m.ankiNoteRefused', 2],
  ['m.ankiNoteUnmarked', 1],
]);
assert.equal(summary.stopped?.key, 'm.ankiStoppedAnki');

const emptySummary = buildExportSummary({ sent: [], skipped: 3, silent: 0, refused: 0, unmarked: 0 });
assert.equal(emptySummary.headlineKey, 'm.ankiSentNone');
assert.equal(emptySummary.stopped, undefined);

// 7. Schedule labels & plain HTML stripping
assert.equal(cardScheduleLabel(cSilent, NOW).kind, 'noAudio');
assert.equal(cardScheduleLabel({ ...cEn1, mastered: NOW }, NOW).kind, 'mastered');
assert.equal(cardScheduleLabel(cEn1, NOW).kind, 'dueNow');
assert.equal(cardScheduleLabel({ ...cEn1, fsrs: { ...cEn1.fsrs, due: NOW + DAY } }, NOW).kind, 'tomorrow');
assert.equal(cardScheduleLabel(cEn2, NOW).kind, 'inDays');
assert.equal(stripHtmlPlain('<b>weather</b> <i>noun</i>'), 'weather noun');

console.log('mobile review phone ok');
