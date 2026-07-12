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
          pairedUpperRooms.add(key3(cx, cy + 1, cz))
          audit.multilevelPairs++
          if (!sameMultilevelDescriptor(roomUp, roomDown)) {
            audit.mismatchedMultilevelDescriptors++
            details.mismatchedMultilevelDescriptors.push({ cx, cy, cz })
          } else {
            const reasons = multilevelRoomErrors(lower, upper, roomUp)
            if (reasons.length > 0) {
              audit.invalidMultilevelRooms++
              details.invalidMultilevelRooms.push({ cx, cy, cz, id: roomUp.id, reasons })
            }
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

  // A window/rail without an upper multilevel descriptor is categorically
  // invalid: ordinary walls and lower atrium halls may never acquire these
  // see-through collision features. Paired upper rooms receive the stricter
  // exact-edge validation in multilevelRoomErrors above.
  for (const [key, data] of chunks) {
    if (data.multilevelDown) {
      if (pairedUpperRooms.has(key)) continue
      const reasons = multilevelUpperBoundaryErrors(data, data.multilevelDown)
      if (reasons.length > 0) {
        const [cx, , cz] = key.split(',').map(Number)
        audit.invalidMultilevelRooms++
        details.invalidMultilevelRooms.push({
          cx,
          cy: data.multilevelDown.baseCy,
          cz,
          id: data.multilevelDown.id,
          reasons,
          boundaryHalf: 'upper.multilevelDown',
        })
      }
      continue
    }
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

function multilevelRoomErrors(lower, upper, room) {
  const reasons = []
  const { x0, z0, x1, z1 } = room.bounds || {}
  if (
    !Number.isInteger(room.id) || room.id <= 0 || room.id > 0xffffffff ||
    room.baseCy !== lower.cy ||
    !Number.isInteger(x0) ||
    !Number.isInteger(z0) ||
    !Number.isInteger(x1) ||
    !Number.isInteger(z1) ||
    x0 < 1 || z0 < 1 || x1 >= CHUNK - 1 || z1 >= CHUNK - 1 ||
    x0 > x1 || z0 > z1
  ) {
    return ['invalid room identity or bounds']
  }
  if (room.bridgeAxis !== 'x' && room.bridgeAxis !== 'z') {
    return ['invalid bridge axis']
  }

  const expectedWindows = new Set()
  const expectedRails = new Set()
  const expectedMouths = new Set()
  const edgeKey = (axis, line, cell) => `${axis}:${line},${cell}`
  const state = (data, axis, line, cell) => axis === 'v'
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

  for (let z = z0; z <= z1; z++) {
    const ends = room.bridgeAxis === 'x' && z === room.bridgeLine
    for (const line of [x0, x1 + 1]) {
      ;(ends ? expectedMouths : expectedWindows).add(edgeKey('v', line, z))
    }
  }
  for (let x = x0; x <= x1; x++) {
    const ends = room.bridgeAxis === 'z' && x === room.bridgeLine
    for (const line of [z0, z1 + 1]) {
      ;(ends ? expectedMouths : expectedWindows).add(edgeKey('h', line, x))
    }
  }
  if (room.bridgeAxis === 'x') {
    for (let x = x0; x <= x1; x++) {
      expectedRails.add(edgeKey('h', room.bridgeLine, x))
      expectedRails.add(edgeKey('h', room.bridgeLine + 1, x))
    }
  } else {
    for (let z = z0; z <= z1; z++) {
      expectedRails.add(edgeKey('v', room.bridgeLine, z))
      expectedRails.add(edgeKey('v', room.bridgeLine + 1, z))
    }
  }

  const actualVoid = new Set(room.voidCells?.map((c) => `${c.lx},${c.lz}`) || [])
  const actualBridge = new Set(room.bridgeCells?.map((c) => `${c.lx},${c.lz}`) || [])
  const footprint = (x1 - x0 + 1) * (z1 - z0 + 1)
  for (let z = z0; z <= z1; z++) {
    for (let x = x0; x <= x1; x++) {
      const key = `${x},${z}`
      const bridge = room.bridgeAxis === 'x' ? z === room.bridgeLine : x === room.bridgeLine
      if (bridge !== actualBridge.has(key) || bridge === actualVoid.has(key)) {
        reasons.push('descriptor does not partition footprint into void and bridge')
      }
      if (lower.colAt(x, z) || upper.colAt(x, z)) reasons.push('column inside room volume')
      if (bridge) {
        if (lower.hasCeilHole(x, z) || upper.hasFloorHole(x, z)) {
          reasons.push('bridge deck is not a retained slab cell')
        }
        if (upper.cellKind[cIdx(x, z)] !== CELL_BRIDGE) reasons.push('bridge semantic missing')
      } else {
        if (!lower.hasCeilHole(x, z) || !upper.hasFloorHole(x, z)) {
          reasons.push('void slab mask is incomplete')
        }
        if (upper.cellKind[cIdx(x, z)] !== CELL_VOID) reasons.push('void semantic missing')
      }
      if (lower.cellKind[cIdx(x, z)] !== CELL_ATRIUM) reasons.push('lower atrium semantic missing')
      if (lower.spaceId[cIdx(x, z)] !== room.id || upper.spaceId[cIdx(x, z)] !== room.id) {
        reasons.push('room identity missing from footprint')
      }
    }
  }
  if (actualVoid.size + actualBridge.size !== footprint) {
    reasons.push('descriptor footprint area mismatch')
  }

  const bridgeCells = room.bridgeCells || []
  const expectedLength = room.bridgeAxis === 'x' ? x1 - x0 + 1 : z1 - z0 + 1
  if (bridgeCells.length !== expectedLength) reasons.push('invalid bridge length')
  for (let i = 1; i < bridgeCells.length; i++) {
    const a = bridgeCells[i - 1]
    const b = bridgeCells[i]
    const canonical = room.bridgeAxis === 'x'
      ? b.lx === a.lx + 1 && b.lz === a.lz
      : b.lz === a.lz + 1 && b.lx === a.lx
    if (!canonical) {
      reasons.push('non-canonical bridge deck')
      break
    }
    const axis = room.bridgeAxis === 'x' ? 'v' : 'h'
    const line = room.bridgeAxis === 'x' ? b.lx : b.lz
    const cell = room.bridgeAxis === 'x' ? a.lz : a.lx
    if (state(upper, axis, line, cell).wall !== 0) {
      reasons.push('blocked bridge deck')
      break
    }
  }
  const banks = room.bridgeAxis === 'x'
    ? [
        { lx: x0 - 1, lz: room.bridgeLine },
        { lx: x1 + 1, lz: room.bridgeLine },
      ]
    : [
        { lx: room.bridgeLine, lz: z0 - 1 },
        { lx: room.bridgeLine, lz: z1 + 1 },
      ]
  for (const bank of banks) {
    if (
      upper.hasFloorHole(bank.lx, bank.lz) ||
      upper.colAt(bank.lx, bank.lz) ||
      upper.cellKind[cIdx(bank.lx, bank.lz)] !== CELL_LOBBY
    ) {
      reasons.push('invalid bridge bank')
      break
    }
  }

  for (const key of expectedWindows) {
    const [axis, coords] = key.split(':')
    const [line, cell] = coords.split(',').map(Number)
    const s = state(upper, axis, line, cell)
    if (s.wall !== 1 || s.passage !== PASSAGE_WALL || s.feature !== WALL_WINDOW) {
      reasons.push('invalid observation window')
      break
    }
  }
  for (const key of expectedRails) {
    const [axis, coords] = key.split(':')
    const [line, cell] = coords.split(',').map(Number)
    const s = state(upper, axis, line, cell)
    if (s.wall !== 1 || s.passage !== PASSAGE_WALL || s.feature !== WALL_RAIL) {
      reasons.push('invalid bridge guard')
      break
    }
  }
  for (const key of expectedMouths) {
    const [axis, coords] = key.split(':')
    const [line, cell] = coords.split(',').map(Number)
    const s = state(upper, axis, line, cell)
    if (s.wall !== 0 || s.passage !== PASSAGE_WIDE || s.feature !== WALL_PLAIN) {
      reasons.push('invalid bridge approach')
      break
    }
  }

  // No feature-marked edge may exist outside the room-derived sets. This is
  // the audit-level proof that ordinary partitions never become windows.
  for (let cell = 0; cell < CHUNK; cell++) {
    for (let line = 0; line < CHUNK; line++) {
      const vf = upper.wallFeatureVAt(line, cell)
      const hf = upper.wallFeatureHAt(cell, line)
      if (vf !== WALL_PLAIN) {
        const key = edgeKey('v', line, cell)
        if (
          (vf !== WALL_WINDOW || !expectedWindows.has(key)) &&
          (vf !== WALL_RAIL || !expectedRails.has(key))
        ) reasons.push('window or rail outside its multilevel room')
      }
      if (hf !== WALL_PLAIN) {
        const key = edgeKey('h', line, cell)
        if (
          (hf !== WALL_WINDOW || !expectedWindows.has(key)) &&
          (hf !== WALL_RAIL || !expectedRails.has(key))
        ) reasons.push('window or rail outside its multilevel room')
      }
    }
  }
  return [...new Set(reasons)]
}

// A bounded live/debug patch may begin on an upper atrium floor and omit the
// lower owner by design. Validate every upper-local invariant anyway by
// supplying a canonical lower semantic view derived from the descriptor; only
// cross-slab pairing/connectivity remains outside the patch's authority.
function multilevelUpperBoundaryErrors(upper, room) {
  const voidCells = new Set(room?.voidCells?.map((cell) => `${cell.lx},${cell.lz}`) || [])
  const cellKind = new Uint8Array(CHUNK * CHUNK).fill(CELL_ATRIUM)
  const spaceId = new Uint32Array(CHUNK * CHUNK).fill(room?.id || 0)
  const lower = {
    cy: room?.baseCy,
    cellKind,
    spaceId,
    colAt: () => 0,
    hasCeilHole: (lx, lz) => voidCells.has(`${lx},${lz}`),
  }
  return multilevelRoomErrors(lower, upper, room)
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
