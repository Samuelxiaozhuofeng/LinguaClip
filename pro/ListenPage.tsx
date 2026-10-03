import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowLeft } from 'lucide-react';
import type { Subtitle, VideoRecord } from '../types';
import { Btn, Seg, useToast } from '../components/ui';
import ReaderLine from './ReaderLine';
import DefinitionPanel from '../components/DefinitionPanel';
import WatchSummary from '../components/WatchSummary';
import ReviewSession from '../components/ReviewSession';
import { JaBanner } from '../components/JaSetup';
import { useSavedLines } from '../hooks/useSavedLines';
import { lineAt, parseSRT } from '../utils/srtParser';
import { buildSections, sectionAt, sectionLengthOf, sectionStart } from '../utils/sections';
import { detectLang } from '../utils/dictionary';
import { useJaVersion } from '../utils/japanese';
import { settleSplits } from '../utils/jaSegments';
import { videoSrcFromPath } from '../utils/desktop';
import { getWatchPos, getWatchPrefs, saveWatchPrefs, setWatchPos, type WatchSubs } from '../utils/storage';
import { LOOP_GAP_MS, loopMore, setLoopOn, useLoop } from '../utils/loop';
import { matches } from '../utils/shortcuts';
import { IS_WINDOWS } from '../utils/platform';
import { useT, type DictKey } from '../utils/i18n';
import { useListenText } from './useListenText';
import { useListenWords, type Word } from './useListenWords';
import { DrillBar, IntroCard, ListenBlind, PassCard, StepBar, rateText, useHeardAsk } from './ListenCoach';
import ListenBar from './ListenBar';
import { recordRate } from './listenLevel';
import PodcastPicker from './PodcastPicker';
import type { Pick } from './podcastShows';

// Intensive listening to something with no picture — a podcast episode or a sound file
// (docs/private/podcast.md). One section at a time, in three steps: blind (S / A / V mark lines hard),
// the hard lines each looped blind until "got it" or its text shows (none marked and little followed:
// the whole transcript), then the summary — hard and saved lines to dictate, words to keep.
// "Free listening" leaves the steps. This file: playback and its stops, the steps, keys, layout;
// the transcript's scrolling / translation is useListenText, lookups and review useListenWords,
// the coaching cards ListenCoach. Opens at the start of the section left in, on step 1.

const MODES: WatchSubs[] = ['hide', 'show'];
const SEEK = 5;
type Mark = 'open' | 'ok' | 'more'; // a hard line: not worked on yet / got it now / needs more work

const ListenPage: React.FC<{ record: VideoRecord; onExit: () => void; onPractice: () => void; onOpen?: (r: VideoRecord) => void }> = ({ record, onExit, onPractice, onOpen }) => {
  const t = useT();
  const lines = useMemo(() => [...parseSRT(record.subtitleText)].sort((a, b) => a.startTime - b.startTime), [record.subtitleText]);
  const sections = useMemo(() => buildSections(lines, sectionLengthOf(record)), [lines]);
  const sectionOf = useMemo(() => new Map(sections.flatMap((s, i) => s.subtitles.map(l => [l.id, i] as const))), [sections]);
  const indexOf = useMemo(() => new Map(lines.map((l, i) => [l.id, i])), [lines]);
  const dictLang = useMemo(() => detectLang(lines.map(l => l.text)), [lines]);
  const ja = dictLang === 'ja';
  const jaVersion = useJaVersion();
  const [kana] = useState(() => getWatchPrefs().kana);
  useEffect(() => { settleSplits(record.id, lines.map(l => l.text)).catch(() => {}); }, [record.id, lines]);

  const audio = useRef<HTMLAudioElement>(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [mode, setModeState] = useState<WatchSubs>(() => getWatchPrefs().listenSubs);
  const setMode = (m: WatchSubs) => { setModeState(m); saveWatchPrefs({ listenSubs: m }); };
  const [autoPause, setAutoPause] = useState(() => getWatchPrefs().autoPause);
  const [free, setFree] = useState(false); // off the steps; not kept: every visit starts on them
  const passes = !free;
  const [throughPref, setThrough] = useState(() => getWatchPrefs().listenThrough);
  const through = free && throughPref; // "play on" is free listening's; the steps stop at every section end
  const toggleThrough = () => { setThrough(!throughPref); saveWatchPrefs({ listenThrough: !throughPref }); };
  const [intro, setIntro] = useState(() => !getWatchPrefs().listenIntro);
  const introRef = useRef(intro);
  introRef.current = intro;
  const [pass, setPass] = useState(1);
  const [passMode, setPassMode] = useState<WatchSubs | null>(null); // C pressed during this pass
  const [passCard, setPassCard] = useState<number | null>(null); // the pass just heard
  const [marks, setMarks] = useState<Map<number, Mark>>(new Map()); // hard lines, this visit (never stored: "saved" is the star)
  const [queue, setQueue] = useState<number[] | null>(null); // step 2's hard lines, fixed as it starts
  const [qAt, setQAt] = useState(0);
  const [tries] = useState(() => getWatchPrefs().listenTries); // blind plays of a hard line before its text shows
  const [play, setPlay] = useState(1); // which blind play of step 2's hard line this is
  const [shown, setShown] = useState(false); // its text is up: it needs more work
  const armed = useRef<number | null>(null); // the next pass, started by play too
  const effMode: WatchSubs = passes ? (queue ? (shown ? 'show' : 'hide') : passMode ?? (pass === 2 ? 'show' : 'hide')) : mode;
  const changeMode = (m: WatchSubs) => { if (passes) setPassMode(m); else setMode(m); };
  const [peek, setPeek] = useState<number | null>(null);
  const [pickerShow, setPickerShow] = useState<Pick | null>(null); // under it the card / summary step aside (Esc is the picker's)
  const rate = useMemo(() => recordRate(record), [record]);
  const loop = useLoop();
  const [summary, setSummary] = useState<{ ended: boolean } | null>(null);
  const summaryRef = useRef(summary);
  summaryRef.current = summary;

  // Closing it plays — unless a step's card or the summary is still waiting under it.
  const closeIntro = () => { setIntro(false); saveWatchPrefs({ listenIntro: true }); if (passCard === null && !summaryRef.current) playOn(); };
  const help = () => { audio.current?.pause(); stopGap(); setIntro(true); }; // a looped line's next play waits too

  const at = lineAt(lines, time);
  const cur = at >= 0 ? lines[at] : null;
  const sec = cur ? sectionOf.get(cur.id) ?? 0 : 0;
  const section = sections[sec];
  // A section ends with its last line, or where the next section's first line starts if they
  // overlap: past that, playback is already in the next section and the stop would be missed.
  const sectionEnd = (i: number) => Math.min(sections[i]?.subtitles.at(-1)?.endTime ?? 0, sections[i + 1]?.subtitles[0]?.startTime ?? Infinity);

  // --- Playback: one loop follows the clock. When playback itself runs past a line's end
  // (not a seek landing past it): the line loop plays it again after a pause; else the end
  // of a section stops and shows its summary; else the optional pause at every line's end.
  const prevT = useRef(0);
  const heldAt = useRef(-1);
  const plays = useRef({ at: -1, n: 1 });
  const gap = useRef(0); // a looped line's next play, waiting out the gap (0: none)
  const stopGap = () => { window.clearTimeout(gap.current); gap.current = 0; };
  const resumeAfter = useRef(false); // a lookup paused playback: closing it plays again
  const target = queue?.[qAt] ?? null; // the hard line step 2 is on: playback stops at its end
  const opts = useRef({ autoPause, through, passes, pass, sec, target, play, shown, tries });
  opts.current = { autoPause, through, passes, pass, sec, target, play, shown, tries };
  const seek = useCallback((to: number, play = false) => {
    const a = audio.current;
    if (!a) return;
    stopGap();
    heldAt.current = -1;
    armed.current = null; // moved: play is play again, not "the next pass"
    resumeAfter.current = false; // moved by hand while a lookup is open: closing it leaves that be
    const s = Math.max(0, Math.min(to, Number.isFinite(a.duration) ? a.duration - 0.05 : to));
    a.currentTime = s;
    prevT.current = s;
    setTime(s);
    if (play) a.play().catch(() => {});
  }, []);
  // Run by every frame and by the audio's own timeupdate: with the window hidden or covered the
  // frames stop but the audio plays on, and a section end crossed then must still stop it.
  // Any forward move not made by seek() is playback (seek moves prevT along), however long.
  const check = useRef(() => {});
  useEffect(() => {
    check.current = () => {
      const a = audio.current;
      if (!a) return;
      const now = a.currentTime, before = prevT.current;
      setTime(x => (Math.abs(x - now) > 0.04 ? now : x));
      const was = lineAt(lines, before);
      if (a.paused || was < 0 || now <= before) { prevT.current = now; return; }
      const line = lines[was];
      const crossed = before < line.endTime && now >= line.endTime;
      const s = sectionOf.get(line.id) ?? 0, end = sectionEnd(s);
      const last = sections[s]?.subtitles.at(-1);
      const lastAt = last ? indexOf.get(last.id) ?? -1 : -1;
      const tgt = opts.current.target !== null ? indexOf.get(opts.current.target) ?? -1 : -1;
      const tEnd = tgt >= 0 ? Math.min(lines[tgt].endTime, sectionEnd(sectionOf.get(lines[tgt].id) ?? 0)) : 0; // where pause() puts it back: a last line overlapping the next section ends with its section
      const pause = (i: number) => { // back to that line's end (never past its section's); the page's time too, not
        const back = Math.max(lines[i].startTime, Math.min(lines[i].endTime, sectionEnd(sectionOf.get(lines[i].id) ?? 0)) - 0.02);
        a.pause(); a.currentTime = back; setTime(back); // `now`, already in the next section: that would reset the passes
      };
      if (tgt < 0 && crossed && now - before < 0.5 * Math.max(1, a.playbackRate) && loopMore(plays.current.at === was ? plays.current.n : 1)) {
        if (plays.current.at !== was) plays.current = { at: was, n: 1 };
        plays.current.n++;
        pause(was); // the gap is still this line (and this section)
        gap.current = window.setTimeout(() => { gap.current = 0; seek(line.startTime, true); }, LOOP_GAP_MS);
      } else if (tgt >= 0 && before < tEnd && now >= tEnd && heldAt.current !== tgt) {
        pause(tgt); // the hard line heard (from it or a line before it, however long the frame)
        const { play: k, shown: up, tries: n } = opts.current;
        if (up) heldAt.current = tgt; // with its text: stays stopped for the reader
        else { // blind: again after the gap — past the last blind play, once more with the text
          if (k < n) setPlay(k + 1); else { setShown(true); setFollow(true); }
          const from = lines[tgt].startTime;
          gap.current = window.setTimeout(() => { gap.current = 0; seek(from, true); }, LOOP_GAP_MS);
        }
      } else if (!opts.current.through && lastAt >= 0 && before < end && now >= end && heldAt.current !== lastAt) {
        // Once: closing the summary and pressing play goes on past the section end.
        heldAt.current = lastAt;
        pause(lastAt);
        if (opts.current.passes && opts.current.pass < 2) openPass(); else openSummary(false);
      } else if (crossed && now - before < 0.5 * Math.max(1, a.playbackRate) && opts.current.autoPause && heldAt.current !== was) {
        heldAt.current = was;
        pause(was); // (and a line peeked at stays up while held)
      }
      if (crossed && plays.current.at !== was) plays.current = { at: was, n: 1 };
      prevT.current = a.currentTime;
    };
  });
  useEffect(() => {
    let raf = 0;
    const tick = () => { check.current(); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); stopGap(); };
  }, []);

  const togglePlay = () => {
    const a = audio.current;
    if (!a) return;
    resumeAfter.current = false; // played / paused by hand: closing the definition leaves it be
    stopGap();
    if (a.paused && armed.current) startPass(armed.current);
    else if (a.paused) playOn(); else a.pause();
  };
  // Stopped at step 2's hard line (or between its plays): play is that line again, not what follows (nor a play counted twice).
  const playOn = () => {
    const a = audio.current;
    if (!a) return;
    const end = drillLine ? Math.min(drillLine.endTime, sectionEnd(sectionOf.get(drillLine.id) ?? 0)) : NaN;
    if (drillLine && Math.abs(a.currentTime - end) < 0.1) seek(drillLine.startTime, true); else a.play().catch(() => {});
  };
  const jump = (i: number) => { if (i >= 0 && i < lines.length) seek(lines[i].startTime, true); };
  const prev = () => jump(cur && time < cur.endTime ? at - 1 : at);
  const next = () => jump(at + 1);
  const replay = () => { if (cur) seek(cur.startTime, true); };

  const onLoaded = () => {
    const a = audio.current;
    if (!a) return;
    setDuration(a.duration);
    a.playbackRate = speed;
    const pos = getWatchPos(record.id); // back at the start of that section, step 1
    if (pos > 0 && pos < a.duration - 3 && sections.length) seek(sectionStart(sections[sectionAt(sections, pos)]));
    if (!introRef.current) a.play().catch(() => {});
  };
  const lastSaved = useRef(0);
  const onTime = () => {
    check.current();
    const a = audio.current;
    if (a && Math.abs(a.currentTime - lastSaved.current) > 5) { lastSaved.current = a.currentTime; setWatchPos(record.id, a.currentTime); }
  };
  useEffect(() => {
    const a = audio.current;
    return () => { if (a && !a.ended && a.currentTime > 0) setWatchPos(record.id, a.currentTime); };
  }, [record.id]);
  useEffect(() => { if (audio.current) audio.current.playbackRate = speed; }, [speed]);

  const curId = cur?.id ?? null;
  const { scroller, follow, setFollow, armBack, leave, hasTrans, trans, transBusy, openT, onTrans } = useListenText(record, lines, audio, curId, effMode, sec, playing);
  const pick = useCallback((line: Subtitle) => { setFollow(true); seek(line.startTime, true); }, [seek]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Lookup: pauses; closing the card plays the interrupted line again from its start ---
  const { looked, def, explain, closeDef, lookLine, lookUp, noteWord, words, setWords, kept, keep, keepOne, adding, addFail, addMissed, drill, setDrill, drillMissing, startDrill, clearNotes } = useListenWords(record, lines, dictLang, ja, marks);
  const resumeFrom = useRef(0);
  const onWord = useCallback((word: string, line: Subtitle) => {
    const a = audio.current;
    // Playing, or between two plays of a looped line: the next play waits for the card, then goes on.
    if (a && (!a.paused || gap.current)) {
      const i = lineAt(lines, a.currentTime);
      resumeFrom.current = i >= 0 ? lines[i].startTime : a.currentTime;
      resumeAfter.current = true;
      a.pause();
    }
    stopGap();
    noteWord(word, line);
  }, [record.id, ja]); // eslint-disable-line react-hooks/exhaustive-deps
  const closeLookup = () => {
    closeDef();
    if (resumeAfter.current && !summaryRef.current) seek(resumeFrom.current, true);
    resumeAfter.current = false;
  };
  // --- Saved lines (the same star as reading / watching) ---
  const { savedIds, savedItems, toggleSave } = useSavedLines({ videoId: record.id, fullSubtitles: lines, videoFileName: record.videoFileName });
  const saveRef = useRef(toggleSave);
  saveRef.current = toggleSave;
  const onSave = useCallback((line: Subtitle) => saveRef.current(line), []);
  const toast = useToast(); // S has no star under the finger: say what it did
  const { said, canAsk, ask } = useHeardAsk(record, sec, playing && effMode === 'hide', p => setPickerShow(p)); // "how much did you follow"
  // --- The summary at a section's end (or "done with this section") ---
  const summed = useRef(-1); // the section last summed up: its passes are over
  function openSummary(ended: boolean) {
    summed.current = opts.current.sec;
    setPassCard(null); setQueue(null); clearNotes();
    armed.current = null;
    audio.current?.pause();
    stopGap();
    setSummary({ ended });
  }
  // The sections heard since the last summary (with "play on", more than one); set as the
  // audio opens and whenever a summary closes, to the section playing then. Words start over too.
  const since = useRef(0);
  useEffect(() => { if (!summary) { since.current = sec; setWords([]); } }, [summary, duration]); // eslint-disable-line react-hooks/exhaustive-deps
  const heard = (id: number) => { const s = sectionOf.get(id) ?? -1; return s >= Math.min(since.current, sec) && s <= Math.max(since.current, sec); };
  const lastSec = sec === sections.length - 1;
  const goSection = (i: number) => {
    summed.current = -1; // heard again: its steps aren't over (the last section's end would skip them)
    setSummary(null);
    setFollow(true);
    setPass(1); setPassMode(null); setPassCard(null); setQueue(null); // "listen again": all the steps again
    seek(sections[i]?.subtitles[0]?.startTime ?? 0, true);
  };
  // Ran to the very end: with passes left, the last section's next pass.
  const onEnded = () => { if (passes && pass < 2 && summed.current !== sec) openPass(); else { setWatchPos(record.id, 0); openSummary(true); } };

  // --- Three passes: the pass count belongs to one section; getting into another starts it at 1 ---
  const passSec = useRef(sec);
  useEffect(() => {
    if (sec === passSec.current) return;
    passSec.current = sec;
    setPass(1); setPassMode(null); setPassCard(null); setQueue(null); armed.current = null; summed.current = -1;
  }, [sec]);
  function openPass() {
    audio.current?.pause(); stopGap();
    armed.current = opts.current.pass + 1; setPassCard(opts.current.pass);
  }
  // Step 2 works on the lines marked hard — unless little was followed: then marking missed too much, the whole transcript.
  const secMarks = section ? section.subtitles.filter(l => marks.has(l.id)) : [];
  const hard = said.get(sec)?.a === 'little' ? 0 : secMarks.length;
  function startPass(n: number) { // back to this section's start (step 2: its first hard line): the count stays
    summed.current = -1;
    setPassCard(null); setPass(n); setPassMode(null); setFollow(true);
    const q = n === 2 && hard ? secMarks.map(l => l.id) : null;
    setQueue(q); setQAt(0); setPlay(1); setShown(false);
    seek(q ? secMarks[0].startTime : sections[sec]?.subtitles[0]?.startTime ?? 0, true);
  }
  const drillLine = target !== null ? lines[indexOf.get(target) ?? -1] : undefined;
  const inDrill = !!(queue && drillLine);
  const drillShow = () => { if (drillLine && !shown) { setShown(true); setFollow(true); seek(drillLine.startTime, true); } }; // V / C / the buttons: this line again, with its text
  const drillNext = () => { // got it blind / needed the text, then the next hard line blind; after the last, the summary
    if (target === null || !queue) return;
    setMarks(m => new Map(m).set(target, shown ? 'more' : 'ok'));
    setPlay(1); setShown(false); setFollow(true);
    const next = qAt + 1 < queue.length ? lines[indexOf.get(queue[qAt + 1]) ?? -1] : undefined;
    if (next) { setQAt(qAt + 1); seek(next.startTime, true); } else openSummary(false);
  };
  // Followed most of it blind with nothing marked: moving on is the main way — to the saved lines' dictation, else the next section.
  const hasSaved = section ? section.subtitles.some(l => savedIds.has(l.id)) : false;
  const easy = passCard === 1 && said.get(sec)?.a === 'most' && !secMarks.length;
  const moveOn = () => { if (hasSaved || lastSec) openSummary(false); else goSection(sec + 1); };
  const cardMain = () => { if (easy) moveOn(); else if (passCard) startPass(passCard + 1); };
  const goStep = (n: number) => { setSummary(null); if (n === 3) openSummary(false); else startPass(n); };
  const goFree = (on: boolean) => { // leaving the steps keeps playing; back on them, this section from step 1
    setFree(on);
    if (on) { if (queue) stopGap(); setPassCard(null); setPassMode(null); setQueue(null); armed.current = null; } else goSection(sec); // a hard line's next blind play is dropped
  };

  // --- Hard lines: S (or the blind screen's button) marks / unmarks the line being said; seeing one with V marks it ---
  const flipMark = (id: number, onMsg: 'listen.marked' | 'listen.markedPrev') => {
    const on = marks.has(id);
    toast.say(t(on ? 'listen.unmarked' : onMsg));
    setMarks(m => { const n = new Map(m); if (on) n.delete(id); else n.set(id, 'open'); return n; });
  };
  const toggleMark = () => { if (cur) flipMark(cur.id, 'listen.marked'); };
  // A: the line just heard — in the gap after a line (or stopped at its end: pause() parks 0.02s before it) that's still it,
  // once the next has begun it's the one before. Not across sections.
  const markPrev = () => {
    const i = at >= 0 && time > lines[at].endTime - 0.05 ? at : at - 1;
    if (i < 0 || (sectionOf.get(lines[i].id) ?? 0) !== sec) { toast.say(t('listen.noPrev')); return; }
    flipMark(lines[i].id, 'listen.markedPrev');
  };
  useEffect(() => { if (peek !== null) setMarks(m => (m.has(peek) ? m : new Map(m).set(peek, 'open'))); }, [peek]);
  const markedIds = useMemo(() => new Set(marks.keys()), [marks]);

  // --- Blind: V shows the line being said until playback reaches another one ---
  useEffect(() => { if (peek !== null && peek !== curId) setPeek(null); }, [curId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (effMode !== 'hide' || summary) setPeek(null); }, [effMode, summary]);
  const togglePeek = () => { if (effMode === 'hide' && cur) setPeek(p => (p === cur.id ? null : cur.id)); };
  // "Save and stop here": the ticked hard lines into review, and next visit starts at the next section.
  const keepEnd = async (picked: Subtitle[]) => {
    if (!(await addMissed(picked))) return;
    const to = lastSec ? 0 : sectionStart(sections[sec + 1]);
    if (audio.current) { audio.current.pause(); audio.current.currentTime = to; } // leaving saves where the audio is
    setWatchPos(record.id, to);
    onExit();
  };
  // --- Keys (a dictation round, while open, keeps every key to itself) ---
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e: KeyboardEvent) => {
    if (e.isComposing || e.keyCode === 229 || drill || pickerShow) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (intro) { if (e.key === 'Escape') closeIntro(); return; }
    if (e.key === 'Escape') { if (def.word !== null) closeLookup(); else if (summary) setSummary(null); else if (passCard) setPassCard(null); return; }
    if (summary) return;
    if (passCard && def.word === null) {
      if ((e.code === 'Space' || e.code === 'Enter') && !(e.target instanceof HTMLButtonElement)) { e.preventDefault(); cardMain(); }
      return;
    }
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
    const mod = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
    let act: (() => void) | null = null;
    if (inDrill && (((plain || mod) && e.code === 'ArrowRight') || (plain && e.code === 'Enter' && !(e.target instanceof HTMLButtonElement)) || matches(e, 'next'))) act = () => { if (def.word === null) drillNext(); };
    else if (inDrill && plain && (e.code === 'KeyV' || e.code === 'KeyC')) act = drillShow;
    else if (matches(e, 'replay')) act = replay;
    else if (matches(e, 'loop')) act = () => setLoopOn(!loop.on);
    else if (e.code === 'Space' && plain) act = togglePlay;
    // ← / → change lines, like the watch page (⌘ too); ±5 s is the bar's buttons.
    else if (((plain || mod) && e.code === 'ArrowLeft') || matches(e, 'prev')) act = prev;
    else if (((plain || mod) && e.code === 'ArrowRight') || matches(e, 'next')) act = next;
    else if (plain && e.code === 'KeyS') act = toggleMark;
    else if (plain && e.code === 'KeyA') act = markPrev;
    else if (plain && e.code === 'KeyP') act = () => { setAutoPause(!autoPause); saveWatchPrefs({ autoPause: !autoPause }); };
    else if (plain && e.code === 'KeyC') act = () => changeMode(MODES[(MODES.indexOf(effMode) + 1) % MODES.length]);
    else if (plain && e.code === 'KeyV') act = togglePeek;
    if (!act) return;
    e.preventDefault();
    act();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const inSec = section ? section.subtitles.findIndex(l => l.id === curId) : -1;
  const sumSaved = summary ? savedItems.filter(l => heard(l.id) && !marks.has(l.id)) : [];
  const sumMissed = summary ? lines.filter(l => marks.has(l.id) && heard(l.id)).map(l => ({ line: l, on: marks.get(l.id) !== 'ok', saved: savedIds.has(l.id) })) : [];
  const onward = summary && !summary.ended && !lastSec;

  return (
    <div className="fixed inset-0 bg-paper flex flex-col">
      <audio ref={audio} crossOrigin="anonymous" preload="auto" src={videoSrcFromPath(record.videoPath!)}
        onLoadedMetadata={onLoaded} onTimeUpdate={onTime} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={onEnded} onError={() => setFailed(true)} />

      <header className={`h-16 shrink-0 ${IS_WINDOWS ? 'pl-4' : 'pl-24'} pr-6 flex items-center gap-4 bg-page border-b border-line`} data-tauri-drag-region>
        <button type="button" onClick={onExit} className="press h-10 pl-3 pr-4 flex items-center gap-1.5 min-w-0 max-w-[30%] rounded-full bg-page border border-line text-ink text-[13px] hover:bg-shade">
          <ArrowLeft size={16} className="shrink-0" /><span className="truncate">{record.podcast ? `${record.podcast.show} · ${record.displayName}` : record.displayName}</span>
        </button>
        <div className="flex-1 flex justify-center">
          {passes ? <StepBar step={summary ? 3 : pass} onStep={goStep} onHelp={help} />
            : <Seg<WatchSubs> size="sm" value={effMode} onChange={changeMode} options={MODES.map(m => ({ value: m, label: t(`listen.mode_${m}` as DictKey), title: t('listen.modeKey') }))} />}
        </div>
        {rate && <span className="text-[13px] text-mute whitespace-nowrap" title={t('listen.rateTitle')}>{rateText(rate, t)}</span>}
        {sections.length > 1 && <span className="text-[13px] text-mute whitespace-nowrap">{t('listen.sectionOf', { n: sec + 1, total: sections.length })}</span>}
        {!passes && <Btn tone="ink" onClick={() => openSummary(false)}>{t('listen.done')}</Btn>}
      </header>

      <div className="flex-1 min-h-0 relative">
        {failed ? (
          <p className="h-full flex items-center justify-center text-sm text-mute">{t('listen.failed')}</p>
        ) : effMode === 'hide' ? (
          <ListenBlind image={record.podcast?.image} lines={section?.subtitles ?? []} at={inSec} marked={markedIds} onPick={pick} onPeek={queue ? drillShow : togglePeek} onMark={toggleMark} drill={!!queue}
            hint={!passes ? t('listen.blindHint') : pass === 1 ? t('listen.stepHint_1') : queue ? t('listen.drillBlindHint', { n: tries }) : null}
            peek={peek !== null && cur?.id === peek ? (
              <ReaderLine line={cur} ja={ja} jaVersion={jaVersion} kana={kana} looked={looked} playing saved={savedIds.has(cur.id)} hasTrans={hasTrans}
                transOpen={openT.has(cur.id)} transText={trans?.[indexOf.get(cur.id)!] ?? null} transPending={transBusy}
                onWord={onWord} onListen={pick} onView={pick} onTrans={onTrans} onSave={onSave} onPick={pick} />
            ) : null} />
        ) : (
          <div ref={scroller} className="h-full overflow-y-auto px-8"
            onWheel={leave} onTouchMove={leave} onPointerDown={e => { if (e.target === e.currentTarget) leave(); }} onPointerMove={() => { if (!follow) armBack(); }}>
            <div className="mx-auto max-w-[820px] py-[30vh]">
              {passes && pass === 2 && <p className="mb-6 text-sm text-mute">{t(queue ? 'listen.stepHint_drill' : 'listen.stepHint_2')}</p>}
              {ja && <div className="mb-4"><JaBanner /></div>}
              {section?.subtitles.map(line => (
                <ReaderLine key={line.id} line={line} ja={ja} jaVersion={jaVersion} kana={kana} looked={looked}
                  playing={line.id === curId} saved={savedIds.has(line.id)} hasTrans={hasTrans} transOpen={openT.has(line.id)}
                  transText={trans?.[indexOf.get(line.id)!] ?? null} transPending={transBusy}
                  onWord={onWord} onListen={pick} onView={pick} onTrans={onTrans} onSave={onSave} onPick={pick} />
              ))}
            </div>
          </div>
        )}
        {toast.view}
        {queue && drillLine && !summary && <DrillBar n={qAt + 1} total={queue.length} play={play} tries={tries} shown={shown} onShow={drillShow} onNext={drillNext} />}
        {!follow && effMode !== 'hide' && (
          <Btn className="absolute right-8 bottom-5 shadow-card !bg-page border-line" onClick={() => setFollow(true)}><ArrowDown size={15} />{t('listen.backToLine')}</Btn>
        )}
      </div>

      <ListenBar time={time} duration={duration} playing={playing}
        band={section ? [sectionStart(section), sectionEnd(sec)] : null} ticks={sections.slice(1).map(sectionStart)}
        speed={speed} onSpeed={setSpeed} loop={loop.on} onLoop={() => setLoopOn(!loop.on)}
        autoPause={autoPause} onAutoPause={() => { setAutoPause(!autoPause); saveWatchPrefs({ autoPause: !autoPause }); }}
        extra={passes
          ? <Btn size="sm" onClick={() => goFree(true)} title={t('listen.freeTitle')}>{t('listen.free')}</Btn>
          : <>
            <Btn size="sm" tone={through ? 'accent-soft' : 'white'} aria-pressed={through} onClick={toggleThrough} title={t('listen.throughTitle')}>{t('listen.through')}</Btn>
            <Btn size="sm" onClick={() => goFree(false)} title={t('listen.routeTitle')}>{t('listen.route')}</Btn>
          </>}
        keys={inDrill ? t('listen.keysDrill') : undefined}
        onSeek={seek} onPrev={prev} onNext={inDrill ? drillNext : next} onToggle={togglePlay}
        onBack={() => seek((audio.current?.currentTime ?? 0) - SEEK)} onFwd={() => seek((audio.current?.currentTime ?? 0) + SEEK)} />

      {summary && !pickerShow && (
        <WatchSummary
          title={summary.ended || lastSec ? t('listen.allDone') : t('listen.sectionDone', { n: sec + 1 })}
          savedEmpty={t('listen.savedEmpty')} saved={sumSaved} missed={sumMissed} busy={adding} looked={words} pickAll={passes}
          top={canAsk && (!passes || pass === 1 || said.has(sec)) ? ask : null}
          words={{
            kept: w => kept.has((w as Word).key),
            can: w => !!(w as Word).fields,
            onKeep: w => keepOne(w as Word),
            onKeepAll: () => words.filter(w => w.fields && !kept.has(w.key)).forEach(keepOne),
          }}
          actions={<>
            {(drillMissing || addFail) && <span className="mr-auto text-[13px] text-mute">{t(addFail ? 'listen.addFail' : 'watch.drillMissing')}</span>}
            <Btn onClick={onPractice}>{t('reader.pickPractice')}</Btn>
            <Btn onClick={() => goSection(sec)}>{t('listen.again')}</Btn>
            {onward && passes && <Btn onClick={() => { goFree(true); setThrough(true); goSection(sec + 1); }} title={t('listen.throughRestTitle')}>{t('listen.throughRest')}</Btn>}
            {onward && <Btn tone={passes && (sumSaved.length || sumMissed.length) ? 'white' : 'accent'} autoFocus={passes && !sumSaved.length && !sumMissed.length} onClick={() => goSection(sec + 1)}>{t('listen.next')}</Btn>}
          </>}
          onClose={() => setSummary(null)}
          onJump={line => { setSummary(null); pick(line); }}
          onWord={w => lookUp(w.word, w.line)}
          onDrill={picked => { startDrill(picked).catch(console.error); }}
          onKeep={picked => { keepEnd(picked).catch(console.error); }} />
      )}
      {passCard !== null && !summary && !pickerShow && (
        <PassCard hard={hard} ask={canAsk ? ask : null} on={easy ? t(hasSaved ? 'listen.toDrill' : lastSec ? 'listen.done' : 'listen.next') : null}
          onStart={() => startPass(passCard + 1)} onOn={moveOn} onClose={() => setPassCard(null)} />
      )}
      {pickerShow && <PodcastPicker initialShow={pickerShow} onClose={() => setPickerShow(null)} onOpen={r => onOpen?.(r)} />}
      {drill && <ReviewSession cards={drill} onClose={() => setDrill(null)} onFinish={passes && onward ? () => { setDrill(null); goSection(sec + 1); } : undefined} />}
      {intro && <IntroCard onClose={closeIntro} />}
      {def.word !== null && (
        <DefinitionPanel key={def.word} def={def} onClose={closeLookup} onExplain={explain} onKeepWord={lookLine.current ? (w, d, x, ai) => keep(w, lookLine.current!, d, x, ai) : undefined} />
      )}
    </div>
  );
};

export default ListenPage;
