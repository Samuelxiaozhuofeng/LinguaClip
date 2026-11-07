/**
 * Checks the hard-subtitle mask's maths and storage (utils/subtitleMask.ts, docs/subtitle-mask.md):
 * where an object-contain picture sits, dragging held to the picture, bad data read as none,
 * and a deleted video's entry going away.
 * Run with: node test-subtitle-mask.mjs
 */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: k => { store.delete(k); },
};

const out = join(tmpdir(), `subtitle-mask-${process.pid}.mjs`);
await build({ entryPoints: ['utils/subtitleMask.ts'], bundle: true, format: 'esm', outfile: out, logLevel: 'error' });
const M = await import(out);
const KEY = 'linguaclip_subtitle_mask';
const near = (a, b, msg) => {
  for (const k of Object.keys(b)) assert.ok(Math.abs(a[k] - b[k]) < 1e-9, `${msg}: ${k} = ${a[k]}, want ${b[k]}`);
};

// fitBox: 16:9 video in a wider box → bars left / right; in a taller box → bars top / bottom.
near(M.fitBox(1000, 400, 1920, 1080), { left: (1000 - 400 * 16 / 9) / 2, top: 0, width: 400 * 16 / 9, height: 400 }, 'pillarbox');
near(M.fitBox(800, 800, 1920, 1080), { left: 0, top: (800 - 450) / 2, width: 800, height: 450 }, 'letterbox');
near(M.fitBox(640, 360, 1280, 720), { left: 0, top: 0, width: 640, height: 360 }, 'exact fit');
assert.equal(M.fitBox(800, 600, 0, 0), null, 'no metadata yet: nothing drawn');
assert.equal(M.fitBox(0, 600, 1920, 1080), null, 'collapsed element: nothing drawn');
// The same share lands on the same spot of the picture at any size (resize / fullscreen / list open).
// A box over the bottom tenth, x 10%–90%, in pixels of the element:
const px = (W, H) => { const b = M.fitBox(W, H, 1920, 1080); return { left: b.left + 0.1 * b.width, top: b.top + 0.9 * b.height, right: b.left + 0.9 * b.width, bottom: b.top + b.height }; };
near(px(1280, 720), { left: 128, top: 648, right: 1152, bottom: 720 }, 'no bars');
near(px(900, 900), { left: 90, top: 196.875 + 455.625, right: 810, bottom: 196.875 + 506.25 }, 'letterboxed: off the bars');
near(px(1600, 500), { left: 355.5555555555556 + 88.88888888888889, top: 450, right: 355.5555555555556 + 800, bottom: 500 }, 'pillarboxed: off the bars');

// clampRect / spanRect / dragRect: never off the picture, never under MIN.
near(M.clampRect({ x: 0.9, y: -0.2, w: 0.3, h: 0.1 }), { x: 0.7, y: 0, w: 0.3, h: 0.1 }, 'pushed back inside, size kept');
near(M.clampRect({ x: 0.5, y: 0.5, w: 0.001, h: 2 }), { x: 0.5, y: 0, w: M.MIN, h: 1 }, 'min side, max side');
near(M.spanRect({ x: 0.8, y: 0.9 }, { x: 0.2, y: 1.4 }), { x: 0.2, y: 0.9, w: 0.6, h: 0.1 }, 'dragged up-left and off the bottom');
const r = { x: 0.2, y: 0.7, w: 0.6, h: 0.2 };
near(M.dragRect(r, 'move', 0.5, 0.5), { x: 0.4, y: 0.8, w: 0.6, h: 0.2 }, 'move stops at the edge, size kept');
near(M.dragRect(r, 'move', -0.1, -0.1), { x: 0.1, y: 0.6, w: 0.6, h: 0.2 }, 'move');
near(M.dragRect(r, 'se', 0.5, 0.5), { x: 0.2, y: 0.7, w: 0.8, h: 0.3 }, 'corner stops at the picture edge');
near(M.dragRect(r, 'nw', 0.1, -0.1), { x: 0.3, y: 0.6, w: 0.5, h: 0.3 }, 'top-left corner');
near(M.dragRect(r, 'w', 0.9, 0), { x: 0.8 - M.MIN, y: 0.7, w: M.MIN, h: 0.2 }, 'left edge past the right: min width');
near(M.dragRect(r, 'n', 0, 0.5), { x: 0.2, y: 0.9 - M.MIN, w: 0.6, h: M.MIN }, 'top edge past the bottom: min height');
near(M.dragRect(r, 'e', 0, 0.3), { x: 0.2, y: 0.7, w: 0.6, h: 0.2 }, 'an edge only moves its own axis');

// parseMasks: bad data = none, never throws; good entries survive next to bad ones.
assert.deepEqual(M.parseMasks(null), {}, 'missing key');
assert.deepEqual(M.parseMasks('not json'), {}, 'bad JSON');
assert.deepEqual(M.parseMasks('[1,2]'), {}, 'an array');
assert.deepEqual(M.parseMasks('"x"'), {}, 'a string');
const mixed = M.parseMasks(JSON.stringify({
  good: { on: true, x: 0.1, y: 0.8, w: 0.8, h: 0.1, extra: 1 },
  off: { on: false, x: 0, y: 0, w: 1, h: 1 },
  noOn: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
  str: { on: true, x: '0.1', y: 0.1, w: 0.1, h: 0.1 },
  nan: { on: true, x: null, y: 0.1, w: 0.1, h: 0.1 },
  out: { on: true, x: 0.5, y: 0.5, w: 0.6, h: 0.1 },
  neg: { on: true, x: -0.1, y: 0.5, w: 0.2, h: 0.1 },
  zero: { on: true, x: 0.1, y: 0.5, w: 0, h: 0.1 },
  nul: null,
}));
assert.deepEqual(mixed, { good: { on: true, x: 0.1, y: 0.8, w: 0.8, h: 0.1 }, off: { on: false, x: 0, y: 0, w: 1, h: 1 } }, 'only whole, in-range entries');

// Storage: write, read, toggle, forget; a broken stored value reads as none.
store.set(KEY, '{broken');
assert.equal(M.getMask('v1'), null, 'broken key: no mask');
M.setMask('v1', { on: true, x: 0.1, y: 0.8, w: 0.8, h: 0.15 });
M.setMask('v2', { on: false, x: 0.9, y: 0.9, w: 0.5, h: 0.5 }); // clamped on write
assert.deepEqual(M.getMask('v1'), { on: true, x: 0.1, y: 0.8, w: 0.8, h: 0.15 }, 'written over a broken key');
near(M.getMask('v2'), { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, 'clamped on write');
assert.equal(M.getMask('v2').on, false, 'off kept with its box');
M.forgetMask('v1');
assert.equal(M.getMask('v1'), null, 'deleted video: entry gone');
assert.deepEqual(Object.keys(JSON.parse(store.get(KEY))), ['v2'], 'other videos untouched');
store.delete(KEY);
M.forgetMask('nope');
assert.equal(store.has(KEY), false, 'forgetting nothing writes nothing');

// maskShowing: switch, box on, not framing.
M.setMask('v3', { on: true, x: 0, y: 0.8, w: 1, h: 0.2 });
assert.equal(M.maskShowing('v3'), true, 'on by default (no practice_config)');
M.setDrawFor('v3');
assert.equal(M.maskShowing('v3', true), false, 'framing: the editing copy hides the old box');
M.setDrawFor(null);
store.set('linguaclip_practice_config', JSON.stringify({ sectionLength: 4, subtitleMask: false }));
assert.equal(M.maskShowing('v3'), false, 'switched off in settings');
store.delete('linguaclip_practice_config');
M.setMask('v3', { ...M.getMask('v3'), on: false });
assert.equal(M.maskShowing('v3'), false, 'box off');
assert.equal(M.maskShowing(null), false, 'no video');


// Review fix 2: a read-only copy (review) ignores framing on the practice page underneath.
M.setMask('v4', { on: true, x: 0, y: 0.8, w: 1, h: 0.2 });
M.setDrawFor('v4');
assert.equal(M.maskShowing('v4'), true, 'read-only (review): framing elsewhere does not hide it');
assert.equal(M.maskShowing('v4', true), false, 'editing copy: hidden while framing');
M.setDrawFor(null);

// Review fix 1: entering framing, finishing it, cancelling it and switching the cover on all cover again.
M.setPeek(true); M.setDrawFor('v4');
assert.equal(M.getPeek(), false, 'start framing: covered again');
M.setPeek(true); M.setDrawFor(null);
assert.equal(M.getPeek(), false, 'cancel framing: covered again');
M.setPeek(true); M.setMask('v4', { on: true, x: 0.1, y: 0.8, w: 0.8, h: 0.1 });
assert.equal(M.getPeek(), false, 'a box drawn / switched on: covered');

// Review fix 4: with the switch off the mask keys are not live: no key, no clash, not listed.
const outS = join(tmpdir(), `subtitle-mask-keys-${process.pid}.mjs`);
await build({ entryPoints: ['utils/shortcuts.ts'], bundle: true, format: 'esm', outfile: outS, logLevel: 'error' });
const S = await import(outS);
const U = { code: 'KeyU', mod: true, shift: false };
const evU = { code: 'KeyU', key: 'u', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false };
assert.equal(S.matches(evU, 'dict.mask'), true, 'switch on: ⌘U is the dictation mask key');
assert.ok(S.liveActions().some(a => a.id === 'review.mask'), 'switch on: listed');
assert.deepEqual(S.checkNewCombo(evU, 'dict.playTyping'), { taken: 'dict.mask' }, 'switch on: ⌘U clashes with the mask key');
store.set('linguaclip_practice_config', JSON.stringify({ sectionLength: 4, subtitleMask: false }));
S.refreshShortcuts();
assert.equal(S.matches(evU, 'dict.mask'), false, 'switch off: ⌘U does nothing for the mask');
assert.equal(S.matches(evU, 'review.mask'), false, 'switch off: review mask key off too');
assert.ok(!S.liveActions().some(a => a.id === 'dict.mask' || a.id === 'review.mask'), 'switch off: not listed in Settings / legends');
assert.deepEqual(S.checkNewCombo(evU, 'dict.playTyping'), { combo: U }, 'switch off: ⌘U free for another dictation key');
store.delete('linguaclip_practice_config');
S.refreshShortcuts();
console.log('subtitle mask: ok');
