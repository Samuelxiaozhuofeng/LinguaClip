# 看剧模式（watch）

全窗口看片 + 叠加字幕，边看边查词 / 收藏，看完挑收藏句去听写。**独立页面，不走练习会话**。

## 文件

| 文件 | 管什么 |
|---|---|
| `components/CustomPanel.tsx` | 「练法」第三项 `watch` → `onStart({ kind: 'watch' })`；上次是否选看剧存 `watchPrefs.chosen` |
| `App.tsx` `openPractice` | watch 分支：查路径（同练习）→ 字幕为空弹 `app.noSubtitles*` → 只 patch `lastPracticed` → `AppState.WATCH` |
| `components/WatchPage.tsx` | 页面：播放、当前句、快捷键、收藏、Anki、查词、小结 / 听写入口 |
| `components/WatchLine.tsx` | 叠加字幕一行：`show` / `blur` / `hide`，按词查词（纯文本渲染） |
| `components/WatchList.tsx` | 右侧字幕列表（学 asbplayer）：当前句高亮、鼠标不在列表上时自动滚到中间、点一句 `jump`、左边缘拖宽（20–50%，松手才存） |
| `components/WatchSummary.tsx` | 小结弹窗：收藏句勾选 → 听写；本次查过的词 → 再查 |
| `utils/srtParser.ts` `lineAt` | 某一秒的「当前句」= 最后一个已开始的句子（`test-watch.mjs`） |
| `utils/storage.ts` watch 段 | `linguaclip_watch_pos`（秒，看完归零，删视频清）/ `linguaclip_watch_prefs`（`subs` / `autoPause` / `chosen` / `pin` / `list` / `listPct`） |

## 不变量（改前核对）

- 不用 `usePracticeSession` / `PracticeProvider` / `saveProgress` / `setCustomPos`：看剧**不改段进度、定制进度、`learningMode`**，不计 `countLine` / `usePracticeClock`。
- App 全局快捷键只在 `AppState.PRACTICE` 生效，看剧键全在 `WatchPage` 自己的 keydown 里。
- 收藏 / 收词 / Anki 复用练习页那套：`useSavedLines`（卡 id = `视频id|start.toFixed(2)`，与练习页同一张卡）、`addWord`、`useAnkiIntegration`。
- 字幕按 `startTime` 排序后用；`lineAt` 依赖有序。
- `cur = { at, on }`：`at` = 最后开始的句，`on` = 仍在句内。屏幕显示 `on ? lines[at] : null`；S / Anki / 重听作用于 `lines[at]`（句间空档时 = 刚说完那句）。
- 句尾暂停：只在播放**自然越过**句尾时触发（`before < end <= now` 且 `now - before < 0.5`）；暂停后退回 `end - 0.02`，让刚说完那句留在屏幕上；`heldAt` 防止恢复播放时同一句再停；任何 `seek` 清 `heldAt`。
- `busy()` = 句子 Anki 录音（`ankiStatus === 'recording'`）或释义里单词 Anki 录音（`wordRecording`）。busy 时：不句尾暂停、不 seek / 播放切换、不存位置、`onEnded` 不清零不弹小结、返回键禁用、书签禁用。录音会自己 seek + play 视频。
- 查词：播放中点词先暂停并记 `resumeAfter`；关释义时若 `resumeAfter` 且无小结则恢复播放；期间手动播放 / 暂停清掉 `resumeAfter`。`lookup(word, line)` 第二参覆盖上下文（小结里再查用）。
- 切换字幕显示方式清 `revealed`（在模糊里点开的句子切到隐藏要重新藏）。
- 两条栏按鼠标位置显示：顶部返回按钮 = 鼠标 y < 88 或在 `header` 上；底部控制条 = 距底 < 44（字幕下方，瞄字幕查词不会带出栏）或在 `footer` 上，或钉住（`watchPrefs.pin`）（「…」菜单是 footer 的子元素，鼠标进菜单不收起）；进页面两条都先亮 2.5 秒；暂停不强制显示；鼠标离开窗口两条都收。**鼠标在字幕带（`[data-watch-line]`）上或释义开着时，底部栏状态冻结**——它会把字幕顶上去 / 放下来，不冻结字幕就躲鼠标（`bounce` 实测）。隐藏时 `pointer-events-none`。字幕 `bottom` 跟底部栏：132 / 44。鼠标静止 2.5 秒且在播放、不在两条栏区域 → 隐藏指针。
- 字幕列表开着时视频区（含顶栏、字幕、控制条）缩到左侧 `100 - listPct`%；鼠标在列表上两条栏都不算「靠近」。控制条按视频区宽度折叠：< 900 句尾暂停收进「…」，< 720 字幕显示切换也收进去。
- 全屏 = Tauri 窗口全屏（`utils/desktop.ts` 的 `isFullscreen` / `setFullscreen`，capabilities 里 `core:window:allow-is-fullscreen` / `allow-set-fullscreen`）。切换时先记目标状态（Mac 全屏动画约 0.5 秒，立刻回读会读到旧值），之后每次 `resize` 和切换后 1.2 秒回读实际状态（绿色按钮也会改它）；离开页面若在全屏则退出。黑边保持居中（用户拍板，不裁切、不贴顶）。

## 快捷键（`WatchPage` keys）

空格 播放/暂停 · `replay`（默认 ⇧空格）重听当前句 · ⌘← 或 `prev` 上一句（在句内 → 前一句；在空档 → 刚说完那句）· ⌘→ 或 `next` 下一句 · ←/→ ±5 秒 · S 收藏切换 · P 句尾暂停 · C 字幕 show→blur→hide · F 全屏切换 · `anki`（默认 ⌘⇧N）· Esc 依次：关释义 → 关小结 → 退全屏，**从不退出页面**。
小结、听写（`ReviewSession`）开着时只认 Esc；输入法组字中不处理。字母键要求无修饰键。

## 小结

- 弹出：`ended`（非 busy）；或点返回且 `activity > shownAt`（上次弹小结后有新收藏 / 新查词），否则直接退出。
- 收藏句 = 本视频全部收藏（`savedItems`），默认不勾；查过的词只算本次进入以来。
- 「听写选中的 N 句」：`getAllCards()` 取本视频、`deck:'line'`、start 命中、`hasAudio` 的卡 → `ReviewSession`（会按 FSRS 记分），关掉回小结。
- Esc / 点遮罩 = 只关小结；「接着看」= 关 + 播放；播完时换成「从头再看」。

## 验证

- `node test-watch.mjs`；浏览器实测见 CLAUDE.md（面板 `radio`「看剧」→「开始看剧」；样片第 2、3 句首尾相接，可测句尾暂停停在第 2 句内）。
- 浏览器验不到：Anki 录音成卡、Mac 原生全屏（mock 用页面全屏代替，无头浏览器可能拒绝）、真实视频解码。
