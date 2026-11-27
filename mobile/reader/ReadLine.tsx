// One subtitle row in the phone's "Read first" (先读字幕) page (M2.3).
// - Serif original line with tap-word lookup + long-press drag phrase selection (usePhrasePick)
// - Looked-up word dotted underline + episode phrase marks (hot red / passive underline) + Japanese furigana
// - Translation row below (shows when ready, never blocks reading; retry tap on failure)
// - Line number is a small inline tag before the text (no gutter column: the text gets the whole
//   width, docs/android.md「沉浸阅读」); tap anywhere off a word to play this line.
// - Active line highlights in bg-accent-soft with one compact row: ☆ save, and "Break down"
//   (拆开教我) only when AI is set up. Saved lines keep a small accent ★ by their number.
import React, { useMemo } from 'react';
import type { Subtitle } from '../../types';
import { useT } from '../../utils/i18n';
import { lookedKey } from '../../utils/readLooked';
import { sentenceParts } from '../../utils/textTokenizer';
import { sliceTextByMarks, type PickToken, type TextMark } from './phrasePick';
import { PickHandleDot, usePhrasePick } from './usePhrasePick';
import { useJustShown } from '../justShown';

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
  /** Undefined = no AI set up: the button is not shown. */
  onBreakdown?: (line: Subtitle) => void;
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
    if (pick.selecting || pick.tapCancelled()) return;
    onPlay(index);
  };

  // During continuous play the action row hops to the next line: ignore a tap that lands just after.
  const actionsTooSoon = useJustShown(active);
  const numCls = active && playing ? 'text-accent font-semibold' : active || saved ? 'text-accent/80' : 'text-mute/70';

  return (
    <div
      data-line={line.id}
      data-line-index={index}
      data-active={highlighted || undefined}
      data-saved={saved || undefined}
      onClick={onRowClick}
      className={`rounded-xl px-2 py-1.5 flex flex-col gap-1 transition-colors ${
        highlighted ? 'bg-accent-soft/80' : 'bg-transparent'
      }`}
    >
      <p
        {...pick.containerProps}
        data-lookup-line
        className={`font-serif text-[17px] break-words select-none ${kana ? 'leading-[2.1]' : 'leading-[1.75]'} ${
          highlighted ? 'text-ink' : 'text-ink/90'
        }`}
      >
        <button
          type="button"
          data-testid="read-line-num"
          aria-label={t('listen.playFrom')}
          onClick={e => { e.stopPropagation(); if (!pick.selecting && !pick.tapCancelled()) onPlay(index); }}
          className={`inline-block min-w-[1.7em] mr-1 font-sans text-[11px] tabular-nums align-[2px] ${numCls}`}
        >
          {active && playing ? '▶' : index + 1}
          {saved && <span aria-label={t('m.saved')} className="ml-px">★</span>}
        </button>
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
        <div className="flex items-center justify-end gap-1 -mb-1 -mr-1">
          <button
            type="button"
            aria-pressed={saved}
            data-testid="read-save"
            onClick={e => { e.stopPropagation(); if (!actionsTooSoon()) onSave(line); }}
            className={`min-h-[40px] px-3 rounded-lg text-xs font-medium ${saved ? 'text-accent' : 'text-mute'}`}
          >
            {saved ? t('m.saved') : t('m.save')}
          </button>
          {onBreakdown && (
            <button
              type="button"
              data-testid="read-breakdown"
              onClick={e => { e.stopPropagation(); if (!actionsTooSoon()) onBreakdown(line); }}
              className="min-h-[40px] px-3 rounded-lg text-xs font-medium text-ink"
            >
              {t('m.breakdownBtn')}
            </button>
          )}
        </div>
      )}
    </div>
  );
});
