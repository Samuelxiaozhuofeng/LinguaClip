// The phone's intensive listening, minus the screen (docs/mobile-web.md 6): the same
// rules as the desktop's pro/ListenPage.tsx (docs/private/podcast.md「现状速览」), its
// keys turned into functions for big buttons and the lock screen. Each section in three
// steps: blind (mark hard lines) → the hard lines looped blind until got / their text shows
// (none marked, or little followed: the whole transcript) → summary. Free listening leaves
// the steps. Where it stopped: linguaclip_watch_pos, as on the desktop.
// Every stop is judged in check(), run by every frame and by timeupdate (frames stop in
// the background, timeupdate goes on); it only pauses and moves the clock — a missed stop
// in the background never writes anything but the position.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Subtitle, VideoRecord } from '../types';
import { lineAt, parseSRT } from '../utils/srtParser';
import { buildSections, sectionAt, sectionLengthOf, sectionStart } from '../utils/sections';
import { getWatchPos, getWatchPrefs, saveWatchPrefs, setWatchPos, type WatchSubs } from '../utils/storage';
import { LOOP_GAP_MS } from '../utils/loop';
import { noteHeard, showKey, type Heard, type Way } from '../pro/listenLevel';

export type Mark = 'open' | 'ok' | 'more'; // a hard line: not worked on yet / got it now / needs more work
export const SPEEDS = [0.75, 0.9, 1, 1.25];

export function useListen(record: VideoRecord) {
  const lines = useMemo(() => [...parseSRT(record.subtitleText)].sort((a, b) => a.startTime - b.startTime), [record.subtitleText]);
  const sections = useMemo(() => buildSections(lines, sectionLengthOf(record)), [lines]); // eslint-disable-line react-hooks/exhaustive-deps
  const sectionOf = useMemo(() => new Map(sections.flatMap((s, i) => s.subtitles.map(l => [l.id, i] as const))), [sections]);
  const indexOf = useMemo(() => new Map(lines.map((l, i) => [l.id, i])), [lines]);

  const audio = useRef<HTMLAudioElement>(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [free, setFree] = useState(false);
  const [mode, setModeState] = useState<WatchSubs>(() => (getWatchPrefs().listenSubs === 'show' ? 'show' : 'hide'));
  const setMode = (m: WatchSubs) => { setModeState(m); saveWatchPrefs({ listenSubs: m }); };
  const [throughPref, setThrough] = useState(() => getWatchPrefs().listenThrough);
  const through = free && throughPref;
  const toggleThrough = () => { setThrough(!throughPref); saveWatchPrefs({ listenThrough: !throughPref }); };
  const [pass, setPass] = useState(1);
  const [passCard, setPassCard] = useState(false);
  const [marks, setMarks] = useState<Map<number, Mark>>(new Map());
  const [queue, setQueue] = useState<number[] | null>(null);
  const [qAt, setQAt] = useState(0);
  const [tries] = useState(() => getWatchPrefs().listenTries);
  const [play, setPlay] = useState(1);
  const [shown, setShown] = useState(false);
  const [summary, setSummary] = useState<{ ended: boolean } | null>(null);
  const [peek, setPeek] = useState<number | null>(null); // "see this line": pinned until closed
  const [said, setSaid] = useState<Map<number, { a: Heard; way: Way | null }>>(new Map());
  const [note, setNote] = useState<{ text: string; n: number } | null>(null);
  const say = (text: string) => setNote(x => ({ text, n: (x?.n ?? 0) + 1 }));

  const at = lineAt(lines, time);
  const cur = at >= 0 ? lines[at] : null;
  const sec = cur ? sectionOf.get(cur.id) ?? 0 : 0;
  const section = sections[sec];
  const sectionEnd = (i: number) => Math.min(sections[i]?.subtitles.at(-1)?.endTime ?? 0, sections[i + 1]?.subtitles[0]?.startTime ?? Infinity);

  const prevT = useRef(0);
  const heldAt = useRef(-1);
  const holdTo = useRef<number | null>(null); // "listen again" in "see this line": stop at that line's end
  const gap = useRef(0);
  const stopGap = () => { window.clearTimeout(gap.current); gap.current = 0; };
  const resume = useRef<number | null>(null); // a lookup / "see this line" paused playback: closing it plays from here
  const target = queue?.[qAt] ?? null;
  const opts = useRef({ through, free, pass, target, play, shown, tries });
  opts.current = { through, free, pass, target, play, shown, tries };

  const seek = useCallback((to: number, go = false) => {
    const a = audio.current;
    if (!a) return;
    stopGap();
    heldAt.current = -1;
    holdTo.current = null;
    resume.current = null;
    const s = Math.max(0, Math.min(to, Number.isFinite(a.duration) ? a.duration - 0.05 : to));
    a.currentTime = s;
    prevT.current = s;
    setTime(s);
    if (go) a.play().catch(() => {});
  }, []);

  const check = useRef(() => {});
  check.current = () => {
    const a = audio.current;
    if (!a) return;
    const now = a.currentTime, before = prevT.current;
    setTime(x => (Math.abs(x - now) > 0.04 ? now : x));
    const was = lineAt(lines, before);
    if (a.paused || was < 0 || now <= before) { prevT.current = now; return; }
    const line = lines[was];
    const s = sectionOf.get(line.id) ?? 0, end = sectionEnd(s);
    const last = sections[s]?.subtitles.at(-1);
    const lastAt = last ? indexOf.get(last.id) ?? -1 : -1;
    const tgt = opts.current.target !== null ? indexOf.get(opts.current.target) ?? -1 : -1;
    const tEnd = tgt >= 0 ? Math.min(lines[tgt].endTime, sectionEnd(sectionOf.get(lines[tgt].id) ?? 0)) : 0;
    const pause = (i: number) => {
      const back = Math.max(lines[i].startTime, Math.min(lines[i].endTime, sectionEnd(sectionOf.get(lines[i].id) ?? 0)) - 0.02);
      a.pause(); a.currentTime = back; setTime(back);
    };
    const hold = holdTo.current;
    if (hold !== null && before < hold && now >= hold) {
      holdTo.current = null;
      a.pause(); a.currentTime = hold - 0.02; setTime(hold - 0.02);
    } else if (tgt >= 0 && before < tEnd && now >= tEnd && heldAt.current !== tgt) {
      pause(tgt);
      const { play: k, shown: up, tries: n } = opts.current;
      if (up) heldAt.current = tgt;
      else {
        if (k < n) setPlay(k + 1); else setShown(true);
        const from = lines[tgt].startTime;
        gap.current = window.setTimeout(() => { gap.current = 0; seek(from, true); }, LOOP_GAP_MS);
      }
    } else if (!opts.current.through && lastAt >= 0 && before < end && now >= end && heldAt.current !== lastAt) {
      heldAt.current = lastAt;
      pause(lastAt);
      if (!opts.current.free && opts.current.pass < 2) openPass(); else openSummary(false);
    }
    prevT.current = a.currentTime;
  };
  useEffect(() => {
    let raf = 0;
    const tick = () => { check.current(); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); stopGap(); };
  }, []);

  const drillLine = target !== null ? lines[indexOf.get(target) ?? -1] : undefined;
  const inDrill = !!(queue && drillLine);
  // Stopped at step 2's hard line (or between its plays): play is that line again.
  const playOn = () => {
    const a = audio.current;
    if (!a) return;
    if (passCard) { startPass(2); return; }
    const waiting = !!gap.current;
    stopGap();
    const end = drillLine ? Math.min(drillLine.endTime, sectionEnd(sectionOf.get(drillLine.id) ?? 0)) : NaN;
    if (drillLine && (waiting || Math.abs(a.currentTime - end) < 0.1)) seek(drillLine.startTime, true);
    else a.play().catch(() => {});
  };
  const pauseNow = () => { stopGap(); resume.current = null; audio.current?.pause(); };
  const toggle = () => { if (audio.current?.paused) playOn(); else pauseNow(); };
  const jump = (i: number) => { if (i >= 0 && i < lines.length) seek(lines[i].startTime, true); };
  const prev = () => jump(cur && time < cur.endTime ? at - 1 : at);
  const next = () => jump(at + 1);
  const replay = () => { if (cur) seek(cur.startTime, true); };
  const cycleSpeed = () => setSpeed(s => SPEEDS[(SPEEDS.indexOf(s) + 1) % SPEEDS.length]);
  useEffect(() => { if (audio.current) audio.current.playbackRate = speed; }, [speed]);

  const onLoaded = () => {
    const a = audio.current;
    if (!a) return;
    setDuration(a.duration);
    a.playbackRate = speed;
    const pos = getWatchPos(record.id);
    if (pos > 0 && pos < a.duration - 3 && sections.length) seek(sectionStart(sections[sectionAt(sections, pos)]));
    a.play().catch(() => {}); // a phone may refuse until the play button is pressed
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

  // --- Steps ---
  const summed = useRef(-1);
  function openSummary(ended: boolean) {
    summed.current = sec;
    setPassCard(false); setQueue(null); setPeek(null);
    audio.current?.pause(); stopGap();
    setSummary({ ended });
  }
  function openPass() { audio.current?.pause(); stopGap(); setPassCard(true); }
  const goSection = (i: number) => {
    summed.current = -1;
    setSummary(null); setPeek(null);
    setPass(1); setPassCard(false); setQueue(null);
    seek(sections[i]?.subtitles[0]?.startTime ?? 0, true);
  };
  const onEnded = () => { if (!free && pass < 2 && summed.current !== sec) openPass(); else { setWatchPos(record.id, 0); openSummary(true); } };
  const passSec = useRef(sec);
  useEffect(() => {
    if (sec === passSec.current) return;
    passSec.current = sec;
    setPass(1); setPassCard(false); setQueue(null); summed.current = -1;
  }, [sec]);
  const secMarks = section ? section.subtitles.filter(l => marks.has(l.id)) : [];
  const hard = said.get(sec)?.a === 'little' ? 0 : secMarks.length;
  function startPass(n: number) {
    summed.current = -1;
    setPassCard(false); setPass(n); setPeek(null);
    const q = n === 2 && hard ? secMarks.map(l => l.id) : null;
    setQueue(q); setQAt(0); setPlay(1); setShown(false);
    seek(q ? secMarks[0].startTime : sections[sec]?.subtitles[0]?.startTime ?? 0, true);
  }
  const drillShow = () => { if (drillLine && !shown) { setShown(true); seek(drillLine.startTime, true); } };
  const drillNext = () => {
    if (target === null || !queue) return;
    setMarks(m => new Map(m).set(target, shown ? 'more' : 'ok'));
    setPlay(1); setShown(false);
    const nx = qAt + 1 < queue.length ? lines[indexOf.get(queue[qAt + 1]) ?? -1] : undefined;
    if (nx) { setQAt(qAt + 1); seek(nx.startTime, true); } else openSummary(false);
  };
  const lastSec = sec === sections.length - 1;
  const easy = passCard && said.get(sec)?.a === 'most' && !secMarks.length;
  const moveOn = () => { if (lastSec) openSummary(false); else goSection(sec + 1); };
  const goStep = (n: number) => { setSummary(null); if (n === 3) openSummary(false); else startPass(n); };
  const goFree = (on: boolean) => {
    setFree(on);
    if (on) { stopGap(); setPassCard(false); setQueue(null); } else goSection(sec);
  };
  const answer = (a: Heard) => { if (!said.has(sec)) { const way = noteHeard(showKey(record), a); setSaid(m => new Map(m).set(sec, { a, way })); } };

  // --- Hard lines ---
  const flipMark = (id: number, onMsg: string, offMsg: string) => {
    const on = marks.has(id);
    say(on ? offMsg : onMsg);
    setMarks(m => { const n = new Map(m); if (on) n.delete(id); else n.set(id, 'open'); return n; });
  };
  const markPrevIndex = () => {
    const i = at >= 0 && time > lines[at].endTime - 0.05 ? at : at - 1;
    return i < 0 || (sectionOf.get(lines[i].id) ?? 0) !== sec ? -1 : i;
  };
  useEffect(() => { if (peek !== null) setMarks(m => (m.has(peek) ? m : new Map(m).set(peek, 'open'))); }, [peek]);

  // "See this line" / a word's meaning pause; closing plays the paused line again from its start.
  const holdFor = () => {
    const a = audio.current;
    if (a && (!a.paused || gap.current)) { resume.current = cur ? cur.startTime : a.currentTime; a.pause(); }
    stopGap();
  };
  const release = () => { const r = resume.current; resume.current = null; if (r !== null && !summary) seek(r, true); };
  const openPeek = () => { if (cur) { holdFor(); setPeek(cur.id); } };
  const closePeek = () => { setPeek(null); release(); };
  // Plays one line inside "see this line"; closing it still goes back where it paused.
  const playLine = (l: Subtitle) => { const r = resume.current; seek(l.startTime, true); resume.current = r; holdTo.current = Math.min(l.endTime, sectionEnd(sectionOf.get(l.id) ?? 0)); };

  return {
    lines, sections, indexOf, audio, time, duration, playing, setPlaying, speed, cycleSpeed, free, goFree, mode, setMode, through, throughPref, toggleThrough,
    pass, passCard, setPassCard, marks, queue, qAt, tries, play, shown, summary, setSummary, peek, said, note, say,
    at, cur, sec, section, lastSec, hard, secMarks, easy, inDrill, drillLine,
    seek, playOn, pauseNow, toggle, prev, next, replay, onLoaded, onTime, onEnded, goSection, startPass, drillShow, drillNext, moveOn, goStep, answer,
    flipMark, markPrevIndex, openPeek, closePeek, holdFor, release, playLine, sectionEnd,
  };
}
