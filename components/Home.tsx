import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, MoreHorizontal, Loader2, Play } from 'lucide-react';
import { LearningMode, VideoRecord } from '../types';
import * as VideoStorage from '../utils/videoStorage';
import { forgetCustomPos, forgetWatchPos, formatTimeCode, getCustomConfig, getCustomPos, getPracticeConfig } from '../utils/storage';
import { parseSRT } from '../utils/srtParser';
import { buildSections } from '../utils/sections';
import { fileNameFromPath, isVideoFile, listenDragDrop, trashFile, relatedFilePaths, cacheFilePaths } from '../utils/desktop';
import { cancelImport, canConvertRetry, formatImportError, isCookieError, openYouTubeLogin, retryImport, subscribeImportJobs } from '../utils/importJob';
import { Btn, Menu, MenuItem, inputCls } from './ui';
import { DECK_LANGS, langName, videoLang } from '../utils/deckLang';
import type { DictLang } from '../utils/dictionary';
import VideoCover from './VideoCover';
import { dialog } from './Dialog';
import { useT, useLang } from '../utils/i18n';
import AddVideo from './AddVideo';
import { canCloze } from '../utils/aiDrills';
import { cancelPrep, getPrepJob, prepStatus, prepareBreakdowns, subscribePrep } from '../utils/breakdownPrep';
import { cancelLevels } from '../utils/levelPrep';
import { cancelTrans } from '@pro';
import { forgetLooked } from '../utils/readLooked';
import { cancelCloze, clozeStatus, getClozeJob, linesOf, prepareCloze, subscribeCloze } from '../utils/clozePrep';
import { cancelSegments, getSegJob, subscribeSeg } from '../utils/jaSegments';
import { deckCounts, deleteVideoCards, getAllCards, keepOrphans, subscribeCards } from '../utils/review';
import { clipVideoNow } from '../utils/clips';
import { getToday } from '../utils/today';

// Home does two things: pick up the video you were on, and add a new one (the top
// bar's "+", or a drop). The most recent video leads as a big frame with its play
// strip; the rest are covers. Everything else (mode switch, AI prep, delete)
// waits behind hover or the "…" menu.

interface HomeProps {
  onResume: (record: VideoRecord, mode: LearningMode) => void | Promise<void>;
  onEmptyChange?: (empty: boolean) => void;
  addAsked?: boolean; // the top bar's "+" was pressed
  onAddHandled?: () => void;
}

type PrepInfo = { eligible: number; missing: number };
const SRT_EXT = /\.srt$/i;

const Line: React.FC<{ pct: number; className?: string }> = ({ pct, className = '' }) => (
  <div className={`h-[2px] bg-line ${className}`}>
    <div className="h-full bg-mute" style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
  </div>
);

const Home: React.FC<HomeProps> = ({ onResume, onEmptyChange, addAsked, onAddHandled }) => {
  const t = useT();
  const lang = useLang();
  const [videos, setVideos] = useState<VideoRecord[] | null>(null);
  // The records could not be read (not the same as having none): shown only before any list loaded.
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => { onEmptyChange?.(videos?.length === 0); }, [videos, onEmptyChange]);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ path: string | null; srt?: string | null } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // AI prep per video (breakdowns, blanks): how many lines are still unprepared,
  // read from the saved caches so it survives a restart, and a tick that
  // re-renders running jobs' progress.
  const [prep, setPrep] = useState<Map<string, PrepInfo>>(new Map());
  const [cloze, setCloze] = useState<Map<string, PrepInfo>>(new Map());
  const [prepTick, setPrepTick] = useState(0);
  useEffect(() => {
    if (!addAsked) return;
    setAdding(prev => prev ?? { path: null });
    onAddHandled?.();
  }, [addAsked, onAddHandled]);
  const hasAi = canCloze();

  // Where each record sits in sections rather than in percent: "part 3 of 12"
  // is something you can finish, where "24%" of a long video never moves.
  // Computed the same way the practice page cuts the video, so the two agree.
  const sectionLength = getPracticeConfig().sectionLength;
  const shelfPosition = useMemo(() => {
    const byId = new Map<string, { part: number; parts: number; line: number; lines: number; customSec?: number; customPct?: number }>();
    // The start panel opens on custom when that was the last choice; the card then
    // shows where the custom sets reached, since that is where "start" goes on.
    const customOn = getCustomConfig().on;
    for (const v of videos ?? []) {
      if (v.importJob || !v.subtitleText) continue;
      try {
        const subs = parseSRT(v.subtitleText);
        const customSec = customOn ? getCustomPos(v.id) : 0;
        const end = subs[subs.length - 1]?.endTime ?? 0;
        const sections = buildSections(subs, sectionLength);
        if (sections.length === 0) continue;
        const part = Math.min(Math.max(v.currentSectionIndex, 0), sections.length - 1);
        const lines = sections[part].subtitles.length;
        byId.set(v.id, {
          part,
          parts: sections.length,
          line: Math.min(Math.max(v.currentSubtitleIndex, 0), lines),
          lines,
          ...(customSec > 0 ? { customSec, customPct: end ? Math.min(100, customSec / end * 100) : 0 } : {}),
        });
      } catch { /* a record we cannot parse just falls back to percent */ }
    }
    return byId;
  }, [videos, sectionLength]);

  const loadVideos = useCallback(() => {
    setLoadFailed(false);
    VideoStorage.getAllVideoRecords()
      .then(setVideos)
      .catch(err => { console.error(err); setLoadFailed(true); });
  }, []);
  useEffect(() => {
    loadVideos();
    return subscribeImportJobs(loadVideos);
  }, [loadVideos]);

  // The whole window takes a dropped video and/or .srt; it opens the add dialog
  // with them filled in, keeping whichever half is already there.
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
        if (video || srt) setAdding(prev => ({ path: video ?? prev?.path ?? null, srt: srt ?? prev?.srt ?? null }));
      },
    }).then(fn => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // How many lines stick; what is due shows on the top bar's tabs instead.
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
  // A running job ticks faster than a read of every cache finishes, so reads are
  // never cancelled (that starved the shelf until the job stopped): each one
  // lands unless a newer read already has.
  const statusSeq = useRef({ started: 0, applied: 0 });
  useEffect(() => {
    if (!hasAi || !videos) return;
    const seq = statusSeq.current;
    const mine = ++seq.started;
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

  // A record made in the dialog shows on the shelf even if the start panel is then cancelled.
  const closeAdd = useCallback(() => { setAdding(null); loadVideos(); }, [loadVideos]);

  const handleYouTubeLogin = async () => {
    try {
      await openYouTubeLogin();
      dialog.alert(t('home.ytLoginTitle'), t('home.ytLoginBody'));
    } catch (e) {
      const missing = String(e).includes('missing:');
      dialog.alert(t('home.ytLoginFailTitle'), missing ? t('home.ytLoginNoChrome') : t('home.ytLoginFailBody'));
    }
  };

  const handleRetry = async (v: VideoRecord, convert = false) => {
    setRetryingId(v.id);
    try {
      await retryImport(v.id, convert);
    } catch (e) {
      console.error(e);
      dialog.alert(t('home.retryFailTitle'), t('home.retryFailBody'));
    } finally {
      setRetryingId(null);
    }
  };

  const handleDelete = async (v: VideoRecord) => {
    // Cards made just now may not have their clip yet: cut this video's while it is still here,
    // and count only clips that are really on disk.
    setDeletingId(v.id);
    const clipped = await clipVideoNow(v.id).catch(() => 0);
    setDeletingId(null);
    const mine = await getAllCards().then(cs => cs.filter(c => c.videoId === v.id)).catch(() => null); // unreadable: still warn, the cards go either way
    const n = mine ? mine.length : -1;
    // Cards with their own clip get their own question next, so don't say here that they all go.
    const cardsNote = clipped ? '' : n > 0 ? ' ' + t('home.deleteHasCards', { n }) : n < 0 ? ' ' + t('home.deleteCardsUnknown') : '';
    const ok = await dialog.confirm(t('home.deleteTitle'), t('home.deleteBody', { name: v.displayName }) + cardsNote, { ok: t('home.deleteOk'), danger: true });
    if (!ok) return;
    // Cards that saved a clip still play without the video: keep them? Dismissed = nothing is deleted.
    const keepCards = clipped > 0 && await dialog.confirm(
      t('home.keepCardsTitle'),
      t(clipped === n ? 'home.keepCardsBodyAll' : 'home.keepCardsBody', { n, rest: n - clipped }),
      { ok: t('home.keepCardsOk'), cancel: t('home.keepCardsNo') },
    );
    if (keepCards === null) return;
    const trash = !!v.videoPath && await dialog.confirm(
      t('home.deleteFileTitle'),
      t('home.deleteFileBody', { file: fileNameFromPath(v.videoPath) }),
      { ok: t('home.deleteFileOk'), cancel: t('home.deleteFileKeep'), danger: true },
    );
    if (trash === null) return; // dismissed the file question: nothing is deleted
    setDeletingId(v.id);
    await Promise.all([cancelPrep(v.id), cancelCloze(v.id), cancelSegments(v.id), cancelLevels(v.id), cancelTrans(v.id)]);
    try {
      await VideoStorage.deleteVideoRecord(v.id);
      // Still generating or waiting its turn: stop it, its events are ignored from here on.
      if (v.importJob) cancelImport(v.id).catch(console.error);
      setVideos(prev => (prev ? prev.filter(x => x.id !== v.id) : prev));
      forgetCustomPos(v.id);
      forgetWatchPos(v.id);
      forgetLooked(v.id);
    } catch {
      dialog.alert(t('home.deleteFailTitle'), t('home.deleteFailBody'));
      setDeletingId(null);
      return;
    }
    // A failure here leaves orphan cards; the next launch offers to clear them.
    // Kept cards have no video record any more: don't ask about them as leftovers at launch.
    await deleteVideoCards(v.id, keepCards).then(keepOrphans).catch(console.error);
    try {
      if (trash) {
        const paths = [v.videoPath!, ...await relatedFilePaths(v.id, v.videoPath!, v.subtitleFileName)];
        const results = await Promise.allSettled(paths.map(trashFile));
        if (results[0].status === 'rejected') throw results[0].reason;
      } else {
        // Keeping the video (and its .srt): only our own AI results go, nothing reads them after this.
        await Promise.allSettled((await cacheFilePaths(v.id)).map(trashFile));
      }
    } catch {
      dialog.alert(t('home.deleteFileFailTitle'), t('home.deleteFileFailBody'));
    } finally {
      setDeletingId(null);
    }
  };

  const jobLabel = (job: NonNullable<VideoRecord['importJob']>) => {
    const pct = job.percent ?? 0;
    if (job.stage === 'queued') return t('import.stageQueued');
    if (job.stage === 'setup') return t('import.stageSetup', { pct });
    if (job.stage === 'convertSetup') return t('import.stageConvertSetup', { pct });
    if (job.stage === 'convert') return t('import.stageConvert', { pct });
    if (job.stage === 'download') return t('import.stageDownload', { pct });
    if (job.stage === 'transcribe') return t('import.stageTranscribe', { pct });
    if (job.stage === 'cloud') return t('import.stageCloud', { pct });
    if (job.stage === 'segment') return t('import.stageSegment');
    return t('import.stageExtract');
  };

  const modeName = (m: LearningMode) => (m === LearningMode.BLUR ? t('home.blur') : t('home.dictate'));
  const lastMode = (v: VideoRecord) => v.learningMode ?? LearningMode.DICTATION;
  const otherMode = (v: VideoRecord) => (lastMode(v) === LearningMode.BLUR ? LearningMode.DICTATION : LearningMode.BLUR);

  // "Part 2 of 5" and how far into that part, or lines when there is only one part.
  const where = (v: VideoRecord) => {
    const pos = shelfPosition.get(v.id);
    if (!pos) return { text: `${v.completionRate}%`, pct: v.completionRate };
    if (pos.customSec) return { text: t('home.customAt', { time: formatTimeCode(pos.customSec) }), pct: pos.customPct ?? 0 };
    const pct = pos.lines ? (pos.line / pos.lines) * 100 : 0;
    if (pos.parts > 1) return { text: t('home.partOf', { current: pos.part + 1, total: pos.parts }), pct };
    return { text: t('home.linesCount', { current: pos.line, total: pos.lines }), pct };
  };

  // One "…" entry per kind of AI prep: running, start, top up, or done.
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

  // " · Broken down · Blanks 3/5": where each kind of AI prep stands.
  const prepLine = (v: VideoRecord) => {
    if (!hasAi || v.importJob) return null;
    const parts: string[] = [];
    const seg = getSegJob(v.id);
    if (seg?.total) parts.push(t('home.prepSegmentRunning', { done: seg.done, total: seg.total }));
    const one = (job: { done: number; total: number } | undefined, info: PrepInfo | undefined, kind: 'Breakdown' | 'Cloze') => {
      if (job) parts.push(t(`home.prep${kind}Running`, { done: job.done, total: job.total || '…' }));
      else if (info && info.eligible > 0 && info.missing < info.eligible) {
        parts.push(info.missing === 0 ? t(`home.prep${kind}Done`) : t(`home.prep${kind}Part`, { done: info.eligible - info.missing, total: info.eligible }));
      }
    };
    one(getPrepJob(v.id), prep.get(v.id), 'Breakdown');
    one(getClozeJob(v.id), cloze.get(v.id), 'Cloze');
    return parts.length ? <span> · {parts.join(' · ')}</span> : null;
  };

  const menuFor = (v: VideoRecord): MenuItem[] => {
    const items: MenuItem[] = [];
    if (!v.importJob) {
      items.push({ label: t('home.practiceAs', { mode: modeName(otherMode(v)) }), onClick: () => onResume(v, otherMode(v)) });
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

  // Which language deck this video's cards go in: guessed from the subtitles unless set here.
  // Shows what was actually saved (re-read after the write), so a failed write snaps back.
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

  // A running import, or one that failed: its own status instead of a position.
  const jobStatus = (v: VideoRecord) => {
    const job = v.importJob!;
    if (!job.error) return null;
    return (
      <p className="mt-1 text-xs text-mute">
        {formatImportError(job.error)}
        {isCookieError(job.error) && <><span className="mx-2 text-mute">·</span><button type="button" onClick={handleYouTubeLogin} className="text-ink hover:underline underline-offset-4">{t('home.ytLogin')}</button></>}
        {canConvertRetry(job) && <><span className="mx-2 text-mute">·</span><button type="button" onClick={() => handleRetry(v, true)} disabled={retryingId === v.id} className="text-ink hover:underline underline-offset-4 disabled:opacity-40">{t('home.retryConvert')}</button></>}
        <span className="mx-2 text-mute">·</span><button type="button" onClick={() => handleRetry(v)} disabled={retryingId === v.id} className="text-ink hover:underline underline-offset-4 disabled:opacity-40">{t('home.retry')}</button>
      </p>
    );
  };

  // "Today: 12 min · 18 lines · 34 lines remembered" — each part only once it's above zero.
  const today = getToday();
  const todayWhat = [today.sec >= 60 && t('home.todayMin', { n: Math.floor(today.sec / 60) }), today.lines && t('home.reviewLine', { n: today.lines })].filter(Boolean).join(' · ');
  const stats = [todayWhat && t('home.today', { what: todayWhat }), remembered > 0 && t('home.remembered', { n: remembered })].filter(Boolean).join(' · ');
  const lead = videos?.find(v => !v.importJob);
  const rest = (videos ?? []).filter(v => v !== lead);

  // Where you are in this part: one tick per line when they fit, else a bar.
  const ticks = (v: VideoRecord) => {
    const pos = shelfPosition.get(v.id);
    if (!pos || pos.customSec || pos.lines > 32) return <Line pct={where(v).pct} className="w-[160px]" />;
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
      {adding && <AddVideo initialPath={adding.path} initialSrt={adding.srt ?? null} onClose={closeAdd} onPractice={rec => onResume(rec, LearningMode.DICTATION)} />}

      {videos === null && loadFailed ? (
        <div className="pt-28 flex flex-col items-center text-center">
          <p className="text-2xl font-semibold">{t('home.loadFailTitle')}</p>
          <p className="mt-3 text-sm text-mute max-w-sm leading-relaxed">{t('home.loadFailBody')}</p>
          <Btn tone="accent" className="mt-6" onClick={loadVideos}>{t('home.loadRetry')}</Btn>
        </div>
      ) : videos === null ? (
        <div className="pt-24 flex justify-center text-mute"><Loader2 className="animate-spin" size={20} /></div>
      ) : videos.length === 0 ? (
        <div className="pt-28 flex flex-col items-center text-center">
          <p className="text-[40px] font-semibold tracking-[-0.02em] leading-tight">{t('home.nothingHereYet')}</p>
          <p className="mt-3 text-sm text-mute max-w-sm leading-relaxed">{t('home.nothingHereHint')}</p>
          <Btn tone="accent" size="lg" className="mt-8" onClick={() => setAdding({ path: null })}><Plus size={18} /> {t('home.addVideo')}</Btn>
        </div>
      ) : (
        <>
          {lead && (() => {
            const w = where(lead);
            return (
              <section className="relative">
                <button type="button" onClick={() => onResume(lead, lastMode(lead))} className="block w-full" aria-label={t('home.continueMode', { mode: modeName(lastMode(lead)) })}>
                  <VideoCover path={lead.videoPath} className="h-[min(52vh,440px)] rounded-[20px]" />
                </button>
                <div className="absolute left-6 right-6 bottom-6 flex items-center gap-5 p-4 pl-5 bg-page rounded-2xl shadow-card">
                  <button type="button" onClick={() => onResume(lead, lastMode(lead))} title={t('home.continueMode', { mode: modeName(lastMode(lead)) })} aria-label={t('home.continueMode', { mode: modeName(lastMode(lead)) })}
                    className="press shrink-0 w-[52px] h-[52px] rounded-full bg-accent text-white flex items-center justify-center">
                    <Play size={20} fill="currentColor" className="ml-1" />
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className="text-xl font-semibold leading-snug truncate" title={lead.displayName}>{lead.displayName}</p>
                    <div className="mt-2 flex items-center gap-3 text-[13px] text-mute min-w-0">
                      {ticks(lead)}
                      <span className="truncate">{w.text} · {w.pct >= 100 && (shelfPosition.get(lead.id)?.customSec || (shelfPosition.get(lead.id)?.part ?? 0) + 1 >= (shelfPosition.get(lead.id)?.parts ?? 1)) ? t('home.finished') : t('home.continueMode', { mode: modeName(lastMode(lead)) })}{prepLine(lead)}</span>
                    </div>
                  </div>
                  {more(lead, 'lg')}
                </div>
              </section>
            );
          })()}

          <div className="mt-7 mb-3.5 flex items-baseline justify-between gap-4 text-[13px] text-mute">
            <span className="font-medium text-ink">{lead ? t('home.others') : t('nav.videos')}</span>
            {stats && <span title={t('home.rememberedTitle')}>{stats}</span>}
          </div>
          {rest.length === 0 ? (
            <p className="py-2 text-sm text-mute">{t('home.onlyOne')}</p>
          ) : (
            <ul className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-5 gap-y-7">
              {rest.map(v => {
                const w = v.importJob ? null : where(v);
                return (
                  <li key={v.id} className="group relative min-w-0 focus-within:z-10 hover:z-10">
                    <button type="button" disabled={!!v.importJob} onClick={() => onResume(v, lastMode(v))} className="block w-full text-left disabled:cursor-default">
                      <VideoCover path={v.videoPath}>
                        {v.importJob && !v.importJob.error && (
                          <span className="absolute inset-x-0 bottom-0 px-3 py-2 text-xs text-white bg-black/60">{jobLabel(v.importJob)}</span>
                        )}
                        {w && (
                          <span className="absolute left-2.5 right-2.5 bottom-2 h-[3px] rounded-full bg-white/50">
                            <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.min(100, Math.max(0, w.pct))}%` }} />
                          </span>
                        )}
                      </VideoCover>
                      <p className={`mt-2.5 text-[13px] font-medium leading-snug truncate ${v.importJob ? 'text-mute' : ''}`} title={v.displayName}>{v.displayName}</p>
                    </button>
                    {v.importJob ? (
                      jobStatus(v) ?? <Line pct={v.importJob.percent ?? 0} className="mt-2" />
                    ) : (
                      <p className="mt-0.5 text-xs text-mute truncate">{w!.text} · {modeName(lastMode(v))}{prepLine(v)}</p>
                    )}
                    <div className="absolute top-2 right-2 rounded-lg bg-page opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                      {more(v)}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
};

export default Home;
