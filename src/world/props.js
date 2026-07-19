import {
  CELL,
  CHUNK,
  WALL_H,
  THICK,
  HEADER_H,
  COL_HALF,
  MONUMENTAL_COL_HALF,
  BASEBOARD_H,
  BASEBOARD_PROUD,
  CROWN_H,
  CROWN_PROUD,
  THRESHOLD_H,
  THRESHOLD_DEPTH,
  COL_BASE_H,
  COL_BASE_WIDEN,
  COL_CAP_H,
  COL_CAP_WIDEN,
  EXIT_SIGN_CHANCE,
  EXIT_SIGN_W,
  EXIT_SIGN_H,
  EXIT_SIGN_T,
  BLADE_SIGN_CHANCE,
  BLADE_SIGN_W,
  BLADE_SIGN_H,
  BLADE_SIGN_T,
  BLADE_SIGN_Y,
  VENT_CHANCE,
  VENT_W,
  VENT_D,
  VENT_H,
  CLOCK_CHANCE,
  CLOCK_SIZE,
  CLOCK_Y,
  BOARD_CHANCE,
  BOARD_W,
  BOARD_H,
  BOARD_Y,
  PROP_PLATE_T,
  EXT_CHANCE,
  EXT_W,
  EXT_H,
  EXT_T,
  EXT_Y,
  RADIATOR_W,
  RADIATOR_H,
  RADIATOR_T,
  RADIATOR_RIBS,
  PROP_SALT,
  SIGN_SALT,
  VENT_SALT,
  vIdx,
  hIdx,
  cIdx,
} from './constants.js'
import { hash2i } from './core/hash.js'
import {
  PASSAGE_DOOR,
  PASSAGE_WIDE,
  WALL_PLAIN,
  WALL_RAIL,
  WALL_WINDOW,
  CELL_CORRIDOR,
  CELL_LOBBY,
  CELL_ROOM,
  CELL_STAIR,
  CELL_ATRIUM,
  CELL_VOID,
  CELL_BRIDGE,
  COLUMN_MONUMENTAL,
  COLUMN_FURNITURE,
  MAP_FAMILY_TOWER,
  SPACE_ROLE_BREAK,
  SPACE_ROLE_MEETING,
  SPACE_ROLE_SERVER,
} from './mapTypes.js'
import {
  TOWER_STRUCTURE_KIND,
  towerSocketBelongsToChunk,
} from './tower.js'

// Interior dressing and props — the "designed building" layer that sits
// between bare thin-wall geometry and the light field. Like trimwork.js this
// is THREE-free: pure functions turning ChunkData into unit-box instance
// descriptors, batched by mesh.js. Everything is deterministic from GLOBAL
// cell coordinates, so a chunk dresses identically across reloads.
//
// Returns { trim, props, signs }:
//   trim  : baseboards, crown molding, column bases/caps — batched with the
//           door/window casings (uniform trim paint, no per-instance tint).
//   props : tinted flat items — floor thresholds, radiators, clocks, notice
//           boards, extinguisher cabinets, ceiling vents. Each carries `tint`.
//   signs : emissive items — exit signs over doors, hanging blade signs.
//           These glow (and bloom) but cast no light: beacons, not lamps.
//
// Collision contract: the collision raster and navigation graph never learn
// about any of this. Everything either hugs an existing wall/column face
// (no prouder than the door casings the game already ships), lies flat on the
// floor below ankle height, or hangs above door-head height, so nothing can
// visibly swallow the player or fake a blocker.

// Albedo multipliers on the shared white prop material (linear-ish 0..1).
export const PROP_TINT = {
  threshold: [0.5, 0.42, 0.26], // worn brass
  vent: [0.3, 0.29, 0.26], // dark grille
  ventSlat: [0.17, 0.16, 0.14], // grille slats
  clock: [0.95, 0.93, 0.85], // cream face
  clockRim: [0.2, 0.2, 0.19], // dark case + hands
  board: [0.66, 0.54, 0.36], // cork
  boardFrame: [0.3, 0.24, 0.17], // wood frame
  paper: [0.93, 0.91, 0.82], // pinned notices
  extinguisher: [0.62, 0.14, 0.1], // safety red
  glassPale: [0.78, 0.86, 0.88], // cabinet glazing
  radiator: [0.82, 0.8, 0.72], // painted enamel
  pipe: [0.35, 0.34, 0.32], // plumbing metal
  caution: [0.85, 0.7, 0.15], // server-room warning plate
}
export const SIGN_TINT = {
  exit: [0.45, 1.0, 0.62], // emergency green
  blade: [1.0, 0.82, 0.45], // warm wayfinding amber
  frame: [0.2, 0.2, 0.18], // sign housings (dark even while emissive)
}

const DOOR_H = WALL_H - HEADER_H
const roll = (salt, gx, gz) => hash2i(salt | 0, gx, gz) / 4294967296

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

function dressTowerLandmarkSockets(data, props, signs) {
  const structure = data.multilevelStructure
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

// Wall edges ------------------------------------------------------------

function dressEdge(data, axis, line, cell, trim, props, signs) {
  const vertical = axis === 'v'
  const i = vertical ? vIdx(line, cell) : hIdx(cell, line)
  const wall = vertical ? data.wallV[i] : data.wallH[i]
  const passage = vertical ? data.passageV[i] : data.passageH[i]
  const feature = vertical ? data.wallFeatureV[i] : data.wallFeatureH[i]
  const plane = line * CELL
  const centre = (cell + 0.5) * CELL
  const gx = data.cx * CHUNK + (vertical ? line : cell)
  const gz = data.cz * CHUNK + (vertical ? cell : line)

  // box(): axis-aware emit, `along` running along the wall, `across` across it.
  const box = (out, along, y, across, sAlong, sY, sAcross, tint) => {
    if (vertical) out.push({ px: across, py: y, pz: along, sx: sAcross, sy: sY, sz: sAlong, tint })
    else out.push({ px: along, py: y, pz: across, sx: sAlong, sy: sY, sz: sAcross, tint })
  }

  if (wall !== 1) {
    if (passage !== PASSAGE_DOOR && passage !== PASSAGE_WIDE) return
    // Threshold strip: a flooring-material seam line under the opening.
    box(props, centre, THRESHOLD_H / 2, plane, CELL, THRESHOLD_H, THRESHOLD_DEPTH, PROP_TINT.threshold)
    // Exit sign on a deterministic subset of real doorways — a dark housing
    // plate with the glowing face proud of it, one assembly per wall face.
    if (passage === PASSAGE_DOOR && roll(SIGN_SALT, gx, gz) < EXIT_SIGN_CHANCE) {
      const y = DOOR_H + 0.12 + EXIT_SIGN_H / 2
      for (const s of [-1, 1]) {
        box(signs, centre, y, plane + s * (THICK / 2 + 0.02), EXIT_SIGN_W + 0.07, EXIT_SIGN_H + 0.06, 0.04, SIGN_TINT.frame)
        box(signs, centre, y, plane + s * (THICK / 2 + 0.04 + EXIT_SIGN_T / 2), EXIT_SIGN_W, EXIT_SIGN_H, EXIT_SIGN_T, SIGN_TINT.exit)
      }
    }
    return
  }

  if (feature !== WALL_RAIL) {
    // Baseboard + crown: one box straddling the wall plane dresses both faces.
    box(trim, centre, BASEBOARD_H / 2, plane, CELL, BASEBOARD_H, THICK + 2 * BASEBOARD_PROUD)
    box(trim, centre, WALL_H - CROWN_H / 2, plane, CELL, CROWN_H, THICK + 2 * CROWN_PROUD)
  }

  if (feature === WALL_WINDOW) {
    // Radiator under the window stool, both gallery faces: enamel panel with
    // ribs, feet, and an inlet pipe dropping to the floor.
    const y = RADIATOR_H / 2
    for (const s of [-1, 1]) {
      const faceOff = plane + s * (THICK / 2 + RADIATOR_T / 2)
      box(props, centre, y, faceOff, RADIATOR_W, RADIATOR_H, RADIATOR_T, PROP_TINT.radiator)
      for (let r = 0; r < RADIATOR_RIBS; r++) {
        const off = (r / (RADIATOR_RIBS - 1) - 0.5) * (RADIATOR_W - 0.2)
        box(props, centre + off, y, faceOff + s * (RADIATOR_T / 2 + 0.015), 0.07, RADIATOR_H * 0.82, 0.03, PROP_TINT.radiator)
      }
      // Feet + the inlet pipe at one end.
      for (const fs of [-1, 1]) {
        box(props, centre + fs * (RADIATOR_W / 2 - 0.12), 0.04, faceOff, 0.08, 0.08, RADIATOR_T, PROP_TINT.pipe)
      }
      box(props, centre + RADIATOR_W / 2 - 0.06, RADIATOR_H / 2 - 0.1, faceOff + s * (RADIATOR_T / 2 + 0.02), 0.05, RADIATOR_H - 0.1, 0.05, PROP_TINT.pipe)
    }
    return
  }

  if (feature !== WALL_PLAIN) return

  // Wall-mounted props: one roll per wall face, driven by the adjacent cell
  // kind. Corridor walls get extinguisher cabinets; rooms/lobbies get clocks
  // and notice boards — modulated by the district plan's room role: break
  // rooms always pin notices, server rooms get warning plates instead of
  // homely clutter. Plates sit shallower than the door casings.
  for (const s of [-1, 1]) {
    const cx = vertical ? line + (s > 0 ? 0 : -1) : cell
    const cz = vertical ? cell : line + (s > 0 ? 0 : -1)
    if (cx < 0 || cx >= CHUNK || cz < 0 || cz >= CHUNK) continue
    const ci = cIdx(cx, cz)
    const kind = data.cellKind[ci]
    const role = data.spaceRole[ci]
    const r = roll((PROP_SALT ^ (s > 0 ? 0x5eed : 0xface)) | 0, gx, gz)
    if (kind === CELL_CORRIDOR) {
      if (r >= EXT_CHANCE) continue
      // Extinguisher cabinet: red body, pale glazed door, handle nub.
      const off = plane + s * (THICK / 2 + EXT_T / 2)
      box(props, centre, EXT_Y, off, EXT_W, EXT_H, EXT_T, PROP_TINT.extinguisher)
      box(props, centre, EXT_Y + 0.03, off + s * (EXT_T / 2 + 0.008), EXT_W - 0.08, EXT_H - 0.16, 0.015, PROP_TINT.glassPale)
      box(props, centre + (EXT_W / 2 - 0.05), EXT_Y, off + s * (EXT_T / 2 + 0.02), 0.03, 0.1, 0.03, PROP_TINT.pipe)
    } else if (kind === CELL_ROOM || kind === CELL_LOBBY) {
      if (role === SPACE_ROLE_SERVER) {
        // Caution plate at the server room's walls, no homely clutter.
        if (r >= 0.3) continue
        const off = plane + s * (THICK / 2 + PROP_PLATE_T / 2)
        box(props, centre, 1.6, off, 0.4, 0.28, PROP_PLATE_T, PROP_TINT.caution)
        box(props, centre, 1.6, off + s * (PROP_PLATE_T / 2 + 0.006), 0.3, 0.05, 0.012, PROP_TINT.clockRim)
        continue
      }
      const boardChance = role === SPACE_ROLE_BREAK ? 0.4 : role === SPACE_ROLE_MEETING ? 0.16 : BOARD_CHANCE
      if (r < CLOCK_CHANCE && role !== SPACE_ROLE_BREAK) {
        // Wall clock: dark case, cream face, two static hands.
        const off = plane + s * (THICK / 2 + PROP_PLATE_T / 2)
        box(props, centre, CLOCK_Y, off, CLOCK_SIZE + 0.06, CLOCK_SIZE + 0.06, PROP_PLATE_T, PROP_TINT.clockRim)
        const faceOff = off + s * (PROP_PLATE_T / 2 + 0.006)
        box(props, centre, CLOCK_Y, faceOff, CLOCK_SIZE, CLOCK_SIZE, 0.012, PROP_TINT.clock)
        box(props, centre, CLOCK_Y + 0.05, faceOff + s * 0.012, 0.025, 0.16, 0.012, PROP_TINT.clockRim) // hour hand
        box(props, centre + 0.06, CLOCK_Y, faceOff + s * 0.012, 0.2, 0.02, 0.012, PROP_TINT.clockRim) // minute hand
      } else if (r < CLOCK_CHANCE + boardChance) {
        // Notice board: wood frame, cork field, pinned paper slips.
        const off = plane + s * (THICK / 2 + PROP_PLATE_T / 2)
        box(props, centre, BOARD_Y, off, BOARD_W + 0.08, BOARD_H + 0.08, PROP_PLATE_T, PROP_TINT.boardFrame)
        const faceOff = off + s * (PROP_PLATE_T / 2 + 0.006)
        box(props, centre, BOARD_Y, faceOff, BOARD_W, BOARD_H, 0.012, PROP_TINT.board)
        const h2 = hash2i((PROP_SALT ^ 0xbeef) | 0, gx, gz)
        for (let p = 0; p < 3; p++) {
          const pu = ((h2 >>> (p * 6)) & 63) / 63 - 0.5
          const pv = ((h2 >>> (p * 6 + 3)) & 63) / 63 - 0.5
          box(props, centre + pu * (BOARD_W - 0.5), BOARD_Y + pv * (BOARD_H - 0.35), faceOff + s * 0.01,
            0.22, 0.28, 0.008, PROP_TINT.paper)
        }
      }
    }
  }
}

// Columns ---------------------------------------------------------------

function dressColumns(data, trim) {
  for (let z = 0; z < CHUNK; z++) {
    for (let x = 0; x < CHUNK; x++) {
      const kind = data.cols[cIdx(x, z)]
      // Furniture cells are dressed by their own models (furnitureModels.js);
      // only structural columns get a base + capital.
      if (!kind || kind === COLUMN_FURNITURE) continue
      const half = kind === COLUMN_MONUMENTAL ? MONUMENTAL_COL_HALF : COL_HALF
      const px = (x + 0.5) * CELL
      const pz = (z + 0.5) * CELL
      const baseW = (half + COL_BASE_WIDEN) * 2
      const capW = (half + COL_CAP_WIDEN) * 2
      // Base: a stepped plinth (lower wide step + narrower neck); capital: a
      // flare + abacus slab, so piers read as designed structure.
      trim.push({ px, py: COL_BASE_H / 2, pz, sx: baseW, sy: COL_BASE_H, sz: baseW })
      trim.push({ px, py: COL_BASE_H + 0.05, pz, sx: (half + 0.06) * 2, sy: 0.1, sz: (half + 0.06) * 2 })
      trim.push({ px, py: WALL_H - COL_CAP_H / 2, pz, sx: capW, sy: COL_CAP_H, sz: capW })
      trim.push({ px, py: WALL_H - COL_CAP_H - 0.05, pz, sx: (half + 0.08) * 2, sy: 0.1, sz: (half + 0.08) * 2 })
    }
  }
}

// Ceiling layer (blade signs + vents) -------------------------------------

function dressCeiling(data, props, signs) {
  const lampCells = new Set(data.lamps.map((l) => `${l.lx},${l.lz}`))
  for (let z = 0; z < CHUNK; z++) {
    for (let x = 0; x < CHUNK; x++) {
      if (data.cols[cIdx(x, z)]) continue
      const key = `${x},${z}`
      if (lampCells.has(key)) continue
      const kind = data.cellKind[cIdx(x, z)]
      const gx = data.cx * CHUNK + x
      const gz = data.cz * CHUNK + z
      const px = (x + 0.5) * CELL
      const pz = (z + 0.5) * CELL
      let signed = false
      if (kind === CELL_CORRIDOR || kind === CELL_LOBBY) {
        const h = hash2i((SIGN_SALT ^ 0x5b1a) | 0, gx, gz)
        if (h / 4294967296 < BLADE_SIGN_CHANCE) {
          const alongX = (h & 2) === 2
          const blade = (ou, y, ov, su, sy, sv, tint) =>
            signs.push({
              px: px + (alongX ? ou : ov),
              py: y,
              pz: pz + (alongX ? ov : ou),
              sx: alongX ? su : sv,
              sy,
              sz: alongX ? sv : su,
              tint,
            })
          // Housing rails above and below the glowing panel face.
          blade(0, BLADE_SIGN_Y, 0, BLADE_SIGN_W, BLADE_SIGN_H, BLADE_SIGN_T, SIGN_TINT.blade)
          blade(0, BLADE_SIGN_Y + BLADE_SIGN_H / 2 + 0.02, 0, BLADE_SIGN_W + 0.08, 0.04, BLADE_SIGN_T + 0.02, SIGN_TINT.frame)
          blade(0, BLADE_SIGN_Y - BLADE_SIGN_H / 2 - 0.02, 0, BLADE_SIGN_W + 0.08, 0.04, BLADE_SIGN_T + 0.02, SIGN_TINT.frame)
          // Two hanger rods from the housing to the ceiling.
          const top = BLADE_SIGN_Y + BLADE_SIGN_H / 2 + 0.04
          for (const rod of [-1, 1]) {
            blade(rod * (BLADE_SIGN_W / 2 - 0.12), (top + WALL_H) / 2, 0, 0.04, WALL_H - top, 0.04, SIGN_TINT.frame)
          }
          signed = true
        }
      }
      if (signed) continue
      // Vents never float over slab openings or stair runs.
      if (kind === CELL_STAIR || kind === CELL_VOID || kind === CELL_ATRIUM || kind === CELL_BRIDGE) continue
      if (data.hasCeilHole(x, z)) continue
      if (roll(VENT_SALT, gx, gz) >= VENT_CHANCE) continue
      const h = hash2i((VENT_SALT ^ 0x33c1) | 0, gx, gz)
      const ox = ((h & 1023) / 1023 - 0.5) * 0.9
      const oz = (((h >>> 10) & 1023) / 1023 - 0.5) * 0.9
      // Grille body flush under the ceiling, with three slat strips.
      props.push({
        px: px + ox,
        py: WALL_H - VENT_H / 2,
        pz: pz + oz,
        sx: VENT_W,
        sy: VENT_H,
        sz: VENT_D,
        tint: PROP_TINT.vent,
      })
      for (let slat = 0; slat < 3; slat++) {
        props.push({
          px: px + ox,
          py: WALL_H - VENT_H - 0.012,
          pz: pz + oz + (slat - 1) * (VENT_D / 3),
          sx: VENT_W - 0.16,
          sy: 0.025,
          sz: 0.05,
          tint: PROP_TINT.ventSlat,
        })
      }
    }
  }
}

export function collectInteriorDressing(data) {
  const trim = []
  const props = []
  const signs = []
  for (let z = 0; z < CHUNK; z++) {
    for (let lx = 0; lx < CHUNK; lx++) dressEdge(data, 'v', lx, z, trim, props, signs)
  }
  for (let lz = 0; lz < CHUNK; lz++) {
    for (let x = 0; x < CHUNK; x++) dressEdge(data, 'h', lz, x, trim, props, signs)
  }
  dressColumns(data, trim)
  dressCeiling(data, props, signs)
  dressTowerLandmarkSockets(data, props, signs)
  return { trim, props, signs }
}
