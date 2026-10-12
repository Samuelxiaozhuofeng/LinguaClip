// Phone backup and restore, the reading / writing part (docs/mobile-web.md「备份」「恢复」),
// closed the way the desktop's utils/restore.ts is. Settings only exports or gets a restore
// ready (current state → copy `pre`, the backup → copy `staged`, marker, reload); the
// replacing happens in main.tsx before the app is mounted (bootRestore). While the marker
// is there the app is not mounted: it finishes, goes back to `pre`, or the user gives up.
// Every step that writes the copies, the marker or the data holds the Web Lock
// 'linguaclip-restore', so one window restores at a time; main.tsx reloads the other windows
// when the marker comes or goes. A browser without navigator.locks just runs the step.
import { getAllVideosFromDB, replaceAllVideos } from '../utils/fileSystemAccess';
import { readAll, replaceAll } from '../utils/review';
import { PENDING_KEY } from '../utils/backup';
import { t } from '../utils/i18n';
import { BackupProblem, checkMobile, makeBackup, parseBackup, planLocal, readPending, type MobileBackup, type Pending } from './backup';
import { RESTORE_LOCK, deleteCopy, getCopy, putCopy, readAllCache, replaceAllCache } from './store';

const LOCK = RESTORE_LOCK;
const locked = <T>(fn: () => Promise<T>): Promise<T> => (navigator.locks ? navigator.locks.request(LOCK, fn) : fn());
const never = () => new Promise<never>(() => {});
const reloading = () => { location.reload(); return never(); };

const allLocal = () => {
  const o: Record<string, string> = {};
  for (const k of Object.keys(localStorage)) o[k] = localStorage.getItem(k) ?? '';
  return o;
};

// Everything as it is now, checked. Any read failing throws: never half a backup.
export async function snapshot(): Promise<MobileBackup> {
  const [videos, review, cache] = await Promise.all([getAllVideosFromDB(), readAll(), readAllCache()]);
  const b = makeBackup({ videos, cards: review.cards, meta: review.meta, local: allLocal(), cache }, Date.now());
  const p = checkMobile(b);
  if (p) throw new BackupProblem('bad', p.why);
  return b;
}

// Share sheet (iPhone: "Save to Files") when it takes files, else a download.
export async function exportBackup(): Promise<{ videos: number; cards: number } | null> {
  const b = await snapshot();
  const date = new Date(b.at).toLocaleDateString('sv-SE'); // this phone's date, YYYY-MM-DD
  const file = new File([JSON.stringify(b)], t('m.bkFileName', { date }), { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return { videos: b.videos.length, cards: b.review.cards.length };
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return null; // the user closed the sheet
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { videos: b.videos.length, cards: b.review.cards.length };
}

// A picked file → a checked backup (BackupProblem when not one). Touches no data.
export const readBackupFile = async (f: File) => parseBackup(await f.text());

// The user said yes: keep the current state, stage the backup, then reload into the restore.
// Either copy failing to save = nothing restored, nothing changed. Another window already
// restoring (its marker is there) = its copies are left alone, this one just reloads.
export const startRestore = (b: MobileBackup): Promise<void> => locked(async () => {
  if (localStorage.getItem(PENDING_KEY) !== null) return reloading();
  const why = (e: unknown) => new BackupProblem('pre', e instanceof Error ? e.message : String(e));
  const now = await snapshot().catch(e => { throw why(e); });
  await putCopy('pre', now).catch(e => { throw why(e); });
  await putCopy('staged', b).catch(e => { throw why(e); });
  localStorage.setItem(PENDING_KEY, JSON.stringify({ use: 'staged', tries: 0 } satisfies Pending));
  return reloading(); // the lock goes with the page
});

// Replaces records, cards, settings and caches with the copy `use` points at. Throws on any
// failure; the marker stays.
async function run(p: Pending): Promise<void> {
  localStorage.setItem(PENDING_KEY, JSON.stringify({ ...p, tries: p.tries + 1 }));
  const raw = await getCopy(p.use);
  if (raw === null) throw new BackupProblem('gone', p.use);
  const problem = checkMobile(raw);
  if (problem) throw new BackupProblem(problem.code, problem.why);
  const b = raw as MobileBackup;
  await replaceAllVideos(b.videos);
  await replaceAll(b.review.cards.map(c => (Array.isArray(c.reasons) ? c : { ...c, reasons: [] })), b.review.meta);
  const plan = planLocal(allLocal(), b.local);
  for (const [k, v] of plan.set) localStorage.setItem(k, v);
  for (const k of plan.remove) localStorage.removeItem(k);
  await replaceAllCache(b.cache);
  localStorage.removeItem(PENDING_KEY);
  await deleteCopy('staged').catch(console.error);
  location.reload();
}

export const describe = (e: unknown) => {
  if (!(e instanceof BackupProblem)) return e instanceof Error ? e.message : String(e);
  if (e.code === 'desktop') return t('m.bkDesktop');
  if (e.code === 'newer') return t('backup.newer');
  if (e.code === 'pre') return t('restore.preFailed', { why: e.message });
  if (e.code === 'gone') return t('m.bkGone');
  return t('backup.bad', { why: e.message });
};

export type Boot = { ok: boolean; pending: Pending | null; error: string | null; waiting?: boolean };

// Before render: no marker → start the app. Another window holding the lock = it is
// restoring: "wait" until it lets go, then start over. A marker already tried once (the page
// may have died during it) is not run again by itself: the failure screen asks.
export async function bootRestore(): Promise<Boot> {
  if (localStorage.getItem(PENDING_KEY) === null) return { ok: true, pending: null, error: null };
  if (!navigator.locks) return boot();
  return navigator.locks.request(LOCK, { ifAvailable: true }, async lock => {
    if (lock) return boot();
    void navigator.locks.request(LOCK, async () => { location.reload(); });
    return { ok: false, pending: null, error: null, waiting: true };
  });
}

// Holding the lock (or no locks at all): the marker read again, as it is now.
async function boot(): Promise<Boot> {
  const p = readPending(localStorage.getItem(PENDING_KEY));
  if (p === null) return { ok: true, pending: null, error: null };
  if (p === 'unreadable') return { ok: false, pending: null, error: t('restore.marker') };
  if (p.tries >= 1) return { ok: false, pending: p, error: null };
  try {
    await run(p);
    return never(); // reloading
  } catch (e) {
    console.error('restore failed', e);
    const now = readPending(localStorage.getItem(PENDING_KEY));
    return { ok: false, pending: now === 'unreadable' ? null : now, error: describe(e) };
  }
}

// The failure screen's buttons. Each resolves only on failure (success reloads). Under the
// lock the marker is read again: another window may have finished or given up meanwhile
// (no marker: just reload), or switched it to `pre`.
export const currentPending = () => { const p = readPending(localStorage.getItem(PENDING_KEY)); return p === 'unreadable' ? null : p; };
export const retryRestore = () => locked(async () => {
  const p = currentPending();
  if (!p) return reloading();
  await run(p);
  return never();
});
export const restorePre = () => locked(async () => {
  if (localStorage.getItem(PENDING_KEY) === null) return reloading();
  await run({ use: 'pre', tries: 0 });
  return never();
});
export const abandonRestore = () => locked(async () => {
  localStorage.removeItem(PENDING_KEY);
  await deleteCopy('staged').catch(console.error);
  return reloading();
});
