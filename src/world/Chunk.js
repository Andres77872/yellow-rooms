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
    this.multilevelStructure = this.data.multilevelStructure

    // Vertical openings through this chunk's CEILING (slab cy). Stairs expose
    // a point-like centre; multilevel rooms expose the exact two void lobes on
    // either side of their bridge. Feeds light, sight and visibility gating.
    this.apertures = []
    const up = this.data.stairUp
    if (up) {
      const centerX = cx * CHUNK_WORLD + ((up.run[0].lx + up.run[1].lx) / 2 + 0.5) * CELL
      const centerZ = cz * CHUNK_WORLD + ((up.run[0].lz + up.run[1].lz) / 2 + 0.5) * CELL
      this.apertures.push({
        kind: 'stair',
        id: `stair:${cx},${cy},${cz}`,
        centerX,
        centerZ,
        minX: centerX,
        maxX: centerX,
        minZ: centerZ,
        maxZ: centerZ,
        regions: [{ minX: centerX, maxX: centerX, minZ: centerZ, maxZ: centerZ }],
        lowerCy: cy,
      })
    }
    const room = this.data.multilevelUp
    if (room) {
      const { x0, z0, x1, z1 } = room.bounds
      const minX = cx * CHUNK_WORLD + x0 * CELL
      const maxX = cx * CHUNK_WORLD + (x1 + 1) * CELL
      const minZ = cz * CHUNK_WORLD + z0 * CELL
      const maxZ = cz * CHUNK_WORLD + (z1 + 1) * CELL
      let regions
      if (room.globalBridgeLine === null) {
        regions = [{ minX, maxX, minZ, maxZ }]
      } else if (room.bridgeAxis === 'x') {
        const split0 = cz * CHUNK_WORLD + room.bridgeLine * CELL
        const split1 = split0 + CELL
        regions = [
          { minX, maxX, minZ, maxZ: split0 },
          { minX, maxX, minZ: split1, maxZ },
        ].filter((region) => region.minZ < region.maxZ)
      } else {
        const split0 = cx * CHUNK_WORLD + room.bridgeLine * CELL
        const split1 = split0 + CELL
        regions = [
          { minX, maxX: split0, minZ, maxZ },
          { minX: split1, maxX, minZ, maxZ },
        ].filter((region) => region.minX < region.maxX)
      }
      this.apertures.push({
        kind: 'multilevel',
        id: room.id,
        centerX: (minX + maxX) / 2,
        centerZ: (minZ + maxZ) / 2,
        minX,
        maxX,
        minZ,
        maxZ,
        regions,
        lowerCy: room.lowerCy,
        baseCy: room.baseCy,
        topCy: room.topCy,
        structureKind: room.kind,
      })
    }
  }

  dispose() {
    this._mesh.dispose()
  }
}
