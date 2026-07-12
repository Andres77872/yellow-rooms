import { CHUNK, ZONE_OFFICE } from '../constants.js'
import { hash3i } from '../core/hash.js'
import { RNG } from '../core/rng.js'
import {
  CELL_CORRIDOR,
  CELL_LOBBY,
  CELL_OPEN,
  CELL_ROOM,
  PASSAGE_DOOR,
  PASSAGE_OPEN,
  PASSAGE_WALL,
  PASSAGE_WIDE,
} from '../mapTypes.js'
import { selectZone } from '../regions.js'
import { chunkStairs, stairStrip, STAIR_DX, STAIR_DZ } from '../slab.js'
import { bsp } from './ZoneGenerator.js'

// Office planning happens on a district grid above streaming chunks. Boundary
// portals are derived first, routed into a shared circulation graph, and only
// then is the remaining footprint divided into rooms.

const SALT_PORTALS = 0x25d7
const SALT_CIRCULATION = 0x31c7
const SALT_ROOMS = 0x6a09
const SALT_DOORS = 0x4d23
const SALT_SPACE_ID = 0x72e5
// Sized for v8's stacked floors: up to 3 resident layers, each with its own
// per-layer-seed districts, keep ~2-3x the districts warm vs a single floor.
const CACHE_LIMIT = 64
const PLAN_CACHES = new WeakMap()

const idx = (size, x, z) => z * size + x
const edgeIdx = (size, line, along) => along * size + line
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n))

function officePlanConfig(config) {
  const office = config.office || {}
  const corridors = office.corridors || {}
  const portals = office.portals || {}
  const number = (value, fallback) => Number.isFinite(value) ? value : fallback
  const integer = (value, fallback, minimum) =>
    Math.max(minimum, Math.floor(number(value, fallback)))
  const roomMin = integer(office.roomMin, 3, 2)
  return {
    districtChunks: integer(office.districtChunks, 3, 2),
    candidates: integer(office.planCandidates, 4, 1),
    roomMin,
    roomMax: Math.max(roomMin, integer(office.roomMax, 8, 2)),
    minRoomArea: integer(office.minRoomArea, 6, 2),
    minRoomWidth: integer(office.minRoomWidth, 2, 1),
    maxRoomAspect: Math.max(1, number(office.maxRoomAspect, 3)),
    targetRoomCompactness: clamp(number(office.targetRoomCompactness, 0.5), 0, 1),
    braid: clamp(number(office.braid, 0.2), 0, 1),
    targetCoverage: clamp(number(corridors.targetCoverage, 0.16), 0, 1),
    targetWallFraction: clamp(number(office.targetWallFraction, 0.2), 0, 1),
    hubRadius: integer(corridors.hubRadius, 1, 0),
    maxRoomDepth: integer(corridors.maxRoomDepth, 3, 1),
    maxSeamRatio: Math.max(0.5, number(corridors.maxSeamRatio, 1.25)),
    portalJitter: integer(portals.jitter, 3, 0),
    portalMinSpacing: integer(portals.minSpacing, 5, 2),
    portalSalt: number(portals.salt, SALT_PORTALS) | 0,
  }
}

export function officeDistrictCoords(cx, cz, config) {
  const chunks = officePlanConfig(config).districtChunks
  const dx = Math.floor(cx / chunks)
  const dz = Math.floor(cz / chunks)
  return {
    chunks,
    dx,
    dz,
    localCx: cx - dx * chunks,
    localCz: cz - dz * chunks,
  }
}

export function chunksShareOfficeDistrict(ax, az, bx, bz, config) {
  const a = officeDistrictCoords(ax, az, config)
  const b = officeDistrictCoords(bx, bz, config)
  return a.dx === b.dx && a.dz === b.dz
}

class OfficePlan {
  constructor(size, dx, dz) {
    this.size = size
    this.dx = dx
    this.dz = dz
    this.active = new Uint8Array(size * size)
    this.wallV = new Uint8Array(size * size)
    this.wallH = new Uint8Array(size * size)
    this.passageV = new Uint8Array(size * size).fill(PASSAGE_OPEN)
    this.passageH = new Uint8Array(size * size).fill(PASSAGE_OPEN)
    this.cellKind = new Uint8Array(size * size).fill(CELL_OPEN)
    this.spaceId = new Uint32Array(size * size)
    this.spaces = []
    this.adjacency = []
    this.portals = []
    this.stairLobbies = []
    this.metrics = {}
    this.score = Infinity
  }

  vAt(lineX, z) {
    return this.wallV[edgeIdx(this.size, lineX, z)]
  }
  hAt(x, lineZ) {
    return this.wallH[edgeIdx(this.size, x, lineZ)]
  }
  passageVAt(lineX, z) {
    return this.passageV[edgeIdx(this.size, lineX, z)]
  }
  passageHAt(x, lineZ) {
    return this.passageH[edgeIdx(this.size, x, lineZ)]
  }
  setV(lineX, z, wall, passage = wall ? PASSAGE_WALL : PASSAGE_OPEN) {
    const i = edgeIdx(this.size, lineX, z)
    this.wallV[i] = wall
    this.passageV[i] = passage
  }
  setH(x, lineZ, wall, passage = wall ? PASSAGE_WALL : PASSAGE_OPEN) {
    const i = edgeIdx(this.size, x, lineZ)
    this.wallH[i] = wall
    this.passageH[i] = passage
  }
}

function edgeSegmentZones(axis, dx, dz, segment, config, seed) {
  const n = officePlanConfig(config).districtChunks
  if (axis === 'v') {
    const westCx = (dx + 1) * n - 1
    const eastCx = westCx + 1
    const cz = dz * n + segment
    return [
      selectZone(westCx, cz, seed, config),
      selectZone(eastCx, cz, seed, config),
    ]
  }
  const cx = dx * n + segment
  const northCz = (dz + 1) * n - 1
  const southCz = northCz + 1
  return [
    selectZone(cx, northCz, seed, config),
    selectZone(cx, southCz, seed, config),
  ]
}

function nearestPortalPosition(raw, lo, hi, used, minSpacing) {
  for (let d = 0; d <= hi - lo; d++) {
    for (const sign of d === 0 ? [1] : [-1, 1]) {
      const p = clamp(raw + sign * d, lo, hi)
      const local = ((p % CHUNK) + CHUNK) % CHUNK
      if (local <= 0 || local >= CHUNK - 1) continue
      if (used.some((u) => Math.abs(u - p) < minSpacing)) continue
      return p
    }
  }
  return null
}

// Canonical macro-edge contract. The key is the lower district coordinate:
// vertical = west district, horizontal = north district.
export function buildOfficeDistrictEdgeContract(seed, axis, dx, dz, config) {
  const cfg = officePlanConfig(config)
  const size = cfg.districtChunks * CHUNK
  const walls = new Uint8Array(size).fill(1)
  const passages = new Uint8Array(size).fill(PASSAGE_WALL)
  const valid = []
  for (let segment = 0; segment < cfg.districtChunks; segment++) {
    const [a, b] = edgeSegmentZones(axis, dx, dz, segment, config, seed)
    valid.push(a === ZONE_OFFICE && b === ZONE_OFFICE)
  }

  const portals = []
  const axisSalt = axis === 'v' ? 0x56 : 0x48
  const validSegments = valid.flatMap((isValid, segment) => isValid ? [segment] : [])
  for (let i = 0; i < validSegments.length; i++) {
    const segment = validSegments[i]
    const lo = segment * CHUNK + 1
    const hi = (segment + 1) * CHUNK - 2
    const target = Math.round((lo + hi) * 0.5)
    const jitterHash = hash3i((seed ^ cfg.portalSalt) | 0, dx + segment, dz + i, axisSalt)
    const jitter = (jitterHash % (cfg.portalJitter * 2 + 1)) - cfg.portalJitter
    const p = nearestPortalPosition(
      target + jitter,
      lo,
      hi,
      portals.map((portal) => portal.offset),
      cfg.portalMinSpacing
    )
    if (p === null) continue
    walls[p] = 0
    passages[p] = PASSAGE_DOOR
    portals.push({ offset: p, width: 1, kind: PASSAGE_DOOR })
  }
  return { kind: 'office', axis, dx, dz, walls, passages, portals }
}

function boundaryPortals(seed, dx, dz, config) {
  const size = officePlanConfig(config).districtChunks * CHUNK
  const edges = {
    w: buildOfficeDistrictEdgeContract(seed, 'v', dx - 1, dz, config),
    e: buildOfficeDistrictEdgeContract(seed, 'v', dx, dz, config),
    n: buildOfficeDistrictEdgeContract(seed, 'h', dx, dz - 1, config),
    s: buildOfficeDistrictEdgeContract(seed, 'h', dx, dz, config),
  }
  const out = []
  for (const portal of edges.w.portals) out.push({ side: 'w', x: 0, z: portal.offset })
  for (const portal of edges.e.portals) out.push({ side: 'e', x: size - 1, z: portal.offset })
  for (const portal of edges.n.portals) out.push({ side: 'n', x: portal.offset, z: 0 })
  for (const portal of edges.s.portals) out.push({ side: 's', x: portal.offset, z: size - 1 })
  return out
}

function markActiveChunks(plan, seed, config) {
  const n = officePlanConfig(config).districtChunks
  for (let localCz = 0; localCz < n; localCz++) {
    for (let localCx = 0; localCx < n; localCx++) {
      const cx = plan.dx * n + localCx
      const cz = plan.dz * n + localCz
      if (selectZone(cx, cz, seed, config) !== ZONE_OFFICE) continue
      for (let z = localCz * CHUNK; z < (localCz + 1) * CHUNK; z++) {
        for (let x = localCx * CHUNK; x < (localCx + 1) * CHUNK; x++) {
          plan.active[idx(plan.size, x, z)] = 1
        }
      }
    }
  }
}

function layerContext(seed, context = null) {
  return {
    rootSeed: (context?.rootSeed ?? seed) >>> 0,
    layerSeed: (context?.layerSeed ?? seed) >>> 0,
    cy: Number.isFinite(context?.cy) ? Math.floor(context.cy) : 0,
  }
}

// Reserve both stair halves before circulation and room allocation. The
// physical stamp still owns holes/guard walls later, but the district planner
// now knows that the halo is circulation rather than discovering it as a
// post-slice carve through already-labelled rooms.
function collectStairLobbies(plan, seed, config, context) {
  const ctx = layerContext(seed, context)
  const n = officePlanConfig(config).districtChunks
  const out = []
  for (let localCz = 0; localCz < n; localCz++) {
    for (let localCx = 0; localCx < n; localCx++) {
      const chunkX0 = localCx * CHUNK
      const chunkZ0 = localCz * CHUNK
      if (!plan.active[idx(plan.size, chunkX0, chunkZ0)]) continue
      const cx = plan.dx * n + localCx
      const cz = plan.dz * n + localCz
      const contracts = chunkStairs(ctx.rootSeed, cx, cz, ctx.cy, config)
      for (const kind of ['up', 'down']) {
        const contract = contracts[kind]
        if (!contract.hasStair) continue
        const strip = stairStrip(contract)
        const xs = strip.map((cell) => cell.lx)
        const zs = strip.map((cell) => cell.lz)
        const x0 = Math.max(0, Math.min(...xs) - 1)
        const z0 = Math.max(0, Math.min(...zs) - 1)
        const x1 = Math.min(CHUNK - 1, Math.max(...xs) + 1)
        const z1 = Math.min(CHUNK - 1, Math.max(...zs) + 1)
        const cells = []
        for (let lz = z0; lz <= z1; lz++) {
          for (let lx = x0; lx <= x1; lx++) {
            const x = chunkX0 + lx
            const z = chunkZ0 + lz
            const i = idx(plan.size, x, z)
            if (plan.active[i]) cells.push(i)
          }
        }
        // The lower half enters opposite the ascent direction; the upper half
        // enters through the exit cell beyond the ramp top.
        const mouthLocal = kind === 'up'
          ? {
              lx: contract.landing.lx - STAIR_DX[contract.dir],
              lz: contract.landing.lz - STAIR_DZ[contract.dir],
            }
          : contract.exit
        const mouth = {
          x: chunkX0 + mouthLocal.lx,
          z: chunkZ0 + mouthLocal.lz,
        }
        out.push({
          kind,
          cx,
          cy: ctx.cy,
          cz,
          mouth,
          cells,
          contract: {
            dir: contract.dir,
            landing: { ...contract.landing },
            run: contract.run.map((cell) => ({ ...cell })),
            exit: { ...contract.exit },
          },
        })
      }
    }
  }
  return out
}

function labelMask(mask, size) {
  const labels = new Int16Array(mask.length).fill(-1)
  const cells = []
  const stack = []
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start] !== -1) continue
    const label = cells.length
    const component = []
    labels[start] = label
    stack.push(start)
    while (stack.length) {
      const i = stack.pop()
      component.push(i)
      const x = i % size
      const z = Math.floor(i / size)
      for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nx = x + dx
        const nz = z + dz
        if (nx < 0 || nx >= size || nz < 0 || nz >= size) continue
        const ni = idx(size, nx, nz)
        if (!mask[ni] || labels[ni] !== -1) continue
        labels[ni] = label
        stack.push(ni)
      }
    }
    cells.push(component)
  }
  return { labels, cells }
}

function buildRouteTree(plan, hub, routeSeed) {
  const previous = new Int32Array(plan.active.length).fill(-2)
  const queue = new Int32Array(plan.active.length)
  let head = 0
  let tail = 0
  previous[hub] = -1
  queue[tail++] = hub
  while (head < tail) {
    const i = queue[head++]
    const x = i % plan.size
    const z = Math.floor(i / plan.size)
    const directions = [[-1, 0], [1, 0], [0, -1], [0, 1]]
    const rotation = hash3i(routeSeed, x, z, 1) & 3
    for (let d = 0; d < 4; d++) {
      const [dx, dz] = directions[(d + rotation) & 3]
      const nx = x + dx
      const nz = z + dz
      if (nx < 0 || nx >= plan.size || nz < 0 || nz >= plan.size) continue
      const ni = idx(plan.size, nx, nz)
      if (!plan.active[ni] || previous[ni] !== -2) continue
      previous[ni] = i
      queue[tail++] = ni
    }
  }
  return previous
}

function markRoute(corridor, start, previous) {
  let i = start
  while (i >= 0) {
    if (!corridor[i]) corridor[i] = CELL_CORRIDOR
    i = previous[i]
  }
}

function markOrthogonalRoute(plan, corridor, start, goal, horizontalFirst) {
  let x = start % plan.size
  let z = Math.floor(start / plan.size)
  const gx = goal % plan.size
  const gz = Math.floor(goal / plan.size)
  const path = [start]
  const walkX = () => {
    while (x !== gx) {
      x += Math.sign(gx - x)
      const i = idx(plan.size, x, z)
      if (!plan.active[i]) return false
      path.push(i)
    }
    return true
  }
  const walkZ = () => {
    while (z !== gz) {
      z += Math.sign(gz - z)
      const i = idx(plan.size, x, z)
      if (!plan.active[i]) return false
      path.push(i)
    }
    return true
  }
  const valid = horizontalFirst ? walkX() && walkZ() : walkZ() && walkX()
  if (!valid) return false
  for (const i of path) if (!corridor[i]) corridor[i] = CELL_CORRIDOR
  return true
}

function chooseHub(component, endpoints, size, seed) {
  let sx = 0
  let sz = 0
  const source = endpoints.length ? endpoints : component.map((i) => ({
    x: i % size,
    z: Math.floor(i / size),
  }))
  for (const point of source) {
    sx += point.x
    sz += point.z
  }
  const tx = sx / source.length
  const tz = sz / source.length
  let best = component[0]
  let bestScore = Infinity
  for (const i of component) {
    const x = i % size
    const z = Math.floor(i / size)
    const score = Math.abs(x - tx) + Math.abs(z - tz) +
      (hash3i(seed, x, z, 0) / 4294967296) * 0.01
    if (score < bestScore) {
      best = i
      bestScore = score
    }
  }
  return best
}

function markLobby(corridor, active, size, center, radius) {
  const x0 = center % size
  const z0 = Math.floor(center / size)
  for (let z = z0 - radius; z <= z0 + radius; z++) {
    for (let x = x0 - radius; x <= x0 + radius; x++) {
      if (x < 0 || x >= size || z < 0 || z >= size) continue
      const i = idx(size, x, z)
      if (active[i]) corridor[i] = CELL_LOBBY
    }
  }
}

function planCirculation(plan, seed, config, candidate) {
  const cfg = officePlanConfig(config)
  const components = labelMask(plan.active, plan.size)
  const corridor = new Uint8Array(plan.active.length)
  plan.portals = boundaryPortals(seed, plan.dx, plan.dz, config)
    .filter((portal) => plan.active[idx(plan.size, portal.x, portal.z)])

  const endpointsByComponent = components.cells.map(() => [])
  for (const portal of plan.portals) {
    const i = idx(plan.size, portal.x, portal.z)
    endpointsByComponent[components.labels[i]].push({ ...portal, i, portal: true })
  }
  for (const lobby of plan.stairLobbies) {
    const i = idx(plan.size, lobby.mouth.x, lobby.mouth.z)
    const component = components.labels[i]
    if (component < 0) continue
    endpointsByComponent[component].push({
      x: lobby.mouth.x,
      z: lobby.mouth.z,
      i,
      stair: true,
    })
    for (const cell of lobby.cells) corridor[cell] = CELL_LOBBY
  }

  for (let component = 0; component < components.cells.length; component++) {
    const cells = components.cells[component]
    const endpoints = endpointsByComponent[component]
    const hub = chooseHub(cells, endpoints, plan.size, seed ^ candidate ^ component)
    endpoints.sort((a, b) => {
      const ax = a.x - (hub % plan.size)
      const az = a.z - Math.floor(hub / plan.size)
      const bx = b.x - (hub % plan.size)
      const bz = b.z - Math.floor(hub / plan.size)
      const ad = Math.abs(ax) + Math.abs(az)
      const bd = Math.abs(bx) + Math.abs(bz)
      if (ad !== bd) return bd - ad
      return hash3i(seed ^ candidate, a.x, a.z, component) -
        hash3i(seed ^ candidate, b.x, b.z, component)
    })
    const routeTree = buildRouteTree(
      plan,
      hub,
      (seed ^ SALT_CIRCULATION ^ candidate ^ component) | 0
    )
    for (let e = 0; e < endpoints.length; e++) {
      const endpoint = endpoints[e]
      const horizontalFirst = endpoint.side === 'w' || endpoint.side === 'e'
        ? true
        : endpoint.side === 'n' || endpoint.side === 's'
          ? false
          : (hash3i(seed ^ candidate, endpoint.x, endpoint.z, component) & 1) === 0
      if (!markOrthogonalRoute(plan, corridor, endpoint.i, hub, horizontalFirst)) {
        markRoute(corridor, endpoint.i, routeTree)
      }
      if (endpoints[e].portal) markLobby(corridor, plan.active, plan.size, endpoints[e].i, 0)
    }
    markLobby(corridor, plan.active, plan.size, hub, cfg.hubRadius)

    // Add a secondary branch only for an active chunk the portal/hub routes did
    // not already traverse. This gives every streamed slice circulation without
    // turning all nine chunk centres into an artificial grid of mandatory paths.
    for (let localCz = 0; localCz < cfg.districtChunks; localCz++) {
      for (let localCx = 0; localCx < cfg.districtChunks; localCx++) {
        const x0 = localCx * CHUNK
        const z0 = localCz * CHUNK
        const center = idx(plan.size, x0 + (CHUNK >> 1), z0 + (CHUNK >> 1))
        if (!plan.active[center] || components.labels[center] !== component) continue
        let traversed = false
        for (let z = z0; z < z0 + CHUNK && !traversed; z++) {
          for (let x = x0; x < x0 + CHUNK; x++) {
            if (corridor[idx(plan.size, x, z)]) {
              traversed = true
              break
            }
          }
        }
        if (traversed) continue
        const horizontalFirst =
          (hash3i(seed ^ candidate, localCx, localCz, component) & 1) === 0
        if (!markOrthogonalRoute(plan, corridor, center, hub, horizontalFirst)) {
          markRoute(corridor, center, routeTree)
        }
      }
    }
  }
  return { corridor, components }
}

function buildLeafField(size, rng, cfg) {
  const leaves = bsp(rng, 0, 0, size - 1, size - 1, cfg.roomMin, cfg.roomMax)
  const field = new Int16Array(size * size)
  for (let leaf = 0; leaf < leaves.length; leaf++) {
    const room = leaves[leaf]
    for (let z = room.z0; z <= room.z1; z++) {
      for (let x = room.x0; x <= room.x1; x++) field[idx(size, x, z)] = leaf
    }
  }
  return field
}

function labelRoomFragments(plan, corridor, leafField) {
  const labels = new Int16Array(plan.active.length).fill(-1)
  const rooms = []
  const stack = []
  for (let start = 0; start < plan.active.length; start++) {
    if (!plan.active[start] || corridor[start] || labels[start] !== -1) continue
    const label = rooms.length
    const leaf = leafField[start]
    const cells = []
    labels[start] = label
    stack.push(start)
    while (stack.length) {
      const i = stack.pop()
      cells.push(i)
      const x = i % plan.size
      const z = Math.floor(i / plan.size)
      for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nx = x + dx
        const nz = z + dz
        if (nx < 0 || nx >= plan.size || nz < 0 || nz >= plan.size) continue
        const ni = idx(plan.size, nx, nz)
        if (
          !plan.active[ni] ||
          corridor[ni] ||
          labels[ni] !== -1 ||
          leafField[ni] !== leaf
        ) continue
        labels[ni] = label
        stack.push(ni)
      }
    }
    rooms.push(cells)
  }
  return { labels, rooms }
}

function roomShape(cells, size) {
  let x0 = size
  let z0 = size
  let x1 = -1
  let z1 = -1
  for (const i of cells) {
    const x = i % size
    const z = Math.floor(i / size)
    x0 = Math.min(x0, x)
    z0 = Math.min(z0, z)
    x1 = Math.max(x1, x)
    z1 = Math.max(z1, z)
  }
  const width = x1 >= x0 ? x1 - x0 + 1 : 0
  const height = z1 >= z0 ? z1 - z0 + 1 : 0
  return {
    area: cells.length,
    width,
    height,
    aspect: width && height ? Math.max(width / height, height / width) : Infinity,
    compactness: width && height ? cells.length / (width * height) : 0,
  }
}

function roomConstraintPenalty(shape, cfg) {
  return (
    Math.max(0, cfg.minRoomArea - shape.area) * 4 +
    Math.max(0, cfg.minRoomWidth - Math.min(shape.width, shape.height)) * 8 +
    Math.max(0, shape.aspect - cfg.maxRoomAspect) * 3 +
    Math.max(0, cfg.targetRoomCompactness - shape.compactness) * 6
  )
}

function roomHasUsableWidth(cells, size, width) {
  if (width <= 1) return true
  const wanted = new Set(cells)
  for (const i of cells) {
    const x = i % size
    const z = Math.floor(i / size)
    for (let oz = 1 - width; oz <= 0; oz++) {
      for (let ox = 1 - width; ox <= 0; ox++) {
        const x0 = x + ox
        const z0 = z + oz
        if (x0 < 0 || z0 < 0 || x0 + width > size || z0 + width > size) continue
        let supported = true
        for (let dz = 0; dz < width && supported; dz++) {
          for (let dx = 0; dx < width; dx++) {
            if (!wanted.has(idx(size, x0 + dx, z0 + dz))) {
              supported = false
              break
            }
          }
        }
        if (supported) return true
      }
    }
  }
  return false
}

function roomNeedsMerge(cells, size, cfg) {
  const shape = roomShape(cells, size)
  return shape.area < cfg.minRoomArea ||
    Math.min(shape.width, shape.height) < cfg.minRoomWidth ||
    shape.aspect > cfg.maxRoomAspect
}

function roomIsInvalid(cells, size, cfg) {
  return roomNeedsMerge(cells, size, cfg)
}

function rebuildFragments(labels, find) {
  const rootToRoom = new Map()
  const rooms = []
  const rebuilt = new Int16Array(labels.length).fill(-1)
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] < 0) continue
    const root = find(labels[i])
    let room = rootToRoom.get(root)
    if (room === undefined) {
      room = rooms.length
      rootToRoom.set(root, room)
      rooms.push([])
    }
    rebuilt[i] = room
    rooms[room].push(i)
  }
  return { labels: rebuilt, rooms }
}

function mergeInvalidRoomFragments(plan, corridor, fragments, cfg) {
  const parent = fragments.rooms.map((_, i) => i)
  const find = (a) => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]]
      a = parent[a]
    }
    return a
  }
  const join = (a, b) => {
    a = find(a)
    b = find(b)
    if (a === b) return
    parent[a] = b
  }

  for (let pass = 0; pass < fragments.rooms.length; pass++) {
    let changed = false
    const groups = new Map()
    for (let i = 0; i < fragments.labels.length; i++) {
      if (fragments.labels[i] < 0) continue
      const root = find(fragments.labels[i])
      let cells = groups.get(root)
      if (!cells) groups.set(root, (cells = []))
      cells.push(i)
    }
    for (let room = 0; room < fragments.rooms.length; room++) {
      const root = find(room)
      const cells = groups.get(root)
      if (root !== room || !cells || !roomNeedsMerge(cells, plan.size, cfg)) continue
      const neighbours = new Map()
      for (const i of cells) {
        const x = i % plan.size
        const z = Math.floor(i / plan.size)
        for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const nx = x + dx
          const nz = z + dz
          if (nx < 0 || nx >= plan.size || nz < 0 || nz >= plan.size) continue
          const ni = idx(plan.size, nx, nz)
          if (!plan.active[ni] || corridor[ni] || fragments.labels[ni] < 0) continue
          const other = find(fragments.labels[ni])
          if (other === root) continue
          neighbours.set(other, (neighbours.get(other) || 0) + 1)
        }
      }
      let best = -1
      let bestScore = Infinity
      for (const [other, boundary] of neighbours) {
        const merged = cells.concat(groups.get(other) || [])
        const score = (
          roomConstraintPenalty(roomShape(merged, plan.size), cfg) +
          (roomHasUsableWidth(merged, plan.size, cfg.minRoomWidth) ? 0 : 20)
        ) * 1000 - boundary * 10 - merged.length * 0.01
        if (score < bestScore || (score === bestScore && other < best)) {
          best = other
          bestScore = score
        }
      }
      if (best >= 0) {
        join(root, best)
        changed = true
        // Rebuild root cell sets before scoring another union. This keeps the
        // shape calculation exact after every merge rather than using a stale
        // snapshot from the start of the pass.
        break
      }
    }
    if (!changed) break
  }
  return rebuildFragments(fragments.labels, find)
}

function absorbInvalidRoomsIntoCirculation(plan, corridor, fragments, cfg) {
  const rooms = []
  const labels = new Int16Array(fragments.labels.length).fill(-1)
  const pending = []
  for (const cells of fragments.rooms) {
    if (roomIsInvalid(cells, plan.size, cfg)) {
      pending.push(cells)
      continue
    }
    const room = rooms.length
    rooms.push(cells)
    for (const i of cells) labels[i] = room
  }

  // Absorb clipped slivers in connectivity waves. A fragment can be separated
  // from the original spine by another sliver, so a single array-order pass is
  // insufficient; each wave extends the lobby into the next connected piece.
  while (pending.length) {
    let absorbed = 0
    for (let room = pending.length - 1; room >= 0; room--) {
      const cells = pending[room]
      const touchesCirculation = cells.some((i) => {
        const x = i % plan.size
        const z = Math.floor(i / plan.size)
        return (
          (x > 0 && corridor[i - 1]) ||
          (x < plan.size - 1 && corridor[i + 1]) ||
          (z > 0 && corridor[i - plan.size]) ||
          (z < plan.size - 1 && corridor[i + plan.size])
        )
      })
      if (!touchesCirculation) continue
      for (const i of cells) corridor[i] = CELL_LOBBY
      pending.splice(room, 1)
      absorbed++
    }
    if (!absorbed) throw new Error('invalid office fragments cannot connect to circulation')
  }
  return { labels, rooms }
}

function allocateSpaces(plan, circulation, rng, cfg, seed) {
  const leafField = buildLeafField(plan.size, rng, cfg)
  const fragments = absorbInvalidRoomsIntoCirculation(
    plan,
    circulation.corridor,
    mergeInvalidRoomFragments(
      plan,
      circulation.corridor,
      labelRoomFragments(plan, circulation.corridor, leafField),
      cfg
    ),
    cfg
  )

  const componentCount = circulation.components.cells.length
  const localSpace = new Int16Array(plan.active.length).fill(-1)
  for (let i = 0; i < plan.active.length; i++) {
    if (!plan.active[i]) continue
    if (circulation.corridor[i]) localSpace[i] = circulation.components.labels[i]
  }
  for (let room = 0; room < fragments.rooms.length; room++) {
    const id = componentCount + room
    for (const i of fragments.rooms[room]) localSpace[i] = id
  }

  const totalSpaces = componentCount + fragments.rooms.length
  const stableIds = []
  const usedIds = new Set()
  for (let localId = 0; localId < totalSpaces; localId++) {
    let id = hash3i((seed ^ SALT_SPACE_ID) | 0, plan.dx, plan.dz, localId) || 1
    while (usedIds.has(id)) id = (id + 0x9e3779b9) >>> 0 || 1
    usedIds.add(id)
    stableIds.push(id)
  }
  const stats = Array.from({ length: totalSpaces }, (_, localId) => ({
    id: stableIds[localId],
    localId,
    type: localId < componentCount ? 'corridor' : 'room',
    component: -1,
    area: 0,
    x0: plan.size,
    z0: plan.size,
    x1: -1,
    z1: -1,
    hasUsableWidth: true,
  }))
  for (let z = 0; z < plan.size; z++) {
    for (let x = 0; x < plan.size; x++) {
      const i = idx(plan.size, x, z)
      if (!plan.active[i]) continue
      const localId = localSpace[i]
      plan.cellKind[i] = circulation.corridor[i] || CELL_ROOM
      plan.spaceId[i] = stableIds[localId]
      const s = stats[localId]
      s.component = circulation.components.labels[i]
      s.area++
      s.x0 = Math.min(s.x0, x)
      s.z0 = Math.min(s.z0, z)
      s.x1 = Math.max(s.x1, x)
      s.z1 = Math.max(s.z1, z)
    }
  }
  for (let room = 0; room < fragments.rooms.length; room++) {
    stats[componentCount + room].hasUsableWidth = roomHasUsableWidth(
      fragments.rooms[room],
      plan.size,
      cfg.minRoomWidth
    )
  }
  if (stats.some((space) => space.area === 0)) {
    throw new Error('office plan allocated an empty semantic space')
  }
  plan.spaces = stats
  return localSpace
}

function derivePartitions(plan, localSpace) {
  for (let z = 0; z < plan.size; z++) {
    plan.setV(0, z, 1)
    for (let x = 1; x < plan.size; x++) {
      const a = idx(plan.size, x - 1, z)
      const b = idx(plan.size, x, z)
      const open = plan.active[a] && plan.active[b] && localSpace[a] === localSpace[b]
      plan.setV(x, z, open ? 0 : 1)
    }
  }
  for (let x = 0; x < plan.size; x++) {
    plan.setH(x, 0, 1)
    for (let z = 1; z < plan.size; z++) {
      const a = idx(plan.size, x, z - 1)
      const b = idx(plan.size, x, z)
      const open = plan.active[a] && plan.active[b] && localSpace[a] === localSpace[b]
      plan.setH(x, z, open ? 0 : 1)
    }
  }
}

function pairKey(a, b) {
  return a < b ? String(a) + ',' + String(b) : String(b) + ',' + String(a)
}

function collectAdjacency(plan, localSpace) {
  const grouped = new Map()
  const add = (a, b, candidate) => {
    if (a < 0 || b < 0 || a === b) return
    const key = pairKey(a, b)
    let list = grouped.get(key)
    if (!list) grouped.set(key, (list = []))
    list.push(candidate)
  }
  for (let z = 0; z < plan.size; z++) {
    for (let x = 1; x < plan.size; x++) {
      const a = idx(plan.size, x - 1, z)
      const b = idx(plan.size, x, z)
      if (plan.active[a] && plan.active[b]) {
        add(localSpace[a], localSpace[b], { axis: 'v', line: x, cell: z })
      }
    }
  }
  for (let z = 1; z < plan.size; z++) {
    for (let x = 0; x < plan.size; x++) {
      const a = idx(plan.size, x, z - 1)
      const b = idx(plan.size, x, z)
      if (plan.active[a] && plan.active[b]) {
        add(localSpace[a], localSpace[b], { axis: 'h', line: z, cell: x })
      }
    }
  }
  return grouped
}

function supportingWalls(plan, candidate) {
  const local = ((candidate.cell % CHUNK) + CHUNK) % CHUNK
  if (local === 0 || local === CHUNK - 1) return 0
  if (candidate.axis === 'v') {
    let n = 0
    if (candidate.cell > 0 && plan.vAt(candidate.line, candidate.cell - 1)) n++
    if (candidate.cell < plan.size - 1 && plan.vAt(candidate.line, candidate.cell + 1)) n++
    return n
  }
  let n = 0
  if (candidate.cell > 0 && plan.hAt(candidate.cell - 1, candidate.line)) n++
  if (candidate.cell < plan.size - 1 && plan.hAt(candidate.cell + 1, candidate.line)) n++
  return n
}

function neighbouringPassage(plan, candidate, offset) {
  const cell = candidate.cell + offset
  if (cell < 0 || cell >= plan.size) return PASSAGE_WALL
  return candidate.axis === 'v'
    ? plan.passageVAt(candidate.line, cell)
    : plan.passageHAt(cell, candidate.line)
}

function pickDoor(plan, candidates, rng) {
  let pool = candidates.filter((candidate) => supportingWalls(plan, candidate) === 2)
  if (!pool.length) pool = candidates.filter((candidate) => supportingWalls(plan, candidate) > 0)
  if (!pool.length) pool = candidates
  const isolated = pool.filter((candidate) =>
    neighbouringPassage(plan, candidate, -1) === PASSAGE_WALL &&
    neighbouringPassage(plan, candidate, 1) === PASSAGE_WALL
  )
  if (isolated.length) pool = isolated

  let lo = Infinity
  let hi = -Infinity
  for (const candidate of pool) {
    lo = Math.min(lo, candidate.cell)
    hi = Math.max(hi, candidate.cell)
  }
  const mid = (lo + hi) * 0.5
  const weighted = []
  let total = 0
  for (const candidate of pool) {
    const endDistance = Math.min(candidate.cell - lo, hi - candidate.cell)
    const support = supportingWalls(plan, candidate)
    const weight = 1 + Math.min(3, Math.max(0, endDistance)) * 1.5 + support * 4 +
      1 / (1 + Math.abs(candidate.cell - mid))
    total += weight
    weighted.push([candidate, total])
  }
  const roll = rng.next() * total
  for (const [candidate, ceiling] of weighted) if (roll <= ceiling) return candidate
  return weighted[weighted.length - 1][0]
}

function setCandidatePassage(plan, candidate, passage) {
  if (candidate.axis === 'v') plan.setV(candidate.line, candidate.cell, 0, passage)
  else plan.setH(candidate.cell, candidate.line, 0, passage)
  for (const edge of plan.adjacency) {
    if (
      edge.axis === candidate.axis &&
      edge.line === candidate.line &&
      edge.cell === candidate.cell
    ) edge.kind = passage
  }
}

function carveConnection(plan, a, b, candidate) {
  const support = supportingWalls(plan, candidate)
  const low = neighbouringPassage(plan, candidate, -1)
  const high = neighbouringPassage(plan, candidate, 1)
  let kind = support > 0 ? PASSAGE_DOOR : PASSAGE_WIDE
  if (low === PASSAGE_DOOR || low === PASSAGE_WIDE || high === PASSAGE_DOOR || high === PASSAGE_WIDE) {
    kind = PASSAGE_WIDE
    for (const offset of [-1, 1]) {
      const neighbour = neighbouringPassage(plan, candidate, offset)
      if (neighbour === PASSAGE_DOOR) {
        setCandidatePassage(plan, { ...candidate, cell: candidate.cell + offset }, PASSAGE_WIDE)
      }
    }
  }
  setCandidatePassage(plan, candidate, kind)
  const spaceA = plan.spaces[a]
  const spaceB = plan.spaces[b]
  if (!spaceA || !spaceB) throw new Error('office connection references an unknown space')
  plan.adjacency.push({
    a: spaceA.id,
    b: spaceB.id,
    kind,
    ...candidate,
  })
}

function connectSpaces(plan, localSpace, rng, cfg) {
  const grouped = collectAdjacency(plan, localSpace)
  const graph = Array.from({ length: plan.spaces.length }, () => [])
  for (const key of grouped.keys()) {
    const [a, b] = key.split(',').map(Number)
    graph[a].push({ to: b, key })
    graph[b].push({ to: a, key })
  }
  for (const edges of graph) rng.shuffle(edges)

  const depth = new Int16Array(plan.spaces.length).fill(-1)
  const queue = []
  for (const space of plan.spaces) {
    if (space.type !== 'corridor') continue
    depth[space.localId] = 0
    queue.push(space.localId)
  }
  const tree = new Set()
  while (queue.length) {
    const a = queue.shift()
    for (const edge of graph[a]) {
      if (depth[edge.to] !== -1) continue
      depth[edge.to] = depth[a] + 1
      queue.push(edge.to)
      tree.add(edge.key)
      const [lo, hi] = edge.key.split(',').map(Number)
      carveConnection(plan, lo, hi, pickDoor(plan, grouped.get(edge.key), rng))
    }
  }

  for (const [key, candidates] of grouped) {
    if (tree.has(key) || !rng.chance(cfg.braid)) continue
    const [a, b] = key.split(',').map(Number)
    carveConnection(plan, a, b, pickDoor(plan, candidates, rng))
  }
  return depth
}

function measureSpaceDepth(plan) {
  const byId = new Map(plan.spaces.map((space) => [space.id, space.localId]))
  const graph = Array.from({ length: plan.spaces.length }, () => new Set())
  for (const edge of plan.adjacency) {
    const a = byId.get(edge.a)
    const b = byId.get(edge.b)
    if (a === undefined || b === undefined) {
      throw new Error('office adjacency uses an unknown public space id')
    }
    graph[a].add(b)
    graph[b].add(a)
  }

  const depth = new Int16Array(plan.spaces.length).fill(-1)
  const previous = new Int16Array(plan.spaces.length).fill(-1)
  const queue = []
  for (const space of plan.spaces) {
    if (space.type !== 'corridor') continue
    depth[space.localId] = 0
    queue.push(space.localId)
  }
  while (queue.length) {
    const a = queue.shift()
    for (const b of graph[a]) {
      if (depth[b] !== -1) continue
      depth[b] = depth[a] + 1
      previous[b] = a
      queue.push(b)
    }
  }
  return { depth, previous }
}

function promoteSpacesToLobby(plan, localIds) {
  let promotions = 0
  for (const localId of localIds) {
    const space = plan.spaces[localId]
    if (!space || space.type !== 'room') continue
    space.type = 'corridor'
    for (let i = 0; i < plan.spaceId.length; i++) {
      if (plan.spaceId[i] === space.id) plan.cellKind[i] = CELL_LOBBY
    }
    promotions++
  }

  const byId = new Map(plan.spaces.map((space) => [space.id, space]))
  for (const edge of plan.adjacency) {
    if (byId.get(edge.a)?.type !== 'corridor' || byId.get(edge.b)?.type !== 'corridor') continue
    setCandidatePassage(plan, edge, PASSAGE_WIDE)
  }
  return promotions
}

function repairInvalidRoomShapes(plan, cfg) {
  const invalid = plan.spaces.filter((space) => {
    if (space.type !== 'room') return false
    const width = space.x1 - space.x0 + 1
    const height = space.z1 - space.z0 + 1
    return space.area < cfg.minRoomArea ||
      Math.min(width, height) < cfg.minRoomWidth ||
      Math.max(width / height, height / width) > cfg.maxRoomAspect ||
      !space.hasUsableWidth
  })
  if (!invalid.length) return 0

  const measured = measureSpaceDepth(plan)
  const promote = new Set()
  for (const space of invalid) {
    let current = space.localId
    if (measured.depth[current] < 0) {
      throw new Error('invalid office room is unreachable in the finalized adjacency graph')
    }
    // Promote the shortest room chain back to existing circulation. This turns
    // a geometrically unusable sliver into a connected lobby branch without
    // publishing a disconnected corridor label.
    while (current >= 0 && plan.spaces[current].type === 'room') {
      promote.add(current)
      current = measured.previous[current]
    }
  }
  return promoteSpacesToLobby(plan, promote)
}

function enforceRoomDepth(plan, cfg) {
  let promotions = 0
  while (promotions <= plan.spaces.length) {
    const measured = measureSpaceDepth(plan)
    const promote = new Set()
    for (const space of plan.spaces) {
      if (space.type !== 'room') continue
      if (measured.depth[space.localId] < 0) {
        throw new Error('office room is unreachable in the finalized adjacency graph')
      }
      if (measured.depth[space.localId] <= cfg.maxRoomDepth) continue
      let ancestor = space.localId
      while (measured.depth[ancestor] > 1) ancestor = measured.previous[ancestor]
      if (ancestor >= 0) promote.add(ancestor)
    }
    if (!promote.size) return { depth: measured.depth, promotions }

    const changed = promoteSpacesToLobby(plan, promote)
    promotions += changed
    if (!changed) throw new Error('office room-depth enforcement made no progress')
  }
  throw new Error('office room-depth enforcement did not converge')
}

function labelChunkComponents(plan, x0, z0) {
  const labels = new Int16Array(CHUNK * CHUNK).fill(-1)
  const stack = []
  let count = 0
  for (let z = 0; z < CHUNK; z++) {
    for (let x = 0; x < CHUNK; x++) {
      const start = z * CHUNK + x
      if (labels[start] !== -1) continue
      labels[start] = count
      stack.push([x, z])
      while (stack.length) {
        const [lx, lz] = stack.pop()
        const visit = (nx, nz, wall) => {
          if (wall || nx < 0 || nx >= CHUNK || nz < 0 || nz >= CHUNK) return
          const ni = nz * CHUNK + nx
          if (labels[ni] !== -1) return
          labels[ni] = count
          stack.push([nx, nz])
        }
        visit(lx - 1, lz, plan.vAt(x0 + lx, z0 + lz))
        visit(lx + 1, lz, lx === CHUNK - 1 ? 1 : plan.vAt(x0 + lx + 1, z0 + lz))
        visit(lx, lz - 1, plan.hAt(x0 + lx, z0 + lz))
        visit(lx, lz + 1, lz === CHUNK - 1 ? 1 : plan.hAt(x0 + lx, z0 + lz + 1))
      }
      count++
    }
  }
  return { labels, count }
}

function repairPlanChunkSlices(plan, localSpace, rng, cfg) {
  let repairs = 0
  const n = cfg.districtChunks
  for (let localCz = 0; localCz < n; localCz++) {
    for (let localCx = 0; localCx < n; localCx++) {
      const x0 = localCx * CHUNK
      const z0 = localCz * CHUNK
      if (!plan.active[idx(plan.size, x0, z0)]) continue
      const { labels, count } = labelChunkComponents(plan, x0, z0)
      if (count <= 1) continue
      const grouped = new Map()
      const add = (a, b, candidate) => {
        if (a === b) return
        const key = pairKey(a, b)
        let list = grouped.get(key)
        if (!list) grouped.set(key, (list = []))
        list.push(candidate)
      }
      for (let z = 0; z < CHUNK; z++) {
        for (let x = 1; x < CHUNK; x++) {
          if (!plan.vAt(x0 + x, z0 + z)) continue
          const left = idx(plan.size, x0 + x - 1, z0 + z)
          const right = idx(plan.size, x0 + x, z0 + z)
          add(labels[z * CHUNK + x - 1], labels[z * CHUNK + x], {
            axis: 'v',
            line: x0 + x,
            cell: z0 + z,
            sa: localSpace[left],
            sb: localSpace[right],
          })
        }
      }
      for (let z = 1; z < CHUNK; z++) {
        for (let x = 0; x < CHUNK; x++) {
          if (!plan.hAt(x0 + x, z0 + z)) continue
          const north = idx(plan.size, x0 + x, z0 + z - 1)
          const south = idx(plan.size, x0 + x, z0 + z)
          add(labels[(z - 1) * CHUNK + x], labels[z * CHUNK + x], {
            axis: 'h',
            line: z0 + z,
            cell: x0 + x,
            sa: localSpace[north],
            sb: localSpace[south],
          })
        }
      }
      const parent = Array.from({ length: count }, (_, i) => i)
      const find = (a) => {
        while (parent[a] !== a) {
          parent[a] = parent[parent[a]]
          a = parent[a]
        }
        return a
      }
      for (const key of rng.shuffle([...grouped.keys()])) {
        const [a, b] = key.split(',').map(Number)
        const ra = find(a)
        const rb = find(b)
        if (ra === rb) continue
        parent[ra] = rb
        const candidate = pickDoor(plan, grouped.get(key), rng)
        carveConnection(plan, candidate.sa, candidate.sb, candidate)
        repairs++
      }
    }
  }
  return repairs
}

function ensureInternalChunkSeams(plan, localSpace, rng, cfg) {
  let repairs = 0
  const n = cfg.districtChunks
  let ordinaryWalls = 0
  let ordinaryEdges = 0
  for (let z = 0; z < plan.size; z++) {
    for (let x = 1; x < plan.size; x++) {
      const a = idx(plan.size, x - 1, z)
      const b = idx(plan.size, x, z)
      if (x % CHUNK !== 0 && plan.active[a] && plan.active[b]) {
        ordinaryWalls += plan.vAt(x, z)
        ordinaryEdges++
      }
    }
  }
  for (let z = 1; z < plan.size; z++) {
    for (let x = 0; x < plan.size; x++) {
      const a = idx(plan.size, x, z - 1)
      const b = idx(plan.size, x, z)
      if (z % CHUNK !== 0 && plan.active[a] && plan.active[b]) {
        ordinaryWalls += plan.hAt(x, z)
        ordinaryEdges++
      }
    }
  }
  const ordinaryDensity = ordinaryEdges ? ordinaryWalls / ordinaryEdges : 0
  const targetWalls = Math.max(0, Math.floor(ordinaryDensity * cfg.maxSeamRatio * CHUNK))

  for (let localCz = 0; localCz < n; localCz++) {
    const z0 = localCz * CHUNK
    for (let localCx = 1; localCx < n; localCx++) {
      const line = localCx * CHUNK
      const a = idx(plan.size, line - 1, z0)
      const b = idx(plan.size, line, z0)
      if (!plan.active[a] || !plan.active[b]) continue
      const candidates = []
      let walls = 0
      for (let z = z0; z < z0 + CHUNK; z++) {
        if (plan.vAt(line, z)) walls++
        const left = idx(plan.size, line - 1, z)
        const right = idx(plan.size, line, z)
        candidates.push({
          axis: 'v',
          line,
          cell: z,
          sa: localSpace[left],
          sb: localSpace[right],
        })
      }
      const remaining = candidates.slice()
      while (walls > targetWalls && remaining.length) {
        const candidate = pickDoor(plan, remaining, rng)
        remaining.splice(remaining.indexOf(candidate), 1)
        if (!plan.vAt(candidate.line, candidate.cell)) continue
        carveConnection(plan, candidate.sa, candidate.sb, candidate)
        repairs++
        walls--
      }
    }
  }
  for (let localCx = 0; localCx < n; localCx++) {
    const x0 = localCx * CHUNK
    for (let localCz = 1; localCz < n; localCz++) {
      const line = localCz * CHUNK
      const a = idx(plan.size, x0, line - 1)
      const b = idx(plan.size, x0, line)
      if (!plan.active[a] || !plan.active[b]) continue
      const candidates = []
      let walls = 0
      for (let x = x0; x < x0 + CHUNK; x++) {
        if (plan.hAt(x, line)) walls++
        const north = idx(plan.size, x, line - 1)
        const south = idx(plan.size, x, line)
        candidates.push({
          axis: 'h',
          line,
          cell: x,
          sa: localSpace[north],
          sb: localSpace[south],
        })
      }
      const remaining = candidates.slice()
      while (walls > targetWalls && remaining.length) {
        const candidate = pickDoor(plan, remaining, rng)
        remaining.splice(remaining.indexOf(candidate), 1)
        if (!plan.hAt(candidate.cell, candidate.line)) continue
        carveConnection(plan, candidate.sa, candidate.sb, candidate)
        repairs++
        walls--
      }
    }
  }
  return repairs
}

function scorePlan(
  plan,
  depth,
  cfg,
  sliceRepairs,
  seamRepairs,
  depthPromotions,
  shapePromotions
) {
  const rooms = plan.spaces.filter((space) => space.type === 'room')
  let shapePenalty = 0
  let tinyRooms = 0
  let invalidRooms = 0
  let lowCompactnessRooms = 0
  let maxDepth = 0
  for (const room of rooms) {
    const w = room.x1 - room.x0 + 1
    const h = room.z1 - room.z0 + 1
    const aspect = Math.max(w / h, h / w)
    const compactness = room.area / (w * h)
    shapePenalty += Math.max(0, aspect - cfg.maxRoomAspect) ** 2 +
      Math.max(0, cfg.targetRoomCompactness - compactness) * 3
    if (room.area < cfg.minRoomArea) tinyRooms++
    if (compactness < cfg.targetRoomCompactness) lowCompactnessRooms++
    if (
      room.area < cfg.minRoomArea ||
      Math.min(w, h) < cfg.minRoomWidth ||
      aspect > cfg.maxRoomAspect ||
      !room.hasUsableWidth
    ) invalidRooms++
    maxDepth = Math.max(maxDepth, depth[room.localId])
  }

  let active = 0
  let corridor = 0
  let walls = 0
  let edges = 0
  let seamWalls = 0
  let seamEdges = 0
  let ordinaryWalls = 0
  let ordinaryEdges = 0
  for (let z = 0; z < plan.size; z++) {
    for (let x = 0; x < plan.size; x++) {
      const i = idx(plan.size, x, z)
      if (plan.active[i]) {
        active++
        if (plan.cellKind[i] === CELL_CORRIDOR || plan.cellKind[i] === CELL_LOBBY) corridor++
      }
      if (x > 0) {
        const a = idx(plan.size, x - 1, z)
        if (plan.active[a] && plan.active[i]) {
          const wall = plan.vAt(x, z)
          walls += wall
          edges++
          if (x % CHUNK === 0) {
            seamWalls += wall
            seamEdges++
          } else {
            ordinaryWalls += wall
            ordinaryEdges++
          }
        }
      }
      if (z > 0) {
        const a = idx(plan.size, x, z - 1)
        if (plan.active[a] && plan.active[i]) {
          const wall = plan.hAt(x, z)
          walls += wall
          edges++
          if (z % CHUNK === 0) {
            seamWalls += wall
            seamEdges++
          } else {
            ordinaryWalls += wall
            ordinaryEdges++
          }
        }
      }
    }
  }

  const coverage = active ? corridor / active : 0
  const wallFraction = edges ? walls / edges : 0
  const seamDensity = seamEdges ? seamWalls / seamEdges : wallFraction
  const ordinaryDensity = ordinaryEdges ? ordinaryWalls / ordinaryEdges : wallFraction
  const seamRatio = ordinaryDensity > 0 ? seamDensity / ordinaryDensity : 1
  const portalMisses = plan.portals.filter((portal) => {
    const kind = plan.cellKind[idx(plan.size, portal.x, portal.z)]
    return kind !== CELL_CORRIDOR && kind !== CELL_LOBBY
  }).length
  const unroutedStairs = plan.stairLobbies.filter((lobby) => {
    const kind = plan.cellKind[idx(plan.size, lobby.mouth.x, lobby.mouth.z)]
    return kind !== CELL_CORRIDOR && kind !== CELL_LOBBY
  }).length
  const stairLobbyCells = new Set(plan.stairLobbies.flatMap((lobby) => lobby.cells)).size
  let unsupported = 0
  for (let z = 0; z < plan.size; z++) {
    for (let x = 0; x < plan.size; x++) {
      if (
        plan.passageVAt(x, z) === PASSAGE_DOOR &&
        supportingWalls(plan, { axis: 'v', line: x, cell: z }) === 0
      ) unsupported++
      if (
        plan.passageHAt(x, z) === PASSAGE_DOOR &&
        supportingWalls(plan, { axis: 'h', line: z, cell: x }) === 0
      ) unsupported++
    }
  }

  plan.metrics = {
    activeCells: active,
    corridorCoverage: coverage,
    wallFraction,
    rooms: rooms.length,
    maxRoomDepth: maxDepth,
    portalMisses,
    stairLobbies: plan.stairLobbies.length,
    stairLobbyCells,
    unroutedStairs,
    unsupportedDoors: unsupported,
    seamRatio,
    sliceRepairs,
    seamRepairs,
    depthPromotions,
    shapePromotions,
    tinyRooms,
    invalidRooms,
    lowCompactnessRooms,
  }
  const seamPenalty = Math.abs(Math.log(Math.max(0.05, seamRatio)))
  plan.score =
    portalMisses * 100 +
    unroutedStairs * 1000 +
    unsupported * 5 +
    invalidRooms * 100 +
    Math.max(0, maxDepth - cfg.maxRoomDepth) * 100 +
    Math.max(0, seamRatio - cfg.maxSeamRatio) * 100 +
    Math.abs(coverage - cfg.targetCoverage) * 8 +
    Math.abs(wallFraction - cfg.targetWallFraction) * 6 +
    seamPenalty * 2 +
    sliceRepairs * 0.05 +
    seamRepairs * 0.1 +
    depthPromotions * 0.5 +
    shapePromotions * 2 +
    lowCompactnessRooms * 0.25 +
    shapePenalty / Math.max(1, rooms.length)
  return plan.score
}

function buildCandidate(seed, dx, dz, config, candidate, context) {
  const cfg = officePlanConfig(config)
  const size = cfg.districtChunks * CHUNK
  const plan = new OfficePlan(size, dx, dz)
  markActiveChunks(plan, seed, config)
  plan.stairLobbies = collectStairLobbies(plan, seed, config, context)
  const circulation = planCirculation(plan, seed, config, candidate)
  const localSpace = allocateSpaces(
    plan,
    circulation,
    RNG.fromHash(seed, dx, dz, SALT_ROOMS ^ candidate),
    cfg,
    seed
  )
  derivePartitions(plan, localSpace)
  connectSpaces(
    plan,
    localSpace,
    RNG.fromHash(seed, dx, dz, SALT_DOORS ^ candidate),
    cfg
  )
  const repairRng = RNG.fromHash(seed, dx, dz, 0x7f13 ^ candidate)
  const sliceRepairs = repairPlanChunkSlices(plan, localSpace, repairRng, cfg)
  const seamRepairs = ensureInternalChunkSeams(plan, localSpace, repairRng, cfg)
  const shapePromotions = repairInvalidRoomShapes(plan, cfg)
  const { depth, promotions } = enforceRoomDepth(plan, cfg)
  scorePlan(plan, depth, cfg, sliceRepairs, seamRepairs, promotions, shapePromotions)
  return plan
}

function generateOfficeDistrictPlan(seed, dx, dz, config, context) {
  const cfg = officePlanConfig(config)
  let best = null
  for (let candidate = 0; candidate < cfg.candidates; candidate++) {
    const plan = buildCandidate(seed, dx, dz, config, candidate, context)
    if (!best || plan.score < best.score) best = plan
  }
  if (best.metrics.invalidRooms > 0) {
    throw new Error('office planner could not satisfy room-shape constraints')
  }
  if (best.metrics.unroutedStairs > 0) {
    throw new Error('office planner could not route every stair lobby')
  }
  return best
}

function configSignature(config) {
  return JSON.stringify([
    config.office,
    config.region,
    config.zoneBands,
    config.stairs,
  ])
}

function getOfficeDistrictPlan(seed, dx, dz, config, context = null) {
  const ctx = layerContext(seed, context)
  const signature = configSignature(config)
  let cache = PLAN_CACHES.get(config)
  if (!cache || cache.signature !== signature) {
    cache = { signature, plans: new Map() }
    PLAN_CACHES.set(config, cache)
  }
  const key =
    String(seed >>> 0) + ':' + String(ctx.rootSeed) + ':' + String(ctx.cy) + ':' +
    String(dx) + ',' + String(dz)
  const hit = cache.plans.get(key)
  if (hit) {
    cache.plans.delete(key)
    cache.plans.set(key, hit)
    return hit
  }
  const plan = generateOfficeDistrictPlan(seed, dx, dz, config, ctx)
  cache.plans.set(key, plan)
  if (cache.plans.size > CACHE_LIMIT) cache.plans.delete(cache.plans.keys().next().value)
  return plan
}

function clonePlan(source) {
  const plan = new OfficePlan(source.size, source.dx, source.dz)
  for (const key of [
    'active',
    'wallV',
    'wallH',
    'passageV',
    'passageH',
    'cellKind',
    'spaceId',
  ]) plan[key] = source[key].slice()
  plan.spaces = source.spaces.map((space) => ({ ...space }))
  plan.adjacency = source.adjacency.map((edge) => ({ ...edge }))
  plan.portals = source.portals.map((portal) => ({ ...portal }))
  plan.stairLobbies = source.stairLobbies.map((lobby) => ({
    ...lobby,
    mouth: { ...lobby.mouth },
    cells: lobby.cells.slice(),
    contract: {
      ...lobby.contract,
      landing: { ...lobby.contract.landing },
      run: lobby.contract.run.map((cell) => ({ ...cell })),
      exit: { ...lobby.contract.exit },
    },
  }))
  plan.metrics = { ...source.metrics }
  plan.score = source.score
  return plan
}

// Public inspection API returns a defensive snapshot. Generation uses the
// private cached plan so callers cannot mutate future chunk output. Pass
// `{rootSeed, layerSeed, cy}` when inspecting a non-zero layer; omission keeps
// the convenient layer-0 convention (rootSeed === seed, cy === 0).
export function buildOfficeDistrictPlan(seed, dx, dz, config, context = null) {
  return clonePlan(getOfficeDistrictPlan(seed, dx, dz, config, context))
}

export function clearOfficePlanCache(config) {
  if (config) PLAN_CACHES.delete(config)
}

export function applyOfficeDistrictPlan(data, ctx) {
  const district = officeDistrictCoords(ctx.cx, ctx.cz, ctx.config)
  const plan = getOfficeDistrictPlan(ctx.seed, district.dx, district.dz, ctx.config, ctx)
  const x0 = district.localCx * CHUNK
  const z0 = district.localCz * CHUNK
  for (let z = 0; z < CHUNK; z++) {
    for (let x = 0; x < CHUNK; x++) {
      const pi = idx(plan.size, x0 + x, z0 + z)
      const di = z * CHUNK + x
      data.cellKind[di] = plan.cellKind[pi]
      data.spaceId[di] = plan.spaceId[pi]
    }
  }
  for (let z = 0; z < CHUNK; z++) {
    for (let lineX = 1; lineX < CHUNK; lineX++) {
      data.setPassageV(lineX, z, plan.passageVAt(x0 + lineX, z0 + z))
    }
  }
  for (let lineZ = 1; lineZ < CHUNK; lineZ++) {
    for (let x = 0; x < CHUNK; x++) {
      data.setPassageH(x, lineZ, plan.passageHAt(x0 + x, z0 + lineZ))
    }
  }
}

export function officeInternalVContract(seed, kx, kz, config, context = null) {
  const east = officeDistrictCoords(kx + 1, kz, config)
  const plan = getOfficeDistrictPlan(seed, east.dx, east.dz, config, context)
  const lineX = east.localCx * CHUNK
  const z0 = east.localCz * CHUNK
  const walls = new Uint8Array(CHUNK)
  const passages = new Uint8Array(CHUNK)
  for (let z = 0; z < CHUNK; z++) {
    walls[z] = plan.vAt(lineX, z0 + z)
    passages[z] = plan.passageVAt(lineX, z0 + z)
  }
  return { kind: 'planned', walls, passages }
}

export function officeInternalHContract(seed, kx, kz, config, context = null) {
  const south = officeDistrictCoords(kx, kz + 1, config)
  const plan = getOfficeDistrictPlan(seed, south.dx, south.dz, config, context)
  const x0 = south.localCx * CHUNK
  const lineZ = south.localCz * CHUNK
  const walls = new Uint8Array(CHUNK)
  const passages = new Uint8Array(CHUNK)
  for (let x = 0; x < CHUNK; x++) {
    walls[x] = plan.hAt(x0 + x, lineZ)
    passages[x] = plan.passageHAt(x0 + x, lineZ)
  }
  return { kind: 'planned', walls, passages }
}

export function officeDistrictVContract(seed, kx, kz, config) {
  const n = officePlanConfig(config).districtChunks
  const dx = Math.floor(kx / n)
  const dz = Math.floor(kz / n)
  const segment = kz - dz * n
  const edge = buildOfficeDistrictEdgeContract(seed, 'v', dx, dz, config)
  const offset = segment * CHUNK
  return {
    kind: 'office',
    walls: edge.walls.slice(offset, offset + CHUNK),
    passages: edge.passages.slice(offset, offset + CHUNK),
  }
}

export function officeDistrictHContract(seed, kx, kz, config) {
  const n = officePlanConfig(config).districtChunks
  const dx = Math.floor(kx / n)
  const dz = Math.floor(kz / n)
  const segment = kx - dx * n
  const edge = buildOfficeDistrictEdgeContract(seed, 'h', dx, dz, config)
  const offset = segment * CHUNK
  return {
    kind: 'office',
    walls: edge.walls.slice(offset, offset + CHUNK),
    passages: edge.passages.slice(offset, offset + CHUNK),
  }
}
