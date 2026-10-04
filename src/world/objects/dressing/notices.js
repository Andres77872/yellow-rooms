import { CHUNK, THICK, cIdx, hIdx, vIdx } from '../../constants.js'
import { hash2i } from '../../core/hash.js'
import { DOOR_EGRESS, edgeCells, edgeContext } from '../../doorFunction.js'
import { CELL_ATRIUM, CELL_LOBBY, CELL_STAIR, CELL_VOID, PASSAGE_DOOR, WALL_PLAIN } from '../../mapTypes.js'
import { roomContext, worldSurfaceSet } from '../../surfaceSet.js'
import { PROP_TINT } from './palette.js'

// Shared signage helpers for every family's dressing layer: printed plates
// on wall faces, raised numerals on numbered plates, and the chunk's
// signage plan — the context a sign is chosen from (which room a face looks
// into, where the stairs and fire doors are), resolved once per chunk.

// Wear past which a space reads as derelict (surfaceSet.js decay field):
// signs have come down, notes nobody should have left go up.
export const DERELICT = 0.8

// One printed plate on a wall face, in the decal descriptor format every
// family's dressing emits: atlas cell `cellIndex` on face `side` (+1 = the
// +x / +z room) of the wall plane at `plane` (metres along the wall's normal
// axis), centred `along` the wall.
// `base` is how far off the plane the plate's back sits (the wall face by
// default). A numbered plate (decalKinds.js SIGN_PLATES) gets its `number`
// set in raised numerals into `props`, and the record carries the number.
export function pushPlate(decals, props, vertical, plane, side, along, y, w, h, cellIndex, { t = 0.012, base = THICK / 2, shade = 1, rough = 0.6, number = null } = {}) {
  const across = plane + side * (base + t / 2)
  const record = vertical
    ? { px: across, py: y, pz: along, sx: t, sy: h, sz: w, cell: cellIndex, shade, rough }
    : { px: along, py: y, pz: across, sx: w, sy: h, sz: t, cell: cellIndex, shade, rough }
  if (number !== null) {
    record.number = number
    if (props) pushNumerals(props, vertical, plane + side * (base + t), side, along, y, w, h, number)
  }
  decals.push(record)
}

// --- Numerals -----------------------------------------------------------------
// Seven-segment glyphs; 'b' prefixes a basement storey. The letters a
// seven-segment display can spell carry authored level labels (data.levelLabel:
// gate codes, foreign or impossible floors); a space is a blank digit.
export const NUMERAL_GLYPHS = Object.freeze({
  0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg',
  b: 'cdefg',
  '-': 'g',
  A: 'abcefg', C: 'adef', E: 'adefg', F: 'aefg', H: 'bcefg', L: 'def', P: 'abefg', U: 'bcdef',
  d: 'bcdeg', r: 'eg', n: 'ceg', o: 'cdeg', t: 'defg', y: 'bcdfg',
  ' ': '',
})

// Raised numerals over the number field of a numbered plate: the right part
// of the plate as the viewer reads it, whichever face it hangs on. `front`
// is the plate's front plane. Each stroke is flagged `numeral`: it stands on
// its printed plate, so a mesh build that draws no plates (no decal
// material) draws no numerals either.
function pushNumerals(props, vertical, front, side, along, y, w, h, text) {
  const right = vertical ? -side : side // +along direction of the viewer's right
  const gh = h * 0.5
  const pitch = Math.min(gh * 0.72, (w * 0.36) / text.length)
  const gw = pitch * 0.72
  const st = gh * 0.15
  // [u0, u1, v0, v1]: across the glyph (viewer's left to right) and up it.
  const seg = {
    a: [-gw / 2, gw / 2, gh - st, gh],
    b: [gw / 2 - st, gw / 2, gh / 2, gh],
    c: [gw / 2 - st, gw / 2, 0, gh / 2],
    d: [-gw / 2, gw / 2, 0, st],
    e: [-gw / 2, -gw / 2 + st, 0, gh / 2],
    f: [-gw / 2, -gw / 2 + st, gh / 2, gh],
    g: [-gw / 2, gw / 2, gh / 2 - st / 2, gh / 2 + st / 2],
  }
  const depth = 0.006
  const across = front + side * (depth / 2)
  const centre = along + right * w * 0.255
  for (let i = 0; i < text.length; i++) {
    const u = (i - (text.length - 1) / 2) * pitch
    for (const name of NUMERAL_GLYPHS[text[i]] ?? '') {
      const [u0, u1, v0, v1] = seg[name]
      const a = centre + right * (u + (u0 + u1) / 2)
      const py = y - gh / 2 + (v0 + v1) / 2
      props.push(vertical
        ? { px: across, py, pz: a, sx: depth, sy: v1 - v0, sz: u1 - u0, tint: PROP_TINT.signInk, numeral: true }
        : { px: a, py, pz: across, sx: u1 - u0, sy: v1 - v0, sz: depth, tint: PROP_TINT.signInk, numeral: true })
    }
  }
}

// Storey number as a building numbers it: ground floor 1, basements b1, b2…
export function storeyNumber(cy) {
  return cy >= 0 ? String(cy + 1) : `b${-cy}`
}

// A door's number, as a building numbers its rooms: by where the door opens,
// the convention of the hotel's guest doors (doorSchedule.js) — the storey,
// the corridor's band, then an index that climbs along the corridor, odd on
// the right hand walking toward +z (v doors) or +x (h doors), even on the
// left. Everything counts from GLOBAL coordinates, so a number is stable
// across seams: the index runs NUMBER_RUN cells (100 numbers, both hands)
// before it repeats, and corridors NUMBER_BAND cells apart or more across it
// take different band digits — 1-5 for corridors running along z, 6-9 along
// x, so the two never share one — repeating only 12-15 corridor rows on.
// A room with doors on two corridor bays shows each bay's number.
const NUMBER_RUN = 50
const NUMBER_BAND = 3
const NUMBER_BANDS_V = 5
const NUMBER_BANDS_H = 4
export function doorNumber(data, axis, line, cell, roomSide) {
  const v = axis === 'v'
  const wrap = (g, n) => ((g % n) + n) % n
  const along = wrap((v ? data.cz : data.cx) * CHUNK + cell, NUMBER_RUN)
  // The corridor row: the cell on the far side of the line from the room.
  const row = (v ? data.cx : data.cz) * CHUNK + line - (roomSide > 0 ? 1 : 0)
  const odd = v ? roomSide < 0 : roomSide > 0
  const index = (2 * along + (odd ? 1 : 2)) % 100
  const band = v ? 1 + wrap(Math.floor(row / NUMBER_BAND), NUMBER_BANDS_V) : 1 + NUMBER_BANDS_V + wrap(Math.floor(row / NUMBER_BAND), NUMBER_BANDS_H)
  return `${storeyNumber(data.cy | 0)}${band}${String(index).padStart(2, '0')}`
}

// --- Signage plan -------------------------------------------------------------

const near = (cells, lx, lz, r) => cells.some((c) => Math.max(Math.abs(c.lx - lx), Math.abs(c.lz - lz)) <= r)

// Faces that look into cell (lx, lz) from its four walls, in a fixed order;
// lines on the far chunk seam (14) belong to the neighbour and are skipped.
function cellFaces(lx, lz) {
  const out = [
    ['h', lz, lx, 1],
    ['v', lx + 1, lz, -1],
    ['h', lz + 1, lx, -1],
    ['v', lx, lz, 1],
  ]
  return out.filter(([, line]) => line < CHUNK)
}

export const faceKey = (axis, line, cell, side) => `${axis}${line},${cell},${side}`

const inChunk = (lx, lz) => lx >= 0 && lx < CHUNK && lz >= 0 && lz < CHUNK

// Is the edge between in-chunk cell (lx, lz) and its neighbour one step
// (dx, dz) away open to walk through (no wall; a doorway counts as open)?
export function openStep(data, lx, lz, dx, dz) {
  const x = lx + dx
  const z = lz + dz
  if (!inChunk(x, z)) return false
  return dx ? data.wallV[vIdx(Math.max(lx, x), lz)] !== 1 : data.wallH[hIdx(lx, Math.max(lz, z))] !== 1
}

// Everything the dressing needs to choose signs by meaning, from the chunk's
// own data (never a neighbour's): the room context behind each cell, the
// stair ends the escape route leaves the storey by, the fire doors that
// carry exit signs, the walking route from every cell to its nearest stair
// end, and the wall face beside each stair end that carries the storey's
// LEVEL plate.
export function signagePlan(data, set = worldSurfaceSet(data.mapFamily, data.worldSeed)) {
  const contexts = new Array(CHUNK * CHUNK)
  const ctxAt = (lx, lz) => (contexts[cIdx(lx, lz)] ??= roomContext(data, lx, lz, set))

  // Stair ends: the landing of the up stair and the exit of the down stair,
  // each with the step (dx, dz) from it into its flight. Without a stair
  // half of its own the chunk falls back to any stair cell.
  const stairs = []
  const flightStep = (end, run) => {
    const next = (run ?? []).find((c) => Math.abs(c.lx - end.lx) + Math.abs(c.lz - end.lz) === 1)
    return next ? { dx: next.lx - end.lx, dz: next.lz - end.lz } : null
  }
  if (data.stairUp?.landing) {
    const { lx, lz } = data.stairUp.landing
    stairs.push({ lx, lz, up: true, flight: flightStep(data.stairUp.landing, data.stairUp.run) })
  }
  if (data.stairDown?.exit) {
    const { lx, lz } = data.stairDown.exit
    stairs.push({ lx, lz, up: false, flight: flightStep(data.stairDown.exit, data.stairDown.run) })
  }
  const stairCells = [...stairs]
  for (let lz = 0; lz < CHUNK; lz++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      if (data.cellKind[cIdx(lx, lz)] === CELL_STAIR) stairCells.push({ lx, lz, up: null })
    }
  }
  const stairEnds = stairs.filter((s) => inChunk(s.lx, s.lz))
  if (!stairs.length) stairs.push(...stairCells)

  // The up stair's flight fills its cells with steps to the ceiling: nothing
  // mounts on the walls beside it (a plate there would sit inside the steps).
  const flight = new Set((data.stairUp?.run ?? []).filter((c) => inChunk(c.lx, c.lz)).map((c) => cIdx(c.lx, c.lz)))
  const inFlight = (lx, lz) => flight.has(cIdx(lx, lz))

  // Door classes (doorFunction.js), resolved once per doorway, and which of
  // them hang exit signs. A district portal is lit: both of its sides are
  // routed corridor. Any other seam door the chunk only half sees, classed
  // egress for its in-chunk lobby, is left dark: a room can open onto a
  // lobby — the stair-end signs carry the escape route there instead.
  const doors = new Map()
  const lit = new Set()
  const egress = []
  for (const axis of ['v', 'h']) {
    const vertical = axis === 'v'
    for (let line = 0; line < CHUNK; line++) {
      for (let cell = 0; cell < CHUNK; cell++) {
        const i = vertical ? vIdx(line, cell) : hIdx(cell, line)
        const wall = vertical ? data.wallV[i] : data.wallH[i]
        const passage = vertical ? data.passageV[i] : data.passageH[i]
        if (wall === 1 || passage !== PASSAGE_DOOR) continue
        const key = faceKey(axis, line, cell, 0)
        const ctx = edgeContext(data, axis, line, cell, set)
        doors.set(key, ctx)
        if (ctx.fn !== DOOR_EGRESS) continue
        if (ctx.partial && !ctx.portal) {
          const { lo, hi } = edgeCells(axis, line, cell)
          const own = lo ?? hi
          if (data.cellKind[cIdx(own.lx, own.lz)] === CELL_LOBBY) continue
        }
        lit.add(key)
        egress.push(vertical ? { lx: line, lz: cell } : { lx: cell, lz: line })
        egress.push(vertical ? { lx: line - 1, lz: cell } : { lx: cell, lz: line - 1 })
      }
    }
  }

  // Walking route: steps from every cell to its nearest stair end through
  // open edges (never over a slab opening or up the flight), and which end.
  // Arrows follow the route, not the bee-line through a wall.
  const route = new Int16Array(CHUNK * CHUNK).fill(-1)
  const routeEnd = new Array(CHUNK * CHUNK).fill(null)
  const walkable = (lx, lz) => {
    const k = data.cellKind[cIdx(lx, lz)]
    return k !== CELL_ATRIUM && k !== CELL_VOID && !data.hasFloorHole(lx, lz) && !inFlight(lx, lz)
  }
  const queue = []
  for (const s of stairs) {
    if (!inChunk(s.lx, s.lz) || route[cIdx(s.lx, s.lz)] === 0) continue
    route[cIdx(s.lx, s.lz)] = 0
    routeEnd[cIdx(s.lx, s.lz)] = s
    queue.push(s.lx, s.lz)
  }
  for (let q = 0; q < queue.length; q += 2) {
    const lx = queue[q]
    const lz = queue[q + 1]
    const i = cIdx(lx, lz)
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = lx + dx
      const z = lz + dz
      if (!openStep(data, lx, lz, dx, dz) || route[cIdx(x, z)] >= 0 || !walkable(x, z)) continue
      route[cIdx(x, z)] = route[i] + 1
      routeEnd[cIdx(x, z)] = routeEnd[i]
      queue.push(x, z)
    }
  }

  // LEVEL plates: the first plain, door-free wall face of each stair end,
  // so arriving on a storey names it.
  const isDoor = (axis, line, c) => c >= 0 && c < CHUNK &&
    (axis === 'v' ? data.passageV[vIdx(line, c)] : data.passageH[hIdx(c, line)]) === PASSAGE_DOOR
  const plainFace = ([axis, line, cell]) => {
    const i = axis === 'v' ? vIdx(line, cell) : hIdx(cell, line)
    const wall = axis === 'v' ? data.wallV[i] : data.wallH[i]
    const feature = axis === 'v' ? data.wallFeatureV[i] : data.wallFeatureH[i]
    return wall === 1 && feature === WALL_PLAIN && !isDoor(axis, line, cell - 1) && !isDoor(axis, line, cell + 1)
  }
  const levelFaces = new Set()
  for (const end of stairEnds) {
    if (data.hasFloorHole(end.lx, end.lz)) continue
    const face = cellFaces(end.lx, end.lz).find(plainFace)
    if (face) levelFaces.add(faceKey(...face))
  }

  return {
    set,
    ctxAt,
    stairs,
    stairEnds,
    levelFaces,
    inFlight,
    memo: new Map(),
    door: (axis, line, cell) => doors.get(faceKey(axis, line, cell, 0)) ?? edgeContext(data, axis, line, cell, set),
    exitLit: (axis, line, cell) => lit.has(faceKey(axis, line, cell, 0)),
    nearEgress: (lx, lz) => near(egress, lx, lz, 2),
    nearStair: (lx, lz) => near(stairCells, lx, lz, 2),
    // Steps from cell (lx, lz) to its nearest stair end (-1: no route).
    routeAt: (lx, lz) => route[cIdx(lx, lz)],
    // The arrow a face of a wall shows to a reader standing in cell
    // (lx, lz): { dir, target } — dir -1 the reader's left, +1 the right,
    // whichever step along the wall shortens the walk to the stairs — or
    // null when the route leaves the cell across the wall's normal, the
    // stair is next door, or the cell has no route.
    arrow(vertical, side, lx, lz) {
      const here = route[cIdx(lx, lz)]
      if (here < 2) return null
      let step = 0
      let best = here
      for (const s of [-1, 1]) {
        const dx = vertical ? 0 : s
        const dz = vertical ? s : 0
        if (!openStep(data, lx, lz, dx, dz)) continue
        const d = route[cIdx(lx + dx, lz + dz)]
        if (d >= 0 && d < best) {
          best = d
          step = s
        }
      }
      if (!step) return null
      const right = vertical ? -side : side
      return { dir: step * right, target: routeEnd[cIdx(lx, lz)] }
    },
  }
}

// EXIT when the stair leads toward the ground floor, STAIRS otherwise.
export function arrowLabel(cy, target) {
  if (target.up === false && cy > 0) return 'EXIT'
  if (target.up === true && cy < 0) return 'EXIT'
  return 'STAIRS'
}

// Per-face 0..1 roll.
export const faceRoll = (salt, gx, gz) => hash2i(salt | 0, gx, gz) / 4294967296

// A wall face a plate can hang on in the plate-only layers (lattice,
// sewer): a real plain wall in this chunk (a seam line beyond the chunk's
// own, CHUNK, belongs to the neighbour), not where an open door leaf lies
// flat beside a doorway, and not beside the up stair's flight.
export function plateFace(data, plan, vertical, line, cell, side) {
  if (line <= 0 && side < 0) return false
  if (line < 0 || line >= CHUNK || cell < 0 || cell >= CHUNK) return false
  const i = vertical ? vIdx(line, cell) : hIdx(cell, line)
  if ((vertical ? data.wallV[i] : data.wallH[i]) !== 1) return false
  if ((vertical ? data.wallFeatureV[i] : data.wallFeatureH[i]) !== WALL_PLAIN) return false
  const door = (c) => c >= 0 && c < CHUNK && (vertical ? data.passageV[vIdx(line, c)] : data.passageH[hIdx(c, line)]) === PASSAGE_DOOR
  if (door(cell - 1) || door(cell + 1)) return false
  const lx = vertical ? line + (side > 0 ? 0 : -1) : cell
  const lz = vertical ? cell : line + (side > 0 ? 0 : -1)
  return !plan.inFlight(lx, lz)
}
