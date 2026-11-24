// One subtitle row in the phone's "Read first" (先读字幕) page (M2.3).
// - Serif original line with tap-word lookup + long-press drag phrase selection (usePhrasePick)
// - Looked-up word dotted underline + episode phrase marks (hot red / passive underline) + Japanese furigana
// - Translation row below (shows when ready, never blocks reading; retry tap on failure)
// - Tap line number / whitespace to play this line; active line highlights in bg-accent-soft
//   with compact ☆ save & "Break down" (拆开教我) actions.
import React, { useMemo } from 'react';
import type { Subtitle } from '../../types';
import { useT } from '../../utils/i18n';
import { lookedKey } from '../../utils/readLooked';
import { sentenceParts } from '../../utils/textTokenizer';
import { sliceTextByMarks, type PickToken, type TextMark } from './phrasePick';
import { PickHandleDot, usePhrasePick } from './usePhrasePick';

export const ReadLine: React.FC<{
  line: Subtitle;
  index: number;
  ja: boolean;
  jaVersion: number;
  kana: boolean;
  looked: Set<string>;
  active: boolean;
  playing: boolean;
  saved: boolean;
  showTrans: boolean;
  transText: string | null;
  transFailed: boolean;
  marks?: TextMark[];
  onPlay: (index: number) => void;
  onWord: (word: string, line: Subtitle) => void;
  onPhrase: (phrase: string, line: Subtitle) => void;
  onSave: (line: Subtitle) => void;
  onBreakdown: (line: Subtitle) => void;
  onRetryTrans?: () => void;
}> = React.memo(({
  line,
  index,
  ja,
  jaVersion,
  kana,
  looked,
  active,
  playing,
  saved,
  showTrans,
  transText,
  transFailed,
  marks,
  onPlay,
  onWord,
  onPhrase,
  onSave,
  onBreakdown,
  onRetryTrans,
}) => {
  const t = useT();

  const groups = useMemo(() => {
    let at = 0;
    return sentenceParts(line.text).map(g => {
      const from = at;
      const text = g.pieces.map(p => p.s).join('');
      at += text.length;
      return { ...g, text, key: g.word ? lookedKey(g.word, ja) : null, from, to: at };
    });
  }, [line.text, ja, jaVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickTokens: PickToken[] = useMemo(
    () => groups.map(g => ({ text: g.text, isWord: !!g.word })),
    [groups],
  );

  const pick = usePhrasePick({
    tokens: pickTokens,
    onWord: w => onWord(w, line),
    onPhrase: phrase => onPhrase(phrase, line),
  });

  const renderPieces = (g: (typeof groups)[number]) => {
    let at = g.from;
    return g.pieces.map((p, pi) => {
      const pFrom = at;
      at += p.s.length;
      if (p.rt && kana) {
        const hit = marks?.filter(m => m.from < at && m.to > pFrom) ?? [];
        const cls = hit.some(m => m.hot)
          ? 'text-accent font-semibold'
          : hit.length > 0
            ? 'underline decoration-2 underline-offset-4 decoration-ink'
            : '';
        return <ruby key={pi} className={cls}>{p.s}<rt>{p.rt}</rt></ruby>;
      }
      const segs = sliceTextByMarks(p.s, pFrom, marks);
      return segs.map((seg, si) => {
        const cls = seg.hot
          ? 'text-accent font-semibold'
          : seg.marked
            ? 'underline decoration-2 underline-offset-4 decoration-ink'
            : '';
        return cls
          ? <span key={`${pi}.${si}`} className={cls}>{seg.text}</span>
          : <React.Fragment key={`${pi}.${si}`}>{seg.text}</React.Fragment>;
      });
    });
  };

  const hot = !!marks?.some(m => m.hot);
  const highlighted = active || hot;

  const onRowClick = () => {
    if (pick.selecting) return;
    onPlay(index);
  };

  return (
    <div
      data-line={line.id}
      data-line-index={index}
      data-active={highlighted || undefined}
      onClick={onRowClick}
      className={`rounded-2xl px-2.5 py-2.5 transition-colors ${
        highlighted ? 'bg-accent-soft/80' : 'bg-transparent'
      }`}
    >
      <div className="flex items-start gap-1">
        <button
          type="button"
          onClick={e => { e.stopPropagation(); onPlay(index); }}
          aria-label={t('listen.playFrom')}
          className={`shrink-0 w-11 h-11 -ml-1 rounded-xl flex items-center justify-center text-xs tabular-nums ${
            active && playing
              ? 'text-accent font-semibold'
              : active
                ? 'text-accent'
                : 'text-mute'
          }`}
        >
          {active && playing ? '▶' : index + 1}
        </button>

        <div className="flex-1 min-w-0 pt-1.5 flex flex-col gap-1.5">
          <p
            {...pick.containerProps}
            data-lookup-line
            className={`font-serif text-[20px] leading-[1.75] break-words select-none ${
              highlighted ? 'text-ink' : 'text-ink/90'
            }`}
          >
            {groups.map((g, gi) => {
              const pieces = renderPieces(g);
              const selected = pick.inRange(gi);
              if (!g.word) {
                return (
                  <span key={gi} className={selected ? 'bg-accent/20 text-ink' : undefined}>
                    {pieces}
                  </span>
                );
              }
              const seen = !!g.key && looked.has(g.key);
              const startEdge = pick.isStart(gi);
              const endEdge = pick.isEnd(gi);
              return (
                <button
                  key={gi}
                  type="button"
                  {...pick.bindWord(gi, g.word)}
                  className={`relative inline rounded px-0.5 -mx-0.5 align-baseline active:bg-accent-soft ${
                    selected ? 'bg-accent/20 text-ink' : ''
                  } ${seen && !selected ? 'border-b border-dotted border-accent/70' : ''}`}
                >
                  {startEdge && <PickHandleDot side="start" bind={pick.bindHandle('start')} />}
                  {pieces}
                  {endEdge && <PickHandleDot side="end" bind={pick.bindHandle('end')} />}
                </button>
              );
            })}
          </p>

          {pick.selecting && (
            <p className="text-xs text-accent" role="status">{t('m.phraseHint')}</p>
          )}

          {showTrans && transText && (
            <p className="text-[14px] leading-relaxed text-mute">{transText}</p>
          )}
          {showTrans && !transText && transFailed && onRetryTrans && (
            <button
              type="button"
              onClick={e => { e.stopPropagation(); onRetryTrans(); }}
              className="self-start min-h-[36px] text-xs text-accent underline underline-offset-2"
            >
              {t('m.readTransFail')} · {t('m.readTransRetry')}
            </button>
          )}

          {active && (
            <div className="pt-1 flex items-center gap-2 flex-wrap">
              <button
                type="button"
                aria-pressed={saved}
                onClick={e => { e.stopPropagation(); onSave(line); }}
                className={`min-h-[44px] px-3 rounded-[10px] text-xs font-medium ${
                  saved ? 'bg-page text-accent shadow-card' : 'bg-page/80 text-mute shadow-card'
                }`}
              >
                {saved ? t('m.saved') : t('m.save')}
              </button>
              <button
                type="button"
                onClick={e => { e.stopPropagation(); onBreakdown(line); }}
                className="min-h-[44px] px-3 rounded-[10px] bg-page/80 text-xs font-medium text-ink shadow-card"
              >
                {t('m.breakdownBtn')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
