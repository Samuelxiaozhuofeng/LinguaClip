// What outlives the page: records and cards after a reload, and what deleting the video takes with it.
import { readFileSync } from 'node:fs';

const NAME = 'Me at the zoo [jNQXAC9IVRw].mp4';
const firstLine = sample => readFileSync(`${sample}.srt`, 'utf8').split(/\r?\n/)[2].trim();

export default [
  {
    name: '刷新页面后记录和卡片都还在',
    run: async ({ page, see, nav, sample }) => {
      await page.reload();
      await see(page.getByText(NAME), '刷新后首页卡片');
      await see(page.getByText(/看到 \d\d:\d\d · 继续看剧/), '刷新后卡片仍是「继续看剧」');
      await nav('句子');
      await see(page.getByText(firstLine(sample)), '刷新后「句子」页的卡');
      await nav('视频');
    },
  },
  {
    name: '删视频 → 卡片消失，它的复习卡一起删',
    run: async ({ page, see, gone, nav, sample }) => {
      await page.getByRole('button', { name: '更多' }).first().click();
      await page.getByRole('menuitem', { name: '删除记录' }).click();
      const ask = page.getByRole('dialog', { name: '删除这个视频？' });
      await see(ask.getByText(/复习里这个视频的 1 张句子卡和单词卡也会一起删掉/), '删除确认里说 1 张卡会一起删');
      await ask.getByRole('button', { name: '删除' }).click();
      const file = page.getByRole('dialog', { name: '视频文件也一起删吗？' });
      await file.getByRole('button', { name: '只删记录，保留文件' }).click();
      await see(page.getByText('这里还空着'), '首页变成「这里还空着」');
      await gone(page.getByText(NAME), '首页视频卡片');
      await nav('句子');
      await see(page.getByText('共 0 个'), '「句子」页「共 0 个」');
      await gone(page.getByText(firstLine(sample)), '「句子」页里这张卡');
      // Nothing left behind: no leftover-cards question after a reload.
      await page.reload();
      await see(page.getByText('这里还空着'), '刷新后首页仍是空的');
      if (await page.getByRole('dialog').count()) throw new Error(`刷新后弹了窗：${await page.getByRole('dialog').first().innerText()}`);
    },
  },
];
