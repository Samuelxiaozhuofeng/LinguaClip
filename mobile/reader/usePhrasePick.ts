// Reusable touch long-press & drag phrase picker for mobile subtitles (docs/phrase.md, M2.3).
// Used by mobile/reader/ReadLine.tsx and mobile/LineView.tsx:
// - Quick tap on a word → onWord(word)
// - Hold a word (~450ms) → haptic buzz, enters selection mode with start/end vermilion dot handles
// - Slide finger while holding, drag either handle, or tap another word in the same line → expands range
// - Lift finger after expanding (or tap second word) → onPhrase(exactSubstring)
// - Tap outside / blank space → cancels selection; blocks native text selection & context menu.
import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import {
  expandRangeByHandle,
  extractPhraseText,
  isIndexInRange,
  type PickHandle,
  type PickRange,
  type PickToken,
} from './phrasePick';

const LONG_PRESS_MS = 450;
const MOVE_CANCEL_PX = 12;

function hapticTick(): void {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try { navigator.vibrate(10); } catch { /* ignore unsupported WebView */ }
  }
}

export type PhrasePickSelection = {
  anchor: number;
  range: PickRange;
  dragging: boolean;
  handle: PickHandle | null;
};

export interface UsePhrasePickOptions {
  tokens: readonly PickToken[];
  onWord: (word: string) => void;
  onPhrase: (phrase: string) => void;
  /** Optional callback whenever selection opens/closes (lets parent suppress line-play taps). */
  /** byTap: a tap elsewhere just dropped the selection — that tap must not also act (e.g. play the row). */
  onSelectingChange?: (selecting: boolean, byTap?: boolean) => void;
}

export const TAP_CANCEL_MS = 700;

export function usePhrasePick({ tokens, onWord, onPhrase, onSelectingChange }: UsePhrasePickOptions) {
  const lineKey = useId();
  const [sel, setSel] = useState<PhrasePickSelection | null>(null);
  const selRef = useRef<PhrasePickSelection | null>(null);
  selRef.current = sel;

  const tokensRef = useRef(tokens);
  tokensRef.current = tokens;
  const cbRef = useRef({ onWord, onPhrase, onSelectingChange });
  cbRef.current = { onWord, onPhrase, onSelectingChange };

  const timerRef = useRef<number | null>(null);
  // Document listeners only while this line is pressed or selecting: a reader renders every line,
  // and hundreds of always-on non-passive touchmove listeners make scrolling stutter.
  const [pressing, setPressing] = useState(false);
  const armed = pressing || sel !== null;
  const pressRef = useRef<{ index: number; x: number; y: number } | null>(null);
  const suppressClickRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // When a tap off the selection drops it: that same tap's click must not also play the row.
  const tapCancelAtRef = useRef(0);
  const updateSel = useCallback((next: PhrasePickSelection | null, byTap = false) => {
    const was = selRef.current !== null;
    selRef.current = next;
    setSel(next);
    if (byTap) tapCancelAtRef.current = performance.now();
    if (was !== (next !== null)) cbRef.current.onSelectingChange?.(next !== null, byTap);
  }, []);

  const cancel = useCallback(() => {
    setPressing(false);
    clearTimer();
    pressRef.current = null;
    if (selRef.current !== null) updateSel(null);
  }, [clearTimer, updateSel]);

  const commitRange = useCallback((range: PickRange) => {
    const text = extractPhraseText(tokensRef.current, range[0], range[1]);
    updateSel(null);
    if (text) cbRef.current.onPhrase(text);
  }, [updateSel]);

  const hitWordIndex = useCallback((clientX: number, clientY: number): number | null => {
    if (typeof document === 'undefined') return null;
    const stack = typeof document.elementsFromPoint === 'function'
      ? document.elementsFromPoint(clientX, clientY)
      : document.elementFromPoint
        ? [document.elementFromPoint(clientX, clientY)].filter(Boolean)
        : [];
    for (const hit of stack) {
      const el = (hit as Element | null)?.closest?.('[data-pick-line]');
      if (!el || el.getAttribute('data-pick-line') !== lineKey) continue;
      const raw = el.getAttribute('data-pick-i');
      if (raw === null) continue;
      const idx = Number(raw);
      if (Number.isInteger(idx)) return idx;
    }
    return null;
  }, [lineKey]);

  useEffect(() => () => clearTimer(), [clearTimer]);

  // Reset if line tokens shrink or change underneath an active selection.
  useEffect(() => {
    if (selRef.current && selRef.current.range[1] >= tokens.length) {
      updateSel(null);
    }
  }, [tokens.length, updateSel]);

  useLayoutEffect(() => {
    if (!armed) return;
    const onMove = (e: PointerEvent) => {
      const p = pressRef.current;
      if (p && timerRef.current !== null) {
        if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > MOVE_CANCEL_PX) {
          clearTimer();
          pressRef.current = null;
        }
        return;
      }
      const cur = selRef.current;
      if (!cur || (!cur.dragging && !cur.handle)) return;
      const idx = hitWordIndex(e.clientX, e.clientY);
      if (idx === null) return;
      const count = tokensRef.current.length;
      if (cur.handle) {
        const nextRange = expandRangeByHandle(cur.range, cur.handle, idx, count);
        if (nextRange[0] !== cur.range[0] || nextRange[1] !== cur.range[1]) {
          updateSel({ ...cur, range: nextRange });
        }
      } else if (cur.dragging) {
        const nextRange: PickRange = [Math.min(cur.anchor, idx), Math.max(cur.anchor, idx)];
        if (nextRange[0] !== cur.range[0] || nextRange[1] !== cur.range[1]) {
          updateSel({ ...cur, range: nextRange });
        }
      }
    };

    const onUp = () => {
      setPressing(false);
      clearTimer();
      pressRef.current = null;
      const cur = selRef.current;
      if (!cur) return;
      if (cur.handle) {
        commitRange(cur.range);
        return;
      }
      if (cur.dragging) {
        if (cur.range[0] !== cur.range[1]) {
          commitRange(cur.range);
        } else {
          // Single-word long-press released: keep handles visible so user can drag a handle or tap another word.
          updateSel({ ...cur, dragging: false });
        }
      }
    };

    const onCancel = () => {
      setPressing(false);
      clearTimer();
      pressRef.current = null;
      const cur = selRef.current;
      if (cur && (cur.dragging || cur.handle)) {
        updateSel(cur.range[0] === cur.range[1] ? null : { ...cur, dragging: false, handle: null });
      }
    };

    const onDocDown = (e: PointerEvent) => {
      if (!selRef.current) return;
      const target = e.target as Element | null;
      const inLine = target?.closest?.('[data-pick-line]')?.getAttribute('data-pick-line') === lineKey;
      const inHandle = target?.closest?.('[data-pick-handle-line]')?.getAttribute('data-pick-handle-line') === lineKey;
      if (!inLine && !inHandle) {
        updateSel(null, true);
      }
    };

    // Prevent browser scroll from stealing an active touch phrase drag or handle drag.
    const onTouchMove = (e: TouchEvent) => {
      const cur = selRef.current;
      if (cur && (cur.dragging || cur.handle) && e.cancelable) {
        e.preventDefault();
      }
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onCancel);
    document.addEventListener('pointerdown', onDocDown, true);
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onCancel);
      document.removeEventListener('pointerdown', onDocDown, true);
      document.removeEventListener('touchmove', onTouchMove);
    };
  }, [armed, clearTimer, commitRange, hitWordIndex, lineKey, updateSel]);

  const bindWord = (index: number, word: string) => ({
    'data-pick-line': lineKey,
    'data-pick-i': index,
    onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); },
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      suppressClickRef.current = false;
      const cur = selRef.current;
      if (cur) {
        // Already in phrase selection on this line: tapping a word extends/commits the phrase.
        suppressClickRef.current = true;
        if (index === cur.range[0] && index === cur.range[1]) {
          commitRange(cur.range);
        } else {
          commitRange([Math.min(cur.anchor, index), Math.max(cur.anchor, index)]);
        }
        return;
      }
      pressRef.current = { index, x: e.clientX, y: e.clientY };
      setPressing(true);
      clearTimer();
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        if (!pressRef.current || pressRef.current.index !== index) return;
        suppressClickRef.current = true;
        hapticTick();
        updateSel({ anchor: index, range: [index, index], dragging: true, handle: null });
      }, LONG_PRESS_MS);
    },
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        return;
      }
      if (selRef.current) return;
      cbRef.current.onWord(word);
    },
  });

  const bindHandle = (side: PickHandle) => ({
    'data-pick-handle-line': lineKey,
    'data-pick-handle': side,
    'data-pick-dragging': sel?.dragging ? '1' : undefined,
    onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); },
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      suppressClickRef.current = true;
      const cur = selRef.current;
      if (!cur) return;
      updateSel({ ...cur, dragging: false, handle: side });
    },
  });

  const containerProps = {
    onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); },
    style: {
      WebkitTouchCallout: 'none',
      WebkitUserSelect: 'none',
      userSelect: 'none',
      touchAction: sel && (sel.dragging || sel.handle) ? 'none' : 'pan-y',
    } as React.CSSProperties,
  };

  return {
    sel,
    selecting: sel !== null,
    /** True right after a tap dropped the selection (that tap's click should do nothing else). */
    tapCancelled: () => performance.now() - tapCancelAtRef.current < TAP_CANCEL_MS,
    inRange: (index: number) => isIndexInRange(index, sel?.range ?? null),
    isStart: (index: number) => !!sel && sel.range[0] === index,
    isEnd: (index: number) => !!sel && sel.range[1] === index,
    bindWord,
    bindHandle,
    containerProps,
    cancel,
  };
}

/** Small vermilion dot handle below the edge of the selection, never obscuring letters or adjacent words. */
export const PickHandleDot: React.FC<{
  side: PickHandle;
  bind: ReturnType<ReturnType<typeof usePhrasePick>['bindHandle']>;
}> = ({ side, bind }) =>
  React.createElement(
    'span',
    {
      ...bind,
      role: 'slider',
      'aria-label': side === 'start' ? 'Selection start' : 'Selection end',
      'aria-valuenow': side === 'start' ? 0 : 1,
      className: `absolute -bottom-3.5 z-10 inline-flex items-center justify-center w-7 h-7 cursor-grab touch-none ${
        bind['data-pick-dragging'] ? 'pointer-events-none' : ''
      } ${side === 'start' ? '-left-3' : '-right-3'}`,
    },
    React.createElement('span', {
      className: 'w-2.5 h-2.5 rounded-full bg-accent ring-2 ring-page shadow-card pointer-events-none',
    }),
  );
