// One line at a time, for the phone's practice ways other than listening (dictation, blur, cloze,
// AI custom, reader; docs/android-roadmap.md「第 2 期施工约定」). Same engine as useListen
// (mobile/platform/audioEngine.ts: Web <audio> on the PWA, native Media3 on Android), but only
// "play this line and stop at its end", replay, pause and speed. A way using it renders
// <PlayerAudio player={p} /> once (it is a no-op on Android) and reports positions itself.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Subtitle, VideoRecord } from '../../types';
import {
  AUDIO_ENGINE_PLATFORM,
  createAudioEngine,
  resolveAudioSource,
  type AudioEngine,
  type EngineCue,
} from '../platform/audioEngine';
import { clearPlayingProbe, setPlayingProbe } from '../../utils/today';

export interface LinePlayer {
  bindAudio: (el: HTMLAudioElement | null) => void;
  ready: boolean;
  errorCode: string;
  playing: boolean;
  rate: number;
  setRate: (r: number) => void;
  /** Play line i from its start and stop at its end (seconds of padding either side, default 0). */
  playLine: (i: number, pad?: number) => void;
  /** playLine for a line object (e.g. the one a word was looked up in), found by id. */
  playSubtitle: (line: Subtitle, pad?: number) => void;
  /** Play the last line given to playLine again. */
  replay: () => void;
  pause: () => void;
  /** Pause if playing, else replay the current line. */
  toggle: () => void;
  /** The index last given to playLine (-1 before the first). */
  current: number;
}

export function useLinePlayer(record: VideoRecord, lines: Subtitle[]): LinePlayer {
  const [ready, setReady] = useState(false);
  const [errorCode, setErrorCode] = useState('');
  const [playing, setPlaying] = useState(false);
  const [rate, setRateState] = useState(1);
  const [current, setCurrent] = useState(-1);
  const engine = useRef<AudioEngine | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const pending = useRef<{ i: number; pad: number } | null>(null);
  const lastPad = useRef(0);
  const playingRef = useRef(false);
  playingRef.current = playing;

  // The practice clock can't see Media3 (no <audio> on Android): tell it when a line is playing.
  useEffect(() => {
    const probe = () => playingRef.current;
    setPlayingProbe(probe);
    return () => clearPlayingProbe(probe);
  }, []);

  const start = useCallback((i: number, pad: number) => {
    const eng = engine.current;
    const line = linesRef.current[i];
    if (!eng || !line) return;
    pending.current = null;
    // seek() clears any hold on both engines, so: seek, then hold, then play — Android queues
    // the three in order, so the stop is in place before Media3 starts moving.
    eng.seek(Math.max(0, line.startTime - pad), false);
    eng.holdAt(line.endTime + pad);
    eng.play();
  }, []);

  const path = record.videoPath ?? '';
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setErrorCode('');
    const eng = createAudioEngine({
      // iOS Safari may hold back loadedmetadata until a tap plays the element, so a "ready"
      // state (source bound) counts too, or the first tap would only queue behind it.
      onState: st => { if (cancelled) return; setPlaying(st.playing); if (st.ready) setReady(true); },
      onLoaded: () => {
        if (cancelled) return;
        setReady(true);
        const p = pending.current;
        pending.current = null;
        if (p) start(p.i, p.pad);
      },
      onHoldEnd: () => { if (!cancelled) setPlaying(false); },
      onError: code => { if (!cancelled) setErrorCode(code); },
    });
    engine.current = eng;
    if (audio.current) eng.attachElement(audio.current);
    const cues: EngineCue[] = linesRef.current.map(l => ({ id: l.id, startMs: Math.round(l.startTime * 1000), endMs: Math.round(l.endTime * 1000), text: l.text }));
    resolveAudioSource(path).then(
      source => {
        if (cancelled) return;
        return eng.load({
          source,
          mediaId: record.id,
          title: record.displayName,
          artist: record.podcast?.show ?? '',
          artworkUri: record.podcast?.image ?? '',
          startSec: linesRef.current[Math.max(0, pending.current?.i ?? 0)]?.startTime ?? 0,
          autoPlay: false,
          rate: 1,
          cues,
          stopsSec: [],
        });
      },
      (e: unknown) => { if (!cancelled) setErrorCode(e instanceof Error ? e.message : String(e)); },
    );
    return () => {
      cancelled = true;
      if (AUDIO_ENGINE_PLATFORM === 'android') eng.pause();
      eng.dispose();
      if (engine.current === eng) engine.current = null;
    };
  }, [record.id, path]); // eslint-disable-line react-hooks/exhaustive-deps

  const bindAudio = useCallback((el: HTMLAudioElement | null) => {
    audio.current = el;
    engine.current?.attachElement(el);
  }, []);

  const playLine = useCallback((i: number, pad = 0) => {
    setCurrent(i);
    lastPad.current = pad;
    if (!ready) { pending.current = { i, pad }; return; }
    start(i, pad);
  }, [ready, start]);

  const playSubtitle = useCallback((line: Subtitle, pad = 0) => {
    const i = linesRef.current.findIndex(l => l.id === line.id && l.startTime === line.startTime);
    if (i >= 0) playLine(i, pad);
  }, [playLine]);

  const replay = useCallback(() => { if (current >= 0) playLine(current, lastPad.current); }, [current, playLine]);
  const pause = useCallback(() => { pending.current = null; engine.current?.pause(); }, []);
  const toggle = useCallback(() => { if (playing) pause(); else replay(); }, [playing, pause, replay]);
  const setRate = useCallback((r: number) => { setRateState(r); engine.current?.setRate(r); }, []);

  return { bindAudio, ready, errorCode, playing, rate, setRate, playLine, playSubtitle, replay, pause, toggle, current };
}

/** The hidden <audio> the PWA plays through; nothing on Android (native Media3). */
export const PlayerAudio: React.FC<{ player: LinePlayer }> = ({ player }) =>
  AUDIO_ENGINE_PLATFORM === 'web' ? React.createElement('audio', { ref: player.bindAudio, preload: 'auto' }) : null;
