// Polyfills for older Android System WebViews (e.g. Android 10-12 shipping Chromium 83-99)
// where AbortSignal.timeout (Chrome 103+) is absent, which otherwise breaks dictionary/AI/starter fetches.
export function installWebViewPolyfills(target: {
  AbortSignal?: typeof AbortSignal;
  AbortController?: typeof AbortController;
} = globalThis): void {
  const AS = target.AbortSignal as (typeof AbortSignal & { timeout?: (ms: number) => AbortSignal }) | undefined;
  const AC = target.AbortController;
  if (AS && AC && typeof AS.timeout !== 'function') {
    AS.timeout = (ms: number): AbortSignal => {
      const ctrl = new AC();
      const delay = Math.max(0, Number(ms) || 0);
      setTimeout(() => {
        try {
          ctrl.abort(new DOMException('The operation timed out.', 'TimeoutError'));
        } catch {
          ctrl.abort();
        }
      }, delay);
      return ctrl.signal;
    };
  }
}

installWebViewPolyfills();
