/**
 * Minimal pure-TS QR Code generator (ISO/IEC 18004, Byte mode, ECC Level L,
 * Versions 1–12, up to 367 UTF-8 bytes) for local desktop-to-phone sync pairing.
 * Zero dependencies, ES2020-compatible.
 */

// [totalCw, ecPerBlock, g1Blocks, g1DataCw, g2Blocks, g2DataCw] for ECC Level L
const VER_L: [number, number, number, number, number, number][] = [
  [26, 7, 1, 19, 0, 0], [44, 10, 1, 34, 0, 0], [70, 15, 1, 55, 0, 0], [100, 20, 1, 80, 0, 0],
  [134, 26, 1, 108, 0, 0], [172, 18, 2, 68, 0, 0], [196, 20, 2, 78, 0, 0], [242, 24, 2, 97, 0, 0],
  [292, 30, 2, 116, 0, 0], [346, 18, 2, 68, 2, 69], [404, 20, 4, 81, 0, 0], [466, 24, 2, 92, 2, 93],
];

const ALIGN: number[][] = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58],
];

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x; LOG[x] = i;
  x <<= 1; if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];

const gfMul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function rsEncode(data: Uint8Array, ecLen: number): Uint8Array {
  let gen = new Uint8Array([1]);
  for (let i = 0; i < ecLen; i++) {
    const next = new Uint8Array(gen.length + 1);
    for (let j = 0; j < gen.length; j++) {
      next[j] ^= gen[j];
      next[j + 1] ^= gfMul(gen[j], EXP[i]);
    }
    gen = next;
  }
  const rem = new Uint8Array(ecLen);
  for (let i = 0; i < data.length; i++) {
    const coef = data[i] ^ rem[0];
    rem.copyWithin(0, 1);
    rem[ecLen - 1] = 0;
    if (coef) for (let j = 0; j < ecLen; j++) rem[j] ^= gfMul(gen[j + 1], coef);
  }
  return rem;
}

function encodeCodewords(bytes: Uint8Array, ver: number): Uint8Array {
  const [, ecLen, g1, g1Data, g2, g2Data] = VER_L[ver - 1];
  const totalData = g1 * g1Data + g2 * g2Data;
  const bits: number[] = [];
  const push = (val: number, len: number) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  push(0b0100, 4); // Byte mode
  push(bytes.length, ver < 10 ? 8 : 16);
  for (let i = 0; i < bytes.length; i++) push(bytes[i], 8);
  for (let i = 0; i < 4 && bits.length < totalData * 8; i++) bits.push(0);
  while (bits.length % 8) bits.push(0);

  const dataCw = new Uint8Array(totalData);
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    dataCw[i >> 3] = b;
  }
  for (let i = bits.length >> 3, p = 0; i < totalData; i++, p ^= 1) dataCw[i] = p ? 0x11 : 0xec;

  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let off = 0;
  for (const [count, size] of [[g1, g1Data], [g2, g2Data]]) {
    for (let i = 0; i < count; i++) {
      const blk = dataCw.slice(off, off + size);
      off += size;
      dataBlocks.push(blk);
      ecBlocks.push(rsEncode(blk, ecLen));
    }
  }

  const out: number[] = [];
  const maxData = Math.max(g1Data, g2Data);
  for (let i = 0; i < maxData; i++) for (const blk of dataBlocks) if (i < blk.length) out.push(blk[i]);
  for (let i = 0; i < ecLen; i++) for (const blk of ecBlocks) out.push(blk[i]);
  return new Uint8Array(out);
}

function formatBits(mask: number): number {
  const data = (0b01 << 3) | mask;
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
  return ((data << 10) | rem) ^ 0x5412;
}

function versionBits(ver: number): number {
  let rem = ver << 12;
  for (let i = 17; i >= 12; i--) if ((rem >>> i) & 1) rem ^= 0x1f25 << (i - 12);
  return (ver << 12) | rem;
}

function buildBaseGrid(ver: number): { mat: boolean[][]; fixed: boolean[][] } {
  const n = 17 + ver * 4;
  const mat = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  const fixed = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  const set = (r: number, c: number, v: boolean) => {
    if (r >= 0 && r < n && c >= 0 && c < n) { mat[r][c] = v; fixed[r][c] = true; }
  };

  for (const [fr, fc] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const dark = inside && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        set(fr + r, fc + c, dark);
      }
    }
  }

  for (const r of ALIGN[ver - 1]) {
    for (const c of ALIGN[ver - 1]) {
      if (fixed[r][c]) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
      }
    }
  }

  for (let i = 8; i < n - 8; i++) {
    if (!fixed[6][i]) set(6, i, i % 2 === 0);
    if (!fixed[i][6]) set(i, 6, i % 2 === 0);
  }
  for (let i = 0; i <= 8; i++) {
    if (!fixed[8][i]) set(8, i, false);
    if (!fixed[i][8]) set(i, 8, false);
  }
  for (let i = n - 8; i < n; i++) { set(8, i, false); set(i, 8, false); }
  set(n - 8, 8, true);

  if (ver >= 7) {
    const vb = versionBits(ver);
    for (let i = 0; i < 18; i++) {
      const bit = ((vb >>> i) & 1) === 1;
      const r = Math.floor(i / 3), c = n - 11 + (i % 3);
      set(r, c, bit);
      set(c, r, bit);
    }
  }
  return { mat, fixed };
}

function writeFormat(mat: boolean[][], mask: number): void {
  const n = mat.length;
  const bits = formatBits(mask);
  const b = (idx: number) => ((bits >>> idx) & 1) === 1;
  const tl: [number, number][] = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  for (let i = 0; i < 15; i++) mat[tl[i][0]][tl[i][1]] = b(14 - i);
  for (let i = 0; i < 7; i++) mat[n - 1 - i][8] = b(14 - i);
  for (let i = 0; i < 8; i++) mat[8][n - 8 + i] = b(7 - i);
}

const MASKS: ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function penaltyScore(mat: boolean[][]): number {
  const n = mat.length;
  let score = 0, dark = 0;
  const scan = (get: (i: number) => boolean) => {
    let run = 1, prev = get(0);
    for (let i = 1; i < n; i++) {
      const cur = get(i);
      if (cur === prev) { run++; score += run === 5 ? 3 : run > 5 ? 1 : 0; }
      else { prev = cur; run = 1; }
    }
    for (let i = 0; i <= n - 11; i++) {
      let pat = 0;
      for (let j = 0; j < 11; j++) pat = (pat << 1) | (get(i + j) ? 1 : 0);
      if (pat === 0b10111010000 || pat === 0b00001011101) score += 40;
    }
  };
  for (let r = 0; r < n; r++) {
    scan(c => mat[r][c]);
    scan(c => mat[c][r]);
    for (let c = 0; c < n; c++) {
      if (mat[r][c]) dark++;
      if (r < n - 1 && c < n - 1) {
        const v = mat[r][c];
        if (mat[r][c + 1] === v && mat[r + 1][c] === v && mat[r + 1][c + 1] === v) score += 3;
      }
    }
  }
  return score + Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
}

/** Generate a standard QR Code boolean matrix (`true` = dark module) for UTF-8 `text`. */
export function qrMatrix(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  let ver = 0;
  for (let v = 1; v <= VER_L.length; v++) {
    const [, , g1, g1Data, g2, g2Data] = VER_L[v - 1];
    if (bytes.length <= g1 * g1Data + g2 * g2Data - (v < 10 ? 2 : 3)) { ver = v; break; }
  }
  if (!ver) throw new Error(`QR payload too long (${bytes.length} bytes, max 367)`);

  const codewords = encodeCodewords(bytes, ver);
  const { mat: base, fixed } = buildBaseGrid(ver);
  const n = base.length;
  let bitIdx = 0;
  const totalBits = codewords.length * 8;
  for (let col = n - 1, up = true; col >= 1; col -= 2, up = !up) {
    if (col === 6) col--;
    for (let step = 0; step < n; step++) {
      const r = up ? n - 1 - step : step;
      for (const dc of [0, -1]) {
        const c = col + dc;
        if (fixed[r][c]) continue;
        base[r][c] = bitIdx < totalBits && ((codewords[bitIdx >> 3] >>> (7 - (bitIdx & 7))) & 1) === 1;
        bitIdx++;
      }
    }
  }

  let best: boolean[][] | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const fn = MASKS[mask];
    const cand = base.map((row, r) => row.map((v, c) => (fixed[r][c] ? v : fn(r, c) ? !v : v)));
    writeFormat(cand, mask);
    const sc = penaltyScore(cand);
    if (sc < bestScore) { bestScore = sc; best = cand; }
  }
  return best!;
}

/** Render `text` as a self-contained crisp SVG QR Code with a 4-module quiet zone. */
export function qrSvg(text: string, size = 240): string {
  const mat = qrMatrix(text);
  const n = mat.length, quiet = 4, total = n + quiet * 2;
  const parts: string[] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (mat[r][c]) parts.push(`M${c + quiet},${r + quiet}h1v1h-1z`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="#fff"/><path d="${parts.join('')}" fill="#111"/></svg>`;
}
