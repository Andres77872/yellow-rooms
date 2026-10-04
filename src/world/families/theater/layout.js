import { CHUNK } from '../../constants.js'
import {
  CELL_CORRIDOR,
  CELL_LOBBY,
  CELL_ROOM,
  CELL_STAIR,
  FACING,
  PASSAGE_DOOR,
  PASSAGE_OPEN,
  PASSAGE_WALL,
  PASSAGE_WIDE,
  SPACE_ROLE_BATHROOM,
  SPACE_ROLE_LOUNGE,
  SPACE_ROLE_NONE,
  SPACE_ROLE_OFFICE,
  SPACE_ROLE_STORAGE,
  WALL_PLAIN,
} from '../../tiles/floorPlan.js'
import {
  FURN_ARMCHAIR,
  FURN_BOOKSHELF,
  FURN_CABINET,
  FURN_CHAIR,
  FURN_COUNTER,
  FURN_DESK,
  FURN_PLANT,
  FURN_RACK,
  FURN_SINK,
  FURN_SOFA,
  FURN_TOILET,
  FURN_WARDROBE,
} from '../../rooms/catalog.js'
import { PROP_GHOST_LIGHT, PROP_PROMPT_DESK, PROP_ROAD_CASE, PROP_SEAT_ROW } from '../../props/index.js'
import { hashChain } from '../../tiles/tileKey.js'
import {
  BAND_TOP,
  BASE,
  EDGE,
  FIRST,
  FLOORS,
  GROUND,
  HALL_TYPES,
  N,
  R,
  ROOM_TYPES,
  dice,
  frameOf,
  inRect,
  keptLocal,
} from './geometry.js'

// The theater's per-storey infill (doc 11 §4): the scheme (geometry.js) fixed
// the house volume, the band's strips, corridor lanes and stair slots; this
// module rolls, storey by storey, what fills them — the house levels (trap
// room, stalls and stage, circles and boxes, fly galleries), the rooms of
// every band (sizes, types, halls, dressing-room runs, doors, loops, dead
// ends), the seats, props, furniture and lamps — as a RASTER over the 42×42
// tile: a region per cell (0 = mass), a class per cell (void, deck, pier,
// stair core, pillar) and explicit edges (doors, the proscenium's wide
// opening). Every storey is then made one connected graph (doors added,
// passages carved, unreachable scraps sealed) and its furniture unblocked,
// before tile.js writes it, stamps the volume and the stairs, and reapplies
// it over what the stamps carved.

export const CLS_NONE = 0
export const CLS_VOID = 1
export const CLS_BRIDGE = 2
export const CLS_PIER = 3 // the volume's level-0 stage piers (the stamp raises them)
export const CLS_CORE = 4 // the volume's stair core (the stamp encloses it)
export const CLS_STAIR = 5 // a band stairwell core (the stamp encloses it)
export const CLS_PILLAR = 6 // a hall column (written here)

export const BULB = 0xffe2b4 // the ghost light: a bare tungsten bulb
export const WORK = 0xa8bcff // backstage work lights, blue: the family record's lampTint
export const MIRROR = 0xffd8a4 // dressing-room mirror bulbs
export const HOUSE_LAMP = 0xffd2a0 // front-of-house fittings (warm)

const IDX = (gx, gz) => gz * N + gx
const inTile = (gx, gz) => gx >= 0 && gz >= 0 && gx < N && gz < N
const EK = (axis, gx, gz) => ((axis === 'v' ? 1 : 0) * 64 + gx) * 64 + gz
const edgeOf = (ax, az, bx, bz) => (bx !== ax ? { axis: 'v', gx: Math.max(ax, bx), gz: az } : { axis: 'h', gx: ax, gz: Math.max(az, bz) })
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const OPEN = Object.freeze({ wall: 0, passage: PASSAGE_OPEN, feature: WALL_PLAIN })
const WALL = Object.freeze({ wall: 1, passage: PASSAGE_WALL, feature: WALL_PLAIN })
const DOOR = Object.freeze({ wall: 0, passage: PASSAGE_DOOR, feature: WALL_PLAIN })
const WIDE = Object.freeze({ wall: 0, passage: PASSAGE_WIDE, feature: WALL_PLAIN })

// FACING of a tile step; the wall a piece backs onto, from its facing.
const facingOf = (dx, dz) => (dx > 0 ? FACING.E : dx < 0 ? FACING.W : dz > 0 ? FACING.S : FACING.N)
const sideOf = (dx, dz) => (dx > 0 ? 'E' : dx < 0 ? 'W' : dz > 0 ? 'S' : 'N')

// --- the storey raster -------------------------------------------------------------

export class Storey {
  constructor(s, scheme) {
    this.s = s
    this.scheme = scheme
    this.reg = new Int32Array(N * N)
    this.cls = new Uint8Array(N * N)
    this.noCarve = new Uint8Array(N * N)
    this.reserved = new Uint8Array(N * N)
    this.furn = new Map() // IDX → piece {gx, gz, kind, wall|facing}
    this.regions = [null]
    this.edges = new Map()
    this.lamps = []
    this.root = null
  }

  kept(gx, gz) {
    return inTile(gx, gz) && keptLocal(this.scheme, Math.floor(gx / CHUNK), this.s, Math.floor(gz / CHUNK))
  }

  add(props) {
    const id = this.regions.length
    this.regions.push({ id, kind: CELL_ROOM, role: SPACE_ROLE_NONE, space: 0, name: 'room', zone: 'boh', cells: 0, ...props })
    return id
  }

  regAt(gx, gz) {
    return inTile(gx, gz) ? this.reg[IDX(gx, gz)] : 0
  }

  clsAt(gx, gz) {
    return inTile(gx, gz) ? this.cls[IDX(gx, gz)] : CLS_NONE
  }

  set(gx, gz, id, cls = CLS_NONE) {
    if (!this.kept(gx, gz)) return
    const i = IDX(gx, gz)
    this.reg[i] = id
    this.cls[i] = cls
  }

  fill(r, id, cls = CLS_NONE) {
    for (let gz = r.z0; gz <= r.z1; gz++) for (let gx = r.x0; gx <= r.x1; gx++) this.set(gx, gz, id, cls)
  }

  // Walkable floor (decks and cores included; voids, piers and pillars not).
  walk(gx, gz) {
    if (!inTile(gx, gz)) return false
    const i = IDX(gx, gz)
    const c = this.cls[i]
    return this.reg[i] > 0 && c !== CLS_VOID && c !== CLS_PIER && c !== CLS_PILLAR
  }

  // Free floor: walkable, no furniture.
  free(gx, gz) {
    return this.walk(gx, gz) && !this.furn.has(IDX(gx, gz))
  }

  edge(ax, az, bx, bz, state) {
    const e = edgeOf(ax, az, bx, bz)
    this.edges.set(EK(e.axis, e.gx, e.gz), state)
  }

  door(ax, az, bx, bz, state = DOOR) {
    this.edge(ax, az, bx, bz, state)
    if (inTile(ax, az)) this.reserved[IDX(ax, az)] = 1
    if (inTile(bx, bz)) this.reserved[IDX(bx, bz)] = 1
  }

  // The state of the line between cells a and b (adjacent; either may lie
  // outside the tile, which counts as mass).
  edgeState(ax, az, bx, bz) {
    const ra = this.regAt(ax, az)
    const rb = this.regAt(bx, bz)
    if (ra > 0 && rb > 0) {
      const e = edgeOf(ax, az, bx, bz)
      const ex = this.edges.get(EK(e.axis, e.gx, e.gz))
      if (ex) return ex
      return ra === rb ? OPEN : WALL
    }
    return ra > 0 || rb > 0 ? WALL : OPEN
  }

  passable(ax, az, bx, bz) {
    return this.walk(ax, az) && this.walk(bx, bz) && this.edgeState(ax, az, bx, bz).wall === 0
  }

  reserve(gx, gz) {
    if (inTile(gx, gz)) this.reserved[IDX(gx, gz)] = 1
  }

  lamp(gx, gz, lit, tint = null) {
    if (this.walk(gx, gz) || this.clsAt(gx, gz) === CLS_VOID) this.lamps.push({ gx, gz, lit, tint })
  }

  piece(gx, gz, kind, { wall = null, facing = FACING.S } = {}) {
    this.furn.set(IDX(gx, gz), { gx, gz, kind, wall, facing })
  }
}

// --- connectivity --------------------------------------------------------------------

// Cells reachable from `from` over passable edges (`free`: furniture blocks).
function flood(st, seeds, { free = false, seen = new Uint8Array(N * N) } = {}) {
  const q = []
  for (const [gx, gz] of seeds) {
    const i = IDX(gx, gz)
    if (seen[i] || !(free ? st.free(gx, gz) : st.walk(gx, gz))) continue
    seen[i] = 1
    q.push(gx, gz)
  }
  for (let h = 0; h < q.length; h += 2) {
    const gx = q[h]
    const gz = q[h + 1]
    for (const [dx, dz] of DIRS) {
      const nx = gx + dx
      const nz = gz + dz
      if (!inTile(nx, nz)) continue
      const j = IDX(nx, nz)
      if (seen[j] || !(free ? st.free(nx, nz) : st.walk(nx, nz))) continue
      if (st.edgeState(gx, gz, nx, nz).wall) continue
      seen[j] = 1
      q.push(nx, nz)
    }
  }
  return seen
}

// A door may be cut between two walkable cells of different regions unless
// either is a void, a deck, a core, a stairwell or a pillar, or the line
// already carries an explicit edge.
function doorable(st, ax, az, bx, bz) {
  if (!st.walk(ax, az) || !st.walk(bx, bz)) return false
  const ca = st.clsAt(ax, az)
  const cb = st.clsAt(bx, bz)
  if (ca !== CLS_NONE || cb !== CLS_NONE) return false
  const e = edgeOf(ax, az, bx, bz)
  return !st.edges.has(EK(e.axis, e.gx, e.gz))
}

// Make storey `st` one connected graph from its root: an unreached
// component gets a door onto the reached set, else a passage carved through
// mass, else it is sealed (mass). Deterministic (row-major scans).
function connect(st) {
  const root = st.root
  if (!st.walk(root.gx, root.gz)) {
    st.set(root.gx, root.gz, st.add({ kind: CELL_CORRIDOR, name: 'landing' }))
  }
  let seen = flood(st, [[root.gx, root.gz]])
  // Structural cells (the volume's decks and core, a band stairwell) are
  // never sealed: the stamps own them. A component that keeps any is left
  // as it is and counted (st.stranded; the family test requires 0).
  const kept = new Uint8Array(N * N)
  for (let guard = 0; guard < 200; guard++) {
    let start = -1
    for (let i = 0; i < N * N; i++) {
      if (!seen[i] && !kept[i] && st.walk(i % N, Math.floor(i / N))) {
        start = i
        break
      }
    }
    if (start < 0) return
    const comp = flood(st, [[start % N, Math.floor(start / N)]])
    // 1. a door onto the reached set.
    let done = false
    for (let i = 0; i < N * N && !done; i++) {
      if (!comp[i]) continue
      const gx = i % N
      const gz = Math.floor(i / N)
      for (const [dx, dz] of DIRS) {
        const nx = gx + dx
        const nz = gz + dz
        if (!inTile(nx, nz) || !seen[IDX(nx, nz)]) continue
        if (!doorable(st, gx, gz, nx, nz)) continue
        st.door(gx, gz, nx, nz)
        done = true
        break
      }
    }
    // 2. a passage through mass to the reached set.
    if (!done) done = carve(st, comp, seen)
    // 3. seal what cannot be reached (its plain floor; structural cells stay).
    if (!done) {
      let structural = 0
      for (let i = 0; i < N * N; i++) if (comp[i] && st.cls[i] !== CLS_NONE) structural++
      for (let i = 0; i < N * N; i++) {
        if (!comp[i]) continue
        if (structural) {
          kept[i] = 1
          continue
        }
        st.reg[i] = 0
        st.cls[i] = CLS_NONE
        st.furn.delete(i)
      }
      if (structural) st.stranded = (st.stranded ?? 0) + structural
    }
    seen = flood(st, [[root.gx, root.gz]])
  }
}

// Breadth-first from component `comp` through carvable mass to a cell of
// `seen`; the path becomes a service passage with doors at both ends.
function carve(st, comp, seen) {
  const prev = new Int32Array(N * N).fill(-1)
  const vis = new Uint8Array(N * N)
  const q = []
  for (let i = 0; i < N * N; i++) {
    if (comp[i]) {
      vis[i] = 1
      q.push(i)
    }
  }
  let goal = -1
  for (let h = 0; h < q.length && goal < 0; h++) {
    const i = q[h]
    const gx = i % N
    const gz = Math.floor(i / N)
    for (const [dx, dz] of DIRS) {
      const nx = gx + dx
      const nz = gz + dz
      if (!inTile(nx, nz)) continue
      const j = IDX(nx, nz)
      if (vis[j]) continue
      if (seen[j]) {
        // Only through a line that may carry a door (or into an open cell).
        if (!st.walk(nx, nz) || st.clsAt(nx, nz) !== CLS_NONE) continue
        if (!comp[i] && st.reg[i] !== 0) continue
        vis[j] = 1
        prev[j] = i
        goal = j
        break
      }
      const mass = st.reg[j] === 0 && st.cls[j] === CLS_NONE && !st.noCarve[j] && st.kept(nx, nz) && nx <= EDGE && nz <= EDGE
      if (!mass) continue
      vis[j] = 1
      prev[j] = i
      q.push(j)
    }
  }
  if (goal < 0) return false
  const id = st.add({ kind: CELL_CORRIDOR, name: 'service passage' })
  const path = []
  for (let j = goal; j >= 0; j = prev[j]) path.push(j)
  path.reverse() // comp cell … goal
  for (let p = 1; p < path.length - 1; p++) st.set(path[p] % N, Math.floor(path[p] / N), id)
  for (let p = 0; p + 1 < path.length; p++) {
    const a = path[p]
    const b = path[p + 1]
    if (st.reg[a] === st.reg[b]) continue
    st.door(a % N, Math.floor(a / N), b % N, Math.floor(b / N))
  }
  return true
}

// Remove furniture until every free cell is reachable from the root over free
// cells. One 0-1 breadth-first search from the reached set over walkable
// cells (a furniture cell costs one) gives every stranded cell its cheapest
// way back; each stranded pocket, in scan order, loses the pieces on its
// way, and the pocket joins the reached set.
function unblock(st) {
  const seen = flood(st, [[st.root.gx, st.root.gz]], { free: true })
  const dist = new Int32Array(N * N).fill(1 << 30)
  const prev = new Int32Array(N * N).fill(-1)
  const dq = new Int32Array(4 * N * N)
  let head = 2 * N * N
  let tail = head
  for (let i = 0; i < N * N; i++) {
    if (!seen[i]) continue
    dist[i] = 0
    dq[tail++] = i
  }
  while (head < tail) {
    const i = dq[head++]
    const gx = i % N
    const gz = (i - gx) / N
    for (const [dx, dz] of DIRS) {
      const nx = gx + dx
      const nz = gz + dz
      if (!st.passable(gx, gz, nx, nz)) continue
      const j = IDX(nx, nz)
      const w = st.furn.has(j) ? 1 : 0
      if (dist[i] + w >= dist[j]) continue
      dist[j] = dist[i] + w
      prev[j] = i
      if (w) dq[tail++] = j
      else dq[--head] = j
    }
  }
  for (let i = 0; i < N * N; i++) {
    if (seen[i] || !st.free(i % N, Math.floor(i / N))) continue
    if (dist[i] >= 1 << 30) {
      // Unreachable even through furniture (cannot happen after connect):
      // clear the pocket's own pieces so nothing is boxed in.
      const comp = flood(st, [[i % N, Math.floor(i / N)]])
      for (let j = 0; j < N * N; j++) if (comp[j]) st.furn.delete(j)
      continue
    }
    for (let j = i; j >= 0 && !seen[j]; j = prev[j]) st.furn.delete(j)
    flood(st, [[i % N, Math.floor(i / N)]], { free: true, seen })
  }
}

// --- the house volume --------------------------------------------------------------

// Doors between region `a` cells and region `b` cells along a candidate
// list: pick `n` of them (dice), spread out.
function pickDoors(st, D, pairs, n) {
  const ok = pairs.filter(([ax, az, bx, bz]) => doorable(st, ax, az, bx, bz))
  const out = []
  for (let k = 0; k < n && ok.length; k++) {
    const i = D.int(0, ok.length - 1)
    const p = ok[i]
    st.door(...p)
    out.push(p)
    // Spread: drop the candidates within 2 cells.
    for (let j = ok.length - 1; j >= 0; j--) if (Math.abs(ok[j][0] - p[0]) + Math.abs(ok[j][1] - p[1]) <= 2) ok.splice(j, 1)
  }
  return out
}

// Pairs (inside cell of region `inner`, outside ring cell) along a canonical
// side of the volume: side 'back' (u = −1), 'stage' (u = L), 'left' (v = −1),
// 'right' (v = W), restricted to canonical u in [u0, u1] / v in [v0, v1].
function ringPairs(st, F, sc, side, inner, { u0 = 0, u1 = sc.L - 1, v0 = 0, v1 = sc.W - 1 } = {}) {
  const out = []
  if (side === 'back' || side === 'stage') {
    const u = side === 'back' ? 0 : sc.L - 1
    const ru = side === 'back' ? -1 : sc.L
    for (let v = v0; v <= v1; v++) {
      const a = F.toTile(u, v)
      const b = F.toTile(ru, v)
      if (st.regAt(a.gx, a.gz) === inner) out.push([a.gx, a.gz, b.gx, b.gz])
    }
  } else {
    const v = side === 'left' ? 0 : sc.W - 1
    const rv = side === 'left' ? -1 : sc.W
    for (let u = u0; u <= u1; u++) {
      const a = F.toTile(u, v)
      const b = F.toTile(u, rv)
      if (st.regAt(a.gx, a.gz) === inner) out.push([a.gx, a.gz, b.gx, b.gz])
    }
  }
  return out
}

function volumeLevel(st, sc, F, k, D, ids) {
  const b = sc.bounds
  const box = R(b.x0 - 1, b.z0 - 1, b.x1 + 1, b.z1 + 1)
  const level = sc.levels[k]
  // The ring: the theatre's own corridor on every storey; a ring cell on a
  // chunk's last line facing a chunk this storey does not keep is mass (the
  // perimeter rule), and so is never carved.
  const ring = st.add({ kind: CELL_LOBBY, name: 'ring corridor', zone: 'ring' })
  ids.ring = ring
  for (let gz = box.z0; gz <= box.z1; gz++) {
    for (let gx = box.x0; gx <= box.x1; gx++) {
      if (inRect(b, gx, gz)) continue
      const lx = gx % CHUNK
      const lz = gz % CHUNK
      const facing = (lx === CHUNK - 1 && !st.kept(gx + 1, gz)) || (lz === CHUNK - 1 && !st.kept(gx, gz + 1))
      if (facing) {
        st.noCarve[IDX(gx, gz)] = 1
        continue
      }
      st.set(gx, gz, ring)
    }
  }
  const house = F.rect(0, 0, sc.P - 1, sc.W - 1)
  const stage = F.rect(sc.P, 0, sc.L - 1, sc.W - 1)
  const inVoid = (gx, gz) => level.voids.some((r) => inRect(r, gx, gz))
  const inBridge = (gx, gz) => level.bridges.some((r) => inRect(r, gx, gz))
  const mark = (r, id) => {
    for (let gz = r.z0; gz <= r.z1; gz++) {
      for (let gx = r.x0; gx <= r.x1; gx++) {
        if (inBridge(gx, gz)) st.set(gx, gz, id, CLS_BRIDGE)
        else if (inVoid(gx, gz)) st.set(gx, gz, id, CLS_VOID)
        else st.set(gx, gz, id)
      }
    }
  }
  if (k === 0) {
    // Basement: the trap room under the stage (and the pit floor), the
    // understalls (stores or one long store) behind it.
    const tu0 = sc.pit ? sc.P - 3 : sc.P - 1
    const trap = st.add({ kind: CELL_ROOM, role: SPACE_ROLE_STORAGE, space: 900, name: 'trap room', zone: 'boh' })
    ids.trap = trap
    mark(F.rect(tu0, 0, sc.L - 1, sc.W - 1), trap)
    for (const c of sc.columns) st.set(c.gx, c.gz, trap, CLS_PIER)
    const nRooms = sc.understalls === 'rooms' ? D.int(2, 3) : 1
    const cuts = [0]
    for (let i = 1; i < nRooms; i++) cuts.push(Math.round((i * sc.W) / nRooms) + D.int(-1, 1))
    cuts.push(sc.W)
    const unders = []
    for (let i = 0; i < nRooms; i++) {
      const id = st.add({ kind: CELL_ROOM, role: SPACE_ROLE_STORAGE, space: 910 + i, name: nRooms > 1 ? 'understalls store' : 'understalls', zone: 'foh' })
      unders.push(id)
      mark(F.rect(0, cuts[i], tu0 - 1, cuts[i + 1] - 1), id)
    }
    pickDoors(st, D, ringPairs(st, F, sc, 'stage', trap), D.int(1, 2))
    pickDoors(st, D, [...ringPairs(st, F, sc, 'left', trap, { u0: tu0 }), ...ringPairs(st, F, sc, 'right', trap, { u0: tu0 })], 1)
    for (const id of unders) pickDoors(st, D, ringPairs(st, F, sc, 'back', id), 1)
    // A loop under the stage: a store opens onto the trap room.
    const loop = []
    for (let v = 0; v < sc.W; v++) {
      const a = F.toTile(tu0 - 1, v)
      const c = F.toTile(tu0, v)
      loop.push([a.gx, a.gz, c.gx, c.gz])
    }
    pickDoors(st, D, loop, 1)
    for (let i = 0; i + 1 < unders.length; i++) {
      const pairs = []
      for (let u = 0; u < tu0; u++) {
        const a = F.toTile(u, cuts[i + 1] - 1)
        const c = F.toTile(u, cuts[i + 1])
        pairs.push([a.gx, a.gz, c.gx, c.gz])
      }
      if (D.chance(0.5)) pickDoors(st, D, pairs, 1)
    }
  } else if (k === GROUND) {
    const stalls = st.add({ kind: CELL_LOBBY, name: 'stalls', zone: 'house' })
    const stageId = st.add({ kind: CELL_LOBBY, name: 'stage', zone: 'stage' })
    ids.stalls = stalls
    ids.stage = stageId
    mark(house, stalls)
    mark(stage, stageId)
    // The prop room in an upstage corner (clear of the fly, the core, the door).
    if (sc.propRoom) {
      const v0 = sc.propRoom > 0 ? sc.W - 3 : 0
      const r = F.rect(sc.L - 3, v0, sc.L - 1, v0 + 2)
      const fly = F.rect(sc.fly.u0, sc.fly.v0, sc.fly.u1, sc.fly.v1)
      const clash = (gx, gz) => inRect(fly, gx, gz) || inRect(sc.coreRect, gx, gz) || (gx === sc.coreDoor.outside.gx && gz === sc.coreDoor.outside.gz)
      let ok = true
      for (let gz = r.z0; gz <= r.z1 && ok; gz++) for (let gx = r.x0; gx <= r.x1; gx++) if (clash(gx, gz)) ok = false
      if (ok) {
        const prop = st.add({ kind: CELL_ROOM, role: SPACE_ROLE_STORAGE, space: 920, name: 'prop room', zone: 'stage' })
        ids.prop = prop
        st.fill(r, prop)
        const pairs = []
        for (let v = v0; v <= v0 + 2; v++) {
          const a = F.toTile(sc.L - 4, v)
          const c = F.toTile(sc.L - 3, v)
          pairs.push([c.gx, c.gz, a.gx, a.gz])
        }
        const side = sc.propRoom > 0 ? v0 - 1 : v0 + 3
        for (let u = sc.L - 3; u <= sc.L - 1; u++) {
          const a = F.toTile(u, side)
          const c = F.toTile(u, sc.propRoom > 0 ? v0 : v0 + 2)
          pairs.push([c.gx, c.gz, a.gx, a.gz])
        }
        pickDoors(st, D, pairs, 1)
      }
    }
    // The proscenium: a wall with the opening WIDE, and a pass door or two.
    const pass = []
    for (let v = 0; v < sc.W; v++) {
      const a = F.toTile(sc.P - 1, v)
      const c = F.toTile(sc.P, v)
      if (v >= sc.o0 && v <= sc.o1) st.edge(a.gx, a.gz, c.gx, c.gz, WIDE)
      else if (v < sc.o0 - 1 || v > sc.o1 + 1) pass.push([a.gx, a.gz, c.gx, c.gz])
    }
    pickDoors(st, D, pass, D.int(1, 2))
    // The house doors from the ring: at the back (gangways), the sides (cross
    // aisles); the stage doors in both wings and upstage.
    const backV = [...sc.gangways, 0, sc.W - 1]
    pickDoors(st, D, ringPairs(st, F, sc, 'back', stalls).filter(([ax, az]) => backV.includes(F.toCanon(ax, az).v)), D.int(1, 3))
    const crossU = [0, sc.front, ...(sc.mid >= 0 ? [sc.mid] : [])]
    for (const side of ['left', 'right']) {
      pickDoors(st, D, ringPairs(st, F, sc, side, stalls).filter(([ax, az]) => crossU.includes(F.toCanon(ax, az).u)), D.int(1, 2))
      pickDoors(st, D, ringPairs(st, F, sc, side, stageId, { u0: sc.P + 1 }), 1)
    }
    if (D.chance(0.5)) pickDoors(st, D, ringPairs(st, F, sc, 'stage', stageId), 1)
  } else {
    // Upper levels: the circles over the house (where this theatre has one
    // on this level), the fly galleries round the fly tower, the ring.
    const circle = (k === 2 && sc.circles >= 1) || (k === 3 && sc.circles >= 2)
    if (circle) {
      const gallery = st.add({ kind: CELL_LOBBY, name: k === 2 ? 'dress circle' : 'upper circle', zone: 'house' })
      ids[k === 2 ? 'dress' : 'upper'] = gallery
      mark(F.rect(0, 0, sc.P - 1, sc.W - 1), gallery)
      // Boxes along the dress circle's sides: 2-cell bays between the box
      // corridor (the outer row) and the void, one door each.
      if (k === 2 && sc.boxes) {
        const hv = sc.dress
        ids.boxes = []
        for (const sgn of [1, -1]) {
          const vIn = sgn > 0 ? [1, sc.sideW - 1] : [sc.W - sc.sideW, sc.W - 2]
          const vCorr = sgn > 0 ? 0 : sc.W - 1
          for (let u = hv.u0; u + 1 <= hv.u1; u += 2) {
            const u1 = u + 2 <= hv.u1 && u + 3 > hv.u1 ? hv.u1 : u + 1
            const id = st.add({ kind: CELL_ROOM, role: SPACE_ROLE_LOUNGE, space: 930 + ids.boxes.length, name: 'box', zone: 'house' })
            let cells = 0
            for (let uu = u; uu <= u1; uu++) {
              for (let v = vIn[0]; v <= vIn[1]; v++) {
                const c = F.toTile(uu, v)
                if (st.clsAt(c.gx, c.gz) !== CLS_NONE || st.regAt(c.gx, c.gz) !== gallery) continue
                st.set(c.gx, c.gz, id)
                cells++
              }
            }
            if (!cells) continue
            ids.boxes.push({ id, u0: u, u1, sgn })
            const a = F.toTile(u, vCorr)
            const c = F.toTile(u, sgn > 0 ? 1 : sc.W - 2)
            if (doorable(st, a.gx, a.gz, c.gx, c.gz)) st.door(a.gx, a.gz, c.gx, c.gz)
            if (u1 > u + 1) u = u1 - 1
          }
        }
      }
      pickDoors(st, D, ringPairs(st, F, sc, 'back', gallery), D.int(1, 2))
      for (const side of ['left', 'right']) pickDoors(st, D, ringPairs(st, F, sc, side, gallery, { u1: sc.P - 2 }), 1)
    }
    // No circle on this level: the back of the house is the lighting box
    // (control room, follow-spot box) whenever the core opens into it, else
    // on a roll; the rest of the house stays mass over the stalls.
    if (!circle) {
      const o = F.toCanon(sc.coreDoor.outside.gx, sc.coreDoor.outside.gz)
      const coreIn = inRect(b, sc.coreDoor.outside.gx, sc.coreDoor.outside.gz) && o.u < sc.P
      if (coreIn || D.chance(0.35)) {
        const depth = Math.min(sc.P - 2, coreIn ? Math.max(3, o.u + 1) : D.int(2, 3))
        const inset = coreIn ? 0 : D.int(0, 2)
        const lbox = st.add({ kind: CELL_ROOM, role: SPACE_ROLE_OFFICE, space: 950 + k, name: 'lighting box', zone: 'house' })
        ids.lightingBox = lbox
        mark(F.rect(0, inset, depth - 1, sc.W - 1 - inset), lbox)
        pickDoors(st, D, ringPairs(st, F, sc, 'back', lbox), D.int(1, 2))
        for (const side of ['left', 'right']) if (D.chance(0.5)) pickDoors(st, D, ringPairs(st, F, sc, side, lbox, { u1: depth - 1 }), 1)
      }
    }
    const flyG = st.add({ kind: CELL_LOBBY, name: k === sc.NL - 1 ? 'grid' : k === 2 ? 'fly floor' : 'fly gallery', zone: 'stage' })
    ids.fly = flyG
    mark(stage, flyG)
    for (const side of ['left', 'right']) pickDoors(st, D, ringPairs(st, F, sc, side, flyG, { u0: sc.P }), 1)
    if (D.chance(0.5)) pickDoors(st, D, ringPairs(st, F, sc, 'stage', flyG), 1)
  }
  // The stair core (the stamp encloses it; its door is the root).
  st.fill(sc.coreRect, st.add({ kind: CELL_STAIR, name: 'stage core', zone: 'core' }), CLS_CORE)
  // Doors rolled above onto cells the core now covers are gone: the core
  // opens only at its own door.
  clearRim(st, sc.coreRect)
  const d = sc.coreDoor
  st.door(d.inside.gx, d.inside.gz, d.outside.gx, d.outside.gz)
  st.root = { gx: d.outside.gx, gz: d.outside.gz }
}

// Drop every explicit edge on rect r's rim and inside it.
function clearRim(st, r) {
  for (let gz = r.z0; gz <= r.z1 + 1; gz++) {
    for (let gx = r.x0; gx <= r.x1 + 1; gx++) {
      if (gz <= r.z1) st.edges.delete(EK('v', gx, gz))
      if (gx <= r.x1) st.edges.delete(EK('h', gx, gz))
    }
  }
}

// --- the band ------------------------------------------------------------------------

const ROLE_OF = Object.freeze({
  'box office': SPACE_ROLE_OFFICE,
  manager: SPACE_ROLE_OFFICE,
  office: SPACE_ROLE_OFFICE,
  toilets: SPACE_ROLE_BATHROOM,
  bar: SPACE_ROLE_LOUNGE,
  'circle bar': SPACE_ROLE_LOUNGE,
  'green room': SPACE_ROLE_LOUNGE,
  salon: SPACE_ROLE_LOUNGE,
  dressing: SPACE_ROLE_LOUNGE,
  lobby: SPACE_ROLE_LOUNGE,
  foyer: SPACE_ROLE_LOUNGE,
})
const roleOf = (name) => ROLE_OF[name] ?? SPACE_ROLE_STORAGE

// Strip-local frame: along `a` (the strip's long axis) and across `t`.
function stripFrame(st) {
  const r = st.rect
  return st.axis === 'x'
    ? { cell: (a, t) => ({ gx: r.x0 + a, gz: r.z0 + t }) }
    : { cell: (a, t) => ({ gx: r.x0 + t, gz: r.z0 + a }) }
}

function bandStorey(st, sc, F, s, D, info) {
  const sk = sc.skeleton
  const zoneAt = (gx, gz) => (F.toCanon(gx, gz).u < sc.P ? 'foh' : 'boh')
  let space = 1000 + s * 200
  const rooms = []
  const strips = []
  for (const [si, strip] of sk.strips.entries()) {
    const fr = stripFrame(strip)
    const { c0, cw, a0, a1 } = strip.lane
    const stairs = sk.stairs.filter((t) => t.strip === si)
    // Halls: one segment of the strip spanning its full thickness (a lobby,
    // a foyer, a scene dock, a cistern…), clear of the stair slots.
    const halls = []
    if (strip.len >= 12 && strip.t >= 3 && D.chance(s === GROUND ? 0.55 : 0.35)) {
      const hl = D.int(5, Math.min(10, strip.len - 6))
      const h0 = D.int(1, strip.len - hl - 1)
      const h1 = h0 + hl - 1
      if (!stairs.some((t) => t.a <= h1 + 1 && t.a + 5 >= h0 - 1)) halls.push([h0, h1])
    }
    const inHall = (a) => halls.some(([h0, h1]) => a >= h0 && a <= h1)
    const corr = st.add({ kind: CELL_CORRIDOR, name: 'corridor', zone: zoneAt(fr.cell(Math.floor((a0 + a1) / 2), c0).gx, fr.cell(Math.floor((a0 + a1) / 2), c0).gz) })
    for (let a = a0; a <= a1; a++) {
      if (inHall(a)) continue
      for (let t = c0; t < c0 + cw; t++) {
        const c = fr.cell(a, t)
        st.set(c.gx, c.gz, corr)
      }
    }
    const hallIds = []
    for (const [h0, h1] of halls) {
      const mid = fr.cell(Math.floor((h0 + h1) / 2), Math.floor(strip.t / 2))
      const zone = zoneAt(mid.gx, mid.gz)
      const name = HALL_TYPES[zone][s]
      const id = st.add({ kind: s === GROUND && zone === 'foh' ? CELL_LOBBY : CELL_ROOM, role: roleOf(name), space: space++, name, zone, hall: true })
      hallIds.push(id)
      rooms.push({ id, name, zone, hall: true, h0, h1, strip: si })
      for (let a = h0; a <= h1; a++) {
        for (let t = 0; t < strip.t; t++) {
          const c = fr.cell(a, t)
          st.set(c.gx, c.gz, id)
        }
      }
      // The corridor runs into the hall (open, no door).
      for (let t = c0; t < c0 + cw; t++) {
        for (const [ah, ac] of [[h0, h0 - 1], [h1, h1 + 1]]) {
          if (ac < a0 || ac > a1 || inHall(ac)) continue
          const p = fr.cell(ah, t)
          const q = fr.cell(ac, t)
          st.edge(p.gx, p.gz, q.gx, q.gz, OPEN)
        }
      }
      // Pillars on a 3-cell grid, off the hall's edges.
      if (strip.t >= 5 && h1 - h0 >= 4 && D.chance(0.7)) {
        const oa = D.int(0, 2)
        const ot = D.int(0, 2)
        for (let a = h0 + 1; a < h1; a++) {
          if ((a - h0 + oa) % 3) continue
          for (let t = 1; t < strip.t - 1; t++) {
            if ((t + ot) % 3) continue
            const c = fr.cell(a, t)
            st.set(c.gx, c.gz, id, CLS_PILLAR)
          }
        }
      }
    }
    // Bands: slices along the strip, each one room deep or split into a room
    // on the lane and rooms behind it; stair slots first.
    for (const [bi, band] of strip.bands.entries()) {
      const depth = band.b1 - band.b0 + 1
      const nearLow = band.near === band.b0
      const across = (d) => (nearLow ? band.b0 + d : band.b1 - d) // d = 0 at the lane
      const bandStairs = stairs.filter((t) => t.band === bi)
      const mid = fr.cell(Math.floor(strip.len / 2), across(0))
      const zone0 = zoneAt(mid.gx, mid.gz)
      const dressing = zone0 === 'boh' && (s === GROUND || s === FIRST) && depth >= 2 && D.chance(0.6)
      const slices = []
      let a = 0
      while (a < strip.len) {
        if (inHall(a)) {
          a++
          continue
        }
        const stair = bandStairs.find((t) => t.a === a)
        if (stair) {
          slices.push({ s0: a, s1: a + 5, stair })
          a += 6
          continue
        }
        let w = dressing ? 2 : zone0 === 'foh' ? D.int(3, 6) : D.int(2, 5)
        let end = a + w - 1
        // Stop at the next hall or stair; never leave a sliver under 2.
        for (let x = a; x <= end; x++) {
          if (inHall(x) || bandStairs.some((t) => t.a === x)) {
            end = x - 1
            break
          }
        }
        let next = end + 1
        while (next < strip.len && !inHall(next) && !bandStairs.some((t) => t.a === next) && next - end <= 1) next++
        if (next - end - 1 === 1 && next <= strip.len) end++
        if (end >= strip.len) end = strip.len - 1
        slices.push({ s0: a, s1: end })
        a = end + 1
      }
      for (const sl of slices) {
        if (sl.stair) {
          const t = sl.stair
          const id = st.add({ kind: CELL_STAIR, name: 'stairwell', zone: 'stair' })
          st.fill(t.rect, id, CLS_STAIR)
          st.door(t.door.inside.gx, t.door.inside.gz, t.door.outside.gx, t.door.outside.gz)
          // The cells behind the stair: a store reached from a neighbour slice.
          if (depth > 4) {
            const name = 'store'
            const id2 = st.add({ kind: CELL_ROOM, role: SPACE_ROLE_STORAGE, space: space++, name, zone: zone0 })
            for (let x = sl.s0; x <= sl.s1; x++) {
              for (let d = 4; d < depth; d++) {
                const c = fr.cell(x, across(d))
                st.set(c.gx, c.gz, id2)
              }
            }
            rooms.push({ id: id2, name, zone: zone0, strip: si, behind: { s0: sl.s0, s1: sl.s1, across, depth }, fr })
          }
          continue
        }
        // Split deep slices: a room on the lane (3..5 deep) and the rest
        // behind it (again split when deep).
        const parts = []
        let d0 = 0
        while (d0 < depth) {
          const left = depth - d0
          const dd = left <= 6 ? left : D.int(3, Math.min(5, left - 2))
          parts.push([d0, d0 + dd - 1])
          d0 += dd
        }
        for (const [pi, [da, db]] of parts.entries()) {
          const c = fr.cell(Math.floor((sl.s0 + sl.s1) / 2), across(da))
          const zone = zoneAt(c.gx, c.gz)
          const name = dressing && pi === 0 && sl.s1 - sl.s0 === 1 && db - da <= 2 ? 'dressing' : D.pick(ROOM_TYPES[zone][s].filter((n) => n !== 'dressing' || zone === 'boh'))
          const id = st.add({ kind: CELL_ROOM, role: roleOf(name), space: space++, name, zone })
          for (let x = sl.s0; x <= sl.s1; x++) {
            for (let d = da; d <= db; d++) {
              const cc = fr.cell(x, across(d))
              st.set(cc.gx, cc.gz, id)
            }
          }
          const room = { id, name, zone, strip: si, s0: sl.s0, s1: sl.s1, da, db, across, fr, band: bi }
          rooms.push(room)
          if (pi === 0) {
            // The door onto the lane (staggered in a dressing run: a door every cell).
            const cand = []
            for (let x = sl.s0; x <= sl.s1; x++) {
              const p = fr.cell(x, across(0))
              const q = fr.cell(x, nearLow ? band.b0 - 1 : band.b1 + 1)
              if (st.walk(q.gx, q.gz)) cand.push([p.gx, p.gz, q.gx, q.gz])
            }
            if (cand.length) {
              const pick = name === 'dressing' ? cand[(bi + (sl.s0 >> 1)) % cand.length] ?? cand[0] : cand[D.int(0, cand.length - 1)]
              if (doorable(st, ...pick)) st.door(...pick)
            }
          } else {
            const cand = []
            for (let x = sl.s0; x <= sl.s1; x++) {
              const p = fr.cell(x, across(da))
              const q = fr.cell(x, across(da - 1))
              cand.push([p.gx, p.gz, q.gx, q.gz])
            }
            pickDoors(st, D, cand, 1)
          }
        }
      }
    }
    // Lane ends beyond the corridor: part of the end rooms (dead ends).
    for (const [x, inward] of [...Array.from({ length: a0 }, (_, i) => [i, a0]), ...Array.from({ length: strip.len - 1 - a1 }, (_, i) => [a1 + 1 + i, a1])]) {
      if (inHall(x)) continue
      for (let t = c0; t < c0 + cw; t++) {
        const c = fr.cell(x, t)
        // Join the band room beside it, else the corridor.
        let id = 0
        for (const tt of [c0 - 1, c0 + cw]) {
          if (tt < 0 || tt >= strip.t) continue
          const n = fr.cell(x, tt)
          const r = st.regAt(n.gx, n.gz)
          if (r && st.clsAt(n.gx, n.gz) === CLS_NONE) {
            id = r
            break
          }
        }
        st.set(c.gx, c.gz, id || corr)
      }
      // The end room's door onto the corridor's end.
      if (x === a0 - 1 || x === a1 + 1) {
        const p = fr.cell(x, c0)
        const q = fr.cell(inward, c0)
        if (st.regAt(p.gx, p.gz) !== corr && doorable(st, p.gx, p.gz, q.gx, q.gz) && D.chance(0.7)) st.door(p.gx, p.gz, q.gx, q.gz)
      }
    }
    strips.push({ si, corr, hallIds })
  }
  // Stores behind stairs: a door to the neighbouring slice's room.
  for (const room of rooms) {
    if (!room.behind) continue
    const { s0, s1, across, depth } = room.behind
    const fr = room.fr
    const cand = []
    for (let d = 4; d < depth; d++) {
      for (const [x, nx] of [[s0, s0 - 1], [s1, s1 + 1]]) {
        const p = fr.cell(x, across(d))
        const q = fr.cell(nx, across(d))
        cand.push([p.gx, p.gz, q.gx, q.gz])
      }
    }
    pickDoors(st, D, cand, 1)
  }
  // Loops: a door between some neighbouring rooms of a band.
  for (const room of rooms) {
    if (room.hall || room.behind || !D.chance(0.25)) continue
    const fr = room.fr
    const cand = []
    for (let d = room.da; d <= room.db; d++) {
      const p = fr.cell(room.s1, room.across(d))
      const q = fr.cell(room.s1 + 1, room.across(d))
      cand.push([p.gx, p.gz, q.gx, q.gz])
    }
    pickDoors(st, D, cand, 1)
  }
  // The band meets the ring: every strip gets one or two doors onto it.
  const ringId = info.ring
  for (const strip of sk.strips) {
    const pairs = []
    const r = strip.rect
    for (let gz = r.z0; gz <= r.z1; gz++) {
      for (let gx = r.x0; gx <= r.x1; gx++) {
        for (const [dx, dz] of DIRS) {
          if (st.regAt(gx + dx, gz + dz) === ringId) pairs.push([gx, gz, gx + dx, gz + dz])
        }
      }
    }
    const pref = pairs.filter(([gx, gz]) => {
      const reg = st.regions[st.regAt(gx, gz)]
      return reg && (reg.kind === CELL_CORRIDOR || reg.hall)
    })
    const n = pickDoors(st, D, pref, D.int(1, 2)).length
    if (!n) pickDoors(st, D, pairs, 1)
  }
  // Strips meet each other: one door per neighbouring pair (corridor or hall
  // preferred).
  for (let i = 0; i < sk.strips.length; i++) {
    for (let j = i + 1; j < sk.strips.length; j++) {
      const A = sk.strips[i].rect
      const B = sk.strips[j].rect
      const pairs = []
      for (let gz = A.z0; gz <= A.z1; gz++) {
        for (let gx = A.x0; gx <= A.x1; gx++) {
          for (const [dx, dz] of DIRS) {
            if (inRect(B, gx + dx, gz + dz)) pairs.push([gx, gz, gx + dx, gz + dz])
          }
        }
      }
      if (!pairs.length) continue
      const good = (gx, gz) => {
        const reg = st.regions[st.regAt(gx, gz)]
        return reg && (reg.kind === CELL_CORRIDOR || reg.hall)
      }
      const pref = pairs.filter(([ax, az, bx, bz]) => good(ax, az) && good(bx, bz))
      if (!pickDoors(st, D, pref, 1).length) pickDoors(st, D, pairs, 1)
    }
  }
  info.rooms = rooms
}

// --- ports ---------------------------------------------------------------------------

// Tile mode: every declared port cell is walkable on both sides of its seam.
// West/north: the tile's own edge cell (band or ring by construction);
// east/south: the perimeter cell joins the band room or ring beside it.
// The band's outer poché (doc 11 §4: load-bearing masonry, service voids):
// along each tile edge the outermost band row is solid in rolled runs — room
// cells, and corridor cells where the corridor is two wide there — so the
// tile's skin differs from theatre to theatre and storey to storey.
function poche(st, D) {
  const sides = [(a) => [0, a, 1, a], (a) => [a, 0, a, 1], (a) => [EDGE, a, EDGE - 1, a], (a) => [a, EDGE, a, EDGE - 1]]
  for (const cell of sides) {
    let a = 0
    let solid = D.chance(0.5)
    while (a <= EDGE) {
      const len = D.int(2, 9)
      if (solid) {
        for (let t = a; t < Math.min(EDGE + 1, a + len); t++) {
          const [gx, gz, ix, iz] = cell(t)
          const i = IDX(gx, gz)
          const r = st.reg[i]
          if (!r || st.cls[i] !== CLS_NONE || st.reserved[i]) continue
          const reg = st.regions[r]
          if (reg.zone !== 'foh' && reg.zone !== 'boh') continue
          if (reg.kind === CELL_CORRIDOR ? st.regAt(ix, iz) !== r || st.clsAt(ix, iz) !== CLS_NONE : reg.kind !== CELL_ROOM) continue
          st.reg[i] = 0
        }
      }
      a += len
      solid = !solid
    }
  }
}

function openPorts(st, portsOf) {
  const sides = [
    ['west', (a) => [0, a, 1, a]],
    ['north', (a) => [a, 0, a, 1]],
    ['east', (a) => [N - 1, a, N - 2, a]],
    ['south', (a) => [a, N - 1, a, N - 2]],
  ]
  for (const [side, cells] of sides) {
    for (const { a0, a1 } of portsOf(side) ?? []) {
      for (let a = a0; a <= a1; a++) {
        const [gx, gz, ix, iz] = cells(a)
        if (!st.kept(gx, gz)) continue
        // The inner cell first (the band's edge poché may have massed it),
        // then the edge cell joins it.
        if (!st.walk(ix, iz) || st.clsAt(ix, iz) !== CLS_NONE) {
          const jx = 2 * ix - gx
          const jz = 2 * iz - gz
          const id = st.walk(jx, jz) && st.clsAt(jx, jz) === CLS_NONE ? st.regAt(jx, jz) : st.add({ kind: CELL_CORRIDOR, name: 'port' })
          st.set(ix, iz, id)
        }
        if (!st.walk(gx, gz) || st.clsAt(gx, gz) !== CLS_NONE) st.set(gx, gz, st.regAt(ix, iz))
        st.reserve(gx, gz)
        st.reserve(ix, iz)
        st.noCarve[IDX(gx, gz)] = 0
      }
    }
  }
}

// --- furniture and lamps ---------------------------------------------------------------

// A piece hugging a wall of its cell (the first walled side, in the dice's
// order), unless the cell is reserved or taken.
function hug(st, D, gx, gz, kind) {
  const i = IDX(gx, gz)
  if (!st.walk(gx, gz) || st.reserved[i] || st.furn.has(i) || st.clsAt(gx, gz) !== CLS_NONE) return false
  const sides = [...DIRS]
  const o = D.int(0, 3)
  for (let k = 0; k < 4; k++) {
    const [dx, dz] = sides[(k + o) % 4]
    if (st.edgeState(gx, gz, gx + dx, gz + dz).wall && st.edgeState(gx, gz, gx + dx, gz + dz).passage === PASSAGE_WALL) {
      st.piece(gx, gz, kind, { wall: sideOf(dx, dz) })
      return true
    }
  }
  return false
}

const ROOM_PIECES = Object.freeze({
  dressing: [FURN_DESK],
  'green room': [FURN_SOFA, FURN_SOFA, FURN_ARMCHAIR],
  wardrobe: [FURN_RACK, FURN_WARDROBE, FURN_RACK],
  'prop store': [PROP_ROAD_CASE, PROP_ROAD_CASE, FURN_CABINET],
  'stage door': [FURN_DESK, FURN_CHAIR],
  'box office': [FURN_COUNTER, FURN_CHAIR],
  cloakroom: [FURN_RACK, FURN_RACK, FURN_COUNTER],
  bar: [FURN_COUNTER, FURN_COUNTER, FURN_ARMCHAIR],
  toilets: [FURN_TOILET, FURN_SINK, FURN_TOILET],
  manager: [FURN_DESK, FURN_CHAIR, FURN_BOOKSHELF],
  'circle bar': [FURN_COUNTER, FURN_ARMCHAIR, FURN_PLANT],
  office: [FURN_DESK, FURN_CHAIR, FURN_CABINET],
  archive: [FURN_BOOKSHELF, FURN_BOOKSHELF, FURN_CABINET],
  salon: [FURN_SOFA, FURN_ARMCHAIR, FURN_PLANT],
  rehearsal: [FURN_CHAIR],
  cellar: [FURN_RACK, FURN_CABINET],
  boiler: [FURN_CABINET],
  store: [PROP_ROAD_CASE, FURN_RACK],
  'cloak store': [FURN_RACK, FURN_WARDROBE],
  'band room': [FURN_CHAIR, FURN_CHAIR, FURN_CABINET],
  workshop: [FURN_CABINET, PROP_ROAD_CASE],
  lobby: [FURN_SOFA, FURN_PLANT, FURN_COUNTER],
  foyer: [FURN_ARMCHAIR, FURN_PLANT],
  'scene dock': [PROP_ROAD_CASE, PROP_ROAD_CASE, PROP_ROAD_CASE],
  'paint frame': [FURN_CABINET],
  understore: [PROP_ROAD_CASE, FURN_RACK],
  cistern: [],
})

function furnishBand(st, D, info) {
  const cellsOf = new Map()
  for (let i = 0; i < N * N; i++) {
    const r = st.reg[i]
    if (!r) continue
    let a = cellsOf.get(r)
    if (!a) cellsOf.set(r, (a = []))
    a.push(i)
  }
  let lit = 0
  for (const room of info.rooms) {
    const cells = cellsOf.get(room.id) ?? []
    if (!cells.length) continue
    const pieces = ROOM_PIECES[room.name] ?? []
    const budget = Math.min(pieces.length, Math.max(0, Math.floor(cells.length / 3)))
    let placed = 0
    for (const kind of pieces.slice(0, budget || (cells.length >= 2 ? 1 : 0))) {
      for (let t = 0; t < 6; t++) {
        const i = cells[D.int(0, cells.length - 1)]
        if (hug(st, D, i % N, Math.floor(i / N), kind)) {
          placed++
          break
        }
      }
    }
    // The room's circuit: the mirror bulbs over a dressing table, work
    // lights backstage, warm fittings front of house; some circuits dead.
    room.lit = D.chance(room.name === 'dressing' ? 0.7 : room.zone === 'foh' ? 0.55 : 0.65)
    room.tint = room.name === 'dressing' ? MIRROR : room.zone === 'foh' ? HOUSE_LAMP : WORK
    lit += room.lit
    room.pieces = placed
  }
  info.litRooms = lit
}

// --- the plan ------------------------------------------------------------------------

// The whole theatre of one tile (or the kind lab's sample): a Storey per
// kind storey 0..FLOORS−1 (null where nothing is kept), plus the notes'
// counts. opts: { tile, anomaly (geometry.ANOMALY_CLASSES or null),
// portsOf(side, s) → [{a0, a1}] (tile mode: the seams' declared ports) }.
export function planTheatre(sc, { tile = false, anomaly = null, portsOf = null } = {}) {
  const F = frameOf(sc)
  const storeys = []
  const info = { seats: { stalls: 0, dress: 0, upper: 0, boxes: 0 }, dressing: 0, rooms: 0, halls: 0, stairs: sc.skeleton.stairs.length }
  for (let s = 0; s < FLOORS; s++) {
    let any = false
    for (let cz = 0; cz < 3 && !any; cz++) for (let cx = 0; cx < 3; cx++) if (keptLocal(sc, cx, s, cz)) any = true
    if (!any) {
      storeys.push(null)
      continue
    }
    const st = new Storey(s, sc)
    const D = dice(hashChain(sc.seed | 0, s, 0x1f))
    const ids = {}
    const binfo = { rooms: [] }
    if (s < sc.NL) volumeLevel(st, sc, F, s, D, ids)
    if (s <= BAND_TOP) {
      binfo.ring = ids.ring
      bandStorey(st, sc, F, s, D, binfo)
      poche(st, D)
    }
    // The perimeter row/column (x/z 41) stays mass but at ports.
    for (let a = 0; a < N; a++) {
      st.noCarve[IDX(N - 1, a)] = 1
      st.noCarve[IDX(a, N - 1)] = 1
    }
    if (tile && portsOf && s <= BAND_TOP) openPorts(st, (side) => portsOf(side, s))
    if (!st.root) st.root = { gx: sc.coreDoor.outside.gx, gz: sc.coreDoor.outside.gz }
    connect(st)
    st.ids = ids
    st.binfo = binfo
    storeys.push(st)
  }
  furnishHouse(storeys, sc, F, anomaly, info)
  for (let s = 0; s <= BAND_TOP; s++) {
    const st = storeys[s]
    const D = dice(hashChain(sc.seed | 0, s, 0x2f))
    furnishBand(st, D, st.binfo)
    info.rooms += st.binfo.rooms.length
    info.halls += st.binfo.rooms.filter((r) => r.hall).length
    info.dressing += st.binfo.rooms.filter((r) => r.name === 'dressing').length
    bandLamps(st, D, st.binfo.rooms)
  }
  for (const st of storeys) if (st) unblock(st)
  // Recount the seats that survived the unblock.
  info.seats = { stalls: 0, dress: 0, upper: 0, boxes: 0 }
  for (const [s, key] of [[GROUND, 'stalls'], [2, 'dress'], [3, 'upper']]) {
    const st = storeys[s]
    if (!st) continue
    for (const p of st.furn.values()) {
      if (p.kind !== PROP_SEAT_ROW) continue
      if (s === 2 && st.regions[st.regAt(p.gx, p.gz)]?.name === 'box') info.seats.boxes++
      else info.seats[key]++
    }
  }
  return { storeys, info, F }
}

// The band's lamps: every room, hall and corridor gets fittings at most
// three cells (Chebyshev) apart over its own cells, on one circuit per room
// (rooms.lit) and a few cells per circuit along a corridor; the house
// volume's own lamps are furnishHouse's.
function bandLamps(st, D, rooms) {
  const roomOf = new Map(rooms.map((r) => [r.id, r]))
  const placed = new Map() // region → [[gx, gz]]
  for (let i = 0; i < N * N; i++) {
    const r = st.reg[i]
    if (!r || st.cls[i] !== CLS_NONE) continue
    const reg = st.regions[r]
    if (reg.zone === 'ring' || reg.zone === 'house' || reg.zone === 'stage' || reg.zone === 'core' || reg.zone === 'stair') continue
    const gx = i % N
    const gz = (i - gx) / N
    let list = placed.get(r)
    if (!list) placed.set(r, (list = []))
    if (list.some(([x, z]) => Math.max(Math.abs(x - gx), Math.abs(z - gz)) <= 3)) continue
    // Centre the fitting: one cell in from the region's first cells.
    const tx = st.regAt(gx + 1, gz) === r && st.clsAt(gx + 1, gz) === CLS_NONE ? gx + 1 : gx
    const tz = st.regAt(tx, gz + 1) === r && st.clsAt(tx, gz + 1) === CLS_NONE ? gz + 1 : gz
    list.push([tx, tz])
    const room = roomOf.get(r)
    const on = room ? room.lit : D.chance(0.65)
    const tint = room ? room.tint : reg.zone === 'foh' ? HOUSE_LAMP : WORK
    st.lamp(tx, tz, on, on ? tint : null)
  }
}

// --- the house's furniture and lamps ------------------------------------------------

function furnishHouse(storeys, sc, F, anomaly, info) {
  const ground = storeys[GROUND]
  const face = F.step(1, 0) // toward the stage
  const towardStage = facingOf(face.dx, face.dz)
  const back = facingOf(-face.dx, -face.dz)
  const D = dice(hashChain(sc.seed | 0, 0x5ea7))
  // Stalls: rows u 1..front−1 (not the mid aisle), blocks between gangways.
  const rows = []
  for (let u = 1; u < sc.front; u++) if (u !== sc.mid) rows.push(u)
  const victim = { u: rows[D.int(0, rows.length - 1)], block: D.int(0, sc.blocks.length - 1) }
  for (const u of rows) {
    for (const [bi, [v0, v1]] of sc.blocks.entries()) {
      const hit = u === victim.u && bi === victim.block
      if (hit && anomaly === 'missing') continue
      for (let v = v0; v <= v1; v++) {
        const c = F.toTile(u, v)
        if (!seatable(ground, c)) continue
        ground.piece(c.gx, c.gz, PROP_SEAT_ROW, { facing: hit && anomaly === 'turned' ? back : towardStage })
      }
    }
  }
  // The circles: back rows facing the stage; a front row along each side
  // gallery (or a seat in every box), facing the house.
  for (const [s, hv] of [[2, sc.dress], [3, sc.upper]]) {
    const st = storeys[s]
    if (!st || !hv || !((s === 2 && sc.circles >= 1) || (s === 3 && sc.circles >= 2))) continue
    for (let u = 1; u < hv.u0; u++) {
      for (const [v0, v1] of sc.blocks) {
        for (let v = v0; v <= v1; v++) {
          const c = F.toTile(u, v)
          // A seat looks at the next row or over the rail, never at a box's wall.
          const f = F.toTile(u + 1, v)
          if (st.regAt(f.gx, f.gz) !== st.regAt(c.gx, c.gz) && st.clsAt(f.gx, f.gz) !== CLS_VOID) continue
          if (seatable(st, c)) st.piece(c.gx, c.gz, PROP_SEAT_ROW, { facing: towardStage })
        }
      }
    }
    for (const sgn of [1, -1]) {
      const vf = sgn > 0 ? hv.v0 - 1 : hv.v1 + 1
      if (sgn > 0 ? vf < 1 : vf > sc.W - 2) continue
      const inward = F.step(0, sgn)
      for (let u = hv.u0; u <= hv.u1; u++) {
        const c = F.toTile(u, vf)
        const reg = st.regions[st.regAt(c.gx, c.gz)]
        if (!reg) continue
        if (s === 2 && sc.boxes && reg.name !== 'box') continue
        if (seatable(st, c)) st.piece(c.gx, c.gz, PROP_SEAT_ROW, { facing: facingOf(inward.dx, inward.dz) })
      }
    }
  }
  // The ghost light: downstage centre (upstage as the anomaly), the only lit
  // lamp in the house and on the stage.
  const ghost = F.toTile(anomaly === 'upstage' ? sc.L - 2 : sc.P + 1, sc.oc)
  const dc = F.toTile(sc.P + 1, sc.oc)
  ground.reserve(ghost.gx, ghost.gz)
  ground.piece(ghost.gx, ghost.gz, PROP_GHOST_LIGHT)
  if (anomaly === 'upstage') ground.lamp(dc.gx, dc.gz, false)
  ground.lamp(ghost.gx, ghost.gz, true, BULB)
  info.ghost = ghost
  // The prompt desk, stage left of the opening, against the proscenium wall.
  const pd = F.toTile(sc.P, sc.o1 + 2)
  if (sc.o1 + 2 <= sc.W - 1 && seatable(ground, pd)) {
    const w = F.step(-1, 0)
    ground.piece(pd.gx, pd.gz, PROP_PROMPT_DESK, { wall: sideOf(w.dx, w.dz) })
  }
  // Road cases in the wings (upstage corners) and the trap room.
  for (const v of [0, sc.W - 1]) {
    const c = F.toTile(sc.L - 1, v)
    if (D.chance(0.7)) hug(ground, D, c.gx, c.gz, PROP_ROAD_CASE)
  }
  const trap = storeys[BASE]
  for (const c of sc.exitCells) trap.reserve(c.gx, c.gz)
  for (let n = 0; n < 4; n++) {
    const c = F.toTile(sc.L - 1, D.int(0, sc.W - 1))
    hug(trap, D, c.gx, c.gz, PROP_ROAD_CASE)
  }
  // Lamps: the house all dead (side aisles, the back aisle, the circles'
  // fittings), the chandelier dead under the slab that caps the house, the
  // fly grid dead; one blue work light per fly level and in the trap room.
  for (const u of [0, sc.front, Math.floor(sc.front / 2)]) {
    for (const v of [0, sc.W - 1]) {
      const c = F.toTile(u, v)
      ground.lamp(c.gx, c.gz, false)
    }
  }
  for (const [s, hv] of [[2, sc.dress], [3, sc.upper]]) {
    const st = storeys[s]
    if (!st || !hv || !((s === 2 && sc.circles >= 1) || (s === 3 && sc.circles >= 2))) continue
    for (const v of [0, sc.W - 1]) {
      const c = F.toTile(0, v)
      st.lamp(c.gx, c.gz, false)
    }
  }
  const capS = GROUND + sc.circles
  const capSt = storeys[capS]
  const hv = sc.circles >= 2 ? sc.upper : sc.circles >= 1 ? sc.dress : { u0: 1, u1: sc.front - 1, v0: 1, v1: sc.W - 2 }
  const cu = Math.floor((hv.u0 + hv.u1) / 2)
  const cv = Math.floor((hv.v0 + hv.v1) / 2)
  for (const [du, dv] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const c = F.toTile(cu + du, cv + dv)
    capSt?.lamp(c.gx, c.gz, false)
  }
  for (let s = 2; s < sc.NL; s++) {
    const st = storeys[s]
    const w = F.toTile(sc.fly.u0, Math.max(0, sc.fly.v0 - 1))
    st.lamp(w.gx, w.gz, s === 2 || s === sc.NL - 1, WORK)
    if (s === sc.NL - 1) {
      const fc = F.toTile(Math.floor((sc.fly.u0 + sc.fly.u1) / 2), sc.oc)
      st.lamp(fc.gx, fc.gz, false)
    }
  }
  const tl = F.toTile(sc.fly.u0, sc.oc)
  trap.lamp(tl.gx, tl.gz, true, WORK)
  info.victim = victim
  // No seat looks at a wall (a box's partition, the core, the proscenium):
  // in front of each is the next row, an aisle, a door or the rail over a void.
  const STEP = { [FACING.E]: [1, 0], [FACING.W]: [-1, 0], [FACING.S]: [0, 1], [FACING.N]: [0, -1] }
  for (const st of storeys) {
    if (!st) continue
    for (const [i, p] of [...st.furn]) {
      if (p.kind !== PROP_SEAT_ROW) continue
      const [dx, dz] = STEP[p.facing]
      if (st.edgeState(p.gx, p.gz, p.gx + dx, p.gz + dz).wall) st.furn.delete(i)
    }
  }
}

const seatable = (st, c) => {
  const i = IDX(c.gx, c.gz)
  return st.walk(c.gx, c.gz) && !st.reserved[i] && !st.furn.has(i) && st.clsAt(c.gx, c.gz) === CLS_NONE
}

