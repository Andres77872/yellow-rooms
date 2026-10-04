import { CHUNK, hIdx, vIdx } from '../constants.js'
import { generateChunk } from '../generate.js'
import { PASSAGE_OPEN, WALL_PLAIN } from '../mapTypes.js'
import { cellWalkable } from '../tiles/holeMasks.js'
import { STAIR_STEP_COST, packNodeKey, walkGraph } from '../tiles/simulate.js'

// Reachability over the generated world (spec §8.3): the proof that a
// family's exit is reachable from its spawn, and that a window of the world
// is one connected graph (decision 6). Both run on the walk graph the layered
// audit and the editor simulations share (tiles/simulate.js): walkable cells
// are nodes, planar steps cross open thin-wall edges (the line's owner chunk
// decides; a missing chunk or a cell outside the box blocks), and the only
// vertical edge joins a matched stair's lower landing and upper exit.

// A box is GLOBAL chunks { x0, z0, x1, z1, y0, y1 } (inclusive); a hook's
// proofBox shape { chunks: {x0, z0, x1, z1}, cy: [lo, hi] } is accepted too.
export function toBox(box) {
  if (box?.chunks) return { ...box.chunks, y0: box.cy[0], y1: box.cy[1] }
  return box
}

// A cell { gx, gz, cy } (GLOBAL); { cx, cz, lx, lz, cy? } (cy defaults to 0,
// the spawn storey) is accepted too.
export function toCell(c) {
  if (Number.isInteger(c?.gx)) return { gx: c.gx, gz: c.gz, cy: c.cy ?? 0 }
  return { gx: c.cx * CHUNK + c.lx, gz: c.cz * CHUNK + c.lz, cy: c.cy ?? 0 }
}

const NO_WALL = Object.freeze({ wall: 0, passage: PASSAGE_OPEN, feature: WALL_PLAIN })

// A walk-graph source over the generated world of (seed, config): chunkAt
// memoises generateChunk (GLOBAL chunk coordinates); wallVAt/wallHAt read a
// grid line from its owner chunk. Pass `cache` (a Map) to share chunks across
// sources — e.g. across the levels of one seed, whose worlds are identical.
// wallBitVAt/wallBitHAt read only the line's wall byte (0 without a chunk):
// the searches' allocation-free path. chunkAt remembers the last chunk it
// returned, so runs of reads in one chunk build no cache key.
export function worldSource(seed, config, { cache = new Map() } = {}) {
  const worldSeed = seed >>> 0
  let lastX = 0
  let lastY = 0
  let lastZ = 0
  let last
  const chunkAt = (cx, cy, cz) => {
    if (last !== undefined && cx === lastX && cy === lastY && cz === lastZ) return last
    const key = `${cx},${cy},${cz}`
    let d = cache.get(key)
    if (d === undefined) cache.set(key, (d = generateChunk(worldSeed, cx, cy, cz, config)))
    lastX = cx
    lastY = cy
    lastZ = cz
    last = d
    return d
  }
  const line = (axis, gx, cy, gz) => {
    const cx = Math.floor(gx / CHUNK)
    const cz = Math.floor(gz / CHUNK)
    const d = chunkAt(cx, cy, cz)
    if (!d) return NO_WALL
    const lx = gx - cx * CHUNK
    const lz = gz - cz * CHUNK
    const i = axis === 'v' ? vIdx(lx, lz) : hIdx(lx, lz)
    return axis === 'v'
      ? { wall: d.wallV[i], passage: d.passageV[i], feature: d.wallFeatureV[i] }
      : { wall: d.wallH[i], passage: d.passageH[i], feature: d.wallFeatureH[i] }
  }
  const wallBitVAt = (gx, cy, gz) => {
    const cx = Math.floor(gx / CHUNK)
    const cz = Math.floor(gz / CHUNK)
    const d = chunkAt(cx, cy, cz)
    return d ? d.wallV[vIdx(gx - cx * CHUNK, gz - cz * CHUNK)] : 0
  }
  const wallBitHAt = (gx, cy, gz) => {
    const cx = Math.floor(gx / CHUNK)
    const cz = Math.floor(gz / CHUNK)
    const d = chunkAt(cx, cy, cz)
    return d ? d.wallH[hIdx(gx - cx * CHUNK, gz - cz * CHUNK)] : 0
  }
  return {
    seed: worldSeed,
    config,
    cache,
    chunkAt,
    wallVAt: (gx, cy, gz) => line('v', gx, cy, gz),
    wallHAt: (gx, cy, gz) => line('h', gx, cy, gz),
    wallBitVAt,
    wallBitHAt,
  }
}

// --- lazy search ------------------------------------------------------------------

const inBoxChunk = (b, cx, cy, cz) => cx >= b.x0 && cx <= b.x1 && cz >= b.z0 && cz <= b.z1 && cy >= b.y0 && cy <= b.y1

function walkableAt(source, b, gx, gz, cy) {
  const cx = Math.floor(gx / CHUNK)
  const cz = Math.floor(gz / CHUNK)
  if (!inBoxChunk(b, cx, cy, cz)) return false
  const d = source.chunkAt(cx, cy, cz)
  return !!d && cellWalkable(d, gx - cx * CHUNK, gz - cz * CHUNK)
}

// The wall byte of a grid line: the source's allocation-free read when it
// has one (worldSource), else its { wall } record (any walk-graph source).
const wallV = (source, gx, cy, gz) => (source.wallBitVAt ? source.wallBitVAt(gx, cy, gz) : source.wallVAt(gx, cy, gz).wall)
const wallH = (source, gx, cy, gz) => (source.wallBitHAt ? source.wallBitHAt(gx, cy, gz) : source.wallHAt(gx, cy, gz).wall)

// The neighbours of cell (gx, gz, cy) inside box b, as flat triples
// (gx, gz, cy) handed to visit(nx, nz, ny); returns nothing, allocates
// nothing for planar steps. Identical to walkGraph's edges (reach-oracle.test
// compares partitions); a flight counts as one move.
function eachNeighbour(source, b, gx, gz, cy, visit) {
  if (walkableAt(source, b, gx + 1, gz, cy) && wallV(source, gx + 1, cy, gz) !== 1) visit(gx + 1, gz, cy)
  if (walkableAt(source, b, gx - 1, gz, cy) && wallV(source, gx, cy, gz) !== 1) visit(gx - 1, gz, cy)
  if (walkableAt(source, b, gx, gz + 1, cy) && wallH(source, gx, cy, gz + 1) !== 1) visit(gx, gz + 1, cy)
  if (walkableAt(source, b, gx, gz - 1, cy) && wallH(source, gx, cy, gz) !== 1) visit(gx, gz - 1, cy)
  // Stairs: this cell as the lower landing (up) or the upper exit (down).
  const cx = Math.floor(gx / CHUNK)
  const cz = Math.floor(gz / CHUNK)
  const lx = gx - cx * CHUNK
  const lz = gz - cz * CHUNK
  const here = source.chunkAt(cx, cy, cz)
  const up = here?.stairUp
  if (up && up.landing.lx === lx && up.landing.lz === lz && inBoxChunk(b, cx, cy + 1, cz)) {
    const down = source.chunkAt(cx, cy + 1, cz)?.stairDown
    if (down && JSON.stringify(up) === JSON.stringify(down) && walkableAt(source, b, cx * CHUNK + up.exit.lx, cz * CHUNK + up.exit.lz, cy + 1)) {
      visit(cx * CHUNK + up.exit.lx, cz * CHUNK + up.exit.lz, cy + 1)
    }
  }
  const down = here?.stairDown
  if (down && down.exit.lx === lx && down.exit.lz === lz && inBoxChunk(b, cx, cy - 1, cz)) {
    const below = source.chunkAt(cx, cy - 1, cz)?.stairUp
    if (below && JSON.stringify(below) === JSON.stringify(down) && walkableAt(source, b, cx * CHUNK + down.landing.lx, cz * CHUNK + down.landing.lz, cy - 1)) {
      visit(cx * CHUNK + down.landing.lx, cz * CHUNK + down.landing.lz, cy - 1)
    }
  }
}

// The neighbours of cell (gx, gz, cy) inside box b: [gx, gz, cy, cost].
function neighbours(source, b, gx, gz, cy) {
  const out = []
  eachNeighbour(source, b, gx, gz, cy, (nx, nz, ny) => {
    out.push([nx, nz, ny, ny === cy ? 1 : STAIR_STEP_COST])
  })
  return out
}

// Prove `to` reachable from `from` inside `box`: a bidirectional
// breadth-first search over the lazy walk graph (chunks are generated on
// demand), one layer at a time from whichever side has the smaller frontier,
// stopping at the layer where the two searches meet. The walk graph is
// undirected, so the route found is a shortest one: `steps` is its number of
// moves (a flight counts as one move) — the same count a one-sided search
// gives — and `visited` the cells expanded on both sides. Goal-directed
// A* is not used: a flight moves up to 2·(CHUNK−1) cells in one step, so no
// planar distance is an admissible estimate. ok is false when either end is
// not walkable, when the search exhausts the box, or past `maxNodes` (reason
// says which).
export function proveReachable(source, from, to, box, { maxNodes = 2_000_000 } = {}) {
  const b = toBox(box)
  const a = toCell(from)
  const z = toCell(to)
  if (!walkableAt(source, b, a.gx, a.gz, a.cy)) return { ok: false, steps: -1, visited: 0, reason: 'from-not-walkable' }
  if (!walkableAt(source, b, z.gx, z.gz, z.cy)) return { ok: false, steps: -1, visited: 0, reason: 'to-not-walkable' }
  const ka = packNodeKey(a.gx, a.gz, a.cy)
  const kz = packNodeKey(z.gx, z.gz, z.cy)
  if (ka === kz) return { ok: true, steps: 0, visited: 0 }
  // Per side: the depth of every reached cell, and the current frontier as
  // flat (gx, gz, cy) triples.
  const sides = [
    { dist: new Map([[ka, 0]]), frontier: [a.gx, a.gz, a.cy], depth: 0 },
    { dist: new Map([[kz, 0]]), frontier: [z.gx, z.gz, z.cy], depth: 0 },
  ]
  let visited = 0
  while (sides[0].frontier.length && sides[1].frontier.length) {
    const s = sides[0].frontier.length <= sides[1].frontier.length ? 0 : 1
    const me = sides[s]
    const other = sides[1 - s].dist
    const next = []
    let best = Infinity
    const f = me.frontier
    const step = me.depth + 1
    const reach = (nx, nz, ny) => {
      const nk = packNodeKey(nx, nz, ny)
      if (me.dist.has(nk)) return
      me.dist.set(nk, step)
      const o = other.get(nk)
      if (o !== undefined && step + o < best) best = step + o
      next.push(nx, nz, ny)
    }
    for (let i = 0; i < f.length; i += 3) {
      if (++visited > maxNodes) return { ok: false, steps: -1, visited, reason: 'max-nodes' }
      eachNeighbour(source, b, f[i], f[i + 1], f[i + 2], reach)
    }
    // Every cell met in this layer lies at `step` from this side; the
    // shortest route through any of them is the smallest sum (the other
    // side's depths differ by at most one across its last layers).
    if (best < Infinity) return { ok: true, steps: best, visited }
    me.frontier = next
    me.depth = step
  }
  return { ok: false, steps: -1, visited, reason: 'unreachable' }
}

// The component partition of box b computed with the lazy search's own
// edges (not walkGraph): every walkable cell of b, flooded over
// `neighbours`. Canonical form: each component as its sorted "gx,gz,cy"
// keys, components sorted by their first key. reach-oracle.test compares it
// with walkGraph's partition and its sizes with auditLayeredPatch's.
export function componentPartition(source, box) {
  const b = toBox(box)
  const key = (gx, gz, cy) => `${gx},${gz},${cy}`
  const seen = new Set()
  const out = []
  for (let cy = b.y0; cy <= b.y1; cy++) {
    for (let cz = b.z0; cz <= b.z1; cz++) {
      for (let cx = b.x0; cx <= b.x1; cx++) {
        const d = source.chunkAt(cx, cy, cz)
        if (!d) continue
        for (let lz = 0; lz < CHUNK; lz++) {
          for (let lx = 0; lx < CHUNK; lx++) {
            if (!cellWalkable(d, lx, lz)) continue
            const gx = cx * CHUNK + lx
            const gz = cz * CHUNK + lz
            const start = key(gx, gz, cy)
            if (seen.has(start)) continue
            seen.add(start)
            const comp = [start]
            const stack = [[gx, gz, cy]]
            while (stack.length) {
              const [x, z, y] = stack.pop()
              for (const [nx, nz, ny] of neighbours(source, b, x, z, y)) {
                const nk = key(nx, nz, ny)
                if (seen.has(nk)) continue
                seen.add(nk)
                comp.push(nk)
                stack.push([nx, nz, ny])
              }
            }
            out.push(comp.sort())
          }
        }
      }
    }
  }
  return out.sort((p, q) => (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : 0))
}

// --- window connectivity ------------------------------------------------------------

// Whether walkable cell `cur` (in chunk cx, cz) can lead out of box b: it
// lies in the box's planar ring of chunks, or it is a stair end on the box's
// top / bottom storey whose flight leaves the box.
function leavesBox(source, b, cur, cx, cz) {
  if (cx === b.x0 || cx === b.x1 || cz === b.z0 || cz === b.z1) return true
  if (cur.cy !== b.y0 && cur.cy !== b.y1) return false
  const d = source.chunkAt(cx, cur.cy, cz)
  const lx = cur.gx - cx * CHUNK
  const lz = cur.gz - cz * CHUNK
  if (cur.cy === b.y1 && d?.stairUp?.landing?.lx === lx && d.stairUp.landing.lz === lz) return true
  if (cur.cy === b.y0 && d?.stairDown?.exit?.lx === lx && d.stairDown.exit.lz === lz) return true
  return false
}

// Decision 6 over a test window: every walkable cell of `inner` must belong
// to the spawn's component of the walk graph over `outer` (inner grown by a
// margin, so routes may leave inner and come back). A component that is not
// the spawn's and can leave outer (a cell in outer's planar ring of chunks,
// or a stair end on its top/bottom storey whose flight leaves it) is STRANDED (unproven: it
// may only connect outside the window) and fails. One that does not touch it
// is a SEALED pocket: allowed when it has ≤ sealedMax cells, or at any size
// when `sealedPockets` is set; otherwise it fails.
//
// Returns { ok, reason, walkable (inner cells), components (over outer),
//   spawnComponent (size), stranded: [{size, sample}], sealed: [...],
//   pockets: [...] (the allowed sealed ones) }.
export function windowConnectivity(source, inner, outer, spawn, { sealedMax = 24, sealedPockets = false } = {}) {
  const ib = toBox(inner)
  const ob = toBox(outer)
  const graph = walkGraph(source, ob)
  const s = toCell(spawn)
  const spawnKey = graph.keyOf(s.gx, s.gz, s.cy)
  const result = { ok: false, reason: null, walkable: 0, components: 0, spawnComponent: 0, stranded: [], sealed: [], pockets: [] }
  if (!graph.nodes.has(spawnKey)) {
    result.reason = 'spawn-not-walkable'
    return result
  }
  const label = new Map()
  const comps = []
  for (const [startKey, start] of graph.nodes) {
    if (label.has(startKey)) continue
    const id = comps.length
    const comp = { id, size: 0, sample: start, inner: 0, boundary: false }
    comps.push(comp)
    label.set(startKey, id)
    const stack = [start]
    while (stack.length) {
      const cur = stack.pop()
      comp.size++
      const cx = Math.floor(cur.gx / CHUNK)
      const cz = Math.floor(cur.gz / CHUNK)
      if (inBoxChunk(ib, cx, cur.cy, cz)) comp.inner++
      if (!comp.boundary && leavesBox(source, ob, cur, cx, cz)) comp.boundary = true
      for (const [k] of graph.neighbors(cur)) {
        if (label.has(k)) continue
        label.set(k, id)
        stack.push(graph.nodes.get(k))
      }
    }
  }
  const spawnId = label.get(spawnKey)
  result.components = comps.length
  result.spawnComponent = comps[spawnId].size
  for (const c of comps) {
    result.walkable += c.inner
    if (c.id === spawnId || !c.inner) continue
    const rec = { size: c.size, sample: { ...c.sample } }
    if (c.boundary) result.stranded.push(rec)
    else if (sealedPockets || c.size <= sealedMax) result.pockets.push(rec)
    else result.sealed.push(rec)
  }
  if (!inBoxChunk(ib, Math.floor(s.gx / CHUNK), s.cy, Math.floor(s.gz / CHUNK))) result.reason = 'spawn-outside-inner'
  else if (result.stranded.length) result.reason = 'stranded-components'
  else if (result.sealed.length) result.reason = 'sealed-pockets'
  result.ok = result.reason === null
  return result
}
