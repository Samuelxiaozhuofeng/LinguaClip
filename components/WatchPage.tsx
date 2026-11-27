import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Bookmark, Maximize2, Minimize2, MoreHorizontal, Pause, Play, Repeat, RotateCcw, Check } from 'lucide-react';
import { Subtitle, VideoRecord } from '../types';
import { Btn, Menu, Seg, Stamp, useToast } from './ui';
import WatchLine from './WatchLine';
import WatchList from './WatchList';
import WatchSummary, { Looked } from './WatchSummary';
import DefinitionPanel from './DefinitionPanel';
import ReviewSession from './ReviewSession';
import SubtitleMask, { useMaskMenu } from './SubtitleMask';
import WayBar from './WayBar';
import type { StudyWay } from '../utils/studyWays';
import { useLookup, aroundOf } from '../hooks/useLookup';
import { useSavedLines } from '../hooks/useSavedLines';
import { useAnkiIntegration } from '../hooks/useAnkiIntegration';
import { parseSRT } from '../utils/srtParser';
import { isFullscreen, setFullscreen, videoSrcFromPath } from '../utils/desktop';
import { resolveDictLang } from '../utils/resolveDictLang';
import { settleSplits } from '../utils/jaSegments';
import { addWord, lineCardsFor, ReviewCard } from '../utils/review';
import { formatTimeCode, getWatchPos, getWatchPrefs, saveWatchPrefs, setWatchPos, WatchPrefs, WatchSubs } from '../utils/storage';
import { formatCombo, lineKey, loose, matches, useShortcuts } from '../utils/shortcuts';
import { IS_WINDOWS } from '../utils/platform';
import { SPEEDS, useSpeed } from '../utils/speedPref';
import { DictKey, useT } from '../utils/i18n';
import { usePracticeClock } from '../utils/today';
import { maskShowing, setPeek, togglePeek } from '../utils/subtitleMask';
import { LOOP_TIMES, LoopTimes, setLoopTimes } from '../utils/loop';
import { useWatchClock, useWatchLoop, watchLegend } from '../hooks/useWatchLoop';

// Watch mode: the whole window is the video, the subtitle sits on the picture.
// Look words up, save lines (S), send them to Anki, and at the end dictate a few
// of the lines saved this time; leaving midway just leaves. Its own page: the practice
// session, its sections and its progress are never touched.

const SUBS: WatchSubs[] = ['show', 'blur', 'hide'];
const IDLE_MS = 2500; // the pointer hides after this long still; both bars show this long on entry
const TOP_ZONE = 88; // px from the top edge that bring the back button up
const BOTTOM_ZONE = 44; // px from the bottom edge that bring the controls up: below the subtitle, so aiming at a word doesn't

const WatchPage: React.FC<{
  record: VideoRecord;
  startSec?: number;
  hasReader?: boolean;
  hasListen?: boolean;
  onSwitchWay?: (way: StudyWay, sec: number) => void;
  onExit: () => void;
}> = ({ record, startSec, hasReader, hasListen, onSwitchWay, onExit }) => {
  const t = useT();
  usePracticeClock();
  const combos = useShortcuts();
  const lines = useMemo(() => [...parseSRT(record.subtitleText)].sort((a, b) => a.startTime - b.startTime), [record.subtitleText]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [failed, setFailed] = useState(false);
  const [prefs, setPrefsState] = useState<WatchPrefs>(getWatchPrefs);
  const [speed, setSpeed] = useSpeed('watch');
  // The line on screen: `at` = last line started, `on` = still inside it (not in the gap after).
  const [cur, setCur] = useState({ at: -1, on: false });
  const [revealed, setRevealed] = useState<number | null>(null);
  const [summary, setSummary] = useState(false);
  const [drill, setDrill] = useState<ReviewCard[] | null>(null);
  const [looked, setLooked] = useState<Looked[]>([]);
  const [awake, setAwake] = useState(true);
  const [intro, setIntro] = useState(true);
  const [near, setNear] = useState({ top: false, bottom: false });
  const [full, setFull] = useState(false);
  const [mine, setMine] = useState<number[]>([]); // lines saved this time: the summary's

  const shown = cur.on ? lines[cur.at] : null;
  // A lifted mask goes with the line it was lifted for (subtitle hidden / blurred), and with a change of display.
  useEffect(() => { if (prefs.subs !== 'show') setPeek(false); }, [cur.at]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setPeek(false), [prefs.subs]);
  const target = cur.at >= 0 ? lines[cur.at] : null; // what S / Anki / replay act on
  const [listPct, setListPct] = useState(prefs.listPct); // live while dragging; saved on release
  const setPrefs = (patch: Partial<WatchPrefs>) => {
    if (patch.subs) setRevealed(null); // a line opened in one display is covered again by the next
    setPrefsState(p => ({ ...p, ...patch }));
    saveWatchPrefs(patch);
  };
  const toast = useToast();
  const maskItems = useMaskMenu(record.id, 'watch.peek', true);
  const say = (key: DictKey) => toast.say(t(key));

  const { savedIds, savedItems, toggleSave } = useSavedLines({ videoId: record.id, fullSubtitles: lines, videoFileName: record.videoFileName });
  const { ankiConfig, ankiStatus, handleAddToAnki, handleWordToAnki } = useAnkiIntegration({ videoRef, videoFileName: record.videoFileName, videoId: record.id });
  const recording = ankiStatus === 'recording';
  // An Anki clip (a line's, or a word's from the definition card) seeks and plays the video
  // itself: nothing may pause, seek, save the position or end the watch meanwhile.
  const wordRecording = useRef(false);
  const recordingRef = useRef(recording);
  recordingRef.current = recording;
  const busy = () => recordingRef.current || wordRecording.current;

  // --- Lookup & Playback ---
  // Clock check (rAF + video timeupdate) tracks the current line and handles line-end loop / auto-pause.
  const dictLang = useMemo(() => resolveDictLang(record.lang, lines.map(l => l.text)), [record.lang, lines]);
  useEffect(() => { settleSplits(record.id, lines.map(l => l.text)).catch(() => {}); }, [record.id, lines]); // words, and the reader's marks on them
  const { def, lookup, explain, closeDef } = useLookup(dictLang, shown?.text ?? '');
  const loop = useWatchLoop();
  const onCur = useCallback((at: number, on: boolean) => setCur(c => (c.at === at && c.on === on ? c : { at, on })), []);
  const { seek: rawSeek, checkClock, tryEndLoop, gapLine } = useWatchClock({
    videoRef, lines, loop, autoPause: prefs.autoPause, busy,
    blocked: !!drill || summary || def.word !== null, onCur,
  });
  const resumeAfter = useRef(false);
  const resumeLoopAt = useRef(-1);
  const seek = useCallback((sec: number, play = false, keepPlays = false) => {
    if (!keepPlays) { resumeAfter.current = false; resumeLoopAt.current = -1; }
    rawSeek(sec, play, keepPlays);
  }, [rawSeek]);

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v || busy()) return;
    loop.clearGap();
    resumeAfter.current = false; // played / paused by hand: closing the definition leaves it be
    resumeLoopAt.current = -1;
    if (v.paused) v.play().catch(() => {}); else v.pause();
  };
  const jump = (i: number) => { if (i >= 0 && i < lines.length) seek(lines[i].startTime, true); };
  // Previous = the line before the one on screen; in the gap after a line, that line itself.
  const prev = () => jump(cur.on ? cur.at - 1 : cur.at);
  const next = () => jump(cur.at + 1);
  const replay = () => { if (target) seek(target.startTime, true); };

  // Resume where the last watch stopped (or `startSec` when switched from another way; the end counts as the start on normal resume).
  const loadedRef = useRef(false);
  const onLoaded = () => {
    const v = videoRef.current;
    if (!v) return;
    loadedRef.current = true;
    setDuration(v.duration);
    if (startSec !== undefined) {
      if (startSec > 0) seek(Math.min(startSec, Math.max(0, v.duration - 0.1)));
    } else {
      const pos = getWatchPos(record.id);
      if (pos > 0 && pos < v.duration - 3) seek(pos);
    }
    v.play().catch(() => {});
  };
  const lastSaved = useRef(0);
  const onTime = () => {
    checkClock();
    const v = videoRef.current;
    if (!v) return;
    setTime(v.currentTime);
    if (!busy() && Math.abs(v.currentTime - lastSaved.current) > 5) {
      lastSaved.current = v.currentTime;
      setWatchPos(record.id, v.currentTime);
    }
  };
  useEffect(() => {
    const v = videoRef.current;
    return () => {
      if (!v || v.ended) return;
      const pos = loadedRef.current ? v.currentTime : startSec;
      if (pos !== undefined && (pos > 0 || startSec !== undefined)) setWatchPos(record.id, pos);
    };
  }, [record.id, startSec]);
  useEffect(() => { if (videoRef.current) videoRef.current.defaultPlaybackRate = videoRef.current.playbackRate = speed; }, [speed]);

  // --- Lookup: pauses the video; closing the card resumes it if it was playing ---
  const lookLine = useRef<Subtitle | null>(null);
  // Pressing a word pauses already: dragging across a phrase, the line must not move on.
  const pauseForLookup = () => {
    const loopIdx = gapLine();
    const inGap = loopIdx >= 0;
    loop.clearGap();
    const v = videoRef.current;
    if (v && (!v.paused || inGap) && !busy()) {
      resumeAfter.current = true;
      if (inGap) resumeLoopAt.current = loopIdx;
      v.pause();
    }
  };
  const unpause = () => {
    const loopIdx = resumeLoopAt.current;
    resumeLoopAt.current = -1;
    const shouldResume = resumeAfter.current;
    resumeAfter.current = false;
    if (!shouldResume || summary) return;
    if (loopIdx >= 0 && loop.loopOnRef.current && lines[loopIdx]) seek(lines[loopIdx].startTime, true, true);
    else videoRef.current?.play().catch(() => {});
  };
  const onWord = (word: string, line: Subtitle, fromList = false) => {
    pauseForLookup();
    lookLine.current = line;
    if (!fromList) {
      setLooked(l => (l.some(x => x.word.toLowerCase() === word.toLowerCase()) ? l : [...l, { word, line }]));
    }
    lookup(word, line.text, aroundOf(lines, lines.indexOf(line)));
  };
  const closeLookup = () => { closeDef(); unpause(); };
  const keepWord = (word: string, definition: string, example: string, ai: string) => {
    const l = lookLine.current;
    if (l) addWord({ videoId: record.id, videoName: record.videoFileName, text: l.text, start: l.startTime, end: l.endTime }, word, definition, example, ai).catch(console.error);
  };
  const wordToAnki = async (word: string, definition: string, example?: string) => {
    if (!lookLine.current) return;
    loop.clearGap();
    wordRecording.current = true;
    try { await handleWordToAnki(word, definition, lookLine.current, example); } finally { wordRecording.current = false; }
  };

  // --- Save / Anki ---
  const save = () => {
    if (!target) return;
    say(savedIds.has(target.id) ? 'watch.unsaved' : 'watch.saved');
    const id = target.id;
    setMine(m => (savedIds.has(id) ? m.filter(x => x !== id) : [...m, id]));
    toggleSave(target);
  };
  const toAnki = () => { if (target && !busy()) { loop.clearGap(); handleAddToAnki(target); } };
  const ankiReady = !!ankiConfig?.card;
  // The Anki button lives in "…": how it went shows as a note.
  useEffect(() => {
    if (ankiStatus === 'success' || ankiStatus === 'error') toast.say(`Anki · ${t(ankiStatus === 'success' ? 'common.added' : 'common.failed')}`);
  }, [ankiStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  const cycleSubs = () => {
    const subs = SUBS[(SUBS.indexOf(prefs.subs) + 1) % SUBS.length];
    setPrefs({ subs });
    say(`watch.subs_${subs}` as DictKey);
  };
  const toggleAutoPause = () => {
    setPrefs({ autoPause: !prefs.autoPause });
    say(prefs.autoPause ? 'watch.autoPauseOff' : 'watch.autoPauseOn');
  };
  const onToggleLoop = () => {
    const on = loop.toggleLoop();
    const times = loop.times ? t('transport.loopN', { n: loop.times }) : t('transport.loopForever');
    toast.say(on ? t('watch.loopOn', { times }) : t('watch.loopOff'));
  };

  // --- Summary: only at the end; leaving midway never asks (the saved lines are review cards already) ---
  const leave = () => { if (!busy()) onExit(); };
  const switchWay = (way: StudyWay) => {
    if (busy()) return;
    loop.clearGap();
    videoRef.current?.pause();
    const sec = !loadedRef.current ? (startSec ?? getWatchPos(record.id)) : (target?.startTime ?? videoRef.current?.currentTime ?? 0);
    onSwitchWay?.(way, sec);
  };
  const onEnded = () => {
    if (busy()) return; // an Anki clip ran to the very end: not a finished watch
    if (tryEndLoop()) return;
    loop.clearGap();
    loop.resetPlays();
    setWatchPos(record.id, 0);
    setSummary(true);
  };
  const startDrill = async (picked: Subtitle[]) => {
    const cards = await lineCardsFor(record.id, picked).catch(() => [] as ReviewCard[]);
    if (cards.length) setDrill(cards); else say('watch.drillMissing');
  };

  // --- Keys (ReviewSession, while open, keeps every key to itself) ---
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e: KeyboardEvent) => {
    if (e.isComposing || e.keyCode === 229 || drill) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (loose(e, 'watch.close')) {
      if (def.word !== null || summary || full) e.preventDefault(); // a rebound key mustn't also press a focused button
      if (def.word !== null) closeLookup();
      else if (summary) setSummary(false);
      else if (full) toggleFull();
      return;
    }
    if (summary || recording) return;
    let act: (() => void) | null = null;
    if (matches(e, 'watch.replay')) act = replay;
    else if (matches(e, 'watch.loop') && def.word === null) act = onToggleLoop;
    else if (matches(e, 'watch.play')) act = togglePlay;
    // A learner's jump is by line, not by seconds.
    else if (lineKey(e, 'prev')) act = prev;
    else if (lineKey(e, 'next')) act = next;
    else if (matches(e, 'watch.save')) act = save;
    else if (matches(e, 'watch.autoPause')) act = toggleAutoPause;
    else if (matches(e, 'watch.subs')) act = cycleSubs;
    // = the ··· / blurred line's click, which also lifts the hard-subtitle mask for this line; with the
    // subtitle showing anyway, V lifts / restores the mask (docs/subtitle-mask.md「临时掀开」)
    else if (matches(e, 'watch.peek') && (prefs.subs !== 'show' ? !!shown : maskShowing(record.id, true))) act = () => {
      if (prefs.subs === 'show') return togglePeek();
      setRevealed(shown!.id);
      if (maskShowing(record.id, true)) setPeek(true);
    };
    else if (matches(e, 'watch.full')) act = toggleFull;
    else if (matches(e, 'watch.anki') && ankiReady) act = toAnki;
    if (!act) return;
    e.preventDefault();
    act();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The back button shows only with the pointer near the top, the controls only near the
  // bottom (or on them, menus included); both show for a moment on entry so they can be found.
  // The controls hold still while the pointer is on the subtitle band or a definition is open:
  // they move the subtitle, and a subtitle that jumps away from the pointer can't be clicked.
  // The pointer itself hides after a still moment while playing.
  const idle = useRef(0);
  const onMove = (e: React.MouseEvent) => {
    const el = e.target as Element;
    const inList = !!el.closest?.('[data-watch-list]'); // the list is beside the picture, not on it
    const top = !inList && (e.clientY < TOP_ZONE || !!el.closest?.('header'));
    const hold = def.word !== null || !!el.closest?.('[data-watch-line], [data-subtitle-mask]'); // the mask: reaching its lower edge mustn't bring the bar over it
    setNear(n => {
      const bottom = hold ? n.bottom : !inList && (e.clientY > window.innerHeight - BOTTOM_ZONE || !!el.closest?.('footer'));
      return n.top === top && n.bottom === bottom ? n : { top, bottom };
    });
    setAwake(true);
    window.clearTimeout(idle.current);
    idle.current = window.setTimeout(() => setAwake(false), IDLE_MS);
  };
  useEffect(() => {
    const id = window.setTimeout(() => setIntro(false), IDLE_MS);
    return () => { window.clearTimeout(id); window.clearTimeout(idle.current); };
  }, []);
  const showTop = intro || near.top;
  const showBottom = intro || near.bottom || prefs.pin;
  const hideCursor = !awake && playing && !near.top && !near.bottom;

  // Fullscreen is the window's; the green button can change it too, so read it back on every resize.
  const fullRef = useRef(false);
  fullRef.current = full;
  useEffect(() => {
    const sync = () => { isFullscreen().then(setFull).catch(() => {}); };
    sync();
    window.addEventListener('resize', sync);
    return () => {
      window.removeEventListener('resize', sync);
      if (fullRef.current) setFullscreen(false).catch(console.error); // leaving the page leaves fullscreen
    };
  }, []);
  // Set the wanted state at once: the Mac's fullscreen animation takes ~0.5 s, and asking
  // right after the call can still say "not fullscreen". Resizes read the real state back.
  const toggleFull = () => {
    const next = !fullRef.current;
    fullRef.current = next;
    setFull(next);
    setFullscreen(next).catch(console.error);
    window.setTimeout(() => { isFullscreen().then(setFull).catch(() => {}); }, 1200); // after the animation
  };

  const scrub = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.type === 'pointermove' && !e.buttons) return;
    if (e.type === 'pointerdown') e.currentTarget.setPointerCapture(e.pointerId);
    const r = e.currentTarget.getBoundingClientRect();
    if (duration) seek(((e.clientX - r.left) / r.width) * duration);
  };

  const isSaved = !!target && savedIds.has(target.id);
  const mySaved = savedItems.filter(l => mine.includes(l.id));
  const withKey = (label: string, key: string) => `${label} (${key})`;
  const key = (id: string) => formatCombo(combos[`watch.${id}`]);
  const onOff = (label: string, on: boolean) => <><span className="flex-1">{label}</span>{on && <Check size={15} className="text-accent" />}</>;
  const legend = watchLegend(key, t, ankiReady);

  return (
    <div className={`fixed inset-0 bg-black select-none ${hideCursor ? 'cursor-none' : ''}`} onMouseMove={onMove} onMouseLeave={() => setNear(n => ({ top: false, bottom: def.word !== null && n.bottom }))}>
      <div className="absolute inset-y-0 left-0" style={{ right: prefs.list ? `${listPct}%` : 0 }}>
      <video ref={videoRef} crossOrigin="anonymous" src={videoSrcFromPath(record.videoPath!)} className="absolute inset-0 w-full h-full object-contain"
        onLoadedMetadata={onLoaded} onTimeUpdate={onTime} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={onEnded}
        onError={() => setFailed(true)} onClick={togglePlay} />
      <SubtitleMask videoId={record.id} media={videoRef} onTap={togglePlay} />

      {failed && <p className="absolute inset-0 flex items-center justify-center px-8 text-center text-white/80 text-sm pointer-events-none">{t('watch.videoFailed')}</p>}
      {!failed && !playing && !recording && !summary && def.word === null && (
        <button type="button" onClick={togglePlay} aria-label={t('transport.playSpace')}
          className="press absolute z-20 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent text-white w-16 h-16 flex items-center justify-center">
          <Play size={26} fill="currentColor" className="ml-1" />
        </button>
      )}

      {/* Back, on the traffic lights' centre line like the practice page */}
      <header className={`absolute inset-x-0 top-0 h-16 ${IS_WINDOWS ? 'pl-4' : 'pl-24'} pr-4 flex items-center justify-between gap-2 [&>*]:relative [&>*]:z-20 transition-opacity [&:focus-within]:opacity-100 [&:focus-within]:pointer-events-auto ${showTop ? 'opacity-100' : 'opacity-0 pointer-events-none'}`} data-tauri-drag-region="deep">
        <button type="button" onClick={leave} disabled={recording} title={t('studio.backToVideos')} aria-label={t('studio.backToVideos')}
          className="h-10 pl-3 pr-4 flex items-center gap-1.5 min-w-0 max-w-[42%] rounded-full bg-page border border-line text-ink text-[13px] hover:bg-shade disabled:opacity-60">
          <ArrowLeft size={16} className="shrink-0" /><span className="truncate">{record.displayName}</span>
        </button>
        {onSwitchWay && <WayBar current="watch" record={record} hasReader={!!hasReader} hasListen={!!hasListen} variant="cinema" disabled={recording} blocked={recording || wordRecording.current || !!drill || summary || def.word !== null} onSelect={switchWay} />}
        {onSwitchWay && <span className="w-28 min-w-0 shrink-[99] pointer-events-none" />}
      </header>

      {toast.view}
      {recording && (
        <div className="absolute left-1/2 -translate-x-1/2 top-5 z-20 pointer-events-none">
          <Stamp tone="accent-soft" className="!px-3 !py-1.5 !text-sm blink">{t('transport.recordingBanner')}</Stamp>
        </div>
      )}

      {/* The subtitle rides above the controls while they show */}
      {shown && (
        <div data-watch-line className="absolute z-20 inset-x-0 px-6 flex justify-center pointer-events-none [&>*]:pointer-events-auto text-center transition-[bottom] duration-200" style={{ bottom: showBottom ? 132 : 44 }}>
          <WatchLine key={shown.id} videoId={record.id} ja={dictLang === 'ja'} text={shown.text} subs={prefs.subs} revealed={revealed === shown.id}
            onReveal={() => setRevealed(shown.id)} onWord={w => onWord(w, shown)} onPress={pauseForLookup} onCancel={unpause} />
        </div>
      )}

      {/* Controls */}
      <footer className={`absolute z-20 inset-x-4 lg:inset-x-6 bottom-4 lg:bottom-6 px-4 pt-2.5 pb-2 rounded-2xl bg-page shadow-card transition-opacity ${showBottom ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
        <div className="h-4 flex items-center cursor-pointer" onPointerDown={scrub} onPointerMove={scrub} role="slider" aria-label={t('transport.seek')}
          aria-valuemin={0} aria-valuemax={Math.round(duration)} aria-valuenow={Math.round(time)}>
          <div className="relative w-full h-1 rounded-full bg-line">
            <div className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${duration ? (time / duration) * 100 : 0}%` }} />
          </div>
        </div>
        <div className="mt-1 flex items-center gap-2 text-mute">
          <div className="flex-1 min-w-0 flex items-center gap-1">
            <span className="text-xs tabular-nums pr-2 whitespace-nowrap">{formatTimeCode(time)} / {formatTimeCode(duration)}</span>
            <Btn square size="sm" flat onClick={save} disabled={recording || !target} title={withKey(isSaved ? t('transport.unsaveLine') : t('transport.saveLine'), key('save'))} className={isSaved ? '!text-accent' : ''}>
              <Bookmark size={17} fill={isSaved ? 'currentColor' : 'none'} />
            </Btn>
          </div>
          <div className="flex items-center gap-1.5 shrink-0 text-ink">
            <Btn square flat onClick={replay} disabled={recording || !target} title={withKey(t('transport.replayLine'), key('replay'))} className="!text-ink"><RotateCcw size={18} /></Btn>
            <button type="button" onClick={e => { e.currentTarget.blur(); togglePlay(); }} disabled={recording} aria-label={playing ? t('transport.pauseSpace') : t('transport.playSpace')}
              className="press w-11 h-11 rounded-full bg-accent text-white flex items-center justify-center">
              {playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" className="ml-0.5" />}
            </button>
            <Btn square flat onClick={onToggleLoop} disabled={recording} aria-pressed={loop.loopOn}
              title={t('watch.loopTitle', { key: key('loop') })} aria-label={t('watch.loop')}
              className={`relative ${loop.loopOn ? '!text-accent' : '!text-ink'}`}>
              <Repeat size={18} />
              {loop.loopOn && loop.times > 0 && <span className="absolute right-0.5 bottom-0.5 text-[10px] font-semibold leading-none">{loop.times}</span>}
            </Btn>
          </div>
          <div className="flex-1 min-w-0 flex items-center justify-end gap-2">
            <Btn square size="sm" flat onClick={toggleFull} title={withKey(full ? t('watch.exitFullscreen') : t('watch.fullscreen'), key('full'))} aria-label={full ? t('watch.exitFullscreen') : t('watch.fullscreen')}>
              {full ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
            </Btn>
            {/* Everything used less than once a line: how subtitles show, the pause at each line's end, the list, pinning, Anki */}
            <Menu up className="w-[280px]" items={[
              { label: onOff(t('watch.autoPause'), prefs.autoPause), title: withKey(t('watch.autoPauseTitle'), key('autoPause')), onClick: toggleAutoPause },
              { label: onOff(t('watch.list'), prefs.list), onClick: () => setPrefs({ list: !prefs.list }) },
              { label: onOff(t('watch.pin'), prefs.pin), onClick: () => setPrefs({ pin: !prefs.pin }) },
              ...(ankiReady ? [{ label: t('transport.sendToAnki'), title: key('anki'), disabled: ankiStatus !== 'idle' || !target, onClick: toAnki }] : []),
              ...maskItems,
              'divider',
            ]} trigger={(open, toggle) => (
              <Btn square size="sm" flat onClick={toggle} title={t('home.more')} aria-label={t('home.more')} className={open ? '!bg-shade !text-ink' : ''}><MoreHorizontal size={18} /></Btn>
            )} footer={
              <div className="px-2.5 py-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
                {legend.map(([k, label]) => (
                  <React.Fragment key={label}><span className="text-ink/80 whitespace-nowrap">{k}</span><span className="text-mute">{label}</span></React.Fragment>
                ))}
              </div>
            }>
              <div className="px-2.5 py-2 flex flex-col gap-2">
                <span className="text-xs text-mute">{t('transport.speed')}</span>
                <Seg<number> size="sm" className="w-full [&>button]:flex-1 [&>button]:px-0" value={speed} onChange={setSpeed} options={SPEEDS.watch.map(s => ({ value: s, label: `${s}×` }))} />
                <span className="text-xs text-mute">{t('transport.loopTimes')}</span>
                <Seg<LoopTimes> size="sm" className="w-full [&>button]:flex-1" value={loop.times} onChange={setLoopTimes} options={LOOP_TIMES.map(n => ({ value: n, label: n ? t('transport.loopN', { n }) : t('transport.loopForever') }))} />
                <span className="text-xs text-mute">{withKey(t('watch.keySubs'), key('subs'))}</span>
                <Seg size="sm" className="w-full [&>button]:flex-1" value={prefs.subs} onChange={subs => setPrefs({ subs })} options={SUBS.map(s => ({ value: s, label: t(`watch.subsShort_${s}` as DictKey) }))} />
              </div>
            </Menu>
          </div>
        </div>
      </footer>
      </div>

      {prefs.list && (
        <WatchList lines={lines} at={cur.at} pct={listPct} onPick={jump} onClose={() => setPrefs({ list: false })}
          onResize={(pct, done) => { setListPct(pct); if (done) setPrefs({ listPct: pct }); }} />
      )}

      {summary && (
        <WatchSummary title={t('watch.summaryEnded')} savedEmpty={t('watch.savedEmpty')} savedHead={t('watch.savedNow', { n: mySaved.length })} tick={5} saved={mySaved} looked={looked}
          actions={<>
            <Btn onClick={onExit}><ArrowLeft size={16} /> {t('studio.backToVideosBtn')}</Btn>
            <Btn onClick={() => { setSummary(false); seek(0, true); }}><RotateCcw size={16} /> {t('watch.restart')}</Btn>
          </>}
          onClose={() => setSummary(false)}
          onJump={line => { setSummary(false); seek(line.startTime, true); }}
          onWord={w => onWord(w.word, w.line, true)}
          onDrill={lines => { startDrill(lines).catch(console.error); }} />
      )}
      {def.word !== null && (
        <DefinitionPanel key={def.word} def={def} onClose={closeLookup} onWordToAnki={ankiReady ? wordToAnki : undefined} onExplain={explain} onKeepWord={keepWord}
          say={lookLine.current ? { videoId: record.id, text: lookLine.current.text, start: lookLine.current.startTime, end: lookLine.current.endTime, busy: recording } : null} />
      )}
      {drill && <ReviewSession cards={drill} onClose={() => setDrill(null)} />}
    </div>
  );
};

export default WatchPage;
