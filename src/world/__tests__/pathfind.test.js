import { describe, it, expect } from 'vitest'
import { findPath, followPath, makeCanPass, edgeOpen } from '../pathfind.js'
import { ChunkData } from '../ChunkData.js'
import { CELL, CHUNK } from '../constants.js'

// Mock ChunkManager backed by a single chunk at the origin (cells 0..CHUNK-1).
// Out-of-range cells read as open — same convention as the real ChunkManager for
// unloaded chunks. Mirrors collision.test.js, plus cellCenter for the follower.
function mockCM(data) {
  const inRange = (gx, gz) => gx >= 0 && gx < CHUNK && gz >= 0 && gz < CHUNK
  return {
    wallVAt: (gx, gz) => inRange(gx, gz) && data.vAt(gx, gz) === 1,
    wallHAt: (gx, gz) => inRange(gx, gz) && data.hAt(gx, gz) === 1,
    columnAt: (gx, gz) => inRange(gx, gz) && data.colAt(gx, gz) === 1,
    cellCenter: (gx, gz, t) => t.set((gx + 0.5) * CELL, 0, (gz + 0.5) * CELL),
  }
}

const wc = (c) => (c + 0.5) * CELL // cell index -> world centre
const cells = (path) => {
  const out = []
  for (let i = 0; i < path.length; i += 2) out.push([path[i], path[i + 1]])
  return out
}

describe('pathfind: findPath', () => {
  it('returns the optimal straight line in open space', () => {
    const cm = mockCM(new ChunkData(0, 0, 0))
    const path = findPath(cm, wc(2), wc(2), wc(10), wc(2), { collapse: false })
    expect(path).not.toBeNull()
    const c = cells(path)
    expect(c.length).toBe(9) // cells 2..10 inclusive
    c.forEach(([gx, gz], i) => {
      expect(gz).toBe(2)
      expect(gx).toBe(2 + i)
    })
  })

  it('uses no diagonal moves', () => {
    const cm = mockCM(new ChunkData(0, 0, 0))
    const path = findPath(cm, wc(2), wc(2), wc(9), wc(6), { collapse: false })
    const c = cells(path)
    for (let i = 1; i < c.length; i++) {
      const md = Math.abs(c[i][0] - c[i - 1][0]) + Math.abs(c[i][1] - c[i - 1][1])
      expect(md).toBe(1)
    }
  })

  it('detours around a full wall to the single gap', () => {
    const data = new ChunkData(0, 0, 0)
    for (let z = 0; z < CHUNK; z++) data.setV(5, z, 1) // wall on line x=5
    data.setV(5, 4, 0) // ...with one doorway at z=4
    const cm = mockCM(data)
    // Start/target on row 7; the gap (z=4) is the closest crossing — closer than
    // routing past the chunk border (open beyond z=0/CHUNK), so the detour is forced.
    const path = findPath(cm, wc(2), wc(7), wc(8), wc(7))
    expect(path).not.toBeNull()
    const c = cells(path)
    let span = 0
    for (let i = 1; i < c.length; i++) span += Math.abs(c[i][0] - c[i - 1][0]) + Math.abs(c[i][1] - c[i - 1][1])
    expect(span).toBeGreaterThan(6) // longer than the 6-cell straight line
    expect(c.some(([, gz]) => gz === 4)).toBe(true) // crosses at the gap row
  })

  it('routes straight through a doorway gap', () => {
    const data = new ChunkData(0, 0, 0)
    for (let z = 0; z < CHUNK; z++) data.setV(5, z, 1)
    data.setV(5, 7, 0) // doorway at z=7, aligned with start/target row
    const cm = mockCM(data)
    const path = findPath(cm, wc(2), wc(7), wc(8), wc(7), { collapse: false })
    expect(path).not.toBeNull()
    const c = cells(path)
    expect(c.length).toBe(7) // straight 2..8 through the door
    c.forEach(([, gz]) => expect(gz).toBe(7))
    expect(c.some(([gx]) => gx === 5)).toBe(true)
  })

  it('returns null when the start is boxed in', () => {
    const data = new ChunkData(0, 0, 0)
    data.setV(4, 4, 1)
    data.setV(5, 4, 1)
    data.setH(4, 4, 1)
    data.setH(4, 5, 1)
    const cm = mockCM(data)
    expect(findPath(cm, wc(4), wc(4), wc(10), wc(10))).toBeNull()
  })

  it('returns null when the target is boxed in', () => {
    const data = new ChunkData(0, 0, 0)
    data.setV(9, 9, 1)
    data.setV(10, 9, 1)
    data.setH(9, 9, 1)
    data.setH(9, 10, 1)
    const cm = mockCM(data)
    expect(findPath(cm, wc(2), wc(2), wc(9), wc(9))).toBeNull()
  })

  it('respects the maxNodes budget cap', () => {
    const cm = mockCM(new ChunkData(0, 0, 0))
    expect(findPath(cm, wc(2), wc(2), wc(12), wc(12), { maxNodes: 5 })).toBeNull()
  })

  it('bails immediately when the target is beyond the leash', () => {
    const cm = mockCM(new ChunkData(0, 0, 0))
    // Chebyshev distance 8 > leash 3; huge maxNodes proves the leash gate fires first.
    expect(findPath(cm, wc(2), wc(2), wc(10), wc(2), { leash: 3, maxNodes: 1e6 })).toBeNull()
  })

  it('retargets a column target to an open neighbour, or null when enclosed', () => {
    const data = new ChunkData(0, 0, 0)
    data.setCol(9, 9, 1) // solid target with open neighbours
    const cm = mockCM(data)
    const path = findPath(cm, wc(2), wc(2), wc(9), wc(9))
    expect(path).not.toBeNull()
    const c = cells(path)
    const end = c[c.length - 1]
    expect(Math.abs(end[0] - 9) + Math.abs(end[1] - 9)).toBe(1) // ends adjacent to the column

    data.setV(9, 9, 1)
    data.setV(10, 9, 1)
    data.setH(9, 9, 1)
    data.setH(9, 10, 1)
    expect(findPath(cm, wc(2), wc(2), wc(9), wc(9))).toBeNull()
  })

  it('is deterministic across identical calls', () => {
    const data = new ChunkData(0, 0, 0)
    for (let z = 0; z < CHUNK; z++) data.setV(6, z, 1)
    data.setV(6, 9, 0)
    const cm = mockCM(data)
    const a = findPath(cm, wc(1), wc(1), wc(11), wc(2))
    const b = findPath(cm, wc(1), wc(1), wc(11), wc(2))
    expect(Array.from(a)).toEqual(Array.from(b))
  })

  it('reuses the caller-supplied out buffer', () => {
    const cm = mockCM(new ChunkData(0, 0, 0))
    const out = []
    const r1 = findPath(cm, wc(2), wc(2), wc(7), wc(2), { out, collapse: false })
    expect(r1).toBe(out)
    expect(cells(out).length).toBe(6)
    const r2 = findPath(cm, wc(2), wc(2), wc(5), wc(2), { out, collapse: false })
    expect(r2).toBe(out)
    expect(cells(out).length).toBe(4) // cleared + refilled, not appended
  })
})

describe('pathfind: makeCanPass / edgeOpen', () => {
  it('agrees with the edge rule on a wall and an open edge', () => {
    const data = new ChunkData(0, 0, 0)
    data.setV(5, 7, 1) // wall on line x=5 at row 7
    const cm = mockCM(data)
    const canPass = makeCanPass(cm)
    expect(canPass(4, 7, 5, 7)).toBe(false) // east into the wall line
    expect(canPass(5, 7, 4, 7)).toBe(false) // west into the same line
    expect(canPass(5, 7, 6, 7)).toBe(true) // east, open
    expect(edgeOpen(cm, 4, 7, 0)).toBe(false)
    expect(edgeOpen(cm, 5, 7, 0)).toBe(true)
  })
})

describe('pathfind: followPath', () => {
  it('string-pulls past a colinear waypoint and converges to the target', () => {
    const cm = mockCM(new ChunkData(0, 0, 0))
    const path = [2, 5, 5, 5, 8, 5] // colinear middle waypoint (5,5)
    const pos = { x: wc(2), z: wc(5) }

    const first = followPath(cm, pos, path, 0, 1.0)
    expect(first.i).toBe(2) // jumped straight to the last waypoint (clear LOS)

    let r = first
    for (let k = 0; k < 80 && !r.done; k++) r = followPath(cm, pos, path, r.i, 1.0)
    expect(r.done).toBe(true)
    expect(Math.abs(pos.x - wc(8))).toBeLessThan(CELL)
    expect(Math.abs(pos.z - wc(5))).toBeLessThan(0.5)
  })
})
