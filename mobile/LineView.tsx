// Lines with their text up on the listening page (design Lookup.dc.html): words to tap
// for their meaning (Japanese split into groups once the dictionary is in), long-press drag
// to select & look up a phrase (usePhrasePick, M2.3), "see this line" — the line in a card
// between its neighbours, with listen again / ☆ / 中 — and the whole section's transcript.
import React, { useMemo, useRef } from 'react';
import type { Subtitle } from '../types';
import { TokenType, tokenizeText } from '../utils/textTokenizer';
import { useJaVersion } from '../utils/japanese';
import { useT } from '../utils/i18n';
import type { PickToken } from './reader/phrasePick';
import { PickHandleDot, TAP_CANCEL_MS, usePhrasePick } from './reader/usePhrasePick';
import { useJustShown } from './justShown';

export type LineProps = {
  saved: Set<number>; trans: (l: Subtitle) => string | null | undefined; // undefined: closed
  onWord: (w: string, l: Subtitle) => void; onSave: (l: Subtitle) => void; onTrans?: (l: Subtitle) => void;
};

export const Words: React.FC<{
  line: Subtitle;
  onWord: (w: string, l: Subtitle) => void;
  className?: string;
  prefix?: React.ReactNode;
  onSelectingChange?: (selecting: boolean, byTap?: boolean) => void;
}> = ({ line, onWord, className, prefix, onSelectingChange }) => {
  const t = useT();
  const v = useJaVersion();
  const tokens = useMemo(() => tokenizeText(line.text), [line.text, v]); // eslint-disable-line react-hooks/exhaustive-deps
  const pickTokens: PickToken[] = useMemo(
    () => tokens.map(x => ({ text: x.value, isWord: x.type === TokenType.WORD })),
    [tokens],
  );
  const pick = usePhrasePick({
    tokens: pickTokens,
    onWord: w => onWord(w, line),
    onPhrase: phrase => onWord(phrase, line),
    onSelectingChange,
  });

  return (
    <div>
      <p
        {...pick.containerProps}
        className={`${className ?? ''} select-none`.trim()}
        data-split={tokens.filter(x => x.type === TokenType.WORD).length}
      >
        {prefix}
        {tokens.map((x, idx) => {
          const selected = pick.inRange(idx);
          if (x.type !== TokenType.WORD) {
            return (
              <span key={x.index} className={selected ? 'bg-accent/20 text-ink' : undefined}>
                {x.value}
              </span>
            );
          }
          const startEdge = pick.isStart(idx);
          const endEdge = pick.isEnd(idx);
          return (
            <button
              key={x.index}
              type="button"
              {...pick.bindWord(idx, x.value)}
              className={`relative inline rounded active:bg-accent-soft ${
                selected ? 'bg-accent/20 text-ink' : ''
              }`}
            >
              {startEdge && <PickHandleDot side="start" bind={pick.bindHandle('start')} />}
              {x.value}
              {endEdge && <PickHandleDot side="end" bind={pick.bindHandle('end')} />}
            </button>
          );
        })}
      </p>
      {pick.selecting && <p className="mt-1 text-xs text-accent" role="status">{t('m.phraseHint')}</p>}
    </div>
  );
};

const TransText: React.FC<{ text: string | null }> = ({ text }) => {
  const t = useT();
  return <p className="text-sm text-mute leading-relaxed">{text ?? t('m.transWait')}</p>;
};

const soft = 'min-h-[44px] px-3.5 rounded-[10px] bg-shade text-sm';

// "See this line": the line before and after faded, the line itself to read and tap.
export const LineCard: React.FC<LineProps & { lines: Subtitle[]; at: number; onAgain: () => void }> = ({ lines, at, saved, trans, onWord, onSave, onTrans, onAgain }) => {
  const t = useT();
  const line = lines[at];
  if (!line) return null;
  const tr = trans(line);
  return (
    <div className="px-5 py-3 flex flex-col gap-3.5">
      {lines[at - 1] && <p className="font-serif text-[17px] leading-normal text-faint">{lines[at - 1].text}</p>}
      <div className="bg-page rounded-2xl shadow-card px-4 py-[18px] flex flex-col gap-3">
        <Words line={line} onWord={onWord} className="font-serif text-[22px] leading-normal" />
        {tr !== undefined && <TransText text={tr} />}
        <div className="flex gap-2 flex-wrap">
          <button className={soft} onClick={onAgain}>{t('m.again')}</button>
          <button className={soft} aria-pressed={saved.has(line.id)} onClick={() => onSave(line)}>{saved.has(line.id) ? t('m.saved') : t('m.save')}</button>
          {onTrans && <button className={soft} aria-pressed={tr !== undefined} onClick={() => onTrans(line)}>{t('reader.transShort')}</button>}
        </div>
      </div>
      {lines[at + 1] && <p className="font-serif text-[17px] leading-normal text-faint">{lines[at + 1].text}</p>}
    </div>
  );
};

const TranscriptRow: React.FC<{
  line: Subtitle;
  index: number;
  isCur: boolean;
  isSaved: boolean;
  tr: string | null | undefined;
  onWord: (w: string, l: Subtitle) => void;
  onSave: (l: Subtitle) => void;
  onTrans?: (l: Subtitle) => void;
  onPlay: (l: Subtitle) => void;
}> = ({ line, index, isCur, isSaved, tr, onWord, onSave, onTrans, onPlay }) => {
  const t = useT();
  const selectingRef = useRef(false);
  const suppressRowClickRef = useRef(false);
  const tapCancelAtRef = useRef(0);
  // The save / translation row follows the playing line: ignore a tap that lands just as it moved.
  const actionsTooSoon = useJustShown(isCur);

  const prefix = (
    <span
      aria-hidden="true"
      className={`inline-flex items-center gap-0.5 mr-1.5 font-sans text-[11px] tabular-nums align-[1px] select-none ${
        isCur ? 'text-accent font-semibold' : 'text-mute/75'
      }`}
    >
      <span>{isCur ? '▶' : index + 1}</span>
      {isSaved && <span className="text-accent leading-none">★</span>}
    </span>
  );

  return (
    <div
      data-line={line.id}
      onPointerDownCapture={() => { suppressRowClickRef.current = selectingRef.current; }}
      onClick={() => {
        if (suppressRowClickRef.current || selectingRef.current || performance.now() - tapCancelAtRef.current < TAP_CANCEL_MS) {
          suppressRowClickRef.current = false;
          return;
        }
        onPlay(line);
      }}
      className={`px-2.5 py-2 border-b border-shade transition-colors ${
        isCur ? 'bg-accent-soft/60 rounded-xl border-b-transparent' : ''
      }`}
    >
      <Words
        line={line}
        onWord={onWord}
        prefix={prefix}
        onSelectingChange={(s, byTap) => { selectingRef.current = s; if (byTap) tapCancelAtRef.current = performance.now(); }}
        className={`font-serif text-[18px] leading-normal ${isCur ? 'text-ink' : 'text-ink/85'}`}
      />
      {tr !== undefined && <div className="mt-1"><TransText text={tr} /></div>}
      {isCur && (
        <div className="mt-1.5 flex items-center gap-2">
          <button
            type="button"
            aria-pressed={isSaved}
            onClick={e => { e.stopPropagation(); if (!actionsTooSoon()) onSave(line); }}
            className={`relative h-9 px-2.5 rounded-[10px] text-xs font-medium inline-flex items-center before:content-[''] before:absolute before:-inset-y-1 before:-inset-x-0.5 ${
              isSaved ? 'bg-page text-accent shadow-card' : 'bg-page/80 text-mute shadow-card'
            }`}
          >
            {isSaved ? t('m.saved') : t('m.save')}
          </button>
          {onTrans && (
            <button
              type="button"
              aria-label={t('reader.transShow')}
              aria-pressed={tr !== undefined}
              onClick={e => { e.stopPropagation(); if (!actionsTooSoon()) onTrans(line); }}
              className={`relative h-9 min-w-[40px] px-2.5 rounded-[10px] text-xs font-medium inline-flex items-center justify-center before:content-[''] before:absolute before:-inset-y-1 before:-inset-x-0.5 ${
                tr !== undefined ? 'bg-page text-accent shadow-card' : 'bg-page/80 text-mute shadow-card'
              }`}
            >
              {t('reader.transShort')}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

// The section's lines; tapping a line plays from it, words tap to look up, active line shows ☆ / 中 below.
export const Transcript = React.forwardRef<HTMLDivElement, LineProps & { lines: Subtitle[]; cur: number | null; onPlay: (l: Subtitle) => void; onScroll: () => void }>(
  ({ lines, cur, saved, trans, onWord, onSave, onTrans, onPlay, onScroll }, ref) => (
    <div ref={ref} className="h-full overflow-y-auto px-3 pb-6" onTouchMove={onScroll}>
      {lines.map((l, idx) => (
        <TranscriptRow
          key={l.id}
          line={l}
          index={idx}
          isCur={l.id === cur}
          isSaved={saved.has(l.id)}
          tr={trans(l)}
          onWord={onWord}
          onSave={onSave}
          onTrans={onTrans}
          onPlay={onPlay}
        />
      ))}
    </div>
  ),
);
