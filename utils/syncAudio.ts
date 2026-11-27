/**
 * Compressed speech audio relay between Desktop and Android (docs/sync.md, L2b):
 * unique offerId, serialized monthly auto budget accounting, desktop send / auto-queue,
 * Android Wi-Fi auto & manual download, delete-on-delivery cleanup, and reactive UI store.
 * Zero @tauri-apps/* or `utils/clips.ts` imports (100% PWA-safe).
 */
import type { VideoRecord } from '../types';
import {
  syncClipNetworkOk, syncDownloadAudio, syncUploadAudio, syncWebdavDelete,
  syncWebdavSupported, type UploadedSyncAudio,
} from './desktop';
import {
  getSyncConfig, getSyncDeviceId, getSyncState, saveSyncState, webDavTargetKey,
  type SyncState, type WebDavConfig,
} from './syncConfig';
import { notifySyncDirty } from './syncMeta';
import {
  AUDIO_OFFER_TTL_MS, AUTO_AUDIO_MONTHLY_BUDGET_BYTES,
  type MergeResult, type RemoteAudioOffer, type SyncAudioOffer, type SyncPlatform,
} from './syncTypes';
import { getVideoRecord, patchVideoRecord } from './videoStorage';

export interface MonthlyAudioUsage { ym: string; bytes: number; budgetBytes: number; remainingBytes: number; exceeded: boolean }
export interface DesktopVideoAudioState { status: 'sending' | 'pending' | 'delivered' | 'idle'; bytes?: number; error?: string | null }
export type SendAudioResult = { ok: true; offer: SyncAudioOffer } | { ok: false; reason: string };
type DownloadAudioResult = { ok: true; path: string } | { ok: false; reason: string };

export interface SyncAudioSnapshot {
  version: number; sendingIds: readonly string[]; downloadingIds: readonly string[];
  sendErrors: Readonly<Record<string, string>>; downloadErrors: Readonly<Record<string, string>>;
  audioOffers: Readonly<Record<string, SyncAudioOffer>>; remoteAudioOffers: Readonly<Record<string, RemoteAudioOffer>>;
  deliveredAudioIds: readonly string[]; audioAutoPending: readonly string[];
  audioMonthly: Readonly<{ ym: string; bytes: number }>; budgetNotice: boolean;
}

export interface SyncAudioPhaseArgs {
  cfg: WebDavConfig; devId: string; platform: SyncPlatform; targetKey: string; state: SyncState;
  result: MergeResult; localAudioHave: string[]; now: number;
  isAuthErr: (msg: string) => boolean; isStale: () => boolean;
}

export interface SyncAudioPhaseResult {
  audioOffers: Record<string, SyncAudioOffer>; remoteAudioOffers: Record<string, RemoteAudioOffer>;
  audioMonthly: { ym: string; bytes: number }; audioAutoPending: string[];
  deliveredAudioIds: string[]; audioAck: Record<string, string>;
  localAudioHave: string[]; changed: boolean; downloadedCount: number;
}

const MAX_SINGLE_AUDIO_BYTES = 100 * 1024 * 1024;
const listeners = new Set<() => void>();
const sendingMap = new Map<string, Promise<SendAudioResult>>();
const downloadingMap = new Map<string, Promise<DownloadAudioResult>>();
const sendErrors = new Map<string, string>(), downloadErrors = new Map<string, string>();
const badAutoDownloadKeys = new Set<string>();
let autoChain: Promise<unknown> = Promise.resolve();
let audioEpoch = 0, budgetNotice = false, snapVersion = 0, snapCache: SyncAudioSnapshot | null = null;
let onAppliedHook: (() => void) | null = null, triggerSyncHook: (() => void | Promise<unknown>) | null = null;

const errStr = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const offerKey = (o: Pick<RemoteAudioOffer, 'videoId' | 'file' | 'offerId'>): string => `${o.videoId}|${o.offerId ?? o.file}`;
const isPermanentDownloadErr = (m: string): boolean => m.startsWith('sync:corrupt:') || m.startsWith('sync:invalid_');
const isNotFoundErr = (m: string): boolean => m === 'sync:notfound' || m === 'sync:not_found' || m === 'sync:http:404' || /\b404\b/.test(m);
const isPermanentAudioErr = (m: string): boolean =>
  /^(?:sync:audio_(?:missing_src|too_large|no_track|encode:|probe:|empty|budget)|sync:invalid_path:|convertSetup:|audio:(?:missing|too_large|no_track)|missing:)/.test(m)
  || m === 'extract:no audio track';

function randomOfferId(): string {
  const bytes = new Uint8Array(6);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(bytes);
  else for (let i = 0; i < 6; i++) bytes[i] = Math.floor(Math.random() * 256);
  let hex = '';
  for (let i = 0; i < 6; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

function isStillSameTarget(startTargetKey: string): boolean {
  const cfg = getSyncConfig();
  return cfg.enabled && webDavTargetKey(cfg) === startTargetKey;
}

function enqueueAuto<T>(fn: () => Promise<T>): Promise<T> {
  const next = autoChain.then(fn, fn);
  autoChain = next.then(() => undefined, () => undefined);
  return next;
}

/** Register runtime hooks from `utils/syncEngine.ts` without introducing a circular import. */
export function registerAudioSyncHooks(hooks: { onApplied?: (() => void) | null; triggerSync?: (() => void | Promise<unknown>) | null }): void {
  if ('onApplied' in hooks) onAppliedHook = hooks.onApplied ?? null;
  if ('triggerSync' in hooks) triggerSyncHook = hooks.triggerSync ?? null;
}

function buildAudioSnapshot(): SyncAudioSnapshot {
  const st = getSyncState();
  if (!getSyncConfig().autoSyncAudio && budgetNotice) budgetNotice = false;
  return {
    version: ++snapVersion, sendingIds: [...sendingMap.keys()].sort(), downloadingIds: [...downloadingMap.keys()].sort(),
    sendErrors: Object.fromEntries(sendErrors), downloadErrors: Object.fromEntries(downloadErrors),
    audioOffers: { ...st.audioOffers }, remoteAudioOffers: { ...st.remoteAudioOffers },
    deliveredAudioIds: [...st.deliveredAudioIds], audioAutoPending: [...st.audioAutoPending],
    audioMonthly: { ...st.audioMonthly }, budgetNotice,
  };
}

export function notifyAudioStateChanged(): void {
  snapCache = buildAudioSnapshot();
  listeners.forEach(fn => { try { fn(); } catch { /* isolate */ } });
}
export function clearAudioBudgetNotice(): void {
  if (budgetNotice) { budgetNotice = false; notifyAudioStateChanged(); }
}
export function resetAudioRuntimeState(): void {
  audioEpoch++;
  sendErrors.clear(); downloadErrors.clear(); badAutoDownloadKeys.clear(); budgetNotice = false;
  notifyAudioStateChanged();
}
export const getSyncAudioSnapshot = (): SyncAudioSnapshot => (snapCache ??= buildAudioSnapshot());
export const subscribeSyncAudio = (fn: () => void): (() => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

export function currentYearMonth(now = Date.now()): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
export function getMonthlyAudioUsage(state: SyncState = getSyncState(), now = Date.now()): MonthlyAudioUsage {
  const ym = currentYearMonth(now), bytes = state.audioMonthly.ym === ym ? Math.max(0, state.audioMonthly.bytes) : 0;
  return { ym, bytes, budgetBytes: AUTO_AUDIO_MONTHLY_BUDGET_BYTES, remainingBytes: Math.max(0, AUTO_AUDIO_MONTHLY_BUDGET_BYTES - bytes), exceeded: bytes >= AUTO_AUDIO_MONTHLY_BUDGET_BYTES };
}
export function formatAudioMB(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  return mb < 0.1 ? '<0.1 MB' : mb < 10 ? `${mb.toFixed(1)} MB` : `${Math.round(mb)} MB`;
}

const addMonthlyBytes = (cur: SyncState['audioMonthly'], added: number, now = Date.now()) => {
  const ym = currentYearMonth(now);
  return { ym, bytes: (cur.ym === ym ? Math.max(0, cur.bytes) : 0) + Math.max(0, added) };
};

const toAudioOffer = (u: UploadedSyncAudio, fallback: string, createdAt: number, offerId: string): SyncAudioOffer => ({
  file: (u.file || fallback).replace(/^audio\//, ''), sha256: u.sha256, bytes: u.bytes, durSec: u.durSec, createdAt, offerId,
});

function dropPending(videoId: string, startTargetKey: string): void {
  if (!isStillSameTarget(startTargetKey)) return;
  const cur = getSyncState();
  if (cur.audioAutoPending.includes(videoId)) {
    saveSyncState({ ...cur, audioAutoPending: cur.audioAutoPending.filter(id => id !== videoId) });
  }
}

function dropRemoteOffer(videoId: string, startTargetKey: string, ackOfferId?: string): void {
  if (!isStillSameTarget(startTargetKey)) return;
  const cur = getSyncState();
  const hadOffer = videoId in cur.remoteAudioOffers;
  const needAck = !!ackOfferId && cur.audioAck[videoId] !== ackOfferId;
  if (!hadOffer && !needAck) return;
  const nextRemote = { ...cur.remoteAudioOffers };
  delete nextRemote[videoId];
  const nextAck = needAck ? { ...cur.audioAck, [videoId]: ackOfferId! } : cur.audioAck;
  saveSyncState({ ...cur, remoteAudioOffers: nextRemote, audioAck: nextAck });
}

/** Check whether expired offers, pending desktop auto-uploads, or Android auto-downloads should bypass `unchanged`. */
export async function hasPendingAudioWork(platform: SyncPlatform, cfg: WebDavConfig, state: SyncState, now: number): Promise<boolean> {
  if (platform === 'mac' || platform === 'windows') {
    if (Object.values(state.audioOffers).some(o => now - o.createdAt > AUDIO_OFFER_TTL_MS)) return true;
    return !!cfg.autoSyncAudio && state.audioAutoPending.length > 0 && !getMonthlyAudioUsage(state, now).exceeded;
  }
  return platform === 'android'
    && Object.values(state.remoteAudioOffers).some(o => !badAutoDownloadKeys.has(offerKey(o)))
    && await syncClipNetworkOk(cfg.wifiOnlyAudio ?? true).catch(() => false);
}

/** Scan completed non-podcast records on Android whose local absolute audio file exists on disk. */
export async function collectLocalAudioHave(
  platform: SyncPlatform, rawVideos: VideoRecord[], pathExists?: (p: string) => Promise<boolean>,
): Promise<string[]> {
  if (platform !== 'android') return [];
  const have: string[] = [];
  for (const r of rawVideos) {
    if (r.importJob || r.podcast || !r.videoPath?.startsWith('/')) continue;
    if (pathExists ? await pathExists(r.videoPath).catch(() => false) : true) have.push(r.id);
  }
  return [...new Set(have)].sort();
}

function runUploadTask(
  videoId: string,
  opts: { auto: boolean; devId: string; startTargetKey: string; now?: number; triggerSync: boolean; isStale?: () => boolean },
): Promise<SendAudioResult> {
  const inflight = sendingMap.get(videoId);
  if (inflight) return inflight;
  const startEpoch = audioEpoch;
  const aborted = () => audioEpoch !== startEpoch || !!opts.isStale?.() || !isStillSameTarget(opts.startTargetKey);
  const exec = async (): Promise<SendAudioResult> => {
    if (aborted()) return { ok: false, reason: 'target_changed' };
    if (!syncWebdavSupported()) return { ok: false, reason: 'unsupported' };
    const cfg = getSyncConfig();
    if (!cfg.enabled) return { ok: false, reason: 'disabled' };
    if (opts.auto && !cfg.autoSyncAudio) return { ok: false, reason: 'auto_disabled' };

    const rec = await getVideoRecord(videoId);
    if (aborted()) return { ok: false, reason: 'target_changed' };
    if (!rec || rec.importJob || rec.podcast || !rec.videoPath) {
      if (opts.auto) dropPending(videoId, opts.startTargetKey);
      return { ok: false, reason: !rec?.videoPath ? 'audio:missing' : 'ineligible' };
    }
    const now = opts.now ?? Date.now();
    let maxBytes: number | undefined;
    if (opts.auto) {
      const usage = getMonthlyAudioUsage(getSyncState(), now);
      if (usage.exceeded || usage.remainingBytes <= 0) {
        budgetNotice = true; dropPending(videoId, opts.startTargetKey); notifyAudioStateChanged();
        return { ok: false, reason: 'budget' };
      }
      maxBytes = Math.min(MAX_SINGLE_AUDIO_BYTES, usage.remainingBytes);
    }

    sendErrors.delete(videoId); notifyAudioStateChanged();
    const offerId = randomOfferId();
    const fileName = `${opts.devId}__${videoId}__${offerId}.m4a`;
    const uploaded = await syncUploadAudio(cfg, rec.videoPath, `audio/${fileName}`, maxBytes);
    if (aborted()) return { ok: false, reason: 'target_changed' };
    const ts = opts.now ?? Date.now();
    const offer = toAudioOffer(uploaded, fileName, ts, offerId);
    const cur = getSyncState();
    saveSyncState({
      ...cur,
      audioOffers: { ...cur.audioOffers, [videoId]: offer },
      audioMonthly: opts.auto ? addMonthlyBytes(cur.audioMonthly, offer.bytes, ts) : cur.audioMonthly,
      audioAutoPending: cur.audioAutoPending.filter(id => id !== videoId),
      deliveredAudioIds: cur.deliveredAudioIds.filter(id => id !== videoId),
      dirty: opts.triggerSync ? true : cur.dirty,
    });
    sendErrors.delete(videoId); notifyAudioStateChanged();
    if (opts.triggerSync) { notifySyncDirty(); Promise.resolve(triggerSyncHook?.()).catch(() => {}); }
    return { ok: true, offer };
  };
  const task = (opts.auto ? enqueueAuto(exec) : exec()).catch((e): SendAudioResult => {
    const reason = errStr(e);
    if (aborted()) return { ok: false, reason: 'target_changed' };
    if (!opts.auto) sendErrors.set(videoId, reason);
    else if (reason === 'sync:audio_budget') { budgetNotice = true; dropPending(videoId, opts.startTargetKey); }
    else if (isPermanentAudioErr(reason)) dropPending(videoId, opts.startTargetKey);
    notifyAudioStateChanged();
    return { ok: false, reason };
  }).finally(() => { sendingMap.delete(videoId); notifyAudioStateChanged(); });
  sendingMap.set(videoId, task); notifyAudioStateChanged();
  return task;
}

function runDownloadTask(
  offer: RemoteAudioOffer,
  opts: { startTargetKey: string; triggerSync: boolean; recordError: boolean; isStale?: () => boolean },
): Promise<DownloadAudioResult> {
  const videoId = offer.videoId;
  const inflight = downloadingMap.get(videoId);
  if (inflight) return inflight;
  const startEpoch = audioEpoch;
  const aborted = () => audioEpoch !== startEpoch || !!opts.isStale?.() || !isStillSameTarget(opts.startTargetKey);
  const task = (async (): Promise<DownloadAudioResult> => {
    if (aborted()) return { ok: false, reason: 'target_changed' };
    const cfg = getSyncConfig();
    if (!cfg.enabled) return { ok: false, reason: 'disabled' };
    downloadErrors.delete(videoId); notifyAudioStateChanged();
    const savedPath = await syncDownloadAudio(cfg, `audio/${offer.file}`, videoId, offer.sha256);
    if (aborted()) return { ok: false, reason: 'target_changed' };
    const liveRec = await getVideoRecord(videoId);
    if (!liveRec || liveRec.importJob || liveRec.podcast) return { ok: false, reason: 'deleted' };
    await patchVideoRecord(videoId, { videoPath: savedPath });
    if (aborted()) return { ok: false, reason: 'target_changed' };
    const cur = getSyncState(), nextRemote = { ...cur.remoteAudioOffers };
    delete nextRemote[videoId];
    const nextAck = offer.offerId ? { ...cur.audioAck, [videoId]: offer.offerId } : cur.audioAck;
    saveSyncState({ ...cur, remoteAudioOffers: nextRemote, audioAck: nextAck, dirty: opts.triggerSync ? true : cur.dirty });
    downloadErrors.delete(videoId); notifyAudioStateChanged();
    if (opts.triggerSync) { notifySyncDirty(); onAppliedHook?.(); Promise.resolve(triggerSyncHook?.()).catch(() => {}); }
    return { ok: true, path: savedPath };
  })().catch((e): DownloadAudioResult => {
    const reason = errStr(e);
    if (aborted()) return { ok: false, reason: 'target_changed' };
    if (opts.recordError) downloadErrors.set(videoId, reason);
    notifyAudioStateChanged();
    return { ok: false, reason };
  }).finally(() => { downloadingMap.delete(videoId); notifyAudioStateChanged(); });
  downloadingMap.set(videoId, task); notifyAudioStateChanged();
  return task;
}

/** Sync engine phase: clean up delivered/stale offers, flush auto-pending uploads, and auto-download on Android. */
export async function syncAudioPhase(args: SyncAudioPhaseArgs): Promise<SyncAudioPhaseResult> {
  const { cfg, devId, platform, targetKey, state, result, now, isAuthErr, isStale } = args;
  const aborted = () => isStale() || !isStillSameTarget(targetKey);
  const liveIds = new Set(result.snapshot.videos.map(v => v.id));
  const localHaveSet = new Set(args.localAudioHave.filter(id => liveIds.has(id)));
  let changed = false, downloadedCount = 0;

  if (!aborted()) {
    const cur = getSyncState();
    const nextRemote: Record<string, RemoteAudioOffer> = {};
    if (platform === 'android') {
      for (const o of result.availableAudioOffers) {
        if (!localHaveSet.has(o.videoId) && (!o.offerId || cur.audioAck[o.videoId] !== o.offerId)) nextRemote[o.videoId] = o;
      }
    }
    const nextAck: Record<string, string> = platform === 'android' ? { ...result.localAudioAck } : {};
    if (platform === 'android') {
      for (const [k, v] of Object.entries(cur.audioAck)) {
        if (!(k in state.audioAck) && !(k in nextAck)) nextAck[k] = v;
      }
    }
    const nextDelivered = result.deliveredAudioIds.filter(id => !cur.audioOffers[id]);
    saveSyncState({ ...cur, remoteAudioOffers: nextRemote, audioAck: nextAck, deliveredAudioIds: nextDelivered });
  }

  try {
    for (const vid of result.staleAudioVideoIds) {
      if (aborted()) break;
      const cur = getSyncState(), offer = cur.audioOffers[vid], orig = state.audioOffers[vid];
      if (!offer || (orig && (offer.offerId !== orig.offerId || offer.createdAt > orig.createdAt))) continue;
      try { await syncWebdavDelete(cfg, `audio/${offer.file}`); }
      catch (e) {
        const m = errStr(e);
        if (!isNotFoundErr(m)) { if (isAuthErr(m)) throw e; console.warn('sync: audio delete failed', vid, m); break; }
      }
      if (aborted()) break;
      const latest = getSyncState();
      if (latest.audioOffers[vid]?.file === offer.file) {
        const nextOffers = { ...latest.audioOffers };
        delete nextOffers[vid];
        const nextDelivered = result.deliveredAudioIds.filter(id => !nextOffers[id]);
        saveSyncState({ ...latest, audioOffers: nextOffers, deliveredAudioIds: nextDelivered });
        changed = true;
      }
    }

    if (!aborted() && (platform === 'mac' || platform === 'windows') && cfg.autoSyncAudio) {
      const pending = [...new Set([...state.audioAutoPending, ...getSyncState().audioAutoPending])];
      for (const vid of pending) {
        if (aborted()) break;
        if (sendingMap.has(vid)) continue;
        const cur = getSyncState();
        if (cur.audioOffers[vid] || !liveIds.has(vid)) { dropPending(vid, targetKey); continue; }
        const res = await runUploadTask(vid, { auto: true, devId, startTargetKey: targetKey, now, triggerSync: false, isStale });
        if (!('reason' in res)) { changed = true; continue; }
        const { reason } = res;
        if (isAuthErr(reason)) throw new Error(reason);
        if (reason === 'budget' || reason === 'sync:audio_budget' || reason === 'target_changed' ||
          reason === 'disabled' || reason === 'auto_disabled') break;
        if (isPermanentAudioErr(reason)) { console.warn('sync: auto audio upload skipped', vid, reason); continue; }
        console.warn('sync: auto audio upload failed', vid, reason);
        break;
      }
    }

    if (!aborted() && platform === 'android') {
      const pendingOffers = Object.values(getSyncState().remoteAudioOffers);
      if (pendingOffers.length > 0 && await syncClipNetworkOk(cfg.wifiOnlyAudio ?? true).catch(() => false)) {
        for (const offer of pendingOffers) {
          if (aborted()) break;
          if (downloadingMap.has(offer.videoId) || badAutoDownloadKeys.has(offerKey(offer))) continue;
          if (localHaveSet.has(offer.videoId)) { dropRemoteOffer(offer.videoId, targetKey, offer.offerId); continue; }
          const rec = await getVideoRecord(offer.videoId);
          if (!rec || rec.importJob || rec.podcast) { dropRemoteOffer(offer.videoId, targetKey); continue; }
          const res = await runDownloadTask(offer, { startTargetKey: targetKey, triggerSync: false, recordError: false, isStale });
          if (!('reason' in res)) { localHaveSet.add(offer.videoId); downloadedCount++; changed = true; continue; }
          const { reason } = res;
          if (isAuthErr(reason)) throw new Error(reason);
          if (reason === 'target_changed' || reason === 'disabled') break;
          if (isNotFoundErr(reason) || reason === 'deleted') { dropRemoteOffer(offer.videoId, targetKey); continue; }
          if (isPermanentDownloadErr(reason)) {
            badAutoDownloadKeys.add(offerKey(offer));
            console.warn('sync: skipping corrupt audio offer', offer.videoId, reason);
            continue;
          }
          console.warn('sync: audio download failed', offer.videoId, reason);
          break;
        }
      }
    }
  } finally {
    if (!aborted()) notifyAudioStateChanged();
  }

  const st = getSyncState();
  return {
    audioOffers: st.audioOffers, remoteAudioOffers: st.remoteAudioOffers, audioMonthly: st.audioMonthly,
    audioAutoPending: st.audioAutoPending, deliveredAudioIds: st.deliveredAudioIds, audioAck: st.audioAck,
    localAudioHave: [...localHaveSet].sort(), changed, downloadedCount,
  };
}

export function getDesktopVideoAudioState(videoId: string): DesktopVideoAudioState {
  if (sendingMap.has(videoId)) return { status: 'sending', error: null };
  const st = getSyncState(), err = sendErrors.get(videoId) ?? null;
  if (st.audioOffers[videoId]) return { status: 'pending', bytes: st.audioOffers[videoId].bytes, error: err };
  return { status: st.deliveredAudioIds.includes(videoId) ? 'delivered' : 'idle', error: err };
}

/** Compress & upload a desktop video's speech audio to WebDAV and trigger a lightweight snapshot push. */
export function sendVideoAudioToPhone(videoId: string, opts?: { auto?: boolean }): Promise<SendAudioResult> {
  const inflight = sendingMap.get(videoId);
  if (inflight) return inflight;
  if (!syncWebdavSupported()) return Promise.resolve({ ok: false, reason: 'unsupported' });
  const cfg = getSyncConfig();
  if (!cfg.enabled) return Promise.resolve({ ok: false, reason: 'disabled' });
  if (opts?.auto && !cfg.autoSyncAudio) return Promise.resolve({ ok: false, reason: 'auto_disabled' });
  return runUploadTask(videoId, { auto: !!opts?.auto, devId: getSyncDeviceId(), startTargetKey: webDavTargetKey(cfg), triggerSync: true });
}

/** Called when a desktop import finishes: enqueue & start non-blocking auto audio upload if enabled. */
export function maybeQueueAutoAudioSync(record: Pick<VideoRecord, 'id' | 'podcast' | 'videoPath'>): void {
  if (!syncWebdavSupported() || record.podcast || !record.videoPath) return;
  const cfg = getSyncConfig();
  if (!cfg.enabled || !cfg.autoSyncAudio) return;
  const cur = getSyncState();
  if (getMonthlyAudioUsage(cur).exceeded) { budgetNotice = true; notifyAudioStateChanged(); return; }
  if (!cur.audioAutoPending.includes(record.id)) {
    saveSyncState({ ...cur, audioAutoPending: [...cur.audioAutoPending, record.id] });
    notifyAudioStateChanged();
  }
  void sendVideoAudioToPhone(record.id, { auto: true });
}

export const getRemoteAudioOffer = (videoId: string): RemoteAudioOffer | null => getSyncState().remoteAudioOffers[videoId] ?? null;
export const getPhoneAudioDownloadState = (videoId: string): { downloading: boolean; error: string | null } => ({
  downloading: downloadingMap.has(videoId), error: downloadErrors.get(videoId) ?? null,
});

/** On-demand Android download of a desktop-offered speech audio file, unlocking full study modes immediately. */
export function downloadRemoteAudioNow(videoId: string): Promise<string | null> {
  const inflight = downloadingMap.get(videoId);
  if (inflight) return inflight.then(r => (r.ok ? r.path : null));
  const cfg = getSyncConfig(), offer = getSyncState().remoteAudioOffers[videoId];
  if (!cfg.enabled || !offer) return Promise.resolve(null);
  badAutoDownloadKeys.delete(offerKey(offer));
  return runDownloadTask(offer, { startTargetKey: webDavTargetKey(cfg), triggerSync: true, recordError: true })
    .then(r => (r.ok ? r.path : null));
}
