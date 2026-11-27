// Touch AI Custom way (docs/android-roadmap.md M2.2, docs/android.md「手机学习闭环」).
// Reuses desktop selection logic (utils/customPick.ts + utils/levelPrep.ts + practice_config.custom).
// Single-column list of picked lines: active line highlighted, tapping any line selects & plays it,
// bottom reuses DictDock for sentence-by-sentence dictation with near-miss/extra feedback,
// cached translations, independent vs helped status, and keyboard avoidance.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Subtitle } from '../../types';
import { useSavedLines } from '../../hooks/useSavedLines';
import { canCloze } from '../../utils/aiDrills';
import { pickCustom, type CustomConfig } from '../../utils/customPick';
import { detectLang } from '../../utils/dictionary';
import { useT } from '../../utils/i18n';
import { loadJa, useJaVersion } from '../../utils/japanese';
import { settleSplits } from '../../utils/jaSegments';
import { getLevelJob, prepareLevels, subscribeLevels } from '../../utils/levelPrep';
import { addLine, clearMastered } from '../../utils/review';
import {
  getCustomConfig,
  getCustomPos,
  getLooseJudge,
  saveCustomConfig,
  setCustomPos,
} from '../../utils/storage';
import { countLine } from '../../utils/today';
import { autoAddOn } from '../autoAdd';
import { checkDictation, tokenizeDictation, type Checked } from '../dictation';
import { errText } from '../ui';
import { useWordLookup } from '../useWordLookup';
import { WordSheet } from '../WordSheet';
import { BreakdownSheet } from './BreakdownSheet';
import { CustomControls, CustomDoneCard, CustomInactiveRow } from './CustomControls';
import { DictDock } from './DictDock';
import { DictStatusBar } from './DictStatusBar';
import { GradedLine } from './GradedLine';
import {
  AUTO_NEXT_MS,
  aroundOf,
  nextHintIndex,
  padSecOf,
  sortedLines,
} from './drillCommon';
import type { WayProps } from './types';
import { useCachedTrans } from './useCachedTrans';
import { useKeyboardBackClose, useKeyboardInset } from './useKeyboardInset';
import { PlayerAudio, useLinePlayer } from './useLinePlayer';
import { useRoundLabels } from './useRoundLabels';

export const CustomWay: React.FC<WayProps> = ({ record, startSec, onPos, onLine, onExit }) => {
  const t = useT();
  const lines = useMemo(() => sortedLines(record.subtitleText), [record.subtitleText]);
  const lang = useMemo(() => detectLang(lines.map(l => l.text)), [lines]);
  const ja = lang === 'ja';
  const jaVersion = useJaVersion();
  useEffect(() => {
    if (!ja) return;
    void loadJa();
    settleSplits(record.id, lines.map(l => l.text)).catch(() => {});
  }, [ja, record.id, lines]);

  const trans = useCachedTrans(record.id, lines);
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

  const [cfg, setCfg] = useState<CustomConfig>(() => {
    const c = getCustomConfig();
    return hasAi ? c : { ...c, level: null };
  });
  const [fromSec, setFromSec] = useState(() => (startSec > 0 ? startSec : getCustomPos(record.id)));
  const { labels, offer: setLabels, markBusy, newRound, reset: resetLabels } = useRoundLabels();
  const [prepState, setPrepState] = useState<'idle' | 'loading' | 'ready' | 'failed'>(hasAi ? 'loading' : 'idle');
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [tries, setTries] = useState(0);

  const [pos, setPos] = useState(0);
  const [setDone, setSetDone] = useState(false);
  const [doneLines, setDoneLines] = useState<Set<number>>(() => new Set());
  const [stuckLines, setStuckLines] = useState<Set<number>>(() => new Set());
  const [typed, setTyped] = useState('');
  const [hinted, setHinted] = useState<Set<number>>(() => new Set());
  const [result, setResult] = useState<Checked | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [everRevealed, setEverRevealed] = useState(false);
  const [wrongTries, setWrongTries] = useState(0);
  const [showBreakdown, setShowBreakdown] = useState(false);

  const autoTimer = useRef<number | null>(null);
  const countedLinesRef = useRef<Set<number>>(new Set());
  const stuckLineRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

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
    resetLabels();
    countedLinesRef.current = new Set();
    setFromSec(startSec > 0 ? startSec : getCustomPos(record.id));
    setPos(0);
    setSetDone(false);
    setDoneLines(new Set());
    setStuckLines(new Set());
  }, [record.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Grade lines with AI when AI Key is configured (cached in <id>.levels.json / IndexedDB cache).
  useEffect(() => {
    if (!hasAi || lines.length === 0) {
      setPrepState('idle');
      return;
    }
    let live = true;
    setPrepState('loading');
    const sync = () => {
      const job = getLevelJob(record.id);
      if (live) setProgress(job && job.total > 0 ? { done: job.done, total: job.total } : null);
    };
    const unsub = subscribeLevels(sync);
    sync();
    prepareLevels(record.id, lines, true)
      .then(res => {
        if (!live) return;
        setLabels(res);
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
  }, [hasAi, record.id, lines, tries]);

  const effectiveCfg = useMemo(
    () => (hasAi && labels ? cfg : { ...cfg, level: null }),
    [cfg, hasAi, labels],
  );
  const pick = useMemo(
    // The phone only drills the picked lines (others never play), so they don't eat the set's minutes.
    () => pickCustom(lines, hasAi ? labels : null, { ...effectiveCfg, others: 'skip' }, fromSec, 'dictation'),
    [lines, hasAi, labels, effectiveCfg, fromSec],
  );
  const practise = pick?.practise ?? [];
  const safePos = practise.length > 0 ? Math.min(pos, practise.length - 1) : 0;
  const activeLineIdx = practise[safePos] ?? -1;
  const line: Subtitle | undefined = activeLineIdx >= 0 ? lines[activeLineIdx] : undefined;

  const tokens = useMemo(
    () => (line ? tokenizeDictation(line.text, lang) : []),
    [line, lang, jaVersion], // eslint-disable-line react-hooks/exhaustive-deps
  );

  useEffect(() => {
    clearAuto();
    stuckLineRef.current = false;
    setTyped('');
    setHinted(new Set());
    setResult(null);
    setRevealed(false);
    setEverRevealed(false);
    setWrongTries(0);
    setShowBreakdown(false);
    if (!line || setDone) return;
    onPos(line.startTime);
    setCustomPos(record.id, line.startTime);
    onLine?.(activeLineIdx + 1, lines.length);
    player.playLine(activeLineIdx, pad);
    listRef.current
      ?.querySelector(`[data-custom-row="${activeLineIdx}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeLineIdx, setDone]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (typed || result || pos > 0 || hinted.size > 0 || revealed) markBusy();
  }, [typed, result, pos, hinted, revealed, markBusy]);

  const countOnce = useCallback(() => {
    if (!line || countedLinesRef.current.has(line.id)) return;
    countedLinesRef.current.add(line.id);
    countLine();
  }, [line]);

  const updateCfg = (patch: Partial<CustomConfig>) => {
    const next = { ...cfg, on: true, ...patch };
    setCfg(next);
    saveCustomConfig(next);
    newRound();
    setPos(0);
    setSetDone(false);
    setStuckLines(new Set());
  };

  const advance = useCallback(() => {
    clearAuto();
    if (safePos + 1 < practise.length) {
      setPos(safePos + 1);
    } else {
      player.pause();
      if (line) setCustomPos(record.id, line.endTime);
      setSetDone(true);
    }
  }, [clearAuto, line, player, practise.length, record.id, safePos]);

  const recordStuck = useCallback((reason: 'wrong' | 'peek') => {
    if (!line || stuckLineRef.current) return;
    stuckLineRef.current = true;
    setStuckLines(prev => new Set(prev).add(line.id));
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

  const handleSubmit = useCallback(() => {
    if (!line || !typed.trim()) return;
    countOnce();
    const checked = checkDictation(line.text, typed, lenient, lang);
    setResult(checked);
    setRevealed(false);
    if (checked.correct) {
      setDoneLines(prev => new Set(prev).add(activeLineIdx));
      clearAuto();
      autoTimer.current = window.setTimeout(() => {
        autoTimer.current = null;
        advance();
      }, AUTO_NEXT_MS);
    } else {
      setWrongTries(n => n + 1);
      recordStuck('wrong');
    }
  }, [activeLineIdx, advance, clearAuto, countOnce, lang, lenient, line, recordStuck, typed]);

  const handleHint = useCallback(() => {
    if (!line || revealed || result?.correct) return;
    const nextIdx = nextHintIndex(line.text, typed, hinted, lenient, lang);
    if (nextIdx < 0) return;
    recordStuck('peek');
    setHinted(prev => {
      const next = new Set(prev);
      next.add(nextIdx);
      return next;
    });
  }, [hinted, lang, lenient, line, recordStuck, result?.correct, revealed, typed]);

  const handleReveal = useCallback(() => {
    if (!line || revealed) return;
    clearAuto();
    countOnce();
    setRevealed(true);
    setEverRevealed(true);
    setResult(null);
    recordStuck('peek');
  }, [clearAuto, countOnce, line, recordStuck, revealed]);

  const selectRow = (rowPos: number, lineIdx: number) => {
    if (rowPos === safePos) {
      player.playLine(lineIdx, pad);
      return;
    }
    setSetDone(false);
    setPos(rowPos);
  };

  const handleWordTap = (word: string) => {
    if (!line) return;
    player.pause();
    void lookup(word, line, aroundOf(lines, activeLineIdx));
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

  const audioErr = player.errorCode
    ? (player.errorCode === 'listen.failed' ? t('listen.failed') : errText(player.errorCode))
    : '';
  const isSaved = !!line && savedIds.has(line.id);
  const canHint = !!line && !revealed && !result?.correct && nextHintIndex(line.text, typed, hinted, lenient, lang) >= 0;
  const answered = revealed || result !== null;

  return (
    <div
      className="flex-1 min-h-0 flex flex-col bg-paper"
      style={kbInset > 0 ? { paddingBottom: kbInset } : undefined}
    >
      <PlayerAudio player={player} />

      <div className="shrink-0 px-4 pt-2 pb-1">
        <CustomControls
          cfg={cfg}
          hasAi={hasAi}
          pickedCount={practise.length}
          prepState={prepState}
          progress={progress}
          onUpdate={updateCfg}
          onRetry={() => setTries(n => n + 1)}
        />
      </div>

      <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto px-4 pt-1 pb-4 flex flex-col gap-2">
        {audioErr && <p role="alert" className="text-xs text-accent px-1">{audioErr}</p>}

        {setDone ? (
          <CustomDoneCard
            onNextSet={() => {
              newRound();
              setFromSec(getCustomPos(record.id));
              setPos(0);
              setSetDone(false);
              setStuckLines(new Set());
            }}
            onExit={onExit}
          />
        ) : practise.length === 0 ? (
          <p className="py-6 text-center text-sm text-mute">{t('m.customEmpty')}</p>
        ) : (
          <div className="flex flex-col gap-2" data-testid="custom-list">
            {practise.map((lineIdx, rowPos) => {
              const sub = lines[lineIdx];
              if (!sub) return null;
              const active = rowPos === safePos;
              const completed = doneLines.has(lineIdx);
              const lv = labels?.[lineIdx];

              if (!active) {
                return (
                  <CustomInactiveRow
                    key={sub.id}
                    lineIdx={lineIdx}
                    rowPos={rowPos}
                    text={sub.text}
                    completed={completed}
                    level={lv}
                    onSelect={() => selectRow(rowPos, lineIdx)}
                  />
                );
              }

              const hasLevel = !!lv && lv !== 'x';
              return (
                <div
                  key={sub.id}
                  data-custom-row={lineIdx}
                  data-active="true"
                  className={`relative rounded-2xl bg-page border-2 border-accent/40 shadow-card px-4 ${
                    hasLevel ? 'pt-5 pb-3.5' : 'py-3.5'
                  } flex flex-col gap-2.5`}
                >
                  {hasLevel && (
                    <span className="absolute top-2 right-3 px-1.5 py-0.5 rounded-full bg-accent-soft text-[10px] text-accent font-medium pointer-events-none">
                      {lv}
                    </span>
                  )}

                  <GradedLine
                    tokens={tokens}
                    hinted={hinted}
                    result={result}
                    revealed={revealed}
                    onWord={handleWordTap}
                    compact
                  />

                  <DictStatusBar
                    result={result}
                    revealed={revealed}
                    everRevealed={everRevealed}
                    usedHint={hinted.size > 0}
                    wrongTries={wrongTries}
                    alreadyStuck={stuckLines.has(sub.id)}
                    trans={trans?.[lineIdx] ?? null}
                    isSaved={isSaved}
                    onBreakdown={() => { player.pause(); setShowBreakdown(true); }}
                    onToggleSave={() => toggleSave(sub)}
                    compact
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {!setDone && line && (
        <DictDock
          value={typed}
          onChange={v => { setTyped(v); if (result && !result.correct) setResult(null); }}
          onSubmit={handleSubmit}
          onReplay={() => player.playLine(activeLineIdx, pad)}
          rate={player.rate}
          onToggleSlow={() => player.setRate(player.rate < 0.99 ? 1 : 0.75)}
          onHint={handleHint}
          hintDisabled={!canHint}
          onReveal={handleReveal}
          revealDisabled={revealed || !!result?.correct}
          onPrev={() => { clearAuto(); if (safePos > 0) setPos(safePos - 1); }}
          prevDisabled={safePos <= 0}
          onNext={advance}
          nextHighlight={answered}
          submitDisabled={!!result?.correct}
          keyboardOpen={kbInset > 0}
          inputRef={inputRef}
        />
      )}

      {showBreakdown && line && (
        <BreakdownSheet
          record={record}
          line={line}
          around={aroundOf(lines, activeLineIdx)}
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
