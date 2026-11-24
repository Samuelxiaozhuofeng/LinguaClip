// Bottom batch export bar for AnkiDroid inside CardLibrary (Android native only; docs/android-roadmap.md M2.5).
// Guides the user through install / permission / first-launch initialization states, shows live
// "Sent x / y" progress, and displays a plain-language summary after completion.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ReviewCard } from '../../utils/review';
import type { ExportResult } from '../../utils/ankiExport';
import { useT } from '../../utils/i18n';
import { isAndroidNative } from '../platform/androidBridge';
import { ankiOpen, ankiRequestPermission, ankiStatus, type AnkiDroidStatus } from '../platform/ankiDroid';
import { btnPrimary, btnSoft } from '../ui';
import { buildExportSummary, classifyAnkiStatus, unsentAnkiCount } from './cardFilter';
import { getAnkiDroidExportRuntime } from './nativeRuntime';

export const AnkiExportBar: React.FC<{ cards: ReviewCard[] }> = ({ cards }) => {
  const android = isAndroidNative();
  const t = useT();
  const [status, setStatus] = useState<AnkiDroidStatus | null>(null);
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const [summary, setSummary] = useState<ExportResult | null>(null);
  const [note, setNote] = useState('');
  const [acting, setActing] = useState(false);
  const mounted = useRef(true);

  const refreshStatus = useCallback(() => {
    if (!android) return;
    ankiStatus()
      .then(s => { if (mounted.current) setStatus(s); })
      .catch(() => { if (mounted.current) setStatus({ installed: false, permitted: false, apiAvailable: false }); });
  }, [android]);

  useEffect(() => {
    mounted.current = true;
    if (!android) return () => { mounted.current = false; };
    refreshStatus();
    const onVis = () => { if (document.visibilityState === 'visible') refreshStatus(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', refreshStatus);

    let offSub: (() => void) | null = null;
    void getAnkiDroidExportRuntime().then(mod => {
      if (!mod || !mounted.current) return;
      setProgress(mod.getAnkiDroidProgress());
      offSub = mod.subscribeAnkiDroid(() => {
        if (mounted.current) setProgress(mod.getAnkiDroidProgress());
      });
    });

    return () => {
      mounted.current = false;
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', refreshStatus);
      offSub?.();
    };
  }, [android, refreshStatus]);

  if (!android) return null;

  const state = classifyAnkiStatus(status);
  const unsent = unsentAnkiCount(cards);

  const handleOpen = async () => {
    setNote('');
    setActing(true);
    try {
      await ankiOpen();
    } catch (e) {
      console.error(e);
    } finally {
      if (mounted.current) setActing(false);
    }
  };

  const handleGrant = async () => {
    setNote('');
    setActing(true);
    try {
      const res = await ankiRequestPermission();
      if (!res?.granted && mounted.current) setNote(t(res?.settings ? 'm.ankiPermSettings' : 'm.ankiPermDenied'));
      refreshStatus();
    } catch (e) {
      console.error(e);
      if (mounted.current) setNote(t('m.ankiPermDenied'));
    } finally {
      if (mounted.current) setActing(false);
    }
  };

  const handleSend = async () => {
    if (progress || unsent === 0) return;
    setNote('');
    setSummary(null);
    const mod = await getAnkiDroidExportRuntime();
    if (!mod) return;
    const res = await mod.exportToAnkiDroid(cards, (done, total) => {
      if (mounted.current) setProgress([done, total]);
    });
    if (res && mounted.current) {
      setSummary(res);
      if (res.stopped?.why === 'anki') refreshStatus();
    }
  };

  const summaryLines = summary ? buildExportSummary(summary) : null;

  return (
    <div className="shrink-0 bg-page border-t border-line px-4 pt-3 pb-[max(14px,env(safe-area-inset-bottom))] flex flex-col gap-2.5">
      {summaryLines && (
        <div role="status" className="rounded-xl bg-shade px-3.5 py-3 flex flex-col gap-1.5 text-[13px]">
          <div className="flex items-start justify-between gap-2">
            <p className="font-semibold text-ink">
              {summaryLines.headlineKey === 'm.ankiSentSummary'
                ? t('m.ankiSentSummary', { n: summaryLines.sentCount })
                : t('m.ankiSentNone')}
            </p>
            <button
              type="button"
              onClick={() => setSummary(null)}
              className="shrink-0 -mt-1 -mr-1 min-h-[36px] px-2.5 rounded-lg text-[13px] text-accent font-medium"
            >
              {t('m.ankiGotIt')}
            </button>
          </div>
          {summaryLines.notes.length > 0 && (
            <ul className="flex flex-col gap-0.5 text-mute">
              {summaryLines.notes.map(item => (
                <li key={item.key}>{t(item.key, { n: item.n })}</li>
              ))}
            </ul>
          )}
          {summaryLines.stopped && (
            <p className="text-accent leading-relaxed">
              {summaryLines.stopped.key === 'm.ankiStoppedTool'
                ? t('m.ankiStoppedTool', { err: summaryLines.stopped.err ?? '' })
                : t(summaryLines.stopped.key)}
            </p>
          )}
        </div>
      )}

      {note && <p role="alert" className="text-[12px] text-accent px-1">{note}</p>}

      {progress ? (
        <div className="flex flex-col gap-2">
          <button type="button" disabled className={`${btnPrimary} w-full`}>
            {progress[1] > 0 ? t('m.ankiSending', { done: progress[0], total: progress[1] }) : t('podcast.preparing')}
          </button>
          {progress[1] > 0 && (
            <div className="h-1 rounded-full bg-shade overflow-hidden">
              <div
                className="h-full rounded-full bg-accent transition-all"
                style={{ width: `${Math.min(100, Math.round((progress[0] / progress[1]) * 100))}%` }}
              />
            </div>
          )}
        </div>
      ) : state === 'loading' ? (
        <button type="button" disabled className={`${btnSoft} w-full min-h-[48px]`}>
          {t('m.ankiChecking')}
        </button>
      ) : state === 'not_installed' ? (
        <button type="button" disabled={acting} onClick={() => void handleOpen()} className={`${btnSoft} w-full min-h-[48px]`}>
          {t('m.ankiNeedInstall')}
        </button>
      ) : state === 'no_permission' ? (
        <button type="button" disabled={acting} onClick={() => void handleGrant()} className={`${btnPrimary} w-full`}>
          {t('m.ankiNeedPerm')}
        </button>
      ) : state === 'not_initialized' ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-[12px] text-mute text-center">{t('m.ankiNeedInitHint')}</p>
          <button type="button" disabled={acting} onClick={() => void handleOpen()} className={`${btnPrimary} w-full`}>
            {t('m.ankiNeedInit')}
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={unsent === 0}
          onClick={() => void handleSend()}
          className={`${btnPrimary} w-full`}
        >
          {unsent > 0 ? t('m.ankiSendBtn', { n: unsent }) : t('m.ankiAllSent')}
        </button>
      )}
    </div>
  );
};
