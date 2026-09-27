# 桌面版（Tauri）细节

## 运行时事实

- 页面 origin 是 `tauri://localhost`，本地视频经 asset 协议是 `asset://localhost/<encoded path>`，两者跨源。asset 协议会回 `Access-Control-Allow-Origin`，所以 `<video crossOrigin="anonymous">` 必须带上，否则截图 canvas 被污染、Web Audio 出静音。
- WKWebView 没有：`showOpenFilePicker`、`FileSystemFileHandle`、`HTMLMediaElement.captureStream()`。Mac 内核放不了 mkv / avi / 多数 webm，所以播放只认 mp4 / mov / m4v；别的格式在导入时转成 mp4（见 docs/import.md「转 mp4」），扩展名清单收口在 `utils/desktop.ts`。
- Tauri 默认接管窗口拖放（`dragDropEnabled` 未关），HTML5 `onDrop` 拿不到文件；用 `getCurrentWebview().onDragDropEvent`，payload 是绝对路径数组。
- 系统标题栏隐藏（`titleBarStyle: Overlay` + `hiddenTitle`），红绿灯悬浮在页面左上；`Shell.tsx` / `Studio.tsx` 顶栏 `pl-[80px]` 留位，`data-tauri-drag-region` 让顶栏可拖窗。
- 外链用 `@tauri-apps/plugin-opener` 的 `openUrl`，`target="_blank"` 在壳子里没反应。

## 文件与记录

- 新建 / 续练都拿绝对路径：`pickVideoPath()` / `pickSubtitlePath()`（系统对话框）或拖放事件。
- `VideoRecord.videoPath` 存绝对路径；续练先 `pathExists()`，不存在走「请重新选视频」对话框，选完 `patchVideoRecord(id, { videoPath })` 写回（先重读再写，别整条覆盖）。
- 字幕读成文本存进记录（`readSubtitleFile(path)` → File），之后不再依赖字幕文件。
- 视频从不读进内存：`videoSrcFromPath(path)` = `convertFileSrc(path)`。

## Anki

- `utils/anki.ts` 的 `fetch` 来自 `@tauri-apps/plugin-http`（绕过 AnkiConnect 的 CORS）。http 权限放行 `http://127.0.0.1:*` 与 `http://localhost:*`（任意端口，仅本机）。
- Anki 卡的音频：`hooks/useAnkiIntegration.ts` 对 `<video>` 建一次 `AudioContext` + `createMediaElementSource`（WeakMap 缓存，重复建会抛错），source 同时接回 `ctx.destination`（不然用户听不到声）；录制时临时接一个 `MediaStreamAudioDestinationNode` 喂 `MediaRecorder`。mimeType 探测 `audio/webm` → `audio/mp4`，扩展名随之传给 `addNote`。

## 权限（`src-tauri/capabilities/default.json`）

`fs:allow-read-file` / `read-text-file` / `exists` 放行 `**`（视频可能在任何地方）；`assetProtocol.scope` 也是 `**`；`csp: null`。缩紧任何一项前先想清楚用户视频存哪。

## 打包

- `npx tauri build`，`.app` 在 `src-tauri/target/release/bundle/macos/`。DMG 那步脚本要 Finder 自动化权限，失败就用 `hdiutil create -volname LinguaClip -srcfolder <.app> -ov -format UDZO LinguaClip.dmg`。
- npm 侧 `@tauri-apps/plugin-*` 与 Rust 侧 `tauri-plugin-*` 必须同 major.minor，不然 `tauri build` 直接拒绝（http 插件目前钉在 2.6.1）。
- 图标源文件不在仓库：纸面 + 高亮条 + 绿色播放三角，重做用 `npx tauri icon <1024png>` 生成 `src-tauri/icons/`。
- Windows 版未做；要做需在 Windows 机器或 GitHub Actions 上跑 `tauri build`。
