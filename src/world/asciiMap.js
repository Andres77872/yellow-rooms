import { CHUNK } from './constants.js'
import {
  CELL_ATRIUM,
  CELL_BRIDGE,
  CELL_CORRIDOR,
  CELL_LOBBY,
  CELL_ROOM,
  CELL_VOID,
  COLUMN_FURNITURE,
  COLUMN_MONUMENTAL,
  COLUMN_STANDARD,
  PASSAGE_DOOR,
  PASSAGE_WIDE,
  WALL_RAIL,
  WALL_WINDOW,
} from './mapTypes.js'
import { auditLethalVoidHalf } from './familyAudit.js'

// Headless text renderer for the thin-wall model — the CLI/test counterpart of
// the F2 world map. One floor (cy) at a time, same data contract as
// auditLayeredPatch: dataAt(cx, cy, cz) -> ChunkData | null. THREE-free like
// the rest of src/world so it runs anywhere generation does.
//
// Grid: each cell is one character with wall characters between; a patch of
// NX x NZ chunks renders as (NZ*CHUNK*2+1) rows of (NX*CHUNK*2+1) characters.
// Wall lines are resolved through the OWNING chunk (a chunk owns its West
// lx-lines and North lz-lines; the East/South boundaries belong to the next
// chunk over) — the exact seam-ownership rule the border contracts encode.
// Unknown chunks render their cells as '?' and their edges as walls.

export const ASCII_LEGEND = [
  'cells  E exit  ^ stair up (landing)  v stair down (arrival)  % stair run',
  '       X lethal void (valid)  ! lethal void (BROKEN half)  ~ hole/void  = bridge',
  '       M monumental col  # column  f furniture  * lamp lit  o lamp dead',
  '       L lobby  A atrium  , corridor  . room  (space) open  ? unknown chunk',
  "edges  | - wall  w window  r rail  d door  _ wide mouth  (space) open  + corner",
].join('\n')

function vEdgeChar(data, lx, lz) {
  if (!data) return '|'
  if (data.vAt(lx, lz)) {
    const feature = data.wallFeatureVAt(lx, lz)
    if (feature === WALL_WINDOW) return 'w'
    if (feature === WALL_RAIL) return 'r'
    return '|'
  }
  const passage = data.passageVAt(lx, lz)
  if (passage === PASSAGE_DOOR) return 'd'
  if (passage === PASSAGE_WIDE) return '_'
  return ' '
}

function hEdgeChar(data, lx, lz) {
  if (!data) return '-'
  if (data.hAt(lx, lz)) {
    const feature = data.wallFeatureHAt(lx, lz)
    if (feature === WALL_WINDOW) return 'w'
    if (feature === WALL_RAIL) return 'r'
    return '-'
  }
  const passage = data.passageHAt(lx, lz)
  if (passage === PASSAGE_DOOR) return 'd'
  if (passage === PASSAGE_WIDE) return '_'
  return ' '
}

// Stair descriptors are shared between the two layers of a slab: landing and
// run live on the LOWER layer, exit on the UPPER. On this floor an up-stair
// shows its landing (departure) and an owned down-stair its exit (arrival);
// run cells mark on both (treads below, floor holes above).
function stairMarkAt(stair, lx, lz, anchor, anchorChar) {
  if (!stair) return null
  if (anchor && anchor.lx === lx && anchor.lz === lz) return anchorChar
  if (stair.run?.some((cell) => cell.lx === lx && cell.lz === lz)) return '%'
  return null
}

// The lethal halves are validated ONCE per chunk (auditLethalVoidHalf), not
// per cell: the per-cell adapter path re-validates the whole descriptor on
// every call. 'X' means this FLOOR drops to a death plane (down half only —
// an up half is a hole in the ceiling and does not change this floor's
// walkability); a broken half in either direction reads as '!'.
function lethalCellSets(data) {
  const valid = new Set()
  const broken = new Set()
  for (const dir of ['down', 'up']) {
    const half = dir === 'down' ? data.lethalVoidDown : data.lethalVoidUp
    if (!half) continue
    const ok = auditLethalVoidHalf(data, dir).length === 0
    if (ok && dir === 'up') continue
    if (!Array.isArray(half.cells)) continue
    const target = ok ? valid : broken
    for (const cell of half.cells) target.add(cell.lz * CHUNK + cell.lx)
  }
  return { valid, broken }
}

function cellChar(data, lx, lz, lethal) {
  if (data.exit && data.exit.lx === lx && data.exit.lz === lz) return 'E'
  const up = stairMarkAt(data.stairUp, lx, lz, data.stairUp?.landing, '^')
  if (up) return up
  const down = stairMarkAt(data.stairDown, lx, lz, data.stairDown?.exit, 'v')
  if (down) return down
  const i = lz * CHUNK + lx
  if (lethal.broken.has(i)) return '!'
  if (lethal.valid.has(i)) return 'X'
  const kind = data.cellKind[i]
  if (kind === CELL_VOID || data.hasFloorHole(lx, lz)) return '~'
  if (kind === CELL_BRIDGE) return '='
  const col = data.colAt(lx, lz)
  if (col === COLUMN_MONUMENTAL) return 'M'
  if (col === COLUMN_STANDARD) return '#'
  if (col === COLUMN_FURNITURE) return 'f'
  const lamp = data.lamps.find((l) => l.lx === lx && l.lz === lz)
  if (lamp) return lamp.lit ? '*' : 'o'
  if (kind === CELL_LOBBY) return 'L'
  if (kind === CELL_ATRIUM) return 'A'
  if (kind === CELL_CORRIDOR) return ','
  if (kind === CELL_ROOM) return '.'
  return ' '
}

// Render NX x NZ chunks of floor Y0 starting at chunk (X0, Z0).
// opts: { legend: false, ruler: true }
export function renderAsciiPatch(dataAt, X0, Y0, Z0, NX, NZ, opts = {}) {
  const { legend = false, ruler = true } = opts
  const cols = NX * CHUNK * 2 + 1
  const rows = NZ * CHUNK * 2 + 1
  const grid = Array.from({ length: rows }, () => new Array(cols).fill(' '))

  const chunkAt = new Map()
  const keyOf = (cx, cz) => `${cx},${cz}`
  const lookup = (cx, cz) => {
    const key = keyOf(cx, cz)
    if (!chunkAt.has(key)) chunkAt.set(key, dataAt(cx, Y0, cz) ?? null)
    return chunkAt.get(key)
  }

  for (let ncz = 0; ncz < NZ; ncz++) {
    for (let ncx = 0; ncx < NX; ncx++) {
      const data = lookup(X0 + ncx, Z0 + ncz)
      const ox = ncx * CHUNK * 2 // grid col of this chunk's west corner line
      const oz = ncz * CHUNK * 2 // grid row of this chunk's north corner line
      const lethal = data ? lethalCellSets(data) : null

      for (let lz = 0; lz < CHUNK; lz++) {
        for (let lx = 0; lx < CHUNK; lx++) {
          const r = oz + lz * 2 + 1
          const c = ox + lx * 2 + 1
          grid[r][c] = data ? cellChar(data, lx, lz, lethal) : '?'
          grid[r][c - 1] = vEdgeChar(data, lx, lz) // owned West line
          grid[r - 1][c] = hEdgeChar(data, lx, lz) // owned North line
          grid[r - 1][c - 1] = '+'
        }
      }
    }
  }

  // East/South boundary lines of the patch are owned by chunks OUTSIDE it —
  // resolve them through dataAt too; unknown stays walled.
  for (let ncz = 0; ncz < NZ; ncz++) {
    const east = lookup(X0 + NX, Z0 + ncz)
    for (let lz = 0; lz < CHUNK; lz++) {
      const r = ncz * CHUNK * 2 + lz * 2 + 1
      grid[r][cols - 1] = vEdgeChar(east, 0, lz)
      grid[r - 1][cols - 1] = '+'
    }
  }
  for (let ncx = 0; ncx < NX; ncx++) {
    const south = lookup(X0 + ncx, Z0 + NZ)
    for (let lx = 0; lx < CHUNK; lx++) {
      const c = ncx * CHUNK * 2 + lx * 2 + 1
      grid[rows - 1][c] = hEdgeChar(south, lx, 0)
      grid[rows - 1][c - 1] = '+'
    }
  }
  grid[rows - 1][cols - 1] = '+'

  const lines = []
  const margin = ruler ? 7 : 0
  if (ruler) {
    const head = new Array(margin + cols).fill(' ')
    for (let ncx = 0; ncx < NX; ncx++) {
      const label = `cx ${X0 + ncx}`
      const at = margin + ncx * CHUNK * 2
      for (let k = 0; k < label.length && at + k < head.length; k++) {
        head[at + k] = label[k]
      }
    }
    lines.push(head.join('').replace(/\s+$/, ''))
  }
  for (let r = 0; r < rows; r++) {
    let left = ''
    if (ruler) {
      const isChunkLine = r % (CHUNK * 2) === 0 && r < rows - 1
      left = isChunkLine ? `cz ${Z0 + r / (CHUNK * 2)}`.padEnd(margin) : ' '.repeat(margin)
    }
    lines.push((left + grid[r].join('')).replace(/\s+$/, ''))
  }
  if (legend) lines.push('', ASCII_LEGEND)
  return lines.join('\n')
}

export function renderAsciiChunk(data, opts = {}) {
  const dataAt = (cx, cy, cz) =>
    cx === data.cx && cy === data.cy && cz === data.cz ? data : null
  return renderAsciiPatch(dataAt, data.cx, data.cy, data.cz, 1, 1, opts)
}
