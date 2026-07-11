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
  HEADER_H,
  FRAME_W,
  FRAME_DEPTH,
  DOOR_LEAF_THICK,
  DOOR_LEAF_FRACTION,
  vIdx,
  hIdx,
  cIdx,
} from './constants.js'
import { collectDoorways } from './doors.js'
import { STAIR_E, STAIR_S, STAIR_W } from './slab.js'

const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _p = new THREE.Vector3()
const _s = new THREE.Vector3()

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

// Inward-facing skirt around a rectangular ceiling hole, spanning the slab
// thickness (local y WALL_H..LAYER_H) — so looking at the hole edge from the
// stairwell shows a solid slab, never a paper-thin plane.
function appendHoleRim(geo, holeCells) {
  const pos = Array.from(geo.attributes.position.array)
  const nrm = Array.from(geo.attributes.normal.array)
  const uv = Array.from(geo.attributes.uv.array)
  let x0 = CHUNK, z0 = CHUNK, x1 = -1, z1 = -1
  for (const c of holeCells) {
    x0 = Math.min(x0, c.lx)
    z0 = Math.min(z0, c.lz)
    x1 = Math.max(x1, c.lx)
    z1 = Math.max(z1, c.lz)
  }
  const wx0 = x0 * CELL
  const wx1 = (x1 + 1) * CELL
  const wz0 = z0 * CELL
  const wz1 = (z1 + 1) * CELL
  const y0 = WALL_H
  const y1 = LAYER_H
  const v = (u, y) => [u / CELL, y / CELL]
  // West face (+x into the hole), East (-x), North (+z), South (-z).
  pushQuad(pos, nrm, uv, [wx0, y0, wz1], [wx0, y0, wz0], [wx0, y1, wz0], [wx0, y1, wz1], v(wz1, y0), v(wz0, y0), v(wz0, y1), v(wz1, y1), 1, 0, 0)
  pushQuad(pos, nrm, uv, [wx1, y0, wz0], [wx1, y0, wz1], [wx1, y1, wz1], [wx1, y1, wz0], v(wz0, y0), v(wz1, y0), v(wz1, y1), v(wz0, y1), -1, 0, 0)
  pushQuad(pos, nrm, uv, [wx0, y0, wz0], [wx1, y0, wz0], [wx1, y1, wz0], [wx0, y1, wz0], v(wx0, y0), v(wx1, y0), v(wx1, y1), v(wx0, y1), 0, 0, 1)
  pushQuad(pos, nrm, uv, [wx1, y0, wz1], [wx0, y0, wz1], [wx0, y1, wz1], [wx1, y1, wz1], v(wx1, y0), v(wx0, y0), v(wx0, y1), v(wx1, y1), 0, 0, -1)
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
}

export function buildChunkMeshes(data, geom, materials, ox, oy, oz) {
  const group = new THREE.Group()
  group.position.set(ox, oy, oz)

  // Floor + ceiling. The shared full-chunk planes cover the common (no-hole)
  // case with zero per-chunk geometry; stair chunks build hole-punched merged
  // row-span quads (<= ~16 quads) that this chunk owns and must dispose.
  const ownedGeos = []
  let floor
  if (!data.stairDown) {
    floor = new THREE.Mesh(geom.floor, materials.carpet)
    floor.position.set(CHUNK_WORLD / 2, 0, CHUNK_WORLD / 2)
  } else {
    const holes = new Set(data.stairDown.run.map((c) => `${c.lx},${c.lz}`))
    const g = buildSlabFace(holes, 0, true)
    ownedGeos.push(g)
    floor = new THREE.Mesh(g, materials.carpet)
  }
  group.add(floor)

  let ceil
  if (!data.stairUp) {
    ceil = new THREE.Mesh(geom.ceiling, materials.ceiling)
    ceil.position.set(CHUNK_WORLD / 2, WALL_H, CHUNK_WORLD / 2)
  } else {
    const holes = new Set(data.stairUp.run.map((c) => `${c.lx},${c.lz}`))
    const g = buildSlabFace(holes, WALL_H, false)
    appendHoleRim(g, data.stairUp.run) // slab-owner renders the hole's cut faces
    ownedGeos.push(g)
    ceil = new THREE.Mesh(g, materials.ceiling)
  }
  group.add(ceil)

  // --- Collect wall + column + stair-step instance transforms ---
  const inst = [] // [{px,py,pz, sx,sy,sz}]
  const wallY = WALL_H / 2
  // Vertical wall lines (lx in [0..CHUNK-1]): slab at world x = lx*CELL,
  // spanning the depth of cell row z.
  for (let z = 0; z < CHUNK; z++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      if (data.wallV[vIdx(lx, z)] !== 1) continue
      inst.push({
        px: lx * CELL,
        py: wallY,
        pz: (z + 0.5) * CELL,
        sx: THICK,
        sy: WALL_H,
        sz: CELL,
      })
    }
  }
  // Horizontal wall lines (lz in [0..CHUNK-1]): slab at world z = lz*CELL,
  // spanning the width of cell column x.
  for (let lz = 0; lz < CHUNK; lz++) {
    for (let x = 0; x < CHUNK; x++) {
      if (data.wallH[hIdx(x, lz)] !== 1) continue
      inst.push({
        px: (x + 0.5) * CELL,
        py: wallY,
        pz: lz * CELL,
        sx: CELL,
        sy: WALL_H,
        sz: THICK,
      })
    }
  }
  // Freestanding columns at cell centres.
  for (let z = 0; z < CHUNK; z++) {
    for (let x = 0; x < CHUNK; x++) {
      if (data.cols[cIdx(x, z)] !== 1) continue
      inst.push({
        px: (x + 0.5) * CELL,
        py: wallY,
        pz: (z + 0.5) * CELL,
        sx: COL_HALF * 2,
        sy: WALL_H,
        sz: COL_HALF * 2,
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

  // --- Decorative door frames + open leaves (from explicit passage metadata) ---
  // Purely visual: a casing (two jambs + a lintel) around every single-cell
  // doorway, plus an open door leaf laid flat against the wall on a deterministic
  // subset. Reuses the unit box (axis-aligned scales, like the walls), so it adds
  // no geometry primitive and never blocks the opening — collision/LOS, which read
  // the edge bytes, are untouched.
  const DOOR_H = WALL_H - HEADER_H
  const JAMB_OFF = CELL / 2 - FRAME_W / 2 // jamb centre offset from the gap centre
  const leafFaceOff = THICK / 2 + DOOR_LEAF_THICK / 2 // panel sits just off the wall face
  const frameInst = [] // {px,py,pz, sx,sy,sz}
  const leafInst = []
  for (const d of collectDoorways(data, DOOR_LEAF_FRACTION)) {
    if (d.axis === 'v') {
      const x0 = d.line * CELL // wall plane (x)
      const zc = (d.cell + 0.5) * CELL // gap centre along z
      frameInst.push({ px: x0, py: DOOR_H + HEADER_H / 2, pz: zc, sx: FRAME_DEPTH, sy: HEADER_H, sz: CELL })
      frameInst.push({ px: x0, py: DOOR_H / 2, pz: zc - JAMB_OFF, sx: FRAME_DEPTH, sy: DOOR_H, sz: FRAME_W })
      frameInst.push({ px: x0, py: DOOR_H / 2, pz: zc + JAMB_OFF, sx: FRAME_DEPTH, sy: DOOR_H, sz: FRAME_W })
      if (d.leaf) {
        const zl = (d.cell + d.hinge + 0.5) * CELL // flat against the neighbour wall cell
        leafInst.push({ px: x0 + d.face * leafFaceOff, py: DOOR_H / 2, pz: zl, sx: DOOR_LEAF_THICK, sy: DOOR_H, sz: CELL - 2 * FRAME_W })
      }
    } else {
      const z0 = d.line * CELL // wall plane (z)
      const xc = (d.cell + 0.5) * CELL // gap centre along x
      frameInst.push({ px: xc, py: DOOR_H + HEADER_H / 2, pz: z0, sx: CELL, sy: HEADER_H, sz: FRAME_DEPTH })
      frameInst.push({ px: xc - JAMB_OFF, py: DOOR_H / 2, pz: z0, sx: FRAME_W, sy: DOOR_H, sz: FRAME_DEPTH })
      frameInst.push({ px: xc + JAMB_OFF, py: DOOR_H / 2, pz: z0, sx: FRAME_W, sy: DOOR_H, sz: FRAME_DEPTH })
      if (d.leaf) {
        const xl = (d.cell + d.hinge + 0.5) * CELL
        leafInst.push({ px: xl, py: DOOR_H / 2, pz: z0 + d.face * leafFaceOff, sx: CELL - 2 * FRAME_W, sy: DOOR_H, sz: DOOR_LEAF_THICK })
      }
    }
  }

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
    }
    leaves.instanceMatrix.needsUpdate = true
    leaves.computeBoundingSphere()
    group.add(leaves)
  }

  // --- Fluorescent ceiling panels (lit feed the light pool; dead are dark) ---
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
      const v = new THREE.Vector3(ox + (l.lx + 0.5) * CELL, oy + WALL_H - 0.5, oz + (l.lz + 0.5) * CELL)
      v.cy = data.cy // floor tag for the cross-floor light filter
      lamps.push(v)
    })
    panels.instanceMatrix.needsUpdate = true
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
  let exitWorld = null
  if (data.exit) {
    const exit = new THREE.Mesh(geom.exit, materials.exit)
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
    panels?.dispose()
    deadPanels?.dispose()
    for (const g of ownedGeos) g.dispose()
    group.parent?.remove(group)
  }

  return { group, lamps, exitWorld, dispose }
}
