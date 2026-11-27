import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { Loader2 } from 'lucide-react';
import { Btn, Card, Field, Seg, inputCls } from './ui';
import SettingsFold from './SettingsFold';
import { dialog } from './Dialog';
import { SyncPairModal } from './SyncPairModal';
import { formatSyncError, getDesktopSyncOpts, openDesktopSyncConfirm, triggerDesktopSyncNow } from './SyncHost';
import { useLang, useT, type t as tr } from '../utils/i18n';
import { pickSyncPackFile } from '../utils/desktop';
import { enableLocalSaveClipsIfUnset } from '../utils/storage';
import { downloadConvertTool, loadConvertTool } from '../utils/convertTool';
import { retryClips } from '../utils/clips';
import { getSyncConfig, JIANGUOYUN_URL, saveSyncConfig, type WebDavConfig } from '../utils/syncConfig';
import { clearAudioBudgetNotice, formatAudioMB, getMonthlyAudioUsage, getSyncAudioSnapshot, subscribeSyncAudio } from '../utils/syncAudio';
import {
  disableSync, exportOfflineSyncPack, getSyncRuntimeStatus, previewOfflineSyncPack,
  subscribeSyncStatus, testAndEnableSync, type OfflineMergePreview, type SyncRunResult,
} from '../utils/syncEngine';

// When the user turns on sync (or exports a .zip pack) and has never explicitly chosen `saveClips`,
// enable card clips locally (without touching sync timestamps) so cards play audio on the phone too.
function maybeEnableClipsForSync(): boolean {
  if (!enableLocalSaveClipsIfUnset()) return false;
  loadConvertTool().then(st => st && !st.path ? downloadConvertTool() : true).finally(() => { retryClips(); }).catch(() => {});
  return true;
}

const formatSyncWhen = (ms: number, lang: string, translate: typeof tr): string => {
  if (Date.now() - ms < 60_000) return translate('sync.syncedJustNow');
  const d = new Date(ms);
  const loc = lang === 'zh' ? 'zh-CN' : 'en-US';
  const time = d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit', hour12: false });
  const when = d.toDateString() === new Date().toDateString()
    ? translate('backup.today', { time })
    : `${d.toLocaleDateString(loc)} ${time}`;
  return translate('sync.syncedAgo', { when });
};

const Toggle: React.FC<{ checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }> = ({
  checked, onChange, disabled, label,
}) => (
  <button
    type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
    onClick={e => { onChange(!checked); e.currentTarget.blur(); }}
    className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${checked ? 'bg-accent' : 'bg-line'}`}
  >
    <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-[18px]' : 'translate-x-[3px]'}`} />
  </button>
);

const SettingsSync: React.FC<{ onClipsChanged?: () => void }> = ({ onClipsChanged }) => {
  const t = useT();
  const lang = useLang();
  const status = useSyncExternalStore(subscribeSyncStatus, getSyncRuntimeStatus);
  const audioSnap = useSyncExternalStore(subscribeSyncAudio, getSyncAudioSnapshot);
  const usage = getMonthlyAudioUsage();
  const [cfg, setCfg] = useState<WebDavConfig>(() => getSyncConfig());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; warn?: boolean } | null>(null);

  const [configOpen, setConfigOpen] = useState(false);
  const [draft, setDraft] = useState<WebDavConfig>(() => getSyncConfig());
  const [testing, setTesting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [pairOpen, setPairOpen] = useState(false);
  const [packPreview, setPackPreview] = useState<OfflineMergePreview | null>(null);
  const [packBusy, setPackBusy] = useState(false);

  // Esc closes config or pack preview dialog unless an operation is in progress.
  useEffect(() => {
    if (!configOpen && !packPreview) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (configOpen && !testing) setConfigOpen(false);
      else if (packPreview && !packBusy) {
        const cur = packPreview;
        setPackPreview(null);
        void cur.cancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [configOpen, testing, packPreview, packBusy]);

  const handleRunResult = (res: SyncRunResult, suffix = '') => {
    if (res.status === 'needs_confirm') { openDesktopSyncConfirm(); return; }
    if (res.status === 'error') { setNote({ text: formatSyncError(res.error, t), warn: true }); return; }
    if (res.status === 'ok') {
      const s = res.summary;
      setNote({
        text: (s.addedVideos + s.addedCards > 0
          ? t('sync.doneSummary', { v: s.addedVideos, c: s.addedCards })
          : t('sync.doneClean')) + suffix,
      });
    }
  };

  const openConfig = () => {
    const latest = getSyncConfig();
    setCfg(latest);
    setDraft(latest);
    setFormError(null);
    setConfigOpen(true);
  };

  const switchPreset = (preset: 'jianguoyun' | 'custom') => {
    setFormError(null);
    setDraft(prev => preset === 'jianguoyun'
      ? { ...prev, preset, url: !prev.url.trim() || prev.preset !== 'jianguoyun' ? JIANGUOYUN_URL : prev.url }
      : { ...prev, preset, url: prev.url.trim() === JIANGUOYUN_URL ? '' : prev.url });
  };

  const submitConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    if (testing) return;
    setTesting(true);
    setFormError(null);
    const next: WebDavConfig = {
      ...draft,
      url: draft.url.trim(),
      username: draft.username.trim(),
      rootDir: draft.rootDir.trim() || 'LinguaClip',
    };
    let res;
    try {
      res = await testAndEnableSync(next);
    } catch (err) {
      setFormError(formatSyncError(err instanceof Error ? err.message : String(err), t));
      return;
    } finally {
      setTesting(false);
    }
    const enabledClips = maybeEnableClipsForSync();
    if (enabledClips) onClipsChanged?.();
    const autoClipsNote = enabledClips ? t('sync.autoClipsNote') : '';
    setCfg(getSyncConfig());
    setConfigOpen(false);
    setNote({
      text: (res.existingDevices > 0
        ? t('sync.connectedWithPeers', { n: res.existingDevices })
        : t('sync.connected')) + autoClipsNote,
    });
    setBusy(true);
    try { handleRunResult(await triggerDesktopSyncNow(), autoClipsNote); } finally { setBusy(false); }
  };

  const handleDisable = () => {
    if (testing) return;
    disableSync();
    setCfg(getSyncConfig());
    setConfigOpen(false);
    setNote(null);
  };

  const toggleAutoSyncAudio = (v: boolean) => {
    const next: WebDavConfig = { ...getSyncConfig(), autoSyncAudio: v };
    saveSyncConfig(next);
    if (!v) clearAudioBudgetNotice();
    setCfg(next);
  };

  const handleSyncNow = async () => {
    if (busy || status.syncing) return;
    setBusy(true);
    setNote(null);
    try { handleRunResult(await triggerDesktopSyncNow()); } finally { setBusy(false); }
  };

  const handleExportPack = async (format: 'zip' | 'json' = 'zip') => {
    if (busy) return;
    if (format === 'zip' && maybeEnableClipsForSync()) onClipsChanged?.();
    setBusy(true);
    try {
      const opts = await getDesktopSyncOpts();
      const done = await exportOfflineSyncPack({ platform: opts.platform, ownDir: opts.ownDir, format });
      if (done) {
        await dialog.alert(
          t('sync.title'),
          t(format === 'json' ? 'sync.packExportedJson' : 'sync.packExported', { videos: done.videos, cards: done.cards }),
        );
      }
    } catch (err) {
      await dialog.alert(t('sync.title'), formatSyncError(err instanceof Error ? err.message : String(err), t));
    } finally {
      setBusy(false);
    }
  };

  const handleImportPack = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const picked = await pickSyncPackFile();
      if (!picked) return;
      try {
        const opts = await getDesktopSyncOpts();
        setPackPreview(await previewOfflineSyncPack(picked, opts));
      } catch (err) {
        if (picked.kind === 'zip') await picked.cleanup?.().catch(() => {});
        await dialog.alert(t('sync.title'), formatSyncError(err instanceof Error ? err.message : String(err), t));
      }
    } finally {
      setBusy(false);
    }
  };

  const cancelPackPreview = () => {
    if (packBusy || !packPreview) return;
    const cur = packPreview;
    setPackPreview(null);
    void cur.cancel();
  };

  const applyPackPreview = async () => {
    if (packBusy || !packPreview) return;
    setPackBusy(true);
    try {
      const res = await packPreview.apply();
      setPackPreview(null);
      await dialog.alert(t('sync.title'), t('sync.packMerged', {
        addV: res.summary.addedVideos,
        addC: res.summary.addedCards,
      }));
    } catch (err) {
      setPackPreview(null);
      await dialog.alert(t('sync.title'), formatSyncError(err instanceof Error ? err.message : String(err), t));
    } finally {
      setPackBusy(false);
    }
  };

  const renderStatus = () => {
    if (!cfg.enabled) return <span>{t('sync.off')}</span>;
    if (status.syncing) {
      return <span className="inline-flex items-center gap-1"><Loader2 size={12} className="animate-spin" />{t('sync.syncing')}</span>;
    }
    if (status.authFailed) return <span className="text-accent font-medium">{t('sync.authError')}</span>;
    if (status.pendingAlert) return <span className="text-accent font-medium">{t('sync.needConfirm')}</span>;
    if (status.newerFormat) return <span className="text-accent font-medium">{t('sync.newerFormat')}</span>;
    if (status.lastError) return <span className="text-accent">{formatSyncError(status.lastError, t)}</span>;
    if (status.lastSyncAt > 0) return <span>{formatSyncWhen(status.lastSyncAt, lang, t)}</span>;
    return <span>{t('sync.neverSynced')}</span>;
  };

  const canSubmit = !testing && !!draft.url.trim() && !!draft.username.trim() && !!draft.password;

  const quickActions = cfg.enabled ? (
    <>
      {status.pendingAlert && (
        <Btn type="button" size="sm" tone="accent" onClick={openDesktopSyncConfirm}>{t('sync.reviewConfirm')}</Btn>
      )}
      <Btn type="button" size="sm" disabled={busy || status.syncing} onClick={() => { void handleSyncNow(); }}>
        {status.syncing && <Loader2 size={13} className="animate-spin" />}
        {t('sync.syncNow')}
      </Btn>
    </>
  ) : undefined;

  return (
    <div>
      <SettingsFold
        title={t('settings.group.sync')}
        summary={renderStatus()}
        action={quickActions}
      >
        <div className="space-y-3 text-xs text-mute">
          {!cfg.enabled ? (
            <>
              <div className="flex flex-wrap gap-2">
                <Btn type="button" size="sm" disabled={busy} onClick={openConfig}>{t('sync.configure')}</Btn>
                <Btn type="button" size="sm" disabled={busy} onClick={() => { void handleExportPack('zip'); }}>{t('sync.packExport')}</Btn>
                <Btn type="button" size="sm" disabled={busy} onClick={() => { void handleExportPack('json'); }}>{t('sync.packExportJson')}</Btn>
                <Btn type="button" size="sm" disabled={busy} onClick={() => { void handleImportPack(); }}>{t('sync.packImport')}</Btn>
              </div>
              <p className="leading-relaxed">{t('sync.subtitle')}</p>
            </>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                <Btn type="button" size="sm" disabled={busy || status.syncing} onClick={() => { void handleSyncNow(); }}>
                  {status.syncing && <Loader2 size={13} className="animate-spin" />}
                  {t('sync.syncNow')}
                </Btn>
                <Btn type="button" size="sm" disabled={busy} onClick={() => { setCfg(getSyncConfig()); setPairOpen(true); }}>{t('sync.pairPhone')}</Btn>
                <Btn type="button" size="sm" disabled={busy} onClick={openConfig}>{t('sync.configure')}</Btn>
                {status.pendingAlert && <Btn type="button" size="sm" tone="accent" onClick={openDesktopSyncConfirm}>{t('sync.reviewConfirm')}</Btn>}
              </div>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <span className="text-mute">{t('sync.packSection')}</span>
                <Btn type="button" size="sm" flat disabled={busy} onClick={() => { void handleExportPack('zip'); }}>{t('sync.packExport')}</Btn>
                <Btn type="button" size="sm" flat disabled={busy} onClick={() => { void handleExportPack('json'); }}>{t('sync.packExportJson')}</Btn>
                <Btn type="button" size="sm" flat disabled={busy} onClick={() => { void handleImportPack(); }}>{t('sync.packImport')}</Btn>
              </div>
              <div className="pt-2 border-t border-line/60 space-y-1.5">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-ink font-medium">{t('sync.autoSyncAudio')}</span>
                  <Toggle checked={!!cfg.autoSyncAudio} disabled={busy} label={t('sync.autoSyncAudio')} onChange={toggleAutoSyncAudio} />
                </div>
                <p className="leading-relaxed">{t('sync.autoSyncAudioHint')}</p>
                {cfg.autoSyncAudio && (
                  <p className="leading-relaxed">
                    {t('sync.audioMonthlyUsed', { used: formatAudioMB(usage.bytes), limit: formatAudioMB(usage.budgetBytes) })}
                  </p>
                )}
                {cfg.autoSyncAudio && (audioSnap.budgetNotice || usage.exceeded) && (
                  <p className="text-accent leading-relaxed">{t('sync.audioBudgetHit')}</p>
                )}
              </div>
            </>
          )}
        </div>
      </SettingsFold>

      {note && <p className={`mt-2 px-1 text-xs ${note.warn ? 'text-accent' : 'text-mute'}`}>{note.text}</p>}

      {configOpen && (
        <div className="fixed inset-0 z-[90] bg-black/40 flex items-center justify-center p-4 fade-in" onClick={() => { if (!testing) setConfigOpen(false); }}>
          <Card
            data-testid="sync-config-dialog"
            className="w-full max-w-md shadow-lift text-left max-h-[90vh] overflow-y-auto"
            role="dialog" aria-modal="true" aria-label={t('sync.title')}
            onClick={e => e.stopPropagation()}
          >
            <form onSubmit={e => { void submitConfig(e); }}>
              <div className="px-6 pt-6 pb-3">
                <h3 className="text-xl font-semibold leading-tight text-ink">{t('sync.title')}</h3>
              </div>
              <div className="px-6 space-y-4">
                <Field label={t('sync.presetLabel')}>
                  <Seg<'jianguoyun' | 'custom'>
                    size="sm" value={draft.preset} onChange={switchPreset}
                    options={[
                      { value: 'jianguoyun', label: t('sync.presetJianguoyun') },
                      { value: 'custom', label: t('sync.presetCustom') },
                    ]}
                  />
                </Field>
                <p className="text-xs text-mute leading-relaxed whitespace-pre-line bg-shade rounded-xl px-3.5 py-2.5">
                  {t(draft.preset === 'jianguoyun' ? 'sync.jianguoyunGuide' : 'sync.customGuide')}
                </p>
                <Field label={t('sync.url')}>
                  <input type="url" className={inputCls} disabled={testing} value={draft.url}
                    onChange={e => setDraft(d => ({ ...d, url: e.target.value }))} placeholder={JIANGUOYUN_URL} />
                </Field>
                <Field label={t('sync.username')}>
                  <input type="text" className={inputCls} disabled={testing} autoComplete="username" value={draft.username}
                    onChange={e => setDraft(d => ({ ...d, username: e.target.value }))} />
                </Field>
                <Field label={t('sync.password')}>
                  <input type="password" className={inputCls} disabled={testing} autoComplete="current-password" value={draft.password}
                    onChange={e => setDraft(d => ({ ...d, password: e.target.value }))} />
                </Field>
                <Field label={t('sync.rootDir')}>
                  <input type="text" className={inputCls} disabled={testing} value={draft.rootDir}
                    onChange={e => setDraft(d => ({ ...d, rootDir: e.target.value }))} placeholder="LinguaClip" />
                </Field>
                <div className="pt-1">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium text-ink">{t('sync.syncClips')}</span>
                    <Toggle checked={draft.syncClips} disabled={testing} label={t('sync.syncClips')}
                      onChange={v => setDraft(d => ({ ...d, syncClips: v }))} />
                  </div>
                  <p className="mt-1.5 text-xs text-mute leading-relaxed">{t('sync.syncClipsHint')}</p>
                </div>
                <div className="pt-1">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium text-ink">{t('sync.autoSyncAudio')}</span>
                    <Toggle checked={!!draft.autoSyncAudio} disabled={testing} label={t('sync.autoSyncAudio')}
                      onChange={v => setDraft(d => ({ ...d, autoSyncAudio: v }))} />
                  </div>
                  <p className="mt-1.5 text-xs text-mute leading-relaxed">{t('sync.autoSyncAudioHint')}</p>
                  {draft.autoSyncAudio && (
                    <p className="mt-1 text-xs text-mute">
                      {t('sync.audioMonthlyUsed', { used: formatAudioMB(usage.bytes), limit: formatAudioMB(usage.budgetBytes) })}
                    </p>
                  )}
                </div>
                {formError && <p className="text-xs text-accent leading-relaxed">{formError}</p>}
              </div>
              <div className="px-6 pt-5 pb-6 flex items-center justify-between gap-2">
                <div>{cfg.enabled && <Btn type="button" flat disabled={testing} onClick={handleDisable}>{t('sync.disable')}</Btn>}</div>
                <div className="flex items-center gap-2">
                  <Btn type="button" disabled={testing} onClick={() => setConfigOpen(false)}>{t('sync.close')}</Btn>
                  <Btn type="submit" tone="accent" disabled={!canSubmit}>
                    {testing && <Loader2 size={14} className="animate-spin" />}
                    {t(testing ? 'sync.testing' : 'sync.testAndEnable')}
                  </Btn>
                </div>
              </div>
            </form>
          </Card>
        </div>
      )}

      {pairOpen && <SyncPairModal config={cfg} onClose={() => setPairOpen(false)} />}

      {packPreview && (
        <div className="fixed inset-0 z-[95] bg-black/40 flex items-center justify-center p-4 fade-in" onClick={cancelPackPreview}>
          <Card
            data-testid="sync-pack-preview-dialog"
            className="w-full max-w-md shadow-lift text-left"
            role="dialog" aria-modal="true" aria-label={t('sync.packPreviewTitle')}
            onClick={e => e.stopPropagation()}
          >
            <div className="px-6 pt-6 pb-2">
              <h3 className="text-xl font-semibold leading-tight text-ink">{t('sync.packPreviewTitle')}</h3>
            </div>
            <div className="px-6 pb-5 space-y-3">
              <p className="text-sm text-mute leading-relaxed whitespace-pre-line">
                {t('sync.packPreviewBody', {
                  addV: packPreview.summary.addedVideos, updV: packPreview.summary.updatedVideos,
                  addC: packPreview.summary.addedCards, updC: packPreview.summary.updatedCards,
                })}
              </p>
              {packPreview.newerFormat && <p className="text-xs text-accent leading-relaxed">{t('sync.newerFormat')}</p>}
              {packPreview.safetyAlert?.massDeletion && (
                <p className="text-xs text-accent leading-relaxed">
                  {t('sync.massDelBody', {
                    dropV: packPreview.safetyAlert.dropVideos, dropC: packPreview.safetyAlert.dropCards,
                    localVideos: packPreview.safetyAlert.localVideos, localCards: packPreview.safetyAlert.localCards,
                  })}
                </p>
              )}
            </div>
            <div className="px-6 pt-1 pb-6 flex justify-end gap-3">
              <Btn disabled={packBusy} onClick={cancelPackPreview}>{t('sync.cancel')}</Btn>
              <Btn tone="accent" disabled={packBusy} onClick={() => { void applyPackPreview(); }}>
                {packBusy && <Loader2 size={14} className="animate-spin" />}
                {t('sync.confirmMergeOk')}
              </Btn>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
};

export default SettingsSync;
