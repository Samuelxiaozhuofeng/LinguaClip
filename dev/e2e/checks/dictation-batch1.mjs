// One-off browser check for 改进方案第一批 A + B1–B3 (docs/dictation-judge.md, docs/shortcuts.md):
// 宽松判对 / 差一点, judged-right jumps at once, skipping a section's last line, ⌘I saves the line.
// Not part of run.mjs. Run: node dev/e2e/checks/dictation-batch1.mjs [screenshot dir]
import { open, seed, record, SAMPLE } from '../lib.mjs';

// The sample clip (19 s) with our own lines on its times, the last ending before the clip does;
// a 4th line past 1 min makes a second section.
const SRT = `1
00:00:00,550 --> 00:00:07,250
Hello, I walked to the zoo.

2
00:00:07,250 --> 00:00:17,150
I'm going home.

3
00:00:17,150 --> 00:00:18,300
That's all, Mary.

4
00:01:01,000 --> 00:01:02,000
Bye now.
`;
const over = id => ({ id, displayName: id, subtitleText: SRT, totalSubtitles: 4 });

const t = await open(process.argv[2]);
const { page, see, nav } = t;
const shot = name => page.screenshot({ path: `${t.out}/${name}.png` });
const boxes = page.getByRole('textbox').and(page.locator(':not([placeholder])'));
const focusedBox = () => page.evaluate(() => [...document.querySelectorAll('form input[type=text]')].indexOf(document.activeElement));
const values = () => page.evaluate(() => [...document.querySelectorAll('form input[type=text]')].map(i => i.value));
const classOf = i => boxes.nth(i).getAttribute('class');
const todayLines = () => page.evaluate(async () => (await import('/utils/today.ts')).getToday().lines);
const ok = (cond, msg) => { if (!cond) throw new Error(msg); console.log('  ✓ ' + msg); };
const waitBoxes = async n => {
  await see(boxes, '听写输入格', 25_000);
  ok((await boxes.count()) === n, `出现 ${n} 个输入格`);
};
// The first time a video opens it asks how to practise; after that it opens straight away.
const start = async () => {
  await nav('视频');
  await page.getByRole('button', { name: '继续听写' }).first().click();
  const panel = page.getByRole('dialog', { name: '这次怎么练' });
  if (await panel.waitFor({ timeout: 3000 }).then(() => true, () => false)) {
    await panel.getByRole('radio', { name: '按段从头练' }).click();
    await panel.getByRole('button', { name: '开始练习' }).click();
  }
};

try {
  await seed(page, [record(SAMPLE, '.mp4', over('zoo'))],
    { linguaclip_practice_config: { sectionLength: 1, autoAddReview: true } });

  console.log('A 宽松判对（默认开）');
  await start();
  await waitBoxes(6);
  // HELLO is right as soon as it is typed (whole-word case), so the comma lands in the next blank.
  await page.keyboard.type('HELLO,');
  ok((await values())[0] === 'HELLO', '整词大写「HELLO」判对并跳格（严格下不算对）');
  await page.keyboard.type('I');
  ok((await values())[1] === ',I' && (await focusedBox()) === 2, '第 2 格「,I」（多出的首标点）判对跳格（严格下不算对）');
  await page.keyboard.type('walk');
  await page.waitForTimeout(300);
  ok((await focusedBox()) === 2, '打 walk（答案 walked）不跳格');
  ok(!(await classOf(2)).includes('border-dashed'), '还在这一格时不标虚线');
  await page.keyboard.press('Space');
  ok((await focusedBox()) === 3, '空格跳走');
  ok(/border-dashed/.test(await classOf(2)) && /border-accent/.test(await classOf(2)), '离开后 walk 那格朱红虚线');
  await shot('A1-near-dashed');
  await boxes.nth(2).click();
  ok(!(await classOf(2)).includes('border-dashed'), '点回这一格虚线消失');
  await boxes.nth(3).click();
  ok(/border-dashed/.test(await classOf(2)), '点走又出虚线');
  await page.keyboard.type('to');
  await page.keyboard.type('the');
  await page.keyboard.type('ZOO');
  await page.keyboard.press('Enter');
  await see(page.getByText('6 个词对了 5 个'), '交卷「6 个词对了 5 个」（差一点仍算错）');
  const walked = page.locator('[data-lookup-line] button', { hasText: 'walked' });
  ok((await walked.locator('span.text-accent').allInnerTexts()).join('') === 'ed', '答案 walked 里只有 ed 标朱红');
  ok(/decoration-dashed/.test(await walked.getAttribute('class')) && !/text-accent/.test(await walked.getAttribute('class')), 'walked 整词不变红、下面朱红虚线');
  ok((await page.locator('[data-lookup-line] .line-through').count()) === 0, '不划掉打的 walk');
  await shot('A2-feedback');
  const cards = await page.evaluate(async () => (await import('/utils/review.ts')).getAllCards());
  ok(cards.some(c => c.deck === 'line' && c.text.startsWith('Hello, I walked') && c.reasons.includes('wrong')), '这句进了复习（原因 wrong）');

  console.log('B1 判对立即跳格');
  const before = await todayLines();
  await page.keyboard.press('Enter');
  await waitBoxes(3);
  // Each right word moves the cursor on by itself: typed straight on, the next word's
  // letters must land in the next blank (before the fix they went into the last one).
  await page.keyboard.type("I'mgoinghome", { delay: 25 });
  await see(page.getByText('3 个词对了 3 个'), "一口气连打 I'mgoinghome 不串格，三格全对自动交卷", 3000);
  console.log("  ✓ 一口气连打不串格（3 个词对了 3 个）");
  await shot('B1-fast');

  console.log('B3 ⌘I 收藏这句');
  await page.keyboard.press('Enter');
  await waitBoxes(3);
  ok((await focusedBox()) === 0, '光标在听写框里');
  // Untouched keys still work: Space in an empty blank plays / pauses, the Space right after
  // an auto-jump is swallowed, ⌘X shows the word.
  const paused = () => page.evaluate(() => document.querySelector('video').paused);
  const p0 = await paused();
  await page.keyboard.press('Space');
  await page.waitForTimeout(200);
  ok((await paused()) !== p0, '空格子按空格 = 播放 / 暂停');
  await page.keyboard.press('Space');
  await page.waitForTimeout(200);
  ok((await paused()) === p0, '再按一下切回来');
  await page.keyboard.type("That's");
  ok((await focusedBox()) === 1, "That's 判对跳格");
  await page.keyboard.press('Space');
  await page.waitForTimeout(200);
  ok((await focusedBox()) === 1 && (await values())[1] === '' && (await paused()) === p0, '跳格后紧跟的空格被吃掉（不跳、不播）');
  await page.keyboard.press('Meta+KeyX');
  await see(page.locator('form .pointer-events-none', { hasText: 'all' }), '⌘X 提示出「all」');
  console.log('  ✓ ⌘X 提示照常');
  const typed = await values();
  await page.keyboard.press('Meta+KeyI');
  await see(page.getByRole('button', { name: /^取消收藏/ }), '按 ⌘I 后书签变「取消收藏」');
  ok((await values()).join('|') === typed.join('|'), '⌘I 没往框里打字');
  let saved = await page.evaluate(async () => (await import('/utils/review.ts')).getAllCards());
  ok(saved.some(c => c.text.startsWith("That's all") && c.saved), '句子库里这句已收藏');
  ok((await page.getByRole('button', { name: /^取消收藏/ }).getAttribute('title')).includes('⌘I'), '书签悬停提示带 ⌘I');
  await shot('B3-saved');
  await page.keyboard.press('Meta+KeyI');
  await see(page.getByRole('button', { name: /^收藏这句/ }), '再按 ⌘I 取消收藏');
  await page.getByRole('button', { name: /^收藏这句/ }).click();
  await see(page.getByRole('button', { name: /^取消收藏/ }), '点按钮同样切换');
  await page.keyboard.press('Meta+KeyI');
  await see(page.getByRole('button', { name: /^收藏这句/ }), '按钮和键交替切换一致');

  console.log('B2 段末跳过');
  const mid = await todayLines();
  ok(mid === before + 2, `前面正常练完的两句照常计数（${before} → ${mid}）`);
  await boxes.nth(0).click();
  await page.keyboard.press('Meta+KeyT');
  await see(page.getByText('第 1 段完成'), '段内最后一句 ⌘T → 「第 1 段完成」');
  ok((await todayLines()) === mid, `跳过的这句不计入（仍是 ${mid}）`);
  await shot('B2-section-done');
  await page.getByRole('button', { name: '今天到此为止' }).click();

  console.log('复习句子卡：宽松 + 差一点');
  await nav('句子');
  await page.getByRole('button', { name: /^开始复习/ }).click();
  await waitBoxes(6);
  for (const w of ['HELLO', 'i']) await page.keyboard.type(w);
  await page.keyboard.type('walk');
  await page.keyboard.press('Space');
  ok(/border-dashed/.test(await classOf(2)), '复习卡：walk 离开后朱红虚线');
  for (const w of ['to', 'the', 'zoo.']) await page.keyboard.type(w);
  await page.keyboard.press('Enter');
  await see(page.getByText('6 个词对了 5 个'), '复习卡交卷 5/6');
  ok((await page.locator('[data-lookup-line] button', { hasText: 'walked' }).locator('span.text-accent').allInnerTexts()).join('') === 'ed', '复习卡答案只红 ed');
  await shot('A3-review-card');
  await page.keyboard.press('Escape');

  console.log('A 关掉宽松判对 = 严格');
  await page.evaluate(async () => {
    // Back to the first line of the same video.
    await (await import('/utils/fileSystemAccess.ts')).updateVideoInDB('zoo', r => ({ ...r, currentSubtitleIndex: 0, currentSectionIndex: 0, completionRate: 0 }));
    const c = JSON.parse(localStorage.getItem('linguaclip_practice_config'));
    localStorage.setItem('linguaclip_practice_config', JSON.stringify({ ...c, looseJudge: false }));
  });
  await page.reload();
  await start();
  await waitBoxes(6);
  await page.keyboard.type('HELLO');
  await page.waitForTimeout(300);
  ok((await focusedBox()) === 0, '严格：整词大写「HELLO」不判对、不跳格');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+KeyA' : 'Control+KeyA');
  await page.keyboard.type('Hello');
  ok((await focusedBox()) === 1, '严格：Hello 照旧判对跳格');
  await page.keyboard.type('I');
  await page.keyboard.type('walk');
  await page.keyboard.press('Space');
  ok(!(await classOf(2)).includes('border-dashed'), '严格：没有差一点虚线');
  for (const w of ['to', 'the', 'ZOO']) await page.keyboard.type(w);
  await page.keyboard.press('Enter');
  await see(page.getByText('6 个词对了 4 个'), '严格：ZOO、walk 都算错（4/6）');
  await shot('A4-strict');

  console.log('设置');
  await page.mouse.move(300, 30);
  await page.getByRole('button', { name: '回到你的视频列表' }).click();
  await nav('设置');
  const box = page.getByRole('checkbox', { name: '宽松判对' });
  await see(box, '设置 → 练习「宽松判对」');
  ok(!(await box.isChecked()), '关掉后开关显示为关');
  await box.check();
  ok(JSON.parse(await page.evaluate(() => localStorage.getItem('linguaclip_practice_config'))).looseJudge === true, '打开后写回 looseJudge: true');
  await shot('S1-settings-practice');
  await page.getByRole('radio', { name: '快捷键', exact: true }).click();
  await see(page.getByText('收藏这句'), '设置 → 快捷键「听写」页有「收藏这句」');
  await shot('S2-settings-keys');

  console.log('B1 乱序填词：跳过已填对的格 + 补齐最后一处空缺自动过关 + 200ms 内回车立即过关');
  await page.evaluate(async () => {
    await (await import('/utils/fileSystemAccess.ts')).updateVideoInDB('zoo', r => ({ ...r, currentSubtitleIndex: 0, currentSectionIndex: 0, completionRate: 0 }));
  });
  await start();
  await waitBoxes(6);
  await boxes.nth(2).click();
  await page.keyboard.type('walked');
  ok((await focusedBox()) === 3, '先填第 3 格 walked → 跳到第 4 格');
  await boxes.nth(0).click();
  await page.keyboard.type('Hello');
  ok((await focusedBox()) === 1, '从头填第 1 格 Hello → 跳到第 2 格');
  await page.keyboard.type('I');
  ok((await focusedBox()) === 3, '填对第 2 格 I → 自动跳过已填对的第 3 格，落进第 4 格');
  await boxes.nth(4).click();
  await page.keyboard.type('the');
  await page.keyboard.type('zoo');
  await page.waitForTimeout(300);
  ok((await boxes.count()) === 6, '末尾填完但中间第 4 格还空着：不提前交卷');
  await boxes.nth(3).click();
  await page.keyboard.type('to');
  await see(page.getByText('6 个词对了 6 个'), '回头补齐中间最后一个空缺词 to → 自动过关（6 个词对了 6 个）', 3000);
  console.log('  ✓ 回头补齐中间最后一个空缺词自动过关');
  await shot('B1-out-of-order');

  await page.keyboard.press('Enter');
  await waitBoxes(3);
  await boxes.nth(2).click();
  await page.keyboard.type('home');
  await boxes.nth(0).click();
  await page.keyboard.type("I'm");
  ok((await focusedBox()) === 1, "先填末格 home 再填首格 I'm → 跳到中间第 2 格");
  await page.keyboard.type('going');
  await page.keyboard.press('Enter');
  await see(page.getByText('3 个词对了 3 个'), '中间格补齐整句后立即按 Enter → 直接交卷过关');
  await page.waitForTimeout(300);
  await see(page.getByText('3 个词对了 3 个'), '200ms 定时器已清，不会二次触发跳到下一句');
  console.log('  ✓ 中间格补齐后 200ms 内按 Enter 立即过关且不二次换句');

  if (t.errors.length) throw new Error('页面报错：' + t.errors.join(' / '));
  console.log('全部通过，截图在 ' + t.out);
} catch (e) {
  await shot('FAIL').catch(() => {});
  console.log('FAIL: ' + e.message + '（截图 ' + t.out + '/FAIL.png）');
  process.exitCode = 1;
} finally { await t.close(); }
