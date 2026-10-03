import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Bookmark, Maximize2, Minimize2, MoreHorizontal, Pause, Play, RotateCcw, Check } from 'lucide-react';
import { Subtitle, VideoRecord } from '../types';
import { Btn, Menu, Seg, Stamp, useToast } from './ui';
import WatchLine from './WatchLine';
import WatchList from './WatchList';
import WatchSummary, { Looked } from './WatchSummary';
import DefinitionPanel from './DefinitionPanel';
import ReviewSession from './ReviewSession';
import { useLookup, aroundOf } from '../hooks/useLookup';
import { useSavedLines } from '../hooks/useSavedLines';
import { useAnkiIntegration } from '../hooks/useAnkiIntegration';
import { lineAt, parseSRT } from '../utils/srtParser';
import { isFullscreen, setFullscreen, videoSrcFromPath } from '../utils/desktop';
import { detectLang } from '../utils/dictionary';
import { settleSplits } from '../utils/jaSegments';
import { addWord, lineCardsFor, ReviewCard } from '../utils/review';
import { formatTimeCode, getWatchPos, getWatchPrefs, saveWatchPrefs, setWatchPos, WatchPrefs, WatchSubs } from '../utils/storage';
import { formatCombo, matches, useShortcuts } from '../utils/shortcuts';
import { IS_WINDOWS } from '../utils/platform';
import { DictKey, useT } from '../utils/i18n';

// Watch mode: the whole window is the video, the subtitle sits on the picture.
// Look words up, save lines (S), send them to Anki, and at the end dictate a few
// of the lines saved this time; leaving midway just leaves. Its own page: the practice
// session, its sections and its progress are never touched.

const SPEEDS = [0.75, 0.9, 1, 1.25, 1.5, 2];
const SUBS: WatchSubs[] = ['show', 'blur', 'hide'];
const IDLE_MS = 2500; // the pointer hides after this long still; both bars show this long on entry
const TOP_ZONE = 88; // px from the top edge that bring the back button up
const BOTTOM_ZONE = 44; // px from the bottom edge that bring the controls up: below the subtitle, so aiming at a word doesn't

const WatchPage: React.FC<{ record: VideoRecord; onExit: () => void }> = ({ record, onExit }) => {
  const t = useT();
  const combos = useShortcuts();
  const lines = useMemo(() => [...parseSRT(record.subtitleText)].sort((a, b) => a.startTime - b.startTime), [record.subtitleText]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [failed, setFailed] = useState(false);
  const [prefs, setPrefsState] = useState<WatchPrefs>(getWatchPrefs);
  const [speed, setSpeed] = useState(1);
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
  const target = cur.at >= 0 ? lines[cur.at] : null; // what S / Anki / replay act on
  const [listPct, setListPct] = useState(prefs.listPct); // live while dragging; saved on release
  const setPrefs = (patch: Partial<WatchPrefs>) => {
    if (patch.subs) setRevealed(null); // a line opened in one display is covered again by the next
    setPrefsState(p => ({ ...p, ...patch }));
    saveWatchPrefs(patch);
  };
  const toast = useToast();
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

  // --- Playback ---
  // One loop follows the clock: which line is on screen, and the optional pause at a line's end
  // (only when playback crossed that end by itself, not when a seek landed past it). The pause
  // steps back inside the line, so the line just heard stays on screen for S / lookup / replay,
  // not the next one; `heldAt` keeps it from pausing on that same end again when play resumes.
  const prevT = useRef(0);
  const heldAt = useRef(-1);
  const autoPauseRef = useRef(prefs.autoPause);
  autoPauseRef.current = prefs.autoPause;
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const v = videoRef.current;
      if (v) {
        const now = v.currentTime, before = prevT.current;
        const at = lineAt(lines, now);
        const on = at >= 0 && now < lines[at].endTime;
        setCur(c => (c.at === at && c.on === on ? c : { at, on }));
        const was = lineAt(lines, before);
        if (autoPauseRef.current && !busy() && !v.paused && was >= 0 && was !== heldAt.current
          && before < lines[was].endTime && now >= lines[was].endTime && now - before < 0.5 * Math.max(1, v.playbackRate)) {
          v.pause();
          heldAt.current = was;
          const back = Math.max(lines[was].startTime, lines[was].endTime - 0.02);
          v.currentTime = back;
          prevT.current = back;
        } else prevT.current = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [lines]); // eslint-disable-line react-hooks/exhaustive-deps

  const seek = useCallback((sec: number, play = false) => {
    const v = videoRef.current;
    if (!v || busy()) return;
    heldAt.current = -1;
    const to = Math.max(0, Math.min(sec, Number.isFinite(v.duration) ? v.duration - 0.05 : sec));
    v.currentTime = to;
    prevT.current = to;
    if (play) v.play().catch(() => {});
  }, []);
  const togglePlay = () => {
    const v = videoRef.current;
    if (!v || busy()) return;
    resumeAfter.current = false; // played / paused by hand: closing the definition leaves it be
    if (v.paused) v.play().catch(() => {}); else v.pause();
  };
  const jump = (i: number) => { if (i >= 0 && i < lines.length) seek(lines[i].startTime, true); };
  // Previous = the line before the one on screen; in the gap after a line, that line itself.
  const prev = () => jump(cur.on ? cur.at - 1 : cur.at);
  const next = () => jump(cur.at + 1);
  const replay = () => { if (target) seek(target.startTime, true); };

  // Resume where the last watch stopped (the end counts as the start).
  const onLoaded = () => {
    const v = videoRef.current;
    if (!v) return;
    setDuration(v.duration);
    const pos = getWatchPos(record.id);
    if (pos > 0 && pos < v.duration - 3) seek(pos);
    v.play().catch(() => {});
  };
  const lastSaved = useRef(0);
  const onTime = () => {
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
    return () => { if (v && !v.ended && v.currentTime > 0) setWatchPos(record.id, v.currentTime); };
  }, [record.id]);
  useEffect(() => { if (videoRef.current) videoRef.current.playbackRate = speed; }, [speed]);

  // --- Lookup: pauses the video; closing the card resumes it if it was playing ---
  const dictLang = useMemo(() => detectLang(lines.map(l => l.text)), [lines]);
  useEffect(() => { settleSplits(record.id, lines.map(l => l.text)).catch(() => {}); }, [record.id, lines]); // words, and the reader's marks on them
  const { def, lookup, explain, closeDef } = useLookup(dictLang, shown?.text ?? '');
  const lookLine = useRef<Subtitle | null>(null);
  const resumeAfter = useRef(false);
  // Pressing a word pauses already: dragging across a phrase, the line must not move on.
  const pauseForLookup = () => {
    const v = videoRef.current;
    if (v && !v.paused && !busy()) { resumeAfter.current = true; v.pause(); }
  };
  const unpause = () => {
    if (resumeAfter.current && !summary) videoRef.current?.play().catch(() => {});
    resumeAfter.current = false;
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
  const toAnki = () => { if (target && !busy()) handleAddToAnki(target); };
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

  // --- Summary: only at the end; leaving midway never asks (the saved lines are review cards already) ---
  const leave = () => { if (!busy()) onExit(); };
  const onEnded = () => {
    if (busy()) return; // an Anki clip ran to the very end: not a finished watch
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
    if (e.key === 'Escape') {
      if (def.word !== null) closeLookup();
      else if (summary) setSummary(false);
      else if (full) toggleFull();
      return;
    }
    if (summary || recording) return;
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
    const mod = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
    let act: (() => void) | null = null;
    if (matches(e, 'replay')) act = replay;
    else if (e.code === 'Space' && plain) act = togglePlay;
    // ← / → change lines — a learner's jump is by line, not by seconds (⌘ too, as before).
    else if (((plain || mod) && e.code === 'ArrowLeft') || matches(e, 'prev')) act = prev;
    else if (((plain || mod) && e.code === 'ArrowRight') || matches(e, 'next')) act = next;
    else if (plain && e.code === 'KeyS') act = save;
    else if (plain && e.code === 'KeyP') act = toggleAutoPause;
    else if (plain && e.code === 'KeyC') act = cycleSubs;
    else if (plain && e.code === 'KeyV' && shown && prefs.subs !== 'show') act = () => setRevealed(shown.id); // = the ··· / blurred line's click
    else if (plain && e.code === 'KeyF') act = toggleFull;
    else if (matches(e, 'anki') && ankiReady) act = toAnki;
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
    const hold = def.word !== null || !!el.closest?.('[data-watch-line]');
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
  const onOff = (label: string, on: boolean) => <><span className="flex-1">{label}</span>{on && <Check size={15} className="text-accent" />}</>;
  const legend: [string, string][] = [
    [formatCombo(combos.play), t('keys.play')],
    [`← / ${formatCombo(combos.prev)}`, t('keys.prev')],
    [`→ / ${formatCombo(combos.next)}`, t('keys.next')],
    [formatCombo(combos.replay), t('keys.replay')],
    ['S', t('watch.keySave')],
    ['P', t('watch.autoPause')],
    ['C', t('watch.keySubs')],
    ['V', t('watch.showLine')],
    ['F', t('watch.fullscreen')],
    ...(ankiReady ? [[formatCombo(combos.anki), t('keys.anki')] as [string, string]] : []),
  ];

  return (
    <div className={`fixed inset-0 bg-black select-none ${hideCursor ? 'cursor-none' : ''}`} onMouseMove={onMove} onMouseLeave={() => setNear(n => ({ top: false, bottom: def.word !== null && n.bottom }))}>
      <div className="absolute inset-y-0 left-0" style={{ right: prefs.list ? `${listPct}%` : 0 }}>
      <video ref={videoRef} crossOrigin="anonymous" src={videoSrcFromPath(record.videoPath!)} className="absolute inset-0 w-full h-full object-contain"
        onLoadedMetadata={onLoaded} onTimeUpdate={onTime} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={onEnded}
        onError={() => setFailed(true)} onClick={togglePlay} />

      {failed && <p className="absolute inset-0 flex items-center justify-center px-8 text-center text-white/80 text-sm pointer-events-none">{t('watch.videoFailed')}</p>}
      {!failed && !playing && !recording && !summary && def.word === null && (
        <button type="button" onClick={togglePlay} aria-label={t('transport.playSpace')}
          className="press absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent text-white w-16 h-16 flex items-center justify-center">
          <Play size={26} fill="currentColor" className="ml-1" />
        </button>
      )}

      {/* Back, on the traffic lights' centre line like the practice page */}
      <header className={`absolute inset-x-0 top-0 h-16 ${IS_WINDOWS ? 'pl-4' : 'pl-24'} pr-4 flex items-center transition-opacity ${showTop ? 'opacity-100' : 'opacity-0 pointer-events-none'}`} data-tauri-drag-region="deep">
        <button type="button" onClick={leave} disabled={recording} title={t('studio.backToVideos')} aria-label={t('studio.backToVideos')}
          className="h-10 pl-3 pr-4 flex items-center gap-1.5 min-w-0 max-w-[60%] rounded-full bg-page border border-line text-ink text-[13px] hover:bg-shade disabled:opacity-60">
          <ArrowLeft size={16} className="shrink-0" /><span className="truncate">{record.displayName}</span>
        </button>
      </header>

      {toast.view}
      {recording && (
        <div className="absolute left-1/2 -translate-x-1/2 top-5 z-20 pointer-events-none">
          <Stamp tone="accent-soft" className="!px-3 !py-1.5 !text-sm blink">{t('transport.recordingBanner')}</Stamp>
        </div>
      )}

      {/* The subtitle rides above the controls while they show */}
      {shown && (
        <div data-watch-line className="absolute inset-x-0 px-6 flex justify-center text-center transition-[bottom] duration-200" style={{ bottom: showBottom ? 132 : 44 }}>
          <WatchLine key={shown.id} videoId={record.id} ja={dictLang === 'ja'} text={shown.text} subs={prefs.subs} revealed={revealed === shown.id}
            onReveal={() => setRevealed(shown.id)} onWord={w => onWord(w, shown)} onPress={pauseForLookup} onCancel={unpause} />
        </div>
      )}

      {/* Controls */}
      <footer className={`absolute inset-x-4 lg:inset-x-6 bottom-4 lg:bottom-6 px-4 pt-2.5 pb-2 rounded-2xl bg-page shadow-card transition-opacity ${showBottom ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
        <div className="h-4 flex items-center cursor-pointer" onPointerDown={scrub} onPointerMove={scrub} role="slider" aria-label={t('transport.seek')}
          aria-valuemin={0} aria-valuemax={Math.round(duration)} aria-valuenow={Math.round(time)}>
          <div className="relative w-full h-1 rounded-full bg-line">
            <div className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${duration ? (time / duration) * 100 : 0}%` }} />
          </div>
        </div>
        <div className="mt-1 flex items-center gap-2 text-mute">
          <div className="flex-1 min-w-0 flex items-center gap-1">
            <span className="text-xs tabular-nums pr-2 whitespace-nowrap">{formatTimeCode(time)} / {formatTimeCode(duration)}</span>
            <Btn square size="sm" flat onClick={save} disabled={recording || !target} title={withKey(isSaved ? t('transport.unsaveLine') : t('transport.saveLine'), 'S')} className={isSaved ? '!text-accent' : ''}>
              <Bookmark size={17} fill={isSaved ? 'currentColor' : 'none'} />
            </Btn>
          </div>
          <div className="flex items-center gap-1.5 shrink-0 text-ink">
            <Btn square flat onClick={replay} disabled={recording || !target} title={withKey(t('transport.replayLine'), formatCombo(combos.replay))} className="!text-ink"><RotateCcw size={18} /></Btn>
            <button type="button" onClick={e => { e.currentTarget.blur(); togglePlay(); }} disabled={recording} aria-label={playing ? t('transport.pauseSpace') : t('transport.playSpace')}
              className="press w-11 h-11 rounded-full bg-accent text-white flex items-center justify-center">
              {playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" className="ml-0.5" />}
            </button>
            <span className="w-10" />{/* keeps play in the middle now that replay sits alone beside it */}
          </div>
          <div className="flex-1 min-w-0 flex items-center justify-end gap-2">
            <Btn square size="sm" flat onClick={toggleFull} title={withKey(full ? t('watch.exitFullscreen') : t('watch.fullscreen'), 'F')} aria-label={full ? t('watch.exitFullscreen') : t('watch.fullscreen')}>
              {full ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
            </Btn>
            {/* Everything used less than once a line: how subtitles show, the pause at each line's end, the list, pinning, Anki */}
            <Menu up className="w-[280px]" items={[
              { label: onOff(t('watch.autoPause'), prefs.autoPause), title: withKey(t('watch.autoPauseTitle'), 'P'), onClick: toggleAutoPause },
              { label: onOff(t('watch.list'), prefs.list), onClick: () => setPrefs({ list: !prefs.list }) },
              { label: onOff(t('watch.pin'), prefs.pin), onClick: () => setPrefs({ pin: !prefs.pin }) },
              ...(ankiReady ? [{ label: t('transport.sendToAnki'), title: formatCombo(combos.anki), disabled: ankiStatus !== 'idle' || !target, onClick: toAnki }] : []),
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
                <Seg<number> size="sm" className="w-full [&>button]:flex-1 [&>button]:px-0" value={speed} onChange={setSpeed} options={SPEEDS.map(s => ({ value: s, label: `${s}×` }))} />
                <span className="text-xs text-mute">{withKey(t('watch.keySubs'), 'C')}</span>
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
        <DefinitionPanel key={def.word} def={def} onClose={closeLookup} onWordToAnki={ankiReady ? wordToAnki : undefined} onExplain={explain} onKeepWord={keepWord} />
      )}
      {drill && <ReviewSession cards={drill} onClose={() => setDrill(null)} />}
    </div>
  );
};

export default WatchPage;
