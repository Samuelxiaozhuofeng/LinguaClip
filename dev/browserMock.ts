/**
 * Browser-only stand-in for the Tauri shell, so `npm run dev` can be clicked
 * through in a normal browser. Never loaded inside Tauri or in a release build.
 *
 * - Local files are served by vite's /@fs route (allow-list in vite.config.ts).
 * - File dialogs return `window.__MOCK__.pick` if set, else a fixture clip.
 * - `window.__MOCK__.tools` sets what import_tools reports (both false by default).
 * - `window.__MOCK__.convertTool`: is the video converter "downloaded" (false by
 *   default); `window.__MOCK__.probe` = what probe_video reports for any file.
 * - `window.__MOCK__.jaDict`: is the Japanese dictionary "downloaded" (false by
 *   default); its files are served from node_modules/kuromoji/dict.
 * - `window.__MOCK__.update = { version, body }` fakes a newer release (null = up to
 *   date, 'fail' = no connection); `updateFail = 'download' | 'install'` fakes that step failing.
 * - Rust commands are logged to `window.__MOCK__.calls`; fake import progress
 *   with `window.__MOCK__.emit('import-progress', {...})`.
 * - vite aliases @tauri-apps/plugin-http to this file, hence the `fetch` export;
 *   cross-origin calls (AI endpoints, AnkiConnect) are relayed by vite.
 */
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';

declare const __DEV_HOME__: string;

const FIXTURE = `${__DEV_HOME__}/Movies/LinguaClip/Me at the zoo [jNQXAC9IVRw]`;
const fsUrl = (path: string) => '/@fs' + path.split('/').map(encodeURIComponent).join('/');
const cache = new Map<string, string>(); // write_cache stays in memory

type Args = Record<string, any>;

const mock = {
  pick: null as string | null,
  // set to (args) => ArrayBuffer to fake Edge TTS; unset = null = system voice
  tts: null as ((args: Args) => unknown) | null,
  calls: [] as { cmd: string; args: unknown }[],
  // what import_tools reports; default = a stranger's Mac with nothing installed
  tools: { whisper: false, youtube: false },
  jaDict: false,
  convertTool: false,
  // device_info: set another id to act as a second computer (license seats)
  device: { id: 'browser-dev-device-0001', name: 'Browser (dev)' },
  clipFail: null as string | null, // set to make cut_clip fail with this message
  probe: { duration: 19, video: 'h264', audio: 'ac3', subtitles: [] as unknown[] },
  update: null as null | 'fail' | { version: string; body: string },
  updateFail: null as null | 'download' | 'install',
  emit,
};
(window as any).__MOCK__ = mock;

async function handle(cmd: string, args: Args): Promise<unknown> {
  switch (cmd) {
    case 'plugin:dialog|open': {
      const exts: string[] = args.options?.filters?.[0]?.extensions ?? [];
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
  return window.fetch('/__proxy', { ...init, headers });
};
