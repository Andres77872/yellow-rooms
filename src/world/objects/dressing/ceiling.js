import {
  CELL,
  CHUNK,
  WALL_H,
  BLADE_SIGN_CHANCE,
  BLADE_SIGN_W,
  BLADE_SIGN_H,
  BLADE_SIGN_T,
  BLADE_SIGN_Y,
  VENT_CHANCE,
  VENT_W,
  VENT_D,
  VENT_H,
  SIGN_SALT,
  VENT_SALT,
  cIdx,
} from '../../constants.js'
import { hash2i } from '../../core/hash.js'
import {
  CELL_CORRIDOR,
  CELL_LOBBY,
  CELL_STAIR,
  CELL_ATRIUM,
  CELL_VOID,
  CELL_BRIDGE,
} from '../../mapTypes.js'
import { PROP_TINT, SIGN_TINT } from './palette.js'

// Ceiling-layer dressing: hanging blade signs in corridors/lobbies and
// sparse dark vent grilles. Never over lamps, columns, stairs, or slab
// openings.
const roll = (salt, gx, gz) => hash2i(salt | 0, gx, gz) / 4294967296

export function dressCeiling(data, props, signs) {
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
