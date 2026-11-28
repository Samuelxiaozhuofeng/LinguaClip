// The phone's home (design Main.dc.html & Android M1.2/M1.3/M1.5 & 手机学习闭环):
// onboarding starter-first layout on empty library, battery-whitelist hint gated on first practice,
// Today panel + Week card, practiced records (HomeRecordRow), and key-preserving local import resume.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { VideoRecord } from '../types';
import { useT } from '../utils/i18n';
import { androidCloudArgs } from '../utils/transcribeConfig';
import { patchVideoRecord, updateVideoWith } from '../utils/videoStorage';
import { importFile, retryImport } from './importAudio';
import { groqKey } from './transcribe';
import { Starter } from './Starter';
import { audioIds } from './store';
import { blobId } from './backup';
import { hasEverPracticed, isWebAudioMissing } from './homeHelpers';
import { HomeRecordRow, type PendingRepickTrack } from './HomeRecordRow';
import { ImportSheet, TrackPickSheet, type ImportSheetConfirm } from './ImportSheet';
import { clearPendingImport, getPendingImport, savePendingAndroidImport, setPendingImportStore } from './pendingImportStore';
import { callAndroid, isAndroidNative, type ProbeTracksResult } from './platform/androidBridge';
import {
  HOME_PLATFORM,
  clearAndroidJobTmp,
  extractAndroidRecordAudio,
  pickAndroidMedia,
  pickAndroidSrt,
  startAndroidImport,
} from './platform/homePlatform';
import { subscribeWays } from './phoneWays';
import { consumeRestoreResult } from './restore';
import { sanitizeShareText } from './shareHelper';
import { TodayPanel, WeekCard } from './TodayPanel';
import { btnSmall, btnSoft, errText, sheet } from './ui';

const HINT_KEY = 'linguaclip_install_hint_closed';
const BATTERY_DISMISS_KEY = 'linguaclip_android_battery_dismissed';
const standalone = () => isAndroidNative() || window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
const ios = () => /iPhone|iPad|iPod/.test(navigator.userAgent);

function isAndroidLocalPath(path?: string): path is string {
  return !!path && !/^https?:\/\//i.test(path) && !path.startsWith('blob:') && !path.startsWith('content://');
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
    if (!isAndroidNative() || !hasEverPracticed()) { setShown(false); return; }
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
        className="min-h-[36px] px-2.5 rounded-lg bg-ink text-inverse text-[13px] font-medium shrink-0"
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

interface PendingImportState {
  uri: string;
  probe: ProbeTracksResult;
  initialLang?: string;
  initialTrackIndex?: number;
  initialSrt?: { name: string; text: string; count: number };
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
  const [restoreBanner, setRestoreBanner] = useState('');
  const [have, setHave] = useState<Set<string> | null>(null);
  const [missingAndroid, setMissingAndroid] = useState<Set<string>>(() => new Set());
  const [checkTick, setCheckTick] = useState(0);
  const [pendingImport, setPendingImport] = useState<PendingImportState | null>(null);
  const [pendingWebFile, setPendingWebFile] = useState<{ file: File; lang: string } | null>(null);
  const [repickTrack, setRepickTrack] = useState<PendingRepickTrack | null>(null);
  const [, bumpWays] = useState(0);

  useEffect(() => subscribeWays(() => bumpWays(n => n + 1)), []);

  useEffect(() => {
    const res = consumeRestoreResult();
    if (res) {
      setRestoreBanner(t(res.kind === 'undo' ? 'm.fxBkSwapped' : 'm.w3BkRestored', { videos: res.videos, cards: res.cards }));
    }
  }, [t]);

  // Resume a local import saved before jumping to Settings for a missing transcription key.
  useEffect(() => {
    const saved = getPendingImport();
    if (!saved?.waitingForKey) return;
    const hasKeyNow = android ? !!androidCloudArgs() : !!groqKey();
    if (saved.kind === 'android') {
      clearPendingImport();
      if (hasKeyNow) {
        void startAndroidImport({
          uri: saved.uri,
          displayName: sanitizeShareText(saved.probe.displayName) || 'Audio',
          trackIndex: saved.trackIndex,
          lang: saved.lang,
          ...(saved.srt ? { srtText: saved.srt.text, srtName: saved.srt.name } : {}),
        }).then(onChanged, (e: unknown) => {
          setNote(errText(e instanceof Error ? e.message : String(e)));
        });
      } else {
        setPendingImport({
          uri: saved.uri,
          probe: saved.probe,
          initialLang: saved.lang,
          initialTrackIndex: saved.trackIndex,
          initialSrt: saved.srt,
        });
      }
      return;
    }
    if (hasKeyNow) {
      clearPendingImport();
      setPendingWebFile(null);
      importFile(saved.file, saved.lang).then(onChanged, (e: unknown) => {
        const code = e instanceof Error ? e.message : String(e);
        setNote(code === 'file:toolarge' ? errText(code) : t('m.errSave', { msg: code }));
      });
    } else {
      clearPendingImport();
      setPendingWebFile({ file: saved.file, lang: saved.lang });
    }
  }, [android, onChanged, t]);

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
      setMissingAndroid(new Set(results.filter((id): id is string => !!id)));
    });
    return () => { cancelled = true; };
  }, [records, checkTick]);

  const handleRowFixed = useCallback(() => {
    loadAudio();
    onChanged();
  }, [loadAudio, onChanged]);

  const isRowMissing = (r: VideoRecord) => (
    android
      ? (missingAndroid.has(r.id) || !!blobId(r.videoPath ?? r.importJob?.source) || (!r.importJob && !r.videoPath))
      : isWebAudioMissing(r, have)
  );
  const last = records.find(r => !r.importJob && !isRowMissing(r))
    ?? records.find(r => !r.importJob && !!r.subtitleText?.trim());

  const pickWeb = (f: File, lang = 'auto') => {
    setNote('');
    setPendingWebFile(null);
    importFile(f, lang).then(onChanged, (e: unknown) => {
      const code = e instanceof Error ? e.message : String(e);
      if (code === 'cloud:nokey') {
        setPendingImportStore({ kind: 'web', file: f, lang, waitingForKey: true });
        onNeedKey();
      } else {
        setNote(code === 'file:toolarge' ? errText(code) : t('m.errSave', { msg: code }));
      }
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
      setNote(errText(e instanceof Error ? e.message : String(e)));
    }
  };

  const confirmAndroid = async (opts: ImportSheetConfirm) => {
    setNote('');
    try {
      await startAndroidImport({ ...opts, displayName: sanitizeShareText(opts.displayName) || 'Audio' });
      clearPendingImport();
      setPendingImport(null);
      onChanged();
    } catch (e: unknown) {
      const code = e instanceof Error ? e.message : String(e);
      if (code === 'cloud:nokey' || code === 'cloud:missing-url') {
        if (pendingImport) {
          savePendingAndroidImport(pendingImport.uri, pendingImport.probe, opts);
        }
        setPendingImport(null);
        if (code === 'cloud:missing-url') setNote(errText(code));
        onNeedKey();
      } else {
        setPendingImport(null);
        setNote(errText(code));
      }
    }
  };

  const finishRepickTrack = async (trackIndex: number) => {
    const req = repickTrack;
    if (!req) return;
    setRepickTrack(null);
    setNote('');
    try {
      const newPath = await extractAndroidRecordAudio(req.record.id, req.uri, req.probe.displayName, trackIndex);
      if (req.record.importJob) {
        await clearAndroidJobTmp(req.record.id).catch(console.error);
        await updateVideoWith(req.record.id, cur => (
          cur.importJob
            ? { ...cur, importJob: { ...cur.importJob, extractedPath: newPath, source: newPath, error: undefined } }
            : null
        ));
        handleRowFixed();
        retryImport(req.record.id).catch(console.error);
      } else {
        await patchVideoRecord(req.record.id, { videoPath: newPath });
        handleRowFixed();
      }
    } catch (e: unknown) {
      setNote(errText(e instanceof Error ? e.message : String(e)));
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
        {restoreBanner && (
          <div role="status" data-testid="restore-result-banner" className={`${sheet} shadow-card px-4 py-3 flex items-center gap-2 text-[13px] text-ink`}>
            <span className="flex-1">{restoreBanner}</span>
            <button type="button" aria-label={t('m.close')} className="w-9 h-9 shrink-0 flex items-center justify-center text-lg text-mute" onClick={() => setRestoreBanner('')}>×</button>
          </div>
        )}

        {pendingWebFile && (
          <div className={`${sheet} shadow-card px-4 py-3 flex items-center gap-2 text-[13px]`}>
            <span className="flex-1 text-mute truncate">{t('m.w3ResumePending', { name: pendingWebFile.file.name })}</span>
            <button type="button" className={btnSmall} onClick={() => pickWeb(pendingWebFile.file, pendingWebFile.lang)}>
              {t('m.w3ContinueImport')}
            </button>
            <button type="button" aria-label={t('m.close')} className="w-9 h-9 shrink-0 flex items-center justify-center text-lg text-mute" onClick={() => setPendingWebFile(null)}>×</button>
          </div>
        )}

        {note && <p role="alert" className="text-[13px] text-accent">{note}</p>}

        {records.length === 0 ? (
          <>
            {starter}
            <TodayPanel due={due} last={last} emptyLibrary onReview={onReview} onOpen={onOpen} onPodcast={onPodcast} />
            <WeekCard remembered={remembered} />
            <button type="button" className={`${btnSoft} w-full`} onClick={openPicker}>
              {t(android ? 'm.w3OrImportLocal' : 'm.w3OrImportAudio')}
            </button>
          </>
        ) : (
          <>
            <TodayPanel due={due} last={last} onReview={onReview} onOpen={onOpen} onPodcast={onPodcast} />
            <WeekCard remembered={remembered} />
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
                <HomeRecordRow
                  key={r.id}
                  r={r}
                  webMissing={isWebAudioMissing(r, have)}
                  androidMissing={missingAndroid.has(r.id)}
                  android={android}
                  onOpen={onOpen}
                  onFixed={handleRowFixed}
                  onNeedTrackPick={setRepickTrack}
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
          defaultLang={pendingImport.initialLang}
          initialTrackIndex={pendingImport.initialTrackIndex}
          initialSrt={pendingImport.initialSrt}
          onPickSrt={pickAndroidSrt}
          onCancel={() => { clearPendingImport(); setPendingImport(null); }}
          onConfirm={opts => { void confirmAndroid(opts); }}
        />
      )}
      {repickTrack && (
        <TrackPickSheet
          probe={repickTrack.probe}
          preferredLang={repickTrack.record.lang}
          onCancel={() => setRepickTrack(null)}
          onConfirm={idx => { void finishRepickTrack(idx); }}
        />
      )}
    </>
  );
};
