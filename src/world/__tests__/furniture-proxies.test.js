import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  FURNITURE_PROXIES,
  OCC_MAX_H,
  furnitureProxyBoxes,
} from '../objects/furniture/proxies.js'
import { builder } from '../objects/furniture/frame.js'
import * as FURN from '../furniture.js'
import { PIECE_DIMS } from '../rooms/furnish.js'
import { CELL, THICK, CHAIR_W, DESK_W, DESK_D, TABLE_W, TABLE_D } from '../constants.js'

// Furniture shadow proxies vs the GLBs as rendered. Every GLB is parsed with
// node:fs alone (no three.js), placed exactly the way world/mesh.js instances
// it (scale 1, rotY by facing, translate to the record's x/z), and compared
// with furnitureProxyBoxes() output through 2 cm orthographic binary
// silhouettes — top, front, back, left, right — for all four facings, so the
// facing mapping is exercised end to end in world x/z. Proxy boxes with
// t >= 5 are mostly light (a table's see-through leg frame) and stay out of
// the silhouettes: they dim rather than shadow.

const MODELS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../public/models/furniture'
)

const RES = 0.02 // silhouette pixel (m)
const GRID_H = 2.24 // silhouette height range [0, GRID_H) — above OCC_MAX_H
// Sub-pixel grid offset: keeps cm-round coordinates off exact pixel centres,
// so no IoU hinges on float32-vs-float64 tie breaking.
const JITTER = 0.0037
const TOP_MIN = 0.8
const SIDE_MIN = 0.7
const SEE_THROUGH_T = 5
// Documented per-kind side floors (see the table in proxies.js), set just
// under the best a physically consistent pair of boxes reaches (measured:
// table .572, chair .519), never below 0.5.
//   table: four separate corner legs. The only pairs that beat .58 from the
//     side spend box B on ONE leg (.74) — a lone asymmetric leg shadow. The
//     legs ride in a t=7 leg-frame box instead (it dims; excluded here).
//   chair: the five-star base + gas post (~30% of the side silhouette) sit
//     under the seat and cannot share its box; a snapped 2-box search over
//     the GLB's own coordinates tops out near .52.
const SIDE_FLOOR = { [FURN.FURN_TABLE]: 0.55, [FURN.FURN_CHAIR]: 0.5 }

// Kind id -> GLB name, by the naming convention render/furnitureModels.js
// FURNITURE_MODEL_FILES follows (FURN_DESK -> desk.glb). Kept import-free of
// three.js; the "every GLB has a kind" check below catches drift.
const KINDS = Object.entries(FURN)
  .filter(([k, v]) => k.startsWith('FURN_') && Number.isInteger(v))
  .map(([k, v]) => ({ id: v, key: k, file: `${k.slice(5).toLowerCase()}.glb` }))

// facing -> front direction (furnish.js DIR): 0=+z 1=-z 2=+x 3=-x.
const DIR = [[0, 1], [0, -1], [1, 0], [-1, 0]]
// world/mesh.js FURN_FACING_ANGLE: the instance rotY per facing.
const FACING_ANGLE = [0, Math.PI, Math.PI / 2, -Math.PI / 2]

// --- Minimal GLB reader (glTF 2.0 binary) ---------------------------------

const COMPONENT = {
  5121: [1, 'getUint8'],
  5123: [2, 'getUint16'],
  5125: [4, 'getUint32'],
  5126: [4, 'getFloat32'],
}
const WIDTH = { SCALAR: 1, VEC3: 3 }

function readGlb(file) {
  const buf = readFileSync(path.join(MODELS_DIR, file))
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  expect(dv.getUint32(0, true)).toBe(0x46546c67) // 'glTF'
  expect(dv.getUint32(4, true)).toBe(2)
  let json = null
  let bin = null
  for (let off = 12; off + 8 <= dv.getUint32(8, true);) {
    const len = dv.getUint32(off, true)
    const type = dv.getUint32(off + 4, true)
    const body = buf.subarray(off + 8, off + 8 + len)
    if (type === 0x4e4f534a) json = JSON.parse(body.toString('utf8')) // JSON
    else if (type === 0x004e4942) bin = body // BIN
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

// Column-major 4x4 helpers (glTF convention).
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

// Every triangle of every primitive of every scene node, in model space
// (= the piece's local u/y/v frame): flat [x, y, z] x 3 per triangle.
function glbTriangles(file) {
  const glb = readGlb(file)
  const { json } = glb
  const tris = []
  const walk = (index, parent) => {
    const node = json.nodes[index]
    const m = mul(parent, nodeMatrix(node))
    if (node.mesh !== undefined) {
      for (const prim of json.meshes[node.mesh].primitives) {
        expect(prim.mode ?? 4).toBe(4) // TRIANGLES
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
  return Float64Array.from(tris)
}

// mesh.js instance transform: rotY(FACING_ANGLE[facing]) then translate to
// (f.x, 0, f.z), scale 1. Quarter-turn sin/cos are rounded to exact integers.
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

// --- Placements --------------------------------------------------------------

// Realistic records per furnish.js: row pieces and desks hug the wall behind
// them, chairs hug the boundary toward the table/desk they face, tables sit
// on the cell centre. Every kind is exercised at all four facings.
const LX = 6
const LZ = 7
function placement(kind, facing) {
  const [dx, dz] = DIR[facing]
  const cx = (LX + 0.5) * CELL
  const cz = (LZ + 0.5) * CELL
  let off = 0
  if (kind === FURN.FURN_CHAIR) off = CELL / 2 - CHAIR_W / 2 - 0.12
  else if (kind !== FURN.FURN_TABLE) {
    const depth = kind === FURN.FURN_DESK ? DESK_D : PIECE_DIMS[kind][1]
    off = -(CELL / 2 - THICK / 2 - depth / 2 - 0.06) // back onto the wall
  }
  const dims = kind === FURN.FURN_DESK ? [DESK_W, DESK_D]
    : kind === FURN.FURN_TABLE ? [TABLE_W, TABLE_D]
      : kind === FURN.FURN_CHAIR ? [CHAIR_W, CHAIR_W] : PIECE_DIMS[kind]
  const alongX = dx !== 0
  return {
    kind, lx: LX, lz: LZ, facing,
    x: cx + dx * off, z: cz + dz * off,
    w: alongX ? dims[1] : dims[0], d: alongX ? dims[0] : dims[1],
  }
}

// --- Silhouettes ---------------------------------------------------------------

// A view projects world points to (h, w) image coords: h = sign * p[hAxis],
// w = p[wAxis] (axes: 0 = x, 1 = y, 2 = z). The grid covers the piece's cell
// horizontally and [0, GRID_H) vertically (top view: the cell in both).
function makeView(name, hAxis, sign, wAxis) {
  const cell0 = [LX * CELL, 0, LZ * CELL]
  const h0 = (sign > 0 ? cell0[hAxis] : -(cell0[hAxis] + CELL)) - JITTER
  const w0 = (wAxis === 1 ? 0 : cell0[wAxis]) - JITTER
  const nh = Math.round(CELL / RES) + 1
  const nw = Math.round((wAxis === 1 ? GRID_H : CELL) / RES) + 1
  return { name, hAxis, sign, wAxis, h0, w0, nh, nw }
}

// Views named relative to the piece: front/back look along its front axis,
// left/right across it. Opposite views are mirror images (binary
// orthographic), yet all five are rasterised so every view is exercised.
function viewsFor(facing) {
  const frontAlongZ = DIR[facing][0] === 0
  const across = frontAlongZ ? 0 : 2 // horizontal axis seen from the front
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

// Pixel-centre sampling with inclusive edges, for triangles and rects alike.
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
    if (Math.abs(area) < 1e-12) continue // edge-on: no coverage
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

// Unclamped local -> world mapping via frame.js itself: one builder part per
// proxy box, read back as an AABB. The reference for the facing checks.
function frameAabb(f, b) {
  const parts = []
  builder(f, parts)(
    (b.u0 + b.u1) / 2, (b.y0 + b.y1) / 2, (b.v0 + b.v1) / 2,
    b.u1 - b.u0, b.y1 - b.y0, b.v1 - b.v0, null
  )
  const p = parts[0]
  return {
    x0: p.px - p.sx / 2, x1: p.px + p.sx / 2,
    y0: p.py - p.sy / 2, y1: p.py + p.sy / 2,
    z0: p.pz - p.sz / 2, z1: p.pz + p.sz / 2,
    t: b.t,
  }
}

const opacityArea = (b) =>
  ((b.u1 - b.u0) * (b.v1 - b.v0) + (b.u1 - b.u0) * (b.y1 - b.y0) + (b.v1 - b.v0) * (b.y1 - b.y0)) *
  (1 - b.t / 8)

// Parsed lazily inside a test: readGlb asserts on the file format.
let models = null
const modelOf = (kind) => {
  models ??= new Map(KINDS.map((k) => [k.id, glbTriangles(k.file)]))
  return models.get(kind)
}

describe('furniture shadow proxies: table contract', () => {
  it('covers exactly the placement kinds, one GLB each', () => {
    const glbs = readdirSync(MODELS_DIR).filter((f) => f.endsWith('.glb')).sort()
    expect(KINDS.map((k) => k.file).sort()).toEqual(glbs)
    expect(Object.keys(FURNITURE_PROXIES).map(Number).sort((a, b) => a - b))
      .toEqual(KINDS.map((k) => k.id).sort((a, b) => a - b))
  })

  it('holds 1-2 well-formed boxes per kind inside the half-cell footprint', () => {
    for (const { id, key } of KINDS) {
      const boxes = FURNITURE_PROXIES[id]
      expect(boxes.length, key).toBeGreaterThanOrEqual(1)
      expect(boxes.length, key).toBeLessThanOrEqual(2)
      for (const b of boxes) {
        expect(b.u0, key).toBeLessThan(b.u1)
        expect(b.v0, key).toBeLessThan(b.v1)
        expect(b.y0, key).toBeLessThan(b.y1)
        expect(b.y0, key).toBeGreaterThanOrEqual(0)
        expect(Number.isInteger(b.t) && b.t >= 0 && b.t <= 7, key).toBe(true)
        for (const c of [b.u0, b.u1, b.v0, b.v1]) expect(Math.abs(c), key).toBeLessThanOrEqual(CELL / 2)
      }
    }
  })

  it('orders box A first by opacity-weighted silhouette (the low tier casts A)', () => {
    for (const { id, key } of KINDS) {
      const [a, b] = FURNITURE_PROXIES[id]
      if (b) expect(opacityArea(a), key).toBeGreaterThanOrEqual(opacityArea(b))
    }
  })

  it('derives OCC_MAX_H from the table and keeps it under the 2.2 m budget', () => {
    const top = Math.max(...Object.values(FURNITURE_PROXIES).flat().map((b) => b.y1))
    expect(OCC_MAX_H).toBe(top)
    expect(OCC_MAX_H).toBeGreaterThanOrEqual(2.0)
    expect(OCC_MAX_H).toBeLessThanOrEqual(2.2)
    expect(OCC_MAX_H).toBeLessThan(GRID_H)
  })

  it('is frozen so no consumer can retune a shared proxy', () => {
    expect(Object.isFrozen(FURNITURE_PROXIES)).toBe(true)
    for (const boxes of Object.values(FURNITURE_PROXIES)) {
      expect(Object.isFrozen(boxes)).toBe(true)
      for (const b of boxes) expect(Object.isFrozen(b)).toBe(true)
    }
  })
})

describe('furnitureProxyBoxes', () => {
  it('maps u/v exactly like frame.js for every kind, facing and box', () => {
    for (const { id, key } of KINDS) {
      for (let facing = 0; facing < 4; facing++) {
        const f = placement(id, facing)
        const out = []
        expect(furnitureProxyBoxes(f, out)).toBe(FURNITURE_PROXIES[id].length)
        FURNITURE_PROXIES[id].forEach((b, i) => {
          const ref = frameAabb(f, b)
          for (const k of ['x0', 'x1', 'y0', 'y1', 'z0', 'z1']) {
            expect(out[i][k], `${key} facing ${facing} box ${i} ${k}`).toBeCloseTo(ref[k], 9)
          }
          expect(out[i].t).toBe(b.t)
        })
      }
    }
  })

  it('puts +v boxes on the front side and -v boxes on the back for each facing', () => {
    const cases = [
      [FURN.FURN_COPIER, 1, 1], // output tray, the +0.46 front
      [FURN.FURN_WHITEBOARD, 1, 1], // marker tray
      [FURN.FURN_BED, 1, -1], // headboard against the wall
      [FURN.FURN_SINK, 1, -1], // mirror
      [FURN.FURN_STOVE, 1, -1], // backguard
    ]
    for (const [kind, i, side] of cases) {
      for (let facing = 0; facing < 4; facing++) {
        const f = placement(kind, facing)
        const out = []
        furnitureProxyBoxes(f, out)
        const [dx, dz] = DIR[facing]
        const along = ((out[i].x0 + out[i].x1) / 2 - f.x) * dx + ((out[i].z0 + out[i].z1) / 2 - f.z) * dz
        expect(Math.sign(along), `kind ${kind} facing ${facing}`).toBe(side)
      }
    }
  })

  it('appends deterministic boxes that stay inside the piece cell', () => {
    for (const { id, key } of KINDS) {
      for (let facing = 0; facing < 4; facing++) {
        const f = placement(id, facing)
        const first = [{ sentinel: true }]
        const n = furnitureProxyBoxes(f, first)
        const again = [{ sentinel: true }]
        furnitureProxyBoxes({ ...f }, again)
        expect(first).toEqual(again)
        expect(first[0]).toEqual({ sentinel: true }) // appends, never clears
        expect(first.length).toBe(1 + n)
        for (const b of first.slice(1)) {
          expect(b.x0, key).toBeGreaterThanOrEqual(LX * CELL)
          expect(b.x1, key).toBeLessThanOrEqual((LX + 1) * CELL)
          expect(b.z0, key).toBeGreaterThanOrEqual(LZ * CELL)
          expect(b.z1, key).toBeLessThanOrEqual((LZ + 1) * CELL)
          expect(b.x0 < b.x1 && b.y0 < b.y1 && b.z0 < b.z1, key).toBe(true)
        }
      }
    }
  })

  it('clamps to the cell when a record sits off its placement contract', () => {
    // Centre 0.1 m inside the cell corner: every box must be cut at the cell
    // walls rather than spill into the neighbours' occupancy slots.
    const f = { kind: FURN.FURN_TABLE, lx: 2, lz: 3, x: 2 * CELL + 0.1, z: 3 * CELL + 0.1, facing: 0 }
    const out = []
    expect(furnitureProxyBoxes(f, out)).toBe(2)
    for (const b of out) {
      expect(b.x0).toBe(2 * CELL)
      expect(b.z0).toBe(3 * CELL)
      expect(b.x1).toBeCloseTo(f.x + FURNITURE_PROXIES[FURN.FURN_TABLE][out.indexOf(b)].u1, 9)
    }
    // Without lx/lz the cell is derived from the centre, like placement.
    const bare = []
    furnitureProxyBoxes({ kind: f.kind, x: f.x, z: f.z, facing: 0 }, bare)
    expect(bare).toEqual(out)
  })

  it('ignores unknown kinds', () => {
    const out = []
    expect(furnitureProxyBoxes({ kind: 999, lx: 1, lz: 1, x: 4.5, z: 4.5, facing: 0 }, out)).toBe(0)
    expect(out).toEqual([])
  })
})

describe('furniture shadow proxies vs the rendered GLBs (2 cm silhouettes)', () => {
  it('matches every kind from the top and all four sides at every facing', () => {
    const worst = new Map()
    for (const { id, key, file } of KINDS) {
      const local = modelOf(id)
      expect(local.length, file).toBeGreaterThan(0)
      let top = 1
      let side = 1
      for (let facing = 0; facing < 4; facing++) {
        const f = placement(id, facing)
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
      worst.set(key, { top, side })
      expect(top, `${key} top IoU`).toBeGreaterThanOrEqual(TOP_MIN)
      expect(side, `${key} side IoU`).toBeGreaterThanOrEqual(SIDE_FLOOR[id] ?? SIDE_MIN)
    }
    // Exceptions stay honest: each floor must actually be needed.
    for (const [id, floor] of Object.entries(SIDE_FLOOR)) {
      const key = KINDS.find((k) => k.id === Number(id)).key
      expect(worst.get(key).side, `${key} no longer needs its floor`).toBeLessThan(SIDE_MIN)
      expect(floor).toBeGreaterThanOrEqual(0.5)
    }
  })
})
