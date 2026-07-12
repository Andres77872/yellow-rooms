import { CHUNK } from './constants.js'
import { STAIR_DX, STAIR_DZ } from './slab.js'
import { PASSAGE_WALL, PASSAGE_WIDE } from './mapTypes.js'
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

        let slabMismatch = false
        for (let lz = 0; lz < CHUNK; lz++) {
          for (let lx = 0; lx < CHUNK; lx++) {
            const ceiling = stairHoleAt(lower.stairUp, lx, lz)
            const floor = stairHoleAt(upper.stairDown, lx, lz)
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
    !stairHoleAt(data.stairUp, lx, lz) &&
    !stairHoleAt(data.stairDown, lx, lz)
  )
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
