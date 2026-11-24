// Shared bottom control + input dock for touch dictation (Dictation & Custom ways).
// Row 1: 4 fixed buttons (Replay / 0.75x / Hint word / Reveal line).
// Row 2: single-line text input (autocorrect off, IME composition guarded) + vermilion Check button.
// Sits above the soft keyboard via parent's flex layout + useKeyboardInset.
import React, { useRef } from 'react';
import { useT } from '../../utils/i18n';

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
  submitDisabled?: boolean;
  keyboardOpen: boolean;
  inputRef?: React.RefObject<HTMLInputElement | null>;
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
  submitDisabled = false,
  keyboardOpen,
  inputRef,
}) => {
  const t = useT();
  const composingRef = useRef(false);
  const isSlow = rate < 0.99;

  const trySubmit = () => {
    if (composingRef.current || submitDisabled) return;
    onSubmit();
  };

  return (
    <div
      data-testid="dict-dock"
      className={`shrink-0 bg-page border-t border-line px-3.5 pt-2.5 flex flex-col gap-2 ${
        keyboardOpen ? 'pb-2.5' : 'pb-[max(12px,env(safe-area-inset-bottom))]'
      }`}
    >
      <div className="grid grid-cols-4 gap-1.5">
        <button
          type="button"
          onClick={onReplay}
          className="min-h-[44px] px-2 rounded-xl bg-ink text-white text-[13px] font-medium flex items-center justify-center gap-1 whitespace-nowrap active:opacity-80"
        >
          <span aria-hidden>▶</span>
          <span>{t('m.dictReplay')}</span>
        </button>
        <button
          type="button"
          aria-pressed={isSlow}
          onClick={onToggleSlow}
          className={`min-h-[44px] px-2 rounded-xl text-[13px] font-medium tabular-nums whitespace-nowrap ${
            isSlow ? 'bg-accent-soft text-accent' : 'bg-shade text-ink'
          }`}
        >
          {isSlow ? '0.75×' : '1.0×'}
        </button>
        <button
          type="button"
          disabled={hintDisabled}
          onClick={onHint}
          className="min-h-[44px] px-2 rounded-xl bg-shade text-ink text-[13px] font-medium whitespace-nowrap disabled:opacity-40"
        >
          {t('m.dictHintWord')}
        </button>
        <button
          type="button"
          disabled={revealDisabled}
          onClick={onReveal}
          className="min-h-[44px] px-2 rounded-xl bg-shade text-ink text-[13px] font-medium whitespace-nowrap disabled:opacity-40"
        >
          {t('m.dictShowLine')}
        </button>
      </div>

      <form
        className="flex items-center gap-2"
        onSubmit={e => {
          e.preventDefault();
          trySubmit();
        }}
      >
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={e => onChange(e.target.value)}
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
          className="flex-1 min-w-0 min-h-[46px] px-3.5 rounded-xl bg-shade font-serif text-[17px] text-ink placeholder:font-sans placeholder:text-[14px] placeholder:text-mute outline-none focus:ring-2 focus:ring-accent/30"
        />
        <button
          type="submit"
          disabled={submitDisabled || !value.trim()}
          className="shrink-0 min-h-[46px] px-4 rounded-xl bg-accent text-white text-[15px] font-semibold whitespace-nowrap disabled:opacity-40 active:opacity-85"
        >
          {t('m.check')}
        </button>
      </form>
    </div>
  );
};
