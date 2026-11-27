/**
 * Pure sync core engine self-tests (docs/sync.md):
 * SHA-256 / UUID v5 / causal clock, WebDAV pairing codec, 100-round 3-device
 * random-order convergence, FSRS concurrent revlog replay, tombstones + clock skew
 * + keepCards + 90-day GC / drawer device, podcast rekey + ±0.8s subtitle alignment,
 * daysDev idempotency, watch_pos reset to 0, videoPath cross-platform isolation,
 * safety alerts / circuit breakers / format version guard, and QR code matrix/SVG.
 *
 * Run with: node test-sync-merge.mjs
 */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = join(tmpdir(), `sync-merge-${process.pid}.mjs`);
await build({
  stdin: {
    contents: `
      export * from './utils/syncClock';
      export * from './utils/syncConfig';
      export * from './utils/syncMerge';
      export * from './utils/qr';
      export { newCard, schedule, lineCardId, wordCardId, revertAddedLine } from './utils/review';
      export { enableLocalSaveClipsIfUnset, getPracticeConfig, savePracticeConfig, saveLocalWatchChosen } from './utils/storage';
    `,
    resolveDir: '.',
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  outfile: out,
  logLevel: 'error',
});
const S = await import(out);

const DAY = 86_400_000;
const HOUR = 3_600_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_ID_RE = /^[0-9a-f-]+$/;

// Helpers for test fixtures
const makeVideo = (id, over = {}) => ({
  id,
  displayName: `${id}.mp4`,
  videoFileName: `${id}.mp4`,
  subtitleFileName: `${id}.srt`,
  srtHash: S.srtHash(`1\n00:00:01,000 --> 00:00:03,000\nLine for ${id}\n`),
  currentSubtitleIndex: 0,
  currentSectionIndex: 0,
  totalSubtitles: 10,
  completionRate: 0,
  dateAdded: 1_000,
  bornAt: 1_000,
  lastPracticed: 1_000,
  totalPracticeTime: 0,
  ...over,
});

const makeSnap = (devId, platform, ownDir, over = {}) => ({
  v: S.SYNC_FORMAT,
  devId,
  platform,
  ownDir,
  exportedAt: 10_000,
  lastMergedAt: 10_000,
  videos: [],
  cards: [],
  cardMeta: {},
  tombstones: { videos: {}, cards: {} },
  daysDev: {},
  positions: { watch: {}, custom: {}, read: {}, lastWay: {} },
  posAt: {},
  ...over,
});

const makeCardWithMeta = (videoId, start, text, bornAt, reason = 'saved', overCard = {}, overMeta = {}) => {
  const id = S.lineCardId(videoId, start);
  const c = S.newCard({ id, deck: 'line', videoId, videoName: `${videoId}.mp4`, text, start, end: start + 2 }, reason, bornAt);
  const card = { ...c, ...overCard };
  const meta = {
    bornAt,
    base: { ...card.fsrs },
    logs: [],
    ...(reason === 'saved' ? { savedAt: bornAt } : {}),
    ...(reason === 'missed' ? { missedAt: bornAt } : {}),
    ...overMeta,
  };
  return { card, meta };
};

const reviewLocal = (card, meta, revId, grade, at) => {
  const next = S.schedule(card, grade, at);
  const logs = [...(meta.logs ?? []), [revId, grade, at]];
  let base = meta.base ?? { ...card.fsrs };
  while (logs.length > 8) {
    const oldest = logs.shift();
    base = S.schedule({ ...card, fsrs: base }, oldest[1], oldest[2]).fsrs;
  }
  const unmasteredAt = (grade === 1 || grade === 2)
    ? Math.max(meta.unmasteredAt ?? 0, at)
    : meta.unmasteredAt;
  const nextCard = (grade === 1 || grade === 2)
    ? (({ mastered: _, ...rest }) => rest)(next)
    : next;
  return {
    card: nextCard,
    meta: { ...meta, base, logs, ...(unmasteredAt ? { unmasteredAt } : {}) },
  };
};

// =========================================================================
// 1. SHA-256 NIST vectors, normFeedUrl, srtHash, episodeUuid, bumpTs, compareStamp
// =========================================================================
{
  assert.equal(S.sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(S.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(
    S.sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  );
  assert.equal(S.sha256Hex('你好世界'), 'beca6335b20ff57ccc47403ef4d9e0b8fccb4442b3151c2e7d50050673d43172');

  assert.equal(S.normFeedUrl('  HTTPS://Example.COM/Feed/Show///?Key=AbC  '), 'https://example.com/Feed/Show?Key=AbC');
  assert.equal(S.normFeedUrl('HTTPS://Example.COM///'), 'https://example.com/');
  assert.equal(S.normFeedUrl('https://Example.COM'), 'https://example.com/');
  assert.equal(S.normFeedUrl('  linguaclip:starter  '), 'linguaclip:starter');

  const u1 = S.episodeUuid('HTTPS://Feeds.Example.COM/Pod///', '  ep-42  ');
  const u2 = S.episodeUuid('https://feeds.example.com/Pod', 'ep-42');
  const u3 = S.episodeUuid('https://feeds.example.com/Pod', 'ep-43');
  assert.equal(u1, u2, 'episodeUuid deterministic across feed normalization & guid trim');
  assert.notEqual(u1, u3);
  assert.match(u1, UUID_RE, 'strict RFC 4122 UUID v5 format');
  assert.match(u1, SAFE_ID_RE, 'passes Rust valid_id [0-9a-f-]');

  assert.equal(S.srtHash('1\r\n00:00:01,000 --> 00:00:02,000\r\nHi\r\n'), S.srtHash('1\n00:00:01,000 --> 00:00:02,000\nHi\n'));
  assert.equal(S.bumpTs(100, 50), 101, 'bumpTs monotonic even when clock is behind');
  assert.equal(S.bumpTs(100, 500), 500);
  assert.equal(S.compareStamp(10, 'a', 20, 'z'), -1);
  assert.equal(S.compareStamp(10, 'b', 10, 'a'), 1);
  assert.equal(S.compareStamp(10, 'a', 10, 'a'), 0);
}

// =========================================================================
// 2. syncConfig: localStorage CRUD + encodePairCode / decodePairCode
// =========================================================================
{
  const mem = new Map();
  const storage = {
    getItem: k => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, v); },
    removeItem: k => { mem.delete(k); },
  };
  const devId = S.getSyncDeviceId(storage);
  assert.match(devId, SAFE_ID_RE);
  assert.equal(S.getSyncDeviceId(storage), devId, 'device ID persisted');

  const cfg = {
    enabled: true,
    preset: 'jianguoyun',
    url: S.JIANGUOYUN_URL,
    username: 'user@example.com',
    password: 'p@ss/w:rd?&=中文#1!',
    rootDir: '我的同步/日语学习',
    syncClips: true,
    wifiOnlyClips: true,
    autoSyncAudio: false,
    wifiOnlyAudio: true,
  };
  S.saveSyncConfig(cfg, storage);
  assert.deepEqual(S.getSyncConfig(storage), cfg);

  assert.equal(S.getSyncState(storage).dirty, false);
  S.markSyncDirty(storage);
  assert.equal(S.getSyncState(storage).dirty, true);

  const pair = S.encodePairCode(cfg);
  assert.ok(pair.startsWith(S.PAIR_PREFIX));
  // Roundtrip with leading/trailing spaces & line wraps
  const wrapped = `\n  ${pair.slice(0, 40)}\n  ${pair.slice(40)} \r\n`;
  const decoded = S.decodePairCode(wrapped);
  assert.deepEqual(decoded, {
    preset: cfg.preset,
    url: cfg.url,
    username: cfg.username,
    password: cfg.password,
    rootDir: cfg.rootDir,
    syncClips: cfg.syncClips,
    wifiOnlyClips: cfg.wifiOnlyClips,
    wifiOnlyAudio: cfg.wifiOnlyAudio,
  });

  // LAN / Tailscale / loopback HTTP allowed; public HTTP rejected
  const lanPair = S.encodePairCode({ ...cfg, preset: 'custom', url: 'http://192.168.1.10:5005/dav/' });
  assert.ok(S.decodePairCode(lanPair), 'LAN http allowed');
  const tsPair = S.encodePairCode({ ...cfg, preset: 'custom', url: 'http://100.88.1.2:8080/dav/' });
  assert.ok(S.decodePairCode(tsPair), 'Tailscale http allowed');
  const pubHttp = S.encodePairCode({ ...cfg, preset: 'custom', url: 'http://dav.public.example.com/dav/' });
  assert.equal(S.decodePairCode(pubHttp), null, 'public plaintext http rejected');
  const badDir = S.encodePairCode({ ...cfg, rootDir: '../escape' });
  assert.equal(S.decodePairCode(badDir), null, 'path traversal rootDir rejected');
  const emptyPw = S.encodePairCode({ ...cfg, password: '' });
  assert.equal(S.decodePairCode(emptyPw), null, 'empty password rejected');
  assert.equal(S.decodePairCode('not-a-code'), null);
  assert.equal(S.decodePairCode(`${S.PAIR_PREFIX}!!!invalid!!!`), null);
}

// =========================================================================
// 3. FSRS concurrent review divergence replay + >8 logs folding + mastered/saved/missed/note
// =========================================================================
{
  const baseAt = 1_700_000_000_000;
  let { card, meta } = makeCardWithMeta('v1', 10, 'Hello there', baseAt, 'saved');
  // 3 shared reviews first (reps = 3, lapses = 0)
  ({ card, meta } = reviewLocal(card, meta, 'r1', 3, baseAt + 1 * DAY));
  ({ card, meta } = reviewLocal(card, meta, 'r2', 3, baseAt + 4 * DAY));
  ({ card, meta } = reviewLocal(card, meta, 'r3', 3, baseAt + 10 * DAY));
  assert.equal(card.fsrs.reps, 3);
  assert.equal(card.fsrs.lapses, 0);

  // Diverge: Phone reviews Again offline, Desktop reviews Good offline
  const phone = reviewLocal(card, meta, 'p4', 1, baseAt + 15 * DAY);
  const desktop = reviewLocal(card, meta, 'd5', 3, baseAt + 16 * DAY);

  const ab = S.mergeCard(phone.card, phone.meta, 'dev-phone', desktop.card, desktop.meta, 'dev-desk');
  const ba = S.mergeCard(desktop.card, desktop.meta, 'dev-desk', phone.card, phone.meta, 'dev-phone');

  assert.equal(ab.card.fsrs.reps, 5, 'reps = 3 + 2 concurrent reviews');
  assert.equal(ab.card.fsrs.lapses, 1, 'lapses = 1 from phone Again');
  assert.deepEqual(ab.card.fsrs, ba.card.fsrs, 'bit-for-bit identical FSRS in both merge orders');
  assert.equal(ab.card.fsrs.due, ba.card.fsrs.due);
  assert.equal(ab.card.fsrs.stability, ba.card.fsrs.stability);
  assert.equal(ab.card.fsrs.difficulty, ba.card.fsrs.difficulty);

  // > 8 logs auto-fold into base and ancestor alignment across folded vs unfolded peers
  let heavy = { card: ab.card, meta: ab.meta };
  for (let i = 0; i < 6; i++) {
    heavy = reviewLocal(heavy.card, heavy.meta, `h${i}`, 3, baseAt + (20 + i * 2) * DAY);
  }
  assert.equal(heavy.meta.logs.length, 8, 'bounded to 8 logs');
  const light = reviewLocal(ab.card, ab.meta, 'l1', 2, baseAt + 21 * DAY);
  const m1 = S.mergeCard(heavy.card, heavy.meta, 'dev-a', light.card, light.meta, 'dev-b');
  const m2 = S.mergeCard(light.card, light.meta, 'dev-b', heavy.card, heavy.meta, 'dev-a');
  assert.equal(m1.meta.logs.length, 8, 'merged logs stay <= 8');
  assert.deepEqual(m1.card.fsrs, m2.card.fsrs, 'ancestor-aligned fold converges bit-for-bit');

  // mastered cleared by later Again/Hard, preserved if mastered > unmasteredAt
  const masteredEarly = { ...phone.card, mastered: baseAt + 14 * DAY };
  const resCleared = S.mergeCard(masteredEarly, phone.meta, 'dev-phone', desktop.card, desktop.meta, 'dev-desk');
  assert.equal('mastered' in resCleared.card, false, 'Again at day 15 clears mastered from day 14');

  const masteredLate = { ...desktop.card, mastered: baseAt + 18 * DAY };
  const resKept = S.mergeCard(phone.card, phone.meta, 'dev-phone', masteredLate, desktop.meta, 'dev-desk');
  assert.equal(resKept.card.mastered, baseAt + 18 * DAY, 'mastered at day 18 beats Again at day 15');

  // signed savedAt / missedAt (abs wins, tie positive wins) + extra reasons union + ankiAt max + noteAt LWW preserving ai
  const cA = {
    ...card,
    saved: false,
    reasons: ['wrong', 'peek'],
    ankiAt: 500,
    definition: 'old def',
    example: 'old ex',
    ai: 'AI cultural note',
  };
  const mA = { ...meta, savedAt: -200, missedAt: -300, noteAt: 100, noteBy: 'dev-a' };
  const cB = {
    ...card,
    saved: true,
    reasons: ['blur', 'saved', 'missed'],
    ankiAt: 900,
    definition: 'new def',
    example: 'new ex',
  };
  const mB = { ...meta, savedAt: 200, missedAt: 300, noteAt: 250, noteBy: 'dev-b' };
  const cm = S.mergeCard(cA, mA, 'dev-a', cB, mB, 'dev-b');
  assert.equal(cm.card.saved, true, 'savedAt tie (+200 vs -200): positive wins');
  assert.ok(cm.card.reasons.includes('missed'), 'missedAt tie (+300 vs -300): positive wins');
  assert.ok(cm.card.reasons.includes('wrong') && cm.card.reasons.includes('peek') && cm.card.reasons.includes('blur'));
  assert.equal(cm.card.ankiAt, 900);
  assert.equal(cm.card.definition, 'new def');
  assert.equal(cm.card.example, 'new ex');
  assert.equal(cm.card.ai, 'AI cultural note', 'preserves loser.ai when winner lacks ai');
}

// =========================================================================
// 4. Tombstones anti-ping-pong + 10h clock skew + keepCards + 90d GC & drawer device
// =========================================================================
{
  const T0 = 1_700_000_000_000;
  const v1 = makeVideo('v1', { dateAdded: T0, bornAt: T0 });
  const { card: c1, meta: m1 } = makeCardWithMeta('v1', 5, 'Skew line', T0);

  // Device B clock is 10 hours behind, deletes c1 using bumpTs(bornAt, T0 - 10h)
  const slowNow = T0 - 10 * HOUR;
  const delAt = S.bumpTs(m1.bornAt, slowNow);
  assert.equal(delAt, T0 + 1);

  const devA = makeSnap('dev-a', 'mac', '/Users/a/LinguaClip', {
    exportedAt: T0 + 50, lastMergedAt: T0 + 50,
    videos: [v1], cards: [c1], cardMeta: { [c1.id]: m1 },
  });
  const devB = makeSnap('dev-b', 'android', '/data/user/0/app', {
    exportedAt: T0 + 50, lastMergedAt: T0 + 50,
    videos: [v1], cards: [], cardMeta: {},
    tombstones: { videos: {}, cards: { [c1.id]: delAt } },
  });

  const aAfter = S.mergeSnapshots(devA, [devB], { localPlatform: 'mac', localOwnDir: '/Users/a/LinguaClip', now: T0 + 100, initialized: true, lastSyncAt: T0 });
  const bAfter = S.mergeSnapshots(devB, [devA], { localPlatform: 'android', localOwnDir: '/data/user/0/app', now: T0 + 100, initialized: true, lastSyncAt: T0 });
  assert.equal(aAfter.snapshot.cards.length, 0, 'slow-clock deletion wins via bumpTs');
  assert.equal(bAfter.snapshot.cards.length, 0, 'no ping-pong');

  // Re-adding / undo via bumpTs(tombstoneAt, slowNow) resurrects cleanly
  const rebornAt = S.bumpTs(delAt, slowNow);
  const { card: c1Reborn, meta: m1Reborn } = makeCardWithMeta('v1', 5, 'Skew line', rebornAt);
  const bReborn = { ...bAfter.snapshot, cards: [c1Reborn], cardMeta: { [c1Reborn.id]: m1Reborn }, tombstones: { videos: {}, cards: {} } };
  const aAfterReborn = S.mergeSnapshots(aAfter.snapshot, [bReborn], { localPlatform: 'mac', localOwnDir: '/Users/a/LinguaClip', now: T0 + 200, initialized: true, lastSyncAt: T0 + 100 });
  assert.equal(aAfterReborn.snapshot.cards.length, 1, 'reborn card beats older tombstone');
  assert.equal(aAfterReborn.snapshot.tombstones.cards[c1.id], undefined, 'overridden tombstone pruned');

  // keepCards = true deletes video but preserves cards and records keptOrphans
  const vDelKeep = S.bumpTs(v1.bornAt, T0 + 500);
  const devADelKeep = makeSnap('dev-a', 'mac', '/Users/a/LinguaClip', {
    exportedAt: T0 + 600, lastMergedAt: T0 + 600,
    videos: [], cards: [c1], cardMeta: { [c1.id]: m1 },
    tombstones: { videos: { v1: { at: vDelKeep, keepCards: true } }, cards: {} },
  });
  const devBStillHas = makeSnap('dev-b', 'android', '/data/user/0/app', {
    exportedAt: T0 + 600, lastMergedAt: T0 + 600,
    videos: [v1], cards: [c1], cardMeta: { [c1.id]: m1 },
  });
  const keepRes = S.mergeSnapshots(devBStillHas, [devADelKeep], { localPlatform: 'android', localOwnDir: '/data/user/0/app', now: T0 + 700, initialized: true, lastSyncAt: T0 });
  assert.equal(keepRes.snapshot.videos.length, 0, 'video deleted');
  assert.equal(keepRes.snapshot.cards.length, 1, 'card preserved when keepCards=true');
  assert.deepEqual(keepRes.keptOrphans, [c1.id], 'surviving card id added to keptOrphans');

  // 90-day GC + drawer old device zombie prevention
  const day0 = T0;
  const day5 = T0 + 5 * DAY;
  const day10 = T0 + 10 * DAY;
  const day20 = T0 + 20 * DAY;
  const day200 = T0 + 200 * DAY;

  const vOld = makeVideo('v-old', { dateAdded: day0, bornAt: day0 });
  const vKeep = makeVideo('v-keep', { dateAdded: day0, bornAt: day0 });
  const vOfflineNew = makeVideo('v-new-offline', { dateAdded: day20, bornAt: day20 });

  // Active device A had tombstone from day10; at day200 with active peer C synced at day199, tombstone is GC'd
  const activeA = makeSnap('dev-a', 'mac', '/Users/a/LinguaClip', {
    exportedAt: day200, lastMergedAt: day200,
    videos: [vKeep],
    tombstones: { videos: { 'v-old': { at: day10, keepCards: false } }, cards: {} },
  });
  const activeC = makeSnap('dev-c', 'windows', 'C:\\Users\\c\\LinguaClip', {
    exportedAt: day200 - DAY, lastMergedAt: day200 - DAY,
    videos: [vKeep],
    tombstones: { videos: { 'v-old': { at: day10, keepCards: false } }, cards: {} },
  });
  const gcRes = S.mergeSnapshots(activeA, [activeC], { localPlatform: 'mac', localOwnDir: '/Users/a/LinguaClip', now: day200, initialized: true, lastSyncAt: day200 - DAY });
  assert.equal(gcRes.snapshot.tombstones.videos['v-old'], undefined, 'tombstone > 90d GCd');
  assert.equal(gcRes.snapshot.tombstones.gcFloorAt, day10, 'gcFloorAt advanced');

  // Drawer phone wakes up at day201 (lastSyncAt = day5 < gcFloorAt = day10)
  // It still has v-old (born day0, deleted long ago), v-keep (born day0, still alive on A), and v-new-offline (born day20 > lastSyncAt)
  const drawerPhone = makeSnap('dev-drawer', 'android', '/data/user/0/app', {
    exportedAt: day5, lastMergedAt: day5,
    videos: [vOld, vKeep, vOfflineNew],
  });
  const wakeRes = S.mergeSnapshots(drawerPhone, [gcRes.snapshot], {
    localPlatform: 'android',
    localOwnDir: '/data/user/0/app',
    now: day200 + DAY,
    initialized: true,
    lastSyncAt: day5,
  });
  const wakeIds = wakeRes.snapshot.videos.map(v => v.id).sort();
  assert.deepEqual(wakeIds, ['v-keep', 'v-new-offline'], 'old deleted v-old purged (no zombie), offline new v-new-offline kept');
}

// =========================================================================
// 5. Legacy podcast dual-UUID split auto-rekey + ±0.8s subtitle alignment + clip.file preserved
// =========================================================================
{
  const feedA = 'HTTPS://Feeds.Example.COM/Show///';
  const feedB = 'https://feeds.example.com/Show';
  const guid = 'ep-101';
  const canonId = S.episodeUuid(feedB, guid);
  const legacyId = '11111111-2222-4333-8444-555555555555';

  const srtWinner = '1\n00:00:12,000 --> 00:00:14,500\nHello world\n';
  const hashWinner = S.srtHash(srtWinner);

  const vLegacy = makeVideo(legacyId, {
    dateAdded: 2000, bornAt: 2000, lastPracticed: 3000,
    podcast: { show: 'Show', feed: feedA, guid, name: 'ep101', audio: 'https://cdn.example.com/101.mp3' },
  });
  const vCanon = makeVideo(canonId, {
    dateAdded: 4000, bornAt: 4000, lastPracticed: 2500, srtHash: hashWinner,
    podcast: { show: 'Show', feed: feedB, guid, name: 'ep101', audio: 'https://cdn.example.com/101.mp3' },
  });

  const { card: cLegacy, meta: mLegacy } = makeCardWithMeta(legacyId, 12.8, 'Hello, world!', 2100, 'saved', {
    clip: { kind: 'audio', file: `${legacyId}_12.80.m4a`, from: 12.6 },
  });
  const { card: cCanon, meta: mCanon } = makeCardWithMeta(canonId, 12.0, 'Hello world', 4100, 'wrong');

  const snapLegacy = makeSnap('dev-old', 'mac', '/Users/old/LinguaClip', {
    videos: [vLegacy],
    cards: [cLegacy],
    cardMeta: { [cLegacy.id]: mLegacy },
    positions: { watch: { [legacyId]: 120 }, custom: {}, read: {}, lastWay: { [legacyId]: 'watch' } },
    posAt: { [legacyId]: { watch: 3000, lastWay: 3000 } },
  });
  const snapCanon = makeSnap('dev-new', 'android', '/data/user/0/app', {
    videos: [vCanon],
    cards: [cCanon],
    cardMeta: { [cCanon.id]: mCanon },
    positions: { watch: { [canonId]: 60 }, custom: {}, read: {}, lastWay: {} },
    posAt: { [canonId]: { watch: 2500 } },
  });

  const res = S.mergeSnapshots(snapLegacy, [snapCanon], {
    localPlatform: 'mac',
    localOwnDir: '/Users/old/LinguaClip',
    now: 5000,
    initialized: true,
    lastSyncAt: 1000,
    subtitles: { [hashWinner]: srtWinner },
  });

  assert.deepEqual(res.rekeys, [{ from: legacyId, to: canonId }], 'rekey generated for legacyId -> canonId');
  assert.equal(res.snapshot.idRedirects[legacyId], canonId);
  assert.equal(res.snapshot.videos.length, 1);
  assert.equal(res.snapshot.videos[0].id, canonId);
  assert.equal(res.snapshot.cards.length, 1, '±0.8s cards merged into one');
  const mergedCard = res.snapshot.cards[0];
  assert.equal(mergedCard.id, S.lineCardId(canonId, 12.0));
  assert.equal(mergedCard.start, 12.0, '±0.8s aligned to winner subtitle timestamp');
  assert.equal(mergedCard.clip?.file, `${legacyId}_12.80.m4a`, 'clip.file literal preserved');
  assert.ok(mergedCard.saved && mergedCard.reasons.includes('wrong'), 'reasons merged across rekeyed cards');
  assert.equal(res.snapshot.positions.watch[canonId], 120, 'position remapped from legacyId to canonId');
}

// =========================================================================
// 6. daysDev 100x repeated merge never doubles
// =========================================================================
{
  let snapA = makeSnap('dev-a', 'mac', '/Users/a/LinguaClip', {
    daysDev: { '2026-11-25': { 'dev-a': { sec: 600, lines: 45 } } },
  });
  let snapB = makeSnap('dev-b', 'android', '/data/user/0/app', {
    daysDev: { '2026-11-25': { 'dev-b': { sec: 300, lines: 20 } } },
  });
  let proj;
  for (let i = 0; i < 100; i++) {
    const rA = S.mergeSnapshots(snapA, [snapB], { localPlatform: 'mac', localOwnDir: '/Users/a/LinguaClip', now: 10_000 + i, initialized: true, lastSyncAt: 9_000 });
    const rB = S.mergeSnapshots(snapB, [rA.snapshot], { localPlatform: 'android', localOwnDir: '/data/user/0/app', now: 10_000 + i, initialized: true, lastSyncAt: 9_000 });
    snapA = rA.snapshot;
    snapB = rB.snapshot;
    proj = rB.projectedDays;
  }
  assert.deepEqual(proj['2026-11-25'], { sec: 900, lines: 65 }, '100 merges never double daysDev');
}

// =========================================================================
// 7. watch_pos reset to 0 overwrites older 600s progress
// =========================================================================
{
  const v1 = makeVideo('v1');
  const snapA = makeSnap('dev-a', 'android', '/data/user/0/app', {
    videos: [v1],
    positions: { watch: { v1: 600 }, custom: {}, read: {}, lastWay: {} },
    posAt: { v1: { watch: 100 } },
  });
  const snapB = makeSnap('dev-b', 'mac', '/Users/b/LinguaClip', {
    videos: [v1],
    positions: { watch: { v1: 0 }, custom: {}, read: {}, lastWay: {} },
    posAt: { v1: { watch: 200 } },
  });
  const res = S.mergeSnapshots(snapA, [snapB], {
    localPlatform: 'android', localOwnDir: '/data/user/0/app', now: 300, initialized: true, lastSyncAt: 50,
  });
  assert.equal(res.snapshot.positions.watch.v1, 0, 'watch=0 at t=200 beats watch=600 at t=100');
  assert.deepEqual(res.watchPosUpdatedIds, ['v1'], 'android notified to advance native_pos_ts');
}

// =========================================================================
// 8. videoPath cross-platform isolation + neededClips + neededSubs + safe settings
// =========================================================================
{
  const vPod = makeVideo('v-pod', {
    videoPath: '/Users/amy/Movies/LinguaClip/pod.mp3',
    podcast: { show: 'S', feed: 'https://f.example/rss', guid: 'g1', name: 'ep1', audio: 'https://cdn.example/ep1.mp3' },
  });
  const vStarter = makeVideo('v-start', { videoPath: 'https://linguaclipapp.com/starter/1.mp3' });
  const vLocalMac = makeVideo('v-mac', { videoPath: '/Users/amy/Movies/LinguaClip/movie.mp4' });
  const vAndroidLocal = makeVideo('v-and', { videoPath: '/data/user/0/com.linguaclip/files/a.m4a' });

  const { card: cClip, meta: mClip } = makeCardWithMeta('v-mac', 3, 'Clip line', 1000, 'saved', {
    clip: { kind: 'audio', file: 'v-mac_3.00.m4a', from: 2.8 },
  });

  const macSnap = makeSnap('dev-mac', 'mac', '/Users/amy/Movies/LinguaClip', {
    videos: [vPod, vLocalMac],
    cards: [cClip],
    cardMeta: { [cClip.id]: mClip },
    clipPacks: { 'dev-mac-1.zip': ['v-mac_3.00.m4a'] },
    settings: {
      linguaclip_loop: { value: '{"on":true,"times":3}', at: 500 },
      linguaclip_ai_config: { value: '{"apiKey":"sk-secret"}', at: 999 },
      linguaclip_keys: { value: '{"studio":{"play":"Space"}}', at: 999 },
      linguaclip_sync_auth: { value: '{"password":"leaked"}', at: 999 },
    },
  });
  const androidSnap = makeSnap('dev-and', 'android', '/data/user/0/com.linguaclip', {
    videos: [vStarter, vAndroidLocal],
  });

  // Android merges Mac
  const onAndroid = S.mergeSnapshots(androidSnap, [macSnap], {
    localPlatform: 'android', localOwnDir: '/data/user/0/com.linguaclip', now: 2000, initialized: true, lastSyncAt: 500,
  });
  const aById = Object.fromEntries(onAndroid.snapshot.videos.map(v => [v.id, v]));
  assert.equal(aById['v-pod'].videoPath, 'https://cdn.example/ep1.mp3', 'podcast.audio assigned on Android');
  assert.equal(aById['v-mac'].videoPath, undefined, 'Mac path never enters Android');
  assert.equal(aById['v-start'].videoPath, 'https://linguaclipapp.com/starter/1.mp3', 'existing Android https kept');
  assert.equal(aById['v-and'].videoPath, '/data/user/0/com.linguaclip/files/a.m4a', 'existing Android local path kept');
  assert.equal(onAndroid.snapshot.cards[0].clip, undefined, 'missing remote clip not attached before download');
  assert.deepEqual(onAndroid.neededClips, [{ cardId: cClip.id, clip: cClip.clip, fromDevId: 'dev-mac', packName: 'dev-mac-1.zip' }]);
  assert.deepEqual(onAndroid.neededSubs, [vLocalMac.srtHash, vPod.srtHash].sort());
  assert.equal(onAndroid.snapshot.settings?.linguaclip_loop?.value, '{"on":true,"times":3}');
  assert.equal(onAndroid.snapshot.settings?.linguaclip_ai_config, undefined, 'SECRET_KEYS never synced');
  assert.equal(onAndroid.snapshot.settings?.linguaclip_keys, undefined, 'DEVICE_ONLY never synced');
  assert.equal(onAndroid.snapshot.settings?.linguaclip_sync_auth, undefined, 'SYNC_AUTH_KEY never synced');

  // Desktop merges Android: never accepts https:// or /data/user/0/...
  const onMac = S.mergeSnapshots(macSnap, [androidSnap], {
    localPlatform: 'mac', localOwnDir: '/Users/amy/Movies/LinguaClip', now: 2000, initialized: true, lastSyncAt: 500,
  });
  const mById = Object.fromEntries(onMac.snapshot.videos.map(v => [v.id, v]));
  assert.equal(mById['v-start'].videoPath, undefined, 'https:// never enters desktop');
  assert.equal(mById['v-and'].videoPath, undefined, 'Android path never enters desktop');
  assert.equal(mById['v-mac'].videoPath, '/Users/amy/Movies/LinguaClip/movie.mp4', 'local Mac path kept');

  // Mac -> Windows produces candidateRemappedPaths
  const winEmpty = makeSnap('dev-win', 'windows', 'C:\\Users\\bob\\Videos\\LinguaClip');
  const onWin = S.mergeSnapshots(winEmpty, [macSnap], {
    localPlatform: 'windows', localOwnDir: 'C:\\Users\\bob\\Videos\\LinguaClip', now: 2000, initialized: true, lastSyncAt: 500,
  });
  assert.equal(onWin.candidateRemappedPaths['v-mac'], 'C:\\Users\\bob\\Videos\\LinguaClip\\movie.mp4');
  assert.equal(onWin.snapshot.videos.find(v => v.id === 'v-mac').videoPath, undefined, 'unverified path stays in candidateRemappedPaths');
}

// =========================================================================
// 9. Safety alerts: firstSync, massDeletion, and v > SYNC_FORMAT
// =========================================================================
{
  const v1 = makeVideo('v1');
  const localNonEmpty = makeSnap('dev-a', 'mac', '/Users/a/LinguaClip', { videos: [v1] });
  const peerNonEmpty = makeSnap('dev-b', 'android', '/data/user/0/app', { videos: [makeVideo('v2')] });
  const firstRes = S.mergeSnapshots(localNonEmpty, [peerNonEmpty], {
    localPlatform: 'mac', localOwnDir: '/Users/a/LinguaClip', now: 5000, initialized: false, lastSyncAt: 0,
  });
  assert.ok(firstRes.safetyAlert && firstRes.safetyAlert.kind === 'firstSync' && firstRes.safetyAlert.firstSync);
  assert.equal(firstRes.summary.addedVideos, 1);

  // Mass card deletion (>= 20 cards and > 20%)
  const cards30 = [];
  const meta30 = {};
  const cardTombs20 = {};
  for (let i = 0; i < 30; i++) {
    const { card, meta } = makeCardWithMeta('v1', i + 1, `Line ${i}`, 1000);
    cards30.push(card);
    meta30[card.id] = meta;
    if (i < 20) cardTombs20[card.id] = 2000;
  }
  const local30 = makeSnap('dev-a', 'mac', '/Users/a/LinguaClip', { videos: [v1], cards: cards30, cardMeta: meta30 });
  const peerDel20 = makeSnap('dev-b', 'android', '/data/user/0/app', {
    videos: [v1], tombstones: { videos: {}, cards: cardTombs20 },
  });
  const massCardRes = S.mergeSnapshots(local30, [peerDel20], {
    localPlatform: 'mac', localOwnDir: '/Users/a/LinguaClip', now: 5000, initialized: true, lastSyncAt: 1000,
  });
  assert.ok(massCardRes.safetyAlert && massCardRes.safetyAlert.kind === 'massDeletion');
  assert.equal(massCardRes.summary.removedCards, 20);

  // Mass video deletion (>= 5 videos and > 30%)
  const vids10 = Array.from({ length: 10 }, (_, i) => makeVideo(`mv${i}`, { bornAt: 1000 }));
  const vTombs5 = Object.fromEntries(vids10.slice(0, 5).map(v => [v.id, { at: 2000 }]));
  const massVidRes = S.mergeSnapshots(
    makeSnap('dev-a', 'mac', '/Users/a/LinguaClip', { videos: vids10 }),
    [makeSnap('dev-b', 'android', '/data/user/0/app', { tombstones: { videos: vTombs5, cards: {} } })],
    { localPlatform: 'mac', localOwnDir: '/Users/a/LinguaClip', now: 5000, initialized: true, lastSyncAt: 1000 },
  );
  assert.ok(massVidRes.safetyAlert && massVidRes.safetyAlert.kind === 'massDeletion');
  assert.equal(massVidRes.summary.removedVideos, 5);

  // Higher format version v > SYNC_FORMAT skipped safely
  const futurePeer = makeSnap('dev-future', 'mac', '/Users/f/LinguaClip', { v: S.SYNC_FORMAT + 1, videos: [makeVideo('v-future')] });
  const futRes = S.mergeSnapshots(localNonEmpty, [futurePeer], {
    localPlatform: 'mac', localOwnDir: '/Users/a/LinguaClip', now: 5000, initialized: true, lastSyncAt: 1000,
  });
  assert.equal(futRes.newerFormat, true);
  assert.deepEqual(futRes.snapshot.videos.map(v => v.id), ['v1'], 'future-format peer skipped');
}

// =========================================================================
// 10. Three-device 100-round random-order convergence stress test
// =========================================================================
{
  let seed = 0x51a7c0de;
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const randInt = n => Math.floor(rand() * n);
  const pick = arr => arr[randInt(arr.length)];

  const canonicalize = snap => ({
    videos: snap.videos.map(({ videoPath: _vp, ...rest }) => rest),
    cards: snap.cards.map(({ videoPath: _vp, clip: _cl, ...rest }) => rest),
    cardMeta: snap.cardMeta,
    tombstones: snap.tombstones,
    daysDev: snap.daysDev,
    positions: snap.positions,
    posAt: snap.posAt,
    keptOrphans: snap.keptOrphans ?? [],
    idRedirects: snap.idRedirects ?? {},
    settings: snap.settings ?? {},
  });

  const devs = [
    { id: 'dev-a', platform: 'mac', ownDir: '/Users/a/LinguaClip' },
    { id: 'dev-b', platform: 'android', ownDir: '/data/user/0/app' },
    { id: 'dev-c', platform: 'windows', ownDir: 'C:\\Users\\c\\LinguaClip' },
  ];
  let snaps = devs.map(d => makeSnap(d.id, d.platform, d.ownDir, { exportedAt: 1_700_000_000_000, lastMergedAt: 1_700_000_000_000 }));
  let clock = 1_700_000_000_000;
  let seq = 0;
  const videoPool = ['v1', 'v2', 'v3', 'v4', 'v5'];
  const ways = ['all', 'custom', 'watch', 'read'];

  for (let round = 0; round < 100; round++) {
    clock += 60_000;
    // Independent offline mutations on all 3 devices
    for (let di = 0; di < 3; di++) {
      const s = structuredClone(snaps[di]);
      const d = devs[di];
      const ops = 2 + randInt(3);
      for (let o = 0; o < ops; o++) {
        clock += 5 + randInt(50);
        const ts = clock;
        const vid = pick(videoPool);
        const action = randInt(9);

        if (action === 0) {
          // Add or resurrect video
          const prevTomb = s.tombstones.videos[vid]?.at ?? 0;
          const prevVid = s.videos.find(v => v.id === vid);
          const born = S.bumpTs(Math.max(prevTomb, prevVid?.bornAt ?? 0), ts);
          delete s.tombstones.videos[vid];
          const updated = makeVideo(vid, {
            dateAdded: prevVid?.dateAdded ?? born,
            bornAt: born,
            lastPracticed: S.bumpTs(prevVid?.lastPracticed ?? 0, ts),
            updatedBy: d.id,
            completionRate: randInt(101),
            currentSubtitleIndex: randInt(10),
            totalPracticeTime: (prevVid?.totalPracticeTime ?? 0) + 10,
            videoPath: d.platform === 'android' ? `/data/user/0/app/${vid}.m4a` : `${d.ownDir}/${vid}.mp4`,
          });
          s.videos = [...s.videos.filter(v => v.id !== vid), updated];
        } else if (action === 1 && s.videos.length > 0) {
          // Delete video (randomly keepCards true/false)
          const target = pick(s.videos);
          const keepCards = rand() < 0.4;
          const delAt = S.bumpTs(target.bornAt ?? target.dateAdded ?? 0, ts);
          s.videos = s.videos.filter(v => v.id !== target.id);
          s.tombstones.videos[target.id] = { at: delAt, ...(keepCards ? { keepCards: true } : {}) };
          if (!keepCards) {
            for (const c of s.cards.filter(x => x.videoId === target.id)) {
              s.tombstones.cards[c.id] = S.bumpTs(s.cardMeta[c.id]?.bornAt ?? c.createdAt ?? 0, delAt);
              delete s.cardMeta[c.id];
            }
            s.cards = s.cards.filter(x => x.videoId !== target.id);
          } else {
            const kept = new Set(s.keptOrphans ?? []);
            for (const c of s.cards.filter(x => x.videoId === target.id)) kept.add(c.id);
            s.keptOrphans = Array.from(kept);
          }
        } else if (action === 2 && s.videos.length > 0) {
          // Add or toggle saved/missed card
          const target = pick(s.videos);
          const start = 1 + randInt(4);
          const cid = S.lineCardId(target.id, start);
          const existing = s.cards.find(c => c.id === cid);
          if (!existing) {
            const prevTomb = s.tombstones.cards[cid] ?? 0;
            const born = S.bumpTs(prevTomb, ts);
            delete s.tombstones.cards[cid];
            const { card, meta } = makeCardWithMeta(target.id, start, `Line ${start}`, born, rand() < 0.5 ? 'saved' : 'missed');
            s.cards.push(card);
            s.cardMeta[cid] = meta;
          } else {
            const m = s.cardMeta[cid] ?? { bornAt: existing.createdAt };
            const nextSaved = !existing.saved;
            const nextAt = S.bumpTs(Math.abs(m.savedAt ?? 0), ts);
            m.savedAt = nextSaved ? nextAt : -nextAt;
            existing.saved = nextSaved;
            existing.reasons = nextSaved
              ? Array.from(new Set([...existing.reasons, 'saved']))
              : existing.reasons.filter(r => r !== 'saved');
            s.cardMeta[cid] = m;
          }
        } else if (action === 3 && s.cards.length > 0) {
          // Review card with FSRS
          const idx = randInt(s.cards.length);
          const c = s.cards[idx];
          const m = s.cardMeta[c.id] ?? { bornAt: c.createdAt, base: { ...c.fsrs }, logs: [] };
          const grade = 1 + randInt(4);
          const revAt = S.bumpTs(c.fsrs.last_review ?? c.createdAt, ts + DAY * (1 + randInt(2)));
          const r = reviewLocal(c, m, `${d.id}-${++seq}`, grade, revAt);
          s.cards[idx] = r.card;
          s.cardMeta[c.id] = r.meta;
        } else if (action === 4 && s.cards.length > 0) {
          // Delete card
          const c = pick(s.cards);
          const born = s.cardMeta[c.id]?.bornAt ?? c.createdAt ?? 0;
          s.tombstones.cards[c.id] = S.bumpTs(born, ts);
          s.cards = s.cards.filter(x => x.id !== c.id);
          delete s.cardMeta[c.id];
        } else if (action === 5 && s.cards.length > 0) {
          // Toggle mastered / edit note / mark ankiAt
          const c = pick(s.cards);
          const m = s.cardMeta[c.id] ?? { bornAt: c.createdAt };
          if (rand() < 0.5) {
            c.mastered = S.bumpTs(Math.max(c.mastered ?? 0, m.unmasteredAt ?? 0), ts);
          } else {
            m.noteAt = S.bumpTs(m.noteAt ?? 0, ts);
            m.noteBy = d.id;
            c.definition = `def-${d.id}-${round}`;
            if (rand() < 0.3) c.ai = `ai-${round}`;
            c.ankiAt = Math.max(c.ankiAt ?? 0, ts);
          }
          s.cardMeta[c.id] = m;
        } else if (action === 6) {
          // Bump daysDev (G-Counter)
          const date = `2026-11-${String(1 + (round % 25)).padStart(2, '0')}`;
          if (!s.daysDev[date]) s.daysDev[date] = {};
          const prev = s.daysDev[date][d.id] ?? { sec: 0, lines: 0 };
          s.daysDev[date][d.id] = { sec: prev.sec + 15, lines: prev.lines + 2 };
        } else if (action === 7 && s.videos.length > 0) {
          // Update watch/custom/read/lastWay position (including reset to 0)
          const target = pick(s.videos);
          const pa = s.posAt[target.id] ?? {};
          const wTs = S.bumpTs(pa.watch ?? 0, ts);
          s.positions.watch[target.id] = rand() < 0.3 ? 0 : randInt(600);
          pa.watch = wTs;
          pa.watchBy = d.id;
          const lwTs = S.bumpTs(pa.lastWay ?? 0, ts);
          s.positions.lastWay[target.id] = pick(ways);
          pa.lastWay = lwTs;
          pa.lastWayBy = d.id;
          s.posAt[target.id] = pa;
        } else {
          // Update a safe setting + inject a blocked key
          if (!s.settings) s.settings = {};
          const prevAt = s.settings.linguaclip_speed_listen?.at ?? 0;
          s.settings.linguaclip_speed_listen = { value: String(1 + (round % 4) * 0.25), at: S.bumpTs(prevAt, ts), by: d.id };
          s.settings.linguaclip_ai_config = { value: `secret-${d.id}`, at: ts, by: d.id };
        }
      }
      snaps[di] = s;
    }

    // Random-order pairwise syncs (2 passes over random pairs ensures full gossip across 3 nodes)
    const pairs = [[0, 1], [1, 2], [2, 0], [1, 0], [2, 1], [0, 2]];
    for (let i = pairs.length - 1; i > 0; i--) {
      const j = randInt(i + 1);
      [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
    }
    for (const [dst, src] of pairs) {
      const d = devs[dst];
      snaps[dst] = S.mergeSnapshots(snaps[dst], [snaps[src]], {
        localPlatform: d.platform, localOwnDir: d.ownDir, now: clock + 1000, initialized: true, lastSyncAt: clock - 60_000,
      }).snapshot;
    }
    // Second randomized convergence pass so earliest pairs receive transitive updates
    for (const [dst, src] of [[0, 2], [1, 0], [2, 1]]) {
      const d = devs[dst];
      snaps[dst] = S.mergeSnapshots(snaps[dst], [snaps[src]], {
        localPlatform: d.platform, localOwnDir: d.ownDir, now: clock + 2000, initialized: true, lastSyncAt: clock,
      }).snapshot;
    }

    const c0 = canonicalize(snaps[0]);
    const c1 = canonicalize(snaps[1]);
    const c2 = canonicalize(snaps[2]);
    assert.deepEqual(c0, c1, `Round ${round}: dev-a and dev-b converged`);
    assert.deepEqual(c1, c2, `Round ${round}: dev-b and dev-c converged`);
    assert.equal(c0.settings.linguaclip_ai_config, undefined, `Round ${round}: secret never leaked`);
  }
}

// =========================================================================
// 11. QR Code matrix & SVG (short & 250+ char pair code)
// =========================================================================
{
  const checkQr = (payload, label) => {
    const mat = S.qrMatrix(payload);
    const n = mat.length;
    assert.ok(n >= 21 && (n - 17) % 4 === 0, `${label}: valid QR dimension ${n}`);
    assert.ok(mat.every(row => row.length === n), `${label}: square matrix`);
    // Verify 7x7 finder outer border & 3x3 center in all 3 corners
    for (const [fr, fc] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
      for (let r = 0; r < 7; r++) {
        for (let c = 0; c < 7; c++) {
          const expected = r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
          assert.equal(mat[fr + r][fc + c], expected, `${label}: finder (${fr + r},${fc + c})`);
        }
      }
    }
    // Dark module at (n - 8, 8)
    assert.equal(mat[n - 8][8], true, `${label}: dark module`);
    // Timing pattern alternating on row 6 and col 6
    for (let i = 8; i < n - 8; i++) {
      assert.equal(mat[6][i], i % 2 === 0, `${label}: horizontal timing`);
      assert.equal(mat[i][6], i % 2 === 0, `${label}: vertical timing`);
    }
    const svg = S.qrSvg(payload, 220);
    assert.ok(svg.startsWith('<svg ') && svg.includes('width="220"') && svg.includes('<path d="M') && svg.endsWith('</svg>'));
  };

  const shortCode = S.encodePairCode({
    preset: 'jianguoyun', url: S.JIANGUOYUN_URL, username: 'a@b.c', password: 'pw',
    rootDir: 'LC', syncClips: true, wifiOnlyClips: false,
  });
  checkQr(shortCode, 'short pair code');

  const longCode = S.encodePairCode({
    preset: 'custom',
    url: 'https://my-webdav-nas.example.com:8443/remote.php/dav/files/learner/',
    username: 'learner@example.com',
    password: 'app-password-中文-!@#$%1234567890',
    rootDir: '我的同步目录/LinguaClipSync',
    syncClips: true,
    wifiOnlyClips: true,
  });
  assert.ok(longCode.length >= 250 && longCode.length <= 350, `long pair code length ${longCode.length} in 250..350`);
  checkQr(longCode, 'long 250+ char pair code');
  assert.throws(() => S.qrMatrix('x'.repeat(400)), /too long/, 'rejects payloads exceeding Version 12 capacity');
}

// =========================================================================
// 12. Regression: abandoned/stale remote peer must NEVER resurrect GC'd items (Opus P0)
// =========================================================================
{
  const T0 = 1_700_000_000_000;
  const oldV = makeVideo('v-old', { dateAdded: T0 + DAY, bornAt: T0 + DAY, srtHash: S.srtHash('old') });
  const { card: oldC, meta: oldCMeta } = makeCardWithMeta('v-old', 2, 'Old line', T0 + DAY);
  const newOfflineV = makeVideo('v-after-gc', { dateAdded: T0 + 205 * DAY, bornAt: T0 + 205 * DAY, srtHash: S.srtHash('after') });

  // Abandoned phone last synced on Day 5 and stayed on WebDAV forever
  const abandonedPeer = makeSnap('dev-abandoned', 'android', '/data/user/0/com.linguaclip.app/files/LinguaClip', {
    exportedAt: T0 + 5 * DAY,
    lastMergedAt: T0 + 5 * DAY,
    videos: [oldV],
    cards: [oldC],
    cardMeta: { [oldC.id]: oldCMeta },
  });

  // Active desktop deleted v-old + c-old on Day 10
  const desktopDay200 = makeSnap('dev-desktop', 'mac', '/Users/u/Movies/LinguaClip', {
    exportedAt: T0 + 200 * DAY,
    lastMergedAt: T0 + 199 * DAY,
    videos: [],
    cards: [],
    tombstones: {
      videos: { 'v-old': { at: T0 + 10 * DAY } },
      cards: { [oldC.id]: T0 + 10 * DAY },
    },
  });

  // Day 200: tombstones > 90d old and abandonedPeer is > 180d inactive -> tombstones GC'd, gcFloorAt advances
  const r200 = S.mergeSnapshots(desktopDay200, [abandonedPeer], {
    localPlatform: 'mac', localOwnDir: '/Users/u/Movies/LinguaClip', now: T0 + 200 * DAY, initialized: true, lastSyncAt: T0 + 199 * DAY,
  });
  assert.deepEqual(r200.snapshot.videos, [], 'Day 200: v-old deleted');
  assert.deepEqual(r200.snapshot.cards, [], 'Day 200: c-old deleted');
  assert.equal(r200.snapshot.tombstones.videos['v-old'], undefined, 'Day 200: video tombstone GCd');
  assert.equal(r200.snapshot.tombstones.gcFloorAt, T0 + 10 * DAY, 'Day 200: gcFloorAt raised to Day 10');

  // Day 201: abandonedPeer file is STILL on WebDAV; must NOT resurrect v-old or c-old
  const r201 = S.mergeSnapshots(r200.snapshot, [abandonedPeer], {
    localPlatform: 'mac', localOwnDir: '/Users/u/Movies/LinguaClip', now: T0 + 201 * DAY, initialized: true, lastSyncAt: T0 + 200 * DAY,
  });
  assert.deepEqual(r201.snapshot.videos, [], 'Day 201: abandoned peer must NOT resurrect v-old');
  assert.deepEqual(r201.snapshot.cards, [], 'Day 201: abandoned peer must NOT resurrect c-old');
  assert.equal(r201.summary.addedVideos, 0);
  assert.equal(r201.summary.addedCards, 0);

  // If that stale peer ALSO has a genuinely new offline item created AFTER gcFloorAt, keep the new item only
  const revivedPeer = { ...abandonedPeer, videos: [oldV, newOfflineV] };
  const r206 = S.mergeSnapshots(r201.snapshot, [revivedPeer], {
    localPlatform: 'mac', localOwnDir: '/Users/u/Movies/LinguaClip', now: T0 + 206 * DAY, initialized: true, lastSyncAt: T0 + 201 * DAY,
  });
  assert.deepEqual(r206.snapshot.videos.map(v => v.id), ['v-after-gc'], 'keeps genuinely new offline video after gcFloorAt');

  // Stale peer with recent exportedAt but lastMergedAt < gcFloorAt must ALSO NOT resurrect v-old
  const staleRecentExport = { ...abandonedPeer, exportedAt: T0 + 201 * DAY };
  const r201b = S.mergeSnapshots(r200.snapshot, [staleRecentExport], {
    localPlatform: 'mac', localOwnDir: '/Users/u/Movies/LinguaClip', now: T0 + 201 * DAY, initialized: true, lastSyncAt: T0 + 200 * DAY,
  });
  assert.deepEqual(r201b.snapshot.videos, [], 'stale peer with recent exportedAt must NOT vouch for pre-GC items');
  assert.deepEqual(r201b.snapshot.cards, []);

  // HTTP allowlist parity (TS side accepts .ts.net, 100.64/10, fe80::/10; rejects query/fragment)
  assert.equal(S.isSafeWebDavUrl('http://nas.tail123.ts.net:8080/dav'), true);
  assert.equal(S.isSafeWebDavUrl('http://100.64.1.2:8080/dav'), true);
  assert.equal(S.isSafeWebDavUrl('http://[fe90::1]/dav'), true);
  assert.equal(S.isSafeWebDavUrl('https://dav.example.com/dav?x=1'), false);
  assert.equal(S.isSafeWebDavUrl('https://dav.example.com/dav#frag'), false);
  assert.equal(S.isSafeWebDavUrl('http://.ts.net/dav'), false);
}

// =========================================================================
// 13. Regression: local-only saveClips auto-enable never taints sync settingAt,
//     and undo of unmastered card survives cross-device merge
// =========================================================================
{
  const mem = new Map();
  const prevLS = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: k => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: k => { mem.delete(k); },
  };
  try {
    // Fresh device: enables saveClips without filling defaults or touching sync settingAt
    assert.equal(S.enableLocalSaveClipsIfUnset(), true);
    assert.deepEqual(JSON.parse(mem.get('linguaclip_practice_config')), { saveClips: true });
    assert.equal(S.getSyncState(globalThis.localStorage).settingAt?.linguaclip_practice_config, undefined,
      'fresh device auto-enable must NOT stamp linguaclip_practice_config settingAt');
    assert.equal(S.enableLocalSaveClipsIfUnset(), false, 'idempotent once set');

    // Explicit saveClips: false must never be overwritten
    mem.clear();
    mem.set('linguaclip_practice_config', JSON.stringify({ saveClips: false }));
    assert.equal(S.enableLocalSaveClipsIfUnset(), false);
    assert.equal(S.getPracticeConfig().saveClips, false);
    assert.equal(S.getSyncState(globalThis.localStorage).settingAt?.linguaclip_practice_config, undefined);

    // Explicit savePracticeConfig DOES touch settingAt (sanity check)
    S.savePracticeConfig({ sectionLength: 8, clozeLevel: 'medium', saveClips: true });
    assert.ok((S.getSyncState(globalThis.localStorage).settingAt?.linguaclip_practice_config?.at ?? 0) > 0);

    // Local-only saveLocalWatchChosen never fills default watch_prefs or touches sync settingAt
    mem.clear();
    S.saveLocalWatchChosen(false);
    assert.deepEqual(JSON.parse(mem.get('linguaclip_watch_prefs')), { chosen: false });
    assert.equal(S.getSyncState(globalThis.localStorage).settingAt?.linguaclip_watch_prefs, undefined,
      'switching ways on fresh device must NOT stamp linguaclip_watch_prefs settingAt');
    S.saveLocalWatchChosen(true);
    assert.deepEqual(JSON.parse(mem.get('linguaclip_watch_prefs')), { chosen: true });
    assert.equal(S.getSyncState(globalThis.localStorage).settingAt?.linguaclip_watch_prefs, undefined);
  } finally {
    if (prevLS === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = prevLS;
  }

  // Undo of stuck on a previously mastered card bumps mastered > unmasteredAt so sync preserves mastered
  const baseAt = 1_700_000_000_000;
  const { card: mCard, meta: mMeta } = makeCardWithMeta('v1', 42, 'Mastered line', baseAt, 'saved', { mastered: baseAt + 5 * DAY });
  const unmAt = baseAt + 10 * DAY;
  const afterStuck = (({ mastered: _, ...rest }) => ({ ...rest, reasons: [...rest.reasons, 'wrong'] }))(mCard);
  const afterStuckMeta = { ...mMeta, unmasteredAt: unmAt };
  const rev = S.revertAddedLine(afterStuck, { id: mCard.id, created: false, addedReason: true, prevMastered: mCard.mastered }, 'wrong');
  assert.ok(rev && rev.mastered === mCard.mastered);
  // Simulated undoAddLine bump: mastered = Math.max(rev.mastered, unmAt + 1)
  const undoneCard = { ...rev, mastered: Math.max(rev.mastered, unmAt + 1) };
  const merged = S.mergeCard(undoneCard, afterStuckMeta, 'dev-a', afterStuck, afterStuckMeta, 'dev-b');
  assert.equal(merged.card.mastered, unmAt + 1, 'mastered restored past unmasteredAt survives sync merge');
}

// =========================================================================
// 14. Compressed audio relay (L2b): offers, deterministic winner, stale cleanup,
//     deliveredAudioIds, and PairConfig backward compatibility
// =========================================================================
{
  const T = 1_750_000_000_000;
  const makeOffer = (file, createdAt, bytes = 2_000_000, offerId) => ({
    file, sha256: S.sha256Hex(file), bytes, durSec: 180, createdAt, ...(offerId ? { offerId } : {}),
  });

  // 14a. Desktop audioOffers merged to Android -> availableAudioOffers filtering & deterministic tie-break
  const vNormal = makeVideo('v-normal', { bornAt: T - DAY });
  const vPodcast = makeVideo('v-podcast', {
    bornAt: T - DAY,
    podcast: { show: 'S', feed: 'https://f.example/rss', guid: 'g1', name: 'ep1', audio: 'https://cdn.example/ep1.mp3' },
  });
  const vStarter = makeVideo('v-starter', { bornAt: T - DAY, videoPath: 'https://linguaclipapp.com/starter/1.mp3' });
  const vLocalHave = makeVideo('v-local-have', { bornAt: T - DAY });
  const vLostDisk = makeVideo('v-has-path', { bornAt: T - DAY, videoPath: '/data/user/0/app/media/v-has-path.m4a' });
  const vDeskPath = makeVideo('v-desk-path', { bornAt: T - DAY, videoPath: '/Users/a/Movies/v-desk-path.mp4' });
  const vMultiNewer = makeVideo('v-multi-newer', { bornAt: T - DAY });
  const vMultiTie = makeVideo('v-multi-tie', { bornAt: T - DAY });

  const deskA = makeSnap('dev-desk-a', 'mac', '/Users/a/LinguaClip', {
    exportedAt: T, lastMergedAt: T,
    videos: [vNormal, vPodcast, vStarter, vLocalHave, vLostDisk, vDeskPath, vMultiNewer, vMultiTie],
    audioOffers: {
      'v-podcast': makeOffer('dev-desk-a__v-podcast__111111111111.m4a', T - 100, 2_000_000, '111111111111'),
      'v-starter': makeOffer('dev-desk-a__v-starter__222222222222.m4a', T - 100, 2_000_000, '222222222222'),
      'v-local-have': makeOffer('dev-desk-a__v-local-have__333333333333.m4a', T - 100, 2_000_000, '333333333333'),
      'v-has-path': makeOffer('dev-desk-a__v-has-path__444444444444.m4a', T - 100, 2_000_000, '444444444444'),
      'v-desk-path': makeOffer('dev-desk-a__v-desk-path__555555555555.m4a', T - 100, 2_000_000, '555555555555'),
      'v-multi-newer': makeOffer('dev-desk-a__v-multi-newer__666666666666.m4a', T - 500, 2_000_000, '666666666666'),
      'v-multi-tie': makeOffer('dev-desk-a__v-multi-tie__777777777777.m4a', T - 200, 2_000_000, '777777777777'),
    },
  });
  const deskB = makeSnap('dev-desk-b', 'windows', 'C:\\Users\\b\\LinguaClip', {
    exportedAt: T, lastMergedAt: T,
    videos: [vNormal, vMultiNewer, vMultiTie],
    audioOffers: {
      'v-normal': makeOffer('dev-desk-b__v-normal__888888888888.m4a', T - 300, 2_000_000, '888888888888'),
      'v-multi-newer': makeOffer('dev-desk-b__v-multi-newer__999999999999.m4a', T - 100, 2_000_000, '999999999999'),
      'v-multi-tie': makeOffer('dev-desk-b__v-multi-tie__aaaaaaaaaaaa.m4a', T - 200, 2_000_000, 'aaaaaaaaaaaa'),
    },
  });
  const androidLocal = makeSnap('dev-and-1', 'android', '/data/user/0/app', {
    exportedAt: T - 1000, lastMergedAt: T - 1000,
    videos: [vStarter, vLocalHave, vLostDisk, vDeskPath],
  });

  const andMerge = S.mergeSnapshots(androidLocal, [deskB, deskA], {
    localPlatform: 'android', localOwnDir: '/data/user/0/app', now: T, initialized: true, lastSyncAt: T - 1000,
    localAudioHave: ['v-local-have'],
  });
  assert.deepEqual(
    andMerge.availableAudioOffers.map(o => [o.videoId, o.fromDevId, o.file]),
    [
      ['v-desk-path', 'dev-desk-a', 'dev-desk-a__v-desk-path__555555555555.m4a'],
      ['v-has-path', 'dev-desk-a', 'dev-desk-a__v-has-path__444444444444.m4a'],
      ['v-multi-newer', 'dev-desk-b', 'dev-desk-b__v-multi-newer__999999999999.m4a'],
      ['v-multi-tie', 'dev-desk-a', 'dev-desk-a__v-multi-tie__777777777777.m4a'],
      ['v-normal', 'dev-desk-b', 'dev-desk-b__v-normal__888888888888.m4a'],
    ],
    'Android availableAudioOffers skips podcast/http/localHave, STILL includes stale desktop path & missing disk file, and picks deterministic winner',
  );
  assert.deepEqual(
    andMerge.localAudioAck,
    { 'v-local-have': '333333333333' },
    'Android already having playable local audio acks peer offerId directly without re-downloading',
  );

  // Desktop never populates availableAudioOffers
  const deskMerge = S.mergeSnapshots(deskA, [deskB], {
    localPlatform: 'mac', localOwnDir: '/Users/a/LinguaClip', now: T, initialized: true, lastSyncAt: T - 1000,
  });
  assert.deepEqual(deskMerge.availableAudioOffers, [], 'desktop never populates availableAudioOffers');

  // 14b. Desktop staleAudioVideoIds & deliveredAudioIds
  const vDelivered = makeVideo('v-delivered', { bornAt: T - 10 * DAY });
  const vPartial = makeVideo('v-partial', { bornAt: T - 10 * DAY });
  const vWaiting = makeVideo('v-waiting', { bornAt: T - 10 * DAY });
  const vExpired = makeVideo('v-expired', { bornAt: T - 40 * DAY });
  const vTomb = makeVideo('v-tomb', { bornAt: T - 10 * DAY });

  const deskSender = makeSnap('dev-desk-send', 'mac', '/Users/s/LinguaClip', {
    exportedAt: T - HOUR, lastMergedAt: T - HOUR,
    videos: [vDelivered, vPartial, vWaiting, vExpired, vTomb],
    audioOffers: {
      'v-delivered': makeOffer('dev-desk-send__v-delivered__d11111111111.m4a', T - 8 * DAY, 2_000_000, 'd11111111111'),
      'v-partial': makeOffer('dev-desk-send__v-partial__p11111111111.m4a', T - 8 * DAY, 2_000_000, 'p11111111111'),
      'v-waiting': makeOffer('dev-desk-send__v-waiting__w11111111111.m4a', T - 8 * DAY, 2_000_000, 'w11111111111'),
      'v-expired': makeOffer('dev-desk-send__v-expired__e11111111111.m4a', T - 31 * DAY, 2_000_000, 'e11111111111'),
      'v-tomb': makeOffer('dev-desk-send__v-tomb__t11111111111.m4a', T - 8 * DAY, 2_000_000, 't11111111111'),
    },
  });
  const andActive1 = makeSnap('dev-and-1', 'android', '/data/user/0/app', {
    exportedAt: T - 2 * DAY, lastMergedAt: T - 2 * DAY,
    videos: [vDelivered, vPartial, vWaiting, vExpired],
    tombstones: { videos: { 'v-tomb': { at: T - HOUR } }, cards: {} },
    audioHave: ['v-delivered', 'v-partial', 'v-tomb'],
    audioAck: { 'v-delivered': 'd11111111111', 'v-partial': 'p11111111111', 'v-tomb': 't11111111111' },
  });
  const andActive2 = makeSnap('dev-and-2', 'android', '/data/user/0/app', {
    exportedAt: T - 5 * DAY, lastMergedAt: T - 5 * DAY,
    videos: [vDelivered, vPartial, vWaiting, vExpired],
    audioHave: ['v-delivered'],
    audioAck: { 'v-delivered': 'd11111111111' },
  });
  const andInactiveOld = makeSnap('dev-and-old', 'android', '/data/user/0/app', {
    exportedAt: T - 35 * DAY, lastMergedAt: T - 35 * DAY,
    videos: [vDelivered],
    audioHave: [], // inactive > 30d: must NOT block cleanup
  });

  // Single active Android peer: v-delivered + v-partial + v-tomb + v-expired all stale
  const singleRes = S.mergeSnapshots(deskSender, [andActive1], {
    localPlatform: 'mac', localOwnDir: '/Users/s/LinguaClip', now: T, initialized: true, lastSyncAt: T - HOUR,
  });
  assert.deepEqual(singleRes.staleAudioVideoIds, ['v-delivered', 'v-expired', 'v-partial', 'v-tomb']);
  assert.deepEqual(singleRes.deliveredAudioIds, ['v-delivered', 'v-partial'], 'deliveredAudioIds excludes tombstoned v-tomb');

  // Multiple Android peers (2 active + 1 inactive >30d): v-delivered stale, v-partial waits for active2, old inactive ignored
  const multiRes = S.mergeSnapshots(deskSender, [andActive1, andActive2, andInactiveOld], {
    localPlatform: 'mac', localOwnDir: '/Users/s/LinguaClip', now: T, initialized: true, lastSyncAt: T - HOUR,
  });
  assert.deepEqual(
    multiRes.staleAudioVideoIds,
    ['v-delivered', 'v-expired', 'v-tomb'],
    'requires all active <=30d Androids to ack; >30d inactive Android does not block; tombstone & >30d TTL cleaned',
  );
  assert.deepEqual(multiRes.deliveredAudioIds, ['v-delivered'], 'undelivered local offer v-partial excluded from deliveredAudioIds');

  // 14c. offerId re-send anti-premature-delete + peersIncomplete guard + malformed audio fields resilience
  const deskResend = makeSnap('dev-desk-resend', 'mac', '/Users/s/LinguaClip', {
    exportedAt: T - 50, lastMergedAt: T - 50,
    videos: [vDelivered, vExpired, vTomb],
    audioOffers: {
      'v-delivered': makeOffer('dev-desk-resend__v-delivered__bbbbbbbbbbbb.m4a', T - 100, 2_000_000, 'bbbbbbbbbbbb'),
      'v-expired': makeOffer('dev-desk-resend__v-expired__eeeeeeeeeeee.m4a', T - 31 * DAY, 2_000_000, 'eeeeeeeeeeee'),
      'v-tomb': makeOffer('dev-desk-resend__v-tomb__tttttttttttt.m4a', T - 100, 2_000_000, 'tttttttttttt'),
    },
  });
  const andOldAck = makeSnap('dev-and-ack', 'android', '/data/user/0/app', {
    exportedAt: T - 10, lastMergedAt: T - 10, // newer than offer.createdAt, yet holds OLD offerId
    videos: [vDelivered, vExpired],
    tombstones: { videos: { 'v-tomb': { at: T - 20 } }, cards: {} },
    audioHave: ['v-delivered'],
    audioAck: { 'v-delivered': 'aaaaaaaaaaaa' },
  });
  const resOldAck = S.mergeSnapshots(deskResend, [andOldAck], {
    localPlatform: 'mac', localOwnDir: '/Users/s/LinguaClip', now: T, initialized: true, lastSyncAt: T - 50,
  });
  assert.deepEqual(resOldAck.staleAudioVideoIds, ['v-expired', 'v-tomb'], 'old offerId ack MUST NOT prematurely delete re-sent offer');
  assert.deepEqual(resOldAck.deliveredAudioIds, [], 're-sent pending offer MUST NOT simultaneously appear in deliveredAudioIds');

  const andNewAck = { ...andOldAck, audioAck: { 'v-delivered': 'bbbbbbbbbbbb' } };
  const resNewAck = S.mergeSnapshots(deskResend, [andNewAck], {
    localPlatform: 'mac', localOwnDir: '/Users/s/LinguaClip', now: T, initialized: true, lastSyncAt: T - 50,
  });
  assert.deepEqual(resNewAck.staleAudioVideoIds, ['v-delivered', 'v-expired', 'v-tomb'], 'matching new offerId ack marks offer stale immediately');
  assert.deepEqual(resNewAck.deliveredAudioIds, ['v-delivered']);

  // Legacy Android peer without audioAck: exportedAt <= createdAt does NOT delete; exportedAt > createdAt DOES delete
  const andLegacyOld = makeSnap('dev-and-leg', 'android', '/data/user/0/app', {
    exportedAt: T - 200, lastMergedAt: T - 200,
    videos: [vDelivered], audioHave: ['v-delivered'],
  });
  const resLegOld = S.mergeSnapshots(deskResend, [andLegacyOld], {
    localPlatform: 'mac', localOwnDir: '/Users/s/LinguaClip', now: T, initialized: true, lastSyncAt: T - 50,
  });
  assert.equal(resLegOld.staleAudioVideoIds.includes('v-delivered'), false, 'legacy peer snapshot older than offer.createdAt must NOT delete');
  const andLegacyFresh = { ...andLegacyOld, exportedAt: T - 50, lastMergedAt: T - 50 };
  const resLegFresh = S.mergeSnapshots(deskResend, [andLegacyFresh], {
    localPlatform: 'mac', localOwnDir: '/Users/s/LinguaClip', now: T, initialized: true, lastSyncAt: T - 50,
  });
  assert.equal(resLegFresh.staleAudioVideoIds.includes('v-delivered'), true, 'legacy peer snapshot newer than offer.createdAt still deletes');

  // peersIncomplete: true suppresses delivery cleanup, keeps tombstone & >30d TTL cleanup
  const resIncomplete = S.mergeSnapshots(deskResend, [andNewAck], {
    localPlatform: 'mac', localOwnDir: '/Users/s/LinguaClip', now: T, initialized: true, lastSyncAt: T - 50,
    peersIncomplete: true,
  });
  assert.deepEqual(resIncomplete.staleAudioVideoIds, ['v-expired', 'v-tomb'], 'peersIncomplete skips delivery deletion but keeps TTL & tombstone cleanup');

  // Malformed audioHave / audioAck / audioOffers in peer snapshots safely ignored without throwing
  const badPeer = makeSnap('dev-bad', 'android', '/data/user/0/app', {
    exportedAt: T - 10, lastMergedAt: T - 10,
    videos: [vNormal],
    audioHave: 'not-an-array',
    audioAck: ['not-an-object'],
    audioOffers: {
      badNull: null,
      badShape: { file: 123, sha256: null, bytes: -5, durSec: 'x', createdAt: NaN },
      'v-normal': makeOffer('dev-bad__v-normal__cccccccccccc.m4a', T - 10, 1024, 'cccccccccccc'),
    },
  });
  const badPeer2 = makeSnap('dev-bad-2', 'mac', '/Users/x', {
    exportedAt: T - 10, lastMergedAt: T - 10,
    videos: [vNormal],
    audioHave: [123, null, '', 'v-normal'],
    audioAck: { 'v-normal': 42 },
    audioOffers: 'not-an-object',
  });
  const resBad = S.mergeSnapshots(androidLocal, [badPeer, badPeer2], {
    localPlatform: 'android', localOwnDir: '/data/user/0/app', now: T, initialized: true, lastSyncAt: T - 50,
  });
  assert.deepEqual(resBad.availableAudioOffers.map(o => o.videoId), ['v-normal'], 'malformed audio fields ignored while valid offer survives');

  // 14c-4. Newer-format peer defers ack-based deletion & empty-sha256 offer is dropped
  const newerAndroid = makeSnap('and-future', 'android', '/data/user/0/app', {
    v: S.SYNC_FORMAT + 1, exportedAt: T - 10, lastMergedAt: T - 10, videos: [vDelivered],
  });
  const resNewer = S.mergeSnapshots(deskResend, [andNewAck, newerAndroid], {
    localPlatform: 'mac', localOwnDir: '/Users/s/LinguaClip', now: T, initialized: true, lastSyncAt: T - 50,
  });
  assert.equal(resNewer.newerFormat, true);
  assert.deepEqual(resNewer.staleAudioVideoIds, ['v-expired', 'v-tomb'], 'newer-format peer prevents ack-based premature deletion');

  const emptyShaPeer = makeSnap('desk-empty-sha', 'mac', '/Users/u/Movies/LinguaClip', {
    videos: [vNormal],
    audioOffers: { 'v-normal': { file: 'desk__v-normal__aa11bb22cc33.m4a', sha256: '', bytes: 1000, durSec: 10, createdAt: T - 10, offerId: 'aa11bb22cc33' } },
  });
  const resEmptySha = S.mergeSnapshots(androidLocal, [emptyShaPeer], {
    localPlatform: 'android', localOwnDir: '/data/user/0/app', now: T, initialized: true, lastSyncAt: T - 50,
  });
  assert.deepEqual(resEmptySha.availableAudioOffers, [], 'empty sha256 audio offer is rejected during merge');

  // 14d. PairConfig backward compatibility (excludes autoSyncAudio; missing wifiOnlyAudio defaults to true)
  const fullCfgWithAuto = {
    enabled: true,
    preset: 'jianguoyun',
    url: S.JIANGUOYUN_URL,
    username: 'u@example.com',
    password: 'secret',
    rootDir: 'LinguaClip',
    syncClips: true,
    wifiOnlyClips: false,
    autoSyncAudio: true,
    wifiOnlyAudio: false,
  };
  const encodedNoAuto = S.encodePairCode(fullCfgWithAuto);
  const decodedNoAuto = S.decodePairCode(encodedNoAuto);
  assert.equal(decodedNoAuto.wifiOnlyAudio, false);
  assert.equal('autoSyncAudio' in decodedNoAuto, false, 'PairConfig never carries desktop-only autoSyncAudio');

  // Legacy pairing code without `a` / `wifiOnlyAudio` field -> defaults wifiOnlyAudio to true
  const legacyPayload = Buffer.from(JSON.stringify({
    p: 'j', u: S.JIANGUOYUN_URL, n: 'u@example.com', w: 'secret', d: 'LinguaClip', c: 1, f: 0,
  })).toString('base64url');
  const legacyDecoded = S.decodePairCode(`${S.PAIR_PREFIX}${legacyPayload}`);
  assert.ok(legacyDecoded, 'legacy pair code without wifiOnlyAudio still decodes');
  assert.equal(legacyDecoded.wifiOnlyAudio, true, 'missing wifiOnlyAudio defaults to true');
}

console.log('test-sync-merge: all passed (including 100-round 3-device convergence + GC anti-zombie + L2b audio relay)');
