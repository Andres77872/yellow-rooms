import { CHUNK, WORLD_GEN_VERSION, vIdx, hIdx, cIdx } from './constants.js'
import {
  CELL_OPEN,
  PASSAGE_OPEN,
  PASSAGE_WALL,
  PASSAGE_WIDE,
} from './mapTypes.js'

// Plain, serializable chunk state — the thin-wall model. No THREE here, so the
// whole generation graph runs headless under Vitest. Meshing (mesh.js) reads
// this and builds geometry; collision/AI read it through ChunkManager queries.
//
// Walls live on cell EDGES (see constants.js vIdx/hIdx). Passage metadata says
// whether an absent wall is a room continuation, door, or wide threshold.
// Columns occupy cell centres and never change thin-wall connectivity, but the
// navigation validator treats their blocking AABBs as part of walkability.
export class ChunkData {
  constructor(cx, cz, zone, version = WORLD_GEN_VERSION) {
    this.version = version
    this.cx = cx
    this.cz = cz
    this.zone = zone
    this.wallV = new Uint8Array(CHUNK * CHUNK) // 1 = vertical wall on a grid line
    this.wallH = new Uint8Array(CHUNK * CHUNK) // 1 = horizontal wall on a grid line
    // Semantic edge metadata. Keeping this beside the collision bytes means a
    // one-cell opening can be distinguished as a door, room continuation or
    // transition mouth without inspecting neighbouring raster cells.
    this.passageV = new Uint8Array(CHUNK * CHUNK).fill(PASSAGE_OPEN)
    this.passageH = new Uint8Array(CHUNK * CHUNK).fill(PASSAGE_OPEN)
    this.cols = new Uint8Array(CHUNK * CHUNK) // 1 = freestanding column at cell centre
    this.cellKind = new Uint8Array(CHUNK * CHUNK).fill(CELL_OPEN)
    this.spaceId = new Uint32Array(CHUNK * CHUNK)
    this.repairs = { connectivity: 0, navigation: 0, columns: 0 }
    this.lamps = [] // [{lx, lz, lit}] — ceiling fixtures on a global module grid
    this.exit = null // {lx, lz} | null
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
  setV(lx, z, v, passage = v ? PASSAGE_WALL : PASSAGE_OPEN) {
    const i = vIdx(lx, z)
    this.wallV[i] = v
    this.passageV[i] = passage
  }
  setH(x, lz, v, passage = v ? PASSAGE_WALL : PASSAGE_OPEN) {
    const i = hIdx(x, lz)
    this.wallH[i] = v
    this.passageH[i] = passage
  }
  setPassageV(lx, z, passage) {
    this.setV(lx, z, passage === PASSAGE_WALL ? 1 : 0, passage)
  }
  setPassageH(x, lz, passage) {
    this.setH(x, lz, passage === PASSAGE_WALL ? 1 : 0, passage)
  }
  setCol(x, z, v) {
    this.cols[cIdx(x, z)] = v
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

  // Force an open clearing around (lx,lz): delete columns and open every
  // INTERIOR wall edge within Chebyshev radius r. Only ever opens edges
  // (monotone) so it can never disconnect the graph; it also opens the ring of
  // edges to the surrounding cells, so the clearing always joins the chunk's
  // (already connected) open set. Never touches the owned border lines (0).
  carveClearing(lx, lz, r = 1) {
    for (let z = lz - r; z <= lz + r; z++) {
      for (let x = lx - r; x <= lx + r; x++) {
        if (x < 0 || x >= CHUNK || z < 0 || z >= CHUNK) continue
        this.setCol(x, z, 0)
        if (x >= 1) this.setV(x, z, 0, this.clearingPassageV(x, z))
        if (x + 1 <= CHUNK - 1) {
          this.setV(x + 1, z, 0, this.clearingPassageV(x + 1, z))
        }
        if (z >= 1) this.setH(x, z, 0, this.clearingPassageH(x, z))
        if (z + 1 <= CHUNK - 1) {
          this.setH(x, z + 1, 0, this.clearingPassageH(x, z + 1))
        }
      }
    }
  }
}
