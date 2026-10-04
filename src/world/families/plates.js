import { CHUNK, cIdx, hIdx, vIdx } from '../constants.js'
import { CELL_CORRIDOR, CELL_LOBBY, CELL_ROOM, PASSAGE_DOOR, WALL_PLAIN } from '../mapTypes.js'
import { MAP_FAMILY_TERMINAL, MAP_FAMILY_TRAIN } from './ids.js'
import { trainPlates } from './train/plates.js'

// Family-declared plates (spec §5.1 dressing; Phase I). The office dressing
// draws a storey's LEVEL plate only at a stair end (notices.js levelFaces),
// so a liminal family whose signage is data (car numbers, station names,
// gate numbers, a lying board) declares the plate faces it wants drawn. The
// dressing hook (objects/dressing/index.js) feeds each descriptor to
// notices.js pushPlate after the office layer.
//
// Descriptor (chunk-local; see train/plates.js): { sign, axis, line, cell,
// side, y, w, h, base, number } — atlas sign id, wall axis ('v' | 'h'),
// wall line and cell along it (cells), face side (+1 the +x/+z room), centre
// height, width, height, standoff from the wall plane (metres), the printed
// text. An optional `pick` groups alternative faces: the hook draws the
// first of a group whose box is clear of everything the office layer
// already emitted, and none when every one is taken.
//
// Legacy families (and every family not registered here) get EMPTY, so the
// legacy dressing — and its snapshot — is untouched.

const EMPTY = Object.freeze([])

// --- Label plates ---------------------------------------------------------------
// A chunk that carries an authored level label (data.levelLabel: a gate
// code, an impossible floor) but no stair end shows it once, on a plain wall
// face looking into a lobby (else a room, else a corridor: an open hall
// chunk whose only walls line a passage through it), nearest the chunk's
// middle — the
// cadence the lattice keeps along its cores, one plate per chunk here. The
// plate is the storey's LEVEL plate at the stair-end plate's height and
// size (edges.js), so it reads as the same sign family.
export const LABEL_PLATE = Object.freeze({ y: 1.75, w: 0.6, h: 0.2 })
const LABEL_CANDIDATES = 6

function labelFace(data, plan, vertical, line, cell, side) {
  if (line <= 0 || line >= CHUNK || cell < 0 || cell >= CHUNK) return 0
  const i = vertical ? vIdx(line, cell) : hIdx(cell, line)
  if ((vertical ? data.wallV[i] : data.wallH[i]) !== 1) return 0
  if ((vertical ? data.wallFeatureV[i] : data.wallFeatureH[i]) !== WALL_PLAIN) return 0
  const door = (c) => c >= 0 && c < CHUNK && (vertical ? data.passageV[vIdx(line, c)] : data.passageH[hIdx(c, line)]) === PASSAGE_DOOR
  if (door(cell - 1) || door(cell + 1)) return 0
  const lx = vertical ? line + (side > 0 ? 0 : -1) : cell
  const lz = vertical ? cell : line + (side > 0 ? 0 : -1)
  if (plan?.inFlight?.(lx, lz) || data.hasFloorHole(lx, lz)) return 0
  if (data.furniture.some((f) => f.lx === lx && f.lz === lz)) return 0
  const kind = data.cellKind[cIdx(lx, lz)]
  return kind === CELL_LOBBY ? 3 : kind === CELL_ROOM ? 2 : kind === CELL_CORRIDOR ? 1 : 0
}

export function labelPlates(data, plan) {
  const label = data?.levelLabel
  if (label === null || label === undefined || label === '') return EMPTY
  if (!plan || plan.levelFaces?.size) return EMPTY // the stair end already names it
  const faces = []
  const mid = (CHUNK - 1) / 2
  for (const vertical of [true, false]) {
    for (let line = 1; line < CHUNK; line++) {
      for (let cell = 0; cell < CHUNK; cell++) {
        for (const side of [-1, 1]) {
          const rank = labelFace(data, plan, vertical, line, cell, side)
          if (!rank) continue
          const lx = vertical ? line + (side > 0 ? 0.5 : -0.5) : cell + 0.5
          const lz = vertical ? cell + 0.5 : line + (side > 0 ? 0.5 : -0.5)
          const dist = Math.abs(lx - 0.5 - mid) + Math.abs(lz - 0.5 - mid)
          faces.push({ rank, dist, axis: vertical ? 'v' : 'h', line, cell, side })
        }
      }
    }
  }
  if (!faces.length) return EMPTY
  // Lobby faces first, then room, then corridor; nearest the middle within
  // a rank; ties in scan order (stable).
  faces.sort((a, b) => b.rank - a.rank || a.dist - b.dist)
  const { y, w, h } = LABEL_PLATE
  return Object.freeze(faces.slice(0, LABEL_CANDIDATES).map((f) =>
    Object.freeze({ sign: 'level', axis: f.axis, line: f.line, cell: f.cell, side: f.side, y, w, h, base: undefined, number: String(label), pick: 'label' })))
}

// --- Registry ---------------------------------------------------------------------
// trainPlates: car numbers over the gangway doors, station names on the
// platform and concourse ('nonE' at the exit station; train/plates.js).
// terminal: its gate numbers on the pier chunks without a stair top (the
// second gate plate, the outer pier chunks), the 'Err' of a board anomaly
// there, and the Arr / dEP / CLUb storey names between the stair cores.
const PLATES = Object.freeze({
  [MAP_FAMILY_TRAIN]: trainPlates,
  [MAP_FAMILY_TERMINAL]: labelPlates,
})

export function familyPlates(data, plan) {
  const fn = typeof data?.mapFamily === 'string' && Object.hasOwn(PLATES, data.mapFamily) ? PLATES[data.mapFamily] : null
  return fn ? fn(data, plan) : EMPTY
}

export const PLATE_FAMILIES = Object.freeze(Object.keys(PLATES))
