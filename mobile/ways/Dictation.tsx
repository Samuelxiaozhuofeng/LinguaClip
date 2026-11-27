// Touch dictation way (docs/android.md「手机学习闭环」).
// Renders sentence blanks / graded feedback (right / near dashed / wrong / extra struck-through),
// optional cached translation, independent vs helped-correct feedback, per-section summary,
// and a keyboard-safe dock with Replay / 0.75x / Hint / Reveal + Prev / Skip / Next + auto-grow input.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Subtitle } from '../../types';
import { useSavedLines } from '../../hooks/useSavedLines';
import { detectLang } from '../../utils/dictionary';
import { useT } from '../../utils/i18n';
import { loadJa, useJaVersion } from '../../utils/japanese';
import { settleSplits } from '../../utils/jaSegments';
import { addLine, clearMastered } from '../../utils/review';
import { buildSections, sectionLengthOf } from '../../utils/sections';
import { getLooseJudge } from '../../utils/storage';
import { getWordTokens } from '../../utils/textTokenizer';
import { countLine } from '../../utils/today';
import { autoAddOn } from '../autoAdd';
import { checkDictation, tokenizeDictation, type Checked } from '../dictation';
import { errText } from '../ui';
import { useWordLookup } from '../useWordLookup';
import { WordSheet } from '../WordSheet';
import { BreakdownSheet } from './BreakdownSheet';
import { DictDock } from './DictDock';
import { DictSectionSummary } from './DictSectionSummary';
import { DictStatusBar } from './DictStatusBar';
import { GradedLine } from './GradedLine';
import {
  AUTO_NEXT_MS,
  aroundOf,
  clearSectionStats,
  getSectionStats,
  nextHintIndex,
  padSecOf,
  prevLineInSection,
  recordSectionIndependent,
  recordSectionStuck,
  sectionForLine,
  sectionRangesOf,
  sortedLines,
  startIndexForSec,
  type SectionStatsMap,
} from './drillCommon';
import type { WayProps } from './types';
import { useCachedTrans } from './useCachedTrans';
import { useKeyboardBackClose, useKeyboardInset } from './useKeyboardInset';
import { PlayerAudio, useLinePlayer } from './useLinePlayer';

export const DictationWay: React.FC<WayProps> = ({ record, startSec, onPos, onLine, onExit, onReview }) => {
  const t = useT();
  const lines = useMemo(() => sortedLines(record.subtitleText), [record.subtitleText]);
  const sections = useMemo(
    () => buildSections(lines, sectionLengthOf(record)),
    [lines, record.podcast?.feed], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const ranges = useMemo(() => sectionRangesOf(lines, sections), [lines, sections]);
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

  const [idx, setIdx] = useState(() => startIndexForSec(lines, startSec));
  const [roundKey, setRoundKey] = useState(0);
  const [sectionSummary, setSectionSummary] = useState<number | null>(null);
  const [statsBySec, setStatsBySec] = useState<SectionStatsMap>({});
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
  const lenient = useMemo(getLooseJudge, []);
  const pad = useMemo(padSecOf, []);

  const clearAuto = useCallback(() => {
    if (autoTimer.current !== null) {
      window.clearTimeout(autoTimer.current);
      autoTimer.current = null;
    }
  }, []);

  useEffect(() => clearAuto, [clearAuto]);

  useKeyboardBackClose(kbInset, showBreakdown || !!def);

  // Reset when switching record.
  useEffect(() => {
    clearAuto();
    countedLinesRef.current = new Set();
    setIdx(startIndexForSec(lines, startSec));
    setSectionSummary(null);
    setStatsBySec({});
  }, [record.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const line: Subtitle | undefined = lines[idx];
  const curRange = useMemo(() => sectionForLine(ranges, idx), [ranges, idx]);
  const curSecIdx = curRange?.index ?? 0;
  const tokens = useMemo(
    () => (line ? tokenizeDictation(line.text, lang) : []),
    [line, lang, jaVersion], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const wordCount = useMemo(() => getWordTokens(tokens).length, [tokens]);

  // Report position & line number and auto-play each line when entering it.
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
    if (!line || sectionSummary !== null) return;
    onPos(line.startTime);
    onLine?.(idx + 1, lines.length);
    player.playLine(idx, pad);
  }, [idx, sectionSummary, roundKey, line?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const countOnce = useCallback(() => {
    if (!line || countedLinesRef.current.has(line.id)) return;
    countedLinesRef.current.add(line.id);
    countLine();
  }, [line]);

  const advance = useCallback(() => {
    clearAuto();
    if (curRange && idx + 1 >= curRange.endIdx) {
      // Nothing answered in this section this time (e.g. resumed on its last line and skipped):
      // no empty 0 / 0 summary, just carry on into the next section.
      const s = getSectionStats(statsBySec, curRange.index);
      if (s.independent.size + s.stuck.size === 0 && idx + 1 < lines.length) {
        setIdx(i => i + 1);
        return;
      }
      player.pause();
      setSectionSummary(curRange.index);
      return;
    }
    if (idx + 1 < lines.length) {
      setIdx(i => i + 1);
    } else {
      player.pause();
      setSectionSummary(Math.max(0, ranges.length - 1));
    }
  }, [clearAuto, curRange, idx, lines.length, player, ranges.length, statsBySec]);

  const recordStuck = useCallback((reason: 'wrong' | 'peek') => {
    if (!line || stuckLineRef.current) return;
    stuckLineRef.current = true;
    setStatsBySec(prev => recordSectionStuck(prev, curSecIdx, line.id));
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
  }, [curSecIdx, line, record.id, record.videoFileName, record.videoPath]);

  const handleSubmit = useCallback(() => {
    if (!line || !typed.trim()) return;
    countOnce();
    const checked = checkDictation(line.text, typed, lenient, lang);
    setResult(checked);
    setRevealed(false);
    if (checked.correct) {
      if (!everRevealed && hinted.size === 0 && !stuckLineRef.current) {
        setStatsBySec(prev => recordSectionIndependent(prev, curSecIdx, line.id));
      }
      clearAuto();
      autoTimer.current = window.setTimeout(() => {
        autoTimer.current = null;
        advance();
      }, AUTO_NEXT_MS);
    } else {
      setWrongTries(n => n + 1);
      recordStuck('wrong');
    }
  }, [advance, clearAuto, countOnce, curSecIdx, everRevealed, hinted.size, lang, lenient, line, recordStuck, typed]);

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

  const prevIdx = prevLineInSection(idx, curRange);
  const handlePrev = useCallback(() => {
    if (prevIdx === null) return;
    clearAuto();
    setIdx(prevIdx);
  }, [clearAuto, prevIdx]);

  const handleInputChange = (val: string) => {
    setTyped(val);
    if (result && !result.correct) setResult(null);
  };

  const handleReplay = () => {
    if (!line) return;
    player.playLine(idx, pad);
  };

  const handleToggleSlow = () => {
    player.setRate(player.rate < 0.99 ? 1 : 0.75);
  };

  const handleWordTap = (word: string) => {
    if (!line) return;
    player.pause();
    void lookup(word, line, aroundOf(lines, idx));
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
        <button
          type="button"
          onClick={onExit}
          className="min-h-[44px] px-6 rounded-xl bg-page shadow-card text-sm font-medium"
        >
          {t('m.toHome')}
        </button>
      </div>
    );
  }

  if (sectionSummary !== null) {
    const finished = ranges[sectionSummary] ?? ranges[0];
    const nextSec = ranges[sectionSummary + 1];
    const summaryStats = getSectionStats(statsBySec, sectionSummary);
    return (
      <>
        <PlayerAudio player={player} />
        <DictSectionSummary
          sectionNum={sectionSummary + 1}
          totalSections={ranges.length}
          independentCount={summaryStats.independent.size}
          stuckCount={summaryStats.stuck.size}
          autoAddEnabled={autoAddOn()}
          onReview={onReview}
          onRetrySection={() => {
            setStatsBySec(prev => clearSectionStats(prev, sectionSummary));
            setSectionSummary(null);
            setIdx(finished ? finished.startIdx : 0);
            setRoundKey(k => k + 1);
          }}
          onNextSection={nextSec ? () => {
            setSectionSummary(null);
            setIdx(nextSec.startIdx);
            setRoundKey(k => k + 1);
          } : undefined}
          onExit={onExit}
        />
      </>
    );
  }

  const audioErr = player.errorCode
    ? (player.errorCode === 'listen.failed' ? t('listen.failed') : errText(player.errorCode))
    : '';
  const isSaved = !!line && savedIds.has(line.id);
  const curSecStats = getSectionStats(statsBySec, curSecIdx);
  const canHint = !!line && !revealed && !result?.correct && nextHintIndex(line.text, typed, hinted, lenient, lang) >= 0;
  const answered = revealed || result !== null;

  return (
    <div
      className="flex-1 min-h-0 flex flex-col bg-paper"
      style={kbInset > 0 ? { paddingBottom: kbInset } : undefined}
    >
      <PlayerAudio player={player} />

      <div className="flex-1 min-h-0 overflow-y-auto px-4 pt-2 pb-3 flex flex-col gap-2" data-testid="dict-scroll">
        {audioErr && (
          <p role="alert" className="text-[13px] text-accent px-1">
            {audioErr}
          </p>
        )}

        <div className="relative bg-page rounded-2xl shadow-card px-4 pt-5 pb-3.5 flex flex-col gap-2.5">
          {wordCount > 0 && (
            <span className="absolute top-2 right-3.5 text-[11px] text-mute/75 tabular-nums pointer-events-none">
              {wordCount === 1 ? t('home.reviewWordOne') : t('home.reviewWord', { n: wordCount })}
            </span>
          )}

          <GradedLine
            tokens={tokens}
            hinted={hinted}
            result={result}
            revealed={revealed}
            onWord={handleWordTap}
          />

          {line && (
            <DictStatusBar
              result={result}
              revealed={revealed}
              everRevealed={everRevealed}
              usedHint={hinted.size > 0}
              wrongTries={wrongTries}
              alreadyStuck={curSecStats.stuck.has(line.id)}
              trans={trans?.[idx] ?? null}
              isSaved={isSaved}
              onBreakdown={() => { player.pause(); setShowBreakdown(true); }}
              onToggleSave={() => toggleSave(line)}
            />
          )}
        </div>
      </div>

      <DictDock
        value={typed}
        onChange={handleInputChange}
        onSubmit={handleSubmit}
        onReplay={handleReplay}
        rate={player.rate}
        onToggleSlow={handleToggleSlow}
        onHint={handleHint}
        hintDisabled={!canHint}
        onReveal={handleReveal}
        revealDisabled={revealed || !!result?.correct}
        onPrev={handlePrev}
        prevDisabled={prevIdx === null}
        onNext={advance}
        nextHighlight={answered}
        submitDisabled={!!result?.correct}
        keyboardOpen={kbInset > 0}
        inputRef={inputRef}
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
