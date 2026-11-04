/**
 * The three operations behind the plugin's tools, expressed against explicit
 * dependencies (a capture helper, a config directory, a state directory).
 *
 * They live here rather than inside `apply()` so they can be unit-tested with a
 * fake helper: the interesting failures — a minimized window, a taken hotkey, a
 * host without an attachment store — are all in this file, and none of them need
 * a real desktop to reproduce.
 *
 * @module dsh-quick-screenshot/actions
 */

import { existsSync } from 'node:fs'
import { readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'

import { DEFAULT_COMBO, candidateCombos, parseCombo } from './combo.js'
import { loadConfig, updateConfig } from './config.js'
import { HelperError, ensureDirectory, isSupportedPlatform } from './helper-client.js'
import { hotkeyStatus, readLatest, startDaemon, stopDaemon } from './hotkey.js'
import {
  resolveArchiveDir,
  screenshotFileName,
  uniquePath,
} from './paths.js'
import {
  OFFSCREEN_MONITOR,
  TargetError,
  activeWindow,
  describeWindow,
  parseCaptureTarget,
  pickWindow,
  rankWindows,
} from './windows.js'

/** Capture destinations, in report order. */
export const DESTINATIONS = ['chat', 'clipboard', 'archive']

/** A tool call keeps a record and lets the model see it. */
export const DEFAULT_DESTINATIONS = ['archive', 'chat']

/** A hotkey press is not a conversation turn, so it copies and archives. */
export const DEFAULT_HOTKEY_DESTINATIONS = ['clipboard', 'archive']

/**
 * Resolve a DSH service without assuming the host mounts it.
 *
 * @param {object} ctx
 * @param {string} serviceName
 */
export function service (ctx, serviceName) {
  try {
    if (typeof ctx?.get === 'function') return ctx.get(serviceName)
  } catch {
    // Falls through to the property form below.
  }
  return ctx?.[serviceName]
}

/** The session working directory, used to place the archive folder. */
export function sessionCwd (exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
}

/**
 * Parse the `destinations` argument.
 *
 * A comma-separated string rather than an array keeps the tool schema to scalar
 * types; `all` and `none` cover the two cases people actually mean.
 *
 * @param {string|undefined} value
 * @param {string[]} [fallback]
 * @returns {string[]}
 * @throws {TargetError}
 */
export function parseDestinations (value, fallback = DEFAULT_DESTINATIONS) {
  if (value === undefined || value === null || String(value).trim().length === 0) return [...fallback]
  const text = String(value).trim().toLowerCase()
  if (text === 'all' || text === '*') return [...DESTINATIONS]
  if (text === 'none') return []

  const names = text.split(/[\s,|]+/).filter(Boolean)
  const chosen = []
  for (const entry of names) {
    const alias = entry === 'model' || entry === 'input' || entry === 'vision'
      ? 'chat'
      : entry === 'copy' || entry === 'paste'
        ? 'clipboard'
        : entry === 'save' || entry === 'file'
          ? 'archive'
          : entry
    if (!DESTINATIONS.includes(alias)) {
      throw new TargetError(`未知的截图去向「${entry}」；可用：chat（回传给模型）、clipboard（剪贴板）、archive（存进项目截图文件夹），或 all / none`)
    }
    if (!chosen.includes(alias)) chosen.push(alias)
  }
  return chosen
}

/**
 * Resolve a parsed target into helper geometry, or a reuse record.
 *
 * @param {object} options
 * @param {object} options.target parsed target
 * @param {Array<object>} options.windows enumerable windows
 * @param {object|null} options.latest latest hotkey capture pointer
 * @param {object} options.helper anything with `request(cmd, args)`
 * @param {string|number|null} [options.activeId] foreground handle from the host
 */
export async function resolveTarget ({ target, windows, latest, helper, activeId }) {
  switch (target.kind) {
    case 'screen':
      return { request: { kind: 'screen' }, window: null }

    case 'monitor':
      return { request: { kind: 'monitor', index: target.index }, window: null }

    case 'region':
      return { request: { kind: 'region', ...target.rect }, window: null }

    case 'active': {
      const focused = activeWindow(windows)
      if (focused) {
        return {
          request: {
            kind: 'window',
            handle: Number(focused.id),
            x: focused.x,
            y: focused.y,
            width: focused.width,
            height: focused.height,
            minimized: focused.minimized === true,
          },
          window: focused,
        }
      }
      // An untitled window (a splash screen, a game) has no enumerable record but
      // still has geometry — ask for it instead of failing.
      const handle = activeId === undefined || activeId === null ? '' : String(activeId)
      if (handle.length > 0 && handle !== '0') {
        const geometry = await helper.request('window_geometry', { handle }).catch(() => null)
        if (geometry) {
          return {
            request: {
              kind: 'window',
              handle: Number(geometry.id),
              x: geometry.x,
              y: geometry.y,
              width: geometry.width,
              height: geometry.height,
              minimized: geometry.minimized === true,
            },
            window: null,
          }
        }
      }
      throw new TargetError('拿不到当前活动窗口。可以改用 target:"screen" 截整个桌面，或用 quick_screenshot_windows 先看有哪些窗口。')
    }

    case 'window': {
      const { best, alternatives } = pickWindow(windows, { query: target.query })
      if (!best) {
        const titles = windows.slice(0, 8).map((window) => String(window.title ?? '').trim()).filter(Boolean)
        throw new TargetError(
          `没有窗口匹配「${target.query}」。${titles.length > 0 ? `现有窗口：${titles.join(' / ')}。` : ''}也可以先用 quick_screenshot_windows 查看。`,
        )
      }
      return {
        request: {
          kind: 'window',
          handle: Number(best.id),
          x: best.x,
          y: best.y,
          width: best.width,
          height: best.height,
          minimized: best.minimized === true,
        },
        window: best,
        alternatives,
      }
    }

    case 'latest': {
      if (!latest?.path) {
        throw new TargetError('还没有任何快捷键截图。可以先启动快捷键（quick_screenshot_hotkey start），或直接用普通截图。')
      }
      return { reuse: latest, window: null }
    }

    default:
      throw new TargetError(`无法识别的截图目标：${target.kind}`)
  }
}

/**
 * Attach a capture to the conversation through the host attachment store.
 *
 * Returns the durable reference the renderer turns into an image block, or null
 * when the host has no attachment service — the text result still carries the
 * path, so the capture is never lost.
 *
 * @param {object} options
 * @param {object} options.ctx
 * @param {string} options.filePath
 */
export async function attachImage ({ ctx, filePath }) {
  const attachments = service(ctx, 'attachments')
  if (!attachments || typeof attachments.saveImages !== 'function') return null

  const bytes = await readFile(filePath)
  const lower = filePath.toLowerCase()
  const mediaType = lower.endsWith('.jpg') || lower.endsWith('.jpeg') ? 'image/jpeg' : 'image/png'
  const refs = await attachments.saveImages([
    { data: new Uint8Array(bytes), mediaType, name: path.basename(filePath) },
  ])
  return Array.isArray(refs) ? refs[0] ?? null : refs ?? null
}

/**
 * Turn a helper failure into something a user can act on.
 *
 * @param {Error} error
 */
export function explainCaptureFailure (error) {
  const code = error?.code ?? ''
  const messages = {
    WINDOW_MINIMIZED_UNCAPTURABLE: '目标窗口已最小化，没有可以取样的屏幕像素。请先还原窗口，或改用 target:"monitor" / target:"screen"。',
    WINDOW_MINIMIZED_BLANK: '目标窗口已最小化，截出来是空白。请先还原窗口再截。',
    PRINTWINDOW_FAILED: '这个窗口拒绝被直接渲染（受保护的窗口），请改用 target:"screen"，或先让它显示在前台。',
    WINDOW_NOT_FOUND: '那个窗口已经关闭或不再可截。先用 quick_screenshot_windows 重新看一下。',
    MONITOR_NOT_FOUND: '没有这个编号的显示器，先用 quick_screenshot_windows 看显示器编号。',
    CAPTURE_FAILED: '没有取到任何画面，请确认屏幕没有锁定、远程桌面未断开。',
    FOREGROUND_WINDOW_UNKNOWN: '拿不到当前前台窗口，请改用 target:"screen"。',
    UNSUPPORTED_PLATFORM: '截图功能只支持 Windows。',
  }
  if (messages[code]) return messages[code]
  return error?.message ?? String(error)
}

/**
 * List capturable windows.
 *
 * @param {object} options
 * @param {object} options.args tool arguments
 * @param {object} options.helper capture helper
 * @param {string} options.dataDir plugin data directory
 */
export async function listWindows ({ args = {}, helper, dataDir }) {
  const { config } = await loadConfig(dataDir)
  const includeMinimized = args.include_minimized === true
  const data = await helper.request('list_windows', { includeMinimized })
  const windows = Array.isArray(data.windows) ? data.windows : []
  const ranked = rankWindows(windows, {
    query: args.query ?? '',
    excludeProcesses: config.excludeProcesses,
    includeMinimized,
  })
  const screens = await helper.request('screens').catch(() => ({ monitors: [] }))

  const rows = ranked.map(({ window }) => ({
    id: String(window.id),
    title: window.title ?? '',
    process: window.process ?? '',
    width: window.width,
    height: window.height,
    x: window.x,
    y: window.y,
    monitor: window.monitor ?? OFFSCREEN_MONITOR,
    minimized: window.minimized === true,
    active: window.active === true,
  }))

  // When a query matches nothing, hand back a few real titles so the model can
  // correct the query instead of asking the user what exists.
  const suggestions = rows.length === 0
    ? windows.filter((window) => !window.minimized).slice(0, 8).map((window) => describeWindow(window))
    : []

  return {
    query: args.query ?? '',
    total: windows.length,
    matched: rows.length,
    activeId: data.activeId ?? null,
    monitors: screens.monitors ?? [],
    windows: rows,
    suggestions,
  }
}

/**
 * Capture, then route the result to the requested destinations.
 *
 * @param {object} options
 * @param {object} options.args tool arguments
 * @param {object} options.exec tool execution context
 * @param {object} options.ctx plugin context (for the attachment service)
 * @param {object} options.helper capture helper
 * @param {string} options.dataDir
 * @param {string} options.stateDirectory
 * @param {(level: string, message: string) => void} [options.log]
 */
export async function capture ({ args = {}, exec, ctx, helper, dataDir, stateDirectory, log = () => {} }) {
  if (!isSupportedPlatform()) throw new HelperError('截图功能只支持 Windows。', 'UNSUPPORTED_PLATFORM')

  const { config } = await loadConfig(dataDir)
  const destinations = parseDestinations(args.destinations)
  const target = parseCaptureTarget(args.target)

  const data = await helper.request('list_windows', { includeMinimized: true })
  const windows = Array.isArray(data.windows) ? data.windows : []
  const latest = target.kind === 'latest' ? await readLatest(stateDirectory) : null

  const resolved = await resolveTarget({ target, windows, latest, helper, activeId: data.activeId })

  // ---- reuse path: `latest` is not a new capture -------------------------
  if (resolved.reuse) {
    const previous = resolved.reuse
    const info = await stat(previous.path).catch(() => null)
    if (!info) {
      throw new TargetError(`最近一次截图文件已经不在了：${previous.path}。可以重新截一张。`)
    }

    let clipboardWritten = false
    if (destinations.includes('clipboard')) {
      const result = await helper.request('clipboard_from_file', { path: previous.path }).catch(() => null)
      clipboardWritten = result?.written === true
    }

    let image = null
    if (destinations.includes('chat')) {
      image = await attachImage({ ctx, filePath: previous.path }).catch((error) => {
        log('warn', `attachment failed: ${error.message}`)
        return null
      })
    }

    const reuseNotes = []
    if (previous.fallback) {
      // A hotkey press that could not resolve the foreground window falls back to
      // the pointer's monitor; say so rather than presenting it as a window shot.
      reuseNotes.push(`这张是快捷键的兜底截图：按下时前台窗口无法确定，改截了 ${previous.fallback === 'monitor' ? '鼠标所在显示器' : '整个桌面'}。`)
    }
    if (previous.blank === true) reuseNotes.push('这张画面接近纯色，可能截到了空白区域。')

    return {
      ok: true,
      reused: true,
      path: previous.path,
      bytes: info.size,
      width: previous.width,
      height: previous.height,
      method: previous.method ?? 'screen',
      blank: previous.blank === true,
      elapsedMs: 0,
      target: { kind: 'latest', description: '最近一次快捷键截图', window: previous.window ?? null },
      destinations: {
        chat: destinations.includes('chat'),
        clipboard: destinations.includes('clipboard'),
        archive: false,
      },
      clipboardWritten,
      archived: false,
      imageAttached: image !== null,
      image,
      notes: reuseNotes,
    }
  }

  // ---- resolve where the file goes --------------------------------------
  const archiveDir = resolveArchiveDir({ configured: config.archiveDir, cwd: sessionCwd(exec) })
  const label = resolved.window?.title || resolved.request.kind
  const fileName = screenshotFileName({ label, format: config.format })

  const explicitSavePath = typeof args.save_path === 'string' && args.save_path.trim().length > 0
    ? path.resolve(args.save_path.trim())
    : null

  let outputPath
  let temporary = false
  if (explicitSavePath) {
    outputPath = explicitSavePath
    await ensureDirectory(path.dirname(outputPath))
  } else if (destinations.includes('archive')) {
    await ensureDirectory(archiveDir)
    outputPath = uniquePath(path.join(archiveDir, fileName), (candidate) => existsSync(candidate))
  } else {
    // The helper must write a file even when nobody asked for one, so use a
    // scratch path and clean it up once the bytes are in the conversation.
    const scratch = path.join(stateDirectory, 'tmp')
    await ensureDirectory(scratch)
    outputPath = path.join(scratch, fileName)
    temporary = true
  }

  // ---- capture -----------------------------------------------------------
  const wantsClipboard = destinations.includes('clipboard')
  const captureResult = await helper.request('capture', {
    target: resolved.request,
    path: outputPath,
    format: config.format,
    jpegQuality: config.jpegQuality,
    maxWidth: config.maxWidth,
    clipboard: wantsClipboard,
  }).catch((error) => {
    throw new HelperError(explainCaptureFailure(error), error?.code ?? 'CAPTURE_FAILED')
  })

  const result = captureResult.capture ?? {}
  const finalPath = result.path ?? outputPath
  const info = await stat(finalPath).catch(() => null)

  // ---- deliver -----------------------------------------------------------
  let image = null
  if (destinations.includes('chat')) {
    image = await attachImage({ ctx, filePath: finalPath }).catch((error) => {
      log('warn', `attachment failed: ${error.message}`)
      return null
    })
  }

  if (temporary && !destinations.includes('chat')) {
    await rm(finalPath, { force: true }).catch(() => {})
  }

  const notes = []
  if (resolved.alternatives?.length > 0) {
    notes.push(`还有 ${resolved.alternatives.length} 个窗口也匹配，已按相关度选中最高的那个：${resolved.alternatives.map((window) => `「${window.title}」`).join('、')}`)
  }
  if (wantsClipboard && result.clipboardWritten !== true) {
    notes.push('剪贴板被其他程序占用，未能复制；图片文件本身是好的。')
  }
  if (destinations.includes('chat') && image === null) {
    notes.push('没有把图片作为图片输入回传（宿主未提供附件服务，或当前模型不接受图片）；路径可用。')
  }
  if (temporary) notes.push(`未选择 archive 去向，图片只保留在本次会话：${finalPath}`)

  const blank = result.blank === true
  return {
    ok: true,
    reused: false,
    path: finalPath,
    bytes: info?.size ?? 0,
    width: result.width ?? 0,
    height: result.height ?? 0,
    method: result.method ?? 'screen',
    blank,
    elapsedMs: result.elapsedMs ?? 0,
    target: {
      kind: resolved.request.kind,
      description: targetDescription(target, resolved.window),
      window: resolved.window
        ? { id: String(resolved.window.id), title: resolved.window.title ?? '', process: resolved.window.process ?? '' }
        : null,
    },
    destinations: {
      chat: destinations.includes('chat'),
      clipboard: wantsClipboard,
      archive: !temporary,
    },
    clipboardWritten: result.clipboardWritten === true,
    archived: !temporary,
    imageAttached: image !== null,
    image,
    notes,
  }
}

/**
 * Describe the resolved target the way a person would recognise it.
 *
 * @param {object} target
 * @param {object|null} window
 */
export function targetDescription (target, window) {
  if (window) return describeWindow(window)
  return target.description ?? target.kind
}

/**
 * Start, stop, restart or report the global hotkey daemon.
 *
 * @param {object} options
 * @param {object} options.args tool arguments
 * @param {object} options.exec tool execution context
 * @param {string} options.dataDir
 * @param {string} options.stateDirectory
 * @param {string} options.pluginRoot
 * @param {object} [options.deps] injectable daemon/status functions (tests)
 */
export async function hotkeyControl ({
  args = {},
  exec,
  dataDir,
  stateDirectory,
  pluginRoot,
  deps = {},
}) {
  const daemon = {
    start: deps.startDaemon ?? startDaemon,
    stop: deps.stopDaemon ?? stopDaemon,
    status: deps.hotkeyStatus ?? hotkeyStatus,
    latest: deps.readLatest ?? readLatest,
  }

  if (!isSupportedPlatform()) throw new HelperError('全局快捷键只支持 Windows。', 'UNSUPPORTED_PLATFORM')

  const { config } = await loadConfig(dataDir)
  const action = String(args.action ?? 'status').trim().toLowerCase()

  if (action === 'status') {
    const status = await daemon.status({ stateDir: stateDirectory, configuredCombo: config.hotkey })
    return { action: 'status', ...status }
  }

  if (!['start', 'stop', 'restart'].includes(action)) {
    throw new TargetError(`未知的 action「${action}」；可用 start / stop / status / restart。`)
  }

  if (action === 'stop' || action === 'restart') {
    const stopped = await daemon.stop(stateDirectory)
    if (action === 'stop') {
      return {
        action: 'stop',
        running: false,
        present: stopped.stopped,
        pid: stopped.pid,
        reason: stopped.reason ?? null,
        requested: config.hotkey,
        combo: null,
        fellBack: false,
        tried: [],
        latest: await daemon.latest(stateDirectory),
        recentEvents: [],
        notes: stopped.reason === 'still-alive' ? ['守护进程没有在 4 秒内退出，可能仍然占用着快捷键；稍后再试一次 stop。'] : [],
      }
    }
  }

  // Validate before writing settings: a typo must not leave config in a state the
  // daemon cannot honour.
  let parsedPreferred
  try {
    const requested = typeof args.combo === 'string' && args.combo.trim().length > 0 ? args.combo : config.hotkey ?? DEFAULT_COMBO
    parsedPreferred = parseCombo(requested)
  } catch (error) {
    throw new TargetError(`${error.message}。例如：Ctrl+Shift+A`)
  }

  const requestedCapture = String(args.capture ?? '').toLowerCase()
  const captureMode = ['active', 'monitor', 'screen'].includes(requestedCapture) ? requestedCapture : config.hotkeyCapture

  const effectiveArchive = resolveArchiveDir({
    configured: typeof args.archive_dir === 'string' && args.archive_dir.trim().length > 0
      ? args.archive_dir.trim()
      : config.archiveDir,
    cwd: sessionCwd(exec),
  })
  await ensureDirectory(effectiveArchive)

  // Persisted before starting: the daemon re-reads this file on every press, so
  // this is also how a later capture-mode or archive change takes effect.
  const { config: saved, warning } = await updateConfig(dataDir, {
    hotkey: parsedPreferred.combo,
    hotkeyCapture: captureMode,
    archiveDir: effectiveArchive,
  })

  const started = await daemon.start({
    root: pluginRoot,
    stateDir: stateDirectory,
    configPath: path.join(dataDir, 'config.json'),
    combos: candidateCombos(parsedPreferred.combo),
    requested: parsedPreferred.combo,
  })

  const status = await daemon.status({ stateDir: stateDirectory, configuredCombo: saved.hotkey })
  const notes = []
  if (warning) notes.push(warning)
  notes.push(`快捷键截图会存到：${effectiveArchive}`)
  if (!started.ok) {
    notes.push('没有注册成功。换一个 combo（例如 Ctrl+Shift+A）再试，或先关掉占用该组合的程序。')
  } else if (started.detached === false) {
    // Degraded but working: say so instead of letting the user discover later that
    // the hotkey disappeared when they closed DSH.
    for (const note of started.notes ?? []) notes.push(note)
  }

  return {
    action,
    running: started.ok === true,
    present: status.present,
    pid: started.ok ? started.pid : status.pid,
    combo: started.ok ? started.combo : status.combo,
    requested: parsedPreferred.combo,
    fellBack: started.ok ? started.fellBack === true : status.fellBack,
    detached: started.ok ? started.detached : null,
    tried: started.tried ?? status.tried ?? [],
    error: started.ok ? null : { code: started.code, message: started.message, detail: started.detail },
    latest: status.latest,
    recentEvents: status.recentEvents,
    notes,
  }
}
