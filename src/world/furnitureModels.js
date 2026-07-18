import {
  DESK_W,
  DESK_D,
  DESK_H,
  CHAIR_W,
  CHAIR_H,
  CHAIR_SEAT_H,
  TABLE_W,
  TABLE_D,
  TABLE_H,
  CABINET_W,
  CABINET_D,
  CABINET_H,
  COPIER_W,
  COPIER_D,
  COPIER_H,
  COOLER_W,
  COOLER_H,
  PLANT_W,
  PLANT_H,
  RACK_W,
  RACK_D,
  RACK_H,
} from './constants.js'
import {
  FURN_DESK,
  FURN_CHAIR,
  FURN_TABLE,
  FURN_CABINET,
  FURN_COPIER,
  FURN_COOLER,
  FURN_PLANT,
  FURN_RACK,
} from './furniture.js'

// Furniture model builders — THREE-free, like trimwork.js/props.js. Each
// builder turns one ChunkData.furniture record into unit-box descriptors
// { px, py, pz, sx, sy, sz, tint } in CHUNK-LOCAL coordinates, batched by
// mesh.js into a single instanced draw with per-instance tints.
//
// Design language: the same bold flat shapes as the joinery — readable
// silhouettes first (desktop line, chair back, cabinet doors, copier lid,
// bottle neck, leaf cross), panel gaps and handles as thin proud slabs that
// catch the ink outline. Pieces are modelled in a local frame (u = width,
// v = depth, front toward +v) and mapped to the world by `facing`.

export const FURN_TINT = {
  laminate: [0.74, 0.68, 0.58], // desk/table tops
  legMetal: [0.32, 0.31, 0.3],
  panel: [0.62, 0.58, 0.5], // modesty panels, drawer cases
  drawerFace: [0.7, 0.64, 0.54],
  screen: [0.1, 0.11, 0.13],
  keyDark: [0.16, 0.16, 0.17],
  fabric: [0.3, 0.34, 0.42], // chair upholstery
  cabinetPaint: [0.66, 0.67, 0.63],
  copierBody: [0.78, 0.79, 0.75],
  slotDark: [0.14, 0.14, 0.15],
  coolerWhite: [0.88, 0.9, 0.88],
  bottleBlue: [0.55, 0.75, 0.9],
  potClay: [0.52, 0.34, 0.24],
  soil: [0.2, 0.15, 0.1],
  leafGreen: [0.28, 0.48, 0.28],
  rackDark: [0.16, 0.17, 0.19], // server rack body
  rackFace: [0.22, 0.23, 0.26], // rack front panel
  ledGreen: [0.4, 1.0, 0.55], // status LEDs
}

// facing 0=+z 1=-z 2=+x 3=-x: map local (u,v) offsets/sizes to world (x,z).
function frame(facing) {
  switch (facing & 3) {
    case 1: return { ox: (u, v) => [-u, -v], sz: (su, sv) => [su, sv] }
    case 2: return { ox: (u, v) => [v, -u], sz: (su, sv) => [sv, su] }
    case 3: return { ox: (u, v) => [-v, u], sz: (su, sv) => [sv, su] }
    default: return { ox: (u, v) => [u, v], sz: (su, sv) => [su, sv] }
  }
}

function builder(f, out) {
  const fr = frame(f.facing)
  return (ou, y, ov, su, sy, sv, tint) => {
    const [ox, oz] = fr.ox(ou, ov)
    const [sx, sz] = fr.sz(su, sv)
    out.push({ px: f.x + ox, py: y, pz: f.z + oz, sx, sy, sz, tint })
  }
}

// --- Desk: worktop on leg panels, modesty panel, drawer stack with handles,
//     monitor + keyboard on top. ------------------------------------------
function desk(f, out) {
  const b = builder(f, out)
  const W = DESK_W
  const D = DESK_D
  b(0, DESK_H - 0.025, 0, W, 0.05, D, FURN_TINT.laminate) // top
  b(-(W / 2 - 0.05), (DESK_H - 0.05) / 2, 0, 0.06, DESK_H - 0.05, D - 0.06, FURN_TINT.legMetal)
  b(W / 2 - 0.05, (DESK_H - 0.05) / 2, 0, 0.06, DESK_H - 0.05, D - 0.06, FURN_TINT.legMetal)
  b(0, 0.42, -(D / 2 - 0.06), W - 0.16, 0.42, 0.03, FURN_TINT.panel) // modesty panel
  // Drawer stack on the right, two drawer fronts + handle nubs.
  b(W / 2 - 0.3, 0.32, 0, 0.44, 0.58, D - 0.1, FURN_TINT.panel)
  b(W / 2 - 0.3, 0.47, D / 2 - 0.065, 0.38, 0.2, 0.02, FURN_TINT.drawerFace)
  b(W / 2 - 0.3, 0.2, D / 2 - 0.065, 0.38, 0.28, 0.02, FURN_TINT.drawerFace)
  b(W / 2 - 0.3, 0.4, D / 2 - 0.04, 0.12, 0.02, 0.03, FURN_TINT.legMetal)
  b(W / 2 - 0.3, 0.34, D / 2 - 0.04, 0.12, 0.02, 0.03, FURN_TINT.legMetal)
  // Monitor (screen + stand) and keyboard — the occupied-desk read.
  b(-0.18, DESK_H + 0.2, -0.12, 0.55, 0.34, 0.04, FURN_TINT.screen)
  b(-0.18, DESK_H + 0.03, -0.1, 0.08, 0.06, 0.12, FURN_TINT.legMetal)
  b(-0.05, DESK_H + 0.008, 0.16, 0.45, 0.015, 0.16, FURN_TINT.keyDark)
}

// --- Chair: upholstered seat + back on four legs. ------------------------
function chair(f, out) {
  const b = builder(f, out)
  const W = CHAIR_W
  b(0, CHAIR_SEAT_H, 0, W - 0.04, 0.07, W - 0.04, FURN_TINT.fabric) // seat
  b(0, CHAIR_SEAT_H + 0.07 + (CHAIR_H - CHAIR_SEAT_H - 0.07) / 2, -(W / 2 - 0.04),
    W - 0.06, CHAIR_H - CHAIR_SEAT_H - 0.07, 0.05, FURN_TINT.fabric) // back
  const leg = W / 2 - 0.06
  for (const [su, sv] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    b(su * leg, (CHAIR_SEAT_H - 0.035) / 2, sv * leg, 0.05, CHAIR_SEAT_H - 0.035, 0.05, FURN_TINT.legMetal)
  }
}

// --- Conference table: long top on two panel legs + a stretcher beam. ----
function table(f, out) {
  const b = builder(f, out)
  b(0, TABLE_H - 0.03, 0, TABLE_W, 0.06, TABLE_D, FURN_TINT.laminate)
  b(-(TABLE_W / 2 - 0.15), (TABLE_H - 0.06) / 2, 0, 0.08, TABLE_H - 0.06, TABLE_D - 0.1, FURN_TINT.panel)
  b(TABLE_W / 2 - 0.15, (TABLE_H - 0.06) / 2, 0, 0.08, TABLE_H - 0.06, TABLE_D - 0.1, FURN_TINT.panel)
  b(0, 0.3, 0, TABLE_W - 0.5, 0.08, 0.06, FURN_TINT.legMetal) // stretcher
}

// --- Cabinet: tall two-door storage with handles and a kick base. --------
function cabinet(f, out) {
  const b = builder(f, out)
  b(0, 0.05, 0, CABINET_W - 0.06, 0.1, CABINET_D - 0.04, FURN_TINT.legMetal) // kick
  b(0, CABINET_H / 2 + 0.04, 0, CABINET_W, CABINET_H - 0.1, CABINET_D, FURN_TINT.cabinetPaint)
  for (const s of [-1, 1]) {
    b(s * (CABINET_W / 4 - 0.01), CABINET_H / 2 + 0.04, CABINET_D / 2 + 0.008,
      CABINET_W / 2 - 0.04, CABINET_H - 0.24, 0.015, FURN_TINT.panel) // door
    b(s * 0.05, CABINET_H / 2 + 0.04, CABINET_D / 2 + 0.025, 0.03, 0.18, 0.02, FURN_TINT.legMetal) // handle
  }
}

// --- Photocopier: body, scanner lid, output slot, paper tray. ------------
function copier(f, out) {
  const b = builder(f, out)
  b(0, (COPIER_H - 0.12) / 2, 0, COPIER_W, COPIER_H - 0.12, COPIER_D, FURN_TINT.copierBody)
  b(0, COPIER_H - 0.06, -0.02, COPIER_W - 0.06, 0.1, COPIER_D - 0.08, FURN_TINT.panel) // lid
  b(0, 0.62, COPIER_D / 2 + 0.006, COPIER_W - 0.2, 0.09, 0.02, FURN_TINT.slotDark) // output slot
  b(0, 0.3, COPIER_D / 2 + 0.01, COPIER_W - 0.14, 0.16, 0.03, FURN_TINT.drawerFace) // tray
  b(COPIER_W / 2 - 0.1, COPIER_H - 0.02, 0.12, 0.14, 0.03, 0.2, FURN_TINT.keyDark) // control strip
}

// --- Water cooler: base unit, blue bottle (body + neck), tap. ------------
function cooler(f, out) {
  const b = builder(f, out)
  b(0, 0.45, 0, COOLER_W, 0.9, COOLER_W, FURN_TINT.coolerWhite)
  b(0, 0.98, 0, COOLER_W - 0.1, 0.2, COOLER_W - 0.1, FURN_TINT.bottleBlue) // bottle body
  b(0, 0.9 + (COOLER_H - 0.9) / 2, 0, 0.18, COOLER_H - 1.08, 0.18, FURN_TINT.bottleBlue) // neck
  b(0, 0.78, COOLER_W / 2 + 0.02, 0.1, 0.05, 0.05, FURN_TINT.legMetal) // tap
  b(0, 0.68, COOLER_W / 2 + 0.01, 0.2, 0.03, 0.06, FURN_TINT.slotDark) // drip tray
}

// --- Plant: clay pot (tapered), soil, crossed leaf slabs. ----------------
function plant(f, out) {
  const b = builder(f, out)
  b(0, 0.16, 0, PLANT_W - 0.08, 0.32, PLANT_W - 0.08, FURN_TINT.potClay) // pot base
  b(0, 0.35, 0, PLANT_W, 0.1, PLANT_W, FURN_TINT.potClay) // pot rim
  b(0, 0.4, 0, PLANT_W - 0.1, 0.04, PLANT_W - 0.1, FURN_TINT.soil)
  b(0, 0.42 + (PLANT_H - 0.42) / 2 - 0.08, 0, 0.07, PLANT_H - 0.5, 0.07, FURN_TINT.leafGreen) // stem
  b(0, PLANT_H - 0.3, 0, PLANT_W + 0.15, 0.16, 0.1, FURN_TINT.leafGreen) // leaf cross u
  b(0, PLANT_H - 0.18, 0, 0.1, 0.16, PLANT_W + 0.15, FURN_TINT.leafGreen) // leaf cross v
  b(0, PLANT_H - 0.06, 0, PLANT_W - 0.05, 0.14, 0.09, FURN_TINT.leafGreen) // top leaf
}

// --- Server rack: tall dark cabinet, slotted front, blinking-free LEDs. ----
function rack(f, out) {
  const b = builder(f, out)
  b(0, 0.05, 0, RACK_W - 0.06, 0.1, RACK_D - 0.04, FURN_TINT.legMetal) // kick
  b(0, RACK_H / 2 + 0.04, 0, RACK_W, RACK_H - 0.1, RACK_D, FURN_TINT.rackDark)
  // Front panel with horizontal ventilation slots.
  b(0, RACK_H / 2 + 0.04, RACK_D / 2 + 0.006, RACK_W - 0.1, RACK_H - 0.2, 0.015, FURN_TINT.rackFace)
  for (let s = 0; s < 5; s++) {
    b(0, 0.45 + s * 0.28, RACK_D / 2 + 0.016, RACK_W - 0.2, 0.05, 0.008, FURN_TINT.rackDark)
  }
  // Status LEDs down one edge — the only "alive" detail in the room.
  for (let s = 0; s < 3; s++) {
    b(-(RACK_W / 2 - 0.12), 0.6 + s * 0.42, RACK_D / 2 + 0.02, 0.04, 0.04, 0.01, FURN_TINT.ledGreen)
  }
}

const BUILDERS = {
  [FURN_DESK]: desk,
  [FURN_CHAIR]: chair,
  [FURN_TABLE]: table,
  [FURN_CABINET]: cabinet,
  [FURN_COPIER]: copier,
  [FURN_COOLER]: cooler,
  [FURN_PLANT]: plant,
  [FURN_RACK]: rack,
}

export function pushFurnitureModel(out, f) {
  BUILDERS[f.kind]?.(f, out)
  return out
}
