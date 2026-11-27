/**
 * Local snapshot collection and incremental non-destructive IDB merge apply
 * for cross-device sync (docs/sync.md).
 * Zero @tauri-apps/* imports, zero `utils/clips.ts` imports (PWA-safe), zero IDB `clear()`.
 */
import type { VideoRecord } from '../types';
import { clipFiles } from './backup';
import type { RekeyFilesResult } from './desktop';
import { getAllVideosFromDB, initDB } from './fileSystemAccess';
import { getAllReadGloss, getAllReadLooked, getAllReadPos } from './readLooked';
import { readAll, setClip, type Clip, type ReviewCard } from './review';
import { getAllCustomPos, getAllLastWay, getAllWatchPos } from './storage';
import { srtHash } from './syncClock';
import { getSyncDeviceId } from './syncConfig';
import { mergeCard, mergeSnapshots } from './syncMerge';
import {
  META_SYNC_CARDS, META_SYNC_PENDING_CLIPS, META_SYNC_REDIRECTS, META_SYNC_TOMBSTONES,
  readPosAt, readSyncMetaFromReviewMeta, type PendingClipEntry,
} from './syncMeta';
import {
  META_SYNC_SETTINGS, SAFE_SYNC_SETTING_KEYS, applyLiveLocalStorageMerge,
  collectSafeSettings, extractSettingsMeta, readKeptOrphans,
} from './syncSettingsApply';
import {
  SYNC_FORMAT, type CardSyncMeta, type DeviceSnapshot, type MergeOptions, type MergeResult,
  type NeededClip, type SyncAudioOffer, type SyncPlatform, type SyncTombstones, type SyncVideoHeader,
} from './syncTypes';
import { applyDaysDev, readDaysDev } from './today';

export { SAFE_SYNC_SETTING_KEYS };
export const RESTORE_LOCK = 'linguaclip-restore';
const REVIEW_DB = 'linguaclip_review';

let clipsUnpackingDepth = 0;
export const isClipsUnpacking = (): boolean => clipsUnpackingDepth > 0;
export async function withClipsUnpacking<T>(fn: () => Promise<T>): Promise<T> {
  clipsUnpackingDepth++;
  try { return await fn(); } finally { clipsUnpackingDepth--; }
}

/** Run `fn` exclusively under the shared Web Lock `'linguaclip-restore'` when available. */
export function withRestoreLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  return locks?.request ? locks.request(RESTORE_LOCK, fn) : fn();
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const settleTx = (tx: IDBTransaction, what: string): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error(`${what} failed`));
    tx.onabort = () => reject(tx.error ?? new Error(`${what} aborted`));
  });

function openReviewDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(REVIEW_DB, 1);
    req.onupgradeneeded = () => { for (const n of ['cards', 'meta']) if (!req.result.objectStoreNames.contains(n)) req.result.createObjectStore(n, { keyPath: 'id' }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open review database'));
  });
}

export interface BuildSnapshotOptions {
  platform: SyncPlatform;
  ownDir: string;
  clipPacks?: Record<string, string[]>;
  audioOffers?: Record<string, SyncAudioOffer>;
  audioHave?: string[];
  audioAck?: Record<string, string>;
  lastMergedAt?: number;
  now?: number;
}
export interface LocalSnapshotBundle {
  snapshot: DeviceSnapshot; subsByHash: Record<string, string>; localClipFiles: string[];
  rawVideos: VideoRecord[]; rawCards: ReviewCard[]; pendingClips: Record<string, PendingClipEntry>;
}

/** Collect a complete local L1a DeviceSnapshot plus local subtitle bodies & clip names. */
export async function buildLocalSnapshot(opts: BuildSnapshotOptions): Promise<LocalSnapshotBundle> {
  const now = opts.now ?? Date.now();
  const devId = getSyncDeviceId();
  const [rawVideos, review] = await Promise.all([getAllVideosFromDB() as Promise<VideoRecord[]>, readAll()]);
  const { cardMeta, tombstones, pendingClips, idRedirects } = readSyncMetaFromReviewMeta(review.meta);
  const prevSettingsMeta = extractSettingsMeta(review.meta);

  const subsByHash: Record<string, string> = {};
  const videos: SyncVideoHeader[] = [];
  for (const r of rawVideos) {
    if (r.importJob) continue; // skip unfinished / failed imports
    const hash = r.subtitleText ? srtHash(r.subtitleText) : '';
    if (hash && r.subtitleText) subsByHash[hash] = r.subtitleText;
    const { subtitleText: _st, videoFileHandle: _fh, importJob: _ij, ...rest } = r;
    videos.push({ ...rest, srtHash: hash, bornAt: r.dateAdded || 0 });
  }

  const readLooked = getAllReadLooked(), readGloss = getAllReadGloss();
  const keptOrphans = [...new Set(readKeptOrphans())].sort();
  const settings = collectSafeSettings(prevSettingsMeta, devId, now);
  const localClipFiles = clipFiles(review.cards);

  const audioOffers = opts.audioOffers && Object.keys(opts.audioOffers).length > 0 ? opts.audioOffers : undefined;
  const audioHave = opts.audioHave
    ? [...new Set(opts.audioHave.filter(x => typeof x === 'string' && !!x))].sort()
    : [];
  const audioAck: Record<string, string> = {};
  if (opts.audioAck) {
    for (const k of Object.keys(opts.audioAck).sort()) {
      const v = opts.audioAck[k];
      if (k && typeof v === 'string' && v) audioAck[k] = v;
    }
  }

  const snapshot: DeviceSnapshot = {
    v: SYNC_FORMAT, devId, platform: opts.platform, ownDir: opts.ownDir,
    exportedAt: now, lastMergedAt: opts.lastMergedAt ?? 0,
    videos, cards: review.cards, cardMeta, tombstones,
    daysDev: readDaysDev(now),
    positions: { watch: getAllWatchPos(), custom: getAllCustomPos(), read: getAllReadPos(), lastWay: getAllLastWay() },
    posAt: readPosAt(),
    ...(Object.keys(readLooked).length > 0 ? { readLooked } : {}),
    ...(Object.keys(readGloss).length > 0 ? { readGloss } : {}),
    ...(keptOrphans.length > 0 ? { keptOrphans } : {}),
    ...(Object.keys(idRedirects).length > 0 ? { idRedirects } : {}),
    ...(Object.keys(settings).length > 0 ? { settings } : {}),
    ...(opts.clipPacks && Object.keys(opts.clipPacks).length > 0 ? { clipPacks: opts.clipPacks } : {}),
    ...(audioOffers ? { audioOffers } : {}),
    ...(audioHave.length > 0 ? { audioHave } : {}),
    ...(Object.keys(audioAck).length > 0 ? { audioAck } : {}),
  };
  return { snapshot, subsByHash, localClipFiles, rawVideos, rawCards: review.cards, pendingClips };
}

function headerToVideoRecord(v: SyncVideoHeader, subtitleText: string, videoPath?: string): VideoRecord {
  const { srtHash: _h, bornAt: _b, updatedBy: _u, importing: _i, ...base } = v;
  const rec: VideoRecord = { ...base, subtitleText };
  if (videoPath !== undefined) rec.videoPath = videoPath;
  else delete rec.videoPath;
  return rec;
}

export interface ApplyMergeArgs {
  result: MergeResult;
  downloadedSubs: Record<string, string>;
  platform: SyncPlatform;
  localOwnDir: string;
  candidatePathExists?: (p: string) => Promise<boolean>;
  rekeyFiles?: (from: string, to: string) => Promise<RekeyFilesResult | number>;
  onWatchPosUpdated?: (ids: string[]) => Promise<void>;
}

export interface ApplyMergeStats {
  skippedMissingSubVideos: string[];
  pendingClipsCount: number;
}

const isReadableLocalVideo = (r: VideoRecord | undefined): boolean => !!r && !r.importJob && !!r.subtitleText.trim();

/** Re-run `mergeSnapshots` omitting unready rekey targets whose winning subtitle is missing locally & remotely. */
export function remergeWithoutUnreadyRekeys(
  localBundle: LocalSnapshotBundle,
  peers: DeviceSnapshot[],
  initialResult: MergeResult,
  downloadedSubs: Record<string, string>,
  mergeOpts: MergeOptions,
): MergeResult {
  const readableLocalIds = new Set(localBundle.rawVideos.filter(isReadableLocalVideo).map(v => v.id));
  const missingTargets = new Set(
    initialResult.rekeys.map(r => r.to).filter(to => {
      if (readableLocalIds.has(to)) return false;
      const w = initialResult.snapshot.videos.find(v => v.id === to);
      return !w?.srtHash || !downloadedSubs[w.srtHash];
    }),
  );
  if (missingTargets.size === 0) return initialResult;
  const safePeers = peers.map(p => ({
    ...p,
    videos: p.videos.filter(v => !missingTargets.has(v.id)),
    cards: p.cards.filter(c => !c.videoId || !missingTargets.has(c.videoId)),
  }));
  return mergeSnapshots(localBundle.snapshot, safePeers, mergeOpts);
}

/** Incrementally apply a `MergeResult` to IDB & localStorage without ever clearing stores or reloading. */
export async function applyMergeToLocal(args: ApplyMergeArgs): Promise<ApplyMergeStats> {
  const { result, downloadedSubs } = args;
  const devId = getSyncDeviceId();
  const mergedVideos = new Map(result.snapshot.videos.map(v => [v.id, v]));

  // 1. Only execute rekeys whose winning target already has readable local subtitles or has its subtitle ready.
  const preExisting = new Map<string, VideoRecord>(((await getAllVideosFromDB()) as VideoRecord[]).map(r => [r.id, r]));
  const candidateRekeys = result.rekeys.filter(({ to }) => {
    if (isReadableLocalVideo(preExisting.get(to))) return true;
    const w = mergedVideos.get(to);
    return !!(w?.srtHash && downloadedSubs[w.srtHash]);
  });
  const readyRekeys: { from: string; to: string }[] = [];
  const movedMediaPaths = new Map<string, string>();
  const movedMediaByWinner = new Map<string, string>();

  for (const r of candidateRekeys) {
    try {
      const res = await args.rekeyFiles?.(r.from, r.to);
      if (res && typeof res === 'object' && Array.isArray(res.mediaPaths)) {
        for (const [oldP, newP] of res.mediaPaths) {
          movedMediaPaths.set(oldP, newP);
          if (!movedMediaByWinner.has(r.to)) movedMediaByWinner.set(r.to, newP);
        }
      }
      readyRekeys.push(r);
    } catch (e) { console.warn('sync rekeyFiles failed:', r.from, r.to, e); }
  }
  const readyRekeyFromSet = new Set(readyRekeys.map(r => r.from));

  // 2. Probe Mac↔Windows candidate remapped paths before opening any IDB transaction.
  const verifiedPaths: Record<string, string> = {};
  if (args.candidatePathExists) {
    await Promise.all(Object.entries(result.candidateRemappedPaths).map(async ([vid, p]) => {
      try { if (p && await args.candidatePathExists!(p)) verifiedPaths[vid] = p; } catch { /* unverified */ }
    }));
  }

  const vTombs = result.snapshot.tombstones.videos ?? {};
  const gcFloorAt = result.snapshot.tombstones.gcFloorAt ?? 0;
  const skippedMissingSubVideos: string[] = [];
  const skippedVideoSet = new Set<string>();
  const liveVideoIds = new Set<string>();

  // 3. Videos: single incremental readwrite transaction (never `clear()`).
  {
    const db = await initDB();
    const tx = db.transaction(['videos'], 'readwrite');
    const store = tx.objectStore('videos');
    const allReq = store.getAll();
    allReq.onsuccess = () => {
      const existing = new Map<string, VideoRecord>(((allReq.result as VideoRecord[] | undefined) ?? []).map(r => [r.id, r]));
      const remapPathIfMoved = (p?: string) => (p && movedMediaPaths.has(p) ? movedMediaPaths.get(p)! : p);
      for (const v of result.snapshot.videos) {
        const local = existing.get(v.id);
        if (local) {
          liveVideoIds.add(v.id);
          if (local.importJob) continue;
          const localHash = local.subtitleText ? srtHash(local.subtitleText) : '';
          const nextSub = v.srtHash && v.srtHash !== localHash && downloadedSubs[v.srtHash] ? downloadedSubs[v.srtHash] : local.subtitleText;
          const localP = remapPathIfMoved(local.videoPath);
          const nextPath = localP !== undefined ? localP : (movedMediaByWinner.get(v.id) ?? verifiedPaths[v.id] ?? remapPathIfMoved(v.videoPath));
          const mergedRec = headerToVideoRecord(v, nextSub, nextPath);
          if ((local.lastPracticed || 0) > (v.lastPracticed || 0)) {
            Object.assign(mergedRec, {
              currentSubtitleIndex: local.currentSubtitleIndex, currentSectionIndex: local.currentSectionIndex,
              completionRate: local.completionRate, lastPracticed: local.lastPracticed,
              totalPracticeTime: Math.max(local.totalPracticeTime || 0, v.totalPracticeTime || 0),
            });
          }
          store.put(mergedRec);
        } else {
          const subText = v.srtHash ? downloadedSubs[v.srtHash] : undefined;
          if (!subText) { skippedMissingSubVideos.push(v.id); skippedVideoSet.add(v.id); continue; }
          liveVideoIds.add(v.id);
          const nextPath = movedMediaByWinner.get(v.id) ?? verifiedPaths[v.id] ?? remapPathIfMoved(v.videoPath);
          store.put(headerToVideoRecord(v, subText, nextPath));
        }
      }
      for (const [id, local] of existing) {
        if (mergedVideos.has(id) || local.importJob) { liveVideoIds.add(id); continue; }
        const tomb = vTombs[id], born = local.dateAdded || 0;
        const canRekeyDel = readyRekeyFromSet.has(id) && !skippedVideoSet.has(readyRekeys.find(r => r.from === id)?.to ?? '');
        if (canRekeyDel || (tomb && tomb.at >= born) || (gcFloorAt > 0 && born > 0 && born <= gcFloorAt)) store.delete(id);
        else liveVideoIds.add(id);
      }
    };
    await settleTx(tx, 'sync videos');
  }

  // 4. Cards & sync metadata: single incremental readwrite transaction with concurrent re-merge.
  const neededClipMap = new Map<string, PendingClipEntry>(
    result.neededClips.map(n => [n.cardId, { ...n.clip, ...(n.packName ? { packName: n.packName } : {}) }]),
  );
  const mergedCards = new Map(result.snapshot.cards.map(c => [c.id, c]));
  const cTombs = result.snapshot.tombstones.cards ?? {};
  const nextRedirects: Record<string, string> = {};
  for (const [from, to] of Object.entries(result.snapshot.idRedirects ?? {})) {
    if (!skippedVideoSet.has(to)) nextRedirects[from] = to;
  }
  let pendingClipsCount = 0;

  {
    const rdb = await openReviewDB();
    const tx = rdb.transaction(['cards', 'meta'], 'readwrite');
    const cStore = tx.objectStore('cards'), mStore = tx.objectStore('meta');
    const cAllReq = cStore.getAll(), mAllReq = mStore.getAll();
    let cardsReady = false, metaReady = false;

    const run = () => {
      if (!cardsReady || !metaReady) return;
      const freshCards = new Map<string, ReviewCard>(((cAllReq.result as ReviewCard[] | undefined) ?? []).map(c => [c.id, c]));
      const liveMeta = readSyncMetaFromReviewMeta((mAllReq.result as Record<string, unknown>[] | undefined) ?? []);
      const nextCardMeta: Record<string, CardSyncMeta> = { ...result.snapshot.cardMeta };
      const nextTombs: SyncTombstones = {
        videos: { ...vTombs }, cards: { ...cTombs }, ...(gcFloorAt > 0 ? { gcFloorAt } : {}),
      };
      for (const [vid, t] of Object.entries(liveMeta.tombstones.videos)) {
        if (!nextTombs.videos[vid] || t.at > nextTombs.videos[vid].at) nextTombs.videos[vid] = t;
      }
      for (const [cid, at] of Object.entries(liveMeta.tombstones.cards)) {
        if (!nextTombs.cards[cid] || at > nextTombs.cards[cid]) nextTombs.cards[cid] = at;
      }
      const nextPendingClips: Record<string, PendingClipEntry> = { ...liveMeta.pendingClips };

      for (const [cid, mergedCard] of mergedCards) {
        const fresh = freshCards.get(cid);
        const targetMeta = result.snapshot.cardMeta[cid] ?? { bornAt: mergedCard.createdAt || 0 };
        if (!fresh && (liveMeta.tombstones.cards[cid] ?? 0) >= targetMeta.bornAt) {
          delete nextCardMeta[cid]; delete nextPendingClips[cid]; continue;
        }
        let finalCard: ReviewCard = { ...mergedCard }, finalMeta: CardSyncMeta = targetMeta;
        if (fresh) {
          const remerged = mergeCard(fresh, liveMeta.cardMeta[cid], devId, mergedCard, targetMeta, result.snapshot.devId);
          finalCard = remerged.card; finalMeta = remerged.meta;
          if (fresh.videoPath !== undefined) finalCard.videoPath = fresh.videoPath;
        }
        if (finalCard.videoPath && movedMediaPaths.has(finalCard.videoPath)) {
          finalCard.videoPath = movedMediaPaths.get(finalCard.videoPath)!;
        } else if (finalCard.videoId && movedMediaByWinner.has(finalCard.videoId) && (!finalCard.videoPath || movedMediaPaths.has(finalCard.videoPath))) {
          finalCard.videoPath = movedMediaByWinner.get(finalCard.videoId)!;
        } else if (finalCard.videoPath === undefined && finalCard.videoId && verifiedPaths[finalCard.videoId]) {
          finalCard.videoPath = verifiedPaths[finalCard.videoId];
        }
        if (fresh?.clip) { finalCard.clip = fresh.clip; delete nextPendingClips[cid]; }
        else if (neededClipMap.has(cid)) { delete finalCard.clip; nextPendingClips[cid] = neededClipMap.get(cid)!; }
        cStore.put(finalCard);
        nextCardMeta[cid] = finalMeta;
      }

      for (const [cid, fresh] of freshCards) {
        if (mergedCards.has(cid)) continue;
        const born = liveMeta.cardMeta[cid]?.bornAt ?? fresh.createdAt ?? 0;
        const vTomb = fresh.videoId ? vTombs[fresh.videoId] : undefined;
        const rekeyedAway = !!fresh.videoId && readyRekeyFromSet.has(fresh.videoId) && !skippedVideoSet.has(readyRekeys.find(r => r.from === fresh.videoId)?.to ?? '');
        const killed = ((cTombs[cid] ?? 0) >= born && (cTombs[cid] ?? 0) > 0) ||
          (!!vTomb && !vTomb.keepCards && born <= vTomb.at) || rekeyedAway || (gcFloorAt > 0 && born > 0 && born <= gcFloorAt);
        if (killed) { cStore.delete(cid); delete nextCardMeta[cid]; delete nextPendingClips[cid]; }
        else if (liveMeta.cardMeta[cid]) nextCardMeta[cid] = liveMeta.cardMeta[cid];
      }

      for (const cid of Object.keys(nextPendingClips)) {
        const fresh = freshCards.get(cid);
        if ((!mergedCards.has(cid) && !fresh) || fresh?.clip) delete nextPendingClips[cid];
      }
      pendingClipsCount = Object.keys(nextPendingClips).length;

      mStore.put({ id: META_SYNC_CARDS, map: nextCardMeta });
      mStore.put({ id: META_SYNC_TOMBSTONES, videos: nextTombs.videos, cards: nextTombs.cards, ...(nextTombs.gcFloorAt !== undefined ? { gcFloorAt: nextTombs.gcFloorAt } : {}) });
      mStore.put({ id: META_SYNC_PENDING_CLIPS, map: nextPendingClips });
      mStore.put({ id: META_SYNC_REDIRECTS, map: nextRedirects });
      if (result.snapshot.settings) mStore.put({ id: META_SYNC_SETTINGS, map: result.snapshot.settings });
    };
    cAllReq.onsuccess = () => { cardsReady = true; run(); };
    mAllReq.onsuccess = () => { metaReady = true; run(); };
    await settleTx(tx, 'sync review');
  }

  await setClip([], { kind: 'audio', file: '', from: 0 }).catch(() => {});

  // 5. Re-read live stats, playback/reading positions, readLooked/readGloss & settings before committing.
  applyDaysDev(result.snapshot.daysDev);
  const actualWatchUpdatedIds = await applyLiveLocalStorageMerge({ result, devId, liveVideoIds, readyRekeys });
  if (actualWatchUpdatedIds.length > 0) await args.onWatchPosUpdated?.(actualWatchUpdatedIds);
  return { skippedMissingSubVideos, pendingClipsCount };
}

/** Read pending (not-yet-downloaded) clip map from `linguaclip_review.meta`. */
export async function getPendingClipsMap(): Promise<Record<string, PendingClipEntry>> {
  return readSyncMetaFromReviewMeta((await readAll()).meta).pendingClips;
}

/** Return unique filenames of ALL pending clips so `clips.ts` sweep protects them. */
export async function pendingClipsList(): Promise<string[]> {
  const out = new Set<string>();
  for (const clip of Object.values(await getPendingClipsMap())) {
    if (clip.file) out.add(clip.file);
    if (clip.image) out.add(clip.image);
  }
  return [...out];
}

/** Return unique filenames of pending clips that actually have an uploaded remote pack. */
export async function downloadablePendingClipsList(): Promise<string[]> {
  const out = new Set<string>();
  for (const clip of Object.values(await getPendingClipsMap())) {
    if (!clip.packName) continue;
    if (clip.file) out.add(clip.file);
    if (clip.image) out.add(clip.image);
  }
  return [...out];
}

/** Remove mounted card IDs from `sync_pending_clips` after their clip files land on disk. */
export async function clearPendingClips(cardIds: string[]): Promise<void> {
  if (cardIds.length === 0) return;
  const rdb = await openReviewDB();
  const tx = rdb.transaction(['meta'], 'readwrite');
  const mStore = tx.objectStore('meta');
  const req = mStore.get(META_SYNC_PENDING_CLIPS);
  req.onsuccess = () => {
    const row = req.result;
    const map = isRecord(row) && isRecord(row.map) ? { ...(row.map as Record<string, PendingClipEntry>) } : {};
    let changed = false;
    for (const id of cardIds) if (id in map) { delete map[id]; changed = true; }
    if (changed) mStore.put({ id: META_SYNC_PENDING_CLIPS, map });
  };
  await settleTx(tx, 'clear pending clips');
}

/** Validate and parse a remote/offline `DeviceSnapshot` JSON string; returns null if malformed. */
export function parsePeerSnapshot(raw: string): DeviceSnapshot | null {
  try {
    const obj = JSON.parse(raw) as Partial<DeviceSnapshot> | null;
    if (!isRecord(obj) || typeof obj.devId !== 'string' || !obj.devId || typeof obj.v !== 'number') return null;
    if (!Array.isArray(obj.videos) || !Array.isArray(obj.cards)) return null;
    const snap = obj as DeviceSnapshot;
    if ('audioHave' in snap) {
      snap.audioHave = Array.isArray(snap.audioHave)
        ? snap.audioHave.filter((x): x is string => typeof x === 'string' && !!x)
        : undefined;
    }
    if ('audioAck' in snap) {
      if (isRecord(snap.audioAck)) {
        const clean: Record<string, string> = {};
        for (const [k, v] of Object.entries(snap.audioAck)) if (k && typeof v === 'string' && v) clean[k] = v;
        snap.audioAck = clean;
      } else snap.audioAck = undefined;
    }
    if ('audioOffers' in snap) {
      if (isRecord(snap.audioOffers)) {
        const clean: Record<string, SyncAudioOffer> = {};
        for (const [k, v] of Object.entries(snap.audioOffers)) {
          if (!k || !isRecord(v)) continue;
          if (typeof v.file !== 'string' || !v.file || typeof v.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(v.sha256) ||
            typeof v.bytes !== 'number' || !Number.isFinite(v.bytes) || v.bytes < 0 ||
            typeof v.durSec !== 'number' || !Number.isFinite(v.durSec) || v.durSec < 0 ||
            typeof v.createdAt !== 'number' || !Number.isFinite(v.createdAt)) continue;
          const offerId = typeof v.offerId === 'string' && v.offerId ? v.offerId : undefined;
          clean[k] = { file: v.file, sha256: v.sha256, bytes: v.bytes, durSec: v.durSec, createdAt: v.createdAt, ...(offerId ? { offerId } : {}) };
        }
        snap.audioOffers = clean;
      } else snap.audioOffers = undefined;
    }
    return snap;
  } catch { return null; }
}

/** Skip needed clips whose source video exists locally (can be cut locally for free). */
export async function filterDownloadableClips(
  items: NeededClip[], cardMap: Map<string, ReviewCard>, findVideo?: (c: ReviewCard) => Promise<string | null>,
): Promise<NeededClip[]> {
  if (!findVideo) return items;
  const out: NeededClip[] = [];
  for (const item of items) {
    const card = cardMap.get(item.cardId);
    if (card && await findVideo(card).catch(() => null)) continue;
    out.push(item);
  }
  return out;
}

/** Mount extracted clip files onto cards via `setClip(..., true)` and clear them from `sync_pending_clips`. */
export async function mountExtractedClips(
  items: NeededClip[], extracted: string[], mountClip: typeof setClip = setClip,
): Promise<number> {
  const got = new Set(extracted), mountedIds: string[] = [];
  for (const item of items) {
    if (!got.has(item.clip.file)) continue;
    const clip: Clip = item.clip.image && !got.has(item.clip.image)
      ? { kind: item.clip.kind, file: item.clip.file, from: item.clip.from } : item.clip;
    await mountClip([item.cardId], clip, true);
    mountedIds.push(item.cardId);
  }
  if (mountedIds.length > 0) await clearPendingClips(mountedIds);
  return mountedIds.length;
}
