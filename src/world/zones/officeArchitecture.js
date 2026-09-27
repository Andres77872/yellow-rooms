import { CELL_CORRIDOR, CELL_LOBBY } from '../mapTypes.js'
import { hash3i } from '../core/hash.js'

// Small, empty architectural landmarks inside the room fabric. These are
// circulation reservations, before room partitioning: walls follow their
// silhouettes, furniture cannot occupy them, and chunk seams simply slice the
// same district plan. The much larger pillar courts/vertical atria remain rare.
const KINDS = ['emptyBullpen', 'doglegGallery', 'waitingLoop']
const SALT = 0x4c494d

function footprint(kind, width, height) {
  const cells = []
  for (let z = 0; z < height; z++) {
    for (let x = 0; x < width; x++) {
      const included = kind === 'emptyBullpen' ||
        (kind === 'doglegGallery' && (z < 3 || x >= width - 3)) ||
        (kind === 'waitingLoop' && (x < 2 || z < 2 || x >= width - 2 || z >= height - 2))
      if (included) cells.push({ x, z })
    }
  }
  return cells
}

// Multi-source flood over active cells. Stop on existing circulation and carve
// only the shortest connector; never tunnel through an inactive landmark zone.
function connect(plan, corridor, cells) {
  if (cells.some(i => corridor[i])) return true
  const previous = new Int32Array(plan.active.length).fill(-2)
  const queue = new Int32Array(plan.active.length)
  let tail = 0
  for (const i of cells) {
    previous[i] = -1
    queue[tail++] = i
  }
  for (let head = 0; head < tail; head++) {
    const i = queue[head]
    if (corridor[i]) {
      for (let p = previous[i]; p >= 0; p = previous[p]) {
        if (!corridor[p]) corridor[p] = CELL_CORRIDOR
      }
      return true
    }
    const x = i % plan.size
    const z = Math.floor(i / plan.size)
    for (const [nx, nz] of [[x - 1, z], [x + 1, z], [x, z - 1], [x, z + 1]]) {
      if (nx < 0 || nz < 0 || nx >= plan.size || nz >= plan.size) continue
      const next = nz * plan.size + nx
      if (!plan.active[next] || previous[next] !== -2) continue
      previous[next] = i
      queue[tail++] = next
    }
  }
  return false
}

export function reserveOfficeArchitecture(plan, corridor, seed) {
  const roll = hash3i(seed ^ SALT, plan.dx, plan.dz, 0)
  const kind = KINDS[roll % KINDS.length]
  const axis = (roll & 8) ? 'z' : 'x'
  const long = 9 + ((roll >>> 4) % 3)
  const short = kind === 'waitingLoop' ? 9 : 6 + ((roll >>> 8) & 1)
  const width = axis === 'x' ? long : short
  const height = axis === 'x' ? short : long
  const localCells = footprint(kind, long, short).map(({ x, z }) =>
    axis === 'x' ? { x, z } : { x: z, z: x })
  const protectedCells = new Set([
    ...(plan.stairLobbies || []).flatMap(lobby => lobby.cells),
    ...(plan.multilevelLobbies || []).flatMap(lobby => lobby.cells),
  ])
  const sites = []
  // Check the bounding box too: the office island inside a loop must be real
  // room fabric, never an existing shaft, stair, or inactive/open-zone pocket.
  for (let z = 2; z <= plan.size - height - 2; z++) {
    for (let x = 2; x <= plan.size - width - 2; x++) {
      let valid = true
      for (let dz = -1; dz <= height && valid; dz++) {
        for (let dx = -1; dx <= width; dx++) {
          const i = (z + dz) * plan.size + x + dx
          const insideLoop = kind === 'waitingLoop' && dx >= 2 &&
            dz >= 2 && dx < width - 2 && dz < height - 2
          if (!plan.active[i] || protectedCells.has(i) || (insideLoop && corridor[i])) {
            valid = false
            break
          }
        }
      }
      if (valid) sites.push({ x, z, rank: hash3i(roll, x, z, 1) })
    }
  }
  sites.sort((a, b) => a.rank - b.rank || a.z - b.z || a.x - b.x)
  for (const { x, z } of sites) {
    const cells = localCells.map(cell => (z + cell.z) * plan.size + x + cell.x)
    if (!connect(plan, corridor, cells)) continue
    for (const i of cells) corridor[i] = CELL_LOBBY
    const bounds = { x0: x, z0: z, x1: x + width - 1, z1: z + height - 1 }
    const coreBounds = kind === 'waitingLoop'
      ? { x0: x + 2, z0: z + 2, x1: x + width - 3, z1: z + height - 3 }
      : null
    return [{ kind, axis, bounds, coreBounds, cells }]
  }
  // A heavily reserved district may have no honest site. Do not shrink the
  // landmark into a meaningless slot or overwrite a canonical vertical route.
  return []
}
