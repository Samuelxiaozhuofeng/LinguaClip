// Touch blur practice way (docs/android-roadmap.md M2.2, docs/shortcuts.md).
// Words start covered; first tap reveals one word, second tap looks it up via WordSheet.
// Big "Show full line" button toggles reveal/cover (mirrors desktop Cmd+D), counting "missed"
// at most once per line. Bottom bar provides speed / prev / replay-pause / next.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Subtitle } from '../../types';
import { useSavedLines } from '../../hooks/useSavedLines';
import { detectLang } from '../../utils/dictionary';
import { useT } from '../../utils/i18n';
import { loadJa, useJaVersion } from '../../utils/japanese';
import { settleSplits } from '../../utils/jaSegments';
import { addLine, clearMastered } from '../../utils/review';
import { TokenType, tokenizeText } from '../../utils/textTokenizer';
import { countLine } from '../../utils/today';
import { autoAddOn } from '../autoAdd';
import { errText } from '../ui';
import { useWordLookup } from '../useWordLookup';
import { WordSheet } from '../WordSheet';
import { BreakdownSheet } from './BreakdownSheet';
import {
  aroundOf,
  padSecOf,
  sortedLines,
  startIndexForSec,
  stripLookupPunct,
} from './drillCommon';
import type { WayProps } from './types';
import { useCachedTrans } from './useCachedTrans';
import { PlayerAudio, useLinePlayer } from './useLinePlayer';

const SPEEDS = [1, 0.75, 1.25];

export const BlurWay: React.FC<WayProps> = ({ record, startSec, onPos, onLine, onExit }) => {
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

  const [idx, setIdx] = useState(() => startIndexForSec(lines, startSec));
  const [revealed, setRevealed] = useState<Set<number>>(() => new Set());
  const [picked, setPicked] = useState<number | null>(null);
  const [missedCount, setMissedCount] = useState(0);
  const [missedHere, setMissedHere] = useState(false);
  const [showBreakdown, setShowBreakdown] = useState(false);

  const missedLineRef = useRef(false);
  const countedLinesRef = useRef<Set<number>>(new Set());
  const pad = useMemo(padSecOf, []);

  useEffect(() => {
    countedLinesRef.current = new Set();
    setIdx(startIndexForSec(lines, startSec));
  }, [record.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const line: Subtitle | undefined = lines[idx];
  const tokens = useMemo(
    () => (line ? tokenizeText(line.text) : []),
    [line, jaVersion], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const wordCount = useMemo(
    () => tokens.filter(tk => tk.type === TokenType.WORD).length,
    [tokens],
  );

  // Reset reveal state and report position whenever the active line changes.
  useEffect(() => {
    setRevealed(new Set());
    setPicked(null);
    setMissedHere(false);
    setShowBreakdown(false);
    missedLineRef.current = false;
    if (!line) return;
    onPos(line.startTime);
    onLine?.(idx + 1, lines.length);
    player.playLine(idx, pad);
  }, [idx, line?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const countOnce = useCallback(() => {
    if (!line || countedLinesRef.current.has(line.id)) return;
    countedLinesRef.current.add(line.id);
    countLine();
  }, [line]);

  // Count "missed / revealed" at most once per line (matches desktop BlurLine countReveal).
  const countRevealOnce = useCallback(() => {
    if (missedLineRef.current || !line) return;
    missedLineRef.current = true;
    countOnce();
    setMissedHere(true);
    setMissedCount(c => c + 1);
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
        'blur',
      ).catch(console.error);
    }
  }, [countOnce, line, record.id, record.videoFileName, record.videoPath]);

  const handleWordClick = (wordIdx: number, raw: string) => {
    if (!line) return;
    if (!revealed.has(wordIdx)) {
      countRevealOnce();
      setRevealed(prev => new Set(prev).add(wordIdx));
      setPicked(wordIdx);
      return;
    }
    const clean = stripLookupPunct(raw);
    if (!clean) return;
    setPicked(wordIdx);
    player.pause();
    void lookup(clean, line, aroundOf(lines, idx));
  };

  const allShown = wordCount > 0 && revealed.size >= wordCount;

  const handleToggleAll = () => {
    setPicked(null);
    if (!allShown) {
      countRevealOnce();
      setRevealed(new Set(Array.from({ length: wordCount }, (_, k) => k)));
    } else {
      setRevealed(new Set());
    }
  };

  const goPrev = () => {
    if (idx > 0) setIdx(i => i - 1);
  };

  const goNext = () => {
    countOnce();
    if (idx + 1 < lines.length) setIdx(i => i + 1);
  };

  const cycleSpeed = () => {
    const pos = SPEEDS.indexOf(player.rate);
    const next = SPEEDS[(pos + 1) % SPEEDS.length];
    player.setRate(next);
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

  const audioErr = player.errorCode
    ? (player.errorCode === 'listen.failed' ? t('listen.failed') : errText(player.errorCode))
    : '';
  const isSaved = !!line && savedIds.has(line.id);
  let wi = 0;

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-paper" data-blur-missed={missedCount}>
      <PlayerAudio player={player} />

      <div className="flex-1 min-h-0 overflow-y-auto px-4 pt-3 pb-4 flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2 px-1">
          <p className="text-xs text-mute">{t('m.blurHint')}</p>
          {missedHere && (
            <span className="text-xs text-accent shrink-0" data-testid="blur-missed-badge">
              {t('m.blurRevealedMark')}
            </span>
          )}
        </div>

        {audioErr && (
          <p role="alert" className="text-xs text-accent px-1">
            {audioErr}
          </p>
        )}

        <div className="bg-page rounded-2xl shadow-card px-4 py-6 flex flex-col gap-5">
          <div className="font-serif text-[24px] leading-[1.7] flex flex-wrap items-baseline gap-y-2" data-testid="blur-line">
            {tokens.map(tk => {
              if (tk.type === TokenType.SPACE) {
                return <span key={tk.index} className="w-[0.3em] inline-block" aria-hidden />;
              }
              if (tk.type !== TokenType.WORD) {
                return <span key={tk.index} className="text-mute">{tk.value}</span>;
              }
              const wordIdx = wi++;
              const isOpen = revealed.has(wordIdx);
              const isPicked = picked === wordIdx;
              return (
                <button
                  key={tk.index}
                  type="button"
                  data-blur-word={wordIdx}
                  data-revealed={isOpen ? 'true' : 'false'}
                  aria-label={isOpen ? undefined : t('blur.hiddenWord')}
                  onClick={() => handleWordClick(wordIdx, tk.value)}
                  className={`min-h-[38px] px-1.5 rounded-lg ${
                    isOpen
                      ? (isPicked ? 'bg-accent-soft text-ink' : 'text-ink active:bg-accent-soft')
                      : 'bg-shade text-transparent select-none active:bg-line'
                  }`}
                >
                  {tk.value}
                </button>
              );
            })}
          </div>

          {allShown && trans?.[idx] && (
            <p
              data-testid="blur-trans"
              className="text-[14px] leading-relaxed text-mute border-t border-shade pt-3"
            >
              {trans[idx]}
            </p>
          )}

          <button
            type="button"
            aria-pressed={allShown}
            onClick={handleToggleAll}
            className={`w-full min-h-[48px] rounded-xl text-[15px] font-semibold ${
              allShown ? 'bg-shade text-ink' : 'bg-ink text-white'
            }`}
          >
            {allShown ? t('m.blurHideAll') : t('m.blurRevealAll')}
          </button>

          {line && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => { player.pause(); setShowBreakdown(true); }}
                className="flex-1 min-h-[44px] px-3 rounded-xl bg-shade text-ink text-[14px] font-medium"
              >
                {t('studio.breakdown')}
              </button>
              <button
                type="button"
                aria-pressed={isSaved}
                onClick={() => toggleSave(line)}
                className={`flex-1 min-h-[44px] px-3 rounded-xl text-[14px] font-medium ${
                  isSaved ? 'bg-accent-soft text-accent' : 'bg-shade text-ink'
                }`}
              >
                {isSaved ? t('m.saved') : t('m.dictSaveLine')}
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 bg-page border-t border-line px-5 pt-3 pb-[max(16px,env(safe-area-inset-bottom))] flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={cycleSpeed}
          aria-label={t('m.speed')}
          className={`min-w-[52px] min-h-[48px] px-2 rounded-xl text-[13px] font-medium tabular-nums ${
            player.rate !== 1 ? 'bg-accent-soft text-accent' : 'bg-shade text-ink'
          }`}
        >
          {player.rate === 1 ? '1.0' : player.rate}×
        </button>

        <button
          type="button"
          disabled={idx <= 0}
          onClick={goPrev}
          aria-label={t('m.prevLine')}
          className="min-h-[48px] px-4 rounded-xl bg-shade text-ink text-[14px] font-medium disabled:opacity-40"
        >
          {t('m.prevLine')}
        </button>

        <button
          type="button"
          onClick={() => (player.playing ? player.pause() : player.playLine(idx, pad))}
          aria-label={t(player.playing ? 'm.pause' : 'm.replayLine')}
          className="min-w-[84px] min-h-[52px] px-5 rounded-full bg-ink text-white text-[15px] font-semibold flex items-center justify-center gap-1"
        >
          <span aria-hidden>{player.playing ? '⏸' : '▶'}</span>
          <span>{player.playing ? t('m.pause') : t('m.dictReplay')}</span>
        </button>

        <button
          type="button"
          disabled={idx + 1 >= lines.length}
          onClick={goNext}
          aria-label={t('m.nextLine')}
          className="min-h-[48px] px-4 rounded-xl bg-accent text-white text-[14px] font-semibold disabled:opacity-40"
        >
          {t('m.nextLine')}
        </button>
      </div>

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
