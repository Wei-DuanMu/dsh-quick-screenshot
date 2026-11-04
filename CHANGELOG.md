# Changelog

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
