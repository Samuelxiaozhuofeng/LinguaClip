/**
 * End-to-end runtime integration tests for `utils/syncApply.ts` and `utils/syncEngine.ts`
 * (docs/sync.md). Bundles the real TypeScript modules with esbuild, injecting an in-memory
 * IndexedDB / localStorage / WebDAV / clip-pack / merge-pack transport bridge.
 *
 * Run with: node test-sync-engine.mjs
 */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// --- 1. Multi-device in-memory IDB + localStorage + disk/WebDAV harness ---

function clone(v) {
  return v === undefined ? undefined : structuredClone(v);
}

function makeDeviceEnv(name, platform, ownDir) {
  return {
    name,
    platform,
    ownDir,
    dbs: new Map(), // dbName -> Map<storeName, Map<key, record>>
    ls: new Map(),
    clips: new Map(), // filename -> bytes/string
    caches: new Map(), // `${id}.${kind}` -> text
    media: new Map(), // `${ownDir}/media/${id}.${ext}` -> bytes
    preSnapshots: 0,
  };
}

let activeDev = null;

function ensureStore(dbName, storeName) {
  let dbMap = activeDev.dbs.get(dbName);
  if (!dbMap) { dbMap = new Map(); activeDev.dbs.set(dbName, dbMap); }
  let st = dbMap.get(storeName);
  if (!st) { st = new Map(); dbMap.set(storeName, st); }
  return st;
}

class FakeIDBDatabase {
  constructor(name) {
    this.name = name;
    this.objectStoreNames = {
      contains: s => !!activeDev.dbs.get(this.name)?.has(s),
    };
  }
  createObjectStore(storeName) {
    ensureStore(this.name, storeName);
    return {};
  }
  transaction(storeNames) {
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    const dev = activeDev;
    const tx = {
      error: null,
      oncomplete: null,
      onerror: null,
      onabort: null,
      _pending: 0,
      _finished: false,
      abort() {
        this._finished = true;
        queueMicrotask(() => this.onabort?.());
      },
      _schedule(work) {
        const req = { result: undefined, error: null, onsuccess: null, onerror: null };
        this._pending++;
        queueMicrotask(() => {
          if (this._finished) return;
          try {
            req.result = work();
            req.onsuccess?.({ target: req });
          } catch (e) {
            req.error = e;
            this.error = e;
            req.onerror?.({ target: req });
            this._finished = true;
            this.onerror?.();
            return;
          }
          if (--this._pending === 0 && !this._finished) {
            this._finished = true;
            this.oncomplete?.();
          }
        });
        return req;
      },
      objectStore: storeName => {
        if (!names.includes(storeName)) throw new Error(`Store ${storeName} not in tx`);
        const getMap = () => {
          let dbMap = dev.dbs.get(this.name);
          if (!dbMap) { dbMap = new Map(); dev.dbs.set(this.name, dbMap); }
          let st = dbMap.get(storeName);
          if (!st) { st = new Map(); dbMap.set(storeName, st); }
          return st;
        };
        return {
          get: key => tx._schedule(() => clone(getMap().get(key))),
          getAll: () => tx._schedule(() => Array.from(getMap().values(), clone)),
          put: val => tx._schedule(() => { getMap().set(val.id, clone(val)); return val.id; }),
          delete: key => tx._schedule(() => { getMap().delete(key); }),
          clear: () => { throw new Error('FORBIDDEN: sync must never call IDB clear()'); },
        };
      },
    };
    // Complete empty transactions (e.g., setClip([], ...))
    queueMicrotask(() => {
      if (tx._pending === 0 && !tx._finished) {
        tx._finished = true;
        tx.oncomplete?.();
      }
    });
    return tx;
  }
}

globalThis.indexedDB = {
  open(name) {
    const req = { result: null, error: null, onupgradeneeded: null, onsuccess: null, onerror: null };
    queueMicrotask(() => {
      const db = new FakeIDBDatabase(name);
      req.result = db;
      req.onupgradeneeded?.({ target: req });
      req.onsuccess?.({ target: req });
    });
    return req;
  },
};

globalThis.localStorage = {
  getItem: k => (activeDev.ls.has(k) ? activeDev.ls.get(k) : null),
  setItem: (k, v) => { activeDev.ls.set(k, String(v)); },
  removeItem: k => { activeDev.ls.delete(k); },
  clear: () => { activeDev.ls.clear(); },
  key: i => Array.from(activeDev.ls.keys())[i] ?? null,
  get length() { return activeDev.ls.size; },
};

const cloud = {
  files: new Map(), // relPath -> { content, etag, size }
  packs: new Map(), // zipPath -> { snapshotJson, subs, clips: Map<name, content> }
  jsonPacks: new Map(), // jsonPath -> content
  etagSeq: 1,
  reqCount: 0,
  forceError: null,
  uploadAudioError: null,
  wifiOk: true,
  nextAudioBytes: null,
  onDownloadClipPack: null,
  onPutGz: null,
  onList: null,
  onUploadAudio: null,
  reset() {
    this.files.clear();
    this.packs.clear();
    this.jsonPacks.clear();
    this.reqCount = 0;
    this.forceError = null;
    this.uploadAudioError = null;
    this.wifiOk = true;
    this.nextAudioBytes = null;
    this.onDownloadClipPack = null;
    this.onPutGz = null;
    this.onList = null;
    this.onUploadAudio = null;
  },
  put(relPath, content) {
    const etag = `"etag-${this.etagSeq++}"`;
    this.files.set(relPath, { content, etag, size: Buffer.byteLength(content) });
    return etag;
  },
};

globalThis.__SYNC_BRIDGE__ = {
  syncWebdavSupported: () => true,
  syncWebdavTest: async () => {
    cloud.reqCount++;
    if (cloud.forceError) throw new Error(cloud.forceError);
    const existingDevices = Array.from(cloud.files.keys()).filter(k => k.startsWith('devices/') && k.endsWith('.json.gz')).length;
    return { ok: true, remoteRoot: 'https://dav.jianguoyun.com/dav/LinguaClip/LinguaClipSync/', existingDevices };
  },
  syncWebdavList: async (_cfg, subpath) => {
    cloud.reqCount++;
    if (cloud.forceError) throw new Error(cloud.forceError);
    if (cloud.onList) await cloud.onList(subpath);
    const prefix = `${subpath}/`;
    const out = [];
    for (const [k, v] of cloud.files.entries()) {
      if (!k.startsWith(prefix)) continue;
      const name = k.slice(prefix.length);
      if (!name.includes('/')) out.push({ name, etag: v.etag, size: v.size });
    }
    return out;
  },
  syncWebdavGetGz: async (_cfg, relPath) => {
    cloud.reqCount++;
    if (cloud.forceError) throw new Error(cloud.forceError);
    const entry = cloud.files.get(relPath);
    if (!entry) throw new Error('sync:notfound');
    if (entry.content === '__CORRUPT_GZIP__') throw new Error('sync:corrupt:gzip:invalid header');
    return entry.content;
  },
  syncWebdavPutGz: async (_cfg, relPath, content) => {
    cloud.reqCount++;
    if (cloud.forceError) throw new Error(cloud.forceError);
    if (cloud.onPutGz) await cloud.onPutGz(relPath, content);
    return cloud.put(relPath, content);
  },
  syncWebdavDelete: async (_cfg, relPath) => {
    cloud.reqCount++;
    cloud.files.delete(relPath);
  },
  syncUploadAudio: async (_cfg, srcPath, relPath, maxBytes) => {
    cloud.reqCount++;
    if (cloud.onUploadAudio) await cloud.onUploadAudio(srcPath, relPath, maxBytes);
    if (cloud.forceError) throw new Error(cloud.forceError);
    if (cloud.uploadAudioError) throw new Error(cloud.uploadAudioError);
    assert.match(relPath, /^audio\/[0-9a-f-]+__[A-Za-z0-9_-]+__[0-9a-f]{12}\.m4a$/, `3-segment offerId audio filename: ${relPath}`);
    const payload = activeDev.media.get(srcPath) ?? `M4A_AUDIO:${srcPath}`;
    const sha256 = createHash('sha256').update(payload).digest('hex');
    const bytes = cloud.nextAudioBytes ?? Buffer.byteLength(payload);
    if (typeof maxBytes === 'number' && bytes > maxBytes) throw new Error('sync:audio_budget');
    cloud.put(relPath, payload);
    const entry = cloud.files.get(relPath);
    if (entry) entry.size = bytes;
    return { file: relPath.replace(/^audio\//, ''), sha256, bytes, durSec: 120 };
  },
  syncDownloadAudio: async (_cfg, relPath, videoId, expectedSha256) => {
    cloud.reqCount++;
    if (cloud.forceError) throw new Error(cloud.forceError);
    const entry = cloud.files.get(relPath);
    if (!entry) throw new Error('sync:notfound');
    const actualSha = createHash('sha256').update(entry.content).digest('hex');
    if (!expectedSha256 || !/^[0-9a-f]{64}$/.test(expectedSha256) || actualSha !== expectedSha256) throw new Error('sync:corrupt:sha256');
    const savedPath = `${activeDev.ownDir}/media/${videoId}.m4a`;
    activeDev.media.set(savedPath, entry.content);
    return savedPath;
  },
  syncUploadClipPack: async (_cfg, relPath, files) => {
    cloud.reqCount++;
    if (cloud.forceError) throw new Error(cloud.forceError);
    const packObj = {};
    const packed = [];
    for (const f of files) {
      if (activeDev.clips.has(f)) {
        packObj[f] = activeDev.clips.get(f);
        packed.push(f);
      }
    }
    if (packed.length > 0) cloud.put(relPath, JSON.stringify(packObj));
    return packed;
  },
  syncDownloadClipPack: async (_cfg, relPath, wantedFiles) => {
    cloud.reqCount++;
    if (cloud.forceError) throw new Error(cloud.forceError);
    if (cloud.onDownloadClipPack) await cloud.onDownloadClipPack(relPath, wantedFiles);
    const entry = cloud.files.get(relPath);
    if (!entry) throw new Error('sync:notfound');
    const packObj = JSON.parse(entry.content);
    const extracted = [];
    for (const f of wantedFiles) {
      if (typeof packObj[f] === 'string') {
        activeDev.clips.set(f, packObj[f]);
        extracted.push(f);
      }
    }
    return extracted;
  },
  syncWriteMergePack: async (dest, snapshotJson, subs, clipFiles) => {
    const path = dest || `${activeDev.ownDir}/tmp/exports/pack-${Date.now()}.zip`;
    const clips = new Map();
    for (const f of clipFiles) if (activeDev.clips.has(f)) clips.set(f, activeDev.clips.get(f));
    cloud.packs.set(path, { snapshotJson, subs, clips });
    return path;
  },
  syncWriteMergeJson: async (dest, content) => {
    const path = dest || `${activeDev.ownDir}/tmp/exports/pack-${Date.now()}.json`;
    cloud.jsonPacks.set(path, content);
    return path;
  },
  syncReadMergePack: async path => {
    const p = cloud.packs.get(path);
    if (!p) throw new Error('sync:io:not found');
    return { snapshotJson: p.snapshotJson, subs: p.subs, clipNames: Array.from(p.clips.keys()) };
  },
  syncUnpackMergePack: async (path, wantedFiles) => {
    const p = cloud.packs.get(path);
    if (!p) throw new Error('sync:io:not found');
    const extracted = [];
    for (const f of wantedFiles) {
      if (p.clips.has(f)) { activeDev.clips.set(f, p.clips.get(f)); extracted.push(f); }
    }
    return extracted;
  },
  syncRekeyFiles: async (fromId, toId) => {
    let moved = 0;
    const mediaPaths = [];
    for (const [k, v] of Array.from(activeDev.caches.entries())) {
      if (k.startsWith(`${fromId}.`)) {
        const nk = `${toId}${k.slice(fromId.length)}`;
        if (!activeDev.caches.has(nk)) { activeDev.caches.set(nk, v); activeDev.caches.delete(k); moved++; }
      }
    }
    const prefix = `${activeDev.ownDir}/media/${fromId}.`;
    for (const [p, v] of Array.from(activeDev.media.entries())) {
      if (p.startsWith(prefix)) {
        const dst = `${activeDev.ownDir}/media/${toId}.${p.slice(prefix.length)}`;
        if (!activeDev.media.has(dst)) { activeDev.media.set(dst, v); activeDev.media.delete(p); moved++; }
        mediaPaths.push([p, dst]);
      }
    }
    return { moved, mediaPaths };
  },
  syncClipNetworkOk: async wifiOnly => (wifiOnly ? cloud.wifiOk : true),
  readCacheText: async (id, kind) => activeDev.caches.get(`${id}.${kind}`) ?? null,
  writeCacheText: async (id, kind, text) => { activeDev.caches.set(`${id}.${kind}`, text); },
  pickSyncPackDest: async name => `${activeDev.ownDir}/${name}`,
  shareSyncPackFile: async () => {},
};

// --- 2. Bundle real syncApply + syncEngine + app data modules with virtual desktop bridge ---

const mockDesktopPlugin = {
  name: 'mock-desktop-bridge',
  setup(b) {
    b.onResolve({ filter: /^\.\/desktop$/ }, () => ({ path: 'virtual-desktop', namespace: 'mock' }));
    b.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({
      contents: `
        const B = () => globalThis.__SYNC_BRIDGE__;
        export const syncWebdavSupported = () => B().syncWebdavSupported();
        export const syncWebdavTest = (...a) => B().syncWebdavTest(...a);
        export const syncWebdavList = (...a) => B().syncWebdavList(...a);
        export const syncWebdavGetGz = (...a) => B().syncWebdavGetGz(...a);
        export const syncWebdavPutGz = (...a) => B().syncWebdavPutGz(...a);
        export const syncWebdavDelete = (...a) => B().syncWebdavDelete(...a);
        export const syncUploadAudio = (...a) => B().syncUploadAudio(...a);
        export const syncDownloadAudio = (...a) => B().syncDownloadAudio(...a);
        export const syncUploadClipPack = (...a) => B().syncUploadClipPack(...a);
        export const syncDownloadClipPack = (...a) => B().syncDownloadClipPack(...a);
        export const syncWriteMergePack = (...a) => B().syncWriteMergePack(...a);
        export const syncWriteMergeJson = (...a) => B().syncWriteMergeJson(...a);
        export const syncReadMergePack = (...a) => B().syncReadMergePack(...a);
        export const syncUnpackMergePack = (...a) => B().syncUnpackMergePack(...a);
        export const syncRekeyFiles = (...a) => B().syncRekeyFiles(...a);
        export const syncClipNetworkOk = (...a) => B().syncClipNetworkOk(...a);
        export const readCacheText = (...a) => B().readCacheText(...a);
        export const writeCacheText = (...a) => B().writeCacheText(...a);
        export const pickSyncPackDest = (...a) => B().pickSyncPackDest(...a);
        export const shareSyncPackFile = (...a) => B().shareSyncPackFile(...a);
        export const jaDictStatus = async () => ({ installed: false, dir: '', bytes: 0 });
        export const installJaDict = async () => {};
        export const removeJaDict = async () => {};
        export const readBinaryFile = async () => new Uint8Array();
        export const onJaDictProgress = async () => () => {};
      `,
      loader: 'js',
    }));
  },
};

const out = join(tmpdir(), `sync-engine-${process.pid}.mjs`);
await build({
  stdin: {
    contents: `
      export * from './utils/syncApply';
      export * from './utils/syncEngine';
      export * from './utils/syncAudio';
      export * from './utils/syncConfig';
      export * from './utils/syncClock';
      export * from './utils/syncMeta';
      export { saveVideoToDB, getAllVideosFromDB, getVideoFromDB } from './utils/fileSystemAccess';
      export { addLine, recordOutcome, deleteCards, getAllCards, setClip, readAll, subscribeCards, lineCardId } from './utils/review';
      export { setWatchPos, getWatchPos, saveWatchPrefs, getWatchPrefs, savePracticeConfig, getPracticeConfig } from './utils/storage';
      export { countLine, getDays, readDaysDev } from './utils/today';
    `,
    resolveDir: '.',
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  outfile: out,
  plugins: [mockDesktopPlugin],
  logLevel: 'error',
});
const M = await import(out);

const DAV_CFG = {
  enabled: true,
  preset: 'jianguoyun',
  url: 'https://dav.jianguoyun.com/dav/',
  username: 'alice@example.com',
  password: 'app-password',
  rootDir: 'LinguaClip',
  syncClips: true,
  wifiOnlyClips: false,
};

const SRT_1 = '1\n00:00:01,000 --> 00:00:03,000\nHello world.\n\n2\n00:00:04,000 --> 00:00:06,000\nSecond line.\n';
const SRT_2 = '1\n00:00:02,000 --> 00:00:05,000\nPodcast episode line.\n';

const makeVideoRec = (id, subtitleText, over = {}) => ({
  id,
  displayName: `${id}.mp4`,
  videoFileName: `${id}.mp4`,
  subtitleFileName: `${id}.srt`,
  subtitleText,
  currentSubtitleIndex: 0,
  currentSectionIndex: 0,
  totalSubtitles: 2,
  completionRate: 0,
  dateAdded: 10_000,
  lastPracticed: 10_000,
  totalPracticeTime: 60,
  ...over,
});

const runOptsFor = (dev, over = {}) => ({
  platform: dev.platform,
  ownDir: dev.ownDir,
  savePreSnapshot: async () => { dev.preSnapshots++; },
  ...over,
});

// =========================================================================
// Test 1: Two-device (Desktop + Android) bidirectional convergence & videoPath isolation
// =========================================================================
{
  cloud.reset();
  const devA = makeDeviceEnv('A', 'mac', '/Users/amy/Movies/LinguaClip');
  const devB = makeDeviceEnv('B', 'android', '/data/user/0/com.linguaclip.app/files/LinguaClip');

  let appliedCount = 0;
  let cardsSubCount = 0;
  const unsubApp = M.subscribeSyncApplied(() => { appliedCount++; });
  const unsubCards = M.subscribeCards(() => { cardsSubCount++; });

  // Desktop A creates video + 2 cards + stats + watchPos + cache
  activeDev = devA;
  await M.testAndEnableSync(DAV_CFG);
  await M.saveVideoToDB(makeVideoRec('v1', SRT_1, { videoPath: '/Users/amy/Movies/LinguaClip/v1.mp4' }));
  await M.addLine({ videoId: 'v1', videoName: 'v1.mp4', videoPath: '/Users/amy/Movies/LinguaClip/v1.mp4', text: 'Hello world.', start: 1, end: 3 }, 'saved');
  await M.addLine({ videoId: 'v1', videoName: 'v1.mp4', videoPath: '/Users/amy/Movies/LinguaClip/v1.mp4', text: 'Second line.', start: 4, end: 6 }, 'wrong');
  M.countLine();
  M.setWatchPos('v1', 12);
  devA.caches.set('v1.trans', '{"lines":["你好世界"]}');
  devA.caches.set('v1.words', '{"huge":true}'); // must NOT be uploaded

  const rA1 = await M.runWebDavSync(runOptsFor(devA, { manual: true }));
  assert.equal(rA1.status, 'ok');
  assert.equal(rA1.uploaded, true);
  assert.ok(cloud.files.has('caches/v1.trans.json.gz'), 'light cache uploaded');
  assert.ok(!cloud.files.has('caches/v1.words.json.gz'), 'words cache never uploaded');

  // Android B (empty) syncs down
  activeDev = devB;
  await M.testAndEnableSync(DAV_CFG);
  const watchUpdatedB = [];
  const rB1 = await M.runWebDavSync(runOptsFor(devB, {
    manual: true,
    onWatchPosUpdated: async ids => { watchUpdatedB.push(...ids); },
  }));
  assert.equal(rB1.status, 'ok');
  assert.equal(rB1.summary.addedVideos, 1);
  assert.equal(rB1.summary.addedCards, 2);
  assert.deepEqual(watchUpdatedB, ['v1']);
  assert.equal(devB.caches.get('v1.trans'), '{"lines":["你好世界"]}');
  const bV1 = await M.getVideoFromDB('v1');
  assert.equal(bV1.videoPath, undefined, 'Android never receives Mac local path');
  assert.equal(bV1.subtitleText, SRT_1);
  assert.equal(M.getWatchPos('v1'), 12);

  // Android B grades c1, deletes c2, marks c3 missed, bumps stats, adds podcast episode
  const bCards = await M.getAllCards();
  const c1 = bCards.find(c => c.id === M.lineCardId('v1', 1));
  const c2 = bCards.find(c => c.id === M.lineCardId('v1', 4));
  const gradeAt = Date.now() + 5000;
  await M.recordOutcome(c1, 3, gradeAt);
  await M.deleteCards([c2.id]);
  await M.addLine({ videoId: 'v1', videoName: 'v1.mp4', text: 'Missed line', start: 9, end: 11 }, 'missed');
  M.countLine();
  M.countLine();
  M.setWatchPos('v1', 42);
  await M.saveVideoToDB(makeVideoRec('p1', SRT_2, {
    videoPath: 'https://cdn.example/ep1.mp3',
    podcast: { show: 'Pod', feed: 'https://cdn.example/rss', guid: 'ep1', name: 'ep1', audio: 'https://cdn.example/ep1.mp3' },
  }));

  const rB2 = await M.runWebDavSync(runOptsFor(devB, { manual: true }));
  assert.equal(rB2.status, 'ok');

  // Desktop A syncs back
  activeDev = devA;
  const rA2 = await M.runWebDavSync(runOptsFor(devA, { manual: true }));
  assert.equal(rA2.status, 'ok');
  assert.equal(rA2.summary.addedVideos, 1);
  assert.equal(rA2.summary.removedCards, 1);
  assert.equal(rA2.summary.addedCards, 1);

  const aV1 = await M.getVideoFromDB('v1');
  const aP1 = await M.getVideoFromDB('p1');
  assert.equal(aV1.videoPath, '/Users/amy/Movies/LinguaClip/v1.mp4', 'Desktop keeps its own videoPath');
  assert.equal(aP1.videoPath, undefined, 'Desktop never accepts Android https:// videoPath');
  assert.equal(M.getWatchPos('v1'), 42);

  const aCards = (await M.getAllCards()).sort((x, y) => x.id.localeCompare(y.id));
  activeDev = devB;
  const bCardsAfter = (await M.getAllCards()).sort((x, y) => x.id.localeCompare(y.id));
  assert.deepEqual(aCards.map(c => c.id), bCardsAfter.map(c => c.id), 'both devices converge to identical card ids');
  assert.equal(aCards.find(c => c.id === c1.id).fsrs.reps, 1, 'FSRS grade converged');
  assert.ok(aCards.find(c => c.id === M.lineCardId('v1', 9)).reasons.includes('missed'), 'missed card synced');

  // Stats summed across both devices (1 line on A + 2 lines on B = 3 total)
  const bToday = M.getDays(1)[0];
  activeDev = devA;
  const aToday = M.getDays(1)[0];
  assert.equal(aToday.lines, 3);
  assert.equal(bToday.lines, 3);
  assert.ok(appliedCount >= 2 && cardsSubCount >= 2, 'live UI listeners notified without reload');

  unsubApp();
  unsubCards();
}

// =========================================================================
// Test 2: First-sync confirmation gate + savePreSnapshot failure abort + pre-before-apply
// =========================================================================
{
  cloud.reset();
  const devX = makeDeviceEnv('X', 'mac', '/Users/x/Movies/LinguaClip');
  const devY = makeDeviceEnv('Y', 'android', '/data/user/0/com.linguaclip.app/files/LinguaClip');

  activeDev = devY;
  await M.testAndEnableSync(DAV_CFG);
  await M.saveVideoToDB(makeVideoRec('vy', SRT_2));
  assert.equal((await M.runWebDavSync(runOptsFor(devY, { manual: true }))).status, 'ok');

  activeDev = devX;
  await M.testAndEnableSync(DAV_CFG);
  await M.saveVideoToDB(makeVideoRec('vx', SRT_1));

  // Unconfirmed first sync with two non-empty devices → pauses with needs_confirm
  const res1 = await M.runWebDavSync(runOptsFor(devX, { manual: true }));
  assert.equal(res1.status, 'needs_confirm');
  assert.equal(res1.alert.kind, 'firstSync');
  assert.equal(M.getSyncRuntimeStatus().pendingAlert?.kind, 'firstSync');
  assert.deepEqual((await M.getAllVideosFromDB()).map(v => v.id), ['vx'], 'DB untouched before confirm');

  // Confirmed, but savePreSnapshot fails → aborts without touching DB
  const resFail = await M.runWebDavSync(runOptsFor(devX, {
    manual: true,
    confirmSafety: true,
    savePreSnapshot: async () => { throw new Error('disk full'); },
  }));
  assert.equal(resFail.status, 'error');
  assert.equal(resFail.error, 'sync:pre_failed:disk full');
  assert.deepEqual((await M.getAllVideosFromDB()).map(v => v.id), ['vx'], 'DB untouched when pre snapshot fails');

  // Confirmed with working pre snapshot → pre runs first, then merge succeeds
  let preRanWhileOnlyVx = false;
  const resOk = await M.runWebDavSync(runOptsFor(devX, {
    manual: true,
    confirmSafety: true,
    savePreSnapshot: async () => {
      const vids = await M.getAllVideosFromDB();
      preRanWhileOnlyVx = vids.length === 1 && vids[0].id === 'vx';
      devX.preSnapshots++;
    },
  }));
  assert.equal(resOk.status, 'ok');
  assert.equal(preRanWhileOnlyVx, true, 'pre snapshot captured before DB mutation');
  assert.equal(devX.preSnapshots, 1);
  assert.deepEqual((await M.getAllVideosFromDB()).map(v => v.id).sort(), ['vx', 'vy']);
  assert.equal(M.getSyncRuntimeStatus().pendingAlert, null);
}

// =========================================================================
// Test 3: Mass deletion circuit breaker (>= 20 cards and > 20%)
// =========================================================================
{
  cloud.reset();
  const dev1 = makeDeviceEnv('D1', 'mac', '/Users/d1/Movies/LinguaClip');
  const dev2 = makeDeviceEnv('D2', 'android', '/data/user/0/com.linguaclip.app/files/LinguaClip');

  activeDev = dev1;
  await M.testAndEnableSync(DAV_CFG);
  await M.saveVideoToDB(makeVideoRec('vm', SRT_1));
  for (let i = 1; i <= 25; i++) {
    await M.addLine({ videoId: 'vm', videoName: 'vm.mp4', text: `Line ${i}`, start: i, end: i + 1 }, 'saved');
  }
  assert.equal((await M.runWebDavSync(runOptsFor(dev1, { manual: true }))).status, 'ok');

  // dev2 pulls all 25, then deletes 20 of them and pushes
  activeDev = dev2;
  await M.testAndEnableSync(DAV_CFG);
  assert.equal((await M.runWebDavSync(runOptsFor(dev2, { manual: true }))).status, 'ok');
  const all25 = await M.getAllCards();
  assert.equal(all25.length, 25);
  await M.deleteCards(all25.slice(0, 20).map(c => c.id));
  assert.equal((await M.runWebDavSync(runOptsFor(dev2, { manual: true }))).status, 'ok');

  // dev1 auto-syncs → massDeletion circuit breaker triggers, local 25 cards stay intact
  activeDev = dev1;
  const rMass = await M.runWebDavSync(runOptsFor(dev1, { manual: false }));
  assert.equal(rMass.status, 'needs_confirm');
  assert.equal(rMass.alert.kind, 'massDeletion');
  assert.equal(rMass.alert.dropCards, 20);
  assert.equal((await M.getAllCards()).length, 25, 'all 25 cards preserved until user confirms');
}

// =========================================================================
// Test 4: 401 authFailed circuit breaker (0 further requests) + 429 exponential backoff
// =========================================================================
{
  cloud.reset();
  const dev = makeDeviceEnv('AuthDev', 'mac', '/Users/a/Movies/LinguaClip');
  activeDev = dev;
  await M.testAndEnableSync(DAV_CFG);

  // Inject 401
  cloud.forceError = 'sync:auth';
  const r401 = await M.runWebDavSync(runOptsFor(dev, { manual: false }));
  assert.equal(r401.status, 'error');
  assert.equal(r401.error, 'sync:auth');
  assert.equal(M.getSyncState().authFailed, true);

  // Subsequent auto syncs must skip with ZERO network requests
  cloud.reqCount = 0;
  const rSkip = await M.runWebDavSync(runOptsFor(dev, { manual: false }));
  assert.deepEqual(rSkip, { status: 'skipped', reason: 'auth_failed' });
  assert.equal(cloud.reqCount, 0, 'zero requests after authFailed');

  // Reset authFailed and test 429 exponential backoff
  cloud.forceError = null;
  await M.testAndEnableSync(DAV_CFG);
  cloud.forceError = 'sync:ratelimit';

  let fakeNow = 1_000_000;
  const expectedBases = [60_000, 180_000, 600_000];
  for (let i = 0; i < expectedBases.length; i++) {
    const r = await M.runWebDavSync(runOptsFor(dev, { manual: false, now: () => fakeNow }));
    assert.equal(r.status, 'error');
    assert.equal(r.error, 'sync:ratelimit');
    const st = M.getSyncState();
    assert.equal(st.failCount, i + 1);
    const delay = st.backoffUntil - fakeNow;
    assert.ok(delay >= expectedBases[i] && delay <= Math.ceil(expectedBases[i] * 1.15) + 1,
      `step ${i + 1} backoff ${delay} within [base, 1.15*base]`);

    // During backoff window: skipped with zero requests
    cloud.reqCount = 0;
    const rBack = await M.runWebDavSync(runOptsFor(dev, { manual: false, now: () => fakeNow + 1000 }));
    assert.deepEqual(rBack, { status: 'skipped', reason: 'backoff' });
    assert.equal(cloud.reqCount, 0);

    fakeNow = st.backoffUntil + 1;
  }
  cloud.forceError = null;
}

// =========================================================================
// Test 5: Corrupt peer snapshot (`sync:corrupt:gzip` & truncated JSON) safely skipped
// =========================================================================
{
  cloud.reset();
  const devGood = makeDeviceEnv('Good', 'mac', '/Users/g/Movies/LinguaClip');
  const devLocal = makeDeviceEnv('Local', 'android', '/data/user/0/com.linguaclip.app/files/LinguaClip');

  activeDev = devGood;
  await M.testAndEnableSync(DAV_CFG);
  await M.saveVideoToDB(makeVideoRec('vgood', SRT_2));
  assert.equal((await M.runWebDavSync(runOptsFor(devGood, { manual: true }))).status, 'ok');

  // Inject corrupt peers alongside valid peer
  cloud.put('devices/corrupt-gz.json.gz', '__CORRUPT_GZIP__');
  cloud.put('devices/truncated-json.json.gz', '{"v":1,"devId":"broken');

  activeDev = devLocal;
  await M.testAndEnableSync(DAV_CFG);
  await M.saveVideoToDB(makeVideoRec('vlocal', SRT_1));
  const r = await M.runWebDavSync(runOptsFor(devLocal, { manual: true, confirmSafety: true }));
  assert.equal(r.status, 'ok', 'corrupt peers never break sync');
  assert.deepEqual((await M.getAllVideosFromDB()).map(v => v.id).sort(), ['vgood', 'vlocal'], 'local data intact and valid peer merged');
}

// =========================================================================
// Test 6: L2 clip-pack upload & on-demand download + zero-race extraKeptClipsProvider
// =========================================================================
{
  cloud.reset();
  const devA = makeDeviceEnv('ClipA', 'mac', '/Users/ca/Movies/LinguaClip');
  const devB = makeDeviceEnv('ClipB', 'android', '/data/user/0/com.linguaclip.app/files/LinguaClip');

  activeDev = devA;
  await M.testAndEnableSync(DAV_CFG);
  await M.saveVideoToDB(makeVideoRec('vc', SRT_1, { videoPath: '/Users/ca/Movies/LinguaClip/vc.mp4' }));
  await M.addLine({ videoId: 'vc', videoName: 'vc.mp4', text: 'Clip line', start: 1, end: 3 }, 'saved');
  const cid = M.lineCardId('vc', 1);
  await M.setClip([cid], { kind: 'audio', file: 'vc_1.00.m4a', from: 0 }, true);
  devA.clips.set('vc_1.00.m4a', 'AUDIO_BYTES_123');

  const rUp = await M.runWebDavSync(runOptsFor(devA, { manual: true }));
  assert.equal(rUp.status, 'ok');
  assert.equal(rUp.clipsUploaded, 1);
  const packRel = `clip-packs/${M.getSyncDeviceId()}-1.zip`;
  assert.ok(cloud.files.has(packRel), 'clip pack uploaded to WebDAV');

  // Device B downloads clip: inspect state MID-UNPACK via hook
  activeDev = devB;
  await M.testAndEnableSync(DAV_CFG);
  const extraKeptProvider = M.createSyncExtraKeptClipsProvider();
  let midProviderResult = 'not-called';
  let midPendingList = [];
  let midCardClip = 'unset';

  cloud.onDownloadClipPack = async () => {
    midProviderResult = await extraKeptProvider();
    midPendingList = await M.pendingClipsList();
    const cards = await M.getAllCards();
    midCardClip = cards.find(c => c.id === cid)?.clip;
  };

  const rDown = await M.runWebDavSync(runOptsFor(devB, {
    manual: true,
    clipsRuntime: { findVideo: async () => null },
  }));
  cloud.onDownloadClipPack = null;

  assert.equal(rDown.status, 'ok');
  assert.equal(rDown.clipsDownloaded, 1);
  assert.equal(midProviderResult, null, 'sweep paused (extraKeptProvider returns null) during unpacking');
  assert.deepEqual(midPendingList, ['vc_1.00.m4a'], 'clip guarded in sync_pending_clips before disk landing');
  assert.equal(midCardClip, undefined, 'card.clip not mounted until file is on disk');

  // After landing: clip mounted, pending cleared, provider returns empty array (not null)
  const afterCards = await M.getAllCards();
  assert.deepEqual(afterCards.find(c => c.id === cid)?.clip, { kind: 'audio', file: 'vc_1.00.m4a', from: 0 });
  assert.deepEqual(await M.pendingClipsList(), []);
  assert.deepEqual(await extraKeptProvider(), []);
  assert.equal(devB.clips.get('vc_1.00.m4a'), 'AUDIO_BYTES_123');

  // When source video exists locally, clip download is skipped (free local cut)
  const devC = makeDeviceEnv('ClipC', 'mac', '/Users/cc/Movies/LinguaClip');
  activeDev = devC;
  await M.testAndEnableSync(DAV_CFG);
  const rSkipClip = await M.runWebDavSync(runOptsFor(devC, {
    manual: true,
    clipsRuntime: { findVideo: async () => '/Users/cc/Movies/LinguaClip/vc.mp4' },
  }));
  assert.equal(rSkipClip.status, 'ok');
  assert.equal(rSkipClip.clipsDownloaded, 0, 'skips downloading clip when local source video exists');
}

// =========================================================================
// Test 7: Offline sync packs (.json PWA & .zip Desktop/Android) export → preview → merge
// =========================================================================
{
  cloud.reset();
  // 7a. PWA .json path
  const pwaA = makeDeviceEnv('PwaA', 'pwa', '');
  const pwaB = makeDeviceEnv('PwaB', 'pwa', '');

  activeDev = pwaA;
  await M.saveVideoToDB(makeVideoRec('vpwa1', SRT_1));
  await M.addLine({ videoId: 'vpwa1', videoName: 'vpwa1.mp4', text: 'PWA line', start: 1, end: 3 }, 'saved');
  const expJson = await M.exportOfflineSyncPack({ platform: 'pwa', ownDir: '' });
  assert.ok(expJson && typeof expJson.json === 'string');
  assert.equal(expJson.videos, 1);
  assert.equal(expJson.cards, 1);

  activeDev = pwaB;
  await M.saveVideoToDB(makeVideoRec('vpwa2', SRT_2));
  const prevJson = await M.previewOfflineSyncPack(
    { kind: 'json', text: expJson.json },
    runOptsFor(pwaB),
  );
  assert.equal(prevJson.summary.addedVideos, 1);
  assert.equal(prevJson.summary.addedCards, 1);
  assert.deepEqual((await M.getAllVideosFromDB()).map(v => v.id), ['vpwa2'], 'preview does not mutate DB');

  const appliedJson = await prevJson.apply();
  assert.equal(appliedJson.summary.addedVideos, 1);
  assert.equal(pwaB.preSnapshots, 1, 'offline merge saves pre snapshot before applying');
  assert.deepEqual((await M.getAllVideosFromDB()).map(v => v.id).sort(), ['vpwa1', 'vpwa2'], 'lossless merge preserves local video');
  assert.equal((await M.getAllCards()).length, 1);

  // 7b. Desktop/Android .zip path (with clip unpacking + cleanup)
  const zipSrc = makeDeviceEnv('ZipSrc', 'mac', '/Users/zs/Movies/LinguaClip');
  const zipDst = makeDeviceEnv('ZipDst', 'android', '/data/user/0/com.linguaclip.app/files/LinguaClip');

  activeDev = zipSrc;
  await M.saveVideoToDB(makeVideoRec('vzip', SRT_1));
  await M.addLine({ videoId: 'vzip', videoName: 'vzip.mp4', text: 'Zip clip line', start: 1, end: 3 }, 'saved');
  const zcid = M.lineCardId('vzip', 1);
  await M.setClip([zcid], { kind: 'audio', file: 'vzip_1.00.m4a', from: 0 }, true);
  zipSrc.clips.set('vzip_1.00.m4a', 'ZIP_CLIP_DATA');

  const expZip = await M.exportOfflineSyncPack({ platform: 'mac', ownDir: zipSrc.ownDir, dest: '/tmp/test-sync.zip' });
  assert.equal(expZip.path, '/tmp/test-sync.zip');

  activeDev = zipDst;
  let cleanedUp = false;
  const prevZip = await M.previewOfflineSyncPack(
    { kind: 'zip', path: expZip.path, cleanup: async () => { cleanedUp = true; } },
    runOptsFor(zipDst, { clipsRuntime: { findVideo: async () => null } }),
  );
  assert.equal(prevZip.summary.addedVideos, 1);
  assert.equal(prevZip.summary.addedCards, 1);

  const appliedZip = await prevZip.apply();
  assert.equal(appliedZip.clipsUnpacked, 1);
  assert.equal(cleanedUp, true, 'temporary zip cleaned up after apply');
  assert.equal(zipDst.preSnapshots, 1);
  assert.equal(zipDst.clips.get('vzip_1.00.m4a'), 'ZIP_CLIP_DATA');
  assert.deepEqual((await M.getAllCards()).find(c => c.id === zcid)?.clip, { kind: 'audio', file: 'vzip_1.00.m4a', from: 0 });
  assert.deepEqual(await M.pendingClipsList(), []);

  // 7c. Desktop -> iPhone PWA .json bidirectional export (Astra P1 #7 / Opus P2 #10)
  activeDev = zipSrc;
  const expDesktopJson = await M.exportOfflineSyncPack({ platform: 'mac', ownDir: zipSrc.ownDir, format: 'json', dest: '/tmp/for-iphone.json' });
  assert.equal(expDesktopJson.path, '/tmp/for-iphone.json');
  assert.ok(cloud.jsonPacks.get('/tmp/for-iphone.json'));
  const iphonePwa = makeDeviceEnv('iPhonePWA', 'pwa', '');
  activeDev = iphonePwa;
  const prevIphone = await M.previewOfflineSyncPack({ kind: 'json', text: cloud.jsonPacks.get('/tmp/for-iphone.json') }, runOptsFor(iphonePwa));
  assert.equal(prevIphone.summary.addedVideos, 1);
  await prevIphone.apply();
  assert.deepEqual((await M.getAllVideosFromDB()).map(v => v.id), ['vzip']);
}

// =========================================================================
// Test 8: Target switch resets sync state & re-uploads subs + keeps firstSync guard (Astra P0 #1)
// =========================================================================
{
  cloud.reset();
  const dev = makeDeviceEnv('SwitchDev', 'mac', '/Users/s/Movies/LinguaClip');
  activeDev = dev;
  await M.saveVideoToDB(makeVideoRec('vsw', SRT_1));
  await M.testAndEnableSync({ ...DAV_CFG, rootDir: 'FolderA' });
  const r1 = await M.runWebDavSync(runOptsFor(dev, { manual: true }));
  assert.equal(r1.status, 'ok');
  const subHash = M.srtHash(SRT_1);
  assert.ok(cloud.files.has(`subs/${subHash}.srt.gz`), 'subtitle uploaded to FolderA');

  // Switch to an empty new folder FolderB
  cloud.reset();
  await M.testAndEnableSync({ ...DAV_CFG, rootDir: 'FolderB' });
  assert.equal(M.getSyncState().initialized, false, 'target switch resets initialized');
  assert.deepEqual(M.getSyncState().uploadedSubs, [], 'target switch clears uploadedSubs');
  const r2 = await M.runWebDavSync(runOptsFor(dev, { manual: true }));
  assert.equal(r2.status, 'ok');
  assert.ok(cloud.files.has(`subs/${subHash}.srt.gz`), 'subtitle MUST be uploaded to new target FolderB');
}

// =========================================================================
// Test 9: Atomic podcast rekey (missing winner sub never deletes local) + Android media path update
// =========================================================================
{
  cloud.reset();
  const feed = 'https://example.com/pod.xml', guid = 'ep-rekey-1';
  const winnerId = M.episodeUuid(feed, guid);
  const loserId = '11111111-1111-4111-8111-111111111111';

  const androidDev = makeDeviceEnv('AndRekey', 'android', '/data/user/0/com.linguaclip.app/files/LinguaClip');
  const oldMediaPath = `${androidDev.ownDir}/media/${loserId}.mp3`;
  androidDev.media.set(oldMediaPath, 'MP3_BYTES');
  activeDev = androidDev;
  await M.saveVideoToDB(makeVideoRec(loserId, SRT_1, {
    videoPath: oldMediaPath,
    podcast: { show: 'S', feed, guid, name: 'ep', audio: 'https://cdn.example.com/ep.mp3' },
  }));
  await M.addLine({ videoId: loserId, videoName: 'ep.mp3', videoPath: oldMediaPath, text: 'Hello world', start: 0, end: 2 }, 'saved');

  // Remote peer holds winnerId with SRT_2, but subs/<SRT_2> is MISSING (404) on WebDAV
  const peerSnap = {
    v: 1, devId: 'peer-desktop-1', platform: 'mac', ownDir: '/Users/p/Movies/LinguaClip',
    exportedAt: Date.now(), lastMergedAt: Date.now(),
    videos: [{
      id: winnerId, displayName: 'ep', videoFileName: 'ep.mp3', subtitleFileName: 'ep.srt',
      srtHash: M.srtHash(SRT_2), bornAt: Date.now() - 10_000, currentSubtitleIndex: 0, currentSectionIndex: 0,
      totalSubtitles: 1, completionRate: 0, dateAdded: Date.now() - 10_000, lastPracticed: Date.now(), totalPracticeTime: 0,
      podcast: { show: 'S', feed, guid, name: 'ep', audio: 'https://cdn.example.com/ep.mp3' },
    }],
    cards: [], cardMeta: {}, tombstones: { videos: {}, cards: {} }, daysDev: {},
    positions: { watch: {}, custom: {}, read: {}, lastWay: {} }, posAt: {},
  };
  cloud.put('devices/peer-desktop-1.json.gz', JSON.stringify(peerSnap));

  await M.testAndEnableSync(DAV_CFG);
  const rMissing = await M.runWebDavSync(runOptsFor(androidDev, { manual: true, confirmSafety: true }));
  assert.equal(rMissing.status, 'ok');
  const vidsAfterMissing = await M.getAllVideosFromDB();
  assert.deepEqual(vidsAfterMissing.map(v => v.id), [loserId], 'missing winner sub MUST NOT delete local readable record');
  assert.ok(androidDev.media.has(oldMediaPath), 'media file untouched while winner sub missing');

  // Now winner subtitle arrives on WebDAV -> rekey succeeds AND videoPath updates to new media path!
  cloud.put(`subs/${M.srtHash(SRT_2)}.srt.gz`, SRT_2);
  const rOk = await M.runWebDavSync(runOptsFor(androidDev, { manual: true }));
  assert.equal(rOk.status, 'ok');
  const vidsAfterOk = await M.getAllVideosFromDB();
  assert.deepEqual(vidsAfterOk.map(v => v.id), [winnerId], 'rekeyed to canonical winnerId');
  const newMediaPath = `${androidDev.ownDir}/media/${winnerId}.mp3`;
  assert.equal(vidsAfterOk[0].videoPath, newMediaPath, 'Android record videoPath updated to renamed media file');
  const cardsAfterOk = await M.getAllCards();
  assert.equal(cardsAfterOk[0].videoId, winnerId);
  assert.equal(cardsAfterOk[0].videoPath, newMediaPath, 'Android card videoPath updated to renamed media file');
}

// =========================================================================
// Test 10: Concurrent local saves during offline preview & mid-upload dirty tracking + settings preservation
// =========================================================================
{
  cloud.reset();
  const desk = makeDeviceEnv('DeskLive', 'mac', '/Users/d/Movies/LinguaClip');
  const phone = makeDeviceEnv('PhoneLive', 'android', '/data/user/0/com.linguaclip.app/files/LinguaClip');

  // 10a. Offline preview -> user advances watch_pos 12 -> 48 before clicking Confirm -> 48 MUST survive!
  activeDev = desk;
  await M.saveVideoToDB(makeVideoRec('vpos', SRT_1));
  M.setWatchPos('vpos', 12);
  const packFromPhone = (() => {
    const snap = {
      v: 1, devId: 'phone-x', platform: 'android', ownDir: phone.ownDir,
      exportedAt: Date.now() - 5000, lastMergedAt: Date.now() - 5000,
      videos: [], cards: [], cardMeta: {}, tombstones: { videos: {}, cards: {} }, daysDev: {},
      positions: { watch: { vpos: 10 }, custom: {}, read: {}, lastWay: {} },
      posAt: { vpos: { watch: Date.now() - 5000, watchBy: 'phone-x' } },
    };
    return JSON.stringify({ format: 'linguaclip-sync-pack', v: 1, snapshot: snap, subs: {} });
  })();
  const prev = await M.previewOfflineSyncPack({ kind: 'json', text: packFromPhone }, runOptsFor(desk));
  M.setWatchPos('vpos', 48); // user watches further while preview dialog is open
  await prev.apply();
  assert.equal(M.getWatchPos('vpos'), 48, 'concurrent watch_pos save during preview must NOT revert to 12');

  // 10b. Adding new video & updating watchPrefs marks dirty and uploads on sync; mid-upload edit retains dirty!
  await M.testAndEnableSync(DAV_CFG);
  await M.runWebDavSync(runOptsFor(desk, { manual: true }));
  await M.saveVideoToDB(makeVideoRec('vnew2', SRT_2));
  M.saveWatchPrefs({ autoPause: true });
  assert.equal(M.getSyncState().dirty, true, 'saveVideoToDB + saveWatchPrefs set dirty=true');

  let injectedMidUpload = false;
  cloud.onPutGz = async relPath => {
    if (relPath.startsWith('devices/') && !injectedMidUpload) {
      injectedMidUpload = true;
      await M.addLine({ videoId: 'vnew2', videoName: 'vnew2.mp4', text: 'Mid upload', start: 0, end: 2 }, 'saved');
    }
  };
  const rPush = await M.runWebDavSync(runOptsFor(desk, { manual: true }));
  assert.equal(rPush.status, 'ok');
  assert.equal(rPush.uploaded, true, 'local-only video & watchPrefs uploaded');
  assert.equal(M.getSyncState().dirty, true, 'edit landed during upload MUST retain dirty=true');
  cloud.onPutGz = null;

  // 10c. Desktop-only saveClips preserved when newly paired phone syncs settings (Opus P1 #3)
  M.savePracticeConfig({ sectionLength: 4, clozeLevel: 'medium', saveClips: true, clipKind: 'audio', videoShare: 55 });
  await M.runWebDavSync(runOptsFor(desk, { manual: true }));

  activeDev = phone;
  // Untouched default practice_config on newly paired phone (never explicitly edited -> at: 0)
  localStorage.setItem('linguaclip_practice_config', JSON.stringify({ sectionLength: 4, clozeLevel: 'full', saveClips: false }));
  await M.testAndEnableSync(DAV_CFG);
  const rPhoneJoin = await M.runWebDavSync(runOptsFor(phone, { manual: true, confirmSafety: true }));
  assert.equal(rPhoneJoin.status, 'ok');
  assert.equal(M.getPracticeConfig().clozeLevel, 'medium', 'existing desktop setting beats untouched phone default');

  // Now phone explicitly changes clozeLevel -> easy; desktop MUST receive 'easy' while keeping saveClips:true & videoShare:55!
  M.savePracticeConfig({ ...M.getPracticeConfig(), clozeLevel: 'easy' });
  await M.runWebDavSync(runOptsFor(phone, { manual: true }));

  activeDev = desk;
  await M.runWebDavSync(runOptsFor(desk, { manual: true }));
  const deskCfg = M.getPracticeConfig();
  assert.equal(deskCfg.clozeLevel, 'easy', 'phone explicit cross-device setting synced to desktop');
  assert.equal(deskCfg.saveClips, true, 'desktop-only saveClips MUST NOT be clobbered by phone');
  assert.equal(deskCfg.clipKind, 'audio', 'desktop-only clipKind preserved');
  assert.equal(deskCfg.videoShare, 55, 'desktop-only videoShare preserved');

  // 10d. Corrupt peer on first sync does NOT strip firstSync confirmation when peer recovers (Astra P1 #6)
  cloud.reset();
  cloud.put('devices/peer-bad.json.gz', '__CORRUPT_GZIP__');
  const freshDev = makeDeviceEnv('FreshGuard', 'mac', '/Users/f/Movies/LinguaClip');
  activeDev = freshDev;
  await M.saveVideoToDB(makeVideoRec('vlocal', SRT_1));
  await M.testAndEnableSync(DAV_CFG);
  const rCorrupt = await M.runWebDavSync(runOptsFor(freshDev, { manual: true }));
  assert.equal(rCorrupt.status, 'ok');
  assert.equal(M.getSyncState().initialized, false, 'corrupt-only peer must NOT mark initialized=true');

  // Peer recovers with valid snapshot -> firstSync confirmation MUST trigger!
  cloud.put('devices/peer-bad.json.gz', JSON.stringify({
    v: 1, devId: 'peer-bad', platform: 'android', ownDir: '', exportedAt: Date.now(), lastMergedAt: Date.now(),
    videos: [], cards: [], cardMeta: {}, tombstones: { videos: {}, cards: {} }, daysDev: {},
    positions: { watch: {}, custom: {}, read: {}, lastWay: {} }, posAt: {},
  }));
  const rRecover = await M.runWebDavSync(runOptsFor(freshDev, { manual: true }));
  assert.equal(rRecover.status, 'needs_confirm', 'recovered peer still triggers firstSync confirmation');
  assert.equal(rRecover.alert.firstSync, true);

  // 10e. Newer-format-only peer (v: 2) also keeps initialized=false + offline merge marks dirty + mid-sync new video uploads sub
  cloud.reset();
  cloud.put('devices/peer-v2.json.gz', JSON.stringify({
    v: 2, devId: 'peer-v2', platform: 'android', ownDir: '', exportedAt: Date.now(), lastMergedAt: Date.now(),
    videos: [], cards: [], cardMeta: {}, tombstones: { videos: {}, cards: {} }, daysDev: {},
    positions: { watch: {}, custom: {}, read: {}, lastWay: {} }, posAt: {},
  }));
  const v2Dev = makeDeviceEnv('V2Guard', 'mac', '/Users/v2/Movies/LinguaClip');
  activeDev = v2Dev;
  await M.saveVideoToDB(makeVideoRec('vloc2', SRT_1));
  await M.testAndEnableSync(DAV_CFG);
  await M.runWebDavSync(runOptsFor(v2Dev, { manual: true }));
  assert.equal(M.getSyncState().initialized, false, 'v>1 incompatible peer must NOT set initialized=true');

  // Offline merge marks dirty so next background WebDAV sync uploads merged items
  cloud.reset();
  const cleanDev = makeDeviceEnv('OfflineDirty', 'mac', '/Users/od/Movies/LinguaClip');
  activeDev = cleanDev;
  await M.testAndEnableSync(DAV_CFG);
  await M.runWebDavSync(runOptsFor(cleanDev, { manual: true }));
  assert.equal(M.getSyncState().dirty, false);
  const offSnap = {
    v: 1, devId: 'peer-off', platform: 'pwa', ownDir: '', exportedAt: Date.now(), lastMergedAt: Date.now(),
    videos: [{
      id: 'voff', displayName: 'voff', videoFileName: 'voff.mp3', subtitleFileName: 'voff.srt',
      srtHash: M.srtHash(SRT_2), bornAt: Date.now(), currentSubtitleIndex: 0, currentSectionIndex: 0,
      totalSubtitles: 1, completionRate: 0, dateAdded: Date.now(), lastPracticed: Date.now(), totalPracticeTime: 0,
    }],
    cards: [], cardMeta: {}, tombstones: { videos: {}, cards: {} }, daysDev: {},
    positions: { watch: {}, custom: {}, read: {}, lastWay: {} }, posAt: {},
  };
  const prevOff = await M.previewOfflineSyncPack(
    { kind: 'json', text: JSON.stringify({ format: 'linguaclip-sync-pack', v: 1, snapshot: offSnap, subs: { [M.srtHash(SRT_2)]: SRT_2 } }) },
    runOptsFor(cleanDev),
  );
  await prevOff.apply();
  assert.equal(M.getSyncState().dirty, true, 'offline merge marks dirty for subsequent WebDAV push');

  // Failed-import placeholder with winnerId must NOT cause rekey to delete readable local loserId
  const phFeed = 'https://example.com/ph.xml', phGuid = 'ep-ph';
  const phWin = M.episodeUuid(phFeed, phGuid);
  const phLose = '22222222-2222-4222-8222-222222222222';
  const phDev = makeDeviceEnv('PhDev', 'mac', '/Users/ph/Movies/LinguaClip');
  activeDev = phDev;
  await M.saveVideoToDB(makeVideoRec(phLose, SRT_1, { podcast: { show: 'P', feed: phFeed, guid: phGuid, name: 'ep' } }));
  await M.saveVideoToDB({ ...makeVideoRec(phWin, ''), importJob: { stage: 'download', error: 'net', source: 'x' } });
  cloud.reset();
  cloud.put('devices/peer-ph.json.gz', JSON.stringify({
    v: 1, devId: 'peer-ph', platform: 'android', ownDir: '', exportedAt: Date.now(), lastMergedAt: Date.now(),
    videos: [{
      id: phWin, displayName: 'ep', videoFileName: 'ep.mp3', subtitleFileName: 'ep.srt',
      srtHash: M.srtHash(SRT_2), bornAt: Date.now() - 5000, currentSubtitleIndex: 0, currentSectionIndex: 0,
      totalSubtitles: 1, completionRate: 0, dateAdded: Date.now() - 5000, lastPracticed: Date.now(), totalPracticeTime: 0,
      podcast: { show: 'P', feed: phFeed, guid: phGuid, name: 'ep' },
    }],
    cards: [], cardMeta: {}, tombstones: { videos: {}, cards: {} }, daysDev: {},
    positions: { watch: {}, custom: {}, read: {}, lastWay: {} }, posAt: {},
  }));
  await M.testAndEnableSync(DAV_CFG);
  await M.runWebDavSync(runOptsFor(phDev, { manual: true, confirmSafety: true }));
  assert.ok((await M.getAllVideosFromDB()).some(v => v.id === phLose), 'importJob placeholder must NOT allow rekey deletion when winner sub is missing');
}

// =========================================================================
// Test 11 (Scenario A): Desktop manual send + Android Wi-Fi auto-download + delete-on-delivery
// =========================================================================
{
  cloud.reset();
  const desk = makeDeviceEnv('AudioDeskA', 'mac', '/Users/a/Movies/LinguaClip');
  const phone = makeDeviceEnv('AudioPhoneA', 'android', '/data/user/0/com.linguaclip.app/files/LinguaClip');
  const deskSrc = '/Users/a/Movies/LinguaClip/va1.mp4';
  desk.media.set(deskSrc, 'DESKTOP_AUDIO_PAYLOAD_VA1');

  activeDev = desk;
  await M.testAndEnableSync({ ...DAV_CFG, autoSyncAudio: false, wifiOnlyAudio: true });
  await M.saveVideoToDB(makeVideoRec('va1', SRT_1, { videoPath: deskSrc }));
  const sendRes = await M.sendVideoAudioToPhone('va1');
  assert.equal(sendRes.ok, true, 'manual send succeeds');
  const offerRel = `audio/${sendRes.offer.file}`;
  assert.ok(cloud.files.has(offerRel), 'audio uploaded to WebDAV audio/');
  assert.equal(M.getDesktopVideoAudioState('va1').status, 'pending');

  // Desktop pushes snapshot carrying audioOffers
  const rDesk1 = await M.runWebDavSync(runOptsFor(desk, { manual: true }));
  assert.equal(rDesk1.status, 'ok');
  assert.equal(rDesk1.uploaded, true);

  // Android syncs on Wi-Fi -> auto-downloads audio, patches videoPath, publishes audioHave
  activeDev = phone;
  cloud.wifiOk = true;
  await M.testAndEnableSync({ ...DAV_CFG, wifiOnlyAudio: true });
  const rPhone1 = await M.runWebDavSync(runOptsFor(phone, { manual: true, pathExists: async p => phone.media.has(p) }));
  assert.equal(rPhone1.status, 'ok');
  const expectedPhonePath = `${phone.ownDir}/media/va1.m4a`;
  const phoneRec = await M.getVideoFromDB('va1');
  assert.equal(phoneRec.videoPath, expectedPhonePath, 'Android videoPath patched after Wi-Fi auto-download');
  assert.equal(phone.media.get(expectedPhonePath), 'DESKTOP_AUDIO_PAYLOAD_VA1', 'audio bytes landed on Android disk');
  assert.equal(M.getRemoteAudioOffer('va1'), null, 'remoteAudioOffers cleared after download');

  // Desktop syncs again -> sees Android audioHave -> deletes cloud audio/ file, clears offer, marks delivered
  activeDev = desk;
  const rDesk2 = await M.runWebDavSync(runOptsFor(desk, { manual: true }));
  assert.equal(rDesk2.status, 'ok');
  assert.equal(cloud.files.has(offerRel), false, 'cloud audio/ file deleted on delivery');
  assert.equal(M.getSyncState().audioOffers.va1, undefined, 'desktop audioOffers cleared');
  assert.ok(M.getSyncState().deliveredAudioIds.includes('va1'), 'deliveredAudioIds contains va1');
  assert.equal(M.getDesktopVideoAudioState('va1').status, 'delivered');
}

// =========================================================================
// Test 12 (Scenario B): Android cellular skips auto-download + manual downloadRemoteAudioNow
// =========================================================================
{
  cloud.reset();
  const desk = makeDeviceEnv('AudioDeskB', 'mac', '/Users/b/Movies/LinguaClip');
  const phone = makeDeviceEnv('AudioPhoneB', 'android', '/data/user/0/com.linguaclip.app/files/LinguaClip');
  const deskSrc = '/Users/b/Movies/LinguaClip/vb1.mp4';
  desk.media.set(deskSrc, 'DESKTOP_AUDIO_PAYLOAD_VB1');

  activeDev = desk;
  await M.testAndEnableSync({ ...DAV_CFG, autoSyncAudio: false, wifiOnlyAudio: true });
  await M.saveVideoToDB(makeVideoRec('vb1', SRT_1, { videoPath: deskSrc }));
  const sendRes = await M.sendVideoAudioToPhone('vb1');
  assert.equal(sendRes.ok, true);
  assert.equal((await M.runWebDavSync(runOptsFor(desk, { manual: true }))).status, 'ok');

  // Android on cellular with wifiOnlyAudio: true -> does NOT auto-download, keeps remoteAudioOffers
  activeDev = phone;
  cloud.wifiOk = false;
  await M.testAndEnableSync({ ...DAV_CFG, wifiOnlyAudio: true });
  const rCell = await M.runWebDavSync(runOptsFor(phone, { manual: true, pathExists: async p => phone.media.has(p) }));
  assert.equal(rCell.status, 'ok');
  assert.equal((await M.getVideoFromDB('vb1')).videoPath, undefined, 'cellular skips auto-download');
  assert.equal(phone.media.size, 0, 'no audio file downloaded on cellular');
  const keptOffer = M.getRemoteAudioOffer('vb1');
  assert.ok(keptOffer && keptOffer.file === sendRes.offer.file, 'remoteAudioOffers preserves offer for manual download');

  // User manually triggers downloadRemoteAudioNow on cellular -> succeeds, patches videoPath, clears offer
  const savedPath = await M.downloadRemoteAudioNow('vb1');
  assert.equal(savedPath, `${phone.ownDir}/media/vb1.m4a`);
  assert.equal((await M.getVideoFromDB('vb1')).videoPath, savedPath);
  assert.equal(phone.media.get(savedPath), 'DESKTOP_AUDIO_PAYLOAD_VB1');
  assert.equal(M.getRemoteAudioOffer('vb1'), null, 'remoteAudioOffers cleared after manual download');
  assert.equal(M.getSyncState().dirty, true, 'manual download marks dirty to notify desktop');
}

// =========================================================================
// Test 13 (Scenario C): Auto-sync switch + 600 MB monthly budget guard + offline audioAutoPending retry
// =========================================================================
{
  cloud.reset();
  const MB = 1024 * 1024;
  const desk = makeDeviceEnv('AudioDeskC', 'mac', '/Users/c/Movies/LinguaClip');
  activeDev = desk;
  await M.testAndEnableSync({ ...DAV_CFG, autoSyncAudio: true, wifiOnlyAudio: true });
  assert.equal((await M.runWebDavSync(runOptsFor(desk, { manual: true }))).status, 'ok');

  // 1. Auto-upload vc1 (60 MB, within 100 MB single-file cap) via maybeQueueAutoAudioSync
  const vc1 = makeVideoRec('vc1', SRT_1, { videoPath: '/Users/c/Movies/LinguaClip/vc1.mp4' });
  await M.saveVideoToDB(vc1);
  cloud.nextAudioBytes = 60 * MB;
  M.maybeQueueAutoAudioSync(vc1);
  const rAuto1 = await M.sendVideoAudioToPhone('vc1', { auto: true });
  assert.equal(rAuto1.ok, true, 'auto upload vc1 succeeds');
  assert.ok(cloud.files.has(`audio/${rAuto1.offer.file}`));
  assert.equal(M.getMonthlyAudioUsage().bytes, 60 * MB);
  assert.deepEqual(M.getSyncState().audioAutoPending, [], 'vc1 removed from audioAutoPending after upload');

  // 2. Offline failure for vc2 (80 MB, with 520 MB already used this month) persists in audioAutoPending and auto-retries on next sync
  M.saveSyncState({ ...M.getSyncState(), audioMonthly: { ym: M.currentYearMonth(), bytes: 520 * MB } });
  const vc2 = makeVideoRec('vc2', SRT_2, { videoPath: '/Users/c/Movies/LinguaClip/vc2.mp4' });
  await M.saveVideoToDB(vc2);
  cloud.nextAudioBytes = 80 * MB;
  cloud.forceError = 'sync:network:offline';
  M.maybeQueueAutoAudioSync(vc2);
  const rOffline = await M.sendVideoAudioToPhone('vc2', { auto: true });
  assert.equal(rOffline.ok, false);
  assert.equal(rOffline.reason, 'sync:network:offline');
  assert.deepEqual(M.getSyncState().audioAutoPending, ['vc2'], 'offline failure kept in audioAutoPending');

  // Network recovers -> non-manual sync picks up audioAutoPending and uploads vc2
  cloud.forceError = null;
  const rRetry = await M.runWebDavSync(runOptsFor(desk, { manual: false }));
  assert.equal(rRetry.status, 'ok');
  assert.ok(M.getSyncState().audioOffers.vc2, 'vc2 auto-uploaded on next sync');
  assert.deepEqual(M.getSyncState().audioAutoPending, [], 'audioAutoPending cleared after retry');
  assert.equal(M.getMonthlyAudioUsage().bytes, 600 * MB);
  assert.equal(M.getMonthlyAudioUsage().exceeded, true, '600 MB monthly budget reached');

  // 3. Budget hit: auto-sync pauses and sets budgetNotice=true, while manual send still works
  const vc3 = makeVideoRec('vc3', SRT_1, { videoPath: '/Users/c/Movies/LinguaClip/vc3.mp4' });
  await M.saveVideoToDB(vc3);
  cloud.nextAudioBytes = 10 * MB;
  M.maybeQueueAutoAudioSync(vc3);
  assert.equal(M.getSyncAudioSnapshot().budgetNotice, true, 'budgetNotice raised at 600 MB limit');
  assert.equal(M.getSyncState().audioOffers.vc3, undefined, 'auto upload paused over budget');
  assert.deepEqual(M.getSyncState().audioAutoPending, [], 'vc3 not queued when over budget');
  const rAutoBlocked = await M.sendVideoAudioToPhone('vc3', { auto: true });
  assert.deepEqual(rAutoBlocked, { ok: false, reason: 'budget' });

  const rManualOverride = await M.sendVideoAudioToPhone('vc3');
  assert.equal(rManualOverride.ok, true, 'manual send still allowed after monthly auto budget hit');
  assert.ok(cloud.files.has(`audio/${rManualOverride.offer.file}`));
  assert.ok(M.getSyncState().audioOffers.vc3);
  assert.equal(M.getMonthlyAudioUsage().bytes, 600 * MB, 'manual send MUST NOT consume monthly auto budget');
}

// =========================================================================
// Test 14: Regression suite for R2 protocol & concurrency race fixes
// =========================================================================
{
  const MB = 1024 * 1024;
  const DAY = 86_400_000;

  // 14a. Concurrent manual send during background unchanged sync must NOT be overwritten by stale state
  {
    cloud.reset();
    const desk = makeDeviceEnv('RaceDesk', 'mac', '/Users/r/Movies/LinguaClip');
    const src = '/Users/r/Movies/LinguaClip/vrace.mp4';
    desk.media.set(src, 'RACE_AUDIO');
    activeDev = desk;
    await M.testAndEnableSync({ ...DAV_CFG, autoSyncAudio: false });
    await M.saveVideoToDB(makeVideoRec('vrace', SRT_1, { videoPath: src }));
    assert.equal((await M.runWebDavSync(runOptsFor(desk, { manual: true }))).status, 'ok');
    assert.equal(M.getSyncState().dirty, false);

    let fired = false;
    cloud.onList = async subpath => {
      if (subpath === 'devices' && !fired) {
        fired = true;
        const r = await M.sendVideoAudioToPhone('vrace');
        assert.equal(r.ok, true);
      }
    };
    const rBg = await M.runWebDavSync(runOptsFor(desk, { manual: false }));
    cloud.onList = null;
    assert.equal(rBg.status, 'ok');
    assert.ok(M.getSyncState().audioOffers.vrace, 'concurrent manual offer preserved (never overwritten by unchanged fast-path)');
  }

  // 14b. Phone clears local audio -> Desktop re-sends (new offerId) -> Desktop sync does NOT delete -> Phone re-downloads & acks -> Desktop deletes
  {
    cloud.reset();
    const desk = makeDeviceEnv('ResendDesk', 'mac', '/Users/rs/Movies/LinguaClip');
    const phone = makeDeviceEnv('ResendPhone', 'android', '/data/user/0/com.linguaclip.app/files/LinguaClip');
    const src = '/Users/rs/Movies/LinguaClip/vrs1.mp4';
    desk.media.set(src, 'PAYLOAD_VRS1');

    activeDev = desk;
    await M.testAndEnableSync({ ...DAV_CFG, autoSyncAudio: false, wifiOnlyAudio: true });
    await M.saveVideoToDB(makeVideoRec('vrs1', SRT_1, { videoPath: src }));
    const s1 = await M.sendVideoAudioToPhone('vrs1');
    assert.equal(s1.ok, true);
    assert.ok(s1.offer.offerId);
    assert.equal((await M.runWebDavSync(runOptsFor(desk, { manual: true }))).status, 'ok');

    // Phone downloads vrs1 (offer 1) and acks offerId 1
    activeDev = phone;
    cloud.wifiOk = true;
    await M.testAndEnableSync({ ...DAV_CFG, wifiOnlyAudio: true });
    assert.equal((await M.runWebDavSync(runOptsFor(phone, { manual: true, pathExists: async p => phone.media.has(p) }))).status, 'ok');
    const phonePath = `${phone.ownDir}/media/vrs1.m4a`;
    assert.equal((await M.getVideoFromDB('vrs1')).videoPath, phonePath);
    assert.equal(M.getSyncState().audioAck.vrs1, s1.offer.offerId);

    // Desktop syncs -> deletes offer 1
    activeDev = desk;
    assert.equal((await M.runWebDavSync(runOptsFor(desk, { manual: true }))).status, 'ok');
    assert.equal(cloud.files.has(`audio/${s1.offer.file}`), false, 'offer 1 deleted after ack');

    // Phone clears local audio file on disk (stale videoPath still remains in IDB!)
    phone.media.delete(phonePath);

    // Desktop re-sends vrs1 (offer 2 with brand-new offerId) and syncs BEFORE phone syncs
    const s2 = await M.sendVideoAudioToPhone('vrs1');
    assert.equal(s2.ok, true);
    assert.notEqual(s2.offer.offerId, s1.offer.offerId, 'new send generates distinct offerId');
    assert.notEqual(s2.offer.file, s1.offer.file, 'distinct filename avoids same-name race');
    assert.equal((await M.runWebDavSync(runOptsFor(desk, { manual: true }))).status, 'ok');
    assert.ok(cloud.files.has(`audio/${s2.offer.file}`), 'first desktop sync MUST NOT delete re-sent offer based on old phone snapshot');
    assert.ok(M.getSyncState().audioOffers.vrs1, 'desktop keeps offer 2 pending');

    // Phone syncs -> pathExists is false -> re-downloads offer 2 despite stale videoPath and acks offerId 2
    activeDev = phone;
    assert.equal((await M.runWebDavSync(runOptsFor(phone, { manual: true, pathExists: async p => phone.media.has(p) }))).status, 'ok');
    assert.equal(phone.media.get(phonePath), 'PAYLOAD_VRS1', 'phone re-downloaded audio after disk file cleared');
    assert.equal(M.getSyncState().audioAck.vrs1, s2.offer.offerId, 'phone acked new offerId');

    // Desktop syncs again -> sees new offerId ack -> deletes offer 2
    activeDev = desk;
    assert.equal((await M.runWebDavSync(runOptsFor(desk, { manual: true }))).status, 'ok');
    assert.equal(cloud.files.has(`audio/${s2.offer.file}`), false, 'offer 2 deleted after new offerId ack');
    assert.equal(M.getSyncState().audioOffers.vrs1, undefined);
    assert.ok(M.getSyncState().deliveredAudioIds.includes('vrs1'));
  }

  // 14c. Target switch while audio upload is in-flight must NOT pollute new target SyncState
  {
    cloud.reset();
    const desk = makeDeviceEnv('SwitchAudio', 'mac', '/Users/sa/Movies/LinguaClip');
    const src = '/Users/sa/Movies/LinguaClip/vsw_a.mp4';
    desk.media.set(src, 'SWITCH_AUDIO');
    activeDev = desk;
    await M.testAndEnableSync({ ...DAV_CFG, rootDir: 'AcctA', autoSyncAudio: false });
    await M.saveVideoToDB(makeVideoRec('vsw_a', SRT_1, { videoPath: src }));

    let releaseUpload;
    cloud.onUploadAudio = () => new Promise(res => { releaseUpload = res; });
    const sendPromise = M.sendVideoAudioToPhone('vsw_a');
    await new Promise(r => setTimeout(r, 10));
    await M.testAndEnableSync({ ...DAV_CFG, rootDir: 'AcctB', autoSyncAudio: false });
    releaseUpload();
    cloud.onUploadAudio = null;
    const sendRes = await sendPromise;
    assert.deepEqual(sendRes, { ok: false, reason: 'target_changed' });
    assert.deepEqual(M.getSyncState().audioOffers, {}, 'in-flight upload from AcctA must NOT pollute AcctB state');
  }

  // 14d. Audio upload persistent network error must NOT block cards & subtitles from syncing to peer
  {
    cloud.reset();
    const desk = makeDeviceEnv('LightDesk', 'mac', '/Users/l/Movies/LinguaClip');
    const phone = makeDeviceEnv('LightPhone', 'android', '/data/user/0/com.linguaclip.app/files/LinguaClip');
    const src = '/Users/l/Movies/LinguaClip/vlight.mp4';
    desk.media.set(src, 'LIGHT_AUDIO');

    activeDev = desk;
    await M.testAndEnableSync({ ...DAV_CFG, autoSyncAudio: true });
    await M.saveVideoToDB(makeVideoRec('vlight', SRT_1, { videoPath: src }));
    await M.addLine({ videoId: 'vlight', videoName: 'vlight.mp4', text: 'Hello world.', start: 1, end: 3 }, 'saved');
    // Queue auto audio while audio upload persistently fails with network error
    cloud.uploadAudioError = 'sync:network:timeout';
    const cur = M.getSyncState();
    M.saveSyncState({ ...cur, audioAutoPending: ['vlight'], dirty: true });
    const rDesk = await M.runWebDavSync(runOptsFor(desk, { manual: true }));
    assert.equal(rDesk.status, 'ok', 'audio network failure must NOT fail lightweight sync');
    assert.equal(rDesk.uploaded, true, 'lightweight snapshot still uploaded');
    assert.deepEqual(M.getSyncState().audioAutoPending, ['vlight'], 'transient audio error keeps video in queue');

    // Phone syncs and receives the video subtitle & card immediately
    activeDev = phone;
    await M.testAndEnableSync({ ...DAV_CFG });
    const rPhone = await M.runWebDavSync(runOptsFor(phone, { manual: true }));
    assert.equal(rPhone.status, 'ok');
    assert.equal((await M.getVideoFromDB('vlight'))?.subtitleText, SRT_1, 'subtitle synced despite audio failure');
    assert.equal((await M.getAllCards()).length, 1, 'card synced despite audio failure');
    cloud.uploadAudioError = null;
  }

  // 14e. Budget precision: 590 MB used + 30 MB new auto-upload blocked by maxBytes preflight; manual send succeeds & keeps 590 MB
  {
    cloud.reset();
    const desk = makeDeviceEnv('BudgetDesk', 'mac', '/Users/bd/Movies/LinguaClip');
    const src = '/Users/bd/Movies/LinguaClip/vbud.mp4';
    desk.media.set(src, 'BUDGET_AUDIO');
    activeDev = desk;
    await M.testAndEnableSync({ ...DAV_CFG, autoSyncAudio: true });
    const ym = M.currentYearMonth();
    M.saveSyncState({ ...M.getSyncState(), audioMonthly: { ym, bytes: 590 * MB } });
    const vbud = makeVideoRec('vbud', SRT_1, { videoPath: src });
    await M.saveVideoToDB(vbud);

    cloud.nextAudioBytes = 30 * MB;
    M.maybeQueueAutoAudioSync(vbud);
    const rAuto = await M.sendVideoAudioToPhone('vbud', { auto: true });
    assert.deepEqual(rAuto, { ok: false, reason: 'sync:audio_budget' }, '30 MB auto-upload rejected when only 10 MB remains');
    assert.equal(M.getSyncAudioSnapshot().budgetNotice, true, 'budgetNotice set on sync:audio_budget');
    assert.deepEqual(M.getSyncState().audioAutoPending, [], 'vbud removed from audioAutoPending on budget hit');
    assert.equal(Array.from(cloud.files.keys()).filter(k => k.startsWith('audio/')).length, 0, 'blocked file NOT uploaded');
    assert.equal(M.getMonthlyAudioUsage().bytes, 590 * MB);

    const rMan = await M.sendVideoAudioToPhone('vbud');
    assert.equal(rMan.ok, true, 'manual send bypasses auto budget');
    assert.equal(M.getMonthlyAudioUsage().bytes, 590 * MB, 'manual send does NOT alter audioMonthly');
    cloud.nextAudioBytes = null;
  }

  // 14f. Expired (>30d) local offer with no other changes bypasses unchanged and auto-cleans WebDAV file
  {
    cloud.reset();
    const desk = makeDeviceEnv('TtlDesk', 'mac', '/Users/ttl/Movies/LinguaClip');
    const src = '/Users/ttl/Movies/LinguaClip/vttl.mp4';
    desk.media.set(src, 'TTL_AUDIO');
    const baseNow = 1_760_000_000_000;
    activeDev = desk;
    await M.testAndEnableSync({ ...DAV_CFG, autoSyncAudio: false });
    await M.saveVideoToDB(makeVideoRec('vttl', SRT_1, { videoPath: src }));
    const s = await M.sendVideoAudioToPhone('vttl');
    assert.equal(s.ok, true);
    // Stamp offer createdAt at baseNow and complete sync so dirty=false & initialized=true
    const st0 = M.getSyncState();
    M.saveSyncState({ ...st0, audioOffers: { vttl: { ...st0.audioOffers.vttl, createdAt: baseNow } } });
    assert.equal((await M.runWebDavSync(runOptsFor(desk, { manual: true, now: () => baseNow + 1000 }))).status, 'ok');
    assert.equal(M.getSyncState().dirty, false);
    assert.ok(cloud.files.has(`audio/${s.offer.file}`));

    // 31 days later, non-manual sync with no other edits bypasses unchanged and deletes expired audio file
    const rTtl = await M.runWebDavSync(runOptsFor(desk, { manual: false, now: () => baseNow + 31 * DAY }));
    assert.equal(rTtl.status, 'ok');
    assert.equal(cloud.files.has(`audio/${s.offer.file}`), false, 'expired >30d cloud audio auto-deleted bypassing unchanged');
    assert.equal(M.getSyncState().audioOffers.vttl, undefined);
  }

  // 14g. 401 preserves audioAutoPending (resumes after password fix); permanent encode error drops from queue
  {
    cloud.reset();
    const desk = makeDeviceEnv('AuthQueueDesk', 'mac', '/Users/aq/Movies/LinguaClip');
    activeDev = desk;
    await M.testAndEnableSync({ ...DAV_CFG, autoSyncAudio: true });
    assert.equal((await M.runWebDavSync(runOptsFor(desk, { manual: true }))).status, 'ok');

    const vAuth = makeVideoRec('vauth', SRT_1, { videoPath: '/Users/aq/Movies/LinguaClip/vauth.mp4' });
    const vBad = makeVideoRec('vbadenc', SRT_2, { videoPath: '/Users/aq/Movies/LinguaClip/vbadenc.mp4' });
    await M.saveVideoToDB(vAuth);
    await M.saveVideoToDB(vBad);

    // 401 during auto-queue keeps vauth in audioAutoPending
    cloud.uploadAudioError = 'sync:auth';
    M.maybeQueueAutoAudioSync(vAuth);
    const r401 = await M.sendVideoAudioToPhone('vauth', { auto: true });
    assert.deepEqual(r401, { ok: false, reason: 'sync:auth' });
    assert.deepEqual(M.getSyncState().audioAutoPending, ['vauth'], '401 MUST preserve audioAutoPending');

    // Permanent encode error drops vbadenc from audioAutoPending
    cloud.uploadAudioError = 'sync:audio_encode:ffmpeg exit 1';
    M.maybeQueueAutoAudioSync(vBad);
    const rPerm = await M.sendVideoAudioToPhone('vbadenc', { auto: true });
    assert.deepEqual(rPerm, { ok: false, reason: 'sync:audio_encode:ffmpeg exit 1' });
    assert.deepEqual(M.getSyncState().audioAutoPending, ['vauth'], 'permanent encode error removed from queue while vauth stays');

    // User fixes password (same target) -> next sync auto-uploads vauth
    cloud.uploadAudioError = null;
    await M.testAndEnableSync({ ...DAV_CFG, password: 'fixed-password', autoSyncAudio: true });
    assert.deepEqual(M.getSyncState().audioAutoPending, ['vauth'], 'same-target password fix keeps audioAutoPending');
    const rFix = await M.runWebDavSync(runOptsFor(desk, { manual: false }));
    assert.equal(rFix.status, 'ok');
    assert.ok(M.getSyncState().audioOffers.vauth, 'vauth auto-uploaded after password fix');
    assert.deepEqual(M.getSyncState().audioAutoPending, []);
  }

  // 14h. Switching WebDAV target A -> B -> A aborts stale in-flight manual upload from first A session
  {
    cloud.reset();
    const desk = makeDeviceEnv('RoundTripDesk', 'mac', '/Users/rt/Movies/LinguaClip');
    activeDev = desk;
    await M.testAndEnableSync({ ...DAV_CFG, rootDir: 'BucketA' });
    const vRt = makeVideoRec('vrt', SRT_1, { videoPath: '/Users/rt/Movies/LinguaClip/vrt.mp4' });
    await M.saveVideoToDB(vRt);

    let releaseUpload;
    const uploadStarted = new Promise(res => {
      cloud.onUploadAudio = async () => { cloud.onUploadAudio = null; res(); await new Promise(r => { releaseUpload = r; }); };
    });
    const sendPromise = M.sendVideoAudioToPhone('vrt');
    await uploadStarted;

    // Switch A -> B -> A while old upload is still in flight
    await M.testAndEnableSync({ ...DAV_CFG, rootDir: 'BucketB' });
    await M.testAndEnableSync({ ...DAV_CFG, rootDir: 'BucketA' });
    releaseUpload();
    const sendRes = await sendPromise;
    assert.equal(sendRes.ok, false, 'stale upload from previous A session must abort after A->B->A');
    assert.equal(sendRes.reason, 'target_changed');
    assert.equal(M.getSyncState().audioOffers.vrt, undefined, 're-initialized A state stays clean');
  }

  // 14i. Corrupt audio download skips bad offer instead of blocking subsequent valid offers
  {
    cloud.reset();
    const desk = makeDeviceEnv('CorruptDesk', 'mac', '/Users/cd/Movies/LinguaClip');
    const phone = makeDeviceEnv('CorruptPhone', 'android', '/data/user/0/app');
    activeDev = desk;
    await M.testAndEnableSync({ ...DAV_CFG, autoSyncAudio: false });
    const v1 = makeVideoRec('v1corrupt', SRT_1, { videoPath: '/Users/cd/Movies/LinguaClip/v1.mp4' });
    const v2 = makeVideoRec('v2good', SRT_2, { videoPath: '/Users/cd/Movies/LinguaClip/v2.mp4' });
    await M.saveVideoToDB(v1);
    await M.saveVideoToDB(v2);
    const s1 = await M.sendVideoAudioToPhone('v1corrupt');
    const s2 = await M.sendVideoAudioToPhone('v2good');
    assert.equal(s1.ok, true);
    assert.equal(s2.ok, true);
    assert.equal((await M.runWebDavSync(runOptsFor(desk, { manual: true }))).status, 'ok');

    // Corrupt v1's cloud file so SHA-256 check fails, while v2 remains intact
    const f1 = cloud.files.get(`audio/${s1.offer.file}`);
    f1.content = Buffer.from('TAMPERED-CORRUPT-BYTES');

    activeDev = phone;
    cloud.wifiOk = true;
    await M.testAndEnableSync({ ...DAV_CFG, wifiOnlyAudio: true });
    const rPhone = await M.runWebDavSync(runOptsFor(phone, { manual: true }));
    assert.equal(rPhone.status, 'ok');
    const got1 = await M.getVideoFromDB('v1corrupt');
    const got2 = await M.getVideoFromDB('v2good');
    assert.equal(got1.videoPath, undefined, 'corrupt offer rejected');
    assert.equal(got2.videoPath, '/data/user/0/app/media/v2good.m4a', 'subsequent valid offer still auto-downloads');
  }
}

console.log('test-sync-engine: all 14 scenarios passed (including L2b audio relay A/B/C & R2 race/protocol regressions)');
