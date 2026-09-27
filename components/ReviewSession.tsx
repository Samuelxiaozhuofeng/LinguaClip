import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PracticeMode } from '../types';
import { ReviewCard, Outcome, recordOutcome, repointVideo, getAllCards, dueQueue, wordBoxes, addWord } from '../utils/review';
import { getVideoRecord, patchVideoRecord } from '../utils/videoStorage';
import { getAudioPaddingConfig } from '../utils/storage';
import { videoSrcFromPath, pathExists, pickVideoPath } from '../utils/desktop';
import { tokenizeText, getWordTokens } from '../utils/textTokenizer';
import { Play, RotateCcw, X } from 'lucide-react';
import { Btn } from './ui';
import { IS_WINDOWS } from '../utils/platform';
import DictationLine from './DictationLine';
import DefinitionPanel from './DefinitionPanel';
import { useLookup } from '../hooks/useLookup';
import { detectLang } from '../utils/dictionary';
import type { DeckLang } from '../utils/deckLang';
import { useT } from '../utils/i18n';
import { countLine, usePracticeClock } from '../utils/today';
import { hasKana, jaReady, useJaVersion } from '../utils/japanese';
import { settleSplits } from '../utils/jaSegments';
import { playSpan, useTimedWords } from '../utils/wordTimes';

// A review round: one card at a time over the whole window (clip on top, a white
// sheet below, like the practice page), graded by how the dictation went. Also opened on top of the practice page, so it owns its keys.

// The video's current path (the record's wins over the card's snapshot), or null if the file is gone.
export const findVideo = async (c: ReviewCard): Promise<string | null> => {
  const rec = c.videoId ? await getVideoRecord(c.videoId).catch(() => null) : null;
  const path = rec?.videoPath ?? c.videoPath;
  return path && await pathExists(path) ? path : null;
};

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
  const play = (path: string, from: number, to: number, then?: () => void) => {
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
  return { play, stop, video };
};

// A kept meaning is HTML (dictionary text we escaped, but also raw AI text and
// glyph images from dictionary pages), so only <b> <i> <br> and http(s) <img>
// get through; everything else is flattened to its text.
const clean = (html: string): string => {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const walk = (n: Node): string => [...n.childNodes].map(c => {
    if (c.nodeType === Node.TEXT_NODE) return (c.textContent ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    if (!(c instanceof Element)) return '';
    const tag = c.tagName.toLowerCase();
    if (tag === 'br') return '<br/>';
    if (tag === 'script' || tag === 'style') return '';
    if (tag === 'img') { const src = c.getAttribute('src') ?? ''; return /^https?:\/\//.test(src) ? `<img src="${src.replace(/"/g, '&quot;')}">` : ''; }
    return tag === 'b' || tag === 'i' ? `<${tag}>${walk(c)}</${tag}>` : walk(c);
  }).join('');
  return walk(doc.body);
};

const Html: React.FC<{ html?: string; className?: string }> = ({ html, className }) =>
  html ? <div className={className} dangerouslySetInnerHTML={{ __html: clean(html) }} /> : null;

// `langOf` (from a library page): each card's language deck. Then lookups use the card's
// own language, and "more" after the round stays in the deck the round came from.
const ReviewSession: React.FC<{ cards: ReviewCard[]; onClose: () => void; langOf?: (c: ReviewCard) => DeckLang; lang?: DeckLang | 'all' }> = ({ cards, onClose, langOf, lang = 'all' }) => {
  const t = useT();
  const [queue, setQueue] = useState(cards);
  const [round, setRound] = useState(0);
  const [idx, setIdx] = useState(0);
  const [mode, setMode] = useState<PracticeMode>(PracticeMode.INPUT);
  const [found, setFound] = useState<{ id: string; path: string | null } | null>(null);
  const [more, setMore] = useState<ReviewCard[] | null>(null);
  const relinked = useRef(new Map<string, string>());
  const writes = useRef<Promise<unknown>[]>([]);
  const clip = useClip();
  const rootRef = useRef<HTMLDivElement>(null);

  usePracticeClock();
  const card = queue[idx] as ReviewCard | undefined;
  const done = idx >= queue.length;
  const path = card && found?.id === card.id ? found.path : undefined; // undefined = still looking
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
  const blanks = useMemo(
    () => card?.deck === 'word' ? wordBoxes(getWordTokens(tokenizeText(card.text)).map(w => w.value), card.word!) : undefined,
    [card, splitVersion], // eslint-disable-line react-hooks/exhaustive-deps
  );

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

  const playCard = (then?: () => void, fromRatio?: number, toRatio?: number) => {
    if (!card || !path) return;
    const [from, to] = clipOf(card);
    if (fromRatio === undefined) return clip.play(path, from, to, then);
    const [a, b] = playSpan(card.start, card.end, fromRatio, toRatio);
    clip.play(path, a, toRatio === undefined ? to : b, then);
  };

  const timedWords = useTimedWords(card?.videoId, card?.start ?? 0, card?.end ?? 0);

  const next = () => { clip.stop(); setMode(PracticeMode.INPUT); setIdx(i => i + 1); };

  // Find this card's file, then play it once.
  useEffect(() => {
    if (!card) return;
    let cancelled = false;
    const override = relinked.current.get(card.videoId);
    (override ? Promise.resolve(override) : findVideo(card).catch(() => null)).then(p => { if (!cancelled) setFound({ id: card.id, path: p }); });
    return () => { cancelled = true; };
  }, [card]);
  useEffect(() => { if (path) playCard(); }, [found]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const result = (o: Outcome) => {
    if (!card) return;
    if (!isWord) countLine();
    const videoPath = relinked.current.get(card.videoId) ?? card.videoPath;
    writes.current.push(recordOutcome({ ...card, videoPath }, o).catch(console.error));
  };

  const complete = (correct: boolean) => {
    if (mode === PracticeMode.FEEDBACK) next();
    else if (correct && !isWord) next();
    else setMode(PracticeMode.FEEDBACK);
  };

  const replay = (auto?: boolean, fromRatio?: number, toRatio?: number) => {
    if (!auto) return playCard(undefined, fromRatio, toRatio);
    // All right: hear it once more, then the next line (a word card stops on its meaning).
    if (isWord) { setMode(PracticeMode.FEEDBACK); playCard(); }
    else playCard(next);
  };

  const relink = async () => {
    if (!card) return;
    const p = await pickVideoPath();
    if (!p) return;
    relinked.current.set(card.videoId, p);
    await patchVideoRecord(card.videoId, { videoPath: p }).catch(console.error); // the record may be gone; the cards still move
    await repointVideo(card.videoId, p).catch(console.error);
    setFound({ id: card.id, path: p });
  };

  const again = () => {
    if (!more?.length) return;
    writes.current = [];
    setQueue(more);
    setRound(r => r + 1);
    setIdx(0);
    setMode(PracticeMode.INPUT);
  };

  // Own keys only: Esc closes the definition, else quits; Enter moves on from feedback; nothing reaches the page underneath.
  const defOpen = def.word !== null;
  const keys = useRef({ onClose, next, mode, done, defOpen, closeDef });
  keys.current = { onClose, next, mode, done, defOpen, closeDef };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return; // Esc / Enter inside a Japanese input method
      const inside = rootRef.current?.contains(e.target as Node);
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      const k = keys.current;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (k.defOpen) k.closeDef(); else k.onClose(); return; }
      if (e.key === 'Enter' && !typing && !k.done && !k.defOpen && k.mode === PracticeMode.FEEDBACK) { e.preventDefault(); e.stopPropagation(); k.next(); return; }
      if (!inside) e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const hidden = done || path === null;

  return (
    <div ref={rootRef} onKeyDown={e => e.stopPropagation()} className="fixed inset-0 z-50 bg-black flex flex-col fade-in">
      {/* Same room as practice: the clip on top, a white sheet from below. */}
      <div className="relative min-h-0 flex items-center justify-center" style={{ flex: '60 1 0' }}>
        {clip.video(`block w-full h-full object-contain ${hidden ? 'invisible' : ''}`)}
        <header className={`absolute inset-x-0 top-0 h-16 ${IS_WINDOWS ? 'pl-4' : 'pl-24'} pr-4 lg:pr-6 flex items-center justify-between gap-3 text-[13px]`} data-tauri-drag-region="deep">
          <button type="button" onClick={onClose} className="press h-[42px] pl-3.5 pr-4 rounded-full bg-page border border-line text-ink flex items-center gap-1.5"><X size={15} /> {t('session.quit')}</button>
          {!done && <span className="h-[42px] px-4 rounded-full bg-page border border-line text-ink flex items-center tabular-nums">{t('session.progress', { current: idx + 1, total: queue.length })}</span>}
        </header>
      </div>

      <section className="relative -mt-6 min-h-[340px] bg-page rounded-t-3xl flex flex-col" style={{ flex: '40 1 0' }}>
        {!done && (
          <div className="px-6 lg:px-24 pt-6">
            {queue.length <= 60 ? (
              <div className="flex gap-[5px]">
                {queue.map((c, i) => <span key={c.id} className={`flex-1 h-1 rounded-full ${i < idx ? 'bg-ink' : i === idx ? 'bg-accent' : 'bg-line'}`} />)}
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
                <p className="text-sm text-mute leading-relaxed max-w-md">{t('session.doneBody', { n: queue.length })}</p>
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
              <>
                <DictationLine
                  key={`${round}-${card.id}`}
                  targetText={card.text}
                  mode={mode}
                  blanks={blanks}
                  splitVersion={splitVersion}
                  nextLabel={isWord ? t('session.next') : undefined}
                  onComplete={complete}
                  onReplay={replay}
                  timedWords={timedWords}
                  onLookup={lookup}
                  onResult={result}
                />
                {isWord && mode === PracticeMode.FEEDBACK && (
                  <section className="w-full max-w-2xl px-5 py-4 rounded-2xl bg-shade text-left space-y-2 fade-in">
                    <h3 className="text-xs text-mute">{t('session.meaning')}</h3>
                    <p className="font-serif text-2xl">{card.word}</p>
                    <Html html={card.definition} className="text-[15px] leading-relaxed" />
                    <Html html={card.example} className="text-[15px] leading-relaxed text-mute" />
                  </section>
                )}
              </>
            ) : null}
          </div>
        </div>

        {!hidden && path && (
          <footer className="shrink-0 h-[76px] flex items-center justify-center gap-2 text-ink">
            <Btn square flat onClick={() => playCard()} title={t('transport.replayLine')} aria-label={t('transport.replayLine')} className="!text-ink"><RotateCcw size={18} /></Btn>
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
