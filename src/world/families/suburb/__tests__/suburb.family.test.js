import { describe, expect, it } from 'vitest'
import { CHUNK, hIdx } from '../../../constants.js'
import { hash2i } from '../../../core/hash.js'
import { auditLayeredPatch } from '../../../audit.js'
import { resolveMapFamily } from '../../../mapFamily.js'
import { CELL_OPEN, CELL_ROOM, COLUMN_STANDARD } from '../../../mapTypes.js'
import { makeTileCtx, tileBakeAt } from '../../../tiles/familyChunk.js'
import { cellWalkable } from '../../../tiles/holeMasks.js'
import { massLeakAudit } from '../../../tiles/seams.js'
import { walkGraph } from '../../../tiles/simulate.js'
import { solidChunk } from '../../../tiles/solidChunk.js'
import { TileCanvas } from '../../../tiles/TileCanvas.js'
import { tileWindow } from '../../../tiles/tileKey.js'
import { forcedFamilyConfig } from '../../forced.js'
import { familyGenerator } from '../../generators.js'
import { familyExitHook, familySpawn, hookOf } from '../../hooks.js'
import { familyPlanner } from '../../planners.js'
import { windowConnectivity, worldSource } from '../../reach.js'
import { STRUCTURAL_COUNTERS, runFamilySuite } from '../../__tests__/familyHarness.js'
import { TINT_EXIT, TINT_MOON, TINT_STREET } from '../tile.js'
import {
  ANOMALY_CLASSES,
  ATTIC,
  MODEL_DEFS,
  STREET_W,
  TILE,
  TILE_D,
  TILE_W,
  TWO_STOREY,
  TWO_STOREY_KINDS,
  anomalyAt,
  anomalyChance,
  bandKey,
  exitAnchor,
  exitTileOf,
  footprint,
  forcedHouses,
  houseCellOf,
  houseRectOf,
  isAnchorTile,
  lotCell,
  nineRowOf,
  planSeedOf,
  ports,
  streetCellOf,
  suburbPlan,
  tilePorts,
  xSeamPorts,
  zSeamPorts,
} from '../geometry.js'

// The suburb family suite (spec §11.1, §12.6): W = 2×2 tiles × storeys 0..1;
// the decision-6 window is 3×3 tiles × 0..1.
runFamilySuite('suburb', {
  window: { tiles: [2, 2], storeys: [0, 1] },
  connWindow: { tiles: [3, 3], storeys: [0, 1] },
})

// --- suburb specifics (§12.6 Tests) ---------------------------------------------------

const ID = 'suburb'
const config = forcedFamilyConfig(ID)
const profile = resolveMapFamily(config)
const gen = familyGenerator(ID)
const planner = familyPlanner(ID)
const SEEDS = [1, 0x5eed, 777]

// One shared world source per seed (chunks memoised across the tests).
const SOURCES = new Map()
const src = (seed) => {
  let s = SOURCES.get(seed)
  if (!s) SOURCES.set(seed, (s = worldSource(seed, config)))
  return s
}
const tileBox = (tx, tz, y0 = 0, y1 = 1) => ({ x0: tx * TILE.w, z0: tz * TILE.d, x1: tx * TILE.w + TILE.w - 1, z1: tz * TILE.d + TILE.d - 1, y0, y1 })
// A kind-local cell of tile (tx, tz) → its chunk and local cell.
const at = (seed, tx, tz, gx, gz, cy) => {
  const GX = tx * TILE_W + gx
  const GZ = tz * TILE_D + gz
  const cx = Math.floor(GX / CHUNK)
  const cz = Math.floor(GZ / CHUNK)
  return { d: src(seed).chunkAt(cx, cy, cz), lx: GX - cx * CHUNK, lz: GZ - cz * CHUNK, GX, GZ }
}
const walkable = (seed, tx, tz, gx, gz, cy = 0) => {
  const c = at(seed, tx, tz, gx, gz, cy)
  return cellWalkable(c.d, c.lx, c.lz)
}
const isMass = (seed, tx, tz, gx, gz, cy = 0) => {
  const c = at(seed, tx, tz, gx, gz, cy)
  return c.d.cols[c.lz * CHUNK + c.lx] === COLUMN_STANDARD
}
// The forced house of slot `slot` as a GLOBAL cell rect.
const houseRect = (seed, tx, tz, slot = 0) => {
  const h = forcedHouses(seed, bandKey(tx, tz))[slot]
  const r = houseRectOf(h, { u0: 0, v0: 0, u1: h.W - 1, v1: h.D - 1 })
  return { x0: r.x0 + tx * TILE_W, z0: r.z0 + tz * TILE_D, x1: r.x1 + tx * TILE_W, z1: r.z1 + tz * TILE_D }
}
const inRect = (r, gx, gz) => gx >= r.x0 && gx <= r.x1 && gz >= r.z0 && gz <= r.z1
// A street cell of tile (tx, tz), GLOBAL (the walks start there).
const streetStart = (seed, tx, tz, cy = 0) => {
  const c = streetCellOf(seed, tx, tz)
  return { gx: tx * TILE_W + c.gx, gz: tz * TILE_D + c.gz, cy }
}

describe('suburb family (§12.6)', () => {
  it('tile, footprint and ports: 5×3 street level, attics only over two-storey houses, storey-0 ports', () => {
    expect(TILE).toMatchObject({ w: 5, d: 3, backend: 'band', H: 2, lo: 0, hi: 1, salt: 0x5a17000a })
    for (const seed of SEEDS) {
      for (const [tx, tz] of [[0, 0], [-3, 2], [5, -7]]) {
        const k = bandKey(tx, tz)
        const ups = new Set(forcedHouses(seed, k).map((h) => `${tx * 5 + h.up.lcx},${tz * 3 + h.up.lcz}`))
        expect(ups.size).toBe(forcedHouses(seed, k).length)
        expect(ups.size).toBeGreaterThanOrEqual(1)
        for (let cz = tz * 3; cz < tz * 3 + 3; cz++) {
          for (let cx = tx * 5; cx < tx * 5 + 5; cx++) {
            expect(footprint(seed, cx, 0, cz)).toBe('tile')
            expect(footprint(seed, cx, 1, cz)).toBe(ups.has(`${cx},${cz}`) ? 'tile' : 'solid')
            expect(planner.verticalOpeningAt(seed, cx, cz, 0)).toBe(ups.has(`${cx},${cz}`))
            for (const cy of [-1, 2]) expect(footprint(seed, cx, cy, cz)).toBe('solid')
          }
        }
        expect(ports(seed, k, 'north', 0)).toEqual(zSeamPorts(seed, tx, tz).map((x) => ({ a0: x, a1: x + STREET_W - 1 })))
        expect(ports(seed, k, 'west', 0)).toEqual(xSeamPorts(seed, tx, tz).map((z) => ({ a0: z, a1: z + STREET_W - 1 })))
        for (const side of ['west', 'north']) expect(ports(seed, k, side, 1)).toEqual([])
      }
    }
  })

  it('seam ports: 1-2 street crossings per seam, hashed per seam, shared by both tiles, open across the seam', () => {
    const counts = { x: [0, 0, 0], z: [0, 0, 0] }
    for (let seed = 0; seed < 50; seed++) {
      for (let tx = -6; tx <= 6; tx++) {
        for (let tz = -6; tz <= 6; tz++) {
          const xs = xSeamPorts(seed, tx, tz)
          const zs = zSeamPorts(seed, tx, tz)
          counts.x[xs.length]++
          counts.z[zs.length]++
          expect(xs.length >= 1 && xs.length <= 2 && zs.length >= 1 && zs.length <= 2).toBe(true)
          for (const z of xs) expect(z >= 3 && z + STREET_W - 1 <= TILE_D - 4).toBe(true)
          for (const x of zs) expect(x >= 3 && x + STREET_W - 1 <= TILE_W - 4).toBe(true)
          if (xs.length === 2) expect(xs[1] - xs[0]).toBeGreaterThanOrEqual(17)
          if (zs.length === 2) expect(zs[1] - zs[0]).toBeGreaterThanOrEqual(22)
          // Both tiles of a seam read the same crossings.
          expect(tilePorts(seed, tx - 1, tz).E).toEqual(tilePorts(seed, tx, tz).W)
          expect(tilePorts(seed, tx, tz - 1).S).toEqual(tilePorts(seed, tx, tz).N)
        }
      }
    }
    expect(counts.x[2]).toBeGreaterThan(0)
    expect(counts.z[2]).toBeGreaterThan(0)
    expect(counts.x[1]).toBeGreaterThan(counts.x[2])
    // Built: every crossing is open on both sides of its seam. Beside it the
    // neighbour's east/south rim is mass (§6.8 rule 1), and the owned
    // west/north rim cell is mass or walled on the seam line (rule 2: a lot
    // or the field runs out onto it).
    for (const seed of SEEDS) {
      for (const [tx, tz] of [[0, 0], [1, 0], [0, -1], [-1, 1]]) {
        for (const z0 of xSeamPorts(seed, tx, tz)) {
          for (let gz = z0; gz < z0 + STREET_W; gz++) {
            expect(walkable(seed, tx, tz, 0, gz), `${seed} ${tx},${tz} x-port z${gz} east side`).toBe(true)
            expect(walkable(seed, tx - 1, tz, TILE_W - 1, gz), `${seed} ${tx},${tz} x-port z${gz} west side`).toBe(true)
            const c = at(seed, tx, tz, 0, gz, 0)
            expect(c.d.wallV[c.lz * CHUNK + c.lx], `${seed} ${tx},${tz} x-port z${gz} seam wall`).toBe(0)
          }
          for (const gz of [z0 - 1, z0 + STREET_W]) {
            expect(isMass(seed, tx - 1, tz, TILE_W - 1, gz), `${seed} ${tx},${tz} x-port beside z${gz} west side`).toBe(true)
            const c = at(seed, tx, tz, 0, gz, 0)
            expect(isMass(seed, tx, tz, 0, gz) || c.d.wallV[c.lz * CHUNK + c.lx] === 1, `${seed} ${tx},${tz} x-port beside z${gz} east side`).toBe(true)
          }
        }
        for (const x0 of zSeamPorts(seed, tx, tz)) {
          for (let gx = x0; gx < x0 + STREET_W; gx++) {
            expect(walkable(seed, tx, tz, gx, 0), `${seed} ${tx},${tz} z-port x${gx} south side`).toBe(true)
            expect(walkable(seed, tx, tz - 1, gx, TILE_D - 1), `${seed} ${tx},${tz} z-port x${gx} north side`).toBe(true)
            const c = at(seed, tx, tz, gx, 0, 0)
            expect(c.d.wallH[hIdx(c.lx, c.lz)], `${seed} ${tx},${tz} z-port x${gx} seam wall`).toBe(0)
          }
          for (const gx of [x0 - 1, x0 + STREET_W]) {
            expect(isMass(seed, tx, tz - 1, gx, TILE_D - 1), `${seed} ${tx},${tz} z-port beside x${gx} north side`).toBe(true)
            const c = at(seed, tx, tz, gx, 0, 0)
            expect(isMass(seed, tx, tz, gx, 0) || c.d.wallH[hIdx(c.lx, c.lz)] === 1, `${seed} ${tx},${tz} z-port beside x${gx} south side`).toBe(true)
          }
        }
      }
    }
  })

  it('the street grammar composes every tile: varied plans, one street network, two-storey houses each in its own chunk', () => {
    const seen = { axis: new Set(), parallel: new Set(), stems: new Set(), forced: new Set(), faces: new Set(), lots: [], models: new Set() }
    const bad = []
    for (const seed of [1, 0x5eed]) {
      for (let tx = -6; tx <= 6; tx++) {
        for (let tz = -6; tz <= 6; tz++) {
          const p = suburbPlan(seed, tx, tz)
          seen.axis.add(p.axis)
          seen.parallel.add(!!p.parallel)
          seen.stems.add(p.stems)
          seen.forced.add(p.forced.length)
          seen.lots.push(p.lots.length)
          // Lots on free land only (the owned west/north rim included, never
          // the east/south rim): never on a street, never overlapping; the
          // kerb before each front door is a street.
          const taken = new Uint8Array(TILE_W * TILE_D)
          for (const l of p.lots) {
            seen.faces.add(l.face)
            if (l.model !== TWO_STOREY) seen.models.add(l.model)
            for (let t = 0; t < l.lawn + l.D + l.yard; t++) {
              for (let s = 0; s <= l.W + l.side; s++) {
                const c = lotCell(l, s, t)
                const key = c.gz * TILE_W + c.gx
                if (p.street[key] || taken[key] || c.gx < 0 || c.gz < 0 || c.gx > TILE_W - 2 || c.gz > TILE_D - 2) bad.push(`${seed} ${tx},${tz} lot ${l.index} at ${c.gx},${c.gz}`)
                taken[key] = 1
              }
            }
            const front = l.model === TWO_STOREY ? l.frontU : MODEL_DEFS[l.model].rows[0].indexOf('h')
            const kerb = lotCell(l, 1 + (l.flip ? l.W - 1 - front : front), -1)
            if (!p.street[kerb.gz * TILE_W + kerb.gx]) bad.push(`${seed} ${tx},${tz} lot ${l.index} kerb`)
          }
          // The streets are one piece (4-connected).
          let first = -1
          let total = 0
          for (let i = 0; i < p.street.length; i++) if (p.street[i]) { total++; if (first < 0) first = i }
          const seenCells = new Uint8Array(p.street.length)
          const queue = [first]
          seenCells[first] = 1
          for (let q = 0; q < queue.length; q++) {
            const i = queue[q]
            const x = i % TILE_W
            for (const j of [x > 0 ? i - 1 : -1, x < TILE_W - 1 ? i + 1 : -1, i - TILE_W, i + TILE_W]) {
              if (j < 0 || j >= p.street.length || !p.street[j] || seenCells[j]) continue
              seenCells[j] = 1
              queue.push(j)
            }
          }
          if (queue.length !== total) bad.push(`${seed} ${tx},${tz} streets in pieces`)
          // Two-storey houses: 1-4, each wholly inside its own chunk.
          expect(p.forced.length).toBeGreaterThanOrEqual(1)
          expect(p.forced.length).toBeLessThanOrEqual(4)
          expect(new Set(p.forced.map((f) => `${f.up.lcx},${f.up.lcz}`)).size).toBe(p.forced.length)
          for (const f of p.forced) {
            const r = houseRectOf(f, { u0: 0, v0: 0, u1: f.W - 1, v1: f.D - 1 })
            expect(Math.floor(r.x0 / CHUNK)).toBe(f.up.lcx)
            expect(Math.floor(r.x1 / CHUNK)).toBe(f.up.lcx)
            expect(Math.floor(r.z0 / CHUNK)).toBe(f.up.lcz)
            expect(Math.floor(r.z1 / CHUNK)).toBe(f.up.lcz)
          }
        }
      }
    }
    expect(bad.slice(0, 5)).toEqual([])
    expect([...seen.axis].sort()).toEqual(['x', 'z'])
    expect([...seen.parallel].sort()).toEqual([false, true])
    expect(seen.stems.size).toBeGreaterThanOrEqual(3)
    expect([...seen.forced].sort()).toEqual([1, 2, 3, 4])
    expect([...seen.faces].sort()).toEqual(['E', 'N', 'S', 'W'])
    expect(seen.models.size).toBe(5)
    expect(Math.min(...seen.lots)).toBeGreaterThanOrEqual(6)
  })

  it('upstairs vary: four two-storey models, every ground plan in use, each house draws its own upstairs (walls mean Jaccard ≤ 0.25, two houses of one plan on a tile never share one)', () => {
    const grounds = new Set()
    const drawn = new Set()
    const walls = []
    let clash = 0
    let fallback = 0
    // The upstairs walls in the house frame (the reviewer's upsim measure):
    // every edge inside the outline between two cells that differ (room /
    // hall / core / eave).
    const wallSet = (rows) => {
      const set = new Set()
      const D = rows.length
      const W = rows[0].length
      for (let v = 0; v < D; v++) {
        for (let u = 0; u < W; u++) {
          const c = rows[v][u]
          if (u + 1 < W && c !== rows[v][u + 1]) set.add(`r${u},${v}`)
          if (v + 1 < D && c !== rows[v + 1][u]) set.add(`d${u},${v}`)
        }
      }
      return set
    }
    for (const seed of [1, 0x5eed]) {
      for (let tx = -6; tx <= 6; tx++) {
        for (let tz = -6; tz <= 6; tz++) {
          const forced = suburbPlan(seed, tx, tz).forced
          const seen = new Set()
          for (const f of forced) {
            const kind = TWO_STOREY_KINDS[f.two]
            expect(kind.W).toBe(f.W)
            expect(kind.D).toBe(f.D)
            grounds.add(`${f.two}:${f.ground}`)
            if (f.atticPlan < 0) continue
            const key = `${f.two}:${f.ground}:${f.attic.rows.join('|')}`
            if (seen.has(key)) clash++
            seen.add(key)
            if (kind.variants[f.ground].attics.includes(f.attic)) fallback++
            drawn.add(key)
            walls.push(wallSet(f.attic.rows))
          }
        }
      }
    }
    expect(grounds.size).toBe(TWO_STOREY_KINDS.reduce((n, k) => n + k.variants.length, 0))
    expect(clash).toBe(0)
    expect(fallback).toBeLessThanOrEqual(walls.length / 100)
    expect(drawn.size).toBeGreaterThan(walls.length * 0.8)
    const jac = (a, b) => {
      let i = 0
      for (const x of a) if (b.has(x)) i++
      return i / (a.size + b.size - i || 1)
    }
    let sum = 0
    let n = 0
    for (let i = 0; i < walls.length; i++) for (let j = i + 1; j < walls.length; j++, n++) sum += jac(walls[i], walls[j])
    expect(sum / n).toBeLessThanOrEqual(0.25)
  })

  it('tiles differ: storey-0 walls and columns of 12 tiles, mean pairwise Jaccard ≤ 0.25, max ≤ 0.45', () => {
    // The repetition gate (scratchpad repeat/sim.mjs): wall edges and column
    // cells of whole tiles, compared pairwise in their own frames.
    const seed = 1
    const sets = []
    for (let a = 0; a < 4; a++) {
      for (let b = 0; b < 3; b++) {
        const tx = a * 3 + 1
        const tz = b * 3 + 1
        const set = new Set()
        for (let dz = 0; dz < TILE.d; dz++) {
          for (let dx = 0; dx < TILE.w; dx++) {
            const d = src(seed).chunkAt(tx * TILE.w + dx, 0, tz * TILE.d + dz)
            for (let i = 0; i < CHUNK * CHUNK; i++) {
              const k = `${dx},${dz},${i}`
              if (d.wallV[i]) set.add(`v${k}`)
              if (d.wallH[i]) set.add(`h${k}`)
              if (d.cols[i]) set.add(`c${k}:${d.cols[i]}`)
            }
          }
        }
        sets.push(set)
      }
    }
    let sum = 0
    let n = 0
    let max = 0
    for (let i = 0; i < sets.length; i++) {
      for (let j = i + 1; j < sets.length; j++) {
        let both = 0
        for (const x of sets[i]) if (sets[j].has(x)) both++
        const jac = both / (sets[i].size + sets[j].size - both)
        sum += jac
        n++
        max = Math.max(max, jac)
      }
    }
    expect(sum / n).toBeLessThanOrEqual(0.25)
    expect(max).toBeLessThanOrEqual(0.45)
  }, 60_000)

  it('every tile has a house stair to its attic, and every attic room is reachable from the street', () => {
    for (const seed of SEEDS) {
      for (const [tx, tz] of [[0, 0], [1, 0], [0, 1], [-1, -1]]) {
        const s = src(seed)
        const k = bandKey(tx, tz)
        const houses = forcedHouses(seed, k)
        expect(houses.length).toBeGreaterThanOrEqual(1)
        for (const h of houses) {
          const cx = tx * 5 + h.up.lcx
          const cz = tz * 3 + h.up.lcz
          const down = s.chunkAt(cx, 0, cz)
          const up = s.chunkAt(cx, 1, cz)
          expect(down.stairUp, `${seed} ${tx},${tz} house ${h.slot} stair up`).toBeTruthy()
          expect(up.stairDown, `${seed} ${tx},${tz} house ${h.slot} stair down`).toEqual(down.stairUp)
        }
        // One walk graph over the tile (both storeys): every walkable attic
        // cell is in the street's component.
        const g = walkGraph(s, tileBox(tx, tz))
        const st = streetStart(seed, tx, tz)
        const start = g.keyOf(st.gx, st.gz, 0)
        expect(g.nodes.has(start)).toBe(true)
        const seen = new Set([start])
        const stack = [g.nodes.get(start)]
        while (stack.length) {
          for (const [nk] of g.neighbors(stack.pop())) {
            if (seen.has(nk)) continue
            seen.add(nk)
            stack.push(g.nodes.get(nk))
          }
        }
        let attic = 0
        for (const [key, n] of g.nodes) {
          if (n.cy !== ATTIC) continue
          attic++
          expect(seen.has(key), `${seed} ${tx},${tz} attic cell ${n.gx},${n.gz} unreachable`).toBe(true)
        }
        expect(attic).toBeGreaterThanOrEqual(houses.length * 30)
      }
    }
  })

  it('the anchor tile: its forced house is the only lit house, in a tint found nowhere else; the exit is in its attic', () => {
    for (const seed of [...SEEDS, 42, 0xbeef]) {
      const t = exitTileOf(seed)
      expect(Math.abs(t.tx)).toBe(2)
      expect(Math.abs(t.tz)).toBeLessThanOrEqual(1)
      const s = src(seed)
      const rect = houseRect(seed, t.tx, t.tz)
      const h = forcedHouses(seed, bandKey(t.tx, t.tz))[0]
      const porch = houseCellOf(h, h.frontU, -1)
      const porchG = { gx: porch.gx + t.tx * TILE_W, gz: porch.gz + t.tz * TILE_D }
      // The coach light over its driveway burns with the porch.
      const drive = lotCell(h, 0, h.lawn)
      const driveG = { gx: drive.gx + t.tx * TILE_W, gz: drive.gz + t.tz * TILE_D }
      let inside = 0
      for (const [cx, cy, cz] of boxChunks(tileBox(t.tx, t.tz))) {
        const d = s.chunkAt(cx, cy, cz)
        for (const l of d.lamps) {
          if (!l.lit) continue
          const gx = cx * CHUNK + l.lx
          const gz = cz * CHUNK + l.lz
          if (inRect(rect, gx, gz)) {
            inside++
            expect(l.tint, `${seed} anchor-house lamp ${gx},${gz},${cy}`).toBe(TINT_EXIT)
          } else if ((gx === porchG.gx && gz === porchG.gz) || (gx === driveG.gx && gz === driveG.gz)) {
            expect(l.tint).toBe(TINT_EXIT)
          } else {
            // Nothing else burns but a streetlight or moonlight on open ground.
            expect([TINT_STREET, TINT_MOON], `${seed} lamp ${gx},${gz},${cy} outside the anchor house`).toContain(l.tint)
            expect(d.cellKind[l.lz * CHUNK + l.lx]).toBe(CELL_OPEN)
          }
        }
      }
      expect(inside, `${seed} the anchor house burns`).toBeGreaterThanOrEqual(4)
      // The exit is that house's attic hall end, on storey 1.
      const e = exitAnchor(seed)
      expect(e.cy).toBe(ATTIC)
      expect(inRect(rect, e.cx * CHUNK + e.lx, e.cz * CHUNK + e.lz)).toBe(true)
      const ex = familyExitHook(config)({ worldSeed: seed, level: 1, config, profile, generate: s.chunkAt })
      expect(ex).toEqual({ cx: e.cx, cy: e.cy, cz: e.cz, lx: e.lx, lz: e.lz })
      expect(hookOf(ID).exitHookStats.lastResort).toBe(0)
    }
    // TINT_EXIT burns in no other tile.
    for (const seed of SEEDS) {
      const t = exitTileOf(seed)
      for (const [tx, tz] of [[0, 0], [1, 0], [0, 1], [-t.tx, t.tz]]) {
        if (isAnchorTile(seed, { tx, tz })) continue
        for (const [cx, cy, cz] of boxChunks(tileBox(tx, tz))) {
          for (const l of src(seed).chunkAt(cx, cy, cz).lamps) expect(l.tint, `${seed} ${tx},${tz}`).not.toBe(TINT_EXIT)
        }
      }
    }
  })

  it('exit bounds over 300 seeds: the attic of a tile at Chebyshev distance 2, 7..13 chunks from the spawn', () => {
    const { exitBounds } = hookOf(ID)
    const sp = familySpawn(config, 1)
    for (let seed = 0; seed < 300; seed++) {
      const e = exitAnchor(seed)
      const d = Math.max(Math.abs(e.cx - sp.cx), Math.abs(e.cz - sp.cz))
      expect(d).toBeGreaterThanOrEqual(Math.max(7, exitBounds.minChunks))
      expect(d).toBeLessThanOrEqual(Math.min(13, exitBounds.maxChunks))
      expect(e.cy).toBe(1)
    }
  })

  it('lamp cap: ≤ 12 lit lamps per chunk-storey in the anchor tile and an anomaly tile', () => {
    for (const seed of SEEDS) {
      const t = exitTileOf(seed)
      for (const [tx, tz] of [[t.tx, t.tz], [3, 0], [-3, 1]]) {
        for (const [cx, cy, cz] of boxChunks(tileBox(tx, tz))) {
          expect(src(seed).chunkAt(cx, cy, cz).lamps.filter((l) => l.lit).length).toBeLessThanOrEqual(12)
        }
      }
    }
  })

  it('anomalies: hashed per tile, depth dial, never near the spawn or on the exit tile, rotated, every class occurs', () => {
    const seen = new Set()
    let eligible = 0
    let present = 0
    for (let seed = 0; seed < 40; seed++) {
      const ex = exitTileOf(seed)
      const A = new Map()
      for (let tx = -7; tx <= 7; tx++) for (let tz = -7; tz <= 7; tz++) A.set(`${tx},${tz}`, anomalyAt(seed, bandKey(tx, tz)))
      for (let tx = -7; tx <= 7; tx++) {
        for (let tz = -7; tz <= 7; tz++) {
          const a = A.get(`${tx},${tz}`)
          // Determinism, independent of the order of queries.
          expect(anomalyAt(seed, bandKey(tx, tz))).toBe(a)
          if (Math.max(Math.abs(tx), Math.abs(tz)) <= 1 || (tx === ex.tx && tz === ex.tz)) {
            expect(a, `${seed} ${tx},${tz} excluded`).toBeNull()
            continue
          }
          eligible++
          if (a) {
            present++
            seen.add(a)
            expect(ANOMALY_CLASSES).toContain(a)
          }
          for (const [dx, dz] of [[1, 0], [0, 1]]) {
            const b = A.get(`${tx + dx},${tz + dz}`)
            if (a && b) expect(b, `${seed} ${tx},${tz} rotation`).not.toBe(a)
          }
        }
      }
    }
    expect([...seen].sort()).toEqual([...ANOMALY_CLASSES].sort())
    // Doc 14: suburb 1 per 2 streets (a tile holds two) times the depth dial.
    const share = present / eligible
    expect(share).toBeGreaterThan(0.6)
    expect(share).toBeLessThan(0.9)
    expect(anomalyChance(2, 0)).toBeCloseTo(0.5)
    expect(anomalyChance(9, 9)).toBeCloseTo(0.9)
  })

  it('a tile carrying each anomaly audits clean, stays connected and shows its anomaly', () => {
    const seed = 1
    const found = new Map()
    for (let r = 2; r <= 5 && found.size < ANOMALY_CLASSES.length; r++) {
      for (let tx = -r; tx <= r; tx++) {
        for (const tz of [-1, 0, 1]) {
          const a = anomalyAt(seed, bandKey(tx, tz))
          if (a && !found.has(a)) found.set(a, [tx, tz])
        }
      }
    }
    expect([...found.keys()].sort()).toEqual([...ANOMALY_CLASSES].sort())
    const s = src(seed)
    for (const [cls, [tx, tz]] of found) {
      const box = tileBox(tx, tz)
      const audit = massLeakAudit(s.chunkAt, box, { gen, worldSeed: seed })
      expect(audit.details.leaks, cls).toEqual([])
      expect(audit.details.seals, cls).toEqual([])
      expect(audit.details.seeThroughThinMass, cls).toEqual([])
      expect(audit.sealedMass, cls).toBe(true)
      const layered = auditLayeredPatch(s.chunkAt, box.x0, 0, box.z0, 5, 2, 3)
      expect(Object.fromEntries(STRUCTURAL_COUNTERS.filter((c) => layered[c]).map((c) => [c, layered[c]])), cls).toEqual({})
      const conn = windowConnectivity(s, box, { ...box, x0: box.x0 - 1, x1: box.x1 + 1, z0: box.z0 - 1, z1: box.z1 + 1 }, streetStart(seed, tx, tz))
      expect({ ok: conn.ok, reason: conn.reason }, cls).toEqual({ ok: true, reason: null })
      const notes = tileBakeAt(seed, bandKey(tx, tz), config).notes
      expect(notes).toContain(`anomaly: ${cls}`)
      if (cls === 'nine') {
        const row = nineRowOf(seed, bandKey(tx, tz))
        for (let lcz = 0; lcz < 3; lcz++) {
          for (let lcx = 0; lcx < 5; lcx++) expect(s.chunkAt(tx * 5 + lcx, 0, tz * 3 + lcz).levelLabel === '9').toBe(lcz === row)
        }
      }
      if (cls === 'door') {
        // The doorless house: the edge between its porch and its front hall
        // cell (any facing) is walled, and the hall cell is a room cell.
        const m = notes.join('\n').match(/the house at (\d+),(\d+) has no front door \(door cell (\d+),(\d+)\)/)
        expect(m).toBeTruthy()
        const [px, pz, dx, dz] = m.slice(1, 5).map(Number)
        expect(Math.abs(px - dx) + Math.abs(pz - dz)).toBe(1)
        const hall = at(seed, tx, tz, dx, dz, 0)
        expect(hall.d.cellKind[hall.lz * CHUNK + hall.lx]).toBe(CELL_ROOM)
        const edge = pz === dz
          ? at(seed, tx, tz, Math.max(px, dx), pz, 0)
          : at(seed, tx, tz, px, Math.max(pz, dz), 0)
        const wall = pz === dz ? edge.d.wallV[edge.lz * CHUNK + edge.lx] : edge.d.wallH[hIdx(edge.lx, edge.lz)]
        expect(wall).toBe(1)
      }
      if (cls === 'upstairs') {
        // The attic repeats the ground floor: the same room roles over the
        // living room and the kitchen.
        const h = forcedHouses(seed, bandKey(tx, tz))[0]
        for (let v = 0; v < h.D; v++) {
          for (let u = 7; u < h.W; u++) {
            const c = houseCellOf(h, u, v)
            const g = at(seed, tx, tz, c.gx, c.gz, 0)
            const a = at(seed, tx, tz, c.gx, c.gz, 1)
            expect(a.d.spaceRole[a.lz * CHUNK + a.lx], `${u},${v}`).toBe(g.d.spaceRole[g.lz * CHUNK + g.lx])
            // ...and the same furniture, piece for piece (doc §10.9).
            const pieces = (c) => c.d.furniture.filter((f) => f.lx === c.lx && f.lz === c.lz).map((f) => ({ ...f }))
            expect(pieces(a), `furniture ${u},${v}`).toEqual(pieces(g))
            expect(a.d.cols[a.lz * CHUNK + a.lx], `column ${u},${v}`).toBe(g.d.cols[g.lz * CHUNK + g.lx])
          }
        }
        expect(houseFurniture(seed, tx, tz, h, 1).length).toBeGreaterThan(0)
      }
    }
  })

  it('no walk-graph pockets: every free cell of a 3×3-tile window joins the street graph (lawns behind rails, room corners)', () => {
    // Near the spawn and far out (the reviewer's lawn-behind-a-mailbox case
    // was seed 0xdeadbeef, tile (-39, -67); seed 31337 tile (42, 69) had a
    // side-yard strip's end cell freed by the prop-kind cap behind the piece
    // at its mouth: unboxFreed).
    for (const [seed, tx0, tz0] of [[1, -1, -1], [0x5eed, 1, -2], [0xdeadbeef, -40, -67], [31337, 41, 68]]) {
      const s = seed === 0xdeadbeef || seed === 31337 ? worldSource(seed, config) : src(seed)
      const inner = { x0: tx0 * TILE.w, z0: tz0 * TILE.d, x1: (tx0 + 3) * TILE.w - 1, z1: (tz0 + 3) * TILE.d - 1, y0: 0, y1: 1 }
      const outer = { x0: inner.x0 - TILE.w, z0: inner.z0 - TILE.d, x1: inner.x1 + TILE.w, z1: inner.z1 + TILE.d, y0: 0, y1: 1 }
      const conn = windowConnectivity(s, inner, outer, streetStart(seed, tx0 + 1, tz0 + 1))
      expect({ ok: conn.ok, reason: conn.reason }, `${seed} ${tx0},${tz0}`).toEqual({ ok: true, reason: null })
      expect(conn.pockets.map((p) => [p.size, p.sample]), `${seed} ${tx0},${tz0}`).toEqual([])
    }
  })

  it('a forced attempt-1 bake (new tileSeed, same planSeed) matches the geometry: no error, one exit', () => {
    for (const seed of SEEDS) {
      for (const [tx, tz] of [[0, 0], [2, 1], [-2, 0]]) {
        const k = bandKey(tx, tz)
        const planSeed = planSeedOf(seed, k)
        const win = tileWindow(TILE, k)
        const canvas = new TileCanvas({
          family: ID, base: 'hotel', version: config.version, worldSeed: seed, origin: k.origin, district: { dx: tx, dz: tz },
          keep: (cx, cy, cz) => cx >= win.cx0 && cx <= win.cx1 && cz >= win.cz0 && cz <= win.cz1 && cy >= k.cy0 && cy <= k.cy1 &&
            footprint(seed, cx, cy, cz) === 'tile',
          solidChunk: (cx, cy, cz) => solidChunk(seed, cx, cy, cz, config, ID, { district: { dx: tx, dz: tz } }),
        })
        const ctx = makeTileCtx(gen, profile, seed, config, k, canvas, { tileSeed: hash2i(planSeed, 1, 0x7e) >>> 0, planSeed, attempt: 1 })
        let res = null
        expect(() => { res = gen.bake(canvas, ctx) }).not.toThrow()
        expect(res?.error).toBeUndefined()
        expect(ctx.notes.filter((n) => n.startsWith('kit:') || n.startsWith('seam:'))).toEqual([])
        expect(ctx.exits).toHaveLength(1)
        expect(canvas.stats.scratchWalkableWrites).toBe(0)
      }
    }
  })
})

// Every furniture piece over the living room and the kitchen (u ≥ 7) of
// forced house h on storey cy.
function houseFurniture(seed, tx, tz, h, cy) {
  const out = []
  for (let v = 0; v < h.D; v++) {
    for (let u = 7; u < h.W; u++) {
      const c = houseCellOf(h, u, v)
      const p = at(seed, tx, tz, c.gx, c.gz, cy)
      out.push(...p.d.furniture.filter((f) => f.lx === p.lx && f.lz === p.lz))
    }
  }
  return out
}

function boxChunks(b) {
  const out = []
  for (let cy = b.y0; cy <= b.y1; cy++) for (let cz = b.z0; cz <= b.z1; cz++) for (let cx = b.x0; cx <= b.x1; cx++) out.push([cx, cy, cz])
  return out
}
