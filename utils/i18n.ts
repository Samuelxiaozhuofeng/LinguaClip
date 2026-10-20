import { useSyncExternalStore } from 'react';
import { en } from './i18n.en';
import { zh } from './i18n.zh';
import { IS_WINDOWS } from './platform';
import { keyLabel, useShortcuts } from './shortcuts';

// Language state + translation lookup. Works both outside React (event handlers,
// hooks/useAnkiIntegration.ts, utils/ai.ts call `t()` directly) and inside it
// (components call `useT()` / `useLang()` so a language switch re-renders them).

export type Lang = 'en' | 'zh';
export type DictKey = keyof typeof en;

const STORAGE_KEY = 'linguaclip_lang';
const dicts: Record<Lang, Record<DictKey, string>> = { en, zh };

function detectDefaultLang(): Lang {
  const nav = typeof navigator !== 'undefined' ? navigator.language : '';
  return nav?.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

function loadLang(): Lang {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'en' || stored === 'zh') return stored;
  } catch { /* localStorage unavailable */ }
  return detectDefaultLang();
}

let currentLang: Lang = loadLang();
const listeners = new Set<() => void>();

export function getLang(): Lang {
  return currentLang;
}

export function setLang(lang: Lang): void {
  if (lang === currentLang) return;
  currentLang = lang;
  try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* localStorage unavailable */ }
  listeners.forEach(l => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Looks up `key` in the current language and substitutes `{name}`-style
// placeholders from `vars`. Placeholders with no matching var (e.g. the
// literal "{word}"/"{context}" documented in the AI prompt hint) are left as-is.
// Copy is written for the Mac; on Windows the keys are Ctrl / Shift and the
// Trash is the Recycle Bin, Finder is File Explorer.
const forPlatform = (s: string) => (IS_WINDOWS
  ? s.replace(/⌘/g, 'Ctrl+').replace(/⇧/g, 'Shift+').replace(/废纸篓/g, '回收站').replace(/\bTrash\b/g, 'Recycle Bin')
    .replace(/访达/g, '文件资源管理器').replace(/\bFinder\b/g, 'File Explorer')
  : s);

export function t(key: DictKey, vars?: Record<string, string | number>): string {
  // `{key:watch.save}` = that action's key as the user has set it (docs/shortcuts.md).
  const template = forPlatform(dicts[currentLang][key] ?? dicts.en[key] ?? String(key)).replace(/\{key:([\w.]+)\}/g, (_, id) => keyLabel(id));
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}

// Subscribes the calling component to language changes; returns the current language.
export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang, getLang);
}

// Subscribes the calling component to language changes; returns the translate function.
export function useT(): typeof t {
  useLang();
  useShortcuts(); // copy that names a key follows a rebind
  return t;
}
