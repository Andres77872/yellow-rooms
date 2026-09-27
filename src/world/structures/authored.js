import { CHUNK, cIdx } from '../constants.js'
import { hash3i } from '../core/hash.js'
import {
  CELL_LOBBY,
  CELL_OPEN,
  PASSAGE_DOOR,
  PASSAGE_OPEN,
  PASSAGE_WALL,
  SPACE_ROLE_NONE,
  WALL_PLAIN,
} from '../mapTypes.js'
import { stampMultilevelRooms } from './multilevelStamp.js'
import { STAIR_E, STAIR_N, STAIR_S, STAIR_W } from './slab.js'
import { stampStairDescriptors } from './stairStamp.js'

// Authored multilevel structures: volumes placed by hand (the map editor) or
// by a future planner at an arbitrary position, built from the SAME contracts
// the canonical families use so every consumer — meshing, collision, slab
// holes, lighting, pathfinding and the layered audit — treats them exactly
// like generated geometry.
//
//   atrium     the Office/Hotel multilevel contract (atrium hall at the base,
//              windowed galleries above, optional railed bridge decks) at any
//              rectangle whose ring stays inside its owning chunks.
//   stairwell  a switchback stair core: one canonical stair flight per slab,
//              alternating between two parallel rows, optionally enclosed by
//              walls with the same door on every floor — the endless stair.
//
// Builders are pure over a chunk accessor: `getChunk(cx, cy, cz)` reads,
// `ensureChunk(cx, cy, cz)` returns a mutable ChunkData (creating it when the
// caller allows). Authored volumes carry only slab slices/stair halves, never
// `data.structure`: they are not canonical planner output and must not claim a
// family adapter's ownership.

export const AUTHORED_TEMPLATES = Object.freeze(['atrium', 'stairwell'])
const TEMPLATE_SALT = Object.freeze({ atrium: 0xa7710, stairwell: 0x57a1e })

export function authoredId(template, gx, cy, gz) {
  return (hash3i(0x0a0717ed ^ (TEMPLATE_SALT[template] ?? 0), gx, cy, gz) >>> 0) || 1
}

const local = (g) => g - Math.floor(g / CHUNK) * CHUNK

function chunksOfRect(x0, z0, x1, z1) {
  const out = []
  for (let cz = Math.floor(z0 / CHUNK); cz <= Math.floor(z1 / CHUNK); cz++) {
    for (let cx = Math.floor(x0 / CHUNK); cx <= Math.floor(x1 / CHUNK); cx++) out.push({ cx, cz })
  }
  return out
}

// --- atrium -------------------------------------------------------------------

const MIN_ATRIUM_SPAN = 3
const MIN_BRIDGED_SHORT_SPAN = 4

// Build an authored atrium descriptor in the office multilevel shape
// (multilevelStructureSlice/stampMultilevelRooms consume it unchanged).
// Returns { descriptor } or { error }.
export function atriumDescriptor({
  x0, z0, x1, z1, baseCy, levels = 3, kind = 'openVoid', bridgeAxis = null, bridgeEvery = 2,
}) {
  if (![x0, z0, x1, z1, baseCy, levels].every(Number.isInteger)) return { error: 'non-integer parameters' }
  if (x1 < x0) [x0, x1] = [x1, x0]
  if (z1 < z0) [z0, z1] = [z1, z0]
  if (levels < 2) return { error: 'an atrium needs at least 2 storeys' }
  const w = x1 - x0 + 1
  const d = z1 - z0 + 1
  if (w < MIN_ATRIUM_SPAN || d < MIN_ATRIUM_SPAN) return { error: `footprint must be at least ${MIN_ATRIUM_SPAN}×${MIN_ATRIUM_SPAN}` }
  // The windowed perimeter and the lobby ring must live inside the chunks the
  // footprint occupies: an edge on a neighbour's owned line cannot be stamped
  // by this volume's slices.
  if (local(x0) < 1 || local(z0) < 1 || local(x1) > CHUNK - 2 || local(z1) > CHUNK - 2) {
    return { error: 'footprint edge touches a chunk border (keep one cell clear inside each chunk)' }
  }
  const axis = bridgeAxis ?? (w >= d ? 'x' : 'z')
  if (kind === 'bridged') {
    const short = axis === 'x' ? d : w
    if (short < MIN_BRIDGED_SHORT_SPAN) return { error: `a bridged atrium needs a short side of ${MIN_BRIDGED_SHORT_SPAN}+ cells` }
    // Deck guard rails sit on both long edges of the deck line; if the short
    // side crossed a chunk seam a rail could land on the neighbour's owned
    // line, where this chunk's slice cannot stamp it (canonical footprints
    // keep the short side inside one chunk for the same reason).
    const [s0, s1] = axis === 'x' ? [z0, z1] : [x0, x1]
    if (Math.floor(s0 / CHUNK) !== Math.floor(s1 / CHUNK)) {
      return { error: 'a bridged atrium\'s short side must lie within one chunk' }
    }
  } else if (kind !== 'openVoid') {
    return { error: `unknown atrium kind ${kind}` }
  }
  const topCy = baseCy + levels - 1
  const globalBounds = { x0, z0, x1, z1 }
  const participants = chunksOfRect(x0, z0, x1, z1)
  const id = authoredId('atrium', x0, baseCy, z0)

  let centerLines = []
  let bridgeLevels = []
  let decks = []
  if (kind === 'bridged') {
    const shortStart = axis === 'x' ? z0 : x0
    const shortEnd = axis === 'x' ? z1 : x1
    const low = shortStart + Math.floor((shortEnd - shortStart) / 2)
    centerLines = [low, Math.min(shortEnd - 1, low + 1)]
    for (let cy = baseCy + 1; cy <= topCy; cy += Math.max(1, bridgeEvery)) bridgeLevels.push(cy)
    decks = bridgeLevels.map((levelCy, i) => {
      const line = centerLines[i % centerLines.length]
      const cells = []
      if (axis === 'x') for (let gx = x0; gx <= x1; gx++) cells.push({ gx, gz: line })
      else for (let gz = z0; gz <= z1; gz++) cells.push({ gx: line, gz })
      return {
        levelCy,
        lowerCy: levelCy - 1,
        globalBridgeLine: line,
        globalBounds: axis === 'x' ? { x0, z0: line, x1, z1: line } : { x0: line, z0, x1: line, z1 },
        globalCells: cells,
      }
    })
  }
  return {
    descriptor: {
      id,
      hasRoom: true,
      authored: true,
      template: 'atrium',
      kind,
      baseCy,
      bottomCy: baseCy,
      topCy,
      levelCount: levels,
      height: levels,
      bridgeAxis: axis,
      longSpan: axis === 'x' ? w : d,
      shortSpan: axis === 'x' ? d : w,
      anchor: participants[0],
      participants,
      participantChunks: participants,
      bounds: globalBounds,
      globalBounds,
      centerLines,
      bridgeLevels,
      decks,
    },
  }
}

// Everything the volume would overwrite that belongs to another contract.
export function atriumConflicts(getChunk, desc) {
  const reasons = []
  const b = desc.globalBounds
  const ring = { x0: b.x0 - 1, z0: b.z0 - 1, x1: b.x1 + 1, z1: b.z1 + 1 }
  const inRing = (gx, gz) => gx >= ring.x0 - 1 && gx <= ring.x1 + 1 && gz >= ring.z0 - 1 && gz <= ring.z1 + 1
  for (let cy = desc.baseCy; cy <= desc.topCy; cy++) {
    for (const { cx, cz } of desc.participants) {
      const d = getChunk(cx, cy, cz)
      if (!d) continue
      if (d.structure?.hasRoom || d.structureUp || d.structureDown || d.lethalVoidUp || d.lethalVoidDown) {
        reasons.push(`cy ${cy}: chunk ${cx},${cz} already holds a multilevel structure`)
        continue
      }
      for (const stair of [d.stairUp, d.stairDown]) {
        const cells = stair ? [stair.landing, ...stair.run, stair.exit] : []
        if (cells.some((c) => inRing(cx * CHUNK + c.lx, cz * CHUNK + c.lz))) {
          reasons.push(`cy ${cy}: a stair in chunk ${cx},${cz} crosses the atrium ring`)
          break
        }
      }
      // The atrium hall must be the only multilevel surface of its base floor:
      // a base chunk carries no window or rail anywhere (layered audit rule).
      if (cy === desc.baseCy) {
        for (let i = 0; i < CHUNK * CHUNK; i++) {
          if (d.wallFeatureV[i] !== WALL_PLAIN || d.wallFeatureH[i] !== WALL_PLAIN) {
            reasons.push(`cy ${cy}: chunk ${cx},${cz} has windows/rails on the base floor`)
            break
          }
        }
      }
    }
  }
  return reasons
}

// Stamp every storey of every participant with the canonical multilevel
// stamp, then drop the canonical-structure claim and any fixture hanging in
// an opened ceiling.
export function stampAtrium(ensureChunk, desc) {
  const touched = []
  for (let cy = desc.baseCy; cy <= desc.topCy; cy++) {
    for (const { cx, cz } of desc.participants) {
      const d = ensureChunk(cx, cy, cz)
      stampMultilevelRooms(d, desc)
      d.structure = null
      d.lamps = d.lamps.filter((l) => !d.hasCeilHole(l.lx, l.lz))
      touched.push(d)
    }
  }
  return touched
}

// --- stairwell ----------------------------------------------------------------

const AXIS = {
  [STAIR_E]: { a: [1, 0], p: [0, 1] },
  [STAIR_W]: { a: [-1, 0], p: [0, 1] },
  [STAIR_S]: { a: [0, 1], p: [1, 0] },
  [STAIR_N]: { a: [0, -1], p: [1, 0] },
}
const OPPOSITE = { [STAIR_E]: STAIR_W, [STAIR_W]: STAIR_E, [STAIR_S]: STAIR_N, [STAIR_N]: STAIR_S }

// A switchback core at global landing (gx, gz): even flights climb along
// `dir` on the landing row; odd flights climb back along the adjacent row.
// The core (both rows, one halo cell around) must fit strictly inside one
// chunk. Returns { flights, core, cx, cz } or { error }.
export function stairwellPlan({ gx, gz, baseCy, topCy, dir = STAIR_E, doorSide = 'near' }) {
  if (![gx, gz, baseCy, topCy, dir].every(Number.isInteger)) return { error: 'non-integer parameters' }
  if (topCy <= baseCy) return { error: 'a stairwell spans at least 2 floors' }
  const ax = AXIS[dir]
  if (!ax) return { error: `invalid direction ${dir}` }
  const cx = Math.floor(gx / CHUNK)
  const cz = Math.floor(gz / CHUNK)
  const L = { lx: gx - cx * CHUNK, lz: gz - cz * CHUNK }
  const at = (base, along, across) => ({
    lx: base.lx + ax.a[0] * along + ax.p[0] * across,
    lz: base.lz + ax.a[1] * along + ax.p[1] * across,
  })
  const coreCells = []
  for (let along = -1; along <= 4; along++) {
    for (let across = -1; across <= 2; across++) coreCells.push(at(L, along, across))
  }
  if (coreCells.some((c) => c.lx < 1 || c.lz < 1 || c.lx > CHUNK - 2 || c.lz > CHUNK - 2)) {
    return { error: 'the stair core (6×4 cells with its halo) must sit strictly inside one chunk' }
  }
  const even = { dir, landing: at(L, 0, 0), run: [at(L, 1, 0), at(L, 2, 0)], exit: at(L, 3, 0) }
  const odd = { dir: OPPOSITE[dir], landing: at(L, 3, 1), run: [at(L, 2, 1), at(L, 1, 1)], exit: at(L, 0, 1) }
  const flights = []
  for (let lowerCy = baseCy; lowerCy < topCy; lowerCy++) {
    const stair = (lowerCy - baseCy) % 2 === 0 ? even : odd
    flights.push({ lowerCy, stair: { dir: stair.dir, landing: { ...stair.landing }, run: stair.run.map((c) => ({ ...c })), exit: { ...stair.exit } } })
  }
  const xs = coreCells.map((c) => c.lx)
  const zs = coreCells.map((c) => c.lz)
  const core = { x0: Math.min(...xs), z0: Math.min(...zs), x1: Math.max(...xs), z1: Math.max(...zs) }
  return {
    id: authoredId('stairwell', gx, baseCy, gz),
    template: 'stairwell',
    cx, cz, baseCy, topCy, dir, doorSide,
    flights,
    core,
    globalCore: { x0: cx * CHUNK + core.x0, z0: cz * CHUNK + core.z0, x1: cx * CHUNK + core.x1, z1: cz * CHUNK + core.z1 },
  }
}

export function stairwellConflicts(getChunk, plan) {
  const reasons = []
  for (let cy = plan.baseCy; cy <= plan.topCy; cy++) {
    const d = getChunk(plan.cx, cy, plan.cz)
    if (!d) continue
    if (cy < plan.topCy && d.stairUp) reasons.push(`cy ${cy}: chunk already has a stair up`)
    if (cy > plan.baseCy && d.stairDown) reasons.push(`cy ${cy}: chunk already has a stair down`)
    for (const slice of [d.structureUp, d.structureDown]) {
      const cells = slice ? [...(slice.voidCells ?? []), ...(slice.bridgeCells ?? [])] : []
      if (cells.some((c) => c.lx >= plan.core.x0 - 1 && c.lx <= plan.core.x1 + 1 && c.lz >= plan.core.z0 - 1 && c.lz <= plan.core.z1 + 1)) {
        reasons.push(`cy ${cy}: the core overlaps a multilevel structure`)
        break
      }
    }
  }
  return reasons
}

// Stamp every flight's lower and upper halves (the canonical stair
// primitive: halo carve, guard walls, mouth, back/far walls), then optionally
// enclose the core with walls and one door per floor at the same place.
export function stampStairwell(ensureChunk, plan, { enclosed = true } = {}) {
  const touched = []
  const flightAt = (lowerCy) => plan.flights.find((f) => f.lowerCy === lowerCy)?.stair ?? null
  for (let cy = plan.baseCy; cy <= plan.topCy; cy++) {
    const d = ensureChunk(plan.cx, cy, plan.cz)
    // The whole core is the stair hall on every floor, including the rows a
    // single flight's halo does not reach on the bottom and top floors.
    d.carveRect(plan.core.x0, plan.core.z0, plan.core.x1, plan.core.z1)
    stampStairDescriptors(d, { up: flightAt(cy), down: flightAt(cy - 1) })
    if (enclosed) encloseCore(d, plan)
    d.lamps = d.lamps.filter((l) => !d.hasCeilHole(l.lx, l.lz))
    touched.push(d)
  }
  return touched
}

function encloseCore(d, plan) {
  const { x0, z0, x1, z1 } = plan.core
  for (let z = z0; z <= z1; z++) {
    d.setV(x0, z, 1, PASSAGE_WALL)
    d.setV(x1 + 1, z, 1, PASSAGE_WALL)
  }
  for (let x = x0; x <= x1; x++) {
    d.setH(x, z0, 1, PASSAGE_WALL)
    d.setH(x, z1 + 1, 1, PASSAGE_WALL)
  }
  // One door, identical on every floor: centre of the side the first flight
  // starts beside (the -p side of the landing row).
  const door = stairwellDoor(plan)
  if (door.axis === 'h') d.setH(door.lx, door.line, 0, PASSAGE_DOOR)
  else d.setV(door.line, door.lz, 0, PASSAGE_DOOR)
  // The core reads as one stair hall.
  for (let z = z0; z <= z1; z++) {
    for (let x = x0; x <= x1; x++) {
      if (d.cellKind[cIdx(x, z)] === CELL_OPEN) d.cellKind[cIdx(x, z)] = CELL_LOBBY
      d.spaceRole[cIdx(x, z)] = SPACE_ROLE_NONE
    }
  }
}

export function stairwellDoor(plan) {
  const { x0, z0, x1, z1 } = plan.core
  const horizontal = plan.dir === STAIR_E || plan.dir === STAIR_W
  const far = plan.doorSide === 'far'
  // Horizontal flights: door on the north ('near') or south ('far') wall at
  // the core's middle column; vertical flights: west or east wall, mid row.
  return horizontal
    ? { axis: 'h', lx: Math.floor((x0 + x1) / 2), line: far ? z1 + 1 : z0 }
    : { axis: 'v', lz: Math.floor((z0 + z1) / 2), line: far ? x1 + 1 : x0 }
}

// Clearing helpers used when an authored volume is removed: open the
// footprint back to plain floor (the original fabric is not recoverable).
export function clearRectToOpen(d, x0, z0, x1, z1) {
  for (let z = Math.max(0, z0); z <= Math.min(CHUNK - 1, z1); z++) {
    for (let x = Math.max(0, x0); x <= Math.min(CHUNK - 1, x1); x++) {
      d.setCol(x, z, 0)
      d.cellKind[cIdx(x, z)] = CELL_OPEN
      d.spaceId[cIdx(x, z)] = 0
      d.spaceRole[cIdx(x, z)] = SPACE_ROLE_NONE
      if (x >= 1) d.setV(x, z, 0, PASSAGE_OPEN)
      if (x + 1 <= CHUNK - 1) d.setV(x + 1, z, 0, PASSAGE_OPEN)
      if (z >= 1) d.setH(x, z, 0, PASSAGE_OPEN)
      if (z + 1 <= CHUNK - 1) d.setH(x, z + 1, 0, PASSAGE_OPEN)
    }
  }
}

export { STAIR_E, STAIR_N, STAIR_S, STAIR_W }
