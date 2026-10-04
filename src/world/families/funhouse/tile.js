import {
  CELL,
  CELL_CORRIDOR,
  CELL_LOBBY,
  FACING,
  FloorPlan,
  PASSAGE_DOOR,
  PASSAGE_OPEN,
  PASSAGE_WALL,
  PASSAGE_WIDE,
  SPACE_ROLE_BATHROOM,
  SPACE_ROLE_BEDROOM,
  SPACE_ROLE_DINING,
  SPACE_ROLE_KITCHEN,
  SPACE_ROLE_LAUNDRY,
  SPACE_ROLE_LIBRARY,
  SPACE_ROLE_LIVING,
  SPACE_ROLE_LOUNGE,
  SPACE_ROLE_NONE,
  SPACE_ROLE_OFFICE,
  SPACE_ROLE_STORAGE,
  THICK,
  WALL_PLAIN,
  WALL_TO_FRONT,
  labelFloor,
  rng,
} from '../../tiles/floorPlan.js'
import {
  FURN_ARMCHAIR,
  FURN_BED,
  FURN_BOOKSHELF,
  FURN_CABINET,
  FURN_CHAIR,
  FURN_COUNTER,
  FURN_DESK,
  FURN_FRIDGE,
  FURN_NIGHTSTAND,
  FURN_RACK,
  FURN_SINK,
  FURN_STOVE,
  FURN_TABLE,
  FURN_TUB,
  FURN_TV,
  FURN_WARDROBE,
  FURN_WASHER,
} from '../../rooms/catalog.js'
import { CHAIR_W, CHUNK, TABLE_D, TABLE_W } from '../../constants.js'
import { RNG } from '../../core/rng.js'
import { PROP_ARCADE, PROP_BALL_TRACK, PROP_CCTV, PROP_CHILD_CHAIR, PROP_MASCOT, PROP_PUNCH_BAG } from '../../props/index.js'
import { stairwellPlan } from '../../structures/authored.js'
import { finiteCtx, markExit, markSpawn } from '../../tiles/kit.js'
import { openOwnedSeam } from '../../tiles/seams.js'
import {
  ATTRACTION_MIN,
  F_FIELD,
  F_MASS,
  F_MIDWAY,
  GROUND,
  LIE_CLASSES,
  PLAN_X1,
  RIDE,
  SALT,
  SPAWN_CELLS,
  STUB,
  TILE_CELLS_X,
  TILE_CELLS_Z,
  anomalyAt,
  attractionOf,
  exitCandidatesOf,
  exitTileOf,
  fieldTintOf,
  firstFits,
  lieBudget,
  skeletonOf,
} from './geometry.js'

// --- funhouse (docs/liminal_maps/12-funhouse.md) -------------------------------
//
// One closed pavilion (3×2 chunks) on two storeys: a maze whose walls lie.
// The pavilion is GENERATED from a parts catalogue by a seeded grammar; no
// two pavilions share a layout. Only the elements repeat (booths, bulb
// strings, glass, mirror lines, scene bays, bump doors) — never the plan.
//
// The skeleton (geometry.skeletonOf, pure in the world seed and the
// pavilion index) fixes the FRAME: the pavilion's size and outline, the
// midway's route, the lobby, the booth bands and the field's pieces, the two
// stair cores, the ride loop, the platform and the two walkways. This
// program grows the rest from the tile seed:
//
//   cy 0  the MIDWAY follows the skeleton's route (2 or 3 rows, straight
//         runs at rolled rows joined by jogs, in at the west seam's port
//         rows and out at the east seam's) under a warm bulb string with
//         one live bulb in five, and passes the lobby — a hall across it
//         (a door at its sealed end, WIDE at the other), a rotunda round it
//         or a vestibule beside it (a 2-cell arch), dressed with a barker
//         (the mascot), a ticket counter, a cabinet, and a game cabinet or
//         the ticket seller's monitor.
//         Its BOOTH BANDS (both sides of every run, 2..7 columns each) are
//         booth rows (1..3-wide prize stands with counters and a big plush
//         or a prize shelf, ticket windows with a monitor or a cash
//         cabinet, fortune tellers with a table and an automaton,
//         ball-roll games, bare shells; one slot in five boarded; three
//         neighbouring pairs in four share a side door), 2-wide food stalls,
//         an arcade alcove of cabinets, a plaza round a dead carousel's pole
//         (picnic tables, a strength tester), a fortune tent (never on a
//         one-column band: its second column would be the field, the lobby
//         or the seam), and exactly one attendant booth (CCTV desk); an open
//         alcove joins what each of its columns fronts (the midway or a
//         lobby run over it); where a band reaches the shed's edge the rows
//         behind a unit are a stock room (a cabinet and a rack) or mass. At
//         most MASCOT_CAP mascots a pavilion besides the barker (a plush or
//         automaton past the cap is a shelf or a cabinet). Every piece
//         of the FIELD (the pavilion floor the frame leaves, north and south
//         of the midway) opens onto it at one to three WIDE mouths, and the
//         lobby has a door onto it. The field first takes the attractions on
//         reserved footprints, each rolled in size and placed at a fit drawn
//         from every position that leaves ≥ 1 cell of field round it and
//         every piece whole (the skeleton guarantees the smallest three fit,
//         geometry.firstFits, which the last try takes): a glass
//         maze (4..6 × 4..6, 60–90% of its walls glass), a mirror maze (6
//         wide × 4..6: a 3-wide half reflected across a line of glass by
//         FloorPlan.mirror, carrying at most one lie), the third attraction
//         (a 2×2 level room with its ball track, or a 3×3 black-light room),
//         and — each on its own roll — an Ames room (3×2, one door and one
//         peephole pane) and a distorting-mirror hall (1×5..7, open at both
//         ends, glazed along both sides). The rest of the field is split by
//         a BSP into 2..4 WINGS, each its own maze texture: a unit-cell maze
//         with a rolled corridor bias, a hall maze of open blocks on a
//         2..4 × 2..4 lattice with a rolled phase, or a warren of BSP rooms
//         joined by doors. One spanning tree per piece (randomised Kruskal
//         over the wings' atoms) joins the field; 10–20% of the remaining
//         joints are reopened (doc §4.3 step 2: leaf joints first, more of
//         them while the tree's dead ends are over LEAF_TARGET of its
//         atoms), about
//         a third of the walls left are single glass panes (step 3) — more
//         when the pavilion's whole mirror/glass share would fall under
//         0.24 (doc §12: 0.2–0.4) — and half the free-standing cells of the
//         maze take a mirror pillar. The maze's lamps burn in the
//         pavilion's colour (geometry.fieldTintOf). Then the DRESSING pass
//         (makeDresser) puts a piece round most dead ends (a figure while
//         the cap allows, a game cabinet still glowing, a ball-roll game, a
//         cabinet, a counter), a full-size and a child's chair at the two
//         ends of the Ames room, and — while the storey holds fewer than
//         PROP_FLOOR pieces — more in the corners of the maze's rooms and
//         hall blocks; only where it closes no way (no opening onto another
//         zone, a real wall behind it, its open neighbours still joined
//         round it) and never as a 15th kind in a chunk. Last, unseal()
//         takes out any piece that would leave a cell unreached.
//   cy 1  the dark ride: the skeleton's track (the 2-wide rim of the loop
//         polygon) with bump doors on 3..6 of its straight cross-sections,
//         6..10 scene bays (2×2, outside the loop or inside it, furniture
//         tableaux under UV-purple spots, the track's lamps dead), the
//         load/unload platform with its 4-cell gate, the walkways to both
//         stairs, and BACKSTAGE: every other free cell, each connected
//         piece a dead-end service warren (hall maze, unit maze or rooms)
//         with a single door onto the track, platform or a walkway, a few
//         mirror posts, and racks, costume wardrobes and cabinets in half
//         its rooms; the operator's console (the CCTV desk) by the gate and
//         control cabinets on the platform's back row.
// The route is a cycle: midway → a mouth or the lobby door → the maze → a
// stair → the ride → the other stair → back down.
//
// THE tile program of the funhouse family (spec §3.3, §12.12), wrapped by
// src/editor/kinds/funhouse.js with FINITE_CTX_FUNHOUSE (the kind lab shows a
// procedural sample: the skeleton of "pavilion 0" of the kind's seed). In
// tile mode (ctx.mode === 'tile') the body draws one pavilion of the endless
// chain at ctx.origin (kind storeys 0..1 = world storeys 0..1, kind cell
// x = tile-local x):
//   - the midway runs on through the east mass column (x 41) at the east
//     seam's rows to the next pavilion, and in from the west line (x 0) at
//     the west seam's rows (both hashed per seam, geometry.ports, the
//     owned west line opened with openOwnedSeam); the kind closes it;
//   - the two stair cores go through ctx.kit.stairwell;
//   - the pavilion carries at most ONE anomaly (geometry.anomalyAt, doc 14:
//     none within LIE_FREE pavilions of the spawn and none on the exit
//     pavilion, its chance growing with |tx|, classes rotated along the
//     chain): one of the mirror lies, the ball rolling uphill in the level
//     room, or the animatronic turned toward the track. Every other
//     pavilion draws the honest baseline (an exact reflection, the track
//     flush on the level room's wall, the figure facing its tableau);
//   - the third attraction is hashed per pavilion (geometry.attractionOf);
//   - on the exit pavilion the ride runs one way (doc §4.3 step 6): stair A
//     lands in a stub of its walkway behind a glass pane, the platform and
//     the track are cut at the middle of the gate, so the unload walkway is
//     reached only through the maze, stair B and the full ride loop;
//   - the exit candidates are the unload walkway's cells past the pane
//     (markExit, pure in the seed), the spawn the midway of pavilion 0
//     (markSpawn), and at most 12 lamps burn per chunk-storey.

// The midway's bulb string (the family record's lampTint).
export const BULB = 0xffb060

// The ground storey's dressing (the funhouse pack's games and monitors, the
// arcade's cabinets, the carnival's counters, racks and cabinets; the
// playplace pack's mascot only as the barker and at most MASCOT_CAP more a
// pavilion): PROP_FLOOR pieces at least (9.5 a chunk); what waits at a maze
// dead end, and what fills a maze corner.
const MASCOT_CAP = 2
const PROP_FLOOR = 57
const SURPRISE = [[PROP_MASCOT, 2], [PROP_ARCADE, 2], [PROP_BALL_TRACK, 3], [FURN_CABINET, 1], [FURN_COUNTER, 1]]
const CORNER_PIECES = [[FURN_CABINET, 2], [PROP_ARCADE, 1], [PROP_BALL_TRACK, 2], [FURN_RACK, 1], [FURN_COUNTER, 2]]

// The kind lab's finite ctx.
export const FINITE_CTX_FUNHOUSE = finiteCtx({})

const REGION = { x0: 0, z0: 0, x1: TILE_CELLS_X - 1, z1: TILE_CELLS_Z - 1 }
const X1 = PLAN_X1 // 40: the last plan column west of the mass column x 41

const UV = 0xb070ff // black-light spots in the ride
const MAGENTA = 0xff5ad8 // the glass maze (Level 956's magenta)
const MIRROR_HUES = [[0x5a7dff, 'blue'], [0x50ff8c, 'green'], [0xff4a4a, 'red']] // Level 228

// Tableaux: two pieces against a bay's back wall, and the bay's role.
const SCENES = [
  { name: 'parlour', role: SPACE_ROLE_LIVING, pieces: [FURN_ARMCHAIR, FURN_TV] },
  { name: 'bedroom', role: SPACE_ROLE_BEDROOM, pieces: [FURN_BED, FURN_NIGHTSTAND] },
  { name: 'kitchen', role: SPACE_ROLE_KITCHEN, pieces: [FURN_STOVE, FURN_FRIDGE] },
  { name: 'bathroom', role: SPACE_ROLE_BATHROOM, pieces: [FURN_TUB, FURN_SINK] },
  { name: 'dinner', role: SPACE_ROLE_DINING, pieces: [FURN_TABLE, FURN_CHAIR] },
  { name: 'study', role: SPACE_ROLE_LIBRARY, pieces: [FURN_BOOKSHELF, FURN_ARMCHAIR] },
  { name: 'office', role: SPACE_ROLE_OFFICE, pieces: [FURN_DESK, FURN_CABINET] },
  { name: 'laundry', role: SPACE_ROLE_LAUNDRY, pieces: [FURN_WASHER, FURN_WASHER] },
]
export const FUNHOUSE_LIES = LIE_CLASSES

// Wing textures (the field and the backstage): weights.
const WING_TYPES = [['maze1', 1], ['blocks', 8], ['rooms', 2]]
const BACK_TYPES = [['blocks', 3], ['rooms', 7]]

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const key = (gx, gz) => `${gx},${gz}`
// The edge between two 4-adjacent cells, as FloorPlan keys it.
const edgeOf = (ax, az, bx, bz) => (az === bz ? ['v', Math.max(ax, bx), az] : ['h', ax, Math.max(az, bz)])
const edgeKey = (e) => `${e[0]}:${e[1]},${e[2]}`
const inRect = (r, gx, gz) => gx >= r.x0 && gx <= r.x1 && gz >= r.z0 && gz <= r.z1
const rectCells = (r) => {
  const out = []
  for (let gz = r.z0; gz <= r.z1; gz++) for (let gx = r.x0; gx <= r.x1; gx++) out.push([gx, gz])
  return out
}
const weighted = (rnd, table) => {
  let t = rnd.next() * table.reduce((s, [, w]) => s + w, 0)
  for (const [v, w] of table) if ((t -= w) < 0) return v
  return table[table.length - 1][0]
}

// A perfect maze over `cells` (an ordered list): a growing-tree spanning tree.
// `bias` (0..100) is how often the walk restarts from a random live cell
// rather than the newest — 0 is a recursive backtracker (long corridors, few
// dead ends), 100 Prim-like (bushy). Returns the open edges and the walls
// (every other edge between two maze cells), both in a stable order.
// Panes of a glass or mirror module (doc §4.3 step 3: 60–90% of its walls
// glass): the share of n, rounded but kept inside the band.
const paneCount = (share, n) => Math.min(Math.floor(0.9 * n), Math.max(Math.ceil(0.6 * n), Math.round(share * n)))

function spanningMaze(cells, r, salt, bias) {
  const inside = new Set(cells.map(([x, z]) => key(x, z)))
  const start = cells[r(0, salt) % cells.length]
  const seen = new Set([key(...start)])
  const open = new Set()
  const live = [start]
  let step = 0
  while (live.length) {
    step++
    const i = r(step, salt + 1) % 100 < bias ? r(step, salt + 2) % live.length : live.length - 1
    const [gx, gz] = live[i]
    const next = DIRS.map(([dx, dz]) => [gx + dx, gz + dz]).filter(([x, z]) => inside.has(key(x, z)) && !seen.has(key(x, z)))
    if (!next.length) {
      live.splice(i, 1)
      continue
    }
    const [nx, nz] = next[r(step, salt + 3) % next.length]
    open.add(edgeKey(edgeOf(gx, gz, nx, nz)))
    seen.add(key(nx, nz))
    live.push([nx, nz])
  }
  const walls = []
  for (const [gx, gz] of cells) {
    for (const [nx, nz] of [[gx + 1, gz], [gx, gz + 1]]) {
      const e = edgeOf(gx, gz, nx, nz)
      if (inside.has(key(nx, nz)) && !open.has(edgeKey(e))) walls.push(e)
    }
  }
  return { open, walls, reached: seen.size }
}

// --- the wing grammar (atoms, one spanning tree, loops, panes) -------------------------

// Split `rect` by a BSP into leaves no thinner than `min` (`splits` levels,
// each child splitting again on a coin).
function bsp(rnd, rect, splits, min) {
  const w = rect.x1 - rect.x0 + 1
  const d = rect.z1 - rect.z0 + 1
  if (splits <= 0) return [rect]
  const canX = w >= 2 * min
  const canZ = d >= 2 * min
  if (!canX && !canZ) return [rect]
  const alongX = canX && (!canZ || (w > d * 1.25 ? true : d > w * 1.25 ? false : rnd.chance(0.5)))
  const len = alongX ? w : d
  const cut = Math.max(min, Math.min(len - min, Math.round(len * rnd.range(0.32, 0.68))))
  const [a, b] = alongX
    ? [{ ...rect, x1: rect.x0 + cut - 1 }, { ...rect, x0: rect.x0 + cut }]
    : [{ ...rect, z1: rect.z0 + cut - 1 }, { ...rect, z0: rect.z0 + cut }]
  const more = (r) => bsp(rnd, r, rnd.chance(0.55) ? splits - 1 : 0, min)
  return [...more(a), ...more(b)]
}

// Rooms of a 'rooms' wing: a BSP down to 2..5-cell rooms.
function roomRects(rnd, rect) {
  const out = []
  const split = (r) => {
    const w = r.x1 - r.x0 + 1
    const d = r.z1 - r.z0 + 1
    const big = Math.max(w, d)
    if (big <= 3 || (big <= 6 && rnd.chance(0.55))) return out.push(r)
    const alongX = w > d || (w === d && rnd.chance(0.5))
    const len = alongX ? w : d
    if (len < 4) return out.push(r)
    const cut = rnd.int(Math.min(3, len >> 1), len - Math.min(3, len >> 1))
    if (alongX) {
      split({ ...r, x1: r.x0 + cut - 1 })
      split({ ...r, x0: r.x0 + cut })
    } else {
      split({ ...r, z1: r.z0 + cut - 1 })
      split({ ...r, z0: r.z0 + cut })
    }
  }
  split(rect)
  return out
}

// A wing: its rect, texture and the texture's dials.
function rollWing(rnd, rect, table) {
  const type = weighted(rnd, table)
  const bx = rnd.int(2, 4)
  const bz = rnd.int(2, 4)
  return {
    rect,
    type,
    bx,
    bz,
    ox: rnd.int(0, bx - 1),
    oz: rnd.int(0, bz - 1),
    hBias: rnd.range(-0.45, 0.45),
    rooms: type === 'rooms' ? roomRects(rnd, rect) : null,
  }
}

// Atoms: the units the spanning tree joins — a cell of a unit maze, a
// lattice block of a hall maze, a room of a warren — each split into its
// 4-connected parts. `cells` [[x, z]], `wingOf(x, z)` → wing. Atom maps are
// keyed by ik(x, z).
const ik = (x, z) => z * 64 + x
// The lattice block of coordinate a in a hall-maze wing spanning a0..a1
// (phase o, pitch b); a one-cell sliver the phase leaves at either end
// joins its neighbour block, so the wing's edges are no thin strips.
function blockIdx(a, a0, a1, o, b) {
  const i = Math.floor((a - o) / b)
  if (i === Math.floor((a0 - o) / b) && Math.floor((a0 + 1 - o) / b) !== i && a0 < a1) return i + 1
  if (i === Math.floor((a1 - o) / b) && Math.floor((a1 - 1 - o) / b) !== i && a1 > a0) return i - 1
  return i
}
function buildAtoms(cells, wingOf) {
  const inside = new Set(cells.map(([x, z]) => ik(x, z)))
  const group = new Map()
  for (const [x, z] of cells) {
    const w = wingOf(x, z)
    let g
    if (w.type === 'maze1') g = `c${x},${z}`
    else if (w.type === 'blocks') g = `b${w.id}:${blockIdx(x, w.rect.x0, w.rect.x1, w.ox, w.bx)},${blockIdx(z, w.rect.z0, w.rect.z1, w.oz, w.bz)}`
    else g = `r${w.id}:${w.rooms.findIndex((rr) => inRect(rr, x, z))}`
    let list = group.get(g)
    if (!list) group.set(g, (list = []))
    list.push([x, z])
  }
  const atomOf = new Map()
  const atoms = []
  for (const list of group.values()) {
    const left = new Set(list.map(([x, z]) => ik(x, z)))
    for (const [x0, z0] of list) {
      if (!left.has(ik(x0, z0))) continue
      const wing = wingOf(x0, z0)
      const atom = { id: atoms.length, cells: [], type: wing.type, wing }
      const q = [[x0, z0]]
      left.delete(ik(x0, z0))
      while (q.length) {
        const [x, z] = q.pop()
        atom.cells.push([x, z])
        atomOf.set(ik(x, z), atom.id)
        for (const [dx, dz] of DIRS) {
          const k = ik(x + dx, z + dz)
          if (left.has(k) && inside.has(k)) {
            left.delete(k)
            q.push([x + dx, z + dz])
          }
        }
      }
      atom.cells.sort((a, b) => a[1] - b[1] || a[0] - b[0])
      atoms.push(atom)
    }
  }
  return { atomOf, atoms }
}

// Join the atoms with one spanning tree (randomised Kruskal; a wing's hBias
// favours runs along x or z), reopen `reopenShare` of the other joints, and
// write every remaining joint as walls — `paneRate` of the maze walls as
// single glass panes. Returns the counts and the atom map.
// The field's weave: a third of its spare walls glass (doc §12 mirror/glass
// share 0.2–0.4 per pavilion), reopened joints biased toward the leaves.
const PANE_RATE = 0.35
const LEAF_TARGET = 0.12
function weaveAtoms(plan, rnd, cells, wingOf, { reopenShare = 0.1, paneRate, leafTarget = null, chambers = false }) {
  const { atomOf, atoms } = buildAtoms(cells, wingOf)
  const pairs = new Map()
  for (const [x, z] of cells) {
    const a = atomOf.get(ik(x, z))
    for (const [nx, nz] of [[x + 1, z], [x, z + 1]]) {
      const b = atomOf.get(ik(nx, nz))
      if (b === undefined || b === a) continue
      const pk = a < b ? a * 4096 + b : b * 4096 + a
      if (!pairs.has(pk)) pairs.set(pk, { a: Math.min(a, b), b: Math.max(a, b), edges: [] })
      pairs.get(pk).edges.push(edgeOf(x, z, nx, nz))
    }
  }
  const list = [...pairs.values()]
  for (const p of list) {
    const w = atoms[p.a].wing
    const along = p.edges[0][0] === 'v' ? w.hBias : -w.hBias
    p.w = rnd.next() - along
  }
  list.sort((p, q) => p.w - q.w || p.a - q.a || p.b - q.b)
  const parent = atoms.map((_, i) => i)
  const find = (i) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]]
    return i
  }
  const tree = []
  const rest = []
  for (const p of list) {
    const ra = find(p.a)
    const rb = find(p.b)
    if (ra !== rb) {
      parent[ra] = rb
      tree.push(p)
    } else rest.push(p)
  }
  rnd.shuffle(rest)
  // The reopened joints favour the tree's leaves: a loop through a dead-end
  // atom turns it into a pass-through. With a `leafTarget` the count adapts
  // (doc §4.3 step 2 and §12: 10–20% of the spare joints reopened, dead ends
  // 0.15–0.3): the first 10% go in dice order, each a joint touching a leaf
  // while the leaves' share of the atoms is over the target and one touching
  // none once it is under; then joints touching a leaf are reopened while
  // the share is over the target, never past 20%.
  let reopened = Math.round(reopenShare * rest.length)
  if (leafTarget !== null) {
    const deg = new Uint16Array(atoms.length)
    for (const p of tree) {
      deg[p.a]++
      deg[p.b]++
    }
    const leafy = (p) => (deg[p.a] === 1 ? 1 : 0) + (deg[p.b] === 1 ? 1 : 0)
    for (const p of rest) p.w = rnd.next() - leafy(p)
    rest.sort((p, q) => p.w - q.w || p.a - q.a || p.b - q.b)
    const lo = Math.ceil(0.1 * rest.length)
    const hi = Math.floor(0.2 * rest.length)
    let leaves = 0
    for (let i = 0; i < atoms.length; i++) if (deg[i] === 1) leaves++
    const take = (i) => {
      const [p] = rest.splice(i, 1)
      for (const k of [p.a, p.b]) {
        if (deg[k] === 1) leaves--
        deg[k]++
      }
      rest.splice(reopened++, 0, p)
    }
    // The next joint in dice order that touches a leaf (or, `leaf` false,
    // that touches none); -1 when there is none.
    const next = (leaf) => {
      for (let i = reopened; i < rest.length; i++) if ((leafy(rest[i]) > 0) === leaf) return i
      return -1
    }
    reopened = 0
    while (reopened < lo) {
      const i = next(leaves > leafTarget * atoms.length)
      take(i < 0 ? reopened : i)
    }
    while (reopened < hi && leaves > leafTarget * atoms.length) {
      const i = next(true)
      if (i < 0) break
      take(i)
    }
  }
  let panes = 0
  const opaque = [] // the walls left plain, in dice order
  const join = (p) => {
    const ta = atoms[p.a].type
    const tb = atoms[p.b].type
    if (ta === 'rooms' || tb === 'rooms') {
      const e = p.edges[rnd.int(0, p.edges.length - 1)]
      for (const f of p.edges) if (f !== e) plan.edge(f[0], f[1], f[2], 1, PASSAGE_WALL)
      plan.edge(e[0], e[1], e[2], 0, PASSAGE_DOOR)
    } else if (ta !== 'maze1' && tb !== 'maze1') {
      // Hall blocks: wide open, or (`chambers`) through a gap of a third to
      // a half of their shared side, the rest a wall or a pane.
      const n = p.edges.length
      const k = chambers && n >= 3 ? rnd.int(Math.ceil(n / 3), Math.ceil(n / 2)) : n
      const s0 = rnd.int(0, n - k)
      p.edges.forEach((f, i) => {
        if (i >= s0 && i < s0 + k) plan.edge(f[0], f[1], f[2], 0, PASSAGE_OPEN)
        else if (rnd.next() < paneRate) {
          plan.window(f[0], f[1], f[2])
          panes++
        } else {
          plan.edge(f[0], f[1], f[2], 1, PASSAGE_WALL)
          opaque.push(f)
        }
      })
    } else {
      const e = p.edges[rnd.int(0, p.edges.length - 1)]
      for (const f of p.edges) if (f !== e) plan.edge(f[0], f[1], f[2], 1, PASSAGE_WALL)
      plan.edge(e[0], e[1], e[2], 0, PASSAGE_OPEN)
    }
  }
  for (const p of tree) join(p)
  rest.forEach((p, i) => {
    if (i < reopened) return join(p)
    // paneRate of the walls are glass (in a room wing: its office windows).
    for (const f of p.edges) {
      if (rnd.next() < paneRate) {
        plan.window(f[0], f[1], f[2])
        panes++
      } else {
        plan.edge(f[0], f[1], f[2], 1, PASSAGE_WALL)
        opaque.push(f)
      }
    }
  })
  const components = new Set(atoms.map((_, i) => find(i))).size
  return { atomOf, atoms, pairs: list.length, tree: tree.length, walls: rest.length, reopened, panes, components, opaque }
}

// Mirror pillars (doc §4.2's maze modules, the "forest of mirrors"):
// free-standing mirror-clad columns inside the maze's atoms. A cell may take
// one when all eight of its neighbours are open maze cells (no mass touches
// it, so it stands free), none of its four edges is an opening (tree joints,
// doors and every later mouth or entrance sit on cells next to another
// zone, which are excluded), and its atom stays in one piece without it
// (the in-atom neighbours stay joined round it: a simple point). `share`
// of the eligible cells, in dice order, take a pillar. Returns the cells.
function mirrorPillars(plan, rnd, atoms, atomOf, share) {
  const out = []
  const pillar = new Set()
  const RING = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]]
  for (const atom of atoms) {
    if (atom.type === 'maze1' || atom.cells.length < 4) continue
    const mine = (x, z) => atomOf.get(ik(x, z)) === atom.id && !pillar.has(ik(x, z))
    for (const [x, z] of rnd.shuffle([...atom.cells])) {
      if (!rnd.chance(share)) continue
      // Free-standing: all eight neighbours are maze cells, none a pillar.
      if (!RING.every(([dx, dz]) => atomOf.has(ik(x + dx, z + dz)) && !pillar.has(ik(x + dx, z + dz)))) continue
      // No opening to another atom on its edges.
      const joint = DIRS.some(([dx, dz]) => {
        if (mine(x + dx, z + dz)) return false
        const ex = plan.edges.get(edgeKey(edgeOf(x, z, x + dx, z + dz)))
        return !ex || !ex.wall
      })
      if (joint) continue
      // A simple point: the in-atom ring cells stay one run round it.
      const inRing = RING.map(([dx, dz]) => mine(x + dx, z + dz))
      const fourIn = [1, 3, 5, 7].filter((i) => inRing[i]).length
      if (fourIn === 0) continue
      let runs = 0
      for (let i = 0; i < 8; i++) if (inRing[i] && !inRing[(i + 7) % 8]) runs++
      if (runs > 1 || (runs === 0 && !inRing.every(Boolean))) continue
      // Every in-atom 4-neighbour must lie on that run joined by 4-steps:
      // a diagonal ring cell joins its two orthogonal neighbours only.
      let ok = true
      for (let i = 0; i < 8 && ok; i += 2) {
        if (inRing[i] && !inRing[(i + 1) % 8] && !inRing[(i + 7) % 8]) ok = false
      }
      if (!ok) continue
      pillar.add(ik(x, z))
      plan.column(x, z)
      out.push([x, z])
    }
  }
  return out
}

// Order `items` by a seeded dice roll (stable for a seed).
// Pieces PIECE_DIMS does not size (FloorPlan.piece would store them 1×1, the
// box collision pushes against): their real footprints, unrotated.
const SIZED_DIMS = { [FURN_TABLE]: [TABLE_W, TABLE_D], [FURN_CHAIR]: [CHAIR_W, CHAIR_W] }

// FloorPlan.piece for a SIZED_DIMS kind: queue it on `list` and write it
// after the storey compiles with placeSized (addPiece's rules, real dims).
function sizedPiece(list, gx, gz, kind, { wall = null, facing = FACING.S } = {}) {
  list.push({ gx, gz, kind, front: wall ? WALL_TO_FRONT[wall] : facing, wall })
}

function placeSized(map, cy, { gx, gz, kind, front, wall }) {
  if (map.cellAt(gx, cy, gz).col) return
  const [w0, d0] = SIZED_DIMS[kind]
  const alongX = front === FACING.E || front === FACING.W
  const w = alongX ? d0 : w0
  const d = alongX ? w0 : d0
  let x = (map.cellLocal(gx) + 0.5) * CELL
  let z = (map.cellLocal(gz) + 0.5) * CELL
  if (wall) {
    const off = CELL / 2 - THICK / 2 - (alongX ? w : d) / 2 - 0.06
    if (wall === 'N') z -= off
    if (wall === 'S') z += off
    if (wall === 'W') x -= off
    if (wall === 'E') x += off
  }
  map.addFurniture(gx, cy, gz, { kind, x, z, w, d, facing: front })
}

const shuffled = (items, r, salt) => items.map((it, i) => [r(i, salt), i, it]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[2])

// Wall every edge between two plan cells of different zones that no explicit
// edge already describes (entrances and room walls are set before this).
function sealZones(plan, zone) {
  for (const [k, z] of zone) {
    const [gx, gz] = k.split(',').map(Number)
    for (const [nx, nz] of [[gx + 1, gz], [gx, gz + 1]]) {
      const other = zone.get(key(nx, nz))
      if (other === undefined || other === z) continue
      const e = edgeOf(gx, gz, nx, nz)
      if (!plan.edges.has(edgeKey(e))) plan.edge(e[0], e[1], e[2], 1, PASSAGE_WALL)
    }
  }
}

// 4-connected pieces of a cell-key set.
function pieces(set) {
  const left = new Set(set)
  const out = []
  for (const k of set) {
    if (!left.has(k)) continue
    left.delete(k)
    const comp = []
    const q = [k]
    while (q.length) {
      const c = q.pop()
      comp.push(c)
      const [x, z] = c.split(',').map(Number)
      for (const [dx, dz] of DIRS) {
        const n = key(x + dx, z + dz)
        if (left.has(n)) {
          left.delete(n)
          q.push(n)
        }
      }
    }
    out.push(comp)
  }
  return out
}

export function buildFunhouseTile(map, seed, ctx = FINITE_CTX_FUNHOUSE) {
  const tile = ctx.mode === 'tile'
  const r = rng(seed, SALT)
  const rnd = new RNG(r(0x7a, 0x9e))
  const notes = []
  // Tile mode: this pavilion's place in the chain, its skeleton, its anomaly
  // and its third attraction (pure in the world seed and tx). The finite
  // kind draws "pavilion 0" of its own seed's skeleton, with the kind's
  // single rolled lie, its uphill ball and its turned figure.
  const tx = tile ? ctx.key.tx : 0
  const sk = skeletonOf(tile ? ctx.worldSeed : seed, tx)
  const anomaly = tile ? anomalyAt(ctx.worldSeed, tx) : null
  const blacklight = tile && attractionOf(ctx.worldSeed, tx) === 'blacklight'
  const exitPavilion = tile && tx === exitTileOf(ctx.worldSeed)
  const cores = [sk.stairA.core, sk.stairB.core]
  const LOBBY = sk.lobby
  const SHED = sk.shed

  // --- ground storey: the frame (midway, lobby, booth bands) ---------------------
  // The skeleton's frame grid says what every cell of the ground storey is:
  // the midway (its route, 2..3 rows, in straight runs joined by jogs), the
  // lobby, the booth bands along the runs, the field and the cores.
  const m = sk.mid
  const F = sk.frame
  const fAt = (x, z) => (x < 0 || z < 0 || x >= TILE_CELLS_X || z >= TILE_CELLS_Z ? F_MASS : F[z * TILE_CELLS_X + x])
  const g = new FloorPlan(REGION)
  const zone = new Map() // 'gx,gz' -> zone name (walls go between zones)
  const gSized = [] // tables and chairs, written after compile at real size
  const busy = new Set() // cells holding a piece or a column (no mouth, door or prop there)
  const area = (rect, kind, name, spaceId = 0, role = SPACE_ROLE_NONE) => {
    g.rect(rect, kind, spaceId, role)
    for (const [x, z] of rectCells(rect)) zone.set(key(x, z), name)
  }
  const put = (x, z, kind, opts) => {
    g.piece(x, z, kind, opts)
    busy.add(key(x, z))
  }
  const putSized = (x, z, kind, opts) => {
    sizedPiece(gSized, x, z, kind, opts)
    busy.add(key(x, z))
  }
  area(cores[0], CELL_LOBBY, 'coreA')
  area(cores[1], CELL_LOBBY, 'coreB')
  area(LOBBY, CELL_LOBBY, 'lobby')
  const lastX = tile ? TILE_CELLS_X - 1 : X1
  for (let z = 0; z < TILE_CELLS_Z; z++) {
    for (let x = 0; x <= lastX; x++) {
      if (fAt(x, z) !== F_MIDWAY) continue
      g.open(x, z, CELL_CORRIDOR)
      zone.set(key(x, z), 'midway')
    }
  }
  // The lobby's ways in. A hall or rotunda: the midway runs into it through
  // a door at its sealed end (the doc's lobby seal, §4.3 step 6, which
  // cannot lock in the static engine) and out WIDE at the other. A
  // vestibule: a 2-cell arch off the midway.
  const L = sk.lobby
  if (L.type === 'vestibule') {
    const line = L.side === 'N' ? L.z1 + 1 : L.z0
    for (const x of [L.arch, L.arch + 1]) g.edge('h', x, line, 0, PASSAGE_WIDE)
  } else {
    const ends = [[L.x0, L.x0 - 1], [L.x1 + 1, L.x1 + 1]] // [line, the midway cell beyond]
    const [sealEnd, wideEnd] = L.seal === 'W' ? ends : [ends[1], ends[0]]
    const rowsOn = ([, x]) => {
      const out = []
      for (let z = L.z0; z <= L.z1; z++) if (zone.get(key(x, z)) === 'midway') out.push(z)
      return out
    }
    for (const z of rowsOn(wideEnd)) g.edge('v', wideEnd[0], z, 0, PASSAGE_WIDE)
    const dz = rowsOn(sealEnd)
    if (dz.length) g.edge('v', sealEnd[0], dz[rnd.int(0, dz.length - 1)], 0, PASSAGE_DOOR)
  }
  g.lamp(Math.floor((L.x0 + L.x1) / 2), Math.floor((L.z0 + L.z1) / 2), true, BULB)

  // The booth bands (skeleton.bands): each band is a run of units fronting
  // the midway (or the lobby) on one side of a straight run — prize stands,
  // ticket windows, fortune tellers, ball-roll games, bare shells (one slot
  // in five boarded), food stalls, an arcade alcove of cabinets, a plaza
  // round a dead carousel, a fortune tent, and exactly one attendant booth
  // (CCTV desk) in the pavilion. Where the band reaches the shed's edge the
  // rows behind a unit are a stock room (often) or mass.
  const big = sk.bands.filter((b) => b.depth >= 2 && b.x1 > b.x0)
  const attendantBand = big[rnd.int(0, big.length - 1)]
  const booths = []
  const bandTypes = []
  const wishes = [] // [x, z, kind]: loose pieces the dressing pass places where they close no way
  let carousels = 0
  let arcades = 0
  let attendant = null
  let stock = 0
  let sid = 300
  // Mascots besides the lobby's barker (MASCOT_CAP a pavilion); a booth
  // that would show one past the cap shows `alt` instead.
  let mascots = 0
  const mascotOr = (alt) => {
    if (mascots >= MASCOT_CAP) return alt
    mascots++
    return PROP_MASCOT
  }
  for (const b of sk.bands) {
    const N = b.side === 'N'
    const dir = N ? -1 : 1
    const rowAt = (k) => b.front + dir * k
    const rows = (x0, x1, k0, k1) => ({ x0, x1, z0: Math.min(rowAt(k0), rowAt(k1)), z1: Math.max(rowAt(k0), rowAt(k1)) })
    const frontLine = N ? b.front + 1 : b.front // the h-line between the band and the midway
    const backWall = N ? 'N' : 'S'
    const toBack = N ? FACING.N : FACING.S
    // An open alcove (plaza, arcade) joins whatever its columns front: the
    // midway, or the lobby where a hall or rotunda runs over it.
    const openAlcove = (rect) => {
      for (let x = rect.x0; x <= rect.x1; x++) area({ ...rect, x0: x, x1: x }, CELL_CORRIDOR, zone.get(key(x, rowAt(-1))) === 'lobby' ? 'lobby' : 'midway')
    }
    const front = (x, passage = PASSAGE_WIDE) => ({ axis: 'h', gx: x, gz: frontLine, passage })
    const bd = b.toEdge ? rnd.int(2, Math.min(3, b.depth)) : b.depth // a unit's depth
    let lastStock = null
    // A stock room behind a unit (rows k0.. of the band): its back door
    // never opens onto a piece; neighbours often share a side door.
    const stockBehind = (unit, k0) => {
      if (k0 > b.depth - 1 || !rnd.chance(0.65)) return
      const backRow = rowAt(k0 - 1)
      const doorXs = []
      for (let x = unit.x0; x <= unit.x1; x++) if (!busy.has(key(x, backRow))) doorXs.push(x)
      if (!doorXs.length) return
      const st = rows(unit.x0, unit.x1, k0, b.toEdge && rnd.chance(0.6) ? b.depth - 1 : rnd.int(k0, b.depth - 1))
      const doorLine = N ? st.z1 + 1 : st.z0
      const doorX = rnd.pick(doorXs)
      g.room(st, { spaceId: sid++, role: SPACE_ROLE_STORAGE, doors: [{ axis: 'h', gx: doorX, gz: doorLine, passage: PASSAGE_DOOR }] })
      for (const [x, z] of rectCells(st)) zone.set(key(x, z), `stock${sid}`)
      // Spare stock against the far wall (placed by the dressing pass): a
      // cabinet and, in a wider room, a rack of prizes and spare parts.
      if (st.x1 > st.x0 || st.z1 > st.z0) {
        const [ca, cb] = rnd.chance(0.5) ? [st.x0, st.x1] : [st.x1, st.x0]
        wishes.push([ca, N ? st.z0 : st.z1, FURN_CABINET])
        if (ca !== cb) wishes.push([cb, N ? st.z0 : st.z1, FURN_RACK])
      }
      stock++
      const zlo = lastStock ? Math.max(st.z0, lastStock.z0) : 1
      const zhi = lastStock ? Math.min(st.z1, lastStock.z1) : 0
      if (lastStock && lastStock.x1 + 1 === st.x0 && zlo <= zhi && rnd.chance(0.85)) g.edge('v', st.x0, rnd.int(zlo, zhi), 0, PASSAGE_DOOR)
      lastStock = st
    }
    const unitRoom = (unit, role, doors, name) => {
      g.room(unit, { spaceId: sid++, role, doors })
      for (const [x, z] of rectCells(unit)) zone.set(key(x, z), name)
    }
    // A side door between neighbouring units on v-line x (the operators'
    // way along the row), on a row where neither side holds a piece.
    const sideDoor = (x) => {
      for (let k = 0; k < bd; k++) {
        if (busy.has(key(x - 1, rowAt(k))) || busy.has(key(x, rowAt(k)))) continue
        g.edge('v', x, rowAt(k), 0, PASSAGE_DOOR)
        return
      }
    }
    // Booths 1..3 wide over columns x0..x1.
    const fillBooths = (x0, x1) => {
      let prevEnd = null
      for (let x = x0; x <= x1;) {
        const bw = Math.min(x1 - x + 1, rnd.pick([1, 1, 2, 2, 3]))
        if (rnd.int(0, 4) === 0) {
          prevEnd = null
          x += bw
          continue
        }
        const unit = rows(x, x + bw - 1, 0, bd - 1)
        const kind = rnd.pick(['prize', 'prize', 'ticket', 'fortune', 'games', 'bare'])
        const role = kind === 'fortune' ? SPACE_ROLE_LOUNGE : kind === 'ticket' ? SPACE_ROLE_OFFICE : SPACE_ROLE_STORAGE
        unitRoom(unit, role, rectCells({ ...unit, z0: 0, z1: 0 }).map(([cx]) => front(cx)), `booth${sid}`)
        const back = rowAt(bd - 1)
        const mid = rowAt(bd - 2)
        if (kind === 'prize') {
          // Prize counters along the back; on a wide stand a big plush (the
          // mascot) or a shelf of prizes.
          const plush = bw >= 2 ? x + rnd.int(0, bw - 1) : null
          for (let c = x; c < x + bw; c++) {
            const k = c === plush ? mascotOr(FURN_BOOKSHELF) : FURN_COUNTER
            put(c, back, k, k === PROP_MASCOT ? { facing: WALL_TO_FRONT[backWall] } : { wall: backWall })
          }
        } else if (kind === 'ticket') {
          put(x, back, FURN_COUNTER, { wall: backWall })
          // The ticket seller's monitor (CCTV) or a cash cabinet.
          if (bw >= 2) put(x + 1, back, rnd.chance(0.4) ? PROP_CCTV : FURN_CABINET, { wall: backWall })
          if (bd >= 2) putSized(x, mid, FURN_CHAIR, { facing: toBack })
        } else if (kind === 'fortune') {
          // The fortune teller: a table and her chair, and in a wide booth
          // the automaton in its cabinet (the mascot).
          putSized(x, back, FURN_TABLE, { wall: backWall })
          if (bd >= 2) putSized(x, mid, FURN_CHAIR, { facing: toBack })
          if (bw >= 2) {
            const k = mascotOr(FURN_CABINET)
            put(x + 1, back, k, k === PROP_MASCOT ? { facing: WALL_TO_FRONT[backWall] } : { wall: backWall })
          }
        } else if (kind === 'games') {
          // Ball-roll games along the back wall.
          for (let c = x; c < x + bw; c++) put(c, back, PROP_BALL_TRACK, { wall: backWall })
        }
        booths.push(kind)
        stockBehind(unit, bd)
        if (prevEnd === x - 1 && rnd.chance(0.85)) sideDoor(x)
        prevEnd = unit.x1
        x += bw
      }
    }
    // 2-wide food stalls with WIDE fronts and counters along the back.
    const fillStalls = (x0, x1) => {
      let x = x0
      for (; x + 1 <= x1; x += 2) {
        const unit = rows(x, x + 1, 0, bd - 1)
        unitRoom(unit, SPACE_ROLE_STORAGE, [front(x), front(x + 1)], `booth${sid}`)
        put(x, rowAt(bd - 1), FURN_COUNTER, { wall: backWall })
        put(x + 1, rowAt(bd - 1), rnd.chance(0.7) ? FURN_COUNTER : FURN_FRIDGE, { wall: backWall })
        booths.push('stall')
        if (x > x0 && rnd.chance(0.85)) sideDoor(x)
        stockBehind(unit, bd)
      }
      if (x <= x1) fillBooths(x, x1)
    }
    // The midway widens into a plaza round a dead carousel's pole: picnic
    // tables, a strength tester (the punch bag) and a mascot at its back.
    const fillPlaza = (x0, x1) => {
      const pd = Math.min(b.depth, rnd.int(2, 4))
      const rect = rows(x0, x1, 0, pd - 1)
      openAlcove(rect)
      const back = rowAt(pd - 1)
      const pole = [Math.floor((x0 + x1) / 2), rowAt(1)]
      g.column(pole[0], pole[1])
      busy.add(key(...pole))
      g.lamp(pole[0] + (pole[0] + 1 <= x1 ? 1 : -1), pole[1], rnd.chance(0.6), BULB)
      carousels++
      // (Its pieces wait for the dressing pass, which keeps every cell reachable.)
      // Picnic tables, a strength tester (the punch bag), a game cabinet and
      // the carousel's mascot.
      const kinds = rnd.shuffle([FURN_TABLE, PROP_PUNCH_BAG, PROP_MASCOT, PROP_ARCADE])
      ;[x0, x1].forEach((x, i) => wishes.push([x, back, kinds[i]]))
      if (x1 - x0 >= 4) wishes.push([x0 + 1, back, FURN_CHAIR])
      if (x1 - x0 >= 4) wishes.push([x1 - 1, back, PROP_BALL_TRACK])
      stockBehind(rect, pd)
    }
    // An arcade alcove: cabinets along its back wall, facing the midway.
    const fillArcade = (x0, x1) => {
      const ad = Math.min(b.depth, 2)
      const rect = rows(x0, x1, 0, ad - 1)
      openAlcove(rect)
      for (let x = x0; x <= x1; x++) if (rnd.chance(0.8)) put(x, rowAt(ad - 1), PROP_ARCADE, { wall: backWall })
      g.lamp(Math.floor((x0 + x1) / 2), rowAt(0), rnd.chance(0.6), MAGENTA)
      arcades++
      stockBehind(rect, ad)
    }
    let x0 = b.x0
    let x1 = b.x1
    const west = rnd.chance(0.5)
    const takeTwo = () => {
      const x = west ? x0 : x1 - 1
      if (west) x0 += 2
      else x1 -= 2
      return x
    }
    // (A tent takes two columns: never on a one-column band, whose second
    // column would be the field, the lobby or the seam.)
    let type = weighted(rnd, [['booths', 4], ['stall', 2], ['plaza', b.x1 - b.x0 >= 2 ? 2 : 0], ['arcade', 2], ['tent', b.x1 > b.x0 ? 1 : 0]])
    if (b === attendantBand) {
      // The attendant watches the pavilion on a CCTV desk.
      const x = takeTwo()
      const unit = rows(x, x + 1, 0, Math.min(2, b.depth - 1))
      const ud = unit.z1 - unit.z0 + 1
      unitRoom(unit, SPACE_ROLE_OFFICE, [front(x, PASSAGE_DOOR)], 'attendant')
      g.lamp(x, Math.floor((unit.z0 + unit.z1) / 2), true)
      const back = rowAt(ud - 1)
      put(x + 1, back, PROP_CCTV, { wall: backWall })
      putSized(x + 1, rowAt(ud - 2), FURN_CHAIR, { facing: toBack })
      attendant = { ...unit, cctv: [x + 1, back] }
      stockBehind(unit, ud)
      if (type === 'tent' || type === 'plaza') type = 'booths'
    } else if (type === 'tent') {
      // A fortune teller's tent: 2×2, one door, her table, chair and crystal-ball automaton.
      const x = takeTwo()
      const unit = rows(x, x + 1, 0, 1)
      unitRoom(unit, SPACE_ROLE_LOUNGE, [front(x + rnd.int(0, 1), PASSAGE_DOOR)], `booth${sid}`)
      putSized(x, rowAt(1), FURN_TABLE, { wall: backWall })
      const k = mascotOr(FURN_CABINET)
      put(x + 1, rowAt(1), k, k === PROP_MASCOT ? { facing: WALL_TO_FRONT[backWall] } : { wall: backWall })
      booths.push('fortune')
      stockBehind(unit, 2)
      type = rnd.chance(0.5) ? 'booths' : 'stall'
    }
    bandTypes.push(`${b.side}${b.x0}-${b.x1}:${type}`)
    if (x0 > x1) continue
    if (type === 'plaza' && x1 - x0 >= 2) fillPlaza(x0, x1)
    else if (type === 'arcade') fillArcade(x0, x1)
    else if (type === 'stall') fillStalls(x0, x1)
    else fillBooths(x0, x1)
  }

  // The bulb string over the midway: one live bulb in five — and on the
  // spawn's pavilion the bulb over the spawn always burns (the run starts
  // in light).
  const bulbOffset = rnd.int(0, 4)
  const spawnHere = !tile || tx === 0
  let spawnBulb = null
  let bulbs = 0
  const bulbCols = []
  for (let x = 1; x <= X1; x++) if (sk.midLo[x] >= 0 && x % 2 === SPAWN_CELLS[0].gx % 2) bulbCols.push(x)
  bulbCols.forEach((x, i) => {
    const overSpawn = spawnHere && x === SPAWN_CELLS[0].gx
    const lit = i % 5 === bulbOffset || overSpawn
    let z = overSpawn ? m : Math.min(sk.midHi[x], sk.midLo[x] + (i % 2))
    if (busy.has(key(x, z)) || zone.get(key(x, z)) !== 'midway') z = sk.midLo[x]
    if (zone.get(key(x, z)) !== 'midway') return
    g.lamp(x, z, lit, BULB)
    if (overSpawn) spawnBulb = { x, z }
    if (lit) bulbs++
  })

  // --- ground storey: the pavilion field --------------------------------------
  // Field cells: the frame's field (one to four pieces, each touching the
  // midway).
  const doorCells = [sk.stairA.door, sk.stairB.door].map((d) => key(d.x, d.z))
  const fieldAll = new Set()
  for (let z = SHED.z0; z <= SHED.z1; z++) for (let x = SHED.x0; x <= Math.min(SHED.x1, X1); x++) if (fAt(x, z) === F_FIELD) fieldAll.add(key(x, z))
  // Attractions: rolled sizes, placed anywhere that keeps a cell of field
  // round them and every piece of the field whole.
  const reserved = []
  const GW = TILE_CELLS_X
  const fieldGrid = new Uint8Array(GW * TILE_CELLS_Z)
  for (const k of fieldAll) {
    const [x, z] = k.split(',').map(Number)
    fieldGrid[z * GW + x] = 1
  }
  const doorIdx = [sk.stairA.door, sk.stairB.door].map((d) => d.z * GW + d.x)
  const queue = new Int32Array(GW * TILE_CELLS_Z)
  const piecesOf = (blocked) => {
    const open = fieldGrid.slice()
    for (const b of blocked) for (let z = b.z0; z <= b.z1; z++) for (let x = b.x0; x <= b.x1; x++) open[z * GW + x] = 0
    if (doorIdx.some((i) => !open[i])) return -1
    let comps = 0
    for (let s = 0; s < open.length; s++) {
      if (open[s] !== 1) continue
      comps++
      let n = 1
      queue[0] = s
      open[s] = 2
      for (let h = 0; h < n; h++) {
        const c = queue[h]
        for (const d of [1, -1, GW, -GW]) {
          const q = c + d
          if (q >= 0 && q < open.length && open[q] === 1) {
            open[q] = 2
            queue[n++] = q
          }
        }
      }
    }
    return comps
  }
  // Every position that fits is listed (the field can be a few narrow
  // strips round the midway's jogs), then tried in dice order. The
  // attraction and the ring round it lie in the field, clear of the stair
  // doors and of the attractions already placed (a summed-area table over
  // the free field cells).
  const SW = GW + 1
  const sat = new Int32Array(SW * (TILE_CELLS_Z + 1))
  const place = (w, d) => {
    const free = fieldGrid.slice()
    for (const i of doorIdx) free[i] = 0
    for (const rr of reserved) for (let z = rr.z0; z <= rr.z1; z++) for (let x = rr.x0; x <= rr.x1; x++) free[z * GW + x] = 0
    for (let z = 0; z < TILE_CELLS_Z; z++) {
      for (let x = 0; x < GW; x++) sat[(z + 1) * SW + x + 1] = free[z * GW + x] + sat[z * SW + x + 1] + sat[(z + 1) * SW + x] - sat[z * SW + x]
    }
    const sum = (x0, z0, x1, z1) => sat[(z1 + 1) * SW + x1 + 1] - sat[z0 * SW + x1 + 1] - sat[(z1 + 1) * SW + x0] + sat[z0 * SW + x0]
    const fits = []
    for (let z0 = SHED.z0 + 1; z0 <= SHED.z1 - d; z0++) {
      for (let x0 = SHED.x0 + 1; x0 <= SHED.x1 - w; x0++) {
        if (sum(x0 - 1, z0 - 1, x0 + w, z0 + d) === (w + 2) * (d + 2)) fits.push({ x0, z0, x1: x0 + w - 1, z1: z0 + d - 1 })
      }
    }
    for (const rect of rnd.shuffle(fits).slice(0, 40)) {
      if (piecesOf([...reserved, rect]) !== sk.fieldPieces) continue
      reserved.push(rect)
      return rect
    }
    return null
  }
  // The three attractions by dice (a few tries, each from scratch); the
  // last takes the first fit of each at its smallest, which the skeleton
  // guarantees (geometry.firstFits).
  const tiltW = blacklight ? 3 : 2
  let MIRROR = null
  let GLASS = null
  let TILT = null
  for (let t = 0; t < 4 && !TILT; t++) {
    reserved.length = 0
    MIRROR = place(6, rnd.int(4, 6))
    GLASS = MIRROR && place(rnd.int(4, 6), rnd.int(4, 6))
    TILT = GLASS && place(tiltW, tiltW)
  }
  if (!TILT) {
    reserved.length = 0
    const free = fieldGrid.slice()
    for (const i of doorIdx) free[i] = 0
    const fit = firstFits(free, [ATTRACTION_MIN[0], ATTRACTION_MIN[1], [tiltW, tiltW]], SHED.x0, SHED.z0, SHED.x1, SHED.z1)
    if (fit) reserved.push(...fit)
    ;[MIRROR, GLASS, TILT] = fit ?? [null, null, null]
  }
  if (!MIRROR || !GLASS || !TILT) return { error: 'funhouse: no room for the attractions' }
  const amesW = rnd.chance(0.5) ? [3, 2] : [2, 3]
  const AMES = rnd.chance(0.55) ? place(...amesW) : null
  const hallLen = rnd.int(5, 7)
  const HALL = rnd.chance(0.55) ? (rnd.chance(0.5) ? place(hallLen, 1) : place(1, hallLen)) : null

  // The field proper: what the attractions leave.
  const fieldCells = []
  for (const k of fieldAll) {
    const [x, z] = k.split(',').map(Number)
    if (reserved.some((rr) => inRect(rr, x, z))) continue
    fieldCells.push([x, z])
  }
  fieldCells.sort((a, b) => a[1] - b[1] || a[0] - b[0])
  for (const [x, z] of fieldCells) {
    g.open(x, z, CELL_CORRIDOR)
    zone.set(key(x, z), 'maze')
  }
  // Wings: a BSP of the shed, each leaf its own texture.
  const wingRects = bsp(rnd, { x0: SHED.x0, z0: SHED.z0, x1: SHED.x1, z1: SHED.z1 }, rnd.int(1, 2), 6)
  const wings = wingRects.map((rect, id) => ({ ...rollWing(rnd, rect, WING_TYPES), id }))
  const wingOf = (x, z) => wings.find((w) => inRect(w.rect, x, z))
  const weave = weaveAtoms(g, rnd, fieldCells, wingOf, { paneRate: PANE_RATE, leafTarget: LEAF_TARGET, chambers: true })
  const reopenShare = weave.walls ? weave.reopened / weave.walls : 0
  const pillars = mirrorPillars(g, rnd, weave.atoms, weave.atomOf, 0.5)
  const pillarAt = new Set(pillars.map(([x, z]) => key(x, z)))
  for (const k of pillarAt) busy.add(k)
  if (weave.components !== sk.fieldPieces) return { error: `funhouse: the field split into ${weave.components} pieces (frame ${sk.fieldPieces})` }
  // Lamps: one over every atom of four cells or more (a room, a hall
  // block), on a rolled 4-cell lattice in the unit maze; two in three work.
  const mazeTint = fieldTintOf(tile ? ctx.worldSeed : seed, tx)
  const lox = rnd.int(0, 3)
  const loz = rnd.int(0, 3)
  for (const atom of weave.atoms) {
    const spots = atom.type === 'maze1'
      ? atom.cells.filter(([x, z]) => (x + lox) % 4 === 0 && (z + loz) % 4 === 0)
      : atom.cells.length >= 4 ? [atom.cells[rnd.int(0, atom.cells.length - 1)]] : []
    for (const [x, z] of spots) if (!pillarAt.has(key(x, z))) g.lamp(x, z, rnd.int(0, 2) !== 0, mazeTint)
  }

  // Ways in: every piece of the field opens onto the midway at one to three
  // 2-wide mouths (a single door where the piece meets it by one cell), and
  // the lobby has a door onto the field.
  const pieceOf = new Map()
  {
    let id = 0
    for (const [x0, z0] of fieldCells) {
      if (pieceOf.has(key(x0, z0))) continue
      const q = [[x0, z0]]
      pieceOf.set(key(x0, z0), id)
      while (q.length) {
        const [x, z] = q.pop()
        for (const [dx, dz] of DIRS) {
          const k = key(x + dx, z + dz)
          if (zone.get(k) === 'maze' && !pieceOf.has(k)) {
            pieceOf.set(k, id)
            q.push([x + dx, z + dz])
          }
        }
      }
      id++
    }
  }
  const onMidway = (x, z, dx, dz) => zone.get(key(x + dx, z + dz)) === 'midway' && !busy.has(key(x + dx, z + dz)) && !busy.has(key(x, z))
  const mouthCands = new Map() // piece -> [{cells, edges, wide}]
  for (const [x, z] of fieldCells) {
    for (const [dx, dz] of DIRS) {
      if (!onMidway(x, z, dx, dz)) continue
      // The pair: the next cell along the facade, facing the midway the same way.
      const [ax, az] = dx === 0 ? [x + 1, z] : [x, z + 1]
      const pair = zone.get(key(ax, az)) === 'maze' && pieceOf.get(key(ax, az)) === pieceOf.get(key(x, z)) && onMidway(ax, az, dx, dz)
      const cells = pair ? [[x, z], [ax, az]] : [[x, z]]
      const p = pieceOf.get(key(x, z))
      if (!mouthCands.has(p)) mouthCands.set(p, [])
      mouthCands.get(p).push({ cells, edges: cells.map(([cx, cz]) => edgeOf(cx, cz, cx + dx, cz + dz)), wide: pair })
    }
  }
  const mouths = []
  for (const [p, cands] of [...mouthCands].sort((a, b) => a[0] - b[0])) {
    const want = rnd.int(1, cands.length > 24 ? 3 : 2)
    const pool = rnd.shuffle(cands.filter((c) => c.wide)).concat(rnd.shuffle(cands.filter((c) => !c.wide)))
    let got = 0
    for (const c of pool) {
      if (got >= want) break
      if (got && !c.wide) break
      const [cx, cz] = c.cells[0]
      if (mouths.some((mo) => mo.p === p && Math.abs(mo.x - cx) + Math.abs(mo.z - cz) < 6)) continue
      for (const e of c.edges) g.edge(e[0], e[1], e[2], 0, c.wide ? PASSAGE_WIDE : PASSAGE_DOOR)
      mouths.push({ p, x: cx, z: cz, wide: c.wide })
      got++
    }
  }
  if (new Set(mouths.map((mo) => mo.p)).size !== sk.fieldPieces) return { error: 'funhouse: a field piece has no mouth' }
  const lobbyDoors = []
  for (let z = L.z0; z <= L.z1; z++) {
    for (let x = L.x0; x <= L.x1; x++) {
      for (const [dx, dz] of DIRS) if (zone.get(key(x + dx, z + dz)) === 'maze') lobbyDoors.push(edgeOf(x, z, x + dx, z + dz))
    }
  }
  const lobbyDoor = lobbyDoors.length ? lobbyDoors[rnd.int(0, lobbyDoors.length - 1)] : null
  if (lobbyDoor) g.edge(lobbyDoor[0], lobbyDoor[1], lobbyDoor[2], 0, PASSAGE_DOOR)

  // Glass maze: its own perfect maze, 60–90% of the walls glass; two ways in.
  const glassCells = rectCells(GLASS)
  for (const [x, z] of glassCells) {
    g.open(x, z, CELL_CORRIDOR)
    zone.set(key(x, z), 'glass')
  }
  const gm = spanningMaze(glassCells, r, 0x200, 50)
  const glassShare = 0.6 + (r(10, 0x45) % 31) / 100
  const glassOrder = shuffled(gm.walls, r, 0x46)
  const glassPanes = paneCount(glassShare, glassOrder.length)
  glassOrder.forEach((e, i) => {
    if (i < glassPanes) g.window(e[0], e[1], e[2])
    else g.edge(e[0], e[1], e[2], 1, PASSAGE_WALL)
  })
  const gd = GLASS.z1 - GLASS.z0 + 1
  g.edge('v', GLASS.x0, GLASS.z0 + (r(11, 0x45) % gd), 0, PASSAGE_OPEN)
  g.edge('v', GLASS.x1 + 1, GLASS.z0 + (r(12, 0x45) % gd), 0, PASSAGE_OPEN)
  g.lamp(GLASS.x0 + 1, GLASS.z0 + 1, true, MAGENTA)
  g.lamp(GLASS.x1 - 1, GLASS.z1 - 1, true, MAGENTA)

  // Mirror maze: build the west half, glaze the mirror line, reflect.
  const line = MIRROR.x0 + 3
  const HALF = { x0: MIRROR.x0, z0: MIRROR.z0, x1: line - 1, z1: MIRROR.z1 }
  const md = MIRROR.z1 - MIRROR.z0 + 1
  const halfCells = rectCells(HALF)
  for (const [x, z] of rectCells(MIRROR)) zone.set(key(x, z), 'mirror')
  for (const [x, z] of halfCells) g.open(x, z, CELL_CORRIDOR)
  const hm = spanningMaze(halfCells, r, 0x300, 50)
  const mirrorShare = 0.6 + (r(13, 0x47) % 31) / 100
  const halfOrder = shuffled(hm.walls, r, 0x48)
  const halfPanes = paneCount(mirrorShare, halfOrder.length)
  halfOrder.forEach((e, i) => {
    if (i < halfPanes) g.window(e[0], e[1], e[2])
    else g.edge(e[0], e[1], e[2], 1, PASSAGE_WALL)
  })
  for (let z = MIRROR.z0; z <= MIRROR.z1; z++) g.window('v', line, z)
  const entryZ = MIRROR.z0 + (r(14, 0x47) % md)
  g.edge('v', MIRROR.x0, entryZ, 0, PASSAGE_OPEN)
  const [hue, hueName] = MIRROR_HUES[r(15, 0x47) % MIRROR_HUES.length]
  const lampAt = halfCells[r(16, 0x47) % halfCells.length]
  g.lamp(lampAt[0], lampAt[1], true, hue)
  const reflected = g.mirror({ axis: 'x', line, from: HALF })
  const rx = (gx) => 2 * line - 1 - gx
  // One lie per reflection (doc §4.3 step 4): a pane missing from the
  // reflection, its lamp dead, or a figure standing only in the reflection.
  // Tile mode: only when the pavilion's one anomaly is a mirror lie; the
  // reflection is otherwise exact.
  const lies = tile ? (LIE_CLASSES.includes(anomaly) ? [anomaly] : []) : [FUNHOUSE_LIES[r(17, 0x49) % FUNHOUSE_LIES.length]]
  const liesAtCells = []
  for (const lie of lies) {
    let lieAt
    if (lie === 'panel') {
      const e = hm.walls[r(18, 0x49) % hm.walls.length]
      const m = e[0] === 'v' ? ['v', 2 * line - e[1], e[2]] : ['h', rx(e[1]), e[2]]
      g.edge(m[0], m[1], m[2], 0, PASSAGE_OPEN)
      lieAt = [m[1], m[2], `${m[0]}-edge`]
    } else if (lie === 'lamp') {
      const l = g.lamps.find((lp) => lp.gx === rx(lampAt[0]) && lp.gz === lampAt[1])
      l.lit = false
      lieAt = [l.gx, l.gz]
    } else {
      // A leaf of the half's tree (never its entrance), so blocking it in the
      // reflection cuts nothing off.
      const degree = (gx, gz) => DIRS.filter(([dx, dz]) => {
        const nx = gx + dx
        const nz = gz + dz
        return inRect(HALF, nx, nz) && hm.open.has(edgeKey(edgeOf(gx, gz, nx, nz)))
      }).length
      const leaves = halfCells.filter(([x, z]) => degree(x, z) === 1 && !(x === MIRROR.x0 && z === entryZ))
      const [lx, lz] = leaves[r(19, 0x49) % leaves.length]
      g.piece(rx(lx), lz, PROP_MASCOT, { facing: FACING.W })
      lieAt = [rx(lx), lz]
    }
    liesAtCells.push([lie, lieAt])
  }

  // The tilted house's stand-in: a level room where the ball track rolls
  // uphill (doc §10 anomaly 5). Door on its west wall, track in the far cell.
  // Tile mode: the track sits flush on the east wall (the ball runs down,
  // the baseline) unless the pavilion's anomaly is 'uphill', which turns it
  // end-on to the wall; or the slot is a black-light room (UV spots, a dead
  // arcade cabinet; UV paint is deferred with S4).
  const tiltDoorZ = TILT.z0 + (r(20, 0x4a) % 2)
  if (blacklight) {
    g.room(TILT, { spaceId: 280, role: SPACE_ROLE_LOUNGE, doors: [{ axis: 'v', gx: TILT.x0, gz: tiltDoorZ }] })
    g.lamp(TILT.x0 + 1, TILT.z0, true, UV)
    g.lamp(TILT.x0 + 1, TILT.z1, r(24, 0x4a) % 3 !== 0, UV)
    g.piece(TILT.x1, TILT.z0 + 1, PROP_ARCADE, { wall: 'E' })
  } else {
    g.room(TILT, { spaceId: 280, role: SPACE_ROLE_LOUNGE, doors: [{ axis: 'v', gx: TILT.x0, gz: tiltDoorZ }], lamp: true })
    const trackZ = tiltDoorZ === TILT.z0 ? TILT.z1 : TILT.z0
    if (!tile || anomaly !== 'uphill') g.piece(TILT.x1, trackZ, PROP_BALL_TRACK, { wall: 'E' })
    else g.piece(TILT.x1, trackZ, PROP_BALL_TRACK, { facing: trackZ === TILT.z0 ? FACING.S : FACING.N })
  }
  for (const [x, z] of rectCells(TILT)) zone.set(key(x, z), 'tilt')

  // The Ames room (3×2): one door and one peephole pane on two other sides.
  if (AMES) {
    const sides = rnd.shuffle(['N', 'S', 'E', 'W'])
    const sideEdge = (s) => {
      if (s === 'N' || s === 'S') return ['h', rnd.int(AMES.x0, AMES.x1), s === 'N' ? AMES.z0 : AMES.z1 + 1]
      return ['v', s === 'W' ? AMES.x0 : AMES.x1 + 1, rnd.int(AMES.z0, AMES.z1)]
    }
    const door = sideEdge(sides[0])
    const peep = sideEdge(sides[1])
    g.room(AMES, { spaceId: 281, role: SPACE_ROLE_LOUNGE, doors: [{ axis: door[0], gx: door[1], gz: door[2] }], lamp: true })
    g.window(peep[0], peep[1], peep[2])
    for (const [x, z] of rectCells(AMES)) zone.set(key(x, z), 'ames')
  }
  // The distorting-mirror hall: open at both ends, glazed along both sides.
  if (HALL) {
    const alongX = HALL.x1 > HALL.x0
    for (const [x, z] of rectCells(HALL)) {
      g.open(x, z, CELL_CORRIDOR)
      zone.set(key(x, z), 'hall')
      if (alongX) {
        g.window('h', x, z)
        g.window('h', x, z + 1)
      } else {
        g.window('v', x, z)
        g.window('v', x + 1, z)
      }
    }
    if (alongX) {
      g.edge('v', HALL.x0, HALL.z0, 0, PASSAGE_OPEN)
      g.edge('v', HALL.x1 + 1, HALL.z0, 0, PASSAGE_OPEN)
    } else {
      g.edge('h', HALL.x0, HALL.z0, 0, PASSAGE_OPEN)
      g.edge('h', HALL.x0, HALL.z1 + 1, 0, PASSAGE_OPEN)
    }
    g.lamp(Math.floor((HALL.x0 + HALL.x1) / 2), Math.floor((HALL.z0 + HALL.z1) / 2), true, MAGENTA)
  }

  sealZones(g, zone)

  // --- ground storey: dressing -------------------------------------------------
  // Props go only where they close no way: never on a cell with an opening
  // onto another zone (a mouth, a door, an arch), always against a real
  // wall, and only where the cell's open neighbours stay joined round it.
  // The stair doors (stamped later, over the zone wall) stay clear and open.
  const keepClear = new Set(doorCells)
  const dresser = makeDresser(g, zone, busy, keepClear, gSized)
  const { dress, opensOf } = dresser
  // A mascot (the big plush, the automaton, a figure round a corner) only
  // while the pavilion has fewer than MASCOT_CAP besides the barker.
  const dressMascot = (x, z, alt, corner = false) => {
    if (mascots >= MASCOT_CAP) return dress(x, z, alt, corner)
    if (!dress(x, z, PROP_MASCOT, corner)) return false
    mascots++
    return true
  }
  const dressAny = (x, z, kind, corner = false) => (kind === PROP_MASCOT ? dressMascot(x, z, PROP_BALL_TRACK, corner) : dress(x, z, kind, corner))
  // The lobby first: the barker (a mascot) by the way in, a ticket counter,
  // a cabinet, and a game cabinet or the ticket seller's monitor — off the
  // midway's own rows.
  {
    const cells = rnd.shuffle(rectCells(LOBBY).filter(([, z]) => L.type === 'vestibule' || z < L.row || z >= L.row + L.wide))
    const kinds = [PROP_MASCOT, FURN_COUNTER, rnd.chance(0.5) ? PROP_ARCADE : PROP_CCTV, FURN_CABINET]
    for (const [x, z] of cells) if (kinds.length && dress(x, z, kinds[0])) kinds.shift()
  }
  for (const [x, z, kind] of wishes) dressAny(x, z, kind)
  // The maze's dead ends: something waits round the last corner — a
  // figure, a game cabinet still glowing, a ball-roll game, a counter.
  for (const [x, z] of fieldCells) {
    if (busy.has(key(x, z)) || opensOf(x, z).length !== 1 || !rnd.chance(0.75)) continue
    dressAny(x, z, weighted(rnd, SURPRISE))
  }
  // The Ames room: a full-size chair and a child's chair at its two ends
  // (seen through the peephole, the same chair at two sizes).
  if (AMES) {
    const cells = rectCells(AMES)
    for (const [kind, list] of [[FURN_CHAIR, cells], [PROP_CHILD_CHAIR, [...cells].reverse()]]) {
      for (const [x, z] of list) if (dress(x, z, kind)) break
    }
  }
  // A pavilion is never bare: while its ground storey holds fewer than
  // PROP_FLOOR pieces, the maze's corners take more of the carnival's
  // leftovers (a cabinet, a game, a rack, a counter), in dice order.
  const pieceCount = () => g.pieces.length + gSized.length
  if (pieceCount() < PROP_FLOOR) {
    for (const [x, z] of rnd.shuffle([...fieldCells])) {
      if (pieceCount() >= PROP_FLOOR) break
      // (Never a dead end: the dead ends keep the share the maze rolled.)
      if (!busy.has(key(x, z)) && opensOf(x, z).length > 1) dressAny(x, z, weighted(rnd, CORNER_PIECES), true)
    }
  }
  // The pavilion's mirror/glass share (doc §12: 0.2–0.4 of the walls
  // between two walkable cells are mirror or glass): the booths, stock
  // rooms and attractions are counted with the maze; when the share falls
  // short of GLASS_SHARE_MIN, more of the maze's plain walls (in dice order)
  // turn to single panes.
  const pavilionGlass = topUpGlass(g, weave.opaque, GLASS_SHARE_MIN)
  // Last check: every floor cell of the storey is still reached from the
  // midway; a piece that closes the only way into a pocket is taken out.
  const unsealedG = unseal(g, gSized, (k) => zone.get(k) === 'midway', (k) => zone.get(k) === 'coreA' || zone.get(k) === 'coreB', MIRROR)
  g.compile(map, GROUND)
  // §6.8 rule 3: open the owned West/North lines at the declared ports (the
  // midway's west port on this storey; the north side has none).
  if (tile) {
    openOwnedSeam(map, ctx, GROUND, 'west')
    openOwnedSeam(map, ctx, GROUND, 'north')
  }
  for (const p of gSized) placeSized(map, GROUND, p)

  // --- ride storey -----------------------------------------------------------
  const u = new FloorPlan(REGION)
  const uzone = new Map()
  const uSized = []
  const W = TILE_CELLS_X
  const uarea = (cells, kind, name) => {
    for (const [x, z] of cells) {
      u.open(x, z, kind)
      uzone.set(key(x, z), name)
    }
  }
  uarea(rectCells(cores[0]), CELL_LOBBY, 'coreA')
  uarea(rectCells(cores[1]), CELL_LOBBY, 'coreB')
  const trackCells = []
  for (let i = 0; i < sk.track.length; i++) if (sk.track[i]) trackCells.push([i % W, (i - (i % W)) / W])
  uarea(trackCells, CELL_CORRIDOR, 'track')
  const isTrack = (x, z) => uzone.get(key(x, z)) === 'track'
  const P = sk.platform
  uarea(P.cells.flat().map((c) => [c.gx, c.gz]), CELL_LOBBY, 'platform')
  const walkA = sk.stairA.path.map((c) => [c.gx, c.gz])
  const walkB = sk.stairB.path.map((c) => [c.gx, c.gz])
  uarea(walkA, CELL_CORRIDOR, 'walkA')
  uarea(walkB, CELL_CORRIDOR, 'walkB')
  for (const [s, path] of [[sk.stairA, walkA], [sk.stairB, walkB]]) {
    const [lx, lz] = path[path.length - 1]
    const e = edgeOf(lx, lz, s.joins.gx, s.joins.gz)
    u.edge(e[0], e[1], e[2], 0, PASSAGE_OPEN)
  }
  // The load/unload gate: four cells of platform edge onto the track.
  for (let k = P.gate; k < P.gate + 4; k++) {
    const t = P.rim[k]
    const p = P.cells[k][0]
    const e = edgeOf(t.gx, t.gz, p.gx, p.gz)
    u.edge(e[0], e[1], e[2], 0, PASSAGE_WIDE)
  }
  // The cut (the exit pavilion's one-way ride) lies between gate cells 1
  // and 2: across the platform and every track cell of that cross-section.
  const cutEdges = []
  {
    const a = P.rim[P.gate + 1]
    const b = P.rim[P.gate + 2]
    for (const d of [0, 1]) cutEdges.push(edgeOf(P.cells[P.gate + 1][d].gx, P.cells[P.gate + 1][d].gz, P.cells[P.gate + 2][d].gx, P.cells[P.gate + 2][d].gz))
    for (let j = 0; j < 8; j++) {
      const ax = a.gx - P.out[0] * j
      const az = a.gz - P.out[1] * j
      const bx = b.gx - P.out[0] * j
      const bz = b.gz - P.out[1] * j
      if (!isTrack(ax, az) || !isTrack(bx, bz)) break
      cutEdges.push(edgeOf(ax, az, bx, bz))
    }
  }
  const cutKeys = new Set(cutEdges.map(edgeKey))
  // Bump doors across 3..6 straight 2-wide cross-sections of the track.
  const bumpCands = []
  for (const [x, z] of trackCells) {
    // v-line x across a run along x (rows z, z+1); h-line z across a run along z.
    if ([[x - 1, z], [x - 1, z + 1], [x, z + 1]].every(([a, b]) => isTrack(a, b)) && ![[x - 1, z - 1], [x, z - 1], [x - 1, z + 2], [x, z + 2]].some(([a, b]) => isTrack(a, b))) {
      bumpCands.push([['v', x, z], ['v', x, z + 1]])
    }
    if ([[x, z - 1], [x + 1, z - 1], [x + 1, z]].every(([a, b]) => isTrack(a, b)) && ![[x - 1, z - 1], [x - 1, z], [x + 2, z - 1], [x + 2, z]].some(([a, b]) => isTrack(a, b))) {
      bumpCands.push([['h', x, z], ['h', x + 1, z]])
    }
  }
  const bumps = []
  const bumpTarget = rnd.int(3, 6)
  for (const c of rnd.shuffle(bumpCands)) {
    if (bumps.length >= bumpTarget) break
    if (c.some((e) => cutKeys.has(edgeKey(e)))) continue
    if (bumps.some((b) => Math.abs(b[0][1] - c[0][1]) + Math.abs(b[0][2] - c[0][2]) < 5)) continue
    bumps.push(c)
    for (const e of c) u.edge(e[0], e[1], e[2], 0, PASSAGE_DOOR)
  }

  // Scene bays: 2×2 rooms off straight runs of the track, outside the loop
  // or inside it, their front pair WIDE onto the track.
  const taken = new Set(uzone.keys())
  const freeCell = (x, z) => inRect(SHED, x, z) && !taken.has(key(x, z))
  const bayCands = []
  for (const [x, z] of trackCells) {
    // side: where the track is, seen from the bay; wall: the bay's back wall.
    for (const [dx, dz, side, wall] of [[0, 1, 'N', 'S'], [0, -1, 'S', 'N'], [1, 0, 'W', 'E'], [-1, 0, 'E', 'W']]) {
      const alongX = dx === 0
      const t2 = alongX ? [x + 1, z] : [x, z + 1]
      if (!isTrack(...t2)) continue
      // Never across the cut: a bay open to both sides of it would let the
      // exit pavilion's riders skip the loop.
      if (cutKeys.has(edgeKey(edgeOf(x, z, ...t2)))) continue
      const near = alongX ? z + dz : x + dx
      const far = near + (alongX ? dz : dx)
      const rect = alongX
        ? { x0: x, x1: x + 1, z0: Math.min(near, far), z1: Math.max(near, far) }
        : { z0: z, z1: z + 1, x0: Math.min(near, far), x1: Math.max(near, far) }
      if (!rectCells(rect).every(([a, b]) => freeCell(a, b))) continue
      bayCands.push({ rect, side, wall })
    }
  }
  const bays = []
  const bayTarget = rnd.int(6, 10)
  for (const c of rnd.shuffle(bayCands)) {
    if (bays.length >= bayTarget) break
    if (!rectCells(c.rect).every(([a, b]) => freeCell(a, b))) continue
    bays.push(c)
    for (const [a, b] of rectCells(c.rect)) taken.add(key(a, b))
  }
  bays.sort((a, b) => a.rect.z0 - b.rect.z0 || a.rect.x0 - b.rect.x0)
  const scenes = []
  const sceneOrder = rnd.shuffle([...SCENES])
  const kindsByChunk = new Map()
  bays.forEach((b, i) => {
    const rect = b.rect
    const chunkKey = `${Math.floor(rect.x0 / CHUNK)},${Math.floor(rect.z0 / CHUNK)}`
    const kinds = kindsByChunk.get(chunkKey) ?? new Set()
    kindsByChunk.set(chunkKey, kinds)
    // A scene whose pieces keep the chunk under 12 kinds (the prop cap is 14).
    let scene = null
    for (let k = 0; k < sceneOrder.length && !scene; k++) {
      const s = sceneOrder[(i + k) % sceneOrder.length]
      if (new Set([...kinds, ...s.pieces]).size <= 11) scene = s
    }
    scene ??= sceneOrder[i % sceneOrder.length]
    for (const p of scene.pieces) kinds.add(p)
    const doors = b.side === 'N' || b.side === 'S'
      ? [rect.x0, rect.x1].map((gx) => ({ axis: 'h', gx, gz: b.side === 'N' ? rect.z0 : rect.z1 + 1, passage: PASSAGE_WIDE }))
      : [rect.z0, rect.z1].map((gz) => ({ axis: 'v', gx: b.side === 'W' ? rect.x0 : rect.x1 + 1, gz, passage: PASSAGE_WIDE }))
    u.room(rect, { spaceId: 500 + i, role: scene.role, doors })
    for (const [x, z] of rectCells(rect)) uzone.set(key(x, z), `bay${i}`)
    // Back row: the tableau, facing the track.
    const back = rectCells(rect).filter(([x, z]) => (b.wall === 'N' ? z === rect.z0 : b.wall === 'S' ? z === rect.z1 : b.wall === 'W' ? x === rect.x0 : x === rect.x1))
    back.forEach(([x, z], k) => (SIZED_DIMS[scene.pieces[k]] ? sizedPiece(uSized, x, z, scene.pieces[k], { wall: b.wall }) : u.piece(x, z, scene.pieces[k], { wall: b.wall })))
    // Spots: UV-purple, about two in three working.
    const lit = rnd.int(0, 2) !== 0
    u.lamp(back[0][0], back[0][1], lit, UV)
    scenes.push({ bay: i, scene: scene.name, lit, rect, back, wall: b.wall })
  })
  if (!scenes.length) return { error: 'funhouse: no scene bay fits the loop' }
  // One figure has left its tableau and stands at the front of its bay,
  // turned toward the track (doc §10 anomaly 8). Tile mode: the figure
  // faces its tableau (the baseline) unless the pavilion's anomaly is
  // 'turned'.
  const fig = scenes[rnd.int(0, scenes.length - 1)]
  const front = rectCells(fig.rect).find(([x, z]) => !fig.back.some(([bx, bz]) => bx === x && bz === z))
  const figTurned = !tile || anomaly === 'turned'
  u.piece(front[0], front[1], PROP_MASCOT, { facing: figTurned ? WALL_TO_FRONT[fig.wall] : FACING[fig.wall] })
  // At least one spot burns, so the ride reads as running.
  if (!scenes.some((s) => s.lit)) {
    const s = scenes[0]
    u.lamps.find((l) => l.gx === s.back[0][0] && l.gz === s.back[0][1]).lit = true
    s.lit = true
  }

  // Backstage: every other free cell. Each 4-connected piece is a dead-end
  // service warren with one door onto the track, the platform or a walkway.
  const free = new Set()
  for (let z = SHED.z0; z <= SHED.z1; z++) for (let x = SHED.x0; x <= SHED.x1; x++) if (freeCell(x, z)) free.add(key(x, z))
  const publicZone = (z) => z === 'track' || z === 'platform' || z === 'walkA' || z === 'walkB'
  let backCells = 0
  let backPieces = 0
  let backPillars = 0
  const backRooms = [] // the warrens' atoms of four cells or more (dressed below)
  for (const comp of pieces(free).sort((a, b) => b.length - a.length || (a[0] < b[0] ? -1 : 1))) {
    const cells = comp.map((k) => k.split(',').map(Number)).sort((a, b) => a[1] - b[1] || a[0] - b[0])
    const doors = []
    for (const [x, z] of cells) {
      for (const [dx, dz] of DIRS) {
        const zn = uzone.get(key(x + dx, z + dz))
        if (publicZone(zn)) doors.push({ e: edgeOf(x, z, x + dx, z + dz), track: zn === 'track' })
      }
    }
    if (!doors.length || cells.length < 2) continue
    const xs = cells.map((c) => c[0])
    const zs = cells.map((c) => c[1])
    const frame = { x0: Math.min(...xs), z0: Math.min(...zs), x1: Math.max(...xs), z1: Math.max(...zs) }
    const wing = { ...rollWing(rnd, frame, BACK_TYPES), id: 100 + backPieces }
    for (const [x, z] of cells) {
      u.open(x, z, CELL_CORRIDOR, 0, SPACE_ROLE_STORAGE)
      uzone.set(key(x, z), `back${backPieces}`)
    }
    const back = weaveAtoms(u, rnd, cells, () => wing, { reopenShare: 0.1, paneRate: 0 })
    // A few posts only (a quarter of the free-standing cells): the warrens
    // stay rooms of crates, and the track reads as the storey's spine.
    const posts = new Set(mirrorPillars(u, rnd, back.atoms, back.atomOf, 0.25).map(([x, z]) => key(x, z)))
    for (const atom of back.atoms) if (atom.cells.length >= 4) backRooms.push(atom)
    backPillars += posts.size
    // Work lights: one in three of the warren's rooms has one, one in three
    // of those burns (the fill light leaves backstage dark).
    for (const atom of back.atoms) {
      if (atom.cells.length < 4 || rnd.int(0, 2) !== 0) continue
      const [x, z] = atom.cells[rnd.int(0, atom.cells.length - 1)]
      if (!posts.has(key(x, z))) u.lamp(x, z, rnd.int(0, 2) === 0)
    }
    const pool = doors.some((d) => d.track) && rnd.chance(0.7) ? doors.filter((d) => d.track) : doors
    const d = pool[rnd.int(0, pool.length - 1)].e
    u.edge(d[0], d[1], d[2], 0, PASSAGE_DOOR)
    backCells += cells.length
    backPieces++
  }

  // The track's own lights are dead; the platform keeps one working lamp
  // (at the load end; the exit pavilion lights its unload end too).
  for (const [x, z] of trackCells) if (x % 4 === 2 && z % 4 === 2) u.lamp(x, z, false)
  const loadK = P.loadEnd ? P.length - 1 : 0
  const unloadK = P.length - 1 - loadK
  for (let k = 0; k < P.length; k++) {
    if (k !== loadK && k !== unloadK && k % 5 !== 2) continue
    const c = P.cells[k][1]
    u.lamp(c.gx, c.gz, k === loadK || (exitPavilion && k === unloadK))
  }
  walkA.forEach(([x, z], i) => {
    if (i % 6 === 4) u.lamp(x, z, false)
  })
  // The exit pavilion's one-way ride (doc §4.3 step 6): a pane across
  // walkway A after its stub, and a wall across the platform and the track
  // in the middle of the gate. Riders board on the load side (stair B), ride
  // the whole loop and step off on the unload side, which leads to walkway A
  // and the exit.
  if (exitPavilion) {
    const [a, b] = [walkA[STUB - 1], walkA[STUB]]
    const e = edgeOf(a[0], a[1], b[0], b[1])
    u.window(e[0], e[1], e[2])
    for (const c of cutEdges) u.edge(c[0], c[1], c[2], 1, PASSAGE_WALL)
  }
  sealZones(u, uzone)
  // The ride's dressing: the operator's console (the CCTV desk) by the gate
  // and a control cabinet or two on the platform's back row; racks of ride
  // parts, costume wardrobes and cabinets in the backstage rooms. The
  // walkways and the platform's ends stay clear (the exit lies on walkway A).
  const ubusy = new Set([...u.cols, ...u.pieces, ...uSized].map((c) => key(c.gx, c.gz)))
  const uClear = new Set([...walkA, ...walkB].map(([x, z]) => key(x, z)))
  for (const k of [0, P.length - 1]) for (const c of P.cells[k]) uClear.add(key(c.gx, c.gz))
  const udress = makeDresser(u, uzone, ubusy, uClear, uSized)
  {
    const back = (k) => P.cells[k][1]
    const podiumAt = [P.gate - 1, P.gate + 4].filter((k) => k > 0 && k < P.length - 1)
    for (const k of rnd.shuffle(podiumAt)) if (udress.dress(back(k).gx, back(k).gz, PROP_CCTV)) break
    const queue = []
    for (let k = 1; k < P.length - 1; k++) if (k < P.gate - 1 || k > P.gate + 4) queue.push(k)
    let benches = 0
    for (const k of rnd.shuffle(queue)) if (benches < 2 && udress.dress(back(k).gx, back(k).gz, FURN_CABINET)) benches++
  }
  for (const atom of backRooms) {
    if (!rnd.chance(0.5)) continue
    const cells = rnd.shuffle([...atom.cells])
    const kind = weighted(rnd, [[FURN_RACK, 3], [FURN_WARDROBE, 2], [FURN_CABINET, 1]])
    for (const [x, z] of cells) if (udress.dress(x, z, kind, true)) break
  }
  const unsealedU = unseal(u, uSized, (k) => uzone.get(k) === 'track', (k) => uzone.get(k) === 'coreA' || uzone.get(k) === 'coreB', null)
  u.compile(map, RIDE)
  for (const p of uSized) placeSized(map, RIDE, p)

  // --- stamps ----------------------------------------------------------------
  for (const s of [sk.stairA, sk.stairB]) {
    const sp = stairwellPlan({ gx: s.gx, gz: s.gz, baseCy: GROUND, topCy: RIDE, dir: s.dir, doorSide: s.doorSide })
    if (sp.error) return { error: `funhouse stair: ${sp.error}` }
    ctx.kit.stairwell(map, sp, { enclosed: true })
  }

  // --- touch-ups ---------------------------------------------------------------
  // The plates read FUn below and its mirror image above (doc §4.2: the
  // mirror maze's exit marks read backwards).
  labelFloor(map, GROUND, 'FUn')
  labelFloor(map, RIDE, 'nUF')
  // The midway runs on to the next pavilion: sealed here, marked as the exit.
  // Tile mode: the midway is open to the chain, and the exit is the ride's
  // unload walkway (§12.12) — every pavilion marks its walkway cells past the
  // pane, the hashed one first (pure in the world seed); the exit hook reads
  // the exit pavilion's. The world's spawn is pavilion 0's midway.
  let exit
  if (tile) {
    const cells = exitCandidatesOf(ctx.worldSeed, tx)
    for (const c of cells) markExit(map, ctx, c)
    exit = cells[0]
    if (tx === 0) markSpawn(map, ctx, { ...SPAWN_CELLS[0], cy: GROUND })
    // The world's lamp cap (≤ 12 lit lamps per chunk-storey, spec §11.1
    // item 9): the surplus of a crowded chunk are dead bulbs, by the dice —
    // never the mirror maze's two lamps (the lamp lie is the only dead one)
    // nor the bulb over the spawn.
    const o = map.origin ?? ctx.origin ?? { cx: 0, cy: 0, cz: 0 }
    capLitLamps(map, r, LIT_CAP, (d, l) => {
      if (d.cy - o.cy !== GROUND) return false
      const gx = (d.cx - o.cx) * CHUNK + l.lx
      const gz = (d.cz - o.cz) * CHUNK + l.lz
      return inRect(MIRROR, gx, gz) || (spawnBulb !== null && gx === spawnBulb.x && gz === spawnBulb.z)
    })
  } else {
    exit = { gx: lastX, gz: sk.midLo[lastX], cy: GROUND }
    markExit(map, ctx, exit)
  }

  // --- notes -----------------------------------------------------------------
  const wingNames = wings.map((w) => `${w.type}@${w.rect.x0},${w.rect.z0}-${w.rect.x1},${w.rect.z1}`).join(' ')
  notes.push(`field: ${fieldCells.length} cells, ${weave.atoms.length} atoms in ${wings.length} wings (${wingNames}); ${weave.reopened}/${weave.walls} walls reopened (${Math.round(reopenShare * 100)}%), ${weave.panes} glass panes; mirror/glass share about ${pavilionGlass.toFixed(2)} of the pavilion's walls (plan)`)
  notes.push(`glass maze at ${GLASS.x0},${GLASS.z0} (${GLASS.x1 - GLASS.x0 + 1}x${gd}): ${glassPanes}/${glassOrder.length} walls glass`)
  notes.push(`mirror maze at ${MIRROR.x0},${MIRROR.z0} (6x${md}, ${hueName}): ${reflected} cells reflected across x ${line}, ${halfPanes}/${halfOrder.length} panes a half`)
  for (const [lie, lieAt] of liesAtCells) notes.push(`mirror lie: ${lie} at ${lieAt[0]},${lieAt[1]}${lieAt[2] ? ` (${lieAt[2]})` : ''}`)
  if (tile) notes.push(`anomaly: ${anomaly ?? 'none'} (budget ${lieBudget(tx)}‰${exitPavilion ? ', the exit pavilion' : ''}) in pavilion ${tx}`)
  if (blacklight) notes.push(`black-light room at ${TILT.x0},${TILT.z0}: UV spots, a dead arcade cabinet`)
  else notes.push(`level room at ${TILT.x0},${TILT.z0}: the ball track ${!tile || anomaly === 'uphill' ? 'rolls uphill' : 'runs downhill'}`)
  if (AMES) notes.push(`ames room at ${AMES.x0},${AMES.z0} (${AMES.x1 - AMES.x0 + 1}x${AMES.z1 - AMES.z0 + 1}): a door and a peephole pane`)
  if (HALL) notes.push(`mirror hall at ${HALL.x0},${HALL.z0} (${HALL.x1 - HALL.x0 + 1}x${HALL.z1 - HALL.z0 + 1}): glazed both sides`)
  const R = sk.route
  notes.push(`midway: ${R.wide} rows wide, runs at rows ${R.rows.join(', ')}${R.jogs.length ? `, jogs at x ${R.jogs.join(', ')}` : ''} (east port rows ${sk.portE}..${sk.portE + 1}); ${booths.length} booths, ${arcades} arcade alcoves, ${carousels} carousels, ${bulbs} live bulbs; ${mouths.length} mouths onto ${sk.fieldPieces} field pieces; bands ${bandTypes.join(' ')}; ${stock} stock rooms behind`)
  notes.push(`attendant booth at ${attendant.x0},${attendant.z0} (CCTV at ${attendant.cctv[0]},${attendant.cctv[1]})`)
  notes.push(`shed ${SHED.x0},${SHED.z0}-${SHED.x1},${SHED.z1}, ${sk.notches.length} corner notches; props ${g.pieces.length + gSized.length} on the ground storey (${dresser.count()} dressed, ${mascots} mascots besides the barker)`)
  notes.push(`lobby (${LOBBY.type}) ${LOBBY.x0},${LOBBY.z0}-${LOBBY.x1},${LOBBY.z1}; stairs A at ${sk.stairA.gx},${sk.stairA.gz} (dir ${sk.stairA.dir}, ${sk.stairA.doorSide}), B at ${sk.stairB.gx},${sk.stairB.gz} (dir ${sk.stairB.dir}, ${sk.stairB.doorSide})`)
  notes.push(`dark ride: ${scenes.length} scenes (${scenes.filter((s) => s.lit).length} UV-lit), a loop of ${sk.loopCells} track cells (${sk.loopRects.length} rects), ${bumps.length} bump doors, platform ${P.side} ${P.length} long, gate at ${P.rim[P.gate].gx},${P.rim[P.gate].gz}; ${figTurned ? 'figure out of its scene' : 'figure facing its scene'} in bay ${fig.bay}`)
  notes.push(`mirror pillars: ${pillars.length} in the maze, ${backPillars} backstage; ${unsealedG + unsealedU} pieces taken out to keep every cell reached`)
  notes.push(`backstage: ${backPieces} warrens, ${backCells} cells; walkways ${walkA.length} (unload) and ${walkB.length} (load)`)
  if (exitPavilion) notes.push(`one-way ride: cut at the gate's middle; stair A's landing behind glass after ${STUB} cells`)
  notes.push('look: the corridor through the mirror line is real and walkable from its far side; the glass maze shows exits you cannot reach; the plates say FUn below and nUF above')
  notes.push('stand-ins: mirrors are glass onto duplicated geometry (no reflections, no player image); glass panes keep window sills and frames; the level room holds a ball track instead of a 10–20° tilt; the Ames room has a peephole pane, no distortion; no vortex tunnel, barrel, ride cars, UV paint, slide or lobby seal (static engine)')
  if (tile) {
    if (exitPavilion) notes.push(`exit pavilion: the unload walkway at ${exit.gx},${exit.gz} on the ride storey`)
    ctx.notes.push(...notes)
  }
  const field = new Map()
  for (const [x, z] of fieldCells) field.set(key(x, z), weave.atomOf.get(ik(x, z)))
  return { spawn: { gx: SPAWN_CELLS[0].gx, gz: m + 1, cy: GROUND }, notes, exit, field }
}

// The dressing pass of one storey's plan: a piece goes only where it closes
// no way — never on a cell with an opening onto another zone (a mouth, a
// door, an arch) or in `keepClear`, always against a real wall (two of them
// for a `corner`), and only where the cell's open neighbours stay joined
// round it — and never as a 15th distinct kind in its chunk (spec §11.1
// item 9: ≤ 14 kinds per chunk). `busy` holds the cells already taken.
const SIDES = [['E', 1, 0], ['W', -1, 0], ['S', 0, 1], ['N', 0, -1]]
const OPP = { E: 'W', W: 'E', S: 'N', N: 'S' }
const KIND_CAP = 14
function makeDresser(plan, zone, busy, keepClear, sized) {
  const edgeAt = (ax, az, bx, bz) => plan.edges.get(edgeKey(edgeOf(ax, az, bx, bz)))
  const passable = (ax, az, bx, bz) => {
    const zb = zone.get(key(bx, bz))
    if (zb === undefined || busy.has(key(bx, bz))) return false
    const ex = edgeAt(ax, az, bx, bz)
    return ex ? !ex.wall : zb === zone.get(key(ax, az))
  }
  const opensOf = (x, z) => SIDES.filter(([, dx, dz]) => passable(x, z, x + dx, z + dz))
  const spot = (x, z, corner = false) => {
    const zn = zone.get(key(x, z))
    if (zn === undefined || busy.has(key(x, z)) || keepClear.has(key(x, z))) return null
    const open = []
    const walls = []
    for (const [s, dx, dz] of SIDES) {
      const nk = key(x + dx, z + dz)
      const ex = edgeAt(x, z, x + dx, z + dz)
      if (zone.get(nk) === undefined || (ex && ex.wall) || (!ex && zone.get(nk) !== zn)) walls.push(s)
      else if (busy.has(nk)) continue
      else if (zone.get(nk) !== zn) return null
      else open.push([x + dx, z + dz])
    }
    if (!open.length || !walls.length || (corner && walls.length < 2)) return null
    if (open.length >= 2) {
      busy.add(key(x, z))
      const targets = new Set(open.slice(1).map(([a, b]) => key(a, b)))
      const seen = new Set([key(...open[0])])
      const q = [open[0]]
      for (let h = 0; h < q.length && targets.size && seen.size < 80; h++) {
        const [cx, cz] = q[h]
        for (const [, dx, dz] of SIDES) {
          const nk = key(cx + dx, cz + dz)
          if (seen.has(nk) || zone.get(nk) !== zn || !passable(cx, cz, cx + dx, cz + dz)) continue
          seen.add(nk)
          targets.delete(nk)
          q.push([cx + dx, cz + dz])
        }
      }
      busy.delete(key(x, z))
      if (targets.size) return null
    }
    // Stand against the wall that faces an opening (the piece looks out).
    const facing = walls.filter((s) => open.some(([a, b]) => a - x === SIDES.find((t) => t[0] === OPP[s])[1] && b - z === SIDES.find((t) => t[0] === OPP[s])[2]))
    return facing.length ? facing[0] : walls[0]
  }
  const kinds = new Map()
  const chunkOf = (x, z) => `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`
  const noteKind = (x, z, kind) => {
    const c = chunkOf(x, z)
    let set = kinds.get(c)
    if (!set) kinds.set(c, (set = new Set()))
    set.add(kind)
  }
  for (const p of [...plan.pieces, ...sized]) noteKind(p.gx, p.gz, p.kind)
  let count = 0
  const dress = (x, z, kind, corner = false) => {
    const set = kinds.get(chunkOf(x, z))
    if (set && !set.has(kind) && set.size >= KIND_CAP) return false
    const wall = spot(x, z, corner)
    if (!wall) return false
    if (SIZED_DIMS[kind]) sizedPiece(sized, x, z, kind, { wall })
    else plan.piece(x, z, kind, { wall })
    busy.add(key(x, z))
    noteKind(x, z, kind)
    count++
    return true
  }
  return { dress, opensOf, count: () => count }
}

// The plan's walkable cells (no column, no piece, `skip` excluded) not
// reached from the `start` cells through open edges (an explicit open edge,
// or no edge between two plan cells, as FloorPlan.compile writes them). While
// some are left, every piece (outside `keep`) standing between a reached cell
// and an unreached one is taken out. Returns how many pieces went.
function unseal(plan, sized, start, skip, keep) {
  const W = TILE_CELLS_X
  const D = TILE_CELLS_Z
  const N = W * D
  // 0 none, 1 walkable, 2 column, 3 piece, 4 skipped; the start cells.
  const cell = new Uint8Array(N)
  const seed = []
  for (const k of plan.cells.keys()) {
    const comma = k.indexOf(',')
    const x = +k.slice(0, comma)
    const z = +k.slice(comma + 1)
    if (x < 0 || z < 0 || x >= W || z >= D) continue
    cell[z * W + x] = skip(k) ? 4 : 1
    if (start(k)) seed.push(z * W + x)
  }
  for (const c of plan.cols) if (c.gx >= 0 && c.gz >= 0 && c.gx < W && c.gz < D) cell[c.gz * W + c.gx] = 2
  const pieceCells = []
  for (const p of [...plan.pieces, ...sized]) {
    if (p.gx < 0 || p.gz < 0 || p.gx >= W || p.gz >= D) continue
    const i = p.gz * W + p.gx
    if (cell[i] === 1) {
      cell[i] = 3
      pieceCells.push(i)
    }
  }
  // Open edges: east (v-line x+1) and south (h-line z+1) of each cell.
  const openE = new Uint8Array(N)
  const openS = new Uint8Array(N)
  for (let z = 0; z < D; z++) {
    for (let x = 0; x < W; x++) {
      const e = plan.edges.get(`v:${x + 1},${z}`)
      openE[z * W + x] = e ? (e.wall ? 0 : 1) : 1
      const f = plan.edges.get(`h:${x},${z + 1}`)
      openS[z * W + x] = f ? (f.wall ? 0 : 1) : 1
    }
  }
  const nbrs = (i) => {
    const x = i % W
    const out = []
    if (x + 1 < W && openE[i]) out.push(i + 1)
    if (x > 0 && openE[i - 1]) out.push(i - 1)
    if (i + W < N && openS[i]) out.push(i + W)
    if (i - W >= 0 && openS[i - W]) out.push(i - W)
    return out
  }
  const seen = new Uint8Array(N)
  let removed = 0
  for (let round = 0; round < 16; round++) {
    seen.fill(0)
    const q = []
    for (const i of seed) {
      if (cell[i] === 1 && !seen[i]) {
        seen[i] = 1
        q.push(i)
      }
    }
    for (let h = 0; h < q.length; h++) {
      for (const n of nbrs(q[h])) {
        if (seen[n] || cell[n] !== 1) continue
        seen[n] = 1
        q.push(n)
      }
    }
    const lost = (i) => cell[i] === 1 && !seen[i]
    let any = false
    for (let i = 0; i < N && !any; i++) if (lost(i)) any = true
    if (!any) break
    const cut = []
    for (const i of pieceCells) {
      if (cell[i] !== 3) continue
      if (keep && inRect(keep, i % W, (i - (i % W)) / W)) continue
      const nb = nbrs(i)
      if (nb.some((n) => seen[n]) && nb.some(lost)) cut.push(i)
    }
    if (!cut.length) break
    const gone = new Set()
    for (const i of cut) {
      cell[i] = 1
      removed++
      gone.add(key(i % W, (i - (i % W)) / W))
    }
    plan.pieces = plan.pieces.filter((p) => !gone.has(key(p.gx, p.gz)))
    sized.splice(0, sized.length, ...sized.filter((p) => !gone.has(key(p.gx, p.gz))))
  }
  return removed
}

// The share of a plan's walls between two walkable cells that are see-through
// (mirror or glass), raised to `min` by glazing `spare` walls in order.
const GLASS_SHARE_MIN = 0.24
function topUpGlass(plan, spare, min) {
  const pillar = new Set(plan.cols.map((c) => key(c.gx, c.gz)))
  const walk = (x, z) => plan.cells.has(key(x, z)) && !pillar.has(key(x, z))
  const counts = (axis, gx, gz) => (axis === 'v' ? walk(gx - 1, gz) && walk(gx, gz) : walk(gx, gz - 1) && walk(gx, gz))
  let walls = 0
  let glass = 0
  for (const [k, e] of plan.edges) {
    if (!e.wall) continue
    const [axis, rest] = k.split(':')
    const [gx, gz] = rest.split(',').map(Number)
    if (!counts(axis, gx, gz)) continue
    walls++
    if (e.feature !== WALL_PLAIN) glass++
  }
  for (const f of spare) {
    if (!walls || glass / walls >= min) break
    const e = plan.edges.get(edgeKey(f))
    if (!e || !e.wall || e.feature !== WALL_PLAIN || !counts(f[0], f[1], f[2])) continue
    plan.window(f[0], f[1], f[2])
    glass++
  }
  return walls ? glass / walls : 0
}

// Tile mode: at most `cap` lit lamps per chunk-storey (spec §11.1 item 9).
// A chunk over the cap keeps the `cap` lamps whose dice rank lowest lit and
// turns the rest into dead bulbs (the midway's dead strings).
const LIT_CAP = 12
function capLitLamps(map, r, cap, keep) {
  for (const d of map.chunks.values()) {
    const lit = d.lamps.filter((l) => l.lit)
    if (lit.length <= cap) continue
    const rank = (l) => (keep(d, l) ? -1 : r(1000 + d.cy * 256 + l.lx * 16 + l.lz, d.cx * 64 + d.cz))
    lit.sort((a, b) => rank(a) - rank(b) || a.lx - b.lx || a.lz - b.lz)
    for (const l of lit.slice(cap)) l.lit = false
  }
}
