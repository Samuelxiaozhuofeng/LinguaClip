/**
 * Browser-only stand-in for the Tauri shell, so `npm run dev` can be clicked
 * through in a normal browser. Never loaded inside Tauri or in a release build.
 *
 * - Local files are served by vite's /@fs route (allow-list in vite.config.ts).
 * - File dialogs return `window.__MOCK__.pick` if set, else a fixture clip.
 * - `window.__MOCK__.tools` sets what import_tools reports (both false by default).
 * - `window.__MOCK__.gpus` = the graphics cards list_gpus reports (empty by default;
 *   the GPU settings only show with a Windows user agent).
 * - `window.__MOCK__.convertTool`: is the video converter "downloaded" (false by
 *   default); `window.__MOCK__.probe` = what probe_video reports for any file.
 * - `window.__MOCK__.jaDict`: is the Japanese dictionary "downloaded" (false by
 *   default); its files are served from node_modules/kuromoji/dict.
 * - `window.__MOCK__.update = { version, body }` fakes a newer release (null = up to
 *   date, 'fail' = no connection); `updateFail = 'download' | 'install'` fakes that step failing.
 * - Local dictionaries (docs/yomitan.md): `window.__MOCK__.localDicts` is the
 *   installed list (empty by default). Importing / downloading adds a book from
 *   dev/fixtures/dict-sample.json (rows cut from the real ones; a picked path
 *   containing "nolang" adds one whose language is unknown); `dictFail = 'net'`
 *   etc. makes the next import / download fail with that code.
 * - Backups (docs/backup.md): zips are plain objects kept in sessionStorage, so they outlive
 *   the reload a restore does. The save dialog returns `pick` or ~/Desktop/<suggested name>;
 *   the open dialog for a zip returns `pick` or the last one saved. `__MOCK__.putBackup(path,
 *   { manifest, data })` plants one (a bad backup); `__MOCK__.failUnpack('msg')` makes every
 *   backup_unpack fail (survives reloads; `failUnpack(null)` stops it).
 * - Rust commands are logged to `window.__MOCK__.calls`; fake import progress
 *   with `window.__MOCK__.emit('import-progress', {...})`.
 * - vite aliases @tauri-apps/plugin-http to this file, hence the `fetch` export;
 *   cross-origin calls (AI endpoints, AnkiConnect) are relayed by vite.
 */
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';

declare const __DEV_HOME__: string;

const FIXTURE = `${__DEV_HOME__}/Movies/LinguaClip/Me at the zoo [jNQXAC9IVRw]`;
// Commas stay as they are: vite's /@fs doesn't find a file whose name has an encoded one (%2C).
const fsUrl = (path: string) => '/@fs' + path.split('/').map(p => encodeURIComponent(p).replace(/%2C/g, ',')).join('/');
const cache = new Map<string, string>(); // write_cache stays in memory

type Args = Record<string, any>;

const OWN = `${__DEV_HOME__}/Movies/LinguaClip`;
const BACKUPS = `${OWN}/backups`;
type Zip = { manifest: string; data: string; files?: Record<string, string> };
const zips = (): Record<string, Zip> => JSON.parse(sessionStorage.getItem('__mock_backups') || '{}');
const setZips = (z: Record<string, Zip>) => sessionStorage.setItem('__mock_backups', JSON.stringify(z));
const inBackups = (path: string) => path.startsWith(`${BACKUPS}/`) && !path.slice(BACKUPS.length + 1).includes('/');
const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const stamp = (d: Date, long: boolean) => long
  ? `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${pad(d.getMilliseconds(), 3)}`
  : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const readZip = (path: string) => {
  const z = zips()[path];
  if (!inBackups(path) || !z) throw 'missing:backup';
  return z;
};

type SyncFile = { content: string; etag: string; size: number };
type SyncPack = { snapshotJson: string; subs: [string, string][]; clips: Record<string, string> };
const byteLen = (s: string) => new TextEncoder().encode(s).byteLength;
const loadObj = <T extends Record<string, any>>(key: string): T => {
  try { return JSON.parse(sessionStorage.getItem(key) || '{}') as T; } catch { return {} as T; }
};
const saveObj = (key: string, v: unknown) => sessionStorage.setItem(key, JSON.stringify(v));
const storeProxy = <T extends Record<string, any>>(key: string) => new Proxy({} as T, {
  get: (_, prop) => (typeof prop === 'string' ? loadObj<T>(key)[prop] : undefined),
  has: (_, prop) => typeof prop === 'string' && prop in loadObj<T>(key),
  set: (_, prop, val) => { if (typeof prop === 'string') { const d = loadObj<T>(key); (d as any)[prop] = val; saveObj(key, d); } return true; },
  deleteProperty: (_, prop) => { if (typeof prop === 'string') { const d = loadObj<T>(key); delete d[prop]; saveObj(key, d); } return true; },
  ownKeys: () => Reflect.ownKeys(loadObj<T>(key)),
  getOwnPropertyDescriptor: (_, prop) => {
    const d = loadObj<T>(key);
    return typeof prop === 'string' && prop in d ? { configurable: true, enumerable: true, value: d[prop], writable: true } : undefined;
  },
});
const SYNC_FILES_KEY = '__mock_sync_webdav';
const SYNC_PACKS_KEY = '__mock_sync_merge_packs';
const SYNC_CLIPS_KEY = '__mock_sync_clips';
let syncEtagSeq = 0;
const nextEtag = () => `"mock-${Date.now()}-${++syncEtagSeq}"`;
const syncEntryOf = (raw: unknown): SyncFile | null => typeof raw === 'string'
  ? { content: raw, etag: `"raw-${raw.length}"`, size: byteLen(raw) }
  : raw && typeof raw === 'object' && typeof (raw as SyncFile).content === 'string'
    ? raw as SyncFile : null;
const isLocalHost = (host: string) => {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h === '::1' || h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.ts.net')) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(h) || /^fe80:/i.test(h)) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
};
const VALID_ID = /^[A-Za-z0-9_-]{1,128}$/;
const VALID_SHA = /^[0-9a-f]{64}$/;
const SAFE_CLIP = /^[A-Za-z0-9._-]+$/;
const SYNC_SUBS = new Set(['devices', 'subs', 'caches', 'clip-packs']);
const SYNC_CACHE_KINDS = new Set(['cloze', 'breakdown', 'segments', 'levels', 'trans', 'keywords', 'phrases']);
const REKEY_KINDS = ['words', 'cloze', 'breakdown', 'segments', 'levels', 'trans', 'keywords', 'phrases'];
const checkClipName = (name: string) => {
  if (!name || name.length > 200 || name.startsWith('.') || name.includes('..') || !SAFE_CLIP.test(name)) throw `clip:bad_name:${name}`;
};
const checkRelPath = (rel: string) => {
  if (!rel || rel.startsWith('/') || rel.includes('\\') || rel.includes('..') || /[\u0000-\u001f]/.test(rel)) throw `sync:invalid_path:${rel}`;
  const idx = rel.indexOf('/');
  const [sub, rest] = idx < 0 ? ['', ''] : [rel.slice(0, idx), rel.slice(idx + 1)];
  const ok = (sub === 'devices' && rest.endsWith('.json.gz') && VALID_ID.test(rest.slice(0, -8)))
    || (sub === 'subs' && rest.endsWith('.srt.gz') && VALID_SHA.test(rest.slice(0, -7)))
    || (sub === 'caches' && rest.endsWith('.json.gz') && (() => { const s = rest.slice(0, -8); const d = s.indexOf('.'); return d > 0 && VALID_ID.test(s.slice(0, d)) && SYNC_CACHE_KINDS.has(s.slice(d + 1)); })())
    || (sub === 'clip-packs' && rest.endsWith('.zip') && /^[A-Za-z0-9_-]{1,196}$/.test(rest.slice(0, -4)));
  if (!ok) throw `sync:invalid_path:${rel}`;
};
const checkSyncCfg = (cfg: Args | undefined, isGetGz = false) => {
  if (mock.sync.fail && (isGetGz || !mock.sync.fail.startsWith('sync:corrupt:'))) throw mock.sync.fail;
  let u: URL;
  try { u = new URL(String(cfg?.url ?? '').trim()); } catch { throw 'sync:insecure_url'; }
  if (!u.hostname || u.search || u.hash || (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLocalHost(u.hostname)))) throw 'sync:insecure_url';
  const rawRoot = String(cfg?.rootDir ?? 'LinguaClip').trim().replace(/^\/+|\/+$/g, '');
  const rootSegs = rawRoot ? rawRoot.split('/') : ['LinguaClip'];
  if (rootSegs.some(s => !s || s === '.' || s === '..' || s.length > 128 || /[\u0000-\u001f\\?#:*"<>|]/.test(s))) throw `sync:invalid_path:${cfg?.rootDir}`;
  if (!String(cfg?.username ?? '').trim() || !String(cfg?.password ?? '')) throw 'sync:auth';
  const baseSegs = u.pathname.split('/').filter(Boolean);
  return `${u.origin}/${[...baseSegs, ...rootSegs, 'LinguaClipSync'].map(encodeURIComponent).join('/')}/`;
};

const syncMock = {
  get files(): Record<string, SyncFile> { return storeProxy<Record<string, SyncFile>>(SYNC_FILES_KEY); },
  set files(v: Record<string, SyncFile>) { saveObj(SYNC_FILES_KEY, v ?? {}); },
  get mergePacks(): Record<string, SyncPack> { return storeProxy<Record<string, SyncPack>>(SYNC_PACKS_KEY); },
  set mergePacks(v: Record<string, SyncPack>) { saveObj(SYNC_PACKS_KEY, v ?? {}); },
  get clips(): Record<string, string> { return storeProxy<Record<string, string>>(SYNC_CLIPS_KEY); },
  set clips(v: Record<string, string>) { saveObj(SYNC_CLIPS_KEY, v ?? {}); },
  fail: null as string | null,
  putPeer(devId: string, snapshotObj: unknown, subsMap?: Record<string, string>, clipPacksMap?: Record<string, Record<string, string> | string[] | string>) {
    const store = loadObj<Record<string, SyncFile>>(SYNC_FILES_KEY);
    const snap = typeof snapshotObj === 'string' ? snapshotObj : JSON.stringify(snapshotObj);
    store[`devices/${devId}.json.gz`] = { content: snap, etag: nextEtag(), size: byteLen(snap) };
    if (subsMap) for (const [k, srt] of Object.entries(subsMap)) {
      const path = k.startsWith('subs/') ? k : `subs/${k.endsWith('.srt.gz') ? k : `${k}.srt.gz`}`;
      store[path] = { content: srt, etag: nextEtag(), size: byteLen(srt) };
    }
    if (clipPacksMap) for (const [k, clips] of Object.entries(clipPacksMap)) {
      const path = k.startsWith('clip-packs/') ? k : `clip-packs/${k.endsWith('.zip') ? k : `${k}.zip`}`;
      const body = typeof clips === 'string' ? clips : JSON.stringify(Array.isArray(clips) ? Object.fromEntries(clips.map(n => [n, `mock-clip:${n}`])) : clips);
      store[path] = { content: body, etag: nextEtag(), size: byteLen(body) };
    }
    saveObj(SYNC_FILES_KEY, store);
  },
  reset() {
    this.fail = null;
    sessionStorage.removeItem(SYNC_FILES_KEY);
    sessionStorage.removeItem(SYNC_PACKS_KEY);
    sessionStorage.removeItem(SYNC_CLIPS_KEY);
    sessionStorage.removeItem('__mock_last_sync_pack');
  },
};

const mock = {
  pick: null as string | null,
  // set to (args) => ArrayBuffer to fake Edge TTS; unset = null = system voice
  tts: null as ((args: Args) => unknown) | null,
  calls: [] as { cmd: string; args: unknown }[],
  // what import_tools reports; default = a stranger's Mac with nothing installed
  tools: { whisper: false, youtube: false },
  jaDict: false,
  convertTool: false,
  // youtube_tool_status: yt-dlp + deno + ffmpeg downloaded (docs/youtube.md)
  youtubeTool: false,
  // open_youtube_window: what the main window handed over (the window itself only exists in the app)
  youtubeWindow: null as Args | null,
  // youtube_pick_done: the main window's answers to "youtube-pick" ({ id, ok })
  youtubePicksDone: [] as Args[],
  // list_gpus: the cards a Windows PC would report
  gpus: [] as { name: string; discrete: boolean }[],
  // device_info: set another id to act as a second computer (license seats)
  device: { id: 'browser-dev-device-0001', name: 'Browser (dev)' },
  clipFail: null as string | null, // set to make cut_clip fail with this message
  probe: { duration: 19, video: 'h264', audio: 'ac3', subtitles: [] as unknown[] },
  update: null as null | 'fail' | { version: string; body: string },
  updateFail: null as null | 'download' | 'install',
  localDicts: [] as Args[],
  dictFail: null as string | null,
  putBackup: (path: string, zip: Zip) => setZips({ ...zips(), [path]: zip }),
  failUnpack: (msg: string | null) => (msg ? sessionStorage.setItem('__mock_unpack_fail', msg) : sessionStorage.removeItem('__mock_unpack_fail')),
  sync: syncMock,
  emit,
};
(window as any).__MOCK__ = mock;

let dictFixture: Args | null = null;
const fixture = async (): Promise<Args> => (dictFixture ??= await (await fetch('/dev/fixtures/dict-sample.json')).json());
const dictJob = async (stages: ('download' | 'import')[]) => {
  for (const stage of stages) {
    for (let pct = 0; pct < 100; pct += 25) {
      await emit('dict-import-progress', { stage, pct });
      await new Promise(r => setTimeout(r, 250));
    }
  }
  const fail = mock.dictFail;
  mock.dictFail = null;
  if (fail) throw fail;
};
const addDict = (d: Args) => {
  const order = Math.max(-1, ...mock.localDicts.map(x => x.order)) + 1;
  mock.localDicts = [...mock.localDicts, { ...d, id: `${d.id}-${Date.now()}`, order, enabled: true }];
  return mock.localDicts;
};
// A mock book reads its rows from the fixture book of the same language.
const rowsFor = (fx: Args, id: string) => {
  const d = mock.localDicts.find(x => x.id === id);
  const src = fx.dicts.find((x: Args) => x.lang === d?.lang);
  return src ? { rows: fx.rows[src.id] as unknown[][], tags: fx.tags[src.id] as Args } : null;
};

async function handle(cmd: string, args: Args): Promise<unknown> {
  switch (cmd) {
    case 'dict_list':
      return [...mock.localDicts].sort((a, b) => a.order - b.order);
    case 'dict_check': {
      const fx = await fixture();
      const d = fx.dicts.find((x: Args) => args.path.includes(x.title)) ?? fx.dicts[1];
      return { title: d.title, revision: d.revision, same: mock.localDicts.find(x => x.title === d.title) ?? null };
    }
    case 'dict_import': {
      const fx = await fixture();
      await dictJob(['import']);
      const d = fx.dicts.find((x: Args) => args.path.includes(x.title)) ?? fx.dicts[1];
      if (args.replace) mock.localDicts = mock.localDicts.filter(x => x.id !== args.replace);
      return addDict({ ...d, downloadUrl: null, lang: args.path.includes('nolang') ? null : d.lang });
    }
    case 'dict_download': {
      const fx = await fixture();
      await dictJob(['download', 'import']);
      const url: string = args.urls[0];
      const title = /\/([^/]+?)(?:-yomitan)?\.zip$/.exec(url)?.[1] ?? 'download';
      const lang = /dict\/(\w\w)\//.exec(url)?.[1] ?? 'ja';
      const like = fx.dicts.find((x: Args) => x.lang === lang);
      return addDict({ ...like, id: `mock-${title}`, title, downloadUrl: url, bytes: like.bytes });
    }
    case 'dict_update':
      mock.localDicts = mock.localDicts.map(d => (d.id !== args.id ? d : {
        ...d, ...(args.enabled != null && { enabled: args.enabled }), ...(args.lang != null && { lang: args.lang }),
      }));
      return handle('dict_list', {});
    case 'dict_move': {
      const list = await handle('dict_list', {}) as Args[];
      const at = list.findIndex(d => d.id === args.id), to = at + args.dirStep;
      if (at >= 0 && to >= 0 && to < list.length) [list[at], list[to]] = [list[to], list[at]];
      mock.localDicts = list.map((d, i) => ({ ...d, order: i }));
      return mock.localDicts;
    }
    case 'dict_remove':
      mock.localDicts = mock.localDicts.filter(d => d.id !== args.id);
      return handle('dict_list', {});
    case 'dict_lookup': {
      const fx = await fixture();
      const keys = new Set(args.keys as string[]);
      return (args.ids as string[]).flatMap(id => {
        const src = rowsFor(fx, id);
        const rows = src?.rows.filter(r => keys.has(r[0] as string) || keys.has(r[1] as string)) ?? [];
        if (!rows.length) return [];
        const used = new Set(rows.flatMap(r => `${r[2] ?? ''} ${r[7] ?? ''}`.split(/\s+/)));
        return [{ id, rows, tags: Object.fromEntries(Object.entries(src!.tags).filter(([k]) => used.has(k))) }];
      });
    }
    case 'plugin:dialog|save': {
      const pick = mock.pick ?? `${__DEV_HOME__}/Desktop/${args.options?.defaultPath}`;
      mock.pick = null;
      const key = args.options?.filters?.[0]?.name === 'LinguaClip Sync' ? '__mock_last_sync_pack' : '__mock_last_saved';
      sessionStorage.setItem(key, pick);
      return pick;
    }
    case 'backup_write': {
      const name = `LinguaClip-${args.kind}-${stamp(new Date(), args.kind === 'pre')}.zip`;
      const path = args.dest ?? `${BACKUPS}/${name}`;
      const files: Record<string, string> = {};
      if (args.files) for (const [k, v] of cache) files[`files/${k.slice(OWN.length + 1)}`] = v;
      setZips({ ...zips(), [path]: { manifest: args.manifest, data: args.data, files } });
      return path;
    }
    case 'backup_stage': {
      const z = zips()[args.path];
      if (!z) throw 'missing:backup';
      setZips({ ...zips(), [`${BACKUPS}/restore-staged.zip`]: z });
      return `${BACKUPS}/restore-staged.zip`;
    }
    case 'backup_list':
      return Object.entries(zips())
        .filter(([p]) => inBackups(p) && !p.endsWith('/restore-staged.zip'))
        .flatMap(([path, z]) => { try { return [{ path, manifest: z.manifest, at: JSON.parse(z.manifest).createdAt as number }]; } catch { return []; } })
        .sort((a, b) => b.at - a.at)
        .map(({ path, manifest }) => ({ path, manifest }));
    case 'backup_read': {
      const z = readZip(args.path);
      return { manifest: z.manifest, data: z.data };
    }
    case 'backup_unpack': {
      const fail = sessionStorage.getItem('__mock_unpack_fail');
      if (fail) throw fail;
      const files = Object.entries(readZip(args.path).files ?? {}).filter(([k]) => /^files\/[\w-]+\.\w+\.json$/.test(k));
      for (const [k, v] of files) cache.set(`${OWN}/${k.slice(6)}`, v);
      return files.length;
    }
    case 'backup_kept_clips': {
      const ours = /\/(LinguaClip-(auto|pre)-[^/]*\.zip|restore-staged\.zip)$/; // anything else in backups/ is ignored
      const all = Object.entries(zips()).filter(([p]) => inBackups(p) && ours.test(p));
      try {
        return [...new Set(all.flatMap(([, z]) => JSON.parse(z.manifest).clips as string[]))];
      } catch { return null; }
    }
    case 'backup_remove': {
      const z = zips();
      for (const n of args.names as string[]) delete z[`${BACKUPS}/${n}`];
      setZips(z);
      return null;
    }
    case 'plugin:dialog|open': {
      const filter = args.options?.filters?.[0];
      const exts: string[] = filter?.extensions ?? [];
      if (filter?.name === 'LinguaClip') { // a backup (utils/desktop.ts pickBackupFile)
        const pick = mock.pick ?? sessionStorage.getItem('__mock_last_saved');
        mock.pick = null;
        return pick;
      }
      if (filter?.name === 'LinguaClip Sync') { // a sync merge pack (utils/desktop.ts pickSyncPackFile)
        const pick = mock.pick ?? sessionStorage.getItem('__mock_last_sync_pack');
        mock.pick = null;
        return pick;
      }
      const pick = mock.pick ?? (exts.includes('srt') ? `${FIXTURE}.srt` : `${FIXTURE}.mp4`);
      mock.pick = null;
      return pick;
    }
    case 'plugin:fs|exists': {
      if (cache.has(args.path)) return true;
      const clipPrefix = `${OWN}/clips/`;
      if (typeof args.path === 'string' && args.path.startsWith(clipPrefix) && args.path.slice(clipPrefix.length) in loadObj(SYNC_CLIPS_KEY)) return true;
      return (await fetch(fsUrl(args.path), { method: 'HEAD' })).ok;
    }
    case 'plugin:fs|read_file': {
      // anki_* = a batch's cuts for Anki (utils/ankiExport.ts); cut_clip makes no file here, so hand back a few bytes.
      if (/\/clips\/anki_[^/]+$/.test(args.path)) return new Uint8Array([1, 2, 3, 4]).buffer;
      const clipPrefix = `${OWN}/clips/`;
      if (typeof args.path === 'string' && args.path.startsWith(clipPrefix)) {
        const clipBody = loadObj<Record<string, string>>(SYNC_CLIPS_KEY)[args.path.slice(clipPrefix.length)];
        if (clipBody != null) return new TextEncoder().encode(clipBody).buffer;
      }
      if (typeof args.path === 'string') {
        const jsonPack = loadObj<Record<string, string>>('__mock_sync_json_packs')[args.path];
        if (jsonPack != null) return new TextEncoder().encode(jsonPack).buffer;
      }
      const ja = /^\/__ja-dict\/([\w.]+)$/.exec(args.path);
      const res = await fetch(ja ? `/node_modules/kuromoji/dict/${ja[1]}` : fsUrl(args.path));
      if (!res.ok) throw new Error(`mock fs: ${res.status} ${args.path}`);
      const buf = await res.arrayBuffer();
      // vite sends .gz files with Content-Encoding: gzip, so the browser has
      // already unpacked them; pack again to hand over what is on disk.
      if (!ja || new Uint8Array(buf)[0] === 0x1f) return buf;
      return new Response(new Blob([buf]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
    }
    case 'ja_dict_status':
      return { installed: mock.jaDict, dir: '/__ja-dict', bytes: 18_792_000 };
    case 'install_ja_dict':
      for (let pct = 0; pct < 100; pct += 20) {
        await emit('ja-dict-progress', pct);
        await new Promise(r => setTimeout(r, 300));
      }
      mock.jaDict = true;
      return null;
    case 'convert_tool_status': {
      const dir = `${__DEV_HOME__}/Library/Application Support/com.linguaclip.app/convert`;
      return { path: mock.convertTool ? `${dir}/ffmpeg` : null, dir, bytes: 28_395_699 };
    }
    case 'install_convert_tool':
      for (let pct = 0; pct < 100; pct += 20) {
        await emit('convert-tool-progress', pct);
        await new Promise(r => setTimeout(r, 300));
      }
      mock.convertTool = true;
      return null;
    case 'youtube_tool_status': {
      const dir = `${__DEV_HOME__}/Library/Application Support/com.linguaclip.app/youtube`;
      return { ready: mock.youtubeTool, path: mock.youtubeTool ? `${dir}/yt-dlp` : null, dir, bytes: mock.youtubeTool ? 0 : 104_644_070 };
    }
    case 'install_youtube_tool':
      for (let pct = 0; pct < 100; pct += 20) {
        await emit('youtube-tool-progress', pct);
        await new Promise(r => setTimeout(r, 300));
      }
      mock.youtubeTool = true;
      return null;
    case 'open_youtube_window':
      mock.youtubeWindow = args;
      return null;
    case 'youtube_pick_done':
      mock.youtubePicksDone.push(args);
      return null;
    case 'probe_video':
      if (!mock.convertTool) throw 'missing:ffmpeg';
      return mock.probe;
    // Nothing is cut here: files named like the real ones can be made by hand in ~/Movies/LinguaClip/clips.
    case 'cut_clip': {
      if (mock.clipFail) throw mock.clipFail;
      const res = args.kind === 'video' ? { file: `${args.name}.mp4`, image: null } : { file: `${args.name}.m4a`, image: `${args.name}.jpg` };
      const clips = loadObj<Record<string, string>>(SYNC_CLIPS_KEY);
      clips[res.file] = `mock-clip:${res.file}`;
      if (res.image) clips[res.image] = `mock-clip:${res.image}`;
      saveObj(SYNC_CLIPS_KEY, clips);
      return res;
    }
    case 'sweep_clips':
      return 0;
    case 'clips_info':
      return { dir: `${__DEV_HOME__}/Movies/LinguaClip/clips`, bytes: 1_234_567 };
    case 'remove_ja_dict':
      mock.jaDict = false;
      return null;
    case 'plugin:fs|read_text_file': {
      const hit = cache.get(args.path);
      if (hit != null) return new TextEncoder().encode(hit).buffer;
      const packHit = loadObj<Record<string, SyncPack>>(SYNC_PACKS_KEY)[args.path];
      if (packHit && typeof packHit.snapshotJson === 'string') return new TextEncoder().encode(packHit.snapshotJson).buffer;
      const res = await fetch(fsUrl(args.path));
      if (!res.ok) throw new Error(`mock fs: ${res.status} ${args.path}`);
      return res.arrayBuffer();
    }
    case 'plugin:path|resolve_directory':
      return __DEV_HOME__; // only homeDir() is used
    case 'plugin:path|join':
      return (args.paths as string[]).join('/').replace(/\/+/g, '/');
    case 'write_cache':
      cache.set(`${__DEV_HOME__}/Movies/LinguaClip/${args.id}.${args.kind}.json`, args.text);
      return null;
    case 'plugin:opener|open_url':
      window.open(args.url, '_blank');
      return null;
    case 'plugin:opener|reveal_item_in_dir':
      return null; // recorded in __MOCK__.calls
    case 'transcribe_location': {
      const dir = `${__DEV_HOME__}/Library/Application Support/com.linguaclip.app/whisper`;
      const file = args.model === 'light' ? 'ggml-small-q5_1.bin' : 'ggml-large-v3-turbo-q5_0.bin';
      return { dir, model: mock.tools.whisper ? `${dir}/${file}` : null };
    }
    case 'list_gpus':
      return mock.gpus;
    case 'device_info':
      return mock.device;
    case 'trash_file':
      return null; // recorded in __MOCK__.calls; real files untouched
    case 'tts':
      return mock.tts ? mock.tts(args) : null;
    case 'anki_request': {
      const res = await fetch(args.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: args.body });
      const text = await res.text();
      if (!res.ok) throw `HTTP ${res.status}: ${text.slice(0, 120) || '(empty body)'}`;
      return text;
    }
    case 'import_tools':
      return mock.tools;
    case 'plugin:window|is_fullscreen':
      return !!document.fullscreenElement;
    case 'plugin:window|set_fullscreen':
      // Headless browsers refuse page fullscreen; the call is still in __MOCK__.calls.
      await (args.value ? document.documentElement.requestFullscreen() : document.exitFullscreen()).catch(() => {});
      return null;
    case 'probe_import_sizes':
      return { '1080': null, '720': null, '480': null };
    case 'plugin:app|version':
      return '0.2.1';
    case 'plugin:updater|check': {
      await new Promise(r => setTimeout(r, 600));
      if (mock.update === 'fail') throw new Error('network');
      return mock.update && { rid: 1, currentVersion: '0.2.1', version: mock.update.version, body: mock.update.body, rawJson: {} };
    }
    case 'plugin:updater|download': {
      const send = (m: unknown) => args.onEvent?.onmessage?.(m);
      const total = 7_000_000;
      send({ event: 'Started', data: { contentLength: total } });
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 150));
        if (mock.updateFail === 'download' && i === 8) throw new Error('connection reset');
        send({ event: 'Progress', data: { chunkLength: total / 20 } });
      }
      send({ event: 'Finished' });
      return 2;
    }
    case 'plugin:updater|install':
      if (mock.updateFail === 'install') throw new Error('install failed');
      return null;
    case 'plugin:process|restart':
      location.reload();
      return null;
    case 'android_paths':
      return { ownDir: OWN, mediaDir: `${OWN}/media`, clipsDir: `${OWN}/clips`, tmpDir: `${OWN}/tmp` };
    case 'plan_wav_cuts':
      return [{ index: 0, fromSample: 0, toSample: 16000, offsetMs: 0 }];
    case 'transcribe_prepared_pieces':
    case 'transcribe_finalize':
      return { subtitleText: '1\n00:00:00,000 --> 00:00:01,000\nMock line\n', words: [] };
    case 'transcribe_plan':
      return { planId: 'mock-plan', lang: args.lang ?? 'en', pieceSecs: 3600, wavSamples: 16000, pieces: [{ index: 0, fromSample: 0, toSample: 16000, offsetMs: 0 }], doneIndices: [] };
    case 'transcribe_piece':
      return true;
    case 'download_podcast_audio':
    case 'download_podcast_audio_stream':
      return `${OWN}/media/${args.id ?? 'mock'}.mp3`;
    case 'android_cancel_job':
      return null;
    case 'android_purge_files':
    case 'android_sweep_orphans':
      return 0;
    case 'sync_webdav_test': {
      const remoteRoot = checkSyncCfg(args.config);
      const store = loadObj<Record<string, unknown>>(SYNC_FILES_KEY);
      const existingDevices = Object.keys(store).filter(k => k.startsWith('devices/') && k.endsWith('.json.gz') && !k.slice(8).includes('/')).length;
      return { ok: true, remoteRoot, existingDevices };
    }
    case 'sync_webdav_list': {
      checkSyncCfg(args.config);
      const sub = String(args.subpath ?? '');
      if (!SYNC_SUBS.has(sub)) throw `sync:invalid_path:${sub}`;
      const prefix = `${sub}/`;
      const store = loadObj<Record<string, unknown>>(SYNC_FILES_KEY);
      return Object.entries(store).flatMap(([k, raw]) => {
        if (!k.startsWith(prefix)) return [];
        const name = k.slice(prefix.length);
        if (!name || name.includes('/')) return [];
        const entry = syncEntryOf(raw);
        return entry ? [{ name, etag: entry.etag, size: entry.size }] : [];
      });
    }
    case 'sync_webdav_get_gz': {
      checkSyncCfg(args.config, true);
      const rel = String(args.relPath ?? '');
      checkRelPath(rel);
      if (!rel.endsWith('.gz')) throw `sync:invalid_path:${rel}`;
      const entry = syncEntryOf(loadObj<Record<string, unknown>>(SYNC_FILES_KEY)[rel]);
      if (!entry) throw 'sync:notfound';
      return entry.content;
    }
    case 'sync_webdav_put_gz': {
      checkSyncCfg(args.config);
      const rel = String(args.relPath ?? '');
      checkRelPath(rel);
      if (!rel.endsWith('.gz')) throw `sync:invalid_path:${rel}`;
      const content = String(args.content ?? '');
      const etag = nextEtag();
      const store = loadObj<Record<string, SyncFile>>(SYNC_FILES_KEY);
      store[rel] = { content, etag, size: byteLen(content) };
      saveObj(SYNC_FILES_KEY, store);
      return etag;
    }
    case 'sync_webdav_delete': {
      checkSyncCfg(args.config);
      const rel = String(args.relPath ?? '');
      checkRelPath(rel);
      const store = loadObj<Record<string, unknown>>(SYNC_FILES_KEY);
      delete store[rel];
      saveObj(SYNC_FILES_KEY, store);
      return null;
    }
    case 'sync_upload_clip_pack': {
      checkSyncCfg(args.config);
      const rel = String(args.relPath ?? '');
      checkRelPath(rel);
      if (!rel.startsWith('clip-packs/')) throw `sync:invalid_path:${rel}`;
      const maxBytes = typeof args.maxBytes === 'number' ? args.maxBytes : 10 * 1024 * 1024;
      const maxFile = typeof args.maxFileBytes === 'number' ? args.maxFileBytes : 1_572_864;
      const localClips = loadObj<Record<string, string>>(SYNC_CLIPS_KEY);
      const packed: string[] = [];
      const packMap: Record<string, string> = {};
      let total = 0;
      for (const name of new Set<string>(args.files ?? [])) {
        checkClipName(name);
        if (!(name in localClips)) continue;
        const body = localClips[name];
        const sz = byteLen(body);
        if (sz > maxFile || total + sz > maxBytes) continue;
        total += sz;
        packed.push(name);
        packMap[name] = body;
      }
      if (!packed.length) return [];
      const body = JSON.stringify(packMap);
      const store = loadObj<Record<string, SyncFile>>(SYNC_FILES_KEY);
      store[rel] = { content: body, etag: nextEtag(), size: byteLen(body) };
      saveObj(SYNC_FILES_KEY, store);
      return packed;
    }
    case 'sync_download_clip_pack': {
      checkSyncCfg(args.config);
      const rel = String(args.relPath ?? '');
      checkRelPath(rel);
      if (!rel.startsWith('clip-packs/')) throw `sync:invalid_path:${rel}`;
      const wanted = new Set<string>();
      for (const n of (args.wantedFiles ?? []) as string[]) { checkClipName(n); wanted.add(n); }
      if (!wanted.size) return [];
      const entry = syncEntryOf(loadObj<Record<string, unknown>>(SYNC_FILES_KEY)[rel]);
      if (!entry) throw 'sync:notfound';
      let packMap: Record<string, string>;
      try { packMap = JSON.parse(entry.content); } catch { throw 'sync:corrupt:bad_zip'; }
      const localClips = loadObj<Record<string, string>>(SYNC_CLIPS_KEY);
      const extracted: string[] = [];
      for (const [name, body] of Object.entries(packMap)) {
        if (wanted.has(name) && typeof body === 'string') { localClips[name] = body; extracted.push(name); }
      }
      saveObj(SYNC_CLIPS_KEY, localClips);
      return extracted;
    }
    case 'sync_write_merge_pack': {
      const dest = args.dest ? String(args.dest) : `${OWN}/tmp/exports/mock-${Date.now()}/LinguaClip-sync-${stamp(new Date(), false)}.zip`;
      const subs: [string, string][] = [];
      const seenSub = new Set<string>();
      for (const [hash, srt] of (args.subs ?? []) as [string, string][]) {
        if (!VALID_SHA.test(hash)) throw `sync:invalid_path:subs/${hash}.srt.gz`;
        if (!seenSub.has(hash)) { seenSub.add(hash); subs.push([hash, String(srt)]); }
      }
      const localClips = loadObj<Record<string, string>>(SYNC_CLIPS_KEY);
      const clips: Record<string, string> = {};
      for (const name of new Set<string>(args.clipFiles ?? [])) {
        checkClipName(name);
        if (name in localClips) clips[name] = localClips[name];
      }
      const packs = loadObj<Record<string, SyncPack>>(SYNC_PACKS_KEY);
      packs[dest] = { snapshotJson: String(args.snapshotJson ?? ''), subs, clips };
      saveObj(SYNC_PACKS_KEY, packs);
      return dest;
    }
    case 'sync_write_merge_json': {
      const dest = args.dest ? String(args.dest) : `${OWN}/tmp/exports/mock-${Date.now()}/LinguaClip-sync-${stamp(new Date(), false)}.json`;
      const jsonPacks = loadObj<Record<string, string>>('__mock_sync_json_packs');
      jsonPacks[dest] = String(args.content ?? '');
      saveObj('__mock_sync_json_packs', jsonPacks);
      return dest;
    }
    case 'sync_read_merge_pack': {
      const pack = loadObj<Record<string, SyncPack>>(SYNC_PACKS_KEY)[String(args.path ?? '')];
      if (!pack) throw 'sync:io:not found';
      if (typeof pack.snapshotJson !== 'string') throw 'sync:corrupt:missing_sync_json';
      return { snapshotJson: pack.snapshotJson, subs: pack.subs ?? [], clipNames: Object.keys(pack.clips ?? {}) };
    }
    case 'sync_unpack_merge_pack': {
      const pack = loadObj<Record<string, SyncPack>>(SYNC_PACKS_KEY)[String(args.path ?? '')];
      if (!pack) throw 'sync:io:not found';
      const wanted = new Set<string>();
      for (const n of (args.wantedFiles ?? []) as string[]) { checkClipName(n); wanted.add(n); }
      if (!wanted.size) return [];
      const localClips = loadObj<Record<string, string>>(SYNC_CLIPS_KEY);
      const extracted: string[] = [];
      for (const [name, body] of Object.entries(pack.clips ?? {})) {
        if (wanted.has(name) && typeof body === 'string') { localClips[name] = body; extracted.push(name); }
      }
      saveObj(SYNC_CLIPS_KEY, localClips);
      return extracted;
    }
    case 'sync_rekey_files': {
      const fromId = String(args.fromId ?? ''), toId = String(args.toId ?? '');
      if (!VALID_ID.test(fromId) || !VALID_ID.test(toId)) throw 'sync:invalid_id';
      if (fromId === toId) return { moved: 0, mediaPaths: [] };
      let moved = 0;
      for (const kind of REKEY_KINDS) {
        const src = `${OWN}/${fromId}.${kind}.json`, dst = `${OWN}/${toId}.${kind}.json`;
        if (cache.has(src) && !cache.has(dst)) { cache.set(dst, cache.get(src)!); cache.delete(src); moved++; }
      }
      return { moved, mediaPaths: [] };
    }
    default:
      // start_import, open_youtube_login, window chrome… nothing to do in a browser
      return null;
  }
}

mockWindows('main');
mockIPC(
  (cmd, args) => {
    mock.calls.push({ cmd, args });
    return handle(cmd, (args ?? {}) as Args);
  },
  { shouldMockEvents: true },
);
(window as any).__TAURI_INTERNALS__.convertFileSrc = fsUrl;

// Cross-origin requests go through vite's /__proxy (see vite.config.ts).
export const fetch: typeof window.fetch = (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!/^https?:\/\//.test(url) || url.startsWith(location.origin)) return window.fetch(input, init);
  const headers = new Headers(init?.headers);
  headers.set('x-proxy-url', url);
  // One address for every target: the browser's cache would hand one feed back for all.
  return window.fetch('/__proxy', { ...init, headers, cache: 'no-store' });
};
