import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Pause, Play, RotateCcw, X } from 'lucide-react';
import type { Subtitle, VideoRecord } from '../types';
import { Btn, Seg } from './ui';
import ReaderLine, { Trans } from './ReaderLine';
import DefinitionPanel from './DefinitionPanel';
import { JaBanner } from './JaSetup';
import { useClip } from './ReviewSession';
import { useLookup } from '../hooks/useLookup';
import { lineAt, parseSRT } from '../utils/srtParser';
import { buildSections } from '../utils/sections';
import { detectLang } from '../utils/dictionary';
import { useJaVersion } from '../utils/japanese';
import { settleSplits } from '../utils/jaSegments';
import { addWord } from '../utils/review';
import { addLooked, getLooked, useLookedVersion } from '../utils/readLooked';
import { canCloze } from '../utils/aiDrills';
import { getTransJob, prepareTrans, subscribeTrans } from '../utils/transPrep';
import { formatTimeCode, getAudioPaddingConfig, getPracticeConfig, getWatchPrefs, ReadBy, saveWatchPrefs } from '../utils/storage';
import { IS_WINDOWS } from '../utils/platform';
import { getLang, useT } from '../utils/i18n';

// Reading a video's subtitles before practising it: the lines as a page to read,
// words to look up (kept, so the watch page marks them later), furigana, a folded
// translation, and any line heard or seen in a small player that stops by itself.
// "All": every line on one page; "section": one practice section at a time, each
// ending on "watch this section". Leaving (back or "done") returns to the panel.
// Nothing about the record changes: no progress, no position.

// What the small player is doing: one line (heard, or seen), on from a line, or a section.
type Clip = { kind: 'line' | 'from' | 'section'; view: boolean; from: number; to: number; line?: Subtitle; section?: number; done?: boolean };

const ReaderPage: React.FC<{ record: VideoRecord; by: ReadBy; onExit: (looked: number) => void }> = ({ record, by, onExit }) => {
  const t = useT();
  const lines = useMemo(() => [...parseSRT(record.subtitleText)].sort((a, b) => a.startTime - b.startTime), [record.subtitleText]);
  const sections = useMemo(() => buildSections(lines, getPracticeConfig().sectionLength), [lines]);
  const [sec, setSec] = useState(0); // "section" mode: the one on the page
  const dictLang = useMemo(() => detectLang(lines.map(l => l.text)), [lines]);
  const ja = dictLang === 'ja';
  const jaVersion = useJaVersion();
  useEffect(() => { settleSplits(record.id, lines.map(l => l.text)).catch(() => {}); }, [record.id, lines]);
  const [kana, setKana] = useState(() => getWatchPrefs().kana);
  const scroller = useRef<HTMLDivElement>(null);

  // --- Looked-up words: kept for the watch page, listed on the side ---
  const lookedVersion = useLookedVersion();
  const lookedList = useMemo(() => getLooked(record.id), [record.id, lookedVersion]);
  const looked = useMemo(() => new Set(lookedList), [lookedList]);
  const { def, lookup, explain, closeDef } = useLookup(dictLang, '');
  const lookLine = useRef<Subtitle | null>(null);
  const onWord = useCallback((word: string, line: Subtitle) => {
    addLooked(record.id, word, ja);
    lookLine.current = line;
    lookup(word, line.text);
  }, [record.id, ja]); // eslint-disable-line react-hooks/exhaustive-deps
  const again = (word: string) => {
    lookLine.current = lines.find(l => l.text.includes(word)) ?? null;
    lookup(word, lookLine.current?.text);
  };
  const keepWord = (word: string, definition: string, example: string) => {
    const l = lookLine.current;
    if (l) addWord({ videoId: record.id, videoName: record.videoFileName, text: l.text, start: l.startTime, end: l.endTime }, word, definition, example).catch(console.error);
  };

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
  const toggleTrans = useCallback((line: Subtitle) => {
    askTrans();
    setOpenT(s => { const n = new Set(s); if (n.has(line.id)) n.delete(line.id); else n.add(line.id); return n; });
  }, [trans, transBusy]); // eslint-disable-line react-hooks/exhaustive-deps
  const transOf = (i: number, line: Subtitle): Trans | null => hasAi
    ? { open: allT !== openT.has(line.id), text: trans?.[i] ?? null, pending: transBusy }
    : null;

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
  useEffect(() => {
    if (!clip || clip.kind === 'line' || playingId === null) return;
    scroller.current?.querySelector(`[data-line="${playingId}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [playingId]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Keys: Space pauses / resumes the player; Esc closes the definition, then the player. Never leaves. ---
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e: KeyboardEvent) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === 'Escape') { if (def.word !== null) closeDef(); else if (clip) closePlayer(); return; }
    if (e.code === 'Space' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && clip) { e.preventDefault(); togglePause(); }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const leave = () => { closePlayer(); onExit(lookedList.length); };
  const setKanaPref = (on: boolean) => { setKana(on); saveWatchPrefs({ kana: on }); };
  const goSection = (i: number) => {
    if (by === 'section') { setSec(i); scroller.current?.scrollTo({ top: 0 }); return; }
    scroller.current?.querySelector(`[data-section="${i}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };
  const shown = by === 'section' ? [sections[sec]] : sections;
  const indexOf = useMemo(() => new Map(lines.map((l, i) => [l.id, i])), [lines]);

  const status = !clip ? '' : done ? t('reader.clipDone')
    : clip.kind === 'line' ? t('reader.clipLine', { time: formatTimeCode(clip.line!.startTime) })
    : clip.kind === 'from' ? t('reader.clipFrom', { time: formatTimeCode(now) })
    : t('reader.clipSection', { n: clip.section! + 1, time: formatTimeCode(now), end: formatTimeCode(clip.to) });

  return (
    <div className="fixed inset-0 bg-paper flex flex-col">
      <header className={`h-16 shrink-0 ${IS_WINDOWS ? 'pl-4' : 'pl-24'} pr-6 flex items-center gap-4 bg-page border-b border-line`} data-tauri-drag-region>
        <button type="button" onClick={leave} className="press h-10 pl-3 pr-4 flex items-center gap-1.5 min-w-0 max-w-[36%] rounded-full bg-page border border-line text-ink text-[13px] hover:bg-shade">
          <ArrowLeft size={16} className="shrink-0" /><span className="truncate">{record.displayName}</span>
        </button>
        {sections.length > 1 && (
          <Seg<number> size="sm" className="min-w-0 overflow-x-auto" value={by === 'section' ? sec : -1} onChange={goSection}
            options={sections.map((_, i) => ({ value: i, label: t('reader.sectionN', { n: i + 1 }) }))} />
        )}
        <div className="flex-1" />
        {ja && <Btn size="sm" tone={kana ? 'ink' : 'white'} aria-pressed={kana} onClick={() => setKanaPref(!kana)}>{t(kana ? 'reader.kanaOn' : 'reader.kanaOff')}</Btn>}
        {hasAi && <Btn size="sm" tone={allT ? 'ink' : 'white'} aria-pressed={allT} onClick={() => { if (!allT) askTrans(); setAllT(!allT); setOpenT(new Set()); }}>{t(allT ? 'reader.transAllOn' : 'reader.transAll')}</Btn>}
        <Btn tone="accent" onClick={leave}>{t('reader.done')}</Btn>
      </header>

      <div className="flex-1 min-h-0 flex gap-8 pl-10 pr-8">
        <div ref={scroller} className="flex-1 min-w-0 overflow-y-auto py-5">
          {ja && <div className="mb-4 max-w-3xl"><JaBanner /></div>}
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
                    playing={playingId === line.id} trans={transOf(indexOf.get(line.id)!, line)}
                    onWord={onWord} onListen={onListen} onView={onView} onTrans={toggleTrans} />
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

      {def.word !== null && (
        <DefinitionPanel key={def.word} def={def} onClose={closeDef} onExplain={explain} onKeepWord={lookLine.current ? keepWord : undefined} />
      )}
    </div>
  );
};

export default ReaderPage;
