/**
 * Unit tests for the pure logic: combo parsing, window ranking, file naming and
 * the JSON-Lines decoder.
 *
 * These deliberately need no Windows desktop and no DSH host — they are the parts
 * that break silently when someone "improves" a heuristic, so they are pinned
 * with examples taken from real window titles on the development machine.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import { ComboError, candidateCombos, formatCombo, parseCombo, virtualKey } from '../lib/combo.js'
import { DEFAULT_CONFIG, loadConfig, normalizeConfig, saveConfig, updateConfig } from '../lib/config.js'
import { LineDecoder, HelperError, buildHelperArgs, isSupportedPlatform, resolvePowerShell } from '../lib/helper-client.js'
import { buildDaemonArgs } from '../lib/hotkey.js'
import {
  ARCHIVE_FOLDER,
  pluginDataDir,
  resolveArchiveDir,
  sanitizeSegment,
  screenshotFileName,
  timestamp,
  uniquePath,
} from '../lib/paths.js'
import {
  TargetError,
  activeWindow,
  normalize,
  parseCaptureTarget,
  pickWindow,
  rankWindows,
  scoreWindow,
  tokenize,
  windowById,
} from '../lib/windows.js'

const realWindows = [
  { id: '5770456', title: '为什么青霉素是药物史最高的山？_哔哩哔哩 - Microsoft Edge', process: 'msedge', width: 2512, height: 1440, monitor: 2, active: true, minimized: false },
  { id: '198012', title: '我想做一个在dsh里可以帮助我 — DeepSeek Harness', process: 'DeepSeek Harness', width: 2488, height: 1600, monitor: 0, active: false, minimized: false },
  { id: '68308', title: '微信', process: 'WeChat', width: 700, height: 1080, monitor: 1, active: false, minimized: false },
  { id: '328426', title: 'QQ', process: 'QQ', width: 674, height: 1080, monitor: 1, active: false, minimized: false },
  { id: '132456', title: 'dsh-pet 桌宠（桌面模式）', process: 'dsh-pet', width: 924, height: 822, monitor: 0, active: false, minimized: false },
  { id: '856256', title: 'cxdownload - 文件资源管理器', process: 'explorer', width: 788, height: 39, monitor: -1, active: false, minimized: true },
]

describe('combo parsing', () => {
  it('parses the documented default', () => {
    const parsed = parseCombo('Ctrl+Alt+A')
    assert.equal(parsed.mods, 3)
    assert.equal(parsed.vk, 65)
    assert.equal(parsed.combo, 'Ctrl+Alt+A')
  })

  it('accepts aliases, any case and any modifier order', () => {
    assert.equal(parseCombo('alt+control+a').combo, 'Ctrl+Alt+A')
    assert.equal(parseCombo('control + shift + s').combo, 'Ctrl+Shift+S')
    assert.equal(parseCombo('Win+Alt+Space').mods, 0x0001 | 0x0008)
  })

  it('maps named keys without relying on the keyboard layout', () => {
    assert.equal(virtualKey('F9'), 120)
    assert.equal(virtualKey('F12'), 123)
    assert.equal(virtualKey('HOME'), 36)
    assert.equal(virtualKey('PAGEDOWN'), 34)
    assert.equal(virtualKey('5'), 53)
    assert.equal(parseCombo('Ctrl+Shift+F9').vk, 120)
  })

  it('refuses a modifier-less combo, which would swallow the key system-wide', () => {
    assert.throws(() => parseCombo('A'), ComboError)
    assert.throws(() => parseCombo('F9'), /修饰键/)
  })

  it('refuses two main keys and unknown keys, naming the offending token', () => {
    assert.throws(() => parseCombo('Ctrl+A+B'), /只能有一个主键/)
    assert.throws(() => parseCombo('Ctrl+Alt+Unknown'), (error) => {
      assert.equal(error.token, 'Unknown')
      return true
    })
  })

  it('round-trips through formatCombo', () => {
    const parsed = parseCombo('Ctrl+Alt+Shift+Win+F5')
    assert.equal(parsed.combo, 'Ctrl+Alt+Shift+Win+F5')
    assert.equal(formatCombo(parsed.mods, parsed.vk), parsed.combo)
  })

  it('builds a de-duplicated candidate list with the request first', () => {
    const candidates = candidateCombos('Ctrl+Shift+A')
    assert.equal(candidates[0].combo, 'Ctrl+Shift+A')
    const keys = candidates.map((entry) => `${entry.mods}:${entry.vk}`)
    assert.equal(new Set(keys).size, keys.length)
    assert.ok(candidates.length > 1, 'a fallback list is what keeps the hotkey alive on a busy machine')
  })

  it('falls back to the defaults when the requested combo is unparseable', () => {
    const candidates = candidateCombos('not-a-combo')
    assert.ok(candidates.length > 0)
    assert.equal(candidates[0].combo, 'Ctrl+Shift+A')
  })
})

describe('window matching', () => {
  it('normalizes case and whitespace only', () => {
    assert.equal(normalize('  Hello   World  '), 'hello world')
    assert.deepEqual(tokenize('WeChat, 微信'), ['wechat', '微信'])
  })

  it('scores an exact title above a prefix above a substring', () => {
    const window = { title: 'WeChat', process: 'wechat' }
    assert.ok(scoreWindow(window, 'WeChat') > scoreWindow(window, 'We'))
    assert.ok(scoreWindow(window, 'We') > scoreWindow({ title: 'xWeChatx' }, 'wechat'))
  })

  it('matches Chinese titles and process names', () => {
    assert.ok(scoreWindow(realWindows[2], '微信') > 0)
    assert.ok(scoreWindow(realWindows[2], 'wechat') > 0)
  })

  it('filters out non-matching windows instead of returning something unrelated', () => {
    const ranked = rankWindows(realWindows, { query: 'nothing-like-this' })
    assert.equal(ranked.length, 0)
  })

  it('puts the active window first for an empty query', () => {
    const ranked = rankWindows(realWindows, { query: '' })
    assert.equal(ranked[0].window.active, true)
  })

  it('drops minimized windows unless asked for them', () => {
    assert.equal(rankWindows(realWindows, { query: 'cxdownload' }).length, 0)
    assert.equal(rankWindows(realWindows, { query: 'cxdownload', includeMinimized: true }).length, 1)
  })

  it('honours the excluded-processes list', () => {
    const ranked = rankWindows(realWindows, { query: '', excludeProcesses: ['WeChat', 'qq'] })
    const processes = ranked.map((entry) => entry.window.process)
    assert.ok(!processes.includes('WeChat'))
    assert.ok(!processes.includes('QQ'))
  })

  it('reports alternatives rather than silently guessing', () => {
    const { best, alternatives } = pickWindow(realWindows, { query: '' })
    assert.ok(best)
    assert.ok(alternatives.length > 0)
    assert.notEqual(alternatives[0].id, best.id)
  })

  it('finds a window by its 64-bit handle string', () => {
    assert.equal(windowById(realWindows, '5770456')?.process, 'msedge')
    assert.equal(windowById(realWindows, 5770456)?.process, 'msedge')
    assert.equal(windowById(realWindows, 'nope'), null)
  })

  it('identifies the focused window', () => {
    assert.equal(activeWindow(realWindows)?.id, '5770456')
  })
})

describe('capture target parsing', () => {
  it('defaults to the active window', () => {
    assert.deepEqual(parseCaptureTarget(''), { kind: 'active', description: '当前活动窗口' })
    assert.equal(parseCaptureTarget(undefined).kind, 'active')
  })

  it('understands the documented keywords', () => {
    assert.equal(parseCaptureTarget('screen').kind, 'screen')
    assert.equal(parseCaptureTarget('desktop').kind, 'screen')
    assert.equal(parseCaptureTarget('latest').kind, 'latest')
    assert.deepEqual(parseCaptureTarget('monitor:2'), { kind: 'monitor', index: 2, description: '显示器 #2' })
    assert.deepEqual(parseCaptureTarget('monitor 0'), { kind: 'monitor', index: 0, description: '显示器 #0' })
  })

  it('parses a region including negative coordinates (a monitor left of the primary one)', () => {
    const target = parseCaptureTarget('region:-1920,-580,1920,1080')
    assert.equal(target.kind, 'region')
    assert.deepEqual(target.rect, { x: -1920, y: -580, width: 1920, height: 1080 })
  })

  it('rejects a region with no area', () => {
    assert.throws(() => parseCaptureTarget('region:0,0,0,100'), TargetError)
  })

  it('treats a bare word as a window search, because that is what people type', () => {
    assert.deepEqual(parseCaptureTarget('Edge'), { kind: 'window', query: 'Edge', description: '窗口「Edge」' })
    assert.equal(parseCaptureTarget('window:微信').query, '微信')
  })

  it('explains a half-written region instead of treating it as a title', () => {
    assert.throws(() => parseCaptureTarget('region'), /x,y,w,h/)
    assert.throws(() => parseCaptureTarget('window:'), TargetError)
  })
})

describe('file naming', () => {
  it('strips characters Windows refuses and collapses separators', () => {
    assert.equal(sanitizeSegment('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j')
    assert.equal(sanitizeSegment('   '), 'capture')
    assert.equal(sanitizeSegment(''), 'capture')
  })

  it('never leaves a trailing dot or space, which Windows would silently drop', () => {
    assert.equal(sanitizeSegment('name.  '), 'name')
    assert.equal(sanitizeSegment('...name...'), 'name')
  })

  it('truncates by code point so a surrogate pair is not split', () => {
    const emoji = '😀'.repeat(30)
    const result = sanitizeSegment(emoji, 5)
    assert.equal(Array.from(result).length, 5)
    assert.ok(!result.includes('\uFFFD'))
  })

  it('builds a sortable, unique-ish name', () => {
    const date = new Date(2026, 10, 5, 1, 2, 3)
    assert.equal(timestamp(date), '20261105_010203')
    assert.equal(screenshotFileName({ label: '微信', date }), '20261105_010203_微信.png')
    assert.equal(screenshotFileName({ label: '微信', date, format: 'jpeg' }), '20261105_010203_微信.jpg')
  })

  it('adds a suffix instead of overwriting a second capture in the same second', () => {
    const taken = new Set(['C:\\shots\\a.png', 'C:\\shots\\a-2.png'])
    assert.equal(uniquePath('C:\\shots\\a.png', (file) => taken.has(file)), 'C:\\shots\\a-3.png')
    assert.equal(uniquePath('C:\\shots\\b.png', (file) => taken.has(file)), 'C:\\shots\\b.png')
  })

  it('resolves the archive directory from the session, the config, or the plugin data dir', () => {
    assert.equal(resolveArchiveDir({ cwd: 'D:\\proj' }), path.join('D:\\proj', ARCHIVE_FOLDER))
    assert.equal(resolveArchiveDir({ configured: 'E:\\shots', cwd: 'D:\\proj' }), path.resolve('E:\\shots'))
    assert.equal(resolveArchiveDir({ env: { DSH_HOME: 'C:\\home' } }), path.join('C:\\home', 'plugin-data', 'dsh-quick-screenshot', 'shots'))
  })

  it('honours DSH_HOME for plugin-private data', () => {
    assert.equal(pluginDataDir({ DSH_HOME: 'C:\\dsh' }), path.join('C:\\dsh', 'plugin-data', 'dsh-quick-screenshot'))
  })
})

describe('json-lines decoder', () => {
  it('reassembles frames split across arbitrary chunk boundaries', () => {
    const decoder = new LineDecoder()
    const raw = '{"id":"1","ok":true,"data":{}}\n{"id":"2","ok":true,"data":{}}\n'
    const frames = []
    for (const character of raw) frames.push(...decoder.push(character))
    assert.equal(frames.length, 2)
    assert.equal(frames[0].id, '1')
  })

  it('handles CRLF and a frame without a trailing newline', () => {
    const decoder = new LineDecoder()
    assert.equal(decoder.push('{"id":"1","ok":true}\r\n').length, 1)
    assert.equal(decoder.push('{"id":"2","ok":true}').length, 0)
    assert.equal(decoder.flushTail(), '{"id":"2","ok":true}')
  })

  it('records unexpected output instead of throwing, so one stray line cannot kill a session', () => {
    const decoder = new LineDecoder()
    assert.equal(decoder.push('WARNING: something\n').length, 0)
    assert.equal(decoder.noise.length, 1)
    assert.equal(decoder.push('{"id":"1","ok":true}\n').length, 1)
  })

  it('keeps the noise buffer bounded', () => {
    const decoder = new LineDecoder()
    for (let index = 0; index < 50; index++) decoder.push(`noise ${index}\n`)
    assert.ok(decoder.noise.length <= 20)
    assert.equal(decoder.noise.at(-1), 'noise 49')
  })

  it('treats a non-object JSON payload as noise', () => {
    const decoder = new LineDecoder()
    assert.equal(decoder.push('{"broken"\n').length, 0)
    assert.equal(decoder.push('[1,2,3]\n').length, 0)
    assert.equal(decoder.noise.length, 2)
  })
})

describe('helper process discovery', () => {
  it('reports the platform gate honestly', () => {
    assert.equal(isSupportedPlatform('win32'), true)
    assert.equal(isSupportedPlatform('darwin'), false)
    assert.equal(isSupportedPlatform('linux'), false)
  })

  it('prefers System32 over PATH so a sandboxed PATH cannot break capture', () => {
    const resolved = resolvePowerShell({ SystemRoot: 'C:\\Windows' })
    assert.match(resolved, /System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/)
  })

  it('carries the helper error code for the caller to translate', () => {
    const error = new HelperError('boom', 'WINDOW_MINIMIZED_BLANK')
    assert.equal(error.code, 'WINDOW_MINIMIZED_BLANK')
    assert.equal(error.name, 'HelperError')
  })

  it('builds the helper argument vector with STA and no profile', () => {
    const args = buildHelperArgs('C:\\p\\host\\helper.ps1', 'C:\\p')
    assert.ok(args.includes('-STA'), 'clipboard access needs a single-threaded apartment')
    assert.ok(args.includes('-NoProfile'), 'a user profile could write to the protocol stream')
    assert.ok(args.includes('-ExecutionPolicy'))
    assert.equal(args[args.indexOf('-File') + 1], 'C:\\p\\host\\helper.ps1')
    assert.equal(args[args.indexOf('-Root') + 1], 'C:\\p')
  })

  it('builds the daemon argument vector, passing hotkeys through a file not inline JSON', () => {
    const args = buildDaemonArgs({
      scriptPath: 'C:\\p\\host\\hotkey.ps1',
      root: 'C:\\p',
      candidatesFile: 'C:\\state\\candidates.json',
      requested: 'Ctrl+Alt+A',
      configPath: 'C:\\data\\config.json',
      stateDir: 'C:\\state',
    })
    assert.ok(args.includes('-CombosFile'))
    assert.ok(!args.some((arg) => arg.includes('"mods"')), 'inline JSON in argv is a quoting trap')
    assert.equal(args[args.indexOf('-Requested') + 1], 'Ctrl+Alt+A')
    assert.equal(args[args.indexOf('-StateDir') + 1], 'C:\\state')
    assert.equal(args[args.indexOf('-File') + 1], 'C:\\p\\host\\hotkey.ps1')
  })
})

describe('configuration', () => {
  const directory = path.join(tmpdir(), `dsh-quick-screenshot-test-${process.pid}`)

  after(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('starts from documented defaults and rejects junk values', () => {
    assert.deepEqual(normalizeConfig({}), { ...DEFAULT_CONFIG })
    const coerced = normalizeConfig({
      hotkey: '   ',
      format: 'webp',
      jpegQuality: 1000,
      maxWidth: -5,
      hotkeyCapture: 'nonsense',
      excludeProcesses: ['ok', 7, '  '],
    })
    assert.equal(coerced.hotkey, DEFAULT_CONFIG.hotkey)
    assert.equal(coerced.format, 'png')
    assert.equal(coerced.jpegQuality, 100)
    assert.equal(coerced.maxWidth, 0)
    assert.equal(coerced.hotkeyCapture, DEFAULT_CONFIG.hotkeyCapture)
    assert.equal(coerced.hotkeyCapture, 'all')
    assert.deepEqual(coerced.excludeProcesses, ['ok'])
  })

  it('round-trips through disk and preserves unset archiveDir as null', async () => {
    await saveConfig(directory, { hotkey: 'Ctrl+Shift+A', archiveDir: null })
    const { config } = await loadConfig(directory)
    assert.equal(config.hotkey, 'Ctrl+Shift+A')
    assert.equal(config.archiveDir, null)
  })

  it('patches without dropping the keys it did not touch', async () => {
    await saveConfig(directory, { hotkey: 'Ctrl+Alt+A', clipboard: false })
    const { config } = await updateConfig(directory, { archiveDir: 'E:\\shots' })
    assert.equal(config.hotkey, 'Ctrl+Alt+A')
    assert.equal(config.clipboard, false)
    assert.equal(config.archiveDir, 'E:\\shots')
  })

  it('survives a corrupt file with defaults plus a warning', async () => {
    await writeFile(path.join(directory, 'config.json'), '{ not json', 'utf8')
    const { config, warning } = await loadConfig(directory)
    assert.equal(config.hotkey, DEFAULT_CONFIG.hotkey)
    assert.match(String(warning), /默认值/)
  })

  it('treats a missing file as defaults without a warning', async () => {
    const empty = path.join(directory, 'empty')
    const { config, warning } = await loadConfig(empty)
    assert.equal(warning, null)
    assert.equal(config.format, 'png')
  })
})
