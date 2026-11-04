/**
 * Lifecycle of the global-hotkey capture daemon.
 *
 * The daemon is a *detached* PowerShell process, not a child of a session: a
 * hotkey exists to fire while DSH is behind another window or not focused, and a
 * child that dies with the plugin would defeat that. So the plugin starts it, then
 * only ever talks to it through files: `daemon.json` for liveness, `events.ndjson`
 * for what happened, `latest.json` for "the shot I just took".
 *
 * @module dsh-quick-screenshot/hotkey
 */

import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { resolvePowerShell } from './helper-client.js'

/** How long to wait for the daemon to report a registered hotkey. */
export const START_TIMEOUT_MS = 20_000

/** Poll interval while waiting; the daemon writes its state once, at startup. */
const READY_POLL_MS = 150

/** Only the tail of the event log is ever read back. */
const EVENT_TAIL_BYTES = 256 * 1024

/** Files the daemon owns. */
export const daemonFile = (stateDir) => path.join(stateDir, 'daemon.json')
export const latestFile = (stateDir) => path.join(stateDir, 'latest.json')
export const eventsFile = (stateDir) => path.join(stateDir, 'events.ndjson')
export const candidatesFile = (stateDir) => path.join(stateDir, 'candidates.json')
export const daemonLogFile = (stateDir) => path.join(stateDir, 'daemon.log')

/**
 * Read and parse a JSON file, returning null when it is missing or unreadable.
 *
 * @param {string} file
 */
export async function readJson (file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Whether a process id is alive.
 *
 * `process.kill(pid, 0)` is the portable probe; on Windows it fails with ESRCH for
 * a dead pid and EPERM for a live one owned by another user, and EPERM still
 * means alive.
 *
 * @param {number} pid
 */
export function isProcessAlive (pid) {
  const value = Number(pid)
  if (!Number.isFinite(value) || value <= 0) return false
  try {
    process.kill(value, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * Read the daemon's last reported state plus a derived liveness flag.
 *
 * `daemon.json` is written at startup and on shutdown; a machine that killed the
 * process (or a reboot) leaves `ready: true` behind, so the pid must be probed
 * before believing it.
 *
 * @param {string} stateDir
 */
export async function readDaemonState (stateDir) {
  const raw = await readJson(daemonFile(stateDir))
  if (!raw) return { present: false, ready: false, running: false, state: null }
  const running = raw.ready === true && isProcessAlive(raw.pid)
  return { present: true, ready: raw.ready === true, running, state: raw }
}

/**
 * Read the most recent successful capture pointer.
 *
 * @param {string} stateDir
 */
export async function readLatest (stateDir) {
  return await readJson(latestFile(stateDir))
}

/**
 * Read the tail of the event log.
 *
 * Bounded to a tail slice: the log is append-only and lives for the life of the
 * installation, so reading it whole would eventually cost seconds.
 *
 * @param {string} stateDir
 * @param {number} [limit]
 */
export async function readEvents (stateDir, limit = 10) {
  const file = eventsFile(stateDir)
  try {
    const handle = await readFile(file)
    const slice = handle.subarray(Math.max(0, handle.length - EVENT_TAIL_BYTES)).toString('utf8')
    const lines = slice.split('\n').filter((line) => line.trim().length > 0)
    const parsed = []
    for (const line of lines) {
      try {
        parsed.push(JSON.parse(line))
      } catch {
        // A torn first line from the tail slice is expected; skip it.
      }
    }
    return parsed.slice(-limit).reverse()
  } catch {
    return []
  }
}

/**
 * Stop a running daemon.
 *
 * @param {string} stateDir
 * @returns {Promise<{ stopped: boolean, pid: number|null, reason?: string }>}
 */
export async function stopDaemon (stateDir) {
  const { state, running } = await readDaemonState(stateDir)
  if (!state || !running) {
    return { stopped: false, pid: state?.pid ?? null, reason: 'not-running' }
  }

  const pid = Number(state.pid)
  try {
    process.kill(pid)
  } catch (error) {
    return { stopped: false, pid, reason: `无法结束进程 ${pid}：${error?.message ?? String(error)}` }
  }

  const deadline = Date.now() + 4000
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      await rm(daemonFile(stateDir), { force: true })
      return { stopped: true, pid }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  // Terminate is asynchronous on Windows; if the pid outlives the grace window,
  // report it rather than pretending the hotkey is gone.
  return { stopped: !isProcessAlive(pid), pid, reason: 'still-alive' }
}

/**
 * The exact argument vector used to start the hotkey daemon.
 *
 * Extracted so it can be asserted without spawning anything: the candidate list
 * goes through a *file* (`-CombosFile`) because an inline JSON array of hotkeys
 * carries double quotes, and every Windows caller quotes command-line arguments
 * slightly differently.
 *
 * @param {object} options
 * @param {string} options.scriptPath
 * @param {string} options.root
 * @param {string} options.candidatesFile
 * @param {string} options.requested
 * @param {string} options.configPath
 * @param {string} options.stateDir
 */
export function buildDaemonArgs ({ scriptPath, root, candidatesFile, requested, configPath, stateDir }) {
  return [
    '-NoLogo',
    '-NoProfile',
    '-STA',
    '-ExecutionPolicy',
    'Bypass',
    '-WindowStyle',
    'Hidden',
    '-File',
    scriptPath,
    '-Root',
    root,
    '-CombosFile',
    candidatesFile,
    '-Requested',
    requested,
    '-ConfigPath',
    configPath,
    '-StateDir',
    stateDir,
  ]
}

/**
 * Start the daemon and wait until it has a hotkey registered.
 *
 * @param {object} options
 * @param {string} options.root plugin root (contains host/hotkey.ps1)
 * @param {string} options.stateDir
 * @param {string} options.configPath settings file the daemon re-reads per press
 * @param {Array<{combo: string, mods: number, vk: number}>} options.combos ordered candidates
 * @param {string} options.requested the combo the user asked for
 * @param {NodeJS.ProcessEnv} [options.env]
 * @returns {Promise<object>} the daemon state, or an error description
 */
export async function startDaemon ({ root, stateDir, configPath, combos, requested, env = process.env }) {
  if (combos.length === 0) {
    return { ok: false, code: 'NO_CANDIDATES', message: '没有可用的快捷键候选。' }
  }

  await mkdir(stateDir, { recursive: true })
  await writeFile(candidatesFile(stateDir), JSON.stringify(combos), 'utf8')

  // A stale file from a previous run would be read as "already ready".
  await rm(daemonFile(stateDir), { force: true })

  const scriptPath = path.join(root, 'host', 'hotkey.ps1')
  if (!existsSync(scriptPath)) {
    return { ok: false, code: 'DAEMON_SCRIPT_MISSING', message: `找不到快捷键守护脚本：${scriptPath}` }
  }

  const logPath = daemonLogFile(stateDir)
  const logFd = openSync(logPath, 'a')
  let child
  try {
    child = spawn(
      resolvePowerShell(env),
      buildDaemonArgs({
        scriptPath,
        root,
        candidatesFile: candidatesFile(stateDir),
        requested,
        configPath,
        stateDir,
      }),
      {
        cwd: root,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', 'ignore', logFd],
        env,
      },
    )
  } finally {
    closeSync(logFd)
  }

  child.unref()

  let exited = false
  child.on('exit', () => {
    exited = true
  })

  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    const { state } = await readDaemonState(stateDir)
    if (state && state.ready === true) {
      return {
        ok: true,
        pid: state.pid,
        combo: state.combo,
        requested: state.requested ?? requested,
        fellBack: state.fellBack === true,
        tried: state.tried ?? [],
        dpiLevel: state.dpiLevel,
      }
    }
    if (state && state.ready === false && state.error) {
      return {
        ok: false,
        code: state.error.code ?? 'HOTKEY_REGISTER_FAILED',
        message: '没有成功注册全局快捷键。',
        tried: state.tried ?? [],
        pid: state.pid,
      }
    }
    if (exited) break
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS))
  }

  const logTail = await readFile(logPath, 'utf8').catch(() => '')
  return {
    ok: false,
    code: exited ? 'DAEMON_EXITED' : 'DAEMON_TIMEOUT',
    message: exited ? '快捷键守护进程启动后立即退出。' : `快捷键守护进程 ${Math.round(START_TIMEOUT_MS / 1000)} 秒内没有就绪。`,
    detail: logTail.split('\n').slice(-8).join('\n').trim(),
  }
}

/**
 * Full status report for the hotkey subsystem.
 *
 * @param {object} options
 * @param {string} options.stateDir
 * @param {string} [options.configuredCombo]
 */
export async function hotkeyStatus ({ stateDir, configuredCombo }) {
  const { present, ready, running, state } = await readDaemonState(stateDir)
  const latest = await readLatest(stateDir)
  const events = await readEvents(stateDir, 5)
  return {
    present,
    ready,
    running,
    pid: state?.pid ?? null,
    combo: state?.combo ?? null,
    requested: state?.requested ?? configuredCombo ?? null,
    fellBack: state?.fellBack === true,
    startedAt: state?.startedAt ?? null,
    stoppedAt: state?.stoppedAt ?? null,
    error: state?.error ?? null,
    tried: state?.tried ?? [],
    latest: latest ?? null,
    recentEvents: events,
  }
}
