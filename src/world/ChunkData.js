import { CHUNK, WORLD_GEN_VERSION, vIdx, hIdx, cIdx } from './constants.js'

// Plain, serializable chunk state — the thin-wall model. No THREE here, so the
// whole generation graph runs headless under Vitest. Meshing (mesh.js) reads
// this and builds geometry; collision/AI read it through ChunkManager queries.
//
// Walls live on cell EDGES (see constants.js vIdx/hIdx). A doorway is simply the
// absence of a wall (value 0). Columns occupy cell centres and block a small
// AABB but never a cell edge (so they never affect graph connectivity).
export class ChunkData {
  constructor(cx, cz, zone) {
    this.version = WORLD_GEN_VERSION
    this.cx = cx
    this.cz = cz
    this.zone = zone
    this.wallV = new Uint8Array(CHUNK * CHUNK) // 1 = vertical wall on a grid line
    this.wallH = new Uint8Array(CHUNK * CHUNK) // 1 = horizontal wall on a grid line
    this.cols = new Uint8Array(CHUNK * CHUNK) // 1 = freestanding column at cell centre
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
  setV(lx, z, v) {
    this.wallV[vIdx(lx, z)] = v
  }
  setH(x, lz, v) {
    this.wallH[hIdx(x, lz)] = v
  }
  setCol(x, z, v) {
    this.cols[cIdx(x, z)] = v
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
        if (x >= 1) this.setV(x, z, 0) // west edge of cell (line x)
        if (x + 1 <= CHUNK - 1) this.setV(x + 1, z, 0) // east edge (line x+1)
        if (z >= 1) this.setH(x, z, 0) // north edge of cell (line z)
        if (z + 1 <= CHUNK - 1) this.setH(x, z + 1, 0) // south edge (line z+1)
      }
    }
  }
}
