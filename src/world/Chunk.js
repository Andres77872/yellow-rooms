import { CHUNK_WORLD, CELL, layerY } from './constants.js'
import { generateChunk } from './generate.js'
import { latticeStructureSlice } from './latticeStamp.js'
import { resolveMapFamily } from './mapFamily.js'
import { MAP_FAMILY_LATTICE } from './mapTypes.js'
import { buildChunkMeshes } from './mesh.js'
import { buildStairCells } from './stairCells.js'
import { validatedRuntimeStructure } from './structureAdapters.js'

function worldApertureRegion(region, cx, cz) {
  return {
    minX: cx * CHUNK_WORLD + region.x0 * CELL,
    maxX: cx * CHUNK_WORLD + region.x1 * CELL,
    minZ: cz * CHUNK_WORLD + region.z0 * CELL,
    maxZ: cz * CHUNK_WORLD + region.z1 * CELL,
  }
}

function canonicalLatticeApertureSlice(
  structure,
  slice,
  cx,
  cy,
  cz,
  config
) {
  try {
    const profile = resolveMapFamily(config)
    if (profile.family !== MAP_FAMILY_LATTICE || !Object.isFrozen(slice)) {
      return null
    }
    const expected = latticeStructureSlice(structure, cx, cz, cy, profile)
    if (!expected || JSON.stringify(slice) !== JSON.stringify(expected)) return null
    return expected
  } catch {
    return null
  }
}

// Lattice slabs can expose many non-rectangular void cells. Preserve the
// existing multilevel aperture kind and exact cell footprint, coalescing only
// adjacent cells on the same row into deterministic half-open local regions.
function latticeApertureRegions(slice) {
  const regions = []
  let current = null
  for (const { lx, lz } of slice.voidCells) {
    if (current && current.z0 === lz && current.x1 === lx) {
      current.x1 = lx + 1
      continue
    }
    current = { x0: lx, z0: lz, x1: lx + 1, z1: lz + 1 }
    regions.push(current)
  }
  return regions
}

function structureApertureRegions(
  adapter,
  slice,
  structure,
  cx,
  cy,
  cz,
  config
) {
  const regions = adapter.apertureRegions(slice)
  if (Array.isArray(regions) && regions.length > 0) return regions
  if (adapter.family !== MAP_FAMILY_LATTICE) return regions

  const canonical = canonicalLatticeApertureSlice(
    structure,
    slice,
    cx,
    cy,
    cz,
    config
  )
  return canonical ? latticeApertureRegions(canonical) : []
}

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
    // a point-like centre; multilevel rooms expose exact void regions around
    // retained bridges. Feeds light, sight and visibility gating.
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
    this._registerStructureAperture(seed, config)
  }

  _registerStructureAperture(seed, config) {
    const structure = this.data.multilevelStructure
    const slice = this.data.multilevelUp
    if (!structure || !slice) return

    const validated = validatedRuntimeStructure(
      seed,
      config,
      structure,
      this.cy
    )
    if (!validated) return
    const { adapter, ownership } = validated
    if (!adapter.validateSlice(slice, structure, { ownership }).ok) return

    const localRegions = structureApertureRegions(
      adapter,
      slice,
      structure,
      this.cx,
      this.cy,
      this.cz,
      config
    )
    if (!Array.isArray(localRegions) || localRegions.length === 0) return
    const regions = localRegions.map((region) =>
      worldApertureRegion(region, this.cx, this.cz)
    )
    const minX = Math.min(...regions.map((region) => region.minX))
    const maxX = Math.max(...regions.map((region) => region.maxX))
    const minZ = Math.min(...regions.map((region) => region.minZ))
    const maxZ = Math.max(...regions.map((region) => region.maxZ))

    this.apertures.push({
      kind: 'multilevel',
      id: slice.id,
      centerX: (minX + maxX) / 2,
      centerZ: (minZ + maxZ) / 2,
      minX,
      maxX,
      minZ,
      maxZ,
      regions,
      lowerCy: slice.lowerCy,
      baseCy: slice.baseCy,
      topCy: slice.topCy,
      structureKind: slice.kind,
    })
  }

  dispose() {
    this._mesh.dispose()
  }
}
