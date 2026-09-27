/**
 * In-app review: the sentence deck and the word deck, scheduled with FSRS.
 *
 * Cards live in their own IndexedDB database (`linguaclip_review`) so the
 * practice records' database (and its DB_VERSION) is never touched. Each card
 * carries its own copy of the line, its times and the video path. Deleting a
 * video deletes its cards too (deleteVideoCards).
 *
 * Grading is automatic, from how the dictation went: nobody rates themselves.
 */
import { createEmptyCard, fsrs, Rating, State, type Card, type Grade } from 'ts-fsrs';
import { parseSRT } from './srtParser';
import { getAllVideosFromDB, getVideoFromDB } from './fileSystemAccess';
import type { SavedLine } from '../types';

export type Deck = 'line' | 'word';
// Files in <own dir>/clips; `from` = where the file starts in the source video, in seconds.
export interface Clip { kind: 'video' | 'audio'; file: string; image?: string; from: number }
export type Reason = 'wrong' | 'peek' | 'breakdown' | 'blur' | 'saved' | 'lookup';

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
  reasons: Reason[];
  saved: boolean;        // bookmarked by hand
  clip?: Clip;           // its own copy of the line (utils/clips.ts), so it plays after the video is deleted
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

// Meeting a card again while practising only notes why; it never resets the schedule.
export const withReason = (card: ReviewCard, reason: Reason): ReviewCard => ({
  ...card,
  reasons: card.reasons.includes(reason) ? card.reasons : [...card.reasons, reason],
  saved: card.saved || reason === 'saved',
});

export const schedule = (card: ReviewCard, o: Outcome, now = Date.now()): ReviewCard => ({
  ...card,
  fsrs: toStored(scheduler.next(fromStored(card.fsrs), new Date(now), gradeOf(o)).card),
});

export const isDue = (c: ReviewCard, now = Date.now()) => hasAudio(c) && c.fsrs.due <= now;

export const dueQueue = (cards: ReviewCard[], deck: Deck, now = Date.now(), limit = SESSION_SIZE) =>
  cards.filter(c => c.deck === deck && isDue(c, now)).sort((a, b) => a.fsrs.due - b.fsrs.due).slice(0, limit);

export const isNew = (c: ReviewCard) => c.fsrs.state === State.New;

// "Remembered" on the home screen: a line likely still recalled a week from now.
export const REMEMBERED_DAYS = 7;
export const isRemembered = (c: ReviewCard) => c.deck === 'line' && hasAudio(c) && c.fsrs.stability >= REMEMBERED_DAYS;

// Which boxes to blank in a word card: the first token equal to the word,
// ignoring case and punctuation. A Japanese word kept under another split
// (天気 vs 天気ですね, or a whole line kept by an older version) blanks every box
// it overlaps in the line.
export const wordBoxes = (words: string[], word: string): number[] => {
  const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}'’-]/gu, '');
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
const update = async (id: string, next: (old: ReviewCard | null) => ReviewCard | null | undefined, forgetIt = false) => {
  await migrateSavedLines().catch(console.error);
  const t = (await db()).transaction([STORE, META], 'readwrite');
  const s = t.objectStore(STORE);
  const r = s.get(id);
  r.onsuccess = () => {
    const card = next((r.result as ReviewCard | undefined) ?? null);
    if (card === null) s.delete(id);
    else if (card) s.put(card);
  };
  if (forgetIt) forget(t, [id]);
  await finished(t);
  changed();
};

const listeners = new Set<() => void>();
export const subscribeCards = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const changed = () => listeners.forEach(fn => fn());

export const getAllCards = async (): Promise<ReviewCard[]> => (await tx<ReviewCard[]>('readonly', s => s.getAll())) ?? [];
export const deleteCards = async (ids: string[]) => {
  await migrateSavedLines().catch(console.error);
  const t = (await db()).transaction([STORE, META], 'readwrite');
  ids.forEach(id => t.objectStore(STORE).delete(id));
  forget(t, ids);
  await finished(t);
  changed();
};

export interface LineRef { videoId: string; videoName: string; videoPath?: string; text: string; start: number; end: number }

// The card keeps its own copy of the video path, taken from the record when the caller has none.
const withPath = async (ref: LineRef): Promise<LineRef> =>
  ref.videoPath ? ref : { ...ref, videoPath: (await getVideoFromDB(ref.videoId).catch(() => null))?.videoPath };

// A line the learner got stuck on (or bookmarked). Creates the card or just adds the reason.
export const addLine = async (ref: LineRef, reason: Reason) => {
  if (!ref.videoId) return;
  const id = lineCardId(ref.videoId, ref.start);
  const full = await withPath(ref);
  await update(id, old => old ? withReason({ ...old, videoPath: full.videoPath ?? old.videoPath }, reason) : newCard({ id, deck: 'line', ...full }, reason));
};

export const addWord = async (ref: LineRef, word: string, definition: string, example: string) => {
  if (!ref.videoId || !word) return;
  const id = wordCardId(ref.videoId, ref.start, word);
  const full = await withPath(ref);
  await update(id, old => old ? { ...old, definition, example } : newCard({ id, deck: 'word', ...full, word, definition, example }, 'lookup'));
};


// Un-bookmark: a card that is only a bookmark goes; a line you also got stuck on stays.
export const unsaveLine = (videoId: string, start: number) => update(lineCardId(videoId, start), old => {
  if (!old) return undefined;
  const reasons = old.reasons.filter(r => r !== 'saved');
  return reasons.length === 0 ? null : { ...old, reasons, saved: false };
}, true);

// Start times of this video's bookmarked lines, for the practice page's bookmark icons.
export const savedStarts = async (videoId: string): Promise<Set<string>> =>
  new Set((await getAllCards()).filter(c => c.deck === 'line' && c.saved && c.videoId === videoId).map(c => c.start.toFixed(2)));

// Schedules from the stored card (not the round's snapshot) and only touches the schedule
// and path; a card deleted meanwhile stays deleted.
export const recordOutcome = (card: ReviewCard, o: Outcome) =>
  update(card.id, old => old ? { ...old, videoPath: card.videoPath ?? old.videoPath, fsrs: schedule(old, o).fsrs } : undefined);

export const countForVideo = async (videoId: string) => (await getAllCards()).filter(c => c.videoId === videoId).length;

// Deleting a video takes its cards along. Read and delete in one transaction, so
// a card written meanwhile is either seen here or written after. `keep`: the cards
// stay (they have their own clips); returns their ids.
export const deleteVideoCards = async (videoId: string, keep = false): Promise<string[]> => {
  await migrateSavedLines().catch(console.error);
  const t = (await db()).transaction([STORE, META], 'readwrite');
  const s = t.objectStore(STORE);
  const r = s.getAll();
  let kept: string[] = [];
  r.onsuccess = () => {
    const mine = (r.result as ReviewCard[]).filter(c => c.videoId === videoId);
    const ids = keep ? [] : mine.map(c => c.id);
    kept = keep ? mine.map(c => c.id) : [];
    ids.forEach(id => s.delete(id));
    forget(t, ids);
  };
  await finished(t);
  changed();
  return kept;
};

// Give these cards their clip; a card deleted meanwhile stays deleted, one that got a clip
// meanwhile keeps it — unless `replace` (its file was gone and this is the new cut).
export const setClip = async (ids: string[], clip: Clip, replace = false) => {
  await migrateSavedLines().catch(console.error);
  const t = (await db()).transaction(STORE, 'readwrite');
  const s = t.objectStore(STORE);
  for (const id of ids) {
    const r = s.get(id);
    r.onsuccess = () => { const c = r.result as ReviewCard | undefined; if (c && (replace || !c.clip)) s.put({ ...c, clip }); };
  }
  await finished(t);
  changed();
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
  return (await getAllCards()).filter(c => c.videoId && !live.has(c.videoId) && !kept.has(c.id));
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
