/**
 * Sync localStorage keys, WebDAV configuration, runtime sync state,
 * device identity, and desktop-to-phone pairing code codec (docs/sync.md).
 *
 * Pure localStorage / string logic — zero @tauri-apps/* imports, ES2020-compatible.
 */
import type { RemoteAudioOffer, SyncAudioOffer } from './syncTypes';

export const SYNC_DEVICE_KEY = 'linguaclip_sync_device';
export const SYNC_AUTH_KEY = 'linguaclip_sync_auth';
export const SYNC_STATE_KEY = 'linguaclip_sync_state';
export const DAYS_DEV_KEY = 'linguaclip_days_dev';
export const POS_AT_KEY = 'linguaclip_pos_at';
export const JIANGUOYUN_URL = 'https://dav.jianguoyun.com/dav/';
export const PAIR_PREFIX = 'linguaclip-sync://v1/';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export interface WebDavConfig {
  enabled: boolean;
  preset: 'jianguoyun' | 'custom';
  url: string;
  username: string;
  password: string;
  rootDir: string;
  syncClips: boolean;
  wifiOnlyClips: boolean;
  autoSyncAudio?: boolean;
  wifiOnlyAudio?: boolean;
}

export type PairConfig = Pick<
  WebDavConfig,
  'preset' | 'url' | 'username' | 'password' | 'rootDir' | 'syncClips' | 'wifiOnlyClips' | 'wifiOnlyAudio'
>;

export interface SyncState {
  initialized: boolean;
  dirty: boolean;
  lastSyncAt: number;
  lastMergedAt: number;
  peerEtags: Record<string, string>;
  uploadedSubs: string[];
  uploadedCaches: string[];
  uploadedClips: Record<string, string>;
  clipPackSeq: number;
  clipPacks: Record<string, string[]>;
  audioOffers: Record<string, SyncAudioOffer>;
  remoteAudioOffers: Record<string, RemoteAudioOffer>;
  audioMonthly: { ym: string; bytes: number };
  audioAutoPending: string[];
  deliveredAudioIds: string[];
  audioAck: Record<string, string>;
  authFailed: boolean;
  failCount: number;
  backoffUntil: number;
  newerFormat: boolean;
  lastError: string | null;
  targetKey?: string;
  lastPublishedHash?: string;
  settingAt?: Record<string, { at: number; by: string }>;
}

const DEFAULT_CONFIG: WebDavConfig = {
  enabled: false,
  preset: 'jianguoyun',
  url: JIANGUOYUN_URL,
  username: '',
  password: '',
  rootDir: 'LinguaClip',
  syncClips: true,
  wifiOnlyClips: false,
  autoSyncAudio: false,
  wifiOnlyAudio: true,
};

const DEFAULT_STATE: SyncState = {
  initialized: false,
  dirty: false,
  lastSyncAt: 0,
  lastMergedAt: 0,
  peerEtags: {},
  uploadedSubs: [],
  uploadedCaches: [],
  uploadedClips: {},
  clipPackSeq: 0,
  clipPacks: {},
  audioOffers: {},
  remoteAudioOffers: {},
  audioMonthly: { ym: '', bytes: 0 },
  audioAutoPending: [],
  deliveredAudioIds: [],
  audioAck: {},
  authFailed: false,
  failCount: 0,
  backoffUntil: 0,
  newerFormat: false,
  lastError: null,
};

const defaultStorage = (): StorageLike | null => {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function generateUuidV4(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().toLowerCase();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  let hex = '';
  for (let i = 0; i < 16; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Return this device's persistent sync UUID (strictly `[0-9a-f-]`), generating one on first call. */
export function getSyncDeviceId(storage: StorageLike | null = defaultStorage()): string {
  try {
    const existing = storage?.getItem(SYNC_DEVICE_KEY)?.trim().toLowerCase() ?? '';
    if (UUID_RE.test(existing)) return existing;
  } catch { /* fall through and generate */ }
  const id = generateUuidV4();
  try {
    storage?.setItem(SYNC_DEVICE_KEY, id);
  } catch { /* storage unavailable */ }
  return id;
}

const asStr = (v: unknown, fallback: string) => (typeof v === 'string' ? v : fallback);
const asBool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
const asNum = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

function asStrMap(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string') out[k] = val;
  }
  return out;
}

function asStrListMap(v: unknown): Record<string, string[]> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, string[]> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (Array.isArray(val)) out[k] = val.filter((x): x is string => typeof x === 'string');
  }
  return out;
}

function asStrList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of v) {
    if (typeof x === 'string' && x && !seen.has(x)) { seen.add(x); out.push(x); }
  }
  return out;
}

function asAudioOffer(v: unknown): SyncAudioOffer | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.file !== 'string' || !o.file || typeof o.sha256 !== 'string') return null;
  if (typeof o.bytes !== 'number' || !Number.isFinite(o.bytes) || o.bytes < 0) return null;
  if (typeof o.durSec !== 'number' || !Number.isFinite(o.durSec) || o.durSec < 0) return null;
  if (typeof o.createdAt !== 'number' || !Number.isFinite(o.createdAt)) return null;
  const offerId = typeof o.offerId === 'string' && o.offerId ? o.offerId : undefined;
  return { file: o.file, sha256: o.sha256, bytes: o.bytes, durSec: o.durSec, createdAt: o.createdAt, ...(offerId ? { offerId } : {}) };
}

function asAudioOfferMap(v: unknown): Record<string, SyncAudioOffer> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, SyncAudioOffer> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const parsed = asAudioOffer(val);
    if (k && parsed) out[k] = parsed;
  }
  return out;
}

function asRemoteAudioOfferMap(v: unknown): Record<string, RemoteAudioOffer> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, RemoteAudioOffer> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const base = asAudioOffer(val);
    if (!k || !base) continue;
    const o = val as Record<string, unknown>;
    const videoId = typeof o.videoId === 'string' && o.videoId ? o.videoId : k;
    if (typeof o.fromDevId !== 'string' || !o.fromDevId) continue;
    out[k] = { ...base, videoId, fromDevId: o.fromDevId };
  }
  return out;
}

function asAudioMonthly(v: unknown): { ym: string; bytes: number } {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ym: '', bytes: 0 };
  const o = v as Record<string, unknown>;
  const ym = typeof o.ym === 'string' && /^\d{4}-\d{2}$/.test(o.ym) ? o.ym : '';
  const bytes = typeof o.bytes === 'number' && Number.isFinite(o.bytes) && o.bytes >= 0 ? o.bytes : 0;
  return { ym, bytes: ym ? bytes : 0 };
}

export function getSyncConfig(storage: StorageLike | null = defaultStorage()): WebDavConfig {
  try {
    const raw = storage?.getItem(SYNC_AUTH_KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    const p = JSON.parse(raw) as Record<string, unknown>;
    if (!p || typeof p !== 'object' || Array.isArray(p)) return { ...DEFAULT_CONFIG };
    return {
      enabled: asBool(p.enabled, DEFAULT_CONFIG.enabled),
      preset: p.preset === 'custom' ? 'custom' : 'jianguoyun',
      url: asStr(p.url, DEFAULT_CONFIG.url),
      username: asStr(p.username, DEFAULT_CONFIG.username),
      password: asStr(p.password, DEFAULT_CONFIG.password),
      rootDir: asStr(p.rootDir, DEFAULT_CONFIG.rootDir),
      syncClips: asBool(p.syncClips, DEFAULT_CONFIG.syncClips),
      wifiOnlyClips: asBool(p.wifiOnlyClips, DEFAULT_CONFIG.wifiOnlyClips),
      autoSyncAudio: asBool(p.autoSyncAudio, false),
      wifiOnlyAudio: asBool(p.wifiOnlyAudio, true),
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveSyncConfig(cfg: WebDavConfig, storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.setItem(SYNC_AUTH_KEY, JSON.stringify(cfg));
  } catch { /* storage unavailable */ }
}

function asSettingAtMap(v: unknown): Record<string, { at: number; by: string }> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, { at: number; by: string }> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const o = val as Record<string, unknown>;
      if (typeof o.at === 'number' && Number.isFinite(o.at) && typeof o.by === 'string') {
        out[k] = { at: o.at, by: o.by };
      }
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function createFreshSyncState(targetKey = ''): SyncState {
  return {
    ...DEFAULT_STATE,
    peerEtags: {},
    uploadedSubs: [],
    uploadedCaches: [],
    uploadedClips: {},
    clipPacks: {},
    audioOffers: {},
    remoteAudioOffers: {},
    audioMonthly: { ym: '', bytes: 0 },
    audioAutoPending: [],
    deliveredAudioIds: [],
    audioAck: {},
    ...(targetKey ? { targetKey } : {}),
  };
}

/** Normalized identity for a WebDAV destination (URL + account + rootDir) to isolate state across targets. */
export function webDavTargetKey(cfg: Pick<WebDavConfig, 'url' | 'username' | 'rootDir'>): string {
  let normUrl = cfg.url.trim().replace(/\/+$/, '');
  try {
    const u = new URL(normUrl);
    normUrl = `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
  } catch { /* keep trimmed */ }
  const normUser = cfg.username.trim();
  const normRoot = cfg.rootDir.trim().replace(/^\/+|\/+$/g, '') || 'LinguaClip';
  return `${normUrl}|${normUser}|${normRoot}`;
}

export function getSyncState(storage: StorageLike | null = defaultStorage()): SyncState {
  try {
    const raw = storage?.getItem(SYNC_STATE_KEY);
    if (!raw) return createFreshSyncState();
    const p = JSON.parse(raw) as Record<string, unknown>;
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
      return createFreshSyncState();
    }
    const settingAt = asSettingAtMap(p.settingAt);
    return {
      initialized: asBool(p.initialized, false),
      dirty: asBool(p.dirty, false),
      lastSyncAt: asNum(p.lastSyncAt, 0),
      lastMergedAt: asNum(p.lastMergedAt, 0),
      peerEtags: asStrMap(p.peerEtags),
      uploadedSubs: Array.isArray(p.uploadedSubs) ? p.uploadedSubs.filter((x): x is string => typeof x === 'string') : [],
      uploadedCaches: Array.isArray(p.uploadedCaches) ? p.uploadedCaches.filter((x): x is string => typeof x === 'string') : [],
      uploadedClips: asStrMap(p.uploadedClips),
      clipPackSeq: asNum(p.clipPackSeq, 0),
      clipPacks: asStrListMap(p.clipPacks),
      audioOffers: asAudioOfferMap(p.audioOffers),
      remoteAudioOffers: asRemoteAudioOfferMap(p.remoteAudioOffers),
      audioMonthly: asAudioMonthly(p.audioMonthly),
      audioAutoPending: asStrList(p.audioAutoPending),
      deliveredAudioIds: asStrList(p.deliveredAudioIds),
      audioAck: asStrMap(p.audioAck),
      authFailed: asBool(p.authFailed, false),
      failCount: asNum(p.failCount, 0),
      backoffUntil: asNum(p.backoffUntil, 0),
      newerFormat: asBool(p.newerFormat, false),
      lastError: typeof p.lastError === 'string' ? p.lastError : null,
      ...(typeof p.targetKey === 'string' && p.targetKey ? { targetKey: p.targetKey } : {}),
      ...(typeof p.lastPublishedHash === 'string' && p.lastPublishedHash ? { lastPublishedHash: p.lastPublishedHash } : {}),
      ...(settingAt ? { settingAt } : {}),
    };
  } catch {
    return createFreshSyncState();
  }
}

export function saveSyncState(state: SyncState, storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.setItem(SYNC_STATE_KEY, JSON.stringify(state));
  } catch { /* storage unavailable */ }
}

export function markSyncDirty(storage: StorageLike | null = defaultStorage()): void {
  const cur = getSyncState(storage);
  if (!cur.dirty) saveSyncState({ ...cur, dirty: true }, storage);
}

// --- Pairing code codec (desktop → phone) ---

function isLocalOrLanHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    h === 'localhost' || h === '::1'
    || (h.length > 6 && h.endsWith('.local') && !h.startsWith('.'))
    || (h.length > 4 && h.endsWith('.lan') && !h.startsWith('.'))
    || (h.length > 7 && h.endsWith('.ts.net') && !h.startsWith('.'))
  ) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(h) || /^fe[89ab][0-9a-f]:/i.test(h)) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const a = Number(m[1]), b = Number(m[2]), c = Number(m[3]), d = Number(m[4]);
  if (a > 255 || b > 255 || c > 255 || d > 255) return false;
  if (a === 127 || a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // Tailscale CGNAT
  if (a === 169 && b === 254) return true;
  return false;
}

/** Validate WebDAV endpoint scheme: HTTPS everywhere, plaintext HTTP only for loopback / LAN / Tailscale. */
export function isSafeWebDavUrl(raw: string): boolean {
  if (typeof raw !== 'string') return false;
  const s = raw.trim();
  if (!s) return false;
  try {
    const u = new URL(s);
    if (!u.hostname || u.search || u.hash) return false;
    if (u.protocol === 'https:') return true;
    if (u.protocol === 'http:') return isLocalOrLanHost(u.hostname);
    return false;
  } catch {
    return false;
  }
}

function isSafeRootDir(rootDir: string): boolean {
  if (typeof rootDir !== 'string' || /[\u0000-\u001f\\]/.test(rootDir)) return false;
  const parts = rootDir.split('/').filter(Boolean);
  return !parts.some(seg => seg === '.' || seg === '..');
}

function utf8ToBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToUtf8(b64url: string): string | null {
  if (!b64url || !/^[A-Za-z0-9_-]+$/.test(b64url)) return null;
  const pad = b64url.length % 4;
  if (pad === 1) return null;
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + (pad ? '='.repeat(4 - pad) : '');
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Encode WebDAV settings into a compact `linguaclip-sync://v1/...` pairing string (UTF-8 safe). */
export function encodePairCode(cfg: PairConfig): string {
  const payload = {
    p: cfg.preset === 'custom' ? 'c' : 'j',
    u: cfg.url.trim(),
    n: cfg.username,
    w: cfg.password,
    d: cfg.rootDir,
    c: cfg.syncClips ? 1 : 0,
    f: cfg.wifiOnlyClips ? 1 : 0,
    ...(cfg.wifiOnlyAudio !== undefined ? { a: cfg.wifiOnlyAudio ? 1 : 0 } : {}),
  };
  return PAIR_PREFIX + utf8ToBase64Url(JSON.stringify(payload));
}

/** Decode and strictly validate a `linguaclip-sync://v1/...` pairing string; returns null if invalid. */
export function decodePairCode(raw: string): PairConfig | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith(PAIR_PREFIX)) return null;
  const body = trimmed.slice(PAIR_PREFIX.length).replace(/\s+/g, '');
  const jsonText = base64UrlToUtf8(body);
  if (!jsonText) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;

  const rawPreset = o.p ?? o.preset;
  const preset: 'jianguoyun' | 'custom' | null =
    rawPreset === 'j' || rawPreset === 'jianguoyun' ? 'jianguoyun'
      : rawPreset === 'c' || rawPreset === 'custom' ? 'custom'
        : null;
  if (!preset) return null;

  const url = typeof o.u === 'string' ? o.u.trim() : typeof o.url === 'string' ? o.url.trim() : '';
  const username = typeof o.n === 'string' ? o.n : typeof o.username === 'string' ? o.username : null;
  const password = typeof o.w === 'string' ? o.w : typeof o.password === 'string' ? o.password : null;
  const rootDir = typeof o.d === 'string' ? o.d : typeof o.rootDir === 'string' ? o.rootDir : 'LinguaClip';

  if (!isSafeWebDavUrl(url)) return null;
  if (username === null || username.trim() === '') return null;
  if (password === null || password === '') return null;
  if (!isSafeRootDir(rootDir)) return null;

  const rawClips = o.c !== undefined ? o.c : o.syncClips;
  const rawWifi = o.f !== undefined ? o.f : o.wifiOnlyClips;
  const rawWifiAudio = o.a !== undefined ? o.a : o.wifiOnlyAudio;
  const syncClips = rawClips === undefined ? true : rawClips === 1 || rawClips === true;
  const wifiOnlyClips = rawWifi === undefined ? false : rawWifi === 1 || rawWifi === true;
  const wifiOnlyAudio = rawWifiAudio === undefined ? true : rawWifiAudio === 1 || rawWifiAudio === true;

  return { preset, url, username, password, rootDir, syncClips, wifiOnlyClips, wifiOnlyAudio };
}
