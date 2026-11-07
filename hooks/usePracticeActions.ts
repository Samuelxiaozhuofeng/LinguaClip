import React, { useCallback } from 'react';
import { PracticeMode, Subtitle, VideoSection } from '../types';

export interface UsePracticeActionsParams {
  // State
  subtitles: Subtitle[];
  fullSubtitles: Subtitle[];
  currentSubtitleIndex: number;
  sections: VideoSection[];
  currentSectionIndex: number;
  mode: PracticeMode;
  ankiStatus: string;

  // Setters
  setCurrentSubtitleIndex: (index: number | ((prev: number) => number)) => void;
  setCurrentSectionIndex: (index: number) => void;
  setMode: (mode: PracticeMode) => void;
  setAnkiStatus: (status: string) => void;
  setSubtitles: (subs: Subtitle[]) => void;
  setShowSavedList: (show: boolean) => void;

  // Other dependencies
  videoRef: React.RefObject<HTMLVideoElement>;
  setIsPlaying: (playing: boolean) => void;
  switchSection: (index: number, videoRef?: React.RefObject<HTMLVideoElement>, setIsPlaying?: (value: boolean) => void) => void;
  savedLinesToggleSave: (sub: Subtitle) => void;
  savedLinesDeleteSavedItem: (id: number, e: React.MouseEvent) => void;
  ankiHandleAddToAnki: (sub: Subtitle) => Promise<void>;
  ankiHandleWordToAnki: (word: string, definition: string, sub: Subtitle, example?: string) => Promise<void>;

  // Practice session actions
  practiceHandleContinue: (
    onSectionComplete: () => void,
    onPracticeComplete: () => void,
    onAnkiStatusChange: (status: string) => void,
    count?: boolean,
  ) => void;
  handleNextSection: (videoRef?: React.RefObject<HTMLVideoElement>, setIsPlaying?: (value: boolean) => void) => void;

  // Fired when the last line of the last section is done
  onPracticeComplete: () => void;

  // Video controller dependency
  videoPlayerHandleProgressSeek: (
    e: React.ChangeEvent<HTMLInputElement>,
    sections: VideoSection[],
    currentSectionIndex: number,
    onSeekComplete: (sectionIndex: number, subIndex: number) => void
  ) => void;
}

export function usePracticeActions(params: UsePracticeActionsParams) {
  const {
    subtitles,
    fullSubtitles,
    currentSubtitleIndex,
    sections,
    currentSectionIndex,
    ankiStatus,
    setCurrentSubtitleIndex,
    setCurrentSectionIndex,
    setMode,
    setAnkiStatus,
    setSubtitles,
    setShowSavedList,
    videoRef,
    setIsPlaying,
    switchSection,
    savedLinesToggleSave,
    savedLinesDeleteSavedItem,
    ankiHandleAddToAnki,
    ankiHandleWordToAnki,
    practiceHandleContinue,
    handleNextSection,
    onPracticeComplete,
    videoPlayerHandleProgressSeek,
  } = params;

  const handleSkip = useCallback((direction: 'prev' | 'next') => {
    if (direction === 'prev' && currentSubtitleIndex > 0) {
      setCurrentSubtitleIndex(prev => (typeof prev === 'number' ? prev - 1 : currentSubtitleIndex - 1));
      setMode(PracticeMode.LISTENING);
      setAnkiStatus('idle');
    } else if (direction === 'next' && currentSubtitleIndex < subtitles.length - 1) {
      setCurrentSubtitleIndex(prev => (typeof prev === 'number' ? prev + 1 : currentSubtitleIndex + 1));
      setMode(PracticeMode.LISTENING);
      setAnkiStatus('idle');
    } else if (direction === 'next' && subtitles.length > 0) {
      // The section's last line: on to "section done" / "all done" like finishing it, but not counted (docs/shortcuts.md B2).
      practiceHandleContinue(() => {}, onPracticeComplete, (status: string) => setAnkiStatus(status as any), false);
    }
  }, [currentSubtitleIndex, subtitles.length, setCurrentSubtitleIndex, setMode, setAnkiStatus, practiceHandleContinue, onPracticeComplete]);

  const handleProgressSeek = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    videoPlayerHandleProgressSeek(e, sections, currentSectionIndex, (sectionIndex, subIndex) => {
      if (sectionIndex !== currentSectionIndex) {
        const newSection = sections[sectionIndex];
        setCurrentSectionIndex(sectionIndex);
        setSubtitles(newSection.subtitles);
        setCurrentSubtitleIndex(subIndex);
      } else {
        setCurrentSubtitleIndex(subIndex);
      }
      setMode(PracticeMode.LISTENING);
      setAnkiStatus('idle');
    });
  }, [
    videoPlayerHandleProgressSeek,
    sections,
    currentSectionIndex,
    setCurrentSectionIndex,
    setSubtitles,
    setCurrentSubtitleIndex,
    setMode,
    setAnkiStatus
  ]);

  const toggleSaveCurrent = useCallback(() => {
    const currentSub = subtitles[currentSubtitleIndex];
    if (!currentSub) return;
    savedLinesToggleSave(currentSub);
  }, [subtitles, currentSubtitleIndex, savedLinesToggleSave]);

  const handleAddToAnki = useCallback(async () => {
    const currentSub = subtitles[currentSubtitleIndex];
    if (!currentSub) return;
    // Pause first: the clip plays past the line's end, where "playing" would pause or advance it.
    videoRef.current?.pause();
    setIsPlaying(false);
    await ankiHandleAddToAnki(currentSub);
  }, [subtitles, currentSubtitleIndex, ankiHandleAddToAnki, videoRef, setIsPlaying]);

  const handleWordToAnki = useCallback(async (word: string, definition: string, example?: string) => {
    const currentSub = subtitles[currentSubtitleIndex];
    if (!currentSub) return;
    videoRef.current?.pause();
    setIsPlaying(false);
    await ankiHandleWordToAnki(word, definition, currentSub, example);
  }, [subtitles, currentSubtitleIndex, ankiHandleWordToAnki, videoRef, setIsPlaying]);

  const deleteSavedItem = useCallback((id: number, e: React.MouseEvent) => {
    savedLinesDeleteSavedItem(id, e);
  }, [savedLinesDeleteSavedItem]);

  const jumpToSaved = useCallback((id: number) => {
    const sub = fullSubtitles.find(s => s.id === id);
    if (!sub) return;

    const sectionIdx = sections.findIndex(sec => sub.startTime >= sec.startTime && sub.startTime < sec.endTime);
    if (sectionIdx === -1) return;

    if (sectionIdx !== currentSectionIndex) {
      switchSection(sectionIdx, videoRef, setIsPlaying);
      const newSectionSubs = sections[sectionIdx].subtitles;
      const subIndex = newSectionSubs.findIndex(s => s.id === id);
      if (subIndex !== -1) setCurrentSubtitleIndex(subIndex);
    } else {
      const subIndex = subtitles.findIndex(s => s.id === id);
      if (subIndex !== -1) setCurrentSubtitleIndex(subIndex);
    }

    setMode(PracticeMode.LISTENING);
    setAnkiStatus('idle');
    setShowSavedList(false);
  }, [
    fullSubtitles,
    sections,
    currentSectionIndex,
    switchSection,
    videoRef,
    setIsPlaying,
    subtitles,
    setCurrentSubtitleIndex,
    setMode,
    setAnkiStatus,
    setShowSavedList
  ]);

  const handleInputComplete = useCallback((wasCorrect: boolean) => {
    setMode(PracticeMode.FEEDBACK);
  }, [setMode]);

  const handleContinue = useCallback(() => {
    practiceHandleContinue(
      () => {
        // section complete already handled by setShowSectionComplete in session hook
      },
      onPracticeComplete,
      (status: string) => setAnkiStatus(status as any)
    );
  }, [practiceHandleContinue, onPracticeComplete, setAnkiStatus]);

  const handleNextSectionClick = useCallback(() => {
    handleNextSection(videoRef, setIsPlaying);
  }, [handleNextSection, videoRef, setIsPlaying]);

  const handleAddToAnkiShortcut = useCallback((event: KeyboardEvent) => {
    // This handler expects caller to ensure practice mode and app state if needed
    if (!subtitles[currentSubtitleIndex] || ankiStatus !== 'idle') return;

    event.preventDefault();
    handleAddToAnki();
  }, [subtitles, currentSubtitleIndex, ankiStatus, handleAddToAnki]);

  return {
    handleSkip,
    toggleSaveCurrent,
    handleAddToAnki,
    handleWordToAnki,
    deleteSavedItem,
    jumpToSaved,
    handleProgressSeek,
    handleInputComplete,
    handleContinue,
    handleNextSectionClick,
    handleAddToAnkiShortcut,
  };
}
