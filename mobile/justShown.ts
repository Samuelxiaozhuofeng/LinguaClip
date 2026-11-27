// Tap guard for buttons that appear or move under the user's finger (docs/android.md「练习页省空间」):
// Cloze's "Check" turning into "Next" in place, or a line's save row jumping to the next line during
// continuous play. A tap within JUST_SHOWN_MS of the change was aimed at what was there before.
import { useEffect, useRef } from 'react';

export const JUST_SHOWN_MS = 450;

/** Returns `tooSoon()`: true for JUST_SHOWN_MS after `shown` turns true (or `key` changes while shown). */
export function useJustShown(shown: boolean, key?: unknown): () => boolean {
  const at = useRef(0);
  useEffect(() => { if (shown) at.current = performance.now(); }, [shown, key]);
  return () => shown && performance.now() - at.current < JUST_SHOWN_MS;
}
