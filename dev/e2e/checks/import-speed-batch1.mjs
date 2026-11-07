// One-off browser check for batch 1 of the improvements (not in run.mjs):
//   B4 each player remembers its own speed; B5 over-long lines of subtitles the user brings are
//   cut on a new import (switch in Settings); E a sound file opens the panel on 精听.
// node dev/e2e/checks/import-speed-batch1.mjs [output dir for screenshots]
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { open, seed, record, ROOT, SAMPLE, AUDIO } from '../lib.mjs';

const t = await open(process.argv[2]);
const { page, see, nav } = t;
const shot = name => page.screenshot({ path: `${t.out}/${name}.png` });
const ok = (cond, what) => { if (!cond) throw new Error(`不对：${what}`); console.log(`  ok  ${what}`); };
const ls = key => page.evaluate(k => localStorage.getItem(k), key);
const records = () => page.evaluate(async () => (await import('/utils/fileSystemAccess.ts')).getAllVideosFromDB());
const lines = text => page.evaluate(async s => (await import('/utils/srtParser.ts')).parseSRT(s), text);
// Only these records in the library (plus localStorage values), page reloaded.
const only = async (recs, storage = {}) => {
  await page.evaluate(async () => {
    const db = await import('/utils/fileSystemAccess.ts');
    for (const r of await db.getAllVideosFromDB()) await db.deleteVideoFromDB(r.id);
  });
  await seed(page, recs, storage);
};
const back = async () => { await page.mouse.move(300, 30); await page.getByRole('button', { name: '回到你的视频列表' }).click(); };
const rateOf = sel => page.evaluate(s => document.querySelector(s)?.playbackRate, sel);
const waitRate = async (sel, want, what) => {
  const end = Date.now() + 8000;
  let got;
  while (Date.now() < end) { got = await rateOf(sel); if (got === want) break; await page.waitForTimeout(200); }
  ok(got === want, `${what}：${sel} playbackRate = ${want}（实际 ${got}）`);
};

// The long-line subtitle: 30 words on one line, then two short ones. Served from the project
// folder (the browser mock reads files through vite, which only allows a few places).
const LONG = Array.from({ length: 30 }, (_, i) => ['we', 'walked', 'along', 'the', 'quiet', 'river'][i % 6]).join(' ');
const FIXTURE_DIR = path.join(ROOT, 'node_modules/.cache/linguaclip-e2e');
mkdirSync(FIXTURE_DIR, { recursive: true });
const SRT = path.join(FIXTURE_DIR, 'long-line.srt');
const RAW = `1\n00:00:01,000 --> 00:00:11,000\n${LONG}\n\n2\n00:00:12,000 --> 00:00:14,000\nThat was a nice day.\n\n3\n00:00:15,000 --> 00:00:17,000\nWe should go again.\n`;
writeFileSync(SRT, RAW);
const words = s => s.split(/\s+/).filter(Boolean).length;

const pod = { show: 'Coffee Break Spanish', feed: 'https://x/feed', guid: 'g1', name: 'x' };

try {
  // ---------- B4: speeds, each its own ----------
  console.log('B4 倍速三处各记各的');
  await only([
    record(SAMPLE, '.mp4', { id: 'v1', displayName: 'Dict' }),
    record(AUDIO, '.mp3', { id: 'p1', displayName: 'Quien', podcast: pod }),
  ], { linguaclip_last_way: { v1: 'all' }, linguaclip_watch_prefs: { listenIntro: true } });

  await nav('视频');
  await page.getByRole('button', { name: '继续听写' }).first().click();
  await see(page.getByText(/第 1 \/ 3 句/), '听写页');
  await page.getByRole('button', { name: '更多' }).last().click();
  await page.getByRole('radio', { name: '0.75×', exact: true }).click();
  await page.keyboard.press('Escape');
  await waitRate('video', 0.75, '听写选 0.75×');
  ok(await ls('linguaclip_speed_dictation') === '0.75', '存进 linguaclip_speed_dictation');
  // What the Anki recorder does: the element straight to 1× and back. Nothing is stored.
  await page.evaluate(() => { const v = document.querySelector('video'); v.playbackRate = 1; v.playbackRate = 0.75; v.playbackRate = 1; });
  ok(await ls('linguaclip_speed_dictation') === '0.75', '直接改元素倍速（Anki 录音那样）不改存的值');
  await back();
  await page.getByRole('button', { name: '继续听写' }).first().click();
  await see(page.getByText(/第 1 \/ 3 句/), '再进听写页');
  await waitRate('video', 0.75, '退出再进听写');
  await see(page.getByText('0.75×', { exact: true }), '遥控条显示 0.75×');
  await shot('b4-dictation-0.75');
  await back();

  // Watch: from the card's「…」→ 换个练法 → 看剧.
  await page.getByRole('button', { name: '更多' }).first().click();
  await page.getByRole('menuitem', { name: '换个练法' }).click();
  let panel = page.getByRole('dialog', { name: '这次怎么练' });
  await panel.getByRole('radio', { name: '看剧' }).click();
  await panel.getByRole('button', { name: '开始看剧' }).click();
  await waitRate('video', 1, '看剧第一次进来是 1×（不跟听写的 0.75×）');
  await page.mouse.move(640, 790);
  await page.getByRole('button', { name: '更多' }).last().click();
  await page.getByRole('radio', { name: '1.25×', exact: true }).click();
  await page.keyboard.press('Escape');
  await waitRate('video', 1.25, '看剧选 1.25×');
  await back();
  await page.getByRole('button', { name: '继续看剧' }).first().click();
  await waitRate('video', 1.25, '退出再进看剧');
  await shot('b4-watch-1.25');
  await back();
  ok(await ls('linguaclip_speed_dictation') === '0.75' && await ls('linguaclip_speed_watch') === '1.25', '听写 / 看剧各存各的');

  // Listen (精听) on the podcast page.
  await nav('播客');
  await page.getByRole('button', { name: '继续精听' }).first().click();
  await see(page.locator('header [aria-current=step]'), '精听页');
  await waitRate('audio', 1, '精听第一次进来是 1×');
  await page.getByRole('radio', { name: '0.9×', exact: true }).click();
  await waitRate('audio', 0.9, '精听选 0.9×');
  await page.locator('header button').first().click();
  await page.getByRole('button', { name: '继续精听' }).first().click();
  await see(page.locator('header [aria-current=step]'), '再进精听页');
  await waitRate('audio', 0.9, '退出再进精听');
  await shot('b4-listen-0.9');
  await page.locator('header button').first().click();
  ok(await ls('linguaclip_speed_dictation') === '0.75' && await ls('linguaclip_speed_watch') === '1.25' && await ls('linguaclip_speed_listen') === '0.9', '三处互不影响');

  // A stored value not among the page's choices (0.5 is dictation's only) → 1×.
  await page.evaluate(() => localStorage.setItem('linguaclip_speed_listen', '0.5'));
  await page.getByRole('button', { name: '继续精听' }).first().click();
  await see(page.locator('header [aria-current=step]'), '精听页');
  await waitRate('audio', 1, '存的 0.5 不在精听档位里 → 1×');
  await page.locator('header button').first().click();

  // ---------- E: a sound file opens the panel on 精听 ----------
  console.log('E 纯音频默认选中精听');
  await only([record(AUDIO, '.mp3', { id: 'a1', displayName: 'Sound' })], { linguaclip_watch_prefs: { listenIntro: true } });
  await nav('视频');
  await page.getByRole('button', { name: '继续听写' }).first().click();
  panel = page.getByRole('dialog', { name: '这次怎么练' });
  await see(panel, '音频第一次点：弹「这次怎么练」');
  ok(await panel.getByRole('radio', { name: '精听' }).getAttribute('aria-checked') === 'true', 'mp3 面板默认选中「精听」');
  await page.waitForTimeout(500); // the panel fades in
  await shot('e-audio-panel');
  await page.keyboard.press('Enter'); // start with the default
  await see(page.locator('header [aria-current=step]'), '回车 = 开始精听');
  await page.locator('header button').first().click();
  const prefs = JSON.parse(await ls('linguaclip_watch_prefs') || '{}');
  ok(prefs.chosen === undefined, `音频选精听不改视频的默认（watch_prefs.chosen = ${prefs.chosen}）`);

  await only([record(SAMPLE, '.mp4', { id: 'v2', displayName: 'Zoo' })], { linguaclip_watch_prefs: prefs });
  await nav('视频');
  await page.getByRole('button', { name: '继续听写' }).first().click();
  panel = page.getByRole('dialog', { name: '这次怎么练' });
  await see(panel, '新视频弹面板');
  ok(await panel.getByRole('radio', { name: '按段从头练' }).getAttribute('aria-checked') === 'true', '视频文件仍默认「按段从头练」');
  ok(!(await panel.getByRole('radio', { name: '精听' }).count()), '视频面板里没有「精听」');
  await page.waitForTimeout(500);
  await shot('e-video-panel');
  await page.keyboard.press('Escape');

  // ---------- B5: long lines cut on import ----------
  console.log('B5 新导入的外挂字幕自动切长句');
  const old = record(SAMPLE, '.mp4', { id: 'old', displayName: 'Old', subtitleText: RAW, totalSubtitles: 3 });
  await only([old]);
  const addWithSrt = async (video, button) => {
    await nav('视频');
    await page.getByRole('button', { name: '添加视频' }).first().click();
    const add = page.getByRole('dialog', { name: '添加视频' });
    await page.evaluate(p => { window.__MOCK__.pick = p; }, video);
    await add.getByRole('button', { name: '选择本机视频' }).click();
    await page.evaluate(p => { window.__MOCK__.pick = p; }, SRT);
    await add.getByRole('button', { name: '选字幕文件' }).click();
    await see(add.getByText('long-line.srt'), '弹窗里显示选中的字幕');
    await add.getByRole('button', { name: button }).click();
  };
  const newest = async () => (await records()).filter(r => r.id !== 'old').sort((a, b) => b.dateAdded - a.dateAdded)[0];

  // ① video + .srt, straight into a record (switch on by default).
  await addWithSrt(`${SAMPLE}.mp4`, '开始练习');
  await see(page.getByRole('dialog', { name: '这次怎么练' }), '「这次怎么练」面板');
  await page.keyboard.press('Escape');
  await see(page.getByText('0 / 4 句 · 继续听写'), '卡片「0 / 4 句」（30 词那句切成两句）');
  await shot('b5-on-card');
  let rec = await newest();
  let ls1 = await lines(rec.subtitleText);
  ok(rec.totalSubtitles === 4 && ls1.length === 4, `切完 4 句（记录 ${rec.totalSubtitles}，解析 ${ls1.length}）`);
  ok(ls1.every(l => words(l.text) <= 16), `每句 ≤16 词：${ls1.map(l => words(l.text)).join(' / ')}`);
  ok(ls1[0].startTime === 1 && ls1[1].endTime === 11 && ls1[0].endTime === ls1[1].startTime, `时间首尾相接：${ls1[0].startTime}–${ls1[0].endTime}，${ls1[1].startTime}–${ls1[1].endTime}`);
  ok(`${ls1[0].text} ${ls1[1].text}` === LONG, '切开的两句拼回去就是原句');
  // In practice: line 1 of 4.
  await page.getByRole('button', { name: '继续听写' }).first().click();
  panel = page.getByRole('dialog', { name: '这次怎么练' });
  await panel.getByRole('radio', { name: '按段从头练' }).click();
  await panel.getByRole('button', { name: '开始练习' }).click();
  await see(page.getByText(/第 1 \/ 4 句/), '练习页「第 1 / 4 句」');
  await shot('b5-on-practice');
  await back();

  // ② the same with a video that is converted first: the import card carries the cut subtitles.
  await page.evaluate(() => { window.__MOCK__.convertTool = true; window.__MOCK__.probe = { subtitles: [] }; });
  await addWithSrt(`${SAMPLE}.mkv`, '开始导入');
  await page.waitForTimeout(800);
  rec = (await records()).find(r => r.importJob?.subs === 'own');
  ok(rec && rec.totalSubtitles === 4 && (await lines(rec.subtitleText)).length === 4, '先转格式的那条路：导入卡片带的字幕也切成 4 句');
  await page.evaluate(async id => (await import('/utils/fileSystemAccess.ts')).deleteVideoFromDB(id), rec.id);

  // ③ a subtitle track inside the video: cut when the import finishes.
  const trackId = await page.evaluate(async () => {
    await (await import('/utils/importJob.ts')).startLocalImport('/x/track.mkv', 'en', { subs: 0 });
    return window.__MOCK__.calls.filter(c => c.cmd === 'start_import').pop().args.id;
  });
  await page.evaluate(([id, text, videoPath]) => window.__MOCK__.emit('import-progress', { id, stage: 'done', videoPath, subtitleText: text }), [trackId, RAW, `${SAMPLE}.mp4`]);
  await page.waitForTimeout(1000);
  rec = (await records()).find(r => r.id === trackId);
  ok(rec && !rec.importJob && rec.totalSubtitles === 4, `视频自带字幕轨：导入完成后切成 4 句（${rec?.totalSubtitles}）`);
  await page.evaluate(async id => (await import('/utils/fileSystemAccess.ts')).deleteVideoFromDB(id), trackId);

  // A starter episode's own transcript is never cut.
  const starterId = 'starter-1';
  await page.evaluate(async ([id, text]) => {
    await (await import('/utils/importJob.ts')).startPodcastImport(
      { id, title: 'Starter', audio: 'https://x/a.mp3', lang: 'en', podcast: { show: 'S', feed: 'https://x/f', guid: 'g', name: 'S' } },
      { text, fileName: 'starter.srt', count: 3 });
  }, [starterId, RAW]);
  rec = (await records()).find(r => r.id === starterId);
  ok(rec && rec.subtitleText === RAW, '入门练习自带字幕原样不切');
  await page.evaluate(async id => (await import('/utils/fileSystemAccess.ts')).deleteVideoFromDB(id), starterId);

  // Switch off in Settings → 导入与转录 → imported as it is.
  await nav('设置');
  await page.getByRole('radio', { name: '导入与转录' }).click();
  const box = page.getByRole('checkbox', { name: '自动切开太长的句子' });
  ok(await box.isChecked(), '设置里「自动切开太长的句子」默认开');
  await box.uncheck();
  await shot('b5-setting-off');
  ok(JSON.parse(await ls('linguaclip_transcribe_config')).splitLong === false, '关掉存进 transcribe_config.splitLong = false');
  const before = (await records()).length;
  await addWithSrt(`${SAMPLE}.mp4`, '开始练习');
  await see(page.getByRole('dialog', { name: '这次怎么练' }), '「这次怎么练」面板');
  await page.keyboard.press('Escape');
  ok((await records()).length === before + 1, '关掉后又加了一条');
  rec = await newest();
  ok(rec.subtitleText === RAW && rec.totalSubtitles === 3, '开关关掉：字幕原样（3 句）');
  await see(page.getByText('0 / 3 句 · 继续听写'), '卡片「0 / 3 句」');
  await shot('b5-off-card');

  // Records imported before: untouched (no migration anywhere).
  await page.reload();
  const oldNow = (await records()).find(r => r.id === 'old');
  ok(oldNow.subtitleText === RAW && oldNow.totalSubtitles === 3, '已有视频的字幕不变');

  if (t.errors.length) console.log('页面报错', t.errors);
  console.log(`全部通过，截图在 ${t.out}`);
} catch (e) {
  await shot('fail').catch(() => {});
  console.log(`没过：${e.message}（截图 ${t.out}/fail.png）`);
  process.exitCode = 1;
} finally {
  await t.close();
}
