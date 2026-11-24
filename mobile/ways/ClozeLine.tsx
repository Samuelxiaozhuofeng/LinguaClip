// Inline cloze sentence renderer for mobile/ways/Cloze.tsx.
// Renders non-blank words as tappable lookup buttons, blank words as inline <input>
// slots (autocorrect off, IME composition guarded), and graded feedback after submit.
import React from 'react';
import { useT } from '../../utils/i18n';
import {
  TokenType,
  judgeWord,
  letters,
  nearMarks,
  type Token,
} from '../../utils/textTokenizer';
import { slotWidthEm } from './drillCommon';

export interface ClozeLineProps {
  tokens: Token[];
  blanks: number[];
  blankSet: ReadonlySet<number>;
  inputs: Record<number, string>;
  leftBlanks: ReadonlySet<number>;
  submitted: boolean;
  lenient: boolean;
  inputRefs: React.MutableRefObject<Record<number, HTMLInputElement | null>>;
  composingRef: React.MutableRefObject<Record<number, boolean>>;
  onBlankChange: (wordIdx: number, val: string, composing: boolean) => void;
  onBlankCompositionEnd: (wordIdx: number, val: string) => void;
  onBlankFocus: (wordIdx: number) => void;
  onBlankBlur: (wordIdx: number) => void;
  onBlankEnter: (wordIdx: number) => void;
  onWordTap: (raw: string) => void;
}

export const ClozeLine: React.FC<ClozeLineProps> = ({
  tokens,
  blanks,
  blankSet,
  inputs,
  leftBlanks,
  submitted,
  lenient,
  inputRefs,
  composingRef,
  onBlankChange,
  onBlankCompositionEnd,
  onBlankFocus,
  onBlankBlur,
  onBlankEnter,
  onWordTap,
}) => {
  const t = useT();
  let wi = 0;

  return (
    <div className="font-serif text-[22px] leading-[1.9] flex flex-wrap items-baseline gap-y-2" data-testid="cloze-line">
      {tokens.map(tk => {
        if (tk.type === TokenType.SPACE) {
          return <span key={tk.index} className="w-[0.3em] inline-block" aria-hidden />;
        }
        if (tk.type !== TokenType.WORD) {
          return <span key={tk.index} className="text-mute">{tk.value}</span>;
        }
        const wordIdx = wi++;
        if (!blankSet.has(wordIdx)) {
          return (
            <button
              key={tk.index}
              type="button"
              onClick={() => onWordTap(tk.value)}
              className="text-ink/85 rounded px-0.5 active:bg-accent-soft"
            >
              {tk.value}
            </button>
          );
        }

        const val = inputs[wordIdx] ?? '';
        const verdict = val ? judgeWord(val, tk.value, tk.reading, lenient) : 'wrong';

        if (submitted) {
          const marks = verdict === 'near' ? nearMarks(val, tk.value) : null;
          const chars = letters(tk.value);
          return (
            <button
              key={tk.index}
              type="button"
              data-cloze-verdict={verdict}
              onClick={() => onWordTap(tk.value)}
              className={`rounded px-1 ${
                verdict === 'right'
                  ? 'text-ink font-medium'
                  : verdict === 'near'
                    ? 'text-ink underline decoration-dashed decoration-accent decoration-2 underline-offset-[6px]'
                    : 'text-accent underline decoration-accent decoration-2 underline-offset-[6px]'
              }`}
            >
              {marks && marks.length === chars.length
                ? chars.map((ch, k) => (marks[k] ? <span key={k} className="text-accent">{ch}</span> : ch))
                : tk.value}
            </button>
          );
        }

        const ok = verdict === 'right';
        const near = verdict === 'near' && leftBlanks.has(wordIdx);
        const isLast = blanks[blanks.length - 1] === wordIdx;

        return (
          <span
            key={tk.index}
            className="inline-grid align-baseline"
            style={{ minWidth: `${slotWidthEm(tk.value) + 0.4}em` }}
          >
            <input
              ref={el => { inputRefs.current[wordIdx] = el; }}
              type="text"
              size={1}
              value={val}
              data-cloze-blank={wordIdx}
              onChange={e => onBlankChange(wordIdx, e.target.value, (e.nativeEvent as InputEvent).isComposing)}
              onCompositionStart={() => { composingRef.current[wordIdx] = true; }}
              onCompositionEnd={e => {
                composingRef.current[wordIdx] = false;
                onBlankCompositionEnd(wordIdx, e.currentTarget.value);
              }}
              onFocus={() => onBlankFocus(wordIdx)}
              onBlur={() => onBlankBlur(wordIdx)}
              onKeyDown={e => {
                if (e.key !== 'Enter') return;
                if (composingRef.current[wordIdx] || e.nativeEvent.isComposing || e.keyCode === 229) return;
                e.preventDefault();
                onBlankEnter(wordIdx);
              }}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              enterKeyHint={isLast ? 'done' : 'next'}
              aria-label={t('m.typeHere')}
              className={`col-start-1 row-start-1 w-full min-w-0 h-[38px] px-1 bg-transparent border-0 border-b-2 rounded-none font-serif text-[22px] text-ink caret-accent outline-none ${
                ok ? 'border-transparent' : near ? 'border-dashed border-accent' : 'border-faint focus:border-accent'
              }`}
            />
            <span className="invisible h-0 overflow-hidden whitespace-pre col-start-1 row-start-1 px-1">
              {val}
            </span>
          </span>
        );
      })}
    </div>
  );
};

export interface ClozeBarProps {
  canFill: boolean;
  submitted: boolean;
  rate: number;
  kbInset: number;
  canPrev: boolean;
  canNext: boolean;
  onReplay: () => void;
  onToggleSlow: () => void;
  onReveal: () => void;
  onSubmit: () => void;
  onPrev: () => void;
  onNext: () => void;
}

export const ClozeBar: React.FC<ClozeBarProps> = ({
  canFill,
  submitted,
  rate,
  kbInset,
  canPrev,
  canNext,
  onReplay,
  onToggleSlow,
  onReveal,
  onSubmit,
  onPrev,
  onNext,
}) => {
  const t = useT();
  const isSlow = rate < 0.99;

  return (
    <div
      className={`shrink-0 bg-page border-t border-line px-4 pt-2.5 flex items-center gap-2 ${
        kbInset > 0 ? 'pb-2.5' : 'pb-[max(14px,env(safe-area-inset-bottom))]'
      }`}
    >
      <button
        type="button"
        onClick={onReplay}
        className="min-h-[44px] px-4 rounded-xl bg-ink text-white text-[14px] font-medium flex items-center gap-1 whitespace-nowrap"
      >
        <span aria-hidden>▶</span>
        <span>{t('m.dictReplay')}</span>
      </button>
      <button
        type="button"
        aria-pressed={isSlow}
        onClick={onToggleSlow}
        className={`min-h-[44px] px-3 rounded-xl text-[13px] font-medium tabular-nums ${
          isSlow ? 'bg-accent-soft text-accent' : 'bg-shade text-ink'
        }`}
      >
        {isSlow ? '0.75×' : '1.0×'}
      </button>
      {canFill ? (
        <>
          <button
            type="button"
            disabled={submitted}
            onClick={onReveal}
            className="min-h-[44px] px-3 rounded-xl bg-shade text-ink text-[13px] font-medium whitespace-nowrap disabled:opacity-40"
          >
            {t('m.dictShowLine')}
          </button>
          <button
            type="button"
            disabled={submitted}
            onClick={onSubmit}
            className="ml-auto min-h-[44px] px-4 rounded-xl bg-accent text-white text-[14px] font-semibold whitespace-nowrap disabled:opacity-40"
          >
            {t('m.check')}
          </button>
        </>
      ) : (
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            disabled={!canPrev}
            onClick={onPrev}
            className="min-h-[44px] px-3 rounded-xl bg-shade text-ink text-[13px] font-medium disabled:opacity-40"
          >
            {t('m.prevLine')}
          </button>
          <button
            type="button"
            disabled={!canNext}
            onClick={onNext}
            className="min-h-[44px] px-3 rounded-xl bg-shade text-ink text-[13px] font-medium disabled:opacity-40"
          >
            {t('m.nextLine')}
          </button>
        </div>
      )}
    </div>
  );
};
