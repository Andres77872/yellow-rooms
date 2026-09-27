import { describe, expect, it, vi } from 'vitest'
import { SETTINGS_HTML, SettingsBlock } from '../settingsPanel.js'
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

describe('REDUCE FLICKER checkbox', () => {
  it('sits in the simple view, not behind ADVANCED', () => {
    const adv = SETTINGS_HTML.indexOf('data-k="adv"')
    const box = SETTINGS_HTML.indexOf('data-k="flicker"')
    expect(box).toBeGreaterThan(0)
    expect(box).toBeLessThan(adv)
    expect(SETTINGS_HTML).toMatch(/PHOTOSENSITIVITY/)
  })

  it('shows the stored value, checked by default', () => {
    const b = bareBlock()
    b.refresh(store({}))
    expect(b.el.flicker.checked).toBe(true)
    b.refresh(store({ reduceFlicker: false }))
    expect(b.el.flicker.checked).toBe(false)
  })

  it('reports edits as the reduceFlicker setting', () => {
    const els = {}
    const root = {
      querySelectorAll: () =>
        [...SETTINGS_HTML.matchAll(/data-k="([^"]+)"/g)].map(([, k]) => {
          const el = { dataset: { k }, listeners: {}, classList: { toggle: () => true } }
          el.addEventListener = (evt, fn) => (el.listeners[evt] = fn)
          el.setAttribute = () => {}
          els[k] = el
          return el
        }),
    }
    const onSetting = vi.fn()
    new SettingsBlock(root, { onSetting })
    els.flicker.checked = false
    els.flicker.listeners.change()
    expect(onSetting).toHaveBeenCalledWith('reduceFlicker', false)
  })
})
