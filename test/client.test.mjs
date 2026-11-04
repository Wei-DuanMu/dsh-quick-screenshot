/**
 * Tests for the browser half (lib/client.js).
 *
 * The bundle is hand-written and the host serves it verbatim, so a syntax error or
 * a wrong module-loader shape would only surface as "the plugin failed to
 * activate" after a DSH restart. These tests execute the real file in Node with a
 * stubbed `window.__ModuleLoader__`, a stubbed `require`, and a stubbed `fetch`,
 * which is close enough to the browser to catch every failure that matters:
 * format, registration, intake wiring, and the two response shapes.
 */

import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'

const BUNDLE = path.resolve(import.meta.dirname, '..', 'lib', 'client.js')

/**
 * Minimal React stand-in: enough for createElement/useState/useCallback, and it
 * keeps the element tree inspectable so a test can drive `onClick` directly.
 */
function createReactStub () {
  const elements = []
  return {
    elements,
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => [initial, () => {}],
    useCallback: (fn) => fn,
  }
}

/**
 * Load the bundle the way the shell does, and return its factory exports.
 *
 * @param {object} [overrides]
 */
async function loadBundle ({ react, globals = {} } = {}) {
  const captured = []
  const previousWindow = globalThis.window
  const previousGlobals = new Map(Object.keys(globals).map((key) => [key, globalThis[key]]))

  globalThis.window = { __ModuleLoader__: { load: (entry) => captured.push(entry) } }
  for (const [key, value] of Object.entries(globals)) globalThis[key] = value

  try {
    await import(`${pathToFileURL(BUNDLE).href}?t=${Date.now()}-${Math.random()}`)
  } finally {
    globalThis.window = previousWindow
    for (const [key, value] of previousGlobals) {
      if (value === undefined) delete globalThis[key]
      else globalThis[key] = value
    }
  }

  assert.equal(captured.length, 1, 'the bundle must register exactly one module-loader entry')
  const entry = captured[0]
  assert.equal(entry.id, 'dsh-quick-screenshot')
  assert.equal(typeof entry.factory, 'function')

  const reactImpl = react ?? createReactStub()
  const required = []
  const exports = entry.factory((name) => {
    required.push(name)
    if (name === 'react') return reactImpl
    throw new Error(`unexpected require(${name})`)
  })

  return { entry, exports, required, react: reactImpl }
}

describe('client bundle format', () => {
  it('registers under the module-loader contract with the package id', async () => {
    const { entry } = await loadBundle()
    assert.equal(entry.id, 'dsh-quick-screenshot')
    assert.deepEqual(Object.keys(entry).sort(), ['factory', 'id'])
  })

  it('exports apply and declares no module dependencies', async () => {
    const { exports, required } = await loadBundle()
    assert.equal(typeof exports.apply, 'function')
    // An `inject` entry naming something that is not a mountable client row makes
    // the whole client boot wait forever. 0.2.0 shipped one (a package that only
    // exists as a TypeScript type) and bricked the app, so this list stays empty
    // and slot readiness is awaited through ctx.slots.inject instead.
    assert.deepEqual(exports.inject, [])
    // Only React is required at load time; everything else comes through ctx.
    assert.deepEqual(required, ['react'])
  })

  it('declares a platform-only client block, with no inject list', async () => {
    const { readFile } = await import('node:fs/promises')
    const manifest = JSON.parse(await readFile(path.resolve(import.meta.dirname, '..', 'package.json'), 'utf8'))
    assert.equal(manifest.dsh.client.platform, 'web')
    assert.equal(manifest.dsh.client.inject, undefined, 'dsh.client.inject must stay absent')
    assert.equal(manifest.exports['./client'], './lib/client.js')
  })

  it('returns an inert module instead of throwing when a module is unavailable', async () => {
    const captured = []
    const previousWindow = globalThis.window
    globalThis.window = { __ModuleLoader__: { load: (entry) => captured.push(entry) } }
    try {
      await import(`${pathToFileURL(BUNDLE).href}?broken=${Date.now()}`)
    } finally {
      globalThis.window = previousWindow
    }

    // A shell that cannot supply react must yield "no button", never an exception
    // that takes the whole Web client down with it.
    const errors = []
    const originalError = console.error
    console.error = (...args) => errors.push(args)
    try {
      const moduleExports = captured[0].factory(() => { throw new Error('react is not in the table') })
      assert.equal(typeof moduleExports.apply, 'function')
      assert.equal(moduleExports.__test, null)
      assert.equal(typeof moduleExports.apply({}), 'function')
    } finally {
      console.error = originalError
    }
    assert.equal(errors.length, 1, 'the failure should be logged once, not silently swallowed')
  })

  it('is plain CommonJS-compatible code the host can serve without a build', async () => {
    const { readFile } = await import('node:fs/promises')
    const source = await readFile(BUNDLE, 'utf8')
    assert.match(source, /^window\.__ModuleLoader__\.load\(\{/m, 'must start from the loader shell')
    assert.ok(!/\bimport\s+/.test(source), 'must not use ESM import syntax')

    // Strip comments first: JSDoc generics such as `Promise<File>` are not JSX,
    // and a guard that cries wolf gets deleted instead of trusted.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
    assert.ok(
      !/(^|[=(,\[\s])<\s*[A-Za-z][\w.]*[\s/>]/.test(code),
      'must not contain untranspiled JSX',
    )
  })
})

describe('client registration', () => {
  it('registers one session-scoped control into conversation.input.left', async () => {
    const { exports } = await loadBundle()
    const registrations = []
    const injections = []
    const ctx = {
      slots: {
        inject: (name, callback) => { injections.push(name); return callback() },
        register: (options, render) => { registrations.push({ options, render }); return () => {} },
      },
      effect: (fn) => fn(),
    }

    exports.apply(ctx)

    assert.deepEqual(injections, ['conversation.input.left'])
    assert.equal(registrations.length, 1)
    const { options, render } = registrations[0]
    assert.equal(options.name, 'conversation.input.left')
    assert.equal(options.id, 'dsh-quick-screenshot')
    assert.equal(typeof options.order, 'number')
    // Renders nothing without a session: the slot is session-scoped and a
    // sessionless composer has no intake to stage into.
    assert.equal(render({}), null)
    assert.equal(render({ sessionId: undefined }), null)
    assert.ok(render({ sessionId: 's1', addFiles: () => {} }), 'must render for an active session')
  })

  it('returns the disposer so an unload removes the button', async () => {
    const { exports } = await loadBundle()
    let disposed = false
    const ctx = {
      slots: {
        inject: (_name, callback) => callback(),
        register: () => () => { disposed = true },
      },
    }
    const dispose = exports.apply(ctx)
    assert.equal(typeof dispose, 'function')
    dispose()
    assert.equal(disposed, true)
  })

  it('degrades to a no-op when the host provides no slot registry', async () => {
    const { exports } = await loadBundle()
    const errors = []
    const originalError = console.error
    console.error = (...args) => errors.push(args)
    try {
      // A host that does not mount the slot registry must lose the button, not
      // the app.
      const dispose = exports.apply({})
      assert.equal(typeof dispose, 'function')
      assert.doesNotThrow(() => dispose())
      assert.equal(typeof exports.apply(undefined), 'function')
    } finally {
      console.error = originalError
    }
    assert.ok(errors.length >= 1)
  })
})

describe('capture into the composer', () => {
  /** A tiny but real PNG: signature plus IHDR, enough for File/Blob round trips. */
  const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82])

  it('stages the captured PNG through addFiles', async () => {
    const { exports } = await loadBundle()
    const staged = []
    const calls = []

    const fetchImpl = async (url, init) => {
      calls.push({ url, init })
      return new Response(PNG_BYTES, {
        status: 200,
        headers: { 'content-type': 'image/png', 'x-capture-file': encodeURIComponent('微信.png') },
      })
    }

    const file = await exports.__test.captureIntoComposer({
      slots: { sessionId: 'session-1', addFiles: (...args) => staged.push(args) },
      fetchImpl,
    })

    assert.equal(calls.length, 1)
    assert.match(calls[0].url, /^\/api\/quick-screenshot\/capture\?sessionId=session-1$/)
    assert.equal(calls[0].init.method, 'POST')
    assert.equal(calls[0].init.credentials, 'same-origin')

    assert.equal(staged.length, 1, 'exactly one intake call')
    const [files, directories] = staged[0]
    assert.equal(files.length, 1)
    assert.deepEqual(directories, [])
    assert.equal(files[0].name, '微信.png', 'the host-provided filename is preserved')
    assert.equal(files[0].type, 'image/png')
    assert.equal(file.size, PNG_BYTES.length)
  })

  it('omits the session query when the slot gives none', async () => {
    const { exports } = await loadBundle()
    const calls = []
    await exports.__test.captureIntoComposer({
      slots: { addFiles: () => {} },
      fetchImpl: async (url) => {
        calls.push(url)
        return new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } })
      },
    })
    assert.equal(calls[0], '/api/quick-screenshot/capture')
  })

  it('accepts a JSON base64 envelope when the transport refuses binary', async () => {
    const { exports } = await loadBundle()
    const staged = []
    const base64 = Buffer.from(PNG_BYTES).toString('base64')
    await exports.__test.captureIntoComposer({
      slots: { addFiles: (files) => staged.push(files[0]) },
      fetchImpl: async () => new Response(JSON.stringify({ ok: true, base64 }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }),
    })
    assert.equal(staged.length, 1)
    assert.equal(staged[0].size, PNG_BYTES.length)
    assert.equal(staged[0].type, 'image/png')
  })

  it('surfaces the host error message', async () => {
    const { exports } = await loadBundle()
    await assert.rejects(
      exports.__test.captureIntoComposer({
        slots: { addFiles: () => {} },
        fetchImpl: async () => new Response(JSON.stringify({ ok: false, code: 'WINDOW_MINIMIZED_BLANK', message: '目标窗口已最小化' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
      }),
      /目标窗口已最小化/,
    )
  })

  it('explains a missing intake instead of throwing something opaque', async () => {
    const { exports } = await loadBundle()
    await assert.rejects(
      exports.__test.captureIntoComposer({ slots: {}, fetchImpl: async () => new Response('') }),
      /不支持附件/,
    )
  })

  it('refuses an empty body rather than staging a broken file', async () => {
    const { exports } = await loadBundle()
    await assert.rejects(
      exports.__test.captureIntoComposer({
        slots: { addFiles: () => {} },
        fetchImpl: async () => new Response(new Uint8Array(0), { status: 200, headers: { 'content-type': 'image/png' } }),
      }),
      /空文件/,
    )
  })
})
