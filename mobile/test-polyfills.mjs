// Unit check for Chromium <103 WebView AbortSignal.timeout polyfill (bug caught on MuMu Android 12 / Chrome 95).
import assert from 'node:assert/strict';
import { installWebViewPolyfills } from '../utils/polyfills.ts';

// 1. Missing AbortSignal.timeout -> polyfill installs and aborts after timeout with TimeoutError
{
  class FakeSignal { aborted = false; reason = undefined; }
  class FakeController {
    signal = new FakeSignal();
    abort(reason) { this.signal.aborted = true; this.signal.reason = reason; }
  }
  const fakeEnv = {
    AbortSignal: FakeSignal,
    AbortController: FakeController,
  };
  assert.equal(typeof fakeEnv.AbortSignal.timeout, 'undefined', 'precondition: absent on Chrome 95');
  installWebViewPolyfills(fakeEnv);
  assert.equal(typeof fakeEnv.AbortSignal.timeout, 'function', 'polyfill must define AbortSignal.timeout');
  const sig = fakeEnv.AbortSignal.timeout(20);
  assert.equal(sig.aborted, false, 'signal should start non-aborted');
  await new Promise(r => setTimeout(r, 60));
  assert.equal(sig.aborted, true, 'signal must abort after timeout');
  assert.equal(sig.reason?.name, 'TimeoutError', 'abort reason should be TimeoutError');
}

// 2. Native AbortSignal.timeout present -> never overwritten
{
  const nativeFn = () => ({ aborted: false });
  const fakeEnv = {
    AbortSignal: Object.assign(class {}, { timeout: nativeFn }),
    AbortController: class {},
  };
  installWebViewPolyfills(fakeEnv);
  assert.equal(fakeEnv.AbortSignal.timeout, nativeFn, 'must preserve native AbortSignal.timeout');
}

console.log('test-polyfills ok');
