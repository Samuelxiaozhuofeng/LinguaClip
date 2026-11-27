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
await build({
  stdin: {
    contents: [
      "export * from './mobile/backup';",
      "export * from './mobile/restorePlan';",
      "export { collectRestoreKeptClips } from './mobile/restoreClips';",
      "export { checkBackup, clipFiles } from './utils/backup';",
    ].join('\n'),
    resolveDir: '.',
    loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error',
});
const {
  makeBackup, checkMobile, parseBackup, fromDesktopBackup, buildAndroidZipPayload,
  pickLocal, planLocal, blobId, blobIds, orphanAudio, readPending, BackupProblem, checkBackup, clipFiles,
  stageRestorePlan, prepareUndoPlan, collectRestoreKeptClips,
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

// --- F1: Reversible undo, atomic staging preserving existing `pre`, and clips keep-set for pre/staged ---
{
  const snapA = makeBackup({
    videos: [video('va')],
    cards: [card('ca', { videoId: 'va', clip: { kind: 'audio', file: 'va_1.00.m4a', image: 'va_1.00.jpg', from: 0 } })],
    meta: [], local: {}, cache: {},
  }, 1700000010000);
  const snapB = makeBackup({
    videos: [video('vb')],
    cards: [card('cb', { videoId: 'vb', clip: { kind: 'audio', file: 'vb_2.00.m4a', from: 1 } })],
    meta: [], local: {}, cache: {},
  }, 1700000020000);
  const snapBPracticed = makeBackup({
    videos: [video('vb'), video('vc')],
    cards: [
      card('cb', { videoId: 'vb', clip: { kind: 'audio', file: 'vb_2.00.m4a', from: 1 } }),
      card('cc', { videoId: 'vc', clip: { kind: 'audio', file: 'vc_3.00.m4a', from: 2 } }),
    ],
    meta: [], local: {}, cache: {},
  }, 1700000030000);

  // 1. Reversible undo: undo snapshots current state (snapBPracticed) into `pre`, stages old `pre` (snapA) as `staged`,
  //    and running undo a second time swaps right back to snapBPracticed!
  {
    const copies = new Map([['pre', snapA]]);
    let currentLive = snapBPracticed;
    let pending = null;
    const intents = [];
    const makeDeps = () => ({
      hasPending: () => pending !== null,
      prepare: async () => {},
      snapshot: async () => currentLive,
      getPre: async () => copies.get('pre') ?? null,
      commitCopies: async (staged, newPre) => {
        const prev = copies.get('pre') ?? null;
        copies.set('staged', staged);
        copies.set('pre', newPre);
        return prev;
      },
      rollbackCopies: async prev => {
        copies.delete('staged');
        if (prev) copies.set('pre', prev); else copies.delete('pre');
      },
      setPending: p => { pending = p; },
      setIntent: i => { intents.push(i); },
      clearIntent: () => { intents.push('clear'); },
    });

    // First undo: snapBPracticed -> pre, snapA -> staged
    assert.equal(await prepareUndoPlan(makeDeps()), 'ready');
    assert.deepEqual(pending, { use: 'staged', tries: 0 });
    assert.equal(intents.at(-1), 'undo');
    assert.deepEqual(copies.get('staged'), snapA);
    assert.deepEqual(copies.get('pre'), snapBPracticed);

    // Simulate bootRestore applying staged (snapA) while keeping `pre` (snapBPracticed).
    currentLive = copies.get('staged');
    copies.delete('staged');
    pending = null;
    assert.deepEqual(currentLive, snapA);
    assert.deepEqual(copies.get('pre'), snapBPracticed);

    // Second undo (undo the undo!): snapA -> pre, snapBPracticed -> staged -> returns to practiced state!
    assert.equal(await prepareUndoPlan(makeDeps()), 'ready');
    assert.deepEqual(pending, { use: 'staged', tries: 0 });
    assert.deepEqual(copies.get('staged'), snapBPracticed);
    assert.deepEqual(copies.get('pre'), snapA);
  }

  // 2. Second restore failing (quota exceeded when writing staged) preserves original `pre` untouched.
  {
    const copies = new Map([['pre', snapA]]);
    let pending = null;
    await assert.rejects(
      () => stageRestorePlan(snapB, undefined, {
        hasPending: () => pending !== null,
        prepare: async () => {},
        snapshot: async () => snapBPracticed,
        commitCopies: async () => { throw new Error('QuotaExceededError'); },
        rollbackCopies: async () => {},
        setPending: p => { pending = p; },
      }),
      e => e instanceof BackupProblem && e.code === 'pre' && e.message.includes('QuotaExceededError'),
    );
    assert.deepEqual(copies.get('pre'), snapA, 'original pre must remain untouched on staged quota failure');
    assert.equal(copies.has('staged'), false, 'staged must not be left behind on failure');
    assert.equal(pending, null, 'PENDING_KEY must not be written on failure');
  }

  // 3. Failure when writing PENDING_KEY rolls back `pre` to original and removes `staged`.
  {
    const copies = new Map([['pre', snapA]]);
    let cleared = false;
    await assert.rejects(
      () => stageRestorePlan(snapB, undefined, {
        hasPending: () => false,
        prepare: async () => {},
        snapshot: async () => snapBPracticed,
        commitCopies: async (staged, newPre) => {
          const prev = copies.get('pre') ?? null;
          copies.set('staged', staged);
          copies.set('pre', newPre);
          return prev;
        },
        rollbackCopies: async prev => {
          copies.delete('staged');
          if (prev) copies.set('pre', prev); else copies.delete('pre');
        },
        setPending: () => { throw new Error('localStorage full'); },
        clearIntent: () => { cleared = true; },
      }),
      e => e instanceof BackupProblem && e.code === 'pre',
    );
    assert.deepEqual(copies.get('pre'), snapA, 'rollback must restore original pre');
    assert.equal(copies.has('staged'), false, 'rollback must remove staged');
    assert.equal(cleared, true);
  }

  // 4. Undo with missing `pre` throws BackupProblem('gone').
  await assert.rejects(
    () => prepareUndoPlan({
      hasPending: () => false,
      prepare: async () => {},
      snapshot: async () => snapB,
      getPre: async () => null,
      commitCopies: async () => null,
      rollbackCopies: async () => {},
      setPending: () => {},
    }),
    e => e instanceof BackupProblem && e.code === 'gone',
  );

  // 5. Clip sweep protection for `pre` and `staged` snapshots (collectRestoreKeptClips).
  {
    const ok = await collectRestoreKeptClips({
      outsideRestore: async fn => fn(),
      hasPendingRestore: () => false,
      readCopy: async k => (k === 'pre' ? snapA : snapB),
    });
    assert.deepEqual([...ok].sort(), ['va_1.00.jpg', 'va_1.00.m4a', 'vb_2.00.m4a']);

    // Unreadable snapshot -> returns null so caller skips clip sweeping altogether.
    const errRes = await collectRestoreKeptClips({
      outsideRestore: async fn => fn(),
      hasPendingRestore: () => false,
      readCopy: async k => { if (k === 'pre') throw new Error('idb error'); return null; },
    });
    assert.equal(errRes, null, 'unreadable pre snapshot must skip clip sweep');

    // Malformed snapshot -> returns null (never sweep blindly).
    const badRes = await collectRestoreKeptClips({
      outsideRestore: async fn => fn(),
      hasPendingRestore: () => false,
      readCopy: async k => (k === 'pre' ? { broken: true } : null),
    });
    assert.equal(badRes, null, 'malformed pre snapshot must skip clip sweep');

    // Pending restore marker -> returns null.
    const pendRes = await collectRestoreKeptClips({
      outsideRestore: async fn => fn(),
      hasPendingRestore: () => true,
      readCopy: async () => snapA,
    });
    assert.equal(pendRes, null, 'pending restore must skip clip sweep');

    // Restore lock busy -> outsideRestore returns skip (null).
    const lockedRes = await collectRestoreKeptClips({
      outsideRestore: async (_fn, skip) => skip,
      hasPendingRestore: () => false,
      readCopy: async () => snapA,
    });
    assert.equal(lockedRes, null, 'locked restore must skip clip sweep');
  }

  // 6. End-to-end utils/clips.ts fillClips + registerExtraKeptClips:
  //    - desktop (no provider): keeps current cards + backupKeptClips
  //    - Android (provider returns pre/staged clips): includes pre/staged clips in sweepClips keep list
  //    - provider returns null (read failure): skips sweepClips completely!
  {
    const clipsOut = join(tmpdir(), `mobile-clips-keep-${process.pid}.mjs`);
    await build({
      entryPoints: ['./utils/clips.ts'],
      bundle: true,
      format: 'esm',
      platform: 'node',
      outfile: clipsOut,
      logLevel: 'error',
      plugins: [{
        name: 'stub-clips-deps',
        setup(b) {
          b.onResolve({ filter: /^\.\/(desktop|review|videoStorage|storage)$/ }, args => ({
            path: args.path,
            namespace: 'clipstub',
          }));
          b.onLoad({ filter: /^\.\/desktop$/, namespace: 'clipstub' }, () => ({
            contents: `
              export const backupKeptClips = async () => globalThis.__clipTest.backupKept;
              export const sweepClips = async keep => { globalThis.__clipTest.swept.push([...keep]); return 0; };
              export const clipPath = async f => f;
              export const cutClip = async () => { throw new Error('no cut'); };
              export const pathExists = async () => false;
            `,
          }));
          b.onLoad({ filter: /^\.\/review$/, namespace: 'clipstub' }, () => ({
            contents: `
              export const getAllCards = async () => globalThis.__clipTest.cards;
              export const hasAudio = c => !!c.videoPath || !!c.clip;
              export const setClip = async () => {};
              export const subscribeCards = () => () => {};
            `,
          }));
          b.onLoad({ filter: /^\.\/videoStorage$/, namespace: 'clipstub' }, () => ({
            contents: 'export const getVideoRecord = async () => null;',
          }));
          b.onLoad({ filter: /^\.\/storage$/, namespace: 'clipstub' }, () => ({
            contents: 'export const getPracticeConfig = () => ({ saveClips: false, clipKind: "audio" });',
          }));
        },
      }],
    });
    globalThis.__clipTest = {
      backupKept: ['zip_1.00.m4a'],
      cards: [{ id: 'c_now', videoId: 'vnow', start: 0, end: 1, clip: { kind: 'audio', file: 'now_0.00.m4a', from: 0 } }],
      swept: [],
    };
    const Clips = await import(clipsOut);

    // Desktop behavior (zero providers registered)
    await Clips.fillClips();
    assert.equal(globalThis.__clipTest.swept.length, 1);
    assert.deepEqual(globalThis.__clipTest.swept[0].sort(), ['now_0.00.m4a', 'zip_1.00.m4a']);

    // Android behavior: provider supplies pre/staged clips
    let mode = 'ok';
    const unreg = Clips.registerExtraKeptClips(async () => (
      mode === 'ok'
        ? collectRestoreKeptClips({
          outsideRestore: async fn => fn(),
          hasPendingRestore: () => false,
          readCopy: async k => (k === 'pre' ? snapA : snapB),
        })
        : mode === 'null'
          ? null
          : Promise.reject(new Error('idb fail'))
    ));

    await Clips.fillClips();
    assert.equal(globalThis.__clipTest.swept.length, 2);
    assert.deepEqual(
      globalThis.__clipTest.swept[1].sort(),
      ['now_0.00.m4a', 'va_1.00.jpg', 'va_1.00.m4a', 'vb_2.00.m4a', 'zip_1.00.m4a'],
    );

    // Provider returns null -> skip sweep completely
    mode = 'null';
    await Clips.fillClips();
    assert.equal(globalThis.__clipTest.swept.length, 2, 'must not call sweepClips when provider returns null');

    // Provider rejects -> skip sweep completely
    mode = 'throw';
    await Clips.fillClips();
    assert.equal(globalThis.__clipTest.swept.length, 2, 'must not call sweepClips when provider throws');

    unreg();
    delete globalThis.__clipTest;
  }
}

console.log('mobile backup: all passed');
