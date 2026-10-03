import { useState, useRef, useEffect, useCallback } from 'react';
import { Subtitle, PracticeMode, LearningMode, BlurPlaybackMode } from '../types';
import { playSpan } from '../utils/wordTimes';
import { loopMore, pageLoopHeld, LOOP_GAP_MS } from '../utils/loop';

export interface UseVideoPlayerParams {
  videoRef: React.RefObject<HTMLVideoElement>;
  subtitles: Subtitle[];
  currentSubtitleIndex: number;
  mode: PracticeMode;
  shouldAutoAdvance: boolean;
  learningMode?: LearningMode;
  blurPlaybackMode?: BlurPlaybackMode;
  // Custom practice: ids of lines only watched (play on, no stop, no input), and
  // whether lines left out of the session are jumped over even while playing on.
  watch?: Set<number> | null;
  jumpGaps?: boolean;
  onSubtitleEnded?: () => void;
  onModeChange?: (mode: PracticeMode) => void;
  onAutoAdvance?: () => void;
  onShouldAutoAdvanceChange?: (value: boolean) => void;
  loopOk?: () => boolean; // false while something else owns playback (breakdown, Anki recording)
}

export interface UseVideoPlayerReturn {
  isPlaying: boolean;
  volume: number;
  playbackSpeed: number;
  progress: number;
  setIsPlaying: (value: boolean) => void;
  setVolume: (value: number) => void;
  setPlaybackSpeed: (value: number) => void;
  setProgress: (value: number) => void;
  togglePlay: () => void;
  handleProgressSeek: (e: React.ChangeEvent<HTMLInputElement>, sections: any[], currentSectionIndex: number, onSectionChange: (index: number, subIndex: number) => void) => void;
  handleReplayCurrent: (autoAdvanceAfter?: boolean, fromRatio?: number, toRatio?: number) => void;
}

export function useVideoPlayer(params: UseVideoPlayerParams): UseVideoPlayerReturn {
  const {
    videoRef,
    subtitles,
    currentSubtitleIndex,
    mode,
    shouldAutoAdvance,
    learningMode = LearningMode.DICTATION,
    blurPlaybackMode = BlurPlaybackMode.SENTENCE_BY_SENTENCE,
    watch = null,
    jumpGaps = false,
    onSubtitleEnded,
    onModeChange,
    onAutoAdvance,
    onShouldAutoAdvanceChange,
    loopOk
  } = params;

  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(1);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [progress, setProgress] = useState(0);
  const requestRef = useRef<number | undefined>(undefined);
  const blurAutoAdvanceRef = useRef(false);
  const userPausedRef = useRef(false); // Track if user manually paused in continuous mode
  const flowRef = useRef(false); // the last line was only watched: play straight on into this one
  // "Play just this word": pause here, not at the line's end. Any pause, seek or new line drops it.
  const stopAtRef = useRef<number | null>(null);
  useEffect(() => { if (!isPlaying) stopAtRef.current = null; }, [isPlaying]);

  // Line loop (docs/loop.md): full plays of this line so far, and the pending replay.
  const playsRef = useRef(0);
  const loopTimer = useRef<number | null>(null);
  const clearLoop = () => { if (loopTimer.current) window.clearTimeout(loopTimer.current); loopTimer.current = null; };
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const loopOkRef = useRef(loopOk);
  loopOkRef.current = loopOk;
  const playLineRef = useRef<() => void>(() => {});
  // Stopped at the line's end (counted) or after a one-word play: replay the line in a moment.
  // Checked again when it fires, so a play, a new line, a submit or turning it off meanwhile wins.
  const scheduleLoop = (counted: boolean) => {
    if (counted) playsRef.current++;
    clearLoop();
    const ok = () => loopMore(playsRef.current) && !pageLoopHeld() && modeRef.current !== PracticeMode.FEEDBACK && (loopOkRef.current?.() ?? true);
    if (!ok()) return;
    loopTimer.current = window.setTimeout(() => {
      loopTimer.current = null;
      if (videoRef.current?.paused && ok()) playLineRef.current();
    }, LOOP_GAP_MS);
  };
  useEffect(() => { playsRef.current = 0; clearLoop(); }, [currentSubtitleIndex, subtitles]);
  useEffect(() => clearLoop, []);

  // A new line list (next section, next custom set) counts as a new line even
  // when the index stays 0, or a one-line set would never advance.
  useEffect(() => {
    blurAutoAdvanceRef.current = false;
    // Reset user pause state when subtitle changes
    userPausedRef.current = false;
  }, [currentSubtitleIndex, subtitles, learningMode, blurPlaybackMode]);

  // Checks whether the current line has ended; runs every frame and on `timeupdate`
  // (rAF is throttled in background tabs, timeupdate keeps firing).
  const checkVideoTime = useCallback(() => {
    if (!videoRef.current || subtitles.length === 0) return;
    
    const video = videoRef.current;
    const currentSub = subtitles[currentSubtitleIndex];
    
    if (!currentSub) return;

    const isBlurContinuous = learningMode === LearningMode.BLUR && blurPlaybackMode === BlurPlaybackMode.CONTINUOUS;
    const watching = !!watch?.has(currentSub.id);

    if (isPlaying && stopAtRef.current !== null && video.currentTime >= stopAtRef.current) {
      stopAtRef.current = null;
      video.pause();
      setIsPlaying(false);
      if (!shouldAutoAdvance) scheduleLoop(false);
    } else if (isPlaying) {
      if (video.currentTime >= currentSub.endTime) {
        if (isBlurContinuous || watching) {
          if (!blurAutoAdvanceRef.current) {
            blurAutoAdvanceRef.current = true;
            flowRef.current = watching;
            onAutoAdvance?.();
          }
        } else if (!video.paused) {
          // rAF and the timeupdate our own seek fires can both land here before
          // React re-renders; the first one pauses, so paused = already handled
          // (else an auto-advance fires twice and skips a line).
          video.pause();
          setIsPlaying(false);
          video.currentTime = currentSub.endTime;

          if (!shouldAutoAdvance) scheduleLoop(true);
          if (learningMode === LearningMode.BLUR) {
            // Sentence-by-sentence mode waits for user action between lines.
          } else {
            if (mode === PracticeMode.LISTENING) {
              onModeChange?.(PracticeMode.INPUT);
            } else if (shouldAutoAdvance) {
              onShouldAutoAdvanceChange?.(false);
              onAutoAdvance?.();
            }
          }
        }
      }
    }
    
    if (video.duration) {
      setProgress((video.currentTime / video.duration) * 100);
    }
  }, [
    subtitles,
    currentSubtitleIndex,
    mode,
    isPlaying,
    shouldAutoAdvance,
    learningMode,
    blurPlaybackMode,
    watch,
    onModeChange,
    onAutoAdvance,
    onShouldAutoAdvanceChange,
    videoRef
  ]);

  useEffect(() => {
    const loop = () => { checkVideoTime(); requestRef.current = requestAnimationFrame(loop); };
    requestRef.current = requestAnimationFrame(loop);
    const video = videoRef.current;
    video?.addEventListener('timeupdate', checkVideoTime);
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
      video?.removeEventListener('timeupdate', checkVideoTime);
    };
  }, [checkVideoTime, videoRef]);

  // Volume and speed apart: a volume change while an Anki clip records at 1× must not put the speed back.
  useEffect(() => { if (videoRef.current) videoRef.current.volume = volume; }, [volume, videoRef]);
  useEffect(() => { if (videoRef.current) videoRef.current.playbackRate = playbackSpeed; }, [playbackSpeed, videoRef]);

  // Seek + autoplay when the line changes. Deliberately not keyed on isPlaying:
  // otherwise the end-of-line pause flips isPlaying and this would restart the video.
  const isPlayingRef = useRef(isPlaying);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);

  useEffect(() => {
    const video = videoRef.current;
    const currentSub = subtitles[currentSubtitleIndex];
    if (!video || !currentSub || mode !== PracticeMode.LISTENING) return;
    const isBlurContinuous = learningMode === LearningMode.BLUR && blurPlaybackMode === BlurPlaybackMode.CONTINUOUS;
    const playing = isPlayingRef.current;
    const flowing = flowRef.current;
    flowRef.current = false;
    stopAtRef.current = null;

    const tolerance = 0.5;
    const early = video.currentTime < currentSub.startTime - tolerance;
    const shouldForceSeek = !((isBlurContinuous || flowing) && playing) || (jumpGaps && early);
    if (shouldForceSeek && (early || video.currentTime > currentSub.endTime)) {
      video.currentTime = currentSub.startTime;
    }

    if (playing) return;
    // Continuous mode respects a manual pause; every other mode plays the new line.
    if (isBlurContinuous && userPausedRef.current) return;
    setIsPlaying(true);
    video.play().catch(e => { console.error("Autoplay blocked", e); setIsPlaying(false); });
  }, [currentSubtitleIndex, subtitles, mode, videoRef, learningMode, blurPlaybackMode, jumpGaps]);

  // fromRatio / toRatio: where in the line to start and stop (0..1), for "play
  // from this word" and "play just this word"; without toRatio the line plays to its end.
  const handleReplayCurrent = useCallback((autoAdvanceAfter: boolean = false, fromRatio: number = 0, toRatio?: number, fromLoop = false) => {
    const sub = subtitles[currentSubtitleIndex];
    clearLoop();
    if (!fromLoop && fromRatio === 0 && toRatio === undefined) playsRef.current = 0; // a manual replay counts afresh
    if (videoRef.current && sub) {
      const [from, to] = playSpan(sub.startTime, sub.endTime, fromRatio, toRatio);
      videoRef.current.currentTime = from;
      stopAtRef.current = toRatio === undefined ? null : to;
      setIsPlaying(true);
      videoRef.current.play().catch(e => { console.error("Play blocked", e); setIsPlaying(false); });
      onShouldAutoAdvanceChange?.(autoAdvanceAfter);
    }
  }, [subtitles, currentSubtitleIndex, videoRef, onShouldAutoAdvanceChange]);
  playLineRef.current = () => handleReplayCurrent(false, 0, undefined, true);

  const togglePlay = useCallback(() => {
    if (!videoRef.current) return;

    const isBlurContinuous = learningMode === LearningMode.BLUR && blurPlaybackMode === BlurPlaybackMode.CONTINUOUS;

    clearLoop();
    if (isPlaying) {
      videoRef.current.pause();
      setIsPlaying(false);
      // Mark that user manually paused in continuous mode
      if (isBlurContinuous) {
        userPausedRef.current = true;
      }
    } else {
      const sub = subtitles[currentSubtitleIndex];
      const atLineEnd = !!sub && videoRef.current.currentTime >= sub.endTime - 0.05;
      if (mode === PracticeMode.INPUT || mode === PracticeMode.FEEDBACK || atLineEnd) {
        handleReplayCurrent();
      } else {
        stopAtRef.current = null;
        setIsPlaying(true);
        videoRef.current.play().catch(e => { console.error("Play failed", e); setIsPlaying(false); });
        // Clear user pause flag when resuming
        if (isBlurContinuous) {
          userPausedRef.current = false;
        }
      }
    }
  }, [isPlaying, mode, videoRef, handleReplayCurrent, learningMode, blurPlaybackMode, subtitles, currentSubtitleIndex]);

  const handleProgressSeek = useCallback((
    e: React.ChangeEvent<HTMLInputElement>,
    sections: any[],
    currentSectionIndex: number,
    onSectionChange: (sectionIndex: number, subIndex: number) => void
  ) => {
    if (videoRef.current && videoRef.current.duration) {
      const newTime = (Number(e.target.value) / 100) * videoRef.current.duration;
      stopAtRef.current = null;
      clearLoop();
      videoRef.current.currentTime = newTime;
      setProgress(Number(e.target.value));
      
      const targetSectionIndex = sections.findIndex(s => newTime >= s.startTime && newTime < s.endTime);
      
      if (targetSectionIndex !== -1) {
        if (targetSectionIndex !== currentSectionIndex) {
          const newSection = sections[targetSectionIndex];
          const subIndex = newSection.subtitles.findIndex((s: Subtitle) => newTime >= s.startTime && newTime <= s.endTime);
          onSectionChange(targetSectionIndex, subIndex !== -1 ? subIndex : 0);
        } else {
          const subIndex = subtitles.findIndex(s => newTime >= s.startTime && newTime <= s.endTime);
          if (subIndex !== -1) {
            onSectionChange(currentSectionIndex, subIndex);
          }
        }
      }
    }
  }, [videoRef, subtitles]);

  return {
    isPlaying,
    volume,
    playbackSpeed,
    progress,
    setIsPlaying,
    setVolume,
    setPlaybackSpeed,
    setProgress,
    togglePlay,
    handleProgressSeek,
    handleReplayCurrent
  };
}
