// The phone's listening page (design Listen.dc.html / Lookup.dc.html): playback and the
// steps are useListen, the pieces ListenParts, the lines with words to tap LineView, a
// word's meaning WordSheet. This file: the audio element, the layout and its big buttons,
// the lock screen, translations ("中"), stars, and what the summary sends to review.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Subtitle, VideoRecord } from '../types';
import { useT } from '../utils/i18n';
import { detectLang } from '../utils/dictionary';
import { downloadJa, loadJa, useJaState } from '../utils/japanese';
import { settleSplits } from '../utils/jaSegments';
import { addLooked, lookedKey } from '../utils/readLooked';
import { addLine, addWord } from '../utils/review';
import { useSavedLines } from '../hooks/useSavedLines';
import { useListenText } from '../pro/useListenText';
import { prepareSrc, videoSrcFromPath } from './platform/desktop';
import { useListen } from './useListen';
import { useMediaSession } from './mediaSession';
import { useWordLookup, firstFields, type Keep } from './useWordLookup';
import { Blind, DrillBar, HeardAsk, PassSheet, StepBar, Summary } from './ListenParts';
import { LineCard, Transcript } from './LineView';
import { WordSheet } from './WordSheet';
import { btnPlain, btnPrimary, errText } from './ui';

const JaBanner: React.FC = () => {
  const t = useT();
  const s = useJaState();
  if (s.ready || s.installed === null || (s.installed && !s.failed)) return null;
  return (
    <button disabled={s.running} onClick={() => { void downloadJa(); }} className="mx-5 mt-1 min-h-[44px] px-3 rounded-xl bg-page shadow-card text-[13px] text-left">
      {s.running ? t('ja.downloading', { pct: s.pct }) : s.failed ? t('m.jaFailed') : t('m.jaDownload')}
    </button>
  );
};

const Icon: React.FC<{ d: string; fill?: boolean; size?: number }> = ({ d, fill, size = 26 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={fill ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
);
const round = 'w-[52px] h-[52px] flex items-center justify-center';

type Word = { word: string; key: string; line: Subtitle; fields: Keep | null; kept: boolean };

export const Listen: React.FC<{ record: VideoRecord; onBack: () => void }> = ({ record, onBack }) => {
  const t = useT();
  const L = useListen(record);
  const { lines, section, cur, sec, audio } = L;
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState('');
  const path = record.videoPath ?? '';
  useEffect(() => {
    prepareSrc(path).then(() => setSrc(videoSrcFromPath(path)), (e: unknown) => setFailed(errText(e instanceof Error ? e.message : String(e))));
  }, [path]);

  const lang = useMemo(() => detectLang(lines.map(l => l.text)), [lines]);
  const ja = lang === 'ja';
  useEffect(() => { if (ja) { void loadJa(); settleSplits(record.id, lines.map(l => l.text)).catch(() => {}); } }, [ja, record.id, lines]);

  const effMode = L.free ? L.mode : L.queue ? (L.shown ? 'show' : 'hide') : L.pass === 2 ? 'show' : 'hide';
  const { scroller, follow, setFollow, leave, hasTrans, trans, transBusy, openT, onTrans } = useListenText(record, lines, audio, cur?.id ?? null, effMode, sec, L.playing);
  const transOf = (l: Subtitle) => (openT.has(l.id) ? trans?.[L.indexOf.get(l.id)!] ?? (transBusy ? null : t('reader.transFailed')) : undefined);
  const { savedIds, savedItems, toggleSave } = useSavedLines({ videoId: record.id, fullSubtitles: lines, videoFileName: record.videoFileName });
  const ref = { videoId: record.id, videoName: record.videoFileName };

  // --- Words: a tap pauses and opens the meaning; closing plays the paused line again ---
  const { def, lookup, explain, close, keep } = useWordLookup(lang, ja);
  const [words, setWords] = useState<Word[]>([]); // since the last summary
  const onWord = (word: string, line: Subtitle) => {
    L.holdFor();
    addLooked(record.id, word, ja);
    const key = lookedKey(word, ja) ?? word.toLowerCase();
    setWords(ws => (ws.some(w => w.key === key) ? ws : [...ws, { word, key, line, fields: null, kept: false }]));
    const i = lines.indexOf(line); // the lines around it, for the AI (as hooks/useLookup.ts's aroundOf)
    void lookup(word, line, [lines[i - 1]?.text, lines[i + 1]?.text].filter(Boolean).join('\n'));
  };
  useEffect(() => {
    if (!def || def.loading || def.aiBusy) return;
    const key = lookedKey(def.word, ja) ?? def.word.toLowerCase();
    setWords(ws => ws.map(w => (w.key === key && !w.fields ? { ...w, fields: firstFields(def) } : w)));
  }, [def, ja]);
  const closeDef = () => { close(); if (L.peek === null && !(L.inDrill && L.shown)) L.release(); };
  const keepWord = (key: string) => {
    const w = words.find(x => x.key === key);
    if (!w?.fields) return;
    setWords(ws => ws.map(x => (x.key === key ? { ...x, kept: true } : x)));
    addWord({ ...ref, text: w.line.text, start: w.line.startTime, end: w.line.endTime }, w.word, w.fields.definition, w.fields.example, w.fields.ai)
      .catch(e => { console.error(e); setWords(ws => ws.map(x => (x.key === key ? { ...x, kept: false } : x))); });
  };

  // --- Summary: hard lines heard since the last one, into review one at a time ---
  const since = useRef(0);
  useEffect(() => { if (!L.summary) { since.current = sec; setWords([]); setAdded(false); setFail(false); } }, [L.summary, L.duration]); // eslint-disable-line react-hooks/exhaustive-deps
  const heard = (id: number) => { const s = L.sections.findIndex(x => x.subtitles.some(l => l.id === id)); return s >= Math.min(since.current, sec) && s <= Math.max(since.current, sec); };
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState(false);
  const [added, setAdded] = useState(false);
  const addMissed = async (picked: Subtitle[]) => {
    setBusy(true); setFail(false);
    try {
      for (const l of picked) await addLine({ ...ref, text: l.text, start: l.startTime, end: l.endTime }, 'missed');
      setAdded(true);
    } catch (e) { console.error(e); setFail(true); } finally { setBusy(false); }
  };

  // --- Buttons, the same for the page and the lock screen ---
  const nextBtn = L.inDrill ? L.drillNext : L.next;
  useMediaSession({ title: record.displayName, artist: record.podcast?.show ?? '', image: record.podcast?.image },
    { play: L.playOn, pause: L.pauseNow, prev: L.prev, next: nextBtn }, L.playing);
  const markNow = () => { if (cur) L.flipMark(cur.id, t('listen.marked'), t('listen.unmarked')); };
  const markPrev = () => { const i = L.markPrevIndex(); if (i < 0) L.say(t('listen.noPrev')); else L.flipMark(lines[i].id, t('listen.markedPrev'), t('listen.unmarked')); };
  const marked = useMemo(() => new Set(L.marks.keys()), [L.marks]);
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => { if (!L.note) return; setToast(L.note.text); const id = window.setTimeout(() => setToast(null), 1800); return () => window.clearTimeout(id); }, [L.note]);

  const inSec = section ? section.subtitles.findIndex(l => l.id === cur?.id) : -1;
  const peekAt = L.peek !== null && section ? section.subtitles.findIndex(l => l.id === L.peek) : -1;
  const drillAt = L.inDrill && L.shown && section ? section.subtitles.findIndex(l => l.id === L.drillLine!.id) : -1;
  const lineProps = { saved: savedIds, trans: transOf, onWord, onSave: toggleSave, onTrans: hasTrans ? onTrans : undefined };
  const sumMissed = L.summary ? lines.filter(l => L.marks.has(l.id) && heard(l.id)).map(l => ({ line: l, on: L.marks.get(l.id) !== 'ok', saved: savedIds.has(l.id) })) : [];
  const sumSaved = L.summary ? savedItems.filter(l => heard(l.id) && !L.marks.has(l.id)) : [];
  const step = L.summary ? 3 : L.pass;
  useEffect(() => { if (effMode === 'show' && follow) scroller.current?.querySelector(`[data-line="${cur?.id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, [cur?.id, effMode, follow]); // eslint-disable-line react-hooks/exhaustive-deps

  const body = failed ? <p className="h-full flex items-center justify-center px-8 text-center text-sm text-accent" role="alert">{failed}</p>
    : drillAt >= 0 ? <><p className="px-5 pt-2 text-[13px] text-mute">{t('m.drillShownHint')}</p><LineCard {...lineProps} lines={section!.subtitles} at={drillAt} onAgain={() => L.playLine(L.drillLine!)} /></>
    : peekAt >= 0 ? <>
      <button onClick={L.closePeek} className="mx-3 min-h-[44px] px-2 flex items-center gap-1 text-[15px] font-semibold"><span className="text-2xl">‹</span>{t('listen.peek')}</button>
      <LineCard {...lineProps} lines={section!.subtitles} at={peekAt} onAgain={() => L.playLine(section!.subtitles[peekAt])} />
    </>
    : effMode === 'hide' ? <Blind lines={section?.subtitles ?? []} at={inSec} marked={marked} hint={L.free ? null : L.queue ? t('m.drillHint', { n: L.tries }) : t('m.blindHint')} />
    : <Transcript ref={scroller} {...lineProps} lines={section?.subtitles ?? []} cur={cur?.id ?? null} hint={!L.free ? t('m.checkHint') : null}
      onPlay={l => { setFollow(true); L.seek(l.startTime, true); }} onScroll={leave} />;

  return (
    <div className="fixed inset-0 bg-paper flex flex-col pt-[env(safe-area-inset-top)]">
      <audio ref={audio} preload="auto" src={src ?? undefined} onLoadedMetadata={L.onLoaded} onTimeUpdate={L.onTime}
        onPlay={() => L.setPlaying(true)} onPause={() => L.setPlaying(false)} onEnded={L.onEnded} onError={() => { if (src) setFailed(t('listen.failed')); }} />
      <div className="pt-2 px-3 pb-1 flex items-center gap-1">
        <button aria-label={t('m.back')} onClick={onBack} className="w-11 h-11 shrink-0 flex items-center justify-center text-2xl">‹</button>
        <div className="flex-1 min-w-0 flex flex-col">
          <span className="text-[15px] font-semibold truncate">{record.displayName}</span>
          {L.sections.length > 1 && <span className="text-xs text-mute">{t('listen.sectionOf', { n: sec + 1, total: L.sections.length })}</span>}
        </div>
        <button onClick={() => L.goFree(!L.free)} className="min-h-[44px] px-2.5 text-[13px] text-mute">{t(L.free ? 'listen.route' : 'listen.free')}</button>
      </div>
      {ja && <JaBanner />}
      {L.free ? (
        <div className="mx-5 mt-1 flex gap-2 flex-wrap">
          {(['hide', 'show'] as const).map(m => <button key={m} aria-pressed={L.mode === m} onClick={() => L.setMode(m)} className={`min-h-[44px] px-3.5 rounded-full text-[13px] ${L.mode === m ? 'bg-ink text-white' : 'bg-page shadow-card text-mute'}`}>{t(`listen.mode_${m}`)}</button>)}
          <button aria-pressed={L.throughPref} onClick={L.toggleThrough} className={`min-h-[44px] px-3.5 rounded-full text-[13px] ${L.throughPref ? 'bg-accent-soft text-accent' : 'bg-page shadow-card text-mute'}`}>{t('listen.through')}</button>
          <button onClick={() => L.goStep(3)} className="min-h-[44px] px-3.5 rounded-full text-[13px] bg-page shadow-card">{t('listen.done')}</button>
        </div>
      ) : <StepBar step={step} onStep={L.goStep} />}

      <div className="flex-1 min-h-0 overflow-y-auto relative">{body}</div>
      {toast && <p role="status" className="fixed left-1/2 -translate-x-1/2 top-[calc(env(safe-area-inset-top)+64px)] z-20 px-4 py-2 rounded-full bg-ink text-white text-sm">{toast}</p>}

      <div className="px-5 pt-3 flex flex-col gap-2.5">
        {L.inDrill ? <DrillBar n={L.qAt + 1} total={L.queue!.length} play={L.play} tries={L.tries} shown={L.shown} onShow={L.drillShow} onNext={L.drillNext} />
          : !failed && <>
            <div className={`grid ${effMode === 'hide' && peekAt < 0 ? 'grid-cols-2' : 'grid-cols-1'} gap-2.5`}>
              <button className={btnPlain} onClick={markPrev}>{t('m.markPrev')}</button>
              {effMode === 'hide' && peekAt < 0 && <button className={btnPlain} onClick={L.openPeek} disabled={!cur}>{t('listen.peek')}</button>}
            </div>
            <button className={`${btnPrimary} h-16 text-[17px]`} onClick={markNow} disabled={!cur} aria-pressed={!!cur && marked.has(cur.id)}>
              {cur && marked.has(cur.id) ? t('m.unmarkNow') : t('m.markNow')}
            </button>
          </>}
      </div>
      <div className="px-7 pt-3 pb-[max(20px,env(safe-area-inset-bottom))] flex items-center justify-between">
        <button className={`${round} text-[13px] text-mute`} onClick={L.cycleSpeed} aria-label={t('m.speed')}>{L.speed === 1 ? '1.0' : L.speed}×</button>
        <button className={round} aria-label={t('m.prevLine')} onClick={L.prev}><Icon d="M15 18l-6-6 6-6M6 6v12" /></button>
        <button className="w-[72px] h-[72px] rounded-full bg-ink text-white flex items-center justify-center" aria-label={t(L.playing ? 'm.pause' : 'm.play')} onClick={L.toggle} disabled={!src}>
          {L.playing ? <Icon d="M9 6v12M15 6v12" /> : <Icon d="M7 4l13 8-13 8z" fill />}
        </button>
        <button className={round} aria-label={t('m.nextLine')} onClick={nextBtn}><Icon d="M9 18l6-6-6-6M18 6v12" /></button>
        <button className={round} aria-label={t('m.replayLine')} onClick={L.replay}><Icon d="M1 4v6h6M3.5 15a9 9 0 1 0 2.1-9.4L1 10" size={24} /></button>
      </div>

      {L.passCard && !L.summary && (
        <PassSheet hard={L.hard} ask={<HeardAsk said={L.said.get(sec)} onAnswer={L.answer} />}
          on={L.easy ? t(L.lastSec ? 'listen.done' : 'listen.next') : null}
          onStart={() => L.startPass(2)} onOn={L.moveOn} onClose={() => L.setPassCard(false)} />
      )}
      {L.summary && (
        <Summary key={`${sec}-${L.summary.ended}`} title={L.summary.ended || L.lastSec ? t('listen.allDone') : t('listen.sectionDone', { n: sec + 1 })}
          missed={sumMissed} saved={sumSaved} words={words.map(w => ({ word: w.word, key: w.key, kept: w.kept, can: !!w.fields }))}
          busy={busy} fail={fail} added={added} onward={!L.summary.ended && !L.lastSec}
          onAdd={p => { void addMissed(p); }} onKeep={keepWord} onAgain={() => L.goSection(sec)} onNext={() => L.goSection(sec + 1)} onHome={onBack} onClose={() => L.setSummary(null)} />
      )}
      {def && <WordSheet key={`${def.word}|${def.line.id}`} def={def} onClose={closeDef} onExplain={explain} onKeep={k => keep(k, ref)} />}
    </div>
  );
};
