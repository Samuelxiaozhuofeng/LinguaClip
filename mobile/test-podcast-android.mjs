/**
 * Android M1.3 podcast logic tests:
 * - OPML parsing (nested folders, XSS/tag stripping, protocol filtering, deduplication, invalid XML)
 * - Subscription storage (add, merge, remove, isSubscribed, corrupt localStorage resilience)
 * - Wi-Fi-only preference & cellular network confirmation branches
 * - Safe Android deletion order (record -> cards -> local/IDB -> Rust purge, clip keep prompt, stop timeout, restore lock)
 * - Startup orphan sweep 6 safety invariants (restore lock, PENDING_KEY, DB errors, empty library, keepIds/activeImportIds)
 * Run with: node mobile/test-podcast-android.mjs
 */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = join(tmpdir(), `mobile-podcast-android-${process.pid}.mjs`);
await build({
  stdin: {
    contents: "export * from './mobile/opml'; export * from './mobile/platform/deleteAndroid';",
    resolveDir: '.',
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: out,
  logLevel: 'error',
  plugins: [{
    name: 'stub-tauri',
    setup(b) {
      b.onResolve({ filter: /^@tauri-apps\// }, args => ({ path: args.path, namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        contents: `
          const noop = () => { throw new Error("stub tauri call"); };
          export const invoke = noop;
          export const convertFileSrc = noop;
          export const homeDir = noop;
          export const join = noop;
          export const getCurrentWebview = noop;
          export const getCurrentWindow = noop;
          export const listen = noop;
          export const open = noop;
          export const save = noop;
          export const openUrl = noop;
          export const revealItemInDir = noop;
          export const exists = noop;
          export const readFile = noop;
          export const readTextFile = noop;
          export const remove = noop;
          export const check = noop;
          export const relaunch = noop;
          export const getVersion = noop;
          export const fetch = noop;
        `,
      }));
    },
  }],
});

// Lightweight XML DOMParser polyfill for Node so parseOpml's real DOMParser path is tested.
function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

class MiniDOMParser {
  parseFromString(xml) {
    if (!/<opml\b/i.test(xml) || /<unclosed-bad-xml\b/i.test(xml)) {
      return { getElementsByTagName: tag => (tag === 'parsererror' ? [{}] : []) };
    }
    const outlines = [];
    const tagRe = /<outline\b([^>]*?)\/?\s*>/gi;
    let m;
    while ((m = tagRe.exec(xml)) !== null) {
      const attrs = new Map();
      const attrRe = /([A-Za-z_][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      let a;
      while ((a = attrRe.exec(m[1])) !== null) {
        attrs.set(a[1], decodeXmlEntities(a[2] ?? a[3] ?? ''));
      }
      outlines.push({ getAttribute: k => (attrs.has(k) ? attrs.get(k) : null) });
    }
    return {
      getElementsByTagName: tag => (tag === 'outline' ? outlines : []),
    };
  }
}

globalThis.DOMParser = MiniDOMParser;

const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: k => { store.delete(k); },
  clear: () => { store.clear(); },
};

const M = await import(out);

// --- 1. OPML parsing: nested folders, XSS filtering, protocol allowlist, deduplication ---
{
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
  <opml version="2.0">
    <body>
      <outline text="English">
        <outline text="Fallback Text" title="6 Minute English" xmlUrl="https://podcasts.files.bbci.co.uk/p02pc9tn.rss" />
        <outline text="Duplicate Uppercase Host" title="Dup" xmlUrl="HTTPS://PODCASTS.FILES.BBCI.CO.UK/p02pc9tn.rss" />
        <outline text="Nested Folder">
          <outline text="&lt;script&gt;alert(1)&lt;/script&gt;&lt;b&gt;Clean&lt;/b&gt; Show" xmlUrl="https://example.com/feed/" />
          <outline text="Trailing Slash Dup" xmlUrl="https://example.com/feed" />
          <outline text="Only URL" title="&lt;script&gt;evil()&lt;/script&gt;" xmlUrl="http://plain.example.org/rss.xml" />
        </outline>
      </outline>
      <outline text="Bad JS" xmlUrl="javascript:alert(1)" />
      <outline text="Bad Data" xmlUrl="data:text/xml,&lt;rss/&gt;" />
      <outline text="Bad File" xmlUrl="file:///etc/passwd" />
      <outline text="Bad Relative" xmlUrl="/local/feed.xml" />
    </body>
  </opml>`;

  const subs = M.parseOpml(xml, 1700000000000);
  assert.equal(subs.length, 3, 'should keep 3 unique valid http(s) feeds across nested outlines');
  assert.equal(subs[0].title, '6 Minute English', 'title takes precedence over text');
  assert.equal(subs[0].feed, 'https://podcasts.files.bbci.co.uk/p02pc9tn.rss');
  assert.equal(subs[1].title, 'Clean Show', 'script and HTML tags stripped to plain text');
  assert.ok(!subs[1].title.includes('<') && !subs[1].title.includes('alert'), 'no XSS payload remains');
  assert.equal(subs[2].title, 'Only URL', 'falls back to text when title cleans to empty');
  assert.equal(subs[2].feed, 'http://plain.example.org/rss.xml');

  assert.deepEqual(M.parseOpml('   '), []);
  assert.throws(() => M.parseOpml('<unclosed-bad-xml>'), /invalid XML/);
}

// --- 2. Subscription persistence: add, merge, remove, isSubscribed, corrupt data ---
{
  store.clear();
  assert.deepEqual(M.getPodcastSubs(), []);
  M.addPodcastSub({ feed: 'https://a.example/rss/', title: 'Show A', addedAt: 100 });
  assert.equal(M.isPodcastSubscribed('https://a.example/rss'), true);
  assert.equal(M.isPodcastSubscribed('https://b.example/rss'), false);

  // Adding same feed updates metadata without duplicating.
  const updated = M.addPodcastSub({ feed: 'https://a.example/rss', title: 'Show A Renamed', image: 'https://a.example/art.jpg' });
  assert.equal(updated.length, 1);
  assert.equal(updated[0].title, 'Show A Renamed');
  assert.equal(updated[0].image, 'https://a.example/art.jpg');

  // Merge skips existing, appends new, filters invalid URLs.
  const merged = M.mergePodcastSubs([
    { feed: 'https://a.example/rss/', title: 'Dup A', addedAt: 200 },
    { feed: 'https://b.example/rss', title: '<b>Show B</b>', addedAt: 201 },
    { feed: 'javascript:bad()', title: 'Bad', addedAt: 202 },
  ]);
  assert.equal(merged.added, 1);
  assert.equal(merged.total, 2);
  assert.equal(merged.list[1].title, 'Show B');

  const afterRemove = M.removePodcastSub('https://a.example/rss');
  assert.equal(afterRemove.length, 1);
  assert.equal(afterRemove[0].feed, 'https://b.example/rss');

  // Corrupt JSON in localStorage safely returns empty list.
  store.set(M.PODCAST_SUBS_KEY, '{broken-json');
  assert.deepEqual(M.getPodcastSubs(), []);
}

// --- 3. Wi-Fi-only switch & confirmPodcastDownloadNetwork ---
{
  store.clear();
  assert.equal(M.getPodcastWifiOnly(), false, 'defaults to off');
  M.setPodcastWifiOnly(true);
  assert.equal(store.get(M.PODCAST_WIFI_ONLY_KEY), '1');
  assert.equal(M.getPodcastWifiOnly(), true);
  M.setPodcastWifiOnly(false);
  assert.equal(store.get(M.PODCAST_WIFI_ONLY_KEY), '0');
  assert.equal(M.getPodcastWifiOnly(), false);

  // Non-Android always allows download without prompting.
  delete globalThis.window;
  M.setPodcastWifiOnly(true);
  assert.equal(await M.confirmPodcastDownloadNetwork(), true);

  // Android bridge mock
  let mockNet = { connected: true, wifi: true, metered: false };
  let confirmCalls = 0;
  let confirmAnswer = false;
  globalThis.confirm = () => { confirmCalls += 1; return confirmAnswer; };
  globalThis.window = {
    LinguaAndroid: {
      isAvailable: () => true,
      call(reqId, method) {
        assert.equal(method, 'system.networkState');
        queueMicrotask(() => globalThis.window.__lcAndroidResolve(reqId, true, JSON.stringify(mockNet)));
      },
    },
  };

  // Wi-Fi connected -> no prompt, returns true.
  assert.equal(await M.confirmPodcastDownloadNetwork(), true);
  assert.equal(confirmCalls, 0);

  // Cellular + wifiOnly off -> no prompt, returns true.
  mockNet = { connected: true, wifi: false, metered: true };
  M.setPodcastWifiOnly(false);
  assert.equal(await M.confirmPodcastDownloadNetwork(), true);
  assert.equal(confirmCalls, 0);

  // Cellular + wifiOnly on + user cancels -> returns false.
  M.setPodcastWifiOnly(true);
  confirmAnswer = false;
  assert.equal(await M.confirmPodcastDownloadNetwork(), false);
  assert.equal(confirmCalls, 1);

  // Cellular + wifiOnly on + user confirms -> returns true.
  confirmAnswer = true;
  assert.equal(await M.confirmPodcastDownloadNetwork(), true);
  assert.equal(confirmCalls, 2);

  delete globalThis.window;
  delete globalThis.confirm;
}

// --- 4. Safe Android deletion order, clip preservation, stop timeout & restore lock ---
{
  const order = [];
  let keptPassed = null;
  let keepFlagPassed = null;
  const ok = await M.runDeleteAndroidRecord('ep-1', {
    outsideRestore: async fn => fn(),
    getAllCards: async () => [
      { id: 'c1', videoId: 'ep-1', clip: { kind: 'audio', file: 'ep-1_1.00.m4a', from: 1 } },
      { id: 'c2', videoId: 'ep-1' },
      { id: 'c3', videoId: 'ep-2', clip: { kind: 'audio', file: 'ep-2_1.00.m4a', from: 1 } },
    ],
    confirmKeepClips: n => {
      order.push(`confirmKeepClips:${n}`);
      return true;
    },
    stopJob: async id => { order.push(`stopJob:${id}`); },
    cancelRustImport: async id => { order.push(`cancelRust:${id}`); },
    deleteVideoRecord: async id => { order.push(`1.deleteRecord:${id}`); },
    deleteVideoCards: async (id, keep) => {
      keepFlagPassed = keep;
      order.push(`2.deleteCards:${id}:${keep}`);
      return keep ? ['c1', 'c2'] : [];
    },
    keepOrphans: ids => {
      keptPassed = ids;
      order.push(`2b.keepOrphans:${ids.join(',')}`);
    },
    forgetVideoLocal: id => { order.push(`3a.forgetLocal:${id}`); },
    releaseSrc: id => { order.push(`3b.releaseSrc:${id}`); },
    deleteAudio: async id => { order.push(`3c.deleteAudio:${id}`); },
    deleteCache: async id => { order.push(`3d.deleteCache:${id}`); },
    purgeFiles: async id => { order.push(`4.purgeFiles:${id}`); return 3; },
  });

  assert.equal(ok, true);
  assert.equal(keepFlagPassed, true);
  assert.deepEqual(keptPassed, ['c1', 'c2']);
  assert.deepEqual(order, [
    'confirmKeepClips:1',
    'stopJob:ep-1',
    'cancelRust:ep-1',
    '1.deleteRecord:ep-1',
    '2.deleteCards:ep-1:true',
    '2b.keepOrphans:c1,c2',
    '3a.forgetLocal:ep-1',
    '3b.releaseSrc:ep-1',
    '3c.deleteAudio:ep-1',
    '3d.deleteCache:ep-1',
    '4.purgeFiles:ep-1',
  ]);

  // Hung stopJob must not deadlock deletion (bounded by stopTimeoutMs).
  const t0 = Date.now();
  let purged = false;
  await M.runDeleteAndroidRecord('ep-hang', {
    outsideRestore: async fn => fn(),
    getAllCards: async () => [],
    confirmKeepClips: () => { throw new Error('must not prompt without clips'); },
    stopJob: () => new Promise(() => {}),
    cancelRustImport: () => new Promise(() => {}),
    deleteVideoRecord: async () => {},
    deleteVideoCards: async () => [],
    keepOrphans: () => {},
    forgetVideoLocal: () => {},
    releaseSrc: () => {},
    deleteAudio: async () => {},
    deleteCache: async () => {},
    purgeFiles: async () => { purged = true; return 1; },
    stopTimeoutMs: 40,
  });
  assert.equal(purged, true);
  assert.ok(Date.now() - t0 < 500, 'timeout must release deletion promptly');

  // When restore holds lock, outsideRestore skips and nothing is touched.
  let touched = false;
  const skipped = await M.runDeleteAndroidRecord('ep-locked', {
    outsideRestore: async (_fn, skip) => skip,
    getAllCards: async () => { touched = true; return []; },
    confirmKeepClips: () => false,
    cancelRustImport: async () => { touched = true; },
    deleteVideoRecord: async () => { touched = true; },
    deleteVideoCards: async () => [],
    keepOrphans: () => {},
    forgetVideoLocal: () => {},
    releaseSrc: () => {},
    deleteAudio: async () => {},
    deleteCache: async () => {},
    purgeFiles: async () => 0,
  });
  assert.equal(skipped, false);
  assert.equal(touched, false);
}

// Cards saved a moment ago get their clip cut before counting, so "keep the cards" covers them.
{
  let cut = false;
  let asked = 0;
  await M.runDeleteAndroidRecord('ep-fresh', {
    outsideRestore: async fn => fn(),
    clipNow: async () => { cut = true; return 1; },
    getAllCards: async () => [{ id: 'c1', videoId: 'ep-fresh', ...(cut ? { clip: { kind: 'audio', file: 'ep-fresh_1.00.m4a', from: 1 } } : {}) }],
    confirmKeepClips: n => { asked = n; return true; },
    cancelRustImport: async () => {},
    deleteVideoRecord: async () => {},
    deleteVideoCards: async () => ['c1'],
    keepOrphans: () => {},
    forgetVideoLocal: () => {},
    releaseSrc: () => {},
    deleteAudio: async () => {},
    deleteCache: async () => {},
    purgeFiles: async () => 0,
  });
  assert.equal(asked, 1, 'a card clipped just before delete must be offered for keeping');
}

// --- 5. Startup orphan sweep 6 safety invariants ---
{
  let rustCalls = 0;
  let lastArgs = null;
  const baseDeps = {
    outsideRestore: async fn => fn(),
    hasPendingRestore: () => false,
    getAllVideos: async () => [
      { id: 'v1' },
      { id: 'v2', importJob: { stage: 'cloud', source: 'https://x/2.mp3' } },
    ],
    readAllCards: async () => ({
      cards: [
        { id: 'c1', videoId: 'v1' },
        { id: 'c2', videoId: 'v-kept-clip' },
        { id: 'c3', videoId: '' },
      ],
    }),
    sweepRust: async (keepIds, activeImportIds) => {
      rustCalls += 1;
      lastArgs = { keepIds: [...keepIds].sort(), activeImportIds: [...activeImportIds].sort() };
      return 2;
    },
    logInfo: () => {},
  };

  // Guard 1: restore lock busy -> skip
  assert.equal(await M.runSweepAndroidOrphans({ ...baseDeps, outsideRestore: async (_fn, skip) => skip }), 0);
  assert.equal(rustCalls, 0);

  // Guard 2: PENDING_KEY present -> skip
  assert.equal(await M.runSweepAndroidOrphans({ ...baseDeps, hasPendingRestore: () => true }), 0);
  assert.equal(rustCalls, 0);

  // Guard 3a: videos DB unreadable -> skip
  assert.equal(await M.runSweepAndroidOrphans({ ...baseDeps, getAllVideos: async () => { throw new Error('idb fail'); } }), 0);
  assert.equal(rustCalls, 0);

  // Guard 3b: review cards DB unreadable -> skip
  assert.equal(await M.runSweepAndroidOrphans({ ...baseDeps, readAllCards: async () => { throw new Error('cards fail'); } }), 0);
  assert.equal(rustCalls, 0);

  // Guard 4: empty video library -> never sweep, log only
  let logged = '';
  assert.equal(
    await M.runSweepAndroidOrphans({
      ...baseDeps,
      getAllVideos: async () => [],
      logInfo: msg => { logged = msg; },
    }),
    0,
  );
  assert.equal(rustCalls, 0);
  assert.match(logged, /empty video library/);

  // Happy path: sends deduped keepIds (all video ids + card videoIds) and activeImportIds
  assert.equal(await M.runSweepAndroidOrphans(baseDeps), 2);
  assert.equal(rustCalls, 1);
  assert.deepEqual(lastArgs, {
    keepIds: ['v-kept-clip', 'v1', 'v2'],
    activeImportIds: ['v2'],
  });
}

console.log('mobile podcast android: all passed');
