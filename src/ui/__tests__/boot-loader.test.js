import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BOOT_DONE_LABEL,
  BOOT_STAGES,
  BOOT_STEP_COUNT,
  BootLoader,
  afterPaint,
  readScaleX,
  settleWithin,
} from '../bootLoader.js'

// Node env, no DOM: the loader runs against hand-built element fakes, the
// same pattern the overlay tests use. The visual behaviour (compositor-driven
// creep, the fade off the world) is covered by the browser smoke.

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const fakeEl = () => ({
  textContent: '',
  style: {},
  dataset: {},
  attrs: {},
  classList: new Set(),
  setAttribute(k, v) {
    this.attrs[k] = v
  },
  animate: vi.fn(() => ({ cancel: vi.fn() })),
  remove: vi.fn(),
})

function fakeBoot() {
  const parts = {
    '.fill': fakeEl(),
    '.tube': fakeEl(),
    '.boot-label': fakeEl(),
    '.boot-step': fakeEl(),
  }
  const root = fakeEl()
  root.classList = { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() }
  root.querySelector = (sel) => parts[sel] ?? null
  return { root, parts }
}

describe('afterPaint', () => {
  it('runs synchronously without a rendering loop', () => {
    vi.stubGlobal('requestAnimationFrame', undefined)
    const fn = vi.fn()
    afterPaint(fn)
    expect(fn).toHaveBeenCalledOnce()
  })

  it('waits for the frame after the one that presents the change', () => {
    const frames = []
    vi.stubGlobal('requestAnimationFrame', (cb) => frames.push(cb))
    vi.stubGlobal('document', { hidden: false })
    const fn = vi.fn()
    afterPaint(fn)
    expect(fn).not.toHaveBeenCalled()
    frames.shift()()
    expect(fn).not.toHaveBeenCalled()
    frames.shift()()
    expect(fn).toHaveBeenCalledOnce()
  })

  it('falls back to a timer in a hidden tab, which fires no frames', () => {
    vi.useFakeTimers()
    const raf = vi.fn()
    vi.stubGlobal('requestAnimationFrame', raf)
    vi.stubGlobal('document', { hidden: true })
    const fn = vi.fn()
    afterPaint(fn)
    vi.runAllTimers()
    expect(fn).toHaveBeenCalledOnce()
    expect(raf).not.toHaveBeenCalled()
  })
})

describe('settleWithin', () => {
  it('passes a value through and gives up after the cap', async () => {
    vi.useFakeTimers()
    await expect(settleWithin(Promise.resolve(7), 100)).resolves.toBe(7)
    const never = settleWithin(new Promise(() => {}), 100)
    vi.advanceTimersByTime(100)
    await expect(never).resolves.toBeUndefined()
  })
})

describe('readScaleX', () => {
  it('reads the x scale of computed transforms, clamped to the tube', () => {
    expect(readScaleX('none')).toBe(0)
    expect(readScaleX('matrix(0.42, 0, 0, 1, 0, 0)')).toBeCloseTo(0.42)
    expect(readScaleX('matrix3d(0.5, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)')).toBeCloseTo(0.5)
    expect(readScaleX('matrix(1.2, 0, 0, 1, 0, 0)')).toBe(1)
    expect(readScaleX(undefined)).toBe(0)
  })
})

describe('BOOT_STAGES', () => {
  it('climbs monotonically after the HTML fetch step and never claims done', () => {
    const stages = Object.values(BOOT_STAGES).sort((a, b) => a.step - b.step)
    expect(stages[0].step).toBe(2) // 01 is the inline fetch stage
    expect(stages.at(-1).step).toBe(BOOT_STEP_COUNT)
    let last = 0.3 // the inline CSS creep's ceiling
    for (const s of stages) {
      expect(s.floor).toBeGreaterThan(last)
      expect(s.ceil).toBeGreaterThan(s.floor)
      expect(s.ceil).toBeLessThan(1)
      last = s.ceil
    }
  })
})

describe('BootLoader', () => {
  it('is inert without the boot element', async () => {
    const loader = new BootLoader(null)
    loader.stage('renderer')
    const reveal = vi.fn()
    await loader.finish(reveal)
    expect(reveal).toHaveBeenCalledOnce()
    loader.remove()
  })

  it('takes the screen over from the inline failure fallback', () => {
    const { root } = fakeBoot()
    new BootLoader(root)
    expect(root.dataset.live).toBe('1')
  })

  it('labels each stage and drives the tube from its current fill', () => {
    vi.stubGlobal('getComputedStyle', () => ({ transform: 'matrix(0.2, 0, 0, 1, 0, 0)' }))
    const { root, parts } = fakeBoot()
    const loader = new BootLoader(root)

    loader.stage('lights')

    expect(parts['.boot-label'].textContent).toBe(BOOT_STAGES.lights.label)
    expect(parts['.boot-step'].textContent).toBe('03/04')
    expect(parts['.tube'].attrs['aria-valuenow']).toBe(String(Math.round(BOOT_STAGES.lights.floor * 100)))
    // The inline CSS creep hands over; the end state is the stage's ceiling.
    expect(parts['.fill'].style.animation).toBe('none')
    expect(parts['.fill'].style.transform).toBe(`scaleX(${BOOT_STAGES.lights.ceil})`)
    const [frames] = parts['.fill'].animate.mock.calls[0]
    expect(frames[0].transform).toBe('scaleX(0.2)')
    expect(frames.at(-1).transform).toBe(`scaleX(${BOOT_STAGES.lights.ceil})`)
  })

  it('ignores unknown stages and anything after finish', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('getComputedStyle', () => ({ transform: 'none' }))
    const { root, parts } = fakeBoot()
    const loader = new BootLoader(root)
    loader.stage('nope')
    expect(parts['.boot-label'].textContent).toBe('')

    const done = loader.finish(() => {})
    loader.stage('renderer')
    expect(parts['.boot-label'].textContent).toBe(BOOT_DONE_LABEL)
    await vi.runAllTimersAsync()
    await done
  })

  it('fills the tube, reveals as the fade starts, then removes the screen', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('getComputedStyle', () => ({ transform: 'matrix(0.9, 0, 0, 1, 0, 0)' }))
    const { root, parts } = fakeBoot()
    const loader = new BootLoader(root)
    const reveal = vi.fn()

    const done = loader.finish(reveal)

    expect(parts['.boot-label'].textContent).toBe(BOOT_DONE_LABEL)
    expect(parts['.boot-step'].textContent).toBe('04/04')
    expect(parts['.fill'].style.transform).toBe('scaleX(1)')
    expect(root.classList.add).toHaveBeenCalledWith('lit')
    expect(reveal).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(400)
    expect(reveal).toHaveBeenCalledOnce()
    expect(root.classList.add).toHaveBeenCalledWith('out')
    expect(root.remove).not.toHaveBeenCalled()

    await vi.runAllTimersAsync()
    await done
    expect(root.remove).toHaveBeenCalledOnce()
  })
})
