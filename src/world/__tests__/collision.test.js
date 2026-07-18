import { describe, it, expect } from 'vitest'
import { moveAndCollide, hasLineOfSight } from '../../player/collision.js'
import { ChunkData } from '../ChunkData.js'
import {
  CELL,
  CHUNK,
  COL_HALF,
  MONUMENTAL_COL_HALF,
  PLAYER_R,
  WALL_COL_HALF,
} from '../constants.js'
import {
  COLUMN_MONUMENTAL,
  PASSAGE_WALL,
  WALL_RAIL,
  WALL_WINDOW,
  wallFeatureSeesThrough,
} from '../mapTypes.js'

// Mock ChunkManager backed by a single chunk at the origin.
function mockCM(data) {
  const inRange = (gx, gz) => gx >= 0 && gx < CHUNK && gz >= 0 && gz < CHUNK
  const wallVAt = (gx, gz) => inRange(gx, gz) && data.vAt(gx, gz) === 1
  const wallHAt = (gx, gz) => inRange(gx, gz) && data.hAt(gx, gz) === 1
  return {
    wallVAt,
    wallHAt,
    opaqueVAt: (gx, gz) => wallVAt(gx, gz) && !wallFeatureSeesThrough(data.wallFeatureVAt(gx, gz)),
    opaqueHAt: (gx, gz) => wallHAt(gx, gz) && !wallFeatureSeesThrough(data.wallFeatureHAt(gx, gz)),
    columnAt: (gx, gz) => inRange(gx, gz) && data.colAt(gx, gz) > 0,
    columnHalfAt: (gx, gz) => {
      if (!inRange(gx, gz)) return 0
      const kind = data.colAt(gx, gz)
      if (!kind) return 0
      return kind === COLUMN_MONUMENTAL ? MONUMENTAL_COL_HALF : COL_HALF
    },
  }
}

const STOP = (line) => line * CELL - PLAYER_R - WALL_COL_HALF - 0.001

describe('collision: walls', () => {
  it('stops the player at a vertical wall and never penetrates it', () => {
    const data = new ChunkData(0, 0, 0, 0)
    for (let z = 0; z < CHUNK; z++) data.setV(5, z, 1) // wall on line x=5
    const cm = mockCM(data)
    const pos = { x: 5 * CELL - 1, z: 7.5 }
    const hit = moveAndCollide(cm, pos, 2, 0) // drive east through the wall
    expect(hit.x).toBe(true)
    expect(pos.x).toBeLessThanOrEqual(STOP(5) + 1e-6)
    expect(pos.x).toBeGreaterThan(5 * CELL - PLAYER_R - 0.2) // stopped just shy
  })

  it('passes through a doorway gap in the wall', () => {
    const data = new ChunkData(0, 0, 0, 0)
    for (let z = 0; z < CHUNK; z++) data.setV(5, z, 1)
    data.setV(5, 7, 0) // doorway at row z=7
    const cm = mockCM(data)
    const pos = { x: 5 * CELL - 1, z: 7 * CELL + 1.5 } // centred in row 7
    const hit = moveAndCollide(cm, pos, 2, 0)
    expect(hit.x).toBe(false)
    expect(pos.x).toBeCloseTo(5 * CELL + 1, 6) // moved freely through
  })

  it('slides along a wall (blocked axis stops, free axis moves)', () => {
    const data = new ChunkData(0, 0, 0, 0)
    for (let z = 0; z < CHUNK; z++) data.setV(5, z, 1)
    const cm = mockCM(data)
    const pos = { x: 5 * CELL - 1, z: 7.5 }
    const hit = moveAndCollide(cm, pos, 2, 1) // diagonal into the wall
    expect(hit.x).toBe(true)
    expect(pos.z).toBeCloseTo(8.5, 6) // z slid freely
  })

  it('blocks on a freestanding column', () => {
    const data = new ChunkData(0, 0, 0, 0)
    data.setCol(5, 5, 1)
    const cm = mockCM(data)
    const colCenterX = 5.5 * CELL
    const pos = { x: colCenterX - 2, z: 5.5 * CELL }
    // Engine sub-steps movement (~0.09u/call max), so drive in small steps.
    let blocked = false
    for (let i = 0; i < 60; i++) blocked = moveAndCollide(cm, pos, 0.1, 0).x || blocked
    expect(blocked).toBe(true)
    expect(pos.x).toBeLessThan(colCenterX - 0.3) // stopped west of the column centre
  })

  it('collides against a monumental pier at its rendered width', () => {
    const data = new ChunkData(0, 0, 0, 0)
    data.setCol(5, 5, COLUMN_MONUMENTAL)
    const cm = mockCM(data)
    const center = 5.5 * CELL
    const pos = { x: center - 3, z: center }
    let blocked = false
    for (let i = 0; i < 60; i++) blocked = moveAndCollide(cm, pos, 0.1, 0).x || blocked
    expect(blocked).toBe(true)
    expect(pos.x).toBeCloseTo(center - MONUMENTAL_COL_HALF - PLAYER_R - 0.001, 3)
  })
})

describe('collision: line of sight', () => {
  it('is blocked by a wall between two cells', () => {
    const data = new ChunkData(0, 0, 0, 0)
    for (let z = 0; z < CHUNK; z++) data.setV(5, z, 1)
    const cm = mockCM(data)
    // From cell x=2 to cell x=8 across the wall at line 5.
    expect(hasLineOfSight(cm, 2.5 * CELL, 7.5, 8.5 * CELL, 7.5)).toBe(false)
  })

  it('is clear through a doorway', () => {
    const data = new ChunkData(0, 0, 0, 0)
    for (let z = 0; z < CHUNK; z++) data.setV(5, z, 1)
    data.setV(5, 7, 0)
    const cm = mockCM(data)
    expect(hasLineOfSight(cm, 2.5 * CELL, 7.5 * CELL, 8.5 * CELL, 7.5 * CELL)).toBe(true)
  })

  it('is clear in fully open space', () => {
    const cm = mockCM(new ChunkData(0, 0, 0, 0))
    expect(hasLineOfSight(cm, 3, 3, 30, 12)).toBe(true)
  })

  it('blocks sight through a monumental pier but preserves clear bay sightlines', () => {
    const data = new ChunkData(0, 0, 0, 0)
    data.setCol(5, 5, COLUMN_MONUMENTAL)
    const cm = mockCM(data)
    expect(
      hasLineOfSight(cm, 2.5 * CELL, 5.5 * CELL, 8.5 * CELL, 5.5 * CELL)
    ).toBe(false)
    expect(
      hasLineOfSight(
        cm,
        2.5 * CELL,
        5.5 * CELL + MONUMENTAL_COL_HALF + 0.05,
        8.5 * CELL,
        5.5 * CELL + MONUMENTAL_COL_HALF + 0.05
      )
    ).toBe(true)
  })

  it('windows and bridge rails block movement but not sight', () => {
    for (const feature of [WALL_WINDOW, WALL_RAIL]) {
      const data = new ChunkData(0, 0, 0, 0)
      data.setV(5, 7, 1, PASSAGE_WALL, feature)
      const cm = mockCM(data)
      const z = 7.5 * CELL
      const pos = { x: 5 * CELL - 1, z }
      expect(moveAndCollide(cm, pos, 2, 0).x).toBe(true)
      expect(hasLineOfSight(cm, 2.5 * CELL, z, 8.5 * CELL, z)).toBe(true)

      // Transparency applies only to the marked barrier; an ordinary wall
      // behind it still occludes the same ray.
      data.setV(7, 7, 1)
      expect(hasLineOfSight(cm, 2.5 * CELL, z, 8.5 * CELL, z)).toBe(false)
    }
  })
})

// Drive moveAndCollide in substep-sized steps (the Engine moves the player in 5
// sub-steps of <= ~0.086u each), accumulating the worst slab penetration seen so
// a regression can assert the box is never embedded in a wall.
const SUB = 0.08
function drive(cm, pos, dx, dz, n) {
  let worst = 0
  for (let i = 0; i < n; i++) {
    moveAndCollide(cm, pos, dx, dz)
    worst = Math.max(worst, penetration(cm, pos.x, pos.z))
  }
  return worst
}
// How deep the player AABB (half PLAYER_R) sits inside any wall slab (half
// WALL_COL_HALF). 0 = clean; > 0 = embedded (the through-walls precondition).
function penetration(cm, x, z) {
  const r = PLAYER_R
  const cell = (w) => Math.floor(w / CELL)
  let worst = 0
  for (let gx = cell(x - 1); gx <= cell(x + 1); gx++) {
    const xpen = r + WALL_COL_HALF - Math.abs(x - gx * CELL)
    if (xpen <= 0.001) continue
    for (let gz = cell(z - r); gz <= cell(z + r); gz++) {
      if (!cm.wallVAt(gx, gz)) continue
      const ov = Math.min(z + r, (gz + 1) * CELL) - Math.max(z - r, gz * CELL)
      if (ov > 0.001) worst = Math.max(worst, Math.min(xpen, ov))
    }
  }
  for (let gz = cell(z - 1); gz <= cell(z + 1); gz++) {
    const zpen = r + WALL_COL_HALF - Math.abs(z - gz * CELL)
    if (zpen <= 0.001) continue
    for (let gx = cell(x - r); gx <= cell(x + r); gx++) {
      if (!cm.wallHAt(gx, gz)) continue
      const ov = Math.min(x + r, (gx + 1) * CELL) - Math.max(x - r, gx * CELL)
      if (ov > 0.001) worst = Math.max(worst, Math.min(zpen, ov))
    }
  }
  return worst
}

describe('collision: no embedding / tunnelling (depenetration)', () => {
  it('does not embed or pass through when sliding +Z into a vertical wall that begins beside it', () => {
    // Vertical wall on line x=5, present only for rows z>=7 (a wall end at z=7).
    const data = new ChunkData(0, 0, 0, 0)
    for (let z = 7; z < CHUNK; z++) data.setV(5, z, 1)
    const cm = mockCM(data)
    // Centre 0.05 WEST of the line (legal: row 6 is open), then strafe south into
    // the walled rows and try to push east through the wall.
    const pos = { x: 5 * CELL - 0.05, z: 6.5 * CELL }
    let worst = drive(cm, pos, 0, SUB, 40) // strafe +Z into rows 7,8
    worst = Math.max(worst, drive(cm, pos, SUB, 0, 40)) // then push +X at the wall
    expect(worst).toBeLessThan(0.02) // never embedded in the slab
    expect(pos.x).toBeLessThan(5 * CELL) // never tunnelled to the east side
    expect(pos.x).toBeLessThanOrEqual(STOP(5) + 1e-6) // resting at the wall surface
  })

  it('does not embed or pass through when sliding +X into a horizontal wall that begins beside it', () => {
    // Horizontal wall on line z=5, present only for columns x>=7.
    const data = new ChunkData(0, 0, 0, 0)
    for (let x = 7; x < CHUNK; x++) data.setH(x, 5, 1)
    const cm = mockCM(data)
    const pos = { x: 6.5 * CELL, z: 5 * CELL - 0.05 }
    let worst = drive(cm, pos, SUB, 0, 40) // strafe +X into cols 7,8
    worst = Math.max(worst, drive(cm, pos, 0, SUB, 40)) // then push +Z at the wall
    expect(worst).toBeLessThan(0.02)
    expect(pos.z).toBeLessThan(5 * CELL)
    expect(pos.z).toBeLessThanOrEqual(STOP(5) + 1e-6)
  })

  it('does not slip through a wall end when approached diagonally', () => {
    // Wall on line x=5 for rows 7..13; the player rounds its north end (row 6).
    const data = new ChunkData(0, 0, 0, 0)
    for (let z = 7; z < CHUNK; z++) data.setV(5, z, 1)
    const cm = mockCM(data)
    let worst = 0
    for (let off = -0.3; off <= 0.3 + 1e-9; off += 0.1) {
      const pos = { x: 5 * CELL - 1.0, z: 6.5 * CELL + off }
      worst = Math.max(worst, drive(cm, pos, SUB, SUB, 60)) // dive SE toward the corner
    }
    expect(worst).toBeLessThan(0.12) // at most the transient margin, never embedded
  })

  it('rests at a consistent distance from a wall regardless of approach phase', () => {
    const data = new ChunkData(0, 0, 0, 0)
    for (let z = 0; z < CHUNK; z++) data.setV(5, z, 1)
    const cm = mockCM(data)
    const rests = [1.0, 1.03, 0.97, 1.11].map((gap) => {
      const pos = { x: 5 * CELL - gap, z: 7.5 }
      drive(cm, pos, SUB, 0, 30)
      return pos.x
    })
    for (const x of rests) expect(x).toBeCloseTo(STOP(5), 2) // all settle at the slab surface
  })

  it('does not falsely block walking straight past a wall end in an open row', () => {
    // Wall on line x=5 only at row 7; row 6 is fully open and must stay passable.
    const data = new ChunkData(0, 0, 0, 0)
    data.setV(5, 7, 1)
    const cm = mockCM(data)
    const pos = { x: 3 * CELL, z: 6.5 * CELL } // open row 6, west of the wall
    let blocked = false
    for (let i = 0; i < 120; i++) blocked = moveAndCollide(cm, pos, SUB, 0).x || blocked
    expect(blocked).toBe(false)
    expect(pos.x).toBeGreaterThan(5 * CELL + 1) // walked freely past the line
  })
})
