import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PracticeMode } from '../types';
import { Rating, type Grade } from 'ts-fsrs';
import { ReviewCard, recordOutcome, repointVideo, getAllCards, dueQueue, addWord, gradeOf, previewDue, schedule } from '../utils/review';
import { patchVideoRecord } from '../utils/videoStorage';
import { getAudioPaddingConfig, getWordFront } from '../utils/storage';
import { videoSrcFromPath, pickVideoPath } from '../utils/desktop';
import { findSource, type Source } from '../utils/clips';
import { Play, Repeat, RotateCcw, X } from 'lucide-react';
import { Btn } from './ui';
import { IS_WINDOWS } from '../utils/platform';
import DictationLine from './DictationLine';
import DefinitionPanel from './DefinitionPanel';
import { WordFace, GradeBar } from './WordReview';
import { matches, formatCombo, getCombo } from '../utils/shortcuts';
import { useLoop, getLoop, setLoopOn, loopMore, holdPageLoop, LOOP_GAP_MS } from '../utils/loop';
import { useLookup } from '../hooks/useLookup';
import { detectLang } from '../utils/dictionary';
import type { DeckLang } from '../utils/deckLang';
import { useT } from '../utils/i18n';
import { countLine, usePracticeClock } from '../utils/today';
import { hasKana, jaReady, useJaVersion } from '../utils/japanese';
import { settleSplits } from '../utils/jaSegments';
import { playSpan, useTimedWords } from '../utils/wordTimes';

// A review round: one card at a time over the whole window (clip on top, a white
// sheet below, like the practice page). A sentence card is dictated, a word card is
// thought about then turned; either ends on the four FSRS buttons, and "Again" comes
// back at the end of the round. Also opened on top of the practice page, so it owns its keys.

// The line's audio with the user's lead-in / tail padding.
export const clipOf = (c: ReviewCard): [number, number] => {
  const { startPadding, endPadding } = getAudioPaddingConfig();
  return [Math.max(0, c.start - startPadding / 1000), c.end + endPadding / 1000];
};

// One <video> that plays a stretch and stops; keeps its src while the path stays the same.
export const useClip = () => {
  const ref = useRef<HTMLVideoElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const srcRef = useRef<string | null>(null);
  const pending = useRef<(() => void) | null>(null);
  const raf = useRef(0);
  const stopAt = useRef<{ end: number; then?: () => void } | null>(null);

  const stop = () => {
    cancelAnimationFrame(raf.current);
    stopAt.current = null;
    pending.current = null;
    ref.current?.pause();
  };
  const watch = () => {
    raf.current = requestAnimationFrame(() => {
      const v = ref.current, s = stopAt.current;
      if (!v || !s) return;
      if (v.currentTime >= s.end || v.ended) { stop(); s.then?.(); } else watch();
    });
  };
  // `from` / `to` are times in the source video; a card's own clip starts `offset` seconds in.
  const play = ({ path, offset }: Source, from: number, to: number, then?: () => void) => {
    from = Math.max(0, from - offset);
    to -= offset;
    stop();
    const go = () => {
      const v = ref.current;
      if (!v) return;
      const token = { end: to, then };
      stopAt.current = token;
      v.currentTime = from;
      // Blocked playback still moves on, so an auto-advance never hangs.
      v.play().then(watch, () => { if (stopAt.current === token) { stop(); then?.(); } });
    };
    if (path === srcRef.current && ref.current && ref.current.readyState >= 1) go();
    else { pending.current = go; srcRef.current = path; setSrc(path); }
  };
  useEffect(() => stop, []);

  const onLoadedMetadata = () => { const go = pending.current; pending.current = null; go?.(); };
  const video = (className: string) => (
    <video ref={ref} crossOrigin="anonymous" src={src ? videoSrcFromPath(src) : undefined} onLoadedMetadata={onLoadedMetadata} className={className} />
  );
  return { play, stop, video, ref };
};

// `langOf` (from a library page): each card's language deck. Then lookups use the card's
// own language, and "more" after the round stays in the deck the round came from.
const ReviewSession: React.FC<{ cards: ReviewCard[]; onClose: () => void; langOf?: (c: ReviewCard) => DeckLang; lang?: DeckLang | 'all' }> = ({ cards, onClose, langOf, lang = 'all' }) => {
  const t = useT();
  const [queue, setQueue] = useState(cards);
  const [round, setRound] = useState(0);
  const [idx, setIdx] = useState(0);
  const [mode, setMode] = useState<PracticeMode>(PracticeMode.INPUT);
  const [found, setFound] = useState<{ id: string; source: Source | null } | null>(null);
  const [more, setMore] = useState<ReviewCard[] | null>(null);
  const [turned, setTurned] = useState(false); // word card: answer showing
  const [suggest, setSuggest] = useState<Grade | undefined>(); // sentence card: what the dictation says
  const [at, setAt] = useState(0); // when the buttons came up: shown days and kept days share it
  const front = useMemo(getWordFront, []);
  const repeats = useRef(new Set<string>()); // cards already graded "Again" this round
  const relinked = useRef(new Map<string, string>());
  const writes = useRef<Promise<unknown>[]>([]);
  const clip = useClip();
  const rootRef = useRef<HTMLDivElement>(null);

  usePracticeClock();
  const card = queue[idx] as ReviewCard | undefined;
  const done = idx >= queue.length;
  const source = card && found?.id === card.id ? found.source : undefined; // undefined = still looking
  const path = source && source.path;
  const isWord = card?.deck === 'word';
  // Japanese cards split as on the practice page: the dictionary plus each video's AI check.
  // A card keeps the split it opened with. A Japanese queue shows no boxes until
  // the dictionary and every video's saved splits are read, all at once, so no
  // split lands under the user's fingers; a dictionary downloaded meanwhile
  // (from the practice page underneath) re-reads them.
  const jaVersion = useJaVersion();
  const jaOn = jaReady();
  const hasJa = useMemo(() => queue.some(c => hasKana(c.text)), [queue]);
  const [settled, setSettled] = useState<{ queue: ReviewCard[]; n: number } | null>(null);
  useEffect(() => {
    if (!hasJa) return;
    let live = true;
    const byVideo = new Map<string, string[]>();
    for (const c of queue) if (hasKana(c.text)) byVideo.set(c.videoId, [...byVideo.get(c.videoId) ?? [], c.text]);
    Promise.all([...byVideo].map(([id, texts]) => settleSplits(id, texts).catch(() => {})))
      .then(() => { if (live) setSettled(s => ({ queue, n: (s?.n ?? 0) + 1 })); });
    return () => { live = false; };
  }, [queue, hasJa, jaOn]);
  const splitsReady = !hasJa || settled?.queue === queue;
  const splitVersion = useMemo(() => jaVersion, [card?.id, settled]); // eslint-disable-line react-hooks/exhaustive-deps

  // Words in the answer can be looked up, and kept, as on the practice page (no Anki: that records off the practice video).
  const dictLang = useMemo(() => {
    const l = card && langOf ? langOf(card) : undefined;
    return l ? (l === 'other' ? null : l) : detectLang(queue.map(c => c.text));
  }, [queue, card, langOf]);
  const { def, lookup, explain, closeDef } = useLookup(dictLang, card?.text ?? '');
  useEffect(closeDef, [card]); // eslint-disable-line react-hooks/exhaustive-deps
  const keepWord = (word: string, definition: string, example: string) => {
    if (!card) return;
    const videoPath = relinked.current.get(card.videoId) ?? card.videoPath;
    addWord({ videoId: card.videoId, videoName: card.videoName, videoPath, text: card.text, start: card.start, end: card.end }, word, definition, example).catch(console.error);
  };

  // Line loop (docs/loop.md): a sentence card being typed replays after each play, until
  // it has played enough times; a one-word play resumes the loop without counting.
  const loop = useLoop();
  const plays = useRef(0);
  const loopTimer = useRef(0);
  const loopable = useRef(false);
  loopable.current = !!card && !isWord && mode === PracticeMode.INPUT;
  const clearLoop = () => { window.clearTimeout(loopTimer.current); loopTimer.current = 0; };
  useEffect(() => { plays.current = 0; clearLoop(); }, [card, mode]);
  useEffect(() => { const release = holdPageLoop(); return () => { release(); clearLoop(); }; }, []);
  const ended = (counted: boolean) => () => {
    if (counted) plays.current++;
    clearLoop();
    const ok = () => loopable.current && loopMore(plays.current);
    if (ok()) loopTimer.current = window.setTimeout(() => { if (ok() && clip.ref.current?.paused) playRef.current(); }, LOOP_GAP_MS);
  };

  const playCard = (then?: () => void, fromRatio?: number, toRatio?: number) => {
    if (!card || !source) return;
    clearLoop();
    if (!then && !isWord) {
      if (fromRatio === undefined) plays.current = 0; // a manual replay counts afresh
      then = ended(fromRatio === undefined || toRatio === undefined);
    }
    const [from, to] = clipOf(card);
    if (fromRatio === undefined) return clip.play(source, from, to, then);
    const [a, b] = playSpan(card.start, card.end, fromRatio, toRatio);
    clip.play(source, a, toRatio === undefined ? to : b, then);
  };

  const playRef = useRef(() => {});
  playRef.current = () => { const [from, to] = clipOf(card!); if (source) clip.play(source, from, to, ended(true)); };
  const toggleLoop = () => {
    const on = !getLoop().on;
    setLoopOn(on);
    if (on && loopable.current && clip.ref.current?.paused) playCard();
  };
  const loopBtn = (
    <Btn square flat onClick={toggleLoop} aria-pressed={loop.on} title={`${t(loop.on ? 'transport.loopOn' : 'transport.loopOff')} (${formatCombo(getCombo('loop'))})`}
      className={`relative ${loop.on ? '!text-accent' : '!text-ink'}`}>
      <Repeat size={18} />
      {loop.on && loop.times > 0 && <span className="absolute right-0.5 bottom-0.5 text-[10px] font-semibold leading-none">{loop.times}</span>}
    </Btn>
  );

  const timedWords = useTimedWords(card?.videoId, card?.start ?? 0, card?.end ?? 0);

  const next = () => { clip.stop(); setMode(PracticeMode.INPUT); setTurned(false); setSuggest(undefined); setAt(0); setIdx(i => i + 1); };

  // Find this card's file, then play it once.
  useEffect(() => {
    if (!card) return;
    let cancelled = false;
    const override = relinked.current.get(card.videoId);
    findSource(card, override).then(src => { if (!cancelled) setFound({ id: card.id, source: src }); }, () => { if (!cancelled) setFound({ id: card.id, source: null }); });
    return () => { cancelled = true; };
  }, [card]);
  // A word card stays silent until it is turned: the sound would give the answer away.
  useEffect(() => { if (path && !isWord) playCard(); }, [found]); // eslint-disable-line react-hooks/exhaustive-deps

  // Round over: anything still due in this deck? Waits for the grades to land first.
  useEffect(() => {
    if (!done || queue.length === 0) return;
    let cancelled = false;
    setMore(null);
    Promise.allSettled(writes.current)
      .then(() => getAllCards())
      .then(all => { if (!cancelled) setMore(dueQueue(lang === 'all' || !langOf ? all : all.filter(c => langOf(c) === lang), queue[0].deck)); })
      .catch(e => { console.error(e); if (!cancelled) setMore([]); });
    return () => { cancelled = true; };
  }, [done, queue]);

  const grading = !!card && !!path && splitsReady && !done && (isWord ? turned : mode === PracticeMode.FEEDBACK);
  useEffect(() => { if (grading) setAt(Date.now()); }, [grading, card]);
  // A card the scheduler can't read still gets its buttons, just without the days.
  const due = useMemo(() => { try { return card && at ? previewDue(card, at) : null; } catch (e) { console.error(e); return null; } }, [card, at]);

  const turn = () => { setTurned(true); playCard(); };
  const complete = () => { if (mode === PracticeMode.INPUT) setMode(PracticeMode.FEEDBACK); };
  const replay = (_auto?: boolean, fromRatio?: number, toRatio?: number) => playCard(undefined, fromRatio, toRatio);

  // Recorded with the moment the buttons came up, so the days kept are the days shown.
  const grade = (g: Grade) => {
    if (!card || !at) return;
    const videoPath = relinked.current.get(card.videoId) ?? card.videoPath;
    writes.current.push(recordOutcome({ ...card, videoPath }, g, at).catch(console.error));
    if (!isWord && !repeats.current.has(card.id)) countLine();
    if (g === Rating.Again) {
      repeats.current.add(card.id);
      try {
        const again = { ...card, videoPath, fsrs: schedule(card, g, at).fsrs };
        setQueue(q => [...q, again]);
      } catch (e) { console.error(e); } // unreadable schedule: no second pass, but the round goes on
    }
    next();
  };

  const relink = async () => {
    if (!card) return;
    const p = await pickVideoPath();
    if (!p) return;
    relinked.current.set(card.videoId, p);
    await patchVideoRecord(card.videoId, { videoPath: p }).catch(console.error); // the record may be gone; the cards still move
    await repointVideo(card.videoId, p).catch(console.error);
    setFound({ id: card.id, source: { path: p, offset: 0 } });
  };

  const again = () => {
    if (!more?.length) return;
    writes.current = [];
    setQueue(more);
    setRound(r => r + 1);
    setIdx(0);
    setMode(PracticeMode.INPUT);
    setTurned(false);
    setSuggest(undefined);
    setAt(0);
    repeats.current.clear();
  };

  // Own keys only: Esc closes the definition, else quits; Space turns a word card; 1–4 grade,
  // Enter takes the suggested grade; nothing reaches the page underneath.
  const defOpen = def.word !== null;
  const front0 = isWord && !turned && !!path && splitsReady && !done;
  const keys = useRef({ onClose, done, defOpen, closeDef, front0, grading, suggest, grade, turn, playCard, toggleLoop });
  keys.current = { onClose, done, defOpen, closeDef, front0, grading, suggest, grade, turn, playCard, toggleLoop };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return; // Esc / Enter inside a Japanese input method
      const inside = rootRef.current?.contains(e.target as Node);
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      const k = keys.current;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (k.defOpen) k.closeDef(); else k.onClose(); return; }
      const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
      if (!k.done && !k.defOpen && matches(e, 'loop')) { e.preventDefault(); e.stopPropagation(); k.toggleLoop(); return; }
      if (!typing && !k.done && !k.defOpen) {
        const hit = (run: () => void) => { e.preventDefault(); e.stopPropagation(); run(); };
        if (k.front0 && plain && e.code === 'Space') return hit(k.turn);
        if (k.grading && plain && /^[1-4]$/.test(e.key)) return hit(() => k.grade(+e.key as Grade));
        if (k.grading && plain && e.key === 'Enter' && k.suggest) return hit(() => k.grade(k.suggest!));
        if (k.grading && matches(e, 'replay')) return hit(() => k.playCard());
      }
      if (!inside) e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const hidden = done || path === null || front0;

  return (
    <div ref={rootRef} onKeyDown={e => e.stopPropagation()} className="fixed inset-0 z-50 bg-black flex flex-col fade-in">
      {/* Same room as practice: the clip on top, a white sheet from below. */}
      <div className="relative min-h-0 flex items-center justify-center" style={{ flex: isWord && turned ? '45 1 0' : '60 1 0' }}>
        {clip.video(`block w-full h-full object-contain ${hidden ? 'invisible' : ''}`)}
        {/* A sound-only clip: its still stands in for the picture. */}
        {!hidden && source?.image && <img src={videoSrcFromPath(source.image)} alt="" className="absolute inset-0 w-full h-full object-contain" />}
        {front0 && <p className="absolute text-[13px] text-mute">{t('review.hidden')}</p>}
        <header className={`absolute inset-x-0 top-0 h-16 ${IS_WINDOWS ? 'pl-4' : 'pl-24'} pr-4 lg:pr-6 flex items-center justify-between gap-3 text-[13px]`} data-tauri-drag-region="deep">
          <button type="button" onClick={onClose} className="press h-[42px] pl-3.5 pr-4 rounded-full bg-page border border-line text-ink flex items-center gap-1.5"><X size={15} /> {t('session.quit')}</button>
          {!done && <span className="h-[42px] px-4 rounded-full bg-page border border-line text-ink flex items-center tabular-nums">{t('session.progress', { current: idx + 1, total: queue.length })}</span>}
        </header>
      </div>

      <section className="relative -mt-6 min-h-[340px] bg-page rounded-t-3xl flex flex-col" style={{ flex: isWord && turned ? '55 1 0' : '40 1 0' }}>
        {!done && (
          <div className="px-6 lg:px-24 pt-6">
            {queue.length <= 60 ? (
              <div className="flex gap-[5px]">
                {queue.map((c, i) => <span key={i} className={`flex-1 h-1 rounded-full ${i < idx ? 'bg-ink' : i === idx ? 'bg-accent' : 'bg-line'}`} />)}
              </div>
            ) : (
              <div className="h-1 rounded-full bg-line"><div className="h-full rounded-full bg-ink" style={{ width: `${(idx / queue.length) * 100}%` }} /></div>
            )}
            {card && <p className="mt-1.5 text-xs text-mute truncate">{card.videoName}</p>}
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto px-6 lg:px-24 py-5 flex flex-col">
          <div className="mt-[5vh] w-full max-w-4xl mx-auto flex flex-col items-center gap-6 text-center">
            {done ? (
              <div className="flex flex-col items-center gap-3 fade-in">
                <h2 className="text-[34px] font-semibold tracking-[-0.02em] leading-tight">{t('session.doneTitle')}</h2>
                <p className="text-sm text-mute leading-relaxed max-w-md">{t('session.doneBody', { n: new Set(queue.map(c => c.id)).size })}</p>
                <div className="pt-4 flex gap-2.5">
                  {!!more?.length && <Btn onClick={again}>{t('session.doneMore', { n: more.length })}</Btn>}
                  <Btn tone="accent" onClick={onClose} autoFocus>{t('session.back')}</Btn>
                </div>
              </div>
            ) : path === null ? (
              <div className="max-w-md flex flex-col items-center gap-3">
                <h2 className="text-2xl font-semibold leading-tight">{t('session.missingTitle')}</h2>
                <p className="text-sm text-mute leading-relaxed">{t('session.missingBody', { name: card!.videoName })}</p>
                <div className="pt-3 flex gap-2">
                  <Btn tone="accent" onClick={() => { relink().catch(console.error); }}>{t('session.relink')}</Btn>
                  <Btn onClick={next}>{t('session.skip')}</Btn>
                </div>
              </div>
            ) : path && card && splitsReady ? (
              isWord ? (
                <WordFace key={`${round}-${idx}`} card={card} front={front} turned={turned} onLookup={lookup} onReplay={() => playCard()} />
              ) : (
                <DictationLine
                  key={`${round}-${idx}`}
                  targetText={card.text}
                  mode={mode}
                  splitVersion={splitVersion}
                  hideNext
                  onComplete={complete}
                  onReplay={replay}
                  timedWords={timedWords}
                  onLookup={lookup}
                  onResult={o => setSuggest(gradeOf(o))}
                />
              )
            ) : null}
          </div>
        </div>

        {front0 ? (
          <footer className="shrink-0 h-[96px] flex items-center justify-center gap-3">
            <button type="button" onClick={e => { e.currentTarget.blur(); turn(); }}
              className="press h-[52px] px-7 rounded-full bg-accent text-white text-[15px] font-semibold flex items-center gap-2.5">
              {t('review.show')}<span className="text-xs font-medium px-2 py-0.5 rounded-md bg-white/20">{t('review.space')}</span>
            </button>
            <Btn size="sm" flat onClick={next}>{t('session.skip')}</Btn>
          </footer>
        ) : grading && at ? (
          <footer className="shrink-0 h-[96px] flex items-center justify-center gap-3 text-ink">
            {!isWord && <Btn square flat onClick={() => playCard()} title={t('transport.replayLine')} aria-label={t('transport.replayLine')} className="!text-ink"><RotateCcw size={18} /></Btn>}
            <GradeBar due={due} now={at} suggest={isWord ? undefined : suggest} onGrade={grade} />
          </footer>
        ) : !hidden && path && (
          <footer className="shrink-0 h-[76px] flex items-center justify-center gap-2 text-ink">
            <Btn square flat onClick={() => playCard()} title={t('transport.replayLine')} aria-label={t('transport.replayLine')} className="!text-ink"><RotateCcw size={18} /></Btn>
            {!isWord && loopBtn}
            <button type="button" onClick={e => { e.currentTarget.blur(); playCard(); }} aria-label={t('transport.playSpace')}
              className="press w-12 h-12 rounded-full bg-accent text-white flex items-center justify-center"><Play size={19} fill="currentColor" className="ml-0.5" /></button>
            <Btn size="sm" flat onClick={next}>{t('session.skip')}</Btn>
          </footer>
        )}
      </section>
      {defOpen && <DefinitionPanel key={def.word} def={def} onClose={closeDef} onExplain={explain} onKeepWord={keepWord} />}
    </div>
  );
};

export default ReviewSession;
