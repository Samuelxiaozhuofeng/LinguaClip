// Compact configuration bar & AI grading status for mobile/ways/Custom.tsx.
import React from 'react';
import {
  LEVELS,
  MINUTE_CHOICES,
  type CustomConfig,
  type Level,
} from '../../utils/customPick';
import { useT } from '../../utils/i18n';

export interface CustomControlsProps {
  cfg: CustomConfig;
  hasAi: boolean;
  prepState: 'idle' | 'loading' | 'ready' | 'failed';
  progress: { done: number; total: number } | null;
  onUpdate: (patch: Partial<CustomConfig>) => void;
  onRetry: () => void;
}

export const CustomControls: React.FC<CustomControlsProps> = ({
  cfg,
  hasAi,
  prepState,
  progress,
  onUpdate,
  onRetry,
}) => {
  const t = useT();
  return (
    <>
      {!hasAi && (
        <div role="status" data-testid="custom-no-key" className="bg-page rounded-2xl shadow-card px-4 py-3 text-[13px] leading-relaxed text-ink">
          {t('m.customNeedKey')}
        </div>
      )}

      <div className="bg-page rounded-2xl shadow-card px-3.5 py-3 flex flex-col gap-2">
        <div className="flex items-center gap-1.5 overflow-x-auto">
          {MINUTE_CHOICES.map(m => (
            <button
              key={m}
              type="button"
              aria-pressed={cfg.minutes === m}
              onClick={() => onUpdate({ minutes: m })}
              className={`shrink-0 min-h-[38px] px-3 rounded-full text-xs font-medium ${
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
            onClick={() => onUpdate({ level: null })}
            className={`shrink-0 min-h-[38px] px-3 rounded-full text-xs font-medium ${
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
              onClick={() => onUpdate({ level: lv })}
              className={`shrink-0 min-h-[38px] px-3 rounded-full text-xs font-medium disabled:opacity-35 ${
                cfg.level === lv ? 'bg-ink text-white' : 'bg-shade text-mute'
              }`}
            >
              {lv}
            </button>
          ))}
        </div>

        {hasAi && prepState === 'loading' && (
          <p className="text-xs text-mute" role="status">
            {progress ? t('m.customPreparingProg', progress) : t('m.customPreparing')}
          </p>
        )}

        {hasAi && prepState === 'failed' && (
          <div className="flex items-center justify-between gap-2" role="alert">
            <span className="text-xs text-accent">{t('m.customFailed')}</span>
            <button
              type="button"
              onClick={onRetry}
              className="min-h-[36px] px-3 rounded-lg bg-shade text-ink text-xs font-medium"
            >
              {t('m.retry')}
            </button>
          </div>
        )}
      </div>
    </>
  );
};
