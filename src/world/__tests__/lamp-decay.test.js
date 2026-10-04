import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { generateChunk } from '../generate.js'
import { worldConfigForFamily } from '../mapFamily.js'
import { CELL, CHUNK, CHUNK_WORLD, LAMP_BAD_CHANCE, cIdx, layerY } from '../constants.js'
import { MAP_FAMILY_SEWER } from '../mapTypes.js'
import { SPACE_ROOM, roomContext, worldSurfaceSet } from '../surfaceSet.js'
import {
  FLICKER_FULL,
  ballastFailShare,
  isBadTube,
  lampCircuit,
  lampFlicker,
  lampIsBad,
  lampPanelTint,
  lampWear,
  tubeFailChance,
  wearOdds,
} from '../lampCharacter.js'
import { buildChunkMeshes } from '../mesh.js'
import { LightGrid } from '../lightGrid/LightGrid.js'
import { texelIndex } from '../lightGrid/gridSpec.js'
import { createGeometries, disposeGeometries } from '../../render/geometries.js'
import { LightField, makeLampUniforms } from '../../render/LightField.js'
import { familiesWith } from '../families/registry.js'

// Office-semantics matrix: only the building families (spec §11.4). The
// liminal families have their own per-family suites.
const BUILDING_FAMILIES = familiesWith('buildingMatrices')

// Bad tubes as a symptom of the building, measured on generated worlds of
// every family: they gather where the wear field says the wing is failing,
// fail together per circuit (and failing circuits gather there too), stay
// rare in kept-up space, differ from world to world, and every consumer
// (emissive panel, CPU cast light, GPU light grid) agrees on which they are.

// A 5x5-chunk, two-storey block that straddles a kept-up and a derelict wing
// of world 12 (about a third of its fixtures in each), so both wear bands
// hold enough lamps in every family.
const SEED = 12
const BLOCK_X = -16
const BLOCK_Z = -8
const N = 5

const KEPT = 0.2 // decay below: the kept-up end of lived-in
const LIVED = 0.45 // decay below: lived-in
const DERELICT = 0.8 // decay at or above: derelict

function blockLamps(family) {
  const config = worldConfigForFamily(family)
  const set = worldSurfaceSet(family, SEED)
  const lamps = []
  for (const cy of [0, 1]) {
    for (let cz = BLOCK_Z; cz < BLOCK_Z + N; cz++) {
      for (let cx = BLOCK_X; cx < BLOCK_X + N; cx++) {
        const d = generateChunk(SEED, cx, cy, cz, config)
        for (const l of d.lamps) {
          if (!l.lit) continue
          const ctx = roomContext(d, l.lx, l.lz, set)
          const wear = lampWear(d, l.lx, l.lz, set)
          lamps.push({
            d,
            l,
            ctx,
            wear,
            chunk: `${cx},${cy},${cz}`,
            circuit: lampCircuit(d, l.lx, l.lz),
            odds: wear.odds,
            bad: lampIsBad(d, l.lx, l.lz, set),
            // The old flat lottery at the same fixture, for comparison.
            flat: isBadTube((d.cx * CHUNK + l.lx + 0.5) * CELL, (d.cz * CHUNK + l.lz + 0.5) * CELL, d.cy),
          })
        }
      }
    }
  }
  return lamps
}

const blocks = new Map()
const blockOf = (family) => {
  if (!blocks.has(family)) blocks.set(family, blockLamps(family))
  return blocks.get(family)
}

const rate = (lamps, key = 'bad') => lamps.filter((x) => x[key]).length / lamps.length

// Circuits of a lamp list: { lamps, decay (mean), failing (its ballast) }.
function circuitsOf(lamps) {
  const byCircuit = new Map()
  for (const x of lamps) {
    const c = byCircuit.get(x.circuit) ?? []
    c.push(x)
    byCircuit.set(x.circuit, c)
  }
  return [...byCircuit.values()].map((c) => ({
    lamps: c,
    decay: c.reduce((s, x) => s + x.wear.decay, 0) / c.length,
    failing: c.some((x) => x.wear.failing),
  }))
}

describe('lamp decay: bad tubes follow the building', () => {
  it.each(BUILDING_FAMILIES)('%s: derelict wings hold far more bad tubes than lived-in ones', (family) => {
    const lamps = blockOf(family)
    const lived = lamps.filter((x) => x.ctx.decay < LIVED)
    const derelict = lamps.filter((x) => x.ctx.decay >= DERELICT)
    expect(lived.length).toBeGreaterThan(80)
    expect(derelict.length).toBeGreaterThan(80)
    // Per-tube dice used to ignore wear entirely (the two rates matched).
    expect(rate(derelict)).toBeGreaterThan(2 * rate(lived))
  })

  it('kept-up space keeps only the odd bad tube: a rare anomaly, not none', () => {
    const lamps = BUILDING_FAMILIES.flatMap(blockOf)
    const lived = lamps.filter((x) => x.ctx.decay < LIVED)
    expect(rate(lived)).toBeGreaterThan(0)
    expect(rate(lived)).toBeLessThan(LAMP_BAD_CHANCE)
    // The kept-up end sits well under the world-wide share: in odds (the flat
    // lottery is exactly 1x) and in tubes, against the flat lottery's own
    // tubes at the same fixtures.
    const kept = lamps.filter((x) => x.ctx.decay < KEPT)
    expect(kept.length).toBeGreaterThan(150)
    expect(kept.reduce((s, x) => s + x.odds, 0) / kept.length).toBeLessThan(0.75 * LAMP_BAD_CHANCE)
    expect(rate(kept)).toBeGreaterThan(0)
    expect(rate(kept)).toBeLessThan(0.8 * rate(kept, 'flat'))
  })

  it.each(BUILDING_FAMILIES)('%s: failing ballasts gather in derelict wings, a rare one in kept-up space', (family) => {
    const circuits = circuitsOf(blockOf(family))
    const lived = circuits.filter((c) => c.decay < LIVED)
    const derelict = circuits.filter((c) => c.decay >= DERELICT)
    expect(lived.length).toBeGreaterThan(40)
    expect(derelict.length).toBeGreaterThan(40)
    const share = (cs) => cs.filter((c) => c.failing).length / cs.length
    // A flat ballast roll fails the same share of circuits in every wing.
    expect(share(derelict)).toBeGreaterThan(2 * share(lived))
    expect(share(lived)).toBeGreaterThan(0)
  })

  it('a failing circuit takes several of its tubes with it', () => {
    // Lift: P(another tube on my circuit is bad | I am bad) / P(bad). Per-tube
    // dice give ~1; shared ballasts (and shared wear) push it well above.
    let pairs = 0
    let both = 0
    let bad = 0
    let total = 0
    for (const family of BUILDING_FAMILIES) {
      const byCircuit = new Map()
      for (const x of blockOf(family)) {
        const c = byCircuit.get(x.circuit) ?? { n: 0, bad: 0 }
        c.n++
        c.bad += x.bad ? 1 : 0
        byCircuit.set(x.circuit, c)
        total++
        bad += x.bad ? 1 : 0
      }
      for (const c of byCircuit.values()) {
        if (c.n < 2) continue
        pairs += c.bad * (c.n - 1)
        both += c.bad * (c.bad - 1)
      }
    }
    expect(pairs).toBeGreaterThan(200)
    expect(both / pairs / (bad / total)).toBeGreaterThan(1.5)
  })

  it('the world-wide share of bad tubes stays near LAMP_BAD_CHANCE', () => {
    // Widely spaced chunks (further apart than the wear field's ~150 m
    // lattice) of ten worlds, one family each, two storeys.
    let n = 0
    let bad = 0
    for (let k = 0; k < 10; k++) {
      const seed = 1 + k
      const family = BUILDING_FAMILIES[k % BUILDING_FAMILIES.length]
      const config = worldConfigForFamily(family)
      const set = worldSurfaceSet(family, seed)
      for (const cy of [0, 2]) {
        for (const cz of [-12, 0, 12]) {
          for (const cx of [-12, 0, 12]) {
            const d = generateChunk(seed, cx, cy, cz, config)
            for (const l of d.lamps) {
              if (!l.lit) continue
              n++
              if (lampIsBad(d, l.lx, l.lz, set)) bad++
            }
          }
        }
      }
    }
    expect(n).toBeGreaterThan(1500)
    expect(Math.abs(bad / n / LAMP_BAD_CHANCE - 1)).toBeLessThan(0.4)
  })

  it('wear odds and failing ballasts rise with decay through the three bands', () => {
    expect(wearOdds(0)).toBeLessThan(1)
    expect(wearOdds(0.6)).toBeGreaterThan(1)
    expect(wearOdds(0.9)).toBeGreaterThan(1.5)
    expect(ballastFailShare(0)).toBeLessThan(0.1)
    expect(ballastFailShare(0.9)).toBeGreaterThan(0.5)
    for (const f of [wearOdds, ballastFailShare]) {
      for (let d = 0; d < 1; d += 0.01) expect(f(d + 0.01)).toBeGreaterThanOrEqual(f(d))
      expect(f(-1)).toBe(f(0))
      expect(f(2)).toBe(f(1))
    }
  })

  it('each world rolls its own tubes: bad ones do not haunt the same cells world after world', () => {
    // Lift: P(bad in world B | bad in world A at the same global cell) /
    // P(bad), over the chunks around spawn. A seed-free die hung the same
    // dying tubes there in every world (~2.6); independent worlds give ~1.
    let n = 0
    let bad = 0
    let pairs = 0
    let both = 0
    for (const family of BUILDING_FAMILIES) {
      const config = worldConfigForFamily(family)
      const cells = new Map()
      for (let k = 0; k < 6; k++) {
        const seed = 31 + k * 101
        const set = worldSurfaceSet(family, seed)
        for (let cz = -1; cz <= 1; cz++) {
          for (let cx = -1; cx <= 1; cx++) {
            const d = generateChunk(seed, cx, 0, cz, config)
            for (const l of d.lamps) {
              if (!l.lit) continue
              const key = `${cx * CHUNK + l.lx},${cz * CHUNK + l.lz}`
              const b = lampIsBad(d, l.lx, l.lz, set)
              cells.set(key, (cells.get(key) ?? []).concat(b))
              n++
              if (b) bad++
            }
          }
        }
      }
      for (const c of cells.values()) {
        const b = c.filter(Boolean).length
        pairs += b * (c.length - 1)
        both += b * (b - 1)
      }
    }
    expect(pairs).toBeGreaterThan(300)
    expect(both / pairs / (bad / n)).toBeLessThan(1.6)
  })
})

describe('lamp decay: pure, keyed and seam-safe', () => {
  it('is a pure function of the chunk: regenerating it gives the same tubes', () => {
    for (const family of BUILDING_FAMILIES) {
      const config = worldConfigForFamily(family)
      const a = generateChunk(SEED, BLOCK_X + 2, 0, BLOCK_Z + 2, config)
      // Other worlds in between churn the surface-set memo; no hidden state.
      for (let s = 100; s < 120; s++) worldSurfaceSet(family, s)
      const b = generateChunk(SEED, BLOCK_X + 2, 0, BLOCK_Z + 2, config)
      expect(b.lamps.map((l) => lampIsBad(b, l.lx, l.lz))).toEqual(a.lamps.map((l) => lampIsBad(a, l.lx, l.lz)))
      expect(b.lamps.map((l) => tubeFailChance(b, l.lx, l.lz))).toEqual(a.lamps.map((l) => tubeFailChance(a, l.lx, l.lz)))
      expect(b.lamps.map((l) => lampWear(b, l.lx, l.lz))).toEqual(a.lamps.map((l) => lampWear(a, l.lx, l.lz)))
    }
  })

  it('one physical circuit, one id across chunk seams, one ballast endurance', () => {
    let seamRooms = 0
    let seamRuns = 0
    for (const family of BUILDING_FAMILIES) {
      // The circuit a fixture should hang on, worked out here from global
      // coordinates rather than lampCircuit's own keys: a room is its planner
      // space on its storey (sewer chamber ids are per chunk: skipped), a
      // corridor or hall run is its space and its 8-cell global block.
      const groups = new Map()
      for (const x of blockOf(family)) {
        const { d, l } = x
        const room = x.ctx.cls === SPACE_ROOM
        if (room && family === MAP_FAMILY_SEWER) continue
        const gx = d.cx * CHUNK + l.lx
        const gz = d.cz * CHUNK + l.lz
        const id = room
          ? `room|${d.spaceId[cIdx(l.lx, l.lz)]}|${d.cy}`
          : `run|${x.ctx.key}|${Math.floor(gx / 8)}|${Math.floor(gz / 8)}|${d.cy}`
        const g = groups.get(id) ?? { room, circuits: new Set(), chunks: new Set() }
        g.circuits.add(x.circuit)
        g.chunks.add(x.chunk)
        groups.set(id, g)
      }
      const ids = new Set()
      for (const g of groups.values()) {
        expect(g.circuits.size).toBe(1)
        ids.add([...g.circuits][0])
        if (g.chunks.size > 1) {
          if (g.room) seamRooms++
          else seamRuns++
        }
      }
      // ...and two physical circuits never share an id.
      expect(ids.size).toBe(groups.size)
      // One endurance per circuit, wherever its chunks are: along the wear of
      // its fixtures the ballast is sound up to a point and failing past it.
      for (const c of circuitsOf(blockOf(family))) {
        const byWear = c.lamps.slice().sort((a, b) => a.wear.decay - b.wear.decay)
        const first = byWear.findIndex((x) => x.wear.failing)
        if (first >= 0) for (const x of byWear.slice(first)) expect(x.wear.failing).toBe(true)
      }
    }
    // Rooms and corridor runs do span seams in these blocks.
    expect(seamRooms).toBeGreaterThan(10)
    expect(seamRuns).toBeGreaterThan(50)
  })

  it('is presentation only: the generated lamps and lit flags are untouched', () => {
    for (const family of BUILDING_FAMILIES) {
      const config = worldConfigForFamily(family)
      const d = generateChunk(SEED, BLOCK_X + 1, 1, BLOCK_Z + 3, config)
      const before = JSON.stringify(d.lamps)
      for (const l of d.lamps) {
        lampIsBad(d, l.lx, l.lz)
        tubeFailChance(d, l.lx, l.lz)
      }
      new LightGrid().addChunk(d)
      expect(JSON.stringify(d.lamps)).toBe(before)
      expect(JSON.stringify(generateChunk(SEED, BLOCK_X + 1, 1, BLOCK_Z + 3, config).lamps)).toBe(before)
    }
  })
})

describe('lamp decay: one answer for every consumer', () => {
  it.each(BUILDING_FAMILIES)('%s: panel tint, CPU cast light and GPU grid agree on bad tubes', (family) => {
    // The first block chunk holding both a bad and a healthy lit tube.
    const lamps = blockOf(family)
    const chunkKey = [...new Set(lamps.map((x) => x.chunk))].find((k) => {
      const own = lamps.filter((x) => x.chunk === k)
      return own.some((x) => x.bad) && own.some((x) => !x.bad)
    })
    expect(chunkKey).toBeDefined()
    const d = lamps.find((x) => x.chunk === chunkKey).d
    const ox = d.cx * CHUNK_WORLD
    const oz = d.cz * CHUNK_WORLD

    const geometry = createGeometries()
    const material = new THREE.MeshBasicMaterial()
    const materials = new Proxy({}, { get: () => material })
    const mesh = buildChunkMeshes(d, geometry, materials, ox, layerY(d.cy), oz)
    const grid = new LightGrid()
    grid.addChunk(d)

    const lit = d.lamps.filter((l) => l.lit)
    expect(mesh.lamps.length).toBe(lit.length)
    const panels = mesh.parts.litPanels
    const color = new THREE.Color()
    const tint = [0, 0, 0]
    lit.forEach((l, i) => {
      const v = mesh.lamps[i]
      const bad = lampIsBad(d, l.lx, l.lz)
      // The lamp carries the build-time answer to LightField.
      expect(v.bad).toBe(bad)
      // The emissive panel is browned exactly when the tube is bad.
      panels.getColorAt(i, color)
      lampPanelTint(v.x, v.z, d.cy, tint, v.role, bad)
      expect(color.r).toBeCloseTo(tint[0], 5)
      expect(color.g).toBeCloseTo(tint[1], 5)
      expect(color.b).toBeCloseTo(tint[2], 5)
      // The GPU twin's flicker byte carries the same bad bit.
      const gx = d.cx * CHUNK + l.lx
      const gz = d.cz * CHUNK + l.lz
      expect((grid.lamp[texelIndex(gx, gz, d.cy) * 4 + 3] & 128) !== 0).toBe(bad)
      expect(Math.floor(v.x / CELL)).toBe(gx)
    })

    // CPU cast light: LightField strobes the tagged tubes, not a re-roll.
    const u = makeLampUniforms()
    const field = new LightField(u)
    field.flicker = FLICKER_FULL
    const cm = {
      collectLampsNear(_px, _pz, out) {
        out.length = 0
        out.push(...mesh.lamps)
        return out
      },
    }
    field.update(0.37, ox + CHUNK_WORLD / 2, oz + CHUNK_WORLD / 2, d.cy, cm)
    const byCell = new Map(mesh.lamps.map((v) => [`${Math.floor(v.x / CELL)},${Math.floor(v.z / CELL)}`, v]))
    for (let i = 0; i < u.uLampCount.value; i++) {
      const p = u.uLampPos.value[i]
      const v = byCell.get(`${Math.floor(p.x / CELL)},${Math.floor(p.z / CELL)}`)
      expect(u.lampFlickerRaw[i]).toBeCloseTo(lampFlicker(p.x, p.z, d.cy, 0.37, FLICKER_FULL, v.bad), 6)
    }

    mesh.dispose()
    disposeGeometries(geometry)
  })
})
