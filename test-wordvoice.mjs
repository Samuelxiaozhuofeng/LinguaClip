/**
 * Checks utils/wordVoice.ts and utils/dictVoice.ts: dictionary recording first, then read aloud, then null;
 * the 2 s wait, what is remembered, a minute of quiet when offline; and the three page parsers.
 * Run with: node test-wordvoice.mjs
 *
 * Bundles the real modules (Tauri, the video store and language guessing stubbed out). The parsers use
 * DOMParser, so they run in headless Chrome through the e2e Playwright (~/.cache/linguaclip-e2e).
 * Page fixtures are trimmed real pages (2026-10-19).
 */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const out = join(tmpdir(), `wordvoice-${process.pid}.mjs`);
await build({
  entryPoints: ['utils/wordVoice.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: out,
  external: ['@tauri-apps/*'],
  plugins: [{
    name: 'stub',
    setup(b) {
      b.onResolve({ filter: /\/(desktop|videoStorage|deckLang|dictVoice)$/ }, a => ({ path: a.path, namespace: 'stub' }));
      b.onLoad({ filter: /desktop$/, namespace: 'stub' }, () => ({ contents: 'export const synthesizeSpeech = (...a) => globalThis.__tts(...a);' }));
      b.onLoad({ filter: /dictVoice$/, namespace: 'stub' }, () => ({ contents: 'export const dictVoice = (...a) => globalThis.__dict(...a);' }));
      b.onLoad({ filter: /deckLang$/, namespace: 'stub' }, () => ({ contents: "export const videoLang = r => r.lang ?? 'other';" }));
      b.onLoad({ filter: /videoStorage$/, namespace: 'stub' }, () => ({ contents: 'export const getVideoRecord = async id => globalThis.__rec[id] ?? null;' }));
    },
  }],
});
globalThis.__rec = { a: { id: 'a', lang: 'en' }, x: { id: 'x', lang: 'sv' } };
const buf = (...b) => new Uint8Array(b).buffer;
const later = (ms, v) => new Promise(r => setTimeout(() => r(typeof v === 'function' ? v() : v), ms));
const calls = [];
let dictReply = async () => 'none';
let ttsReply = async () => buf(1, 2, 3);
globalThis.__dict = (w, lang) => { calls.push(`dict|${lang}|${w}`); return dictReply(w); };
globalThis.__tts = (text, voice) => { calls.push(`${voice}|${text}`); return ttsReply(text); };
const { createVoices, wordVoiceUrl, wordVoiceB64 } = await import(out);

// --- the real module: no recording → read aloud; one request per word ---
const [u1, u2] = await Promise.all([wordVoiceUrl('car', 'a', 2000), wordVoiceUrl('car', 'a', 2000)]);
assert.ok(u1 && u1 === u2);
assert.deepEqual(calls, ['dict|en|car', 'en-US-JennyNeural|car']);
assert.equal(await wordVoiceB64('car', 'a'), 'AQID');
assert.equal(calls.length, 2, "'none' is remembered");
// A recording wins over reading aloud.
dictReply = async () => buf(9, 9);
assert.equal(await wordVoiceB64('dog', 'a'), 'CQk=');
// No source / voice for the language, or no record → null, nothing asked of read aloud.
dictReply = async () => 'none'; // what dictVoice says for a language without sources
assert.equal(await wordVoiceUrl('hej', 'x', 2000), null);
assert.equal(await wordVoiceUrl('car', 'gone', 2000), null);
assert.ok(!calls.some(c => c.includes('Neural|hej')));

// --- the order, with fakes ---
const fake = () => {
  const log = [];
  const f = { dict: async () => 'none', tts: async () => buf(2) };
  let t = 0;
  const pick = createVoices(
    (w, l) => { log.push(`d|${w}`); return f.dict(w, l); },
    (w, l) => { log.push(`t|${w}`); return f.tts(w, l); },
    () => t,
  );
  return { log, f, pick, tick: ms => { t += ms; } };
};
const first = v => v && new Uint8Array(v)[0];
{
  const { f, pick } = fake();
  f.dict = async () => buf(1);
  assert.equal(first(await pick('a', 'en', 2000)), 1, 'recording → recording');
  f.dict = async () => 'none';
  assert.equal(first(await pick('b', 'en', 2000)), 2, 'no recording → read aloud');
  f.dict = async () => 'none'; f.tts = async () => 'none';
  assert.equal(await pick('c', 'en', 2000), null, 'neither → null');
}
{ // Recording slow (300), read aloud quick (50), wait 200 → read aloud; the recording lands in the cache later.
  const { f, pick, log } = fake();
  f.dict = () => later(300, buf(1)); f.tts = () => later(50, buf(2));
  const t0 = performance.now();
  assert.equal(first(await pick('w', 'en', 200)), 2);
  assert.ok(performance.now() - t0 >= 190, 'waits for the recording until waitMs');
  await later(150);
  assert.equal(first(await pick('w', 'en', 200)), 1, 'late recording used next time');
  assert.equal(log.length, 2, 'no second request');
}
{ // Recording quick, read aloud still out → recording at once.
  const { f, pick } = fake();
  f.dict = () => later(10, buf(1)); f.tts = () => later(500, buf(2));
  const t0 = performance.now();
  assert.equal(first(await pick('q', 'en', 2000)), 1);
  assert.ok(performance.now() - t0 < 300);
}
{ // Nothing back by waitMs → null.
  const { f, pick } = fake();
  f.dict = () => later(300, 'none'); f.tts = () => later(300, buf(2));
  assert.equal(await pick('z', 'en', 50), null);
}
{ // An error isn't remembered; 'none' is.
  const { f, pick, log } = fake();
  f.dict = async () => 'error';
  await pick('e', 'en', 2000); await later(1); await pick('e', 'en', 2000);
  assert.equal(log.filter(l => l === 'd|e').length, 2);
  f.dict = async () => 'none';
  await pick('n', 'en', 2000); await later(1); await pick('n', 'en', 2000);
  assert.equal(log.filter(l => l === 'd|n').length, 1);
  assert.equal(log.filter(l => l === 't|n').length, 1, 'read aloud kept too');
}
{ // Both unreachable → null, then a minute without asking; after it, asked again.
  const { f, pick, log, tick } = fake();
  f.dict = async () => 'error'; f.tts = async () => 'error';
  assert.equal(await pick('o', 'en', 2000), null);
  await later(1);
  const n = log.length;
  tick(59_000);
  assert.equal(await pick('p', 'en', 2000), null);
  assert.equal(log.length, n, 'quiet inside the minute');
  tick(2_000);
  await pick('p', 'en', 2000);
  assert.equal(log.length, n + 2, 'asked again after it');
}
{ // Only one side unreachable → not offline.
  const { f, pick, log } = fake();
  f.dict = async () => 'error'; f.tts = async () => buf(2);
  assert.equal(first(await pick('h', 'en', 2000)), 2);
  await later(1);
  const n = log.length;
  await pick('i', 'en', 2000);
  assert.equal(log.length, n + 2);
}

// --- page parsers, in Chrome ---
const PW = join(homedir(), '.cache/linguaclip-e2e');
assert.ok(existsSync(join(PW, 'node_modules/playwright')), `Playwright missing: run node dev/e2e/run.mjs once (installs into ${PW})`);
const iife = (await build({
  entryPoints: ['utils/dictVoice.ts'], bundle: true, format: 'iife', globalName: 'DV', write: false,
  plugins: [{ name: 'stub', setup(b) {
    b.onResolve({ filter: /\/dictionary$/ }, a => ({ path: a.path, namespace: 'stub' }));
    b.onLoad({ filter: /dictionary$/, namespace: 'stub' }, () => ({ contents: 'export const get = (...a) => window.__get(...a), EUDIC_HOST = { es: "https://www.esdict.cn" }, pickEudicTerms = () => [];' }));
  } }],
})).outputFiles[0].text;
const { chromium } = createRequire(join(PW, 'package.json'))('playwright');
const browser = await chromium.launch({ channel: 'chrome' });
try {
  const page = await browser.newPage();
  await page.addScriptTag({ content: iife });
  const run = (fn, html, word) => page.evaluate(([f, h, w]) => window.DV[f](h, w), [fn, html, word]);

  const wotd = `<div class="wotd"><p class="wotd-hw"><a href="/dictionary/english/hack">hack</a></p>
    <span class="us dpron-i "><span class="daud"><audio class="hdn"><source type="audio/mpeg" src="/media/english/us_pron/h/hac/hack_/hack.mp3"/><source type="audio/ogg" src="/media/english/us_pron_ogg/h/hac/hack_/hack.ogg"/></audio></span></span></div>`;
  const entry = (pron) => `<div class="pr dictionary" data-id="cald4"><div class="entry-body"><div class="pr entry-body__el">${pron}</div></div></div>`;
  const uk = `<span class="uk dpron-i "><span class="daud"><audio><source type="audio/mpeg" src="/media/english/uk_pron/u/ukh/ukhef/ukheft_029.mp3"/></audio></span></span>`;
  const us = `<span class="us dpron-i "><span class="daud"><audio><source type="audio/mpeg" src="/media/english/us_pron/h/hel/hello/hello.mp3"/></audio></span></span>`;
  assert.equal(await run('cambridgeAudio', wotd + entry(uk + us) + wotd), 'https://dictionary.cambridge.org/media/english/us_pron/h/hel/hello/hello.mp3');
  assert.equal(await run('cambridgeAudio', entry(uk) + wotd), 'https://dictionary.cambridge.org/media/english/uk_pron/u/ukh/ukhef/ukheft_029.mp3', 'no US → UK, still not the Word of the Day');
  assert.equal(await run('cambridgeAudio', `<html><body>${wotd}</body></html>`), null, 'Word of the Day alone → null');
  assert.equal(await run('cambridgeAudio', entry(us.replace('/media/', 'https://evil.example/media/'))), null, 'other host → null');

  const gv = id => `<a class="gv-voice voice-button" data-rel="https://fs-gateway.frdic.com/buckets/main/wordmp3/${id}.mp3"></a>`;
  const vjs = `<a href="#" title="真人发音" class="voice-js voice-button" data-rel="langid=es&txt=QYNaGFibGFy"></a>`;
  assert.equal(await run('eudicAudio', `<div>${vjs}<span class="Phonitic">[aˈβlaɾ]</span></div><div id="ExpFCChild">${gv('f0752c2a-7cfe-4f1b-8303-474857e26756')}${gv('f06fcaec-e936-4a21-b303-4d96ac0fc740')}</div>`),
    'https://fs-gateway.frdic.com/buckets/main/wordmp3/f0752c2a-7cfe-4f1b-8303-474857e26756.mp3');
  assert.equal(await run('eudicAudio', `<div>${vjs}</div>`), null, '.voice-js is not taken');
  assert.equal(await run('eudicAudio', `<a class="gv-voice" data-rel="https://evil.example/x.mp3"></a>`), null);
  assert.equal(await run('eudicAudio', `<a class="gv-voice" data-rel="http://fs-gateway.frdic.com/buckets/main/wordmp3/a.mp3"></a>`), null, 'http → null');

  const neko = `<audio id="audio_猫:ねこ" preload="none"><source src="//d1vjc5dkcd3yh2.cloudfront.net/audio_ogg/6b96f918b54d9a75a6bd12a8fb98c48e.ogg" type="audio/ogg"><source src="//d1vjc5dkcd3yh2.cloudfront.net/audio/6b96f918b54d9a75a6bd12a8fb98c48e.mp3" type="audio/mpeg"></audio>`;
  const NEKO = 'https://d1vjc5dkcd3yh2.cloudfront.net/audio/6b96f918b54d9a75a6bd12a8fb98c48e.mp3';
  assert.equal(await run('jishoAudio', neko, '猫'), NEKO);
  assert.equal(await run('jishoAudio', neko, 'ねこ'), NEKO, 'kana search matches the reading');
  assert.equal(await run('jishoAudio', `<div class="concept_light"><span class="text">行方</span></div>` + neko.replace('猫:ねこ', '行方:ゆくえ'), '行く'), null, "another entry's recording is not this word's");
  assert.equal(await run('jishoAudio', `<div class="concept_light"><span class="text">憂鬱</span></div>`, '憂鬱'), null);
  assert.equal(await run('jishoAudio', `<audio id="audio_猫:ねこ"><source src="//evil.example/audio/a.mp3"></audio>`, '猫'), null);

  // Youdao: only its "returned null audio" 500 means no recording; another 500 is the service down (asked again later).
  const youdao500 = body => page.evaluate(async b => {
    window.__get = async url => {
      if (url.includes('/dicts/prefix/')) return new Response('[]');
      throw Object.assign(new Error('HTTP 500'), { status: 500, res: new Response(b) });
    };
    return window.DV.dictVoice('qwxzvbnm', 'es');
  }, body);
  assert.equal(await youdao500('{"status":500,"msg":"returned null audio","path":"/dictvoice"}'), 'none');
  assert.equal(await youdao500('<html>Internal Server Error</html>'), 'error', 'other 500 → error, not remembered as none');
} finally {
  await browser.close();
}

console.log('wordVoice: all checks passed');
