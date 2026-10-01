import { verifyAsync } from '@noble/ed25519';
import { fetch } from '@tauri-apps/plugin-http';
import { deviceInfo, openExternal } from '../utils/desktop';

// A license activated through our relay (api.linguaclipapp.com)
// = a supporter. Since 2026-09-30 every feature is free
// for everyone: being a supporter unlocks nothing, it only
// changes the last line of Settings. The old trial lists (linguaclip_pro_trial /
// linguaclip_pro_listen) stay on disk, never read.
const LICENSE = 'linguaclip_pro_license'; // Stored
// The official site shows prices and the buy button; keep prices off the app.
export const BUY_URL = 'https://linguaclipapp.com/#pricing';
const API = 'https://api.linguaclipapp.com';
const PUBLIC_KEY = 'PtGtSFFAOHFrs4/rRAveqSKgLSZiLb+t9Q9cV4VrgCs=';
const MAX_AGE = 30 * 86400;      // a token older than this no longer unlocks: validate first
const REVALIDATE = 86400 * 1000; // checked again when Settings opens

type Stored = { key: string; device: string; instance: string; token: string };
export type Payload = { v: number; k: string; d: string; i: string; s: string; e: string | null; m: string; t: number };

// --- token (pure, tested in pro/test-license.mjs) ---

const b64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), c => c.charCodeAt(0));

export const keyHash = async (key: string) => {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)));
  return [...d].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
};

// The payload if the relay signed it, else null. Nothing inside is trusted before this.
export async function readToken(token: unknown, pub = PUBLIC_KEY): Promise<Payload | null> {
  if (typeof token !== 'string') return null;
  const [p, s] = token.split('.');
  if (!p || !s) return null;
  try {
    const bytes = b64(p);
    if (!(await verifyAsync(b64(s), bytes, b64(pub)))) return null;
    const v = JSON.parse(new TextDecoder().decode(bytes));
    return v && typeof v === 'object' ? v : null;
  } catch { return null; }
}

// ponytail: age is measured with the local clock; setting it back delays the 30 days,
// setting it >30 days ahead pauses Pro until it's fixed. Both accepted.
export const unlocks = (p: Payload | null, device: string, kHash: string, nowSec: number, allowTest: boolean) =>
  !!p && p.d === device && p.k === kHash && p.s === 'active'
  && (p.m === 'prod' || (allowTest && p.m === 'test'))
  && typeof p.t === 'number' && nowSec - p.t < MAX_AGE;

// --- stored state ---

const readStored = (): Stored | null => {
  try {
    const v = JSON.parse(localStorage.getItem(LICENSE) ?? 'null');
    return v && typeof v === 'object' && ['key', 'device', 'instance', 'token'].every(k => typeof v[k] === 'string') ? v : null;
  } catch { return null; }
};
const writeStored = (v: Stored | null) => {
  if (v) localStorage.setItem(LICENSE, JSON.stringify(v)); // throws → caller says "couldn't save"
  else localStorage.removeItem(LICENSE);
};

let pro = false;
let gen = 0; // bumped by activate / deactivate: a validate answer from before is dropped
let lastValidated = 0;
const subs = new Set<() => void>();
export const subscribe = (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn); }; };
const setPro = (v: boolean) => { if (v !== pro) { pro = v; subs.forEach(f => f()); } };
export const isPro = () => pro;

const allowTest = () => !!import.meta.env?.DEV;
const nowSec = () => Math.floor(Date.now() / 1000);

// Never throws (e.g. no crypto.subtle): a failure just means "not Pro right now".
async function judge(s: Stored | null) {
  if (!s) return false;
  try { return unlocks(await readToken(s.token), s.device, await keyHash(s.key), nowSec(), allowTest()); } catch { return false; }
}

const forget = () => {
  gen++;
  try { writeStored(null); } catch { /* judged by memory until next launch */ }
  setPro(false);
};

// --- relay ---

export type Device = { instance: string; name: string; at: number };
type Answer = { code: number; body: any };

async function call(path: string, body: object): Promise<Answer> {
  try {
    const r = await fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    let j: any = null;
    try { j = await r.json(); } catch { /* not JSON = temporary */ }
    return j && typeof j === 'object' ? { code: r.status, body: j } : { code: 0, body: null };
  } catch { return { code: 0, body: null }; } // network
}

// At launch, then when Settings opens a day later. As long as a record exists it
// keeps being validated, so an aged-out token comes back by itself once online.
// Only a signed answer changes anything: active → new token; anything else → the
// record is dropped (removed elsewhere / refunded). Errors keep it (it ages out).
export async function validateNow() {
  const s = readStored();
  if (!s) return;
  const g = gen;
  const r = await call('/v1/validate', { key: s.key, device: s.device, instance: s.instance });
  if (r.code !== 200) return;
  const p = await readToken(r.body.token).catch(() => null);
  if (g !== gen || !p || p.d !== s.device || p.i !== s.instance) return;
  lastValidated = Date.now();
  if (p.s !== 'active') return forget();
  const next = { ...s, token: r.body.token as string };
  const on = await judge(next);
  if (g !== gen) return; // a deactivate landed while judging
  try { writeStored(next); } catch { /* keep the old one on disk; memory follows the answer */ }
  setPro(on);
}

let ready: Promise<void> | null = null;
export function initLicense(): Promise<void> {
  if (!ready) {
    ready = judge(readStored()).then(setPro);
    ready.then(validateNow);
  } else if (Date.now() - lastValidated > REVALIDATE) validateNow();
  return ready;
}

export type ActivateFail = 'invalid' | 'revoked' | 'limit' | 'busy' | 'offline' | 'device' | 'save' | 'test' | 'verify';
export type ActivateResult = { ok: boolean; why?: ActivateFail; devices?: Device[] };

export async function activate(rawKey: string): Promise<ActivateResult> {
  const key = rawKey.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9-]{8,100}$/.test(key)) return { ok: false, why: 'invalid' };
  let me: { id: string; name: string };
  try { me = await deviceInfo(); } catch { return { ok: false, why: 'device' }; }
  const r = await call('/v1/activate', { key, device: me.id, name: me.name });
  if (r.code === 404) return { ok: false, why: 'invalid' };
  if (r.code === 403 && Array.isArray(r.body.devices)) return { ok: false, why: 'limit', devices: r.body.devices };
  if (r.code === 429) return { ok: false, why: 'busy' };
  if (r.code === 400) return { ok: false, why: 'revoked' }; // Creem refused the key (refunded / disabled)
  if (r.code !== 200 || typeof r.body.token !== 'string' || typeof r.body.instance !== 'string') return { ok: false, why: 'offline' };
  const next: Stored = { key, device: me.id, instance: r.body.instance, token: r.body.token };
  if (!(await judge(next))) {
    const p = await readToken(next.token).catch(() => null);
    if (p && p.s !== 'active') return { ok: false, why: 'revoked' };
    if (p && p.m !== 'prod' && !allowTest()) return { ok: false, why: 'test' };
    return { ok: false, why: 'verify' }; // clock far off, or this WebView can't hash
  }
  const old = readStored();
  gen++;
  try { writeStored(next); } catch { return { ok: false, why: 'save' }; }
  // A different key was on this computer (aged out, so "Enter key" showed): free its seat, best effort.
  if (old && old.key !== key) call('/v1/deactivate', { key: old.key, instance: old.instance });
  lastValidated = Date.now();
  setPro(true);
  return { ok: true };
}

// Judge the stored token again (tests; also cheap enough to call anywhere).
export const recheck = async () => { setPro(await judge(readStored())); return pro; };

export const activeKey = () => readStored()?.key ?? null;
export const thisInstance = () => readStored()?.instance ?? null;

export async function devices(key: string): Promise<Device[] | null> {
  const r = await call('/v1/devices', { key });
  return r.code === 200 && Array.isArray(r.body.devices) ? r.body.devices : null;
}

// Frees a seat. Local state is only cleared once the relay said yes (else the seat
// would leak) — or, for this computer, once it's known to be gone already: removed
// from another computer, Creem then answers 400 "already deactivated", so ask
// validate, whose signed "deactivated" drops the record.
export async function removeDevice(key: string, instance: string): Promise<boolean> {
  const r = await call('/v1/deactivate', { key, instance });
  const mine = readStored()?.instance === instance;
  if (r.code === 200 || (r.code === 404 && r.body?.error === 'not_found')) {
    if (mine) forget();
    return true;
  }
  if (!mine) return false;
  await validateNow();
  return readStored()?.instance !== instance;
}

export const openBuy = () => openExternal(BUY_URL).catch(err => console.error(err));
