# Changelog

## 0.5.0 — 2026-11-05

**The settings live in Settings → Integrations now**

A panel under the DSH settings window covers everything that previously needed a hand-edited
`config.json`: the on/off switch, the hotkey (record it by pressing the keys), the capture mode,
whether the mouse pointer is included, the archive folder, and copy-to-clipboard.

- **The switch is a real side effect.** Turning it off unregisters the global hotkey so the
  combination goes back to the rest of Windows; turning it on registers it again. The daemon
  re-reads the config on every press, so changing mode/cursor/clipboard needs no restart.
- **Four capture modes, named after what they capture**: `all` (全部屏幕), `current` (当前屏幕 —
  the monitor holding the foreground window), `cursor-monitor` (光标所在屏幕) and `app`
  (光标所在应用). The old names still work: `screen` → `all`, `monitor` → `current`,
  `active` → `app`, so an existing config keeps behaving the same.
- **`includeCursor` draws the actual mouse pointer** into the shot (Win32 `GetCursorInfo` +
  `DrawIconEx`, honouring the hotspot), instead of a fake crosshair.
- The panel talks to the host through a same-origin route,
  `GET/POST /api/quick-screenshot/settings`, which needs no auth of its own because it rides the
  browser's signed cookie.
- The client half is contained: each registration step is wrapped, the bundle is guarded, and
  `dsh.client` declares no `inject` packages — the failure mode of 0.2.0 (a dead Web UI) is
  structurally unavailable.
- A config write is now serialised per directory. Boot-time hotkey registration and a panel save
  both patch the same file, and the loser of that race used to discard the other's keys.

## 0.4.2 — 2026-11-05

**The hotkey obeys `hotkeyCapture` again**

The 0.4.0 release carried a fix for a bug older than itself: the daemon read a config key
called `captureMode`, which the plugin has never written — it writes `hotkeyCapture`. So
changing the capture mode changed nothing on a press, and the window was always captured.
Reverting to the 0.3.0 tree (0.4.1) took that fix with it; this release puts it back on its
own, with a regression test that drives the real `Read-CaptureConfig` out of the real script
through PowerShell instead of grepping for the string.

Both names are accepted now: `hotkeyCapture` wins, `captureMode` still works for a
hand-edited config, and a blank value falls through to the other one.

## 0.4.1 — 2026-11-05

**Back to 0.3.0's surface: hotkey only**

The region overlay (0.4.0) and the composer camera button (0.2.x) are gone. This release restores
the 0.3.0 tree and additionally strips the browser half:

- `hotkeyCapture: "region"` no longer exists; a press captures the window immediately again.
- The composer button, its capture route, and the client bundle are removed, along with
  `dsh.client`, the `./client` export, and the `composerCapture` / `composerArchive` /
  `composerClipboard` settings. The plugin is now host-only: three tools plus the hotkey.
- Leftover composer keys in an existing `config.json` are ignored, so upgrading needs no manual
  edit.

Both features were published and then withdrawn by request; the tags `v0.4.0` and `v0.2.0`–`v0.2.3`
stay in history for anyone who wants to read how they worked.

## 0.3.0 — 2026-11-05

**The hotkey now comes back by itself after a restart**

A global hotkey belongs to a process, and this host refuses to create a detached one — so the daemon
is a child of DSH and dies with it. Every restart therefore left the hotkey dead until someone called
`quick_screenshot_hotkey {action:"start"}` by hand, which is a maintenance task no user should have.

The plugin now re-registers at load, once per host process (`hotkeyAutoStart`, default `true`):

- fire-and-forget — plugin load never waits on a hotkey, and a machine where registration fails still
  gets the other three tools;
- `already-running` is respected, so a second DSH process does not fight the first one for the combo;
- if `archiveDir` is unset, the fallback is persisted *before* the daemon starts, because the daemon
  reads that key per press and an empty value there fails a press with nothing to explain it;
- the outcome goes to `state/autostart.json` and is surfaced by `action: "status"`, which now tells
  apart the four situations that all used to read 「未在运行」: registered-then-exited,
  already-running, start-failed (with the Win32 reason), and turned off.

## 0.2.3 — 2026-11-05

**The button exists but refused every capture: `conversation.input.left` never gets `addFiles`**

0.2.2's button rendered and answered clicks with 当前输入栏不支持附件，无法放入截图 — because it
looked for an `addFiles(files, directories)` prop that this slot does not provide. The slot contract
in the shell lists exactly which props `conversation.input.left` hands out, and it is the standard
set only: `inputActions`, `useSession`, `useSessions`, `sessionId`, `useConversation`, … `addFiles`
belongs to `conversation.composer.bar`, whose owner component receives it directly; children slots
do not inherit it.

The supported path is the one the owner itself uses when a file is dropped:

1. `conversation.createDrafts(sessionId, [file])` on the **`conversation` client service** allocates a
   runtime draft — for an image, a browser-only draft whose bytes ride with the prompt (the same
   shape a pasted image has).
2. `inputActions.addAttachments(ids)` registers those ids in the current input state. It returns
   `false` while admission is mid-flight, in which case `releaseDraftAttachments` hands the drafts
   back instead of leaking files nobody owns.

So the plugin now declares `inject: ['slots', 'conversation']`, stages through that pair, and keeps
the direct `addFiles` verb as the first choice for any slot that does inject it.

Diagnosis note: three probes into the served bundle produced the whole contract, with no DevTools and
no restart — dump `Object.keys(props)` (19 standard props, no `addFiles`), then `ctx.get('<service>')`
for each candidate name (the guard answers `cannot get property "conversation" without inject`, which
is itself the proof that a declaration is what activates it).

## 0.2.2 — 2026-11-05

**0.2.1 booted fine but had no button — the other `inject` was the culprit**

Two unrelated things are both called `inject`, and 0.2.0 broke one while 0.2.1 over-corrected by
deleting the other:

- `dsh.client.inject` (manifest) names **module rows** the client loader must resolve before this
  bundle runs. Listing the type-only `@deepseek-ai/dsh-client-ui-slots` there deadlocked boot (0.2.0).
- The cordis **plugin face's** `inject` names **services** the plugin context may read. 0.2.1 left it
  empty, so `ctx.slots` threw `cannot get property "slots" without inject` on the first line of
  `apply`. Because `apply` is guarded (by design — a UI plugin must never break boot), the throw was
  swallowed and the plugin simply contributed nothing.

Fixed by declaring `inject: ['slots']` on the plugin face while keeping `dsh.client.inject` absent.
A regression test now pins both halves of the distinction, with the failure mode written down next to
the assertion.

Diagnosis note, since it cost two restarts: the throw happens inside the guarded `apply`, so nothing
reaches the console. Instrumenting the served bundle in place is enough — the client registry
hot-reloads it, so a badge drawn into the page can be read back with this plugin's own screenshot
tool, no rebuild and no restart.

## 0.2.1 — 2026-11-05

**0.2.0 could stop the Web client from starting at all — upgrade immediately if you installed it**

`package.json` declared `dsh.client.inject: ["@deepseek-ai/dsh-client-ui-slots", …]`. That package
is not a client plugin: it exists only as a TypeScript type that other bundles import for
annotations. The client loader materializes each `inject` entry by importing its bundle, so it waited
for a bundle that can never arrive and the app never finished booting. The only way back was to
disable every plugin.

- **`dsh.client.inject` is gone.** The plugin needs exactly one module at load time (`react`, which
  the shell always provides), and slot readiness is awaited through `ctx.slots.inject` — the API that
  exists for that job. A package-level dependency list that names a non-existent row is a boot-time
  deadlock, so the list stays empty.
- **The client bundle can no longer throw.** The factory body is wrapped: a missing module, a
  missing slot registry, or any error at materialization returns an inert module and logs once. A UI
  plugin must be able to lose its own button; it must never be able to prevent the app from booting.
- The host's route registration no longer requires `ctx.effect` to exist, and a failure there is
  confined to a warning.

Two regression tests pin it: the manifest must keep `dsh.client.inject` absent, and a factory whose
`require` throws must still yield a callable, no-op `apply`.

## 0.2.0 — 2026-11-05

**A camera button in the composer**

Click it and the window you are looking at is captured and staged in the input box as a normal
image attachment — the same intake path a pasted image takes, so sending, the upload queue, byte
progress and durable attachment records all behave exactly as if you had pasted it yourself.

- Registered into `conversation.input.left` (a `list`, session-scoped slot) with `order: 20`, so it
  sits beside the platform's own accessory controls.
- The browser cannot read the screen, so the button asks the host over
  `POST /api/quick-screenshot/capture` — registered on `connection.fetch`, which means it rides the
  same signed browser-session cookie as every other host route instead of inventing its own auth.
- The host reuses the existing capture stack (helper, DPI, window matching) and answers with PNG
  bytes plus `x-capture-*` metadata; a JSON `{ base64 }` envelope is also accepted, so a transport
  that refuses binary bodies degrades to a working button.
- Archive policy carries over: composer captures land in the project's `screenshots/` folder by
  default. Clipboard is off for this path (the image is already going into the draft).
- The button never refuses: an unresolvable foreground window falls back to the pointer's monitor,
  then the whole desktop.
- New settings: `composerCapture` (`active`/`monitor`/`screen`), `composerArchive`, `composerClipboard`.

**No build step**

The client bundle is hand-authored in the host's own module-loader format
(`window.__ModuleLoader__.load({ id, factory })` around CommonJS-style code, `require()` resolving
against the shell's frozen module table). No tsdown, no JSX transform, nothing that can fail at
release time — and `test/client.test.mjs` executes the real file in Node with a stubbed loader,
React, and `fetch`, so a format or wiring mistake fails the suite instead of a DSH restart.

## 0.1.3 — 2026-11-05

**A hotkey press could fail instead of taking a screenshot**

Found by pressing the real hotkey four times on a live desktop: three captures succeeded, the
second failed with `FOREGROUND_WINDOW_UNKNOWN`.

`GetForegroundWindow()` can briefly return zero — during alt-tab, a virtual-desktop switch, or while
a window is being destroyed — and the daemon treated "no resolvable foreground window" as a fatal
error. A keypress has nobody to retry it, so this was the wrong response.

- The hotkey now **falls back to the monitor the pointer is on** (and to the whole desktop when even
  that cannot be resolved), and records `fallback: "monitor" | "screen"` plus the foreground handle
  in `events.ndjson` / `latest.json`, with a note in the tray balloon.
- Reusing such a capture via `target: "latest"` says it was a fallback instead of presenting it as a
  window shot.
- New core helpers `Get-DshCursorPosition` and `Get-DshMonitorIndexAtPoint`, verified against a
  real 3-monitor layout (cursor point → monitor 2; off-screen point → -1).

The explicit `quick_screenshot` tool keeps failing loudly for `target: "active"` — an agent can
retry with `target: "screen"` — while the hotkey, which has nobody to ask, never drops a press.

## 0.1.2 — 2026-11-05

**The plugin could not be updated, and left itself uninstalled when an update failed**

- **Long-lived children no longer run with the package directory as their working directory.** On
  Windows a process whose CWD is a directory prevents that directory from being renamed, and
  installing a newer version of a plugin *is* a rename of the package folder. With the capture
  helper and the hotkey daemon both parked in `node_modules/dsh-quick-screenshot`, every update
  failed with `EPERM: rename …_tmp_… -> …dsh-quick-screenshot` — and pnpm had already removed the
  old copy, so the plugin would have been gone at the next restart. Both processes now run in
  `plugin-data/dsh-quick-screenshot/scratch` and `…/state` instead.
- Documented the failure mode in the README's troubleshooting table, because "plugin update says
  EPERM" is otherwise indistinguishable from an antivirus or permission problem.

## 0.1.1 — 2026-11-05

Fixes found by installing 0.1.0 into a real desktop DSH.

**Hotkey daemon: the actual bug**

- **A hotkey list with two or more candidates killed the daemon.** The candidate file was read as
  `@($json | ConvertFrom-Json)`, which nests the parsed array inside a second array, so the loop
  received the whole array instead of one candidate and `[int]$candidate.mods` was a cast of an
  array to `int`. With exactly one candidate the one-element array coerced silently, so a
  single-candidate test stayed green while the shipping plugin (seven fallbacks) died before
  registering anything and left no trace. The list is now flattened explicitly and every candidate
  is validated before use.
- **A host that forbids detached children no longer kills the hotkey silently.** The daemon is
  started detached first; when that fails it retries *attached* and says which mode is in force.
- **Start failures now lead with their reason.** The renderer checked "is a state file present"
  before "is there an error", so a daemon that died before writing its state produced a message
  with no code, no detail and nothing to act on.
- **The daemon owns its own log** (`daemon.log`) with startup breadcrumbs — `booting` → `core
  loaded` → `candidates parsed: <n>` → `register <combo> -> win32=<n>` → `running` — plus a `trap`
  that records a fatal error and still writes its state file. A detached child given an inherited
  stderr handle can lose its first-line errors; an unwritable log is undebuggable.
- **Start failures report exit code, signal and the log tail** instead of a bare "exited".

**Tests**

- The integration suite now starts a real daemon and asserts it registers, reports and stops, plus
  a regression case for the multi-candidate cast that only reproduces with two or more combos.

## 0.1.0 — 2026-11-05

First release.

**Tools**

- `quick_screenshot_windows` — enumerate capturable windows and monitors, with fuzzy title /
  process matching and the focused window sorted first.
- `quick_screenshot` — capture `active` / `window:<keyword>` / `monitor:<n>` / `region:x,y,w,h` /
  `screen` / `latest` and route the result to any combination of `chat`, `clipboard`, `archive`.
- `quick_screenshot_hotkey` — start / stop / status / restart a detached global-hotkey daemon.

**Capture**

- Per-monitor-v2 DPI awareness is raised before geometry is read, so captures are native pixels
  and correctly positioned on scaled displays and multi-monitor layouts.
- Window bounds come from `DWMWA_EXTENDED_FRAME_BOUNDS`, so the invisible DWM resize border is
  excluded.
- `PrintWindow(PW_RENDERFULLCONTENT)` is attempted first and blank-checked; screen copy of the
  same rectangle is the fallback. A flat frame is reported as `blank` rather than as success.
- Minimized windows fail with an actionable message instead of producing an empty file.

**Hotkey**

- Detached PowerShell daemon with a Win32 message pump; keeps working while DSH is minimized.
- Ordered fallback list: when the preferred combo is already registered by another application,
  the first combo that actually registers is used and reported.
- Writes `daemon.json`, `events.ndjson` and `latest.json`, so status and `latest` captures survive
  plugin reloads.

**Destinations**

- `chat` uses the host attachment store and returns a real image block; degrades to a text
  placeholder plus path when the host or model cannot take images.
- `clipboard` copies the frame as a bitmap.
- `archive` writes to `<workspace>/screenshots/` with a sortable timestamped name and never
  overwrites (`-2`, `-3`, …).

**Diagnostics**

- `scripts/doctor.ps1` — one-command self-check: DPI level, monitors, window list, real capture.
- 92 unit and action tests plus an integration suite that drives the real helper and daemon and
  skips (with a reason) where a sandbox forbids spawning children.
