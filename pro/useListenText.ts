import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { Subtitle, VideoRecord } from '../types';
import type { WatchSubs } from '../utils/storage';
import { canCloze } from '../utils/aiDrills';
import { getLang } from '../utils/i18n';
import { getTransJob, prepareTrans, subscribeTrans } from './transPrep';
import { usePracticeClock } from '../utils/today';

// The listening page's transcript: kept on the line being said until the reader scrolls away
// ("back to the current line", or 5 s without scrolling while it plays, brings it back), and
// each line's translation, opened one by one.
export function useListenText(record: VideoRecord, lines: Subtitle[], audio: RefObject<HTMLAudioElement | null>, curId: number | null, effMode: WatchSubs, sec: number, playing: boolean) {
  // The page's practice clock lives here: ListenPage is at its 500-line cap, and this hook
  // is held exactly as long as the page is open (utils/today.ts, docs/stats.md).
  usePracticeClock();
  const scroller = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  useEffect(() => {
    if (!follow || curId === null || effMode === 'hide') return;
    scroller.current?.querySelector(`[data-line="${curId}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [curId, follow, effMode, sec]);
  // Back by itself after 5 s of no scrolling (a moving mouse counts as not done: the word
  // it is aiming at stays put), only while playing — paused, the reader is reading.
  const backTimer = useRef(0);
  const armBack = useCallback(() => {
    window.clearTimeout(backTimer.current);
    backTimer.current = window.setTimeout(() => { if (audio.current && !audio.current.paused) setFollow(true); }, 5000);
  }, [audio]);
  useEffect(() => {
    if (!follow && playing) armBack();
    return () => window.clearTimeout(backTimer.current);
  }, [follow, playing, armBack]);
  const leave = () => { setFollow(false); armBack(); };

  const [hasTrans, setHasTrans] = useState(canCloze); // no AI: still there when translations came ready-made (docs/starter.md)
  const [trans, setTrans] = useState<(string | null)[] | null>(null);
  const [transBusy, setTransBusy] = useState(false);
  const [openT, setOpenT] = useState<Set<number>>(new Set());
  useEffect(() => subscribeTrans(() => { const job = getTransJob(record.id); if (job) setTrans(job.lines); }), [record.id]);
  useEffect(() => { if (!hasTrans) prepareTrans(record.id, lines.map(l => l.text), getLang() === 'en' ? 'en' : 'zh').then(l => { if (l.some(Boolean)) { setTrans(l); setHasTrans(true); } }).catch(() => {}); }, [record.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const onTrans = useCallback((line: Subtitle) => {
    if (!transBusy && !(trans && trans.every(Boolean))) {
      setTransBusy(true);
      prepareTrans(record.id, lines.map(l => l.text), getLang() === 'en' ? 'en' : 'zh').then(setTrans).catch(console.error).finally(() => setTransBusy(false));
    }
    setOpenT(s => { const n = new Set(s); if (n.has(line.id)) n.delete(line.id); else n.add(line.id); return n; });
  }, [trans, transBusy, record.id, lines]);

  return { scroller, follow, setFollow, armBack, leave, hasTrans, trans, transBusy, openT, onTrans };
}
