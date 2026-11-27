/**
 * Deterministic podcast/starter episode deduplication (rekey), subtitle timestamp
 * alignment (±1.5s), video header merge, and cross-platform `videoPath` isolation.
 */
import { DEVICE_ONLY, LICENSE_KEY, PENDING_KEY, SECRET_KEYS, remapPath } from './backup';
import { lineCardId, wordCardId, type ReviewCard } from './review';
import { parseSRT } from './srtParser';
import { compareStamp, epNormKey, episodeUuid } from './syncClock';
import { DAYS_DEV_KEY, POS_AT_KEY, SYNC_AUTH_KEY, SYNC_DEVICE_KEY, SYNC_STATE_KEY } from './syncConfig';
import { mergeCard } from './syncCardMerge';
import {
  DAYS_DEV_KEEP,
  type CardSyncMeta,
  type DaysDev,
  type DeviceSnapshot,
  type MergeOptions,
  type ProjectedDays,
  type SyncPlatform,
  type SyncSettingEntry,
  type SyncVideoHeader,
  type VideoTombstone,
} from './syncTypes';

export const isHttpUrl = (p?: string) => !!p && /^https?:\/\//i.test(p);
export const isAndroidPath = (p?: string) =>
  !!p && (/^\/data\/(?:user|data)\//.test(p) || /^\/storage\/emulated\//.test(p) || /^content:\/\//.test(p));
export const isWindowsPath = (p?: string) => !!p && (/^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p));
export const isMacPath = (p?: string) => !!p && /^\/(?:Users|Volumes|Applications|Library|private|var|tmp)\//.test(p);
export const isDesktopPlatform = (p: SyncPlatform) => p === 'mac' || p === 'windows';
export const isVideoComplete = (v: SyncVideoHeader) => !v.importing && (v.totalSubtitles > 0 || !!v.srtHash);

const normSubText = (text: string) =>
  text.normalize('NFC').toLowerCase().replace(/[\s\p{P}]+/gu, ' ').trim();

export function sortObj<T>(obj: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k];
  return out;
}

export function buildRedirects(snapshots: DeviceSnapshot[]): Record<string, string> {
  const raw: Record<string, string> = {};
  for (const s of snapshots) {
    for (const [from, to] of Object.entries(s.idRedirects ?? {})) {
      if (!from || !to || from === to) continue;
      if (!raw[from] || to < raw[from]) raw[from] = to;
    }
  }

  type EpCand = { id: string; completed: boolean; canonical: boolean; dateAdded: number };
  const groups = new Map<string, Map<string, EpCand>>();
  for (const s of snapshots) {
    for (const v of s.videos) {
      if (!v.podcast?.feed || !v.podcast?.guid) continue;
      const key = epNormKey(v.podcast.feed, v.podcast.guid);
      const canonId = episodeUuid(v.podcast.feed, v.podcast.guid);
      let g = groups.get(key);
      if (!g) { g = new Map(); groups.set(key, g); }
      const cur = g.get(v.id);
      const completed = isVideoComplete(v);
      const dAdded = v.dateAdded > 0 ? v.dateAdded : Number.MAX_SAFE_INTEGER;
      if (!cur) g.set(v.id, { id: v.id, completed, canonical: v.id === canonId, dateAdded: dAdded });
      else { cur.completed = cur.completed || completed; cur.dateAdded = Math.min(cur.dateAdded, dAdded); }
    }
  }

  for (const g of groups.values()) {
    if (g.size <= 1) continue;
    const sorted = Array.from(g.values()).sort((a, b) => {
      if (a.completed !== b.completed) return a.completed ? -1 : 1;
      if (a.canonical !== b.canonical) return a.canonical ? -1 : 1;
      if (a.dateAdded !== b.dateAdded) return a.dateAdded - b.dateAdded;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    const winner = sorted[0].id;
    for (let i = 1; i < sorted.length; i++) raw[sorted[i].id] = winner;
  }

  const flat: Record<string, string> = {};
  for (const k of Object.keys(raw).sort()) {
    const seen = new Set<string>([k]);
    let cur = raw[k];
    while (raw[cur] && !seen.has(raw[cur])) { seen.add(cur); cur = raw[cur]; }
    if (cur !== k) flat[k] = cur;
  }
  return sortObj(flat);
}

export interface AlignLine { start: number; end: number; norm: string }

export function buildWinnerAlignmentIndex(
  snapshots: DeviceSnapshot[],
  redirects: Record<string, string>,
  subtitles?: Record<string, string>,
): Map<string, AlignLine[]> {
  const index = new Map<string, AlignLine[]>();
  const winners = new Set(Object.values(redirects));
  if (winners.size === 0) return index;

  for (const wid of winners) {
    const lines: AlignLine[] = [];
    const seen = new Set<string>();
    const pushLine = (start: number, end: number, text: string) => {
      const norm = normSubText(text);
      if (!norm) return;
      const k = `${start.toFixed(2)}|${norm}`;
      if (seen.has(k)) return;
      seen.add(k);
      lines.push({ start, end, norm });
    };

    if (subtitles) {
      let srt = subtitles[wid];
      if (!srt) {
        for (const s of snapshots) {
          const v = s.videos.find(x => x.id === wid && x.srtHash && subtitles[x.srtHash]);
          if (v) { srt = subtitles[v.srtHash]; break; }
        }
      }
      if (srt) for (const sub of parseSRT(srt)) pushLine(sub.startTime, sub.endTime, sub.text);
    }
    for (const s of snapshots) {
      for (const c of s.cards) if (c.videoId === wid && c.start >= 0) pushLine(c.start, c.end, c.text);
    }
    if (lines.length > 0) index.set(wid, lines);
  }
  return index;
}

export function alignCardToWinner(
  card: ReviewCard,
  winnerId: string,
  alignIndex: Map<string, AlignLine[]>,
): ReviewCard {
  let start = card.start;
  let end = card.end;
  if (start >= 0) {
    const candidates = alignIndex.get(winnerId);
    if (candidates) {
      const targetNorm = normSubText(card.text);
      let best: AlignLine | null = null;
      let bestGap = Infinity;
      for (const line of candidates) {
        if (line.norm !== targetNorm) continue;
        const gap = Math.abs(line.start - start);
        if (gap <= 1.5 && gap < bestGap) { bestGap = gap; best = line; }
      }
      if (best) { start = best.start; end = best.end; }
    }
  }
  const newId = card.videoId && start >= 0
    ? (card.deck === 'word' && card.word ? wordCardId(winnerId, start, card.word) : lineCardId(winnerId, start))
    : card.id;
  return { ...card, id: newId, videoId: winnerId, start, end };
}

export function remapCardIdString(cardId: string, redirects: Record<string, string>): string {
  const bar = cardId.indexOf('|');
  if (bar <= 0) return cardId;
  const target = redirects[cardId.slice(0, bar)];
  return target ? `${target}${cardId.slice(bar)}` : cardId;
}

export function mergeTwoVideos(
  a: SyncVideoHeader,
  devA: string,
  b: SyncVideoHeader,
  devB: string,
): SyncVideoHeader {
  const aComp = isVideoComplete(a);
  const bComp = isVideoComplete(b);
  const byA = a.updatedBy ?? devA;
  const byB = b.updatedBy ?? devB;
  const cmp =
    compareStamp(a.lastPracticed || 0, byA, b.lastPracticed || 0, byB) ||
    (a.completionRate || 0) - (b.completionRate || 0) ||
    (a.currentSubtitleIndex || 0) - (b.currentSubtitleIndex || 0);
  const win = cmp >= 0 ? a : b;
  const lose = cmp >= 0 ? b : a;
  const updatedBy = cmp >= 0 ? byA : byB;

  const contentWin = aComp !== bComp ? (aComp ? a : b) : win;
  const contentLose = contentWin === a ? b : a;
  const dateAdded =
    a.dateAdded > 0 && b.dateAdded > 0 ? Math.min(a.dateAdded, b.dateAdded) : (a.dateAdded || b.dateAdded || 0);
  const bornAt = Math.max(a.bornAt ?? a.dateAdded ?? 0, b.bornAt ?? b.dateAdded ?? 0);

  let podcast = win.podcast ?? lose.podcast;
  if (win.podcast && lose.podcast) {
    podcast = {
      ...lose.podcast,
      ...win.podcast,
      ...(win.podcast.image || lose.podcast.image ? { image: win.podcast.image || lose.podcast.image } : {}),
      ...(win.podcast.audio || lose.podcast.audio ? { audio: win.podcast.audio || lose.podcast.audio } : {}),
    };
  }

  return {
    ...lose,
    ...win,
    id: a.id,
    displayName: win.displayName || lose.displayName,
    videoFileName: contentWin.videoFileName || contentLose.videoFileName,
    subtitleFileName: contentWin.subtitleFileName || contentLose.subtitleFileName,
    srtHash: contentWin.srtHash || contentLose.srtHash,
    totalSubtitles: contentWin.totalSubtitles || contentLose.totalSubtitles,
    ...(aComp || bComp ? {} : { importing: true }),
    dateAdded,
    bornAt,
    lastPracticed: Math.max(a.lastPracticed || 0, b.lastPracticed || 0),
    totalPracticeTime: Math.max(a.totalPracticeTime || 0, b.totalPracticeTime || 0),
    updatedBy,
    ...(win.lang ?? lose.lang ? { lang: win.lang ?? lose.lang } : {}),
    ...(podcast ? { podcast } : {}),
  };
}

export function resolveVideoPathForLocal(
  merged: SyncVideoHeader,
  localExisting: SyncVideoHeader | undefined,
  peerSources: { video: SyncVideoHeader; platform: SyncPlatform; ownDir: string }[],
  opts: MergeOptions,
  candidateRemappedPaths: Record<string, string>,
): string | undefined {
  if (localExisting) {
    if (localExisting.videoPath) return localExisting.videoPath;
    if (!isDesktopPlatform(opts.localPlatform) && isHttpUrl(merged.podcast?.audio)) {
      return merged.podcast!.audio;
    }
    return undefined;
  }

  if (isDesktopPlatform(opts.localPlatform)) {
    for (const src of peerSources) {
      const p = src.video.videoPath;
      if (!p || isHttpUrl(p) || p.startsWith('blob:') || isAndroidPath(p)) continue;
      if (!isDesktopPlatform(src.platform)) continue;
      candidateRemappedPaths[merged.id] = remapPath(p, src.ownDir, opts.localOwnDir);
      break;
    }
    return undefined;
  }

  if (isHttpUrl(merged.podcast?.audio)) return merged.podcast!.audio;
  for (const src of peerSources) {
    const p = src.video.videoPath;
    if (isHttpUrl(p)) return p;
    if (isMacPath(p) || isWindowsPath(p) || isAndroidPath(p)) continue;
  }
  return undefined;
}

export interface RemappedSnapshot {
  snapshot: DeviceSnapshot;
  videos: Map<string, SyncVideoHeader>;
  cards: Map<string, ReviewCard>;
  cardMeta: Record<string, CardSyncMeta>;
  vTombs: Record<string, VideoTombstone>;
  cTombs: Record<string, number>;
  cardIdMap: Map<string, string>;
}

export function remapSnapshot(
  s: DeviceSnapshot,
  redirects: Record<string, string>,
  alignIndex: Map<string, AlignLine[]>,
): RemappedSnapshot {
  const resolveId = (id: string) => redirects[id] ?? id;
  const videos = new Map<string, SyncVideoHeader>();
  for (const rawV of s.videos) {
    const vid = resolveId(rawV.id);
    const v: SyncVideoHeader = vid === rawV.id ? rawV : { ...rawV, id: vid };
    const prev = videos.get(vid);
    videos.set(vid, prev ? mergeTwoVideos(prev, s.devId, v, s.devId) : v);
  }

  const cards = new Map<string, ReviewCard>();
  const cardMeta: Record<string, CardSyncMeta> = {};
  const cardIdMap = new Map<string, string>();
  for (const rawC of s.cards) {
    const targetVid = rawC.videoId ? resolveId(rawC.videoId) : '';
    const c = targetVid && targetVid !== rawC.videoId ? alignCardToWinner(rawC, targetVid, alignIndex) : rawC;
    cardIdMap.set(rawC.id, c.id);
    const rawMeta = s.cardMeta[rawC.id] ?? { bornAt: rawC.createdAt || 0 };
    const prev = cards.get(c.id);
    if (prev) {
      const merged = mergeCard(prev, cardMeta[c.id], s.devId, c, rawMeta, s.devId);
      cards.set(c.id, merged.card);
      cardMeta[c.id] = merged.meta;
    } else {
      cards.set(c.id, c);
      cardMeta[c.id] = rawMeta;
    }
  }

  const vTombs: Record<string, VideoTombstone> = {};
  for (const [vid, tomb] of Object.entries(s.tombstones.videos ?? {})) {
    const id = resolveId(vid);
    const prev = vTombs[id];
    if (!prev || tomb.at > prev.at) vTombs[id] = { at: tomb.at, ...(tomb.keepCards ? { keepCards: true } : {}) };
    else if (tomb.at === prev.at && tomb.keepCards) vTombs[id] = { at: prev.at, keepCards: true };
  }

  const cTombs: Record<string, number> = {};
  for (const [cid, at] of Object.entries(s.tombstones.cards ?? {})) {
    const id = cardIdMap.get(cid) ?? remapCardIdString(cid, redirects);
    if (!cTombs[id] || at > cTombs[id]) cTombs[id] = at;
  }

  return { snapshot: s, videos, cards, cardMeta, vTombs, cTombs, cardIdMap };
}

const BLOCKED_SETTINGS = new Set<string>([
  LICENSE_KEY, 'linguaclip_anki_tpl', 'linguaclip_today', 'linguaclip_days', PENDING_KEY,
  SYNC_DEVICE_KEY, SYNC_AUTH_KEY, SYNC_STATE_KEY, DAYS_DEV_KEY, POS_AT_KEY,
  ...SECRET_KEYS,
  ...DEVICE_ONLY,
]);

const SAFE_SETTINGS = new Set<string>([
  'linguaclip_practice_config',
  'linguaclip_watch_prefs',
  'linguaclip_audio_padding',
  'linguaclip_loop',
  'linguaclip_speed_dictation',
  'linguaclip_speed_watch',
  'linguaclip_speed_listen',
  'linguaclip_podcast_subs',
  'linguaclip_lang',
  'linguaclip_deck_lang',
]);

export function mergeDaysDev(snapshots: DeviceSnapshot[]): { daysDev: DaysDev; projectedDays: ProjectedDays } {
  const raw: DaysDev = {};
  for (const s of snapshots) {
    for (const [date, devMap] of Object.entries(s.daysDev ?? {})) {
      if (!devMap || typeof devMap !== 'object') continue;
      if (!raw[date]) raw[date] = {};
      for (const [devId, b] of Object.entries(devMap)) {
        if (!b || typeof b !== 'object') continue;
        const sec = Math.max(0, Number(b.sec) || 0);
        const lines = Math.max(0, Number(b.lines) || 0);
        const prev = raw[date][devId];
        raw[date][devId] = prev
          ? { sec: Math.max(prev.sec, sec), lines: Math.max(prev.lines, lines) }
          : { sec, lines };
      }
    }
  }
  const daysDev: DaysDev = {};
  const projectedDays: ProjectedDays = {};
  for (const date of Object.keys(raw).sort().slice(-DAYS_DEV_KEEP)) {
    daysDev[date] = sortObj(raw[date]);
    let sec = 0, lines = 0;
    for (const b of Object.values(daysDev[date])) { sec += b.sec; lines += b.lines; }
    projectedDays[date] = { sec, lines };
  }
  return { daysDev, projectedDays };
}

export function mergeSettings(snapshots: DeviceSnapshot[]): Record<string, SyncSettingEntry> {
  const out: Record<string, SyncSettingEntry> = {};
  const keys = new Set<string>();
  for (const s of snapshots) {
    for (const k of Object.keys(s.settings ?? {})) {
      if (!BLOCKED_SETTINGS.has(k) && SAFE_SETTINGS.has(k)) keys.add(k);
    }
  }
  for (const k of Array.from(keys).sort()) {
    let best: SyncSettingEntry | null = null;
    for (const s of snapshots) {
      const e = s.settings?.[k];
      if (!e || typeof e.value !== 'string') continue;
      const cand: SyncSettingEntry = { value: e.value, at: e.at || 0, by: e.by ?? s.devId };
      if (!best || compareStamp(cand.at, cand.by!, best.at, best.by!) > 0) best = cand;
    }
    if (best) out[k] = best;
  }
  return out;
}
