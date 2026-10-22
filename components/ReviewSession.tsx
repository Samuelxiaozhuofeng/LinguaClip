import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PracticeMode } from '../types';
import { clipOf, useClip } from '../hooks/useClip';
import { Rating, type Grade } from 'ts-fsrs';
import { ReviewCard, recordOutcome, repointVideo, getAllCards, dueQueue, addWord, gradeOf, previewDue, schedule, setMastered, removeCard, restoreCard, type Removed } from '../utils/review';
import { patchVideoRecord } from '../utils/videoStorage';
import { deferCard } from '../utils/reviewDefer';
import { getWordFront, getMasteredBtn, getWordVoice } from '../utils/storage';
import { wordVoiceUrl } from '../utils/wordVoice';
import { videoSrcFromPath, pickVideoPath } from '../utils/desktop';
import { findSource, holdClips, fillClips, type Source } from '../utils/clips';
import { Check, Play, Repeat, RotateCcw, Trash2, X } from 'lucide-react';
import { Btn } from './ui';
import { IS_WINDOWS } from '../utils/platform';
import DictationLine from './DictationLine';
import DefinitionPanel from './DefinitionPanel';
import { WordFace, GradeBar } from './WordReview';
import { isDefault, loose, matches, formatCombo, getCombo, keyLabel } from '../utils/shortcuts';
import { useLoop, getLoop, setLoopOn, loopMore, holdPageLoop, LOOP_GAP_MS } from '../utils/loop';
import { useLookup, aroundOf } from '../hooks/useLookup';
import { getVideoFromDB } from '../utils/fileSystemAccess';
import { parseSRT } from '../utils/srtParser';
import { detectLang } from '../utils/dictionary';
import type { DeckLang } from '../utils/deckLang';
import { useT } from '../utils/i18n';

type Held = Removed & { release: () => void };
import { countLine, usePracticeClock } from '../utils/today';
import { hasKana, jaReady, useJaVersion } from '../utils/japanese';
import { settleSplits } from '../utils/jaSegments';
import { loadWords, playSpan, useTimedWords } from '../utils/wordTimes';
import { locateWord, type WordSpot } from '../utils/wordAudio';

// A review round: one card at a time over the whole window (clip on top, a white
// sheet below, like the practice page). A sentence card is dictated, a word card is
// thought about then turned; either ends on the four FSRS buttons, and "Again" comes
// back at the end of the round. Also opened on top of the practice page, so it owns its keys.

export { clipOf, useClip } from '../hooks/useClip';

// `langOf` (from a library page): each card's language deck. Then lookups use the card's
// own language, and "more" after the round stays in the deck the round came from.
// onFinish: the done screen's button, when finishing leads on (the listening page's next section); quitting stays onClose.
const ReviewSession: React.FC<{ cards: ReviewCard[]; onClose: () => void; onFinish?: () => void; langOf?: (c: ReviewCard) => DeckLang; lang?: DeckLang | 'all' }> = ({ cards, onClose, onFinish, langOf, lang = 'all' }) => {
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
  const masteredBtn = useMemo(getMasteredBtn, []);
  // The note under the card, with its undo: "got it", or a delete (`gone` = the card as it was).
  const [undo, setUndo] = useState<{ id: string; n: number; gone?: Promise<Held | null> } | null>(null);
  const repeats = useRef(new Set<string>()); // cards already graded "Again" this round
  const removed = useRef(new Set<string>()); // deleted this round: not counted as done
  const undone = useRef(new Set<Promise<Held | null>>()); // deletes taken back: their own chain lets the files go
  const [restored, setRestored] = useState(0); // an undone delete: work out "one more round" again
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
  // The lines around the card's line, for the AI's cultural meaning: from its video's subtitles (none once the video is deleted).
  const [around, setAround] = useState('');
  useEffect(() => {
    let live = true;
    setAround('');
    if (card?.videoId) getVideoFromDB(card.videoId).then(r => {
      const lines = r ? [...parseSRT(r.subtitleText)].sort((a, b) => a.startTime - b.startTime) : [];
      if (live) setAround(aroundOf(lines, lines.findIndex(l => Math.abs(l.startTime - card.start) < 0.01)));
    }).catch(() => {});
    return () => { live = false; };
  }, [card?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const { def, lookup, explain, closeDef } = useLookup(dictLang, card?.text ?? '', around);
  useEffect(closeDef, [card]); // eslint-disable-line react-hooks/exhaustive-deps
  const keepWord = (word: string, definition: string, example: string, ai: string) => {
    if (!card) return;
    const videoPath = relinked.current.get(card.videoId) ?? card.videoPath;
    addWord({ videoId: card.videoId, videoName: card.videoName, videoPath, text: card.text, start: card.start, end: card.end }, word, definition, example, ai).catch(console.error);
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
    <Btn square flat onClick={toggleLoop} aria-pressed={loop.on} title={`${t(loop.on ? 'transport.loopOn' : 'transport.loopOff')} (${formatCombo(getCombo('review.loop'))})`}
      className={`relative ${loop.on ? '!text-accent' : '!text-ink'}`}>
      <Repeat size={18} />
      {loop.on && loop.times > 0 && <span className="absolute right-0.5 bottom-0.5 text-[10px] font-semibold leading-none">{loop.times}</span>}
    </Btn>
  );

  const timedWords = useTimedWords(card?.videoId, card?.start ?? 0, card?.end ?? 0);
  // A word card's word alone (docs/word-audio.md): where it is, worked out per card.
  const [spot, setSpot] = useState<{ id: string; at: WordSpot | null } | null>(null);
  useEffect(() => {
    if (!card?.word || !isWord) return;
    let live = true;
    loadWords(card.videoId).then(w => { if (live) setSpot({ id: card.id, at: locateWord({ text: card.text, startTime: card.start, endTime: card.end }, card.word!, w) }); });
    return () => { live = false; };
  }, [card, isWord]);
  const wordAt = spot && card && spot.id === card.id ? spot.at : null;
  const now = useRef({ id: '', source, wordAt }); // the fallback plays where the word is by then, not at the click
  now.current = { id: card?.id ?? '', source, wordAt };
  const playWord = () => {
    if (!card?.word) return;
    const tts = getWordVoice() === 'tts';
    if (!tts && !(source && wordAt)) return;
    clearLoop();
    const id = card.id;
    clip.playVoice(tts ? wordVoiceUrl(card.word, card.videoId, 2000) : Promise.resolve(null), () => {
      const n = now.current;
      if (n.id === id && n.source && n.wordAt) clip.play(n.source, n.wordAt.from, n.wordAt.to);
    });
  };

  // 没打分就离开（跳过 / 退出时正显示的那张）：下次排到后面；本轮重来过的不算。
  const deferNow = () => { if (card && !done && !repeats.current.has(card.id)) deferCard(card.id); };
  const skip = () => { deferNow(); next(); };
  const quit = () => { deferNow(); onClose(); };
  // 别的路径卸载（如键盘切到底层导航）也算退出；延到下一拍，StrictMode 的假卸载随即重挂会取消它。
  const leaving = useRef(deferNow);
  leaving.current = deferNow;
  const unmountTimer = useRef(0);
  useEffect(() => { window.clearTimeout(unmountTimer.current); return () => { unmountTimer.current = window.setTimeout(() => leaving.current()); }; }, []);
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
  }, [done, queue, restored]);

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

  // "Got it" (docs/review.md): out of review from now on; counts like a grade. Undo = the same switch off.
  const master = () => {
    if (!card) return;
    writes.current.push(setMastered(card.id, true).catch(console.error));
    if (!repeats.current.has(card.id)) countLine();
    setUndo(u => ({ id: card.id, n: (u?.n ?? 0) + 1 }));
    next();
  };
  // Delete (docs/review.md「复习里删卡」): gone at once, with this round's repeats; undo puts it back whole.
  const remove = () => {
    if (!card) return;
    // Its clip files are held from the moment it is gone, so no sweep slips in between.
    const gone = removeCard(card.id).then(c => c && { ...c, release: holdClips(c.card) }).catch(e => { console.error(e); return null; });
    writes.current.push(gone);
    setQueue(q => q.filter((c, i) => i <= idx || c.id !== card.id));
    removed.current.add(card.id);
    setUndo(u => ({ id: card.id, n: (u?.n ?? 0) + 1, gone }));
    next();
  };
  const unmaster = () => {
    if (!undo) return;
    writes.current.push(undo.gone
      // Files held until the card is back and a whole sweep has seen it (one may have read the cards
      // before); "one more round" waits only for the card.
      ? undo.gone.then(c => c && restoreCard(c).then(() => { fillClips().catch(console.error).finally(c.release); }, e => { c.release(); throw e; })).catch(console.error)
      : setMastered(undo.id, false).catch(console.error));
    setRestored(n => n + 1); // drops a "one more round" worked out before, and waits for this write
    if (undo.gone) { undone.current.add(undo.gone); removed.current.delete(undo.id); }
    setUndo(null);
  };
  useEffect(() => {
    if (!undo) return;
    const id = window.setTimeout(() => setUndo(null), 6000);
    // Offer over without undo (timed out, pushed aside, round closed): the deleted card's files may go.
    const gone = undo.gone;
    return () => { window.clearTimeout(id); if (gone && !undone.current.has(gone)) gone.then(c => c?.release()); };
  }, [undo]);
  const canMaster = masteredBtn && !isWord;

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
    removed.current.clear();
  };

  // Own keys only: Esc closes the definition, else quits; Space turns a word card; 1–4 grade,
  // Enter takes the suggested grade; nothing reaches the page underneath.
  const defOpen = def.word !== null;
  const front0 = isWord && !turned && !!path && splitsReady && !done;
  const canRemove = !!card && !done;
  const keys = useRef({ quit, done, defOpen, closeDef, front0, grading, suggest, grade, turn, playCard, toggleLoop, master, canMaster, remove, canRemove, isWord, playWord });
  keys.current = { quit, done, defOpen, closeDef, front0, grading, suggest, grade, turn, playCard, toggleLoop, master, canMaster, remove, canRemove, isWord, playWord };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return; // Esc / Enter inside a Japanese input method
      const inside = rootRef.current?.contains(e.target as Node);
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      const k = keys.current;
      // While typing in a sentence card's blank only ⌘ keys and Esc count here.
      const on = (id: string) => matches(e, id) && !(typing && !getCombo(id).mod && e.code !== 'Escape');
      if (on('review.close') || (loose(e, 'review.close', typing ? 'reviewBlank' : 'reviewOut') && e.code === 'Escape')) { e.preventDefault(); e.stopPropagation(); if (k.defOpen) k.closeDef(); else k.quit(); return; }
      if (!k.done && !k.defOpen && on('review.loop')) { e.preventDefault(); e.stopPropagation(); k.toggleLoop(); return; }
      if (!typing && !k.done && !k.defOpen) {
        const hit = (run: () => void) => { e.preventDefault(); e.stopPropagation(); run(); };
        if (k.front0 && on('review.flip')) return hit(k.turn);
        // ⌘⌫ (Ctrl+Backspace on Windows) by default; inside a blank it stays an editing key.
        if (k.canRemove && on('review.remove') && (!isDefault('review.remove') || (IS_WINDOWS ? e.ctrlKey : e.metaKey))) return hit(k.remove);
        const g = ([1, 2, 3, 4] as Grade[]).find(n => on(`review.g${n}`));
        if (k.grading && g) return hit(() => k.grade(g));
        if (k.grading && on('review.master') && k.canMaster) return hit(k.master);
        if (k.grading && on('review.suggest') && k.suggest) return hit(() => k.grade(k.suggest!));
        if (k.grading && on('review.replay')) return hit(() => k.playCard());
        if (k.grading && k.isWord && on('review.playWord')) return hit(k.playWord); // a sentence card's ⌘K stays the blank's
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
          <button type="button" onClick={quit} className="press h-[42px] pl-3.5 pr-4 rounded-full bg-page border border-line text-ink flex items-center gap-1.5"><X size={15} /> {t('session.quit')}</button>
          {!done && (
            <div className="flex items-center gap-2">
              {canRemove && (
                <button type="button" onClick={e => { e.currentTarget.blur(); remove(); }} title={t('review.deleteTitle', { key: keyLabel('review.remove') })} aria-label={t('review.delete')}
                  className="press h-[42px] px-3.5 rounded-full bg-page border border-line text-ink flex items-center gap-1.5"><Trash2 size={15} /> {t('review.delete')}</button>
              )}
              <span className="h-[42px] px-4 rounded-full bg-page border border-line text-ink flex items-center tabular-nums">{t('session.progress', { current: idx + 1, total: queue.length })}</span>
            </div>
          )}
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
                <p className="text-sm text-mute leading-relaxed max-w-md">{t('session.doneBody', { n: new Set(queue.map(c => c.id).filter(id => !removed.current.has(id))).size })}</p>
                <div className="pt-4 flex gap-2.5">
                  {!!more?.length && <Btn onClick={again}>{t('session.doneMore', { n: more.length })}</Btn>}
                  <Btn tone="accent" onClick={onFinish ?? onClose} autoFocus>{t('session.back')}</Btn>
                </div>
              </div>
            ) : path === null ? (
              <div className="max-w-md flex flex-col items-center gap-3">
                <h2 className="text-2xl font-semibold leading-tight">{t('session.missingTitle')}</h2>
                <p className="text-sm text-mute leading-relaxed">{t('session.missingBody', { name: card!.videoName })}</p>
                <div className="pt-3 flex gap-2">
                  <Btn tone="accent" onClick={() => { relink().catch(console.error); }}>{t('session.relink')}</Btn>
                  <Btn onClick={skip}>{t('session.skip')}</Btn>
                </div>
              </div>
            ) : path && card && splitsReady ? (
              isWord ? (
                <WordFace key={`${round}-${idx}`} card={card} front={front} turned={turned} onLookup={lookup} onReplay={() => playCard()} onPlayWord={wordAt || getWordVoice() === 'tts' ? playWord : undefined} />
              ) : (
                <DictationLine
                  key={`${round}-${idx}`}
                  targetText={card.text}
                  mode={mode}
                  splitVersion={splitVersion}
                  hideNext
                  inReview
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
            <Btn size="sm" flat onClick={skip}>{t('session.skip')}</Btn>
          </footer>
        ) : grading && at ? (
          <footer className="shrink-0 h-[96px] flex items-center justify-center gap-3 text-ink">
            {!isWord && <Btn square flat onClick={() => playCard()} title={t('transport.replayLine')} aria-label={t('transport.replayLine')} className="!text-ink"><RotateCcw size={18} /></Btn>}
            <GradeBar due={due} now={at} suggest={isWord ? undefined : suggest} onGrade={grade} />
            {canMaster && (
              <button type="button" onClick={e => { e.currentTarget.blur(); master(); }} title={t('review.masteredTitle')}
                className="press w-[132px] h-[58px] rounded-2xl border border-line bg-page flex flex-col items-center justify-center gap-0.5">
                <span className="flex items-center gap-1.5"><span className="text-[11px] text-mute">{keyLabel('review.master')}</span><span className="text-[15px] font-semibold">{t('review.mastered')}</span></span>
                <Check size={14} className="text-mute" />
              </button>
            )}
          </footer>
        ) : !hidden && path && (
          <footer className="shrink-0 h-[76px] flex items-center justify-center gap-2 text-ink">
            <Btn square flat onClick={() => playCard()} title={t('transport.replayLine')} aria-label={t('transport.replayLine')} className="!text-ink"><RotateCcw size={18} /></Btn>
            {!isWord && loopBtn}
            <button type="button" onClick={e => { e.currentTarget.blur(); playCard(); }} aria-label={t('transport.playSpace')}
              className="press w-12 h-12 rounded-full bg-accent text-white flex items-center justify-center"><Play size={19} fill="currentColor" className="ml-0.5" /></button>
            <Btn size="sm" flat onClick={skip}>{t('session.skip')}</Btn>
          </footer>
        )}
      </section>
      {undo && (
        <div key={undo.n} className="fixed left-1/2 -translate-x-1/2 top-3 z-[60] h-10 pl-4 pr-1.5 rounded-full bg-ink text-white text-sm flex items-center gap-2 shadow-card fade-in">
          {t(undo.gone ? 'review.deletedToast' : 'review.masteredToast')}
          <button type="button" onClick={e => { e.currentTarget.blur(); unmaster(); }} className="press h-7 px-3 rounded-full bg-white/15 font-medium">{t('review.undo')}</button>
        </div>
      )}
      {defOpen && <DefinitionPanel key={def.word} def={def} onClose={closeDef} onExplain={explain} onKeepWord={keepWord}
        say={card && source ? { videoId: card.videoId, text: card.text, start: card.start, end: card.end, source } : null} />}
    </div>
  );
};

export default ReviewSession;
