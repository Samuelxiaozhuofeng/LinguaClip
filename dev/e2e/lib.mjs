// What every browser test needs, for the regression (run.mjs) and for one-off scripts written in
// a scratchpad (dev/e2e/README.md「临时脚本」): Playwright from ~/.cache/linguaclip-e2e (installed on
// first use, never in the project), a dev server, a fresh Chrome page, records put straight into the DB.
import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PW_DIR = path.join(os.homedir(), '.cache/linguaclip-e2e');
// Paths without the extension. SAMPLE (.mp4 + .srt) is the clip dev/browserMock.ts hands to every
// file dialog; AUDIO (.mp3 + .srt) is a podcast episode for the listening page.
export const SAMPLE = path.join(os.homedir(), 'Movies/LinguaClip/Me at the zoo [jNQXAC9IVRw]');
export const AUDIO = path.join(os.homedir(), 'Movies/LinguaClip/¿Quien quiere, puede [fe5743fc]');

const playwright = () => {
  if (!existsSync(path.join(PW_DIR, 'node_modules/playwright'))) {
    console.log(`首次运行：把 Playwright 装到 ${PW_DIR}…`);
    mkdirSync(PW_DIR, { recursive: true });
    if (!existsSync(path.join(PW_DIR, 'package.json'))) writeFileSync(path.join(PW_DIR, 'package.json'), '{ "private": true }\n');
    execSync('npm i playwright --no-audit --no-fund', { cwd: PW_DIR, stdio: 'inherit' });
  }
  return createRequire(path.join(PW_DIR, 'package.json'))('playwright');
};

// Our vite serves the browser mock; anything else on the port is someone else's server.
const isOurs = async url => {
  try {
    const r = await fetch(url + 'dev/browserMock.ts', { signal: AbortSignal.timeout(2000) });
    return r.ok && (await r.text()).includes('__MOCK__');
  } catch { return false; }
};
const portFree = port => new Promise(res => {
  const s = createServer().once('error', () => res(false)).listen(port, '127.0.0.1', () => s.close(() => res(true)));
});
const anyPort = () => new Promise(res => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

// The dev server on 3000 if it is already LinguaClip's, else one of our own (3000, or any free
// port when something else holds it) that `stop` shuts down. Its log goes to `out`/vite.log.
const startServer = async out => {
  let url = 'http://127.0.0.1:3000/';
  if (await isOurs(url)) { console.log(`复用已在跑的 dev 服务：${url}`); return { url, stop: () => {} }; }
  const port = (await portFree(3000)) ? 3000 : await anyPort();
  url = `http://127.0.0.1:${port}/`;
  const log = path.join(out, 'vite.log');
  if (port !== 3000) console.log('3000 端口被别的程序占着（不是 LinguaClip），改用 ' + port);
  let server = spawn('npm', ['run', 'dev', '--', '--port', String(port), '--strictPort'], { cwd: ROOT, detached: true, stdio: ['ignore', openSync(log, 'w'), openSync(log, 'a')] });
  const stop = () => {
    if (!server) return;
    try { process.kill(-server.pid, 'SIGTERM'); } catch { /* already gone */ }
    server = null;
  };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stop(); process.exit(130); });
  const until = Date.now() + 60_000;
  while (!(await isOurs(url))) {
    if (Date.now() > until || server.exitCode !== null) { stop(); throw new Error(`dev 服务没起来，日志：${log}`); }
    await new Promise(r => setTimeout(r, 300));
  }
  console.log(`已启动 dev 服务：${url}（跑完自动关）`);
  return { url, stop };
};

// A fresh Chrome profile on the app's home page (empty IndexedDB / localStorage, Chinese UI).
// `out`: where the vite log and your screenshots go. Always `await close()` at the end.
export async function open(out = mkdtempSync(path.join(os.tmpdir(), 'linguaclip-e2e-'))) {
  const { chromium } = playwright();
  const { url, stop } = await startServer(out);
  // System Chrome: it has H.264, so the sample mp4 plays.
  const browser = await chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] }).catch(e => { stop(); throw e; });
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(15_000);
  const errors = []; // uncaught errors in the page
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url);
  // Wait for what the user would see, with a plain message when it never shows.
  const see = async (loc, what, timeout) => { await loc.first().waitFor({ state: 'visible', timeout }).catch(() => { throw new Error(`没看到：${what}`); }); };
  const gone = async (loc, what, timeout) => { await loc.first().waitFor({ state: 'hidden', timeout }).catch(() => { throw new Error(`应该消失却还在：${what}`); }); };
  const nav = name => page.getByRole('navigation').getByRole('button', { name: new RegExp(`^${name}`) }).click();
  const close = async () => { await browser.close().catch(() => {}); stop(); };
  return { page, url, out, errors, sample: SAMPLE, see, gone, nav, close };
}

// A practice record for the media at `base` + `ext` with `base`.srt beside it. `over`: any
// VideoRecord fields — `podcast: { show, feed, guid, name }` puts it on the 播客 page.
export const record = (base, ext, over = {}) => {
  for (const f of [base + ext, base + '.srt']) if (!existsSync(f)) throw new Error(`缺样片：${f}`);
  const subtitleText = readFileSync(base + '.srt', 'utf8'), name = path.basename(base);
  return {
    id: name, displayName: name, videoFileName: name + ext, subtitleFileName: name + '.srt', subtitleText, videoPath: base + ext,
    currentSubtitleIndex: 0, currentSectionIndex: 0, totalSubtitles: (subtitleText.match(/-->/g) ?? []).length, completionRate: 0,
    dateAdded: Date.now(), lastPracticed: Date.now(), totalPracticeTime: 0, ...over,
  };
};

// Skip the add-video dialog: write records (and localStorage values, objects as JSON) into the
// page, then reload so the home page shows them.
export async function seed(page, records, storage = {}) {
  await page.evaluate(async ({ records, storage }) => {
    for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
    const { saveVideoToDB } = await import('/utils/fileSystemAccess.ts');
    for (const r of records) await saveVideoToDB(r);
  }, { records, storage });
  await page.reload();
}
