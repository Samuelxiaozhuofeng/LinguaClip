// Top floating undo banner shared by phone Review and CardLibrary (docs/review.md).
// Replaces confirmation dialogs with an immediate action + 6s undo window.
import React from 'react';
import { useT } from '../../utils/i18n';

export const UndoToast: React.FC<{
  message: string;
  onUndo: () => void;
}> = ({ message, onUndo }) => {
  const t = useT();
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed left-4 right-4 top-[max(12px,env(safe-area-inset-top))] z-[70] flex justify-center pointer-events-none"
    >
      <div className="pointer-events-auto min-h-[44px] max-w-md pl-4 pr-1.5 py-1 rounded-full bg-ink text-inverse text-[14px] flex items-center gap-2.5 shadow-lift">
        <span className="truncate">{message}</span>
        <button
          type="button"
          onClick={onUndo}
          className="shrink-0 min-h-[36px] min-w-[52px] px-3.5 rounded-full bg-inverse/15 active:bg-inverse/25 text-[14px] font-medium"
        >
          {t('review.undo')}
        </button>
      </div>
    </div>
  );
};
