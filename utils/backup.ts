/**
 * Backup and restore, the pure part (docs/backup.md; checked by test-backup.mjs):
 * which settings go in, the check every backup passes (writing and restoring),
 * moving video paths to this computer, when the daily one is due and which old
 * ones go. Reading / writing happens in utils/backupData.ts and utils/restore.ts.
 */
import type { ReviewCard } from './review';

export const FORMAT = 1;
export const STAGED = 'restore-staged.zip';
export const PENDING_KEY = 'linguaclip_restore_pending';
export const LICENSE_KEY = 'linguaclip_pro_license';
// Not only the keys: address, model, prompt, transcription choice. Only a hand-made backup carries them.
export const SECRET_KEYS = ['linguaclip_ai_config', 'linguaclip_transcribe_config'];
// This computer's own state: never in a backup, never overwritten or removed by a restore.
const LOCAL_ONLY = [LICENSE_KEY, 'linguaclip_anki_tpl', 'linguaclip_today', PENDING_KEY];
const EXTRA = ['import_lang', 'import_trash_original'];

export const inBackup = (key: string) => (key.startsWith('linguaclip_') || EXTRA.includes(key)) && !LOCAL_ONLY.includes(key);
// The one place that says which settings a backup covers (backing up and restoring both use it).
export const backupKeys = (keys: string[]) => keys.filter(inBackup);

export type Kind = 'manual' | 'auto' | 'pre';

export interface Manifest {
  format: number;
  app: string;
  createdAt: number;
  platform: string;
  ownDir: string;
  videos: number;
  cards: number;
  hadLicense: boolean;
  files: boolean;
  clips: string[];
}

export interface Data {
  videos: Record<string, unknown>[];
  cards: ReviewCard[];
  reviewMeta: Record<string, unknown>[];
  localStorage: Record<string, string>;
}

export interface Pending { staged: string; pre: string | null; use: 'staged' | 'pre'; tries: number }

// The clip files these cards use (manifest `clips`, and what the clip sweep keeps).
export const clipFiles = (cards: Pick<ReviewCard, 'clip'>[]) =>
  [...new Set(cards.flatMap(c => c.clip ? [c.clip.file, ...(c.clip.image ? [c.clip.image] : [])] : []))];

export const isEmpty = (d: Pick<Data, 'videos' | 'cards'>) => d.videos.length === 0 && d.cards.length === 0;

// 1.2.10 > 1.2.9; anything after "-" is ignored.
export const compareVersions = (a: string, b: string) => {
  const parts = (v: string) => v.split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
  const x = parts(a), y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
};

// A video path inside the backup's own folder moves to this computer's own folder
// (folder boundary, either separator); anything else stays as it was.
export const remapPath = (path: string, from: string, to: string): string => {
  const base = from.replace(/[/\\]+$/, '');
  if (!base || path.length <= base.length || !path.startsWith(base) || !/[/\\]/.test(path[base.length])) return path;
  const sep = to.includes('\\') && !to.includes('/') ? '\\' : '/';
  return to.replace(/[/\\]+$/, '') + sep + path.slice(base.length + 1).split(/[/\\]+/).join(sep);
};

// --- The check ---

export type Problem = { newer: boolean; why: string } | null;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => typeof v === 'string';
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const bool = (v: unknown) => typeof v === 'boolean';
// Goes into a path: a plain file name, nothing that climbs or crosses folders.
export const plainName = (v: unknown) => str(v) && v !== '.' && v !== '..' && !/[/\\\0]/.test(v as string);

// Field rules, after types.ts (VideoRecord) and review.ts (ReviewCard): what must be there
// has the right type, what may be there has it when present; unknown extra fields pass.
// Only what a path or the schedule is built from is required: records written by old versions
// may lack (or hold null in) the rest, and the user's own data must never fail its own backup.
type Rule = (v: unknown) => boolean;
const opt = (r: Rule): Rule => v => v == null || r(v);
const oneOf = (...xs: unknown[]): Rule => v => xs.includes(v);
const id: Rule = v => plainName(v) && v !== '';
const firstBad = (o: Record<string, unknown>, rules: Record<string, Rule>) => Object.keys(rules).find(k => !rules[k](o[k])) ?? null;
const shape = (rules: Record<string, Rule>): Rule => v => isObj(v) && firstBad(v, rules) === null;

const VIDEO: Record<string, Rule> = {
  id, displayName: opt(str), videoFileName: opt(str), subtitleFileName: opt(v => v === '' || plainName(v)), videoPath: opt(str), subtitleText: str,
  currentSubtitleIndex: opt(num), currentSectionIndex: opt(num), totalSubtitles: opt(num), completionRate: opt(num),
  dateAdded: opt(num), lastPracticed: opt(num), totalPracticeTime: opt(num),
  learningMode: opt(str), blurPlaybackMode: opt(str), lang: opt(str),
  podcast: opt(shape({ show: str, feed: str, guid: str, image: opt(str), name: str })),
  importJob: opt(shape({
    stage: str, percent: opt(num), error: opt(str), source: str, lang: opt(str), quality: opt(num),
    convert: opt(bool), subs: opt(v => v === 'own' || num(v)), trashOriginal: opt(bool), converted: opt(str),
  })),
};
const CARD: Record<string, Rule> = {
  id: v => str(v) && v !== '', deck: oneOf('line', 'word'), videoId: opt(v => v === '' || plainName(v)), videoName: opt(str), videoPath: opt(str),
  text: str, start: num, end: num, word: opt(str), definition: opt(str), example: opt(str),
  reasons: opt(v => Array.isArray(v) && v.every(str)), saved: opt(bool),
  clip: opt(shape({ kind: oneOf('video', 'audio'), file: plainName, image: opt(plainName), from: num })),
  fsrs: shape({
    due: num, stability: num, difficulty: opt(num), elapsed_days: opt(num), scheduled_days: opt(num), learning_steps: opt(num),
    reps: opt(num), lapses: opt(num), state: num, last_review: opt(num),
  }),
  createdAt: opt(num),
};

const listProblem = (list: unknown[], name: string, rules: Record<string, Rule>): string | null => {
  const seen = new Set<unknown>();
  for (const [i, x] of list.entries()) {
    if (!isObj(x)) return `${name}[${i}]`;
    const bad = firstBad(x, rules);
    if (bad) return `${name}[${i}].${bad}`;
    if (seen.has(x.id)) return `${name}[${i}].id repeated`; // a second one would silently replace the first
    seen.add(x.id);
  }
  return null;
};

// Everything the app start and the restore will rely on. Any failure rejects the whole backup.
export const checkBackup = (manifest: unknown, data: unknown, appVersion: string): Problem => {
  const bad = (why: string): Problem => ({ newer: false, why });
  if (!isObj(manifest)) return bad('manifest');
  if (!num(manifest.format) || (manifest.format as number) < 1) return bad('manifest.format');
  if ((manifest.format as number) > FORMAT) return { newer: true, why: 'format' };
  if (!str(manifest.app)) return bad('manifest.app');
  if (compareVersions(manifest.app as string, appVersion) > 0) return { newer: true, why: `app ${manifest.app}` };
  if (!num(manifest.createdAt) || !str(manifest.ownDir) || !num(manifest.videos) || !num(manifest.cards)) return bad('manifest');
  if (typeof manifest.files !== 'boolean' || typeof manifest.hadLicense !== 'boolean') return bad('manifest');
  if (!Array.isArray(manifest.clips) || !manifest.clips.every(plainName)) return bad('manifest.clips');
  if (!isObj(data)) return bad('data');
  const { videos, cards, reviewMeta, localStorage: ls } = data;
  if (!Array.isArray(videos) || !Array.isArray(cards) || !Array.isArray(reviewMeta)) return bad('data');
  if (videos.length !== manifest.videos || cards.length !== manifest.cards) return bad('counts');
  const listBad = listProblem(videos, 'videos', VIDEO) ?? listProblem(cards, 'cards', CARD) ?? listProblem(reviewMeta, 'reviewMeta', { id: str });
  if (listBad) return bad(listBad);
  if (!isObj(ls) || !Object.values(ls).every(str)) return bad('localStorage');
  return null;
};

// --- Restoring settings ---

// Backup's settings first, then the ones in range it doesn't have go. The AI / transcription
// settings already on this computer are never touched: only a computer without them takes the backup's.
export const planLocalStorage = (current: Record<string, string>, backup: Record<string, string>) => ({
  set: Object.entries(backup).filter(([k]) => inBackup(k) && !(SECRET_KEYS.includes(k) && k in current)),
  remove: Object.keys(current).filter(k => inBackup(k) && !(k in backup) && !SECRET_KEYS.includes(k)),
});

// --- Automatic ones ---

export interface Listed { path: string; manifest: Manifest }

export const fileName = (path: string) => path.split(/[/\\]/).pop() ?? path;
export const kindOf = (path: string): 'auto' | 'pre' | null => {
  const name = fileName(path);
  return name.startsWith('LinguaClip-auto-') ? 'auto' : name.startsWith('LinguaClip-pre-') ? 'pre' : null;
};

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

// Newest automatic backup's time, or null.
export const lastAuto = (list: Listed[]) =>
  list.filter(l => kindOf(l.path) === 'auto' && countsOk(l)).reduce<number | null>((m, l) => Math.max(m ?? 0, l.manifest.createdAt), null);

// Today's (local date) automatic backup isn't there yet, and no restore is under way.
export const dueForAuto = (list: Listed[], now: number, pending: boolean) =>
  !pending && !list.some(l => kindOf(l.path) === 'auto' && sameDay(l.manifest.createdAt, now));

// Counts and time a backup's own manifest must have to be listed, shown or weighed.
export const countsOk = (l: Listed) => isObj(l.manifest) && num(l.manifest.createdAt) && num(l.manifest.videos) && num(l.manifest.cards);

// File names to delete: daily ones beyond the newest 7 (but the biggest older one stays if it is
// bigger than each of those 7), "before restore" ones beyond the newest 3. Only our own names
// count; if any of those has no proper time / counts, nothing goes this time.
export const rotate = (list: Listed[]): string[] => {
  const ours = list.filter(l => kindOf(l.path));
  if (!ours.every(countsOk)) return [];
  const newest = (kind: 'auto' | 'pre') => ours.filter(l => kindOf(l.path) === kind).sort((a, b) => b.manifest.createdAt - a.manifest.createdAt);
  const size = (l: Listed) => l.manifest.videos + l.manifest.cards;
  const autos = newest('auto'), pres = newest('pre');
  const old = autos.slice(7);
  const top = Math.max(0, ...autos.slice(0, 7).map(size));
  const biggest = old.reduce<Listed | null>((m, l) => (size(l) > (m ? size(m) : top) ? l : m), null);
  return [...old.filter(l => l !== biggest), ...pres.slice(3)].map(l => fileName(l.path));
};
