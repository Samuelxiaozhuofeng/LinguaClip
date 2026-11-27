// End-of-section summary card for touch dictation (docs/android.md「手机学习闭环」).
// Shows independent-correct vs stuck counts (noting auto-added to review when enabled)
// and actions to retry the section, move to the next section (or exit on the final section),
// or jump to Review when the host supplies an onReview callback.
import React from 'react';
import { useT } from '../../utils/i18n';

export interface DictSectionSummaryProps {
  /** 1-based section number just finished. */
  sectionNum: number;
  totalSections: number;
  independentCount: number;
  stuckCount: number;
  autoAddEnabled: boolean;
  onRetrySection: () => void;
  onNextSection?: () => void;
  onReview?: () => void;
  onExit: () => void;
}

export const DictSectionSummary: React.FC<DictSectionSummaryProps> = ({
  sectionNum,
  totalSections,
  independentCount,
  stuckCount,
  autoAddEnabled,
  onRetrySection,
  onNextSection,
  onReview,
  onExit,
}) => {
  const t = useT();
  const isLast = !onNextSection;
  const title = isLast && totalSections <= 1
    ? t('m.w2AllDoneTitle')
    : isLast
      ? t('m.w2AllDoneTitle')
      : t('m.w2SecDoneTitle', { n: sectionNum });

  return (
    <div
      className="flex-1 min-h-0 overflow-y-auto px-5 py-8 flex flex-col items-center justify-center gap-5 text-center bg-paper"
      data-testid="dict-section-summary"
    >
      <div className="flex flex-col gap-1">
        <h2 className="text-[22px] font-semibold text-ink">{title}</h2>
        {totalSections > 1 && isLast && (
          <p className="text-[13px] text-mute">{t('m.w2SecDoneTitle', { n: sectionNum })}</p>
        )}
      </div>

      <div className="w-full max-w-xs grid grid-cols-2 gap-3">
        <div className="bg-page rounded-2xl shadow-card px-4 py-4 flex flex-col items-center gap-1">
          <span className="text-[26px] font-semibold text-ink tabular-nums" data-testid="summary-right-count">
            {independentCount}
          </span>
          <span className="text-[13px] text-mute">{t('m.w2StatRight')}</span>
        </div>
        <div className="bg-page rounded-2xl shadow-card px-4 py-4 flex flex-col items-center gap-1">
          <span
            className={`text-[26px] font-semibold tabular-nums ${stuckCount > 0 ? 'text-accent' : 'text-ink'}`}
            data-testid="summary-stuck-count"
          >
            {stuckCount}
          </span>
          <span className="text-[13px] text-mute">{t('m.w2StatStuck')}</span>
          {stuckCount > 0 && autoAddEnabled && (
            <span className="text-[12px] text-accent font-medium">{t('m.w2StuckInReview')}</span>
          )}
        </div>
      </div>

      <div className="w-full max-w-xs flex flex-col gap-2.5 pt-1">
        {onNextSection ? (
          <button
            type="button"
            onClick={onNextSection}
            className="min-h-[48px] w-full px-5 rounded-xl bg-accent text-white text-[15px] font-semibold active:opacity-85"
          >
            {t('m.w2NextSec')}
          </button>
        ) : (
          <button
            type="button"
            onClick={onExit}
            className="min-h-[48px] w-full px-5 rounded-xl bg-accent text-white text-[15px] font-semibold active:opacity-85"
          >
            {t('m.toHome')}
          </button>
        )}

        <div className="flex gap-2.5">
          <button
            type="button"
            onClick={onRetrySection}
            className="flex-1 min-h-[46px] px-4 rounded-xl bg-page shadow-card text-[15px] font-medium text-ink active:bg-shade"
          >
            {t('m.w2RetrySec')}
          </button>
          {onReview && stuckCount > 0 && (
            <button
              type="button"
              onClick={onReview}
              className="flex-1 min-h-[46px] px-4 rounded-xl bg-page shadow-card text-[15px] font-medium text-accent active:bg-shade"
            >
              {t('m.w2GoReview')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
