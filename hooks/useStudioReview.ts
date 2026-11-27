import { useEffect, useRef, useState } from 'react';
import { Subtitle } from '../types';
import { getAutoAddReview } from '../utils/autoAddReview';
import { addLine, addWord, clearMastered, getAllCards, hasAudio, lineCardId, Reason, ReviewCard, undoAddLine, type AddLineResult } from '../utils/review';

// Practice-page review recording: adds stuck lines (or offers a manual button),
// tracks the 5-second undo toast for auto-adds, keeps looked-up words, and opens
// a redo session for lines missed in the current section.
export function useStudioReview(params: {
  videoId: string | null;
  videoName: string;
  currentSub: Subtitle | undefined;
  currentSectionIndex: number;
  isPlaying: boolean;
  onPause: () => void;
}) {
  const { videoId, videoName, currentSub, currentSectionIndex, isPlaying, onPause } = params;
  const [stuck, setStuck] = useState<Set<string>>(new Set());
  const [retry, setRetry] = useState<ReviewCard[] | null>(null);
  const [offer, setOffer] = useState<{ reason: Reason; start: number } | null>(null);
  const [autoUndo, setAutoUndo] = useState<{ res: AddLineResult; reason: Reason; n: number } | null>(null);
  // Writes still in flight, so "redo" can wait for the last line's card instead of missing it.
  const pending = useRef(new Set<Promise<unknown>>());

  useEffect(() => setStuck(new Set()), [currentSectionIndex]);

  const record = (reason: Reason, force = false) => {
    if (!currentSub || !videoId) return;
    const autoAdd = getAutoAddReview();
    if (!autoAdd && !force) {
      clearMastered(videoId, currentSub.startTime).catch(console.error); // stuck again: back into review (docs/review.md)
      setOffer({ reason, start: currentSub.startTime });
      return;
    }
    setOffer(null);
    const p = addLine({ videoId, videoName, text: currentSub.text, start: currentSub.startTime, end: currentSub.endTime }, reason)
      .then(res => {
        if (!force && res && (res.created || res.addedReason || res.prevMastered !== undefined)) {
          setAutoUndo(u => ({ res, reason, n: (u?.n ?? 0) + 1 }));
        }
      })
      .catch(console.error);
    pending.current.add(p);
    p.finally(() => pending.current.delete(p));
    setStuck(prev => new Set(prev).add(lineCardId(videoId, currentSub.startTime)));
  };

  const undoAutoAdd = () => {
    if (!autoUndo) return;
    const { res, reason } = autoUndo;
    setAutoUndo(null);
    const p = undoAddLine(res, reason).then(outcome => {
      if (outcome === 'deleted') setStuck(prev => { const next = new Set(prev); next.delete(res.id); return next; });
    }).catch(console.error);
    pending.current.add(p);
    p.finally(() => pending.current.delete(p));
  };

  const keepWord = (word: string, definition: string, example: string, ai: string) => {
    if (!currentSub || !videoId) return;
    addWord({ videoId, videoName, text: currentSub.text, start: currentSub.startTime, end: currentSub.endTime }, word, definition, example, ai).catch(console.error);
  };

  const openRetry = () => {
    if (isPlaying) onPause();
    Promise.allSettled([...pending.current])
      .then(() => getAllCards())
      .then(all => setRetry(all.filter(c => stuck.has(c.id) && hasAudio(c))))
      .catch(console.error);
  };

  const clearStuck = () => setStuck(new Set());
  const closeRetry = () => { setRetry(null); setStuck(new Set()); };
  const dismissUndo = () => setAutoUndo(null);

  return { stuck, retry, offer, autoUndo, record, undoAutoAdd, dismissUndo, keepWord, openRetry, clearStuck, closeRetry };
}
