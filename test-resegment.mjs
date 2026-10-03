/**
 * Checks the line re-cutting maths in utils/resegment.ts.
 * Run with: node test-resegment.mjs
 *
 * It bundles the real module (stubbing Tauri's fetch, which node has no use
 * for) instead of re-typing the logic, so this fails when that file drifts.
 */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = join(tmpdir(), `resegment-${process.pid}.mjs`);
await build({
  entryPoints: ['utils/resegment.ts'],
  bundle: true,
  format: 'esm',
  outfile: out,
  define: { 'process.env.ROUTER9_BASE_URL': '""', 'process.env.ROUTER9_BASE_KEY': '""' },
  plugins: [{
    name: 'stub-tauri-http',
    setup(b) {
      b.onResolve({ filter: /^@tauri-apps\/plugin-http$/ }, a => ({ path: a.path, namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const fetch = (...a) => globalThis.fetch(...a);' }));
    },
  }],
});
const { buildSrt, mostlyCjk, resegment, ruleStarts, enforceCeiling } = await import(out);

const words = (...spec) => spec.map(([w, from, to]) => ({ w, from, to }));

// A line runs on until the next one starts, so a word whose end time whisper
// placed a little early is still inside the clip you hear.
{
  const w = words(['Hoy', 0, 300], ['vamos', 300, 700], ['bien', 700, 1000], ['pero', 3000, 3400]);
  const srt = buildSrt(w, [0, 3]);
  assert.match(srt, /1\n00:00:00,000 --> 00:00:01,400\nHoy vamos bien\n/);
  assert.match(srt, /2\n00:00:03,000 --> 00:00:03,800\npero\n/);
}

// ...but a real pause does not turn into dead air: the run-on is capped.
{
  const w = words(['uno', 0, 200], ['dos', 9000, 9200]);
  const srt = buildSrt(w, [0, 1]);
  assert.match(srt, /00:00:00,000 --> 00:00:00,600\nuno/, 'run-on capped at 400ms');
}

// An over-long line the model failed to cut gets chopped anyway.
{
  const w = words(...Array.from({ length: 40 }, (_, i) => [`w${i}`, i * 100, i * 100 + 90]));
  const srt = await (async () => buildSrt(w, [0]))();
  const lengths = srt.trim().split('\n\n').map(b => b.split('\n')[2].split(' ').length);
  assert.equal(lengths.length, 1, 'buildSrt itself does not chop');
  // No router configured: resegment still cuts (sentence ends + ceiling), no AI asked.
  const cut = (await resegment(w)).trim().split('\n\n').map(b => b.split('\n')[2].split(' ').length);
  assert.ok(cut.length > 1 && cut.every(n => n >= 3 && n <= 16), 'no router -> ceiling still applied');
  assert.equal(cut.reduce((a, b) => a + b, 0), 40, 'no word lost or repeated');
  assert.equal(await resegment([]), null, 'no words -> nothing');
}

// Japanese / Chinese keep whisper's own lines; a stray Latin word does not
// change that, nor a Japanese name in a Spanish video.
{
  assert.equal(mostlyCjk(words(['大', 0, 1], ['人', 1, 2], ['OK', 2, 3])), true);
  assert.equal(mostlyCjk(words(['今天', 0, 1], ['天气', 1, 2], ['很好。', 2, 3])), true);
  assert.equal(mostlyCjk(words(['「好的', 0, 1], ['」「谢谢', 1, 2], ['OK', 2, 3])), true, 'opening quotes still count');
  assert.equal(mostlyCjk(words(['Hoy', 0, 1], ['vamos', 1, 2], ['a', 2, 3], ['東京', 3, 4])), false);
}

// Hours are carried, not dropped, on a long video.
{
  const w = words(['tarde', 3_723_456, 3_723_900]);
  assert.match(buildSrt(w, [0]), /01:02:03,456 --> 01:02:04,300/);
}

// --- Fallbacks when the model fails or leaves a line too long. ---

const plain = (n, from = i => i * 100, name = i => `w${i}`) =>
  Array.from({ length: n }, (_, i) => ({ w: name(i), from: from(i), to: from(i) + 90 }));
const pieces = (starts, count) => starts.map((a, i) => (i + 1 < starts.length ? starts[i + 1] : count) - a);

// A failed batch is cut after every sentence end, covering every word once.
{
  const w = words(['Hola.', 0, 1], ['¿Qué', 1, 2], ['tal?', 2, 3], ['Bien', 3, 4], ['gracias!', 4, 5], ['y', 5, 6]);
  assert.deepEqual(ruleStarts(w), [0, 1, 3, 5]);
  assert.deepEqual(ruleStarts(words(['a.', 0, 1])), [0]);
}

// Too long: cut after the in-sentence comma, even with no pause there.
{
  const w = plain(20, i => i * 100, i => (i === 11 ? 'w11,' : `w${i}`));
  assert.deepEqual(enforceCeiling([0], w), [0, 12]);
  // Comma too near the edge to leave 3 words: ignored, falls through to even cut.
  const edge = plain(20, i => i * 100, i => (i === 0 ? 'w0,' : `w${i}`));
  assert.deepEqual(enforceCeiling([0], edge), [0, 10]);
  // Closing quote after the comma still counts.
  const quoted = plain(20, i => i * 100, i => (i === 7 ? 'dijo,"' : `w${i}`));
  assert.deepEqual(enforceCeiling([0], quoted), [0, 8]);
}

// No punctuation: cut at the longest pause.
{
  const w = plain(20, i => i * 100 + (i >= 6 ? 800 : 0));
  assert.deepEqual(enforceCeiling([0], w), [0, 6]);
}

// Edges: 16 stays, 17 splits into two pieces of >=3, all-zero times and no
// punctuation still terminate, and long runs come out in pieces of 3..16.
{
  assert.deepEqual(enforceCeiling([0], plain(16)), [0]);
  const s17 = enforceCeiling([0], plain(17, () => 0));
  assert.equal(s17.length, 2);
  for (const n of pieces(s17, 17)) assert.ok(n >= 3 && n <= 16);
  for (const n of [17, 18, 33, 100, 251]) {
    for (const from of [() => 0, i => i * 100, i => i * 37 % 500 + i * 100]) {
      const s = enforceCeiling([0], plain(n, from));
      for (const len of pieces(s, n)) assert.ok(len >= 3 && len <= 16, `n=${n} piece ${len}`);
    }
  }
  // A short line next to a long one is left alone.
  assert.deepEqual(enforceCeiling([0, 2], plain(10)), [0, 2]);
}

// End to end with a mocked router: failed batches fall back, two failures in a
// row stop further asking, and the SRT still holds every word in order.
const store = {};
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } },
});
const setAI = segment => {
  store.linguaclip_ai_config = JSON.stringify({ baseUrl: 'http://router.test', apiKey: 'k', model: 'm', limits: { segment } });
};
const firstWord = init => JSON.parse(init.body).messages[0].content.match(/\n0\t(\S+)/)[1];
const ok = starts => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ starts }) } }] }));
const srtWords = srt => srt.trim().split('\n\n').flatMap(b => b.split('\n')[2].split(' '));
const realError = console.error;
let errors = 0;
console.error = () => { errors++; };

{
  // 5 batches of 250, sentence end every 8 words; one at a time.
  setAI(1);
  const w = plain(1250, i => i * 100, i => (i % 8 === 7 ? `w${i}.` : `w${i}`));
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    if (firstWord(init) === 'w0') return ok([0, 10, 20]);
    throw new Error('router down');
  };
  const srt = await resegment(w);
  assert.equal(calls, 1 + 2 + 2, 'batch 1 ok, batches 2-3 fail with a retry each, 4-5 never asked');
  assert.deepEqual(srtWords(srt), w.map(x => x.w), 'every word once, in order');
  assert.ok(srt.startsWith('1\n00:00:00,000 --> 00:00:01,000\nw0 w1 w2 w3 w4 w5 w6 w7. w8 w9\n'), 'AI cuts kept for the good batch');
  assert.ok(srt.includes('\nw256 w257 w258 w259 w260 w261 w262 w263.\n'), 'failed batch cut at sentence ends');
  assert.ok(errors >= 2, 'failures are logged, not swallowed');

  // Everything failing still returns rule-cut lines, not null.
  calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('router down'); };
  const all = await resegment(w);
  assert.equal(calls, 4);
  assert.deepEqual(srtWords(all), w.map(x => x.w));
}

{
  // Side by side (3 at once): batches 1-2 fail fast while batch 3 is still in
  // flight. Batch 3 is left to finish; batches 5-6 never ask.
  setAI(3);
  const w = plain(1500);
  const asked = [];
  globalThis.fetch = async (_url, init) => {
    const first = firstWord(init);
    asked.push(first);
    if (first === 'w500') { await new Promise(r => setTimeout(r, 30)); return ok([0]); }
    throw new Error('router down');
  };
  const srt = await resegment(w);
  assert.ok(asked.includes('w500'), 'in-flight call not cut off');
  assert.ok(!asked.includes('w1000') && !asked.includes('w1250'), 'braked batches skip the AI');
  assert.deepEqual(srtWords(srt), w.map(x => x.w));
}

console.error = realError;

console.log('resegment: all checks passed');
