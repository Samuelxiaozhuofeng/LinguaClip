/**
 * localStorage settings filtering (stripping device-local Desktop fields) and
 * concurrency-safe live position / readLooked / readGloss reconciliation (docs/sync.md).
 * Zero @tauri-apps/* imports (100% PWA-safe).
 */
import type { PracticeConfig } from '../types';
import { DEVICE_ONLY, LICENSE_KEY, PENDING_KEY, SECRET_KEYS } from './backup';
import { getAllReadGloss, getAllReadLooked, getAllReadPos } from './readLooked';
import {
  getAllCustomPos, getAllLastWay, getAllWatchPos, getPracticeConfig,
  savePracticeConfig, saveWatchPrefs, type LastWay, type WatchPrefs,
} from './storage';
import { bumpTs, compareStamp } from './syncClock';
import {
  DAYS_DEV_KEY, POS_AT_KEY, SYNC_AUTH_KEY, SYNC_DEVICE_KEY, SYNC_STATE_KEY,
  getSyncState, saveSyncState,
} from './syncConfig';
import { readPosAt, withSyncDirtySuppressed, writePosAt } from './syncMeta';
import type { MergeResult, PosAtMap, SyncSettingEntry, VideoPosAt } from './syncTypes';

export const META_SYNC_SETTINGS = 'sync_settings_meta';
export const KEPT_ORPHANS_KEY = 'linguaclip_kept_orphans';

export const SAFE_SYNC_SETTING_KEYS = [
  'linguaclip_practice_config', 'linguaclip_watch_prefs', 'linguaclip_audio_padding',
  'linguaclip_loop', 'linguaclip_speed_dictation', 'linguaclip_speed_watch',
  'linguaclip_speed_listen', 'linguaclip_podcast_subs',
] as const;

// Device-specific fields kept local (never synced across Desktop ↔ Phone).
const LOCAL_PRACTICE_FIELDS = new Set(['saveClips', 'clipKind', 'videoShare', 'custom']);
const LOCAL_WATCH_PREF_FIELDS = new Set(['pin', 'list', 'listPct', 'readerSize', 'chosen']);

const BLOCKED_SETTING_KEYS = new Set<string>([
  LICENSE_KEY, 'linguaclip_anki_tpl', 'linguaclip_today', 'linguaclip_days', PENDING_KEY,
  SYNC_DEVICE_KEY, SYNC_AUTH_KEY, SYNC_STATE_KEY, DAYS_DEV_KEY, POS_AT_KEY,
  ...SECRET_KEYS, ...DEVICE_ONLY,
]);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function readKeptOrphans(): string[] {
  try {
    const raw = typeof localStorage !== 'undefined' ? JSON.parse(localStorage.getItem(KEPT_ORPHANS_KEY) || '[]') : [];
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

function stripObjectFields(raw: string, exclude: Set<string>): string | null {
  try {
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(parsed).sort()) if (!exclude.has(k)) out[k] = parsed[k];
    return Object.keys(out).length > 0 ? JSON.stringify(out) : null;
  } catch { return null; }
}

function normalizeSettingForSync(key: string, raw: string): string | null {
  if (key === 'linguaclip_practice_config') return stripObjectFields(raw, LOCAL_PRACTICE_FIELDS);
  if (key === 'linguaclip_watch_prefs') return stripObjectFields(raw, LOCAL_WATCH_PREF_FIELDS);
  return raw;
}

export function extractSettingsMeta(metaRows: Record<string, unknown>[]): Record<string, SyncSettingEntry> {
  const row = metaRows.find(r => isRecord(r) && r.id === META_SYNC_SETTINGS && isRecord(r.map));
  if (!row || !isRecord(row.map)) return {};
  const out: Record<string, SyncSettingEntry> = {};
  for (const [k, v] of Object.entries(row.map)) {
    if (isRecord(v) && typeof v.value === 'string' && typeof v.at === 'number') {
      out[k] = { value: v.value, at: v.at, ...(typeof v.by === 'string' ? { by: v.by } : {}) };
    }
  }
  return out;
}

export function collectSafeSettings(
  prevMeta: Record<string, SyncSettingEntry>, devId: string, now: number,
): Record<string, SyncSettingEntry> {
  if (typeof localStorage === 'undefined') return {};
  const touched = getSyncState().settingAt ?? {};
  const out: Record<string, SyncSettingEntry> = {};
  for (const key of SAFE_SYNC_SETTING_KEYS) {
    if (BLOCKED_SETTING_KEYS.has(key)) continue;
    let raw: string | null = null;
    try { raw = localStorage.getItem(key); } catch { raw = null; }
    if (raw === null) continue;
    const norm = normalizeSettingForSync(key, raw);
    if (norm === null) continue;
    const prev = prevMeta[key];
    const explicit = touched[key];
    if (explicit && (!prev || (prev.value !== norm && explicit.at >= prev.at))) {
      out[key] = { value: norm, at: explicit.at, by: explicit.by || devId };
    } else if (prev && prev.value === norm) {
      out[key] = { value: norm, at: prev.at, by: prev.by ?? devId };
    } else if (prev) {
      out[key] = { value: norm, at: bumpTs(prev.at, now), by: devId };
    } else {
      // Untouched default on a newly paired device gets timestamp 0 so existing remote settings win.
      out[key] = { value: norm, at: 0, by: devId };
    }
  }
  return out;
}

function posStamp(
  map: PosAtMap, vid: string,
  field: 'watch' | 'custom' | 'read' | 'lastWay',
  byField: 'watchBy' | 'customBy' | 'readBy' | 'lastWayBy',
  fallbackBy: string,
) {
  const raw = map[vid];
  const ts = typeof raw === 'number' ? raw : (raw?.[field] ?? 0);
  const by = typeof raw === 'object' && raw?.[byField] ? raw[byField]! : fallbackBy;
  return { ts, by };
}

/** Re-read live localStorage positions, reading lookups & settings and apply non-destructively. */
export async function applyLiveLocalStorageMerge(args: {
  result: MergeResult;
  devId: string;
  liveVideoIds: Set<string>;
  readyRekeys: { from: string; to: string }[];
}): Promise<string[]> {
  const { result, devId, liveVideoIds, readyRekeys } = args;
  const readyRekeyFromSet = new Set(readyRekeys.map(r => r.from));
  const rekeyToFroms = new Map<string, string[]>();
  for (const r of readyRekeys) rekeyToFroms.set(r.to, [...(rekeyToFroms.get(r.to) ?? []), r.from]);
  const actualWatchUpdatedIds: string[] = [];
  if (typeof localStorage === 'undefined') return actualWatchUpdatedIds;

  const vTombs = result.snapshot.tombstones.videos ?? {};
  await withSyncDirtySuppressed(async () => {
    const safeWrite = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota */ } };
    const livePosAt = readPosAt(), mergedPosAt = result.snapshot.posAt;
    const finalPosAt: PosAtMap = {};
    const liveMaps = {
      watch: getAllWatchPos(), custom: getAllCustomPos(), read: getAllReadPos(), lastWay: getAllLastWay(),
    };
    const outMaps = {
      watch: {} as Record<string, number>, custom: {} as Record<string, number>,
      read: {} as Record<string, number>, lastWay: {} as Record<string, LastWay>,
    };
    const specs = [
      ['watch', 'watchBy'], ['custom', 'customBy'], ['read', 'readBy'], ['lastWay', 'lastWayBy'],
    ] as const;

    for (const [field, byField] of specs) {
      const lMap = liveMaps[field] as Record<string, unknown>;
      const mMap = result.snapshot.positions[field] as Record<string, unknown>;
      const vids = new Set([...Object.keys(lMap), ...Object.keys(mMap), ...rekeyToFroms.keys()]);
      for (const vid of Array.from(vids).sort()) {
        if (readyRekeyFromSet.has(vid)) continue;
        // Include live advances saved onto a rekeyed `from` id before migration completed.
        const liveIds = [vid, ...(rekeyToFroms.get(vid) ?? [])];
        let hasL = false, liveVal: unknown = undefined;
        let ls = { ts: 0, by: devId };
        for (const lid of liveIds) {
          if (!(lid in lMap)) continue;
          const stCand = posStamp(livePosAt, lid, field, byField, devId);
          if (!hasL || compareStamp(stCand.ts, stCand.by, ls.ts, ls.by) > 0) {
            hasL = true; liveVal = lMap[lid]; ls = stCand;
          }
        }
        const hasM = vid in mMap;
        const ms = posStamp(mergedPosAt, vid, field, byField, result.snapshot.devId);
        const vTomb = vTombs[vid];
        if (!hasM && !liveVideoIds.has(vid) && vTomb && vTomb.at >= ls.ts) continue;
        const liveWins = hasL && (!hasM || compareStamp(ls.ts, ls.by, ms.ts, ms.by) > 0);
        const chosenVal = liveWins ? liveVal : mMap[vid];
        const chosenSt = liveWins ? ls : ms;
        if (chosenVal !== undefined) {
          (outMaps[field] as Record<string, unknown>)[vid] = chosenVal;
          if (chosenSt.ts > 0) {
            const entry = (finalPosAt[vid] ?? (finalPosAt[vid] = {})) as VideoPosAt;
            entry[field] = chosenSt.ts; entry[byField] = chosenSt.by;
          }
          if (field === 'watch' && !liveWins && (!hasL || liveVal !== chosenVal || chosenSt.ts > ls.ts)) {
            actualWatchUpdatedIds.push(vid);
          }
        }
      }
    }
    safeWrite('linguaclip_watch_pos', outMaps.watch);
    safeWrite('linguaclip_custom_pos', outMaps.custom);
    safeWrite('linguaclip_read_pos', outMaps.read);
    safeWrite('linguaclip_last_way', outMaps.lastWay);
    writePosAt(finalPosAt);

    const liveLooked = getAllReadLooked(), mergedLooked = result.snapshot.readLooked ?? {};
    const outLooked: Record<string, string[]> = {};
    for (const vid of new Set([...Object.keys(liveLooked), ...Object.keys(mergedLooked), ...rekeyToFroms.keys()])) {
      if (readyRekeyFromSet.has(vid)) continue;
      const fromWords = (rekeyToFroms.get(vid) ?? []).flatMap(f => liveLooked[f] ?? []);
      if (!liveVideoIds.has(vid) && !(vid in mergedLooked) && fromWords.length === 0) continue;
      const words = [...new Set([...(liveLooked[vid] ?? []), ...fromWords, ...(mergedLooked[vid] ?? [])])].sort().slice(-500);
      if (words.length > 0) outLooked[vid] = words;
    }
    safeWrite('linguaclip_read_looked', outLooked);

    const liveGloss = getAllReadGloss(), mergedGloss = result.snapshot.readGloss ?? {};
    const outGloss: Record<string, Record<string, string>> = {};
    for (const vid of new Set([...Object.keys(liveGloss), ...Object.keys(mergedGloss), ...rekeyToFroms.keys()])) {
      if (readyRekeyFromSet.has(vid)) continue;
      const mergedFromGloss = Object.assign({}, ...(rekeyToFroms.get(vid) ?? []).map(f => liveGloss[f] ?? {}));
      if (!liveVideoIds.has(vid) && !(vid in mergedGloss) && Object.keys(mergedFromGloss).length === 0) continue;
      const g = { ...(mergedGloss[vid] ?? {}), ...mergedFromGloss, ...(liveGloss[vid] ?? {}) };
      if (Object.keys(g).length > 0) outGloss[vid] = g;
    }
    safeWrite('linguaclip_read_gloss', outGloss);

    if (result.keptOrphans.length > 0) {
      safeWrite(KEPT_ORPHANS_KEY, [...new Set([...readKeptOrphans(), ...result.keptOrphans])].sort());
    }

    const safeAllowed = new Set<string>(SAFE_SYNC_SETTING_KEYS);
    const st = getSyncState();
    const nextSettingAt = { ...(st.settingAt ?? {}) };
    let settingAtChanged = false;
    for (const [k, entry] of Object.entries(result.snapshot.settings ?? {})) {
      if (!safeAllowed.has(k) || BLOCKED_SETTING_KEYS.has(k)) continue;
      const entryBy = entry.by ?? result.snapshot.devId;
      const liveSt = st.settingAt?.[k];
      if (liveSt && compareStamp(liveSt.at, liveSt.by, entry.at, entryBy) > 0) continue;
      if (entry.at > (nextSettingAt[k]?.at ?? 0) || (entry.at === (nextSettingAt[k]?.at ?? 0) && entry.at > 0 && entryBy > (nextSettingAt[k]?.by ?? ''))) {
        nextSettingAt[k] = { at: entry.at, by: entryBy };
        settingAtChanged = true;
      }
      if (k === 'linguaclip_practice_config') {
        try {
          const incoming = JSON.parse(entry.value);
          if (isRecord(incoming)) {
            const cur = getPracticeConfig() as unknown as Record<string, unknown>;
            const mergedCfg: Record<string, unknown> = { ...cur };
            for (const [fk, fv] of Object.entries(incoming)) if (!LOCAL_PRACTICE_FIELDS.has(fk)) mergedCfg[fk] = fv;
            savePracticeConfig(mergedCfg as unknown as PracticeConfig);
          }
        } catch { /* bad */ }
      } else if (k === 'linguaclip_watch_prefs') {
        try {
          const p = JSON.parse(entry.value);
          if (isRecord(p)) {
            const filtered: Record<string, unknown> = {};
            for (const [fk, fv] of Object.entries(p)) if (!LOCAL_WATCH_PREF_FIELDS.has(fk)) filtered[fk] = fv;
            saveWatchPrefs(filtered as Partial<WatchPrefs>);
          }
        } catch { /* bad */ }
      } else {
        try { if (localStorage.getItem(k) !== entry.value) localStorage.setItem(k, entry.value); } catch { /* quota */ }
      }
    }
    if (settingAtChanged) saveSyncState({ ...st, settingAt: nextSettingAt });
  });
  return actualWatchUpdatedIds;
}
