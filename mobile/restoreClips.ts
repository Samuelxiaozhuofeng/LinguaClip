// Collects standalone clip files referenced by IndexedDB `pre` and `staged` restore snapshots
// so Android's review-clips sweep (utils/clips.ts -> sweep_clips) never deletes clips that an
// undo / swap-back or in-progress restore still needs. Any read error returns null (skip sweep).
import { clipFiles, PENDING_KEY } from '../utils/backup';
import type { ReviewCard } from '../utils/review';
import { getCopy, outsideRestore, type Copy } from './store';

export interface RestoreClipsDeps {
  outsideRestore: <T>(fn: () => Promise<T>, skip: T, wait?: boolean) => Promise<T>;
  hasPendingRestore: () => boolean;
  readCopy: (key: Copy) => Promise<unknown>;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Returns the deduplicated clip filenames (`clip.file` and `clip.image`) referenced by `pre` and
 * `staged` snapshots, or `null` when a restore is active or either snapshot cannot be read/parsed
 * (signaling the caller to skip sweeping rather than risk deleting needed clip files).
 */
export async function collectRestoreKeptClips(deps: RestoreClipsDeps): Promise<string[] | null> {
  return deps.outsideRestore(async () => {
    if (deps.hasPendingRestore()) return null;
    let copies: [unknown, unknown];
    try {
      copies = await Promise.all([deps.readCopy('pre'), deps.readCopy('staged')]);
    } catch (e) {
      console.error('[clips] skip sweep: unreadable restore snapshots', e);
      return null;
    }
    const kept = new Set<string>();
    for (const raw of copies) {
      if (raw === null || raw === undefined) continue;
      if (!isObj(raw) || !isObj(raw.review) || !Array.isArray(raw.review.cards)) {
        console.error('[clips] skip sweep: malformed restore snapshot');
        return null;
      }
      for (const file of clipFiles(raw.review.cards as Pick<ReviewCard, 'clip'>[])) {
        kept.add(file);
      }
    }
    return [...kept];
  }, null, false);
}

export function readRestoreKeptClips(): Promise<string[] | null> {
  return collectRestoreKeptClips({
    outsideRestore,
    hasPendingRestore: () => {
      try { return localStorage.getItem(PENDING_KEY) !== null; } catch { return true; }
    },
    readCopy: getCopy,
  });
}
