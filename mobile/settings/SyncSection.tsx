// Settings → Cross-Device Sync section (docs/sync.md):
// Android native shows WebDAV status + desktop pairing-code paste + manual config
// + offline .zip/.json sync pack; iPhone PWA quietly shows sync.pwaNote + offline
// .json export/merge. Zero @tauri-apps/* imports.
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useLang, useT } from '../../utils/i18n';
import { getSyncConfig, type WebDavConfig } from '../../utils/syncConfig';
import {
  exportOfflineSyncPack,
  getSyncRuntimeStatus,
  previewOfflineSyncPack,
  subscribeSyncStatus,
  type OfflineMergePreview,
  type PickedSyncPack,
  type SyncRunResult,
} from '../../utils/syncEngine';
import { formatBackupDate, isSameLocalDay } from '../homeHelpers';
import { pickSyncPackFile, syncWebdavSupported } from '../platform/desktop';
import {
  confirmMobileSyncPending,
  dismissMobileSyncPending,
  formatSyncError,
  getMobileSyncOpts,
  triggerMobileSyncNow,
} from '../SyncHost';
import { btnPrimary, btnSmall, btnSoft, sheet } from '../ui';
import { ConfigSyncSheet, PackPreviewSheet, PastePairSheet, SafetyConfirmSheet } from './SyncDialogs';

function formatSyncWhen(ts: number, lang: string): string {
  if (!ts) return '';
  if (isSameLocalDay(ts)) {
    try {
      return new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en', { hour: '2-digit', minute: '2-digit' }).format(new Date(ts));
    } catch { /* fallback below */ }
  }
  return formatBackupDate(ts, lang);
}

export const SyncSection: React.FC = () => {
  const t = useT();
  const lang = useLang();
  const webdav = syncWebdavSupported();
  const status = useSyncExternalStore(subscribeSyncStatus, getSyncRuntimeStatus);
  const fileRef = useRef<HTMLInputElement>(null);
  const previewRef = useRef<OfflineMergePreview | null>(null);

  const [cfg, setCfg] = useState<WebDavConfig>(getSyncConfig);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [pasteOpen, setPasteOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [safetyOpen, setSafetyOpen] = useState(false);
  const [packPreview, setPackPreview] = useState<OfflineMergePreview | null>(null);
  previewRef.current = packPreview;

  useEffect(() => () => { void previewRef.current?.cancel().catch(() => {}); }, []);
  const refreshCfg = () => setCfg(getSyncConfig());

  const reportSyncResult = (res: SyncRunResult, prefix = '') => {
    const pre = prefix ? `${prefix} · ` : '';
    if (res.status === 'needs_confirm') {
      if (prefix) setNote(prefix);
      setSafetyOpen(true);
      return;
    }
    if (res.status === 'error') { setNote(`${pre}${formatSyncError(res.error, t)}`); return; }
    if (res.status === 'ok') {
      const s = res.summary;
      const changed = s.addedVideos + s.updatedVideos + s.removedVideos + s.addedCards + s.updatedCards + s.removedCards;
      setNote(changed > 0 ? `${pre}${t('sync.doneSummary', { v: s.addedVideos, c: s.addedCards })}` : `${pre}${t('sync.doneClean')}`);
    }
  };

  const runSyncNow = async (prefix = '') => {
    if (busy || status.syncing) return;
    setBusy(true); setNote(prefix);
    try {
      const res = await triggerMobileSyncNow();
      refreshCfg();
      reportSyncResult(res, prefix);
    } catch (e) { setNote(formatSyncError(e, t)); }
    finally { setBusy(false); }
  };

  const handleConnected = (msg: string) => { refreshCfg(); void runSyncNow(msg); };

  const handleConfirmSafety = async () => {
    if (busy) return;
    setBusy(true); setNote('');
    try {
      const res = await confirmMobileSyncPending();
      setSafetyOpen(false);
      reportSyncResult(res);
    } catch (e) { setNote(formatSyncError(e, t)); }
    finally { setBusy(false); }
  };

  const handleCancelSafety = () => { if (!busy) { setSafetyOpen(false); dismissMobileSyncPending(); } };

  const doExportPack = async (format: 'zip' | 'json' = 'zip') => {
    if (busy) return;
    setBusy(true); setNote('');
    try {
      const opts = await getMobileSyncOpts();
      const actualFmt = opts.platform === 'pwa' ? 'json' : format;
      const res = await exportOfflineSyncPack({ platform: opts.platform, ownDir: opts.ownDir, format: actualFmt, shareTitle: t('sync.packExport') });
      if (res) {
        setNote(t(actualFmt === 'json' && opts.platform !== 'pwa' ? 'sync.packExportedJson' : 'sync.packExported', { videos: res.videos, cards: res.cards }));
      }
    } catch (e) { setNote(formatSyncError(e, t)); }
    finally { setBusy(false); }
  };

  const previewPicked = async (picked: PickedSyncPack) => {
    try {
      const preview = await previewOfflineSyncPack(picked, await getMobileSyncOpts());
      setPackPreview(preview);
    } catch (e) {
      if (picked.kind === 'zip') await picked.cleanup?.().catch(() => {});
      throw e;
    }
  };

  const doImportJsonFile = async (f: File) => {
    setBusy(true); setNote('');
    try { await previewPicked({ kind: 'json', text: await f.text() }); }
    catch (e) { setNote(formatSyncError(e, t)); }
    finally { setBusy(false); }
  };

  const doPickImportPack = async () => {
    if (busy) return;
    if (!webdav) { fileRef.current?.click(); return; }
    setBusy(true); setNote('');
    try {
      const picked = await pickSyncPackFile();
      if (picked) await previewPicked(picked);
    } catch (e) { setNote(formatSyncError(e, t)); }
    finally { setBusy(false); }
  };

  const handleApplyPack = async () => {
    if (!packPreview || busy) return;
    setBusy(true); setNote('');
    try {
      const { summary } = await packPreview.apply();
      setPackPreview(null);
      setNote(t('sync.packMerged', { addV: summary.addedVideos, addC: summary.addedCards }));
    } catch (e) { setPackPreview(null); setNote(formatSyncError(e, t)); }
    finally { setBusy(false); }
  };

  const handleCancelPack = () => {
    if (busy) return;
    const prev = packPreview;
    setPackPreview(null);
    void prev?.cancel().catch(() => {});
  };

  const statusLine = (() => {
    if (status.syncing) return { text: t('sync.syncing'), tone: 'text-ink font-medium' };
    if (!cfg.enabled) return { text: t('sync.off'), tone: 'text-mute' };
    if (status.authFailed) return { text: t('sync.authError'), tone: 'text-accent font-medium' };
    if (status.pendingAlert) return { text: t('sync.needConfirm'), tone: 'text-accent font-medium' };
    if (status.newerFormat) return { text: t('sync.newerFormat'), tone: 'text-accent' };
    if (status.lastSyncAt > 0) {
      const text = Date.now() - status.lastSyncAt < 60_000
        ? t('sync.syncedJustNow')
        : t('sync.syncedAgo', { when: formatSyncWhen(status.lastSyncAt, lang) });
      return { text, tone: 'text-ink font-medium' };
    }
    return { text: t('sync.neverSynced'), tone: 'text-ink' };
  })();

  const disabled = busy || status.syncing;

  return (
    <section className="flex flex-col gap-2" data-testid="sync-section">
      <p className="text-[13px] text-mute">{t('sync.title')}</p>
      <div className={`${sheet} flex flex-col`}>
        {webdav ? (
          <div className="px-4 py-3.5 border-b border-shade flex flex-col gap-2.5">
            <div className="flex flex-col gap-0.5">
              <p className={`text-[15px] ${statusLine.tone}`}>{statusLine.text}</p>
              {!cfg.enabled && <p className="text-[13px] text-mute leading-relaxed">{t('sync.subtitle')}</p>}
              {cfg.enabled && status.lastError && !status.authFailed && !status.pendingAlert && (
                <p className="text-[12px] text-accent leading-relaxed">{formatSyncError(status.lastError, t)}</p>
              )}
            </div>
            {!cfg.enabled ? (
              <div className="flex flex-col gap-2 pt-0.5">
                <button type="button" disabled={disabled} data-testid="sync-paste-pair-btn"
                  onClick={() => { setNote(''); setPasteOpen(true); }} className={`${btnPrimary} w-full`}>
                  {t('sync.pastePair')}
                </button>
                <button type="button" disabled={disabled} data-testid="sync-configure-btn"
                  onClick={() => { setNote(''); refreshCfg(); setConfigOpen(true); }} className={`${btnSoft} w-full min-h-[46px]`}>
                  {t('sync.configure')}
                </button>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2 pt-0.5">
                {status.pendingAlert && (
                  <button type="button" disabled={disabled} data-testid="sync-review-confirm-btn" onClick={() => setSafetyOpen(true)}
                    className="min-h-[44px] px-4 rounded-[10px] bg-accent text-white text-sm font-medium disabled:opacity-50">
                    {t('sync.reviewConfirm')}
                  </button>
                )}
                <button type="button" disabled={disabled} data-testid="sync-now-btn" onClick={() => void runSyncNow()} className={btnSmall}>
                  {status.syncing ? t('sync.syncing') : t('sync.syncNow')}
                </button>
                <button type="button" disabled={disabled} data-testid="sync-configure-btn"
                  onClick={() => { setNote(''); refreshCfg(); setConfigOpen(true); }} className={btnSoft}>
                  {t('sync.configure')}
                </button>
                <button type="button" disabled={disabled} data-testid="sync-paste-pair-btn"
                  onClick={() => { setNote(''); setPasteOpen(true); }} className={btnSoft}>
                  {t('sync.pastePair')}
                </button>
              </div>
            )}
          </div>
        ) : (
          <p className="px-4 py-3 text-[13px] text-mute leading-relaxed border-b border-shade">{t('sync.pwaNote')}</p>
        )}

        <p className="px-4 pt-3 pb-1 text-[12px] text-mute">{t('sync.packSection')}</p>
        <button type="button" disabled={disabled} data-testid="sync-pack-export-btn" onClick={() => void doExportPack('zip')}
          className="h-[52px] px-4 text-left text-[15px] border-b border-shade disabled:opacity-50">
          {t('sync.packExport')}
        </button>
        {webdav && (
          <button type="button" disabled={disabled} data-testid="sync-pack-export-json-btn" onClick={() => void doExportPack('json')}
            className="h-[52px] px-4 text-left text-[15px] border-b border-shade disabled:opacity-50">
            {t('sync.packExportJson')}
          </button>
        )}
        <button type="button" disabled={disabled} data-testid="sync-pack-import-btn" onClick={() => void doPickImportPack()}
          className="h-[52px] px-4 text-left text-[15px] disabled:opacity-50">
          {t('sync.packImport')}
        </button>
      </div>

      {note && <p role="status" className="text-[13px] text-accent px-1 whitespace-pre-line">{note}</p>}

      <input ref={fileRef} type="file" accept=".json,application/json" className="hidden"
        onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void doImportJsonFile(f); }} />

      {webdav && (
        <>
          <PastePairSheet open={pasteOpen} onClose={() => setPasteOpen(false)} onApplied={handleConnected} />
          <ConfigSyncSheet open={configOpen} initial={cfg} onClose={() => setConfigOpen(false)}
            onSaved={handleConnected} onDisabled={() => { refreshCfg(); setNote(t('sync.off')); }} />
          <SafetyConfirmSheet alert={safetyOpen ? status.pendingAlert : null} busy={busy}
            onConfirm={() => void handleConfirmSafety()} onCancel={handleCancelSafety} />
        </>
      )}
      <PackPreviewSheet preview={packPreview} busy={busy} onConfirm={() => void handleApplyPack()} onCancel={handleCancelPack} />
    </section>
  );
};
