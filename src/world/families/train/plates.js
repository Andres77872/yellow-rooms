import { CHUNK, EXIT_SIGN_Y, FRAME_DEPTH, THICK, cIdx, hIdx, vIdx } from '../../constants.js'
import { CELL_LOBBY, PASSAGE_DOOR, WALL_PLAIN } from '../../mapTypes.js'
import { CONC, TILE, TRAIN, carPlateOf, skeleton, stationBoards, stationPlatesOf } from './geometry.js'

// The train's plates in the runtime (spec §12.10 Labels; doc 07 §6 "LED
// panel (car number, next station)", "line map and boards: text that names
// stations; the unlisted station is the exit"). The office dressing draws a
// level plate only at a stair end, which would leave the train's signage as
// data; these are the faces the family declares instead, pure in the chunk
// (its worldSeed and coordinates, through the tile's skeleton, plus its
// walls to keep each plate on a real plain face):
//   - every car's number on an LED panel over both its gangway doors, facing
//     into the car (a lying car repeats the previous car's number);
//   - a station's name on its platforms' back walls (seen from the cars
//     through the glass and the wide doors) and on the concourse's free-side
//     wall, one of each per station chunk; the later chunks drift under a
//     stationName anomaly, the exit station's read UNLISTED.
// Descriptor (chunk-local; the dressing hunk feeds it to notices.js
// pushPlate): { sign, axis, line, cell, side, y, w, h, base, number } —
// atlas sign id, wall axis ('v' | 'h'), wall line and cell along it (cells),
// face side (+1 the +x/+z room), centre height, width, height, standoff
// from the wall plane (metres), and the printed text.
//
// Imports: constants.js, mapTypes.js and ./geometry.js only (pure, no canvas
// or kit), so a runtime registry can take it without the bake's graph.

const EMPTY = Object.freeze([])

// LED panel over a gangway door, on its header casing (the room plates'
// height and standoff, edges.js), and a station board high on a wall.
export const LED = Object.freeze({ y: EXIT_SIGN_Y, w: 0.8, h: 0.2, base: FRAME_DEPTH / 2 })
export const BOARD = Object.freeze({ y: 2.55, w: 1.2, h: 0.3, base: THICK / 2 })

// Atlas plates: a car's panel is the numbered ROOM plate, a station board
// the numbered LEVEL plate (the name a storey's stair end shows too), in
// the train's own wording: CAR, STATION (decalKinds.js SIGN_PLATES).
export const SIGN = Object.freeze({ car: 'room', station: 'level' })

const plate = (sign, axis, line, cell, side, at, number) =>
  Object.freeze({ sign, axis, line, cell, side, y: at.y, w: at.w, h: at.h, base: at.base, number })

// A board can hang on face `side` of H-wall `line` at cell lx: a real plain
// wall in this chunk, no door leaf beside it, a lobby floor in front, no
// furniture standing at it.
function boardFace(data, line, lx, side) {
  if (lx < 0 || lx >= CHUNK || line <= 0 || line >= CHUNK) return false
  const i = hIdx(lx, line)
  if (data.wallH[i] !== 1 || data.wallFeatureH[i] !== WALL_PLAIN) return false
  for (const c of [lx - 1, lx + 1]) {
    if (c >= 0 && c < CHUNK && data.passageH[hIdx(c, line)] === PASSAGE_DOOR && data.wallH[hIdx(c, line)] !== 1) return false
  }
  const lz = line + (side > 0 ? 0 : -1)
  if (data.cellKind[cIdx(lx, lz)] !== CELL_LOBBY || data.hasFloorHole(lx, lz)) return false
  return !data.furniture.some((f) => f.lx === lx && f.lz === lz)
}

// The first good face along a board line inside [lo, hi] (chunk-local),
// nearest `prefer` first.
function board(data, line, side, prefer, lo, hi, number) {
  for (let d = 0; d < CHUNK; d++) {
    for (const lx of d ? [prefer - d, prefer + d] : [prefer]) {
      if (lx < lo || lx > hi) continue
      if (boardFace(data, line, lx, side)) return plate(SIGN.station, 'h', line, lx, side, BOARD, number)
    }
  }
  return null
}

// The plates chunk `data` (a train chunk) shows.
export function trainPlates(data) {
  if (!data || data.cz !== 0) return EMPTY
  const seed = data.worldSeed >>> 0
  const { cx, cy } = data
  if (cy !== TRAIN && cy !== CONC) return EMPTY
  const tx = Math.floor(cx / TILE.w)
  const lc = cx - tx * TILE.w
  const sk = skeleton(seed, tx)
  const x0 = lc * CHUNK // tile-local x of the chunk's west line
  const out = []
  if (cy === TRAIN) {
    // Every gangway door on the chunk's own V-lines (lx 0..13): a panel
    // facing into the east car, and (lx > 0) one facing into the west car;
    // a door on the next chunk's line 0 gets its west-facing panel here.
    for (const j of sk.joints) {
      const line = j.x - x0
      if (line < 0 || line >= CHUNK) continue
      const i = vIdx(line, j.z)
      if (data.wallV[i] === 1 || data.passageV[i] !== PASSAGE_DOOR) continue
      if (line > 0) out.push(plate(SIGN.car, 'v', line, j.z, -1, LED, carPlateOf(seed, tx, j.west)))
      out.push(plate(SIGN.car, 'v', line, j.z, 1, LED, carPlateOf(seed, tx, j.east)))
    }
    const next = lc === TILE.w - 1 ? skeleton(seed, tx + 1).joints[0] : sk.joints.find((q) => q.x === x0 + CHUNK)
    if (next) {
      const west = lc === TILE.w - 1 ? sk.cars[sk.n - 1] : sk.cars[next.west]
      out.push(plate(SIGN.car, 'v', CHUNK, next.z, -1, LED, carPlateOf(seed, tx, west.j)))
    }
  }
  const names = stationPlatesOf(seed, tx, cy)
  const mine = names?.find((q) => q.chunk === lc)
  if (mine) {
    for (const b of stationBoards(sk.station, cy)) {
      const lo = Math.max(0, b.x0 - x0)
      const hi = Math.min(CHUNK - 1, b.x1 - x0)
      if (lo > hi) continue
      const p = board(data, b.line, b.side, (lo + hi) >> 1, lo, hi, mine.name)
      if (p) {
        out.push(p)
        break
      }
    }
  }
  return out.length ? Object.freeze(out) : EMPTY
}
