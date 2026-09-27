import { describe, expect, it } from 'vitest'
import { auditLayeredPatch } from '../audit.js'
import { DEFAULT_WORLD_CONFIG } from '../config.js'
import { CHUNK } from '../constants.js'
import { hashStr } from '../core/hash.js'
import { worldConfigForFamily } from '../mapFamily.js'
import { buildChunk } from '../pipeline.js'
import { structureAt } from '../structures/contract.js'
import { towerSliceCoordinates } from '../structures/tower.js'
import { countChunkComponents } from '../topology.js'
import { WALL_RAIL } from '../mapTypes.js'

const config = worldConfigForFamily('tower', DEFAULT_WORLD_CONFIG)
const key = (cx, cy, cz) => `${cx},${cy},${cz}`
const cellKey = (gx, gz) => `${gx},${gz}`

function discover(seed) {
  for (let cy = -24; cy <= 0; cy++) {
    for (let cz = -4; cz <= 4; cz++) {
      for (let cx = -4; cx <= 4; cx++) {
        const structure = structureAt(seed, cx, cz, cy, config)
        if (structure.hasRoom && structure.kind === 'towerSkybridge') return structure
      }
    }
  }
  throw new Error(`No Tower for seed ${seed}`)
}

// Every Tower landmark inside a chunk window (deduped by descriptor).
function scanTowers(seed, { r = 4, y0 = -2, y1 = 4 } = {}) {
  const found = new Map()
  for (let cy = y0; cy <= y1; cy++) {
    for (let cz = -r; cz <= r; cz++) {
      for (let cx = -r; cx <= r; cx++) {
        const structure = structureAt(seed, cx, cz, cy, config)
        if (structure.hasRoom && structure.kind === 'towerSkybridge') {
          found.set(`${structure.id}:${structure.baseCy}`, structure)
        }
      }
    }
  }
  return [...found.values()]
}

function generate(seed, structure) {
  const chunks = new Map()
  for (let cy = structure.baseCy; cy <= structure.topCy; cy++) {
    for (const { cx, cz } of structure.participants) {
      chunks.set(key(cx, cy, cz), buildChunk(seed, cx, cy, cz, config))
    }
  }
  return chunks
}

function voidCells(chunks, cy) {
  const cells = new Set()
  for (const data of chunks.values()) {
    if (data.cy !== cy) continue
    for (const { lx, lz } of data.structureDown?.voidCells ?? []) {
      cells.add(cellKey(data.cx * CHUNK + lx, data.cz * CHUNK + lz))
    }
  }
  return cells
}

const cases = Array.from({ length: 12 }, (_, index) => {
  const seed = index + 1
  return { seed, structure: discover(seed) }
})

describe('Tower architectural forms', () => {
  it('elects three different plans with courts, galleries, and a repeated nave', () => {
    expect(new Set(cases.map(({ structure }) => structure.architecture.form)))
      .toEqual(new Set(['nave', 'splitCourt', 'overlookCourt']))
    for (const { seed, structure } of cases) {
      expect(discover(seed)).toEqual(structure)
      const chunks = generate(seed, structure)
      const { form } = structure.architecture
      const bounds = structure.globalBounds
      const alongX = structure.bridgeAxis === 'x'
      const longStart = alongX ? bounds.x0 : bounds.z0
      const longEnd = alongX ? bounds.x1 : bounds.z1
      const shortStart = alongX ? bounds.z0 : bounds.x0
      const shortEnd = alongX ? bounds.z1 : bounds.x1
      const topVoid = voidCells(chunks, structure.topCy)
      const middleVoid = voidCells(chunks, structure.baseCy + 1)
      expect(topVoid.size).toBeGreaterThan(0)
      if (form === 'nave') {
        expect(shortEnd - shortStart + 1).toBe(6)
      } else {
        const long = form === 'splitCourt'
          ? Math.floor((longStart + longEnd) / 2)
          : longEnd - 2
        for (let short = shortStart; short <= shortEnd; short++) {
          const cell = alongX ? cellKey(long, short) : cellKey(short, long)
          expect(topVoid.has(cell), `${form} upper gallery ${cell}`).toBe(false)
        }
        if (form === 'splitCourt') {
          const longOf = (cell) => Number(cell.split(',')[alongX ? 0 : 1])
          expect([...topVoid].some((cell) => longOf(cell) < long)).toBe(true)
          expect([...topVoid].some((cell) => longOf(cell) > long + 1)).toBe(true)
        } else {
          expect(topVoid).not.toEqual(middleVoid)
        }
      }
    }
  })

  it.each(cases)('keeps seed $seed connected through its stairs and guards every court edge', ({ seed, structure }) => {
    const chunks = generate(seed, structure)
    const xs = structure.participants.map(({ cx }) => cx)
    const zs = structure.participants.map(({ cz }) => cz)
    const x0 = Math.min(...xs)
    const z0 = Math.min(...zs)
    const audit = auditLayeredPatch(
      (cx, cy, cz) => chunks.get(key(cx, cy, cz)),
      x0, structure.baseCy, z0,
      Math.max(...xs) - x0 + 1, structure.levelCount, Math.max(...zs) - z0 + 1
    )
    expect(audit.connected, JSON.stringify(audit)).toBe(true)
    expect(audit.ok, JSON.stringify(audit)).toBe(true)
    for (let cy = structure.baseCy + 1; cy <= structure.topCy; cy++) {
      const voids = voidCells(chunks, cy)
      for (const cell of voids) {
        const [gx, gz] = cell.split(',').map(Number)
        for (const [nx, nz, axis, wx, wz] of [
          [gx - 1, gz, 'v', gx, gz],
          [gx + 1, gz, 'v', gx + 1, gz],
          [gx, gz - 1, 'h', gx, gz],
          [gx, gz + 1, 'h', gx, gz + 1],
        ]) {
          if (voids.has(cellKey(nx, nz))) continue
          const cx = Math.floor(wx / CHUNK)
          const cz = Math.floor(wz / CHUNK)
          const data = chunks.get(key(cx, cy, cz))
          expect(data).toBeDefined()
          const lx = wx - cx * CHUNK
          const lz = wz - cz * CHUNK
          expect(axis === 'v' ? data.vAt(lx, lz) : data.hAt(lx, lz)).toBe(1)
          expect(axis === 'v' ? data.wallFeatureVAt(lx, lz) : data.wallFeatureHAt(lx, lz)).toBe(WALL_RAIL)
        }
      }
    }
  })
})

// Column-aware, holes excluded: the per-chunk contract the topology repair,
// the sewer candidates and the catalog analyzer already hold. Before v27 the
// gallery walk on the far side of a participant's stair halo was railed off
// from the court and glazed along its long wall, so it reached the ring only
// through the other participant's chunk and that chunk-storey split in two.
describe('Tower landmark chunk-storeys', () => {
  it('keeps the exit-20 nave deck floor in one piece', () => {
    const data = buildChunk(hashStr('exit-20'), -10, -1, 0, config)
    expect(data.structure.kind).toBe('towerSkybridge')
    expect(data.structure.architecture.form).toBe('nave')
    expect(countChunkComponents(data, true)).toBe(1)
  })

  it('keeps every stamped chunk-storey of every landmark one component on its own', () => {
    const layouts = new Set()
    let slices = 0
    for (let index = 0; index < 16; index++) {
      const seed = hashStr(`tower-chunk-${index}`)
      for (const structure of scanTowers(seed)) {
        const { form } = structure.architecture
        layouts.add(`${form}:${structure.bridgeAxis}`)
        for (const { cx, cy, cz } of towerSliceCoordinates(structure)) {
          const data = buildChunk(seed, cx, cy, cz, config)
          expect(data.structure.id).toBe(structure.id)
          expect(
            countChunkComponents(data, true),
            `seed ${seed} ${form} chunk ${cx},${cy},${cz}`
          ).toBe(1)
          slices++
        }
      }
    }
    // Every form on both axes, so each court/nave gallery layout is covered.
    expect(layouts.size).toBe(6)
    expect(slices).toBeGreaterThanOrEqual(200)
  }, 60_000)
})
