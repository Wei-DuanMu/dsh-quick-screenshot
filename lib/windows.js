/**
 * Window matching for dsh-quick-screenshot.
 *
 * Pure functions over the plain objects the capture helper returns, so the
 * ranking rules — the part users actually judge the tool by — are unit-testable
 * without a desktop.
 *
 * @module dsh-quick-screenshot/windows
 */

/** A capture target that could not be understood. */
export class TargetError extends Error {
  constructor (message) {
    super(message)
    this.name = 'TargetError'
  }
}

/**
 * Monitor index reported for a window that no monitor contains.
 *
 * Windows happily creates windows parked far off every display; they are listed
 * so the user can see them, but they must not be auto-picked as a capture target.
 */
export const OFFSCREEN_MONITOR = -1

/** Lower-case, collapse whitespace: what every comparison in this module uses. */
export function normalize (value) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Split a query into words, ignoring punctuation-only noise. */
export function tokenize (query) {
  return normalize(query)
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
}

/**
 * Score how well one window matches a query.
 *
 * The ladder is deliberately coarse and ordered by confidence: an exact title
 * beats a prefix, a prefix beats a substring, and a process name only wins when
 * the title says nothing. Every match that survives scores > 0, and the caller
 * drops the zeros — so "no such window" is never silently answered with an
 * unrelated window.
 *
 * @param {object} window
 * @param {string} query
 * @returns {number}
 */
export function scoreWindow (window, query) {
  const tokens = tokenize(query)
  if (tokens.length === 0) return 0

  const title = normalize(window?.title)
  const process = normalize(window?.process)
  const whole = normalize(query)

  let score = 0
  if (title.length > 0) {
    if (title === whole) score = 1000
    else if (title.startsWith(whole)) score = 800
    else if (title.includes(whole)) score = 600
  }

  if (score === 0 && process.length > 0) {
    if (process === whole) score = 500
    else if (process.includes(whole)) score = 400
  }

  if (score === 0) {
    const titleHits = tokens.filter((token) => title.includes(token)).length
    const processHits = tokens.filter((token) => process.includes(token)).length
    if (titleHits === tokens.length) score = 300 + tokens.length * 10
    else if (titleHits > 0) score = 200 * (titleHits / tokens.length)
    else if (processHits === tokens.length) score = 150
    else if (processHits > 0) score = 100 * (processHits / tokens.length)
  }

  return score
}

/**
 * Rank windows for a query, dropping everything that does not match.
 *
 * With an empty query this is not a search but a listing: the window the user is
 * already looking at comes first, then the largest, which is the order a person
 * scans.
 *
 * @param {Array<object>} windows
 * @param {object} [options]
 * @param {string} [options.query]
 * @param {string[]} [options.excludeProcesses]
 * @param {boolean} [options.includeMinimized]
 */
export function rankWindows (windows, { query = '', excludeProcesses = [], includeMinimized = false } = {}) {
  const excluded = new Set(excludeProcesses.map((name) => normalize(name)).filter(Boolean))
  const search = tokenize(query)

  const scored = []
  for (const window of windows ?? []) {
    if (!includeMinimized && window.minimized) continue
    if (excluded.has(normalize(window.process))) continue

    const score = search.length === 0 ? 0 : scoreWindow(window, query)
    if (search.length > 0 && score <= 0) continue

    const activeBoost = window.active ? 50 : 0
    scored.push({ window, score, relevance: score + activeBoost })
  }

  scored.sort((a, b) => {
    if (b.relevance !== a.relevance) return b.relevance - a.relevance
    if (a.window.active !== b.window.active) return a.window.active ? -1 : 1
    const areaA = (a.window.width ?? 0) * (a.window.height ?? 0)
    const areaB = (b.window.width ?? 0) * (b.window.height ?? 0)
    if (areaB !== areaA) return areaB - areaA
    return String(a.window.title ?? '').localeCompare(String(b.window.title ?? ''))
  })

  return scored
}

/**
 * Pick the single best window for a query.
 *
 * Returns the runner-ups too: when four windows match, the agent should be able
 * to tell the user "captured X, three others also matched" instead of quietly
 * guessing.
 *
 * @param {Array<object>} windows
 * @param {object} [options]
 * @returns {{ best: object|null, alternatives: Array<object>, ranked: Array<object> }}
 */
export function pickWindow (windows, options = {}) {
  const ranked = rankWindows(windows, options)
  if (ranked.length === 0) return { best: null, alternatives: [], ranked }
  return {
    best: ranked[0].window,
    alternatives: ranked.slice(1, 4).map((entry) => entry.window),
    ranked,
  }
}

/** The window that currently has focus, if the host reported one. */
export function activeWindow (windows) {
  return (windows ?? []).find((window) => window.active === true) ?? null
}

/**
 * Find a window by the id the helper reported.
 *
 * Handles arrive as decimal strings because a 64-bit HWND does not survive a
 * JSON round trip as a number in every runtime; compare as strings.
 *
 * @param {Array<object>} windows
 * @param {string|number} id
 */
export function windowById (windows, id) {
  const wanted = String(id ?? '')
  if (wanted.length === 0) return null
  return (windows ?? []).find((window) => String(window.id) === wanted) ?? null
}

/**
 * Parse the `target` argument of the capture tool.
 *
 * Accepted forms, in the order a user is likely to try them:
 *   active | screen | latest | monitor:N | region:x,y,w,h | window:<text> | <text>
 *
 * A bare word is treated as a window search rather than an error, because
 * "screenshot Edge" is what people type and refusing it would be pedantic.
 *
 * @param {string} [value]
 * @returns {object} a discriminated target description
 * @throws {TargetError}
 */
export function parseCaptureTarget (value) {
  const text = String(value ?? '').trim()
  if (text.length === 0) return { kind: 'active', description: '当前活动窗口' }

  const lower = text.toLowerCase()

  if (lower === 'active' || lower === 'foreground') return { kind: 'active', description: '当前活动窗口' }
  if (lower === 'screen' || lower === 'all' || lower === 'desktop') return { kind: 'screen', description: '整个虚拟桌面（所有显示器）' }
  if (lower === 'latest' || lower === 'last') return { kind: 'latest', description: '最近一次快捷键截图' }

  const monitor = /^monitor\s*[:#]?\s*(\d+)$/i.exec(text)
  if (monitor) {
    const index = Number(monitor[1])
    return { kind: 'monitor', index, description: `显示器 #${index}` }
  }

  const region = /^region\s*[:#]?\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)$/i.exec(text)
  if (region) {
    const [x, y, width, height] = region.slice(1).map(Number)
    if (width < 1 || height < 1) throw new TargetError(`区域尺寸必须为正数：收到 ${width}x${height}`)
    return { kind: 'region', rect: { x, y, width, height }, description: `区域 ${width}x${height} @ ${x},${y}` }
  }

  const windowPrefix = /^window\s*[:#]\s*(.+)$/i.exec(text)
  if (windowPrefix) {
    const query = windowPrefix[1].trim()
    if (query.length === 0) throw new TargetError('window: 后面需要窗口关键词')
    return { kind: 'window', query, description: `窗口「${query}」` }
  }

  // An explicit prefix with nothing after it is an unfinished command, not a
  // window whose title happens to be "window:".
  if (/^window\s*[:#]?\s*$/i.test(text)) {
    throw new TargetError('window: 后面需要窗口关键词，例如 window:Edge 或 window:微信')
  }

  if (lower.startsWith('region') || lower.startsWith('monitor')) {
    throw new TargetError(`无法解析目标「${text}」。region 需要 x,y,w,h 四个数，monitor 需要一个编号，例如 region:0,0,800,600 或 monitor:1`)
  }

  return { kind: 'window', query: text, description: `窗口「${text}」` }
}

/** One-line description used in tool output and file names. */
export function describeWindow (window) {
  if (!window) return '未知窗口'
  const title = String(window.title ?? '').trim()
  const process = String(window.process ?? '').trim()
  const size = `${window.width ?? '?'}x${window.height ?? '?'}`
  const parts = []
  if (title.length > 0) parts.push(`「${title}」`)
  if (process.length > 0 && process !== 'unknown') parts.push(`(${process})`)
  parts.push(size)
  if (window.minimized) parts.push('已最小化')
  if (window.monitor !== undefined && window.monitor >= 0) parts.push(`显示器#${window.monitor}`)
  return parts.join(' ')
}
