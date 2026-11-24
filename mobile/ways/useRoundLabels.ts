// AI custom (mobile/ways/Custom.tsx): AI grades that land while a round is under way wait for the
// next round, so the line being typed never swaps out under the learner.
import { useCallback, useRef, useState } from 'react';
import type { LineLabel } from '../../utils/customPick';

export function useRoundLabels() {
  const [labels, setNow] = useState<LineLabel[] | null>(null);
  const late = useRef<LineLabel[] | null>(null);
  const busy = useRef(false);
  /** Grades arrived: use them now, or after this round if the learner has started it. */
  const offer = useCallback((res: LineLabel[] | null) => {
    if (busy.current) late.current = res;
    else setNow(res);
  }, []);
  /** The learner typed, checked or moved on: this round's lines are fixed. */
  const markBusy = useCallback(() => { busy.current = true; }, []);
  /** A new round starts: grades that came late take effect. */
  const newRound = useCallback(() => {
    busy.current = false;
    if (late.current) { setNow(late.current); late.current = null; }
  }, []);
  /** Another episode: forget both. */
  const reset = useCallback(() => { busy.current = false; late.current = null; }, []);
  return { labels, offer, markBusy, newRound, reset };
}
