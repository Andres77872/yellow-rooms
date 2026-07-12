import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { buildChunk } from '../pipeline.js'
import { buildChunkMeshes } from '../mesh.js'
import { DEFAULT_WORLD_CONFIG } from '../config.js'
import { createGeometries, disposeGeometries } from '../../render/geometries.js'
import { CELL, CHUNK_WORLD, LAYER_H, WALL_H, layerY } from '../constants.js'

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
})
