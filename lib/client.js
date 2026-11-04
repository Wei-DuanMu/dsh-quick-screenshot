/**
 * Browser half: the plugin's panel under Settings → Integrations.
 *
 * The panel owns nothing: it reads and writes the host half's `config.json`
 * through one same-origin route, so the daemon (which re-reads that file on every
 * press) and this UI can never disagree. Turning the master switch off is applied
 * by the host, which unregisters the global hotkey for real.
 *
 * Written as a plain `window.__ModuleLoader__.load` factory — the client runtime
 * loads plugin bundles as classic scripts, so this file must not use `import`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-quick-screenshot',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var h = React.createElement

    /** Same-origin, cookie-authenticated route registered by the host half. */
    var ENDPOINT = '/api/quick-screenshot/settings'

    /** Dictionary namespace owned by this plugin. */
    var NS = 'quick-screenshot'

    var CLASS = {
      section: 'dshQs_section',
      heading: 'dshQs_heading',
      intro: 'dshQs_intro',
      card: 'dshQs_card',
      row: 'dshQs_row',
      rowMain: 'dshQs_rowMain',
      label: 'dshQs_label',
      hint: 'dshQs_hint',
      control: 'dshQs_control',
      input: 'dshQs_input',
      inputNarrow: 'dshQs_inputNarrow',
      select: 'dshQs_select',
      checkbox: 'dshQs_checkbox',
      button: 'dshQs_button',
      buttonGhost: 'dshQs_buttonGhost',
      footer: 'dshQs_footer',
      status: 'dshQs_status',
      statusError: 'dshQs_statusError',
      statusOk: 'dshQs_statusOk',
      badge: 'dshQs_badge',
      badgeOn: 'dshQs_badgeOn',
      badgeOff: 'dshQs_badgeOff',
      note: 'dshQs_note',
    }

    var CSS = [
      '.dshQs_section{max-width:760px;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary)}',
      '.dshQs_heading{margin:0;font-size:18px;font-weight:600}',
      '.dshQs_intro{margin:0;font-size:13px;color:var(--dsw-alias-label-tertiary)}',
      '.dshQs_card{display:flex;flex-direction:column;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;overflow:hidden}',
      '.dshQs_row{display:flex;align-items:flex-start;gap:16px;padding:12px 14px;border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.dshQs_row:first-child{border-top:0}',
      '.dshQs_rowMain{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1 1 auto}',
      '.dshQs_label{font-size:13px;line-height:20px}',
      '.dshQs_hint{font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary)}',
      '.dshQs_control{display:flex;align-items:center;gap:8px;flex:0 0 auto}',
      '.dshQs_input{font:inherit;font-size:13px;box-sizing:border-box;padding:4px 8px;height:28px;min-width:200px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-primary);border:.5px solid var(--dsw-alias-border-l2);border-radius:6px}',
      '.dshQs_input:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
      '.dshQs_inputNarrow{min-width:0;width:170px;text-align:center;letter-spacing:.5px}',
      '.dshQs_select{font:inherit;font-size:13px;height:28px;padding:2px 6px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-primary);border:.5px solid var(--dsw-alias-border-l2);border-radius:6px}',
      '.dshQs_checkbox{width:16px;height:16px;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer}',
      '.dshQs_button{font:inherit;font-size:13px;height:28px;padding:0 12px;border-radius:6px;cursor:pointer;color:var(--dsw-alias-bg-primary);background:var(--dsw-alias-label-primary);border:0}',
      '.dshQs_button[disabled]{opacity:.5;cursor:default}',
      '.dshQs_buttonGhost{font:inherit;font-size:13px;height:28px;padding:0 10px;border-radius:6px;cursor:pointer;color:var(--dsw-alias-label-primary);background:0 0;border:.5px solid var(--dsw-alias-border-l2)}',
      '.dshQs_footer{display:flex;align-items:center;gap:10px}',
      '.dshQs_status{font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary);min-height:17px}',
      '.dshQs_statusOk{color:var(--dsw-alias-state-success-primary,#2e7d32)}',
      '.dshQs_statusError{color:var(--dsw-alias-state-error-primary,#c62828)}',
      '.dshQs_badge{display:inline-flex;align-items:center;gap:5px;font-size:12px;padding:1px 7px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2)}',
      '.dshQs_badgeOn{color:var(--dsw-alias-state-success-primary,#2e7d32)}',
      '.dshQs_badgeOff{color:var(--dsw-alias-label-tertiary)}',
      '.dshQs_note{margin:0;font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary)}',
    ].join('')

    /** Inject the stylesheet once, keyed so a reload replaces rather than stacks. */
    function injectStyle () {
      if (typeof document === 'undefined' || !document.head) return
      var tagId = 'dsh-quick-screenshot/settings.css'
      if (document.querySelector('style[data-plugin-css="' + tagId + '"]') !== null) return
      var tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-quick-screenshot'
      tag.dataset.pluginCss = tagId
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ---- pure helpers (unit-tested without a browser) ----------------------

    var CODE_NAMES = {
      Backspace: 'Backspace',
      Tab: 'Tab',
      Enter: 'Enter',
      Escape: 'Esc',
      Space: 'Space',
      PageUp: 'PageUp',
      PageDown: 'PageDown',
      End: 'End',
      Home: 'Home',
      ArrowLeft: 'Left',
      ArrowUp: 'Up',
      ArrowRight: 'Right',
      ArrowDown: 'Down',
      Insert: 'Insert',
      Delete: 'Delete',
      Minus: 'Minus',
      Equal: '=',
      BracketLeft: '[',
      BracketRight: ']',
      Semicolon: ';',
      Quote: "'",
      Comma: ',',
      Period: '.',
      Slash: '/',
      Backslash: '\\',
      Backquote: '`',
    }

    /**
     * Translate a browser keydown into the notation `parseCombo` accepts.
     *
     * Returns null when the press cannot be a global hotkey: a bare modifier, a
     * key with no modifier (that would swallow the key system-wide), or a key the
     * grammar does not know.
     *
     * @param {object} event keydown event (or anything with code/ctrlKey/…)
     * @returns {string|null}
     */
    function comboFromKeyboardEvent (event) {
      if (event === null || typeof event !== 'object') return null
      var code = typeof event.code === 'string' ? event.code : ''
      var parts = []
      if (event.ctrlKey === true) parts.push('Ctrl')
      if (event.altKey === true) parts.push('Alt')
      if (event.shiftKey === true) parts.push('Shift')
      if (event.metaKey === true) parts.push('Win')

      var key = null
      var letter = /^Key([A-Z])$/.exec(code)
      var digit = /^Digit([0-9])$/.exec(code)
      var fkey = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code)
      var numpad = /^Numpad([0-9])$/.exec(code)
      if (letter !== null) key = letter[1]
      else if (digit !== null) key = digit[1]
      else if (fkey !== null) key = 'F' + fkey[1]
      else if (numpad !== null) key = 'Numpad' + numpad[1]
      else if (Object.prototype.hasOwnProperty.call(CODE_NAMES, code)) key = CODE_NAMES[code]

      if (key === null) return null
      // A modifier-only press arrives as the modifier's own key code.
      if (['Control', 'Alt', 'Shift', 'Meta'].indexOf(event.key) >= 0) return null
      if (parts.length === 0) return null
      parts.push(key)
      return parts.join('+')
    }

    /**
     * Turn the form draft into the patch the host accepts.
     *
     * Only these keys are ever sent: the route ignores anything else, and the
     * panel must not be able to rewrite settings it does not show.
     *
     * @param {object} draft
     * @returns {object}
     */
    function buildPatch (draft) {
      var patch = {
        hotkeyEnabled: draft.hotkeyEnabled === true,
        hotkey: String(draft.hotkey == null ? '' : draft.hotkey).trim(),
        hotkeyCapture: String(draft.hotkeyCapture == null ? '' : draft.hotkeyCapture),
        includeCursor: draft.includeCursor === true,
        clipboard: draft.clipboard === true,
      }
      var archive = draft.archiveDir == null ? '' : String(draft.archiveDir).trim()
      patch.archiveDir = archive.length === 0 ? null : archive
      return patch
    }

    /** Draft state from a server view, so a refresh never loses unsaved edits silently. */
    function draftFromView (view) {
      var settings = (view && view.settings) || {}
      return {
        hotkeyEnabled: settings.hotkeyEnabled !== false,
        hotkey: typeof settings.hotkey === 'string' ? settings.hotkey : '',
        hotkeyCapture: typeof settings.hotkeyCapture === 'string' ? settings.hotkeyCapture : 'all',
        includeCursor: settings.includeCursor === true,
        clipboard: settings.clipboard !== false,
        archiveDir: typeof settings.archiveDir === 'string' ? settings.archiveDir : '',
      }
    }

    /**
     * One line describing whether the global hotkey is actually registered.
     *
     * @param {object} view server view
     */
    function describeHotkey (view) {
      var hotkey = (view && view.hotkey) || {}
      var enabled = !view || !view.settings || view.settings.hotkeyEnabled !== false
      if (view && view.platform && view.platform.supported === false) {
        return { text: '全局快捷键只支持 Windows。', tone: 'off' }
      }
      if (!enabled) return { text: '已关闭，快捷键未占用。', tone: 'off' }
      if (hotkey.error) return { text: '注册失败：' + hotkey.error, tone: 'error' }
      if (hotkey.running) {
        return {
          text: '正在监听 ' + (hotkey.combo || '—') + (hotkey.pid ? '（进程 ' + hotkey.pid + '）' : ''),
          tone: 'on',
        }
      }
      return { text: '未在监听，保存后会自动注册。', tone: 'off' }
    }

    // ---- data access -------------------------------------------------------

    /**
     * Call the host route.
     *
     * @param {typeof fetch} doFetch
     * @param {string} method
     * @param {object} [body]
     */
    async function requestJson (doFetch, method, body) {
      var options = { method: method, credentials: 'same-origin', headers: { accept: 'application/json' } }
      if (body !== undefined) {
        options.headers['content-type'] = 'application/json'
        options.body = JSON.stringify(body)
      }
      var response = await doFetch(ENDPOINT, options)
      var text = await response.text()
      var payload = null
      if (text.length > 0) {
        try {
          payload = JSON.parse(text)
        } catch {
          payload = null
        }
      }
      if (!response.ok) {
        var message = (payload && payload.message) || ('请求失败（HTTP ' + response.status + '）')
        var error = new Error(message)
        error.field = payload && payload.field ? payload.field : null
        throw error
      }
      if (payload === null) throw new Error('设置服务返回了无法解析的内容。')
      return payload
    }

    // ---- the panel ---------------------------------------------------------

    /** Settings section: the plugin's switch, hotkey, capture mode and archive. */
    function QuickScreenshotSettings (props) {
      // `t` arrives only when the section declares `locale`; fall back to the
      // Chinese dictionary so a shell that skips that still renders a panel.
      var t = typeof props.t === 'function'
        ? props.t
        : function (key) { return zh[key] || key }
      var [view, setView] = React.useState(null)
      var [draft, setDraft] = React.useState(null)
      var [busy, setBusy] = React.useState(false)
      var [capturing, setCapturing] = React.useState(false)
      var [status, setStatus] = React.useState(null)

      function adopt (next) {
        setView(next)
        setDraft(draftFromView(next))
        setStatus(null)
      }

      React.useEffect(function () {
        var cancelled = false
        var doFetch = typeof fetch === 'function' ? fetch : null
        if (doFetch === null) {
          setStatus({ tone: 'error', text: '当前环境不支持网络请求，无法读写设置。' })
          return function () {}
        }
        requestJson(doFetch, 'GET')
          .then(function (next) { if (!cancelled) adopt(next) })
          .catch(function (error) {
            if (!cancelled) setStatus({ tone: 'error', text: '读取设置失败：' + error.message })
          })
        return function () { cancelled = true }
      }, [])

      // Capture the next combination from the keyboard while the field is armed.
      React.useEffect(function () {
        if (!capturing || typeof window === 'undefined' || !window.addEventListener) return function () {}
        function onKeyDown (event) {
          event.preventDefault()
          event.stopPropagation()
          if (event.key === 'Escape') {
            setCapturing(false)
            return
          }
          var combo = comboFromKeyboardEvent(event)
          if (combo === null) return
          setCapturing(false)
          edit('hotkey', combo, 'now')
        }
        window.addEventListener('keydown', onKeyDown, true)
        return function () { window.removeEventListener('keydown', onKeyDown, true) }
      }, [capturing])

      // Controls write through immediately: the panel tells the user changes save
      // themselves, so a select that only changed local state would be a lie. Text
      // fields debounce instead, and the hotkey field waits for blur or a recording,
      // because a half-typed combination is invalid by definition.
      var pendingTimer = React.useRef(null)

      function cancelPending () {
        if (pendingTimer.current !== null) {
          clearTimeout(pendingTimer.current)
          pendingTimer.current = null
        }
      }

      React.useEffect(function () { return cancelPending }, [])

      function edit (field, value, behaviour) {
        var next = Object.assign({}, draft)
        next[field] = value
        setDraft(next)
        if (behaviour === 'now') {
          cancelPending()
          save(next)
        }
        else if (behaviour === 'later') {
          cancelPending()
          pendingTimer.current = setTimeout(function () {
            pendingTimer.current = null
            save(next)
          }, 500)
        }
      }

      function save (nextDraft) {
        cancelPending()
        var target = nextDraft || draft
        var doFetch = typeof fetch === 'function' ? fetch : null
        if (doFetch === null) {
          setStatus({ tone: 'error', text: '当前环境不支持网络请求，无法保存。' })
          return
        }
        var patch = buildPatch(target)
        if (Object.keys(patch).length === 0) {
          setStatus({ tone: 'ok', text: '已是最新。' })
          return
        }
        setBusy(true)
        setStatus({ tone: 'pending', text: '保存中…' })
        requestJson(doFetch, 'POST', patch)
          .then(function (next) {
            adopt(next)
            var notes = Array.isArray(next.notes) ? next.notes : []
            if (next.hotkey && next.hotkey.error) {
              setStatus({ tone: 'error', text: next.hotkey.error })
            } else {
              setStatus({ tone: 'ok', text: notes.join(' ') || '已保存。' })
            }
          })
          .catch(function (error) {
            setStatus({ tone: 'error', text: '保存失败：' + error.message })
          })
          .then(function () { setBusy(false) })
      }

      if (draft === null) {
        var loadingText = status && status.text ? status.text : '正在读取设置…'
        return h('div', { className: CLASS.section }, [
          h('h2', { key: 'heading', className: CLASS.heading }, t('title')),
          h('p', { key: 'status', className: CLASS.note }, loadingText),
        ])
      }

      var hotkeyState = describeHotkey(Object.assign({}, view, { settings: { hotkeyEnabled: draft.hotkeyEnabled } }))
      var choices = (view && Array.isArray(view.choices) && view.choices.length > 0)
        ? view.choices
        : [{ value: 'all', label: '全部屏幕' }]
      var defaults = (view && view.defaults) || {}
      var disabled = draft.hotkeyEnabled !== true

      function row (key, label, hint, control) {
        return h('div', { key: key, className: CLASS.row }, [
          h('div', { key: 'main', className: CLASS.rowMain }, [
            h('span', { key: 'label', className: CLASS.label }, label),
            hint === null ? null : h('span', { key: 'hint', className: CLASS.hint }, hint),
          ]),
          h('div', { key: 'control', className: CLASS.control }, control),
        ])
      }

      return h('div', { className: CLASS.section }, [
        h('h2', { key: 'heading', className: CLASS.heading }, t('title')),
        h('p', { key: 'intro', className: CLASS.intro }, t('intro')),
        h('div', { key: 'card', className: CLASS.card }, [
          row('enabled', '启用全局快捷键', '关闭后立即注销快捷键，组合键归还给系统；三个截图工具仍可用。',
            h('input', {
              className: CLASS.checkbox,
              type: 'checkbox',
              checked: draft.hotkeyEnabled,
              onChange: function (event) { edit('hotkeyEnabled', event.target.checked, 'now') },
            })),
          row('hotkey', '快捷键',
            h('span', { className: CLASS.hint }, [
              h('span', {
                key: 'badge',
                className: CLASS.badge + ' ' + (hotkeyState.tone === 'on' ? CLASS.badgeOn : CLASS.badgeOff),
              }, hotkeyState.text),
              h('br', { key: 'br' }),
              capturing ? '请按下组合键（Esc 取消）' : '点「录制」后再按键；也可以直接输入，例如 Ctrl+Alt+A。',
            ]),
            [
              h('input', {
                key: 'input',
                className: CLASS.input + ' ' + CLASS.inputNarrow,
                type: 'text',
                value: draft.hotkey,
                'aria-label': '快捷键',
                onChange: function (event) { edit('hotkey', event.target.value) },
                onBlur: function () { save() },
                onKeyDown: function (event) { if (event.key === 'Enter') save() },
              }),
              h('button', {
                key: 'record',
                type: 'button',
                className: CLASS.buttonGhost,
                disabled: disabled,
                onClick: function () { setCapturing(!capturing) },
              }, capturing ? '按键…' : '录制'),
            ]),
          row('mode', '截图模式', '快捷键按下时截取的范围；工具调用可以用 target 参数覆盖。',
            h('select', {
              className: CLASS.select,
              value: draft.hotkeyCapture,
              'aria-label': '截图模式',
              onChange: function (event) { edit('hotkeyCapture', event.target.value, 'now') },
            }, choices.map(function (choice, index) {
              return h('option', { key: 'choice-' + index, value: choice.value }, choice.label)
            }))),
          row('cursor', '包含鼠标指针', '把指针画进画面；某些窗口的截图会显示成默认箭头。',
            h('input', {
              className: CLASS.checkbox,
              type: 'checkbox',
              checked: draft.includeCursor,
              onChange: function (event) { edit('includeCursor', event.target.checked, 'now') },
            })),
          row('clipboard', '复制到剪贴板', '每次截图后直接粘贴可用。',
            h('input', {
              className: CLASS.checkbox,
              type: 'checkbox',
              checked: draft.clipboard,
              onChange: function (event) { edit('clipboard', event.target.checked, 'now') },
            })),
          row('archive', '保存目录', h('span', { className: CLASS.hint }, [
            '留空则存进当前项目。默认：' + String(defaults.archiveDir || ''),
          ]), [
            h('input', {
              key: 'input',
              className: CLASS.input,
              type: 'text',
              value: draft.archiveDir,
              placeholder: '留空 = 当前项目',
              'aria-label': '保存目录',
              onChange: function (event) { edit('archiveDir', event.target.value, 'later') },
              onBlur: function () { save() },
            }),
            h('button', {
              key: 'reset',
              type: 'button',
              className: CLASS.buttonGhost,
              onClick: function () { edit('archiveDir', '', 'now') },
            }, '默认'),
          ]),
        ]),
        h('div', { key: 'footer', className: CLASS.footer }, [
          h('button', {
            key: 'save',
            type: 'button',
            className: CLASS.button,
            disabled: busy,
            onClick: save,
          }, busy ? '保存中…' : '保存'),
          h('span', {
            key: 'status',
            className: CLASS.status + ' ' + (status && status.tone === 'error'
              ? CLASS.statusError
              : status && status.tone === 'ok' ? CLASS.statusOk : ''),
          }, status && status.text ? status.text : ''),
        ]),
      ])
    }

    /** Dictionary bundles, so the section label follows the UI language. */
    var en = { nav: 'Quick screenshot', title: 'Quick screenshot', intro: 'Global screenshot hotkey and capture behaviour. Changes save immediately; the switch registers or unregisters the hotkey.' }
    var zh = { nav: '快截图', title: '快截图', intro: '全局截图快捷键与截图行为。改动即时保存；开关会真正注册或注销快捷键。' }

    /** Required services (cordis fiber inject). */
    var inject = ['slots', 'locale']

    /**
     * Mount the settings section.
     *
     * @param {object} ctx the browser plugin context
     */
    function apply (ctx) {
      injectStyle()
      var t = ctx.locale.bind(NS)
      // A failing client half can take the whole Web UI down, so every step is
      // contained: the worst case is a missing panel, never a broken boot.
      try {
        ctx.effect(function () {
          return ctx.locale.register(NS, { zh: zh, en: en })
        }, 'dsh-quick-screenshot: settings dictionaries')
      } catch (error) {
        console.warn('[dsh-quick-screenshot] locale registration failed', error)
      }
      try {
        ctx.slots.inject('settings.section', function () {
          return ctx.slots.register({
            name: 'settings.section',
            id: 'quick-screenshot',
            order: 40,
            label: function () { return t('nav') },
            locale: NS,
          }, QuickScreenshotSettings)
        })
      } catch (error) {
        console.warn('[dsh-quick-screenshot] settings section registration failed', error)
      }
    }

    exports.apply = apply
    exports.inject = inject
    exports.comboFromKeyboardEvent = comboFromKeyboardEvent
    exports.buildPatch = buildPatch
    exports.draftFromView = draftFromView
    exports.describeHotkey = describeHotkey
    exports.ENDPOINT = ENDPOINT
    return module.exports
  },
})
