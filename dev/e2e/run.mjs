// Runs the browser regression flows (dev/e2e/README.md): node dev/e2e/run.mjs
// Playwright lives in ~/.cache/linguaclip-e2e (installed on first run), never in the project.
import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import practice from './practice.mjs';
import watch from './watch.mjs';
import persist from './persist.mjs';
import backup from './backup.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PW_DIR = path.join(os.homedir(), '.cache/linguaclip-e2e');
// The clip dev/browserMock.ts hands to every file dialog.
const SAMPLE = path.join(os.homedir(), 'Movies/LinguaClip/Me at the zoo [jNQXAC9IVRw]');
const OUT = mkdtempSync(path.join(os.tmpdir(), 'linguaclip-e2e-'));
const FLOWS = [...practice, ...watch, ...persist, ...backup];

for (const f of [`${SAMPLE}.mp4`, `${SAMPLE}.srt`]) {
  if (!existsSync(f)) { console.error(`缺样片：${f}`); process.exit(1); }
}

if (!existsSync(path.join(PW_DIR, 'node_modules/playwright'))) {
  console.log(`首次运行：把 Playwright 装到 ${PW_DIR}…`);
  mkdirSync(PW_DIR, { recursive: true });
  if (!existsSync(path.join(PW_DIR, 'package.json'))) writeFileSync(path.join(PW_DIR, 'package.json'), '{ "private": true }\n');
  execSync('npm i playwright --no-audit --no-fund', { cwd: PW_DIR, stdio: 'inherit' });
}
const { chromium } = createRequire(path.join(PW_DIR, 'package.json'))('playwright');

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

let server = null; // the vite this script started (and so must stop)
const stopServer = () => {
  if (!server) return;
  try { process.kill(-server.pid, 'SIGTERM'); } catch { /* already gone */ }
  server = null;
};
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopServer(); process.exit(130); });

let url = 'http://127.0.0.1:3000/';
if (await isOurs(url)) {
  console.log(`复用已在跑的 dev 服务：${url}`);
} else {
  const port = (await portFree(3000)) ? 3000 : await anyPort();
  url = `http://127.0.0.1:${port}/`;
  const log = path.join(OUT, 'vite.log');
  if (port !== 3000) console.log('3000 端口被别的程序占着（不是 LinguaClip），改用 ' + port);
  server = spawn('npm', ['run', 'dev', '--', '--port', String(port), '--strictPort'], { cwd: ROOT, detached: true, stdio: ['ignore', openSync(log, 'w'), openSync(log, 'a')] });
  const until = Date.now() + 60_000;
  while (!(await isOurs(url))) {
    if (Date.now() > until || server.exitCode !== null) { console.error(`dev 服务没起来，日志：${log}`); stopServer(); process.exit(1); }
    await new Promise(r => setTimeout(r, 300));
  }
  console.log(`已启动 dev 服务：${url}（跑完自动关）`);
}

const results = [];
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
  // A fresh profile every run: empty IndexedDB / localStorage, nothing carried over.
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(15_000);
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto(url);
  // Helpers every flow uses: wait for what the user would see, with a plain message when it never shows.
  const see = async (loc, what, timeout) => { await loc.first().waitFor({ state: 'visible', timeout }).catch(() => { throw new Error(`没看到：${what}`); }); };
  const gone = async (loc, what, timeout) => { await loc.first().waitFor({ state: 'hidden', timeout }).catch(() => { throw new Error(`应该消失却还在：${what}`); }); };
  const nav = name => page.getByRole('navigation').getByRole('button', { name: new RegExp(`^${name}`) }).click();
  const ctx = { page, sample: SAMPLE, see, gone, nav };
  let broken = null;
  for (const [i, flow] of FLOWS.entries()) {
    const name = `${i + 1}. ${flow.name}`;
    if (broken) { results.push({ name, status: 'SKIP', note: `前面「${broken}」失败，这步依赖它` }); continue; }
    process.stdout.write(`… ${name}\n`);
    try {
      await flow.run(ctx);
      results.push({ name, status: 'PASS' });
    } catch (e) {
      const shot = path.join(OUT, `fail-${i + 1}.png`);
      await page.screenshot({ path: shot }).catch(() => {});
      results.push({ name, status: 'FAIL', note: `${String(e.message ?? e).split('\n')[0]}\n     截图：${shot}` });
      broken = flow.name;
    }
  }
  if (pageErrors.length) console.log(`\n页面报错（${pageErrors.length}）：\n  ${pageErrors.slice(0, 5).join('\n  ')}`);
} finally {
  await browser?.close().catch(() => {});
  stopServer();
}

console.log('\n结果：');
for (const r of results) console.log(`  ${r.status.padEnd(4)}  ${r.name}${r.note ? `\n     ${r.note}` : ''}`);
const bad = results.filter(r => r.status !== 'PASS').length;
console.log(bad ? `\n${bad} 项没过（输出目录 ${OUT}）` : `\n全部通过（${results.length} 项）`);
process.exit(bad ? 1 : 0);
