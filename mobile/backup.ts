// The phone backup, the pure part (docs/mobile-web.md「备份」「恢复」; node mobile/test-backup.mjs):
// what one json holds, the check every backup passes (exporting, staging and restoring),
// which settings go in / are replaced, which audio files a backup still points at, and
// the restore marker. Records and cards are checked with the desktop's own rules
// (utils/backup.ts checkBackup). Reading / writing is in mobile/restore.ts.
import {
  FORMAT, LICENSE_KEY, SECRET_KEYS, backupKeys, checkBackup, clipFiles, inBackup, planLocalStorage,
  type Data, type Manifest,
} from '../utils/backup';
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
// Backup's settings first, then the ones in range it lacks go; keys / LOCAL_ONLY never touched
// for PWA JSON backups. Android .zip restores pass includeKeys (same-platform) or crossPlatform.
export const planLocal = (
  current: Record<string, string>,
  backup: Record<string, string>,
  opts?: { crossPlatform?: boolean; target?: 'android' | 'desktop'; includeKeys?: boolean },
) => (opts?.crossPlatform || opts?.includeKeys
  ? planLocalStorage(current, backup, opts?.crossPlatform ? { crossPlatform: true, target: opts.target } : undefined)
  : planLocalStorage(current, pickLocal(backup)));

// Builds a desktop-compatible manifest + data payload for Android native .zip export.
export function buildAndroidZipPayload(opts: {
  videos: Record<string, unknown>[];
  cards: ReviewCard[];
  meta: Record<string, unknown>[];
  local: Record<string, string>;
  appVersion: string;
  ownDir: string;
  includeKeys: boolean;
  createdAt: number;
}): { manifest: Manifest; data: Data } {
  const ls: Record<string, string> = {};
  for (const k of backupKeys(Object.keys(opts.local))) {
    if (!opts.includeKeys && SECRET_KEYS.includes(k)) continue;
    ls[k] = opts.local[k];
  }
  const manifest: Manifest = {
    format: FORMAT,
    app: opts.appVersion,
    createdAt: opts.createdAt,
    platform: 'android',
    ownDir: opts.ownDir,
    videos: opts.videos.length,
    cards: opts.cards.length,
    hadLicense: opts.local[LICENSE_KEY] != null,
    files: true,
    clips: clipFiles(opts.cards),
  };
  const data: Data = {
    videos: opts.videos,
    cards: opts.cards,
    reviewMeta: opts.meta,
    localStorage: ls,
  };
  const p = checkBackup(manifest, data, opts.appVersion);
  if (p) throw new BackupProblem('bad', p.why);
  return { manifest, data };
}

export function fromDesktopBackup(
  manifest: unknown,
  data: unknown,
  appVersion: string,
  opts?: { crossPlatform?: boolean },
): MobileBackup {
  const p = checkBackup(manifest, data, appVersion, opts?.crossPlatform === false ? undefined : { crossPlatform: true });
  if (p) throw new BackupProblem(p.newer ? 'newer' : 'bad', p.why);
  const m = manifest as { createdAt: number };
  const d = data as {
    videos: Record<string, unknown>[];
    cards: ReviewCard[];
    reviewMeta: Record<string, unknown>[];
    localStorage: Record<string, string>;
  };
  return {
    v: V,
    platform: 'mobile',
    at: m.createdAt,
    videos: d.videos,
    review: { cards: d.cards, meta: d.reviewMeta },
    local: d.localStorage,
    cache: {},
  };
}

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
export interface Pending { use: 'staged' | 'pre'; tries: number; zip?: string; cross?: boolean }
export const readPending = (raw: string | null): Pending | null | 'unreadable' => {
  if (raw === null) return null;
  try {
    const p = JSON.parse(raw);
    if (!isObj(p) || (p.use !== 'staged' && p.use !== 'pre') || typeof p.tries !== 'number') return 'unreadable';
    const out: Pending = { use: p.use, tries: p.tries };
    if (typeof p.zip === 'string' && p.zip) out.zip = p.zip;
    if (p.cross === true) out.cross = true;
    return out;
  } catch { return 'unreadable'; }
};
