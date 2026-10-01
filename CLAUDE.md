# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 开工先读 docs/progress.md

每次会话开始（含上下文压缩后）先读 `docs/progress.md`：现在做到哪、在等用户什么、下一步。它代替全局规则里的 `TASKS.md`（这个项目不用 TASKS.md）。
- 写给 AI 看：短句、不写背景和理由（理由在 docs 各专题文档或提交说明里），全文控制在 40 行内。
- 状态一变就改：开始做、做完一步、转成等用户、用户拍板。长任务的步骤清单也写在这里，做完一项勾一项。
- **做完收工的条目直接删掉**，不留历史（历史在 git log）。改完随这次改动一起提交。

## 免费 / Pro 与两个仓库

**本文件会同步到公开仓库**：别在这里写定价、收款、还没公开的功能计划，那些放 `docs/private/`。整个 `docs/` 只在私有仓库，同步时跳过。

- **用户手上只有一个 App**：官方安装包 = 带 `pro/` 的构建。目前**所有功能对所有人免费、不拦不计次**，Pro 功能（阅读器、播客）只是「不开源、只在官方包里」；激活码 = 支持者身份，不解锁任何功能。不存在「免费版 / Pro 版」两个下载。
- **本机这份 = 私有仓库** `linguaclip-pro`（`origin`），所有开发都在这里；Pro 代码只放 `pro/`。
- **公开仓库** `LinguaClip`（AGPL，给自己编译的人）不直接改：`scripts/sync-public.sh "说明"` 把已提交的代码去掉 `pro/`、`docs/` 导到 `~/.cache/linguaclip-public`，在那里跑类型检查 + 打包，通过才提交；`--push` 才推上去。本机没有指向公开仓库的 remote，别加回来；那个副本每次同步都会被整个覆盖，别在里面改。
- 免费代码只通过 `@pro` 用 Pro 功能：有 `pro/` 时指向 `pro/index.ts`，没有时指向 `utils/proStub.ts`（`vite.config.ts` / `tsconfig.json`）。两边导出同样的名字；**免费代码里不许直接 import `pro/` 下的文件**，同步脚本会拦。

### 新功能先问：放免费还是 Pro

新功能 / 交互变化（过产品门那一类），动手前**和产品门一起问用户归哪边**，给推荐、用交互语言写后果，例如「放进 Pro：官方 App 里所有人都能用，但代码不开源，自己编译的开源版里没有 / 放进免费：官方 App 和开源版里都有」。用户拍板前不动手。

推荐时的默认判断（最终用户定）：
- **倾向 Pro**：新的学习形态或新内容来源（如阅读器），AI 深度参与的高级增强，明显「多出来一层」的功能。
- **倾向免费**：现有免费功能的改进和打磨、导入 / 转录 / 平台兼容等基础链路、Pro 功能也要用的公共能力（查词、分段、日语分词等放免费侧，Pro 调用）。
- **不用问**：修 bug、改 Pro 功能本身（阅读器的改进默认 Pro）、改文案样式。

Pro 功能落地清单：
1. 代码放 `pro/`；在 `pro/index.ts` 和 `utils/proStub.ts` 各加同名导出（stub 给 null / 空函数）。开源版里入口要自己消失，不留 Pro 字样。
2. 入口**不挂 Pro 标、不拦、不计次**（试用机制已删，以后真要收费得先和用户重新定规则）。**价格不写进 App**。
3. 文案 zh / en 都加（文案文件是公开的，同样别写定价）。
4. 两种都验：浏览器里测 Pro；再跑一次 `scripts/sync-public.sh "说明"`（只准备不推）证明开源版能编译，入口变化大时在副本里起 dev 看一眼免费版。
5. 碰了免费侧的改动做完、验完，问用户要不要同步开源版；推送（私有 / 公开）都要用户点头。

## 先读 docs/

`docs/README.md` 是这个仓库的技术速览（目录表 + 本地数据结构），`docs/desktop.md` 是 Tauri 桌面版的运行时约定，`docs/import.md` 是自动生成字幕那条链路，`docs/watch.md` 是看剧模式；私有仓库另有 `docs/private/`（收费策略、试用规则、收款与激活方案，官网 / 激活服务器 / 域名的部署和密钥位置（`infra.md`），以及还没公开的功能规划），碰收费 / Pro 相关先读那里。动手前读对应那份，别只靠代码猜。（`docs/` 只在私有仓库；从公开仓库拿到代码的人没有这些文档。）

### 文档先行（每个 AI 会话都要守）

- **新功能 / 改行为：先写文档，再写代码。** 动手前把方案写进对应的 docs 文档（没有就新建一份，并在 `docs/README.md` 目录表加一行）：做成什么效果、数据存哪、接口 / 命令、「四个万一」怎么处理、怎么验收。要过产品门 / 设计门的，审的就是这份文档；用户拍板、门过了才开始写代码。
- **代码和文档同一次提交**：做的过程中方案变了，先改文档再改代码；提交时文档必须跟代码说的是同一件事。实测发现的外部行为（如某接口真实返回和官方文档不一样）当场记进文档。
- **进度写 `docs/progress.md`**，规格写专题文档，两边不重复。
- 改文案 / 样式、修小 bug 不用写文档；修 bug 发现规格本身写错了，顺手改文档。

**碰海外运营先读 `docs/海外运营.md`**：海外宣传、英文文案 / 帖子 / 视频、Reddit / HN / Product Hunt 等渠道、海外用户反馈、取数复盘，动手前先读它，做完按文中约定更新「数据日志」「反馈池」「变更日志」。

根目录除 `README.md`（面向用户的产品介绍，中英双语）外的 `*_FIX.md` / `*_SUMMARY.md` / `拆分计划*.md` 是早期开发日志，不是当前规格。

## 命令

```bash
npx tauri dev          # 桌面开发：自己拉起 vite:3000（Claude 验功能走浏览器，见「验证流程」）
npx tsc --noEmit       # 类型检查
npm run release        # tauri build --bundles app，然后装进 /Applications
npm run release:public # 发 GitHub Release 用：scripts/release-mac.sh 打包进 src-tauri/target/release-files/（有更新签名私钥时多出一键更新包，见 docs/update.md）（在本机打 = 带 Pro + 试用的官方包；包里不带任何 AI 密钥，AI 全靠用户在设置里自填；Creem 正式模式上线、正式码真激活过之前别外发）
cargo test --manifest-path src-tauri/Cargo.toml   # Rust 侧（import.rs、dicts.rs 有单测；dicts 的真词典导入是 --ignored，DICT_ZIP=路径 换词典）
node test-resegment.mjs   # 切句逻辑自检（bundle 真模块，不是复制逻辑）
node test-sections.mjs    # 分段逻辑自检（同上）
node test-cloze.mjs       # 挖空逻辑 + 缓存自检（同上）
node test-dictionary.mjs  # 查词：认语言 + 有道解析 + 欧路挑词（同上）
node test-anki.mjs        # Anki 旧配置合并成一种卡 + 单词加粗（同上）
node test-japanese.mjs    # 日语切词组 + 假名判对 + AI 校对回答校验（读 node_modules/kuromoji/dict）
node test-custom.mjs      # 定制练习：挑句（水平区间、时长、照常播放 / 跳过、从头再挑）+ AI 分级回答 / 缓存校验
node test-wordtimes.mjs   # 逐词时间：空格对到 words.json 的哪一段 + ⌘K / ⌘J 实际播放区间
node test-watch.mjs       # 看剧：某一秒屏幕上是哪一句（lineAt）
node test-review.mjs      # 复习卡：排期 + 匹配（utils/review.ts）
node test-breakdown.mjs   # 拆句：AI 回答校验 + 步骤（utils/aiDrills.ts）
node test-breakdown-prep.mjs # 拆句后台任务：批量回答解析、挑句、缓存（utils/breakdownPrep.ts）
node test-ailimit.mjs     # 各类 AI 请求并发上限（utils/aiLimit.ts）
node test-localdict.mjs   # 本地词典：点的词查哪些候选、变位跳原形、Yomitan 排版转释义（读 dev/fixtures/dict-sample.json 真样本）
node pro/test-reader.mjs  # 阅读器：查过的词怎么记（日语原形）+ 看剧时认回来、AI 译文回答 / 缓存 / 删视频中途取消
node pro/test-podcast.mjs # 播客：粘贴框认链接、时长、下载文件名、转录语言、推荐节目单（每种语言三档）、语速、「听懂多少」→ 推荐换节目
node pro/test-license.mjs # 支持者激活：凭证规则（验签 / 本机 / 30 天 / 测试码）、出错不锁人、退款或被移除删记录、并发不写回旧凭证
```

前端没有测试框架，逻辑自检就是根目录和 `pro/` 里那几个 `node` 脚本（`test-tokenizer.js` / `test-flexible-case.js` 是早期的复制逻辑版，参考价值有限）。

## 推送与发版

- 用户说「推送 / 更新一下」这类：推私有仓库，再 `scripts/sync-public.sh` 同步开源版并 `--push`。不发 Release，不动官网。
- 用户说「**发版**」：按私有文档 `docs/private/infra.md`「发版」走完：打三个平台的包 → GitHub Release → 官网下载同步更新。缺一步都不算发完。

## 验证流程（改完功能必须走）

**Mac 正式包本机打；Windows 包只由 GitHub CI 打**（`.github/workflows/windows.yml`，只在用户说要打时手动触发：`gh workflow run windows.yml`，push 不会触发；现在会跑在私有仓库上，打出来带 Pro，但会消耗私有仓库的 GitHub Actions 免费额度（Windows 按 2 倍计、mac-intel 按 10 倍计），触发前跟用户说一声；先在 Windows 上跑一遍下载组件 + 转录的真链路，安装包挂在那次运行的 artifact 里），用户在 Windows 虚拟机里验。平台差异收口在 `src-tauri/src/paths.rs`（目录、起子进程）和 `utils/platform.ts`；Windows 抽声音用 `decode.rs`（symphonia），不用 afconvert。用户验收在正式包里；交给用户之前，Claude 先在浏览器里把改动走一遍，拿到真实运行证据。顺序：

1. `npx tsc --noEmit` + 相关 `node test-*.mjs`（碰 Rust 再跑 `cargo test`）。
2. **浏览器实测**：启 `npm run dev`（`.claude/launch.json` 的 `dev`），按用户会做的操作走一遍改动，外加改动碰过的原有操作；截图给用户当证据。**首选 Playwright**（后台无头跑、不占用户屏幕、脚本可重跑）；Chrome 插件（claude-in-chrome）只在要用用户已登录的账号、或用户想亲眼看着操作时用——实测它开在用户正在用的 Chrome 里、视频加载不出来、标签页会中途丢失。没有内置浏览器（`preview_start`）时也走 Playwright。
   - Playwright 不装进项目：在 scratchpad 里 `npm i playwright`，`chromium.launch({ channel: 'chrome' })` 用系统 Chrome（自带 H.264，样片 mp4 才能播），`newPage({ locale: 'zh-CN' })`。
   - 按钮用 `getByRole('button', { name })` 找，名字照 `utils/i18n.zh.ts` 抄，别猜（如「添加视频」「选择本机视频」「选字幕文件」「开始练习」；开始练习后先弹「这次怎么练」面板，`getByRole('dialog', { name: '这次怎么练' })` 里点「开始练习」才进练习页；练法选 `radio` 「看剧」再点「开始看剧」进看剧页，面板会记住上次选的练法；练法选 radio「先读字幕」，点「开始阅读」进阅读页）。
   - 支持者（激活）：设置底部两行（「成为支持者 · 输入激活码」+ 用户群）；已激活要真走一遍激活：设置底部「输入激活码」输测试码（dev 下认测试模式的码，码和中转状态见私有文档），`window.__MOCK__.device = { id, name }` 换一台「电脑」；测完在「管理」里取消激活，别占着名额。
   - 同时起两个 vite（如私有这份 + 开源副本）会共用 `node_modules/.vite` 缓存互相覆盖，页面报 Invalid hook call：一次只起一个，换目录时加 `--force`。
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
- **Tailwind 只扫 `tailwind.config.js` 的 `content` 里列的目录**（已含 `pro/`）：新建顶层代码目录要加进去，否则只在那里用的样式不生成、排版静默乱掉。
- **UI 原语全在 `components/ui.tsx`**，风格是影院浮层（浅灰底 + 白面板、一个朱红主色 + 灰阶，别加第二种颜色；设计稿 https://claude.ai/artifact/14B5VBpJi7UJHrzwHeiMHB），新界面用这些原语，不要另起一套。

## 碰数据前

IndexedDB `linguaclip_db`：`videos` 表是练习记录本体；`fileHandles` 表是网页时代遗留，已不读不写——**不要删表、不要动 DB_VERSION**。改记录用 `patchVideoRecord(id, {...})` 按字段更新，别整条覆盖。结构变更要先过设计门。

复习卡片在另一个库 `linguaclip_review`（`utils/review.ts`，见 docs/README.md「本地数据」）。收藏 = 卡片的 `saved` 位，localStorage `linguaclip_saved_lines` 只读不写。复习库的写入一律不许挡住练习（fire-and-forget + catch）。

支持者激活（`pro/license.ts`）：localStorage `linguaclip_pro_license`（激活码 + 本机激活编号 + 中转签名的凭证）；旧的试用名单 `linguaclip_pro_trial` / `linguaclip_pro_listen` 已不读不写。「是不是支持者」只在 `pro/license.ts` 一处算：只认验签通过的凭证，网络错 / 服务器故障**绝不**当成没激活，只有签名过的非 active 才删记录。设备 id 从 Rust `device_info` 取（硬件 UUID 的 hash），读不到就报错，**不许**退回随机 id（每次重装会多占一个名额）。
