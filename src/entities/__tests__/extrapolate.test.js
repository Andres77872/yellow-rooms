import { describe, it, expect } from 'vitest'
import { extrapolateSearch } from '../follow.js'

// A tiny wall-model stub: vertical walls on x-lines, horizontal on z-lines,
// columns per cell — the same queries edgeOpen/cellBlocked make on the real
// ChunkManager.
function grid({ wallsV = [], wallsH = [], columns = [] } = {}) {
  const v = new Set(wallsV.map(([x, z]) => `${x},${z}`))
  const h = new Set(wallsH.map(([x, z]) => `${x},${z}`))
  const c = new Set(columns.map(([x, z]) => `${x},${z}`))
  return {
    wallVAt: (x, z) => v.has(`${x},${z}`),
    wallHAt: (x, z) => h.has(`${x},${z}`),
    columnAt: (x, z) => c.has(`${x},${z}`),
    floorHoleAt: () => false,
    stairAt: () => null,
  }
}

describe('extrapolateSearch', () => {
  it('walks the full distance down an open corridor', () => {
    const cm = grid()
    expect(extrapolateSearch(cm, 0, 0, 0, 1, 0, 6)).toEqual({ gx: 6, gz: 0 })
    expect(extrapolateSearch(cm, 0, 0, 0, 0, -1, 4)).toEqual({ gx: 0, gz: -4 })
  })

  it('follows a diagonal bearing cell by cell', () => {
    const cm = grid()
    const s = extrapolateSearch(cm, 0, 0, 0, 1, 1, 6)
    expect(s.gx).toBeGreaterThanOrEqual(4)
    expect(s.gz).toBeGreaterThanOrEqual(4)
  })

  it('stops at a wall when there is no secondary axis', () => {
    // Vertical wall on the x=3 line blocks E from (2, 0); bearing has no z.
    const cm = grid({ wallsV: [[3, 0]] })
    expect(extrapolateSearch(cm, 0, 0, 0, 1, 0, 6)).toEqual({ gx: 2, gz: 0 })
  })

  it('slides along the secondary axis around a wall', () => {
    // Wall on x=2 at z=0 only: the (3,1)-ish bearing detours via +z.
    const cm = grid({ wallsV: [[2, 0]] })
    const s = extrapolateSearch(cm, 0, 0, 0, 3, 1, 6)
    expect(s.gz).toBeGreaterThanOrEqual(1) // stepped around
    expect(s.gx).toBeGreaterThan(2) // and kept going past the wall line
  })

  it('respects columns as blockers', () => {
    const cm = grid({ columns: [[1, 0]] })
    expect(extrapolateSearch(cm, 0, 0, 0, 1, 0, 6)).toEqual({ gx: 0, gz: 0 })
  })

  it('returns the origin for a zero bearing or zero steps', () => {
    const cm = grid()
    expect(extrapolateSearch(cm, 4, 5, 0, 0, 0, 6)).toEqual({ gx: 4, gz: 5 })
    expect(extrapolateSearch(cm, 4, 5, 0, 1, 0, 0)).toEqual({ gx: 4, gz: 5 })
  })
})
