/**
 * Pure synchronous cryptographic hashing, deterministic episode UUID v5,
 * normalized subtitle hashing, and causal logical clock helpers (docs/sync.md).
 *
 * Zero external dependencies, zero @tauri-apps/* imports, ES2020-compatible
 * (works in Chrome 95 Android WebView, desktop WebView, PWA, and Node).
 */

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const SHA256_INIT = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

function encodeUtf8(text: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text);
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = ((code - 0xd800) << 10) + (next - 0xdc00) + 0x10000;
        i++;
      }
    }
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return new Uint8Array(out);
}

/** Pure JS synchronous SHA-256 returning 32 raw bytes. */
export function sha256Bytes(text: string): Uint8Array {
  const msg = encodeUtf8(text);
  const msgLen = msg.length;
  const totalLen = Math.ceil((msgLen + 9) / 64) * 64;
  const buf = new Uint8Array(totalLen);
  buf.set(msg, 0);
  buf[msgLen] = 0x80;

  // 64-bit big-endian bit length
  const bitLen = msgLen * 8;
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  const view = new DataView(buf.buffer);
  view.setUint32(totalLen - 8, hi, false);
  view.setUint32(totalLen - 4, lo, false);

  const h = new Uint32Array(SHA256_INIT);
  const w = new Uint32Array(64);

  for (let offset = 0; offset < totalLen; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h[0], b = h[1], c = h[2], d = h[3];
    let e = h[4], f = h[5], g = h[6], hh = h[7];

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i], false);
  return out;
}

const HEX = '0123456789abcdef';

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out += HEX[b >>> 4] + HEX[b & 0x0f];
  }
  return out;
}

/** Pure JS synchronous SHA-256 returning 64-char lowercase hex. */
export function sha256Hex(text: string): string {
  return bytesToHex(sha256Bytes(text));
}

/**
 * Normalize a podcast/starter feed URL for stable cross-device identity:
 * trim whitespace, lowercase protocol and host, collapse trailing slashes
 * while preserving the root `/`, and preserve path/query case.
 */
export function normFeedUrl(feed: string): string {
  const trimmed = (feed ?? '').trim();
  if (!trimmed) return '';
  try {
    const u = new URL(trimmed);
    if (u.host) {
      const path = u.pathname.replace(/\/+$/, '') || '/';
      return `${u.protocol}//${u.host}${path}${u.search}${u.hash}`;
    }
    // Opaque URI such as `linguaclip:starter`
    const opaquePath = u.pathname.startsWith('/')
      ? u.pathname.replace(/\/+$/, '') || '/'
      : u.pathname.replace(/\/+$/, '');
    return `${u.protocol}${opaquePath}${u.search}${u.hash}`;
  } catch {
    return trimmed.startsWith('/')
      ? trimmed.replace(/\/+$/, '') || '/'
      : trimmed.replace(/\/+$/, '');
  }
}

/** Canonical episode deduplication key using normalized feed URL and trimmed guid. */
export function epNormKey(feed: string, guid: string): string {
  return `${normFeedUrl(feed)}\n${(guid ?? '').trim()}`;
}

/**
 * Deterministic RFC 4122 UUID v5 for a podcast or starter episode.
 * Always 36-char lowercase `[0-9a-f-]` so it passes Rust `valid_id` / `safe_name`.
 */
export function episodeUuid(feed: string, guid: string): string {
  const hash = sha256Bytes(`linguaclip:ep:${normFeedUrl(feed)}\n${(guid ?? '').trim()}`);
  const b = hash.slice(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytesToHex(b);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** SHA-256 hex of subtitle text with line endings normalized (`\r\n` / `\r` → `\n`). */
export function srtHash(subtitleText: string): string {
  return sha256Hex((subtitleText ?? '').replace(/\r\n?/g, '\n'));
}

/** Causal monotonic timestamp for local writes: never goes backwards. */
export function bumpTs(prevTs = 0, now = Date.now()): number {
  const prev = Number.isFinite(prevTs) ? prevTs : 0;
  return Math.max(now, prev + 1);
}

/** Compare two `(timestamp, deviceId)` causal stamps; ties break lexicographically by deviceId. */
export function compareStamp(tsA: number, devA: string, tsB: number, devB: string): number {
  if (tsA !== tsB) return tsA < tsB ? -1 : 1;
  if (devA !== devB) return devA < devB ? -1 : 1;
  return 0;
}
