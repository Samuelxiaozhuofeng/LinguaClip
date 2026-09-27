# 导入时自动转 mp4（2026-09-27 用户拍板）

用户拍板：mkv/avi/webm 等导入时自动转 mp4；可勾「导入成功后把原文件移到废纸篓」（默认不勾、记住上次）；ffmpeg 第一次用时下载、设置里也能下并看位置；内嵌字幕由用户选（按字幕语言预选）；声音读不出的 mp4 给「转换后重试」；转好的放 LinguaClip 文件夹。

- [x] 产品门 + 设计门（重试保留字段、trash 前查所有引用、.part 不撞名）
- [x] Rust convert.rs：下载 ffmpeg、probe、转换、读内嵌字幕；run_import 接入；Windows 回收站只对固定盘
- [x] 前端：选文件 / 拖入认新格式、弹窗字幕轨 + 勾选、卡片新阶段、转换后重试、设置行、文案
- [x] cargo test + tsc + node test-*.mjs + 真实转换（mkv 带字幕 / webm / avi）+ 真实下载 ffmpeg（Mac arm64）
- [x] 浏览器实测（弹窗、进度卡、移原文件、同文件两次导入、自带字幕重试、转换后重试、设置页下载）
- [x] 三路审码：Opus / 6-sol / Gemini 共 7 条核实已修（记进错题本）
- [x] npm run release
- [ ] Windows：gh workflow run windows.yml 真链路（需用户点头）
- [ ] 用户真机验收

# 看剧模式（产品文档：https://claude.ai/code/artifact/ff7ab143-727c-499e-8ebd-3ba7f1b2fe5b）

- [x] 面板第三种练法「看剧」+ 记住上次选择
- [x] 看剧页：全窗口视频、叠加字幕（原文 / 模糊 / 隐藏）、点词查词（暂停 → 关掉恢复）
- [x] 快捷键：空格、⌘←/⌘→、⇧空格、←/→、S、P、C、⌘⇧N
- [x] 本集小结：收藏句勾选去听写（ReviewSession）、查过的词
- [x] 看剧位置单独存，不碰段进度 / 定制进度；删视频时清掉
- [x] tsc + test-watch.mjs + 浏览器实测（含按段从头练 / 定制回归）
- [x] Gemini 审码：4 条核实已修（句尾暂停停错句、录音期间误清进度 / 误收藏 / 单词录音被掐断）
- [x] npm run release
- [ ] 用户真机验收（Anki 录音成卡、Mac 全屏）

# Windows 显卡加速（Vulkan，设置里的开关，默认关）

- [x] 前端开关 + gpu 参数传到 start_import / import_tools（浏览器实测过）
- [x] Rust：下载 vulkan 版、没 vulkan-1.dll 就用 CPU、显卡失败退回 CPU
- [x] 写 .github/workflows/whisper-vulkan.yml（编译 + lavapipe 实测 + 发 Release）
- [x] 审码（Gemini）结论核完：能合，无缺陷
- [x] push → 跑 whisper-vulkan.yml（lavapipe 上真走 Vulkan0 通过）→ size / sha256 已填
- [x] 跑 windows.yml 出 Windows 测试包（run 36220916594）
- [ ] 提需求的用户在真显卡上试

# 日语分词（按需下载 kuromoji 词典 + AI 校对）

用户拍板：打假名读音也算对；设置里勾「AI 校对日语分词」后台整部校；助词粘前一个词（今日は 一格）；词典不进安装包，第一次遇到日语时提示下载。

- [x] 设计门（segments 缓存 / cloze 缓存加 n / 删视频级联 / 词典目录）
- [x] Rust ja_dict：下载（复用 whisper_setup::fetch）、状态、删除；lib.rs 注册；browserMock 补
- [x] utils/japanese.ts：读词典建 kuromoji、切词组（带读音）、AI 结果覆盖、版本订阅；下载状态共用
- [x] textTokenizer：含假名的句子走日语切法；判对接受读音
- [x] DictationLine：输入法打字中不抢空格 / 回车、不自动跳格；答案行按词点；格子宽度按字宽
- [x] BlurLine / Studio（预告、挖空格数）/ ReviewSession / CardsPage 跟版本刷新
- [x] 练习页提示条（下载 / 进度 / 重试 / ✕）；设置通用页词典行；AI 页勾选
- [x] AI 校对任务 jaSegments.ts（只回序号，逐句校验，存 segments.json），挖空先等它；导入后自动跑
- [x] 挖空缓存加 n，旧日语缓存作废
- [x] 中英文案；docs 更新
- [x] tsc + test-*.mjs + 新 test-japanese.mjs + cargo test
- [x] 浏览器实测
- [x] codex-review + 错题本（Gemini 3 条、6-sol 1 条新的，已修；6-sol 另 2 条按设计接受：开 AI 校对后改了切法的句子重挖一次、同句跨视频借用切点）
- [x] npm run release + 验收路径

# 转录标签页 + 云端转录（Groq）+ 本机标准/轻量

用户拍板：长视频先压缩（Mac AAC），压不下就切段；云端失败 = 卡片提示 + 重试，不自动换本机；本机只开「标准 / 轻量」两档。

- [x] 实测轻量模型 ggml-small-q5_1 + DTW "small" 能出逐词时间
- [x] Rust whisper_setup：按档位找 / 下载模型；import_tools(model)；新命令 transcribe_location(model)
- [x] Rust cloud_asr.rs：wav 切段（静音处下刀）→ Mac 压 AAC / Windows 原样 → Groq verbose_json → 补标点、合词、拼 SRT；错误码 cloud:key / cloud:quota / cloud:network / cloud:toolarge
- [x] Rust import.rs：start_import 带 engine/model/apiKey；云端不跑 ensure；transcribe 用档位对应 DTW 预设
- [x] cargo test（补 cloud_asr 单测：补标点 / 合词 / 切段）
- [x] 前端 utils/transcribeConfig.ts（localStorage）+ desktop.ts 打开网址 / 在访达显示
- [x] SettingsTranscribe.tsx + Settings.tsx 加标签；中英文案
- [x] importJob.ts 传参 + 云端报错翻译 + 云端阶段文案；AddVideo.tsx 按模式改提示 / 没密钥拦住
- [x] browserMock 补 transcribe_location / reveal
- [x] tsc + node test-*.mjs
- [x] 浏览器实测设置页 + 添加视频弹窗
- [x] 真调 Groq（19 秒英文 + 11 分钟西语切 3 段；修：Groq 逐词时间有 0.1–0.3 秒回退，夹平而不是整份丢弃）
- [x] docs/import.md 更新
- [x] 复审（codex 卡住，改用 agy gemini-3.8-flash-high：能合，无实缺陷）
- [x] npm run release + 验收路径

# 攒一批送 codex-review（2026-09-24 已审）

- [x] e36d182 复习里查词（useLookup 抽出、ReviewSession 接查词 / 记下这个词 / Esc 顺序）
- [x] 8150370 复习页：接下来一周预告 + 卡片具体日期、复习次数、忘过次数
- [x] 卡片标签页：列表从复习页搬出、按状态筛（全部/到期/没到期/没声音）、批量删（deleteCards 一个事务）
- [x] codex-review（修：夏令时切换日「接下来一周」分桶错一天。划掉：到期卡显示「现在」不显示日期——故意的。旧问题：旧收藏迁移失败期间删掉的卡，迁移恢复后会复活——已修，见下）
- [x] 迁移失败期间删卡 / 取消收藏记墓碑，迁移恢复后不复活（设计门：取消收藏只去掉收藏位也要记；codex-review 能合；浏览器造迁移失败实测）

# App 内复习（句子 / 单词两个牌组，FSRS）

用户拍板（2026-09-24）：卡住的句子自动进复习 + 收藏也进；单词一起做；句子、单词分开两个牌组各一个入口；自动评分，不自评；Anki 保留。
设计说明：scratchpad/design-review.md（设计门审）

- [x] 探索 + 产品门
- [x] 设计门（reviewer）：可动工；补「记录删了也能重新选文件」、迁移标记进同一库、复习库出错不挡练习
- [x] 地基：utils/review.ts（库、FSRS、评分、迁移、队列）+ test-review.mjs + 全部文案 key
- [x] 路 A 采集：DictationLine 报结果 / Studio 接卡住 / 拆开教我 / 模糊点开 / 收藏按视频+句 / 查词「记下这个词」/ 段末「再练卡住的 N 句」
- [x] 路 B 复习：ReviewSession（放原声片段 + 听写 + 自动评分）/ 复习页（两个牌组入口 + 列表）/ 首页到期提示 / 导航改名 / 删视频提示
- [x] 合流：tsc + node test-*.mjs + 浏览器实测整条链（顺修：全对自动重播后跳过一句——旧版同样复现）
- [x] codex-review（修：AI 释义当网页渲染可被注入；迁移与建卡竞态；老收藏读坏时误标迁移完成。未修：装回旧版后两边收藏各记各的——已知限制）
- [x] 更新 docs/README.md + CLAUDE.md 数据段
- [x] npm run release + 验收路径 + commit

# 六项优化（2026-09-23 用户拍板）

- API 地址必须自己填，留空不再默认连 Google；去掉正式包里内置的作者通道，统一用自己填的 key

- [x] 产品门 pm
- [x] 6 去 Google/Gemini 字样 + 去内置通道 + 地址必填
- [x] 4 设置页分标签（通用 / AI / 快捷键 / Anki）
- [x] 1 练习页视频:练习区比例（7:3 / 6:4 / 5:5 / 4:6，记住）
- [x] 2 查词改居中弹窗
- [x] 3 首页卡片/列表切换（卡片有视频画面封面）；··· 菜单「拆句」「挖空」
- [x] 5 AI 标签勾选：转录后自动拆句 / 自动挖空；首页显示拆句、挖空进度
- [x] tsc / node 自检 / 浏览器实测（本地假 AI 服务）
- [x] codex-review（修：挖空写盘失败时删视频会卡住）
- [x] npm run release

# 快捷键：常驻提示 + 拆句快捷键 + 自定义

用户拍板（2026-09-23）：
- 练习页加一个小按钮，点开后快捷键表常驻在角落，再点收起
- 「拆开教我」默认 ⌘B（Windows Ctrl+B）；用不了时按下要提示原因
- 设置里只允许改带 ⌘/Ctrl 的组合键；空格、回车、打字时跳词固定
- 录到被占用的键（系统或其他功能）当场拦下
- 自定义存本机，Mac 显示 ⌘、Windows 显示 Ctrl

- [x] 转录进度一直 0%（whisper 输出「progress =  42%」多一个空格）
- [x] 快捷键清单收成一份（按键、菜单说明、角落表、按钮提示都从这里读）
- [x] 练习页：角落常驻表 + 开关按钮
- [x] 拆开教我快捷键 + 用不了时提示
- [x] 设置页：快捷键自定义（拦撞键、恢复默认）
- [x] tsc / 浏览器实测 / codex-review / npm run release

# Windows 版（GitHub CI 打包，用户在 Windows 虚拟机里验）

- 用户 2026-09-23 同意为此推送到 GitHub；公开 Release 仍需另外点头
- Windows 不做 YouTube（Chrome 127+ 在 Windows 上加密 cookies，yt-dlp 读不了）
- 转录组件：官方 whisper-bin-x64.zip（4MB）+ 同一套模型；抽声音用内置解码（symphonia），不下 ffmpeg

- [x] Rust：家目录 / 视频目录 / 组件目录按系统分；find_bin 认 .exe；子进程不弹黑窗
- [x] Rust：Windows 组件 = 官方 zip 下载后用系统 tar 解压；import_tools 在 Windows 报 youtube=false
- [x] Rust：内置解码 mp4/mov/m4v 音频 → 16k wav（Windows 用；Mac 仍用 afconvert），带样片测试
- [x] Rust：删除到回收站（Windows）
- [x] 前端：视频目录按系统分；⌘/⇧ 在 Windows 显示成 Ctrl/Shift，快捷键认 Ctrl；标题栏留白
- [x] CI：windows 打 NSIS 安装包 + 跑 cargo test（含下载 whisper 并运行）→ 上传为 artifact
- [x] Mac 侧回归：cargo test / tsc / 浏览器 / npm run release
- [x] codex-review
- [x] push，看 CI 绿，给用户 Windows 验收路径

# 开源发布：自带字幕 + 一键下载转录组件

用户拍板（2026-09-23）：
- 加回「视频 + 自带 .srt」直接开练，不用装任何东西
- 只有视频：首次生成字幕前说明 → 一键下载转录组件（识别程序 3MB + 压缩版模型 550MB + VAD 1MB）到 ~/Library/Application Support，不打进 App
- YouTube 不做一键；本机没装 yt-dlp 就不显示网址框，GitHub 上写进阶说明
- 公开安装包不能带作者的 AI 密钥

- [x] Rust：组件目录 + 查找顺序（我们下的 → Homebrew/旧 ~/.cache，完整版和压缩版模型都认）
- [x] Rust：抽声音改用系统 afconvert，失败再退 ffmpeg
- [x] Rust：缺组件时导入流程先下载（setup 阶段进度、断点续传、官方源→国内镜像、sha256 校验）
- [x] Rust：import_tools 命令（转录组件在不在、yt-dlp 在不在）+ browserMock
- [x] 前端：弹窗加选字幕（只 .srt）、拖放认 .srt、选了字幕→「开始练习」直进练习页
- [x] 前端：缺组件时弹窗写明大小和位置，按钮「下载组件并生成字幕」；没 yt-dlp 隐藏网址框
- [x] 前端：卡片显示「下载转录组件 x%」；任何失败都能重试（本地视频不再只能删卡）
- [x] 中英文案、README、docs/import.md
- [x] 公开包：不带密钥的打包方式 + ad-hoc 完整签名
- [x] tsc / cargo test / 浏览器实测 / 干净环境实测下载+转录
- [x] codex-review → npm run release → 验收路径
- [ ] （需用户许可）push + 发 Release（whisper-cli 和 App 安装包）

# 界面重做（D1 · 深海夜读 双栏）

设计稿：https://claude.ai/artifact/NSw8GzoJEEofdbpms9Ub3v（NightSplit 那张）
主页分工：列表 + 「添加视频」为主角；链接/语言/画质进弹窗；模式按钮悬停出现；拆句/删除进「…」；拖放整窗；删选字幕、重复的选本地按钮、生成字幕按钮、上次时间；进度合并成「第 x/y 段」+ 细线。

- [x] 读懂现有 UI 代码（ui.tsx / index.css / tailwind / 各页面）
- [x] 新配色和字体令牌（1 主色 + 灰阶），字体离线打包
- [x] 重写 ui.tsx 原语
- [x] 主页按分工表重做（添加视频弹窗、整窗拖放、行悬停、… 菜单）
- [x] 练习页 D1 双栏（视频左、文字稿右、底栏快捷键、… 菜单）
- [x] 收藏 / 设置 / 弹窗 / 查词面板跟新令牌
- [x] tsc + node test-*.mjs
- [x] 浏览器实测 + 截图，评审第 1 轮
- [x] 评审第 2 / 3 轮（8.5 分停）
- [x] 第四步做减法（删非听写元素、只留 1 主色、统一字号间距）
- [x] npm run release + 验收路径

# 查词：词典打底，AI 做补充（2026-09-23 用户拍板）

- 点单词先查词典（不配 AI 也能用）；视频语言按整段字幕自动认
- 英语：有道 / 剑桥；西、法、德：有道 / 欧路；设置里每门语言选一本（默认有道）
- 查不到：配了 AI 自动转问 AI；没配 → 「词典里没有这个词」+ 去配 AI 的提示
- 英文界面 + 配了 AI → 直接问 AI
- 弹窗「结合这句解释」按钮（配了 AI 才有）；点过再发 Anki 就发 AI 那份
- 日语：字幕点下去是一整串，词典查不了，照旧走 AI

- [x] 产品门 pm
- [x] utils/dictionary.ts：认语言 + 有道 / 剑桥 / 欧路 解析 + 选择存本机
- [x] Studio 查词流程 + DefinitionPanel 显示词典 / 「结合这句解释」/ Anki
- [x] 设置页：每门语言选词典；文案两份（加载中、没配 AI、Anki 字段名、提示词说明）
- [x] tsc / node 自检（认语言 + 解析）/ 浏览器实测
- [x] codex-review
- [x] npm run release

# 查词：按条加入 Anki（2026-09-23 用户拍板）

- 每条释义末尾「＋」，点了直接发「带音频」卡片（只这一条 + 前 2 句例句）；撤掉底部「仅单词 / 带音频」；AI 兜底那段末尾也有「＋」
- 弹窗每条下只显示第 1 句例句；Anki 新增「例句」栏位（设置 → Anki 里选对应格）
- 「结合这句解释」→ AI 指出第几条（亮起 + 滚到眼前）+ 一句说明；说明不进卡片
- 英语有道 → 柯林斯双解（没有就退回简明）；西法德默认词典改欧路（已选过的不变）
- 顺手：同一条加过显示 ✓ 不能再点、录音时其他「＋」锁住；欧路固定搭配带上短语；例句 ~ 换回原词；挤一行的两条拆开

- [x] 产品门 pm
- [x] dictionary.ts：例句 / 搭配 / 拆条 / ~ / 柯林斯 / 默认欧路 / 单条转 HTML
- [x] Anki：新「例句」栏位（types / anki.ts / useAnkiIntegration / SettingsAnki / 文案）
- [x] AI 挑第几条（ai.ts）+ Studio explain
- [x] DefinitionPanel：每条「＋」、例句、亮起滚动、撤底部按钮
- [x] tsc / test-dictionary / 浏览器实测
- [x] codex-review（修：欧路例句嵌在释义里被混进释义；单条带例句的柯林斯被丢）
- [x] npm run release

# Anki：只剩一种卡 + 一键创建 LinguaClip 卡（2026-09-24 用户拍板）

- 设置 → Anki 只有「卡片」一套（牌组 / 笔记类型 / 字段）；播放条加整句、查词 ＋ 都用它，默认带音频
- 老配置沿用原「音频卡片」（没有就用「单词卡片」）
- 「一键创建 LinguaClip 卡」：建 LinguaClip 牌组 + 笔记类型（已有就直接用，不覆盖），字段自动对上
- 卡面：正面原声 + 截图（单词卡多一个单词）；背面句子（单词加粗）、释义、例句；空的整块不显示

- [x] 产品门 pm + 用户拍板（先听后看、自动建牌组）
- [x] anki.ts：配置合一 + 兼容旧格式 + 一键创建 + 加粗
- [x] useAnkiIntegration / 调用链去掉 includeAudio
- [x] Settings / SettingsAnki 合成一块 + 按钮；文案两份；README / docs
- [x] test-anki.mjs + tsc
- [x] 浏览器实测（真 Anki）
- [x] codex-review（修：Anki 里已有且改过字段名的 LinguaClip 卡，一键创建后提示手动补「句子」「音频」）
- [x] npm run release

# 定制练习：按时间 + 水平挑句子（2026-09-25 用户拍板）

每次「开始练习」先弹面板：按段从头练 / 定制（时长、A1–C2、其余句子照常播放 or 跳过）；定制接着上次往后挑，挑够时长为止。AI 给每句打一次等级存 levels.json，挑句在本机。

- [x] 产品门 pm + 用户拍板（做成可选、每次弹面板、接着上次往后挑）
- [x] 设计门 reviewer（levels.json / 删除级联 / custom_pos / 不碰首页进度）
- [x] utils/customPick.ts 纯函数（挑句、本机杂句规则、时长估算）+ test-custom.mjs
- [x] utils/levelPrep.ts：AI 分级后台任务 + 缓存 + cancel；cache.rs / desktop.ts 加 levels；删视频级联
- [x] 开始练习面板（App handleResume 前弹）+ practice_config.custom
- [x] 练习页：定制会话（跳过 / 照常播放只看句）、句数、完成弹窗、custom_pos
- [x] 中英文案；docs 更新
- [x] tsc + test-*.mjs + cargo test
- [x] 浏览器实测（真 AI 分级一个视频 + 两种其余句子 + 听写 / 遮字）
- [x] codex-review 三路 + 错题本（修：面板回车 / 失败状态 / 等分级卡住 / 下一组沿用只按时间挑、播放方式 / 一句组连播卡死 / 快速连点串台）
- [x] npm run release + 验收路径

# 界面改版「影院浮层」（2026-09-25，设计稿 https://claude.ai/artifact/14B5VBpJi7UJHrzwHeiMHB）

用户拍板：按设计稿实施；顶栏改「视频 / 句子 / 单词 / 设置」（复习 + 卡片合并成两个库）；错词用朱红。

- [x] 令牌：浅色 #FAFAFA / 白 / #1C1917 / 朱红 #E8492B；字体 Instrument Sans + Source Serif 4（打包，卸 newsreader）
- [x] 硬编码颜色清扫（rgba 黄、深色阴影）
- [x] 通用组件 ui.tsx（Btn / Seg / Menu / Dialog 圆角、胶囊）
- [x] 顶栏：居中胶囊导航 + 右上朱红 +，左侧给红绿灯留位
- [x] 首页：大封面 + 白条（播放/标题/按句进度/…），其他视频封面一排
- [x] 练习页：视频上半屏 + 白面板；时长时间轴；控制条；更多面板；查词浮卡；答案错词
- [x] 句子库 / 单词库（合并复习页 + 卡片页）
- [x] 复习中页面沿用影院布局
- [x] 其余：设置、弹窗、段完成、空状态、模糊模式
- [x] tsc + test-*.mjs
- [x] 浏览器实测 + 截图评审（最多 3 轮）
- [x] 快捷键逐个过
- [x] docs / CLAUDE.md 风格描述更新
- [x] 复审：Opus 2 条 + Gemini 1 条已修；等 6-sol
- [x] npm run release
- [x] 6-sol 结论（连字符查词已修）+ 重打包 + 验收路径
