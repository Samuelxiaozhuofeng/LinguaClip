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
    record(AUDIO, '.mp3', { id: 'p1', displayName: 'Quien', lastPracticed: Date.now() - 10_000, podcast: { show: 'Coffee Break Spanish', feed: 'https://x/feed', guid: 'g1', name: 'x' } }),
  ], { linguaclip_last_way: { v1: 'all' } });
  // 3 张句子卡 + 1 张单词卡，新卡当场到期。
  await page.evaluate(async () => {
    const R = await import('/utils/review.ts');
    const lines = [[0.55, 7.25, 'Alright, so here we are'], [7.25, 17.15, 'they have really long fronts'], [17.15, 18.96, 'And that is pretty much all']];
    for (const [start, end, text] of lines) await R.addLine({ videoId: 'v1', videoName: 'Zoo', text, start, end }, 'saved');
    await R.addWord({ videoId: 'v1', videoName: 'Zoo', text: lines[0][2], start: 0.55, end: 7.25 }, 'elephants', '大象', '');
  });
  await page.reload();

  // 1 「今天」栏只放合并复习主按钮（不再重复大继续卡或「换个新素材」），总数与顶栏「复习」角标一致
  await see(bar, '「今天」一栏');
  const reviewBtn = bar.getByRole('button', { name: /该复习$/ });
  await see(reviewBtn, '「该复习」格');
  const b = await badges();
  const want = '3 句 · 1 个词该复习';
  const got = (await reviewBtn.textContent()).trim();
  if (got !== want || b['复习'] !== 4) fail(`该复习格「${got}」和顶栏复习角标 ${b['复习']} 对不上`);
  if (await bar.getByRole('button', { name: /^继续/ }).count()) fail('「今天」栏不应再重复大继续卡的「继续」按钮');
  if (await bar.getByRole('button', { name: '换个新素材' }).count()) fail('「今天」栏不应再有「换个新素材」按钮');
  await see(page.getByText('1 / 3 句 · 继续听写'), '大卡进度「1 / 3 句 · 继续听写」');
  if ((await bar.getByRole('button').first().getAttribute('class')).includes('bg-accent') !== true) fail('复习按钮不是主按钮');
  await page.screenshot({ path: `${t.out}/today-due.png` });
  ok(`去重成功，「${got}」= 顶栏复习角标 ${b['复习']}`);

  // 2 点「该复习」→ 直接进合并队列第一张（3 句 + 1 词 = 4 张）
  await reviewBtn.click();
  await see(page.getByText('1 / 4', { exact: true }), '合并复习进度「1 / 4」');
  if (await page.getByRole('dialog', { name: '这次怎么练' }).count()) fail('点该复习弹了面板');
  await page.getByRole('button', { name: '结束', exact: true }).click();
  await see(bar, '退出复习回到首页');
  ok('点「该复习」直接进合并队列（3 句 + 1 词 = 4 张），退出回首页');

  // 3 切到「播客」筛选后，「今天」一栏依然常驻
  await page.getByRole('radio', { name: /^播客/ }).click();
  await see(page.getByText('Quien'), '播客筛选里的单集');
  await see(bar, '播客筛选下「今天」一栏依然常驻');
  await page.getByRole('radio', { name: /^全部/ }).click();
  ok('切到「播客」筛选后，「今天」一栏仍常驻');

  // 4 所有卡推迟到未来（没到期但有卡）→ 显示「今天的复习做完了」
  await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const q = indexedDB.open('linguaclip_review'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    const tx = db.transaction('cards', 'readwrite');
    const store = tx.objectStore('cards');
    const all = await new Promise((res, rej) => { const r = store.getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    for (const c of all) store.put({ ...c, fsrs: { ...c.fsrs, due: Date.now() + 86_400_000 } });
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    db.close();
  });
  await page.reload();
  await see(bar.getByText('今天的复习做完了'), '全部清完显示「今天的复习做完了」');
  if (await bar.getByRole('button', { name: /该复习$/ }).count()) fail('没到期卡还显示「该复习」');
  await page.screenshot({ path: `${t.out}/today-done.png` });
  ok('没到期但有卡：显示「今天的复习做完了」');

  // 5 删光所有卡 → 整栏不出现
  await page.evaluate(async () => {
    const R = await import('/utils/review.ts');
    await R.deleteCards((await R.getAllCards()).map(c => c.id));
  });
  await page.reload();
  await see(page.getByText('1 / 3 句 · 继续听写'), '大卡还在');
  await gone(bar, '没有任何卡时「今天」栏不渲染');
  const b2 = await badges();
  if (b2['复习']) fail('顶栏复习角标没清零');
  ok('没有任何卡：整栏不占位');

  // 6 首页开着时一张卡到期了 → 去设置再回来，「该复习」和顶栏角标还是同一个数
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
  await see(bar.getByText('今天的复习做完了'), '未到期时显示做完了');
  if ((await badges())['复习'] || await bar.getByRole('button', { name: /该复习$/ }).count()) fail('卡还没到期就算进去了');
  await page.waitForTimeout(5000);
  await nav('设置');
  await nav('学习');
  await see(bar.getByRole('button', { name: /该复习$/ }), '到期后回首页出现「该复习」');
  const b3 = await badges();
  const cell = await bar.getByRole('button', { name: /该复习$/ }).textContent().catch(() => null);
  const cellN = cell ? Number(cell.match(/(\d+) 句/)?.[1] ?? 0) : 0;
  if (cellN !== b3['复习']) fail(`到期后回首页：「该复习」${cellN} 句，顶栏复习角标 ${b3['复习']}，对不上`);
  if (cellN !== 1) fail(`到期后回首页应算 1 句，实际 ${cellN}`);
  ok('首页开着时卡到期 → 回首页后「该复习」和角标都是 1');

  // 7 设置关掉 → 整栏消失；原有大卡 / 筛选照常
  await nav('设置');
  const box = page.getByRole('checkbox', { name: '首页显示「今天」' });
  await see(box, '设置里的开关');
  if (!(await box.isChecked())) fail('开关默认不是开');
  await box.uncheck();
  await nav('学习');
  await see(page.getByRole('button', { name: '继续听写', exact: true }), '大卡还在');
  await see(page.getByRole('radio', { name: /^全部/ }), '关掉今天栏后筛选胶囊仍在');
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
