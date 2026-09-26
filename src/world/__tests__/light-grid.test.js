import { describe, expect, it } from 'vitest'
import { ChunkData } from '../ChunkData.js'
import { CELL, CHUNK, DOOR_H, LIGHT_RANGE, STALKER_AMBIENT, WALL_H, WINDOW_HEAD_Y, WINDOW_SILL_H, BRIDGE_GUARD_H, layerY } from '../constants.js'
import { PASSAGE_DOOR, PASSAGE_WALL, WALL_RAIL, WALL_WINDOW } from '../mapTypes.js'
import {
  EDGE_DOOR,
  EDGE_OPEN,
  EDGE_RAIL,
  EDGE_WALL,
  EDGE_WINDOW,
  GLASS_T,
  GRID_FLOORS,
  GRID_W,
  LAMP_Y,
  LIST_MAX,
  REF_FLOOR_REACH,
  REF_REACH,
  VIS_FULL,
  decodeRef,
  edgeTransmission,
  encodeRef,
  floorOfY,
  ownerIndex,
  packEntry,
  texelIndex,
} from '../lightGrid/gridSpec.js'
import { LightGrid, cubicAttenuation, physicalAttenuation, toHalf } from '../lightGrid/LightGrid.js'

// Synthetic chunk: an empty floor plate the test carves walls into.
function chunk(cx, cy, cz, build = () => {}) {
  const d = new ChunkData(cx, cy, cz, 0)
  build(d)
  return d
}

// A full-height wall on the vertical line lx (chunk-local), rows z0..z1.
function wallV(d, lx, z0 = 0, z1 = CHUNK - 1) {
  for (let z = z0; z <= z1; z++) d.setV(lx, z, 1, PASSAGE_WALL)
}

const lampCellCentre = (gx, gz, cy = 0) => [(gx + 0.5) * CELL, layerY(cy) + LAMP_Y, (gz + 0.5) * CELL]

function lights(grid, gx, gz, cy = 0) {
  const out = []
  grid.forEachLight(gx, gz, cy, (x, y, z, lcy, vis) => out.push({ gx: Math.floor(x / CELL), gz: Math.floor(z / CELL), cy: lcy, vis }))
  return out
}

describe('gridSpec encoding', () => {
  it('round-trips every relative lamp reference and never collides with EMPTY', () => {
    const seen = new Set()
    for (let df = -REF_FLOOR_REACH; df <= REF_FLOOR_REACH; df++) {
      for (let dz = -REF_REACH; dz <= REF_REACH; dz++) {
        for (let dx = -REF_REACH; dx <= REF_REACH; dx++) {
          const ref = encodeRef(dx, dz, df)
          expect(ref).toBeLessThan(1023)
          expect(seen.has(ref)).toBe(false)
          seen.add(ref)
          expect(decodeRef(ref)).toEqual({ dx, dz, df })
        }
      }
    }
    // Two 16-bit entries share one uint32; visibility lives in the top 6 bits.
    const e = packEntry(encodeRef(-4, 3, 1), VIS_FULL)
    expect(e >>> 10).toBe(VIS_FULL)
    expect(e & 1023).toBe(encodeRef(-4, 3, 1))
  })

  it('addresses the toroidal window for negative coordinates and floor slots', () => {
    expect(texelIndex(0, 0, 0)).toBe(0)
    expect(texelIndex(-1, 0, 0)).toBe(GRID_W - 1)
    expect(texelIndex(0, -1, 0)).toBe((GRID_W - 1) * GRID_W)
    expect(texelIndex(3, 5, GRID_FLOORS)).toBe(texelIndex(3, 5, 0)) // slot aliasing is explicit
    expect(texelIndex(3, 5, -1)).toBe(texelIndex(3, 5, GRID_FLOORS - 1))
    // A 12-chunk window never aliases chunks within the 11-chunk residency span.
    const slots = new Set()
    for (let cx = -5; cx <= 5; cx++) slots.add(ownerIndex(cx, 0, 0))
    expect(slots.size).toBe(11)
  })

  it('tests each opening at the ray height (lintel, sill, head, rail)', () => {
    expect(edgeTransmission(EDGE_OPEN, 3)).toBe(1)
    expect(edgeTransmission(EDGE_WALL, 1)).toBe(0)
    expect(edgeTransmission(EDGE_DOOR, DOOR_H - 0.01)).toBe(1)
    expect(edgeTransmission(EDGE_DOOR, DOOR_H + 0.01)).toBe(0)
    expect(edgeTransmission(EDGE_WINDOW, WINDOW_SILL_H - 0.01)).toBe(0)
    expect(edgeTransmission(EDGE_WINDOW, (WINDOW_SILL_H + WINDOW_HEAD_Y) / 2)).toBe(GLASS_T)
    expect(edgeTransmission(EDGE_RAIL, BRIDGE_GUARD_H - 0.01)).toBe(0)
    expect(edgeTransmission(EDGE_RAIL, WALL_H - 0.1)).toBe(1)
    expect(floorOfY(layerY(2))).toBe(2) // a floor surface belongs to its storey
    expect(floorOfY(layerY(2) + WALL_H)).toBe(2) // so does the ceiling underside
  })

  it('converts floats to IEEE half precision with correct rounding carry', () => {
    expect(toHalf(1)).toBe(0x3c00)
    expect(toHalf(0.5)).toBe(0x3800)
    expect(toHalf(-2)).toBe(0xc000)
    expect(toHalf(65504)).toBe(0x7bff)
    expect(toHalf(1e9)).toBe(0x7bff) // clamps instead of producing Inf
    expect(toHalf(2.0009765625)).toBe(0x4001)
    expect(toHalf(0)).toBe(0)
  })
})

describe('LightGrid wall-aware light lists', () => {
  it('lists a fixture in the same room as fully visible and ranks by contribution', () => {
    const grid = new LightGrid()
    grid.addChunk(chunk(0, 0, 0, (d) => d.lamps.push({ lx: 5, lz: 5, lit: true }, { lx: 8, lz: 5, lit: true })))
    grid.flush()
    const l = lights(grid, 5, 6)
    expect(l.map((e) => [e.gx, e.gz])).toEqual([[5, 5], [8, 5]])
    expect(l.every((e) => e.vis === 1)).toBe(true)
  })

  it('never lists a fixture behind a solid wall (the leak chapter 12 §3.2 removes)', () => {
    const grid = new LightGrid()
    // Wall on line x = 6*CELL separates the lamp (x 7) from the receiver (x 5).
    grid.addChunk(chunk(0, 0, 0, (d) => {
      wallV(d, 6)
      d.lamps.push({ lx: 7, lz: 5, lit: true })
    }))
    grid.flush()
    expect(lights(grid, 5, 5)).toEqual([])
    expect(lights(grid, 7, 5)).toHaveLength(1)
    // Gameplay light matches: ambient only behind the wall, lit beside the lamp.
    expect(grid.lightAt((5 + 0.5) * CELL, (5 + 0.5) * CELL, 0)).toBeCloseTo(STALKER_AMBIENT, 6)
    expect(grid.lightAt((7 + 0.5) * CELL, (5 + 0.5) * CELL, 0)).toBeGreaterThan(0.9)
  })

  it('marks a fixture seen through a doorway as partial so the shader traces it', () => {
    const grid = new LightGrid()
    grid.addChunk(chunk(0, 0, 0, (d) => {
      wallV(d, 6)
      d.setV(6, 5, 0, PASSAGE_DOOR) // one doorway in the partition
      d.lamps.push({ lx: 8, lz: 5, lit: true })
    }))
    grid.flush()
    // Off-axis: only some paths from the cell thread the doorway.
    const [e] = lights(grid, 4, 6)
    expect(e).toBeDefined()
    expect(e.vis).toBeGreaterThan(0)
    expect(e.vis).toBeLessThan(1)
    // In line with the doorway every sampled path passes, but the partition
    // is inside the bounding box, so it still stays traced per pixel.
    const [straight] = lights(grid, 4, 5)
    expect(straight.vis).toBeGreaterThan(e.vis)
    expect(straight.vis).toBeLessThan(1)
    // From (4, 3) every straight path crosses the solid part of the wall.
    expect(lights(grid, 4, 3)).toEqual([])
  })

  it('keeps gameplay light curve-identical to the legacy window in open rooms', () => {
    const grid = new LightGrid()
    grid.addChunk(chunk(0, 0, 0, (d) => d.lamps.push({ lx: 5, lz: 5, lit: true })))
    grid.flush()
    for (const [x, z] of [[16.5, 16.5], [18, 15], [21, 20]]) {
      const d = Math.hypot(x - 16.5, z - 16.5)
      expect(grid.lightAt(x, z, 0)).toBeCloseTo(Math.min(1, STALKER_AMBIENT + cubicAttenuation(d)), 6)
    }
  })

  it('traces openings at the ray height: a door lintel blocks a high ray', () => {
    const grid = new LightGrid()
    grid.addChunk(chunk(0, 0, 0, (d) => {
      wallV(d, 6)
      d.setV(6, 5, 0, PASSAGE_DOOR)
      d.setV(6, 8, 1, PASSAGE_WALL, WALL_WINDOW)
      d.setV(6, 10, 1, PASSAGE_WALL, WALL_RAIL)
    }))
    const z = (5 + 0.5) * CELL
    expect(grid.segment(15, 1.0, z, 21, 1.0, z)).toBe(1)
    expect(grid.segment(15, DOOR_H + 0.3, z, 21, DOOR_H + 0.3, z)).toBe(0)
    const zw = (8 + 0.5) * CELL
    expect(grid.segment(15, 1.5, zw, 21, 1.5, zw)).toBe(GLASS_T)
    expect(grid.segment(15, 0.4, zw, 21, 0.4, zw)).toBe(0)
    const zr = (10 + 0.5) * CELL
    expect(grid.segment(15, 2.5, zr, 21, 2.5, zr)).toBe(1)
    expect(grid.segment(15, 0.5, zr, 21, 0.5, zr)).toBe(0)
  })

  it('reaches across chunk seams and forgets a departed chunk', () => {
    const grid = new LightGrid()
    grid.addChunk(chunk(0, 0, 0))
    grid.addChunk(chunk(1, 0, 0, (d) => d.lamps.push({ lx: 1, lz: 5, lit: true })))
    grid.flush()
    const gx = CHUNK - 1 // last column of chunk 0, two cells from the lamp
    expect(lights(grid, gx, 5).map((e) => e.gx)).toEqual([CHUNK + 1])
    grid.removeChunk(1, 0, 0)
    grid.flush()
    expect(lights(grid, gx, 5)).toEqual([])
    expect(grid.isMapped(1, 0, 0)).toBe(false)
  })

  it('bounds every list to LIST_MAX fixtures', () => {
    const grid = new LightGrid()
    grid.addChunk(chunk(0, 0, 0, (d) => {
      for (let x = 3; x <= 9; x++) for (let z = 3; z <= 9; z += 2) d.lamps.push({ lx: x, lz: z, lit: true })
    }))
    grid.flush()
    expect(lights(grid, 6, 6)).toHaveLength(LIST_MAX)
  })

  it('lets light cross floors only through a slab hole', () => {
    const lower = chunk(0, 0, 0, (d) => d.lamps.push({ lx: 6, lz: 6, lit: true }))
    const upper = chunk(0, 1, 0)
    const closed = new LightGrid()
    closed.addChunk(lower)
    closed.addChunk(upper)
    closed.flush()
    expect(lights(closed, 6, 6, 1)).toEqual([])

    // Open the slab over the lamp's neighbourhood (an atrium void).
    const holed = chunk(0, 0, 0, (d) => d.lamps.push({ lx: 6, lz: 8, lit: true }))
    holed.hasCeilHole = (lx, lz) => lx >= 5 && lx <= 7 && lz >= 5 && lz <= 7
    const above = chunk(0, 1, 0)
    above.hasFloorHole = holed.hasCeilHole
    const grid = new LightGrid()
    grid.addChunk(holed)
    grid.addChunk(above)
    grid.flush()
    const up = lights(grid, 6, 6, 1)
    expect(up.map((e) => e.cy)).toEqual([0])
    // The same fixture seen from beyond the void's footprint stays blocked.
    expect(lights(grid, 12, 12, 1)).toEqual([])
  })

  it('resolves vertical slot aliasing toward the player floor', () => {
    const grid = new LightGrid()
    const near = chunk(0, 0, 0, (d) => d.lamps.push({ lx: 2, lz: 2, lit: true }))
    const far = chunk(0, GRID_FLOORS, 0, (d) => d.lamps.push({ lx: 9, lz: 9, lit: true }))
    grid.addChunk(near)
    grid.addChunk(far)
    grid.flush()
    expect(grid.isMapped(0, 0, 0)).toBe(true)
    expect(grid.isMapped(0, GRID_FLOORS, 0)).toBe(false)
    expect(grid.lightAt(9 * CELL, 9 * CELL, GRID_FLOORS)).toBeNull() // no data -> caller falls back
    grid.setPlayerFloor(GRID_FLOORS)
    grid.flush()
    expect(grid.isMapped(0, GRID_FLOORS, 0)).toBe(true)
    expect(grid.isMapped(0, 0, 0)).toBe(false)
    expect(lights(grid, 9, 8, GRID_FLOORS)).toHaveLength(1)
  })

  it('keeps bounce inside the lit room: a sealed neighbour receives none', () => {
    const grid = new LightGrid()
    grid.setAlbedo({ floor: [0.5, 0.4, 0.2], wall: [0.6, 0.6, 0.5], ceiling: [0.6, 0.6, 0.6] })
    grid.addChunk(chunk(0, 0, 0, (d) => {
      wallV(d, 7) // fully sealed partition
      d.lamps.push({ lx: 3, lz: 7, lit: true })
    }))
    grid.flush()
    const lumOf = (gx, gz) => {
      const o = texelIndex(gx, gz, 0) * 12
      return grid.gi[o + 4] // +Y luminance, half-float bits (0 == zero)
    }
    expect(lumOf(3, 7)).toBeGreaterThan(0)
    expect(lumOf(10, 7)).toBe(0)
  })

  it('reports the uploaded texel rectangles and clears them once taken', () => {
    const grid = new LightGrid()
    grid.takeDirty()
    grid.addChunk(chunk(-1, 0, 0))
    const dirty = grid.takeDirty()
    // chunk -1 lives at the window's right edge: x = GRID_W - CHUNK.
    const edge = dirty.edge
    expect(edge.length).toBeGreaterThan(0)
    expect(edge[0]).toBe(GRID_W - CHUNK)
    expect(edge[2]).toBe(CHUNK)
    expect(grid.takeDirty().edge).toEqual([])
  })

  it('uses a finite, monotone physical falloff that reaches zero at range', () => {
    let prev = Infinity
    for (let d = 0.5; d < LIGHT_RANGE; d += 0.5) {
      const a = physicalAttenuation(d)
      expect(a).toBeLessThanOrEqual(prev)
      prev = a
    }
    expect(physicalAttenuation(LIGHT_RANGE)).toBe(0)
  })

  it('is deterministic for identical chunk data', () => {
    const make = () => {
      const g = new LightGrid()
      g.addChunk(chunk(0, 0, 0, (d) => {
        wallV(d, 6, 0, 8)
        d.lamps.push({ lx: 3, lz: 3, lit: true }, { lx: 9, lz: 4, lit: true }, { lx: 4, lz: 11, lit: true })
      }))
      g.flush()
      return g
    }
    const a = make()
    const b = make()
    expect(Buffer.from(a.list.buffer).equals(Buffer.from(b.list.buffer))).toBe(true)
    expect(Buffer.from(a.gi.buffer).equals(Buffer.from(b.gi.buffer))).toBe(true)
    // Fixture positions decode to the same world points the meshes use.
    const [x, y, z] = lampCellCentre(3, 3)
    let found = false
    a.forEachLight(3, 4, 0, (lx, ly, lz) => {
      if (lx === x && ly === y && lz === z) found = true
    })
    expect(found).toBe(true)
  })
})

describe('LightGrid job budgeting', () => {
  it('slices a chunk bake by rows and resumes where it stopped', () => {
    const build = () => {
      const g = new LightGrid()
      g.addChunk(chunk(0, 0, 0, (d) => {
        for (let x = 2; x < CHUNK; x += 4) for (let z = 2; z < CHUNK; z += 4) d.lamps.push({ lx: x, lz: z, lit: true })
      }))
      return g
    }
    const reference = build()
    reference.flush()
    const sliced = build()
    // A clock that expires after every row: each update() bakes one row.
    let t = 0
    const clock = () => t++
    let calls = 0
    while (sliced.pending && calls < 100) {
      sliced.update(0.5, clock)
      calls++
    }
    expect(calls).toBeGreaterThanOrEqual(CHUNK)
    expect(Buffer.from(sliced.list.buffer).equals(Buffer.from(reference.list.buffer))).toBe(true)
    expect(Buffer.from(sliced.gi.buffer).equals(Buffer.from(reference.gi.buffer))).toBe(true)
  })
})
