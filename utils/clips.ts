/**
 * Review cards' own copies of their line, so a card still plays after its
 * video is deleted (Settings → Practice, off by default).
 *
 * fillClips() is the one place that does the work: with the setting on it cuts
 * a clip for every card that has none and whose video is still there (new cards,
 * and the ones from before the setting was turned on), one at a time, in the
 * background. The line and word cards of one line share a clip. Afterwards it
 * removes clip files no card uses any more (Rust keeps anything under an hour
 * old), so every way of deleting cards is covered without touching the files there.
 */
import { getAllCards, hasAudio, setClip, subscribeCards, type ReviewCard } from './review';
import { getVideoRecord } from './videoStorage';
import { clipPath, cutClip, pathExists, sweepClips } from './desktop';
import { getPracticeConfig } from './storage';

// Room around the line, so the lead-in / tail padding (up to 1s) still fits.
const MARGIN = 1.5;
export const clipKey = (c: Pick<ReviewCard, 'videoId' | 'start'>) => `${c.videoId}_${c.start.toFixed(2)}`;
export const clipSpan = (c: Pick<ReviewCard, 'start' | 'end'>): [number, number] => [Math.max(0, c.start - MARGIN), c.end + MARGIN];

// The video's current path (the record's wins over the card's snapshot), or null if the file is gone.
export const findVideo = async (c: ReviewCard): Promise<string | null> => {
  const rec = c.videoId ? await getVideoRecord(c.videoId).catch(() => null) : null;
  const path = rec?.videoPath ?? c.videoPath;
  return path && await pathExists(path) ? path : null;
};

// What to play a card from: its video while it is there, else its own clip.
// Times in the source are video times minus `offset`; `image` = the still shown with a sound-only clip.
export interface Source { path: string; offset: number; image?: string }
export const findSource = async (c: ReviewCard, video?: string | null): Promise<Source | null> => {
  const path = video !== undefined ? video : await findVideo(c).catch(() => null);
  if (path) return { path, offset: 0 };
  if (!c.clip) return null;
  const file = await clipPath(c.clip.file);
  if (!await pathExists(file).catch(() => false)) return null;
  return { path: file, offset: c.clip.from, image: c.clip.image ? await clipPath(c.clip.image) : undefined };
};

// --- Progress, for Settings ---

export interface ClipProgress {
  running: boolean;
  saved: number;    // cards with a clip
  total: number;    // cards with sound at all
  noVideo: number;  // cards without a clip whose video is gone: nothing to cut from
  error: string | null; // the last failure this session; cleared when a later cut works
}
let progress: ClipProgress = { running: false, saved: 0, total: 0, noVideo: 0, error: null };
const listeners = new Set<() => void>();
const set = (p: Partial<ClipProgress>) => { progress = { ...progress, ...p }; listeners.forEach(fn => fn()); };
export const getClipProgress = () => progress;
export const subscribeClips = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

// --- The work ---

const failed = new Set<string>(); // keys that failed this session; tried again next launch
let again = false;

const fillOnce = async () => {
  const cards = await getAllCards(); // unreadable: throws, so nothing below (the sweep above all) runs
  const { saveClips, clipKind = 'video' } = getPracticeConfig();
  const counts = (list: ReviewCard[]) => ({ saved: list.filter(c => c.clip).length, total: list.filter(hasAudio).length });
  // Every line's cards together: a card that already has the line's clip lends it to the rest
  // (a word kept while reviewing from the clip, after the video is gone) — setting on or off.
  const lines = new Map<string, ReviewCard[]>();
  for (const c of cards) if (hasAudio(c)) lines.set(clipKey(c), [...(lines.get(clipKey(c)) ?? []), c]);
  let noVideo = 0;
  if (saveClips) set({ running: true, ...counts(cards), noVideo: 0 });
  for (const [key, line] of lines) {
    const group = line.filter(c => !c.clip);
    const lent = line.find(c => c.clip)?.clip;
    if (group.length === 0) continue;
    if (lent) { await setClip(group.map(c => c.id), lent).catch(console.error); continue; }
    if (!getPracticeConfig().saveClips || failed.has(key)) continue; // off (maybe turned off meanwhile), or failed this session
    const src = await findVideo(group[0]).catch(() => null);
    if (!src) { noVideo += group.length; set({ noVideo }); continue; }
    const [from, to] = clipSpan(group[0]);
    try {
      const r = await cutClip(src, from, to, key, clipKind);
      await setClip(group.map(c => c.id), { kind: clipKind, file: r.file, image: r.image ?? undefined, from });
      set({ saved: getClipProgress().saved + group.length, error: null });
    } catch (e) {
      failed.add(key);
      set({ error: String(e) });
    }
  }
  // Read again: the files the cards use right now are the ones to keep.
  const now = await getAllCards();
  set(counts(now));
  await sweepClips(now.flatMap(c => c.clip ? [c.clip.file, ...(c.clip.image ? [c.clip.image] : [])] : []));
};

// Runs until nothing new came in meanwhile; a call while it runs asks for one more pass and
// gets the same promise, so awaiting it means "every card so far has had its go".
let current: Promise<void> | null = null;
export const fillClips = (): Promise<void> => {
  if (current) { again = true; return current; }
  set({ running: true });
  return current = (async () => {
    try {
      do { again = false; await fillOnce().catch(e => { console.error(e); set({ error: String(e) }); }); } while (again);
    } finally {
      current = null;
      set({ running: false });
    }
  })();
};

// Settings turned it on or changed the kind: failures from earlier get another go.
export const retryClips = () => {
  failed.clear();
  set({ error: null });
  return fillClips();
};

// App start: one pass now, then another shortly after any card change.
let timer = 0;
export const startClips = () => {
  fillClips();
  return subscribeCards(() => { window.clearTimeout(timer); timer = window.setTimeout(fillClips, 1500); });
};
