/**
 * Tests for the browser half: the pure helpers the settings panel is built from,
 * plus the loader contract every client bundle has to honour.
 *
 * The bundle is a classic script (`window.__ModuleLoader__.load`), so it is
 * evaluated in a `vm` context with a stub module table instead of imported.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import vm from 'node:vm'

const bundlePath = path.resolve(import.meta.dirname, '..', 'lib', 'client.js')

/** Load the bundle the way the Web shell does and return its exports. */
function loadBundle () {
  let registration = null
  const sandbox = {
    console,
    document: {
      head: { appendChild: () => {} },
      querySelector: () => null,
      createElement: () => ({ dataset: {}, appendChild: () => {} }),
    },
    window: {
      __ModuleLoader__: {
        load: (value) => { registration = value },
      },
    },
  }
  vm.runInNewContext(readFileSync(bundlePath, 'utf8'), sandbox, { filename: bundlePath })
  assert.ok(registration !== null, 'the bundle should register itself with window.__ModuleLoader__')
  return registration
}

const registration = loadBundle()
const client = registration.factory((specifier) => {
  if (specifier === 'react') {
    return {
      createElement: (type, props, ...children) => ({ type, props, children }),
      useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
      useEffect: () => {},
    }
  }
  throw new Error(`unexpected require: ${specifier}`)
})

test('the bundle registers under the package name with a plugin face', () => {
  assert.equal(registration.id, 'dsh-quick-screenshot')
  assert.equal(typeof client.apply, 'function')
  assert.deepEqual(Array.from(client.inject), ['slots', 'locale'])
})

test('apply registers one settings section and nothing else', () => {
  const effects = []
  const registrations = []
  const injections = []
  const ctx = {
    locale: { bind: (ns) => (key) => `${ns}.${key}`, register: () => () => {} },
    effect: (fn, label) => { effects.push(label); return fn() },
    slots: {
      inject: (name, factory) => { injections.push(name); return factory() },
      register: (options, component) => { registrations.push({ options, component }); return () => true },
    },
  }

  client.apply(ctx)

  assert.deepEqual(injections, ['settings.section'])
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].options.name, 'settings.section')
  assert.equal(registrations[0].options.id, 'quick-screenshot')
  assert.equal(typeof registrations[0].options.label, 'function')
  assert.equal(registrations[0].options.label(), 'quick-screenshot.nav')
  assert.equal(typeof registrations[0].component, 'function')
  assert.equal(effects.length, 1)
})

test('a keydown becomes the notation the daemon parses', () => {
  const combo = client.comboFromKeyboardEvent({ code: 'KeyA', ctrlKey: true, altKey: true, key: 'a' })
  assert.equal(combo, 'Ctrl+Alt+A')
})

test('modifier order is stable and independent of press order', () => {
  const combo = client.comboFromKeyboardEvent({ code: 'KeyS', altKey: true, shiftKey: true, ctrlKey: true, key: 'S' })
  assert.equal(combo, 'Ctrl+Alt+Shift+S')
})

test('digits, F-keys, numpad and named keys all translate', () => {
  const cases = [
    [{ code: 'Digit1', ctrlKey: true, key: '1' }, 'Ctrl+1'],
    [{ code: 'F9', altKey: true, key: 'F9' }, 'Alt+F9'],
    [{ code: 'Numpad5', ctrlKey: true, key: '5' }, 'Ctrl+Numpad5'],
    [{ code: 'ArrowUp', ctrlKey: true, key: 'ArrowUp' }, 'Ctrl+Up'],
    [{ code: 'Space', ctrlKey: true, key: ' ' }, 'Ctrl+Space'],
    [{ code: 'BracketLeft', ctrlKey: true, key: '[' }, 'Ctrl+['],
  ]
  for (const [event, expected] of cases) assert.equal(client.comboFromKeyboardEvent(event), expected)
})

test('a bare key or a bare modifier is refused', () => {
  assert.equal(client.comboFromKeyboardEvent({ code: 'KeyA', key: 'a' }), null)
  assert.equal(client.comboFromKeyboardEvent({ code: 'ControlLeft', ctrlKey: true, key: 'Control' }), null)
  assert.equal(client.comboFromKeyboardEvent({ code: 'Escape', ctrlKey: true, key: 'Escape' }), 'Ctrl+Esc')
  assert.equal(client.comboFromKeyboardEvent({ code: 'Unidentified', ctrlKey: true, key: 'Unidentified' }), null)
  assert.equal(client.comboFromKeyboardEvent(null), null)
})

test('buildPatch sends only the fields the panel owns', () => {
  const patch = client.buildPatch({
    hotkeyEnabled: true,
    hotkey: ' Ctrl+Shift+A ',
    hotkeyCapture: 'current',
    includeCursor: true,
    clipboard: false,
    archiveDir: '  D:\\shots  ',
    somethingElse: 'ignored',
  })
  assert.deepEqual({ ...patch }, {
    hotkeyEnabled: true,
    hotkey: 'Ctrl+Shift+A',
    hotkeyCapture: 'current',
    includeCursor: true,
    clipboard: false,
    archiveDir: 'D:\\shots',
  })
})

test('an empty archive field means "use the project folder"', () => {
  assert.equal(client.buildPatch({ archiveDir: '   ' }).archiveDir, null)
  assert.equal(client.buildPatch({ archiveDir: null }).archiveDir, null)
})

test('booleans default to off when the draft is missing them', () => {
  const patch = client.buildPatch({})
  assert.equal(patch.hotkeyEnabled, false)
  assert.equal(patch.includeCursor, false)
  assert.equal(patch.clipboard, false)
})

test('draftFromView tolerates a shell that answered with nothing', () => {
  const draft = client.draftFromView(null)
  assert.equal(draft.hotkeyEnabled, true)
  assert.equal(draft.hotkey, '')
  assert.equal(draft.hotkeyCapture, 'all')
  assert.equal(draft.archiveDir, '')
})

test('draftFromView keeps what the host reported', () => {
  const draft = client.draftFromView({
    settings: { hotkeyEnabled: false, hotkey: 'Ctrl+Shift+S', hotkeyCapture: 'app', includeCursor: true, clipboard: false, archiveDir: 'D:\\shots' },
  })
  assert.deepEqual({ ...draft }, {
    hotkeyEnabled: false,
    hotkey: 'Ctrl+Shift+S',
    hotkeyCapture: 'app',
    includeCursor: true,
    clipboard: false,
    archiveDir: 'D:\\shots',
  })
})

test('the hotkey line explains each state', () => {
  assert.equal(client.describeHotkey(null).tone, 'off')
  assert.equal(client.describeHotkey({ settings: { hotkeyEnabled: false } }).tone, 'off')
  assert.equal(client.describeHotkey({ settings: { hotkeyEnabled: false } }).text, '已关闭，快捷键未占用。')

  const running = client.describeHotkey({
    settings: { hotkeyEnabled: true },
    hotkey: { running: true, combo: 'Ctrl+Shift+A', pid: 42 },
  })
  assert.equal(running.tone, 'on')
  assert.match(running.text, /Ctrl\+Shift\+A/)
  assert.match(running.text, /42/)

  const failed = client.describeHotkey({
    settings: { hotkeyEnabled: true },
    hotkey: { running: false, error: '组合键被占用' },
  })
  assert.equal(failed.tone, 'error')
  assert.match(failed.text, /组合键被占用/)

  const unsupported = client.describeHotkey({ settings: { hotkeyEnabled: true }, platform: { supported: false } })
  assert.match(unsupported.text, /Windows/)
})
