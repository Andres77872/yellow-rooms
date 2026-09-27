import { CELL, CHUNK, CHUNK_WORLD, layerY } from '../world/constants.js'
import { RNG } from '../world/core/rng.js'
import { generateChunk } from '../world/generate.js'
import { stairStrip } from '../world/structures/slab.js'

export const EXIT_FLOORS = Object.freeze([-5, -4, -3, -2, -1, 1, 2, 3, 4, 5])
export const EXIT_REACH = 1.8

const EXIT_Y = 1.35
const norm = (a) => Math.atan2(Math.sin(a), Math.cos(a))

// Deterministic per seed + level: shared seeds keep identical objectives while
// every objective requires at least one floor transition from the floor-0 spawn.
export function createExitPlacement(seedText, level, worldSeed, config) {
  const r = RNG.fromString(`${seedText}#${level}#exit`)

  // Preserve the established horizontal placement sequence. The floor draw
  // deliberately happens after these values so existing seeds keep their XZ.
  const dist = r.int(6, 11)
  const ang = r.next() * Math.PI * 2
  let cx = Math.round(Math.cos(ang) * dist)
  let cz = Math.round(Math.sin(ang) * dist)
  if (Math.abs(cx) < 2 && Math.abs(cz) < 2) cx += 5
  let lx = r.int(3, CHUNK - 4)
  let lz = r.int(3, CHUNK - 4)
  const cy = r.pick(EXIT_FLOORS)

  // Query the actual family raster once per candidate host. Generic office
  // slab contracts omit forced sewer risers and family-owned tower/lattice
  // stairs; generic multilevel rooms likewise cannot describe their voids.
  const host = generateChunk(worldSeed, cx, cy, cz, config)
  const findCell = (data) => {
    const strips = [data.stairUp, data.stairDown].filter(Boolean).flatMap(stairStrip)
    const clearOf = (x, z, margin) =>
      !data.hasFloorHole(x, z) && data.colAt(x, z) === 0 &&
      strips.every((cell) => Math.max(Math.abs(cell.lx - x), Math.abs(cell.lz - z)) > margin)
    // Retain the seeded interior search first. Sparse catwalks may only offer
    // a narrow platform near a chunk edge, so relax the window and guard
    // clearance in a fixed order while always staying off the stair itself.
    for (const [inset, margin] of [[3, 2], [3, 1], [1, 1], [1, 0], [0, 0]]) {
      const span = CHUNK - inset * 2
      const start = (lz - inset) * span + lx - inset
      for (let i = 0; i < span * span; i++) {
        const j = (start + i) % (span * span)
        const x = inset + (j % span)
        const z = inset + ((j / span) | 0)
        if (clearOf(x, z, margin)) return { lx: x, lz: z }
      }
    }
    return null
  }

  let cell = findCell(host)
  if (!cell) {
    // Some elevated lattice slices are entirely void. Their immutable
    // structure already identifies a finite connected platform network;
    // choose its nearest viable participant on the SAME objective floor.
    const participants = (host.structure?.participants ?? [])
      .filter((p) => p.cx !== cx || p.cz !== cz)
      .sort((a, b) =>
        Math.abs(a.cx - cx) + Math.abs(a.cz - cz) -
        Math.abs(b.cx - cx) - Math.abs(b.cz - cz) || a.cz - b.cz || a.cx - b.cx)
    for (const participant of participants) {
      cell = findCell(generateChunk(worldSeed, participant.cx, cy, participant.cz, config))
      if (cell) {
        cx = participant.cx
        cz = participant.cz
        break
      }
    }
  }
  if (!cell) throw new Error('Unable to place exit on a safe family floor')
  lx = cell.lx
  lz = cell.lz

  return {
    cx,
    cy,
    cz,
    lx,
    lz,
    x: cx * CHUNK_WORLD + (lx + 0.5) * CELL,
    y: layerY(cy) + EXIT_Y,
    z: cz * CHUNK_WORLD + (lz + 0.5) * CELL,
  }
}

export function evaluateExit(target, exitFloor, controller) {
  const p = controller.pos
  const dx = target.x - p.x
  const dz = target.z - p.z
  const dist = Math.hypot(dx, dz)
  const fAng = Math.atan2(-Math.sin(controller.yaw), -Math.cos(controller.yaw))
  const eAng = Math.atan2(dx, dz)
  const floorDelta = exitFloor - controller.floor
  return {
    info: { dist, relAngle: norm(eAng - fAng), floorDelta },
    reached: dist < EXIT_REACH && floorDelta === 0,
  }
}
