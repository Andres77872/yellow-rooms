import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DebugOverlay } from '../DebugOverlay.js'

// Node env (no jsdom): the overlay only needs one element and body.appendChild.
let el
beforeEach(() => {
  el = { style: {}, textContent: '', setAttribute: vi.fn(), remove: vi.fn() }
  vi.stubGlobal('document', { createElement: () => el, body: { appendChild: vi.fn() } })
})
afterEach(() => vi.unstubAllGlobals())

const renderer = () => ({
  info: { render: { calls: 12, triangles: 3400 }, memory: { geometries: 5, textures: 7 }, programs: [{}, {}] },
})

// One callback every `period` ms for `ms`; `drawEvery` = 1 draws on each,
// 2 on every second one (a ½ REFRESH limit), and so on.
function run(o, { from = 0, ms, period, drawEvery = 1 }) {
  let i = 0
  let t = from
  for (; t <= from + ms; t += period, i++) o.update(t, i % drawEvery === 0, { chunks: 9 })
  return t
}

describe('DebugOverlay (FPS monitor)', () => {
  it('starts hidden and shows only while a mode is set', () => {
    const o = new DebugOverlay(renderer())
    expect(o.visible).toBe(false)
    expect(el.style.cssText).toMatch(/display:none/)
    o.setMode('fps')
    expect(o.visible).toBe(true)
    expect(el.style.display).toBe('block')
    o.setMode('off')
    expect(el.style.display).toBe('none')
  })

  it('reads the drawn rate, not the callback rate, under a frame limit', () => {
    const o = new DebugOverlay(renderer())
    o.setMode('fps')
    // 144 Hz display drawing every second callback: 72 fps on screen.
    run(o, { ms: 2000, period: 1000 / 144, drawEvery: 2 })
    expect(el.textContent).toMatch(/^7[12] FPS {2}1[34]\.\d ms$/)
  })

  it('does not over-report below 20 fps (no 50 ms dt clamp)', () => {
    const o = new DebugOverlay(renderer())
    o.setMode('fps')
    run(o, { ms: 2000, period: 100 })
    expect(el.textContent).toBe('10 FPS  100.0 ms')
  })

  it('reads 0 while a held frame draws nothing, without one huge frame afterwards', () => {
    const o = new DebugOverlay(renderer())
    o.setMode('stats')
    let t = run(o, { ms: 1000, period: 1000 / 60 })
    t = run(o, { from: t, ms: 1000, period: 1000 / 60, drawEvery: Infinity })
    expect(el.textContent).toMatch(/^fps {6}0\n/)
    expect(el.textContent).toMatch(/frame {4}-- ms/)
    run(o, { from: t, ms: 1000, period: 1000 / 60 })
    expect(el.textContent).toMatch(/^fps {6}6\d\n/)
    const slowest = Number(el.textContent.match(/slowest +([\d.]+)/)[1])
    expect(slowest).toBeLessThan(20)
  })

  it('stats mode adds the slowest frame and renderer counters', () => {
    const o = new DebugOverlay(renderer())
    o.setMode('stats')
    let t = run(o, { ms: 300, period: 10 })
    t += 80 // one hitch
    run(o, { from: t, ms: 400, period: 10 })
    expect(el.textContent).toMatch(/slowest +90\.0 ms/)
    expect(el.textContent).toMatch(/calls +12/)
    expect(el.textContent).toMatch(/programs +2/)
    expect(el.textContent).toMatch(/chunks +9/)
  })

  it('shows placeholders until the first window closes', () => {
    const o = new DebugOverlay(renderer())
    o.setMode('fps')
    expect(el.textContent).toBe('-- FPS  -- ms')
  })
})
