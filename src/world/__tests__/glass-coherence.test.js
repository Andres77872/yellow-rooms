import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { generateChunk } from '../generate.js'
import { worldConfigForFamily } from '../mapFamily.js'
import { CHUNK, cIdx, hIdx, vIdx } from '../constants.js'
import { ChunkData } from '../ChunkData.js'
import { buildChunkMeshes, buildFurniturePart } from '../mesh.js'
import { GLASS_CRACKED, GLASS_FROSTED, GLASS_TAPED } from '../glassKinds.js'
import {
  CELL_CORRIDOR,
  CELL_ROOM,
  MAP_FAMILY_HOTEL,
  MAP_FAMILY_OFFICE,
  MAP_FAMILY_TOWER,
  SPACE_CLASS_CIRCULATION,
  SPACE_CLASS_ROOM,
  SPACE_ROLE_BATHROOM,
  SPACE_ROLE_BEDROOM,
  SPACE_ROLE_OFFICE,
  WALL_WINDOW,
} from '../mapTypes.js'
import { SPACE_HALL, SPACE_ROOM, ZONE_WET, roomContext, worldSurfaceSet } from '../surfaceSet.js'
import { GLASS_DERELICT, GLASS_LIVED_IN, windowGlazing } from '../glazing.js'
import { FURN_TINT, furnitureTint, furnitureWear } from '../objects/furniture/palette.js'
import { FURN_CHAIR } from '../furniture.js'
import { pushFurnitureModel } from '../objects/furniture/index.js'
import { createGeometries, disposeGeometries } from '../../render/geometries.js'
import { familiesWith } from '../families/registry.js'

// Office-semantics matrix: only the building families (spec §11.4). The
// liminal families have their own per-family suites.
const BUILDING_FAMILIES = familiesWith('buildingMatrices')

// World-scale coherence of the glazing and the furniture batches, measured
// on generated blocks of every family (see finish-coherence.test.js): a
// gallery screen is one designed thing, a room's chairs are one purchase.
const SEEDS = [4242, 9001]
const N = 6 // chunks per side
const STOREYS = [0, 1, 2]
const GALLERY_FAMILIES = [MAP_FAMILY_OFFICE, MAP_FAMILY_HOTEL, MAP_FAMILY_TOWER]

const barsOf = (tone) => (tone < 0.45 ? 'cross' : tone < 0.8 ? 'bar' : 'blind')
const isPrivate = (c) =>
  !!c && c.cls === SPACE_ROOM && (c.category === ZONE_WET || c.role === SPACE_ROLE_BATHROOM || c.role === SPACE_ROLE_BEDROOM)
// The screen a window belongs to, from the global view: its landmark (else
// the pair of spaces it divides) and what it faces.
const facingOf = (w) => (isPrivate(w.lo) || isPrivate(w.hi) ? 2 : w.lo?.cls === SPACE_ROOM || w.hi?.cls === SPACE_ROOM ? 1 : 0)
function screenOf(w) {
  const hall = w.lo?.cls === SPACE_HALL ? w.lo : w.hi?.cls === SPACE_HALL ? w.hi : null
  return `${hall ? hall.key : w.pair}|${facingOf(w)}`
}

function windowEdges(d) {
  const out = []
  for (const axis of ['v', 'h']) {
    for (let line = 0; line < CHUNK; line++) {
      for (let cell = 0; cell < CHUNK; cell++) {
        const i = axis === 'v' ? vIdx(line, cell) : hIdx(cell, line)
        const wall = axis === 'v' ? d.wallV[i] : d.wallH[i]
        const feature = axis === 'v' ? d.wallFeatureV[i] : d.wallFeatureH[i]
        if (wall === 1 && feature === WALL_WINDOW) out.push({ axis, line, cell })
      }
    }
  }
  return out
}

// One storey block: every chunk, every window with its glazing and both
// sides resolved from the GLOBAL view (the test may read neighbours; the
// mesher may not), and every furniture record with its tint.
function block(family, seed, cy) {
  const config = worldConfigForFamily(family)
  const set = worldSurfaceSet(family, seed)
  const chunks = new Map()
  for (let cz = 0; cz < N; cz++) for (let cx = 0; cx < N; cx++) chunks.set(`${cx},${cz}`, generateChunk(seed, cx, cy, cz, config))
  const ctxAt = (gx, gz) => {
    const cx = Math.floor(gx / CHUNK)
    const cz = Math.floor(gz / CHUNK)
    const d = chunks.get(`${cx},${cz}`)
    return d ? roomContext(d, gx - cx * CHUNK, gz - cz * CHUNK, set) : null
  }
  const windows = new Map()
  const furniture = []
  for (const d of chunks.values()) {
    for (const { axis, line, cell } of windowEdges(d)) {
      const v = axis === 'v'
      const gline = (v ? d.cx : d.cz) * CHUNK + line
      const along = (v ? d.cz : d.cx) * CHUNK + cell
      const lo = v ? ctxAt(gline - 1, along) : ctxAt(along, gline - 1)
      const hi = v ? ctxAt(gline, along) : ctxAt(along, gline)
      const pair = [lo?.key ?? 0, hi?.key ?? 0].sort((a, b) => a - b).join('|')
      const g = windowGlazing(d, axis, line, cell, set)
      windows.set(`${axis}:${gline}:${along}`, { axis, gline, along, partial: line === 0, lo, hi, pair, g })
    }
    for (const f of d.furniture) {
      const c = roomContext(d, f.lx, f.lz, set)
      furniture.push({ d, f, ctx: c, tint: furnitureTint(d, f, set) })
    }
  }
  return { chunks, windows, furniture, set }
}

const blocks = new Map()
function blocksOf(family) {
  if (!blocks.has(family)) {
    const list = []
    for (const seed of SEEDS) for (const cy of STOREYS) list.push({ seed, cy, ...block(family, seed, cy) })
    blocks.set(family, list)
  }
  return blocks.get(family)
}

// Adjacent panes of one screen: same axis and line, neighbouring cells,
// between the same two spaces.
function* runPairs(windows) {
  for (const w of windows.values()) {
    const n = windows.get(`${w.axis}:${w.gline}:${w.along + 1}`)
    if (n && n.pair === w.pair) yield [w, n]
  }
}

describe('glazing coherence on generated worlds', () => {
  it('finds gallery screens to measure', () => {
    for (const family of GALLERY_FAMILIES) {
      const count = blocksOf(family).reduce((n, b) => n + b.windows.size, 0)
      expect(count, family).toBeGreaterThan(20)
    }
  })

  it('keeps one glazing system along a screen', () => {
    for (const family of BUILDING_FAMILIES) {
      let pairs = 0
      let changes = 0
      for (const { windows } of blocksOf(family)) {
        for (const [a, b] of runPairs(windows)) {
          pairs++
          if (barsOf(a.g.tone) === barsOf(b.g.tone)) continue
          changes++
          // Both sides in view: the run key is exact, never a re-roll.
          expect(a.partial || b.partial, `${family} bars change mid-screen`).toBe(true)
        }
      }
      if (pairs) expect(changes / pairs, family).toBeLessThan(0.1) // was 62-79% per adjacent pair
    }
  })

  it('turns a corner with the same glazing system', () => {
    let corners = 0
    for (const family of GALLERY_FAMILIES) {
      for (const { windows } of blocksOf(family)) {
        for (const w of windows.values()) {
          if (w.axis !== 'v' || w.partial) continue
          // The 'h' windows meeting this one at either end: grid vertex
          // (gline, z), cells gline-1 and gline of line z.
          for (const z of [w.along, w.along + 1]) {
            for (const x of [w.gline - 1, w.gline]) {
              const h = windows.get(`h:${z}:${x}`)
              if (!h || h.partial || screenOf(h) !== screenOf(w)) continue
              corners++
              expect(barsOf(h.g.tone), `${family} corner at ${w.gline},${z}`).toBe(barsOf(w.g.tone)) // was 60-90% different
            }
          }
        }
      }
    }
    expect(corners).toBeGreaterThan(20)
  })

  it('varies the texture detail per pane, even across a corner', () => {
    for (const family of GALLERY_FAMILIES) {
      let cells = 0
      let same = 0
      for (const { windows } of blocksOf(family)) {
        for (const w of windows.values()) {
          // A cell glazed on its west and its north edge.
          const h = w.axis === 'v' && windows.get(`h:${w.along}:${w.gline}`)
          if (!h) continue
          cells++
          if (h.g.seed === w.g.seed) same++
        }
      }
      if (cells) expect(same / cells, family).toBeLessThan(0.1) // was every one: the same crack star twice
    }
  })

  it('changes pane kind in stretches, not per pane', () => {
    for (const family of BUILDING_FAMILIES) {
      let pairs = 0
      let changes = 0
      for (const { windows } of blocksOf(family)) {
        for (const [a, b] of runPairs(windows)) {
          pairs++
          if (a.g.kind !== b.g.kind) changes++
        }
      }
      if (pairs) expect(changes / pairs, family).toBeLessThan(0.1) // was 54-67%
    }
  })

  it('breaks glass only where the screen is worn, cracks only in derelict wings', () => {
    for (const family of BUILDING_FAMILIES) {
      for (const { windows } of blocksOf(family)) {
        for (const w of windows.values()) {
          const worse = Math.max(w.lo?.decay ?? 0, w.hi?.decay ?? 0)
          if (!w.partial) expect(w.g.decay).toBeCloseTo(worse, 9)
          if (w.g.kind === GLASS_TAPED || w.g.kind === GLASS_CRACKED) {
            expect(w.g.decay, `${family} damaged pane in a lived-in run`).toBeGreaterThanOrEqual(GLASS_LIVED_IN)
          }
          if (w.g.kind === GLASS_CRACKED) expect(w.g.decay, family).toBeGreaterThanOrEqual(GLASS_DERELICT)
        }
      }
    }
  })

  it('frosts only private screens', () => {
    for (const family of BUILDING_FAMILIES) {
      for (const { windows } of blocksOf(family)) {
        for (const w of windows.values()) {
          const priv = isPrivate(w.lo) || isPrivate(w.hi)
          if (w.g.kind === GLASS_FROSTED) expect(priv, `${family} frosted public gallery`).toBe(true)
          if (priv && !w.partial) expect(w.g.kind, family).toBe(GLASS_FROSTED)
        }
      }
    }
  })

  it('is deterministic and independent of streaming order', () => {
    for (const family of GALLERY_FAMILIES) {
      const { seed, cy, chunks, windows } = blocksOf(family)[0]
      for (const d of chunks.values()) {
        const edges = windowEdges(d)
        if (!edges.length) continue
        // A chunk generated alone, through the default surface-set lookup, agrees.
        const again = generateChunk(seed, d.cx, cy, d.cz, worldConfigForFamily(family))
        for (const { axis, line, cell } of edges) {
          const v = axis === 'v'
          const key = `${axis}:${(v ? d.cx : d.cz) * CHUNK + line}:${(v ? d.cz : d.cx) * CHUNK + cell}`
          expect(windowGlazing(again, axis, line, cell)).toEqual(windows.get(key).g)
        }
      }
    }
  })
})

// A hand-built screen: corridor cells west of line 5, a room east of it,
// windows on cells 3..8 of that line.
function screenChunk(role, line = 5, family = MAP_FAMILY_OFFICE) {
  const d = new ChunkData(2, 0, 3, 0, undefined, family)
  d.worldSeed = 77
  for (let z = 0; z < CHUNK; z++) {
    for (let x = 0; x < CHUNK; x++) {
      const i = cIdx(x, z)
      const room = x >= line
      d.cellKind[i] = room ? CELL_ROOM : CELL_CORRIDOR
      d.spaceId[i] = room ? 22 : 11
      d.spaceClass[i] = room ? SPACE_CLASS_ROOM : SPACE_CLASS_CIRCULATION
      d.spaceRole[i] = room ? role : 0
    }
  }
  for (let z = 3; z <= 8; z++) d.setV(line, z, 1, undefined, WALL_WINDOW)
  return d
}

describe('glazing by function', () => {
  it('frosts a whole screen into a bathroom or bedroom, with one bar system', () => {
    for (const role of [SPACE_ROLE_BATHROOM, SPACE_ROLE_BEDROOM]) {
      const d = screenChunk(role)
      const panes = []
      for (let z = 3; z <= 8; z++) panes.push(windowGlazing(d, 'v', 5, z))
      expect(panes.every((p) => p.kind === GLASS_FROSTED)).toBe(true)
      expect(new Set(panes.map((p) => p.tone)).size).toBe(1)
      expect(new Set(panes.map((p) => p.run)).size).toBe(1)
      // Texture detail stays per pane.
      expect(new Set(panes.map((p) => p.seed)).size).toBeGreaterThan(1)
    }
  })

  it('never frosts a screen into an ordinary room', () => {
    const d = screenChunk(SPACE_ROLE_OFFICE)
    const panes = []
    for (let z = 3; z <= 8; z++) panes.push(windowGlazing(d, 'v', 5, z))
    expect(panes.some((p) => p.kind === GLASS_FROSTED)).toBe(false)
    expect(new Set(panes.map((p) => p.tone)).size).toBe(1)
  })

  it('keys a seam screen on its in-chunk side, consistently along the line', () => {
    // Line 0: the corridor side lies in the neighbouring chunk.
    const d = screenChunk(SPACE_ROLE_OFFICE, 0)
    const panes = []
    for (let z = 3; z <= 8; z++) panes.push(windowGlazing(d, 'v', 0, z))
    expect(new Set(panes.map((p) => p.run)).size).toBe(1)
    expect(new Set(panes.map((p) => p.tone)).size).toBe(1)
  })
})

// The mesher really draws what glazing.js decides: the first panes of the
// glass batch are the windows (door vision lites follow them).
describe('glazing in the chunk mesh', () => {
  it('feeds each pane its glazing kind, seed and grime', () => {
    const { chunks, set } = blocksOf(MAP_FAMILY_HOTEL)[0]
    const d = [...chunks.values()].find((c) => windowEdges(c).length)
    const geom = createGeometries()
    const m = new THREE.MeshBasicMaterial()
    const materials = Object.fromEntries(
      ['carpet', 'ceiling', 'wallpaper', 'doorFrame', 'doorLeaf', 'prop', 'signGlow', 'furniture', 'panel', 'panelDead', 'exit', 'glass'].map((k) => [k, m])
    )
    const mesh = buildChunkMeshes(d, geom, materials, 0, 0, 0)
    const glass = mesh.parts.glass
    const edges = windowEdges(d)
    expect(glass.count).toBeGreaterThanOrEqual(edges.length)
    const c = new THREE.Color()
    edges.forEach(({ axis, line, cell }, i) => {
      const g = windowGlazing(d, axis, line, cell, set)
      glass.getColorAt(i, c)
      expect(c.r).toBeCloseTo(g.kind, 5)
      expect(c.g).toBeCloseTo(g.seed, 5)
      expect(c.b).toBeCloseTo(g.dirt, 5)
    })
    mesh.dispose()
    disposeGeometries(geom)
    m.dispose()
  })
})

describe('furniture batches', () => {
  it('gives every piece of one kind in one room the identical tint, across seams', () => {
    for (const family of BUILDING_FAMILIES) {
      let shared = 0
      for (const { furniture } of blocksOf(family)) {
        const byLot = new Map()
        for (const p of furniture) {
          const k = `${p.ctx.key}|${p.f.kind}`
          const seen = byLot.get(k)
          if (!seen) byLot.set(k, p.tint)
          else {
            shared++
            expect(p.tint, `${family} room ${p.ctx.key} kind ${p.f.kind}`).toEqual(seen)
          }
        }
      }
      expect(shared, family).toBeGreaterThan(0) // was: every piece its own cell tint
    }
  })

  it('drifts a little between rooms and stays within the modelled colours', () => {
    for (const family of BUILDING_FAMILIES) {
      const lots = new Set()
      let pieces = 0
      for (const { furniture } of blocksOf(family)) {
        for (const p of furniture) {
          for (const v of p.tint) {
            expect(v).toBeGreaterThan(0.9)
            expect(v).toBeLessThan(1.08)
          }
          lots.add(p.tint.join(','))
          pieces++
        }
      }
      expect(lots.size, family).toBeGreaterThan(5)
      expect(lots.size, family).toBeLessThan(pieces * 0.85) // was one tint per piece
    }
  })

  it('wears pieces in derelict wings darker than lived-in ones', () => {
    const sum = [0, 0]
    const n = [0, 0]
    for (const family of BUILDING_FAMILIES) {
      for (const { set, furniture } of blocksOf(family)) {
        for (const p of furniture) {
          // Bucketed by the wear the lot actually shows.
          const wear = furnitureWear(p.d, p.f, set)
          if (wear >= GLASS_LIVED_IN && wear < GLASS_DERELICT) continue
          const band = wear < GLASS_LIVED_IN ? 0 : 1
          sum[band] += (p.tint[0] + p.tint[1] + p.tint[2]) / 3
          n[band]++
        }
      }
    }
    expect(n[0]).toBeGreaterThan(0)
    expect(n[1]).toBeGreaterThan(0)
    expect(sum[0] / n[0] - sum[1] / n[1]).toBeGreaterThan(0.012) // ~0.024; the per-cell dice gave 0.0009
  })

  it('ages a room the chunk wholly holds with its own floor', () => {
    for (const family of BUILDING_FAMILIES) {
      let held = 0
      for (const { set, furniture } of blocksOf(family)) {
        for (const p of furniture) {
          const id = p.d.spaceId[cIdx(p.f.lx, p.f.lz)]
          if (!id) continue
          let sum = 0
          let cells = 0
          let border = false
          for (let z = 0; z < CHUNK; z++) {
            for (let x = 0; x < CHUNK; x++) {
              if (p.d.spaceId[cIdx(x, z)] !== id) continue
              if (x === 0 || z === 0 || x === CHUNK - 1 || z === CHUNK - 1) border = true
              sum += roomContext(p.d, x, z, set).decay
              cells++
            }
          }
          // Sewer chambers are keyed per chunk, so they always qualify.
          if (border && !(p.d.mapFamily === 'sewer' && p.ctx.cls === SPACE_ROOM)) continue
          held++
          expect(Math.abs(furnitureWear(p.d, p.f, set) - sum / cells), `${family} room ${p.ctx.key}`).toBeLessThan(0.04)
        }
      }
      expect(held, family).toBeGreaterThan(0) // the department centre used to stand in: up to 0.8 off
    }
  })

  it('darkens a room\'s lot with the wear where it stands, and agrees across a seam', () => {
    // One interior room, same key / kind / department, moved over the wear
    // field: only its wear changes.
    const room = (cx, cz, x0, x1) => {
      const d = new ChunkData(cx, 0, cz, 0, undefined, MAP_FAMILY_OFFICE)
      d.worldSeed = 77
      d.district = { dx: 0, dz: 0 }
      for (let z = 0; z < CHUNK; z++) {
        for (let x = 0; x < CHUNK; x++) {
          const i = cIdx(x, z)
          const inRoom = x >= x0 && x <= x1 && z >= 4 && z <= 8
          d.cellKind[i] = inRoom ? CELL_ROOM : CELL_CORRIDOR
          d.spaceId[i] = inRoom ? 22 : 11
          d.spaceClass[i] = inRoom ? SPACE_CLASS_ROOM : SPACE_CLASS_CIRCULATION
        }
      }
      return d
    }
    const luma = (t) => (t[0] + t[1] + t[2]) / 3
    let lived = null
    let derelict = null
    for (let cz = -20; cz <= 20; cz++) {
      for (let cx = -20; cx <= 20; cx++) {
        const d = room(cx, cz, 4, 8)
        const f = { kind: FURN_CHAIR, lx: 6, lz: 6 }
        const wear = furnitureWear(d, f)
        if (!lived && wear < 0.3) lived = furnitureTint(d, f)
        if (!derelict && wear > 0.9) derelict = furnitureTint(d, f)
      }
    }
    expect(lived).not.toBeNull()
    expect(derelict).not.toBeNull()
    expect(luma(derelict) / luma(lived)).toBeLessThan(0.985)

    // A room across the seam between two chunks: each half sees only its own
    // cells, both read the department's wear and buy the same lot.
    const west = room(4, 2, 10, 13)
    const east = room(5, 2, 0, 3)
    expect(furnitureTint(west, { kind: FURN_CHAIR, lx: 11, lz: 6 })).toEqual(furnitureTint(east, { kind: FURN_CHAIR, lx: 2, lz: 6 }))
  })

  it('is deterministic per chunk', () => {
    for (const family of BUILDING_FAMILIES) {
      const { seed, cy, furniture } = blocksOf(family)[0]
      const p = furniture[0]
      if (!p) continue
      const again = generateChunk(seed, p.d.cx, cy, p.d.cz, worldConfigForFamily(family))
      const f = again.furniture.find((r) => r.lx === p.f.lx && r.lz === p.f.lz)
      expect(furnitureTint(again, f)).toEqual(p.tint)
    }
  })

  it('applies the same batch on the GLB path and the box fallback', () => {
    const { furniture } = blocksOf(MAP_FAMILY_OFFICE)[0]
    const d = furniture.find((p) => p.d.furniture.length > 3).d
    const geom = createGeometries()
    const m = new THREE.MeshBasicMaterial()
    const materials = { furniture: m, furnitureModel: m }
    const c = new THREE.Color()

    const kinds = [...new Set(d.furniture.map((f) => f.kind))]
    const models = { geometries: new Map(kinds.map((k) => [k, new THREE.BoxGeometry(1, 1, 1)])) }
    const glb = buildFurniturePart(d, geom, materials, models)
    for (const batch of glb.children) {
      const kind = kinds.find((k) => models.geometries.get(k) === batch.geometry)
      d.furniture.filter((f) => f.kind === kind).forEach((f, i) => {
        const t = furnitureTint(d, f)
        batch.getColorAt(i, c)
        expect([c.r, c.g, c.b].map((v) => +v.toFixed(5))).toEqual(t.map((v) => +v.toFixed(5)))
      })
    }

    const box = buildFurniturePart(d, geom, materials, null).children[0]
    let i = 0
    for (const f of d.furniture) {
      const t = furnitureTint(d, f)
      const parts = []
      pushFurnitureModel(parts, f)
      for (const part of parts) {
        expect(Object.values(FURN_TINT)).toContainEqual(part.tint)
        box.getColorAt(i++, c)
        expect(c.r).toBeCloseTo(part.tint[0] * t[0], 5)
        expect(c.g).toBeCloseTo(part.tint[1] * t[1], 5)
        expect(c.b).toBeCloseTo(part.tint[2] * t[2], 5)
      }
    }
    expect(i).toBe(box.count)
    for (const g of models.geometries.values()) g.dispose()
    disposeGeometries(geom)
    m.dispose()
  })
})
