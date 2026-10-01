/**
 * Supporter license (pro/license.ts; every feature is free):
 * activation (token rules, signed non-active drops the record, errors never lock,
 * a validate answer from before an activate / deactivate is ignored).
 * Run with: node pro/test-license.mjs
 */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as ed from '@noble/ed25519';

const sk = ed.utils.randomSecretKey();
const PUB = Buffer.from(await ed.getPublicKeyAsync(sk)).toString('base64');
const other = ed.utils.randomSecretKey();
const b64u = b => Buffer.from(b).toString('base64url');
const sha = s => require('node:crypto').createHash('sha256').update(s).digest('hex').slice(0, 32);
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const now = () => Math.floor(Date.now() / 1000);
const DEV = 'dev-0001', KEY = 'AAAAA-BBBBB-CCCCC';
const token = async (over = {}, key = sk) => {
  const p = Buffer.from(JSON.stringify({ v: 1, k: sha(KEY), d: DEV, i: 'inst-1', s: 'active', e: null, m: 'prod', t: now(), ...over }));
  return b64u(p) + '.' + b64u(await ed.signAsync(p, key));
};

const store = new Map();
globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
// fake relay: (path, body) => [status, json] | 'network'
globalThis.__relay = async () => 'network';
globalThis.__calls = [];

const out = join(tmpdir(), `license-${process.pid}.mjs`);
await build({
  entryPoints: ['pro/license.ts'], bundle: true, format: 'esm', platform: 'node', outfile: out,
  define: { 'import.meta.env': '{"DEV":false}' },
  plugins: [{
    name: 'stubs',
    setup(b) {
      b.onLoad({ filter: /pro\/license\.ts$/ }, a => ({ contents: readFileSync(a.path, 'utf8').replace(/const PUBLIC_KEY = '[^']+'/, `const PUBLIC_KEY = '${PUB}'`), loader: 'ts' }));
      b.onResolve({ filter: /utils\/desktop$|utils\/i18n$|^@tauri-apps\/plugin-http$/ }, a => ({ path: a.path, namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: `
        export const openExternal = async () => {};
        export const deviceInfo = async () => ({ id: '${DEV}', name: 'Test Mac' });
        export const t = k => k;
        export const fetch = async (url, init) => {
          const path = url.replace(/^https:\\/\\/[^/]+/, ''), body = JSON.parse(init.body);
          globalThis.__calls.push(path);
          const r = await globalThis.__relay(path, body);
          if (r === 'network') throw new Error('offline');
          return { status: r[0], json: async () => r[1] };
        };`, loader: 'js' }));
    },
  }],
});
const L = await import(out);
const stored = () => JSON.parse(store.get('linguaclip_pro_license') ?? 'null');

// --- token rules ---
const kh = await L.keyHash(KEY);
assert.equal(kh, sha(KEY));
const ok = async (tok, allowTest = false) => L.unlocks(await L.readToken(tok, PUB), DEV, kh, now(), allowTest);
assert.equal(await ok(await token()), true);
assert.equal(await ok(await token({}, other)), false, 'signed by someone else');
assert.equal(await ok((await token()).replace(/^./, 'x')), false, 'payload tampered');
assert.equal(await ok(await token({ d: 'dev-other' })), false, 'another computer');
assert.equal(await ok(await token({ k: sha('OTHER-KEY') })), false, 'another key');
assert.equal(await ok(await token({ s: 'disabled' })), false, 'refunded');
assert.equal(await ok(await token({ m: 'test' })), false, 'test key in a release build');
assert.equal(await ok(await token({ m: 'test' }), true), true, 'test key in dev');
assert.equal(await ok(await token({ t: now() - 31 * 86400 })), false, 'older than 30 days');
assert.equal(await ok(await token({ t: now() - 29 * 86400 })), true);
assert.equal(await L.readToken('garbage'), null);
assert.equal(await L.readToken(undefined), null);

// --- old placeholder format is not a license ---
store.set('linguaclip_pro_license', JSON.stringify({ key: 'K' }));
await L.initLicense();
assert.equal(L.isPro(), false);
store.delete('linguaclip_pro_license');

// --- activate: errors ---
const act = async (answer) => { __relay = async () => answer; return L.activate(KEY); };
assert.equal((await L.activate('x')).why, 'invalid', 'too short, never sent');
assert.equal((await act([404, { error: 'invalid_key' }])).why, 'invalid');
assert.equal((await act([400, { error: 'rejected', detail: 'License is disabled' }])).why, 'revoked');
assert.equal((await act([429, { error: 'rate_limited' }])).why, 'busy');
assert.equal((await act([503, { error: 'upstream' }])).why, 'offline');
assert.equal((await act('network')).why, 'offline');
const full = await act([403, { error: 'limit', devices: [{ instance: 'i1', name: 'A', at: 1 }] }]);
assert.equal(full.why, 'limit'); assert.equal(full.devices.length, 1);
assert.equal((await act([200, { status: 'active', instance: 'inst-1', token: await token({ m: 'test' }) }])).why, 'test');
assert.equal((await act([200, { status: 'disabled', instance: 'inst-1', token: await token({ s: 'disabled' }) }])).why, 'revoked', 'refunded key, same computer');
assert.equal((await act([200, { status: 'active', instance: 'inst-1', token: await token({ t: now() - 40 * 86400 }) }])).why, 'verify', 'clock far off');
assert.equal(stored(), null, 'nothing stored after a failure');
assert.equal(L.isPro(), false);

// --- activate: ok → supporter ---
assert.deepEqual(await act([200, { status: 'active', instance: 'inst-1', token: await token() }]), { ok: true });
assert.equal(L.isPro(), true);
assert.equal(stored().instance, 'inst-1');

// --- a pasted key with spaces is cleaned ---
__relay = async (p, b) => { assert.equal(b.key, KEY); return [200, { status: 'active', instance: 'inst-1', token: await token() }]; };
assert.equal((await L.activate(`  ${KEY}\n`)).ok, true);

// --- validate: errors never lock ---
const validate = async answer => { __relay = async () => answer; await L.validateNow(); };
for (const a of ['network', [503, { error: 'upstream' }], [404, { error: 'not_found' }], [200, { status: 'active', token: 'junk' }]]) {
  await validate(a);
  assert.equal(L.isPro(), true, JSON.stringify(a));
  assert.ok(stored(), 'record kept');
}
// a signed answer for another instance is ignored
await validate([200, { status: 'deactivated', token: await token({ s: 'deactivated', i: 'inst-9' }) }]);
assert.equal(L.isPro(), true);

// --- an aged-out token pauses Pro but keeps the record; the next validate brings it back ---
store.set('linguaclip_pro_license', JSON.stringify({ ...stored(), token: await token({ t: now() - 40 * 86400 }) }));
assert.equal(await L.recheck(), false);
assert.ok(stored());
await validate([200, { status: 'active', token: await token() }]);
assert.equal(L.isPro(), true);

// --- a validate that was in flight during a deactivate is dropped ---
let release;
__relay = async p => p === '/v1/validate' ? new Promise(r => { release = r; }) : [200, { ok: true, activation: 0 }];
const inflight = L.validateNow();
await new Promise(r => setTimeout(r, 10));
assert.equal(await L.removeDevice(KEY, 'inst-1'), true);
assert.equal(L.isPro(), false); assert.equal(stored(), null);
release([200, { status: 'active', token: await token() }]);
await inflight;
assert.equal(L.isPro(), false, 'old active token not written back');
assert.equal(stored(), null);

// --- signed non-active drops the record (refund) ---
await act([200, { status: 'active', instance: 'inst-1', token: await token() }]);
await validate([200, { status: 'disabled', token: await token({ s: 'disabled' }) }]);
assert.equal(L.isPro(), false); assert.equal(stored(), null);

// --- deactivate: failure keeps everything; 404 not_found (removed elsewhere) clears ---
await act([200, { status: 'active', instance: 'inst-1', token: await token() }]);
__relay = async () => [503, { error: 'upstream' }];
assert.equal(await L.removeDevice(KEY, 'inst-1'), false);
assert.equal(L.isPro(), true); assert.ok(stored());
__relay = async () => 'network';
assert.equal(await L.removeDevice(KEY, 'inst-1'), false);
assert.ok(stored());
__relay = async () => [404, { error: 'not_found' }];
assert.equal(await L.removeDevice(KEY, 'inst-1'), true);
assert.equal(L.isPro(), false); assert.equal(stored(), null);
// removed from another computer: the real relay says 400 "already deactivated"; validate settles it
await act([200, { status: 'active', instance: 'inst-1', token: await token() }]);
__relay = async p => p === '/v1/deactivate'
  ? [400, { error: 'rejected', detail: 'License key instnace is already deactivated' }]
  : [200, { status: 'deactivated', token: await token({ s: 'deactivated' }) }];
assert.equal(await L.removeDevice(KEY, 'inst-1'), true);
assert.equal(L.isPro(), false); assert.equal(stored(), null);
// same 400 but validate can't be reached: keep everything, say it failed
await act([200, { status: 'active', instance: 'inst-1', token: await token() }]);
__relay = async p => p === '/v1/deactivate' ? [400, { error: 'rejected' }] : 'network';
assert.equal(await L.removeDevice(KEY, 'inst-1'), false);
assert.equal(L.isPro(), true); assert.ok(stored());

// --- removing another computer leaves this one alone ---
await act([200, { status: 'active', instance: 'inst-1', token: await token() }]);
__relay = async () => [200, { ok: true, activation: 1 }];
assert.equal(await L.removeDevice(KEY, 'inst-2'), true);
assert.equal(L.isPro(), true); assert.ok(stored());

// --- a different key replacing an aged-out one frees the old seat ---
store.set('linguaclip_pro_license', JSON.stringify({ key: 'OLDKEY-00000', device: DEV, instance: 'inst-old', token: await token({ t: now() - 40 * 86400 }) }));
const freed = [];
__relay = async (p, b) => p === '/v1/deactivate' ? (freed.push(b), [200, { ok: true }]) : [200, { status: 'active', instance: 'inst-1', token: await token() }];
assert.equal((await L.activate(KEY)).ok, true);
await new Promise(r => setTimeout(r, 10));
assert.deepEqual(freed, [{ key: 'OLDKEY-00000', instance: 'inst-old' }]);
freed.length = 0;
assert.equal((await L.activate(KEY)).ok, true, 'same key again');
await new Promise(r => setTimeout(r, 10));
assert.equal(freed.length, 0);

// --- broken storage: not Pro, nothing thrown ---
store.set('linguaclip_pro_license', '{oops');
assert.equal(await L.recheck(), false);

console.log('test-license ok');
