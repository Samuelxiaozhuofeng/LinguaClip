import { useEffect, useSyncExternalStore } from 'react';
import { ReviewCard, deckCounts, getAllCards, subscribeCards } from '../utils/review';

// One shared "what is due" snapshot for the top bar's badges (Shell) and home's "Today" bar
// (docs/stats.md): every card read once, counted at one `now`, and that same `now` is what the
// review queue is cut at. Re-read when one of them mounts, when cards change, and when the
// window comes back (visible / focused), so the two always show the same numbers.
export type DueSnapshot = { cards: ReviewCard[]; now: number; line: number; word: number };

let snap: DueSnapshot | null = null; // null: not read yet, or unreadable
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(fn => fn());

const refresh = () => {
  const mine = ++seq;
  getAllCards().then(cards => {
    if (mine !== seq) return;
    const now = Date.now();
    const n = deckCounts(cards, now);
    snap = { cards, now, line: n.line.due, word: n.word.due };
    emit();
  }).catch(e => {
    if (mine !== seq) return;
    console.error(e);
    snap = null;
    emit();
  });
};

let detach: (() => void) | null = null;
const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  if (!detach) {
    const off = subscribeCards(refresh);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', refresh);
    detach = () => { off(); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('focus', refresh); };
  }
  return () => {
    listeners.delete(fn);
    if (!listeners.size && detach) { detach(); detach = null; }
  };
};

// `on` false: no read, no listening (a switched-off feature reads nothing).
export const useDueSnapshot = (on = true): DueSnapshot | null => {
  const s = useSyncExternalStore(on ? subscribe : noop, () => (on ? snap : null));
  useEffect(() => { if (on) refresh(); }, [on]);
  return s;
};
const noop = () => () => {};
