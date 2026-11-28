// Shared bottom control + input dock for touch dictation (Dictation & Custom ways).
// Row 1: Prev / Replay / 0.75x / Hint word / Reveal line / Skip-or-Next (all >=40px touch targets).
//        Skip becomes highlighted Next once the line is answered or revealed.
// Row 2: auto-growing multi-line textarea (up to 3 rows, autocorrect off, IME composition guarded,
//        Enter submits) + vermilion Check button. Buttons prevent mousedown focus theft so the
//        soft keyboard stays open across submit / replay / speed / navigation.
import React, { useLayoutEffect, useRef } from 'react';
import { useT } from '../../utils/i18n';

const MIN_INPUT_PX = 42;
const MAX_INPUT_PX = 92; // ~3 lines at 16px / 1.4 line-height + vertical padding

export interface DictDockProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onReplay: () => void;
  rate: number;
  onToggleSlow: () => void;
  onHint: () => void;
  hintDisabled: boolean;
  onReveal: () => void;
  revealDisabled: boolean;
  onPrev?: () => void;
  prevDisabled?: boolean;
  onSkip?: () => void;
  skipDisabled?: boolean;
  onNext?: () => void;
  nextDisabled?: boolean;
  nextHighlight?: boolean;
  submitDisabled?: boolean;
  keyboardOpen: boolean;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  onFocusChange?: (focused: boolean) => void;
}

export const DictDock: React.FC<DictDockProps> = ({
  value,
  onChange,
  onSubmit,
  onReplay,
  rate,
  onToggleSlow,
  onHint,
  hintDisabled,
  onReveal,
  revealDisabled,
  onPrev,
  prevDisabled = false,
  onSkip,
  onNext,
  nextDisabled = false,
  nextHighlight = false,
  submitDisabled = false,
  keyboardOpen,
  inputRef,
  onFocusChange,
}) => {
  const t = useT();
  const composingRef = useRef(false);
  const localRef = useRef<HTMLTextAreaElement | null>(null);
  const isSlow = rate < 0.99;

  const setTextareaRef = (el: HTMLTextAreaElement | null) => {
    localRef.current = el;
    if (inputRef) inputRef.current = el;
  };

  useLayoutEffect(() => {
    const el = localRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const next = Math.min(el.scrollHeight, MAX_INPUT_PX);
    el.style.height = `${Math.max(MIN_INPUT_PX, next)}px`;
    el.style.overflowY = el.scrollHeight > MAX_INPUT_PX ? 'auto' : 'hidden';
  }, [value]);

  const keepFocus = (e: React.MouseEvent) => {
    // Prevent tapping dock controls from stealing focus from the textarea and bouncing the keyboard.
    e.preventDefault();
  };

  const restoreFocus = () => {
    const el = localRef.current;
    if (el && document.activeElement !== el) {
      el.focus({ preventScroll: true });
    }
  };

  const runKeepFocus = (fn?: () => void) => () => {
    fn?.();
    restoreFocus();
  };

  const trySubmit = () => {
    if (composingRef.current || submitDisabled || !value.trim()) return;
    onSubmit();
    restoreFocus();
  };

  const advanceFn = onNext ?? onSkip;

  return (
    <div
      data-testid="dict-dock"
      className={`shrink-0 bg-page border-t border-line px-2.5 pt-1.5 flex flex-col gap-1.5 ${
        keyboardOpen ? 'pb-1.5' : 'pb-[max(8px,env(safe-area-inset-bottom))]'
      }`}
    >
      <div className="flex items-center gap-1" data-testid="dict-ctrl-row">
        {onPrev && (
          <button
            type="button"
            disabled={prevDisabled}
            aria-label={t('m.w2Prev')}
            onMouseDown={keepFocus}
            onClick={runKeepFocus(onPrev)}
            data-testid="dict-prev"
            className="w-10 shrink-0 min-h-[40px] rounded-xl bg-shade text-ink text-[18px] leading-none flex items-center justify-center disabled:opacity-40 active:opacity-80"
          >
            <span aria-hidden>‹</span>
          </button>
        )}
        <button
          type="button"
          onMouseDown={keepFocus}
          onClick={runKeepFocus(onReplay)}
          className="flex-auto min-h-[40px] px-2 rounded-xl bg-ink text-inverse text-[12px] font-medium flex items-center justify-center gap-1 whitespace-nowrap active:opacity-80"
        >
          <span aria-hidden>▶</span>
          <span>{t('m.dictReplay')}</span>
        </button>
        <button
          type="button"
          aria-pressed={isSlow}
          onMouseDown={keepFocus}
          onClick={runKeepFocus(onToggleSlow)}
          className={`shrink-0 min-w-[44px] min-h-[40px] px-1.5 rounded-xl text-[12px] font-medium tabular-nums whitespace-nowrap ${
            isSlow ? 'bg-accent-soft text-accent' : 'bg-shade text-ink'
          }`}
        >
          {isSlow ? '0.75×' : '1.0×'}
        </button>
        <button
          type="button"
          disabled={hintDisabled}
          onMouseDown={keepFocus}
          onClick={runKeepFocus(onHint)}
          className="flex-auto min-h-[40px] px-1.5 rounded-xl bg-shade text-ink text-[12px] font-medium whitespace-nowrap disabled:opacity-40"
        >
          {t('m.dictHintWord')}
        </button>
        <button
          type="button"
          disabled={revealDisabled}
          onMouseDown={keepFocus}
          onClick={runKeepFocus(onReveal)}
          className="flex-auto min-h-[40px] px-1.5 rounded-xl bg-shade text-ink text-[12px] font-medium whitespace-nowrap disabled:opacity-40"
        >
          {t('m.dictShowLine')}
        </button>
        {advanceFn && (
          <button
            type="button"
            disabled={nextDisabled}
            onMouseDown={keepFocus}
            onClick={runKeepFocus(advanceFn)}
            data-testid={nextHighlight ? 'dict-next' : 'dict-skip'}
            className={`flex-auto min-h-[40px] px-2 rounded-xl text-[12px] flex items-center justify-center whitespace-nowrap disabled:opacity-40 active:opacity-85 ${
              nextHighlight
                ? 'bg-accent text-white font-semibold'
                : 'bg-shade text-ink font-medium'
            }`}
          >
            {nextHighlight ? t('m.w2Next') : t('m.w2Skip')}
          </button>
        )}
      </div>

      <form
        className="flex items-end gap-1.5"
        onSubmit={e => {
          e.preventDefault();
          trySubmit();
        }}
      >
        <textarea
          ref={setTextareaRef}
          rows={1}
          value={value}
          onChange={e => onChange(e.target.value.replace(/[\r\n]+/g, ' '))}
          onFocus={() => onFocusChange?.(true)}
          onBlur={() => onFocusChange?.(false)}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
          onKeyDown={e => {
            if (e.key !== 'Enter') return;
            if (composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
            e.preventDefault();
            trySubmit();
          }}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="done"
          aria-label={t('m.typeHere')}
          placeholder={t('m.typeHere')}
          className="flex-1 min-w-0 min-h-[42px] max-h-[92px] py-2 px-3 rounded-xl bg-shade font-serif text-[16px] leading-[1.4] text-ink placeholder:font-sans placeholder:text-[14px] placeholder:text-mute outline-none resize-none focus:ring-2 focus:ring-accent/30"
        />
        <button
          type="submit"
          disabled={submitDisabled || !value.trim()}
          onMouseDown={keepFocus}
          className="shrink-0 min-h-[42px] px-4 rounded-xl bg-accent text-white text-[15px] font-semibold whitespace-nowrap disabled:opacity-40 active:opacity-85"
        >
          {t('m.check')}
        </button>
      </form>
    </div>
  );
};
