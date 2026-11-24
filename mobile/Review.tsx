// Review on the phone (docs/mobile-web.md 8, docs/android-roadmap.md M2.5, docs/review.md):
// today's due sentence cards, then word cards (FSRS). Supports "Got it" (masteredBtn),
// delete-with-undo (holding standalone clips during the 6s undo window), skip / mid-session
// defer (utils/reviewDefer.ts), front/back word speaker (speakWordAux -> clip fallback),
// clips/ fallback when original audio is missing, and entry to the full-screen CardLibrary.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Rating, type Grade } from 'ts-fsrs';
import type { ReviewCard, Removed } from '../utils/review';
import {
  deckCounts,
  dueQueue,
  getAllCards,
  gradeOf,
  previewDue,
  recordOutcome,
  removeCard,
  restoreCard,
  schedule,
  setMastered,
  subscribeCards,
} from '../utils/review';
import { deferCard } from '../utils/reviewDefer';
import { cardLangs, type DeckLang } from '../utils/deckLang';
import { detectLang, type DictLang } from '../utils/dictionary';
import { getAllVideosFromDB } from '../utils/fileSystemAccess';
import { getAudioPaddingConfig, getMasteredBtn, getWordFront } from '../utils/storage';
import { useT } from '../utils/i18n';
import { hasKana, loadJa } from '../utils/japanese';
import { countLine, usePracticeClock } from '../utils/today';
import { loadWords } from '../utils/wordTimes';
import { CAN_SPEAK_WORD, speakWordAux, stopWordAux } from './platform/wordPlatform';
import { holdCardClips, refillClipsAfterRestore, warmClipsRuntime } from './review/nativeRuntime';
import { finishedCardCount, removeCardFromQueue, shouldDeferCard } from './review/cardFilter';
import { findCardMedia, locateWordInLine, useReviewClip, type FoundCardMedia } from './review/useReviewClip';
import { UndoToast } from './review/UndoToast';
import { Dictation, GradeBar, WordFace } from './ReviewFaces';
import { Header, btnPlain, btnPrimary } from './ui';

type Held = Removed & { release: () => void };
type UndoState = { id: string; n: number; gone?: Promise<Held | null> };

export const Review: React.FC<{ onBack?: () => void; onOpenLibrary?: () => void }> = ({ onBack, onOpenLibrary }) => {
  const t = useT();
  usePracticeClock();
  const [queue, setQueue] = useState<ReviewCard[] | null | 'error'>(null);
  const [langs, setLangs] = useState<Map<string, DeckLang>>(() => new Map());
  const [totalDue, setTotalDue] = useState<number>(0);
  const [round, setRound] = useState(0);
  const [idx, setIdx] = useState(0);
  const [found, setFound] = useState<FoundCardMedia | null>(null);
  const [suggest, setSuggest] = useState<Grade | undefined>();
  const [wrong, setWrong] = useState(0);
  const [turned, setTurned] = useState(false);
  const [at, setAt] = useState(0);
  const [speaking, setSpeaking] = useState(false);
  const [undo, setUndo] = useState<UndoState | null>(null);
  const [more, setMore] = useState<ReviewCard[] | null>(null);
  const [restored, setRestored] = useState(0);

  const front = useMemo(getWordFront, []);
  const masteredBtn = useMemo(getMasteredBtn, []);
  const repeats = useRef(new Set<string>());
  const removed = useRef(new Set<string>());
  const undone = useRef(new Set<Promise<Held | null>>());
  const writes = useRef<Promise<unknown>[]>([]);
  const clip = useReviewClip();

  useEffect(() => { warmClipsRuntime(); }, []);

  useEffect(() => {
    let alive = true;
    Promise.all([getAllCards(), getAllVideosFromDB().catch(() => [])]).then(async ([all, recs]) => {
      if (!alive) return;
      const counts = deckCounts(all);
      setTotalDue(counts.line.due + counts.word.due);
      setLangs(cardLangs(all, recs));
      const q = [...dueQueue(all, 'line'), ...dueQueue(all, 'word')];
      if (q.some(c => c.deck === 'line' && hasKana(c.text))) await loadJa();
      if (alive) setQueue(q);
    }, e => { console.error(e); if (alive) setQueue('error'); });

    const unsub = subscribeCards(() => {
      getAllCards().then(all => {
        if (!alive) return;
        const counts = deckCounts(all);
        setTotalDue(counts.line.due + counts.word.due);
      }, console.error);
    });
    return () => { alive = false; unsub(); };
  }, []);

  const list = Array.isArray(queue) ? queue : [];
  const card = list[idx] as ReviewCard | undefined;
  const done = Array.isArray(queue) && idx >= list.length;

  useEffect(() => {
    if (!card) return;
    let live = true;
    setFound(null);
    setSpeaking(false);
    findCardMedia(card).then(
      f => { if (live) setFound(f); },
      () => { if (live) setFound({ id: card.id, src: null, offset: 0, trans: null }); },
    );
    return () => { live = false; stopWordAux(); };
  }, [card]);

  const here = found?.id === card?.id ? found : null;
  const src = here?.src && here.src !== clip.bad ? here.src : null;
  const missing = !!here && !src;
  const isWord = card?.deck === 'word';

  const playCard = () => {
    if (!card || !src || !here) return;
    const { startPadding, endPadding } = getAudioPaddingConfig();
    clip.play(
      src,
      Math.max(0, card.start - here.offset - startPadding / 1000),
      Math.max(0.1, card.end - here.offset + endPadding / 1000),
    );
  };

  const shownCard = useRef<string | undefined>(undefined);
  shownCard.current = card?.id;

  // Sentence cards auto-play once when shown; word cards wait until turned.
  useEffect(() => { if (src && card?.deck === 'line') playCard(); }, [src, card?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const cardDictLang = useMemo((): DictLang | null => {
    if (!card) return null;
    const l = langs.get(card.id);
    if (l && l !== 'other') return l;
    return detectLang([card.text, card.word ?? '']);
  }, [card, langs]);

  const speakWord = async () => {
    if (!card?.word) return;
    clip.stop();
    setSpeaking(true);
    const id = card.id;
    const stale = () => shownCard.current !== id; // the learner moved on while the sound was fetched
    try {
      const ok = await speakWordAux(card.word, cardDictLang);
      if (ok || stale()) return;
      if (!src || !here) return;
      const words = await loadWords(card.videoId).catch(() => null);
      const spot = locateWordInLine({ text: card.text, startTime: card.start, endTime: card.end }, card.word, words);
      if (stale()) return;
      if (spot) {
        clip.play(src, Math.max(0, spot.from - here.offset), Math.max(0.1, spot.to - here.offset));
      } else {
        playCard();
      }
    } finally {
      if (!stale()) setSpeaking(false);
    }
  };

  const canSpeakWord = !!card?.word && (CAN_SPEAK_WORD || !!src);
  const grading = !!card && !!here && (isWord ? turned : missing || suggest !== undefined);
  useEffect(() => { if (grading) setAt(Date.now()); }, [grading, card]);
  const due = useMemo(() => {
    try { return card && at ? previewDue(card, at) : null; }
    catch (e) { console.error(e); return null; }
  }, [card, at]);

  // Defer the currently shown card if left without grading (skip / tab switch / unmount).
  const deferNow = () => {
    if (shouldDeferCard(card, done, repeats.current)) deferCard(card!.id);
  };
  const leaving = useRef(deferNow);
  leaving.current = deferNow;
  const unmountTimer = useRef(0);
  useEffect(() => {
    window.clearTimeout(unmountTimer.current);
    return () => {
      stopWordAux();
      unmountTimer.current = window.setTimeout(() => leaving.current());
    };
  }, []);

  const advance = () => {
    clip.stop();
    stopWordAux();
    setSuggest(undefined);
    setWrong(0);
    setTurned(false);
    setAt(0);
    setIdx(i => i + 1);
  };

  const skip = () => {
    if (!card) return;
    deferNow();
    advance();
  };

  const grade = (g: Grade) => {
    if (!card || !at) return;
    writes.current.push(recordOutcome(card, g, at).catch(console.error));
    if (!isWord && !repeats.current.has(card.id)) countLine();
    if (g === Rating.Again) {
      repeats.current.add(card.id);
      try {
        const again = { ...card, fsrs: schedule(card, g, at).fsrs };
        setQueue(q => (Array.isArray(q) ? [...q, again] : q));
      } catch (e) { console.error(e); }
    }
    advance();
  };

  // "Got it" (docs/review.md): mark mastered, skip grading, show 6s undo bar.
  const master = () => {
    if (!card) return;
    writes.current.push(setMastered(card.id, true).catch(console.error));
    if (!repeats.current.has(card.id)) countLine();
    setUndo(u => ({ id: card.id, n: (u?.n ?? 0) + 1 }));
    advance();
  };

  // Delete in review (docs/review.md): immediate delete, hold standalone clips until undo expires.
  const removeCurrent = () => {
    if (!card) return;
    const targetId = card.id;
    const gone = removeCard(targetId)
      .then(async c => (c ? { ...c, release: await holdCardClips(c.card) } : null))
      .catch(e => { console.error(e); return null; });
    writes.current.push(gone);
    setQueue(q => (Array.isArray(q) ? removeCardFromQueue(q, idx, targetId) : q));
    removed.current.add(targetId);
    setUndo(u => ({ id: targetId, n: (u?.n ?? 0) + 1, gone }));
    advance();
  };

  const handleUndo = () => {
    if (!undo) return;
    const cur = undo;
    writes.current.push(
      cur.gone
        ? cur.gone.then(c => c && restoreCard(c).then(
            () => { refillClipsAfterRestore().catch(console.error).finally(c.release); },
            e => { c.release(); throw e; },
          )).catch(console.error)
        : setMastered(cur.id, false).catch(console.error),
    );
    if (cur.gone) {
      undone.current.add(cur.gone);
      removed.current.delete(cur.id);
    }
    setRestored(n => n + 1);
    setUndo(null);
  };

  useEffect(() => {
    if (!undo) return;
    const timerId = window.setTimeout(() => setUndo(null), 6000);
    const gone = undo.gone;
    return () => {
      window.clearTimeout(timerId);
      if (gone && !undone.current.has(gone)) void gone.then(c => c?.release());
    };
  }, [undo]);

  // Round finished: recompute remaining due cards after pending writes settle.
  useEffect(() => {
    if (!done || list.length === 0) return;
    let cancelled = false;
    setMore(null);
    Promise.allSettled(writes.current)
      .then(() => getAllCards())
      .then(all => {
        if (cancelled) return;
        setMore([...dueQueue(all, 'line'), ...dueQueue(all, 'word')]);
      })
      .catch(e => { console.error(e); if (!cancelled) setMore([]); });
    return () => { cancelled = true; };
  }, [done, list.length, restored]);

  const startAnotherRound = () => {
    if (!more?.length) return;
    writes.current = [];
    repeats.current.clear();
    removed.current.clear();
    setQueue(more);
    setMore(null);
    setRound(r => r + 1);
    setIdx(0);
    setSuggest(undefined);
    setWrong(0);
    setTurned(false);
    setAt(0);
  };

  const canMaster = masteredBtn && !isWord;
  const title = card ? t(isWord ? 'm.reviewWords' : 'm.reviewLines') : t('m.reviewTitle');
  const doneCount = finishedCardCount(list, removed.current);

  return (
    <div className={onBack ? 'fixed inset-0 bg-paper flex flex-col pt-[env(safe-area-inset-top)]' : 'flex-1 min-h-0 flex flex-col bg-paper'}>
      {clip.node}
      {undo && (
        <UndoToast
          key={undo.n}
          message={t(undo.gone ? 'review.deletedToast' : 'review.masteredToast')}
          onUndo={handleUndo}
        />
      )}

      <div className="flex items-center gap-2 pr-3">
        <div className="flex-1 min-w-0 flex items-center gap-2">
          {onBack
            ? <Header title={title} onBack={() => { deferNow(); onBack(); }} />
            : <h1 className="pt-4 pl-5 pb-2 text-[17px] font-semibold truncate">{title}</h1>}
          <span className="mt-2 shrink-0 px-2.5 py-0.5 rounded-full bg-shade text-[12px] font-medium text-ink tabular-nums">
            {t('m.duePill', { n: totalDue })}
          </span>
        </div>
        {onOpenLibrary && (
          <button
            type="button"
            onClick={() => { deferNow(); onOpenLibrary(); }}
            className="mt-2 shrink-0 min-h-[44px] px-3 rounded-full text-[14px] font-medium text-ink active:bg-shade flex items-center gap-0.5"
          >
            <span>{t('m.cardLib')}</span>
            <span aria-hidden="true" className="text-mute text-base leading-none">›</span>
          </button>
        )}
      </div>

      {card && (
        <div className="px-5 pt-1 flex flex-col gap-1.5">
          <div className="h-1 rounded-full bg-line overflow-hidden">
            <div className="h-full rounded-full bg-ink transition-all" style={{ width: `${(idx / Math.max(1, list.length)) * 100}%` }} />
          </div>
          <div className="flex items-center justify-between text-[13px] text-mute">
            <span className="tabular-nums">{t('session.progress', { current: idx + 1, total: list.length })}</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={skip}
                className="min-h-[44px] px-3 rounded-full text-[13px] text-mute active:bg-shade"
              >
                {t('session.skip')}
              </button>
              <button
                type="button"
                onClick={removeCurrent}
                aria-label={t('review.delete')}
                className="min-h-[44px] min-w-[44px] px-2.5 rounded-full text-[13px] text-mute active:bg-shade flex items-center justify-center gap-1"
              >
                <Trash2 size={15} />
                <span>{t('review.delete')}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-3 flex flex-col gap-3.5">
        {queue === 'error' && <p role="alert" className="text-sm text-accent">{t('m.reviewLoadFail')}</p>}
        {Array.isArray(queue) && !list.length && (
          <div className="pt-12 flex flex-col items-center gap-4 text-center">
            <p className="text-[15px] text-mute">{t('m.reviewNone')}</p>
            {onOpenLibrary && (
              <button type="button" onClick={onOpenLibrary} className={`${btnPlain} px-6`}>
                {t('m.cardLib')}
              </button>
            )}
          </div>
        )}
        {done && list.length > 0 && (
          <div className="pt-10 flex flex-col items-center gap-3 text-center">
            <h2 className="text-2xl font-semibold">{t('session.doneTitle')}</h2>
            <p className="text-sm text-mute leading-relaxed">{t('session.doneBody', { n: doneCount })}</p>
            <div className="pt-3 flex flex-col gap-2.5 w-full max-w-xs">
              {!!more?.length && (
                <button type="button" onClick={startAnotherRound} className={`${btnPrimary} w-full`}>
                  {t('session.doneMore', { n: more.length })}
                </button>
              )}
              {onOpenLibrary && (
                <button type="button" onClick={onOpenLibrary} className={`${btnPlain} w-full`}>
                  {t('m.cardLib')}
                </button>
              )}
            </div>
          </div>
        )}
        {card && here && (
          <div className="bg-page rounded-2xl shadow-card px-4 py-[18px] flex flex-col gap-3.5">
            {!isWord && (
              <div className="flex items-center gap-2.5">
                <button type="button" aria-label={t('m.replayLine')} disabled={!src} onClick={playCard} className="w-12 h-12 rounded-full bg-ink text-white flex items-center justify-center disabled:opacity-30">▶</button>
                <span className="text-[13px] text-mute truncate">{card.videoName}</span>
              </div>
            )}
            {missing && <p className="text-[13px] text-mute">{t('m.reviewNoAudio')}</p>}
            {isWord ? (
              <WordFace
                card={card}
                front={front}
                turned={turned}
                onTurn={() => { setTurned(true); playCard(); }}
                onReplay={src ? playCard : null}
                onSpeakWord={canSpeakWord ? () => { void speakWord(); } : null}
                speaking={speaking}
              />
            ) : missing ? (
              <>
                <p className="font-serif text-[20px] leading-relaxed">{card.text}</p>
                {here.trans && <p className="text-sm text-mute">{here.trans}</p>}
              </>
            ) : (
              <Dictation
                key={`${round}-${idx}-${card.id}`}
                card={card}
                trans={here.trans}
                onChecked={c => { setWrong(c.wrong); setSuggest(gradeOf({ correct: c.correct, helped: false })); }}
              />
            )}
          </div>
        )}
        {grading && !isWord && !missing && (
          <p className="text-[13px] text-mute text-center">
            {suggest === Rating.Again ? t('m.wrongN', { n: wrong }) : t('m.allRight')}
          </p>
        )}
      </div>

      <div className={onBack ? 'px-5 pt-2 pb-[max(20px,env(safe-area-inset-bottom))]' : 'px-5 pt-2 pb-4'}>
        {grading && at ? (
          <GradeBar
            due={due}
            now={at}
            suggest={isWord || missing ? undefined : suggest}
            onGrade={grade}
            canMaster={canMaster}
            onMaster={master}
          />
        ) : onBack && (done || (Array.isArray(queue) && !list.length)) && (
          <button type="button" className={`${btnPrimary} w-full`} onClick={onBack}>{t('session.back')}</button>
        )}
      </div>
    </div>
  );
};
