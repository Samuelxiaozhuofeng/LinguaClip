/**
 * Runtime WebDAV sync orchestration engine, L1b/L2 transfers, circuit breakers,
 * zero-race clip unpacking guard, and silent background scheduler (docs/sync.md).
 * Re-exports offline merge pack helpers from `utils/syncPack.ts`.
 * Zero @tauri-apps/* imports and zero `utils/clips.ts` imports (100% PWA-safe).
 */
import {
  readCacheText, syncClipNetworkOk, syncDownloadClipPack, syncRekeyFiles,
  syncUploadClipPack, syncWebdavGetGz, syncWebdavList, syncWebdavPutGz,
  syncWebdavSupported, syncWebdavTest, writeCacheText,
  type RemoteEntry, type WebDavTestResult,
} from './desktop';
import type { ReviewCard } from './review';
import {
  applyMergeToLocal, buildLocalSnapshot, clearPendingClips, downloadablePendingClipsList,
  filterDownloadableClips, isClipsUnpacking, mountExtractedClips, parsePeerSnapshot,
  pendingClipsList, remergeWithoutUnreadyRekeys, withClipsUnpacking, withRestoreLock,
} from './syncApply';
import { sha256Hex } from './syncClock';
import {
  createFreshSyncState, getSyncConfig, getSyncDeviceId, getSyncState, isSafeWebDavUrl,
  saveSyncConfig, saveSyncState, webDavTargetKey, type SyncState, type WebDavConfig,
} from './syncConfig';
import { mergeSnapshots } from './syncMerge';
import { getSyncDirtyGen, subscribeSyncDirty } from './syncMeta';
import {
  exportOfflineSyncPack, previewOfflineSyncPack, registerOfflineAppliedHook,
  type OfflineMergeOptions, type OfflineMergePreview, type PickedSyncPack, type SyncClipsRuntime,
} from './syncPack';
import { SYNC_FORMAT, type DeviceSnapshot, type MergeSummary, type NeededClip, type SafetyAlert } from './syncTypes';

export {
  exportOfflineSyncPack, previewOfflineSyncPack,
  type OfflineMergeOptions, type OfflineMergePreview, type PickedSyncPack, type SyncClipsRuntime,
};

const SYNC_CACHE_KINDS = ['trans', 'breakdown', 'cloze', 'keywords', 'phrases', 'levels', 'segments'] as const;
const SYNC_CACHE_KIND_SET = new Set<string>(SYNC_CACHE_KINDS);
const MAX_CACHE_BYTES = 2 * 1024 * 1024;
const BACKOFF_MS = [60_000, 180_000, 600_000, 1_800_000];
const ZERO_SUMMARY: MergeSummary = { addedVideos: 0, updatedVideos: 0, removedVideos: 0, addedCards: 0, updatedCards: 0, removedCards: 0 };

export interface SyncRuntimeStatus {
  syncing: boolean; phase: 'idle' | 'pulling' | 'merging' | 'pushing' | 'clips';
  lastSyncAt: number; lastError: string | null; authFailed: boolean;
  newerFormat: boolean; dirty: boolean; backoffUntil: number; pendingAlert: SafetyAlert | null;
}

export interface SyncRunOptions extends OfflineMergeOptions {
  manual?: boolean; confirmSafety?: boolean; isBusy?: () => boolean;
}

export type SyncRunResult =
  | { status: 'ok'; summary: MergeSummary; uploaded: boolean; clipsDownloaded: number; clipsUploaded: number; newerFormat: boolean }
  | { status: 'skipped'; reason: 'disabled' | 'unsupported' | 'busy' | 'auth_failed' | 'backoff' }
  | { status: 'needs_confirm'; alert: SafetyAlert }
  | { status: 'error'; error: string };

export interface SyncSchedulerHandle {
  stop: () => void; triggerNow: () => Promise<SyncRunResult>; onLeavePractice: () => Promise<SyncRunResult>;
  confirmPending: () => Promise<SyncRunResult>; dismissPending: () => void;
}

const statusListeners = new Set<() => void>();
const appliedListeners = new Set<() => void>();
const peerCache = new Map<string, { etag: string; snap: DeviceSnapshot }>();
let inFlight: Promise<SyncRunResult> | null = null;
let queuedBgOpts: SyncRunOptions | null = null;
let configEpoch = 0;
let runtimeHydrated = false;
let runtime: SyncRuntimeStatus = {
  syncing: false, phase: 'idle', lastSyncAt: 0, lastError: null,
  authFailed: false, newerFormat: false, dirty: false, backoffUntil: 0, pendingAlert: null,
};

const errStr = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const isAuthErr = (m: string) => m === 'sync:auth' || m.startsWith('sync:auth:');
const isTransientErr = (m: string) => m === 'sync:ratelimit' || m.startsWith('sync:network:') || m.startsWith('sync:http:5');
const isFatalSyncErr = (e: unknown) => { const m = errStr(e); return isAuthErr(m) || isTransientErr(m); };
const utf8Len = (s: string) => new TextEncoder().encode(s).byteLength;
const clipWantedNames = (items: NeededClip[]) => [...new Set(items.flatMap(x => (x.clip.image ? [x.clip.file, x.clip.image] : [x.clip.file])))];
const summaryChanged = (s: MergeSummary) =>
  s.addedVideos + s.updatedVideos + s.removedVideos + s.addedCards + s.updatedCards + s.removedCards > 0;
const snapshotContentHash = (snap: DeviceSnapshot): string =>
  sha256Hex(JSON.stringify({ ...snap, exportedAt: 0, lastMergedAt: 0 }));

function hydrateRuntime(): SyncRuntimeStatus {
  if (!runtimeHydrated) {
    runtimeHydrated = true;
    const st = getSyncState();
    runtime = {
      ...runtime, lastSyncAt: st.lastSyncAt, lastError: st.lastError, authFailed: st.authFailed,
      newerFormat: st.newerFormat, dirty: st.dirty, backoffUntil: st.backoffUntil,
    };
  }
  return runtime;
}

function refreshRuntime(patch: Partial<SyncRuntimeStatus> = {}): void {
  const st = getSyncState();
  runtimeHydrated = true;
  runtime = {
    ...runtime, lastSyncAt: st.lastSyncAt, lastError: st.lastError, authFailed: st.authFailed,
    newerFormat: st.newerFormat, dirty: st.dirty, backoffUntil: st.backoffUntil, ...patch,
  };
  statusListeners.forEach(fn => { try { fn(); } catch { /* isolate */ } });
}

function notifySyncApplied(): void { appliedListeners.forEach(fn => { try { fn(); } catch { /* isolate */ } }); }
registerOfflineAppliedHook(notifySyncApplied);

export const getSyncRuntimeStatus = (): SyncRuntimeStatus => hydrateRuntime();
export const subscribeSyncStatus = (fn: () => void): (() => void) => { hydrateRuntime(); statusListeners.add(fn); return () => { statusListeners.delete(fn); }; };
export const subscribeSyncApplied = (fn: () => void): (() => void) => { appliedListeners.add(fn); return () => { appliedListeners.delete(fn); }; };

/** Register into `utils/clips.ts` (`registerExtraKeptClips`) to prevent sweeping pending or unpacking clips. */
export function createSyncExtraKeptClipsProvider(): () => Promise<string[] | null> {
  return async () => (isClipsUnpacking() ? null : pendingClipsList());
}

/** Validate WebDAV settings, test remote access & create folders, then enable sync (resetting state on target change). */
export async function testAndEnableSync(cfg: WebDavConfig): Promise<WebDavTestResult> {
  if (!isSafeWebDavUrl(cfg.url)) throw new Error('sync:insecure_url');
  const res = await syncWebdavTest(cfg);
  const prevCfg = getSyncConfig();
  const prevState = getSyncState();
  const nextKey = webDavTargetKey(cfg);
  const prevKey = prevState.targetKey || (prevCfg.url.trim() ? webDavTargetKey(prevCfg) : '');
  const targetChanged = !!prevKey && prevKey !== nextKey;

  configEpoch++;
  saveSyncConfig({ ...cfg, enabled: true });
  saveSyncState(targetChanged
    ? { ...createFreshSyncState(nextKey), dirty: true, ...(prevState.settingAt ? { settingAt: prevState.settingAt } : {}) }
    : { ...prevState, targetKey: nextKey, authFailed: false, failCount: 0, backoffUntil: 0, lastError: null });
  peerCache.clear();
  refreshRuntime({ pendingAlert: null });
  return res;
}

/** Turn off WebDAV auto-sync while keeping saved credentials for easy re-enabling. */
export function disableSync(): void {
  configEpoch++;
  saveSyncConfig({ ...getSyncConfig(), enabled: false });
  saveSyncState({ ...getSyncState(), authFailed: false, failCount: 0, backoffUntil: 0, lastError: null });
  refreshRuntime({ syncing: false, phase: 'idle', pendingAlert: null, lastError: null });
}

async function pullPeers(cfg: WebDavConfig, targetKey: string, entries: RemoteEntry[], useCache: boolean) {
  const nextPeerEtags: Record<string, string> = {}, peers: DeviceSnapshot[] = [];
  for (const entry of entries) {
    const cacheKey = `${targetKey}|${entry.name}`;
    const cached = peerCache.get(cacheKey);
    if (useCache && !!entry.etag && cached?.etag === entry.etag) {
      peers.push(cached.snap); nextPeerEtags[entry.name] = entry.etag; continue;
    }
    try {
      const snap = parsePeerSnapshot(await syncWebdavGetGz(cfg, `devices/${entry.name}`));
      if (!snap) continue;
      peers.push(snap);
      if (entry.etag) { nextPeerEtags[entry.name] = entry.etag; peerCache.set(cacheKey, { etag: entry.etag, snap }); }
    } catch (e) {
      if (isFatalSyncErr(e)) throw e;
      if (!errStr(e).startsWith('sync:corrupt:')) console.warn('sync: skipping peer', entry.name, errStr(e));
    }
  }
  return { peers, nextPeerEtags };
}

async function syncLightCaches(cfg: WebDavConfig, liveVideoIds: Set<string>, uploadedCaches: Set<string>): Promise<void> {
  for (const vid of liveVideoIds) {
    for (const kind of SYNC_CACHE_KINDS) {
      const key = `${vid}.${kind}`;
      if (uploadedCaches.has(key)) continue;
      const text = await readCacheText(vid, kind).catch(() => null);
      if (!text) continue;
      if (utf8Len(text) > MAX_CACHE_BYTES) { uploadedCaches.add(key); continue; }
      try { await syncWebdavPutGz(cfg, `caches/${key}.json.gz`, text); uploadedCaches.add(key); }
      catch (e) { if (isFatalSyncErr(e)) throw e; }
    }
  }
  let remoteCaches: RemoteEntry[];
  try { remoteCaches = await syncWebdavList(cfg, 'caches'); } catch (e) { if (isFatalSyncErr(e)) throw e; return; }
  for (const entry of remoteCaches) {
    if (!entry.name.endsWith('.json.gz') || (entry.size && entry.size > MAX_CACHE_BYTES)) continue;
    const stem = entry.name.slice(0, -8), dot = stem.lastIndexOf('.');
    if (dot <= 0) continue;
    const vid = stem.slice(0, dot), kind = stem.slice(dot + 1);
    if (!liveVideoIds.has(vid) || !SYNC_CACHE_KIND_SET.has(kind)) continue;
    const k = kind as typeof SYNC_CACHE_KINDS[number];
    if (await readCacheText(vid, k).catch(() => null)) { uploadedCaches.add(`${vid}.${kind}`); continue; }
    try {
      const text = await syncWebdavGetGz(cfg, `caches/${entry.name}`);
      if (utf8Len(text) <= MAX_CACHE_BYTES) { await writeCacheText(vid, k, text); uploadedCaches.add(`${vid}.${kind}`); }
    } catch (e) { if (isFatalSyncErr(e)) throw e; }
  }
}

async function syncL2Clips(
  cfg: WebDavConfig, devId: string, state: SyncState, localClipFiles: string[],
  neededClips: NeededClip[], cardMap: Map<string, ReviewCard>, clipsRuntime?: SyncClipsRuntime,
) {
  const uploadedClips = { ...state.uploadedClips };
  const clipPacks: Record<string, string[]> = Object.fromEntries(Object.entries(state.clipPacks).map(([k, v]) => [k, [...v]]));
  let clipPackSeq = state.clipPackSeq, clipsUploaded = 0, clipsDownloaded = 0;
  if (!cfg.syncClips || !(await syncClipNetworkOk(cfg.wifiOnlyClips).catch(() => false))) {
    return { uploadedClips, clipPacks, clipPackSeq, clipsUploaded, clipsDownloaded };
  }

  let remaining = localClipFiles.filter(f => !uploadedClips[f]);
  while (remaining.length > 0) {
    const nextSeq = clipPackSeq + 1, packName = `${devId}-${nextSeq}.zip`;
    const packed = await syncUploadClipPack(cfg, `clip-packs/${packName}`, remaining);
    if (packed.length === 0) break;
    clipPackSeq = nextSeq; clipPacks[packName] = packed;
    const packedSet = new Set(packed);
    for (const f of packed) uploadedClips[f] = packName;
    clipsUploaded += packed.length;
    remaining = remaining.filter(f => !packedSet.has(f));
  }

  const withPack = neededClips.filter(x => !!x.packName);
  const downloadable = await filterDownloadableClips(withPack, cardMap, clipsRuntime?.findVideo);
  if (clipsRuntime?.findVideo && downloadable.length < withPack.length) {
    const dlIds = new Set(downloadable.map(x => x.cardId));
    const localPlayableIds = withPack.filter(x => !dlIds.has(x.cardId)).map(x => x.cardId);
    if (localPlayableIds.length > 0) await clearPendingClips(localPlayableIds).catch(() => {});
  }
  const byPack = new Map<string, NeededClip[]>();
  for (const item of downloadable) byPack.set(item.packName!, [...(byPack.get(item.packName!) ?? []), item]);
  if (byPack.size > 0) {
    await withClipsUnpacking(async () => {
      for (const [packName, items] of byPack) {
        let extracted: string[];
        try { extracted = await syncDownloadClipPack(cfg, `clip-packs/${packName}`, clipWantedNames(items)); }
        catch (e) { if (isFatalSyncErr(e)) throw e; continue; }
        clipsDownloaded += await mountExtractedClips(items, extracted, clipsRuntime?.setClip);
      }
    });
  }
  return { uploadedClips, clipPacks, clipPackSeq, clipsUploaded, clipsDownloaded };
}

async function runWebDavSyncInner(opts: SyncRunOptions): Promise<SyncRunResult> {
  const nowFn = opts.now ?? (() => Date.now());
  if (!syncWebdavSupported()) return { status: 'skipped', reason: 'unsupported' };
  const cfg = getSyncConfig();
  if (!cfg.enabled) return { status: 'skipped', reason: 'disabled' };

  const targetKey = webDavTargetKey(cfg);
  let state = getSyncState();
  if (state.targetKey && state.targetKey !== targetKey) {
    state = { ...createFreshSyncState(targetKey), dirty: true, ...(state.settingAt ? { settingAt: state.settingAt } : {}) };
    saveSyncState(state);
    peerCache.clear();
  }
  const isManual = !!opts.manual || !!opts.confirmSafety;
  if (!isManual) {
    if (opts.isBusy?.()) return { status: 'skipped', reason: 'busy' };
    if (state.authFailed) return { status: 'skipped', reason: 'auth_failed' };
    if (state.backoffUntil > nowFn()) return { status: 'skipped', reason: 'backoff' };
  }

  const devId = getSyncDeviceId(), ownFile = `${devId}.json.gz`;
  const startGen = getSyncDirtyGen(), startEpoch = configEpoch;
  refreshRuntime({ syncing: true, phase: 'pulling', lastError: null });

  try {
    const entries = await syncWebdavList(cfg, 'devices');
    const remoteHasOwn = entries.some(e => e.name === ownFile);
    const peerEntries = entries.filter(e => e.name !== ownFile && e.name.endsWith('.json.gz'));
    const hasDownloadableClips = cfg.syncClips
      && (await syncClipNetworkOk(cfg.wifiOnlyClips).catch(() => false))
      && (await downloadablePendingClipsList().catch(() => [])).length > 0;
    const unchanged = state.initialized && !state.dirty && !isManual && remoteHasOwn && !hasDownloadableClips &&
      peerEntries.length === Object.keys(state.peerEtags).length &&
      peerEntries.every(e => !!e.etag && state.peerEtags[e.name] === e.etag);
    if (unchanged) {
      saveSyncState({ ...state, targetKey, dirty: getSyncDirtyGen() !== startGen, lastSyncAt: nowFn(), failCount: 0, backoffUntil: 0, lastError: null });
      refreshRuntime({ syncing: false, phase: 'idle' });
      return { status: 'ok', uploaded: false, clipsDownloaded: 0, clipsUploaded: 0, newerFormat: state.newerFormat, summary: ZERO_SUMMARY };
    }

    const { peers, nextPeerEtags } = await pullPeers(cfg, targetKey, peerEntries, !isManual && state.initialized);
    refreshRuntime({ phase: 'merging' });
    const mergeNow = nowFn();
    let syncedGen = getSyncDirtyGen();
    const localBundle = await buildLocalSnapshot({
      platform: opts.platform, ownDir: opts.ownDir, clipPacks: state.clipPacks, lastMergedAt: state.lastMergedAt, now: mergeNow,
    });
    const mergeOpts = {
      localPlatform: opts.platform, localOwnDir: opts.ownDir, now: mergeNow,
      initialized: state.initialized, lastSyncAt: state.lastSyncAt,
      subtitles: localBundle.subsByHash, localSubHashes: Object.keys(localBundle.subsByHash), localClipFiles: localBundle.localClipFiles,
    };
    let result = mergeSnapshots(localBundle.snapshot, peers, mergeOpts);

    if (result.safetyAlert && !opts.confirmSafety) {
      refreshRuntime({ syncing: false, phase: 'idle', pendingAlert: result.safetyAlert });
      return { status: 'needs_confirm', alert: result.safetyAlert };
    }
    refreshRuntime({ pendingAlert: null });

    if (result.safetyAlert || (!state.initialized && peers.length > 0)) {
      try { await opts.savePreSnapshot(); } catch (e) { throw new Error(`sync:pre_failed:${errStr(e)}`); }
    }

    const downloadedSubs: Record<string, string> = { ...localBundle.subsByHash };
    for (const hash of result.neededSubs) {
      try { downloadedSubs[hash] = await syncWebdavGetGz(cfg, `subs/${hash}.srt.gz`); }
      catch (e) { if (isFatalSyncErr(e)) throw e; console.warn('sync: missing subtitle', hash, errStr(e)); }
    }

    // Never execute a rekey when the winning remote record's subtitle failed to download.
    result = remergeWithoutUnreadyRekeys(localBundle, peers, result, downloadedSubs, mergeOpts);

    // Abort cleanly if the user switched WebDAV target or disabled sync while pulling.
    if (configEpoch !== startEpoch) {
      refreshRuntime({ syncing: false, phase: 'idle' });
      return { status: 'skipped', reason: 'disabled' };
    }

    await withRestoreLock(() => applyMergeToLocal({
      result, downloadedSubs, platform: opts.platform, localOwnDir: opts.ownDir,
      candidatePathExists: opts.pathExists, rekeyFiles: syncRekeyFiles, onWatchPosUpdated: opts.onWatchPosUpdated,
    }));

    refreshRuntime({ phase: 'pushing' });
    const uploadedSubs = new Set(state.uploadedSubs);
    const uploadMissingSubs = async (subs: Record<string, string>) => {
      for (const [hash, srt] of Object.entries(subs)) {
        if (!hash || !srt || uploadedSubs.has(hash)) continue;
        await syncWebdavPutGz(cfg, `subs/${hash}.srt.gz`, srt);
        uploadedSubs.add(hash);
      }
    };
    await uploadMissingSubs(localBundle.subsByHash);
    const uploadedCaches = new Set(state.uploadedCaches);
    await syncLightCaches(cfg, new Set(result.snapshot.videos.map(v => v.id)), uploadedCaches);

    refreshRuntime({ phase: 'clips' });
    const clipRes = await syncL2Clips(
      cfg, devId, state, localBundle.localClipFiles, result.neededClips,
      new Map(result.snapshot.cards.map(c => [c.id, c])), opts.clipsRuntime,
    );

    refreshRuntime({ phase: 'pushing' });
    const syncAt = nowFn();
    syncedGen = getSyncDirtyGen();
    const freshBundle = await buildLocalSnapshot({
      platform: opts.platform, ownDir: opts.ownDir, clipPacks: clipRes.clipPacks, lastMergedAt: syncAt, now: syncAt,
    });
    const freshHash = snapshotContentHash(freshBundle.snapshot);
    const changed = summaryChanged(result.summary);
    const needPush = !state.initialized || state.dirty || changed || !remoteHasOwn ||
      result.rekeys.length > 0 || clipRes.clipsUploaded > 0 || clipRes.clipsDownloaded > 0 ||
      freshHash !== state.lastPublishedHash;
    if (configEpoch !== startEpoch) {
      refreshRuntime({ syncing: false, phase: 'idle' });
      return { status: 'skipped', reason: 'disabled' };
    }
    if (needPush) {
      // Ensure any new video added mid-sync also has its subtitle uploaded before publishing own snapshot.
      await uploadMissingSubs(freshBundle.subsByHash);
      await syncWebdavPutGz(cfg, `devices/${ownFile}`, JSON.stringify(freshBundle.snapshot));
    }
    if (configEpoch !== startEpoch) {
      refreshRuntime({ syncing: false, phase: 'idle' });
      return { status: 'skipped', reason: 'disabled' };
    }

    const latestSettingAt = getSyncState().settingAt;
    const compatiblePeers = peers.filter(p => p.v <= SYNC_FORMAT);
    const allPeersUnusable = peerEntries.length > 0 && compatiblePeers.length === 0;
    const hasUnuploadedNewClips = cfg.syncClips && freshBundle.localClipFiles.some(f => !clipRes.uploadedClips[f]);
    const stillDirty = getSyncDirtyGen() !== syncedGen || hasUnuploadedNewClips;
    saveSyncState({
      initialized: state.initialized || !allPeersUnusable,
      dirty: stillDirty,
      lastSyncAt: syncAt, lastMergedAt: syncAt, targetKey,
      lastPublishedHash: needPush ? freshHash : state.lastPublishedHash,
      peerEtags: nextPeerEtags, uploadedSubs: [...uploadedSubs], uploadedCaches: [...uploadedCaches],
      uploadedClips: clipRes.uploadedClips, clipPackSeq: clipRes.clipPackSeq, clipPacks: clipRes.clipPacks,
      authFailed: false, failCount: 0, backoffUntil: 0, newerFormat: result.newerFormat, lastError: null,
      ...(latestSettingAt ? { settingAt: latestSettingAt } : {}),
    });
    refreshRuntime({ syncing: false, phase: 'idle', pendingAlert: null });
    if (changed || !state.initialized || clipRes.clipsDownloaded > 0 || result.rekeys.length > 0) notifySyncApplied();
    return {
      status: 'ok', summary: result.summary, uploaded: needPush,
      clipsDownloaded: clipRes.clipsDownloaded, clipsUploaded: clipRes.clipsUploaded, newerFormat: result.newerFormat,
    };
  } catch (e) {
    if (configEpoch !== startEpoch) {
      refreshRuntime({ syncing: false, phase: 'idle' });
      return { status: 'skipped', reason: 'disabled' };
    }
    const msg = errStr(e), cur = getSyncState();
    if (isAuthErr(msg)) saveSyncState({ ...cur, targetKey, authFailed: true, lastError: 'sync:auth' });
    else if (isTransientErr(msg)) {
      const failCount = cur.failCount + 1, base = BACKOFF_MS[Math.min(failCount - 1, BACKOFF_MS.length - 1)];
      saveSyncState({ ...cur, targetKey, failCount, backoffUntil: nowFn() + Math.round(base * (1 + Math.random() * 0.15)), lastError: msg });
    } else saveSyncState({ ...cur, targetKey, lastError: msg });
    refreshRuntime({ syncing: false, phase: 'idle' });
    return { status: 'error', error: msg };
  }
}

/** Single-flight WebDAV sync entry point; strictly serializes manual runs and coalesces background triggers. */
export async function runWebDavSync(opts: SyncRunOptions): Promise<SyncRunResult> {
  if (inFlight && !opts.manual && !opts.confirmSafety) {
    queuedBgOpts = opts;
    return inFlight;
  }
  while (inFlight) await inFlight;
  const task = runWebDavSyncInner(opts).finally(() => {
    if (inFlight === task) inFlight = null;
    const follow = queuedBgOpts;
    queuedBgOpts = null;
    if (follow && getSyncState().dirty && !follow.isBusy?.()) {
      void runWebDavSync(follow);
    }
  });
  inFlight = task;
  return task;
}

const STARTUP_DELAY_MS = 3_000, MIN_FOREGROUND_GAP_MS = 60_000, DIRTY_DEBOUNCE_MS = 30_000, DIRTY_MAX_WAIT_MS = 300_000;

/** Start the silent background sync scheduler (startup +3s, visibility, 30s dirty debounce / 5m cap). */
export function startSyncScheduler(opts: Omit<SyncRunOptions, 'manual' | 'confirmSafety'>): SyncSchedulerHandle {
  const nowFn = opts.now ?? (() => Date.now());
  let stopped = false, dirtyTimer: ReturnType<typeof setTimeout> | null = null, firstDirtyAt = 0;
  const clearDirty = () => { if (dirtyTimer !== null) { clearTimeout(dirtyTimer); dirtyTimer = null; } firstDirtyAt = 0; };
  const scheduleDirty = () => {
    if (stopped) return;
    const now = nowFn();
    if (!firstDirtyAt) firstDirtyAt = now;
    if (dirtyTimer !== null) clearTimeout(dirtyTimer);
    dirtyTimer = setTimeout(() => { clearDirty(); void runBg(); }, Math.min(DIRTY_DEBOUNCE_MS, Math.max(0, DIRTY_MAX_WAIT_MS - (now - firstDirtyAt))));
  };
  const runBg = async (): Promise<SyncRunResult> => {
    if (stopped) return { status: 'skipped', reason: 'disabled' };
    const res = await runWebDavSync({ ...opts, manual: false });
    if (!stopped && res.status === 'ok' && getSyncState().dirty) scheduleDirty();
    return res;
  };
  const bootTimer = setTimeout(() => { void runBg(); }, STARTUP_DELAY_MS);

  const unsubDirty = subscribeSyncDirty(() => {
    if (stopped) return;
    refreshRuntime({ dirty: true });
    scheduleDirty();
  });

  const onVisibility = () => {
    if (stopped || typeof document === 'undefined') return;
    const st = getSyncState();
    if (document.visibilityState === 'hidden') { if (st.dirty) { clearDirty(); void runBg(); } }
    else if (document.visibilityState === 'visible' && nowFn() - st.lastSyncAt >= MIN_FOREGROUND_GAP_MS) void runBg();
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);

  return {
    stop() { stopped = true; clearTimeout(bootTimer); clearDirty(); unsubDirty(); if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility); },
    triggerNow() { clearDirty(); return runWebDavSync({ ...opts, manual: true }); },
    onLeavePractice() {
      const st = getSyncState();
      if (st.dirty || nowFn() - st.lastSyncAt >= MIN_FOREGROUND_GAP_MS) { clearDirty(); return runBg(); }
      return Promise.resolve({ status: 'skipped', reason: 'busy' });
    },
    confirmPending() { clearDirty(); return runWebDavSync({ ...opts, manual: true, confirmSafety: true }); },
    dismissPending() { refreshRuntime({ pendingAlert: null }); },
  };
}
