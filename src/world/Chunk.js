import { CHUNK_WORLD, CELL, layerY } from './constants.js'
import { generateChunk } from './generate.js'
import { buildChunkMeshes } from './mesh.js'
import { buildStairCells } from './stairCells.js'

// A single streamed chunk: its deterministic ChunkData (thin-wall model) plus
// the THREE meshes that render it. Generation and meshing are now separate
// modules; this class just owns them and the per-chunk lifetime. v8: a chunk
// is one floor slab of the layered world, keyed (cx, cy, cz).
export class Chunk {
  constructor(cx, cy, cz, seed, materials, geom, exitCell, config, clearings) {
    this.cx = cx
    this.cy = cy
    this.cz = cz
    this.data = generateChunk(seed, cx, cy, cz, config, exitCell, clearings)

    const mesh = buildChunkMeshes(
      this.data,
      geom,
      materials,
      cx * CHUNK_WORLD,
      layerY(cy),
      cz * CHUNK_WORLD
    )
    this.group = mesh.group
    this.lamps = mesh.lamps // world Vector3 of LIT lamps (for the light pool), tagged .cy
    this.exitWorld = mesh.exitWorld
    this._mesh = mesh
    this.stairCells = buildStairCells(this.data, cx, cy, cz)

    // Stair apertures through this chunk's CEILING (slab cy): the world-space
    // centre of the two hole cells. Feeds the light-spill filter and the
    // aperture-gated visibility in ChunkManager.
    this.apertures = []
    const up = this.data.stairUp
    if (up) {
      this.apertures.push({
        centerX: cx * CHUNK_WORLD + ((up.run[0].lx + up.run[1].lx) / 2 + 0.5) * CELL,
        centerZ: cz * CHUNK_WORLD + ((up.run[0].lz + up.run[1].lz) / 2 + 0.5) * CELL,
        lowerCy: cy,
      })
    }
  }

  dispose() {
    this._mesh.dispose()
  }
}
