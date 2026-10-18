/**
 * Checks utils/wordVoice.ts: read-aloud word sound — one request per word, failures not kept, the 2 s cap, no voice = null.
 * Run with: node test-wordvoice.mjs
 *
 * Bundles the real module (Tauri, the video store and language guessing stubbed out).
 */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
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
      b.onResolve({ filter: /\/(desktop|videoStorage|deckLang)$/ }, a => ({ path: a.path, namespace: 'stub' }));
      b.onLoad({ filter: /desktop$/, namespace: 'stub' }, () => ({ contents: 'export const synthesizeSpeech = (...a) => globalThis.__tts(...a);' }));
      b.onLoad({ filter: /deckLang$/, namespace: 'stub' }, () => ({ contents: "export const videoLang = r => r.lang ?? 'other';" }));
      b.onLoad({ filter: /videoStorage$/, namespace: 'stub' }, () => ({ contents: 'export const getVideoRecord = async id => globalThis.__rec[id] ?? null;' }));
    },
  }],
});
globalThis.__rec = { a: { id: 'a', lang: 'en' }, x: { id: 'x', lang: 'sv' } };
const calls = [];
let reply = async () => new Uint8Array([1, 2, 3]).buffer;
globalThis.__tts = (text, voice) => { calls.push(`${voice}|${text}`); return reply(); };
const { voiceBytes, wordVoiceUrl, wordVoiceB64 } = await import(out);

// Same word asked twice → one request.
const [u1, u2] = await Promise.all([wordVoiceUrl('car', 'a'), wordVoiceUrl('car', 'a')]);
assert.ok(u1 && u1 === u2);
assert.deepEqual(calls, ['en-US-JennyNeural|car']);
assert.equal(await wordVoiceB64('car', 'a'), 'AQID');
assert.equal(calls.length, 1);

// A failure isn't kept: the next ask tries again.
reply = async () => null;
assert.equal(await voiceBytes('bus', 'en'), null);
reply = async () => new Uint8Array([9]).buffer;
assert.ok(await voiceBytes('bus', 'en'));
assert.equal(calls.filter(c => c.endsWith('|bus')).length, 2);

// Slower than the wait → null, but the request finishes into the cache.
reply = () => new Promise(r => setTimeout(() => r(new Uint8Array([7]).buffer), 80));
assert.equal(await wordVoiceUrl('slow', 'a', 20), null);
await new Promise(r => setTimeout(r, 100));
const n = calls.length;
assert.ok(await wordVoiceUrl('slow', 'a', 20));
assert.equal(calls.length, n);

// No voice for the language / no record → null, no request.
assert.equal(await wordVoiceUrl('hej', 'x'), null);
assert.equal(await wordVoiceUrl('car', 'gone'), null);
assert.equal(await wordVoiceB64('hej', 'x'), undefined);
assert.ok(!calls.some(c => c.endsWith('|hej')));

console.log('wordVoice: all checks passed');
