// Compact collapsible configuration bar & AI grading status for mobile/ways/Custom.tsx.
import React, { useState } from 'react';
import {
  LEVELS,
  MINUTE_CHOICES,
  type CustomConfig,
  type Level,
} from '../../utils/customPick';
import { useT } from '../../utils/i18n';
import { wordCountOf } from './drillCommon';

export const CustomDoneCard: React.FC<{ onNextSet: () => void; onExit: () => void }> = ({ onNextSet, onExit }) => {
  const t = useT();
  return (
    <div className="bg-page rounded-2xl shadow-card px-4 py-6 flex flex-col items-center gap-3 text-center">
      <h2 className="text-lg font-semibold text-ink">{t('m.customDone')}</h2>
      <div className="flex gap-2.5">
        <button
          type="button"
          onClick={onNextSet}
          className="min-h-[44px] px-4 rounded-xl bg-accent text-white text-sm font-semibold"
        >
          {t('m.customNextSet')}
        </button>
        <button
          type="button"
          onClick={onExit}
          className="min-h-[44px] px-4 rounded-xl bg-shade text-ink text-sm font-medium"
        >
          {t('m.toHome')}
        </button>
      </div>
    </div>
  );
};

export const CustomInactiveRow: React.FC<{
  lineIdx: number;
  rowPos: number;
  text: string;
  completed: boolean;
  level?: string | null;
  onSelect: () => void;
}> = ({ lineIdx, rowPos, text, completed, level, onSelect }) => {
  const t = useT();
  return (
    <button
      type="button"
      data-custom-row={lineIdx}
      onClick={onSelect}
      className="w-full min-h-[48px] px-3.5 py-2 rounded-xl bg-page/80 shadow-card text-left flex items-center gap-2.5 active:bg-shade"
    >
      <span className={`w-6 text-xs text-center tabular-nums shrink-0 ${completed ? 'text-accent font-semibold' : 'text-mute'}`}>
        {completed ? '✓' : rowPos + 1}
      </span>
      <span className={`flex-1 min-w-0 truncate text-[14px] ${completed ? 'font-serif text-ink/75' : 'text-mute'}`}>
        {completed ? text : t('m.customLineHidden', { n: lineIdx + 1, words: wordCountOf(text) })}
      </span>
      {level && level !== 'x' && (
        <span className="shrink-0 px-2 py-0.5 rounded-full bg-shade text-[11px] text-mute font-medium">
          {level}
        </span>
      )}
    </button>
  );
};

export interface CustomControlsProps {
  cfg: CustomConfig;
  hasAi: boolean;
  pickedCount: number;
  prepState: 'idle' | 'loading' | 'ready' | 'failed';
  progress: { done: number; total: number } | null;
  onUpdate: (patch: Partial<CustomConfig>) => void;
  onRetry: () => void;
}

export const CustomControls: React.FC<CustomControlsProps> = ({
  cfg,
  hasAi,
  pickedCount,
  prepState,
  progress,
  onUpdate,
  onRetry,
}) => {
  const t = useT();
  const [open, setOpen] = useState(false);

  const countText = pickedCount > 0
    ? (pickedCount === 1 ? t('home.reviewLineOne') : t('home.reviewLine', { n: pickedCount }))
    : null;
  const summaryParts = [
    t('custom.minutesN', { n: cfg.minutes }),
    cfg.level ?? t('custom.anyLevel'),
    ...(countText ? [countText] : []),
    // Why the level choices are grey, visible without opening the picker.
    ...(hasAi ? [] : [t('m.customNoAi')]),
  ];

  const pickOption = (patch: Partial<CustomConfig>) => {
    onUpdate(patch);
    setOpen(false);
  };

  return (
    <div className="shrink-0 bg-page rounded-2xl shadow-card overflow-hidden">
      <button
        type="button"
        aria-expanded={open}
        data-testid="custom-summary"
        onClick={() => setOpen(v => !v)}
        className="w-full min-h-[40px] px-3.5 py-2 flex items-center justify-between gap-2 text-left active:bg-shade"
      >
        <span className="text-[13px] font-medium text-ink truncate tabular-nums">
          {summaryParts.join(' · ')}
        </span>
        <span aria-hidden className="text-xs text-mute shrink-0">
          {open ? '▴' : '▾'}
        </span>
      </button>

      {open && (
        <div data-testid="custom-picker" className="border-t border-shade px-3 py-2.5 flex flex-col gap-2">
          <div className="flex items-center gap-1.5 overflow-x-auto">
            {MINUTE_CHOICES.map(m => (
              <button
                key={m}
                type="button"
                aria-pressed={cfg.minutes === m}
                onClick={() => pickOption({ minutes: m })}
                className={`shrink-0 min-h-[40px] px-3 rounded-full text-xs font-medium ${
                  cfg.minutes === m ? 'bg-ink text-white' : 'bg-shade text-mute'
                }`}
              >
                {t('custom.minutesN', { n: m })}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1.5 overflow-x-auto">
            <button
              type="button"
              aria-pressed={cfg.level === null}
              onClick={() => pickOption({ level: null })}
              className={`shrink-0 min-h-[40px] px-3 rounded-full text-xs font-medium ${
                cfg.level === null ? 'bg-ink text-white' : 'bg-shade text-mute'
              }`}
            >
              {t('custom.anyLevel')}
            </button>
            {LEVELS.map((lv: Level) => (
              <button
                key={lv}
                type="button"
                disabled={!hasAi}
                aria-pressed={cfg.level === lv}
                onClick={() => pickOption({ level: lv })}
                className={`shrink-0 min-h-[40px] px-3 rounded-full text-xs font-medium disabled:opacity-35 ${
                  cfg.level === lv ? 'bg-ink text-white' : 'bg-shade text-mute'
                }`}
              >
                {lv}
              </button>
            ))}
          </div>

          {!hasAi && (
            <p role="status" data-testid="custom-no-key" className="text-[12px] leading-relaxed text-mute">
              {t('m.customNeedKey')}
            </p>
          )}
        </div>
      )}

      {hasAi && prepState === 'loading' && (
        <p className="border-t border-shade px-3.5 py-1.5 text-xs text-mute" role="status">
          {progress ? t('m.customPreparingProg', progress) : t('m.customPreparing')}
        </p>
      )}

      {hasAi && prepState === 'failed' && (
        <div className="border-t border-shade px-3.5 py-1.5 flex items-center justify-between gap-2" role="alert">
          <span className="text-xs text-accent">{t('m.customFailed')}</span>
          <button
            type="button"
            onClick={onRetry}
            className="min-h-[40px] px-3 rounded-lg bg-shade text-ink text-xs font-medium shrink-0"
          >
            {t('m.retry')}
          </button>
        </div>
      )}
    </div>
  );
};
