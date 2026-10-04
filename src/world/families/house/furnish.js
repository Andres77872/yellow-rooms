import { CELL, cIdx } from '../../constants.js'
import { THICK, WALL_TO_FRONT, addPiece } from '../../tiles/floorPlan.js'
import { PIECE_DIMS } from '../../rooms/furnish.js'
import {
  FURN_ARMCHAIR,
  FURN_BED,
  FURN_BOOKSHELF,
  FURN_CHAIR,
  FURN_COUNTER,
  FURN_FRIDGE,
  FURN_NIGHTSTAND,
  FURN_PLANT,
  FURN_SINK,
  FURN_SOFA,
  FURN_STOVE,
  FURN_TABLE,
  FURN_TOILET,
  FURN_TUB,
  FURN_TV,
  FURN_WARDROBE,
  FURN_WASHER,
} from '../../rooms/catalog.js'
import { PROP_HALL_CLOCK, PROP_RADIO } from '../../props/index.js'

// The house's domestic furnishing (doc §6: "beds, sofas, kitchen, bathroom";
// the hall clock and the radio of the house pack). A room of the house is
// small (2×2 or 2×3 cells of 3 m; a bathroom or a WC 1×2) and FULL, the way
// a lived-in house is: every room is furnished by its role in GROUPS, each
// group a few pieces packed together into one cell at their true sizes —
//   living   the sofa against the far wall facing the TV, the radio on its
//            side table, a plant; armchairs; a bookcase;
//   dining   the table with its chairs drawn up round it; the sideboard (a
//            base-unit run) with a plant;
//   kitchen  the fridge, the stove and the counter in one run (the sink
//            when a counter will not fit); the counter and the sink in
//            another; sometimes a small table with two chairs;
//   bedroom  the bed, its head to the wall, a nightstand either side, or off
//            centre with the wardrobe beside it in a small room; the
//            wardrobe; an armchair, a plant;
//   bathroom the WC, the basin beside it and the bath along the side wall,
//            all in one 3 m cell;
//   laundry  two washers and a sink in a run; a utility counter;
//   study    the writing table against the wall with its chair drawn up,
//            the bookcases; den the sofa and the bookcases; nursery the
//            small bed, an armchair, a plant.
// The office kinds (the desk, the filing cabinet) never appear.
//
// Rules, per room (all cells of a room are one open space):
//   - door cells (a room cell across an open perimeter edge: its door, a
//     second door, a child room's door) and the lamp cell stay free, and at
//     least a third of the room's cells (door cells count) stays floor;
//   - a group opens on a cell no group holds yet, where every free cell of
//     the room still reaches every door cell (a room-local flood); its
//     pieces pack against that cell's walls (or stand free round a table)
//     without overlapping;
//   - at most KIND_CAP distinct kinds per chunk (spec §11.1 item 9): each
//     chunk's slots go to the kinds its rooms want most (planKinds), and the
//     pieces that make each room read go down first (pass 0), the second
//     ones after (pass 1), the dressing last (pass 2).
// Pure in the room record and the dice `r` (the tile's furnishing rng).

export const KIND_CAP = 14

// A wall piece's back, from its cell's centre (addPiece's offset), and the
// clearances between pieces (`tight` for a run of kitchen units).
const IN = CELL / 2 - THICK / 2 - 0.06
const GAP = 0.06
const TIGHT = 0.01
const DIMS = Object.freeze({ ...PIECE_DIMS, [FURN_CHAIR]: [0.55, 0.55], [FURN_TABLE]: [2.2, 1.1] })
const dimsOf = (kind) => DIMS[kind] ?? [1, 1]

// Role recipes: groups of [kind, where, chance, pass, opts]. The first item
// of a group opens it on a cell of its own: 'open' against a wall (the far
// side of the room first; opts.u: 0 centred, 'end' from one end, 'off' a
// little off centre, 'snug' centred while the room has a second cell to
// give; opts.alt: the kind to open with when the room has this one), or
// 'table' free-standing in the cell's middle. The rest join the group's
// cell: 'beside' along the same wall, next to the last piece; 'side'
// against a wall at right angles; 'facing' across the cell, facing the
// first piece (the TV the sofa looks at); 'front' just in front of the
// first piece, facing it (the chair at the writing table); 'chairs' round
// the table (opts.n).
const P0 = 0
const P1 = 1
const P2 = 2
export const RECIPES = Object.freeze({
  living: [
    [[FURN_SOFA, 'open', 1, P0, { u: 'off' }], [FURN_TV, 'facing', 1, P0], [PROP_RADIO, 'beside', 0.6, P1], [FURN_PLANT, 'side', 0.5, P2]],
    [[FURN_ARMCHAIR, 'open', 0.9, P1, { u: 'off' }], [FURN_ARMCHAIR, 'beside', 0.6, P1], [FURN_PLANT, 'side', 0.5, P2]],
    [[FURN_BOOKSHELF, 'open', 0.7, P2, { u: 'off' }], [FURN_PLANT, 'beside', 0.5, P2], [FURN_ARMCHAIR, 'side', 0.4, P2]],
    [[FURN_PLANT, 'open', 0.7, P2, { u: 'end' }], [FURN_BOOKSHELF, 'beside', 0.5, P2]],
  ],
  dining: [
    [[FURN_TABLE, 'table', 1, P0], [FURN_CHAIR, 'chairs', 1, P0, { n: 4 }]],
    // The sideboard (a base-unit run), a plant at its end.
    [[FURN_COUNTER, 'open', 0.85, P1, { u: 'off' }], [FURN_PLANT, 'beside', 0.6, P2], [FURN_PLANT, 'side', 0.3, P2]],
    [[FURN_PLANT, 'open', 0.5, P2, { u: 'end' }], [FURN_ARMCHAIR, 'beside', 0.4, P2]],
  ],
  kitchen: [
    [[FURN_FRIDGE, 'open', 1, P0, { u: 'end' }], [FURN_STOVE, 'beside', 1, P0, { tight: true }], [FURN_COUNTER, 'beside', 1, P1, { tight: true }], [FURN_SINK, 'beside', 1, P1, { tight: true }]],
    [[FURN_COUNTER, 'open', 0.95, P1, { u: 'end' }], [FURN_SINK, 'beside', 0.9, P1, { tight: true }], [FURN_COUNTER, 'beside', 0.4, P2, { tight: true }]],
    [[FURN_TABLE, 'table', 0.45, P2], [FURN_CHAIR, 'chairs', 1, P2, { n: 2 }]],
  ],
  bed: [
    [[FURN_BED, 'open', 1, P0, { u: 'snug' }], [FURN_WARDROBE, 'side', 1, P0], [FURN_NIGHTSTAND, 'beside', 0.9, P1], [FURN_NIGHTSTAND, 'beside', 0.75, P1]],
    [[FURN_WARDROBE, 'open', 1, P0, { u: 'off', alt: FURN_ARMCHAIR }], [FURN_PLANT, 'beside', 0.5, P2], [FURN_ARMCHAIR, 'side', 0.4, P2]],
    [[FURN_ARMCHAIR, 'open', 0.6, P1, { u: 'end' }], [FURN_PLANT, 'beside', 0.5, P2], [FURN_BOOKSHELF, 'side', 0.3, P2]],
  ],
  nursery: [
    [[FURN_BED, 'open', 1, P0, { u: 'snug' }], [FURN_WARDROBE, 'side', 0.7, P1], [FURN_NIGHTSTAND, 'beside', 0.7, P1], [FURN_PLANT, 'side', 0.3, P2]],
    [[FURN_ARMCHAIR, 'open', 0.8, P1, { u: 'off' }], [FURN_PLANT, 'beside', 0.4, P2], [FURN_BOOKSHELF, 'side', 0.4, P2]],
    [[FURN_WARDROBE, 'open', 0.5, P1, { u: 'off', alt: FURN_PLANT }], [FURN_PLANT, 'beside', 0.4, P2]],
  ],
  study: [
    // The writing table against the wall, its chair drawn up.
    [[FURN_TABLE, 'open', 1, P0, { u: 'off' }], [FURN_CHAIR, 'front', 1, P0], [FURN_BOOKSHELF, 'side', 0.7, P1], [FURN_PLANT, 'side', 0.3, P2]],
    [[FURN_BOOKSHELF, 'open', 0.9, P1, { u: 'off' }], [FURN_BOOKSHELF, 'beside', 0.6, P2], [FURN_PLANT, 'beside', 0.3, P2]],
    [[FURN_ARMCHAIR, 'open', 0.6, P1, { u: 'end' }], [FURN_PLANT, 'beside', 0.5, P2]],
  ],
  den: [
    [[FURN_SOFA, 'open', 1, P0, { u: 'off' }], [FURN_TV, 'facing', 0.5, P1], [PROP_RADIO, 'beside', 0.4, P1], [FURN_PLANT, 'side', 0.4, P2]],
    [[FURN_BOOKSHELF, 'open', 0.9, P1, { u: 'off' }], [FURN_BOOKSHELF, 'beside', 0.6, P2], [FURN_ARMCHAIR, 'side', 0.5, P1]],
    [[FURN_ARMCHAIR, 'open', 0.5, P1, { u: 'end' }], [FURN_PLANT, 'beside', 0.5, P2]],
  ],
  bath: [
    [[FURN_TOILET, 'open', 1, P0, { u: 'end' }], [FURN_SINK, 'beside', 1, P0], [FURN_TUB, 'side', 0.85, P1], [FURN_PLANT, 'beside', 0.2, P2]],
    [[FURN_TUB, 'open', 0.6, P1, { alt: FURN_PLANT }], [FURN_PLANT, 'beside', 0.3, P2]],
  ],
  laundry: [
    [[FURN_WASHER, 'open', 1, P0, { u: 'end' }], [FURN_WASHER, 'beside', 0.8, P0, { tight: true }], [FURN_SINK, 'beside', 0.6, P0, { tight: true }], [FURN_COUNTER, 'side', 0.6, P2]],
    [[FURN_SINK, 'open', 0.7, P1, { u: 'end' }], [FURN_COUNTER, 'beside', 0.5, P2, { tight: true }]],
  ],
})

const SIDES = Object.freeze(['N', 'S', 'W', 'E'])
const OPPOSITE = Object.freeze({ N: 'S', S: 'N', W: 'E', E: 'W' })
const ALONG_X = Object.freeze({ N: true, S: true, W: false, E: false })

// --- cell-local rectangles (centre origin, x east, z south) ----------------------------------

// A piece of `kind` with its back to wall `side`, centred `u` along it.
function wallRect(kind, side, u) {
  const [w, d] = dimsOf(kind)
  if (side === 'N') return { x0: u - w / 2, x1: u + w / 2, z0: -IN, z1: -IN + d }
  if (side === 'S') return { x0: u - w / 2, x1: u + w / 2, z0: IN - d, z1: IN }
  if (side === 'W') return { x0: -IN, x1: -IN + d, z0: u - w / 2, z1: u + w / 2 }
  return { x0: IN - d, x1: IN, z0: u - w / 2, z1: u + w / 2 }
}
// A free-standing piece centred at (x, z), its width along x when alongX.
function freeRect(kind, x, z, alongX) {
  const [w, d] = dimsOf(kind)
  const [hx, hz] = alongX ? [w / 2, d / 2] : [d / 2, w / 2]
  return { x0: x - hx, x1: x + hx, z0: z - hz, z1: z + hz }
}
const E = 1e-6
const inCell = (q) => q.x0 >= -IN - E && q.x1 <= IN + E && q.z0 >= -IN - E && q.z1 <= IN + E
const clearOf = (rects, q, gap) => rects.every((o) => q.x1 + gap <= o.x0 + E || o.x1 + gap <= q.x0 + E || q.z1 + gap <= o.z0 + E || o.z1 + gap <= q.z0 + E)
// The position along wall `side` of a rect (its centre).
const uOf = (q, side) => (ALONG_X[side] ? (q.x0 + q.x1) / 2 : (q.z0 + q.z1) / 2)
const halfAlong = (q, side) => (ALONG_X[side] ? (q.x1 - q.x0) / 2 : (q.z1 - q.z0) / 2)

// --- the room's state ------------------------------------------------------------------------

// The walled sides of cell (gx, gz) of room rm, and whether any perimeter
// edge of it is open (a door cell).
function sidesOf(map, rm, gx, gz) {
  const { cy } = rm
  const walls = []
  let door = false
  const edge = {
    N: gz === rm.z0 ? map.wallHAt(gx, cy, gz) : null,
    S: gz === rm.z1 ? map.wallHAt(gx, cy, gz + 1) : null,
    W: gx === rm.x0 ? map.wallVAt(gx, cy, gz) : null,
    E: gx === rm.x1 ? map.wallVAt(gx + 1, cy, gz) : null,
  }
  for (const s of SIDES) {
    const e = edge[s]
    if (!e) continue
    if (e.wall) walls.push(s)
    else door = true
  }
  return { walls, door }
}

// A room's furnishing state: its cells (walls, door flag, the pieces' rects),
// door cells, lamp cell, the cells it may still furnish.
export function roomState(map, rm) {
  const cells = []
  const doors = []
  for (let gz = rm.z0; gz <= rm.z1; gz++) {
    for (let gx = rm.x0; gx <= rm.x1; gx++) {
      const s = sidesOf(map, rm, gx, gz)
      const d = map.chunkAt(map.cellChunk(gx), rm.cy, map.cellChunk(gz))
      const c = { gx, gz, walls: s.walls, door: s.door, rects: null, d, i: cIdx(map.cellLocal(gx), map.cellLocal(gz)) }
      cells.push(c)
      if (s.door) doors.push(c)
    }
  }
  return { rm, cells, doors, lamp: null, placed: [], groups: [], budget: 0 }
}

// The room's lamp cell: the cell inside its door (a pendant by the door
// lights the room and, through the doorway, the hallway outside — the
// chunk's light budget goes twice as far), else its centre. No piece takes
// a door cell anyway.
export function lampCellOf(st) {
  const { rm } = st
  const d = rm.door
  const a = d.axis === 'v' ? { gx: d.gx - 1, gz: d.gz } : { gx: d.gx, gz: d.gz - 1 }
  const inRoom = (c) => c.gx >= rm.x0 && c.gx <= rm.x1 && c.gz >= rm.z0 && c.gz <= rm.z1
  if (inRoom(a)) return a
  if (inRoom(d)) return { gx: d.gx, gz: d.gz }
  return { gx: Math.floor((rm.x0 + rm.x1) / 2), gz: Math.floor((rm.z0 + rm.z1) / 2) }
}

// A room cell's column (its chunk and index are resolved once, roomState).
const colOf = (c) => (c.d ? c.d.cols[c.i] : 0)

const SEEN = new Uint8Array(64)
const STACK = []
// Every free cell of the room reaches the first door cell, and every door
// cell is free, with cell `extra` (an index) blocked as well (a flood over
// the room's cells, row-major from its corner).
function whole(st, extra) {
  const { rm, cells, doors } = st
  const w = rm.x1 - rm.x0 + 1
  const blocked = (k) => k === extra || colOf(cells[k]) !== 0
  const idx = (c) => (c.gz - rm.z0) * w + (c.gx - rm.x0)
  for (const d of doors) if (blocked(idx(d))) return false
  let start = doors.length ? idx(doors[0]) : -1
  if (start < 0) for (let k = 0; k < cells.length && start < 0; k++) if (!blocked(k)) start = k
  if (start < 0) return true
  const seen = SEEN.length >= cells.length ? SEEN.fill(0, 0, cells.length) : new Uint8Array(cells.length)
  const stack = STACK
  let top = 0
  stack[top++] = start
  seen[start] = 1
  let reached = 1
  const visit = (n) => {
    if (n < 0 || n >= cells.length || seen[n] || blocked(n)) return
    seen[n] = 1
    reached++
    stack[top++] = n
  }
  while (top) {
    const k = stack[--top]
    const x = k % w
    if (x > 0) visit(k - 1)
    if (x < w - 1) visit(k + 1)
    visit(k - w)
    visit(k + w)
  }
  let n = 0
  for (let k = 0; k < cells.length; k++) if (!blocked(k)) n++
  return reached === n
}

// A chunk's furniture kinds, kept up to date by put() (rebuilt when the
// chunk's list changed behind its back).
const KINDS = new WeakMap()
const kindsOf = (d) => {
  const hit = KINDS.get(d)
  if (hit && hit.n === d.furniture.length && hit.list === d.furniture) return hit.set
  const set = new Set()
  for (const f of d.furniture) set.add(f.kind)
  KINDS.set(d, { n: d.furniture.length, list: d.furniture, set })
  return set
}
const noteKind = (d, kind) => {
  const hit = KINDS.get(d)
  if (hit && hit.n === d.furniture.length - 1 && hit.list === d.furniture) {
    hit.set.add(kind)
    hit.n++
  }
}

// Chunk d may take one more piece of `kind`: within its kind plan
// (planKinds) when it has one, and under KIND_CAP.
const PLAN = new WeakMap()
function capOk(d, kind) {
  if (!d) return false
  const k = kindsOf(d)
  if (k.has(kind)) return true
  const plan = PLAN.get(d)
  return k.size < KIND_CAP && (!plan || plan.has(kind))
}

// Each chunk's kind slots (KIND_CAP less the kinds it holds already): first
// the kinds that make its rooms read (any pass-0 item of a room in it: at
// most the 11 of SOFA TV TABLE CHAIR FRIDGE STOVE BED WARDROBE TOILET SINK
// WASHER), then the kinds its rooms want most: a recipe item scores 10 when
// it makes a room read, 3 a second piece, 1 the dressing, times its chance,
// shared over the chunks the room's cells lie in. A chunk of bedrooms and
// baths keeps its nightstands and tubs; one round a kitchen its counters.
const WEIGHT = [10, 3, 1]
// Per role: [kind, weight, tier] (tier: the earliest pass that wants it; an
// `alt` opener counts one pass later at a fifth of the weight).
const ROLE_KINDS = Object.freeze(Object.fromEntries(Object.entries(RECIPES).map(([role, recipe]) => {
  const m = new Map()
  const add = (kind, w, t) => {
    const e = m.get(kind) ?? [kind, 0, 9]
    e[1] += w
    e[2] = Math.min(e[2], t)
    m.set(kind, e)
  }
  for (const group of recipe) {
    for (const [kind, , chance, p, opts] of group) {
      add(kind, WEIGHT[p] * chance, p)
      if (opts?.alt) add(opts.alt, WEIGHT[p] * chance * 0.2, p + 1)
    }
  }
  return [role, [...m.values()]]
})))
function planKinds(map, states) {
  const score = new Map()
  for (const st of states) {
    const kinds = ROLE_KINDS[st.role]
    if (!kinds) continue
    const share = new Map()
    for (const c of st.cells) if (c.d) share.set(c.d, (share.get(c.d) ?? 0) + 1 / st.cells.length)
    for (const [d, f] of share) {
      let m = score.get(d)
      if (!m) score.set(d, (m = new Map()))
      for (const [kind, w, t] of kinds) {
        const e = m.get(kind)
        if (e) {
          e[0] += w * f
          if (t < e[1]) e[1] = t
        } else m.set(kind, [w * f, t])
      }
    }
  }
  for (const [d, m] of score) {
    const have = kindsOf(d)
    const plan = new Set(have)
    const want = [...m].filter(([k]) => !have.has(k)).sort((a, b) => a[1][1] - b[1][1] || b[1][0] - a[1][0] || a[0] - b[0])
    for (const [k] of want.slice(0, Math.max(0, KIND_CAP - have.size))) plan.add(k)
    PLAN.set(d, plan)
  }
}

// Put `kind` at rect q of cell c facing `front`. The first piece of a cell
// opens it (a free, non-door, non-lamp cell within the room's budget that
// leaves the room whole).
function put(map, st, c, kind, q, front, gap = GAP) {
  const { cy } = st.rm
  if (!inCell(q)) return false
  if (c.rects && !clearOf(c.rects, q, gap)) return false
  if (!capOk(c.d, kind)) return false
  const first = !c.rects
  if (first) {
    if (c.door || colOf(c) || st.budget <= 0 || (st.lamp && st.lamp.gx === c.gx && st.lamp.gz === c.gz) || map.lampAt(c.gx, cy, c.gz)) return false
    if (!whole(st, (c.gz - st.rm.z0) * (st.rm.x1 - st.rm.x0 + 1) + (c.gx - st.rm.x0))) return false
  }
  const lx = map.cellLocal(c.gx)
  const lz = map.cellLocal(c.gz)
  map.addFurniture(c.gx, cy, c.gz, {
    kind, x: (lx + 0.5) * CELL + (q.x0 + q.x1) / 2, z: (lz + 0.5) * CELL + (q.z0 + q.z1) / 2, w: q.x1 - q.x0, d: q.z1 - q.z0, facing: front,
  })
  noteKind(c.d, kind)
  if (first) {
    c.rects = []
    st.budget--
  }
  c.rects.push(q)
  st.placed.push({ gx: c.gx, gz: c.gz, kind })
  return true
}

// Positions along a wall for a piece of half-width h: `pref` first, then
// outward in 0.15 steps.
function sweep(h, pref) {
  const lim = IN - h
  if (lim < -E) return []
  const p = Math.max(-lim, Math.min(lim, pref))
  const out = [p]
  for (let k = 1; k <= 20; k++) {
    const a = p + k * 0.15
    const b = p - k * 0.15
    if (a <= lim + E) out.push(a)
    if (b >= -lim - E) out.push(b)
    if (a > lim && b < -lim) break
  }
  return out
}

// Try `kind` against wall `side` of cell c, at the positions of `us`.
function onWall(map, st, c, kind, side, us, gap) {
  for (const u of us) {
    const q = wallRect(kind, side, u)
    if (put(map, st, c, kind, q, WALL_TO_FRONT[side], gap)) return q
  }
  return null
}

// --- the groups ------------------------------------------------------------------------------

// Open a group: its first piece against a wall of a fresh cell (the far
// side of the room first) or, for a table, in a fresh cell's middle.
function openGroup(map, st, rnd, salt, kind, where, opts) {
  const l = st.lamp
  const far = (c) => (l ? Math.abs(c.gx - l.gx) + Math.abs(c.gz - l.gz) : 0)
  if (where === 'table') {
    const mx = (st.rm.x0 + st.rm.x1) / 2
    const mz = (st.rm.z0 + st.rm.z1) / 2
    const order = st.cells
      .filter((c) => !c.rects && !c.door)
      .map((c, i) => ({ c, k: c.walls.length * 4 + Math.abs(c.gx - mx) + Math.abs(c.gz - mz) + (rnd(salt + i) % 100) / 200 }))
      .sort((a, b) => a.k - b.k)
    for (const { c } of order) {
      const alongX = rnd(salt + 77) % 2 === 0
      for (const ax of [alongX, !alongX]) {
        const q = freeRect(kind, 0, 0, ax)
        if (put(map, st, c, kind, q, ax ? 0 : 2)) return { c, side: null, first: q, last: q, alongX: ax }
      }
    }
    return null
  }
  // The room's wall spots, far side first, in its dice order (drawn once).
  if (!st.spots) {
    st.spots = []
    st.cells.forEach((c, i) => {
      if (c.door) return
      for (const s of c.walls) st.spots.push({ c, side: s, k: (rnd(i * 4 + SIDES.indexOf(s)) % 1000) - 400 * far(c) })
    })
    st.spots.sort((a, b) => a.k - b.k)
  }
  const [w] = dimsOf(kind)
  const lim = Math.max(0, IN - w / 2)
  for (const { c, side } of st.spots) {
    if (c.rects) continue
    // Off centre away from a wall at right angles (the room the shift
    // leaves is beside that wall, for a 'side' piece), else by the dice.
    const lo = ALONG_X[side] ? 'W' : 'N'
    const hi = ALONG_X[side] ? 'E' : 'S'
    const sign = c.walls.includes(lo) !== c.walls.includes(hi) ? (c.walls.includes(lo) ? 1 : -1) : rnd(salt + 91 + c.gx * 7 + c.gz) % 2 ? 1 : -1
    // 'snug': centred while the room has a second cell to give (the bed
    // between its nightstands), else off centre (the wardrobe beside it): a
    // 2×2 room with two doors has one cell for furniture.
    const off = opts?.u === 'off' || (opts?.u === 'snug' && (st.budget < 2 || (st.doors.length >= 2 && st.cells.length <= 4)))
    const pref = opts?.u === 'end' ? sign * lim : off ? sign * Math.min(lim, 0.6) : 0
    const q = onWall(map, st, c, kind, side, sweep(w / 2, pref), GAP)
    if (q) return { c, side, first: q, last: q }
  }
  return null
}

// A piece joining group g.
function joinGroup(map, st, g, kind, where, opts) {
  const { c, side } = g
  const gap = opts?.tight ? TIGHT : GAP
  const [w, d] = dimsOf(kind)
  if (where === 'beside') {
    if (!side) return null
    // Next to the last piece on the wall (on the side away from the
    // first), then next to the first, then anywhere along the wall.
    const us = []
    const u0 = uOf(g.first, side)
    for (const q of g.last === g.first ? [g.first] : [g.last, g.first]) {
      const u = uOf(q, side)
      const step = halfAlong(q, side) + gap + w / 2
      us.push(...(Math.abs(u + step - u0) >= Math.abs(u - step - u0) ? [u + step, u - step] : [u - step, u + step]))
    }
    const q = onWall(map, st, c, kind, side, [...us, ...sweep(w / 2, 0)], gap)
    if (q) g.last = q
    return q
  }
  if (where === 'side') {
    // A wall at right angles, the end away from the group's wall first.
    const across = side ? (ALONG_X[side] ? ['W', 'E'] : ['N', 'S']) : SIDES
    for (const s of across) {
      if (!c.walls.includes(s)) continue
      const away = side === 'N' || side === 'W' ? 1 : -1
      const q = onWall(map, st, c, kind, s, sweep(w / 2, away * IN), gap)
      if (q) return q
    }
    return null
  }
  if (where === 'facing') {
    if (!side) return null
    const opp = OPPOSITE[side]
    return onWall(map, st, c, kind, opp, sweep(w / 2, uOf(g.first, side)), gap)
  }
  if (where === 'front') {
    if (!side) return null
    // In front of the first piece, facing it.
    const f = g.first
    const u = uOf(f, side)
    const out = d / 2 + gap
    const [x, z] = side === 'N' ? [u, f.z1 + out] : side === 'S' ? [u, f.z0 - out] : side === 'W' ? [f.x1 + out, u] : [f.x0 - out, u]
    const q = freeRect(kind, x, z, ALONG_X[side])
    return put(map, st, c, kind, q, WALL_TO_FRONT[opp(side)], gap) ? q : null
  }
  if (where === 'chairs') {
    // Up to n chairs along the table's long sides, facing it.
    const t = g.first
    const n = opts?.n ?? 4
    const half = (w + 0.1) / 2
    const reach = (g.alongX ? t.z1 - t.z0 : t.x1 - t.x0) / 2 + 0.02 + d / 2
    const seats = n >= 4
      ? [[-half, -1], [half, -1], [-half, 1], [half, 1]]
      : [[0, -1], [0, 1]]
    let k = 0
    for (const [a, s] of seats) {
      const [x, z] = g.alongX ? [a, s * reach] : [s * reach, a]
      const q = freeRect(kind, x, z, true)
      // A chair faces the table: north of it faces S, and so on.
      const front = g.alongX ? (s < 0 ? 0 : 1) : s < 0 ? 2 : 3
      if (put(map, st, c, kind, q, front, 0.01)) k++
    }
    return k ? t : null
  }
  return null
}
const opp = (s) => OPPOSITE[s]

// Furnish the rooms of one storey (records with .house = the plan role):
// pass 0 the pieces that make each room read, pass 1 the second ones,
// pass 2 the dressing.
export function furnishHouseRooms(map, list, r) {
  const states = list.map(({ rec, role, skip = null }) => {
    const st = roomState(map, rec)
    st.role = role
    st.skip = skip
    st.lamp = lampCellOf(st)
    // A third of the room (its door cells count) stays floor.
    const open = st.cells.filter((c) => !c.door && !(c.gx === st.lamp.gx && c.gz === st.lamp.gz)).length
    st.budget = Math.min(open, st.cells.length - Math.ceil(st.cells.length / 3))
    return st
  })
  planKinds(map, states)
  for (const pass of [P0, P1, P2]) {
    for (const st of states) {
      const recipe = RECIPES[st.role]
      if (!recipe) continue
      const rnd = (k) => r(st.rm.x0 * 64 + st.rm.z0 + 4096 * st.rm.cy, 0x3000 + k)
      recipe.forEach((group, gi) => {
        group.forEach(([kind, where, chance, p, opts], ii) => {
          if (p !== pass || st.skip?.has(kind)) return
          const salt = 100 + gi * 37 + ii * 11
          if (ii === 0) {
            if (st.groups[gi] !== undefined) return
            // opts.alt: the opener when the room has `kind` already (a
            // chest of drawers when the wardrobe stands by the bed).
            const k = opts?.alt && st.placed.some((q) => q.kind === kind) ? opts.alt : kind
            st.groups[gi] = (rnd(salt) % 1000) / 1000 < chance ? openGroup(map, st, rnd, salt, k, where, opts) : null
            return
          }
          const g = st.groups[gi]
          if (!g) return
          if ((rnd(salt + 5) % 1000) / 1000 >= chance) return
          joinGroup(map, st, g, kind, where, opts)
        })
      })
    }
  }
  return states
}

// A hall clock against the far wall of a hallway's dead end (the P.T.
// loop's clock, the house's own): `cells` are { gx, gz, wall } candidates.
export function placeClock(map, cy, c) {
  const cell = map.cellAt(c.gx, cy, c.gz)
  if (cell.col || !capOk(cell.chunk, PROP_HALL_CLOCK)) return false
  addPiece(map, cy, { gx: c.gx, gz: c.gz, kind: PROP_HALL_CLOCK, front: WALL_TO_FRONT[c.wall], wall: c.wall })
  return true
}
