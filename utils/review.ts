/**
 * In-app review: the sentence deck and the word deck, scheduled with FSRS.
 *
 * Cards live in their own IndexedDB database (`linguaclip_review`) so the
 * practice records' database (and its DB_VERSION) is never touched. Each card
 * carries its own copy of the line, its times and the video path. Deleting a
 * video deletes its cards too (deleteVideoCards).
 *
 * The learner grades each card with FSRS's four buttons; a sentence card's
 * dictation only suggests one (gradeOf).
 */
import { createEmptyCard, fsrs, Rating, State, type Card, type Grade } from 'ts-fsrs';
import { parseSRT } from './srtParser';
import { readDeferred, deferredAt, type Deferred } from './reviewDefer';
import { getAllVideosFromDB, getVideoFromDB } from './fileSystemAccess';
import type { SavedLine } from '../types';
import * as SM from './syncMeta';
import type { RevGrade } from './syncTypes';

export type Deck = 'line' | 'word';
// Files in <own dir>/clips; `from` = where the file starts in the source video, in seconds.
export interface Clip { kind: 'video' | 'audio'; file: string; image?: string; from: number }
export type Reason = 'wrong' | 'peek' | 'breakdown' | 'blur' | 'saved' | 'lookup' | 'missed'; // missed: marked hard while listening (pro/ListenPage.tsx)

type Stored<T> = { [K in keyof T]: T[K] extends Date ? number : T[K] extends Date | undefined ? number | undefined : T[K] };

export interface ReviewCard {
  id: string;
  deck: Deck;
  videoId: string;       // '' for an old bookmark that matched no video
  videoName: string;
  videoPath?: string;    // snapshot; the video record's current path wins at review time
  text: string;          // the subtitle line
  start: number;         // seconds; -1 = no audio (unmatched old bookmark)
  end: number;
  word?: string;         // word deck only
  definition?: string;
  example?: string;
  ai?: string;           // the AI's word on this line (plain text): what it means here, the cultural meaning
  reasons: Reason[];
  saved: boolean;        // bookmarked by hand
  clip?: Clip;           // its own copy of the line (utils/clips.ts), so it plays after the video is deleted
  mastered?: number;     // marked "got it" in review (when): out of review until the line trips the learner up again (docs/review.md)
  ankiAt?: number;       // sent to Anki from the card library (when; docs/anki-export.md)
  fsrs: Stored<Card>;
  createdAt: number;
}

// How a dictation went. `helped` = peeked or replayed from a word.
export interface Outcome { correct: boolean; helped: boolean }

export const SESSION_SIZE = 15;

// Intervals in whole days: no minute-level steps, so finishing a round never
// leaves "due now" cards behind on the home screen.
const scheduler = fsrs({ enable_fuzz: true, enable_short_term: false });

export const gradeOf = (o: Outcome): Grade => (!o.correct ? Rating.Again : o.helped ? Rating.Hard : Rating.Good);

const toStored = (c: Card): Stored<Card> => ({ ...c, due: +c.due, last_review: c.last_review ? +c.last_review : undefined });
const fromStored = (c: Stored<Card>): Card => ({ ...c, due: new Date(c.due), last_review: c.last_review ? new Date(c.last_review) : undefined });

export const lineCardId = (videoId: string, start: number) => `${videoId}|${start.toFixed(2)}`;
export const wordCardId = (videoId: string, start: number, word: string) => `${lineCardId(videoId, start)}|w|${word.toLowerCase()}`;

export const hasAudio = (c: ReviewCard) => c.start >= 0 && !!c.videoId;

// --- Pure scheduling (checked by test-review.mjs) ---

export const newCard = (base: Omit<ReviewCard, 'fsrs' | 'createdAt' | 'reasons' | 'saved'>, reason: Reason, now = Date.now()): ReviewCard => ({
  ...base,
  reasons: [reason],
  saved: reason === 'saved',
  fsrs: toStored(createEmptyCard(new Date(now))),
  createdAt: now,
});

// Without the "got it" mark (the key removed, not set to undefined).
const unmastered = ({ mastered: _, ...card }: ReviewCard): ReviewCard => card;
const STUCK: Reason[] = ['wrong', 'peek', 'breakdown', 'blur', 'missed'];

// Meeting a card again while practising only notes why; it never resets the schedule.
// Getting stuck on it again takes off "got it"; bookmarking doesn't.
export const withReason = (card: ReviewCard, reason: Reason): ReviewCard => ({
  ...(STUCK.includes(reason) ? unmastered(card) : card),
  reasons: card.reasons.includes(reason) ? card.reasons : [...card.reasons, reason],
  saved: card.saved || reason === 'saved',
});

export const schedule = (card: ReviewCard, o: Outcome | Grade, now = Date.now()): ReviewCard => ({
  ...card,
  fsrs: toStored(scheduler.next(fromStored(card.fsrs), new Date(now), typeof o === 'number' ? o : gradeOf(o)).card),
});

// When each button would bring the card back. Fuzz is seeded from `now`, so the
// grade must be recorded with the same `now` for the days shown to be the days kept.
export const previewDue = (card: ReviewCard, now: number): Record<Grade, number> => {
  const r = scheduler.repeat(fromStored(card.fsrs), new Date(now));
  return { [Rating.Again]: +r[Rating.Again].card.due, [Rating.Hard]: +r[Rating.Hard].card.due, [Rating.Good]: +r[Rating.Good].card.due, [Rating.Easy]: +r[Rating.Easy].card.due } as Record<Grade, number>;
};

// In the review rotation at all: has audio and not marked "got it" (docs/review.md).
export const inReview = (c: ReviewCard) => hasAudio(c) && !c.mastered;
export const isDue = (c: ReviewCard, now = Date.now()) => inReview(c) && c.fsrs.due <= now;

// 没打分就离开过的卡排在后面，按推后时间先后；其余照旧按 due（deck === 'all' 时先句子后单词，docs/review.md「没打分的卡排到后面」）。
export const dueQueue = (cards: ReviewCard[], deck: Deck | 'all', now = Date.now(), limit = SESSION_SIZE, deferred: Deferred = readDeferred()) =>
  cards.filter(c => (deck === 'all' || c.deck === deck) && isDue(c, now))
    .map(c => ({ c, d: deferredAt(deferred, c.id, c.fsrs.last_review) }))
    .sort((a, b) => {
      if (a.d !== undefined || b.d !== undefined) return a.d === undefined ? -1 : b.d === undefined ? 1 : a.d - b.d;
      if (deck === 'all' && a.c.deck !== b.c.deck) return a.c.deck === 'line' ? -1 : 1;
      return a.c.fsrs.due - b.c.fsrs.due;
    })
    .slice(0, limit).map(x => x.c);

export const isNew = (c: ReviewCard) => c.fsrs.state === State.New;

export interface AddLineResult { id: string; created: boolean; addedReason: boolean; prevMastered?: number }

// Pure decision for safely undoing an auto-added line card without losing clips, bookmarks, or reviews.
// Returns null to delete, a new ReviewCard (spreading cur to keep clip) to update, or undefined for no-op.
export const revertAddedLine = (cur: ReviewCard, res: AddLineResult, reason: Reason): ReviewCard | null | undefined => {
  if (res.created && isNew(cur) && !cur.saved && cur.reasons.length === 1 && cur.reasons[0] === reason) return null;
  let dirty = false;
  let next: ReviewCard = { ...cur };
  if (res.addedReason && next.reasons.includes(reason)) {
    next = { ...next, reasons: next.reasons.filter(r => r !== reason) };
    dirty = true;
  }
  if (res.prevMastered !== undefined && !next.mastered) {
    next = { ...next, mastered: res.prevMastered };
    dirty = true;
  }
  return dirty ? next : undefined;
};

// "Remembered" on the home screen: a line likely still recalled a week from now, or marked "got it".
export const REMEMBERED_DAYS = 7;
export const isRemembered = (c: ReviewCard) => c.deck === 'line' && hasAudio(c) && (!!c.mastered || c.fsrs.stability >= REMEMBERED_DAYS);

// Which boxes to blank in a word card: the first token equal to the word,
// ignoring case and punctuation. A Japanese word kept under another split
// (天気 vs 天気ですね, or a whole line kept by an older version) blanks every box
// it overlaps in the line.
export const wordBoxes = (words: string[], word: string): number[] => {
  const norm = (w: string) => w.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}'’-]/gu, ''); // NFC: a decomposed accent is not dropped
  const i = words.findIndex(w => norm(w) === norm(word));
  if (i >= 0 || !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(word + words.join(''))) return [Math.max(i, 0)];
  const at = words.join('').indexOf(word);
  if (at < 0) return [0];
  let start = 0;
  return words.flatMap((w, k) => {
    const hit = start < at + word.length && start + w.length > at;
    start += w.length;
    return hit ? [k] : [];
  });
};

export const wordIndexIn = (words: string[], word: string): number => wordBoxes(words, word)[0];

// Old bookmark (text + file name + mm:ss) → the line it came from, or null.
export const matchLegacy = (
  line: { text: string; videoName?: string; timeDisplay: string },
  records: { id: string; videoFileName: string; displayName: string; videoPath?: string; subtitleText?: string }[],
) => {
  const [m, s] = line.timeDisplay.split(':').map(Number);
  const at = (m || 0) * 60 + (s || 0);
  let best: { record: typeof records[number]; start: number; end: number; gap: number } | null = null;
  for (const record of records) {
    if (record.videoFileName !== line.videoName || !record.subtitleText) continue;
    for (const sub of parseSRT(record.subtitleText)) {
      if (sub.text !== line.text) continue;
      const gap = Math.abs(sub.startTime - at);
      if (!best || gap < best.gap) best = { record, start: sub.startTime, end: sub.endTime, gap };
    }
  }
  return best;
};

// --- Storage ---

const DB_NAME = 'linguaclip_review';
const STORE = 'cards';
const META = 'meta'; // { id: 'migrated' } once the old bookmarks are in, written in the same transaction
let dbp: Promise<IDBDatabase> | null = null;

const db = () => dbp ??= new Promise((resolve, reject) => {
  const req = indexedDB.open(DB_NAME, 1);
  req.onupgradeneeded = () => {
    for (const name of [STORE, META]) if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name, { keyPath: 'id' });
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => { dbp = null; reject(req.error ?? new Error('Failed to open review database')); };
});

// Every read and write waits for the old-bookmark move, so a card written while
// it runs can't be overwritten by it (or overwrite it). A failed move doesn't block.
const tx = async <T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> => {
  await migrateSavedLines().catch(console.error);
  const t = (await db()).transaction(STORE, mode);
  const req = run(t.objectStore(STORE));
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = t.onabort = () => reject(t.error ?? new Error('Review database write failed'));
  });
};

const finished = (t: IDBTransaction) => new Promise<void>((resolve, reject) => {
  t.oncomplete = () => resolve();
  t.onerror = t.onabort = () => reject(t.error ?? new Error('Review database write failed'));
});

// While the old-bookmark move hasn't landed (it failed and will retry), note the ids the
// user deleted or un-bookmarked, so the move skips them instead of bringing them back.
// Same transaction as the delete; cleared when the move lands.
const forget = (t: IDBTransaction, ids: string[]) => {
  const m = t.objectStore(META);
  const done = m.get('migrated');
  done.onsuccess = () => {
    if (done.result) return;
    const g = m.get('deleted');
    g.onsuccess = () => m.put({ id: 'deleted', ids: [...(g.result?.ids ?? []), ...ids] });
  };
};

// Read, merge and write one card inside a single transaction, so two writes to
// the same card (stuck + bookmarked at once) queue up instead of the later one
// clobbering the earlier. `next` returns the new card, null to delete, undefined to leave it.
// `forgetIt` = the user took this card (or its bookmark) away; see forget().
const update = async (id: string, next: (old: ReviewCard | null) => ReviewCard | null | undefined, forgetIt = false, metaEdit?: SM.CardMetaEdit) => {
  await migrateSavedLines().catch(console.error);
  const t = (await db()).transaction([STORE, META], 'readwrite');
  const s = t.objectStore(STORE);
  let wrote = false;
  const r = s.get(id);
  r.onsuccess = () => {
    const old = (r.result as ReviewCard | undefined) ?? null, card = next(old);
    if (card === undefined) return;
    wrote = true;
    if (card === null) s.delete(id); else s.put(card);
    if (metaEdit) SM.touchCardMetaInTx(t.objectStore(META), (cards, tomb) => metaEdit(cards, tomb, old, card));
  };
  if (forgetIt) forget(t, [id]);
  await finished(t);
  changed();
  if (wrote) SM.notifySyncDirty();
};

const listeners = new Set<() => void>();
export const subscribeCards = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const changed = () => listeners.forEach(fn => fn());

export const getAllCards = async (): Promise<ReviewCard[]> => (await tx<ReviewCard[]>('readonly', s => s.getAll())) ?? [];
export const getCard = async (id: string): Promise<ReviewCard | null> => (await tx<ReviewCard>('readonly', s => s.get(id))) ?? null;
export const deleteCards = async (ids: string[]) => {
  const uniq = [...new Set(ids)];
  await migrateSavedLines().catch(console.error);
  const t = (await db()).transaction([STORE, META], 'readwrite');
  let wrote = false;
  SM.deleteCardsInTx(t.objectStore(STORE), t.objectStore(META), uniq, () => { wrote = true; });
  forget(t, uniq);
  await finished(t);
  changed();
  if (wrote) SM.notifySyncDirty();
};

export interface LineRef { videoId: string; videoName: string; videoPath?: string; text: string; start: number; end: number }

// The card keeps its own copy of the video path, taken from the record when the caller has none.
const withPath = async (ref: LineRef): Promise<LineRef> =>
  ref.videoPath ? ref : { ...ref, videoPath: (await getVideoFromDB(ref.videoId).catch(() => null))?.videoPath };

// A line the learner got stuck on (or bookmarked). Creates the card or just adds the reason.
export const addLine = async (ref: LineRef, reason: Reason): Promise<AddLineResult | null> => {
  if (!ref.videoId) return null;
  const id = lineCardId(ref.videoId, ref.start), full = await withPath(ref);
  let out: AddLineResult | null = null;
  await update(id, old => {
    out = {
      id,
      created: !old,
      addedReason: !old || !old.reasons.includes(reason),
      ...(STUCK.includes(reason) && old?.mastered ? { prevMastered: old.mastered } : {}),
    };
    return old ? withReason({ ...old, videoPath: full.videoPath ?? old.videoPath }, reason) : newCard({ id, deck: 'line', ...full }, reason);
  }, false, (cards, tomb, old, card) => { if (card) SM.metaOnAddLine(cards, tomb, id, old, card, reason); });
  return out;
};

// Safely undo a recent addLine: deletes only a brand-new untouched card; otherwise keeps it (and its clip),
// stripping only the reason / mastered-clear added by that call. When restoring `mastered`, bumps it past
// `sync_cards[id].unmasteredAt` in the same transaction so cross-device sync never wipes it back out.
export type UndoAddResult = 'deleted' | 'updated' | 'noop';
export const undoAddLine = async (res: AddLineResult, reason: Reason): Promise<UndoAddResult> => {
  await migrateSavedLines().catch(console.error);
  const t = (await db()).transaction([STORE, META], 'readwrite');
  const s = t.objectStore(STORE), m = t.objectStore(META);
  let outcome: UndoAddResult = 'noop';
  const r = s.get(res.id);
  r.onsuccess = () => {
    const cur = (r.result as ReviewCard | undefined) ?? null;
    if (!cur) return;
    const next = revertAddedLine(cur, res, reason);
    if (next === undefined) return;
    if (next === null) {
      outcome = 'deleted';
      s.delete(res.id);
      SM.touchCardMetaInTx(m, (cards, tomb) => SM.metaOnDeleteCards(cards, tomb, [cur]));
      forget(t, [res.id]);
    } else if (next.mastered !== undefined && !cur.mastered) {
      outcome = 'updated';
      SM.touchCardMetaInTx(m, cards => {
        const unm = cards[res.id]?.unmasteredAt ?? 0;
        const mastered = Math.max(next.mastered!, unm + 1, Date.now());
        s.put({ ...next, mastered });
      });
    } else {
      outcome = 'updated';
      s.put(next);
    }
  };
  await finished(t);
  if (outcome !== 'noop') {
    changed();
    SM.notifySyncDirty();
  }
  return outcome;
};

// Kept again without an AI note (none asked this time): the earlier note stays.
export const addWord = async (ref: LineRef, word: string, definition: string, example: string, ai = '') => {
  if (!ref.videoId || !word) return;
  const id = wordCardId(ref.videoId, ref.start, word), full = await withPath(ref);
  await update(id, old => old ? { ...old, definition, example, ...(ai ? { ai } : {}) } : newCard({ id, deck: 'word', ...full, word, definition, example, ...(ai ? { ai } : {}) }, 'lookup'),
    false, (cards, tomb, old, card) => { if (card) SM.metaOnAddWord(cards, tomb, id, old, card); });
};

// Kept from a list that may be stale (this episode's keywords): a card that is already there,
// however it got there, is left exactly as it is.
export const addWordIfNew = async (ref: LineRef, word: string, definition: string) => {
  if (!ref.videoId || !word) return;
  const id = wordCardId(ref.videoId, ref.start, word), full = await withPath(ref);
  await update(id, old => old ? undefined : newCard({ id, deck: 'word', ...full, word, definition, example: '' }, 'lookup'),
    false, (cards, tomb, old, card) => { if (card) SM.metaOnAddWord(cards, tomb, id, old, card); });
};

// Un-bookmark: a card that is only a bookmark goes; a line you also got stuck on stays.
export const unsaveLine = (videoId: string, start: number) => {
  const id = lineCardId(videoId, start);
  return update(id, old => {
    if (!old) return undefined;
    const reasons = old.reasons.filter(r => r !== 'saved');
    return reasons.length === 0 ? null : { ...old, reasons, saved: false };
  }, true, (cards, tomb, old, card) => { if (old) SM.metaOnUnsaveLine(cards, tomb, id, old, card === null); });
};

// Start times of this video's bookmarked lines, for the practice page's bookmark icons.
export const savedStarts = async (videoId: string): Promise<Set<string>> =>
  new Set((await getAllCards()).filter(c => c.deck === 'line' && c.saved && c.videoId === videoId).map(c => c.start.toFixed(2)));

// Schedules from the stored card (not the round's snapshot) and only touches the schedule
// and path; a card deleted meanwhile stays deleted.
// This video's sentence cards for these lines (with audio): what "dictate the ticked lines" opens.
export const lineCardsFor = async (videoId: string, lines: { startTime: number }[]) => {
  const starts = new Set(lines.map(s => s.startTime.toFixed(2)));
  return (await getAllCards()).filter(c => c.deck === 'line' && c.videoId === videoId && starts.has(c.start.toFixed(2)) && hasAudio(c));
};

// Again / Hard: the line is a struggle again, so "got it" comes off.
export const recordOutcome = (card: ReviewCard, o: Outcome | Grade, now = Date.now()) => {
  const g = typeof o === 'number' ? o : gradeOf(o);
  return update(card.id, old => old ? { ...(g === Rating.Again || g === Rating.Hard ? unmastered(old) : old), videoPath: card.videoPath ?? old.videoPath, fsrs: schedule(old, g, now).fsrs } : undefined,
    false, (cards, _t, old) => { if (old) SM.metaOnRecordOutcome(cards, card.id, old, g as RevGrade, now); });
};

// "Got it" on / off (off = undo, or "back to review" in the library); the schedule is untouched.
export const setMastered = (id: string, on: boolean) =>
  update(id, old => old ? (on ? { ...old, mastered: Date.now() } : unmastered(old)) : undefined, false, (cards, _t, old) => { if (old && !on) SM.metaOnUnmastered(cards, id, old); });

// Sent to Anki from the library: only this card, everything else kept; a card deleted meanwhile stays deleted.
export const markAnkiSent = (id: string, at: number) => update(id, old => old ? { ...old, ankiAt: at } : undefined);

// The practice page got stuck on this line: back to review, whether or not it adds cards.
export const clearMastered = (videoId: string, start: number) => {
  const id = lineCardId(videoId, start);
  return update(id, old => old?.mastered ? unmastered(old) : undefined, false, (cards, _t, old) => { if (old) SM.metaOnUnmastered(cards, id, old); });
};

// Delete from inside a review round (docs/review.md「复习里删卡」): hands back the card as it was,
// so undo can put it back whole (clip included), plus whether the old-bookmark move had already
// been told to skip it. Undo never overwrites a card written since, and takes back only its own skip.
export interface Removed { card: ReviewCard; listed: boolean; pending: boolean } // pending: the move hadn't landed
export const removeCard = async (id: string): Promise<Removed | null> => {
  await migrateSavedLines().catch(console.error);
  const t = (await db()).transaction([STORE, META], 'readwrite');
  const s = t.objectStore(STORE), m = t.objectStore(META);
  let out: Removed | null = null;
  const g = m.get('deleted'), mv = m.get('migrated'), r = s.get(id); // queued before forget() adds this id
  r.onsuccess = () => {
    if (!r.result) return;
    out = { card: r.result, listed: !!g.result?.ids?.includes(id), pending: !mv.result };
    s.delete(id);
    SM.touchCardMetaInTx(m, (cards, tomb) => SM.metaOnDeleteCards(cards, tomb, [r.result as ReviewCard]));
  };
  forget(t, [id]);
  await finished(t);
  changed();
  if (out) SM.notifySyncDirty();
  return out;
};
// Doesn't wait on the old-bookmark move: run first, it would skip this card while it is still on the list.
export const restoreCard = async ({ card, listed, pending }: Removed) => {
  const t = (await db()).transaction([STORE, META], 'readwrite');
  const s = t.objectStore(STORE), m = t.objectStore(META);
  // Not listed before this delete: take back our own skip, and if the move already ran and skipped
  // it because of this delete, give it the bookmark the move would have.
  const g = listed ? null : m.get('deleted'), k = listed || !pending ? null : m.get('skippedSaved'), r = s.get(card.id);
  let restored = false;
  r.onsuccess = () => {
    const missed = !!k?.result?.ids?.includes(card.id);
    if (!r.result) { restored = true; s.put(missed ? withReason(card, 'saved') : card); SM.touchCardMetaInTx(m, (cards, tomb) => SM.metaOnRestoreCard(cards, tomb, card, missed)); }
    if (g?.result) m.put({ ...g.result, ids: g.result.ids.filter((x: string) => x !== card.id) });
    if (missed) m.put({ ...k!.result, ids: k!.result.ids.filter((x: string) => x !== card.id) });
  };
  await finished(t);
  changed();
  if (restored) SM.notifySyncDirty();
};

export const countForVideo = async (videoId: string) => (await getAllCards()).filter(c => c.videoId === videoId).length;

// Deleting a video takes its cards along. Read and delete in one transaction, so
// a card written meanwhile is either seen here or written after. `keep`: the cards
// stay (they have their own clips); returns their ids.
export const deleteVideoCards = async (videoId: string, keep = false): Promise<string[]> => {
  await migrateSavedLines().catch(console.error);
  const t = (await db()).transaction([STORE, META], 'readwrite');
  const s = t.objectStore(STORE), m = t.objectStore(META), r = s.getAll();
  let kept: string[] = [];
  r.onsuccess = () => {
    const mine = (r.result as ReviewCard[]).filter(c => c.videoId === videoId), del = keep ? [] : mine;
    kept = keep ? mine.map(c => c.id) : [];
    del.forEach(c => s.delete(c.id));
    forget(t, del.map(c => c.id));
    SM.touchCardMetaInTx(m, (cards, tomb) => SM.metaOnDeleteVideo(cards, tomb, videoId, keep, del));
  };
  await finished(t);
  changed();
  SM.notifySyncDirty();
  return kept;
};

// Give these cards their clip; a card deleted meanwhile stays deleted, one that got a clip
// meanwhile keeps it — unless `replace` (its file was gone and this is the new cut).
export const setClip = async (ids: string[], clip: Clip, replace = false) => {
  await migrateSavedLines().catch(console.error);
  const t = (await db()).transaction(STORE, 'readwrite');
  const s = t.objectStore(STORE);
  let wrote = false;
  for (const id of ids) {
    const r = s.get(id);
    r.onsuccess = () => { const c = r.result as ReviewCard | undefined; if (c && (replace || !c.clip)) { wrote = true; s.put({ ...c, clip }); } };
  }
  await finished(t);
  changed();
  if (wrote) SM.notifySyncDirty();
};

// Cards whose video record is gone: left by versions that kept cards on delete,
// or by a delete whose card step failed. The user is asked once per card; the
// ones they chose to keep are remembered here. Old bookmarks that never had a
// video (videoId '') don't count. Throws if the records can't be read, so
// "unreadable" never looks like "every video deleted".
const KEPT = 'linguaclip_kept_orphans';
const keptOrphans = (): string[] => {
  try { return JSON.parse(localStorage.getItem(KEPT) || '[]'); } catch { return []; }
};
export const orphanCards = async () => {
  const live = new Set((await getAllVideosFromDB()).map((r: { id: string }) => r.id));
  const kept = new Set(keptOrphans());
  const cards = await getAllCards();
  // A kept video's later cards (a word kept while reviewing from its clip) are kept too, and
  // so is any card with its own clip: it still plays, it isn't a leftover.
  const keptVideos = new Set(cards.filter(c => kept.has(c.id)).map(c => c.videoId));
  return cards.filter(c => c.videoId && !live.has(c.videoId) && !kept.has(c.id) && !keptVideos.has(c.videoId) && !c.clip);
};
export const keepOrphans = (ids: string[]) => {
  try { localStorage.setItem(KEPT, JSON.stringify([...keptOrphans(), ...ids])); } catch { /* storage off: asked again next launch */ }
};

export const repointVideo = async (videoId: string, videoPath: string) => {
  await migrateSavedLines().catch(console.error);
  const t = (await db()).transaction(STORE, 'readwrite');
  const s = t.objectStore(STORE);
  const r = s.getAll();
  r.onsuccess = () => (r.result as ReviewCard[]).filter(c => c.videoId === videoId).forEach(c => s.put({ ...c, videoPath }));
  await finished(t);
  changed();
};

export const deckCounts = (cards: ReviewCard[], now = Date.now()) => {
  const count = (deck: Deck) => ({
    due: cards.filter(c => c.deck === deck && isDue(c, now)).length,
    total: cards.filter(c => c.deck === deck).length,
    remembered: cards.filter(c => c.deck === deck && isRemembered(c)).length,
  });
  return { line: count('line'), word: count('word') };
};

// --- Backup and restore (utils/backupData.ts, utils/restore.ts) ---

// Both stores as they are, in one read. Throws when unreadable (never an empty deck instead).
export const readAll = async (): Promise<{ cards: ReviewCard[]; meta: Record<string, unknown>[] }> => {
  const t = (await db()).transaction([STORE, META], 'readonly');
  const cards = t.objectStore(STORE).getAll();
  const meta = t.objectStore(META).getAll();
  await finished(t);
  return { cards: cards.result, meta: meta.result };
};

// Restore: both stores replaced in one transaction. Runs before the app starts, so it
// doesn't wait for the old-bookmark move (the backup's own `meta` says whether that is done).
export const replaceAll = async (cards: ReviewCard[], meta: Record<string, unknown>[]) => {
  const t = (await db()).transaction([STORE, META], 'readwrite');
  const s = t.objectStore(STORE), m = t.objectStore(META);
  s.clear();
  m.clear();
  cards.forEach(c => s.put(c));
  meta.forEach(x => m.put(x));
  await finished(t);
  changed();
};

// --- One-time move of the old text-only bookmarks ---
// Reads localStorage `linguaclip_saved_lines` and never writes it (it stays as
// a backup). The "done" mark is written in the same transaction as the cards,
// so they land together or not at all; ids are fixed, so a rerun is harmless.
// Known limits: bookmarks made in an older app version after this ran aren't picked up;
// going back to an older version before the move lands ignores forget() and can bring deleted cards back.

let migrating: Promise<void> | null = null;

export const migrateSavedLines = () => migrating ??= (async () => {
  const d = await db();
  const done = await new Promise<boolean>((resolve, reject) => {
    const q = d.transaction(META).objectStore(META).get('migrated');
    q.onsuccess = () => resolve(!!q.result);
    q.onerror = () => reject(q.error);
  });
  if (done) return;
  // Unreadable (not just empty) old bookmarks throw here, so the move isn't marked done and runs again next launch.
  const raw = localStorage.getItem('linguaclip_saved_lines');
  const lines: SavedLine[] = raw ? JSON.parse(raw) : [];
  const records = lines.length ? await getAllVideosFromDB() : [];
  const cards = lines.map(line => {
    const hit = matchLegacy(line, records);
    const base = hit
      ? { id: lineCardId(hit.record.id, hit.start), videoId: hit.record.id, videoName: hit.record.displayName, videoPath: hit.record.videoPath, start: hit.start, end: hit.end }
      : { id: `legacy|${line.id}`, videoId: '', videoName: line.videoName ?? '', start: -1, end: -1 };
    return newCard({ ...base, deck: 'line', text: line.text }, 'saved', line.dateSaved);
  });
  const t = d.transaction([STORE, META], 'readwrite');
  const s = t.objectStore(STORE), m = t.objectStore(META);
  const gone = m.get('deleted');
  gone.onsuccess = () => {
    const skip = new Set<string>(gone.result?.ids ?? []); // deleted / un-bookmarked while this kept failing: leave them be
    // Skipped ones are noted, so undoing a delete from a review round can still add the bookmark (restoreCard).
    const skipped = cards.filter(c => skip.has(c.id)).map(c => c.id);
    if (skipped.length) m.put({ id: 'skippedSaved', ids: skipped });
    // Never clobber a card that already exists (made by practising before this finished).
    for (const c of cards) {
      if (skip.has(c.id)) continue;
      const r = s.get(c.id);
      r.onsuccess = () => { s.put(r.result ? withReason(r.result, 'saved') : c); };
    }
    m.put({ id: 'migrated', at: Date.now(), count: cards.length });
    m.delete('deleted');
  };
  await new Promise<void>((resolve, reject) => { t.oncomplete = () => resolve(); t.onerror = t.onabort = () => reject(t.error); });
  changed();
})().catch(e => { migrating = null; throw e; });
