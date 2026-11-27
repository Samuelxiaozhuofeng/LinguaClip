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
      "export { checkDictation } from './mobile/dictation';",
      "export { filterPairedNearExtras, groupGradedPieces } from './mobile/gradedPieces';",
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
  roundSummaryCounts,
  pickContinueRecord,
  classifyAnkiStatus,
  buildExportSummary,
  cardScheduleLabel,
  stripHtmlPlain,
  checkDictation,
  filterPairedNearExtras,
  groupGradedPieces,
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

// 8. Accurate round summary counts (only graded or mastered count; skipped & deleted count as unfinished)
assert.deepEqual(
  roundSummaryCounts([cEn1, cJa1, cOther], new Set(['c-en-1', 'c-ja-1']), new Set()),
  { completed: 2, unfinished: 1 },
  '1 skipped card counted in unfinished',
);
assert.deepEqual(
  roundSummaryCounts([cEn1, cJa1, cEn1, cOther], new Set(['c-en-1']), new Set(['c-en-1', 'c-other'])),
  { completed: 0, unfinished: 3 },
  'deleted card never counts as completed even if graded Again earlier',
);
assert.deepEqual(
  roundSummaryCounts([cEn1, cJa1], new Set(['c-en-1', 'c-ja-1']), new Set()),
  { completed: 2, unfinished: 0 },
  'all graded -> 0 unfinished',
);

// 9. Review-done "Continue" record selection (most recent playable record)
const recsForContinue = [
  { id: 'r-old', displayName: 'Old Ep', videoPath: 'https://example.com/old.mp3', lastPracticed: 100 },
  { id: 'r-job', displayName: 'Importing', videoPath: 'https://example.com/j.mp3', lastPracticed: 999, importJob: { stage: 'cloud', source: 'x' } },
  { id: 'r-missing-blob', displayName: 'Missing Blob', videoPath: 'blob:gone', lastPracticed: 800 },
  { id: 'r-latest', displayName: 'Latest Ep', videoPath: 'https://example.com/new.mp3', lastPracticed: 500 },
  { id: 'r-no-audio', displayName: 'No Audio', videoPath: '', lastPracticed: 700 },
];
assert.equal(pickContinueRecord(recsForContinue, { haveBlobs: new Set(['present']) })?.id, 'r-latest');
assert.equal(pickContinueRecord(recsForContinue, { haveBlobs: new Set(['gone']) })?.id, 'r-missing-blob');
assert.equal(pickContinueRecord(recsForContinue, { android: true })?.id, 'r-latest', 'android skips blob: paths');
assert.equal(pickContinueRecord(recsForContinue, { android: true, missingAndroid: new Set(['r-latest']) })?.id, 'r-old');
assert.equal(pickContinueRecord([]), null);

// 10. Review-done "Continue" includes subtitle-only desktop records when no playable audio exists (matches Home.tsx)
const subOnlyRecs = [
  { id: 'desk-empty', displayName: 'Empty Sub', videoPath: '', subtitleText: '   ', lastPracticed: 950 },
  { id: 'desk-job', displayName: 'Importing Sub', videoPath: '', subtitleText: '1\n00:00:00,000 --> 00:00:02,000\nHi', lastPracticed: 900, importJob: { stage: 'cloud', source: 'x' } },
  { id: 'desk-no-path', displayName: 'No Path Sub', videoPath: '', subtitleText: '1\n00:00:00,000 --> 00:00:02,000\nHello', lastPracticed: 600 },
  { id: 'desk-local', displayName: 'Desktop Path', videoPath: '/Users/alice/ep.mp4', subtitleText: '1\n00:00:00,000 --> 00:00:02,000\nWorld', lastPracticed: 800 },
];
assert.equal(pickContinueRecord(subOnlyRecs)?.id, 'desk-local', 'web falls back to most recent subtitle-only record');
assert.equal(
  pickContinueRecord(subOnlyRecs, { android: true, missingAndroid: new Set(['desk-local']) })?.id,
  'desk-local',
  'android falls back to subtitle-only record when all local audio files are missing',
);
assert.equal(
  pickContinueRecord([...subOnlyRecs, { id: 'playable', displayName: 'Playable', videoPath: 'https://example.com/a.mp3', lastPracticed: 100 }])?.id,
  'playable',
  'playable audio still takes precedence over newer subtitle-only records',
);
assert.equal(pickContinueRecord([subOnlyRecs[0], subOnlyRecs[1]]), null, 'blank subtitle or active import job ignored');

// 11. Review dictation near-miss display: paired near-miss input is never double-marked as extra
const nearSimple = checkDictation('I walked home', 'I walk home', true);
const filteredSimple = filterPairedNearExtras(nearSimple.pieces);
assert.equal(filteredSimple.filter(p => p.kind === 'extra').length, 0, 'paired walk is not shown as struck-through extra');
assert.equal(filteredSimple.filter(p => p.kind === 'miss' && p.near).length, 1, 'walked stays marked as near');
assert.equal(filteredSimple.map(p => p.s).join(''), 'I walked home', 'spacing remains exact after suppressing paired extra');

const nearWithTrueExtra = checkDictation('I walked home', 'I very walk home', true);
const filteredWithExtra = filterPairedNearExtras(nearWithTrueExtra.pieces);
assert.deepEqual(filteredWithExtra.filter(p => p.kind === 'extra').map(p => p.s), ['very'], 'genuinely extra word stays struck through');
assert.equal(filteredWithExtra.filter(p => p.kind === 'miss' && p.near).length, 1);

const nearDupTyped = checkDictation('I walked home', 'I walk walk home', true);
const filteredDup = filterPairedNearExtras(nearDupTyped.pieces);
assert.deepEqual(filteredDup.filter(p => p.kind === 'extra').map(p => p.s), ['walk'], 'only one copy of duplicated typed word is consumed by near pairing');

const nearTwo = checkDictation('walked talked', 'walk talk', true);
const filteredTwo = filterPairedNearExtras(nearTwo.pieces);
assert.equal(filteredTwo.filter(p => p.kind === 'extra').length, 0);
assert.equal(filteredTwo.map(p => p.s).join(''), 'walked talked');
assert.equal(groupGradedPieces(nearSimple.pieces).filter(g => g.piece?.kind === 'extra').length, 0);

console.log('mobile review phone ok');
