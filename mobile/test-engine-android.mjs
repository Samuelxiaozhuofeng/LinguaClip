// Android audio engine (mobile/platform/audioEngine.android.ts) against a stub bridge:
// leaving a page = pause() then dispose() in one go; the pause must still reach Media3.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = join(tmpdir(), `engine-android-${process.pid}.mjs`);
const stub = {
  name: 'stub-bridge',
  setup(b) {
    b.onResolve({ filter: /^\.\/(androidBridge|androidInit\.android)$/ }, a => ({ path: a.path, namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, a => ({
      loader: 'js',
      contents: a.path.includes('androidInit')
        ? 'export const consumePendingAndroidBgMarks = () => []; export const subscribeAndroidBgMarks = () => () => {};'
        : `export const calls = [];
           export const isAndroidNative = () => true;
           export const onAndroidEvent = () => () => {};
           export const callAndroid = async (m, args) => { calls.push(m); return { playing: false, positionMs: 0, gen: 1 }; };`,
    }));
  },
};
await build({
  stdin: { contents: "export * from './mobile/platform/audioEngine.android.ts'; export { calls } from './androidBridge';", resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent', plugins: [stub],
});
const M = await import(out);

const eng = M.createAudioEngine({ onState: () => {} });
eng.pause();
eng.dispose();
await new Promise(r => setTimeout(r, 20));
assert.ok(M.calls.includes('playback.pause'), 'pause queued right before dispose must still reach Media3');

// Other commands after dispose stay dropped (a gone page must not start or move playback).
M.calls.length = 0;
eng.play();
eng.seek(3, true);
await new Promise(r => setTimeout(r, 20));
assert.deepEqual(M.calls, []);

// One line: seek, hold, then play — the stop is set before Media3 starts moving.
const e2 = M.createAudioEngine({ onState: () => {} });
M.calls.length = 0;
e2.seek(1, false);
e2.holdAt(2);
e2.play();
await new Promise(r => setTimeout(r, 20));
assert.deepEqual(M.calls, ['playback.seek', 'playback.holdAt', 'playback.play']);
// The old page's pause goes out at dispose, ahead of the next page's commands, even when its
// queue was still busy — sent later it would stop the new page's playback.
{
  let release;
  const slowBridge = M.calls;
  slowBridge.length = 0;
  const old = M.createAudioEngine({ onState: () => {} });
  old.seek(5, true); // in flight
  old.pause();
  old.dispose();
  const next = M.createAudioEngine({ onState: () => {} });
  next.play();
  await new Promise(r => setTimeout(r, 20));
  const firstPause = slowBridge.indexOf('playback.pause');
  const lastPlay = slowBridge.lastIndexOf('playback.play');
  assert.ok(firstPause >= 0 && firstPause < lastPlay, `old pause must precede new play: ${slowBridge.join(',')}`);
  assert.equal(slowBridge.filter(c => c === 'playback.pause').length, 1, 'pause sent once');
  void release;
}
console.log('engine android ok');
