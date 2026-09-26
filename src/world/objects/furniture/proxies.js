import { CELL } from '../../constants.js'
import {
  FURN_DESK,
  FURN_CHAIR,
  FURN_TABLE,
  FURN_CABINET,
  FURN_COPIER,
  FURN_COOLER,
  FURN_PLANT,
  FURN_RACK,
  FURN_SOFA,
  FURN_BOOKSHELF,
  FURN_WHITEBOARD,
  FURN_BED,
  FURN_NIGHTSTAND,
  FURN_WARDROBE,
  FURN_TOILET,
  FURN_SINK,
  FURN_TUB,
  FURN_COUNTER,
  FURN_STOVE,
  FURN_FRIDGE,
  FURN_TV,
  FURN_ARMCHAIR,
  FURN_WASHER,
} from '../../furniture.js'

// Furniture shadow proxies (P8) — at most two axis-aligned boxes per kind
// that stand in for the rendered piece when the renderer casts exact analytic
// fixture shadows from a per-cell occupancy texture. THREE-free.
//
// Fitted to the Blender GLBs AS RENDERED (public/models/furniture/*.glb via
// render/furnitureModels.js + world/mesh.js), not to the procedural box
// builders: mesh.js instances each GLB with scale 1, translation (f.x, 0, f.z)
// and a rotY by facing that reproduces frame.js, so the GLB's own x/z/y axes
// ARE the builders' local u/v/y (u = width, v = depth, front toward +v, y up
// from the floor, origin at the footprint centre). Until the GLBs load, and
// permanently when one fails, mesh.js draws the procedural builders instead;
// those share the same constants.js dimensions, so the proxies still bound
// them closely, but the IoU guarantees below are measured on the GLBs.
//
// Box contract: { u0, u1, v0, v1, y0, y1, t } in metres, local frame.
//   t — light transmission in eighths (integer 0..7, 0 = opaque) for volumes
//       light genuinely passes through (a leg frame, foliage). Solid parts are
//       t = 0 even where bevels or a tilt leave their box partly empty: that
//       is silhouette error, not transmission. Non-zero t is derived from the
//       GLB geometry clipped to the box: t = round(8 * (1 - c)), c = the
//       lowest of its three axis-projected coverages.
//   Box A (first) has the largest opacity-weighted silhouette (top + front +
//   side projected area x (1 - t/8)); the low quality tier casts A only.
//
// Fit: 2 cm orthographic silhouettes (top, front, side) of the GLB vs the
// boxes with t < 5, coordinates snapped to the GLB's own vertex coordinates.
// Pieces open underneath get a slab-style box (the top as rendered) unless a
// solid block scores higher from the sides without losing the top ("alt" =
// the rejected variant's front-back / left-right IoU). IoU columns are the
// test's minimum over all four facings (src/world/__tests__/
// furniture-proxies.test.js); f/b = front+back views, l/r = left+right.
//
//   kind        A (y m)                B (y m)                  t    top  f/b  l/r  choice
//   desk        body .04-.78           monitor .951-1.319       0,0  .99  .72  .80  solid [1]
//   chair       seat .409-.532         back .562-.938           0,0  .85  .74  .52* slab (alt .57/.39)
//   table       top+apron .585-.74     leg frame 0-.585         0,7  1.0  .73  .57* slab (alt .27/.33)
//   cabinet     case+doors 0-1.858     -                        0    .99  .99  .97  solid [2]
//   copier      body 0-1.055           tray to v +.46           0,0  1.0  .96  .95  solid
//   cooler      base 0-.925            bottle .925-1.395        0,0  .89  .91  .94  solid
//   plant       pot 0-.38              canopy core .38-.83      0,3  .84  .76  .81  dense core [3]
//   rack        case 0-1.905           -                        0    1.0  1.0  .99  solid
//   sofa        base+arms .11-.67      back .67-.909            0,0  .99  .97  .89  slab (alt .85/.81)
//   bookshelf   case 0-1.858           -                        0    1.0  .97  .90  solid (back panel)
//   whiteboard  panel .65-1.85         marker tray .632-.675    0,0  1.0  .98  .97  -
//   bed         deck+mattress .19-.601 headboard .08-1.19       0,0  .99  .97  .87  slab (alt .92/.65)
//   nightstand  case 0-.6              lamp shade .75-.88       0,0  1.0  .91  .89  solid
//   wardrobe    case 0-2.05            -                        0    .99  .94  .95  solid
//   toilet      bowl 0-.512            cistern .43-.8           0,0  .89  .80  .84  solid pedestal
//   sink        vanity+basin 0-.888    mirror 1.188-1.98        0,0  .96  .92  .79  solid
//   tub         shell 0-.562           -                        0    1.0  .99  .98  solid
//   counter     cabinet 0-.9           backsplash .9-1.08       0,0  .99  .97  .93  solid
//   stove       range 0-.883           backguard .883-1.14      0,0  .94  .99  .96  solid
//   fridge      cabinet 0-1.84         -                        0    .99  .99  .97  solid [2]
//   tv          console 0-.505         panel .7-1.38            0,0  .98  .87  .88  solid [4]
//   armchair    base+arms .11-.67      back .67-.909            0,0  .96  .93  .90  slab (alt .83/.81)
//   washer      cabinet 0-.85          -                        0    .97  .99  .96  solid
//   [1] full-depth end panels + a modesty panel close the desk's sides (alt
//       slab+pedestal .33/.90, slab+monitor .28/.10, solid+pedestal .57/.84:
//       the monitor beats the pedestal). y0 .04 is the pedestal plinth: the
//       knee opening drops a floor-touching block's f/b to .68.
//   [2] door face; the thin handles (cabinet +.267, fridge +.418) left out.
//   [3] leaf cards: the core carries the canopy, the sparse tips stay out.
//   [4] the sled feet fill the side view (alt slab .95/.75).
//   *   documented per-kind floor in the test. Two boxes cannot hold four
//       corner legs or a star base + post: the only pairs that score higher
//       spend box B on ONE leg (table l/r .74) — a lone, asymmetric shadow.
const box = (u0, u1, v0, v1, y0, y1, t = 0) => Object.freeze({ u0, u1, v0, v1, y0, y1, t })

export const FURNITURE_PROXIES = Object.freeze({
  [FURN_DESK]: Object.freeze([
    box(-0.835, 0.835, -0.425, 0.425, 0.04, 0.78),
    box(-0.51, 0.11, -0.204, -0.116, 0.951, 1.319),
  ]),
  [FURN_CHAIR]: Object.freeze([
    box(-0.246, 0.246, -0.252, 0.237, 0.409, 0.532),
    box(-0.224, 0.224, -0.261, -0.12, 0.562, 0.938),
  ]),
  [FURN_TABLE]: Object.freeze([
    box(-1.1, 1.1, -0.55, 0.55, 0.585, 0.74),
    box(-1.03, 1.03, -0.48, 0.48, 0, 0.585, 7),
  ]),
  [FURN_CABINET]: Object.freeze([
    box(-0.475, 0.475, -0.225, 0.25, 0, 1.858),
  ]),
  [FURN_COPIER]: Object.freeze([
    box(-0.425, 0.425, -0.35, 0.364, 0, 1.055),
    box(-0.31, 0.31, 0.34, 0.46, 0.596, 0.624),
  ]),
  [FURN_COOLER]: Object.freeze([
    box(-0.21, 0.21, -0.21, 0.21, 0, 0.925),
    box(-0.15, 0.15, -0.146, 0.146, 0.925, 1.395),
  ]),
  [FURN_PLANT]: Object.freeze([
    box(-0.185, 0.185, -0.185, 0.185, 0, 0.38),
    box(-0.2, 0.09, -0.11, 0.09, 0.38, 0.83, 3),
  ]),
  [FURN_RACK]: Object.freeze([
    box(-0.45, 0.45, -0.35, 0.368, 0, 1.905),
  ]),
  [FURN_SOFA]: Object.freeze([
    box(-0.8, 0.8, -0.377, 0.345, 0.11, 0.67),
    box(-0.64, 0.64, -0.396, 0.007, 0.67, 0.909),
  ]),
  [FURN_BOOKSHELF]: Object.freeze([
    box(-0.595, 0.595, -0.19, 0.19, 0, 1.858),
  ]),
  [FURN_WHITEBOARD]: Object.freeze([
    box(-0.935, 0.935, -0.028, 0.032, 0.65, 1.85),
    box(-0.7, 0.7, 0, 0.101, 0.632, 0.675),
  ]),
  [FURN_BED]: Object.freeze([
    box(-0.783, 0.783, -1.06, 1.072, 0.19, 0.601),
    box(-0.77, 0.77, -1.06, -0.945, 0.08, 1.19),
  ]),
  [FURN_NIGHTSTAND]: Object.freeze([
    box(-0.25, 0.25, -0.25, 0.25, 0, 0.6),
    box(-0.14, 0.065, -0.111, 0.083, 0.75, 0.88),
  ]),
  [FURN_WARDROBE]: Object.freeze([
    box(-0.655, 0.655, -0.33, 0.337, 0, 2.05),
  ]),
  [FURN_TOILET]: Object.freeze([
    box(-0.187, 0.187, -0.105, 0.25, 0, 0.512),
    box(-0.235, 0.235, -0.37, -0.105, 0.43, 0.8),
  ]),
  [FURN_SINK]: Object.freeze([
    box(-0.375, 0.375, -0.25, 0.255, 0, 0.888),
    box(-0.36, 0.36, -0.255, -0.215, 1.188, 1.98),
  ]),
  [FURN_TUB]: Object.freeze([
    box(-0.825, 0.825, -0.375, 0.375, 0, 0.562),
  ]),
  [FURN_COUNTER]: Object.freeze([
    box(-0.645, 0.645, -0.325, 0.325, 0, 0.9),
    box(-0.645, 0.645, -0.325, -0.147, 0.9, 1.08),
  ]),
  [FURN_STOVE]: Object.freeze([
    box(-0.325, 0.325, -0.325, 0.34, 0, 0.883),
    box(-0.325, 0.325, -0.32, -0.27, 0.883, 1.14),
  ]),
  [FURN_FRIDGE]: Object.freeze([
    box(-0.375, 0.375, -0.36, 0.367, 0, 1.84),
  ]),
  [FURN_TV]: Object.freeze([
    box(-0.73, 0.73, -0.225, 0.241, 0, 0.505),
    box(-0.62, 0.62, -0.125, -0.04, 0.7, 1.38),
  ]),
  [FURN_ARMCHAIR]: Object.freeze([
    box(-0.46, 0.425, -0.425, 0.395, 0.11, 0.67),
    box(-0.285, 0.285, -0.446, -0.102, 0.67, 0.909),
  ]),
  [FURN_WASHER]: Object.freeze([
    box(-0.31, 0.31, -0.31, 0.34, 0, 0.85),
  ]),
})

// Tallest proxy top (the wardrobe cornice, 2.05 m): the occupancy texture's
// vertical range. Derived from the table so a retuned proxy can't outgrow it.
export const OCC_MAX_H = Math.max(
  ...Object.values(FURNITURE_PROXIES).flatMap((boxes) => boxes.map((b) => b.y1))
)

// Append the chunk-local world AABBs { x0, x1, y0, y1, z0, z1, t } of
// placement record `f` (kind, x, z, facing, lx, lz) to `out`; returns how
// many were appended (0 for an unknown kind). u/v map through the facing
// frame of objects/furniture/frame.js — 0=+z 1=-z 2=+x 3=-x, the same
// rotation mesh.js applies to the GLB instance — and every box is clamped to
// the piece's own cell [lx*CELL, (lx+1)*CELL] x [lz*CELL, (lz+1)*CELL], so a
// proxy can never shadow a neighbouring cell's occupancy slot. y is metres
// above the piece's floor (the chunk layer's floor, like the GLB instance).
export function furnitureProxyBoxes(f, out) {
  const boxes = FURNITURE_PROXIES[f.kind]
  if (!boxes) return 0
  // Records always carry their cell (furnish.js addPiece, the editor, the
  // .yrmap reader); the fallback derives it from the centre like placement.
  const cx0 = (f.lx ?? Math.floor(f.x / CELL)) * CELL
  const cz0 = (f.lz ?? Math.floor(f.z / CELL)) * CELL
  let n = 0
  for (const b of boxes) {
    let x0, x1, z0, z1
    switch (f.facing & 3) {
      case 1: // (u, v) -> (-u, -v)
        x0 = -b.u1; x1 = -b.u0; z0 = -b.v1; z1 = -b.v0
        break
      case 2: // (u, v) -> (v, -u)
        x0 = b.v0; x1 = b.v1; z0 = -b.u1; z1 = -b.u0
        break
      case 3: // (u, v) -> (-v, u)
        x0 = -b.v1; x1 = -b.v0; z0 = b.u0; z1 = b.u1
        break
      default: // (u, v) -> (u, v)
        x0 = b.u0; x1 = b.u1; z0 = b.v0; z1 = b.v1
    }
    x0 = Math.max(cx0, f.x + x0)
    x1 = Math.min(cx0 + CELL, f.x + x1)
    z0 = Math.max(cz0, f.z + z0)
    z1 = Math.min(cz0 + CELL, f.z + z1)
    if (x1 <= x0 || z1 <= z0) continue // wholly outside its cell: nothing to cast
    out.push({ x0, x1, y0: b.y0, y1: b.y1, z0, z1, t: b.t })
    n++
  }
  return n
}
