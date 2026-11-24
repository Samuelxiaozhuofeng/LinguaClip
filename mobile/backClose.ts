// System back (Android key / iOS swipe) closes the sheet or sub-page on top first, instead of
// leaving the whole page under it. Sheets register here while open; mobile/App.tsx's popstate
// handler asks closeTopOnBack() before it navigates.
import { useEffect, useRef } from 'react';

const stack: Array<{ close: () => void }> = [];

/** popstate hook for App: true = a sheet took this back press (App re-pushes its history entry). */
export function closeTopOnBack(): boolean {
  const top = stack.pop();
  if (!top) return false;
  top.close();
  return true;
}

/** Put a closer on top; returns its removal (a sheet closed by its own button). */
export function pushBackClose(close: () => void): () => void {
  const entry = { close };
  stack.push(entry);
  return () => {
    const i = stack.indexOf(entry);
    if (i >= 0) stack.splice(i, 1);
  };
}

/** While `open`, the back key calls onClose instead of leaving the page. */
export function useBackClose(open: boolean, onClose: () => void): void {
  const cb = useRef(onClose);
  cb.current = onClose;
  useEffect(() => (open ? pushBackClose(() => cb.current()) : undefined), [open]);
}
