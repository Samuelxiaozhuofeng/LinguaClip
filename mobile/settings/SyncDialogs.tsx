// Bottom-sheet dialogs for Settings → Cross-Device Sync:
// desktop pairing-code paste, WebDAV configuration, safety merge confirmation,
// and offline sync-pack preview. Zero @tauri-apps/* imports (PWA-safe).
import React, { useEffect, useRef, useState } from 'react';
import { useLang, useT } from '../../utils/i18n';
import { JIANGUOYUN_URL, decodePairCode, isSafeWebDavUrl, type WebDavConfig } from '../../utils/syncConfig';
import { disableSync, testAndEnableSync, type OfflineMergePreview } from '../../utils/syncEngine';
import type { SafetyAlert } from '../../utils/syncTypes';
import { pushBackClose } from '../backClose';
import { formatSyncError } from '../SyncHost';
import { btnPlain, btnPrimary, btnSoft } from '../ui';

const field = 'h-11 rounded-[10px] border border-line px-3 text-[15px] w-full bg-page outline-none focus:border-ink';

function useGuardedBackClose(open: boolean, busy: boolean, onClose: () => void): void {
  const refs = useRef({ busy, onClose });
  refs.current = { busy, onClose };
  useEffect(() => {
    if (!open) return;
    let remove = () => {};
    const register = () => {
      remove = pushBackClose(() => { if (refs.current.busy) register(); else refs.current.onClose(); });
    };
    register();
    return () => remove();
  }, [open]);
}

const SheetShell: React.FC<{
  open: boolean; busy: boolean; label: string; testId: string; onClose: () => void; children: React.ReactNode;
}> = ({ open, busy, label, testId, onClose, children }) => {
  useGuardedBackClose(open, busy, onClose);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[80] bg-black/40 flex items-end justify-center" onClick={() => { if (!busy) onClose(); }}>
      <div
        role="dialog" aria-modal="true" aria-label={label} data-testid={testId}
        className="w-full max-w-lg max-h-[85vh] supports-[height:1dvh]:max-h-[85dvh] overflow-y-auto bg-page rounded-t-3xl px-5 pt-5 pb-[max(20px,env(safe-area-inset-bottom))] shadow-xl flex flex-col gap-3.5"
        onClick={e => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
};

const StatCard: React.FC<{ label: string; value: string; accent?: boolean }> = ({ label, value, accent }) => (
  <div className="rounded-xl bg-shade px-3.5 py-3 flex flex-col gap-1">
    <span className="text-[12px] text-mute">{label}</span>
    <span className={`text-[14px] font-semibold tabular-nums ${accent ? 'text-accent' : 'text-ink'}`}>{value}</span>
  </div>
);

const SheetActions: React.FC<{
  busy: boolean; confirmDisabled?: boolean; cancelLabel: string; confirmLabel: string; onCancel: () => void; onConfirm: () => void;
}> = ({ busy, confirmDisabled, cancelLabel, confirmLabel, onCancel, onConfirm }) => (
  <div className="grid grid-cols-2 gap-2.5 pt-1">
    <button type="button" disabled={busy} onClick={onCancel} className={btnPlain}>{cancelLabel}</button>
    <button type="button" disabled={busy || confirmDisabled} onClick={onConfirm} className={btnPrimary}>{confirmLabel}</button>
  </div>
);

export const PastePairSheet: React.FC<{
  open: boolean; onClose: () => void; onApplied: (msg: string) => void;
}> = ({ open, onClose, onApplied }) => {
  const t = useT();
  const lang = useLang();
  const [raw, setRaw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => { if (open) { setRaw(''); setErr(''); setBusy(false); } }, [open]);
  const parsed = raw.trim() ? decodePairCode(raw) : null;
  const invalid = raw.trim().length > 0 && !parsed;

  const readClipboard = async () => {
    setErr('');
    try { const text = await navigator.clipboard?.readText?.(); if (text) setRaw(text.trim()); }
    catch { /* user can paste manually */ }
  };

  const apply = async () => {
    if (!parsed || busy) return;
    setBusy(true); setErr('');
    try {
      const res = await testAndEnableSync({ ...parsed, wifiOnlyAudio: parsed.wifiOnlyAudio ?? true, enabled: true });
      const msg = res.existingDevices > 0 ? t('sync.connectedWithPeers', { n: res.existingDevices }) : t('sync.connected');
      onApplied(msg);
      onClose();
    } catch (e) { setErr(formatSyncError(e, t)); }
    finally { setBusy(false); }
  };

  return (
    <SheetShell open={open} busy={busy} label={t('sync.pairPasteTitle')} testId="sync-paste-sheet" onClose={onClose}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[18px] font-semibold text-ink">{t('sync.pairPasteTitle')}</h2>
        {typeof navigator !== 'undefined' && !!navigator.clipboard?.readText && (
          <button type="button" disabled={busy} onClick={() => void readClipboard()} className={btnSoft}>
            {lang === 'zh' ? '从剪贴板读取' : 'Read clipboard'}
          </button>
        )}
      </div>
      <textarea
        rows={3} value={raw} disabled={busy} placeholder={t('sync.pairPastePlaceholder')}
        autoCapitalize="off" autoCorrect="off" spellCheck={false}
        onChange={e => { setRaw(e.target.value); setErr(''); }}
        className="rounded-xl border border-line px-3.5 py-2.5 text-[14px] font-mono bg-page outline-none focus:border-ink resize-none"
      />
      {invalid && <p role="alert" className="text-[13px] text-accent">{t('sync.pairPasteBad')}</p>}
      {parsed && (
        <div className="rounded-xl bg-shade px-3.5 py-3 text-[13px] text-ink whitespace-pre-line break-all leading-relaxed">
          {t('sync.pairPreview', { url: parsed.url, user: parsed.username, dir: parsed.rootDir || 'LinguaClip' })}
        </div>
      )}
      {err && <p role="alert" className="text-[13px] text-accent leading-relaxed">{err}</p>}
      <SheetActions
        busy={busy} confirmDisabled={!parsed} cancelLabel={t('sync.cancel')}
        confirmLabel={busy ? t('sync.testing') : t('sync.pairApply')} onCancel={onClose} onConfirm={() => void apply()}
      />
    </SheetShell>
  );
};

export const ConfigSyncSheet: React.FC<{
  open: boolean; initial: WebDavConfig; onClose: () => void; onSaved: (msg: string) => void; onDisabled: () => void;
}> = ({ open, initial, onClose, onSaved, onDisabled }) => {
  const t = useT();
  const [form, setForm] = useState<WebDavConfig>(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => { if (open) { setForm(initial); setErr(''); setBusy(false); } }, [open, initial]);

  const setPreset = (preset: 'jianguoyun' | 'custom') => {
    setErr('');
    setForm(prev => ({
      ...prev, preset,
      url: preset === 'jianguoyun' ? JIANGUOYUN_URL : (prev.url === JIANGUOYUN_URL ? '' : prev.url),
    }));
  };

  const canSubmit = !!form.url.trim() && !!form.username.trim() && !!form.password;
  const submit = async () => {
    if (busy || !canSubmit) return;
    const cfg: WebDavConfig = {
      ...form,
      url: form.url.trim(),
      username: form.username.trim(),
      rootDir: form.rootDir.trim() || 'LinguaClip',
      wifiOnlyAudio: form.wifiOnlyAudio ?? true,
      enabled: true,
    };
    if (!isSafeWebDavUrl(cfg.url)) { setErr(t('sync.errInsecure')); return; }
    setBusy(true); setErr('');
    try {
      const res = await testAndEnableSync(cfg);
      onSaved(res.existingDevices > 0 ? t('sync.connectedWithPeers', { n: res.existingDevices }) : t('sync.connected'));
      onClose();
    } catch (e) { setErr(formatSyncError(e, t)); }
    finally { setBusy(false); }
  };

  const turnOff = () => { if (busy) return; disableSync(); onDisabled(); onClose(); };
  const inputRow = (label: string, key: 'url' | 'username' | 'password' | 'rootDir', type: string, placeholder?: string) => (
    <label className="flex flex-col gap-1">
      <span className="text-[13px] text-mute">{label}</span>
      <input type={type} className={field} value={form[key]} disabled={busy} placeholder={placeholder}
        autoCapitalize="off" autoCorrect="off" spellCheck={false}
        onChange={e => { setForm(f => ({ ...f, [key]: e.target.value })); setErr(''); }} />
    </label>
  );

  return (
    <SheetShell open={open} busy={busy} label={t('sync.configure')} testId="sync-config-sheet" onClose={onClose}>
      <h2 className="text-[18px] font-semibold text-ink">{t('sync.title')}</h2>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t('sync.presetLabel')}>
        {(['jianguoyun', 'custom'] as const).map(p => (
          <button key={p} type="button" role="radio" aria-checked={form.preset === p} disabled={busy} onClick={() => setPreset(p)}
            className={`min-h-[40px] px-3.5 rounded-full text-[13px] ${form.preset === p ? 'bg-ink text-white font-medium' : 'bg-shade text-mute'}`}>
            {t(p === 'jianguoyun' ? 'sync.presetJianguoyun' : 'sync.presetCustom')}
          </button>
        ))}
      </div>
      <p className="rounded-xl bg-shade px-3.5 py-2.5 text-[12px] text-mute whitespace-pre-line leading-relaxed">
        {t(form.preset === 'jianguoyun' ? 'sync.jianguoyunGuide' : 'sync.customGuide')}
      </p>
      <div className="flex flex-col gap-3">
        {inputRow(t('sync.url'), 'url', 'url', 'https://dav.example.com/dav/')}
        {inputRow(t('sync.username'), 'username', 'text')}
        {inputRow(t('sync.password'), 'password', 'password')}
        {inputRow(t('sync.rootDir'), 'rootDir', 'text', 'LinguaClip')}
        <label className="pt-1 flex items-start justify-between gap-3">
          <span className="flex flex-col gap-0.5">
            <span className="text-[14px] text-ink">{t('sync.syncClips')}</span>
            <span className="text-[12px] text-mute leading-relaxed">{t('sync.syncClipsHint')}</span>
          </span>
          <input type="checkbox" checked={form.syncClips} disabled={busy} className="w-5 h-5 mt-0.5 shrink-0 accent-accent"
            onChange={e => setForm(f => ({ ...f, syncClips: e.target.checked }))} />
        </label>
        <label className={`flex items-center justify-between gap-3 ${form.syncClips ? '' : 'opacity-50'}`}>
          <span className="text-[14px] text-ink">{t('sync.wifiOnlyClips')}</span>
          <input type="checkbox" checked={form.wifiOnlyClips} disabled={busy || !form.syncClips} className="w-5 h-5 shrink-0 accent-accent"
            onChange={e => setForm(f => ({ ...f, wifiOnlyClips: e.target.checked }))} />
        </label>
        <label className="pt-1 flex items-start justify-between gap-3">
          <span className="flex flex-col gap-0.5">
            <span className="text-[14px] text-ink">{t('sync.wifiOnlyAudio')}</span>
            <span className="text-[12px] text-mute leading-relaxed">{t('sync.wifiOnlyAudioHint')}</span>
          </span>
          <input type="checkbox" checked={form.wifiOnlyAudio ?? true} disabled={busy} className="w-5 h-5 mt-0.5 shrink-0 accent-accent"
            onChange={e => setForm(f => ({ ...f, wifiOnlyAudio: e.target.checked }))} />
        </label>
      </div>
      {err && <p role="alert" className="text-[13px] text-accent leading-relaxed">{err}</p>}
      <div className="flex flex-col gap-2 pt-1">
        <button type="button" disabled={busy || !canSubmit} onClick={() => void submit()} className={`${btnPrimary} w-full`}>
          {busy ? t('sync.testing') : t('sync.testAndEnable')}
        </button>
        <div className="flex gap-2">
          {initial.enabled && (
            <button type="button" disabled={busy} onClick={turnOff} className={`${btnSoft} flex-1 min-h-[48px] text-accent`}>
              {t('sync.disable')}
            </button>
          )}
          <button type="button" disabled={busy} onClick={onClose} className={`${btnPlain} flex-1`}>{t('sync.cancel')}</button>
        </div>
      </div>
    </SheetShell>
  );
};

export const SafetyConfirmSheet: React.FC<{
  alert: SafetyAlert | null; busy: boolean; onConfirm: () => void; onCancel: () => void;
}> = ({ alert, busy, onConfirm, onCancel }) => {
  const t = useT();
  const lang = useLang();
  const isFirst = alert?.kind === 'firstSync';
  return (
    <SheetShell open={!!alert} busy={busy} label={t(isFirst ? 'sync.firstSyncTitle' : 'sync.massDelTitle')} testId="sync-safety-sheet" onClose={onCancel}>
      {alert && (
        <>
          <h2 className="text-[18px] font-semibold text-ink">{t(isFirst ? 'sync.firstSyncTitle' : 'sync.massDelTitle')}</h2>
          <div className="grid grid-cols-2 gap-2.5">
            <StatCard label={t('m.w3BkNowLabel')} value={t('m.w3BkCounts', { videos: alert.localVideos, cards: alert.localCards })} />
            <StatCard
              accent={!isFirst}
              label={isFirst ? (lang === 'zh' ? '预计新增' : 'To add') : (lang === 'zh' ? '预计移除' : 'To remove')}
              value={isFirst
                ? t('m.w3BkCounts', { videos: alert.summary.addedVideos, cards: alert.summary.addedCards })
                : t('m.w3BkCounts', { videos: alert.dropVideos, cards: alert.dropCards })}
            />
          </div>
          <p className="text-[14px] text-mute leading-relaxed">
            {isFirst
              ? t('sync.firstSyncBody', { localVideos: alert.localVideos, localCards: alert.localCards, addV: alert.summary.addedVideos, addC: alert.summary.addedCards })
              : t('sync.massDelBody', { dropV: alert.dropVideos, dropC: alert.dropCards, localVideos: alert.localVideos, localCards: alert.localCards })}
          </p>
          <SheetActions
            busy={busy} cancelLabel={t('sync.cancel')} confirmLabel={busy ? t('sync.syncing') : t('sync.confirmMergeOk')}
            onCancel={onCancel} onConfirm={onConfirm}
          />
        </>
      )}
    </SheetShell>
  );
};

export const PackPreviewSheet: React.FC<{
  preview: OfflineMergePreview | null; busy: boolean; onConfirm: () => void; onCancel: () => void;
}> = ({ preview, busy, onConfirm, onCancel }) => {
  const t = useT();
  const lang = useLang();
  return (
    <SheetShell open={!!preview} busy={busy} label={t('sync.packPreviewTitle')} testId="sync-pack-sheet" onClose={onCancel}>
      {preview && (
        <>
          <h2 className="text-[18px] font-semibold text-ink">{t('sync.packPreviewTitle')}</h2>
          <div className="grid grid-cols-2 gap-2.5">
            <StatCard label={t('m.w3BkNowLabel')} value={t('m.w3BkCounts', { videos: preview.localVideos, cards: preview.localCards })} />
            <StatCard label={lang === 'zh' ? '同步包里' : 'In sync pack'} value={t('m.w3BkCounts', { videos: preview.peerVideos, cards: preview.peerCards })} />
          </div>
          <p className="text-[14px] text-mute whitespace-pre-line leading-relaxed">
            {t('sync.packPreviewBody', {
              addV: preview.summary.addedVideos, updV: preview.summary.updatedVideos,
              addC: preview.summary.addedCards, updC: preview.summary.updatedCards,
            })}
          </p>
          {preview.safetyAlert?.massDeletion && (
            <p role="alert" className="text-[13px] text-accent leading-relaxed">
              {t('sync.massDelBody', {
                dropV: preview.safetyAlert.dropVideos, dropC: preview.safetyAlert.dropCards,
                localVideos: preview.safetyAlert.localVideos, localCards: preview.safetyAlert.localCards,
              })}
            </p>
          )}
          {preview.newerFormat && <p role="alert" className="text-[13px] text-accent leading-relaxed">{t('sync.newerFormat')}</p>}
          <SheetActions
            busy={busy} cancelLabel={t('sync.cancel')} confirmLabel={busy ? t('sync.syncing') : t('sync.confirmMergeOk')}
            onCancel={onCancel} onConfirm={onConfirm}
          />
        </>
      )}
    </SheetShell>
  );
};
