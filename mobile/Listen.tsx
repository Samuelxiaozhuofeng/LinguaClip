// The phone's listening page (design Listen.dc.html / Lookup.dc.html): playback and the
// steps are useListen, the pieces ListenParts, the lines with words to tap LineView, a
// word's meaning WordSheet. This file: the layout and its big buttons, platform audio/lockscreen
// binding (Web <audio> + mediaSession, or Android native Media3), translations ("中"), stars,
// and what the summary sends to review.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Subtitle, VideoRecord } from '../types';
import { useT } from '../utils/i18n';
import { detectLang } from '../utils/dictionary';
import { downloadJa, loadJa, useJaState } from '../utils/japanese';
import { settleSplits } from '../utils/jaSegments';
import { addLooked, lookedKey } from '../utils/readLooked';
import { useSavedLines } from '../hooks/useSavedLines';
import { useListenText } from '../pro/useListenText';
import { AUDIO_ENGINE_PLATFORM } from './platform/audioEngine';
import { useListen } from './useListen';
import { removeMissedFromReview, restoreMissedToReview, type HeldRemoval } from './listenMissed';
import { useMediaSession, type MediaActions } from './mediaSession';
import { useWordLookup, cardWordForFirst, firstFields, saveWordCard, type Keep } from './useWordLookup';
import { Blind, DrillBar, HeardAsk, PassSheet, StepBar, Summary } from './ListenParts';
import { LineCard, Transcript } from './LineView';
import { WordSheet } from './WordSheet';
import { btnPrimary, errText } from './ui';

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

// Web/PWA only: Android native owns MediaSession in PlaybackService.kt and must never touch navigator.mediaSession.
const WebMediaSession: React.FC<{
  meta: { title: string; artist: string; image?: string };
  actions: MediaActions;
  playing: boolean;
}> = ({ meta, actions, playing }) => {
  useMediaSession(meta, actions, playing);
  return null;
};

const Icon: React.FC<{ d: string; fill?: boolean; size?: number }> = ({ d, fill, size = 26 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={fill ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
);
const round = 'w-11 h-11 flex items-center justify-center';

type Word = { word: string; cardWord?: string; key: string; line: Subtitle; fields: Keep | null; kept: boolean };

export const Listen: React.FC<{
  record: VideoRecord;
  onBack: () => void;
  embedded?: boolean;
  startSec?: number;
  onPos?: (sec: number) => void;
  onLine?: (n: number, total: number) => void;
}> = ({ record, onBack, embedded = false, startSec, onPos, onLine }) => {
  const t = useT();
  const L = useListen(record, embedded ? { startSec, onPos, onLine } : undefined);
  const { lines, section, cur, sec } = L;
  const failed = L.errorCode ? (L.errorCode === 'listen.failed' ? t('listen.failed') : errText(L.errorCode)) : '';
  const handleBack = () => { L.leavePage(); onBack(); };

  const lang = useMemo(() => detectLang(lines.map(l => l.text)), [lines]);
  const ja = lang === 'ja';
  useEffect(() => { if (ja) { void loadJa(); settleSplits(record.id, lines.map(l => l.text)).catch(() => {}); } }, [ja, record.id, lines]);

  const effMode = L.free ? L.mode : L.queue ? (L.shown ? 'show' : 'hide') : L.pass === 2 ? 'show' : 'hide';
  const { scroller, follow, setFollow, leave, hasTrans, trans, transBusy, openT, onTrans } = useListenText(record, lines, L.pausedRef, cur?.id ?? null, effMode, sec, L.playing);
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
    const fields = firstFields(def);
    const cardWord = cardWordForFirst(def);
    setWords(ws => ws.map(w => (w.key === key && !w.fields ? { ...w, fields, cardWord } : w)));
  }, [def, ja]);
  const closeDef = () => { close(); if (L.peek === null && !(L.inDrill && L.shown)) L.release(); };
  const keepWord = (key: string) => {
    const w = words.find(x => x.key === key);
    if (!w?.fields) return;
    const savedWord = w.cardWord?.trim() || w.word;
    setWords(ws => ws.map(x => (x.key === key ? { ...x, kept: true } : x)));
    saveWordCard({ ...ref, text: w.line.text, start: w.line.startTime, end: w.line.endTime }, savedWord, w.fields)
      .catch(e => { console.error(e); setWords(ws => ws.map(x => (x.key === key ? { ...x, kept: false } : x))); });
  };

  // --- Summary: hard lines are already in review; allow undoable removal here ---
  const since = useRef(0);
  type SummaryRemoved = { line: Subtitle; saved: boolean; held: Promise<HeldRemoval | null> };
  const [removedMap, setRemovedMap] = useState<Map<number, SummaryRemoved>>(() => new Map());
  const removedRef = useRef(removedMap);
  removedRef.current = removedMap;
  const releaseAllRemoved = () => {
    removedRef.current.forEach(item => { void item.held.then(h => h?.release()); });
  };
  useEffect(() => () => { releaseAllRemoved(); }, []);
  useEffect(() => {
    if (!L.summary) {
      since.current = sec;
      setWords([]);
      if (removedRef.current.size > 0) {
        releaseAllRemoved();
        setRemovedMap(new Map());
      }
    }
  }, [L.summary, L.duration]); // eslint-disable-line react-hooks/exhaustive-deps
  const heard = (id: number) => { const s = L.sections.findIndex(x => x.subtitles.some(l => l.id === id)); return s >= Math.min(since.current, sec) && s <= Math.max(since.current, sec); };
  const onRemoveMissed = (line: Subtitle) => {
    L.setLineMarked(line.id, false);
    const held = removeMissedFromReview(record, line);
    setRemovedMap(m => new Map(m).set(line.id, { line, saved: savedIds.has(line.id), held }));
  };
  const onUndoMissed = (line: Subtitle) => {
    const entry = removedRef.current.get(line.id);
    setRemovedMap(m => { const n = new Map(m); n.delete(line.id); return n; });
    L.setLineMarked(line.id, true);
    void restoreMissedToReview(record, line, entry?.held);
  };

  // --- Buttons, the same for the page and the lock screen ---
  const nextBtn = L.inDrill ? L.drillNext : L.next;
  const markNow = () => { if (cur) L.flipMark(cur.id, t('m.w1MarkedReview'), t('listen.unmarked')); };
  const markPrev = () => { const i = L.markPrevIndex(); if (i < 0) L.say(t('listen.noPrev')); else L.flipMark(lines[i].id, t('m.w1MarkedPrevReview'), t('listen.unmarked')); };
  const marked = useMemo(() => new Set(L.marks.keys()), [L.marks]);
  const [toast, setToast] = useState<string | null>(null);
  const [freeMore, setFreeMore] = useState(false);
  useEffect(() => { if (!L.free) setFreeMore(false); }, [L.free]);
  const freeActiveCount = (L.throughPref ? 1 : 0) + (L.loopLine ? 1 : 0) + (L.autoPause ? 1 : 0);
  useEffect(() => { if (!L.note) return; setToast(L.note.text); const id = window.setTimeout(() => setToast(null), 1800); return () => window.clearTimeout(id); }, [L.note]);

  const inSec = section ? section.subtitles.findIndex(l => l.id === cur?.id) : -1;
  const peekAt = L.peek !== null && section ? section.subtitles.findIndex(l => l.id === L.peek) : -1;
  const drillAt = L.inDrill && L.shown && section ? section.subtitles.findIndex(l => l.id === L.drillLine!.id) : -1;
  const lineProps = { saved: savedIds, trans: transOf, onWord, onSave: toggleSave, onTrans: hasTrans ? onTrans : undefined };
  const sumMissed = L.summary
    ? lines
        .filter(l => (L.marks.has(l.id) && heard(l.id)) || removedMap.has(l.id))
        .map(l => {
          const rem = removedMap.get(l.id);
          return { line: l, saved: rem ? rem.saved : savedIds.has(l.id), removed: !!rem };
        })
    : [];
  const sumSaved = L.summary ? savedItems.filter(l => heard(l.id) && !L.marks.has(l.id) && !removedMap.has(l.id)) : [];
  const step = L.summary ? 3 : L.pass;
  useEffect(() => { if (effMode === 'show' && follow) scroller.current?.querySelector(`[data-line="${cur?.id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, [cur?.id, effMode, follow]); // eslint-disable-line react-hooks/exhaustive-deps

  const body = failed ? <p className="h-full flex items-center justify-center px-8 text-center text-sm text-accent" role="alert">{failed}</p>
    : drillAt >= 0 ? <><p className="px-5 pt-2 text-[13px] text-mute">{t('m.drillShownHint')}</p><LineCard {...lineProps} lines={section!.subtitles} at={drillAt} onAgain={() => L.playLine(L.drillLine!)} /></>
    : peekAt >= 0 ? <>
      <button onClick={L.closePeek} className="mx-3 min-h-[44px] px-2 flex items-center gap-1 text-[15px] font-semibold"><span className="text-2xl">‹</span>{t('listen.peek')}</button>
      <LineCard {...lineProps} lines={section!.subtitles} at={peekAt} onAgain={() => L.playLine(section!.subtitles[peekAt])} />
    </>
    : effMode === 'hide' ? <Blind lines={section?.subtitles ?? []} at={inSec} marked={marked} hint={L.free ? null : L.queue ? t('m.drillHint', { n: L.tries }) : t('m.blindHint')} embedded={embedded} multiSection={L.sections.length > 1} />
    : <Transcript ref={scroller} {...lineProps} lines={section?.subtitles ?? []} cur={cur?.id ?? null}
      onPlay={l => { setFollow(true); L.seek(l.startTime, true); }} onScroll={leave} />;

  return (
    <div className={embedded ? 'flex-1 min-h-0 flex flex-col bg-paper' : 'fixed inset-0 bg-paper flex flex-col pt-[env(safe-area-inset-top)]'}>
      {AUDIO_ENGINE_PLATFORM === 'web' && (
        <>
          <audio ref={L.bindAudio} preload="auto" />
          <WebMediaSession
            meta={{ title: record.displayName, artist: record.podcast?.show ?? '', image: record.podcast?.image }}
            actions={{ play: L.playOn, pause: L.pauseNow, prev: L.prev, next: nextBtn }}
            playing={L.playing}
          />
        </>
      )}
      {!embedded && (
        <div className="pt-2 px-3 pb-1 flex items-center gap-1">
          <button aria-label={t('m.back')} onClick={handleBack} className="w-11 h-11 shrink-0 flex items-center justify-center text-2xl">‹</button>
          <div className="flex-1 min-w-0 flex flex-col">
            <span className="text-[15px] font-semibold truncate">{record.displayName}</span>
            {L.sections.length > 1 && <span className="text-xs text-mute">{t('listen.sectionOf', { n: sec + 1, total: L.sections.length })}</span>}
          </div>
          <button onClick={() => L.goFree(!L.free)} className="min-h-[44px] px-2.5 text-[13px] text-mute">{t(L.free ? 'listen.route' : 'listen.free')}</button>
        </div>
      )}
      {!embedded && ja && <JaBanner />}
      {L.free ? (
        <div className="mx-4 mt-1 flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <div className="inline-flex items-center bg-page rounded-full p-0.5 shadow-card shrink-0">
              {(['hide', 'show'] as const).map(m => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={L.mode === m}
                  onClick={() => L.setMode(m)}
                  className={`min-h-[40px] px-3 rounded-full text-xs whitespace-nowrap ${
                    L.mode === m ? 'bg-ink text-white font-medium' : 'text-mute'
                  }`}
                >
                  {t(`listen.mode_${m}`)}
                </button>
              ))}
            </div>
            <button
              type="button"
              data-testid="listen-free-options"
              aria-expanded={freeMore}
              onClick={() => setFreeMore(v => !v)}
              className={`min-h-[40px] px-3 rounded-full text-xs whitespace-nowrap flex items-center gap-1 shrink-0 ${
                freeMore || freeActiveCount > 0 ? 'bg-accent-soft text-accent font-medium' : 'bg-page shadow-card text-mute'
              }`}
            >
              <span>{t('m.listenOptions')}{freeActiveCount > 0 ? ` · ${freeActiveCount}` : ''}</span>
              <span aria-hidden="true" className="text-[10px] leading-none">{freeMore ? '▴' : '▾'}</span>
            </button>
            {embedded && (
              <button
                type="button"
                onClick={() => { setFreeMore(false); L.goFree(false); }}
                className="ml-auto min-h-[40px] px-2 text-xs text-mute shrink-0 whitespace-nowrap"
              >
                {t('listen.route')}
              </button>
            )}
          </div>
          {freeMore && (
            <div className="flex gap-1.5 flex-wrap pb-0.5">
              <button type="button" aria-pressed={L.throughPref} onClick={L.toggleThrough} className={`min-h-[40px] px-3 rounded-full text-xs ${L.throughPref ? 'bg-accent-soft text-accent font-medium' : 'bg-page shadow-card text-mute'}`}>{t('listen.through')}</button>
              <button type="button" aria-pressed={L.loopLine} onClick={L.toggleLoopLine} className={`min-h-[40px] px-3 rounded-full text-xs ${L.loopLine ? 'bg-accent-soft text-accent font-medium' : 'bg-page shadow-card text-mute'}`}>{t(L.loopLine ? 'm.loopOff' : 'm.loopOn')}</button>
              <button type="button" aria-pressed={L.autoPause} onClick={L.toggleAutoPause} className={`min-h-[40px] px-3 rounded-full text-xs ${L.autoPause ? 'bg-accent-soft text-accent font-medium' : 'bg-page shadow-card text-mute'}`}>{t('m.autoPause')}</button>
              <button type="button" onClick={() => { setFreeMore(false); L.goStep(3); }} className="min-h-[40px] px-3 rounded-full text-xs bg-page shadow-card text-ink">{t('listen.done')}</button>
            </div>
          )}
        </div>
      ) : embedded ? (
        <div className="mx-4 mt-0.5 flex items-center gap-2">
          <StepBar step={step} onStep={L.goStep} className="flex-1" />
          <button type="button" onClick={() => L.goFree(true)} className="min-h-[40px] px-2 text-xs text-mute shrink-0">{t('listen.free')}</button>
        </div>
      ) : <StepBar step={step} onStep={L.goStep} />}

      <div className="flex-1 min-h-0 overflow-y-auto relative">{body}</div>
      {toast && <p role="status" className={`fixed left-1/2 -translate-x-1/2 ${embedded ? 'top-[calc(env(safe-area-inset-top)+112px)]' : 'top-[calc(env(safe-area-inset-top)+64px)]'} z-20 px-4 py-2 rounded-full bg-ink text-white text-sm`}>{toast}</p>}

      <div className="px-4 pt-2">
        {L.inDrill ? <DrillBar n={L.qAt + 1} total={L.queue!.length} play={L.play} tries={L.tries} shown={L.shown} onShow={L.drillShow} onNext={L.drillNext} />
          : !failed && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="h-[50px] px-2.5 rounded-[14px] bg-page text-ink text-[13px] font-medium shadow-card shrink-0 leading-tight active:bg-shade"
                onClick={markPrev}
              >
                {t('m.markPrev')}
              </button>
              <button
                type="button"
                className={`${btnPrimary} h-[50px] flex-1 min-w-0 px-2.5 text-[14px] leading-tight`}
                onClick={markNow}
                disabled={!cur}
                aria-pressed={!!cur && marked.has(cur.id)}
              >
                {cur && marked.has(cur.id) ? t('m.unmarkNow') : t('m.markNow')}
              </button>
              {effMode === 'hide' && peekAt < 0 && (
                <button
                  type="button"
                  className="h-[50px] px-2.5 rounded-[14px] bg-page text-ink text-[13px] font-medium shadow-card shrink-0 leading-tight disabled:opacity-50 active:bg-shade"
                  onClick={L.openPeek}
                  disabled={!cur}
                >
                  {t('listen.peek')}
                </button>
              )}
            </div>
          )}
      </div>
      <div className="px-5 pt-2 pb-[max(12px,env(safe-area-inset-bottom))] flex items-center justify-between">
        <button type="button" className={`${round} text-[13px] text-mute`} onClick={L.cycleSpeed} aria-label={t('m.speed')}>{L.speed === 1 ? '1.0' : L.speed}×</button>
        <button type="button" className={round} aria-label={t('m.prevLine')} onClick={L.prev}><Icon d="M15 18l-6-6 6-6M6 6v12" size={22} /></button>
        <button type="button" className="w-[60px] h-[60px] rounded-full bg-ink text-white flex items-center justify-center" aria-label={t(L.playing ? 'm.pause' : 'm.play')} onClick={L.toggle} disabled={!L.ready || !!failed}>
          {L.playing ? <Icon d="M9 6v12M15 6v12" size={24} /> : <Icon d="M7 4l13 8-13 8z" fill size={24} />}
        </button>
        <button type="button" className={round} aria-label={t('m.nextLine')} onClick={nextBtn}><Icon d="M9 18l6-6-6-6M18 6v12" size={22} /></button>
        <button type="button" className={round} aria-label={t('m.replayLine')} onClick={L.replay}><Icon d="M1 4v6h6M3.5 15a9 9 0 1 0 2.1-9.4L1 10" size={21} /></button>
      </div>

      {L.passCard && !L.summary && (
        <PassSheet hard={L.hard} ask={<HeardAsk said={L.said.get(sec)} onAnswer={L.answer} />}
          on={L.easy ? t(L.lastSec ? 'listen.done' : 'listen.next') : null}
          onStart={() => L.startPass(2)} onOn={L.moveOn} onClose={() => L.setPassCard(false)} />
      )}
      {L.summary && (
        <Summary key={`${sec}-${L.summary.ended}`} title={L.summary.ended || L.lastSec ? t('listen.allDone') : t('listen.sectionDone', { n: sec + 1 })}
          missed={sumMissed} saved={sumSaved} words={words.map(w => ({ word: w.word, key: w.key, kept: w.kept, can: !!w.fields }))}
          onward={!L.summary.ended && !L.lastSec}
          onRemoveMissed={onRemoveMissed} onUndoMissed={onUndoMissed}
          onKeep={keepWord} onAgain={() => L.goSection(sec)} onNext={() => L.goSection(sec + 1)} onHome={handleBack} onClose={() => L.setSummary(null)} />
      )}
      {def && <WordSheet key={`${def.word}|${def.line.id}`} def={def} onClose={closeDef} onExplain={explain} onKeep={k => keep(k, ref)} onPlayLine={L.playLine} />}
    </div>
  );
};
