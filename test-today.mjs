/**
 * Checks the per-day practice record in utils/today.ts (docs/stats.md): the 30-day
 * trim, a broken record starting over, picking up the old one-day key, getDays' shape.
 * Run with: node test-today.mjs
 *
 * Bundles the real module (same as the other test-*.mjs) so this fails when it drifts.
 */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let store = {};
globalThis.localStorage = { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } };

const out = join(tmpdir(), `today-${process.pid}.mjs`);
await build({ entryPoints: ['utils/today.ts'], bundle: true, format: 'esm', outfile: out, logLevel: 'error' });
const T = await import(out);

const at = (y, m, d) => new Date(y, m - 1, d, 12).getTime();
const realNow = Date.now;
const on = (t, fn) => { Date.now = () => t; try { return fn(); } finally { Date.now = realNow; } };
const days = () => JSON.parse(store.linguaclip_days);

// --- countLine writes both keys; today comes from days ---
on(at(2026, 10, 3), () => { T.countLine(); T.countLine(); });
assert.deepEqual(days(), { '2026-10-03': { sec: 0, lines: 2 } });
assert.deepEqual(JSON.parse(store.linguaclip_today), { date: '2026-10-03', sec: 0, lines: 2 }, 'old key still written');
assert.equal(T.getToday(at(2026, 10, 3)).lines, 2);

// --- trim keeps the latest 30 by date ---
store = {};
const many = {};
for (let i = 1; i <= 35; i++) many[new Date(2026, 0, i, 12).toLocaleDateString('sv')] = { sec: i, lines: 0 };
store.linguaclip_days = JSON.stringify(many);
on(at(2026, 2, 10), () => T.countLine());
const kept = Object.keys(days()).sort();
assert.equal(kept.length, 30);
assert.equal(kept[0], '2026-01-07', 'oldest dropped first');
assert.equal(kept.at(-1), '2026-02-10', 'today kept');
// clock set back: still the latest 30 by date, so the history isn't wiped
on(at(2025, 6, 1), () => T.countLine());
assert.equal(Object.keys(days()).length, 30);
assert.ok(!('2025-06-01' in days()), 'an older-than-all day is the one trimmed');
assert.ok('2026-02-10' in days());

// --- broken days → starts over, no throw ---
store = { linguaclip_days: '{not json' };
on(at(2026, 10, 3), () => T.countLine());
assert.deepEqual(days(), { '2026-10-03': { sec: 0, lines: 1 } });
store = { linguaclip_days: '[1,2]' };
on(at(2026, 10, 3), () => T.countLine());
assert.deepEqual(days(), { '2026-10-03': { sec: 0, lines: 1 } }, 'non-object starts over too');

// --- upgrade day: days has no today, old key is today → carry on from it ---
store = { linguaclip_today: JSON.stringify({ date: '2026-10-03', sec: 600, lines: 7 }), linguaclip_days: JSON.stringify({ '2026-10-01': { sec: 60, lines: 1 } }) };
assert.deepEqual(T.getToday(at(2026, 10, 3)), { date: '2026-10-03', sec: 600, lines: 7 });
on(at(2026, 10, 3), () => T.countLine());
assert.deepEqual(days()['2026-10-03'], { sec: 600, lines: 8 });
// old key from another day is ignored
store = { linguaclip_today: JSON.stringify({ date: '2026-10-02', sec: 600, lines: 7 }) };
assert.deepEqual(T.getToday(at(2026, 10, 3)), { date: '2026-10-03', sec: 0, lines: 0 });

// --- getDays: n days, oldest first, today last, gaps are zeros ---
store = { linguaclip_days: JSON.stringify({ '2026-09-28': { sec: 120, lines: 3 }, '2026-10-03': { sec: 300, lines: 5 }, '2026-09-01': { sec: 9, lines: 9 } }) };
const w = T.getDays(7, at(2026, 10, 3));
assert.deepEqual(w.map(d => d.date), ['2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03']);
assert.deepEqual(w.map(d => d.sec), [0, 120, 0, 0, 0, 0, 300]);
assert.deepEqual(w.map(d => d.lines), [0, 3, 0, 0, 0, 0, 5]);
assert.equal(T.getDays(3, at(2026, 3, 1)).map(d => d.date).join(), '2026-02-27,2026-02-28,2026-03-01', 'crosses a month');
store = {};
assert.deepEqual(T.getDays(2, at(2026, 10, 3)), [{ date: '2026-10-02', sec: 0, lines: 0 }, { date: '2026-10-03', sec: 0, lines: 0 }], 'empty history');

console.log('today: all checks passed');
