import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { X } from 'lucide-react';
import { Btn } from './ui';
import { dialog } from './Dialog';
import { SyncConfirmModal } from './SyncPairModal';
import { ownDir, pathExists } from '../utils/desktop';
import { IS_WINDOWS } from '../utils/platform';
import { saveBackup } from '../utils/backupData';
import { findVideo, registerExtraKeptClips } from '../utils/clips';
import { setClip } from '../utils/review';
import { useT, type t as tr } from '../utils/i18n';
import {
  createSyncExtraKeptClipsProvider, getSyncRuntimeStatus, runWebDavSync, startSyncScheduler,
  subscribeSyncStatus, type OfflineMergeOptions, type SyncRunResult, type SyncSchedulerHandle,
} from '../utils/syncEngine';

// Prevent clip sweeps while sync is unpacking or holding pending clips.
registerExtraKeptClips(createSyncExtraKeptClipsProvider());

let cachedOwnDir: string | null = null;
let ownDirTask: Promise<string> | null = null;
let activeHandle: SyncSchedulerHandle | null = null;
let desktopBusy = false;
let extraBusyCount = 0;
const extraBusyListeners = new Set<() => void>();
let confirmOpener: (() => void) | null = null;

const isDesktopBusy = (): boolean => desktopBusy || extraBusyCount > 0;

/** Mark a modal learning flow (e.g. ReviewSession) as busy so sync never interrupts it. */
export function registerSyncBusyScope(): () => void {
  extraBusyCount++;
  extraBusyListeners.forEach(fn => fn());
  let released = false;
  return () => {
    if (released) return;
    released = true;
    extraBusyCount = Math.max(0, extraBusyCount - 1);
    extraBusyListeners.forEach(fn => fn());
  };
}

async function resolveOwnDir(): Promise<string> {
  if (cachedOwnDir !== null) return cachedOwnDir;
  ownDirTask ??= ownDir().catch(() => '').then(dir => { cachedOwnDir = dir; return dir; });
  return ownDirTask;
}

export async function getDesktopSyncOpts(): Promise<OfflineMergeOptions> {
  return {
    platform: IS_WINDOWS ? 'windows' : 'mac',
    ownDir: await resolveOwnDir(),
    savePreSnapshot: async () => { await saveBackup('pre'); },
    clipsRuntime: { findVideo, setClip },
    pathExists,
  };
}

export async function triggerDesktopSyncNow(): Promise<SyncRunResult> {
  if (activeHandle) return activeHandle.triggerNow();
  const opts = await getDesktopSyncOpts();
  return runWebDavSync({ ...opts, manual: true, isBusy: isDesktopBusy });
}

export async function confirmDesktopSyncPending(): Promise<SyncRunResult> {
  if (activeHandle) return activeHandle.confirmPending();
  const opts = await getDesktopSyncOpts();
  return runWebDavSync({ ...opts, manual: true, confirmSafety: true, isBusy: isDesktopBusy });
}

export function dismissDesktopSyncPending(): void {
  activeHandle?.dismissPending();
}

export function openDesktopSyncConfirm(): void {
  confirmOpener?.();
}

export function formatSyncError(err: string, translate: typeof tr): string {
  if (err === 'sync:auth' || err.startsWith('sync:auth:')) return translate('sync.errAuth');
  if (err === 'sync:ratelimit') return translate('sync.errRateLimit');
  if (err === 'sync:insecure_url') return translate('sync.errInsecure');
  if (err === 'sync:newer_format') return translate('sync.newerFormat');
  if (err === 'sync:audio_missing_src' || err === 'audio:missing') return translate('sync.audioErrMissing');
  if (err === 'sync:audio_too_large') return translate('sync.audioErrTooLarge');
  if (err === 'sync:audio_no_track' || err === 'extract:no audio track') return translate('sync.audioErrNoTrack');
  if (err.startsWith('sync:network:')) return translate('sync.errNetwork', { why: err.slice('sync:network:'.length) || err });
  if (err.startsWith('sync:pre_failed:')) return translate('sync.preFailed', { why: err.slice('sync:pre_failed:'.length) || err });
  if (err.startsWith('sync:corrupt:')) return translate('sync.packBad', { why: err.slice('sync:corrupt:'.length) || err });
  return translate('sync.errGeneric', { why: err });
}

// Mounts once in App.tsx: runs silent background sync, triggers on leaving practice,
// and hosts the safety-confirmation modal without ever interrupting active practice.
const SyncHost: React.FC<{ busy: boolean }> = ({ busy }) => {
  const t = useT();
  const status = useSyncExternalStore(subscribeSyncStatus, getSyncRuntimeStatus);
  const [extraBusy, setExtraBusy] = useState(() => extraBusyCount > 0);
  const effectiveBusy = busy || extraBusy;
  const prevBusy = useRef(effectiveBusy);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [bannerHidden, setBannerHidden] = useState(false);

  desktopBusy = busy;

  useEffect(() => {
    const syncExtra = () => setExtraBusy(extraBusyCount > 0);
    extraBusyListeners.add(syncExtra);
    return () => { extraBusyListeners.delete(syncExtra); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let handle: SyncSchedulerHandle | null = null;
    getDesktopSyncOpts().then(opts => {
      if (cancelled) return;
      handle = startSyncScheduler({ ...opts, isBusy: isDesktopBusy });
      activeHandle = handle;
    }).catch(console.error);
    return () => {
      cancelled = true;
      if (handle) {
        handle.stop();
        if (activeHandle === handle) activeHandle = null;
      }
    };
  }, []);

  useEffect(() => {
    confirmOpener = () => { if (!isDesktopBusy()) setConfirmOpen(true); };
    return () => { confirmOpener = null; };
  }, []);

  useEffect(() => {
    if (prevBusy.current && !effectiveBusy) activeHandle?.onLeavePractice().catch(console.error);
    if (effectiveBusy) setConfirmOpen(false);
    prevBusy.current = effectiveBusy;
  }, [effectiveBusy]);

  useEffect(() => {
    if (!status.pendingAlert) setConfirmOpen(false);
    setBannerHidden(false);
  }, [status.pendingAlert]);

  if (effectiveBusy || !status.pendingAlert) return null;

  const handleConfirm = async () => {
    setConfirming(true);
    try {
      const res = await confirmDesktopSyncPending();
      setConfirmOpen(false);
      if (res.status === 'error') {
        await dialog.alert(t('sync.title'), formatSyncError(res.error, t));
      }
    } catch (e) {
      setConfirmOpen(false);
      await dialog.alert(t('sync.title'), formatSyncError(e instanceof Error ? e.message : String(e), t));
    } finally {
      setConfirming(false);
    }
  };

  const handleCancel = () => {
    if (confirming) return;
    dismissDesktopSyncPending();
    setConfirmOpen(false);
  };

  if (confirmOpen) {
    return (
      <SyncConfirmModal
        alert={status.pendingAlert}
        busy={confirming}
        onConfirm={() => { void handleConfirm(); }}
        onCancel={handleCancel}
      />
    );
  }

  if (bannerHidden) return null;

  return (
    <div className="fixed bottom-5 right-5 z-[60] max-w-sm card px-4 py-3 shadow-lift flex items-center gap-3 fade-in">
      <span className="text-xs text-ink leading-snug">{t('sync.needConfirm')}</span>
      <Btn size="sm" tone="accent" onClick={() => setConfirmOpen(true)}>{t('sync.reviewConfirm')}</Btn>
      <Btn size="sm" flat square aria-label={t('sync.close')} onClick={() => setBannerHidden(true)}>
        <X size={14} />
      </Btn>
    </div>
  );
};

export default SyncHost;
