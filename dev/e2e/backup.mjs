// Backup and restore (docs/backup.md): back up, delete, restore everything back; a bad
// backup is refused; a restore that fails half way shows the failure screen, from which
// "go back to before the restore" and "give up restoring" both lead back into the app.
import { readFileSync } from 'node:fs';
import os from 'node:os';

const NAME = 'Me at the zoo [jNQXAC9IVRw].mp4';
const firstLine = sample => readFileSync(`${sample}.srt`, 'utf8').split(/\r?\n/)[2].trim();
const btn = (page, name) => page.getByRole('button', { name, exact: true });
const OUTSIDE = `${os.homedir()}/Desktop`; // where the mock's save dialog puts a backup

// Settings → 恢复… → 选备份文件… (the mock's open dialog returns `pick`, else the last one saved).
const pickRestore = async ({ page, see, nav }, pick) => {
  await nav('设置');
  await btn(page, '恢复…').click();
  const list = page.getByRole('dialog', { name: '恢复备份' });
  await see(list, '「恢复备份」窗口');
  if (pick) await page.evaluate(p => { window.__MOCK__.pick = p; }, pick);
  await list.getByRole('button', { name: '选备份文件…' }).click();
};

// A backup that passes every check but holds nothing, with files to unpack (so a failing unpack bites).
const plantEmpty = (page, path) => page.evaluate(([path]) => {
  const manifest = { format: 1, app: '0.2.1', createdAt: Date.now(), platform: 'mac', ownDir: '/Users/someone/Movies/LinguaClip',
    videos: 0, cards: 0, hadLicense: true, files: true, clips: [] };
  const data = { videos: [], cards: [], reviewMeta: [], localStorage: { linguaclip_lang: 'en' } };
  window.__MOCK__.putBackup(path, { manifest: JSON.stringify(manifest), data: JSON.stringify(data), files: {} });
}, [path]);

const confirmRestore = async ({ page, see }, body) => {
  const ask = page.getByRole('dialog', { name: '替换现在的全部记录？' });
  await see(ask, '确认替换的对话框');
  await see(ask.getByText(body), `确认框里写着「${body}」`);
  await ask.getByRole('button', { name: '恢复' }).click();
};

const homeHasIt = async ({ page, see, nav, sample }, what) => {
  await nav('视频');
  await see(page.getByText(NAME), `${what}：首页视频卡片`, 20_000);
  await see(page.getByText('1 / 3 句 · 继续听写'), `${what}：进度「1 / 3 句 · 继续听写」`);
  await nav('句子');
  await see(page.getByText(firstLine(sample)), `${what}：「句子」页的卡`);
  await nav('视频');
};

export default [
  {
    name: '备份 → 删视频 → 恢复 → 视频、卡、进度都回来',
    run: async (ctx) => {
      const { page, see, gone, nav } = ctx;
      // Add the clip, bookmark its first line, move on to line 2.
      await page.getByRole('button', { name: '添加视频' }).first().click();
      const add = page.getByRole('dialog', { name: '添加视频' });
      await add.getByRole('button', { name: '选择本机视频' }).click();
      await add.getByRole('button', { name: '选字幕文件' }).click();
      await see(add.getByText('Me at the zoo [jNQXAC9IVRw].srt'), '弹窗里显示选中的字幕');
      await add.getByRole('button', { name: '开始练习' }).click();
      const panel = page.getByRole('dialog', { name: '这次怎么练' });
      await panel.getByRole('radio', { name: '按段从头练' }).click();
      await panel.getByRole('button', { name: '开始练习' }).click();
      await see(page.getByText('第 1 / 3 句'), '练习页「第 1 / 3 句」');
      await page.getByRole('button', { name: '收藏这句' }).click();
      await see(page.getByRole('button', { name: '取消收藏' }), '收藏按钮变成「取消收藏」');
      await page.getByRole('button', { name: /^下一句/ }).first().click(); // the transport's skip button
      await see(page.getByText('第 2 / 3 句'), '进到「第 2 / 3 句」');
      await page.getByRole('button', { name: '回到你的视频列表' }).click();
      await homeHasIt(ctx, '备份前');

      // Back up.
      await nav('设置');
      await see(page.getByText(/数据备份 · /), '设置底部「数据备份」那行');
      await btn(page, '备份…').click();
      const done = page.getByRole('dialog', { name: '已备份' });
      await see(done.getByText('1 个视频的记录、1 张卡。'), '「已备份：1 个视频的记录、1 张卡」');
      await done.getByRole('button', { name: '好的' }).click();

      // Delete the video: its card goes too.
      await nav('视频');
      await page.getByRole('button', { name: '更多' }).first().click();
      await page.getByRole('menuitem', { name: '删除记录' }).click();
      await page.getByRole('dialog', { name: '删除这个视频？' }).getByRole('button', { name: '删除' }).click();
      await page.getByRole('dialog', { name: '视频文件也一起删吗？' }).getByRole('button', { name: '只删记录，保留文件' }).click();
      await see(page.getByText('这里还空着'), '删完首页变空');
      await nav('句子');
      await see(page.getByText('共 0 个'), '删完「句子」页「共 0 个」');

      // Restore the file just saved.
      await pickRestore(ctx);
      await confirmRestore(ctx, /1 个视频、1 张卡）替换现在的全部记录（现在：0 个视频、0 张卡）/);
      const back = page.getByRole('dialog', { name: '已恢复' });
      await see(back.getByText('恢复了 1 个视频、1 张卡。'), '重新加载后「已恢复」', 20_000);
      await back.getByRole('button', { name: '好的' }).click();
      await gone(back, '「已恢复」对话框');
      await homeHasIt(ctx, '恢复后');
      const staged = await page.evaluate(() => Object.keys(JSON.parse(sessionStorage.getItem('__mock_backups') || '{}')).filter(p => p.endsWith('restore-staged.zip')));
      if (staged.length) throw new Error('恢复完 restore-staged.zip 还在');
    },
  },
  {
    name: '坏备份 → 被拒，现有数据原样',
    run: async (ctx) => {
      const { page, see } = ctx;
      const bad = `${OUTSIDE}/bad-backup.zip`;
      // The good backup with one record's subtitle file name pointing out of its folder.
      await page.evaluate(([bad]) => {
        const all = JSON.parse(sessionStorage.getItem('__mock_backups'));
        const good = all[sessionStorage.getItem('__mock_last_saved')];
        const data = JSON.parse(good.data);
        data.videos[0].subtitleFileName = '../../evil.srt';
        window.__MOCK__.putBackup(bad, { ...good, data: JSON.stringify(data) });
      }, [bad]);
      await pickRestore(ctx, bad);
      const no = page.getByRole('dialog', { name: '没法恢复' });
      await see(no.getByText(/这份备份文件坏了.*subtitleFileName/), '「没法恢复：备份文件坏了」');
      await no.getByRole('button', { name: '好的' }).click();
      if (await page.getByRole('dialog', { name: '替换现在的全部记录？' }).count()) throw new Error('坏备份也弹了确认替换');
      const pending = await page.evaluate(() => localStorage.getItem('linguaclip_restore_pending'));
      if (pending) throw new Error(`坏备份留下了恢复标记：${pending}`);
      await homeHasIt(ctx, '被拒后');
    },
  },
  {
    name: '恢复中途失败 → 失败界面 → 退回恢复前',
    run: async (ctx) => {
      const { page, see } = ctx;
      const target = `${OUTSIDE}/empty-backup.zip`;
      await plantEmpty(page, target);
      await page.evaluate(() => window.__MOCK__.failUnpack('disk full (mock)'));
      await pickRestore(ctx, target);
      await confirmRestore(ctx, /0 个视频、0 张卡）替换现在的全部记录（现在：1 个视频、1 张卡）/);
      const fail = page.getByRole('alertdialog', { name: '恢复没完成' });
      await see(fail.getByText('恢复没完成：disk full (mock)'), '失败界面「恢复没完成：<原因>」', 20_000);
      await see(fail.getByText('现在的记录可能只恢复了一半。'), '失败界面的说明');
      // Retry fails the same way and stays put.
      await btn(fail, '重试').click();
      await see(fail.getByText('恢复没完成：disk full (mock)'), '重试后仍是失败界面');
      // A relaunch after a failed try doesn't run it again by itself.
      await page.reload();
      await see(fail.getByText('上次恢复到一半，App 被关掉了。'), '重新打开后直接是失败界面', 20_000);
      await btn(fail, '退回恢复前').click();
      const back = page.getByRole('dialog', { name: '已恢复' });
      await see(back.getByText('恢复了 1 个视频、1 张卡。'), '退回后「已恢复 1 个视频、1 张卡」', 20_000);
      await back.getByRole('button', { name: '好的' }).click();
      await homeHasIt(ctx, '退回恢复前后');
      const lang = await page.evaluate(() => localStorage.getItem('linguaclip_lang'));
      if (lang === 'en') throw new Error('退回恢复前后界面语言却是那份失败备份里的 en');
    },
  },
  {
    name: '恢复失败 →「放弃恢复」→ 进 App，数据还在',
    run: async (ctx) => {
      const { page, see } = ctx;
      const target = `${OUTSIDE}/empty-backup.zip`;
      await pickRestore(ctx, target);
      await confirmRestore(ctx, /0 个视频、0 张卡/);
      const fail = page.getByRole('alertdialog', { name: '恢复没完成' });
      await see(fail.getByText('恢复没完成：disk full (mock)'), '失败界面', 20_000);
      await page.evaluate(() => window.__MOCK__.failUnpack(null));
      await btn(fail, '放弃恢复').click();
      await homeHasIt(ctx, '放弃恢复后');
      const left = await page.evaluate(() => [localStorage.getItem('linguaclip_restore_pending'),
        Object.keys(JSON.parse(sessionStorage.getItem('__mock_backups') || '{}')).some(p => p.endsWith('restore-staged.zip'))]);
      if (left[0] || left[1]) throw new Error(`放弃后还留着：标记 ${left[0]}，staged ${left[1]}`);
    },
  },
];
