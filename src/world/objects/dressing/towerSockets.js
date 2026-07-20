import {
  CELL,
  CHUNK,
  WALL_H,
  THICK,
  HEADER_H,
  PROP_PLATE_T,
  EXIT_SIGN_W,
  EXIT_SIGN_H,
  EXIT_SIGN_T,
  BLADE_SIGN_W,
  BLADE_SIGN_H,
  BLADE_SIGN_T,
  BLADE_SIGN_Y,
  CLOCK_SIZE,
  CLOCK_Y,
} from '../../constants.js'
import { MAP_FAMILY_TOWER } from '../../mapTypes.js'
import {
  TOWER_STRUCTURE_KIND,
  towerSocketBelongsToChunk,
} from '../../structures/tower.js'
import { PROP_TINT, SIGN_TINT } from './palette.js'

// Tower landmark-socket dressing: signage, wall clocks, and lit accents
// placed from the canonical tower structure's authored sockets.
const DOOR_H = WALL_H - HEADER_H

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

function pushTowerLitAccent(data, socket, signs) {
  const y = DOOR_H + 0.12 + EXIT_SIGN_H / 2
  pushTowerSocketBox(
    signs,
    data,
    socket,
    0,
    y,
    THICK / 2 + 0.02,
    EXIT_SIGN_W + 0.07,
    EXIT_SIGN_H + 0.06,
    0.04,
    SIGN_TINT.frame
  )
  pushTowerSocketBox(
    signs,
    data,
    socket,
    0,
    y,
    THICK / 2 + 0.04 + EXIT_SIGN_T / 2,
    EXIT_SIGN_W,
    EXIT_SIGN_H,
    EXIT_SIGN_T,
    SIGN_TINT.exit
  )
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
