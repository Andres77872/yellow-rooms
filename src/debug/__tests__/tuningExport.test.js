import { describe, it, expect } from 'vitest'
import { formatTuning } from '../tuningExport.js'

describe('formatTuning', () => {
  it('formats numbers and strings as "label: value" lines', () => {
    const text = formatTuning([
      { label: 'lamp intensity', value: 1.2 },
      { label: 'lamp color', value: '#ffe9b0' },
    ])
    expect(text).toBe('lamp intensity: 1.2\nlamp color: #ffe9b0')
  })

  it('trims float noise to 4 decimals', () => {
    expect(formatTuning([{ label: 'x', value: 0.30000000000000004 }])).toBe('x: 0.3')
    expect(formatTuning([{ label: 'y', value: 0.123456789 }])).toBe('y: 0.1235')
  })

  it('keeps integers and zero intact', () => {
    expect(formatTuning([{ label: 'levels', value: 16 }])).toBe('levels: 16')
    expect(formatTuning([{ label: 'grain', value: 0 }])).toBe('grain: 0')
  })

  it('returns an empty string for no entries', () => {
    expect(formatTuning([])).toBe('')
  })
})
