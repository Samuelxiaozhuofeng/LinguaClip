import { useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { IS_WINDOWS } from './platform';
import { ACTION, ACTIONS, pageOf, type ActionId, type Combo, type Page } from './shortcutActions';
import { loadCustom, saveCustom, type Custom } from './shortcutStore';
import { clash, clashes, effective, refuse, sameCombo, takenBy, type Clash } from './shortcutRules';
import { getLang } from './i18n';

// The one place keys are matched and named: every page's key handler, the "…"
// legend, the pinned corner legend, button tooltips and Settings read from here.
// The action table is shortcutActions.ts; saving is shortcutStore.ts.

export { ACTIONS, PAGES } from './shortcutActions';
export type { ActionId, Combo, Page } from './shortcutActions';
export { sameCombo, typesText } from './shortcutRules';

let custom: Custom = loadCustom();
let snapshot = build();
const listeners = new Set<() => void>();

function build(): Record<ActionId, Combo> {
  return Object.fromEntries(ACTIONS.map(a => [a.id, custom[a.id] ?? a.def]));
}

function commit(next: Custom) {
  custom = next;
  saveCustom(custom);
  snapshot = build();
  listeners.forEach(l => l());
}

export const getCombo = (id: ActionId): Combo => snapshot[id];
export const isDefault = (id: ActionId) => !custom[id] || sameCombo(custom[id], ACTION.get(id)!.def);
export const isCustom = (id: ActionId) => !isDefault(id);

const without = (c: Custom, id: ActionId) => { const { [id]: _, ...rest } = c; return rest; };
// Setting the default key again is the same as never having changed it.
export const setCombo = (id: ActionId, combo: Combo) => commit(sameCombo(combo, ACTION.get(id)!.def) ? without(custom, id) : { ...custom, [id]: combo });
// One action back to default; refused (the other action named) when its default is in use now.
export function resetCombo(id: ActionId): ActionId | null {
  const next = without(custom, id);
  const hit = clash(next, id);
  if (hit) return hit.ids[1];
  commit(next);
  return null;
}
// A page back to default. Anything elsewhere now on the same key because of it goes back to
// default too (for a hidden line key, the dictation line key behind it); clashes that were
// there before are left alone. Each round removes one binding, so this ends.
const pair = (h: Clash) => [...h.srcs].sort().join('|');
export function resetPage(page: Page) {
  const before = new Set(clashes(custom).map(pair));
  let next: Custom = Object.fromEntries(Object.entries(custom).filter(([id]) => pageOf(id) !== page));
  for (;;) {
    const src = clashes(next).filter(h => !before.has(pair(h))).flatMap(h => h.srcs).find(s => next[s]);
    if (!src) break;
    next = without(next, src);
  }
  commit(next);
}
export const resetCombos = () => commit({});

export function useShortcuts(): Record<ActionId, Combo> {
  return useSyncExternalStore(
    l => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => snapshot, () => snapshot,
  );
}

// Keypad digits count as digits only while they type one (NumLock off they are End, ↓…).
// Keypad Enter is Enter only bare: ⌘ + keypad Enter never was "show the answer".
const eventCode = (e: KeyboardEvent | ReactKeyboardEvent) =>
  /^Numpad\d$/.test(e.code) && /^\d$/.test(e.key) ? `Digit${e.key}` : e.code === 'NumpadEnter' && !e.ctrlKey && !e.metaKey ? 'Enter' : e.code;
const comboOf = (e: KeyboardEvent | ReactKeyboardEvent): Combo => ({ code: eventCode(e), mod: e.ctrlKey || e.metaKey, shift: e.shiftKey });

// ⌘ and Ctrl both count as "mod" on either system, as before. ⌥ never matches. A bare digit
// also has to type that digit, as before (AZERTY's bare 1 key types &: not a 1).
const bareDigit = (c: Combo) => !c.mod && !c.shift && /^Digit\d$/.test(c.code);
const sameAs = (e: KeyboardEvent | ReactKeyboardEvent, c: Combo) =>
  sameCombo(comboOf(e), c) && (!bareDigit(c) || e.key === c.code.slice(5));
export const matches = (e: KeyboardEvent | ReactKeyboardEvent, id: ActionId) => !e.altKey && sameAs(e, getCombo(id));

const KEY_NAMES: Record<string, string> = {
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Space: 'Space', Enter: 'Enter', Escape: 'Esc', Backspace: '⌫', Tab: 'Tab',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Backquote: '`', Comma: ',', Period: '.', Slash: '/',
};
const ZH_NAMES: Record<string, string> = { Space: '空格', Enter: '回车' };
const keyName = (code: string) => (getLang() === 'zh' && ZH_NAMES[code]) || KEY_NAMES[code] || code.replace(/^(Key|Digit|Numpad)/, '');

export function formatCombo(c: Combo): string {
  if (IS_WINDOWS) return [c.mod && 'Ctrl', c.shift && 'Shift', keyName(c.code)].filter(Boolean).join('+');
  if (c.mod) return `⌘${c.shift ? '⇧' : ''}${keyName(c.code)}`;
  return [c.shift && 'Shift', keyName(c.code)].filter(Boolean).join('+');
}
export const keyLabel = (id: ActionId) => formatCombo(getCombo(id));

// A key press recorded in Settings: the combo, why it is refused, or the action already on it.
export function checkNewCombo(e: KeyboardEvent, id: ActionId): { combo: Combo } | { error: 'needMod' | 'reserved' } | { taken: ActionId } | null {
  if (['Meta', 'Control', 'Shift', 'Alt'].includes(e.key)) return null; // still holding modifiers
  if (e.altKey) return { error: 'reserved' };
  const combo = comboOf(e);
  if (bareDigit(combo) && e.key !== combo.code.slice(5)) return { error: 'reserved' }; // a digit key that types something else
  const why = refuse(ACTION.get(id)!, combo);
  if (why) return { error: why };
  const other = takenBy(id, combo, snapshot);
  return other ? { taken: other } : { combo };
}

// Watch / listen line keys: the bound key, plus — while it is still the default — ⌘← / ⌘→
// and the dictation page's own line keys, as they always worked.
export const lineKey = (e: KeyboardEvent | ReactKeyboardEvent, dir: 'prev' | 'next') => {
  const id = `watch.${dir}`;
  if (matches(e, id)) return true;
  if (!isDefault(id)) return false;
  return matches(e, `dict.${dir}`) || (!e.altKey && sameCombo(comboOf(e), { code: getCombo(id).code, mod: true }));
};

// Keys that always took any modifier (the blank's editing keys, the listen pass card, Esc),
// while still default: as before, any modifier counts (⇧Enter jumps, ⌘← at the start goes
// back, ⇧Esc closes) unless another action live there has exactly that key (⌘Enter, ⇧Space,
// or one the user recorded; ⌥ presses match no binding, so they never yield). `where`: the
// zone the key is pressed in (default: anywhere the action lives); 'alone' = nothing else is
// handled there (the listen pass card), so never yield.
export const loose = (e: KeyboardEvent | ReactKeyboardEvent, id: ActionId, where?: string) => {
  if (matches(e, id)) return true;
  const code = getCombo(id).code;
  if (!isDefault(id) || (eventCode(e) !== code && !(code === 'Enter' && e.code === 'NumpadEnter'))) return false;
  if (where === 'alone') return true;
  if (code === 'Space' && e.key !== ' ') return false; // ⌥Space types a no-break space, as before
  if (e.altKey) return true;
  const zones = where ? [where] : (ACTION.get(id)!.zones as string[]);
  return !effective(snapshot).some(l => l.id !== id && sameAs(e, l.combo) && l.zones.some(z => zones.includes(z)));
};
