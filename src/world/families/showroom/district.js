import {
  CELL_CORRIDOR,
  CELL_LOBBY,
  CELL_OPEN,
  CHUNK,
  COLUMN_MONUMENTAL,
  FACING,
  FloorPlan,
  PASSAGE_DOOR,
  PASSAGE_WALL,
  SPACE_ROLE_BEDROOM,
  SPACE_ROLE_BREAK,
  SPACE_ROLE_LIVING,
  SPACE_ROLE_OFFICE,
  SPACE_ROLE_STORAGE,
  STAIR_E,
  STAIR_N,
  STAIR_S,
  STAIR_W,
  WALL_TO_FRONT,
  addPiece,
  labelFloor,
  rng,
} from '../../tiles/floorPlan.js'
import { FURN_BOOKSHELF, FURN_CHAIR, FURN_COUNTER, FURN_RACK, FURN_TABLE, FURN_WARDROBE } from '../../rooms/catalog.js'
import { PROP_BAG_BIN, PROP_CART, PROP_FLATPACK } from '../../props/index.js'
import { stairwellPlan } from '../../structures/authored.js'
import { markExit, markSpawn } from '../../tiles/kit.js'
import { clearRoomObjects, createRoom, furnishRoom } from '../../tiles/roomOps.js'
import { openOwnedSeam } from '../../tiles/seams.js'
import { hashChain } from '../../tiles/tileKey.js'
import { DOWN, N, REGION, UP, aisleOf, anomalyAt, districtSeed, idx, mutationClassAt, oddCopyOf } from './geometry.js'
import { DEPT, K_CORE, K_CUT, K_HALL, K_LANE, K_LOBBY, K_LOOP, K_ROOM, K_SPUR, hallLayout, hallExitOf, routeLayout } from './layout.js'
import { PROP_KIND_CAP, ROLES, ROLE_NAME, WARM, capRunKinds, frontEdges, oddPool, openFrontSide, paste, put, roomItems } from './parts.js'

// THE showroom family's tile program (spec §3.3, §12.3; doc 09 §4.4): one
// world tile, a district on two storeys, drawn from its grammar — the macro
// plan (geometry.districtPlan: lattice, serpentine, lanes, cores, spurs, the
// hall's lobby corridor) and the fine layout (layout.js: partitions,
// shortcuts, the loop, vignette rooms, the hall's departments, its fire
// exit). Nothing of one district is copied into another: the elements repeat
// (the vignette roles, the room sets shown again and again down the route,
// the till rows, the rack lines), the arrangement never does.
//   cy 0  the route: a 2-wide serpentine from stair A's door to stair B's,
//         lined on its free sides by three-walled room sets opened WIDE onto
//         it; each new layout (role at that size and front) shows 2–3×
//         exactly in route order, then the district's one odd copy; a
//         wardrobe display and a lighting department are the one-offs;
//         unmarked shortcut gaps; the seam passages north and south.
//   cy −1 the lower store: stair B's door opens on the departments (market
//         hall, warehouse, stockroom, café, checkouts), the checkouts leave
//         through the east port into the next district's lobby corridor and
//         its stair A. The fire exit is one hall cell of the east chunk column.
// Stairs A and B through ctx.kit.stairwell; exit and spawn through the kit
// markers; plates pure (oPEn, oUt on a loop district, HALL, the aisle
// number); caps by construction (≤ 9 lamps per chunk-storey: the cores' and
// rooms' fixtures, then a greedy cover of the still-dark floor, and the fill
// pass tops up to 9 too; ≤ 90 pieces and ≤ 14 kinds per chunk). The repeat
// anomaly shows one room set in every size, never closing a run.

export const LOOP_TINT = 0x7dffa8 // exit-sign green
export const LOOP_PLATE = 'oUt'
export const WORLD_PARAMS = Object.freeze({ grammar: 'district' })
export { WARM }

const STAIR = { E: STAIR_E, W: STAIR_W, N: STAIR_N, S: STAIR_S }
const BACK_ROLE = { storage: SPACE_ROLE_STORAGE, break: SPACE_ROLE_BREAK, office: SPACE_ROLE_OFFICE }
const W = N + 1
const LAMP_CAP = 9 // per chunk-storey, before the fill pass (gate 12 lit, 72 within 60 u)
const PIECE_CAP = 88 // per chunk (gate 90)
const SALT = 0x09a1

const chunkKeyOf = (x, z) => Math.floor(x / CHUNK) * 2 + Math.floor(z / CHUNK)

// A vignette's warm fixture: centred across, one row in from its open front
// (the furnishing grammar keeps its cell free).
export function vLamp(rect, front) {
  const mx = (rect.x0 + rect.x1) >> 1
  const mz = (rect.z0 + rect.z1) >> 1
  if (front === 'S') return { gx: mx, gz: rect.z1 - 1 }
  if (front === 'N') return { gx: mx, gz: rect.z0 + 1 }
  if (front === 'E') return { gx: rect.x1 - 1, gz: mz }
  return { gx: rect.x0 + 1, gz: mz }
}

const KIND_OF_UP = { [K_LANE]: CELL_CORRIDOR, [K_SPUR]: CELL_CORRIDOR, [K_LOOP]: CELL_CORRIDOR, [K_CORE]: CELL_LOBBY, [K_ROOM]: CELL_OPEN, [K_CUT]: CELL_OPEN }
const KIND_OF_DOWN = { [K_CORE]: CELL_LOBBY, [K_LOBBY]: CELL_LOBBY, [K_HALL]: CELL_OPEN }

export function buildShowroomDistrict(map, ctx) {
  const { worldSeed } = ctx
  const { tx, tz } = ctx.key
  const R = routeLayout(worldSeed, tx, tz)
  const H = hallLayout(worldSeed, tx, tz)
  const plan = R.plan
  const anomaly = anomalyAt(worldSeed, ctx.key)
  const repeat = anomaly === 'repeat'
  const r = rng(hashChain(districtSeed(worldSeed, tx, tz), 0x77), SALT)
  const notes = []

  // --- the route storey --------------------------------------------------------------
  const up = new FloorPlan(REGION)
  for (let k = 0; k < W * W; k++) {
    const t = KIND_OF_UP[R.kind[k]]
    if (t !== undefined) up.open(k % W, Math.floor(k / W), t)
  }
  for (const w of R.walls) up.edge(w.axis, w.gx, w.gz, 1, PASSAGE_WALL)

  // Vignettes in route order, the two one-off departments among them.
  const sets = R.vignettes
  // The lamp plan: each stair core's two fixtures (landing and foot
  // corners, on both storeys), every room's warm fixture (the lighting
  // department's on its tables), then the route's plain ones in route order,
  // ≤ LAMP_CAP per chunk-storey. Shortcuts stay unlit; the loop glows
  // exit-green.
  const lampCount = new Map()
  const bump = (x, z) => lampCount.set(chunkKeyOf(x, z), (lampCount.get(chunkKeyOf(x, z)) ?? 0) + 1)
  const coreLamps = plan.stairs.flatMap((s) => [{ gx: s.core.x0, gz: s.core.z0 }, { gx: s.core.x1, gz: s.core.z1 }])
  for (const c of coreLamps) bump(c.gx, c.gz)
  for (const v of sets) { const c = vLamp(v.rect, v.front); bump(c.gx, c.gz) }
  // The two one-off departments, in route order; the lighting department
  // only where its table lamps fit the chunk's budget.
  const depts = new Map()
  if (sets.length >= 4) {
    const a = Math.min(sets.length - 1, 2 + (r(0, 0x2f) % 6))
    depts.set(a, 'wardrobes')
    const b0 = Math.min(sets.length - 1, Math.max(a + 2, Math.floor(sets.length / 2) + (r(1, 0x2f) % 6)))
    for (let j = 0; j < sets.length; j++) {
      const b = (b0 + j) % sets.length
      if (b === a) continue
      const v = sets[b]
      const c = vLamp(v.rect, v.front)
      const extra = lightingTables(v.rect, v.front).length - 1
      if (extra < 0 || (lampCount.get(chunkKeyOf(c.gx, c.gz)) ?? 0) + extra > LAMP_CAP) continue
      lampCount.set(chunkKeyOf(c.gx, c.gz), lampCount.get(chunkKeyOf(c.gx, c.gz)) + extra)
      depts.set(b, 'lighting')
      break
    }
  }
  const roomLamps = sets.flatMap((v, i) => (depts.get(i) === 'lighting' ? lightingTables(v.rect, v.front) : [vLamp(v.rect, v.front)]))
  const lit = []
  if (R.loop) {
    const c0 = R.loop.parts[0]
    const k = c0.type === 'cut' ? c0.cells[Math.floor(c0.cells.length / 2)] : c0.ends[0]
    lit.push({ gx: k % W, gz: Math.floor(k / W), tint: LOOP_TINT })
  }
  // The route's plain fixtures: greedy cover of the storey's still-dark
  // cells, from lane and spur cells only (shortcuts stay unlit).
  const placed = [...lit, ...coreLamps]
  const upOpen = (k) => KIND_OF_UP[R.kind[k]] !== undefined && R.kind[k] !== K_CORE
  const routeCand = (k) => R.kind[k] === K_LANE || R.kind[k] === K_SPUR
  for (const c of coverLamps(upOpen, upOpen, routeCand, R.walls, [...placed, ...roomLamps], lampCount)) placed.push({ ...c, tint: null })
  for (const l of placed) if (!coreLamps.includes(l)) up.lamp(l.gx, l.gz, true, l.tint)
  up.compile(map, UP)

  // --- the hall storey ---------------------------------------------------------------
  const down = new FloorPlan(REGION)
  for (let k = 0; k < W * W; k++) {
    const t = KIND_OF_DOWN[H.kind[k]]
    if (t !== undefined) down.open(k % W, Math.floor(k / W), t)
  }
  for (const w of H.walls) down.edge(w.axis, w.gx, w.gz, 1, PASSAGE_WALL)
  const hallCount = new Map()
  for (const c of coreLamps) hallCount.set(chunkKeyOf(c.gx, c.gz), (hallCount.get(chunkKeyOf(c.gx, c.gz)) ?? 0) + 1)
  const hallLit = [...coreLamps]
  const hallDead = []
  // The authored fixtures first (back rooms, the checkout's lanes, the
  // warehouse's half-dead lines); the plain ceiling grid is the cover pass's.
  for (const l of [...H.lamps.filter((m) => m.room), ...H.lamps.filter((m) => !m.room && !m.grid)]) {
    const x = l.k % W
    const z = (l.k - x) / W
    const key = chunkKeyOf(x, z)
    if (l.lit && (hallCount.get(key) ?? 0) >= LAMP_CAP) continue
    if (l.lit) hallCount.set(key, (hallCount.get(key) ?? 0) + 1)
    ;(l.lit ? hallLit : hallDead).push({ gx: x, gz: z })
    down.lamp(x, z, l.lit)
  }
  // Fill the hall's dark pockets the same way, from aisle cells, but leave
  // the dead fixtures' authored dark alone.
  const downOpen = (k) => KIND_OF_DOWN[H.kind[k]] !== undefined && H.kind[k] !== K_CORE && !H.piers.has(k)
  const authored = (k) => hallDead.some((l) => Math.max(Math.abs(l.gx - (k % W)), Math.abs(l.gz - Math.floor(k / W))) <= 1)
  const hallTarget = (k) => downOpen(k) && !authored(k)
  const hallCand = (k) => hallTarget(k) && !H.furn.has(k) && (H.kind[k] === K_HALL || H.kind[k] === K_LOBBY)
  const roomWalls = H.rooms.flatMap(({ rect: q }) => {
    const out = []
    for (let x = q.x0; x <= q.x1; x++) out.push({ axis: 'h', gx: x, gz: q.z0 }, { axis: 'h', gx: x, gz: q.z1 + 1 })
    for (let z = q.z0; z <= q.z1; z++) out.push({ axis: 'v', gx: q.x0, gz: z }, { axis: 'v', gx: q.x1 + 1, gz: z })
    return out
  })
  for (const c of coverLamps(downOpen, hallTarget, hallCand, [...H.walls, ...roomWalls], hallLit, hallCount)) down.lamp(c.gx, c.gz, true)
  down.compile(map, DOWN)

  // §6.8 rule 3: open the owned West/North lines at the declared ports.
  for (const cy of [DOWN, UP]) {
    openOwnedSeam(map, ctx, cy, 'west')
    openOwnedSeam(map, ctx, cy, 'north')
  }

  // --- stamps ------------------------------------------------------------------------
  for (const s of plan.stairs) {
    const sp = stairwellPlan({ gx: s.gx, gz: s.gz, baseCy: DOWN, topCy: UP, dir: STAIR[s.dir], doorSide: s.doorSide })
    if (sp.error) return { error: `showroom stair: ${sp.error}` }
    const g = sp.globalCore
    if (g.x0 !== s.core.x0 || g.z0 !== s.core.z0 || g.x1 !== s.core.x1 || g.z1 !== s.core.z1) return { error: 'showroom stair: core mismatch' }
    ctx.kit.stairwell(map, sp, { enclosed: true })
  }
  // The cores' two fixtures on each storey: the cells nearest the core's
  // corners that keep a ceiling (the flight's opening has none).
  for (const s of plan.stairs) {
    for (const cy of [DOWN, UP]) {
      const free = []
      for (let z = s.core.z0; z <= s.core.z1; z++) {
        for (let x = s.core.x0; x <= s.core.x1; x++) {
          if (!map.chunkAt(map.cellChunk(x), cy, map.cellChunk(z)).hasCeilHole(map.cellLocal(x), map.cellLocal(z))) free.push({ x, z })
        }
      }
      for (const [cx, cz] of [[s.core.x0, s.core.z0], [s.core.x1, s.core.z1]]) {
        let best = null
        for (const c of free) if (!best || Math.abs(c.x - cx) + Math.abs(c.z - cz) < Math.abs(best.x - cx) + Math.abs(best.z - cz)) best = c
        if (!best) continue
        map.setLamp(best.x, cy, best.z, true)
        free.splice(free.indexOf(best), 1)
      }
    }
  }
  for (const k of H.piers) map.setCell(k % W, DOWN, Math.floor(k / W), { col: COLUMN_MONUMENTAL })

  // --- plates ------------------------------------------------------------------------
  labelFloor(map, UP, 'oPEn')
  if (anomaly === 'loop' && R.loop) labelFloor(map, UP, LOOP_PLATE, plan.stairs[0].chunk)
  labelFloor(map, DOWN, 'HALL')
  const ware = H.depts.find((dd) => dd.type === DEPT.WARE)
  if (ware) {
    const l = ware.leaf
    labelFloor(map, DOWN, aisleOf(worldSeed, tx, tz), { cx: Math.floor(((l.x0 + l.x1) >> 1) / CHUNK), cz: Math.floor(((l.z0 + l.z1) >> 1) / CHUNK) })
  }

  // --- vignettes ---------------------------------------------------------------------
  const vignettes = []
  const mutations = []
  const plain = []
  const runs = new Map() // 'w×d front' -> { role, exact, shown, master }
  let lastRole = -1
  let roll = 0
  const saltOf = (i) => r(i, 0x2f1) % 997
  sets.forEach((v, i) => {
    const { rect, front } = v
    const dept = depts.get(i)
    if (dept) {
      vignettes.push(department(map, rect, front, dept, saltOf(i)))
      return
    }
    const key = `${rect.x1 - rect.x0 + 1}x${rect.z1 - rect.z0 + 1}${front}`
    let run = runs.get(key)
    let mode = 'copy'
    if (!run || (!repeat && run.shown > run.exact)) {
      // The repeat anomaly: one room set, every size of it, never closing.
      let role = repeat ? ROLES[r(0, 0x2a) % ROLES.length] : ROLES[r(roll++, 0x2a) % ROLES.length]
      if (role === lastRole && !repeat) role = ROLES[(ROLES.indexOf(role) + 1 + (r(roll++, 0x2b) % (ROLES.length - 1))) % ROLES.length]
      run = { role, exact: 2 + (r(roll++, 0x2c) % 2), shown: 0, master: null, front }
      runs.set(key, run)
      mode = 'master'
    } else if (!repeat && run.shown === run.exact) mode = 'mutant'
    run.shown++
    lastRole = run.role
    const pickRoll = mode === 'master' ? -1 : roll++
    const room = shellRoom(map, rect, front, run.role, mode === 'master' ? saltOf(i) : 0)
    if (mode === 'master') {
      openFrontSide(map, UP, rect, front)
      furnishRoom(map, room)
      run.master = { rect, items: roomItems(map, room) }
      clearRoomObjects(map, room)
    }
    const rec = { rect, front, room, role: run.role, run, mode: mode === 'master' ? 'master' : 'copy', closing: mode === 'mutant', pickRoll, mutation: null }
    vignettes.push(rec)
    plain.push(rec)
  })
  // The district's odd copy (geometry.mutationClassAt): among the closing
  // copies, else any copy, else a master whose run has no copy.
  const cls = mutationClassAt(worldSeed, ctx.key)
  let odd = null
  if (cls) {
    const usable = (v) => cls === 'dark' || cls === 'walled' || oddPool(v.run.master.items, v.rect, cls, v.front).length > 0
    const lonely = plain.filter((v) => v.mode === 'master' && !plain.some((o) => o !== v && o.run === v.run))
    for (const pool of [plain.filter((v) => v.closing), plain.filter((v) => v.mode === 'copy'), lonely]) {
      if (!pool.length) continue
      const start = oddCopyOf(ctx.planSeed, ctx.key, pool.length)
      for (let j = 0; j < pool.length && !odd; j++) if (usable(pool[(start + j) % pool.length])) odd = pool[(start + j) % pool.length]
      if (!odd && (cls === 'dark' || cls === 'walled')) odd = pool[start]
      if (odd) break
    }
    if (!odd && plain.length) odd = plain[oddCopyOf(ctx.planSeed, ctx.key, plain.length)]
  }
  // The route's strays: abandoned carts on straight 2-wide lane stretches.
  const strays = routeStrays(R, r)
  capRunKinds(map, UP, plain, strays.map((s) => ({ ...s, kind: PROP_CART })), PROP_KIND_CAP, cls === 'swapped' ? odd : null)
  for (const v of plain) {
    let mutation = null
    if (v === odd) {
      mutation = cls
      if ((mutation === 'missing' || mutation === 'swapped') && !oddPool(v.run.master.items, v.rect, mutation, v.front).length) mutation = 'dark'
      v.mode = 'mutant'
      v.mutation = mutation
      mutations.push(v)
    }
    paste(map, UP, v.run.master.items, v.rect, mutation, mutation ? r(v.pickRoll < 0 ? 0 : v.pickRoll, 0x2e) : 0, v.front)
    const lamp = vLamp(v.rect, v.front)
    map.setLamp(lamp.gx, UP, lamp.gz, !(mutation === 'dark' || mutation === 'walled'), WARM)
    if (mutation !== 'walled') openFrontSide(map, UP, v.rect, v.front)
  }
  for (const s of strays) addPiece(map, UP, { gx: s.gx, gz: s.gz, kind: PROP_CART, front: s.front, wall: null })

  // --- the hall's furniture ----------------------------------------------------------
  const pallets = furnishHall(map, H)
  // The trolley bay's parked carts.
  for (const k of H.carts) addPiece(map, DOWN, { gx: k % W, gz: Math.floor(k / W), kind: PROP_CART, front: (k % 2) ? FACING.N : FACING.E, wall: null })
  // The back-of-house rooms (office grammar, door on the staff corridor).
  H.rooms.forEach((rm, i) => {
    createRoom(map, { cy: DOWN, ...rm.rect, role: BACK_ROLE[rm.role], salt: r(i, 0x2f3) % 997, door: { ...rm.door, passage: PASSAGE_DOOR }, lamp: false, furnish: true })
  })

  // --- world markers -----------------------------------------------------------------
  const ex = hallExitOf(worldSeed, tx, tz)
  if (ex) markExit(map, ctx, ex)
  if (tx === 0 && tz === 0) markSpawn(map, ctx, { gx: plan.stairs[0].door.x, gz: plan.stairs[0].door.z, cy: UP })
  // Lamps under the stair cores' openings would hang in mid-air.
  for (const d of map.chunks.values()) d.lamps = d.lamps.filter((l) => !d.hasCeilHole(l.lx, l.lz))

  // --- notes -------------------------------------------------------------------------
  let routeN = 0
  for (let k = 0; k < W * W; k++) if (R.kind[k] === K_LANE) routeN++
  notes.push(`route: ${plan.nx}×${plan.nz} blocks, ${routeN} lane cells, length ${R.routeLen}; ${vignettes.length} vignettes, ${mutations.length} mutated`)
  for (const v of mutations) notes.push(`mutation at ${v.rect.x0},${v.rect.z0}: ${ROLE_NAME[v.role]} ${v.mutation}`)
  for (const v of vignettes) if (v.mode === 'wardrobes' || v.mode === 'lighting') notes.push(`${v.mode} department at ${v.rect.x0},${v.rect.z0}`)
  for (const s of R.shortcuts) notes.push(`shortcut ${s.type} at ${s.ends.map((k) => `${k % W},${Math.floor(k / W)}`).join('→')} saves ${s.saving}`)
  notes.push(`hall: ${H.depts.map((dd) => dd.type).join(', ')} · ${pallets} flat-pack stacks`)
  notes.push('look: room sets again and again down a serpentine of its own, then the odd one; unlit shortcut gaps; the checkouts lead on to the next district')
  ctx.notes.push(...notes)
  for (const s of plan.spurs) ctx.notes.push(`z-seam passage ${s.side} at x ${s.a0}..${s.a0 + 1}`)
  if (anomaly) ctx.notes.push(`anomaly: ${anomaly}`)
  const out = vignettes.map((v) => ({
    rect: { ...v.rect }, front: v.front, mode: v.mode, role: v.run ? v.role : null,
    run: v.run ? vignettes.findIndex((m) => m.run === v.run && m.mode === 'master') : -1,
    mutation: v.mutation,
  }))
  return { notes, vignettes: out }
}

// createRoom without its furnishing pass or centre lamp, its door on the
// open front; the warm fixture stands at vLamp.
function shellRoom(map, rect, front, role, salt, lamp = true) {
  const e = frontEdges(rect, front)[0]
  const room = createRoom(map, { cy: UP, ...rect, role, salt, lamp: false, furnish: false, door: { axis: e.axis, gx: e.gx, gz: e.gz, passage: PASSAGE_DOOR } })
  if (lamp) {
    const l = vLamp(rect, front)
    map.setLamp(l.gx, UP, l.gz, true, WARM)
  }
  return room
}

// Front-relative cells of a rect: depth 0 is the back row, depth − 1 the
// front row; `along` runs across the front.
function relCells(rect, front) {
  const out = []
  for (let z = rect.z0; z <= rect.z1; z++) {
    for (let x = rect.x0; x <= rect.x1; x++) {
      let depth
      let along
      let n
      let dn
      if (front === 'S') [depth, along, n, dn] = [z - rect.z0, x - rect.x0, rect.x1 - rect.x0 + 1, rect.z1 - rect.z0 + 1]
      else if (front === 'N') [depth, along, n, dn] = [rect.z1 - z, x - rect.x0, rect.x1 - rect.x0 + 1, rect.z1 - rect.z0 + 1]
      else if (front === 'E') [depth, along, n, dn] = [x - rect.x0, z - rect.z0, rect.z1 - rect.z0 + 1, rect.x1 - rect.x0 + 1]
      else [depth, along, n, dn] = [rect.x1 - x, z - rect.z0, rect.z1 - rect.z0 + 1, rect.x1 - rect.x0 + 1]
      out.push({ x, z, depth, along, n, dn })
    }
  }
  return out
}
const BACK = { S: 'N', N: 'S', E: 'W', W: 'E' }
const SIDE_LO = { S: 'W', N: 'W', E: 'N', W: 'N' }
const SIDE_HI = { S: 'E', N: 'E', E: 'S', W: 'S' }

// Greedy light cover: lamps at `cand` cells, each the one that lights most
// still-dark `target` cells (a geodesic reach ≤ 4 steps within 3.8 cells,
// through `open` cells and around walls — the gate's 0.12 level is ~3.9
// cells from one fixture), ≤ LAMP_CAP per chunk-storey, until a lamp would
// light fewer than three.
function coverLamps(open, target, cand, walls, lamps, count) {
  const openM = new Uint8Array(W * W)
  const targetM = new Uint8Array(W * W)
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      const k = z * W + x
      openM[k] = open(k) ? 1 : 0
      targetM[k] = openM[k] && target(k) ? 1 : 0
    }
  }
  const wallV = new Uint8Array(W * W) // line gx (between gx − 1 and gx), row gz
  const wallH = new Uint8Array(W * W) // line gz, column gx
  for (const w of walls) if (w.gx >= 0 && w.gz >= 0 && w.gx < W && w.gz < W) (w.axis === 'v' ? wallV : wallH)[w.gz * W + w.gx] = 1
  const R2 = 3.8 * 3.8
  const depth = new Int8Array(W * W).fill(-1)
  const queue = new Int32Array(W * W)
  // The cells one fixture at k0 lights (k0 included), in BFS order.
  const reach = (k0) => {
    const x0 = k0 % W
    const z0 = (k0 - x0) / W
    let head = 0
    let tail = 0
    queue[tail++] = k0
    depth[k0] = 0
    while (head < tail) {
      const k = queue[head++]
      const d = depth[k]
      if (d === 4) continue
      const x = k % W
      const z = (k - x) / W
      for (let dir = 0; dir < 4; dir++) {
        const nx = dir === 0 ? x + 1 : dir === 1 ? x - 1 : x
        const nz = dir === 2 ? z + 1 : dir === 3 ? z - 1 : z
        if (nx < 0 || nz < 0 || nx >= N || nz >= N) continue
        const n = nz * W + nx
        if (depth[n] >= 0 || !openM[n]) continue
        if (dir === 0 ? wallV[z * W + x + 1] : dir === 1 ? wallV[z * W + x] : dir === 2 ? wallH[(z + 1) * W + x] : wallH[z * W + x]) continue
        if ((nx - x0) ** 2 + (nz - z0) ** 2 > R2) continue
        depth[n] = d + 1
        queue[tail++] = n
      }
    }
    const out = queue.slice(0, tail)
    for (const k of out) depth[k] = -1
    return out
  }
  const lit = new Uint8Array(W * W)
  for (const l of lamps) {
    if (l.gx < 0 || l.gz < 0 || l.gx >= N || l.gz >= N) continue
    const k = l.gz * W + l.gx
    if (openM[k]) for (const n of reach(k)) lit[n] = 1
  }
  // Each candidate keeps only the target cells it lights.
  const cands = []
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      const k = z * W + x
      if (!cand(k)) continue
      const cells = reach(k).filter((n) => targetM[n])
      cands.push({ k, key: chunkKeyOf(x, z), cells })
    }
  }
  const out = []
  for (;;) {
    let best = null
    let gain = 2
    for (const c of cands) {
      if (c.cells.length <= gain || (count.get(c.key) ?? 0) >= LAMP_CAP) continue
      let g = 0
      for (const n of c.cells) if (!lit[n]) g++
      if (g > gain) {
        gain = g
        best = c
      }
    }
    if (!best) return out
    for (const n of best.cells) lit[n] = 1
    const gx = best.k % W
    const gz = (best.k - gx) / W
    count.set(best.key, (count.get(best.key) ?? 0) + 1)
    out.push({ gx, gz })
  }
}

function lightingTables(rect, front) {
  return relCells(rect, front).filter((c) => c.depth < c.dn - 1 && c.along % 2 === 1 && c.depth % 2 === 1).map((c) => ({ gx: c.x, gz: c.z }))
}

// A hand-dressed one-off vignette: wardrobes line the back and side walls
// (the interior and the front row stay free), or the lighting department's
// tables, each under its own lit warm fixture.
function department(map, rect, front, dept, salt) {
  const role = dept === 'wardrobes' ? SPACE_ROLE_BEDROOM : SPACE_ROLE_LIVING
  const room = shellRoom(map, rect, front, role, salt, dept === 'wardrobes')
  for (const c of relCells(rect, front)) {
    if (c.depth >= c.dn - 1) continue
    if (dept === 'wardrobes') {
      const wall = c.depth === 0 ? BACK[front] : c.along === 0 ? SIDE_LO[front] : c.along === c.n - 1 ? SIDE_HI[front] : null
      if (wall && !map.lampAt(c.x, UP, c.z)) addPiece(map, UP, { gx: c.x, gz: c.z, kind: FURN_WARDROBE, front: WALL_TO_FRONT[wall], wall })
    } else if (c.along % 2 === 1 && c.depth % 2 === 1) {
      put(map, UP, c.x, c.z, FURN_TABLE, FACING.S, 0, 0)
      map.setLamp(c.x, UP, c.z, true, WARM)
    }
  }
  openFrontSide(map, UP, rect, front)
  return { rect, front, room, role, mode: dept, mutation: null }
}

// Carts on straight lane stretches: a lane cell whose stretch runs on both
// sides of it and whose twin across the 2-wide lane is lane of the same
// block, clear of doors, ports, spurs, shortcuts and the loop.
function routeStrays(R, r) {
  const { kind, owner, plan } = R
  const avoid = []
  for (const s of plan.stairs) avoid.push([s.door.x, s.door.z])
  // Port cells stay walkable on both sides of the seam (§6.8).
  for (const { a0, a1 } of plan.ports.north) for (let a = a0; a <= a1; a++) avoid.push([a, 0])
  for (const { a0, a1 } of plan.ports.south) for (let a = a0; a <= a1; a++) avoid.push([a, N - 1])
  for (const s of R.shortcuts) for (const k of [...s.ends, ...(s.cells ?? [])]) avoid.push([k % W, Math.floor(k / W)])
  if (R.loop) for (const c of R.loop.parts) for (const k of [...c.ends, ...(c.cells ?? [])]) avoid.push([k % W, Math.floor(k / W)])
  const lane = (x, z, o) => x >= 0 && z >= 0 && x < N && z < N && kind[idx(x, z)] === K_LANE && owner[idx(x, z)] === o
  const near = (x, z) => avoid.some(([a, b]) => Math.abs(a - x) <= 3 && Math.abs(b - z) <= 3)
  const spurNear = (x, z) => {
    for (let b = -2; b <= 2; b++) for (let a = -2; a <= 2; a++) {
      const gx = x + a
      const gz = z + b
      if (gx >= 0 && gz >= 0 && gx < W && gz < W && (kind[idx(gx, gz)] === K_SPUR || kind[idx(gx, gz)] === K_LOOP)) return true
    }
    return false
  }
  const out = []
  const want = 2 + (r(0, 0x3c) % 2)
  for (let i = 0; i < 48 && out.length < want; i++) {
    const k = r(i, 0x3d) % (W * W)
    const x = k % W
    const z = (k - x) / W
    if (kind[k] !== K_LANE || near(x, z) || spurNear(x, z)) continue
    const o = owner[k]
    const alongX = lane(x - 1, z, o) && lane(x + 1, z, o) && ((lane(x - 1, z - 1, o) && lane(x, z - 1, o) && lane(x + 1, z - 1, o)) || (lane(x - 1, z + 1, o) && lane(x, z + 1, o) && lane(x + 1, z + 1, o)))
    const alongZ = lane(x, z - 1, o) && lane(x, z + 1, o) && ((lane(x - 1, z - 1, o) && lane(x - 1, z, o) && lane(x - 1, z + 1, o)) || (lane(x + 1, z - 1, o) && lane(x + 1, z, o) && lane(x + 1, z + 1, o)))
    if (!alongX && !alongZ) continue
    if (out.some((s) => Math.abs(s.gx - x) + Math.abs(s.gz - z) < 5)) continue
    // A stray beside a lane wall only: its twin across stays free.
    const twinFree = alongX ? !out.some((s) => s.gx === x) : !out.some((s) => s.gz === z)
    if (!twinFree) continue
    out.push({ gx: x, gz: z, front: alongX ? (r(i, 0x3e) % 2 ? FACING.E : FACING.W) : r(i, 0x3e) % 2 ? FACING.N : FACING.S })
  }
  return out
}

// The hall's furniture from its layout, within PIECE_CAP records per chunk:
// stacked cells take two records while the chunk has room, one after.
function furnishHall(map, H) {
  const byChunk = new Map()
  for (const [k, f] of H.furn) {
    const x = k % W
    const key = chunkKeyOf(x, (k - x) / W)
    if (!byChunk.has(key)) byChunk.set(key, [])
    byChunk.get(key).push([k, f])
  }
  // Back rooms furnish later: leave them a piece per room cell.
  const roomCellsIn = new Map()
  for (const rm of H.rooms) {
    for (let z = rm.rect.z0; z <= rm.rect.z1; z++) for (let x = rm.rect.x0; x <= rm.rect.x1; x++) roomCellsIn.set(chunkKeyOf(x, z), (roomCellsIn.get(chunkKeyOf(x, z)) ?? 0) + 1)
  }
  let stacks = 0
  for (const [ck, list] of byChunk) {
    list.key = ck
    list.sort((a, b) => a[0] - b[0])
    const per = (f) => (f.type === 'table' ? 3 : 2)
    let budget = PIECE_CAP - (roomCellsIn.get(list.key) ?? 0)
    const cells = list.filter(() => {
      if (budget <= 0) return false
      budget -= 1
      return true
    })
    let spare = budget
    for (const [k, f] of cells) {
      const x = k % W
      const z = (k - x) / W
      const two = spare >= per(f) - 1
      if (two) spare -= per(f) - 1
      const along = f.axis === 'x' // runs along x: pieces face N and S
      if (f.type === 'gondola') {
        if (two) {
          if (along) {
            put(map, DOWN, x, z, FURN_BOOKSHELF, FACING.N, 0, -0.2)
            put(map, DOWN, x, z, FURN_BOOKSHELF, FACING.S, 0, 0.2)
          } else {
            put(map, DOWN, x, z, FURN_BOOKSHELF, FACING.W, -0.2, 0)
            put(map, DOWN, x, z, FURN_BOOKSHELF, FACING.E, 0.2, 0)
          }
        } else put(map, DOWN, x, z, FURN_BOOKSHELF, along ? FACING.S : FACING.E, 0, 0)
      } else if (f.type === 'rack') {
        if (two) {
          if (along) {
            put(map, DOWN, x, z, FURN_RACK, FACING.N, 0, -0.38)
            put(map, DOWN, x, z, FURN_RACK, FACING.S, 0, 0.38)
          } else {
            put(map, DOWN, x, z, FURN_RACK, FACING.W, -0.38, 0)
            put(map, DOWN, x, z, FURN_RACK, FACING.E, 0.38, 0)
          }
        } else put(map, DOWN, x, z, FURN_RACK, along ? FACING.S : FACING.E, 0, 0)
      } else if (f.type === 'stack') {
        stacks++
        for (const dz of two ? [-0.65, 0.65] : [0]) put(map, DOWN, x, z, PROP_FLATPACK, FACING.E, 0, dz)
      } else if (f.type === 'till') {
        for (const dx of two ? [-0.68, 0.68] : [0]) put(map, DOWN, x, z, FURN_COUNTER, FACING.N, dx, 0)
      } else if (f.type === 'table') {
        put(map, DOWN, x, z, FURN_TABLE, FACING.S, 0, 0)
        if (two) {
          put(map, DOWN, x, z, FURN_CHAIR, FACING.S, 0, -0.95)
          put(map, DOWN, x, z, FURN_CHAIR, FACING.N, 0, 0.95)
        }
      }
    }
  }
  // The bag bin layout chose against the east wall of the till strip.
  if (H.bin !== null) addPiece(map, DOWN, { gx: H.bin % W, gz: Math.floor(H.bin / W), kind: PROP_BAG_BIN, front: WALL_TO_FRONT.E, wall: 'E' })
  return stacks
}
