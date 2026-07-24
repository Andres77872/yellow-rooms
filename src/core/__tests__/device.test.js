import { describe, expect, it } from 'vitest'
import {
  MAX_BACKING_PIXELS,
  computeEffectivePixelRatio,
} from '../device.js'

const backingPixels = (width, height, ratio) => width * height * ratio * ratio

describe('computeEffectivePixelRatio', () => {
  it('preserves smaller displays and their requested render scale exactly', () => {
    expect(computeEffectivePixelRatio(1920, 1080, 1, 2, 1)).toBe(1)
    expect(computeEffectivePixelRatio(1366, 768, 1.25, 2, 0.75)).toBe(0.9375)
  })

  it('preserves a 1080p Retina backing store at the exact 4K budget', () => {
    const ratio = computeEffectivePixelRatio(1920, 1080, 2, 2, 1)

    expect(ratio).toBe(2)
    expect(backingPixels(1920, 1080, ratio)).toBe(MAX_BACKING_PIXELS)
  })

  it('caps a 1440p Retina display at a 3840x2160 backing store', () => {
    const ratio = computeEffectivePixelRatio(2560, 1440, 2, 2, 1)

    expect(ratio).toBe(1.5)
    expect(backingPixels(2560, 1440, ratio)).toBe(MAX_BACKING_PIXELS)
  })

  it('caps a native-CSS 5K display even at DPR 1', () => {
    const ratio = computeEffectivePixelRatio(5120, 2880, 1, 2, 1)

    expect(ratio).toBe(0.75)
    expect(backingPixels(5120, 2880, ratio)).toBe(MAX_BACKING_PIXELS)
  })

  it('keeps a lower render scale when it already fits under budget', () => {
    const ratio = computeEffectivePixelRatio(2560, 1440, 2, 2, 0.5)

    expect(ratio).toBe(1)
    expect(backingPixels(2560, 1440, ratio)).toBeLessThan(MAX_BACKING_PIXELS)
  })

  it('returns a finite requested ratio for transient zero or invalid dimensions', () => {
    expect(computeEffectivePixelRatio(0, 1080, 2, 2, 0.75)).toBe(1.5)
    expect(computeEffectivePixelRatio(NaN, Infinity, 2, 2, 1)).toBe(2)
    expect(computeEffectivePixelRatio(1920, 1080, NaN, NaN, NaN)).toBe(1)
  })
})
