// Stands in for @tauri-apps/plugin-http in the mobile build (vite.mobile.config.ts):
// the browser's own fetch, CORS and all. User-Agent / Origin (set by the desktop's
// dictionary and feed code) are dropped: a browser that sends a custom User-Agent turns
// the request into a preflight that Wiktionary and most feeds refuse.
export const fetch: typeof globalThis.fetch = (input, init) => {
  if (!init?.headers) return globalThis.fetch(input, init);
  const headers = new Headers(init.headers);
  headers.delete('User-Agent');
  headers.delete('Origin');
  return globalThis.fetch(input, { ...init, headers });
};
