/**
 * Offline lossless merge packs (.zip for Desktop/Android, .json for iPhone PWA & cross-export),
 * sharing the exact same merge & apply engine as WebDAV sync (docs/sync.md).
 * Zero @tauri-apps/* imports (100% PWA-safe).
 */
import {
  pickSyncPackDest, shareSyncPackFile, syncReadMergePack, syncRekeyFiles,
  syncUnpackMergePack, syncWriteMergeJson, syncWriteMergePack,
} from './desktop';
import type { ReviewCard, setClip } from './review';
import {
  applyMergeToLocal, buildLocalSnapshot, filterDownloadableClips, mountExtractedClips,
  parsePeerSnapshot, remergeWithoutUnreadyRekeys, withClipsUnpacking, withRestoreLock,
} from './syncApply';
import { getSyncState } from './syncConfig';
import { mergeSnapshots } from './syncMerge';
import { notifySyncDirty } from './syncMeta';
import {
  SYNC_FORMAT, type DeviceSnapshot, type MergeSummary, type NeededClip,
  type SafetyAlert, type SyncPlatform,
} from './syncTypes';

const SYNC_PACK_JSON_FORMAT = 'linguaclip-sync-pack';

export interface SyncClipsRuntime { findVideo: (c: ReviewCard) => Promise<string | null>; setClip?: typeof setClip }

export interface OfflineMergeOptions {
  platform: SyncPlatform; ownDir: string;
  savePreSnapshot: () => Promise<void>;
  onWatchPosUpdated?: (ids: string[]) => Promise<void>;
  clipsRuntime?: SyncClipsRuntime;
  pathExists?: (p: string) => Promise<boolean>;
  now?: () => number;
}

export type PickedSyncPack = { kind: 'zip'; path: string; cleanup?: () => Promise<void> } | { kind: 'json'; text: string };

export interface OfflineMergePreview {
  peerPlatform: SyncPlatform; peerVideos: number; peerCards: number; localVideos: number; localCards: number;
  summary: MergeSummary; safetyAlert: SafetyAlert | null; newerFormat: boolean;
  apply: () => Promise<{ summary: MergeSummary; clipsUnpacked: number }>; cancel: () => Promise<void>;
}

const errStr = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const clipWantedNames = (items: NeededClip[]) =>
  [...new Set(items.flatMap(x => (x.clip.image ? [x.clip.file, x.clip.image] : [x.clip.file])))];

let onAppliedHook: (() => void) | null = null;
export function registerOfflineAppliedHook(fn: () => void): void { onAppliedHook = fn; }

/** Export an offline sync merge pack (Desktop/Android `.zip` or `.json` for iPhone PWA, PWA `.json`). */
export async function exportOfflineSyncPack(opts: {
  platform: SyncPlatform; ownDir: string; format?: 'zip' | 'json'; shareTitle?: string; dest?: string | null;
}): Promise<{ videos: number; cards: number; path?: string; json?: string } | null> {
  const now = Date.now(), state = getSyncState();
  const local = await buildLocalSnapshot({ platform: opts.platform, ownDir: opts.ownDir, clipPacks: state.clipPacks, lastMergedAt: state.lastMergedAt, now });
  const date = new Date(now).toLocaleDateString('sv-SE');
  const counts = { videos: local.snapshot.videos.length, cards: local.snapshot.cards.length };
  const fmt = opts.platform === 'pwa' ? 'json' : (opts.format ?? 'zip');

  if (fmt === 'json') {
    const json = JSON.stringify({ format: SYNC_PACK_JSON_FORMAT, v: SYNC_FORMAT, snapshot: local.snapshot, subs: local.subsByHash });
    const name = `LinguaClip-sync-${date}.json`;
    if (opts.platform === 'pwa') {
      if (typeof File !== 'undefined' && typeof document !== 'undefined') {
        const file = new File([json], name, { type: 'application/json' });
        if (typeof navigator !== 'undefined' && navigator.canShare?.({ files: [file] })) {
          try { await navigator.share({ files: [file], title: opts.shareTitle ?? name }); return { ...counts, json }; }
          catch (e) { if (e instanceof DOMException && e.name === 'AbortError') return null; }
        }
        const url = URL.createObjectURL(file), a = document.createElement('a');
        a.href = url; a.download = name; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
      return { ...counts, json };
    }
    let dest: string | null = opts.dest ?? null;
    if ((opts.platform === 'mac' || opts.platform === 'windows') && opts.dest === undefined) {
      dest = await pickSyncPackDest(name, 'json');
      if (!dest) return null;
    }
    const written = await syncWriteMergeJson(dest, json);
    if (opts.platform === 'android') await shareSyncPackFile(written, opts.shareTitle ?? 'LinguaClip Sync', 'application/json');
    return { ...counts, path: written, json };
  }

  let dest: string | null = opts.dest ?? null;
  if ((opts.platform === 'mac' || opts.platform === 'windows') && opts.dest === undefined) {
    dest = await pickSyncPackDest(`LinguaClip-sync-${date}.zip`, 'zip');
    if (!dest) return null;
  }
  const written = await syncWriteMergePack(dest, JSON.stringify(local.snapshot), Object.entries(local.subsByHash) as [string, string][], local.localClipFiles);
  if (opts.platform === 'android') await shareSyncPackFile(written, opts.shareTitle ?? 'LinguaClip Sync', 'application/zip');
  return { ...counts, path: written };
}

async function parseOfflinePack(picked: PickedSyncPack): Promise<{ peerSnap: DeviceSnapshot; packSubs: Record<string, string>; packClips: Set<string> }> {
  if (picked.kind === 'zip') {
    const content = await syncReadMergePack(picked.path), peerSnap = parsePeerSnapshot(content.snapshotJson);
    if (!peerSnap) throw new Error('sync:corrupt:snapshot');
    return { peerSnap, packSubs: Object.fromEntries(content.subs), packClips: new Set(content.clipNames) };
  }
  let raw: unknown;
  try { raw = JSON.parse(picked.text); } catch { throw new Error('sync:corrupt:json'); }
  const obj = raw as { format?: unknown; v?: unknown; snapshot?: unknown; subs?: unknown } | null;
  if (!obj || typeof obj !== 'object' || obj.format !== SYNC_PACK_JSON_FORMAT) throw new Error('sync:corrupt:format');
  if (typeof obj.v === 'number' && obj.v > SYNC_FORMAT) throw new Error('sync:newer_format');
  const peerSnap = parsePeerSnapshot(JSON.stringify(obj.snapshot));
  if (!peerSnap) throw new Error('sync:corrupt:snapshot');
  const packSubs: Record<string, string> = {};
  if (obj.subs && typeof obj.subs === 'object' && !Array.isArray(obj.subs)) {
    for (const [h, txt] of Object.entries(obj.subs as Record<string, unknown>)) if (typeof txt === 'string') packSubs[h] = txt;
  }
  return { peerSnap, packSubs, packClips: new Set<string>() };
}

/** Parse and dry-run an offline `.zip` or `.json` sync pack, re-merging fresh local state at apply time. */
export async function previewOfflineSyncPack(picked: PickedSyncPack, opts: OfflineMergeOptions): Promise<OfflineMergePreview> {
  const { peerSnap, packSubs, packClips } = await parseOfflinePack(picked);
  const nowFn = opts.now ?? (() => Date.now());
  const previewNow = nowFn(), state = getSyncState();
  const local = await buildLocalSnapshot({ platform: opts.platform, ownDir: opts.ownDir, clipPacks: state.clipPacks, lastMergedAt: state.lastMergedAt, now: previewNow });
  const previewRes = mergeSnapshots(local.snapshot, [peerSnap], {
    localPlatform: opts.platform, localOwnDir: opts.ownDir, now: previewNow, initialized: true, lastSyncAt: state.lastSyncAt,
    subtitles: { ...local.subsByHash, ...packSubs }, localSubHashes: Object.keys(local.subsByHash), localClipFiles: local.localClipFiles,
  });
  const cleanup = async () => { if (picked.kind === 'zip') await picked.cleanup?.().catch(() => {}); };

  return {
    peerPlatform: peerSnap.platform, peerVideos: peerSnap.videos.length, peerCards: peerSnap.cards.length,
    localVideos: local.snapshot.videos.length, localCards: local.snapshot.cards.length,
    summary: previewRes.summary, safetyAlert: previewRes.safetyAlert, newerFormat: previewRes.newerFormat, cancel: cleanup,
    apply: async () => {
      try {
        try { await opts.savePreSnapshot(); } catch (e) { throw new Error(`sync:pre_failed:${errStr(e)}`); }
        let appliedSummary = previewRes.summary;
        let appliedNeededClips = previewRes.neededClips;
        let appliedCards = previewRes.snapshot.cards;
        await withRestoreLock(async () => {
          const applyNow = nowFn(), stNow = getSyncState();
          const freshLocal = await buildLocalSnapshot({
            platform: opts.platform, ownDir: opts.ownDir, clipPacks: stNow.clipPacks, lastMergedAt: stNow.lastMergedAt, now: applyNow,
          });
          const mergeOpts = {
            localPlatform: opts.platform, localOwnDir: opts.ownDir, now: applyNow, initialized: true, lastSyncAt: stNow.lastSyncAt,
            subtitles: { ...freshLocal.subsByHash, ...packSubs }, localSubHashes: Object.keys(freshLocal.subsByHash), localClipFiles: freshLocal.localClipFiles,
          };
          const combinedSubs = { ...freshLocal.subsByHash, ...packSubs };
          const freshRes = remergeWithoutUnreadyRekeys(
            freshLocal, [peerSnap], mergeSnapshots(freshLocal.snapshot, [peerSnap], mergeOpts), combinedSubs, mergeOpts,
          );
          appliedSummary = freshRes.summary;
          appliedNeededClips = freshRes.neededClips;
          appliedCards = freshRes.snapshot.cards;
          await applyMergeToLocal({
            result: freshRes, downloadedSubs: combinedSubs, platform: opts.platform, localOwnDir: opts.ownDir,
            candidatePathExists: opts.pathExists, rekeyFiles: syncRekeyFiles, onWatchPosUpdated: opts.onWatchPosUpdated,
          });
        });
        notifySyncDirty();
        let clipsUnpacked = 0;
        if (picked.kind === 'zip' && appliedNeededClips.length > 0 && packClips.size > 0) {
          const cardMap = new Map(appliedCards.map(c => [c.id, c]));
          const toUnpack = await filterDownloadableClips(appliedNeededClips.filter(x => packClips.has(x.clip.file)), cardMap, opts.clipsRuntime?.findVideo);
          if (toUnpack.length > 0) {
            clipsUnpacked = await withClipsUnpacking(async () =>
              mountExtractedClips(toUnpack, await syncUnpackMergePack(picked.path, clipWantedNames(toUnpack)), opts.clipsRuntime?.setClip));
          }
        }
        onAppliedHook?.();
        return { summary: appliedSummary, clipsUnpacked };
      } finally { await cleanup(); }
    },
  };
}
