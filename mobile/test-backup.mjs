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
await build({ stdin: { contents: "export * from './mobile/backup';", resolveDir: '.', loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error' });
const { makeBackup, checkMobile, parseBackup, pickLocal, planLocal, blobId, blobIds, orphanAudio, readPending, BackupProblem } = await import(out);

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

console.log('mobile backup: all passed');
