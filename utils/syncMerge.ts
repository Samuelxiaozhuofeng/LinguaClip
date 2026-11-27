/**
 * Pure snapshot-level multi-device merge engine (docs/sync.md).
 *
 * Guarantees commutativity, associativity, and idempotency across Desktop, Android,
 * and iPhone PWA without network IO, without @tauri-apps/* imports, and without
 * ever calling `Date.now()`.
 */
import type { ReviewCard } from './review';
import { compareStamp } from './syncClock';
import { mergeCard } from './syncCardMerge';
import {
  buildRedirects,
  buildWinnerAlignmentIndex,
  mergeDaysDev,
  mergeSettings,
  mergeTwoVideos,
  remapCardIdString,
  remapSnapshot,
  resolveVideoPathForLocal,
  sortObj,
} from './syncRekey';
import {
  ACTIVE_PEER_WINDOW_MS,
  SYNC_FORMAT,
  TOMBSTONE_GC_AGE_MS,
  type CardSyncMeta,
  type DeviceSnapshot,
  type MergeOptions,
  type MergeResult,
  type NeededClip,
  type PosAtMap,
  type SafetyAlert,
  type SyncPlatform,
  type SyncPositions,
  type SyncTombstones,
  type SyncVideoHeader,
  type VideoPosAt,
  type VideoTombstone,
} from './syncTypes';

export * from './syncTypes';
export { mergeCard, mergeSignedTs, sameFsrs } from './syncCardMerge';

function findPackForClip(clipPacks: Record<string, string[]> | undefined, file: string): string | undefined {
  if (!clipPacks) return undefined;
  for (const name of Object.keys(clipPacks).sort()) {
    if (clipPacks[name]?.includes(file)) return name;
  }
  return undefined;
}

function videoChanged(a: SyncVideoHeader, b: SyncVideoHeader): boolean {
  return (
    a.displayName !== b.displayName || a.srtHash !== b.srtHash ||
    a.currentSubtitleIndex !== b.currentSubtitleIndex || a.currentSectionIndex !== b.currentSectionIndex ||
    a.completionRate !== b.completionRate || a.lastPracticed !== b.lastPracticed ||
    a.totalPracticeTime !== b.totalPracticeTime || a.learningMode !== b.learningMode ||
    a.blurPlaybackMode !== b.blurPlaybackMode || a.lang !== b.lang
  );
}

function cardChanged(a: ReviewCard, b: ReviewCard): boolean {
  return (
    a.saved !== b.saved || a.mastered !== b.mastered || a.ankiAt !== b.ankiAt ||
    a.definition !== b.definition || a.example !== b.example || a.ai !== b.ai ||
    a.reasons.join(',') !== b.reasons.join(',') || a.fsrs.due !== b.fsrs.due ||
    a.fsrs.reps !== b.fsrs.reps || a.fsrs.lapses !== b.fsrs.lapses || a.fsrs.last_review !== b.fsrs.last_review
  );
}

function mergePositions(
  local: DeviceSnapshot,
  allSnapshots: DeviceSnapshot[],
  liveVideos: Map<string, SyncVideoHeader>,
  resolveId: (id: string) => string,
): { positions: SyncPositions; posAt: PosAtMap; watchPosUpdatedIds: string[] } {
  const positions: SyncPositions = { watch: {}, custom: {}, read: {}, lastWay: {} };
  const posAt: PosAtMap = {};
  const watchPosUpdatedIds: string[] = [];

  const extract = <T>(
    s: DeviceSnapshot,
    map: Record<string, T> | undefined,
    tsField: 'watch' | 'custom' | 'read' | 'lastWay',
    byField: 'watchBy' | 'customBy' | 'readBy' | 'lastWayBy',
  ) => {
    const out = new Map<string, { val: T; ts: number; by: string }>();
    if (!map) return out;
    for (const [rawVid, val] of Object.entries(map)) {
      if (val === undefined) continue;
      const vid = resolveId(rawVid);
      const rawAt = s.posAt?.[rawVid];
      const ts = typeof rawAt === 'number' ? rawAt : (rawAt?.[tsField] ?? 0);
      const by = typeof rawAt === 'object' && rawAt?.[byField] ? rawAt[byField]! : s.devId;
      const prev = out.get(vid);
      if (!prev || compareStamp(ts, by, prev.ts, prev.by) > 0) out.set(vid, { val, ts, by });
    }
    return out;
  };

  const specs = [
    ['watch', 'watch', 'watchBy'],
    ['custom', 'custom', 'customBy'],
    ['read', 'read', 'readBy'],
    ['lastWay', 'lastWay', 'lastWayBy'],
  ] as const;

  for (const [field, tsField, byField] of specs) {
    const localMap = extract(local, local.positions?.[field] as Record<string, unknown>, tsField, byField);
    const allMaps = allSnapshots.map(s => extract(s, s.positions?.[field] as Record<string, unknown>, tsField, byField));
    const vids = new Set<string>();
    for (const m of allMaps) for (const k of m.keys()) if (liveVideos.has(k)) vids.add(k);

    for (const vid of Array.from(vids).sort()) {
      let best: { val: unknown; ts: number; by: string } | null = null;
      for (const m of allMaps) {
        const cur = m.get(vid);
        if (cur && (!best || compareStamp(cur.ts, cur.by, best.ts, best.by) > 0)) best = cur;
      }
      if (!best) continue;
      (positions[field] as Record<string, unknown>)[vid] = best.val;
      if (!posAt[vid]) posAt[vid] = {};
      const entry = posAt[vid] as VideoPosAt;
      if (best.ts > 0) { entry[tsField] = best.ts; entry[byField] = best.by; }
      if (field === 'watch') {
        const prevLocal = localMap.get(vid);
        if (!prevLocal || prevLocal.val !== best.val || best.ts > prevLocal.ts) watchPosUpdatedIds.push(vid);
      }
    }
  }

  return {
    positions: {
      watch: sortObj(positions.watch),
      custom: sortObj(positions.custom),
      read: sortObj(positions.read),
      lastWay: sortObj(positions.lastWay),
    },
    posAt: sortObj(posAt),
    watchPosUpdatedIds: watchPosUpdatedIds.sort(),
  };
}

/** Merge `local` snapshot with zero or more `peers` snapshots deterministically. */
export function mergeSnapshots(
  local: DeviceSnapshot,
  peers: DeviceSnapshot[],
  opts: MergeOptions,
): MergeResult {
  let newerFormat = false;
  const validPeers: DeviceSnapshot[] = [];
  for (const p of peers) {
    if (!p || typeof p.devId !== 'string' || !p.devId) continue;
    if (p.v > SYNC_FORMAT) { newerFormat = true; continue; }
    validPeers.push(p);
  }
  validPeers.sort((a, b) => (a.devId < b.devId ? -1 : a.devId > b.devId ? 1 : 0));
  const allSnapshots = [local, ...validPeers];
  const sortedSnapshots = [...allSnapshots].sort((a, b) => (a.devId < b.devId ? -1 : a.devId > b.devId ? 1 : 0));

  // 1. Resolve idRedirects & podcast/starter UUID splits
  const idRedirects = buildRedirects(sortedSnapshots);
  const resolveId = (id: string) => idRedirects[id] ?? id;
  const alignIndex = buildWinnerAlignmentIndex(sortedSnapshots, idRedirects, opts.subtitles);

  const localRekeySet = new Map<string, string>();
  const noteRekey = (id: string) => { const to = resolveId(id); if (to !== id) localRekeySet.set(id, to); };
  for (const v of local.videos) noteRekey(v.id);
  for (const c of local.cards) if (c.videoId) noteRekey(c.videoId);
  for (const k of Object.keys(local.tombstones.videos ?? {})) noteRekey(k);
  for (const k of Object.keys(local.posAt ?? {})) noteRekey(k);
  const rekeys = Array.from(localRekeySet.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([from, to]) => ({ from, to }));

  const mappedLocal = remapSnapshot(local, idRedirects, alignIndex);
  const mappedPeers = validPeers.map(p => remapSnapshot(p, idRedirects, alignIndex));
  const origLocalVideos = new Map(mappedLocal.videos);
  const origLocalCards = new Map(mappedLocal.cards);

  // 2. Anti-zombie prevention via gcFloorAt (both stale local drawer devices AND stale/abandoned remote peers)
  const remoteGcFloorAt = validPeers.reduce((m, p) => Math.max(m, p.tombstones.gcFloorAt ?? 0), 0);
  const prevGcFloorAt = Math.max(local.tombstones.gcFloorAt ?? 0, remoteGcFloorAt);
  const activePeers = mappedPeers.filter(
    mp => Math.max(mp.snapshot.exportedAt, mp.snapshot.lastMergedAt) >= opts.now - ACTIVE_PEER_WINDOW_MS,
  );
  const activePeerSet = new Set(activePeers);
  const localStale = opts.lastSyncAt > 0 && remoteGcFloorAt > 0 && opts.lastSyncAt < remoteGcFloorAt;
  const isPeerStale = (mp: (typeof mappedPeers)[number]) =>
    prevGcFloorAt > 0 && (mp.snapshot.lastMergedAt < prevGcFloorAt || !activePeerSet.has(mp));

  if (prevGcFloorAt > 0) {
    const activeLiveV = new Set<string>();
    const activeLiveC = new Set<string>();
    if (!localStale) {
      for (const vid of mappedLocal.videos.keys()) activeLiveV.add(vid);
      for (const cid of mappedLocal.cards.keys()) activeLiveC.add(cid);
    }
    const nonStalePeers = mappedPeers.filter(mp => !isPeerStale(mp));
    for (const mp of nonStalePeers) {
      for (const vid of mp.videos.keys()) activeLiveV.add(vid);
      for (const cid of mp.cards.keys()) activeLiveC.add(cid);
    }

    if (localStale) {
      for (const [vid, v] of Array.from(mappedLocal.videos.entries())) {
        const born = v.bornAt ?? v.dateAdded ?? 0;
        if (born <= remoteGcFloorAt && born <= opts.lastSyncAt && !activeLiveV.has(vid)) mappedLocal.videos.delete(vid);
      }
      for (const [cid, c] of Array.from(mappedLocal.cards.entries())) {
        const born = mappedLocal.cardMeta[cid]?.bornAt ?? c.createdAt ?? 0;
        if (born <= remoteGcFloorAt && born <= opts.lastSyncAt && !activeLiveC.has(cid)) {
          mappedLocal.cards.delete(cid);
          delete mappedLocal.cardMeta[cid];
        }
      }
    }

    for (const mp of mappedPeers) {
      if (!isPeerStale(mp)) continue;
      for (const [vid, v] of Array.from(mp.videos.entries())) {
        const born = v.bornAt ?? v.dateAdded ?? 0;
        if (born <= prevGcFloorAt && !activeLiveV.has(vid)) mp.videos.delete(vid);
      }
      for (const [cid, c] of Array.from(mp.cards.entries())) {
        const born = mp.cardMeta[cid]?.bornAt ?? c.createdAt ?? 0;
        if (born <= prevGcFloorAt && !activeLiveC.has(cid)) {
          mp.cards.delete(cid);
          delete mp.cardMeta[cid];
        }
      }
    }
  }

  // 3. Merge tombstones
  const allMapped = [mappedLocal, ...mappedPeers];
  const mergedVTombs: Record<string, VideoTombstone> = {};
  const mergedCTombs: Record<string, number> = {};
  for (const m of allMapped) {
    for (const [vid, tomb] of Object.entries(m.vTombs)) {
      const prev = mergedVTombs[vid];
      if (!prev || tomb.at > prev.at) mergedVTombs[vid] = { at: tomb.at, ...(tomb.keepCards ? { keepCards: true } : {}) };
      else if (tomb.at === prev.at && tomb.keepCards) mergedVTombs[vid] = { at: prev.at, keepCards: true };
    }
    for (const [cid, at] of Object.entries(m.cTombs)) {
      if (!mergedCTombs[cid] || at > mergedCTombs[cid]) mergedCTombs[cid] = at;
    }
  }

  // 4. Merge Videos + videoPath isolation
  const allVideoIds = new Set<string>();
  for (const m of allMapped) for (const vid of m.videos.keys()) allVideoIds.add(vid);
  const mergedVideosMap = new Map<string, SyncVideoHeader>();
  const candidateRemappedPaths: Record<string, string> = {};

  for (const vid of Array.from(allVideoIds).sort()) {
    const versions = allMapped
      .map(m => ({ video: m.videos.get(vid), devId: m.snapshot.devId }))
      .filter((x): x is { video: SyncVideoHeader; devId: string } => !!x.video)
      .sort((a, b) => (a.devId < b.devId ? -1 : a.devId > b.devId ? 1 : 0));
    if (versions.length === 0) continue;

    const maxBorn = versions.reduce((mx, x) => Math.max(mx, x.video.bornAt ?? x.video.dateAdded ?? 0), 0);
    const tomb = mergedVTombs[vid];
    if (tomb && tomb.at >= maxBorn) continue;
    if (tomb && maxBorn > tomb.at) delete mergedVTombs[vid];

    let acc = versions[0].video;
    let accDev = versions[0].devId;
    for (let i = 1; i < versions.length; i++) {
      acc = mergeTwoVideos(acc, accDev, versions[i].video, versions[i].devId);
      accDev = acc.updatedBy ?? accDev;
    }

    const peerSources = mappedPeers
      .map(mp => ({ video: mp.videos.get(vid), platform: mp.snapshot.platform, ownDir: mp.snapshot.ownDir }))
      .filter((x): x is { video: SyncVideoHeader; platform: SyncPlatform; ownDir: string } => !!x.video);
    const resolvedPath = resolveVideoPathForLocal(acc, mappedLocal.videos.get(vid), peerSources, opts, candidateRemappedPaths);
    const finalVideo: SyncVideoHeader = { ...acc };
    if (resolvedPath !== undefined) finalVideo.videoPath = resolvedPath;
    else delete finalVideo.videoPath;
    mergedVideosMap.set(vid, finalVideo);
  }

  // 5. Merge Cards + tombstones + keptOrphans + neededClips
  const localClipSet = new Set<string>(opts.localClipFiles ?? []);
  for (const c of mappedLocal.cards.values()) if (c.clip?.file) localClipSet.add(c.clip.file);

  const allCardIds = new Set<string>();
  for (const m of allMapped) for (const cid of m.cards.keys()) allCardIds.add(cid);
  const mergedCardsMap = new Map<string, ReviewCard>();
  const mergedCardMeta: Record<string, CardSyncMeta> = {};
  const neededClips: NeededClip[] = [];
  const keptOrphansSet = new Set<string>();

  for (const m of allMapped) {
    for (const oid of m.snapshot.keptOrphans ?? []) {
      keptOrphansSet.add(m.cardIdMap.get(oid) ?? remapCardIdString(oid, idRedirects));
    }
  }

  for (const cid of Array.from(allCardIds).sort()) {
    const versions = allMapped
      .map(m => ({ card: m.cards.get(cid), meta: m.cardMeta[cid], devId: m.snapshot.devId, clipPacks: m.snapshot.clipPacks }))
      .filter((x): x is { card: ReviewCard; meta: CardSyncMeta; devId: string; clipPacks: Record<string, string[]> | undefined } => !!x.card)
      .sort((a, b) => (a.devId < b.devId ? -1 : a.devId > b.devId ? 1 : 0));
    if (versions.length === 0) continue;

    const maxBorn = versions.reduce((mx, x) => Math.max(mx, x.meta?.bornAt || x.card.createdAt || 0), 0);
    const vid = versions[0].card.videoId;
    const vTomb = vid ? mergedVTombs[vid] : undefined;
    if (vTomb && !vTomb.keepCards && maxBorn <= vTomb.at) {
      if (!mergedCTombs[cid] || vTomb.at > mergedCTombs[cid]) mergedCTombs[cid] = vTomb.at;
    }

    const cTomb = mergedCTombs[cid];
    if (cTomb && cTomb >= maxBorn) continue;
    if (cTomb && maxBorn > cTomb) delete mergedCTombs[cid];

    let accCard = versions[0].card;
    let accMeta = versions[0].meta ?? { bornAt: accCard.createdAt || 0 };
    const accDev = versions[0].devId;
    for (let i = 1; i < versions.length; i++) {
      const res = mergeCard(accCard, accMeta, accDev, versions[i].card, versions[i].meta, versions[i].devId);
      accCard = res.card;
      accMeta = res.meta;
    }

    const localCard = mappedLocal.cards.get(cid);
    const liveVideo = accCard.videoId ? mergedVideosMap.get(accCard.videoId) : undefined;
    const finalCard: ReviewCard = { ...accCard };
    if (localCard?.videoPath !== undefined) finalCard.videoPath = localCard.videoPath;
    else if (liveVideo?.videoPath !== undefined) finalCard.videoPath = liveVideo.videoPath;
    else delete finalCard.videoPath;

    if (localCard?.clip) {
      finalCard.clip = localCard.clip;
    } else {
      delete finalCard.clip;
      const peerWithClip = versions
        .filter(x => x.devId !== local.devId && x.card.clip)
        .sort((a, b) => {
          const fa = a.card.clip!.file, fb = b.card.clip!.file;
          return fa !== fb ? (fa < fb ? -1 : 1) : (a.devId < b.devId ? -1 : 1);
        })[0];
      if (peerWithClip?.card.clip) {
        if (localClipSet.has(peerWithClip.card.clip.file)) {
          finalCard.clip = peerWithClip.card.clip;
        } else {
          const packName = findPackForClip(peerWithClip.clipPacks, peerWithClip.card.clip.file);
          neededClips.push({ cardId: cid, clip: peerWithClip.card.clip, fromDevId: peerWithClip.devId, ...(packName ? { packName } : {}) });
        }
      }
    }

    mergedCardsMap.set(cid, finalCard);
    mergedCardMeta[cid] = accMeta;
    if (vTomb?.keepCards) keptOrphansSet.add(cid);
  }
  const keptOrphans = Array.from(keptOrphansSet).filter(id => mergedCardsMap.has(id)).sort();

  // 6. 90-day Tombstone GC across 180-day active peers
  let gcFloorAt = Math.max(local.tombstones.gcFloorAt ?? 0, remoteGcFloorAt);
  const minActiveMergedAt = activePeers.length > 0
    ? activePeers.reduce((mn, mp) => Math.min(mn, mp.snapshot.lastMergedAt), opts.now)
    : opts.now;
  const gcCutoff = Math.min(minActiveMergedAt, opts.now - TOMBSTONE_GC_AGE_MS);
  if (gcCutoff > 0) {
    let maxGcd = 0;
    for (const [vid, tomb] of Object.entries(mergedVTombs)) {
      if (tomb.at < gcCutoff) { if (tomb.at > maxGcd) maxGcd = tomb.at; delete mergedVTombs[vid]; }
    }
    for (const [cid, at] of Object.entries(mergedCTombs)) {
      if (at < gcCutoff) { if (at > maxGcd) maxGcd = at; delete mergedCTombs[cid]; }
    }
    if (maxGcd > gcFloorAt) gcFloorAt = maxGcd;
  }

  // 7. Merge daysDev, positions, readLooked/readGloss, settings, neededSubs
  const { daysDev, projectedDays } = mergeDaysDev(allSnapshots);
  const { positions, posAt, watchPosUpdatedIds } = mergePositions(local, allSnapshots, mergedVideosMap, resolveId);
  const mergedSettings = mergeSettings(allSnapshots);

  const mergedReadLooked: Record<string, string[]> = {};
  const mergedReadGloss: Record<string, Record<string, string>> = {};
  for (const vid of Array.from(mergedVideosMap.keys()).sort()) {
    const words = new Set<string>();
    const gloss: Record<string, string> = {};
    for (const s of sortedSnapshots) {
      for (const [rawVid, list] of Object.entries(s.readLooked ?? {})) {
        if (resolveId(rawVid) === vid && Array.isArray(list)) for (const w of list) if (typeof w === 'string') words.add(w);
      }
      for (const [rawVid, gMap] of Object.entries(s.readGloss ?? {})) {
        if (resolveId(rawVid) === vid && gMap && typeof gMap === 'object') {
          for (const [w, meaning] of Object.entries(gMap)) if (typeof meaning === 'string' && !gloss[w]) gloss[w] = meaning;
        }
      }
    }
    if (words.size > 0) mergedReadLooked[vid] = Array.from(words).sort().slice(-500);
    if (Object.keys(gloss).length > 0) mergedReadGloss[vid] = sortObj(gloss);
  }

  const localSubSet = opts.localSubHashes
    ? new Set<string>(opts.localSubHashes)
    : new Set<string>(local.videos.map(v => v.srtHash).filter(Boolean));
  const neededSubs = Array.from(
    new Set(Array.from(mergedVideosMap.values()).map(v => v.srtHash).filter(h => !!h && !localSubSet.has(h))),
  ).sort();

  // 8. Summary & safety circuit breaker
  let addedVideos = 0, updatedVideos = 0, removedVideos = 0;
  for (const [vid, v] of mergedVideosMap) {
    const prev = origLocalVideos.get(vid);
    if (!prev) addedVideos++;
    else if (videoChanged(prev, v)) updatedVideos++;
  }
  for (const vid of origLocalVideos.keys()) if (!mergedVideosMap.has(vid)) removedVideos++;

  let addedCards = 0, updatedCards = 0, removedCards = 0;
  for (const [cid, c] of mergedCardsMap) {
    const prev = origLocalCards.get(cid);
    if (!prev) addedCards++;
    else if (cardChanged(prev, c)) updatedCards++;
  }
  for (const cid of origLocalCards.keys()) if (!mergedCardsMap.has(cid)) removedCards++;

  const summary = { addedVideos, updatedVideos, removedVideos, addedCards, updatedCards, removedCards };
  const firstSync = !opts.initialized && (local.videos.length > 0 || local.cards.length > 0) && validPeers.length > 0;
  const massDeletion =
    (removedCards >= 20 && removedCards / Math.max(1, local.cards.length) > 0.2) ||
    (removedVideos >= 5 && removedVideos / Math.max(1, local.videos.length) > 0.3);
  const safetyAlert: SafetyAlert | null = firstSync || massDeletion
    ? {
        kind: firstSync ? 'firstSync' : 'massDeletion',
        firstSync, massDeletion,
        localVideos: local.videos.length, localCards: local.cards.length,
        dropVideos: removedVideos, dropCards: removedCards, summary,
      }
    : null;

  const tombstones: SyncTombstones = {
    videos: sortObj(mergedVTombs),
    cards: sortObj(mergedCTombs),
    ...(gcFloorAt > 0 ? { gcFloorAt } : {}),
  };

  const snapshot: DeviceSnapshot = {
    v: SYNC_FORMAT, devId: local.devId, platform: opts.localPlatform, ownDir: opts.localOwnDir,
    exportedAt: opts.now, lastMergedAt: opts.now,
    videos: Array.from(mergedVideosMap.values()),
    cards: Array.from(mergedCardsMap.values()),
    cardMeta: sortObj(mergedCardMeta),
    tombstones, daysDev, positions, posAt,
    ...(Object.keys(mergedReadLooked).length > 0 ? { readLooked: mergedReadLooked } : {}),
    ...(Object.keys(mergedReadGloss).length > 0 ? { readGloss: mergedReadGloss } : {}),
    ...(keptOrphans.length > 0 ? { keptOrphans } : {}),
    ...(Object.keys(idRedirects).length > 0 ? { idRedirects } : {}),
    ...(Object.keys(mergedSettings).length > 0 ? { settings: mergedSettings } : {}),
    ...(local.clipPacks ? { clipPacks: local.clipPacks } : {}),
  };

  return {
    snapshot, projectedDays, rekeys, keptOrphans, watchPosUpdatedIds, neededClips, neededSubs,
    candidateRemappedPaths: sortObj(candidateRemappedPaths), newerFormat, summary, safetyAlert,
  };
}
