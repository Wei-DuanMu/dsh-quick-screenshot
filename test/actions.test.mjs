/**
 * Tests for the capture orchestration (lib/actions.js) and the renderers
 * (lib/render.js), driven by a fake helper.
 *
 * This is where the behaviour users actually feel is pinned: which file is
 * written, whether a failed capture is explained instead of returning a black
 * image, whether a taken hotkey falls back, and what the model is told.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import {
  DESTINATIONS,
  attachImage,
  capture,
  captureForComposer,
  createComposerCaptureHandler,
  explainCaptureFailure,
  hotkeyControl,
  listWindows,
  parseDestinations,
  resolveComposerTarget,
  resolveTarget,
  service,
  sessionCwd,
  targetDescription,
} from '../lib/actions.js'
import { HelperError } from '../lib/helper-client.js'
import { renderCapture, renderHotkey, renderWindowList, formatBytes } from '../lib/render.js'
import { TargetError } from '../lib/windows.js'

const isWindows = process.platform === 'win32'

// Keep every path these tests touch inside a temp tree. Without this, a capture
// that resolves no archive directory falls back to the real DSH home, which a
// restricted test runner must not (and here, cannot) write to.
const homeRoot = path.join(tmpdir(), `dsh-quick-screenshot-home-${process.pid}`)
process.env.DSH_HOME = homeRoot

const windows = [
  { id: '100', title: 'Microsoft Edge', process: 'msedge', x: 0, y: 0, width: 1200, height: 800, monitor: 2, active: true, minimized: false },
  { id: '200', title: '微信', process: 'WeChat', x: -1800, y: 0, width: 700, height: 1000, monitor: 1, active: false, minimized: false },
  { id: '300', title: 'Terminal', process: 'pwsh', x: 10, y: 10, width: 800, height: 600, monitor: 2, active: false, minimized: true },
]

/**
 * A capture helper that records calls and can materialize files on demand.
 */
class FakeHelper {
  constructor ({ onCapture } = {}) {
    this.calls = []
    this.onCapture = onCapture
  }

  async request (cmd, args = {}) {
    this.calls.push({ cmd, args })
    switch (cmd) {
      case 'list_windows':
        return { activeId: '100', windows: args.includeMinimized ? windows : windows.filter((window) => !window.minimized) }
      case 'screens':
        return { monitors: [{ index: 0, width: 2560, height: 1440, primary: true }, { index: 1, width: 1920, height: 1080, primary: false }] }
      case 'window_geometry':
        if (String(args.handle) === '900') return { id: '900', x: 5, y: 6, width: 320, height: 240, minimized: false }
        throw new HelperError('no such window', 'WINDOW_NOT_FOUND')
      case 'cursor_monitor':
        return this.cursorMonitor ?? { index: 1, x: 100, y: 100 }
      case 'clipboard_from_file':
        return { written: true }
      case 'capture': {
        if (this.onCapture) return await this.onCapture(args)
        await writeFile(args.path, Buffer.from('fake-png-bytes'))
        return {
          capture: {
            path: args.path,
            width: args.target.kind === 'window' ? args.target.width : 640,
            height: args.target.kind === 'window' ? args.target.height : 480,
            method: 'screen',
            blank: false,
            clipboardWritten: args.clipboard === true,
            elapsedMs: 12,
          },
        }
      }
      default:
        throw new HelperError(`fake has no handler for ${cmd}`, 'NO_FAKE')
    }
  }

  commands () {
    return this.calls.map((call) => call.cmd)
  }
}

const tempRoot = path.join(tmpdir(), `dsh-quick-screenshot-actions-${process.pid}`)
const dataDir = path.join(tempRoot, 'data')
const stateDirectory = path.join(tempRoot, 'state')
const workspace = path.join(tempRoot, 'workspace')

after(async () => {
  await rm(tempRoot, { recursive: true, force: true })
  await rm(homeRoot, { recursive: true, force: true })
})

/** A fresh, empty config so tests do not inherit each other's settings. */
async function resetConfig (patch = {}) {
  await rm(dataDir, { recursive: true, force: true })
  await writeFile(path.join(tempRoot, 'placeholder'), '', { flag: 'w' }).catch(() => {})
  const { mkdir, writeFile: write } = await import('node:fs/promises')
  await mkdir(dataDir, { recursive: true })
  await write(path.join(dataDir, 'config.json'), JSON.stringify(patch), 'utf8')
}

describe('parseDestinations', () => {
  it('defaults to archive+chat', () => {
    assert.deepEqual(parseDestinations(undefined), ['archive', 'chat'])
    assert.deepEqual(parseDestinations('   '), ['archive', 'chat'])
  })

  it('accepts the three names in any order and de-duplicates', () => {
    assert.deepEqual(parseDestinations('clipboard,archive,chat'), ['clipboard', 'archive', 'chat'])
    assert.deepEqual(parseDestinations('chat,chat'), ['chat'])
  })

  it('expands all and none', () => {
    assert.deepEqual(parseDestinations('all'), [...DESTINATIONS])
    assert.deepEqual(parseDestinations('none'), [])
  })

  it('understands the aliases people and models actually type', () => {
    assert.deepEqual(parseDestinations('model'), ['chat'])
    assert.deepEqual(parseDestinations('copy'), ['clipboard'])
    assert.deepEqual(parseDestinations('save'), ['archive'])
  })

  it('rejects an unknown destination and lists the valid ones', () => {
    assert.throws(() => parseDestinations('dropbox'), (error) => {
      assert.ok(error instanceof TargetError)
      assert.match(error.message, /clipboard/)
      return true
    })
  })
})

describe('service and session plumbing', () => {
  it('reads a service through ctx.get, then the ctx property', () => {
    assert.equal(service({ get: (key) => (key === 'attachments' ? 'via-get' : undefined) }, 'attachments'), 'via-get')
    assert.equal(service({ attachments: 'via-prop' }, 'attachments'), 'via-prop')
    assert.equal(service(undefined, 'attachments'), undefined)
  })

  it('survives a ctx.get that throws', () => {
    assert.equal(service({ get: () => { throw new Error('nope') }, attachments: 'fallback' }, 'attachments'), 'fallback')
  })

  it('reads the session cwd out of the header, and nothing else', () => {
    assert.equal(sessionCwd({ agent: { session: { header: { cwd: 'D:\\proj' } } } }), 'D:\\proj')
    assert.equal(sessionCwd({ agent: { session: { header: {} } } }), undefined)
    assert.equal(sessionCwd(undefined), undefined)
  })
})

describe('resolveTarget', () => {
  const helper = new FakeHelper()

  it('resolves the focused window to explicit geometry', async () => {
    const resolved = await resolveTarget({ target: { kind: 'active' }, windows, latest: null, helper })
    assert.equal(resolved.request.kind, 'window')
    assert.equal(resolved.request.handle, 100)
    assert.equal(resolved.request.width, 1200)
    assert.equal(resolved.window.title, 'Microsoft Edge')
  })

  it('falls back to geometry for an untitled foreground window', async () => {
    // No enumerable window is focused: the foreground window has no title, so it
    // never appears in the list, but the host still knows its handle.
    const withoutActive = windows.map((window) => ({ ...window, active: false }))
    const resolved = await resolveTarget({
      target: { kind: 'active' },
      windows: withoutActive,
      latest: null,
      helper,
      activeId: '900',
    })
    assert.equal(resolved.request.handle, 900)
    assert.equal(resolved.window, null)
  })

  it('explains rather than guesses when the foreground window is unknown', async () => {
    const withoutActive = windows.map((window) => ({ ...window, active: false }))
    await assert.rejects(
      resolveTarget({ target: { kind: 'active' }, windows: withoutActive, latest: null, helper, activeId: '123' }),
      TargetError,
    )
  })

  it('maps monitor, screen and region targets straight through', async () => {
    assert.deepEqual((await resolveTarget({ target: { kind: 'monitor', index: 1 }, windows, helper })).request, { kind: 'monitor', index: 1 })
    assert.deepEqual((await resolveTarget({ target: { kind: 'screen' }, windows, helper })).request, { kind: 'screen' })
    assert.deepEqual(
      (await resolveTarget({ target: { kind: 'region', rect: { x: -10, y: 0, width: 100, height: 50 } }, windows, helper })).request,
      { kind: 'region', x: -10, y: 0, width: 100, height: 50 },
    )
  })

  it('picks the best window match and reports the runners-up', async () => {
    const resolved = await resolveTarget({ target: { kind: 'window', query: '微信' }, windows, helper })
    assert.equal(resolved.request.handle, 200)
    assert.ok(Array.isArray(resolved.alternatives))
  })

  it('lists real titles when a window query matches nothing', async () => {
    await assert.rejects(
      resolveTarget({ target: { kind: 'window', query: 'nonexistent-app' }, windows, helper }),
      (error) => {
        assert.match(error.message, /没有窗口匹配/)
        assert.match(error.message, /Microsoft Edge/)
        return true
      },
    )
  })

  it('refuses latest when there is no previous hotkey capture', async () => {
    await assert.rejects(resolveTarget({ target: { kind: 'latest' }, windows, latest: null, helper }), /还没有任何快捷键截图/)
  })
})

describe('capture', () => {
  const helper = new FakeHelper()

  it('archives into the session screenshots folder and reports the file', { skip: !isWindows }, async () => {
    await resetConfig({ archiveDir: null })
    const exec = { agent: { session: { header: { cwd: workspace } } } }
    const value = await capture({ args: { target: 'active', destinations: 'archive' }, exec, ctx: {}, helper, dataDir, stateDirectory })

    assert.equal(value.ok, true)
    assert.equal(value.archived, true)
    assert.equal(path.dirname(value.path), path.join(workspace, 'screenshots'))
    assert.equal(value.width, 1200)
    assert.equal(value.height, 800)
    assert.equal(value.method, 'screen')
    assert.ok(existsSync(value.path), 'the capture file must exist on disk')
    assert.ok(value.bytes > 0)
    assert.equal(value.imageAttached, false)
    assert.equal(value.image, null)
    assert.match(value.target.description, /Microsoft Edge/)
  })

  it('does not overwrite when two shots land in the same second', { skip: !isWindows }, async () => {
    await resetConfig({ archiveDir: null })
    const exec = { agent: { session: { header: { cwd: workspace } } } }
    const first = await capture({ args: { target: 'active', destinations: 'archive' }, exec, ctx: {}, helper, dataDir, stateDirectory })
    const second = await capture({ args: { target: 'active', destinations: 'archive' }, exec, ctx: {}, helper, dataDir, stateDirectory })
    assert.notEqual(first.path, second.path)
    assert.ok(existsSync(first.path))
    assert.ok(existsSync(second.path))
  })

  it('writes to a scratch file and removes it when nobody asked for a file', { skip: !isWindows }, async () => {
    await resetConfig({ archiveDir: null })
    const value = await capture({
      args: { target: 'screen', destinations: 'clipboard' },
      exec: {},
      ctx: {},
      helper,
      dataDir,
      stateDirectory,
    })
    assert.equal(value.archived, false)
    assert.equal(value.destinations.archive, false)
    assert.equal(value.path.includes('tmp'), true)
    assert.equal(existsSync(value.path), false, 'a scratch capture must not leak once delivered')
    assert.ok(value.notes.some((note) => note.includes('只保留在本次会话')))
  })

  it('honours an explicit save_path and creates its directory', { skip: !isWindows }, async () => {
    await resetConfig({ archiveDir: null })
    const target = path.join(tempRoot, 'explicit', 'shot.png')
    const value = await capture({ args: { target: 'screen', save_path: target, destinations: 'none' }, exec: {}, ctx: {}, helper, dataDir, stateDirectory })
    assert.equal(value.path, target)
    assert.ok(existsSync(target))
  })

  it('attaches the image when the host has an attachment store', { skip: !isWindows }, async () => {
    await resetConfig({ archiveDir: null })
    const saved = []
    const ctx = {
      attachments: {
        saveImages: async (inputs) => {
          saved.push(...inputs)
          return [{ attachmentId: 'sha256:abc', mediaType: inputs[0].mediaType, width: 1200, height: 800, bytes: inputs[0].data.byteLength }]
        },
      },
    }
    const value = await capture({ args: { target: 'active', destinations: 'archive,chat' }, exec: {}, ctx, helper, dataDir, stateDirectory })
    assert.equal(value.imageAttached, true)
    assert.equal(value.image.attachmentId, 'sha256:abc')
    assert.equal(saved.length, 1)
    assert.equal(saved[0].mediaType, 'image/png')
    assert.ok(saved[0].data.byteLength > 0)
  })

  it('degrades to a path when the attachment store throws', { skip: !isWindows }, async () => {
    await resetConfig({ archiveDir: null })
    const ctx = { attachments: { saveImages: async () => { throw new Error('model does not support images') } } }
    const value = await capture({ args: { target: 'active', destinations: 'archive,chat' }, exec: {}, ctx, helper, dataDir, stateDirectory })
    assert.equal(value.imageAttached, false)
    assert.equal(value.image, null)
    assert.ok(value.notes.some((note) => note.includes('路径可用')))
  })

  it('translates a helper failure into an actionable sentence', { skip: !isWindows }, async () => {
    await resetConfig({ archiveDir: null })
    const failing = new FakeHelper({
      onCapture: async () => {
        throw new HelperError('window is minimized', 'WINDOW_MINIMIZED_BLANK')
      },
    })
    await assert.rejects(
      capture({ args: { target: 'active', destinations: 'archive' }, exec: {}, ctx: {}, helper: failing, dataDir, stateDirectory }),
      (error) => {
        assert.equal(error.code, 'WINDOW_MINIMIZED_BLANK')
        assert.match(error.message, /先还原窗口/)
        return true
      },
    )
  })

  it('passes a blank-frame warning through instead of pretending success', { skip: !isWindows }, async () => {
    await resetConfig({ archiveDir: null })
    const blanking = new FakeHelper({
      onCapture: async (args) => {
        await writeFile(args.path, Buffer.from('blank'))
        return { capture: { path: args.path, width: 100, height: 100, method: 'print', blank: true, clipboardWritten: false, elapsedMs: 5 } }
      },
    })
    const value = await capture({ args: { target: 'active', destinations: 'archive' }, exec: {}, ctx: {}, helper: blanking, dataDir, stateDirectory })
    assert.equal(value.blank, true)
    assert.match(renderCapture(value), /接近纯色/)
  })

  it('reuses the latest hotkey capture without capturing again', { skip: !isWindows }, async () => {
    await resetConfig({ archiveDir: null })
    const { mkdir, writeFile: write } = await import('node:fs/promises')
    await mkdir(stateDirectory, { recursive: true })
    const previous = path.join(stateDirectory, 'previous.png')
    await write(previous, Buffer.from('previous-bytes'))
    await write(path.join(stateDirectory, 'latest.json'), JSON.stringify({
      path: previous,
      width: 900,
      height: 700,
      method: 'print',
      blank: false,
      window: { title: 'notepad', process: 'notepad' },
    }))

    const quiet = new FakeHelper()
    const value = await capture({ args: { target: 'latest', destinations: 'chat' }, exec: {}, ctx: {}, helper: quiet, dataDir, stateDirectory })
    assert.equal(value.reused, true)
    assert.equal(value.path, previous)
    assert.equal(value.width, 900)
    assert.equal(quiet.commands().includes('capture'), false, 'latest must not trigger a new capture')
    assert.equal(value.bytes, 'previous-bytes'.length)
  })

  it('reports a missing latest file instead of a broken result', { skip: !isWindows }, async () => {
    await resetConfig({ archiveDir: null })
    const { mkdir, writeFile: write } = await import('node:fs/promises')
    await mkdir(stateDirectory, { recursive: true })
    const gone = path.join(stateDirectory, 'gone.png')
    await write(path.join(stateDirectory, 'latest.json'), JSON.stringify({ path: gone, width: 10, height: 10 }))
    await assert.rejects(
      capture({ args: { target: 'latest', destinations: 'chat' }, exec: {}, ctx: {}, helper, dataDir, stateDirectory }),
      /已经不在了/,
    )
  })

  it('notes when the clipboard could not be written', { skip: !isWindows }, async () => {
    await resetConfig({ archiveDir: null })
    const stuck = new FakeHelper({
      onCapture: async (args) => {
        await writeFile(args.path, Buffer.from('bytes'))
        return { capture: { path: args.path, width: 10, height: 10, method: 'screen', blank: false, clipboardWritten: false, elapsedMs: 1 } }
      },
    })
    const value = await capture({ args: { target: 'screen', destinations: 'archive,clipboard' }, exec: {}, ctx: {}, helper: stuck, dataDir, stateDirectory })
    assert.equal(value.clipboardWritten, false)
    assert.ok(value.notes.some((note) => note.includes('剪贴板被其他程序占用')))
  })
})

describe('explainCaptureFailure', () => {
  it('maps every stable helper code to guidance', () => {
    for (const code of ['WINDOW_MINIMIZED_UNCAPTURABLE', 'WINDOW_MINIMIZED_BLANK', 'PRINTWINDOW_FAILED', 'WINDOW_NOT_FOUND', 'MONITOR_NOT_FOUND', 'CAPTURE_FAILED', 'FOREGROUND_WINDOW_UNKNOWN']) {
      const message = explainCaptureFailure(new HelperError('raw', code))
      assert.ok(message.length > 10, `${code} must produce a real sentence`)
      assert.notEqual(message, 'raw')
    }
  })

  it('keeps an unknown message rather than inventing one', () => {
    assert.equal(explainCaptureFailure(new HelperError('something odd', 'WHATEVER')), 'something odd')
  })
})

describe('listWindows', () => {
  it('reports the active window first and includes the monitor list', async () => {
    await resetConfig({})
    const value = await listWindows({ args: {}, helper: new FakeHelper(), dataDir })
    assert.equal(value.total, 2)
    assert.equal(value.matched, 2)
    assert.equal(value.windows[0].active, true)
    assert.equal(value.monitors.length, 2)
  })

  it('filters by query and hides minimized windows by default', async () => {
    await resetConfig({})
    const value = await listWindows({ args: { query: 'terminal' }, helper: new FakeHelper(), dataDir })
    assert.equal(value.matched, 0)

    const withMinimized = await listWindows({ args: { query: 'terminal', include_minimized: true }, helper: new FakeHelper(), dataDir })
    assert.equal(withMinimized.matched, 1)
  })

  it('offers real titles when the query matches nothing', async () => {
    await resetConfig({})
    const value = await listWindows({ args: { query: 'zzz' }, helper: new FakeHelper(), dataDir })
    assert.equal(value.matched, 0)
    assert.ok(value.suggestions.length > 0)
    assert.match(renderWindowList(value), /没有窗口匹配/)
  })
})

describe('hotkeyControl', () => {
  const fakeDeps = (overrides = {}) => ({
    startDaemon: async ({ requested }) => ({ ok: true, pid: 4242, combo: requested, requested, fellBack: false, tried: [] }),
    stopDaemon: async () => ({ stopped: true, pid: 4242 }),
    hotkeyStatus: async () => ({ present: true, ready: true, running: true, pid: 4242, combo: 'Ctrl+Shift+A', latest: null, recentEvents: [], tried: [] }),
    readLatest: async () => null,
    ...overrides,
  })

  it('starts, persists the effective settings, and reports the combo', { skip: !isWindows }, async () => {
    await resetConfig({ hotkey: 'Ctrl+Alt+A' })
    const value = await hotkeyControl({
      args: { action: 'start', combo: 'Ctrl+Shift+A' },
      exec: { agent: { session: { header: { cwd: workspace } } } },
      dataDir,
      stateDirectory,
      pluginRoot: 'C:\\plugin',
      deps: fakeDeps(),
    })
    assert.equal(value.running, true)
    assert.equal(value.combo, 'Ctrl+Shift+A')
    assert.equal(value.pid, 4242)

    const saved = JSON.parse(await readFile(path.join(dataDir, 'config.json'), 'utf8'))
    assert.equal(saved.hotkey, 'Ctrl+Shift+A')
    assert.equal(saved.archiveDir, path.join(workspace, 'screenshots'))
    assert.ok(value.notes.some((note) => note.includes('会存到')))
  })

  it('validates the combo before touching the daemon', { skip: !isWindows }, async () => {
    await resetConfig({})
    let started = false
    await assert.rejects(
      hotkeyControl({
        args: { action: 'start', combo: 'A' },
        exec: {},
        dataDir,
        stateDirectory,
        pluginRoot: 'C:\\plugin',
        deps: fakeDeps({ startDaemon: async () => { started = true; return { ok: true } } }),
      }),
      /修饰键/,
    )
    assert.equal(started, false, 'an invalid combo must not reach the daemon')

    const saved = JSON.parse(await readFile(path.join(dataDir, 'config.json'), 'utf8'))
    assert.equal(saved.hotkey, undefined, 'an invalid combo must not be persisted')
  })

  it('explains a taken combo and suggests changing it', { skip: !isWindows }, async () => {
    await resetConfig({})
    const value = await hotkeyControl({
      args: { action: 'start' },
      exec: {},
      dataDir,
      stateDirectory,
      pluginRoot: 'C:\\plugin',
      deps: fakeDeps({
        startDaemon: async () => ({ ok: false, code: 'HOTKEY_REGISTER_FAILED', tried: [{ combo: 'Ctrl+Alt+A', win32: 1409 }] }),
      }),
    })
    assert.equal(value.running, false)
    assert.equal(value.error.code, 'HOTKEY_REGISTER_FAILED')
    assert.ok(value.notes.some((note) => note.includes('Ctrl+Shift+A')))
    assert.match(renderHotkey(value), /没有注册成功|未在运行/)
  })

  it('reports that a fallback combo was used', { skip: !isWindows }, async () => {
    await resetConfig({})
    const value = await hotkeyControl({
      args: { action: 'start', combo: 'Ctrl+Alt+A' },
      exec: {},
      dataDir,
      stateDirectory,
      pluginRoot: 'C:\\plugin',
      deps: fakeDeps({ startDaemon: async () => ({ ok: true, pid: 7, combo: 'Ctrl+Shift+A', requested: 'Ctrl+Alt+A', fellBack: true, tried: [] }) }),
    })
    assert.equal(value.fellBack, true)
    assert.match(renderHotkey(value), /已被其他程序占用/)
  })

  it('stops and says so', { skip: !isWindows }, async () => {
    await resetConfig({})
    const value = await hotkeyControl({ args: { action: 'stop' }, exec: {}, dataDir, stateDirectory, pluginRoot: 'C:\\plugin', deps: fakeDeps() })
    assert.equal(value.running, false)
    assert.equal(value.action, 'stop')
    assert.match(renderHotkey(value), /已停止/)
  })

  it('reports status without starting anything', { skip: !isWindows }, async () => {
    await resetConfig({ hotkey: 'Ctrl+Alt+A' })
    const value = await hotkeyControl({ args: {}, exec: {}, dataDir, stateDirectory, pluginRoot: 'C:\\plugin', deps: fakeDeps() })
    assert.equal(value.action, 'status')
    assert.equal(value.running, true)
  })

  it('rejects an unknown action', { skip: !isWindows }, async () => {
    await resetConfig({})
    await assert.rejects(
      hotkeyControl({ args: { action: 'explode' }, exec: {}, dataDir, stateDirectory, pluginRoot: 'C:\\plugin', deps: fakeDeps() }),
      /未知的 action/,
    )
  })

  it('restarts by stopping first', { skip: !isWindows }, async () => {
    await resetConfig({})
    const order = []
    const deps = fakeDeps({
      stopDaemon: async () => { order.push('stop'); return { stopped: true, pid: 1 } },
      startDaemon: async ({ requested }) => { order.push('start'); return { ok: true, pid: 2, combo: requested, requested, fellBack: false, tried: [] } },
    })
    await hotkeyControl({ args: { action: 'restart' }, exec: {}, dataDir, stateDirectory, pluginRoot: 'C:\\plugin', deps })
    assert.deepEqual(order, ['stop', 'start'])
  })
})

describe('attachImage', () => {
  it('returns null without an attachment service', async () => {
    assert.equal(await attachImage({ ctx: {}, filePath: 'x.png' }), null)
  })

  it('detects jpeg media type by extension', async () => {
    const { mkdir, writeFile: write } = await import('node:fs/promises')
    const file = path.join(tempRoot, 'jpeg-check', 'a.jpg')
    await mkdir(path.dirname(file), { recursive: true })
    await write(file, Buffer.from([0xff, 0xd8, 0xff]))
    let seen = null
    const ctx = { attachments: { saveImages: async (inputs) => { seen = inputs[0]; return [{}] } } }
    await attachImage({ ctx, filePath: file })
    assert.equal(seen.mediaType, 'image/jpeg')
  })
})

describe('renderers', () => {
  it('summarises a capture honestly, including failures', () => {
    const text = renderCapture({
      path: 'D:\\p\\screenshots\\a.png',
      width: 1200,
      height: 800,
      bytes: 2048,
      method: 'screen',
      blank: false,
      elapsedMs: 40,
      target: { description: '「Microsoft Edge」 (msedge) 1200x800', window: { title: 'Microsoft Edge', process: 'msedge' } },
      destinations: { chat: true, clipboard: true, archive: true },
      clipboardWritten: true,
      archived: true,
      imageAttached: true,
      notes: [],
    })
    assert.match(text, /已截图/)
    assert.match(text, /Microsoft Edge/)
    assert.match(text, /已回传给模型/)
    assert.match(text, /已复制到剪贴板/)
    assert.match(text, /已留档/)
    assert.match(text, /2\.0 KB/)
  })

  it('says so when the clipboard write failed', () => {
    const text = renderCapture({
      path: 'a.png',
      width: 1,
      height: 1,
      bytes: 1,
      destinations: { clipboard: true, chat: false, archive: false },
      clipboardWritten: false,
      notes: ['剪贴板被其他程序占用'],
    })
    assert.match(text, /剪贴板写入失败/)
    assert.match(text, /剪贴板被其他程序占用/)
  })

  it('renders the hotkey state for running, stopped and failed daemons', () => {
    assert.match(renderHotkey({ running: true, combo: 'Ctrl+Alt+A', pid: 1 }), /正在运行/)
    // A failure must lead with its reason, not with "not running": the reason is
    // the only actionable part, and the daemon may have died before writing state.
    const failed = renderHotkey({
      running: false,
      present: false,
      error: { code: 'DAEMON_EXITED', message: '启动后立即退出', detail: 'exit=1 signal=null' },
    })
    assert.match(failed, /启动失败：DAEMON_EXITED/)
    assert.match(failed, /启动后立即退出/)
    assert.match(failed, /exit=1/)
    assert.match(renderHotkey({ running: false, present: true }), /未在运行/)
    assert.match(renderHotkey({ running: false, present: false }), /尚未启动/)
    assert.match(
      renderHotkey({ running: false, present: false, tried: [{ combo: 'Ctrl+Alt+A', win32: 1409 }] }),
      /Ctrl\+Alt\+A/,
    )
  })

  it('formats byte sizes without lying about zero', () => {
    assert.equal(formatBytes(0), '大小未知')
    assert.equal(formatBytes(1536), '1.5 KB')
    assert.equal(formatBytes(5 * 1024 * 1024), '5.00 MB')
  })

  it('describes a target from its window when one was resolved', () => {
    assert.equal(targetDescription({ kind: 'window', description: 'window' }, { title: 'Edge', process: 'msedge', width: 10, height: 10 }), '「Edge」 (msedge) 10x10')
    assert.equal(targetDescription({ kind: 'monitor', description: '显示器 #1' }, null), '显示器 #1')
  })
})

describe('composer button capture', () => {
  it('targets the focused window in active mode', async () => {
    const resolved = await resolveComposerTarget({ windows, helper: new FakeHelper(), mode: 'active' })
    assert.equal(resolved.request.kind, 'window')
    assert.equal(resolved.request.handle, 100)
    assert.equal(resolved.fallback, null)
    assert.match(resolved.label, /Microsoft Edge/)
  })

  it('falls back to the pointer monitor when no window is focused', async () => {
    const unfocused = windows.map((window) => ({ ...window, active: false }))
    const helper = new FakeHelper()
    helper.cursorMonitor = { index: 2, x: 900, y: 50 }
    const resolved = await resolveComposerTarget({ windows: unfocused, helper, mode: 'active' })
    assert.deepEqual(resolved.request, { kind: 'monitor', index: 2 })
    assert.equal(resolved.fallback, 'monitor')
  })

  it('falls back to the whole desktop when even the pointer is unresolved', async () => {
    const unfocused = windows.map((window) => ({ ...window, active: false }))
    const helper = new FakeHelper()
    helper.cursorMonitor = { index: -1, x: 0, y: 0 }
    const resolved = await resolveComposerTarget({ windows: unfocused, helper, mode: 'active' })
    assert.deepEqual(resolved.request, { kind: 'screen' })
    assert.equal(resolved.fallback, 'screen')
  })

  it('honours the configured mode', async () => {
    const helper = new FakeHelper()
    assert.equal((await resolveComposerTarget({ windows, helper, mode: 'monitor' })).request.kind, 'monitor')
    assert.equal((await resolveComposerTarget({ windows, helper, mode: 'screen' })).request.kind, 'screen')
  })

  it('archives into the session workspace and returns the bytes', { skip: !isWindows }, async () => {
    await resetConfig({ archiveDir: null })
    const helper = new FakeHelper()
    const shot = await captureForComposer({ helper, dataDir, stateDirectory, cwd: workspace })

    assert.equal(shot.archived, true)
    assert.equal(path.dirname(path.join(workspace, 'screenshots', shot.fileName)), path.join(workspace, 'screenshots'))
    assert.equal(shot.contentType, 'image/png')
    assert.equal(shot.bytes.toString(), 'fake-png-bytes')
    assert.ok(existsSync(path.join(workspace, 'screenshots', shot.fileName)), 'the archive file must exist')
    const captureCall = helper.calls.find((call) => call.cmd === 'capture')
    assert.equal(captureCall.args.clipboard, false, 'clipboard is off by default for composer captures')
  })

  it('uses a scratch file and removes it when archiving is off', { skip: !isWindows }, async () => {
    await resetConfig({ archiveDir: null, composerArchive: false })
    const helper = new FakeHelper()
    const shot = await captureForComposer({ helper, dataDir, stateDirectory, cwd: workspace })
    assert.equal(shot.archived, false)
    assert.ok(shot.path === undefined || shot.path === null)
    assert.equal(existsSync(path.join(stateDirectory, 'tmp', shot.fileName)), false, 'scratch capture must not leak')
  })

  it('explains a helper failure with an actionable message', { skip: !isWindows }, async () => {
    await resetConfig({ archiveDir: null })
    const failing = new FakeHelper({
      onCapture: async () => { throw new HelperError('minimized', 'WINDOW_MINIMIZED_BLANK') },
    })
    await assert.rejects(
      captureForComposer({ helper: failing, dataDir, stateDirectory, cwd: workspace }),
      (error) => {
        assert.equal(error.code, 'WINDOW_MINIMIZED_BLANK')
        assert.match(error.message, /先还原窗口/)
        return true
      },
    )
  })
})

describe('composer capture route', () => {
  const deps = () => ({ helper: new FakeHelper(), dataDir, stateDirectory, cwd: workspace })

  it('rejects anything but POST', async () => {
    await resetConfig({ archiveDir: null })
    const handler = createComposerCaptureHandler(deps())
    const response = await handler(new Request('http://localhost/api/quick-screenshot/capture', { method: 'GET' }))
    assert.equal(response.status, 405)
    assert.equal(response.headers.get('allow'), 'POST')
  })

  it('answers a POST with PNG bytes and capture metadata', { skip: !isWindows }, async () => {
    await resetConfig({ archiveDir: null })
    const handler = createComposerCaptureHandler(deps())
    const response = await handler(
      new Request('http://localhost/api/quick-screenshot/capture?sessionId=s1', { method: 'POST' }),
      { cwd: workspace },
    )

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'image/png')
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('x-capture-archived'), '1')
    assert.ok(decodeURIComponent(response.headers.get('x-capture-file')).endsWith('.png'))
    const bytes = new Uint8Array(await response.arrayBuffer())
    assert.equal(bytes.length, 'fake-png-bytes'.length)
  })

  it('turns a capture failure into a JSON message the button can show', { skip: !isWindows }, async () => {
    await resetConfig({ archiveDir: null })
    const failing = new FakeHelper({
      onCapture: async () => { throw new HelperError('no pixels', 'CAPTURE_FAILED') },
    })
    const handler = createComposerCaptureHandler({ helper: failing, dataDir, stateDirectory, cwd: workspace })
    const response = await handler(new Request('http://localhost/api/quick-screenshot/capture', { method: 'POST' }))

    assert.equal(response.status, 500)
    assert.match(String(response.headers.get('content-type')), /application\/json/)
    const payload = await response.json()
    assert.equal(payload.ok, false)
    assert.equal(payload.code, 'CAPTURE_FAILED')
    assert.match(payload.message, /没有取到任何画面/)
  })
})
