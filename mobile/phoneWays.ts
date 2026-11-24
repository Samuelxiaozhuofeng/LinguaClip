// Which practice ways the phone shows and which one each record opens with (docs/android-roadmap.md
// 「第 2 期施工约定」). Both keys are this device's own (DEVICE_ONLY in utils/backup.ts); where the
// learner is stays in linguaclip_watch_pos (utils/storage.ts), shared by every way.
import type { Subtitle, VideoSection } from '../types';
import type { DictKey } from '../utils/i18n';
import { sectionAt, sectionStart } from '../utils/sections';
import { lineAt } from '../utils/srtParser';
import { getWatchPos } from '../utils/storage';
import { MAIN_WAYS, MORE_WAYS, type PhoneWay } from './ways/types';

const OFF_KEY = 'linguaclip_phone_ways_off';   // string[] of MORE_WAYS switched off
const LAST_KEY = 'linguaclip_phone_last_way';  // Record<videoId, PhoneWay>
const ALL: PhoneWay[] = [...MAIN_WAYS, ...MORE_WAYS];
const isWay = (w: unknown): w is PhoneWay => typeof w === 'string' && (ALL as string[]).includes(w);

export const WAY_LABEL_KEY: Record<PhoneWay, DictKey> = {
  listen: 'm.wayListen',
  dict: 'm.wayDict',
  blur: 'm.wayBlur',
  cloze: 'm.wayCloze',
  custom: 'm.wayCustom',
  read: 'm.wayRead',
};

export const MORE_WAY_DESC_KEY: Record<'blur' | 'cloze' | 'custom' | 'read', DictKey> = {
  blur: 'm.wayBlurDesc',
  cloze: 'm.wayClozeDesc',
  custom: 'm.wayCustomDesc',
  read: 'm.wayReadDesc',
};

export const AI_WAYS: readonly PhoneWay[] = ['cloze', 'custom'];

/** 1-based line number for a timestamp in seconds (0 when there are no lines). */
export const lineNumberAt = (lines: Subtitle[], sec: number): number => {
  if (!lines.length) return 0;
  const i = lineAt(lines, Math.max(0, sec));
  return i >= 0 ? i + 1 : 1;
};

/** Resolve `startSec` to the start time of the line holding it (0 at start or past the very end). */
export const resolveLineStartSec = (lines: Subtitle[], startSec: number): number => {
  if (!lines.length || !Number.isFinite(startSec) || startSec <= 0) return 0;
  const last = lines[lines.length - 1];
  // Only wrap back to 0 when strictly past the last line's end (or within 0.5s of EOF after its start).
  if (last.endTime > 0 && startSec >= last.endTime - 0.5 && startSec > last.startTime + 0.05) return 0;
  const i = lineAt(lines, startSec);
  return i >= 0 ? lines[i].startTime : 0;
};

/** Resolve initial listen start time: exact line when embedded with `startSec`, else section start. */
export const resolveListenStartSec = (
  lines: Subtitle[],
  sections: VideoSection[],
  recordId: string,
  embeddedStartSec?: number,
): number => {
  if (embeddedStartSec !== undefined) return resolveLineStartSec(lines, embeddedStartSec);
  const pos = getWatchPos(recordId);
  const lastEnd = lines.at(-1)?.endTime ?? 0;
  return pos > 0 && sections.length && (lastEnd <= 0 || pos < lastEnd - 3)
    ? sectionStart(sections[sectionAt(sections, pos)])
    : 0;
};

const listeners = new Set<() => void>();
export const subscribeWays = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

const readJson = <T>(key: string, fallback: T): T => {
  try { const v = JSON.parse(localStorage.getItem(key) || 'null'); return v ?? fallback; } catch { return fallback; }
};

export const getWaysOff = (): PhoneWay[] => {
  const v = readJson<unknown>(OFF_KEY, []);
  return Array.isArray(v) ? v.filter((w): w is PhoneWay => isWay(w) && MORE_WAYS.includes(w)) : [];
};
export const isWayOn = (w: PhoneWay) => MAIN_WAYS.includes(w) || !getWaysOff().includes(w);
export const moreWaysOn = (): PhoneWay[] => MORE_WAYS.filter(isWayOn);
export const setWayOn = (w: PhoneWay, on: boolean) => {
  if (MAIN_WAYS.includes(w)) return;
  const off = new Set(getWaysOff());
  if (on) off.delete(w); else off.add(w);
  try { localStorage.setItem(OFF_KEY, JSON.stringify([...off])); } catch { /* storage off: stays as it was */ }
  listeners.forEach(fn => fn());
};

// The way a record opens with: the last one used, unless it has been switched off since.
export const getPhoneLastWay = (videoId: string): PhoneWay => {
  const v = readJson<Record<string, unknown>>(LAST_KEY, {})[videoId];
  return isWay(v) && isWayOn(v) ? v : 'listen';
};
export const setPhoneLastWay = (videoId: string, w: PhoneWay) => {
  try {
    const all = readJson<Record<string, unknown>>(LAST_KEY, {});
    localStorage.setItem(LAST_KEY, JSON.stringify({ ...(all && typeof all === 'object' ? all : {}), [videoId]: w }));
  } catch { /* storage off */ }
};
export const forgetPhoneLastWay = (videoId: string) => {
  try {
    const all = readJson<Record<string, unknown>>(LAST_KEY, {});
    if (all && typeof all === 'object' && videoId in all) { delete all[videoId]; localStorage.setItem(LAST_KEY, JSON.stringify(all)); }
  } catch { /* storage off */ }
};
