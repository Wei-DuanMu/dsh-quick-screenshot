/**
 * Model-facing text for dsh-quick-screenshot.
 *
 * All user-visible wording lives here (the PowerShell layer stays ASCII-only and
 * returns codes), and every renderer takes the plain result object so it can be
 * tested without a desktop.
 *
 * @module dsh-quick-screenshot/render
 */

import { OFFSCREEN_MONITOR } from './windows.js'

/** Human-readable byte size. */
export function formatBytes (bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return '大小未知'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(2)} MB`
}

/**
 * Render the window list.
 *
 * @param {object} value
 */
export function renderWindowList (value) {
  const lines = []
  const monitors = value.monitors?.length ? `，共 ${value.monitors.length} 块显示器` : ''
  lines.push(`可截图窗口 ${value.matched}/${value.total} 个${monitors}。`)

  if (value.matched === 0) {
    lines.push(value.query ? `没有窗口匹配「${value.query}」。` : '当前没有可截图的窗口。')
    if (value.suggestions?.length > 0) {
      lines.push('现有窗口：')
      for (const title of value.suggestions) lines.push(`  · ${title}`)
    }
    return lines.join('\n')
  }

  for (const window of value.windows) {
    const markers = []
    if (window.active) markers.push('活动')
    if (window.minimized) markers.push('最小化')
    if (window.monitor === OFFSCREEN_MONITOR) markers.push('不在任何屏幕内')
    const suffix = markers.length > 0 ? ` [${markers.join('·')}]` : ''
    const title = String(window.title ?? '').trim() || '(无标题)'
    lines.push(`· id=${window.id} ${window.width}x${window.height} 屏#${window.monitor} ${window.process}  ${title}${suffix}`)
  }

  if (value.monitors?.length > 0) {
    const summary = value.monitors.map((monitor) => `#${monitor.index} ${monitor.width}x${monitor.height}${monitor.primary ? '(主)' : ''}`)
    lines.push(`显示器：${summary.join('，')}`)
  }
  lines.push('用 quick_screenshot 的 target 指定：active / window:<关键词> / monitor:<编号> / region:x,y,w,h / screen / latest')
  return lines.join('\n')
}

/**
 * Render one capture result.
 *
 * @param {object} value
 */
export function renderCapture (value) {
  const lines = []
  if (value.reused) {
    lines.push(`复用最近一次截图：${value.path}`)
  } else {
    lines.push(`已截图：${value.target?.description ?? value.target?.kind ?? ''}`)
  }

  const window = value.target?.window
  if (window?.title) lines.push(`窗口：「${window.title}」${window.process ? ` (${window.process})` : ''}`)

  const region = value.target?.region
  if (region) {
    lines.push(region.wholeMonitor === true
      ? `选区：单击选中的整块显示器 #${region.monitor}（${region.width}x${region.height}）`
      : `选区：${region.width}x${region.height}，位于显示器 #${region.monitor} 的 ${region.x},${region.y}`)
  }

  const method = value.method === 'print' ? 'PrintWindow' : '屏幕取样'
  const elapsed = value.elapsedMs > 0 ? `，${value.elapsedMs} ms` : ''
  lines.push(`图片：${value.width}x${value.height}，${formatBytes(value.bytes)}，${method}${elapsed}`)
  lines.push(`文件：${value.path}`)

  const delivered = []
  if (value.destinations?.chat) {
    delivered.push(value.imageAttached ? '已回传给模型' : '未回传图片（宿主无附件服务或模型不支持，已给路径）')
  }
  if (value.destinations?.clipboard) delivered.push(value.clipboardWritten ? '已复制到剪贴板' : '剪贴板写入失败')
  if (value.destinations?.archive) delivered.push(value.archived ? '已留档' : '未留档')
  if (delivered.length > 0) lines.push(`去向：${delivered.join(' · ')}`)

  if (value.blank) lines.push('⚠ 画面接近纯色，可能截到了空白或被遮挡的区域。可改用 target:"screen"，或先把目标窗口切到前台再截。')
  for (const note of value.notes ?? []) lines.push(`提示：${note}`)
  return lines.join('\n')
}

/**
 * Render the hotkey status.
 *
 * @param {object} value
 */
export function renderHotkey (value) {
  const lines = []
  if (value.running) {
    lines.push(`全局快捷键正在运行：${value.combo}（进程 ${value.pid}）`)
    if (value.fellBack) lines.push(`注意：你想要的 ${value.requested} 已被其他程序占用，已自动改用 ${value.combo}。`)
  } else if (value.error) {
    // The reason comes first. Reporting only "not running" leaves the user with
    // nothing to act on at exactly the moment they need the reason most.
    lines.push(`全局快捷键启动失败：${value.error.code}${value.error.message ? `（${value.error.message}）` : ''}`)
    if (value.error.detail) lines.push(`详情：${value.error.detail}`)
  } else if (value.present) {
    lines.push('全局快捷键未在运行。')
  } else {
    lines.push('全局快捷键尚未启动。')
  }

  // What the boot hook did. Phrased for a hotkey that is missing *now*: a
  // registration that succeeded at boot and is gone later means the daemon exited
  // with an earlier DSH process, which is a different fix from a combo conflict —
  // and "not running" alone tells the user none of this.
  const auto = value.autoStart ?? null
  if (auto && value.action !== 'stop') {
    const at = typeof auto.at === 'string' ? auto.at.replace('T', ' ').slice(0, 19) : ''
    if (auto.reason === 'start-failed') {
      lines.push(`DSH 启动时自动注册失败：${auto.code ?? ''}${auto.message ? `（${auto.message}）` : ''}${at ? `，时间 ${at}` : ''}`)
    } else if (!value.running) {
      if (auto.reason === 'disabled') lines.push('DSH 启动时没有自动注册（hotkeyAutoStart 已关闭）。')
      else if (auto.reason === 'already-running') lines.push('DSH 启动时守护进程已在运行，现在它已经不在了（随上一个 DSH 进程退出）。')
      else if (auto.started === true) lines.push(`${at ? `${at} ` : ''}DSH 启动时注册成功，但守护进程后来退出了。`)
      else if (auto.reason === 'invalid-combo') lines.push(`DSH 启动时没有自动注册：配置里的快捷键无法解析${auto.detail ? `（${auto.detail}）` : ''}。`)
    }
  }

  if (!value.running && value.tried?.length > 0) {
    const taken = value.tried.filter((entry) => entry.win32 !== 0).map((entry) => entry.combo)
    if (taken.length > 0) lines.push(`尝试过但被占用的组合：${taken.join('、')}`)
  }

  if (value.latest) {
    lines.push(`最近一次截图：${value.latest.path}（${value.latest.width}x${value.latest.height}${value.latest.blank ? '，疑似空白' : ''}）`)
  }
  if (value.recentEvents?.length > 0) {
    const failures = value.recentEvents.filter((event) => event.ok === false)
    if (failures.length > 0) {
      lines.push(`最近有 ${failures.length} 次按键截图失败，最后一次：${failures[0].code ?? ''} ${failures[0].message ?? ''}`)
    }
  }
  for (const note of value.notes ?? []) lines.push(`提示：${note}`)
  if (value.action === 'start' && value.running) {
    lines.push('现在按下该快捷键即可截图；之后可以用 target:"latest" 取到最近一张。')
  }
  if (value.action === 'stop' && !value.running) lines.push('已停止全局快捷键。')
  return lines.join('\n')
}
