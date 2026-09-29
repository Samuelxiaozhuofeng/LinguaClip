# LinguaClip 技术速览（给 agent 看的）

视频听写 / 遮字跟读练习工具。**只发 Mac 桌面版**（Tauri 2 + WKWebView），网页版已停维护，`npm run dev` 单独跑在浏览器里时由 `dev/browserMock.ts` 冒充 Tauri 外壳，仅供开发验证（见 CLAUDE.md）。

- 开发运行：`npx tauri dev`（自己拉起 vite:3000）
- 打包：`npx tauri build` → `src-tauri/target/release/bundle/macos/LinguaClip.app`
- 类型检查：`npx tsc --noEmit`
- 前端：React 19 + Vite 6 + Tailwind 3（本地打包，见 `tailwind.config.js`），字体走 `@fontsource`，断网可用
- 界面风格：影院浮层（浅灰底 #FAFAFA + 白面板，近黑字，唯一主色朱红 #E8492B；学习的外语句子 Source Serif 4 衬线、界面 Instrument Sans、中文苹方）。首页上方是继续练的大画面 + 白条，练习页和复习都是「视频在上、白面板从下盖上来」；顶栏居中胶囊「视频 / 句子 / 单词 / 设置」，句子 / 单词两个库页 = `ReviewPage`（deck）+ 下面的 `CardsPage` 列表，令牌在 `tailwind.config.js` / `index.css`，原语全在 `components/ui.tsx`（含「…」菜单 `Menu`）；快捷键提示用 ⌘ ⇧ 符号

## 目录

| 位置 | 管什么 |
|---|---|
| `App.tsx` | 页面状态机（首页 / 练习 / 看剧 / 收藏 / 设置）、开始练习与续练、全局快捷键表 |
| `components/Home.tsx` + `VideoCover.tsx` | 拖入 / 选文件、历史记录货架（列表 / 卡片，卡片封面是现抓的视频一帧，不存盘） |
| `components/Studio.tsx` + `Transport.tsx` + `DictationLine.tsx` / `BlurLine.tsx` | 练习页：视频、字幕条、遥控条 |
| `components/Settings*.tsx` | 通用 / AI 查词 / Anki 设置 |
| `hooks/` | 播放控制、练习会话、收藏、Anki 集成、快捷键 |
| `utils/sections.ts` | 按分钟把字幕切成段。**首页和练习页必须用同一个函数**，否则卡片上的「第几段」会和实际练的对不上 |
| `utils/desktop.ts` | **所有 Tauri 调用的唯一入口**：系统对话框、读字幕、路径是否存在、asset URL、拖放监听 |
| `utils/videoStorage.ts` + `fileSystemAccess.ts` | 练习记录（IndexedDB） |
| `utils/anki.ts` | AnkiConnect 请求（经 Tauri http 插件代发） |
| `utils/aiConfig.ts` + `ai.ts` | AI 设置（用户自填 OpenAI 兼容地址 + key + 模型，无默认地址、无内置通道）与 AI 查词 |
| `utils/dictionary.ts` | 词典查词（不用 AI）：按整段字幕认语言（英 / 西 / 法 / 德 / 日，日语看假名占比），查有道 JSON 或剑桥 / 欧路网页（借鉴 ODH）；每门语言用哪本存 localStorage `linguaclip_dict_choice`。查词顺序在 `Studio.tsx` 的 `lookup`：词典优先，查不到或英文界面且配了 AI 时走 AI。弹窗按条列释义（带例句），每条「＋」单独发 Anki（`senseToAnki`：释义进 definition、前 2 句例句进 example 栏位）；AI 只回答第几条（`ai.ts` 的 `pickSense`），不改写释义。剑桥 / 欧路连不上时自动改查有道 |
| `utils/japanese.ts` + `jaSegments.ts` + `components/JaSetup.tsx` + `src-tauri/src/ja_dict.rs` | 日语分词：含假名的句子用 kuromoji（ipadic）切成词组（助词、词尾粘前一个词），一格一个，带读音（打假名算对，`textTokenizer.ts` 判对时比）。词典不随包：12 个 .dat.gz 共 17MB，第一次练日语时练习页顶部提示下载（设置 → 练习里也能下 / 删），下到 App Support 的 `com.linguaclip.app/ja-dict`（复用 whisper_setup 的续传 + sha256）。设置 → AI 勾「AI 校对日语分词」后，AI 只回每句第几个片段起新词组，存 `<id>.segments.json`（键是句子原文）。**数格子只有 `tokenizeText` 一个来源，任何数格入口先 `settleSplits`**；词典不在且视频含假名时，挖空整份不读不写 |
| `utils/jaLookup.ts` + `jaPhrases.ts` | 日语点词查词：词组还原原形（`jaLemma`）后查有道日汉（`newjc`，走老接口 `jsonapi?le=jap`，新接口 `jsonapi_s` 会把「高い」「皆さん」认成英语）；有道查不到的词会拿别的词顶上，按读音 / 汉字筛掉，再按词性排（くる 先给「来る」）。`jaPhrases.ts` 两张表：寒暄语 / 固定句型（初めまして、かもしれない…，只收有道有词条的）切词时整体一格、查词查整条；有道缺的或同音词排前面的假名词改查汉字写法（やる→遣る）。桌面版请求有道必须去掉 plugin-http 默认加的 `Origin: tauri://localhost`（有道回 400）：`get()` 传空 Origin + Cargo 开 `unsafe-headers` |
| `utils/breakdownPrep.ts` + `clozePrep.ts` | 拆句 / 挖空的后台任务（首页「…」、导入后自动做、练习页共用同一个任务），结果存 `~/Movies/LinguaClip/<id>.breakdown/cloze.json`；cloze.json 带 `n`（排名时每句格数），格数变了（日语切法变了）那句作废重问 |
| `components/CustomPanel.tsx` + `utils/customPick.ts` + `utils/levelPrep.ts` | 开始练习前的面板（所有入口都走 `App.tsx` 的 `handleResume`）：「按段从头练」（旧行为）或「定制」（时长 + A1–C2 水平 + 其余句子照常播放 / 跳过）。AI 给每句一个等级或 `x`（不值得练），只回代码，存 `<id>.levels.json`（按字幕 hash 作废；失败的句子留 null 下次再问，挑句时按本机规则当可练）；挑句是纯函数 `pickCustom`，从 localStorage `linguaclip_custom_pos` 记的秒数往后挑够时长。定制会话是只有一段的 sections；「照常播放」的句子进 `watch`（`useVideoPlayer` 里播完不停、不进输入）。**定制练习不写记录的段进度**：`App.tsx` 里所有 `updateProgress` 都走 `saveProgress`，定制时静默 |
| `components/WatchPage.tsx` + `WatchLine.tsx` + `WatchSummary.tsx` | 看剧模式：面板选「看剧」→ `AppState.WATCH`，独立页面，不碰段进度 / 定制进度，见 [watch.md](watch.md) |
| `pro/ReaderPage.tsx` + `ReaderLine.tsx` + `transPrep.ts` + `utils/readLooked.ts` | **Pro 功能**（`pro/` 只在私有仓库，开源版里面板没有这一项，见 CLAUDE.md「两个仓库」）。先读字幕（阅读器）：面板选「先读字幕」（整集 / 读一段看一段，`watchPrefs.readBy`；**不写 `chosen`**，读完回面板选真正的练法）→ `AppState.READ`，不碰视频记录。台词按 `buildSections` 分段（和练习页同一个）、`sentenceParts` 注假名（`watchPrefs.kana`）、点词查词；查过的词按原形记进 localStorage `linguaclip_read_looked`（日语去掉被动 / 使役：頼まれた→頼む；其他语言小写），看剧页 `WatchLine` 据此画红虚线，悬停显示当时查到的第一条意思（localStorage `linguaclip_read_gloss`，优先取词条拼写等于词键的那条，截 40 字）。读到哪儿存 `linguaclip_read_pos`（最上面那句的开始秒；只记用户自己滚的，小窗跟随播放的滚动不算；进页先滚回去，顶部钉一行「接着上次」+「从头读」）。顶栏「查词时放这句」（`watchPrefs.autoClip`）开着时点词同时在小窗放这句。右侧小窗用 `useClip`：一句放完停 / 从这句接着放 / 放一段。AI 译文第一次点开「中」才请求，存 `<id>.trans.json`（按字幕 hash + 目标语言作废，每批写一次、写盘串行、删视频前 `cancelTrans`）。`node pro/test-reader.mjs` |
| `components/AddVideo.tsx`（添加视频弹窗）+ `utils/importJob.ts` + `src-tauri/src/import.rs` + `whisper_setup.rs` | 自带字幕 / 本地转录（首次自动下载转录组件）/ YouTube 下载，见 [import.md](import.md) |
| `utils/i18n.*.ts` | 中 / 英文案，两份都要改 |
| `src-tauri/src/paths.rs` + `utils/platform.ts` | Mac / Windows 差异：自有目录（~/Movies 或 ~/Videos 下的 LinguaClip）、起子进程不弹黑窗、快捷键和「废纸篓」文案 |
| `src-tauri/src/decode.rs` | 纯 Rust 抽视频音轨成 16k wav（Windows 用；Mac 用系统 afconvert） |
| `src-tauri/` | Rust 壳子；`tauri.conf.json` 窗口与 asset 协议，`capabilities/default.json` 权限 |

## 桌面版的关键约定（改这些地方前先读）

详见 [desktop.md](desktop.md)。一句话版：视频不读进内存，用 `convertFileSrc(path)` 当 `<video src>`；记录里存绝对路径 `videoPath`；拖放走 Tauri 事件不走 HTML5 `onDrop`；Anki 卡的音频走 Web Audio 录制。

## 本地数据（改结构要过设计门）

- IndexedDB `linguaclip_db`：`videos` 表（VideoRecord，含 `videoPath`、字幕全文、进度）；`fileHandles` 表是网页时代遗留，已不读不写，**不要删表、不要动 DB_VERSION**
- IndexedDB `linguaclip_review`（`utils/review.ts`）：复习卡片，和 `linguaclip_db` 分库——**别把它并进 `linguaclip_db`**（那要升 DB_VERSION，旧版 App 就打不开练习记录了）。`cards` 表一张卡 = 一句（`deck:'line'`，id `视频id|开始秒`）或一个词（`deck:'word'`，id 再加 `|w|单词`），卡里自带句子、时间、视频路径快照和 FSRS 排期（`ts-fsrs`，间隔按天、不走分钟步）；删视频记录连同它的卡一起删（`deleteVideoCards`），App 自己的 `<id>.{words,cloze,breakdown,segments,levels,trans}.json` 缓存也进废纸篓；旧版删视频留下的卡（`orphanCards`），启动时弹窗问一次删不删，选保留的记在 localStorage `linguaclip_kept_orphans`；`meta` 表只有 `migrated` 一条，和旧收藏迁移的卡同一事务写入。评分靠用户按 FSRS 四键（重来 / 困难 / 良好 / 简单，1–4 键，按钮下的天数用按钮出现那一刻的 `now` 预览，写库用同一个 `now`，fuzz 才对得上）：句子卡先听写，交卷后按结果圈一个建议（有错 Again、看提示 / ⌘J / ⌘K 过 Hard、全对 Good，`gradeOf`），回车采用；单词卡先想再翻（设置「单词卡正面」`practice_config.wordFront`：只看词 / 看原句，翻面前不放声音不给画面），翻面后播片段、词和原句带假名（`utils/textTokenizer.ts` `sentenceParts` + `japanese.ts` `furigana`，目标词注音常显、其余悬停，词典没下载就不注）；按「重来」写库（明天到期）并在本轮队尾再出一次。没按键就退出 / 跳过不记。Anki：LinguaClip 笔记类型的模板和 CSS 由 App 改写（`syncLinguaClipTemplate`，localStorage `linguaclip_anki_tpl` = 模板版本:正面，变了才改写，一键创建时强制改写；字段不动），LinguaClip 笔记的 Sentence / Word 字段写 `<ruby>` 假名，单词笔记正面不放声音截图。**语言牌组**（`utils/deckLang.ts`）：卡片不存语言，卡的语言 = 视频的语言，现算——`VideoRecord.lang`（首页「…」里手动选）优先，否则整份字幕 `detectLang`，认不出 = 未分类；库页顶部按语言筛（两种以上才出现，选择存 localStorage `linguaclip_deck_lang`），复习查词按每张卡自己的语言。Anki 配置 `card.deckByLang` 按语言指牌组，没设走 `deckName`；**凡是重建 card 配置的保存路径都要带上 deckByLang**。**卡片片段**（`utils/clips.ts` + `src-tauri/src/clips.rs`，设置 → 练习勾选，`practice_config.saveClips` / `clipKind`）：卡的可选字段 `clip`（文件名相对 `<own dir>/clips`，`from` = 片段在原视频里的起点秒）；同一句的卡共用一个文件（`videoId_start`）。`fillClips` 是唯一干活的地方：切缺的、把已有片段借给同一句的新卡、最后 `sweep_clips` 删不被任何卡引用且超过 1 小时的文件——所以**任何写卡路径都必须 `{...old}` 保留 clip**，否则片段会被当垃圾删掉。播放一律走 `findSource`（原视频优先，否则片段，时间减 `from`）。首页删记录前先 `await fillClips()`，有片段就问保不保留卡
- localStorage：`linguaclip_custom_pos`（每个视频下次定制练习从第几秒挑起，删视频时清掉）/ `linguaclip_watch_pos`（每个视频看剧看到第几秒，看完归零，删视频时清掉）/ `linguaclip_watch_prefs`（看剧字幕显示、句尾暂停、面板上次是否选了看剧、阅读器怎么读 / 假名开关）/ `linguaclip_read_looked` / `linguaclip_read_gloss` / `linguaclip_read_pos`（每个视频阅读时查过的词、查到的意思、读到哪儿，删视频时一起清掉）/ `practice_config.custom`（开始练习面板上次的选择）/ `linguaclip_ai_config` / `linguaclip_anki_config` / `linguaclip_anki_tpl`（LinguaClip 模板已改写到哪个版本:正面） / `audio_padding` / `lang` / `practice_config` / `saved_lines`（**旧收藏，只读**：首次打开复习库时迁移进卡片，之后不再写，留作备份）/ `video_progress` / `import_lang`（添加视频弹窗记住的字幕语言）/ `linguaclip_today`（首页「今天练了几分钟 · 几句」，只存当天一条，`utils/today.ts`）/ `home_view`（首页列表 or 卡片）

## 根目录那些 *.md

`README.md` 以外的 20 多份 `*_FIX.md` / `*_SUMMARY.md` / `拆分计划*.md` 是早期开发日志，不是当前状态，别当规格用。
