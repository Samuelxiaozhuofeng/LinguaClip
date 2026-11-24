// Reader audio player built on mobile/platform/audioEngine.ts (Web <audio> on PWA, Media3 on Android).
// Supports both single-line stop (calls seek BEFORE holdAt so neither Web nor Android clears holdTo)
// and continuous playback (tracks current time via lineAt to highlight & follow the spoken line).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Subtitle, VideoRecord } from '../../types';
import { lineAt } from '../../utils/srtParser';
import {
  AUDIO_ENGINE_PLATFORM,
  createAudioEngine,
  resolveAudioSource,
  type AudioEngine,
  type EngineCue,
} from '../platform/audioEngine';
import { clearPlayingProbe, setPlayingProbe } from '../../utils/today';

export type ReadPlayMode = 'single' | 'continuous';

export interface ReaderPlayer {
  bindAudio: (el: HTMLAudioElement | null) => void;
  ready: boolean;
  errorCode: string;
  playing: boolean;
  rate: number;
  mode: ReadPlayMode;
  current: number;
  setRate: (r: number) => void;
  setMode: (m: ReadPlayMode) => void;
  /** Play line i in the active mode (single stops at line end; continuous plays on). */
  playLine: (i: number, overrideMode?: ReadPlayMode) => void;
  /** Update highlighted line without starting playback (e.g., jumping to a phrase or resuming). */
  focusLine: (i: number) => void;
  pause: () => void;
  toggle: () => void;
}

export function useReaderPlayer(
  record: VideoRecord,
  lines: Subtitle[],
  initialIndex: number,
  onActiveLine?: (index: number) => void,
): ReaderPlayer {
  const [ready, setReady] = useState(false);
  const [errorCode, setErrorCode] = useState('');
  const [playing, setPlaying] = useState(false);
  const [rate, setRateState] = useState(1);
  const [mode, setModeState] = useState<ReadPlayMode>('single');
  const [current, setCurrent] = useState(initialIndex);

  const engine = useRef<AudioEngine | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const modeRef = useRef<ReadPlayMode>(mode);
  modeRef.current = mode;
  const currentRef = useRef(current);
  currentRef.current = current;
  const playingRef = useRef(false);
  // Media3 plays outside the DOM on Android: let the practice clock see continuous play.
  useEffect(() => {
    const probe = () => playingRef.current;
    setPlayingProbe(probe);
    return () => clearPlayingProbe(probe);
  }, []);
  const onActiveRef = useRef(onActiveLine);
  onActiveRef.current = onActiveLine;
  const pending = useRef<{ i: number; mode: ReadPlayMode } | null>(null);

  const reportActive = useCallback((i: number) => {
    if (i < 0 || i >= linesRef.current.length) return;
    if (currentRef.current !== i) {
      currentRef.current = i;
      setCurrent(i);
      onActiveRef.current?.(i);
    }
  }, []);

  const startPlay = useCallback((i: number, playMode: ReadPlayMode) => {
    const eng = engine.current;
    const line = linesRef.current[i];
    if (!eng || !line) return;
    currentRef.current = i;
    setCurrent(i);
    onActiveRef.current?.(i);
    // seek clears holdTo on both engines: seek, then hold, then play (Android runs them in order,
    // so the stop is set before Media3 starts moving).
    eng.seek(Math.max(0, line.startTime), false);
    eng.holdAt(playMode === 'single' ? line.endTime : null);
    eng.play();
  }, []);

  const path = record.videoPath ?? '';
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setErrorCode('');
    setPlaying(false);
    playingRef.current = false;

    const eng = createAudioEngine({
      onState: st => {
        if (cancelled) return;
        playingRef.current = st.playing;
        setPlaying(st.playing);
        if (st.playing && modeRef.current === 'continuous' && linesRef.current.length > 0) {
          const idx = lineAt(linesRef.current, st.time);
          if (idx >= 0 && idx !== currentRef.current) {
            reportActive(idx);
          }
        }
      },
      onLoaded: () => {
        if (cancelled) return;
        setReady(true);
        const p = pending.current;
        pending.current = null;
        if (p) startPlay(p.i, p.mode);
      },
      onHoldEnd: () => {
        if (cancelled) return;
        playingRef.current = false;
        setPlaying(false);
      },
      onEnded: () => {
        if (cancelled) return;
        playingRef.current = false;
        setPlaying(false);
      },
      onError: code => {
        if (!cancelled) setErrorCode(code);
      },
    });
    engine.current = eng;
    if (audio.current) eng.attachElement(audio.current);

    if (!path) {
      setErrorCode('audio:missing');
      return () => {
        cancelled = true;
        eng.dispose();
        if (engine.current === eng) engine.current = null;
      };
    }

    const cues: EngineCue[] = linesRef.current.map(l => ({
      id: l.id,
      startMs: Math.round(l.startTime * 1000),
      endMs: Math.round(l.endTime * 1000),
      text: l.text,
    }));
    resolveAudioSource(path).then(
      source => {
        if (cancelled) return;
        return eng.load({
          source,
          mediaId: record.id,
          title: record.displayName,
          artist: record.podcast?.show ?? '',
          artworkUri: record.podcast?.image ?? '',
          startSec: linesRef.current[Math.max(0, currentRef.current)]?.startTime ?? 0,
          autoPlay: false,
          rate: 1,
          cues,
          stopsSec: [],
        });
      },
      (e: unknown) => {
        if (!cancelled) setErrorCode(e instanceof Error ? e.message : String(e));
      },
    );

    return () => {
      cancelled = true;
      if (AUDIO_ENGINE_PLATFORM === 'android') eng.pause();
      eng.dispose();
      if (engine.current === eng) engine.current = null;
    };
  }, [record.id, path, reportActive, startPlay]); // eslint-disable-line react-hooks/exhaustive-deps

  const bindAudio = useCallback((el: HTMLAudioElement | null) => {
    audio.current = el;
    engine.current?.attachElement(el);
  }, []);

  const playLine = useCallback((i: number, overrideMode?: ReadPlayMode) => {
    if (i < 0 || i >= linesRef.current.length) return;
    const m = overrideMode ?? modeRef.current;
    currentRef.current = i;
    setCurrent(i);
    onActiveRef.current?.(i);
    if (!engine.current || !ready) {
      pending.current = { i, mode: m };
      return;
    }
    startPlay(i, m);
  }, [ready, startPlay]);

  const focusLine = useCallback((i: number) => {
    if (i < 0 || i >= linesRef.current.length) return;
    currentRef.current = i;
    setCurrent(i);
    onActiveRef.current?.(i);
  }, []);

  const pause = useCallback(() => {
    pending.current = null;
    engine.current?.pause();
  }, []);

  const toggle = useCallback(() => {
    if (playingRef.current) {
      pause();
      return;
    }
    const idx = currentRef.current >= 0 ? currentRef.current : 0;
    playLine(idx);
  }, [pause, playLine]);

  const setRate = useCallback((r: number) => {
    setRateState(r);
    engine.current?.setRate(r);
  }, []);

  const setMode = useCallback((m: ReadPlayMode) => {
    modeRef.current = m;
    setModeState(m);
    const eng = engine.current;
    if (!eng || !playingRef.current) return;
    const curLine = linesRef.current[currentRef.current];
    eng.holdAt(m === 'single' && curLine ? curLine.endTime : null);
  }, []);

  return { bindAudio, ready, errorCode, playing, rate, mode, current, setRate, setMode, playLine, focusLine, pause, toggle };
}

export const ReaderAudio: React.FC<{ player: ReaderPlayer }> = ({ player }) =>
  AUDIO_ENGINE_PLATFORM === 'web' ? React.createElement('audio', { ref: player.bindAudio, preload: 'auto' }) : null;
