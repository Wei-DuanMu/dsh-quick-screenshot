# dsh-quick-screenshot

Window-aware screenshots for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH), on Windows.

Ask the agent to screenshot what you are looking at, or press one global hotkey — and choose
where each shot goes: **back into the conversation**, **onto the clipboard**, or **into your
project's `screenshots/` folder**.

```
你: 截一下现在这个窗口
    → quick_screenshot { target: "active" }
    → 已截图：「Microsoft Edge」2512x1440，屏幕取样，已留档 · 已回传给模型
```

## Why this exists

Most "screenshot" integrations take a picture of *everything*, or hand you a file path you then
have to find. This one is built around three details that decide whether it is actually usable:

- **It knows which window you mean.** Windows are enumerated with real DWM frame bounds and
  matched by title or process name, so `target: "window:微信"` captures WeChat and not whatever
  happened to be on top.
- **It never returns a black image.** Several capture strategies are tried, and every frame is
  checked for being a single flat colour before it is reported as a success.
- **It survives a busy keyboard.** `Ctrl+Alt+A` is already taken on a surprisingly large number
  of machines; the plugin finds the first combo that actually registers and tells you which one
  it got.

## Requirements

| | |
|---|---|
| OS | Windows 10 / 11 (x64 or arm64) |
| DSH | core `0.2.1-rc.2` or newer |
| PowerShell | Windows PowerShell 5.1 (built in — nothing to install) |

No native addon, no compiler, no extra runtime: the capture layer is PowerShell + .NET.

## Install

```bash
dsh plugin --profile desktop add git+https://github.com/Wei-DuanMu/dsh-quick-screenshot.git
```

Restart DSH. Then verify the capture layer works on your machine:

```powershell
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass `
  -File "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-quick-screenshot\scripts\doctor.ps1"
```

It prints the DPI awareness level, every monitor, every capturable window, and a real capture of
the focused window — so a failure becomes a specific, reportable fact instead of "it doesn't work".

## Tools

### `quick_screenshot_windows`

What can I capture right now? Returns id, title, process, size, monitor and the focused flag for
every window, plus the monitor list. The focused window sorts first.

| Parameter | Type | Description |
|---|---|---|
| `query` | string | Fuzzy match on window title or process name (`Edge`, `微信`, `bilibili`). Space-separated words must all appear in the title. |
| `include_minimized` | boolean | Include minimized windows (default `false`). They can only be captured via `PrintWindow` and often come back blank. |

### `quick_screenshot`

| Parameter | Type | Description |
|---|---|---|
| `target` | string | `active` (default, the focused window), `window:<keyword>`, `monitor:<n>`, `region:x,y,w,h`, `screen` (whole virtual desktop), `latest` (the last hotkey shot). A bare word is treated as a window keyword. |
| `destinations` | string | Comma-separated, or `all` / `none`. `chat` = return it to the model, `clipboard` = copy it, `archive` = save into the project. Default `archive,chat`. |
| `save_path` | string | Save to an explicit absolute path instead (parent directories are created). |

### `quick_screenshot_hotkey`

| Parameter | Type | Description |
|---|---|---|
| `action` | string | `start`, `stop`, `status` (default), `restart`. |
| `combo` | string | e.g. `Ctrl+Shift+A`. At least one modifier is required. |
| `capture` | string | `active` (default), `monitor`, or `screen` — what a keypress grabs. |
| `archive_dir` | string | Where hotkey shots go. Default: the current project's `screenshots/`. |

## The hotkey

Default `Ctrl+Alt+A`. On press it captures the focused window, writes it into the project's
`screenshots/` folder, copies it to the clipboard, and updates the **latest** pointer — so
afterwards you can just say *"give me the screenshot I just took"* and the agent reads it with
`target: "latest"`.

It works while DSH is minimized or behind other windows, because the listener is a detached
process rather than something inside a chat session. `quick_screenshot_hotkey { action: "stop" }`
ends it.

If your chosen combo is already owned by another application, the plugin tries a short fallback
list and reports the result honestly:

```
全局快捷键正在运行：Ctrl+Shift+A（进程 23992）
注意：你想要的 Ctrl+Alt+A 已被其他程序占用，已自动改用 Ctrl+Shift+A。
```

## Where shots go

| Destination | Meaning |
|---|---|
| `chat` | Returned to the model as an image. If the current model has no vision, the host substitutes a text placeholder — the path still comes back, so nothing is lost. |
| `clipboard` | Copied as a bitmap: paste straight into WeChat, a document, or a PR. |
| `archive` | Saved under the session workspace as `screenshots/YYYYMMDD_HHMMSS_<window-title>.png`. Never overwrites: a second shot in the same second gets `-2`, `-3`, … |

Destinations combine freely (`destinations: "all"`), which is the point: the same keypress can
feed the agent *and* leave you something to paste.

## Configuration

`%USERPROFILE%\.dsh\plugin-data\dsh-quick-screenshot\config.json` — created on first use, and
patchable through `quick_screenshot_hotkey`:

| Key | Default | Meaning |
|---|---|---|
| `hotkey` | `Ctrl+Alt+A` | Preferred combo. |
| `hotkeyCapture` | `active` | `active` / `monitor` / `screen`. |
| `archiveDir` | `null` | `null` follows the session workspace. |
| `clipboard` | `true` | Copy every hotkey capture. |
| `format` | `png` | `png` or `jpeg`. |
| `jpegQuality` | `90` | 1–100. |
| `maxWidth` | `0` | Downscale wider captures; `0` keeps native pixels. |
| `showBalloon` | `true` | Tray balloon on each hotkey capture. |
| `excludeProcesses` | `[]` | Never offered as targets. |

## How it works

```
DSH plugin (Node)
 ├─ 3 tools
 └─ resident PowerShell helper (JSON-Lines over stdio)
       ├─ EnumWindows / DWM frame bounds / DPI      → window list
       ├─ GDI+ screen copy + PrintWindow fallback   → PNG/JPEG
       ├─ Clipboard                                 → paste anywhere
       └─ RegisterHotKey + message pump             → detached daemon
```

Four decisions are load-bearing:

1. **DPI awareness is raised to per-monitor-v2 before any geometry is read.** Without it Windows
   virtualizes coordinates: on the development machine the same display reports 1707×1067 instead
   of its real 2560×1600, and every capture is scaled and offset.
2. **`PrintWindow` is tried first, then screen copy.** `PrintWindow` still works for occluded
   windows but returns a blank frame for many Electron/DWM windows (measured on the DSH host
   itself). The blank check decides which result to keep — a flat frame is never reported as
   success.
3. **One long-lived helper.** Cold start is ~1 s (PowerShell + the `Add-Type` compile); a warm
   capture is tens of milliseconds. The helper is started once and every request has a deadline.
4. **The hotkey daemon is detached and file-driven.** A hotkey has to fire while DSH is
   unfocused, and a capture has to survive a plugin reload, so the plugin talks to the daemon
   through `daemon.json`, `events.ndjson` and `latest.json` instead of a pipe.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Captures are blurry or offset | The process is not DPI aware. Run `scripts/doctor.ps1` and check `dpi level` is `per-monitor-v2`. |
| A window captures as flat colour | It is minimized, protected, or DRM. Un-minimize it, or use `target: "screen"`. |
| `HOTKEY_REGISTER_FAILED` | Another app owns that combo. Use `combo: "Ctrl+Shift+A"`, or stop the other app. |
| Hotkey does nothing after a reboot | The daemon is not auto-started. Run `quick_screenshot_hotkey { action: "start" }`. |
| `Process` shows as `unknown` | The host runs below the target's integrity level (e.g. inside a sandboxed shell), so process names cannot be read. Matching by title still works. |
| Blank frames everywhere | The desktop is locked, or a remote session is disconnected. |

## Limitations

- **Windows only.** Window enumeration and global hotkeys are a different implementation per OS.
- **No video, OCR, scrolling capture or annotation.** This plugin takes still frames.
- **DRM and hardware-overlay surfaces** (some players, some games) can capture as black; that is
  the compositor refusing, not the plugin.
- **Vision needs a vision model.** With a text-only model, `chat` delivery degrades to a text
  placeholder plus the file path.

## Development

```bash
npm test                       # unit + action tests (no desktop needed)
npm run test:integration       # drives the real helper and daemon
node test/all.test.mjs         # same tests in one process, for restricted sandboxes
```

```
lib/index.js         tool schemas and descriptions only
lib/actions.js       capture orchestration, hotkey control (unit-tested with a fake helper)
lib/render.js        every user-facing sentence
lib/windows.js       window scoring and target parsing
lib/combo.js         "Ctrl+Alt+A" → Win32 modifiers + virtual key
lib/helper-client.js helper lifecycle and JSON-Lines framing
lib/hotkey.js        daemon lifecycle (detached, file-driven)
lib/config.js        settings file
host/*.ps1           the Win32 layer (ASCII-only: PowerShell 5.1 reads .ps1 as ANSI)
scripts/doctor.ps1   one-command self-check
```

## License

MIT
