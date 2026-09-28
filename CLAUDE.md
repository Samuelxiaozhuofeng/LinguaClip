# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 先读 docs/

`docs/README.md` 是这个仓库的技术速览（目录表 + 本地数据结构），`docs/desktop.md` 是 Tauri 桌面版的运行时约定，`docs/import.md` 是自动生成字幕那条链路，`docs/watch.md` 是看剧模式。动手前读对应那份，别只靠代码猜。

根目录除 `README.md`（上游 AI Studio 模板，内容已过时）外的 `*_FIX.md` / `*_SUMMARY.md` / `拆分计划*.md` 是早期开发日志，不是当前规格。

## 命令

```bash
npx tauri dev          # 桌面开发：自己拉起 vite:3000（Claude 验功能走浏览器，见「验证流程」）
npx tsc --noEmit       # 类型检查
npm run release        # tauri build --bundles app，然后装进 /Applications
npm run release:public # 同一个包再压成 src-tauri/target/LinguaClip.zip，发 GitHub Release 用（包里不带任何 AI 密钥，AI 全靠用户在设置里自填）
cargo test --manifest-path src-tauri/Cargo.toml   # Rust 侧（import.rs 有单测）
node test-resegment.mjs   # 切句逻辑自检（bundle 真模块，不是复制逻辑）
node test-sections.mjs    # 分段逻辑自检（同上）
node test-cloze.mjs       # 挖空逻辑 + 缓存自检（同上）
node test-dictionary.mjs  # 查词：认语言 + 有道解析 + 欧路挑词（同上）
node test-anki.mjs        # Anki 旧配置合并成一种卡 + 单词加粗（同上）
node test-japanese.mjs    # 日语切词组 + 假名判对 + AI 校对回答校验（读 node_modules/kuromoji/dict）
node test-custom.mjs      # 定制练习：挑句（水平区间、时长、照常播放 / 跳过、从头再挑）+ AI 分级回答 / 缓存校验
node test-wordtimes.mjs   # 逐词时间：空格对到 words.json 的哪一段 + ⌘K / ⌘J 实际播放区间
node test-watch.mjs       # 看剧：某一秒屏幕上是哪一句（lineAt）
node test-reader.mjs      # 阅读器：查过的词怎么记（日语原形）+ 看剧时认回来、AI 译文回答 / 缓存 / 删视频中途取消
```

前端没有测试框架，逻辑自检就是根目录那几个 `node` 脚本（`test-tokenizer.js` / `test-flexible-case.js` 是早期的复制逻辑版，参考价值有限）。

## 验证流程（改完功能必须走）

**Mac 正式包本机打；Windows 包只由 GitHub CI 打**（`.github/workflows/windows.yml`，只在用户说要打时手动触发：`gh workflow run windows.yml`，push 不会触发；先在 Windows 上跑一遍下载组件 + 转录的真链路，安装包挂在那次运行的 artifact 里），用户在 Windows 虚拟机里验。平台差异收口在 `src-tauri/src/paths.rs`（目录、起子进程）和 `utils/platform.ts`；Windows 抽声音用 `decode.rs`（symphonia），不用 afconvert。用户验收在正式包里；交给用户之前，Claude 先在浏览器里把改动走一遍，拿到真实运行证据。顺序：

1. `npx tsc --noEmit` + 相关 `node test-*.mjs`（碰 Rust 再跑 `cargo test`）。
2. **浏览器实测**：启 `npm run dev`（`.claude/launch.json` 的 `dev`），按用户会做的操作走一遍改动，外加改动碰过的原有操作；截图给用户当证据。**首选 Playwright**（后台无头跑、不占用户屏幕、脚本可重跑）；Chrome 插件（claude-in-chrome）只在要用用户已登录的账号、或用户想亲眼看着操作时用——实测它开在用户正在用的 Chrome 里、视频加载不出来、标签页会中途丢失。没有内置浏览器（`preview_start`）时也走 Playwright。
   - Playwright 不装进项目：在 scratchpad 里 `npm i playwright`，`chromium.launch({ channel: 'chrome' })` 用系统 Chrome（自带 H.264，样片 mp4 才能播），`newPage({ locale: 'zh-CN' })`。
   - 按钮用 `getByRole('button', { name })` 找，名字照 `utils/i18n.zh.ts` 抄，别猜（如「添加视频」「选择本机视频」「选字幕文件」「开始练习」；开始练习后先弹「这次怎么练」面板，`getByRole('dialog', { name: '这次怎么练' })` 里点「开始练习」才进练习页；练法选 `radio` 「看剧」再点「开始看剧」进看剧页，面板会记住上次选的练法）。
   - 进听写：先 `page.evaluate` 设 `window.__MOCK__`（`jaDict` / `pick`），添加视频 → 开始练习 → `video.play()`，等 `section input` 出现（先放完一遍听、再切到输入）；`fill` 各格后按 Enter 交卷，答案行 `section p button` 可点查词，释义弹窗是 `[role=dialog]`。
3. `npm run release` 打正式包装进 /Applications，给用户验收路径（打开哪里 → 做什么 → 应该看到什么），并写明哪些是浏览器验不到、需要真机确认的。

浏览器模式怎么运作（`dev/browserMock.ts` 冒充 Tauri 外壳，只在浏览器 dev 下加载，正式包和 `tauri dev` 里都没有）：

- 本地文件经 vite `/@fs` 读真文件（允许 `~/Movies`、`~/Downloads`、项目目录；cookies / `.yt-login` 已屏蔽）。
- 日语词典默认「没下载」；`window.__MOCK__.jaDict = true` 当已下载，文件从 `node_modules/kuromoji/dict` 读（刷新即忘）。
- 文件对话框默认返回 `~/Movies/LinguaClip/Me at the zoo` 样片（视频或 .srt 看过滤器）；`window.__MOCK__.pick = '绝对路径'` 指定下一次返回值。
- Rust 命令不执行，只记到 `window.__MOCK__.calls`；`write_cache` 存内存，刷新即清。
- 导入进度手动发：`window.__MOCK__.emit('import-progress', { id, stage: 'done', videoPath, subtitleText })`，`id` 从 `__MOCK__.calls` 里的 `start_import` 取。
- AI / Anki 请求经 vite `/__proxy` 转发（浏览器有 CORS，Tauri 没有），能打到真实 AI 端点。
- 浏览器里的 IndexedDB 和桌面 App 是两份，测试数据不会污染用户记录。

**新增 Rust 命令或 Tauri 插件调用时，同步在 `dev/browserMock.ts` 的 `handle` 里补一条**，否则浏览器里该功能静默返回 null。

浏览器验不到的：真实导入（yt-dlp / whisper）、系统对话框、Finder 拖放、WKWebView 独有的渲染 / 行为差异——这些在交付时明确列给用户真机验。

内置浏览器的坑：pane 隐藏时截图可能是旧帧，读状态优先 `get_page_text` / `javascript_tool`；`computer` 按空格 / 回车会发空 key，按键改用 `javascript_tool` 往 `document.activeElement` 派发 `KeyboardEvent`；输入框改值用原生 value setter + `input` 事件。React StrictMode 下 dev 的副作用会跑两遍（如 AI 请求发两次），正式包只发一次，别误判为 bug。

## 架构要点（跨文件才看得出来的）

- **Tauri 调用只准从 `utils/desktop.ts` 走**：系统对话框、读字幕、路径存在性、asset URL、拖放监听都在那儿收口。组件里直接 `invoke` 是错的。
- **视频永不读进内存**：记录里存绝对路径 `videoPath`，`<video src>` = `convertFileSrc(path)`。跨源，所以 `<video crossOrigin="anonymous">` 不能丢，掉了会让截图和 Anki 音频静默坏掉。
- **练习状态**：`App.tsx` 是页面状态机 + 全局快捷键表；练习期的状态在 `hooks/usePracticeContext.tsx` 及同族 hooks 里，组件只渲染。
- **导入任务的监听挂在 `App.tsx`，不是首页**：用户在练习页时首页已卸载，挂错地方会漏进度事件。
- **文案两份都要改**：`utils/i18n.zh.ts` 和 `utils/i18n.en.ts`。
- **视频扩展名收口在 `utils/desktop.ts`**：`PLAYABLE`（播放器直接能开的 mp4/mov/m4v，和 `src-tauri/src/convert.rs` 的 `plays_natively` 必须一致）+ `VIDEO_EXTS`（再加导入时自动转 mp4 的格式）。添加视频的选文件 / 拖入认全部；「重新选视频」只认 PLAYABLE。
- **UI 原语全在 `components/ui.tsx`**，风格是影院浮层（浅灰底 + 白面板、一个朱红主色 + 灰阶，别加第二种颜色；设计稿 https://claude.ai/artifact/14B5VBpJi7UJHrzwHeiMHB），新界面用这些原语，不要另起一套。

## 碰数据前

IndexedDB `linguaclip_db`：`videos` 表是练习记录本体；`fileHandles` 表是网页时代遗留，已不读不写——**不要删表、不要动 DB_VERSION**。改记录用 `patchVideoRecord(id, {...})` 按字段更新，别整条覆盖。结构变更要先过设计门。

复习卡片在另一个库 `linguaclip_review`（`utils/review.ts`，见 docs/README.md「本地数据」）。收藏 = 卡片的 `saved` 位，localStorage `linguaclip_saved_lines` 只读不写。复习库的写入一律不许挡住练习（fire-and-forget + catch）。
