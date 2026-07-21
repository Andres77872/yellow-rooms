import { CHUNK, FURN_MARGIN, fmod, ZONE_OFFICE } from '../constants.js'
import { hash2i, hash3i } from '../core/hash.js'
import {
  CELL_ROOM,
  PASSAGE_DOOR,
  PASSAGE_WIDE,
  SPACE_ROLE_NONE,
} from '../mapTypes.js'
import { roomCatalogFor } from './catalog.js'

// Room-role election (v23) — the planner half of the room catalog. Runs on
// the finished office district plan AFTER circulation, doors, and every lobby
// promotion settle, so a role can never go stale on a space that later
// becomes circulation. Still a pure function of (seed, district, space ids).
//
// Election is composition-budgeted per district: a deterministic shuffle of
// the final rooms draws from the selected map family's catalog
// (rooms/catalog.js) — its role quotas and its size-banded election windows —
// instead of independent per-room lotteries, so a district reads as ONE
// coherent floor of that family's institution. Every candidate room must
// prove it can host its role's anchor furniture (roomFurnishMetrics mirrors
// the furnishing layer's candidate contract), so the architectural read
// (wainscot band, lighting register) is always backed by the furniture.
//
// Quotas are targets, not ceilings: after the windowed walk, a backstop pass
// re-walks the still-ordinary rooms in the same shuffle order and fills any
// open quota from the room's band entries (same order, same wallFree proof,
// only the dice gate dropped). A district therefore reaches its full named
// mix whenever its geometry can host it — the windows only decide WHICH rooms
// volunteer first, never whether the floor ends up missing its copy room.

const SALT_ROLES = 0x5a11

const idx = (size, x, z) => z * size + x

// Anchor-hosting capacity per room space, mirroring the furnishing layer's
// candidate contract (rooms/furnish.js): margin-safe room cells with no
// doorway on any edge are placeable; wall-backed placeable cells can host a
// wall-hugging anchor piece. Furnishing runs per chunk slice, so capacity is
// measured per slice and the best slice speaks for the room: `free` is that
// slice's placeable count, `wallFree` its wall-backed count (only slices with
// >= 3 placeable cells count, matching the furnishing minimum). Room-grid
// lamp fixtures are a pure function of (seed, global cell) — the same stream
// placeLights reads — so the cells the lamp pass will claim are excluded
// exactly rather than estimated.
export function roomFurnishMetrics(plan, seed, config) {
  const lamps = config.lamps
  const lampStep = lamps.step
  const lampPhase = lamps.phase?.[ZONE_OFFICE] ?? 0
  const lampChance = lamps.chance?.[ZONE_OFFICE] ?? 0.7
  const lampSalt = lamps.salt
  const holdsLamp = (gx, gz) =>
    fmod(gx - lampPhase, lampStep) === 0 &&
    fmod(gz - lampPhase, lampStep) === 0 &&
    hash2i((seed ^ lampSalt) | 0, gx, gz) / 4294967296 < lampChance
  // The stair/structure stamps may open a reserved halo's entire perimeter as
  // wide mouths, turning bordering room cells into approach cells after the
  // plan is frozen — treat every cell touching a reserved lobby as unusable.
  const lobbyAdj = new Set()
  const reserve = (cell) => {
    const x = cell % plan.size
    const z = Math.floor(cell / plan.size)
    lobbyAdj.add(cell)
    if (x > 0) lobbyAdj.add(cell - 1)
    if (x < plan.size - 1) lobbyAdj.add(cell + 1)
    if (z > 0) lobbyAdj.add(cell - plan.size)
    if (z < plan.size - 1) lobbyAdj.add(cell + plan.size)
  }
  for (const lobby of plan.stairLobbies) for (const cell of lobby.cells) reserve(cell)
  for (const lobby of plan.multilevelLobbies) for (const cell of lobby.cells) reserve(cell)
  const slices = new Map() // spaceId -> Map(chunkKey -> {free, wallFree})
  for (let z = 0; z < plan.size; z++) {
    for (let x = 0; x < plan.size; x++) {
      const i = idx(plan.size, x, z)
      if (!plan.active[i] || plan.cellKind[i] !== CELL_ROOM) continue
      const lx = x % CHUNK
      const lz = z % CHUNK
      if (lx < FURN_MARGIN || lx >= CHUNK - FURN_MARGIN) continue
      if (lz < FURN_MARGIN || lz >= CHUNK - FURN_MARGIN) continue
      if (lobbyAdj.has(i)) continue
      if (holdsLamp(plan.dx * plan.size + x, plan.dz * plan.size + z)) continue
      // Margin-safe cells never sit on a district border, so x+1/z+1 lines
      // stay inside the plan's edge rasters.
      const edges = [
        { wall: plan.vAt(x, z), passage: plan.passageVAt(x, z) },
        { wall: plan.vAt(x + 1, z), passage: plan.passageVAt(x + 1, z) },
        { wall: plan.hAt(x, z), passage: plan.passageHAt(x, z) },
        { wall: plan.hAt(x, z + 1), passage: plan.passageHAt(x, z + 1) },
      ]
      if (edges.some((e) => e.passage === PASSAGE_DOOR || e.passage === PASSAGE_WIDE)) continue
      const id = plan.spaceId[i]
      let perChunk = slices.get(id)
      if (!perChunk) slices.set(id, (perChunk = new Map()))
      const chunkKey = Math.floor(x / CHUNK) * 64 + Math.floor(z / CHUNK)
      let slice = perChunk.get(chunkKey)
      if (!slice) perChunk.set(chunkKey, (slice = { free: 0, wallFree: 0 }))
      slice.free++
      if (edges.some((e) => e.wall === 1)) slice.wallFree++
    }
  }
  const metrics = new Map()
  for (const [id, perChunk] of slices) {
    let free = 0
    let wallFree = 0
    for (const slice of perChunk.values()) {
      if (slice.free < 3) continue // furnishing skips slices under 3 candidates
      free = Math.max(free, slice.free)
      wallFree = Math.max(wallFree, slice.wallFree)
    }
    metrics.set(id, { free, wallFree })
  }
  return metrics
}

// Size bands gate which election table a room draws from. Thresholds mirror
// the furnishing minimums: `free` counts the cells an anchor can actually
// occupy in the room's best slice.
function electionBand(space, m) {
  const w = space.x1 - space.x0 + 1
  const h = space.z1 - space.z0 + 1
  if (space.area >= 20 && w >= 4 && h >= 4 && m.free >= 5) return 'large'
  if (space.area >= 10 && m.free >= 3) return 'mid'
  if (m.free >= 3 && m.wallFree >= 1) return 'small'
  return null
}

export function assignSpaceRoles(plan, seed, config) {
  plan.roleGrid.fill(SPACE_ROLE_NONE)
  for (const space of plan.spaces) space.role = SPACE_ROLE_NONE
  const catalog = roomCatalogFor(config)
  const metrics = roomFurnishMetrics(plan, seed, config)
  const rooms = plan.spaces.filter((space) => space.type === 'room')
  const shuffleKey = (space) =>
    hash3i((seed ^ SALT_ROLES) | 0, plan.dx, plan.dz, (space.localId << 1) | 1)
  const order = [...rooms].sort((a, b) => shuffleKey(a) - shuffleKey(b) || a.localId - b.localId)
  const quota = { ...catalog.quotas }
  const take = (space, m, band, windowed) => {
    const r = hash3i((seed ^ SALT_ROLES) | 0, plan.dx, plan.dz, space.localId) / 4294967296
    for (const entry of catalog.election[band]) {
      if (windowed && r >= entry.window) continue
      if (!(quota[entry.role] > 0)) continue
      if (m.wallFree < entry.wallFree) continue
      space.role = entry.role
      quota[entry.role]--
      return true
    }
    return false
  }
  const eligible = []
  for (const space of order) {
    const m = metrics.get(space.id) ?? { free: 0, wallFree: 0 }
    const band = electionBand(space, m)
    if (!band) continue
    if (!take(space, m, band, true)) eligible.push({ space, m, band })
  }
  // Backstop: quotas are a composition target. Rooms that rolled past every
  // window (or lost a race to an exhausted quota) get a second, dice-free
  // walk — the first open quota their band can host lands. Quotas left open
  // after this pass are genuinely geometry-gated, not unlucky.
  for (const { space, m, band } of eligible) {
    if (!Object.values(quota).some((q) => q > 0)) break
    take(space, m, band, false)
  }
  for (const space of rooms) {
    if (space.role === SPACE_ROLE_NONE) continue
    for (let z = space.z0; z <= space.z1; z++) {
      for (let x = space.x0; x <= space.x1; x++) {
        const i = idx(plan.size, x, z)
        if (plan.spaceId[i] === space.id) plan.roleGrid[i] = space.role
      }
    }
  }
}
