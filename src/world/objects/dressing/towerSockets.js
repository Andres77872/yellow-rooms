import {
  CELL,
  CHUNK,
  THICK,
  WALL_H,
  PROP_PLATE_T,
  EXIT_SIGN_H,
  EXIT_SIGN_Y,
  BLADE_SIGN_W,
  BLADE_SIGN_H,
  BLADE_SIGN_T,
  BLADE_SIGN_Y,
  CLOCK_SIZE,
  CLOCK_Y,
  hIdx,
  vIdx,
} from '../../constants.js'
import { MAP_FAMILY_TOWER, PASSAGE_DOOR, WALL_PLAIN } from '../../mapTypes.js'
import {
  TOWER_STRUCTURE_KIND,
  towerSocketBelongsToChunk,
} from '../../structures/tower.js'
import { ACCENT_CYCLE, PROP_TINT, SIGN_TINT } from './palette.js'

// Tower landmark-socket dressing: signage, wall clocks, and lit accents
// placed from the canonical tower structure's authored sockets.

// Emit one wall-hugging unit box from the canonical global socket coordinate.
// `axis` names the wall normal, while `side` chooses its authored face. The
// returned record is the existing prop/sign batch vocabulary consumed by
// mesh.js; no landmark render DTO is introduced.
function pushTowerSocketBox(
  out,
  data,
  socket,
  alongOffset,
  y,
  distanceFromPlane,
  sAlong,
  sY,
  sAcross,
  tint
) {
  const lx = socket.gx - data.cx * CHUNK
  const lz = socket.gz - data.cz * CHUNK
  const normalX = socket.axis === 'x'
  const along = ((normalX ? lz : lx) + 0.5) * CELL + alongOffset
  const line = (normalX ? lx : lz) + (socket.side > 0 ? 1 : 0)
  const across = line * CELL + socket.side * distanceFromPlane
  out.push(normalX
    ? {
        px: across,
        py: y,
        pz: along,
        sx: sAcross,
        sy: sY,
        sz: sAlong,
        tint,
      }
    : {
        px: along,
        py: y,
        pz: across,
        sx: sAlong,
        sy: sY,
        sz: sAcross,
        tint,
      })
}

function pushTowerSignage(data, socket, signs) {
  const housingDepth = BLADE_SIGN_T + 0.02
  pushTowerSocketBox(
    signs,
    data,
    socket,
    0,
    BLADE_SIGN_Y,
    THICK / 2 + housingDepth / 2,
    BLADE_SIGN_W + 0.08,
    BLADE_SIGN_H + 0.08,
    housingDepth,
    SIGN_TINT.frame
  )
  pushTowerSocketBox(
    signs,
    data,
    socket,
    0,
    BLADE_SIGN_Y,
    THICK / 2 + housingDepth + 0.006 + BLADE_SIGN_T / 2,
    BLADE_SIGN_W,
    BLADE_SIGN_H,
    BLADE_SIGN_T,
    SIGN_TINT.blade
  )
}

function pushTowerClock(data, socket, props) {
  pushTowerSocketBox(
    props,
    data,
    socket,
    0,
    CLOCK_Y,
    THICK / 2 + PROP_PLATE_T / 2,
    CLOCK_SIZE + 0.06,
    CLOCK_SIZE + 0.06,
    PROP_PLATE_T,
    PROP_TINT.clockRim
  )
  const faceDistance = THICK / 2 + PROP_PLATE_T + 0.006
  pushTowerSocketBox(
    props,
    data,
    socket,
    0,
    CLOCK_Y,
    faceDistance,
    CLOCK_SIZE,
    CLOCK_SIZE,
    0.012,
    PROP_TINT.clock
  )
  pushTowerSocketBox(
    props,
    data,
    socket,
    0,
    CLOCK_Y + 0.05,
    faceDistance + 0.012,
    0.025,
    0.16,
    0.012,
    PROP_TINT.clockRim
  )
  pushTowerSocketBox(
    props,
    data,
    socket,
    0.06,
    CLOCK_Y,
    faceDistance + 0.012,
    0.2,
    0.02,
    0.012,
    PROP_TINT.clockRim
  )
}

// The bridge-approach accent is a landmark light, not an exit sign: it
// wears the storey's accent colour — the same ACCENT_CYCLE entry the tower's
// stair-landing markers wear (tower.js), so the skybridge mouth reads as
// this floor's place — while emergency green stays with the escape route
// alone (constants.js EXIT_SIGN_*). Its band is the landing marker's band.
const ACCENT_W = 0.7
const ACCENT_H = 0.14
const ACCENT_T = 0.07
const ACCENT_INSET = 0.3 // hung accent plane, metres in from the opening

function pushTowerLitAccent(data, socket, signs) {
  const lx = socket.gx - data.cx * CHUNK
  const lz = socket.gz - data.cz * CHUNK
  const vertical = socket.axis === 'x' // the wall normal runs along x: a 'v' line
  const line = (vertical ? lx : lz) + (socket.side > 0 ? 1 : 0)
  const cell = vertical ? lz : lx
  // The far seam line is the neighbour's: its wall bytes are not this
  // chunk's to read, so no accent is guessed onto it.
  if (line >= CHUNK) return
  const accent = ACCENT_CYCLE[((data.cy % ACCENT_CYCLE.length) + ACCENT_CYCLE.length) % ACCENT_CYCLE.length]
  const i = vertical ? vIdx(line, cell) : hIdx(cell, line)
  const wall = vertical ? data.wallV[i] : data.wallH[i]
  const feature = vertical ? data.wallFeatureV[i] : data.wallFeatureH[i]
  const door = (vertical ? data.passageV[i] : data.passageH[i]) === PASSAGE_DOOR
  // The header-sign height, clear of a door's head cap. On a door header the
  // band rides above the exit sign's housing instead: the header's lower
  // band is where the escape route hangs its sign, should this door be one.
  const y = door ? EXIT_SIGN_Y + (EXIT_SIGN_H + 0.06) / 2 + 0.02 + (ACCENT_H + 0.06) / 2 : EXIT_SIGN_Y

  // A plain wall or a door's header casing behind it: the accent mounts flat
  // on the authored face, a dark housing with the glowing band proud of it.
  if ((wall === 1 && feature === WALL_PLAIN) || door) {
    pushTowerSocketBox(
      signs,
      data,
      socket,
      0,
      y,
      THICK / 2 + 0.02,
      ACCENT_W + 0.07,
      ACCENT_H + 0.06,
      0.04,
      SIGN_TINT.frame
    )
    pushTowerSocketBox(
      signs,
      data,
      socket,
      0,
      y,
      THICK / 2 + 0.04 + ACCENT_T / 2,
      ACCENT_W,
      ACCENT_H,
      ACCENT_T,
      accent
    )
    return
  }

  // An open mouth (the wide bridge approach, a guard rail) has nothing
  // behind it, so the accent hangs from the ceiling just in from the
  // opening, as the stair mouths' exit signs do (edges.js dressStairExits):
  // housing, the band glowing on both sides, two hanger rods. It hangs on
  // the authored face's side, under the ceiling the approach keeps — the
  // bridge side is open to the void above — else on the other side; with no
  // ceiling either side within the chunk it stays dark rather than float.
  const ceiled = (s) => {
    const k = line + (s > 0 ? 0 : -1)
    return k >= 0 && k < CHUNK && !(vertical ? data.hasCeilHole(k, cell) : data.hasCeilHole(cell, k))
  }
  const s = ceiled(socket.side) ? socket.side : ceiled(-socket.side) ? -socket.side : 0
  if (!s) return
  const across = line * CELL + s * ACCENT_INSET
  const centre = (cell + 0.5) * CELL
  const hang = (ou, py, su, sy, st, tint) =>
    signs.push(vertical
      ? { px: across, py, pz: centre + ou, sx: st, sy, sz: su, tint }
      : { px: centre + ou, py, pz: across, sx: su, sy, sz: st, tint })
  hang(0, y, ACCENT_W + 0.07, ACCENT_H + 0.06, 0.05, SIGN_TINT.frame)
  hang(0, y, ACCENT_W, ACCENT_H, ACCENT_T, accent)
  const top = y + (ACCENT_H + 0.06) / 2
  for (const rod of [-1, 1]) hang(rod * (ACCENT_W / 2 - 0.08), (top + WALL_H) / 2, 0.03, WALL_H - top, 0.03, SIGN_TINT.frame)
}

export function dressTowerLandmarkSockets(data, props, signs) {
  const structure = data.structure
  if (
    data.mapFamily !== MAP_FAMILY_TOWER ||
    structure?.family !== MAP_FAMILY_TOWER ||
    structure.kind !== TOWER_STRUCTURE_KIND ||
    !Array.isArray(structure.landmarkSockets)
  ) return

  // Preserve canonical authored-template order. Door and fixture sockets emit
  // no parallel prop records: their existing PASSAGE_DOOR and data.lamps
  // placements are rendered by the established doorway and fixture paths.
  for (const socket of structure.landmarkSockets) {
    if (
      !towerSocketBelongsToChunk(socket, data) ||
      (socket.axis !== 'x' && socket.axis !== 'z') ||
      (socket.side !== -1 && socket.side !== 1)
    ) continue
    if (socket.kind === 'signage') pushTowerSignage(data, socket, signs)
    else if (socket.kind === 'clock') pushTowerClock(data, socket, props)
    else if (socket.kind === 'litAccent') pushTowerLitAccent(data, socket, signs)
  }
}
