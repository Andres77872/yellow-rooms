import {
  CELL_CORRIDOR,
  CELL_LOBBY,
  CELL_OPEN,
  COLUMN_MONUMENTAL,
  FACING,
  FloorPlan,
  PASSAGE_WALL,
  PASSAGE_WIDE,
  SPACE_ROLE_BEDROOM,
  SPACE_ROLE_LIVING,
  STAIR_E,
  WALL_TO_FRONT,
  addPiece,
  labelFloor,
  rng,
} from '../../tiles/floorPlan.js'
import { FURN_BOOKSHELF, FURN_COUNTER, FURN_RACK, FURN_TABLE, FURN_WARDROBE } from '../../rooms/catalog.js'
import { PROP_BAG_BIN, PROP_CART, PROP_FLATPACK } from '../../props/index.js'
import { stairwellPlan } from '../../structures/authored.js'
import { finiteCtx } from '../../tiles/kit.js'
import { clearRoomObjects, createRoom, regenerateRoom } from '../../tiles/roomOps.js'
import { ROLES, ROLE_NAME, SHOWROOM_MUTATIONS, WARM, oddPool, paste, put, roomItems } from './parts.js'

// --- infinite showroom: the kind lab (docs/liminal_maps/09-infinite-showroom.md)
//
// The editor kind's finite district (src/editor/kinds/showroom.js wraps it
// with FINITE_CTX_SHOWROOM, byte-identical to the original kind): one fixed
// district on two storeys (2×2 chunks each), day only — the prototype the
// world's district grammar (district.js) took its parts from. The world never
// runs this program: every world tile is composed by the grammar instead.
//   cy 1  the showroom: a 2-wide serpentine route of four bands joined by
//         U-turns, each band lined on its north side by three-walled room-set
//         vignettes (createRoom with a residential/office role, front opened
//         WIDE onto the route). A layout shows 2–3× exactly along the route,
//         then once more mutated; a wardrobe display and a lighting
//         department are the one-offs (repetition lands in doc 12's 0.5–0.7).
//         Two or three unmarked 1-wide gaps cut between spatially adjacent
//         bands far apart along the route (shortcuts).
//   cy 0  market hall (gondola runs, 1-wide aisles, flat-pack pallets), the
//         self-serve warehouse (rack lines on monumental piers, dim) and the
//         checkout bank (counter lanes, one lit), in the store's own order.
// The route is a cycle: stair B at the showroom's end drops to the market
// hall; the checkouts lead to stair A, which climbs back to the route start.

export { SHOWROOM_MUTATIONS, WARM }

const SALT = 0x09a1
const DOWN = 0
const UP = 1
const REGION = Object.freeze({ x0: 0, z0: 0, x1: 27, z1: 27 })
const BANDS = [5, 12, 19, 25]
const STAIRS = [{ gx: 2, gz: 2 }, { gx: 2, gz: 22 }]

export const KIND_DEFAULTS = Object.freeze({ checkoutSide: 'west' })
export const FINITE_CTX_SHOWROOM = finiteCtx(KIND_DEFAULTS)

// Route bands (north row z; each band is rows z, z + 1, x 1..26) and the
// vignette rows north of them. A row's segments never straddle a chunk seam
// (createRoom furnishes per chunk slice); `slots` are the x where a shortcut
// may cut through it, all far from the U-turn that already joins its bands.
const ROWS = [
  { band: 0, z0: 1, z1: 4, segs: [[7, 13], [14, 26]], slots: [] },
  { band: 1, z0: 7, z1: 11, segs: [[1, 13], [14, 24]], slots: [1, 4, 5, 6, 7], uturn: [25, 26] },
  { band: 2, z0: 14, z1: 18, segs: [[3, 13], [14, 26]], slots: [20, 21, 22, 23, 26], uturn: [1, 2] },
  { band: 3, z0: 21, z1: 24, segs: [[7, 13], [14, 24]], slots: [7, 10], uturn: [25, 26] },
]
// Stair cores (landing, enclosed, door to the south at (gx + 1, core z1 + 1)):
// A climbs from the checkouts to the route start, B drops from the route end
// to the market hall.
const CORES = [{ x0: 1, z0: 1, x1: 6, z1: 4 }, { x0: 1, z0: 21, x1: 6, z1: 24 }]

// Split a segment of n cells into vignette widths of 3..5, mostly 4, so
// same-size rooms (the repetition pool) are common.
function widths(n) {
  if (n <= 0) return []
  const k = Math.max(1, Math.round(n / 4))
  const base = Math.floor(n / k)
  return Array.from({ length: k }, (_, i) => base + (i < n - base * k ? 1 : 0))
}

// Segment [a, b] minus the cut columns `cuts` ([[x0, x1]], disjoint), as the
// non-empty parts in x order.
function splitSeg(a, b, cuts) {
  const parts = []
  let x = a
  for (const [c0, c1] of [...cuts].sort((p, q) => p[0] - q[0])) {
    if (c1 < a || c0 > b) continue
    if (c0 - 1 >= x) parts.push([x, c0 - 1])
    x = Math.max(x, c1 + 1)
  }
  if (b >= x) parts.push([x, b])
  return parts
}

export function buildShowroomTile(map, seed, ctx = FINITE_CTX_SHOWROOM) {
  const r = rng(seed, SALT)
  const notes = []

  // --- plans ---------------------------------------------------------------
  // Shortcuts: always through rows 1 and 2, a third through row 3 on odd dice.
  const shortcuts = []
  for (const row of ROWS) {
    if (!row.slots.length || (row.band === 3 && r(3, 0x5c) % 2 === 0)) continue
    shortcuts.push({ row, x: row.slots[r(row.band, 0x5d) % row.slots.length] })
  }
  const slotOf = new Map(shortcuts.map((s) => [s.row.band, s.x]))

  const up = new FloorPlan(REGION)
  for (const c of CORES) up.rect(c, CELL_LOBBY)
  for (const z of BANDS) up.rect({ x0: 1, z0: z, x1: 26, z1: z + 1 }, CELL_CORRIDOR)
  const sets = [] // vignette rects in route order
  for (const row of ROWS) {
    if (row.uturn) up.rect({ x0: row.uturn[0], z0: row.z0, x1: row.uturn[1], z1: row.z1 }, CELL_CORRIDOR)
    const xs = slotOf.get(row.band)
    if (xs !== undefined) up.rect({ x0: xs, z0: row.z0, x1: xs, z1: row.z1 }, CELL_OPEN)
    const cuts = xs !== undefined ? [[xs, xs]] : []
    const rowSlots = []
    for (const [a, b] of row.segs) {
      // A shortcut splits its segment; every part stays 0 or ≥ 3 cells wide.
      for (const [p0, p1] of splitSeg(a, b, cuts)) {
        const ws = widths(p1 - p0 + 1)
        // Dice the order so equal widths land at different x per seed.
        if (ws.length > 1) ws.push(...ws.splice(0, r(p0, row.band) % ws.length))
        let x = p0
        for (const w of ws) {
          const rect = { x0: x, z0: row.z0, x1: x + w - 1, z1: row.z1 }
          up.rect(rect, CELL_OPEN)
          rowSlots.push(rect)
          x += w
        }
      }
    }
    // Read in the band's walking direction: even bands run west → east.
    if (row.band % 2) rowSlots.reverse()
    sets.push(...rowSlots)
  }
  // Day lighting on the route: a fixture every three cells, staggered across
  // the two lanes; one per U-turn. Shortcuts stay unlit.
  for (const z of BANDS) for (let x = 2; x <= 26; x += 3) up.lamp(x, z + (((x - 2) / 3) % 2), true)
  for (const row of ROWS) if (row.uturn) up.lamp(row.uturn[0], (row.z0 + row.z1) >> 1, true)
  for (const c of CORES) for (const [x, z] of [[c.x0, c.z0], [c.x1, c.z1]]) up.lamp(x, z, true)
  up.compile(map, UP)

  const down = new FloorPlan(REGION)
  for (const c of CORES) {
    down.rect(c, CELL_LOBBY)
    for (const [x, z] of [[c.x0, c.z0], [c.x1, c.z1]]) down.lamp(x, z, true)
  }
  const hall = planHallWest(down, r)
  down.compile(map, DOWN)

  // --- stamps --------------------------------------------------------------
  for (const at of STAIRS) {
    const sp = stairwellPlan({ ...at, baseCy: DOWN, topCy: UP, dir: STAIR_E, doorSide: 'far' })
    if (sp.error) return { error: `showroom stair: ${sp.error}` }
    ctx.kit.stairwell(map, sp, { enclosed: true })
  }

  // --- touch-ups -----------------------------------------------------------
  // Warehouse rack lines on even rows; a monumental pier every third bay
  // carries the (absent) upper rack levels.
  const RACK_LINES = [2, 4, 6, 8, 10]
  const rackCells = []
  for (const z of RACK_LINES) {
    for (const [a, b] of hall.rackRuns) {
      for (let x = a; x <= b; x++) {
        if ((x - a) % 3 === 0) map.setCell(x, DOWN, z, { col: COLUMN_MONUMENTAL })
        else rackCells.push([x, z])
      }
    }
  }
  // Plates at the stair ends: the showroom claims to be open, the lower
  // storey names its hall. (Floor arrows have no carrier yet: S11.)
  labelFloor(map, UP, 'oPEn')
  labelFloor(map, DOWN, 'HALL')

  // --- furniture: vignettes ------------------------------------------------
  // Walking the route, each new layout (role at that size) is shown 2–3×
  // exactly, then once more with one thing wrong. 2–4 exact showings pushed
  // repetition past 0.75; doc 12 wants 0.5–0.7.
  const runs = new Map() // 'w×d' -> { role, exact, shown, master }
  const vignettes = []
  const mutations = []
  let lastRole = -1
  let roll = 0
  // Two one-off departments break the rhythm: a wardrobe display and the
  // lighting department (fixtures over every table).
  const depts = new Map([[2 + (r(0, 0x2f) % 6), 'wardrobes'], [12 + (r(1, 0x2f) % 6), 'lighting']])
  const schedule = sets.map((rect, i) => {
    if (depts.has(i)) return null
    const key = `${rect.x1 - rect.x0 + 1}x${rect.z1 - rect.z0 + 1}`
    let run = runs.get(key)
    let mode = 'copy'
    if (!run || run.shown > run.exact) {
      let role = ROLES[r(roll++, 0x2a) % ROLES.length]
      if (role === lastRole) role = ROLES[(ROLES.indexOf(role) + 1 + (r(roll++, 0x2b) % (ROLES.length - 1))) % ROLES.length]
      run = { role, exact: 2 + (r(roll++, 0x2c) % 2), shown: 0, master: null }
      runs.set(key, run)
      mode = 'master'
    } else if (run.shown === run.exact) mode = 'mutant'
    run.shown++
    lastRole = run.role
    const mutRoll = mode === 'mutant' ? roll++ : -1
    const pickRoll = mode === 'master' ? -1 : roll++
    return { run, mode, mutRoll, pickRoll }
  })
  // The route's strays (pure in the dice): abandoned carts on the bands'
  // outer lanes, clear of U-turns, shortcut mouths and the stair doors.
  const carts = []
  for (let band = 0; band < 3; band++) {
    const x = 6 + (r(band, 0x3c) % 16)
    if ([...slotOf.values()].some((s) => Math.abs(s - x) <= 1)) continue
    carts.push({ gx: x, gz: BANDS[band] + 1, front: r(band, 0x3d) % 2 ? FACING.E : FACING.W })
  }
  const BAG_BIN = { gx: 1, gz: 26 }
  for (const [i, rect] of sets.entries()) {
    const dept = depts.get(i)
    if (dept) {
      vignettes.push(department(map, rect, dept))
      continue
    }
    const { run, mode, mutRoll, pickRoll } = schedule[i]
    const room = createRoom(map, { cy: UP, ...rect, role: run.role, salt: 0 })
    const v = { rect, room, role: run.role, mode, mutation: null }
    if (mode === 'master') {
      // Furnish with the route side already open: the grammar then skips the
      // WIDE front row instead of backing pieces onto a wall that openFront
      // removes. Copies paste this layout, so they inherit it.
      openFront(map, rect)
      regenerateRoom(map, room)
      run.master = { rect, items: roomItems(map, room) }
    } else {
      clearRoomObjects(map, room)
      let mutation = null
      if (mode === 'mutant') {
        mutation = SHOWROOM_MUTATIONS[r(mutRoll, 0x2d) % SHOWROOM_MUTATIONS.length]
        if ((mutation === 'missing' || mutation === 'swapped') && !oddPool(run.master.items, rect, mutation).length) mutation = 'dark'
      }
      paste(map, UP, run.master.items, rect, mutation, r(pickRoll, 0x2e))
      v.mutation = mutation
      if (mutation) mutations.push(v)
    }
    const dark = v.mutation === 'dark' || v.mutation === 'walled'
    map.setLamp((rect.x0 + rect.x1) >> 1, UP, (rect.z0 + rect.z1) >> 1, !dark, WARM)
    // Three walls: the route side opens WIDE, except on the real room.
    if (v.mutation !== 'walled') openFront(map, rect)
    vignettes.push(v)
  }

  // --- furniture: the lower storey and the route's strays ----------------
  const lower = furnishHallWest(map, r, rackCells)
  addPiece(map, UP, { ...BAG_BIN, kind: PROP_BAG_BIN, front: FACING.E, wall: 'W' })
  // Abandoned carts: the queue strip and the route's outer lane.
  addPiece(map, DOWN, { gx: 7, gz: 18, kind: PROP_CART, front: FACING.N, wall: null })
  for (const c of carts) addPiece(map, UP, { gx: c.gx, gz: c.gz, kind: PROP_CART, front: c.front, wall: null })

  // --- notes ---------------------------------------------------------------
  const routeCells = [...up.cells.values()].filter((c) => c.kind === CELL_CORRIDOR).length
  notes.push(`route: ${BANDS.length} bands, ${routeCells} cells; ${vignettes.length} vignettes, ${mutations.length} mutated`)
  for (const v of mutations) {
    notes.push(`mutation at ${v.rect.x0},${v.rect.z0}: ${ROLE_NAME[v.role]} ${v.mutation}`)
  }
  for (const v of vignettes) if (v.mode === 'wardrobes' || v.mode === 'lighting') notes.push(`${v.mode} department at ${v.rect.x0},${v.rect.z0}`)
  for (const s of shortcuts) notes.push(`shortcut ${s.row.band}→${s.row.band + 1} at x ${s.x}`)
  notes.push(`checkout lane ${hall.litLane + 1}/${hall.lanes.length} lit · ${lower.pallets} flat-pack pallets · ${carts.length + 1} carts`)
  notes.push('look: the same room set again and again down the route, then the odd one; the unlit shortcut gaps; the checkouts lead back up to the route start')
  notes.push('stand-ins: no floor arrows or aisle/bin labels (S11), full-height partitions, racks one storey tall, plates on the lower storey only')
  return { spawn: { gx: 2, gz: BANDS[0] + 1, cy: UP }, notes }
}

// --- the hall storey (kind storey 0) --------------------------------------------------

// The kind lab's hall storey: the checkout bank at the west side, between
// stair A and the warehouse; the market hall and the warehouse x 8..26.
function planHallWest(down, r) {
  down.rect({ x0: 1, z0: 25, x1: 7, z1: 26 }, CELL_CORRIDOR) // from stair B into the hall
  const HALL = { x0: 8, z0: 13, x1: 26, z1: 26 }
  down.rect(HALL, CELL_OPEN)
  const WARE = { x0: 8, z0: 1, x1: 26, z1: 12 }
  down.rect(WARE, CELL_OPEN)
  // The warehouse shows the hall a blank partition except along its main aisle.
  for (let x = WARE.x0; x <= WARE.x1; x++) if (x !== 17 && x !== 18) down.edge('h', x, 13, 1, PASSAGE_WALL)
  // Checkout bank: a queue strip off the warehouse, lanes x 3..5 (counter rows
  // on even z, lane aisles on odd z), then the strip past the tills to stair A.
  down.rect({ x0: 6, z0: 7, x1: 7, z1: 20 }, CELL_LOBBY)
  for (let z = 13; z <= 20; z++) down.edge('v', 8, z, 1, PASSAGE_WALL) // no way round the warehouse
  down.rect({ x0: 3, z0: 7, x1: 5, z1: 19 }, CELL_LOBBY)
  down.rect({ x0: 1, z0: 7, x1: 2, z1: 20 }, CELL_LOBBY)
  down.rect({ x0: 1, z0: 5, x1: 5, z1: 6 }, CELL_LOBBY)
  const lanes = []
  for (let z = 7; z <= 19; z += 2) lanes.push(z)
  const litLane = r(0, 0x1a) % lanes.length
  lanes.forEach((z, i) => down.lamp(4, z, i === litLane))
  for (const [x, z] of [[1, 9], [1, 15], [3, 6], [2, 26], [5, 25]]) down.lamp(x, z, true)
  down.lamp(6, 10, false)
  down.lamp(7, 17, true)
  // Market hall: bright, a fixture over every other aisle.
  for (let x = 8; x <= 26; x += 4) for (let z = 16; z <= 24; z += 4) down.lamp(x, z, true)
  for (let x = 9; x <= 26; x += 4) {
    down.lamp(x, 13, true)
    down.lamp(x, 26, true)
  }
  // Warehouse: the dim layer. The main aisle is lit; the rack aisles keep a
  // scatter of working high-bays.
  for (let z = 1; z <= 12; z += 3) down.lamp(17, z, true)
  let n = 0
  for (const z of [1, 3, 5, 7, 9, 11]) for (const x of [9, 12, 15, 20, 23, 26]) down.lamp(x, z, r(n++, 0x1b) % 4 === 0)
  return { lanes, litLane, rackRuns: [[10, 16], [19, 24]] }
}

function furnishHallWest(map, r, rackCells) {
  // Gondola runs: x 9, 11 … 25, z 15..24, back-to-back shelving; flat-pack
  // pallets stand at some run ends.
  let pallets = 0
  for (let x = 9; x <= 25; x += 2) {
    for (let z = 15; z <= 24; z++) {
      const end = z === 15 || z === 24
      if (end && r(x, z) % 3 === 0) {
        for (const dz of [-0.65, 0.65]) put(map, DOWN, x, z, PROP_FLATPACK, FACING.E, 0, dz)
        pallets++
      } else {
        for (const dz of [-0.62, 0.62]) {
          put(map, DOWN, x, z, FURN_BOOKSHELF, FACING.W, -0.2, dz)
          put(map, DOWN, x, z, FURN_BOOKSHELF, FACING.E, 0.2, dz)
        }
      }
    }
  }
  // Pallet racks between the piers, facing both aisles.
  for (const [x, z] of rackCells) {
    for (const dx of [-0.6, 0.6]) {
      put(map, DOWN, x, z, FURN_RACK, FACING.N, dx, -0.38)
      put(map, DOWN, x, z, FURN_RACK, FACING.S, dx, 0.38)
    }
  }
  // Till counters: three cells per counter row, two counters per cell.
  for (let z = 8; z <= 18; z += 2) {
    for (let x = 3; x <= 5; x++) for (const dx of [-0.68, 0.68]) put(map, DOWN, x, z, FURN_COUNTER, FACING.N, dx, 0)
  }
  // Bag bins past the tills and at both stair mouths (single cells of
  // 2-wide strips, so nothing is cut off).
  // (5, 6) has its wall to the east: the strip runs on west of it.
  for (const [x, z, wall] of [[1, 8, 'W'], [1, 12, 'W'], [1, 16, 'W'], [5, 6, 'E'], [1, 26, 'W']]) {
    addPiece(map, DOWN, { gx: x, gz: z, kind: PROP_BAG_BIN, front: WALL_TO_FRONT[wall], wall })
  }
  return { pallets }
}

function openFront(map, rect) {
  for (let x = rect.x0; x <= rect.x1; x++) map.setWallH(x, UP, rect.z1 + 1, 0, PASSAGE_WIDE)
}

// A hand-dressed one-off vignette. Wardrobes line the back and side walls
// (the interior and the front row stay free); the lighting department sets
// tables on odd cells, each under its own lit fixture.
function department(map, rect, dept) {
  const role = dept === 'wardrobes' ? SPACE_ROLE_BEDROOM : SPACE_ROLE_LIVING
  const room = createRoom(map, { cy: UP, ...rect, role, salt: 0 })
  clearRoomObjects(map, room)
  const w = rect.x1 - rect.x0 + 1
  const depth = rect.z1 - rect.z0 + 1
  map.setLamp((rect.x0 + rect.x1) >> 1, UP, (rect.z0 + rect.z1) >> 1, true, WARM)
  for (let dz = 0; dz < depth - 1; dz++) {
    for (let dx = 0; dx < w; dx++) {
      const gx = rect.x0 + dx
      const gz = rect.z0 + dz
      if (dept === 'wardrobes') {
        const wall = dz === 0 ? 'N' : dx === 0 ? 'W' : dx === w - 1 ? 'E' : null
        if (wall) addPiece(map, UP, { gx, gz, kind: FURN_WARDROBE, front: WALL_TO_FRONT[wall], wall })
      } else if (dx % 2 === 1 && dz % 2 === 1) {
        put(map, UP, gx, gz, FURN_TABLE, FACING.S, 0, 0)
        map.setLamp(gx, UP, gz, true, WARM)
      }
    }
  }
  openFront(map, rect)
  return { rect, room, role: room.role, mode: dept, mutation: null }
}
