import * as THREE from 'three'
import {
  CELL,
  CHUNK,
  CHUNK_WORLD,
  WALL_H,
  LAYER_H,
  STAIR_STEPS,
  THICK,
  COL_HALF,
  MONUMENTAL_COL_HALF,
  FRAME_DEPTH,
  DOOR_LEAF_FRACTION,
  DOOR_DARK_CHANCE,
  DOOR_DARK_TINT,
  DOOR_TINT_VAR,
  WINDOW_SILL_H,
  WINDOW_HEAD_Y,
  WINDOW_SALT,
  BRIDGE_GUARD_H,
  BRIDGE_GUARD_CAP_H,
  BRIDGE_BEAM_H,
  BRIDGE_BEAM_W,
  vIdx,
  hIdx,
  cIdx,
} from './constants.js'
import { collectDoorways } from './doors.js'
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
import {
  COLUMN_FURNITURE,
  COLUMN_MONUMENTAL,
  WALL_PLAIN,
  WALL_RAIL,
  WALL_WINDOW,
} from './mapTypes.js'

const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _p = new THREE.Vector3()
const _s = new THREE.Vector3()
const _c = new THREE.Color()
const _tint3 = [0, 0, 0]

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

// Build the THREE meshes for one chunk from its ChunkData (thin-wall model).
// Returns { group, lamps, exitWorld, dispose }. Geometry/materials are shared
// (created once); only per-chunk InstancedMesh GPU buffers — and, for stair
// chunks, the hole-punched slab geometries — are owned here.
//
// Walls are emitted as one instanced unit-box per cell-edge (each <= CELL long,
// so wallpaper texel density matches a full cell), plus columns and stair
// steps — all in a single InstancedMesh / draw call. A chunk OWNS its West
// (lx=0) and North (lz=0) border lines and all interior lines; the East/South
// borders are drawn by the neighbours as their line 0, so every shared wall is
// drawn exactly once. Vertically (v8) a chunk owns its floor top face and its
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

// Hole-punched horizontal slab face: row-span merged quads over the cell grid
// skipping `holes` ("lx,lz" strings), at local height y, facing up or down.
// UVs are 1 per cell, matching scaleUV(plane, CHUNK) on the shared geometry.
function buildSlabFace(holes, y, faceUp) {
  const pos = []
  const nrm = []
  const uv = []
  const emit = (x0, z, x1) => {
    const ax = x0 * CELL
    const bx = (x1 + 1) * CELL
    const az = z * CELL
    const bz = (z + 1) * CELL
    const A = [ax, y, az]
    const B = [bx, y, az]
    const C = [bx, y, bz]
    const D = [ax, y, bz]
    const uA = [x0, z]
    const uB = [x1 + 1, z]
    const uC = [x1 + 1, z + 1]
    const uD = [x0, z + 1]
    if (faceUp) pushQuad(pos, nrm, uv, A, D, C, B, uA, uD, uC, uB, 0, 1, 0)
    else pushQuad(pos, nrm, uv, A, B, C, D, uA, uB, uC, uD, 0, -1, 0)
  }
  for (let z = 0; z < CHUNK; z++) {
    let start = -1
    for (let x = 0; x <= CHUNK; x++) {
      const solid = x < CHUNK && !holes.has(`${x},${z}`)
      if (solid && start < 0) start = x
      if (!solid && start >= 0) {
        emit(start, z, x - 1)
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

// Inward-facing skirts around arbitrary ceiling-hole masks, spanning the slab
// thickness (local y WALL_H..LAYER_H). Emitting each solid/void boundary edge
// independently supports irregular masks and the two lobes split by a retained
// bridge deck; the old bounding-rectangle rim incorrectly sealed such shapes.
function appendHoleRims(geo, holes, outsideHole = null) {
  const pos = Array.from(geo.attributes.position.array)
  const nrm = Array.from(geo.attributes.normal.array)
  const uv = Array.from(geo.attributes.uv.array)
  const y0 = WALL_H
  const y1 = LAYER_H
  const v = (u, y) => [u / CELL, y / CELL]
  const has = (x, z) => {
    if (x >= 0 && x < CHUNK && z >= 0 && z < CHUNK) {
      return holes.has(`${x},${z}`)
    }
    return outsideHole ? outsideHole(x, z) : false
  }
  for (let z = 0; z < CHUNK; z++) {
    for (let x = 0; x < CHUNK; x++) {
      if (!has(x, z)) continue
      const wx0 = x * CELL
      const wx1 = (x + 1) * CELL
      const wz0 = z * CELL
      const wz1 = (z + 1) * CELL
      // West face (+x into the hole), East (-x), North (+z), South (-z).
      if (!has(x - 1, z)) {
        pushQuad(pos, nrm, uv, [wx0, y0, wz1], [wx0, y0, wz0], [wx0, y1, wz0], [wx0, y1, wz1], v(wz1, y0), v(wz0, y0), v(wz0, y1), v(wz1, y1), 1, 0, 0)
      }
      if (!has(x + 1, z)) {
        pushQuad(pos, nrm, uv, [wx1, y0, wz0], [wx1, y0, wz1], [wx1, y1, wz1], [wx1, y1, wz0], v(wz0, y0), v(wz1, y0), v(wz1, y1), v(wz0, y1), -1, 0, 0)
      }
      if (!has(x, z - 1)) {
        pushQuad(pos, nrm, uv, [wx0, y0, wz0], [wx1, y0, wz0], [wx1, y1, wz0], [wx0, y1, wz0], v(wx0, y0), v(wx1, y0), v(wx1, y1), v(wx0, y1), 0, 0, 1)
      }
      if (!has(x, z + 1)) {
        pushQuad(pos, nrm, uv, [wx1, y0, wz1], [wx0, y0, wz1], [wx0, y1, wz1], [wx1, y1, wz1], v(wx1, y0), v(wx0, y0), v(wx0, y1), v(wx1, y1), 0, 0, -1)
      }
    }
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
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
// to answer the one-cell halo queried by appendHoleRims without generating the
// neighbouring chunk.
function multilevelHoleOutsideChunk(data, lx, lz) {
  const room = data.structureUp
  if (!room?.hasRoom) return false
  const gx = data.cx * CHUNK + lx
  const gz = data.cz * CHUNK + lz
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

export function buildChunkMeshes(data, geom, materials, ox, oy, oz) {
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
    const g = buildSlabFace(floorHoles, 0, true)
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
    const g = buildSlabFace(ceilingHoles, WALL_H, false)
    appendHoleRims(
      g,
      ceilingHoles,
      (x, z) => multilevelHoleOutsideChunk(data, x, z)
    ) // slab-owner renders only real global solid/void boundaries
    ownedGeos.push(g)
    ceil = new THREE.Mesh(g, materials.ceiling)
  }
  group.add(ceil)

  // --- Collect wall + column + stair-step instance transforms ---
  const inst = [] // [{px,py,pz, sx,sy,sz}]
  const featureFrameInst = []
  const wallY = WALL_H / 2
  const addFeatureWall = (axis, line, cell, feature) => {
    const vertical = axis === 'v'
    const px = vertical ? line * CELL : (cell + 0.5) * CELL
    const pz = vertical ? (cell + 0.5) * CELL : line * CELL
    const sx = vertical ? THICK : CELL
    const sz = vertical ? CELL : THICK
    if (feature === WALL_WINDOW) {
      // Collision-solid sill + header (wallpaper); the joinery (casings, stool,
      // glazing) comes from the shared objects/joinery builder, with a
      // deterministic per-window tone selecting cross / single-bar /
      // venetian-blind glazing.
      inst.push({ px, py: WINDOW_SILL_H / 2, pz, sx, sy: WINDOW_SILL_H, sz })
      inst.push({
        px,
        py: (WINDOW_HEAD_Y + WALL_H) / 2,
        pz,
        sx,
        sy: WALL_H - WINDOW_HEAD_Y,
        sz,
      })
      const gx = data.cx * CHUNK + (vertical ? line : cell)
      const gz = data.cz * CHUNK + (vertical ? cell : line)
      pushWindowTrim(featureFrameInst, axis, line, cell, hash2i(WINDOW_SALT, gx, gz) / 4294967296)
      return
    }
    if (feature === WALL_RAIL) {
      inst.push({ px, py: BRIDGE_GUARD_H / 2, pz, sx, sy: BRIDGE_GUARD_H, sz })
      featureFrameInst.push({
        px,
        py: BRIDGE_GUARD_H,
        pz,
        sx: vertical ? FRAME_DEPTH : CELL,
        sy: BRIDGE_GUARD_CAP_H,
        sz: vertical ? CELL : FRAME_DEPTH,
      })
      return
    }
    inst.push({ px, py: wallY, pz, sx, sy: WALL_H, sz })
  }
  // Vertical wall lines (lx in [0..CHUNK-1]): slab at world x = lx*CELL,
  // spanning the depth of cell row z.
  for (let z = 0; z < CHUNK; z++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      if (data.wallV[vIdx(lx, z)] !== 1) continue
      addFeatureWall('v', lx, z, data.wallFeatureV[vIdx(lx, z)] ?? WALL_PLAIN)
    }
  }
  // Horizontal wall lines (lz in [0..CHUNK-1]): slab at world z = lz*CELL,
  // spanning the width of cell column x.
  for (let lz = 0; lz < CHUNK; lz++) {
    for (let x = 0; x < CHUNK; x++) {
      if (data.wallH[hIdx(x, lz)] !== 1) continue
      addFeatureWall('h', lz, x, data.wallFeatureH[hIdx(x, lz)] ?? WALL_PLAIN)
    }
  }
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
  // Stair steps (up-stair only — the lower chunk owns the whole flight).
  // STAIR_STEPS solid risers over the two run cells; collision is the analytic
  // ramp (player/ground.js), these are render detail. The top step's top face
  // sits flush with the upper layer's floor at LAYER_H.
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
    const cross = horiz ? (s.landing.lz + 0.5) * CELL : (s.landing.lx + 0.5) * CELL
    for (let i = 0; i < STAIR_STEPS; i++) {
      const along = start + sign * (i + 0.5) * tread
      const h = (i + 1) * rise
      inst.push({
        px: horiz ? along : cross,
        py: h / 2,
        pz: horiz ? cross : along,
        sx: horiz ? tread : CELL,
        sy: h,
        sz: horiz ? CELL : tread,
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
  // than minor bridges — the route hierarchy made legible.
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

  let walls = null
  if (inst.length) {
    walls = new THREE.InstancedMesh(geom.wallUnit, materials.wallpaper, inst.length)
    for (let i = 0; i < inst.length; i++) {
      const it = inst[i]
      _p.set(it.px, it.py, it.pz)
      _s.set(it.sx, it.sy, it.sz)
      _m.compose(_p, _q, _s)
      walls.setMatrixAt(i, _m)
    }
    walls.instanceMatrix.needsUpdate = true
    walls.computeBoundingSphere() // else the whole batch frustum-culls wrongly
    group.add(walls)
  }

  // --- Decorative door frames + dressed open leaves (from explicit passage metadata) ---
  // Purely visual: a plinth-and-cap casing around every single-cell doorway,
  // plus a panelled door PAIR swung flat against the flanking walls on a
  // deterministic subset — one leaf per wall face, so the doorway reads as a
  // door from both rooms. All built by trimwork.js into unit-box descriptors,
  // so it adds no geometry primitive and never blocks the opening
  // (collision/LOS read the edge bytes). Leaves carry the doorway's `tone`
  // seed for per-door tinting.
  const frameInst = featureFrameInst.slice() // {px,py,pz, sx,sy,sz}
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
  // and collision-free by construction (see props.js header).
  const dressing = collectInteriorDressing(data)
  for (const t of dressing.trim) frameInst.push(t)

  let frames = null
  if (frameInst.length) {
    frames = new THREE.InstancedMesh(geom.wallUnit, materials.doorFrame, frameInst.length)
    for (let i = 0; i < frameInst.length; i++) {
      const it = frameInst[i]
      _p.set(it.px, it.py, it.pz)
      _s.set(it.sx, it.sy, it.sz)
      _m.compose(_p, _q, _s)
      frames.setMatrixAt(i, _m)
    }
    frames.instanceMatrix.needsUpdate = true
    frames.computeBoundingSphere()
    group.add(frames)
  }

  let leaves = null
  if (leafInst.length) {
    leaves = new THREE.InstancedMesh(geom.wallUnit, materials.doorLeaf, leafInst.length)
    for (let i = 0; i < leafInst.length; i++) {
      const it = leafInst[i]
      _p.set(it.px, it.py, it.pz)
      _s.set(it.sx, it.sy, it.sz)
      _m.compose(_p, _q, _s)
      leaves.setMatrixAt(i, _m)
      leaves.setColorAt(i, leafTint(it, _c))
    }
    leaves.instanceMatrix.needsUpdate = true
    leaves.instanceColor.needsUpdate = true
    leaves.computeBoundingSphere()
    group.add(leaves)
  }

  let props = null
  if (dressing.props.length) {
    props = new THREE.InstancedMesh(geom.wallUnit, materials.prop, dressing.props.length)
    for (let i = 0; i < dressing.props.length; i++) {
      const it = dressing.props[i]
      _p.set(it.px, it.py, it.pz)
      _s.set(it.sx, it.sy, it.sz)
      _m.compose(_p, _q, _s)
      props.setMatrixAt(i, _m)
      props.setColorAt(i, _c.setRGB(it.tint[0], it.tint[1], it.tint[2]))
    }
    props.instanceMatrix.needsUpdate = true
    props.instanceColor.needsUpdate = true
    props.computeBoundingSphere()
    group.add(props)
  }

  let signs = null
  if (dressing.signs.length) {
    signs = new THREE.InstancedMesh(geom.wallUnit, materials.signGlow, dressing.signs.length)
    for (let i = 0; i < dressing.signs.length; i++) {
      const it = dressing.signs[i]
      _p.set(it.px, it.py, it.pz)
      _s.set(it.sx, it.sy, it.sz)
      _m.compose(_p, _q, _s)
      signs.setMatrixAt(i, _m)
      signs.setColorAt(i, _c.setRGB(it.tint[0], it.tint[1], it.tint[2]))
    }
    signs.instanceMatrix.needsUpdate = true
    signs.instanceColor.needsUpdate = true
    signs.computeBoundingSphere()
    group.add(signs)
  }

  // --- Furniture (collision-real pieces from ChunkData.furniture) ---
  // Multi-part models (objects/furniture/) batched into one instanced draw
  // with per-part tints. These are the ONLY props the collision raster knows
  // about: their cells carry COLUMN_FURNITURE and the player sweeps the
  // precise piece AABBs.
  let furniture = null
  if (data.furniture.length) {
    const parts = []
    for (const f of data.furniture) pushFurnitureModel(parts, f)
    if (parts.length) {
      furniture = new THREE.InstancedMesh(geom.wallUnit, materials.furniture, parts.length)
      for (let i = 0; i < parts.length; i++) {
        const it = parts[i]
        _p.set(it.px, it.py, it.pz)
        _s.set(it.sx, it.sy, it.sz)
        _m.compose(_p, _q, _s)
        furniture.setMatrixAt(i, _m)
        furniture.setColorAt(i, _c.setRGB(it.tint[0], it.tint[1], it.tint[2]))
      }
      furniture.instanceMatrix.needsUpdate = true
      furniture.instanceColor.needsUpdate = true
      furniture.computeBoundingSphere()
      group.add(furniture)
    }
  }

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
    frames?.dispose()
    leaves?.dispose()
    props?.dispose()
    signs?.dispose()
    furniture?.dispose()
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
