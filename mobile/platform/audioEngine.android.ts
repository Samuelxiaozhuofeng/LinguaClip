// Android native Media3 playback engine (swapped in for audioEngine.ts by vite.android.config.ts).
// Connects directly to window.LinguaAndroid (`playback.*`) without rendering any <audio> element
// or registering navigator.mediaSession.
import { callAndroid, isAndroidNative, onAndroidEvent, type PlaybackSnapshot } from './androidBridge';
import { consumePendingAndroidBgMarks, subscribeAndroidBgMarks } from './androidInit.android';
import type {
  AudioEngine,
  EngineBgMark,
  EngineCallbacks,
  EngineCue,
  EngineLoadOpts,
  EngineState,
} from './audioEngine';

export type { AudioEngine, EngineBgMark, EngineCallbacks, EngineCue, EngineLoadOpts, EngineState };

export const AUDIO_ENGINE_PLATFORM: 'web' | 'android' = 'android';

export async function resolveAudioSource(path: string): Promise<string> {
  if (!path || path.startsWith('blob:')) {
    throw new Error('audio:missing');
  }
  if (/^https?:\/\//i.test(path) || path.startsWith('content://') || path.startsWith('file://')) {
    return path;
  }
  if (isAndroidNative()) {
    const info = await callAndroid<{ exists: boolean }>('media.fileInfo', { path });
    if (!info.exists) throw new Error('audio:missing');
  }
  return path;
}

type NativeEventMeta = { mediaId?: string; gen?: number };

export function createAudioEngine(cbs: EngineCallbacks): AudioEngine {
  let activeMediaId = '';
  let activeGen = 0;
  let disposed = false;
  let loadedEmitted = false;
  let expectingLoop = false;
  let lastReportedLoopCount = 0;
  const seenBgIds = new Set<string>();

  let state: EngineState = {
    time: 0,
    duration: 0,
    playing: false,
    ready: false,
    loopActive: false,
    waitingGap: false,
  };

  // Serialize mutating playback.* bridge calls so LinguaBridge's CachedThreadPool never reorders them.
  let chain: Promise<unknown> = Promise.resolve();
  let pauseQueued = false;
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => {});
    return next;
  };

  const isMine = (p?: NativeEventMeta | null): boolean => {
    if (!p || !activeMediaId) return false;
    if (p.mediaId && p.mediaId !== activeMediaId) return false;
    if (activeGen > 0 && typeof p.gen === 'number' && p.gen !== activeGen) return false;
    return true;
  };

  const emitState = () => {
    if (!disposed) cbs.onState({ ...state });
  };

  const applySnapshot = (snap: PlaybackSnapshot & { reason?: string }) => {
    if (disposed || !isMine(snap)) return;
    if (typeof snap.gen === 'number' && snap.gen > 0) activeGen = snap.gen;
    const dur = snap.durationMs > 0 ? snap.durationMs / 1000 : state.duration;
    const pos = Math.max(0, snap.positionMs / 1000);
    const hasLoop = !!snap.loop;
    // Player.STATE_READY == 3 in AndroidX Media3.
    const isReady = state.ready || snap.playbackState === 3 || snap.durationMs > 0 || snap.reason === 'ready';
    state = {
      time: pos,
      duration: dur,
      playing: !!snap.playing,
      ready: isReady,
      loopActive: hasLoop,
      waitingGap: !!snap.loop?.waitingGap,
    };
    if (!loadedEmitted && isReady) {
      loadedEmitted = true;
      cbs.onLoaded?.(dur, pos);
    }
    emitState();
    if (snap.reason === 'ended') {
      cbs.onEnded?.();
    }
  };

  const deliverBgMark = (ev: EngineBgMark) => {
    if (disposed || !activeMediaId || ev.mediaId !== activeMediaId) return;
    if (!ev.id || seenBgIds.has(ev.id)) return;
    seenBgIds.add(ev.id);
    cbs.onBgMark?.(ev);
  };

  const unsubs: (() => void)[] = [];

  unsubs.push(
    onAndroidEvent<PlaybackSnapshot & { reason?: string }>('playbackState', snap => {
      applySnapshot(snap);
    }),
  );

  unsubs.push(
    onAndroidEvent<{
      mediaId?: string;
      gen?: number;
      positionMs: number;
      durationMs: number;
      playing: boolean;
    }>('playbackTick', tick => {
      if (disposed || !isMine(tick)) return;
      const dur = tick.durationMs > 0 ? tick.durationMs / 1000 : state.duration;
      state = {
        ...state,
        time: Math.max(0, tick.positionMs / 1000),
        duration: dur,
        playing: !!tick.playing,
        ready: true,
      };
      emitState();
    }),
  );

  unsubs.push(
    onAndroidEvent<{
      mediaId?: string;
      gen?: number;
      completedLoops: number;
      remaining: number;
      positionMs?: number;
    }>('loopTick', ev => {
      if (disposed || !isMine(ev)) return;
      lastReportedLoopCount = Math.max(lastReportedLoopCount, ev.completedLoops);
      state = {
        ...state,
        time: typeof ev.positionMs === 'number' ? Math.max(0, ev.positionMs / 1000) : state.time,
        playing: false,
        loopActive: true,
        waitingGap: true,
      };
      emitState();
      cbs.onLoopTick?.(ev.completedLoops, ev.remaining);
    }),
  );

  unsubs.push(
    onAndroidEvent<{
      mediaId?: string;
      gen?: number;
      completedLoops: number;
      positionMs?: number;
    }>('loopCompleted', ev => {
      if (disposed || !isMine(ev)) return;
      expectingLoop = false;
      lastReportedLoopCount = Math.max(lastReportedLoopCount, ev.completedLoops);
      state = {
        ...state,
        time: typeof ev.positionMs === 'number' ? Math.max(0, ev.positionMs / 1000) : state.time,
        playing: false,
        loopActive: false,
        waitingGap: false,
      };
      emitState();
      cbs.onLoopComplete?.(ev.completedLoops);
    }),
  );

  unsubs.push(
    onAndroidEvent<{
      mediaId?: string;
      gen?: number;
      positionMs: number;
      sectionEndMs: number;
    }>('sectionEnded', ev => {
      if (disposed || !isMine(ev)) return;
      const posSec = Math.max(0, ev.positionMs / 1000);
      const stopSec = Math.max(0, ev.sectionEndMs / 1000);
      state = { ...state, time: posSec, playing: false };
      emitState();
      cbs.onSectionEnd?.(posSec, stopSec);
    }),
  );

  unsubs.push(
    onAndroidEvent<{
      mediaId?: string;
      gen?: number;
      positionMs: number;
    }>('holdEnded', ev => {
      if (disposed || !isMine(ev)) return;
      const posSec = Math.max(0, ev.positionMs / 1000);
      state = { ...state, time: posSec, playing: false };
      emitState();
      cbs.onHoldEnd?.(posSec);
    }),
  );

  unsubs.push(
    onAndroidEvent<{
      mediaId?: string;
      gen?: number;
      index: number;
      lineId?: number;
      positionMs: number;
    }>('sentencePaused', ev => {
      if (disposed || !isMine(ev)) return;
      const posSec = Math.max(0, ev.positionMs / 1000);
      state = { ...state, time: posSec, playing: false };
      emitState();
      cbs.onSentencePause?.(ev.index, ev.lineId ?? -1, posSec);
    }),
  );

  unsubs.push(
    onAndroidEvent<{
      mediaId?: string;
      gen?: number;
      index: number;
      lineId?: number;
      startMs: number;
      delta?: number;
    }>('sentenceJumped', ev => {
      if (disposed || !isMine(ev)) return;
      const startSec = Math.max(0, ev.startMs / 1000);
      state = { ...state, time: startSec };
      emitState();
      cbs.onSentenceJump?.(ev.index, ev.lineId ?? -1, startSec, ev.delta ?? 0);
    }),
  );

  unsubs.push(
    onAndroidEvent<{
      mediaId?: string;
      gen?: number;
      errorCode?: number;
      message?: string;
    }>('playbackError', ev => {
      if (disposed || !isMine(ev)) return;
      console.error('[audioEngine.android playbackError]', ev);
      state = { ...state, playing: false, loopActive: false, waitingGap: false };
      emitState();
      cbs.onError?.('listen.failed');
    }),
  );

  unsubs.push(subscribeAndroidBgMarks(ev => {
    deliverBgMark(ev);
  }));

  const onVisibility = () => {
    if (disposed || document.visibilityState !== 'visible' || !activeMediaId) return;
    callAndroid<PlaybackSnapshot>('playback.getState')
      .then(snap => {
        if (disposed || !isMine(snap)) return;
        const wasExpectingLoop = expectingLoop;
        applySnapshot(snap);
        if (snap.loop && snap.loop.completedLoops > lastReportedLoopCount) {
          lastReportedLoopCount = snap.loop.completedLoops;
          cbs.onLoopTick?.(snap.loop.completedLoops, snap.loop.remaining);
        } else if (wasExpectingLoop && !snap.loop && !snap.playing) {
          expectingLoop = false;
          cbs.onLoopComplete?.(lastReportedLoopCount + 1);
        }
      })
      .catch(() => {});
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
    unsubs.push(() => document.removeEventListener('visibilitychange', onVisibility));
  }

  return {
    platform: 'android',
    attachElement() {
      // Android uses Media3 PlaybackService, never an HTML <audio> element.
    },
    async load(opts) {
      activeMediaId = opts.mediaId;
      loadedEmitted = false;
      expectingLoop = false;
      lastReportedLoopCount = 0;

      for (const buffered of consumePendingAndroidBgMarks(opts.mediaId)) {
        deliverBgMark(buffered);
      }

      await enqueue(async () => {
        if (disposed) return;
        const stopsMs = opts.stopsSec.map(s => Math.round(s * 1000));
        try {
          const cur = await callAndroid<PlaybackSnapshot>('playback.getState');
          // Do not hard-restart ExoPlayer if the exact same episode is already playing in background.
          if (cur.mediaId === opts.mediaId && cur.source === opts.source && cur.playing) {
            activeGen = cur.gen ?? 0;
            await callAndroid('playback.setTimeline', { cues: opts.cues, sectionEndMs: -1 });
            await callAndroid('playback.setStops', { stopsMs });
            await callAndroid('playback.setRate', { rate: opts.rate });
            applySnapshot(cur);
            if (!loadedEmitted) {
              loadedEmitted = true;
              cbs.onLoaded?.(state.duration, state.time);
            }
            return;
          }
        } catch {
          // Fall through to fresh load.
        }

        const snap = await callAndroid<PlaybackSnapshot>('playback.load', {
          source: opts.source,
          mediaId: opts.mediaId,
          title: opts.title,
          artist: opts.artist,
          artworkUri: opts.artworkUri ?? '',
          startMs: Math.round(opts.startSec * 1000),
          autoPlay: opts.autoPlay,
          rate: opts.rate,
          cues: opts.cues,
          stopsMs,
        });
        activeGen = snap.gen ?? 0;
        applySnapshot(snap);
      }).catch(e => {
        console.error('[audioEngine.android load]', e);
        if (!disposed) cbs.onError?.('listen.failed');
      });
    },
    play() {
      void enqueue(async () => {
        if (disposed) return;
        const snap = await callAndroid<PlaybackSnapshot>('playback.play');
        applySnapshot(snap);
      }).catch(e => console.error('[audioEngine.android play]', e));
    },
    pause() {
      pauseQueued = true;
      void enqueue(async () => {
        if (disposed) return;
        pauseQueued = false;
        const snap = await callAndroid<PlaybackSnapshot>('playback.pause');
        applySnapshot(snap);
      }).catch(e => console.error('[audioEngine.android pause]', e));
    },
    seek(sec, autoPlay = false) {
      const clamped = Math.max(0, sec);
      state = { ...state, time: clamped, waitingGap: false };
      emitState();
      void enqueue(async () => {
        if (disposed) return;
        const snap = await callAndroid<PlaybackSnapshot>('playback.seek', { positionMs: Math.round(clamped * 1000) });
        applySnapshot(snap);
        if (autoPlay && !disposed) {
          const playSnap = await callAndroid<PlaybackSnapshot>('playback.play');
          applySnapshot(playSnap);
        }
      }).catch(e => console.error('[audioEngine.android seek]', e));
    },
    setRate(rate) {
      void enqueue(async () => {
        if (disposed) return;
        const snap = await callAndroid<PlaybackSnapshot>('playback.setRate', { rate });
        applySnapshot(snap);
      }).catch(e => console.error('[audioEngine.android setRate]', e));
    },
    setStops(stopsSec) {
      const stopsMs = stopsSec.map(s => Math.round(s * 1000));
      void enqueue(async () => {
        if (disposed) return;
        await callAndroid('playback.setStops', { stopsMs });
      }).catch(e => console.error('[audioEngine.android setStops]', e));
    },
    setAutoPause(enabled) {
      void enqueue(async () => {
        if (disposed) return;
        await callAndroid('playback.setAutoPause', { enabled });
      }).catch(e => console.error('[audioEngine.android setAutoPause]', e));
    },
    setLoop(startSec, endSec, count, gapMs = 300) {
      expectingLoop = endSec > startSec && count > 0;
      lastReportedLoopCount = 0;
      void enqueue(async () => {
        if (disposed) return;
        const snap = await callAndroid<PlaybackSnapshot>('playback.setLoop', {
          startMs: Math.round(Math.max(0, startSec) * 1000),
          endMs: Math.round(Math.max(0, endSec) * 1000),
          count,
          gapMs,
        });
        applySnapshot(snap);
      }).catch(e => console.error('[audioEngine.android setLoop]', e));
    },
    clearLoop() {
      expectingLoop = false;
      lastReportedLoopCount = 0;
      void enqueue(async () => {
        if (disposed) return;
        const snap = await callAndroid<PlaybackSnapshot>('playback.clearLoop');
        applySnapshot(snap);
      }).catch(e => console.error('[audioEngine.android clearLoop]', e));
    },
    holdAt(endSec) {
      void enqueue(async () => {
        if (disposed) return;
        await callAndroid('playback.holdAt', { endMs: endSec !== null && endSec > 0 ? Math.round(endSec * 1000) : null });
      }).catch(e => console.error('[audioEngine.android holdAt]', e));
    },
    setNav(lineIds) {
      void enqueue(async () => {
        if (disposed) return;
        await callAndroid('playback.setNav', { lineIds });
      }).catch(e => console.error('[audioEngine.android setNav]', e));
    },
    getState: () => ({ ...state }),
    dispose() {
      // Pages pause and dispose in the same unmount. A pause still waiting behind this engine's
      // queue goes out now, before the next page's engine starts — sent later it would stop that one.
      if (pauseQueued && !disposed) void callAndroid('playback.pause').catch(() => {});
      pauseQueued = false;
      disposed = true;
      for (const off of unsubs) off();
      unsubs.length = 0;
    },
  };
}
