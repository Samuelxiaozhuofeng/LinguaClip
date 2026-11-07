import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Crop, EyeOff } from 'lucide-react';
import { Btn, MenuItem, Stamp } from './ui';
import { useT } from '../utils/i18n';
import { formatCombo, matches, useShortcuts } from '../utils/shortcuts';
import { getSubtitleMaskOn } from '../utils/storage';
import { Box, dragRect, fitBox, Grip, Rect, setDrawFor, setMask, setPeek, setPicture, spanRect, togglePeek, useMaskState } from '../utils/subtitleMask';

// The hard-subtitle mask on a video or a still (docs/subtitle-mask.md): drawn, moved and
// resized here (edit), or only shown (review). Sits right after the media element; while
// editing, the block is lifted over the page's top bar (its buttons stay above), under
// everything else the page lays on the picture. Framing covers the whole window.

type Media = HTMLVideoElement | HTMLImageElement;
type Props = {
  videoId: string | null | undefined;
  media: React.RefObject<Media | null>;
  edit?: boolean; // draw / move / resize; review only shows
  peekKey?: string; // the action that lifts it for now (watch and review handle theirs themselves)
  onTap?: () => void; // a click on the block that didn't drag: what a click on the picture does
};

// The page hides the pointer (watch, playing): the block and its grips hide it too.
const NO_CURSOR = '[.cursor-none_&]:cursor-none';
const GRIPS: [Grip, string][] = [
  ['n', 'inset-x-2 -top-1 h-2 cursor-ns-resize'], ['s', 'inset-x-2 -bottom-1 h-2 cursor-ns-resize'],
  ['w', 'inset-y-2 -left-1 w-2 cursor-ew-resize'], ['e', 'inset-y-2 -right-1 w-2 cursor-ew-resize'],
  ['nw', '-left-1.5 -top-1.5 w-3 h-3 cursor-nwse-resize bg-page/80 rounded-sm'], ['ne', '-right-1.5 -top-1.5 w-3 h-3 cursor-nesw-resize bg-page/80 rounded-sm'],
  ['sw', '-left-1.5 -bottom-1.5 w-3 h-3 cursor-nesw-resize bg-page/80 rounded-sm'], ['se', '-right-1.5 -bottom-1.5 w-3 h-3 cursor-nwse-resize bg-page/80 rounded-sm'],
];
const pct = (v: number) => `${v * 100}%`;

const SubtitleMask: React.FC<Props> = ({ videoId, media, edit = true, peekKey, onTap }) => {
  const t = useT();
  const enabled = getSubtitleMaskOn();
  const { mask, drawing: drawFor, peek } = useMaskState(videoId);
  const drawing = edit && drawFor;
  // The element can appear after this does (a video once its path is known, a still per card).
  const [el, setEl] = useState<Media | null>(null);
  useEffect(() => { if (media.current !== el) setEl(media.current); });
  const [frame, setFrame] = useState<{ el: Box; pic: Box } | null>(null);
  useEffect(() => {
    if (!el) { setFrame(null); return; }
    const measure = () => {
      const [vw, vh] = el instanceof HTMLVideoElement ? [el.videoWidth, el.videoHeight] : [el.naturalWidth, el.naturalHeight];
      const box = { left: el.offsetLeft, top: el.offsetTop, width: el.clientWidth, height: el.clientHeight };
      const fit = fitBox(box.width, box.height, vw, vh);
      const next = fit && { el: box, pic: { ...fit, left: fit.left + box.left, top: fit.top + box.top } };
      setFrame(f => (JSON.stringify(f) === JSON.stringify(next) ? f : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const evs = ['loadedmetadata', 'load', 'resize', 'emptied', 'error'];
    evs.forEach(n => el.addEventListener(n, measure));
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); evs.forEach(n => el.removeEventListener(n, measure)); window.removeEventListener('resize', measure); };
  }, [el]);

  // The "…" items only exist while there is a picture to frame (not sound only, not a failed video).
  const hasPicture = edit && enabled && !!frame && !!videoId;
  useEffect(() => {
    if (!hasPicture) return;
    setPicture(videoId!);
    return () => setPicture(null);
  }, [hasPicture, videoId]);

  // A drag in progress: framing a new box, or moving / resizing the block. Written on release.
  const [draft, setDraft] = useState<Rect | null>(null);
  const drag = useRef<{ grip: Grip | 'draw'; x0: number; y0: number; from: Rect; moved: boolean; el: Element; pointer: number } | null>(null);
  const picRef = useRef<HTMLDivElement>(null);
  // Every way a drag ends without being kept: the reference, the preview, the pointer capture.
  const endDrag = () => {
    const d = drag.current;
    drag.current = null;
    setDraft(null);
    if (d?.el.hasPointerCapture(d.pointer)) d.el.releasePointerCapture(d.pointer);
  };
  const exitDraw = () => { endDrag(); setDrawFor(null); };

  // Lifting is for now only: a new video, or leaving, covers it again; leaving also ends framing.
  useEffect(() => { setPeek(false); return () => { setPeek(false); if (edit) setDrawFor(null); }; }, [videoId, edit]);
  // The picture went away mid-framing (the video failed): nothing to frame on.
  useEffect(() => { if (drawing && !frame) exitDraw(); }, [drawing, frame]); // eslint-disable-line react-hooks/exhaustive-deps

  const showing = enabled && !!mask?.on && !drawing;
  const framing = drawing && !!frame; // the framing layer is really on screen
  const live = useRef({ showing, framing, exitDraw });
  live.current = { showing, framing, exitDraw };
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (peekKey && live.current.showing && matches(e, peekKey)) { e.preventDefault(); togglePeek(); }
    };
    // Framing covers the whole window, so it is the top layer: Esc closes it and nothing else.
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !live.current.framing) return;
      e.preventDefault(); e.stopImmediatePropagation(); live.current.exitDraw();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keydown', onEsc, true);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keydown', onEsc, true); };
  }, [enabled, peekKey]);

  const share = (e: React.PointerEvent) => {
    const r = picRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, w: r.width, h: r.height };
  };
  const down = (grip: Grip | 'draw') => (e: React.PointerEvent) => {
    if (e.button !== 0 || !picRef.current || (grip !== 'draw' && !mask)) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = share(e);
    drag.current = { grip, x0: e.clientX, y0: e.clientY, from: grip === 'draw' ? { x: p.x, y: p.y, w: 0, h: 0 } : mask!, moved: false, el: e.currentTarget, pointer: e.pointerId };
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !picRef.current) return;
    if (Math.abs(e.clientX - d.x0) + Math.abs(e.clientY - d.y0) > 3) d.moved = true;
    const p = share(e);
    if (d.grip === 'draw') setDraft(spanRect(d.from, p));
    else if (d.moved) setDraft(dragRect(d.from, d.grip, (e.clientX - d.x0) / p.w, (e.clientY - d.y0) / p.h));
  };
  const up = (e: React.PointerEvent) => {
    const d = drag.current;
    endDrag();
    if (!d || !videoId || !picRef.current) return;
    e.stopPropagation();
    if (d.grip === 'draw') {
      const p = share(e), r = spanRect(d.from, p);
      if (r.w * p.w < 8 || r.h * p.h < 8) return; // a click, not a box: keep waiting
      setMask(videoId, { on: true, ...r });
      setDrawFor(null);
    } else if (d.moved) {
      const p = share(e);
      setMask(videoId, { on: true, ...dragRect(d.from, d.grip, (e.clientX - d.x0) / p.w, (e.clientY - d.y0) / p.h) });
    } else onTap?.();
  };
  const handlers = { onPointerMove: move, onPointerUp: up, onPointerCancel: endDrag, onLostPointerCapture: endDrag };

  if (!enabled || !frame || !videoId) return null;
  const rect = draft ?? (drawing ? null : mask);
  const at = (r: Rect) => ({ left: pct(r.x), top: pct(r.y), width: pct(r.w), height: pct(r.h) });
  const movable = edit && !drawing;
  return (
    <>
      <div ref={picRef} className="absolute pointer-events-none overflow-visible" style={frame.pic}>
        {rect && (drawing || (showing && !peek)) && (
          <div data-subtitle-mask className={`absolute bg-ink ${edit ? 'z-10' : ''} ${drawing ? 'ring-2 ring-accent' : ''} ${movable ? `group pointer-events-auto cursor-move ${NO_CURSOR}` : ''}`} style={at(rect)}
            onPointerDown={movable ? down('move') : undefined} {...(movable ? handlers : {})}>
            {movable && GRIPS.map(([g, cls]) => (
              <div key={g} className={`absolute ${cls} ${NO_CURSOR} opacity-0 group-hover:opacity-100`} onPointerDown={down(g)} {...handlers} />
            ))}
          </div>
        )}
      </div>
      {framing && createPortal(
        <div className="fixed inset-0 z-[60] cursor-crosshair" onPointerDown={down('draw')} {...handlers}>
          <div className="absolute left-1/2 top-20 -translate-x-1/2 flex items-center gap-2 cursor-default" onPointerDown={e => e.stopPropagation()}>
            <Stamp tone="ink" className="!px-3 !py-1.5 !text-sm shadow-card whitespace-nowrap">{t('mask.drawHint')}</Stamp>
            <Btn size="sm" onClick={exitDraw}>{t('mask.cancel')}</Btn>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
};

// The two "…" items: cover on / off (frames first when there is no box yet), and draw again.
// None while there is no picture to frame.
export function useMaskMenu(videoId: string | null | undefined, keyId: string, plain = false): MenuItem[] {
  const t = useT();
  const combos = useShortcuts();
  const { mask, drawing, picture } = useMaskState(videoId);
  if (!videoId || !getSubtitleMaskOn() || !picture) return [];
  const on = !!mask?.on;
  // Always leaves framing first; with no box yet, it starts (or, when framing, cancels) it.
  const toggle = () => {
    setDrawFor(null);
    if (mask) setMask(videoId, { ...mask, on: !on });
    else if (!drawing) setDrawFor(videoId);
  };
  const label = (icon: React.ReactNode, text: string, tick: boolean) => plain
    ? <><span className="flex-1">{text}</span>{tick && <Check size={15} className="text-accent" />}</>
    : <>{icon} <span className="flex-1">{text}</span>{tick && <Check size={15} className="text-accent" />}</>;
  return [
    { label: label(<EyeOff size={15} />, t('mask.toggle'), on), title: t('mask.title', { key: formatCombo(combos[keyId]) }), onClick: toggle },
    ...(mask ? [{ label: label(<Crop size={15} />, t('mask.redraw'), false), onClick: () => setDrawFor(videoId) }] : []),
  ];
}

export default SubtitleMask;
