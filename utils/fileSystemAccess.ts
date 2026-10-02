/**
 * IndexedDB utilities for video records and subtitle storage.
 */

// IndexedDB setup
const DB_NAME = 'linguaclip_db';
const DB_VERSION = 1;
const STORE_VIDEOS = 'videos';
const STORE_FILE_HANDLES = 'fileHandles';

let dbInstance: IDBDatabase | null = null;

/**
 * Initialize IndexedDB
 */
export const initDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    if (dbInstance) {
      resolve(dbInstance);
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      reject(new Error('Failed to open IndexedDB'));
    };

    request.onsuccess = () => {
      dbInstance = request.result;
      resolve(dbInstance);
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      // Create object stores if they don't exist
      if (!db.objectStoreNames.contains(STORE_VIDEOS)) {
        db.createObjectStore(STORE_VIDEOS, { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains(STORE_FILE_HANDLES)) {
        db.createObjectStore(STORE_FILE_HANDLES, { keyPath: 'id' });
      }
    };
  });
};

// Settles once the transaction has really committed (a request's own success
// comes before that, and a full disk only shows up as an abort afterwards).
const commit = (tx: IDBTransaction, what: string): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(new Error(`Failed to ${what}: ${tx.error?.message ?? 'unknown'}`));
    tx.onabort = () => reject(new Error(`Failed to ${what}: ${tx.error?.message ?? 'aborted'}`));
  });

/**
 * Save video record to IndexedDB
 */
export const saveVideoToDB = async (videoRecord: any): Promise<void> => {
  const db = await initDB();
  const tx = db.transaction([STORE_VIDEOS], 'readwrite');
  tx.objectStore(STORE_VIDEOS).put(videoRecord);
  return commit(tx, 'save video record');
};

/**
 * Read one record and write back `change(record)` in the same transaction, so a
 * write elsewhere can't land in between and be rolled back. `change` must be
 * synchronous; returning null (or the record being gone) writes nothing.
 * Resolves with what was written, or null.
 */
export const updateVideoInDB = async (id: string, change: (record: any) => any | null): Promise<any | null> => {
  const db = await initDB();
  const tx = db.transaction([STORE_VIDEOS], 'readwrite');
  const store = tx.objectStore(STORE_VIDEOS);
  let written: any | null = null;
  let failure: unknown;
  const request = store.get(id);
  request.onsuccess = () => {
    if (!request.result) return;
    try {
      written = change(request.result);
    } catch (err) {
      failure = err;
      tx.abort();
      return;
    }
    if (written) store.put(written);
  };
  const done = commit(tx, 'update video record');
  await done.catch(err => { throw failure ?? err; });
  return written;
};

/**
 * Get all video records from IndexedDB
 */
export const getAllVideosFromDB = async (): Promise<any[]> => {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_VIDEOS], 'readonly');
    const store = transaction.objectStore(STORE_VIDEOS);
    const request = store.getAll();

    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(new Error('Failed to get video records'));
  });
};

/**
 * Get a single video record by ID
 */
export const getVideoFromDB = async (id: string): Promise<any | null> => {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_VIDEOS], 'readonly');
    const store = transaction.objectStore(STORE_VIDEOS);
    const request = store.get(id);

    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(new Error('Failed to get video record'));
  });
};

/**
 * Restore (utils/restore.ts): every record replaced by `records`, in one transaction.
 */
export const replaceAllVideos = async (records: any[]): Promise<void> => {
  const db = await initDB();
  const tx = db.transaction([STORE_VIDEOS], 'readwrite');
  const store = tx.objectStore(STORE_VIDEOS);
  store.clear();
  records.forEach(r => store.put(r));
  return commit(tx, 'replace video records');
};

/**
 * Delete video record from IndexedDB
 */
export const deleteVideoFromDB = async (id: string): Promise<void> => {
  const db = await initDB();
  const tx = db.transaction([STORE_VIDEOS], 'readwrite');
  tx.objectStore(STORE_VIDEOS).delete(id);
  return commit(tx, 'delete video record');
};

