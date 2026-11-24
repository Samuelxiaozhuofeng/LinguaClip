// Typed bridge to Android's native Kotlin layer (`window.LinguaAndroid`, registered in MainActivity.kt).
// Safe to import on web/PWA: `isAndroidNative()` simply returns false there.

interface RawAndroidBridge {
  isAvailable(): boolean;
  isDebug?: () => boolean;
  call(reqId: string, method: string, argsJson: string): void;
}

declare global {
  interface Window {
    LinguaAndroid?: RawAndroidBridge;
    __lcAndroidResolve?: (reqId: string, ok: boolean, jsonPayload: string) => void;
    __lcAndroidEmit?: (eventName: string, jsonPayload: string) => void;
  }
}

type PendingCall = { resolve: (v: unknown) => void; reject: (e: Error) => void };
const pending = new Map<string, PendingCall>();
const listeners = new Map<string, Set<(payload: unknown) => void>>();
let seq = 0;

function installCallbacks() {
  if (typeof window === 'undefined' || window.__lcAndroidResolve) return;
  window.__lcAndroidResolve = (reqId, ok, jsonPayload) => {
    const p = pending.get(reqId);
    if (!p) return;
    pending.delete(reqId);
    try {
      const parsed = jsonPayload ? JSON.parse(jsonPayload) : null;
      if (ok) p.resolve(parsed);
      else p.reject(new Error(parsed?.error || 'android:error'));
    } catch (e) {
      p.reject(e instanceof Error ? e : new Error(String(e)));
    }
  };
  window.__lcAndroidEmit = (eventName, jsonPayload) => {
    const set = listeners.get(eventName);
    if (!set || set.size === 0) return;
    let payload: unknown = null;
    try { payload = jsonPayload ? JSON.parse(jsonPayload) : null; } catch { payload = jsonPayload; }
    for (const cb of set) {
      try { cb(payload); } catch (e) { console.error('[android event]', eventName, e); }
    }
  };
}

export function isAndroidNative(): boolean {
  return typeof window !== 'undefined' && !!window.LinguaAndroid?.isAvailable?.();
}

export function isAndroidDebug(): boolean {
  return isAndroidNative() && !!window.LinguaAndroid?.isDebug?.();
}

export function callAndroid<T = Record<string, unknown>>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!isAndroidNative()) return Promise.reject(new Error('android:unavailable'));
  installCallbacks();
  const reqId = `r${++seq}_${Date.now()}`;
  return new Promise<T>((resolve, reject) => {
    pending.set(reqId, { resolve: v => resolve(v as T), reject });
    try {
      window.LinguaAndroid!.call(reqId, method, JSON.stringify(args));
    } catch (e) {
      pending.delete(reqId);
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

export function onAndroidEvent<T = Record<string, unknown>>(eventName: string, cb: (payload: T) => void): () => void {
  installCallbacks();
  let set = listeners.get(eventName);
  if (!set) {
    set = new Set();
    listeners.set(eventName, set);
  }
  const fn = cb as (payload: unknown) => void;
  set.add(fn);
  return () => { set?.delete(fn); };
}

export interface AudioTrackInfo {
  index: number;
  mime: string;
  language: string;
  sampleRate: number;
  channels: number;
  isDefault?: boolean;
  supported?: boolean;
}

export interface ProbeTracksResult {
  displayName: string;
  sizeBytes: number;
  mime: string;
  tracks: AudioTrackInfo[];
  defaultTrackIndex: number;
}

export interface ExtractedAudio {
  path: string;
  mime: string;
  lossless: boolean;
  durationMs: number;
  sizeBytes: number;
  tracks: AudioTrackInfo[];
}

export interface NetworkState {
  connected: boolean;
  wifi: boolean;
  metered: boolean;
}

export interface SharePayload {
  mime: string;
  kind: 'text' | 'uri';
  text?: string;
  uri?: string;
}

export interface DecodedWav {
  wavPath: string;
  samples: number;
  durationMs: number;
  sizeBytes: number;
}

export interface CompressedPiece {
  path: string;
  sizeBytes: number;
  durationMs: number;
  equivalentHourMb: number;
}

export interface PlaybackSnapshot {
  playing: boolean;
  playbackState: number;
  positionMs: number;
  durationMs: number;
  rate: number;
  mediaId: string;
  gen?: number;
  source: string;
  cueIndex: number;
  timelineSize: number;
  sectionEndMs: number;
  sectionStopDriftMs: number;
  autoPause: boolean;
  autoPauseCueIdx: number;
  auxPlaying: boolean;
  hasMediaSession: boolean;
  loop?: {
    startMs: number;
    endMs: number;
    remaining: number;
    completedLoops: number;
    maxDriftMs: number;
    lastDriftMs: number;
    waitingGap: boolean;
  };
}

export interface BgEvent {
  id: string;
  type: 'mark_missed';
  mediaId: string;
  gen?: number;
  source: string;
  index: number;
  lineId?: number;
  startMs: number;
  endMs: number;
  positionMs: number;
  text: string;
  ts: number;
}
