import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { AppState, PracticeMode, VideoRecord, LearningMode, BlurPlaybackMode } from './types';
import ReviewPage from './components/ReviewPage';
import Settings from './components/Settings';
import Home from './components/Home';
import Shell from './components/Shell';
import Studio from './components/Studio';
import WatchPage from './components/WatchPage';
import CustomPanel, { PanelChoice, nextPick, paceOf, resumeChoice } from './components/CustomPanel';
import { Listen, PodcastPicker, ProHost, Reader, StarterHost, podcastRate } from '@pro';
import SyncHost from './components/SyncHost';
import { DialogHost, dialog } from './components/Dialog';
import { UpdateDialog } from './components/UpdateUI';
import { checkUpdate } from './utils/update';
import { PracticeProvider } from './hooks/usePracticeContext';
import { useVideoHistory } from './hooks/useVideoHistory';
import { usePracticeSession } from './hooks/usePracticeSession';
import { useAnkiIntegration } from './hooks/useAnkiIntegration';
import { useSavedLines } from './hooks/useSavedLines';
import { useVideoController } from './hooks/useVideoController';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { usePracticeActions } from './hooks/usePracticeActions';
import { resolveAnchorPos, sectionLengthOf, useWaySwitch } from './hooks/useWaySwitch';
import * as VideoStorage from './utils/videoStorage';
import { fileNameFromPath, isAudioRecord, pathExists, pickVideoPath, videoSrcFromPath } from './utils/desktop';
import { parseSRT } from './utils/srtParser';
import { t, useLang } from './utils/i18n';
import { markInterruptedJobs, startImportListener } from './utils/importJob';
import { isDefault, loose, matches } from './utils/shortcuts';
import { getLoop, setLoopOn, useLoop } from './utils/loop';
import { countLine } from './utils/today';
import { deleteCards, keepOrphans, orphanCards } from './utils/review';
import { startClips } from './utils/clips';
import { CustomConfig, CustomPick } from './utils/customPick';
import { setCustomPos, setLastWay, type ReadBy } from './utils/storage';
import { initAutoAddDefault } from './utils/autoAddReview';
import type { DictLang } from './utils/dictionary';

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
  useEffect(() => { initAutoAddDefault().catch(console.error); askAboutOrphans().catch(console.error); }, []);
  // Official build only: look for a new version once, quietly (docs/update.md).
  useEffect(() => { const id = setTimeout(() => { checkUpdate(); }, 5000); return () => clearTimeout(id); }, []);

  // Cards' own clips: fill in what's missing, now and after card changes (utils/clips.ts).
  useEffect(() => startClips(), []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    markInterruptedJobs().catch(console.error)
      .then(() => startImportListener())
      .then(fn => { if (cancelled) fn(); else unlisten = fn; })
      .catch(console.error);
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  const [appState, setAppState] = useState<AppState>(AppState.UPLOAD);
  // Which shelf a page returns to: the videos, or the podcast tab.
  const homeRef = useRef<AppState.UPLOAD | AppState.PODCASTS>(AppState.UPLOAD);
  if (appState === AppState.UPLOAD || appState === AppState.PODCASTS) homeRef.current = appState;
  const goHome = () => { ++launchRef.current; setAppState(homeRef.current); };
  const [homeEmpty, setHomeEmpty] = useState(false); // no videos yet: the top bar drops its add button
  const [addAsked, setAddAsked] = useState(false); // the top bar's "+": Home opens its add dialog
  const [videoFileName, setVideoFileName] = useState<string | null>(null);
  const [videoLang, setVideoLang] = useState<DictLang | undefined>(undefined);
  const [learningMode, setLearningMode] = useState<LearningMode>(LearningMode.DICTATION);
  const [blurPlaybackMode, setBlurPlaybackModeState] = useState<BlurPlaybackMode>(BlurPlaybackMode.SENTENCE_BY_SENTENCE);
  const [showComplete, setShowComplete] = useState(false);
  // The start-of-practice panel, and the custom set being practised (null = section by section).
  const [panel, setPanel] = useState<{ record: VideoRecord; lm: LearningMode; read?: number } | null>(null);
  type CustomSession = { record: VideoRecord; lm: LearningMode; cfg: CustomConfig; watch: Set<number>; end: number };
  const [custom, setCustom] = useState<CustomSession | null>(null);
  const [watching, setWatching] = useState<{ record: VideoRecord; startSec?: number } | null>(null); // watch mode's video, its path checked
  const [reading, setReading] = useState<{ record: VideoRecord; lm: LearningMode; by: ReadBy; startSec?: number } | null>(null); // the reader's, likewise
  const [listening, setListening] = useState<{ record: VideoRecord; lm: LearningMode; startSec?: number } | null>(null); // no picture: listen instead of watch
  const [practiceRecord, setPracticeRecord] = useState<VideoRecord | null>(null);
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

  const loopOkRef = useRef<() => boolean>(() => true);
  const toggleLoopRef = useRef(() => {});

  const {
    videoRef, videoSrc, setVideoSrc, isPlaying, volume, playbackSpeed, slowReplay, progress,
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
    loopOk: () => loopOkRef.current(),
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
    } else if (currentSectionIndex > 0 || currentSubtitleIndex > 0) {
      const before = sections.slice(0, currentSectionIndex).reduce((n, s) => n + s.subtitles.length, 0);
      saveProgress(currentVideoId, currentSubtitleIndex, currentSectionIndex, before + currentSubtitleIndex);
    }
  }, [currentSubtitleIndex, currentSectionIndex, currentVideoId, appState, showComplete, sections, subtitles, saveProgress]);

  // --- Starting a session ---

  const startPractice = async (
    videoName: string, videoPath: string, sf: File, lm: LearningMode, bpm: BlurPlaybackMode,
    startIndex?: number, startSectionIndex?: number, videoId?: string, pick?: number[], stale?: () => boolean, sectionLength?: number,
  ): Promise<boolean> => {
    let subText: string;
    try {
      subText = await sf.text();
    } catch {
      dialog.alert(t('app.subtitleReadFailTitle'), t('app.subtitleReadFailBody'));
      return false;
    }
    if (stale?.()) return false;
    const result = initializePractice(subText, startIndex, startSectionIndex, pick, sectionLength);
    if (!result) {
      dialog.alert(t('app.noSubtitlesTitle'), t('app.noSubtitlesBody', { name: sf.name }));
      return false;
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
    return true;
  };

  // Only the latest start wins: two starts in quick succession must not mix one
  // video's lines with the other's custom session.
  const launchRef = useRef(0);
  // Every way into practice lands here. A podcast episode goes straight to intensive listening, a video
  // started before starts the same way again (docs/watch.md); else the panel asks ("…" → another way opens it).
  const handleResume = (record: VideoRecord, lm: LearningMode, practiceOnly = false) => {
    if (record.importJob) return;
    if (record.podcast && Listen) return void openPractice(record, lm, { kind: 'listen' }).catch(console.error);
    const launch = ++launchRef.current;
    resumeChoice(record, lm, practiceOnly).catch(() => null).then(choice => {
      if (launchRef.current !== launch) return;
      if (choice) openPractice(record, lm, choice); else setPanel({ record, lm });
    });
  };
  const otherWay = (r: VideoRecord) => setPanel({ record: r, lm: r.learningMode ?? LearningMode.DICTATION });
  const openPractice = async (record: VideoRecord, lm: LearningMode, choice: PanelChoice, anchorSec?: number, existingToken?: number): Promise<boolean> => {
    const launch = existingToken ?? ++launchRef.current;
    const stale = () => launchRef.current !== launch;
    const clearViews = () => { setWatching(null); setReading(null); setListening(null); };
    try {
      let videoPath = record.videoPath;
      if (!videoPath || !(await pathExists(videoPath))) {
        if (stale()) return false;
        const ok = await dialog.confirm(t('app.pickVideoTitle'), t('app.pickVideoBody', { name: record.videoFileName }), { ok: t('app.pickVideoOk') });
        if (!ok || stale()) return false;
        const picked = await pickVideoPath();
        if (!picked || stale()) return false;
        videoPath = picked;
        await VideoStorage.patchVideoRecord(record.id, { videoPath });
      }
      if (stale()) return false;

      if (choice.kind === 'watch' || choice.kind === 'listen' || choice.kind === 'read') {
        if (parseSRT(record.subtitleText).length === 0) {
          dialog.alert(t('app.noSubtitlesTitle'), t('app.noSubtitlesBody', { name: record.videoFileName }));
          return false;
        }
        clearViews(); customRef.current = null; setCustom(null); setPracticeRecord(null); setShowComplete(false); setIsPlaying(false);
        const withPath = { ...record, videoPath };
        if (choice.kind === 'read') { // before practice: the record is left as it is, only the last way is kept
          if (!record.podcast) setLastWay(record.id, 'read');
          setReading({ record: withPath, lm, by: choice.by, startSec: anchorSec });
          setAppState(AppState.READ);
          return true;
        }
        // Watching (or listening) moves the video up the shelf; its practice mode and progress stay.
        VideoStorage.patchVideoRecord(record.id, { lastPracticed: Date.now() }).catch(console.error);
        if (!record.podcast) setLastWay(record.id, 'watch');
        if (choice.kind === 'listen') {
          setListening({ record: withPath, lm, startSec: anchorSec });
          setAppState(AppState.LISTEN);
          return true;
        }
        setWatching({ record: withPath, startSec: anchorSec });
        setAppState(AppState.WATCH);
        return true;
      }

      const secLen = sectionLengthOf(record);
      const bpm = record.blurPlaybackMode ?? BlurPlaybackMode.SENTENCE_BY_SENTENCE;
      const withPath = { ...record, videoPath, learningMode: lm };
      if (choice.kind === 'custom') {
        const { lines, practise } = choice.pick;
        const keep = new Set(practise);
        const subs = parseSRT(record.subtitleText);
        const session: CustomSession = {
          record: withPath, lm, cfg: choice.cfg,
          watch: new Set(lines.filter(i => !keep.has(i)).map(i => subs[i].id)),
          end: subs[lines[lines.length - 1]].endTime,
        };
        const started = await startPractice(record.videoFileName, videoPath, getSubtitleFileFromRecord(record), lm, bpm, 0, 0, record.id, lines, stale, secLen);
        if (!started || stale()) return false;
        clearViews(); setVideoLang(record.lang); customRef.current = session; setCustom(session); setPracticeRecord(withPath);
        if (!record.podcast) setLastWay(record.id, 'custom');
        VideoStorage.patchVideoRecord(record.id, { learningMode: lm, lastPracticed: Date.now() }).catch(console.error);
        return true;
      }
      const anchor = anchorSec !== undefined ? resolveAnchorPos(withPath, anchorSec) : null;
      const finished = record.completionRate >= 100;
      const startSub = anchor ? anchor.subtitleIndex : finished ? 0 : record.currentSubtitleIndex;
      const startSecIdx = anchor ? anchor.sectionIndex : finished ? 0 : record.currentSectionIndex;
      const started = await startPractice(record.videoFileName, videoPath, getSubtitleFileFromRecord(record), lm, bpm, startSub, startSecIdx, record.id, undefined, stale, secLen);
      if (!started || stale()) return false;
      clearViews(); setVideoLang(record.lang); customRef.current = null; setCustom(null); setPracticeRecord(withPath);
      if (!record.podcast) setLastWay(record.id, 'all');
      VideoStorage.patchVideoRecord(record.id, { learningMode: lm }).catch(console.error);
      if (anchor) saveProgress(record.id, anchor.subtitleIndex, anchor.sectionIndex, anchor.absIndex);
      return true;
    } catch (error) {
      console.error('Failed to continue from library:', error);
      dialog.alert(t('app.openVideoFailTitle'), t('app.openVideoFailBody'));
      return false;
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
  const replayCurrent = useCallback((autoAdvanceAfter?: boolean, fromRatio?: number, toRatio?: number, fromLoop?: boolean) => {
    if (stepReplayRef.current) stepReplayRef.current();
    else handleReplayCurrent(autoAdvanceAfter, fromRatio, toRatio, fromLoop);
  }, [handleReplayCurrent]);
  // The line loop waits while a breakdown step or an Anki recording owns playback.
  loopOkRef.current = () => !stepReplayRef.current && ankiStatus !== 'recording';
  const blurContinuous = learningMode === LearningMode.BLUR && blurPlaybackMode === BlurPlaybackMode.CONTINUOUS;
  // Turning it on while the line sits stopped plays it straight away.
  const toggleLoop = () => {
    if (blurContinuous) return;
    const on = !getLoop().on;
    setLoopOn(on);
    if (on && !isPlaying && mode !== PracticeMode.FEEDBACK) replayCurrent(false, 0, undefined, true);
  };
  toggleLoopRef.current = toggleLoop;
  const togglePlayOrStep = useCallback(() => {
    if (stepReplayRef.current && !isPlaying) stepReplayRef.current();
    else togglePlay();
  }, [togglePlay, isPlaying]);

  const exitPractice = () => { setShowComplete(false); goHome(); customRef.current = null; setCustom(null); setPracticeRecord(null); };
  const { switchWay, wayToast } = useWaySwitch({
    appState, currentVideoId, learningMode, mode, hasListen: !!Listen, launchRef, customRef,
    setLearningMode, setMode, setPracticeRecord, openPractice,
  });

  // "Next set" on the custom done overlay: same choices, from where this set ended.
  const nextSet = async () => {
    const c = customRef.current;
    if (!c) return;
    const lm = learningMode;
    const pick = await nextPick(c.record, c.cfg, paceOf(lm, blurPlaybackMode));
    if (customRef.current !== c) return; // left the page meanwhile
    // The playback style or learning mode may have changed mid-set.
    if (pick) openPractice({ ...c.record, learningMode: lm, blurPlaybackMode }, lm, { kind: 'custom', cfg: c.cfg, pick });
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
  const loopOn = useLoop().on;
  const unlessRecording = <A extends unknown[]>(fn: (...a: A) => void) => (...a: A) => { if (!recording) fn(...a); };
  const inPractice = appState === AppState.PRACTICE && !showSectionComplete && !showComplete && !recording;
  const blurStepPaused = learningMode === LearningMode.BLUR && blurPlaybackMode === BlurPlaybackMode.SENTENCE_BY_SENTENCE && (!isPlaying || loopOn); // a looping line never stops by itself

  const keyboardShortcuts = useMemo(() => ([
    { preventDefault: true, condition: (e: KeyboardEvent) => inPractice && matches(e, 'dict.replay'), handler: () => replayCurrent() },
    { preventDefault: true, allowInEditable: false, condition: (e: KeyboardEvent) => inPractice && (matches(e, 'dict.play') || (isDefault('dict.play') && e.code === 'Space' && !e.shiftKey)), handler: () => togglePlayOrStep() },
    { preventDefault: true, allowInEditable: false, condition: (e: KeyboardEvent) => !e.repeat && inPractice && (mode === PracticeMode.FEEDBACK || blurStepPaused) && loose(e, 'dict.continue', 'dictOut'), handler: () => handleContinue() },
    { preventDefault: true, condition: (e: KeyboardEvent) => inPractice && matches(e, 'dict.loop'), handler: () => toggleLoopRef.current() },
    { preventDefault: true, condition: (e: KeyboardEvent) => inPractice && matches(e, 'dict.prev'), handler: () => handleSkip('prev') },
    { preventDefault: true, condition: (e: KeyboardEvent) => inPractice && matches(e, 'dict.next'), handler: () => handleSkip('next') },
    { preventDefault: true, condition: (e: KeyboardEvent) => inPractice && matches(e, 'dict.skipLine'), handler: () => handleSkip('next') },
    { condition: (e: KeyboardEvent) => inPractice && matches(e, 'dict.anki'), handler: (e: KeyboardEvent) => handleAddToAnkiShortcut(e) },
    // In a blank DictationLine handles these (from / just that word); anywhere else there's no current word, so replay the line.
    { preventDefault: true, condition: (e: KeyboardEvent) => inPractice && (matches(e, 'dict.playFrom') || matches(e, 'dict.playWord')), handler: () => replayCurrent() },
  ]), [inPractice, mode, blurStepPaused, replayCurrent, togglePlayOrStep, handleContinue, handleSkip, handleAddToAnkiShortcut]);

  useKeyboardShortcuts(keyboardShortcuts);

  // --- Render ---

  const currentSub = subtitles[currentSubtitleIndex];
  const practiceAnchor = currentSub?.startTime ?? videoRef.current?.currentTime ?? 0;

  const page = appState === AppState.WATCH && watching ? (
    <WatchPage key={watching.record.id} record={watching.record} startSec={watching.startSec} hasReader={!!Reader} hasListen={!!Listen}
      onSwitchWay={(w, sec) => switchWay(watching.record, w, sec)} onExit={() => { setWatching(null); goHome(); }} />
  ) : appState === AppState.LISTEN && listening && Listen ? (
    <Listen key={listening.record.id} record={listening.record} startSec={listening.startSec} hasReader={!!Reader}
      onSwitchWay={(w, sec) => switchWay(listening.record, w, sec)} onExit={() => { setListening(null); goHome(); }}
      onPractice={() => { setListening(null); goHome(); setPanel({ record: listening.record, lm: listening.lm }); }}
      onOpen={r => { setListening(null); goHome(); handleResume(r, r.learningMode ?? LearningMode.DICTATION); }} />
  ) : appState === AppState.READ && reading && Reader ? (
    // Done reading: back to the panel to pick how to practise.
    <Reader key={reading.record.id} record={reading.record} by={reading.by} startSec={reading.startSec} hasListen={!!Listen}
      onSwitchWay={(w, sec) => switchWay(reading.record, w, sec)}
      onExit={n => { setReading(null); goHome(); setPanel({ record: reading.record, lm: reading.lm, read: n }); }} />
  ) : appState !== AppState.PRACTICE ? (
    <Shell active={appState} onNav={setAppState} podcasts={!!PodcastPicker} hideAdd={appState === homeRef.current && homeEmpty} onAdd={() => { setAppState(appState === AppState.PODCASTS ? AppState.PODCASTS : AppState.UPLOAD); setAddAsked(true); }}>
      {appState === AppState.SETTINGS ? <Settings /> :
       appState === AppState.LIBRARY ? <ReviewPage key="line" deck="line" onResume={r => handleResume(r, r.learningMode ?? LearningMode.DICTATION)} /> :
       appState === AppState.CARDS ? <ReviewPage key="word" deck="word" onResume={r => handleResume(r, r.learningMode ?? LearningMode.DICTATION)} /> :
       appState === AppState.PODCASTS && PodcastPicker ? (
        <Home key="podcasts" onResume={handleResume} onOtherWay={otherWay} onEmptyChange={setHomeEmpty} addAsked={addAsked} onAddHandled={() => setAddAsked(false)} podcasts={{
          empty: <PodcastPicker onOpen={r => handleResume(r, r.learningMode ?? LearningMode.DICTATION)} />,
          add: close => <PodcastPicker onClose={close} onOpen={r => handleResume(r, r.learningMode ?? LearningMode.DICTATION)} />,
          rate: podcastRate,
        }} />
       ) :
       <Home key="videos" onResume={handleResume} onOtherWay={otherWay} onEmptyChange={setHomeEmpty} addAsked={addAsked} onAddHandled={() => setAddAsked(false)} />}
    </Shell>
  ) : (
    <PracticeProvider
      practice={{
        videoId: currentVideoId, videoLang, subtitles, fullSubtitles, sections, currentSectionIndex, currentSubtitleIndex, mode,
        showSectionComplete, showComplete, learningMode, blurPlaybackMode, videoName: videoFileName || 'Video',
        watch: custom ? custom.watch : null, practiceRecord, hasReader: !!Reader, hasListen: !!Listen,
      }}
      video={{ videoRef, videoSrc, isPlaying, volume, playbackSpeed, slowReplay, progress }}
      saved={{ savedIds, showSavedList, savedItems, isCurrentSaved: savedLinesIsCurrentSaved(currentSub) }}
      anki={{ ankiConfig, ankiStatus }}
      actions={{
        onExit: exitPractice, onRestart: restartPractice, onNextSet: nextSet,
        onSwitchSection: unlessRecording((index: number) => {
          switchSection(index, videoRef, setIsPlaying);
          if (currentVideoId && index >= 0 && index < sections.length) saveProgress(currentVideoId, 0, index, sections.slice(0, index).reduce((n, s) => n + s.subtitles.length, 0));
        }),
        onToggleSavedList: setShowSavedList, onTogglePlay: unlessRecording(togglePlayOrStep),
        onReplayCurrent: unlessRecording(replayCurrent), onToggleLoop: unlessRecording(toggleLoop),
        onSetStepReplay: setStepReplay, onSkip: unlessRecording(handleSkip), onProgressSeek: unlessRecording(handleProgressSeek),
        onToggleSaveCurrent: toggleSaveCurrent, onAddToAnki: handleAddToAnki, onWordToAnki: handleWordToAnki,
        onNextSection: unlessRecording(handleNextSectionClick), onStopAfterSection: stopAfterSection,
        onSetShowSectionComplete: setShowSectionComplete, onSetVolume: setVolume, onSetPlaybackSpeed: setPlaybackSpeed,
        onInputComplete: handleInputComplete, onStartInput: () => { if (mode === PracticeMode.LISTENING) setMode(PracticeMode.INPUT); },
        onContinue: unlessRecording(handleContinue), onDeleteSavedItem: deleteSavedItem, onJumpToSaved: unlessRecording(jumpToSaved),
        onSetBlurPlaybackMode: setBlurPlaybackMode,
        onSwitchWay: practiceRecord ? unlessRecording(w => switchWay(practiceRecord, w, practiceAnchor)) : undefined,
      }}
    >
      <Studio />
    </PracticeProvider>
  );

  return (
    <>
      {page}
      {wayToast}
      {panel && (
        <CustomPanel record={panel.record} pace={paceOf(panel.lm, panel.record.blurPlaybackMode)} read={panel.read}
          onCancel={() => setPanel(null)} onStart={choice => { setPanel(null); openPractice(panel.record, panel.lm, choice); }} />
      )}
      {ProHost && <ProHost />}
      {StarterHost && <StarterHost here={appState === AppState.UPLOAD || appState === AppState.PODCASTS} onOpen={r => handleResume(r, r.learningMode ?? LearningMode.DICTATION)} />}
      <SyncHost busy={appState === AppState.PRACTICE || appState === AppState.WATCH || appState === AppState.LISTEN || appState === AppState.READ} />
      <UpdateDialog />
      <DialogHost />
    </>
  );
}
