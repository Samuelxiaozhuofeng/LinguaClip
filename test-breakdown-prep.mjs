/**
 * Checks "prepare breakdowns": batch answer parsing, which lines get asked
 * about, and cache loading in utils/breakdownPrep.ts. Run with: node test-breakdown-prep.mjs
 *
 * Bundles the real module (stubbing Tauri) instead of re-typing the logic.
 */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = join(tmpdir(), `breakdown-prep-${process.pid}.mjs`);
await build({
  stdin: {
    contents: `export { parseBatchResponse, eligibleLines, parseBreakdownCache, batchPrompt, PREP_BATCH_LINES } from './utils/breakdownPrep.ts';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  outfile: out,
  define: { 'process.env.ROUTER9_BASE_URL': '""', 'process.env.ROUTER9_BASE_KEY': '""' },
  plugins: [{
    name: 'stub-tauri',
    setup(b) {
      b.onResolve({ filter: /^@tauri-apps\// }, a => ({ path: a.path, namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        contents: `const no = () => { throw new Error('tauri'); };
          export const fetch = globalThis.fetch, invoke = no, convertFileSrc = no, open = no, save = no, readTextFile = no,
            exists = no, readFile = no, listen = no, homeDir = no, join = no, getCurrentWebview = no, getCurrentWindow = no, openUrl = no, revealItemInDir = no,
            check = no, relaunch = no, getVersion = no;`,
      }));
    },
  }],
});
const { parseBatchResponse, eligibleLines, parseBreakdownCache, batchPrompt } = await import(out);

const a = 'I was looking for my dog when I saw Mary.'; // 10 words
const b = 'She picked it up at the station yesterday.'; // 8 words
const ok = { lang: 'en', points: [{ from: 1, to: 3, note: 'Was looking for：过去进行时' }] };

// 1. One answer per line, in order; a line that breaks a rule is null, not the batch.
{
  const bad = { lang: 'en', points: [{ from: 0, to: 9, note: 'x' }] }; // whole line
  const res = parseBatchResponse('```json\n' + JSON.stringify({ lines: [ok, bad] }) + '\n```', [a, b]);
  assert.deepEqual(res[0], ok);
  assert.equal(res[1], null);
}

// 1b. Right count but shifted: b's answer lands on a, and its note names
//     words a does not have at those positions, so it is dropped.
{
  const forB = { lang: 'en', points: [{ from: 1, to: 3, note: 'picked it up：短语动词' }] };
  const res = parseBatchResponse(JSON.stringify({ lines: [forB, ok] }), [a, b]);
  assert.equal(res[0], null);
  assert.equal(res[1], null);
  const good = parseBatchResponse(JSON.stringify({ lines: [ok, forB] }), [a, b]);
  assert.deepEqual(good, [ok, forB]);
}

// 2. A wrong number of answers throws: they could be on the wrong lines.
assert.throws(() => parseBatchResponse(JSON.stringify({ lines: [ok] }), [a, b]));
assert.throws(() => parseBatchResponse('sorry', [a, b]));

// 3. Only lines of 5+ words, each asked once, keyed with spaces normalised.
{
  const srt = `1\n00:00:01,000 --> 00:00:02,000\n${a}\n\n2\n00:00:02,000 --> 00:00:03,000\nOh yes.\n\n3\n00:00:03,000 --> 00:00:04,000\n${a.replace(/ /g, '  ')}\n\n4\n00:00:04,000 --> 00:00:05,000\n${b}\n`;
  assert.deepEqual(eligibleLines(srt), [a, b]);
}

// 4. Cache: bad answers inside are dropped, a broken file is no cache.
{
  const raw = JSON.stringify({ v: 1, lang: 'zh', lines: { [a]: ok, [b]: { lang: 'en', points: [] } } });
  const c = parseBreakdownCache(raw);
  assert.equal(c.lang, 'zh');
  assert.deepEqual(Object.keys(c.lines), [a]);
  assert.equal(parseBreakdownCache('{oops'), null);
  assert.equal(parseBreakdownCache(JSON.stringify({ v: 1, lang: 'fr', lines: {} })), null);
  assert.equal(parseBreakdownCache(null), null);
}

// 5. The prompt numbers every line and asks for exactly that many answers.
{
  const p = batchPrompt([a, b], 'zh');
  assert.match(p, /lines 的长度必须等于 2/);
  assert.match(p, /第 1 句（8 个词）/);
  assert.match(p, /简体中文/);
}

console.log('breakdown prep: all checks passed');
