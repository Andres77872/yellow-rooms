import { CELL, CHUNK, THICK, WALL_H, vIdx, hIdx } from '../../constants.js'
import { hash2i } from '../../core/hash.js'
import {
  SEWER_DIR_EAST,
  SEWER_DIR_WEST,
  SEWER_MODULE_CHAMBER_LARGE,
  SEWER_MODULE_CHAMBER_SMALL,
} from '../../mapTypes.js'
import { SEWER_TINT, SEWER_SIGN } from './palette.js'

// Sewer gallery dressing — replaces the office "designed building" layer for
// the sewer family. Everything reads as buried infrastructure: pipe runs on
// the gallery walls, cast vault ribs over the trunk, a center drain gutter
// with grates, valve hardware in the chambers, and painted hazard bands plus
// a lit way-out marker at every real riser (dossier GS-3/GS-6/GS-12).
//
// Same contract as the office layer: THREE-free unit-box descriptors, purely
// visual, deterministic from GLOBAL coordinates, collision-free (wall-hugging,
// floor strips below ankle height, or overhead).

const PIPE_SALT = 0x51e0
const PIPE2_SALT = 0x51e1

const PIPE_R = 0.13
const PIPE_Y = 2.55
const PIPE2_R = 0.08
const PIPE2_Y = 2.28
const RIB_D = 0.24
const RIB_H = 0.2
const GUTTER_W = 0.56
const GUTTER_H = 0.035
const GRATE_H = 0.055

const roll = (salt, a, b) => hash2i(salt | 0, a, b) / 4294967296

export function collectSewerDressing(data) {
  const trim = []
  const props = []
  const signs = []
  const descriptor = data.sewerDescriptor
  if (!descriptor) return { trim, props, signs }

  const wallV = (lx, z) => (lx <= 0 || lx >= CHUNK ? 1 : data.wallV[vIdx(lx, z)])
  const wallH = (x, lz) => (lz <= 0 || lz >= CHUNK ? 1 : data.wallH[hIdx(x, lz)])

  // Pipe runs keyed per GLOBAL wall line + face, so a run continues cell to
  // cell along a gallery instead of stuttering per cell.
  const linePipe = (axis, gLine, side) => {
    const r = roll(PIPE_SALT, axis === 'v' ? gLine : ~gLine, side)
    const r2 = roll(PIPE2_SALT, axis === 'v' ? gLine : ~gLine, side)
    return { main: r < 0.55, old: r2 < 0.3 }
  }

  const pipeAlongWall = (vertical, line, cell, side) => {
    const gLine = (vertical ? data.cx : data.cz) * CHUNK + line
    const { main, old } = linePipe(vertical ? 'v' : 'h', gLine, side)
    if (!main && !old) return
    const plane = line * CELL + side * (THICK / 2)
    const centre = (cell + 0.5) * CELL
    const emit = (r, y, tint) => {
      if (vertical) {
        props.push({ px: plane + side * r, py: y, pz: centre, sx: r * 2, sy: r * 2, sz: CELL, tint })
        props.push({ px: plane + side * (r * 0.7), py: y - r * 1.4, pz: centre, sx: r, sy: r * 1.6, sz: 0.12, tint: SEWER_TINT.bracket })
      } else {
        props.push({ px: centre, py: y, pz: plane + side * r, sx: CELL, sy: r * 2, sz: r * 2, tint })
        props.push({ px: centre, py: y - r * 1.4, pz: plane + side * (r * 0.7), sx: 0.12, sy: r * 1.6, sz: r, tint: SEWER_TINT.bracket })
      }
    }
    if (main) emit(PIPE_R, PIPE_Y, SEWER_TINT.pipe)
    if (old) emit(PIPE2_R, PIPE2_Y, SEWER_TINT.pipeOld)
  }

  let trunkStep = 0
  for (let index = 0; index < descriptor.modules.length; index++) {
    const m = descriptor.modules[index]
    const cx = (m.lx + 0.5) * CELL
    const cz = (m.lz + 0.5) * CELL
    const horizontal = m.dir === SEWER_DIR_EAST || m.dir === SEWER_DIR_WEST

    if (index < descriptor.trunkCount) {
      // Trunk gallery: drain gutter down the middle, grates and vault ribs on
      // a fixed cadence — the readable engineered spine.
      props.push(horizontal
        ? { px: cx, py: GUTTER_H / 2, pz: cz, sx: CELL, sy: GUTTER_H, sz: GUTTER_W, tint: SEWER_TINT.gutter }
        : { px: cx, py: GUTTER_H / 2, pz: cz, sx: GUTTER_W, sy: GUTTER_H, sz: CELL, tint: SEWER_TINT.gutter })
      if (trunkStep % 4 === 1) {
        for (const o of [-0.3, 0, 0.3]) {
          props.push(horizontal
            ? { px: cx + o, py: GRATE_H / 2, pz: cz, sx: 0.14, sy: GRATE_H, sz: GUTTER_W + 0.18, tint: SEWER_TINT.grate }
            : { px: cx, py: GRATE_H / 2, pz: cz + o, sx: GUTTER_W + 0.18, sy: GRATE_H, sz: 0.14, tint: SEWER_TINT.grate })
        }
      }
      if (trunkStep % 3 === 2) {
        // Rib across the gallery under the ceiling: the cast-vault rhythm.
        props.push(horizontal
          ? { px: cx, py: WALL_H - RIB_H / 2, pz: cz, sx: RIB_D, sy: RIB_H, sz: CELL, tint: SEWER_TINT.rib }
          : { px: cx, py: WALL_H - RIB_H / 2, pz: cz, sx: CELL, sy: RIB_H, sz: RIB_D, tint: SEWER_TINT.rib })
      }
      trunkStep++
    }

    // Pipes hug the closed walls of every gallery cell (not chambers — their
    // hardware is the valve station instead).
    if (m.kind !== SEWER_MODULE_CHAMBER_LARGE && m.kind !== SEWER_MODULE_CHAMBER_SMALL) {
      if (wallV(m.lx, m.lz)) pipeAlongWall(true, m.lx, m.lz, 1)
      if (wallV(m.lx + 1, m.lz)) pipeAlongWall(true, m.lx + 1, m.lz, -1)
      if (wallH(m.lx, m.lz)) pipeAlongWall(false, m.lz, m.lx, 1)
      if (wallH(m.lx, m.lz + 1)) pipeAlongWall(false, m.lz + 1, m.lx, -1)
    }
  }

  // Chamber hardware: a valve station in the large chamber, a rung ladder
  // detail in the small one — one high-salience landmark per chamber.
  for (const chamber of descriptor.chambers ?? []) {
    const wide = chamber.kind === SEWER_MODULE_CHAMBER_LARGE
    placeChamberHardware(data, chamber, wide, props)
  }

  // Risers: painted hazard band + glowing way-out arrow at the working end of
  // each real stair, so a manhole reads as an exit, not decoration.
  if (data.stairUp) riserMarker(data.stairUp.landing, data.stairUp.dir, true, props, signs)
  if (data.stairDown) riserMarker(data.stairDown.exit, data.stairDown.dir, false, props, signs)

  return { trim, props, signs }
}

// Find the first closed wall on the chamber perimeter and mount the hardware
// against its inner face.
function placeChamberHardware(data, chamber, wide, props) {
  for (let lz = chamber.z0; lz <= chamber.z1; lz++) {
    for (let lx = chamber.x0; lx <= chamber.x1; lx++) {
      const centre = { x: (lx + 0.5) * CELL, z: (lz + 0.5) * CELL }
      const faces = [
        { closed: lx === 0 || data.wallV[vIdx(lx, lz)] === 1, px: lx * CELL, pz: centre.z, vertical: true, side: 1 },
        { closed: lz === 0 || data.wallH[hIdx(lx, lz)] === 1, px: centre.x, pz: lz * CELL, vertical: false, side: 1 },
      ]
      for (const f of faces) {
        if (!f.closed) continue
        const off = THICK / 2 + 0.05
        const ox = f.vertical ? f.side * off : 0
        const oz = f.vertical ? 0 : f.side * off
        // Seep stain behind the hardware, flush against the wall face (its
        // centre must sit past THICK/2 — closer and the 0.02 plate is buried
        // inside the wall slab and never renders).
        const stainOff = f.side * (THICK / 2 + 0.01)
        props.push({
          px: f.px + (f.vertical ? stainOff : 0), py: 1.5, pz: f.pz + (f.vertical ? 0 : stainOff),
          sx: f.vertical ? 0.02 : 1.1, sy: 1.9, sz: f.vertical ? 1.1 : 0.02,
          tint: SEWER_TINT.stain,
        })
        if (wide) {
          // Valve wheel: crossed spokes + hub on a stem dropping to the floor.
          props.push({ px: f.px + ox, py: 1.5, pz: f.pz + oz, sx: f.vertical ? 0.08 : 0.62, sy: 0.1, sz: f.vertical ? 0.62 : 0.08, tint: SEWER_TINT.valve })
          props.push({ px: f.px + ox, py: 1.5, pz: f.pz + oz, sx: f.vertical ? 0.08 : 0.1, sy: 0.62, sz: f.vertical ? 0.1 : 0.08, tint: SEWER_TINT.valve })
          props.push({ px: f.px + ox, py: 1.5, pz: f.pz + oz, sx: f.vertical ? 0.12 : 0.16, sy: 0.16, sz: f.vertical ? 0.16 : 0.12, tint: SEWER_TINT.stem })
          props.push({ px: f.px + ox * 0.7, py: 0.75, pz: f.pz + oz * 0.7, sx: 0.09, sy: 1.5, sz: 0.09, tint: SEWER_TINT.stem })
        } else {
          // Rung ladder detail up the chamber wall.
          for (let r = 0; r < 4; r++) {
            props.push({
              px: f.px + ox, py: 0.7 + r * 0.55, pz: f.pz + oz,
              sx: f.vertical ? 0.07 : 0.5, sy: 0.06, sz: f.vertical ? 0.5 : 0.07,
              tint: SEWER_TINT.rung,
            })
          }
        }
        return
      }
    }
  }
}

function riserMarker(cell, dir, up, props, signs) {
  const cx = (cell.lx + 0.5) * CELL
  const cz = (cell.lz + 0.5) * CELL
  const horizontal = dir === SEWER_DIR_EAST || dir === SEWER_DIR_WEST
  // Painted hazard band across the approach floor.
  props.push(horizontal
    ? { px: cx, py: 0.012, pz: cz, sx: 0.5, sy: 0.024, sz: CELL - 0.4, tint: SEWER_TINT.hazard }
    : { px: cx, py: 0.012, pz: cz, sx: CELL - 0.4, sy: 0.024, sz: 0.5, tint: SEWER_TINT.hazard })
  // Glowing way-out marker above head height, visible from both directions.
  signs.push({
    px: cx, py: up ? 2.5 : 2.7, pz: cz,
    sx: horizontal ? 0.1 : 0.5, sy: 0.22, sz: horizontal ? 0.5 : 0.1,
    tint: SEWER_SIGN.arrow,
  })
}
