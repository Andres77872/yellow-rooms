// Worker half of the realtime tracer's chunk mirror (tracerHost.js). A chunk
// arrives as a plain record (chunkExport.js): the source geometries it uses,
// each drawn by a node with a world matrix, optionally instanced with
// per-instance matrices and colours. Here it is baked into ONE world-space
// mesh per material, so the tracer's top-level BVH spans tens of objects
// instead of thousands of instances (docs/pathracer/10 §6).
//
// Plain typed-array math, no three.js: this runs in the tracer worker and in
// Node tests alike.
//
//   record      { items: [{ geometry, matrix, count, instanceMatrices,
//                 instanceColors, ranges: [{ start, count, material,
//                 partColor, worldUV }] }] }
//   geometries  Map id -> { position (xyz), normal (xyz) | null, uv (xy) |
//                 null, color (rgb or rgba, colorSize) | null, index | null }
//
// Returns [{ material, position, normal, uv, color, index, triangles }]:
// vertex colour carries the instance colour (times the part colour where the
// range asks for it), so every merged proxy material uses vertex colours.
// A `worldUV` range gets the G-buffer's box-projected world UVs
// (gbufferMaterials.js USE_WORLD_UV) instead of the geometry's own, so the
// tracer samples surface textures exactly where the deferred frame does.
// Only the vertex span a range indexes is copied, and a mirrored instance
// (negative determinant) has its winding flipped so front faces stay front.

import { CELL, LAYER_H, WALL_H } from '../../world/constants.js'

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

// out = a * b (column-major 4x4).
function multiply(a, b, out) {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4]
    const b1 = b[c * 4 + 1]
    const b2 = b[c * 4 + 2]
    const b3 = b[c * 4 + 3]
    out[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3
    out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3
    out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3
    out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3
  }
  return out
}

// Inverse transpose of m's upper 3x3 (row-major out[9]); returns the
// determinant (0: degenerate, normals left as given).
function normalMatrix(m, out) {
  const a00 = m[0], a01 = m[4], a02 = m[8]
  const a10 = m[1], a11 = m[5], a12 = m[9]
  const a20 = m[2], a21 = m[6], a22 = m[10]
  const c00 = a11 * a22 - a12 * a21
  const c01 = a12 * a20 - a10 * a22
  const c02 = a10 * a21 - a11 * a20
  const det = a00 * c00 + a01 * c01 + a02 * c02
  if (det === 0) {
    out.set([a00, a01, a02, a10, a11, a12, a20, a21, a22])
    return 0
  }
  const id = 1 / det
  // (A^-1)^T = cofactor(A) / det.
  out[0] = c00 * id
  out[1] = c01 * id
  out[2] = c02 * id
  out[3] = (a02 * a21 - a01 * a22) * id
  out[4] = (a00 * a22 - a02 * a20) * id
  out[5] = (a01 * a20 - a00 * a21) * id
  out[6] = (a01 * a12 - a02 * a11) * id
  out[7] = (a02 * a10 - a00 * a12) * id
  out[8] = (a00 * a11 - a01 * a10) * id
  return det
}

// The vertex span [min, max] a range of a geometry's index touches.
function rangeSpan(geometry, range) {
  const { index } = geometry
  if (!index) return [range.start, range.start + range.count - 1]
  let min = Infinity
  let max = -1
  for (let k = range.start, end = range.start + range.count; k < end; k++) {
    const v = index[k]
    if (v < min) min = v
    if (v > max) max = v
  }
  return max < 0 ? [0, -1] : [min, max]
}

export function mergeChunkRecord(record, geometries) {
  const buckets = new Map()
  for (const item of record.items) {
    const g = geometries.get(item.geometry)
    if (!g || item.count <= 0) continue
    for (const range of item.ranges) {
      if (range.count <= 0) continue
      const [lo, hi] = rangeSpan(g, range)
      const verts = hi - lo + 1
      if (verts <= 0) continue
      let b = buckets.get(range.material)
      if (!b) buckets.set(range.material, (b = { verts: 0, indices: 0, parts: [] }))
      b.parts.push({ item, g, range, lo, verts })
      b.verts += verts * item.count
      b.indices += (range.count - (range.count % 3)) * item.count
    }
  }

  const m = new Float32Array(16)
  const n = new Float32Array(9)
  const out = []
  for (const [material, b] of buckets) {
    const position = new Float32Array(b.verts * 3)
    const normal = new Float32Array(b.verts * 3)
    const uv = new Float32Array(b.verts * 2)
    const color = new Float32Array(b.verts * 3)
    const index = new Uint32Array(b.indices)
    let vo = 0
    let io = 0
    for (const { item, g, range, lo, verts } of b.parts) {
      const P = g.position
      const N = g.normal
      const T = g.uv
      const C = range.partColor ? g.color : null
      const cs = g.colorSize ?? 3
      const I = g.index
      const tris = range.count - (range.count % 3)
      for (let i = 0; i < item.count; i++) {
        const inst = item.instanceMatrices
        if (inst) multiply(item.matrix, inst.subarray(i * 16, i * 16 + 16), m)
        else m.set(item.matrix ?? IDENTITY)
        const det = normalMatrix(m, n)
        // The G-buffer wraps wall v per layer; one base per instance keeps a
        // face's mapping linear (its origin's layer).
        const layerBase = Math.floor((m[13] + 0.001) / LAYER_H) * LAYER_H
        const worldUV = !!range.worldUV
        const ic = item.instanceColors
        const ir = ic ? ic[i * 3] : 1
        const ig = ic ? ic[i * 3 + 1] : 1
        const ib = ic ? ic[i * 3 + 2] : 1
        const base = vo
        for (let k = lo, end = lo + verts; k < end; k++, vo++) {
          const x = P[k * 3]
          const y = P[k * 3 + 1]
          const z = P[k * 3 + 2]
          position[vo * 3] = m[0] * x + m[4] * y + m[8] * z + m[12]
          position[vo * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13]
          position[vo * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14]
          let wx = 0
          let wy = 1
          let wz = 0
          if (N) {
            const nx = N[k * 3]
            const ny = N[k * 3 + 1]
            const nz = N[k * 3 + 2]
            wx = n[0] * nx + n[1] * ny + n[2] * nz
            wy = n[3] * nx + n[4] * ny + n[5] * nz
            wz = n[6] * nx + n[7] * ny + n[8] * nz
            const len = Math.hypot(wx, wy, wz)
            if (len > 0) {
              wx /= len
              wy /= len
              wz /= len
            }
            normal[vo * 3] = wx
            normal[vo * 3 + 1] = wy
            normal[vo * 3 + 2] = wz
          }
          if (worldUV) {
            const px = position[vo * 3]
            const py = position[vo * 3 + 1]
            const pz = position[vo * 3 + 2]
            const ax = Math.abs(wx)
            const ay = Math.abs(wy)
            const az = Math.abs(wz)
            if (ay >= ax && ay >= az) {
              uv[vo * 2] = px / CELL
              uv[vo * 2 + 1] = ((wy >= 0 ? -1 : 1) * pz) / CELL
            } else if (ax >= az) {
              uv[vo * 2] = ((wx >= 0 ? -1 : 1) * pz) / CELL
              uv[vo * 2 + 1] = (py - layerBase) / WALL_H
            } else {
              uv[vo * 2] = ((wz >= 0 ? 1 : -1) * px) / CELL
              uv[vo * 2 + 1] = (py - layerBase) / WALL_H
            }
          } else if (T) {
            uv[vo * 2] = T[k * 2]
            uv[vo * 2 + 1] = T[k * 2 + 1]
          }
          color[vo * 3] = C ? ir * C[k * cs] : ir
          color[vo * 3 + 1] = C ? ig * C[k * cs + 1] : ig
          color[vo * 3 + 2] = C ? ib * C[k * cs + 2] : ib
        }
        // A mirroring transform reverses the winding: swap two corners.
        const flip = det < 0
        for (let k = range.start, end = range.start + tris; k < end; k += 3) {
          const a = (I ? I[k] : k) - lo + base
          const b1 = (I ? I[k + 1] : k + 1) - lo + base
          const c = (I ? I[k + 2] : k + 2) - lo + base
          index[io++] = a
          index[io++] = flip ? c : b1
          index[io++] = flip ? b1 : c
        }
      }
    }
    out.push({ material, position, normal, uv, color, index, triangles: index.length / 3 })
  }
  return out
}
