// Touch dictation way (docs/android-roadmap.md M2.2).
// Renders sentence blanks / word-by-word graded feedback (right / near dashed / wrong)
// in a scrollable body above a keyboard-safe fixed 4-button + input dock.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Subtitle } from '../../types';
import { useSavedLines } from '../../hooks/useSavedLines';
import { detectLang } from '../../utils/dictionary';
import { useT } from '../../utils/i18n';
import { loadJa, useJaVersion } from '../../utils/japanese';
import { settleSplits } from '../../utils/jaSegments';
import { addLine, clearMastered } from '../../utils/review';
import { getLooseJudge, getPracticeConfig } from '../../utils/storage';
import { getWordTokens, tokenizeText } from '../../utils/textTokenizer';
import { countLine } from '../../utils/today';
import { checkDictation, type Checked } from '../dictation';
import { errText } from '../ui';
import { useWordLookup } from '../useWordLookup';
import { WordSheet } from '../WordSheet';
import { BreakdownSheet } from './BreakdownSheet';
import { DictDock } from './DictDock';
import { GradedLine } from './GradedLine';
import {
  AUTO_NEXT_MS,
  aroundOf,
  nextHintIndex,
  padSecOf,
  sortedLines,
  startIndexForSec,
} from './drillCommon';
import type { WayProps } from './types';
import { useKeyboardInset } from './useKeyboardInset';
import { PlayerAudio, useLinePlayer } from './useLinePlayer';

export const DictationWay: React.FC<WayProps> = ({ record, startSec, onPos, onLine, onExit }) => {
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

  const [idx, setIdx] = useState(() => startIndexForSec(lines, startSec));
  const [done, setDone] = useState(false);
  const [typed, setTyped] = useState('');
  const [hinted, setHinted] = useState<Set<number>>(() => new Set());
  const [result, setResult] = useState<Checked | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [showBreakdown, setShowBreakdown] = useState(false);

  const autoTimer = useRef<number | null>(null);
  const countedRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const lenient = useMemo(getLooseJudge, []);
  const pad = useMemo(padSecOf, []);

  const clearAuto = useCallback(() => {
    if (autoTimer.current !== null) {
      window.clearTimeout(autoTimer.current);
      autoTimer.current = null;
    }
  }, []);

  useEffect(() => clearAuto, [clearAuto]);

  // Reset when switching record.
  useEffect(() => {
    clearAuto();
    setIdx(startIndexForSec(lines, startSec));
    setDone(false);
  }, [record.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const line: Subtitle | undefined = lines[idx];
  const tokens = useMemo(
    () => (line ? tokenizeText(line.text) : []),
    [line, jaVersion], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const wordCount = useMemo(() => getWordTokens(tokens).length, [tokens]);

  // Report position & line number and auto-play each line when entering it.
  useEffect(() => {
    clearAuto();
    countedRef.current = false;
    setTyped('');
    setHinted(new Set());
    setResult(null);
    setRevealed(false);
    setShowBreakdown(false);
    if (!line || done) return;
    onPos(line.startTime);
    onLine?.(idx + 1, lines.length);
    player.playLine(idx, pad);
  }, [idx, done, line?.id]); // eslint-disable-line react-hooks/exhaustive-deps

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
  }, [advance, clearAuto, lenient, line, recordStuck, typed]);

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
  const showActions = !!line && (revealed || (result !== null && !result.correct));
  const isSaved = !!line && savedIds.has(line.id);
  const canHint = !!line && !revealed && !result?.correct && nextHintIndex(line.text, typed, hinted, lenient) >= 0;

  return (
    <div
      className="flex-1 min-h-0 flex flex-col bg-paper"
      style={kbInset > 0 ? { paddingBottom: kbInset } : undefined}
    >
      <PlayerAudio player={player} />

      <div className="flex-1 min-h-0 overflow-y-auto px-4 pt-3 pb-4 flex flex-col gap-3">
        <p className="text-xs text-mute px-1">
          {t('m.dictPrompt', { n: wordCount })}
        </p>

        {audioErr && (
          <p role="alert" className="text-xs text-accent px-1">
            {audioErr}
          </p>
        )}

        <div className="bg-page rounded-2xl shadow-card px-4 py-5 flex flex-col gap-4">
          <GradedLine
            tokens={tokens}
            hinted={hinted}
            result={result}
            revealed={revealed}
            onWord={handleWordTap}
          />

          {result?.correct && (
            <p
              role="status"
              data-testid="dict-all-right"
              className="self-start px-3 py-1.5 rounded-full bg-shade text-ink text-[13px] font-medium"
            >
              {t('m.dictAllRightAuto')}
            </p>
          )}

          {result && !result.correct && (() => {
            const wrongWords = result.words.filter(w => w.verdict !== 'right').length || result.wrong;
            return (
              <p className="text-xs text-mute" role="status">
                {result.near > 0
                  ? t('m.dictNearSummary', { wrong: wrongWords, near: result.near })
                  : t('m.dictWrongSummary', { wrong: wrongWords })}
              </p>
            );
          })()}

          {showActions && line && (
            <div className="pt-1 border-t border-shade flex flex-wrap items-center gap-2" data-testid="dict-actions">
              <button
                type="button"
                onClick={() => { player.pause(); setShowBreakdown(true); }}
                className="min-h-[44px] px-3.5 rounded-xl bg-shade text-ink text-[14px] font-medium"
              >
                {t('studio.breakdown')}
              </button>
              <button
                type="button"
                aria-pressed={isSaved}
                onClick={() => toggleSave(line)}
                className={`min-h-[44px] px-3.5 rounded-xl text-[14px] font-medium ${
                  isSaved ? 'bg-accent-soft text-accent' : 'bg-shade text-ink'
                }`}
              >
                {isSaved ? t('m.saved') : t('m.dictSaveLine')}
              </button>
              <button
                type="button"
                onClick={advance}
                className="ml-auto min-h-[44px] px-4 rounded-xl bg-accent text-white text-[14px] font-semibold"
              >
                {t('m.nextLine')}
              </button>
            </div>
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
