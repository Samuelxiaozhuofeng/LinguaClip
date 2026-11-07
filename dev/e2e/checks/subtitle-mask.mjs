// 硬字幕遮挡块（docs/subtitle-mask.md）：听写页画框 → 刷新还在 → 拖动 / 改大小 → 换比例、缩窗口跟着画面走 →
// ⌘U 掀开 → 看剧同一块、V 掀开、点块 = 点画面 → 关掉再开复原 → 复习只读叠上 → 设置关掉全消失 → 删视频清条目。
// 不进 run.mjs。用法：node dev/e2e/checks/subtitle-mask.mjs [截图目录]
import { open, seed, record, SAMPLE, AUDIO } from '../lib.mjs';

const t = await open(process.argv[2]);
const { page, see, gone, nav } = t;
const ok = msg => console.log('  PASS  ' + msg);
const fail = msg => { throw new Error(msg); };
const KEY = 'linguaclip_subtitle_mask';
const block = page.locator('[data-subtitle-mask]');
const stored = () => page.evaluate(k => JSON.parse(localStorage.getItem(k) || '{}'), KEY);
// The object-contain picture inside the first visible <video> (or the review still), in page pixels.
const picture = (sel = 'video') => page.evaluate(sel => {
  const el = [...document.querySelectorAll(sel)].find(e => e.getBoundingClientRect().width > 0);
  const r = el.getBoundingClientRect();
  const [vw, vh] = el.tagName === 'VIDEO' ? [el.videoWidth, el.videoHeight] : [el.naturalWidth, el.naturalHeight];
  const s = Math.min(r.width / vw, r.height / vh), w = vw * s, h = vh * s;
  return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, width: w, height: h };
}, sel);
// The block sits where its stored shares say, on the picture (not the bars), within a pixel.
const aligned = async (what, sel) => {
  const m = (await stored()).v1, p = await picture(sel), b = await block.first().boundingBox();
  const want = { x: p.left + m.x * p.width, y: p.top + m.y * p.height, width: m.w * p.width, height: m.h * p.height };
  for (const k of Object.keys(want)) if (Math.abs(b[k] - want[k]) > 1.5) fail(`${what}：块的 ${k} = ${b[k].toFixed(1)}，画面上应在 ${want[k].toFixed(1)}`);
};
const metadata = () => page.waitForFunction(() => [...document.querySelectorAll('video')].some(v => v.videoWidth > 0));
const menu = async item => {
  await page.getByRole('button', { name: '更多' }).last().click();
  await page.getByRole('menuitem', { name: item }).click();
};
const near = (a, b) => Math.abs(a - b) < 0.012;
// 返修单的每一条单独记 PASS / FAIL，一条没过不挡后面的（每条自己从首页重新进页面）。
const failed = [];
const step = async (name, fn) => {
  try { await fn(); ok(name); } catch (e) {
    failed.push(name);
    console.log(`  FAIL  ${name}：${e.message}`);
    await page.screenshot({ path: `${t.out}/fail-${failed.length}.png` }).catch(() => {});
    await page.mouse.up().catch(() => {});
    await page.evaluate(() => localStorage.removeItem('linguaclip_keys')).catch(() => {});
    await page.reload().catch(() => {});
  }
};
const setBox = (m, extra = {}) => page.evaluate(([k, m, extra]) => {
  localStorage.setItem(k, JSON.stringify({ v1: { on: true, ...m } }));
  for (const [key, v] of Object.entries(extra)) localStorage.setItem(key, JSON.stringify(v));
}, [KEY, m, extra]);
const enter = async (way, prefs) => {
  await page.reload(); // a page still playing keeps saving where it is: stop it before resetting that
  await page.evaluate(([way, prefs]) => {
    localStorage.setItem('linguaclip_last_way', JSON.stringify({ v1: way }));
    localStorage.setItem('linguaclip_watch_pos', '{}');
    if (prefs) localStorage.setItem('linguaclip_watch_prefs', JSON.stringify(prefs));
  }, [way, prefs]);
  await page.reload();
  await page.getByRole('button', { name: way === 'watch' ? '继续看剧' : /^继续(听写|模糊)$/ }).first().click();
  await metadata();
};
const drag = async (from, to) => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
};
const at = (p, x, y) => ({ x: p.left + x * p.width, y: p.top + y * p.height });
const hint = () => page.getByText('在画面上按住拖出一个框，盖住字幕');
// What the pointer would hit at a page point: the block (or one of its grips)?
const hitsBlock = (x, y) => page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('[data-subtitle-mask]'), [x, y]);

try {
  await seed(page, [record(SAMPLE, '.mp4', { id: 'v1', displayName: 'Zoo' })], { linguaclip_last_way: { v1: 'all' } });

  // 1 听写页：「…」→「遮挡硬字幕」→ 画框
  await page.getByRole('button', { name: '继续听写', exact: true }).first().click();
  await see(page.getByText('第 1 / 3 句'), '练习页');
  await metadata();
  if (await block.count()) fail('还没框就有遮挡块');
  await menu('遮挡硬字幕');
  await see(page.getByText('在画面上按住拖出一个框，盖住字幕'), '画框提示');
  // Esc 取消：什么也不存
  await page.keyboard.press('Escape');
  await gone(page.getByText('在画面上按住拖出一个框，盖住字幕'), 'Esc 后画框提示');
  if (Object.keys(await stored()).length) fail('Esc 取消后存了东西');
  await menu('遮挡硬字幕');
  let p = await picture();
  await page.mouse.move(p.left + 0.1 * p.width, p.top + 0.8 * p.height);
  await page.mouse.down();
  await page.mouse.move(p.left + 0.5 * p.width, p.top + 0.9 * p.height, { steps: 5 });
  await page.mouse.move(p.left + 0.9 * p.width, p.top + 0.95 * p.height, { steps: 5 });
  await page.mouse.up();
  await see(block, '遮挡块');
  let m = (await stored()).v1;
  if (!m?.on || !near(m.x, 0.1) || !near(m.y, 0.8) || !near(m.w, 0.8) || !near(m.h, 0.15)) fail(`存的矩形不对：${JSON.stringify(m)}`);
  await aligned('画完');
  await page.screenshot({ path: `${t.out}/mask-drawn.png` });
  ok(`听写页画框 → 存 ${JSON.stringify(m)}，块对在画面上；Esc 取消不存`);

  // 2 拖块身移动、拖右下角改大小（松手才存）
  let b = await block.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 - 0.05 * p.width, b.y + b.height / 2 - 0.1 * p.height, { steps: 5 });
  await page.mouse.up();
  m = (await stored()).v1;
  if (!near(m.x, 0.05) || !near(m.y, 0.7) || !near(m.w, 0.8)) fail(`拖动后矩形不对：${JSON.stringify(m)}`);
  b = await block.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); // hover shows the grips
  await page.mouse.move(b.x + b.width - 1, b.y + b.height - 1);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width - 1 - 0.1 * p.width, b.y + b.height - 1 + 0.05 * p.height, { steps: 5 });
  await page.mouse.up();
  m = (await stored()).v1;
  if (!near(m.x, 0.05) || !near(m.w, 0.7) || !near(m.h, 0.2)) fail(`改大小后矩形不对：${JSON.stringify(m)}`);
  // 拖出画面：贴住边
  b = await block.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2 + p.height, { steps: 5 });
  await page.mouse.up();
  m = (await stored()).v1;
  if (!near(m.y + m.h, 1)) fail(`拖出画面没贴住下边：${JSON.stringify(m)}`);
  await aligned('拖动后');
  ok(`拖动 / 改大小 / 拖出画面贴边都存对：${JSON.stringify(m)}`);

  // 3 ⌘U 掀开 / 盖回（不改存储）
  await page.keyboard.press('Meta+KeyU');
  await gone(block, '⌘U 掀开后的块');
  if (!(await stored()).v1.on) fail('掀开改了存储');
  await page.keyboard.press('Meta+KeyU');
  await see(block, '再按 ⌘U 盖回');
  ok('听写页 ⌘U 掀开 / 盖回，存储不变');

  // 4 换听写区比例、缩窗口：块跟着画面走
  await page.getByRole('button', { name: '更多' }).last().click();
  await page.getByRole('radio', { name: '4:6', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await aligned('视频 : 练习区 = 4:6');
  await page.setViewportSize({ width: 900, height: 900 });
  await page.waitForTimeout(300);
  await aligned('窗口 900×900（上下黑边）');
  await page.screenshot({ path: `${t.out}/mask-resized.png` });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(300);
  await aligned('窗口改回 1280×800');
  ok('换比例、缩窗口（出黑边）块都对在画面上');

  // 5 刷新后还在
  await page.reload();
  await page.getByRole('button', { name: '继续听写', exact: true }).first().click();
  await metadata();
  await see(block, '刷新后遮挡块');
  await aligned('刷新后');
  ok('刷新后再进听写，块还在原处');

  // 6 看剧：同一块；V 掀开 / 盖回；App 字幕在块上面；点块 = 点画面（暂停 / 播放）
  await page.evaluate(() => localStorage.setItem('linguaclip_last_way', JSON.stringify({ v1: 'watch' })));
  await page.reload();
  await page.getByRole('button', { name: '继续看剧', exact: true }).first().click();
  await metadata();
  await see(block, '看剧页遮挡块');
  await aligned('看剧页');
  await page.keyboard.press('KeyV');
  await gone(block, '看剧 V 掀开后的块');
  await page.keyboard.press('KeyV');
  await see(block, '看剧再按 V 盖回');
  const line = page.locator('[data-watch-line]');
  await see(line, '看剧 App 字幕');
  const onTop = await page.evaluate(() => {
    const l = document.querySelector('[data-watch-line] button, [data-watch-line] span') ?? document.querySelector('[data-watch-line]');
    const r = l.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!at?.closest('[data-watch-line]');
  });
  if (!onTop) fail('App 字幕被遮挡块盖住了');
  const paused = () => page.evaluate(() => document.querySelector('video').paused);
  const before = await paused();
  // A spot of the block nothing else covers (the subtitle and the controls sit on parts of it).
  const spot = await block.evaluate(el => {
    const r = el.getBoundingClientRect();
    for (let y = r.top + 3; y < r.bottom - 3; y += 4) for (let x = r.left + 20; x < r.right - 20; x += 20) {
      if (document.elementFromPoint(x, y) === el) return { x, y };
    }
    return null;
  });
  if (!spot) fail('遮挡块整块都被别的东西盖住了');
  await page.mouse.click(spot.x, spot.y);
  await page.waitForTimeout(200);
  if ((await paused()) === before) fail('点遮挡块没有像点画面一样切换播放');
  await page.screenshot({ path: `${t.out}/mask-watch.png` });
  ok('看剧同一块；V 掀开 / 盖回；App 字幕在块上；点块切换播放');

  // 7 「…」里关掉 → 消失；再开 → 原样复原
  const keep = (await stored()).v1;
  await menu('遮挡硬字幕');
  await gone(block, '关掉后的块');
  if ((await stored()).v1.on !== false) fail('关掉没记成 off');
  await menu('遮挡硬字幕');
  await see(block, '再开');
  const back = (await stored()).v1;
  if (JSON.stringify({ ...back, on: true }) !== JSON.stringify({ ...keep, on: true }) || !back.on) fail(`再开没复原：${JSON.stringify(back)} ≠ ${JSON.stringify(keep)}`);
  await aligned('再开后');
  ok('「…」关掉再开，块原样复原');

  // 8 复习：句子卡画面上叠同一块（不接鼠标），⌘U 掀开
  await page.locator('header button').first().click();
  await page.evaluate(async () => {
    const R = await import('/utils/review.ts');
    await R.addLine({ videoId: 'v1', videoName: 'Zoo', text: 'Alright, so here we are', start: 0.55, end: 7.25 }, 'saved');
  });
  await page.reload();
  await nav('句子');
  await page.getByRole('button', { name: '开始复习' }).first().click();
  await see(page.getByText('1 / 1', { exact: true }), '复习第一张');
  await metadata();
  await see(block, '复习画面上的遮挡块');
  await aligned('复习');
  if ((await block.evaluate(e => getComputedStyle(e).pointerEvents)) !== 'none') fail('复习里的块能接鼠标');
  await page.keyboard.press('Meta+KeyU');
  await gone(block, '复习 ⌘U 掀开后的块');
  await page.keyboard.press('Meta+KeyU');
  await see(block, '复习再按 ⌘U 盖回');
  await page.screenshot({ path: `${t.out}/mask-review.png` });
  await page.getByRole('button', { name: '结束', exact: true }).click();
  ok('复习句子卡叠同一块、不接鼠标、⌘U 掀开 / 盖回');

  // ---- 返修单（9 条 + 同类）----
  const BOX = { x: 0.1, y: 0.8, w: 0.8, h: 0.15 };
  await page.reload();

  await step('R1 掀开后「重新框选」：画完、取消后块都显示', async () => {
    await setBox(BOX);
    await enter('all');
    await see(block, '块');
    await page.keyboard.press('Meta+KeyU');
    await gone(block, '掀开');
    await menu('重新框选');
    let p = await picture();
    await drag(at(p, 0.2, 0.7), at(p, 0.8, 0.9));
    await see(block, '掀开状态下重新框选画完后的块', 3000);
    await page.keyboard.press('Meta+KeyU');
    await gone(block, '再掀开');
    await menu('重新框选');
    await page.keyboard.press('Escape');
    await see(block, '掀开状态下重新框选取消后的块', 3000);
  });

  await step('R2 画框时盖住整页：「…」点不到，Esc 只收画框', async () => {
    await setBox(BOX);
    await enter('all');
    await menu('重新框选');
    await see(hint(), '画框提示');
    const more = await page.getByRole('button', { name: '更多' }).last().boundingBox();
    const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('button')?.getAttribute('aria-label') ?? null, [more.x + more.width / 2, more.y + more.height / 2]);
    if (hit === '更多') fail('画框时底栏「…」还能点到');
    await page.mouse.click(more.x + more.width / 2, more.y + more.height / 2);
    if (await page.getByRole('menuitem').count()) fail('画框时点「…」打开了菜单');
    await see(hint(), '点了一下（没拖出框）还在画框');
    await page.keyboard.press('Escape');
    await gone(hint(), 'Esc 后画框提示');
    await see(block, 'Esc 后原来的块');
  });

  await step('R5 拖新框没松手按 Esc：原块原样，不留草稿', async () => {
    await setBox(BOX);
    await enter('all');
    const before = (await stored()).v1;
    await menu('重新框选');
    const p = await picture();
    const a = at(p, 0.2, 0.1), b = at(p, 0.6, 0.4);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 5 });
    await page.keyboard.press('Escape');
    await page.mouse.move(b.x + 20, b.y + 20, { steps: 2 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    if (JSON.stringify((await stored()).v1) !== JSON.stringify(before)) fail(`存储变了：${JSON.stringify((await stored()).v1)}`);
    await aligned('Esc 取消拖框后');
  });

  await step('R8a 块画在顶栏那一条：按得到、拖得动（不被顶栏 / 拖窗区吃掉）', async () => {
    await setBox({ x: 0.3, y: 0, w: 0.4, h: 0.06 });
    await enter('all');
    await page.mouse.move(640, 20); // brings the top bar up
    const b = await block.boundingBox();
    if (!(await hitsBlock(b.x + b.width / 2, b.y + b.height / 2))) fail('顶栏挡住了块');
    const pill = await page.getByRole('button', { name: '回到你的视频列表' }).boundingBox();
    if (!(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('button'), [pill.x + pill.width / 2, pill.y + pill.height / 2]))) fail('顶栏按钮点不到了');
    const p = await picture();
    await drag({ x: b.x + b.width / 2, y: b.y + b.height / 2 }, { x: b.x + b.width / 2, y: b.y + b.height / 2 + 0.2 * p.height });
    if (!near((await stored()).v1.y, 0.2)) fail(`没拖动：${JSON.stringify((await stored()).v1)}`);
  });

  await step('R8b/R8c 看剧：字幕行两侧按得到块；在块上靠近底边不弹出底栏', async () => {
    await setBox({ x: 0, y: 0.6, w: 1, h: 0.4 });
    await enter('watch', { subs: 'show' });
    const line = page.locator('[data-watch-line]');
    await see(line, '看剧字幕');
    // The last line is short: its bubble leaves room on both sides, on the picture. Held there.
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await see(page.getByRole('button', { name: 'pretty', exact: true }), '最后一句');
    await page.keyboard.press('Space');
    await page.mouse.move(640, 300);
    await page.waitForTimeout(2800); // the bars' first show is over
    const row = await line.boundingBox(), bubble = await line.locator(':scope > *').first().boundingBox();
    const x = (row.x + bubble.x) / 2, y = row.y + row.height / 2;
    if (bubble.x - row.x < 10) fail('字幕气泡太宽，测不了两侧');
    if (!(await hitsBlock(x, y))) fail('字幕行的空白处挡住了块');
    const footer = page.locator('footer');
    if (!(await footer.getAttribute('class')).includes('opacity-0')) fail('底栏没先收起');
    const b = await block.boundingBox();
    await page.mouse.move(b.x + 30, b.y + 30);
    await page.mouse.move(b.x + 30, 790, { steps: 4 });
    await page.waitForTimeout(300);
    if (!(await footer.getAttribute('class')).includes('opacity-0')) fail('鼠标在块上靠近底边时底栏弹出来了');
  });

  await step('R7 看剧播放中光标自动隐藏：停在块上也隐藏', async () => {
    await setBox({ x: 0, y: 0.3, w: 1, h: 0.3 });
    await enter('watch', { subs: 'show' });
    const b = await block.boundingBox();
    await page.mouse.move(b.x + 40, b.y + b.height / 2);
    await page.waitForTimeout(2900);
    if (await page.evaluate(() => document.querySelector('video').paused)) fail('视频没在放');
    const cur = await block.evaluate(e => getComputedStyle(e).cursor);
    if (cur !== 'none') fail(`块上的光标是 ${cur}`);
  });

  await step('R9 看剧字幕模糊时：V 揭开这一句 = 同时掀开块，换句一起盖回', async () => {
    await setBox(BOX);
    await enter('watch', { subs: 'blur' });
    await see(page.locator('[data-watch-line]'), '看剧字幕（模糊）');
    await page.keyboard.press('KeyV');
    await gone(block, 'V 后的块');
    await page.keyboard.press('ArrowRight');
    await see(page.getByRole('button', { name: '显示这句' }), '下一句重新模糊');
    await see(block, '换句后块盖回', 3000);
    await page.keyboard.press('KeyV');
    await gone(block, '下一句 V 后的块（不反相）');
  });

  await step('R3 复习「掀开」改成单键 U：句子卡框里打 u 照常出字、不掀块', async () => {
    await setBox(BOX, { linguaclip_keys: { 'review.mask': { code: 'KeyU' } } });
    await page.reload();
    await nav('句子');
    await page.getByRole('button', { name: '开始复习' }).first().click();
    await metadata();
    await see(block, '复习块');
    await page.waitForFunction(() => document.activeElement?.tagName === 'INPUT');
    await page.keyboard.press('KeyU');
    const typed = await page.evaluate(() => document.activeElement.value);
    if (!typed.includes('u')) fail(`框里没出 u：「${typed}」`);
    if (!(await block.count())) fail('打字时块被掀开了');
    await page.getByRole('button', { name: '结束', exact: true }).click();
    await page.evaluate(() => localStorage.removeItem('linguaclip_keys'));
  });

  await step('同类：复习换到同一部视频的下一张句子卡，掀开自动盖回', async () => {
    await page.evaluate(async () => {
      const R = await import('/utils/review.ts');
      await R.addLine({ videoId: 'v1', videoName: 'Zoo', text: 'they have really long fronts', start: 7.25, end: 17.15 }, 'saved');
    });
    await setBox(BOX);
    await page.reload();
    await nav('句子');
    await page.getByRole('button', { name: '开始复习' }).first().click();
    await metadata();
    await see(block, '复习块');
    await page.keyboard.press('Meta+KeyU');
    await gone(block, '掀开');
    await page.getByRole('button', { name: '跳过' }).click();
    await see(page.getByText('2 / 2', { exact: true }), '第二张');
    await see(block, '第二张卡块盖回', 3000);
    await page.getByRole('button', { name: '结束', exact: true }).click();
  });

  await step('X1 复习单张卡：⌘U 掀开 → 交卷 → 重来 → 同一张卡块盖回', async () => {
    await page.evaluate(async () => {
      const R = await import('/utils/review.ts');
      await R.deleteCards((await R.getAllCards()).map(c => c.id));
      await R.addLine({ videoId: 'v1', videoName: 'Zoo', text: 'Alright, so here we are', start: 0.55, end: 7.25 }, 'saved');
    });
    await setBox(BOX);
    await page.reload();
    await nav('句子');
    await page.getByRole('button', { name: '开始复习' }).first().click();
    await see(page.getByText('1 / 1', { exact: true }), '1/1');
    await metadata();
    await see(block, '复习块');
    await page.keyboard.press('Meta+KeyU');
    await gone(block, '掀开');
    const boxes = page.getByRole('textbox').and(page.locator(':not([placeholder])'));
    await see(boxes, '输入格', 25000);
    for (const [i, word] of ['Alright', 'so', 'here', 'we', 'are'].entries()) {
      await boxes.nth(i).evaluate(el => new Promise((ok, no) => { const end = Date.now() + 5000; const p = () => document.activeElement === el ? ok() : Date.now() > end ? no(new Error('光标没跳')) : setTimeout(p, 20); p(); }));
      await page.keyboard.type(word);
    }
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: /重来/ }).click();
    await see(page.getByText('2 / 2', { exact: true }), '重来后 2/2（同一张卡再来）');
    await metadata();
    await see(block, '重来后块盖回', 3000);
    await page.getByRole('button', { name: '结束', exact: true }).click();
  });

  await step('R4 开关开着：模糊练角落快捷键表有「掀开 / 盖回遮挡块」', async () => {
    await page.evaluate(async () => {
      localStorage.setItem('linguaclip_keys_pinned', '1');
      const { patchVideoRecord } = await import('/utils/videoStorage.ts');
      await patchVideoRecord('v1', { learningMode: 'BLUR' });
    });
    try {
      await enter('all');
      await see(page.locator('aside').getByText('掀开 / 盖回遮挡块'), '模糊练角落表的遮挡键');
    } finally {
      await page.reload(); // leaving the practice page writes its mode back: change it from home
      await page.evaluate(async () => {
        const { patchVideoRecord } = await import('/utils/videoStorage.ts');
        await patchVideoRecord('v1', { learningMode: 'DICTATION' });
      });
    }
  });
  await setBox(BOX);

  // 9 设置关掉 → 菜单项、块、快捷键都没有
  await nav('设置');
  await page.getByRole('checkbox', { name: '硬字幕遮挡' }).uncheck();
  await nav('视频');
  await page.evaluate(() => localStorage.setItem('linguaclip_last_way', JSON.stringify({ v1: 'all' })));
  await page.reload();
  await page.getByRole('button', { name: '继续听写', exact: true }).first().click();
  await metadata();
  await page.waitForTimeout(300);
  if (await block.count()) fail('开关关了块还在');
  await page.getByRole('button', { name: '更多' }).last().click();
  await see(page.getByRole('menuitem').first(), '「…」菜单');
  if (await page.getByRole('menuitem', { name: '遮挡硬字幕' }).count()) fail('开关关了菜单项还在');
  await page.keyboard.press('Escape');
  await page.screenshot({ path: `${t.out}/mask-off.png` });
  if (!(await stored()).v1) fail('关开关把矩形删了');
  ok('设置关掉：菜单项和块都没有，矩形还留着');

  await step('R4 开关关掉：角落表、设置 → 快捷键都不列，⌘U 可以给别的听写动作', async () => {
    if (await page.locator('aside').getByText('掀开 / 盖回遮挡块').count()) fail('角落快捷键表还列着');
    await page.keyboard.press('Meta+KeyU');
    await page.locator('header button').first().click();
    await nav('设置');
    await page.getByRole('radio', { name: '快捷键', exact: true }).click();
    await see(page.getByText('打字中播放/暂停'), '快捷键页');
    if (await page.getByText('掀开 / 盖回遮挡块').count()) fail('设置 → 快捷键还列着');
    await page.getByRole('radio', { name: '复习', exact: true }).click();
    if (await page.getByText('掀开 / 盖回遮挡块').count()) fail('设置 → 快捷键 · 复习还列着');
    await nav('视频');
  });
  await page.evaluate(() => localStorage.removeItem('linguaclip_keys_pinned'));

  // 10 删视频 → 条目清掉
  await page.reload();
  await page.getByRole('button', { name: '更多' }).first().click();
  await page.getByRole('menuitem', { name: '删除记录' }).click();
  await page.getByRole('dialog', { name: '删除这个视频？' }).getByRole('button', { name: '删除' }).click();
  const keepCards = page.getByRole('dialog').getByRole('button', { name: '只删记录，保留文件' });
  await keepCards.click();
  await page.waitForFunction(k => !(JSON.parse(localStorage.getItem(k) || '{}').v1), KEY, { timeout: 5000 }).catch(() => fail('删视频后遮挡条目还在'));
  ok('删视频后这部的遮挡条目被清');

  await step('R6 纯音频听写（没有画面）：「…」里没有遮挡项，Esc 不被吞', async () => {
    await seed(page, [record(AUDIO, '.mp3', { id: 'a1', displayName: 'Quien' })], { linguaclip_last_way: { a1: 'all' }, linguaclip_practice_config: { sectionLength: 4, subtitleMask: true } }); // switched back on (step 9 turned it off)
    await page.getByRole('button', { name: '继续听写', exact: true }).first().click();
    await page.waitForFunction(() => document.querySelector('video')?.readyState >= 1);
    await page.getByRole('button', { name: '更多' }).last().click();
    await see(page.getByRole('menuitem').first(), '「…」菜单');
    if (await page.getByRole('menuitem', { name: '遮挡硬字幕' }).count()) fail('没有画面也出了「遮挡硬字幕」');
    await page.keyboard.press('Escape');
  });

  if (t.errors.length) fail('页面报错：' + t.errors.join(' | '));
  if (failed.length) fail(`返修项没过 ${failed.length} 条：${failed.join('；')}`);
  console.log('全部通过；截图在 ' + t.out);
} catch (e) {
  await page.screenshot({ path: `${t.out}/mask-fail.png` }).catch(() => {});
  console.log('  FAIL  ' + e.message);
  process.exitCode = 1;
} finally { await t.close(); }
