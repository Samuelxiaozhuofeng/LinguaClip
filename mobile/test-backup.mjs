/**
 * The phone backup's pure part (mobile/backup.ts): what goes in, the check, settings on restore,
 * the audio a backup points at, the restore marker.
 * Run with: node mobile/test-backup.mjs
 */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = join(tmpdir(), `mobile-backup-${process.pid}.mjs`);
await build({ stdin: { contents: "export * from './mobile/backup'; export { checkBackup, clipFiles } from './utils/backup';", resolveDir: '.', loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error' });
const {
  makeBackup, checkMobile, parseBackup, fromDesktopBackup, buildAndroidZipPayload,
  pickLocal, planLocal, blobId, blobIds, orphanAudio, readPending, BackupProblem, checkBackup, clipFiles,
} = await import(out);

const video = (id, extra = {}) => ({ id, displayName: id, subtitleText: '1\n00:00:00,000 --> 00:00:01,000\nhi\n', videoPath: `blob:${id}`, ...extra });
const card = (id, extra = {}) => ({ id, deck: 'line', text: 'hi', start: 0, end: 1, videoId: 'a', videoPath: 'blob:a', fsrs: { due: 1, stability: 0, state: 0 }, ...extra });
const local = {
  linguaclip_watch_pos: '{"a":3}', import_lang: 'ja', other_app: 'x',
  linguaclip_ai_config: '{"apiKey":"sk-1"}', linguaclip_transcribe_config: '{"groqKey":"gsk_1"}',
  linguaclip_restore_pending: '{"use":"staged","tries":0}', linguaclip_pro_license: 'L', linguaclip_today: 'T',
};
const good = () => makeBackup({ videos: [video('a'), video('b', { videoPath: 'https://x/ep.mp3' })], cards: [card('c1'), card('c2'), card('c3', { videoPath: 'blob:gone' })],
  meta: [{ id: 'savedLinesMigrated', v: true }], local, cache: { 'a|words': '[]', 'b|trans': '{}' } }, 1700000000000);

// What goes in: keys and this-phone-only state never.
const b = good();
assert.deepEqual(Object.keys(b.local).sort(), ['import_lang', 'linguaclip_watch_pos']);
assert.equal(b.v, 1);
assert.equal(b.platform, 'mobile');
assert.equal(checkMobile(b), null);
assert.deepEqual(parseBackup(JSON.stringify(b)), b);
assert.ok(!JSON.stringify(b).includes('gsk_1') && !JSON.stringify(b).includes('sk-1'));
assert.deepEqual(Object.keys(pickLocal(local)).sort(), ['import_lang', 'linguaclip_watch_pos']);

// Refused, with the reason.
const code = text => { try { parseBackup(text); return 'ok'; } catch (e) { assert.ok(e instanceof BackupProblem); return e.code; } };
assert.equal(code('PK\u0003\u0004 zip bytes'), 'desktop');
assert.equal(code(JSON.stringify({ format: 1, app: '0.6.0', createdAt: 1 })), 'desktop'); // a desktop manifest.json
assert.equal(code(JSON.stringify({ videos: [], cards: [], reviewMeta: [], localStorage: {} })), 'desktop'); // desktop data.json
assert.equal(code('not json {'), 'bad');
assert.equal(code('{"hello":1}'), 'bad');
assert.equal(code('[]'), 'bad');
assert.equal(code(JSON.stringify({ ...b, v: 2 })), 'newer');
assert.equal(code(JSON.stringify({ ...b, v: 0 })), 'bad');
assert.equal(code(JSON.stringify({ ...b, v: '1' })), 'bad');
assert.equal(code(JSON.stringify({ ...b, platform: 'mac' })), 'bad');
assert.equal(code(JSON.stringify({ ...b, at: undefined })), 'bad');
assert.equal(code(JSON.stringify({ ...b, videos: undefined })), 'bad');
assert.equal(code(JSON.stringify({ ...b, review: { cards: [] } })), 'bad');
assert.equal(code(JSON.stringify({ ...b, review: { ...b.review, cards: [card('x', { fsrs: undefined })] } })), 'bad');
assert.equal(code(JSON.stringify({ ...b, videos: [{ id: 'a' }] })), 'bad'); // no subtitleText
assert.equal(code(JSON.stringify({ ...b, videos: [video('a'), video('a')] })), 'bad'); // repeated id
assert.equal(code(JSON.stringify({ ...b, videos: [video('../a')] })), 'bad');
assert.equal(code(JSON.stringify({ ...b, local: { linguaclip_x: 1 } })), 'bad');
assert.equal(code(JSON.stringify({ ...b, cache: { 'a|words': 3 } })), 'bad');
assert.equal(code(JSON.stringify({ ...b, cache: { nopipe: 'x' } })), 'bad');
assert.equal(code(JSON.stringify(b)), 'ok');

// A podcast title with '/' (importAudio names the transcript `${id}.srt`): the backup still passes.
const slash = video('p1', { displayName: 'Q / A', videoFileName: 'Q / A', subtitleFileName: 'p1.srt', videoPath: 'https://x/ep.mp3' });
assert.equal(checkMobile(makeBackup({ videos: [slash], cards: [], meta: [], local: {}, cache: {} }, 1)), null);
assert.equal(code(JSON.stringify({ ...b, videos: [{ ...slash, subtitleFileName: 'Q / A.srt' }] })), 'bad'); // why the title can't be used

// Restoring settings: backup's in, in-range ones it lacks go; keys and this-phone state stay.
const now = { linguaclip_watch_pos: '{"z":1}', linguaclip_reader_font: '18', linguaclip_transcribe_config: '{"groqKey":"gsk_now"}',
  linguaclip_ai_config: '{"apiKey":"sk-now"}', linguaclip_restore_pending: 'P', linguaclip_pro_license: 'L', other_app: 'x' };
const sneaky = { ...b.local, linguaclip_transcribe_config: '{"groqKey":"gsk_old"}', linguaclip_restore_pending: 'X' };
const plan = planLocal(now, sneaky);
assert.deepEqual(plan.set.sort(), [['import_lang', 'ja'], ['linguaclip_watch_pos', '{"a":3}']]);
assert.deepEqual(plan.remove, ['linguaclip_reader_font']);
// A phone without keys still doesn't take them from a backup.
assert.ok(!planLocal({}, sneaky).set.some(([k]) => k === 'linguaclip_transcribe_config'));

// The audio a backup points at.
assert.equal(blobId('blob:abc'), 'abc');
assert.equal(blobId('blob:https://x/y'), null);
assert.equal(blobId('https://x/y.mp3'), null);
assert.equal(blobId('blob:'), null);
assert.equal(blobId(undefined), null);
assert.deepEqual(blobIds(b).sort(), ['a', 'a', 'a', 'gone'].sort());
assert.deepEqual(blobIds({ videos: [video('j', { videoPath: undefined, importJob: { stage: 'cloud', source: 'blob:j' } })], review: { cards: [] } }), ['j']);

// Orphan audio: kept while a record, an unfinished import, a card or a restore copy points at it.
assert.deepEqual(orphanAudio(['a', 'j', 'c', 'p', 'x'],
  [video('a'), video('j', { videoPath: undefined, importJob: { stage: 'cloud', source: 'blob:j' } })],
  [card('k', { videoId: 'gone', videoPath: 'blob:c' })],
  [{ videos: [video('p')], review: { cards: [] } }]), ['x']);
assert.deepEqual(orphanAudio(['c'], [], [], []), ['c']); // no card left: swept

// The marker.
assert.equal(readPending(null), null);
assert.equal(readPending('{'), 'unreadable');
assert.equal(readPending('{"use":"other","tries":0}'), 'unreadable');
assert.deepEqual(readPending('{"use":"pre","tries":2,"x":1}'), { use: 'pre', tries: 2 });
assert.deepEqual(readPending('{"use":"staged","tries":0,"zip":"/tmp/x.zip","cross":true}'), { use: 'staged', tries: 0, zip: '/tmp/x.zip', cross: true });

// Desktop zip -> Android conversion & settings downgrade
{
  const m = { format: 1, app: '0.10.0', createdAt: 1700000000000, ownDir: '/Users/x', videos: 1, cards: 1, hadLicense: false, files: true, clips: ['c.m4a'] };
  const d = {
    videos: [video('d1', { videoPath: '/Users/x/a.mp3' })],
    cards: [card('c1', { videoId: 'd1', videoPath: '/Users/x/a.mp3', clip: { kind: 'audio', file: 'c.m4a', from: 0 } })],
    reviewMeta: [{ id: 'migrated' }],
    localStorage: { linguaclip_lang: 'zh', linguaclip_keys: '{}', linguaclip_transcribe_config: '{"mode":"local","gpu":true,"groqKey":"gsk_1"}' },
  };
  const conv = fromDesktopBackup(m, d, '0.10.0');
  assert.equal(conv.videos.length, 1);
  assert.equal(conv.review.cards.length, 1);
  // Cross-platform restore checks format version only, allowing desktop/Android app versions to differ.
  assert.equal(fromDesktopBackup({ ...m, app: '0.11.0' }, d, '0.10.0').videos.length, 1);
  assert.throws(() => fromDesktopBackup({ ...m, format: 2 }, d, '0.10.0'), e => e instanceof BackupProblem && e.code === 'newer');
  const p = planLocal({ linguaclip_android_battery_dismissed: '1' }, conv.local, { crossPlatform: true, target: 'android' });
  const sm = Object.fromEntries(p.set);
  assert.equal('linguaclip_keys' in sm, false);
  assert.equal(JSON.parse(sm.linguaclip_transcribe_config).mode, 'cloud');
  assert.deepEqual(p.remove, []);
}

// Android native .zip export payload & same-platform restore with keys
{
  const cardsWithClips = [
    card('c1', { clip: { kind: 'audio', file: 'a_1.m4a', from: 1 } }),
    card('c2', { clip: { kind: 'audio', file: 'a_2.m4a', image: 'a_2.jpg', from: 2 } }),
  ];
  const androidLocal = {
    ...local,
    linguaclip_android_battery_dismissed: '1',
    linguaclip_podcast_wifi_only: '1',
    linguaclip_transcribe_config: JSON.stringify({ mode: 'custom', customUrl: 'https://asr.test/v1', customKey: 'sk-c', customModel: 'whisper-1' }),
  };

  // includeKeys: true keeps SECRET_KEYS and Android settings, excludes LOCAL_ONLY & non-app keys.
  const withKeys = buildAndroidZipPayload({
    videos: [video('a', { videoPath: '/data/user/0/com.linguaclip.app/files/media/a.m4a' })],
    cards: cardsWithClips,
    meta: [{ id: 'migrated', v: true }],
    local: androidLocal,
    appVersion: '0.10.0',
    ownDir: '/data/user/0/com.linguaclip.app/files',
    includeKeys: true,
    createdAt: 1700000001234,
  });
  assert.equal(withKeys.manifest.platform, 'android');
  assert.equal(withKeys.manifest.files, true);
  assert.equal(withKeys.manifest.hadLicense, true);
  assert.deepEqual(withKeys.manifest.clips, clipFiles(cardsWithClips));
  assert.equal(withKeys.manifest.videos, 1);
  assert.equal(withKeys.manifest.cards, 2);
  assert.ok('linguaclip_ai_config' in withKeys.data.localStorage);
  assert.ok('linguaclip_transcribe_config' in withKeys.data.localStorage);
  assert.equal('linguaclip_pro_license' in withKeys.data.localStorage, false);
  assert.equal('linguaclip_today' in withKeys.data.localStorage, false);
  assert.equal('linguaclip_restore_pending' in withKeys.data.localStorage, false);
  assert.equal('other_app' in withKeys.data.localStorage, false);
  // Desktop checkBackup accepts Android-exported manifest + data directly.
  assert.equal(checkBackup(withKeys.manifest, withKeys.data, '0.10.0'), null);
  assert.equal(checkBackup(withKeys.manifest, withKeys.data, '0.9.0', { crossPlatform: true }), null);

  // includeKeys: false strips SECRET_KEYS while keeping all other settings and passing checkBackup.
  const noKeys = buildAndroidZipPayload({
    videos: [video('a')],
    cards: cardsWithClips,
    meta: [],
    local: androidLocal,
    appVersion: '0.10.0',
    ownDir: '/data/user/0/com.linguaclip.app/files',
    includeKeys: false,
    createdAt: 1700000001234,
  });
  assert.equal('linguaclip_ai_config' in noKeys.data.localStorage, false);
  assert.equal('linguaclip_transcribe_config' in noKeys.data.localStorage, false);
  assert.ok('linguaclip_watch_pos' in noKeys.data.localStorage);
  assert.equal(checkBackup(noKeys.manifest, noKeys.data, '0.10.0'), null);

  // Invalid data is rejected before writing.
  assert.throws(() => buildAndroidZipPayload({
    videos: [{ id: 'bad' }],
    cards: [],
    meta: [],
    local: {},
    appVersion: '0.10.0',
    ownDir: '/data/user/0/com.linguaclip.app/files',
    includeKeys: true,
    createdAt: 1700000001234,
  }), e => e instanceof BackupProblem && e.code === 'bad');

  // Same-platform Android .zip restore: fresh phone recovers keys & Android settings (custom mode preserved).
  const sameConv = fromDesktopBackup(withKeys.manifest, withKeys.data, '0.10.0', { crossPlatform: false });
  const freshRestore = planLocal({}, sameConv.local, { includeKeys: true });
  const freshObj = Object.fromEntries(freshRestore.set);
  assert.equal(freshObj.linguaclip_ai_config, '{"apiKey":"sk-1"}');
  assert.equal(JSON.parse(freshObj.linguaclip_transcribe_config).mode, 'custom');
  assert.equal(freshObj.linguaclip_podcast_wifi_only, '1');
  assert.equal(freshObj.linguaclip_android_battery_dismissed, '1');

  // Existing keys on target phone are never overwritten during Android .zip restore.
  const existingRestore = planLocal(
    { linguaclip_transcribe_config: '{"mode":"cloud","groqKey":"gsk_keep"}' },
    sameConv.local,
    { includeKeys: true },
  );
  const existingObj = Object.fromEntries(existingRestore.set);
  assert.equal('linguaclip_transcribe_config' in existingObj, false);
  assert.equal(existingObj.linguaclip_ai_config, '{"apiKey":"sk-1"}');

  // Same-platform Android .zip from a newer app version is rejected when crossPlatform: false.
  assert.throws(
    () => fromDesktopBackup({ ...withKeys.manifest, app: '0.11.0' }, withKeys.data, '0.10.0', { crossPlatform: false }),
    e => e instanceof BackupProblem && e.code === 'newer',
  );
}

console.log('mobile backup: all passed');
