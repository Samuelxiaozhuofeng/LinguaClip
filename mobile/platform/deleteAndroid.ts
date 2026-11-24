// Android-safe record deletion order and startup orphan media/tmp cleanup (M1.3).
// Only imported in the Android build path (uses @tauri-apps/api/core invoke).
import { invoke } from '@tauri-apps/api/core';
import type { VideoRecord } from '../../types';
import { PENDING_KEY } from '../../utils/backup';
import { getAllVideosFromDB } from '../../utils/fileSystemAccess';
import { forgetVideoLocal } from '../../utils/forgetVideoLocal';
import { t } from '../../utils/i18n';
import { deleteVideoCards, getAllCards, keepOrphans, readAll, type ReviewCard } from '../../utils/review';
import * as VideoStorage from '../../utils/videoStorage';
import { deleteAudio, deleteCache, getCopy, outsideRestore } from '../store';
import { releaseSrc } from './desktop';

export { confirmPodcastDownloadNetwork } from '../opml';

const STOP_JOB_TIMEOUT_MS = 2000;

export interface DeleteAndroidDeps {
  outsideRestore: typeof outsideRestore;
  getAllCards: () => Promise<ReviewCard[]>;
  confirmKeepClips: (n: number) => boolean;
  /** Cut this video's missing card clips while it is still here (utils/clips clipVideoNow; no-op when off). */
  clipNow?: (id: string) => Promise<number>;
  stopJob?: (id: string) => Promise<void>;
  cancelRustImport: (id: string) => Promise<void>;
  deleteVideoRecord: (id: string) => Promise<void>;
  deleteVideoCards: (id: string, keep: boolean) => Promise<string[]>;
  keepOrphans: (ids: string[]) => void;
  forgetVideoLocal: (id: string) => void;
  releaseSrc: (id: string) => void;
  deleteAudio: (id: string) => Promise<void>;
  deleteCache: (id: string) => Promise<void>;
  purgeFiles: (id: string) => Promise<number>;
  stopTimeoutMs?: number;
}

async function stopWithTimeout(task: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      task.catch(() => {}),
      new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// Strict safe deletion order:
// 1. Delete IndexedDB record first
// 2. Delete or keep review cards (keep cards with clips when user confirms; never touch clips/)
// 3. Clear per-video localStorage, object URLs, and legacy mobile IDB entries
// 4. Ask Rust to purge media/<id>.*, tmp/<id>.*, and <id>.<kind>.json (never touches clips/)
const CLIP_NOW_MS = 20_000;

export async function runDeleteAndroidRecord(id: string, deps: DeleteAndroidDeps): Promise<boolean> {
  return deps.outsideRestore(async () => {
    // Cards saved a moment ago may not have their clip yet (desktop Home does the same); its count
    // is of clips really on disk. Bounded: a stalled streamed cut must not hold the delete (and the restore lock).
    const onDisk = deps.clipNow
      ? await Promise.race([deps.clipNow(id), new Promise<null>(r => setTimeout(() => r(null), CLIP_NOW_MS))]).catch(() => null)
      : null;
    const cards = await deps.getAllCards();
    const clipCount = onDisk ?? cards.filter(c => c.videoId === id && !!c.clip).length;
    const keepCards = clipCount > 0 ? deps.confirmKeepClips(clipCount) : false;

    const timeoutMs = deps.stopTimeoutMs ?? STOP_JOB_TIMEOUT_MS;
    await stopWithTimeout(
      Promise.allSettled([
        deps.stopJob ? deps.stopJob(id) : Promise.resolve(),
        deps.cancelRustImport(id),
      ]),
      timeoutMs,
    );

    // Step 1: remove the IndexedDB video record first.
    await deps.deleteVideoRecord(id);

    // Step 2: remove or keep associated review cards (preserve clip-backed cards if requested).
    const kept = await deps.deleteVideoCards(id, keepCards);
    if (kept.length > 0) deps.keepOrphans(kept);

    // Step 3: clear per-video localStorage and legacy IndexedDB audio/cache residues.
    deps.forgetVideoLocal(id);
    deps.releaseSrc(id);
    await deps.deleteAudio(id).catch(console.error);
    await deps.deleteCache(id).catch(console.error);

    // Step 4: purge private media, tmp, and JSON caches by id in Rust (never touches clips/).
    await deps.purgeFiles(id).catch(console.error);
    return true;
  }, false);
}

export function deleteAndroidRecord(
  id: string,
  opts?: { stopJob?: (id: string) => Promise<void> },
): Promise<boolean> {
  return runDeleteAndroidRecord(id, {
    outsideRestore,
    getAllCards,
    clipNow: targetId => import('../../utils/clips').then(m => m.clipVideoNow(targetId)),
    confirmKeepClips: n => (typeof confirm === 'function' ? confirm(t('m.keepClipsConfirm', { n })) : true),
    stopJob: opts?.stopJob,
    cancelRustImport: targetId => invoke<void>('cancel_import', { id: targetId }),
    deleteVideoRecord: VideoStorage.deleteVideoRecord,
    deleteVideoCards,
    keepOrphans,
    forgetVideoLocal,
    releaseSrc,
    deleteAudio,
    deleteCache,
    purgeFiles: targetId => invoke<number>('android_purge_files', { id: targetId }),
  });
}

export interface SweepOrphanDeps {
  outsideRestore: typeof outsideRestore;
  hasPendingRestore: () => boolean;
  getAllVideos: () => Promise<VideoRecord[]>;
  readAllCards: () => Promise<{ cards: ReviewCard[] }>;
  readRestoreCopies?: () => Promise<Array<{ videos?: Array<{ id?: unknown }>; review?: { cards?: Array<{ videoId?: unknown }> } } | null>>;
  sweepRust: (keepIds: string[], activeImportIds: string[]) => Promise<number>;
  logInfo?: (msg: string) => void;
}

// Startup orphan sweep guarded by all 6 safety invariants:
// 1. Runs under shared RESTORE_LOCK (no-wait, skips during restore)
// 2. Skips whenever PENDING_KEY restore marker is present
// 3. Requires both videos DB and review cards DB reads to succeed
// 4. Never sweeps on an empty video library (videos.length === 0)
// 5. Protects every video id and card videoId in keepIds
// 6. Protects every record with an importJob in activeImportIds
export async function runSweepAndroidOrphans(deps: SweepOrphanDeps): Promise<number> {
  return deps.outsideRestore(async () => {
    if (deps.hasPendingRestore()) return 0;
    let videos: VideoRecord[];
    let cards: ReviewCard[];
    try {
      [videos, { cards }] = await Promise.all([deps.getAllVideos(), deps.readAllCards()]);
    } catch (e) {
      console.error('[android] skip orphan sweep: unreadable DB', e);
      return 0;
    }
    if (videos.length === 0) {
      (deps.logInfo ?? console.info)('[android] skip orphan sweep: empty video library');
      return 0;
    }
    const keepSet = new Set<string>();
    const activeSet = new Set<string>();
    for (const v of videos) {
      if (v.id) keepSet.add(v.id);
      if (v.id && v.importJob) activeSet.add(v.id);
    }
    for (const c of cards) {
      if (c.videoId) keepSet.add(c.videoId);
    }
    if (deps.readRestoreCopies) {
      let copies: Array<{ videos?: Array<{ id?: unknown }>; review?: { cards?: Array<{ videoId?: unknown }> } } | null>;
      try {
        copies = await deps.readRestoreCopies();
      } catch (e) {
        console.error('[android] skip orphan sweep: unreadable restore copies', e);
        return 0;
      }
      for (const cp of copies) {
        if (!cp) continue;
        for (const v of cp.videos ?? []) {
          if (typeof v?.id === 'string' && v.id) keepSet.add(v.id);
        }
        for (const c of cp.review?.cards ?? []) {
          if (typeof c?.videoId === 'string' && c.videoId) keepSet.add(c.videoId);
        }
      }
    }
    const keepIds = [...keepSet];
    if (keepIds.length === 0) return 0;
    const activeImportIds = [...activeSet];
    return deps.sweepRust(keepIds, activeImportIds);
  }, 0, false);
}

export function sweepAndroidOrphans(): Promise<number> {
  return runSweepAndroidOrphans({
    outsideRestore,
    hasPendingRestore: () => {
      try { return localStorage.getItem(PENDING_KEY) !== null; } catch { return true; }
    },
    getAllVideos: () => getAllVideosFromDB() as Promise<VideoRecord[]>,
    readAllCards: readAll,
    readRestoreCopies: () => Promise.all([
      getCopy('pre'),
      getCopy('staged'),
    ]) as Promise<Array<{ videos?: Array<{ id?: unknown }>; review?: { cards?: Array<{ videoId?: unknown }> } } | null>>,
    sweepRust: (keepIds, activeImportIds) =>
      invoke<number>('android_sweep_orphans', { keepIds, activeImportIds }),
  });
}
