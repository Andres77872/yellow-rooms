import { catalogVoidAt, isCatalogKind } from './structures/catalog/engine.js'
import * as THREE from 'three'
import {
  CELL,
  CHUNK,
  CHUNK_WORLD,
  WALL_H,
  WALL_BEVEL,
  LAYER_H,
  STAIR_STEPS,
  COL_HALF,
  MONUMENTAL_COL_HALF,
  DOOR_LEAF_FRACTION,
  DOOR_DARK_CHANCE,
  DOOR_DARK_TINT,
  DOOR_TINT_VAR,
  WINDOW_SALT,
  BRIDGE_BEAM_H,
  BRIDGE_BEAM_W,
  vIdx,
  hIdx,
  cIdx,
} from './constants.js'
import { collectDoorways } from './doors.js'
import { collectWallShell, mergeCollinearBoxes } from './objects/wallShell.js'
import {
  pushDoorFrame,
  pushDoorLeaves,
  pushWindowTrim,
  collectInteriorDressing,
  pushFurnitureModel,
} from './objects/index.js'
import { hash2i } from './core/hash.js'
import { lampPanelTint } from './lampCharacter.js'
import { STAIR_E, STAIR_S, STAIR_W } from './structures/slab.js'
import { COLUMN_FURNITURE, COLUMN_MONUMENTAL, WALL_WINDOW } from './mapTypes.js'

const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _p = new THREE.Vector3()
const _s = new THREE.Vector3()
const _c = new THREE.Color()
const _tint3 = [0, 0, 0]
// Furniture GLB instancing: placement records rotate whole models by facing
// (0=+z 1=-z 2=+x 3=-x — the same mapping objects/furniture/frame.js applies
// to box parts). rotY angles below reproduce that frame exactly.
const _qf = new THREE.Quaternion()
const _Y_AXIS = new THREE.Vector3(0, 1, 0)
const FURN_FACING_ANGLE = [0, Math.PI, Math.PI / 2, -Math.PI / 2]

// Per-door leaf colour from the doorway's deterministic tone seed (doors.js).
// instanceColor multiplies the doorLeaf material's painted-cream base: most
// leaves drift a little in brightness; a rare one comes out dark-stained —
// the liminal "this door is wrong" beat. Knob parts go dark metal.
function leafTint(part, out) {
  if (part.role === 1) return out.setRGB(0.25, 0.22, 0.18)
  const tone = part.tone ?? 0.5
  if (tone < DOOR_DARK_CHANCE) {
    return out.setRGB(DOOR_DARK_TINT, DOOR_DARK_TINT * 0.88, DOOR_DARK_TINT * 0.76)
  }
  const t = (tone - DOOR_DARK_CHANCE) / (1 - DOOR_DARK_CHANCE)
  const b = 1 - DOOR_TINT_VAR + 2 * DOOR_TINT_VAR * t
  return out.setRGB(b, b * 0.99, b * 0.955)
}

// Per-instance variation for GLB furniture (engine-improvement §3.4): the
// instanceColor attribute was bound but always white, so every copy of a
// desk read as the same object. A deterministic +-5% brightness drift with a
// slight warm/cool lean — keyed by the piece's GLOBAL cell, so a chunk
// reload never re-rolls it — reads as age and batch variation, not paint.
function furnitureInstanceTint(data, f, out) {
  const h = hash2i(0x5f1d, data.cx * CHUNK + f.lx, data.cz * CHUNK + f.lz)
  const b = 0.95 + ((h & 1023) / 1023) * 0.1
  const lean = (((h >>> 10) & 1023) / 1023 - 0.5) * 0.04
  return out.setRGB(b * (1 + lean), b, b * (1 - lean))
}

// --- Furniture node ------------------------------------------------------
// One Group per chunk holding the collision-real furniture. Two render paths
// with identical placement semantics (record x/z chunk-local centre, facing
// 0..3 rotating the piece):
//   GLB path — the Blender-built models (render/furnitureModels.js), one
//     InstancedMesh per kind present, per-vertex part colors from the GLB and
//     a white per-instance tint (instanceColor stays bound: the material
//     declares USE_INSTANCING_COLOR and an unbound attribute reads black).
//   box path — the procedural builders (objects/furniture/), one InstancedMesh
//     of scaled unit boxes with per-part tints. Used until the GLBs load and
//     as the permanent fallback when they are unavailable (tests, editor,
//     network failure).
export function buildFurniturePart(data, geom, materials, models = null) {
  if (!data.furniture.length) return null
  const node = new THREE.Group()
  node.name = 'furniture'

  const geometries = models?.geometries
  if (geometries?.size && materials.furnitureModel) {
    const byKind = new Map()
    const uncovered = [] // kinds without a loaded GLB keep the box treatment
    for (const f of data.furniture) {
      if (!geometries.has(f.kind)) {
        uncovered.push(f)
        continue
      }
      if (!byKind.has(f.kind)) byKind.set(f.kind, [])
      byKind.get(f.kind).push(f)
    }
    _s.set(1, 1, 1)
    for (const [kind, list] of byKind) {
      const batch = new THREE.InstancedMesh(geometries.get(kind), materials.furnitureModel, list.length)
      for (let i = 0; i < list.length; i++) {
        const f = list[i]
        _p.set(f.x, 0, f.z)
        _qf.setFromAxisAngle(_Y_AXIS, FURN_FACING_ANGLE[f.facing & 3])
        _m.compose(_p, _qf, _s)
        batch.setMatrixAt(i, _m)
        batch.setColorAt(i, furnitureInstanceTint(data, f, _c))
      }
      batch.instanceMatrix.needsUpdate = true
      batch.instanceColor.needsUpdate = true
      batch.computeBoundingSphere()
      node.add(batch)
    }
    if (uncovered.length) pushBoxBatch(node, geom, materials, uncovered)
  } else if (data.furniture.length) {
    pushBoxBatch(node, geom, materials, data.furniture)
  }

  return node.children.length ? node : null
}

// The procedural fallback: multi-part models (objects/furniture/) batched
// into one instanced bevelled-box draw with per-part tints.
function pushBoxBatch(node, geom, materials, records) {
  const parts = []
  for (const f of records) pushFurnitureModel(parts, f)
  const batch = boxBatch(geom.detailUnit, materials.furniture, parts, partTint)
  if (batch) node.add(batch)
}

const partTint = (it, out) => out.setRGB(it.tint[0], it.tint[1], it.tint[2])

// One InstancedMesh of unit boxes from {px,py,pz, sx,sy,sz} descriptors
// (axis-aligned, chunk-local), optionally coloured per instance. Every
// architecture batch in this file goes through here; null when empty.
function boxBatch(geometry, material, list, colorOf = null) {
  if (!list.length) return null
  const batch = new THREE.InstancedMesh(geometry, material, list.length)
  for (let i = 0; i < list.length; i++) {
    const it = list[i]
    _p.set(it.px, it.py, it.pz)
    _s.set(it.sx, it.sy, it.sz)
    _m.compose(_p, _q, _s)
    batch.setMatrixAt(i, _m)
    if (colorOf) batch.setColorAt(i, colorOf(it, _c))
  }
  batch.instanceMatrix.needsUpdate = true
  if (colorOf) batch.instanceColor.needsUpdate = true
  batch.computeBoundingSphere() // else the whole batch frustum-culls wrongly
  return batch
}

// The furniture node owns only its InstancedMesh GPU buffers: geometries and
// materials are shared (model library / gbuffer materials) and disposed with
// their owners.
// Idempotent: a chunk whose furniture was swapped by refreshFurniture() owns
// two generations of parts, and both teardown paths may reach the first.
export function disposeFurniturePart(node) {
  if (!node || node.userData.disposed) return
  node.userData.disposed = true
  for (const child of node.children) child.dispose()
  node.parent?.remove(node)
}

// Build the THREE meshes for one chunk from its ChunkData (thin-wall model).
// Returns { group, lamps, exitWorld, dispose }. Geometry/materials are shared
// (created once); only per-chunk InstancedMesh GPU buffers — and, for stair
// chunks, the hole-punched slab geometries — are owned here.
//
// Walls are emitted as merged runs of collinear cell edges resolved at every
// vertex (objects/wallShell.js), plus columns and bridge beams — all in a
// single InstancedMesh / draw call of the bevelled wall cube (render/bevel.js);
// the wallpaper samples world-space UVs, so a run of any length keeps one
// texel density. A stair flight adds one wallpaper draw of fully bevelled
// treads. A chunk OWNS its West (lx=0) and North (lz=0) border lines and all
// interior lines; the East/South borders are drawn by the neighbours as their
// line 0, so every shared wall is drawn once (a run crossing a seam overlaps
// the neighbour's by THICK, coplanar and invisible). Vertically (v8) a chunk
// owns its floor top face and its
// ceiling underside; the SLAB_T gap between one chunk's ceiling and the next
// layer's floor is only ever seen through stair holes, whose rim skirts are
// owned by the LOWER chunk (the slab owner, matching the contract convention).

// One quad = two front-facing triangles; corners CCW as seen from the normal.
function pushQuad(arr, n, uv, c0, c1, c2, c3, u0, u1, u2, u3, nx, ny, nz) {
  for (const [c, u] of [
    [c0, u0],
    [c1, u1],
    [c2, u2],
    [c0, u0],
    [c2, u2],
    [c3, u3],
  ]) {
    arr.push(c[0], c[1], c[2])
    n.push(nx, ny, nz)
    uv.push(u[0], u[1])
  }
}

// Hole-punched floor (the slab's top face, local y 0): row-span merged quads
// over the cell grid skipping `holes` ("lx,lz" strings). UVs are 1 per cell,
// matching scaleUV(plane, CHUNK) on the shared geometry.
function buildFloorFace(holes) {
  const pos = []
  const nrm = []
  const uv = []
  for (let z = 0; z < CHUNK; z++) {
    let start = -1
    for (let x = 0; x <= CHUNK; x++) {
      const solid = x < CHUNK && !holes.has(`${x},${z}`)
      if (solid && start < 0) start = x
      if (!solid && start >= 0) {
        const [ax, bx, az, bz] = [start * CELL, x * CELL, z * CELL, (z + 1) * CELL]
        pushQuad(
          pos, nrm, uv,
          [ax, 0, az], [ax, 0, bz], [bx, 0, bz], [bx, 0, az],
          [start, z], [start, z + 1], [x, z + 1], [x, z],
          0, 1, 0
        )
        start = -1
      }
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  return geo
}

// Smooth-shaded quad: corners in either winding, flipped to face along the
// mean of the per-corner normals.
const _e1 = new THREE.Vector3()
const _e2 = new THREE.Vector3()
function pushSmoothQuad(pos, nrm, uv, corners, normals, uvs) {
  _e1.set(corners[1][0] - corners[0][0], corners[1][1] - corners[0][1], corners[1][2] - corners[0][2])
  _e2.set(corners[2][0] - corners[0][0], corners[2][1] - corners[0][1], corners[2][2] - corners[0][2])
  _e1.cross(_e2)
  let dot = 0
  for (const n of normals) dot += _e1.x * n[0] + _e1.y * n[1] + _e1.z * n[2]
  const order = dot < 0 ? [0, 3, 2, 0, 2, 1] : [0, 1, 2, 0, 2, 3]
  for (const i of order) {
    pos.push(corners[i][0], corners[i][1], corners[i][2])
    nrm.push(normals[i][0], normals[i][1], normals[i][2])
    uv.push(uvs[i][0], uvs[i][1])
  }
}

const NOSING_SEGMENTS = 3

// Ceiling underside of a punched slab plus the inward skirts that close each
// hole over the slab thickness (local y WALL_H..LAYER_H). Each solid/void
// boundary edge is emitted independently, so irregular masks and the two
// lobes split by a retained bridge deck stay open (a bounding-rectangle rim
// would seal them).
//
// The skirt's lower edge — the slab nosing seen looking up a stairwell or an
// atrium — rounds at WALL_BEVEL like the wall shell: a quarter-round strip
// replaces the corner and the underside steps back by the radius along every
// hole-facing side. Strip ends mitre where the boundary turns: round a solid
// corner (convex) they draw back, into a notch (reflex) they run on over the
// corner square the underside gives up, so the two strips meeting at a
// corner share one diagonal end profile and the slab stays closed. Above the
// strip the skirt is the plain vertical face it always was.
export function buildCeilingSlab(holes, outsideHole = null) {
  const r = WALL_BEVEL
  const y0 = WALL_H
  const y1 = LAYER_H
  const pos = []
  const nrm = []
  const uv = []
  const has = (x, z) => {
    if (x >= 0 && x < CHUNK && z >= 0 && z < CHUNK) return holes.has(`${x},${z}`)
    return outsideHole ? outsideHole(x, z) : false
  }
  const under = (x0, z0, x1, z1) =>
    pushQuad(
      pos, nrm, uv,
      [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1],
      [x0 / CELL, z0 / CELL], [x1 / CELL, z0 / CELL], [x1 / CELL, z1 / CELL], [x0 / CELL, z1 / CELL],
      0, -1, 0
    )

  // Underside. A solid cell touching a hole (by a side or a corner) is cut
  // on a 3x3 grid at the radius, dropping the bands under hole-facing sides
  // and the corner square of a notch; every other cell merges into row spans.
  const touchesHole = (x, z) => {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) if ((dx || dz) && has(x + dx, z + dz)) return true
    }
    return false
  }
  const cutCell = (x, z) => {
    const w = has(x - 1, z)
    const e = has(x + 1, z)
    const n = has(x, z - 1)
    const s = has(x, z + 1)
    const notch = (dx, dz) => has(x + dx, z + dz) && !has(x + dx, z) && !has(x, z + dz)
    const xs = [x * CELL, x * CELL + r, (x + 1) * CELL - r, (x + 1) * CELL]
    const zs = [z * CELL, z * CELL + r, (z + 1) * CELL - r, (z + 1) * CELL]
    for (let j = 0; j < 3; j++) {
      if ((j === 0 && n) || (j === 2 && s)) continue
      let i0 = -1
      for (let i = 0; i <= 3; i++) {
        const keep =
          i < 3 &&
          !((i === 0 && w) || (i === 2 && e)) &&
          !(i !== 1 && j !== 1 && notch(i - 1, j - 1))
        if (keep && i0 < 0) i0 = i
        if (!keep && i0 >= 0) {
          under(xs[i0], zs[j], xs[i], zs[j + 1])
          i0 = -1
        }
      }
    }
  }
  for (let z = 0; z < CHUNK; z++) {
    let start = -1
    for (let x = 0; x <= CHUNK; x++) {
      const plain = x < CHUNK && !has(x, z) && !touchesHole(x, z)
      if (plain && start < 0) start = x
      if (!plain && start >= 0) {
        under(start * CELL, z * CELL, x * CELL, (z + 1) * CELL)
        start = -1
      }
      if (x < CHUNK && !plain && !has(x, z)) cutCell(x, z)
    }
  }

  // Nosing profile: inset into the solid side and height above the
  // underside, from tangent to the underside (j = 0) to tangent to the
  // skirt (j = NOSING_SEGMENTS).
  const profile = []
  for (let j = 0; j <= NOSING_SEGMENTS; j++) {
    const t = (j / NOSING_SEGMENTS) * (Math.PI / 2)
    profile.push({ inset: r * (1 - Math.sin(t)), y: y0 + r * (1 - Math.cos(t)), sin: Math.sin(t), cos: Math.cos(t) })
  }
  // End treatment where the boundary meets the next cell along it: +1 draw
  // back (the solid turns a convex corner), -1 run on (a notch), 0 straight.
  const endMode = (sx, sz, hx, hz) => (has(sx, sz) ? 1 : has(hx, hz) ? 0 : -1)

  for (let z = 0; z < CHUNK; z++) {
    for (let x = 0; x < CHUNK; x++) {
      if (!has(x, z)) continue
      // [inward x, inward z] points from the hole into the solid neighbour.
      for (const [ix, iz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        if (has(x + ix, z + iz)) continue
        const tx = iz === 0 ? 0 : 1 // along unit: z for x-facing sides, x otherwise
        const tz = 1 - tx
        const line = ix ? (x + (ix > 0 ? 1 : 0)) * CELL : (z + (iz > 0 ? 1 : 0)) * CELL
        const e0 = (tx ? x : z) * CELL
        const e1 = e0 + CELL
        const m0 = endMode(x + ix - tx, z + iz - tz, x - tx, z - tz)
        const m1 = endMode(x + ix + tx, z + iz + tz, x + tx, z + tz)
        const at = (along, inset, y) =>
          tx ? [along, y, line + iz * inset] : [line + ix * inset, y, along]
        const uvAt = (along, y) => [along / CELL, y / CELL]
        for (let j = 0; j < NOSING_SEGMENTS; j++) {
          const p = profile[j]
          const q = profile[j + 1]
          const a0p = e0 + m0 * p.inset
          const a1p = e1 - m1 * p.inset
          const a0q = e0 + m0 * q.inset
          const a1q = e1 - m1 * q.inset
          const np = [-ix * p.sin, -p.cos, -iz * p.sin]
          const nq = [-ix * q.sin, -q.cos, -iz * q.sin]
          pushSmoothQuad(
            pos, nrm, uv,
            [at(a0p, p.inset, p.y), at(a1p, p.inset, p.y), at(a1q, q.inset, q.y), at(a0q, q.inset, q.y)],
            [np, np, nq, nq],
            [uvAt(a0p, p.y), uvAt(a1p, p.y), uvAt(a1q, q.y), uvAt(a0q, q.y)]
          )
        }
        const skirt = [-ix, 0, -iz]
        const ys = y0 + r
        pushSmoothQuad(
          pos, nrm, uv,
          [at(e0, 0, ys), at(e1, 0, ys), at(e1, 0, y1), at(e0, 0, y1)],
          [skirt, skirt, skirt, skirt],
          [uvAt(e0, ys), uvAt(e1, ys), uvAt(e1, y1), uvAt(e0, y1)]
        )
      }
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  return geo
}

function collectHoles(data, ceiling) {
  const holes = new Set()
  for (let z = 0; z < CHUNK; z++) {
    for (let x = 0; x < CHUNK; x++) {
      if (ceiling ? data.hasCeilHole(x, z) : data.hasFloorHole(x, z)) {
        holes.add(`${x},${z}`)
      }
    }
  }
  return holes
}

// A tall void can continue through an owned chunk seam. Chunk-local hole sets
// alone would treat the neighbour as solid and erect a false vertical fascia
// across the shaft/bridge. The canonical slab slice has enough global geometry
// to answer the one-cell halo queried by buildCeilingSlab without generating the
// neighbouring chunk.
function multilevelHoleOutsideChunk(data, lx, lz) {
  const room = data.structureUp
  if (!room?.hasRoom) return false
  const gx = data.cx * CHUNK + lx
  const gz = data.cz * CHUNK + lz
  // Catalog volumes (v26) carry per-storey void shapes (terraces, courts):
  // answer from the canonical descriptor, not the footprint rectangle.
  if (isCatalogKind(room.kind)) return catalogVoidAt(data.structure, room.levelCy, gx, gz)
  const bounds = room.globalBounds
  if (
    gx < bounds.x0 || gx > bounds.x1 ||
    gz < bounds.z0 || gz > bounds.z1
  ) return false
  if (room.globalBridgeLine === null) return true
  return room.bridgeAxis === 'x'
    ? gz !== room.globalBridgeLine
    : gx !== room.globalBridgeLine
}

export function buildChunkMeshes(data, geom, materials, ox, oy, oz, models = null) {
  const group = new THREE.Group()
  group.position.set(ox, oy, oz)

  // Floor + ceiling. The shared full-chunk planes cover the common (no-hole)
  // case with zero per-chunk geometry; stair chunks build hole-punched merged
  // row-span quads (<= ~16 quads) that this chunk owns and must dispose.
  const ownedGeos = []
  let floor
  const floorHoles = collectHoles(data, false)
  if (floorHoles.size === 0) {
    floor = new THREE.Mesh(geom.floor, materials.carpet)
    floor.position.set(CHUNK_WORLD / 2, 0, CHUNK_WORLD / 2)
  } else {
    const g = buildFloorFace(floorHoles)
    ownedGeos.push(g)
    floor = new THREE.Mesh(g, materials.carpet)
  }
  group.add(floor)

  let ceil
  const ceilingHoles = collectHoles(data, true)
  if (ceilingHoles.size === 0) {
    ceil = new THREE.Mesh(geom.ceiling, materials.ceiling)
    ceil.position.set(CHUNK_WORLD / 2, WALL_H, CHUNK_WORLD / 2)
  } else {
    // The slab owner renders only real global solid/void boundaries.
    const g = buildCeilingSlab(ceilingHoles, (x, z) => multilevelHoleOutsideChunk(data, x, z))
    ownedGeos.push(g)
    ceil = new THREE.Mesh(g, materials.ceiling)
  }
  group.add(ceil)

  // --- Wall shell + columns + stair flight + beams: one wallpaper batch ---
  // The shell (objects/wallShell.js) turns the edge bytes into merged runs,
  // window/rail pieces with joints and corner posts, so bevelled walls read
  // as continuous planes with rounded corners and ends. Rail caps come back
  // with it (trim batch); window joinery stays per window edge.
  const shell = collectWallShell(data)
  const inst = shell.walls // [{px,py,pz, sx,sy,sz}]
  const featureFrameInst = shell.caps
  for (const axis of ['v', 'h']) {
    for (let line = 0; line < CHUNK; line++) {
      for (let cell = 0; cell < CHUNK; cell++) {
        const i = axis === 'v' ? vIdx(line, cell) : hIdx(cell, line)
        const wall = axis === 'v' ? data.wallV[i] : data.wallH[i]
        const feature = axis === 'v' ? data.wallFeatureV[i] : data.wallFeatureH[i]
        if (wall !== 1 || feature !== WALL_WINDOW) continue
        // Casings, stool and glazing from the shared joinery builder, with a
        // deterministic per-window tone selecting cross / single-bar /
        // venetian-blind glazing.
        const gx = data.cx * CHUNK + (axis === 'v' ? line : cell)
        const gz = data.cz * CHUNK + (axis === 'v' ? cell : line)
        pushWindowTrim(featureFrameInst, axis, line, cell, hash2i(WINDOW_SALT, gx, gz) / 4294967296)
      }
    }
  }
  const wallY = WALL_H / 2
  // Freestanding columns at cell centres. Furniture cells are built separately
  // from their records (precise pieces, not full-height shafts).
  for (let z = 0; z < CHUNK; z++) {
    for (let x = 0; x < CHUNK; x++) {
      const kind = data.cols[cIdx(x, z)]
      if (!kind || kind === COLUMN_FURNITURE) continue
      const half = kind === COLUMN_MONUMENTAL ? MONUMENTAL_COL_HALF : COL_HALF
      inst.push({
        px: (x + 0.5) * CELL,
        py: wallY,
        pz: (z + 0.5) * CELL,
        sx: half * 2,
        sy: WALL_H,
        sz: half * 2,
      })
    }
  }
  // Stair flight (up-stair only — the lower chunk owns the whole flight).
  // STAIR_STEPS treads over the two run cells; collision is the analytic
  // ramp (player/ground.js), these are render detail. Step i is a block
  // standing on the floor from its nosing to the head of the flight: the
  // union is the stepped solid, every riser/tread joint is a concave corner
  // on a flat face, and only the nosings meet the air — so the fully
  // bevelled stair cube rounds exactly those into bullnoses (the floor
  // contact and the top tread, flush with the next storey, stay square).
  // The top step sits flush with the upper floor at LAYER_H.
  const stepInst = []
  if (data.stairUp) {
    const s = data.stairUp
    const horiz = s.dir === STAIR_E || s.dir === STAIR_W
    const sign = s.dir === STAIR_E || s.dir === STAIR_S ? 1 : -1
    const tread = (2 * CELL) / STAIR_STEPS
    const rise = LAYER_H / STAIR_STEPS
    // Ramp-start edge (landing -> run0), in chunk-local world units.
    const start = horiz
      ? Math.max(s.landing.lx, s.run[0].lx) * CELL
      : Math.max(s.landing.lz, s.run[0].lz) * CELL
    const head = start + sign * STAIR_STEPS * tread
    const cross = horiz ? (s.landing.lz + 0.5) * CELL : (s.landing.lx + 0.5) * CELL
    for (let i = 0; i < STAIR_STEPS; i++) {
      const nosing = start + sign * i * tread
      const along = (nosing + head) / 2
      const len = Math.abs(head - nosing)
      const h = (i + 1) * rise
      stepInst.push({
        px: horiz ? along : cross,
        py: h / 2,
        pz: horiz ? cross : along,
        sx: horiz ? len : CELL,
        sy: h,
        sz: horiz ? CELL : len,
      })
    }
  }

  // Two longitudinal drop beams make the long one-cell bridge read as a
  // supported structural span, not a paper-thin strip floating over the hall.
  // They belong to the lower/slab-owner chunk and sit below the retained bridge
  // underside, well above player head height.
  // Lattice slices carry bridgeCells but no bridgeAxis/bridgeLine; without the
  // guard the beam math below degenerates to NaN instance transforms that
  // poison the shared wall batch's bounding sphere.
  // Lattice decks carry per-edge bridgeSegments instead of one bridge line:
  // give every deck cell a pair of under-slung beams so the catwalk reads as
  // a supported steel span. The arterial spine gets visibly heavier steel
  // than minor bridges — the route hierarchy made legible. (Collinear cell
  // beams merge into one member below.)
  if (data.structureUp?.bridgeSegments?.length) {
    const chunkGx = data.cx * CHUNK
    const chunkGz = data.cz * CHUNK
    for (const segment of data.structureUp.bridgeSegments) {
      if (segment.orientation !== 'horizontal') continue
      const depth = segment.role === 'spine' ? BRIDGE_BEAM_H * 1.5 : BRIDGE_BEAM_H
      const cellSet = new Set(segment.cells.map((c) => `${c.gx},${c.gz}`))
      for (const cell of segment.cells) {
        const lx = cell.gx - chunkGx
        const lz = cell.gz - chunkGz
        if (lx < 0 || lx >= CHUNK || lz < 0 || lz >= CHUNK) continue
        const alongX = cellSet.has(`${cell.gx - 1},${cell.gz}`) ||
          cellSet.has(`${cell.gx + 1},${cell.gz}`)
        const cxw = (lx + 0.5) * CELL
        const czw = (lz + 0.5) * CELL
        const beamOffset = CELL / 2 - BRIDGE_BEAM_W
        for (const side of [-1, 1]) {
          inst.push({
            px: alongX ? cxw : cxw + side * beamOffset,
            py: WALL_H - depth / 2,
            pz: alongX ? czw + side * beamOffset : czw,
            sx: alongX ? CELL : BRIDGE_BEAM_W,
            sy: depth,
            sz: alongX ? BRIDGE_BEAM_W : CELL,
          })
        }
      }
    }
  }

  if (
    data.structureUp?.bridgeCells.length &&
    (data.structureUp.bridgeAxis === 'x' || data.structureUp.bridgeAxis === 'z') &&
    Number.isInteger(data.structureUp.bridgeLine)
  ) {
    const room = data.structureUp
    const { x0, z0, x1, z1 } = room.bounds
    const alongX = room.bridgeAxis === 'x'
    const alongCenter = alongX
      ? ((x0 + x1 + 1) / 2) * CELL
      : ((z0 + z1 + 1) / 2) * CELL
    const alongLength = (alongX ? x1 - x0 + 1 : z1 - z0 + 1) * CELL
    const crossCenter = (room.bridgeLine + 0.5) * CELL
    const beamOffset = CELL / 2 - BRIDGE_BEAM_W
    for (const side of [-1, 1]) {
      inst.push({
        px: alongX ? alongCenter : crossCenter + side * beamOffset,
        py: WALL_H - BRIDGE_BEAM_H / 2,
        pz: alongX ? crossCenter + side * beamOffset : alongCenter,
        sx: alongX ? alongLength : BRIDGE_BEAM_W,
        sy: BRIDGE_BEAM_H,
        sz: alongX ? BRIDGE_BEAM_W : alongLength,
      })
    }
  }

  // Collinear boxes of one cross-section (run + post, cell beams, stools of
  // neighbouring windows, wainscot bands) become single members: no seam for
  // a bevel to round, and fewer instances.
  const walls = boxBatch(geom.wallUnit, materials.wallpaper, mergeCollinearBoxes(inst))
  if (walls) group.add(walls)
  const stairs = boxBatch(geom.stairUnit, materials.wallpaper, stepInst)
  if (stairs) group.add(stairs)

  // --- Decorative door frames + dressed open leaves (from explicit passage metadata) ---
  // Purely visual: a plinth-and-cap casing around every single-cell doorway,
  // plus a panelled door PAIR swung flat against the flanking walls on a
  // deterministic subset — one leaf per wall face, so the doorway reads as a
  // door from both rooms. All built by trimwork.js into unit-box descriptors,
  // so it adds no geometry primitive and never blocks the opening
  // (collision/LOS read the edge bytes). Leaves carry the doorway's `tone`
  // seed for per-door tinting.
  const frameInst = featureFrameInst // {px,py,pz, sx,sy,sz}
  const leafInst = [] // same, plus role (0 paint / 1 knob) + tone
  for (const d of collectDoorways(data, DOOR_LEAF_FRACTION)) {
    pushDoorFrame(frameInst, d.axis, d.line, d.cell)
    if (d.leaf) {
      const at = leafInst.length
      pushDoorLeaves(leafInst, d)
      for (let i = at; i < leafInst.length; i++) leafInst[i].tone = d.tone
    }
  }

  // --- Interior dressing (props.js): the "designed building" layer ---
  // Trim (baseboards, crowns, column bases/caps) shares the frame batch and
  // its uniform trim paint; tinted props and emissive wayfinding signs get
  // their own instanced batches with per-instance colours. All purely visual
  // and collision-free by construction (see props.js header). Every detail
  // batch draws the all-edges bevelled cube.
  const dressing = collectInteriorDressing(data)
  for (const t of dressing.trim) frameInst.push(t)

  const frames = boxBatch(geom.detailUnit, materials.doorFrame, mergeCollinearBoxes(frameInst))
  if (frames) group.add(frames)
  const leaves = boxBatch(geom.detailUnit, materials.doorLeaf, leafInst, leafTint)
  if (leaves) group.add(leaves)
  const props = boxBatch(geom.detailUnit, materials.prop, mergeCollinearBoxes(dressing.props), partTint)
  if (props) group.add(props)
  const signs = boxBatch(geom.detailUnit, materials.signGlow, dressing.signs, partTint)
  if (signs) group.add(signs)

  // --- Furniture (collision-real pieces from ChunkData.furniture) ---
  // buildFurniturePart picks the render path: instanced Blender GLBs once the
  // model library is loaded, else the procedural unit-box builders. Either way
  // these are the ONLY props the collision raster knows about: their cells
  // carry COLUMN_FURNITURE and the player sweeps the precise piece AABBs.
  const furniture = buildFurniturePart(data, geom, materials, models)
  if (furniture) group.add(furniture)

  // --- Fluorescent ceiling panels (lit feed the light pool; dead are dark) ---
  // Each lit panel's emissive is tinted by its fixture identity (lampCharacter):
  // the same colour-temperature drift the cast light gets, and a browned-dim
  // face for bad tubes — so what the tube LOOKS like never argues with the
  // pool it throws.
  const lamps = [] // world Vector3 of LIT lamps, tagged with the layer index
  const lit = data.lamps.filter((l) => l.lit)
  const dead = data.lamps.filter((l) => !l.lit)
  _s.set(1, 1, 1)

  let panels = null
  if (lit.length) {
    panels = new THREE.InstancedMesh(geom.panel, materials.panel, lit.length)
    lit.forEach((l, i) => {
      _p.set((l.lx + 0.5) * CELL, WALL_H - 0.02, (l.lz + 0.5) * CELL)
      _m.compose(_p, _q, _s)
      panels.setMatrixAt(i, _m)
      // Light-point hangs lower than the recessed panel mesh so the lamp sits
      // clearly IN the room: ceiling tiles around it now catch real N·L and the
      // light shafts/shadows originate in-room (not coplanar with the ceiling).
      const wx = ox + (l.lx + 0.5) * CELL
      const wz = oz + (l.lz + 0.5) * CELL
      const role = data.spaceRole[cIdx(l.lx, l.lz)]
      const v = new THREE.Vector3(wx, oy + WALL_H - 0.5, wz)
      v.cy = data.cy // floor tag for the cross-floor light filter
      v.role = role // room-role tag: the cast pool matches the tube's register
      lamps.push(v)
      lampPanelTint(wx, wz, data.cy, _tint3, role)
      panels.setColorAt(i, _c.setRGB(_tint3[0], _tint3[1], _tint3[2]))
    })
    panels.instanceMatrix.needsUpdate = true
    panels.instanceColor.needsUpdate = true
    panels.computeBoundingSphere()
    group.add(panels)
  }

  let deadPanels = null
  if (dead.length) {
    deadPanels = new THREE.InstancedMesh(geom.panel, materials.panelDead, dead.length)
    dead.forEach((l, i) => {
      _p.set((l.lx + 0.5) * CELL, WALL_H - 0.02, (l.lz + 0.5) * CELL)
      _m.compose(_p, _q, _s)
      deadPanels.setMatrixAt(i, _m)
    })
    deadPanels.instanceMatrix.needsUpdate = true
    deadPanels.computeBoundingSphere()
    group.add(deadPanels)
  }

  // --- Exit anomaly ---
  let exit = null
  let exitWorld = null
  if (data.exit) {
    exit = new THREE.Mesh(geom.exit, materials.exit)
    exit.position.set((data.exit.lx + 0.5) * CELL, 1.35, (data.exit.lz + 0.5) * CELL)
    group.add(exit)
    exitWorld = new THREE.Vector3(
      ox + (data.exit.lx + 0.5) * CELL,
      oy + 1.35,
      oz + (data.exit.lz + 0.5) * CELL
    )
  }

  const dispose = () => {
    walls?.dispose()
    stairs?.dispose()
    frames?.dispose()
    leaves?.dispose()
    props?.dispose()
    signs?.dispose()
    disposeFurniturePart(furniture)
    panels?.dispose()
    deadPanels?.dispose()
    for (const g of ownedGeos) g.dispose()
    group.parent?.remove(group)
  }

  // Stable semantic references let Chunk lower render detail without relying
  // on child order or material identity. The shell and emissive/gameplay cues
  // are intentionally separate from decorative and silhouette batches.
  const parts = Object.freeze({
    floor,
    ceiling: ceil,
    walls,
    stairs,
    frames,
    leaves,
    props,
    signs,
    furniture,
    litPanels: panels,
    deadPanels,
    exit,
  })

  return { group, parts, lamps, exitWorld, dispose }
}
