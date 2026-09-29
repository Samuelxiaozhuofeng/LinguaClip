import { useSyncExternalStore } from 'react';

// Line loop, shared by the practice page and review's sentence cards (docs/loop.md):
// on = replay the line after a short pause until it has played `times` times (0 = forever).
// The first, automatic play counts.

export type LoopTimes = 0 | 3 | 5 | 10;
export const LOOP_TIMES: LoopTimes[] = [3, 5, 10, 0];
export const LOOP_GAP_MS = 1000;
type Loop = { on: boolean; times: LoopTimes };

const KEY = 'linguaclip_loop';

function load(): Loop {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { on: raw?.on === true, times: LOOP_TIMES.includes(raw?.times) ? raw.times : 0 };
  } catch { return { on: false, times: 0 }; }
}

let state = load();
const listeners = new Set<() => void>();

function set(next: Partial<Loop>) {
  state = { ...state, ...next };
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* localStorage unavailable */ }
  listeners.forEach(l => l());
}

export const getLoop = () => state;
export const setLoopOn = (on: boolean) => set({ on });
export const setLoopTimes = (times: LoopTimes) => set({ times });

// After `plays` full plays of this line: play it again?
export const loopMore = (plays: number) => state.on && (state.times === 0 || plays < state.times);

// A review round open on top of the practice page holds the page's own loop.
let held = 0;
export const holdPageLoop = () => { held++; return () => { held--; }; };
export const pageLoopHeld = () => held > 0;

export function useLoop(): Loop {
  return useSyncExternalStore(
    l => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => state, () => state,
  );
}
