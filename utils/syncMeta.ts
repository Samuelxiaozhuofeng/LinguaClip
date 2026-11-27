/**
 * Sync metadata helpers for `linguaclip_review.meta` and `localStorage` (`linguaclip_pos_at`),
 * bounded 8-entry FSRS revlog maintenance, and sync-dirty event bus (docs/sync.md).
 *
 * Pure IDB / localStorage logic — zero @tauri-apps/* imports, zero circular runtime import on `utils/review.ts`.
 */
import { fsrs, type Card, type Grade } from 'ts-fsrs';
import type { Clip, Reason, ReviewCard } from './review';
import { bumpTs } from './syncClock';
import { getSyncDeviceId, getSyncState, markSyncDirty, POS_AT_KEY, saveSyncState } from './syncConfig';
import {
  MAX_REVLOGS,
  type CardRevLogEntry,
  type CardSyncMeta,
  type PosAtMap,
  type RevGrade,
  type SyncTombstones,
  type VideoPosAt,
  type VideoTombstone,
} from './syncTypes';

export const META_SYNC_CARDS = 'sync_cards';
export const META_SYNC_TOMBSTONES = 'sync_tombstones';
export const META_SYNC_PENDING_CLIPS = 'sync_pending_clips';
export const META_SYNC_REDIRECTS = 'sync_redirects';

export type PosAtField = 'watch' | 'custom' | 'read' | 'lastWay';
export type CardMetaEdit = (
  cards: Record<string, CardSyncMeta>,
  tomb: SyncTombstones,
  old: ReviewCard | null,
  card: ReviewCard | null,
) => void;

const POS_BY_FIELD: Record<PosAtField, 'watchBy' | 'customBy' | 'readBy' | 'lastWayBy'> = {
  watch: 'watchBy',
  custom: 'customBy',
  read: 'readBy',
  lastWay: 'lastWayBy',
};
const STUCK_REASONS: readonly Reason[] = ['wrong', 'peek', 'breakdown', 'blur', 'missed'];

// Identical scheduler config to utils/review.ts (avoids circular runtime dependency).
const scheduler = fsrs({ enable_fuzz: true, enable_short_term: false });
const toStoredFsrs = (c: Card): ReviewCard['fsrs'] => ({ ...c, due: +c.due, last_review: c.last_review ? +c.last_review : undefined });
const fromStoredFsrs = (c: ReviewCard['fsrs']): Card => ({ ...c, due: new Date(c.due), last_review: c.last_review ? new Date(c.last_review) : undefined });
const stepFsrs = (state: ReviewCard['fsrs'], grade: RevGrade, at: number): ReviewCard['fsrs'] =>
  toStoredFsrs(scheduler.next(fromStoredFsrs(state), new Date(at), grade as Grade).card);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function makeRevId8(): string {
  const b = new Uint8Array(4);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(b);
  else for (let i = 0; i < 4; i++) b[i] = Math.floor(Math.random() * 256);
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

function cloneCardMetaMap(raw: unknown): Record<string, CardSyncMeta> {
  if (!isRecord(raw)) return {};
  const out: Record<string, CardSyncMeta> = {};
  for (const [k, v] of Object.entries(raw)) if (isRecord(v)) out[k] = { ...(v as unknown as CardSyncMeta) };
  return out;
}

function cloneTombstones(raw: unknown): SyncTombstones {
  const row = isRecord(raw) ? raw : {};
  const videos: Record<string, VideoTombstone> = {};
  if (isRecord(row.videos)) {
    for (const [k, v] of Object.entries(row.videos)) {
      if (isRecord(v) && isNum(v.at)) videos[k] = { at: v.at, ...(typeof v.keepCards === 'boolean' ? { keepCards: v.keepCards } : {}) };
    }
  }
  const cards: Record<string, number> = {};
  if (isRecord(row.cards)) {
    for (const [k, v] of Object.entries(row.cards)) if (isNum(v)) cards[k] = v;
  }
  return { videos, cards, ...(isNum(row.gcFloorAt) ? { gcFloorAt: row.gcFloorAt } : {}) };
}

export type PendingClipEntry = Clip & { packName?: string };

function clonePendingClips(raw: unknown): Record<string, PendingClipEntry> {
  if (!isRecord(raw)) return {};
  const out: Record<string, PendingClipEntry> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (isRecord(v) && typeof v.file === 'string' && isNum(v.from)) out[k] = { ...(v as unknown as PendingClipEntry) };
  }
  return out;
}

function cloneRedirects(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === 'string' && v) out[k] = v;
  return out;
}

const ensureMeta = (cards: Record<string, CardSyncMeta>, id: string, old: ReviewCard, now: number): CardSyncMeta => {
  const prev = cards[id];
  return prev ? { ...prev, bornAt: prev.bornAt || old.createdAt || now } : { bornAt: old.createdAt || now };
};

/** Append a review log entry and fold oldest entries into `base` when exceeding MAX_REVLOGS (8). */
export function recordRevLog(meta: CardSyncMeta, prevFsrs: ReviewCard['fsrs'], grade: RevGrade, now: number): CardSyncMeta {
  let base: ReviewCard['fsrs'] = meta.base ? { ...meta.base } : { ...prevFsrs };
  const logs: CardRevLogEntry[] = [...(meta.logs ?? []), [makeRevId8(), grade, now]];
  while (logs.length > MAX_REVLOGS) {
    const oldest = logs.shift()!;
    base = stepFsrs(base, oldest[1], oldest[2]);
  }
  return { ...meta, base, logs };
}

/** Read and update `sync_cards` and `sync_tombstones` inside the caller's existing `[cards, meta]` IDB transaction. */
export function touchCardMetaInTx(
  m: IDBObjectStore,
  edit: (cards: Record<string, CardSyncMeta>, tomb: SyncTombstones) => void,
): void {
  const reqCards = m.get(META_SYNC_CARDS);
  const reqTombs = m.get(META_SYNC_TOMBSTONES);
  let cardsDone = false, tombsDone = false;
  let cardsRow: unknown, tombsRow: unknown;
  const commit = () => {
    if (!cardsDone || !tombsDone) return;
    const cards = cloneCardMetaMap(isRecord(cardsRow) ? cardsRow.map : undefined);
    const tomb = cloneTombstones(tombsRow);
    edit(cards, tomb);
    m.put({ id: META_SYNC_CARDS, map: cards });
    m.put({ id: META_SYNC_TOMBSTONES, videos: tomb.videos, cards: tomb.cards, ...(tomb.gcFloorAt !== undefined ? { gcFloorAt: tomb.gcFloorAt } : {}) });
  };
  reqCards.onsuccess = () => { cardsRow = reqCards.result; cardsDone = true; commit(); };
  reqTombs.onsuccess = () => { tombsRow = reqTombs.result; tombsDone = true; commit(); };
}

// --- Per-operation card & tombstone metadata mutations (called inside touchCardMetaInTx) ---

export function metaOnAddLine(
  cards: Record<string, CardSyncMeta>, tomb: SyncTombstones, id: string,
  old: ReviewCard | null, created: ReviewCard, reason: Reason, now = Date.now(),
): void {
  if (!old) {
    const bornAt = bumpTs(tomb.cards[id] ?? 0, now);
    delete tomb.cards[id];
    const m: CardSyncMeta = { bornAt, base: { ...created.fsrs }, logs: [] };
    if (reason === 'saved') m.savedAt = bumpTs(0, bornAt);
    if (reason === 'missed') m.missedAt = bumpTs(0, bornAt);
    cards[id] = m;
    return;
  }
  const m = ensureMeta(cards, id, old, now);
  delete tomb.cards[id];
  if (reason === 'saved') m.savedAt = bumpTs(Math.abs(m.savedAt ?? 0), now);
  if (reason === 'missed') m.missedAt = bumpTs(Math.abs(m.missedAt ?? 0), now);
  if (STUCK_REASONS.includes(reason) && old.mastered) m.unmasteredAt = bumpTs(Math.max(old.mastered, m.unmasteredAt ?? 0), now);
  cards[id] = m;
}

export function metaOnAddWord(
  cards: Record<string, CardSyncMeta>, tomb: SyncTombstones, id: string,
  old: ReviewCard | null, created: ReviewCard, now = Date.now(),
): void {
  const noteBy = getSyncDeviceId();
  if (!old) {
    const bornAt = bumpTs(tomb.cards[id] ?? 0, now);
    delete tomb.cards[id];
    cards[id] = { bornAt, base: { ...created.fsrs }, logs: [], noteAt: bumpTs(0, bornAt), noteBy };
    return;
  }
  const m = ensureMeta(cards, id, old, now);
  cards[id] = { ...m, noteAt: bumpTs(m.noteAt ?? 0, now), noteBy };
}

export function metaOnUnsaveLine(
  cards: Record<string, CardSyncMeta>, tomb: SyncTombstones, id: string,
  old: ReviewCard, deleted: boolean, now = Date.now(),
): void {
  if (deleted) { metaOnDeleteCards(cards, tomb, [old], now); return; }
  const m = ensureMeta(cards, id, old, now);
  cards[id] = { ...m, savedAt: -bumpTs(Math.abs(m.savedAt ?? 0), now) };
}

export function metaOnRecordOutcome(
  cards: Record<string, CardSyncMeta>, id: string, old: ReviewCard, grade: RevGrade, now = Date.now(),
): void {
  let next = recordRevLog(ensureMeta(cards, id, old, now), old.fsrs, grade, now);
  if (grade === 1 || grade === 2) next = { ...next, unmasteredAt: bumpTs(Math.max(old.mastered ?? 0, next.unmasteredAt ?? 0), now) };
  cards[id] = next;
}

export function metaOnUnmastered(cards: Record<string, CardSyncMeta>, id: string, old: ReviewCard, now = Date.now()): void {
  const m = ensureMeta(cards, id, old, now);
  cards[id] = { ...m, unmasteredAt: bumpTs(Math.max(old.mastered ?? 0, m.unmasteredAt ?? 0), now) };
}

export function metaOnDeleteCards(
  cards: Record<string, CardSyncMeta>, tomb: SyncTombstones, deletedCards: ReviewCard[], now = Date.now(),
): void {
  for (const c of deletedCards) {
    const born = cards[c.id]?.bornAt ?? c.createdAt ?? 0;
    tomb.cards[c.id] = bumpTs(Math.max(born, tomb.cards[c.id] ?? 0), now);
    delete cards[c.id];
  }
}

export function deleteCardsInTx(
  s: IDBObjectStore, m: IDBObjectStore, ids: string[], onDeleted: (deleted: ReviewCard[]) => void,
): void {
  if (!ids.length) return;
  const deleted: ReviewCard[] = [];
  let left = ids.length;
  for (const id of ids) {
    const r = s.get(id);
    r.onsuccess = () => {
      if (r.result) { deleted.push(r.result as ReviewCard); s.delete(id); }
      if (--left === 0 && deleted.length) {
        onDeleted(deleted);
        touchCardMetaInTx(m, (cards, tomb) => metaOnDeleteCards(cards, tomb, deleted));
      }
    };
  }
}

export function metaOnRestoreCard(
  cards: Record<string, CardSyncMeta>, tomb: SyncTombstones, card: ReviewCard, addedSaved: boolean, now = Date.now(),
): void {
  const prev = cards[card.id];
  const bornAt = bumpTs(Math.max(tomb.cards[card.id] ?? 0, prev?.bornAt ?? card.createdAt ?? 0), now);
  delete tomb.cards[card.id];
  const m: CardSyncMeta = prev ? { ...prev, bornAt } : { bornAt, base: { ...card.fsrs }, logs: [] };
  if (addedSaved) m.savedAt = bumpTs(Math.abs(m.savedAt ?? 0), bornAt);
  cards[card.id] = m;
}

export function metaOnDeleteVideo(
  cards: Record<string, CardSyncMeta>, tomb: SyncTombstones, videoId: string,
  keep: boolean, deletedCards: ReviewCard[], now = Date.now(),
): void {
  const delAt = bumpTs(tomb.videos[videoId]?.at ?? 0, now);
  tomb.videos[videoId] = { at: delAt, keepCards: keep };
  if (!keep && deletedCards.length > 0) metaOnDeleteCards(cards, tomb, deletedCards, delAt);
}

export function metaOnMissedChange(
  cards: Record<string, CardSyncMeta>, tomb: SyncTombstones, id: string,
  old: ReviewCard, action: 'delete' | 'strip' | 'readd', now = Date.now(),
): void {
  if (action === 'delete') { metaOnDeleteCards(cards, tomb, [old], now); return; }
  const m = ensureMeta(cards, id, old, now);
  const nextAbs = bumpTs(Math.abs(m.missedAt ?? 0), now);
  cards[id] = { ...m, missedAt: action === 'readd' ? nextAbs : -nextAbs };
}

// --- Pure extraction from reviewMeta rows (used by syncEngine) ---

export interface ExtractedSyncMeta {
  cardMeta: Record<string, CardSyncMeta>;
  tombstones: SyncTombstones;
  pendingClips: Record<string, PendingClipEntry>;
  idRedirects: Record<string, string>;
}

export function readSyncMetaFromReviewMeta(metaRows: Record<string, unknown>[]): ExtractedSyncMeta {
  let cardMeta: Record<string, CardSyncMeta> = {};
  let tombstones: SyncTombstones = { videos: {}, cards: {} };
  let pendingClips: Record<string, PendingClipEntry> = {};
  let idRedirects: Record<string, string> = {};
  for (const row of metaRows) {
    if (!isRecord(row) || typeof row.id !== 'string') continue;
    if (row.id === META_SYNC_CARDS) cardMeta = cloneCardMetaMap(row.map);
    else if (row.id === META_SYNC_TOMBSTONES) tombstones = cloneTombstones(row);
    else if (row.id === META_SYNC_PENDING_CLIPS) pendingClips = clonePendingClips(row.map);
    else if (row.id === META_SYNC_REDIRECTS) idRedirects = cloneRedirects(row.map);
  }
  return { cardMeta, tombstones, pendingClips, idRedirects };
}

// --- Per-video position timestamps (`linguaclip_pos_at`) ---

export function readPosAt(): PosAtMap {
  try {
    if (typeof localStorage === 'undefined') return {};
    const parsed = JSON.parse(localStorage.getItem(POS_AT_KEY) || '{}');
    return isRecord(parsed) ? (parsed as PosAtMap) : {};
  } catch { return {}; }
}

export function writePosAt(map: PosAtMap): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(POS_AT_KEY, JSON.stringify(map));
  } catch { /* localStorage off: never block practice */ }
}

export function touchPosAt(videoId: string, field: PosAtField, now = Date.now()): void {
  if (!videoId) return;
  const map = readPosAt();
  const raw = map[videoId];
  const entry: VideoPosAt = typeof raw === 'number'
    ? { watch: raw, custom: raw, read: raw, lastWay: raw }
    : isRecord(raw) ? { ...(raw as VideoPosAt) } : {};
  entry[field] = bumpTs(entry[field] ?? 0, now);
  entry[POS_BY_FIELD[field]] = getSyncDeviceId();
  map[videoId] = entry;
  writePosAt(map);
}

export function forgetPosAt(videoId: string, field?: PosAtField): void {
  if (!videoId) return;
  const map = readPosAt();
  if (!(videoId in map)) return;
  if (!field) { delete map[videoId]; writePosAt(map); return; }
  const raw = map[videoId];
  const entry: VideoPosAt = typeof raw === 'number'
    ? { watch: raw, custom: raw, read: raw, lastWay: raw }
    : isRecord(raw) ? { ...(raw as VideoPosAt) } : {};
  delete entry[field];
  delete entry[POS_BY_FIELD[field]];
  if (Object.keys(entry).length === 0) delete map[videoId];
  else map[videoId] = entry;
  writePosAt(map);
}

// --- Sync dirty event bus & generation tracking ---

const dirtyListeners = new Set<() => void>();
let dirtyGen = 0;
let suppressDirtyDepth = 0;

export const getSyncDirtyGen = (): number => dirtyGen;
export async function withSyncDirtySuppressed<T>(fn: () => Promise<T>): Promise<T> {
  suppressDirtyDepth++;
  try { return await fn(); } finally { suppressDirtyDepth--; }
}

export const subscribeSyncDirty = (fn: () => void): (() => void) => { dirtyListeners.add(fn); return () => { dirtyListeners.delete(fn); }; };
export function notifySyncDirty(): void {
  if (suppressDirtyDepth > 0) return;
  dirtyGen++;
  markSyncDirty();
  dirtyListeners.forEach(fn => { try { fn(); } catch { /* listener failure must not break writes */ } });
}

/** Record an explicit user edit to a synced setting key so untouched defaults on a newly paired device never overwrite it. */
export function touchSyncSetting(key: string, now = Date.now()): void {
  if (suppressDirtyDepth > 0 || !key) return;
  try {
    const cur = getSyncState();
    const settingAt = { ...(cur.settingAt ?? {}) };
    const prev = settingAt[key]?.at ?? 0;
    settingAt[key] = { at: bumpTs(prev, now), by: getSyncDeviceId() };
    saveSyncState({ ...cur, settingAt, dirty: true });
  } catch { /* never block settings save */ }
  dirtyGen++;
  dirtyListeners.forEach(fn => { try { fn(); } catch { /* isolate */ } });
}
