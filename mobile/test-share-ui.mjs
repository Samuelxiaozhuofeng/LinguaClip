/**
 * Share intake & mobile UI error mapping tests (mobile/shareHelper.ts, mobile/ui.tsx):
 * - Plain-text sanitization (control chars, bidi overrides, length cap, no HTML synthesis)
 * - URL extraction from free-form share copy (Chinese/English punctuation, balanced parens)
 * - ACTION_SEND payload routing (media URI, RSS feed, Apple Podcasts, closed platforms, unsupported)
 * - errText() coverage across all Android & shared error codes in zh & en
 * Run with: node mobile/test-share-ui.mjs
 */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = join(tmpdir(), `mobile-share-ui-${process.pid}.mjs`);
await build({
  stdin: {
    contents: [
      "export * from './mobile/shareHelper';",
      "export { errText } from './mobile/ui';",
      "export { setLang } from './utils/i18n';",
    ].join('\n'),
    resolveDir: '.',
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: out,
  logLevel: 'error',
  plugins: [{
    name: 'stub-http',
    setup(b) {
      b.onResolve({ filter: /^@tauri-apps\/plugin-http$/ }, () => ({ path: 'http', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        contents: 'export const fetch = () => { throw new Error("no network in unit test"); };',
      }));
    },
  }],
});

// Minimal browser globals for utils/i18n setLang
const store = new Map();
globalThis.localStorage = {
  getItem: k => store.get(k) ?? null,
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};
globalThis.document = { documentElement: { lang: 'zh' } };

const {
  sanitizeShareText,
  extractUrlFromShare,
  classifySharePayload,
  shareDedupeKey,
  errText,
  setLang,
} = await import(out);

// 1. Plain-text sanitization (control chars, bidi overrides, truncation, XSS payload stays inert text)
assert.equal(sanitizeShareText('  hello\x00\x07\r\n\tworld\x1b[31m  '), 'hello world[31m');
assert.equal(sanitizeShareText('safe\u202ename.mp3\u2066'), 'safename.mp3');
assert.equal(sanitizeShareText('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>');
assert.equal(sanitizeShareText('a'.repeat(300)).length, 160);
assert.equal(sanitizeShareText('a'.repeat(50), 20).length, 20);
assert.equal(sanitizeShareText(''), '');

// 2. URL extraction from free-form share copy
assert.equal(
  extractUrlFromShare('推荐收听 Coffee Break Spanish https://podcasts.apple.com/cn/podcast/coffee-break-spanish/id201598403，超棒！'),
  'https://podcasts.apple.com/cn/podcast/coffee-break-spanish/id201598403',
);
assert.equal(
  extractUrlFromShare('（https://feeds.megaphone.fm/allearsenglish）'),
  'https://feeds.megaphone.fm/allearsenglish',
);
assert.equal(
  extractUrlFromShare('Check out (https://example.com/show_(en)/feed.xml).'),
  'https://example.com/show_(en)/feed.xml',
);
assert.equal(
  extractUrlFromShare('听一下这个播客 http://example.com/rss.xml。太赞了'),
  'http://example.com/rss.xml',
);
assert.equal(extractUrlFromShare('javascript:alert(1)'), null);
assert.equal(extractUrlFromShare('file:///etc/passwd'), null);
assert.equal(extractUrlFromShare('只是一段普通聊天文字，没有链接'), null);

// 3. SharePayload classification
assert.deepEqual(
  classifySharePayload({ kind: 'uri', uri: 'content://com.android.providers.downloads/document/42', mime: 'audio/mpeg' }),
  { kind: 'media', uri: 'content://com.android.providers.downloads/document/42', mime: 'audio/mpeg' },
);
assert.deepEqual(
  classifySharePayload({ kind: 'uri', uri: '   ', mime: 'audio/mpeg' }),
  { kind: 'unsupported' },
);
assert.deepEqual(
  classifySharePayload({ kind: 'text', mime: 'text/plain', text: '推荐收听 https://podcasts.apple.com/us/podcast/x/id987654?i=10001' }),
  { kind: 'apple', id: '987654' },
);
assert.deepEqual(
  classifySharePayload({ kind: 'text', mime: 'text/plain', text: '分享播客 RSS：https://feeds.megaphone.fm/allearsenglish。' }),
  { kind: 'feed', url: 'https://feeds.megaphone.fm/allearsenglish' },
);
assert.deepEqual(
  classifySharePayload({ kind: 'text', mime: 'text/plain', text: '来听这个 https://open.spotify.com/show/5Y1abc' }),
  { kind: 'closed', name: 'Spotify' },
);
assert.deepEqual(
  classifySharePayload({ kind: 'text', mime: 'text/plain', text: '分享小宇宙单集 https://www.xiaoyuzhoufm.com/episode/abc123' }),
  { kind: 'closed', name: '小宇宙' },
);
assert.deepEqual(
  classifySharePayload({ kind: 'text', mime: 'text/plain', text: '喜马拉雅 https://www.ximalaya.com/sound/123' }),
  { kind: 'closed', name: '喜马拉雅' },
);
assert.deepEqual(
  classifySharePayload({ kind: 'text', mime: 'text/plain', text: '这是一段不能导入的文本' }),
  { kind: 'unsupported' },
);
assert.deepEqual(
  classifySharePayload({ kind: 'text', mime: 'text/plain', text: 'javascript:alert(1)' }),
  { kind: 'unsupported' },
);
assert.deepEqual(classifySharePayload(null), { kind: 'unsupported' });

// 4. Dedupe key stability
assert.equal(
  shareDedupeKey({ kind: 'uri', uri: 'content://a/1', mime: 'audio/mp4' }),
  shareDedupeKey({ kind: 'uri', uri: ' content://a/1 ', mime: 'video/mp4' }),
);
assert.notEqual(
  shareDedupeKey({ kind: 'uri', uri: 'https://a.com/rss', mime: 'audio/mp4' }),
  shareDedupeKey({ kind: 'text', text: 'https://a.com/rss', mime: 'text/plain' }),
);

// 5. errText() full Android & shared error mapping (zh & en)
for (const lang of ['zh', 'en']) {
  setLang(lang);
  const ac3 = errText('audio:unsupported_codec:audio/ac3');
  assert.ok(ac3.includes('AC-3'), `[${lang}] expected AC-3 in "${ac3}"`);
  assert.ok(!/\{[a-z]+\}/i.test(ac3), `[${lang}] unreplaced placeholder in "${ac3}"`);

  const eac3 = errText('audio:unsupported_codec:audio/eac3');
  assert.ok(eac3.includes('E-AC-3'), `[${lang}] expected E-AC-3 in "${eac3}"`);

  const dts = errText('audio:unsupported_codec:audio/vnd.dts');
  assert.ok(dts.includes('DTS'), `[${lang}] expected DTS in "${dts}"`);

  const dl = errText('download:HTTP 403');
  assert.ok(dl.includes('HTTP 403'), `[${lang}] expected download detail in "${dl}"`);

  const codes = [
    'audio:no_track',
    'audio:reimport',
    'cloud:missing-url',
    'cancelled',
    'srt:empty',
    'podcast:format',
    'file:toolarge',
    'cloud:nokey',
    'interrupted',
    'audio:missing',
    'cloud:toolarge',
    'cloud:nomedia',
    'cloud:key',
    'cloud:empty',
    'cloud:quota:429',
    'cloud:denied:403',
    'cloud:network:timeout',
    'cloud:unexpected_err',
  ];
  for (const code of codes) {
    const msg = errText(code);
    assert.ok(typeof msg === 'string' && msg.length > 0, `[${lang}] empty errText for ${code}`);
    assert.ok(!/\{[a-z]+\}/i.test(msg), `[${lang}] unreplaced placeholder for ${code}: ${msg}`);
  }
  assert.equal(errText('podcast:format'), errText('cloud:nomedia'), `[${lang}] podcast:format maps to m.errNoMedia`);
}

console.log('mobile/test-share-ui.mjs ok');
