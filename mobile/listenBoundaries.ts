// Pure boundary, drill-loop, and lockscreen-mark helpers for mobile intensive listening.
// Shared across Web/PWA (audioEngine.ts), Android native (audioEngine.android.ts), and useListen.ts.
import type { Subtitle, VideoSection } from '../types';
import { lineAt } from '../utils/srtParser';

export type Mark = 'open' | 'ok' | 'more';

export type WebLoopState = {
  start: number;
  end: number;
  remaining: number; // -1 = infinite, 0 = final pass, >0 = repeats remaining after current pass
  completedLoops: number;
  gapMs: number;
};

export type WebBoundaryInput = {
  lines: Subtitle[];
  before: number;
  now: number;
  paused: boolean;
  forceEnded?: boolean;
  holdTo: number | null;
  loop: WebLoopState | null;
  stops: number[];
  autoPause: boolean;
  heldBoundary: number | null;
};

export type WebBoundaryAction =
  | { kind: 'none' }
  | { kind: 'holdEnd'; pullBack: number; boundary: number }
  | { kind: 'loopEnd'; pullBack: number; done: boolean; nextRemaining: number; completedLoops: number; boundary: number }
  | { kind: 'sectionEnd'; pullBack: number; stopTime: number }
  | { kind: 'sentencePause'; pullBack: number; lineIndex: number; lineId: number; boundary: number };

export const PULLBACK_SEC = 0.02;
const BOUNDARY_EPS = 0.005;

export function sectionEndOf(sections: VideoSection[], index: number): number {
  const curEnd = sections[index]?.subtitles.at(-1)?.endTime ?? 0;
  const nextStart = sections[index + 1]?.subtitles[0]?.startTime ?? Infinity;
  return Math.min(curEnd, nextStart);
}

export function buildSectionStops(sections: VideoSection[]): number[] {
  const stops: number[] = [];
  for (let i = 0; i < sections.length; i++) {
    const end = sectionEndOf(sections, i);
    if (Number.isFinite(end) && end > 0) {
      if (stops.length === 0 || end - stops[stops.length - 1] > 0.001) {
        stops.push(end);
      }
    }
  }
  return stops;
}

export function lineStopTime(line: Subtitle, sections: VideoSection[], sectionOf: Map<number, number>): number {
  const sec = sectionOf.get(line.id) ?? 0;
  return Math.min(line.endTime, sectionEndOf(sections, sec));
}

export function computePullBack(lineStart: number, boundary: number): number {
  return Math.max(0, Math.max(lineStart, boundary - PULLBACK_SEC));
}

function sameBoundary(a: number | null, b: number): boolean {
  return a !== null && Math.abs(a - b) < BOUNDARY_EPS;
}

/**
 * Edge-triggered boundary evaluator for the Web <audio> engine (mirrors PlaybackService.kt).
 * Only triggers when playback crosses a boundary (`before < b && now >= b`) or on `forceEnded`.
 */
export function evaluateWebBoundary(input: WebBoundaryInput): WebBoundaryAction {
  const { lines, before, now, paused, forceEnded, holdTo, loop, stops, autoPause, heldBoundary } = input;
  if (!forceEnded && (paused || now <= before)) return { kind: 'none' };

  const crossed = (boundary: number) =>
    (before < boundary && now >= boundary) || (!!forceEnded && before < boundary);

  // 1. One-shot holdAt ("listen again" inside "see this line")
  if (holdTo !== null && holdTo > 0 && crossed(holdTo)) {
    const effective = forceEnded && holdTo > now ? now : holdTo;
    return {
      kind: 'holdEnd',
      pullBack: Math.max(0, effective - PULLBACK_SEC),
      boundary: holdTo,
    };
  }

  // 2. Active single-sentence loop (drill or free-mode loop)
  if (loop && !sameBoundary(heldBoundary, loop.end) && crossed(loop.end)) {
    const effective = forceEnded && loop.end > now ? now : loop.end;
    const completedLoops = loop.completedLoops + 1;
    const done = loop.remaining === 0;
    const nextRemaining = loop.remaining > 0 ? loop.remaining - 1 : loop.remaining;
    return {
      kind: 'loopEnd',
      pullBack: computePullBack(loop.start, effective),
      done,
      nextRemaining,
      completedLoops,
      boundary: loop.end,
    };
  }

  // 3. Section-end stops (edge-triggered, skipping the stop just paused on)
  if (stops.length > 0) {
    for (const stop of stops) {
      if (stop <= 0 || sameBoundary(heldBoundary, stop)) continue;
      const hit = (before < stop && now >= stop) || (!!forceEnded && before < stop && stop <= now + 0.5);
      if (hit) {
        const effective = forceEnded && stop > now ? now : stop;
        const was = lineAt(lines, before);
        const lineStart = was >= 0 ? lines[was].startTime : 0;
        return {
          kind: 'sectionEnd',
          pullBack: computePullBack(lineStart, effective),
          stopTime: stop,
        };
      }
    }
  }

  // 4. Sentence-end autoPause (free mode)
  if (autoPause && lines.length > 0) {
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (sameBoundary(heldBoundary, l.endTime)) continue;
      const hit = (before < l.endTime && now >= l.endTime) || (!!forceEnded && before < l.endTime && l.endTime <= now + 0.5);
      if (hit) {
        const effective = forceEnded && l.endTime > now ? now : l.endTime;
        return {
          kind: 'sentencePause',
          pullBack: computePullBack(l.startTime, effective),
          lineIndex: i,
          lineId: l.id,
          boundary: l.endTime,
        };
      }
    }
  }

  return { kind: 'none' };
}

/**
 * Maps native/web loop completion count to drill UI state (`play` 1..tries, `shown` boolean).
 * In drill mode, native `setLoop` is armed with `count = tries + 1` so after `tries` blind
 * passes the text reveals and plays one final pass before pausing at line end.
 */
export function drillProgressFromLoops(completedLoops: number, tries: number): { play: number; shown: boolean } {
  const safeTries = Math.max(1, tries);
  if (completedLoops >= safeTries) {
    return { play: safeTries, shown: true };
  }
  return { play: Math.max(1, completedLoops + 1), shown: false };
}

/**
 * Resolves a lockscreen/background `mark_missed` event to a Subtitle.id in `lines`.
 */
export function resolveBgMarkLineId(
  lines: Subtitle[],
  ev: { lineId?: number; startMs: number; positionMs?: number; text?: string },
): number | null {
  if (lines.length === 0) return null;
  if (typeof ev.lineId === 'number' && ev.lineId > 0) {
    const exact = lines.find(l => l.id === ev.lineId);
    if (exact) return exact.id;
  }
  const startSec = Math.max(0, ev.startMs / 1000);
  // First try exact timestamp match within 250ms (optionally preferring matching text)
  let best: Subtitle | null = null;
  let bestDist = Infinity;
  const wantText = ev.text?.trim();
  for (const l of lines) {
    const dist = Math.abs(l.startTime - startSec);
    if (dist <= 0.25 && dist < bestDist) {
      if (!wantText || l.text.trim() === wantText || best === null) {
        best = l;
        bestDist = dist;
      }
    }
  }
  if (best) return best.id;
  const idx = lineAt(lines, typeof ev.positionMs === 'number' ? ev.positionMs / 1000 : startSec);
  return idx >= 0 ? lines[idx].id : null;
}

/**
 * Merges lockscreen-marked line IDs into the in-memory marks Map without downgrading 'ok'/'more'.
 */
export function mergeBgMarks(marks: Map<number, Mark>, lineIds: number[]): Map<number, Mark> {
  let next: Map<number, Mark> | null = null;
  for (const id of lineIds) {
    if (!marks.has(id) && !(next?.has(id))) {
      if (!next) next = new Map(marks);
      next.set(id, 'open');
    }
  }
  return next ?? marks;
}
