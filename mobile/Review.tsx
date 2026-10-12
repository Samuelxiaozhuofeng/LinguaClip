// Review on the phone (docs/mobile-web.md 8, design Review.dc.html): today's due sentence
// cards, then word cards (utils/review.ts, the desktop's FSRS). A sentence card plays its
// stretch of the episode, is typed and checked, then graded (the check suggests a grade by
// gradeOf; "Again" comes back at the end of this round). A word card is thought about, then
// turned (its stretch plays). Audio gone (a phone file deleted, an address that no longer
// answers): the text alone, said so. Grades are written in the background: a failed write
// is logged and never holds the round up.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Rating, type Grade } from 'ts-fsrs';
import type { ReviewCard } from '../utils/review';
import { dueQueue, getAllCards, gradeOf, previewDue, recordOutcome, schedule } from '../utils/review';
import { getVideoFromDB } from '../utils/fileSystemAccess';
import { parseSRT } from '../utils/srtParser';
import { getAudioPaddingConfig, getWordFront } from '../utils/storage';
import { hashSrt } from '../utils/aiDrills';
import { parseTransCache } from '../pro/transPrep';
import { getLang, useT } from '../utils/i18n';
import { hasKana, loadJa } from '../utils/japanese';
import { prepareSrc, readCacheText, videoSrcFromPath } from './platform/desktop';
import { Dictation, GradeBar, WordFace } from './ReviewFaces';
import { Header, btnPrimary } from './ui';

type Found = { id: string; src: string | null; trans: string | null };

// The card's audio and its line's translation (the record's current path wins, as on the desktop).
async function findCard(c: ReviewCard): Promise<Found> {
  const rec = await getVideoFromDB(c.videoId).catch(() => null);
  const path = rec?.videoPath ?? c.videoPath;
  let src: string | null = null;
  if (path) { try { await prepareSrc(path); src = videoSrcFromPath(path); } catch { src = null; } }
  let trans: string | null = null;
  if (rec && c.deck === 'line') {
    const lines = [...parseSRT(rec.subtitleText)].sort((a, b) => a.startTime - b.startTime);
    const texts = lines.map(l => l.text);
    const raw = await readCacheText(c.videoId, 'trans');
    const got = raw && parseTransCache(raw, hashSrt(texts.join('\n')), getLang() === 'en' ? 'en' : 'zh', texts.length);
    const i = lines.findIndex(l => Math.abs(l.startTime - c.start) < 0.01);
    trans = got && i >= 0 ? got[i] : null;
  }
  return { id: c.id, src, trans };
}

// One <audio> that plays a stretch and stops at its end.
function useClip() {
  const ref = useRef<HTMLAudioElement>(null);
  const stopAt = useRef<number | null>(null);
  const [bad, setBad] = useState<string | null>(null); // the src that would not load
  const play = (src: string, from: number, to: number) => {
    const a = ref.current;
    if (!a) return;
    const go = () => { a.currentTime = Math.max(0, from); stopAt.current = to; a.play().catch(() => {}); };
    if (a.getAttribute('src') !== src) { a.setAttribute('src', src); a.addEventListener('loadedmetadata', go, { once: true }); a.load(); } else go();
  };
  const stop = () => { stopAt.current = null; ref.current?.pause(); };
  useEffect(() => {
    let raf = 0;
    const tick = () => { const a = ref.current; if (a && stopAt.current !== null && a.currentTime >= stopAt.current) stop(); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); stop(); };
  }, []);
  const node = <audio ref={ref} preload="auto" onError={() => setBad(ref.current?.getAttribute('src') ?? null)} />;
  return { play, stop, node, bad };
}

export const Review: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const t = useT();
  const [queue, setQueue] = useState<ReviewCard[] | null | 'error'>(null);
  const [idx, setIdx] = useState(0);
  const [found, setFound] = useState<Found | null>(null);
  const [suggest, setSuggest] = useState<Grade | undefined>();
  const [wrong, setWrong] = useState(0);
  const [turned, setTurned] = useState(false);
  const [at, setAt] = useState(0); // when the buttons came up: the days shown are the days kept
  const front = useMemo(getWordFront, []);
  const clip = useClip();
  useEffect(() => {
    // A Japanese line is judged by its reading too: the installed dictionary first (none: as before).
    getAllCards().then(async all => {
      const q = [...dueQueue(all, 'line'), ...dueQueue(all, 'word')];
      if (q.some(c => c.deck === 'line' && hasKana(c.text))) await loadJa();
      setQueue(q);
    }, e => { console.error(e); setQueue('error'); });
  }, []);

  const list = Array.isArray(queue) ? queue : [];
  const card = list[idx] as ReviewCard | undefined;
  const done = Array.isArray(queue) && idx >= list.length;
  useEffect(() => {
    if (!card) return;
    let live = true;
    setFound(null);
    findCard(card).then(f => { if (live) setFound(f); }, () => { if (live) setFound({ id: card.id, src: null, trans: null }); });
    return () => { live = false; };
  }, [card]);
  const here = found?.id === card?.id ? found : null;
  const src = here?.src && here.src !== clip.bad ? here.src : null;
  const missing = !!here && !src;
  const playCard = () => {
    if (!card || !src) return;
    const { startPadding, endPadding } = getAudioPaddingConfig();
    clip.play(src, card.start - startPadding / 1000, card.end + endPadding / 1000);
  };
  // A sentence card plays once as it comes up; a word card only once turned (the sound gives it away).
  useEffect(() => { if (src && card?.deck === 'line') playCard(); }, [src, card?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const isWord = card?.deck === 'word';
  const grading = !!card && !!here && (isWord ? turned : missing || suggest !== undefined);
  useEffect(() => { if (grading) setAt(Date.now()); }, [grading, card]);
  const due = useMemo(() => { try { return card && at ? previewDue(card, at) : null; } catch (e) { console.error(e); return null; } }, [card, at]);

  const grade = (g: Grade) => {
    if (!card || !at) return;
    recordOutcome(card, g, at).catch(console.error);
    if (g === Rating.Again) {
      try { const again = { ...card, fsrs: schedule(card, g, at).fsrs }; setQueue(q => (Array.isArray(q) ? [...q, again] : q)); } catch (e) { console.error(e); }
    }
    clip.stop(); setSuggest(undefined); setWrong(0); setTurned(false); setAt(0); setIdx(i => i + 1);
  };

  const left = list.length - idx;
  const title = card ? t(isWord ? 'm.reviewWords' : 'm.reviewLines') : t('m.reviewTitle');
  return (
    <div className="fixed inset-0 bg-paper flex flex-col pt-[env(safe-area-inset-top)]">
      {clip.node}
      <div className="flex items-center">
        <div className="flex-1 min-w-0"><Header title={title} onBack={onBack} /></div>
        {card && <span className="pr-5 pt-2 text-[13px] text-mute">{t('m.left', { n: left })}</span>}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 flex flex-col gap-3.5">
        {queue === 'error' && <p role="alert" className="text-sm text-accent">{t('m.reviewLoadFail')}</p>}
        {Array.isArray(queue) && !list.length && <p className="pt-10 text-center text-[15px] text-mute">{t('m.reviewNone')}</p>}
        {done && list.length > 0 && <div className="pt-10 flex flex-col items-center gap-3 text-center">
          <h2 className="text-2xl font-semibold">{t('session.doneTitle')}</h2>
          <p className="text-sm text-mute leading-relaxed">{t('session.doneBody', { n: new Set(list.map(c => c.id)).size })}</p>
        </div>}
        {card && here && (
          <div className="bg-page rounded-2xl shadow-card px-4 py-[18px] flex flex-col gap-3.5">
            {!isWord && (
              <div className="flex items-center gap-2.5">
                <button aria-label={t('m.replayLine')} disabled={!src} onClick={playCard} className="w-12 h-12 rounded-full bg-ink text-white flex items-center justify-center disabled:opacity-30">▶</button>
                <span className="text-[13px] text-mute truncate">{card.videoName}</span>
              </div>
            )}
            {missing && <p className="text-[13px] text-mute">{t('m.reviewNoAudio')}</p>}
            {isWord ? <WordFace card={card} front={front} turned={turned} onTurn={() => { setTurned(true); playCard(); }} onReplay={src ? playCard : null} />
              : missing ? <><p className="font-serif text-[20px] leading-relaxed">{card.text}</p>{here.trans && <p className="text-sm text-mute">{here.trans}</p>}</>
              : <Dictation key={`${idx}-${card.id}`} card={card} trans={here.trans} onChecked={c => { setWrong(c.wrong); setSuggest(gradeOf({ correct: c.correct, helped: false })); }} />}
          </div>
        )}
        {grading && !isWord && !missing && <p className="text-[13px] text-mute text-center">{suggest === Rating.Again ? t('m.wrongN', { n: wrong }) : t('m.allRight')}</p>}
      </div>
      <div className="px-5 pt-2 pb-[max(20px,env(safe-area-inset-bottom))]">
        {grading && at ? <GradeBar due={due} now={at} suggest={isWord || missing ? undefined : suggest} onGrade={grade} />
          : (done || (Array.isArray(queue) && !list.length)) && <button className={`${btnPrimary} w-full`} onClick={onBack}>{t('session.back')}</button>}
      </div>
    </div>
  );
};
