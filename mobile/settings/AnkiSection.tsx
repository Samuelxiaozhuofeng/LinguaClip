// Settings → AnkiDroid section (docs/android-roadmap.md M2.5): Android native only.
// Shows AnkiDroid installation / permission / initialization / ready status, actions,
// and auto-refreshes when returning to foreground (visibilitychange / focus).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../../utils/i18n';
import { isAndroidNative } from '../platform/androidBridge';
import { ankiOpen, ankiRequestPermission, ankiStatus, type AnkiDroidStatus } from '../platform/ankiDroid';
import { classifyAnkiStatus } from '../review/cardFilter';
import { btnSmall, btnSoft, sheet } from '../ui';

export const AnkiSection: React.FC = () => {
  const android = isAndroidNative();
  const t = useT();
  const [status, setStatus] = useState<AnkiDroidStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const alive = useRef(true);

  const refresh = useCallback(() => {
    if (!android) return;
    ankiStatus()
      .then(s => { if (alive.current) { setStatus(s); setNote(''); } })
      .catch(() => { if (alive.current) setStatus({ installed: false, permitted: false, apiAvailable: false }); });
  }, [android]);

  useEffect(() => {
    alive.current = true;
    if (!android) return () => { alive.current = false; };
    refresh();
    const onVis = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', refresh);
    return () => {
      alive.current = false;
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', refresh);
    };
  }, [android, refresh]);

  if (!android) return null;

  const state = classifyAnkiStatus(status);

  const openAnki = async () => {
    setBusy(true);
    setNote('');
    try {
      await ankiOpen();
    } catch (e) {
      console.error(e);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const requestPerm = async () => {
    setBusy(true);
    setNote('');
    try {
      const res = await ankiRequestPermission();
      if (!res?.granted && alive.current) setNote(t(res?.settings ? 'm.ankiPermSettings' : 'm.ankiPermDenied'));
      refresh();
    } catch (e) {
      console.error(e);
      if (alive.current) setNote(t('m.ankiPermDenied'));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const statusText = (() => {
    if (state === 'loading') return t('m.ankiChecking');
    if (state === 'not_installed') return t('m.ankiNotInstalled');
    if (state === 'no_permission') return t('m.ankiNoPerm');
    if (state === 'not_initialized') return t('m.ankiNotInit');
    return status?.version ? t('m.ankiReadyVer', { v: status.version }) : t('m.ankiReady');
  })();

  const statusTone = state === 'ready' ? 'text-ink font-medium' : state === 'loading' ? 'text-mute' : 'text-accent';

  return (
    <section className="flex flex-col gap-2">
      <p className="text-[13px] text-mute">{t('m.ankiTitle')}</p>
      <div className={`${sheet} px-4 py-3.5 flex flex-col gap-2.5`}>
        <p className={`text-[14px] ${statusTone}`}>{statusText}</p>
        <p className="text-xs text-mute leading-relaxed">{t('m.ankiHint')}</p>
        {note && <p role="alert" className="text-xs text-accent">{note}</p>}
        <div className="flex flex-wrap gap-2 pt-0.5">
          {state === 'not_installed' && (
            <button type="button" disabled={busy} onClick={() => void openAnki()} className={btnSmall}>
              {t('m.ankiNeedInstall')}
            </button>
          )}
          {state === 'no_permission' && (
            <button type="button" disabled={busy} onClick={() => void requestPerm()} className={btnSmall}>
              {t('m.ankiGrant')}
            </button>
          )}
          {state === 'not_initialized' && (
            <button type="button" disabled={busy} onClick={() => void openAnki()} className={btnSmall}>
              {t('m.ankiNeedInit')}
            </button>
          )}
          {state === 'ready' && (
            <button type="button" disabled={busy} onClick={() => void openAnki()} className={btnSoft}>
              {t('m.ankiOpen')}
            </button>
          )}
          <button type="button" disabled={busy} onClick={refresh} className={btnSoft}>
            {t('m.ankiRefresh')}
          </button>
        </div>
      </div>
    </section>
  );
};
