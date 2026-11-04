/**
 * Browser half of dsh-quick-screenshot: the capture button in the composer.
 *
 * Written as a hand-authored module-loader bundle instead of a bundled build.
 * The format is three lines of shell (`window.__ModuleLoader__.load({ id,
 * factory })`) around CommonJS-style code, and the host serves this file
 * verbatim — so this plugin needs no tsdown, no JSX transform, and no build step
 * in the release. `require()` resolves against the shell's frozen module table
 * (`react`, `@deepseek-ai/dsh-client-ui-primitives`, …).
 *
 * What it does: registers one control into `conversation.input.left` (a list
 * slot, session-scoped), asks the host for a capture, and hands the PNG to the
 * composer as a normal file attachment — the same intake path a pasted image
 * takes, so sending, uploading, and durable attachment records all behave
 * exactly like a user-supplied image.
 *
 * A UI plugin must never be able to prevent the app from booting. 0.2.0 proved
 * the point: a single invalid entry in `dsh.client.inject` (a package that only
 * exists as a TypeScript type) stopped the whole Web client from starting. So the
 * factory body is wrapped: any failure at materialization returns an inert module
 * instead of propagating.
 *
 * Watch out for the two unrelated things both called `inject` — mixing them up
 * cost one release each way:
 *
 *  - `dsh.client.inject` (package.json) names *module rows* that must resolve
 *    before this bundle is evaluated. It stays empty; listing a non-existent row
 *    hangs the entire client boot.
 *  - The cordis plugin face's `inject` (the `inject: [...]` below) names
 *    *services* the plugin context may read. Leaving it empty made `ctx.slots`
 *    throw inside apply, so no button appeared at all.
 *
 * @module dsh-quick-screenshot/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-quick-screenshot',
  factory: (require) => {
    // Returned when anything below fails: no button, but a working app.
    const inert = { apply: () => () => {}, inject: [], __test: null }

    try {
      return build(require)
    } catch (error) {
      try {
        console.error('[dsh-quick-screenshot] client bundle failed to initialize; the composer button is unavailable', error)
      } catch {
        // A console that cannot log is not worth crashing the app over.
      }
      return inert
    }

    /** Everything the bundle does, built inside the guard above. */
    function build (require) {
      const React = require('react')
      if (!React || typeof React.createElement !== 'function') {
        throw new Error('react was not available from the shell module table')
      }
      const h = React.createElement

    /** Same-origin, cookie-authenticated capture route registered by the host half. */
    const ENDPOINT = '/api/quick-screenshot/capture'

    /** One stylesheet for the whole bundle, injected once at materialization. */
    const STYLE_ID = 'dsh-quick-screenshot-style'
    const STYLES = `
.dsh-qs-button {
  align-items: center;
  background: transparent;
  border: 0;
  border-radius: 6px;
  color: var(--dsw-alias-menu-icon, currentColor);
  cursor: pointer;
  display: inline-flex;
  flex: 0 0 auto;
  height: 28px;
  justify-content: center;
  opacity: 0.72;
  padding: 0;
  transition: background-color 120ms ease, opacity 120ms ease;
  width: 28px;
}
.dsh-qs-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14)); opacity: 1; }
.dsh-qs-button:focus-visible { outline: 2px solid var(--dsw-alias-focus-ring, #3b82f6); outline-offset: 1px; }
.dsh-qs-button:disabled { cursor: progress; opacity: 0.45; }
.dsh-qs-button[data-error="true"] { color: var(--dsw-alias-danger, #dc2626); opacity: 1; }
.dsh-qs-spin { animation: dsh-qs-spin 900ms linear infinite; transform-origin: 50% 50%; }
@keyframes dsh-qs-spin { to { transform: rotate(360deg); } }
`

    /**
     * Put the stylesheet in the document exactly once.
     *
     * Guarded by id rather than a module-level boolean so a hot-reloaded copy of
     * this bundle cannot stack duplicate rules.
     */
    function ensureStyles () {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = STYLES
      document.head.appendChild(style)
    }

    /** Camera glyph, drawn inline so no icon font or sprite has to be shipped. */
    function Icon (props) {
      return h(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          className: props.spinning ? 'dsh-qs-spin' : undefined,
        },
        h('path', { d: 'M2 5.5h2.2l1-1.6h5.6l1 1.6H14a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-.5.5H2a.5.5 0 0 1-.5-.5v-6a.5.5 0 0 1 .5-.5Z' }),
        h('circle', { cx: 8, cy: 8.8, r: 2.3 }),
      )
    }

    /**
     * Turn one HTTP response into a File the composer can intake.
     *
     * The host answers with image/png bytes; a JSON `{ base64 }` envelope is also
     * accepted, because a transport that refuses binary bodies should degrade to
     * a working button instead of a dead one.
     *
     * @param {Response} response
     * @param {string} fallbackName
     * @returns {Promise<File>}
     */
    async function toFile (response, fallbackName) {
      const type = String(response.headers.get('content-type') ?? '').toLowerCase()
      const stamped = response.headers.get('x-capture-file')
      const name = stamped ? decodeURIComponent(stamped) : fallbackName

      if (type.indexOf('application/json') === 0) {
        const payload = await response.json()
        if (!payload || payload.ok !== true || typeof payload.base64 !== 'string') {
          throw new Error(payload && payload.message ? payload.message : '截图失败')
        }
        const binary = atob(payload.base64)
        const bytes = new Uint8Array(binary.length)
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
        return new File([bytes], name, { type: 'image/png' })
      }

      const blob = await response.blob()
      if (blob.size === 0) throw new Error('截图返回了空文件')
      return new File([blob], name, { type: type.indexOf('image/') === 0 ? type : 'image/png' })
    }

    /**
     * Resolve how a captured file reaches the draft.
     *
     * Two contracts exist for staging a file into the composer, and which one a
     * slot gets depends on where the control is registered:
     *
     *  - A slot whose owner injects `addFiles` (the platform's own composer bar)
     *    hands the control a direct `addFiles(files, directories)` verb.
     *  - `conversation.input.left` is NOT such a slot. Its documented props are
     *    the standard ones (`inputActions`, `useSession`, `sessionId`, …), so the
     *    file has to be staged the way the owner stages a dropped file: allocate a
     *    runtime draft on the `conversation` service, then hand its id to
     *    `inputActions.addAttachments`. `createDrafts` turns an image into a
     *    browser-only draft whose bytes ride along with the prompt, which is
     *    exactly the pasted-image behaviour we want.
     *
     * @param {object} slots slot props
     * @param {object} [service] the `conversation` client service
     * @returns {((file: File) => void) | null} stager, or null when neither exists
     */
    function resolveStaging (slots, service) {
      if (slots && typeof slots.addFiles === 'function') {
        return (file) => slots.addFiles([file], [])
      }

      const actions = slots && slots.inputActions
      const sessionId = slots && slots.sessionId
      const canDraft = service !== undefined && service !== null && typeof service.createDrafts === 'function'
      const canAttach = actions !== undefined && actions !== null && typeof actions.addAttachments === 'function'

      if (!canDraft || !canAttach || typeof sessionId !== 'string' || sessionId.length === 0) return null

      return (file) => {
        const drafts = service.createDrafts(sessionId, [file])
        if (!Array.isArray(drafts) || drafts.length === 0) throw new Error('截图无法登记为草稿')
        if (!actions.addAttachments(drafts.map((draft) => draft.id))) {
          // Admission is mid-flight and refused the ids: hand the drafts back
          // instead of leaving files nobody owns.
          service.releaseDraftAttachments(drafts)
          throw new Error('输入栏正忙，稍后再试')
        }
      }
    }

    /**
     * Capture on the host and stage the result in the composer.
     *
     * Exported for the bundled test suite, which drives it with a stub fetch and
     * stub slot props — the only way to verify this contract without a browser.
     *
     * @param {object} options
     * @param {object} options.slots slot props carrying the intake
     * @param {object} [options.service] the `conversation` client service
     * @param {typeof fetch} [options.fetchImpl]
     * @param {() => number} [options.now]
     */
    async function captureIntoComposer ({ slots, service, fetchImpl, now }) {
      const stage = resolveStaging(slots, service)
      if (stage === null) throw new Error('当前输入栏不支持附件，无法放入截图')

      const doFetch = fetchImpl ?? (typeof fetch === 'function' ? fetch : null)
      if (doFetch === null) throw new Error('当前环境不支持网络请求')

      // The session id lets the host place the archive in the right workspace; a
      // host that cannot resolve it falls back to the configured directory.
      const query = slots && typeof slots.sessionId === 'string' && slots.sessionId.length > 0
        ? `?sessionId=${encodeURIComponent(slots.sessionId)}`
        : ''

      const response = await doFetch(ENDPOINT + query, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { accept: 'image/png' },
      })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        let message = `截图失败（HTTP ${response.status}）`
        try {
          const parsed = JSON.parse(text)
          if (parsed && typeof parsed.message === 'string') message = parsed.message
        } catch {
          if (text.length > 0 && text.length < 200) message = text
        }
        throw new Error(message)
      }

      const stamp = new Date(now ? now() : Date.now()).toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const file = await toFile(response, `screenshot-${stamp}.png`)
      // Staging through the composer's own intake means the ordinary upload queue,
      // byte-progress, ordering, and durable attachment records all apply unchanged.
      stage(file)
      return file
    }

    /** The toolbar control itself. */
    function ScreenshotButton (props) {
      const busyState = React.useState(false)
      const errorState = React.useState(null)
      const busy = busyState[0]
      const setBusy = busyState[1]
      const error = errorState[0]
      const setError = errorState[1]

      const onClick = React.useCallback(async () => {
        if (busy) return
        setBusy(true)
        setError(null)
        try {
          await captureIntoComposer({
            slots: props,
            // Read lazily: cordis rebinds scope per property access, and the
            // service may not be constructed the first time the slot renders.
            service: typeof props.conversationService === 'function' ? props.conversationService() : undefined,
          })
        } catch (failure) {
          setError(failure && failure.message ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }, [busy, props])

      const label = error ?? (busy ? '正在截图…' : '截取窗口并放入输入框')
      return h(
        'button',
        {
          type: 'button',
          className: 'dsh-qs-button',
          title: label,
          'aria-label': label,
          'aria-busy': busy ? 'true' : undefined,
          'data-error': error ? 'true' : undefined,
          disabled: busy,
          // A toolbar press must not move focus out of the draft editor; the
          // platform's own toolbar controls do the same.
          onMouseDown: (event) => { event.preventDefault() },
          onClick,
        },
        h(Icon, { spinning: busy }),
      )
    }

    /**
     * Mount the button into the composer's left-hand control group.
     *
     * `ctx.slots.inject` — not a package-level `dsh.client.inject` entry — is the
     * supported way to wait for the slot to exist. Declaring a dependency that is
     * not a mountable client row is what broke the 0.2.0 boot.
     */
    function apply (ctx) {
      try {
        if (!ctx || !ctx.slots || typeof ctx.slots.register !== 'function') {
          throw new Error('the host did not provide the slot registry')
        }
        ensureStyles()

        const register = () => ctx.slots.register(
          {
            name: 'conversation.input.left',
            id: 'dsh-quick-screenshot',
            // After the platform's own accessory controls (+ / file, modes).
            order: 20,
            label: '截图',
          },
          (props) => (props && props.sessionId
            ? h(ScreenshotButton, {
                ...props,
                // This slot hands out standard props only — no `addFiles` — so the
                // draft has to be created on the conversation service instead.
                conversationService: () => ctx.conversation,
              })
            : null),
        )

        const dispose = typeof ctx.slots.inject === 'function'
          ? ctx.slots.inject('conversation.input.left', register)
          : register()

        if (typeof ctx.effect === 'function') ctx.effect(() => dispose)
        return dispose
      } catch (error) {
        // A missing slot or registry means no button, never a broken composer.
        try {
          console.error('[dsh-quick-screenshot] could not mount the composer button', error)
        } catch {
          // Ignore: nothing to report to.
        }
        return () => {}
      }
    }

    return {
      apply,
      // Services this plugin ctx may read. Both are hard requirements: `slots` is
      // the UI registry, and `conversation` is the service that turns a captured
      // file into a draft attachment. Listing a service here is what makes
      // `ctx.<name>` legal at all — cordis throws
      // `cannot get property "…" without inject` otherwise, which the guard above
      // would turn into a silent no-button.
      inject: ['slots', 'conversation'],
      // Test seams: the bundled suite imports these through the loader stub so it
      // can exercise the capture path without a DOM.
      __test: { captureIntoComposer, toFile, resolveStaging },
    }
    }
  },
})
