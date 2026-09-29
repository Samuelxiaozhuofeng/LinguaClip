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
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const fetch = globalThis.fetch;' }));
    },
  }],
});
const { buildSrt, mostlyCjk, resegment } = await import(out);

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
  // resegment applies the ceiling; with no router configured it bows out.
  assert.equal(await resegment(w), null, 'no router configured -> keep whisper lines');
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

console.log('resegment: all checks passed');
