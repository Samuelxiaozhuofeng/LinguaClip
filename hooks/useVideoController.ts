import { useRef, useState } from 'react';
import { PracticeMode, Subtitle, VideoSection, LearningMode, BlurPlaybackMode } from '../types';
import { useVideoPlayer } from './useVideoPlayer';

export interface UseVideoControllerParams {
  subtitles: Subtitle[];
  currentSubtitleIndex: number;
  mode: PracticeMode;
  shouldAutoAdvance: boolean;
  learningMode?: LearningMode;
  blurPlaybackMode?: BlurPlaybackMode;
  watch?: Set<number> | null;
  jumpGaps?: boolean;
  onModeChange?: (mode: PracticeMode) => void;
  onAutoAdvance?: () => void;
  onShouldAutoAdvanceChange?: (value: boolean) => void;
  loopOk?: () => boolean;
}

export interface UseVideoControllerReturn {
  // Video Element
  videoRef: React.RefObject<HTMLVideoElement>;
  videoSrc: string | null;
  setVideoSrc: (src: string | null) => void;
  
  // Playback State (from useVideoPlayer)
  isPlaying: boolean;
  volume: number;
  playbackSpeed: number;
  progress: number;
  
  // Playback Controls
  setIsPlaying: (value: boolean) => void;
  setVolume: (value: number) => void;
  setPlaybackSpeed: (value: number) => void;
  setProgress: (value: number) => void;
  togglePlay: () => void;
  handleProgressSeek: (e: React.ChangeEvent<HTMLInputElement>, sections: VideoSection[], currentSectionIndex: number, onSectionChange: (sectionIndex: number, subIndex: number) => void) => void;
  handleReplayCurrent: (autoAdvanceAfter?: boolean, fromRatio?: number, toRatio?: number) => void;
}

export function useVideoController(params: UseVideoControllerParams): UseVideoControllerReturn {
  const {
    subtitles,
    currentSubtitleIndex,
    mode,
    shouldAutoAdvance,
    learningMode,
    blurPlaybackMode,
    watch,
    jumpGaps,
    onModeChange,
    onAutoAdvance,
    onShouldAutoAdvanceChange,
    loopOk
  } = params;

  // Create video ref internally
  const videoRef = useRef<HTMLVideoElement>(null);

  // Manage video source
  const [videoSrc, setVideoSrc] = useState<string | null>(null);

  // Use the video player hook
  const {
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
  } = useVideoPlayer({
    videoRef,
    subtitles,
    currentSubtitleIndex,
    mode,
    shouldAutoAdvance,
    learningMode,
    blurPlaybackMode,
    watch,
    jumpGaps,
    onModeChange,
    onAutoAdvance,
    onShouldAutoAdvanceChange,
    loopOk
  });

  return {
    // Video Element
    videoRef,
    videoSrc,
    setVideoSrc,
    
    // Playback State
    isPlaying,
    volume,
    playbackSpeed,
    progress,
    
    // Playback Controls
    setIsPlaying,
    setVolume,
    setPlaybackSpeed,
    setProgress,
    togglePlay,
    handleProgressSeek,
    handleReplayCurrent
  };
}

