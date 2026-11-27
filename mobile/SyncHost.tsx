// Silent cross-device sync host for mobile (Android native WebDAV scheduler +
// shared offline-merge options for Android & iPhone PWA). Zero @tauri-apps/* or
// utils/clips.ts static imports so dist-mobile/ stays 100% PWA-safe (docs/sync.md).
import React, { useEffect, useRef } from 'react';
import type { t as tFn } from '../utils/i18n';
import { setClip } from '../utils/review';
import {
  getSyncRuntimeStatus,
  runWebDavSync,
  startSyncScheduler,
  type OfflineMergeOptions,
  type SyncClipsRuntime,
  type SyncRunResult,
  type SyncSchedulerHandle,
} from '../utils/syncEngine';
import { callAndroid, isAndroidNative } from './platform/androidBridge';
import * as desktop from './platform/desktop';
import { snapshot } from './restore';
import { getClipsRuntime } from './review/nativeRuntime';
import { putCopy } from './store';

type AndroidSyncDesktop = typeof desktop & {
  getAndroidPaths?: () => Promise<{ ownDir: string; mediaDir: string; clipsDir: string; tmpDir: string }>;
  pathExists?: (p: string) => Promise<boolean>;
};

const desktopApi = desktop as AndroidSyncDesktop;
const NATIVE_POS_TS_KEY = 'linguaclip_native_pos_ts';

let scheduler: SyncSchedulerHandle | null = null;
let currentBusy = false;
let ownDirPromise: Promise<string> | null = null;

function resolveOwnDir(): Promise<string> {
  if (!isAndroidNative() || !desktopApi.getAndroidPaths) return Promise.resolve('');
  return ownDirPromise ??= desktopApi.getAndroidPaths()
    .then(p => p.ownDir || '')
    .catch(() => {
      ownDirPromise = null;
      return '';
    });
}

async function savePreSnapshot(): Promise<void> {
  const snap = await snapshot();
  await putCopy('pre', snap);
}

async function onWatchPosUpdated(ids: string[]): Promise<void> {
  if (!isAndroidNative() || ids.length === 0) return;
  const last = await callAndroid<{ mediaId?: string }>('playback.getLastPos').catch(() => null);
  if (!last?.mediaId || !ids.includes(last.mediaId)) return;
  try {
    localStorage.setItem(NATIVE_POS_TS_KEY, String(Date.now()));
  } catch { /* ignore storage quota errors */ }
  if (!currentBusy) {
    await callAndroid('playback.clearLastPos').catch(() => {});
  }
}

const androidClipsRuntime: SyncClipsRuntime = {
  findVideo: async card => {
    const mod = await getClipsRuntime();
    return mod ? mod.findVideo(card) : null;
  },
  setClip,
};

/** Build shared sync/offline-merge runtime options for Android native or iPhone PWA. */
export async function getMobileSyncOpts(): Promise<OfflineMergeOptions> {
  const android = isAndroidNative();
  const ownDir = await resolveOwnDir();
  return {
    platform: android ? 'android' : 'pwa',
    ownDir,
    savePreSnapshot,
    onWatchPosUpdated: android ? onWatchPosUpdated : undefined,
    clipsRuntime: android ? androidClipsRuntime : undefined,
    pathExists: android && desktopApi.pathExists ? p => desktopApi.pathExists!(p) : undefined,
  };
}

/** Manually run a WebDAV sync pass (used by Settings → Sync). */
export async function triggerMobileSyncNow(): Promise<SyncRunResult> {
  if (scheduler) return scheduler.triggerNow();
  const opts = await getMobileSyncOpts();
  return runWebDavSync({ ...opts, manual: true, isBusy: () => currentBusy });
}

/** Confirm and execute a pending first-sync or mass-deletion merge. */
export async function confirmMobileSyncPending(): Promise<SyncRunResult> {
  if (scheduler) return scheduler.confirmPending();
  const opts = await getMobileSyncOpts();
  return runWebDavSync({ ...opts, manual: true, confirmSafety: true, isBusy: () => currentBusy });
}

/** Clear the pending safety confirmation banner/modal without merging. */
export function dismissMobileSyncPending(): void {
  if (scheduler) scheduler.dismissPending();
  else void getSyncRuntimeStatus();
}

/** Map internal `sync:*` error strings to user-facing localized copy. */
export function formatSyncError(err: unknown, tr: typeof tFn): string {
  const msg = (err instanceof Error ? err.message : String(err ?? '')).trim();
  if (!msg) return tr('sync.errGeneric', { why: 'unknown' });
  if (msg === 'sync:auth' || msg.startsWith('sync:auth:')) return tr('sync.errAuth');
  if (msg === 'sync:ratelimit') return tr('sync.errRateLimit');
  if (msg === 'sync:insecure_url') return tr('sync.errInsecure');
  if (msg === 'sync:newer_format') return tr('sync.newerFormat');
  if (msg === 'sync:audio_missing_src' || msg === 'audio:missing') return tr('sync.audioErrMissing');
  if (msg === 'sync:audio_too_large') return tr('sync.audioErrTooLarge');
  if (msg === 'sync:audio_no_track' || msg === 'extract:no audio track') return tr('sync.audioErrNoTrack');
  if (msg.startsWith('sync:pre_failed:')) {
    return tr('sync.preFailed', { why: msg.slice('sync:pre_failed:'.length).trim() || 'error' });
  }
  if (msg.startsWith('sync:network:')) {
    return tr('sync.errNetwork', { why: msg.slice('sync:network:'.length).trim() || 'offline' });
  }
  if (msg.startsWith('sync:corrupt:')) {
    return tr('sync.packBad', { why: msg.slice('sync:corrupt:'.length).trim() || 'corrupt' });
  }
  return tr('sync.errGeneric', { why: msg.replace(/^sync:/, '').slice(0, 140) });
}

export const SyncHost: React.FC<{ busy: boolean }> = ({ busy }) => {
  const prevBusyRef = useRef(busy);
  currentBusy = busy;

  useEffect(() => {
    if (!desktop.syncWebdavSupported()) return;
    let alive = true;
    let handle: SyncSchedulerHandle | null = null;
    void getMobileSyncOpts().then(opts => {
      if (!alive) return;
      handle = startSyncScheduler({
        ...opts,
        isBusy: () => currentBusy,
      });
      scheduler = handle;
    });
    return () => {
      alive = false;
      if (handle) {
        handle.stop();
        if (scheduler === handle) scheduler = null;
      }
    };
  }, []);

  useEffect(() => {
    const wasBusy = prevBusyRef.current;
    prevBusyRef.current = busy;
    if (wasBusy && !busy && scheduler) {
      void scheduler.onLeavePractice();
    }
  }, [busy]);

  return null;
};
