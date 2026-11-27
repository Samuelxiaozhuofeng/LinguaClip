// Soft-keyboard bottom inset via visualViewport (with graceful fallback to 0 on
// Android adjustResize or older WebViews without visualViewport).
// When the layout viewport shrinks natively (adjustResize), innerHeight - vv.height is ~0
// so flex containers already stay above the keyboard; when only visualViewport shrinks
// (iOS Safari PWA or overlay keyboards), this returns the exact keyboard height in px.
import { useEffect, useState } from 'react';
import { pushBackClose } from '../backClose';

/** Only intercept back for keyboard dismissal when the viewport inset actually shows a visible keyboard. */
export function shouldRegisterKeyboardBackClose(kbInset: number): boolean {
  return kbInset > 0;
}

/**
 * Dismiss the soft keyboard on system back before closing any sheet (BreakdownSheet / WordSheet).
 * Pass `sheetOpen` so parent effects re-register after child sheets mount, keeping keyboard
 * dismissal at the top of the LIFO back-close stack. Only active while `kbInset > 0` so Android's
 * IME-handled back key never leaves a stale focus-only handler behind.
 */
export function useKeyboardBackClose(kbInset: number, sheetOpen: boolean): void {
  const kbVisible = shouldRegisterKeyboardBackClose(kbInset);
  useEffect(() => {
    if (!kbVisible) return;
    return pushBackClose(() => {
      const active = document.activeElement as HTMLElement | null;
      if (active && typeof active.blur === 'function') active.blur();
    });
  }, [kbVisible, sheetOpen]);
}

export function computeKeyboardInset(
  innerHeight: number,
  vv?: { height: number; offsetTop: number; scale?: number } | null,
): number {
  if (!vv || !Number.isFinite(innerHeight) || !Number.isFinite(vv.height)) return 0;
  // Ignore pinch-zoomed viewports so zooming doesn't push the dock upward.
  if (typeof vv.scale === 'number' && Math.abs(vv.scale - 1) > 0.02) return 0;
  const raw = Math.round(innerHeight - vv.height - (vv.offsetTop || 0));
  return raw > 40 ? raw : 0;
}

export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.visualViewport) return;
    const vv = window.visualViewport;
    const update = () => {
      setInset(computeKeyboardInset(window.innerHeight, vv));
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);

  return inset;
}
