import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { buildChunk } from '../pipeline.js'
import { buildChunkMeshes } from '../mesh.js'
import { ChunkData } from '../ChunkData.js'
import { DEFAULT_WORLD_CONFIG } from '../config.js'
import { createGeometries, disposeGeometries } from '../../render/geometries.js'
import {
  BRIDGE_BEAM_H,
  BRIDGE_BEAM_W,
  BRIDGE_GUARD_H,
  CELL,
  CHUNK,
  CHUNK_WORLD,
  COL_HALF,
  LAYER_H,
  MONUMENTAL_COL_HALF,
  SLAB_T,
  WALL_BEVEL,
  THICK,
  WALL_H,
  WINDOW_HEAD_Y,
  WINDOW_SILL_H,
  layerY,
} from '../constants.js'
import {
  COLUMN_MONUMENTAL,
  COLUMN_STANDARD,
  WALL_RAIL,
  WALL_WINDOW,
} from '../mapTypes.js'
import {
  multilevelBandBase,
  multilevelConfig,
  multilevelContract,
} from '../structures/multilevel.js'

const cfg = structuredClone(DEFAULT_WORLD_CONFIG)
cfg.stairs.chance = 1
cfg.multilevel.enabled = false

function structureConfig(kind = 'bridged', levels = 15) {
  const config = structuredClone(DEFAULT_WORLD_CONFIG)
  config.multilevel.bridgeChance = kind === 'bridged' ? 1 : 0
  config.multilevel.minLevels = levels
  config.multilevel.maxLevels = levels
  return config
}

function districtStructure(seed, districtX, districtZ, levelCy, config) {
  const K = multilevelConfig(config).districtChunks
  const baseCy = multilevelBandBase(
    seed,
    districtX * K,
    districtZ * K,
    levelCy,
    config
  )
  for (let dz = 0; dz < K; dz++) {
    for (let dx = 0; dx < K; dx++) {
      const structure = multilevelContract(
        seed,
        districtX * K + dx,
        districtZ * K + dz,
        baseCy,
        config
      )
      if (structure.hasRoom) return structure
    }
  }
  throw new Error('expected structure')
}

function materials() {
  const material = new THREE.MeshBasicMaterial()
  return {
    material,
    all: {
      carpet: material,
      ceiling: material,
      wallpaper: material,
      doorFrame: material,
      doorLeaf: material,
      prop: material,
      signGlow: material,
      furniture: material,
      panel: material,
      panelDead: material,
      exit: material,
    },
  }
}

// Geometric (winding) normal of triangle i, unnormalised: |n| = 2 x area.
function faceNormal(p, i, out) {
  const a = new THREE.Vector3().fromBufferAttribute(p, i)
  const b = new THREE.Vector3().fromBufferAttribute(p, i + 1)
  const c = new THREE.Vector3().fromBufferAttribute(p, i + 2)
  return out.subVectors(b, a).cross(c.sub(a))
}

// Area of the faces turned toward normalY (+1 up, -1 down), projected onto
// the horizontal plane: a slab underside covers its solid cells exactly once,
// whether a stretch of it is flat or rounds up into a hole's nosing.
function horizontalArea(geometry, normalY) {
  const p = geometry.attributes.position
  const n = new THREE.Vector3()
  let area = 0
  for (let i = 0; i < p.count; i += 3) {
    faceNormal(p, i, n)
    if (n.y * normalY > 1e-9) area += Math.abs(n.y) * 0.5
  }
  return area
}

// Area of the exactly vertical faces: the hole skirts above their nosings.
function fasciaArea(geometry) {
  const p = geometry.attributes.position
  const n = new THREE.Vector3()
  let area = 0
  for (let i = 0; i < p.count; i += 3) {
    faceNormal(p, i, n)
    if (Math.abs(n.y) <= 1e-6 * n.length()) area += n.length() * 0.5
  }
  return area
}

describe('3D chunk mesh / slab ownership', () => {
  it('meshes ordinary posts and monumental piers at distinct physical widths', () => {
    const geom = createGeometries()
    const { material, all } = materials()
    const data = new ChunkData(0, 0, 0, 0)
    data.setCol(2, 2, COLUMN_STANDARD)
    data.setCol(6, 6, COLUMN_MONUMENTAL)
    const mesh = buildChunkMeshes(data, geom, all, 0, 0, 0)
    const instances = mesh.group.children.find((child) => child.isInstancedMesh)
    const matrix = new THREE.Matrix4()
    const position = new THREE.Vector3()
    const quaternion = new THREE.Quaternion()
    const scale = new THREE.Vector3()
    const widths = []
    for (let i = 0; i < instances.count; i++) {
      instances.getMatrixAt(i, matrix)
      matrix.decompose(position, quaternion, scale)
      widths.push(scale.x)
    }
    widths.sort((a, b) => a - b)
    expect(widths[0]).toBeCloseTo(COL_HALF * 2, 6)
    expect(widths[1]).toBeCloseTo(MONUMENTAL_COL_HALF * 2, 6)
    mesh.dispose()
    disposeGeometries(geom)
    material.dispose()
  })

  it('punches identical two-cell apertures in the lower ceiling and upper floor', () => {
    const geom = createGeometries()
    const { material, all } = materials()
    const lowerData = buildChunk(7, 1, 0, 1, cfg)
    const upperData = buildChunk(7, 1, 1, 1, cfg)
    expect(lowerData.stairUp).toEqual(upperData.stairDown)

    const lower = buildChunkMeshes(lowerData, geom, all, 0, layerY(0), 0)
    const upper = buildChunkMeshes(upperData, geom, all, 0, layerY(1), 0)
    const lowerCeiling = lower.group.children[1]
    const upperFloor = upper.group.children[0]
    const expectedArea = CHUNK_WORLD * CHUNK_WORLD - 2 * CELL * CELL
    expect(horizontalArea(lowerCeiling.geometry, -1)).toBeCloseTo(expectedArea, 6)
    expect(horizontalArea(upperFloor.geometry, 1)).toBeCloseTo(expectedArea, 6)

    // The slab-owner's inward rim closes the complete WALL_H..LAYER_H cut.
    const ys = lowerCeiling.geometry.attributes.position.array.filter((_, i) => i % 3 === 1)
    expect(Math.min(...ys)).toBeCloseTo(WALL_H, 6)
    expect(Math.max(...ys)).toBeCloseTo(LAYER_H, 6)
    expect(lower.group.position.y + LAYER_H).toBe(upper.group.position.y)

    lower.dispose()
    upper.dispose()
    disposeGeometries(geom)
    material.dispose()
  })

  it('renders the owned flight flush with the upper floor and disposes punched geometry', () => {
    const geom = createGeometries()
    const { material, all } = materials()
    const data = buildChunk(12345, -2, -1, 3, cfg)
    expect(data.stairUp).not.toBeNull()
    const mesh = buildChunkMeshes(data, geom, all, 0, layerY(-1), 0)
    const ceiling = mesh.group.children[1]
    let disposed = 0
    ceiling.geometry.addEventListener('dispose', () => disposed++)

    const instances = mesh.parts.stairs
    expect(instances.geometry).toBe(geom.stairUnit)
    const matrix = new THREE.Matrix4()
    const position = new THREE.Vector3()
    const quaternion = new THREE.Quaternion()
    const scale = new THREE.Vector3()
    let maxTop = -Infinity
    for (let i = 0; i < instances.count; i++) {
      instances.getMatrixAt(i, matrix)
      matrix.decompose(position, quaternion, scale)
      maxTop = Math.max(maxTop, position.y + scale.y * 0.5)
    }
    expect(maxTop).toBeCloseTo(LAYER_H, 6)

    mesh.dispose()
    expect(disposed).toBe(1)
    disposeGeometries(geom)
    material.dispose()
  })

  it('meshes maximum-height bridge and open apertures without chunk-seam fascia', () => {
    const geom = createGeometries()
    const { material, all } = materials()
    const seed = 1337
    for (const kind of ['bridged', 'openVoid']) {
      const config = structureConfig(kind, 15)
      const structure = districtStructure(seed, 0, -2, 0, config)
      const levelCy = structure.baseCy + 1
      const lowerCy = structure.baseCy
      const lowerMeshes = []
      const upperMeshes = []
      const holes = new Set()
      let horizontalCeiling = 0
      let horizontalFloor = 0
      let actualFascia = 0
      for (const { cx, cz } of structure.participants) {
        const lowerData = buildChunk(seed, cx, lowerCy, cz, config)
        const upperData = buildChunk(seed, cx, levelCy, cz, config)
        expect(upperData.structureDown).toEqual(lowerData.structureUp)
        for (const { lx, lz } of lowerData.structureUp.voidCells) {
          holes.add(`${cx * CHUNK + lx},${cz * CHUNK + lz}`)
        }
        const lower = buildChunkMeshes(
          lowerData,
          geom,
          all,
          cx * CHUNK_WORLD,
          layerY(lowerCy),
          cz * CHUNK_WORLD
        )
        const upper = buildChunkMeshes(
          upperData,
          geom,
          all,
          cx * CHUNK_WORLD,
          layerY(levelCy),
          cz * CHUNK_WORLD
        )
        lowerMeshes.push(lower)
        upperMeshes.push(upper)
        horizontalCeiling += horizontalArea(lower.group.children[1].geometry, -1)
        horizontalFloor += horizontalArea(upper.group.children[0].geometry, 1)
        actualFascia += fasciaArea(lower.group.children[1].geometry)
      }
      const expectedArea =
        2 * CHUNK_WORLD * CHUNK_WORLD - holes.size * CELL * CELL
      expect(horizontalCeiling).toBeCloseTo(expectedArea, 6)
      expect(horizontalFloor).toBeCloseTo(expectedArea, 6)

      // Count boundaries in GLOBAL coordinates. No edge at the participant seam
      // is counted when the void continues on its other side.
      let boundaryEdges = 0
      for (const key of holes) {
        const [gx, gz] = key.split(',').map(Number)
        for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          if (!holes.has(`${gx + dx},${gz + dz}`)) boundaryEdges++
        }
      }
      expect(actualFascia).toBeCloseTo(boundaryEdges * CELL * (SLAB_T - WALL_BEVEL), 4)

      for (const mesh of [...lowerMeshes, ...upperMeshes]) mesh.dispose()
    }
    disposeGeometries(geom)
    material.dispose()
  })

  it('replaces feature walls with window openings and low bridge guards', () => {
    const geom = createGeometries()
    const wallpaper = new THREE.MeshBasicMaterial()
    const trim = new THREE.MeshBasicMaterial()
    const surface = new THREE.MeshBasicMaterial()
    const all = {
      carpet: surface,
      ceiling: surface,
      wallpaper,
      doorFrame: trim,
      doorLeaf: trim,
      panel: surface,
      panelDead: surface,
      exit: surface,
    }
    const config = structureConfig('bridged', 15)
    const seed = 1337
    const structure = districtStructure(seed, 0, -2, 0, config)
    const levelCy = structure.bridgeLevels[0]
    const host = structure.participants.find(({ cx, cz }) => {
      const data = buildChunk(seed, cx, levelCy, cz, config)
      return data.wallFeatureV.includes(WALL_WINDOW) &&
        (data.wallFeatureV.includes(WALL_RAIL) || data.wallFeatureH.includes(WALL_RAIL))
    })
    expect(host).toBeTruthy()
    const data = buildChunk(seed, host.cx, levelCy, host.cz, config)
    expect(data.structureDown).not.toBeNull()
    const mesh = buildChunkMeshes(
      data,
      geom,
      all,
      host.cx * CHUNK_WORLD,
      layerY(levelCy),
      host.cz * CHUNK_WORLD
    )
    const walls = mesh.group.children.find((child) => child.isInstancedMesh && child.material === wallpaper)
    expect(walls).toBeTruthy()

    const findFeature = (wanted) => {
      for (let z = 0; z < CHUNK; z++) {
        for (let line = 0; line < CHUNK; line++) {
          if (data.wallFeatureVAt(line, z) === wanted) return { axis: 'v', line, cell: z }
          if (data.wallFeatureHAt(z, line) === wanted) return { axis: 'h', line, cell: z }
        }
      }
      return null
    }
    // Wall pieces are run-merged (objects/wallShell.js): collect the heights
    // of the THICK-deep boxes on the edge's plane that span the whole edge.
    const instancesAt = (edge) => {
      const vertical = edge.axis === 'v'
      const plane = edge.line * CELL
      const a0 = edge.cell * CELL
      const a1 = (edge.cell + 1) * CELL
      const matrix = new THREE.Matrix4()
      const position = new THREE.Vector3(), quaternion = new THREE.Quaternion(), scale = new THREE.Vector3()
      const hits = []
      for (let i = 0; i < walls.count; i++) {
        walls.getMatrixAt(i, matrix)
        matrix.decompose(position, quaternion, scale)
        const across = vertical ? position.x : position.z
        const thin = vertical ? scale.x : scale.z
        const centre = vertical ? position.z : position.x
        const half = (vertical ? scale.z : scale.x) / 2
        if (Math.abs(across - plane) > 1e-6 || Math.abs(thin - THICK) > 1e-6) continue
        if (centre - half <= a0 + 1e-6 && centre + half >= a1 - 1e-6) hits.push(scale.y)
      }
      return hits.sort((a, b) => a - b)
    }
    const windowHeights = instancesAt(findFeature(WALL_WINDOW))
    const expectedWindowHeights = [
      WALL_H - WINDOW_HEAD_Y,
      WINDOW_SILL_H,
    ].sort((a, b) => a - b)
    expect(windowHeights).toHaveLength(expectedWindowHeights.length)
    for (let i = 0; i < windowHeights.length; i++) {
      expect(windowHeights[i]).toBeCloseTo(expectedWindowHeights[i], 5)
    }
    const railHeights = instancesAt(findFeature(WALL_RAIL))
    expect(railHeights).toHaveLength(1)
    expect(railHeights[0]).toBeCloseTo(BRIDGE_GUARD_H, 5)

    mesh.dispose(); disposeGeometries(geom); wallpaper.dispose(); trim.dispose(); surface.dispose()
  })

  it('continues both support beams across the chunk seam and omits them for open shafts', () => {
    const geom = createGeometries()
    const { material, all } = materials()
    const seed = 771
    const bridgedConfig = structureConfig('bridged', 15)
    const bridged = districtStructure(seed, -1, 1, 0, bridgedConfig)
    const lowerCy = bridged.bridgeLevels[0] - 1
    let beams = 0
    let alongLength = 0

    for (const { cx, cz } of bridged.participants) {
      const data = buildChunk(seed, cx, lowerCy, cz, bridgedConfig)
      const mesh = buildChunkMeshes(data, geom, all, 0, layerY(lowerCy), 0)
      const walls = mesh.group.children.find((child) => child.isInstancedMesh)
      const matrix = new THREE.Matrix4()
      const position = new THREE.Vector3()
      const quaternion = new THREE.Quaternion()
      const scale = new THREE.Vector3()
      for (let i = 0; i < walls.count; i++) {
        walls.getMatrixAt(i, matrix)
        matrix.decompose(position, quaternion, scale)
        if (Math.abs(scale.y - BRIDGE_BEAM_H) > 1e-6) continue
        const cross = bridged.bridgeAxis === 'x' ? scale.z : scale.x
        if (Math.abs(cross - BRIDGE_BEAM_W) > 1e-6) continue
        beams++
        alongLength += bridged.bridgeAxis === 'x' ? scale.x : scale.z
      }
      mesh.dispose()
    }
    expect(beams).toBe(4)
    expect(alongLength).toBeCloseTo(bridged.longSpan * CELL * 2, 6)

    const openConfig = structureConfig('openVoid', 15)
    const open = districtStructure(seed, 1, -2, 0, openConfig)
    for (const { cx, cz } of open.participants) {
      const data = buildChunk(seed, cx, open.baseCy, cz, openConfig)
      const mesh = buildChunkMeshes(data, geom, all, 0, layerY(open.baseCy), 0)
      const walls = mesh.group.children.find((child) => child.isInstancedMesh)
      const matrix = new THREE.Matrix4()
      const position = new THREE.Vector3()
      const quaternion = new THREE.Quaternion()
      const scale = new THREE.Vector3()
      let found = 0
      for (let i = 0; i < walls.count; i++) {
        walls.getMatrixAt(i, matrix)
        matrix.decompose(position, quaternion, scale)
        if (Math.abs(scale.y - BRIDGE_BEAM_H) < 1e-6) found++
      }
      expect(found).toBe(0)
      mesh.dispose()
    }
    disposeGeometries(geom)
    material.dispose()
  })
})
