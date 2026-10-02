// Practice flows: add the sample clip, dictate its first line, save it and review it
// in the 句子 library, then pick the video up again from the home card.
import { readFileSync } from 'node:fs';

const firstLine = sample => readFileSync(`${sample}.srt`, 'utf8').split(/\r?\n/)[2].trim();
const words = text => text.match(/[A-Za-z']+/g);
const NAME = 'Me at the zoo [jNQXAC9IVRw].mp4';

// Type the line the way a user does: each right word moves the cursor on by itself
// (DictationLine, after 100 ms), and Enter right after the last word hands it in.
const dictate = async ({ page, see }, text) => {
  // The answer boxes have no name; the library's search box (under the review overlay) has a placeholder.
  const boxes = page.getByRole('textbox').and(page.locator(':not([placeholder])'));
  await see(boxes, '听写输入格（先放完一遍才出现）', 25_000);
  const w = words(text);
  if ((await boxes.count()) !== w.length) throw new Error(`输入格 ${await boxes.count()} 个，句子有 ${w.length} 个词`);
  const focused = i => boxes.nth(i).evaluate(el => new Promise((ok, no) => {
    const end = Date.now() + 5000;
    const poll = () => (document.activeElement === el ? ok() : Date.now() > end ? no(new Error('光标没自动跳到下一格')) : setTimeout(poll, 20));
    poll();
  }));
  for (const [i, word] of w.entries()) {
    await focused(i);
    await page.keyboard.type(word);
  }
  await page.keyboard.press('Enter');
};

export default [
  {
    name: '添加视频 → 首页出现卡片',
    run: async ({ page, see }) => {
      await page.getByRole('button', { name: '添加视频' }).first().click();
      const add = page.getByRole('dialog', { name: '添加视频' });
      await add.getByRole('button', { name: '选择本机视频' }).click();
      await see(add.getByText(NAME), '弹窗里显示选中的视频');
      await add.getByRole('button', { name: '选字幕文件' }).click();
      await see(add.getByText('Me at the zoo [jNQXAC9IVRw].srt'), '弹窗里显示选中的字幕');
      await add.getByRole('button', { name: '开始练习' }).click();
      // A new video asks how to practise first; closing that leaves it on the shelf.
      await see(page.getByRole('dialog', { name: '这次怎么练' }), '「这次怎么练」面板');
      await page.keyboard.press('Escape');
      await see(page.getByText(NAME), '首页卡片上的视频名');
      await see(page.getByText('0 / 3 句 · 继续听写'), '卡片进度「0 / 3 句 · 继续听写」');
    },
  },
  {
    name: '开始练习 → 听写一句 → 判对',
    run: async (ctx) => {
      const { page, see } = ctx;
      await page.getByRole('button', { name: '继续听写' }).first().click();
      const panel = page.getByRole('dialog', { name: '这次怎么练' });
      await panel.getByRole('radio', { name: '按段从头练' }).click();
      await panel.getByRole('button', { name: '开始练习' }).click();
      await see(page.getByText('第 1 / 3 句'), '练习页「第 1 / 3 句」');
      const text = firstLine(ctx.sample);
      await dictate(ctx, text);
      const n = words(text).length;
      await see(page.getByText(`${n} 个词对了 ${n} 个`), `交卷后「${n} 个词对了 ${n} 个」`);
    },
  },
  {
    name: '收藏这句 → 「句子」页出现卡片 → 复习打分',
    run: async (ctx) => {
      const { page, see, nav } = ctx;
      await page.getByRole('button', { name: '收藏这句' }).click();
      await see(page.getByRole('button', { name: '取消收藏' }), '收藏按钮变成「取消收藏」');
      await page.getByRole('button', { name: '下一句', exact: true }).click();
      await see(page.getByText('第 2 / 3 句'), '进到「第 2 / 3 句」');
      await page.getByRole('button', { name: '回到你的视频列表' }).click();
      await nav('句子');
      const text = firstLine(ctx.sample);
      await see(page.getByText(text), '「句子」页列表里的这张卡');
      await page.getByRole('button', { name: /^开始复习 · 1/ }).click();
      await see(page.getByText('1 / 1'), '复习进度「1 / 1」');
      await dictate(ctx, text);
      await page.getByRole('button', { name: /良好/ }).click();
      await see(page.getByText('这一轮复习完了'), '「这一轮复习完了」');
      await page.getByRole('button', { name: '完成' }).click();
      await see(page.getByText('今天没有要复习的'), '打分后「今天没有要复习的」');
      await see(page.getByText(text), '卡片还在列表里');
    },
  },
  {
    name: '回首页再点同一个视频 → 直接续练',
    run: async ({ page, see, nav }) => {
      await nav('视频');
      await see(page.getByText('1 / 3 句 · 继续听写'), '卡片进度「1 / 3 句 · 继续听写」');
      await page.getByRole('button', { name: '继续听写' }).first().click();
      await see(page.getByText('第 2 / 3 句'), '直接接着练「第 2 / 3 句」');
      if (await page.getByRole('dialog', { name: '这次怎么练' }).count()) throw new Error('又弹了「这次怎么练」面板，应直接开练');
      await page.getByRole('button', { name: '回到你的视频列表' }).click();
      await see(page.getByText(NAME), '回到首页');
    },
  },
];
