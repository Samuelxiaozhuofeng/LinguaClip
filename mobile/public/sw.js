// LinguaClip phone app's service worker (docs/mobile-web.md「离线 / 安装」): keeps only
// the app's own files (other caches, like the Japanese dictionary's, are left alone).
// Pages: network first, the cached copy when offline. Hashed build files under
// /app/assets/: cache first. Never audio, /starter/, Groq, AI or feeds
// (other origins and paths outside /app/ are not touched at all).
// Some servers add Vary: Origin to build files, which would make the cached copies miss offline.
const CACHE = 'linguaclip-app-v1';
const SCOPE = new URL(self.registration.scope).pathname; // '/app/'

// The page and the build files it names, so the first visit already opens offline.
// Failing never holds the install up.
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(async c => {
    const res = await fetch(SCOPE);
    if (!res.ok) return;
    const html = await res.clone().text();
    await c.put(SCOPE, res);
    await c.addAll([...new Set(html.match(new RegExp(`${SCOPE}assets/[^"'\\s)>]+`, 'g')) ?? [])]);
  }).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('linguaclip-app-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

const keep = (req, res) => {
  if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
  return res;
};

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || !url.pathname.startsWith(SCOPE)) return;
  if (req.headers.has('range') || req.destination === 'audio' || url.pathname.endsWith('/sw.js')) return;
  if (url.pathname.startsWith(SCOPE + 'assets/')) {
    e.respondWith(caches.match(req, { ignoreVary: true }).then(hit => hit || fetch(req).then(res => keep(req, res))));
    return;
  }
  // ponytail: assets of old versions stay in the cache until the cache name changes.
  e.respondWith(fetch(req).then(res => keep(req.mode === 'navigate' ? SCOPE : req, res))
    .catch(() => caches.match(req.mode === 'navigate' ? SCOPE : req, { ignoreVary: true }).then(hit => hit || Response.error())));
});
