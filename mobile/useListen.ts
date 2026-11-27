// The phone's intensive listening, minus the screen (docs/mobile-web.md 6 / docs/android-roadmap.md M1.1):
// same rules as desktop pro/ListenPage.tsx, unified over mobile/platform/audioEngine.ts (Web <audio>
// or Android native Media3 PlaybackService via vite.android.config.ts SWAP).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Subtitle, VideoRecord } from '../types';
import { lineAt, parseSRT } from '../utils/srtParser';
import { buildSections, sectionLengthOf } from '../utils/sections';
import { getWatchPrefs, saveWatchPrefs, setWatchPos, type WatchSubs } from '../utils/storage';
import { LOOP_GAP_MS } from '../utils/loop';
import { clearPlayingProbe, setPlayingProbe } from '../utils/today';
import { noteHeard, showKey, type Heard, type Way } from '../pro/listenLevel';
import { resolveListenStartSec } from './phoneWays';
import {
  buildSectionStops,
  drillProgressFromLoops,
  lineStopTime,
  resolveBgMarkLineId,
  sectionEndOf,
  type Mark,
} from './listenBoundaries';
import { useListenMarks } from './listenMissed';
import {
  AUDIO_ENGINE_PLATFORM,
  createAudioEngine,
  resolveAudioSource,
  type AudioEngine,
  type EngineCallbacks,
} from './platform/audioEngine';

export type { Mark };
export const SPEEDS = [0.75, 0.9, 1, 1.25];

export interface UseListenOptions {
  startSec?: number;
  onPos?: (sec: number) => void;
  onLine?: (n: number, total: number) => void;
}

export function useListen(record: VideoRecord, opts?: UseListenOptions) {
  const lines = useMemo(() => [...parseSRT(record.subtitleText)].sort((a, b) => a.startTime - b.startTime), [record.subtitleText]);
  const sections = useMemo(() => buildSections(lines, sectionLengthOf(record)), [lines]); // eslint-disable-line react-hooks/exhaustive-deps
  const sectionOf = useMemo(() => new Map(sections.flatMap((s, i) => s.subtitles.map(l => [l.id, i] as const))), [sections]);
  const indexOf = useMemo(() => new Map(lines.map((l, i) => [l.id, i])), [lines]);
  const stopsSec = useMemo(() => buildSectionStops(sections), [sections]);
  const cues = useMemo(
    () => lines.map(l => ({ id: l.id, startMs: Math.round(l.startTime * 1000), endMs: Math.round(l.endTime * 1000), text: l.text })),
    [lines],
  );

  const audio = useRef<HTMLAudioElement | null>(null);
  const pausedRef = useRef<{ paused: boolean }>({ paused: true });
  const engineRef = useRef<AudioEngine | null>(null);
  const initSec = useMemo(() => resolveListenStartSec(lines, sections, record.id, opts?.startSec), [record.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const [ready, setReady] = useState(false);
  const [errorCode, setErrorCode] = useState('');
  const [time, setTime] = useState(initSec);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [free, setFree] = useState(false);
  const [loopLine, setLoopLine] = useState(false);
  const [autoPause, setAutoPause] = useState(false);
  const [mode, setModeState] = useState<WatchSubs>(() => (getWatchPrefs().listenSubs === 'show' ? 'show' : 'hide'));
  const setMode = (m: WatchSubs) => { setModeState(m); saveWatchPrefs({ listenSubs: m }); };
  const [throughPref, setThrough] = useState(() => getWatchPrefs().listenThrough);
  const through = free && throughPref;
  const toggleThrough = () => { setThrough(!throughPref); saveWatchPrefs({ listenThrough: !throughPref }); };
  const [pass, setPass] = useState(1);
  const [passCard, setPassCard] = useState(false);
  const [queue, setQueue] = useState<number[] | null>(null);
  const [qAt, setQAt] = useState(0);
  const [tries] = useState(() => getWatchPrefs().listenTries);
  const [play, setPlay] = useState(1);
  const [shown, setShown] = useState(false);
  const [summary, setSummary] = useState<{ ended: boolean } | null>(null);
  const [peek, setPeek] = useState<number | null>(null); // "see this line": pinned until closed
  const [said, setSaid] = useState<Map<number, { a: Heard; way: Way | null }>>(new Map());
  const [note, setNote] = useState<{ text: string; n: number } | null>(null);
  const say = useCallback((text: string) => setNote(x => ({ text, n: (x?.n ?? 0) + 1 })), []);
  const { marks, markLine, flipMark, setMarkState, setLineMarked, mergeBg } = useListenMarks(record, lines, indexOf, say);

  pausedRef.current.paused = !playing;

  const at = lineAt(lines, time);
  const cur = at >= 0 ? lines[at] : null;
  const sec = cur ? sectionOf.get(cur.id) ?? 0 : 0;
  const section = sections[sec];
  const sectionEnd = (i: number) => sectionEndOf(sections, i);

  const target = queue?.[qAt] ?? null;
  const drillLine = target !== null ? lines[indexOf.get(target) ?? -1] : undefined;
  const inDrill = !!(queue && drillLine);

  const resume = useRef<number | null>(null); // a lookup / "see this line" paused playback: closing it plays from here
  const lastSaved = useRef(0);
  const latestTime = useRef(initSec);
  const loadedRef = useRef(false);
  const endedRef = useRef(false);
  const summed = useRef(-1);
  const onPosRef = useRef(opts?.onPos);
  const onLineRef = useRef(opts?.onLine);
  onPosRef.current = opts?.onPos;
  onLineRef.current = opts?.onLine;

  useEffect(() => {
    const probe = () => !pausedRef.current.paused;
    setPlayingProbe(probe);
    return () => clearPlayingProbe(probe);
  }, []);
  useEffect(() => {
    onLineRef.current?.(lines.length > 0 ? Math.max(0, at) + 1 : 0, lines.length);
  }, [at, lines.length]);
  useEffect(() => {
    if (cur) onPosRef.current?.(cur.startTime);
  }, [cur?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const armDrillLoop = (l: Subtitle, count: number, gapMs: number, go = true) => {
    const eng = engineRef.current;
    if (!eng) return;
    const end = lineStopTime(l, sections, sectionOf);
    eng.setLoop(l.startTime, end, count, gapMs);
    if (go) eng.play();
  };

  const seek = useCallback((to: number, go = false) => {
    const eng = engineRef.current;
    if (!eng) return;
    resume.current = null;
    endedRef.current = false;
    setTime(Math.max(0, to));
    latestTime.current = Math.max(0, to);
    eng.seek(to, go);
  }, []);

  function openSummary(ended: boolean) {
    summed.current = sec;
    setPassCard(false); setQueue(null); setPeek(null);
    engineRef.current?.clearLoop();
    engineRef.current?.setNav(null);
    engineRef.current?.pause();
    setSummary({ ended });
  }
  function openPass() {
    engineRef.current?.pause();
    setPassCard(true);
  }

  const goSection = (i: number) => {
    summed.current = -1;
    setSummary(null); setPeek(null);
    setPass(1); setPassCard(false); setQueue(null);
    engineRef.current?.clearLoop();
    engineRef.current?.setNav(null);
    seek(sections[i]?.subtitles[0]?.startTime ?? 0, true);
  };

  const secMarks = section ? section.subtitles.filter(l => marks.has(l.id)) : [];
  const hard = said.get(sec)?.a === 'little' ? 0 : secMarks.length;

  function startPass(n: number) {
    summed.current = -1;
    setPassCard(false); setPass(n); setPeek(null);
    const q = n === 2 && hard ? secMarks.map(l => l.id) : null;
    setQueue(q); setQAt(0); setPlay(1); setShown(false);
    if (q && secMarks[0]) {
      engineRef.current?.setNav(q);
      armDrillLoop(secMarks[0], tries + 1, LOOP_GAP_MS, true);
    } else {
      engineRef.current?.clearLoop();
      engineRef.current?.setNav(null);
      seek(sections[sec]?.subtitles[0]?.startTime ?? 0, true);
    }
  }

  const drillShow = () => {
    if (drillLine && !shown) {
      setShown(true);
      armDrillLoop(drillLine, 1, 0, true);
    }
  };

  const drillNext = () => {
    if (target === null || !queue) return;
    setMarkState(target, shown ? 'more' : 'ok');
    setPlay(1); setShown(false);
    const nx = qAt + 1 < queue.length ? lines[indexOf.get(queue[qAt + 1]) ?? -1] : undefined;
    if (nx) {
      setQAt(qAt + 1);
      armDrillLoop(nx, tries + 1, LOOP_GAP_MS, true);
    } else {
      engineRef.current?.clearLoop();
      engineRef.current?.setNav(null);
      openSummary(false);
    }
  };

  const cbRef = useRef<EngineCallbacks>({ onState: () => {} });
  cbRef.current = {
    onState(st) {
      if (st.duration > 0 || st.playing) loadedRef.current = true;
      if (loadedRef.current || st.time > 0) {
        latestTime.current = st.time;
        setTime(x => (Math.abs(x - st.time) > 0.02 || !st.playing ? st.time : x));
      }
      if (st.duration > 0) setDuration(st.duration);
      setPlaying(st.playing);
      if (st.ready) setReady(true);
      if (free && !inDrill) setLoopLine(st.loopActive);
      if (loadedRef.current && Math.abs(st.time - lastSaved.current) > 5) {
        lastSaved.current = st.time;
        setWatchPos(record.id, st.time);
      }
    },
    onLoaded(dur, initialTime) {
      loadedRef.current = true;
      if (dur > 0) setDuration(dur);
      setReady(true);
      setTime(initialTime);
      latestTime.current = initialTime;
    },
    onSectionEnd(posSec) {
      setTime(posSec);
      latestTime.current = posSec;
      if (!free && pass < 2) openPass(); else openSummary(false);
    },
    onLoopTick(completedLoops) {
      if (!inDrill) return;
      const p = drillProgressFromLoops(completedLoops, tries);
      setPlay(p.play);
      if (p.shown) setShown(true);
    },
    onLoopComplete(completedLoops) {
      if (!inDrill) return;
      const p = drillProgressFromLoops(completedLoops, tries);
      setPlay(p.play);
      if (p.shown) setShown(true);
    },
    onHoldEnd(posSec) {
      setTime(posSec);
      latestTime.current = posSec;
    },
    onSentencePause(_cueIndex, _lineId, posSec) {
      setTime(posSec);
      latestTime.current = posSec;
    },
    onSentenceJump(cueIndex, lineId, startSec, delta) {
      setTime(startSec);
      latestTime.current = startSec;
      if (inDrill && queue) {
        const idx = queue.indexOf(lineId);
        if (idx >= 0 && idx !== qAt) {
          if (delta > 0 && target !== null) {
            setMarkState(target, shown ? 'more' : 'ok');
          }
          setQAt(idx);
          setPlay(1);
          setShown(false);
          const l = lines[cueIndex];
          if (l) {
            const wasPlaying = !!engineRef.current?.getState().playing;
            armDrillLoop(l, tries + 1, LOOP_GAP_MS, wasPlaying);
          }
        } else if (delta > 0 && qAt === queue.length - 1) {
          drillNext();
        }
      }
    },
    onEnded() {
      endedRef.current = true;
      if (!free && pass < 2 && summed.current !== sec) openPass();
      else { setWatchPos(record.id, 0); openSummary(true); }
    },
    onError(code) {
      setErrorCode(code);
    },
    onBgMark(ev) {
      if (ev.mediaId !== record.id) return;
      const lineId = resolveBgMarkLineId(lines, ev);
      if (lineId !== null) {
        mergeBg([lineId]);
      }
    },
  };

  // Instantiate engine once per record and load its resolved audio source.
  const path = record.videoPath ?? '';
  useEffect(() => {
    let cancelled = false;
    loadedRef.current = false;
    setReady(false);
    setErrorCode('');
    endedRef.current = false;

    const eng = createAudioEngine({
      onState: st => cbRef.current.onState(st),
      onLoaded: (d, t0) => cbRef.current.onLoaded?.(d, t0),
      onSectionEnd: (p, s) => cbRef.current.onSectionEnd?.(p, s),
      onLoopTick: (c, r) => cbRef.current.onLoopTick?.(c, r),
      onLoopComplete: c => cbRef.current.onLoopComplete?.(c),
      onHoldEnd: p => cbRef.current.onHoldEnd?.(p),
      onSentencePause: (i, id, p) => cbRef.current.onSentencePause?.(i, id, p),
      onSentenceJump: (i, id, s, d) => cbRef.current.onSentenceJump?.(i, id, s, d),
      onEnded: () => cbRef.current.onEnded?.(),
      onError: code => cbRef.current.onError?.(code),
      onBgMark: ev => cbRef.current.onBgMark?.(ev),
    });
    engineRef.current = eng;
    if (audio.current) eng.attachElement(audio.current);

    resolveAudioSource(path).then(
      source => {
        if (cancelled) return;
        const startSec = resolveListenStartSec(lines, sections, record.id, opts?.startSec);
        return eng.load({
          source,
          mediaId: record.id,
          title: record.displayName,
          artist: record.podcast?.show ?? '',
          artworkUri: record.podcast?.image ?? '',
          startSec,
          autoPlay: true,
          rate: speed,
          cues,
          stopsSec: through ? [] : stopsSec,
        });
      },
      (e: unknown) => {
        if (!cancelled) setErrorCode(e instanceof Error ? e.message : String(e));
      },
    );

    return () => {
      cancelled = true;
      if (AUDIO_ENGINE_PLATFORM === 'android') eng.pause();
      if (!endedRef.current && latestTime.current > 0) setWatchPos(record.id, latestTime.current);
      eng.dispose();
      if (engineRef.current === eng) engineRef.current = null;
    };
  }, [record.id, path]); // eslint-disable-line react-hooks/exhaustive-deps

  const bindAudio = useCallback((el: HTMLAudioElement | null) => {
    audio.current = el;
    engineRef.current?.attachElement(el);
  }, []);

  useEffect(() => { engineRef.current?.setRate(speed); }, [speed]);
  useEffect(() => { engineRef.current?.setStops(through || inDrill ? [] : stopsSec); }, [through, inDrill, stopsSec]);

  const passSec = useRef(sec);
  useEffect(() => {
    if (sec === passSec.current) return;
    passSec.current = sec;
    setPass(1); setPassCard(false); setQueue(null); summed.current = -1;
    if (!free) {
      engineRef.current?.clearLoop();
      engineRef.current?.setNav(null);
    }
  }, [sec, free]);

  // --- Controls ---
  const playOn = () => {
    const eng = engineRef.current;
    if (!eng) return;
    if (passCard) { startPass(2); return; }
    const st = eng.getState();
    const end = drillLine ? lineStopTime(drillLine, sections, sectionOf) : NaN;
    if (drillLine && (st.waitingGap || Math.abs(st.time - end) < 0.15)) {
      if (shown) armDrillLoop(drillLine, 1, 0, true);
      else armDrillLoop(drillLine, Math.max(1, tries - play + 1) + 1, LOOP_GAP_MS, true);
    } else if (free && loopLine && cur && !st.loopActive) {
      eng.setLoop(cur.startTime, lineStopTime(cur, sections, sectionOf), 0, LOOP_GAP_MS);
      eng.play();
    } else {
      eng.play();
    }
  };
  const pauseNow = () => { resume.current = null; engineRef.current?.pause(); };
  const toggle = () => { if (!playing) playOn(); else pauseNow(); };
  const jump = (i: number) => {
    if (i < 0 || i >= lines.length) return;
    const l = lines[i];
    if (free && loopLine) {
      engineRef.current?.setLoop(l.startTime, lineStopTime(l, sections, sectionOf), 0, LOOP_GAP_MS);
      engineRef.current?.play();
    } else {
      seek(l.startTime, true);
    }
  };
  const prev = () => jump(cur && time < cur.endTime ? at - 1 : at);
  const next = () => jump(at + 1);
  const replay = () => { if (cur) seek(cur.startTime, true); };
  const cycleSpeed = () => setSpeed(s => SPEEDS[(SPEEDS.indexOf(s) + 1) % SPEEDS.length]);

  const toggleLoopLine = () => {
    const eng = engineRef.current;
    if (!eng || !free) return;
    if (loopLine) {
      eng.clearLoop();
      setLoopLine(false);
    } else if (cur) {
      if (autoPause) { setAutoPause(false); eng.setAutoPause(false); }
      setLoopLine(true);
      eng.setLoop(cur.startTime, lineStopTime(cur, sections, sectionOf), 0, LOOP_GAP_MS);
    }
  };
  const toggleAutoPause = () => {
    const eng = engineRef.current;
    if (!eng || !free) return;
    const nextOn = !autoPause;
    if (nextOn && loopLine) { setLoopLine(false); eng.clearLoop(); }
    setAutoPause(nextOn);
    eng.setAutoPause(nextOn);
  };

  const lastSec = sec === sections.length - 1;
  const easy = passCard && said.get(sec)?.a === 'most' && !secMarks.length;
  const moveOn = () => { if (lastSec) openSummary(false); else goSection(sec + 1); };
  const goStep = (n: number) => { setSummary(null); if (n === 3) openSummary(false); else startPass(n); };
  const goFree = (on: boolean) => {
    setFree(on);
    if (on) {
      setPassCard(false); setQueue(null);
      engineRef.current?.clearLoop();
      engineRef.current?.setNav(null);
    } else {
      setLoopLine(false); setAutoPause(false);
      engineRef.current?.clearLoop();
      engineRef.current?.setAutoPause(false);
      goSection(sec);
    }
  };
  const answer = (a: Heard) => { if (!said.has(sec)) { const way = noteHeard(showKey(record), a); setSaid(m => new Map(m).set(sec, { a, way })); } };

  // --- Hard lines ---
  const markPrevIndex = () => {
    const i = at >= 0 && time > lines[at].endTime - 0.05 ? at : at - 1;
    return i < 0 || (sectionOf.get(lines[i].id) ?? 0) !== sec ? -1 : i;
  };

  // "See this line" / a word's meaning pause; closing plays the paused line again from its start.
  const holdFor = () => {
    const eng = engineRef.current;
    if (!eng) return;
    const st = eng.getState();
    if (st.playing || st.waitingGap) {
      resume.current = cur ? cur.startTime : st.time;
      eng.pause();
    }
  };
  const release = () => {
    const r = resume.current;
    resume.current = null;
    if (r !== null && !summary) {
      if (inDrill && drillLine) {
        if (shown) armDrillLoop(drillLine, 1, 0, true);
        else armDrillLoop(drillLine, Math.max(1, tries - play + 1) + 1, LOOP_GAP_MS, true);
      } else {
        seek(r, true);
      }
    }
  };
  const openPeek = () => { if (cur) { holdFor(); setPeek(cur.id); markLine(cur.id); } };
  const closePeek = () => { setPeek(null); release(); };
  // Plays one line inside "see this line"; closing it still goes back where it paused.
  const playLine = (l: Subtitle) => {
    const eng = engineRef.current;
    if (!eng) return;
    const r = resume.current;
    const end = lineStopTime(l, sections, sectionOf);
    eng.seek(l.startTime, false);
    eng.holdAt(end);
    eng.play();
    resume.current = r;
  };

  const leavePage = () => {
    engineRef.current?.pause();
    if (!endedRef.current && latestTime.current > 0) setWatchPos(record.id, latestTime.current);
  };

  return {
    lines, sections, indexOf, audio, bindAudio, pausedRef, ready, errorCode,
    time, duration, playing, speed, cycleSpeed, free, goFree, mode, setMode,
    through, throughPref, toggleThrough, loopLine, toggleLoopLine, autoPause, toggleAutoPause,
    pass, passCard, setPassCard, marks, queue, qAt, tries, play, shown, summary, setSummary, peek, said, note, say,
    at, cur, sec, section, lastSec, hard, secMarks, easy, inDrill, drillLine,
    seek, playOn, pauseNow, toggle, prev, next, replay, goSection, startPass, drillShow, drillNext, moveOn, goStep, answer,
    flipMark, setLineMarked, markPrevIndex, openPeek, closePeek, holdFor, release, playLine, sectionEnd, leavePage,
  };
}
