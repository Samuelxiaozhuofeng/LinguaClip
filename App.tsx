import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { AppState, PracticeMode, VideoRecord, LearningMode, BlurPlaybackMode } from './types';
import ReviewPage from './components/ReviewPage';
import Settings from './components/Settings';
import Home from './components/Home';
import Shell from './components/Shell';
import Studio from './components/Studio';
import WatchPage from './components/WatchPage';
import CustomPanel, { PanelChoice, nextPick, paceOf } from './components/CustomPanel';
import { Reader } from '@pro';
import type { ReadBy } from './utils/storage';
import { DialogHost, dialog } from './components/Dialog';
import { PracticeProvider } from './hooks/usePracticeContext';
import { useVideoHistory } from './hooks/useVideoHistory';
import { usePracticeSession } from './hooks/usePracticeSession';
import { useAnkiIntegration } from './hooks/useAnkiIntegration';
import { useSavedLines } from './hooks/useSavedLines';
import { useVideoController } from './hooks/useVideoController';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { usePracticeActions } from './hooks/usePracticeActions';
import * as VideoStorage from './utils/videoStorage';
import { fileNameFromPath, pathExists, pickVideoPath, videoSrcFromPath } from './utils/desktop';
import { parseSRT } from './utils/srtParser';
import { t, useLang } from './utils/i18n';
import { markInterruptedJobs, startImportListener } from './utils/importJob';
import { matches } from './utils/shortcuts';
import { countLine } from './utils/today';
import { deleteCards, keepOrphans, orphanCards } from './utils/review';
import { startClips } from './utils/clips';
import { CustomConfig, CustomPick } from './utils/customPick';
import { setCustomPos } from './utils/storage';

let orphansAsked = false; // StrictMode runs effects twice in dev
async function askAboutOrphans() {
  if (orphansAsked) return;
  orphansAsked = true;
  const cards = await orphanCards();
  if (!cards.length) return;
  const names = [...new Set(cards.map(c => c.videoName))];
  const ok = await dialog.confirm(
    t('app.orphansTitle', { n: cards.length }),
    t('app.orphansBody', { names: names.slice(0, 3).join(' · ') + (names.length > 3 ? ' …' : '') }),
    { ok: t('app.orphansOk'), cancel: t('app.orphansKeep'), danger: true },
  );
  if (ok) await deleteCards(cards.map(c => c.id));
  else if (ok === false) keepOrphans(cards.map(c => c.id)); // dismissed: ask again next launch
}

export default function App() {
  const lang = useLang();
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);

  // Cards left by videos deleted in older versions: ask once whether they go too.
  useEffect(() => { askAboutOrphans().catch(console.error); }, []);

  // Cards' own clips: fill in what's missing, now and after card changes (utils/clips.ts).
  useEffect(() => startClips(), []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      try {
        await markInterruptedJobs();
      } catch (err) {
        console.error(err);
      }
      try {
        const fn = await startImportListener();
        if (cancelled) fn();
        else unlisten = fn;
      } catch (err) {
        console.error(err);
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const [appState, setAppState] = useState<AppState>(AppState.UPLOAD);
  const [homeEmpty, setHomeEmpty] = useState(false); // no videos yet: the top bar drops its add button
  const [addAsked, setAddAsked] = useState(false); // the top bar's "+": Home opens its add dialog
  const [videoFileName, setVideoFileName] = useState<string | null>(null);
  const [learningMode, setLearningMode] = useState<LearningMode>(LearningMode.DICTATION);
  const [blurPlaybackMode, setBlurPlaybackModeState] = useState<BlurPlaybackMode>(BlurPlaybackMode.SENTENCE_BY_SENTENCE);
  const [showComplete, setShowComplete] = useState(false);
  // The start-of-practice panel, and the custom set being practised (null = section by section).
  const [panel, setPanel] = useState<{ record: VideoRecord; lm: LearningMode; read?: number } | null>(null);
  type CustomSession = { record: VideoRecord; lm: LearningMode; cfg: CustomConfig; watch: Set<number>; end: number };
  const [custom, setCustom] = useState<CustomSession | null>(null);
  const [watching, setWatching] = useState<VideoRecord | null>(null); // watch mode's video, its path checked
  const [reading, setReading] = useState<{ record: VideoRecord; lm: LearningMode; by: ReadBy } | null>(null); // the reader's, likewise
  const customRef = useRef<CustomSession | null>(null);
  // Every write of the record's section progress goes through here, so a custom
  // set can never move the shelf's "part 3 of 12" or where "continue" lands.
  const saveProgress = useCallback((id: string, subIndex: number, sectionIndex: number, done?: number) => {
    if (!customRef.current) VideoStorage.updateProgress(id, subIndex, sectionIndex, done);
  }, []);

  const {
    currentVideoId, setCurrentVideoId, createVideoRecord,
    getSubtitleFileFromRecord,
  } = useVideoHistory();

  const {
    fullSubtitles, subtitles, sections, currentSectionIndex, currentSubtitleIndex, mode,
    showSectionComplete, shouldAutoAdvance,
    setSubtitles, setCurrentSectionIndex, setCurrentSubtitleIndex, setMode, setShowSectionComplete, setShouldAutoAdvance,
    switchSection, handleContinue: practiceHandleContinue, handleNextSection, initializePractice,
  } = usePracticeSession({ videoId: currentVideoId, appState });

  const {
    savedIds, showSavedList, savedItems, setShowSavedList,
    toggleSave: savedLinesToggleSave, deleteSavedItem: savedLinesDeleteSavedItem,
    isCurrentSaved: savedLinesIsCurrentSaved,
  } = useSavedLines({ videoId: currentVideoId, fullSubtitles, videoFileName });

  const finishPractice = useCallback(() => {
    setShowComplete(true);
    const c = customRef.current;
    if (c) setCustomPos(c.record.id, c.end);
    else if (currentVideoId) saveProgress(currentVideoId, fullSubtitles.length, currentSectionIndex);
  }, [currentVideoId, fullSubtitles.length, currentSectionIndex, saveProgress]);

  const {
    videoRef, videoSrc, setVideoSrc, isPlaying, volume, playbackSpeed, progress,
    setIsPlaying, setVolume, setPlaybackSpeed, togglePlay,
    handleProgressSeek: videoPlayerHandleProgressSeek, handleReplayCurrent,
  } = useVideoController({
    subtitles, currentSubtitleIndex, mode, shouldAutoAdvance, learningMode, blurPlaybackMode,
    watch: custom?.watch.size ? custom.watch : null,
    jumpGaps: !!custom && custom.cfg.others === 'skip',
    onModeChange: setMode,
    onAutoAdvance: () => {
      // Continuous blur play and watch-only lines roll past on their own; those aren't practised.
      const watched = !!custom?.watch.has(subtitles[currentSubtitleIndex]?.id);
      if (!watched && !(learningMode === LearningMode.BLUR && blurPlaybackMode === BlurPlaybackMode.CONTINUOUS)) countLine();
      if (currentSubtitleIndex < subtitles.length - 1) {
        setCurrentSubtitleIndex(prev => prev + 1);
        setMode(PracticeMode.LISTENING);
        setAnkiStatus('idle');
      } else if (currentSectionIndex < sections.length - 1) {
        setShowSectionComplete(true);
      } else {
        finishPractice();
      }
    },
    onShouldAutoAdvanceChange: setShouldAutoAdvance,
  });

  const {
    ankiConfig, ankiStatus, setAnkiStatus,
    handleAddToAnki: ankiHandleAddToAnki, handleWordToAnki: ankiHandleWordToAnki, reloadConfig: reloadAnkiConfig,
  } = useAnkiIntegration({ videoRef, videoFileName, videoId: currentVideoId });

  // Settings autosaves; pick the latest Anki config up whenever we leave that page.
  useEffect(() => {
    if (appState !== AppState.SETTINGS) reloadAnkiConfig();
  }, [appState, reloadAnkiConfig]);

  // Progress autosave (% is measured across the whole video, not just this section).
  // A custom set only remembers the line it is on, so quitting resumes there.
  useEffect(() => {
    if (!currentVideoId || appState !== AppState.PRACTICE || showComplete) return;
    if (customRef.current) {
      const sub = subtitles[currentSubtitleIndex];
      if (sub) setCustomPos(customRef.current.record.id, sub.startTime);
    } else if (currentSubtitleIndex > 0) {
      const before = sections.slice(0, currentSectionIndex).reduce((n, s) => n + s.subtitles.length, 0);
      saveProgress(currentVideoId, currentSubtitleIndex, currentSectionIndex, before + currentSubtitleIndex);
    }
  }, [currentSubtitleIndex, currentSectionIndex, currentVideoId, appState, showComplete, sections, subtitles, saveProgress]);

  // --- Starting a session ---

  const startPractice = async (
    videoName: string, videoPath: string, sf: File, lm: LearningMode, bpm: BlurPlaybackMode,
    startIndex?: number, startSectionIndex?: number, videoId?: string, pick?: number[], stale?: () => boolean,
  ) => {
    let subText: string;
    try {
      subText = await sf.text();
    } catch {
      dialog.alert(t('app.subtitleReadFailTitle'), t('app.subtitleReadFailBody'));
      return;
    }
    if (stale?.()) return;
    const result = initializePractice(subText, startIndex, startSectionIndex, pick);
    if (!result) {
      dialog.alert(t('app.noSubtitlesTitle'), t('app.noSubtitlesBody', { name: sf.name }));
      return;
    }

    setLearningMode(lm);
    setBlurPlaybackModeState(bpm);

    let recordId = videoId;
    if (!recordId) {
      try {
        const record = await createVideoRecord(videoName, sf, subText, result.parsed.length, { learningMode: lm, blurPlaybackMode: bpm, videoPath });
        recordId = record.id;
      } catch (error) {
        console.error('Failed to save video record:', error);
      }
    }

    setVideoFileName(videoName);
    setIsPlaying(false);
    setCurrentVideoId(recordId || null);
    setVideoSrc(videoSrcFromPath(videoPath));
    setShowComplete(false);
    setAppState(AppState.PRACTICE);
  };

  // Every way into practice lands here: ask how to practise first.
  const handleResume = (record: VideoRecord, lm: LearningMode) => {
    if (!record.importJob) setPanel({ record, lm });
  };

  // Only the latest start wins: two starts in quick succession must not mix one
  // video's lines with the other's custom session.
  const launchRef = useRef(0);
  const openPractice = async (record: VideoRecord, lm: LearningMode, choice: PanelChoice) => {
    const launch = ++launchRef.current;
    const stale = () => launchRef.current !== launch;
    try {
      let videoPath = record.videoPath;
      if (!videoPath || !(await pathExists(videoPath))) {
        const ok = await dialog.confirm(t('app.pickVideoTitle'), t('app.pickVideoBody', { name: record.videoFileName }), { ok: t('app.pickVideoOk') });
        if (!ok) return;
        const picked = await pickVideoPath();
        if (!picked) return;
        videoPath = picked;
        await VideoStorage.patchVideoRecord(record.id, { videoPath });
      }

      if (choice.kind === 'watch' || choice.kind === 'read') {
        if (stale()) return;
        if (parseSRT(record.subtitleText).length === 0) {
          dialog.alert(t('app.noSubtitlesTitle'), t('app.noSubtitlesBody', { name: record.videoFileName }));
          return;
        }
        // Reading comes before practice: the record is left as it is.
        if (choice.kind === 'read') {
          setReading({ record: { ...record, videoPath }, lm, by: choice.by });
          setAppState(AppState.READ);
          return;
        }
        // Watching moves the video up the shelf; its practice mode and progress stay.
        VideoStorage.patchVideoRecord(record.id, { lastPracticed: Date.now() }).catch(console.error);
        setWatching({ ...record, videoPath });
        setAppState(AppState.WATCH);
        return;
      }

      if (record.learningMode !== lm) await VideoStorage.patchVideoRecord(record.id, { learningMode: lm });
      if (stale()) return;
      const bpm = record.blurPlaybackMode ?? BlurPlaybackMode.SENTENCE_BY_SENTENCE;
      if (choice.kind === 'custom') {
        const { lines, practise } = choice.pick;
        const keep = new Set(practise);
        const subs = parseSRT(record.subtitleText);
        const session: CustomSession = {
          record: { ...record, videoPath }, lm, cfg: choice.cfg,
          watch: new Set(lines.filter(i => !keep.has(i)).map(i => subs[i].id)),
          end: subs[lines[lines.length - 1]].endTime,
        };
        customRef.current = session;
        setCustom(session);
        // The shelf's "last practised" moves; its section progress does not.
        VideoStorage.patchVideoRecord(record.id, { lastPracticed: Date.now() }).catch(console.error);
        await startPractice(record.videoFileName, videoPath, getSubtitleFileFromRecord(record), lm, bpm, 0, 0, record.id, lines, stale);
        return;
      }
      customRef.current = null;
      setCustom(null);
      const finished = record.completionRate >= 100;
      await startPractice(
        record.videoFileName, videoPath, getSubtitleFileFromRecord(record), lm, bpm,
        finished ? 0 : record.currentSubtitleIndex, finished ? 0 : record.currentSectionIndex, record.id, undefined, stale,
      );
    } catch (error) {
      console.error('Failed to continue from library:', error);
      dialog.alert(t('app.openVideoFailTitle'), t('app.openVideoFailBody'));
    }
  };

  const setBlurPlaybackMode = (bpm: BlurPlaybackMode) => {
    setBlurPlaybackModeState(bpm);
    if (currentVideoId) VideoStorage.patchVideoRecord(currentVideoId, { blurPlaybackMode: bpm });
  };

  const {
    handleSkip, toggleSaveCurrent, handleAddToAnki, handleWordToAnki, deleteSavedItem, jumpToSaved,
    handleProgressSeek, handleInputComplete, handleContinue, handleNextSectionClick, handleAddToAnkiShortcut,
  } = usePracticeActions({
    subtitles, fullSubtitles, currentSubtitleIndex, sections, currentSectionIndex, mode, ankiStatus,
    setCurrentSubtitleIndex, setCurrentSectionIndex, setMode, setAnkiStatus, setSubtitles, setShowSavedList,
    videoRef, setIsPlaying, switchSection,
    savedLinesToggleSave, savedLinesDeleteSavedItem, ankiHandleAddToAnki, ankiHandleWordToAnki,
    practiceHandleContinue, handleNextSection,
    onPracticeComplete: finishPractice,
    videoPlayerHandleProgressSeek,
  });

  // While "break it down" is on, every way of replaying (Shift+Space, Space,
  // the transport's replay button) plays the current step's clip instead.
  const stepReplayRef = useRef<(() => void) | null>(null);
  const setStepReplay = useCallback((play: (() => void) | null) => { stepReplayRef.current = play; }, []);
  const replayCurrent = useCallback((autoAdvanceAfter?: boolean, fromRatio?: number, toRatio?: number) => {
    if (stepReplayRef.current) stepReplayRef.current();
    else handleReplayCurrent(autoAdvanceAfter, fromRatio, toRatio);
  }, [handleReplayCurrent]);
  const togglePlayOrStep = useCallback(() => {
    if (stepReplayRef.current && !isPlaying) stepReplayRef.current();
    else togglePlay();
  }, [togglePlay, isPlaying]);

  const exitPractice = () => { setShowComplete(false); setAppState(AppState.UPLOAD); customRef.current = null; setCustom(null); };

  // "Next set" on the custom done overlay: same choices, from where this set ended.
  const nextSet = async () => {
    const c = customRef.current;
    if (!c) return;
    const pick = await nextPick(c.record, c.cfg, paceOf(c.lm, blurPlaybackMode));
    if (customRef.current !== c) return; // left the page meanwhile
    // The playback style may have changed mid-set (the record snapshot predates it).
    if (pick) openPractice({ ...c.record, blurPlaybackMode }, c.lm, { kind: 'custom', cfg: c.cfg, pick });
    else exitPractice();
  };

  // "That's enough for today" from the section-done overlay. The autosave has
  // us parked on the last line of the finished section, so resuming there would
  // replay that line and pop the same overlay again; park at the top of the
  // next section instead.
  const stopAfterSection = () => {
    const next = Math.min(currentSectionIndex + 1, sections.length - 1);
    if (currentVideoId) {
      const done = sections.slice(0, next).reduce((n, s) => n + s.subtitles.length, 0);
      saveProgress(currentVideoId, 0, next, done);
    }
    setShowSectionComplete(false);
    exitPractice();
  };
  const restartPractice = () => {
    setShowComplete(false);
    switchSection(0, videoRef, setIsPlaying);
    if (currentVideoId) saveProgress(currentVideoId, 0, 0);
  };

  // --- Keyboard ---
  // Recording an Anki clip plays the video itself: nothing may move or pause it meanwhile.
  const recording = ankiStatus === 'recording';
  const unlessRecording = <A extends unknown[]>(fn: (...a: A) => void) => (...a: A) => { if (!recording) fn(...a); };
  const inPractice = appState === AppState.PRACTICE && !showSectionComplete && !showComplete && !recording;
  const blurStepPaused = learningMode === LearningMode.BLUR && blurPlaybackMode === BlurPlaybackMode.SENTENCE_BY_SENTENCE && !isPlaying;

  const keyboardShortcuts = useMemo(() => ([
    { preventDefault: true, condition: (e: KeyboardEvent) => inPractice && matches(e, 'replay'), handler: () => replayCurrent() },
    { code: 'Space', shiftKey: false, preventDefault: true, allowInEditable: false, condition: () => inPractice, handler: () => togglePlayOrStep() },
    { code: 'Enter', preventDefault: true, allowInEditable: false, condition: () => inPractice && (mode === PracticeMode.FEEDBACK || blurStepPaused), handler: () => handleContinue() },
    { preventDefault: true, condition: (e: KeyboardEvent) => inPractice && matches(e, 'prev'), handler: () => handleSkip('prev') },
    { preventDefault: true, condition: (e: KeyboardEvent) => inPractice && matches(e, 'next'), handler: () => handleSkip('next') },
    { preventDefault: true, condition: (e: KeyboardEvent) => inPractice && matches(e, 'skipLine'), handler: () => handleSkip('next') },
    { condition: (e: KeyboardEvent) => inPractice && matches(e, 'anki'), handler: (e: KeyboardEvent) => handleAddToAnkiShortcut(e) },
    // In a blank DictationLine handles these (from / just that word); anywhere else there's no current word, so replay the line.
    { preventDefault: true, condition: (e: KeyboardEvent) => inPractice && (matches(e, 'playFrom') || matches(e, 'playWord')), handler: () => replayCurrent() },
  ]), [inPractice, mode, blurStepPaused, replayCurrent, togglePlayOrStep, handleContinue, handleSkip, handleAddToAnkiShortcut]);

  useKeyboardShortcuts(keyboardShortcuts);

  // --- Render ---

  const currentSub = subtitles[currentSubtitleIndex];

  const page = appState === AppState.WATCH && watching ? (
    <WatchPage key={watching.id} record={watching} onExit={() => { setWatching(null); setAppState(AppState.UPLOAD); }} />
  ) : appState === AppState.READ && reading && Reader ? (
    // Done reading: back to the panel to pick how to practise.
    <Reader key={reading.record.id} record={reading.record} by={reading.by}
      onExit={n => { setReading(null); setAppState(AppState.UPLOAD); setPanel({ record: reading.record, lm: reading.lm, read: n }); }} />
  ) : appState !== AppState.PRACTICE ? (
    <Shell active={appState} onNav={setAppState} hideAdd={appState === AppState.UPLOAD && homeEmpty} onAdd={() => { setAppState(AppState.UPLOAD); setAddAsked(true); }}>
      {appState === AppState.SETTINGS ? <Settings /> :
       appState === AppState.LIBRARY ? <ReviewPage key="line" deck="line" /> :
       appState === AppState.CARDS ? <ReviewPage key="word" deck="word" /> :
       <Home onResume={handleResume} onEmptyChange={setHomeEmpty} addAsked={addAsked} onAddHandled={() => setAddAsked(false)} />}
    </Shell>
  ) : (
    <PracticeProvider
      practice={{
        videoId: currentVideoId,
        subtitles, fullSubtitles, sections, currentSectionIndex, currentSubtitleIndex, mode,
        showSectionComplete, showComplete, learningMode, blurPlaybackMode,
        videoName: videoFileName || 'Video',
        watch: custom ? custom.watch : null,
      }}
      video={{ videoRef, videoSrc, isPlaying, volume, playbackSpeed, progress }}
      saved={{ savedIds, showSavedList, savedItems, isCurrentSaved: savedLinesIsCurrentSaved(currentSub) }}
      anki={{ ankiConfig, ankiStatus }}
      actions={{
        onExit: exitPractice,
        onRestart: restartPractice,
        onNextSet: nextSet,
        onSwitchSection: unlessRecording((index: number) => switchSection(index, videoRef, setIsPlaying)),
        onToggleSavedList: setShowSavedList,
        onTogglePlay: unlessRecording(togglePlayOrStep),
        onReplayCurrent: unlessRecording(replayCurrent),
        onSetStepReplay: setStepReplay,
        onSkip: unlessRecording(handleSkip),
        onProgressSeek: unlessRecording(handleProgressSeek),
        onToggleSaveCurrent: toggleSaveCurrent,
        onAddToAnki: handleAddToAnki,
        onWordToAnki: handleWordToAnki,
        onNextSection: unlessRecording(handleNextSectionClick),
        onStopAfterSection: stopAfterSection,
        onSetShowSectionComplete: setShowSectionComplete,
        onSetVolume: setVolume,
        onSetPlaybackSpeed: setPlaybackSpeed,
        onInputComplete: handleInputComplete,
        onContinue: unlessRecording(handleContinue),
        onDeleteSavedItem: deleteSavedItem,
        onJumpToSaved: unlessRecording(jumpToSaved),
        onSetBlurPlaybackMode: setBlurPlaybackMode,
      }}
    >
      <Studio />
    </PracticeProvider>
  );

  return (
    <>
      {page}
      {panel && (
        <CustomPanel
          record={panel.record}
          pace={paceOf(panel.lm, panel.record.blurPlaybackMode)}
          read={panel.read}
          onCancel={() => setPanel(null)}
          onStart={choice => { setPanel(null); openPractice(panel.record, panel.lm, choice); }}
        />
      )}
      <DialogHost />
    </>
  );
}
