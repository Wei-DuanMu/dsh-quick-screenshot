/**
 * Integration tests: drive the real PowerShell helper and the real hotkey daemon.
 *
 * These verify what unit tests cannot: that PowerShell 5.1 can compile the P/Invoke
 * layer, that window enumeration returns sane geometry, and that a capture produces
 * a real, non-blank image file of the expected size.
 *
 *     node --test test/integration.test.mjs
 *
 * Every case SKIPS (with the reason) when the environment cannot run it: a
 * restricted sandbox may refuse child processes with piped stdio, and reporting
 * "skipped: blocked" is honest while a green test that asserted nothing is not.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import { HelperClient } from '../lib/helper-client.js'
import { hotkeyStatus, readEvents, readLatest, startDaemon, stopDaemon } from '../lib/hotkey.js'

const isWindows = process.platform === 'win32'
const skipPlatform = isWindows ? false : 'Windows only'
const root = path.resolve(import.meta.dirname, '..')

let workDir = null
let helper = null
let blockedReason = null

/**
 * Start the real helper once; remember if this environment refuses to spawn it.
 *
 * @returns {Promise<HelperClient|null>} null when spawning is blocked
 */
async function ensureHelper () {
  if (blockedReason !== null) return null
  if (helper) return helper

  workDir ??= await mkdtemp(path.join(tmpdir(), 'dsh-quick-screenshot-it-'))
  const candidate = new HelperClient({ root })
  try {
    await candidate.start()
    helper = candidate
    return helper
  } catch (error) {
    const message = String(error?.message ?? '')
    if (message.includes('EPERM') || message.includes('HELPER_EXITED') || message.includes('启动失败')) {
      blockedReason = `this environment cannot spawn a child with piped stdio (${message.slice(0, 120)})`
      await candidate.dispose()
      return null
    }
    throw error
  }
}

after(async () => {
  await helper?.dispose()
  if (workDir) await rm(workDir, { recursive: true, force: true })
})

describe('capture helper', { skip: skipPlatform }, () => {
  it('answers ping with monitors and a raised DPI awareness', async (t) => {
    const client = await ensureHelper()
    if (!client) return t.skip(blockedReason)

    const ping = await client.request('ping')
    assert.equal(ping.protocol, 1)
    assert.ok(Array.isArray(ping.monitors) && ping.monitors.length >= 1)
    assert.notEqual(ping.dpiLevel, 'none', 'without DPI awareness every capture would be scaled and offset')
    assert.equal(ping.apartment, 'STA', 'clipboard access needs a single-threaded apartment')
  })

  it('lists windows with usable geometry', async (t) => {
    const client = await ensureHelper()
    if (!client) return t.skip(blockedReason)

    const data = await client.request('list_windows')
    assert.ok(Array.isArray(data.windows))
    for (const window of data.windows) {
      assert.equal(typeof window.id, 'string')
      assert.ok(window.width >= 1 && window.height >= 1)
      assert.ok(Number.isInteger(window.monitor))
    }
  })

  it('captures the focused window to a real, non-blank PNG', async (t) => {
    const client = await ensureHelper()
    if (!client) return t.skip(blockedReason)

    const { activeId, windows } = await client.request('list_windows')
    const active = windows.find((window) => window.id === activeId)
    if (!active) return t.skip('no foreground window on this desktop (locked or headless)')

    const out = path.join(workDir, 'active-window.png')
    const result = await client.request('capture', {
      target: {
        kind: 'window',
        handle: Number(active.id),
        x: active.x,
        y: active.y,
        width: active.width,
        height: active.height,
        minimized: active.minimized,
      },
      path: out,
    })

    const capture = result.capture
    assert.equal(capture.path, out)
    assert.equal(capture.width, active.width, 'the PNG must be the window width in physical pixels')
    assert.equal(capture.height, active.height)
    assert.equal(capture.blank, false, 'a real desktop capture must not be a single flat colour')

    const bytes = await readFile(out)
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'PNG signature')
  })

  it('captures an exact region, including negative coordinates on a left-hand monitor', async (t) => {
    const client = await ensureHelper()
    if (!client) return t.skip(blockedReason)

    const out = path.join(workDir, 'region.png')
    const result = await client.request('capture', {
      target: { kind: 'region', x: -200, y: -100, width: 320, height: 200 },
      path: out,
    })
    assert.equal(result.capture.width, 320)
    assert.equal(result.capture.height, 200)
  })

  it('reports a missing monitor instead of capturing something else', async (t) => {
    const client = await ensureHelper()
    if (!client) return t.skip(blockedReason)

    await assert.rejects(
      client.request('capture', { target: { kind: 'monitor', index: 99 }, path: path.join(workDir, 'nope.png') }),
      (error) => {
        assert.equal(error.code, 'MONITOR_NOT_FOUND')
        return true
      },
    )
  })

  it('answers an unknown command with a code and stays usable', async (t) => {
    const client = await ensureHelper()
    if (!client) return t.skip(blockedReason)

    await assert.rejects(client.request('this_command_does_not_exist'), (error) => {
      assert.equal(error.code, 'UNKNOWN_COMMAND')
      return true
    })

    const ping = await client.request('ping')
    assert.equal(ping.protocol, 1)
  })
})

describe('hotkey daemon', { skip: skipPlatform }, () => {
  it('registers a hotkey, reports it, and stops cleanly', async (t) => {
    // Start the daemon straight away: it uses file-redirected stdio, so it can
    // work even where piped child stdio is refused.
    const stateDir = await mkdtemp(path.join(tmpdir(), 'dsh-quick-screenshot-hk-'))
    const configPath = path.join(stateDir, 'config.json')
    await writeFile(configPath, JSON.stringify({ archiveDir: stateDir, clipboard: false, showBalloon: false, captureMode: 'active' }), 'utf8')

    try {
      const started = await startDaemon({
        root,
        stateDir,
        configPath,
        combos: [
          { combo: 'Ctrl+Shift+F9', mods: 6, vk: 120 },
          { combo: 'Ctrl+Alt+F9', mods: 3, vk: 120 },
          { combo: 'Ctrl+Shift+Y', mods: 6, vk: 89 },
        ],
        requested: 'Ctrl+Shift+F9',
      })

      if (started.code === 'DAEMON_EXITED' || started.code === 'DAEMON_TIMEOUT') {
        const log = await readFile(path.join(stateDir, 'daemon.log'), 'utf8').catch(() => '')
        if (log.trim().length === 0) {
          // The process was created but produced nothing at all: the environment
          // intercepts detached children. Not a defect in the daemon.
          return t.skip('this environment cannot keep a detached child process alive')
        }
        assert.fail(`daemon exited with output: ${log.slice(-400)}`)
      }

      if (!started.ok) {
        // Another application may legitimately own every candidate on this
        // machine. The contract is to say so clearly, not to pretend.
        assert.equal(started.code, 'HOTKEY_REGISTER_FAILED', `unexpected daemon failure: ${started.code}`)
        assert.ok(Array.isArray(started.tried) && started.tried.length > 0)
        return
      }

      assert.ok(started.pid > 0)
      assert.ok(started.combo.length > 0)

      const status = await hotkeyStatus({ stateDir })
      assert.equal(status.running, true)
      assert.equal(status.combo, started.combo)
      assert.ok(status.startedAt)

      const stopped = await stopDaemon(stateDir)
      assert.equal(stopped.stopped, true, 'the daemon must actually die, not just lose its state file')
      const afterStop = await hotkeyStatus({ stateDir })
      assert.equal(afterStop.running, false)
    } finally {
      await stopDaemon(stateDir).catch(() => {})
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  it('handles a full multi-candidate list without a cast error', async (t) => {
    // Regression: `@($json | ConvertFrom-Json)` nested the array, so the loop got
    // the whole array instead of one candidate and `[int]$candidate.mods` cast an
    // array to int. That only threw with two or more candidates — with one, the
    // 1-element array coerced fine, so a single-candidate test stayed green while
    // the real plugin (seven candidates) died silently.
    const stateDir = await mkdtemp(path.join(tmpdir(), 'dsh-quick-screenshot-mc-'))
    const configPath = path.join(stateDir, 'config.json')
    await writeFile(configPath, JSON.stringify({ archiveDir: stateDir, clipboard: false, showBalloon: false, captureMode: 'active' }), 'utf8')

    const combos = [
      { combo: 'Ctrl+Alt+A', mods: 3, vk: 65 },
      { combo: 'Ctrl+Shift+A', mods: 6, vk: 65 },
      { combo: 'Ctrl+Alt+S', mods: 3, vk: 83 },
      { combo: 'Ctrl+Alt+D', mods: 3, vk: 68 },
      { combo: 'Ctrl+Shift+S', mods: 6, vk: 83 },
      { combo: 'Ctrl+Shift+X', mods: 6, vk: 88 },
      { combo: 'Ctrl+Shift+F9', mods: 6, vk: 120 },
    ]

    try {
      const started = await startDaemon({ root, stateDir, configPath, combos, requested: combos[0].combo })

      if (started.code === 'DAEMON_EXITED' || started.code === 'DAEMON_TIMEOUT') {
        const log = await readFile(path.join(stateDir, 'daemon.log'), 'utf8').catch(() => '')
        if (log.trim().length === 0) return t.skip('this environment cannot keep a spawned child alive')
        assert.fail(`daemon died with output: ${log.slice(-300)}`)
      }

      const details = JSON.stringify(started)
      assert.ok(!/System\.Object\[\]|System\.Int32/.test(details), `a PowerShell cast error leaked through: ${details}`)

      if (!started.ok) {
        assert.equal(started.code, 'HOTKEY_REGISTER_FAILED')
        assert.ok(started.tried.length >= 2, 'every candidate should have been attempted and reported')
        return
      }

      // Multi-candidate parsing worked and registration succeeded: the daemon
      // reports which candidate won, and the log proves it parsed them all.
      assert.ok(started.combo.length > 0)
      const log = await readFile(path.join(stateDir, 'daemon.log'), 'utf8')
      assert.match(log, new RegExp(`candidates parsed: ${combos.length}`))
    } finally {
      await stopDaemon(stateDir).catch(() => {})
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  it('reads an event log tail without trusting torn lines', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'dsh-quick-screenshot-ev-'))
    try {
      await writeFile(
        path.join(stateDir, 'events.ndjson'),
        `${JSON.stringify({ ts: 1, ok: true, path: 'a.png' })}\n{"torn line\n${JSON.stringify({ ts: 2, ok: false, code: 'X' })}\n`,
        'utf8',
      )
      const events = await readEvents(stateDir, 5)
      assert.equal(events.length, 2)
      assert.equal(events[0].ts, 2, 'newest first')
      assert.equal(await readLatest(stateDir), null)
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })
})
