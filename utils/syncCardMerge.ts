/**
 * Pure per-card merge logic: bounded 8-entry FSRS revlog replay via real `schedule()`,
 * signed-timestamp saved/missed flags, mastered vs unmasteredAt/Again/Hard resolution,
 * max ankiAt, and LWW note fields preserving AI explanations (docs/sync.md).
 */
import type { Grade } from 'ts-fsrs';
import { schedule, type Reason, type ReviewCard } from './review';
import { compareStamp } from './syncClock';
import { MAX_REVLOGS, type CardRevLogEntry, type CardSyncMeta, type RevGrade } from './syncTypes';

type FsrsState = ReviewCard['fsrs'];

const REASON_ORDER: Reason[] = ['wrong', 'peek', 'breakdown', 'blur', 'saved', 'lookup', 'missed'];
const EXTRA_REASONS = new Set<Reason>(['wrong', 'peek', 'breakdown', 'blur', 'lookup']);

const DUMMY_CARD: ReviewCard = {
  id: '',
  deck: 'line',
  videoId: '',
  videoName: '',
  text: '',
  start: 0,
  end: 0,
  reasons: [],
  saved: false,
  createdAt: 0,
  fsrs: {
    due: 0,
    stability: 0,
    difficulty: 0,
    elapsed_days: 0,
    scheduled_days: 0,
    learning_steps: 0,
    reps: 0,
    lapses: 0,
    state: 0,
    last_review: undefined,
  },
};

export function sameFsrs(a?: FsrsState, b?: FsrsState): boolean {
  if (!a || !b) return false;
  return (
    a.due === b.due &&
    a.stability === b.stability &&
    a.difficulty === b.difficulty &&
    a.elapsed_days === b.elapsed_days &&
    a.scheduled_days === b.scheduled_days &&
    a.learning_steps === b.learning_steps &&
    a.reps === b.reps &&
    a.lapses === b.lapses &&
    a.state === b.state &&
    (a.last_review ?? undefined) === (b.last_review ?? undefined)
  );
}

function cloneFsrs(f: FsrsState): FsrsState {
  return f.last_review !== undefined ? { ...f } : { ...f, last_review: undefined };
}

function replayOne(state: FsrsState, grade: RevGrade, at: number): FsrsState {
  return schedule({ ...DUMMY_CARD, fsrs: state }, grade as Grade, at).fsrs;
}

function cmpLog(a: CardRevLogEntry, b: CardRevLogEntry): number {
  if (a[2] !== b[2]) return a[2] < b[2] ? -1 : 1;
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  return a[1] - b[1];
}

function normalizeLogs(logs?: CardRevLogEntry[]): CardRevLogEntry[] {
  if (!logs || logs.length === 0) return [];
  const byId = new Map<string, CardRevLogEntry>();
  for (const entry of logs) {
    if (!Array.isArray(entry) || entry.length < 3) continue;
    const prev = byId.get(entry[0]);
    if (!prev || cmpLog(entry, prev) < 0) byId.set(entry[0], [entry[0], entry[1], entry[2]]);
  }
  return Array.from(byId.values()).sort(cmpLog);
}

function unionSortedLogs(a: CardRevLogEntry[], b: CardRevLogEntry[]): CardRevLogEntry[] {
  const byId = new Map<string, CardRevLogEntry>();
  for (const entry of a) byId.set(entry[0], entry);
  for (const entry of b) {
    const prev = byId.get(entry[0]);
    if (!prev || cmpLog(entry, prev) < 0) byId.set(entry[0], entry);
  }
  return Array.from(byId.values()).sort(cmpLog);
}

function isSubsetIds(sub: CardRevLogEntry[], sup: CardRevLogEntry[]): boolean {
  if (sub.length > sup.length) return false;
  const supIds = new Set(sup.map(x => x[0]));
  return sub.every(x => supIds.has(x[0]));
}

/** Check if replaying a prefix of `logs` from `fromBase` reaches `targetBase`; returns prefix length or -1. */
function findAncestorOffset(fromBase: FsrsState, logs: CardRevLogEntry[], targetBase: FsrsState): number {
  if (sameFsrs(fromBase, targetBase)) return 0;
  let cur = fromBase;
  for (let i = 0; i < logs.length; i++) {
    cur = replayOne(cur, logs[i][1], logs[i][2]);
    if (sameFsrs(cur, targetBase)) return i + 1;
  }
  return -1;
}

/** Fallback FSRS comparator when no common base exists: (last_review ?? 0, reps, lapses, -due). */
function compareFsrsFallback(a: FsrsState, b: FsrsState): number {
  const la = a.last_review ?? 0;
  const lb = b.last_review ?? 0;
  if (la !== lb) return la < lb ? -1 : 1;
  if (a.reps !== b.reps) return a.reps < b.reps ? -1 : 1;
  if (a.lapses !== b.lapses) return a.lapses < b.lapses ? -1 : 1;
  if (a.due !== b.due) return a.due > b.due ? -1 : 1; // -due: smaller due wins
  if (a.stability !== b.stability) return a.stability < b.stability ? -1 : 1;
  if (a.difficulty !== b.difficulty) return a.difficulty < b.difficulty ? -1 : 1;
  if (a.state !== b.state) return a.state < b.state ? -1 : 1;
  return 0;
}

function replayAndTrim(
  commonBase: FsrsState,
  mergedLogs: CardRevLogEntry[],
): { fsrs: FsrsState; base: FsrsState; logs: CardRevLogEntry[] } {
  let base = cloneFsrs(commonBase);
  const excess = Math.max(0, mergedLogs.length - MAX_REVLOGS);
  for (let i = 0; i < excess; i++) {
    base = replayOne(base, mergedLogs[i][1], mergedLogs[i][2]);
  }
  const kept = mergedLogs.slice(excess);
  let fsrs = base;
  for (const [, grade, at] of kept) {
    fsrs = replayOne(fsrs, grade, at);
  }
  return { fsrs: cloneFsrs(fsrs), base, logs: kept };
}

function maxAgainHardAt(logs: CardRevLogEntry[]): number {
  let maxAt = 0;
  for (const [, grade, at] of logs) {
    if ((grade === 1 || grade === 2) && at > maxAt) maxAt = at;
  }
  return maxAt;
}

function mergeFsrs(
  a: ReviewCard,
  aMeta: CardSyncMeta,
  b: ReviewCard,
  bMeta: CardSyncMeta,
): { fsrs: FsrsState; base?: FsrsState; logs: CardRevLogEntry[]; againHardAt: number } {
  const logsA = normalizeLogs(aMeta.logs);
  const logsB = normalizeLogs(bMeta.logs);
  const allSeenAgainHard = Math.max(maxAgainHardAt(logsA), maxAgainHardAt(logsB));

  // Case 1: Both sides have a base snapshot.
  if (aMeta.base && bMeta.base) {
    if (sameFsrs(aMeta.base, bMeta.base)) {
      if (isSubsetIds(logsB, logsA) && logsA.length <= MAX_REVLOGS) {
        if (logsA.length === logsB.length && !sameFsrs(a.fsrs, b.fsrs)) {
          const r = replayAndTrim(aMeta.base, unionSortedLogs(logsA, logsB));
          return { ...r, againHardAt: allSeenAgainHard };
        }
        return { fsrs: cloneFsrs(a.fsrs), base: cloneFsrs(aMeta.base), logs: logsA, againHardAt: allSeenAgainHard };
      }
      if (isSubsetIds(logsA, logsB) && logsB.length <= MAX_REVLOGS) {
        return { fsrs: cloneFsrs(b.fsrs), base: cloneFsrs(bMeta.base), logs: logsB, againHardAt: allSeenAgainHard };
      }
      const union = unionSortedLogs(logsA, logsB);
      const r = replayAndTrim(aMeta.base, union);
      return { ...r, againHardAt: allSeenAgainHard };
    }

    // Check if one base is an ancestor of the other via folded logs.
    const bToA = findAncestorOffset(bMeta.base, logsB, aMeta.base);
    if (bToA >= 0) {
      const tailB = logsB.slice(bToA);
      if (isSubsetIds(tailB, logsA) && logsA.length <= MAX_REVLOGS) {
        return { fsrs: cloneFsrs(a.fsrs), base: cloneFsrs(aMeta.base), logs: logsA, againHardAt: allSeenAgainHard };
      }
      const r = replayAndTrim(aMeta.base, unionSortedLogs(logsA, tailB));
      return { ...r, againHardAt: allSeenAgainHard };
    }

    const aToB = findAncestorOffset(aMeta.base, logsA, bMeta.base);
    if (aToB >= 0) {
      const tailA = logsA.slice(aToB);
      if (isSubsetIds(tailA, logsB) && logsB.length <= MAX_REVLOGS) {
        return { fsrs: cloneFsrs(b.fsrs), base: cloneFsrs(bMeta.base), logs: logsB, againHardAt: allSeenAgainHard };
      }
      const r = replayAndTrim(bMeta.base, unionSortedLogs(tailA, logsB));
      return { ...r, againHardAt: allSeenAgainHard };
    }
  }

  // Case 2: One side is legacy (no base/logs) and matches the other side's base.
  if (!aMeta.base && logsA.length === 0 && bMeta.base && sameFsrs(a.fsrs, bMeta.base)) {
    return { fsrs: cloneFsrs(b.fsrs), base: cloneFsrs(bMeta.base), logs: logsB, againHardAt: allSeenAgainHard };
  }
  if (!bMeta.base && logsB.length === 0 && aMeta.base && sameFsrs(b.fsrs, aMeta.base)) {
    return { fsrs: cloneFsrs(a.fsrs), base: cloneFsrs(aMeta.base), logs: logsA, againHardAt: allSeenAgainHard };
  }

  // Case 3: No common base — deterministic fallback comparator.
  const cmp = compareFsrsFallback(a.fsrs, b.fsrs);
  if (cmp >= 0) {
    return {
      fsrs: cloneFsrs(a.fsrs),
      ...(aMeta.base ? { base: cloneFsrs(aMeta.base) } : {}),
      logs: logsA,
      againHardAt: allSeenAgainHard,
    };
  }
  return {
    fsrs: cloneFsrs(b.fsrs),
    ...(bMeta.base ? { base: cloneFsrs(bMeta.base) } : {}),
    logs: logsB,
    againHardAt: allSeenAgainHard,
  };
}

/** Merge two signed timestamps: larger |ts| wins; on equal |ts|, positive wins. */
export function mergeSignedTs(a = 0, b = 0): number {
  const absA = Math.abs(a);
  const absB = Math.abs(b);
  if (absA !== absB) return absA > absB ? a : b;
  return a >= b ? a : b;
}

function sortReasons(set: Set<Reason>): Reason[] {
  const out: Reason[] = [];
  for (const r of REASON_ORDER) {
    if (set.has(r)) out.push(r);
  }
  const extras = Array.from(set).filter(r => !REASON_ORDER.includes(r)).sort();
  return [...out, ...extras];
}

export interface MergedCardPair {
  card: ReviewCard;
  meta: CardSyncMeta;
}

/**
 * Pure card-level merge between two live versions of the same card.
 * Commutative, associative, and idempotent across all fields (except `clip`,
 * where `a.clip` is kept if already present on the first/local side).
 */
export function mergeCard(
  a: ReviewCard,
  aMeta: CardSyncMeta | undefined,
  devA: string,
  b: ReviewCard,
  bMeta: CardSyncMeta | undefined,
  devB: string,
): MergedCardPair {
  const mA: CardSyncMeta = aMeta ?? { bornAt: a.createdAt || 0 };
  const mB: CardSyncMeta = bMeta ?? { bornAt: b.createdAt || 0 };

  // 1. FSRS state + bounded revlog
  const fsrsMerged = mergeFsrs(a, mA, b, mB);

  // 2. saved & missed (signed timestamps) + union of other reasons
  const savedAt = mergeSignedTs(mA.savedAt ?? 0, mB.savedAt ?? 0);
  const missedAt = mergeSignedTs(mA.missedAt ?? 0, mB.missedAt ?? 0);

  const saved = savedAt > 0 ? true : savedAt < 0 ? false : Boolean(a.saved || b.saved);
  const missed =
    missedAt > 0
      ? true
      : missedAt < 0
        ? false
        : Boolean(a.reasons.includes('missed') || b.reasons.includes('missed'));

  const reasonSet = new Set<Reason>();
  for (const r of a.reasons) if (EXTRA_REASONS.has(r)) reasonSet.add(r);
  for (const r of b.reasons) if (EXTRA_REASONS.has(r)) reasonSet.add(r);
  if (saved) reasonSet.add('saved');
  if (missed) reasonSet.add('missed');
  const reasons = sortReasons(reasonSet);

  // 3. mastered vs unmasteredAt & replayed Again/Hard
  const maxMastered = Math.max(a.mastered ?? 0, b.mastered ?? 0);
  const unmasteredAt = Math.max(mA.unmasteredAt ?? 0, mB.unmasteredAt ?? 0, fsrsMerged.againHardAt);

  // 4. ankiAt: max
  const ankiAt = Math.max(a.ankiAt ?? 0, b.ankiAt ?? 0);

  // 5. definition / example / ai: noteAt LWW, preserving ai if winner lacks it
  const noteAtA = mA.noteAt ?? 0;
  const noteAtB = mB.noteAt ?? 0;
  const noteByA = mA.noteBy ?? devA;
  const noteByB = mB.noteBy ?? devB;
  const noteCmp =
    noteAtA === 0 && noteAtB === 0
      ? ((a.definition ? 1 : 0) - (b.definition ? 1 : 0)) || compareStamp(0, noteByA, 0, noteByB)
      : compareStamp(noteAtA, noteByA, noteAtB, noteByB);
  const noteWin = noteCmp >= 0 ? a : b;
  const noteLose = noteCmp >= 0 ? b : a;
  const mergedNoteAt = Math.max(noteAtA, noteAtB);
  const mergedNoteBy = noteCmp >= 0 ? noteByA : noteByB;

  const definition = noteWin.definition !== undefined ? noteWin.definition : noteLose.definition;
  const example = noteWin.example !== undefined ? noteWin.example : noteLose.example;
  const ai = noteWin.ai || noteLose.ai;

  // 6. Core immutable/descriptive fields (prefer earliest createdAt, deterministic tie-break)
  const createdAt =
    a.createdAt && b.createdAt ? Math.min(a.createdAt, b.createdAt) : (a.createdAt || b.createdAt || 0);
  const bornAt = Math.max(mA.bornAt || a.createdAt || 0, mB.bornAt || b.createdAt || 0);

  const pickStr = (x: string, y: string) => (!x ? y : !y ? x : x <= y ? x : y);
  const clip = a.clip ?? b.clip;

  const card: ReviewCard = {
    id: a.id,
    deck: a.deck,
    videoId: a.videoId || b.videoId,
    videoName: pickStr(a.videoName, b.videoName),
    ...(a.videoPath !== undefined ? { videoPath: a.videoPath } : b.videoPath !== undefined ? { videoPath: b.videoPath } : {}),
    text: pickStr(a.text, b.text),
    start: a.start,
    end: a.end,
    ...(a.word !== undefined ? { word: a.word } : b.word !== undefined ? { word: b.word } : {}),
    ...(definition !== undefined ? { definition } : {}),
    ...(example !== undefined ? { example } : {}),
    ...(ai ? { ai } : {}),
    reasons,
    saved,
    ...(clip ? { clip } : {}),
    ...(maxMastered > 0 && maxMastered > unmasteredAt ? { mastered: maxMastered } : {}),
    ...(ankiAt > 0 ? { ankiAt } : {}),
    fsrs: fsrsMerged.fsrs,
    createdAt,
  };

  const meta: CardSyncMeta = {
    bornAt,
    ...(fsrsMerged.base ? { base: fsrsMerged.base } : {}),
    ...(fsrsMerged.logs.length > 0 ? { logs: fsrsMerged.logs } : {}),
    ...(savedAt !== 0 ? { savedAt } : {}),
    ...(missedAt !== 0 ? { missedAt } : {}),
    ...(unmasteredAt > 0 ? { unmasteredAt } : {}),
    ...(mergedNoteAt > 0 ? { noteAt: mergedNoteAt, noteBy: mergedNoteBy } : {}),
  };

  return { card, meta };
}
