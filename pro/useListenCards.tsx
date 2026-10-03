import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { VideoRecord } from '../types';
import { IntroCard } from './ListenCoach';
import { KeywordModal } from '../components/KeywordCard';
import { canCloze } from '../utils/aiDrills';
import { getWatchPrefs, saveWatchPrefs } from '../utils/storage';
import { keywordsOn, keywordsSeen, markKeywordsSeen, prepareKeywords, readKeywords, type Keywords } from '../utils/keywordPrep';

// The listening page's opening cards (docs/keywords.md): the how-it-works card (first visit
// ever, or "?") and then this episode's keywords (first time they are there for it). While
// either is up — or the keywords are still being read — nothing plays and the keys are the
// card's: `blocking` is what the page's load, play and keys ask, and the page is inert (`open`).
// Once both are gone, `onClear`.
// Keywords not made yet are made in the background; they show on a later visit.
export function useListenCards(record: VideoRecord, onClear: () => void) {
  const [intro, setIntro] = useState(() => !getWatchPrefs().listenIntro);
  const [kw, setKw] = useState<Keywords | 'wait' | null>(() => (keywordsOn() && !keywordsSeen(record.id) ? 'wait' : null));
  useEffect(() => {
    if (!keywordsOn()) return;
    let live = true;
    readKeywords(record.id, record.subtitleText).then(saved => {
      if (!live) return;
      if (!saved && canCloze()) prepareKeywords(record.id, record.subtitleText).catch(() => {});
      setKw(k => (k === 'wait' ? saved : k));
    }, () => { if (live) setKw(k => (k === 'wait' ? null : k)); });
    return () => { live = false; };
  }, [record.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = !intro && kw !== null && kw !== 'wait' ? kw : null;
  useEffect(() => { if (shown) markKeywordsSeen(record.id); }, [!!shown]); // eslint-disable-line react-hooks/exhaustive-deps

  const blocking = useRef(false);
  blocking.current = intro || kw !== null;
  const was = useRef(blocking.current);
  const clear = useRef(onClear);
  clear.current = onClear;
  useEffect(() => {
    if (was.current && !blocking.current) clear.current();
    was.current = blocking.current;
  });

  const closeIntro = () => { setIntro(false); saveWatchPrefs({ listenIntro: true }); };
  // Outside the page, which goes inert meanwhile: Tab can't reach its buttons behind the card.
  const node = createPortal(<>
    {intro && <IntroCard onClose={closeIntro} />}
    {shown && <KeywordModal record={record} data={shown} onClose={() => setKw(null)} />}
  </>, document.body);
  return { blocking, open: blocking.current, intro, closeIntro, help: () => setIntro(true), node };
}
