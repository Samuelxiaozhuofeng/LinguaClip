// Android native startup hooks (docs/android.md): durable bg-events.jsonl -> IndexedDB flushing,
// last-position sync, the review-clips worker. The debug-only phase-0 harness lives in
// androidVerify.android.ts and is wired only behind Android FLAG_DEBUGGABLE (`isAndroidDebug()`).
import { invoke } from '@tauri-apps/api/core';
import {
  callAndroid,
  isAndroidDebug,
  isAndroidNative,
  onAndroidEvent,
  type BgEvent,
} from './androidBridge';
import { clipsInfo } from './desktop.android';
import { fillClips, getClipProgress, registerExtraKeptClips, retryClips, startClips, subscribeClips } from '../../utils/clips';
import { createSyncExtraKeptClipsProvider } from '../../utils/syncEngine';
import { readRestoreKeptClips } from '../restoreClips';
import { registerClipsRuntime } from '../settings/ClipsSection';
import * as ankiDroid from './ankiDroid';
import { exportToAnkiDroid } from '../ankiDroidExport';
import { getVideoFromDB } from '../../utils/fileSystemAccess';
import { PENDING_KEY } from '../../utils/backup';
import { addLine } from '../../utils/review';
import { setWatchPos } from '../../utils/storage';
import { RESTORE_LOCK } from '../store';
import { getPhoneLastWay } from '../phoneWays';
import { runPhase0Verification } from './androidVerify.android';

let flushing: Promise<number> | null = null;
let flushPending = false;
// The native position already applied, kept across launches: Media3's saved position is only newer
// than linguaclip_watch_pos once per save; replaying an old one would undo the reader / drills moving on.
const POS_TS_KEY = 'linguaclip_native_pos_ts';
const readAppliedTs = (): number => { try { return Number(localStorage.getItem(POS_TS_KEY)) || 0; } catch { return 0; } };
let lastAppliedPosTs = readAppliedTs();
let suspendAutoFlush = false;

const bgMarkListeners = new Set<(ev: BgEvent) => void>();
const pendingBgMarks: BgEvent[] = [];
const seenBgMarkIds = new Set<string>();

function emitBgMark(ev: BgEvent) {
  if (!ev?.id || ev.type !== 'mark_missed' || !ev.mediaId) return;
  if (seenBgMarkIds.has(ev.id)) return;
  seenBgMarkIds.add(ev.id);
  if (seenBgMarkIds.size > 500) {
    const first = seenBgMarkIds.values().next().value;
    if (first) seenBgMarkIds.delete(first);
  }
  if (bgMarkListeners.size > 0) {
    for (const cb of bgMarkListeners) {
      try { cb(ev); } catch (e) { console.error('[android bgMark listener]', e); }
    }
  } else {
    pendingBgMarks.push(ev);
    if (pendingBgMarks.length > 100) pendingBgMarks.shift();
  }
}

export function subscribeAndroidBgMarks(cb: (ev: BgEvent) => void): () => void {
  bgMarkListeners.add(cb);
  return () => { bgMarkListeners.delete(cb); };
}

export function consumePendingAndroidBgMarks(mediaId: string): BgEvent[] {
  if (!mediaId || pendingBgMarks.length === 0) return [];
  const matched: BgEvent[] = [];
  for (let i = pendingBgMarks.length - 1; i >= 0; i--) {
    if (pendingBgMarks[i].mediaId === mediaId) {
      matched.unshift(pendingBgMarks[i]);
      pendingBgMarks.splice(i, 1);
    }
  }
  return matched;
}

export async function syncLastPosFromNative(): Promise<void> {
  if (!isAndroidNative()) return;
  if (localStorage.getItem(PENDING_KEY) !== null) return;
  try {
    const res = await callAndroid<{ mediaId?: string; posMs?: number; ts?: number }>('playback.getLastPos');
    const ts = typeof res?.ts === 'number' ? res.ts : 0;
    if (!res?.mediaId || typeof res.posMs !== 'number' || res.posMs <= 0) return;
    const appliedTs = Math.max(lastAppliedPosTs, readAppliedTs());
    if (ts > 0 && ts <= appliedTs) return;
    // Never write watchPos back for a deleted or absent record (protects delete & backup restore).
    const rec = await getVideoFromDB(res.mediaId);
    if (!rec) return;
    // Media3's saved spot is the listen session's; the reader and drills keep their own (their
    // pause on leaving also saves one, which would otherwise pull the reader back to it).
    const way = getPhoneLastWay(res.mediaId);
    if (way && way !== 'listen') return;
    if (ts > 0) {
      lastAppliedPosTs = ts;
      try { localStorage.setItem(POS_TS_KEY, String(ts)); } catch { /* only costs a stale resume */ }
    }
    setWatchPos(res.mediaId, res.posMs / 1000);
  } catch (e) {
    console.error('[android lastPos sync]', e);
  }
}

/**
 * Two-phase durable consumption of <filesDir>/bg-events.jsonl:
 * 1. Peek events read-only from Kotlin PlaybackEventStore (file is NOT deleted).
 * 2. Idempotently commit each mark_missed event into IndexedDB via `addLine(..., 'missed')`.
 * 3. Only after IndexedDB commits, acknowledge committed IDs via `playback.ackBgEvents`.
 */
export function flushBgEventsToReview(): Promise<number> {
  if (!isAndroidNative()) return Promise.resolve(0);
  if (localStorage.getItem(PENDING_KEY) !== null) return Promise.resolve(0);
  if (flushing) {
    flushPending = true;
    return flushing;
  }
  const runFlush = async () => {
    let totalAcked = 0;
    try {
      do {
        flushPending = false;
        // Re-check under RESTORE_LOCK so a pending backup restore can never wipe a just-acked mark.
        if (localStorage.getItem(PENDING_KEY) !== null) break;
        const res = await callAndroid<{ events: BgEvent[] }>('playback.peekBgEvents');
        const events = Array.isArray(res?.events) ? res.events : [];
        if (events.length === 0) break;
        const ackIds: string[] = [];
        for (const ev of events) {
          if (!ev?.id) continue;
          if (ev.type === 'mark_missed') {
            const videoId = ev.mediaId || '';
            if (!videoId || !ev.text) {
              console.warn('[android bgEvents flush] acking malformed event', ev.id, { videoId, hasText: !!ev.text });
              ackIds.push(ev.id);
              continue;
            }
            try {
              // Distinguish confirmed deleted record (null) from transient IDB error (throws).
              const rec = await getVideoFromDB(videoId);
              if (!rec) {
                // Record was already deleted; drop stale lockscreen mark so it cannot resurrect orphan cards.
                ackIds.push(ev.id);
                continue;
              }
              await addLine({
                videoId,
                videoName: rec.displayName || rec.videoFileName || videoId,
                videoPath: rec.videoPath || ev.source || undefined,
                text: ev.text,
                start: Math.max(0, ev.startMs / 1000),
                end: Math.max(ev.startMs / 1000 + 0.1, ev.endMs / 1000),
              }, 'missed');
              emitBgMark(ev);
              ackIds.push(ev.id);
            } catch (itemErr) {
              console.error('[android bgEvents flush item]', ev.id, itemErr);
            }
          } else {
            ackIds.push(ev.id);
          }
        }
        if (ackIds.length > 0) {
          await callAndroid('playback.ackBgEvents', { ids: ackIds });
          totalAcked += ackIds.length;
        }
      } while (flushPending);
      return totalAcked;
    } catch (e) {
      console.error('[android bgEvents flush]', e);
      return totalAcked;
    } finally {
      flushing = null;
    }
  };
  flushing = navigator.locks ? navigator.locks.request(RESTORE_LOCK, runFlush) : runFlush();
  return flushing;
}


let restoreClipsRegistered = false;

export function initAndroidNative(): void {
  if (!isAndroidNative()) return;
  if (!restoreClipsRegistered) {
    restoreClipsRegistered = true;
    registerExtraKeptClips(readRestoreKeptClips);
    registerExtraKeptClips(createSyncExtraKeptClipsProvider());
  }
  registerClipsRuntime({ getClipProgress, subscribeClips, retryClips, clipsInfo });
  // Durable lockscreen event flush & last-pos sync: on startup, on foreground resume, and on live bgEvent.
  // Start standalone review clips background worker after restore check (bootRestore) and initial bg-events flush.
  void flushBgEventsToReview().finally(() => {
    if (!suspendAutoFlush && localStorage.getItem(PENDING_KEY) === null) startClips();
  });
  void syncLastPosFromNative();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !suspendAutoFlush) {
      void flushBgEventsToReview();
      void syncLastPosFromNative();
    }
  });
  onAndroidEvent<BgEvent>('bgEvent', ev => {
    if (!suspendAutoFlush) {
      if (ev?.type === 'mark_missed' && ev.mediaId) emitBgMark(ev);
      void flushBgEventsToReview();
    }
  });

  // Verification hooks are strictly disabled in release APKs.
  if (isAndroidDebug()) {
    const debugApi = { invoke, callAndroid, fillClips, anki: ankiDroid, exportToAnkiDroid };
    const verify = (videoPath?: string) => runPhase0Verification({
      setSuspend: on => { suspendAutoFlush = on; },
      flushBgEventsToReview,
    }, videoPath);
    (window as unknown as {
      __runPhase0Verify?: typeof verify;
      __lcDebug?: typeof debugApi;
    }).__runPhase0Verify = verify;
    (window as unknown as { __lcDebug?: typeof debugApi }).__lcDebug = debugApi;
    onAndroidEvent<{ videoPath?: string }>('runPhase0Verify', p => {
      void verify(p?.videoPath);
    });
  }
}
