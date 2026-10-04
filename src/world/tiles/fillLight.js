import { CELL, CHUNK, LIGHT_RANGE, chunkKey3 } from '../constants.js'
import { hasLineOfSight } from '../../player/collision.js'
import { spawnCellOk } from './cells.js'
import { cellWalkable } from './holeMasks.js'
import { sourceCM } from './simulate.js'

// The bake's fill-light pass (I-playfix): a liminal tile program lights its
// set pieces, and this pass then hangs plain fixtures over the walkable cells
// those lamps leave dark, so every room a player walks through reads in first
// person — the legacy families get the same from their global lamp lattice
// (lamps.js placeLights). Runs in finishBake on the exported chunks of one
// tile, so it is pure in the tile like the rest of the bake; editor kinds
// (world mode) never reach it.
//
// The light model is the game's own gameplay light (LightGrid.lightAt): each
// lit fixture adds the cubic window (1 - d / LIGHT_RANGE)³ of its planar
// distance where a wall sight line (the game's DDA through tiles/simulate's
// sourceCM) reaches the cell; lightAt adds its 0.1 floor on top. Per storey
// the pass is a greedy cover: every roofed, walkable, unlamped cell is a
// candidate fixture, and each round hangs the one that lifts the most cells
// still below `level` to it, at least `gap + 1` cells (Chebyshev) from every
// fixture of its storey in its sight (a fixture behind a wall does not crowd
// it), while its chunk-storey holds fewer than `cap` lit lamps — so a capped
// chunk spends its fixtures where they light the most.
//
// spec (a family generator's `light`: an object, or (ctx) => object | null;
// { off: true } or null skips the pass):
//   level   target light above lightAt's floor (default 0.05: a fixture
//           within ~2.4 cells, in sight)
//   cap     lit lamps per chunk-storey after the pass (default 10; the §11.1
//           gate is 12 per chunk-storey and 72 within 60 u)
//   gap     minimum free cells between two fixtures in sight (default 2)
//   tint    fixture tint (absent/null: the palette's plain fixture), or
//           (d, lx, lz, gx, gz, cy) => tint | null for the fixture's cell
//   deadReach  a dead fixture is authored darkness (a dead circuit, a dark
//           anomaly, a sleeping house): the cells within this many cells
//           (Chebyshev) of one, in its sight, are never lit nor hung with a
//           fixture (default 4; 0 turns it off)
//   rooms   'all' (default) or 'lit': fill a room (spaceId ≠ 0) only when the
//           tile already lights it (a fixture of the room burns); circulation
//           (spaceId 0) is always filled
//   roomTint  true: a fixture hung in a lit room takes the tint of the room's
//           first burning fixture (the room keeps its own colour)
//   where   (d, lx, lz, gx, gz, cy) => boolean: the cells the pass may light
//           and hang fixtures over (default: every walkable cell)
//   spawn   (ctx) => [{gx, gz} | {cx, cz, lx, lz}]: the family spawn hook's
//           candidate cells on world storey 0, in the hook's order. Before
//           the scan, the first candidate in this tile that the hook would
//           take (walkable and spawnCellOk) is lifted to SPAWN_LEVEL with a
//           fixture over it or a neighbour (ignoring `where`, `gap` and
//           `cap` up to the §11.1 gate), so no run starts in the dark.

export const FILL_DEFAULTS = Object.freeze({ level: 0.05, cap: 10, gap: 2, deadReach: 4, rooms: 'all', roomTint: false })
export const SPAWN_LEVEL = 0.3
const GATE_CAP = 12 // §11.1 item 9: lit lamps per chunk-storey

const REACH = Math.ceil(LIGHT_RANGE / CELL) // cells a fixture's window spans
const cubic = (q) => {
  const f = 1 - (Math.sqrt(q) * CELL) / LIGHT_RANGE
  return f > 0 ? f * f * f : 0
}

// Spawn fixture offsets: over the cell, then its ring.
const SPAWN_OFFSETS = Object.freeze([
  [0, 0], [1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1],
])

export function resolveFillSpec(light, ctx) {
  const spec = typeof light === 'function' ? light(ctx) : light
  if (!spec || spec.off) return null
  const spawn = typeof spec.spawn === 'function' ? spec.spawn(ctx) ?? [] : []
  return { ...FILL_DEFAULTS, ...spec, spawn }
}

// Fill the dark cells of a tile's chunks (Map chunkKey3(GLOBAL) → ChunkData),
// storey by storey. Returns the number of fixtures hung.
export function fillDarkCells(chunks, spec) {
  if (!spec) return 0
  const byCy = new Map()
  for (const d of chunks.values()) {
    if (!byCy.has(d.cy)) byCy.set(d.cy, [])
    byCy.get(d.cy).push(d)
  }
  const source = { chunkAt: (cx, cy, cz) => chunks.get(chunkKey3(cx, cy, cz)) ?? null }
  let total = 0
  for (const cy of [...byCy.keys()].sort((a, b) => a - b)) total += fillStorey(source, byCy.get(cy), cy, spec)
  return total
}

function fillStorey(source, list, cy, spec) {
  const { level, cap, gap, tint, where } = spec
  // Most storeys of a mass-heavy tile are solid: nothing to light.
  let any = false
  for (const d of list) {
    for (let i = 0; i < CHUNK * CHUNK && !any; i++) any = cellWalkable(d, i % CHUNK, Math.floor(i / CHUNK))
    if (any) break
  }
  if (!any) return 0

  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity
  for (const d of list) {
    x0 = Math.min(x0, d.cx); x1 = Math.max(x1, d.cx)
    z0 = Math.min(z0, d.cz); z1 = Math.max(z1, d.cz)
  }
  const gx0 = x0 * CHUNK
  const gz0 = z0 * CHUNK
  const W = (x1 - x0 + 1) * CHUNK
  const D = (z1 - z0 + 1) * CHUNK
  const idx = (gx, gz) => (gz - gz0) * W + gx - gx0
  const at = (gx, gz) => {
    if (gx < gx0 || gz < gz0 || gx >= gx0 + W || gz >= gz0 + D) return null
    const cx = Math.floor(gx / CHUNK)
    const cz = Math.floor(gz / CHUNK)
    const d = source.chunkAt(cx, cy, cz)
    return d ? { d, lx: gx - cx * CHUNK, lz: gz - cz * CHUNK } : null
  }
  const grid = new Float32Array(W * D)
  const fixture = new Uint8Array(W * D) // 1: a fixture (lit or dead) hangs over the cell
  const shut = new Uint8Array(W * D) // 1: authored darkness (spec.deadReach)
  const litOf = new Map()
  const cm = sourceCM(source)
  const sees = (ax, az, bx, bz) =>
    (ax === bx && az === bz) ||
    hasLineOfSight(cm, (ax + 0.5) * CELL, (az + 0.5) * CELL, (bx + 0.5) * CELL, (bz + 0.5) * CELL, cy)
  // Lit rooms (spec.rooms 'lit') and their tints (spec.roomTint).
  const roomLit = new Map() // spaceId -> tint of its first burning fixture (null: plain)
  for (const d of list) {
    for (const l of d.lamps) {
      const id = d.spaceId[l.lz * CHUNK + l.lx]
      if (l.lit && id && !roomLit.has(id)) roomLit.set(id, l.tint ?? null)
    }
  }
  const ok = (c, gx, gz) => {
    if (!cellWalkable(c.d, c.lx, c.lz) || shut[idx(gx, gz)]) return false
    const id = c.d.spaceId[c.lz * CHUNK + c.lx]
    if (id && spec.rooms === 'lit' && !roomLit.has(id)) return false
    return !where || where(c.d, c.lx, c.lz, gx, gz, cy)
  }
  const shine = (ax, az) => {
    for (let gz = Math.max(gz0, az - REACH); gz <= Math.min(gz0 + D - 1, az + REACH); gz++) {
      for (let gx = Math.max(gx0, ax - REACH); gx <= Math.min(gx0 + W - 1, ax + REACH); gx++) {
        const v = cubic((gx - ax) ** 2 + (gz - az) ** 2)
        if (v <= 0 || !sees(ax, az, gx, gz)) continue
        grid[idx(gx, gz)] += v
      }
    }
  }
  const crowded = (gx, gz) => {
    for (let z = Math.max(gz0, gz - gap); z <= Math.min(gz0 + D - 1, gz + gap); z++) {
      for (let x = Math.max(gx0, gx - gap); x <= Math.min(gx0 + W - 1, gx + gap); x++) {
        if (fixture[idx(x, z)] && sees(x, z, gx, gz)) return true
      }
    }
    return false
  }
  const shutAround = (ax, az) => {
    const R = spec.deadReach | 0
    for (let gz = Math.max(gz0, az - R); gz <= Math.min(gz0 + D - 1, az + R); gz++) {
      for (let gx = Math.max(gx0, ax - R); gx <= Math.min(gx0 + W - 1, ax + R); gx++) {
        if (!shut[idx(gx, gz)] && sees(ax, az, gx, gz)) shut[idx(gx, gz)] = 1
      }
    }
  }
  // The tile's own fixtures on this storey.
  for (const d of list) {
    let lit = 0
    for (const l of d.lamps) {
      const gx = d.cx * CHUNK + l.lx
      const gz = d.cz * CHUNK + l.lz
      fixture[idx(gx, gz)] = 1
      if (!l.lit) {
        shutAround(gx, gz)
        continue
      }
      lit++
      shine(gx, gz)
    }
    litOf.set(d, lit)
  }

  const hang = (p, px, pz) => {
    const id = p.d.spaceId[p.lz * CHUNK + p.lx]
    const t = spec.roomTint && id && roomLit.has(id)
      ? roomLit.get(id)
      : typeof tint === 'function' ? tint(p.d, p.lx, p.lz, px, pz, cy) : tint
    const rec = { lx: p.lx, lz: p.lz, lit: true }
    if (t !== undefined && t !== null) rec.tint = t >>> 0
    p.d.lamps.push(rec)
    litOf.set(p.d, litOf.get(p.d) + 1)
    fixture[idx(px, pz)] = 1
    shine(px, pz)
  }

  let added = 0
  // The spawn first (world storey 0 only).
  if (cy === 0) {
    for (const s of spec.spawn ?? []) {
      const gx = s.gx ?? s.cx * CHUNK + s.lx
      const gz = s.gz ?? s.cz * CHUNK + s.lz
      const c = at(gx, gz)
      if (!c || !cellWalkable(c.d, c.lx, c.lz) || !spawnCellOk(c.d, c.lx, c.lz)) continue
      if (grid[idx(gx, gz)] >= SPAWN_LEVEL) break
      for (const [ox, oz] of SPAWN_OFFSETS) {
        const px = gx + ox
        const pz = gz + oz
        const p = at(px, pz)
        if (!p || !cellWalkable(p.d, p.lx, p.lz) || p.d.hasCeilHole(p.lx, p.lz)) continue
        if (fixture[idx(px, pz)] || litOf.get(p.d) >= GATE_CAP) continue
        if (!sees(px, pz, gx, gz)) continue
        hang(p, px, pz)
        added++
        break
      }
      break
    }
  }
  // Greedy cover: every hangable cell is a candidate fixture with its reach
  // (the cells it would light, with the window it adds); each round hangs the
  // candidate that lifts the most still-dark cells to `level` (ties: the
  // most light added below `level`, then scan order), until none lifts any.
  const dark = (i) => grid[i] < level
  const cands = []
  for (let gz = gz0; gz < gz0 + D; gz++) {
    for (let gx = gx0; gx < gx0 + W; gx++) {
      const p = at(gx, gz)
      if (!p || !ok(p, gx, gz) || p.d.hasCeilHole(p.lx, p.lz) || fixture[idx(gx, gz)] || crowded(gx, gz)) continue
      const ks = []
      const vs = []
      let useful = false
      for (let z = Math.max(gz0, gz - REACH); z <= Math.min(gz0 + D - 1, gz + REACH); z++) {
        for (let x = Math.max(gx0, gx - REACH); x <= Math.min(gx0 + W - 1, gx + REACH); x++) {
          const i = idx(x, z)
          if (!dark(i)) continue
          const c = at(x, z)
          if (!c || !ok(c, x, z)) continue
          const v = cubic((x - gx) ** 2 + (z - gz) ** 2)
          if (v <= 0 || !sees(gx, gz, x, z)) continue
          ks.push(i)
          vs.push(v)
          useful = true
        }
      }
      if (useful) cands.push({ gx, gz, p, ks, vs, live: true })
    }
  }
  for (;;) {
    let best = null
    let bestN = 0
    let bestSum = 0
    for (const c of cands) {
      if (!c.live) continue
      if (litOf.get(c.p.d) >= cap) {
        c.live = false
        continue
      }
      let n = 0
      let sum = 0
      for (let j = 0; j < c.ks.length; j++) {
        const lv = grid[c.ks[j]]
        if (lv >= level) continue
        if (lv + c.vs[j] >= level) n++
        sum += Math.min(c.vs[j], level - lv)
      }
      if (n > bestN || (n === bestN && n > 0 && sum > bestSum)) {
        best = c
        bestN = n
        bestSum = sum
      }
    }
    if (!best) break
    best.live = false
    hang(best.p, best.gx, best.gz)
    added++
    for (const c of cands) if (c.live && Math.max(Math.abs(c.gx - best.gx), Math.abs(c.gz - best.gz)) <= gap && sees(best.gx, best.gz, c.gx, c.gz)) c.live = false
  }
  return added
}

// The pass's light model at one cell of any source (chunkAt over global
// chunk keys): the sum of the cubic windows of the lit fixtures within reach
// that see the cell (same storey). For tests and reports.
export function lightLevelAt(source, gx, gz, cy) {
  const cm = sourceCM(source)
  let acc = 0
  for (let cz = Math.floor((gz - REACH) / CHUNK); cz <= Math.floor((gz + REACH) / CHUNK); cz++) {
    for (let cx = Math.floor((gx - REACH) / CHUNK); cx <= Math.floor((gx + REACH) / CHUNK); cx++) {
      const d = source.chunkAt(cx, cy, cz)
      if (!d) continue
      for (const l of d.lamps) {
        if (!l.lit) continue
        const ax = cx * CHUNK + l.lx
        const az = cz * CHUNK + l.lz
        const v = cubic((gx - ax) ** 2 + (gz - az) ** 2)
        if (v <= 0) continue
        if ((ax !== gx || az !== gz) && !hasLineOfSight(cm, (ax + 0.5) * CELL, (az + 0.5) * CELL, (gx + 0.5) * CELL, (gz + 0.5) * CELL, cy)) continue
        acc += v
      }
    }
  }
  return acc
}
