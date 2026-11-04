/**
 * Lifecycle and framing for the resident PowerShell capture helper.
 *
 * A cold PowerShell start costs about a second (startup plus the Add-Type compile
 * of the P/Invoke layer) while a warm capture costs tens of milliseconds, so this
 * class keeps one helper alive and multiplexes requests over it with a JSON-Lines
 * protocol. Everything here is about not letting that long-lived child become a
 * source of hangs: every request has a deadline, every pending request is
 * rejected when the child dies, and a dead child is restarted on the next call.
 *
 * @module dsh-quick-screenshot/helper-client
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

/** A failure reported by, or about, the helper process. */
export class HelperError extends Error {
  constructor (message, code = 'HELPER_ERROR', details = {}) {
    super(message)
    this.name = 'HelperError'
    this.code = code
    this.details = details
  }
}

/** How long a request may take before it is abandoned. */
export const DEFAULT_TIMEOUT_MS = 30_000

/** Non-JSON stdout lines kept for diagnostics; the helper must not write any. */
const NOISE_LIMIT = 20

/**
 * Incremental newline-delimited JSON decoder.
 *
 * Kept separate from the process plumbing so framing can be tested by feeding it
 * byte slices at arbitrary boundaries — the classic bug here is a chunk that ends
 * mid-line, which silently drops a response and hangs the caller.
 */
export class LineDecoder {
  constructor () {
    this.buffer = ''
    this.noise = []
  }

  /**
   * Feed one stdout chunk.
   *
   * @param {string} chunk
   * @returns {Array<object>} parsed frames, in order
   */
  push (chunk) {
    this.buffer += chunk
    const frames = []
    let index = this.buffer.indexOf('\n')
    while (index !== -1) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '')
      this.buffer = this.buffer.slice(index + 1)
      const frame = this.parseLine(line)
      if (frame) frames.push(frame)
      index = this.buffer.indexOf('\n')
    }
    return frames
  }

  /**
   * Parse one line, recording non-protocol output instead of throwing.
   *
   * @param {string} line
   */
  parseLine (line) {
    const text = line.trim()
    if (text.length === 0) return null
    if (!text.startsWith('{')) {
      this.recordNoise(text)
      return null
    }
    try {
      const value = JSON.parse(text)
      if (value && typeof value === 'object') return value
      this.recordNoise(text)
      return null
    } catch {
      this.recordNoise(text)
      return null
    }
  }

  /** Keep a bounded tail of unexpected output for error messages. */
  recordNoise (text) {
    this.noise.push(text)
    if (this.noise.length > NOISE_LIMIT) this.noise.shift()
  }

  /** Whatever is left in the buffer when the child died mid-line. */
  flushTail () {
    const rest = this.buffer.trim()
    this.buffer = ''
    if (rest.length > 0) this.recordNoise(rest)
    return rest
  }
}

/**
 * Locate Windows PowerShell.
 *
 * `System32` is used rather than whatever `powershell.exe` resolves to on PATH,
 * because DSH children inherit a modified PATH in sandboxed sessions and the
 * capture helper must not depend on that.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolvePowerShell (env = process.env) {
  const fromEnv = env.DSH_QUICK_SCREENSHOT_POWERSHELL
  if (fromEnv && existsSync(fromEnv)) return fromEnv

  const systemRoot = env.SystemRoot ?? env.windir ?? 'C:\\Windows'
  const candidate = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (existsSync(candidate)) return candidate
  return 'powershell.exe'
}

/** True when this host can run the capture helper at all. */
export function isSupportedPlatform (platform = process.platform) {
  return platform === 'win32'
}

/**
 * The exact argument vector used to start the capture helper.
 *
 * Extracted so it can be asserted: `-STA` is required for clipboard access, and
 * `-NoProfile` keeps a user's PowerShell profile from writing to the protocol
 * stream. Both are silent, hard-to-diagnose failures when missing.
 *
 * @param {string} scriptPath absolute path to host/helper.ps1
 * @param {string} root plugin root
 */
export function buildHelperArgs (scriptPath, root) {
  return [
    '-NoLogo',
    '-NoProfile',
    '-STA',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
    '-Root',
    root,
  ]
}

export class HelperClient {
  /**
   * @param {object} options
   * @param {string} options.root plugin root, containing host/helper.ps1
   * @param {string} [options.workDir] scratch directory the helper runs in
   * @param {number} [options.timeoutMs]
   * @param {(level: string, message: string) => void} [options.log]
   */
  constructor ({ root, workDir, timeoutMs = DEFAULT_TIMEOUT_MS, log = () => {} }) {
    this.root = root
    this.scriptPath = path.join(root, 'host', 'helper.ps1')
    this.workDir = workDir ?? tmpdir()
    this.timeoutMs = timeoutMs
    this.log = log

    this.child = null
    this.decoder = new LineDecoder()
    this.pending = new Map()
    this.nextId = 1
    this.starting = null
    this.startCount = 0
    this.lastError = null
  }

  /** Whether a live helper is attached. */
  get running () {
    return this.child !== null && !this.child.killed && this.child.exitCode === null
  }

  /**
   * Ensure one helper is running, starting it if needed.
   *
   * Concurrent callers share the same in-flight start, so a burst of tool calls
   * cannot spawn several PowerShell processes.
   */
  async start () {
    if (this.running) return
    if (this.starting) return this.starting

    this.starting = (async () => {
      if (!isSupportedPlatform()) {
        throw new HelperError('截图功能只支持 Windows。', 'UNSUPPORTED_PLATFORM')
      }
      if (!existsSync(this.scriptPath)) {
        throw new HelperError(`找不到截图助手脚本：${this.scriptPath}`, 'HELPER_SCRIPT_MISSING')
      }

      const executable = resolvePowerShell()
      const args = buildHelperArgs(this.scriptPath, this.root)

      // Never use the plugin directory as the child's working directory: on
      // Windows a process whose CWD is a directory prevents that directory from
      // being renamed, and a plugin update works by renaming the package folder.
      // A long-lived helper parked in its own package made the plugin permanently
      // un-updatable (EPERM on rename). The scratch dir is ours and disposable.
      await mkdir(this.workDir, { recursive: true })

      const child = spawn(executable, args, {
        cwd: this.workDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })

      this.child = child
      this.decoder = new LineDecoder()
      this.startCount += 1

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        for (const frame of this.decoder.push(chunk)) this.handleFrame(frame)
      })

      let stderr = ''
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk).slice(-4000)
        this.log('debug', `[helper stderr] ${chunk.trim()}`)
      })

      child.on('error', (error) => {
        this.lastError = new HelperError(`截图助手启动失败：${error.message}`, 'HELPER_SPAWN_FAILED')
        this.rejectAll(this.lastError)
        this.child = null
      })

      child.on('exit', (code, signal) => {
        const noise = this.decoder.noise.join(' | ')
        const detail = [stderr.trim(), noise].filter((part) => part.length > 0).join(' | ')
        const failure = new HelperError(
          `截图助手进程已退出（code=${code}${signal ? `, signal=${signal}` : ''}）${detail ? `：${detail}` : ''}`,
          'HELPER_EXITED',
          { code, signal },
        )
        this.lastError = code === 0 ? null : failure
        this.child = null
        this.rejectAll(failure)
      })

      // A first ping doubles as the readiness check: the helper compiles its
      // P/Invoke layer during module load, so answering means it can capture.
      await this.send('ping', {}, { timeoutMs: Math.max(this.timeoutMs, 30_000) })
    })()

    try {
      await this.starting
    } finally {
      this.starting = null
    }
  }

  /**
   * Send one command and resolve with its `data` payload.
   *
   * @param {string} cmd
   * @param {object} [args]
   * @param {object} [options]
   * @param {number} [options.timeoutMs]
   * @returns {Promise<object>}
   */
  async request (cmd, args = {}, options = {}) {
    await this.start()
    return this.send(cmd, args, options)
  }

  /**
   * Write one request frame and await its matching response.
   *
   * @param {string} cmd
   * @param {object} args
   * @param {object} [options]
   */
  async send (cmd, args = {}, { timeoutMs = this.timeoutMs } = {}) {
    const child = this.child
    if (!child || child.exitCode !== null) {
      throw this.lastError ?? new HelperError('截图助手没有在运行。', 'HELPER_NOT_RUNNING')
    }

    const id = String(this.nextId++)
    const payload = `${JSON.stringify({ id, cmd, args })}\n`

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new HelperError(`截图助手在 ${Math.round(timeoutMs / 1000)} 秒内没有响应（命令 ${cmd}）。`, 'HELPER_TIMEOUT'))
      }, timeoutMs)
      timer.unref?.()

      this.pending.set(id, { resolve, reject, timer, cmd })

      try {
        child.stdin.write(payload, 'utf8')
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new HelperError(`无法向截图助手发送命令：${error.message}`, 'HELPER_WRITE_FAILED'))
      }
    })
  }

  /**
   * Settle one response frame.
   *
   * @param {object} frame
   */
  handleFrame (frame) {
    const id = frame.id === null || frame.id === undefined ? null : String(frame.id)
    if (id === null) {
      this.log('debug', `[helper event] ${JSON.stringify(frame)}`)
      return
    }
    const entry = this.pending.get(id)
    if (!entry) {
      this.log('debug', `[helper late response] ${JSON.stringify(frame)}`)
      return
    }
    this.pending.delete(id)
    clearTimeout(entry.timer)

    if (frame.ok === true) {
      entry.resolve(frame.data ?? {})
      return
    }
    const error = frame.error ?? {}
    entry.reject(new HelperError(
      String(error.message ?? '截图助手执行失败'),
      String(error.code ?? 'HELPER_COMMAND_FAILED'),
      { command: entry.cmd },
    ))
  }

  /**
   * Reject every in-flight request after the child died.
   *
   * @param {Error} error
   */
  rejectAll (error) {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
      this.pending.delete(id)
    }
  }

  /** Stop the helper and reject anything still in flight. */
  async dispose () {
    const child = this.child
    this.child = null
    if (!child) return
    try {
      child.stdin.write(`${JSON.stringify({ id: 'bye', cmd: 'quit' })}\n`, 'utf8')
    } catch {
      // The child may already be gone; killing below is what matters.
    }
    this.rejectAll(new HelperError('截图助手已关闭。', 'HELPER_CLOSED'))
    try {
      child.kill()
    } catch {
      // Already terminated.
    }
  }
}

/**
 * Ensure a directory exists.
 *
 * @param {string} directory
 */
export async function ensureDirectory (directory) {
  await mkdir(directory, { recursive: true })
  return directory
}
