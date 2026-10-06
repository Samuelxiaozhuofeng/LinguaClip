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

const mock = {
  pick: null as string | null,
  // set to (args) => ArrayBuffer to fake Edge TTS; unset = null = system voice
  tts: null as ((args: Args) => unknown) | null,
  calls: [] as { cmd: string; args: unknown }[],
  // what import_tools reports; default = a stranger's Mac with nothing installed
  tools: { whisper: false, youtube: false },
  jaDict: false,
  convertTool: false,
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
      sessionStorage.setItem('__mock_last_saved', pick);
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
      const exts: string[] = args.options?.filters?.[0]?.extensions ?? [];
      if (args.options?.filters?.[0]?.name === 'LinguaClip') { // a backup (utils/desktop.ts pickBackupFile)
        const pick = mock.pick ?? sessionStorage.getItem('__mock_last_saved');
        mock.pick = null;
        return pick;
      }
      const pick = mock.pick ?? (exts.includes('srt') ? `${FIXTURE}.srt` : `${FIXTURE}.mp4`);
      mock.pick = null;
      return pick;
    }
    case 'plugin:fs|exists':
      if (cache.has(args.path)) return true;
      return (await fetch(fsUrl(args.path), { method: 'HEAD' })).ok;
    case 'plugin:fs|read_file': {
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
    case 'probe_video':
      if (!mock.convertTool) throw 'missing:ffmpeg';
      return mock.probe;
    // Nothing is cut here: files named like the real ones can be made by hand in ~/Movies/LinguaClip/clips.
    case 'cut_clip':
      if (mock.clipFail) throw mock.clipFail;
      return args.kind === 'video' ? { file: `${args.name}.mp4`, image: null } : { file: `${args.name}.m4a`, image: `${args.name}.jpg` };
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
