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
} from '../multilevel.js'

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
      panel: material,
      panelDead: material,
      exit: material,
    },
  }
}

function horizontalArea(geometry, normalY) {
  const p = geometry.attributes.position
  const n = geometry.attributes.normal
  let area = 0
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  const ab = new THREE.Vector3()
  const ac = new THREE.Vector3()
  for (let i = 0; i < p.count; i += 3) {
    if (Math.sign(n.getY(i)) !== Math.sign(normalY)) continue
    a.fromBufferAttribute(p, i)
    b.fromBufferAttribute(p, i + 1)
    c.fromBufferAttribute(p, i + 2)
    area += ab.subVectors(b, a).cross(ac.subVectors(c, a)).length() * 0.5
  }
  return area
}

function fasciaArea(geometry) {
  const p = geometry.attributes.position
  const n = geometry.attributes.normal
  let area = 0
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  const ab = new THREE.Vector3()
  const ac = new THREE.Vector3()
  for (let i = 0; i < p.count; i += 3) {
    if (Math.abs(n.getY(i)) > 1e-6) continue
    a.fromBufferAttribute(p, i)
    b.fromBufferAttribute(p, i + 1)
    c.fromBufferAttribute(p, i + 2)
    area += ab.subVectors(b, a).cross(ac.subVectors(c, a)).length() * 0.5
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

    const instances = mesh.group.children.find((child) => child.isInstancedMesh)
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
        expect(upperData.multilevelDown).toEqual(lowerData.multilevelUp)
        for (const { lx, lz } of lowerData.multilevelUp.voidCells) {
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
      expect(actualFascia).toBeCloseTo(boundaryEdges * CELL * SLAB_T, 4)

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
    expect(data.multilevelDown).not.toBeNull()
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
    const instancesAt = (edge) => {
      const wantedX = edge.axis === 'v' ? edge.line * CELL : (edge.cell + 0.5) * CELL
      const wantedZ = edge.axis === 'v' ? (edge.cell + 0.5) * CELL : edge.line * CELL
      const matrix = new THREE.Matrix4()
      const position = new THREE.Vector3(), quaternion = new THREE.Quaternion(), scale = new THREE.Vector3()
      const hits = []
      for (let i = 0; i < walls.count; i++) {
        walls.getMatrixAt(i, matrix)
        matrix.decompose(position, quaternion, scale)
        if (Math.abs(position.x - wantedX) < 1e-6 && Math.abs(position.z - wantedZ) < 1e-6) {
          const thin = edge.axis === 'v' ? scale.x : scale.z
          const along = edge.axis === 'v' ? scale.z : scale.x
          if (Math.abs(thin - THICK) < 1e-6 && Math.abs(along - CELL) < 1e-6) hits.push(scale.y)
        }
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
