// Phone "Read first" (先读字幕) practice way (docs/reader.md, docs/android-roadmap.md M2.3).
// Study.tsx owns the top header & way switcher; ReadWay renders only the sticky mini player bar,
// collapsible Keywords & Episode Phrases cards, the full subtitle list with non-blocking AI
// translations, tap-word & long-press phrase lookup, and the "Break it down" sheet.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Subtitle, VideoRecord } from '../../types';
import { useSavedLines } from '../../hooks/useSavedLines';
import { getTransJob, parseTransCache, prepareTrans, subscribeTrans, type TransTo } from '../../pro/transPrep';
import { canCloze, hashSrt } from '../../utils/aiDrills';
import { detectLang } from '../../utils/dictionary';
import { useLang, useT } from '../../utils/i18n';
import { loadJa, useJaVersion } from '../../utils/japanese';
import { settleSplits } from '../../utils/jaSegments';
import { addLooked, getLooked, getReadPos, lookedKey, setGloss, setReadPos, useLookedVersion } from '../../utils/readLooked';
import { lineAt, parseSRT } from '../../utils/srtParser';
import { getWatchPrefs, saveWatchPrefs } from '../../utils/storage';
import { readCacheText } from '../platform/desktop';
import { errText } from '../ui';
import { useWordLookup, type Def } from '../useWordLookup';
import { WordSheet } from '../WordSheet';
import { KeywordsCard } from '../reader/KeywordsCard';
import { MiniPlayerBar } from '../reader/MiniPlayerBar';
import { PhrasesCard, useReaderPhrases } from '../reader/PhrasesCard';
import { ReadLine } from '../reader/ReadLine';
import { ReaderAudio, useReaderPlayer } from '../reader/useReaderPlayer';
import { BreakdownSheet } from './BreakdownSheet';
import type { WayProps } from './types';

function firstPlainMeaning(def: Def, key: string | null): string {
  const entry = def.dict?.find(e => e.word === key) ?? def.dict?.[0];
  const sense = entry?.senses[0];
  if (sense) {
    const rows = sense.text
      .map(p => (typeof p === 'string' ? p : 'ruby' in p ? p.ruby : ''))
      .join('')
      .split('\n')
      .map(r => r.trim())
      .filter(Boolean);
    return rows.find(r => /[\u4e00-\u9fff]/.test(r)) ?? rows[0] ?? '';
  }
  return (def.ai?.definition ?? '').replace(/<[^>]*>/g, '');
}

function resolveInitialIndex(record: VideoRecord, lines: Subtitle[], startSec: number): number {
  if (!lines.length) return 0;
  if (Number.isFinite(startSec) && startSec > 0) {
    const i = lineAt(lines, startSec);
    if (i >= 0) return i;
  }
  const readPos = getReadPos(record.id);
  if (readPos > 0) {
    const i = lines.findIndex(l => l.startTime >= readPos - 0.01);
    if (i >= 0) return i;
  }
  return 0;
}

export const ReadWay: React.FC<WayProps> = ({ record, startSec, onPos, onLine }) => {
  const t = useT();
  const uiLang = useLang();
  const transTo: TransTo = uiLang === 'en' ? 'en' : 'zh';

  const lines = useMemo(
    () => [...parseSRT(record.subtitleText)].sort((a, b) => a.startTime - b.startTime),
    [record.subtitleText],
  );
  const indexOf = useMemo(() => new Map(lines.map((l, i) => [l.id, i])), [lines]);
  const initialIndex = useMemo(
    () => resolveInitialIndex(record, lines, startSec),
    [record.id, lines], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const dictLang = useMemo(() => detectLang(lines.map(l => l.text)), [lines]);
  const ja = dictLang === 'ja';
  const jaVersion = useJaVersion();
  useEffect(() => {
    if (ja) {
      void loadJa();
      settleSplits(record.id, lines.map(l => l.text)).catch(() => {});
    }
  }, [ja, record.id, lines]);

  const [kana, setKana] = useState(() => getWatchPrefs().kana);
  const toggleKana = () => {
    setKana(prev => {
      const next = !prev;
      saveWatchPrefs({ kana: next });
      return next;
    });
  };

  // --- Position reporting: sync linguaclip_read_pos + Study's shared linguaclip_watch_pos ---
  const onActiveLine = useCallback((idx: number) => {
    const line = lines[idx];
    if (!line) return;
    onPos(line.startTime);
    onLine?.(idx + 1, lines.length);
    setReadPos(record.id, idx === 0 ? 0 : line.startTime);
  }, [lines, onLine, onPos, record.id]);

  const player = useReaderPlayer(record, lines, initialIndex, onActiveLine);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const userScrollingRef = useRef(false);
  const scrollIdleRef = useRef<number | null>(null);

  useEffect(() => {
    if (lines.length > 0) {
      onLine?.(initialIndex + 1, lines.length);
    }
  }, [lines.length, initialIndex, onLine]);

  useEffect(() => () => {
    if (scrollIdleRef.current !== null) window.clearTimeout(scrollIdleRef.current);
  }, []);

  // Scroll to initial line on mount when resuming mid-episode.
  useEffect(() => {
    if (initialIndex <= 0) return;
    const line = lines[initialIndex];
    if (!line) return;
    const id = requestAnimationFrame(() => {
      scrollerRef.current?.querySelector(`[data-line="${line.id}"]`)?.scrollIntoView({ block: 'center' });
    });
    return () => cancelAnimationFrame(id);
  }, [record.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const scrollToLine = useCallback((lineId: number, smooth = true) => {
    requestAnimationFrame(() => {
      scrollerRef.current
        ?.querySelector(`[data-line="${lineId}"]`)
        ?.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
    });
  }, []);

  // Auto-scroll active line into view during playback unless user is actively scrolling.
  useEffect(() => {
    const curLine = lines[player.current];
    if (!curLine || userScrollingRef.current) return;
    scrollToLine(curLine.id, true);
  }, [player.current, lines, scrollToLine]);

  // --- Translations (pro/transPrep.ts): cached per SRT hash, background AI fill, retry on failure ---
  const hasAi = canCloze();
  const [showTrans, setShowTrans] = useState(true);
  const [trans, setTrans] = useState<(string | null)[] | null>(null);
  const [transBusy, setTransBusy] = useState(false);
  const [transFailed, setTransFailed] = useState(false);
  const texts = useMemo(() => lines.map(l => l.text), [lines]);
  const srtHash = useMemo(() => hashSrt(texts.join('\n')), [texts]);

  const runTrans = useCallback((askAiIfMissing: boolean) => {
    if (!texts.length) return;
    let live = true;
    const startAi = () => {
      if (!hasAi || !live) return;
      setTransBusy(true);
      setTransFailed(false);
      prepareTrans(record.id, texts, transTo)
        .then(res => {
          if (!live) return;
          setTrans(res);
          const anyMissing = res.some(x => x === null);
          setTransFailed(anyMissing);
        })
        .catch(e => {
          console.error(e);
          if (live) setTransFailed(true);
        })
        .finally(() => {
          if (live) setTransBusy(false);
        });
    };

    readCacheText(record.id, 'trans').then(raw => {
      if (!live) return;
      const cached = raw ? parseTransCache(raw, srtHash, transTo, texts.length) : null;
      if (cached) setTrans(cached);
      const complete = !!cached && cached.every(Boolean);
      if (!complete && askAiIfMissing && hasAi) startAi();
    }, () => {
      if (askAiIfMissing && hasAi) startAi();
    });

    return () => { live = false; };
  }, [record.id, texts, srtHash, transTo, hasAi]);

  useEffect(() => runTrans(true), [runTrans]);

  useEffect(() => subscribeTrans(() => {
    const job = getTransJob(record.id);
    if (job) {
      setTrans(job.lines);
      if (job.failed) setTransFailed(true);
    }
  }), [record.id]);

  // --- Looked-up words, saved lines, phrases, breakdown ---
  const lookedVersion = useLookedVersion();
  const looked = useMemo(() => new Set(getLooked(record.id)), [record.id, lookedVersion]);
  const { savedIds, toggleSave } = useSavedLines({
    videoId: record.id,
    fullSubtitles: lines,
    videoFileName: record.videoFileName,
  });
  const ref = useMemo(() => ({ videoId: record.id, videoName: record.videoFileName }), [record.id, record.videoFileName]);

  const { def, lookup, explain, close, keep } = useWordLookup(dictLang, ja);
  const [breakdownLine, setBreakdownLine] = useState<Subtitle | null>(null);

  const aroundOf = useCallback((line: Subtitle) => {
    const i = indexOf.get(line.id) ?? -1;
    return [lines[i - 1]?.text, lines[i + 1]?.text].filter(Boolean).join('\n');
  }, [indexOf, lines]);

  const openLookup = useCallback((text: string, line: Subtitle, isPhrase: boolean) => {
    player.pause();
    addLooked(record.id, text, ja);
    const idx = indexOf.get(line.id);
    if (idx !== undefined) player.focusLine(idx);
    void lookup(text, line, aroundOf(line), isPhrase);
  }, [player, record.id, ja, indexOf, lookup, aroundOf]);

  const onWord = useCallback((word: string, line: Subtitle) => openLookup(word, line, false), [openLookup]);
  const onPhrase = useCallback((phrase: string, line: Subtitle) => openLookup(phrase, line, true), [openLookup]);

  useEffect(() => {
    if (!def || def.loading) return;
    if (def.dict || def.ai) {
      const key = lookedKey(def.word, ja);
      const meaning = firstPlainMeaning(def, key);
      if (meaning) setGloss(record.id, def.word, ja, meaning);
    }
  }, [def, ja, record.id]);

  const phrases = useReaderPhrases(record, lines);
  const jumpToLine = useCallback((line: Subtitle) => {
    const idx = indexOf.get(line.id);
    if (idx === undefined) return;
    userScrollingRef.current = false;
    player.focusLine(idx);
    scrollToLine(line.id, true);
  }, [indexOf, player, scrollToLine]);

  const playSpecificLine = useCallback((line: Subtitle) => {
    const idx = indexOf.get(line.id);
    if (idx === undefined) return;
    userScrollingRef.current = false;
    player.playLine(idx, 'single');
  }, [indexOf, player]);

  const openBreakdown = useCallback((line: Subtitle) => {
    player.pause();
    setBreakdownLine(line);
  }, [player]);

  const onUserScroll = () => {
    userScrollingRef.current = true;
    if (scrollIdleRef.current !== null) window.clearTimeout(scrollIdleRef.current);
    scrollIdleRef.current = window.setTimeout(() => {
      userScrollingRef.current = false;
      scrollIdleRef.current = null;
    }, 1800);
  };

  if (lines.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center px-8 text-center text-sm text-mute">
        {t('m.readEmpty')}
      </div>
    );
  }

  const audioErr = player.errorCode
    ? (player.errorCode === 'listen.failed' ? t('listen.failed') : errText(player.errorCode))
    : '';
  const hasAnyTrans = hasAi || !!trans?.some(Boolean);

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-paper">
      <ReaderAudio player={player} />

      <MiniPlayerBar
        lineNum={player.current + 1}
        total={lines.length}
        playing={player.playing}
        disabled={!player.ready || !!audioErr}
        mode={player.mode}
        rate={player.rate}
        ja={ja}
        kana={kana}
        showTrans={showTrans}
        hasTrans={hasAnyTrans}
        onToggle={player.toggle}
        onModeChange={player.setMode}
        onRateChange={player.setRate}
        onKanaToggle={toggleKana}
        onTransToggle={() => setShowTrans(v => !v)}
      />

      <div
        ref={scrollerRef}
        onTouchMove={onUserScroll}
        onWheel={onUserScroll}
        className="flex-1 min-h-0 overflow-y-auto px-4 pt-3 pb-[max(28px,env(safe-area-inset-bottom))] space-y-3"
      >
        {audioErr && (
          <p role="alert" className="px-3.5 py-2.5 rounded-xl bg-accent-soft text-xs text-accent">
            {audioErr}
          </p>
        )}

        <KeywordsCard
          record={record}
          lines={lines}
          lang={dictLang}
          onJumpLine={jumpToLine}
          onPlayLine={playSpecificLine}
        />

        <PhrasesCard record={record} phrases={phrases} onJump={jumpToLine} />

        {showTrans && transBusy && !trans?.every(Boolean) && (
          <p className="px-2 text-xs text-mute" role="status">{t('m.readTransWait')}</p>
        )}
        {showTrans && !transBusy && transFailed && hasAi && (
          <div className="px-3 py-2 rounded-xl bg-shade flex items-center justify-between gap-2">
            <span className="text-xs text-mute">{t('m.readTransFail')}</span>
            <button
              type="button"
              onClick={() => runTrans(true)}
              className="min-h-[36px] px-3 rounded-lg bg-page text-xs font-medium text-accent shadow-card"
            >
              {t('m.readTransRetry')}
            </button>
          </div>
        )}

        <div className="flex flex-col gap-1">
          {lines.map((line, i) => (
            <ReadLine
              key={line.id}
              line={line}
              index={i}
              ja={ja}
              jaVersion={jaVersion}
              kana={kana}
              looked={looked}
              active={player.current === i}
              playing={player.playing && player.current === i}
              saved={savedIds.has(line.id)}
              showTrans={showTrans}
              transText={trans?.[i] ?? null}
              transFailed={!transBusy && transFailed && hasAi}
              marks={phrases.marks.get(line.id)}
              onPlay={idx => player.playLine(idx)}
              onWord={onWord}
              onPhrase={onPhrase}
              onSave={toggleSave}
              onBreakdown={openBreakdown}
              onRetryTrans={hasAi ? () => runTrans(true) : undefined}
            />
          ))}
        </div>
      </div>

      {def && (
        <WordSheet
          key={`${def.word}|${def.line.id}`}
          def={def}
          onClose={close}
          onExplain={explain}
          onKeep={k => keep(k, ref)}
          onPlayLine={playSpecificLine}
        />
      )}

      {breakdownLine && (
        <BreakdownSheet
          record={record}
          line={breakdownLine}
          around={aroundOf(breakdownLine)}
          lang={dictLang}
          onPlayLine={() => playSpecificLine(breakdownLine)}
          onClose={() => setBreakdownLine(null)}
        />
      )}
    </div>
  );
};
