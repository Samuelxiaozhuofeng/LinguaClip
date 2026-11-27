// Settings → Data backup & undoable restore section (docs/android.md「手机学习闭环」):
// export backup, restore with side-by-side "phone now vs backup" confirmation modal,
// and persistent "Undo last restore" powered by mobile/restore.ts's `pre` snapshot.
import React, { useEffect, useRef, useState } from 'react';
import { useLang, useT } from '../../utils/i18n';
import type { MobileBackup } from '../backup';
import { pushBackClose } from '../backClose';
import { formatBackupDate } from '../homeHelpers';
import { isAndroidNative } from '../platform/androidBridge';
import {
  consumeRestoreResult,
  currentCounts,
  describe,
  discardAndroidStagedZip,
  exportBackup,
  getPreSnapshotInfo,
  pickAndReadAndroidBackup,
  readBackupFile,
  startRestore,
  undoLastRestore,
  type PreSnapshotInfo,
} from '../restore';
import { btnPlain, btnPrimary, sheet } from '../ui';

interface PendingRestoreDialog {
  backup: MobileBackup;
  now: { videos: number; cards: number };
  zip?: string;
  cross?: boolean;
}

export const BackupSection: React.FC = () => {
  const t = useT();
  const ui = useLang();
  const android = isAndroidNative();
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const setBusyState = (next: boolean) => { busyRef.current = next; setBusy(next); };
  const [note, setNote] = useState('');
  const [includeKeys, setIncludeKeys] = useState(true);
  const [preInfo, setPreInfo] = useState<PreSnapshotInfo | null>(null);
  const [pendingRestore, setPendingRestore] = useState<PendingRestoreDialog | null>(null);
  const [undoConfirmOpen, setUndoConfirmOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    const res = consumeRestoreResult();
    if (res) {
      setNote(t(res.kind === 'undo' ? 'm.fxBkSwapped' : 'm.w3BkRestored', { videos: res.videos, cards: res.cards }));
    }
    getPreSnapshotInfo().then(info => { if (alive) setPreInfo(info); }, () => {});
    return () => { alive = false; };
  }, [t]);

  const cancelRestoreDialog = () => {
    if (busyRef.current) return;
    const zip = pendingRestore?.zip;
    setPendingRestore(null);
    if (zip) discardAndroidStagedZip().catch(console.error);
  };
  const cancelUndoDialog = () => {
    if (busyRef.current) return;
    setUndoConfirmOpen(false);
  };

  const cancelRestoreRef = useRef(cancelRestoreDialog);
  cancelRestoreRef.current = cancelRestoreDialog;
  const cancelUndoRef = useRef(cancelUndoDialog);
  cancelUndoRef.current = cancelUndoDialog;

  // Guard system Back while a dialog is open; if busy (reading/staging snapshot), swallow Back
  // and re-register so neither the dialog closes nor the page navigates away mid-restore.
  const restoreOpen = !!pendingRestore;
  useEffect(() => {
    if (!restoreOpen) return;
    let remove = () => {};
    const register = () => {
      remove = pushBackClose(() => {
        if (busyRef.current) { register(); return; }
        cancelRestoreRef.current();
      });
    };
    register();
    return () => remove();
  }, [restoreOpen]);

  useEffect(() => {
    if (!undoConfirmOpen) return;
    let remove = () => {};
    const register = () => {
      remove = pushBackClose(() => {
        if (busyRef.current) { register(); return; }
        cancelUndoRef.current();
      });
    };
    register();
    return () => remove();
  }, [undoConfirmOpen]);

  const doExport = () => {
    setBusyState(true);
    setNote('');
    exportBackup(android ? { includeKeys } : undefined)
      .then(n => { if (n) setNote(t('m.bkExported', n)); }, e => { console.error(e); setNote(t('m.bkExportFail', { why: describe(e) })); })
      .finally(() => setBusyState(false));
  };

  const doRestoreWeb = async (f: File) => {
    setBusyState(true);
    setNote('');
    try {
      const [b, now] = await Promise.all([readBackupFile(f), currentCounts()]);
      setPendingRestore({ backup: b, now });
    } catch (e) {
      console.error(e);
      setNote(t('m.bkCant', { why: describe(e) }));
    } finally {
      setBusyState(false);
    }
  };

  const doPickRestore = async () => {
    if (!android) { file.current?.click(); return; }
    setBusyState(true);
    setNote('');
    let stagedZip = false;
    try {
      const picked = await pickAndReadAndroidBackup();
      if (!picked) return;
      stagedZip = !!picked.zip;
      const now = await currentCounts();
      setPendingRestore({ backup: picked.backup, now, zip: picked.zip, cross: picked.cross });
    } catch (e) {
      if (stagedZip) await discardAndroidStagedZip().catch(console.error);
      console.error(e);
      setNote(t('m.bkCant', { why: describe(e) }));
    } finally {
      setBusyState(false);
    }
  };

  const confirmRestore = async () => {
    if (!pendingRestore || busyRef.current) return;
    const { backup, zip, cross } = pendingRestore;
    setBusyState(true);
    setNote('');
    try {
      await startRestore(backup, { zip, cross }); // reloads on success
    } catch (e) {
      setPendingRestore(null);
      if (zip) await discardAndroidStagedZip().catch(console.error);
      console.error(e);
      setNote(t('m.bkCant', { why: describe(e) }));
      setBusyState(false);
    }
  };

  const confirmUndo = async () => {
    if (busyRef.current) return;
    setBusyState(true);
    setNote('');
    try {
      await undoLastRestore(); // reloads on success
    } catch (e) {
      setUndoConfirmOpen(false);
      console.error(e);
      setNote(t('m.bkCant', { why: describe(e) }));
      setPreInfo(await getPreSnapshotInfo());
      setBusyState(false);
    }
  };

  const bkDate = pendingRestore ? formatBackupDate(pendingRestore.backup.at, ui) : '';

  return (
    <section className="flex flex-col gap-2">
      <p className="text-[13px] text-mute">{t('m.dataTitle')}</p>
      <div className={`${sheet} flex flex-col`}>
        {android && (
          <label className="px-4 py-3 flex items-start justify-between gap-3 border-b border-shade">
            <span className="flex flex-col gap-0.5">
              <span className="text-[15px]">{t('m.bkIncludeKeys')}</span>
              <span className="text-[13px] text-mute">{t('m.bkIncludeKeysWarn')}</span>
            </span>
            <input type="checkbox" checked={includeKeys} className="w-5 h-5 mt-0.5 shrink-0 accent-accent"
              onChange={e => setIncludeKeys(e.target.checked)} />
          </label>
        )}
        <button disabled={busy} onClick={doExport} className="h-[52px] px-4 text-left text-[15px] border-b border-shade disabled:opacity-50">
          {t(android ? 'm.bkExportZip' : 'm.bkExport')}
        </button>
        <button disabled={busy} onClick={() => void doPickRestore()} className={`min-h-[52px] px-4 py-2.5 text-left text-[15px] disabled:opacity-50 ${preInfo ? 'border-b border-shade' : ''}`}>
          {t(android ? 'm.bkRestoreAndroid' : 'm.bkRestore')}
        </button>
        {preInfo && (
          <button
            type="button"
            disabled={busy}
            data-testid="undo-restore-btn"
            onClick={() => setUndoConfirmOpen(true)}
            className="min-h-[56px] px-4 py-3 text-left flex flex-col gap-0.5 disabled:opacity-50"
          >
            <span className="text-[15px] font-medium text-accent">{t('m.fxBkSwapBtn')}</span>
            <span className="text-[13px] text-mute">
              {t('m.fxBkSwapSub', { videos: preInfo.videos, cards: preInfo.cards })}
            </span>
          </button>
        )}
      </div>
      {note && <p role="status" className="text-[13px] text-accent px-1 whitespace-pre-line">{note}</p>}
      <p className="text-[13px] text-mute px-1">{t(android ? 'm.androidDataHelp' : 'm.dataHelp')}</p>
      <input ref={file} type="file" accept=".json,application/json" className="hidden"
        onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void doRestoreWeb(f); }} />

      {pendingRestore && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t('m.w3BkConfirmTitle')}
          data-testid="restore-confirm-dialog"
          className="fixed inset-0 z-50 bg-black/40 flex items-end justify-center p-3 pb-[max(16px,env(safe-area-inset-bottom))]"
          onClick={cancelRestoreDialog}
        >
          <div
            className={`${sheet} w-full max-w-lg p-5 shadow-xl flex flex-col gap-4`}
            onClick={e => e.stopPropagation()}
          >
            <h2 className="text-[17px] font-semibold text-ink">{t('m.w3BkConfirmTitle')}</h2>
            <div className="grid grid-cols-2 gap-2.5">
              <div className="rounded-xl bg-shade px-3.5 py-3 flex flex-col gap-1">
                <span className="text-[13px] text-mute">{t('m.w3BkNowLabel')}</span>
                <span className="text-[15px] font-semibold text-ink tabular-nums">
                  {t('m.w3BkCounts', { videos: pendingRestore.now.videos, cards: pendingRestore.now.cards })}
                </span>
              </div>
              <div className="rounded-xl bg-shade px-3.5 py-3 flex flex-col gap-1">
                <span className="text-[13px] text-mute">{t('m.w3BkBackupLabel')}</span>
                <span className="text-[15px] font-semibold text-ink tabular-nums">
                  {t('m.w3BkCounts', { videos: pendingRestore.backup.videos.length, cards: pendingRestore.backup.review.cards.length })}
                </span>
                {bkDate && <span className="text-[13px] text-mute">{t('m.w3BkDate', { date: bkDate })}</span>}
              </div>
            </div>
            <p className="text-[14px] text-mute leading-relaxed">{t('m.w3BkWarn')}</p>
            <div className="grid grid-cols-2 gap-2.5 pt-1">
              <button type="button" disabled={busy} className={btnPlain} onClick={cancelRestoreDialog}>
                {t('m.cancel')}
              </button>
              <button type="button" disabled={busy} className={btnPrimary} onClick={() => void confirmRestore()}>
                {t('m.w3BkConfirmOk')}
              </button>
            </div>
          </div>
        </div>
      )}

      {undoConfirmOpen && preInfo && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t('m.fxBkSwapTitle')}
          data-testid="undo-confirm-dialog"
          className="fixed inset-0 z-50 bg-black/40 flex items-end justify-center p-3 pb-[max(16px,env(safe-area-inset-bottom))]"
          onClick={cancelUndoDialog}
        >
          <div
            className={`${sheet} w-full max-w-lg p-5 shadow-xl flex flex-col gap-4`}
            onClick={e => e.stopPropagation()}
          >
            <h2 className="text-[17px] font-semibold text-ink">{t('m.fxBkSwapTitle')}</h2>
            <p className="text-[14px] text-mute leading-relaxed">
              {t('m.fxBkSwapConfirm', { videos: preInfo.videos, cards: preInfo.cards })}
            </p>
            <div className="grid grid-cols-2 gap-2.5 pt-1">
              <button type="button" disabled={busy} className={btnPlain} onClick={cancelUndoDialog}>
                {t('m.cancel')}
              </button>
              <button type="button" disabled={busy} className={btnPrimary} onClick={() => void confirmUndo()}>
                {t('m.fxBkSwapOk')}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
