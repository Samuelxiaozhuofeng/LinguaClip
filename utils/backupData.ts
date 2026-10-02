/**
 * Making backups (docs/backup.md): read everything with reads that throw, check it,
 * write the zip, drop old automatic ones. The daily automatic one starts from
 * index.tsx after the app is up; it never blocks anything and fails quietly
 * (Settings shows "last automatic backup failed").
 */
import { getAllVideosFromDB } from './fileSystemAccess';
import { readAll } from './review';
import { appVersion, backupList, backupRemove, backupWrite, ownDir } from './desktop';
import { IS_WINDOWS } from './platform';
import {
  FORMAT, LICENSE_KEY, PENDING_KEY, SECRET_KEYS, backupKeys, checkBackup, clipFiles, dueForAuto, isEmpty, rotate,
  type Data, type Kind, type Listed, type Manifest,
} from './backup';

// Everything as it is now. Any read failing throws: nothing is written then.
export async function snapshot(kind: Kind): Promise<{ manifest: Manifest; data: Data }> {
  const [videos, review, app, own] = await Promise.all([getAllVideosFromDB(), readAll(), appVersion(), ownDir()]);
  const ls: Record<string, string> = {};
  for (const k of backupKeys(Object.keys(localStorage))) {
    if (kind !== 'manual' && SECRET_KEYS.includes(k)) continue;
    const v = localStorage.getItem(k);
    if (v !== null) ls[k] = v;
  }
  const data: Data = { videos, cards: review.cards, reviewMeta: review.meta, localStorage: ls };
  const manifest: Manifest = {
    format: FORMAT, app, createdAt: Date.now(), platform: IS_WINDOWS ? 'windows' : 'mac', ownDir: own,
    videos: videos.length, cards: review.cards.length, hadLicense: localStorage.getItem(LICENSE_KEY) !== null,
    files: kind === 'manual', clips: clipFiles(review.cards),
  };
  return { manifest, data };
}

export class BackupError extends Error {}

// Backups readable in <own dir>/backups, newest first; an unparsable manifest is left out.
export async function listBackups(): Promise<Listed[]> {
  return (await backupList()).flatMap(l => {
    try { return [{ path: l.path, manifest: JSON.parse(l.manifest) as Manifest }]; } catch { return []; }
  });
}

// Writes one backup and returns its path and contents; null = nothing to keep (automatic /
// before-restore with no records and no cards).
export async function saveBackup(kind: Kind, dest: string | null = null) {
  const { manifest, data } = await snapshot(kind);
  const problem = checkBackup(manifest, data, manifest.app);
  if (problem) throw new BackupError(problem.why);
  if (kind !== 'manual' && isEmpty(data)) return null;
  const path = await backupWrite(dest, kind === 'pre' ? 'pre' : 'auto', JSON.stringify(manifest), JSON.stringify(data), kind === 'manual');
  if (kind !== 'manual') {
    const drop = rotate(await listBackups());
    if (drop.length) await backupRemove(drop).catch(console.error); // a backup still came out
  }
  return { path, manifest };
}

// --- The daily one, and what Settings shows about it ---

type AutoState = { last: number | null; failed: boolean };
let state: AutoState = { last: null, failed: false };
const listeners = new Set<() => void>();
const set = (p: Partial<AutoState>) => { state = { ...state, ...p }; listeners.forEach(fn => fn()); };
export const getAutoState = () => state;
export const subscribeAuto = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const noteLastAuto = (last: number | null) => set({ last });

let running: Promise<void> | null = null; // StrictMode / a second call share one run
export const autoBackup = () => running ??= (async () => {
  try {
    if (!dueForAuto(await listBackups(), Date.now(), localStorage.getItem(PENDING_KEY) !== null)) return;
    const done = await saveBackup('auto');
    set({ failed: false, ...(done && { last: done.manifest.createdAt }) });
  } catch (e) {
    console.error('automatic backup failed', e);
    set({ failed: true });
  }
})();
