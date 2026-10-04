import { describe, expect, it } from 'vitest'
import { CHUNK, cIdx, hIdx, vIdx } from '../../../constants.js'
import { hash2i } from '../../../core/hash.js'
import { auditLayeredPatch } from '../../../audit.js'
import { resolveMapFamily } from '../../../mapFamily.js'
import { CELL_ATRIUM, CELL_CORRIDOR, CELL_ROOM, CELL_VOID, PASSAGE_DOOR, WALL_RAIL } from '../../../mapTypes.js'
import { buildChunk } from '../../../pipeline.js'
import { PROP_HALL_CLOCK, PROP_RADIO } from '../../../props/index.js'
import {
  FURN_BED,
  FURN_CHAIR,
  FURN_FRIDGE,
  FURN_SINK,
  FURN_SOFA,
  FURN_STOVE,
  FURN_TABLE,
  FURN_TOILET,
  FURN_TV,
  FURN_WARDROBE,
  FURN_WASHER,
} from '../../../rooms/catalog.js'
import { stairwellDoor, stairwellPlan } from '../../../structures/authored.js'
import { catalogSliceErrors } from '../../../structures/catalog/audit.js'
import { STAIR_E, STAIR_N, STAIR_S, STAIR_W } from '../../../structures/slab.js'
import { makeTileCtx, tileBakeAt } from '../../../tiles/familyChunk.js'
import { isMassCell, massLeakAudit } from '../../../tiles/seams.js'
import { solidChunk } from '../../../tiles/solidChunk.js'
import { TileCanvas } from '../../../tiles/TileCanvas.js'
import { tileWindow } from '../../../tiles/tileKey.js'
import { forcedFamilyConfig } from '../../forced.js'
import { familyGenerator } from '../../generators.js'
import { familyExitHook, familySpawn, hookOf } from '../../hooks.js'
import { familyPlanner } from '../../planners.js'
import { componentPartition, proveReachable, windowConnectivity, worldSource } from '../../reach.js'
import { STRUCTURAL_COUNTERS, plannerKeySweep, runFamilySuite } from '../../__tests__/familyHarness.js'
import {
  ALL_CHUNKS,
  ANOMALY_CLASSES,
  DIR,
  EXIT_TILES,
  HALL_SHAPES,
  LOOP_ANOMALIES,
  SPAWN_CELLS,
  TILE,
  TILE_D,
  TILE_W,
  anomalyAt,
  bandKey,
  chunkOf,
  depthOf,
  exitCellsOfTile,
  exitTileOf,
  footprint,
  frameOf,
  hallOf,
  hasHall,
  hasLoop,
  labelOf,
  northPortCol,
  planSeedOf,
  ports,
  portsOfTile,
  stairCore,
  variantAt,
  variantWeights,
  westPortRow,
} from '../geometry.js'
import { CORR, ROLES, hallCapOf, loopSizesOf, planTile, usableMask } from '../layout.js'
import { RED, closetRow, qCell } from '../tile.js'
import { bareShareOf } from '../world.js'

// The house family suite (spec §11.1, §12.11): W = 2×2 tiles × storeys 0..2;
// the decision-6 window is 5×3 tiles × 0..2.
runFamilySuite('house', {
  window: { tiles: [2, 2], storeys: [0, 2] },
  connWindow: { tiles: [5, 3], storeys: [0, 2] },
})

// --- house specifics (§12.11 Tests) ------------------------------------------------------
//
// Every tile is GROWN from the family grammar (layout.js): the frame (hashed
// seam ports, stair cores, the Great Hall's chunk and shape, the storeys'
// chunk sets), then per storey a hallway network routed between the anchors
// with junctions and loops, rooms hung off it (front rooms, rooms behind
// rooms, closets) — no tile is a copy of another. The finite kind is the
// parts catalogue (tile.js).

const ID = 'house'
const config = forcedFamilyConfig(ID)
const profile = resolveMapFamily(config)
const gen = familyGenerator(ID)
const planner = familyPlanner(ID)
const SEEDS = [1, 0x5eed, 777]

const popcount = (m) => {
  let n = 0
  for (let i = 0; i < 6; i++) n += (m >> i) & 1
  return n
}
const connected = (m) => {
  const bits = [0, 1, 2, 3, 4, 5].filter((i) => (m >> i) & 1)
  if (!bits.length) return true
  const seen = new Set([bits[0]])
  const q = [bits[0]]
  while (q.length) {
    const i = q.pop()
    const { lx, lz } = chunkOf(i)
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = lx + dx
      const z = lz + dz
      const j = x + 3 * z
      if (x < 0 || x > 2 || z < 0 || z > 1 || !((m >> j) & 1) || seen.has(j)) continue
      seen.add(j)
      q.push(j)
    }
  }
  return seen.size === bits.length
}
// The tile's chunk box (GLOBAL chunks) over storeys y0..y1.
const tileBox = (tx, tz, y0 = 0, y1 = 2) => ({ x0: tx * 3, z0: tz * 2, x1: tx * 3 + 2, z1: tz * 2 + 1, y0, y1 })
const boxOfTiles = (tx0, tz0, tx1, tz1, y0 = 0, y1 = 2) => ({ x0: tx0 * 3, z0: tz0 * 2, x1: tx1 * 3 + 2, z1: tz1 * 2 + 1, y0, y1 })
// A tile-local cell of tile (tx, tz) on storey cy: its chunk and local cell.
const at = (src, tx, tz, gx, gz, cy) => {
  const x = tx * TILE_W + gx
  const z = tz * TILE_D + gz
  const cx = Math.floor(x / CHUNK)
  const cz = Math.floor(z / CHUNK)
  return { d: src.chunkAt(cx, cy, cz), lx: x - cx * CHUNK, lz: z - cz * CHUNK, gx: x, gz: z }
}
const shift = (r, tx, tz) => ({ x0: r.x0 + tx * TILE_W, z0: r.z0 + tz * TILE_D, x1: r.x1 + tx * TILE_W, z1: r.z1 + tz * TILE_D })
// The first tiles (spiral order from (0,0)) of `seed` passing `test`.
function findTiles(seed, test, count = 1, reach = 8) {
  const out = []
  for (let ring = 0; ring <= reach && out.length < count; ring++) {
    for (let tz = -ring; tz <= ring && out.length < count; tz++) {
      for (let tx = -ring; tx <= ring && out.length < count; tx++) {
        if (Math.max(Math.abs(tx), Math.abs(tz)) !== ring) continue
        if (test(tx, tz)) out.push({ tx, tz })
      }
    }
  }
  return out
}
// Wall edges and columns of a tile on storey cy (the variety metric of the
// proc-* tasks: SP/repeat/sim.mjs).
function tileSignature(seed, tx, tz, cy) {
  const s = new Set()
  for (let dz = 0; dz < TILE.d; dz++) {
    for (let dx = 0; dx < TILE.w; dx++) {
      const c = buildChunk(seed, tx * TILE.w + dx, cy, tz * TILE.d + dz, config, null, [])
      for (let i = 0; i < CHUNK * CHUNK; i++) {
        const k = `${dx},${dz},${i}`
        if (c.wallV[i]) s.add(`v${k}`)
        if (c.wallH[i]) s.add(`h${k}`)
        if (c.cols[i]) s.add(`c${k}:${c.cols[i]}`)
      }
    }
  }
  return s
}
const jaccard = (a, b) => {
  let i = 0
  for (const x of a) if (b.has(x)) i++
  return i / (a.size + b.size - i || 1)
}

describe('house family (§12.11)', () => {
  it('tile, footprint and ports: 3×2 chunks, storeys 0..2; storey 0 whole, the upper storeys a connected set per tile; one hashed ground door per seam', () => {
    expect(TILE).toMatchObject({ w: 3, d: 2, backend: 'band', H: 3, lo: 0, hi: 2, salt: 0x5a17000f })
    const masks = new Set()
    for (const seed of SEEDS) {
      for (let tz = -5; tz <= 5; tz++) {
        for (let tx = -5; tx <= 5; tx++) {
          const f = frameOf(seed, tx, tz)
          expect(f.up[0]).toBe(ALL_CHUNKS)
          expect(f.up[2] & ~f.up[1], `up2 ⊆ up1 at ${tx},${tz}`).toBe(0)
          expect(connected(f.up[1]) && connected(f.up[2])).toBe(true)
          expect(popcount(f.up[1])).toBeGreaterThanOrEqual(3)
          // The top keeps all of the first storey or all but one chunk (≥ 5):
          // a small top repeated the same footprint-solid mass tile to tile.
          expect(popcount(f.up[2])).toBeGreaterThanOrEqual(5)
          expect(popcount(f.up[1]) - popcount(f.up[2])).toBeLessThanOrEqual(1)
          masks.add(`${f.up[1]}/${f.up[2]}`)
          for (let cy = 0; cy <= 2; cy++) {
            for (let i = 0; i < 6; i++) {
              const { lx, lz } = chunkOf(i)
              expect(footprint(seed, tx * 3 + lx, cy, tz * 2 + lz)).toBe((f.up[cy] >> i) & 1 ? 'tile' : 'solid')
            }
          }
          expect(footprint(seed, tx * 3, 3, tz * 2)).toBe('solid')
          expect(footprint(seed, tx * 3, -1, tz * 2)).toBe('solid')
          // Ports: hashed per seam, one per side, both sides agree.
          const p = portsOfTile(seed, tx, tz)
          expect(ports(seed, bandKey(tx, tz), 'west', 0)).toEqual([{ a0: p.w.gz, a1: p.w.gz }])
          expect(ports(seed, bandKey(tx, tz), 'north', 0)).toEqual([{ a0: p.n.gx, a1: p.n.gx }])
          for (const cy of [1, 2]) for (const side of ['west', 'north']) expect(ports(seed, bandKey(tx, tz), side, cy)).toEqual([])
          expect(p.e.gz).toBe(portsOfTile(seed, tx + 1, tz).w.gz)
          expect(p.s.gx).toBe(portsOfTile(seed, tx, tz + 1).n.gx)
        }
      }
    }
    // The stacking varies tile to tile (not one fixed upper plan): every one
    // of the 13 stackings the rule allows (storey 1 whole or one of six 5-chunk
    // sets; the top the same, or the whole first storey less one chunk) turns up.
    expect(masks.size).toBe(13)
    // The ports wander along the seams.
    const rows = new Set()
    const cols = new Set()
    for (let t = -10; t <= 10; t++) {
      rows.add(westPortRow(1, t, 3))
      cols.add(northPortCol(1, 3, t))
    }
    expect(rows.size).toBeGreaterThan(8)
    expect(cols.size).toBeGreaterThan(8)
    // The spawn tile's west door opens above the yard; tile (0,1)'s north
    // door (the yard's south seam) east of it.
    for (const seed of SEEDS) {
      expect(westPortRow(seed, 0, 0)).toBeLessThan(15)
      expect(northPortCol(seed, 0, 1)).toBeGreaterThan(15)
    }
  })

  it('variants: the shell at (0,0), the hall at the exit tile, the rest weighted by depth (rooms near the door, loops and halls deeper)', () => {
    const tally = new Map() // depth band → counts
    for (let seed = 1; seed <= 60; seed++) {
      expect(variantAt(seed, 0, 0)).toBe('shell')
      const ex = exitTileOf(seed)
      expect(variantAt(seed, ex.tx, ex.tz)).toBe('hall')
      expect(depthOf(ex.tx, ex.tz)).toBeGreaterThanOrEqual(3)
      expect(depthOf(ex.tx, ex.tz)).toBeLessThanOrEqual(5)
      for (let tz = -9; tz <= 9; tz++) {
        for (let tx = -9; tx <= 9; tx++) {
          if (tx === 0 && tz === 0) continue
          const d = depthOf(tx, tz)
          const band = d <= 1 ? 'near' : d <= 4 ? 'mid' : 'deep'
          const v = variantAt(seed, tx, tz)
          expect(['rooms', 'loop', 'hall']).toContain(v)
          if (d === 1) expect(v, `seed ${seed} tile ${tx},${tz}`).not.toBe('hall')
          const t = tally.get(band) ?? { rooms: 0, loop: 0, hall: 0, n: 0 }
          t[v]++
          t.n++
          tally.set(band, t)
          expect(variantAt(seed, tx, tz)).toBe(v)
        }
      }
    }
    const share = (band, v) => tally.get(band)[v] / tally.get(band).n
    expect(share('near', 'rooms')).toBeGreaterThan(share('mid', 'rooms'))
    expect(share('mid', 'rooms')).toBeGreaterThan(share('deep', 'rooms'))
    expect(share('near', 'hall')).toBeLessThan(share('mid', 'hall'))
    expect(share('mid', 'hall')).toBeLessThan(share('deep', 'hall'))
    for (const band of ['near', 'mid', 'deep']) expect(share(band, 'loop')).toBeGreaterThan(0.1)
    expect(variantWeights(1)[2]).toBe(0)
  })

  it('stair cores: the frame\'s cores are stairwellPlan\'s (core, door), each in a chunk its storeys keep; the cores move tile to tile', () => {
    expect(DIR).toEqual({ N: STAIR_N, E: STAIR_E, S: STAIR_S, W: STAIR_W })
    const spots = new Set()
    let seconds = 0
    let tiles = 0
    for (const seed of SEEDS) {
      for (let tz = -4; tz <= 4; tz++) {
        for (let tx = -4; tx <= 4; tx++) {
          const f = frameOf(seed, tx, tz)
          tiles++
          expect(f.stairs.length).toBeGreaterThanOrEqual(1)
          expect(f.stairs[0].top).toBe(2)
          if (f.stairs.length > 1) seconds++
          for (const s of f.stairs) {
            spots.add(`${s.chunk}:${s.gx % CHUNK},${s.gz % CHUNK},${s.dir}`)
            expect(stairCore(s.gx, s.gz, s.dir, s.doorSide)).toEqual({ core: s.core, door: s.door })
            const gx = tx * TILE_W + s.gx
            const gz = tz * TILE_D + s.gz
            const sp = stairwellPlan({ gx, gz, baseCy: 0, topCy: s.top, dir: s.dir, doorSide: s.doorSide })
            expect(sp.error).toBeUndefined()
            expect(sp.globalCore).toEqual(shift(s.core, tx, tz))
            const d = stairwellDoor(sp)
            const o = { x: sp.cx * CHUNK, z: sp.cz * CHUNK }
            if (d.axis === 'h') expect([s.door.axis, tx * TILE_W + s.door.gx, tz * TILE_D + s.door.gz]).toEqual(['h', o.x + d.lx, o.z + d.line])
            else expect([s.door.axis, tx * TILE_W + s.door.gx, tz * TILE_D + s.door.gz]).toEqual(['v', o.x + d.line, o.z + d.lz])
            for (let cy = 0; cy <= s.top; cy++) expect((f.up[cy] >> s.chunk) & 1).toBe(1)
            expect(s.chunk).not.toBe(f.hallChunk)
          }
          if (f.hallChunk >= 0) expect((f.up[2] >> f.hallChunk) & 1).toBe(1)
        }
      }
    }
    expect(spots.size).toBeGreaterThan(tiles * 0.8)
    expect(seconds / tiles).toBeGreaterThan(0.2)
  })

  it('planner: one Great Hall per hall tile at true global coordinates, its chunk and shape the tile\'s own; none elsewhere; 0 nulls over 2000 hall keys', () => {
    const sweep = plannerKeySweep(planner, TILE, SEEDS[0], profile, config, 2000)
    expect(sweep).toMatchObject({ keys: 2000, nulls: 0, ruleErrors: [] })
    let halls = 0
    const shapes = new Set()
    for (let seed = 1; halls < 2000; seed++) {
      for (let tz = -4; tz <= 4 && halls < 2000; tz++) {
        for (let tx = -4; tx <= 4 && halls < 2000; tx++) {
          const k = bandKey(tx, tz)
          const list = planner.structuresInTile(seed, k, profile, config)
          if (!hasHall(variantAt(seed, tx, tz))) {
            expect(list).toEqual([])
            continue
          }
          halls++
          expect(list).toHaveLength(1)
          expect(list[0], `hall null: seed ${seed} tile ${tx},${tz}`).not.toBeNull()
          const g = hallOf(seed, k).geometry
          shapes.add(`${g.chunk}:${g.side}:${g.void.x0},${g.void.z0},${g.void.x1},${g.void.z1}`)
        }
      }
    }
    expect(shapes.size).toBeGreaterThan(200)
    for (const seed of SEEDS) {
      expect(planner.structuresInTile(seed, bandKey(0, 0), profile, config)).toEqual([])
      for (const t of [exitTileOf(seed), ...findTiles(seed, (tx, tz) => variantAt(seed, tx, tz) === 'hall', 3)]) {
        const k = bandKey(t.tx, t.tz)
        const [s] = planner.structuresInTile(seed, k, profile, config)
        const g = hallOf(seed, k).geometry
        expect(HALL_SHAPES).toContain(g.shape)
        expect([s.slot, s.type, s.kind, s.family]).toEqual([0, 'greatHall', 'houseCatalog', ID])
        expect(s.globalBounds).toEqual(shift(g.bounds, t.tx, t.tz))
        expect(s.levels.map((l) => l.voids)).toEqual([[], [shift(g.void, t.tx, t.tz)], [shift(g.void, t.tx, t.tz)]])
        expect([s.baseCy, s.topCy, s.glazing]).toEqual([0, 2, 'rail'])
        const c = { cx: t.tx * 3 + (g.chunk % 3), cz: t.tz * 2 + Math.floor(g.chunk / 3) }
        expect(s.participants).toEqual([c])
        expect(s.verticalLinks.map((l) => l.lowerCy)).toEqual([0, 1])
        expect(planner.structureAt(seed, c.cx, c.cz, 1, profile, config)).toBe(s)
        expect(planner.verticalOpeningAt(seed, c.cx, c.cz, 1, profile, config)).toBe(true)
        expect(planner.verticalOpeningAt(seed, c.cx, c.cz, 2, profile, config)).toBe(false)
      }
      // Every stair core's chunk opens upward on the storeys below its top.
      for (const [tx, tz] of [[0, 0], [1, 0], [-2, 3]]) {
        const f = frameOf(seed, tx, tz)
        for (const st of f.stairs) {
          const { lx, lz } = chunkOf(st.chunk)
          const got = [0, 1, 2].map((cy) => planner.verticalOpeningAt(seed, tx * 3 + lx, tz * 2 + lz, cy, profile, config))
          expect(got.slice(0, st.top)).toEqual(Array(st.top).fill(true))
        }
      }
    }
  })

  it('the grammar: every storey plan is one hallway network reaching every anchor; rooms tile the usable cells without overlap, each door on a hallway or its parent room; second doors close room-level loops', () => {
    const loopsPer10 = []
    for (const seed of SEEDS) {
      for (const [tx, tz] of [[0, 0], [1, 0], [-2, 3], [4, -1], [3, 3], [-5, -2], ...[exitTileOf(seed)].map((t) => [t.tx, t.tz])]) {
        const plan = planTile(seed, tx, tz)
        expect(plan).toBe(planTile(seed, tx, tz))
        for (let cy = 0; cy <= 2; cy++) {
          const st = plan.storeys[cy]
          expect(st.unjoined, `seed ${seed} tile ${tx},${tz} cy ${cy}`).toBe(0)
          const mask = usableMask(plan.frame, cy)
          const owner = new Int32Array(TILE_W * TILE_D).fill(-1)
          const corr = new Set(st.corridors)
          for (const c of st.corridors) expect(mask[c]).toBeTruthy()
          st.rooms.forEach((r, i) => {
            for (let z = r.z0; z <= r.z1; z++) {
              for (let x = r.x0; x <= r.x1; x++) {
                const c = z * TILE_W + x
                expect(mask[c], `room ${i} cell ${x},${z} usable`).toBeTruthy()
                expect(owner[c], `room ${i} overlaps ${owner[c]}`).toBe(-1)
                expect(corr.has(c)).toBe(false)
                owner[c] = i
              }
            }
          })
          // Each door joins its room to a hallway or to its parent room.
          st.rooms.forEach((r, i) => {
            const d = r.door
            const a = d.axis === 'v' ? [d.gx - 1, d.gz] : [d.gx, d.gz - 1]
            const b = [d.gx, d.gz]
            const sides = [a, b].map(([x, z]) => z * TILE_W + x)
            const mine = sides.filter((c) => owner[c] === i)
            expect(mine, `room ${i} door`).toHaveLength(1)
            const other = sides.find((c) => owner[c] !== i)
            const ok = corr.has(other) || (r.parent !== undefined && r.parent !== null && r.parent >= 0 && owner[other] === r.parent) || plan.grids[cy][other] === CORR
            expect(ok, `room ${i} door at ${d.axis} ${d.gx},${d.gz} cy ${cy}`).toBe(true)
          })
          // Second doors (doc §12 loops, "a graph, not a tree"): each joins a
          // room to a hallway or another room it was not yet joined to, so the
          // room graph (rooms + the hallway network as one node; doors and
          // second doors as edges) has cycle rank E − V + 1 = links exactly.
          const node = (c) => (corr.has(c) ? -1 : owner[c])
          const edges = new Set()
          const edgeKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`)
          st.rooms.forEach((r, i) => edges.add(edgeKey(i, r.parent >= 0 ? r.parent : -1)))
          expect(edges.size).toBe(st.rooms.length)
          for (const l of st.links) {
            const a = l.axis === 'v' ? (l.gz * TILE_W + l.gx - 1) : ((l.gz - 1) * TILE_W + l.gx)
            const b = l.gz * TILE_W + l.gx
            const [na, nb] = [node(a), node(b)]
            expect(na >= -1 && nb >= -1 && na !== nb, `link ${l.axis} ${l.gx},${l.gz} joins two spaces`).toBe(true)
            for (const n of [na, nb]) if (n >= 0) expect(st.rooms[n].kind, `link into a closet at ${l.gx},${l.gz}`).toBe('room')
            const k = edgeKey(na, nb)
            expect(edges.has(k), `link ${l.axis} ${l.gx},${l.gz} repeats a join`).toBe(false)
            edges.add(k)
          }
          loopsPer10.push((10 * (edges.size - (st.rooms.length + 1) + 1)) / (st.rooms.length + 1))
          // The hallways form one network.
          if (st.corridors.length) {
            const seen = new Set([st.corridors[0]])
            const q = [st.corridors[0]]
            while (q.length) {
              const c = q.pop()
              for (const n of [c - 1, c + 1, c - TILE_W, c + TILE_W]) {
                if (corr.has(n) && !seen.has(n) && Math.abs((n % TILE_W) - (c % TILE_W)) <= 1) {
                  seen.add(n)
                  q.push(n)
                }
              }
            }
            expect(seen.size, `hallways of ${tx},${tz} cy ${cy}`).toBe(corr.size)
          }
        }
        expect(plan.storeys[0].rooms.length).toBeGreaterThan(10)
      }
    }
    // Doc §12: ≥ 2 loops per 10 nodes on average (a graph, not a tree).
    const mean = loopsPer10.reduce((a, b) => a + b, 0) / loopsPer10.length
    expect(mean, `room-level loops per 10 nodes ${mean.toFixed(2)}`).toBeGreaterThanOrEqual(2)
    expect(Math.min(...loopsPer10)).toBeGreaterThan(0)
  })

  it('domestic identity: every room is a house room of domestic size (2..3 cells a side, a bathroom or a laundry 1..2), the ground storey keeps a living room, dining room, kitchen, bedroom and bathroom; each room shows the pieces that make it read, and is full', () => {
    // What makes each role read (furnish.js RECIPES, pass 0).
    const NEED = {
      living: [FURN_SOFA, FURN_TV], dining: [FURN_TABLE, FURN_CHAIR], kitchen: [FURN_STOVE, FURN_FRIDGE],
      bed: [FURN_BED, FURN_WARDROBE], nursery: [FURN_BED], bath: [FURN_TOILET, FURN_SINK], laundry: [FURN_WASHER],
      study: [FURN_TABLE, FURN_CHAIR], den: [FURN_SOFA],
    }
    const WET = new Set(['bath', 'laundry'])
    const tally = {}
    const props = new Set()
    let rooms = 0
    let pieces = 0
    for (const seed of SEEDS) {
      const src = worldSource(seed, config)
      for (const [tx, tz] of [[1, 0], [0, 1], [-1, 0], [1, -1]]) {
        const plan = planTile(seed, tx, tz)
        for (let cy = 0; cy <= 2; cy++) {
          const st = plan.storeys[cy]
          const roles = new Set()
          // Furniture by tile-local cell.
          const at2 = new Map()
          const count = new Map()
          for (let dz = 0; dz < TILE.d; dz++) {
            for (let dx = 0; dx < TILE.w; dx++) {
              const d = src.chunkAt(tx * TILE.w + dx, cy, tz * TILE.d + dz)
              if (!d) continue
              for (const f of d.furniture) {
                const k = `${dx * CHUNK + f.lx},${dz * CHUNK + f.lz}`
                if (!at2.has(k)) at2.set(k, new Set())
                at2.get(k).add(f.kind)
                count.set(k, (count.get(k) ?? 0) + 1)
                props.add(f.kind)
              }
            }
          }
          st.rooms.forEach((rm, i) => {
            expect(ROLES, `role ${rm.role}`).toContain(rm.role)
            const w = rm.x1 - rm.x0 + 1
            const d = rm.z1 - rm.z0 + 1
            if (rm.kind === 'closet') {
              expect(w * d, `closet ${i} of ${tx},${tz} cy ${cy}`).toBeLessThanOrEqual(2)
              return
            }
            expect(Math.min(w, d), `room ${i} (${rm.role}) of ${tx},${tz} cy ${cy}`).toBeGreaterThanOrEqual(WET.has(rm.role) ? 1 : 2)
            expect(Math.max(w, d), `room ${i} (${rm.role}) of ${tx},${tz} cy ${cy}`).toBeLessThanOrEqual(3)
            roles.add(rm.role)
            if (plan.copy?.cy === cy && plan.copy.room === i) return
            const kinds = new Set()
            for (let z = rm.z0; z <= rm.z1; z++) {
              for (let x = rm.x0; x <= rm.x1; x++) {
                for (const k of at2.get(`${x},${z}`) ?? []) kinds.add(k)
                pieces += count.get(`${x},${z}`) ?? 0
              }
            }
            rooms++
            const t = (tally[rm.role] ??= { n: 0, ok: 0 })
            t.n++
            if (NEED[rm.role].every((k) => kinds.has(k))) t.ok++
          })
          if (cy === 0) for (const role of ['living', 'dining', 'kitchen', 'bed', 'bath']) expect(roles.has(role), `${role} on the ground storey of ${tx},${tz}`).toBe(true)
        }
      }
    }
    for (const [role, t] of Object.entries(tally)) {
      expect(t.n, role).toBeGreaterThan(0)
      expect(t.ok / t.n, `${role}: ${t.ok}/${t.n} rooms show their pieces`).toBeGreaterThanOrEqual(0.9)
    }
    // Full rooms (a lived-in house, not big near-empty halls): pieces packed
    // in groups, ≥ 3.5 per room on average by the front door.
    expect(pieces / rooms, `pieces per room ${(pieces / rooms).toFixed(2)}`).toBeGreaterThanOrEqual(3.5)
    // The house pack's props: the hall clock and the radio.
    expect(props.has(PROP_HALL_CLOCK)).toBe(true)
    expect(props.has(PROP_RADIO)).toBe(true)
  })

  it('the house empties with depth (doc §4.1, world.bareShareOf): rooms by the front door are all furnished, deeper tiles leave their share bare', () => {
    const bands = [{ lo: 0, hi: 3, bare: 0, rooms: 0 }, { lo: 4, hi: 8, bare: 0, rooms: 0 }, { lo: 9, hi: Infinity, bare: 0, rooms: 0 }]
    for (const seed of SEEDS) {
      const src = worldSource(seed, config)
      for (const [tx, tz] of [[1, 0], [0, 1], [2, 2], [-3, 1], [4, -2], [6, 3], [-8, 5], [12, -7]]) {
        const plan = planTile(seed, tx, tz)
        const b = bands.find((q) => plan.depth >= q.lo && plan.depth <= q.hi)
        for (let cy = 0; cy <= 2; cy++) {
          const at2 = new Set()
          for (let dz = 0; dz < TILE.d; dz++) {
            for (let dx = 0; dx < TILE.w; dx++) {
              const d = src.chunkAt(tx * TILE.w + dx, cy, tz * TILE.d + dz)
              if (d) for (const f of d.furniture) at2.add(`${dx * CHUNK + f.lx},${dz * CHUNK + f.lz}`)
            }
          }
          plan.storeys[cy].rooms.forEach((rm, i) => {
            if (rm.kind === 'closet' || (plan.copy?.cy === cy && plan.copy.room === i)) return
            let any = false
            for (let z = rm.z0; z <= rm.z1 && !any; z++) for (let x = rm.x0; x <= rm.x1 && !any; x++) any = at2.has(`${x},${z}`)
            b.rooms++
            if (!any) b.bare++
          })
        }
      }
    }
    const [near, mid, far] = bands
    for (const q of bands) expect(q.rooms, `rooms at depth ${q.lo}..${q.hi}`).toBeGreaterThan(200)
    expect(near.bare / near.rooms, 'bare share, depth ≤ 3').toBeLessThanOrEqual(0.03)
    expect(Math.abs(mid.bare / mid.rooms - bareShareOf(6) / 1000), 'bare share, depth 4..8').toBeLessThanOrEqual(0.06)
    expect(Math.abs(far.bare / far.rooms - bareShareOf(9) / 1000), 'bare share, depth ≥ 9').toBeLessThanOrEqual(0.08)
  })

  it('a house plan, not a corridor block: halls between doors of the doc\'s length by the front door, longer deeper in (hallCapOf); the P.T. loop sized by depth; one kitchen, dining room and living room to a house near the door', () => {
    expect([0, 3, 4, 6, 7, 9, 10, 12, 13].map(hallCapOf)).toEqual([4, 4, 5, 5, 6, 6, 8, 8, 14])
    // Plan: straight hallway runs between doors (hall doors, the houses'
    // front doors) longer than the tile's cap are rare (a run along a chunk
    // line has no wall in its chunk to hang a door on).
    let runs = 0
    let over = 0
    const PUB = new Set(['living', 'dining', 'kitchen'])
    for (const seed of SEEDS) {
      for (let tx = -4; tx <= 4; tx++) {
        for (let tz = -4; tz <= 4; tz++) {
          const plan = planTile(seed, tx, tz)
          const cap = hallCapOf(plan.depth)
          if (plan.loop) expect([...loopSizesOf(plan.depth, plan.frame.variant === 'shell'), 6], `loop of ${tx},${tz}`).toContain(plan.loop.S)
          for (let cy = 0; cy <= 2; cy++) {
            const g = plan.grids[cy]
            const st = plan.storeys[cy]
            const doors = new Set([...st.hallDoors, ...st.frontDoors].map((d) => `${d.axis}:${d.gx},${d.gz}`))
            for (const horiz of [true, false]) {
              const [n, m] = horiz ? [TILE_D, TILE_W] : [TILE_W, TILE_D]
              for (let a = 0; a < n; a++) {
                let k = 0
                for (let b = 0; b <= m; b++) {
                  const x = horiz ? b : a
                  const z = horiz ? a : b
                  const c = b < m && g[z * TILE_W + x] === CORR
                  if (c && !(k > 0 && doors.has(horiz ? `v:${x},${z}` : `h:${x},${z}`))) {
                    k++
                    continue
                  }
                  if (k >= 2) {
                    runs++
                    if (k > cap) over++
                  }
                  k = c ? 1 : 0
                }
              }
            }
            // The schema by the front door: no two public rooms of a role
            // within 6 cells (centre to centre) on the ground storey.
            if (cy === 0 && plan.depth <= 3) {
              const pub = st.rooms.filter((r) => PUB.has(r.role))
              for (let i = 0; i < pub.length; i++) {
                for (let j = i + 1; j < pub.length; j++) {
                  if (pub[i].role !== pub[j].role) continue
                  const dx = Math.abs(pub[i].x0 + pub[i].x1 - pub[j].x0 - pub[j].x1) / 2
                  const dz = Math.abs(pub[i].z0 + pub[i].z1 - pub[j].z0 - pub[j].z1) / 2
                  expect(Math.max(dx, dz), `two ${pub[i].role}s on ${tx},${tz}`).toBeGreaterThanOrEqual(6)
                }
              }
            }
          }
        }
      }
    }
    expect(over / runs, `runs over the cap ${over}/${runs}`).toBeLessThanOrEqual(0.03)
    // World: by the front door (tiles of depth ≤ 1) the straight open
    // hallway runs (no wall, no door across) a player walks.
    for (const seed of SEEDS) {
      const src = worldSource(seed, config)
      const all = []
      for (const [tx, tz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const box = tileBox(tx, tz, 0, 0)
        const GW = TILE_W
        const GD = TILE_D
        const cell = (x, z) => {
          const gx = box.x0 * CHUNK + x
          const gz = box.z0 * CHUNK + z
          const cx = Math.floor(gx / CHUNK)
          const cz = Math.floor(gz / CHUNK)
          return { d: src.chunkAt(cx, 0, cz), lx: gx - cx * CHUNK, lz: gz - cz * CHUNK }
        }
        const hall = (x, z) => {
          const { d, lx, lz } = cell(x, z)
          return d.cellKind[cIdx(lx, lz)] === CELL_CORRIDOR && d.cols[cIdx(lx, lz)] === 0
        }
        const open = (x, z, horiz) => {
          const { d, lx, lz } = cell(x, z)
          return horiz ? !d.wallV[vIdx(lx, lz)] && d.passageV[vIdx(lx, lz)] !== PASSAGE_DOOR : !d.wallH[hIdx(lx, lz)] && d.passageH[hIdx(lx, lz)] !== PASSAGE_DOOR
        }
        for (const horiz of [true, false]) {
          const [n, m] = horiz ? [GD, GW] : [GW, GD]
          for (let a = 0; a < n; a++) {
            let k = 0
            for (let b = 0; b <= m; b++) {
              const x = horiz ? b : a
              const z = horiz ? a : b
              const h = b < m && hall(x, z)
              if (h && (k === 0 || open(x, z, horiz))) {
                k++
                continue
              }
              if (k >= 2) all.push(k)
              k = h ? 1 : 0
            }
          }
        }
      }
      // The loop's legs are 6 (the doc's 3 + 2 L, mirrored).
      const long = all.filter((k) => k > 6).length
      expect(long / all.length, `seed ${seed}: runs > 6 cells by the door ${long}/${all.length}`).toBeLessThanOrEqual(0.02)
      expect(Math.max(...all), `seed ${seed}: longest hall by the door`).toBeLessThanOrEqual(12)
    }
  })

  it('a forced attempt-1 bake (new tileSeed, same planSeed) matches the planner: no kit:planner-mismatch, no blocked port', () => {
    for (const seed of SEEDS) {
      const tiles = [{ tx: 0, tz: 0 }, exitTileOf(seed), ...findTiles(seed, (tx, tz) => variantAt(seed, tx, tz) === 'rooms', 1), ...findTiles(seed, (tx, tz) => variantAt(seed, tx, tz) === 'loop', 1)]
      for (const { tx, tz } of tiles) {
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
        expect(ctx.exits).toHaveLength(hasHall(variantAt(seed, tx, tz)) ? 1 : 0)
        expect(ctx.spawns).toHaveLength(tx === 0 && tz === 0 ? 1 : 0)
      }
    }
  })

  it('no dead chunks: every kept chunk has walkable space; the spawn tile has the shell (hall clock) and no Great Hall', () => {
    for (const seed of SEEDS) {
      const tiles = [{ tx: 0, tz: 0 }, exitTileOf(seed), ...['rooms', 'loop'].flatMap((v) => findTiles(seed, (tx, tz) => variantAt(seed, tx, tz) === v, 2))]
      for (const { tx, tz } of tiles) {
        const f = frameOf(seed, tx, tz)
        const bake = tileBakeAt(seed, bandKey(tx, tz), config)
        expect(bake.chunks.size).toBe(f.up.reduce((n, m) => n + popcount(m), 0))
        for (const d of bake.chunks.values()) {
          let open = 0
          for (let lz = 0; lz < CHUNK; lz++) for (let lx = 0; lx < CHUNK; lx++) if (!isMassCell(d, lx, lz)) open++
          expect(open, `seed ${seed} tile ${tx},${tz} chunk ${d.cx},${d.cy},${d.cz}`).toBeGreaterThan(0)
        }
      }
      expect(variantAt(seed, 0, 0)).toBe('shell')
      expect(hasHall(variantAt(seed, 0, 0))).toBe(false)
      expect(hasLoop(variantAt(seed, 0, 0))).toBe(true)
      const src = worldSource(seed, config)
      // The shell's hall clock by the back door (tile cell 6,17: chunk 0,1).
      expect(src.chunkAt(0, 0, 1).furniture.some((f) => f.kind === PROP_HALL_CLOCK)).toBe(true)
      // Nothing stands over the shell.
      for (const cy of [1, 2]) expect(footprint(seed, 0, cy, 1)).toBe('solid')
    }
  })

  it('every tile is one walkable component over its storeys (stair cores, the hall\'s flights), and its four seam doors join it', () => {
    for (const seed of SEEDS) {
      const src = worldSource(seed, config)
      const tiles = [{ tx: 0, tz: 0 }, exitTileOf(seed), ...['rooms', 'loop'].flatMap((v) => findTiles(seed, (tx, tz) => variantAt(seed, tx, tz) === v, 1))]
      for (const { tx, tz } of tiles) {
        const comps = componentPartition(src, tileBox(tx, tz))
        expect(comps.length, `components of tile ${tx},${tz} (${variantAt(seed, tx, tz)})`).toBe(1)
        const set = new Set(comps[0])
        const p = portsOfTile(seed, tx, tz)
        for (const c of [p.w, p.e, p.n, p.s]) {
          expect(set.has(`${tx * TILE_W + c.gx},${tz * TILE_D + c.gz},0`), `seam door ${c.side} ${c.gx},${c.gz} of ${tx},${tz}`).toBe(true)
        }
        const f = frameOf(seed, tx, tz)
        for (const s of f.stairs) {
          const { lx, lz } = chunkOf(s.chunk)
          for (let cy = 0; cy < s.top; cy++) expect(!!src.chunkAt(tx * 3 + lx, cy, tz * 2 + lz).stairUp).toBe(true)
          for (let cy = 1; cy <= s.top; cy++) expect(!!src.chunkAt(tx * 3 + lx, cy, tz * 2 + lz).stairDown).toBe(true)
        }
        for (const cy of [1, 2]) expect(comps[0].some((c) => c.endsWith(`,${cy}`)), `storey ${cy} of ${tx},${tz}`).toBe(true)
      }
    }
  })

  it('massLeakAudit and connectivity on a hall tile and its east and south neighbours', () => {
    for (const seed of SEEDS) {
      const src = worldSource(seed, config)
      for (const h of [exitTileOf(seed), ...findTiles(seed, (tx, tz) => variantAt(seed, tx, tz) === 'hall' && (tx || tz), 1)]) {
        const box = boxOfTiles(h.tx, h.tz, h.tx + 1, h.tz + 1)
        const audit = massLeakAudit(src.chunkAt, box, { gen, worldSeed: seed })
        expect(audit.details).toEqual({ leaks: [], seals: [], portViolations: [], seeThroughToSolid: [], seeThroughThinMass: [] })
        const lay = auditLayeredPatch(src.chunkAt, box.x0, 0, box.z0, box.x1 - box.x0 + 1, 3, box.z1 - box.z0 + 1)
        expect(Object.fromEntries(STRUCTURAL_COUNTERS.filter((c) => lay[c]).map((c) => [c, lay[c]]))).toEqual({})
        const comps = componentPartition(src, box)
        expect(comps.length, `components over hall ${h.tx},${h.tz} + E + S`).toBe(1)
      }
    }
  })

  it('the Great Hall in the world: dark, unfurnished ring; the void over storeys 1..2 behind rails; the planned doors; exit under the void', () => {
    for (const seed of SEEDS) {
      const src = worldSource(seed, config)
      const { tx, tz } = exitTileOf(seed)
      const plan = planTile(seed, tx, tz)
      const g = plan.hall.geometry
      const ring = g.ring
      const v = g.void
      for (let cy = 0; cy <= 2; cy++) {
        let rails = 0
        for (let gz = ring.z0; gz <= ring.z1; gz++) {
          for (let gx = ring.x0; gx <= ring.x1; gx++) {
            const c = at(src, tx, tz, gx, gz, cy)
            expect(c.d.lamps.filter((l) => l.lx === c.lx && l.lz === c.lz), `lamp ${gx},${gz},${cy}`).toEqual([])
            expect(c.d.furniture.filter((f) => f.lx === c.lx && f.lz === c.lz)).toEqual([])
            const inVoid = gx >= v.x0 && gx <= v.x1 && gz >= v.z0 && gz <= v.z1
            if (inVoid) expect(c.d.cellKind[cIdx(c.lx, c.lz)]).toBe(cy === 0 ? CELL_ATRIUM : CELL_VOID)
            if (c.d.wallFeatureH?.[hIdx(c.lx, c.lz)] === WALL_RAIL) rails++
            if (c.d.wallFeatureV?.[vIdx(c.lx, c.lz)] === WALL_RAIL) rails++
          }
        }
        if (cy > 0) expect(rails, `rails round the void, storey ${cy}`).toBeGreaterThanOrEqual(Math.min(v.x1 - v.x0, v.z1 - v.z0) + 1)
        // The planned doors through the ring (and any a hallway cut).
        for (const d of [...plan.hallDoors[cy], ...plan.storeys[cy].ringDoors]) {
          const c = at(src, tx, tz, d.gx, d.gz, cy)
          const i = d.axis === 'v' ? vIdx(c.lx, c.lz) : hIdx(c.lx, c.lz)
          const got = d.axis === 'v' ? [c.d.wallV[i], c.d.passageV[i]] : [c.d.wallH[i], c.d.passageH[i]]
          expect(got, `hall door ${d.axis} ${d.gx},${d.gz} cy ${cy}`).toEqual([0, PASSAGE_DOOR])
        }
        expect(plan.hallDoors[cy].length).toBeGreaterThanOrEqual(1)
      }
      const e = at(src, tx, tz, g.exit.gx, g.exit.gz, 0)
      expect(e.d.cellKind[cIdx(e.lx, e.lz)]).toBe(CELL_ATRIUM)
      expect(e.d.structure?.kind).toBe('houseCatalog')
      for (const cy of [1, 2]) {
        const s = src.chunkAt(e.d.cx, cy, e.d.cz)
        if (s.structureDown) expect(catalogSliceErrors(s, s.structureDown, 'down')).toEqual([])
      }
    }
  })

  it('spawn on the yard path of tile (0,0); exit on the Great Hall floor of the exit tile, depth 3..5, 6..16 chunks away', () => {
    const hooks = hookOf(ID)
    expect(hooks.stub).toBe(false)
    for (const seed of [...SEEDS, 4242, 99, 12345]) {
      const sp = familySpawn(config, seed)
      expect([sp.cx * CHUNK + sp.lx, sp.cz * CHUNK + sp.lz]).toEqual([SPAWN_CELLS[0].gx, SPAWN_CELLS[0].gz])
      const src = worldSource(seed, config)
      const ex = familyExitHook(config)({ worldSeed: seed, level: 1, config, profile, generate: src.chunkAt })
      const t = exitTileOf(seed)
      expect(EXIT_TILES).toContainEqual(t)
      expect(ex).toEqual(hooks.exitAnchor(seed, profile))
      expect(ex.cy).toBe(0)
      const cell = exitCellsOfTile(seed, t.tx, t.tz)[0]
      expect([ex.cx * CHUNK + ex.lx, ex.cz * CHUNK + ex.lz]).toEqual([t.tx * TILE_W + cell.gx, t.tz * TILE_D + cell.gz])
      const dist = Math.max(Math.abs(ex.cx - sp.cx), Math.abs(ex.cz - sp.cz))
      expect(dist).toBeGreaterThanOrEqual(hooks.exitBounds.minChunks)
      expect(dist).toBeLessThanOrEqual(hooks.exitBounds.maxChunks)
      expect(anomalyAt(seed, bandKey(t.tx, t.tz))).toBeNull()
      const box = hooks.proofBox(ex, sp)
      expect(box).toEqual({
        chunks: { x0: Math.min(t.tx, 0) * 3, z0: Math.min(t.tz, 0) * 2, x1: Math.max(t.tx, 0) * 3 + 2, z1: Math.max(t.tz, 0) * 2 + 1 },
        cy: [0, 0],
      })
    }
    for (const t of EXIT_TILES) {
      for (let i = 0; i < 6; i++) {
        const { lx, lz } = chunkOf(i)
        const d = Math.max(Math.abs(t.tx * 3 + lx), Math.abs(t.tz * 2 + lz - 1))
        expect(d).toBeGreaterThanOrEqual(6)
        expect(d).toBeLessThanOrEqual(16)
      }
    }
    expect(hooks.exitHookStats.lastResort).toBe(0)
  })

  it('reach over 5 tiles: the seam doors carry a walk from the front yard five tiles out along each axis on the ground storey', () => {
    for (const seed of SEEDS.slice(0, 2)) {
      const src = worldSource(seed, config)
      const sp = familySpawn(config, seed)
      const from = { gx: sp.cx * CHUNK + sp.lx, gz: sp.cz * CHUNK + sp.lz, cy: 0 }
      for (const [tx, tz] of [[5, 0], [-5, 0], [0, 5], [0, -5]]) {
        const w = portsOfTile(seed, tx, tz).w
        const to = { gx: tx * TILE_W + w.gx, gz: tz * TILE_D + w.gz, cy: 0 } // the far tile's west seam door
        const box = { chunks: { x0: Math.min(tx, 0) * 3, z0: Math.min(tz, 0) * 2, x1: Math.max(tx, 0) * 3 + 2, z1: Math.max(tz, 0) * 2 + 1 }, cy: [0, 0] }
        const proof = proveReachable(src, from, to, box)
        expect(proof.ok, `seed ${seed} → tile ${tx},${tz}: ${proof.reason}`).toBe(true)
      }
    }
  })

  it('anomalies: hashed per tile, density rising with depth, rotated (no edge neighbours share a class), never near spawn or on the exit tile', () => {
    const maps = []
    const classes = new Set()
    const loops = new Set()
    const dens = { mid: [0, 0], deep: [0, 0] }
    for (const seed of [...SEEDS, 2, 3, 4, 5, 6]) {
      const ex = exitTileOf(seed)
      const sig = []
      for (let tz = -9; tz <= 9; tz++) {
        for (let tx = -9; tx <= 9; tx++) {
          const a = anomalyAt(seed, bandKey(tx, tz))
          sig.push(a ? a.cls : '-')
          if (Math.max(Math.abs(tx), Math.abs(tz)) <= 1 || (tx === ex.tx && tz === ex.tz)) {
            expect(a, `seed ${seed} tile ${tx},${tz}`).toBeNull()
            continue
          }
          const band = depthOf(tx, tz) <= 4 ? 'mid' : 'deep'
          dens[band][1]++
          if (!a) continue
          dens[band][0]++
          classes.add(a.cls)
          expect(ANOMALY_CLASSES).toContain(a.cls)
          if (a.cls === 'loop') {
            expect(hasLoop(variantAt(seed, tx, tz))).toBe(true)
            expect(LOOP_ANOMALIES).toContain(a.loop.anomaly)
            expect([1, 2, 3]).toContain(a.loop.q)
            if (a.loop.anomaly === 'missingDoor') expect(a.loop.q).not.toBe(3)
            loops.add(a.loop.anomaly)
          }
          for (const [nx, nz] of [[tx + 1, tz], [tx, tz + 1]]) {
            const b = anomalyAt(seed, bandKey(nx, nz))
            if (b) expect(b.cls, `seed ${seed} ${tx},${tz}→${nx},${nz}`).not.toBe(a.cls)
          }
          expect(anomalyAt(seed, bandKey(tx, tz))).toEqual(a)
        }
      }
      maps.push(sig.join(''))
    }
    expect(new Set(maps).size).toBe(maps.length)
    expect(classes).toEqual(new Set(ANOMALY_CLASSES))
    expect(loops).toEqual(new Set(LOOP_ANOMALIES))
    const mid = dens.mid[0] / dens.mid[1]
    const deep = dens.deep[0] / dens.deep[1]
    expect(mid).toBeGreaterThan(0.25)
    expect(deep).toBeGreaterThan(mid)
    expect(deep).toBeLessThan(0.9)
  })

  it('anomalies in the world: a mutated L, the red hallway and the copied room, each sealed and connected', () => {
    const seed = SEEDS[0]
    const src = worldSource(seed, config)
    const lampAt = (t, gx, gz, cy) => {
      const c = at(src, t.tx, t.tz, gx, gz, cy)
      return c.d.lamps.find((l) => l.lx === c.lx && l.lz === c.lz) ?? null
    }
    for (const cls of ANOMALY_CLASSES) {
      const [t] = findTiles(seed, (tx, tz) => {
        if (anomalyAt(seed, bandKey(tx, tz))?.cls !== cls) return false
        const p = planTile(seed, tx, tz)
        return cls === 'loop' ? !!p.loop : cls === 'copy' ? !!p.copy : !!p.red
      }, 1)
      expect(t, `a ${cls} tile`).toBeTruthy()
      const a = anomalyAt(seed, bandKey(t.tx, t.tz))
      const plan = planTile(seed, t.tx, t.tz)
      const inner = tileBox(t.tx, t.tz)
      const outer = boxOfTiles(t.tx - 1, t.tz - 1, t.tx + 1, t.tz + 1)
      const w = portsOfTile(seed, t.tx, t.tz).w
      const res = windowConnectivity(src, inner, outer, { gx: t.tx * TILE_W + w.gx, gz: t.tz * TILE_D + w.gz, cy: 0 })
      expect({ ok: res.ok, reason: res.reason, stranded: res.stranded, sealed: res.sealed }).toEqual({ ok: true, reason: null, stranded: [], sealed: [] })
      const audit = massLeakAudit(src.chunkAt, outer, { gen, worldSeed: seed })
      expect(audit.details).toEqual({ leaks: [], seals: [], portViolations: [], seeThroughToSolid: [], seeThroughThinMass: [] })
      if (cls === 'red') {
        // The ground storey's longest straight hallway burns red.
        expect(plan.red.length).toBeGreaterThanOrEqual(5)
        const red = plan.red.map((c) => lampAt(t, c.gx, c.gz, 0)).filter((l) => l && l.tint === RED)
        expect(red.length).toBeGreaterThanOrEqual(Math.floor(plan.red.length / 3))
        expect(red.some((l) => l.lit)).toBe(true)
      }
      if (cls === 'copy') {
        // The twin holds its source's pieces, shifted, piece for piece.
        const st = plan.storeys[plan.copy.cy]
        const srcRoom = st.rooms[plan.copy.of]
        const twin = st.rooms[plan.copy.room]
        expect([twin.x1 - twin.x0, twin.z1 - twin.z0]).toEqual([srcRoom.x1 - srcRoom.x0, srcRoom.z1 - srcRoom.z0])
        const pieces = (r) => {
          const out = []
          for (let gz = r.z0; gz <= r.z1; gz++) {
            for (let gx = r.x0; gx <= r.x1; gx++) {
              const c = at(src, t.tx, t.tz, gx, gz, plan.copy.cy)
              expect(c.d.cellKind[cIdx(c.lx, c.lz)]).toBe(CELL_ROOM)
              for (const f of c.d.furniture.filter((q) => q.lx === c.lx && q.lz === c.lz)) out.push([gx - r.x0, gz - r.z0, f.kind, f.facing])
            }
          }
          return out
        }
        expect(pieces(srcRoom).length).toBeGreaterThanOrEqual(1)
        expect(pieces(twin)).toEqual(pieces(srcRoom))
      }
      if (cls === 'loop') {
        const L = plan.loop
        const sig = (q) => {
          const cell = (gx, gz) => {
            const p = qCell(L, q, gx, gz)
            return at(src, t.tx, t.tz, p.gx, p.gz, 0)
          }
          const e = cell(L.x0 + 1, L.z0 + 1)
          const k = cell(L.x0 + 3, L.z0)
          const lamp = e.d.lamps.find((l) => l.lx === e.lx && l.lz === e.lz)
          const clock = k.d.furniture.find((f) => f.lx === k.lx && f.lz === k.lz)
          const closet = cell(L.x0, closetRow(L))
          const inner = cell(L.x0 + 2, L.z0 + 3)
          return JSON.stringify([lamp ? [lamp.lit, lamp.tint ?? null] : null, clock ? clock.kind : null,
            closet.d.cellKind[cIdx(closet.lx, closet.lz)], inner.d.cellKind[cIdx(inner.lx, inner.lz)]])
        }
        const sigs = [0, 1, 2, 3].map(sig)
        expect(JSON.parse(sigs[0])[1]).toBe(PROP_HALL_CLOCK)
        const odd = [1, 2, 3].filter((q) => sigs[q] !== sigs[0])
        if (a.loop.anomaly !== 'turned') expect(odd, sigs.join(' ')).toEqual([a.loop.q])
      }
    }
    // A loop without the anomaly keeps four identical L's (the baseline).
    const [plain] = findTiles(seed, (tx, tz) => variantAt(seed, tx, tz) === 'loop' && !anomalyAt(seed, bandKey(tx, tz)) && !!planTile(seed, tx, tz).loop, 1)
    const L = planTile(seed, plain.tx, plain.tz).loop
    const lampOf = (q) => {
      const p = qCell(L, q, L.x0 + 1, L.z0 + 1)
      const l = lampAt(plain, p.gx, p.gz, 0)
      return [l.lit, l.tint ?? null]
    }
    expect([1, 2, 3].map(lampOf)).toEqual([lampOf(0), lampOf(0), lampOf(0)])
  })

  it('variety: no tile is a copy — wall/column Jaccard over 12 tiles, ground and first floor, mean ≤ 0.25, max ≤ 0.45', () => {
    const origins = []
    for (let a = 0; a < 4; a++) for (let b = 0; b < 3; b++) origins.push([a * 3 + 1, b * 3 + 1])
    for (const seed of [12345, 1]) {
      for (const cy of [0, 1]) {
        const sigs = origins.map(([tx, tz]) => tileSignature(seed, tx, tz, cy))
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
        expect(sum / n, `seed ${seed} cy ${cy} mean`).toBeLessThanOrEqual(0.25)
        expect(max, `seed ${seed} cy ${cy} max`).toBeLessThanOrEqual(0.45)
      }
    }
  })

  it('storey plates are pure per tile: 1F, 2F, then a top floor the roof cannot hold deeper in', () => {
    for (const seed of SEEDS) {
      const src = worldSource(seed, config)
      for (const [tx, tz] of [[0, 0], [1, 0], [3, -2], [-4, 4]]) {
        const k = bandKey(tx, tz)
        const f = frameOf(seed, tx, tz)
        for (let cy = 0; cy <= 2; cy++) {
          const i = [0, 1, 2, 3, 4, 5].find((j) => (f.up[cy] >> j) & 1)
          const { lx, lz } = chunkOf(i)
          expect(src.chunkAt(tx * 3 + lx, cy, tz * 2 + lz).levelLabel).toBe(labelOf(seed, k, cy))
        }
        expect(labelOf(seed, k, 0)).toBe('1F')
        expect(labelOf(seed, k, 1)).toBe('2F')
        const top = Number.parseInt(labelOf(seed, k, 2), 10)
        if (depthOf(tx, tz) < 3) expect(top).toBe(3)
        else expect(top).toBeLessThanOrEqual(3 + depthOf(tx, tz) - 2)
      }
    }
    let lies = 0
    for (let tx = 3; tx < 40; tx++) if (labelOf(1, bandKey(tx, 0), 2) !== '3F') lies++
    expect(lies).toBeGreaterThan(10)
  })

  it('the bake\'s chunks are exactly the footprint\'s, nothing untouched, slices project clean', () => {
    for (const seed of SEEDS) {
      for (const [tx, tz] of [[0, 0], [2, -1], [-3, 2]]) {
        const k = bandKey(tx, tz)
        const bake = tileBakeAt(seed, k, config)
        const kept = []
        for (let cy = 0; cy <= 2; cy++) {
          for (let cz = tz * 2; cz < tz * 2 + 2; cz++) for (let cx = tx * 3; cx < tx * 3 + 3; cx++) if (footprint(seed, cx, cy, cz) === 'tile') kept.push(`${cx},${cy},${cz}`)
        }
        expect([...bake.chunks.values()].map((d) => `${d.cx},${d.cy},${d.cz}`).sort()).toEqual(kept.sort())
        expect(bake.stats.untouchedKept).toBe(0)
        expect(bake.fallback).toBe(false)
        for (const d of bake.chunks.values()) {
          if (d.structureUp) expect(catalogSliceErrors(d, d.structureUp, 'up')).toEqual([])
          if (d.structureDown) expect(catalogSliceErrors(d, d.structureDown, 'down')).toEqual([])
        }
      }
    }
  })
})
