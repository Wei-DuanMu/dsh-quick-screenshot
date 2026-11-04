/**
 * Persisted settings for dsh-quick-screenshot.
 *
 * The plugin deliberately does not declare a DSH `Config` schema: these settings
 * must be changeable from a tool call while DSH is running (which hotkey to fall
 * back to, where archives go), and a loader-level config schema is read at mount
 * time and cannot be written back. One small JSON file, owned by the plugin,
 * keeps the hotkey daemon and the agent in sync.
 *
 * @module dsh-quick-screenshot/config
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { DEFAULT_COMBO } from './combo.js'

/**
 * Defaults, and the full list of keys the plugin accepts.
 *
 * `null` means "not configured", which is different from a falsy value: an empty
 * `archiveDir` must fall back to the session workspace, while `false` for
 * `clipboard` must actually disable the clipboard.
 */
export const DEFAULT_CONFIG = Object.freeze({
  /** Preferred global hotkey; the daemon falls back when it is taken. */
  hotkey: DEFAULT_COMBO,
  /**
   * What a hotkey press captures: the focused window, the monitor holding it, the
   * whole desktop, or a region the user drags out.
   *
   * `region` is the only mode that asks before capturing, which is why it is
   * offered for the hotkey but not for the composer button: a hotkey press is
   * naturally followed by the user's own drag, while a single button click should
   * produce the file immediately.
   */
  hotkeyCapture: 'active',
  /** Archive directory; null follows the session workspace. */
  archiveDir: null,
  /** Copy every capture to the clipboard. */
  clipboard: true,
  /** png | jpeg */
  format: 'png',
  /** JPEG quality, 1-100. */
  jpegQuality: 90,
  /** Downscale wider captures to this width; 0 keeps native pixels. */
  maxWidth: 0,
  /**
   * Re-register the global hotkey every time DSH starts.
   *
   * On by default: this host cannot create a detached process, so the daemon lives
   * exactly as long as DSH does. Without this the hotkey would silently stop
   * working after every restart and the user would have to call the tool by hand.
   */
  hotkeyAutoStart: true,
  /** Show a tray balloon on each hotkey capture. */
  showBalloon: true,
  /** Processes never offered as capture targets. */
  excludeProcesses: [],
  /** What the composer button captures: active | monitor | screen. */
  composerCapture: 'active',
  /** Archive composer-button captures into the project folder too. */
  composerArchive: true,
  /** Also copy composer-button captures to the clipboard (usually redundant). */
  composerClipboard: false,
})

const CAPTURE_MODES = new Set(['active', 'monitor', 'screen'])
/** The hotkey additionally understands the interactive drag-a-region mode. */
const HOTKEY_CAPTURE_MODES = new Set([...CAPTURE_MODES, 'region'])
const FORMATS = new Set(['png', 'jpeg'])

/**
 * Coerce one raw value, returning the default when it is unusable.
 *
 * Bad settings are corrected rather than thrown, because a malformed config file
 * must never make the tools unavailable — the user would have no way to fix it
 * from inside DSH.
 *
 * @param {string} key
 * @param {unknown} value
 */
export function coerceValue (key, value) {
  const fallback = DEFAULT_CONFIG[key]
  if (value === undefined) return fallback

  switch (key) {
    case 'hotkey':
      return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
    case 'hotkeyCapture':
      return typeof value === 'string' && HOTKEY_CAPTURE_MODES.has(value) ? value : fallback
    case 'composerCapture':
      return typeof value === 'string' && CAPTURE_MODES.has(value) ? value : fallback
    case 'archiveDir':
      if (value === null) return null
      return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
    case 'clipboard':
    case 'showBalloon':
    case 'hotkeyAutoStart':
    case 'composerArchive':
    case 'composerClipboard':
      return typeof value === 'boolean' ? value : fallback
    case 'format':
      return typeof value === 'string' && FORMATS.has(value) ? value : fallback
    case 'jpegQuality': {
      const quality = Number(value)
      return Number.isFinite(quality) ? Math.min(100, Math.max(1, Math.round(quality))) : fallback
    }
    case 'maxWidth': {
      const width = Number(value)
      return Number.isFinite(width) && width > 0 ? Math.round(width) : 0
    }
    case 'excludeProcesses':
      return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim()) : fallback
    default:
      return fallback
  }
}

/**
 * Merge unknown input onto the defaults, keeping only known keys.
 *
 * @param {object} [raw]
 */
export function normalizeConfig (raw = {}) {
  const result = {}
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    result[key] = coerceValue(key, raw?.[key])
  }
  return result
}

/** Absolute path of the settings file inside the plugin data directory. */
export function configPath (directory) {
  return path.join(directory, 'config.json')
}

/**
 * Read settings, tolerating a missing or corrupt file.
 *
 * A corrupt file yields defaults plus a warning: refusing to start would strand
 * the user with a broken plugin and no way to reset it from the tool surface.
 *
 * @param {string} directory plugin data directory
 * @returns {Promise<{ config: object, warning: string|null }>}
 */
export async function loadConfig (directory) {
  const file = configPath(directory)
  try {
    const text = await readFile(file, 'utf8')
    return { config: normalizeConfig(JSON.parse(text)), warning: null }
  } catch (error) {
    if (error?.code === 'ENOENT') return { config: normalizeConfig({}), warning: null }
    return { config: normalizeConfig({}), warning: `配置文件无法解析，已使用默认值：${(error?.message ?? String(error))}` }
  }
}

/**
 * Write settings atomically enough for a single writer.
 *
 * @param {string} directory
 * @param {object} config
 */
export async function saveConfig (directory, config) {
  await mkdir(directory, { recursive: true })
  const normalized = normalizeConfig(config)
  await writeFile(configPath(directory), `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
  return normalized
}

/**
 * Apply a partial patch and persist it.
 *
 * @param {string} directory
 * @param {object} patch
 */
export async function updateConfig (directory, patch) {
  const { config, warning } = await loadConfig(directory)
  const next = await saveConfig(directory, { ...config, ...patch })
  return { config: next, warning }
}
