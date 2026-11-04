# dsh-quick-screenshot

Window-aware screenshots for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH), on Windows.

Click the camera in the composer, press one global hotkey, or ask the agent — and choose where each
shot goes: **back into the conversation**, **onto the clipboard**, or **into your project's
`screenshots/` folder**.

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
| `target` | string | `active` (default, the focused window), `region` (opens the overlay so you drag the area yourself), `window:<keyword>`, `monitor:<n>`, `region:x,y,w,h`, `screen` (whole virtual desktop), `latest` (the last hotkey shot). A bare word is treated as a window keyword. |
| `destinations` | string | Comma-separated, or `all` / `none`. `chat` = return it to the model, `clipboard` = copy it, `archive` = save into the project. Default `archive,chat`. |
| `save_path` | string | Save to an explicit absolute path instead (parent directories are created). |

### `quick_screenshot_hotkey`

| Parameter | Type | Description |
|---|---|---|
| `action` | string | `start`, `stop`, `status` (default), `restart`. |
| `combo` | string | e.g. `Ctrl+Shift+A`. At least one modifier is required. |
| `capture` | string | `active` (default), `region` (drag the area after pressing), `monitor`, or `screen` — what a keypress grabs. |
| `archive_dir` | string | Where hotkey shots go. Default: the current project's `screenshots/`. |

## The composer button

A camera button sits in the input bar, next to the platform's own accessory controls. One click
captures the window you are looking at and **stages it in the draft as an image attachment** — not a
file path, not a chat turn. Press Enter when you are ready.

That means the ordinary attachment path applies: the upload queue, byte progress, ordering, and the
durable attachment record all behave exactly as if you had pasted the image yourself.

- The browser cannot read the screen, so the button asks the host over
  `POST /api/quick-screenshot/capture`, registered on the host's authenticated fetch registry (it
  rides the same signed browser cookie as every other route).
- It never refuses: if the foreground window cannot be resolved — alt-tab, a virtual-desktop switch,
  a window mid-destruction — it falls back to the pointer's monitor, then to the whole desktop.
- Captures are archived into the project like every other shot; the clipboard stays off for this
  path because the image is already going into the draft.
- While a capture is in flight the button is disabled and shows a spinner; a failure puts the
  reason in the tooltip instead of failing silently.

Configure it with `composerCapture` (`active` / `monitor` / `screen`), `composerArchive`, and
`composerClipboard` in the settings file below.

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

### Drag to select a region

Set `hotkeyCapture` to `region` (or `quick_screenshot_hotkey { capture: "region" }`) and every
press opens a full-desktop overlay instead of shooting immediately:

- **drag** a rectangle — the area outside your selection dims, the size shows in a label next to
  the pointer, and releasing captures exactly that rectangle;
- **click** a monitor — captures that whole screen, for when a rough region is all you need;
- **Esc** or a right click — cancels without producing a file (a cancelled selection is reported as
  a decision, not an error);
- the overlay dismisses itself after two minutes of no mouse activity, so a stray press can never
  leave a modal window trapping the daemon.

The pixels come from one snapshot taken at the moment of the press, so what you framed is exactly
what you get even if a video underneath keeps playing. A single press produces one capture: the
file, the clipboard copy and the latest pointer all work the same as any other shot.

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
| `hotkeyAutoStart` | `true` | Re-register the hotkey every time DSH starts (see below). |
| `hotkeyCapture` | `active` | `active` / `region` / `monitor` / `screen`. `region` opens the drag-to-select overlay on every press. |
| `archiveDir` | `null` | `null` follows the session workspace. |
| `clipboard` | `true` | Copy every hotkey capture. |
| `format` | `png` | `png` or `jpeg`. |
| `jpegQuality` | `90` | 1–100. |
| `maxWidth` | `0` | Downscale wider captures; `0` keeps native pixels. |
| `showBalloon` | `true` | Tray balloon on each hotkey capture. |
| `excludeProcesses` | `[]` | Never offered as targets. |
| `composerCapture` | `active` | What the composer button captures: `active` / `monitor` / `screen`. |
| `composerArchive` | `true` | Archive composer captures into the project folder too. |
| `composerClipboard` | `false` | Also copy composer captures (usually redundant). |

### The hotkey re-registers itself

A global hotkey belongs to a process, and this host will not grant a detached one. So the daemon is
a child of DSH: it survives focus changes and plugin reloads, and it dies when DSH closes.

That would make "my hotkey stopped working after a restart" the normal case, so the plugin
re-registers on every boot — `hotkeyAutoStart` (on by default), once per host process, at plugin
load. It never blocks or breaks the boot: if registration fails you still get the other tools, and
`quick_screenshot_hotkey` with `action: "status"` reports what that attempt did
(`state/autostart.json`):

| Recorded reason | What it means |
|---|---|
| `started: true` | Registered at boot. If it is missing later, the daemon exited — an earlier DSH process took it down. |
| `already-running` | A daemon was already up, so this boot left it alone instead of fighting over the same combo. |
| `start-failed` | Registration failed — most often the combo is taken. Change it with `combo`, and the new one is what boots use from then on. |
| `disabled` | `hotkeyAutoStart` is `false`. |


## How it works

```
DSH plugin (Node)                       browser (Web client)
 ├─ 3 tools                              └─ camera button in the composer
 ├─ POST /api/quick-screenshot/capture  ←──── fetch, same-origin cookie
 └─ resident PowerShell helper (JSON-Lines over stdio)
       ├─ EnumWindows / DWM frame bounds / DPI      → window list
       ├─ GDI+ screen copy + PrintWindow fallback   → PNG/JPEG
       ├─ Clipboard                                 → paste anywhere
       └─ RegisterHotKey + message pump             → detached daemon
```

Five decisions are load-bearing:

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
5. **The composer button stages a real File, not a special case.** It receives PNG bytes over an
   authenticated route and hands them to the composer's own `addFiles` intake, so uploads,
   ordering, and durable attachments behave exactly like a pasted image — and the plugin never
   touches the attachment store itself.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Captures are blurry or offset | The process is not DPI aware. Run `scripts/doctor.ps1` and check `dpi level` is `per-monitor-v2`. |
| A window captures as flat colour | It is minimized, protected, or DRM. Un-minimize it, or use `target: "screen"`. |
| `HOTKEY_REGISTER_FAILED` | Another app owns that combo. Use `combo: "Ctrl+Shift+A"`, or stop the other app. |
| Hotkey does nothing after a reboot | The daemon is not auto-started. Run `quick_screenshot_hotkey { action: "start" }`. |
| `Process` shows as `unknown` | The host runs below the target's integrity level (e.g. inside a sandboxed shell), so process names cannot be read. Matching by title still works. |
| Blank frames everywhere | The desktop is locked, or a remote session is disconnected. |
| `pnpm` fails with `EPERM: rename …dsh-quick-screenshot` | A process was running with the package directory as its working directory, so Windows refused to rename it. Fixed in 0.1.2 (children now run in the plugin-data folder); upgrade, and if a stale helper still holds it, stop DSH first. |
| DSH will not start after installing a version | Disable plugins to get back in, then pin a known-good release: `dsh plugin --profile desktop add git+https://github.com/Wei-DuanMu/dsh-quick-screenshot.git#v0.2.1`. 0.2.0 had this failure mode (an invalid `dsh.client.inject` entry) and 0.2.1 fixed it; a client plugin that cannot mount its own button must never stop the app from booting. |

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
lib/index.js         tool schemas, descriptions, and the composer capture route
lib/actions.js       capture orchestration, hotkey control, composer capture
lib/client.js        the composer button (hand-written module-loader bundle, no build)
lib/render.js        every user-facing sentence
lib/windows.js       window scoring and target parsing
lib/combo.js         "Ctrl+Alt+A" → Win32 modifiers + virtual key
lib/helper-client.js helper lifecycle and JSON-Lines framing
lib/hotkey.js        daemon lifecycle (detached, file-driven)
lib/config.js        settings file
host/*.ps1           the Win32 layer (ASCII-only: PowerShell 5.1 reads .ps1 as ANSI)
scripts/doctor.ps1   one-command self-check
```

`test/client.test.mjs` runs the real `lib/client.js` in Node with a stubbed module loader, React,
and `fetch`, so a bad bundle format or a broken intake call fails `npm test` instead of a DSH
restart. The client bundle is hand-authored: the host serves it verbatim, so there is no build step
to break and no toolchain to install.

## License

MIT
