import {
  CELL,
  CHUNK,
  FACING,
  PASSAGE_WIDE,
  SPACE_ROLE_BATHROOM,
  SPACE_ROLE_BEDROOM,
  SPACE_ROLE_DINING,
  SPACE_ROLE_KITCHEN,
  SPACE_ROLE_LIVING,
  SPACE_ROLE_OFFICE,
  THICK,
} from '../../tiles/floorPlan.js'
import {
  FURN_ARMCHAIR,
  FURN_BED,
  FURN_CABINET,
  FURN_CHAIR,
  FURN_DESK,
  FURN_NIGHTSTAND,
  FURN_PLANT,
  FURN_SINK,
  FURN_SOFA,
  FURN_TABLE,
  FURN_TUB,
  FURN_TV,
} from '../../rooms/catalog.js'
import { TABLE_D, TABLE_W } from '../../constants.js'
import { PIECE_DIMS } from '../../rooms/furnish.js'
import { roomCells } from '../../tiles/roomOps.js'

// The showroom's parts catalogue (doc 09 §4.2, §4.3, §6): the pieces the
// kind lab (tile.js) and the world's district grammar (district.js) share —
// the vignette roles, the mutation classes, a vignette's layout lifted into an
// item list and pasted into another rect of the same size and front, stacked
// furniture records, and the per-chunk furniture-kind cap that trims whole
// runs. Moved out of tile.js unchanged for the kind lab (front 'S').

export const WARM = 0xffd6a0 // vignette fixtures: a home at dusk inside a daylit store (the record's lampTint)

export const ROLES = Object.freeze([SPACE_ROLE_LIVING, SPACE_ROLE_BEDROOM, SPACE_ROLE_KITCHEN, SPACE_ROLE_DINING, SPACE_ROLE_BATHROOM, SPACE_ROLE_OFFICE])
export const ROLE_NAME = Object.freeze({
  [SPACE_ROLE_LIVING]: 'living', [SPACE_ROLE_BEDROOM]: 'bedroom', [SPACE_ROLE_KITCHEN]: 'kitchen',
  [SPACE_ROLE_DINING]: 'dining', [SPACE_ROLE_BATHROOM]: 'bathroom', [SPACE_ROLE_OFFICE]: 'office',
})
export const SHOWROOM_MUTATIONS = Object.freeze(['missing', 'swapped', 'dark', 'walled'])
// A mutated copy's odd piece: something plausible, never the right thing.
export const SWAP = Object.freeze({ [FURN_BED]: FURN_SOFA, [FURN_SOFA]: FURN_ARMCHAIR, [FURN_TABLE]: FURN_DESK, [FURN_DESK]: FURN_TABLE, [FURN_TV]: FURN_PLANT })

// A rect's open front ('N' | 'S' | 'W' | 'E'): the edges along that side
// (an H line for N/S, a V line for W/E).
export function frontEdges(rect, front) {
  const out = []
  if (front === 'S' || front === 'N') {
    const gz = front === 'S' ? rect.z1 + 1 : rect.z0
    for (let gx = rect.x0; gx <= rect.x1; gx++) out.push({ axis: 'h', gx, gz })
  } else {
    const gx = front === 'E' ? rect.x1 + 1 : rect.x0
    for (let gz = rect.z0; gz <= rect.z1; gz++) out.push({ axis: 'v', gx, gz })
  }
  return out
}

// Open the rect's front WIDE on storey cy (three walls stay).
export function openFrontSide(map, cy, rect, front) {
  for (const e of frontEdges(rect, front)) {
    if (e.axis === 'h') map.setWallH(e.gx, cy, e.gz, 0, PASSAGE_WIDE)
    else map.setWallV(e.gx, cy, e.gz, 0, PASSAGE_WIDE)
  }
}

// A placed room's furniture as offsets from its rect corner.
export function roomItems(map, room) {
  const items = []
  for (const { gx, gz } of roomCells(map, room)) {
    const d = map.chunkAt(map.cellChunk(gx), room.cy, map.cellChunk(gz))
    const lx = map.cellLocal(gx)
    const lz = map.cellLocal(gz)
    for (const f of d.furniture) {
      if (f.lx !== lx || f.lz !== lz) continue
      const rec = { ...f }
      delete rec.lx
      delete rec.lz
      items.push({ dx: gx - room.x0, dz: gz - room.z0, ox: f.x - lx * CELL, oz: f.z - lz * CELL, rec })
    }
  }
  return items
}

// Is item cell (dx, dz) on the rect's open front row?
const onFront = (it, rect, front) =>
  front === 'S' ? it.dz === rect.z1 - rect.z0
    : front === 'N' ? it.dz === 0
      : front === 'E' ? it.dx === rect.x1 - rect.x0
        : it.dx === 0

// The pieces a mutation may pick. A dropped piece must free a cell that joins
// the room: one with an empty neighbour inside the set, or on its open front
// row. A swapped piece must change kind (a plant "swapped" for a plant is no
// mutation at all).
export function oddPool(items, rect, mutation, front = 'S') {
  if (mutation === 'swapped') return items.filter((it) => (SWAP[it.rec.kind] ?? FURN_PLANT) !== it.rec.kind)
  if (mutation !== 'missing') return items
  const cells = new Set(items.map((it) => `${it.dx},${it.dz}`))
  const depth = rect.z1 - rect.z0
  const width = rect.x1 - rect.x0
  const joins = (it) => onFront(it, rect, front) || [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => {
    const x = it.dx + a
    const z = it.dz + b
    return x >= 0 && x <= width && z >= 0 && z <= depth && !cells.has(`${x},${z}`)
  })
  return items.filter(joins)
}

// Unrotated footprint; PIECE_DIMS has no table (the grammar sizes its own).
export const dims = (kind) => (kind === FURN_TABLE ? [TABLE_W, TABLE_D] : PIECE_DIMS[kind] ?? [1, 1])

// Lay a master's furniture into another rect of the same size (and front);
// a mutation drops or swaps the piece `pick` selects.
export function paste(map, cy, items, rect, mutation, pick, front = 'S') {
  const pool = oddPool(items, rect, mutation, front)
  const odd = pool.length ? items.indexOf(pool[pick % pool.length]) : -1
  items.forEach((it, i) => {
    if (mutation === 'missing' && i === odd) return
    const gx = rect.x0 + it.dx
    const gz = rect.z0 + it.dz
    const rec = { ...it.rec, x: map.cellLocal(gx) * CELL + it.ox, z: map.cellLocal(gz) * CELL + it.oz }
    if (mutation === 'swapped' && i === odd) {
      rec.kind = SWAP[rec.kind] ?? FURN_PLANT
      const [w, d] = dims(rec.kind)
      const alongX = rec.facing === FACING.E || rec.facing === FACING.W
      rec.w = alongX ? d : w
      rec.d = alongX ? w : d
      // A master piece hugging a wall (wallHugCentre's 0.06 gap on its
      // facing axis) keeps the hug at the new depth; anything else keeps
      // the master's centre.
      const hug = (depth) => CELL / 2 - THICK / 2 - depth / 2 - 0.06
      const off = (alongX ? it.ox : it.oz) - CELL / 2
      if (Math.abs(Math.abs(off) - hug(alongX ? it.rec.w : it.rec.d)) < 0.02) {
        const shift = Math.sign(off) * hug(d) - off
        if (alongX) rec.x += shift
        else rec.z += shift
      }
    }
    map.addFurniture(gx, cy, gz, rec)
  })
}

// One of several pieces in a cell (addPiece places one per cell): offset
// (dx, dz) metres from the cell centre.
export function put(map, cy, gx, gz, kind, facing, dx, dz) {
  const [w0, d0] = dims(kind)
  const alongX = facing === FACING.E || facing === FACING.W
  map.addFurniture(gx, cy, gz, {
    kind,
    x: (map.cellLocal(gx) + 0.5) * CELL + dx,
    z: (map.cellLocal(gz) + 0.5) * CELL + dz,
    w: alongX ? d0 : w0,
    d: alongX ? w0 : d0,
    facing,
  })
}

// At most `cap` distinct furniture kinds per chunk of storey cy (spec §11.1
// item 9), by construction and run by run. While a chunk would hold more
// kinds (the fixed pieces already on the canvas, the strays, every vignette's
// run list; one slot kept free in the chunk of a 'swapped' odd copy, whose
// odd piece may bring a kind of its own), its rarest accent kind leaves the
// lists of every run that shows it there — all copies of a run lose it alike
// — when no run's freed cell would be cut off from the room's open floor.
// Anchors, departments and strays stay.
export const PROP_KIND_CAP = 14
const ACCENTS = new Set([FURN_PLANT, FURN_NIGHTSTAND, FURN_ARMCHAIR, FURN_CABINET, FURN_CHAIR, FURN_TV, FURN_TUB, FURN_SINK])
export function capRunKinds(map, cy, plain, strays, cap, swappedOdd) {
  const chunkOf = (gx, gz) => map.cellChunk(gx) * 64 + map.cellChunk(gz)
  const fixed = [...strays]
  for (const d of map.chunks.values()) {
    if (d.cy - map.origin.cy !== cy) continue
    const ox = (d.cx - map.origin.cx) * CHUNK
    const oz = (d.cz - map.origin.cz) * CHUNK
    for (const f of d.furniture) fixed.push({ gx: ox + f.lx, gz: oz + f.lz, kind: f.kind })
  }
  const oddChunk = swappedOdd ? chunkOf(swappedOdd.rect.x0, swappedOdd.rect.z0) : null
  const blocked = new Set()
  for (;;) {
    const tally = new Map() // chunk -> kind -> { n, runs, fixed }
    const add = (gx, gz, kind, run) => {
      const c = chunkOf(gx, gz)
      let kinds = tally.get(c)
      if (!kinds) tally.set(c, (kinds = new Map()))
      let t = kinds.get(kind)
      if (!t) kinds.set(kind, (t = { n: 0, runs: new Set(), fixed: false }))
      t.n++
      if (run) t.runs.add(run)
      else t.fixed = true
    }
    for (const p of fixed) add(p.gx, p.gz, p.kind, null)
    for (const v of plain) for (const it of v.run.master.items) add(v.rect.x0 + it.dx, v.rect.z0 + it.dz, it.rec.kind, v.run)
    let dropped = false
    for (const [c, kinds] of [...tally].sort((a, b) => a[0] - b[0])) {
      if (kinds.size <= cap - (c === oddChunk ? 1 : 0)) continue
      const cands = [...kinds]
        .filter(([k, t]) => ACCENTS.has(k) && !t.fixed && !blocked.has(`${c}:${k}`))
        .sort((a, b) => a[1].n - b[1].n || a[0] - b[0])
      for (const [k, t] of cands) {
        const next = [...t.runs].map((run) => [run, dropKind(run.master, k)])
        if (next.some(([, items]) => !items)) {
          blocked.add(`${c}:${k}`)
          continue
        }
        for (const [run, items] of next) run.master.items = items
        dropped = true
        break
      }
      if (dropped) break
    }
    if (!dropped) return
  }
}

// A run's list without `kind`, or null when a freed cell would be cut off:
// every cell the drop empties must join, through empty cells of the room,
// a cell that was empty already (the open front row, the fixture's cell).
function dropKind(master, kind) {
  const { rect, items } = master
  const keep = items.filter((it) => it.rec.kind !== kind)
  if (keep.length === items.length) return items
  const w = rect.x1 - rect.x0 + 1
  const dep = rect.z1 - rect.z0 + 1
  const before = new Set(items.map((it) => it.dz * w + it.dx))
  const after = new Set(keep.map((it) => it.dz * w + it.dx))
  const seen = new Set()
  const stack = []
  for (let i = 0; i < w * dep; i++) {
    if (before.has(i)) continue
    seen.add(i)
    stack.push(i)
  }
  while (stack.length) {
    const i = stack.pop()
    const x = i % w
    const z = (i - x) / w
    for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + a
      const nz = z + b
      if (nx < 0 || nx >= w || nz < 0 || nz >= dep) continue
      const j = nz * w + nx
      if (after.has(j) || seen.has(j)) continue
      seen.add(j)
      stack.push(j)
    }
  }
  for (const i of before) if (!after.has(i) && !seen.has(i)) return null
  return keep
}
