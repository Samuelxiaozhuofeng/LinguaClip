import React, { createContext, useContext } from 'react';
import { PracticeMode, Subtitle, VideoRecord, VideoSection, AnkiConfig, LearningMode, BlurPlaybackMode } from '../types';
import type { DictLang } from '../utils/dictionary';
import type { StudyWay } from '../utils/studyWays';

export interface PracticeContextPractice {
  videoId: string | null;
  subtitles: Subtitle[];
  fullSubtitles: Subtitle[];
  sections: VideoSection[];
  currentSectionIndex: number;
  currentSubtitleIndex: number;
  mode: PracticeMode;
  showSectionComplete: boolean;
  showComplete: boolean;
  learningMode: LearningMode;
  blurPlaybackMode: BlurPlaybackMode;
  videoName: string;
  videoLang?: DictLang;
  watch: Set<number> | null; // custom set: ids of lines only watched; null = section by section
  practiceRecord?: Pick<VideoRecord, 'podcast' | 'videoPath' | 'videoFileName'> | null;
  hasReader?: boolean;
  hasListen?: boolean;
}

export interface PracticeContextVideo {
  videoRef: React.RefObject<HTMLVideoElement>;
  videoSrc: string | null;
  isPlaying: boolean;
  volume: number;
  playbackSpeed: number;
  slowReplay?: boolean;
  progress: number;
}

export interface PracticeContextSaved {
  savedIds: Set<number>;
  showSavedList: boolean;
  savedItems: Subtitle[];
  isCurrentSaved: boolean;
}

export interface PracticeContextAnki {
  ankiConfig: AnkiConfig | null;
  ankiStatus: 'idle' | 'recording' | 'adding' | 'success' | 'error';
}

export interface PracticeContextActions {
  onExit: () => void;
  onRestart: () => void;
  onNextSet: () => void;
  onSwitchSection: (index: number) => void;
  onToggleSavedList: (show: boolean) => void;
  onTogglePlay: () => void;
  onReplayCurrent: (autoAdvanceAfter?: boolean, fromRatio?: number, toRatio?: number, fromLoop?: boolean) => void;
  onToggleLoop: () => void;
  onSetStepReplay: (play: (() => void) | null) => void; // non-null: replays call this instead
  onSkip: (direction: 'prev' | 'next') => void;
  onProgressSeek: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onToggleSaveCurrent: () => void;
  onAddToAnki: () => void;
  onWordToAnki: (word: string, definition: string, example?: string) => void | Promise<void>;
  onNextSection: () => void;
  onStopAfterSection: () => void;
  onSetShowSectionComplete: (show: boolean) => void;
  onSetVolume: (volume: number) => void;
  onSetPlaybackSpeed: (speed: number) => void;
  onInputComplete: (wasCorrect: boolean) => void;
  onStartInput?: () => void;
  onContinue: () => void;
  onDeleteSavedItem: (id: number, e: React.MouseEvent) => void;
  onJumpToSaved: (id: number) => void;
  onSetBlurPlaybackMode: (mode: BlurPlaybackMode) => void;
  onSwitchWay?: (way: StudyWay) => void;
}

export interface PracticeContextValue {
  practice: PracticeContextPractice;
  video: PracticeContextVideo;
  saved: PracticeContextSaved;
  anki: PracticeContextAnki;
  actions: PracticeContextActions;
}

const PracticeContext = createContext<PracticeContextValue | undefined>(undefined);

interface PracticeProviderProps extends PracticeContextValue {
  children: React.ReactNode;
}

export const PracticeProvider: React.FC<PracticeProviderProps> = (props) => {
  const { children, ...value } = props;
  return (
    <PracticeContext.Provider value={value}>
      {children}
    </PracticeContext.Provider>
  );
};

export const usePracticeContext = (): PracticeContextValue => {
  const ctx = useContext(PracticeContext);
  if (!ctx) {
    throw new Error('usePracticeContext must be used within a PracticeProvider');
  }
  return ctx;
};

