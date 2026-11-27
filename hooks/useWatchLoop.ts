import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Subtitle } from '../types';
import { lineAt, lineEnded } from '../utils/srtParser';
import { LOOP_GAP_MS, type LoopTimes, pageLoopHeld, useLoop } from '../utils/loop';
import type { DictKey } from '../utils/i18n';

// Watch page single-line loop and playback clock: page-local on/off (always defaults to off on
// entry, never writes global linguaclip_loop.on), shared repeat count from utils/loop, plus
// line-end decision logic shared between rAF tick and video timeupdate.

export interface WatchLineEndInput {
  loopOn: boolean;
  times: LoopTimes;
  plays: number;
  autoPause: boolean;
  busy: boolean;
  blocked: boolean;
}

export type WatchLineEndAction = 'loop' | 'pause' | 'continue';

// Pure decision at a subtitle line's end: loop takes priority over autoPause until `times` plays finish.
export function decideWatchLineEnd(p: WatchLineEndInput): WatchLineEndAction {
  if (p.busy || p.blocked) return 'continue';
  if (p.loopOn && (p.times === 0 || p.plays < p.times)) return 'loop';
  if (p.autoPause) return 'pause';
  return 'continue';
}

// Should video `ended` be treated as the final subtitle line reaching its end (e.g. endTime >= duration,
// or the final rAF/timeupdate missed the sliver before `ended`)?
export function shouldLoopAtVideoEnd(p: WatchLineEndInput & {
  lastEnd: number;
  before: number;
  now: number;
  alreadyHandled: boolean;
}): boolean {
  if (p.alreadyHandled) return false;
  const stillInLastLine = p.lastEnd >= p.now - 0.001 || p.before < p.lastEnd - 0.001;
  if (!stillInLastLine) return false;
  return decideWatchLineEnd(p) === 'loop';
}

export function useWatchLoop() {
  const [loopOn, setLoopOn] = useState(false);
  const { times } = useLoop();
  const loopOnRef = useRef(loopOn);
  loopOnRef.current = loopOn;
  const timesRef = useRef<LoopTimes>(times);
  timesRef.current = times;
  const playsRef = useRef(0);
  const lastLineRef = useRef(-1);
  const gapTimerRef = useRef(0);

  const clearGap = useCallback(() => {
    if (gapTimerRef.current) {
      window.clearTimeout(gapTimerRef.current);
      gapTimerRef.current = 0;
    }
  }, []);

  const inGap = useCallback(() => gapTimerRef.current !== 0, []);

  const resetPlays = useCallback(() => {
    playsRef.current = 0;
    lastLineRef.current = -1;
  }, []);

  // Record that line `lineIdx` just finished a play; returns completed play count (1 after 1st play).
  const lineEndedAt = useCallback((lineIdx: number) => {
    if (lastLineRef.current !== lineIdx) {
      lastLineRef.current = lineIdx;
      playsRef.current = 0;
    }
    playsRef.current += 1;
    return playsRef.current;
  }, []);

  const toggleLoop = useCallback(() => {
    const next = !loopOnRef.current;
    loopOnRef.current = next;
    setLoopOn(next);
    if (!next) {
      clearGap();
      resetPlays();
    }
    return next;
  }, [clearGap, resetPlays]);

  const scheduleLoop = useCallback((fn: () => void) => {
    clearGap();
    gapTimerRef.current = window.setTimeout(() => {
      gapTimerRef.current = 0;
      fn();
    }, LOOP_GAP_MS);
  }, [clearGap]);

  useEffect(() => () => clearGap(), [clearGap]);

  return {
    loopOn,
    times,
    loopOnRef,
    timesRef,
    playsRef,
    gapTimerRef,
    clearGap,
    inGap,
    resetPlays,
    lineEndedAt,
    toggleLoop,
    scheduleLoop,
  };
}

export function useWatchClock(opts: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  lines: Subtitle[];
  loop: ReturnType<typeof useWatchLoop>;
  autoPause: boolean;
  busy: () => boolean;
  blocked: boolean;
  onCur: (at: number, on: boolean) => void;
}) {
  const prevT = useRef(0);
  const lastPlayT = useRef(0);
  const heldAt = useRef(-1);
  const completedAt = useRef(-1);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => { if (opts.blocked) opts.loop.clearGap(); }, [opts.blocked, opts.loop.clearGap]);
  useEffect(() => { opts.loop.clearGap(); opts.loop.resetPlays(); completedAt.current = -1; }, [opts.lines, opts.loop.clearGap, opts.loop.resetPlays]);

  const seek = useCallback((sec: number, play = false, keepPlays = false) => {
    const o = optsRef.current;
    const v = o.videoRef.current;
    if (!v || o.busy()) return;
    o.loop.clearGap();
    if (!keepPlays) o.loop.resetPlays();
    heldAt.current = -1;
    completedAt.current = -1;
    const to = Math.max(0, Math.min(sec, Number.isFinite(v.duration) ? v.duration - 0.05 : sec));
    v.currentTime = to;
    prevT.current = to;
    lastPlayT.current = to;
    if (play) v.play().catch(() => {});
  }, []);

  const gapLine = useCallback(() => (optsRef.current.loop.inGap() ? heldAt.current : -1), []);

  const checkClock = useCallback(() => {
    const o = optsRef.current;
    const v = o.videoRef.current;
    if (!v) return;
    const now = v.currentTime, before = prevT.current;
    const was = lineAt(o.lines, before);
    if (!v.paused && was >= 0 && was !== heldAt.current
      && lineEnded(o.lines[was], before, now) && now - before < 0.5 * Math.max(1, v.playbackRate)) {
      const plays = o.loop.lineEndedAt(was);
      const action = decideWatchLineEnd({
        loopOn: o.loop.loopOnRef.current,
        times: o.loop.timesRef.current,
        plays,
        autoPause: o.autoPause,
        busy: o.busy(),
        blocked: o.blocked || pageLoopHeld(),
      });
      if (action === 'loop') {
        const line = o.lines[was];
        const back = Math.max(line.startTime, line.endTime - 0.02);
        v.pause();
        v.currentTime = back;
        prevT.current = back;
        lastPlayT.current = back;
        heldAt.current = was;
        o.loop.scheduleLoop(() => {
          const cur = optsRef.current;
          if (!cur.loop.loopOnRef.current || cur.busy() || cur.blocked || pageLoopHeld()) return;
          seek(line.startTime, true, true);
        });
      } else {
        o.loop.resetPlays();
        completedAt.current = was;
        if (action === 'pause') {
          const back = Math.max(o.lines[was].startTime, o.lines[was].endTime - 0.02);
          v.pause();
          heldAt.current = was;
          v.currentTime = back;
          prevT.current = back;
          lastPlayT.current = back;
        } else {
          prevT.current = now;
          lastPlayT.current = now;
        }
      }
    } else {
      prevT.current = now;
      if (!v.paused) lastPlayT.current = now;
    }
    const tNow = v.currentTime;
    const at = lineAt(o.lines, tNow);
    o.onCur(at, at >= 0 && tNow < o.lines[at].endTime);
  }, [seek]);

  // If the final subtitle extends to or past video.duration (or ended fires right after a paused
  // timeupdate), intercept it when watch loop still has repeats left instead of jumping to summary.
  const tryEndLoop = useCallback((): boolean => {
    const o = optsRef.current;
    const v = o.videoRef.current;
    if (!v) return false;
    if (o.loop.inGap()) return true;
    const lastIdx = o.lines.length - 1;
    if (lastIdx < 0 || !o.loop.loopOnRef.current) return false;
    const now = v.currentTime;
    if (lineAt(o.lines, now) !== lastIdx) return false;
    const line = o.lines[lastIdx];
    const before = lastPlayT.current;
    const alreadyHandled = heldAt.current === lastIdx || completedAt.current === lastIdx;
    const stillInLastLine = line.endTime >= now - 0.001 || before < line.endTime - 0.001;
    if (alreadyHandled || !stillInLastLine) return false;
    const plays = o.loop.lineEndedAt(lastIdx);
    const shouldLoop = shouldLoopAtVideoEnd({
      loopOn: o.loop.loopOnRef.current,
      times: o.loop.timesRef.current,
      plays,
      autoPause: o.autoPause,
      busy: o.busy(),
      blocked: o.blocked || pageLoopHeld(),
      lastEnd: line.endTime,
      before,
      now,
      alreadyHandled: false,
    });
    if (!shouldLoop) {
      o.loop.resetPlays();
      completedAt.current = lastIdx;
      return false;
    }
    // Step slightly off `duration` so manual Space / lookup unpause during the gap doesn't restart at 0:00.
    const endCap = Number.isFinite(v.duration) ? Math.min(line.endTime, v.duration) : line.endTime;
    const back = Math.max(line.startTime, endCap - 0.05);
    v.currentTime = back;
    prevT.current = back;
    lastPlayT.current = back;
    heldAt.current = lastIdx;
    o.loop.scheduleLoop(() => {
      const cur = optsRef.current;
      if (!cur.loop.loopOnRef.current || cur.busy() || cur.blocked || pageLoopHeld()) return;
      seek(line.startTime, true, true);
    });
    return true;
  }, [seek]);

  useEffect(() => {
    let raf = 0;
    const tick = () => { checkClock(); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [checkClock]);

  return { seek, checkClock, tryEndLoop, gapLine };
}

export const watchLegend = (key: (id: string) => string, t: (k: DictKey) => string, ankiReady: boolean): [string, string][] => [
  [key('play'), t('keys.play')],
  [key('prev'), t('keys.prev')],
  [key('next'), t('keys.next')],
  [key('replay'), t('keys.replay')],
  [key('loop'), t('watch.loop')],
  [key('save'), t('watch.keySave')],
  [key('autoPause'), t('watch.autoPause')],
  [key('subs'), t('watch.keySubs')],
  [key('peek'), t('watch.showLine')],
  [key('full'), t('watch.fullscreen')],
  ...(ankiReady ? [[key('anki'), t('keys.anki')] as [string, string]] : []),
];
