// Web/PWA playback engine wrapping <audio> + mobile/listenBoundaries.ts.
// Swapped for audioEngine.android.ts in vite.android.config.ts (Android native Media3).
import type { Subtitle } from '../../types';
import { evaluateWebBoundary, type WebLoopState } from '../listenBoundaries';
import { prepareSrc, videoSrcFromPath } from './desktop';

export const AUDIO_ENGINE_PLATFORM: 'web' | 'android' = 'web';

export type EngineCue = { id: number; startMs: number; endMs: number; text: string };

export type EngineLoadOpts = {
  source: string;
  mediaId: string;
  title: string;
  artist: string;
  artworkUri?: string;
  startSec: number;
  autoPlay: boolean;
  rate: number;
  cues: EngineCue[];
  stopsSec: number[];
};

export type EngineState = {
  time: number;
  duration: number;
  playing: boolean;
  ready: boolean;
  loopActive: boolean;
  waitingGap: boolean;
};

export type EngineBgMark = {
  id: string;
  mediaId: string;
  lineId?: number;
  startMs: number;
  endMs: number;
  positionMs: number;
  text: string;
  ts: number;
};

export type EngineCallbacks = {
  onState: (st: EngineState) => void;
  onLoaded?: (durationSec: number, initialTimeSec: number) => void;
  onSectionEnd?: (posSec: number, stopSec: number) => void;
  onLoopTick?: (completedLoops: number, remaining: number) => void;
  onLoopComplete?: (completedLoops: number) => void;
  onHoldEnd?: (posSec: number) => void;
  onSentencePause?: (cueIndex: number, lineId: number, posSec: number) => void;
  onSentenceJump?: (cueIndex: number, lineId: number, startSec: number, delta: number) => void;
  onEnded?: () => void;
  onError?: (code: string) => void;
  onBgMark?: (ev: EngineBgMark) => void;
};

export interface AudioEngine {
  readonly platform: 'web' | 'android';
  attachElement(el: HTMLAudioElement | null): void;
  load(opts: EngineLoadOpts): Promise<void>;
  play(): void;
  pause(): void;
  seek(sec: number, autoPlay?: boolean): void;
  setRate(rate: number): void;
  setStops(stopsSec: number[]): void;
  setAutoPause(enabled: boolean): void;
  setLoop(startSec: number, endSec: number, count: number, gapMs?: number): void;
  clearLoop(): void;
  holdAt(endSec: number | null): void;
  setNav(lineIds: number[] | null): void;
  getState(): EngineState;
  dispose(): void;
}

export async function resolveAudioSource(path: string): Promise<string> {
  await prepareSrc(path);
  return videoSrcFromPath(path);
}

export function createAudioEngine(cbs: EngineCallbacks): AudioEngine {
  let el: HTMLAudioElement | null = null;
  let pendingLoad: EngineLoadOpts | null = null;
  let lines: Subtitle[] = [];
  let stops: number[] = [];
  let autoPause = false;
  let loop: WebLoopState | null = null;
  let holdTo: number | null = null;
  let heldBoundary: number | null = null;
  let prevT = 0;
  let rate = 1;
  let initialStartSec = 0;
  let initialAutoPlay = false;
  let activeSource = '';
  let gapTimer = 0;
  let waitingGap = false;
  let rafId = 0;
  let lastReportedTime = 0;
  let ready = false;
  let disposed = false;

  const stopGap = () => {
    if (gapTimer) {
      window.clearTimeout(gapTimer);
      gapTimer = 0;
    }
    waitingGap = false;
  };

  const snapshot = (): EngineState => ({
    time: el ? el.currentTime : 0,
    duration: el && Number.isFinite(el.duration) ? el.duration : 0,
    playing: !!el && !el.paused && !el.ended,
    ready,
    loopActive: loop !== null,
    waitingGap,
  });

  const emitState = () => {
    if (disposed) return;
    const st = snapshot();
    lastReportedTime = st.time;
    cbs.onState(st);
  };

  const runBoundaryCheck = (forceEnded: boolean): boolean => {
    if (!el || disposed) return false;
    const now = el.currentTime;
    const before = prevT;
    if (Math.abs(now - lastReportedTime) > 0.04) {
      emitState();
    }
    if (heldBoundary !== null && (now > heldBoundary + 0.1 || now < heldBoundary - 0.25)) {
      heldBoundary = null;
    }
    const action = evaluateWebBoundary({
      lines,
      before,
      now,
      paused: el.paused,
      forceEnded,
      holdTo,
      loop,
      stops,
      autoPause,
      heldBoundary,
    });
    if (action.kind === 'none') {
      prevT = el.currentTime;
      return false;
    }
    if (action.kind === 'holdEnd') {
      holdTo = null;
      el.pause();
      el.currentTime = action.pullBack;
      prevT = action.pullBack;
      emitState();
      cbs.onHoldEnd?.(action.pullBack);
      return true;
    }
    if (action.kind === 'loopEnd') {
      el.pause();
      el.currentTime = action.pullBack;
      prevT = action.pullBack;
      const curLoop = loop!;
      if (action.done) {
        loop = null;
        heldBoundary = action.boundary;
        stopGap();
        emitState();
        cbs.onLoopComplete?.(action.completedLoops);
        return true;
      }
      curLoop.remaining = action.nextRemaining;
      curLoop.completedLoops = action.completedLoops;
      if (curLoop.gapMs > 0) {
        stopGap();
        waitingGap = true;
        emitState();
        cbs.onLoopTick?.(action.completedLoops, action.nextRemaining);
        const startFrom = curLoop.start;
        gapTimer = window.setTimeout(() => {
          gapTimer = 0;
          waitingGap = false;
          if (!el || disposed || !loop) return;
          el.currentTime = startFrom;
          prevT = startFrom;
          emitState();
          el.play().catch(() => {});
        }, curLoop.gapMs);
      } else {
        cbs.onLoopTick?.(action.completedLoops, action.nextRemaining);
        el.currentTime = curLoop.start;
        prevT = curLoop.start;
        emitState();
        el.play().catch(() => {});
      }
      return true;
    }
    if (action.kind === 'sectionEnd') {
      heldBoundary = action.stopTime;
      el.pause();
      el.currentTime = action.pullBack;
      prevT = action.pullBack;
      emitState();
      cbs.onSectionEnd?.(action.pullBack, action.stopTime);
      return true;
    }
    if (action.kind === 'sentencePause') {
      heldBoundary = action.boundary;
      el.pause();
      el.currentTime = action.pullBack;
      prevT = action.pullBack;
      emitState();
      cbs.onSentencePause?.(action.lineIndex, action.lineId, action.pullBack);
      return true;
    }
    return false;
  };

  const onLoadedMetadata = () => {
    if (!el || disposed) return;
    ready = true;
    el.playbackRate = rate;
    const dur = Number.isFinite(el.duration) ? el.duration : 0;
    if (initialStartSec > 0 && (dur <= 0 || initialStartSec < dur - 3)) {
      const s = Math.max(0, dur > 0 ? Math.min(initialStartSec, dur - 0.05) : initialStartSec);
      el.currentTime = s;
      prevT = s;
    } else {
      prevT = el.currentTime;
    }
    cbs.onLoaded?.(dur, el.currentTime);
    emitState();
    if (initialAutoPlay) {
      el.play().catch(() => {});
    }
  };
  const onTimeUpdate = () => { runBoundaryCheck(false); };
  const onPlay = () => { emitState(); };
  const onPause = () => { emitState(); };
  const onEnded = () => {
    const handled = runBoundaryCheck(true);
    if (!handled && !disposed) {
      emitState();
      cbs.onEnded?.();
    }
  };
  const onError = () => {
    if (activeSource && !disposed) cbs.onError?.('listen.failed');
  };

  const startRaf = () => {
    if (rafId || disposed) return;
    const tick = () => {
      if (disposed) return;
      runBoundaryCheck(false);
      rafId = window.requestAnimationFrame(tick);
    };
    rafId = window.requestAnimationFrame(tick);
  };
  const stopRaf = () => {
    if (rafId) {
      window.cancelAnimationFrame(rafId);
      rafId = 0;
    }
  };

  const detachCurrent = () => {
    if (!el) return;
    el.removeEventListener('loadedmetadata', onLoadedMetadata);
    el.removeEventListener('timeupdate', onTimeUpdate);
    el.removeEventListener('play', onPlay);
    el.removeEventListener('pause', onPause);
    el.removeEventListener('ended', onEnded);
    el.removeEventListener('error', onError);
    el = null;
    stopRaf();
  };

  const applyLoad = (opts: EngineLoadOpts) => {
    if (!el) {
      pendingLoad = opts;
      return;
    }
    stopGap();
    loop = null;
    holdTo = null;
    heldBoundary = null;
    autoPause = false;
    ready = false;
    lines = opts.cues.map(c => ({ id: c.id, startTime: c.startMs / 1000, endTime: c.endMs / 1000, text: c.text }));
    stops = [...opts.stopsSec];
    rate = opts.rate;
    initialStartSec = opts.startSec;
    initialAutoPlay = opts.autoPlay;
    activeSource = opts.source;
    el.playbackRate = rate;
    el.src = opts.source;
    el.load();
    // Mark ready as soon as source is bound so iOS Safari (which may defer loadedmetadata until
    // a user tap) never disables the Play button before the first gesture.
    ready = true;
    emitState();
  };

  return {
    platform: 'web',
    attachElement(nextEl) {
      if (nextEl === el) return;
      detachCurrent();
      if (!nextEl || disposed) return;
      el = nextEl;
      el.addEventListener('loadedmetadata', onLoadedMetadata);
      el.addEventListener('timeupdate', onTimeUpdate);
      el.addEventListener('play', onPlay);
      el.addEventListener('pause', onPause);
      el.addEventListener('ended', onEnded);
      el.addEventListener('error', onError);
      startRaf();
      if (pendingLoad) {
        const opts = pendingLoad;
        pendingLoad = null;
        applyLoad(opts);
      }
    },
    async load(opts) {
      applyLoad(opts);
    },
    play() {
      if (!el) return;
      stopGap();
      el.play().catch(() => {});
    },
    pause() {
      stopGap();
      el?.pause();
    },
    seek(sec, autoPlay = false) {
      if (!el) return;
      stopGap();
      heldBoundary = null;
      holdTo = null;
      const s = Math.max(0, Math.min(sec, Number.isFinite(el.duration) && el.duration > 0 ? el.duration - 0.05 : sec));
      el.currentTime = s;
      prevT = s;
      emitState();
      if (autoPlay) el.play().catch(() => {});
    },
    setRate(nextRate) {
      rate = nextRate;
      if (el) el.playbackRate = nextRate;
    },
    setStops(nextStops) {
      stops = [...nextStops];
      heldBoundary = null;
    },
    setAutoPause(enabled) {
      autoPause = enabled;
      heldBoundary = null;
    },
    setLoop(startSec, endSec, count, gapMs = 300) {
      stopGap();
      heldBoundary = null;
      holdTo = null;
      if (endSec <= startSec) {
        loop = null;
        emitState();
        return;
      }
      loop = {
        start: Math.max(0, startSec),
        end: endSec,
        remaining: count <= 0 ? -1 : Math.max(0, count - 1),
        completedLoops: 0,
        gapMs,
      };
      if (el) {
        el.currentTime = loop.start;
        prevT = loop.start;
      }
      emitState();
    },
    clearLoop() {
      stopGap();
      loop = null;
      emitState();
    },
    holdAt(endSec) {
      holdTo = endSec !== null && endSec > 0 ? endSec : null;
    },
    setNav() {
      // Web handles prev/next in Listen.tsx + mediaSession.ts directly.
    },
    getState: snapshot,
    dispose() {
      disposed = true;
      stopGap();
      detachCurrent();
    },
  };
}
