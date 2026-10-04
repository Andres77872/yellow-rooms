import { CHUNK as CHUNK_CELLS, cIdx, hIdx, vIdx } from '../../constants.js'
import {
  CELL_CORRIDOR,
  CELL_LOBBY,
  FloorPlan,
  PASSAGE_DOOR,
  PASSAGE_WALL,
  SPACE_ROLE_BATHROOM,
  SPACE_ROLE_BEDROOM,
  SPACE_ROLE_DINING,
  SPACE_ROLE_KITCHEN,
  SPACE_ROLE_LAUNDRY,
  SPACE_ROLE_LIVING,
  SPACE_ROLE_LOUNGE,
  SPACE_ROLE_NONE,
  SPACE_ROLE_OFFICE,
  labelFloor,
  rng,
} from '../../tiles/floorPlan.js'
import { normalizeDoorPassages } from '../../doors.js'
import { markExit, markSpawn } from '../../tiles/kit.js'
import { openOwnedSeam } from '../../tiles/seams.js'
import { hashChain } from '../../tiles/tileKey.js'
import { stairwellPlan } from '../../structures/authored.js'
import { SALT, SPAWN_CELLS, hallSpec, labelOf } from './geometry.js'
import { CORR, D, W, planTile } from './layout.js'
import { furnishHouseRooms, placeClock } from './furnish.js'
import {
  FLOORS,
  LOOP_Q,
  RED,
  SHELL,
  WARM,
  YARD,
  buildLoopAt,
  buildShellPlan,
  copyContents,
  furnishShell,
  mutateLoopWith,
  qCell,
  rewallRing,
} from './tile.js'

// THE tile program of the house family (spec §3.3, §12.11): one 3×2-chunk
// world tile at ctx.origin over storeys 0..2, drawn from the tile's GROWN
// plan (layout.planTile: a corridor graph and a domestic room packing round
// the frame's set pieces), not from a copied floor plan. The parts come from
// tile.js (the kind's catalogue): the P.T. loop at the plan's size and place,
// the shell on tile (0,0), the room operations; the Great Hall is the
// planner's 'houseCatalog' volume through ctx.kit.atrium (geometry.hallOf),
// the stair cores kit.stairwell (geometry.frameOf).
//
//   storey 0   all six chunks: the four seam doors (hashed per seam), the
//              hallways, rooms, rooms behind rooms, closets; the loop; the
//              Great Hall's floor; the shell and its yard on tile (0,0)
//   storeys 1..2  the frame's chunk sets (every tile stacks differently):
//              landings off the stair cores, bedrooms, the hall's galleries
//              (a landing door, the Winchester door on top)
//
// One hashed anomaly per tile at most (geometry.anomalyAt): a mutated L of
// the loop, the red hallway (the longest straight run on storey 0) or the
// copied room (a room and its twin, piece for piece). Storey plates from
// geometry.labelOf; the exit (the hall's floor) and spawn through the
// markers.

// The plan's domestic roles (layout.ROLE_SPEC) as space roles: the study is
// an office (a desk), the den a lounge (a sofa), the nursery a bedroom, a
// closet no role (bare and dark).
const ROLE_CODE = Object.freeze({
  living: SPACE_ROLE_LIVING,
  dining: SPACE_ROLE_DINING,
  kitchen: SPACE_ROLE_KITCHEN,
  bed: SPACE_ROLE_BEDROOM,
  nursery: SPACE_ROLE_BEDROOM,
  study: SPACE_ROLE_OFFICE,
  den: SPACE_ROLE_LOUNGE,
  bath: SPACE_ROLE_BATHROOM,
  laundry: SPACE_ROLE_LAUNDRY,
  closet: SPACE_ROLE_NONE,
})

const REGION = Object.freeze({ x0: 0, z0: 0, x1: W - 1, z1: D - 1 })
// Lit lamps per chunk-storey after the tile's own lamps (§11.1 item 9: 12;
// the 60 u gate counts the fill light's fixtures too).
export const LIT_CAP = 9
// The tile's middle chunk column takes one fewer: a 60 u circle round one
// of its chunks holds nearly the whole tile (and the middle of the tiles
// north and south), so the 72-in-60 u gate binds there first.
// The front door's tile (0,0) takes one more (doc §3: the first rooms are
// warm and lit; its neighbours keep the 60 u count under the gate).
export const litCapOf = (d, origin) => (d.cx - origin.cx === 1 ? LIT_CAP - 1 : LIT_CAP) + (origin.cx === 0 && origin.cz === 0 ? 1 : 0)
const LOOP_SPACE = 900 // the loop closets' space ids (900..913)
const DARK_ROOM = 7 // one room in 7 sleeps dark (none by the front door: depth ≤ 1)
// Rooms left bare, by tile depth (doc §3: "the first rooms are warm, lit
// and furnished"; deeper, the house has rooms it has not got round to): a
// share in 1000 of the furnished roles, never by the front door.
export const bareShareOf = (depth) => (depth <= 3 ? 0 : depth <= 8 ? 120 : 250)
// Hall clocks per storey (the dead ends of its hallways and the alcoves).
const CLOCKS = 4

export function buildWorldHouse(map, ctx) {
  const { worldSeed, key } = ctx
  const plan = planTile(worldSeed, key.tx, key.tz)
  const { frame, hall, anomaly, loop } = plan
  const shellTile = frame.variant === 'shell'
  // The furnishing dice: per bake attempt (tileSeed) and per tile.
  const r = rng(hashChain(ctx.tileSeed, key.tx, key.tz, key.band), SALT)
  const unjoined = plan.storeys.reduce((n, s) => n + (s.unjoined ?? 0), 0)
  if (unjoined) return { error: `house: ${unjoined} doors left off the hallways` }

  // --- the rooms' records (ids, roles), drawn by the floor plans --------------------------
  const salt = () => r(map.nextRoomId, 7) & 0xffff
  const recs = plan.storeys.map((st, cy) => roomRecords(map, cy, st, plan.copy?.cy === cy ? plan.copy : null, salt))

  // --- the floor plans ------------------------------------------------------------------
  let loopMut = null
  for (let cy = 0; cy < FLOORS; cy++) {
    const st = plan.storeys[cy]
    const p = new FloorPlan(REGION)
    if (cy === 0 && loop) {
      const L = { x0: loop.x0, z0: loop.z0, S: loop.S, LX: loop.LX, LZ: loop.LZ }
      buildLoopAt(p, L, LOOP_SPACE)
      if (anomaly?.cls === 'loop') loopMut = mutateLoopWith(p, anomaly.loop.anomaly, anomaly.loop.q, L, LOOP_SPACE + 10)
      // The module is sealed but for its two doors (the hallways round it
      // may pass close by); an extra door's closet (in the block) is part
      // of it.
      const cells = [...loop.cells]
      if (loopMut?.anomaly === 'extraDoor') {
        const c = qCell(L, loopMut.q, L.x0 + 2, L.z0 + 3)
        cells.push(c.gz * W + c.gx)
      }
      sealModule(p, cells, [loop.entry, loop.exit])
    }
    if (cy === 0 && shellTile) {
      buildShellPlan(p)
      const cells = []
      for (let z = SHELL.z0; z <= SHELL.z1; z++) for (let x = SHELL.x0; x <= SHELL.x1; x++) cells.push(z * W + x)
      sealModule(p, cells, [{ axis: 'h', gx: 5, gz: 17 }, { axis: 'h', gx: 5, gz: 22 }, { axis: 'h', gx: 6, gz: 22, keep: true }])
    }
    // The grown storey after the set pieces (the loop's mirrors copy only
    // the loop).
    for (const c of st.corridors) p.open(c % W, Math.floor(c / W), CELL_CORRIDOR)
    // Each room walled with its door (a room behind a room opens through
    // its parent's wall: parents come first, the child's door wins).
    for (const rm of recs[cy]) p.room(rm, { spaceId: rm.id, role: rm.role, doors: [rm.door] })
    // The second doors (room to room, a back room to a hallway) after every
    // room's walls, so no later room walls one shut.
    for (const l of st.links) p.edge(l.axis, l.gx, l.gz, 0, PASSAGE_DOOR)
    for (const l of st.frontDoors ?? []) p.edge(l.axis, l.gx, l.gz, 0, PASSAGE_DOOR)
    // The hall doors: one house's hall opening on the next (layout.hallCapOf).
    for (const l of st.hallDoors ?? []) p.edge(l.axis, l.gx, l.gz, 0, PASSAGE_DOOR)
    if (hall) p.rect(hall.geometry.ring, CELL_LOBBY)
    p.compile(map, cy)
  }
  // §6.8 rule 3: open the owned West/North lines at the declared ports.
  for (let cy = 0; cy < FLOORS; cy++) {
    openOwnedSeam(map, ctx, cy, 'west')
    openOwnedSeam(map, ctx, cy, 'north')
  }

  // --- stamps: the Great Hall, then the stair cores -------------------------------------
  if (hall) {
    const view = ctx.kit.atrium(map, hallSpec(hall.geometry))
    if (view === null) return { error: 'house: great hall (planner null slot)' }
    if (view.error) return { error: `house: ${view.error}` }
  }
  for (const s of frame.stairs) {
    const sp = stairwellPlan({ gx: s.gx, gz: s.gz, baseCy: 0, topCy: s.top, dir: s.dir, doorSide: s.doorSide })
    if (sp.error) return { error: `house: ${sp.error}` }
    ctx.kit.stairwell(map, sp, { enclosed: true })
  }
  if (hall) {
    rewallRing(map, hall.geometry.ring, plan.storeys.map((st, cy) => [...plan.hallDoors[cy], ...st.ringDoors]))
    markExit(map, ctx, { ...hall.geometry.exit, cy: 0 })
  }
  if (shellTile) {
    markSpawn(map, ctx, { ...SPAWN_CELLS[0], cy: 0 })
    // The garden lamps burn by the front door (doc §3: "homely, then
    // wrong" — the first thing the house shows is a lit yard).
    for (const gx of [YARD.x0 + 1, YARD.x1 - 1]) map.setLamp(gx, 0, YARD.z1 - 1, true, WARM)
  }

  // --- rooms ------------------------------------------------------------------------------
  let rooms = 0
  if (shellTile) {
    furnishShell(map, r, (r(1) & 1) === 1, salt)
    rooms += 4
  }
  // The hall clocks first: a chunk's kind slots (furnish.KIND_CAP) keep one
  // for the house's own prop.
  for (let cy = 0; cy < FLOORS; cy++) placeClocks(map, r, cy, plan)
  const pendants = [[], [], []]
  for (let cy = 0; cy < FLOORS; cy++) rooms += drawRooms(map, r, cy, plan.storeys[cy], recs[cy], plan.copy?.cy === cy ? plan.copy : null, plan.depth, pendants[cy])
  // A door with no wall beside it reads as a wide opening (roomOps'
  // stampRoomShell rule, once per chunk).
  for (const d of map.chunks.values()) normalizeDoorPassages(d)

  // --- finish -----------------------------------------------------------------------------
  // The red hallway: the ground storey's longest straight run burns red,
  // every tube lit (a tube every third cell).
  if (anomaly?.cls === 'red' && plan.red) {
    plan.red.forEach((c, i) => {
      const lamp = map.lampAt(c.gx, 0, c.gz)
      if (lamp || i % 3 === 1) map.setLamp(c.gx, 0, c.gz, true, RED)
    })
  }
  for (let cy = 0; cy < FLOORS; cy++) labelFloor(map, cy, labelOf(worldSeed, key, cy))
  // Lamps under ceiling openings would hang in mid-air; the lamp cap keeps
  // the world's light budget (the red hallway keeps its tubes).
  for (const d of map.chunks.values()) d.lamps = d.lamps.filter((l) => !d.hasCeilHole(l.lx, l.lz))
  // The loop's four elbow lamps are the comparison P.T. invites: the cap
  // never dims one (a dark elbow is an anomaly only when the tile says so).
  const keep = new Set()
  if (loop) {
    for (let q = 0; q < 4; q++) {
      const c = qCell(loop, q, loop.x0 + 1, loop.z0 + 1)
      const hit = map.lampAt(c.gx, 0, c.gz)
      if (hit) keep.add(hit.rec)
    }
  }
  for (let cy = 0; cy < FLOORS; cy++) lightStorey(map, r, cy, plan, pendants[cy])
  const area = new Map()
  for (const list of recs) for (const rm of list) area.set(rm.id, (rm.x1 - rm.x0 + 1) * (rm.z1 - rm.z0 + 1))
  capLitLamps(map, r, keep, area)
  const st0 = plan.storeys[0]
  ctx.notes.push(
    `house tile ${key.tx},${key.tz}: ${frame.variant}${loop ? ` · loop ${loop.S}` : ''}${hall ? ` · great hall ${hall.geometry.shape.w}×${hall.geometry.shape.d}` : ''} · ${rooms} rooms · ${st0.corridors.length} hallway cells · ${frame.stairs.length} stair${frame.stairs.length > 1 ? 's' : ''}`,
    ...(anomaly ? [`anomaly: ${anomaly.cls}${loopMut ? ` (${LOOP_Q[loopMut.q]} ${loopMut.anomaly})` : ''}${anomaly.cls === 'copy' && !plan.copy ? ' (no twin fits)' : ''}`] : []),
  )
  return { spawn: shellTile ? { ...SPAWN_CELLS[0], cy: 0 } : null, exit: hall ? { ...hall.geometry.exit, cy: 0 } : null, notes: [] }
}

// Explicit walls round a module's cells (plan cells it owns), except its
// door edges ({axis, gx, gz}; keep: leave a feature edge the module wrote).
function sealModule(p, cells, doors) {
  const set = new Set(cells)
  const isDoor = (axis, gx, gz) => doors.find((d) => d.axis === axis && d.gx === gx && d.gz === gz)
  const wall = (axis, gx, gz) => {
    const d = isDoor(axis, gx, gz)
    if (d?.keep) return
    if (d) p.edge(axis, gx, gz, 0, PASSAGE_DOOR)
    else p.edge(axis, gx, gz, 1, PASSAGE_WALL)
  }
  for (const c of set) {
    const x = c % W
    const z = (c - x) / W
    if (!set.has(c - 1) || x === 0) wall('v', x, z)
    if (!set.has(c + 1) || x === W - 1) wall('v', x + 1, z)
    if (!set.has(c - W)) wall('h', x, z)
    if (!set.has(c + W)) wall('h', x, z + 1)
  }
}

// The room records of one storey (ids, roles, salts); the copied room's
// twin takes its source's role and salt.
function roomRecords(map, cy, st, copy, nextSalt) {
  const recs = st.rooms.map((p) => {
    const role = ROLE_CODE[p.role] ?? SPACE_ROLE_NONE
    return { id: map.nextRoomId++, cy, x0: p.x0, z0: p.z0, x1: p.x1, z1: p.z1, role, salt: nextSalt(), door: { axis: p.door.axis, gx: p.door.gx, gz: p.door.gz }, baked: false }
  })
  if (copy) Object.assign(recs[copy.room], { role: recs[copy.of].role, salt: recs[copy.of].salt })
  return recs
}

// Light and furnish one storey's rooms (the floor plan walled them): every
// room by its domestic role (furnish.js); closets stay bare and dark; deeper
// tiles leave a share bare; the copied room's twin takes its source's lamp
// and furniture piece for piece. Returns the room count.
function drawRooms(map, r, cy, st, recs, copy, depth, pendants) {
  const twin = copy ? copy.room : -1
  const bare = bareShareOf(depth)
  const list = []
  recs.forEach((rm, i) => {
    const p = st.rooms[i]
    if (i !== twin && p.kind !== 'closet') {
      const dark = depth > 1 && r(500 + i, cy) % DARK_ROOM === 0
      const empty = i !== copy?.of && r(800 + i, cy) % 1000 < bare
      list.push({ rec: rm, role: empty ? null : p.role, dark })
    }
    map.rooms.push(rm)
  })
  const states = furnishHouseRooms(map, list, r)
  // The pendants: a dark room's hangs dead now (authored darkness); the
  // copied room's source burns (its twin copies it); the rest wait for the
  // storey's light budget (lightStorey).
  states.forEach((s, k) => {
    const { dark, rec } = list[k]
    const forced = copy && rec === recs[copy.of]
    if (dark || forced) map.setLamp(s.lamp.gx, cy, s.lamp.gz, !dark, dark ? null : WARM)
    else pendants.push({ gx: s.lamp.gx, gz: s.lamp.gz, room: st.rooms[recs.indexOf(rec)], door: rec.door })
  })
  if (copy) copyContents(map, recs[copy.of], copy.dx, copy.dz)
  return recs.length
}

// The hall clocks: against the far wall of a hallway's dead end or an
// alcove (a hallway cell with one hallway neighbour, no door onto it, not a
// seam, stair, hall or loop door), at most one per chunk and CLOCKS per
// storey, in a dice order.
function placeClocks(map, r, cy, plan) {
  const st = plan.storeys[cy]
  const g = plan.grids[cy]
  const keep = new Set()
  const f = plan.frame
  for (const s of f.stairs) keep.add(s.door.out.gz * W + s.door.out.gx)
  for (const d of plan.hallDoors[cy]) keep.add(d.out.gz * W + d.out.gx)
  for (const d of st.ringDoors) keep.add(d.out.gz * W + d.out.gx)
  if (cy === 0 && plan.loop) for (const d of [plan.loop.entry, plan.loop.exit]) keep.add(d.out.gz * W + d.out.gx)
  const sides = [['E', 1, 0], ['S', 0, 1], ['W', -1, 0], ['N', 0, -1]]
  const cands = []
  for (const c of st.corridors) {
    const x = c % W
    const z = (c - x) / W
    if (x === 0 || z === 0 || x === W - 1 || z === D - 1 || keep.has(c)) continue
    let corr = 0
    let open = null
    for (const [, dx, dz] of sides) {
      const n = (z + dz) * W + x + dx
      if (x + dx >= 0 && x + dx < W && z + dz >= 0 && z + dz < D && g[n] === CORR) {
        corr++
        open = [dx, dz]
      }
    }
    if (corr !== 1) continue
    // No door, second door or opening onto the cell but its one hallway side.
    let doors = 0
    for (const [, dx, dz] of sides) {
      const e = dx ? map.wallVAt(dx > 0 ? x + 1 : x, cy, z) : map.wallHAt(x, cy, dz > 0 ? z + 1 : z)
      if (!e.wall) doors++
    }
    if (doors !== 1) continue
    const back = sides.find(([, dx, dz]) => dx === -open[0] && dz === -open[1])[0]
    cands.push({ gx: x, gz: z, wall: back, k: r(0xc10c + c, cy) })
  }
  cands.sort((a, b) => a.k - b.k)
  const used = new Set()
  let n = 0
  for (const c of cands) {
    if (n >= CLOCKS) break
    const ck = `${map.cellChunk(c.gx)},${map.cellChunk(c.gz)}`
    if (used.has(ck)) continue
    if (placeClock(map, cy, c)) {
      used.add(ck)
      n++
    }
  }
}

// The storey's light budget (spec §11.1 item 9: LIT_CAP lit lamps per
// chunk-storey, under the 12 gate and the 72-in-60 u gate): a greedy cover
// over the plan. Candidates are the rooms' pendants (each by its door) and a
// ceiling light over any hallway or stairwell-landing cell; each lights the
// cells the light model reaches from it (within LIT_R2, in line of sight
// through the walls, the pieces and the mass: sightOf). Each round hangs the
// one that lights the most cells still dark (a pendant scores PENDANT more),
// in a chunk under its budget (litCapOf), no hallway light within two cells
// of another nor any light beside one. The fill light then tops up what the
// budget leaves (generator.js).
function lightStorey(map, r, cy, plan, pendants) {
  const g = plan.grids[cy]
  const chunkOf = (x, z) => map.chunkAt(map.cellChunk(x), cy, map.cellChunk(z))
  const free = (x, z) => {
    const d = chunkOf(x, z)
    const lx = map.cellLocal(x)
    const lz = map.cellLocal(z)
    return d !== null && d.cols[cIdx(lx, lz)] === 0 && !d.hasCeilHole(lx, lz)
  }
  const walk = new Uint8Array(W * D)
  for (let z = 0; z < D; z++) {
    for (let x = 0; x < W; x++) {
      const v = g[z * W + x]
      if ((v === CORR || v >= 10) && free(x, z)) walk[z * W + x] = 1
    }
  }
  // The stairwells' landings and flights (the cores of the frame's stairs
  // this storey keeps): a light over a landing lights its stairwell.
  const stairCells = []
  for (const s of plan.frame.stairs) {
    if (cy > s.top) continue
    for (let z = s.core.z0; z <= s.core.z1; z++) {
      for (let x = s.core.x0; x <= s.core.x1; x++) {
        const c = map.cellAt(x, cy, z)
        if (c.chunk === null || c.col !== 0 || c.chunk.hasFloorHole(map.cellLocal(x), map.cellLocal(z))) continue
        walk[z * W + x] = 1
        stairCells.push(z * W + x)
      }
    }
  }
  const lit = new Uint8Array(W * D)
  const covers = []
  // What a fixture lights: the walkable cells within LIT_R2 (squared cells;
  // the light model's cubic window falls under the dark line beyond) that
  // its sight line reaches (sightOf: the game's grid sight, walls and mass
  // block).
  const sight = sightOf(map, cy)
  const cover = (x0, z0) => {
    const out = []
    for (let k = 0; k < LIT_OFFSETS.length; k++) {
      const x = x0 + LIT_OFFSETS[k][0]
      const z = z0 + LIT_OFFSETS[k][1]
      if (x < 0 || z < 0 || x >= W || z >= D || !walk[z * W + x]) continue
      if (sight(x0, z0, k)) out.push(z * W + x)
    }
    return out
  }
  // Already burning: the loop, the shell, the red tubes, the forced pendants.
  const count = new Map()
  // Cells within two (Chebyshev) of a hallway light take no second hallway
  // light; cells next to any light take none.
  const crowded = new Uint8Array(W * D)
  const near = new Uint8Array(W * D)
  const crowd = (gx, gz, hall) => {
    for (let z = Math.max(0, gz - 2); z <= Math.min(D - 1, gz + 2); z++) {
      for (let x = Math.max(0, gx - 2); x <= Math.min(W - 1, gx + 2); x++) {
        if (hall) crowded[z * W + x] = 1
        if (Math.abs(x - gx) <= 1 && Math.abs(z - gz) <= 1) near[z * W + x] = 1
      }
    }
  }
  const lamped = new Uint8Array(W * D)
  for (const d of map.chunks.values()) {
    if (d.cy !== cy + map.origin.cy) continue
    let n = 0
    for (const l of d.lamps) {
      const gx = (d.cx - map.origin.cx) * CHUNK_CELLS + l.lx
      const gz = (d.cz - map.origin.cz) * CHUNK_CELLS + l.lz
      const inTile = gx >= 0 && gz >= 0 && gx < W && gz < D
      if (inTile) lamped[gz * W + gx] = 1
      if (!l.lit) continue
      n++
      if (!inTile) continue
      for (const c of cover(gx, gz)) lit[c] = 1
      crowd(gx, gz, g[gz * W + gx] === CORR)
    }
    count.set(d, n)
  }
  // A candidate's cover is drawn when it first tops the heap (until then
  // its gain is bounded by the walkable cells in reach, sight or not).
  const reach = (x0, z0) => {
    let n = 0
    for (const [dx, dz] of LIT_OFFSETS) {
      const x = x0 + dx
      const z = z0 + dz
      if (x >= 0 && z >= 0 && x < W && z < D && walk[z * W + x]) n++
    }
    return n
  }
  const caps = new Map()
  const cand = (gx, gz, hall, k, bonus = 0) => {
    const d = chunkOf(gx, gz)
    let cap = caps.get(d)
    if (cap === undefined) caps.set(d, (cap = litCapOf(d, map.origin)))
    covers.push({ gx, gz, cells: null, hall, k, d, cap, bonus, n: reach(gx, gz) + bonus })
  }
  // The rooms' pendants (by the door), for the rooms that wait for the
  // budget; the hallways; the stairwells' landings.
  for (const p of pendants) {
    cand(p.gx, p.gz, false, r(0x11a0 + p.gz * W + p.gx, cy), plan.depth <= 1 ? PENDANT_NEAR : PENDANT)
  }
  for (const c of plan.storeys[cy].corridors) {
    const x = c % W
    const z = (c - x) / W
    if (!walk[c] || lamped[c]) continue
    cand(x, z, true, r(0x11a1 + c, cy))
  }
  for (const c of stairCells) {
    const x = c % W
    const z = (c - x) / W
    if (!free(x, z) || lamped[c]) continue
    cand(x, z, true, r(0x11a2 + c, cy))
  }
  // Lazy greedy (a candidate's gain only falls as cells light, its chunk
  // fills and hallway lights crowd it): a max-heap on (gain, then the lower
  // dice); the top is taken once its fresh gain still tops the heap.
  const above = (a, b) => a.n > b.n || (a.n === b.n && a.k < b.k)
  const heap = []
  const push = (c) => {
    heap.push(c)
    for (let i = heap.length - 1; i > 0;) {
      const p = (i - 1) >> 1
      if (!above(heap[i], heap[p])) break
      ;[heap[i], heap[p]] = [heap[p], heap[i]]
      i = p
    }
  }
  const pop = () => {
    const top = heap[0]
    const last = heap.pop()
    if (heap.length) {
      heap[0] = last
      for (let i = 0; ;) {
        const a = 2 * i + 1
        const b = a + 1
        let m = i
        if (a < heap.length && above(heap[a], heap[m])) m = a
        if (b < heap.length && above(heap[b], heap[m])) m = b
        if (m === i) break
        ;[heap[i], heap[m]] = [heap[m], heap[i]]
        i = m
      }
    }
    return top
  }
  for (const c of covers) push(c)
  while (heap.length) {
    const c = pop()
    if ((count.get(c.d) ?? 0) >= c.cap) continue
    if (near[c.gz * W + c.gx] || (c.hall && crowded[c.gz * W + c.gx])) continue
    c.cells ??= cover(c.gx, c.gz)
    let n = 0
    for (const i of c.cells) if (!lit[i]) n++
    if (n < 2) continue
    n += c.bonus
    if (n < c.n) {
      c.n = n
      push(c)
      continue
    }
    map.setLamp(c.gx, cy, c.gz, true, WARM)
    count.set(c.d, (count.get(c.d) ?? 0) + 1)
    for (const i of c.cells) lit[i] = 1
    crowd(c.gx, c.gz, c.hall)
  }
}

// A room's own pendant counts as lighting this many cells more than it
// does (by the front door, depth ≤ 1, more: doc §3, "the first rooms are
// warm, lit and furnished"), so the budget goes room first.
const PENDANT = 1
const PENDANT_NEAR = 2

// Cells a fixture lights: within LIT_R2 squared cells, where the light
// model's (1 − d / LIGHT_RANGE)³ stays over the 0.02 dark line (d ≤ 2.67
// cells), nearest first.
const LIT_R2 = 7
const LIT_OFFSETS = (() => {
  const out = []
  for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) if (dx * dx + dz * dz <= LIT_R2) out.push([dx, dz])
  return Object.freeze(out.sort((a, b) => a[0] ** 2 + a[1] ** 2 - b[0] ** 2 - b[1] ** 2))
})()

// The game's grid sight line (player/collision gridLineClear) from a cell
// centre to the centre of the cell (dx, dz) away: the edges it crosses and
// the cells it passes, in order (a tie steps along z first), the same for
// every origin, so drawn once per offset.
const SIGHT_PATHS = LIT_OFFSETS.map(([dx, dz]) => {
  const out = [] // [kind, x, z] triples: 0 a V edge (west side of x), 1 an H edge (north side of z), 2 a cell
  const sx = Math.sign(dx)
  const sz = Math.sign(dz)
  const tdx = dx ? 1 / Math.abs(dx) : Infinity
  const tdz = dz ? 1 / Math.abs(dz) : Infinity
  let tx = dx ? 0.5 / Math.abs(dx) : Infinity
  let tz = dz ? 0.5 / Math.abs(dz) : Infinity
  let x = 0
  let z = 0
  let first = true
  while (x !== dx || z !== dz) {
    if (!first) out.push([2, x, z])
    first = false
    if (tx < tz) {
      out.push([0, sx > 0 ? x + 1 : x, z])
      x += sx
      tx += tdx
    } else {
      out.push([1, x, sz > 0 ? z + 1 : z])
      z += sz
      tz += tdz
    }
  }
  return Int8Array.from(out.flat())
})

// Whether storey cy of the tile has sight from cell (x0, z0) to the cell of
// offset k (LIT_OFFSETS): a wall on an edge it crosses or mass in a cell it
// passes blocks.
function sightOf(map, cy) {
  // Read straight off the tile's chunks (a missing chunk is mass); the
  // tile's own east and south lines are never crossed (every target is in
  // the tile).
  const V = new Uint8Array((W + 1) * D)
  const H = new Uint8Array(W * (D + 1))
  const M = new Uint8Array(W * D).fill(1)
  for (let lcz = 0; lcz * CHUNK_CELLS < D; lcz++) {
    for (let lcx = 0; lcx * CHUNK_CELLS < W; lcx++) {
      const d = map.chunkAt(lcx, cy, lcz)
      if (!d) continue
      for (let lz = 0; lz < CHUNK_CELLS; lz++) {
        for (let lx = 0; lx < CHUNK_CELLS; lx++) {
          const x = lcx * CHUNK_CELLS + lx
          const z = lcz * CHUNK_CELLS + lz
          if (d.wallV[vIdx(lx, lz)]) V[z * (W + 1) + x] = 1
          if (d.wallH[hIdx(lx, lz)]) H[z * W + x] = 1
          const col = d.cols[cIdx(lx, lz)]
          M[z * W + x] = col === 1 || col === 2 ? 1 : 0
        }
      }
    }
  }
  return (x0, z0, k) => {
    const path = SIGHT_PATHS[k]
    for (let i = 0; i < path.length; i += 3) {
      const x = x0 + path[i + 1]
      const z = z0 + path[i + 2]
      const kind = path[i]
      if (kind === 0 ? V[z * (W + 1) + x] : kind === 1 ? H[z * W + x] : M[z * W + x]) return false
    }
    return true
  }
}

// Tile mode: at most `cap` lit lamps per chunk-storey (spec §11.1 item 9).
// A chunk over the cap keeps the `cap` lamps whose dice rank lowest lit
// (red tubes and the `keep` lamps first: the red hallway is the anomaly;
// then by the floor each lights). The rest come DOWN, not dark: a dead
// fixture is authored darkness to the fill light (a dark room by design),
// while a room without its own pendant is lit by the fill light's fixtures
// where they light the most.
function capLitLamps(map, r, keep, area) {
  for (const d of map.chunks.values()) {
    const cap = litCapOf(d, map.origin)
    const lit = d.lamps.filter((l) => l.lit)
    if (lit.length <= cap) continue
    // Then the lamps that light the most floor (a room's area; a hallway
    // tube counts as 8 cells), then the dice.
    const floor = (l) => Math.min(20, area.get(d.spaceId[cIdx(l.lx, l.lz)]) ?? 8)
    const rank = (l) => (l.tint === RED || keep.has(l) ? 0 : 1) * 0x100000000 + (20 - floor(l)) * 0x1000000 + (r(1000 + d.cy * 256 + l.lx * 16 + l.lz, d.cx * 64 + d.cz) & 0xffffff)
    lit.sort((a, b) => rank(a) - rank(b) || a.lx - b.lx || a.lz - b.lz)
    const down = new Set(lit.slice(cap))
    d.lamps = d.lamps.filter((l) => !down.has(l))
  }
}
