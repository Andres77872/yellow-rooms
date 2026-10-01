import { describe, expect, it } from 'vitest'
import { ChunkData } from '../ChunkData.js'
import { buildChunk } from '../pipeline.js'
import { worldConfigForFamily } from '../mapFamily.js'
import { collectWallShell, collectWallTrim, mergeCollinearBoxes } from '../objects/wallShell.js'
import {
  BASEBOARD_H,
  BRIDGE_GUARD_CAP_H,
  BRIDGE_GUARD_H,
  CELL,
  CHUNK,
  FRAME_DEPTH,
  THICK,
  WALL_BEVEL,
  WALL_H,
  WINDOW_HEAD_Y,
  WINDOW_SILL_H,
  ZONE_OFFICE,
} from '../constants.js'
import { PASSAGE_DOOR, PASSAGE_WALL, WALL_RAIL, WALL_WINDOW } from '../mapTypes.js'

const chunk = () => new ChunkData(0, 0, 0, ZONE_OFFICE)
const T = THICK

// Is world point (x, y, z) inside (or on) any box?
const covered = (boxes, x, y, z, eps = 1e-6) =>
  boxes.some((b) =>
    Math.abs(x - b.px) <= b.sx / 2 + eps &&
    Math.abs(y - b.py) <= b.sy / 2 + eps &&
    Math.abs(z - b.pz) <= b.sz / 2 + eps
  )

describe('wall shell', () => {
  const extent = (b, axis) => (axis === 'x' ? [b.px - b.sx / 2, b.px + b.sx / 2] : [b.pz - b.sz / 2, b.pz + b.sz / 2])
  const close = (actual, expected) => {
    expect(actual[0]).toBeCloseTo(expected[0], 9)
    expect(actual[1]).toBeCloseTo(expected[1], 9)
  }

  it('draws a straight wall as one run reaching past both seam vertices', () => {
    const data = chunk()
    for (let z = 0; z < CHUNK; z++) data.setV(5, z, 1)
    const { walls } = collectWallShell(data)
    expect(walls).toHaveLength(1)
    expect(walls[0]).toMatchObject({ px: 5 * CELL, sx: T, sy: WALL_H })
    // Neighbour edges are unknown at mesh time: the run reaches the far face
    // of each seam vertex square, overlapping the neighbour's own reach.
    close(extent(walls[0], 'z'), [-T / 2, CHUNK * CELL + T / 2])
  })

  it('fills the outer corner square of an L and reaches past both free ends', () => {
    const data = chunk()
    for (let z = 3; z <= 6; z++) data.setV(5, z, 1) // x = 15, z 9..21
    for (let x = 5; x <= 8; x++) data.setH(x, 3, 1) // z = 9, x 15..27
    const { walls } = collectWallShell(data)
    expect(walls).toHaveLength(2)
    // The old per-edge slabs left the (-,-) quadrant of the vertex square
    // empty; both legs now reach its far faces.
    expect(covered(walls, 15 - T / 2 + 1e-3, 1, 9 - T / 2 + 1e-3)).toBe(true)
    close(extent(walls.find((b) => b.sx === T), 'z'), [9 - T / 2, 21 + T / 2])
    close(extent(walls.find((b) => b.sz === T), 'x'), [15 - T / 2, 27 + T / 2])
  })

  it('buries a T-stem in the through wall instead of extending it', () => {
    const data = chunk()
    for (let z = 0; z < CHUNK; z++) data.setV(5, z, 1)
    for (let x = 5; x <= 8; x++) data.setH(x, 7, 1)
    const { walls } = collectWallShell(data)
    const stem = walls.find((b) => b.sz === T)
    // The stem ends on the through-wall's centre line: its rounded end
    // (r < T/2) sits inside the through wall. The free end reaches past.
    close(extent(stem, 'x'), [15, 27 + T / 2])
    expect(WALL_BEVEL).toBeLessThan(T / 2)
  })

  it('reaches window sills and headers into the walls beside them, jambs stay put', () => {
    const data = chunk()
    for (let z = 0; z < CHUNK; z++) data.setV(5, z, 1)
    data.setV(5, 6, 1, PASSAGE_WALL, WALL_WINDOW)
    const { walls } = collectWallShell(data)
    const sill = walls.find((b) => Math.abs(b.sy - WINDOW_SILL_H) < 1e-9)
    const header = walls.find((b) => Math.abs(b.sy - (WALL_H - WINDOW_HEAD_Y)) < 1e-9)
    for (const piece of [sill, header]) close(extent(piece, 'z'), [6 * CELL - 2 * WALL_BEVEL, 7 * CELL + 2 * WALL_BEVEL])
    // The plain runs stop exactly at the jambs (the opening stays CELL wide).
    const plains = walls.filter((b) => b.sy === WALL_H).map((b) => extent(b, 'z'))
    expect(plains).toHaveLength(2)
    close(plains[0], [-T / 2, 6 * CELL])
    close(plains[1], [7 * CELL, CHUNK * CELL + T / 2])
  })

  it('wraps free rail ends with the parapet and its cap', () => {
    const data = chunk()
    for (let x = 2; x <= 5; x++) data.setH(x, 4, 1, PASSAGE_WALL, WALL_RAIL)
    const { walls, caps } = collectWallShell(data)
    expect(walls).toHaveLength(1)
    expect(walls[0].py + walls[0].sy / 2).toBeCloseTo(BRIDGE_GUARD_H, 9)
    close(extent(walls[0], 'x'), [6 - T / 2, 18 + T / 2])
    expect(caps).toHaveLength(1)
    expect(caps[0]).toMatchObject({ py: BRIDGE_GUARD_H, sy: BRIDGE_GUARD_CAP_H, sz: FRAME_DEPTH })
    close(extent(caps[0], 'x'), [6 - FRAME_DEPTH / 2, 18 + FRAME_DEPTH / 2])
  })

  it('lets a framed door casing cover the jamb; a plain opening shows rounded ends', () => {
    const data = chunk()
    for (let z = 0; z < CHUNK; z++) data.setV(5, z, 1)
    data.setV(5, 6, 0, PASSAGE_DOOR)
    const framed = collectWallShell(data).walls.map((b) => extent(b, 'z'))
    close(framed[0], [-T / 2, 6 * CELL])
    close(framed[1], [7 * CELL, CHUNK * CELL + T / 2])
    const open = chunk()
    for (let z = 0; z < CHUNK; z++) if (z !== 6) open.setV(5, z, 1)
    const ends = collectWallShell(open).walls.map((b) => extent(b, 'z'))
    close(ends[0], [-T / 2, 6 * CELL + T / 2])
    close(ends[1], [7 * CELL - T / 2, CHUNK * CELL + T / 2])
  })

  it('overlaps a wall crossing a seam from both neighbouring chunks', () => {
    const west = new ChunkData(0, 0, 0, ZONE_OFFICE)
    const east = new ChunkData(1, 0, 0, ZONE_OFFICE)
    for (let x = 0; x < CHUNK; x++) {
      west.setH(x, 5, 1)
      east.setH(x, 5, 1)
    }
    const seam = CHUNK * CELL
    const [w] = collectWallShell(west).walls
    const [e] = collectWallShell(east).walls
    expect(extent(w, 'x')[1]).toBeCloseTo(seam + T / 2, 9)
    expect(extent(e, 'x')[0] + seam).toBeCloseTo(seam - T / 2, 9)
  })

  it('wraps baseboards around corners and free ends, not into door casings', () => {
    const data = chunk()
    for (let z = 3; z <= 6; z++) data.setV(5, z, 1)
    for (let x = 5; x <= 8; x++) data.setH(x, 3, 1)
    data.setH(9, 3, 0, PASSAGE_DOOR)
    for (let x = 10; x <= 11; x++) data.setH(x, 3, 1)
    const boards = collectWallTrim(data).filter((b) => b.sy === BASEBOARD_H)
    const depth = Math.min(boards[0].sx, boards[0].sz)
    // Outer corner quadrant of the L is dressed.
    expect(covered(boards, 15 - depth / 2 + 1e-3, 0.05, 9 - depth / 2 + 1e-3)).toBe(true)
    // Free end of the V run wraps; the door jambs stop at the casing.
    close(extent(boards.find((b) => b.sx === depth), 'z'), [9 - depth / 2, 21 + depth / 2])
    close(extent(boards.find((b) => b.sz === depth && b.px < 24), 'x'), [15 - depth / 2, 27])
    close(extent(boards.find((b) => b.sz === depth && b.px > 24), 'x'), [30, 36 + depth / 2])
  })

  it('keeps every generated wall edge drawn, with closed L-corners', () => {
    for (const family of ['office', 'hotel', 'tower', 'sewer', 'lattice']) {
      const config = worldConfigForFamily(family)
      for (const [cx, cz] of [[0, 0], [1, -1], [-2, 1]]) {
        const data = buildChunk(4242, cx, 0, cz, config)
        expect(data.mapFamily).toBe(family)
        const walls = mergeCollinearBoxes(collectWallShell(data).walls)
        for (let line = 0; line < CHUNK; line++) {
          for (let cell = 0; cell < CHUNK; cell++) {
            const along = (cell + 0.5) * CELL
            if (data.vAt(line, cell)) expect(covered(walls, line * CELL, 0.4, along)).toBe(true)
            if (data.hAt(cell, line)) expect(covered(walls, along, 0.4, line * CELL)).toBe(true)
          }
        }
        // Every interior vertex where exactly two perpendicular full walls
        // meet has its whole square filled at head height.
        for (let vx = 1; vx < CHUNK; vx++) {
          for (let vz = 1; vz < CHUNK; vz++) {
            const plain = (wall, feature) => wall === 1 && feature === 0
            const n = plain(data.vAt(vx, vz - 1), data.wallFeatureVAt(vx, vz - 1))
            const s = plain(data.vAt(vx, vz), data.wallFeatureVAt(vx, vz))
            const w = plain(data.hAt(vx - 1, vz), data.wallFeatureHAt(vx - 1, vz))
            const e = plain(data.hAt(vx, vz), data.wallFeatureHAt(vx, vz))
            if ([n, s, w, e].filter(Boolean).length !== 2 || (n && s) || (w && e)) continue
            for (const dx of [-1, 1]) {
              for (const dz of [-1, 1]) {
                const x = vx * CELL + dx * (T / 2 - 1e-3)
                const z = vz * CELL + dz * (T / 2 - 1e-3)
                expect(covered(walls, x, 1.7, z)).toBe(true)
              }
            }
          }
        }
      }
    }
  })
})

describe('mergeCollinearBoxes', () => {
  it('unions touching boxes of one cross-section and leaves the rest alone', () => {
    const a = { px: 1, py: 1, pz: 0, sx: 2, sy: 2, sz: 0.2 }
    const b = { px: 3, py: 1, pz: 0, sx: 2, sy: 2, sz: 0.2 }
    const gap = { px: 6, py: 1, pz: 0, sx: 2, sy: 2, sz: 0.2 }
    const other = { px: 3, py: 1, pz: 0, sx: 2, sy: 1, sz: 0.2 }
    const out = mergeCollinearBoxes([a, b, gap, other])
    expect(out).toHaveLength(3)
    expect(out[0]).toMatchObject({ px: 2, sx: 4 })
    expect(out).toContainEqual(gap)
    expect(out).toContainEqual(other)
    expect(mergeCollinearBoxes(out)).toEqual(out)
  })

  it('never merges across tints', () => {
    const red = [1, 0, 0]
    const blue = [0, 0, 1]
    const out = mergeCollinearBoxes([
      { px: 0.5, py: 0, pz: 0, sx: 1, sy: 1, sz: 1, tint: red },
      { px: 1.5, py: 0, pz: 0, sx: 1, sy: 1, sz: 1, tint: blue },
      { px: 2.5, py: 0, pz: 0, sx: 1, sy: 1, sz: 1, tint: blue },
    ])
    expect(out).toHaveLength(2)
    expect(out[1]).toMatchObject({ px: 2, sx: 2, tint: blue })
  })
})
