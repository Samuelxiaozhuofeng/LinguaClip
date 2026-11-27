// Touch AI Cloze way (docs/android-roadmap.md M2.2).
// Reuses utils/clozePrep.ts (cached per record in <id>.cloze.json / IndexedDB cache)
// and utils/aiDrills.ts (pickBlanks, canCloze). Missing / slow / failed AI never blocks listening.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClozeLevel, Subtitle } from '../../types';
import { useSavedLines } from '../../hooks/useSavedLines';
import { canCloze, pickBlanks } from '../../utils/aiDrills';
import { getClozeJob, prepareCloze, subscribeCloze } from '../../utils/clozePrep';
import { detectLang } from '../../utils/dictionary';
import { useT } from '../../utils/i18n';
import { loadJa, useJaVersion } from '../../utils/japanese';
import { settleSplits } from '../../utils/jaSegments';
import { addLine, clearMastered } from '../../utils/review';
import { getLooseJudge, getPracticeConfig, savePracticeConfig } from '../../utils/storage';
import { getWordTokens, judgeWord, tokenizeText } from '../../utils/textTokenizer';
import { countLine } from '../../utils/today';
import { autoAddOn } from '../autoAdd';
import { errText } from '../ui';
import { useWordLookup } from '../useWordLookup';
import { WordSheet } from '../WordSheet';
import { BreakdownSheet } from './BreakdownSheet';
import { ClozeBar, ClozeLine } from './ClozeLine';
import {
  AUTO_NEXT_MS,
  aroundOf,
  hasAnyClozeInput,
  padSecOf,
  sortedLines,
  startIndexForSec,
  stripLookupPunct,
} from './drillCommon';
import type { WayProps } from './types';
import { useKeyboardBackClose, useKeyboardInset } from './useKeyboardInset';
import { PlayerAudio, useLinePlayer } from './useLinePlayer';

type ClozeDensity = 'easy' | 'medium';

function initialDensity(): ClozeDensity {
  const saved: ClozeLevel | undefined = getPracticeConfig().clozeLevel;
  return saved === 'easy' ? 'easy' : 'medium';
}

export const ClozeWay: React.FC<WayProps> = ({ record, startSec, onPos, onLine, onExit }) => {
  const t = useT();
  const lines = useMemo(() => sortedLines(record.subtitleText), [record.subtitleText]);
  const lineTexts = useMemo(() => lines.map(l => l.text), [lines]);
  const lang = useMemo(() => detectLang(lineTexts), [lineTexts]);
  const ja = lang === 'ja';
  const jaVersion = useJaVersion();
  useEffect(() => {
    if (!ja) return;
    void loadJa();
    settleSplits(record.id, lineTexts).catch(() => {});
  }, [ja, record.id, lineTexts]);

  const player = useLinePlayer(record, lines);
  const { savedIds, toggleSave } = useSavedLines({
    videoId: record.id,
    fullSubtitles: lines,
    videoFileName: record.videoFileName,
  });
  const { def, lookup, explain, close: closeDef, keep } = useWordLookup(lang, ja);
  const kbInset = useKeyboardInset();

  const hasAi = canCloze();
  const lenient = useMemo(getLooseJudge, []);
  const pad = useMemo(padSecOf, []);

  const [density, setDensity] = useState<ClozeDensity>(initialDensity);
  const [ranked, setRanked] = useState<(number[] | null)[] | null>(null);
  const [prepState, setPrepState] = useState<'idle' | 'loading' | 'ready' | 'failed'>(hasAi ? 'loading' : 'idle');
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [tries, setTries] = useState(0);

  const [idx, setIdx] = useState(() => startIndexForSec(lines, startSec));
  const [done, setDone] = useState(false);
  const [inputs, setInputs] = useState<Record<number, string>>({});
  const [leftBlanks, setLeftBlanks] = useState<Set<number>>(() => new Set());
  const [submitted, setSubmitted] = useState(false);
  const [allRight, setAllRight] = useState(false);
  const [showBreakdown, setShowBreakdown] = useState(false);

  const inputRefs = useRef<Record<number, HTMLInputElement | null>>({});
  const composingRef = useRef<Record<number, boolean>>({});
  const autoTimer = useRef<number | null>(null);
  const countedLinesRef = useRef<Set<number>>(new Set());
  const stuckLineRef = useRef(false);

  const clearAuto = useCallback(() => {
    if (autoTimer.current !== null) {
      window.clearTimeout(autoTimer.current);
      autoTimer.current = null;
    }
  }, []);
  useEffect(() => clearAuto, [clearAuto]);

  useKeyboardBackClose(kbInset, showBreakdown || !!def);

  useEffect(() => {
    clearAuto();
    countedLinesRef.current = new Set();
    setIdx(startIndexForSec(lines, startSec));
    setDone(false);
  }, [record.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Prepare cloze ranking in background (cached in <id>.cloze.json / IndexedDB cache).
  useEffect(() => {
    if (!hasAi || lineTexts.length === 0) {
      setPrepState('idle');
      return;
    }
    let live = true;
    setPrepState('loading');
    const sync = () => {
      const job = getClozeJob(record.id);
      if (live) setProgress(job && job.total > 0 ? { done: job.done, total: job.total } : null);
    };
    const unsub = subscribeCloze(sync);
    sync();
    prepareCloze(record.id, lineTexts, true)
      .then(res => {
        if (!live) return;
        setRanked(res);
        setPrepState(res.some(Boolean) ? 'ready' : 'failed');
      })
      .catch(() => {
        if (live) setPrepState('failed');
      })
      .finally(() => {
        if (live) setProgress(null);
      });
    return () => {
      live = false;
      unsub();
    };
  }, [hasAi, record.id, lineTexts, tries]);

  const line: Subtitle | undefined = lines[idx];
  const tokens = useMemo(
    () => (line ? tokenizeText(line.text) : []),
    [line, jaVersion], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const wordTokens = useMemo(() => getWordTokens(tokens), [tokens]);
  const lineRanking = ranked?.[idx] ?? null;
  const blanks = useMemo(
    () => (lineRanking ? pickBlanks(lineRanking, wordTokens.length, density).slice().sort((a, b) => a - b) : []),
    [lineRanking, wordTokens.length, density],
  );
  const blankSet = useMemo(() => new Set(blanks), [blanks]);

  useEffect(() => {
    clearAuto();
    stuckLineRef.current = false;
    setInputs({});
    setLeftBlanks(new Set());
    setSubmitted(false);
    setAllRight(false);
    setShowBreakdown(false);
    composingRef.current = {};
    if (!line || done) return;
    onPos(line.startTime);
    onLine?.(idx + 1, lines.length);
    player.playLine(idx, pad);
  }, [idx, done, line?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const countOnce = useCallback(() => {
    if (!line || countedLinesRef.current.has(line.id)) return;
    countedLinesRef.current.add(line.id);
    countLine();
  }, [line]);

  const changeDensity = (next: ClozeDensity) => {
    setDensity(next);
    savePracticeConfig({ ...getPracticeConfig(), clozeLevel: next });
    setInputs({});
    setLeftBlanks(new Set());
    setSubmitted(false);
    setAllRight(false);
  };

  const advance = useCallback(() => {
    clearAuto();
    if (idx + 1 < lines.length) {
      setIdx(i => i + 1);
    } else {
      player.pause();
      setDone(true);
    }
  }, [clearAuto, idx, lines.length, player]);

  const recordStuck = useCallback((reason: 'wrong' | 'peek') => {
    if (!line || stuckLineRef.current) return;
    stuckLineRef.current = true;
    clearMastered(record.id, line.startTime).catch(() => {});
    if (autoAddOn()) {
      addLine(
        {
          videoId: record.id,
          videoName: record.videoFileName,
          videoPath: record.videoPath,
          text: line.text,
          start: line.startTime,
          end: line.endTime,
        },
        reason,
      ).catch(console.error);
    }
  }, [line, record.id, record.videoFileName, record.videoPath]);

  const finishRight = useCallback(() => {
    setAllRight(true);
    setSubmitted(true);
    countOnce();
    clearAuto();
    autoTimer.current = window.setTimeout(() => {
      autoTimer.current = null;
      advance();
    }, AUTO_NEXT_MS);
  }, [advance, clearAuto, countOnce]);

  const isBlankRight = useCallback((bi: number, map: Record<number, string>) => {
    const tk = wordTokens[bi];
    if (!tk) return false;
    return judgeWord(map[bi] ?? '', tk.value, tk.reading, lenient) === 'right';
  }, [lenient, wordTokens]);

  const settleBlank = useCallback((bi: number, nextMap: Record<number, string>) => {
    if (!isBlankRight(bi, nextMap)) return;
    if (blanks.length > 0 && blanks.every(b => isBlankRight(b, nextMap))) {
      finishRight();
      return;
    }
    const nextOpen = blanks.find(b => b > bi && !isBlankRight(b, nextMap))
      ?? blanks.find(b => !isBlankRight(b, nextMap));
    if (nextOpen !== undefined) inputRefs.current[nextOpen]?.focus();
  }, [blanks, finishRight, isBlankRight]);

  const handleBlankChange = (bi: number, val: string, composing: boolean) => {
    const nextMap = { ...inputs, [bi]: val };
    setInputs(nextMap);
    if (submitted && !allRight) setSubmitted(false);
    if (composing || composingRef.current[bi]) return;
    settleBlank(bi, nextMap);
  };

  const handleSubmit = () => {
    if (blanks.length === 0 || !hasAnyClozeInput(blanks, inputs)) return;
    countOnce();
    if (blanks.every(b => isBlankRight(b, inputs))) {
      finishRight();
    } else {
      setSubmitted(true);
      recordStuck('wrong');
    }
  };

  const handleWordTap = (raw: string) => {
    if (!line) return;
    const clean = stripLookupPunct(raw);
    if (!clean) return;
    player.pause();
    void lookup(clean, line, aroundOf(lines, idx));
  };

  const wordRef = useMemo(
    () => ({ videoId: record.id, videoName: record.videoFileName }),
    [record.id, record.videoFileName],
  );

  if (lines.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 px-8 text-center">
        <PlayerAudio player={player} />
        <p className="text-sm text-mute">{t('m.dictNoLines')}</p>
        <button type="button" onClick={onExit} className="min-h-[44px] px-6 rounded-xl bg-page shadow-card text-sm font-medium">
          {t('m.toHome')}
        </button>
      </div>
    );
  }

  if (done) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 px-8 text-center">
        <PlayerAudio player={player} />
        <h2 className="text-xl font-semibold text-ink">{t('m.dictDoneTitle')}</h2>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => { setDone(false); setIdx(0); }}
            className="min-h-[46px] px-5 rounded-xl bg-page shadow-card text-[15px] font-medium text-ink"
          >
            {t('m.dictRestart')}
          </button>
          <button
            type="button"
            onClick={onExit}
            className="min-h-[46px] px-5 rounded-xl bg-accent text-white text-[15px] font-semibold"
          >
            {t('m.toHome')}
          </button>
        </div>
      </div>
    );
  }

  const audioErr = player.errorCode
    ? (player.errorCode === 'listen.failed' ? t('listen.failed') : errText(player.errorCode))
    : '';
  const isSaved = !!line && savedIds.has(line.id);
  const canFill = hasAi && blanks.length > 0;
  const canSubmit = hasAnyClozeInput(blanks, inputs);

  return (
    <div
      className="flex-1 min-h-0 flex flex-col bg-paper"
      style={kbInset > 0 ? { paddingBottom: kbInset } : undefined}
    >
      <PlayerAudio player={player} />

      <div className="flex-1 min-h-0 overflow-y-auto px-4 pt-2 pb-4 flex flex-col gap-2.5">
        {!hasAi && (
          <div role="status" data-testid="cloze-no-key" className="bg-page rounded-2xl shadow-card px-4 py-4">
            <p className="text-[14px] leading-relaxed text-ink">{t('m.clozeNeedKey')}</p>
          </div>
        )}

        {hasAi && prepState === 'loading' && !lineRanking && (
          <div role="status" className="bg-page rounded-2xl shadow-card px-4 py-4 text-sm text-mute">
            {progress ? t('m.clozePreparingProg', progress) : t('m.clozePreparing')}
          </div>
        )}

        {hasAi && prepState === 'failed' && !lineRanking && (
          <div role="alert" className="bg-page rounded-2xl shadow-card px-4 py-4 flex items-center justify-between gap-3">
            <span className="text-sm text-accent">{t('m.clozeFailed')}</span>
            <button
              type="button"
              onClick={() => setTries(n => n + 1)}
              className="min-h-[44px] px-4 rounded-xl bg-shade text-ink text-sm font-medium shrink-0"
            >
              {t('m.retry')}
            </button>
          </div>
        )}

        {audioErr && <p role="alert" className="text-xs text-accent px-1">{audioErr}</p>}

        {canFill && (
          <div className="relative bg-page rounded-2xl shadow-card px-4 pt-7 pb-3.5 flex flex-col gap-3">
            <button
              type="button"
              data-testid="cloze-density"
              aria-label={t('studio.clozeLabel')}
              onClick={() => changeDensity(density === 'easy' ? 'medium' : 'easy')}
              className="absolute top-0.5 right-2.5 min-h-[40px] inline-flex items-center px-1 active:opacity-80"
            >
              <span className="h-[24px] px-2.5 rounded-full bg-shade text-mute text-[11px] font-medium inline-flex items-center gap-1 whitespace-nowrap">
                <span>{t(density === 'easy' ? 'm.clozeLevelEasy' : 'm.clozeLevelMedium')}</span>
                <span aria-hidden>⇄</span>
              </span>
            </button>

            <ClozeLine
              tokens={tokens}
              blanks={blanks}
              blankSet={blankSet}
              inputs={inputs}
              leftBlanks={leftBlanks}
              submitted={submitted}
              lenient={lenient}
              inputRefs={inputRefs}
              composingRef={composingRef}
              onBlankChange={handleBlankChange}
              onBlankCompositionEnd={(bi, val) => {
                const nextMap = { ...inputs, [bi]: val };
                setInputs(nextMap);
                settleBlank(bi, nextMap);
              }}
              onBlankFocus={bi => {
                setLeftBlanks(prev => {
                  if (!prev.has(bi)) return prev;
                  const n = new Set(prev);
                  n.delete(bi);
                  return n;
                });
              }}
              onBlankBlur={bi => {
                setLeftBlanks(prev => new Set(prev).add(bi));
              }}
              onBlankEnter={bi => {
                const nextB = blanks.find(b => b > bi && !isBlankRight(b, inputs));
                if (nextB !== undefined) inputRefs.current[nextB]?.focus();
                else handleSubmit();
              }}
              onWordTap={handleWordTap}
            />

            {allRight && (
              <p role="status" data-testid="cloze-all-right" className="self-start px-3 py-1 rounded-full bg-shade text-ink text-[13px] font-medium">
                {stuckLineRef.current ? t('m.fxRightAfterWrong') : t('m.dictAllRightAuto')}
              </p>
            )}

            {submitted && !allRight && line && (
              <div className="pt-1 border-t border-shade flex items-center justify-end gap-1.5 -mb-1" data-testid="cloze-actions">
                {hasAi && (
                  <button
                    type="button"
                    onClick={() => { player.pause(); setShowBreakdown(true); }}
                    className="min-h-[40px] inline-flex items-center active:opacity-80"
                  >
                    <span className="h-[34px] px-3 rounded-lg bg-shade text-ink text-[13px] font-medium inline-flex items-center whitespace-nowrap">
                      {t('studio.breakdown')}
                    </span>
                  </button>
                )}
                <button
                  type="button"
                  aria-pressed={isSaved}
                  onClick={() => toggleSave(line)}
                  className="min-h-[40px] inline-flex items-center active:opacity-80"
                >
                  <span
                    className={`h-[34px] px-3 rounded-lg text-[13px] font-medium inline-flex items-center whitespace-nowrap ${
                      isSaved ? 'bg-accent-soft text-accent' : 'bg-shade text-ink'
                    }`}
                  >
                    {isSaved ? t('m.saved') : t('m.dictSaveLine')}
                  </span>
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <ClozeBar
        canFill={canFill}
        canSubmit={canSubmit}
        submitted={submitted}
        rate={player.rate}
        kbInset={kbInset}
        canPrev={idx > 0}
        canNext={idx + 1 < lines.length}
        onReplay={() => player.playLine(idx, pad)}
        onToggleSlow={() => player.setRate(player.rate < 0.99 ? 1 : 0.75)}
        onReveal={() => { countOnce(); setSubmitted(true); recordStuck('peek'); }}
        onSubmit={handleSubmit}
        onPrev={() => setIdx(i => Math.max(0, i - 1))}
        onNext={advance}
      />

      {showBreakdown && line && (
        <BreakdownSheet
          record={record}
          line={line}
          around={aroundOf(lines, idx)}
          onClose={() => setShowBreakdown(false)}
        />
      )}

      {def && (
        <WordSheet
          key={`${def.word}|${def.line.id}`}
          def={def}
          onClose={closeDef}
          onExplain={explain}
          onKeep={k => keep(k, wordRef)}
          onPlayLine={l => player.playSubtitle(l, pad)}
        />
      )}
    </div>
  );
};
