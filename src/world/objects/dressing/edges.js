import {
  CELL,
  CHUNK,
  WALL_H,
  THICK,
  BASEBOARD_H,
  BASEBOARD_PROUD,
  CROWN_H,
  CROWN_PROUD,
  THRESHOLD_H,
  THRESHOLD_DEPTH,
  EXIT_SIGN_CHANCE,
  EXIT_SIGN_W,
  EXIT_SIGN_H,
  EXIT_SIGN_T,
  EXIT_SIGN_Y,
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
  vIdx,
  hIdx,
  cIdx,
} from '../../constants.js'
import { hash2i } from '../../core/hash.js'
import {
  PASSAGE_DOOR,
  PASSAGE_WIDE,
  WALL_PLAIN,
  WALL_RAIL,
  WALL_WINDOW,
  CELL_CORRIDOR,
  CELL_LOBBY,
  CELL_ROOM,
  SPACE_ROLE_BREAK,
  SPACE_ROLE_MEETING,
  SPACE_ROLE_SERVER,
} from '../../mapTypes.js'
import { PROP_TINT, ROLE_BAND, SIGN_TINT } from './palette.js'

// Wall-edge dressing: thresholds and exit signs at openings, baseboards and
// crown molding on solid walls, radiators under windows, and the wall-mounted
// prop set (clocks, notice boards, extinguisher cabinets, caution plates).
const roll = (salt, gx, gz) => hash2i(salt | 0, gx, gz) / 4294967296

export function dressEdge(data, axis, line, cell, trim, props, signs) {
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
      const y = EXIT_SIGN_Y
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
    // Role wainscot: a continuous painted band around every role room's
    // walls, so the room's identity reads architecturally at a glance.
    if ((kind === CELL_ROOM || kind === CELL_LOBBY) && ROLE_BAND[role]) {
      box(props, centre, 1.32, plane + s * (THICK / 2 + 0.011), CELL, 0.4, 0.022, ROLE_BAND[role])
    }
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
