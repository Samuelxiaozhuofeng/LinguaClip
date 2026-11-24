// Touch AI Custom way (docs/android-roadmap.md M2.2).
// Reuses desktop selection logic (utils/customPick.ts + utils/levelPrep.ts + practice_config.custom).
// Single-column list of picked lines: active line highlighted, tapping any line selects & plays it,
// bottom reuses DictDock for sentence-by-sentence dictation with near-miss feedback & keyboard avoidance.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Subtitle } from '../../types';
import { useSavedLines } from '../../hooks/useSavedLines';
import { canCloze } from '../../utils/aiDrills';
import { pickCustom, type CustomConfig } from '../../utils/customPick';
import { useRoundLabels } from './useRoundLabels';
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
  getPracticeConfig,
  saveCustomConfig,
  setCustomPos,
} from '../../utils/storage';
import { tokenizeText } from '../../utils/textTokenizer';
import { countLine } from '../../utils/today';
import { checkDictation, type Checked } from '../dictation';
import { errText } from '../ui';
import { useWordLookup } from '../useWordLookup';
import { WordSheet } from '../WordSheet';
import { BreakdownSheet } from './BreakdownSheet';
import { CustomControls } from './CustomControls';
import { DictDock } from './DictDock';
import { GradedLine } from './GradedLine';
import {
  AUTO_NEXT_MS,
  aroundOf,
  nextHintIndex,
  padSecOf,
  sortedLines,
  wordCountOf,
} from './drillCommon';
import type { WayProps } from './types';
import { useKeyboardInset } from './useKeyboardInset';
import { PlayerAudio, useLinePlayer } from './useLinePlayer';

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
  const [typed, setTyped] = useState('');
  const [hinted, setHinted] = useState<Set<number>>(() => new Set());
  const [result, setResult] = useState<Checked | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [showBreakdown, setShowBreakdown] = useState(false);

  const autoTimer = useRef<number | null>(null);
  const countedRef = useRef(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  const clearAuto = useCallback(() => {
    if (autoTimer.current !== null) {
      window.clearTimeout(autoTimer.current);
      autoTimer.current = null;
    }
  }, []);
  useEffect(() => clearAuto, [clearAuto]);

  useEffect(() => {
    clearAuto();
    resetLabels();
    setFromSec(startSec > 0 ? startSec : getCustomPos(record.id));
    setPos(0);
    setSetDone(false);
    setDoneLines(new Set());
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
    () => (line ? tokenizeText(line.text) : []),
    [line, jaVersion], // eslint-disable-line react-hooks/exhaustive-deps
  );

  useEffect(() => {
    clearAuto();
    countedRef.current = false;
    setTyped('');
    setHinted(new Set());
    setResult(null);
    setRevealed(false);
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

  useEffect(() => { if (typed || result || pos > 0 || hinted.size > 0 || revealed) markBusy(); }, [typed, result, pos, hinted, revealed, markBusy]);

  const updateCfg = (patch: Partial<CustomConfig>) => {
    const next = { ...cfg, on: true, ...patch };
    setCfg(next);
    saveCustomConfig(next);
    newRound();
    setPos(0);
    setSetDone(false);
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
    if (!line) return;
    clearMastered(record.id, line.startTime).catch(() => {});
    if (getPracticeConfig().autoAddReview) {
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
    const checked = checkDictation(line.text, typed, lenient);
    setResult(checked);
    setRevealed(false);
    if (checked.correct) {
      setDoneLines(prev => new Set(prev).add(activeLineIdx));
      if (!countedRef.current) {
        countedRef.current = true;
        countLine();
      }
      clearAuto();
      autoTimer.current = window.setTimeout(() => {
        autoTimer.current = null;
        advance();
      }, AUTO_NEXT_MS);
    } else {
      recordStuck('wrong');
    }
  }, [activeLineIdx, advance, clearAuto, lenient, line, recordStuck, typed]);

  const handleHint = useCallback(() => {
    if (!line || revealed || result?.correct) return;
    const nextIdx = nextHintIndex(line.text, typed, hinted, lenient);
    if (nextIdx < 0) return;
    setHinted(prev => {
      const next = new Set(prev);
      next.add(nextIdx);
      return next;
    });
  }, [hinted, lenient, line, result?.correct, revealed, typed]);

  const handleReveal = useCallback(() => {
    if (!line || revealed) return;
    clearAuto();
    setRevealed(true);
    setResult(null);
    recordStuck('peek');
  }, [clearAuto, line, recordStuck, revealed]);

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
  const showActions = !!line && (revealed || (result !== null && !result.correct));
  const isSaved = !!line && savedIds.has(line.id);
  const canHint = !!line && !revealed && !result?.correct && nextHintIndex(line.text, typed, hinted, lenient) >= 0;

  return (
    <div
      className="flex-1 min-h-0 flex flex-col bg-paper"
      style={kbInset > 0 ? { paddingBottom: kbInset } : undefined}
    >
      <PlayerAudio player={player} />

      <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto px-4 pt-2 pb-4 flex flex-col gap-2.5">
        <CustomControls
          cfg={cfg}
          hasAi={hasAi}
          prepState={prepState}
          progress={progress}
          onUpdate={updateCfg}
          onRetry={() => setTries(n => n + 1)}
        />

        {audioErr && <p role="alert" className="text-xs text-accent px-1">{audioErr}</p>}

        {setDone ? (
          <div className="bg-page rounded-2xl shadow-card px-4 py-6 flex flex-col items-center gap-3 text-center">
            <h2 className="text-lg font-semibold text-ink">{t('m.customDone')}</h2>
            <div className="flex gap-2.5">
              <button
                type="button"
                onClick={() => {
                  newRound();
                  setFromSec(getCustomPos(record.id));
                  setPos(0);
                  setSetDone(false);
                }}
                className="min-h-[44px] px-4 rounded-xl bg-accent text-white text-sm font-semibold"
              >
                {t('m.customNextSet')}
              </button>
              <button
                type="button"
                onClick={onExit}
                className="min-h-[44px] px-4 rounded-xl bg-shade text-ink text-sm font-medium"
              >
                {t('m.toHome')}
              </button>
            </div>
          </div>
        ) : practise.length === 0 ? (
          <p className="py-6 text-center text-sm text-mute">{t('m.customEmpty')}</p>
        ) : (
          <>
            <p className="text-xs text-mute px-1">{t('m.customCount', { n: practise.length })}</p>
            <div className="flex flex-col gap-2" data-testid="custom-list">
              {practise.map((lineIdx, rowPos) => {
                const sub = lines[lineIdx];
                if (!sub) return null;
                const active = rowPos === safePos;
                const completed = doneLines.has(lineIdx);
                const lv = labels?.[lineIdx];

                if (!active) {
                  return (
                    <button
                      key={sub.id}
                      type="button"
                      data-custom-row={lineIdx}
                      onClick={() => selectRow(rowPos, lineIdx)}
                      className="w-full min-h-[52px] px-3.5 py-2.5 rounded-xl bg-page/80 shadow-card text-left flex items-center gap-2.5 active:bg-shade"
                    >
                      <span className={`w-6 text-xs text-center tabular-nums shrink-0 ${completed ? 'text-accent font-semibold' : 'text-mute'}`}>
                        {completed ? '✓' : rowPos + 1}
                      </span>
                      <span className={`flex-1 min-w-0 truncate text-[14px] ${completed ? 'font-serif text-ink/75' : 'text-mute'}`}>
                        {completed ? sub.text : t('m.customLineHidden', { n: lineIdx + 1, words: wordCountOf(sub.text) })}
                      </span>
                      {lv && lv !== 'x' && (
                        <span className="shrink-0 px-2 py-0.5 rounded-full bg-shade text-[11px] text-mute font-medium">
                          {lv}
                        </span>
                      )}
                    </button>
                  );
                }

                return (
                  <div
                    key={sub.id}
                    data-custom-row={lineIdx}
                    data-active="true"
                    className="rounded-2xl bg-page border-2 border-accent/40 shadow-card px-4 py-4 flex flex-col gap-3"
                  >
                    <button
                      type="button"
                      onClick={() => player.playLine(lineIdx, pad)}
                      className="w-full flex items-center justify-between gap-2 text-left"
                    >
                      <span className="text-xs font-medium text-accent">
                        ▶ {t('m.customLineHidden', { n: lineIdx + 1, words: wordCountOf(sub.text) })}
                      </span>
                      {lv && lv !== 'x' && (
                        <span className="px-2 py-0.5 rounded-full bg-accent-soft text-[11px] text-accent font-medium">
                          {lv}
                        </span>
                      )}
                    </button>

                    <GradedLine
                      tokens={tokens}
                      hinted={hinted}
                      result={result}
                      revealed={revealed}
                      onWord={handleWordTap}
                      compact
                    />

                    {result?.correct && (
                      <p role="status" className="self-start px-3 py-1 rounded-full bg-shade text-ink text-xs font-medium">
                        {t('m.dictAllRightAuto')}
                      </p>
                    )}

                    {showActions && (
                      <div className="pt-1 border-t border-shade flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => { player.pause(); setShowBreakdown(true); }}
                          className="min-h-[44px] px-3 rounded-xl bg-shade text-ink text-[13px] font-medium"
                        >
                          {t('studio.breakdown')}
                        </button>
                        <button
                          type="button"
                          aria-pressed={isSaved}
                          onClick={() => toggleSave(sub)}
                          className={`min-h-[44px] px-3 rounded-xl text-[13px] font-medium ${
                            isSaved ? 'bg-accent-soft text-accent' : 'bg-shade text-ink'
                          }`}
                        >
                          {isSaved ? t('m.saved') : t('m.dictSaveLine')}
                        </button>
                        <button
                          type="button"
                          onClick={advance}
                          className="ml-auto min-h-[44px] px-4 rounded-xl bg-accent text-white text-[13px] font-semibold"
                        >
                          {t('m.nextLine')}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
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
          submitDisabled={!!result?.correct}
          keyboardOpen={kbInset > 0}
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
