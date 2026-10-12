// The phone backup, the pure part (docs/mobile-web.md「备份」「恢复」; node mobile/test-backup.mjs):
// what one json holds, the check every backup passes (exporting, staging and restoring),
// which settings go in / are replaced, which audio files a backup still points at, and
// the restore marker. Records and cards are checked with the desktop's own rules
// (utils/backup.ts checkBackup). Reading / writing is in mobile/restore.ts.
import { SECRET_KEYS, checkBackup, inBackup, planLocalStorage } from '../utils/backup';
import type { ReviewCard } from '../utils/review';

export const V = 1;

export interface MobileBackup {
  v: number;
  platform: 'mobile';
  at: number;
  videos: Record<string, unknown>[];
  review: { cards: ReviewCard[]; meta: Record<string, unknown>[] };
  local: Record<string, string>; // localStorage, never the AI / Groq settings
  cache: Record<string, string>; // linguaclip_audio cache table: `id|kind` → text
}

export type Code = 'desktop' | 'newer' | 'bad' | 'pre' | 'gone';
export class BackupProblem extends Error {
  constructor(readonly code: Code, why: string) { super(why); }
}

// Settings a phone backup carries and a restore replaces: the desktop's range minus the keys.
export const keepLocal = (k: string) => inBackup(k) && !SECRET_KEYS.includes(k);
export const pickLocal = (all: Record<string, string>) => Object.fromEntries(Object.entries(all).filter(([k]) => keepLocal(k)));
// Backup's settings first, then the ones in range it lacks go; keys / LOCAL_ONLY never touched.
export const planLocal = (current: Record<string, string>, backup: Record<string, string>) => planLocalStorage(current, pickLocal(backup));

export const makeBackup = (p: { videos: Record<string, unknown>[]; cards: ReviewCard[]; meta: Record<string, unknown>[]; local: Record<string, string>; cache: Record<string, string> }, at: number): MobileBackup =>
  ({ v: V, platform: 'mobile', at, videos: p.videos, review: { cards: p.cards, meta: p.meta }, local: pickLocal(p.local), cache: p.cache });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown) => isObj(v) && Object.values(v).every(x => typeof x === 'string');
const CACHE_KEY = /^[^|/\\\0]+\|[a-z]+$/;

// Everything the restore will rely on. Any failure rejects the whole backup.
export function checkMobile(x: unknown): { code: Code; why: string } | null {
  const bad = (why: string) => ({ code: 'bad' as const, why });
  if (!isObj(x)) return bad('json');
  if (x.platform !== 'mobile') return 'format' in x || 'reviewMeta' in x || 'manifest' in x ? { code: 'desktop', why: 'desktop' } : bad('platform');
  if (typeof x.v !== 'number' || !Number.isInteger(x.v) || x.v < 1) return bad('v');
  if (x.v > V) return { code: 'newer', why: `v${x.v}` };
  if (typeof x.at !== 'number' || !Number.isFinite(x.at)) return bad('at');
  const { videos, review, local, cache } = x;
  if (!Array.isArray(videos) || !isObj(review) || !Array.isArray(review.cards) || !Array.isArray(review.meta)) return bad('data');
  if (!strings(local)) return bad('local');
  if (!strings(cache) || !Object.keys(cache as object).every(k => CACHE_KEY.test(k))) return bad('cache');
  const manifest = { format: 1, app: '0', createdAt: x.at, ownDir: '', videos: videos.length, cards: review.cards.length, hadLicense: false, files: false, clips: [] };
  const p = checkBackup(manifest, { videos, cards: review.cards, reviewMeta: review.meta, localStorage: local }, '0');
  return p ? bad(p.why) : null;
}

// A file the user picked → a checked backup, or BackupProblem. A desktop zip is named as such.
export function parseBackup(text: string): MobileBackup {
  if (text.startsWith('PK')) throw new BackupProblem('desktop', 'zip');
  let x: unknown;
  try { x = JSON.parse(text); } catch { throw new BackupProblem('bad', 'json'); }
  const p = checkMobile(x);
  if (p) throw new BackupProblem(p.code, p.why);
  return x as MobileBackup;
}

// `blob:<id>` = an audio file kept on this phone under <id>; web addresses aren't.
export const blobId = (path: unknown): string | null =>
  typeof path === 'string' && path.startsWith('blob:') && !/^blob:https?:/.test(path) && path.length > 5 ? path.slice(5) : null;

// The phone audio a backup points at (records, unfinished imports, cards).
export const blobIds = (b: Pick<MobileBackup, 'videos' | 'review'>): string[] => [
  ...b.videos.flatMap(r => [blobId(r.videoPath), blobId((r.importJob as { source?: unknown } | undefined)?.source)]),
  ...b.review.cards.map(c => blobId(c.videoPath)),
].filter((x): x is string => x !== null);

// Stored audio nothing points at any more: not a record, its file or unfinished import, a
// card (a delete that failed at the cards step), nor a restore copy (sweepAudio in store.ts).
export const orphanAudio = (keys: string[], videos: Record<string, unknown>[], cards: ReviewCard[], copies: Pick<MobileBackup, 'videos' | 'review'>[]) => {
  const ids = new Set<string>([
    ...videos.map(r => String(r.id)),
    ...blobIds({ videos, review: { cards, meta: [] } }),
    ...copies.flatMap(blobIds),
  ]);
  return keys.filter(k => !ids.has(k));
};

// localStorage linguaclip_restore_pending: which copy is being restored, and how many tries started.
export interface Pending { use: 'staged' | 'pre'; tries: number }
export const readPending = (raw: string | null): Pending | null | 'unreadable' => {
  if (raw === null) return null;
  try {
    const p = JSON.parse(raw);
    return isObj(p) && (p.use === 'staged' || p.use === 'pre') && typeof p.tries === 'number' ? { use: p.use, tries: p.tries } : 'unreadable';
  } catch { return 'unreadable'; }
};
