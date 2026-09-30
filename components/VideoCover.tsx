import React, { useEffect, useState } from 'react';
import { Film, Headphones } from 'lucide-react';
import { videoSrcFromPath } from '../utils/desktop';

// A shelf card's cover: one frame grabbed from the video itself, nothing saved
// to disk. Frames are grabbed one video at a time and kept for this session.
// Sound only (`audio`): no frame to grab — the podcast's own picture, else headphones.

const frames = new Map<string, Promise<string | null>>();
let queue: Promise<unknown> = Promise.resolve();

function grabFrame(path: string): Promise<string | null> {
  return new Promise(resolve => {
    const v = document.createElement('video');
    const done = (url: string | null) => {
      window.clearTimeout(timer);
      v.removeAttribute('src');
      v.load();
      resolve(url);
    };
    const timer = window.setTimeout(() => done(null), 15_000);
    v.crossOrigin = 'anonymous'; // same as the player: a tainted canvas cannot export
    v.muted = true;
    v.preload = 'auto';
    v.onloadedmetadata = () => { v.currentTime = Math.min(5, (v.duration || 0) * 0.1); };
    // True once a real frame landed. WKWebView (the Mac app) often has nothing
    // painted yet at `seeked`, so the canvas stays transparent — a black JPEG.
    const draw = (): boolean => {
      const c = document.createElement('canvas');
      c.width = 480;
      c.height = Math.round(480 * (v.videoHeight / v.videoWidth)) || 270;
      const g = c.getContext('2d')!;
      g.drawImage(v, 0, 0, c.width, c.height);
      if (g.getImageData(0, 0, 1, 1).data[3] === 0) return false;
      done(c.toDataURL('image/jpeg', 0.75));
      return true;
    };
    v.onseeked = () => {
      try {
        if (!v.videoWidth) return done(null); // audio only: no frame will ever come
        if (draw()) return;
        if (!v.requestVideoFrameCallback) return done(null);
        v.requestVideoFrameCallback(() => {
          try { if (!draw()) done(null); } catch { done(null); }
        });
      } catch {
        done(null);
      }
    };
    v.onerror = () => done(null);
    v.src = videoSrcFromPath(path);
  });
}

function coverOf(path: string): Promise<string | null> {
  let hit = frames.get(path);
  if (!hit) {
    hit = queue.then(() => grabFrame(path));
    queue = hit;
    frames.set(path, hit);
  }
  return hit;
}

const VideoCover: React.FC<{ path?: string; audio?: boolean; image?: string; className?: string; children?: React.ReactNode }> = ({ path, audio, image, className = 'aspect-video rounded-xl', children }) => {
  const [src, setSrc] = useState<string | null>(null);
  const [art, setArt] = useState(true); // the podcast picture loaded (or is still loading)
  useEffect(() => {
    let live = true;
    setSrc(null);
    if (path && !audio) coverOf(path).then(url => { if (live) setSrc(url); });
    return () => { live = false; };
  }, [path, audio]);
  useEffect(() => setArt(true), [image]);
  return (
    <div className={`relative overflow-hidden ${audio ? 'bg-shade' : 'bg-line'} flex items-center justify-center ${className}`}>
      {audio
        ? image && art
          ? <img src={image} alt="" onError={() => setArt(false)} className="h-[68%] aspect-square rounded-xl object-cover shadow-card" />
          : <Headphones size={22} className="text-mute" />
        : src ? <img src={src} alt="" className="absolute inset-0 w-full h-full object-cover" /> : <Film size={22} className="text-mute" />}
      {children}
    </div>
  );
};

export default VideoCover;
