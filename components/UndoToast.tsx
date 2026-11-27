import React, { useEffect, useRef } from 'react';

// Brief non-blocking bottom pill with an undo button (e.g. auto-added review card).
const UndoToast: React.FC<{
  nonce: number;
  message: string;
  undoLabel: string;
  onUndo: () => void;
  onDismiss: () => void;
  ms?: number;
}> = ({ nonce, message, undoLabel, onUndo, onDismiss, ms = 5000 }) => {
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  useEffect(() => {
    const id = window.setTimeout(() => dismissRef.current(), ms);
    return () => window.clearTimeout(id);
  }, [nonce, ms]);

  return (
    <div key={nonce} className="absolute left-1/2 -translate-x-1/2 bottom-24 z-30 fade-in">
      <div className="inline-flex items-center gap-2 pl-3 pr-1.5 py-1 rounded-full bg-accent-soft text-accent text-xs leading-tight shadow-card whitespace-nowrap">
        <span>{message}</span>
        <button
          type="button"
          onClick={e => { e.currentTarget.blur(); onUndo(); }}
          className="press px-2 py-0.5 rounded-full bg-accent/15 hover:bg-accent/25 font-medium transition-colors"
        >
          {undoLabel}
        </button>
      </div>
    </div>
  );
};

export default UndoToast;
