import { useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { IS_WINDOWS } from './platform';
import type { DictKey } from './i18n';

// The one list of practice shortcuts: key handlers, the "…" legend, the pinned
// corner legend, button tooltips and Settings all read from here. Combos with
// ⌘ (Ctrl on Windows) can be rebound; the typing keys stay fixed so a custom
// key can never swallow what the user types.

export type Combo = { code: string; mod?: boolean; shift?: boolean };
export type ActionId = 'play' | 'replay' | 'loop' | 'playFrom' | 'playWord' | 'prev' | 'next' | 'continue' | 'peek' | 'anki' | 'breakdown' | 'skipWord' | 'skipLine' | 'reveal';

type Action = { id: ActionId; def: Combo; label: DictKey; fixed?: boolean; dictationOnly?: boolean };

export const ACTIONS: Action[] = [
  { id: 'play', def: { code: 'Space' }, label: 'keys.play', fixed: true },
  { id: 'replay', def: { code: 'Space', shift: true }, label: 'keys.replay' },
  { id: 'loop', def: { code: 'KeyL', mod: true }, label: 'keys.loop' },
  { id: 'playFrom', def: { code: 'KeyJ', mod: true }, label: 'keys.playFrom', dictationOnly: true },
  { id: 'playWord', def: { code: 'KeyK', mod: true }, label: 'keys.playWord', dictationOnly: true },
  { id: 'prev', def: { code: 'ArrowUp', mod: true }, label: 'keys.prev' },
  { id: 'next', def: { code: 'ArrowDown', mod: true }, label: 'keys.next' },
  { id: 'continue', def: { code: 'Enter' }, label: 'keys.continue', fixed: true },
  { id: 'skipLine', def: { code: 'KeyT', mod: true }, label: 'keys.skipLine' },
  { id: 'reveal', def: { code: 'Enter', mod: true }, label: 'keys.reveal', fixed: true, dictationOnly: true },
  { id: 'peek', def: { code: 'KeyX', mod: true }, label: 'keys.peek', dictationOnly: true },
  { id: 'anki', def: { code: 'KeyN', mod: true, shift: true }, label: 'keys.anki' },
  { id: 'breakdown', def: { code: 'KeyB', mod: true }, label: 'keys.breakdown', dictationOnly: true },
  { id: 'skipWord', def: { code: 'Space' }, label: 'keys.skipWord', fixed: true, dictationOnly: true },
];

const STORAGE_KEY = 'linguaclip_shortcuts';

// Editing, and what the system or the web view catches before the page does:
// copy/paste/select all/undo/redo, quit/close/hide/minimise, find/print/save (⌘R is free: no Reload menu, and a bound combo preventDefaults).
const RESERVED = ['KeyC', 'KeyV', 'KeyA', 'KeyZ', 'KeyY', 'KeyQ', 'KeyW', 'KeyH', 'KeyM', 'KeyF', 'KeyG', 'KeyP', 'KeyS'];
// Letters and digits only, plus ↑/↓: ⌘+Backspace/←/→/Enter are editing keys in a blank.
const BINDABLE = /^(Key[A-Z]|Digit\d|ArrowUp|ArrowDown)$/;

function load(): Partial<Record<ActionId, Combo>> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    const out: Partial<Record<ActionId, Combo>> = {};
    for (const a of ACTIONS) {
      const c = raw?.[a.id];
      if (!a.fixed && c && typeof c.code === 'string' && c.mod && BINDABLE.test(c.code)) out[a.id] = { code: c.code, mod: true, shift: !!c.shift };
    }
    return out;
  } catch { return {}; }
}

let custom = load();
let snapshot = build();
const listeners = new Set<() => void>();

function build(): Record<ActionId, Combo> {
  return Object.fromEntries(ACTIONS.map(a => [a.id, custom[a.id] ?? a.def])) as Record<ActionId, Combo>;
}

function commit() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(custom)); } catch { /* localStorage unavailable */ }
  snapshot = build();
  listeners.forEach(l => l());
}

export const getCombo = (id: ActionId): Combo => snapshot[id];

export function setCombo(id: ActionId, combo: Combo) {
  custom = { ...custom, [id]: combo };
  commit();
}

export function resetCombos() {
  custom = {};
  commit();
}

export function useShortcuts(): Record<ActionId, Combo> {
  return useSyncExternalStore(
    l => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => snapshot, () => snapshot,
  );
}

export const sameCombo = (a: Combo, b: Combo) => a.code === b.code && !!a.mod === !!b.mod && !!a.shift === !!b.shift;

// ⌘ and Ctrl both count as "mod" on either system, as before.
export const matches = (e: KeyboardEvent | ReactKeyboardEvent, id: ActionId) =>
  !e.altKey && sameCombo({ code: e.code, mod: e.ctrlKey || e.metaKey, shift: e.shiftKey }, getCombo(id));

const KEY_NAMES: Record<string, string> = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Space: 'Space', Enter: 'Enter' };
const keyName = (code: string) => KEY_NAMES[code] ?? code.replace(/^(Key|Digit|Numpad)/, '');

export function formatCombo(c: Combo): string {
  if (IS_WINDOWS) return [c.mod && 'Ctrl', c.shift && 'Shift', keyName(c.code)].filter(Boolean).join('+');
  if (c.mod) return `⌘${c.shift ? '⇧' : ''}${keyName(c.code)}`;
  return [c.shift && 'Shift', keyName(c.code)].filter(Boolean).join('+');
}

// A key press recorded in Settings. Returns the combo, or why it is refused:
// 'needMod' (no ⌘/Ctrl), 'reserved' (the system's), or the action already on it.
export function checkNewCombo(e: KeyboardEvent, id: ActionId): { combo: Combo } | { error: 'needMod' | 'reserved' } | { taken: ActionId } | null {
  if (['Meta', 'Control', 'Shift', 'Alt'].includes(e.key)) return null; // still holding modifiers
  const combo: Combo = { code: e.code, mod: e.ctrlKey || e.metaKey, shift: e.shiftKey };
  if (!combo.mod || e.altKey) return { error: 'needMod' };
  if (!BINDABLE.test(combo.code) || RESERVED.includes(combo.code)) return { error: 'reserved' };
  const other = ACTIONS.find(a => a.id !== id && sameCombo(snapshot[a.id], combo));
  return other ? { taken: other.id } : { combo };
}
