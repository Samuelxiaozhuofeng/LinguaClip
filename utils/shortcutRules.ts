import { ACTION, ACTIONS, maySharePair, type Combo } from './shortcutActions';

// Which keys an action may take, and which other action already holds one.
// Pages where you type (dictation, the blank) take ⌘ combos or keys that print
// nothing; the others take plain letters / digits too (docs/shortcuts.md).

type Rule = { single: boolean };

// ⌘ / Ctrl + these is the system's or editing's: copy, paste, select all, undo, redo, quit, close, hide, minimise, find, print, save.
const RESERVED = ['KeyC', 'KeyV', 'KeyA', 'KeyZ', 'KeyY', 'KeyQ', 'KeyW', 'KeyH', 'KeyM', 'KeyF', 'KeyG', 'KeyP', 'KeyS'];
const MOD_KEYS = /^(Key[A-Z]|Digit\d|ArrowUp|ArrowDown)$/;
// Keys that print nothing (⌫ / Enter included: ⌘⌫ and ⌘Enter are defaults).
const SILENT = /^(Space|Enter|Tab|Escape|Backspace|Arrow(Up|Down|Left|Right)|F([1-9]|1[0-2]))$/;
// Keys that type a character: allowed bare only where nothing is typed.
const PRINTING = /^(Key[A-Z]|Digit\d|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Backquote|Comma|Period|Slash)$/;

export const typesText = (c: Combo) => !c.mod && (c.code === 'Space' || PRINTING.test(c.code));

export function validCombo(rule: Rule, c: Combo): boolean {
  if (c.mod) {
    if (MOD_KEYS.test(c.code)) return !RESERVED.includes(c.code);
    // ⌘Space / ⌘Tab belong to the system; ⌘⌫ / ⌘← / ⌘→ edit text where you type.
    if (/^(Enter|Escape|F([1-9]|1[0-2]))$/.test(c.code)) return true;
    return rule.single && /^(Backspace|ArrowLeft|ArrowRight)$/.test(c.code);
  }
  if (SILENT.test(c.code)) return true;
  return rule.single && PRINTING.test(c.code);
}

// Why a recorded key is refused, if it is.
export function refuse(rule: Rule, c: Combo): 'needMod' | 'reserved' | null {
  if (validCombo(rule, c)) return null;
  return !c.mod && PRINTING.test(c.code) ? 'needMod' : 'reserved';
}

export const sameCombo = (a: Combo, b: Combo) => a.code === b.code && !!a.mod === !!b.mod && !!a.shift === !!b.shift;

type Table = Record<string, Combo>;

// A key that does something: the action it runs, the binding it comes from (`src`, what to
// reset to undo it) and where it is live.
type Live = { id: string; src: string; combo: Combo; zones: string[] };

// While typing in a review sentence card only review's ⌘ keys and Esc count (ReviewSession).
export const zonesOf = (id: string, c: Combo) => {
  const z = ACTION.get(id)!.zones as string[];
  return id.startsWith('review.') && !c.mod && c.code !== 'Escape' ? z.filter(x => x !== 'reviewBlank') : z;
};

// Every key that does something: each action's key, plus the watch / listen line keys' hidden
// extras while those are default (shortcuts.ts lineKey). The blank's loose editing keys
// (shortcuts.ts loose) aren't listed: they yield to any exact binding, so they never clash.
export function effective(table: Table): Live[] {
  const at = (id: string) => table[id] ?? ACTION.get(id)!.def;
  const isDef = (id: string) => sameCombo(at(id), ACTION.get(id)!.def);
  const out: Live[] = ACTIONS.map(a => ({ id: a.id, src: a.id, combo: at(a.id), zones: zonesOf(a.id, at(a.id)) }));
  for (const dir of ['prev', 'next'] as const) {
    const id = `watch.${dir}`, z = ACTION.get(id)!.zones as string[];
    if (!isDef(id)) continue;
    out.push({ id, src: id, combo: { code: at(id).code, mod: true, shift: false }, zones: z },
      { id, src: `dict.${dir}`, combo: at(`dict.${dir}`), zones: z });
  }
  return out;
}

export type Clash = { ids: [string, string]; srcs: [string, string] };

// Every pair of different actions live at once on the same key.
export function clashes(table: Table): Clash[] {
  const keys = effective(table), out: Clash[] = [];
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
    const a = keys[i], b = keys[j];
    if (a.id === b.id || !sameCombo(a.combo, b.combo) || maySharePair(a.id, b.id) || !a.zones.some(z => b.zones.includes(z))) continue;
    out.push({ ids: [a.id, b.id], srcs: [a.src, b.src] });
  }
  return out;
}

// A clash, or null. `only`: just clashes that involve this action (or a key it supplies),
// that side first — an old clash elsewhere never blocks changing an unrelated key.
export function clash(table: Table, only?: string): Clash | null {
  for (const h of clashes(table)) {
    const mine = (i: number) => h.srcs[i] === only || h.ids[i] === only;
    if (!only || mine(0)) return h;
    if (mine(1)) return { ids: [h.ids[1], h.ids[0]], srcs: [h.srcs[1], h.srcs[0]] };
  }
  return null;
}

// The action that would share `c` with `id`, if `id` took it.
export function takenBy(id: string, c: Combo, table: Table): string | null {
  const hit = clash({ ...table, [id]: c }, id);
  return hit ? hit.ids[1] : null;
}
