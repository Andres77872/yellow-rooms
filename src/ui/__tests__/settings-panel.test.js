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

describe('WEBGPU PATH TRACER select (experimental)', () => {
  it('sits in its own EXPERIMENTAL group behind ADVANCED, OFF first', () => {
    const adv = SETTINGS_HTML.indexOf('data-k="adv"')
    const group = SETTINGS_HTML.indexOf('EXPERIMENTAL')
    const box = SETTINGS_HTML.indexOf('data-k="pathTracer"')
    expect(group).toBeGreaterThan(adv)
    expect(box).toBeGreaterThan(group)
    const options = [...SETTINGS_HTML.slice(box).matchAll(/<option value="([^"]+)">/g)].slice(0, 3).map((m) => m[1])
    expect(options).toEqual(['off', 'viewer', 'realtime'])
  })

  it('shows OFF by default and follows the stored mode where WebGPU exists', () => {
    const b = bareBlock()
    b.refresh(store({}), { pathTracer: { ok: true, reason: '' } })
    expect(b.el.pathTracer.value).toBe('off')
    expect(b.el.pathTracer.disabled).toBe(false)
    expect(b.el.pathTracerRow.title).toMatch(/REALTIME/)
    b.refresh(store({ pathTracer: 'realtime' }), { pathTracer: { ok: true, reason: '' } })
    expect(b.el.pathTracer.value).toBe('realtime')
  })

  it('reads OFF, locked, and says why without WebGPU, keeping the stored mode', () => {
    const b = bareBlock()
    b.refresh(store({ pathTracer: 'realtime' }), { pathTracer: { ok: false, reason: 'WebGPU is not available in this browser' } })
    expect(b.el.pathTracer.value).toBe('off')
    expect(b.el.pathTracer.disabled).toBe(true)
    expect(b.el.pathTracerRow.title).toBe('Unavailable: WebGPU is not available in this browser')
  })

  it('reports edits as the pathTracer setting', () => {
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
    els.pathTracer.value = 'realtime'
    els.pathTracer.listeners.change()
    expect(onSetting).toHaveBeenCalledWith('pathTracer', 'realtime')
  })
})

describe('FRAME RATE LIMIT select', () => {
  it('sits in the simple GRAPHICS group, OFF first', () => {
    const adv = SETTINGS_HTML.indexOf('data-k="adv"')
    const box = SETTINGS_HTML.indexOf('data-k="fps"')
    expect(box).toBeGreaterThan(SETTINGS_HTML.indexOf('data-k="preset"'))
    expect(box).toBeLessThan(adv)
    const options = [...SETTINGS_HTML.slice(box).matchAll(/<option value="([^"]+)">([^<]+)</g)].slice(0, 4)
    expect(options.map((m) => m[1])).toEqual(['off', 'half', '30', '60'])
    expect(options.map((m) => m[2])).toEqual(['OFF', '½ REFRESH', '30 FPS', '60 FPS'])
  })

  it('shows the stored limit', () => {
    const b = bareBlock()
    b.refresh(store({}))
    expect(b.el.fps.value).toBe('off')
    b.refresh(store({ frameLimit: 60 }))
    expect(b.el.fps.value).toBe('60')
  })

  it('reports numbers as numbers and the modes as strings', () => {
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
    els.fps.value = '60'
    els.fps.listeners.change()
    expect(onSetting).toHaveBeenLastCalledWith('frameLimit', 60)
    els.fps.value = 'half'
    els.fps.listeners.change()
    expect(onSetting).toHaveBeenLastCalledWith('frameLimit', 'half')
  })
})
