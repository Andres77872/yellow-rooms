import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import {
  BEVEL_GLSL,
  bevelDepthMaterial,
  bevelUnitPosition,
  createBevelBoxGeometry,
  createBevelPrismGeometry,
} from '../bevel.js'
import { BEVEL_DETAIL, BEVEL_FRAC, BEVEL_STAIR, BEVEL_WALL, LAYER_H, THICK, WALL_BEVEL, WALL_H } from '../../world/constants.js'

// Decode every vertex the way the vertex stage does, in WORLD units for an
// instance of size `scale` centred at height `centreY` (chunk-local).
function decoded(geo, scale, centreY = 10) {
  const pos = geo.attributes.position
  const bev = geo.attributes.bevel
  const out = []
  for (let i = 0; i < pos.count; i++) {
    const p = bevelUnitPosition(
      [pos.getX(i), pos.getY(i), pos.getZ(i)],
      [bev.getX(i), bev.getY(i), bev.getZ(i), bev.getW(i)],
      scale,
      centreY
    )
    out.push(new THREE.Vector3(p[0] * scale[0], p[1] * scale[1], p[2] * scale[2]))
  }
  return out
}

function triangles(geo) {
  const idx = geo.index.array
  const out = []
  for (let i = 0; i < idx.length; i += 3) out.push([idx[i], idx[i + 1], idx[i + 2]])
  return out
}

function signedVolume(points, tris) {
  let v = 0
  for (const [a, b, c] of tris) v += points[a].dot(new THREE.Vector3().crossVectors(points[b], points[c]))
  return v / 6
}

// Every geometric edge (positions welded) is shared by exactly two
// triangles: the decoded surface is watertight.
function weldedEdgeCounts(points, tris) {
  const key = (p) => `${Math.round(p.x * 1e6)},${Math.round(p.y * 1e6)},${Math.round(p.z * 1e6)}`
  const counts = new Map()
  for (const t of tris) {
    const k = t.map((i) => key(points[i]))
    if (k[0] === k[1] || k[1] === k[2] || k[0] === k[2]) continue // collapsed
    for (let e = 0; e < 3; e++) {
      const edge = [k[e], k[(e + 1) % 3]].sort().join('|')
      counts.set(edge, (counts.get(edge) ?? 0) + 1)
    }
  }
  return [...counts.values()]
}

describe('bevelled unit boxes', () => {
  it('keeps positions on the sharp unit-box corners for attribute-blind consumers', () => {
    for (const geo of [createBevelPrismGeometry(BEVEL_WALL), createBevelBoxGeometry(BEVEL_DETAIL)]) {
      const pos = geo.attributes.position
      for (let i = 0; i < pos.count; i++) {
        for (const v of [pos.getX(i), pos.getY(i), pos.getZ(i)]) expect(Math.abs(v)).toBe(0.5)
      }
      expect(geo.boundingBox.min.toArray()).toEqual([-0.5, -0.5, -0.5])
      expect(geo.boundingBox.max.toArray()).toEqual([0.5, 0.5, 0.5])
      // Read without the bevel, the mesh is exactly the unit cube.
      const sharp = []
      for (let i = 0; i < pos.count; i++) sharp.push(new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)))
      expect(signedVolume(sharp, triangles(geo))).toBeCloseTo(1, 9)
      geo.dispose()
    }
  })

  it('rounds a stretched wall run at a constant world radius, vertical edges only', () => {
    const geo = createBevelPrismGeometry(BEVEL_WALL)
    const scale = [THICK, WALL_H, 12]
    const pts = decoded(geo, scale)
    const tris = triangles(geo)
    expect(weldedEdgeCounts(pts, tris).every((n) => n === 2)).toBe(true)
    // Two-segment arcs: the section loses 4 r^2 (1 - sin 45deg).
    const r = WALL_BEVEL
    const area = scale[0] * scale[2] - 4 * r * r * (1 - Math.SQRT1_2)
    expect(signedVolume(pts, tris)).toBeCloseTo(area * scale[1], 6)
    // Feet and heads stay flat: no vertex leaves the y = +-H/2 planes.
    for (const p of pts) expect(Math.abs(Math.abs(p.y) - WALL_H / 2)).toBeLessThan(1e-9)
    // The extreme corner pulls in by r on each axis, never more.
    const xs = pts.map((p) => Math.abs(p.x))
    expect(Math.max(...xs)).toBeCloseTo(THICK / 2, 9)
    expect(Math.min(...xs)).toBeCloseTo(THICK / 2 - r, 9)
    geo.dispose()
  })

  it('caps the radius by the box size, and the wall pieces get WALL_BEVEL', () => {
    expect(WALL_BEVEL).toBeCloseTo(Math.min(BEVEL_WALL, BEVEL_FRAC * THICK), 12)
    // r < THICK/2 is the joint rule the wall shell depends on.
    expect(BEVEL_FRAC).toBeLessThan(0.5)
    expect(WALL_BEVEL).toBeLessThan(THICK / 2)
    const geo = createBevelPrismGeometry(BEVEL_WALL)
    const column = decoded(geo, [0.8, WALL_H, 0.8])
    const minX = Math.min(...column.map((p) => Math.abs(p.x)))
    expect(minX).toBeCloseTo(0.4 - BEVEL_WALL, 6) // column hits the cap
    geo.dispose()
  })

  it('chamfers all twelve edges of a free-floating detail box, outward and watertight', () => {
    const geo = createBevelBoxGeometry(BEVEL_DETAIL)
    const scale = [0.6, 0.3, 0.2]
    const pts = decoded(geo, scale)
    const tris = triangles(geo)
    expect(weldedEdgeCounts(pts, tris).every((n) => n === 2)).toBe(true)
    const r = BEVEL_DETAIL
    const full = scale[0] * scale[1] * scale[2]
    const vol = signedVolume(pts, tris)
    expect(vol).toBeLessThan(full)
    // 12 edge prisms of r^2/2 cross-section, minus the corners they double count.
    const edges = (r * r) / 2 * 4 * (scale[0] + scale[1] + scale[2] - 6 * r)
    expect(vol).toBeGreaterThan(full - edges - 8 * r * r * r)
    // Each triangle faces the way its vertex normals do.
    const nrm = geo.attributes.normal
    for (const [a, b, c] of tris) {
      const face = new THREE.Vector3().subVectors(pts[b], pts[a]).cross(new THREE.Vector3().subVectors(pts[c], pts[a]))
      if (face.lengthSq() < 1e-14) continue
      const n = new THREE.Vector3()
      for (const i of [a, b, c]) n.add(new THREE.Vector3(nrm.getX(i), nrm.getY(i), nrm.getZ(i)))
      expect(face.dot(n)).toBeGreaterThan(0)
    }
    geo.dispose()
  })

  it('keeps faces that rest on the floor or meet the ceiling square', () => {
    const geo = createBevelBoxGeometry(BEVEL_DETAIL)
    const board = [3, 0.14, 0.22]
    const onFloor = decoded(geo, board, 0.07)
    // Every foot vertex stays on the floor plane; the top still rounds.
    expect(Math.min(...onFloor.map((p) => p.y))).toBeCloseTo(-0.07, 9)
    const feet = onFloor.filter((p) => p.y < 0)
    for (const p of feet) expect(p.y).toBeCloseTo(-0.07, 9)
    expect(onFloor.some((p) => p.y > 0 && p.y < 0.07 - 1e-6)).toBe(true)
    const crown = decoded(geo, [3, 0.12, 0.24], WALL_H - 0.06)
    for (const p of crown.filter((q) => q.y > 0)) expect(p.y).toBeCloseTo(0.06, 9)
    geo.dispose()
  })

  it('bullnoses stair nosings, but not the top tread flush with the next floor', () => {
    const geo = createBevelBoxGeometry(BEVEL_STAIR)
    const tread = 0.3
    // A middle step: floor-standing, its top edges round at BEVEL_STAIR.
    const mid = decoded(geo, [tread * 3, 1.2, 2], 0.6)
    expect(mid.filter((p) => p.y < 0).every((p) => Math.abs(p.y + 0.6) < 1e-9)).toBe(true)
    const nosing = mid.filter((p) => p.y > 0.6 - 1e-9).map((p) => p.x)
    expect(Math.max(...nosing)).toBeCloseTo(tread * 1.5 - BEVEL_STAIR, 6)
    // The top step's head meets the upper slab at LAYER_H: square, no groove.
    const top = decoded(geo, [tread, LAYER_H, 2], LAYER_H / 2)
    for (const p of top.filter((q) => q.y > 0)) expect(p.y).toBeCloseTo(LAYER_H / 2, 6)
    geo.dispose()
  })

  it('passes geometry without the attribute through untouched (w >= 0 gate)', () => {
    const p = [0.5, -0.5, 0.5]
    expect(bevelUnitPosition(p, [0, 0, 0, 0], [1, 1, 1])).toEqual(p)
    // three's own generic defaults leave w at 1.
    expect(bevelUnitPosition(p, [1, 1, 1, 1], [1, 1, 1])).toEqual(p)
    expect(BEVEL_GLSL).toContain('bevel.w >= 0.0')
  })

  it('teaches the flashlight depth override the same bevel, gated per program', () => {
    const material = bevelDepthMaterial({ depthPacking: THREE.BasicDepthPacking })
    expect(material.defaultAttributeValues).toEqual({ bevel: [0, 0, 0, 0] })
    const shader = { vertexShader: THREE.ShaderLib.depth.vertexShader, fragmentShader: THREE.ShaderLib.depth.fragmentShader }
    material.onBeforeCompile(shader)
    expect(shader.vertexShader).toContain('attribute vec4 bevel;')
    expect(shader.vertexShader).toContain('transformed = bevelUnitPosition(transformed, bevel, instanceMatrix);')
    expect(shader.vertexShader.indexOf('bevelUnitPosition(transformed')).toBeGreaterThan(
      shader.vertexShader.indexOf('#include <begin_vertex>')
    )
    expect(material.customProgramCacheKey()).toBe('bevel-depth')
    material.dispose()
  })
})
