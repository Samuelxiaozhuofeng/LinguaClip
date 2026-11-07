import { LearningMode, VideoRecord } from '../types';
import { isAudioRecord } from './desktop';
import type { DictKey } from './i18n';
import { getReadPos } from './readLooked';
import { formatTimeCode, getCustomPos, getWatchPos, LastWay } from './storage';

// What a home card says about the way a click goes on (docs/watch.md, 点视频直接开播):
// where that way stopped and its name. Both follow getLastWay, like the click itself.

// Seconds where the custom sets / watching / reading got to; undefined = by sections.
export const lastWaySec = (videoId: string, way: LastWay | null): number | undefined =>
  way === 'custom' ? getCustomPos(videoId) : way === 'watch' ? getWatchPos(videoId) : way === 'read' ? getReadPos(videoId) : undefined;

// The i18n key naming what a click starts; dictation / blur by the video's practice mode.
export const lastWayName = (v: VideoRecord, way: LastWay | null): DictKey =>
  way === 'watch' ? (isAudioRecord(v) ? 'custom.listen' : 'custom.watch') : way === 'read' ? 'home.readMode'
    : v.learningMode === LearningMode.BLUR ? 'home.blur' : 'home.dictate';

// Where a record sits, worked out on Home from its subtitles and getLastWay.
export type ShelfPos = { part: number; parts: number; line: number; lines: number; customSec?: number; customPct?: number; listen?: boolean; watch?: boolean; read?: boolean };

// "Part 2 of 5" and how far into that part, or lines when there is only one part. The cards'
// text and bar and the "Today" bar's continue cell (docs/stats.md) all come from here.
export const cardWhere = (v: VideoRecord, pos: ShelfPos | undefined, t: (key: DictKey, vars?: Record<string, string | number>) => string) => {
  if (!pos) return { text: `${v.completionRate}%`, pct: v.completionRate };
  if (pos.listen) return { text: t('home.listenAt', { current: pos.part + 1, total: pos.parts }), pct: (pos.part / pos.parts) * 100 };
  if (pos.read && !pos.customSec) return { text: '', pct: 0 }; // nothing read yet: the card just says "continue reading"
  if (pos.customSec !== undefined) return { text: t(pos.read ? 'home.readAt' : pos.watch ? 'home.watchAt' : 'home.customAt', { time: formatTimeCode(pos.customSec ?? 0) }), pct: pos.customPct ?? 0 };
  const pct = pos.lines ? (pos.line / pos.lines) * 100 : 0;
  if (pos.parts > 1) return { text: t('home.partOf', { current: pos.part + 1, total: pos.parts }), pct };
  return { text: t('home.linesCount', { current: pos.line, total: pos.lines }), pct };
};

// The big card says "finished" instead of "continue": its bar is full, at the last part (or by seconds).
export const cardFinished = (pct: number, pos: ShelfPos | undefined) => pct >= 100 && (!!pos?.customSec || (pos?.part ?? 0) + 1 >= (pos?.parts ?? 1));
