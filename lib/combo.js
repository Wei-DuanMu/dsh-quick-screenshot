/**
 * Hotkey notation: the one place that knows how "Ctrl+Alt+A" becomes the Win32
 * modifier bitmask and virtual-key code that RegisterHotKey expects.
 *
 * The PowerShell daemon receives already-parsed numbers, so there is exactly one
 * implementation of this grammar and it is unit-testable without Windows.
 *
 * @module dsh-quick-screenshot/combo
 */

/** Win32 MOD_* values. */
export const MOD_ALT = 0x0001
export const MOD_CONTROL = 0x0002
export const MOD_SHIFT = 0x0004
export const MOD_WIN = 0x0008

/** Preferred combo, then the fallbacks tried when another app already owns it. */
export const DEFAULT_COMBO = 'Ctrl+Alt+A'

/**
 * Fallbacks, in order.
 *
 * Deliberately not a single combo: on a real machine several `Ctrl+Alt+<letter>`
 * combinations are already claimed by vendor overlays and chat apps (measured on
 * the development host: Ctrl+Alt+A/X/Q/P/E/Z were all taken), so a plugin that
 * only knows how to ask for one of them is dead on arrival.
 */
export const FALLBACK_COMBOS = [
  'Ctrl+Shift+A',
  'Ctrl+Alt+S',
  'Ctrl+Alt+D',
  'Ctrl+Shift+S',
  'Ctrl+Shift+X',
  'Ctrl+Alt+F9',
]

/** Named keys beyond letters, digits and F-keys. */
const NAMED_KEYS = new Map(Object.entries({
  BACKSPACE: 8,
  TAB: 9,
  ENTER: 13,
  RETURN: 13,
  PAUSE: 19,
  CAPSLOCK: 20,
  ESC: 27,
  ESCAPE: 27,
  SPACE: 32,
  PAGEUP: 33,
  PRIOR: 33,
  PAGEDOWN: 34,
  NEXT: 34,
  END: 35,
  HOME: 36,
  LEFT: 37,
  UP: 38,
  RIGHT: 39,
  DOWN: 40,
  PRINTSCREEN: 44,
  SNAPSHOT: 44,
  INSERT: 45,
  DELETE: 46,
  DEL: 46,
  MINUS: 189,
  '=': 187,
  EQUALS: 187,
  '[': 219,
  ']': 221,
  ';': 186,
  "'": 222,
  ',': 188,
  '.': 190,
  '/': 191,
  '\\': 220,
  '`': 192,
  OEM_MINUS: 189,
  OEM_PLUS: 187,
  OEM_4: 219,
  OEM_6: 221,
  OEM_1: 186,
  OEM_7: 222,
  OEM_COMMA: 188,
  OEM_PERIOD: 190,
  OEM_2: 191,
  OEM_5: 220,
  OEM_3: 192,
}))

/** A parse failure that carries the offending token for the message. */
export class ComboError extends Error {
  constructor (message, token) {
    super(message)
    this.name = 'ComboError'
    this.token = token
  }
}

/**
 * Resolve one non-modifier token to a virtual-key code.
 *
 * @param {string} token upper-cased key name
 * @returns {number|null}
 */
export function virtualKey (token) {
  if (token.length === 1) {
    const code = token.charCodeAt(0)
    // A-Z
    if (code >= 65 && code <= 90) return code
    // 0-9
    if (code >= 48 && code <= 57) return code
  }
  if (/^F([1-9]|1\d|2[0-4])$/.test(token)) return 111 + Number(token.slice(1))
  if (/^NUMPAD[0-9]$/.test(token)) return 96 + Number(token.slice(6))
  const named = NAMED_KEYS.get(token)
  if (named !== undefined) return named
  return null
}

/**
 * Parse "Ctrl+Alt+A" into `{ combo, mods, vk }`.
 *
 * Requires at least one modifier: a bare key would swallow that key for every
 * application on the machine, which is not a screenshot tool, it is malware.
 *
 * @param {string} input
 * @returns {{ combo: string, mods: number, vk: number }}
 * @throws {ComboError}
 */
export function parseCombo (input) {
  const text = String(input ?? '').trim()
  if (text.length === 0) throw new ComboError('快捷键不能为空', '')

  const tokens = text
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)

  if (tokens.length < 2) throw new ComboError(`快捷键「${text}」至少需要一个修饰键加一个主键，例如 Ctrl+Alt+A`, text)

  let mods = 0
  let vk = null
  let keyToken = null

  for (const raw of tokens) {
    const token = raw.toUpperCase()
    if (token === 'CTRL' || token === 'CONTROL') { mods |= MOD_CONTROL; continue }
    if (token === 'ALT') { mods |= MOD_ALT; continue }
    if (token === 'SHIFT') { mods |= MOD_SHIFT; continue }
    if (token === 'WIN' || token === 'WINDOWS' || token === 'META' || token === 'SUPER') { mods |= MOD_WIN; continue }

    const resolved = virtualKey(token)
    if (resolved === null) throw new ComboError(`无法识别的按键「${raw}」；可用字母、数字、F1-F24 或常见键名（Space/Tab/Home/End/Insert/Delete/方向键等）`, raw)
    if (vk !== null) throw new ComboError(`快捷键「${text}」只能有一个主键，但出现了「${keyToken}」和「${raw}」`, raw)
    vk = resolved
    keyToken = raw
  }

  if (vk === null) throw new ComboError(`快捷键「${text}」缺少主键，例如 Ctrl+Alt+A`, text)
  if (mods === 0) throw new ComboError(`快捷键「${text}」必须包含 Ctrl/Alt/Shift/Win 中至少一个修饰键`, text)

  return { combo: formatCombo(mods, vk), mods, vk }
}

/**
 * Render modifier bits and a virtual key back as canonical notation.
 *
 * @param {number} mods
 * @param {number} vk
 */
export function formatCombo (mods, vk) {
  const parts = []
  if (mods & MOD_CONTROL) parts.push('Ctrl')
  if (mods & MOD_ALT) parts.push('Alt')
  if (mods & MOD_SHIFT) parts.push('Shift')
  if (mods & MOD_WIN) parts.push('Win')
  parts.push(keyName(vk))
  return parts.join('+')
}

/**
 * Name a virtual-key code.
 *
 * @param {number} vk
 */
export function keyName (vk) {
  for (const [name, code] of NAMED_KEYS) {
    if (code === vk && /^[A-Z]+$/.test(name) && name !== 'ESCAPE' && name !== 'SNAPSHOT' && name !== 'PRIOR' && name !== 'NEXT' && name !== 'RETURN' && name !== 'DEL' && name !== 'OEM_MINUS') return name
  }
  if (vk >= 65 && vk <= 90) return String.fromCharCode(vk)
  if (vk >= 48 && vk <= 57) return String.fromCharCode(vk)
  if (vk >= 112 && vk <= 135) return `F${vk - 111}`
  if (vk >= 96 && vk <= 105) return `Numpad${vk - 96}`
  return `VK${vk}`
}

/**
 * Ordered candidate list for the daemon: the requested combo first, then the
 * fallbacks, de-duplicated by modifier+key so the same failed registration is
 * not retried.
 *
 * @param {string} [preferred]
 * @returns {Array<{ combo: string, mods: number, vk: number }>}
 */
export function candidateCombos (preferred = DEFAULT_COMBO) {
  const combos = []
  const seen = new Set()

  const add = (value) => {
    let parsed
    try {
      parsed = parseCombo(value)
    } catch {
      return
    }
    const key = `${parsed.mods}:${parsed.vk}`
    if (seen.has(key)) return
    seen.add(key)
    combos.push(parsed)
  }

  add(preferred)
  for (const fallback of FALLBACK_COMBOS) add(fallback)
  return combos
}
