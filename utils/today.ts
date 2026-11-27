import { useEffect } from 'react';
import { DAYS_DEV_KEY, getSyncDeviceId } from './syncConfig';
import { notifySyncDirty } from './syncMeta';
import { DAYS_DEV_KEEP, type DayBucket, type DaysDev } from './syncTypes';

// Practice time and lines per day, for the home screen's week (docs/stats.md, docs/sync.md).
// Per-device G-Counter buckets live in `linguaclip_days_dev` (35 days); their per-day sums
// are projected back into `linguaclip_days` (30 days) and `linguaclip_today` (legacy shape).

const KEY = 'linguaclip_today';
const DAYS = 'linguaclip_days';
const KEEP = 30;
const TICK = 5;         // seconds per clock tick
const IDLE = 60_000;    // no key / click for this long = not practising
const PLAY_IDLE = 15 * 60_000; // media playing still counts, but only this long after the last key / click

export interface Today { date: string; sec: number; lines: number }
type Days = Record<string, DayBucket>;

const dayOf = (now: number) => new Date(now).toLocaleDateString('sv'); // local YYYY-MM-DD

const readDays = (): Days => {
  try {
    const d = JSON.parse(localStorage.getItem(DAYS) || '{}');
    if (d && typeof d === 'object' && !Array.isArray(d)) return d;
  } catch { /* unreadable → start the history fresh */ }
  return {};
};

const normalizeBucket = (v: unknown): DayBucket | null => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  return { sec: Math.max(0, +Number(o.sec) || 0), lines: Math.max(0, +Number(o.lines) || 0) };
};

const sumBuckets = (devMap: Record<string, DayBucket> | undefined): DayBucket => {
  let sec = 0, lines = 0;
  if (!devMap) return { sec, lines };
  for (const b of Object.values(devMap)) {
    sec += Math.max(0, +b.sec || 0);
    lines += Math.max(0, +b.lines || 0);
  }
  return { sec, lines };
};

/** Read per-device practice buckets, migrating legacy `linguaclip_days` / `linguaclip_today` once if absent. */
export const readDaysDev = (now = Date.now()): DaysDev => {
  try {
    const raw = localStorage.getItem(DAYS_DEV_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const out: DaysDev = {};
        for (const [date, devMap] of Object.entries(parsed as Record<string, unknown>)) {
          if (!devMap || typeof devMap !== 'object' || Array.isArray(devMap)) continue;
          const clean: Record<string, DayBucket> = {};
          for (const [devId, b] of Object.entries(devMap as Record<string, unknown>)) {
            const nb = normalizeBucket(b);
            if (nb) clean[devId] = nb;
          }
          if (Object.keys(clean).length > 0) out[date] = clean;
        }
        return out;
      }
    }
  } catch { /* unreadable → fall back to migrating linguaclip_days */ }

  const devId = getSyncDeviceId();
  const legacy = readDays();
  const migrated: DaysDev = {};
  for (const [date, val] of Object.entries(legacy)) {
    const nb = normalizeBucket(val);
    if (nb) migrated[date] = { [devId]: nb };
  }
  try {
    const today = dayOf(now);
    if (!migrated[today]) {
      const t = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (t?.date === today) {
        migrated[today] = { [devId]: { sec: Math.max(0, +t.sec || 0), lines: Math.max(0, +t.lines || 0) } };
      }
    }
  } catch { /* ignore unreadable legacy today */ }

  const kept = Object.keys(migrated).sort().slice(-DAYS_DEV_KEEP);
  return Object.fromEntries(kept.map(k => [k, migrated[k]]));
};

/** Persist merged `daysDev` (G-Counter max against live local, latest 35 days) and refresh `linguaclip_days` + `linguaclip_today`. */
export const applyDaysDev = (daysDev: DaysDev, now = Date.now()): void => {
  try {
    const clean: DaysDev = {};
    const mergeInto = (src: DaysDev) => {
      for (const [date, devMap] of Object.entries(src)) {
        if (!devMap || typeof devMap !== 'object' || Array.isArray(devMap)) continue;
        const buckets = clean[date] ?? (clean[date] = {});
        for (const [devId, b] of Object.entries(devMap)) {
          const nb = normalizeBucket(b);
          if (!nb) continue;
          const prev = buckets[devId];
          buckets[devId] = prev
            ? { sec: Math.max(prev.sec, nb.sec), lines: Math.max(prev.lines, nb.lines) }
            : nb;
        }
        if (Object.keys(buckets).length === 0) delete clean[date];
      }
    };
    mergeInto(readDaysDev(now));
    mergeInto(daysDev);
    const keptDevDates = Object.keys(clean).sort().slice(-DAYS_DEV_KEEP);
    const trimmedDev: DaysDev = Object.fromEntries(keptDevDates.map(k => [k, clean[k]]));
    localStorage.setItem(DAYS_DEV_KEY, JSON.stringify(trimmedDev));

    // Keep the latest 30 by date, not "30 days before today": a clock set back won't wipe the history.
    const keptDayDates = keptDevDates.slice(-KEEP);
    const projected: Days = Object.fromEntries(keptDayDates.map(k => [k, sumBuckets(trimmedDev[k])]));
    localStorage.setItem(DAYS, JSON.stringify(projected));

    const today = dayOf(now);
    const todaySum = clean[today] ? sumBuckets(clean[today]) : null;
    if (todaySum) {
      localStorage.setItem(KEY, JSON.stringify({ date: today, sec: todaySum.sec, lines: todaySum.lines }));
    }
  } catch { /* storage off: the stat just doesn't count */ }
};

export const getToday = (now = Date.now()): Today => {
  const date = dayOf(now);
  const d = readDays()[date];
  if (d) return { date, sec: +d.sec || 0, lines: +d.lines || 0 };
  try {
    // Upgrade day: today so far is only in the old key.
    const t = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (t?.date === date) return { date, sec: +t.sec || 0, lines: +t.lines || 0 };
  } catch { /* unreadable → start the day fresh */ }
  return { date, sec: 0, lines: 0 };
};

// The last n days, oldest first, today last; days with nothing are zeros.
export const getDays = (n = 7, now = Date.now()): Today[] => {
  const days = readDays();
  const out: Today[] = [];
  for (let i = n - 1; i > 0; i--) {
    const at = new Date(now);
    at.setDate(at.getDate() - i);
    const date = dayOf(at.getTime());
    out.push({ date, sec: +days[date]?.sec || 0, lines: +days[date]?.lines || 0 });
  }
  out.push(getToday(now));
  return out;
};

const bump = (sec: number, lines: number) => {
  try {
    const now = Date.now();
    const today = dayOf(now);
    const devId = getSyncDeviceId();
    const devMap = readDaysDev(now);
    const buckets = { ...(devMap[today] ?? {}) };
    const cur = buckets[devId] ?? { sec: 0, lines: 0 };
    buckets[devId] = { sec: cur.sec + sec, lines: cur.lines + lines };
    devMap[today] = buckets;
    applyDaysDev(devMap, now);
    notifySyncDirty();
  } catch { /* storage off: the stat just doesn't count */ }
};

export const countLine = () => bump(0, 1);

// One clock for the whole app: the practice page and a review round opened on
// top of it both hold it, and time still only counts once.
let holders = 0;
let timer: number | undefined;
let lastInput = 0;
// Optional external playback probe (e.g. Android native Media3 player outside DOM <audio>).
let playingProbe: (() => boolean) | null = null;
export const setPlayingProbe = (fn: (() => boolean) | null) => { playingProbe = fn; };
/** Drop the probe only if it is still this one (the next page may have set its own). */
export const clearPlayingProbe = (fn: () => boolean) => { if (playingProbe === fn) playingProbe = null; };
const isProbePlaying = () => {
  if (!playingProbe) return false;
  try { return !!playingProbe(); } catch { return false; }
};
const onInput = () => { lastInput = Date.now(); };
const tick = () => {
  const since = Date.now() - lastInput;
  const playing = Array.from(document.querySelectorAll<HTMLMediaElement>('video, audio')).some(v => !v.paused) || isProbePlaying();
  if (document.hasFocus() && (since < IDLE || (playing && since < PLAY_IDLE))) bump(TICK, 0);
};

export const usePracticeClock = () => {
  useEffect(() => {
    if (holders++ === 0) {
      lastInput = Date.now();
      window.addEventListener('keydown', onInput, true);
      window.addEventListener('pointerdown', onInput, true);
      timer = window.setInterval(tick, TICK * 1000);
    }
    return () => {
      if (--holders === 0) {
        window.removeEventListener('keydown', onInput, true);
        window.removeEventListener('pointerdown', onInput, true);
        window.clearInterval(timer);
      }
    };
  }, []);
};
