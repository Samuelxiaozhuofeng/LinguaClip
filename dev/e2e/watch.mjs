// Watch mode: switch the video to 看剧 from the card's「…」, subtitles follow the picture.
export default [
  {
    name: '看剧模式进得去、字幕跟着走',
    run: async ({ page, see, gone }) => {
      await page.getByRole('button', { name: '更多' }).first().click();
      await page.getByRole('menuitem', { name: '换个练法' }).click();
      const panel = page.getByRole('dialog', { name: '这次怎么练' });
      await panel.getByRole('radio', { name: '看剧' }).click();
      await panel.getByRole('button', { name: '开始看剧' }).click();
      // It starts playing by itself. Line 1 (0.55–7.25 s), then line 2 takes its place as the clip plays on.
      const first = page.getByRole('button', { name: 'elephants', exact: true });
      const second = page.getByRole('button', { name: 'fronts', exact: true });
      await see(first, '第 1 句字幕（elephants）');
      await see(second, '播到第 2 句时字幕换成第 2 句（fronts）', 15_000);
      await gone(first, '第 1 句字幕');
      await page.mouse.move(300, 30); // the back button shows near the top
      await page.getByRole('button', { name: '回到你的视频列表' }).click();
      await see(page.getByText(/看到 \d\d:\d\d · 继续看剧/), '首页卡片「看到 mm:ss · 继续看剧」');
    },
  },
];
