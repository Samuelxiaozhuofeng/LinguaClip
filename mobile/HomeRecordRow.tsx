// One practiced or importing record row on phone Home: clickable even when audio is missing
// (opens Study in Read mode), shows desktop/missing-audio status, and handles web/Android repick.
import React, { useRef, useState, useSyncExternalStore } from 'react';
import type { VideoRecord } from '../types';
import { useT } from '../utils/i18n';
import { downloadRemoteAudioNow, formatAudioMB, getSyncAudioSnapshot, subscribeSyncAudio } from '../utils/syncAudio';
import { patchVideoRecord, updateVideoWith } from '../utils/videoStorage';
import { blobId } from './backup';
import { isDesktopPath } from './homeHelpers';
import { cancelImport, deleteRecord, retryImport } from './importAudio';
import { confirmPodcastDownloadNetwork } from './opml';
import { WAY_LABEL_KEY } from './phoneWays';
import type { ProbeTracksResult } from './platform/androidBridge';
import { clearAndroidJobTmp, extractAndroidRecordAudio, pickAndroidMedia } from './platform/homePlatform';
import { resumeWayOf } from './resumePos';
import { putAudio } from './store';
import { formatSyncError } from './SyncHost';
import { MAX_BYTES, NO_MEDIA } from './transcribe';
import { errText, heardPct, sourceOf } from './ui';

export interface PendingRepickTrack {
  record: VideoRecord;
  uri: string;
  probe: ProbeTracksResult;
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

export const HomeRecordRow: React.FC<{
  r: VideoRecord;
  webMissing: boolean;
  androidMissing: boolean;
  android: boolean;
  onOpen: (id: string) => void;
  onFixed: () => void;
  onNeedTrackPick: (req: PendingRepickTrack) => void;
}> = ({ r, webMissing, androidMissing, android, onOpen, onFixed, onNeedTrackPick }) => {
  const t = useT();
  const audioSnap = useSyncExternalStore(subscribeSyncAudio, getSyncAudioSnapshot);
  const job = r.importJob;
  const input = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState('');
  const [repicking, setRepicking] = useState(false);

  const remove = () => {
    if (confirm(t('m.confirmDelete', { name: r.displayName }))) deleteRecord(r.id).catch(console.error);
  };

  // PWA: store under existing blob id (or r.id for desktop-moved records); transcript stays.
  const repickWeb = (f: File) => {
    if (job && f.size > MAX_BYTES) { setErr(errText('file:toolarge')); return; }
    setErr('');
    const targetId = blobId(r.videoPath ?? job?.source) ?? r.id;
    putAudio(targetId, { blob: f, name: f.name, type: f.type }).then(async () => {
      if (!job && r.videoPath !== `blob:${targetId}`) {
        await patchVideoRecord(r.id, { videoPath: `blob:${targetId}` });
      }
      onFixed();
      if (job) retryImport(r.id).catch(console.error);
    }, (e: unknown) => setErr(t('m.errSave', { msg: e instanceof Error ? e.message : String(e) })));
  };

  // Android: probe newly picked file; if >=2 supported tracks exist, ask user to pick a track first.
  const repickAndroid = async () => {
    if (repicking) return;
    setErr('');
    setRepicking(true);
    try {
      const picked = await pickAndroidMedia();
      if (!picked) return;
      const supportedCount = picked.probe.tracks.filter(tr => tr.supported !== false).length;
      if (supportedCount >= 2) {
        onNeedTrackPick({ record: r, uri: picked.uri, probe: picked.probe });
        return;
      }
      const newPath = await extractAndroidRecordAudio(r.id, picked.uri, picked.probe.displayName, picked.probe.defaultTrackIndex);
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
  const effectiveAndroidMissing = android && (androidMissing || !!blobId(r.videoPath ?? job?.source) || (!job && !r.videoPath));
  const isMissing = android ? effectiveAndroidMissing : webMissing;
  const inProgress = !!job && !job.error;
  const canRetry = !!job?.error && !isMissing && !needsReimport && job.error !== NO_MEDIA && job.error !== 'podcast:format';

  const handleRetry = async () => {
    if (android && job && /^https?:\/\//i.test(job.source) && !job.extractedPath) {
      if (!(await confirmPodcastDownloadNetwork())) return;
    }
    retryImport(r.id).catch(console.error);
  };

  const pct = !job ? heardPct(r) : 0;
  const fromDesktop = isDesktopPath(r.videoPath ?? job?.source);
  const missingLabel = fromDesktop ? t('m.w3FromDesktopNoAudio') : t('m.w3NoAudioHere');
  const offer = android && !job && isMissing ? audioSnap.remoteAudioOffers[r.id] : undefined;
  const downloading = !!offer && audioSnap.downloadingIds.includes(r.id);
  const dlErr = offer ? audioSnap.downloadErrors[r.id] : undefined;
  const offerBadge = offer ? t('sync.audioReadyBadge', { size: formatAudioMB(offer.bytes) }) : '';
  const metaLine = err
    ? `${sourceOf(r)} · ${err}`
    : dlErr
      ? formatSyncError(dlErr, t)
      : offer
        ? pct > 0
          ? `${offerBadge} · ${t('m.doneRate', { n: pct })}`
          : offerBadge
        : isMissing
          ? r.podcast
            ? `${sourceOf(r)} · ${missingLabel}`
            : pct > 0
              ? `${missingLabel} · ${t('m.doneRate', { n: pct })}`
              : missingLabel
          : job
            ? `${sourceOf(r)} · ${job.error ? t('m.failed', { why: errText(job.error) }) : jobStageText(job, t)}`
            : `${sourceOf(r)} · ${t('m.doneRate', { n: pct })}`;
  const lastWay = !job ? resumeWayOf(r) : null;

  return (
    <li data-id={r.id} className="flex items-center border-b border-shade last:border-0">
      <button disabled={!!job} onClick={() => onOpen(r.id)} className="flex-1 min-w-0 min-h-[56px] pl-4 py-3 text-left flex flex-col gap-1">
        <span className="text-[15px] truncate">{r.displayName}</span>
        <span className="flex items-center gap-1.5 flex-wrap">
          {lastWay && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[13px] bg-shade text-mute shrink-0">
              {t('m.lastWayTag', { way: t(WAY_LABEL_KEY[lastWay]) })}
            </span>
          )}
          <span className={`text-[13px] ${job?.error || isMissing || err || dlErr ? 'text-accent' : 'text-mute'}`}>{metaLine}</span>
        </span>
      </button>
      {inProgress && (
        <button
          type="button"
          className="min-h-[44px] px-3 text-[13px] text-mute font-medium shrink-0"
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
      {offer && (
        <button
          type="button"
          data-testid="row-download-audio-btn"
          disabled={downloading || repicking}
          className="min-h-[44px] ml-1.5 px-3 rounded-[10px] bg-accent text-white text-[13px] font-medium shrink-0 whitespace-nowrap disabled:opacity-50"
          onClick={() => {
            setErr('');
            void downloadRemoteAudioNow(r.id).then(saved => { if (saved) onFixed(); });
          }}
        >
          {downloading ? t('sync.downloadingAudio') : t('sync.downloadAudio', { size: formatAudioMB(offer.bytes) })}
        </button>
      )}
      {(effectiveAndroidMissing || needsReimport) && (
        <button
          type="button"
          disabled={repicking || downloading}
          className={
            offer
              ? 'min-h-[44px] px-2 text-[13px] text-mute font-medium shrink-0 whitespace-nowrap disabled:opacity-50'
              : 'min-h-[44px] px-3 text-sm text-accent font-medium shrink-0 disabled:opacity-50'
          }
          onClick={() => { void repickAndroid(); }}
        >
          {t('m.repick')}
        </button>
      )}
      {!android && isMissing && <>
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
};
