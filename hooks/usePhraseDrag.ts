import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

// Drag from one word of a line to another and let go: the run is looked up as a phrase
// (docs/phrase.md). A plain click is left to the word's own onClick. Letting go outside
// this line cancels. `bind(i)` goes on word i's element (any index the line can map back
// to text); `inSel(i)` = word i is inside the run being dragged.
// onCancel: let go outside the line (the watch page plays again what onPress paused).
export const usePhraseDrag = (onPhrase: (from: number, to: number) => void, onPress?: () => void, onCancel?: () => void) => {
  const id = useId();
  const drag = useRef<{ from: number } | null>(null);
  const [sel, setSel] = useState<[number, number] | null>(null);
  const cb = useRef({ onPhrase, onPress, onCancel });
  cb.current = { onPhrase, onPress, onCancel };

  useEffect(() => {
    const up = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      drag.current = null;
      setSel(null);
      const el = (e.target as Element | null)?.closest?.('[data-phrase]');
      if (!el || el.getAttribute('data-phrase') !== id) { cb.current.onCancel?.(); return; }
      const to = Number(el.getAttribute('data-phrase-i'));
      if (to !== d.from) cb.current.onPhrase(Math.min(d.from, to), Math.max(d.from, to));
    };
    // Interrupted (a system gesture, the window losing the pointer): dropped like a let-go outside.
    const cancel = () => { if (drag.current) { drag.current = null; setSel(null); cb.current.onCancel?.(); } };
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', cancel);
    return () => { document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', cancel); };
  }, [id]);

  const bind = (i: number) => ({
    'data-phrase': id,
    'data-phrase-i': i,
    onPointerDown: (e: ReactPointerEvent) => {
      if (e.button !== 0) return;
      drag.current = { from: i };
      setSel([i, i]);
      cb.current.onPress?.();
    },
    onPointerEnter: () => {
      const d = drag.current;
      if (d) setSel([Math.min(d.from, i), Math.max(d.from, i)]);
    },
  });
  const inSel = (i: number) => !!sel && sel[0] !== sel[1] && i >= sel[0] && i <= sel[1];
  return { bind, inSel };
};
