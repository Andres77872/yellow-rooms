import { describe, it, expect } from 'vitest'
import { generateChunk } from '../generate.js'
import { worldConfigForFamily } from '../mapFamily.js'
import { CHUNK } from '../constants.js'
import {
  CELL_VOID,
  PASSAGE_DOOR,
  SPACE_CLASS_ROOM,
  SPACE_ROLE_BATHROOM,
  SPACE_ROLE_KITCHEN,
  SPACE_ROLE_LAUNDRY,
  SPACE_ROLE_NONE,
} from '../mapTypes.js'
import {
  SPACE_CIRC,
  SPACE_ROOM,
  ZONE_EDGE_E,
  ZONE_EDGE_S,
  ZONE_LAYER_MASK,
  ZONE_MAP_SIZE,
  ZONE_WET,
  buildSurfaceZoneMap,
  cellRole,
  roomContext,
  seamContext,
  worldSurfaceSet,
} from '../surfaceSet.js'
import { familiesWith } from '../families/registry.js'

// Office-semantics matrix: only the building families (spec §11.4). The
// liminal families have their own per-family suites.
const BUILDING_FAMILIES = familiesWith('buildingMatrices')

// World-scale coherence of the finish schedule, measured on generated
// blocks of every family: the properties a player reads as "a building"
// rather than "a random texture per room".
const SEED = 4242
const N = 6 // chunks per side

function block(family, cy = 0) {
  const config = worldConfigForFamily(family)
  const chunks = new Map()
  for (let cz = 0; cz < N; cz++) for (let cx = 0; cx < N; cx++) chunks.set(`${cx},${cz}`, generateChunk(SEED, cx, cy, cz, config))
  const set = worldSurfaceSet(family, SEED)
  const maps = new Map()
  for (const [k, d] of chunks) {
    maps.set(k, buildSurfaceZoneMap(d, set, (dx, dz) => chunks.get(`${d.cx + dx},${d.cz + dz}`) ?? null))
  }
  const W = N * CHUNK
  const at = (gx, gz) => {
    const cx = Math.floor(gx / CHUNK)
    const cz = Math.floor(gz / CHUNK)
    const d = chunks.get(`${cx},${cz}`)
    const lx = gx - cx * CHUNK
    const lz = gz - cz * CHUNK
    const o = ((lz + 1) * ZONE_MAP_SIZE + lx + 1) * 4
    const m = maps.get(`${cx},${cz}`)
    return { d, lx, lz, raw: m[o], floor: m[o] & ZONE_LAYER_MASK, wall: m[o + 1], ceiling: m[o + 2], wear: m[o + 3] & 127, ctx: roomContext(d, lx, lz, set) }
  }
  // Is the edge from (gx, gz) to its east / south neighbour free of walls?
  const open = (gx, gz, east) => {
    const nx = east ? gx + 1 : gx
    const nz = east ? gz : gz + 1
    const n = at(nx, nz)
    return east ? !n.d.vAt(n.lx, n.lz) : !n.d.hAt(n.lx, n.lz)
  }
  const passage = (gx, gz, east) => {
    const n = at(east ? gx + 1 : gx, east ? gz : gz + 1)
    return east ? n.d.passageVAt(n.lx, n.lz) : n.d.passageHAt(n.lx, n.lz)
  }
  return { W, at, open, passage, set, chunks }
}

const blocks = new Map()
const blockOf = (family) => {
  if (!blocks.has(family)) blocks.set(family, block(family))
  return blocks.get(family)
}

describe('finish coherence on generated worlds', () => {
  it('gives every space exactly one finish', () => {
    for (const family of BUILDING_FAMILIES) {
      const { W, at } = blockOf(family)
      const byKey = new Map()
      for (let gz = 0; gz < W; gz++) {
        for (let gx = 0; gx < W; gx++) {
          const c = at(gx, gz)
          const triple = `${c.floor}/${c.wall}/${c.ceiling}`
          const seen = byKey.get(c.ctx.key)
          if (seen === undefined) byKey.set(c.ctx.key, triple)
          else expect(triple, `${family} space ${c.ctx.key}`).toBe(seen)
        }
      }
    }
  })

  it('runs one continuous circulation finish through a storey', () => {
    for (const family of BUILDING_FAMILIES) {
      const { W, at } = blockOf(family)
      const floors = new Set()
      for (let gz = 0; gz < W; gz++) for (let gx = 0; gx < W; gx++) {
        const c = at(gx, gz)
        if (c.ctx.cls === SPACE_CIRC && c.d.cellKind[c.lz * CHUNK + c.lx] !== CELL_VOID) floors.add(c.floor)
      }
      expect(floors.size, family).toBe(1)
    }
  })

  it('changes floor only where two spaces meet, and marks every change with a strip', () => {
    for (const family of BUILDING_FAMILIES) {
      const { W, at, open } = blockOf(family)
      let changes = 0
      for (let gz = 0; gz < W - 1; gz++) for (let gx = 0; gx < W - 1; gx++) {
        const a = at(gx, gz)
        if (a.d.cellKind[a.lz * CHUNK + a.lx] === CELL_VOID) continue
        for (const east of [true, false]) {
          const b = east ? at(gx + 1, gz) : at(gx, gz + 1)
          if (b.d.cellKind[b.lz * CHUNK + b.lx] === CELL_VOID) continue
          if (a.floor === b.floor) {
            expect(a.raw & (east ? ZONE_EDGE_E : ZONE_EDGE_S)).toBe(0)
            continue
          }
          changes++
          expect(a.ctx.key, `${family} floor change inside one space`).not.toBe(b.ctx.key)
          expect(a.raw & (east ? ZONE_EDGE_E : ZONE_EDGE_S), `${family} unmarked change`).not.toBe(0)
          if (open(gx, gz, east)) expect(a.ctx.cls === b.ctx.cls && a.ctx.category === b.ctx.category && a.ctx.cls === SPACE_CIRC).toBe(false)
        }
      }
      expect(changes, family).toBeGreaterThanOrEqual(0)
    }
  })

  it('fits out a department consistently: same-category rooms of a district share a package', () => {
    for (const family of BUILDING_FAMILIES) {
      const { W, at } = blockOf(family)
      const rooms = new Map() // key -> ctx
      for (let gz = 0; gz < W; gz++) for (let gx = 0; gx < W; gx++) {
        const c = at(gx, gz)
        if (c.ctx.cls === SPACE_ROOM) rooms.set(c.ctx.key, { ...c.ctx, storey: c.d.cy })
      }
      const groups = new Map()
      for (const r of rooms.values()) {
        const k = `${r.district}|${r.category}`
        if (!groups.has(k)) groups.set(k, [])
        groups.get(k).push(r.package)
      }
      let agree = 0
      let total = 0
      for (const packages of groups.values()) {
        if (packages.length < 3) continue
        const ones = packages.filter((p) => p === 1).length
        agree += Math.max(ones, packages.length - ones)
        total += packages.length
      }
      if (total) expect(agree / total, family).toBeGreaterThan(0.85)
    }
  })

  it('keeps wet rooms on washable finishes', () => {
    for (const family of BUILDING_FAMILIES) {
      const { W, at, set } = blockOf(family)
      for (let gz = 0; gz < W; gz++) for (let gx = 0; gx < W; gx++) {
        const c = at(gx, gz)
        const role = c.d.spaceRole[c.lz * CHUNK + c.lx]
        if (c.ctx.cls !== SPACE_ROOM || ![SPACE_ROLE_BATHROOM, SPACE_ROLE_KITCHEN, SPACE_ROLE_LAUNDRY].includes(role)) continue
        expect(c.ctx.category).toBe(ZONE_WET)
        expect(['carpet', 'carpetPattern', 'carpetTile', 'parquet', 'planks']).not.toContain(set.floor[c.floor].style)
      }
    }
  })

  it('ages neighbouring spaces together instead of salt-and-pepper wear', () => {
    for (const family of BUILDING_FAMILIES) {
      const { W, at, open } = blockOf(family)
      let sum = 0
      let n = 0
      for (let gz = 0; gz < W - 1; gz++) for (let gx = 0; gx < W - 1; gx++) {
        for (const east of [true, false]) {
          if (!open(gx, gz, east)) continue
          const a = at(gx, gz)
          const b = east ? at(gx + 1, gz) : at(gx, gz + 1)
          if (a.ctx.key === b.ctx.key) continue
          sum += Math.abs(a.wear - b.wear)
          n++
        }
      }
      if (n) expect(sum / n, family).toBeLessThan(18)
    }
  })

  it('sees across a chunk seam what the neighbour itself resolves', () => {
    // The planner's seam ring stands in for the neighbour chunk, so doors and
    // windows on a chunk's own line 0 classify from both of their sides.
    let planned = 0
    for (const family of BUILDING_FAMILIES) {
      const { chunks, set } = blockOf(family)
      for (let cz = 1; cz < N; cz++) {
        for (let cx = 1; cx < N; cx++) {
          const d = chunks.get(`${cx},${cz}`)
          for (const [axis, nb] of [['v', chunks.get(`${cx - 1},${cz}`)], ['h', chunks.get(`${cx},${cz - 1}`)]]) {
            for (let c = 0; c < CHUNK; c++) {
              const seen = seamContext(d, axis, c, set)
              if (!seen) continue
              planned++
              const real = axis === 'v' ? roomContext(nb, CHUNK - 1, c, set) : roomContext(nb, c, CHUNK - 1, set)
              const pick = ({ cls, category, role, key, district, floor, wall, ceiling, decay }) => ({ cls, category, role, key, district, floor, wall, ceiling, decay })
              expect(pick(seen), `${family} ${cx},${cz} ${axis}${c}`).toEqual(pick(real))
            }
          }
        }
      }
    }
    expect(planned).toBeGreaterThan(1000)
  })

  it('sees the neighbour beside its landmarks on other storeys too', () => {
    // A structure stamp clears its footprint and a one-cell ring around it to
    // a role-less hall / lobby; the ring mirrors that, below ground and up a
    // tower as on the ground floor, and on both sides of the origin.
    // A room cell in that ring keeps its room's role (cellRole), so the ring
    // reports the plan's role where the stamp cleared the neighbour's byte.
    const pick = ({ cls, category, role, key, district, floor, wall, ceiling, decay }) => ({ cls, category, role, key, district, floor, wall, ceiling, decay })
    let planned = 0
    let cleared = 0
    for (const family of ['tower', 'hotel']) {
      const config = worldConfigForFamily(family)
      for (const [seed, cy] of [[1, -2], [5, 2]]) {
        const set = worldSurfaceSet(family, seed)
        const chunks = new Map()
        // Takes in the review's repro seams: tower 1 / -2 at chunk (3,-2) and
        // 5 / 2 at (5,1), both beside a skybridge.
        for (let cz = -3; cz < 3; cz++) for (let cx = -3; cx < 6; cx++) chunks.set(`${cx},${cz}`, generateChunk(seed, cx, cy, cz, config))
        for (let cz = -2; cz < 3; cz++) {
          for (let cx = -2; cx < 6; cx++) {
            const d = chunks.get(`${cx},${cz}`)
            for (const [axis, nb] of [['v', chunks.get(`${cx - 1},${cz}`)], ['h', chunks.get(`${cx},${cz - 1}`)]]) {
              for (let c = 0; c < CHUNK; c++) {
                const seen = seamContext(d, axis, c, set)
                if (!seen) continue
                planned++
                const real = axis === 'v' ? roomContext(nb, CHUNK - 1, c, set) : roomContext(nb, c, CHUNK - 1, set)
                expect(pick(seen), `${family} ${seed} ${cy} ${cx},${cz} ${axis}${c}`).toEqual(pick(real))
                const byte = axis === 'v' ? nb.spaceRole[c * CHUNK + CHUNK - 1] : nb.spaceRole[(CHUNK - 1) * CHUNK + c]
                if (seen.role !== byte) cleared++
              }
            }
          }
        }
      }
    }
    expect(planned).toBeGreaterThan(2500)
    expect(cleared).toBeGreaterThan(0)
  }, 60_000) // generates a few hundred chunks: slow under full-suite load

  it('keeps one finish across a whole room, stamp-cleared strips included', () => {
    // A structure halo, catalogue ring or stair halo relabels the strip of a
    // room it borders as role-less lobby, while the planner's id and class
    // still give the strip to that room. The room keeps one package, one
    // category and one role (door signs read it) over all of its cells —
    // across chunk seams, on both sides of the origin, storey after storey.
    for (const family of ['tower', 'office', 'lattice', 'hotel']) {
      const config = worldConfigForFamily(family)
      const bad = []
      let cleared = 0
      for (const seed of [4242, 101, 131]) {
        const set = worldSurfaceSet(family, seed)
        for (let cy = 0; cy <= 2; cy++) {
          const rooms = new Map()
          for (let cz = -3; cz < 3; cz++) {
            for (let cx = -3; cx < 3; cx++) {
              const d = generateChunk(seed, cx, cy, cz, config)
              for (let lz = 0; lz < CHUNK; lz++) {
                for (let lx = 0; lx < CHUNK; lx++) {
                  const c = roomContext(d, lx, lz, set)
                  if (c.cls !== SPACE_ROOM) continue
                  if (c.role !== d.spaceRole[lz * CHUNK + lx]) cleared++
                  const finish = `${c.category} role ${c.role} ${c.floor}/${c.wall}/${c.ceiling}`
                  const seen = rooms.get(c.key)
                  if (seen === undefined) rooms.set(c.key, finish)
                  else if (finish !== seen) bad.push(`${seed} cy${cy} ${cx},${cz} ${lx},${lz} room ${c.key}: ${finish} vs ${seen}`)
                }
              }
            }
          }
        }
      }
      expect(bad.slice(0, 5), family).toEqual([])
      // The sample really holds stamp-cleared room strips in every family.
      expect(cleared, family).toBeGreaterThan(0)
    }
  }, 60_000) // generates a few hundred chunks: slow under full-suite load

  it('reads a cleared room role back from the room itself without a plan', () => {
    // An editor document carries no plan (structuredClone drops the seam
    // source too): a cleared strip takes the role most of the room's cells in
    // the chunk carry, re-read on every call as the author repaints.
    const config = worldConfigForFamily('tower')
    let recovered = 0
    for (let cy = 0; cy <= 2; cy++) {
      for (let cz = -3; cz < 3; cz++) {
        for (let cx = -3; cx < 3; cx++) {
          const d = generateChunk(SEED, cx, cy, cz, config)
          const doc = structuredClone(d)
          expect(doc.seam).toBeUndefined()
          for (let i = 0; i < CHUNK * CHUNK; i++) {
            const lx = i % CHUNK
            const lz = (i / CHUNK) | 0
            const planned = cellRole(d, lx, lz)
            if (planned === d.spaceRole[i]) continue
            expect(d.spaceClass[i]).toBe(SPACE_CLASS_ROOM)
            let carried = false
            for (let j = 0; j < CHUNK * CHUNK; j++) carried ||= d.spaceId[j] === d.spaceId[i] && d.spaceRole[j] !== SPACE_ROLE_NONE
            // A room whose whole part in this chunk was cleared has nothing to
            // read back from: it stays role-less.
            expect(cellRole(doc, lx, lz)).toBe(carried ? planned : SPACE_ROLE_NONE)
            if (!carried) continue
            recovered++
            const repaint = planned === SPACE_ROLE_BATHROOM ? SPACE_ROLE_KITCHEN : SPACE_ROLE_BATHROOM
            const was = doc.spaceRole.slice()
            for (let j = 0; j < CHUNK * CHUNK; j++) if (doc.spaceId[j] === doc.spaceId[i] && doc.spaceRole[j] !== SPACE_ROLE_NONE) doc.spaceRole[j] = repaint
            expect(cellRole(doc, lx, lz)).toBe(repaint)
            doc.spaceRole.set(was)
          }
        }
      }
    }
    expect(recovered).toBeGreaterThan(0)
  })

  it('keeps doors as the usual place a room and its corridor differ', () => {
    // Every floor change across a wall-free edge is either a door / wide
    // passage or the edge of a landmark — never two halves of one corridor.
    for (const family of BUILDING_FAMILIES) {
      const { W, at, open, passage } = blockOf(family)
      for (let gz = 0; gz < W - 1; gz++) for (let gx = 0; gx < W - 1; gx++) {
        for (const east of [true, false]) {
          if (!open(gx, gz, east)) continue
          const a = at(gx, gz)
          const b = east ? at(gx + 1, gz) : at(gx, gz + 1)
          if (a.floor === b.floor || passage(gx, gz, east) === PASSAGE_DOOR) continue
          expect(a.ctx.cls === SPACE_CIRC && b.ctx.cls === SPACE_CIRC, `${family} corridor split`).toBe(false)
        }
      }
    }
  })
})
