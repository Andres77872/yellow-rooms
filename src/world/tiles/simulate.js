import { CELL, CHUNK, COL_HALF, MONUMENTAL_COL_HALF, cIdx } from '../constants.js'
import { COLUMN_FURNITURE, COLUMN_MONUMENTAL, wallFeatureSeesThrough } from '../mapTypes.js'
import { hasLineOfSight } from '../../player/collision.js'
import { STAIR_DOWN_RUN, STAIR_UP_RUN, cellWalkable, holeMasks } from './holeMasks.js'

// The source-level simulation helpers the world's reachability proofs and
// the editor's simulations share (moved from editor/simulate.js, which
// re-exports them and keeps the editor-only analyses: distance fields,
// paths, isovists, space syntax, the liminal report).
//
// A source is anything with chunkAt(cx, cy, cz) / wallVAt / wallHAt over one
// coordinate frame: the editor document, a tile canvas (its local frame) or a
// generated-world window. Distances are in cells (3 m).

// The editor's node key: a string, stable across every coordinate.
export const nodeKey = (gx, gz, cy) => `${gx},${gz},${cy}`

// The world's node key: one JS number, ((cy+512)·2^22 + (gx+2^20))·2^21 +
// (gz+2^20), exact below 2^53 for cy ∈ [-512, 511], gx ∈ [-2^20, 3·2^20) and
// gz ∈ [-2^20, 2^20). Out of that range it falls back to the string key, so
// a key is always unique (a number never equals a string).
const PACK_CY = 512
const PACK_G = 0x100000 // 2^20
export function packNodeKey(gx, gz, cy) {
  const y = cy + PACK_CY
  const x = gx + PACK_G
  const z = gz + PACK_G
  if (y >= 0 && y < 1024 && x >= 0 && x < 0x400000 && z >= 0 && z < 0x200000 &&
    Number.isInteger(y) && Number.isInteger(x) && Number.isInteger(z)) {
    return (y * 0x400000 + x) * 0x200000 + z
  }
  return nodeKey(gx, gz, cy)
}

const KEY_FNS = Object.freeze({ packed: packNodeKey, string: nodeKey })

// Cost of one stair flight in cells: landing -> exit spans three cells.
export const STAIR_STEP_COST = 3

// --- game-rule adapter ---------------------------------------------------------

// The ChunkManager-shaped interface the game's collision/sight helpers read
// (player/collision.js), backed by an editor source. Using the game's own DDA
// keeps isovists faithful: windows and guard rails are see-through, piers
// block at their true size, low furniture does not occlude.
export function sourceCM(source) {
  // Local cells from the queried chunk key, not from d.cx: a tile canvas's
  // chunks carry global coordinates while its accessors take local ones.
  const locate = (gx, gz, cy) => {
    const cx = Math.floor(gx / CHUNK)
    const cz = Math.floor(gz / CHUNK)
    const d = source.chunkAt(cx, cy, cz)
    return d ? { d, lx: gx - cx * CHUNK, lz: gz - cz * CHUNK } : null
  }
  return {
    wallVAt(gx, gz, cy = 0) {
      const a = locate(gx, gz, cy)
      return !!a && a.d.vAt(a.lx, a.lz) === 1
    },
    wallHAt(gx, gz, cy = 0) {
      const a = locate(gx, gz, cy)
      return !!a && a.d.hAt(a.lx, a.lz) === 1
    },
    opaqueVAt(gx, gz, cy = 0) {
      const a = locate(gx, gz, cy)
      return !!a && a.d.vAt(a.lx, a.lz) === 1 && !wallFeatureSeesThrough(a.d.wallFeatureVAt(a.lx, a.lz))
    },
    opaqueHAt(gx, gz, cy = 0) {
      const a = locate(gx, gz, cy)
      return !!a && a.d.hAt(a.lx, a.lz) === 1 && !wallFeatureSeesThrough(a.d.wallFeatureHAt(a.lx, a.lz))
    },
    columnAt(gx, gz, cy = 0) {
      const a = locate(gx, gz, cy)
      return !!a && a.d.colAt(a.lx, a.lz) > 0
    },
    columnHalfAt(gx, gz, cy = 0) {
      const a = locate(gx, gz, cy)
      if (!a) return 0
      const kind = a.d.colAt(a.lx, a.lz)
      if (!kind || kind === COLUMN_FURNITURE) return 0
      return kind === COLUMN_MONUMENTAL ? MONUMENTAL_COL_HALF : COL_HALF
    },
    floorHoleAt(gx, gz, cy = 0) {
      const a = locate(gx, gz, cy)
      return !!a && holeMasks(a.d).floor[cIdx(a.lx, a.lz)] === 1
    },
    stairAt(gx, gz, cy = 0) {
      const a = locate(gx, gz, cy)
      if (!a) return null
      const bits = holeMasks(a.d).stair[cIdx(a.lx, a.lz)]
      if (bits & STAIR_UP_RUN) return { part: 'run' }
      if (bits & STAIR_DOWN_RUN) return { part: 'hole' }
      return null
    },
  }
}

// --- walk graph -------------------------------------------------------------------

// Walkable cells are nodes; planar steps cross an open thin-wall edge (the
// owner of the shared grid line decides; a missing chunk or a cell outside the
// box blocks); the sole vertical edge joins a matched stair's lower landing and
// upper exit. Identical to the layered audit's graph (tested).
//
// Node keys are packed integers (packNodeKey) unless `keys: 'string'` asks
// for the editor's nodeKey strings (editor/simulate.js passes it, so every
// editor consumer keeps its string-keyed maps).
export function walkGraph(source, box, { vertical = true, keys = 'packed' } = {}) {
  const keyOf = KEY_FNS[keys]
  if (!keyOf) throw new Error(`walkGraph: keys must be 'packed' or 'string', got ${keys}`)
  const nodes = new Map()
  for (let cy = box.y0; cy <= box.y1; cy++) {
    for (let cz = box.z0; cz <= box.z1; cz++) {
      for (let cx = box.x0; cx <= box.x1; cx++) {
        const d = source.chunkAt(cx, cy, cz)
        if (!d) continue
        for (let lz = 0; lz < CHUNK; lz++) {
          for (let lx = 0; lx < CHUNK; lx++) {
            if (!cellWalkable(d, lx, lz)) continue
            const gx = cx * CHUNK + lx
            const gz = cz * CHUNK + lz
            nodes.set(keyOf(gx, gz, cy), { gx, gz, cy })
          }
        }
      }
    }
  }

  const links = new Map()
  if (vertical) {
    for (let cy = box.y0; cy < box.y1; cy++) {
      for (let cz = box.z0; cz <= box.z1; cz++) {
        for (let cx = box.x0; cx <= box.x1; cx++) {
          const up = source.chunkAt(cx, cy, cz)?.stairUp
          const down = source.chunkAt(cx, cy + 1, cz)?.stairDown
          if (!up || !down || JSON.stringify(up) !== JSON.stringify(down)) continue
          const a = keyOf(cx * CHUNK + up.landing.lx, cz * CHUNK + up.landing.lz, cy)
          const b = keyOf(cx * CHUNK + up.exit.lx, cz * CHUNK + up.exit.lz, cy + 1)
          if (!nodes.has(a) || !nodes.has(b)) continue
          if (!links.has(a)) links.set(a, [])
          if (!links.has(b)) links.set(b, [])
          links.get(a).push(b)
          links.get(b).push(a)
        }
      }
    }
  }

  const inBox = (gx, gz) => {
    const cx = Math.floor(gx / CHUNK)
    const cz = Math.floor(gz / CHUNK)
    return cx >= box.x0 && cx <= box.x1 && cz >= box.z0 && cz <= box.z1
  }
  // A source with wallBitVAt/wallBitHAt (families/reach.js worldSource)
  // reads the wall byte without building a { wall, passage, feature } record.
  const wallV = source.wallBitVAt ? (gx, cy, gz) => source.wallBitVAt(gx, cy, gz) : (gx, cy, gz) => source.wallVAt(gx, cy, gz).wall
  const wallH = source.wallBitHAt ? (gx, cy, gz) => source.wallBitHAt(gx, cy, gz) : (gx, cy, gz) => source.wallHAt(gx, cy, gz).wall
  const blockedV = (lineGX, gz, cy) => !inBox(lineGX, gz) ||
    !source.chunkAt(Math.floor(lineGX / CHUNK), cy, Math.floor(gz / CHUNK)) ||
    wallV(lineGX, cy, gz) === 1
  const blockedH = (gx, lineGZ, cy) => !inBox(gx, lineGZ) ||
    !source.chunkAt(Math.floor(gx / CHUNK), cy, Math.floor(lineGZ / CHUNK)) ||
    wallH(gx, cy, lineGZ) === 1

  // Planar neighbours of a node with their edge cost, plus stair links.
  const neighbors = (n) => {
    const out = []
    const push = (gx, gz, cy, blocked) => {
      if (blocked) return
      const k = keyOf(gx, gz, cy)
      if (nodes.has(k)) out.push([k, 1])
    }
    push(n.gx + 1, n.gz, n.cy, blockedV(n.gx + 1, n.gz, n.cy))
    push(n.gx - 1, n.gz, n.cy, blockedV(n.gx, n.gz, n.cy))
    push(n.gx, n.gz + 1, n.cy, blockedH(n.gx, n.gz + 1, n.cy))
    push(n.gx, n.gz - 1, n.cy, blockedH(n.gx, n.gz, n.cy))
    for (const k of links.get(keyOf(n.gx, n.gz, n.cy)) ?? []) out.push([k, STAIR_STEP_COST])
    return out
  }
  return { nodes, links, neighbors, keyOf }
}

// Connected components of a walk graph (either key form), largest first.
export function graphComponents(graph) {
  const components = []
  const seen = new Set()
  for (const [startKey, start] of graph.nodes) {
    if (seen.has(startKey)) continue
    seen.add(startKey)
    const stack = [start]
    const comp = { size: 0, sample: start, floors: new Set() }
    while (stack.length) {
      const cur = stack.pop()
      comp.size++
      comp.floors.add(cur.cy)
      for (const [k] of graph.neighbors(cur)) {
        if (seen.has(k)) continue
        seen.add(k)
        stack.push(graph.nodes.get(k))
      }
    }
    components.push({ size: comp.size, sample: comp.sample, floors: [...comp.floors].sort((a, b) => a - b) })
  }
  components.sort((a, b) => b.size - a.size)
  return components
}

// --- light ---------------------------------------------------------------------------

// Estimated illumination per walkable cell on one floor from the lit ceiling
// lamps: each lamp reaches cells within `radius` cells that it has a line of
// sight to (the game's sight rule), with a smooth falloff; contributions add
// and saturate. Dead fixtures emit nothing. A planning estimate of the
// fluorescent coverage, not the renderer's lighting. `level` is keyed by the
// string nodeKey.
export const DARK_LEVEL = 0.12

export function lightField(source, box, cy, { radius = 6 } = {}) {
  const cm = sourceCM(source)
  const level = new Map()
  let lit = 0
  let dead = 0
  const lamps = []
  for (let cz = box.z0 - 1; cz <= box.z1 + 1; cz++) {
    for (let cx = box.x0 - 1; cx <= box.x1 + 1; cx++) {
      const d = source.chunkAt(cx, cy, cz)
      if (!d) continue
      for (const l of d.lamps) {
        const inside = cx >= box.x0 && cx <= box.x1 && cz >= box.z0 && cz <= box.z1
        if (inside && l.lit) lit++
        else if (inside) dead++
        if (l.lit) lamps.push({ gx: cx * CHUNK + l.lx, gz: cz * CHUNK + l.lz })
      }
    }
  }
  const gx0 = box.x0 * CHUNK
  const gz0 = box.z0 * CHUNK
  const gx1 = (box.x1 + 1) * CHUNK - 1
  const gz1 = (box.z1 + 1) * CHUNK - 1
  const r2 = radius * radius
  for (const lamp of lamps) {
    const ox = (lamp.gx + 0.5) * CELL
    const oz = (lamp.gz + 0.5) * CELL
    for (let gz = Math.max(gz0, lamp.gz - radius); gz <= Math.min(gz1, lamp.gz + radius); gz++) {
      for (let gx = Math.max(gx0, lamp.gx - radius); gx <= Math.min(gx1, lamp.gx + radius); gx++) {
        const dx = gx - lamp.gx
        const dz = gz - lamp.gz
        const q = dx * dx + dz * dz
        if (q > r2) continue
        if (q > 0 && !hasLineOfSight(cm, ox, oz, (gx + 0.5) * CELL, (gz + 0.5) * CELL, cy)) continue
        const t = 1 - Math.sqrt(q) / radius
        const k = nodeKey(gx, gz, cy)
        level.set(k, Math.min(1.5, (level.get(k) ?? 0) + t * t))
      }
    }
  }
  let walkable = 0
  let darkCells = 0
  for (let cz = box.z0; cz <= box.z1; cz++) {
    for (let cx = box.x0; cx <= box.x1; cx++) {
      const d = source.chunkAt(cx, cy, cz)
      if (!d) continue
      for (let lz = 0; lz < CHUNK; lz++) {
        for (let lx = 0; lx < CHUNK; lx++) {
          if (!cellWalkable(d, lx, lz)) continue
          walkable++
          if ((level.get(nodeKey(cx * CHUNK + lx, cz * CHUNK + lz, cy)) ?? 0) < DARK_LEVEL) darkCells++
        }
      }
    }
  }
  return {
    cy,
    level,
    radius,
    litLamps: lit,
    deadLamps: dead,
    walkable,
    darkCells,
    darkness: walkable ? darkCells / walkable : 0,
  }
}
