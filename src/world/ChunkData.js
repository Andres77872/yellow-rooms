import { CHUNK, WORLD_GEN_VERSION, vIdx, hIdx, cIdx } from './constants.js'
import {
  CELL_OPEN,
  MAP_FAMILY_OFFICE,
  PASSAGE_OPEN,
  PASSAGE_WALL,
  PASSAGE_WIDE,
  WALL_PLAIN,
} from './mapTypes.js'
import { lethalVoidCellAt } from './structureAdapters.js'

function stairHoleAt(stair, lx, lz) {
  return !!stair?.run?.some((cell) => cell.lx === lx && cell.lz === lz)
}

// Each multilevel slab descriptor carries its exact chunk-local void mask.
// Tall structures can use a different bridge line on every storey (or no
// bridge at all), so a rectangle-minus-one-line shortcut is no longer enough.
// Keeping the mask on the canonical descriptor still lets independently
// generated floor halves derive identical holes without another mutable raster.
function multilevelHoleAt(room, lx, lz) {
  if (!room?.hasRoom || !Array.isArray(room.voidCells)) return false
  return room.voidCells.some((cell) => cell.lx === lx && cell.lz === lz)
}

// Plain, serializable chunk state — the thin-wall model. No THREE here, so the
// whole generation graph runs headless under Vitest. Meshing (mesh.js) reads
// this and builds geometry; collision/AI read it through ChunkManager queries.
//
// Walls live on cell EDGES (see constants.js vIdx/hIdx). Passage metadata says
// whether an absent wall is a room continuation, door, or wide threshold.
// Columns occupy cell centres and never change thin-wall connectivity, but the
// navigation validator treats their blocking AABBs as part of walkability.
//
// v8: a chunk is one FLOOR of the layered world, keyed (cx, cy, cz). Stairs
// through the slabs above/below are realized by the stair stamp (stairStamp.js)
// from the shared slab contracts (slab.js); the descriptors are recorded here
// and the slab holes are DERIVED from them (hasCeilHole/hasFloorHole) so the
// raster and the descriptor can never drift apart.
export class ChunkData {
  constructor(
    cx,
    cy,
    cz,
    zone,
    version = WORLD_GEN_VERSION,
    mapFamily = MAP_FAMILY_OFFICE
  ) {
    this.version = version
    this.cx = cx
    this.cy = cy
    this.cz = cz
    // Family identity is carried independently from zone identity. Keeping it
    // explicit prevents future office-compatible families from being inferred
    // from shared zone or descriptor vocabulary.
    this.mapFamily = mapFamily
    this.zone = zone
    this.wallV = new Uint8Array(CHUNK * CHUNK) // 1 = vertical wall on a grid line
    this.wallH = new Uint8Array(CHUNK * CHUNK) // 1 = horizontal wall on a grid line
    // Semantic edge metadata. Keeping this beside the collision bytes means a
    // one-cell opening can be distinguished as a door, room continuation or
    // transition mouth without inspecting neighbouring raster cells.
    this.passageV = new Uint8Array(CHUNK * CHUNK).fill(PASSAGE_OPEN)
    this.passageH = new Uint8Array(CHUNK * CHUNK).fill(PASSAGE_OPEN)
    // Visual/sight refinement for CLOSED edges. WALL_PLAIN is the default;
    // windows and bridge rails remain wall=1 + PASSAGE_WALL for collision.
    this.wallFeatureV = new Uint8Array(CHUNK * CHUNK).fill(WALL_PLAIN)
    this.wallFeatureH = new Uint8Array(CHUNK * CHUNK).fill(WALL_PLAIN)
    // Column kind at a cell centre: 0 none, 1 standard post, 2 monumental pier.
    this.cols = new Uint8Array(CHUNK * CHUNK)
    this.cellKind = new Uint8Array(CHUNK * CHUNK).fill(CELL_OPEN)
    this.spaceId = new Uint32Array(CHUNK * CHUNK)
    // SPACE_ROLE_* per cell (mapTypes.js): the district plan's semantic room
    // roles, compiled alongside spaceId. Dressing-only; topology never reads it.
    this.spaceRole = new Uint8Array(CHUNK * CHUNK)
    this.repairs = { connectivity: 0, navigation: 0, columns: 0 }
    this.lamps = [] // [{lx, lz, lit}] — ceiling fixtures on a global module grid
    // Collision-real furniture (furniture.js). One record per occupied cell:
    //   { kind, lx, lz, x, z, w, d, facing }
    // x/z are CHUNK-LOCAL centre coordinates; w/d the axis-aligned extents
    // (already rotated by `facing`, which only steers asymmetric render
    // details). The owning cell also carries COLUMN_FURNITURE in cols, so
    // navigation/maps/audits block it; the player sweeps the precise AABB.
    this.furniture = []
    this.exit = null // {lx, lz} | null
    // Stair halves this layer realizes (slab contracts; see stairStamp.js):
    // stairUp pierces this chunk's CEILING (slab cy), stairDown its FLOOR
    // (slab cy-1). Shape: {dir, landing:{lx,lz}, run:[{..},{..}], exit:{lx,lz}}.
    this.stairUp = null
    this.stairDown = null
    // Sole canonical carrier for the bounded Sewer family. It remains null for
    // office and every other family; generators must not introduce wrapper
    // aliases that would let pipeline, digest, and audit consumers drift.
    this.sewerDescriptor = null
    // Global immutable descriptor for the tall structure intersecting this
    // chunk/floor, if any. Runtime streaming uses its participant chunks and
    // inclusive vertical range without widening the world's normal Y radius.
    this.multilevelStructure = null
    // Canonical per-slab slices of a possibly tall structure. `multilevelUp`
    // describes this layer's ceiling and `multilevelDown` its floor. Middle
    // storeys legitimately own both. Rectilinear Office/Tower slices retain a
    // single bridge line; Lattice slices instead carry derived bridgeSegments
    // while the same voidCells mask remains the slab-hole authority.
    this.multilevelUp = null
    this.multilevelDown = null
    // Descriptor-scoped lethal slab halves. A lower layer owns `Up` for its
    // ceiling; the layer above owns the byte-equal `Down` half for its floor.
    // Null remains the only default for Office, Sewer, and unstamped families.
    this.lethalVoidUp = null
    this.lethalVoidDown = null
    // Edges the stair stamp owns (guard walls AND mouths). Transient — not
    // serialized, not digested — carves check these so a later exit/spawn
    // clearing can never re-open a guard wall or re-wall a stair mouth.
    this._protV = new Set()
    this._protH = new Set()
  }

  vAt(lx, z) {
    return this.wallV[vIdx(lx, z)]
  }
  hAt(x, lz) {
    return this.wallH[hIdx(x, lz)]
  }
  colAt(x, z) {
    return this.cols[cIdx(x, z)]
  }
  passageVAt(lx, z) {
    return this.passageV[vIdx(lx, z)]
  }
  passageHAt(x, lz) {
    return this.passageH[hIdx(x, lz)]
  }
  wallFeatureVAt(lx, z) {
    return this.wallFeatureV[vIdx(lx, z)]
  }
  wallFeatureHAt(x, lz) {
    return this.wallFeatureH[hIdx(x, lz)]
  }
  setV(lx, z, v, passage = v ? PASSAGE_WALL : PASSAGE_OPEN, feature = WALL_PLAIN) {
    const i = vIdx(lx, z)
    this.wallV[i] = v
    this.passageV[i] = passage
    this.wallFeatureV[i] = v ? feature : WALL_PLAIN
  }
  setH(x, lz, v, passage = v ? PASSAGE_WALL : PASSAGE_OPEN, feature = WALL_PLAIN) {
    const i = hIdx(x, lz)
    this.wallH[i] = v
    this.passageH[i] = passage
    this.wallFeatureH[i] = v ? feature : WALL_PLAIN
  }
  setPassageV(lx, z, passage) {
    this.setV(lx, z, passage === PASSAGE_WALL ? 1 : 0, passage)
  }
  setPassageH(x, lz, passage) {
    this.setH(x, lz, passage === PASSAGE_WALL ? 1 : 0, passage)
  }
  setCol(x, z, v) {
    this.cols[cIdx(x, z)] = v
    // Clearing a cell (late anomaly/exit carves) also drops any furniture it
    // hosted, so a carved clearing never keeps a ghost desk without its
    // navigation blocker.
    if (!v && this.furniture.length) {
      this.furniture = this.furniture.filter((f) => f.lx !== x || f.lz !== z)
    }
  }

  // --- Slab holes (derived from the stair descriptors, never rasterized) ---
  // The ceiling of this layer is holed over its up-stair's run cells; the
  // floor over its down-stair's run cells (those are the same world openings,
  // seen from below and above).

  hasCeilHole(lx, lz) {
    return stairHoleAt(this.stairUp, lx, lz) ||
      multilevelHoleAt(this.multilevelUp, lx, lz) ||
      lethalVoidCellAt(this, 'up', lx, lz) !== null
  }

  hasFloorHole(lx, lz) {
    return stairHoleAt(this.stairDown, lx, lz) ||
      multilevelHoleAt(this.multilevelDown, lx, lz) ||
      lethalVoidCellAt(this, 'down', lx, lz) !== null
  }

  // --- Protected edges (stair stamp ownership) ---

  protectV(lx, z) {
    this._protV.add(vIdx(lx, z))
  }
  protectH(x, lz) {
    this._protH.add(hIdx(x, lz))
  }

  clearingPassageV(lx, z) {
    if (lx <= 0 || lx >= CHUNK) return PASSAGE_OPEN
    const west = this.spaceId[cIdx(lx - 1, z)]
    const east = this.spaceId[cIdx(lx, z)]
    return west && east && west !== east ? PASSAGE_WIDE : PASSAGE_OPEN
  }

  clearingPassageH(x, lz) {
    if (lz <= 0 || lz >= CHUNK) return PASSAGE_OPEN
    const north = this.spaceId[cIdx(x, lz - 1)]
    const south = this.spaceId[cIdx(x, lz)]
    return north && south && north !== south ? PASSAGE_WIDE : PASSAGE_OPEN
  }

  // Force-open every INTERIOR wall edge touching the cell rect [x0..x1]x[z0..z1]
  // and delete its columns. Monotone (only ever opens edges) so it can never
  // disconnect the graph; it also opens the ring of edges to the surrounding
  // cells, so the opened pocket always joins the chunk's (already connected)
  // open set. Never touches the owned border lines (0) or protected edges.
  carveRect(x0, z0, x1, z1) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        if (x < 0 || x >= CHUNK || z < 0 || z >= CHUNK) continue
        this.setCol(x, z, 0)
        if (x >= 1 && !this._protV.has(vIdx(x, z))) {
          this.setV(x, z, 0, this.clearingPassageV(x, z))
        }
        if (x + 1 <= CHUNK - 1 && !this._protV.has(vIdx(x + 1, z))) {
          this.setV(x + 1, z, 0, this.clearingPassageV(x + 1, z))
        }
        if (z >= 1 && !this._protH.has(hIdx(x, z))) {
          this.setH(x, z, 0, this.clearingPassageH(x, z))
        }
        if (z + 1 <= CHUNK - 1 && !this._protH.has(hIdx(x, z + 1))) {
          this.setH(x, z + 1, 0, this.clearingPassageH(x, z + 1))
        }
      }
    }
  }

  // Force an open clearing around (lx,lz) within Chebyshev radius r (exit and
  // spawn anomalies). Same monotone guarantees as carveRect.
  carveClearing(lx, lz, r = 1) {
    this.carveRect(lx - r, lz - r, lx + r, lz + r)
  }
}
