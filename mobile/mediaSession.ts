// The lock screen / headphone controls (docs/mobile-web.md 6): title, show, cover, and
// play / pause / previous / next wired to the very functions the page's buttons call
// (read through a ref, so they always act on the page as it is now).
import { useEffect, useRef } from 'react';

export type MediaActions = { play: () => void; pause: () => void; prev: () => void; next: () => void };

export function useMediaSession(meta: { title: string; artist: string; image?: string }, actions: MediaActions, playing: boolean) {
  const ref = useRef(actions);
  ref.current = actions;
  const ms = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined;
  useEffect(() => {
    if (!ms) return;
    const set = (a: MediaSessionAction, fn: (() => void) | null) => { try { ms.setActionHandler(a, fn); } catch { /* not supported here */ } };
    set('play', () => ref.current.play());
    set('pause', () => ref.current.pause());
    set('previoustrack', () => ref.current.prev());
    set('nexttrack', () => ref.current.next());
    return () => { for (const a of ['play', 'pause', 'previoustrack', 'nexttrack'] as const) set(a, null); ms.metadata = null; };
  }, [ms]);
  useEffect(() => {
    if (!ms || typeof MediaMetadata === 'undefined') return;
    ms.metadata = new MediaMetadata({ title: meta.title, artist: meta.artist, artwork: meta.image ? [{ src: meta.image, sizes: '512x512' }] : [] });
  }, [ms, meta.title, meta.artist, meta.image]);
  useEffect(() => { if (ms) ms.playbackState = playing ? 'playing' : 'paused'; }, [ms, playing]);
}
