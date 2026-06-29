import { CHUNK_WORLD } from './constants.js'
import { generateChunk } from './generate.js'
import { buildChunkMeshes } from './mesh.js'

// A single streamed chunk: its deterministic ChunkData (thin-wall model) plus
// the THREE meshes that render it. Generation and meshing are now separate
// modules; this class just owns them and the per-chunk lifetime.
export class Chunk {
  constructor(cx, cz, seed, materials, geom, exitCell, config, clearings) {
    this.cx = cx
    this.cz = cz
    this.data = generateChunk(seed, cx, cz, config, exitCell, clearings)

    const mesh = buildChunkMeshes(this.data, geom, materials, cx * CHUNK_WORLD, cz * CHUNK_WORLD)
    this.group = mesh.group
    this.lamps = mesh.lamps // world Vector3 of LIT lamps (for the light pool)
    this.exitWorld = mesh.exitWorld
    this._mesh = mesh
  }

  dispose() {
    this._mesh.dispose()
  }
}
