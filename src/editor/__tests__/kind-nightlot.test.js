import { describe, expect, it } from 'vitest'
import { CHUNK } from '../../world/constants.js'
import { CELL_ROOM } from '../../world/mapTypes.js'
import { FURN_COOLER, FURN_COUNTER, FURN_RACK } from '../../world/rooms/catalog.js'
import { anchorDistrict, upperChunks } from '../../world/families/nightlot/geometry.js'
import { SODIUM, UPPER_LABELS } from '../../world/families/nightlot/tile.js'
import { cellWalkable } from '../../world/tiles/holeMasks.js'
import { EditorMap } from '../EditorMap.js'
import { generatePrototype } from '../prototypes.js'
import { KIND_SEEDS, expectKindClean, judgeMap } from './kindJudge.js'

// 02 Night Lot (docs/liminal_maps/02-night-lot.md): the kind lab shows ONE
// procedurally generated district of the family's own grammar per seed — the
// seed's exit district (so it holds the kiosk and its basement exit) — over
// the family's three storeys: the undercroft (storey 0), the lot (storey 1)
// and the upper storey of roof decks and upper floors (storey 2), its seams
// closed. These tests judge that sample: clean and connected, rich (the
// content gate of the family's lot), lit by sodium circuits with dead heads,
// different from seed to seed, and faithful to the world's district.

const BASE = 0
const LOT = 1
const UP = 2

function build(seed) {
  const map = new EditorMap()
  const res = generatePrototype(map, 'nightlot', { seed })
  return { map, res, ...judgeMap(map) }
}

const chunksOf = (map, cy) => [...map.chunks.values()].filter((d) => d.cy === cy)
const allFurniture = (map, cy) => chunksOf(map, cy).flatMap((d) => d.furniture.map((f) => ({ ...f, gx: d.cx * CHUNK + f.lx, gz: d.cz * CHUNK + f.lz })))

// Wall edges and column cells of one storey, as the family's variety gate
// counts them.
function signature(map, cy) {
  const s = new Set()
  for (const d of chunksOf(map, cy)) {
    for (let i = 0; i < CHUNK * CHUNK; i++) {
      const k = `${d.cx},${d.cz},${i}`
      if (d.wallV[i]) s.add(`v${k}`)
      if (d.wallH[i]) s.add(`h${k}`)
      if (d.cols[i]) s.add(`c${k}:${d.cols[i]}`)
    }
  }
  return s
}
const jaccard = (a, b) => {
  let i = 0
  for (const x of a) if (b.has(x)) i++
  return i / (a.size + b.size - i || 1)
}

describe('nightlot kind', () => {
  it('nightlot: audits clean, the volume one connected whole across three storeys, deterministic, for every seed', () => {
    expectKindClean(expect, 'nightlot')
  })

  it('nightlot: the sample is the seed\'s exit district — 4×4 chunks, spawn on the lot, the exit in the kiosk basement, the kiosk furnished', () => {
    for (const seed of KIND_SEEDS) {
      const { map, res, box } = build(seed)
      const at = `seed ${seed}`
      expect(box.x1 - box.x0 + 1, at).toBe(4)
      expect(box.z1 - box.z0 + 1, at).toBe(4)
      expect([box.y0, box.y1], at).toEqual([BASE, UP])
      for (const cy of [BASE, LOT, UP]) expect(chunksOf(map, cy).length, at).toBe(16)
      expect(res.notes[0], at).toContain('(the exit district)')
      const s = map.chunkAt(map.cellChunk(res.spawn.gx), LOT, map.cellChunk(res.spawn.gz))
      expect(res.spawn.cy, at).toBe(LOT)
      expect(cellWalkable(s, map.cellLocal(res.spawn.gx), map.cellLocal(res.spawn.gz)), at).toBe(true)
      expect(res.exit.cy, at).toBe(BASE)
      const exitChunk = map.chunkAt(map.cellChunk(res.exit.gx), BASE, map.cellChunk(res.exit.gz))
      expect(exitChunk.exit, at).toEqual({ lx: map.cellLocal(res.exit.gx), lz: map.cellLocal(res.exit.gz) })
      // The kiosk over the exit: counter, rack and cooler on room cells.
      const furn = allFurniture(map, LOT)
      for (const kind of [FURN_COUNTER, FURN_RACK, FURN_COOLER]) {
        const f = furn.find((p) => p.kind === kind && map.cellAt(p.gx, LOT, p.gz).kind === CELL_ROOM)
        expect(f, `${at}: a ${kind} on a room cell`).toBeTruthy()
      }
    }
  })

  it('nightlot: the lot storey is rich — per chunk ≥ 25 wall edges, ≥ 2 spaces, ≥ 8 pieces, ≥ 3 lit lamps; walkable share 0.5–0.9', () => {
    for (const seed of KIND_SEEDS) {
      const { map } = build(seed)
      const at = `seed ${seed}`
      const lot = chunksOf(map, LOT)
      let walls = 0
      let spaces = 0
      let pieces = 0
      let lit = 0
      let open = 0
      for (const d of lot) {
        const ids = new Set()
        for (let i = 0; i < CHUNK * CHUNK; i++) {
          walls += d.wallV[i] + d.wallH[i]
          if (!d.cols[i]) open++
          if (d.spaceId[i]) ids.add(d.spaceId[i])
        }
        spaces += ids.size
        pieces += d.furniture.length
        lit += d.lamps.filter((l) => l.lit).length
      }
      const n = lot.length
      expect(walls / n, at).toBeGreaterThanOrEqual(25)
      expect(spaces / n, at).toBeGreaterThanOrEqual(2)
      expect(pieces / n, at).toBeGreaterThanOrEqual(8)
      expect(lit / n, at).toBeGreaterThanOrEqual(3)
      const walk = open / (n * CHUNK * CHUNK)
      expect(walk, at).toBeGreaterThan(0.5)
      expect(walk, at).toBeLessThan(0.9)
    }
  })

  it('nightlot: stairs join all three storeys; the upper storey stands only over its footprint (solid elsewhere) and reads P2 / 2; the undercroft P-1', () => {
    for (const seed of KIND_SEEDS) {
      const { map, audit } = build(seed)
      const at = `seed ${seed}`
      expect(audit.canonicalLinks, at).toBeGreaterThanOrEqual(3)
      const { tx, tz } = anchorDistrict(seedOf(map))
      const ups = new Set(upperChunks(seedOf(map), tx, tz).map(([a, b]) => `${a},${b}`))
      expect(ups.size, at).toBeGreaterThan(0)
      let upFloor = 0
      for (const d of chunksOf(map, UP)) {
        let open = 0
        for (let i = 0; i < CHUNK * CHUNK; i++) if (!d.cols[i] || d.spaceId[i]) open++
        if (ups.has(`${d.cx},${d.cz}`)) {
          expect(open, `${at} upper chunk ${d.cx},${d.cz}`).toBeGreaterThan(0)
          expect([UPPER_LABELS.roof, UPPER_LABELS.floor], at).toContain(d.levelLabel)
          upFloor += open
        } else {
          expect(open, `${at} solid chunk ${d.cx},${d.cz}`).toBe(0)
        }
      }
      expect(upFloor, at).toBeGreaterThan(80)
      expect(chunksOf(map, BASE).every((d) => d.levelLabel === 'P-1'), at).toBe(true)
      // A stair up from the lot to the upper storey somewhere in the district.
      expect(chunksOf(map, LOT).some((d) => d.stairUp), at).toBe(true)
    }
  })

  it('nightlot: sodium circuits with dead heads on the lot, ≤ 12 lit lamps per chunk-storey', () => {
    for (const seed of KIND_SEEDS) {
      const { map } = build(seed)
      const at = `seed ${seed}`
      const lamps = chunksOf(map, LOT).flatMap((d) => d.lamps)
      const on = lamps.filter((l) => l.lit)
      expect(on.some((l) => l.tint === SODIUM), at).toBe(true)
      expect(lamps.length - on.length, at).toBeGreaterThanOrEqual(4)
      for (const d of map.chunks.values()) expect(d.lamps.filter((l) => l.lit).length, `${at} ${d.cx},${d.cy},${d.cz}`).toBeLessThanOrEqual(12)
    }
  })

  it('nightlot: every seed draws a different district (lot-storey wall/column Jaccard between samples ≤ 0.25 mean, ≤ 0.45 max)', () => {
    const sigs = KIND_SEEDS.map((seed) => signature(build(seed).map, LOT))
    let sum = 0
    let n = 0
    let max = 0
    for (let i = 0; i < sigs.length; i++) {
      for (let j = i + 1; j < sigs.length; j++) {
        const v = jaccard(sigs[i], sigs[j])
        sum += v
        n++
        max = Math.max(max, v)
      }
    }
    expect(sum / n).toBeLessThanOrEqual(0.25)
    expect(max).toBeLessThanOrEqual(0.45)
  })
})

function seedOf(map) {
  return map.meta.seed >>> 0
}
