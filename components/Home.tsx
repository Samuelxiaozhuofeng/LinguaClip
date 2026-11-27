import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MoreHorizontal, Loader2, Play } from 'lucide-react';
import { LearningMode, VideoRecord } from '../types';
import * as VideoStorage from '../utils/videoStorage';
import { forgetCustomPos, forgetWatchPos, getLastWay, getLibraryFilter, getPracticeConfig, getWatchPos, saveLibraryFilter, setLastWay, type LibraryFilter } from '../utils/storage';
import { ShelfPos, cardFinished, cardWhere, lastWayName, lastWaySec } from '../utils/lastWayCard';
import { parseSRT } from '../utils/srtParser';
import { buildSections, sectionAt, sectionLengthOf } from '../utils/sections';
import { fileNameFromPath, isAudioRecord, isVideoFile, listenDragDrop, trashFile, relatedFilePaths, cacheFilePaths } from '../utils/desktop';
import { cancelImport, canConvertRetry, canYouTubeLogin, formatImportError, openYouTubeLogin, retryImport, subscribeImportJobs } from '../utils/importJob';
import { Btn, Menu, MenuItem, Seg, inputCls } from './ui';
import { DECK_LANGS, langName, videoLang } from '../utils/deckLang';
import type { DictLang } from '../utils/dictionary';
import VideoCover from './VideoCover';
import { dialog } from './Dialog';
import { useT, useLang, type DictKey } from '../utils/i18n';
import AddVideo from './AddVideo';
import { canCloze } from '../utils/aiDrills';
import { cancelPrep, getPrepJob, prepStatus, prepareBreakdowns, subscribePrep } from '../utils/breakdownPrep';
import { cancelLevels } from '../utils/levelPrep';
import { forgetKeywords } from '../utils/keywordPrep';
import { forgetPhrases } from '../utils/phrasePrep';
import { cancelTrans, Listen, PodcastPicker, podcastRate } from '@pro';
import { forgetLooked } from '../utils/readLooked';
import { forgetMask } from '../utils/subtitleMask';
import { cancelCloze, clozeStatus, getClozeJob, linesOf, prepareCloze, subscribeCloze } from '../utils/clozePrep';
import { cancelSegments, getSegJob, subscribeSeg } from '../utils/jaSegments';
import { deckCounts, deleteVideoCards, getAllCards, keepOrphans, subscribeCards } from '../utils/review';
import { clipVideoNow } from '../utils/clips';
import { subscribeSyncApplied } from '../utils/syncEngine';
import WeekStats from './WeekStats';
import TodayBar from './TodayBar';
import HomeEmpty from './HomeEmpty';

// Unified Learn shelf: videos, audio files, and podcast episodes in one place with an
// All / Videos / Podcasts filter. The most recent item leads as a big frame with its play
// strip; the rest are covers. Everything else (mode switch, AI prep, delete) waits in "…".

interface HomeProps {
  onResume: (record: VideoRecord, mode: LearningMode, practiceOnly?: boolean) => void | Promise<void>;
  onOtherWay: (record: VideoRecord) => void; // "…" → another way: the start panel
  onEmptyChange?: (empty: boolean) => void;
  addAsked?: boolean; // top bar "+ Add → Video / audio file"
  onAddHandled?: () => void;
  podcastAsked?: boolean; // top bar "+ Add → Find podcasts"
  onPodcastHandled?: () => void;
}

type PrepInfo = { eligible: number; missing: number };
const SRT_EXT = /\.srt$/i;
const STAGE_KEYS: Record<NonNullable<VideoRecord['importJob']>['stage'], DictKey> = {
  queued: 'import.stageQueued', setup: 'import.stageSetup', ytSetup: 'import.stageYtSetup',
  convertSetup: 'import.stageConvertSetup', convert: 'import.stageConvert', download: 'import.stageDownload',
  transcribe: 'import.stageTranscribe', cloud: 'import.stageCloud', retranscribe: 'import.stageRetranscribe',
  segment: 'import.stageSegment', extract: 'import.stageExtract',
};

const Line: React.FC<{ pct: number; className?: string }> = ({ pct, className = '' }) => (
  <div className={`h-[2px] bg-line ${className}`}>
    <div className="h-full bg-mute" style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
  </div>
);

const Home: React.FC<HomeProps> = ({ onResume, onOtherWay, onEmptyChange, addAsked, onAddHandled, podcastAsked, onPodcastHandled }) => {
  const t = useT();
  const lang = useLang();
  const [videos, setVideos] = useState<VideoRecord[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [filter, setFilterState] = useState<LibraryFilter>(getLibraryFilter);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ path: string | null; srt?: string | null } | null>(null);
  const [pickingPodcast, setPickingPodcast] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [prep, setPrep] = useState<Map<string, PrepInfo>>(new Map());
  const [cloze, setCloze] = useState<Map<string, PrepInfo>>(new Map());
  const [prepTick, setPrepTick] = useState(0);

  const setFilter = useCallback((f: LibraryFilter) => { setFilterState(f); saveLibraryFilter(f); }, []);
  const knownIds = useRef<Set<string> | null>(null);
  const allEmpty = videos !== null && videos.length === 0;
  useEffect(() => { onEmptyChange?.(allEmpty); }, [allEmpty, onEmptyChange]);
  // Never let a remembered filter hide a newly added item or linger on an empty library.
  useEffect(() => {
    if (!videos) return;
    const ids = new Set(videos.map(v => v.id));
    if (knownIds.current) {
      const added = videos.filter(v => !knownIds.current!.has(v.id));
      if (added.length && ((filter === 'podcast' && added.some(v => !v.podcast)) || (filter === 'video' && added.some(v => !!v.podcast)))) {
        setFilter('all');
      }
    }
    knownIds.current = ids;
    if (videos.length === 0 && filter !== 'all') setFilter('all');
  }, [videos, filter, setFilter]);
  useEffect(() => {
    if (!addAsked) return;
    setPickingPodcast(false); setAdding(prev => prev ?? { path: null }); onAddHandled?.();
  }, [addAsked, onAddHandled]);
  useEffect(() => {
    if (!podcastAsked) return;
    if (PodcastPicker) { setAdding(null); setPickingPodcast(true); }
    onPodcastHandled?.();
  }, [podcastAsked, onPodcastHandled]);

  const hasAi = canCloze();
  const sectionLength = getPracticeConfig().sectionLength;

  const shelfPosition = useMemo(() => {
    const byId = new Map<string, ShelfPos>();
    for (const v of videos ?? []) {
      if (v.importJob || !v.subtitleText) continue;
      try {
        const subs = parseSRT(v.subtitleText);
        const way = getLastWay(v.id);
        const customSec = lastWaySec(v.id, way);
        const end = subs[subs.length - 1]?.endTime ?? 0;
        const sections = buildSections(subs, sectionLengthOf(v));
        if (sections.length === 0) continue;
        if (v.podcast && Listen) {
          byId.set(v.id, { part: sectionAt(sections, getWatchPos(v.id)), parts: sections.length, line: 0, lines: 0, listen: true });
          continue;
        }
        const part = Math.min(Math.max(v.currentSectionIndex, 0), sections.length - 1);
        const lines = sections[part].subtitles.length;
        byId.set(v.id, {
          part, parts: sections.length, line: Math.min(Math.max(v.currentSubtitleIndex, 0), lines), lines,
          ...(customSec !== undefined ? { customSec, customPct: end ? Math.min(100, customSec / end * 100) : 0, watch: way === 'watch', read: way === 'read' } : {}),
        });
      } catch { /* a record we cannot parse just falls back to percent */ }
    }
    return byId;
  }, [videos, sectionLength]);

  const loadVideos = useCallback(() => {
    setLoadFailed(false);
    VideoStorage.getAllVideoRecords().then(setVideos).catch(err => { console.error(err); setLoadFailed(true); });
  }, []);
  useEffect(() => {
    loadVideos();
    const offImport = subscribeImportJobs(loadVideos), offSync = subscribeSyncApplied(loadVideos);
    return () => { offImport(); offSync(); };
  }, [loadVideos]);

  // Global drag-and-drop works regardless of the active filter tab.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listenDragDrop({
      onHover: () => setDragOver(true),
      onLeave: () => setDragOver(false),
      onDrop: (paths) => {
        setDragOver(false);
        const video = paths.find(isVideoFile);
        const srt = paths.find(p => SRT_EXT.test(fileNameFromPath(p)));
        if (video || srt) {
          setPickingPodcast(false);
          setAdding(prev => ({ path: video ?? prev?.path ?? null, srt: srt ?? prev?.srt ?? null }));
        }
      },
    }).then(fn => { if (cancelled) fn(); else unlisten = fn; });
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  const [remembered, setRemembered] = useState(0);
  useEffect(() => {
    const load = () => getAllCards().then(cards => setRemembered(deckCounts(cards).line.remembered)).catch(() => {});
    load();
    return subscribeCards(load);
  }, []);

  useEffect(() => {
    const bump = () => setPrepTick(n => n + 1);
    const offs = [subscribePrep(bump), subscribeCloze(bump), subscribeSeg(bump)];
    return () => offs.forEach(off => off());
  }, []);

  const statusSeq = useRef({ started: 0, applied: 0 });
  useEffect(() => {
    if (!hasAi || !videos) return;
    const seq = statusSeq.current, mine = ++seq.started;
    const ready = videos.filter(v => !v.importJob && v.subtitleText);
    Promise.all(ready.map(async v => [v.id, await prepStatus(v.id, v.subtitleText, lang), await clozeStatus(v.id, v.subtitleText)] as const))
      .then(rows => {
        if (mine < seq.applied) return;
        seq.applied = mine;
        setPrep(new Map(rows.map(([id, b]) => [id, b])));
        setCloze(new Map(rows.map(([id, , c]) => [id, c])));
      })
      .catch(() => {});
  }, [videos, lang, hasAi, prepTick]);

  const closeAdd = useCallback(() => { setAdding(null); loadVideos(); }, [loadVideos]);
  const closePodcast = useCallback(() => { setPickingPodcast(false); loadVideos(); }, [loadVideos]);

  const handleYouTubeLogin = async () => {
    try {
      await openYouTubeLogin();
      dialog.alert(t('home.ytLoginTitle'), t('home.ytLoginBody'));
    } catch (e) {
      dialog.alert(t('home.ytLoginFailTitle'), String(e).includes('missing:') ? t('home.ytLoginNoChrome') : t('home.ytLoginFailBody'));
    }
  };

  const handleRetry = async (v: VideoRecord, convert = false) => {
    setRetryingId(v.id);
    try { await retryImport(v.id, convert); }
    catch (e) { console.error(e); dialog.alert(t('home.retryFailTitle'), t('home.retryFailBody')); }
    finally { setRetryingId(null); }
  };

  const handleDelete = async (v: VideoRecord) => {
    setDeletingId(v.id);
    const clipped = await clipVideoNow(v.id).catch(() => 0);
    setDeletingId(null);
    const mine = await getAllCards().then(cs => cs.filter(c => c.videoId === v.id)).catch(() => null);
    const n = mine ? mine.length : -1;
    const cardsNote = clipped ? '' : n > 0 ? ' ' + t('home.deleteHasCards', { n }) : n < 0 ? ' ' + t('home.deleteCardsUnknown') : '';
    const audio = isAudioRecord(v);
    const ok = await dialog.confirm(t(v.podcast ? 'home.deleteEpTitle' : audio ? 'home.deleteAudioTitle' : 'home.deleteTitle'), t('home.deleteBody', { name: v.displayName }) + cardsNote, { ok: t('home.deleteOk'), danger: true });
    if (!ok) return;
    const keepCards = clipped > 0 && await dialog.confirm(t('home.keepCardsTitle'), t(clipped === n ? 'home.keepCardsBodyAll' : 'home.keepCardsBody', { n, rest: n - clipped }), { ok: t('home.keepCardsOk'), cancel: t('home.keepCardsNo') });
    if (keepCards === null) return;
    const trash = !!v.videoPath && await dialog.confirm(t(audio ? 'home.deleteFileAudioTitle' : 'home.deleteFileTitle'), t('home.deleteFileBody', { file: fileNameFromPath(v.videoPath) }), { ok: t('home.deleteFileOk'), cancel: t('home.deleteFileKeep'), danger: true });
    if (trash === null) return;
    setDeletingId(v.id);
    await Promise.all([cancelPrep(v.id), cancelCloze(v.id), cancelSegments(v.id), cancelLevels(v.id), cancelTrans(v.id), forgetKeywords(v.id), forgetPhrases(v.id)]);
    try {
      await VideoStorage.deleteVideoRecord(v.id);
      if (v.importJob) cancelImport(v.id).catch(console.error);
      setVideos(prev => (prev ? prev.filter(x => x.id !== v.id) : prev));
      forgetCustomPos(v.id); forgetWatchPos(v.id); setLastWay(v.id, null); forgetLooked(v.id); forgetMask(v.id);
    } catch {
      dialog.alert(t('home.deleteFailTitle'), t('home.deleteFailBody'));
      setDeletingId(null);
      return;
    }
    await deleteVideoCards(v.id, keepCards).then(keepOrphans).catch(console.error);
    try {
      if (trash) {
        const paths = [v.videoPath!, ...await relatedFilePaths(v.id, v.videoPath!, v.subtitleFileName)];
        const results = await Promise.allSettled(paths.map(trashFile));
        if (results[0].status === 'rejected') throw results[0].reason;
      } else {
        await Promise.allSettled((await cacheFilePaths(v.id)).map(trashFile));
      }
    } catch {
      dialog.alert(t('home.deleteFileFailTitle'), t('home.deleteFileFailBody'));
    } finally {
      setDeletingId(null);
    }
  };

  const jobLabel = (job: NonNullable<VideoRecord['importJob']>) => t(STAGE_KEYS[job.stage], { pct: job.percent ?? 0 });
  const modeName = (m: LearningMode) => (m === LearningMode.BLUR ? t('home.blur') : t('home.dictate'));
  const lastMode = (v: VideoRecord) => v.learningMode ?? LearningMode.DICTATION;
  const cardMode = (v: VideoRecord) => t(v.podcast && Listen ? 'custom.listen' : lastWayName(v, getLastWay(v.id), !!Listen));
  const otherMode = (v: VideoRecord) => (lastMode(v) === LearningMode.BLUR ? LearningMode.DICTATION : LearningMode.BLUR);
  const where = (v: VideoRecord) => cardWhere(v, shelfPosition.get(v.id), t);
  const finished = (v: VideoRecord) => cardFinished(where(v).pct, shelfPosition.get(v.id));

  const prepItem = (job: { done: number; total: number } | undefined, info: PrepInfo | undefined, kind: 'Breakdown' | 'Cloze', start: () => Promise<unknown>): MenuItem | null => {
    if (job) return { label: t(`home.prep${kind}Running`, { done: job.done, total: job.total || '…' }), onClick: () => {}, disabled: true };
    if (!info || info.eligible === 0) return null;
    if (info.missing === 0) return { label: t(`home.prep${kind}Ready`), onClick: () => {}, disabled: true };
    return {
      label: info.missing < info.eligible ? t(`home.prep${kind}More`, { n: info.missing }) : t(`home.prep${kind}`),
      title: t(`home.prep${kind}Title`),
      onClick: () => { start().catch(err => console.error(err)); },
    };
  };

  const prepLine = (v: VideoRecord) => {
    if (!hasAi || v.importJob) return null;
    const parts: string[] = [];
    const seg = getSegJob(v.id);
    if (seg?.total) parts.push(t('home.prepSegmentRunning', { done: seg.done, total: seg.total }));
    const one = (job: { done: number; total: number } | undefined, info: PrepInfo | undefined, kind: 'Breakdown' | 'Cloze') => {
      if (job) parts.push(t(`home.prep${kind}Running`, { done: job.done, total: job.total || '…' }));
      else if (info && info.eligible > 0 && info.missing < info.eligible)
        parts.push(info.missing === 0 ? t(`home.prep${kind}Done`) : t(`home.prep${kind}Part`, { done: info.eligible - info.missing, total: info.eligible }));
    };
    one(getPrepJob(v.id), prep.get(v.id), 'Breakdown');
    one(getClozeJob(v.id), cloze.get(v.id), 'Cloze');
    return parts.length ? <span> · {parts.join(' · ')}</span> : null;
  };

  const menuFor = (v: VideoRecord): MenuItem[] => {
    const items: MenuItem[] = [];
    if (!v.importJob) {
      items.push({ label: t('home.otherWay'), onClick: () => onOtherWay(v) });
      if (!v.podcast) items.push({ label: t('home.practiceAs', { mode: modeName(otherMode(v)) }), onClick: () => onResume(v, otherMode(v), true) });
      if (hasAi) {
        const b = prepItem(getPrepJob(v.id), prep.get(v.id), 'Breakdown', () => prepareBreakdowns(v.id, v.subtitleText, lang));
        const c = prepItem(getClozeJob(v.id), cloze.get(v.id), 'Cloze', () => prepareCloze(v.id, linesOf(v.subtitleText)));
        if (b) items.push(b);
        if (c) items.push(c);
      }
      items.push('divider');
    }
    items.push({ label: t('home.deleteRecordTitle'), onClick: () => handleDelete(v), disabled: deletingId === v.id });
    return items;
  };

  const setVideoLang = async (v: VideoRecord, value: string) => {
    await VideoStorage.patchVideoRecord(v.id, { lang: (value || undefined) as DictLang | undefined });
    VideoStorage.getAllVideoRecords().then(setVideos).catch(console.error);
  };
  const langRow = (v: VideoRecord) => !v.importJob && (
    <label className="flex items-center gap-2.5 mt-1.5 mx-1 px-1.5 pt-2.5 pb-1 border-t border-line text-sm text-mute">
      <span className="shrink-0">{t('deck.videoLang')}</span>
      <select value={v.lang ?? ''} onChange={e => { setVideoLang(v, e.target.value).catch(console.error); }} className={`${inputCls} !h-8`}>
        <option value="">{t('deck.auto', { lang: langName(videoLang({ ...v, lang: undefined }), lang, t('deck.unsorted')) })}</option>
        {DECK_LANGS.filter(l => l !== 'other').map(l => <option key={l} value={l}>{langName(l, lang, '')}</option>)}
      </select>
    </label>
  );

  const more = (v: VideoRecord, size: 'sm' | 'lg' = 'sm') => (
    <Menu items={menuFor(v)} footer={langRow(v)} trigger={(open, toggle) => (
      <Btn square size={size === 'lg' ? 'md' : size} flat onClick={toggle} title={t('home.more')} aria-label={t('home.more')} className={open ? '!bg-shade !text-ink' : ''}>
        {deletingId === v.id ? <Loader2 size={16} className="animate-spin" /> : <MoreHorizontal size={16} />}
      </Btn>
    )} />
  );

  const jobStatus = (v: VideoRecord) => {
    const job = v.importJob!;
    if (!job.error) return null;
    return (
      <p className="mt-1 text-xs text-mute">
        {formatImportError(job.error)}
        {canYouTubeLogin(job.error) && <><span className="mx-2 text-mute">·</span><button type="button" onClick={handleYouTubeLogin} className="text-ink hover:underline underline-offset-4">{t('home.ytLogin')}</button></>}
        {canConvertRetry(job) && <><span className="mx-2 text-mute">·</span><button type="button" onClick={() => handleRetry(v, true)} disabled={retryingId === v.id} className="text-ink hover:underline underline-offset-4 disabled:opacity-40">{t('home.retryConvert')}</button></>}
        <span className="mx-2 text-mute">·</span><button type="button" onClick={() => handleRetry(v)} disabled={retryingId === v.id} className="text-ink hover:underline underline-offset-4 disabled:opacity-40">{t('home.retry')}</button>
      </p>
    );
  };

  const allRecords = videos ?? [];
  const podcastCount = useMemo(() => allRecords.filter(v => !!v.podcast).length, [allRecords]);
  const videoCount = allRecords.length - podcastCount;
  const showFilter = allRecords.length > 0 && (!!PodcastPicker || podcastCount > 0);
  const activeFilter: LibraryFilter = showFilter ? filter : 'all';
  const shown = useMemo(
    () => activeFilter === 'video' ? allRecords.filter(v => !v.podcast) : activeFilter === 'podcast' ? allRecords.filter(v => !!v.podcast) : allRecords,
    [allRecords, activeFilter],
  );

  const lead = shown.find(v => !v.importJob);
  const rest = shown.filter(v => v !== lead);
  const shelfHeading: DictKey = activeFilter === 'podcast' ? (lead ? 'home.otherPodcasts' : 'nav.podcasts') : activeFilter === 'video' ? (lead ? 'home.others' : 'nav.videos') : (lead ? 'home.otherAll' : 'nav.learn');
  const onlyOneKey: DictKey = activeFilter === 'podcast' ? 'home.onlyOnePodcast' : activeFilter === 'video' ? 'home.onlyOne' : 'home.onlyOneAll';
  const filterTabs: [LibraryFilter, DictKey, number][] = [['all', 'home.filterAll', allRecords.length], ['video', 'home.filterVideo', videoCount], ['podcast', 'home.filterPodcast', podcastCount]];
  const filterSeg = showFilter ? (
    <Seg<LibraryFilter> size="sm" value={activeFilter} onChange={setFilter} options={filterTabs.map(([value, key, n]) => ({
      value, label: <span className="inline-flex items-center gap-1.5">{t(key)}<span className="text-mute tabular-nums">{n}</span></span>,
    }))} />
  ) : null;

  const ticks = (v: VideoRecord) => {
    const pos = shelfPosition.get(v.id);
    if (!pos || pos.customSec !== undefined || pos.listen || pos.lines > 32) return <Line pct={where(v).pct} className="w-[160px]" />;
    return (
      <span className="flex gap-[3px]">
        {Array.from({ length: pos.lines }, (_, i) => (
          <span key={i} className={`w-[18px] h-1 rounded-sm ${i < pos.line ? 'bg-ink' : i === pos.line ? 'bg-accent' : 'bg-line'}`} />
        ))}
      </span>
    );
  };

  return (
    <div>
      {dragOver && (
        <div className="fixed inset-3 z-[70] rounded-2xl border-2 border-dashed border-accent bg-paper/90 flex items-center justify-center pointer-events-none fade-in">
          <p className="text-3xl font-semibold text-ink">{t('home.dropRelease')}</p>
        </div>
      )}
      {adding && <AddVideo initialPath={adding.path} initialSrt={adding.srt ?? null} onClose={closeAdd} onPractice={rec => { if (filter === 'podcast') setFilter('all'); onResume(rec, LearningMode.DICTATION); }} />}
      {pickingPodcast && PodcastPicker && <PodcastPicker onClose={closePodcast} onOpen={r => { setPickingPodcast(false); if (filter === 'video') setFilter('all'); onResume(r, lastMode(r)); }} />}

      {videos === null && loadFailed ? (
        <div className="pt-28 flex flex-col items-center text-center">
          <p className="text-2xl font-semibold">{t('home.loadFailTitle')}</p>
          <p className="mt-3 text-sm text-mute max-w-sm leading-relaxed">{t('home.loadFailBody')}</p>
          <Btn tone="accent" className="mt-6" onClick={loadVideos}>{t('home.loadRetry')}</Btn>
        </div>
      ) : videos === null ? (
        <div className="pt-24 flex justify-center text-mute"><Loader2 className="animate-spin" size={20} /></div>
      ) : allEmpty ? (
        <HomeEmpty kind="all" onAddLocal={() => setAdding({ path: null })} onAddPodcast={PodcastPicker ? () => setPickingPodcast(true) : undefined} onOpenStarter={r => onResume(r, lastMode(r))} />
      ) : (
        <>
          <TodayBar lead={allRecords.find(v => !v.importJob && !finished(v))} mode={cardMode} onResume={v => onResume(v, lastMode(v))} right={filterSeg} />
          {shown.length === 0 ? (
            <HomeEmpty kind={activeFilter === 'podcast' ? 'podcast' : 'video'} onAddLocal={() => setAdding({ path: null })}
              podcastPicker={PodcastPicker ? <PodcastPicker onOpen={r => onResume(r, lastMode(r))} /> : null} onOpenStarter={r => onResume(r, lastMode(r))} />
          ) : (
            <>
              {lead && (() => {
                const w = where(lead);
                return (
                  <section className="relative">
                    <button type="button" onClick={() => onResume(lead, lastMode(lead))} className="block w-full" aria-label={t('home.continueMode', { mode: cardMode(lead) })}>
                      <VideoCover path={lead.videoPath} audio={isAudioRecord(lead)} image={lead.podcast?.image} className="h-[min(52vh,440px)] rounded-[20px]" />
                    </button>
                    <div className="absolute left-6 right-6 bottom-6 flex items-center gap-5 p-4 pl-5 bg-page rounded-2xl shadow-card">
                      <button type="button" onClick={() => onResume(lead, lastMode(lead))} title={t('home.continueMode', { mode: cardMode(lead) })} aria-label={t('home.continueMode', { mode: cardMode(lead) })}
                        className="press shrink-0 w-[52px] h-[52px] rounded-full bg-accent text-white flex items-center justify-center">
                        <Play size={20} fill="currentColor" className="ml-1" />
                      </button>
                      <div className="min-w-0 flex-1">
                        {lead.podcast && <p className="mb-0.5 text-xs text-mute truncate">{[lead.podcast.show, podcastRate(lead)].filter(Boolean).join(' · ')}</p>}
                        <p className="text-xl font-semibold leading-snug truncate" title={lead.displayName}>{lead.displayName}</p>
                        <div className="mt-2 flex items-center gap-3 text-[13px] text-mute min-w-0">
                          {ticks(lead)}
                          <span className="truncate">{w.text && `${w.text} · `}{finished(lead) ? t('home.finished') : t('home.continueMode', { mode: cardMode(lead) })}{prepLine(lead)}</span>
                        </div>
                      </div>
                      {more(lead, 'lg')}
                    </div>
                  </section>
                );
              })()}
              <div className="mt-7 mb-3.5 flex items-baseline justify-between gap-4 text-[13px] text-mute">
                <span className="font-medium text-ink">{t(shelfHeading)}</span>
                <WeekStats remembered={remembered} />
              </div>
              {rest.length === 0 ? (
                <p className="py-2 text-sm text-mute">{t(onlyOneKey)}</p>
              ) : (
                <ul className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-5 gap-y-7">
                  {rest.map(v => {
                    const w = v.importJob ? null : where(v);
                    return (
                      <li key={v.id} className="group relative min-w-0 focus-within:z-10 hover:z-10">
                        <button type="button" disabled={!!v.importJob} onClick={() => onResume(v, lastMode(v))} className="block w-full text-left disabled:cursor-default">
                          <VideoCover path={v.videoPath} audio={isAudioRecord(v)} image={v.podcast?.image}>
                            {v.importJob && !v.importJob.error && <span className="absolute inset-x-0 bottom-0 px-3 py-2 text-xs text-white bg-black/60">{jobLabel(v.importJob)}</span>}
                            {w && <span className="absolute left-2.5 right-2.5 bottom-2 h-[3px] rounded-full bg-white/50"><span className="block h-full rounded-full bg-accent" style={{ width: `${Math.min(100, Math.max(0, w.pct))}%` }} /></span>}
                          </VideoCover>
                          {v.podcast && <p className="mt-2.5 -mb-2 text-xs text-mute truncate">{[v.podcast.show, podcastRate(v)].filter(Boolean).join(' · ')}</p>}
                          <p className={`mt-2.5 text-[13px] font-medium leading-snug truncate ${v.importJob ? 'text-mute' : ''}`} title={v.displayName}>{v.displayName}</p>
                        </button>
                        {v.importJob ? jobStatus(v) ?? <Line pct={v.importJob.percent ?? 0} className="mt-2" /> : <p className="mt-0.5 text-xs text-mute truncate">{w!.text && `${w!.text} · `}{cardMode(v)}{prepLine(v)}</p>}
                        <div className="absolute top-2 right-2 rounded-lg bg-page opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">{more(v)}</div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
};

export default Home;
