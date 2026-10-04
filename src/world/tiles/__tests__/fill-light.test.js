import { describe, expect, it } from 'vitest'
import { CHUNK, ZONE_OFFICE, chunkKey3 } from '../../constants.js'
import { ChunkData } from '../../ChunkData.js'
import { FILL_DEFAULTS, SPAWN_LEVEL, fillDarkCells, lightLevelAt, resolveFillSpec } from '../fillLight.js'
import { cellWalkable } from '../holeMasks.js'

// The bake's fill-light pass (tiles/fillLight.js, I-playfix) on hand-made
// chunks: one chunk-storey, a 6×6 room (cells 4..9) in solid mass.
const ROOM = Object.freeze({ x0: 4, z0: 4, x1: 9, z1: 9 })
const ctx = Object.freeze({ notes: [] })

function roomChunk({ spaceId = 0 } = {}) {
  const d = new ChunkData(0, 0, 0, ZONE_OFFICE)
  for (let lz = 0; lz < CHUNK; lz++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      const inside = lx >= ROOM.x0 && lx <= ROOM.x1 && lz >= ROOM.z0 && lz <= ROOM.z1
      if (!inside) d.setCol(lx, lz, 1)
      else d.spaceId[lz * CHUNK + lx] = spaceId
    }
  }
  return d
}
const mapOf = (d) => new Map([[chunkKey3(d.cx, d.cy, d.cz), d]])
const sourceOf = (map) => ({ chunkAt: (cx, cy, cz) => map.get(chunkKey3(cx, cy, cz)) ?? null })
const roomCells = () => {
  const out = []
  for (let gz = ROOM.z0; gz <= ROOM.z1; gz++) for (let gx = ROOM.x0; gx <= ROOM.x1; gx++) out.push([gx, gz])
  return out
}

describe('fill light (tiles/fillLight.js)', () => {
  it('lights a dark room (every cell in a fixture\'s light, most to the target level), fixtures spaced and capped', () => {
    const d = roomChunk()
    const map = mapOf(d)
    const n = fillDarkCells(map, resolveFillSpec({}, ctx))
    expect(n).toBeGreaterThan(0)
    expect(d.lamps.length).toBe(n)
    expect(d.lamps.filter((l) => l.lit).length).toBeLessThanOrEqual(FILL_DEFAULTS.cap)
    for (const l of d.lamps) {
      expect(cellWalkable(d, l.lx, l.lz)).toBe(true)
      expect(l.tint).toBeUndefined()
    }
    for (const [i, a] of d.lamps.entries()) {
      for (const b of d.lamps.slice(i + 1)) {
        expect(Math.max(Math.abs(a.lx - b.lx), Math.abs(a.lz - b.lz))).toBeGreaterThan(FILL_DEFAULTS.gap)
      }
    }
    // Every cell sees a fixture; the spacing rule may leave a corner short
    // of the target, never more than a fifth of the room.
    const src = sourceOf(map)
    const levels = roomCells().map(([gx, gz]) => lightLevelAt(src, gx, gz, 0))
    for (const v of levels) expect(v).toBeGreaterThan(0.01)
    expect(levels.filter((v) => v < FILL_DEFAULTS.level).length).toBeLessThanOrEqual(levels.length / 5)
    // Pure: the same chunk fills the same way.
    const again = roomChunk()
    fillDarkCells(mapOf(again), resolveFillSpec({}, ctx))
    expect(again.lamps).toEqual(d.lamps)
  })

  it('a dead fixture is authored darkness: nothing is hung or lit in its sight', () => {
    const d = roomChunk()
    d.lamps.push({ lx: 6, lz: 6, lit: false })
    expect(fillDarkCells(mapOf(d), resolveFillSpec({}, ctx))).toBe(0)
    expect(d.lamps).toEqual([{ lx: 6, lz: 6, lit: false }])
    // deadReach 0 turns the rule off.
    const e = roomChunk()
    e.lamps.push({ lx: 6, lz: 6, lit: false })
    expect(fillDarkCells(mapOf(e), resolveFillSpec({ deadReach: 0 }, ctx))).toBeGreaterThan(0)
  })

  it('the spawn is lit even inside authored darkness, and `where` / { off } skip the pass', () => {
    const d = roomChunk()
    d.lamps.push({ lx: 9, lz: 9, lit: false })
    const map = mapOf(d)
    const spec = resolveFillSpec({ where: () => false, spawn: () => [{ gx: 5, gz: 5 }] }, ctx)
    expect(fillDarkCells(map, spec)).toBe(1)
    expect(lightLevelAt(sourceOf(map), 5, 5, 0)).toBeGreaterThanOrEqual(SPAWN_LEVEL)
    expect(resolveFillSpec({ off: true }, ctx)).toBeNull()
    expect(resolveFillSpec(null, ctx)).toBeNull()
    expect(resolveFillSpec(() => null, ctx)).toBeNull()
  })

  it("rooms: 'lit' fills only rooms the tile already lights, in the room's tint (roomTint)", () => {
    const dark = roomChunk({ spaceId: 7 })
    expect(fillDarkCells(mapOf(dark), resolveFillSpec({ rooms: 'lit' }, ctx))).toBe(0)
    const lit = roomChunk({ spaceId: 7 })
    lit.lamps.push({ lx: 4, lz: 4, lit: true, tint: 0xff0000 })
    const n = fillDarkCells(mapOf(lit), resolveFillSpec({ rooms: 'lit', roomTint: true, tint: 0x00ff00 }, ctx))
    expect(n).toBeGreaterThan(0)
    for (const l of lit.lamps) expect(l.tint).toBe(0xff0000)
  })
})
