import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowLeft } from 'lucide-react';
import type { Subtitle, VideoRecord } from '../types';
import { Btn, Seg, useToast } from '../components/ui';
import ReaderLine from './ReaderLine';
import DefinitionPanel, { keepFields } from '../components/DefinitionPanel';
import WatchSummary, { type Looked } from '../components/WatchSummary';
import ReviewSession from '../components/ReviewSession';
import { JaBanner } from '../components/JaSetup';
import { useSavedLines } from '../hooks/useSavedLines';
import { useLookup } from '../hooks/useLookup';
import { lineAt, parseSRT } from '../utils/srtParser';
import { buildSections, sectionAt, sectionStart } from '../utils/sections';
import { detectLang } from '../utils/dictionary';
import { useJaVersion } from '../utils/japanese';
import { settleSplits } from '../utils/jaSegments';
import { addWord, lineCardsFor, type ReviewCard } from '../utils/review';
import { addLooked, getLooked, lookedKey, useLookedVersion } from '../utils/readLooked';
import { canCloze } from '../utils/aiDrills';
import { videoSrcFromPath } from '../utils/desktop';
import { getPracticeConfig, getWatchPos, getWatchPrefs, saveWatchPrefs, setWatchPos, type WatchSubs } from '../utils/storage';
import { LOOP_GAP_MS, loopMore, setLoopOn, useLoop } from '../utils/loop';
import { matches } from '../utils/shortcuts';
import { IS_WINDOWS } from '../utils/platform';
import { getLang, useT, type DictKey } from '../utils/i18n';
import { getTransJob, prepareTrans, subscribeTrans } from './transPrep';
import { HeardAsk, IntroCard, ListenBlind, PassCard, StepBar, rateText, type Said } from './ListenCoach';
import ListenBar from './ListenBar';
import { noteHeard, recordRate, showKey, type Heard } from './listenLevel';
import PodcastPicker from './PodcastPicker';
import type { Pick } from './podcastShows';

// Intensive listening to something with no picture — a podcast episode or a sound file
//. One practice section at a time, in four steps: blind,
// with the transcript, blind again, then dictating the lines saved (the section's summary);
// "free listening" leaves the steps for blind / shown by hand. The line being said is lit and kept in view until the reader
// scrolls away ("back to the current line", or 5 s without scrolling while it plays, brings
// it back). Words look up like the reader's (ReaderLine), lines save with the same star.
// Playback running past a section's last line pauses and shows what this section left:
// saved lines to dictate, words to keep, then the next section ("play on" skips that stop). Where it stopped is the watch page's position.
// V shows just the line being said while blind; the card after the blind listen (free: the
// summary) asks how much was followed (ListenCoach.tsx). The page always opens at the start of
// the section it was left in, on step 1.
// Nothing about the record's practice progress changes.

const MODES: WatchSubs[] = ['hide', 'show'];
const SEEK = 5;
type Word = Looked & { key: string; fields?: { definition: string; example: string } | null };

const ListenPage: React.FC<{ record: VideoRecord; onExit: () => void; onPractice: () => void; onOpen?: (r: VideoRecord) => void }> = ({ record, onExit, onPractice, onOpen }) => {
  const t = useT();
  const lines = useMemo(() => [...parseSRT(record.subtitleText)].sort((a, b) => a.startTime - b.startTime), [record.subtitleText]);
  const sections = useMemo(() => buildSections(lines, getPracticeConfig().sectionLength), [lines]);
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
  const armed = useRef<number | null>(null); // the next pass, started by play too
  const effMode: WatchSubs = passes ? passMode ?? (pass === 2 ? 'show' : 'hide') : mode;
  const changeMode = (m: WatchSubs) => { if (passes) setPassMode(m); else setMode(m); };
  const [peek, setPeek] = useState<number | null>(null);
  const [said, setSaid] = useState<Map<number, Said>>(new Map()); // "how much did you follow", per section this visit
  const blindSecs = useRef(new Set<number>());
  const [pickerShow, setPickerShow] = useState<Pick | null>(null); // under it the card / summary step aside (Esc is the picker's)
  const rate = useMemo(() => recordRate(record), [record]);
  const loop = useLoop();
  const [summary, setSummary] = useState<{ ended: boolean } | null>(null);
  const summaryRef = useRef(summary);
  summaryRef.current = summary;
  const [drill, setDrill] = useState<ReviewCard[] | null>(null);
  const [drillMissing, setDrillMissing] = useState(false);

  // Closing it plays — unless a step's card or the summary is still waiting under it.
  const closeIntro = () => { setIntro(false); saveWatchPrefs({ listenIntro: true }); if (passCard === null && !summaryRef.current) audio.current?.play().catch(() => {}); };
  const help = () => { audio.current?.pause(); window.clearTimeout(gap.current); setIntro(true); }; // a looped line's next play waits too

  const at = lineAt(lines, time);
  const cur = at >= 0 ? lines[at] : null;
  const sec = cur ? sectionOf.get(cur.id) ?? 0 : 0;
  const section = sections[sec];
  const sectionEnd = (i: number) => sections[i]?.subtitles.at(-1)?.endTime ?? 0;

  // --- Playback: one loop follows the clock. When playback itself runs past a line's end
  // (not a seek landing past it): the line loop plays it again after a pause; else the end
  // of a section stops and shows its summary; else the optional pause at every line's end.
  const prevT = useRef(0);
  const heldAt = useRef(-1);
  const plays = useRef({ at: -1, n: 1 });
  const gap = useRef(0);
  const resumeAfter = useRef(false); // a lookup paused playback: closing it plays again
  const opts = useRef({ autoPause, through, passes, pass, sec });
  opts.current = { autoPause, through, passes, pass, sec };
  const seek = useCallback((to: number, play = false) => {
    const a = audio.current;
    if (!a) return;
    window.clearTimeout(gap.current);
    heldAt.current = -1;
    armed.current = null; // moved: play is play again, not "the next pass"
    resumeAfter.current = false; // moved by hand while a lookup is open: closing it leaves that be
    const s = Math.max(0, Math.min(to, Number.isFinite(a.duration) ? a.duration - 0.05 : to));
    a.currentTime = s;
    prevT.current = s;
    setTime(s);
    if (play) a.play().catch(() => {});
  }, []);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const a = audio.current;
      if (a) {
        const now = a.currentTime, before = prevT.current;
        setTime(x => (Math.abs(x - now) > 0.04 ? now : x));
        const was = lineAt(lines, before);
        if (!a.paused && was >= 0 && now > before && now - before < 0.5 && before < lines[was].endTime && now >= lines[was].endTime) {
          const line = lines[was];
          if (plays.current.at !== was) plays.current = { at: was, n: 1 };
          const back = Math.max(line.startTime, line.endTime - 0.02);
          if (loopMore(plays.current.n)) {
            plays.current.n++;
            a.pause(); a.currentTime = back; setTime(back); // the gap is still this line (and this section)
            gap.current = window.setTimeout(() => seek(line.startTime, true), LOOP_GAP_MS);
          } else if (!opts.current.through && sectionEnd(sectionOf.get(line.id) ?? 0) === line.endTime && heldAt.current !== was) {
            // Once: closing the summary and pressing play goes on past the section end.
            a.pause();
            heldAt.current = was;
            a.currentTime = back;
            setTime(back); // not the frame's `now`, already in the next section: that would reset the passes
            if (opts.current.passes && opts.current.pass < 3) openPass(); else openSummary(false);
          } else if (opts.current.autoPause && heldAt.current !== was) {
            a.pause();
            heldAt.current = was;
            a.currentTime = back;
            setTime(back); // (and a line peeked at stays up while held)
          }
          prevT.current = a.currentTime;
        } else prevT.current = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); window.clearTimeout(gap.current); };
  }, [lines, sections]); // eslint-disable-line react-hooks/exhaustive-deps

  const togglePlay = () => {
    const a = audio.current;
    if (!a) return;
    resumeAfter.current = false; // played / paused by hand: closing the definition leaves it be
    window.clearTimeout(gap.current);
    if (a.paused && armed.current) startPass(armed.current);
    else if (a.paused) a.play().catch(() => {}); else a.pause();
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
    const a = audio.current;
    if (a && Math.abs(a.currentTime - lastSaved.current) > 5) { lastSaved.current = a.currentTime; setWatchPos(record.id, a.currentTime); }
  };
  useEffect(() => {
    const a = audio.current;
    return () => { if (a && !a.ended && a.currentTime > 0) setWatchPos(record.id, a.currentTime); };
  }, [record.id]);
  useEffect(() => { if (audio.current) audio.current.playbackRate = speed; }, [speed]);

  // --- Following the line being said, until the reader scrolls away ---
  const scroller = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const curId = cur?.id ?? null;
  useEffect(() => {
    if (!follow || curId === null || effMode === 'hide') return;
    scroller.current?.querySelector(`[data-line="${curId}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [curId, follow, effMode, sec]);
  const pick = useCallback((line: Subtitle) => { setFollow(true); seek(line.startTime, true); }, [seek]);
  // Back by itself after 5 s of no scrolling (a moving mouse counts as not done: the word
  // it is aiming at stays put), only while playing — paused, the reader is reading.
  const backTimer = useRef(0);
  const armBack = useCallback(() => {
    window.clearTimeout(backTimer.current);
    backTimer.current = window.setTimeout(() => { if (audio.current && !audio.current.paused) setFollow(true); }, 5000);
  }, []);
  useEffect(() => {
    if (!follow && playing) armBack();
    return () => window.clearTimeout(backTimer.current);
  }, [follow, playing, armBack]);
  const leave = () => { setFollow(false); armBack(); };

  // --- Lookup: pauses; closing the card plays the interrupted line again from its start ---
  const lookedVersion = useLookedVersion();
  const looked = useMemo(() => new Set(getLooked(record.id)), [record.id, lookedVersion]);
  const { def, lookup, explain, closeDef } = useLookup(dictLang, '');
  const lookLine = useRef<Subtitle | null>(null);
  const resumeFrom = useRef(0);
  const [words, setWords] = useState<Word[]>([]); // since the last summary
  const [kept, setKept] = useState<Set<string>>(new Set());
  const keyOf = (word: string) => lookedKey(word, ja) ?? word.toLowerCase();
  const onWord = useCallback((word: string, line: Subtitle) => {
    const a = audio.current;
    window.clearTimeout(gap.current); // between two plays of a looped line: the next one waits for the card
    if (a && !a.paused) {
      const i = lineAt(lines, a.currentTime);
      resumeFrom.current = i >= 0 ? lines[i].startTime : a.currentTime;
      resumeAfter.current = true;
      a.pause();
    }
    addLooked(record.id, word, ja);
    const key = keyOf(word);
    setWords(ws => (ws.some(w => w.key === key) ? ws : [...ws, { word, line, key }]));
    lookLine.current = line;
    lookup(word, line.text);
  }, [record.id, ja]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!def.word || def.loading) return;
    const k = keyOf(def.word);
    const fields = keepFields(def, lookedKey(def.word, ja));
    setWords(ws => ws.map(w => (w.key === k && !w.fields ? { ...w, fields } : w)));
  }, [def]); // eslint-disable-line react-hooks/exhaustive-deps
  const closeLookup = () => {
    closeDef();
    if (resumeAfter.current && !summaryRef.current) seek(resumeFrom.current, true);
    resumeAfter.current = false;
  };
  const keep = (word: string, l: Subtitle, definition: string, example: string) => {
    const k = keyOf(word);
    setKept(s => new Set(s).add(k));
    addWord({ videoId: record.id, videoName: record.videoFileName, text: l.text, start: l.startTime, end: l.endTime }, word, definition, example)
      .catch(e => { console.error(e); setKept(s => { const n = new Set(s); n.delete(k); return n; }); });
  };
  const keepOne = (w: Word) => { if (w.fields) keep(w.word, w.line, w.fields.definition, w.fields.example); };

  // --- Saved lines (the same star as reading / watching) and translation ---
  const { savedIds, savedItems, toggleSave } = useSavedLines({ videoId: record.id, fullSubtitles: lines, videoFileName: record.videoFileName });
  const saveRef = useRef(toggleSave);
  saveRef.current = toggleSave;
  const onSave = useCallback((line: Subtitle) => saveRef.current(line), []);
  const hasAi = canCloze();
  const toast = useToast(); // S has no star under the finger: say what it did
  const [trans, setTrans] = useState<(string | null)[] | null>(null);
  const [transBusy, setTransBusy] = useState(false);
  const [openT, setOpenT] = useState<Set<number>>(new Set());
  useEffect(() => subscribeTrans(() => { const job = getTransJob(record.id); if (job) setTrans(job.lines); }), [record.id]);
  const onTrans = useCallback((line: Subtitle) => {
    if (!transBusy && !(trans && trans.every(Boolean))) {
      setTransBusy(true);
      prepareTrans(record.id, lines.map(l => l.text), getLang() === 'en' ? 'en' : 'zh').then(setTrans).catch(console.error).finally(() => setTransBusy(false));
    }
    setOpenT(s => { const n = new Set(s); if (n.has(line.id)) n.delete(line.id); else n.add(line.id); return n; });
  }, [trans, transBusy, record.id, lines]);

  // --- The summary at a section's end (or "done with this section") ---
  const summed = useRef(-1); // the section last summed up: its passes are over
  function openSummary(ended: boolean) {
    summed.current = opts.current.sec;
    setPassCard(null);
    armed.current = null;
    audio.current?.pause();
    window.clearTimeout(gap.current);
    setDrillMissing(false);
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
    setPass(1); setPassMode(null); setPassCard(null); // "listen again": all three passes again
    seek(sections[i]?.subtitles[0]?.startTime ?? 0, true);
  };
  // Ran to the very end: with passes left, the last section's next pass.
  const onEnded = () => { if (passes && pass < 3 && summed.current !== sec) openPass(); else { setWatchPos(record.id, 0); openSummary(true); } };

  // --- Three passes: the pass count belongs to one section; getting into another starts it at 1 ---
  const passSec = useRef(sec);
  useEffect(() => {
    if (sec === passSec.current) return;
    passSec.current = sec;
    setPass(1); setPassMode(null); setPassCard(null); armed.current = null; summed.current = -1;
  }, [sec]);
  function openPass() {
    audio.current?.pause(); window.clearTimeout(gap.current);
    armed.current = opts.current.pass + 1; setPassCard(opts.current.pass);
  }
  function startPass(n: number) { // back to this section's start: the count stays
    summed.current = -1;
    setPassCard(null); setPass(n); setPassMode(null); setFollow(true);
    seek(sections[sec]?.subtitles[0]?.startTime ?? 0, true);
  }
  // Followed most of it blind: moving on is the main way — to the saved lines' dictation, else the next section.
  const hasSaved = section ? section.subtitles.some(l => savedIds.has(l.id)) : false;
  const easy = passCard === 1 && said.get(sec)?.a === 'most';
  const moveOn = () => { if (hasSaved || lastSec) openSummary(false); else goSection(sec + 1); };
  const cardMain = () => { if (easy) moveOn(); else if (passCard) startPass(passCard + 1); };
  const goStep = (n: number) => { setSummary(null); if (n === 4) openSummary(false); else startPass(n); };
  const goFree = (on: boolean) => { // leaving the steps keeps playing; back on them, this section from step 1
    setFree(on);
    if (on) { setPassCard(null); setPassMode(null); armed.current = null; } else goSection(sec);
  };

  // --- Blind: V shows the line being said until playback reaches another one ---
  useEffect(() => { if (peek !== null && peek !== curId) setPeek(null); }, [curId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (effMode !== 'hide' || summary) setPeek(null); }, [effMode, summary]);
  const togglePeek = () => { if (effMode === 'hide' && cur) setPeek(p => (p === cur.id ? null : cur.id)); };
  useEffect(() => { if (playing && effMode === 'hide') blindSecs.current.add(sec); }, [playing, effMode, sec]);
  // Asked only while it tells something: after a blind listen, before the transcript's been
  // read through (with three passes, on the card after the first). Answered once per section.
  const canAsk = blindSecs.current.has(sec);
  const answer = (a: Heard) => { // noted outside the state update: StrictMode runs those twice
    if (!said.has(sec)) { const way = noteHeard(showKey(record), a); setSaid(m => new Map(m).set(sec, { a, way })); }
  };
  const ask = <HeardAsk record={record} said={said.get(sec)} onAnswer={answer} onShow={p => setPickerShow(p)} />;
  const startDrill = async (picked: Subtitle[]) => {
    const cards = await lineCardsFor(record.id, picked).catch(() => [] as ReviewCard[]);
    if (cards.length) setDrill(cards); else setDrillMissing(true);
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
    if (matches(e, 'replay')) act = replay;
    else if (matches(e, 'loop')) act = () => setLoopOn(!loop.on);
    else if (e.code === 'Space' && plain) act = togglePlay;
    // ← / → change lines, like the watch page (⌘ too); ±5 s is the bar's buttons.
    else if (((plain || mod) && e.code === 'ArrowLeft') || matches(e, 'prev')) act = prev;
    else if (((plain || mod) && e.code === 'ArrowRight') || matches(e, 'next')) act = next;
    else if (plain && e.code === 'KeyS') act = () => { if (cur) { toast.say(t(savedIds.has(cur.id) ? 'watch.unsaved' : 'watch.saved')); toggleSave(cur); } };
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
  const sumSaved = summary ? savedItems.filter(l => heard(l.id)) : [];
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
          {passes ? <StepBar step={summary ? 4 : pass} onStep={goStep} onHelp={help} />
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
          <ListenBlind image={record.podcast?.image} lines={section?.subtitles ?? []} at={inSec} saved={savedIds} onPick={pick} onPeek={togglePeek}
            hint={passes ? t(pass === 3 ? 'listen.stepHint_3' : 'listen.stepHint_1') : t('listen.blindHint')}
            peek={peek !== null && cur?.id === peek ? (
              <ReaderLine line={cur} ja={ja} jaVersion={jaVersion} kana={kana} looked={looked} playing saved={savedIds.has(cur.id)} hasTrans={hasAi}
                transOpen={openT.has(cur.id)} transText={trans?.[indexOf.get(cur.id)!] ?? null} transPending={transBusy}
                onWord={onWord} onListen={pick} onView={pick} onTrans={onTrans} onSave={onSave} onPick={pick} />
            ) : null} />
        ) : (
          <div ref={scroller} className="h-full overflow-y-auto px-8"
            onWheel={leave} onTouchMove={leave} onPointerDown={e => { if (e.target === e.currentTarget) leave(); }} onPointerMove={() => { if (!follow) armBack(); }}>
            <div className="mx-auto max-w-[820px] py-[30vh]">
              {passes && pass === 2 && <p className="mb-6 text-sm text-mute">{t('listen.stepHint_2')}</p>}
              {ja && <div className="mb-4"><JaBanner /></div>}
              {section?.subtitles.map(line => (
                <ReaderLine key={line.id} line={line} ja={ja} jaVersion={jaVersion} kana={kana} looked={looked}
                  playing={line.id === curId} saved={savedIds.has(line.id)} hasTrans={hasAi} transOpen={openT.has(line.id)}
                  transText={trans?.[indexOf.get(line.id)!] ?? null} transPending={transBusy}
                  onWord={onWord} onListen={pick} onView={pick} onTrans={onTrans} onSave={onSave} onPick={pick} />
              ))}
            </div>
          </div>
        )}
        {toast.view}
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
        onSeek={seek} onPrev={prev} onNext={next} onToggle={togglePlay}
        onBack={() => seek((audio.current?.currentTime ?? 0) - SEEK)} onFwd={() => seek((audio.current?.currentTime ?? 0) + SEEK)} />

      {summary && !pickerShow && (
        <WatchSummary
          title={summary.ended || lastSec ? t('listen.allDone') : t('listen.sectionDone', { n: sec + 1 })}
          savedEmpty={t('listen.savedEmpty')} saved={sumSaved} looked={words} pickAll={passes}
          top={canAsk && (!passes || pass === 1 || said.has(sec)) ? ask : null}
          words={{
            kept: w => kept.has((w as Word).key),
            can: w => !!(w as Word).fields,
            onKeep: w => keepOne(w as Word),
            onKeepAll: () => words.filter(w => w.fields && !kept.has(w.key)).forEach(keepOne),
          }}
          actions={<>
            {drillMissing && <span className="mr-auto text-[13px] text-mute">{t('watch.drillMissing')}</span>}
            <Btn onClick={onPractice}>{t('reader.pickPractice')}</Btn>
            <Btn onClick={() => goSection(sec)}>{t('listen.again')}</Btn>
            {onward && passes && <Btn onClick={() => { goFree(true); setThrough(true); goSection(sec + 1); }} title={t('listen.throughRestTitle')}>{t('listen.throughRest')}</Btn>}
            {onward && <Btn tone={passes && sumSaved.length ? 'white' : 'accent'} autoFocus={passes && !sumSaved.length} onClick={() => goSection(sec + 1)}>{t('listen.next')}</Btn>}
          </>}
          onClose={() => setSummary(null)}
          onJump={line => { setSummary(null); pick(line); }}
          onWord={w => { lookLine.current = w.line; lookup(w.word, w.line.text); }}
          onDrill={picked => { setDrillMissing(false); startDrill(picked).catch(console.error); }} />
      )}
      {passCard !== null && !summary && !pickerShow && (
        <PassCard done={passCard} ask={passCard === 1 && canAsk ? ask : null} on={easy ? t(hasSaved ? 'listen.toDrill' : lastSec ? 'listen.done' : 'listen.next') : null}
          onStart={() => startPass(passCard + 1)} onOn={moveOn} onClose={() => setPassCard(null)} />
      )}
      {pickerShow && <PodcastPicker initialShow={pickerShow} onClose={() => setPickerShow(null)} onOpen={r => onOpen?.(r)} />}
      {drill && <ReviewSession cards={drill} onClose={() => setDrill(null)} onFinish={passes && onward ? () => { setDrill(null); goSection(sec + 1); } : undefined} />}
      {intro && <IntroCard onClose={closeIntro} />}
      {def.word !== null && (
        <DefinitionPanel key={def.word} def={def} onClose={closeLookup} onExplain={explain} onKeepWord={lookLine.current ? (w, d, x) => keep(w, lookLine.current!, d, x) : undefined} />
      )}
    </div>
  );
};

export default ListenPage;
