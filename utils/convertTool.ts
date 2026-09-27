import { useSyncExternalStore } from 'react';
import { convertToolStatus, installConvertTool, onConvertToolProgress, type ConvertToolStatus } from './desktop';

// The video converter's download, shared by the add-video dialog and Settings so
// both show the same progress. status: null = not checked yet.
export type ConvertToolState = { status: ConvertToolStatus | null; running: boolean; pct: number; failed: boolean };
let state: ConvertToolState = { status: null, running: false, pct: 0, failed: false };
const listeners = new Set<() => void>();
const setState = (patch: Partial<ConvertToolState>) => {
  state = { ...state, ...patch };
  listeners.forEach(fn => fn());
};
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};
export const useConvertTool = () => useSyncExternalStore(subscribe, () => state);

export async function loadConvertTool(): Promise<ConvertToolStatus | null> {
  try {
    const status = await convertToolStatus();
    setState({ status });
    return status;
  } catch (e) {
    console.error(e);
    return null;
  }
}

let installing: Promise<boolean> | null = null;

// Resolves true once ffmpeg is there. A second call while one runs joins it.
export function downloadConvertTool(): Promise<boolean> {
  installing ??= (async () => {
    setState({ running: true, pct: 0, failed: false });
    const off = await onConvertToolProgress(pct => setState({ pct })).catch(() => () => {});
    try {
      await installConvertTool();
      const ok = !!(await loadConvertTool())?.path;
      if (!ok) setState({ failed: true });
      return ok;
    } catch (e) {
      console.error('Converter download failed:', e);
      setState({ failed: true });
      return false;
    } finally {
      off();
      setState({ running: false });
      installing = null;
    }
  })();
  return installing;
}
