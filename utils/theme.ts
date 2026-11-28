// Light / dark appearance (docs/theme.md). The choice lives in localStorage
// `linguaclip_theme` ('system' | 'light' | 'dark', default 'system'), per device —
// it is not in SAFE_SYNC_SETTING_KEYS on purpose: the phone at night and the
// desk by day each keep their own. Dark = `dark` class on <html>; every colour
// token in tailwind.config.js reads a CSS variable that index.css swaps there.
import { useEffect, useState } from 'react';

export type ThemePref = 'system' | 'light' | 'dark';

const KEY = 'linguaclip_theme';
const EVENT = 'linguaclip-theme';

// The pick of this session when storage refuses to save it (private mode).
let unsaved: ThemePref | null = null;

export const getThemePref = (): ThemePref => {
  if (unsaved) return unsaved;
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
};

const systemDark = () => typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;

export const isDark = (pref: ThemePref = getThemePref()): boolean =>
  pref === 'dark' || (pref === 'system' && systemDark());

export const applyTheme = () => {
  if (typeof document === 'undefined') return;
  const dark = isDark();
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  root.style.colorScheme = dark ? 'dark' : 'light';
  // Phone status bar / PWA chrome follows the page ground.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', getComputedStyle(root).getPropertyValue('--theme-color').trim() || (dark ? '#171615' : '#FAFAFA'));
};

export const setThemePref = (pref: ThemePref) => {
  try {
    if (pref === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
    unsaved = null;
  } catch { unsaved = pref; /* private mode: still applies for this session */ }
  applyTheme();
  window.dispatchEvent(new Event(EVENT));
};

let started = false;
// Call once at startup (index.tsx / mobile/main.tsx): applies the saved choice and
// follows the system switch while on 'system'.
export const initTheme = () => {
  applyTheme();
  if (started || typeof matchMedia !== 'function') return;
  started = true;
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    if (getThemePref() === 'system') applyTheme();
  });
};

export const useThemePref = (): [ThemePref, (p: ThemePref) => void] => {
  const [pref, setPref] = useState<ThemePref>(getThemePref);
  useEffect(() => {
    const on = () => setPref(getThemePref());
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return [pref, setThemePref];
};
