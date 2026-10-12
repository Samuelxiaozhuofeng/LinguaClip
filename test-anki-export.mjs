/**
 * Checks utils/ankiExport.ts: where each card's sound is cut, and how a batch counts
 * skipped / text-only / refused cards and when it stops (docs/anki-export.md).
 * Run with: node test-anki-export.mjs
 *
 * Bundles the real module; the Anki, cutting and card-writing steps are stand-ins.
 */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = join(tmpdir(), `anki-export-${process.pid}.mjs`);
await build({ entryPoints: ['utils/ankiExport.ts'], bundle: true, format: 'esm', outfile: out, logLevel: 'error', jsx: 'automatic' });
const { cutSpan, toolMissing, runExport } = await import(out);

// --- cut times: padding, offset, never before 0 ---
const pad = { startPadding: 100, endPadding: 200 };
assert.deepEqual(cutSpan({ start: 10, end: 12 }, 0, pad), [9.9, 12.2]);
const [a, b] = cutSpan({ start: 10, end: 12 }, 8.5, pad); // from the card's own clip, which starts at 8.5s
assert.ok(Math.abs(a - 1.4) < 1e-9 && Math.abs(b - 3.7) < 1e-9);
assert.deepEqual(cutSpan({ start: 0.05, end: 2 }, 0, pad), [0, 2.2], 'not before the start');
assert.equal(cutSpan({ start: 1, end: 2 }, 1, pad)[0], 0);

assert.equal(toolMissing('ffmpeg: bad input'), false);
assert.equal(toolMissing('clip: too long'), false);
assert.equal(toolMissing('missing:ffmpeg'), false);
assert.equal(toolMissing('download failed'), true);

// --- a batch ---
const card = (id, more = {}) => ({ id, deck: 'line', videoId: 'v', start: 1, end: 2, text: id, ...more });
const run = async (cards, { media, send, reachable = async () => true, mark, current } = {}) => {
  const sent = [], marked = [], progress = [];
  const r = await runExport(cards, {
    media: media ?? (async c => ({ audio: 'AAA', ext: 'm4a', silent: false })),
    send: send ?? (async (c, m) => { sent.push([c.id, m]); }),
    reachable,
    mark: mark ?? (async id => { marked.push(id); }),
    current: current ?? (async id => cards.find(c => c.id === id) ?? null),
  }, (d, t) => progress.push(`${d}/${t}`));
  return { r, sent, marked, progress };
};

{ // the first card skipped on re-read, the first real send fails and Anki isn't there → stopped
  const cards = [card('a'), card('b'), card('c')];
  const { r } = await run(cards, {
    current: async id => id === 'a' ? { ...cards[0], ankiAt: 9 } : cards.find(c => c.id === id),
    send: async () => { throw new Error('connection refused'); },
    reachable: async () => false,
  });
  assert.deepEqual(r.stopped, { why: 'anki', error: 'connection refused' });
  assert.deepEqual([r.sent, r.refused, r.skipped], [[], 0, 1]);
}

{ // the card store unreadable mid-batch → stop, keeping what already went (and its unmarked count)
  const cards = [card('a'), card('b')];
  const { r } = await run(cards, {
    mark: async () => { throw new Error('quota'); },
    current: async id => { if (id === 'b') throw new Error('io'); return cards[0]; },
  });
  assert.deepEqual([r.sent, r.unmarked, r.stopped], [['a'], 1, { why: 'read', error: 'Error: io' }]);
}

{ // a clip saved after the click is used for the cut; sent from the practice page during the cut → skipped, not sent
  const cards = [card('a'), card('b')];
  let now = { a: cards[0], b: cards[1] };
  const cutFrom = [];
  const { r, sent } = await run(cards, {
    current: async id => now[id],
    media: async c => {
      cutFrom.push(c.clip?.file ?? null);
      if (c.id === 'a') now = { ...now, b: { ...cards[1], clip: { kind: 'audio', file: 'b.m4a', from: 0 } } };
      if (c.id === 'b') now = { ...now, b: { ...now.b, ankiAt: 7 } };
      return { audio: 'AAA', ext: 'm4a', silent: false };
    },
  });
  assert.deepEqual(cutFrom, [null, 'b.m4a'], 'b cut from the clip saved meanwhile');
  assert.deepEqual([sent.map(s => s[0]), r.skipped], [['a'], 1]);
}

{ // sent during a cut that then fails for the tool → skipped, the batch goes on
  const cards = [card('a'), card('b')];
  let now = { a: cards[0], b: cards[1] };
  const { r, sent } = await run(cards, {
    current: async id => now[id],
    media: async c => { if (c.id === 'a') { now = { ...now, a: { ...cards[0], ankiAt: 3 } }; throw 'download failed'; } return { audio: 'AAA', ext: 'm4a', silent: false }; },
  });
  assert.deepEqual([sent.map(s => s[0]), r.skipped, r.stopped], [['b'], 1, undefined]);
}

{ // sent before → skipped, never resent
  const { r, sent, marked, progress } = await run([card('a', { ankiAt: 5 }), card('b'), card('c')]);
  assert.deepEqual(r.sent, ['b', 'c']);
  assert.equal(r.skipped, 1);
  assert.deepEqual(sent.map(s => s[0]), ['b', 'c']);
  assert.deepEqual(marked, ['b', 'c'], 'each marked by its own id');
  assert.deepEqual(progress, ['0/2', '1/2', '2/2']);
}
{ // everything sent before: nothing goes
  const { r, sent } = await run([card('a', { ankiAt: 1 })]);
  assert.deepEqual([r.sent, r.skipped, sent.length], [[], 1, 0]);
}
{ // no sound → text only, counted
  const { r, sent } = await run([card('a'), card('b', { start: -1 })], { media: async c => c.start < 0 ? { silent: true } : { audio: 'X', silent: false } });
  assert.deepEqual(r.sent, ['a', 'b']);
  assert.equal(r.silent, 1);
  assert.equal(sent[1][1].audio, undefined);
}
{ // refused → not marked, the rest go on
  const { r, marked } = await run([card('a'), card('b'), card('c')], { send: async c => { if (c.id === 'b') throw new Error('duplicate'); } });
  assert.deepEqual(r.sent, ['a', 'c']);
  assert.deepEqual(marked, ['a', 'c']);
  assert.equal(r.refused, 1);
  assert.equal(r.stopped, undefined);
}
{ // the first one refused but Anki is there: just refused
  const { r } = await run([card('a'), card('b')], { send: async c => { if (c.id === 'a') throw new Error('no'); } });
  assert.deepEqual([r.sent, r.refused, r.stopped], [['b'], 1, undefined]);
}
{ // the first one fails and Anki isn't there: stop
  let tries = 0;
  const { r, marked } = await run([card('a'), card('b')], { send: async () => { tries++; throw new Error('connection refused'); }, reachable: async () => false });
  assert.equal(tries, 1, 'no hitting it card after card');
  assert.deepEqual(r.stopped, { why: 'anki', error: 'connection refused' });
  assert.deepEqual([r.sent, marked, r.refused], [[], [], 0]);
}
{ // a later failure never stops the batch
  const { r } = await run([card('a'), card('b')], { send: async c => { if (c.id === 'b') throw new Error('gone'); }, reachable: async () => false });
  assert.deepEqual([r.sent, r.refused, r.stopped], [['a'], 1, undefined]);
}
{ // the cutting tool missing: stop, what went stays marked
  const { r, marked } = await run([card('a'), card('b'), card('c')], { media: async c => { if (c.id === 'b') throw 'download failed'; return { silent: false }; } });
  assert.deepEqual(r.sent, ['a']);
  assert.deepEqual(marked, ['a']);
  assert.deepEqual(r.stopped, { why: 'tool', error: 'download failed' });
}

{ // sent from the practice page while the batch ran: re-read shows ankiAt → skipped
  const cs = [card('a'), card('b')];
  const { r, sent } = await run(cs, { current: async id => id === 'b' ? { ...cs[1], ankiAt: 9 } : cs[0] });
  assert.deepEqual([r.sent, r.skipped, sent.map(s => s[0])], [['a'], 1, ['a']]);
}
{ // deleted while the batch ran: not sent, not counted
  const cs = [card('a'), card('b')];
  const { r, sent, progress } = await run(cs, { current: async id => id === 'a' ? null : cs[1] });
  assert.deepEqual([r.sent, r.skipped, r.refused, sent.map(s => s[0])], [['b'], 0, 0, ['b']]);
  assert.deepEqual(progress, ['0/2', '1/2', '2/2']);
}
{ // marking fails: still sent (can be deleted), counted as unmarked
  const { r } = await run([card('a'), card('b')], { mark: async id => { if (id === 'a') throw new Error('db'); } });
  assert.deepEqual([r.sent, r.unmarked], [['a', 'b'], 1]);
}

console.log('anki export: ok');
