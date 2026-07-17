import { CHUNK, cIdx } from './constants.js'
import { STAIR_DX, STAIR_DZ } from './slab.js'
import { PASSAGE_WALL, PASSAGE_WIDE } from './mapTypes.js'
import {
  CELL_ATRIUM,
  CELL_BRIDGE,
  CELL_LOBBY,
  CELL_VOID,
  WALL_PLAIN,
  WALL_RAIL,
  WALL_WINDOW,
} from './mapTypes.js'
import { chunksShareOfficeDistrict } from './zones/officePlan.js'

// Continuity / "isolation" audit for the thin-wall generator. THREE-free and
// pure data, so it is shared by the property tests (continuity.test.js) and the
// debug world map (WorldMapTool) — one source of truth, like connectivity.js.
//
// It inspects SHARED BORDERS (the only place chunks couple) and reports how
// continuous the world reads: open zones should merge, office<->open seams
// should have a wide transition mouth, district boundaries need portals, and
// internal office seams should vary like ordinary plan cuts. A planned internal
// seam may be solid; macro-plan connectivity, not per-chunk permeability, is
// the architectural invariant.
//
// Seam storage (thin-wall ownership): the vertical seam between (cx,cz) and
// (cx+1,cz) is the EAST chunk's west line — east.vAt(0,z). The horizontal seam
// between (cx,cz) and (cx,cz+1) is the SOUTH chunk's north line — south.hAt(x,0).

export function vSeamLine(east) {
  const a = new Uint8Array(CHUNK)
  for (let z = 0; z < CHUNK; z++) a[z] = east.vAt(0, z)
  return a
}
export function hSeamLine(south) {
  const a = new Uint8Array(CHUNK)
  for (let x = 0; x < CHUNK; x++) a[x] = south.hAt(x, 0)
  return a
}

export const openFraction = (line) => {
  let n = 0
  for (let i = 0; i < CHUNK; i++) if (line[i] === 0) n++
  return n / CHUNK
}
export const openCount = (line) => {
  let n = 0
  for (let i = 0; i < CHUNK; i++) if (line[i] === 0) n++
  return n
}
export const longestOpenRun = (line) => {
  let best = 0
  let run = 0
  for (let i = 0; i < CHUNK; i++) {
    if (line[i] === 0) best = Math.max(best, ++run)
    else run = 0
  }
  return best
}
// Stable key of the open-index set (for cross-seam alignment comparison).
const openKey = (line) => {
  let k = ''
  for (let i = 0; i < CHUNK; i++) if (line[i] === 0) k += i + ','
  return k
}

const isOpen = (zone, config) => (config.border.openness[zone] ?? 0) >= 1

// Seam style from the two adjacent zones (mirrors border.js reconcile()).
export function classifySeam(za, zb, config, chunkA = null, chunkB = null) {
  const openA = isOpen(za, config)
  const openB = isOpen(zb, config)
  if (openA && openB) return 'open'
  if (openA || openB) return 'mouth'
  if (
    chunkA &&
    chunkB &&
    chunksShareOfficeDistrict(chunkA.cx, chunkA.cz, chunkB.cx, chunkB.cz, config)
  ) return 'planned'
  return 'office'
}

function blank() {
  return {
    seams: 0,
    sealed: 0, // fully solid shared borders (must be 0)
    minOpen: CHUNK, // fewest open cells on any seam (must be >= 1)
    open: { n: 0, openSum: 0 }, // open<->open: should be near-fully open
    mouth: { n: 0, withMouth: 0 }, // office<->open: should all have a wide mouth
    office: { n: 0, minDoors: CHUNK, cornerWalls: 0 }, // office district boundaries
    planned: { n: 0, solid: 0, keys: new Set() }, // internal district plan slices
  }
}

function record(s, line, kind, mouthMin) {
  s.seams++
  const oc = openCount(line)
  if (oc === 0 && kind !== 'planned') s.sealed++
  if (kind !== 'planned' && oc < s.minOpen) s.minOpen = oc
  if (kind === 'open') {
    s.open.n++
    s.open.openSum += openFraction(line)
  } else if (kind === 'mouth') {
    s.mouth.n++
    if (longestOpenRun(line) >= mouthMin) s.mouth.withMouth++
  } else if (kind === 'office') {
    s.office.n++
    s.office.minDoors = Math.min(s.office.minDoors, oc)
    if (line[0] === 1 && line[CHUNK - 1] === 1) s.office.cornerWalls++
  } else {
    s.planned.n++
    if (oc === 0) s.planned.solid++
    s.planned.keys.add(openKey(line))
  }
}

// Audit an NX×NZ patch. `dataAt(cx,cz)` returns a ChunkData (with .zone + the
// vAt/hAt accessors) or null. Walks every internal seam once.
export function auditPatch(dataAt, X0, Z0, NX, NZ, config) {
  const s = blank()
  const mouthMin = config.border.mouthWidth[0]

  // Vertical seams (between cx and cx+1).
  for (let cz = Z0; cz < Z0 + NZ; cz++) {
    for (let cx = X0; cx < X0 + NX - 1; cx++) {
      const a = dataAt(cx, cz)
      const east = dataAt(cx + 1, cz)
      if (!a || !east) continue
      const line = vSeamLine(east)
      const kind = classifySeam(a.zone, east.zone, config, a, east)
      record(s, line, kind, mouthMin)
    }
  }

  // Horizontal seams (between cz and cz+1).
  for (let cx = X0; cx < X0 + NX; cx++) {
    for (let cz = Z0; cz < Z0 + NZ - 1; cz++) {
      const a = dataAt(cx, cz)
      const south = dataAt(cx, cz + 1)
      if (!a || !south) continue
      const line = hSeamLine(south)
      const kind = classifySeam(a.zone, south.zone, config, a, south)
      record(s, line, kind, mouthMin)
    }
  }

  // Single 0..1 "continuity score" for the HUD: each component defaults to 1
  // when not sampled, so an all-office or all-open patch still scores fairly.
  const r = (num, den) => (den > 0 ? num / den : 1)
  s.openness = r(s.open.openSum, s.open.n)
  s.mouthCoverage = r(s.mouth.withMouth, s.mouth.n)
  s.portalCoverage = s.office.n === 0 || s.office.minDoors >= 1 ? 1 : 0
  s.planVariety = r(s.planned.keys.size, s.planned.n)
  s.planned.patterns = s.planned.keys.size
  delete s.planned.keys
  s.score =
    (s.sealed === 0 ? 1 : 0) * 0.4 +
    s.openness * 0.2 +
    s.mouthCoverage * 0.2 +
    s.portalCoverage * 0.1 +
    s.planVariety * 0.1
  return s
}

// Layered integrity audit for a rectangular NX x NY x NZ patch. `dataAt` is a
// pure lookup `(cx, cy, cz) -> ChunkData | null`; absent chunks are simply not
// part of the graph. Only slab pairs whose lower AND upper chunks are supplied
// are checked, so a bounded/live patch never reports its outer floor boundary
// as an orphan.
//
// The connectivity graph deliberately mirrors pathfind.js:
//   - a column blocks its cell;
//   - stair run cells on the lower layer and hole cells on the upper layer are
//     not graph nodes;
//   - planar edges use the thin-wall owner at the global grid line;
//   - the sole vertical edge is lower landing <-> upper exit.
//
// The returned counters are intentionally flat for debug-HUD consumption;
// `details` retains coordinates for tests and deeper diagnostics.
export function auditLayeredPatch(dataAt, X0, Y0, Z0, NX, NY, NZ) {
  const chunks = new Map()
  const key3 = (cx, cy, cz) => `${cx},${cy},${cz}`
  for (let cy = Y0; cy < Y0 + NY; cy++) {
    for (let cz = Z0; cz < Z0 + NZ; cz++) {
      for (let cx = X0; cx < X0 + NX; cx++) {
        const data = dataAt(cx, cy, cz)
        if (data) chunks.set(key3(cx, cy, cz), data)
      }
    }
  }

  const details = {
    mismatchedDescriptors: [],
    holeMismatches: [],
    orphanedHalves: [],
    invalidCanonicalLinks: [],
    mismatchedMultilevelDescriptors: [],
    orphanedMultilevelHalves: [],
    invalidMultilevelRooms: [],
    strayWallFeatures: [],
    invalidMultilevelStructures: [],
    missingMultilevelSlices: [],
    closedBridgeSeams: [],
  }
  const audit = {
    chunks: chunks.size,
    slabs: 0,
    stairs: 0,
    stairPairs: 0,
    mismatchedDescriptors: 0,
    holeMismatches: 0,
    holeMismatchSlabs: 0,
    orphanedHalves: 0,
    canonicalLinks: 0,
    invalidCanonicalLinks: 0,
    multilevelRooms: 0,
    multilevelPairs: 0,
    mismatchedMultilevelDescriptors: 0,
    orphanedMultilevelHalves: 0,
    invalidMultilevelRooms: 0,
    strayWallFeatures: 0,
    multilevelStructures: 0,
    multilevelSlices: 0,
    invalidMultilevelStructures: 0,
    missingMultilevelSlices: 0,
    closedBridgeSeams: 0,
    walkableCells: 0,
    components: 0,
    componentSizes: [],
    largestComponent: 0,
    disconnectedCells: 0,
    connected: true,
    ok: true,
    details,
  }

  // Valid canonical links are collected first, then installed after graph
  // nodes have been materialized. Bad/mismatched/orphaned halves never create
  // a synthetic vertical connection that could hide a real disconnection.
  const pendingLinks = []
  const pairedLowerRooms = new Set()
  const pairedUpperRooms = new Set()
  for (let cy = Y0; cy < Y0 + NY - 1; cy++) {
    for (let cz = Z0; cz < Z0 + NZ; cz++) {
      for (let cx = X0; cx < X0 + NX; cx++) {
        const lower = chunks.get(key3(cx, cy, cz))
        const upper = chunks.get(key3(cx, cy + 1, cz))
        if (!lower || !upper) continue
        audit.slabs++

        const up = lower.stairUp
        const down = upper.stairDown
        if (up || down) audit.stairs++
        if (!!up !== !!down) {
          audit.orphanedHalves++
          details.orphanedHalves.push({
            cx,
            cy,
            cz,
            half: up ? 'lower.stairUp' : 'upper.stairDown',
          })
        } else if (up && down) {
          audit.stairPairs++
          if (!sameStairDescriptor(up, down)) {
            audit.mismatchedDescriptors++
            details.mismatchedDescriptors.push({ cx, cy, cz })
          } else {
            const reasons = canonicalLinkErrors(lower, upper, up)
            if (reasons.length > 0) {
              audit.invalidCanonicalLinks++
              details.invalidCanonicalLinks.push({ cx, cy, cz, reasons })
            } else {
              pendingLinks.push({ cx, cy, cz, stair: up })
            }
          }
        }

        const roomUp = lower.multilevelUp
        const roomDown = upper.multilevelDown
        if (roomUp || roomDown) audit.multilevelRooms++
        if (!!roomUp !== !!roomDown) {
          audit.orphanedMultilevelHalves++
          details.orphanedMultilevelHalves.push({
            cx,
            cy,
            cz,
            half: roomUp ? 'lower.multilevelUp' : 'upper.multilevelDown',
          })
        } else if (roomUp && roomDown) {
          pairedLowerRooms.add(key3(cx, cy, cz))
          pairedUpperRooms.add(key3(cx, cy + 1, cz))
          audit.multilevelPairs++
          if (!sameMultilevelDescriptor(roomUp, roomDown)) {
            audit.mismatchedMultilevelDescriptors++
            details.mismatchedMultilevelDescriptors.push({ cx, cy, cz })
          }
          const reasons = multilevelPairErrors(lower, upper, roomUp, roomDown)
          if (reasons.length > 0) {
            audit.invalidMultilevelRooms++
            details.invalidMultilevelRooms.push({ cx, cy, cz, id: roomUp.id, reasons })
          }
        }

        let slabMismatch = false
        for (let lz = 0; lz < CHUNK; lz++) {
          for (let lx = 0; lx < CHUNK; lx++) {
            const ceiling = lower.hasCeilHole(lx, lz)
            const floor = upper.hasFloorHole(lx, lz)
            if (ceiling === floor) continue
            slabMismatch = true
            audit.holeMismatches++
            details.holeMismatches.push({ cx, cy, cz, lx, lz, ceiling, floor })
          }
        }
        if (slabMismatch) audit.holeMismatchSlabs++
      }
    }
  }

  // Validate boundary halves independently. A live/debug patch can start in
  // the middle of a tall structure, so an upper surface remains fully
  // auditable even when its lower slab owner is outside the patch. Conversely,
  // a lower `up` half still owns an exact ceiling mask when its consumer is
  // outside the patch. Paired halves were already checked together above.
  for (const [key, data] of chunks) {
    if (data.multilevelDown) {
      if (!pairedUpperRooms.has(key)) {
        const reasons = multilevelSurfaceErrors(data, data.multilevelDown)
        if (reasons.length > 0) {
          const [cx, cy, cz] = key.split(',').map(Number)
          audit.invalidMultilevelRooms++
          details.invalidMultilevelRooms.push({
            cx,
            cy: data.multilevelDown.lowerCy ?? cy - 1,
            cz,
            id: data.multilevelDown.id,
            reasons,
            boundaryHalf: 'upper.multilevelDown',
          })
        }
      }
    }
    if (data.multilevelUp && !pairedLowerRooms.has(key)) {
      const reasons = multilevelLowerHalfErrors(data, data.multilevelUp)
      if (reasons.length > 0) {
        const [cx, cy, cz] = key.split(',').map(Number)
        audit.invalidMultilevelRooms++
        details.invalidMultilevelRooms.push({
          cx,
          cy,
          cz,
          id: data.multilevelUp.id,
          reasons,
          boundaryHalf: 'lower.multilevelUp',
        })
      }
    }

    // A window/rail without a descriptor for this floor's visible surface is
    // categorically stray. In particular, the bottom hall has `up` but no
    // `down`, and must remain completely window/rail-free.
    if (data.multilevelDown) continue
    let count = 0
    for (let i = 0; i < data.wallFeatureV.length; i++) {
      if (data.wallFeatureV[i] !== WALL_PLAIN) count++
      if (data.wallFeatureH[i] !== WALL_PLAIN) count++
    }
    if (!count) continue
    const [cx, cy, cz] = key.split(',').map(Number)
    audit.strayWallFeatures += count
    details.strayWallFeatures.push({ cx, cy, cz, count })
  }

  const structureAudit = auditMultilevelStructureGroups(chunks)
  audit.multilevelStructures = structureAudit.structures
  audit.multilevelSlices = structureAudit.slices
  audit.invalidMultilevelStructures = structureAudit.invalid
  audit.missingMultilevelSlices = structureAudit.missing.length
  audit.closedBridgeSeams = structureAudit.closed.length
  details.invalidMultilevelStructures.push(...structureAudit.details)
  details.missingMultilevelSlices.push(...structureAudit.missing)
  details.closedBridgeSeams.push(...structureAudit.closed)

  const nodes = new Map()
  const nodeKey = (gx, gz, cy) => `${gx},${gz},${cy}`
  for (const [key, data] of chunks) {
    const [cx, cy, cz] = key.split(',').map(Number)
    for (let lz = 0; lz < CHUNK; lz++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        if (!cellWalkable(data, lx, lz)) continue
        const gx = cx * CHUNK + lx
        const gz = cz * CHUNK + lz
        nodes.set(nodeKey(gx, gz, cy), { gx, gz, cy })
      }
    }
  }
  audit.walkableCells = nodes.size

  const vertical = new Map()
  const addVertical = (from, to) => {
    let list = vertical.get(from)
    if (!list) vertical.set(from, (list = []))
    list.push(to)
  }
  for (const { cx, cy, cz, stair } of pendingLinks) {
    const lowerKey = nodeKey(
      cx * CHUNK + stair.landing.lx,
      cz * CHUNK + stair.landing.lz,
      cy
    )
    const upperKey = nodeKey(
      cx * CHUNK + stair.exit.lx,
      cz * CHUNK + stair.exit.lz,
      cy + 1
    )
    // canonicalLinkErrors already guarantees both endpoints are walkable, but
    // retain this guard so malformed non-ChunkData input cannot forge a link.
    if (!nodes.has(lowerKey) || !nodes.has(upperKey)) {
      audit.invalidCanonicalLinks++
      details.invalidCanonicalLinks.push({ cx, cy, cz, reasons: ['missing graph endpoint'] })
      continue
    }
    addVertical(lowerKey, upperKey)
    addVertical(upperKey, lowerKey)
    audit.canonicalLinks++
  }

  const wallV = (lineGX, gz, cy) => {
    const cx = Math.floor(lineGX / CHUNK)
    const cz = Math.floor(gz / CHUNK)
    const data = chunks.get(key3(cx, cy, cz))
    if (!data) return true
    return data.vAt(lineGX - cx * CHUNK, gz - cz * CHUNK) === 1
  }
  const wallH = (gx, lineGZ, cy) => {
    const cx = Math.floor(gx / CHUNK)
    const cz = Math.floor(lineGZ / CHUNK)
    const data = chunks.get(key3(cx, cy, cz))
    if (!data) return true
    return data.hAt(gx - cx * CHUNK, lineGZ - cz * CHUNK) === 1
  }

  const seen = new Set()
  for (const [startKey, start] of nodes) {
    if (seen.has(startKey)) continue
    let size = 0
    const stack = [start]
    seen.add(startKey)
    while (stack.length > 0) {
      const cur = stack.pop()
      size++
      const visit = (gx, gz, cy, blocked) => {
        if (blocked) return
        const key = nodeKey(gx, gz, cy)
        const next = nodes.get(key)
        if (!next || seen.has(key)) return
        seen.add(key)
        stack.push(next)
      }
      visit(cur.gx + 1, cur.gz, cur.cy, wallV(cur.gx + 1, cur.gz, cur.cy))
      visit(cur.gx - 1, cur.gz, cur.cy, wallV(cur.gx, cur.gz, cur.cy))
      visit(cur.gx, cur.gz + 1, cur.cy, wallH(cur.gx, cur.gz + 1, cur.cy))
      visit(cur.gx, cur.gz - 1, cur.cy, wallH(cur.gx, cur.gz, cur.cy))
      for (const nextKey of vertical.get(nodeKey(cur.gx, cur.gz, cur.cy)) || []) {
        const next = nodes.get(nextKey)
        if (!next || seen.has(nextKey)) continue
        seen.add(nextKey)
        stack.push(next)
      }
    }
    audit.componentSizes.push(size)
  }

  audit.componentSizes.sort((a, b) => b - a)
  audit.components = audit.componentSizes.length
  audit.largestComponent = audit.componentSizes[0] || 0
  audit.disconnectedCells = audit.walkableCells - audit.largestComponent
  audit.connected = audit.components <= 1
  audit.ok =
    audit.mismatchedDescriptors === 0 &&
    audit.holeMismatches === 0 &&
    audit.orphanedHalves === 0 &&
    audit.invalidCanonicalLinks === 0 &&
    audit.mismatchedMultilevelDescriptors === 0 &&
    audit.orphanedMultilevelHalves === 0 &&
    audit.invalidMultilevelRooms === 0 &&
    audit.strayWallFeatures === 0 &&
    audit.invalidMultilevelStructures === 0 &&
    audit.missingMultilevelSlices === 0 &&
    audit.closedBridgeSeams === 0 &&
    audit.connected
  return audit
}

function sameCell(a, b) {
  if (!a || !b) return a === b
  return a.lx === b.lx && a.lz === b.lz
}

function sameStairDescriptor(a, b) {
  return (
    a.dir === b.dir &&
    sameCell(a.landing, b.landing) &&
    sameCell(a.run?.[0], b.run?.[0]) &&
    sameCell(a.run?.[1], b.run?.[1]) &&
    sameCell(a.exit, b.exit)
  )
}

function sameMultilevelDescriptor(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

function validCell(cell) {
  return (
    Number.isInteger(cell?.lx) &&
    Number.isInteger(cell?.lz) &&
    cell.lx >= 0 &&
    cell.lx < CHUNK &&
    cell.lz >= 0 &&
    cell.lz < CHUNK
  )
}

function stairHoleAt(stair, lx, lz) {
  return !!stair?.run?.some((cell) => cell?.lx === lx && cell?.lz === lz)
}

function cellWalkable(data, lx, lz) {
  return (
    data.colAt(lx, lz) === 0 &&
    !data.hasFloorHole(lx, lz) &&
    !stairHoleAt(data.stairUp, lx, lz) &&
    !stairHoleAt(data.stairDown, lx, lz)
  )
}

const boundsEqual = (a, b) => !!a && !!b &&
  a.x0 === b.x0 && a.z0 === b.z0 && a.x1 === b.x1 && a.z1 === b.z1

const validBounds = (bounds) =>
  Number.isInteger(bounds?.x0) &&
  Number.isInteger(bounds?.z0) &&
  Number.isInteger(bounds?.x1) &&
  Number.isInteger(bounds?.z1) &&
  bounds.x0 <= bounds.x1 &&
  bounds.z0 <= bounds.z1

const multilevelCellKey = (lx, lz) => `${lx},${lz}`
const multilevelEdgeKey = (axis, line, cell) => `${axis}:${line},${cell}`

function multilevelEdgeState(data, axis, line, cell) {
  return axis === 'v'
    ? {
        wall: data.vAt(line, cell),
        passage: data.passageVAt(line, cell),
        feature: data.wallFeatureVAt(line, cell),
      }
    : {
        wall: data.hAt(cell, line),
        passage: data.passageHAt(cell, line),
        feature: data.wallFeatureHAt(cell, line),
      }
}

// Validate the coordinate contract and derive the canonical local partition.
// The footprint is allowed to touch any chunk border: only the GLOBAL bounds
// decide whether a local edge is an exterior wall or an internal owned seam.
function multilevelSliceGeometry(data, room, expectedLowerCy) {
  const reasons = []
  const bounds = room?.localBounds || room?.bounds
  const global = room?.globalBounds
  if (
    room?.hasRoom !== true ||
    !Number.isInteger(room?.id) || room.id <= 0 || room.id > 0xffffffff ||
    !validBounds(bounds) ||
    bounds.x0 < 0 || bounds.z0 < 0 ||
    bounds.x1 >= CHUNK || bounds.z1 >= CHUNK ||
    !validBounds(global)
  ) {
    reasons.push('invalid room identity or bounds')
  }
  if (
    !Number.isInteger(room?.baseCy) ||
    !Number.isInteger(room?.topCy) ||
    room.baseCy >= room.topCy ||
    room?.lowerCy !== expectedLowerCy ||
    room?.levelCy !== expectedLowerCy + 1 ||
    expectedLowerCy < room.baseCy ||
    expectedLowerCy >= room.topCy
  ) reasons.push('invalid multilevel slab coordinates')
  if (room?.kind !== 'bridged' && room?.kind !== 'openVoid') {
    reasons.push('invalid multilevel structure kind')
  }
  if (room?.bridgeAxis !== 'x' && room?.bridgeAxis !== 'z') {
    reasons.push('invalid bridge axis')
  }
  if (room?.bounds && room?.localBounds && !boundsEqual(room.bounds, room.localBounds)) {
    reasons.push('inconsistent local bounds aliases')
  }

  let expectedBounds = null
  if (validBounds(global)) {
    const chunkX0 = data.cx * CHUNK
    const chunkZ0 = data.cz * CHUNK
    const gx0 = Math.max(global.x0, chunkX0)
    const gz0 = Math.max(global.z0, chunkZ0)
    const gx1 = Math.min(global.x1, chunkX0 + CHUNK - 1)
    const gz1 = Math.min(global.z1, chunkZ0 + CHUNK - 1)
    if (gx0 <= gx1 && gz0 <= gz1) {
      expectedBounds = {
        x0: gx0 - chunkX0,
        z0: gz0 - chunkZ0,
        x1: gx1 - chunkX0,
        z1: gz1 - chunkZ0,
      }
    }
  }
  if (!expectedBounds || !boundsEqual(bounds, expectedBounds)) {
    reasons.push('local bounds do not match global structure bounds')
  }

  const globalBridgeLine = room?.globalBridgeLine
  let expectedBridgeLine = null
  if (globalBridgeLine !== null) {
    if (!Number.isInteger(globalBridgeLine) || room?.kind !== 'bridged') {
      reasons.push('invalid global bridge line')
    } else if (room?.bridgeAxis === 'x') {
      if (!validBounds(global) || globalBridgeLine < global.z0 || globalBridgeLine > global.z1) {
        reasons.push('invalid global bridge line')
      }
      expectedBridgeLine = globalBridgeLine - data.cz * CHUNK
    } else if (room?.bridgeAxis === 'z') {
      if (!validBounds(global) || globalBridgeLine < global.x0 || globalBridgeLine > global.x1) {
        reasons.push('invalid global bridge line')
      }
      expectedBridgeLine = globalBridgeLine - data.cx * CHUNK
    }
  }
  if (room?.bridgeLine !== expectedBridgeLine) reasons.push('invalid local bridge line')
  if (room?.kind === 'openVoid' && globalBridgeLine !== null) {
    reasons.push('open void has a bridge line')
  }

  const expectedVoid = new Set()
  const expectedBridge = new Set()
  const expectedBridgeCells = []
  if (validBounds(bounds) && bounds.x0 >= 0 && bounds.z0 >= 0 &&
      bounds.x1 < CHUNK && bounds.z1 < CHUNK) {
    for (let z = bounds.z0; z <= bounds.z1; z++) {
      for (let x = bounds.x0; x <= bounds.x1; x++) {
        const bridge = globalBridgeLine !== null && (
          room.bridgeAxis === 'x' ? z === expectedBridgeLine : x === expectedBridgeLine
        )
        const key = multilevelCellKey(x, z)
        if (bridge) {
          expectedBridge.add(key)
          expectedBridgeCells.push({ lx: x, lz: z })
        } else {
          expectedVoid.add(key)
        }
      }
    }
  }

  const actualVoid = new Set()
  const actualBridge = new Set()
  let duplicateOrInvalidCell = false
  for (const [cells, target] of [
    [room?.voidCells, actualVoid],
    [room?.bridgeCells, actualBridge],
  ]) {
    if (!Array.isArray(cells)) {
      duplicateOrInvalidCell = true
      continue
    }
    for (const cell of cells) {
      const key = multilevelCellKey(cell?.lx, cell?.lz)
      if (!validCell(cell) || target.has(key)) duplicateOrInvalidCell = true
      target.add(key)
    }
  }
  const partitionMatches =
    !duplicateOrInvalidCell &&
    actualVoid.size === expectedVoid.size &&
    actualBridge.size === expectedBridge.size &&
    [...expectedVoid].every((key) => actualVoid.has(key)) &&
    [...expectedBridge].every((key) => actualBridge.has(key))
  if (!partitionMatches) {
    reasons.push('descriptor does not partition footprint into void and bridge')
  }
  const footprint = validBounds(bounds)
    ? (bounds.x1 - bounds.x0 + 1) * (bounds.z1 - bounds.z0 + 1)
    : 0
  if (actualVoid.size + actualBridge.size !== footprint) {
    reasons.push('descriptor footprint area mismatch')
  }
  if ((room?.bridgeCells?.length || 0) !== expectedBridgeCells.length) {
    reasons.push('invalid bridge length')
  } else if (expectedBridgeCells.some((cell, index) => !sameCell(cell, room.bridgeCells[index]))) {
    reasons.push('non-canonical bridge deck')
  }

  return {
    reasons,
    bounds: expectedBounds && boundsEqual(bounds, expectedBounds) ? bounds : null,
    global: validBounds(global) ? global : null,
    expectedVoid,
    expectedBridge,
    expectedBridgeCells,
  }
}

function multilevelLowerHalfErrors(lower, room) {
  const geometry = multilevelSliceGeometry(lower, room, lower.cy)
  const reasons = [...geometry.reasons]
  const bounds = geometry.bounds
  if (!bounds) return [...new Set(reasons)]

  for (let z = bounds.z0; z <= bounds.z1; z++) {
    for (let x = bounds.x0; x <= bounds.x1; x++) {
      const isVoid = geometry.expectedVoid.has(multilevelCellKey(x, z))
      if (lower.hasCeilHole(x, z) !== isVoid) {
        reasons.push(isVoid
          ? 'void slab mask is incomplete'
          : 'bridge deck is not a retained slab cell')
      }
      if (lower.colAt(x, z)) reasons.push('column inside room volume')
      if (lower.spaceId[cIdx(x, z)] !== room.id) {
        reasons.push('room identity missing from footprint')
      }
      // Only the actual base is an atrium hall. A lower chunk in any later
      // slab is itself a gallery stamped from its `multilevelDown` slice.
      if (lower.cy === room.baseCy && lower.cellKind[cIdx(x, z)] !== CELL_ATRIUM) {
        reasons.push('lower atrium semantic missing')
      }
    }
  }
  if (lower.cy === room.baseCy) {
    for (let i = 0; i < lower.wallFeatureV.length; i++) {
      if (lower.wallFeatureV[i] !== WALL_PLAIN || lower.wallFeatureH[i] !== WALL_PLAIN) {
        reasons.push('bottom floor has a window or rail feature')
        break
      }
    }
  }
  return [...new Set(reasons)]
}

function multilevelSurfaceErrors(upper, room) {
  const geometry = multilevelSliceGeometry(upper, room, upper.cy - 1)
  const reasons = [...geometry.reasons]
  const bounds = geometry.bounds
  const global = geometry.global
  if (!bounds || !global) return [...new Set(reasons)]

  for (let z = bounds.z0; z <= bounds.z1; z++) {
    for (let x = bounds.x0; x <= bounds.x1; x++) {
      const key = multilevelCellKey(x, z)
      const bridge = geometry.expectedBridge.has(key)
      if (upper.hasFloorHole(x, z) !== !bridge) {
        reasons.push(bridge
          ? 'bridge deck is not a retained slab cell'
          : 'void slab mask is incomplete')
      }
      if (upper.colAt(x, z)) reasons.push('column inside room volume')
      const expectedKind = bridge ? CELL_BRIDGE : CELL_VOID
      if (upper.cellKind[cIdx(x, z)] !== expectedKind) {
        reasons.push(bridge ? 'bridge semantic missing' : 'void semantic missing')
      }
      if (upper.spaceId[cIdx(x, z)] !== room.id) {
        reasons.push('room identity missing from footprint')
      }
    }
  }

  const expectedWindows = new Set()
  const expectedRails = new Set()
  const expectedMouths = new Set()
  const chunkGX = upper.cx * CHUNK
  const chunkGZ = upper.cz * CHUNK
  const bridge = room.globalBridgeLine

  for (let z = bounds.z0; z <= bounds.z1; z++) {
    const gz = chunkGZ + z
    const bridgeEnd = bridge !== null && room.bridgeAxis === 'x' && gz === bridge
    if (chunkGX + bounds.x0 === global.x0) {
      ;(bridgeEnd ? expectedMouths : expectedWindows)
        .add(multilevelEdgeKey('v', bounds.x0, z))
    }
    if (chunkGX + bounds.x1 === global.x1) {
      ;(bridgeEnd ? expectedMouths : expectedWindows)
        .add(multilevelEdgeKey('v', bounds.x1 + 1, z))
    }
  }
  for (let x = bounds.x0; x <= bounds.x1; x++) {
    const gx = chunkGX + x
    const bridgeEnd = bridge !== null && room.bridgeAxis === 'z' && gx === bridge
    if (chunkGZ + bounds.z0 === global.z0) {
      ;(bridgeEnd ? expectedMouths : expectedWindows)
        .add(multilevelEdgeKey('h', bounds.z0, x))
    }
    if (chunkGZ + bounds.z1 === global.z1) {
      ;(bridgeEnd ? expectedMouths : expectedWindows)
        .add(multilevelEdgeKey('h', bounds.z1 + 1, x))
    }
  }
  for (const { lx, lz } of geometry.expectedBridgeCells) {
    if (room.bridgeAxis === 'x') {
      expectedRails.add(multilevelEdgeKey('h', lz, lx))
      expectedRails.add(multilevelEdgeKey('h', lz + 1, lx))
    } else {
      expectedRails.add(multilevelEdgeKey('v', lx, lz))
      expectedRails.add(multilevelEdgeKey('v', lx + 1, lz))
    }
  }

  const verifyEdges = (keys, expected, reason) => {
    for (const key of keys) {
      const [axis, coordinates] = key.split(':')
      const [line, cell] = coordinates.split(',').map(Number)
      const state = multilevelEdgeState(upper, axis, line, cell)
      if (
        state.wall !== expected.wall ||
        state.passage !== expected.passage ||
        state.feature !== expected.feature
      ) {
        reasons.push(reason)
        break
      }
    }
  }
  verifyEdges(
    expectedWindows,
    { wall: 1, passage: PASSAGE_WALL, feature: WALL_WINDOW },
    'invalid observation window'
  )
  verifyEdges(
    expectedRails,
    { wall: 1, passage: PASSAGE_WALL, feature: WALL_RAIL },
    'invalid bridge guard'
  )
  verifyEdges(
    expectedMouths,
    { wall: 0, passage: PASSAGE_WIDE, feature: WALL_PLAIN },
    'invalid bridge approach'
  )

  // Every longitudinal edge that is owned inside this chunk must stay open.
  // The one edge crossing a participant boundary is checked by the group pass.
  if (bridge !== null) {
    if (room.bridgeAxis === 'x') {
      for (let x = bounds.x0 + 1; x <= bounds.x1; x++) {
        if (multilevelEdgeState(upper, 'v', x, room.bridgeLine).wall !== 0) {
          reasons.push('blocked bridge deck')
          break
        }
      }
    } else {
      for (let z = bounds.z0 + 1; z <= bounds.z1; z++) {
        if (multilevelEdgeState(upper, 'h', z, room.bridgeLine).wall !== 0) {
          reasons.push('blocked bridge deck')
          break
        }
      }
    }

    // Validate only the true global endpoints. A clipped chunk boundary in
    // the middle of a long bridge is a seam, not a bank.
    const banks = room.bridgeAxis === 'x'
      ? [
          { gx: global.x0 - 1, gz: bridge },
          { gx: global.x1 + 1, gz: bridge },
        ]
      : [
          { gx: bridge, gz: global.z0 - 1 },
          { gx: bridge, gz: global.z1 + 1 },
        ]
    for (const bank of banks) {
      const lx = bank.gx - chunkGX
      const lz = bank.gz - chunkGZ
      if (lx < 0 || lx >= CHUNK || lz < 0 || lz >= CHUNK) continue
      if (
        upper.hasFloorHole(lx, lz) ||
        upper.colAt(lx, lz) ||
        upper.cellKind[cIdx(lx, lz)] !== CELL_LOBBY
      ) {
        reasons.push('invalid bridge bank')
        break
      }
    }
  }

  // No feature-marked edge may exist outside this floor's expected global
  // perimeter/bridge sets. Internal participant seams are therefore always
  // plain, even when the local slice happens to end at a chunk border.
  for (let cell = 0; cell < CHUNK; cell++) {
    for (let line = 0; line < CHUNK; line++) {
      const vf = upper.wallFeatureVAt(line, cell)
      const hf = upper.wallFeatureHAt(cell, line)
      if (vf !== WALL_PLAIN) {
        const key = multilevelEdgeKey('v', line, cell)
        if (
          (vf !== WALL_WINDOW || !expectedWindows.has(key)) &&
          (vf !== WALL_RAIL || !expectedRails.has(key))
        ) reasons.push('window or rail outside its multilevel room')
      }
      if (hf !== WALL_PLAIN) {
        const key = multilevelEdgeKey('h', line, cell)
        if (
          (hf !== WALL_WINDOW || !expectedWindows.has(key)) &&
          (hf !== WALL_RAIL || !expectedRails.has(key))
        ) reasons.push('window or rail outside its multilevel room')
      }
    }
  }
  return [...new Set(reasons)]
}

function multilevelPairErrors(lower, upper, roomUp, roomDown) {
  return [...new Set([
    ...multilevelLowerHalfErrors(lower, roomUp),
    ...multilevelSurfaceErrors(upper, roomDown),
  ])]
}

function chunkIntersectsGlobalBounds(data, bounds) {
  if (!validBounds(bounds)) return false
  const x0 = data.cx * CHUNK
  const z0 = data.cz * CHUNK
  return bounds.x0 <= x0 + CHUNK - 1 && bounds.x1 >= x0 &&
    bounds.z0 <= z0 + CHUNK - 1 && bounds.z1 >= z0
}

// Cross-slice invariants are checked only where this patch has enough
// authority: both chunks for a slab before reporting a missing participant,
// and both upper participant chunks before inspecting an owned bridge seam.
// This keeps a streaming boundary from looking like corrupt world data.
function auditMultilevelStructureGroups(chunks) {
  const groups = new Map()
  let slices = 0
  for (const [key, data] of chunks) {
    const [cx, cy, cz] = key.split(',').map(Number)
    for (const [half, slice] of [
      ['up', data.multilevelUp],
      ['down', data.multilevelDown],
    ]) {
      if (!slice) continue
      slices++
      if (!Number.isInteger(slice.id) || slice.id <= 0) continue
      let group = groups.get(slice.id)
      if (!group) groups.set(slice.id, (group = []))
      group.push({ cx, cy, cz, half, slice })
    }
  }

  const missing = []
  const closed = []
  const details = []
  const missingKeys = new Set()
  const closedKeys = new Set()
  const key3 = (cx, cy, cz) => `${cx},${cy},${cz}`

  for (const [id, records] of groups) {
    const canonical = records[0].slice
    const reasons = new Set()
    for (const { slice } of records.slice(1)) {
      if (
        slice.baseCy !== canonical.baseCy ||
        slice.topCy !== canonical.topCy ||
        slice.kind !== canonical.kind ||
        slice.bridgeAxis !== canonical.bridgeAxis ||
        !boundsEqual(slice.globalBounds, canonical.globalBounds)
      ) reasons.add('inconsistent structure descriptor')
    }

    const recordsBySlab = new Map()
    for (const record of records) {
      if (!Number.isInteger(record.slice.lowerCy)) continue
      let slab = recordsBySlab.get(record.slice.lowerCy)
      if (!slab) recordsBySlab.set(record.slice.lowerCy, (slab = []))
      slab.push(record)
    }
    for (const [lowerCy, slab] of recordsBySlab) {
      const first = slab[0].slice
      if (slab.some(({ slice }) =>
        slice.levelCy !== first.levelCy ||
        slice.globalBridgeLine !== first.globalBridgeLine
      )) reasons.add(`inconsistent slab descriptor at ${lowerCy}`)
    }

    const global = canonical.globalBounds
    if (
      Number.isInteger(canonical.baseCy) &&
      Number.isInteger(canonical.topCy) &&
      canonical.baseCy < canonical.topCy &&
      validBounds(global)
    ) {
      // Iterate loaded slab owners instead of the possibly corrupted global
      // coordinate range. It is both bounded and exactly expresses the rule
      // that absent chunks outside this patch are not audit participants.
      for (const [key, lower] of chunks) {
        const [cx, lowerCy, cz] = key.split(',').map(Number)
        if (lowerCy < canonical.baseCy || lowerCy >= canonical.topCy) continue
        const upper = chunks.get(key3(cx, lowerCy + 1, cz))
        if (!upper || !chunkIntersectsGlobalBounds(lower, global)) continue
        const up = lower.multilevelUp
        const down = upper.multilevelDown
        if (
          up?.id === id && down?.id === id &&
          up.lowerCy === lowerCy && down.lowerCy === lowerCy
        ) continue
        const missingKey = `${id}:${cx},${lowerCy},${cz}`
        if (missingKeys.has(missingKey)) continue
        missingKeys.add(missingKey)
        missing.push({ id, cx, cy: lowerCy, cz })
        reasons.add('missing loaded participant slice')
      }
    }

    // Inspect each observed bridge slab once. Local bridge validation covers
    // every longitudinal edge except a chunk crossing, whose owner is the
    // east/south chunk's line zero.
    for (const [lowerCy, slab] of recordsBySlab) {
      const slice = slab[0].slice
      const line = slice.globalBridgeLine
      const globalBounds = slice.globalBounds
      const levelCy = lowerCy + 1
      if (line === null || !Number.isInteger(line) || !validBounds(globalBounds)) continue
      if (slice.bridgeAxis === 'x') {
        const cz = Math.floor(line / CHUNK)
        for (
          let lineGX = (Math.floor(globalBounds.x0 / CHUNK) + 1) * CHUNK;
          lineGX <= globalBounds.x1;
          lineGX += CHUNK
        ) {
          const west = chunks.get(key3(Math.floor((lineGX - 1) / CHUNK), levelCy, cz))
          const east = chunks.get(key3(Math.floor(lineGX / CHUNK), levelCy, cz))
          if (!west || !east) continue
          if (east.vAt(0, line - cz * CHUNK) === 0) continue
          const closedKey = `${id}:${lowerCy}:v:${lineGX},${line}`
          if (closedKeys.has(closedKey)) continue
          closedKeys.add(closedKey)
          closed.push({ id, lowerCy, levelCy, axis: 'v', line: lineGX, cell: line })
          reasons.add('closed bridge seam')
        }
      } else if (slice.bridgeAxis === 'z') {
        const cx = Math.floor(line / CHUNK)
        for (
          let lineGZ = (Math.floor(globalBounds.z0 / CHUNK) + 1) * CHUNK;
          lineGZ <= globalBounds.z1;
          lineGZ += CHUNK
        ) {
          const north = chunks.get(key3(cx, levelCy, Math.floor((lineGZ - 1) / CHUNK)))
          const south = chunks.get(key3(cx, levelCy, Math.floor(lineGZ / CHUNK)))
          if (!north || !south) continue
          if (south.hAt(line - cx * CHUNK, 0) === 0) continue
          const closedKey = `${id}:${lowerCy}:h:${line},${lineGZ}`
          if (closedKeys.has(closedKey)) continue
          closedKeys.add(closedKey)
          closed.push({ id, lowerCy, levelCy, axis: 'h', line: lineGZ, cell: line })
          reasons.add('closed bridge seam')
        }
      }
    }

    if (reasons.size > 0) details.push({ id, reasons: [...reasons] })
  }

  return {
    structures: groups.size,
    slices,
    invalid: details.length,
    missing,
    closed,
    details,
  }
}

function canonicalLinkErrors(lower, upper, stair) {
  const reasons = []
  if (!Number.isInteger(stair?.dir) || stair.dir < 0 || stair.dir >= STAIR_DX.length) {
    reasons.push('invalid direction')
  }
  const strip = [stair?.landing, stair?.run?.[0], stair?.run?.[1], stair?.exit]
  if (!strip.every(validCell)) {
    reasons.push('invalid strip cell')
  } else if (reasons.length === 0) {
    for (let i = 1; i < strip.length; i++) {
      if (
        strip[i].lx !== strip[i - 1].lx + STAIR_DX[stair.dir] ||
        strip[i].lz !== strip[i - 1].lz + STAIR_DZ[stair.dir]
      ) {
        reasons.push('non-canonical strip')
        break
      }
    }
  }
  if (validCell(stair?.landing) && !cellWalkable(lower, stair.landing.lx, stair.landing.lz)) {
    reasons.push('blocked lower landing')
  }
  if (validCell(stair?.exit) && !cellWalkable(upper, stair.exit.lx, stair.exit.lz)) {
    reasons.push('blocked upper exit')
  }
  if (strip.every(validCell) && Number.isInteger(stair?.dir) && stair.dir >= 0 && stair.dir < 4) {
    const horiz = stair.dir === 1 || stair.dir === 3
    const edgeBetween = (a, b) => horiz
      ? { v: true, line: Math.max(a.lx, b.lx), cell: a.lz }
      : { v: false, line: Math.max(a.lz, b.lz), cell: a.lx }
    const flanks = (cell) => horiz
      ? [
          { v: false, line: cell.lz, cell: cell.lx },
          { v: false, line: cell.lz + 1, cell: cell.lx },
        ]
      : [
          { v: true, line: cell.lx, cell: cell.lz },
          { v: true, line: cell.lx + 1, cell: cell.lz },
        ]
    const state = (data, edge) => edge.v
      ? { wall: data.vAt(edge.line, edge.cell), passage: data.passageVAt(edge.line, edge.cell) }
      : { wall: data.hAt(edge.cell, edge.line), passage: data.passageHAt(edge.cell, edge.line) }
    const guarded = (data, edges) => edges.every((edge) => {
      const s = state(data, edge)
      return s.wall === 1 && s.passage === PASSAGE_WALL
    })
    const wideOpen = (data, edge) => {
      const s = state(data, edge)
      return s.wall === 0 && s.passage === PASSAGE_WIDE
    }
    if (![stair.landing, ...stair.run].every((cell) => guarded(lower, flanks(cell)))) {
      reasons.push('invalid lower guard wall')
    }
    if (!guarded(lower, [edgeBetween(stair.run[1], stair.exit)])) {
      reasons.push('invalid lower far wall')
    }
    const outer = {
      lx: stair.landing.lx - STAIR_DX[stair.dir],
      lz: stair.landing.lz - STAIR_DZ[stair.dir],
    }
    if (!wideOpen(lower, edgeBetween(outer, stair.landing))) {
      reasons.push('invalid lower mouth')
    }
    if (!stair.run.every((cell) => guarded(upper, flanks(cell)))) {
      reasons.push('invalid upper guard wall')
    }
    if (!guarded(upper, [edgeBetween(stair.landing, stair.run[0])])) {
      reasons.push('invalid upper back wall')
    }
    if (!wideOpen(upper, edgeBetween(stair.run[1], stair.exit))) {
      reasons.push('invalid upper mouth')
    }
  }
  return reasons
}
