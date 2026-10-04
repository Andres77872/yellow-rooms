import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { createFurnitureModelLibrary, disposeModelScene } from '../furnitureModels.js'
import { GLTF_SURFACES, GLTF_SURFACE_CONFLICTS, mergePackSurfaces } from '../surfaces.js'
import { createGeometries } from '../geometries.js'
import { PROP_PACKS, PROP_PROXIES, PROP_CART, PROP_LOUNGER, PROP_KIDS_BIKE } from '../../world/props/index.js'
import { furnitureProxyBoxes } from '../../world/objects/furniture/proxies.js'
import { pushFurnitureModel } from '../../world/objects/furniture/index.js'
import { buildChunkMeshes } from '../../world/mesh.js'
import { ChunkData } from '../../world/ChunkData.js'
import { CELL, THICK } from '../../world/constants.js'

// Prop packs (world/props) against their Blender exports. A pack is built by
// scripts/blender/build_pack.py into public/models/<pack>/ with a manifest;
// until then its kinds render through the registry's box fallback.
// REQUIRE_PROP_MODELS turns "a pack without a manifest" from a skipped case
// into a failure (Stage B flips it once every pack is built).
const REQUIRE_PROP_MODELS = true

const MODELS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../public/models')
const manifestPath = (pack) => path.join(MODELS_ROOT, pack, 'manifest.json')
const readManifest = (pack) => JSON.parse(readFileSync(manifestPath(pack), 'utf8'))

// The GLB contract shared with furniture-models.test.js.
const TOL_XZ = 0.15
const TOL_CENTER = 0.12
const TOL_H = 0.06
const DIM_TOL = 1e-6

// IoU harness constants (furniture-proxies.test.js).
const RES = 0.02
const GRID_H = 2.24
const JITTER = 0.0037
const TOP_MIN = 0.8
const SIDE_MIN = 0.7
const SEE_THROUGH_T = 5
// Per-kind floors, documented with the pack's proxies, for kinds two boxes
// cannot hold (legs, frames); set just under the measured score.
//   kids_bike: an open frame on two thin wheels. A 2-box search over the GLB
//     tops out near top .55 / side .48 (suburb.js); the proxies follow the
//     wheel line and the handlebar, where the shadow actually falls.
const TOP_FLOOR = { [PROP_KIDS_BIKE]: 0.53 }
const SIDE_FLOOR = { [PROP_KIDS_BIKE]: 0.45 }
// The registry's box fallback (the pre-load / failed-load preview) seen from
// the front and back: a kind whose model is a closed panel must not fall back
// to boxes you can see straight through (lifeguard_chair once scored .32).
const FALLBACK_FRONT_MIN = 0.4

// --- Minimal GLB reader (glTF 2.0 binary, no three.js) -----------------------

const COMPONENT = {
  5121: [1, 'getUint8'],
  5123: [2, 'getUint16'],
  5125: [4, 'getUint32'],
  5126: [4, 'getFloat32'],
}
const WIDTH = { SCALAR: 1, VEC3: 3 }

function readGlb(file) {
  const buf = readFileSync(file)
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  expect(dv.getUint32(0, true)).toBe(0x46546c67) // 'glTF'
  expect(dv.getUint32(4, true)).toBe(2)
  let json = null
  let bin = null
  for (let off = 12; off + 8 <= dv.getUint32(8, true);) {
    const len = dv.getUint32(off, true)
    const type = dv.getUint32(off + 4, true)
    const body = buf.subarray(off + 8, off + 8 + len)
    if (type === 0x4e4f534a) json = JSON.parse(body.toString('utf8'))
    else if (type === 0x004e4942) bin = body
    off += 8 + len
  }
  expect(json).toBeTruthy()
  expect(bin).toBeTruthy()
  return { json, bin: new DataView(bin.buffer, bin.byteOffset, bin.byteLength) }
}

function readAccessor({ json, bin }, index, types) {
  const acc = json.accessors[index]
  expect(types).toContain(`${acc.componentType}:${acc.type}`)
  expect(acc.sparse).toBeUndefined()
  const view = json.bufferViews[acc.bufferView]
  const [size, get] = COMPONENT[acc.componentType]
  const width = WIDTH[acc.type]
  const stride = view.byteStride || size * width
  const base = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0)
  const out = new Float64Array(acc.count * width)
  for (let i = 0; i < acc.count; i++) {
    for (let k = 0; k < width; k++) out[i * width + k] = bin[get](base + i * stride + k * size, true)
  }
  return out
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

function nodeMatrix(n) {
  if (n.matrix) return n.matrix
  const [tx, ty, tz] = n.translation ?? [0, 0, 0]
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1]
  const [sx, sy, sz] = n.scale ?? [1, 1, 1]
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ]
}

// Every triangle of the default scene in model space (the u/y/v frame), plus
// the scene's world-space bounds and its primitives' JSON for the export checks.
function glbScene(file) {
  const glb = readGlb(file)
  const { json } = glb
  const tris = []
  const prims = []
  const walk = (index, parent) => {
    const node = json.nodes[index]
    const m = mul(parent, nodeMatrix(node))
    if (node.mesh !== undefined) {
      for (const prim of json.meshes[node.mesh].primitives) {
        prims.push(prim)
        expect(prim.mode ?? 4).toBe(4)
        const pos = readAccessor(glb, prim.attributes.POSITION, ['5126:VEC3'])
        const idx = prim.indices !== undefined
          ? readAccessor(glb, prim.indices, ['5121:SCALAR', '5123:SCALAR', '5125:SCALAR'])
          : Float64Array.from({ length: pos.length / 3 }, (_, i) => i)
        for (let i = 0; i + 2 < idx.length; i += 3) {
          for (let k = 0; k < 3; k++) {
            const j = idx[i + k] * 3
            const x = pos[j]
            const y = pos[j + 1]
            const z = pos[j + 2]
            tris.push(
              m[0] * x + m[4] * y + m[8] * z + m[12],
              m[1] * x + m[5] * y + m[9] * z + m[13],
              m[2] * x + m[6] * y + m[10] * z + m[14]
            )
          }
        }
      }
    }
    for (const c of node.children ?? []) walk(c, m)
  }
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
  for (const root of json.scenes[json.scene ?? 0].nodes) walk(root, identity)
  const mn = [Infinity, Infinity, Infinity]
  const mx = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < tris.length; i++) {
    mn[i % 3] = Math.min(mn[i % 3], tris[i])
    mx[i % 3] = Math.max(mx[i % 3], tris[i])
  }
  return { json, prims, tris: Float64Array.from(tris), mn, mx }
}

// --- Placement and silhouettes (furniture-proxies.test.js, wall-hugged) -----

const DIR = [[0, 1], [0, -1], [1, 0], [-1, 0]]
const FACING_ANGLE = [0, Math.PI, Math.PI / 2, -Math.PI / 2]
const LX = 6
const LZ = 7

function placement(kind, [w, d], facing) {
  const [dx, dz] = DIR[facing]
  const off = -(CELL / 2 - THICK / 2 - d / 2 - 0.06) // back onto the wall
  const alongX = dx !== 0
  return {
    kind, lx: LX, lz: LZ, facing,
    x: (LX + 0.5) * CELL + dx * off, z: (LZ + 0.5) * CELL + dz * off,
    w: alongX ? d : w, d: alongX ? w : d,
  }
}

function placeTriangles(local, f) {
  const a = FACING_ANGLE[f.facing & 3]
  const c = Math.round(Math.cos(a))
  const s = Math.round(Math.sin(a))
  const out = new Float64Array(local.length)
  for (let i = 0; i < local.length; i += 3) {
    const x = local[i]
    const z = local[i + 2]
    out[i] = f.x + c * x + s * z
    out[i + 1] = local[i + 1]
    out[i + 2] = f.z - s * x + c * z
  }
  return out
}

function makeView(name, hAxis, sign, wAxis) {
  const cell0 = [LX * CELL, 0, LZ * CELL]
  const h0 = (sign > 0 ? cell0[hAxis] : -(cell0[hAxis] + CELL)) - JITTER
  const w0 = (wAxis === 1 ? 0 : cell0[wAxis]) - JITTER
  const nh = Math.round(CELL / RES) + 1
  const nw = Math.round((wAxis === 1 ? GRID_H : CELL) / RES) + 1
  return { name, hAxis, sign, wAxis, h0, w0, nh, nw }
}

function viewsFor(facing) {
  const frontAlongZ = DIR[facing][0] === 0
  const across = frontAlongZ ? 0 : 2
  const along = frontAlongZ ? 2 : 0
  return [
    makeView('top', 0, 1, 2),
    makeView('front', across, 1, 1),
    makeView('back', across, -1, 1),
    makeView('left', along, 1, 1),
    makeView('right', along, -1, 1),
  ]
}

const firstPx = (a, o) => Math.ceil((a - o) / RES - 0.5)
const lastPx = (a, o) => Math.floor((a - o) / RES - 0.5)

function rasterTriangles(tris, v) {
  const mask = new Uint8Array(v.nh * v.nw)
  for (let t = 0; t < tris.length; t += 9) {
    const ax = v.sign * tris[t + v.hAxis]
    const ay = tris[t + v.wAxis]
    const bx = v.sign * tris[t + 3 + v.hAxis]
    const by = tris[t + 3 + v.wAxis]
    const cx = v.sign * tris[t + 6 + v.hAxis]
    const cy = tris[t + 6 + v.wAxis]
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
    if (Math.abs(area) < 1e-12) continue
    const s = Math.sign(area)
    const i0 = Math.max(0, firstPx(Math.min(ax, bx, cx), v.h0))
    const i1 = Math.min(v.nh - 1, lastPx(Math.max(ax, bx, cx), v.h0))
    const j0 = Math.max(0, firstPx(Math.min(ay, by, cy), v.w0))
    const j1 = Math.min(v.nw - 1, lastPx(Math.max(ay, by, cy), v.w0))
    for (let j = j0; j <= j1; j++) {
      const py = v.w0 + (j + 0.5) * RES
      for (let i = i0; i <= i1; i++) {
        const px = v.h0 + (i + 0.5) * RES
        if (s * ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) < -1e-12) continue
        if (s * ((cx - bx) * (py - by) - (cy - by) * (px - bx)) < -1e-12) continue
        if (s * ((ax - cx) * (py - cy) - (ay - cy) * (px - cx)) < -1e-12) continue
        mask[j * v.nh + i] = 1
      }
    }
  }
  return mask
}

function rasterBoxes(boxes, v) {
  const mask = new Uint8Array(v.nh * v.nw)
  const lo = (b, axis) => [b.x0, b.y0, b.z0][axis]
  const hi = (b, axis) => [b.x1, b.y1, b.z1][axis]
  for (const b of boxes) {
    const ha = v.sign > 0 ? lo(b, v.hAxis) : -hi(b, v.hAxis)
    const hb = v.sign > 0 ? hi(b, v.hAxis) : -lo(b, v.hAxis)
    const i0 = Math.max(0, firstPx(ha, v.h0))
    const i1 = Math.min(v.nh - 1, lastPx(hb, v.h0))
    const j0 = Math.max(0, firstPx(lo(b, v.wAxis), v.w0))
    const j1 = Math.min(v.nw - 1, lastPx(hi(b, v.wAxis), v.w0))
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) mask[j * v.nh + i] = 1
  }
  return mask
}

function iou(a, b) {
  let inter = 0
  let union = 0
  for (let k = 0; k < a.length; k++) {
    inter += a[k] & b[k]
    union += a[k] | b[k]
  }
  return union ? inter / union : 1
}

// Worst top / side IoU of a kind's proxies vs its GLB over the four facings.
function proxyScores(kind, dims, local) {
  let top = 1
  let side = 1
  for (let facing = 0; facing < 4; facing++) {
    const f = placement(kind, dims, facing)
    const world = placeTriangles(local, f)
    const boxes = []
    furnitureProxyBoxes(f, boxes)
    const solid = boxes.filter((b) => b.t < SEE_THROUGH_T)
    for (const v of viewsFor(facing)) {
      const score = iou(rasterTriangles(world, v), rasterBoxes(solid, v))
      if (v.name === 'top') top = Math.min(top, score)
      else side = Math.min(side, score)
    }
  }
  return { top, side }
}

// Worst front / back IoU of a kind's box fallback vs its GLB over the four facings.
function fallbackFrontScore(kind, dims, local) {
  let front = 1
  for (let facing = 0; facing < 4; facing++) {
    const f = placement(kind, dims, facing)
    const world = placeTriangles(local, f)
    const boxes = pushFurnitureModel([], f).map((p) => ({
      x0: p.px - p.sx / 2, x1: p.px + p.sx / 2,
      y0: p.py - p.sy / 2, y1: p.py + p.sy / 2,
      z0: p.pz - p.sz / 2, z1: p.pz + p.sz / 2,
    }))
    for (const v of viewsFor(facing)) {
      if (v.name !== 'front' && v.name !== 'back') continue
      front = Math.min(front, iou(rasterTriangles(world, v), rasterBoxes(boxes, v)))
    }
  }
  return front
}

async function paintedColour(file) {
  const buffer = readFileSync(file)
  const { scene } = await new GLTFLoader().parseAsync(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), ''
  )
  let lo = Infinity, sum = 0, count = 0, unpainted = 0
  scene.traverse((node) => {
    if (!node.isMesh) return
    const color = node.geometry.attributes.color
    if (!color || !node.material.vertexColors) {
      unpainted++
      return
    }
    for (let i = 0; i < color.count; i++) {
      const v = (color.getX(i) + color.getY(i) + color.getZ(i)) / 3
      lo = Math.min(lo, v)
      sum += v
      count++
    }
  })
  disposeModelScene(scene)
  return { lo, mean: count ? sum / count : 0, count, unpainted }
}

// --- Packs with exports --------------------------------------------------------

describe.each(PROP_PACKS.map((p) => [p.pack, p]))('prop pack "%s" exports', (pack, data) => {
  const built = existsSync(manifestPath(pack))
  const run = built || REQUIRE_PROP_MODELS

  it.skipIf(!run)('has a manifest listing exactly the registry kinds', () => {
    expect(built, `public/models/${pack}/manifest.json`).toBe(true)
    const manifest = readManifest(pack)
    expect(manifest.pack).toBe(pack)
    const listed = manifest.kinds.map((k) => [k.kindKey, k.kind, k.file]).sort()
    const registry = data.kinds.map((k) => [k.key, k.kind, `${k.kind}.glb`]).sort()
    expect(listed).toEqual(registry)
    for (const k of data.kinds) {
      const m = manifest.kinds.find((e) => e.kindKey === k.key)
      expect(m.collision.w, k.key).toBeCloseTo(k.dims[0], 6)
      expect(m.collision.d, k.key).toBeCloseTo(k.dims[1], 6)
      expect(Math.abs(m.heightBudget - k.height), k.key).toBeLessThanOrEqual(DIM_TOL)
      expect(existsSync(path.join(MODELS_ROOT, pack, m.file)), m.file).toBe(true)
    }
  })

  it.skipIf(!run)('keeps every GLB on the floor, inside its footprint and height budget', () => {
    for (const k of data.kinds) {
      const { json, prims, mn, mx } = glbScene(path.join(MODELS_ROOT, pack, `${k.kind}.glb`))
      const [w, d] = k.dims
      expect(mn[1], k.key).toBeGreaterThanOrEqual(-0.005)
      expect(mx[0] - mn[0], k.key).toBeLessThanOrEqual(w + TOL_XZ)
      expect(mx[2] - mn[2], k.key).toBeLessThanOrEqual(d + TOL_XZ)
      expect(Math.abs((mn[0] + mx[0]) / 2), k.key).toBeLessThanOrEqual(TOL_CENTER)
      expect(Math.abs((mn[2] + mx[2]) / 2), k.key).toBeLessThanOrEqual(TOL_CENTER)
      expect(mx[1], k.key).toBeLessThanOrEqual(k.height + TOL_H)
      for (const prim of prims) {
        expect(prim.material, k.key).toBeTypeOf('number')
        expect(prim.attributes.TEXCOORD_0, k.key).toBeUndefined()
        expect(json.accessors[prim.attributes.COLOR_0], k.key)
          .toMatchObject({ componentType: 5121, normalized: true, type: 'VEC4' })
      }
      expect(json.extensionsRequired ?? [], k.key).toHaveLength(0)
    }
  })

  it.skipIf(!run)('ships the painted vertex-colour look', async () => {
    for (const k of data.kinds) {
      const c = await paintedColour(path.join(MODELS_ROOT, pack, `${k.kind}.glb`))
      expect(c.unpainted, k.key).toBe(0)
      expect(c.count, k.key).toBeGreaterThan(0)
      expect(c.lo, k.key).toBeGreaterThanOrEqual(0.6)
      expect(c.mean, k.key).toBeGreaterThan(0.72)
    }
  })

  it.skipIf(!run)('casts proxies that match the GLB silhouettes at every facing', () => {
    for (const k of data.kinds) {
      const { tris } = glbScene(path.join(MODELS_ROOT, pack, `${k.kind}.glb`))
      const { top, side } = proxyScores(k.id, k.dims, tris)
      expect(top, `${k.key} top IoU`).toBeGreaterThanOrEqual(TOP_FLOOR[k.id] ?? TOP_MIN)
      expect(side, `${k.key} side IoU`).toBeGreaterThanOrEqual(SIDE_FLOOR[k.id] ?? SIDE_MIN)
      // Exceptions stay honest: a floor must actually be needed.
      if (k.id in TOP_FLOOR) expect(top, `${k.key} no longer needs its top floor`).toBeLessThan(TOP_MIN)
      if (k.id in SIDE_FLOOR) expect(side, `${k.key} no longer needs its side floor`).toBeLessThan(SIDE_MIN)
    }
  })

  it.skipIf(!run)('keeps a box fallback that matches the GLB front silhouette', () => {
    for (const k of data.kinds) {
      const { tris } = glbScene(path.join(MODELS_ROOT, pack, `${k.kind}.glb`))
      const front = fallbackFrontScore(k.id, k.dims, tris)
      expect(front, `${k.key} fallback front IoU`).toBeGreaterThanOrEqual(FALLBACK_FRONT_MIN)
    }
  })
})

// --- Always-running checks -----------------------------------------------------

describe('prop pack surfaces', () => {
  it('merge into GLTF_SURFACES without redefining or disagreeing', () => {
    expect(GLTF_SURFACE_CONFLICTS).toEqual([])
    for (const { pack, surfaces } of PROP_PACKS) {
      for (const [name, [roughness, metalness = 0]] of Object.entries(surfaces ?? {})) {
        expect(name, pack).toMatch(/^yr_/)
        expect(GLTF_SURFACES[name], `${pack} ${name}`).toEqual({ roughness, metalness })
      }
    }
    expect(Object.isFrozen(GLTF_SURFACES)).toBe(true)
    expect(GLTF_SURFACES.yr_chrome).toEqual({ roughness: 0.16, metalness: 1 })
  })

  it('guards against conflicting or malformed pack entries', () => {
    const base = { yr_chrome: Object.freeze({ roughness: 0.16, metalness: 1 }) }
    const { surfaces, conflicts } = mergePackSurfaces(base, [
      { pack: 'a', surfaces: { yr_chrome: [0.16, 1], yr_new: [0.5], yr_bad: ['x', 0] } },
      { pack: 'b', surfaces: { yr_chrome: [0.3, 1], yr_new: [0.6, 0] } },
      { pack: 'c' },
    ])
    expect(surfaces.yr_chrome).toBe(base.yr_chrome)
    expect(surfaces.yr_new).toEqual({ roughness: 0.5, metalness: 0 })
    expect(surfaces.yr_bad).toBeUndefined()
    expect(conflicts).toHaveLength(3) // a.yr_bad, b.yr_chrome, b.yr_new
  })
})

describe('prop records in chunk meshing', () => {
  function stubMaterials() {
    const m = new THREE.MeshBasicMaterial()
    return {
      carpet: m, ceiling: m, wallpaper: m, doorFrame: m, doorLeaf: m, prop: m, signGlow: m,
      furniture: m, furnitureModel: m, panel: m, panelDead: m, exit: m,
    }
  }

  function propData() {
    const data = new ChunkData(0, 0, 0, 0)
    data.furniture.push(
      { kind: PROP_CART, lx: 2, lz: 2, x: 7.5, z: 7.5, w: 0.6, d: 1.0, facing: 0 },
      { kind: PROP_LOUNGER, lx: 4, lz: 4, x: 13.5, z: 13.5, w: 1.95, d: 0.7, facing: 2 }
    )
    return data
  }

  it('draws props through the box fallback when no model is loaded', () => {
    const geom = createGeometries()
    const mesh = buildChunkMeshes(propData(), geom, stubMaterials(), 0, 0, 0, null)
    const node = mesh.parts.furniture
    expect(node.children).toHaveLength(1)
    expect(node.children[0].geometry).toBe(geom.detailUnit)
    expect(node.children[0].count).toBeGreaterThanOrEqual(6) // cart + lounger parts
    mesh.dispose()
  })

  it('swaps in a loaded prop GLB and keeps the rest on boxes', () => {
    const geom = createGeometries()
    const lib = createFurnitureModelLibrary()
    lib.geometries.set(PROP_CART, new THREE.BoxGeometry(0.6, 1, 1))
    lib.loaded = true
    const mesh = buildChunkMeshes(propData(), geom, stubMaterials(), 0, 0, 0, lib)
    const node = mesh.parts.furniture
    expect(node.children).toHaveLength(2)
    expect(node.children.some((c) => c.geometry === lib.geometries.get(PROP_CART))).toBe(true)
    expect(node.children.some((c) => c.geometry === geom.detailUnit)).toBe(true)
    mesh.dispose()
  })

  it('feeds the light grid the registry proxies', () => {
    const [cart] = propData().furniture
    const out = []
    expect(furnitureProxyBoxes(cart, out)).toBe(PROP_PROXIES[PROP_CART].length)
  })
})
