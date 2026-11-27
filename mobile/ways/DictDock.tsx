// Shared bottom control + input dock for touch dictation (Dictation & Custom ways).
// Row 1: Replay / 0.75x / Hint word / Reveal line (all >=44px touch targets).
// Row 2: Prev / Skip / Next (always above the soft keyboard; Next highlights on wrong/reveal).
// Row 3: auto-growing multi-line textarea (up to 3 rows, autocorrect off, IME composition guarded,
//        Enter submits) + vermilion Check button. Buttons prevent mousedown focus theft so the
//        soft keyboard stays open across submit / replay / speed / navigation.
import React, { useLayoutEffect, useRef } from 'react';
import { useT } from '../../utils/i18n';

const MIN_INPUT_PX = 44;
const MAX_INPUT_PX = 96; // ~3 lines at 17px / 1.4 line-height + vertical padding

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
  skipDisabled = false,
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

  const showNavRow = !!(onPrev || onSkip || onNext);

  return (
    <div
      data-testid="dict-dock"
      className={`shrink-0 bg-page border-t border-line px-3 pt-2 flex flex-col gap-1.5 ${
        keyboardOpen ? 'pb-2' : 'pb-[max(10px,env(safe-area-inset-bottom))]'
      }`}
    >
      <div className="grid grid-cols-4 gap-1.5">
        <button
          type="button"
          onMouseDown={keepFocus}
          onClick={runKeepFocus(onReplay)}
          className="min-h-[44px] px-1.5 rounded-xl bg-ink text-white text-[13px] font-medium flex items-center justify-center gap-1 whitespace-nowrap active:opacity-80"
        >
          <span aria-hidden>▶</span>
          <span>{t('m.dictReplay')}</span>
        </button>
        <button
          type="button"
          aria-pressed={isSlow}
          onMouseDown={keepFocus}
          onClick={runKeepFocus(onToggleSlow)}
          className={`min-h-[44px] px-1.5 rounded-xl text-[13px] font-medium tabular-nums whitespace-nowrap ${
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
          className="min-h-[44px] px-1.5 rounded-xl bg-shade text-ink text-[13px] font-medium whitespace-nowrap disabled:opacity-40"
        >
          {t('m.dictHintWord')}
        </button>
        <button
          type="button"
          disabled={revealDisabled}
          onMouseDown={keepFocus}
          onClick={runKeepFocus(onReveal)}
          className="min-h-[44px] px-1.5 rounded-xl bg-shade text-ink text-[13px] font-medium whitespace-nowrap disabled:opacity-40"
        >
          {t('m.dictShowLine')}
        </button>
      </div>

      {showNavRow && (
        <div className="grid grid-cols-3 gap-1.5" data-testid="dict-nav-row">
          <button
            type="button"
            disabled={prevDisabled || !onPrev}
            onMouseDown={keepFocus}
            onClick={runKeepFocus(onPrev)}
            data-testid="dict-prev"
            className="min-h-[44px] px-2 rounded-xl bg-shade text-ink text-[13px] font-medium flex items-center justify-center gap-1 whitespace-nowrap disabled:opacity-40 active:opacity-80"
          >
            <span aria-hidden>‹</span>
            <span>{t('m.w2Prev')}</span>
          </button>
          <button
            type="button"
            disabled={skipDisabled || !onSkip}
            onMouseDown={keepFocus}
            onClick={runKeepFocus(onSkip)}
            data-testid="dict-skip"
            className="min-h-[44px] px-2 rounded-xl bg-shade text-ink text-[13px] font-medium whitespace-nowrap disabled:opacity-40 active:opacity-80"
          >
            {t('m.w2Skip')}
          </button>
          <button
            type="button"
            disabled={nextDisabled || !onNext}
            onMouseDown={keepFocus}
            onClick={runKeepFocus(onNext)}
            data-testid="dict-next"
            className={`min-h-[44px] px-2 rounded-xl text-[13px] flex items-center justify-center gap-1 whitespace-nowrap disabled:opacity-40 active:opacity-85 ${
              nextHighlight
                ? 'bg-accent text-white font-semibold'
                : 'bg-shade text-ink font-medium'
            }`}
          >
            <span>{t('m.w2Next')}</span>
            <span aria-hidden>›</span>
          </button>
        </div>
      )}

      <form
        className="flex items-end gap-2"
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
          className="flex-1 min-w-0 min-h-[44px] max-h-[96px] py-2.5 px-3.5 rounded-xl bg-shade font-serif text-[17px] leading-[1.4] text-ink placeholder:font-sans placeholder:text-[14px] placeholder:text-mute outline-none resize-none focus:ring-2 focus:ring-accent/30"
        />
        <button
          type="submit"
          disabled={submitDisabled || !value.trim()}
          onMouseDown={keepFocus}
          className="shrink-0 min-h-[44px] px-4 rounded-xl bg-accent text-white text-[15px] font-semibold whitespace-nowrap disabled:opacity-40 active:opacity-85"
        >
          {t('m.check')}
        </button>
      </form>
    </div>
  );
};
