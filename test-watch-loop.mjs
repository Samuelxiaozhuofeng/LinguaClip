/**
 * Checks watch page single-line loop decision logic in hooks/useWatchLoop.ts.
 * Run with: node test-watch-loop.mjs
 */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = join(tmpdir(), `watch-loop-${process.pid}.mjs`);
await build({
  entryPoints: ['hooks/useWatchLoop.ts'],
  bundle: true,
  format: 'esm',
  outfile: out,
  logLevel: 'error',
  plugins: [{
    name: 'stub-react',
    setup(b) {
      b.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        contents: 'export const useCallback=x=>x,useEffect=()=>{},useRef=x=>({current:x}),useState=x=>[x,()=>{}],useSyncExternalStore=(_,g)=>g();',
      }));
    },
  }],
});
const { decideWatchLineEnd, shouldLoopAtVideoEnd, useWatchClock, useWatchLoop } = await import(out);

const base = { loopOn: false, times: 3, plays: 1, autoPause: false, busy: false, blocked: false };

// 1. Loop takes priority over autoPause while plays < times.
assert.equal(decideWatchLineEnd({ ...base, loopOn: true, times: 3, plays: 1, autoPause: true }), 'loop');
assert.equal(decideWatchLineEnd({ ...base, loopOn: true, times: 3, plays: 2, autoPause: true }), 'loop');
assert.equal(decideWatchLineEnd({ ...base, loopOn: true, times: 3, plays: 1, autoPause: false }), 'loop');

// 2. Once `times` plays finish (plays >= times): autoPause on -> 'pause', off -> 'continue'.
assert.equal(decideWatchLineEnd({ ...base, loopOn: true, times: 3, plays: 3, autoPause: true }), 'pause');
assert.equal(decideWatchLineEnd({ ...base, loopOn: true, times: 3, plays: 3, autoPause: false }), 'continue');
assert.equal(decideWatchLineEnd({ ...base, loopOn: true, times: 5, plays: 4, autoPause: true }), 'loop');
assert.equal(decideWatchLineEnd({ ...base, loopOn: true, times: 5, plays: 5, autoPause: true }), 'pause');
assert.equal(decideWatchLineEnd({ ...base, loopOn: true, times: 10, plays: 9, autoPause: false }), 'loop');
assert.equal(decideWatchLineEnd({ ...base, loopOn: true, times: 10, plays: 10, autoPause: false }), 'continue');

// 3. Infinite loop (times === 0) always returns 'loop' regardless of plays or autoPause.
for (const plays of [1, 3, 10, 999]) {
  assert.equal(decideWatchLineEnd({ ...base, loopOn: true, times: 0, plays, autoPause: false }), 'loop');
  assert.equal(decideWatchLineEnd({ ...base, loopOn: true, times: 0, plays, autoPause: true }), 'loop');
}

// 4. Loop off falls back to autoPause or continue.
assert.equal(decideWatchLineEnd({ ...base, loopOn: false, times: 0, plays: 1, autoPause: true }), 'pause');
assert.equal(decideWatchLineEnd({ ...base, loopOn: false, times: 0, plays: 1, autoPause: false }), 'continue');

// 5. Busy (Anki recording) or blocked (drill/summary/lookup/pageLoopHeld) always returns 'continue'.
assert.equal(decideWatchLineEnd({ ...base, loopOn: true, times: 0, plays: 1, autoPause: true, busy: true }), 'continue');
assert.equal(decideWatchLineEnd({ ...base, loopOn: true, times: 3, plays: 1, autoPause: true, blocked: true }), 'continue');
assert.equal(decideWatchLineEnd({ ...base, loopOn: false, times: 3, plays: 1, autoPause: true, busy: true }), 'continue');
assert.equal(decideWatchLineEnd({ ...base, loopOn: false, times: 3, plays: 1, autoPause: true, blocked: true }), 'continue');

// 6. Final subtitle line reaching video `ended` (e.g. Whisper endTime >= duration).
assert.equal(shouldLoopAtVideoEnd({ ...base, loopOn: true, times: 3, plays: 1, lastEnd: 19.2, before: 18.95, now: 19.0, alreadyHandled: false }), true);
assert.equal(shouldLoopAtVideoEnd({ ...base, loopOn: true, times: 3, plays: 2, lastEnd: 19.0, before: 18.98, now: 19.0, alreadyHandled: false }), true);
assert.equal(shouldLoopAtVideoEnd({ ...base, loopOn: true, times: 3, plays: 3, lastEnd: 19.2, before: 18.95, now: 19.0, alreadyHandled: false }), false);
assert.equal(shouldLoopAtVideoEnd({ ...base, loopOn: true, times: 0, plays: 50, lastEnd: 19.2, before: 18.95, now: 19.0, alreadyHandled: false }), true);
// Last-frame race: lineEnded missed before `ended` fired (`before < lastEnd - 0.001`).
assert.equal(shouldLoopAtVideoEnd({ ...base, loopOn: true, times: 3, plays: 1, lastEnd: 18.95, before: 18.85, now: 19.0, alreadyHandled: false }), true);
// Already handled by checkClock on this play -> must NOT phantom-loop again at `ended`.
assert.equal(shouldLoopAtVideoEnd({ ...base, loopOn: true, times: 3, plays: 1, lastEnd: 18.98, before: 18.99, now: 19.0, alreadyHandled: true }), false);
// Video ended in end credits long after final line -> must NOT loop final line.
assert.equal(shouldLoopAtVideoEnd({ ...base, loopOn: true, times: 0, plays: 1, lastEnd: 120.0, before: 149.0, now: 150.0, alreadyHandled: false }), false);
// Loop off / busy / blocked at video end -> fall through to summary.
assert.equal(shouldLoopAtVideoEnd({ ...base, loopOn: false, times: 0, plays: 1, lastEnd: 19.2, before: 18.95, now: 19.0, alreadyHandled: false }), false);
assert.equal(shouldLoopAtVideoEnd({ ...base, loopOn: true, times: 0, plays: 1, busy: true, lastEnd: 19.2, before: 18.95, now: 19.0, alreadyHandled: false }), false);
assert.equal(shouldLoopAtVideoEnd({ ...base, loopOn: true, times: 0, plays: 1, blocked: true, lastEnd: 19.2, before: 18.95, now: 19.0, alreadyHandled: false }), false);

// 7. Real hook sequence: paused final timeupdate right before `ended` must not swallow the loop,
// and looping at video end must rewind off `duration` so Space during the gap won't restart at 0:00.
{
  const timers = new Map();
  let nextTid = 1;
  globalThis.window = {
    setTimeout: (fn) => { const id = nextTid++; timers.set(id, fn); return id; },
    clearTimeout: (id) => { timers.delete(id); },
  };
  const lines = [
    { id: 1, startTime: 0, endTime: 10, text: 'first' },
    { id: 2, startTime: 15, endTime: 18.99, text: 'last' },
  ];
  const video = { currentTime: 15, duration: 19, paused: false, playbackRate: 1, pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); } };
  const loop = useWatchLoop();
  loop.timesRef.current = 3;
  loop.toggleLoop();
  const clock = useWatchClock({ videoRef: { current: video }, lines, loop, autoPause: false, busy: () => false, blocked: false, onCur: () => {} });

  // Play 1: playing at 18.975, then browser pauses at 19.000 and fires timeupdate -> ended.
  video.currentTime = 18.975; video.paused = false; clock.checkClock();
  video.currentTime = 19.0; video.paused = true; clock.checkClock();
  assert.equal(clock.tryEndLoop(), true, 'play 1 should loop after paused final timeupdate');
  assert.ok(video.currentTime < 19.0 && video.currentTime >= 15.0, 'tryEndLoop should rewind slightly off duration');
  assert.equal(clock.gapLine(), 1, 'gapLine should report last line index during gap');

  // Fire scheduled gap timer -> play 2 starts at 15s and hits ended again.
  const [t1] = [...timers.values()]; timers.clear(); t1();
  assert.equal(video.currentTime, 15);
  assert.equal(video.paused, false);
  video.currentTime = 18.975; clock.checkClock();
  video.currentTime = 19.0; video.paused = true; clock.checkClock();
  assert.equal(clock.tryEndLoop(), true, 'play 2 should loop');

  // Fire scheduled gap timer -> play 3 finishes -> tryEndLoop returns false (open summary).
  const [t2] = [...timers.values()]; timers.clear(); t2();
  video.currentTime = 18.975; clock.checkClock();
  video.currentTime = 19.0; video.paused = true; clock.checkClock();
  assert.equal(clock.tryEndLoop(), false, 'play 3 (reached times=3) should stop looping and show summary');

  // Manual Space during end-of-video gap: clears gap, plays last 0.05s, hits ended -> must NOT re-loop.
  clock.seek(15, true);
  video.currentTime = 18.975; clock.checkClock();
  video.currentTime = 19.0; video.paused = true; clock.checkClock();
  assert.equal(clock.tryEndLoop(), true);
  loop.clearGap();
  video.play();
  video.currentTime = 19.0; video.paused = true; clock.checkClock();
  assert.equal(clock.tryEndLoop(), false, 'Space during end gap should proceed to summary instead of re-looping');

  // Seeking into end credits well past last subtitle -> ended must NOT loop last line.
  const creditLines = [{ id: 1, startTime: 15, endTime: 120, text: 'last' }];
  const v2 = { currentTime: 0, duration: 150, paused: false, playbackRate: 1, pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); } };
  const loop2 = useWatchLoop();
  loop2.timesRef.current = 0;
  loop2.toggleLoop();
  const clock2 = useWatchClock({ videoRef: { current: v2 }, lines: creditLines, loop: loop2, autoPause: false, busy: () => false, blocked: false, onCur: () => {} });
  clock2.seek(149, true);
  v2.currentTime = 150; v2.paused = true; clock2.checkClock();
  assert.equal(clock2.tryEndLoop(), false, 'ending in end credits must not loop last line');
}

console.log('test-watch-loop: all passed');
