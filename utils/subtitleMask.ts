import { useMemo, useSyncExternalStore } from 'react';
import { getSubtitleMaskOn } from './storage';

// Hard-subtitle mask (docs/subtitle-mask.md): one dark rectangle per video, kept as shares
// (0–1) of the video's own picture, shown on dictation, watch and review alike.

export type Rect = { x: number; y: number; w: number; h: number };
export type Mask = Rect & { on: boolean };
export type Box = { left: number; top: number; width: number; height: number };
export type Grip = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const KEY = 'linguaclip_subtitle_mask';
export const MIN = 0.02; // smallest side, as a share of the picture

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

// Bad JSON or a bad entry = no mask for that video; never throws.
export function parseMasks(raw: string | null): Record<string, Mask> {
  const out: Record<string, Mask> = {};
  try {
    const all = JSON.parse(raw || '{}');
    if (!all || typeof all !== 'object' || Array.isArray(all)) return out;
    for (const [id, m] of Object.entries(all as Record<string, Record<string, unknown>>)) {
      if (!m || typeof m !== 'object' || typeof m.on !== 'boolean') continue;
      const { x, y, w, h } = m;
      if (!num(x) || !num(y) || !num(w) || !num(h) || x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1 + 1e-6 || y + h > 1 + 1e-6) continue;
      out[id] = { on: m.on, x, y, w, h };
    }
  } catch { /* unreadable = none */ }
  return out;
}

// Where an object-contain picture (vw × vh) sits inside a W × H element.
export function fitBox(W: number, H: number, vw: number, vh: number): Box | null {
  if (!(W > 0 && H > 0 && vw > 0 && vh > 0)) return null;
  const s = Math.min(W / vw, H / vh);
  const width = vw * s, height = vh * s;
  return { left: (W - width) / 2, top: (H - height) / 2, width, height };
}

// Inside the picture, no side under MIN; moving keeps the size.
export function clampRect(r: Rect): Rect {
  const w = Math.min(1, Math.max(MIN, r.w)), h = Math.min(1, Math.max(MIN, r.h));
  return { x: Math.min(1 - w, Math.max(0, r.x)), y: Math.min(1 - h, Math.max(0, r.y)), w, h };
}

const unit = (v: number) => Math.min(1, Math.max(0, v));
// The rectangle dragged out between two points (shares), held to the picture.
export function spanRect(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  const x0 = unit(Math.min(a.x, b.x)), x1 = unit(Math.max(a.x, b.x));
  const y0 = unit(Math.min(a.y, b.y)), y1 = unit(Math.max(a.y, b.y));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// Moving the whole block, or one edge / corner, by dx / dy (shares of the picture).
export function dragRect(r: Rect, grip: Grip, dx: number, dy: number): Rect {
  if (grip === 'move') return clampRect({ ...r, x: r.x + dx, y: r.y + dy });
  let l = r.x, t = r.y, rt = r.x + r.w, b = r.y + r.h;
  if (grip.includes('w')) l = Math.min(rt - MIN, Math.max(0, l + dx));
  if (grip.includes('e')) rt = Math.max(l + MIN, Math.min(1, rt + dx));
  if (grip.includes('n')) t = Math.min(b - MIN, Math.max(0, t + dy));
  if (grip.includes('s')) b = Math.max(t + MIN, Math.min(1, b + dy));
  return { x: l, y: t, w: rt - l, h: b - t };
}

// --- Stored masks, plus two passing states: which video is being framed, and "lifted for now" ---
let version = 0;
let drawFor: string | null = null;
let peek = false;
let pictureFor: string | null = null; // the editing page's video has a picture to frame (not sound only, not failed)
const listeners = new Set<() => void>();
const bump = () => { version++; listeners.forEach(l => l()); };
const read = () => { try { return parseMasks(localStorage.getItem(KEY)); } catch { return {}; } };

export const getMask = (id: string | null | undefined): Mask | null => (id ? read()[id] ?? null : null);
export function setMask(id: string, m: Mask | null) {
  const all = read();
  if (!m && !(id in all)) return;
  if (m) { const r = clampRect(m); all[id] = { on: m.on, ...r }; } else delete all[id];
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* only costs the mask */ }
  if (m?.on) peek = false; // a box drawn or switched on shows
  bump();
}
export const forgetMask = (id: string) => setMask(id, null);

export const getDrawFor = () => drawFor;
// Starting, finishing or leaving framing always covers again: the box drawn (or kept) shows.
export const setDrawFor = (id: string | null) => { if (drawFor !== id || peek) { drawFor = id; peek = false; bump(); } };
export const getPeek = () => peek;
export const setPeek = (on: boolean) => { if (peek !== on) { peek = on; bump(); } };
export const togglePeek = () => setPeek(!peek);
export const setPicture = (id: string | null) => { if (pictureFor !== id) { pictureFor = id; bump(); } };

// Covering the picture right now (the switch on, this video's block on). Only the editing copy
// hides it while framing; a read-only one (review) never looks at framing.
export const maskShowing = (id: string | null | undefined, edit = false) =>
  !!id && getSubtitleMaskOn() && !!getMask(id)?.on && !(edit && drawFor === id);

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export function useMaskState(id: string | null | undefined) {
  const v = useSyncExternalStore(subscribe, () => version);
  return useMemo(() => ({ mask: getMask(id), drawing: !!id && drawFor === id, peek, picture: !!id && pictureFor === id }), [id, v]); // eslint-disable-line react-hooks/exhaustive-deps
}
