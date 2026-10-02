/**
 * Checks the pure part of backup / restore (utils/backup.ts, docs/backup.md):
 * which settings go in, the check, path moving, the daily trigger and rotation.
 * Run with: node test-backup.mjs
 *
 * Bundles the real module (same as the other test-*.mjs) so this fails when it drifts.
 */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = join(tmpdir(), `backup-${process.pid}.mjs`);
// review.ts too, so the cards checked here are the shape the app really writes (newCard).
await build({
  stdin: { contents: "export * from './utils/backup'; export { newCard, schedule } from './utils/review';", resolveDir: '.', loader: 'ts' },
  bundle: true, format: 'esm', outfile: out, logLevel: 'error',
});
const B = await import(out);

// --- backupKeys: our settings by prefix + two import choices, never this computer's own state ---
const keys = [
  'linguaclip_practice_config', 'linguaclip_ai_config', 'linguaclip_transcribe_config', 'linguaclip_some_future_key',
  'import_lang', 'import_trash_original',
  'linguaclip_pro_license', 'linguaclip_anki_tpl', 'linguaclip_today', 'linguaclip_restore_pending',
  'other_app_key', 'lang',
];
assert.deepEqual(B.backupKeys(keys), [
  'linguaclip_practice_config', 'linguaclip_ai_config', 'linguaclip_transcribe_config', 'linguaclip_some_future_key',
  'import_lang', 'import_trash_original',
]);

// --- remapPath ---
assert.equal(B.remapPath('/Users/amy/Movies/LinguaClip/a b.mp4', '/Users/amy/Movies/LinguaClip', '/Users/bob/Movies/LinguaClip'),
  '/Users/bob/Movies/LinguaClip/a b.mp4', 'Mac → Mac, other user name');
assert.equal(B.remapPath('/Users/amy/Movies/LinguaClip/sub/x.mp4', '/Users/amy/Movies/LinguaClip/', 'C:\\Users\\bob\\Videos\\LinguaClip'),
  'C:\\Users\\bob\\Videos\\LinguaClip\\sub\\x.mp4', 'Mac → Windows');
assert.equal(B.remapPath('C:\\Users\\bob\\Videos\\LinguaClip\\x.mp4', 'C:\\Users\\bob\\Videos\\LinguaClip', '/Users/amy/Movies/LinguaClip'),
  '/Users/amy/Movies/LinguaClip/x.mp4', 'Windows → Mac');
assert.equal(B.remapPath('/Users/amy/Movies/LinguaClip2/x.mp4', '/Users/amy/Movies/LinguaClip', '/Users/bob/Movies/LinguaClip'),
  '/Users/amy/Movies/LinguaClip2/x.mp4', 'sibling LinguaClip2 stays');
assert.equal(B.remapPath('/Volumes/Disk/show.mp4', '/Users/amy/Movies/LinguaClip', '/Users/bob/Movies/LinguaClip'),
  '/Volumes/Disk/show.mp4', 'outside the folder stays');
assert.equal(B.remapPath('/Users/amy/Movies/LinguaClip', '/Users/amy/Movies/LinguaClip', '/x'), '/Users/amy/Movies/LinguaClip', 'the folder itself stays');

// --- checkBackup ---
const DAY = 86400000;
const video = (over = {}) => ({
  id: 'v1', displayName: 'a.mp4', videoFileName: 'a.mp4', subtitleFileName: 'a.srt', subtitleText: '1\n00:00:01,000 --> 00:00:02,000\nHi\n',
  videoPath: '/Users/amy/Movies/LinguaClip/a.mp4', currentSubtitleIndex: 0, currentSectionIndex: 0, totalSubtitles: 1, completionRate: 0,
  dateAdded: 1, lastPracticed: 1, totalPracticeTime: 0, ...over,
});
// A real card as the app makes it (graded once, so last_review is set), with a clip.
const card = (over = {}) => ({
  ...B.schedule(B.newCard({ id: 'v1|1.00', deck: 'line', videoId: 'v1', videoName: 'a.mp4', videoPath: '/Users/amy/Movies/LinguaClip/a.mp4', text: 'Hi', start: 1, end: 2 }, 'saved', 1), 3, 2),
  clip: { kind: 'video', file: 'v1_1.00.mp4', from: 0 }, ...over,
});
const wordCard = (over = {}) => ({
  ...B.newCard({ id: 'v1|1.00|w|hi', deck: 'word', videoId: 'v1', videoName: 'a.mp4', text: 'Hi', start: 1, end: 2, word: 'hi', definition: 'hello', example: 'Hi there.' }, 'lookup', 1),
  ...over,
});
const make = ({ videos = [video()], cards = [card()], ls = { linguaclip_lang: 'zh' }, m = {} } = {}) => ({
  manifest: { format: 1, app: '0.2.1', createdAt: Date.now(), platform: 'mac', ownDir: '/Users/amy/Movies/LinguaClip',
    videos: videos.length, cards: cards.length, hadLicense: false, files: true, clips: B.clipFiles(cards), ...m },
  data: { videos, cards, reviewMeta: [{ id: 'migrated', at: 1, count: 0 }], localStorage: ls },
});
const check = b => B.checkBackup(b.manifest, b.data, '0.2.1');
assert.equal(check(make()), null, 'a good backup passes');
assert.equal(check(make({ videos: [video({ videoFileName: 'https://www.youtube.com/watch?v=abc', videoPath: undefined, importJob: { stage: 'download', source: 'https://www.youtube.com/watch?v=abc', error: 'x' } })] })), null,
  'a record whose videoFileName is a URL (unfinished import) passes');
assert.equal(check(make({ videos: [video({ subtitleFileName: '' })] })), null, 'no subtitle file name passes');
assert.equal(check(make({ cards: [card(), wordCard(), B.newCard({ id: 'legacy|7', deck: 'line', videoId: '', videoName: '', text: 'Old', start: -1, end: -1 }, 'saved', 1)] })), null,
  'line, word and unmatched old-bookmark cards pass');
assert.equal(check(make({ videos: [video({ id: 'podcast-episode-1', podcast: { show: 'S', feed: 'https://f', guid: 'g', name: 'ep' } })] })), null,
  'a non-UUID id and a podcast episode pass');
assert.equal(check(make({ videos: [video({ importJob: { stage: 'segment', percent: undefined, source: '/a.mkv', lang: 'en', quality: 1080, subs: 'own', trashOriginal: true, converted: '/a.mp4', convert: true } })] })), null,
  'every import field, set as the app sets them, passes');
assert.deepEqual(check(make({ m: { format: 2 } })), { newer: true, why: 'format' }, 'format too new');
assert.equal(check(make({ m: { app: '0.3.0' } })).newer, true, 'app version too new');
assert.equal(check(make({ m: { app: '0.2.0' } })), null, 'older app version is fine');
const rejects = {
  'record without id': make({ videos: [video({ id: undefined })] }),
  'record without subtitles': make({ videos: [video({ subtitleText: undefined })] }),
  'card without id': make({ cards: [card({ id: undefined })] }),
  'card without fsrs': make({ cards: [card({ fsrs: undefined })] }),
  'card fsrs.due not a number': make({ cards: [card({ fsrs: { due: '2026', state: 0, stability: 0 } })] }),
  'clip.file with ../': make({ cards: [card({ clip: { kind: 'video', file: '../x.mp4', from: 0 } })], m: { clips: [] } }),
  'clip.image with a folder': make({ cards: [card({ clip: { kind: 'audio', file: 'a.m4a', image: 'a/b.jpg', from: 0 } })], m: { clips: [] } }),
  'subtitleFileName with ../': make({ videos: [video({ subtitleFileName: '../../x.srt' })] }),
  'subtitleFileName with a backslash': make({ videos: [video({ subtitleFileName: '..\\x.srt' })] }),
  'localStorage value not a string': make({ ls: { linguaclip_lang: 3 } }),
  'manifest counts disagree': make({ m: { videos: 5 } }),
  'manifest clip name with ../': make({ m: { clips: ['../x'] } }),
  // ids that would turn into paths (a record's caches, the card's video)
  'video id climbing folders': make({ videos: [video({ id: '../../Documents/x' })] }),
  'video id with a backslash': make({ videos: [video({ id: '..\\x' })] }),
  'card videoId climbing folders': make({ cards: [card({ videoId: '../x' })] }),
  // repeated keys would silently replace each other
  'two records with one id': make({ videos: [video(), video({ displayName: 'other' })] }),
  'two cards with one id': make({ cards: [card(), card({ text: 'other' })] }),
  'two meta rows with one id': (() => { const b = make(); b.data.reviewMeta.push({ id: 'migrated' }); return b; })(),
  // types the app start and the shelves read straight away
  'importJob.error not a string': make({ videos: [video({ importJob: { stage: 'download', source: 'x', error: 42 } })] }),
  'importJob.subs neither own nor a number': make({ videos: [video({ importJob: { stage: 'download', source: 'x', subs: 'all' } })] }),
  'record totalPracticeTime not a number': make({ videos: [video({ totalPracticeTime: 'x' })] }),
  'record lastPracticed a string': make({ videos: [video({ lastPracticed: '2026' })] }),
  'podcast without a show': make({ videos: [video({ podcast: { feed: 'f', guid: 'g', name: 'n' } })] }),
  'word card word not a string': make({ cards: [wordCard({ word: 7 })] }),
  'word card definition an object': make({ cards: [wordCard({ definition: {} })] }),
  'card example a number': make({ cards: [wordCard({ example: 1 })] }),
  'card saved not a boolean': make({ cards: [card({ saved: 'yes' })] }),
  'card reasons not strings': make({ cards: [card({ reasons: [1] })] }),
  'card fsrs learning_steps not a number': make({ cards: [card({ fsrs: { ...card().fsrs, learning_steps: 'x' } })] }),
  'card clip kind unknown': make({ cards: [card({ clip: { kind: 'gif', file: 'a.gif', from: 0 } })] }),
};
for (const [what, b] of Object.entries(rejects)) {
  const p = check(b);
  assert.ok(p && !p.newer, `should reject: ${what}`);
}
assert.ok(B.checkBackup(null, {}, '0.2.1'), 'no manifest');
assert.ok(B.checkBackup(make().manifest, { videos: {}, cards: [], reviewMeta: [], localStorage: {} }, '0.2.1'), 'videos not an array');
// Records written by old versions lack (or hold null in) the later fields: the user's own data must pass.
assert.equal(check(make({ videos: [video({ totalPracticeTime: undefined, lastPracticed: null, videoPath: null, displayName: undefined })] })), null, 'old-shape record passes');
assert.equal(check(make({ videos: [video({ subtitleFileName: undefined })], cards: [card({ videoId: null })] })), null, 'no subtitle file name / no video id passes');
assert.equal(check(make({ cards: [card({ saved: undefined, reasons: undefined, createdAt: undefined, fsrs: { ...card().fsrs, learning_steps: undefined } })] })), null, 'old-shape card passes');

// --- compareVersions ---
assert.equal(B.compareVersions('0.2.10', '0.2.9'), 1);
assert.equal(B.compareVersions('0.2', '0.2.0'), 0);
assert.equal(B.compareVersions('1.0.0-beta', '1.0.0'), 0);
assert.equal(B.compareVersions('0.1.9', '0.2.0'), -1);

// --- restoring settings: AI / transcription settings already here are never touched ---
{
  const current = { linguaclip_ai_config: 'mine', linguaclip_lang: 'en', linguaclip_old: 'x', linguaclip_pro_license: 'L', linguaclip_today: 'T', other: 'o' };
  const backup = { linguaclip_ai_config: 'theirs', linguaclip_transcribe_config: 'theirs-t', linguaclip_lang: 'zh', linguaclip_pro_license: 'evil' };
  const plan = B.planLocalStorage(current, backup);
  assert.deepEqual(Object.fromEntries(plan.set), { linguaclip_transcribe_config: 'theirs-t', linguaclip_lang: 'zh' },
    'local AI settings kept, missing transcription settings taken, license never written');
  assert.deepEqual(plan.remove, ['linguaclip_old'], 'only in-range keys missing from the backup go; secrets / license / today stay');
  // A computer with neither secret key takes both.
  assert.deepEqual(B.planLocalStorage({}, backup).set.map(([k]) => k).sort(), ['linguaclip_ai_config', 'linguaclip_lang', 'linguaclip_transcribe_config']);
}

// --- empty / daily trigger ---
assert.equal(B.isEmpty({ videos: [], cards: [] }), true, 'nothing to back up automatically');
assert.equal(B.isEmpty({ videos: [], cards: [card()] }), false);
const at = (y, mo, d, h = 12) => new Date(y, mo - 1, d, h).getTime();
const entry = (kind, t, size = 1, name = t) => ({ path: `/x/backups/LinguaClip-${kind}-${name}.zip`, manifest: { createdAt: t, videos: size, cards: 0 } });
const now = at(2026, 10, 2, 9);
assert.equal(B.dueForAuto([], now, false), true, 'none yet → due');
assert.equal(B.dueForAuto([entry('auto', at(2026, 10, 1, 23))], now, false), true, 'yesterday only → due');
assert.equal(B.dueForAuto([entry('auto', at(2026, 10, 2, 0))], now, false), false, 'today already → not due');
assert.equal(B.dueForAuto([entry('pre', at(2026, 10, 2, 8))], now, false), true, 'a before-restore one does not count');
assert.equal(B.dueForAuto([], now, true), false, 'restore under way → not due');
assert.equal(B.lastAuto([entry('pre', 50), entry('auto', 30), entry('auto', 40)]), 40);
assert.equal(B.lastAuto([entry('pre', 50)]), null);

// --- rotate ---
{
  const autos = Array.from({ length: 10 }, (_, i) => entry('auto', (i + 1) * DAY, 5)); // day 1 … day 10
  assert.deepEqual(B.rotate(autos).sort(), [1, 2, 3].map(i => `LinguaClip-auto-${i * DAY}.zip`).sort(), 'daily: newest 7 stay');
  // A big old one (data lost since) stays on top of the 7; only one extra.
  const big = [...autos.slice(3), entry('auto', 2 * DAY, 50), entry('auto', 1 * DAY, 40), entry('auto', 0.5 * DAY, 60, 'older')];
  assert.deepEqual(B.rotate(big).sort(), [`LinguaClip-auto-${2 * DAY}.zip`, `LinguaClip-auto-${1 * DAY}.zip`].sort(), 'the biggest old one is kept');
  // Not bigger than every one of the newest 7 → no exception.
  const tie = [...autos.slice(3), entry('auto', 1 * DAY, 5)];
  assert.deepEqual(B.rotate(tie), [`LinguaClip-auto-${1 * DAY}.zip`]);
  const pres = Array.from({ length: 5 }, (_, i) => entry('pre', (i + 1) * DAY));
  assert.deepEqual(B.rotate([...pres, ...autos.slice(5)]).sort(), [`LinguaClip-pre-${DAY}.zip`, `LinguaClip-pre-${2 * DAY}.zip`].sort(), 'before-restore: newest 3, apart from the daily ones');
  assert.deepEqual(B.rotate([...autos, { path: '/x/backups/mine.zip', manifest: { createdAt: 99 * DAY, videos: 0, cards: 0 } }]).length, 3,
    'other zips are left alone and do not count');
  // One of ours without proper counts / time: nothing is deleted at all.
  for (const broken of [{ createdAt: 11 * DAY, cards: 0 }, { createdAt: 11 * DAY, videos: 1, cards: 'x' }, { videos: 1, cards: 0 }]) {
    assert.deepEqual(B.rotate([...autos, { path: '/x/backups/LinguaClip-auto-bad.zip', manifest: broken }]), [], `broken manifest ${JSON.stringify(broken)} → delete nothing`);
  }
  // A broken zip that isn't ours doesn't stop rotation.
  assert.equal(B.rotate([...autos, { path: '/x/backups/mine.zip', manifest: {} }]).length, 3);
  assert.equal(B.countsOk({ path: 'x', manifest: { createdAt: 1, videos: 1 } }), false, 'not listed for restore without a card count');
  assert.equal(B.countsOk(entry('auto', 5)), true);
}

// --- clip names in a manifest = what the cards use ---
assert.deepEqual(B.clipFiles([card(), card({ clip: { kind: 'audio', file: 'b.m4a', image: 'b.jpg', from: 0 } }), card({ clip: undefined }), card()]),
  ['v1_1.00.mp4', 'b.m4a', 'b.jpg']);

console.log('test-backup: all passed');
