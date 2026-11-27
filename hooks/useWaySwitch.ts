import React, { useCallback, useEffect, useState } from 'react';
import { AppState, LearningMode, PracticeMode, VideoRecord } from '../types';
import type { PanelChoice } from '../components/CustomPanel';
import { Stamp } from '../components/ui';
import * as VideoStorage from '../utils/videoStorage';
import { isAudioRecord } from '../utils/desktop';
import { t } from '../utils/i18n';
import { buildSections, sectionLengthOf } from '../utils/sections';
export { sectionLengthOf };
import { parseSRT } from '../utils/srtParser';
import { formatTimeCode, getWatchPrefs, saveLocalWatchChosen } from '../utils/storage';
import { sectionSubAt, StudyWay } from '../utils/studyWays';

export interface AnchorPos {
  sectionIndex: number;
  subtitleIndex: number;
  absIndex: number;
}

// Resolve a timestamp (seconds) into section + subtitle index + absolute index across the video.
export function resolveAnchorPos(record: VideoRecord, anchorSec: number): AnchorPos {
  const subs = parseSRT(record.subtitleText);
  const len = sectionLengthOf(record);
  const hit = sectionSubAt(subs, anchorSec, len);
  const sorted = [...subs].sort((a, b) => a.startTime - b.startTime);
  const secs = buildSections(sorted, len);
  const before = secs.slice(0, hit.sectionIndex).reduce((n, s) => n + s.subtitles.length, 0);
  return { sectionIndex: hit.sectionIndex, subtitleIndex: hit.subtitleIndex, absIndex: before + hit.subtitleIndex };
}

export interface UseWaySwitchParams {
  appState: AppState;
  currentVideoId: string | null;
  learningMode: LearningMode;
  mode: PracticeMode;
  hasListen: boolean;
  launchRef: React.MutableRefObject<number>;
  customRef: React.MutableRefObject<{ lm: LearningMode } | null>;
  setLearningMode: (lm: LearningMode) => void;
  setMode: (mode: PracticeMode) => void;
  setPracticeRecord: React.Dispatch<React.SetStateAction<VideoRecord | null>>;
  openPractice: (record: VideoRecord, lm: LearningMode, choice: PanelChoice, anchorSec?: number, token?: number) => Promise<boolean>;
}

// Unified in-place study-way switching across Read / Watch(Listen) / Blur / Dictate (docs/watch.md).
export function useWaySwitch(params: UseWaySwitchParams) {
  const {
    appState, currentVideoId, learningMode, mode, hasListen, launchRef, customRef,
    setLearningMode, setMode, setPracticeRecord, openPractice,
  } = params;

  const [toast, setToast] = useState<{ text: string; n: number } | null>(null);
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 1600);
    return () => window.clearTimeout(id);
  }, [toast]);

  const saySwitched = useCallback((way: StudyWay, rec: Pick<VideoRecord, 'podcast' | 'videoPath' | 'videoFileName'>, sec: number) => {
    const label =
      way === 'read' ? t('way.read')
      : way === 'watch' ? t(hasListen && isAudioRecord(rec) ? 'way.listen' : 'way.watch')
      : way === 'blur' ? t('way.blur')
      : t('way.dict');
    const text = t('way.switched', { way: label, time: formatTimeCode(sec) });
    setToast(s => ({ text, n: (s?.n ?? 0) + 1 }));
  }, [hasListen]);

  const switchWay = useCallback(async (fromRecord: VideoRecord, targetWay: StudyWay, anchorSec: number) => {
    // Allocate a token before any await so rapid switches or exits invalidate stale requests.
    const token = ++launchRef.current;

    // Blur <-> Dictation inside Studio: instant in-place mode flip, zero reload.
    if (appState === AppState.PRACTICE && (targetWay === 'blur' || targetWay === 'dict') && fromRecord.id === currentVideoId) {
      const nextLm = targetWay === 'blur' ? LearningMode.BLUR : LearningMode.DICTATION;
      if (nextLm === learningMode) return;
      setLearningMode(nextLm);
      if (customRef.current) customRef.current.lm = nextLm;
      VideoStorage.patchVideoRecord(fromRecord.id, { learningMode: nextLm }).catch(console.error);
      if (!isAudioRecord(fromRecord)) saveLocalWatchChosen(false);
      if (mode === PracticeMode.FEEDBACK) setMode(PracticeMode.LISTENING);
      setPracticeRecord(r => (r && r.id === fromRecord.id ? { ...r, learningMode: nextLm } : r));
      saySwitched(targetWay, fromRecord, anchorSec);
      return;
    }

    // Cross-page switch: fetch latest record so lang / videoPath edits aren't lost.
    const latest = await VideoStorage.getVideoRecord(fromRecord.id);
    if (launchRef.current !== token) return;
    const fresh: VideoRecord = latest ? { ...latest, videoPath: latest.videoPath ?? fromRecord.videoPath } : fromRecord;

    let targetLm: LearningMode;
    let targetChoice: PanelChoice;
    if (targetWay === 'read') {
      targetLm = fresh.learningMode ?? LearningMode.DICTATION;
      targetChoice = { kind: 'read', by: getWatchPrefs().readBy };
    } else if (targetWay === 'watch') {
      targetLm = fresh.learningMode ?? LearningMode.DICTATION;
      targetChoice = { kind: hasListen && isAudioRecord(fresh) ? 'listen' : 'watch' };
    } else {
      targetLm = targetWay === 'blur' ? LearningMode.BLUR : LearningMode.DICTATION;
      targetChoice = { kind: 'all' };
    }

    const ok = await openPractice(fresh, targetLm, targetChoice, anchorSec, token);
    if (ok && launchRef.current === token) {
      if (!isAudioRecord(fresh) && targetWay !== 'read') saveLocalWatchChosen(targetWay === 'watch');
      saySwitched(targetWay, fresh, anchorSec);
    }
  }, [appState, currentVideoId, learningMode, mode, hasListen, launchRef, customRef, setLearningMode, setMode, setPracticeRecord, openPractice, saySwitched]);

  const wayToast = toast
    ? React.createElement(
        'div',
        { key: toast.n, className: 'fixed left-1/2 -translate-x-1/2 top-16 z-50 fade-in pointer-events-none' },
        React.createElement(Stamp, { tone: 'ink', className: '!px-3 !py-1.5 !text-sm shadow-card' }, toast.text),
      )
    : null;

  return { switchWay, wayToast };
}
