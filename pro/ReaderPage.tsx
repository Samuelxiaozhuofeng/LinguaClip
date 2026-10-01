import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Pause, Play, RotateCcw, X } from 'lucide-react';
import type { Subtitle, VideoRecord } from '../types';
import { Btn, Seg } from '../components/ui';
import ReaderLine from './ReaderLine';
import DefinitionPanel, { keepFields } from '../components/DefinitionPanel';
import WatchSummary, { type Looked } from '../components/WatchSummary';
import ReviewSession from '../components/ReviewSession';
import { useSavedLines } from '../hooks/useSavedLines';
import { JaBanner } from '../components/JaSetup';
import { useClip } from '../components/ReviewSession';
import { useLookup } from '../hooks/useLookup';
import { lineAt, parseSRT } from '../utils/srtParser';
import { buildSections } from '../utils/sections';
import { detectLang } from '../utils/dictionary';
import { useJaVersion } from '../utils/japanese';
import { settleSplits } from '../utils/jaSegments';
import { addWord, lineCardsFor, type ReviewCard } from '../utils/review';
import { addLooked, getLooked, getReadPos, lookedKey, setGloss, setReadPos, useLookedVersion } from '../utils/readLooked';
import type { DefinitionState } from '../components/DefinitionPanel';
import { getWordTokens, tokenizeText } from '../utils/textTokenizer';
import { canCloze } from '../utils/aiDrills';
import { getTransJob, prepareTrans, subscribeTrans } from './transPrep';
import { formatTimeCode, getAudioPaddingConfig, getPracticeConfig, getWatchPrefs, ReadBy, saveWatchPrefs } from '../utils/storage';
import { IS_WINDOWS } from '../utils/platform';
import { getLang, useT } from '../utils/i18n';

// Reading a video's subtitles before practising it: the lines as a page to read,
// words to look up (kept, so the watch page marks them later), furigana, a folded
// translation, and any line heard or seen in a small player that stops by itself.
// "All": every line on one page; "section": one practice section at a time, each
// ending on "watch this section". Lines can be saved (the same bookmark as watching /
// practising). Leaving (back or "done") after looking up or saving something shows a
// summary first — dictate saved lines, keep this time's words as cards (docs/reader.md) —
// then returns to the panel.
// Nothing about the record changes: no progress, no position.

// The first meaning of a lookup, as plain text: the dictionary's first sense (its Chinese
// line when it has one) — of the entry spelled as the kept word when there is one (頼まれた
// also brings 頼む, whose senses are meanings; 頼まれた's first is a grammar note) — else
// the AI's definition. Kept as the hint for the watch page.
const firstMeaning = (d: DefinitionState, key: string | null): string => {
  const entry = d.dict?.find(e => e.word === key) ?? d.dict?.[0];
  const sense = entry?.senses[0];
  if (sense) {
    const rows = sense.text.map(p => (typeof p === 'string' ? p : 'ruby' in p ? p.ruby : '')).join('').split('\n').map(r => r.trim()).filter(Boolean);
    return rows.find(r => /[\u4e00-\u9fff]/.test(r)) ?? rows[0] ?? '';
  }
  return (d.data?.definition ?? '').replace(/<[^>]*>/g, '');
};

// What the small player is doing: one line (heard, or seen), on from a line, or a section.
// A word looked up this time: its key (the watch page's mark), and what its card would get.
type Word = Looked & { key: string; fields?: { definition: string; example: string } | null };

type Clip = { kind: 'line' | 'from' | 'section'; view: boolean; from: number; to: number; line?: Subtitle; section?: number; done?: boolean };

const ReaderPage: React.FC<{ record: VideoRecord; by: ReadBy; onExit: (looked: number) => void }> = ({ record, by, onExit }) => {
  const t = useT();
  const lines = useMemo(() => [...parseSRT(record.subtitleText)].sort((a, b) => a.startTime - b.startTime), [record.subtitleText]);
  const sections = useMemo(() => buildSections(lines, getPracticeConfig().sectionLength), [lines]);
  const indexOf = useMemo(() => new Map(lines.map((l, i) => [l.id, i])), [lines]);
  // Where reading stopped last time: the line to scroll to, and (by section) its section.
  const [resumeAt] = useState(() => {
    const pos = getReadPos(record.id);
    const i = pos > 0 ? lines.findIndex(l => l.startTime >= pos - 0.01) : -1;
    return i >= 0 ? lines[i] : null;
  });
  const [sec, setSec] = useState(() => Math.max(0, resumeAt ? sections.findIndex(s => s.subtitles.includes(resumeAt)) : 0)); // "section" mode: the one on the page
  const [resumeNote, setResumeNote] = useState(!!resumeAt);
  const dictLang = useMemo(() => detectLang(lines.map(l => l.text)), [lines]);
  const ja = dictLang === 'ja';
  const jaVersion = useJaVersion();
  useEffect(() => { settleSplits(record.id, lines.map(l => l.text)).catch(() => {}); }, [record.id, lines]);
  const [kana, setKana] = useState(() => getWatchPrefs().kana);
  const [autoClip, setAutoClip] = useState(() => getWatchPrefs().autoClip);
  const scroller = useRef<HTMLDivElement>(null);

  // --- Looked-up words: kept for the watch page, listed on the side ---
  const lookedVersion = useLookedVersion();
  const lookedList = useMemo(() => getLooked(record.id), [record.id, lookedVersion]);
  const looked = useMemo(() => new Set(lookedList), [lookedList]);
  const { def, lookup, explain, closeDef } = useLookup(dictLang, '');
  const lookLine = useRef<Subtitle | null>(null);
  const [words, setWords] = useState<Word[]>([]); // this time's, in order
  const [kept, setKept] = useState<Set<string>>(new Set()); // keys kept as word cards this time
  const activity = useRef(0); // lookups / saves since the summary last showed
  const shownAt = useRef(0);
  const keyOf = (word: string) => lookedKey(word, ja) ?? word.toLowerCase();
  const onWord = useCallback((word: string, line: Subtitle) => {
    addLooked(record.id, word, ja);
    activity.current++;
    const key = keyOf(word);
    setWords(ws => (ws.some(w => w.key === key) ? ws : [...ws, { word, line, key }]));
    lookLine.current = line;
    lookup(word, line.text);
    if (autoClip) lineClip(line, true);
  }, [record.id, ja, autoClip]); // eslint-disable-line react-hooks/exhaustive-deps
  // The meaning found, for the hint on the watch page.
  useEffect(() => {
    if (!def.word || def.loading) return;
    const key = lookedKey(def.word, ja);
    if (def.dict || def.data) setGloss(record.id, def.word, ja, firstMeaning(def, key));
    const k = keyOf(def.word);
    const fields = keepFields(def, key);
    setWords(ws => ws.map(w => (w.key === k && !w.fields ? { ...w, fields } : w)));
  }, [def]); // eslint-disable-line react-hooks/exhaustive-deps
  // A kept word is its key (頼む for 頼まれた, lowercased): find a line with a word keyed the same.
  const again = (word: string) => {
    lookLine.current = lines.find(l => getWordTokens(tokenizeText(l.text)).some(w => lookedKey(w.value, ja) === word)) ?? null;
    lookup(word, lookLine.current?.text);
  };
  // Kept from the definition card, or from the summary (a failed write puts the "+" back).
  const keep = (word: string, l: Subtitle, definition: string, example: string) => {
    const k = keyOf(word);
    setKept(s => new Set(s).add(k));
    addWord({ videoId: record.id, videoName: record.videoFileName, text: l.text, start: l.startTime, end: l.endTime }, word, definition, example)
      .catch(e => { console.error(e); setKept(s => { const n = new Set(s); n.delete(k); return n; }); });
  };
  const keepWord = (word: string, definition: string, example: string) => {
    const l = lookLine.current;
    if (l) keep(word, l, definition, example);
  };
  const keepOne = (w: Word) => { if (w.fields) keep(w.word, w.line, w.fields.definition, w.fields.example); };

  // --- Saved lines: the same bookmark as watching / practising ---
  const { savedIds, savedItems, toggleSave } = useSavedLines({ videoId: record.id, fullSubtitles: lines, videoFileName: record.videoFileName });
  const saveRef = useRef({ toggleSave, savedIds });
  saveRef.current = { toggleSave, savedIds };
  const onSave = useCallback((line: Subtitle) => { // stable, so saving one line re-renders only that line
    if (!saveRef.current.savedIds.has(line.id)) activity.current++;
    saveRef.current.toggleSave(line);
  }, []);

  // --- Translation: asked the first time one is opened ---
  const hasAi = canCloze();
  const [trans, setTrans] = useState<(string | null)[] | null>(null);
  const [transBusy, setTransBusy] = useState(false);
  const [openT, setOpenT] = useState<Set<number>>(new Set());
  const [allT, setAllT] = useState(false);
  const askTrans = () => {
    if (!hasAi || transBusy || (trans && trans.every(Boolean))) return;
    setTransBusy(true);
    prepareTrans(record.id, lines.map(l => l.text), getLang() === 'en' ? 'en' : 'zh')
      .then(setTrans).catch(console.error).finally(() => setTransBusy(false));
  };
  useEffect(() => subscribeTrans(() => { const job = getTransJob(record.id); if (job) setTrans(job.lines); }), [record.id]);
  // A line open with no translation (its batch failed): the click retries, it doesn't fold.
  const toggleTrans = useCallback((line: Subtitle) => {
    askTrans();
    const missing = (allT !== openT.has(line.id)) && !trans?.[indexOf.get(line.id)!] && !transBusy;
    if (!missing) setOpenT(s => { const n = new Set(s); if (n.has(line.id)) n.delete(line.id); else n.add(line.id); return n; });
  }, [trans, transBusy, allT, openT]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- The small player ---
  const { play, stop, video, ref: vref } = useClip();
  const [clip, setClip] = useState<Clip | null>(null);
  const [paused, setPaused] = useState(false);
  const [now, setNow] = useState(0);
  const source = { path: record.videoPath!, offset: 0 };
  const run = (c: Clip) => {
    setClip(c);
    setPaused(false);
    play(source, c.from, c.to, () => setClip(k => (k === c ? { ...c, done: true } : k)));
  };
  const lineClip = (line: Subtitle, view: boolean) => {
    const { startPadding, endPadding } = getAudioPaddingConfig();
    run({ kind: 'line', view, line, from: Math.max(0, line.startTime - startPadding / 1000), to: line.endTime + endPadding / 1000 });
  };
  const onListen = useCallback((line: Subtitle) => lineClip(line, false), []); // eslint-disable-line react-hooks/exhaustive-deps
  const onView = useCallback((line: Subtitle) => lineClip(line, true), []); // eslint-disable-line react-hooks/exhaustive-deps
  const playOn = (line: Subtitle) => run({ kind: 'from', view: true, line, from: line.startTime, to: Number.MAX_VALUE });
  const playSection = (i: number) => {
    const s = sections[i];
    const subs = s.subtitles;
    if (subs.length) run({ kind: 'section', view: true, section: i, from: subs[0].startTime, to: subs[subs.length - 1].endTime + 0.5 });
  };
  const closePlayer = () => { stop(); setClip(null); };
  const togglePause = () => {
    const v = vref.current;
    if (!clip) return;
    if (!v || clip.done) { run({ ...clip, done: false }); return; }
    if (v.paused) { v.play().catch(() => {}); setPaused(false); } else { v.pause(); setPaused(true); }
  };
  // Which line the player is on, for the highlight (and to keep it in view while playing on).
  useEffect(() => {
    if (!clip) return;
    let raf = 0;
    const tick = () => { const v = vref.current; if (v) setNow(n => (Math.abs(n - v.currentTime) > 0.05 ? v.currentTime : n)); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [clip]); // eslint-disable-line react-hooks/exhaustive-deps
  const done = !!clip?.done;
  const playingId = !clip || done ? null : clip.kind === 'line' ? clip.line!.id : lines[lineAt(lines, now)]?.id ?? null;
  const ours = useRef(0); // when the page last scrolled itself: that is not where the reader is
  const settle = useRef(0); // a scroll of the reader's waiting to be kept
  useEffect(() => {
    if (!clip || clip.kind === 'line' || playingId === null) return;
    ours.current = Date.now();
    window.clearTimeout(settle.current); // a scroll of the reader's just before this one: the page is not there any more
    settle.current = 0;
    scroller.current?.querySelector(`[data-line="${playingId}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [playingId]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Keys: Space pauses / resumes the player; Esc closes the definition, then the player. Never leaves. ---
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e: KeyboardEvent) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (drill) return; // the dictation keeps every key to itself
    if (e.key === 'Escape') { if (def.word !== null) closeDef(); else if (summary) setSummary(false); else if (clip) closePlayer(); return; }
    if (summary) return;
    if (e.code === 'Space' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && clip) { e.preventDefault(); togglePause(); }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // --- Where reading stopped: the top line on screen, kept when scrolling settles and on leaving.
  // Scrolling back to it on entry is ours, not the reader's: nothing is kept until the reader
  // touches the page (wheel, click, key); until then it stays anchored, also when furigana
  // arriving late makes the lines above it taller.
  const restored = useRef(!resumeAt); // nothing to go back to: every scroll counts from the start
  const noteRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (restored.current) return;
    const el = resumeAt && scroller.current?.querySelector(`[data-line="${resumeAt.id}"]`);
    if (el && scroller.current) {
      el.scrollIntoView({ block: 'start' });
      scroller.current.scrollTop -= noteRef.current?.offsetHeight ?? 0; // clear of the note pinned on top
    }
  }, [jaVersion, kana]); // eslint-disable-line react-hooks/exhaustive-deps
  const touched = () => { restored.current = true; };
  const topLine = (): Subtitle | null => {
    const box = scroller.current;
    if (!box) return null;
    const top = box.getBoundingClientRect().top + (noteRef.current?.offsetHeight ?? 0) + 8;
    const el = [...box.querySelectorAll<HTMLElement>('[data-line]')].find(e => e.getBoundingClientRect().bottom > top);
    return el ? lines.find(l => String(l.id) === el.dataset.line) ?? null : null;
  };
  // The first line is the top: kept as 0, so no "picking up" note for it next time.
  const keepPlace = () => { if (restored.current) { const l = topLine(); if (l) setReadPos(record.id, l === lines[0] ? 0 : l.startTime); } };
  // Only the reader's own scrolling counts; the player following its line does not. A long
  // smooth scroll of ours can outlast any fixed window, so ours lasts while the page keeps moving.
  const onScroll = () => {
    if (Date.now() - ours.current < 300) { ours.current = Date.now(); return; }
    if (!restored.current) return;
    window.clearTimeout(settle.current);
    settle.current = window.setTimeout(() => { settle.current = 0; keepPlace(); }, 500);
  };
  useEffect(() => () => window.clearTimeout(settle.current), []);
  // Moves the page itself and keeps the new place at once: a jump to the top may not scroll
  // at all (already there), so it can't wait for a scroll to be noticed.
  const jumpTo = (place: number) => {
    window.clearTimeout(settle.current);
    settle.current = 0;
    ours.current = Date.now();
    setReadPos(record.id, place);
    scroller.current?.scrollTo({ top: 0 });
  };
  const fromTop = () => {
    setResumeNote(false);
    if (by === 'section') setSec(0);
    jumpTo(0);
  };

  // --- Leaving: the summary first when something was looked up or saved since it last showed ---
  const [summary, setSummary] = useState(false);
  const [drill, setDrill] = useState<ReviewCard[] | null>(null);
  const [drillMissing, setDrillMissing] = useState(false);
  const exit = () => {
    if (settle.current) { window.clearTimeout(settle.current); keepPlace(); } // a scroll not yet kept
    closePlayer();
    onExit(words.length);
  };
  const leave = () => {
    if (activity.current <= shownAt.current) { exit(); return; }
    closePlayer();
    shownAt.current = activity.current;
    setDrillMissing(false);
    setSummary(true);
  };
  const startDrill = async (picked: Subtitle[]) => {
    const cards = await lineCardsFor(record.id, picked).catch(() => [] as ReviewCard[]);
    if (cards.length) setDrill(cards); else setDrillMissing(true);
  };
  const setKanaPref = (on: boolean) => { setKana(on); saveWatchPrefs({ kana: on }); };
  const setAutoClipPref = (on: boolean) => { setAutoClip(on); saveWatchPrefs({ autoClip: on }); };
  const goSection = (i: number) => {
    if (by === 'section') { setSec(i); jumpTo(i === 0 ? 0 : sections[i].subtitles[0]?.startTime ?? 0); return; }
    scroller.current?.querySelector(`[data-section="${i}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };
  const shown = by === 'section' ? [sections[sec]] : sections;

  const status = !clip ? '' : done ? t('reader.clipDone')
    : clip.kind === 'line' ? t('reader.clipLine', { time: formatTimeCode(clip.line!.startTime) })
    : clip.kind === 'from' ? t('reader.clipFrom', { time: formatTimeCode(now) })
    : t('reader.clipSection', { n: clip.section! + 1, time: formatTimeCode(now), end: formatTimeCode(clip.to) });

  return (
    <div className="fixed inset-0 bg-paper flex flex-col" onWheelCapture={touched} onPointerDownCapture={touched} onKeyDownCapture={touched} onTouchStartCapture={touched}>
      <header className={`h-16 shrink-0 ${IS_WINDOWS ? 'pl-4' : 'pl-24'} pr-6 flex items-center gap-4 bg-page border-b border-line`} data-tauri-drag-region>
        <button type="button" onClick={leave} className="press h-10 pl-3 pr-4 flex items-center gap-1.5 min-w-0 max-w-[36%] rounded-full bg-page border border-line text-ink text-[13px] hover:bg-shade">
          <ArrowLeft size={16} className="shrink-0" /><span className="truncate">{record.displayName}</span>
        </button>
        {sections.length > 1 && (
          <Seg<number> size="sm" className="min-w-0 overflow-x-auto" value={by === 'section' ? sec : -1} onChange={goSection}
            options={sections.map((_, i) => ({ value: i, label: t('reader.sectionN', { n: i + 1 }) }))} />
        )}
        <div className="flex-1" />
        <Btn size="sm" tone={autoClip ? 'ink' : 'white'} aria-pressed={autoClip} onClick={() => setAutoClipPref(!autoClip)} title={t('reader.autoClipTitle')}>{t(autoClip ? 'reader.autoClipOn' : 'reader.autoClipOff')}</Btn>
        {ja && <Btn size="sm" tone={kana ? 'ink' : 'white'} aria-pressed={kana} onClick={() => setKanaPref(!kana)}>{t(kana ? 'reader.kanaOn' : 'reader.kanaOff')}</Btn>}
        {hasAi && <Btn size="sm" tone={allT ? 'ink' : 'white'} aria-pressed={allT} onClick={() => { if (!allT) askTrans(); setAllT(!allT); setOpenT(new Set()); }}>{t(allT ? 'reader.transAllOn' : 'reader.transAll')}</Btn>}
        <Btn tone="accent" onClick={leave}>{t('reader.done')}</Btn>
      </header>

      <div className="flex-1 min-h-0 flex gap-8 pl-10 pr-8">
        <div ref={scroller} onScroll={onScroll} className="flex-1 min-w-0 overflow-y-auto pb-5">
          <div className="mx-auto max-w-[780px] pt-5">
          {ja && <div className="mb-4"><JaBanner /></div>}
          {resumeNote && resumeAt && (
            <div ref={noteRef} className="sticky top-0 z-10 -mt-5 mb-1 px-3 py-2.5 bg-paper flex items-center gap-3 text-[13px] text-mute">
              <span>{t('reader.resumed', { time: formatTimeCode(resumeAt.startTime) })}</span>
              <Btn size="sm" onClick={fromTop}>{t('reader.fromTop')}</Btn>
            </div>
          )}
          {shown.map(s => {
            const i = sections.indexOf(s);
            const last = i === sections.length - 1;
            return (
              <section key={s.id} data-section={i} className="mb-6">
                {sections.length > 1 && (
                  <h3 className="px-3 pb-1.5 text-xs text-mute">
                    {t('reader.sectionHead', { n: i + 1, from: formatTimeCode(s.startTime), to: formatTimeCode(Math.min(s.endTime, s.subtitles[s.subtitles.length - 1]?.endTime ?? s.endTime)) })}
                  </h3>
                )}
                {s.subtitles.map(line => (
                  <ReaderLine key={line.id} line={line} ja={ja} jaVersion={jaVersion} kana={kana} looked={looked}
                    playing={playingId === line.id} saved={savedIds.has(line.id)} hasTrans={hasAi} transOpen={allT !== openT.has(line.id)}
                    transText={trans?.[indexOf.get(line.id)!] ?? null} transPending={transBusy}
                    onWord={onWord} onListen={onListen} onView={onView} onTrans={toggleTrans} onSave={onSave} />
                ))}
                {by === 'section' && (
                  <div className="mx-3 mt-6 p-6 card !shadow-none flex flex-col items-center gap-1.5 text-center">
                    <span className="text-lg font-semibold">{sections.length > 1 ? t('reader.sectionDone', { n: i + 1 }) : t('reader.allRead')}</span>
                    <span className="text-[13px] text-mute">{t('reader.sectionInfo', { n: s.subtitles.length })}</span>
                    <div className="mt-3.5 flex gap-3">
                      <Btn size="lg" tone="accent" onClick={() => playSection(i)}><Play size={14} fill="currentColor" />{t(sections.length > 1 ? 'reader.watchSection' : 'reader.watchAll')}</Btn>
                      {last ? <Btn size="lg" onClick={leave}>{t('reader.done')}</Btn>
                        : <Btn size="lg" onClick={() => goSection(i + 1)}>{t('reader.nextSection', { n: i + 2 })}</Btn>}
                    </div>
                  </div>
                )}
              </section>
            );
          })}
          </div>
        </div>

        <aside className="w-[380px] shrink-0 py-5 flex flex-col gap-4 min-h-0">
          <div className={`card !shadow-none overflow-hidden shrink-0 ${clip?.view ? '' : 'hidden'}`}>
            <div className="relative aspect-video bg-ink">
              {video('absolute inset-0 w-full h-full object-contain')}
              <button type="button" onClick={closePlayer} title={t('reader.closePlayer')} aria-label={t('reader.closePlayer')}
                className="absolute top-2 right-2 w-8 h-8 rounded-lg bg-black/45 text-white inline-flex items-center justify-center hover:bg-black/70"><X size={16} /></button>
            </div>
            <div className="px-3.5 py-3 flex items-center gap-2">
              <span className="flex-1 min-w-0 text-xs text-mute truncate">{status}</span>
              <Btn size="sm" square onClick={togglePause} title={t(done || paused ? 'reader.resume' : 'reader.pause')} aria-label={t(done || paused ? 'reader.resume' : 'reader.pause')}>
                {done ? <RotateCcw size={14} /> : paused ? <Play size={14} /> : <Pause size={14} />}
              </Btn>
              {clip?.kind === 'line' && <Btn size="sm" tone="accent-soft" onClick={() => playOn(clip.line!)}>{t('reader.playOn')}</Btn>}
            </div>
          </div>

          <div className="card !shadow-none p-4 min-h-0 flex flex-col">
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-semibold">{t('reader.lookedHead')}</span>
              <span className="text-xs text-mute">{lookedList.length}</span>
            </div>
            {lookedList.length === 0
              ? <p className="mt-2 text-[13px] text-mute leading-relaxed">{t('reader.lookedEmpty')}</p>
              : (
                <ul className="mt-1.5 overflow-y-auto min-h-0 -mx-1">
                  {[...lookedList].reverse().map(w => (
                    <li key={w}>
                      <button type="button" onClick={() => again(w)} className="w-full px-1 py-2 text-left text-[15px] font-medium border-b border-line hover:text-accent">{w}</button>
                    </li>
                  ))}
                </ul>
              )}
          </div>
        </aside>
      </div>

      {summary && (
        <WatchSummary title={t('reader.summaryTitle')} savedEmpty={t('reader.savedEmpty')} saved={savedItems} looked={words}
          words={{
            kept: w => kept.has((w as Word).key),
            can: w => !!(w as Word).fields,
            onKeep: w => keepOne(w as Word),
            onKeepAll: () => words.filter(w => w.fields && !kept.has(w.key)).forEach(keepOne),
          }}
          actions={<>
            {drillMissing && <span className="mr-auto text-[13px] text-mute">{t('watch.drillMissing')}</span>}
            <Btn onClick={() => setSummary(false)}>{t('reader.keepReading')}</Btn>
            <Btn onClick={exit}>{t('reader.pickPractice')}</Btn>
          </>}
          onClose={() => setSummary(false)}
          onJump={line => { setSummary(false); lineClip(line, true); }}
          onWord={w => { lookLine.current = w.line; lookup(w.word, w.line.text); }}
          onDrill={picked => { setDrillMissing(false); startDrill(picked).catch(console.error); }} />
      )}
      {drill && <ReviewSession cards={drill} onClose={() => setDrill(null)} />}
      {def.word !== null && (
        <DefinitionPanel key={def.word} def={def} onClose={closeDef} onExplain={explain} onKeepWord={lookLine.current ? keepWord : undefined} />
      )}
    </div>
  );
};

export default ReaderPage;
