/**
 * Checks "break it down": the AI-answer checks and step building in
 * utils/aiDrills.ts. Run with: node test-breakdown.mjs
 *
 * Bundles the real module (stubbing Tauri's fetch) instead of re-typing the logic.
 */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = join(tmpdir(), `breakdown-${process.pid}.mjs`);
await build({
  stdin: {
    contents: `
      export { validateBreakdown, parseBreakdownResponse, buildSteps, spaceWords } from './utils/aiDrills.ts';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
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
const { validateBreakdown, parseBreakdownResponse, buildSteps, spaceWords } = await import(out);

const line = 'I was looking for my dog when I saw Mary.';
const n = spaceWords(line).length; // 10
const pt = (from, to, note = 'x') => ({ from, to, note });

// 1. Points become steps in sentence order, then the whole line; punctuation
//    stays on its word, and only the whole line has no note.
{
  assert.equal(n, 10);
  const steps = buildSteps(line, [pt(1, 3, 'was looking for'), pt(6, 9, 'when')]);
  assert.deepEqual(steps.map(s => s.text), ['was looking for', 'when I saw Mary.', line]);
  assert.deepEqual(steps.map(s => s.note), ['was looking for', 'when', null]);
  assert.deepEqual(buildSteps(line, [pt(0, 0)]).map(s => s.text), ['I', line]);
  assert.deepEqual(spaceWords('  ¿cómo   estás en U.S.A.? '), ['¿cómo', 'estás', 'en', 'U.S.A.?']);
}

// 2. The AI answer is checked rule by rule; any broken rule throws it out.
{
  const ok = { lang: 'en', points: [pt(1, 3, ' a '), pt(6, 9, 'b')] };
  assert.deepEqual(validateBreakdown(ok, n), { lang: 'en', points: [pt(1, 3, 'a'), pt(6, 9, 'b')] });
  assert.deepEqual(validateBreakdown({ lang: 'es', points: [pt(0, 5)] }, n), { lang: 'es', points: [pt(0, 5)] });
  const bad = {
    noLang: { points: [pt(1, 3)] },
    longLang: { lang: 'eng', points: [pt(1, 3)] },
    upperLang: { lang: 'EN', points: [pt(1, 3)] },
    noPoints: { lang: 'en', points: [] },
    fourPoints: { lang: 'en', points: [pt(0, 0), pt(2, 2), pt(4, 4), pt(6, 6)] },
    overlap: { lang: 'en', points: [pt(1, 3), pt(3, 5)] },
    outOfOrder: { lang: 'en', points: [pt(6, 9), pt(1, 3)] },
    backwards: { lang: 'en', points: [pt(3, 1)] },
    pastEnd: { lang: 'en', points: [pt(8, 10)] },
    negative: { lang: 'en', points: [pt(-1, 2)] },
    notInteger: { lang: 'en', points: [pt(1, 2.5)] },
    stringIndex: { lang: 'en', points: [{ from: '1', to: 3, note: 'x' }] },
    tooLong: { lang: 'en', points: [pt(0, 6)] },
    emptyNote: { lang: 'en', points: [pt(1, 3, '  ')] },
    noNote: { lang: 'en', points: [{ from: 1, to: 3 }] },
    nullPoint: { lang: 'en', points: [null] },
    notObject: [1, 3],
  };
  for (const [name, value] of Object.entries(bad)) {
    assert.equal(validateBreakdown(value, n), null, `should reject: ${name}`);
  }
  // A point may not be the whole line (the whole line is the last step anyway).
  assert.equal(validateBreakdown({ lang: 'en', points: [pt(0, 4)] }, 5), null);
  assert.deepEqual(validateBreakdown({ lang: 'en', points: [pt(0, 3)] }, 5), { lang: 'en', points: [pt(0, 3)] });
  assert.deepEqual(
    parseBreakdownResponse('Sure:\n```json\n{"lang":"en","points":[{"from":1,"to":3,"note":"looking for = 寻找"}]}\n```', n),
    { lang: 'en', points: [pt(1, 3, 'looking for = 寻找')] },
  );
  assert.equal(parseBreakdownResponse('no json here', n), null);
  assert.equal(parseBreakdownResponse('{"lang":"en","points":[', n), null);
}

// 3. Sounds: missing stays missing (an older cache → asked later), a bad list
//    only costs the sounds ([] = do not ask again), bad points still lose it all.
{
  const points = [pt(1, 3)];
  const missing = validateBreakdown({ lang: 'en', points }, n);
  assert.deepEqual(missing, { lang: 'en', points });
  assert.equal('sounds' in missing, false);
  assert.deepEqual(validateBreakdown({ lang: 'en', points, sounds: [] }, n).sounds, []);
  assert.deepEqual(
    validateBreakdown({ lang: 'en', points, sounds: [pt(1, 2, ' was → wuz '), pt(3, 4, 'b')] }, n).sounds,
    [pt(1, 2, 'was → wuz'), pt(3, 4, 'b')],
  );
  // may cover the whole line when it is short enough
  assert.deepEqual(validateBreakdown({ lang: 'en', points: [pt(0, 3)], sounds: [pt(0, 4)] }, 5).sounds, [pt(0, 4)]);
  const badSounds = {
    pastEnd: [pt(8, 10)],
    overlap: [pt(1, 3), pt(3, 4)],
    tooLong: [pt(0, 6)],
    emptyNote: [pt(1, 2, ' ')],
    fourSounds: [pt(0, 0), pt(2, 2), pt(4, 4), pt(6, 6)],
    notArray: 'x',
    nullValue: null,
  };
  for (const [name, sounds] of Object.entries(badSounds)) {
    assert.deepEqual(validateBreakdown({ lang: 'en', points, sounds }, n), { lang: 'en', points, sounds: [] }, `sounds should be []: ${name}`);
  }
  assert.equal(validateBreakdown({ lang: 'en', points: [pt(3, 1)], sounds: [pt(1, 2)] }, n), null);
}

console.log('breakdown: all checks passed');
