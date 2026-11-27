// Immediate review sync for intensive-listening hard lines (docs/android.md「手机学习闭环」):
// marking a line writes addLine(..., 'missed') right away without blocking playback; unmarking
// deletes the card only if this listening session created it AND it is still unreviewed (State.New),
// not bookmarked, and has only the 'missed' reason (checked atomically in one IDB transaction);
// summary "remove from review" likewise strips only 'missed' when a card is bookmarked, has other
// reasons, or is already reviewed; re-entering an episode hydrates unmastered 'missed' cards.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Subtitle, VideoRecord } from '../types';
import {
  addLine,
  clearMastered,
  getCard,
  isNew,
  lineCardId,
  lineCardsFor,
  migrateSavedLines,
  restoreCard,
  type LineRef,
  type Removed,
  type ReviewCard,
} from '../utils/review';
import { metaOnMissedChange, notifySyncDirty, touchCardMetaInTx } from '../utils/syncMeta';
import { mergeBgMarks, type Mark } from './listenBoundaries';
import { holdCardClips, refillClipsAfterRestore } from './review/nativeRuntime';

export type HeldRemoval =
  | { kind: 'deleted'; removed: Removed; release: () => void }
  | { kind: 'stripped'; cardId: string; hadMissed: boolean; release: () => void };

export type UnmarkPlan = 'noop' | 'delete' | 'strip';

export function lineRefOf(record: VideoRecord, line: Subtitle): LineRef {
  return {
    videoId: record.id,
    videoName: record.videoFileName || record.displayName,
    videoPath: record.videoPath,
    text: line.text,
    start: line.startTime,
    end: line.endTime,
  };
}

// A line card that should show as "marked hard" when re-entering an episode.
export function isMissedLineCard(card: ReviewCard): boolean {
  return card.deck === 'line' && !card.mastered && card.reasons.includes('missed');
}

// Maps unmastered missed review cards back to Subtitle.id values for this episode.
export function missedLineIdsFromCards(lines: Subtitle[], cards: ReviewCard[]): number[] {
  const starts = new Set(cards.filter(isMissedLineCard).map(c => c.start.toFixed(2)));
  if (starts.size === 0) return [];
  return lines.filter(l => starts.has(l.startTime.toFixed(2))).map(l => l.id);
}

// True only when a card is safe to delete whole: unreviewed (State.New), not bookmarked,
// and its sole reason is 'missed'. Pre-existing saved / wrong / reviewed cards stay intact.
export function canRemoveUnmarkedCard(card: ReviewCard | null): boolean {
  if (!card) return false;
  return isNew(card) && !card.saved && card.reasons.length === 1 && card.reasons[0] === 'missed';
}

// In-listening unmark: only delete if created during this session AND still a fresh missed-only card;
// otherwise strip 'missed' (preserving bookmark, FSRS progress, other reasons, and clip).
export function planUnmarkCard(card: ReviewCard | null, createdInSession: boolean): UnmarkPlan {
  if (!card) return 'noop';
  if (createdInSession && canRemoveUnmarkedCard(card)) return 'delete';
  return card.reasons.includes('missed') ? 'strip' : 'noop';
}

// Summary "remove from review": delete whole only if fresh missed-only; otherwise strip 'missed' only.
export function planSummaryRemoveCard(card: ReviewCard | null): UnmarkPlan {
  if (!card) return 'noop';
  if (canRemoveUnmarkedCard(card)) return 'delete';
  return card.reasons.includes('missed') ? 'strip' : 'noop';
}

// --- Single-transaction IndexedDB mutations on linguaclip_review (same schema, DB_VERSION=1) ---

const REVIEW_DB = 'linguaclip_review';
const CARDS_STORE = 'cards';
const META_STORE = 'meta';
let reviewDbp: Promise<IDBDatabase> | null = null;

const openReviewDb = () => (reviewDbp ??= new Promise((resolve, reject) => {
  const req = indexedDB.open(REVIEW_DB, 1);
  req.onupgradeneeded = () => {
    for (const name of [CARDS_STORE, META_STORE]) {
      if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name, { keyPath: 'id' });
    }
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => { reviewDbp = null; reject(req.error ?? new Error('Failed to open review database')); };
}));

const txFinished = (t: IDBTransaction) => new Promise<void>((resolve, reject) => {
  t.oncomplete = () => resolve();
  t.onerror = t.onabort = () => reject(t.error ?? new Error('Review database write failed'));
});

// Trigger utils/review.ts's subscribeCards listeners after a direct IDB write (no-op update on nonexistent id).
const notifyReviewChanged = () => clearMastered('', -1).catch(() => {});

async function mutateMissedCard(
  cardId: string,
  planFor: (old: ReviewCard | null) => UnmarkPlan,
): Promise<{ removed: Removed | null; stripped: boolean }> {
  await migrateSavedLines().catch(console.error);
  const t = (await openReviewDb()).transaction([CARDS_STORE, META_STORE], 'readwrite');
  const s = t.objectStore(CARDS_STORE);
  const m = t.objectStore(META_STORE);
  let removed: Removed | null = null;
  let stripped = false;
  const g = m.get('deleted');
  const mv = m.get('migrated');
  const r = s.get(cardId);
  r.onsuccess = () => {
    const old = (r.result as ReviewCard | undefined) ?? null;
    const plan = planFor(old);
    if (plan === 'delete' && old) {
      const deletedIds: string[] = Array.isArray(g.result?.ids) ? g.result.ids : [];
      removed = { card: old, listed: deletedIds.includes(cardId), pending: !mv.result };
      s.delete(cardId);
      if (!mv.result) m.put({ id: 'deleted', ids: [...deletedIds, cardId] });
      touchCardMetaInTx(m, (cards, tomb) => metaOnMissedChange(cards, tomb, cardId, old, 'delete'));
    } else if (plan === 'strip' && old) {
      s.put({ ...old, reasons: old.reasons.filter(x => x !== 'missed') });
      touchCardMetaInTx(m, (cards, tomb) => metaOnMissedChange(cards, tomb, cardId, old, 'strip'));
      stripped = true;
    }
  };
  await txFinished(t);
  if (removed || stripped) {
    notifySyncDirty();
    await notifyReviewChanged();
  }
  return { removed, stripped };
}

async function readdMissedReason(cardId: string): Promise<boolean> {
  await migrateSavedLines().catch(console.error);
  const t = (await openReviewDb()).transaction([CARDS_STORE, META_STORE], 'readwrite');
  const s = t.objectStore(CARDS_STORE);
  const m = t.objectStore(META_STORE);
  let updated = false;
  const r = s.get(cardId);
  r.onsuccess = () => {
    const old = (r.result as ReviewCard | undefined) ?? null;
    if (old && !old.reasons.includes('missed')) {
      s.put({ ...old, reasons: [...old.reasons, 'missed'] });
      touchCardMetaInTx(m, (cards, tomb) => metaOnMissedChange(cards, tomb, cardId, old, 'readd'));
      updated = true;
    }
  };
  await txFinished(t);
  if (updated) {
    notifySyncDirty();
    await notifyReviewChanged();
  }
  return updated;
}

// Per-card FIFO chain so rapid mark -> unmark -> mark never races in IndexedDB.
const queues = new Map<string, Promise<unknown>>();
function enqueue<T>(cardId: string, task: () => Promise<T>): Promise<T> {
  const prev = queues.get(cardId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(task);
  queues.set(cardId, next);
  next.finally(() => { if (queues.get(cardId) === next) queues.delete(cardId); }).catch(() => {});
  return next;
}

// Hydrate already-marked hard lines for an episode; failures silently return [] (never block listening).
export async function loadMissedLineIds(videoId: string, lines: Subtitle[]): Promise<number[]> {
  if (!videoId || lines.length === 0) return [];
  try {
    const cards = await lineCardsFor(videoId, lines);
    return missedLineIdsFromCards(lines, cards);
  } catch {
    return [];
  }
}

// Immediately add this line to review as 'missed' (fire-and-forget + catch, never blocks playback).
// Tracks newly created card ids in `sessionCreated` so only same-session creations can be auto-deleted on unmark.
export function markLineMissed(
  record: VideoRecord,
  line: Subtitle,
  sessionCreated?: Set<string>,
): Promise<boolean> {
  if (!record.id) return Promise.resolve(false);
  const cardId = lineCardId(record.id, line.startTime);
  return enqueue(cardId, async () => {
    const existed = (await getCard(cardId)) !== null;
    await addLine(lineRefOf(record, line), 'missed');
    if (!existed) {
      sessionCreated?.add(cardId);
      return true;
    }
    return false;
  }).catch(e => { console.error('[listenMissed] addLine failed', e); return false; });
}

// Unmark this line: atomically delete ONLY if created in this session and still a fresh missed-only card;
// otherwise strip 'missed' while preserving the card, its bookmark, FSRS schedule, and clip.
export function unmarkLineMissed(
  record: VideoRecord,
  line: Subtitle,
  sessionCreated?: Set<string>,
): Promise<boolean> {
  if (!record.id) return Promise.resolve(false);
  const cardId = lineCardId(record.id, line.startTime);
  return enqueue(cardId, async () => {
    const createdHere = sessionCreated?.has(cardId) ?? false;
    const { removed } = await mutateMissedCard(cardId, old => planUnmarkCard(old, createdHere));
    if (removed) {
      sessionCreated?.delete(cardId);
      return true;
    }
    return false;
  }).catch(e => { console.error('[listenMissed] unmark failed', e); return false; });
}

// Summary "remove from review": deletes whole only if fresh missed-only (holding standalone clips until
// undo settles); otherwise strips only 'missed' so bookmarked / reviewed / multi-reason cards stay intact.
export function removeMissedFromReview(record: VideoRecord, line: Subtitle): Promise<HeldRemoval | null> {
  if (!record.id) return Promise.resolve(null);
  const cardId = lineCardId(record.id, line.startTime);
  return enqueue(cardId, async () => {
    const { removed, stripped } = await mutateMissedCard(cardId, planSummaryRemoveCard);
    if (removed) {
      const release = await holdCardClips(removed.card);
      return { kind: 'deleted', removed, release };
    }
    if (stripped) {
      return { kind: 'stripped', cardId, hadMissed: true, release: () => {} };
    }
    return null;
  }).catch(e => { console.error('[listenMissed] remove failed', e); return null; });
}

// Undo a summary removal: restores either the deleted card (preserving clip & schedule) or the stripped 'missed' reason.
export function restoreMissedToReview(
  record: VideoRecord,
  line: Subtitle,
  heldPromise?: Promise<HeldRemoval | null>,
): Promise<void> {
  if (!record.id) return Promise.resolve();
  const cardId = lineCardId(record.id, line.startTime);
  return enqueue(cardId, async () => {
    const held = heldPromise ? await heldPromise.catch(() => null) : null;
    if (held?.kind === 'deleted') {
      try {
        await restoreCard(held.removed);
        await refillClipsAfterRestore().catch(console.error);
      } finally {
        held.release();
      }
      return;
    }
    if (held?.kind === 'stripped') {
      try {
        if (held.hadMissed) await readdMissedReason(cardId);
      } finally {
        held.release();
      }
      return;
    }
    await addLine(lineRefOf(record, line), 'missed');
  }).catch(e => { console.error('[listenMissed] restore failed', e); });
}

// React state bridge for useListen: hydrates existing missed lines from review DB and syncs mark/unmark.
export function useListenMarks(
  record: VideoRecord,
  lines: Subtitle[],
  indexOf: Map<number, number>,
  say: (text: string) => void,
) {
  const [marks, setMarks] = useState<Map<number, Mark>>(() => new Map());
  const touchedRef = useRef(new Set<number>());
  const sessionCreatedRef = useRef(new Set<string>());
  const recordRef = useRef(record);
  recordRef.current = record;

  useEffect(() => {
    let cancelled = false;
    touchedRef.current.clear();
    sessionCreatedRef.current = new Set<string>();
    setMarks(new Map());
    void loadMissedLineIds(record.id, lines).then(ids => {
      if (cancelled || ids.length === 0) return;
      const fresh = ids.filter(id => !touchedRef.current.has(id));
      if (fresh.length > 0) setMarks(m => mergeBgMarks(m, fresh));
    });
    return () => { cancelled = true; };
  }, [record.id, lines]);

  const markLine = useCallback((id: number) => {
    touchedRef.current.add(id);
    const idx = indexOf.get(id);
    const line = idx !== undefined ? lines[idx] : undefined;
    setMarks(m => (m.has(id) ? m : new Map(m).set(id, 'open')));
    if (line) void markLineMissed(recordRef.current, line, sessionCreatedRef.current);
  }, [indexOf, lines]);

  const flipMark = useCallback((id: number, onMsg: string, offMsg: string) => {
    touchedRef.current.add(id);
    const idx = indexOf.get(id);
    const line = idx !== undefined ? lines[idx] : undefined;
    const wasOn = marks.has(id);
    say(wasOn ? offMsg : onMsg);
    setMarks(m => {
      const n = new Map(m);
      if (wasOn) n.delete(id);
      else n.set(id, 'open');
      return n;
    });
    if (line) {
      if (wasOn) void unmarkLineMissed(recordRef.current, line, sessionCreatedRef.current);
      else void markLineMissed(recordRef.current, line, sessionCreatedRef.current);
    }
  }, [indexOf, lines, marks, say]);

  const setMarkState = useCallback((id: number, state: Mark) => {
    touchedRef.current.add(id);
    setMarks(m => new Map(m).set(id, state));
  }, []);

  const setLineMarked = useCallback((id: number, on: boolean) => {
    touchedRef.current.add(id);
    setMarks(m => {
      const n = new Map(m);
      if (on) n.set(id, m.get(id) ?? 'open');
      else n.delete(id);
      return n;
    });
  }, []);

  const mergeBg = useCallback((lineIds: number[]) => {
    for (const id of lineIds) touchedRef.current.add(id);
    setMarks(m => mergeBgMarks(m, lineIds));
  }, []);

  return { marks, markLine, flipMark, setMarkState, setLineMarked, mergeBg };
}
