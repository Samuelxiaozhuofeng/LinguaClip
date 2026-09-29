// One-click update state (docs/update.md), kept outside React so closing the dialog
// never drops a download. Only the official build (`@pro` UPDATES) ever checks.
import { useSyncExternalStore } from 'react';
import { UPDATES } from '@pro';
import { appVersion, checkForUpdate, relaunchApp, type Update } from './desktop';

export type Phase =
  | 'idle' | 'checking' | 'latest' | 'failed'            // settings row only
  | 'available' | 'downloading' | 'dlFailed' | 'ready' | 'installing' | 'installFailed';

export type UpdateState = { phase: Phase; current: string; version: string; notes: string; pct: number | null; open: boolean };

let state: UpdateState = { phase: 'idle', current: '', version: '', notes: '', pct: null, open: false };
let update: Update | null = null;
let checking: Promise<void> | null = null;
const listeners = new Set<() => void>();

function set(patch: Partial<UpdateState>) {
  state = { ...state, ...patch };
  listeners.forEach(l => l());
}

export const useUpdate = (): UpdateState =>
  useSyncExternalStore(l => { listeners.add(l); return () => { listeners.delete(l); }; }, () => state);

export const updatesOn = UPDATES;
export const openUpdate = (open: boolean) => set({ open });
export const loadCurrent = () => { if (!state.current) appVersion().then(v => set({ current: v })).catch(() => {}); };

// Startup and the settings button share one request; once a newer version is
// known (or on its way), another check changes nothing.
export function checkUpdate(): Promise<void> {
  if (!UPDATES) return Promise.resolve();
  if (!['idle', 'latest', 'failed'].includes(state.phase)) return Promise.resolve();
  checking ??= (async () => {
    set({ phase: 'checking' });
    try {
      if (!state.current) set({ current: await appVersion() });
      const u = await checkForUpdate();
      if (u) {
        update = u;
        set({ phase: 'available', version: u.version, notes: u.body ?? '' });
      } else set({ phase: 'latest' });
    } catch (err) {
      console.error('update check failed', err);
      set({ phase: 'failed' });
    } finally {
      checking = null;
    }
  })();
  return checking;
}

export async function downloadUpdate(): Promise<void> {
  if (!update || (state.phase !== 'available' && state.phase !== 'dlFailed')) return;
  set({ phase: 'downloading', pct: null });
  let total = 0;
  let got = 0;
  try {
    await update.download(ev => {
      if (ev.event === 'Started') total = ev.data.contentLength ?? 0;
      if (ev.event === 'Progress') {
        got += ev.data.chunkLength;
        if (total) set({ pct: Math.min(99, Math.floor((got * 100) / total)) });
      }
    });
    set({ phase: 'ready', pct: 100 });
  } catch (err) {
    // A bad signature lands here too: the plugin refuses the package.
    console.error('update download failed', err);
    set({ phase: 'dlFailed', pct: null });
  }
}

// Only ever from the user's click. Windows quits here and its installer reopens the app.
export async function installUpdate(): Promise<void> {
  if (!update || state.phase !== 'ready') return;
  set({ phase: 'installing' });
  try {
    await update.install();
    await relaunchApp();
  } catch (err) {
    console.error('update install failed', err);
    set({ phase: 'installFailed' });
  }
}
