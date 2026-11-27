// Shared post-check feedback block for Dictation & Custom ways:
// optional cached translation line, independent vs helped-correct status pill,
// wrong/near summary text, and secondary actions (Break it down / Save line).
import React from 'react';
import { useT } from '../../utils/i18n';
import type { Checked } from '../dictation';
import { dictCorrectKind } from './drillCommon';

export interface DictStatusBarProps {
  result: Checked | null;
  revealed: boolean;
  everRevealed: boolean;
  usedHint: boolean;
  wrongTries?: number;
  alreadyStuck?: boolean;
  trans: string | null;
  isSaved: boolean;
  onBreakdown: () => void;
  onToggleSave: () => void;
  compact?: boolean;
}

export const DictStatusBar: React.FC<DictStatusBarProps> = ({
  result,
  revealed,
  everRevealed,
  usedHint,
  wrongTries = 0,
  alreadyStuck = false,
  trans,
  isSaved,
  onBreakdown,
  onToggleSave,
  compact = false,
}) => {
  const t = useT();
  const showTrans = !!trans && (revealed || result !== null);
  const showActions = revealed || (result !== null && !result.correct);
  const correctKind = dictCorrectKind({ everRevealed, usedHint, wrongTries, alreadyStuck });
  const helpedKind = correctKind === 'independent' ? null : correctKind;

  const helpedLabel = helpedKind === 'reveal'
    ? t('m.w2RightAfterReveal')
    : helpedKind === 'hint'
      ? t('m.w2RightAfterHint')
      : wrongTries > 1
        ? t('m.fxRightAfterWrongN', { n: wrongTries })
        : t('m.fxRightAfterWrong');

  const wrongCount = result && !result.correct
    ? Math.max(result.words.filter(w => w.verdict !== 'right').length, result.wrong)
    : 0;

  return (
    <>
      {showTrans && (
        <p
          data-testid="dict-trans"
          className="text-[14px] leading-relaxed text-mute border-t border-shade pt-2.5"
        >
          {trans}
        </p>
      )}

      {result?.correct && (
        helpedKind ? (
          <p
            role="status"
            data-testid="dict-right-helped"
            data-helped={helpedKind}
            className="self-start px-3 py-1.5 rounded-full bg-shade text-mute text-[13px] font-medium"
          >
            {helpedLabel}
          </p>
        ) : (
          <p
            role="status"
            data-testid="dict-all-right"
            data-independent="true"
            className="self-start px-3 py-1.5 rounded-full bg-accent-soft text-accent text-[13px] font-semibold"
          >
            ✓ {t('m.dictAllRightAuto')}
          </p>
        )
      )}

      {result && !result.correct && (
        <p className="text-[13px] text-mute" role="status" data-testid="dict-wrong-summary">
          {result.near > 0
            ? t('m.dictNearSummary', { wrong: wrongCount, near: result.near })
            : t('m.dictWrongSummary', { wrong: wrongCount })}
        </p>
      )}

      {showActions && (
        <div
          className="pt-1 border-t border-shade flex flex-wrap items-center gap-2"
          data-testid="dict-actions"
        >
          <button
            type="button"
            onClick={onBreakdown}
            className={`min-h-[44px] ${compact ? 'px-3 text-[13px]' : 'px-3.5 text-[14px]'} rounded-xl bg-shade text-ink font-medium`}
          >
            {t('studio.breakdown')}
          </button>
          <button
            type="button"
            aria-pressed={isSaved}
            onClick={onToggleSave}
            className={`min-h-[44px] ${compact ? 'px-3 text-[13px]' : 'px-3.5 text-[14px]'} rounded-xl font-medium ${
              isSaved ? 'bg-accent-soft text-accent' : 'bg-shade text-ink'
            }`}
          >
            {isSaved ? t('m.saved') : t('m.dictSaveLine')}
          </button>
        </div>
      )}
    </>
  );
};
