/**
 * Path and file-name policy for dsh-quick-screenshot.
 *
 * Pure string/path work only — no I/O, no DSH imports — so the naming rules can
 * be unit-tested without a Windows desktop or a running host.
 *
 * @module dsh-quick-screenshot/paths
 */

import { homedir } from 'node:os'
import path from 'node:path'

/** Folder name created inside a session workspace for archived shots. */
export const ARCHIVE_FOLDER = 'screenshots'

/** Characters Windows refuses in a file name, plus the ones that still confuse shells. */
const INVALID_FILE_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g

/**
 * Absolute DSH home directory.
 *
 * Read from the environment first because the host sets it for every child, and
 * fall back to the documented default so the plugin still works when it is
 * loaded outside the desktop shell.
 */
export function dshHome (env = process.env) {
  return env.DSH_HOME && env.DSH_HOME.length > 0 ? env.DSH_HOME : path.join(homedir(), '.dsh')
}

/**
 * Plugin-private data directory, following the host's `plugin-data/<name>` layout.
 *
 * Screenshot tool state (config, hotkey liveness, the `latest` pointer) lives
 * here rather than in the workspace: it is plugin bookkeeping, not a project
 * artifact, so it must not appear in `git status` of the user's repository.
 */
export function pluginDataDir (env = process.env) {
  return path.join(dshHome(env), 'plugin-data', 'dsh-quick-screenshot')
}

/** Where the hotkey daemon keeps its liveness and event files. */
export function stateDir (env = process.env) {
  return path.join(pluginDataDir(env), 'state')
}

/** Fallback archive location when a session has no working directory. */
export function fallbackShotsDir (env = process.env) {
  return path.join(pluginDataDir(env), 'shots')
}

/**
 * The archive directory for a session.
 *
 * A session workspace wins because the user asked for a per-project archive
 * folder; the plugin-data fallback keeps captures working for a session that has
 * no cwd yet (a brand-new chat, or a restored session whose header is missing).
 *
 * @param {object} options
 * @param {string|undefined} options.configured explicitly configured directory
 * @param {string|undefined} options.cwd session working directory
 * @param {NodeJS.ProcessEnv} [options.env]
 */
export function resolveArchiveDir ({ configured, cwd, env = process.env } = {}) {
  if (typeof configured === 'string' && configured.trim().length > 0) return path.resolve(expandHome(configured.trim(), env))
  if (typeof cwd === 'string' && cwd.trim().length > 0) return path.join(path.resolve(cwd), ARCHIVE_FOLDER)
  return fallbackShotsDir(env)
}

/** Expand a leading `~` so a config value can be written by hand. */
export function expandHome (value, env = process.env) {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(homedir(), value.slice(2))
  return value
}

/**
 * Two-digit zero padding without depending on locale-aware formatting.
 *
 * @param {number} value
 * @param {number} [width]
 */
export function pad (value, width = 2) {
  return String(Math.trunc(Math.abs(value))).padStart(width, '0')
}

/**
 * `YYYYMMDD_HHMMSS` in local time.
 *
 * Local time on purpose: a screenshot is found later by the user remembering
 * "around lunchtime", not by an absolute epoch.
 */
export function timestamp (date = new Date()) {
  return (
    String(date.getFullYear()) +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    '_' +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  )
}

/**
 * Make any window title safe as one file-name segment.
 *
 * Collapses every run of separators and whitespace into a single underscore so a
 * title such as "a / b" cannot silently create a nested path, drops trailing
 * dots and spaces (Windows silently strips them, which would desynchronize the
 * name the plugin reports from the name on disk), and truncates by code point so
 * a surrogate pair is never split.
 *
 * @param {string} text
 * @param {number} [max] maximum code points to keep
 */
export function sanitizeSegment (text, max = 40) {
  const raw = String(text ?? '')
    .replace(INVALID_FILE_CHARS, ' ')
    .replace(/[\s_]+/g, '_')
    .replace(/^[._]+|[._]+$/g, '')

  if (raw.length === 0) return 'capture'
  const points = Array.from(raw)
  const clipped = points.length > max ? points.slice(0, max).join('') : raw
  const trimmed = clipped.replace(/^[._]+|[._]+$/g, '')
  return trimmed.length === 0 ? 'capture' : trimmed
}

/**
 * Collision-free file name for one capture.
 *
 * The label carries the window title so a folder of shots is readable without
 * opening anything; the timestamp keeps names unique and sortable.
 *
 * @param {object} options
 * @param {string} [options.label] window title or target description
 * @param {Date} [options.date]
 * @param {'png'|'jpeg'} [options.format]
 * @param {number} [options.maxLabel]
 */
export function screenshotFileName ({ label = 'capture', date = new Date(), format = 'png', maxLabel = 40 } = {}) {
  const extension = format === 'jpeg' ? 'jpg' : 'png'
  return `${timestamp(date)}_${sanitizeSegment(label, maxLabel)}.${extension}`
}

/**
 * Add a numeric suffix when a file already exists.
 *
 * Two captures inside the same second are normal when a hotkey is pressed twice;
 * silently overwriting the first one would lose a screenshot the user believes
 * they took.
 *
 * @param {string} filePath
 * @param {(candidate: string) => boolean} exists
 */
export function uniquePath (filePath, exists) {
  if (!exists(filePath)) return filePath
  const directory = path.dirname(filePath)
  const extension = path.extname(filePath)
  const base = path.basename(filePath, extension)
  for (let index = 2; index < 1000; index++) {
    const candidate = path.join(directory, `${base}-${index}${extension}`)
    if (!exists(candidate)) return candidate
  }
  return path.join(directory, `${base}-${Date.now()}${extension}`)
}
