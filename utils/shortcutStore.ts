import { ACTION, type Combo } from './shortcutActions';
import { validCombo } from './shortcutRules';

// The user's rebound keys: localStorage `linguaclip_keys` = { "<page>.<action>": Combo },
// changed ones only. The old one-list key `linguaclip_shortcuts` is read once, to move
// its changes over, and never written (docs/shortcuts.md「数据」).

const KEY = 'linguaclip_keys';
const OLD_KEY = 'linguaclip_shortcuts';

// The old list was shared app-wide, so a change lands on every page that has the action.
const FROM_OLD: Record<string, string[]> = {
  replay: ['dict.replay', 'watch.replay', 'review.replay'],
  loop: ['dict.loop', 'watch.loop', 'review.loop'],
  playFrom: ['dict.playFrom'],
  playWord: ['dict.playWord', 'review.playWord'],
  prev: ['dict.prev'],
  next: ['dict.next'],
  skipLine: ['dict.skipLine'],
  peek: ['blank.peek'],
  anki: ['dict.anki', 'watch.anki'],
  breakdown: ['dict.breakdown'],
  playTyping: ['dict.playTyping'],
};
const OLD_BINDABLE = /^(Key[A-Z]|Digit\d|ArrowUp|ArrowDown)$/;

export type Custom = Record<string, Combo>;

const clean = (c: { code: string; mod?: unknown; shift?: unknown }): Combo => ({ code: c.code, mod: !!c.mod, shift: !!c.shift });

export function parseCustom(raw: unknown): Custom {
  const out: Custom = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, c] of Object.entries(raw as Record<string, unknown>)) {
    const a = ACTION.get(id);
    if (!a || !c || typeof (c as Combo).code !== 'string') continue;
    const combo = clean(c as Combo);
    if (validCombo(a, combo)) out[id] = combo;
  }
  return out;
}

// The old list, filtered by the old rules (⌘ + letter / digit / ↑↓; unknown ids dropped).
export function migrateOld(raw: unknown): Custom {
  const out: Custom = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [old, ids] of Object.entries(FROM_OLD)) {
    const c = (raw as Record<string, Combo | undefined>)[old];
    if (!c || typeof c.code !== 'string' || !c.mod || !OLD_BINDABLE.test(c.code)) continue;
    for (const id of ids) out[id] = clean(c);
  }
  return out;
}

function write(c: Custom) {
  try { localStorage.setItem(KEY, JSON.stringify(c)); } catch { /* localStorage unavailable */ }
}

// Unreadable = defaults and nothing written. No new key yet = migrate and write it at once
// (even `{}`), so a later "reset" is never undone by the old key.
export function loadCustom(): Custom {
  let stored: string | null;
  try { stored = localStorage.getItem(KEY); } catch { return {}; }
  if (stored !== null) {
    try { return parseCustom(JSON.parse(stored)); } catch { return {}; }
  }
  let migrated: Custom;
  try { const old = localStorage.getItem(OLD_KEY); migrated = old === null ? {} : migrateOld(JSON.parse(old)); } catch { return {}; } // unreadable old list: defaults, try again next start
  write(migrated);
  return migrated;
}

export const saveCustom = write;
