// The Japanese splitting dictionary on the phone (docs/mobile-web.md 7): the same 12
// kuromoji 0.1.2 files as src-tauri/src/ja_dict.rs, from the same mirrors, checked by
// size + sha256 and kept in Cache Storage. utils/japanese.ts reads them through
// readBinaryFile(`${dir}/<name>`), exactly as it reads the desktop's files on disk.

const CACHE = 'linguaclip-ja-dict';
const DIR = 'ja-dict';
const MIRRORS = ['cdn', 'fastly', 'gcore'].map(h => `https://${h}.jsdelivr.net/npm/kuromoji@0.1.2/dict/`).concat('https://unpkg.com/kuromoji@0.1.2/dict/');
const FILES: [string, number, string][] = [
  ['base.dat.gz', 3_956_825, '0803327762e1c93ca731e4319ab8343340f2806bb84941207782cde9d2d5a8eb'],
  ['check.dat.gz', 3_111_633, '193ae0035fff6fe812b58d9ee730e7a7d7ee601d918481ce51075c58114f6cc9'],
  ['tid.dat.gz', 1_605_820, 'd43d831cb6fb0f0a411739cd287a6d5e998e121a8daca614df14a81a0dcac586'],
  ['tid_pos.dat.gz', 5_916_009, '60dbfc99a6ab993f30c5dab648bec6ad7f9aaefa5c14e1843837d95e509f8895'],
  ['tid_map.dat.gz', 1_485_576, '33efd5ffd87a70f669add093fa39dee44341d58f940844ef107c8fd98bb795b2'],
  ['cc.dat.gz', 1_692_067, '02b7631be0d4de3a1a75cd9f9cc51536e4f94c9e6b389b813e06ba0f6e7de765'],
  ['unk.dat.gz', 10_512, 'f7f991cdeb9bfd3e9c0e4577cc50ee0815a11c508cccd444a9d3ab3c81521100'],
  ['unk_pos.dat.gz', 10_540, '5b183a29f281acc7e0542beca47b83f7985047c0a2d27e78a66f32276be5ad11'],
  ['unk_map.dat.gz', 1_190, '6df12460e5477230bb6fd9641def918b699fc0a8868016b6c9f794488630509b'],
  ['unk_char.dat.gz', 306, '9a8e86fd9aff32d323fbb59f5a7006f05927a11f8173c90712cc56293aeb3225'],
  ['unk_compat.dat.gz', 338, '50f60aa29bc2e86c2903ab8c825bb6fa604d2b294d96941c1d3924259791899d'],
  ['unk_invoke.dat.gz', 1_140, '6b210889548457c3006913afd12c8b525562255f2709e404604be9614a25e94c'],
];
const TOTAL = FILES.reduce((s, f) => s + f[1], 0);
const keyOf = (name: string) => `/${DIR}/${name}`;

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

async function have(cache: Cache, name: string, size: number): Promise<boolean> {
  const r = await cache.match(keyOf(name));
  return !!r && Number(r.headers.get('content-length')) === size;
}

export type JaDictStatus = { installed: boolean; dir: string; bytes: number };
export async function jaDictStatus(): Promise<JaDictStatus> {
  const cache = await caches.open(CACHE);
  const ok = await Promise.all(FILES.map(([n, s]) => have(cache, n, s)));
  return { installed: ok.every(Boolean), dir: DIR, bytes: TOTAL };
}

const progress = new Set<(pct: number) => void>();
export const onJaDictProgress = async (fn: (pct: number) => void): Promise<() => void> => {
  progress.add(fn);
  return () => { progress.delete(fn); };
};

// One file from the first mirror that gives the right bytes.
async function fetchOne(name: string, size: number, sha: string): Promise<ArrayBuffer> {
  let last: unknown = null;
  for (const m of MIRRORS) {
    try {
      const res = await fetch(m + name, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      if (buf.byteLength !== size || hex(await crypto.subtle.digest('SHA-256', buf)) !== sha) throw new Error(`bad file ${name}`);
      return buf;
    } catch (e) { last = e; }
  }
  throw last ?? new Error(`setup:${name}`);
}

let busy: Promise<void> | null = null;
export const installJaDict = (): Promise<void> => (busy ??= (async () => {
  const cache = await caches.open(CACHE);
  const todo = [];
  for (const f of FILES) if (!(await have(cache, f[0], f[1]))) todo.push(f);
  const total = todo.reduce((s, f) => s + f[1], 0);
  let done = 0;
  for (const [name, size, sha] of todo) {
    const buf = await fetchOne(name, size, sha);
    await cache.put(keyOf(name), new Response(buf, { headers: { 'content-length': String(size) } }));
    done += size;
    const pct = Math.min(99, Math.round((done * 100) / Math.max(1, total)));
    progress.forEach(fn => fn(pct));
  }
})().finally(() => { busy = null; }));

export async function removeJaDict(): Promise<void> {
  await busy?.catch(() => {});
  await caches.delete(CACHE);
}

// Only the dictionary's files exist on the phone; anything else is an error.
export async function readBinaryFile(path: string): Promise<Uint8Array> {
  const name = path.startsWith(`${DIR}/`) ? path.slice(DIR.length + 1) : null;
  const r = name && (await (await caches.open(CACHE)).match(keyOf(name)));
  if (!r) throw new Error(`not on this phone: ${path}`);
  return new Uint8Array(await r.arrayBuffer());
}
