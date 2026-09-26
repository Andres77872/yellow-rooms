import { describe, expect, it } from 'vitest'
import { SettingsBlock } from '../settingsPanel.js'
import { DEFAULTS } from '../../core/Settings.js'

// Node-env test on SettingsBlock.prototype.refresh with plain element fakes
// (the repo has no jsdom): every data-k control is a bag of properties.
function bareBlock() {
  const b = Object.create(SettingsBlock.prototype)
  b.el = new Proxy({}, { get: (t, k) => (t[k] ??= {}) })
  return b
}

const store = (over) => {
  const data = { ...DEFAULTS, ...over }
  return { get: (k) => data[k] }
}

describe('DYNAMIC RESOLUTION checkbox', () => {
  it('shows what runs: checked and locked under auto, even with the opt-in off', () => {
    const b = bareBlock()
    b.refresh(store({ preset: 'auto', dynamicRes: false }))
    expect(b.el.dynres.checked).toBe(true)
    expect(b.el.dynres.disabled).toBe(true)
    expect(b.el.dynres.title).toMatch(/AUTO/)
  })

  it('unchecked and locked under cinematic, even with the opt-in on', () => {
    const b = bareBlock()
    b.refresh(store({ preset: 'cinematic', dynamicRes: true }))
    expect(b.el.dynres.checked).toBe(false)
    expect(b.el.dynres.disabled).toBe(true)
  })

  it('follows the opt-in and is editable under any other preset', () => {
    const b = bareBlock()
    b.refresh(store({ preset: 'high', dynamicRes: true }))
    expect(b.el.dynres.checked).toBe(true)
    expect(b.el.dynres.disabled).toBe(false)
    b.refresh(store({ preset: 'custom', dynamicRes: false }))
    expect(b.el.dynres.checked).toBe(false)
    expect(b.el.dynres.disabled).toBe(false)
    expect(b.el.dynres.title).toBe('')
  })
})
