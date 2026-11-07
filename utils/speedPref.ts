import { useCallback, useState } from 'react';

// Playback speeds of the three players and the one each last used (docs/phrase.md「倍速」).
// Each place remembers its own: their choices differ, so one shared value would not fit.

export type SpeedPlace = 'dictation' | 'watch' | 'listen';

export const SPEEDS: Record<SpeedPlace, readonly number[]> = {
  dictation: [0.5, 0.75, 1, 1.25, 1.5, 2],
  watch: [0.75, 0.9, 1, 1.25, 1.5, 2],
  listen: [0.75, 0.9, 1, 1.25, 1.5, 2],
};

const key = (place: SpeedPlace) => `linguaclip_speed_${place}`;

// Anything not among this place's choices (edited by hand, an older set of choices) is 1×.
export function getSpeed(place: SpeedPlace): number {
  try {
    const v = Number(localStorage.getItem(key(place)));
    return SPEEDS[place].includes(v) ? v : 1;
  } catch {
    return 1;
  }
}

export function saveSpeed(place: SpeedPlace, speed: number): void {
  try { localStorage.setItem(key(place), String(speed)); } catch { /* localStorage unavailable */ }
}

// Only a pick goes to storage: the Anki recorder sets the element's rate to 1 directly, never through here.
export function useSpeed(place: SpeedPlace): [number, (speed: number) => void] {
  const [speed, setSpeed] = useState(() => getSpeed(place));
  const pick = useCallback((s: number) => { setSpeed(s); saveSpeed(place, s); }, [place]);
  return [speed, pick];
}
