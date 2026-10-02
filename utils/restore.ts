/**
 * Restoring a backup = replacing everything (docs/backup.md). Settings only gets it
 * ready (openBackup → startRestore: check, save the current state, leave a marker,
 * reload); the replacing itself happens in index.tsx before the app is mounted
 * (bootRestore), when nothing else writes. While the marker is there the app is not
 * mounted: it either finishes, goes back to the before-restore copy, or the user
 * gives up on purpose.
 */
import { getAllVideosFromDB, replaceAllVideos } from './fileSystemAccess';
import { readAll, replaceAll } from './review';
import { appVersion, backupRead, backupRemove, backupStage, backupUnpack, ownDir } from './desktop';
import {
  LICENSE_KEY, PENDING_KEY, STAGED, checkBackup, planLocalStorage, remapPath,
  type Data, type Manifest, type Pending, type Problem,
} from './backup';
import { autoBackup, saveBackup } from './backupData';
import { dialog } from '../components/Dialog';
import { t } from './i18n';

const NOTE = 'linguaclip_restored'; // sessionStorage: what to say once the app is back up

export class RestoreError extends Error {
  constructor(readonly code: 'newer' | 'bad' | 'busy' | 'pre', why: string) { super(why); }
}

const parse = async (path: string, version: string) => {
  const raw = await backupRead(path).catch(e => { throw new RestoreError('bad', String(e)); });
  let manifest: unknown, data: unknown;
  try { manifest = JSON.parse(raw.manifest); data = JSON.parse(raw.data); } catch { throw new RestoreError('bad', 'json'); }
  const problem: Problem = checkBackup(manifest, data, version);
  if (problem) throw new RestoreError(problem.newer ? 'newer' : 'bad', problem.why);
  return { manifest: manifest as Manifest, data: data as Data };
};

const dropStaged = () => backupRemove([STAGED]).catch(console.error);

export interface Candidate { staged: string; manifest: Manifest; now: { videos: number; cards: number } }

// Picked file (anywhere, backups/ included) → copied to backups/restore-staged.zip, read and checked.
// The original is never touched, so rotation can't take what is being restored. Touches no data.
export async function openBackup(path: string): Promise<Candidate> {
  const staged = await backupStage(path);
  try {
    const { manifest } = await parse(staged, await appVersion());
    const [videos, review] = await Promise.all([getAllVideosFromDB(), readAll()]);
    return { staged, manifest, now: { videos: videos.length, cards: review.cards.length } };
  } catch (e) {
    await dropStaged();
    throw e;
  }
}

export const cancelBackup = () => dropStaged();

// The user said yes: refuse while an import runs, keep the current state, then reload into the restore.
export async function startRestore(c: Candidate): Promise<void> {
  const importing = (await getAllVideosFromDB()).some(r => r.importJob && !r.importJob.error);
  if (importing) throw new RestoreError('busy', 'import');
  const pre = await saveBackup('pre') // fails: nothing touched
    .catch(e => { throw new RestoreError('pre', e instanceof Error ? e.message : String(e)); });
  const pending: Pending = { staged: c.staged, pre: pre?.path ?? null, use: 'staged', tries: 0 };
  localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  location.reload();
}

// --- At app start ---

export const readPending = (): Pending | null | 'unreadable' => {
  const raw = localStorage.getItem(PENDING_KEY);
  if (raw === null) return null;
  try {
    const p = JSON.parse(raw);
    return p && typeof p.staged === 'string' && (p.use === 'staged' || p.use === 'pre') ? { pre: null, tries: 0, ...p } : 'unreadable';
  } catch { return 'unreadable'; }
};

// Steps 5–10 of docs/backup.md, with the backup `use` points at. Throws on any failure; the marker stays.
async function run(p: Pending): Promise<void> {
  localStorage.setItem(PENDING_KEY, JSON.stringify({ ...p, tries: p.tries + 1 }));
  const path = p.use === 'pre' && p.pre ? p.pre : p.staged;
  const { manifest, data } = await parse(path, await appVersion());
  const own = await ownDir();
  const move = <T extends { videoPath?: unknown }>(x: T): T =>
    typeof x.videoPath === 'string' ? { ...x, videoPath: remapPath(x.videoPath, manifest.ownDir, own) } : x;
  if (manifest.files) await backupUnpack(path);
  await replaceAllVideos(data.videos.map(move));
  // An old card without its reasons list: review.ts filters / searches it, so give it one.
  await replaceAll(data.cards.map(move).map(c => (Array.isArray(c.reasons) ? c : { ...c, reasons: [] })), data.reviewMeta);
  const current: Record<string, string> = {};
  for (const k of Object.keys(localStorage)) current[k] = localStorage.getItem(k) ?? '';
  const plan = planLocalStorage(current, data.localStorage);
  for (const [k, v] of plan.set) localStorage.setItem(k, v);
  for (const k of plan.remove) localStorage.removeItem(k);
  localStorage.removeItem(PENDING_KEY);
  await backupRemove([STAGED]).catch(console.error);
  const relicense = manifest.hadLicense && localStorage.getItem(LICENSE_KEY) === null;
  try { sessionStorage.setItem(NOTE, JSON.stringify({ videos: manifest.videos, cards: manifest.cards, relicense })); } catch { /* only the note is lost */ }
  location.reload();
}

// What went wrong, in words for the user.
export const describe = (e: unknown) =>
  e instanceof RestoreError ? (e.code === 'newer' ? t('backup.newer') : e.code === 'busy' ? t('backup.busy')
      : e.code === 'pre' ? t('restore.preFailed', { why: e.message }) : t('backup.bad', { why: e.message }))
    : e instanceof Error ? e.message : String(e);

export type Boot = { ok: true } | { ok: false; pending: Pending | null; error: string | null };

// Before render: no marker → start the app. A marker that has already been tried once (the
// window may have died during it) is not run again by itself: the failure screen asks.
export async function bootRestore(): Promise<Boot> {
  const p = readPending();
  if (p === null) return { ok: true };
  if (p === 'unreadable') return { ok: false, pending: null, error: t('restore.marker') };
  if (p.tries >= 1) return { ok: false, pending: p, error: null };
  try {
    await run(p);
    return new Promise(() => {}); // reloading
  } catch (e) {
    console.error('restore failed', e);
    return { ok: false, pending: readPending() as Pending, error: describe(e) };
  }
}

// The failure screen's buttons. Each resolves only on failure (success reloads).
export const retryRestore = (p: Pending) => run(p).then(() => new Promise<never>(() => {}));
export const restorePre = (p: Pending) => run({ ...p, use: 'pre', tries: 0 }).then(() => new Promise<never>(() => {}));
export async function abandonRestore(): Promise<void> {
  localStorage.removeItem(PENDING_KEY);
  await backupRemove([STAGED]).catch(console.error);
  location.reload();
}

// After the app is up: say a finished restore once, then (later, in the background) the daily backup.
export function afterStart() {
  let note: { videos: number; cards: number; relicense: boolean } | null = null;
  try {
    note = JSON.parse(sessionStorage.getItem(NOTE) ?? 'null');
    sessionStorage.removeItem(NOTE);
  } catch { /* nothing to say */ }
  if (note) {
    const body = t('restore.doneBody', { videos: note.videos, cards: note.cards }) + (note.relicense ? `\n\n${t('restore.relicense')}` : '');
    setTimeout(() => { dialog.alert(t('restore.doneTitle'), body); }, 800); // once the dialog host is mounted
  }
  setTimeout(() => { autoBackup(); }, 10_000);
}
