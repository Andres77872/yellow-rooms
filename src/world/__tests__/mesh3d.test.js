import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { buildChunk } from '../pipeline.js'
import { buildChunkMeshes } from '../mesh.js'
import { DEFAULT_WORLD_CONFIG } from '../config.js'
import { createGeometries, disposeGeometries } from '../../render/geometries.js'
import {
  BRIDGE_GUARD_H,
  CELL,
  CHUNK,
  CHUNK_WORLD,
  LAYER_H,
  SLAB_T,
  THICK,
  WALL_H,
  WINDOW_HEAD_Y,
  WINDOW_SILL_H,
  layerY,
} from '../constants.js'
import { WALL_RAIL, WALL_WINDOW } from '../mapTypes.js'

const cfg = {
  ...DEFAULT_WORLD_CONFIG,
  stairs: { ...DEFAULT_WORLD_CONFIG.stairs, chance: 1 },
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

describe('3D chunk mesh / slab ownership', () => {
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

  it('meshes an irregular atrium mask around its retained bridge without sealing it', () => {
    const geom = createGeometries()
    const { material, all } = materials()
    const lowerData = buildChunk(1337, 2, 0, -7, DEFAULT_WORLD_CONFIG)
    const upperData = buildChunk(1337, 2, 1, -7, DEFAULT_WORLD_CONFIG)
    const room = lowerData.multilevelUp
    expect(room).not.toBeNull()
    expect(upperData.multilevelDown).toEqual(room)

    const lower = buildChunkMeshes(lowerData, geom, all, 0, 0, 0)
    const upper = buildChunkMeshes(upperData, geom, all, 0, LAYER_H, 0)
    const expectedArea = CHUNK_WORLD * CHUNK_WORLD - room.voidCells.length * CELL * CELL
    expect(horizontalArea(lower.group.children[1].geometry, -1)).toBeCloseTo(expectedArea, 6)
    expect(horizontalArea(upper.group.children[0].geometry, 1)).toBeCloseTo(expectedArea, 6)

    // Each hole/solid cell edge owns one vertical slab fascia. Bridge sides
    // count as solid boundaries, proving the two void lobes were not collapsed
    // into the old bounding rectangle.
    const holes = new Set(room.voidCells.map(({ lx, lz }) => `${lx},${lz}`))
    let boundaryEdges = 0
    for (const { lx, lz } of room.voidCells) {
      for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        if (!holes.has(`${lx + dx},${lz + dz}`)) boundaryEdges++
      }
    }
    const ceiling = lower.group.children[1].geometry
    const p = ceiling.attributes.position
    const n = ceiling.attributes.normal
    let fasciaArea = 0
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
    const ab = new THREE.Vector3(), ac = new THREE.Vector3()
    for (let i = 0; i < p.count; i += 3) {
      if (Math.abs(n.getY(i)) > 1e-6) continue
      a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2)
      fasciaArea += ab.subVectors(b, a).cross(ac.subVectors(c, a)).length() * 0.5
    }
    expect(fasciaArea).toBeCloseTo(boundaryEdges * CELL * SLAB_T, 4)

    lower.dispose(); upper.dispose(); disposeGeometries(geom); material.dispose()
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
    const data = buildChunk(1337, 2, 1, -7, DEFAULT_WORLD_CONFIG)
    expect(data.multilevelDown).not.toBeNull()
    const mesh = buildChunkMeshes(data, geom, all, 0, LAYER_H, 0)
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
})
