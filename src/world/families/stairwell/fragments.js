import {
  CELL_CORRIDOR,
  CELL_OPEN,
  CHUNK,
  FACING,
  PASSAGE_DOOR,
  SPACE_ROLE_ARCHIVE,
  SPACE_ROLE_BATHROOM,
  SPACE_ROLE_COPY,
  SPACE_ROLE_OFFICE,
  SPACE_ROLE_SERVER,
  SPACE_ROLE_STORAGE,
} from '../../tiles/floorPlan.js'
import { FURN_BOOKSHELF, FURN_CABINET, FURN_COPIER, FURN_DESK, FURN_RACK, FURN_SINK, FURN_TABLE, FURN_TOILET } from '../../rooms/catalog.js'
import { PROP_CART, PROP_DOORSTOP, PROP_DUMPSTER, PROP_FLATPACK, PROP_WHEELIE_BIN } from '../../props/index.js'

// The stairwell's fragment grammar (doc §4.2, §4.3). Each landing's
// fragment is GENERATED from a parts catalogue inside its SITE (geometry.js
// fragmentSite: up to ~10 × 12 cells on the door's side of the core, cut by
// the landing's share of the storey), so it is a glimpse of a floor, never a
// floor:
//
//   vestibule  two 1-wide cells out of the fire door, held mass either side,
//              a second door at the far end (the sound lock of doc §4.2): the
//              same few metres behind every fire door of the map;
//   corridor   the doc's default stub: a 1- or 2-wide corridor straight out
//              of the vestibule (now and then an arm or a tee), 4–5 locked
//              rooms of the run's module and one open office off it (the
//              office alone grows into the share the others leave), then
//              service cupboards (2 × 2, 1 × 1) in the corridor's leftover
//              sides and a janitor's closet at a dead end;
//   toilets    a short lobby with washrooms of one size and a cleaner's store
//              or two;
//   closets    a narrow passage of small stores, all of one size;
//   office     the single office: a short lobby, one furnished office, a few
//              locked rooms and stores;
//   plant      a plant room of about 6 × 8 grown square in front of the door
//              (doc §4.3 "racks as machinery, standard posts"): rack rows,
//              switchgear on its walls, a post, two riser cupboards;
//   carpark    (now and then) a deck of about 10 × 10 round the core with
//              posts every 3 cells, bay lamps that fail a row at a time,
//              storage cages, one stair/lift block, bins, a skip, a trolley.
//
// Locked rooms are fitted mirror-true (sideFit): two rooms of one size are
// the same room whichever side of a corridor they open from. Cupboards stay
// bare and dark.
//
// Three dice drive a fragment. The BUILDING's (district, band) choose each
// kind's module and its use, so every corridor of the building opens on the
// same rooms (doc 12's repeated units). `r` is the RUN's (district, band,
// shaft, run): the stub and every room's place come from it, so the storeys of a run
// are near-copies of each other (doc §1: "every storey is a near-copy of the
// last"). `m` is the STOREY's: one room missing, a dead tube, a wedge in a
// closet door, a failing bay row, a machine row gone — the small differences
// that are felt before they are understood.
//
// A StoreyGrid holds the storey's cells: which are buildable, and which
// fragment owns each built cell. Two fragments never touch (a fragment's cell
// may not be 4-adjacent to another owner's), so landings stay separate
// pockets joined only by the stairs and the routed rungs.

const DX = [1, -1, 0, 0]
const DZ = [0, 0, 1, -1]
const dirOf = (n) => (n[0] === 1 ? 0 : n[0] === -1 ? 1 : n[1] === 1 ? 2 : 3)

export class StoreyGrid {
  // Global cells x0..x0+W−1 × z0..z0+H−1; ok(gx, gz) → buildable at all.
  constructor({ x0, z0, W, H, ok }) {
    this.x0 = x0
    this.z0 = z0
    this.W = W
    this.H = H
    this.ok = new Uint8Array(W * H)
    this.occ = new Int16Array(W * H)
    this.corr = new Uint8Array(W * H)
    for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) this.ok[z * W + x] = ok(x0 + x, z0 + z) ? 1 : 0
  }

  idx(gx, gz) {
    const x = gx - this.x0
    const z = gz - this.z0
    return x < 0 || z < 0 || x >= this.W || z >= this.H ? -1 : z * this.W + x
  }

  owner(gx, gz) {
    const i = this.idx(gx, gz)
    return i < 0 ? 0 : this.occ[i]
  }

  // May owner o build cell (gx, gz)? Buildable, unowned, and no other
  // owner's cell beside it.
  free(o, gx, gz) {
    const i = this.idx(gx, gz)
    if (i < 0 || !this.ok[i] || this.occ[i]) return false
    for (let d = 0; d < 4; d++) {
      const v = this.owner(gx + DX[d], gz + DZ[d])
      if (v && v !== o) return false
    }
    return true
  }

  take(o, gx, gz, corridor = false) {
    const i = this.idx(gx, gz)
    this.occ[i] = o
    if (corridor) this.corr[i] = 1
  }

  isCorr(o, gx, gz) {
    const i = this.idx(gx, gz)
    return i >= 0 && this.occ[i] === o && this.corr[i] === 1
  }
}

// --- styles ------------------------------------------------------------------------

// A run's style: the module and the stub a kind keeps for its whole run of
// storeys (r: the run's dice). `room` is [wide, deep]: wide along the
// corridor the door is in, deep away from it. The stub: `cw` wide, `len`
// cells out of the vestibule, an `arm` ('left', 'right' or a 'tee') `armAt`
// cells out (or at its end), `armLen` long, on the run's `hand`. `max` rooms
// of the module (the largest the open one), `closets` small stores.
export function runStyle(kind, r, b = r) {
  const pick = (list, i) => list[r(i) % list.length]
  // The building's dice `b` choose the module and its use: every run of a
  // kind in one building opens on the same rooms (doc §4.3, doc 12's
  // repeated units), its stub and share its own.
  const bpick = (list, i) => list[b(i) % list.length]
  const stub = {
    hand: r(20) % 2,
    arm: pick(['none', 'none', 'left', 'right', 'tee'], 21),
    armAt: pick([1, 2, 99], 22),
    armLen: 2 + (r(23) % 3),
  }
  switch (kind) {
    case 'corridor':
    case 'wing': {
      // `use`: what the run's module rooms are (doc §4.3: a corridor of
      // identical doors; offices most often, archives, stores, risers).
      const use = bpick([SPACE_ROLE_OFFICE, SPACE_ROLE_OFFICE, SPACE_ROLE_ARCHIVE, SPACE_ROLE_STORAGE, SPACE_ROLE_SERVER, SPACE_ROLE_COPY], 15)
      return { ...stub, cw: pick([1, 2, 2], 3), len: 5 + (r(5) % 4), room: [bpick([4, 4, 5], 1), bpick([4, 4, 5], 1)], max: 5 + (r(6) % 2), closets: 4 + (r(7) % 2), use, budget: 120 + (r(17) % 21), cap: 36, lit: r(13) % 3 !== 0 }
    }
    case 'closets':
      return { ...stub, cw: 1, len: 6 + (r(5) % 4), room: [2, bpick([3, 3, 4], 1)], max: 9 + (r(6) % 3), closets: 2 + (r(7) % 2), budget: 105 + (r(17) % 21), cap: 16, side: 4, minArea: 2, lit: r(13) % 3 !== 0 }
    case 'toilets':
      return { ...stub, cw: 1, len: 4 + (r(5) % 3), arm: pick(['none', 'tee', 'tee', 'left', 'right'], 21), room: [3, bpick([4, 5], 1)], max: 5 + (r(6) % 2), closets: 3 + (r(7) % 2), budget: 110 + (r(17) % 21), cap: 30, lit: true }
    case 'office':
      return { ...stub, cw: pick([1, 2], 3), len: 3 + (r(5) % 2), arm: 'none', room: [bpick([4, 4, 5], 1), bpick([4, 4, 5], 1)], max: 4 + (r(6) % 2), closets: 3 + (r(7) % 2), budget: 110 + (r(17) % 21), cap: 36, lit: true, use: bpick([SPACE_ROLE_OFFICE, SPACE_ROLE_OFFICE, SPACE_ROLE_ARCHIVE, SPACE_ROLE_STORAGE, SPACE_ROLE_SERVER, SPACE_ROLE_COPY], 15) }
    case 'plant':
      // A plant room of about 5 × 6 to 7 × 8 in front of the door (doc
      // §4.3: "racks as machinery, standard posts"): rack rows, switchgear
      // on the walls, two identical riser cupboards of the building's size.
      return { room: [2, bpick([2, 3], 1)], rooms: 2, posts: 4, lamps: 3, rows: 2, seg: 2 + (r(9) % 2), gap: 1 + (r(11) % 2), axis: r(4) % 2, budget: 58 + (r(17) % 15), cabinets: 2 + (r(12) % 2), site: 'room', reach: 4 }
    default:
      // The car-park deck round the core (doc §4.3: about 10 × 10, posts
      // every 3 cells): tenant storage cages of the building's size against
      // its walls, one stair/lift block, bins, a skip and a trolley or two.
      return { posts: 3, cores: 4, cages: 2 + (r(6) % 2), cage: [2, bpick([2, 2, 3], 2)], lamps: null, budget: 110 + (r(17) % 31), clutter: 5 + (r(7) % 3), site: false }
  }
}

// --- shared pieces -----------------------------------------------------------------

// The door edge between cell (gx, gz) and its neighbour in direction d.
const doorEdge = (gx, gz, d) =>
  d === 0 ? { axis: 'v', gx: gx + 1, gz } : d === 1 ? { axis: 'v', gx, gz } : d === 2 ? { axis: 'h', gx, gz: gz + 1 } : { axis: 'h', gx, gz }

const area = (q) => (q.x1 - q.x0 + 1) * (q.z1 - q.z0 + 1)
const centre = (q) => [Math.floor((q.x0 + q.x1) / 2), Math.floor((q.z0 + q.z1) / 2)]

// The vestibule (doc §4.2): the door cell and the next, 1 wide, with the
// cells either side held as mass, and a second door onto the entry cell, the
// fragment's first. Returns the entry cell, or null when the claim cannot
// hold it (the fragment is then the door cell alone).
function vestibule(f) {
  const { G, plan, o, out, n } = f
  const t = [n[1], n[0]]
  const v = [[out.x, out.z], [out.x + n[0], out.z + n[1]], [out.x + 2 * n[0], out.z + 2 * n[1]]]
  for (const [x, z] of v) if (!f.inClaim(x, z) || !(G.free(o, x, z) || G.isCorr(o, x, z))) return null
  for (const [x, z] of v) {
    if (!G.isCorr(o, x, z)) G.take(o, x, z, true)
    plan.open(x, z, CELL_CORRIDOR)
  }
  for (const [x, z] of v.slice(0, 2)) {
    for (const s of [1, -1]) {
      const sx = x + t[0] * s
      const sz = z + t[1] * s
      if (G.free(o, sx, sz)) G.take(o, sx, sz)
    }
  }
  const e = doorEdge(v[1][0], v[1][1], dirOf(n))
  plan.edge(e.axis, e.gx, e.gz, 0, PASSAGE_DOOR)
  return v[2]
}

// Plan the rooms (spaceIds in order) and their doors.
function emitRooms(f, rooms) {
  for (const q of rooms) {
    q.spaceId = f.ids.next++
    f.plan.room(q, { spaceId: q.spaceId, role: q.role, doors: [q.door] })
  }
}

// A furnished room for createRoom (which furnishes; its centre tube is
// planned here: lit while the chunk's budget lasts, dead after).
function furnish(f, q) {
  const [gx, gz] = centre(q)
  if (!f.lamp(gx, gz, f.lit(true))) f.lamp(gx, gz, false)
  f.jobs.rooms.push({ x0: q.x0, z0: q.z0, x1: q.x1, z1: q.z1, role: q.role, door: q.door })
}

// Tubes: every room of four cells and up in `furnish` is furnished (its
// centre tube with it), the largest first; then the rooms in `plain` (the
// washrooms, the locked rooms of a lit run), largest first, and the corridor
// cells' (one per cell with no tube within three cells). With a whole-class
// budget (lamp.fits: the kind lab, which has no fill pass) the corridor goes
// first and a size class of rooms gets its tubes only when the whole class
// fits, so rooms of one module stay identical, lit or not; in the world the
// rooms go first, each while the chunk's budget lasts (the fill pass lights
// the circulation the tubes leave dark). The storey's dice kill one corridor
// tube now and then.
function lightRooms(f, furnishRooms, corridor, plain = []) {
  const dead = f.m(40) % 3 === 0 ? f.m(41) % 12 : -1
  let k = 0
  const tube = (gx, gz) => f.lamp(gx, gz, f.lit(k++ !== dead))
  const bySize = (list) => [...list].filter((q) => area(q) >= 4).sort((a, b) => area(b) - area(a) || a.x0 - b.x0 || a.z0 - b.z0)
  for (const q of bySize(furnishRooms)) furnish(f, q)
  const corridorTubes = () => {
    const placed = []
    for (const [gx, gz] of corridor) {
      if (placed.some(([x, z]) => Math.max(Math.abs(x - gx), Math.abs(z - gz)) <= 3)) continue
      if (tube(gx, gz)) placed.push([gx, gz])
    }
  }
  if (!f.lamp.fits) {
    for (const q of bySize(plain)) f.lamp(...centre(q), f.lit(true))
    corridorTubes()
    return
  }
  corridorTubes()
  const classes = new Map()
  for (const q of bySize(plain)) {
    const key = `${q.x1 - q.x0}x${q.z1 - q.z0}`
    if (!classes.has(key)) classes.set(key, [])
    classes.get(key).push(q)
  }
  for (const group of classes.values()) {
    const at = group.map(centre)
    const on = f.lit(true)
    if (on && !f.lamp.fits(at)) continue
    for (const c of at) f.lamp(...c, on)
  }
}

// Rooms off the corridor, one at a time up to `max` (doc §4.3: a few doors):
// each the rectangle beside a corridor cell (its door in the near wall, at
// most `side` across and deep, at most `cap` cells, every cell free share)
// whose area is nearest the share of the budget still to fill per room left
// (`budget − used`, spread over the rooms to come), squarer and nearer the
// entry first, ties to the run's dice. So the run's rooms come out alike
// and the fragment fills its ~10 × 10 without more doors. A summed-area
// table over the corridor's window keeps every rectangle test O(1).
// Rooms are reserved on the grid and returned unplanned.
function fillRooms(f, corridor, { max, cap, side = 6, role, budget, used, salt, minArea = 4, module = null }) {
  const { G, o, r } = f
  if (!corridor.length || max <= 0) return []
  let x0 = Infinity
  let x1 = -Infinity
  let z0 = Infinity
  let z1 = -Infinity
  for (const [x, z] of corridor) {
    x0 = Math.min(x0, x - side); x1 = Math.max(x1, x + side)
    z0 = Math.min(z0, z - side); z1 = Math.max(z1, z + side)
  }
  const W = x1 - x0 + 1
  const H = z1 - z0 + 1
  const ok = new Uint8Array(W * H)
  for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) ok[z * W + x] = f.inClaim(x0 + x, z0 + z) && G.free(o, x0 + x, z0 + z) ? 1 : 0
  const S = new Int32Array((W + 1) * (H + 1))
  const table = () => {
    for (let z = 0; z < H; z++) {
      let row = 0
      for (let x = 0; x < W; x++) {
        row += ok[z * W + x]
        S[(z + 1) * (W + 1) + x + 1] = S[z * (W + 1) + x + 1] + row
      }
    }
  }
  // Every cell of [ax..bx] × [az..bz] (global, inclusive) free?
  const full = (ax, bx, az, bz) => {
    const a = ax - x0
    const b = bx - x0
    const c = az - z0
    const d = bz - z0
    if (a < 0 || c < 0 || b >= W || d >= H) return false
    return S[(d + 1) * (W + 1) + b + 1] - S[c * (W + 1) + b + 1] - S[(d + 1) * (W + 1) + a] + S[c * (W + 1) + a] === (b - a + 1) * (d - c + 1)
  }
  // The module's family: the module, one cell narrower or shallower, both,
  // and the module turned (the sizes a run's rooms come in, so rooms of a
  // fragment repeat each other).
  const sizes = []
  if (module) {
    const [mw, md] = module
    for (const q of [[mw, md], [mw - 1, md], [mw, md - 1], [mw - 1, md - 1], [md, mw], [mw, md + 1], [mw + 1, md]]) {
      if (q[0] >= 1 && q[1] >= 1 && q[0] * q[1] >= minArea && q[0] * q[1] <= cap) sizes.push(q)
    }
  }
  const rooms = []
  let n = used
  const [ex, ez] = corridor[0]
  const tiers = module && module[0] * module[1] <= cap ? [true, false] : [false]
  // Sizes already laid: a room that cannot take the module takes the size
  // the last such room took, so the fragment holds two classes, not five.
  const had = new Set()
  while (rooms.length < max && n < budget) {
    table()
    const want = Math.max(minArea, Math.min(cap, Math.round((budget - n) / (max - rooms.length))))
    let best = null
    for (const exact of tiers) {
      if (best) break
      for (const [cx, cz] of corridor) {
        for (let d = 0; d < 4; d++) {
          const nx = cx + DX[d]
          const nz = cz + DZ[d]
          if (!full(nx, nx, nz, nz)) continue
          // Along: the corridor's axis at this cell; deep: direction d.
          const ax = d < 2 ? 0 : 1
          const az = d < 2 ? 1 : 0
          for (let deep = 1; deep <= side; deep++) {
            const fx = nx + DX[d] * (deep - 1)
            const fz = nz + DZ[d] * (deep - 1)
            if (!full(Math.min(nx, fx), Math.max(nx, fx), Math.min(nz, fz), Math.max(nz, fz))) break
            for (let lo = 0; lo < side; lo++) {
              for (let hi = 0; lo + hi + 1 <= side; hi++) {
                const wide = lo + hi + 1
                const A = wide * deep
                if (A > cap) break
                if (A < minArea) continue
                const qx0 = Math.min(nx, fx) - ax * lo
                const qx1 = Math.max(nx, fx) + ax * hi
                const qz0 = Math.min(nz, fz) - az * lo
                const qz1 = Math.max(nz, fz) + az * hi
                if (!full(qx0, qx1, qz0, qz1)) break
                const aspect = Math.max(wide, deep) / Math.min(wide, deep)
                // Only the module's sizes (a corridor of identical doors, doc
                // §4.3): the module itself wherever it fits, else the room
                // nearest the share still to fill among its family.
                if (module && !(exact ? wide === module[0] && deep === module[1] : sizes.some(([a, b]) => a === wide && b === deep))) continue
                const score = (lo === 0 || hi === 0 ? 3 : 0) + (had.has(wide * 64 + deep) ? 24 : 0) - 4 * Math.abs(A - want) - 3 * Math.max(0, aspect - 2) * A / 4 - (Math.abs(cx - ex) + Math.abs(cz - ez)) / 4 + (r(salt + qx0 * 7 + qz0 * 131, 600 + wide * 8 + deep) % 4) / 8
                if (!best || score > best.score) best = { score, q: { x0: qx0, x1: qx1, z0: qz0, z1: qz1, door: doorEdge(cx, cz, d), d, role } }
              }
            }
          }
        }
      }
    }
    if (!best) break
    const q = best.q
    for (let z = q.z0; z <= q.z1; z++) {
      for (let x = q.x0; x <= q.x1; x++) {
        G.take(o, x, z)
        ok[(z - z0) * W + x - x0] = 0
      }
    }
    // Two rooms never share a door cell's corridor side twice over: the
    // cells beside the new room stay free for the next one.
    rooms.push(q)
    had.add((q.d < 2 ? q.z1 - q.z0 + 1 : q.x1 - q.x0 + 1) * 64 + (q.d < 2 ? q.x1 - q.x0 + 1 : q.z1 - q.z0 + 1))
    n += area(q)
  }
  return rooms
}

// Pack rooms along the spine, in laying order: for each corridor cell and
// side (the run's side order), a rect of the first size in `sizes` that fits
// (`wide` along the corridor, `deep` away from it, the door in its near
// wall), scanned from the cell so a straight corridor gets a regular row of
// identical doors. Rooms are reserved on the grid and returned unplanned.
function packRooms(f, spineCells, { sizes, role, salt, max = Infinity }) {
  const { G, o, r } = f
  const rooms = []
  const base = r(salt, 500) % 4
  for (const [cx, cz] of spineCells) {
    for (let k = 0; k < 4 && rooms.length < max; k++) {
      const d = (k + base) % 4
      const nx = cx + DX[d]
      const nz = cz + DZ[d]
      if (!f.inClaim(nx, nz) || !G.free(o, nx, nz)) continue
      let placed = null
      for (const [wide, deep] of sizes) {
        for (let off = 0; off < wide && !placed; off++) {
          let x0, x1, z0, z1
          if (d < 2) {
            x0 = d === 0 ? nx : nx - deep + 1
            x1 = x0 + deep - 1
            z0 = nz - off
            z1 = z0 + wide - 1
          } else {
            z0 = d === 2 ? nz : nz - deep + 1
            z1 = z0 + deep - 1
            x0 = nx - off
            x1 = x0 + wide - 1
          }
          let fits = true
          for (let z = z0; z <= z1 && fits; z++) for (let x = x0; x <= x1 && fits; x++) if (!f.inClaim(x, z) || !G.free(o, x, z)) fits = false
          if (fits) placed = { x0, x1, z0, z1 }
        }
        if (placed) break
      }
      if (!placed) continue
      for (let z = placed.z0; z <= placed.z1; z++) for (let x = placed.x0; x <= placed.x1; x++) G.take(o, x, z)
      rooms.push({ ...placed, door: doorEdge(cx, cz, d), d, role })
    }
  }
  return rooms
}

// The band a room grows by: its back row (side 0), or one more column along
// its corridor at its far (1) or near (2) end.
function growBand(q, side) {
  if (side === 0) {
    return q.d === 0 ? { x0: q.x1 + 1, x1: q.x1 + 1, z0: q.z0, z1: q.z1 }
      : q.d === 1 ? { x0: q.x0 - 1, x1: q.x0 - 1, z0: q.z0, z1: q.z1 }
        : q.d === 2 ? { x0: q.x0, x1: q.x1, z0: q.z1 + 1, z1: q.z1 + 1 } : { x0: q.x0, x1: q.x1, z0: q.z0 - 1, z1: q.z0 - 1 }
  }
  const hi = side === 1
  return q.d < 2 ? { x0: q.x0, x1: q.x1, z0: hi ? q.z1 + 1 : q.z0 - 1, z1: hi ? q.z1 + 1 : q.z0 - 1 }
    : { x0: hi ? q.x1 + 1 : q.x0 - 1, x1: hi ? q.x1 + 1 : q.x0 - 1, z0: q.z0, z1: q.z1 }
}

// Grow rooms a size class at a time: every room of one size (wide along
// its corridor × deep) takes one more row at its back, or none does; classes
// largest-first, while the fragment is under budget.
function growClasses(f, rooms, budget, used, cap = 30) {
  const { G, o } = f
  const dims = (q) => (q.d < 2 ? [q.z1 - q.z0 + 1, q.x1 - q.x0 + 1] : [q.x1 - q.x0 + 1, q.z1 - q.z0 + 1])
  const band = growBand
  let n = used
  for (let changed = true; changed && n < budget;) {
    changed = false
    const classes = new Map()
    for (const q of rooms) {
      const k = dims(q).join('x')
      if (!classes.has(k)) classes.set(k, [])
      classes.get(k).push(q)
    }
    const order = [...classes.values()].sort((a, b) => area(b[0]) * b.length - area(a[0]) * a.length)
    for (const group of order) {
      const [wide, deep] = dims(group[0])
      if (n >= budget) break
      for (const side of [0, 1, 2]) {
        const [w2, d2] = side === 0 ? [wide, deep + 1] : [wide + 1, deep]
        if (w2 > 6 || d2 > 6 || w2 * d2 > cap || w2 > d2 + 2) continue
        const bands = group.map((q) => band(q, side))
        const fits = bands.every((b) => {
          for (let z = b.z0; z <= b.z1; z++) for (let x = b.x0; x <= b.x1; x++) if (!f.inClaim(x, z) || !G.free(o, x, z)) return false
          return true
        })
        // Two bands of one class may claim the same cells.
        const cells = new Set()
        for (const b of bands) for (let z = b.z0; z <= b.z1; z++) for (let x = b.x0; x <= b.x1; x++) cells.add(z * 4096 + x)
        const per = side === 0 ? wide : deep
        if (!fits || cells.size !== bands.length * per) continue
        group.forEach((q, i) => {
          const b = bands[i]
          for (let z = b.z0; z <= b.z1; z++) for (let x = b.x0; x <= b.x1; x++) G.take(o, x, z)
          q.x0 = Math.min(q.x0, b.x0)
          q.x1 = Math.max(q.x1, b.x1)
          q.z0 = Math.min(q.z0, b.z0)
          q.z1 = Math.max(q.z1, b.z1)
          n += per
        })
        changed = true
        break
      }
    }
  }
  return n
}

// Grow one room on its own (the open office): a row at its back or a column
// at either end along its corridor, whichever is free share, while it stays
// under `cap` cells and 7 across, never more than two cells longer than deep.
function growOne(f, q, cap) {
  const { G, o } = f
  for (let changed = true; changed;) {
    changed = false
    for (const side of [0, 1, 2]) {
      const b = growBand(q, side)
      const W = Math.max(q.x1, b.x1) - Math.min(q.x0, b.x0) + 1
      const D = Math.max(q.z1, b.z1) - Math.min(q.z0, b.z0) + 1
      if (W * D > cap || W > 7 || D > 7 || Math.max(W, D) > Math.min(W, D) + 2) continue
      let fits = true
      for (let z = b.z0; z <= b.z1 && fits; z++) for (let x = b.x0; x <= b.x1 && fits; x++) if (!f.inClaim(x, z) || !G.free(o, x, z)) fits = false
      if (!fits) continue
      for (let z = b.z0; z <= b.z1; z++) for (let x = b.x0; x <= b.x1; x++) G.take(o, x, z)
      q.x0 = Math.min(q.x0, b.x0)
      q.x1 = Math.max(q.x1, b.x1)
      q.z0 = Math.min(q.z0, b.z0)
      q.z1 = Math.max(q.z1, b.z1)
      changed = true
    }
  }
}

// The stores packed into the corridor's leftover sides (risers, cleaners'
// and service cupboards), the first size that fits: [wide, deep].
const CUPBOARDS = Object.freeze([[2, 2], [1, 1]])

// One-cell janitor closets beyond the stub's dead ends (at most `max`).
function endClosets(f, cells, max = Infinity) {
  const { G, o } = f
  const out = []
  for (const [x, z] of cells) {
    if (out.length >= max) break
    let nb = -1
    let deg = 0
    for (let d = 0; d < 4; d++) {
      if (G.isCorr(o, x + DX[d], z + DZ[d])) {
        deg++
        nb = d
      }
    }
    if (deg !== 1) continue
    const d = nb ^ 1
    const gx = x + DX[d]
    const gz = z + DZ[d]
    if (!f.inClaim(gx, gz) || !G.free(o, gx, gz)) continue
    G.take(o, gx, gz)
    out.push({ x0: gx, x1: gx, z0: gz, z1: gz, door: doorEdge(x, z, d), d, role: SPACE_ROLE_STORAGE })
  }
  return out
}


// The stub (doc §4.3 "corridor stub"): corridor cells out of the entry,
// `cw` wide and up to `len` long: straight out along the door's normal, or
// turning once (at the entry, a lobby corridor along the core's wall, or a
// few cells out) to either hand, then the run's arm across its end or side.
// Every candidate is laid only where its whole row fits the share; the one
// whose corridor overlooks the most free share (cells within three of it,
// where its rooms go) wins, ties to the run's hand. So a landing whose door
// faces a near chunk edge or a neighbour's share turns along its core, and
// one facing open floor runs straight out. Returns the corridor cells laid
// (the entry first).
function stub(f, entry) {
  const { G, plan, o, style: st } = f
  const n = f.n
  // The window round the entry the stub and its rooms can reach, with each
  // cell's availability (in the share, buildable by this fragment).
  const R = st.len + 12
  const wx0 = entry[0] - R
  const wz0 = entry[1] - R
  const WW = 2 * R + 1
  const avail = new Uint8Array(WW * WW)
  for (let z = 0; z < WW; z++) {
    for (let x = 0; x < WW; x++) {
      const gx = wx0 + x
      const gz = wz0 + z
      avail[z * WW + x] = f.inClaim(gx, gz) && (G.free(o, gx, gz) || G.isCorr(o, gx, gz)) ? 1 : 0
    }
  }
  const idx = (x, z) => {
    const i = x - wx0
    const j = z - wz0
    return i < 0 || j < 0 || i >= WW || j >= WW ? -1 : j * WW + i
  }
  const can = (x, z) => {
    const i = idx(x, z)
    return i >= 0 && avail[i] === 1
  }
  const stamp = new Int32Array(WW * WW)
  let gen = 0
  const trace = (turns, h, side, cw, len) => {
    const t = [n[1] * h, n[0] * h]
    const back = [-n[0], -n[1]]
    const lanes = cw === 2 ? [0, side] : [0]
    gen++
    const out = []
    const add = (row) => {
      for (const [x, z] of row) {
        const i = idx(x, z)
        if (stamp[i] !== gen) {
          stamp[i] = gen
          out.push([x, z])
        }
      }
    }
    stamp[idx(entry[0], entry[1])] = gen
    let px = entry[0]
    let pz = entry[1]
    let dir = n
    let laid = 0
    const heads = []
    for (let k = 0; k < len; k++) {
      if (k === turns[0]) dir = t
      if (k === turns[1]) dir = back
      const a = [dir[1], dir[0]]
      const row = lanes.map((v) => [px + a[0] * v, pz + a[1] * v])
      if (!row.every(([x, z]) => can(x, z))) break
      add(row)
      heads.push([px, pz, dir])
      laid++
      px += dir[0]
      pz += dir[1]
    }
    // The arm: across the stub `armAt` cells along it (or at its end).
    if (st.arm !== 'none' && laid >= 2) {
      const [bx, bz, d0] = heads[Math.min(st.armAt, laid - 1)]
      const sides = st.arm === 'tee' ? [1, -1] : st.arm === 'right' ? [1] : [-1]
      for (const sgn of sides) {
        const a = [d0[1] * sgn, d0[0] * sgn]
        for (let k = 1; k <= st.armLen + (cw - 1); k++) {
          const row = lanes.map((v) => [bx + a[0] * k + d0[0] * Math.abs(v), bz + a[1] * k + d0[1] * Math.abs(v)])
          if (!row.every(([x, z]) => can(x, z))) break
          add(row)
        }
      }
    }
    return out
  }
  // The free share within four cells of the corridor (where its rooms go).
  const near = new Int32Array(WW * WW)
  let gen2 = 0
  const reach = (cells) => {
    gen2++
    let c = 0
    for (const [x, z] of cells) {
      for (let dz = -4; dz <= 4; dz++) {
        for (let dx = -4; dx <= 4; dx++) {
          const i = idx(x + dx, z + dz)
          if (i < 0 || near[i] === gen2 || !avail[i]) continue
          near[i] = gen2
          c++
        }
      }
    }
    return c
  }
  let best = null
  const hand = st.hand ? 1 : -1
  const want = st.budget ?? 100
  // Straight, one turn (along the core's wall), or two (round its corner);
  // either hand, the second lane either side, the run's width or one.
  const plans = [[[99, 99], st.len], [[0, 99], st.len], [[1, 99], st.len], [[2, 99], st.len], [[3, 99], st.len]]
  for (const a of [0, 1, 2]) for (const b of [4, 6, 8]) plans.push([[a, a + b], st.len + 4])
  for (const cw of st.cw === 2 ? [2, 1] : [1]) {
    for (const [turns, len] of plans) {
      for (const h of [hand, -hand]) {
        for (const side of cw === 2 ? [1, -1] : [1]) {
          const cells = trace(turns, h, side, cw, len)
          // Enough share for the budget, then the shortest corridor; the
          // run's own width and hand first.
          const score = Math.min(reach(cells), want * 1.4) * 8 - cells.length - (cw !== st.cw ? 6 : 0) - (h !== hand ? 1 : 0)
          if (!best || score > best.score) best = { score, cells }
        }
      }
    }
  }
  const cells = [entry]
  for (const [x, z] of best.cells) {
    if (G.isCorr(o, x, z)) continue
    G.take(o, x, z, true)
    plan.open(x, z, CELL_CORRIDOR)
    cells.push([x, z])
  }
  return cells
}

// A branch off a stub that fell short of its budget (its share pinched by a
// core, a chunk edge or a neighbour's share): a 1-wide corridor straight out
// of one of the stub's cells, up to 6 long, towards the most free share
// (cells within three of it). Returns the cells laid, or [] when no branch
// overlooks at least `min` free cells.
function branch(f, cells, min = 18) {
  const { G, plan, o } = f
  const free = (x, z) => f.inClaim(x, z) && G.free(o, x, z)
  let best = null
  for (const [cx, cz] of cells) {
    for (let d = 0; d < 4; d++) {
      const run = []
      for (let k = 1; k <= 6; k++) {
        const x = cx + DX[d] * k
        const z = cz + DZ[d] * k
        if (!free(x, z)) break
        run.push([x, z])
      }
      if (run.length < 3) continue
      const seen = new Set()
      for (const [x, z] of run) {
        for (let b = -3; b <= 3; b++) {
          for (let a = -3; a <= 3; a++) {
            const k = (z + b) * 4096 + x + a
            if (!seen.has(k) && free(x + a, z + b)) seen.add(k)
          }
        }
      }
      const score = seen.size * 4 - run.length
      if (!best || score > best.score) best = { score, run, n: seen.size }
    }
  }
  if (!best || best.n < min) return []
  for (const [x, z] of best.run) {
    G.take(o, x, z, true)
    plan.open(x, z, CELL_CORRIDOR)
  }
  return best.run
}

// A fragment floor off its stub: up to `max` rooms of the module's sizes
// both sides (and off up to four branches when the stub fell short of its
// share); rooms of one size then grow alike; the storey's dice drop one room
// (mass behind a plain wall). In an office run the largest room is the open,
// furnished office of doc §4.3 (lit), which alone grows on, the others locked
// rooms of the building's use, each fitted down its side walls alike. Then
// `closets` cupboards in the corridor's leftover sides and one janitor closet
// at a dead end, whose door the storey's dice may wedge.
// `skip` leading cells already have their tubes (the entry, a rung). Returns
// counts.
function fragmentFloor(f, cells, role, skip = 1) {
  const st = f.style
  let used = 3 + cells.length
  const budget = st.budget ?? used + (st.max ?? 4) * 12
  const opts = { cap: st.cap ?? 24, side: st.side ?? 6, role, budget, salt: 2, minArea: st.minArea ?? 4, module: st.room ?? null }
  const all = fillRooms(f, cells, { ...opts, max: st.max ?? 4, used })
  used += all.reduce((t, q) => t + area(q), 0)
  // Short of the budget: one branch into the share the stub missed, with
  // the rooms still to come off it (at least one).
  for (let k = 0; k < 4 && skip === 1 && used < budget * 0.95; k++) {
    const more = branch(f, cells, 10)
    if (!more.length) break
    cells = [...cells, ...more]
    used += more.length
    const got = fillRooms(f, more, { ...opts, max: Math.max(1, (st.max ?? 4) - all.length), used, salt: 5 + k })
    used += got.reduce((t, q) => t + area(q), 0)
    all.push(...got)
  }
  // Rooms grow a class at a time (rooms of one size grow together or not
  // at all), so the run's rooms stay alike while they fill the share.
  growClasses(f, all, st.budget ?? 0, used, st.cap ?? 24)
  const drop = all.length > 3 && f.m(1) % 5 < 2 ? f.m(2) % all.length : -1
  const rooms = all.filter((_, i) => i !== drop)
  if (role === SPACE_ROLE_OFFICE) {
    const use = st.use ?? SPACE_ROLE_OFFICE
    const big = rooms.reduce((b, q) => (!b || area(q) > area(b) ? q : b), null)
    // The open office is the one room of its kind: it alone grows on into
    // the share its locked neighbours leave (doc §4.3 "1 open office").
    if (big) growOne(f, big, st.openCap ?? 42)
    for (const q of rooms) q.role = q === big ? SPACE_ROLE_OFFICE : area(q) <= 4 ? SPACE_ROLE_STORAGE : use
  }
  // Then the cupboards in the corridor's leftover sides, and the janitor's
  // closet at a dead end.
  const closets = [...packRooms(f, cells, { sizes: CUPBOARDS, role: SPACE_ROLE_STORAGE, salt: 3, max: st.closets ?? 2 }), ...endClosets(f, cells, 1)]
  emitRooms(f, [...rooms, ...closets])
  const open = role === SPACE_ROLE_OFFICE ? rooms.filter((q) => q.role === SPACE_ROLE_OFFICE).slice(0, 1) : []
  // A fit needs a free row in front of it: never in a room one cell deep.
  const deep = (q) => (q.d < 2 ? q.x1 - q.x0 : q.z1 - q.z0) >= 1
  for (const q of rooms) {
    if (!open.includes(q) && deep(q) && !sideFit(f, q, FIT[q.role][0])) backWall(f, q, ...FIT[q.role])
  }
  // Tubes: the open office's, the corridor's, then (a class at a time, while
  // the chunk's budget lasts) the washrooms, and in a lit run every locked
  // room of six cells and up; the cupboards stay dark.
  const plain = role === SPACE_ROLE_BATHROOM ? rooms : st.lit ? rooms.filter((q) => !open.includes(q) && area(q) >= 6) : []
  lightRooms(f, open, cells.slice(skip), plain)
  // The tell: a wedge holding one janitor closet's door (someone is on this
  // floor); only one-cell closets, where the door cell is the wedge cell.
  const janitor = closets.filter((q) => q.x0 === q.x1 && q.z0 === q.z1)
  if (janitor.length && f.m(3) % 3 === 0) {
    const q = janitor[f.m(4) % janitor.length]
    f.jobs.pieces.push({ gx: q.x0, gz: q.z0, kind: PROP_DOORSTOP, wall: ['W', 'E', 'N', 'S'][q.d] })
  }
  return { rooms: rooms.length, closets: closets.length, corridor: cells.length, dropped: drop >= 0 }
}

// --- decks (office, plant, car park) ------------------------------------------------

// The claim's buildable cells flooded from the entry: mark 1 = deck, 2 = blocked
// (post, rack), 3 = room, 4 = cut (held mass). `keep` is the entry's
// approach (three cells deep, three wide), which stays open deck.
function deckOf(f, entry, n) {
  const { G, o } = f
  const q = f.site
  const inSite = (x, z) => !q || f.style.site !== true || (x >= q.x0 && x <= q.x1 && z >= q.z0 && z <= q.z1)
  const budget = f.style.budget ?? Infinity
  const flood = (allowed) => {
    const mark = new Uint8Array(G.W * G.H)
    const start = G.idx(entry[0], entry[1])
    const list = [start]
    mark[start] = 1
    for (let h = 0; h < list.length; h++) {
      const i = list[h]
      const x = (i % G.W) + G.x0
      const z = Math.floor(i / G.W) + G.z0
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d]
        const nz = z + DZ[d]
        const j = G.idx(nx, nz)
        if (j < 0 || mark[j] || !allowed(j, nx, nz)) continue
        mark[j] = 1
        list.push(j)
      }
    }
    return { mark, list, start }
  }
  let D = flood((j, x, z) => f.inClaim(x, z) && inSite(x, z) && G.free(o, x, z))
  if (D.list.length > budget) {
    // The deck closest round the core (Chebyshev rings out from its
    // rectangle, then nearest the door): a square hall the core stands in,
    // never a diamond of flood fronts. A 'room' deck instead grows square
    // round a point `reach` cells out of the door: a room in front of it.
    const c = f.style.site === 'room'
      ? (() => {
          const k = f.style.reach ?? 3
          const x = entry[0] + n[0] * k
          const z = entry[1] + n[1] * k
          return { x0: x, x1: x, z0: z, z1: z }
        })()
      : f.core
    const ring = (i) => {
      const x = (i % G.W) + G.x0
      const z = Math.floor(i / G.W) + G.z0
      const dc = c ? Math.max(c.x0 - x, x - c.x1, c.z0 - z, z - c.z1, 0) : 0
      return dc * 4096 + Math.abs(x - entry[0]) + Math.abs(z - entry[1])
    }
    const keepSet = new Uint8Array(G.W * G.H)
    for (const i of [...D.list].sort((u, v) => ring(u) - ring(v) || u - v).slice(0, budget)) keepSet[i] = 1
    D = flood((j) => keepSet[j] === 1)
  }
  const { mark, list, start } = D
  const keep = new Set()
  for (let k = 0; k < 3; k++) {
    for (let j = -1; j <= 1; j++) {
      const i = G.idx(entry[0] + n[0] * k + n[1] * j, entry[1] + n[1] * k + n[0] * j)
      if (i >= 0) keep.add(i)
    }
  }
  return { mark, list, start, keep }
}

const xOf = (G, i) => (i % G.W) + G.x0
const zOf = (G, i) => Math.floor(i / G.W) + G.z0

// Is every deck cell (mark 1) still 4-connected to the entry?
function deckConnected(G, D) {
  let total = 0
  for (const i of D.list) if (D.mark[i] === 1) total++
  const seen = new Uint8Array(D.mark.length)
  const st = [D.start]
  seen[D.start] = 1
  let n = 0
  while (st.length) {
    const i = st.pop()
    n++
    const x = xOf(G, i)
    const z = zOf(G, i)
    for (let d = 0; d < 4; d++) {
      const j = G.idx(x + DX[d], z + DZ[d])
      if (j >= 0 && D.mark[j] === 1 && !seen[j]) {
        seen[j] = 1
        st.push(j)
      }
    }
  }
  return n === total
}

// Rooms carved out of the deck against its outer walls: from a deck cell
// whose side d faces a wall, a rect `deep` cells back into the deck and
// `wide` along the wall, its door in the middle of its deck-side wall. Only
// where the deck stays one piece. The run's dice order the wall cells, so a
// run keeps its rooms.
function carveRooms(f, D, { count, sizes, role, salt, sides = [0, 1, 2, 3] }) {
  const { G, r } = f
  const rooms = []
  if (count <= 0) return rooms
  const order = [...D.list]
  for (let i = order.length - 1; i > 0; i--) {
    const j = r(salt, 300 + i) % (i + 1)
    ;[order[i], order[j]] = [order[j], order[i]]
  }
  let tries = 0
  for (const i of order) {
    if (rooms.length >= count || tries > count * 8) break
    if (D.mark[i] !== 1) continue
    const x = xOf(G, i)
    const z = zOf(G, i)
    for (const d of sides) {
      if (rooms.length >= count) break
      const wj = G.idx(x + DX[d], z + DZ[d])
      if (wj >= 0 && D.mark[wj] !== 0) continue
      const e = d ^ 1
      const t = d < 2 ? [0, 1] : [1, 0]
      let done = false
      for (const [wide, deep] of sizes) {
        const cells = []
        let fits = true
        for (let k = 0; k < deep && fits; k++) {
          for (let j = 0; j < wide && fits; j++) {
            const c = G.idx(x + DX[e] * k + t[0] * j, z + DZ[e] * k + t[1] * j)
            if (c < 0 || D.mark[c] !== 1 || D.keep.has(c)) fits = false
            else cells.push(c)
          }
        }
        if (!fits) continue
        const jm = (wide - 1) >> 1
        const inner = [x + DX[e] * (deep - 1) + t[0] * jm, z + DZ[e] * (deep - 1) + t[1] * jm]
        const front = G.idx(inner[0] + DX[e], inner[1] + DZ[e])
        if (front < 0 || D.mark[front] !== 1) continue
        tries++
        for (const c of cells) D.mark[c] = 3
        if (!deckConnected(G, D)) {
          for (const c of cells) D.mark[c] = 1
          continue
        }
        // The cell before the door stays open deck (no later room or block).
        D.keep.add(front)
        const xs = cells.map((c) => xOf(G, c))
        const zs = cells.map((c) => zOf(G, c))
        rooms.push({
          x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs),
          door: doorEdge(inner[0] + DX[e], inner[1] + DZ[e], d), d, role, cells,
        })
        done = true
        break
      }
      if (done) break
    }
  }
  return rooms
}

// May a blocking piece (post, rack) sit on cells `cells` (a straight run)?
// Every one is open deck off the approach, and every cell round them is open
// deck: an isolated block with a free ring never cuts the deck.
function ringFree(G, D, cells) {
  const own = new Set(cells)
  for (const c of cells) {
    if (D.mark[c] !== 1 || D.keep.has(c)) return false
    const x = xOf(G, c)
    const z = zOf(G, c)
    for (let b = -1; b <= 1; b++) {
      for (let a = -1; a <= 1; a++) {
        const j = G.idx(x + a, z + b)
        if (own.has(j)) continue
        if (j < 0 || D.mark[j] !== 1) return false
      }
    }
  }
  return true
}

// Free-standing blocks in the deck's interior, about one per `per` chunks
// of deck: service cores (risers, lift shafts: held mass) or, where `rooms`
// says so, rooms with a door on one side. Each stands in a free ring of
// deck, so the deck never splits.
function cores(f, D, { per, sizes, rooms = null, salt }) {
  const { G, r } = f
  const want = Math.max(1, Math.round(claimChunks(f, D) / per))
  const out = []
  const order = [...D.list]
  for (let i = order.length - 1; i > 0; i--) {
    const j = r(salt, 600 + i) % (i + 1)
    ;[order[i], order[j]] = [order[j], order[i]]
  }
  for (const i of order) {
    if (out.length >= want) break
    const [w, d] = sizes[r(salt, 700 + out.length) % sizes.length]
    const turn = r(salt, 800 + out.length) % 2
    const [a, b] = turn ? [d, w] : [w, d]
    const x0 = xOf(G, i)
    const z0 = zOf(G, i)
    const cells = []
    for (let z = z0; z < z0 + b; z++) for (let x = x0; x < x0 + a; x++) cells.push(G.idx(x, z))
    if (cells.some((c) => c < 0) || !ringFree(G, D, cells)) continue
    const room = rooms && r(salt, 900 + out.length) % 3 !== 0
    for (const c of cells) D.mark[c] = room ? 3 : 4
    const q = { x0, z0, x1: x0 + a - 1, z1: z0 + b - 1, cells, room }
    if (room) {
      // The door in the middle of a long side.
      const side = r(salt, 950 + out.length) % 2
      const d = a >= b ? (side ? 2 : 3) : side ? 0 : 1
      const [ix, iz] = d === 2 ? [x0 + (a >> 1), q.z1] : d === 3 ? [x0 + (a >> 1), z0] : d === 0 ? [q.x1, z0 + (b >> 1)] : [x0, z0 + (b >> 1)]
      Object.assign(q, { door: doorEdge(ix, iz, d), d: d ^ 1, role: rooms })
    }
    out.push(q)
  }
  return out
}

// Posts on the deck's structural grid (pitch p, the run's phase).
function posts(f, D, p, salt) {
  const { G, plan, r } = f
  const mod = (a) => ((a % p) + p) % p
  // The run's phase, walked on (in the dice's order) until the grid lands at
  // least half its posts: a hall pinched by the core or a service core may
  // ring-block every post of an unlucky phase.
  const at = (phx, phz) => D.list.filter((i) => mod(xOf(G, i) - phx) === 0 && mod(zOf(G, i) - phz) === 0 && ringFree(G, D, [i]))
  const want = Math.floor(D.list.length / (2 * p * p))
  const start = r(salt, 1) % (p * p)
  let best = null
  for (let k = 0; k < p * p; k++) {
    const t = (start + k) % (p * p)
    const got = at(t % p, Math.floor(t / p))
    if (!best || got.length > best.got.length) best = { got, phx: t % p, phz: Math.floor(t / p) }
    if (got.length >= want) break
  }
  const { phx, phz } = best
  let n = 0
  for (const i of best.got) {
    if (!ringFree(G, D, [i])) continue
    D.mark[i] = 2
    plan.column(xOf(G, i), zOf(G, i))
    n++
  }
  return { n, phx, phz, mod }
}

// Lay the deck: open cells (owned, corridor-like for the grid), the rooms
// planned.
function layDeck(f, D, rooms) {
  const { G, plan, o } = f
  for (const i of D.list) {
    const x = xOf(G, i)
    const z = zOf(G, i)
    if (D.mark[i] === 1 || D.mark[i] === 2) {
      if (!G.isCorr(o, x, z)) G.take(o, x, z, true)
      plan.open(x, z, CELL_OPEN)
    } else if (!G.owner(x, z)) G.take(o, x, z)
  }
  emitRooms(f, rooms)
}

// Tubes on a grid over the open deck (pitch p, offset from the posts).
function deckLamps(f, D, p, failRow) {
  const { G } = f
  const half = p >> 1
  const mod = (a) => ((a % p) + p) % p
  for (const i of D.list) {
    if (D.mark[i] !== 1) continue
    const x = xOf(G, i)
    const z = zOf(G, i)
    if (mod(x - half) !== 0 || mod(z - half) !== 0) continue
    f.lamp(x, z, f.lit(!failRow(Math.floor((z - half) / p))))
  }
}

// Pieces against a room's back wall (the side away from its door): kinds[k]
// on the k-th cell of `at` (indices along the wall from one end, negative
// from the other end), so identical rooms of a run get identical fixtures.
function backWall(f, q, kinds, at) {
  const cells = []
  const wall = ['E', 'W', 'S', 'N'][q.d]
  if (q.d < 2) for (let z = q.z0; z <= q.z1; z++) cells.push([q.d === 0 ? q.x1 : q.x0, z])
  else for (let x = q.x0; x <= q.x1; x++) cells.push([x, q.d === 2 ? q.z1 : q.z0])
  const used = new Set()
  for (const [k, i] of at.entries()) {
    const j = i < 0 ? cells.length + i : i
    if (j < 0 || j >= cells.length || used.has(j)) continue
    used.add(j)
    f.jobs.pieces.push({ gx: cells[j][0], gz: cells[j][1], kind: kinds[k % kinds.length], wall })
  }
}

// The side-wall fit of a locked room: its pieces down the walls either side
// of the door (doc §4.3: the rooms behind a corridor's doors are fitted
// alike), placed by the room's own rectangle, not by which side of the
// corridor it opens from, so two rooms of one size facing each other across
// the corridor are the same room. The near and back rows stay clear in a
// room three or more deep; a second wall is fitted when four or more across.
// Returns false (no pieces) when the fit would block the door or cut the
// room in two.
function sideFit(f, q, kinds) {
  const W = q.x1 - q.x0 + 1
  const D = q.z1 - q.z0 + 1
  const door = q.d === 0 ? [q.door.gx, q.door.gz] : q.d === 1 ? [q.door.gx - 1, q.door.gz] : q.d === 2 ? [q.door.gx, q.door.gz] : [q.door.gx, q.door.gz - 1]
  // Every cell of the room reachable from the door around `held`?
  const connected = (held) => {
    if (held.has(door[1] * 4096 + door[0])) return false
    const seen = new Set([door[1] * 4096 + door[0]])
    const list = [door]
    while (list.length) {
      const [x, z] = list.pop()
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d]
        const nz = z + DZ[d]
        const k = nz * 4096 + nx
        if (nx < q.x0 || nx > q.x1 || nz < q.z0 || nz > q.z1 || seen.has(k) || held.has(k)) continue
        seen.add(k)
        list.push([nx, nz])
      }
    }
    return seen.size + held.size === W * D
  }
  // First the mirror-true fit: the pieces down both side walls (the walls
  // either side of the door wall), clear of the near and back rows, each
  // piece's kind by its distance from the nearer end; in a room two cells
  // across, one wall: the one away from the door. The fit is the same
  // whichever wall the door is in and wherever along it, so the rooms of
  // a module are one room on both sides of a corridor.
  {
    const across = q.d >= 2
    const [len, wid] = across ? [D, W] : [W, D]
    const doorLine = across ? door[0] - q.x0 : door[1] - q.z0
    const lines = wid >= 3 ? [0, wid - 1] : wid === 2 ? [1 - doorLine] : []
    const span = wid >= 3 ? [1, len - 2] : [0, len - 1]
    if (lines.length && len >= 2 && span[1] >= span[0]) {
      const pieces = []
      for (const line of lines) {
        for (let t = span[0]; t <= span[1]; t++) {
          const kind = kinds[Math.min(t - span[0], span[1] - t) % kinds.length]
          pieces.push(across ? { gx: q.x0 + line, gz: q.z0 + t, kind, wall: line === 0 ? 'W' : 'E' } : { gx: q.x0 + t, gz: q.z0 + line, kind, wall: line === 0 ? 'N' : 'S' })
        }
      }
      if (connected(new Set(pieces.map((p) => p.gz * 4096 + p.gx)))) {
        f.jobs.pieces.push(...pieces)
        return true
      }
    }
  }
  // One fixed order whatever wall the door is in (the W and E walls, then
  // N and S), so rooms of one size share one fit wherever it leaves the
  // door free.
  for (const [across, firstEnd] of [[true, 0], [true, 1], [false, 0], [false, 1]]) {
    const [len, wid] = across ? [D, W] : [W, D]
    if (wid < 2 || len < 2) continue
    const span = len >= 3 ? [1, len - 2] : [0, len - 1]
    const lines = wid >= 4 ? [0, wid - 1] : [0]
    const first = firstEnd ? wid - 1 : 0
    const pieces = []
    const order = first === 0 ? lines : [...lines].reverse()
    for (const [li, line] of order.entries()) {
      for (let t = span[0]; t <= span[1]; t++) {
        const k = pieces.length - li * (span[1] - span[0] + 1)
        const kind = kinds[(k + li) % kinds.length]
        pieces.push(across ? { gx: q.x0 + line, gz: q.z0 + t, kind, wall: line === 0 ? 'W' : 'E' } : { gx: q.x0 + t, gz: q.z0 + line, kind, wall: line === 0 ? 'N' : 'S' })
      }
    }
    if (!connected(new Set(pieces.map((p) => p.gz * 4096 + p.gx)))) continue
    f.jobs.pieces.push(...pieces)
    return true
  }
  return false
}

// The back-wall fit of a locked room per role: [kinds, cells along the wall
// (negative from the far end)]. Washrooms: a toilet in one back corner, a
// basin in the other; stores: a shelf run and a stack of boxes; offices a
// desk and a cabinet; the copy room a copier and a table.
const FIT = Object.freeze({
  [SPACE_ROLE_OFFICE]: [[FURN_DESK, FURN_CABINET, FURN_DESK, FURN_BOOKSHELF], [1, -1, 3, 0]],
  [SPACE_ROLE_ARCHIVE]: [[FURN_BOOKSHELF], [0, 1, 2, 3, 4, 5]],
  [SPACE_ROLE_STORAGE]: [[FURN_BOOKSHELF, PROP_FLATPACK, PROP_FLATPACK, FURN_BOOKSHELF], [0, -1, 2, -3]],
  [SPACE_ROLE_SERVER]: [[FURN_RACK], [0, 1, 2, 3, 4, 5]],
  [SPACE_ROLE_COPY]: [[FURN_COPIER, FURN_TABLE, FURN_CABINET], [0, -1, 2]],
  [SPACE_ROLE_BATHROOM]: [[FURN_TOILET, FURN_SINK, FURN_TOILET, FURN_SINK], [0, -1, 1, -2]],
})

// --- kinds ------------------------------------------------------------------------

function corridorKind(f, entry) {
  const c = fragmentFloor(f, stub(f, entry), SPACE_ROLE_OFFICE)
  return `corridor (${c.rooms} rooms, ${c.closets} closets, ${c.corridor} corridor${c.dropped ? ', one door gone' : ''})`
}

function toiletsKind(f, entry) {
  const c = fragmentFloor(f, stub(f, entry), SPACE_ROLE_BATHROOM)
  return `toilets (${c.rooms} washrooms, ${c.closets} closets, ${c.corridor} corridor${c.dropped ? ', one door gone' : ''})`
}

function claimChunks(f, D) {
  const s = new Set()
  for (const i of D.list) s.add(`${Math.floor(xOf(f.G, i) / CHUNK)},${Math.floor(zOf(f.G, i) / CHUNK)}`)
  return s.size
}

function closetsKind(f, entry) {
  const c = fragmentFloor(f, stub(f, entry), SPACE_ROLE_STORAGE)
  return `closets (${c.rooms} stores, ${c.closets} closets, ${c.corridor} corridor${c.dropped ? ', one door gone' : ''})`
}

// The single office (doc §4.3): a short lobby, the furnished office (the
// largest room) and a store or two.
function officeKind(f, entry) {
  const c = fragmentFloor(f, stub(f, entry), SPACE_ROLE_OFFICE)
  return `office (${c.rooms} rooms, ${c.closets} closets, ${c.corridor} lobby)`
}

// Pieces against the deck's walls (switchgear in a plant room, bins and a
// skip on a car-park deck): up to `count` of `kinds` (in order), each on an
// open deck cell off the door's approach with a wall (or a room's wall)
// beside it, only where the rest of the deck stays one piece. The run's dice
// order the cells, so a run keeps its pieces; `skip` (the storey's) leaves
// one out.
function wallPieces(f, D, { kinds, count, salt, skip = -1 }) {
  const { G, r } = f
  const order = []
  for (const i of D.list) {
    if (D.mark[i] !== 1 || D.keep.has(i)) continue
    const x = xOf(G, i)
    const z = zOf(G, i)
    for (let d = 0; d < 4; d++) {
      const j = G.idx(x + DX[d], z + DZ[d])
      const v = j < 0 ? 0 : D.mark[j]
      if (v === 0 || v === 3) {
        order.push([i, d])
        break
      }
    }
  }
  for (let i = order.length - 1; i > 0; i--) {
    const j = r(salt, 400 + i) % (i + 1)
    ;[order[i], order[j]] = [order[j], order[i]]
  }
  let n = 0
  for (const [i, d] of order) {
    if (n >= count) break
    if (D.mark[i] !== 1) continue
    // Never beside another piece (a free cell either side along the wall).
    const x = xOf(G, i)
    const z = zOf(G, i)
    let crowd = false
    for (let b = -1; b <= 1 && !crowd; b++) for (let a = -1; a <= 1 && !crowd; a++) {
      const j = G.idx(x + a, z + b)
      if (j >= 0 && j !== i && D.mark[j] === 2) crowd = true
    }
    if (crowd) continue
    D.mark[i] = 2
    if (!deckConnected(G, D)) {
      D.mark[i] = 1
      continue
    }
    if (n !== skip) {
      const wall = ['E', 'W', 'S', 'N'][d]
      f.jobs.pieces.push({ gx: x, gz: z, kind: kinds[n % kinds.length], wall })
    } else D.mark[i] = 1
    n++
  }
  return n
}

function plantKind(f, entry) {
  const D = deckOf(f, entry, f.n)
  const { G, style } = f
  // Riser cupboards: the building's module, a pair on the walls of one axis.
  const rooms = carveRooms(f, D, { count: style.rooms, sizes: [style.room], role: SPACE_ROLE_SERVER, salt: 8, sides: style.axis === 0 ? [2, 3] : [0, 1] })
  const p = posts(f, D, style.posts, 9)
  // Machine rows: rack runs of `seg` every `seg + gap` cells, staggered by
  // half a step on alternate rows so the gaps never line up, on every
  // `rows`-th line of the room's long axis, each run with a free ring (racks
  // as machinery, doc §4.3). The phase is the run's dice, walked on until
  // the room takes two runs; the storey's dice take one run away.
  const step = style.seg + style.gap
  const mod = (a, n) => ((a % n) + n) % n
  const along = new Map()
  for (const i of D.list) {
    const x = xOf(G, i)
    const z = zOf(G, i)
    const [line, at] = style.axis === 0 ? [z, x] : [x, z]
    if (!along.has(line)) along.set(line, new Map())
    along.get(line).set(at, i)
  }
  const layout = (ph, pa) => {
    const out = []
    for (const line of [...along.keys()].sort((a, b) => a - b)) {
      if (mod(line - ph, style.rows) !== 0) continue
      const row = along.get(line)
      const odd = Math.floor((line - ph) / style.rows) & 1
      for (const at of [...row.keys()].sort((a, b) => a - b)) {
        if (mod(at - pa - (odd ? step >> 1 : 0), step) !== 0) continue
        const seg = []
        while (seg.length < style.seg && row.has(at + seg.length)) seg.push(row.get(at + seg.length))
        if (seg.length === style.seg && seg.every((c) => D.mark[c] === 1 && !D.keep.has(c))) out.push(seg)
      }
    }
    return out
  }
  const phases = style.rows * step
  const start = f.r(9, 3) % phases
  let runs = []
  for (let k = 0; k < phases && runs.length < 2; k++) {
    const t = (start + k) % phases
    const got = layout(t % style.rows, Math.floor(t / style.rows))
    if (got.length > runs.length) runs = got
  }
  // Each run stays only where the room stays one piece round it.
  runs = runs.filter((seg) => {
    if (!seg.every((c) => D.mark[c] === 1)) return false
    for (const c of seg) D.mark[c] = 2
    if (deckConnected(G, D)) return true
    for (const c of seg) D.mark[c] = 1
    return false
  })
  const gone = runs.length > 2 && f.m(1) % 2 === 0 ? f.m(2) % runs.length : -1
  if (gone >= 0) for (const c of runs[gone]) D.mark[c] = 1
  runs = runs.filter((_, k) => k !== gone)
  // Switchgear on the walls (the storey's dice leave one panel out now and then).
  const panels = wallPieces(f, D, { kinds: [FURN_CABINET], count: style.cabinets, salt: 12, skip: f.m(5) % 4 === 0 ? f.m(6) % style.cabinets : -1 })
  layDeck(f, D, rooms)
  for (const seg of runs) {
    for (const c of seg) f.jobs.pieces.push({ gx: xOf(G, c), gz: zOf(G, c), kind: FURN_RACK, wall: null, front: style.axis === 0 ? FACING.S : FACING.E })
  }
  for (const q of rooms) {
    if (!sideFit(f, q, FIT[SPACE_ROLE_SERVER][0])) backWall(f, q, ...FIT[SPACE_ROLE_SERVER])
    f.lamp(...centre(q), f.lit(true))
  }
  deckLamps(f, D, style.lamps, () => false)
  return `plant (room ${D.list.length} cells, ${runs.length} machine rows, ${panels} panels, ${rooms.length} risers, ${p.n} posts)`
}

// The car-park deck's loose pieces, in order: a skip, bins, a trolley, boxes.
const DECK_CLUTTER = [PROP_DUMPSTER, PROP_WHEELIE_BIN, PROP_CART, PROP_WHEELIE_BIN, PROP_FLATPACK, PROP_CART, PROP_WHEELIE_BIN]

function carparkKind(f, entry) {
  const D = deckOf(f, entry, f.n)
  const { G, r, style } = f
  // Storage cages of the building's size against the deck's walls.
  const cages = carveRooms(f, D, { count: style.cages, sizes: [style.cage], role: SPACE_ROLE_STORAGE, salt: 13 })
  // One stair/lift block (held mass).
  const blocks = cores(f, D, { per: style.cores, sizes: [[2, 3], [2, 2]], salt: 11 })
  const p = posts(f, D, style.posts, 5)
  const clutter = wallPieces(f, D, { kinds: DECK_CLUTTER, count: style.clutter, salt: 14, skip: f.m(10) % 3 === 0 ? f.m(11) % style.clutter : -1 })
  layDeck(f, D, cages)
  for (const q of cages) if (!sideFit(f, q, FIT[SPACE_ROLE_STORAGE][0])) backWall(f, q, ...FIT[SPACE_ROLE_STORAGE])
  // Bay lamps mid-way between posts. A third of the bay rows are dead for
  // the run; the storey's dice flip one more row now and then.
  const half = Math.floor(style.posts / 2)
  const flip = f.m(8) % 3 === 0 ? f.m(9) % 6 : -1
  for (const i of D.list) {
    if (D.mark[i] !== 1) continue
    const x = xOf(G, i)
    const z = zOf(G, i)
    if (p.mod(x - p.phx) !== half || p.mod(z - p.phz) !== half) continue
    const row = Math.floor((z - p.phz) / style.posts)
    f.lamp(x, z, f.lit((r(5, 200 + row) % 3 !== 0) !== (((row % 6) + 6) % 6 === flip)))
  }
  return `carpark (${D.list.length} cells, ${cages.length} cages, ${blocks.length} cores, ${p.n} posts, ${clutter} pieces)`
}

const KINDS = { corridor: corridorKind, office: officeKind, toilets: toiletsKind, plant: plantKind, carpark: carparkKind, closets: closetsKind }

// Build one landing's fragment. f = { kind, G, plan, o (owner id > 0), out,
// n, inClaim(gx, gz), box, r (the run's dice), m (the storey's dice), style,
// ids, jobs, lamp(gx, gz, lit) → placed?, lit(on) → on unless the storey is
// dark }. Returns a note.
export function buildFragment(f) {
  const entry = vestibule(f)
  if (!entry) return `${f.kind} (no room behind the door)`
  return `${KINDS[f.kind](f, entry)}`
}

// A rung's side rooms near one of its landings (doc §4.3 "transfer
// corridor: runs to shaft B, with a few doors"): two or three rooms off the
// routed rung (f.from: its cells) inside that landing's share, fitted as
// locked rooms but for one open office, and a cupboard (with at most a
// janitor's closet at a dead end): three to five doors a landing, not an
// office wing. Returns the number of rooms.
export function rungWings(f) {
  const st = { ...f.style, max: 2 + (f.r(8) % 2), closets: 1, budget: 3 + f.from.length + 80, cap: 36, side: 6 }
  const c = fragmentFloor({ ...f, style: st }, f.from, SPACE_ROLE_OFFICE, f.from.length)
  return c.rooms + c.closets
}
