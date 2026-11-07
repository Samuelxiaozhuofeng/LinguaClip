// 首页「今天」一栏（docs/stats.md）：到期数和顶栏角标一致、三格各去哪、没到期 / 设置关掉 / 播客页。
// 不进 run.mjs。用法：node dev/e2e/checks/home-today.mjs [截图目录]
import { open, seed, record, SAMPLE, AUDIO } from '../lib.mjs';

const t = await open(process.argv[2]);
const { page, see, gone, nav } = t;
const bar = page.getByRole('region', { name: '今天' });
const ok = msg => console.log('  PASS  ' + msg);
const fail = msg => { throw new Error(msg); };
// 顶栏「句子 / 单词」角标上的数（没有角标 = 0）。
const badges = () => page.getByRole('navigation').locator('button').evaluateAll(bs => Object.fromEntries(bs.map(b => {
  const m = b.textContent.match(/^(\D+)(\d*)$/); return [m[1], Number(m[2] || 0)];
})));

try {
  await seed(page, [
    record(SAMPLE, '.mp4', { id: 'v1', displayName: 'Zoo', currentSubtitleIndex: 1 }),
    record(AUDIO, '.mp3', { id: 'p1', displayName: 'Quien', podcast: { show: 'Coffee Break Spanish', feed: 'https://x/feed', guid: 'g1', name: 'x' } }),
  ], { linguaclip_last_way: { v1: 'all' } });
  // 3 张句子卡 + 1 张单词卡，新卡当场到期。
  await page.evaluate(async () => {
    const R = await import('/utils/review.ts');
    const lines = [[0.55, 7.25, 'Alright, so here we are'], [7.25, 17.15, 'they have really long fronts'], [17.15, 18.96, 'And that is pretty much all']];
    for (const [start, end, text] of lines) await R.addLine({ videoId: 'v1', videoName: 'Zoo', text, start, end }, 'saved');
    await R.addWord({ videoId: 'v1', videoName: 'Zoo', text: lines[0][2], start: 0.55, end: 7.25 }, 'elephants', '大象', '');
  });
  await page.reload();

  // 1 三格都在，数字和顶栏角标一致
  await see(bar, '「今天」一栏');
  const reviewBtn = bar.getByRole('button', { name: /该复习$/ });
  await see(reviewBtn, '「该复习」格');
  const b = await badges();
  const want = `${b['句子']} 句 · ${b['单词']} 个词该复习`;
  const got = (await reviewBtn.textContent()).trim();
  if (got !== want || b['句子'] !== 3 || b['单词'] !== 1) fail(`该复习格「${got}」和角标 句子 ${b['句子']} / 单词 ${b['单词']} 对不上`);
  const resumeBtn = bar.getByRole('button', { name: '继续听写《Zoo》 · 1 / 3 句' });
  await see(resumeBtn, '「接着练」格（和大卡同一段进度）');
  await see(page.getByText('1 / 3 句 · 继续听写'), '大卡进度「1 / 3 句 · 继续听写」');
  await see(bar.getByRole('button', { name: '换个新素材' }), '「换个新素材」格');
  if ((await bar.getByRole('button').first().getAttribute('class')).includes('bg-accent') !== true) fail('第一格不是主按钮');
  await page.screenshot({ path: `${t.out}/today-due.png` });
  ok(`三格都在，「${got}」= 顶栏角标`);

  // 2 点「该复习」→ 直接进复习第一张（句子先）
  await reviewBtn.click();
  await see(page.getByText('1 / 3', { exact: true }), '复习进度「1 / 3」');
  if (await page.getByRole('dialog', { name: '这次怎么练' }).count()) fail('点该复习弹了面板');
  await page.getByRole('button', { name: '结束', exact: true }).click();
  await see(bar, '退出复习回到首页');
  ok('点「该复习」直接进复习第一张（3 句一轮），退出回首页');

  // 3 「接着练」和大卡去同一个地方
  await resumeBtn.click();
  await see(page.getByText('第 2 / 3 句'), '接着练 → 练习页「第 2 / 3 句」');
  if (await page.getByRole('dialog', { name: '这次怎么练' }).count()) fail('接着练弹了面板');
  await page.getByRole('button', { name: '回到你的视频列表' }).click();
  await see(bar, '回首页');
  await page.getByRole('button', { name: '继续听写', exact: true }).first().click();
  await see(page.getByText('第 2 / 3 句'), '大卡 → 练习页「第 2 / 3 句」');
  await page.getByRole('button', { name: '回到你的视频列表' }).click();
  ok('「接着练」和大卡都进「第 2 / 3 句」，不弹面板');

  // 3b 读字幕读到一半 → 两处都写「继续读字幕 · 读到 00:07」，点了都回到阅读器接着读
  await page.evaluate(() => {
    localStorage.setItem('linguaclip_last_way', JSON.stringify({ v1: 'read' }));
    localStorage.setItem('linguaclip_read_pos', JSON.stringify({ v1: 7.25 }));
  });
  await page.reload();
  const readBtn = bar.getByRole('button', { name: '继续读字幕《Zoo》 · 读到 00:07' });
  await see(readBtn, '上次读字幕 → 「继续读字幕《Zoo》 · 读到 00:07」');
  await see(page.getByText('读到 00:07 · 继续读字幕'), '大卡同样「读到 00:07 · 继续读字幕」');
  await readBtn.click();
  await see(page.getByText('接着上次，从 00:07 开始'), '接着练 → 阅读器「接着上次，从 00:07 开始」');
  await page.reload();
  await page.getByRole('button', { name: '继续读字幕', exact: true }).first().click();
  await see(page.getByText('接着上次，从 00:07 开始'), '大卡 → 阅读器「接着上次，从 00:07 开始」');
  await page.reload();
  ok('上次读字幕 → 两处都写「继续读字幕」，点了都接着读');

  // 3c 练完了 → 大卡写「已练完」，这格不出现
  await page.evaluate(async () => {
    localStorage.setItem('linguaclip_last_way', JSON.stringify({ v1: 'all' }));
    const { patchVideoRecord } = await import('/utils/videoStorage.ts');
    await patchVideoRecord('v1', { currentSectionIndex: 0, currentSubtitleIndex: 3 });
  });
  await page.reload();
  await see(page.getByText('3 / 3 句 · 已练完'), '大卡「3 / 3 句 · 已练完」');
  await see(bar.getByRole('button', { name: '换个新素材' }), '「今天」栏还在');
  if (await bar.getByRole('button', { name: /^继续/ }).count()) fail('大卡已练完，「接着练」格还在');
  await page.evaluate(async () => (await import('/utils/videoStorage.ts')).patchVideoRecord('v1', { currentSubtitleIndex: 1 }));
  ok('练完了：大卡「已练完」，接着练格不出现');

  // 4 看剧过的写「继续看剧」
  await page.evaluate(() => localStorage.setItem('linguaclip_last_way', JSON.stringify({ v1: 'watch' })));
  await page.reload();
  await see(bar.getByRole('button', { name: /^继续看剧《Zoo》 · 看到 / }), '上次看剧 → 「继续看剧《Zoo》 · 看到 …」');
  await see(page.getByText(/看到 .* · 继续看剧/), '大卡同样「继续看剧」');
  ok('上次看剧 → 两处都写「继续看剧」');

  // 5 「换个新素材」→ 播客页，那里没有这栏
  await bar.getByRole('button', { name: '换个新素材' }).click();
  await see(page.getByRole('navigation').getByRole('button', { name: '播客', exact: true }).and(page.locator('[aria-current=page]')), '切到播客页');
  await see(page.getByText('Quien'), '播客页的单集');
  if (await bar.count()) fail('播客页出现了「今天」一栏');
  ok('「换个新素材」到播客页，播客页没有这栏');

  // 6 没到期卡 → 第一格不出现，其余两格还在
  await nav('视频');
  await page.evaluate(async () => {
    const R = await import('/utils/review.ts');
    await R.deleteCards((await R.getAllCards()).map(c => c.id));
  });
  await page.reload();
  await see(bar.getByRole('button', { name: '换个新素材' }), '没到期时「换个新素材」还在');
  await see(bar.getByRole('button', { name: /^继续看剧《Zoo》/ }), '没到期时「接着练」还在');
  if (await bar.getByRole('button', { name: /该复习$/ }).count()) fail('没到期卡还显示「该复习」');
  const b2 = await badges();
  if (b2['句子'] || b2['单词']) fail('顶栏角标没清零');
  await page.screenshot({ path: `${t.out}/today-nodue.png` });
  ok('没到期卡：只剩「接着练」「换个新素材」');

  // 6b 首页开着时一张卡到期了 → 去设置再回来，「该复习」和顶栏角标还是同一个数
  await page.evaluate(async () => {
    const R = await import('/utils/review.ts');
    await R.addLine({ videoId: 'v1', videoName: 'Zoo', text: 'Alright, so here we are', start: 0.55, end: 7.25 }, 'saved');
    const card = (await R.getAllCards())[0];
    const db = await new Promise((res, rej) => { const q = indexedDB.open('linguaclip_review'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    await new Promise((res, rej) => {
      const tx = db.transaction('cards', 'readwrite');
      tx.objectStore('cards').put({ ...card, fsrs: { ...card.fsrs, due: Date.now() + 4000 } });
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
    db.close();
  });
  await page.reload();
  await see(bar.getByRole('button', { name: '换个新素材' }), '首页');
  if ((await badges())['句子'] || await bar.getByRole('button', { name: /该复习$/ }).count()) fail('卡还没到期就算进去了');
  await page.waitForTimeout(5000);
  await nav('设置');
  await nav('视频');
  await see(bar.getByRole('button', { name: '换个新素材' }), '回到视频首页');
  await page.waitForTimeout(500);
  const b3 = await badges();
  const cell = await bar.getByRole('button', { name: /该复习$/ }).textContent().catch(() => null);
  const cellN = cell ? Number(cell.match(/(\d+) 句/)?.[1] ?? 0) : 0;
  if (cellN !== b3['句子']) fail(`到期后回首页：「该复习」${cellN} 句，顶栏句子角标 ${b3['句子']}，对不上`);
  if (cellN !== 1) fail(`到期后回首页应算 1 句，实际 ${cellN}`);
  ok('首页开着时卡到期 → 回首页后「该复习」和角标都是 1');

  // 7 设置关掉 → 整栏消失；原有大卡 / 一周统计照常
  await nav('设置');
  const box = page.getByRole('checkbox', { name: '首页显示「今天」' });
  await see(box, '设置里的开关');
  if (!(await box.isChecked())) fail('开关默认不是开');
  await box.uncheck();
  await nav('视频');
  await see(page.getByRole('button', { name: '继续看剧', exact: true }), '大卡还在');
  await gone(bar, '关掉后「今天」一栏');
  await page.screenshot({ path: `${t.out}/today-off.png` });
  ok('设置关掉：整栏消失，大卡还在');

  if (t.errors.length) fail('页面报错：' + t.errors.join(' | '));
  console.log(`全部通过，截图在 ${t.out}`);
} catch (e) {
  await page.screenshot({ path: `${t.out}/fail.png` }).catch(() => {});
  console.log('  FAIL  ' + e.message + `（截图 ${t.out}/fail.png）`);
  process.exitCode = 1;
} finally { await t.close(); }
