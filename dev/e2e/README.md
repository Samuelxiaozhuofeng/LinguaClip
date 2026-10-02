# 浏览器回归（dev/e2e）

```bash
node dev/e2e/run.mjs
```

- 第一次跑会把 Playwright 装到 `~/.cache/linguaclip-e2e/`（不进项目），之后复用；用系统 Chrome 无头跑，中文界面，每次都是全新的浏览器资料（IndexedDB / localStorage 空的）。
- 3000 端口上已经是 LinguaClip 的 `npm run dev` 就直接用；否则自己起一个（3000 被别的程序占了就换个空端口），跑完关掉。
- 要样片 `~/Movies/LinguaClip/Me at the zoo [jNQXAC9IVRw].mp4` + `.srt`（`dev/browserMock.ts` 的文件对话框返回它），缺了直接报「缺样片：路径」。
- 每个流程打印 PASS / FAIL；失败的截图和 vite 日志在输出的临时目录里，后面依赖它的流程标 SKIP；有没过的退出码为 1。

## 临时脚本（针对某次改动补测）

写在 scratchpad 里，从 `lib.mjs` 起步；Playwright、dev 服务、端口、浏览器都不用自己管，也不用去别的会话的 scratchpad 里找旧脚本。

```js
import { open, seed, record, SAMPLE, AUDIO } from '<仓库绝对路径>/dev/e2e/lib.mjs';
const t = await open('<scratchpad 绝对路径>');   // vite.log 落在这里；返回 { page, see, gone, nav, errors, url, close }
const { page, see, nav } = t;
try {
  // 跳过「添加视频」弹窗，直接把记录写进库；第三个参数是 localStorage（对象自动转 JSON）
  await seed(page, [
    record(SAMPLE, '.mp4', { id: 'v1', displayName: 'Zoo' }),
    record(AUDIO, '.mp3', { id: 'p1', displayName: 'Quien', podcast: { show: 'Coffee Break Spanish', feed: 'https://x/feed', guid: 'g1', name: 'x' } }),
  ], { linguaclip_watch_prefs: { listenIntro: true }, linguaclip_last_way: { v1: 'watch' } });

  await nav('播客');                                                            // 顶栏：视频 / 播客 / 句子 / 单词 / 设置
  await page.getByRole('button', { name: '继续精听' }).first().click();         // 播客卡片直接进精听页
  await see(page.locator('header [aria-current=step]'), '步骤条');              // 当前步
  await page.locator('header button').first().click();                          // 精听页返回

  await nav('视频');
  await page.getByRole('button', { name: '继续看剧' }).first().click();         // last_way = watch → 直接开播
  await see(page.getByRole('button', { name: 'elephants', exact: true }), '看剧第 1 句字幕');
  await page.screenshot({ path: `${t.out}/watch.png` });
  if (t.errors.length) console.log('页面报错', t.errors);
} finally { await t.close(); }
```

- `SAMPLE` = `~/Movies/LinguaClip/Me at the zoo [jNQXAC9IVRw]`（3 句英语），`AUDIO` = `~/Movies/LinguaClip/¿Quien quiere, puede [fe5743fc]`（一集西语播客，6 段）；都是不带扩展名的路径，旁边要有同名 `.srt`。
- 没 `seed` 的新视频第一次点会弹「这次怎么练」面板：`page.getByRole('dialog', { name: '这次怎么练' })`，里面的练法是 `radio`，开始按钮是 `button`（写法见 `practice.mjs` / `watch.mjs`）。
- 按钮名字：拿界面上的中文去 `utils/i18n.zh.ts` 里搜，别猜键名。`<audio>` / `<video>` 元素不可见，别 `see` 它；读播放位置用 `page.evaluate(() => document.querySelector('audio').currentTime)`。
- 读库：`page.evaluate(async () => (await import('/utils/review.ts')).getAllCards())`（vite 直接给源文件，任何 `utils/*.ts` 的导出都能这样调）。
- 同一类检查做第二次，就把它写成一个流程加进下面的回归。

## 浏览器模式备忘

`dev/browserMock.ts` 冒充 Tauri 外壳（只在浏览器 dev 下加载）。`window.__MOCK__` 的全部开关写在它的文件头注释里，用之前先读那一段。常用的：

- 本地文件经 vite `/@fs` 读真文件（允许 `~/Movies`、`~/Downloads`、项目目录）。文件对话框默认返回 `SAMPLE` 样片（视频或 .srt 看过滤器）；`__MOCK__.pick = '绝对路径'` 指定下一次返回值。
- Rust 命令不执行，只记到 `__MOCK__.calls`；`write_cache` 存内存，刷新即清。导入进度手动发：`__MOCK__.emit('import-progress', { id, stage: 'done', videoPath, subtitleText })`，`id` 从 `calls` 里的 `start_import` 取。
- 日语词典默认「没下载」；`__MOCK__.jaDict = true` 当已下载（刷新即忘）。
- AI / Anki 请求经 vite `/__proxy` 转发，能打到真实端点。React StrictMode 下 dev 的副作用跑两遍（AI 请求发两次），正式包只发一次，别误判成 bug。
- 浏览器里的 IndexedDB 和桌面 App 是两份，测试数据不会污染真实记录。
- 进听写：添加视频 → 开始练习 → 等输入格出现（先放完一遍听、再切到输入，写法见 `practice.mjs` 的 `dictate`）；交卷后答案行 `section p button` 可点查词，释义弹窗是 `[role=dialog]`。
- 同时起两个 vite（如这份 + 开源副本）会共用 `node_modules/.vite` 缓存互相覆盖，页面报 Invalid hook call：一次只起一个，换目录时加 `--force`。
- 用内置浏览器（不是 Playwright）时：pane 隐藏时截图可能是旧帧，读状态用取页面文字 / 执行脚本；按空格 / 回车要往 `document.activeElement` 派发 `KeyboardEvent`；输入框改值用原生 value setter + `input` 事件。

## 回归覆盖（按顺序，后一步接着前一步的状态）

| 文件 | 流程 |
|---|---|
| `practice.mjs` | 1 添加视频（选视频 + 字幕）→ 首页卡片；2 按段练 → 听写第一句 → 全对；3 收藏 → 「句子」页有卡 → 复习听写 + 打「良好」；4 回首页点卡片 → 不弹面板，接着第 2 句 |
| `watch.mjs` | 5 「…」→ 换个练法 → 看剧，字幕从第 1 句换到第 2 句，首页卡片变「继续看剧」 |
| `persist.mjs` | 6 刷新后记录和卡都在；7 删视频 → 首页空、它的复习卡一起删、刷新后不弹「旧卡」窗 |
| `backup.mjs` | 8 添加视频、收藏一句 → 设置里「备份…」→ 删视频 → 「恢复…」选那份 → 视频、卡、进度都回来；9 坏备份 → 被拒、数据原样；10 解包报错 → 失败界面（重试仍失败、重开不自动重跑）→「退回恢复前」；11 再失败 →「放弃恢复」→ 进 App、数据还在 |

覆盖不到（交付时照旧列给用户真机验）：真实导入（yt-dlp / whisper 转录）、系统文件对话框、Finder 拖放、Anki、WKWebView 独有的渲染 / 行为差异、Windows。
