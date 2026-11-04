# dsh-quick-screenshot

给 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）用的 Windows 截图插件。

点输入栏里的相机按钮、按一个全局快捷键、或者直接跟 agent 说一句——每张图可以选择三种去处：
**回传给对话里的模型**、**复制到剪贴板**、**存进项目的 `screenshots/` 文件夹留档**。

```
你: 截一下现在这个窗口
    → quick_screenshot { target: "active" }
    → 已截图：「Microsoft Edge」2512x1440，屏幕取样，已留档 · 已回传给模型
```

## 为什么值得装

大多数"截图插件"要么只截全屏，要么给你一个还得自己去找的文件路径。这个插件围着三个真正
决定好不好用的细节做：

- **知道你说的是哪个窗口。** 用 DWM 真实边框枚举窗口，按标题或进程名匹配，所以
  `target: "window:微信"` 截的就是微信，不是碰巧在它上面的那个窗口。
- **绝不拿黑图充数。** 按顺序尝试多种截取方式，每一帧都先检测"是不是一整片纯色"，才敢报成功。
- **不怕快捷键被占。** `Ctrl+Alt+A` 在很多机器上已经被别的软件拿走了；插件会自动找到第一个
  真的能注册成功的组合，并明确告诉你它最后用的是什么。

## 环境要求

| | |
|---|---|
| 系统 | Windows 10 / 11（x64 或 arm64） |
| DSH | core `0.2.1-rc.2` 或更新 |
| PowerShell | Windows PowerShell 5.1（系统自带，无需安装） |

不需要原生插件、不需要编译器、不需要额外运行时：截图层由 PowerShell + .NET 完成。

## 安装

```bash
dsh plugin --profile desktop add git+https://github.com/Wei-DuanMu/dsh-quick-screenshot.git
```

重启 DSH。然后先跑一次自检，确认这台机器上截图链路是通的：

```powershell
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass `
  -File "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-quick-screenshot\scripts\doctor.ps1"
```

它会打印 DPI 感知级别、每块显示器、每个可截窗口，以及一张真实的前台窗口截图——这样"用不了"
就变成一条具体、可反馈的事实。

## 三个工具

### `quick_screenshot_windows`

现在能截哪些窗口？返回每个窗口的 id、标题、进程、尺寸、所在显示器、是否为活动窗口，外加
显示器列表。活动窗口排在最前。

| 参数 | 类型 | 说明 |
|---|---|---|
| `query` | string | 按窗口标题或进程名模糊匹配（`Edge`、`微信`、`bilibili`）。用空格分隔的多个词必须都出现在标题里。 |
| `include_minimized` | boolean | 是否包含已最小化的窗口（默认 `false`）。这类窗口只能靠 `PrintWindow` 截，经常是空白。 |

### `quick_screenshot`

| 参数 | 类型 | 说明 |
|---|---|---|
| `target` | string | `active`（默认，当前活动窗口）、`window:<关键词>`、`monitor:<编号>`、`region:x,y,w,h`、`screen`（整个虚拟桌面）、`latest`（最近一次快捷键截图）。只写一个词会被当作窗口关键词。 |
| `destinations` | string | 逗号分隔，或写 `all` / `none`。`chat`=回传给模型、`clipboard`=复制到剪贴板、`archive`=存进项目。默认 `archive,chat`。 |
| `save_path` | string | 改用指定的绝对路径保存（父目录会自动创建）。 |

### `quick_screenshot_hotkey`

| 参数 | 类型 | 说明 |
|---|---|---|
| `action` | string | `start`、`stop`、`status`（默认）、`restart`。 |
| `combo` | string | 例如 `Ctrl+Shift+A`。必须至少包含一个修饰键。 |
| `capture` | string | `active`（默认）、`monitor`、`screen`——按键时截什么。 |
| `archive_dir` | string | 快捷键截图存哪里。默认当前项目下的 `screenshots/`。 |

## 输入栏按钮

输入栏里有一个相机按钮，紧挨着平台自己的附件控件。点一下就会截取你正在看的窗口，并**直接以图片附件的形式放进草稿**——不是文件路径、也不是一整轮对话，你觉得可以了按回车发出去。

这条路径走的是平台原生的附件通道：上传队列、字节进度、顺序、以及发送后 durable 附件记录，和你自己粘贴一张图完全一致。

- 浏览器读不到屏幕，所以按钮通过 `POST /api/quick-screenshot/capture` 向宿主取图；这条路由注册在宿主带鉴权的 fetch 注册表上，用的是和其他路由同一份签名 Cookie。
- **它不会失败**：如果当前前台窗口解析不出来（切换窗口、切换虚拟桌面、窗口正在销毁），会退到鼠标所在显示器，再退到整个桌面。
- 和其它截图一样会留档到项目的 `screenshots/`；剪贴板在这条路径上默认关闭，因为图已经进草稿了。
- 截图过程中按钮禁用并转圈；失败时把原因放进 tooltip，而不是默默什么都不发生。

相关配置：`composerCapture`（`active`/`monitor`/`screen`）、`composerArchive`、`composerClipboard`。

## 快捷键

默认 `Ctrl+Alt+A`。按下后：截当前窗口 → 写进项目的 `screenshots/` → 复制到剪贴板 → 更新
**latest** 指针。之后你只要说"把我刚才截的图给你看"，agent 用 `target: "latest"` 就能取到。

DSH 最小化或被其他窗口盖住时同样有效，因为监听器是一个独立进程，而不是挂在某个对话会话里。
`quick_screenshot_hotkey { action: "stop" }` 可以随时停掉。

如果你选的组合已经被别的软件占用，插件会依次尝试后备组合，并如实报告：

```
全局快捷键正在运行：Ctrl+Shift+A（进程 23992）
注意：你想要的 Ctrl+Alt+A 已被其他程序占用，已自动改用 Ctrl+Shift+A。
```

## 三个去处

| 去处 | 含义 |
|---|---|
| `chat` | 作为图片回传给模型。若当前模型不支持视觉，宿主会用文字占位符替代，路径照样返回，信息不丢。 |
| `clipboard` | 作为位图复制到剪贴板：直接粘进微信、文档或 PR。 |
| `archive` | 存到会话工作区的 `screenshots/YYYYMMDD_HHMMSS_<窗口标题>.png`。不会互相覆盖：同一秒的第二张会变成 `-2`、`-3`。 |

三个去处可以任意组合（`destinations: "all"`），这正是重点：同一次按键既能喂给 agent，也能
留一份给你自己粘。

## 配置

`%USERPROFILE%\.dsh\plugin-data\dsh-quick-screenshot\config.json`——首次使用时自动创建，也可以
通过 `quick_screenshot_hotkey` 修改：

| 键 | 默认值 | 含义 |
|---|---|---|
| `hotkey` | `Ctrl+Alt+A` | 首选组合键。 |
| `hotkeyCapture` | `active` | `active` / `monitor` / `screen`。 |
| `archiveDir` | `null` | `null` 表示跟随会话工作区。 |
| `clipboard` | `true` | 每次快捷键截图都复制。 |
| `format` | `png` | `png` 或 `jpeg`。 |
| `jpegQuality` | `90` | 1–100。 |
| `maxWidth` | `0` | 超宽图自动缩小；`0` 保持原始像素。 |
| `showBalloon` | `true` | 每次快捷键截图弹托盘提示。 |
| `excludeProcesses` | `[]` | 永远不作为截图目标的进程。 |
| `composerCapture` | `active` | 输入栏按钮截什么：`active` / `monitor` / `screen`。 |
| `composerArchive` | `true` | 按钮截的图是否也留档到项目文件夹。 |
| `composerClipboard` | `false` | 按钮截的图是否也复制到剪贴板（通常多余）。 |

## 实现要点

```
DSH 插件（Node）                      浏览器（Web 客户端）
 ├─ 3 个工具                            └─ 输入栏里的相机按钮
 ├─ POST /api/quick-screenshot/capture  ←──── 同源 fetch，带签名 Cookie
 └─ 常驻 PowerShell 助手（stdio 上的 JSON-Lines）
       ├─ EnumWindows / DWM 边框 / DPI          → 窗口列表
       ├─ GDI+ 抓屏 + PrintWindow 兜底          → PNG/JPEG
       ├─ 剪贴板                                → 随处粘贴
       └─ RegisterHotKey + 消息泵               → 独立守护进程
```

五个关键决定：

1. **读取任何坐标之前，先把 DPI 感知提到 per-monitor-v2。** 否则 Windows 会做坐标虚拟化：在
   开发机上同一块屏会报成 1707×1067 而不是真实的 2560×1600，截出来的图既糊又偏。
2. **先试 `PrintWindow`，再退回到抓屏。** `PrintWindow` 能截到被遮挡的窗口，但对很多
   Electron/DWM 窗口只会返回一片空白（在 DSH 自己身上实测如此）。纯色检测决定用哪一份结果——
   纯色帧永远不会被当成成功。
3. **一个常驻助手进程。** 冷启动约 1 秒（PowerShell 启动 + `Add-Type` 编译），热态截图只要几十
   毫秒；所以助手只启动一次，并且每个请求都有超时。
4. **快捷键守护进程独立且靠文件通信。** 快捷键必须在 DSH 不在前台时也能用，截图也必须能在插件
   重载后继续存在，所以插件通过 `daemon.json`、`events.ndjson`、`latest.json` 跟它通信，而不是管道。
5. **输入栏按钮放进草稿的是真正的 File，不是特例。** 它通过鉴权路由拿到 PNG 字节，再交给平台自己的
   `addFiles` 附件入口，因此上传、排序、durable 附件都和你粘贴一张图完全一致——插件自己不碰附件存储。

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| 截图糊或位置偏 | 进程没有 DPI 感知。跑 `scripts/doctor.ps1`，确认 `dpi level` 是 `per-monitor-v2`。 |
| 某个窗口截出来是纯色 | 窗口被最小化、受保护、或 DRM。还原窗口，或改用 `target: "screen"`。 |
| `HOTKEY_REGISTER_FAILED` | 组合键被别的软件占用。用 `combo: "Ctrl+Shift+A"`，或先关掉那个软件。 |
| 重启后快捷键失效 | 守护进程不会随开机自启。执行 `quick_screenshot_hotkey { action: "start" }`。 |
| `进程` 显示 `unknown` | 宿主进程的运行完整性等级低于目标进程（例如在沙箱化终端里），读不到进程名。按标题匹配仍然可用。 |
| 所有截图都是空白 | 桌面已锁屏，或远程会话已断开。 |
| `pnpm` 报 `EPERM: rename …dsh-quick-screenshot` | 有进程把插件包目录当成工作目录，Windows 因此拒绝重命名该目录。0.1.2 已修复（子进程改在 plugin-data 下运行）；升级即可，若仍被旧助手占用，先退出 DSH 再更新。 |

## 已知限制

- **只支持 Windows。** 窗口枚举和全局快捷键在每个系统上都是另一套实现。
- **不做录屏、OCR、滚动长截图、标注。** 这个插件只截静态帧。
- **DRM 与硬件叠加层**（部分播放器、部分游戏）可能截出黑色；那是合成器拒绝共享画面，不是插件的问题。
- **看图需要视觉模型。** 纯文本模型下，`chat` 会降级成文字占位符 + 文件路径。

## 开发

```bash
npm test                       # 单元 + 动作测试（不需要桌面）
npm run test:integration       # 驱动真实的 PowerShell 助手与守护进程
node test/all.test.mjs         # 单进程跑同一批测试，适合受限沙箱
```

```
lib/index.js         工具 schema、描述，以及输入栏截图路由
lib/actions.js       截图编排、快捷键控制、输入栏截图（用假助手做单测）
lib/client.js        输入栏按钮（手写的 module-loader bundle，无需构建）
lib/render.js        所有面向用户的文案
lib/windows.js       窗口打分与目标解析
lib/combo.js         "Ctrl+Alt+A" → Win32 修饰位 + 虚拟键码
lib/helper-client.js 助手生命周期与 JSON-Lines 分帧
lib/hotkey.js        守护进程生命周期（独立、靠文件通信）
lib/config.js        配置文件
host/*.ps1           Win32 层（纯 ASCII：PowerShell 5.1 按 ANSI 读 .ps1）
scripts/doctor.ps1   一条命令的自检
```

`test/client.test.mjs` 会在 Node 里用打桩的 module loader、React 和 `fetch` **真跑** `lib/client.js`，
所以 bundle 格式或附件入口写错会在 `npm test` 阶段失败，而不是等你重启 DSH 才发现。客户端 bundle 是
手写的：宿主原样提供服务，因此没有构建步骤可坏，也不需要安装任何构建工具链。

## 许可证

MIT
