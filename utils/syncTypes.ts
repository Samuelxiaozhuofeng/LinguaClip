/**
 * Shared TypeScript types and constants for the pure sync merge engine (docs/sync.md).
 */
import type { VideoRecord } from '../types';
import type { Clip, ReviewCard } from './review';
import type { LastWay } from './storage';

export const SYNC_FORMAT = 1;
export const MAX_REVLOGS = 8;
export const DAYS_DEV_KEEP = 35;
export const TOMBSTONE_GC_AGE_MS = 90 * 86_400_000;
export const ACTIVE_PEER_WINDOW_MS = 180 * 86_400_000;

export type SyncPlatform = 'mac' | 'windows' | 'android' | 'pwa';
export type RevGrade = 1 | 2 | 3 | 4;
export type CardRevLogEntry = [revId: string, grade: RevGrade, at: number];

export interface CardSyncMeta {
  bornAt: number;
  base?: ReviewCard['fsrs'];
  logs?: CardRevLogEntry[];
  /** Signed timestamp: > 0 bookmarked, < 0 un-bookmarked, 0/unset = legacy. */
  savedAt?: number;
  /** Signed timestamp: > 0 marked missed, < 0 unmarked, 0/unset = legacy. */
  missedAt?: number;
  /** Latest timestamp when "got it" (mastered) was cleared. */
  unmasteredAt?: number;
  /** Latest timestamp when definition / example / ai note was written. */
  noteAt?: number;
  /** Writer device id for deterministic tie-breaking on noteAt. */
  noteBy?: string;
}

export interface VideoTombstone {
  at: number;
  keepCards?: boolean;
}

export interface SyncTombstones {
  videos: Record<string, VideoTombstone>;
  cards: Record<string, number>;
  gcFloorAt?: number;
}

export interface DayBucket {
  sec: number;
  lines: number;
}

/** Per-date, per-device practice time & lines G-Counter: `daysDev[YYYY-MM-DD][devId]`. */
export type DaysDev = Record<string, Record<string, DayBucket>>;

/** Summed practice stats per date for `linguaclip_days`. */
export type ProjectedDays = Record<string, DayBucket>;

export interface VideoPosAt {
  watch?: number;
  watchBy?: string;
  custom?: number;
  customBy?: string;
  read?: number;
  readBy?: string;
  lastWay?: number;
  lastWayBy?: string;
}

export type PosAtMap = Record<string, VideoPosAt | number>;

export interface SyncPositions {
  watch: Record<string, number>;
  custom: Record<string, number>;
  read: Record<string, number>;
  lastWay: Record<string, LastWay>;
}

export interface SyncSettingEntry {
  value: string;
  at: number;
  by?: string;
}

export type SyncPodcastInfo = NonNullable<VideoRecord['podcast']> & {
  audio?: string;
};

/**
 * Lightweight video record stored in L1a device snapshots:
 * `VideoRecord` without `subtitleText`, `videoFileHandle`, `importJob`,
 * carrying `srtHash` and causal metadata instead.
 */
export type SyncVideoHeader = Omit<VideoRecord, 'subtitleText' | 'videoFileHandle' | 'importJob' | 'podcast'> & {
  srtHash: string;
  bornAt?: number;
  updatedBy?: string;
  importing?: boolean;
  podcast?: SyncPodcastInfo;
};

export interface DeviceSnapshot {
  v: number;
  devId: string;
  platform: SyncPlatform;
  ownDir: string;
  exportedAt: number;
  lastMergedAt: number;
  videos: SyncVideoHeader[];
  cards: ReviewCard[];
  cardMeta: Record<string, CardSyncMeta>;
  tombstones: SyncTombstones;
  daysDev: DaysDev;
  positions: SyncPositions;
  posAt: PosAtMap;
  readLooked?: Record<string, string[]>;
  readGloss?: Record<string, Record<string, string>>;
  keptOrphans?: string[];
  idRedirects?: Record<string, string>;
  settings?: Record<string, SyncSettingEntry>;
  clipPacks?: Record<string, string[]>;
}

export interface MergeOptions {
  localPlatform: SyncPlatform;
  localOwnDir: string;
  now: number;
  initialized: boolean;
  lastSyncAt: number;
  /** Optional subtitle text indexed by videoId or srtHash for ±1.5s rekey alignment. */
  subtitles?: Record<string, string>;
  /** Optional set of srtHashes already present locally (defaults to hashes in local.videos). */
  localSubHashes?: Iterable<string>;
  /** Optional set of clip filenames already stored locally. */
  localClipFiles?: Iterable<string>;
}

export interface NeededClip {
  cardId: string;
  clip: Clip;
  fromDevId: string;
  packName?: string;
}

export interface MergeSummary {
  addedVideos: number;
  updatedVideos: number;
  removedVideos: number;
  addedCards: number;
  updatedCards: number;
  removedCards: number;
}

export interface SafetyAlert {
  kind: 'firstSync' | 'massDeletion';
  firstSync: boolean;
  massDeletion: boolean;
  localVideos: number;
  localCards: number;
  dropVideos: number;
  dropCards: number;
  summary: MergeSummary;
}

export interface MergeResult {
  snapshot: DeviceSnapshot;
  projectedDays: ProjectedDays;
  rekeys: { from: string; to: string }[];
  keptOrphans: string[];
  watchPosUpdatedIds: string[];
  neededClips: NeededClip[];
  neededSubs: string[];
  candidateRemappedPaths: Record<string, string>;
  newerFormat: boolean;
  summary: MergeSummary;
  safetyAlert: SafetyAlert | null;
}
