import {
  CELL,
  CELL_CORRIDOR,
  CELL_LOBBY,
  FACING,
  FloorPlan,
  PASSAGE_DOOR,
  PASSAGE_WIDE,
  SPACE_ROLE_BATHROOM,
  SPACE_ROLE_BREAK,
  SPACE_ROLE_SERVER,
  SPACE_ROLE_STORAGE,
  STAIR_E,
  STAIR_W,
  THICK,
  WALL_TO_FRONT,
  addPiece,
  labelFloor,
} from '../../tiles/floorPlan.js'
import {
  FURN_BED,
  FURN_CABINET,
  FURN_COUNTER,
  FURN_DESK,
  FURN_RACK,
  FURN_SINK,
  FURN_TOILET,
  FURN_WARDROBE,
  FURN_WHITEBOARD,
} from '../../rooms/catalog.js'
import { PIECE_DIMS } from '../../rooms/furnish.js'
import { PROP_METRO_BENCH, PROP_SEAT_PAIR, PROP_TICKET_GATE } from '../../props/index.js'
import { stairwellPlan } from '../../structures/authored.js'
import { markExit, markSpawn } from '../../tiles/kit.js'
import { openOwnedSeam } from '../../tiles/seams.js'
import { EMERGENCY_TINT, KIOSK_TINT, TRAIN_TINT } from './tile.js'
import {
  CAR_TYPES,
  CONC,
  ROWS,
  TILE_CELLS,
  TRAIN,
  X_EAST,
  Z_MAX,
  Z_MIN,
  Z_SAFE,
  carPlateOf,
  skeleton,
  spawnCells,
  stationPlatesOf,
  tileAnomalies,
  tileDice,
  wrongSideOf,
} from './geometry.js'

// The train's world tile (tile mode; spec §6.5, §12.10): the bake that
// composes one 4×1-chunk tile around its pure skeleton (geometry.js). The
// prototype (kind.js) and doc 07 §4.2 / §5 are the parts catalogue — the car
// types, the platform with its wide doors, benches and booth, the enclosed
// stair cores, the concourse with its gate line, kiosk, toilets, line map
// and exit closet, the tunnel walkways with their NFPA lamps and
// cross-passages, the parallel tunnel, the ghost station — and this grammar
// decides, per tile, which of them appear, where and how big:
//
// storey 0 (the train and its tunnel):
//   - the cars of the skeleton (mixed types and lengths, each on its own
//     aisle row), joined by gangway doors on every car joint;
//   - a station's platform(s), wide doors into the cars it serves, its stair
//     cores behind the platform (0–2 rows back, a short stair passage
//     between), sometimes an island (the far track railed off behind it)
//     and a station-master's booth;
//   - runs of 1-wide tunnel walkways along the cars' flanks (lengths and
//     gaps rolled per run, following the train's jogs), each reached through
//     ONE emergency door in a car (or the platform);
//   - parallel tunnels: 2–4-row bores of rolled length beyond a walkway, a
//     mass wall between, joined to it by one cross-passage door (doc §5),
//     with refuges, blind cross-passages and relay cabinets;
//   - on a plain tile, sometimes a ghost platform beside a straight run of
//     cars: unlit, a booth and benches, ONE wide door open (doc §5 "one open
//     route"; the train stops where it should not);
//   - a few relay and plant rooms off the walkways and bores;
//   - the glass on the cars' seat bays wherever it looks onto a walkway, a
//     platform or deep enough mass (the §9.6 see-through rule).
//   Every lineside complex hangs off the train through one door (or a
//   platform), so the train stays a chain: no loop off a plain tile's cars.
// storey 1 (the upper works): sealed at every seam. Each stair core leads up
// into its own dead-end pocket (a station's cores share the station's):
//   - a station's concourse over its cores' doors, its gate line (rails and
//     a bank of gates with walk gaps), the exit closet at one end, a kiosk
//     and toilets where they fit, the line map and benches;
//   - modules grown from the pocket through rolled cross-passages: disused
//     platforms (a booth, benches, tunnel mouths), parallel tunnel bores
//     (emergency lamps, a refuge), disused ticket halls (a dead kiosk, the
//     line map); sizes, counts and places rolled per tile.
// The repeated ELEMENTS (identical-looking cars, the same gangway doors,
// benches and tubes) carry the liminal sameness; the arrangement differs
// tile to tile.

// Grid codes (one per cell, per storey).
const MASS = 0
const CAR = 1
const PLAT = 2
const WALK = 3
const ROOM = 4
const CORE = 5
const KEEP = 6 // mass kept for a wrongSide niche
const NICHE = 7
const LOBBY = 8
const CORR = 9
const GPLAT = 10 // ghost platform (storey 0)
const BORE = 11 // parallel tunnel (storey 0)
const REFUGE = 12 // a walkway's refuge recess (storey 0)
const TRACK = 13 // an island platform's far track (storey 0)

const W = TILE_CELLS
const LIT_CAP = 9 // lit lamps per chunk-storey before the fill-light pass

const idx = (x, z) => z * W + x
const inBand = (x, z) => x >= 0 && x <= X_EAST - 1 && z >= Z_MIN && z <= Z_MAX
const inGrid = (x, z) => x >= 0 && x < W && z >= 0 && z < ROWS
const DIRS = [[0, -1], [0, 1], [-1, 0], [1, 0]]

// The edge between cell (x, z) and its neighbour (x + dx, z + dz).
function edgeBetween(x, z, dx, dz) {
  if (dx) return { axis: 'v', gx: dx > 0 ? x + 1 : x, gz: z }
  return { axis: 'h', gx: x, gz: dz > 0 ? z + 1 : z }
}
const edgeKey = (e) => `${e.axis}:${e.gx},${e.gz}`

// A tile's dice, salted per purpose: r(a, b, c) → uint32.
const dice = (seed, tx, salt) => tileDice(seed, tx, salt)

// Shuffle a list with the dice (stable for equal keys).
function shuffled(list, r, tag) {
  return list.map((v, i) => ({ v, k: r(tag, i) })).sort((a, b) => a.k - b.k || 0).map((o) => o.v)
}

// --- rooms -----------------------------------------------------------------------------

const ROOM_KINDS_TRACK = Object.freeze([
  { name: 'relay', role: SPACE_ROLE_SERVER, piece: FURN_RACK },
  { name: 'plant', role: SPACE_ROLE_STORAGE, piece: FURN_CABINET },
  { name: 'mess', role: SPACE_ROLE_BREAK, piece: FURN_DESK },
])

// Try to place one room behind anchor cell (ax, az) in direction (dx, dz):
// the room holds the cell next to the anchor and grows away from it.
function tryRoom(g, ax, az, dx, dz, depth, width, shift) {
  const bx = ax + dx
  const bz = az + dz
  let x0
  let x1
  let z0
  let z1
  if (dz) {
    x0 = bx - shift
    x1 = x0 + width - 1
    z0 = dz < 0 ? bz - depth + 1 : bz
    z1 = dz < 0 ? bz : bz + depth - 1
  } else {
    z0 = bz - shift
    z1 = z0 + width - 1
    x0 = dx < 0 ? bx - depth + 1 : bx
    x1 = dx < 0 ? bx : bx + depth - 1
  }
  if (x0 > bx || x1 < bx || z0 > bz || z1 < bz) return null
  for (let z = z0; z <= z1; z++) {
    for (let x = x0; x <= x1; x++) if (!inBand(x, z) || g[idx(x, z)] !== MASS) return null
  }
  return { x0, z0, x1, z1, door: edgeBetween(ax, az, dx, dz), inside: { x: bx, z: bz }, dir: [dx, dz] }
}

// A few small rooms off the anchor cells (codes in `from`), growing away
// from the train (`outward(x)` is the aisle row at x): at most `cap`, each
// anchor taken once in `every` tries.
function packRooms(g, r, from, { outward, cap, every, tag }) {
  const anchors = []
  for (let z = 0; z < ROWS; z++) {
    for (let x = 0; x < W; x++) {
      if (!from.includes(g[idx(x, z)])) continue
      for (const [dx, dz] of DIRS) {
        if (dx !== 0 || Math.sign(z - outward(x)) !== dz) continue
        if (inBand(x + dx, z + dz) && g[idx(x + dx, z + dz)] === MASS) anchors.push([x, z, dx, dz])
      }
    }
  }
  const rooms = []
  for (const [x, z, dx, dz] of shuffled(anchors, r, 0x100 + tag)) {
    if (rooms.length >= cap) break
    if (g[idx(x + dx, z + dz)] !== MASS) continue
    const k = r(0x200 + tag, x, z * 4 + (dx + 1) * 2 + dz)
    if (k % every !== 0) continue
    const depth = 2 + ((k >>> 3) % 2)
    const width = 2 + ((k >>> 5) % 3)
    let rm = null
    for (let d = depth; d >= 1 && !rm; d--) {
      for (let w2 = width; w2 >= 2 && !rm; w2--) rm = tryRoom(g, x, z, dx, dz, d, w2, (k >>> 9) % w2)
    }
    if (!rm) continue
    rm.keep = new Set()
    for (let zz = rm.z0; zz <= rm.z1; zz++) for (let xx = rm.x0; xx <= rm.x1; xx++) g[idx(xx, zz)] = ROOM
    rooms.push(rm)
  }
  return rooms
}

// Furniture for a room: along the wall facing its door (alternate cells), or
// one end piece in a 1-deep strip; never in the door's cell, never cutting
// the room in two (the row by the door stays free).
function furnishRoom(rm, piece, put) {
  const [dx, dz] = rm.dir
  const w = rm.x1 - rm.x0 + 1
  const d = rm.z1 - rm.z0 + 1
  const depth = dz ? d : w
  const width = dz ? w : d
  const back = (i) => (dz ? { x: rm.x0 + i, z: dz < 0 ? rm.z0 : rm.z1 } : { x: dx < 0 ? rm.x0 : rm.x1, z: rm.z0 + i })
  const wall = dz ? (dz < 0 ? 'N' : 'S') : dx < 0 ? 'W' : 'E'
  const clear = (c) => !rm.keep?.has(idx(c.x, c.z))
  if (depth >= 2) {
    for (let i = 0; i < width; i += 2) {
      const c = back(i)
      if (clear(c)) put(c.x, c.z, piece, wall)
    }
    return
  }
  if (width >= 3) {
    // A strip: one end piece, away from the door's cell.
    const along = dz ? rm.inside.x - rm.x0 : rm.inside.z - rm.z0
    const i = along < width / 2 ? width - 1 : 0
    const c = back(i)
    if (clear(c)) put(c.x, c.z, piece, wall)
  }
}

// A transverse seat pair facing along the car (E/W), pushed against the
// side wall: addPiece only hugs a wall with the piece's back, so place it by
// hand (dims rotate: E/W fronts swap w and d).
function seatPair(map, gx, gz, wall, facing) {
  const [w0, d0] = PIECE_DIMS[PROP_SEAT_PAIR]
  const w = d0
  const d = w0
  const off = CELL / 2 - THICK / 2 - d / 2 - 0.06
  const x = (map.cellLocal(gx) + 0.5) * CELL
  const z = (map.cellLocal(gz) + 0.5) * CELL + (wall === 'N' ? -off : off)
  return { gx, gz, rec: { kind: PROP_SEAT_PAIR, x, z, w, d, facing } }
}

// Lamps with the per-chunk lit cap: callers push in priority order.
function lampBook() {
  const list = []
  const lit = new Map()
  return {
    add(x, z, on, tint = null) {
      const c = Math.floor(x / 14)
      let ok = on
      if (ok && (lit.get(c) ?? 0) >= LIT_CAP) ok = false
      if (ok) lit.set(c, (lit.get(c) ?? 0) + 1)
      list.push({ x, z, on: ok, tint: ok ? tint : null })
    },
    apply(plan) {
      for (const l of list) plan.lamp(l.x, l.z, l.on, l.tint)
    },
  }
}

// Benches along a platform's back row (alternate cells), never in front of
// an opening or beside a non-platform cell of the row.
function platformBenches(g, p, code, put, skip) {
  const backZ = p.side === 'S' ? p.z1 : p.z0
  const outZ = backZ + (p.side === 'S' ? 1 : -1)
  const wall = p.side === 'S' ? 'S' : 'N'
  for (let x = p.x0 + 1; x <= p.x1 - 1; x += 2) {
    const out = inGrid(x, outZ) ? g[idx(x, outZ)] : MASS
    if ((out !== MASS && out !== TRACK) || [-1, 1].some((d) => g[idx(x + d, backZ)] !== code)) continue
    if (skip(x, backZ)) continue
    put(x, backZ, PROP_METRO_BENCH, wall)
  }
  // A 3-row platform: free-standing benches down its middle row, facing the
  // train, only where the back row behind them is blind (no stair, booth or
  // walkway opens there), gaps between them, in the back benches' columns
  // (so every free back-row cell keeps the middle-row cell in front of it).
  if (p.z1 - p.z0 + 1 < 3) return
  const midZ = (p.z0 + p.z1) >> 1
  for (let x = p.x0 + 1; x <= p.x1 - 1; x += 2) {
    if ([-1, 0, 1].some((d) => (inGrid(x + d, outZ) && g[idx(x + d, outZ)] !== MASS && g[idx(x + d, outZ)] !== TRACK) || g[idx(x + d, backZ)] !== code || skip(x + d, backZ))) continue
    put(x, midZ, PROP_METRO_BENCH, null, p.side === 'S' ? FACING.N : FACING.S)
  }
}

// --- storey 0 ----------------------------------------------------------------------------

function buildTrack(map, ctx, sk, seed, pieces, notes) {
  const { tx } = sk
  const r = dice(seed, tx, 0x7a01)
  const g = new Uint8Array(W * ROWS)
  const aisleAt = (x) => sk.cars.find((c) => x >= c.x0 && x <= c.x1).aisle
  const marks = tileAnomalies(seed, tx)
  const markOf = (j) => marks.find((m) => m.car === j)?.cls ?? null
  const st = sk.station

  // Cars.
  for (const car of sk.cars) {
    for (let x = car.x0; x <= car.x1; x++) for (let z = car.aisle - 1; z <= car.aisle + 1; z++) g[idx(x, z)] = CAR
  }
  // Station platforms, every core (station or service) and the service
  // cores' connectors down to their walkway rows.
  for (const p of st?.platforms ?? []) for (let z = p.z0; z <= p.z1; z++) for (let x = p.x0; x <= p.x1; x++) g[idx(x, z)] = PLAT
  for (const c of sk.cores) for (let z = c.z0; z <= c.z1; z++) for (let x = c.x0; x <= c.x1; x++) g[idx(x, z)] = CORE
  // A station's stair passages: from the platform's back row to each core's
  // door, when the cores stand back from it.
  // An island platform: the far track (a corridor row) behind it, railed
  // from the platform but at its ends and the stair passages.
  let trackLine = null
  if (st?.gap) {
    const p = st.platforms.find((q) => q.side === st.coreSide)
    for (const c of sk.cores) {
      const [z0, z1] = p.side === 'S' ? [p.z1 + 1, c.door.z] : [c.door.z, p.z0 - 1]
      for (let z = z0; z <= z1; z++) g[idx(c.door.x, z)] = PLAT
    }
    if (st.island) {
      const z = p.side === 'S' ? p.z1 + 1 : p.z0 - 1
      for (let x = p.x0; x <= p.x1; x++) if (g[idx(x, z)] === MASS) g[idx(x, z)] = TRACK
      trackLine = { z, line: p.side === 'S' ? z : z + 1, x0: p.x0, x1: p.x1 }
    }
  }
  const forced = new Map() // column → side (−1 north, +1 south) whose walkway must run there
  if (!st) {
    for (const c of sk.cores) {
      const a = aisleAt(c.door.x)
      const north = c.doorSide === 'far'
      const from = north ? c.door.z : a + 2
      const to = north ? a - 2 : c.door.z
      for (let z = from; z <= to; z++) g[idx(c.door.x, z)] = WALK
      forced.set(c.door.x, north ? -1 : 1)
    }
  }
  // wrongSide cars keep their door bays' outer cells as mass (niches later).
  const wrong = []
  const shut = (j) => markOf(j) === 'wrongSide' && st?.side === 'B' && j >= st.s && j <= st.e
  for (const car of sk.cars) {
    if (markOf(car.j) !== 'wrongSide' || shut(car.j)) continue
    const s = wrongSideOf(seed, tx, car.j)
    for (const b of CAR_TYPES[car.type].doors) {
      const x = car.x0 + b
      const z = car.aisle + 2 * s
      if (!inBand(x, z)) continue
      if (g[idx(x, z)] === MASS) g[idx(x, z)] = KEEP
      wrong.push({ x, z, s, car })
    }
  }

  // Tunnel walkways: runs along each flank of the train, following its jogs.
  const walkRow = (x, s) => aisleAt(x) + 2 * s
  for (const s of [-1, 1]) {
    let on = (r(0x31, s + 1) & 1) === 1
    let left = 2 + (r(0x32, s + 1) % 6)
    for (let x = 0; x <= X_EAST - 1; x++) {
      if (left-- <= 0) {
        on = !on
        left = on ? 4 + (r(0x33, s + 1, x) % 15) : 2 + (r(0x34, s + 1, x) % 6)
      }
      const want = on || forced.get(x) === s
      const z = walkRow(x, s)
      if (!want || !inBand(x, z)) continue
      if (g[idx(x, z)] !== MASS) continue
      g[idx(x, z)] = WALK
      // A jog: fill the outer corner so the walkway stays one path.
      if (x > 0) {
        const zp = walkRow(x - 1, s)
        if (zp !== z && g[idx(x - 1, zp)] === WALK) {
          const north = s < 0
          const cx = north ? (z > zp ? x : x - 1) : z < zp ? x : x - 1
          const cz = north ? Math.min(z, zp) : Math.max(z, zp)
          if (inBand(cx, cz) && g[idx(cx, cz)] === MASS) g[idx(cx, cz)] = WALK
        }
      }
    }
  }

  const doors = new Map() // edgeKey → {edge, passage}
  const addDoor = (e, passage) => doors.set(edgeKey(e), { e, passage })
  const freeBay = new Set() // 'x,z' bays kept free of seats
  const booths = []
  const boothBehind = (p, code, tag) => {
    const z = p.side === 'S' ? p.z1 + 1 : p.z0 - 1
    const xs = []
    for (let x = p.x0; x + 1 <= p.x1; x++) {
      if (!inBand(x, z) || !inBand(x + 1, z) || g[idx(x, z)] !== MASS || g[idx(x + 1, z)] !== MASS) continue
      if (g[idx(x, p.side === 'S' ? z - 1 : z + 1)] !== code) continue
      xs.push(x)
    }
    if (!xs.length) return
    const x = xs[r(0x41, tag) % xs.length]
    g[idx(x, z)] = ROOM
    g[idx(x + 1, z)] = ROOM
    booths.push({ x0: x, z0: z, x1: x + 1, z1: z, door: edgeBetween(x, z, 0, p.side === 'S' ? -1 : 1), inside: { x, z }, dir: [0, p.side === 'S' ? 1 : -1] })
  }

  // The station-master's booth: a 2×1 room behind the core-side platform.
  if (st) boothBehind(st.platforms.find((q) => q.side === st.coreSide), PLAT, 0)

  // A ghost platform (doc §5; plain tiles four in five): beside a straight
  // run of cars (no wrongSide car), 2–3 rows, one wide door open, a booth,
  // dark. A one-sided station sometimes has one across its tracks (the
  // disused far platform, doc §4.1 "a second platform across the tracks").
  const ghosts = []
  const ghostRoll = r(0x90) % 10
  if (st ? st.side !== 'B' && ghostRoll < 5 : ghostRoll < 8) {
    const runs = []
    for (let i = 0; i < sk.n; i++) {
      for (let k = i; k < sk.n && sk.cars[k].aisle === sk.cars[i].aisle && markOf(sk.cars[k].j) !== 'wrongSide'; k++) {
        const len = sk.cars[k].x1 - sk.cars[i].x0 + 1
        const inStation = !st || (i >= st.s && k <= st.e)
        if (len >= 12 && len <= 40 && inStation) runs.push([i, k])
      }
    }
    for (const [i, k] of shuffled(runs, r, 0x91)) {
      const a = sk.cars[i].aisle
      const x0 = sk.cars[i].x0
      const x1 = Math.min(sk.cars[k].x1, X_EAST - 1)
      const w = 2 + (r(0x92, i) % 2)
      let placed = null
      const sides = st ? [st.side === 'S' ? -1 : 1] : r(0x93, i) & 1 ? [1, -1] : [-1, 1]
      for (const s of sides) {
        const z0 = s > 0 ? a + 2 : a - 1 - w
        const z1 = s > 0 ? a + 1 + w : a - 2
        if (z0 < Z_SAFE || z1 > Z_MAX) continue
        let ok = true
        for (let z = z0; ok && z <= z1; z++) for (let x = x0; ok && x <= x1; x++) ok = g[idx(x, z)] === MASS || g[idx(x, z)] === WALK
        if (!ok) continue
        placed = { side: s > 0 ? 'S' : 'N', x0, x1, z0, z1, s, cars: [i, k] }
        break
      }
      if (!placed) continue
      for (let z = placed.z0; z <= placed.z1; z++) for (let x = placed.x0; x <= placed.x1; x++) g[idx(x, z)] = GPLAT
      // The one open door: a door bay of one of the run's cars.
      const bays = []
      for (let j = i; j <= k; j++) for (const b of CAR_TYPES[sk.cars[j].type].doors) bays.push(sk.cars[j].x0 + b)
      const dx = bays[r(0x94, i) % bays.length]
      addDoor(edgeBetween(dx, a + placed.s, 0, placed.s), PASSAGE_WIDE)
      freeBay.add(`${dx},${a + placed.s}`)
      placed.door = dx
      ghosts.push(placed)
      boothBehind(placed, GPLAT, 1)
      break
    }
  }

  // Parallel tunnels: per side, 3–5 bores (where they fit) beyond the
  // walkway row (a mass wall between), each joined by ONE cross-passage
  // (doc §5 "cross passages to a parallel tunnel"). A bore takes a rolled
  // band of rows (2–4 high) and a rolled stretch of the columns where that
  // band clears the walkway by a wall row (or stands one row off the cars
  // where no walkway runs) and its ring is all mass, so the lineside stays
  // a tree off the train.
  const bores = []
  for (const s of [-1, 1]) {
    const want = 4 + (r(0x50, s + 1) % 4)
    for (let t = 0, got = 0; t < 18 && got < want; t++) {
      // Every band and run of columns where it fits; the run's end columns
      // are the bore's ring (the tile's edges stand in beyond x 0 and 54).
      const opts = []
      for (let hb = 2; hb <= 4; hb++) {
        for (let zb0 = Z_MIN; zb0 + hb - 1 <= Z_MAX; zb0++) {
          const zb1 = zb0 + hb - 1
          const fits = (x) => {
            // Beyond the walkway by a wall row; where no walkway runs, its
            // row is the wall (the bay's glass then looks across one row of
            // mass).
            const wz = walkRow(x, s)
            const need = inBand(x, wz) && g[idx(x, wz)] === MASS ? wz + s : wz + 2 * s
            if (s > 0 ? zb0 < need : zb1 > need) return false
            for (let z = zb0 - 1; z <= zb1 + 1; z++) if (inGrid(x, z) && g[idx(x, z)] !== MASS) return false
            return true
          }
          for (let x = 0, a = -1; x <= X_EAST; x++) {
            const f = x <= X_EAST - 1 && fits(x)
            if (f && a < 0) a = x
            if (!f && a >= 0) {
              const lo = a === 0 ? 0 : a + 1
              const hi = x - 1 === X_EAST - 1 ? X_EAST - 1 : x - 2
              if (hi - lo + 1 >= 6) opts.push([zb0, zb1, lo, hi])
              a = -1
            }
          }
        }
      }
      if (!opts.length) break
      // Area-weighted, and the bands against the tunnel's outer wall twice
      // over (the parallel bore runs at the edge, doc §4.1 sketch).
      const area = (o) => (o[1] - o[0] + 1) * (o[3] - o[2] + 1) * ((s < 0 ? o[0] === Z_MIN : o[1] === Z_MAX) ? 2 : 1)
      let pickAt = r(0x51, s + 1, t) % opts.reduce((a, o) => a + area(o), 0)
      const [zb0, zb1, lo, hi] = opts.find((o) => (pickAt -= area(o)) < 0)
      const len = Math.min(hi - lo + 1, 6 + (r(0x52, s + 1, t) % 17))
      const x0 = lo + (r(0x58, s + 1, t) % (hi - lo - len + 2))
      const x1 = x0 + len - 1
      // The cross-passage: from the bore's near wall toward the train, at a
      // column where it meets a walkway (best), another bore, or a car bay
      // (opening a walkway cell there), through mass walled on both sides.
      const near = s > 0 ? zb0 : zb1
      const cols = []
      for (let x = x0 + 1; x <= x1 - 1; x++) {
        const wz = walkRow(x, s)
        const cells = []
        let z = near - s
        while (inBand(x, z) && g[idx(x, z)] === MASS && (z === wz || (g[idx(x - 1, z)] === MASS && g[idx(x + 1, z)] === MASS))) {
          cells.push(z)
          z -= s
        }
        const c = inGrid(x, z) ? g[idx(x, z)] : -1
        const pref = c === WALK ? 0 : c === BORE ? 1 : c === CAR && cells.includes(wz) ? 2 : -1
        if (pref >= 0 && cells.length >= 1) cols.push({ x, cells, pref })
      }
      if (!cols.length) continue
      const best = cols.filter((c) => c.pref === Math.min(...cols.map((q) => q.pref)))
      const cp = best[r(0x55, s + 1, t) % best.length]
      for (const z of cp.cells) g[idx(cp.x, z)] = WALK
      for (let z = zb0; z <= zb1; z++) for (let x = x0; x <= x1; x++) g[idx(x, z)] = BORE
      addDoor(edgeBetween(cp.x, near - s, 0, s), PASSAGE_DOOR)
      bores.push({ x0, x1, z0: zb0, z1: zb1, s, cross: cp.x, near })
      got++
    }
  }

  // Refuges and blind cross-passages: 1-wide dead-end recesses (1–4 cells)
  // off the walkways' and the bores' outer side, every few cells, walled
  // on both sides and at the end.
  const refuges = []
  const refuge = (x, from, s, len) => {
    if (!inBand(x, from)) return
    const cells = []
    for (let z = from + s, k = 0; k < len; k++, z += s) {
      if (!inBand(x, z) || g[idx(x, z)] !== MASS) break
      if ([-1, 1].some((dx) => inGrid(x + dx, z) && g[idx(x + dx, z)] !== MASS)) break
      cells.push(z)
    }
    while (cells.length && inGrid(x, cells.at(-1) + s) && g[idx(x, cells.at(-1) + s)] !== MASS) cells.pop()
    if (!cells.length) return
    for (const z of cells) g[idx(x, z)] = REFUGE
    refuges.push({ x, z: cells.at(-1) })
  }
  for (const s of [-1, 1]) {
    for (let x = 1 + (r(0x56, s + 1) % 2); x <= X_EAST - 2; x += 2 + (r(0x57, s + 1, x) % 3)) {
      if (g[idx(x, walkRow(x, s))] === WALK) refuge(x, walkRow(x, s), s, 1 + (r(0x5b, s + 1, x) % 5))
    }
  }
  for (const b of bores) {
    const far = b.s > 0 ? b.z1 : b.z0
    for (let x = b.x0 + 1 + (r(0x59, b.x0) % 2); x <= b.x1 - 1; x += 2 + (r(0x5a, b.x0, x) % 3)) refuge(x, far, b.s, 1 + (r(0x5c, b.x0, x) % 4))
  }

  // A few relay and plant rooms off the walkways, platforms and bores.
  const rooms = packRooms(g, r, [WALK, PLAT, BORE, GPLAT], { outward: aisleAt, cap: 6 + (r(0x60) % 4), every: 1, tag: 1 })

  // Every walkway complex reaches the train through ONE door: through a
  // platform, or an emergency door in the nearest car bay.
  const seen = new Uint8Array(W * ROWS)
  const isWalk = (c) => c === WALK || c === BORE
  for (let z = 0; z < ROWS; z++) {
    for (let x = 0; x < W; x++) {
      if (!isWalk(g[idx(x, z)]) || seen[idx(x, z)]) continue
      const comp = []
      const q = [[x, z]]
      seen[idx(x, z)] = 1
      let touchesPlat = false
      while (q.length) {
        const [cx, cz] = q.pop()
        comp.push([cx, cz])
        for (const [dx, dz] of DIRS) {
          const nx = cx + dx
          const nz = cz + dz
          if (!inGrid(nx, nz)) continue
          const c = g[idx(nx, nz)]
          if (c === PLAT || c === GPLAT || c === TRACK) touchesPlat = true
          if (isWalk(c) && !seen[idx(nx, nz)]) {
            seen[idx(nx, nz)] = 1
            q.push([nx, nz])
          }
        }
      }
      if (touchesPlat) continue
      // Candidate emergency doors: a walkway cell right beside a car bay.
      const cands = []
      for (const [cx, cz] of comp) {
        if (g[idx(cx, cz)] !== WALK) continue
        for (const s of [-1, 1]) {
          const bz = cz - s // the bay row, toward the train
          if (bz < 0 || bz >= ROWS || g[idx(cx, bz)] !== CAR) continue
          const car = sk.cars.find((c) => cx >= c.x0 && cx <= c.x1)
          if (bz !== car.aisle + s) continue
          const isDoorBay = CAR_TYPES[car.type].doors.includes(cx - car.x0)
          cands.push({ x: cx, z: cz, bz, s, pref: isDoorBay ? 0 : 1 })
        }
      }
      if (!cands.length) continue
      cands.sort((a, b) => a.pref - b.pref || a.x - b.x)
      const best = cands.filter((c) => c.pref === cands[0].pref)
      const c = best[r(0x51, comp[0][0], comp[0][1]) % best.length]
      addDoor(edgeBetween(c.x, c.bz, 0, c.s), PASSAGE_DOOR)
      freeBay.add(`${c.x},${c.bz}`)
    }
  }

  // wrongSide niches: open the KEEP cells, wide doors from the door bays.
  for (const w of wrong) {
    const c = g[idx(w.x, w.z)]
    if (c === KEEP) g[idx(w.x, w.z)] = NICHE
    const v = g[idx(w.x, w.z)]
    if (v === NICHE || v === WALK || v === PLAT) {
      addDoor(edgeBetween(w.x, w.z - w.s, 0, w.s), PASSAGE_WIDE)
      freeBay.add(`${w.x},${w.z - w.s}`)
    }
  }
  for (let i = 0; i < g.length; i++) if (g[i] === KEEP) g[i] = MASS

  // --- the plan ---
  const t = new FloorPlan({ x0: 0, z0: 0, x1: X_EAST, z1: ROWS - 1 })
  let spaceId = 1
  for (const car of sk.cars) {
    car.space = spaceId++
    t.room({ x0: car.x0, z0: car.aisle - 1, x1: car.x1, z1: car.aisle + 1 }, { spaceId: car.space })
  }
  for (let z = 0; z < ROWS; z++) {
    for (let x = 0; x < W; x++) {
      const c = g[idx(x, z)]
      if (c === PLAT || c === GPLAT) t.open(x, z, CELL_LOBBY)
      else if (c === WALK || c === NICHE || c === BORE || c === REFUGE || c === TRACK) t.open(x, z, CELL_CORRIDOR)
    }
  }
  const roomKind = (rm) => ROOM_KINDS_TRACK[r(0x61, rm.x0, rm.z0) % ROOM_KINDS_TRACK.length]
  for (const rm of booths) {
    t.room(rm, { spaceId: spaceId++, role: SPACE_ROLE_STORAGE })
    addDoor(rm.door, PASSAGE_DOOR)
  }
  for (const rm of rooms) {
    t.room(rm, { spaceId: spaceId++, role: roomKind(rm).role })
    addDoor(rm.door, PASSAGE_DOOR)
  }
  // Gangways (the west seam's included), station wide doors.
  for (const j of sk.joints) {
    addDoor({ axis: 'v', gx: j.x, gz: j.z }, PASSAGE_DOOR)
    if (j.east >= 0 && j.west >= 0) {
      const east = sk.cars[j.east]
      if (east.aisle !== j.z) freeBay.add(`${j.x},${j.z}`)
      const west = sk.cars[j.west]
      if (west.aisle !== j.z) freeBay.add(`${j.x - 1},${j.z}`)
    }
  }
  if (st) {
    for (let k = st.s; k <= st.e; k++) {
      const car = sk.cars[k]
      for (const p of st.platforms) {
        // The platform on the wrong side: this car's doors onto it stay shut.
        if (shut(k) && p.side === st.coreSide) continue
        const s = p.side === 'S' ? 1 : -1
        for (const b of CAR_TYPES[car.type].doors) addDoor(edgeBetween(car.x0 + b, car.aisle + s, 0, s), PASSAGE_WIDE)
      }
    }
  }
  for (const { e, passage } of doors.values()) t.edge(e.axis, e.gx, e.gz, 0, passage)
  // The island's platform edge: a rail along the far track, open at its two
  // ends and where a stair passage crosses.
  if (trackLine) {
    const T = trackLine
    for (let x = T.x0 + 1; x <= T.x1 - 1; x++) if (g[idx(x, T.z)] === TRACK) t.rail('h', x, T.line)
  }

  // Glass: a car's seat bays, where the view is a walkway, a platform or
  // deep enough tunnel mass.
  let panes = 0
  for (const car of sk.cars) {
    if (car.dark) continue
    const doorsB = CAR_TYPES[car.type].doors
    for (let b = 0; b < car.len; b++) {
      if (doorsB.includes(b)) continue
      const x = car.x0 + b
      for (const s of [-1, 1]) {
        const e = edgeBetween(x, car.aisle + s, 0, s)
        if (doors.has(edgeKey(e))) continue
        let z = car.aisle + 2 * s
        const first = g[idx(x, z)]
        let ok = first === WALK || first === PLAT || first === NICHE || first === GPLAT
        if (first === MASS) {
          let m = 0
          while (z >= 0 && z < ROWS && g[idx(x, z)] === MASS) {
            m++
            z += s
          }
          ok = m >= 4 || (z >= 0 && z < ROWS)
        }
        if (!ok) continue
        t.window(e.axis, e.gx, e.gz)
        panes++
      }
    }
  }

  // Lamps (priority order: the train, the platform, the tunnels' emergency
  // lamps, rooms; the ghost platform stays dark).
  const lamps = lampBook()
  const dark = sk.dark
  for (const car of sk.cars) {
    const black = markOf(car.j) === 'blackout'
    for (let b = 1; b < car.len; b += 2) {
      const failing = sk.failSide && car.j === dark + sk.failSide && (sk.failSide < 0 ? b >= car.len - 2 : b <= 1)
      const lit = !car.dark && !black && !failing
      lamps.add(car.x0 + b, car.aisle, lit, lit ? TRAIN_TINT : null)
    }
  }
  for (const p of st?.platforms ?? []) {
    const mid = p.side === 'S' ? p.z0 + 1 : p.z1 - 1
    for (let x = p.x0 + 2, i = 0; x <= p.x1 - 1; x += 4, i++) lamps.add(x, mid, r(0x71, i, p.z0) % 5 < 2)
  }
  for (const b of bores) {
    const row = b.s > 0 ? b.z1 : b.z0 // the bore's walkway, by its far wall
    for (let x = b.x0 + 1 + (r(0x74, b.x0) % 3), i = 0; x <= b.x1; x += 4, i++) lamps.add(x, row, (i & 1) === 0, EMERGENCY_TINT)
  }
  let wl = 0
  for (let z = 0; z < ROWS; z++) {
    for (let x = 0; x < W; x++) {
      if (g[idx(x, z)] !== WALK) continue
      if (r(0x73, x, z) % 9 !== 0) continue
      lamps.add(x, z, (wl++ & 1) === 0, EMERGENCY_TINT)
    }
  }
  for (const gp of ghosts) {
    const mid = gp.side === 'S' ? gp.z0 + 1 : gp.z1 - 1
    for (let x = gp.x0 + 2; x <= gp.x1 - 1; x += 4) lamps.add(x, mid, false)
  }
  for (const rm of rooms) lamps.add((rm.x0 + rm.x1) >> 1, (rm.z0 + rm.z1) >> 1, r(0x72, rm.x0, rm.z0) % 3 === 0)
  for (const b of booths) lamps.add(b.x0, b.z0, false)
  lamps.apply(t)

  // Furniture: seats per car type in its bays, benches on the platforms, the
  // booths' desks, the rooms' pieces.
  const put = (gx, gz, kind, wall, front = null) => pieces.push([TRAIN, { gx, gz, kind, front: wall ? WALL_TO_FRONT[wall] : front, wall }])
  for (const car of sk.cars) {
    const doorsB = CAR_TYPES[car.type].doors
    // A commuter car's standing bays: one bay in three per side left clear,
    // the phase hashed per car and side (a wheelchair space, a luggage
    // stack), so equal cars on two tiles are not dressed alike.
    const phase = [r(0x82, car.j, 0) % 3, r(0x82, car.j, 1) % 3]
    for (let b = 0; b < car.len; b++) {
      if (doorsB.includes(b)) continue
      const x = car.x0 + b
      for (const s of [-1, 1]) {
        const z = car.aisle + s
        if (freeBay.has(`${x},${z}`)) continue
        if (car.type === 'commuter' && (b + phase[(s + 1) / 2]) % 3 === 0) continue
        const wall = s < 0 ? 'N' : 'S'
        if (car.type === 'commuter') put(x, z, PROP_METRO_BENCH, wall)
        else if (car.type === 'open') pieces.push([TRAIN, { raw: seatPair(map, x, z, wall, b % 4 === 0 ? FACING.E : FACING.W) }])
        else if (car.type === 'sleeper') put(x, z, b % 3 === 2 ? FURN_WARDROBE : FURN_BED, wall)
        else if (car.type === 'dining') put(x, z, b === car.len - 1 ? FURN_COUNTER : FURN_DESK, wall)
        else if (car.type === 'luggage' || r(0x81, x, s + 1) % 2 === 0) put(x, z, FURN_CABINET, wall) // crates
      }
    }
  }
  const coreDoor = (x, z) => sk.cores.some((c) => c.door.x === x && c.door.z === z)
  for (const p of st?.platforms ?? []) platformBenches(g, p, PLAT, put, coreDoor)
  for (const gp of ghosts) platformBenches(g, gp, GPLAT, put, coreDoor)
  for (const b of booths) put(b.x1, b.z0, FURN_DESK, b.dir[1] > 0 ? 'S' : 'N')
  for (const rm of rooms) furnishRoom(rm, roomKind(rm).piece, put)
  // Equipment cabinets (relay and cable cabinets) along a bore's far wall,
  // every few cells, where that wall is blind; the rows nearer the train
  // stay open beside them.
  for (const b of bores) {
    if (b.z1 === b.z0) continue // a lone walkway stays clear
    const far = b.s > 0 ? b.z1 : b.z0
    const out = far + b.s
    for (let x = b.x0 + 1 + (r(0x75, b.x0) % 2); x <= b.x1 - 1; x += 2) {
      if (inGrid(x, out) && g[idx(x, out)] !== MASS) continue
      put(x, far, FURN_CABINET, b.s > 0 ? 'S' : 'N')
    }
    // A 3–4-row bore: cabinets on its near wall too, clear of the
    // cross-passage (its middle rows stay open).
    if (b.z1 - b.z0 < 2) continue
    for (let x = b.x0 + 2 + (r(0x77, b.x0) % 2); x <= b.x1 - 1; x += 2) {
      if (Math.abs(x - b.cross) <= 1 || g[idx(x, b.near - b.s)] !== MASS) continue
      put(x, b.near, FURN_CABINET, b.s > 0 ? 'N' : 'S')
    }
  }
  // Half the refuges hold an equipment cabinet (a hose or phone niche).
  for (const f of refuges) if (r(0x78, f.x, f.z) & 1) put(f.x, f.z, FURN_CABINET, f.z > aisleAt(f.x) ? 'S' : 'N')

  t.compile(map, TRAIN)
  // §6.8 rule 3: the gangway port on the owned West line, kept a door.
  openOwnedSeam(map, ctx, TRAIN, 'west')
  openOwnedSeam(map, ctx, TRAIN, 'north')
  map.setWallV(0, TRAIN, sk.P0, 0, PASSAGE_DOOR)

  notes.push(
    `train tile ${tx}: ${sk.n} cars (${sk.cars.map((c) => `${c.type[0]}${c.len}@${c.aisle}`).join(' ')}), ${panes} panes, ` +
      `${bores.length} bores, ${refuges.length} refuges, ${ghosts.length} ghost platforms, ${rooms.length} rooms${st ? `, station ${st.side} w${st.w} cars ${st.s}-${st.e}` : ''}, ${sk.cores.length} cores`,
  )
  return { g }
}

// --- storey 1: the upper works ---------------------------------------------------------------

// Module catalogue (doc 07 §5): kind → [length range, depth range], cell code.
const UPPER_MODULES = Object.freeze({
  platform: { len: [14, 40], dep: [3, 5], code: LOBBY }, // a disused platform
  bore: { len: [14, 50], dep: [2, 3], code: CORR }, // a parallel tunnel bore
  hall: { len: [8, 16], dep: [4, 7], code: LOBBY }, // a disused ticket hall
  adit: { len: [2, 3], dep: [5, 11], code: CORR }, // a cross-passage gallery (along z)
})
const UPPER_WEIGHTS = Object.freeze([['platform', 3], ['bore', 3], ['hall', 2], ['adit', 1]])

function buildUpper(map, ctx, sk, seed, pieces, notes) {
  const { tx } = sk
  const r = dice(seed, tx, 0x7a02)
  const g = new Uint8Array(W * ROWS)
  const own = new Int8Array(W * ROWS).fill(-1) // pocket id of a carved cell
  const st = sk.station
  for (const c of sk.cores) for (let z = c.z0; z <= c.z1; z++) for (let x = c.x0; x <= c.x1; x++) g[idx(x, z)] = CORE
  const set = (x, z, code, p) => {
    g[idx(x, z)] = code
    own[idx(x, z)] = p
  }
  // A cell pocket p may carve: band mass, no other pocket beside it (each
  // pocket stays sealed from the others: one way in, its own stairs).
  const canUse = (x, z, p) => {
    if (!inBand(x, z) || g[idx(x, z)] !== MASS) return false
    for (const [dx, dz] of DIRS) {
      const nx = x + dx
      const nz = z + dz
      if (inGrid(nx, nz) && own[idx(nx, nz)] >= 0 && own[idx(nx, nz)] !== p) return false
    }
    return true
  }
  const walkOf = (c) => c === LOBBY || c === CORR

  const special = [] // station rooms with fixed purposes: closet, kiosk, toilets
  const rooms = [] // booths, refuges, dead kiosks: { ...rect, door, piece, wall }
  const mods = [] // placed modules
  const pockets = []
  if (st) {
    pockets.push(0)
    const C = st.concourse
    for (let z = C.z0; z <= C.z1; z++) for (let x = C.x0; x <= C.x1; x++) set(x, z, LOBBY, 0)
    const cl = st.closet
    for (let z = cl.z0; z <= cl.z1; z++) for (let x = cl.x0; x <= cl.x1; x++) set(x, z, ROOM, 0)
    special.push({ ...cl, kind: 'closet', door: { axis: 'v', gx: cl.door.x, gz: cl.door.z }, passage: PASSAGE_WIDE })
    // The kiosk: 3×2 outside the free-side wall, door into the concourse.
    const freeN = C.free === 'N'
    const kz0 = freeN ? C.z0 - 2 : C.z1 + 1
    const kxs = []
    for (let x = C.x0; x + 2 <= C.x1; x++) {
      let ok = kz0 >= Z_MIN && kz0 + 1 <= Z_MAX
      for (let z = kz0; ok && z <= kz0 + 1; z++) for (let xx = x; ok && xx <= x + 2; xx++) ok = g[idx(xx, z)] === MASS
      if (ok) kxs.push(x)
    }
    if (kxs.length && r(0x11) % 4 !== 0) {
      const x = kxs[r(0x12) % kxs.length]
      for (let z = kz0; z <= kz0 + 1; z++) for (let xx = x; xx <= x + 2; xx++) set(xx, z, ROOM, 0)
      special.push({ x0: x, z0: kz0, x1: x + 2, z1: kz0 + 1, kind: 'kiosk', door: { axis: 'h', gx: x + 1, gz: freeN ? C.z0 : C.z1 + 1 }, passage: PASSAGE_WIDE, front: { x: x + 1, z: freeN ? C.z0 : C.z1 } })
    }
    // Toilets: 3×2 at a paid-side end of the concourse.
    const pz0 = freeN ? C.z1 - 1 : C.z0
    for (const east of r(0x13) & 1 ? [1, 0] : [0, 1]) {
      const x0 = east ? C.x1 + 1 : C.x0 - 3
      let ok = x0 >= 0 && x0 + 2 <= X_EAST - 1 && pz0 >= Z_MIN && pz0 + 1 <= Z_MAX
      for (let z = pz0; ok && z <= pz0 + 1; z++) for (let x = x0; ok && x <= x0 + 2; x++) ok = g[idx(x, z)] === MASS
      if (!ok) continue
      for (let z = pz0; z <= pz0 + 1; z++) for (let x = x0; x <= x0 + 2; x++) set(x, z, ROOM, 0)
      const dz = freeN ? C.z1 : C.z0
      special.push({ x0, z0: pz0, x1: x0 + 2, z1: pz0 + 1, kind: 'toilets', door: { axis: 'v', gx: east ? C.x1 + 1 : C.x0, gz: dz }, passage: PASSAGE_DOOR })
      break
    }
    for (const c of sk.cores) if (g[idx(c.door.x, c.door.z)] === MASS) set(c.door.x, c.door.z, CORR, 0)
  } else {
    sk.cores.forEach((c, k) => {
      pockets.push(k)
      set(c.door.x, c.door.z, CORR, k)
    })
  }

  // Join cells `targets` (uncarved) to pocket p: a shortest 1-wide passage
  // through cells p may carve, from any walkable cell of p. Returns the
  // passage's cells ([] when already touching) or null.
  const connect = (p, isTarget) => {
    const prev = new Int32Array(W * ROWS).fill(-2)
    const q = []
    for (let i = 0; i < g.length; i++) {
      if (own[i] === p && walkOf(g[i])) {
        prev[i] = -1
        q.push(i)
      }
    }
    const order = shuffled(DIRS, r, 0x24 + p)
    for (let hh = 0; hh < q.length; hh++) {
      const i = q[hh]
      const x = i % W
      const z = (i - x) / W
      for (const [dx, dz] of order) {
        const nx = x + dx
        const nz = z + dz
        if (!inGrid(nx, nz)) continue
        const j = idx(nx, nz)
        if (prev[j] !== -2) continue
        if (isTarget(nx, nz)) {
          const out = []
          for (let k = i; prev[k] !== -1; k = prev[k]) out.push(k)
          return out
        }
        if (!canUse(nx, nz, p)) continue
        prev[j] = i
        q.push(j)
      }
    }
    return null
  }

  // Place one module of `kind` for pocket p inside columns [lo, hi]: a
  // rolled size (shrunk on later tries), a rolled place among every place
  // where all its cells are carvable, joined to the pocket by a passage.
  const placeModule = (p, kind, tag, lo = 0, hi = X_EAST - 1) => {
    const M = UPPER_MODULES[kind]
    const SW = W + 1
    const S = new Int32Array(SW * (ROWS + 1))
    for (let z = 0; z < ROWS; z++) {
      for (let x = 0; x < W; x++) S[(z + 1) * SW + x + 1] = (canUse(x, z, p) ? 1 : 0) + S[z * SW + x + 1] + S[(z + 1) * SW + x] - S[z * SW + x]
    }
    const free = (x0, z0, x1, z1) => S[(z1 + 1) * SW + x1 + 1] - S[z0 * SW + x1 + 1] - S[(z1 + 1) * SW + x0] + S[z0 * SW + x0] === (x1 - x0 + 1) * (z1 - z0 + 1)
    for (let t = 0; t < 4; t++) {
      const len0 = M.len[0] + (r(0x40, tag, t) % (M.len[1] - M.len[0] + 1))
      const len = Math.min(hi - lo + 1, Math.max(Math.ceil(M.len[0] * 0.6), Math.round(len0 * (1 - 0.2 * t))))
      const dep = Math.max(M.dep[0], M.dep[0] + (r(0x41, tag, t) % (M.dep[1] - M.dep[0] + 1)) - t)
      const spots = []
      for (let z0 = Z_MIN; z0 + dep - 1 <= Z_MAX; z0++) {
        for (let x0 = lo; x0 + len - 1 <= hi; x0++) if (free(x0, z0, x0 + len - 1, z0 + dep - 1)) spots.push(z0 * W + x0)
      }
      for (let k = 0; k < 4 && spots.length; k++) {
        const at = spots.splice(r(0x42, tag, t, k) % spots.length, 1)[0]
        const x0 = at % W
        const z0 = (at - x0) / W
        const x1 = x0 + len - 1
        const z1 = z0 + dep - 1
        const inRect = (x, z) => x >= x0 && x <= x1 && z >= z0 && z <= z1
        const path = connect(p, inRect)
        if (!path) continue
        for (const i of path) set(i % W, (i - (i % W)) / W, CORR, p)
        for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) set(x, z, M.code, p)
        const m = { kind, p, x0, z0, x1, z1, tag }
        mods.push(m)
        return m
      }
    }
    return null
  }

  // A small room beside module m (its long side), door into it.
  const roomBeside = (m, w, d, piece, tag) => {
    const sides = r(0x44, tag) & 1 ? [-1, 1] : [1, -1]
    for (const s of sides) {
      for (let t = 0; t < 4; t++) {
        const x0 = m.x0 + (r(0x45, tag, t) % Math.max(1, m.x1 - m.x0 - w + 2))
        const x1 = x0 + w - 1
        const z0 = s < 0 ? m.z0 - d : m.z1 + 1
        const z1 = z0 + d - 1
        if (x1 > m.x1) continue
        let ok = true
        for (let z = z0; ok && z <= z1; z++) for (let x = x0; ok && x <= x1; x++) ok = canUse(x, z, m.p)
        if (!ok) continue
        for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) set(x, z, ROOM, m.p)
        const dx = x0 + (r(0x46, tag, t) % w)
        const inside = s < 0 ? z1 : z0
        const rm = { x0, z0, x1, z1, door: edgeBetween(dx, inside, 0, -s), inside: { x: dx, z: inside }, dir: [0, s], piece, keep: new Set() }
        rooms.push(rm)
        return rm
      }
    }
    return null
  }

  // Tunnel mouths: 1-wide stubs off a platform's ends (along its track bed
  // when it has one), 2–7 cells, dead ends.
  const mouths = (m) => {
    for (const e of [-1, 1]) {
      if (r(0x47, m.tag, e + 1) % 3 === 0) continue
      const z = m.bed ? m.bed.z : m.z0 + (r(0x48, m.tag, e + 1) % (m.z1 - m.z0 + 1))
      const n = 2 + (r(0x49, m.tag, e + 1) % 6)
      for (let k = 1, x = e < 0 ? m.x0 - 1 : m.x1 + 1; k <= n && canUse(x, z, m.p); k++, x += e) set(x, z, CORR, m.p)
    }
  }

  // A disused platform's track bed: a 1-row strip along one long side,
  // behind a rail (the platform edge) open only at its two ends.
  const trackBed = (m) => {
    for (const s of r(0x4d, m.tag) & 1 ? [1, -1] : [-1, 1]) {
      const z = s < 0 ? m.z0 - 1 : m.z1 + 1
      let ok = true
      for (let x = m.x0; ok && x <= m.x1; x++) ok = canUse(x, z, m.p)
      if (!ok) continue
      for (let x = m.x0; x <= m.x1; x++) set(x, z, CORR, m.p)
      m.bed = { z, line: s < 0 ? m.z0 : m.z1 + 1, s }
      return
    }
  }

  // The modules: rolled kinds, the pockets taking turns, placed until the
  // storey's open area reaches its rolled budget (a station's pocket starts
  // from its concourse); sizes and places rolled per module.
  const bag = []
  for (const [k, w] of UPPER_WEIGHTS) for (let i = 0; i < w; i++) bag.push(k)
  const budget = 420 + (r(0x30) % 101)
  const openCells = () => {
    let n = 0
    for (let i = 0; i < g.length; i++) if (g[i] !== MASS && g[i] !== CORE) n++
    return n
  }
  for (let i = 0, fails = 0; i < 28 && fails < 8 && openCells() < budget; i++) {
    const p = pockets[i % pockets.length]
    const kind = bag[r(0x31, i) % bag.length]
    const m = placeModule(p, kind, i) ?? placeModule(p, kind === 'bore' ? 'adit' : 'bore', 0x80 + i)
    if (!m) {
      fails++
      continue
    }
    if (m.kind === 'platform') {
      trackBed(m)
      roomBeside(m, 2, 1, FURN_DESK, i) // the station-master's booth
      mouths(m)
    } else if (m.kind === 'bore' && r(0x4a, i) % 2 === 0) roomBeside(m, 2, 1 + (r(0x4b, i) % 2), FURN_CABINET, 0x40 + i) // a refuge
    else if (m.kind === 'hall' && r(0x4c, i) % 2 === 0) roomBeside(m, 3, 2, FURN_COUNTER, 0x60 + i) // a dead kiosk
  }
  // Every chunk of the storey holds something: a short bore from the
  // nearest pocket into a chunk left empty.
  for (let c = 0; c < 4; c++) {
    let any = false
    for (let z = 0; z < ROWS && !any; z++) for (let x = c * 14; x < c * 14 + 14 && !any; x++) any = g[idx(x, z)] !== MASS
    if (any) continue
    for (const p of pockets) if (placeModule(p, 'bore', 0xc0 + c * 4 + p, c * 14, Math.min(X_EAST - 1, c * 14 + 13))) break
  }

  // --- the plan ---
  const plan1 = new FloorPlan({ x0: 0, z0: 0, x1: X_EAST, z1: ROWS - 1 })
  for (let z = 0; z < ROWS; z++) {
    for (let x = 0; x < W; x++) {
      const v = g[idx(x, z)]
      if (v === LOBBY) plan1.open(x, z, CELL_LOBBY)
      else if (v === CORR) plan1.open(x, z, CELL_CORRIDOR)
    }
  }
  let spaceId = 500
  const doorList = []
  for (const s of special) {
    plan1.room(s, { spaceId: spaceId++, role: s.kind === 'toilets' ? SPACE_ROLE_BATHROOM : SPACE_ROLE_STORAGE })
    doorList.push([s.door, s.passage])
  }
  for (const rm of rooms) {
    plan1.room(rm, { spaceId: spaceId++, role: SPACE_ROLE_STORAGE })
    doorList.push([rm.door, PASSAGE_DOOR])
  }
  for (const [e, passage] of doorList) plan1.edge(e.axis, e.gx, e.gz, 0, passage)

  const lamps = lampBook()
  const put = (gx, gz, kind, wall) => pieces.push([CONC, { gx, gz, kind, front: WALL_TO_FRONT[wall], wall }])
  let gates = 0
  if (st) {
    const C = st.concourse
    const freeN = C.free === 'N'
    // The gate line between the paid rows (by the cores) and the free side.
    const gateRow = freeN ? C.z1 - 1 : C.z0 + 1
    const railLine = freeN ? gateRow : gateRow + 1
    const span = C.x1 - C.x0 + 1
    const bank = Math.min(span - 2, 5 + 2 * (r(0x31) % 3))
    const b0 = C.x0 + 1 + (r(0x32) % Math.max(1, span - bank - 1))
    const b1 = b0 + bank - 1
    for (let x = C.x0; x <= C.x1; x++) if (x < b0 || x > b1) plan1.rail('h', x, railLine)
    const doorCells = new Set(sk.cores.map((q) => `${q.door.x},${q.door.z}`))
    for (let x = b0; x <= b1; x += 2) {
      if (doorCells.has(`${x},${gateRow}`)) continue
      pieces.push([CONC, { gx: x, gz: gateRow, kind: PROP_TICKET_GATE, front: freeN ? FACING.S : FACING.N, wall: null }])
      gates++
    }
    // Free side: the line map and benches on the wall, kept off openings.
    const wallRow = freeN ? C.z0 : C.z1
    const outRow = freeN ? C.z0 - 1 : C.z1 + 1
    const wallSide = freeN ? 'N' : 'S'
    const openAt = (x) =>
      (outRow >= 0 && outRow < ROWS && g[idx(x, outRow)] !== MASS) ||
      [-1, 1].some((dx) => x + dx < 0 || x + dx >= W || g[idx(x + dx, wallRow)] !== LOBBY)
    // (Only with a free row between the wall and the gate row: on a 3-deep
    // concourse the wall row is the gate line's own approach.)
    const spots = []
    if (C.z1 - C.z0 + 1 >= 4) for (let x = C.x0 + 1; x <= C.x1 - 1; x++) if (!openAt(x)) spots.push(x)
    const mapAt = spots.length ? spots[r(0x33) % spots.length] : null
    if (mapAt !== null) put(mapAt, wallRow, FURN_WHITEBOARD, wallSide)
    for (const x of spots) if (Math.abs(x - mapAt) >= 2 && (x - C.x0) % 3 === 1) put(x, wallRow, PROP_METRO_BENCH, wallSide)
    // Lamps: the free side lit near the exit, the paid side mostly dead.
    for (let x = C.x0 + 1; x <= C.x1; x += 4) lamps.add(x, freeN ? C.z0 + 1 : C.z1 - 1, r(0x34, x) % 3 !== 0)
    for (let x = C.x0 + 2; x <= C.x1; x += 5) lamps.add(x, gateRow, r(0x35, x) % 4 === 0)
  }
  for (const s of special) {
    if (s.kind === 'closet') lamps.add(s.x0, s.z0, true)
    if (s.kind === 'kiosk') {
      const lit = r(0x36) % 2 === 0
      lamps.add(s.x0 + 1, s.z0, lit, lit ? KIOSK_TINT : null)
      const wall = s.front.z < s.z0 ? 'S' : 'N'
      const backZ = wall === 'S' ? s.z1 : s.z0
      put(s.x0, backZ, FURN_COUNTER, wall)
      put(s.x0 + 2, backZ, FURN_COUNTER, wall)
    }
    if (s.kind === 'toilets') {
      lamps.add(s.x0 + 1, s.z0, false)
      const inner = s.door.gx === s.x0 ? s.x1 : s.x0
      put(inner, s.z0, FURN_TOILET, inner === s.x1 ? 'E' : 'W')
      put(inner, s.z1, FURN_SINK, inner === s.x1 ? 'E' : 'W')
    }
  }
  // The modules: bores carry the NFPA emergency lamps (half lit); disused
  // platforms and halls stay mostly dark (doc §8: ghost stations unlit),
  // with benches and the line map on their walls.
  const doorCell = new Set(sk.cores.map((q) => idx(q.door.x, q.door.z)))
  for (const m of mods) {
    if (m.kind === 'bore' || m.kind === 'adit') {
      const along = m.kind === 'bore'
      const n = along ? m.x1 - m.x0 + 1 : m.z1 - m.z0 + 1
      for (let k = 1 + (r(0x37, m.tag) % 3), i = 0; k < n; k += 4, i++) {
        lamps.add(along ? m.x0 + k : m.x0, along ? m.z0 : m.z0 + k, (i & 1) === 0, EMERGENCY_TINT)
      }
      // Equipment cabinets on a bore's far wall, every few cells, where the
      // wall is blind; the other row stays open beside them.
      if (!along) {
        // An adit: cabinets down one side.
        const x = r(0x3b, m.tag) & 1 ? m.x0 : m.x1
        const out = x === m.x0 ? x - 1 : x + 1
        for (let z = m.z0 + 1; z <= m.z1 - 1; z += 3) if (!inGrid(out, z) || g[idx(out, z)] === MASS) put(x, z, FURN_CABINET, x === m.x0 ? 'W' : 'E')
      }
      if (along) {
        const z = r(0x3b, m.tag) & 1 ? m.z0 : m.z1
        const out = z === m.z0 ? z - 1 : z + 1
        for (let x = m.x0 + 1 + (r(0x3c, m.tag) % 3); x <= m.x1 - 1; x += 2 + (r(0x3d, m.tag, x) % 2)) {
          if (inGrid(x, out) && g[idx(x, out)] !== MASS) continue
          put(x, z, FURN_CABINET, z === m.z0 ? 'N' : 'S')
        }
      }
      continue
    }
    const mid = (m.z0 + m.z1) >> 1
    for (let x = m.x0 + 1; x <= m.x1; x += 4) lamps.add(x, mid, r(0x38, m.tag, x) % 5 === 0)
    // The platform edge: a rail along the track bed, open at both ends.
    if (m.bed) for (let x = m.x0 + 1; x <= m.x1 - 1; x++) plan1.rail('h', x, m.bed.line)
    // Benches (platforms, on the wall away from the track) or the line map
    // (halls) on a long wall with mass behind it and the row beside open.
    const code = UPPER_MODULES[m.kind].code
    const wallZ = m.bed ? (m.bed.s < 0 ? m.z1 : m.z0) : r(0x39, m.tag) & 1 ? m.z0 : m.z1
    const out = wallZ === m.z0 ? wallZ - 1 : wallZ + 1
    const side = wallZ === m.z0 ? 'N' : 'S'
    let placed = 0
    for (let x = m.x0 + 1; x <= m.x1 - 1; x += 2) {
      if (inGrid(x, out) && g[idx(x, out)] !== MASS) continue
      if ([-1, 1].some((d) => g[idx(x + d, wallZ)] !== code)) continue
      if (doorCell.has(idx(x, wallZ))) continue
      if (m.kind === 'hall') {
        if (!placed++) put(x, wallZ, FURN_WHITEBOARD, side)
      } else put(x, wallZ, PROP_METRO_BENCH, side)
    }
    // A disused hall keeps its dead gate line across the middle: gates
    // every other cell, walk gaps between.
    if (m.kind === 'hall') {
      const z = (m.z0 + m.z1 + (wallZ === m.z0 ? 1 : 0)) >> 1
      for (let x = m.x0 + 1 + (r(0x3f, m.tag) % 2); x <= m.x1 - 1; x += 2) {
        pieces.push([CONC, { gx: x, gz: z, kind: PROP_TICKET_GATE, front: wallZ === m.z0 ? FACING.S : FACING.N, wall: null }])
      }
    }
    // Rows of free-standing benches (a deep platform's middle, a hall's
    // waiting side): every other row in from the bench wall, every other
    // cell along it; the module's edge rows and end columns stay clear, so
    // the free cells stay one grid.
    const seatRows = []
    if (m.kind === 'platform') for (let k = 2; k <= m.z1 - m.z0 - 1; k += 2) seatRows.push(wallZ === m.z0 ? m.z0 + k : m.z1 - k)
    if (m.kind === 'hall') {
      const gz = (m.z0 + m.z1 + (wallZ === m.z0 ? 1 : 0)) >> 1
      for (let k = 2; k <= m.z1 - m.z0 - 1; k += 2) {
        const z = wallZ === m.z0 ? m.z0 + k : m.z1 - k
        if (Math.abs(z - gz) >= 2) seatRows.push(z)
      }
    }
    for (const z of seatRows) {
      for (let x = m.x0 + 1 + (r(0x3e, m.tag, z) % 2); x <= m.x1 - 1; x += 2) {
        pieces.push([CONC, { gx: x, gz: z, kind: PROP_METRO_BENCH, front: wallZ === m.z0 ? FACING.S : FACING.N, wall: null }])
      }
    }
  }
  for (const rm of rooms) lamps.add(rm.x0, rm.z0, r(0x3a, rm.x0, rm.z0) % 4 === 0)
  lamps.apply(plan1)
  for (const rm of rooms) furnishRoom(rm, rm.piece, put)

  plan1.compile(map, CONC)
  openOwnedSeam(map, ctx, CONC, 'west')
  openOwnedSeam(map, ctx, CONC, 'north')
  notes.push(`train upper ${tx}: ${pockets.length} pockets, ${mods.map((m) => m.kind).join(' ') || 'no modules'}, ${rooms.length} rooms, ${gates} gates`)
  return { g }
}

// --- the tile ---------------------------------------------------------------------------

export function buildTrainWorldTile(map, ctx) {
  const seed = ctx.worldSeed >>> 0
  const tx = ctx.key.tx
  const sk = skeleton(seed, tx)
  // The skeleton is shared (frozen); the bake keeps its own space ids.
  const view = { ...sk, cars: sk.cars.map((c) => ({ ...c })) }
  const pieces = []
  const notes = ctx.notes ?? []
  buildTrack(map, ctx, view, seed, pieces, notes)
  buildUpper(map, ctx, view, seed, pieces, notes)

  // Stair cores (station and service), through the world kit.
  for (const core of sk.cores) {
    const sp = stairwellPlan({ gx: core.gx, gz: core.gz, dir: core.dir === 'E' ? STAIR_E : STAIR_W, doorSide: core.doorSide, baseCy: TRAIN, topCy: CONC })
    if (sp.error) return { error: `train stair: ${sp.error}` }
    ctx.kit.stairwell(map, sp, { enclosed: true })
  }

  // Labels: a station's name over its chunks (each storey), else the first
  // car's number (storey 0) and the upper works' number (storey 1).
  const st = sk.station
  const names0 = stationPlatesOf(seed, tx, TRAIN) ?? []
  const names1 = stationPlatesOf(seed, tx, CONC) ?? []
  for (let cx = 0; cx < 4; cx++) {
    const n0 = names0.find((q) => q.chunk === cx)
    const car = sk.cars.find((c) => cx * 14 >= c.x0 && cx * 14 <= c.x1)
    labelFloor(map, TRAIN, n0 ? n0.name : carPlateOf(seed, tx, car.j), { cx, cz: 0 })
    const n1 = names1.find((q) => q.chunk === cx)
    const p = (((tx * 4 + cx) % 10) + 10) % 10
    labelFloor(map, CONC, n1 ? n1.name : `P${p}`, { cx, cz: 0 })
  }

  if (st) for (const e of st.exitCells) markExit(map, ctx, { gx: e.gx, gz: e.gz, cy: CONC })
  if (tx === 0 && ctx.key.tz === 0) markSpawn(map, ctx, { ...spawnCells(seed)[0], cy: TRAIN })

  // Furniture last (the stair stamps carve their cores first).
  for (const [cy, p] of pieces) {
    if (p.raw) {
      if (!map.cellAt(p.raw.gx, cy, p.raw.gz).col) map.addFurniture(p.raw.gx, cy, p.raw.gz, p.raw.rec)
    } else addPiece(map, cy, p)
  }
  return {}
}
