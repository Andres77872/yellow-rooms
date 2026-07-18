import { describe, it, expect } from 'vitest'
import { findPath, followPath, cellBlocked } from '../pathfind.js'
import { ChunkData } from '../ChunkData.js'
import {
  CELL,
  CHUNK,
  LAYER_H,
  STAIR_RUN,
  STAIR_LAYER_COST,
  PATH_VLEASH,
  CROSS_FLOOR_NODE_MULT,
  ZONE_WAREHOUSE,
  cIdx,
} from '../constants.js'
import { buildStairCells } from '../stairCells.js'
import { buildChunk } from '../pipeline.js'
import { DEFAULT_WORLD_CONFIG } from '../config.js'

// Cross-floor pathfinding over hand-built layers: a two-layer mock CM with a
// stair authored via the SAME descriptor builder the real ChunkManager uses.
// Layer geometry is otherwise open, so costs are exact and assertions tight.
//
// The mock stair mirrors the stamp: landing (4,7) -> runs (5,7),(6,7) -> exit
// (7,7), ascending E through slab 0 in chunk (0,0).
function stairData(cy) {
  const data = new ChunkData(0, cy, 0, 0)
  const s = {
    dir: 1, // E
    landing: { lx: 4, lz: 7 },
    run: [{ lx: 5, lz: 7 }, { lx: 6, lz: 7 }],
    exit: { lx: 7, lz: 7 },
  }
  if (cy === 0) data.stairUp = s
  if (cy === 1) data.stairDown = s
  return data
}

function mockCM(extraStairs = null) {
  const layers = new Map()
  for (const cy of [-1, 0, 1, 2]) {
    const data = stairData(cy)
    if (extraStairs) extraStairs(data, cy)
    layers.set(cy, { data, cells: buildStairCells(data, 0, cy, 0) })
  }
  const inRange = (gx, gz) => gx >= 0 && gx < CHUNK && gz >= 0 && gz < CHUNK
  const dataOf = (cy) => layers.get(cy)?.data
  return {
    wallVAt: (gx, gz, cy) => inRange(gx, gz) && !!dataOf(cy) && dataOf(cy).vAt(gx, gz) === 1,
    wallHAt: (gx, gz, cy) => inRange(gx, gz) && !!dataOf(cy) && dataOf(cy).hAt(gx, gz) === 1,
    columnAt: (gx, gz, cy) => inRange(gx, gz) && !!dataOf(cy) && dataOf(cy).colAt(gx, gz) > 0,
    stairAt: (gx, gz, cy) => {
      if (!inRange(gx, gz) || !layers.get(cy)) return null
      return layers.get(cy).cells.get(cIdx(gx, gz)) || null
    },
    cellCenter: (gx, gz, cy, t) => t.set((gx + 0.5) * CELL, cy * LAYER_H, (gz + 0.5) * CELL),
  }
}

// Faithful streamed-column double: the descriptor maps are built by the real
// buildStairCells helper, but the surrounding loaded floors are open. Putting
// the column several chunks away models the slab generator's district fallback
// without coupling this pathfinder regression to a particular seed/hash.
function distantStairCM(cx = 3) {
  const lower = stairData(0)
  const upper = stairData(1)
  const cells = new Map([
    [0, buildStairCells(lower, cx, 0, 0)],
    [1, buildStairCells(upper, cx, 1, 0)],
  ])
  const x0 = cx * CHUNK
  const stairAt = (gx, gz, cy) => {
    if (gx < x0 || gx >= x0 + CHUNK || gz < 0 || gz >= CHUNK) return null
    return cells.get(cy)?.get(cIdx(gx - x0, gz)) || null
  }
  const up = lower.stairUp
  return {
    wallVAt: () => false,
    wallHAt: () => false,
    columnAt: () => false,
    stairAt,
    apertures: new Map([
      [`${cx},0,0`, {
        cx,
        cz: 0,
        lowerCy: 0,
        centerX: (x0 + (up.run[0].lx + up.run[1].lx) / 2 + 0.5) * CELL,
        centerZ: ((up.run[0].lz + up.run[1].lz) / 2 + 0.5) * CELL,
      }],
    ]),
    cellCenter: (gx, gz, cy, t) => t.set((gx + 0.5) * CELL, cy * LAYER_H, (gz + 0.5) * CELL),
  }
}

function generatedFallbackPatch(seed = 7331) {
  const config = structuredClone(DEFAULT_WORLD_CONFIG)
  config.stairs.chance = 0
  config.stairs.districtChunks = 4
  config.multilevel.enabled = false
  config.zoneBands = [{ id: ZONE_WAREHOUSE, max: 1.01 }]
  config.warehouse.columns.chance = 0
  config.warehouse.fragments.chance = 0
  const chunks = new Map()
  const key = (cx, cy, cz) => `${cx},${cy},${cz}`
  for (let cy = 0; cy <= 1; cy++) {
    for (let cz = 0; cz < 4; cz++) {
      for (let cx = 0; cx < 4; cx++) {
        const data = buildChunk(seed, cx, cy, cz, config)
        chunks.set(key(cx, cy, cz), {
          data,
          cells: buildStairCells(data, cx, cy, cz),
        })
      }
    }
  }
  const entryAt = (gx, gz, cy) => chunks.get(
    key(Math.floor(gx / CHUNK), cy, Math.floor(gz / CHUNK))
  )
  const local = (g, chunk) => g - chunk * CHUNK
  const apertures = new Map()
  let fallback = null
  for (let cz = 0; cz < 4; cz++) {
    for (let cx = 0; cx < 4; cx++) {
      const up = chunks.get(key(cx, 0, cz)).data.stairUp
      if (!up) continue
      fallback = { cx, cz, stair: up }
      apertures.set(`${cx},${cz},0`, {
        cx,
        cz,
        lowerCy: 0,
        centerX: (cx * CHUNK + (up.run[0].lx + up.run[1].lx) / 2 + 0.5) * CELL,
        centerZ: (cz * CHUNK + (up.run[0].lz + up.run[1].lz) / 2 + 0.5) * CELL,
      })
    }
  }
  return {
    fallback,
    wallVAt(gx, gz, cy) {
      const cx = Math.floor(gx / CHUNK)
      const cz = Math.floor(gz / CHUNK)
      const entry = chunks.get(key(cx, cy, cz))
      return !entry || entry.data.vAt(local(gx, cx), local(gz, cz)) === 1
    },
    wallHAt(gx, gz, cy) {
      const cx = Math.floor(gx / CHUNK)
      const cz = Math.floor(gz / CHUNK)
      const entry = chunks.get(key(cx, cy, cz))
      return !entry || entry.data.hAt(local(gx, cx), local(gz, cz)) === 1
    },
    columnAt(gx, gz, cy) {
      const cx = Math.floor(gx / CHUNK)
      const cz = Math.floor(gz / CHUNK)
      const entry = chunks.get(key(cx, cy, cz))
      return !entry || entry.data.colAt(local(gx, cx), local(gz, cz)) > 0
    },
    floorHoleAt(gx, gz, cy) {
      const cx = Math.floor(gx / CHUNK)
      const cz = Math.floor(gz / CHUNK)
      const entry = chunks.get(key(cx, cy, cz))
      return !entry || entry.data.hasFloorHole(local(gx, cx), local(gz, cz))
    },
    stairAt(gx, gz, cy) {
      const entry = entryAt(gx, gz, cy)
      if (!entry) return null
      const cx = Math.floor(gx / CHUNK)
      const cz = Math.floor(gz / CHUNK)
      return entry.cells.get(cIdx(local(gx, cx), local(gz, cz))) || null
    },
    apertures,
    cellCenter: (gx, gz, cy, t) =>
      t.set((gx + 0.5) * CELL, cy * LAYER_H, (gz + 0.5) * CELL),
  }
}

const wc = (c) => (c + 0.5) * CELL
const triples = (path) => {
  const out = []
  for (let i = 0; i < path.length; i += 3) out.push([path[i], path[i + 1], path[i + 2]])
  return out
}
const pathCost = (path) => {
  // Recompute the true cost of an emitted (uncollapsed) path.
  let cost = 0
  const t = triples(path)
  for (let i = 1; i < t.length; i++) {
    if (t[i][2] !== t[i - 1][2]) cost += STAIR_RUN + STAIR_LAYER_COST
    else cost += Math.abs(t[i][0] - t[i - 1][0]) + Math.abs(t[i][1] - t[i - 1][1])
  }
  return cost
}

describe('pathfind3d: stair edges', () => {
  it('routes to the floor above with exact optimal cost', () => {
    const cm = mockCM()
    // Start (2,7,cy0) -> target (9,7,cy1). Optimal: 2 lateral to the landing
    // (4,7), stair edge (cost 5) to the exit (7,7,cy1), 2 lateral to (9,7).
    const path = findPath(cm, wc(2), wc(7), 0, wc(9), wc(7), 1, { collapse: false })
    expect(path).not.toBeNull()
    const t = triples(path)
    expect(t[0]).toEqual([2, 7, 0])
    expect(t[t.length - 1]).toEqual([9, 7, 1])
    expect(pathCost(path)).toBe(2 + STAIR_RUN + STAIR_LAYER_COST + 2)
    // Monotone floor change through landing -> exit, exactly once.
    let flips = 0
    for (let i = 1; i < t.length; i++) if (t[i][2] !== t[i - 1][2]) flips++
    expect(flips).toBe(1)
    // The transition is exactly landing -> exit.
    const k = t.findIndex((c, i) => i > 0 && c[2] !== t[i - 1][2])
    expect(t[k - 1]).toEqual([4, 7, 0])
    expect(t[k]).toEqual([7, 7, 1])
  })

  it('routes down the same stair', () => {
    const cm = mockCM()
    const path = findPath(cm, wc(9), wc(7), 1, wc(2), wc(7), 0, { collapse: false })
    expect(path).not.toBeNull()
    const t = triples(path)
    expect(t[0]).toEqual([9, 7, 1])
    expect(t[t.length - 1]).toEqual([2, 7, 0])
    const k = t.findIndex((c, i) => i > 0 && c[2] !== t[i - 1][2])
    expect(t[k - 1]).toEqual([7, 7, 1]) // exit cell
    expect(t[k]).toEqual([4, 7, 0]) // landing
  })

  it('never emits run or hole cells as path nodes', () => {
    const cm = mockCM()
    for (const [scy, tcy] of [[0, 1], [1, 0]]) {
      const path = findPath(cm, wc(2), wc(7), scy, wc(9), wc(7), tcy, { collapse: false })
      for (const [gx, gz, cy] of triples(path)) {
        expect(cellBlocked(cm, gx, gz, cy), `(${gx},${gz},${cy})`).toBe(false)
      }
    }
  })

  it('retargets a target standing on the ramp/hole to the stair ends', () => {
    const cm = mockCM()
    // Target on a run cell (lower layer) -> retargets to the landing.
    let path = findPath(cm, wc(2), wc(7), 0, wc(5), wc(7), 0)
    let t = triples(path)
    expect(t[t.length - 1]).toEqual([4, 7, 0])
    // Target over the hole (upper layer) -> retargets to the exit.
    path = findPath(cm, wc(9), wc(7), 1, wc(5), wc(7), 1)
    t = triples(path)
    expect(t[t.length - 1]).toEqual([7, 7, 1])
  })

  it('bails past the vertical leash', () => {
    const cm = mockCM()
    expect(
      findPath(cm, wc(2), wc(7), 0, wc(9), wc(7), PATH_VLEASH + 1, { maxNodes: 1e6 })
    ).toBeNull()
  })

  it('collapse never merges waypoints across a floor change', () => {
    const cm = mockCM()
    const path = findPath(cm, wc(2), wc(7), 0, wc(9), wc(7), 1) // collapsed
    const t = triples(path)
    // Landing and exit must both survive collapsing.
    expect(t.some(([gx, gz, cy]) => gx === 4 && gz === 7 && cy === 0)).toBe(true)
    expect(t.some(([gx, gz, cy]) => gx === 7 && gz === 7 && cy === 1)).toBe(true)
  })

  it('is deterministic and reuses the out buffer across floors', () => {
    const cm = mockCM()
    const out = []
    const a = findPath(cm, wc(2), wc(7), 0, wc(9), wc(7), 1, { out })
    expect(a).toBe(out)
    const snap = Array.from(out)
    const b = findPath(cm, wc(2), wc(7), 0, wc(9), wc(7), 1, { out })
    expect(Array.from(b)).toEqual(snap)
  })

  it('cross-floor searches get the multiplied node budget', () => {
    const cm = mockCM()
    // Deterministic search => a well-defined minimal maxNodes. The effective
    // budget is maxNodes * CROSS_FLOOR_NODE_MULT when floors differ, so the
    // minimal maxNodes is ceil(E / MULT) for E true expansions — deleting the
    // multiplier would double it. Lock the relationship, not a magic number:
    let minimal = -1
    for (let m = 1; m <= 200; m++) {
      if (findPath(cm, wc(2), wc(7), 0, wc(9), wc(7), 1, { maxNodes: m })) {
        minimal = m
        break
      }
    }
    expect(minimal).toBeGreaterThan(1)
    // E (true expansions) sits in (MULT*(minimal-1), MULT*minimal]. Without the
    // multiplier a budget of `minimal` could not cover E:
    expect(CROSS_FLOOR_NODE_MULT * (minimal - 1)).toBeGreaterThanOrEqual(minimal)
    expect(findPath(cm, wc(2), wc(7), 0, wc(9), wc(7), 1, { maxNodes: minimal - 1 })).toBeNull()
  })
})

describe('pathfind3d: cross-floor window extension', () => {
  it('finds a stair OUTSIDE the start-target bbox via the aperture registry', () => {
    const cm = mockCM()
    // The stair sits at x 4..7 row 7; the aperture registry advertises it.
    cm.apertures = new Map([
      ['0,0,0', { cx: 0, cz: 0, lowerCy: 0, centerX: wc(5.5), centerZ: wc(7) }],
    ])
    // Player directly overhead at (12,12): the bbox is a point, margin 6 covers
    // [6..18]x[6..18] — the landing (4,7) is OUTSIDE. Without the extension
    // this returns null and vertical pursuit degrades to relocate-teleports.
    const path = findPath(cm, wc(12), wc(12), 0, wc(12), wc(12), 1)
    expect(path).not.toBeNull()
    const t = triples(path)
    expect(t.some(([gx, gz, cy]) => gx === 4 && gz === 7 && cy === 0)).toBe(true) // via the landing
    expect(t[t.length - 1]).toEqual([12, 12, 1])
    // Without the registry, the same query must fail (locks the mechanism).
    const bare = mockCM()
    expect(findPath(bare, wc(12), wc(12), 0, wc(12), wc(12), 1)).toBeNull()
  })

  it('routes through a loaded district fallback farther away than the target leash', () => {
    const cm = distantStairCM(3)
    // Actor and target are one cell apart, so leash=2 accepts the target. The
    // only stair starts 44 cells away in chunk 3: outside both that leash and
    // the old direct bbox+margin window, but inside the streamed footprint.
    const path = findPath(cm, wc(2), wc(7), 0, wc(3), wc(7), 1, {
      leash: 2,
      maxNodes: 60,
      collapse: false,
    })
    expect(path).not.toBeNull()
    const t = triples(path)
    expect(t[0]).toEqual([2, 7, 0])
    expect(t[t.length - 1]).toEqual([3, 7, 1])
    expect(t.some(([gx, gz, cy]) => gx === 3 * CHUNK + 4 && gz === 7 && cy === 0)).toBe(true)
    expect(t.some(([gx, gz, cy]) => gx === 3 * CHUNK + 7 && gz === 7 && cy === 1)).toBe(true)

    // The same registered portal and bounded detour work in reverse.
    const down = findPath(cm, wc(3), wc(7), 1, wc(2), wc(7), 0, {
      leash: 2,
      maxNodes: 60,
      collapse: false,
    })
    expect(down).not.toBeNull()
    const d = triples(down)
    expect(d[0]).toEqual([3, 7, 1])
    expect(d[d.length - 1]).toEqual([2, 7, 0])
  })

  it('routes through the sole fallback stair in a real generated 4x4 patch', () => {
    const cm = generatedFallbackPatch()
    const { cx, cz, stair } = cm.fallback
    expect(cm.apertures.size).toBe(1)
    const startCx = cx < 2 ? 3 : 0
    const startCz = cz < 2 ? 3 : 0
    const gx = startCx * CHUNK + 1
    const gz = startCz * CHUNK + 1
    const path = findPath(cm, wc(gx), wc(gz), 0, wc(gx), wc(gz), 1, {
      leash: 2,
      maxNodes: 1000,
      collapse: false,
    })
    expect(path).not.toBeNull()
    const cells = triples(path)
    expect(cells).toContainEqual([cx * CHUNK + stair.landing.lx, cz * CHUNK + stair.landing.lz, 0])
    expect(cells).toContainEqual([cx * CHUNK + stair.exit.lx, cz * CHUNK + stair.exit.lz, 1])
    expect(cells.at(-1)).toEqual([gx, gz, 1])
  })

  it('chains canonical loaded portals across two slabs', () => {
    const second = {
      dir: 1,
      landing: { lx: 4, lz: 3 },
      run: [{ lx: 5, lz: 3 }, { lx: 6, lz: 3 }],
      exit: { lx: 7, lz: 3 },
    }
    const cm = mockCM((data, cy) => {
      if (cy === 1) data.stairUp = second
      if (cy === 2) data.stairDown = second
    })
    cm.apertures = new Map([
      ['0,0,0', { cx: 0, cz: 0, lowerCy: 0, centerX: wc(6), centerZ: wc(7) }],
      ['0,0,1', { cx: 0, cz: 0, lowerCy: 1, centerX: wc(6), centerZ: wc(3) }],
    ])
    const path = findPath(cm, wc(2), wc(7), 0, wc(9), wc(3), 2, { collapse: false })
    expect(path).not.toBeNull()
    const t = triples(path)
    const flips = t.filter((cell, i) => i > 0 && cell[2] !== t[i - 1][2])
    expect(flips).toEqual([[7, 7, 1], [7, 3, 2]])
    expect(t[t.length - 1]).toEqual([9, 3, 2])
  })

  it('does not traverse an orphaned stair when the loaded exit half is missing', () => {
    const cm = distantStairCM(0)
    const stairAt = cm.stairAt
    // Keep the lower landing/run descriptors and aperture, but remove the
    // upper exit descriptor. Unloaded geometry reads open, so this would become
    // a phantom floor transition unless the canonical pair is validated.
    cm.stairAt = (gx, gz, cy) => (gx === 7 && gz === 7 && cy === 1 ? null : stairAt(gx, gz, cy))
    expect(
      findPath(cm, wc(4), wc(7), 0, wc(9), wc(7), 1, { maxNodes: 200 })
    ).toBeNull()
  })
})

describe('pathfind3d: mid-ramp repath', () => {
  it('a start on the ramp seeds both stair ends: ascending never backtracks', () => {
    const cm = mockCM()
    // Repath from the middle of the run (cell 5,7 lower layer), target above.
    const path = findPath(cm, wc(5), wc(7), 0, wc(9), wc(7), 1, { collapse: false })
    expect(path).not.toBeNull()
    const t = triples(path)
    // The route must start at the EXIT (upper end), not drag back to the landing.
    expect(t[0]).toEqual([7, 7, 1])
    expect(t.some(([gx, gz, cy]) => gx === 4 && gz === 7 && cy === 0)).toBe(false)
  })

  it('a start on the ramp targeting below routes through the landing', () => {
    const cm = mockCM()
    const path = findPath(cm, wc(5), wc(7), 0, wc(2), wc(7), 0, { collapse: false })
    expect(path).not.toBeNull()
    expect(triples(path)[0]).toEqual([4, 7, 0])
  })

  it('followPath fast-forwards past its own-cell waypoint after a repath', () => {
    const cm = mockCM()
    // Entity standing at (3,7,cy0); path re-starts at its own cell.
    const path = [3, 7, 0, 4, 7, 0, 7, 7, 1]
    const ent = { pos: { x: wc(3) + 1.3, y: 0, z: wc(7) }, cy: 0 } // off-centre in cell 3
    const r = followPath(cm, ent, path, 0, 0.1)
    expect(r.i).toBeGreaterThanOrEqual(1) // own-cell waypoint consumed immediately
    expect(ent.pos.x).toBeGreaterThan(wc(3) + 1.3) // moving FORWARD, not back to centre
  })
})

describe('pathfind3d: followPath across a stair', () => {
  it('ascends: y follows the ramp continuously and cy flips at arrival', () => {
    const cm = mockCM()
    const path = findPath(cm, wc(2), wc(7), 0, wc(9), wc(7), 1, { collapse: false })
    const ent = { pos: { x: wc(2), y: 0, z: wc(7) }, cy: 0 }
    let r = { i: 0, done: false }
    let prevY = 0
    let flips = 0
    let prevCy = 0
    for (let k = 0; k < 400 && !r.done; k++) {
      r = followPath(cm, ent, path, r.i, 0.1)
      expect(ent.pos.y).toBeGreaterThanOrEqual(prevY - 0.11) // monotone-ish rise
      expect(ent.pos.y - prevY).toBeLessThan(LAYER_H / 2) // no pops
      prevY = ent.pos.y
      if (ent.cy !== prevCy) {
        flips++
        prevCy = ent.cy
      }
    }
    expect(r.done).toBe(true)
    expect(ent.cy).toBe(1)
    expect(flips).toBe(1)
    expect(ent.pos.y).toBeCloseTo(LAYER_H, 6)
  })

  it('descends symmetrically', () => {
    const cm = mockCM()
    const path = findPath(cm, wc(9), wc(7), 1, wc(2), wc(7), 0, { collapse: false })
    const ent = { pos: { x: wc(9), y: LAYER_H, z: wc(7) }, cy: 1 }
    let r = { i: 0, done: false }
    let prevY = LAYER_H
    for (let k = 0; k < 400 && !r.done; k++) {
      r = followPath(cm, ent, path, r.i, 0.1)
      expect(prevY - ent.pos.y).toBeLessThan(LAYER_H / 2) // no drops
      prevY = ent.pos.y
    }
    expect(r.done).toBe(true)
    expect(ent.cy).toBe(0)
    expect(ent.pos.y).toBeCloseTo(0, 6)
  })

  it('reports the stair flag while transiting (for stuck detectors)', () => {
    const cm = mockCM()
    const path = findPath(cm, wc(4), wc(7), 0, wc(7), wc(7), 1, { collapse: false })
    const ent = { pos: { x: wc(4), y: 0, z: wc(7) }, cy: 0 }
    let sawStair = false
    let r = { i: 0, done: false }
    for (let k = 0; k < 300 && !r.done; k++) {
      r = followPath(cm, ent, path, r.i, 0.1)
      if (r.stair) sawStair = true
    }
    expect(sawStair).toBe(true)
    expect(ent.cy).toBe(1)
  })
})
