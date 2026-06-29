import { CHUNK, ZONE_OFFICE } from '../constants.js'
import { fillInterior, bsp, clearInterior, carveBorderThresholds, carveOfficeCorridors } from './ZoneGenerator.js'

export const id = ZONE_OFFICE

// BSP rooms-and-corridors with thin walls. Rooms tile the chunk; a spanning tree
// over the room-adjacency graph carves exactly one doorway per tree edge
// (guaranteeing all rooms connect — invariant I1); braiding opens a fraction of
// the remaining shared walls for loops (the "wander" feel). Border doorways were
// written into the owned border lines by the orchestrator.
export function generate(data, ctx) {
  const { rng, config, borders } = ctx
  const cfg = config.office

  fillInterior(data)
  const rooms = bsp(rng, 0, 0, CHUNK - 1, CHUNK - 1, cfg.roomMin, cfg.roomMax)
  for (const r of rooms) clearInterior(data, r)

  // cell -> room index
  const roomOf = new Int16Array(CHUNK * CHUNK).fill(-1)
  rooms.forEach((r, ri) => {
    for (let z = r.z0; z <= r.z1; z++) {
      for (let x = r.x0; x <= r.x1; x++) roomOf[z * CHUNK + x] = ri
    }
  })

  // Collect candidate doorways grouped by the pair of rooms they connect.
  const edges = new Map() // "a,b" (a<b) -> [{v?:lx,z} | {h?:x,lz}]
  const add = (a, b, cand) => {
    const key = a < b ? `${a},${b}` : `${b},${a}`
    let list = edges.get(key)
    if (!list) edges.set(key, (list = []))
    list.push(cand)
  }
  for (let z = 0; z < CHUNK; z++) {
    for (let lx = 1; lx < CHUNK; lx++) {
      const a = roomOf[z * CHUNK + (lx - 1)]
      const b = roomOf[z * CHUNK + lx]
      if (a !== b && a >= 0 && b >= 0) add(a, b, { v: lx, z })
    }
  }
  for (let x = 0; x < CHUNK; x++) {
    for (let lz = 1; lz < CHUNK; lz++) {
      const a = roomOf[(lz - 1) * CHUNK + x]
      const b = roomOf[lz * CHUNK + x]
      if (a !== b && a >= 0 && b >= 0) add(a, b, { h: x, lz })
    }
  }

  // Spanning tree over rooms (union-find), edges visited in random order.
  const parent = rooms.map((_, i) => i)
  const find = (a) => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]]
      a = parent[a]
    }
    return a
  }
  const carve = (cand) => {
    if (cand.v !== undefined) data.setV(cand.v, cand.z, 0)
    else data.setH(cand.h, cand.lz, 0)
  }

  const keys = rng.shuffle([...edges.keys()])
  const nonTree = []
  for (const key of keys) {
    const [a, b] = key.split(',').map(Number)
    const cands = edges.get(key)
    if (find(a) !== find(b)) {
      parent[find(a)] = find(b)
      carve(rng.pick(cands)) // tree doorway
    } else {
      nonTree.push(cands)
    }
  }
  // Braid: extra doorways through some non-tree shared walls -> loops.
  for (const cands of nonTree) {
    if (rng.chance(cfg.braid)) carve(rng.pick(cands))
  }

  // Carve the global corridor skeleton after BSP room doors. This keeps the
  // local room variation while ensuring the main routes continue across chunks.
  carveOfficeCorridors(data, ctx.seed, ctx.cx, ctx.cz, config)

  // Clean threshold behind every border opening so doorways/mouths lead into the
  // rooms (and wide transition mouths read as one lobby), not into a wall corner.
  // Monotone (opens edges only) -> the single-component invariant (I1) holds.
  carveBorderThresholds(data, borders)
}
