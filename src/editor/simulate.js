import { CELL, CHUNK, cIdx } from '../world/constants.js'
import { CELL_CORRIDOR, CELL_LOBBY, CELL_OPEN, CELL_ROOM } from '../world/mapTypes.js'
import { hasLineOfSight } from '../player/collision.js'
import { hash3i } from '../world/core/hash.js'
import { DARK_LEVEL, lightField, nodeKey, sourceCM, walkGraph as walkGraphKeyed } from '../world/tiles/simulate.js'

// Simulations over an editor source (the document or the live world): the
// player-facing questions a liminal-horror layout has to answer, measured
// instead of eyeballed.
//
//   walkGraph      the walk graph the layered audit and pathfinder use
//   distanceField  how far everything is from a point (exit distance, depth)
//   shortestPath   the route between two points, across floors
//   lightField     where the fluorescent lamps actually reach (darkness)
//   isovist        what is visible from a point (sightline depth, exposure)
//   liminalReport  per-floor expressive metrics: dead ends, loops, articulation
//                  spaces, junction density, darkness, sightlines, repetition
//
// Every function reads through chunkAt/wallVAt/wallHAt only; for the world
// source the caller prepares the box first. Distances are in cells (3 m).

// The walk graph, node keys, the game-rule adapter and the light estimate
// live in world/tiles/simulate.js (the world's reachability proofs share
// them); the editor re-exports them. Its walk graph keeps the editor's
// string node keys (nodeKey), which every analysis below and every editor
// caller indexes by.
export {
  DARK_LEVEL,
  STAIR_STEP_COST,
  graphComponents,
  lightField,
  nodeKey,
  sourceCM,
} from '../world/tiles/simulate.js'

export const walkGraph = (source, box, options = {}) => walkGraphKeyed(source, box, { keys: 'string', ...options })

// --- distance field and paths --------------------------------------------------------

// Dial's algorithm (bucketed Dijkstra; costs are 1 or STAIR_STEP_COST).
function dijkstra(graph, startKey, targetKey = null) {
  const dist = new Map([[startKey, 0]])
  const parent = new Map()
  const buckets = [[startKey]]
  for (let d = 0; d < buckets.length; d++) {
    const bucket = buckets[d]
    if (!bucket) continue
    for (let i = 0; i < bucket.length; i++) {
      const k = bucket[i]
      if (dist.get(k) !== d) continue
      if (k === targetKey) return { dist, parent }
      for (const [nk, cost] of graph.neighbors(graph.nodes.get(k))) {
        const nd = d + cost
        const old = dist.get(nk)
        if (old !== undefined && old <= nd) continue
        dist.set(nk, nd)
        parent.set(nk, k)
        ;(buckets[nd] ??= []).push(nk)
      }
    }
    buckets[d] = null
  }
  return { dist, parent }
}

// How far every reachable cell is from `start` ({gx, gz, cy}). Also reports
// the farthest cell (a natural exit/objective candidate), unreachable walkable
// cells, dead ends (degree-1 cells) and per-floor reach.
export function distanceField(source, box, start) {
  const graph = walkGraph(source, box)
  const startKey = nodeKey(start.gx, start.gz, start.cy)
  if (!graph.nodes.has(startKey)) {
    return { ok: false, reason: 'start cell is not walkable', dist: new Map(), graph }
  }
  const { dist } = dijkstra(graph, startKey)
  let max = 0
  let farthest = null
  const perFloor = new Map()
  for (const [k, d] of dist) {
    const n = graph.nodes.get(k)
    const f = perFloor.get(n.cy) ?? { cy: n.cy, reachable: 0, max: 0 }
    f.reachable++
    f.max = Math.max(f.max, d)
    perFloor.set(n.cy, f)
    if (d > max) {
      max = d
      farthest = n
    }
  }
  const deadEnds = []
  for (const [k, n] of graph.nodes) {
    if (graph.neighbors(n).length === 1 && dist.has(k)) deadEnds.push(n)
  }
  const histogram = new Array(Math.min(64, Math.ceil(max / 8) + 1)).fill(0)
  for (const d of dist.values()) histogram[Math.min(histogram.length - 1, Math.floor(d / 8))]++
  return {
    ok: true,
    dist,
    graph,
    max,
    farthest,
    reachable: dist.size,
    unreachable: graph.nodes.size - dist.size,
    deadEnds,
    histogram,
    perFloor: [...perFloor.values()].sort((a, b) => a.cy - b.cy),
  }
}

export function shortestPath(source, box, a, b) {
  const graph = walkGraph(source, box)
  const ak = nodeKey(a.gx, a.gz, a.cy)
  const bk = nodeKey(b.gx, b.gz, b.cy)
  if (!graph.nodes.has(ak)) return { ok: false, reason: 'start cell is not walkable' }
  if (!graph.nodes.has(bk)) return { ok: false, reason: 'target cell is not walkable' }
  const { dist, parent } = dijkstra(graph, ak, bk)
  if (!dist.has(bk)) return { ok: false, reason: 'no route inside the box' }
  const path = []
  for (let k = bk; k; k = parent.get(k)) {
    path.push(graph.nodes.get(k))
    if (k === ak) break
  }
  path.reverse()
  let flights = 0
  for (let i = 1; i < path.length; i++) if (path[i].cy !== path[i - 1].cy) flights++
  return { ok: true, path, cost: dist.get(bk), flights }
}

// --- isovist -------------------------------------------------------------------------

// The set of cells visible from a cell centre at eye height on one floor:
// `rays` rays, each extended to the farthest point with a clear game line of
// sight (binary search; sight is monotone along a ray), up to `range` cells.
export function isovist(source, cy, gx, gz, { rays = 180, range = 32 } = {}) {
  const cm = sourceCM(source)
  const ox = (gx + 0.5) * CELL
  const oz = (gz + 0.5) * CELL
  const maxD = range * CELL
  const points = []
  const cells = new Set([nodeKey(gx, gz, cy)])
  let sum = 0
  let maxDepth = 0
  for (let i = 0; i < rays; i++) {
    const a = (i / rays) * Math.PI * 2
    const dx = Math.cos(a)
    const dz = Math.sin(a)
    let lo = 0
    let hi = maxD
    if (hasLineOfSight(cm, ox, oz, ox + dx * hi, oz + dz * hi, cy)) lo = hi
    else {
      for (let it = 0; it < 14; it++) {
        const mid = (lo + hi) / 2
        if (hasLineOfSight(cm, ox, oz, ox + dx * mid, oz + dz * mid, cy)) lo = mid
        else hi = mid
      }
    }
    points.push({ x: ox + dx * lo, z: oz + dz * lo })
    sum += lo
    maxDepth = Math.max(maxDepth, lo)
    for (let t = CELL * 0.5; t < lo; t += CELL * 0.5) {
      cells.add(nodeKey(Math.floor((ox + dx * t) / CELL), Math.floor((oz + dz * t) / CELL), cy))
    }
  }
  // Polygon area (shoelace) in cells².
  let area = 0
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const q = points[(i + 1) % points.length]
    area += p.x * q.z - q.x * p.z
  }
  area = Math.abs(area) / 2 / (CELL * CELL)
  let perimeter = 0
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const q = points[(i + 1) % points.length]
    perimeter += Math.hypot(q.x - p.x, q.z - p.z)
  }
  perimeter /= CELL
  return {
    origin: { gx, gz, cy },
    points,
    cells,
    area,
    perimeter,
    // 4πA/P²: 1 for a disc, low for spiky, corridor-dominated views.
    compactness: perimeter > 0 ? (4 * Math.PI * area) / (perimeter * perimeter) : 0,
    meanDepth: sum / rays / CELL,
    maxDepth: maxDepth / CELL,
    range,
  }
}

// --- liminal report ---------------------------------------------------------------------

// Space graph of one floor, in the space-syntax sense of convex spaces:
// every named room (CELL_ROOM cells sharing a spaceId) is one node, and all
// other walkable cells — corridors, lobbies, halls, decks — are decomposed
// into maximal rectangles (greedy, scan order, never across a wall), so a
// corridor ring round a core reads as the ring it is instead of one blob. An
// edge joins two spaces that share an open (walkable) edge. On it: dead-end
// spaces (degree 1), decision spaces (degree >= 3: where the player chooses),
// independent loops (cyclomatic number E − V + C), and articulation spaces
// (removing one disconnects the floor) — the "graph cycles, dead ends,
// articulation points, decision density" validation gates.
export function spaceGraph(source, box, cy) {
  const graph = walkGraph(source, { ...box, y0: cy, y1: cy }, { vertical: false })
  const spaceOf = new Map() // nodeKey -> space key
  const cellInfo = (gx, gz) => {
    const d = source.chunkAt(Math.floor(gx / CHUNK), cy, Math.floor(gz / CHUNK))
    const i = cIdx(gx - d.cx * CHUNK, gz - d.cz * CHUNK)
    return { kind: d.cellKind[i], id: d.spaceId[i] }
  }
  // Named rooms first.
  const circulation = []
  for (const [k, n] of graph.nodes) {
    const c = cellInfo(n.gx, n.gz)
    if (c.kind === CELL_ROOM && c.id) spaceOf.set(k, `s${c.id}`)
    else circulation.push(n)
  }
  // Maximal rectangles over the remaining walkable cells.
  const free = new Set(circulation.map((n) => nodeKey(n.gx, n.gz, cy)))
  const openE = (gx, gz) => !source.wallVAt(gx + 1, cy, gz).wall
  const openS = (gx, gz) => !source.wallHAt(gx, cy, gz + 1).wall
  circulation.sort((a, b) => a.gz - b.gz || a.gx - b.gx)
  let rect = 0
  for (const n of circulation) {
    const k0 = nodeKey(n.gx, n.gz, cy)
    if (!free.has(k0)) continue
    let x1 = n.gx
    while (free.has(nodeKey(x1 + 1, n.gz, cy)) && openE(x1, n.gz)) x1++
    let z1 = n.gz
    for (;;) {
      const z = z1 + 1
      let ok = true
      for (let x = n.gx; x <= x1 && ok; x++) {
        if (!free.has(nodeKey(x, z, cy)) || !openS(x, z1)) ok = false
        else if (x < x1 && !openE(x, z)) ok = false
      }
      if (!ok) break
      z1 = z
    }
    const label = `r${rect++}`
    for (let z = n.gz; z <= z1; z++) {
      for (let x = n.gx; x <= x1; x++) {
        const k = nodeKey(x, z, cy)
        free.delete(k)
        spaceOf.set(k, label)
      }
    }
  }
  const adj = new Map()
  const sizes = new Map()
  for (const [k, n] of graph.nodes) {
    const a = spaceOf.get(k)
    sizes.set(a, (sizes.get(a) ?? 0) + 1)
    if (!adj.has(a)) adj.set(a, new Set())
    for (const [nk] of graph.neighbors(n)) {
      const b = spaceOf.get(nk)
      if (b !== a) adj.get(a).add(b)
    }
  }
  let edges = 0
  for (const set of adj.values()) edges += set.size
  edges /= 2
  // Components and articulation points (iterative Tarjan).
  const disc = new Map()
  const low = new Map()
  const articulation = new Set()
  let time = 0
  let components = 0
  for (const root of adj.keys()) {
    if (disc.has(root)) continue
    components++
    disc.set(root, time)
    low.set(root, time++)
    let rootChildren = 0
    const stack = [{ v: root, parent: null, it: adj.get(root).values() }]
    while (stack.length) {
      const top = stack[stack.length - 1]
      const next = top.it.next()
      if (!next.done) {
        const w = next.value
        if (!disc.has(w)) {
          disc.set(w, time)
          low.set(w, time++)
          if (top.v === root) rootChildren++
          stack.push({ v: w, parent: top.v, it: adj.get(w).values() })
        } else if (w !== top.parent) {
          low.set(top.v, Math.min(low.get(top.v), disc.get(w)))
        }
      } else {
        stack.pop()
        const p = top.parent
        if (p !== null) {
          low.set(p, Math.min(low.get(p), low.get(top.v)))
          if (p !== root && low.get(top.v) >= disc.get(p)) articulation.add(p)
        }
      }
    }
    if (rootChildren > 1) articulation.add(root)
  }
  let deadEnds = 0
  let decisions = 0
  let decisionChoices = 0
  for (const set of adj.values()) {
    if (set.size === 1) deadEnds++
    else if (set.size >= 3) {
      decisions++
      decisionChoices += set.size
    }
  }
  const types = hillierTypes(adj)
  const syntax = integration(adj)
  return {
    spaces: adj.size,
    edges,
    components,
    loops: edges - adj.size + components,
    deadEnds,
    decisions,
    // O'Neill's inter-connection density: mean choices at a decision point.
    icd: decisions ? decisionChoices / decisions : 0,
    articulation: articulation.size,
    types,
    ...syntax,
    sizes,
  }
}

// Repeated units: named rooms whose layout (size, furniture kinds at the
// same offsets, lamp state) exactly repeats another room's on the floor.
export function roomRepetition(source, box, cy) {
  const rooms = new Map() // spaceId -> {x0, z0, x1, z1, items}
  for (let cz = box.z0; cz <= box.z1; cz++) {
    for (let cx = box.x0; cx <= box.x1; cx++) {
      const d = source.chunkAt(cx, cy, cz)
      if (!d) continue
      for (let lz = 0; lz < CHUNK; lz++) {
        for (let lx = 0; lx < CHUNK; lx++) {
          const i = cIdx(lx, lz)
          if (d.cellKind[i] !== CELL_ROOM || !d.spaceId[i]) continue
          const gx = cx * CHUNK + lx
          const gz = cz * CHUNK + lz
          let r = rooms.get(d.spaceId[i])
          if (!r) rooms.set(d.spaceId[i], (r = { x0: gx, z0: gz, x1: gx, z1: gz, cells: [] }))
          r.x0 = Math.min(r.x0, gx)
          r.z0 = Math.min(r.z0, gz)
          r.x1 = Math.max(r.x1, gx)
          r.z1 = Math.max(r.z1, gz)
          r.cells.push({ gx, gz, d, lx, lz })
        }
      }
    }
  }
  const signatures = new Map()
  for (const r of rooms.values()) {
    const items = []
    for (const { gx, gz, d, lx, lz } of r.cells) {
      // Every record of a stacked cell counts (the items sort below), so a
      // copy that lost one shelf of a gondola is not a repeat.
      for (const f of d.furniture) if (f.lx === lx && f.lz === lz) items.push(`f${f.kind}@${gx - r.x0},${gz - r.z0}`)
      const l = d.lamps.find((p) => p.lx === lx && p.lz === lz)
      if (l) items.push(`l${l.lit ? 1 : 0}@${gx - r.x0},${gz - r.z0}`)
    }
    const sig = `${r.x1 - r.x0 + 1}x${r.z1 - r.z0 + 1}:${r.cells.length}|${items.sort().join(';')}`
    signatures.set(sig, (signatures.get(sig) ?? 0) + 1)
  }
  let repeated = 0
  for (const n of signatures.values()) if (n > 1) repeated += n
  return { rooms: rooms.size, repeated, share: rooms.size ? repeated / rooms.size : 0 }
}

// Hillier's space types from the biconnected blocks of the space graph:
//   a  one link (dead end)          b  on no ring, more than one link
//   c  on exactly one simple ring   d  on several rings (or a block with more
//                                      than one independent ring)
// Rings are found as biconnected blocks with >= 3 spaces (edge-stack Tarjan).
export function hillierTypes(adj) {
  const disc = new Map()
  const low = new Map()
  const blocksOf = new Map() // node -> [{nodes, edges}]
  const edgeStack = []
  let time = 0
  const record = (block) => {
    for (const v of block.nodes) {
      let list = blocksOf.get(v)
      if (!list) blocksOf.set(v, (list = []))
      list.push(block)
    }
  }
  const popBlock = (u, w) => {
    const nodes = new Set()
    let edges = 0
    while (edgeStack.length) {
      const [a, b] = edgeStack.pop()
      nodes.add(a)
      nodes.add(b)
      edges++
      if (a === u && b === w) break
    }
    record({ nodes, edges })
  }
  for (const root of adj.keys()) {
    if (disc.has(root)) continue
    disc.set(root, time)
    low.set(root, time++)
    const stack = [{ v: root, parent: null, it: adj.get(root).values() }]
    while (stack.length) {
      const top = stack[stack.length - 1]
      const next = top.it.next()
      if (!next.done) {
        const w = next.value
        if (!disc.has(w)) {
          edgeStack.push([top.v, w])
          disc.set(w, time)
          low.set(w, time++)
          stack.push({ v: w, parent: top.v, it: adj.get(w).values() })
        } else if (w !== top.parent && disc.get(w) < disc.get(top.v)) {
          edgeStack.push([top.v, w])
          low.set(top.v, Math.min(low.get(top.v), disc.get(w)))
        }
      } else {
        stack.pop()
        const p = top.parent
        if (p !== null) {
          low.set(p, Math.min(low.get(p), low.get(top.v)))
          if (low.get(top.v) >= disc.get(p)) popBlock(p, top.v)
        }
      }
    }
  }
  const counts = { a: 0, b: 0, c: 0, d: 0 }
  for (const [v, set] of adj) {
    const rings = (blocksOf.get(v) ?? []).filter((blk) => blk.nodes.size >= 3)
    let type
    if (!rings.length) type = set.size <= 1 ? 'a' : 'b'
    else if (rings.length === 1 && rings[0].edges === rings[0].nodes.size) type = 'c'
    else type = 'd'
    counts[type]++
  }
  const n = adj.size || 1
  return {
    ...counts,
    shares: { a: counts.a / n, b: counts.b / n, c: counts.c / n, d: counts.d / n },
  }
}

// Space-syntax integration per space (Hillier & Hanson): mean depth MD over
// its component, relative asymmetry RA = 2(MD−1)/(n−2), normalised by the
// diamond value Dn; integration = 1/RRA. Intelligibility is the R² between
// connectivity (degree) and integration across spaces.
export function integration(adj) {
  const nodes = [...adj.keys()]
  const values = []
  const degrees = []
  for (const root of nodes) {
    const depth = new Map([[root, 0]])
    const queue = [root]
    let sum = 0
    for (let i = 0; i < queue.length; i++) {
      const v = queue[i]
      for (const w of adj.get(v)) {
        if (depth.has(w)) continue
        depth.set(w, depth.get(v) + 1)
        sum += depth.get(w)
        queue.push(w)
      }
    }
    const k = queue.length
    if (k < 4) continue
    const md = sum / (k - 1)
    const ra = (2 * (md - 1)) / (k - 2)
    const dn = (2 * (k * (Math.log2((k + 2) / 3) - 1) + 1)) / ((k - 1) * (k - 2))
    // A hub one step from everything has RRA 0 (infinite integration);
    // floor it so perfectly integrated spaces still count.
    const rra = Math.max(0.05, ra / dn)
    values.push(1 / rra)
    degrees.push(adj.get(root).size)
  }
  if (!values.length) return { meanIntegration: 0, intelligibility: 0 }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length
  const mi = mean(values)
  const md = mean(degrees)
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0; i < values.length; i++) {
    sxy += (degrees[i] - md) * (values[i] - mi)
    sxx += (degrees[i] - md) ** 2
    syy += (values[i] - mi) ** 2
  }
  return {
    meanIntegration: mi,
    intelligibility: sxx > 0 && syy > 0 ? (sxy * sxy) / (sxx * syy) : 0,
  }
}

// Moran's I of darkness over walkable 4-adjacency: ~0 for speckle (dead
// lamps scattered one by one), toward 1 when dark cells form zones.
export function darknessClustering(graph, level) {
  const keys = [...graph.nodes.keys()]
  if (keys.length < 2) return 0
  const x = new Map(keys.map((k) => [k, (level.get(k) ?? 0) < DARK_LEVEL ? 1 : 0]))
  const mean = [...x.values()].reduce((a, b) => a + b, 0) / keys.length
  let num = 0
  let den = 0
  let w = 0
  for (const k of keys) {
    const zi = x.get(k) - mean
    den += zi * zi
    for (const [nk] of graph.neighbors(graph.nodes.get(k))) {
      num += zi * (x.get(nk) - mean)
      w++
    }
  }
  if (!den || !w) return 0
  return (keys.length / w) * (num / den)
}

const quantile = (sorted, q) => sorted.length
  ? sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1) + 0.5))]
  : 0

// Per-floor expressive metrics over a chunk box. `samples` isovists are taken
// at deterministic walkable cells (hash-selected, stable across runs).
export function liminalReport(source, box, { samples = 24, rays = 120, lightRadius = 6, range = 48 } = {}) {
  const floors = []
  for (let cy = box.y0; cy <= box.y1; cy++) {
    const planar = walkGraph(source, { ...box, y0: cy, y1: cy }, { vertical: false })
    if (!planar.nodes.size) continue
    let open = 0
    let circulation = 0
    let deadEndCells = 0
    const candidates = []
    for (const [k, n] of planar.nodes) {
      const d = source.chunkAt(Math.floor(n.gx / CHUNK), cy, Math.floor(n.gz / CHUNK))
      const kind = d.cellKind[cIdx(n.gx - d.cx * CHUNK, n.gz - d.cz * CHUNK)]
      if (kind === CELL_OPEN) open++
      if (kind === CELL_CORRIDOR || kind === CELL_LOBBY) circulation++
      if (planar.neighbors(n).length === 1) deadEndCells++
      candidates.push([hash3i(0x11a1, n.gx, n.gz, cy) >>> 0, k])
    }
    candidates.sort((a, b) => a[0] - b[0])
    const depths = []
    const areas = []
    const compact = []
    for (const [, k] of candidates.slice(0, samples)) {
      const n = planar.nodes.get(k)
      const iso = isovist(source, cy, n.gx, n.gz, { rays, range })
      depths.push(iso.maxDepth)
      areas.push(iso.area)
      compact.push(iso.compactness)
    }
    depths.sort((a, b) => a - b)
    areas.sort((a, b) => a - b)
    compact.sort((a, b) => a - b)
    const light = lightField(source, box, cy, { radius: lightRadius })
    const spaces = spaceGraph(source, box, cy)
    const units = roomRepetition(source, box, cy)
    // Repetition: share of chunks whose wall layout exactly repeats another
    // chunk's on this floor.
    const layouts = new Map()
    let chunks = 0
    for (let cz = box.z0; cz <= box.z1; cz++) {
      for (let cx = box.x0; cx <= box.x1; cx++) {
        const d = source.chunkAt(cx, cy, cz)
        if (!d) continue
        chunks++
        const sig = `${d.wallV.join('')}|${d.wallH.join('')}`
        layouts.set(sig, (layouts.get(sig) ?? 0) + 1)
      }
    }
    let repeated = 0
    for (const n of layouts.values()) if (n > 1) repeated += n
    const walkable = planar.nodes.size
    floors.push({
      cy,
      chunks,
      walkable,
      openShare: open / walkable,
      circulationShare: circulation / walkable,
      deadEndCells,
      decisionSpaces: spaces.decisions,
      spaces: spaces.spaces,
      loops: spaces.loops,
      deadEndSpaces: spaces.deadEnds,
      articulationSpaces: spaces.articulation,
      components: spaces.components,
      darkness: light.darkness,
      darkClustering: darknessClustering(planar, light.level),
      litLamps: light.litLamps,
      deadLamps: light.deadLamps,
      sightMedian: quantile(depths, 0.5),
      sightP90: quantile(depths, 0.9),
      isovistMedian: quantile(areas, 0.5),
      compactnessMedian: quantile(compact, 0.5),
      icd: spaces.icd,
      hillier: spaces.types.shares,
      meanIntegration: spaces.meanIntegration,
      intelligibility: spaces.intelligibility,
      repetition: chunks ? repeated / chunks : 0,
      rooms: units.rooms,
      roomRepetition: units.share,
    })
  }
  return { box, floors }
}
