import {
  CELL,
  CELL_CORRIDOR,
  CELL_LOBBY,
  CELL_OPEN,
  CELL_ROOM,
  CELL_STAIR,
  CELL_VOID,
  CHUNK,
  COLUMN_STANDARD,
  FACING,
  FloorPlan,
  PASSAGE_OPEN,
  PASSAGE_WALL,
  PASSAGE_WIDE,
  SPACE_ROLE_LIBRARY,
  SPACE_ROLE_NONE,
  STAIR_E,
  STAIR_W,
  THICK,
  WALL_PLAIN,
  addPiece,
  featureEdge,
  labelFloor,
  rng,
} from '../../tiles/floorPlan.js'
import { FURN_BOOKSHELF } from '../../rooms/catalog.js'
import { PROP_CORNER_SHELF, PROP_LECTERN } from '../../props/index.js'
import { stampStairDescriptors } from '../../structures/stairStamp.js'
import { finiteCtx, markExit, markSpawn } from '../../tiles/kit.js'
import { openOwnedSeam } from '../../tiles/seams.js'
import {
  BLOCK,
  BLOCK_BOUNDS,
  CLOSET_ID,
  CRIMSON,
  FAMILY,
  FLOORS,
  GALLERY_ID,
  HALL_ID,
  MIRROR_OFFSET,
  SALT,
  SHELF_LABEL,
  SPAWN_CELLS,
  STUB_ID,
  TILE,
  VESTIBULE_ID,
  anomalyAt,
  babelFlights,
  babelVoids,
  boundaryFlights,
  exitAnchorGallery,
  exitCellsOf,
  flightAt,
  galleryX,
  galleryZ,
  layoutOf,
  noShaftAt,
  shaftDraft,
  storeyPlan,
} from './geometry.js'

// Library of Babel (docs/liminal_maps/06-library-of-babel.md). Two modes
// share this file's parts (galleries with a railed shaft, shelves on their
// walls and two globes across the shaft, narrow vestibules with lecterns,
// straight-flight stair halls standing in for Borges' spiral stairs):
//
// FINITE MODE (the editor kind, src/editor/kinds/babel.js, FINITE_CTX_BABEL;
// byte-identical: scripts/kinds-digest.mjs --check) is the prototype: an
// offset-brick lattice of identical 6×4 galleries (row j at z = 7j + 1, even
// rows from x = 7i + 6, odd rows from x = 7i + 2), one serpentine chain per
// storey (along rows on one storey, zig-zag columns on the next), one hotel
// catalog volume per 2×2-chunk block whose levels list every shaft as a void,
// a mirror in some vestibules. It is the parts catalogue of the world grammar.
//
// TILE MODE (ctx.mode === 'tile', the babel world family, spec §3.3, §12.5)
// draws ONE world block — a 2×2-chunk tile over its band's five storeys — at
// ctx.origin, from the block-band's procedural layout (geometry.layoutOf: the
// four stair halls, the seam stubs, a packed arrangement of identical 6×4
// galleries in ranges (some back to back), with rare wells and double
// galleries, in the band's own flavour and packing style; every room has a
// shaft) and each storey's links (geometry.storeyPlan: a randomized chain
// over the rooms, dead ends closed into loops, cross links, closets):
//   - every room is walled; vestibules, stubs and closets are walled cells,
//     their doors opened last (wide passages);
//   - the block's volume comes from the planner through ctx.kit.customCatalog
//     (slot 0, voids from geometry.babelVoids, links from babelFlights); the
//     band-boundary flights (geometry.boundaryFlights) go through ctx.kit.stairs
//     on the top storey (up) and the base storey (down), in the hall the two
//     bands share;
//   - the catalog stamp carves the whole block open on every storey, so the
//     plan is written back after the stamps (reapplyBlock: around the shafts
//     and stair halls; the ring cells re-seal) and the owned West/North lines
//     open at geometry.ports;
//   - anomalies (geometry.anomalyAt, one per 40 gallery-storeys), the Crimson
//     Hexagon on the exit gallery (markExit), the spawn in chunk (0,0)'s stair
//     hall (markSpawn), '----' plates, ≤ 6 lit globes per chunk-storey.

const BLOCKS_X = 3 // 2×2-chunk catalog blocks: 3×2 → 11×8 galleries
const BLOCKS_Z = 2
const ANOMALIES = Object.freeze(['dark', 'noShaft', 'empty'])

const W = BLOCKS_X * BLOCK
const H = BLOCKS_Z * BLOCK
// Galleries per row / rows that fit with one mass cell kept on the far edges
// of the compiled range.
const NI = Math.min(Math.floor((W - 13) / 7), Math.floor((W - 9) / 7)) + 1
const NJ = Math.floor((H - 6) / 7) + 1

// The lattice and its markers, for tests and tools.
export const BABEL_LATTICE = Object.freeze({
  floors: FLOORS, NI, NJ, galleryX, galleryZ, crimson: CRIMSON, label: SHELF_LABEL, vestibuleId: VESTIBULE_ID, mirrorOffset: MIRROR_OFFSET,
})

// The kind lab's finite ctx (the editor kind's map, byte-identical).
export const FINITE_CTX_BABEL = finiteCtx({})

// World mode: lit lamps per chunk-storey (spec §12.5).
export const LIT_CAP = 6

// A corner shelf pushed into one corner of its cell (FloorPlan.piece only
// hugs one wall). The prop anchors in its back-left corner: facing S sits in
// the NW corner, E in SW, N in SE, W in NE (objects/furniture/frame.js).
const CORNER_FACING = { NW: FACING.S, SW: FACING.E, SE: FACING.N, NE: FACING.W }
function cornerPiece(map, cy, gx, gz, corner) {
  if (map.cellAt(gx, cy, gz).col) return
  const off = CELL / 2 - THICK / 2 - 1.15 / 2 - 0.06
  const x = (map.cellLocal(gx) + 0.5) * CELL + (corner.includes('E') ? off : -off)
  const z = (map.cellLocal(gz) + 0.5) * CELL + (corner.includes('S') ? off : -off)
  map.addFurniture(gx, cy, gz, { kind: PROP_CORNER_SHELF, x, z, w: 1.15, d: 1.15, facing: CORNER_FACING[corner] })
}

// The serpentine chain of one storey as a set of links: 'e:i,j' joins (i, j)
// to (i+1, j) through a column vestibule, 'v:i,j' joins (i, j) to (i, j+1)
// through a gap-band vestibule. Rows mode runs each row and turns at the row
// ends; columns mode zig-zags down each column and turns along the edge rows.
function chainLinks(NI, NJ, mode, flipX, flipZ) {
  const links = []
  const fi = (i) => (flipX ? NI - 1 - i : i)
  const fj = (j) => (flipZ ? NJ - 1 - j : j)
  const ew = (a, b, j) => links.push(`e:${Math.min(fi(a), fi(b))},${fj(j)}`)
  const ns = (i, a, b) => links.push(`v:${fi(i)},${Math.min(fj(a), fj(b))}`)
  if (mode === 'rows') {
    for (let j = 0; j < NJ; j++) {
      for (let i = 0; i < NI - 1; i++) ew(i, i + 1, j)
      if (j < NJ - 1) ns(j % 2 === 0 ? NI - 1 : 0, j, j + 1)
    }
  } else {
    for (let i = 0; i < NI; i++) {
      for (let j = 0; j < NJ - 1; j++) ns(i, j, j + 1)
      if (i < NI - 1) ew(i, i + 1, i % 2 === 0 ? NJ - 1 : 0)
    }
  }
  return { links: new Set(links), start: { i: fi(0), j: fj(0) } }
}

// Copy a part plan (a vestibule) into the storey's plan; later writes win.
function merge(plan, part) {
  for (const [k, c] of part.cells) plan.cells.set(k, c)
  for (const [k, e] of part.edges) plan.edges.set(k, e)
  plan.lamps.push(...part.lamps)
  plan.cols.push(...part.cols)
  plan.pieces.push(...part.pieces)
}

// Write a storey's plan back after the stamps carved its blocks open:
// compile's cell and edge rules, except on shaft voids (and their rails) and
// inside stair halos, which belong to the stamps.
function reapply(map, plan, cy, halos) {
  const { x0, z0, x1, z1 } = plan.region
  const inHalo = (gx, gz) => halos.find((h) => gx >= h.x0 && gx <= h.x1 && gz >= h.z0 && gz <= h.z1) ?? null
  const kept = (gx, gz) => {
    const k = map.cellAt(gx, cy, gz).kind
    return k === CELL_VOID || k === CELL_STAIR
  }
  for (let gz = z0; gz <= z1; gz++) {
    for (let gx = x0; gx <= x1; gx++) {
      if (kept(gx, gz) || inHalo(gx, gz)) continue
      const c = plan.cells.get(`${gx},${gz}`)
      if (c) map.setCell(gx, cy, gz, { kind: c.kind, spaceId: c.spaceId, role: c.role, col: 0 })
      else map.setCell(gx, cy, gz, { kind: CELL_OPEN, spaceId: 0, role: SPACE_ROLE_NONE, col: COLUMN_STANDARD })
    }
  }
  const setEdge = (axis, gx, gz, ax, az, bx, bz) => {
    const inside = (x, z) => x >= x0 && x <= x1 && z >= z0 && z <= z1
    if ((inside(ax, az) && kept(ax, az)) || (inside(bx, bz) && kept(bx, bz))) return
    const ha = inHalo(ax, az)
    if (ha && ha === inHalo(bx, bz)) return
    const a = plan.has(ax, az)
    const b = plan.has(bx, bz)
    const explicit = plan.edges.get(`${axis}:${gx},${gz}`)
    let wall
    let passage
    let feature = WALL_PLAIN
    if (!a && !b) {
      const owner = axis === 'v' ? gx <= x1 : gz <= z1
      if (!owner) return
      ;[wall, passage] = [0, PASSAGE_OPEN]
    } else if (explicit) ({ wall, passage, feature } = explicit)
    else if (a && b) [wall, passage] = [0, PASSAGE_OPEN]
    else [wall, passage] = [1, PASSAGE_WALL]
    if (wall && feature !== WALL_PLAIN) featureEdge(map, axis, gx, cy, gz, feature)
    else if (axis === 'v') map.setWallV(gx, cy, gz, wall, passage)
    else map.setWallH(gx, cy, gz, wall, passage)
  }
  for (let gz = z0; gz <= z1; gz++) {
    for (let gx = x0; gx <= x1 + 1; gx++) setEdge('v', gx, gz, gx - 1, gz, gx, gz)
  }
  for (let gz = z0; gz <= z1 + 1; gz++) {
    for (let gx = x0; gx <= x1; gx++) setEdge('h', gx, gz, gx, gz - 1, gx, gz)
  }
}

// reapply for one world block (tile mode): the same cell and edge rules,
// written straight into the block's four kept chunks of storey `cy` (the
// kit stamped them, so every cell is authored). Lines x = 28 / z = 28 belong
// to the neighbour blocks (their writes would land on dropped scratch
// chunks) and are skipped; nothing else differs from reapply. Plan cells
// are read once into a grid with a one-cell margin, so the edge rules see
// the neighbour's cells past the block's edges as compile does.
function reapplyBlock(map, plan, cy, halos) {
  const S = BLOCK
  const M = S + 2
  const at = (gx, gz) => (gz + 1) * M + (gx + 1)
  const P = new Array(M * M)
  for (let gz = -1; gz <= S; gz++) for (let gx = -1; gx <= S; gx++) P[at(gx, gz)] = plan.cells.get(`${gx},${gz}`)
  const chunks = [0, 1, 2, 3].map((q) => map.chunkAt(q & 1, cy, q >> 1))
  const chunkOf = (gx, gz) => chunks[(gz >= CHUNK ? 2 : 0) + (gx >= CHUNK ? 1 : 0)]
  const idx = (gx, gz) => (gz % CHUNK) * CHUNK + (gx % CHUNK)
  const halo = new Int8Array(S * S)
  for (const [n, h] of halos.entries()) {
    for (let gz = h.z0; gz <= h.z1; gz++) for (let gx = h.x0; gx <= h.x1; gx++) halo[gz * S + gx] = n + 1
  }
  const kept = new Uint8Array(S * S)
  for (let gz = 0; gz < S; gz++) {
    for (let gx = 0; gx < S; gx++) {
      const k = chunkOf(gx, gz).cellKind[idx(gx, gz)]
      kept[gz * S + gx] = k === CELL_VOID || k === CELL_STAIR ? 1 : 0
    }
  }
  for (let gz = 0; gz < S; gz++) {
    for (let gx = 0; gx < S; gx++) {
      if (kept[gz * S + gx] || halo[gz * S + gx]) continue
      const d = chunkOf(gx, gz)
      const i = idx(gx, gz)
      const c = P[at(gx, gz)]
      d.cellKind[i] = c ? c.kind : CELL_OPEN
      d.spaceRole[i] = c ? c.role : SPACE_ROLE_NONE
      d.spaceId[i] = c ? c.spaceId : 0
      d.setCol(gx % CHUNK, gz % CHUNK, c ? 0 : COLUMN_STANDARD)
    }
  }
  // The plan's explicit edges of the block's own lines, indexed once (the
  // per-edge string lookups dominated this pass).
  const EV = new Array(S * S)
  const EH = new Array(S * S)
  for (const [k, e] of plan.edges) {
    const comma = k.indexOf(',')
    const gx = +k.slice(2, comma)
    const gz = +k.slice(comma + 1)
    if (gx >= 0 && gx < S && gz >= 0 && gz < S) (k.charCodeAt(0) === 118 ? EV : EH)[gz * S + gx] = e // 'v'
  }
  const inside = (x, z) => x >= 0 && x < S && z >= 0 && z < S
  const setEdge = (vertical, gx, gz, ax, az, bx, bz) => {
    if ((inside(ax, az) && kept[az * S + ax]) || (inside(bx, bz) && kept[bz * S + bx])) return
    const ha = inside(ax, az) ? halo[az * S + ax] : 0
    if (ha && ha === (inside(bx, bz) ? halo[bz * S + bx] : 0)) return
    const a = P[at(ax, az)] !== undefined
    const b = P[at(bx, bz)] !== undefined
    let wall = 0
    let passage = PASSAGE_OPEN
    let feature = WALL_PLAIN
    if (a || b) {
      const explicit = (vertical ? EV : EH)[gz * S + gx]
      if (explicit) {
        wall = explicit.wall
        passage = explicit.passage
        feature = explicit.feature
      } else if (!(a && b)) {
        wall = 1
        passage = PASSAGE_WALL
      }
    }
    if (wall && feature !== WALL_PLAIN) featureEdge(map, vertical ? 'v' : 'h', gx, cy, gz, feature)
    else if (vertical) chunkOf(gx, gz).setV(gx % CHUNK, gz % CHUNK, wall, passage)
    else chunkOf(gx, gz).setH(gx % CHUNK, gz % CHUNK, wall, passage)
  }
  for (let gz = 0; gz < S; gz++) {
    for (let gx = 0; gx < S; gx++) {
      setEdge(true, gx, gz, gx - 1, gz, gx, gz)
      setEdge(false, gx, gz, gx, gz - 1, gx, gz)
    }
  }
}

// A column vestibule (link 'e'): in from the west gallery on row 1, out to
// the east one on row 2 (the dog-leg keeps a row of galleries from reading
// as one corridor), the lectern in the niche above.
function columnVestibule(plan, V, z0, spaceId, lectern = true) {
  plan.room({ x0: V, z0, x1: V, z1: z0 + 2 }, {
    spaceId,
    doors: [{ axis: 'v', gx: V, gz: z0 + 1, passage: PASSAGE_WIDE }, { axis: 'v', gx: V + 1, gz: z0 + 2, passage: PASSAGE_WIDE }],
  })
  if (lectern) plan.piece(V, z0, PROP_LECTERN, { wall: 'N' })
}

// A stair vestibule: the whole band under the upper gallery, open to both
// galleries; the stamp lays the flight along its middle row.
function stairVestibule(plan, a, g0, top, bottom) {
  plan.rect({ x0: a, z0: g0, x1: a + 5, z1: g0 + 2 }, CELL_LOBBY)
  plan.edge('h', top, g0, 0, PASSAGE_WIDE)
  plan.edge('h', bottom, g0 + 3, 0, PASSAGE_WIDE)
  plan.lamp(a, g0, true)
}

export function buildBabelTile(map, seed, ctx = FINITE_CTX_BABEL) {
  return ctx.mode === 'tile' ? buildWorldBlock(map, seed, ctx) : buildFinite(map, seed, ctx)
}

// --- finite mode: the kind lab's 3×2-block library ----------------------------------------

function buildFinite(map, seed, ctx) {
  const r = rng(seed, SALT)
  const region = { x0: 0, z0: 0, x1: W - 1, z1: H - 1 }

  // Stair vestibules: one site per chunk, the gap band under gallery
  // (2cx, 2cz), whose flight strip (local x 7..10, z 6) sits inside the
  // chunk. A site serves the slabs of one parity (checkerboard by chunk), so
  // a chunk never holds two flights of consecutive slabs and every block has
  // two flights per slab.
  const parity = r(1) & 1
  const sites = []
  for (let cz = 0; cz < 2 * BLOCKS_Z; cz++) {
    for (let cx = 0; cx < 2 * BLOCKS_X; cx++) {
      const i = 2 * cx
      const j = 2 * cz
      if (i > NI - 1 || j + 1 > NJ - 1) return { error: `babel: no stair site in chunk ${cx},${cz}` }
      sites.push({ cx, cz, i, j, x0: galleryX(i, j), g0: galleryZ(j) + 4 })
    }
  }
  const flights = []
  for (const s of sites) {
    for (let lowerCy = 0; lowerCy < FLOORS - 1; lowerCy++) {
      if ((s.cx + s.cz + lowerCy + parity) % 2) continue
      const dir = r(s.cx * 8 + s.cz, 10 + lowerCy) & 1 ? STAIR_E : STAIR_W
      const xs = [1, 2, 3, 4].map((k) => (dir === STAIR_E ? s.x0 + k : s.x0 + 5 - k))
      const lz = s.g0 + 1 - s.cz * CHUNK
      const at = (k) => ({ lx: xs[k] - s.cx * CHUNK, lz })
      flights.push({
        site: s,
        link: { lowerCy, cx: s.cx, cz: s.cz, stair: { dir, landing: at(0), run: [at(1), at(2)], exit: at(3) } },
      })
    }
  }
  const hallsOn = (cy) => flights.filter((f) => f.link.lowerCy === cy || f.link.lowerCy === cy - 1).map((f) => f.site)

  // The chain axis alternates between storeys, so the stairs weave rows of
  // one storey into columns of the next; each storey picks its own corner.
  const modeOf = (cy) => ((cy + parity) % 2 ? 'columns' : 'rows')
  const chains = Array.from({ length: FLOORS }, (_, cy) => chainLinks(NI, NJ, modeOf(cy), r(cy, 2) & 1, r(cy, 3) & 1))
  const start = chains[0].start

  // Anomalies (doc §10, about one per 40 galleries) and the Crimson
  // Hexagon: one gallery on an upper storey under red lamps, the exit.
  const crimson = {
    cy: 1 + (r(2) % (FLOORS - 1)),
    i: r(3) % NI,
    j: r(4) % NJ,
  }
  // Keep the exit away from the spawn corner.
  if (Math.abs(crimson.i - start.i) < NI / 2) crimson.i = NI - 1 - crimson.i
  const anomalies = new Map() // 'cy:i,j' -> type
  const perFloor = Math.max(1, Math.round((NI * NJ) / 40))
  for (let cy = 0; cy < FLOORS; cy++) {
    for (let n = 0; n < perFloor; n++) {
      const i = r(cy * 16 + n, 5) % NI
      const j = r(cy * 16 + n, 6) % NJ
      let type = ANOMALIES[r(cy * 16 + n, 7) % ANOMALIES.length]
      if (type === 'noShaft' && cy === 0) type = 'dark'
      if (cy === crimson.cy && i === crimson.i && j === crimson.j) continue
      anomalies.set(`${cy}:${i},${j}`, type)
    }
  }

  const plans = []
  const corners = []
  const notes = []
  const mirrors = []
  for (let cy = 0; cy < FLOORS; cy++) {
    const chain = chains[cy]
    const halls = hallsOn(cy)
    const hallAtSite = new Map(halls.map((s) => [`${s.i},${s.j}`, s]))
    const links = new Set(chain.links)
    for (const s of halls) links.add(`v:${s.i},${s.j}`)
    const plan = new FloorPlan(region)
    const cornerList = []
    for (let j = 0; j < NJ; j++) {
      for (let i = 0; i < NI; i++) {
        const x0 = galleryX(i, j)
        const z0 = galleryZ(j)
        const anomaly = anomalies.get(`${cy}:${i},${j}`) ?? null
        const isCrimson = cy === crimson.cy && i === crimson.i && j === crimson.j
        plan.room({ x0, z0, x1: x0 + 5, z1: z0 + 3 }, { spaceId: GALLERY_ID + j * NI + i, role: SPACE_ROLE_LIBRARY })
        // Two lamps across the shaft; the Crimson Hexagon's burn red.
        const lit = anomaly !== 'dark'
        plan.lamp(x0 + 1, z0 + 1, lit, isCrimson ? CRIMSON : null)
        plan.lamp(x0 + 4, z0 + 2, lit, isCrimson ? CRIMSON : null)
        if (anomaly === 'empty') continue
        // Shelves on five of the six "sides": the north wall either side of
        // the shaft, four slanted corners, and the short end walls beside
        // their door cells (east door on row 1, west door on row 2). The
        // north shelves fill the one row above the shaft, so on the cell
        // grid the walkway is a U round it, not a ring (the 0.35 m shelves
        // still leave a body room to pass); moving them to the corners
        // would cut that row off instead.
        plan.piece(x0 + 2, z0, FURN_BOOKSHELF, { wall: 'N' })
        plan.piece(x0 + 3, z0, FURN_BOOKSHELF, { wall: 'N' })
        plan.piece(x0, z0 + 1, FURN_BOOKSHELF, { wall: 'W' })
        plan.piece(x0 + 5, z0 + 2, FURN_BOOKSHELF, { wall: 'E' })
        cornerList.push([x0, z0, 'NW'], [x0 + 5, z0, 'NE'], [x0, z0 + 3, 'SW'], [x0 + 5, z0 + 3, 'SE'])
      }
    }
    let vid = VESTIBULE_ID
    const mirrorPicks = new Set()
    for (const key of [...links].sort()) {
      const [kind, rest] = key.split(':')
      const [i, j] = rest.split(',').map(Number)
      const x0 = galleryX(i, j)
      const z0 = galleryZ(j)
      if (kind === 'e') {
        columnVestibule(plan, x0 + 6, z0, vid++)
        continue
      }
      // Gap-band vestibule on the shared columns a, b = 7i + 6, 7i + 7: the
      // upper gallery's ring column and the lower one's.
      const a = 7 * i + 6
      const b = a + 1
      const g0 = z0 + 4
      const even = j % 2 === 0
      const top = even ? b : a
      const bottom = even ? a : b
      const hall = hallAtSite.get(`${i},${j}`)
      if (hall) {
        stairVestibule(plan, a, g0, top, bottom)
        continue
      }
      // Built on its own small plan so the mirror only scans the vestibule.
      const rect = { x0: a, z0: g0, x1: b, z1: g0 + 2 }
      const part = new FloorPlan(rect)
      part.room(rect, {
        spaceId: vid++,
        doors: [{ axis: 'h', gx: top, gz: g0, passage: PASSAGE_WIDE }, { axis: 'h', gx: bottom, gz: g0 + 3, passage: PASSAGE_WIDE }],
      })
      part.piece(even ? a : b, g0, PROP_LECTERN, { wall: even ? 'W' : 'E' })
      // The mirror: one vestibule per block and storey is reflected across
      // its side wall into the unused band columns, behind glass. The copy
      // is real and opens to the same upper gallery, but its far door is a
      // blank wall: the reflection shows a way on that is not there.
      const block = `${Math.floor(a / BLOCK)},${Math.floor(g0 / BLOCK)}`
      const line = even ? b + 1 : a
      const mx = (gx) => 2 * line - 1 - gx
      const lo = Math.min(mx(a), mx(b))
      // The copy's columns must be free band cells (never a stair vestibule).
      const free = !halls.some((s) => s.g0 === g0 && lo <= s.x0 + 5 && lo + 1 >= s.x0)
      if (free && !mirrorPicks.has(block) && r(cy * 4096 + j * 64 + i, 8) % 3 === 0) {
        mirrorPicks.add(block)
        reflect(part, { line, rect, bottom: mx(bottom), g0 })
        mirrors.push({ cy, i, j, line, g0, x: lo })
      }
      merge(plan, part)
    }
    plan.compile(map, cy)
    plans.push({ plan, halls })
    corners.push(cornerList)
    notes.push(`cy ${cy}: chain along ${modeOf(cy)} · ${halls.length} stair vestibules · ${mirrorPicks.size} mirrors`)
  }

  // One catalog volume per 2×2-chunk block: every gallery's shaft is a void
  // on every storey above the first (a noShaft anomaly closes one storey).
  let volumes = 0
  for (let bz = 0; bz < BLOCKS_Z; bz++) {
    for (let bx = 0; bx < BLOCKS_X; bx++) {
      const levels = []
      for (let cy = 0; cy < FLOORS; cy++) {
        const voids = []
        for (let j = 0; j < NJ; j++) {
          for (let i = 0; i < NI; i++) {
            const x = galleryX(i, j) + 2
            const z = galleryZ(j) + 1
            if (Math.floor(x / BLOCK) !== bx || Math.floor(z / BLOCK) !== bz) continue
            if (anomalies.get(`${cy}:${i},${j}`) === 'noShaft') continue
            voids.push({ x0: x, z0: z, x1: x + 1, z1: z + 1 })
          }
        }
        levels.push(voids)
      }
      const links = flights
        .map((f) => f.link)
        .filter((l) => Math.floor(l.cx / 2) === bx && Math.floor(l.cz / 2) === bz)
      const id = (r(bx, 20 + bz) >>> 0) || 1
      const bounds = { x0: bx * BLOCK + 1, z0: bz * BLOCK + 1, x1: (bx + 1) * BLOCK - 2, z1: (bz + 1) * BLOCK - 2 }
      const draft = shaftDraft({
        id, family: 'hotel', bounds, levels, links,
        district: { x: Math.floor((2 * bx) / 4), z: Math.floor((2 * bz) / 4), size: 4 },
      })
      // The kit analyses, freezes and stamps every participant × storey.
      const res = ctx.kit.customCatalog(map, draft)
      if (res.error) return { error: `babel block ${bx},${bz}: ${res.error}` }
      volumes++
    }
  }

  // Touch-ups: the plans' walls and cells back around the shafts and halos,
  // the level plates, then furniture (the carve dropped compile's pieces).
  for (let cy = 0; cy < FLOORS; cy++) {
    const { plan, halls } = plans[cy]
    const halos = halls.map((s) => ({ x0: s.x0, z0: s.g0, x1: s.x0 + 5, z1: s.g0 + 2 }))
    reapply(map, plan, cy, halos)
    labelFloor(map, cy, SHELF_LABEL)
    for (const p of plan.pieces) addPiece(map, cy, p)
    for (const [gx, gz, corner] of corners[cy]) cornerPiece(map, cy, gx, gz, corner)
  }

  const cg = { x: galleryX(crimson.i, crimson.j) + 1, z: galleryZ(crimson.j) + 1 }
  markExit(map, ctx, { gx: cg.x, gz: cg.z, cy: crimson.cy })
  const spawn = { gx: galleryX(start.i, start.j) + 1, gz: galleryZ(start.j) + 1, cy: 0 }
  const chunks = map.chunks.size
  const anomalyList = [...anomalies].map(([k, t]) => `${t} ${k}`)
  return {
    spawn,
    exit: { gx: cg.x, gz: cg.z, cy: crimson.cy },
    notes: [
      `${NI}×${NJ} galleries × ${FLOORS} storeys · ${volumes} shaft volumes · ${flights.length} flights · ${chunks} chunks`,
      `Crimson Hexagon: gallery ${crimson.i},${crimson.j} on cy ${crimson.cy} (red lamps, the exit)`,
      `look: down and up each railed shaft; the same gallery in every direction; the glass in ${mirrors.length} vestibules shows a copy whose far door is blind`,
      `anomalies: ${anomalyList.join(' · ')}`,
      ...notes,
      'stand-ins: straight catalog flights for spiral stairs, window glass + a real reflected cul-de-sac for the mirror, ceiling lamps for globes, 3.6 m storeys, shafts end at the first and last storey, every level plate reads ----',
    ],
  }
}

// The mirror on a vestibule part plan (see the kind's comment above).
function reflect(part, { line, rect, bottom, g0 }) {
  part.mirror({ axis: 'x', line, from: rect, spaceOffset: MIRROR_OFFSET })
  for (let gz = g0; gz <= g0 + 2; gz++) part.window('v', line, gz)
  part.edge('h', bottom, g0 + 3, 1, PASSAGE_WALL)
}

// --- tile mode: one world block ---------------------------------------------------------------

// Keep a crowded chunk-storey under the lit budget (a Crimson Hexagon's
// second red lamp can push a chunk over) by taking down spare fixtures
// whole, never by leaving a dead one: the second globes of the galleries
// first, then the stair halls' lamps, picked by the dice. A gallery's own
// globe (`keep`: every first globe, both of a red pair) never goes, so no
// gallery outside a 'dark' anomaly is ever unlit and no dead fixture hangs
// anywhere else. `spare` holds the second globes; keys are block-local
// `n,gx,gz`.
function capLitLamps(map, r, cap, keep, spare) {
  const o = map.origin
  for (const d of map.chunks.values()) {
    const lit = d.lamps.filter((l) => l.lit)
    if (lit.length <= cap) continue
    const id = (l) => `${d.cy - o.cy},${(d.cx - o.cx) * CHUNK + l.lx},${(d.cz - o.cz) * CHUNK + l.lz}`
    const tier = (l) => (keep.has(id(l)) ? 2 : spare.has(id(l)) ? 0 : 1)
    const rank = (l) => r(1000 + (d.cy & 255) * 256 + l.lx * 16 + l.lz, (d.cx & 63) * 64 + (d.cz & 63))
    const pool = lit.filter((l) => tier(l) < 2)
    pool.sort((a, b) => tier(a) - tier(b) || rank(a) - rank(b) || a.lx - b.lx || a.lz - b.lz)
    const drop = new Set(pool.slice(0, lit.length - cap))
    d.lamps = d.lamps.filter((l) => !drop.has(l))
  }
}

const S = BLOCK
const DIR4 = [[0, -1, 'N'], [1, 0, 'E'], [0, 1, 'S'], [-1, 0, 'W']]

// Cells (block-local indices z·28 + x) as one walled space: every edge to a
// cell outside the set is a plain wall (doors are opened afterwards).
function walledCells(plan, cells, kind, spaceId, role = SPACE_ROLE_NONE) {
  const set = new Set(cells)
  for (const c of cells) {
    const x = c % S
    const z = Math.floor(c / S)
    plan.open(x, z, kind, spaceId, role)
    for (const [dx, dz] of DIR4) {
      const nx = x + dx
      const nz = z + dz
      if (nx >= 0 && nz >= 0 && nx < S && nz < S && set.has(nz * S + nx)) continue
      if (dx) plan.edge('v', Math.max(x, nx), z, 1, PASSAGE_WALL)
      else plan.edge('h', x, Math.max(z, nz), 1, PASSAGE_WALL)
    }
  }
}

const rectCells = (r) => {
  const out = []
  for (let z = r.z0; z <= r.z1; z++) for (let x = r.x0; x <= r.x1; x++) out.push(z * S + x)
  return out
}

// The two cells an edge separates.
const edgeCells = (e) => (e.axis === 'v' ? [[e.gx - 1, e.gz], [e.gx, e.gz]] : [[e.gx, e.gz - 1], [e.gx, e.gz]])

// The library's shelving of one room (the kind's parts): corner shelves in
// the four corners, flat shelves along the long walls over the shafts and
// along the short walls, never in a door cell or beside one (lecterns stand
// in the vestibule closets). Furniture makes its cell solid, so each
// piece is kept only while the room's free cells (shafts counted solid, as on
// the storeys above the band's base) stay one piece, the doors and `keep`
// cells (the exit) among them.
function furnish(plan, room, isDoor, corners, keep = []) {
  const { x0, z0, x1, z1 } = room
  const w = x1 - x0 + 1
  const d = z1 - z0 + 1
  const id = (x, z) => (z - z0) * w + (x - x0)
  const solid = new Uint8Array(w * d)
  for (const sh of room.shafts) for (let z = sh.z0; z <= sh.z1; z++) for (let x = sh.x0; x <= sh.x1; x++) solid[id(x, z)] = 1
  const must = new Set(keep.filter(([x, z]) => x >= x0 && x <= x1 && z >= z0 && z <= z1).map(([x, z]) => id(x, z)))
  for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) if (isDoor(x, z)) must.add(id(x, z))
  const whole = () => {
    let start = -1
    let free = 0
    for (let i = 0; i < w * d; i++) {
      if (solid[i]) continue
      free++
      if (start < 0) start = i
    }
    if (start < 0) return false
    const seen = new Uint8Array(w * d)
    const stack = [start]
    seen[start] = 1
    let n = 0
    while (stack.length) {
      const i = stack.pop()
      n++
      const x = i % w
      const z = Math.floor(i / w)
      for (const [dx, dz] of DIR4) {
        const nx = x + dx
        const nz = z + dz
        if (nx < 0 || nz < 0 || nx >= w || nz >= d) continue
        const j = nz * w + nx
        if (seen[j] || solid[j]) continue
        seen[j] = 1
        stack.push(j)
      }
    }
    return n === free
  }
  const near = (x, z) => isDoor(x, z) || isDoor(x - 1, z) || isDoor(x + 1, z) || isDoor(x, z - 1) || isDoor(x, z + 1)
  // A cell whose free 8-ring is one arc (a simple point) can go solid
  // without splitting the room; any other is checked by a flood.
  const RING8 = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]]
  const freeAt = (x, z) => x >= 0 && z >= 0 && x < w && z < d && !solid[z * w + x]
  const simple = (x, z) => {
    const ring = RING8.map(([dx, dz]) => freeAt(x + dx, z + dz))
    // Diagonal cells only join their arc through a free edge neighbour.
    for (let q = 1; q < 8; q += 2) if (!ring[q - 1] || !ring[(q + 1) % 8]) ring[q] = false
    let arcs = 0
    let any = false
    for (let q = 0; q < 8; q++) {
      if (ring[q]) any = true
      if (ring[q] && !ring[(q + 7) % 8]) arcs++
    }
    return any && (arcs === 1 || (arcs === 0 && ring.every(Boolean)))
  }
  const tryBlock = (x, z) => {
    const i = id(x, z)
    if (solid[i] || must.has(i)) return false
    const fast = simple(x - x0, z - z0)
    solid[i] = 1
    if (fast || whole()) return true
    solid[i] = 0
    return false
  }
  for (const [x, z, c] of [[x0, z0, 'NW'], [x1, z0, 'NE'], [x0, z1, 'SW'], [x1, z1, 'SE']]) {
    if (!isDoor(x, z) && tryBlock(x, z)) corners.push([x, z, c])
  }
  const shelf = (x, z, wall) => {
    if (!near(x, z) && tryBlock(x, z)) plan.piece(x, z, FURN_BOOKSHELF, { wall })
  }
  const landscape = w >= d
  // Long walls: over the shafts; short walls: all along.
  const overX = (x) => !landscape || room.shafts.some((sh) => x >= sh.x0 && x <= sh.x1)
  const overZ = (z) => landscape || room.shafts.some((sh) => z >= sh.z0 && z <= sh.z1)
  for (let x = x0 + 1; x < x1; x++) {
    if (!overX(x)) continue
    shelf(x, z0, 'N')
    shelf(x, z1, 'S')
  }
  for (let z = z0 + 1; z < z1; z++) {
    if (!overZ(z)) continue
    shelf(x0, z, 'W')
    shelf(x1, z, 'E')
  }
}

function buildWorldBlock(map, seed, ctx) {
  const ws = ctx.worldSeed >>> 0
  const { tx, tz, band } = ctx.key
  const o = ctx.origin
  const key = { tx, tz, band, origin: o, cy0: ctx.cy0, cy1: ctx.cy1 }
  const ox = o.cx * CHUNK // global cell of the block's local (0, 0)
  const oz = o.cz * CHUNK
  const N = ctx.cy1 - ctx.cy0 + 1
  const r = rng(seed, SALT)
  const region = { x0: 0, z0: 0, x1: BLOCK - 1, z1: BLOCK - 1 }
  const L = layoutOf(ws, key)
  const exitG = exitAnchorGallery(ws)
  const exitHere = exitG.tx === tx && exitG.tz === tz && exitG.cy >= ctx.cy0 && exitG.cy <= ctx.cy1
  const halls = L.rooms.filter((room) => room.kind === 'hall')
  const halos = halls.map((h) => ({ x0: h.x0, z0: h.z0, x1: h.x1, z1: h.z1 }))

  const plans = []
  const corners = []
  const notes = []
  const seen = []
  const keepLamps = new Set()
  const spareLamps = new Set()
  let links = 0
  for (let n = 0; n < N; n++) {
    const cy = ctx.cy0 + n
    const P = storeyPlan(ws, key, cy)
    const plan = new FloorPlan(region)
    const cornerList = []
    // The storey's doors: every vestibule's two, every drawn stub's and
    // every closet's.
    const doors = []
    for (const v of P.vests) doors.push(...v.doors)
    for (const s of P.stubs) doors.push(L.stubs[s].door)
    for (const c of P.closets) doors.push(c.door)
    const doorCells = new Set()
    for (const e of doors) for (const [x, z] of edgeCells(e)) doorCells.add(z * S + x)
    const isDoor = (x, z) => x >= 0 && z >= 0 && x < S && z < S && doorCells.has(z * S + x)
    // Rooms: the halls, then the galleries, wells and double galleries.
    for (const room of L.rooms) {
      if (room.kind === 'hall') {
        walledCells(plan, rectCells(room), CELL_LOBBY, HALL_ID + room.n)
        plan.lamp(room.x0, room.z0, true)
        continue
      }
      const anomaly = anomalyAt(ws, key, room.n, cy)
      const isExit = exitHere && room.n === exitG.n && cy === exitG.cy
      const isCrimson = isExit || anomaly === 'crimson'
      if (anomaly) seen.push(`${anomaly} ${room.kind} ${room.n} cy ${cy}`)
      plan.room(room, { spaceId: GALLERY_ID + room.n, role: SPACE_ROLE_LIBRARY })
      // Globes across each shaft. The
      // library's lamp budget (≤ 6 lit per chunk-storey): the first globe is
      // kept, the others are spare; the Crimson Hexagon keeps both, red. The
      // lamps never fail: a fixture is dark only in a 'dark' anomaly room.
      const lit = anomaly !== 'dark'
      const tint = isCrimson ? CRIMSON : null
      const globes = room.shafts.flatMap((s) => [[s.x0 - 1, s.z0], [s.x1 + 1, s.z1]])
      for (const [t, [gx, gz]] of globes.entries()) {
        plan.lamp(gx, gz, lit, tint)
        ;(t === 0 || (isCrimson && t === 1) ? keepLamps : spareLamps).add(`${n},${gx},${gz}`)
      }
      const keep = isExit ? exitCellsOf(exitG).slice(0, 1).map((c) => [c.gx - ox, c.gz - oz]) : []
      if (anomaly !== 'empty') furnish(plan, room, isDoor, cornerList, keep)
    }
    // Vestibules, stubs and closets, walled; then every door.
    for (const [i, v] of P.vests.entries()) walledCells(plan, v.cells, CELL_ROOM, VESTIBULE_ID + i)
    for (const s of P.stubs) walledCells(plan, L.stubs[s].cells, CELL_CORRIDOR, STUB_ID + s)
    for (const [i, c] of P.closets.entries()) {
      walledCells(plan, [c.cell], CELL_ROOM, CLOSET_ID + i)
      if (c.lectern) {
        const x = c.cell % S
        const z = Math.floor(c.cell / S)
        const [ix, iz] = edgeCells(c.door).find(([ex, ez]) => ex !== x || ez !== z)
        // The lectern stands against the closet's back wall, facing the door.
        const back = ix < x ? 'E' : ix > x ? 'W' : iz < z ? 'S' : 'N'
        plan.piece(x, z, PROP_LECTERN, { wall: back })
      }
    }
    for (const e of doors) plan.edge(e.axis, e.gx, e.gz, 0, PASSAGE_WIDE)
    links += P.vests.length
    // No compile: the block's stamp carves all 28×28 cells of every storey
    // and reapplyBlock writes the whole plan back afterwards, so only the
    // lamps (which the carve keeps) are laid now.
    for (const l of plan.lamps) map.setLamp(l.gx, n, l.gz, l.lit, l.tint)
    plans.push(plan)
    corners.push(cornerList)
  }

  // The block-band's volume, looked up from the planner (slot 0): the kit
  // proves the voids, links and level count equal and stamps all N storeys.
  const shift = (v) => ({ x0: v.x0 - ox, z0: v.z0 - oz, x1: v.x1 - ox, z1: v.z1 - oz })
  const draft = shaftDraft({
    id: 1,
    family: FAMILY,
    bounds: { ...BLOCK_BOUNDS },
    levels: babelVoids(ws, key).map((level) => level.map(shift)),
    links: babelFlights(ws, key).map((l) => ({ lowerCy: l.lowerCy - o.cy, cx: l.cx - o.cx, cz: l.cz - o.cz, stair: l.stair })),
    district: { x: tx, z: tz, size: TILE.w },
    bandIndex: band,
    slot: 0,
    baseCy: 0,
  })
  const res = ctx.kit.customCatalog(map, draft)
  if (!res) return { error: `babel block ${tx},${tz}: planner null slot` }
  if (res.error) return { error: `babel block ${tx},${tz}: ${res.error}` }

  // Band-boundary flights: up from the top storey, and down onto the base
  // storey from the band below (the hall both bands share, never a link slot).
  for (const f of boundaryFlights(ws, key)) {
    const d = ctx.kit.stairs(map, { cx: f.cx - o.cx, cy: N - 1, cz: f.cz - o.cz, up: f.stair })
    stampStairDescriptors(d, { up: f.stair })
  }
  for (let lz = 0; lz < TILE.d; lz++) {
    for (let lx = 0; lx < TILE.w; lx++) {
      const stair = flightAt(ws, o.cx + lx, o.cz + lz, ctx.cy0 - 1)
      if (!stair) continue
      const d = ctx.kit.stairs(map, { cx: lx, cy: 0, cz: lz, down: stair })
      stampStairDescriptors(d, { down: stair })
    }
  }

  // Touch-ups: the plans back around the shafts and halls (the ring cells
  // re-seal), the owned seam lines open at the ports, the plates, furniture.
  for (let n = 0; n < N; n++) {
    reapplyBlock(map, plans[n], n, halos)
    openOwnedSeam(map, ctx, n, 'west')
    openOwnedSeam(map, ctx, n, 'north')
    labelFloor(map, n, SHELF_LABEL)
    for (const p of plans[n].pieces) addPiece(map, n, p)
    for (const [gx, gz, corner] of corners[n]) cornerPiece(map, n, gx, gz, corner)
  }
  // No globe hangs over a stair's ceiling opening; the budget holds.
  for (const d of map.chunks.values()) d.lamps = d.lamps.filter((l) => !d.hasCeilHole(l.lx, l.lz))
  capLitLamps(map, r, LIT_CAP, keepLamps, spareLamps)

  // The Crimson Hexagon (the exit) and the world's spawn.
  let exit = null
  if (exitHere) {
    const c = exitCellsOf(exitG)[0]
    exit = markExit(map, ctx, { gx: c.gx - ox, gz: c.gz - oz, cy: exitG.cy - ctx.cy0 })
  }
  let spawn = null
  if (tx === 0 && tz === 0 && ctx.cy0 <= 0 && ctx.cy1 >= 0) {
    spawn = markSpawn(map, ctx, { gx: SPAWN_CELLS[0].lx, gz: SPAWN_CELLS[0].lz, cy: -ctx.cy0 })
  }
  const kinds = {}
  for (const room of L.rooms) kinds[room.kind] = (kinds[room.kind] ?? 0) + 1
  notes.push(
    `block ${tx},${tz} band ${band} (storeys ${ctx.cy0}..${ctx.cy1}): ${L.flavour}, ${L.style}; ` +
      `${Object.entries(kinds).map(([kd, c]) => `${c} ${kd}`).join(', ')}; ${links} vestibules over ${N} storeys`,
    noShaftAt(ws, key) ? 'anomaly: noShaft (the block-band\'s shafts are floored)' : 'shafts open on levels 1..4',
    ...seen.map((s) => `anomaly: ${s}`),
  )
  ctx.notes.push(...notes)
  return { spawn, exit, notes }
}
