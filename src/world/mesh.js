import * as THREE from 'three'
import {
  CELL,
  CHUNK,
  CHUNK_WORLD,
  WALL_H,
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

const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _p = new THREE.Vector3()
const _s = new THREE.Vector3()

// Build the THREE meshes for one chunk from its ChunkData (thin-wall model).
// Returns { group, lamps, exitWorld, dispose }. Geometry/materials are shared
// (created once); only per-chunk InstancedMesh GPU buffers are owned here.
//
// Walls are emitted as one instanced unit-box per cell-edge (each <= CELL long,
// so wallpaper texel density matches a full cell), plus columns — all in a
// single InstancedMesh / draw call. A chunk OWNS its West (lx=0) and North
// (lz=0) border lines and all interior lines; the East/South borders are drawn
// by the neighbours as their line 0, so every shared wall is drawn exactly once.
export function buildChunkMeshes(data, geom, materials, ox, oz) {
  const group = new THREE.Group()
  group.position.set(ox, 0, oz)

  // Floor + ceiling (shared geometry, repositioned).
  const floor = new THREE.Mesh(geom.floor, materials.carpet)
  floor.position.set(CHUNK_WORLD / 2, 0, CHUNK_WORLD / 2)
  group.add(floor)
  const ceil = new THREE.Mesh(geom.ceiling, materials.ceiling)
  ceil.position.set(CHUNK_WORLD / 2, WALL_H, CHUNK_WORLD / 2)
  group.add(ceil)

  // --- Collect wall + column instance transforms ---
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
  const lamps = [] // world Vector3 of LIT lamps
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
      lamps.push(new THREE.Vector3(ox + (l.lx + 0.5) * CELL, WALL_H - 0.5, oz + (l.lz + 0.5) * CELL))
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
      1.35,
      oz + (data.exit.lz + 0.5) * CELL
    )
  }

  const dispose = () => {
    walls?.dispose()
    frames?.dispose()
    leaves?.dispose()
    panels?.dispose()
    deadPanels?.dispose()
    group.parent?.remove(group)
  }

  return { group, lamps, exitWorld, dispose }
}
