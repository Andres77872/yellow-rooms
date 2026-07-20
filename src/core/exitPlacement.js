import { CELL, CHUNK, CHUNK_WORLD, layerY } from '../world/constants.js'
import { RNG } from '../world/core/rng.js'
import { chunkMultilevelRooms } from '../world/structures/multilevel.js'
import { chunkStairs, stairStrip } from '../world/structures/slab.js'

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
  const cz = Math.round(Math.sin(ang) * dist)
  if (Math.abs(cx) < 2 && Math.abs(cz) < 2) cx += 5
  let lx = r.int(3, CHUNK - 4)
  let lz = r.int(3, CHUNK - 4)
  const cy = r.pick(EXIT_FLOORS)

  // Keep the clearing away from both stair strips touching the objective floor.
  // A multilevel room can also remove the upper floor beneath a candidate, so
  // reject its canonical void cells before stamping the anomaly.
  const { up, down } = chunkStairs(worldSeed, cx, cz, cy, config)
  const strips = []
  if (up.hasStair) strips.push(...stairStrip(up))
  if (down.hasStair) strips.push(...stairStrip(down))
  const room = chunkMultilevelRooms(worldSeed, cx, cz, cy, config).down
  const voids = new Set(
    room.hasRoom ? room.voidCells.map((cell) => `${cell.lx},${cell.lz}`) : []
  )
  const clearOf = (x, z, margin) =>
    !voids.has(`${x},${z}`) &&
    strips.every((cell) => Math.max(Math.abs(cell.lx - x), Math.abs(cell.lz - z)) > margin)

  // Margin 2 is preferred; margin 1 is guaranteed to leave a legal interior
  // cell even when this layer owns both an up- and a down-stair.
  const span = CHUNK - 6
  search: for (const margin of [2, 1]) {
    const start = (lz - 3) * span + (lx - 3)
    for (let i = 0; i < span * span; i++) {
      const j = (start + i) % (span * span)
      const x = 3 + (j % span)
      const z = 3 + ((j / span) | 0)
      if (clearOf(x, z, margin)) {
        lx = x
        lz = z
        break search
      }
    }
  }

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
