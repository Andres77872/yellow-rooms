import { CHUNK_WORLD, CELL, layerY } from './constants.js'
import { generateChunk } from './generate.js'
import { latticeStructureSlice } from './structures/latticeStamp.js'
import { resolveMapFamily } from './mapFamily.js'
import { MAP_FAMILY_LATTICE } from './mapTypes.js'
import { buildChunkMeshes } from './mesh.js'
import {
  RENDER_DETAIL_FULL,
  RENDER_DETAIL_REDUCED,
  RENDER_DETAIL_SHELL,
  normalizeRenderDetailLevel,
} from './renderDetail.js'
import { buildStairCells } from './structures/stairCells.js'
import { validatedRuntimeStructure } from './structures/contract.js'

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
    if (!expected) return null
    // The slice cache makes recomputation return the stamped object itself;
    // the stringify comparison remains only for descriptors built elsewhere.
    if (
      slice !== expected &&
      JSON.stringify(slice) !== JSON.stringify(expected)
    ) return null
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
    this.renderParts = mesh.parts
    this.renderDetail = RENDER_DETAIL_FULL
    this.stairCells = buildStairCells(this.data, cx, cy, cz)
    this.structure = this.data.structure

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

  // Lower only decorative child batches; the chunk group remains under the
  // cross-floor visibility contract owned by ChunkManager. Shell geometry,
  // emissive cues, live fixtures and the exit anomaly are never hidden.
  setRenderDetail(level) {
    const next = normalizeRenderDetailLevel(level)
    if (next === this.renderDetail) return false

    const reduced = next === RENDER_DETAIL_REDUCED
    const shell = next === RENDER_DETAIL_SHELL
    const lattice = this.data.mapFamily === MAP_FAMILY_LATTICE
    const p = this.renderParts

    // Lattice frames include guard-rail caps and posts, so its reduced tier
    // retains that silhouette while other families shed ornamental joinery.
    if (p.frames) p.frames.visible = next === RENDER_DETAIL_FULL || (lattice && reduced)
    if (p.props) p.props.visible = next === RENDER_DETAIL_FULL
    if (p.deadPanels) p.deadPanels.visible = next === RENDER_DETAIL_FULL
    if (p.leaves) p.leaves.visible = !shell
    if (p.furniture) p.furniture.visible = !shell

    // These references are explicit rather than inferred from child order so
    // a future mesh batch cannot accidentally enter an LOD tier.
    if (p.floor) p.floor.visible = true
    if (p.ceiling) p.ceiling.visible = true
    if (p.walls) p.walls.visible = true
    if (p.signs) p.signs.visible = true
    if (p.litPanels) p.litPanels.visible = true
    if (p.exit) p.exit.visible = true

    this.renderDetail = next
    return true
  }

  // Chunk geometry is immutable after construction. Attach first so the
  // cached world matrices include the complete parent chain, then disable
  // Three's local composition and world-matrix multiplication for this static
  // subtree. Visibility changes remain valid because they do not touch
  // transforms.
  mount(parent) {
    parent.add(this.group)
    this.group.updateWorldMatrix(true, true)
    this.group.traverse((object) => {
      object.matrixAutoUpdate = false
      object.matrixWorldAutoUpdate = false
    })
  }

  _registerStructureAperture(seed, config) {
    const structure = this.data.structure
    const slice = this.data.structureUp
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
