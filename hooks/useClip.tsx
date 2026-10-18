// The small player under review cards, the lookup panel and keyword cards: a stretch of the video, or a read-aloud URL.
import React, { useEffect, useRef, useState } from 'react';
import type { ReviewCard } from '../utils/review';
import { getAudioPaddingConfig } from '../utils/storage';
import { videoSrcFromPath } from '../utils/desktop';
import type { Source } from '../utils/clips';

// The line's audio with the user's lead-in / tail padding.
export const clipOf = (c: ReviewCard): [number, number] => {
  const { startPadding, endPadding } = getAudioPaddingConfig();
  return [Math.max(0, c.start - startPadding / 1000), c.end + endPadding / 1000];
};

// One <video> that plays a stretch and stops; keeps its src while the path stays the same.
export const useClip = () => {
  const ref = useRef<HTMLVideoElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const srcRef = useRef<string | null>(null);
  const pending = useRef<(() => void) | null>(null);
  const raf = useRef(0);
  const stopAt = useRef<{ end: number; then?: () => void } | null>(null);
  const voice = useRef<HTMLAudioElement | null>(null); // a read-aloud word (utils/wordVoice.ts)
  const asked = useRef(0); // bumped by every stop: a read-aloud still on its way is then dropped
  const alive = useRef(true);

  const stop = () => {
    asked.current++;
    voice.current?.pause();
    cancelAnimationFrame(raf.current);
    stopAt.current = null;
    pending.current = null;
    ref.current?.pause();
  };
  const watch = () => {
    raf.current = requestAnimationFrame(() => {
      const v = ref.current, s = stopAt.current;
      if (!v || !s) return;
      if (v.currentTime >= s.end || v.ended) { stop(); s.then?.(); } else watch();
    });
  };
  // `from` / `to` are times in the source video; a card's own clip starts `offset` seconds in.
  const play = ({ path, offset }: Source, from: number, to: number, then?: () => void) => {
    from = Math.max(0, from - offset);
    to -= offset;
    stop();
    const go = () => {
      const v = ref.current;
      if (!v) return;
      const token = { end: to, then };
      stopAt.current = token;
      v.currentTime = from;
      // Blocked playback still moves on, so an auto-advance never hangs.
      v.play().then(watch, () => { if (stopAt.current === token) { stop(); then?.(); } });
    };
    if (path === srcRef.current && ref.current && ref.current.readyState >= 1) go();
    else { pending.current = go; srcRef.current = path; setSrc(path); }
  };
  // A read-aloud word: plays `url` when it comes, else (none / failed to play) `fallback`.
  // Any stop meanwhile (next card, close, another sound) or unmounting = silence.
  const playVoice = async (url: Promise<string | null>, fallback: () => void) => {
    stop();
    let me = asked.current;
    const u = await url;
    if (me !== asked.current || !alive.current) return;
    if (u) {
      stop();
      me = asked.current;
      const a = (voice.current ??= new Audio());
      a.src = u;
      if (await a.play().then(() => true, () => false)) return;
      if (me !== asked.current || !alive.current) return;
    }
    fallback();
  };
  useEffect(() => { alive.current = true; return () => { alive.current = false; stop(); }; }, []);

  const onLoadedMetadata = () => { const go = pending.current; pending.current = null; go?.(); };
  const video = (className: string) => (
    <video ref={ref} crossOrigin="anonymous" src={src ? videoSrcFromPath(src) : undefined} onLoadedMetadata={onLoadedMetadata} className={className} />
  );
  return { play, playVoice, stop, video, ref };
};
