import { useEffect } from 'react';

// Practice time and lines per day, for the home screen's week (docs/stats.md). On this
// machine only: `linguaclip_days` keeps the latest 30 days; `linguaclip_today` is still
// written in its old shape so an older build keeps today's count.

const KEY = 'linguaclip_today';
const DAYS = 'linguaclip_days';
const KEEP = 30;
const TICK = 5;         // seconds per clock tick
const IDLE = 60_000;    // no key / click for this long = not practising
const PLAY_IDLE = 15 * 60_000; // media playing still counts, but only this long after the last key / click

export interface Today { date: string; sec: number; lines: number }
type Days = Record<string, { sec: number; lines: number }>;

const dayOf = (now: number) => new Date(now).toLocaleDateString('sv'); // local YYYY-MM-DD

const readDays = (): Days => {
  try {
    const d = JSON.parse(localStorage.getItem(DAYS) || '{}');
    if (d && typeof d === 'object' && !Array.isArray(d)) return d;
  } catch { /* unreadable → start the history fresh */ }
  return {};
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
    const t = getToday();
    const next = { ...t, sec: t.sec + sec, lines: t.lines + lines };
    localStorage.setItem(KEY, JSON.stringify(next));
    const days = { ...readDays(), [t.date]: { sec: next.sec, lines: next.lines } };
    // Keep the latest 30 by date, not "30 days before today": a clock set back won't wipe the history.
    const kept = Object.keys(days).sort().slice(-KEEP);
    localStorage.setItem(DAYS, JSON.stringify(Object.fromEntries(kept.map(k => [k, days[k]]))));
  } catch { /* storage off: the stat just doesn't count */ }
};

export const countLine = () => bump(0, 1);

// One clock for the whole app: the practice page and a review round opened on
// top of it both hold it, and time still only counts once.
let holders = 0;
let timer: number | undefined;
let lastInput = 0;
const onInput = () => { lastInput = Date.now(); };
const tick = () => {
  const since = Date.now() - lastInput;
  const playing = Array.from(document.querySelectorAll<HTMLMediaElement>('video, audio')).some(v => !v.paused);
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
