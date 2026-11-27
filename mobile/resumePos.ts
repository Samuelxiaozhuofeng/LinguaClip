// Where a record resumes on the phone (docs/android.md「手机学习闭环」· 电脑搬来的素材):
// position = the phone's own watch_pos, else the desktop's section/line progress; way = the phone's last way,
// else the desktop's last way mapped to a phone way. Used by Study (where to start) and Home / Today (what to show).
import type { Subtitle, VideoRecord } from '../types';
import { buildSections, sectionLengthOf } from '../utils/sections';
import { getLastWay } from '../utils/storage';
import { isWayOn, readPhoneLastWay } from './phoneWays';
import type { PhoneWay } from './ways/types';

const WATCH_POS_KEY = 'linguaclip_watch_pos';

// Reads the raw watch_pos map so an explicitly stored 0s is distinct from an absent entry.
function readStoredWatchPos(videoId: string): number | null {
  try {
    const raw = localStorage.getItem(WATCH_POS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (!Object.prototype.hasOwnProperty.call(parsed, videoId)) return null;
    const n = (parsed as Record<string, unknown>)[videoId];
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

function sortedLines(lines: Subtitle[]): Subtitle[] {
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].startTime < lines[i - 1].startTime) {
      return [...lines].sort((a, b) => a.startTime - b.startTime);
    }
  }
  return lines;
}

/** Seconds to resume from: phone's watch_pos when present (including 0), else desktop's section + in-section line progress. */
export const resumeSecOf = (record: VideoRecord, lines: Subtitle[]): number => {
  const pos = readStoredWatchPos(record.id);
  if (pos !== null) return pos;
  if (!lines.length) return 0;
  if (typeof record.completionRate === 'number' && record.completionRate >= 100) return 0;

  const rawSec = typeof record.currentSectionIndex === 'number' && Number.isFinite(record.currentSectionIndex)
    ? Math.trunc(record.currentSectionIndex)
    : 0;
  const rawSub = typeof record.currentSubtitleIndex === 'number' && Number.isFinite(record.currentSubtitleIndex)
    ? Math.trunc(record.currentSubtitleIndex)
    : 0;
  if (rawSec <= 0 && rawSub <= 0) return 0;

  const sections = buildSections(sortedLines(lines), sectionLengthOf(record));
  if (!sections.length) return 0;
  const secIdx = Math.min(Math.max(rawSec, 0), sections.length - 1);
  const sec = sections[secIdx];
  if (!sec.subtitles.length) return Math.max(0, sec.startTime);
  const subIdx = Math.min(Math.max(rawSub, 0), sec.subtitles.length - 1);
  return Math.max(0, sec.subtitles[subIdx].startTime);
};

/** The way to open with: phone's own last way if recorded, else mapped from desktop's linguaclip_last_way. */
export const resumeWayOf = (record: VideoRecord): PhoneWay => {
  const phoneWay = readPhoneLastWay(record.id);
  if (phoneWay) return isWayOn(phoneWay) ? phoneWay : 'listen';

  const desktopWay = getLastWay(record.id);
  if (desktopWay === 'all') return 'dict';
  if (desktopWay === 'custom') return isWayOn('custom') ? 'custom' : 'dict';
  if (desktopWay === 'read') return isWayOn('read') ? 'read' : 'listen';
  return 'listen';
};
