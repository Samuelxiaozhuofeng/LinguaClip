// The phone's own IndexedDB `linguaclip_audio` (docs/mobile-web.md「存哪」): audio
// files picked on the phone (`audio`, key = record id), the per-record caches the
// desktop keeps as <id>.<kind>.json (`cache`, key `id|kind`), and the before-restore
// copy (`pre`, used by the restore step). Records and cards stay in linguaclip_db /
// linguaclip_review through utils/.
import type { CacheKind } from '../utils/desktop';
import { getAllVideosFromDB } from '../utils/fileSystemAccess';
import { PENDING_KEY } from '../utils/backup';
import { readAll } from '../utils/review';
import { orphanAudio, type MobileBackup } from './backup';

export type StoredAudio = { blob: Blob; name: string; type: string };

const DB = 'linguaclip_audio';
const STORES = ['audio', 'cache', 'pre'] as const;
type Store = (typeof STORES)[number];

let opening: Promise<IDBDatabase> | null = null;
const db = () => (opening ??= new Promise<IDBDatabase>((resolve, reject) => {
  const req = indexedDB.open(DB, 1);
  req.onupgradeneeded = () => { for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s); };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => { opening = null; reject(req.error ?? new Error('cannot open linguaclip_audio')); };
}));

const settle = (tx: IDBTransaction, store: Store) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error ?? new Error(`${store} failed`));
  tx.onabort = () => reject(tx.error ?? new Error(`${store} aborted`));
});

// Settles once the transaction has committed; the request's result.
async function run<T>(store: Store, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | void): Promise<T> {
  const tx = (await db()).transaction(store, mode);
  const req = fn(tx.objectStore(store));
  await settle(tx, store);
  return (req ? req.result : undefined) as T;
}

export const putAudio = (id: string, a: StoredAudio) => run<void>('audio', 'readwrite', s => { s.put(a, id); });
export const getAudio = async (id: string) => (await run<StoredAudio | undefined>('audio', 'readonly', s => s.get(id))) ?? null;
export const deleteAudio = (id: string) => run<void>('audio', 'readwrite', s => { s.delete(id); });
export const audioIds = async () => (await run<IDBValidKey[]>('audio', 'readonly', s => s.getAllKeys())).map(String);

const cacheKey = (id: string, kind: CacheKind) => `${id}|${kind}`;
export const readCache = async (id: string, kind: CacheKind) =>
  (await run<string | undefined>('cache', 'readonly', s => s.get(cacheKey(id, kind)))) ?? null;
export const writeCache = (id: string, kind: CacheKind, text: string) =>
  run<void>('cache', 'readwrite', s => { s.put(text, cacheKey(id, kind)); });
// Every cache of this one record ('|' sorts below every character a kind uses).
export const deleteCache = (id: string) =>
  run<void>('cache', 'readwrite', s => { s.delete(IDBKeyRange.bound(`${id}|`, `${id}|￿`)); });

// Every cache entry (backup), and the whole table replaced in one transaction (restore).
export async function readAllCache(): Promise<Record<string, string>> {
  const tx = (await db()).transaction('cache', 'readonly');
  const keys = tx.objectStore('cache').getAllKeys(), values = tx.objectStore('cache').getAll();
  await settle(tx, 'cache');
  return Object.fromEntries(keys.result.map((k, i) => [String(k), values.result[i] as string]));
}
export async function replaceAllCache(cache: Record<string, string>): Promise<void> {
  const tx = (await db()).transaction('cache', 'readwrite');
  const s = tx.objectStore('cache');
  s.clear();
  for (const [k, v] of Object.entries(cache)) s.put(v, k);
  await settle(tx, 'cache');
}

// The restore's two copies in `pre`: `pre` = this phone before the last restore (one kept),
// `staged` = the backup being restored (gone once it finished or was given up).
export type Copy = 'pre' | 'staged';
export const putCopy = (key: Copy, b: MobileBackup) => run<void>('pre', 'readwrite', s => { s.put(b, key); });
export const getCopy = async (key: Copy) => (await run<unknown>('pre', 'readonly', s => s.get(key))) ?? null;
export const deleteCopy = (key: Copy) => run<void>('pre', 'readwrite', s => { s.delete(key); });

// Audio no record or card points at: a delete whose last step failed. Audio keys are read
// before the records, and an import writes its record before its audio, so audio
// saved meanwhile is never taken for an orphan. Audio the restore copies point at is
// kept, and nothing is swept while a restore is under way. Unreadable records, cards or
// copies throw: nothing swept.
export const sweepAudio = (): Promise<string[]> => outsideRestore(sweep, [], false); // restoring: skip, don't wait
async function sweep(): Promise<string[]> {
  const keys = await audioIds();
  const records = await getAllVideosFromDB();
  const { cards } = await readAll();
  const copies = await Promise.all([getCopy('pre'), getCopy('staged')]);
  const orphans = orphanAudio(keys, records, cards, copies.filter(c => c !== null) as MobileBackup[]);
  for (const id of orphans) await deleteAudio(id);
  return orphans;
}

// A restore (mobile/restore.ts) holds this lock alone; deleting and sweeping hold it shared, so
// the restore's snapshot never sees half a delete and no audio goes while it is staged. Once
// its marker is set they do nothing (every window reloads on it). No navigator.locks: no lock.
export const RESTORE_LOCK = 'linguaclip-restore';
export const outsideRestore = <T>(fn: () => Promise<T>, skip: T, wait = true): Promise<T> => {
  const go = (held: unknown) => (held === null || localStorage.getItem(PENDING_KEY) !== null ? Promise.resolve(skip) : fn());
  return navigator.locks ? navigator.locks.request(RESTORE_LOCK, { mode: 'shared', ifAvailable: !wait }, go) : go(true);
};

// Once per page load: ask the browser not to evict our data (a no is fine), then sweep.
export async function startStore(): Promise<void> {
  await navigator.storage?.persist?.().catch(() => false);
  await sweepAudio().catch(console.error); // a sweep that fails just doesn't sweep
}
