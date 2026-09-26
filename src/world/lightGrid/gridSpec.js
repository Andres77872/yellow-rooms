import {
  BRIDGE_GUARD_H,
  CELL,
  CHUNK,
  DOOR_H,
  LAYER_H,
  LIGHT_RANGE,
  SLAB_T,
  WALL_H,
  WINDOW_HEAD_Y,
  WINDOW_SILL_H,
} from '../constants.js'

// World-grid lighting contract (engine-improvement chapter 12 §4.1–4.2).
//
// The world is a thin-wall grid: walls lie on 3 m cell edges, fixtures sit at
// cell centres, and doorways never close. Every piece of static light
// visibility is therefore known at chunk-generation time, headless. This file
// is the single source of truth for how that knowledge is ENCODED — the CPU
// bake (LightGrid.js), the gameplay light query, and the GLSL decoders
// (render/shaders/grid.js) are all generated from the constants below, so the
// producer and every consumer move together (ADR-001 §3 "version all
// producers and consumers together").

// v2 (chapter 14): furniture occupancy texture; the owner texture is retired
// from the GPU (the edge texel's LOADED flag + floor tag carry ownership).
export const GRID_SCHEMA_VERSION = 2

// Toroidal residency window. Streaming keeps chunks within UNLOAD_RADIUS (5)
// of the player: at most 11 distinct chunk columns per axis, so a 12-chunk
// window can never alias two resident chunks horizontally. Vertically a floor
// slot is cy mod GRID_FLOORS; tall structures can exceed that span, so every
// slot records its owner and consumers validate it (ownerMatches()).
export const GRID_CHUNKS = 12
export const GRID_W = GRID_CHUNKS * CHUNK // 168 cells per axis
export const GRID_FLOORS = 6
export const GRID_H = GRID_W * GRID_FLOORS // texture rows (all floor slots stacked)

// Light-list shape: up to LIST_MAX fixtures per cell, ranked by
// visibility x attenuation. Each entry is 16 bits: a 10-bit relative lamp
// reference and a 6-bit visibility fraction. Two entries per uint32, so the
// whole list is ONE RGBA32UI texel — one fetch per pixel.
export const LIST_MAX = 8
export const LIST_UINTS = LIST_MAX / 2
export const REF_REACH = Math.ceil(LIGHT_RANGE / CELL) // 4 cells: 11 m / 3 m
export const REF_SPAN = REF_REACH * 2 + 1 // 9
export const REF_FLOOR_REACH = 2 // lamps two slabs away can still reach through a void
export const REF_EMPTY = 1023
export const VIS_BITS = 6
export const VIS_FULL = (1 << VIS_BITS) - 1 // 63: every sampled path open -> no per-pixel test

export function encodeRef(dx, dz, df) {
  return ((df + REF_FLOOR_REACH) * REF_SPAN + (dz + REF_REACH)) * REF_SPAN + (dx + REF_REACH)
}

export function decodeRef(ref, out = { dx: 0, dz: 0, df: 0 }) {
  out.dx = (ref % REF_SPAN) - REF_REACH
  out.dz = (Math.floor(ref / REF_SPAN) % REF_SPAN) - REF_REACH
  out.df = Math.floor(ref / (REF_SPAN * REF_SPAN)) - REF_FLOOR_REACH
  return out
}

export const packEntry = (ref, vis) => (ref & 1023) | ((vis & VIS_FULL) << 10)

// --- Edge codes ---------------------------------------------------------
// One code per cell edge. Each cell stores its WEST edge (line x = gx*CELL,
// spanning row gz) and NORTH edge (line z = gz*CELL, spanning column gx) —
// exactly the lines its chunk owns in ChunkData, so a chunk writes only its
// own texels. Heights are local to the floor (0 = floor surface).
export const EDGE_OPEN = 0 // no wall: room continuation / wide threshold
export const EDGE_WALL = 1 // solid full-height wall
export const EDGE_DOOR = 2 // doorway: open below the lintel (DOOR_H)
export const EDGE_WINDOW = 3 // sill + header solid; glazing transmits GLASS_T
export const EDGE_RAIL = 4 // bridge guard: solid below the rail, open above

export const GLASS_T = 0.82 // observation-window glazing transmission

// Opening [lo, hi] (floor-local metres) and transmission per code. A wall is
// an empty interval.
export const EDGE_OPENINGS = Object.freeze([
  Object.freeze({ lo: 0, hi: WALL_H, t: 1 }), // open
  Object.freeze({ lo: 0, hi: 0, t: 0 }), // wall
  Object.freeze({ lo: 0, hi: DOOR_H, t: 1 }), // door
  Object.freeze({ lo: WINDOW_SILL_H, hi: WINDOW_HEAD_Y, t: GLASS_T }), // window
  Object.freeze({ lo: BRIDGE_GUARD_H, hi: WALL_H, t: 1 }), // rail
])

// Transmission of a ray crossing an edge of `code` at floor-local height y.
export function edgeTransmission(code, y) {
  const o = EDGE_OPENINGS[code] ?? EDGE_OPENINGS[EDGE_WALL]
  return y >= o.lo && y <= o.hi ? o.t : 0
}

// Full-height open edges are the only ones a straight path may cross without
// a height test (the bounding-box fast path in LightGrid).
export const edgeFullyOpen = (code) => code === EDGE_OPEN

// --- Cell flags (edge texel B channel) -----------------------------------
export const FLAG_CEIL_HOLE = 1 // slab above this cell is open (stair run / atrium void)
export const FLAG_FLOOR_HOLE = 2 // slab below is open
export const FLAG_COLUMN = 4 // standard column at the cell centre
export const FLAG_PIER = 8 // monumental pier
export const FLAG_LAMP = 16 // a LIT fixture hangs in this cell
export const FLAG_LOADED = 128 // texel belongs to a resident, mapped chunk

// --- Fixtures -------------------------------------------------------------
// LAMP_Y is the legacy cast-light point 0.5 below the ceiling: the CPU bake,
// the baked list visibility and lightAt (gameplay) keep it. The renderer
// shades and shadows from the look's source height instead (the physically
// based looks use the visible emitter, EMITTER_Y). The emissive panel is a
// 1.7 x 1.0 plane with its long axis along world X.
export const LAMP_Y = WALL_H - 0.5
export const EMITTER_Y = WALL_H - 0.04
export const PANEL_HALF_X = 0.85
export const PANEL_HALF_Z = 0.5
// Radius of the disc with the panel's area (capsule-shadow light size).
export const PANEL_EQ_R = Math.sqrt((PANEL_HALF_X * 2 * PANEL_HALF_Z * 2) / Math.PI)
// The cell-graph GI sees fixtures from the emitter with a downward diffuser
// (only the physically based looks use GI): output at grazing.
export const GI_SOURCE_Y = EMITTER_Y
export const GI_EMIT_FLOOR = 0.03
// Lamp tint is stored as rgb * TINT_SCALE in RGBA8 (tints reach ~1.25 with
// the room-role multipliers).
export const TINT_SCALE = 0.8

// Flicker identity byte (lamp texel A): 0 = no fixture; bit 7 = bad tube;
// bits 0..6 hold a phase id (1..127). The shader re-derives phase and speed
// from it, so per-fixture flicker costs no per-frame upload.
export function encodeFlicker(bad, phaseId) {
  const p = 1 + (Math.abs(phaseId | 0) % 127)
  return (bad ? 128 : 0) | p
}

// --- Addressing -------------------------------------------------------------
export const imod = (a, n) => ((a % n) + n) % n
export const floorSlot = (cy) => imod(cy, GRID_FLOORS)
export const texelX = (gx) => imod(gx, GRID_W)
export const texelY = (gz, cy) => imod(gz, GRID_W) + floorSlot(cy) * GRID_W
export const texelIndex = (gx, gz, cy) => texelY(gz, cy) * GRID_W + texelX(gx)

// Chunk-owner table: one texel per (chunk column, floor slot).
export const OWNER_W = GRID_CHUNKS
export const OWNER_H = GRID_CHUNKS * GRID_FLOORS
export const ownerIndex = (cx, cy, cz) =>
  (imod(cz, GRID_CHUNKS) + floorSlot(cy) * GRID_CHUNKS) * OWNER_W + imod(cx, GRID_CHUNKS)
export const ownerTag = (v) => v & 255

// --- Furniture occupancy (chapter 14 P8) -----------------------------------
// One RGBA32UI texel per cell holds at most two proxy boxes of the furniture
// piece standing in it (world/objects/furniture/proxies.js) plus a mask of
// the furnished cells around it, so a pixel finds every box that can shadow
// it without searching:
//   x  box A: x0, x1, z0, z1 bytes, cell-local in CELL/255 units (rounded out)
//   y  A.y0, A.y1, B.y0, B.y1 bytes, floor-local centimetres (y1 = 0: no box)
//   z  box B xz, same layout as x
//   w  bits 0..24: furnished cells within ring 2, RING ORDER (bit 0 = own
//      cell, 1..8 = ring 1, 9..24 = ring 2); bits 25..27 A.t, 28..30 B.t
//      (light transmission in eighths)
// FURN_MARGIN (2) keeps furniture two cells off every chunk border, so ring
// 2 of any cell only ever meets furniture of its own chunk: masks never
// reference another chunk and need no invalidation when neighbours stream.
export const OCC_RING = 2
// Tallest proxy top (floor-local): rays from a receiver clear every piece of
// furniture above this height, which bounds the cells a light's shadow
// frustum can meet (world/objects/furniture/proxies.js must stay below it).
export const OCC_MAX_H = 2.1
export const OCC_CELLS = (OCC_RING * 2 + 1) ** 2 // 25
export const OCC_UNIT_XZ = CELL / 255
export const OCC_UNIT_Y = 0.01
export const OCC_T_SHIFT_A = 25
export const OCC_T_SHIFT_B = 28
export const OCC_MASK_BITS = (1 << OCC_CELLS) - 1

// Ring-ordered (dx, dz) offsets: own cell, ring 1, ring 2 (row-major within
// each ring). A per-light cap on gathered cells therefore always keeps the
// nearest cells first.
export const OCC_OFFSETS = Object.freeze(
  (() => {
    const out = [[0, 0]]
    for (let r = 1; r <= OCC_RING; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) === r) out.push([dx, dz])
        }
      }
    }
    return out.map((o) => Object.freeze(o))
  })()
)

// Mask bit of a ring offset, or -1 outside ring 2.
export function occMaskBit(dx, dz) {
  for (let i = 0; i < OCC_OFFSETS.length; i++) {
    if (OCC_OFFSETS[i][0] === dx && OCC_OFFSETS[i][1] === dz) return i
  }
  return -1
}

// Rectangle masks: COL_RANGE[(lo + 2) * 5 + (hi + 2)] has the bits of every
// ring cell whose dx lies in [lo, hi]; ROW_RANGE the same for dz. ANDing one
// of each selects the ring cells inside an XZ cell rectangle — the cells a
// light's shadow frustum can reach — with two table reads.
function rangeTable(axis) {
  const out = new Array(25).fill(0)
  for (let lo = -OCC_RING; lo <= OCC_RING; lo++) {
    for (let hi = lo; hi <= OCC_RING; hi++) {
      let m = 0
      OCC_OFFSETS.forEach((o, i) => {
        if (o[axis] >= lo && o[axis] <= hi) m |= 1 << i
      })
      out[(lo + OCC_RING) * 5 + (hi + OCC_RING)] = m >>> 0
    }
  }
  return Object.freeze(out)
}
export const OCC_COL_RANGE = rangeTable(0)
export const OCC_ROW_RANGE = rangeTable(1)

// Encode one cell-local AABB (metres relative to the cell's min
// corner, y floor-local) into the occupancy bytes, rounded OUTWARD so the
// proxy never shrinks below the model.
export function packOccBox(box) {
  const q = (v, up) => Math.max(0, Math.min(255, up ? Math.ceil(v / OCC_UNIT_XZ - 1e-6) : Math.floor(v / OCC_UNIT_XZ + 1e-6)))
  const qy = (v, up) => Math.max(0, Math.min(255, up ? Math.ceil(v / OCC_UNIT_Y - 1e-6) : Math.floor(v / OCC_UNIT_Y + 1e-6)))
  const xz = (q(box.x0, false) | (q(box.x1, true) << 8) | (q(box.z0, false) << 16) | (q(box.z1, true) << 24)) >>> 0
  const y0 = qy(box.y0, false)
  const y1 = Math.max(y0 + 1, qy(box.y1, true))
  return { xz, y: (y0 | (Math.min(255, y1) << 8)) >>> 0, t: Math.max(0, Math.min(7, box.t | 0)) }
}

export function decodeOccBox(xz, y16, t = 0) {
  if (((y16 >>> 8) & 255) === 0) return null
  return {
    x0: (xz & 255) * OCC_UNIT_XZ,
    x1: ((xz >>> 8) & 255) * OCC_UNIT_XZ,
    z0: ((xz >>> 16) & 255) * OCC_UNIT_XZ,
    z1: ((xz >>> 24) & 255) * OCC_UNIT_XZ,
    y0: (y16 & 255) * OCC_UNIT_Y,
    y1: ((y16 >>> 8) & 255) * OCC_UNIT_Y,
    t,
  }
}

// Floor containing a world height, biased so a surface sitting exactly on a
// floor plane or a ceiling underside resolves to the storey it belongs to.
export const floorOfY = (wy) => Math.floor((wy + 0.02) / LAYER_H)
export const SLAB_MID = WALL_H + SLAB_T * 0.5 // slab mid-plane above a floor

// Cell-graph GI texel layout: three RGBA16F texels per cell.
//   0: irradiance luminance on +X, -X, +Z, -Z facing surfaces
//   1: +Y lum, -Y lum, upper-hemisphere chroma r, g
//   2: upper chroma b, lower-hemisphere chroma r, g, b
export const GI_TEXELS = 3
