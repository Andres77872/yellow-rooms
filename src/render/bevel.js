import * as THREE from 'three'
import { BEVEL_FRAC, LAYER_H, WALL_H } from '../world/constants.js'
import { glslFloat } from './shaders/common.js'

// Bevelled unit boxes (constants.js BEVEL_*).
//
// Every architecture batch is ONE instanced unit box stretched per instance
// (a 0.16 x 3.2 x 42 wall run, a 0.8 square column, a 2 cm casing). A rounded
// box modelled at unit size would stretch its rounding with the instance, so
// the bevel is resolved in the vertex shader instead, at a constant
// world-space radius:
//
//   position  the SHARP unit-box corner the vertex belongs to (+-0.5)
//   normal    the rounded surface normal
//   bevel.xyz where the vertex moves from that corner, in radius units
//   bevel.w   -cap: the radius cap; 0 (the attribute default) disables it
//
//   unitPos = position + r * bevel.xyz / instanceScale
//   r       = min(cap, BEVEL_FRAC * smallest instance side)
//
// Because `position` is the sharp corner, every consumer that ignores the
// attribute — bounding spheres, raycasts, the path tracer's scene mirror —
// sees an exact unit box (the rounding strips collapse to zero area). Only
// the G-buffer materials (gbufferMaterials.js USE_BEVEL) and the flashlight
// depth pass (bevelDepthMaterial) apply it, so the shadow caster matches the
// visible surface: a sharp caster would shadow the rounded edge it encloses.
//
// The gate is a NEGATIVE bevel.w. A program reading the attribute from a
// geometry that lacks it gets the material default (0,0,0,0), or — when
// three reuses a cached VAO — whatever generic value another program left at
// that location; three's own defaults are vec2/vec3 values whose w reads 1.
// Either way w >= 0 and the vertex passes through untouched.
//
// Faces resting on the slabs stay square: a box whose foot sits on the floor
// (chunk-local y = 0) or whose top meets the ceiling (y = WALL_H) or the next
// storey's floor (y = LAYER_H, the top stair tread) keeps that side's edges
// sharp, so baseboards, casings, column caps and stair treads never open a
// rounded groove along a floor or ceiling line.

export const BEVEL_GLSL = /* glsl */ `
  vec3 bevelScale(mat4 m){
    return vec3(length(m[0].xyz), length(m[1].xyz), length(m[2].xyz));
  }
  vec3 bevelUnitPosition(vec3 p, vec4 bevel, mat4 m){
    if (bevel.w >= 0.0) return p;
    vec3 s = max(bevelScale(m), vec3(1e-6));
    float r = min(-bevel.w, ${glslFloat(BEVEL_FRAC)} * min(s.x, min(s.y, s.z)));
    vec3 d = bevel.xyz;
    float foot = m[3].y - 0.5 * s.y;
    float head = m[3].y + 0.5 * s.y;
    bool slabHead = abs(head - ${glslFloat(WALL_H)}) < 1e-3 || abs(head - ${glslFloat(LAYER_H)}) < 1e-3;
    if ((p.y < 0.0 && abs(foot) < 1e-3) || (p.y > 0.0 && slabHead)) d.y = 0.0;
    return p + r * d / s;
  }
`

// JS mirror of bevelUnitPosition (tests, tooling).
export function bevelUnitPosition(p, bevel, scale, centreY = 0) {
  if (bevel[3] >= 0) return [...p]
  const s = scale.map((v) => Math.max(v, 1e-6))
  const r = Math.min(-bevel[3], BEVEL_FRAC * Math.min(s[0], s[1], s[2]))
  const d = [bevel[0], bevel[1], bevel[2]]
  const foot = centreY - 0.5 * s[1]
  const head = centreY + 0.5 * s[1]
  const slabHead = Math.abs(head - WALL_H) < 1e-3 || Math.abs(head - LAYER_H) < 1e-3
  if ((p[1] < 0 && Math.abs(foot) < 1e-3) || (p[1] > 0 && slabHead)) d[1] = 0
  return [p[0] + (r * d[0]) / s[0], p[1] + (r * d[1]) / s[1], p[2] + (r * d[2]) / s[2]]
}

// Assemble an indexed geometry from vertex records {c, o, n, uv} where c is
// the corner sign vector, o the offset direction from the inset corner (in
// radius units) and n the normal. Triangles are oriented outward against a
// reference rounding (r = 0.1 on the unit box) so callers can list corners
// in any order.
function assemble(verts, tris, cap) {
  const position = new Float32Array(verts.length * 3)
  const normal = new Float32Array(verts.length * 3)
  const uv = new Float32Array(verts.length * 2)
  const bevel = new Float32Array(verts.length * 4)
  const ref = []
  verts.forEach((v, i) => {
    for (let k = 0; k < 3; k++) {
      position[i * 3 + k] = v.c[k] * 0.5
      normal[i * 3 + k] = v.n[k]
      bevel[i * 4 + k] = v.o[k] - v.c[k]
      ref.push(v.c[k] * 0.5 + 0.1 * (v.o[k] - v.c[k]))
    }
    bevel[i * 4 + 3] = -cap
    uv[i * 2] = v.uv[0]
    uv[i * 2 + 1] = v.uv[1]
  })
  const index = []
  const p = (i) => new THREE.Vector3(ref[i * 3], ref[i * 3 + 1], ref[i * 3 + 2])
  const nrm = (i) => new THREE.Vector3().fromArray(verts[i].n)
  for (const [a, b, c] of tris) {
    const face = new THREE.Vector3().subVectors(p(b), p(a)).cross(new THREE.Vector3().subVectors(p(c), p(a)))
    const out = nrm(a).add(nrm(b)).add(nrm(c))
    if (face.dot(out) < 0) index.push(a, c, b)
    else index.push(a, b, c)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(position, 3))
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  geo.setAttribute('bevel', new THREE.Float32BufferAttribute(bevel, 4))
  geo.setIndex(index)
  geo.computeBoundingBox()
  geo.computeBoundingSphere()
  geo.userData.bevelCap = cap
  return geo
}

// Unit box with only its four VERTICAL edges rounded (k segments per quarter
// arc) and flat, square-cornered caps: the wall shell. Tops and feet meet the
// slabs, so their horizontal edges stay sharp.
export function createBevelPrismGeometry(cap, k = 2) {
  const verts = []
  const tris = []
  const outline = [] // [{c, o, theta}] around the perimeter, theta increasing
  for (let q = 0; q < 4; q++) {
    const mid = (q + 0.5) * (Math.PI / 2)
    const sx = Math.sign(Math.cos(mid))
    const sz = Math.sign(Math.sin(mid))
    for (let j = 0; j <= k; j++) {
      const t = (q + j / k) * (Math.PI / 2)
      const ox = Math.abs(Math.cos(t)) < 1e-12 ? 0 : Math.cos(t)
      const oz = Math.abs(Math.sin(t)) < 1e-12 ? 0 : Math.sin(t)
      outline.push({ sx, sz, ox, oz, t })
    }
  }
  const n = outline.length
  const side = (e, sy) => {
    verts.push({
      c: [e.sx, sy, e.sz],
      o: [e.ox, sy, e.oz],
      n: [e.ox, 0, e.oz],
      uv: [e.t / (Math.PI * 2), (sy + 1) / 2],
    })
    return verts.length - 1
  }
  const bottom = outline.map((e) => side(e, -1))
  const top = outline.map((e) => side(e, 1))
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    tris.push([bottom[i], bottom[j], top[j]], [bottom[i], top[j], top[i]])
  }
  for (const sy of [-1, 1]) {
    const ring = outline.map((e) => {
      verts.push({
        c: [e.sx, sy, e.sz],
        o: [e.ox, sy, e.oz],
        n: [0, sy, 0],
        uv: [(e.sx + 1) / 2, (e.sz + 1) / 2],
      })
      return verts.length - 1
    })
    for (let i = 1; i < n - 1; i++) tris.push([ring[0], ring[i], ring[i + 1]])
  }
  return assemble(verts, tris, cap)
}

// Unit box with all twelve edges chamfered and smooth-shaded: one vertex per
// face corner carrying the face normal, edge quads and corner triangles
// interpolating between them — it shades as a rounded edge at the cost of 32
// extra triangles. Detail batches (trim, props, signs, leaves).
export function createBevelBoxGeometry(cap) {
  const verts = []
  const tris = []
  const at = new Map() // `${axis}${sign}|${cornerSigns}` -> vertex index
  const key = (a, s, c) => `${a}${s}|${c.join(',')}`
  for (let a = 0; a < 3; a++) {
    const b = (a + 1) % 3
    const d = (a + 2) % 3
    for (const s of [-1, 1]) {
      const quad = []
      for (const [sb, sd] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const c = [0, 0, 0]
        c[a] = s
        c[b] = sb
        c[d] = sd
        const o = [0, 0, 0]
        o[a] = s
        verts.push({ c, o, n: o, uv: [(sb + 1) / 2, (sd + 1) / 2] })
        at.set(key(a, s, c), verts.length - 1)
        quad.push(verts.length - 1)
      }
      tris.push([quad[0], quad[1], quad[2]], [quad[0], quad[2], quad[3]])
    }
  }
  // Edge quads: faces (a, sa) and (b, sb) meet along the third axis d.
  for (let a = 0; a < 3; a++) {
    for (let b = a + 1; b < 3; b++) {
      const d = 3 - a - b
      for (const sa of [-1, 1]) {
        for (const sb of [-1, 1]) {
          const ends = [-1, 1].map((sd) => {
            const c = [0, 0, 0]
            c[a] = sa
            c[b] = sb
            c[d] = sd
            return [at.get(key(a, sa, c)), at.get(key(b, sb, c))]
          })
          tris.push([ends[0][0], ends[1][0], ends[1][1]], [ends[0][0], ends[1][1], ends[0][1]])
        }
      }
    }
  }
  // Corner triangles: one vertex from each of the three faces meeting there.
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const c = [sx, sy, sz]
        tris.push([0, 1, 2].map((a) => at.get(key(a, c[a], c))))
      }
    }
  }
  return assemble(verts, tris, cap)
}

// The flashlight's depth-only override material, taught the same bevel so
// the shadow caster is the surface the camera sees. Instanced draws only:
// every bevelled geometry is an instanced unit box.
export function bevelDepthMaterial(parameters) {
  const material = new THREE.MeshDepthMaterial(parameters)
  // Geometries without the attribute (GLB furniture, enemies) read w = 0.
  material.defaultAttributeValues = { bevel: [0, 0, 0, 0] }
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        #ifdef USE_INSTANCING
          attribute vec4 bevel;
          ${BEVEL_GLSL}
        #endif`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        #ifdef USE_INSTANCING
          transformed = bevelUnitPosition(transformed, bevel, instanceMatrix);
        #endif`
      )
  }
  material.customProgramCacheKey = () => 'bevel-depth'
  return material
}
