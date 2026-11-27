// Pure staging and reversible-undo state machine for mobile/restore.ts:
// guarantees an existing `pre` snapshot is never overwritten if taking a new snapshot,
// committing copies (e.g. QuotaExceededError on `staged`), or setting the pending marker fails;
// and snapshots current state into `pre` before undoing so an undo itself can be undone.
import { BackupProblem, checkMobile, type MobileBackup, type Pending } from './backup';

export interface StageRestoreDeps {
  hasPending: () => boolean;
  prepare: () => Promise<void>;
  snapshot: () => Promise<MobileBackup>;
  /** Atomically writes both `staged` and `pre`, returning the previous `pre` value (or null). */
  commitCopies: (staged: MobileBackup, newPre: MobileBackup) => Promise<unknown>;
  /** Restores previous `pre` (or deletes `pre` if null) and deletes `staged` when setPending fails. */
  rollbackCopies: (prevPre: unknown) => Promise<void>;
  setPending: (pending: Pending) => void;
  setIntent?: (intent: 'restore' | 'undo') => void;
  clearIntent?: () => void;
}

export interface UndoRestoreDeps extends StageRestoreDeps {
  getPre: () => Promise<unknown>;
}

const asPreProblem = (e: unknown): BackupProblem =>
  e instanceof BackupProblem ? e : new BackupProblem('pre', e instanceof Error ? e.message : String(e));

/**
 * Prepares a backup restore without clobbering an existing `pre` snapshot on any failure.
 * Returns `'already-pending'` when another restore marker is already active, else `'ready'`.
 */
export async function stageRestorePlan(
  target: MobileBackup,
  opts: { zip?: string; cross?: boolean } | undefined,
  deps: StageRestoreDeps,
): Promise<'already-pending' | 'ready'> {
  if (deps.hasPending()) return 'already-pending';
  await deps.prepare().catch(console.error);
  const now = await deps.snapshot().catch(e => { throw asPreProblem(e); });
  const prevPre = await deps.commitCopies(target, now).catch(e => { throw asPreProblem(e); });
  const pending: Pending = { use: 'staged', tries: 0 };
  if (opts?.zip) pending.zip = opts.zip;
  if (opts?.cross) pending.cross = true;
  try {
    deps.setIntent?.('restore');
    deps.setPending(pending);
  } catch (e) {
    deps.clearIntent?.();
    await deps.rollbackCopies(prevPre).catch(console.error);
    throw asPreProblem(e);
  }
  return 'ready';
}

/**
 * Prepares a reversible undo: validates the existing `pre` copy, snapshots current state as the
 * next `pre`, stages the old `pre` as `staged`, and marks PENDING_KEY with `{ use: 'staged' }`.
 * Because `run()` keeps `pre` on staged restores, the user can undo the undo to get back.
 */
export async function prepareUndoPlan(deps: UndoRestoreDeps): Promise<'already-pending' | 'ready'> {
  if (deps.hasPending()) return 'already-pending';
  const raw = await deps.getPre();
  if (raw === null) throw new BackupProblem('gone', 'pre');
  const problem = checkMobile(raw);
  if (problem) throw new BackupProblem(problem.code, problem.why);
  const oldPre = raw as MobileBackup;
  await deps.prepare().catch(console.error);
  const now = await deps.snapshot().catch(e => { throw asPreProblem(e); });
  const prevPre = await deps.commitCopies(oldPre, now).catch(e => { throw asPreProblem(e); });
  const pending: Pending = { use: 'staged', tries: 0 };
  try {
    deps.setIntent?.('undo');
    deps.setPending(pending);
  } catch (e) {
    deps.clearIntent?.();
    await deps.rollbackCopies(prevPre).catch(console.error);
    throw asPreProblem(e);
  }
  return 'ready';
}
