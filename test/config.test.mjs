import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  CAPTURE_MODE_CHOICES,
  DEFAULT_CONFIG,
  coerceValue,
  loadConfig,
  normalizeConfig,
  saveConfig,
  updateConfig,
} from '../lib/config.js'

async function withTempDir (fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-qs-config-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}

test('defaults keep the pre-0.5.0 behaviour', () => {
  assert.equal(DEFAULT_CONFIG.hotkeyEnabled, true)
  assert.equal(DEFAULT_CONFIG.includeCursor, false)
  assert.equal(DEFAULT_CONFIG.hotkeyCapture, 'all')
  assert.equal(DEFAULT_CONFIG.clipboard, true)
  assert.equal(DEFAULT_CONFIG.hotkeyAutoStart, true)
})

test('capture modes are the four the panel offers', () => {
  assert.deepEqual(CAPTURE_MODE_CHOICES.map((choice) => choice.value), ['all', 'current', 'cursor-monitor', 'app'])
  for (const choice of CAPTURE_MODE_CHOICES) {
    assert.equal(coerceValue('hotkeyCapture', choice.value), choice.value)
  }
})

test('legacy capture names keep their meaning', () => {
  assert.equal(coerceValue('hotkeyCapture', 'screen'), 'all')
  assert.equal(coerceValue('hotkeyCapture', 'monitor'), 'current')
  assert.equal(coerceValue('hotkeyCapture', 'active'), 'app')
})

test('unknown capture modes fall back instead of breaking', () => {
  assert.equal(coerceValue('hotkeyCapture', 'nonsense'), 'all')
  assert.equal(coerceValue('hotkeyCapture', ''), 'all')
  assert.equal(coerceValue('hotkeyCapture', 42), 'all')
  assert.equal(coerceValue('hotkeyCapture', undefined), 'all')
})

test('the two new switches accept only booleans', () => {
  assert.equal(coerceValue('hotkeyEnabled', false), false)
  assert.equal(coerceValue('includeCursor', true), true)
  assert.equal(coerceValue('hotkeyEnabled', 'false'), true)
  assert.equal(coerceValue('includeCursor', 0), false)
})

test('normalizeConfig fills every key and drops unknown ones', () => {
  const normalized = normalizeConfig({ hotkey: 'Ctrl+Shift+X', mystery: 1 })
  assert.equal(normalized.hotkey, 'Ctrl+Shift+X')
  assert.equal('mystery' in normalized, false)
  assert.deepEqual(Object.keys(normalized).sort(), Object.keys(DEFAULT_CONFIG).sort())
})

test('a config written by an older release is migrated on read', async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, 'config.json'), JSON.stringify({
      hotkey: 'Ctrl+Alt+A',
      hotkeyCapture: 'screen',
      archiveDir: 'D:\\shots',
      clipboard: true,
      hotkeyAutoStart: true,
    }), 'utf8')
    const { config, warning } = await loadConfig(dir)
    assert.equal(warning, null)
    assert.equal(config.hotkeyCapture, 'all')
    assert.equal(config.hotkeyEnabled, true)
    assert.equal(config.includeCursor, false)
  })
})

test('a corrupt config yields defaults plus a warning', async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, 'config.json'), '{ not json', 'utf8')
    const { config, warning } = await loadConfig(dir)
    assert.equal(config.hotkeyCapture, 'all')
    assert.match(warning, /默认值/)
  })
})

test('saveConfig writes utf-8 without a BOM', async () => {
  await withTempDir(async (dir) => {
    await saveConfig(dir, { hotkey: 'Ctrl+Alt+A' })
    const bytes = await readFile(path.join(dir, 'config.json'))
    assert.notEqual(bytes[0], 0xef)
    assert.equal(bytes[1] === 0xbb && bytes[2] === 0xbf, false)
    const parsed = JSON.parse(bytes.toString('utf8'))
    assert.equal(parsed.hotkey, 'Ctrl+Alt+A')
  })
})

test('updateConfig merges a patch and reports a prior warning', async () => {
  await withTempDir(async (dir) => {
    await saveConfig(dir, { hotkeyCapture: 'app', includeCursor: true })
    const { config } = await updateConfig(dir, { includeCursor: false })
    assert.equal(config.includeCursor, false)
    assert.equal(config.hotkeyCapture, 'app')
    const reread = await loadConfig(dir)
    assert.equal(reread.config.includeCursor, false)
  })
})

test('overlapping updates do not discard each other', async () => {
  // Boot-time hotkey registration and a settings save can race; without a queue
  // the second read-modify-write writes back a stale snapshot.
  await withTempDir(async (dir) => {
    await saveConfig(dir, {})
    await Promise.all([
      updateConfig(dir, { archiveDir: 'D:\\shots' }),
      updateConfig(dir, { hotkeyCapture: 'app' }),
      updateConfig(dir, { includeCursor: true }),
    ])
    const { config } = await loadConfig(dir)
    assert.equal(config.archiveDir, 'D:\\shots')
    assert.equal(config.hotkeyCapture, 'app')
    assert.equal(config.includeCursor, true)
  })
})
