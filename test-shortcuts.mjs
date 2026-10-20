/**
 * Checks rebindable shortcuts (docs/shortcuts.md「全部快捷键可改」): which keys each page
 * may take, which actions clash, saving / migrating the old list, and that every action
 * id the code names exists.
 * Run with: node test-shortcuts.mjs
 */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};

const entry = join(tmpdir(), `shortcuts-entry-${process.pid}.ts`);
const out = join(tmpdir(), `shortcuts-${process.pid}.mjs`);
const { writeFileSync } = await import('node:fs');
writeFileSync(entry, `export * from '${process.cwd()}/utils/shortcutStore';
export * from '${process.cwd()}/utils/shortcutRules';
export * from '${process.cwd()}/utils/shortcutActions';`);
await build({ entryPoints: [entry], bundle: true, format: 'esm', outfile: out, logLevel: 'error' });
const { loadCustom, saveCustom, migrateOld, parseCustom, validCombo, refuse, takenBy, typesText, ACTIONS, ACTION, zonesShare } = await import(out);

const k = (code, mod = false, shift = false) => ({ code, mod, shift });
const defaults = Object.fromEntries(ACTIONS.map(a => [a.id, a.def]));

// Defaults are all valid and clash with nothing.
for (const a of ACTIONS) {
  assert.ok(validCombo(a, a.def), `default valid: ${a.id}`);
  assert.equal(takenBy(a.id, a.def, defaults), null, `default free: ${a.id}`);
}
assert.equal(new Set(ACTIONS.map(a => a.id)).size, ACTIONS.length, 'ids unique');

// What a page may take.
const dict = ACTION.get('dict.replay'), watch = ACTION.get('watch.replay');
assert.equal(refuse(dict, k('KeyR')), 'needMod', 'dictation: bare letter refused');
assert.equal(refuse(dict, k('KeyR', false, true)), 'needMod', 'dictation: ⇧ letter types a capital');
assert.equal(refuse(dict, k('Tab')), null, 'dictation: Tab ok');
assert.equal(refuse(dict, k('F2')), null, 'dictation: F-key ok');
assert.equal(refuse(dict, k('KeyR', true)), null, 'dictation: ⌘R ok');
assert.equal(refuse(dict, k('KeyC', true)), 'reserved', '⌘C is copy');
assert.equal(refuse(dict, k('Space', true)), 'reserved', '⌘Space is the system');
assert.equal(refuse(dict, k('Backspace', true)), 'reserved', 'dictation: ⌘⌫ edits text');
assert.equal(refuse(watch, k('KeyR')), null, 'watch: bare letter ok');
assert.equal(refuse(watch, k('Digit7')), null, 'watch: digit ok');
assert.equal(refuse(watch, k('Comma')), null, 'watch: punctuation ok');
assert.equal(refuse(ACTION.get('review.remove'), k('Backspace', true)), null, 'review: ⌘⌫ ok');
assert.ok(typesText(k('KeyL')) && typesText(k('Space')) && !typesText(k('KeyL', true)) && !typesText(k('Escape')), 'typesText');

// Clashes: only actions live at the same moment.
assert.equal(takenBy('watch.full', k('KeyS'), defaults), 'watch.save', 'watch: S is save');
assert.equal(takenBy('watch.replay', k('KeyR'), defaults), null, 'watch R free');
assert.equal(takenBy('dict.replay', k('KeyT', true), defaults), 'dict.skipLine', 'dictation ⌘T taken');
assert.equal(takenBy('watch.replay', k('KeyT', true), defaults), null, 'other page: ⌘T free');
assert.equal(takenBy('blank.jump', k('ArrowUp', true), defaults), 'dict.prev', 'blank vs dictation page');
assert.equal(takenBy('review.loop', k('KeyX', true), defaults), 'blank.peek', 'review loop fires in a blank');
assert.equal(takenBy('review.g1', k('KeyX', true), defaults), null, 'review grades never fire in a blank');
assert.equal(takenBy('review.replay', k('Backspace'), defaults), null, 'review single keys sleep while typing: ⌫ free of the blank');
assert.equal(takenBy('review.replay', k('Backspace', true), defaults), 'review.remove', '… but ⌘ keys still clash');
assert.equal(takenBy('watch.drillShow', k('KeyS'), defaults), 'watch.save', 'drill keys clash with the page keys');
assert.equal(takenBy('watch.drillShow', k('ArrowRight'), defaults), 'watch.next', 'show answer on → would be eaten by next');
assert.equal(takenBy('watch.save', k('ArrowUp', true), defaults), 'watch.prev', '⌘↑ is a hidden line key while prev is default');
assert.equal(takenBy('watch.save', k('ArrowLeft', true), defaults), 'watch.prev', '⌘← too');
assert.equal(takenBy('watch.save', k('ArrowUp', true), { ...defaults, 'watch.prev': k('KeyJ') }), null, 'hidden keys go once prev is changed');
assert.equal(takenBy('watch.prev', k('ArrowLeft'), { ...defaults, 'watch.prev': k('KeyJ'), 'watch.save': k('ArrowUp', true) }), 'watch.save', 'back to ← brings ⌘↑ back: clash');
assert.equal(takenBy('dict.prev', k('KeyD', true), { ...defaults, 'watch.save': k('KeyD', true) }), 'watch.save', 'dictation prev is a hidden watch key');
assert.ok(!zonesShare('dict.play', 'blank.jump') && !zonesShare('watch.peek', 'watch.drillShow'), 'meant to share');

// Reading back: unknown ids and keys a page can't take are dropped.
assert.deepEqual(parseCustom({ 'watch.save': k('KeyD'), 'dict.replay': k('KeyR'), 'nope.x': k('KeyQ'), 'watch.full': { code: 5 } }),
  { 'watch.save': k('KeyD') }, 'parse filters');

// Migration from the old shared list.
assert.deepEqual(migrateOld({ replay: k('KeyR', true), play: k('KeyP', true), peek: k('KeyX'), anki: k('Enter', true) }),
  { 'dict.replay': k('KeyR', true), 'watch.replay': k('KeyR', true), 'review.replay': k('KeyR', true) },
  'old: replay lands on every page; fixed / no-⌘ / non-bindable dropped');

store.clear();
store.set('linguaclip_shortcuts', JSON.stringify({ replay: { code: 'KeyR', mod: true } }));
const first = loadCustom();
assert.equal(first['watch.replay'].code, 'KeyR', 'migrated');
assert.equal(store.get('linguaclip_keys'), JSON.stringify(first), 'migration written at once');
saveCustom({ ...first, 'watch.save': k('KeyD') });
assert.equal(loadCustom()['review.replay'].code, 'KeyR', 'a later change keeps the migrated ones');
saveCustom({});
assert.deepEqual(loadCustom(), {}, 'reset all is not undone by the old key');
assert.equal(store.get('linguaclip_shortcuts'), JSON.stringify({ replay: { code: 'KeyR', mod: true } }), 'old key never written');

store.clear();
store.set('linguaclip_shortcuts', '{bad');
assert.deepEqual(loadCustom(), {}, 'bad old JSON = defaults');
assert.equal(store.get('linguaclip_keys'), undefined, 'bad old JSON: nothing written, tried again next start');

store.clear();
store.set('linguaclip_shortcuts', '');
assert.deepEqual(loadCustom(), {}, 'empty old key = unreadable, defaults');
assert.equal(store.get('linguaclip_keys'), undefined, 'empty old key: nothing written');

store.clear();
assert.deepEqual(loadCustom(), {}, 'fresh install');
assert.equal(store.get('linguaclip_keys'), '{}', 'fresh install writes {}');
store.set('linguaclip_keys', '{broken');
assert.deepEqual(loadCustom(), {}, 'bad JSON = defaults');
assert.equal(store.get('linguaclip_keys'), '{broken', 'bad JSON not written over');

// Every action id the code names exists (a typo would silently never match).
const files = ['App.tsx', ...['components', 'pro', 'utils', 'hooks'].flatMap(d => readdirSync(d).filter(f => /\.tsx?$/.test(f)).map(f => `${d}/${f}`))];
const ids = new Set();
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/(?:matches\(e, |getCombo\(|keyLabel\(|isDefault\(|combos\[)'((?:dict|blank|watch|review|reader)\.\w+)'/g)) ids.add(`${f}: ${m[1]}`);
  for (const m of src.matchAll(/\{key:([\w.]+)\}/g)) ids.add(`${f}: ${m[1]}`);
}
assert.ok(ids.size > 40, `found the call sites (${ids.size})`);
for (const s of ids) assert.ok(ACTION.has(s.split(': ')[1]), `unknown action ${s}`);

// An old clash elsewhere never blocks changing an unrelated key.
const stale = { ...defaults, 'watch.save': k('ArrowUp', true) };
assert.equal(takenBy('watch.full', k('KeyQ'), stale), null, 'unrelated key free despite an old clash');

// The live module, through utils/shortcuts.ts. Each `fresh` is a new copy that reads the
// stored keys at start, as the app does.
const out2 = join(tmpdir(), `shortcuts-live-${process.pid}.mjs`);
await build({ entryPoints: ['utils/shortcuts.ts'], bundle: true, format: 'esm', outfile: out2, logLevel: 'error', define: { 'import.meta.env': '{}' } });
let n = 0;
const fresh = async keys => { store.clear(); store.set('linguaclip_keys', JSON.stringify(keys)); return import(`${out2}?${n++}`); };
let live = await fresh({ 'watch.autoPause': k('KeyO'), 'watch.save': k('KeyP') });
assert.equal(live.resetCombo('watch.autoPause'), 'watch.save', '↺ refused: P is save now');
assert.equal(live.getCombo('watch.autoPause').code, 'KeyO', 'refused reset changed nothing');
live = await fresh({ 'blank.peek': k('KeyU', true), 'review.loop': k('KeyX', true) });
assert.ok(!live.isDefault('review.loop') && !live.isDefault('blank.peek'), 'loaded');
live.resetPage('dict');
assert.ok(live.isDefault('blank.peek') && live.isDefault('review.loop'), 'page reset also frees review loop from ⌘X');
// A dictation line key on a hidden watch key: page reset undoes the dictation key, and ends.
live = await fresh({ 'watch.loop': k('Digit9', true), 'dict.loop': k('Digit8', true), 'dict.prev': k('KeyL', true) });
live.resetPage('watch');
assert.ok(live.isDefault('watch.loop') && live.isDefault('dict.prev') && !live.isDefault('dict.loop'), 'reset through a hidden key');
live = await fresh({});
live.setCombo('dict.play', k('Space'));
assert.ok(live.isDefault('dict.play') && !JSON.parse(store.get('linguaclip_keys'))['dict.play'], 'setting the default again = default');
const ev = (code, key, o = {}) => ({ code, key, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...o });
assert.ok(live.matches(ev('Numpad1', '1'), 'review.g1'), 'keypad 1 grades');
assert.ok(!live.matches(ev('Numpad1', 'End'), 'review.g1'), 'NumLock off: End is not a grade');
assert.ok(live.loose(ev('Enter', 'Enter', { shiftKey: true }), 'blank.submit', 'dictBlank'), '⇧Enter still jumps while default');
live = await fresh({ 'blank.back': k('Enter', false, true) });
assert.ok(!live.loose(ev('Enter', 'Enter', { shiftKey: true }), 'blank.submit', 'dictBlank'), '⇧Enter bound to back: submit lets it go');
assert.ok(live.loose(ev('Enter', 'Enter', { shiftKey: true }), 'blank.back', 'dictBlank'), '… and back takes it');
assert.ok(live.loose(ev('ArrowLeft', 'ArrowLeft', { metaKey: true }), 'blank.backLeft', 'dictBlank'), '⌘← at the start still goes back while default');
// A review single key sleeps while typing, so it never takes a blank key.
live = await fresh({ 'review.loop': k('Enter', false, true) });
assert.ok(live.loose(ev('Enter', 'Enter', { shiftKey: true }), 'blank.submit', 'dictBlank') && live.loose(ev('Enter', 'Enter', { shiftKey: true }), 'blank.submit', 'reviewBlank'), 'review loop on ⇧Enter: the blank still jumps');
live = await fresh({ 'dict.loop': k('Enter', false, true) });
assert.ok(live.loose(ev('Enter', 'Enter', { shiftKey: true }), 'blank.submit', 'reviewBlank'), 'dictation loop on ⇧Enter: a review blank still jumps');
assert.ok(!live.loose(ev('Enter', 'Enter', { shiftKey: true }), 'blank.submit', 'dictBlank'), '… the dictation blank lets it go');
// Listen pass card: ⇧Space (replay elsewhere) still passes it.
live = await fresh({});
assert.ok(live.loose(ev('Space', ' ', { shiftKey: true }), 'watch.play', 'alone'), 'pass card: ⇧Space passes');
assert.ok(live.loose(ev('Enter', 'Enter', { altKey: true }), 'watch.drillNext', 'alone'), 'pass card: ⌥Enter passes, as before');
assert.ok(live.loose(ev('Enter', 'Enter', { altKey: true }), 'blank.jump', 'dictBlank') || live.loose(ev('Enter', 'Enter', { altKey: true }), 'blank.submit', 'dictBlank'), '⌥Enter jumps a blank, as before');
assert.ok(live.loose(ev('Escape', 'Escape', { shiftKey: true }), 'watch.close'), '⇧Esc closes, as before');
live = await fresh({ 'watch.save': k('Escape', false, true) });
assert.ok(!live.loose(ev('Escape', 'Escape', { shiftKey: true }), 'watch.close'), '⇧Esc recorded for save: close lets it go');
live = await fresh({});
assert.ok(!live.matches(ev('NumpadEnter', 'Enter', { metaKey: true }), 'blank.reveal'), '⌘ keypad Enter is not "show the answer"');
assert.ok(live.loose(ev('NumpadEnter', 'Enter', { metaKey: true }), 'blank.submit', 'dictBlank'), '… it jumps, as before');
assert.ok(live.matches(ev('NumpadEnter', 'Enter'), 'blank.submit'), 'bare keypad Enter is Enter');
assert.ok(!live.loose(ev('Space', '\u00a0', { altKey: true }), 'blank.jump', 'dictBlank'), '⌥Space types a no-break space');
assert.ok(live.loose(ev('Space', '\u00a0', { altKey: true }), 'watch.play', 'alone'), '… but passes the listen card');
assert.ok(live.loose(ev('Enter', 'Enter', { shiftKey: true }), 'dict.continue', 'dictOut'), '⇧Enter continues, as before');
live = await fresh({ 'review.g1': k('Escape', false, true) });
assert.ok(live.loose(ev('Escape', 'Escape', { shiftKey: true }), 'review.close', 'reviewBlank'), 'typing: ⇧Esc closes (grade 1 sleeps)');
assert.ok(!live.loose(ev('Escape', 'Escape', { shiftKey: true }), 'review.close', 'reviewOut'), 'not typing: grade 1 takes it');
live = await fresh({});
assert.ok(!live.matches(ev('Digit1', '&'), 'review.g1') && !live.matches(ev('Digit1', '1', { shiftKey: true }), 'review.g1'), 'AZERTY: neither & nor ⇧& grades, as before (only bare keys typing 1)');
assert.ok(live.matches(ev('Digit1', '1'), 'review.g1'), 'QWERTY 1 grades');
assert.ok(!live.matches(ev('Digit1', '!', { shiftKey: true }), 'review.g1'), 'QWERTY: ! is not a grade');
live = await fresh({ 'dict.prev': k('Escape', false, true) });
assert.ok(!live.loose(ev('Escape', 'Escape', { shiftKey: true }), 'watch.close') && live.lineKey(ev('Escape', 'Escape', { shiftKey: true }), 'prev'), 'hidden line key on ⇧Esc: watch close lets it go');
// Resetting one page leaves an old clash elsewhere alone.
live = await fresh({ 'watch.save': k('ArrowUp', true), 'reader.play': k('KeyQ') });
live.resetPage('reader');
assert.ok(live.isDefault('reader.play') && !live.isDefault('watch.save'), 'unrelated old clash kept');
store.clear();

console.log('shortcuts ok');
