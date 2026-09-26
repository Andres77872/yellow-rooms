import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import {
  CAPSULES_PER_ENEMY_MAX,
  CAPSULE_RECORD,
  ENEMY_CAPSULES,
  PLAYER_CAPSULE,
  PLAYER_CAPSULES,
  capsuleBound,
  capsuleSet,
  transformCapsules,
} from '../enemyOccluders.js'
import { ENEMY_MODEL_FILES, bakeEnemyRig, createEnemyRig } from '../enemyModels.js'
import { ENEMY_CLIPS } from '../enemyAnimator.js'
import { createGeometries, disposeGeometries } from '../geometries.js'
import { Stalker } from '../../entities/Stalker.js'
import { Pursuer } from '../../entities/Pursuer.js'
import { Husk } from '../../entities/Husk.js'
import { EYE_H } from '../../world/constants.js'

// The capsule tables (render/enemyOccluders.js) are only as good as their fit
// to the meshes the entities really show. These tests re-derive both shapes
// independently of the tables: the shipped GLBs are parsed straight from disk
// (no three.js: JSON + BIN chunks, POSITION accessors, node TRS), and the
// procedural fallback is rebuilt analytically from the CapsuleGeometry
// parameters the entity code actually uses.

const MODELS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../public/models/enemies'
)
const KINDS = ['stalker', 'pursuer', 'husk']
const ENTITY = { stalker: Stalker, pursuer: Pursuer, husk: Husk }
const TOL = 0.03 // m: vertex slack beyond a capsule surface (soft occlusion blurs more than this)

// --- minimal GLB reader (glTF 2.0 binary) ------------------------------------

const COMPONENT = {
  5120: [1, 'getInt8', 127],
  5121: [1, 'getUint8', 255],
  5122: [2, 'getInt16', 32767],
  5123: [2, 'getUint16', 65535],
  5125: [4, 'getUint32', 1],
  5126: [4, 'getFloat32', 1],
}
const WIDTH = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }

function readGlb(kind) {
  const buf = readFileSync(path.join(MODELS_DIR, `${ENEMY_MODEL_FILES[kind]}.glb`))
  expect(buf.readUInt32LE(0)).toBe(0x46546c67) // 'glTF'
  const jsonLen = buf.readUInt32LE(12)
  const json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen))
  const binAt = 20 + jsonLen
  expect(buf.readUInt32LE(binAt + 4)).toBe(0x004e4942) // 'BIN\0'
  return { json, bin: buf.subarray(binAt + 8, binAt + 8 + buf.readUInt32LE(binAt)) }
}

function readAccessor({ json, bin }, index) {
  const acc = json.accessors[index]
  expect(acc.sparse).toBeUndefined()
  const view = json.bufferViews[acc.bufferView]
  const [size, get, norm] = COMPONENT[acc.componentType]
  const width = WIDTH[acc.type]
  const stride = view.byteStride ?? size * width
  const data = new DataView(bin.buffer, bin.byteOffset + (view.byteOffset ?? 0) + (acc.byteOffset ?? 0))
  const out = new Float64Array(acc.count * width)
  for (let i = 0; i < acc.count; i++) {
    for (let c = 0; c < width; c++) {
      const v = data[get](i * stride + c * size, true)
      out[i * width + c] = acc.normalized ? Math.max(v / norm, -1) : v
    }
  }
  return out
}

// Column-major 4x4 helpers (the glTF and three.js convention).
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

function trs(node) {
  if (node.matrix) return node.matrix.slice()
  const [tx, ty, tz] = node.translation ?? [0, 0, 0]
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1]
  const [sx, sy, sz] = node.scale ?? [1, 1, 1]
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + w * z) * sx, 2 * (x * z - w * y) * sx, 0,
    2 * (x * y - w * z) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + w * x) * sy, 0,
    2 * (x * z + w * y) * sz, 2 * (y * z - w * x) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ]
}

function mul(a, b) {
  const o = new Array(16).fill(0)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]
    }
  }
  return o
}

const apply = (m, [x, y, z]) => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
]

const maxDiff = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])))

// Scene-space rest figure: every mesh node's POSITION through its node
// transform, from the default scene (the one GLTFLoader returns as
// asset.scene, i.e. what the entity ends up holding). Skinned primitives are
// taken in their bind pose; `bindError` is the worst |jointRest * IBM -
// meshNode| entry, which is 0 when the rest pose IS the bind pose (so raw
// POSITION through the node transform is the shape a fresh rig shows).
function loadFigure(kind) {
  const glb = readGlb(kind)
  const { json } = glb
  const world = new Array(json.nodes.length)
  const visit = (i, parent) => {
    world[i] = mul(parent, trs(json.nodes[i]))
    for (const c of json.nodes[i].children ?? []) visit(c, world[i])
  }
  for (const n of json.scenes[json.scene ?? 0].nodes) visit(n, IDENTITY)
  const verts = []
  const tris = []
  const meshNodes = []
  let bindError = 0
  json.nodes.forEach((node, ni) => {
    if (node.mesh === undefined || !world[ni]) return
    const m = world[ni]
    meshNodes.push(m)
    if (node.skin !== undefined) {
      const skin = json.skins[node.skin]
      const ibm = readAccessor(glb, skin.inverseBindMatrices)
      skin.joints.forEach((joint, k) => {
        const bind = mul(world[joint], Array.from(ibm.subarray(k * 16, k * 16 + 16)))
        bindError = Math.max(bindError, maxDiff(bind, m))
      })
    }
    for (const prim of json.meshes[node.mesh].primitives) {
      expect(prim.mode ?? 4).toBe(4) // triangles
      const pos = readAccessor(glb, prim.attributes.POSITION)
      const base = verts.length
      for (let i = 0; i < pos.length; i += 3) verts.push(apply(m, [pos[i], pos[i + 1], pos[i + 2]]))
      const index = prim.indices !== undefined ? readAccessor(glb, prim.indices) : pos.map((_, i) => i).slice(0, pos.length / 3)
      for (const i of index) tris.push(base + i)
    }
  })
  return { verts, tris, meshNodes, bindError }
}

const FIGURES = Object.fromEntries(KINDS.map((k) => [k, loadFigure(k)]))

// --- capsule geometry ---------------------------------------------------------

function segDist(p, a, b) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]]
  const ll = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2]
  const t = ll > 0 ? Math.min(1, Math.max(0, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / ll)) : 0
  return Math.hypot(ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t)
}

const inside = (p, c, tol) => segDist(p, c.a, c.b) <= c.r + tol

// Fraction of points within r + tol of at least one capsule.
function coverage(points, caps, tol = TOL) {
  let n = 0
  for (const p of points) if (caps.some((c) => inside(p, c, tol))) n++
  return n / points.length
}

// Fraction of points inside two or more capsules (at r): where the lighting
// pass, which multiplies visibility and AO per capsule, darkens twice.
const overlap = (points, caps) => points.filter((p) => caps.filter((c) => inside(p, c, 0)).length >= 2).length / points.length

// Lowest point of a set (world or local): where it meets the floor.
const bottom = (caps) => Math.min(...caps.map((c) => Math.min(c.a[1], c.b[1]) - c.r))

// Unpack transformCapsules records back into { a, b, r, owner }.
function unpack(out, offset, count) {
  return Array.from({ length: count }, (_, i) => {
    const o = offset + i * CAPSULE_RECORD
    return {
      a: [out[o], out[o + 1], out[o + 2]],
      r: out[o + 3],
      b: [out[o + 4], out[o + 5], out[o + 6]],
      owner: out[o + 7],
    }
  })
}

// lighting.js capsuleAO for one body, full strength (uCapsuleAOK 1, no
// uCapsuleMinVis floor): Quilez sphere occlusion at the axis point nearest P,
// faded out between 3r and 6r, MULTIPLIED over the capsules.
function capsuleAO(P, N, caps) {
  const smooth = (e0, e1, x) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)
  }
  let ao = 1
  for (const { a, b, r } of caps) {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const t = Math.min(1, Math.max(0, ((P[0] - a[0]) * ab[0] + (P[1] - a[1]) * ab[1] + (P[2] - a[2]) * ab[2]) / Math.max(ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2, 1e-6)))
    const v = [a[0] + ab[0] * t - P[0], a[1] + ab[1] * t - P[1], a[2] + ab[2] * t - P[2]]
    const dd = Math.max(Math.hypot(...v), 1e-4)
    const cos = Math.min(1, Math.max(0, (N[0] * v[0] + N[1] * v[1] + N[2] * v[2]) / dd))
    ao *= 1 - Math.min(cos * ((r * r) / (dd * dd)) * (1 - smooth(3 * r, 6 * r, dd)), 1)
  }
  return ao
}

// The floor point under a figure's vertex centroid.
function floorUnder({ verts }) {
  const c = [0, 0]
  for (const p of verts) {
    c[0] += p[0] / verts.length
    c[1] += p[2] / verts.length
  }
  return [c[0], 0, c[1]]
}

// --- orthographic silhouettes --------------------------------------------------
//
// TIGHTNESS. A capsule's job is to cast the figure's shadow, so "oversized"
// means shadow where there is no body and "undersized" means body with no
// shadow. For light along an axis, a capsule's shadow footprint is its
// orthographic projection (a stadium: the projected segment swept by r), and
// the figure's is the projection of its triangles. Precision = the share of
// the capsule footprint the figure also covers; recall = the share of the
// figure's footprint the capsules cover. Three views: FRONT (along z: the
// flashlight — enemies always turn to face the player), TOP (along y:
// ceiling fixtures) and SIDE (along x: grazing fixture light). Volume ratios
// would punish these thin figures twice for the round cross-section any
// capsule has; the projected footprint is what actually reaches the screen.
const VIEWS = { front: [0, 1], top: [0, 2], side: [2, 1] }
const CELL = 0.01

function silhouette(fig, caps, [u, v]) {
  // Raster window: the capsules' AND the figure's footprints.
  const lo = [Infinity, Infinity]
  const hi = [-Infinity, -Infinity]
  const grow = (x, y, r) => {
    lo[0] = Math.min(lo[0], x - r)
    lo[1] = Math.min(lo[1], y - r)
    hi[0] = Math.max(hi[0], x + r)
    hi[1] = Math.max(hi[1], y + r)
  }
  for (const c of caps) for (const p of [c.a, c.b]) grow(p[u], p[v], c.r)
  for (const p of fig.verts) grow(p[u], p[v], 0)
  const nu = Math.ceil((hi[0] - lo[0]) / CELL)
  const nv = Math.ceil((hi[1] - lo[1]) / CELL)
  const body = new Uint8Array(nu * nv)
  const { verts, tris } = fig
  for (let t = 0; t < tris.length; t += 3) {
    const [a, b, c] = [verts[tris[t]], verts[tris[t + 1]], verts[tris[t + 2]]].map((p) => [p[u], p[v]])
    const i0 = Math.max(0, Math.floor((Math.min(a[0], b[0], c[0]) - lo[0]) / CELL))
    const i1 = Math.min(nu - 1, Math.floor((Math.max(a[0], b[0], c[0]) - lo[0]) / CELL))
    const j0 = Math.max(0, Math.floor((Math.min(a[1], b[1], c[1]) - lo[1]) / CELL))
    const j1 = Math.min(nv - 1, Math.floor((Math.max(a[1], b[1], c[1]) - lo[1]) / CELL))
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = lo[0] + (i + 0.5) * CELL
        const y = lo[1] + (j + 0.5) * CELL
        const e0 = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])
        const e1 = (c[0] - b[0]) * (y - b[1]) - (c[1] - b[1]) * (x - b[0])
        const e2 = (a[0] - c[0]) * (y - c[1]) - (a[1] - c[1]) * (x - c[0])
        if ((e0 >= 0 && e1 >= 0 && e2 >= 0) || (e0 <= 0 && e1 <= 0 && e2 <= 0)) body[j * nu + i] = 1
      }
    }
  }
  const flat = caps.map((c) => ({ a: [c.a[u], c.a[v], 0], b: [c.b[u], c.b[v], 0], r: c.r }))
  let shadow = 0
  let hit = 0
  let area = 0
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const cell = body[j * nu + i]
      area += cell
      const p = [lo[0] + (i + 0.5) * CELL, lo[1] + (j + 0.5) * CELL, 0]
      if (!flat.some((c) => inside(p, c, 0))) continue
      shadow++
      hit += cell
    }
  }
  return { precision: hit / shadow, recall: hit / area }
}

function silhouettes(fig, caps) {
  return Object.fromEntries(Object.entries(VIEWS).map(([name, axes]) => [name, silhouette(fig, caps, axes)]))
}

// Precision floors sit ~10% under the fitted values, so a re-fit has headroom
// while a 25% radius inflation fails (checked below, so the floor provably
// bites). Fitted: glb stalker .68/.43/.39, pursuer .27/.21/.25, husk
// .73/.82/.47; single stalker .53/.42/.30, pursuer .36/.31/.25, husk
// .60/.67/.35. The Pursuer's are low by necessity: its four thin, arched legs
// can only be bounded, not traced.
const PRECISION_FLOOR = {
  glb: {
    stalker: { front: 0.6, top: 0.38, side: 0.35 },
    pursuer: { front: 0.24, top: 0.19, side: 0.22 },
    husk: { front: 0.66, top: 0.74, side: 0.42 },
  },
  single: {
    stalker: { front: 0.47, top: 0.37, side: 0.26 },
    pursuer: { front: 0.32, top: 0.27, side: 0.22 },
    husk: { front: 0.53, top: 0.6, side: 0.31 },
  },
}

// A single capsule is the whole body's shadow on the 1-capsule tiers: most of
// the vertices, and the flashlight's (front) silhouette. The Pursuer's
// spread legs cap what one capsule can hold (fitted: .69 vertices, .73
// front); a fatter one only trades precision for it.
const SINGLE_FLOOR = {
  stalker: { coverage: 0.9, front: 0.95 },
  pursuer: { coverage: 0.6, front: 0.7 },
  husk: { coverage: 0.9, front: 0.9 },
}

describe('enemy capsule tables (shape)', () => {
  it('has glb (full), single and fallback sets per enemy kind', () => {
    expect(Object.keys(ENEMY_CAPSULES)).toEqual(Object.keys(ENEMY_MODEL_FILES))
    for (const kind of KINDS) {
      const set = ENEMY_CAPSULES[kind]
      expect(set.glb.length).toBeGreaterThan(1)
      expect(set.glb.length).toBeLessThanOrEqual(CAPSULES_PER_ENEMY_MAX)
      expect(set.single).toHaveLength(1)
      expect(set.fallback).toHaveLength(1)
      for (const c of [...set.glb, ...set.single, ...set.fallback]) {
        expect(c.a).toHaveLength(3)
        expect(c.b).toHaveLength(3)
        expect(c.r).toBeGreaterThan(0)
      }
      // One-capsule stand-ins sit on the figure's centre line.
      for (const c of [...set.single, ...set.fallback]) expect([c.a[0], c.b[0]]).toEqual([0, 0])
      // Left/right symmetric, like the figures: every capsule's mirror image
      // (x -> -x) is in the set.
      for (const c of set.glb) {
        const mirror = set.glb.some((m) =>
          [[m.a, m.b], [m.b, m.a]].some(([p, q]) =>
            p[0] === -c.a[0] && q[0] === -c.b[0] && p[1] === c.a[1] && q[1] === c.b[1] && p[2] === c.a[2] && q[2] === c.b[2]
          ) && m.r === c.r)
        expect(mirror).toBe(true)
      }
    }
    expect(Object.isFrozen(ENEMY_CAPSULES.stalker.glb[0].a)).toBe(true)
    expect(Object.isFrozen(ENEMY_CAPSULES.pursuer.single)).toBe(true)
  })

  it('capsuleSet picks by model state and never exceeds the tier budget', () => {
    for (const kind of KINDS) {
      const set = ENEMY_CAPSULES[kind]
      expect(capsuleSet(kind, 'glb')).toBe(set.glb)
      expect(capsuleSet(kind, 'glb', CAPSULES_PER_ENEMY_MAX)).toBe(set.glb)
      expect(capsuleSet(kind, 'fallback')).toBe(set.fallback)
      expect(capsuleSet(kind, undefined)).toBe(set.fallback)
      // A tier that cannot afford the whole fitted set gets the dedicated
      // single capsule, not a truncated set (a floating torso).
      expect(capsuleSet(kind, 'glb', 1)).toBe(set.single)
      expect(capsuleSet(kind, 'glb', set.glb.length - 1)).toBe(set.single)
      expect(capsuleSet(kind, 'fallback', 1)).toBe(set.fallback)
      for (const state of ['glb', 'fallback']) {
        for (let budget = 1; budget <= CAPSULES_PER_ENEMY_MAX; budget++) {
          expect(capsuleSet(kind, state, budget).length).toBeLessThanOrEqual(budget)
        }
        expect(capsuleSet(kind, state, 0)).toEqual([])
      }
    }
    expect(capsuleSet('nobody', 'glb')).toEqual([])
  })

  it('keeps the player capsule on the feet axis and below the eye', () => {
    expect(PLAYER_CAPSULE.a).toEqual([0, 0.1, 0])
    expect(PLAYER_CAPSULE.b).toEqual([0, 1.45, 0])
    expect(PLAYER_CAPSULE.b[1] + PLAYER_CAPSULE.r).toBeLessThan(EYE_H)
    expect(PLAYER_CAPSULES).toEqual([PLAYER_CAPSULE])
    expect(Object.isFrozen(PLAYER_CAPSULES)).toBe(true)
  })
})

describe('GLB capsules fit the shipped enemy meshes (bind pose, no three.js)', () => {
  it.each(KINDS)('%s: scene space is enemy.mesh space and the bind pose is the rest pose', (kind) => {
    const fig = FIGURES[kind]
    // The static bake uses raw POSITION with no node transform and the rig
    // path renders the scene root: they agree only if the mesh node is
    // identity. Rest joints * IBM = identity means a fresh rig shows exactly
    // the parsed vertices.
    expect(fig.meshNodes.length).toBeGreaterThan(0)
    for (const m of fig.meshNodes) expect(maxDiff(m, IDENTITY)).toBeLessThan(1e-6)
    expect(fig.bindError).toBeLessThan(1e-4)
    expect(fig.verts.length).toBeGreaterThan(1000)
  })

  it.each(KINDS)('%s: the full set encloses at least 90 percent of the vertices and barely overlaps', (kind) => {
    const caps = ENEMY_CAPSULES[kind].glb
    const { verts } = FIGURES[kind]
    expect(coverage(verts, caps)).toBeGreaterThanOrEqual(0.9) // stalker .955, pursuer .942, husk .970
    // Every capsule earns its slot: part of the figure is enclosed by it alone.
    caps.forEach((c, i) => {
      const others = caps.filter((_, j) => j !== i)
      const own = verts.filter((p) => inside(p, c, TOL) && !others.some((o) => inside(p, o, TOL)))
      expect(own.length / verts.length, `capsule ${i}`).toBeGreaterThanOrEqual(0.02)
    })
    // The shader multiplies per capsule, so nested/overlapping capsules
    // double-darken: keep shared volume small (stalker .002, pursuer .026,
    // husk .046).
    expect(overlap(verts, caps)).toBeLessThanOrEqual(0.1)
  })

  it.each(KINDS)('%s: the single capsule stands on the floor and carries the whole body', (kind) => {
    const fig = FIGURES[kind]
    const caps = ENEMY_CAPSULES[kind].single
    const floor = SINGLE_FLOOR[kind]
    expect(coverage(fig.verts, caps)).toBeGreaterThanOrEqual(floor.coverage) // .979 / .693 / .946
    expect(silhouette(fig, caps, VIEWS.front).recall).toBeGreaterThanOrEqual(floor.front) // .99 / .73 / .94
  })

  it.each(KINDS.flatMap((k) => ['glb', 'single'].map((s) => [k, s])))('%s %s: grounded (reaches the floor, AO under the body)', (kind, state) => {
    const fig = FIGURES[kind]
    const caps = ENEMY_CAPSULES[kind][state]
    // Reaches the floor without sinking a big contact disc into it.
    expect(bottom(caps)).toBeGreaterThanOrEqual(-0.1)
    expect(bottom(caps)).toBeLessThanOrEqual(0.25)
    // Capsule AO on the floor under the body (lighting.js capsuleAO at full
    // strength) is what keeps a figure from floating. Fitted: glb .00 / .26 /
    // .12, single .00 / .38 / .25; the old ad-hoc capsules gave .36 / .23 /
    // .39, a lifted torso alone (the old 1-capsule tier) .86 / .31 / .94.
    expect(capsuleAO(floorUnder(fig), [0, 1, 0], caps)).toBeLessThanOrEqual(0.5)
  })

  it.each(KINDS.flatMap((k) => ['glb', 'single'].map((s) => [k, s])))('%s %s: capsule shadows are not grossly oversized (silhouette precision)', (kind, state) => {
    const fig = FIGURES[kind]
    const caps = ENEMY_CAPSULES[kind][state]
    const got = silhouettes(fig, caps)
    const floor = PRECISION_FLOOR[state][kind]
    for (const view of Object.keys(VIEWS)) {
      expect(got[view].precision, view).toBeGreaterThanOrEqual(floor[view])
      if (state === 'glb') expect(got[view].recall, view).toBeGreaterThanOrEqual(0.95)
    }
    // The floor discriminates: the same layout with every radius 25% larger
    // (what a lazy "just make it bigger" fit looks like) falls below it.
    const inflated = silhouettes(fig, caps.map((c) => ({ ...c, r: c.r * 1.25 })))
    const mean = (o) => (o.front + o.top + o.side) / 3
    const precision = Object.fromEntries(Object.entries(inflated).map(([view, s]) => [view, s.precision]))
    expect(mean(precision)).toBeLessThan(mean(floor))
  })
})

// --- procedural fallback ------------------------------------------------------

// The CapsuleGeometry surface, analytically (three r185: `height` is the
// middle section only; caps are hemispheres of `radius` on either end, the
// profile revolved about y). Dense rows so the check covers the ideal surface
// the tessellated vertices lie on, not just those vertices.
function capsuleSurface(radius, height, rows = 24, around = 36) {
  const pts = []
  const ring = (y, rho) => {
    for (let i = 0; i < around; i++) {
      const t = (i / around) * Math.PI * 2
      pts.push([-rho * Math.cos(t), y, rho * Math.sin(t)])
    }
  }
  for (let i = 0; i <= rows; i++) {
    const phi = (i / rows) * (Math.PI / 2)
    ring(-height / 2 - radius * Math.cos(phi), radius * Math.sin(phi))
    ring(height / 2 + radius * Math.sin(phi), radius * Math.cos(phi))
    ring(-height / 2 + (i / rows) * height, radius)
  }
  return pts
}

const capsuleVolume = (len, r) => Math.PI * r * r * len + (4 / 3) * Math.PI * r ** 3

// Where the player stands relative to the entity for the placement tests
// (the entity's own _faceMesh turns the mesh toward it: a non-trivial yaw).
const TO_PLAYER = [2.6, 0, -1.9]

describe('tables live in enemy.mesh space (fallback capsule, static GLB swap)', () => {
  it.each(KINDS)('%s: exact enclosure through a yawed, scaled matrixWorld', (kind) => {
    const geom = createGeometries()
    try {
      // The entity constructor picks the geometry, scale and meshYOffset.
      const entity = new ENTITY[kind]({ add() {} }, {}, geom, {})
      const { mesh } = entity
      const { radius, height } = mesh.geometry.parameters
      expect(mesh.geometry.type).toBe('CapsuleGeometry')
      expect(mesh.scale.x).toBe(mesh.scale.z)
      // Placement exactly as the entity does it.
      entity.pos.set(3.2, 7.1, -5.4)
      entity._faceMesh({ x: entity.pos.x + TO_PLAYER[0], z: entity.pos.z + TO_PLAYER[2] })
      expect(Math.abs(Math.sin(mesh.rotation.y))).toBeGreaterThan(0.5)
      mesh.updateMatrixWorld(true)
      const m = mesh.matrixWorld.elements

      const out = new Float32Array(CAPSULES_PER_ENEMY_MAX * CAPSULE_RECORD)
      const n = transformCapsules(capsuleSet(kind, 'fallback'), m, out, 0, 2)
      expect(n).toBe(1)
      const [cap] = unpack(out, 0, n)
      expect(cap.owner).toBe(2)
      expect(cap.r).toBeCloseTo(radius * mesh.scale.x, 5)

      const surface = capsuleSurface(radius, height).map((p) => apply(m, p))
      const pos = mesh.geometry.attributes.position
      const tessellated = Array.from({ length: pos.count }, (_, i) => apply(m, [pos.getX(i), pos.getY(i), pos.getZ(i)]))
      for (const pts of [surface, tessellated]) {
        const excess = pts.map((p) => segDist(p, cap.a, cap.b) - cap.r)
        expect(excess.filter((e) => e <= 1e-4).length / pts.length).toBeGreaterThanOrEqual(0.95)
        expect(Math.max(...excess)).toBeLessThan(1e-3) // in fact exact
        expect(Math.max(...excess)).toBeGreaterThan(-1e-3) // and touching
      }
      // Tight: at most 10% more volume than the scaled capsule mesh (a
      // cylinder plus two spheroidal caps of radii r*sx and r*sy).
      const sx = mesh.scale.x
      const sy = mesh.scale.y
      const meshVolume = Math.PI * (radius * sx) ** 2 * height * sy + (4 / 3) * Math.PI * (radius * sx) ** 2 * radius * sy
      const len = Math.hypot(cap.b[0] - cap.a[0], cap.b[1] - cap.a[1], cap.b[2] - cap.a[2])
      const ratio = capsuleVolume(len, cap.r) / meshVolume
      expect(ratio).toBeGreaterThanOrEqual(1 - 1e-4)
      expect(ratio).toBeLessThan(1.1)
      // Follows the mesh down to (in fact into) the floor: grounded.
      expect(bottom([cap]) - entity.pos.y).toBeLessThanOrEqual(0.25)
    } finally {
      disposeGeometries(geom)
    }
  })

  it.each(KINDS)('%s: glb tables follow the static swap (feet, yaw, facing)', (kind) => {
    const entity = new ENTITY[kind]({ add() {} }, {}, {}, {})
    const geometry = new THREE.BufferGeometry()
    entity.upgradeModel(geometry, {})
    expect(entity.modelState).toBe('glb')
    entity.pos.set(-4, 3.6, 11)
    const player = { x: entity.pos.x + TO_PLAYER[0], z: entity.pos.z + TO_PLAYER[2] }
    entity._faceMesh(player)
    entity.mesh.updateMatrixWorld(true)
    const m = entity.mesh.matrixWorld.elements
    const yaw = entity.mesh.rotation.y
    expect(Math.abs(Math.sin(yaw))).toBeGreaterThan(0.5)
    for (const caps of [capsuleSet(kind, 'glb'), capsuleSet(kind, 'glb', 1)]) {
      const out = []
      const n = transformCapsules(caps, entity.mesh.matrixWorld, out, 0, 0)
      expect(n).toBe(caps.length)
      unpack(out, 0, n).forEach((c, i) => {
        // Every coordinate: the local table through the entity's own matrix
        // (feet at pos, turned by the yaw, unscaled)...
        apply(m, caps[i].a).forEach((x, k) => expect(c.a[k]).toBeCloseTo(x, 5))
        apply(m, caps[i].b).forEach((x, k) => expect(c.b[k]).toBeCloseTo(x, 5))
        expect(c.r).toBeCloseTo(caps[i].r, 6)
        expect(c.a[1]).toBeCloseTo(entity.pos.y + caps[i].a[1], 5)
      })
    }
    // ...and the facing convention: the capsule furthest toward local +z
    // (the Stalker/Husk head, the Pursuer's head-and-forelegs blob) lands on
    // the player's side of the entity, as far forward as it sits locally.
    const caps = capsuleSet(kind, 'glb')
    const fwd = (c) => (c.a[2] + c.b[2]) / 2
    const front = caps.reduce((best, c) => (fwd(c) > fwd(best) ? c : best))
    expect(fwd(front)).toBeGreaterThan(0.1)
    const out = []
    transformCapsules([front], m, out, 0, 0)
    const [w] = unpack(out, 0, 1)
    const facing = [Math.sin(yaw), Math.cos(yaw)]
    const toPlayer = Math.hypot(TO_PLAYER[0], TO_PLAYER[2])
    expect(facing[0]).toBeCloseTo(TO_PLAYER[0] / toPlayer, 6)
    expect(facing[1]).toBeCloseTo(TO_PLAYER[2] / toPlayer, 6)
    const ahead = ((w.a[0] + w.b[0]) / 2 - entity.pos.x) * facing[0] + ((w.a[2] + w.b[2]) / 2 - entity.pos.z) * facing[1]
    expect(ahead).toBeCloseTo(fwd(front), 5)
    geometry.dispose()
  })
})

// --- rigged runtime path (three.js) --------------------------------------------

async function loadRig(kind) {
  const buf = readFileSync(path.join(MODELS_DIR, `${ENEMY_MODEL_FILES[kind]}.glb`))
  const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  const asset = await new Promise((resolve, reject) => new GLTFLoader().parse(data, '', resolve, reject))
  return bakeEnemyRig(asset)
}

// Clips a static table must hold through their whole loop: what each entity
// shows most of the time it is near the player (standing, or for the
// Pursuer, which never stops while it has a route, crawling). Speeds are
// representative ground speeds; gait clips are sampled over exactly one loop.
const HELD_CLIPS = [
  ['stalker', 'idle', 0],
  ['pursuer', 'idle', 0],
  ['pursuer', 'crawl', 2],
  ['husk', 'idle', 0],
]
const PHASES = 64 // ~40 ms apart on the 2.6 s idle loops: finds the dips

describe('GLB capsules on the live rig (world space, whole loop)', () => {
  // The tables keep most of the figure at EVERY phase of the loop on the rig
  // entity.mesh really is, transformed by its matrixWorld.
  it.each(HELD_CLIPS)('%s %s keeps at least 86 percent coverage through the loop', async (kind, clip, speed) => {
    const rig = await loadRig(kind)
    expect(rig).not.toBeNull()
    const { object, animator } = createEnemyRig(kind, rig, new THREE.MeshBasicMaterial())
    const entity = new ENTITY[kind]({ add() {} }, {}, {}, {})
    entity.upgradeRig(object, animator)
    expect(entity.mesh).toBe(object)
    entity.pos.set(12, -3.4, 5)
    entity._faceMesh({ x: entity.pos.x + TO_PLAYER[0], z: entity.pos.z + TO_PLAYER[2] })
    let skinned
    object.traverse((node) => node.isSkinnedMesh && (skinned = node))
    const pose = { base: clip, speed, hold: false, overlays: {} }
    const def = ENEMY_CLIPS[kind][clip]
    const rate = def.stride ? Math.min(Math.max(speed / def.stride, def.minRate), def.maxRate) : 0
    const loop = def.stride ? 1 / rate : animator.layers.get(clip).duration
    for (let i = 0; i < 30; i++) animator.update(1 / 30, pose) // settle any crossfade
    expect(animator.weightOf(clip)).toBeGreaterThan(0.99)
    const v = new THREE.Vector3()
    const out = new Float32Array(CAPSULES_PER_ENEMY_MAX * CAPSULE_RECORD)
    const covs = []
    for (let phase = 0; phase < PHASES; phase++) {
      animator.update(loop / PHASES, pose)
      object.updateMatrixWorld(true)
      const n = transformCapsules(capsuleSet(kind, 'glb'), object.matrixWorld.elements, out, 0, 0)
      const caps = unpack(out, 0, n)
      const pts = []
      for (let i = 0; i < skinned.geometry.attributes.position.count; i++) {
        skinned.getVertexPosition(i, v).applyMatrix4(skinned.matrixWorld)
        pts.push([v.x, v.y, v.z])
      }
      covs.push(coverage(pts, caps))
    }
    // Measured minima: stalker idle .879, pursuer idle .919 / crawl .896,
    // husk idle .879.
    expect(Math.min(...covs)).toBeGreaterThanOrEqual(0.86)
    animator.dispose()
  })
})

// --- packing ---------------------------------------------------------------------

// Column-major T * Ry(yaw) * S, the way Object3D composes matrixWorld.
function compose([tx, ty, tz], yaw, [sx, sy, sz]) {
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  return [c * sx, 0, -s * sx, 0, 0, sy, 0, 0, s * sz, 0, c * sz, 0, tx, ty, tz, 1]
}

describe('transformCapsules / capsuleBound', () => {
  const caps = [
    { a: [0, -0.4, 0.1], b: [0.2, 0.6, 0.1], r: 0.3 },
    { a: [0.5, 0, -0.2], b: [-0.5, 0, -0.2], r: 0.1 },
    { a: [0, 1, 0.3], b: [0, 1.2, 0.35], r: 0.05 },
    { a: [9, 9, 9], b: [9, 9, 9], r: 9 }, // beyond CAPSULES_PER_ENEMY_MAX: never written
  ]
  const m = compose([4, 1.5, -7], 1.1, [1.4, 1.9, 0.8])

  it('moves endpoints by the matrix and scales r by the larger horizontal axis', () => {
    const out = new Array(40).fill(-1)
    const n = transformCapsules(caps, m, out, 8, 5)
    expect(n).toBe(CAPSULES_PER_ENEMY_MAX)
    expect(out.slice(0, 8)).toEqual(new Array(8).fill(-1)) // before offset untouched
    expect(out.slice(8 + n * CAPSULE_RECORD)).toEqual(new Array(40 - 8 - n * CAPSULE_RECORD).fill(-1))
    unpack(out, 8, n).forEach((c, i) => {
      apply(m, caps[i].a).forEach((x, k) => expect(c.a[k]).toBeCloseTo(x, 9))
      apply(m, caps[i].b).forEach((x, k) => expect(c.b[k]).toBeCloseTo(x, 9))
      expect(c.r).toBeCloseTo(caps[i].r * 1.4, 9)
      expect(c.owner).toBe(5)
    })
    // A Matrix4 works as-is; a full typed buffer truncates instead of overrunning.
    const matrix = new THREE.Matrix4().fromArray(m)
    const tight = new Float32Array(3 + CAPSULE_RECORD + 5) // room for one record after offset 3
    expect(transformCapsules(caps, matrix, tight, 3, 1)).toBe(1)
    expect(tight[3]).toBeCloseTo(apply(m, caps[0].a)[0], 5)
    expect(transformCapsules([], m, tight, 0, 0)).toBe(0)
  })

  it('encloses the transformed local capsule when y is not the widest stretch', () => {
    // With sy <= sx = sz the matrix's largest stretch is the horizontal one
    // that scales r, so every point within r of a LOCAL segment lands within
    // the world capsule (the fallback tables handle sy > sx by lengthening the
    // segment instead; see the fallback suite).
    const squat = compose([-2, 0, 3], -0.7, [1.3, 0.85, 1.3])
    const out = new Float32Array(CAPSULES_PER_ENEMY_MAX * CAPSULE_RECORD)
    const n = transformCapsules(caps, squat, out, 0, 0)
    const world = unpack(out, 0, n)
    let worst = -Infinity
    for (let i = 0; i < n; i++) {
      const { a, b, r } = caps[i]
      for (let s = 0; s <= 8; s++) {
        const t = s / 8
        const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
        for (let k = 0; k < 64; k++) {
          const dir = [Math.sin(k * 2.4) * Math.cos(k), Math.cos(k * 2.4), Math.sin(k * 2.4) * Math.sin(k)]
          const q = apply(squat, [p[0] + r * dir[0], p[1] + r * dir[1], p[2] + r * dir[2]])
          worst = Math.max(worst, segDist(q, world[i].a, world[i].b) - world[i].r)
        }
      }
    }
    expect(worst).toBeLessThanOrEqual(1e-5)
    expect(worst).toBeGreaterThan(-1e-3) // horizontal surface points stay on the surface
  })

  it('bounds every written capsule with one sphere', () => {
    const out = new Float32Array(4 + CAPSULES_PER_ENEMY_MAX * CAPSULE_RECORD)
    const n = transformCapsules(caps, m, out, 4, 0)
    const sphere = capsuleBound(out, 4, n)
    expect(sphere).toHaveLength(4)
    const [cx, cy, cz, R] = sphere
    let farthest = 0
    for (const c of unpack(out, 4, n)) {
      // The farthest point of a capsule from any centre is an endpoint + r.
      for (const p of [c.a, c.b]) farthest = Math.max(farthest, Math.hypot(p[0] - cx, p[1] - cy, p[2] - cz) + c.r)
      for (let k = 0; k < 64; k++) {
        const t = (k % 8) / 7
        const dir = [Math.sin(k * 2.4) * Math.cos(k), Math.cos(k * 2.4), Math.sin(k * 2.4) * Math.sin(k)]
        const len = Math.hypot(...dir)
        const q = [0, 1, 2].map((j) => c.a[j] + (c.b[j] - c.a[j]) * t + (dir[j] / len) * c.r)
        expect(Math.hypot(q[0] - cx, q[1] - cy, q[2] - cz)).toBeLessThanOrEqual(R + 1e-5)
      }
    }
    expect(R).toBeCloseTo(farthest, 5) // and no looser than it has to be for that centre
    // The box centre: halfway between the extreme endpoint-sphere faces.
    const world = unpack(out, 4, n)
    const ext = (k, s) => s * Math.max(...world.flatMap((c) => [c.a[k] * s + c.r, c.b[k] * s + c.r]))
    expect(cx).toBeCloseTo((ext(0, 1) + ext(0, -1)) / 2, 5)
    expect(cy).toBeCloseTo((ext(1, 1) + ext(1, -1)) / 2, 5)
    expect(cz).toBeCloseTo((ext(2, 1) + ext(2, -1)) / 2, 5)
    // No allocation per call: without a target it reuses one shared scratch.
    expect(capsuleBound(out, 4, n)).toBe(sphere)
    // Reuses a given target; an empty body has a zero sphere.
    const target = [9, 9, 9, 9]
    expect(capsuleBound(out, 4, 0, target)).toBe(target)
    expect(target).toEqual([0, 0, 0, 0])
  })
})
