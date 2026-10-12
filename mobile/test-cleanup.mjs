/**
 * The phone's transcript tidy-up (mobile/cleanup.ts) against the desktop's Rust tests
 * (word_order.rs, repeat_fix_tests.rs, cloud_asr.rs punctuate), plus the Groq call's
 * link unwrapping and error codes (mobile/transcribe.ts).
 * Run with: node mobile/test-cleanup.mjs
 */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = join(tmpdir(), `mobile-cleanup-${process.pid}.mjs`);
await build({ stdin: { contents: "export * from './mobile/cleanup'; export * from './mobile/transcribe';", resolveDir: '.', loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error' });
const C = await import(out);

const W = (w, from, to) => ({ w, from, to });
const cue = (from, to, text) => ({ from, to, text });
const texts = c => c.map(x => x.text);
const froms = w => w.map(x => [x.w, x.from]);

// --- word_order.rs ---
{
  const timed = t => t.map((f, i) => W(String(i), f, f + 200));
  assert.deepEqual(froms(C.inOrder(timed([0, 300, 300, 900]))), [['0', 0], ['1', 300], ['2', 300], ['3', 900]]);
  assert.deepEqual(C.inOrder([]), []);

  let w = C.inOrder(timed([1000, 1500, 1300, 1200, 2000]));
  assert.deepEqual(froms(w), [['0', 1000], ['1', 1500], ['2', 1500], ['3', 1500], ['4', 2000]]);
  assert.ok(w.every(x => x.to >= x.from));

  const t = [348_720, 351_520, 356_940, 374_420, 374_660, 374_880, 375_000, 375_200, 367_480, 371_840, 372_480, 372_620, 373_920, 374_380, 374_660, 374_960, 375_180, 376_020];
  w = C.inOrder(timed(t));
  assert.ok(w.every((x, i) => i === 0 || x.from >= w[i - 1].from));
  assert.ok(w.length >= t.length - 6);
  assert.equal(w.at(-1).from, 376_020);

  const many = [...Array(30).keys()].map(i => i * 500).concat([...Array(25).keys()].map(i => 900_000 + i * 500), [...Array(100).keys()].map(i => (i + 30) * 500));
  w = C.inOrder(timed(many));
  assert.equal(w.length, 130);
  assert.ok(w.every(x => x.from < 900_000));

  w = C.inOrder(timed([10_000, 10_500, 11_000, 11_500, 12_000, 12_500, 13_000, 13_500, 500, 14_000]));
  assert.equal(w.length, 9);
  assert.ok(w.every(x => x.w !== '8'));
  assert.deepEqual(froms(C.inOrder(timed([1000, 2000, 900_000, 3000, 4000]))), [['0', 1000], ['1', 2000], ['3', 3000], ['4', 4000]]);
}

// --- repeat_fix_tests.rs (the keep-one-copy half) ---
{
  let c = [cue(0, 9000, 'Well I know, I know, I know, I know, I know you.')];
  assert.deepEqual(C.findLoops(c), [[0, 1]]);
  assert.deepEqual(texts(C.collapse(c, null).cues), ['Well I know you.']);

  assert.deepEqual(C.findLoops([cue(0, 5000, '我不知道我不知道我不知道我不知道')]), [[0, 1]]);
  assert.deepEqual(C.findLoops([cue(0, 5000, 'ありがとうございますありがとうございますありがとうございますありがとうございます')]), [[0, 1]]);
  assert.deepEqual(texts(C.collapse([cue(0, 5000, '我不知道。我不知道。我不知道。我不知道。')], null).cues), ['我不知道。']);
  c = [0, 1, 2, 3, 4].map(i => cue(i * 2000, i * 2000 + 2000, 'そうですね。'));
  assert.deepEqual(C.findLoops(c), [[0, 5]]);

  for (const t of ['No, no, no.', 'I know, I know, I know.', 'No, no, no, no, no!', '哈哈哈哈哈哈哈哈', 'はいはいはいはい', 'ああああああ', 'hahahahaha']) {
    assert.deepEqual(C.findLoops([cue(0, 1000, t)]), [], t);
  }
  c = [cue(0, 1, 'Let it go, let it go'), cue(1, 2, "Can't hold it back anymore"), cue(2, 3, 'Let it go, let it go'), cue(3, 4, 'Turn away and slam the door'),
    cue(4, 5, 'Let it go, let it go'), cue(5, 6, 'Thank you.'), cue(6, 7, 'Thank you.')];
  assert.deepEqual(C.findLoops(c), []);

  c = [cue(0, 1000, 'Hello there.'), cue(1000, 2000, 'Hello there.'), cue(2000, 3000, 'hello, there'), cue(3000, 4000, 'Bye.')];
  assert.deepEqual(C.findLoops(c), [[0, 3]]);
  let w = [W('Hello', 0, 400), W('there.', 400, 900), W('Hello', 1000, 1400), W('there.', 1400, 1900), W('hello,', 2000, 2400), W('there', 2400, 2900), W('Bye.', 3000, 3500)];
  let r = C.collapse(c, w);
  assert.deepEqual(texts(r.cues), ['Hello there.', 'Bye.']);
  assert.deepEqual(froms(r.words), [['Hello', 0], ['there.', 400], ['Bye.', 3000]]);

  w = [...Array(8).keys()].map(i => W(i % 2 === 0 ? '我不' : '知道', i * 1000, i * 1000 + 900));
  r = C.collapse([cue(0, 8000, '我不知道我不知道我不知道我不知道')], w);
  assert.deepEqual(texts(r.cues), ['我不知道']);
  assert.deepEqual(r.words.map(x => x.w), ['我不', '知道']);

  // redo_replaces_the_stretch_and_failure_keeps_one_copy: with no redo, one copy stays.
  c = [cue(0, 1000, 'Before.'), ...[1, 2, 3, 4, 5, 6].map(i => cue(i * 1000, i * 1000 + 1000, 'Loop line.')), cue(20_000, 21_000, 'After.')];
  w = [W('Before.', 0, 900), W('Loop', 1000, 1500), W('line.', 1500, 1900), W('After.', 20_000, 20_900)];
  r = C.collapse(c, w);
  assert.deepEqual(texts(r.cues), ['Before.', 'Loop line.', 'After.']);
  assert.equal(r.words.length, 4);

  assert.deepEqual(C.key("It's, don’t I'm 'quoted'"), ["it's", "don't", "i'm", 'quoted']);
  assert.equal(C.writeSrt([cue(1000, 2500, 'Hello'), cue(3_723_004, 3_724_000, 'Two\nlines')]),
    '1\n00:00:01,000 --> 00:00:02,500\nHello\n\n2\n01:02:03,004 --> 01:02:04,000\nTwo\nlines\n\n');
}

// --- cloud_asr.rs punctuate ---
{
  const resp = (segs, words) => ({ segments: segs.map(t => ({ start: 0, end: 1, text: t })), words: words.map(([word, start, end]) => ({ word, start, end })) });
  let w = C.punctuate(resp([' ¿Qué tal? Muy bien,', ' gracias.'], [['Qué', 0, 0.2], ['tal', 0.2, 0.4], ['Muy', 0.5, 0.6], ['bien', 0.6, 0.8], ['gracias', 1.0, 1.4]]));
  assert.deepEqual(w.map(x => x.w), ['¿Qué', 'tal?', 'Muy', 'bien,', 'gracias.']);
  assert.deepEqual([w[0].from, w[4].to], [0, 1400]);
  assert.deepEqual(C.punctuate(resp([' I don\'t know.'], [['I', 0, 0.1], ['don', 0.1, 0.2], ["'t", 0.2, 0.3], ['know', 0.3, 0.6]])).map(x => x.w), ['I', "don't", 'know.']);
  w = C.punctuate(resp(['今天天气很好。', '我们走吧！'], [['今天', 0, 0.3], ['天气', 0.3, 0.6], ['很好', 0.6, 0.9], ['我们', 1.0, 1.2], ['走吧', 1.2, 1.5]]));
  assert.deepEqual(w.map(x => x.w), ['今天', '天气', '很好。', '我们', '走吧！']);
  assert.deepEqual([w[4].from, w[4].to], [1200, 1500]);
  assert.deepEqual(C.punctuate(resp([' Hello world.'], [['Hello', 0, 0.5], ['zzz', 0.5, 0.6], ['world', 0.6, 1.0]])).map(x => x.w), ['Hello', 'zzz', 'world.']);

  // The whole tidy-up: a looping line kept once, words with it.
  const all = C.cleanUp({ segments: [{ start: 0, end: 1, text: ' Hi there.' }, { start: 1, end: 2, text: ' Hi there.' }, { start: 2, end: 3, text: ' Hi there.' }, { start: 3, end: 4, text: ' Bye.' }],
    words: [['Hi', 0, 0.4], ['there', 0.4, 0.9], ['Hi', 1, 1.4], ['there', 1.4, 1.9], ['Hi', 2, 2.4], ['there', 2.4, 2.9], ['Bye', 3, 3.5]].map(([word, start, end]) => ({ word, start, end })) });
  assert.deepEqual(texts(all.cues), ['Hi there.', 'Bye.']);
  assert.deepEqual(all.words.map(x => x.w), ['Hi', 'there.', 'Bye.']);
  assert.equal(C.cleanUp({ segments: [], words: [] }).words, null);
}

// --- transcribe.ts: anchor links, error codes ---
{
  const real = 'https://d3ctxlq1ktw2nl.cloudfront.net/staging/2024-1-5/abc.m4a';
  assert.equal(C.anchorUrl(`https://anchor.fm/s/1234abcd/podcast/play/81234567/${encodeURIComponent(real)}`), real);
  assert.equal(C.anchorUrl('https://anchor.fm/s/1234abcd/podcast/rss'), null);
  assert.equal(C.anchorUrl('https://example.com/ep.mp3'), null);
  const sig = new AbortController().signal;
  globalThis.fetch = () => { throw new Error('no fetch for an anchor link'); };
  assert.equal(await C.resolveUrl(`https://anchor.fm/s/x/podcast/play/1/${encodeURIComponent(real)}`, sig), real);
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  assert.equal(await C.resolveUrl('https://example.com/ep.mp3', sig), 'https://example.com/ep.mp3', 'unresolvable: the link itself');

  const store = {};
  globalThis.localStorage = { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = v; } };
  const code = p => p.then(() => 'ok', e => e.message);
  assert.equal(await code(C.transcribe({ url: 'https://x/a.mp3' }, 'en', sig)), 'cloud:nokey');
  store.linguaclip_transcribe_config = JSON.stringify({ mode: 'local', groqKey: 'gsk_test' }); // mode local: the key still counts
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('should not be sent'); };
  assert.equal(await code(C.transcribe({ file: { size: 26214401 }, name: 'big.mp3' }, 'en', sig)), 'file:toolarge');
  assert.equal(calls, 0);
  const answer = (status, body) => async (u) => (String(u).includes('groq') ? new Response(body, { status }) : new Response('', { status: 206 }));
  globalThis.fetch = answer(401, '{"error":{"message":"Invalid API Key"}}');
  assert.equal(await code(C.transcribe({ url: 'https://x/a.mp3' }, 'en', sig)), 'cloud:key');
  globalThis.fetch = answer(400, '{"error":{"message":"media file too large: size limit: 26214400"}}');
  assert.equal(await code(C.transcribe({ url: 'https://x/a.mp3' }, 'en', sig)), 'cloud:toolarge');
  globalThis.fetch = answer(403, '{"error":{"message":"Forbidden"}}');
  assert.equal(await code(C.transcribe({ url: 'https://x/a.mp3' }, 'en', sig)), 'cloud:denied:Forbidden');
  globalThis.fetch = answer(429, '{"error":{"message":"Rate limit"}}');
  assert.equal(await code(C.transcribe({ url: 'https://x/a.mp3' }, 'en', sig)), 'cloud:quota:Rate limit');
  globalThis.fetch = async u => { if (String(u).includes('groq')) throw new TypeError('Failed to fetch'); return new Response(''); };
  assert.equal(await code(C.transcribe({ url: 'https://x/a.mp3' }, 'en', sig)), 'cloud:network:Failed to fetch');
}

console.log('mobile cleanup: all good');
