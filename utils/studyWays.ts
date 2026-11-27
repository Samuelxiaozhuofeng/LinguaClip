import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Subtitle, VideoRecord } from '../types';
import { isAudioRecord } from './desktop';
import { buildSections } from './sections';
import { lineAt } from './srtParser';
import { matches } from './shortcuts';
import type { ReadBy } from './storage';

// Unified desktop way switching (docs/watch.md「页内切换练法」):
// Four levels from easiest to hardest — read · watch/listen · blur · dict.
// Podcasts omit "read"; builds without the Pro reader omit "read" as well.
export type StudyWay = 'read' | 'watch' | 'blur' | 'dict';
export const STUDY_WAYS: readonly StudyWay[] = ['read', 'watch', 'blur', 'dict'];

export const WAY_SHORTCUT: Record<StudyWay, 'dict.way1' | 'dict.way2' | 'dict.way3' | 'dict.way4'> = {
  read: 'dict.way1',
  watch: 'dict.way2',
  blur: 'dict.way3',
  dict: 'dict.way4',
};

export function waysForRecord(record: Pick<VideoRecord, 'podcast'>, hasReader: boolean): StudyWay[] {
  return !record.podcast && hasReader ? ['read', 'watch', 'blur', 'dict'] : ['watch', 'blur', 'dict'];
}

export function wayForKey(
  e: KeyboardEvent | ReactKeyboardEvent,
  record: Pick<VideoRecord, 'podcast'>,
  hasReader: boolean,
): StudyWay | null {
  const allowed = waysForRecord(record, hasReader);
  for (const w of allowed) {
    if (matches(e, WAY_SHORTCUT[w])) return w;
  }
  return null;
}

// Convert a video/audio timestamp (seconds) into the section + subtitle index
// inside that section so switching from watch/listen/read to dictation/blur
// lands on the exact same sentence.
export function sectionSubAt(
  subtitles: Subtitle[],
  sec: number,
  sectionLength: number,
): { sectionIndex: number; subtitleIndex: number } {
  if (subtitles.length === 0) return { sectionIndex: 0, subtitleIndex: 0 };
  const sorted = [...subtitles].sort((a, b) => a.startTime - b.startTime);
  const sections = buildSections(sorted, sectionLength);
  if (sections.length === 0) return { sectionIndex: 0, subtitleIndex: 0 };
  const idx = Math.max(0, lineAt(sorted, sec));
  const target = sorted[idx];
  for (let si = 0; si < sections.length; si++) {
    const subIdx = sections[si].subtitles.findIndex(s => s.id === target.id);
    if (subIdx >= 0) return { sectionIndex: si, subtitleIndex: subIdx };
  }
  return { sectionIndex: 0, subtitleIndex: 0 };
}

// Default entry for a record that has never been opened before (no saved `lastWay`).
// Audio files default to intensive listening when Listen is available; regular videos
// follow the user's global preference (`chosen`: true = watch, false = section practice,
// defaulting to watch on a fresh install).
export type NewVideoChoice = { kind: 'all' } | { kind: 'watch' } | { kind: 'listen' } | { kind: 'read'; by: ReadBy };
export function defaultChoiceForNew(
  record: Pick<VideoRecord, 'podcast' | 'videoPath' | 'videoFileName'>,
  chosenWatch: boolean,
  hasListen: boolean,
): NewVideoChoice {
  const audio = isAudioRecord(record);
  if (audio) return { kind: hasListen ? 'listen' : 'watch' };
  return chosenWatch ? { kind: 'watch' } : { kind: 'all' };
}

// Temporary slow-down on repeated replays of the same line in Studio:
// 1st manual replay plays at normal speed; 2nd+ replay drops temporarily to 0.75x
// (never speeding up if the user's base speed is already <= 0.75x).
export const SLOW_REPLAY_RATE = 0.75;
export function replayRate(baseSpeed: number, manualReplayCount: number, enabled: boolean): { rate: number; slowed: boolean } {
  if (enabled && manualReplayCount >= 2 && baseSpeed > SLOW_REPLAY_RATE) {
    return { rate: SLOW_REPLAY_RATE, slowed: true };
  }
  return { rate: baseSpeed, slowed: false };
}
