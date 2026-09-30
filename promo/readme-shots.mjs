// README screenshots: drive the real app (browser dev, English UI) and save PNGs to ../assets/readme/.
// Run: npm run dev (repo root), then `node readme-shots.mjs <port> [stopAfterStep]`.
// AI goes to 9router (key read at runtime, never written anywhere). Clips are hardlinked into media/ (gitignored).
import { chromium } from 'playwright';
import fs from 'fs';
import os from 'os';

const PORT = process.argv[2] || '3000';
const STOP = process.argv[3];
const OUT = '../assets/readme';
const MEDIA = `${process.cwd()}/media`;
const conn = fs.readFileSync(`${os.homedir()}/Downloads/9router-public-connection.txt`, 'utf8');
const AI = { baseUrl: conn.match(/Base URL:\s*(\S+)/)[1], apiKey: conn.match(/API Key:\s*(\S+)/)[1], model: 'cpa/gemini-3.1-flash-lite' };

fs.mkdirSync(OUT, { recursive: true });
const b = await chromium.launch({ channel: 'chrome' });
const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2, locale: 'en-US' });
const p = await ctx.newPage();
if (process.argv[4]) p.setDefaultTimeout(10000);
let bdPoints = null; // the AI's breakdown for the current line, sniffed so the script can type the right answer
p.on('response', async r => { if (!r.url().includes('__proxy')) return;
  try { const t = await r.text(); const c = JSON.parse(t.slice(0, t.lastIndexOf('}', t.indexOf('data:') > 0 ? t.indexOf('data:') : t.length) + 1)).choices[0].message.content; const m = c.match(/\{[\s\S]*\}/); const j = JSON.parse(m[0]); if (j.points) bdPoints = j.points; if (process.env.DBG) console.log('AI', c.slice(0, 600)); } catch (e) { if (process.env.DBG) console.log('AIERR', e.message); } });
p.on('pageerror', e => console.log('PAGEERR', e.message));
const shot = (name, h) => p.screenshot({ path: `${OUT}/${name}.png`, ...(h && { clip: { x: 0, y: 0, width: 1440, height: h } }) });
const btn = (name, o) => p.getByRole('button', { name, ...o });
const wait = ms => p.waitForTimeout(ms);
const dump = async tag => console.log(`--- ${tag}\n`, (await p.evaluate(() => document.body.innerText)).slice(0, 1500),
  '\nBUTTONS:', (await p.evaluate(() => [...document.querySelectorAll('button,[role=radio]')].map(x => x.getAttribute('aria-label') || x.innerText.trim()).filter(Boolean).join(' | '))).slice(0, 1500));
let started = !process.argv[4]; // optional 3rd arg: skip steps before this one (only for steps that need no earlier state)
const step = async (name, fn) => { if (name === process.argv[4]) started = true; if (started) await fn(); if (STOP === name) { await dump(name); await b.close(); process.exit(0); } };

await p.goto(`http://localhost:${PORT}`);
await p.evaluate(ai => { localStorage.setItem('linguaclip_lang', 'en'); localStorage.setItem('linguaclip_ai_config', JSON.stringify(ai)); }, AI);
await p.reload();
await wait(1000);

const addVideo = async (name, ext = 'mp4', snap) => {
  await btn('Add video').first().click();
  await wait(400);
  await p.evaluate(f => { window.__MOCK__.pick = f; }, `${MEDIA}/${name}.${ext}`);
  await btn(/Choose a video/).click();
  await wait(300);
  if (snap) { await p.getByRole('combobox').first().selectOption({ label: 'Spanish' }).catch(e => console.log('lang', e.message)); await wait(200); await shot(snap); }
  await p.evaluate(f => { window.__MOCK__.pick = f; }, `${MEDIA}/${name}.srt`);
  await btn('Choose subtitles').click();
  await wait(400);
  await btn('Start practising').click();
  await wait(2000);
};

await step('add', async () => {
  await addVideo("I'm Tired of Pretending");
  await btn('Cancel').last().click(); await wait(300);
  await addVideo('Comida china en México');
  await btn('Cancel').last().click(); await wait(300);
  await addVideo('Ella vende pan de su país', 'mp4', 'add');
});
await step('mode', async () => { await shot('mode'); });
await step('home', async () => { await btn('Cancel').last().click(); await wait(600); await shot('home', 880); });
await step('practice', async () => {
  await btn(/Continue · Dictate/).first().click(); await wait(500);
  await btn('Start').last().click(); await wait(1500);
  await shot('listening');
  await p.locator('form input').first().waitFor({ timeout: 30000 });
  await wait(400);
  await shot('typing');
});
// Type word by word; a correct word jumps to the next blank by itself, a wrong one needs Space.
const typeWords = async (words, snapAt, snapName) => {
  for (let i = 0; i < words.length; i++) {
    await p.keyboard.type(words[i], { delay: 30 });
    await wait(300);
    const moved = await p.evaluate(() => document.activeElement.value === '');
    if (!moved && i < words.length - 1) { await p.keyboard.press('Space'); await wait(150); }
    if (i === snapAt) await shot(snapName);
  }
};
const gotoLine = async n => { await btn(`Line ${n} / 87`).click(); await p.locator('form input').first().waitFor({ timeout: 30000 }); await wait(400); };
// Demo GIF: grab frames as fast as they come (with timestamps) while one line plays, gets typed and checked.
await step('demo', async () => {
  const dir = 'readme-frames'; fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir);
  const frames = []; let rec = true;
  const loop = (async () => { while (rec) { const f = `${dir}/${String(frames.length).padStart(4, '0')}.png`; await p.screenshot({ path: f, scale: 'css' }); frames.push({ f, t: Date.now() }); } })();
  await btn('Line 6 / 87').click();
  await p.locator('form input').first().waitFor({ timeout: 30000 }); await wait(500);
  for (const w of 'Y panes auténticos de Australia'.split(' ')) { await p.keyboard.type(w, { delay: 90 }); await wait(350); }
  await wait(400); await p.keyboard.press('Enter'); await wait(2800);
  rec = false; await loop;
  const lines = frames.map((x, i) => `file '${x.f.split('/')[1]}'\nduration ${(((frames[i + 1]?.t ?? x.t + 1500) - x.t) / 1000).toFixed(3)}`);
  fs.writeFileSync(`${dir}/list.txt`, lines.join('\n') + `\nfile '${frames.at(-1).f.split('/')[1]}'\n`);
  console.log('frames', frames.length);
});
await step('feedback', async () => {
  await gotoLine(4);
  await typeWords('Miren así se ve como verde lagos muy bonito'.split(' '), 3, 'typing');
  await p.keyboard.press('Enter'); await wait(900);
  await shot('feedback');
});
await step('lookup', async () => {
  await btn('lagos', { exact: true }).first().click();
  await p.locator('[role=dialog]').waitFor(); await p.getByText('Looking it up').waitFor({ state: 'detached', timeout: 30000 }).catch(() => {}); await wait(1000);
  await shot('lookup');
  await p.keyboard.press('Escape'); await wait(300);
});
await step('menu', async () => {
  await gotoLine(9);
  await btn('More').last().click(); await wait(400);
  await shot('menu');
});
await step('cloze', async () => {
  await p.getByRole('radio', { name: 'Easy' }).click(); await wait(500);
  await p.keyboard.press('Escape'); await wait(300);
  await p.getByText(/Preparing blanks/).waitFor({ state: 'detached', timeout: 120000 }).catch(() => {});
  await wait(1500);
  await p.locator('form input').first().focus(); await wait(300);
  await shot('cloze');
  await btn('More').last().click(); await wait(300);
  await p.getByRole('radio', { name: 'Full' }).click(); await wait(800);
  await p.keyboard.press('Escape'); await wait(300);
});
// "Break it down" at 4:6 so the AI's note fits above the controls; the answer is typed from the sniffed AI reply.
await step('breakdown', async () => {
  await btn('More').last().click(); await wait(300);
  await p.getByRole('radio', { name: '4:6' }).click(); await wait(300);
  await p.getByText(/Break(ing)? it down/).first().click();
  await p.getByText(/Breaking down · step/).waitFor({ timeout: 60000 });
  await wait(2500);
  const w = 'Mira Cris yo creo que mi físico lo dice todo'.split(' ');
  const pt = bdPoints[0];
  await p.locator('input').first().focus();
  const ans = w.slice(pt.from, pt.to + 1); ans[ans.length - 1] += 'x'; // one slip so the review shows a correction
  await typeWords(ans);
  await wait(800);
  await shot('breakdown');
});
await step('back', async () => {
  await btn('More').last().click(); await wait(300);
  await p.getByRole('radio', { name: '6:4' }).click(); await wait(300);
  await p.keyboard.press('Escape'); await wait(200);
  await btn('Back to your videos').click(); await wait(1000);
});
const openMode = async label => {
  await btn(/Continue ·/).first().click(); await wait(500);
  await p.getByRole('radio', { name: label }).click(); await wait(300);
  await btn(/^Start/).last().click(); await wait(2500);
};
await step('blur', async () => {
  await btn('More').first().click(); await wait(400);
  await p.getByText('Practise with Blur').click(); await wait(500);
  await btn(/Continue ·/).first().click().catch(() => {}); await wait(300);
  await btn(/^Start/).last().click().catch(() => {}); await wait(9000);
  for (const w of ['creo', 'físico']) { await p.locator('button', { hasText: new RegExp(`^${w}`) }).first().click().catch(e => console.log('blur', e.message)); await wait(200); }
  await shot('blur');
  await btn('Back to your videos').click(); await wait(1000);
});
await step('watch', async () => {
  await openMode('Watch'); await wait(1500);
  await p.mouse.move(720, 985); await wait(500);
  await btn('Subtitle list').click().catch(e => console.log('list', e.message)); await wait(600);
  await p.getByText(/^Miren, así se ve/).first().click().catch(e => console.log('jump', e.message));
  await wait(1800);
  await p.mouse.move(500, 985); await wait(400);
  await shot('watch');
  await p.evaluate(() => document.querySelector('video')?.pause());
  await p.mouse.move(100, 30); await wait(500);
  await btn('Back to your videos').first().click(); await wait(1000);
  await btn(/Keep watching|Close/).first().click({ timeout: 1500 }).catch(() => {});
  await p.keyboard.press('Escape'); await wait(300);
  await btn('Back to your videos').first().click({ timeout: 1500 }).catch(() => {}); await wait(800);
});
await step('read', async () => {
  await openMode('Read first'); await wait(1500);
  await btn(/^Translation/).first().click(); await wait(12000);
  await btn('austriacos', { exact: true }).first().click().catch(e => console.log('rw', e.message)); await wait(4000);
  await p.keyboard.press('Escape'); await wait(300);
  await btn('verdecito', { exact: true }).first().click().catch(e => console.log('rw', e.message)); await wait(4000);
  await p.keyboard.press('Escape'); await wait(300);
  await p.mouse.move(1300, 900); await wait(300);
  await shot('read');
  await p.goto(`http://localhost:${PORT}`); await wait(1500);
});
await step('podcasts', async () => {
  await btn('Podcasts').first().click(); await wait(800);
  await p.getByText('Spanish', { exact: true }).first().click(); await wait(2500);
  await shot('podcasts', 420);
  await btn('Videos').first().click(); await wait(800);
});
await step('listen', async () => {
  await btn('Add video').first().click(); await wait(400);
  await p.evaluate(f => { window.__MOCK__.pick = f; }, `${MEDIA}/Quien quiere, puede.mp3`);
  await btn(/Choose a video/).click(); await wait(300);
  await p.evaluate(f => { window.__MOCK__.pick = f; }, `${MEDIA}/Quien quiere, puede.srt`);
  await btn('Choose subtitles').click(); await wait(400);
  await btn('Start practising').click(); await wait(2000);
  await p.getByRole('radio', { name: 'Intensive listening' }).click(); await wait(300);
  await btn(/^Start/).last().click(); await wait(4000);
  await btn('Start').last().click(); await wait(500);
  await p.keyboard.press('c'); await wait(800);
  await btn('Listen from line 3').click().catch(e => console.log('l3', e.message)); await wait(3500);
  await p.mouse.move(1300, 500);
  await shot('listen');
});
await b.close();
