/**
 * dsh-quick-screenshot — window-aware screenshots for DeepSeek Harness.
 *
 * This file is deliberately thin: it declares the three model-facing tools
 * (names, descriptions, parameter schemas, renderers) and delegates to
 * `lib/actions.js`. Everything that can fail interestingly lives there, where it
 * is unit-tested with a fake helper instead of needing a real desktop.
 *
 * Design decisions worth knowing before changing anything:
 *
 * - The capture work is done by PowerShell (`host/*.ps1`), not a native addon: no
 *   compiler is needed on the user's machine, and DPI awareness, DWM frame bounds
 *   and the PrintWindow fallback are all reachable from .NET.
 * - The helper is one long-lived child (cold start ~1 s, warm capture tens of ms),
 *   so its lifetime is managed explicitly and every request has a deadline.
 * - The hotkey daemon is detached and file-driven, because a hotkey must fire
 *   while DSH is unfocused and must survive a plugin reload.
 * - Capture destinations are independent and combinable, which is what was asked
 *   for: return it to the model, put it on the clipboard, archive it in the
 *   project.
 *
 * @module dsh-quick-screenshot
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineTool } from '@deepseek-ai/dsh-tools'

import { capture, createComposerCaptureHandler, hotkeyControl, listWindows, service } from './actions.js'
import { HelperClient } from './helper-client.js'
import { pluginDataDir, stateDir as resolveStateDir } from './paths.js'
import { renderCapture, renderHotkey, renderWindowList } from './render.js'

/** Stable plugin id; also the plugin-data folder name. */
export const name = 'dsh-quick-screenshot'

/** `tools` is the only hard requirement; attachments is used when the host mounts it. */
export const inject = ['tools']

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Authenticated route the composer button posts to.
 *
 * Under `/api/` like every other browser-facing host route, so it rides the same
 * signed-cookie browser session the client already holds.
 */
export const COMPOSER_CAPTURE_PATH = '/api/quick-screenshot/capture'

/**
 * Best-effort session workspace lookup for the capture route.
 *
 * The archive belongs in the project folder, but a bare HTTP request carries no
 * agent, so the client sends its session id and this resolves the workspace
 * through whichever agent service the host exposes. Every step is guarded: a host
 * without that service falls back to the configured archive directory, and the
 * capture still works.
 *
 * @param {object} ctx plugin context
 * @param {string|null} sessionId
 * @returns {string|undefined}
 */
export function resolveSessionCwd (ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
  const agents = service(ctx, 'agents')
  if (!agents) return undefined
  for (const method of ['get', 'resolve', 'byId']) {
    if (typeof agents[method] !== 'function') continue
    try {
      const agent = agents[method](sessionId)
      const cwd = agent?.session?.header?.cwd
      if (typeof cwd === 'string' && cwd.length > 0) return cwd
    } catch {
      // Try the next accessor; none of them is a documented contract here.
    }
  }
  return undefined
}

/**
 * Register the plugin's tools.
 *
 * @param {object} ctx cordis context with the tools registry
 */
export function apply (ctx) {
  const log = (level, message) => {
    try {
      const logger = ctx?.logger
      if (logger && typeof logger[level] === 'function') logger[level](message)
    } catch {
      // Logging must never break a capture.
    }
  }

  const dataDir = pluginDataDir()
  const stateDirectory = resolveStateDir()
  // The helper runs in a scratch dir inside the plugin's own data folder, never in
  // the package directory: a process parked in the package prevents Windows from
  // renaming it, which would make the plugin impossible to update.
  const helper = new HelperClient({ root: PLUGIN_ROOT, workDir: path.join(dataDir, 'scratch'), log })

  ctx.tools.register(defineTool({
    name: 'quick_screenshot_windows',
    description:
      '列举 Windows 上当前可截图的窗口（自动识别活动窗口），回答"能截哪些窗口"或为截图挑选目标。'
      + '返回每个窗口的 id、标题、进程、尺寸、所在显示器，活动窗口排在最前，并附带显示器列表。'
      + 'query 可按窗口标题或进程名模糊匹配（中英文都行）。'
      + '如果只是想"把现在这个窗口截下来"，不必先调用它——quick_screenshot 的 target:"active" 就够了。',
    parameters: {
      query: {
        type: 'string',
        description: '可选关键词，按窗口标题或进程名模糊匹配，例如 "Edge"、"微信"、"bilibili"。多个词用空格分隔时要求都出现在标题里。',
      },
      include_minimized: {
        type: 'boolean',
        description: '是否包含已最小化的窗口（默认 false）。最小化窗口只能靠 PrintWindow 截取，经常拿到空白图。',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderWindowList(value) }],
    },
    timeoutMs: 30_000,
    execute: async (args) => await listWindows({ args, helper, dataDir }),
  }))

  ctx.tools.register(defineTool({
    name: 'quick_screenshot',
    description:
      '截图，并按需同时做三件事：回传给模型（chat）、复制到剪贴板（clipboard）、存进项目的 screenshots 文件夹留档（archive）。'
      + '用户说"截个图"、"把当前窗口截下来"、"把刚才那张图给我"时使用。'
      + 'target 默认 active（当前活动窗口，也就是用户正在看的那个）；也可用 window:<关键词>、monitor:<编号>、region:x,y,w,h、screen、latest（最近一次快捷键截图）。'
      + '先用 quick_screenshot_windows 可以看到有哪些窗口和显示器编号。'
      + '失败会返回具体原因（窗口已最小化／受保护／不存在），不会拿一张全黑图充数；连续截取同一窗口会得到 -2、-3 这样的文件后缀，不会互相覆盖。',
    parameters: {
      target: {
        type: 'string',
        description: '截图目标：active（默认，当前活动窗口）、window:<关键词>、monitor:<编号>、region:x,y,w,h、screen（整个虚拟桌面）、latest（最近一次快捷键截图）。只写一个词会被当作窗口关键词。',
      },
      destinations: {
        type: 'string',
        description: '截图去向，逗号分隔，或写 all / none。chat=回传给模型（需要支持图片输入的模型）、clipboard=复制到剪贴板、archive=存入项目 screenshots 文件夹。默认 "archive,chat"。',
      },
      save_path: {
        type: 'string',
        description: '可选，指定保存到某个绝对路径（目录会自动创建）。不填则按 archive 去向放到项目截图文件夹。',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const blocks = [{ type: 'text', text: renderCapture(value) }]
        // The image block is only present when the host attachment store accepted
        // the bytes; a text-only model receives it as a placeholder by the host.
        if (value.image) blocks.push({ type: 'image', attachment: value.image })
        return blocks
      },
    },
    timeoutMs: 60_000,
    execute: async (args, exec) => await capture({ args, exec, ctx, helper, dataDir, stateDirectory, log }),
  }))

  ctx.tools.register(defineTool({
    name: 'quick_screenshot_hotkey',
    description:
      '管理全局截图快捷键（默认 Ctrl+Alt+A）。启动后，无论 DSH 是否在前台，按一下就会截取当前窗口、存进项目截图文件夹并复制到剪贴板；之后可用 quick_screenshot 的 target:"latest" 取到那张图。'
      + 'action：start 启动、stop 停止、status 查看状态与最近一次截图（默认）、restart 重启。'
      + '所选组合被其他程序占用时会自动改用下一个可用组合并在结果里说明；想指定别的组合用 combo，例如 Ctrl+Shift+A。同一组合反复失败时不要重复重试，换一个组合即可。',
    parameters: {
      action: {
        type: 'string',
        description: 'start / stop / status / restart。默认 status。',
      },
      combo: {
        type: 'string',
        description: '自定义组合键，例如 "Ctrl+Shift+A"、"Ctrl+Alt+S"、"Ctrl+Shift+F9"。必须至少包含一个修饰键（Ctrl/Alt/Shift/Win）。',
      },
      capture: {
        type: 'string',
        description: '按下快捷键时的行为：active（默认，截当前窗口）、monitor（截当前窗口所在显示器）、screen（截整个虚拟桌面）。',
      },
      archive_dir: {
        type: 'string',
        description: '快捷键截图的存放目录（绝对路径）。不填则使用当前项目下的 screenshots 文件夹。',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderHotkey(value) }],
    },
    timeoutMs: 90_000,
    execute: async (args, exec) => await hotkeyControl({
      args,
      exec,
      dataDir,
      stateDirectory,
      pluginRoot: PLUGIN_ROOT,
    }),
  }))

  // ---- browser capture route (composer button) ---------------------------
  //
  // The button lives in the Web client and cannot touch the screen, so it asks
  // the host for one frame. `connection.fetch` is the authenticated, same-origin
  // registry the client's `fetch` already talks to (it carries the signed browser
  // cookie), so this route needs no auth of its own — but it is registered only
  // when a Web carrier is actually mounted, and the desktop/headless hosts simply
  // skip it while the three tools keep working.
  const connection = service(ctx, 'connection')
  const registerFetch = connection?.fetch?.register
  if (typeof registerFetch === 'function') {
    const handler = createComposerCaptureHandler({ helper, dataDir, stateDirectory, log })
    const registerRoute = () => registerFetch.call(connection.fetch, {
      path: COMPOSER_CAPTURE_PATH,
      methods: ['POST'],
      fetch: (request) => {
        let sessionId = null
        try {
          sessionId = new URL(request.url, 'http://localhost').searchParams.get('sessionId')
        } catch {
          sessionId = null
        }
        return handler(request, { cwd: resolveSessionCwd(ctx, sessionId) })
      },
    })
    try {
      // `effect` is how a cordis plugin owns a disposer; on a host without it the
      // route is still registered, just not torn down individually.
      if (typeof ctx.effect === 'function') ctx.effect(registerRoute, 'dsh-quick-screenshot: composer capture route')
      else registerRoute()
      log('info', `composer capture route registered at ${COMPOSER_CAPTURE_PATH}`)
    } catch (error) {
      // A route collision must not take the tools down with it.
      log('warn', `composer capture route unavailable: ${error?.message ?? String(error)}`)
    }
  }

  // One helper process for the plugin's lifetime; stop it when the plugin unloads.
  const dispose = () => {
    helper.dispose().catch(() => {})
  }
  try {
    if (typeof ctx.effect === 'function') ctx.effect(() => dispose)
    else if (typeof ctx.on === 'function') ctx.on('dispose', dispose)
  } catch {
    // A host without lifecycle hooks still works; the child exits with the host.
  }

  log('info', `dsh-quick-screenshot ready (root=${PLUGIN_ROOT}, data=${dataDir})`)
}
