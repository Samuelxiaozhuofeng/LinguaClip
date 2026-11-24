// The phone's home (design Main.dc.html & Android M1.2/M1.3/M1.5): install tip or Android
// battery-whitelist hint, "continue" card, the practiced list with each import's stage/chunk
// progress & cancel (or "audio not on this phone" + repick), the ready-made episodes, and
// the two ways to add audio (PWA file input or Android native media/video picker + ImportSheet).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { VideoRecord } from '../types';
import { useT } from '../utils/i18n';
import { patchVideoRecord, updateVideoWith } from '../utils/videoStorage';
import { cancelImport, deleteRecord, importFile, retryImport } from './importAudio';
import { MAX_BYTES, NO_MEDIA } from './transcribe';
import { Starter } from './Starter';
import { audioIds, putAudio } from './store';
import { blobId } from './backup';
import { ImportSheet, type ImportSheetConfirm } from './ImportSheet';
import { callAndroid, isAndroidNative, type ProbeTracksResult } from './platform/androidBridge';
import {
  HOME_PLATFORM,
  clearAndroidJobTmp,
  pickAndroidMedia,
  pickAndroidSrt,
  repickAndroidRecordAudio,
  startAndroidImport,
} from './platform/homePlatform';
import { confirmPodcastDownloadNetwork } from './opml';
import { getPhoneLastWay, subscribeWays, WAY_LABEL_KEY } from './phoneWays';
import { sanitizeShareText } from './shareHelper';
import { TodayPanel, WeekCard } from './TodayPanel';
import { btnPlain, errText, heardPct, sheet, sourceOf } from './ui';

const HINT_KEY = 'linguaclip_install_hint_closed';
const BATTERY_DISMISS_KEY = 'linguaclip_android_battery_dismissed';
const standalone = () => isAndroidNative() || window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
const ios = () => /iPhone|iPad|iPod/.test(navigator.userAgent);

function isAndroidLocalPath(path?: string): path is string {
  return !!path && !/^https?:\/\//i.test(path) && !path.startsWith('blob:') && !path.startsWith('content://');
}

function jobStageText(job: NonNullable<VideoRecord['importJob']>, t: ReturnType<typeof useT>): string {
  if (job.stage === 'queued') return t('m.stageQueued');
  if (job.stage === 'download') {
    if (typeof job.percent === 'number') return t('m.stageDownload', { pct: job.percent });
    const mb = typeof job.downloadBytes === 'number' && job.downloadBytes > 0
      ? (job.downloadBytes / 1048576).toFixed(1)
      : '0.0';
    return t('m.stageDownloadBytes', { mb });
  }
  if (job.stage === 'extract') return t('m.stageExtract');
  if (job.stage === 'cloud') {
    if (job.pieceTotal && job.pieceTotal > 0) {
      return t('m.stageChunk', { done: job.pieceDone ?? 0, total: job.pieceTotal });
    }
    return t('m.transcribing');
  }
  if (job.stage === 'segment') return t('m.segmenting');
  return t('m.transcribing');
}

function InstallHint() {
  const t = useT();
  const [shown, setShown] = useState(() => !standalone() && !localStorage.getItem(HINT_KEY));
  if (!shown) return null;
  return (
    <div className="mx-5 mb-3 px-3 py-2.5 bg-page rounded-xl flex items-center gap-2.5 text-[13px] text-mute">
      <span className="flex-1">{t(ios() ? 'm.installIos' : 'm.installAndroid')}</span>
      <button aria-label={t('m.hideHint')} className="w-11 h-11 shrink-0 text-lg" onClick={() => { localStorage.setItem(HINT_KEY, '1'); setShown(false); }}>×</button>
    </div>
  );
}

function BatteryHint({ onOpenSettings }: { onOpenSettings: () => void }) {
  const t = useT();
  const [shown, setShown] = useState(false);

  const check = useCallback(() => {
    if (!isAndroidNative()) return;
    try {
      if (localStorage.getItem(BATTERY_DISMISS_KEY)) { setShown(false); return; }
    } catch { /* ignore */ }
    callAndroid<{ ignoring: boolean }>('system.isIgnoringBatteryOptimizations')
      .then(res => setShown(!res?.ignoring), () => {});
  }, []);

  useEffect(() => {
    if (!isAndroidNative()) return;
    check();
    const onVisible = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', check);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', check);
    };
  }, [check]);

  if (!shown) return null;
  const dismiss = () => {
    try { localStorage.setItem(BATTERY_DISMISS_KEY, '1'); } catch { /* ignore */ }
    setShown(false);
  };
  return (
    <div className="mx-5 mb-3 px-3 py-2.5 bg-page rounded-xl shadow-card flex items-center gap-2 text-[13px] text-mute">
      <span className="flex-1">{t('m.batteryBanner')}</span>
      <button
        type="button"
        className="min-h-[36px] px-2.5 rounded-lg bg-ink text-white text-xs font-medium shrink-0"
        onClick={onOpenSettings}
      >
        {t('m.batteryGo')}
      </button>
      <button
        type="button"
        aria-label={t('m.batteryDismiss')}
        className="w-9 h-9 shrink-0 flex items-center justify-center text-lg"
        onClick={dismiss}
      >
        ×
      </button>
    </div>
  );
}

// A finished or stopped record whose phone audio isn't stored here (restored from a backup):
// its blob id. An import still running has its file (`have` may just not be reloaded yet).
const missingId = (r: VideoRecord, have: Set<string> | null) => {
  const id = blobId(r.videoPath ?? r.importJob?.source);
  return have && id && !have.has(id) && (!r.importJob || r.importJob.error) ? id : null;
};

function Row({
  r,
  missing,
  androidMissing,
  android,
  onOpen,
  onFixed,
}: {
  r: VideoRecord;
  missing: string | null;
  androidMissing: boolean;
  android: boolean;
  onOpen: (id: string) => void;
  onFixed: () => void;
}) {
  const t = useT();
  const job = r.importJob;
  const input = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState('');
  const [repicking, setRepicking] = useState(false);

  const remove = () => {
    if (confirm(t('m.confirmDelete', { name: r.displayName }))) deleteRecord(r.id).catch(console.error);
  };

  // PWA: stored under the blob id the record already points at; transcript stays, unfinished import retries.
  const repickWeb = (f: File) => {
    if (!missing) return;
    if (job && f.size > MAX_BYTES) { setErr(errText('file:toolarge')); return; }
    setErr('');
    putAudio(missing, { blob: f, name: f.name, type: f.type }).then(() => {
      onFixed();
      if (job) retryImport(r.id).catch(console.error);
    }, (e: unknown) => setErr(t('m.errSave', { msg: e instanceof Error ? e.message : String(e) })));
  };

  // Android: extract newly picked file into private mediaDir, update path, and resume unfinished job if any.
  const repickAndroid = async () => {
    if (repicking) return;
    setErr('');
    setRepicking(true);
    try {
      const newPath = await repickAndroidRecordAudio(r.id);
      if (!newPath) return;
      if (job) {
        await clearAndroidJobTmp(r.id).catch(console.error);
        await updateVideoWith(r.id, cur => (
          cur.importJob
            ? { ...cur, importJob: { ...cur.importJob, extractedPath: newPath, source: newPath, error: undefined } }
            : null
        ));
        onFixed();
        retryImport(r.id).catch(console.error);
      } else {
        await patchVideoRecord(r.id, { videoPath: newPath });
        onFixed();
      }
    } catch (e: unknown) {
      const code = e instanceof Error ? e.message : String(e);
      setErr(errText(code));
    } finally {
      setRepicking(false);
    }
  };

  const needsReimport = android && job?.error === 'audio:reimport';
  // On Android native, blob:<id> paths restored from a PWA .json backup cannot be played by Media3;
  // route them through native repickAndroid into private media/ instead of PWA IndexedDB blob storage.
  const effectiveAndroidMissing = android && (androidMissing || !!blobId(r.videoPath ?? r.importJob?.source));
  const isMissing = !!missing || effectiveAndroidMissing;
  const inProgress = !!job && !job.error;
  const canRetry = !!job?.error && !isMissing && !needsReimport && job.error !== NO_MEDIA && job.error !== 'podcast:format';

  const handleRetry = async () => {
    if (android && job && /^https?:\/\//i.test(job.source) && !job.extractedPath) {
      if (!(await confirmPodcastDownloadNetwork())) return;
    }
    retryImport(r.id).catch(console.error);
  };

  const state = err || (isMissing ? t('m.audioGone')
    : job ? job.error ? t('m.failed', { why: errText(job.error) }) : jobStageText(job, t)
    : t('m.doneRate', { n: heardPct(r) }));
  const lastWay = !job && !isMissing ? getPhoneLastWay(r.id) : null;

  return (
    <li data-id={r.id} className="flex items-center border-b border-shade last:border-0">
      <button disabled={!!job || isMissing} onClick={() => onOpen(r.id)} className="flex-1 min-w-0 min-h-[56px] pl-4 py-3 text-left flex flex-col gap-1">
        <span className="text-[15px] truncate">{r.displayName}</span>
        <span className="flex items-center gap-1.5 flex-wrap">
          {lastWay && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] bg-shade text-mute shrink-0">
              {t('m.lastWayTag', { way: t(WAY_LABEL_KEY[lastWay]) })}
            </span>
          )}
          <span className={`text-xs ${job?.error || isMissing || err ? 'text-accent' : 'text-mute'}`}>{sourceOf(r)} · {state}</span>
        </span>
      </button>
      {inProgress && (
        <button
          type="button"
          className="min-h-[44px] px-3 text-xs text-mute font-medium shrink-0"
          onClick={() => cancelImport(r.id)}
        >
          {t('m.cancel')}
        </button>
      )}
      {canRetry && (
        <button
          type="button"
          className="min-h-[44px] px-3 text-sm text-accent font-medium shrink-0"
          onClick={() => { void handleRetry(); }}
        >
          {t('m.retry')}
        </button>
      )}
      {(effectiveAndroidMissing || needsReimport) && (
        <button
          type="button"
          disabled={repicking}
          className="min-h-[44px] px-3 text-sm text-accent font-medium shrink-0 disabled:opacity-50"
          onClick={() => { void repickAndroid(); }}
        >
          {t('m.repick')}
        </button>
      )}
      {!effectiveAndroidMissing && !needsReimport && missing && <>
        <button
          type="button"
          className="min-h-[44px] px-3 text-sm text-accent font-medium shrink-0"
          onClick={() => input.current?.click()}
        >
          {t('m.repick')}
        </button>
        <input ref={input} type="file" accept="audio/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) repickWeb(f); }} />
      </>}
      <button aria-label={t('m.more')} className="w-11 h-11 mr-1 text-mute shrink-0" onClick={remove}>…</button>
    </li>
  );
}

export const Home: React.FC<{
  records: VideoRecord[];
  due: number;
  remembered: number;
  onOpen: (id: string) => void;
  onReview: () => void;
  onPodcast: () => void;
  onNeedKey: () => void;
  onOpenSettings: () => void;
  onChanged: () => void;
}> = ({ records, due, remembered, onOpen, onReview, onPodcast, onNeedKey, onOpenSettings, onChanged }) => {
  const t = useT();
  const android = HOME_PLATFORM === 'android' || isAndroidNative();
  const input = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState('');
  const [have, setHave] = useState<Set<string> | null>(null); // PWA audio stored here; null = unknown, nothing flagged
  const [missingAndroid, setMissingAndroid] = useState<Set<string>>(() => new Set());
  const [checkTick, setCheckTick] = useState(0);
  const [pendingImport, setPendingImport] = useState<{ uri: string; probe: ProbeTracksResult } | null>(null);
  const [, bumpWays] = useState(0);

  useEffect(() => subscribeWays(() => bumpWays(n => n + 1)), []);

  const loadAudio = useCallback(() => {
    audioIds().then(ids => setHave(new Set(ids)), console.error);
    setCheckTick(n => n + 1);
  }, []);
  useEffect(loadAudio, [records, loadAudio]);

  useEffect(() => {
    if (!isAndroidNative()) return;
    let cancelled = false;
    const targets: { id: string; path: string }[] = [];
    for (const r of records) {
      if (r.importJob && !r.importJob.error) continue;
      const p = r.importJob ? r.importJob.extractedPath : r.videoPath;
      if (isAndroidLocalPath(p)) targets.push({ id: r.id, path: p });
    }
    if (targets.length === 0) {
      setMissingAndroid(prev => (prev.size === 0 ? prev : new Set()));
      return;
    }
    Promise.all(targets.map(async item => {
      try {
        const info = await callAndroid<{ exists: boolean }>('media.fileInfo', { path: item.path });
        return info?.exists ? null : item.id;
      } catch {
        return null;
      }
    })).then(results => {
      if (cancelled) return;
      const next = new Set(results.filter((id): id is string => !!id));
      setMissingAndroid(next);
    });
    return () => { cancelled = true; };
  }, [records, checkTick]);

  const handleRowFixed = useCallback(() => {
    loadAudio();
    onChanged();
  }, [loadAudio, onChanged]);

  const last = records.find(r => !r.importJob && r.videoPath && !missingId(r, have) && !missingAndroid.has(r.id) && !(android && blobId(r.videoPath)));

  const pickWeb = (f: File) => {
    setNote('');
    importFile(f, 'auto').then(onChanged, (e: unknown) => {
      const code = e instanceof Error ? e.message : String(e);
      if (code === 'cloud:nokey') onNeedKey();
      else setNote(code === 'file:toolarge' ? errText(code) : t('m.errSave', { msg: code }));
    });
  };

  const pickAndroid = async () => {
    setNote('');
    try {
      const picked = await pickAndroidMedia();
      if (!picked) return;
      const safeName = sanitizeShareText(picked.probe.displayName) || picked.probe.displayName;
      setPendingImport({ uri: picked.uri, probe: { ...picked.probe, displayName: safeName } });
    } catch (e: unknown) {
      const code = e instanceof Error ? e.message : String(e);
      setNote(errText(code));
    }
  };

  const confirmAndroid = async (opts: ImportSheetConfirm) => {
    setNote('');
    try {
      await startAndroidImport({ ...opts, displayName: sanitizeShareText(opts.displayName) || 'Audio' });
      setPendingImport(null);
      onChanged();
    } catch (e: unknown) {
      const code = e instanceof Error ? e.message : String(e);
      setPendingImport(null);
      if (code === 'cloud:nokey') {
        onNeedKey();
      } else if (code === 'cloud:missing-url') {
        setNote(errText(code));
        onNeedKey();
      } else {
        setNote(errText(code));
      }
    }
  };

  const starter = <Starter records={records} onOpen={onOpen} onChanged={onChanged} />;
  const openPicker = () => {
    if (android) void pickAndroid();
    else input.current?.click();
  };

  return (
    <>
      <InstallHint />
      <BatteryHint onOpenSettings={onOpenSettings} />
      <div className="flex-1 px-5 flex flex-col gap-4 pb-6">
        <TodayPanel due={due} last={last} onReview={onReview} onOpen={onOpen} onPodcast={onPodcast} />
        <WeekCard remembered={remembered} />

        {note && <p role="alert" className="text-[13px] text-accent">{note}</p>}

        {records.length === 0 ? (
          <>
            <button type="button" className={`${btnPlain} w-full`} onClick={openPicker}>
              {t(android ? 'm.pickMedia' : 'm.pickFile')}
            </button>
            {starter}
          </>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2 mt-1">
              <p className="text-[13px] text-mute">{t('m.myMaterials')}</p>
              <button
                type="button"
                onClick={openPicker}
                className="min-h-[44px] px-3.5 rounded-full bg-page shadow-card text-[13px] font-medium text-ink"
              >
                + {t(android ? 'm.pickMedia' : 'm.pickFile')}
              </button>
            </div>
            <ul className={`${sheet} shadow-card flex flex-col`}>
              {records.map(r => (
                <Row
                  key={r.id}
                  r={r}
                  missing={missingId(r, have)}
                  androidMissing={missingAndroid.has(r.id)}
                  android={android}
                  onOpen={onOpen}
                  onFixed={handleRowFixed}
                />
              ))}
            </ul>
            <div className="mt-2">{starter}</div>
          </>
        )}
      </div>
      {!android && (
        <input ref={input} type="file" accept="audio/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) pickWeb(f); }} />
      )}
      {pendingImport && (
        <ImportSheet
          key={pendingImport.uri}
          uri={pendingImport.uri}
          probe={pendingImport.probe}
          onPickSrt={pickAndroidSrt}
          onCancel={() => setPendingImport(null)}
          onConfirm={opts => { void confirmAndroid(opts); }}
        />
      )}
    </>
  );
};
