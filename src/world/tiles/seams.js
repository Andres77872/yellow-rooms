import { CHUNK, cIdx, hIdx, vIdx } from '../constants.js'
import {
  CELL_OPEN,
  COLUMN_STANDARD,
  PASSAGE_OPEN,
  PASSAGE_WALL,
  WALL_PLAIN,
  wallFeatureSeesThrough,
} from '../mapTypes.js'
import { CELL_CLASS_RING, levelRaster } from '../structures/catalog/engine.js'
import { cellWalkable } from './holeMasks.js'
import { BORDER_DEPTH } from './massMask.js'
import { isSolidMassChunk } from './solidChunk.js'
import { tileKeyOf } from './tileKey.js'

// The seam and perimeter contract of tile bakes (spec §6.8).
//
// Ownership: a chunk owns its West line (lx = 0) and its North line (lz = 0).
// Perimeter rule: for every kept chunk C and each side with a FOREIGN
// neighbour N (outside the tile, not kept, or scratch):
//   1. east/south: C's east column / south row is mass except at ports;
//   2. west/north: every walkable cell on C's owned line gets an owned plain
//      wall on that line, except at ports;
//   3. ports: the tile program opens plan cells from the interior to the edge
//      at every port range on all four sides, then calls openOwnedSeam for
//      its west/north lines (a port facing a footprint-solid N is a contract
//      violation);
//   4. open decks declare ports covering the whole deck range.
// massLeakAudit proves the result over a generated window.

const ZERO = Object.freeze({ cx: 0, cy: 0, cz: 0 })

// --- ports -------------------------------------------------------------------------

// The port ranges of tile k's `side` on GLOBAL storey cy, tile-local along
// cells, inclusive [{a0, a1}]. West/north are the tile's own; east/south are
// its neighbour's west/north (ports are pure and band-independent, §6.5).
export function seamPorts(gen, worldSeed, k, side, cy) {
  const seed = worldSeed >>> 0
  switch (side) {
    case 'west':
    case 'north':
      return gen.ports(seed, { tx: k.tx, tz: k.tz }, side, cy) ?? []
    case 'east':
      return gen.ports(seed, { tx: k.tx + 1, tz: k.tz }, 'west', cy) ?? []
    case 'south':
      return gen.ports(seed, { tx: k.tx, tz: k.tz + 1 }, 'north', cy) ?? []
    default:
      throw new Error(`seamPorts: unknown side ${side}`)
  }
}

// ctx.portsAt for a bake of tile k: (side, cy GLOBAL) → [{a0, a1}], memoised.
export function portsAtOf(gen, worldSeed, k) {
  const memo = new Map()
  return (side, cy) => {
    const key = `${side}|${cy}`
    let p = memo.get(key)
    if (!p) memo.set(key, (p = Object.freeze([...seamPorts(gen, worldSeed, k, side, cy)].map((r) => Object.freeze({ a0: r.a0, a1: r.a1 })))))
    return p
  }
}

// After `compile` of kind-local storey cy, open the tile's owned West or
// North line at every declared port cell (wall 0, PASSAGE_OPEN). A port
// whose inner cell is not walkable is left closed and noted on ctx.notes
// ('seam:port-blocked <side> <a> <cy>'): the tile program must open its plan
// cells to the edge first. Returns the number of edges opened.
export function openOwnedSeam(map, ctx, cy, side) {
  if (side !== 'west' && side !== 'north') throw new Error(`openOwnedSeam: side must be 'west' or 'north', got ${side}`)
  const o = map.origin ?? ctx.origin ?? ZERO
  const gcy = cy + o.cy
  let opened = 0
  for (const { a0, a1 } of ctx.portsAt?.(side, gcy) ?? []) {
    for (let a = a0; a <= a1; a++) {
      const gx = side === 'west' ? 0 : a
      const gz = side === 'west' ? a : 0
      const d = map.chunkAt(map.cellChunk(gx), cy, map.cellChunk(gz))
      if (!d || !cellWalkable(d, map.cellLocal(gx), map.cellLocal(gz))) {
        ctx.notes?.push?.(`seam:port-blocked ${side} ${a} ${gcy}`)
        continue
      }
      if (side === 'west') map.setWallV(0, cy, a, 0, PASSAGE_OPEN)
      else map.setWallH(a, cy, 0, 0, PASSAGE_OPEN)
      opened++
    }
  }
  return opened
}

// --- stamp ring re-mass ------------------------------------------------------------

const SIDES = [
  // [dlx, dlz, at-edge(lx, lz), tile side when the neighbour leaves the window]
  [-1, 0, (lx) => lx === 0, 'west'],
  [1, 0, (lx) => lx === CHUNK - 1, 'east'],
  [0, -1, (lx, lz) => lz === 0, 'north'],
  [0, 1, (lx, lz) => lz === CHUNK - 1, 'south'],
]

// After a catalog stamp: every carved ring cell that lay outside the kind's
// plan (`before` holds the ring cells that were mass or absent before the
// stamp; without it every carved ring cell counts) and sits on a chunk edge
// facing a FOREIGN chunk (outside the tile window, not kept, or scratch) goes
// back to mass, unless it is a declared port cell; every edge between it and
// a walkable cell of a kept chunk gets a plain wall (spec §6.8).
// Moved verbatim from tiles/kit.js (which re-exports it).
export function remassStampRing(canvas, desc, ctx = {}, { before = null } = {}) {
  const o = canvas.origin ?? ZERO
  const win = ctx.window ?? null
  const inWindow = (gcx, gcz) => !win || (gcx >= win.cx0 && gcx <= win.cx1 && gcz >= win.cz0 && gcz <= win.cz1)
  const kept = (gcx, gcy, gcz) => inWindow(gcx, gcz) && canvas._keptGlobal(gcx, gcy, gcz)
  const isPort = (side, gx, gz, cy) => {
    if (!win || !ctx.portsAt) return false
    const along = side === 'west' || side === 'east' ? gz - win.cz0 * CHUNK : gx - win.cx0 * CHUNK
    return (ctx.portsAt(side, cy) ?? []).some((p) => along >= p.a0 && along <= p.a1)
  }
  const cy0 = Math.max(desc.baseCy, ctx.cy0 ?? -Infinity)
  const cy1 = Math.min(desc.topCy, ctx.cy1 ?? Infinity)
  let restored = 0
  let walled = 0
  for (let cy = cy0; cy <= cy1; cy++) {
    const raster = levelRaster(desc, cy - desc.baseCy)
    const { box } = raster
    const remass = []
    for (let gz = box.z0; gz <= box.z1; gz++) {
      for (let gx = box.x0; gx <= box.x1; gx++) {
        if (raster.at(gx, gz) !== CELL_CLASS_RING) continue
        const gcx = Math.floor(gx / CHUNK)
        const gcz = Math.floor(gz / CHUNK)
        if (!kept(gcx, cy, gcz)) continue
        const d = canvas.globalChunk(gcx, cy, gcz, false)
        const lx = gx - gcx * CHUNK
        const lz = gz - gcz * CHUNK
        if (!d || d.cols[cIdx(lx, lz)] !== 0) continue
        if (before && !before.has(`${gx},${gz},${cy}`)) continue
        let facing = false
        for (const [ax, az, atEdge, side] of SIDES) {
          if (!atEdge(lx, lz)) continue
          const ncx = gcx + ax
          const ncz = gcz + az
          if (kept(ncx, cy, ncz)) continue
          if (!inWindow(ncx, ncz) && isPort(side, gx, gz, cy)) continue
          facing = true
        }
        if (facing) remass.push({ d, gx, gz, lx, lz })
      }
    }
    const massed = new Set(remass.map((c) => `${c.gx},${c.gz}`))
    for (const { d, lx, lz } of remass) {
      const i = cIdx(lx, lz)
      d.setCol(lx, lz, COLUMN_STANDARD)
      d.cellKind[i] = CELL_OPEN
      d.spaceId[i] = 0
      restored++
    }
    for (const { gx, gz } of remass) {
      for (const [ax, az] of SIDES) {
        const nx = gx + ax
        const nz = gz + az
        if (massed.has(`${nx},${nz}`)) continue
        const ncx = Math.floor(nx / CHUNK)
        const ncz = Math.floor(nz / CHUNK)
        if (!kept(ncx, cy, ncz)) continue
        const n = canvas.globalChunk(ncx, cy, ncz, false)
        if (!n || n.cols[cIdx(nx - ncx * CHUNK, nz - ncz * CHUNK)] !== 0) continue
        // The edge's owner line: West (v) / North (h) of the eastern / southern cell.
        if (ax) canvas.setWallV(Math.max(gx, nx) - o.cx * CHUNK, cy - o.cy, gz - o.cz * CHUNK, 1, PASSAGE_WALL)
        else canvas.setWallH(gx - o.cx * CHUNK, cy - o.cy, Math.max(gz, nz) - o.cz * CHUNK, 1, PASSAGE_WALL)
        walled++
      }
    }
  }
  return { restored, walled }
}

// --- mass leak audit -----------------------------------------------------------------

// A mass cell: a standard column over an open, unowned cell — what the canvas
// writes for "nothing here" (FloorPlan.compile's non-plan cells, solidChunk,
// remassStampRing). A pillar placed on a room/corridor cell keeps its cell
// kind or space id and is not mass.
export function isMassCell(d, lx, lz) {
  const i = cIdx(lx, lz)
  return d.cols[i] === COLUMN_STANDARD && d.cellKind[i] === CELL_OPEN && d.spaceId[i] === 0
}

const DETAIL_CAP = 24

// Scan every edge between two cells of `box` (GLOBAL chunks {x0, z0, x1, z1,
// y0, y1}, inclusive): chunk seams, tile seams and every kept/solid boundary
// inside tiles alike. `dataAt(cx, cy, cz)` → ChunkData | null; absent chunks
// are skipped (their edges are not part of the window).
//
// opts.gen / opts.worldSeed (a family generator) enable the port checks:
// tile seams are found with tileKeyOf(gen.tile, …) and declared ports with
// gen.ports (west/north of the eastern/southern tile).
//
// Returns {
//   leaks              open edges between a walkable cell and a mass cell (an
//                      isolated mass cell — a free-standing pillar with no
//                      mass neighbour, in a chunk that is not whole solid — is
//                      not counted);
//   seals              walls between walkable cells of different tiles at a
//                      declared port;
//   portViolations     declared port cells on a tile seam that are not
//                      walkable on both sides (e.g. a port facing a
//                      footprint-solid chunk);
//   seeThroughToSolid  see-through wall features (window, rail) on a boundary
//                      with a whole-solid chunk (§9.6);
//   seeThroughThinMass see-through wall features whose straight line of sight
//                      from a walkable side, along the wall normal, crosses
//                      1..BORDER_DEPTH-1 mass cells and then enters a
//                      whole-solid chunk. Whole-solid chunks draw no posts
//                      (§9.6a), so such glass shows a postless hall. (0 mass
//                      cells is seeThroughToSolid.) A plain wall, a non-mass
//                      cell, BORDER_DEPTH mass cells or the box edge end the
//                      line without a count;
//   solidChunks        whole-solid chunks in the box (reported);
//   sealedMass         every mass↔walkable edge is a wall (leaks === 0);
//   massEdges, edges   counters; details { leaks, seals, portViolations,
//                      seeThroughToSolid, seeThroughThinMass } (first 24 of
//                      each) }
export function massLeakAudit(dataAt, box, { gen = null, worldSeed = 0 } = {}) {
  const chunkMemo = new Map()
  const get = (cx, cy, cz) => {
    if (cx < box.x0 || cx > box.x1 || cz < box.z0 || cz > box.z1 || cy < box.y0 || cy > box.y1) return null
    const key = `${cx},${cy},${cz}`
    if (!chunkMemo.has(key)) chunkMemo.set(key, dataAt(cx, cy, cz) ?? null)
    return chunkMemo.get(key)
  }
  const solidMemo = new Map()
  const solid = (d) => {
    let s = solidMemo.get(d)
    if (s === undefined) solidMemo.set(d, (s = isSolidMassChunk(d)))
    return s
  }
  const at = (gx, cy, gz) => {
    const cx = Math.floor(gx / CHUNK)
    const cz = Math.floor(gz / CHUNK)
    const d = get(cx, cy, cz)
    return d ? { d, lx: gx - cx * CHUNK, lz: gz - cz * CHUNK } : null
  }
  // Mass that matters: a mass cell with a mass 4-neighbour, or in a whole-solid chunk.
  const massy = (c, gx, cy, gz) => {
    if (!isMassCell(c.d, c.lx, c.lz)) return false
    if (solid(c.d)) return true
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = at(gx + dx, cy, gz + dz)
      if (n && isMassCell(n.d, n.lx, n.lz)) return true
    }
    return false
  }
  const tileOf = gen
    ? (cx, cy, cz) => tileKeyOf(gen.tile, cx, cy, cz)
    : () => null
  const portMemo = new Map()
  const portsOf = (tx, tz, side, cy) => {
    const key = `${tx},${tz},${side},${cy}`
    let p = portMemo.get(key)
    if (!p) portMemo.set(key, (p = gen.ports(worldSeed >>> 0, { tx, tz }, side, cy) ?? []))
    return p
  }

  const out = {
    leaks: 0,
    seals: 0,
    portViolations: 0,
    seeThroughToSolid: 0,
    seeThroughThinMass: 0,
    solidChunks: 0,
    sealedMass: true,
    massEdges: 0,
    edges: 0,
    details: { leaks: [], seals: [], portViolations: [], seeThroughToSolid: [], seeThroughThinMass: [] },
  }
  const note = (kind, rec) => {
    out[kind]++
    if (out.details[kind].length < DETAIL_CAP) out.details[kind].push(rec)
  }
  // An opaque line between cell (gx, gz) and its neighbour (gx + dx, gz + dz):
  // a plain wall (the same rule as massMask.js). The line belongs to the
  // eastern / southern cell's chunk.
  const opaqueBetween = (gx, cy, gz, dx, dz) => {
    const o = at(dx > 0 || dz > 0 ? gx + dx : gx, cy, dx > 0 || dz > 0 ? gz + dz : gz)
    if (!o) return true
    const i = dx ? vIdx(o.lx, o.lz) : hIdx(o.lx, o.lz)
    const wall = dx ? o.d.wallV[i] : o.d.wallH[i]
    const feature = dx ? o.d.wallFeatureV[i] : o.d.wallFeatureH[i]
    return wall !== 0 && feature === WALL_PLAIN
  }
  // Look from walkable cell (gx, gz) through its see-through wall towards
  // (gx + dx, gz + dz): the number of mass cells crossed before a whole-solid
  // chunk, or -1 when the line ends some other way.
  const thinMassDepth = (gx, cy, gz, dx, dz) => {
    let x = gx + dx
    let z = gz + dz
    for (let n = 0; n < BORDER_DEPTH; n++) {
      const c = at(x, cy, z)
      if (!c) return -1
      if (solid(c.d)) return n
      if (!isMassCell(c.d, c.lx, c.lz)) return -1
      if (opaqueBetween(x, cy, z, dx, dz)) return -1
      x += dx
      z += dz
    }
    return -1
  }

  for (let cy = box.y0; cy <= box.y1; cy++) {
    for (let cz = box.z0; cz <= box.z1; cz++) {
      for (let cx = box.x0; cx <= box.x1; cx++) {
        const d = get(cx, cy, cz)
        if (!d) continue
        if (solid(d)) out.solidChunks++
        for (let lz = 0; lz < CHUNK; lz++) {
          for (let lx = 0; lx < CHUNK; lx++) {
            const gx = cx * CHUNK + lx
            const gz = cz * CHUNK + lz
            const a = { d, lx, lz }
            // East edge (V line gx + 1) and south edge (H line gz + 1).
            for (const axis of ['v', 'h']) {
              const nx = axis === 'v' ? gx + 1 : gx
              const nz = axis === 'v' ? gz : gz + 1
              const b = at(nx, cy, nz)
              if (!b) continue
              out.edges++
              // The owner of the line is the eastern / southern cell's chunk.
              const i = axis === 'v' ? vIdx(b.lx, b.lz) : hIdx(b.lx, b.lz)
              const wall = axis === 'v' ? b.d.wallV[i] : b.d.wallH[i]
              const feature = axis === 'v' ? b.d.wallFeatureV[i] : b.d.wallFeatureH[i]
              const crossChunk = b.d !== d
              const wa = cellWalkable(d, lx, lz)
              const wb = cellWalkable(b.d, b.lx, b.lz)
              if (wa !== wb) {
                const ma = !wa && massy(a, gx, cy, gz)
                const mb = !wb && massy(b, nx, cy, nz)
                if (ma || mb) {
                  out.massEdges++
                  if (!wall) note('leaks', { gx, gz, cy, axis, walkable: wa ? 'west/north' : 'east/south' })
                }
              }
              if (crossChunk && wall && wallFeatureSeesThrough(feature) && (solid(d) || solid(b.d))) {
                note('seeThroughToSolid', { gx: nx, gz: nz, cy, axis })
              }
              if (wall && wallFeatureSeesThrough(feature)) {
                const ddx = axis === 'v' ? 1 : 0
                const ddz = axis === 'v' ? 0 : 1
                // From the west/north side looking east/south, and back.
                const fwd = wa ? thinMassDepth(gx, cy, gz, ddx, ddz) : -1
                const back = wb ? thinMassDepth(nx, cy, nz, -ddx, -ddz) : -1
                if (fwd > 0) note('seeThroughThinMass', { gx: nx, gz: nz, cy, axis, look: axis === 'v' ? 'east' : 'south', mass: fwd })
                if (back > 0) note('seeThroughThinMass', { gx: nx, gz: nz, cy, axis, look: axis === 'v' ? 'west' : 'north', mass: back })
              }
              if (!gen || !crossChunk) continue
              const ka = tileOf(cx, cy, cz)
              const kb = tileOf(b.d.cx, cy, b.d.cz)
              if (!ka || !kb || (ka.tx === kb.tx && ka.tz === kb.tz)) continue
              // A tile seam: is this cell a declared port of the eastern/southern tile?
              const side = axis === 'v' ? 'west' : 'north'
              const along = axis === 'v' ? nz - kb.tz * gen.tile.d * CHUNK : nx - kb.tx * gen.tile.w * CHUNK
              const isPort = portsOf(kb.tx, kb.tz, side, cy).some((p) => along >= p.a0 && along <= p.a1)
              if (!isPort) continue
              if (!wa || !wb) note('portViolations', { gx: nx, gz: nz, cy, side, walkable: [wa, wb] })
              else if (wall) note('seals', { gx: nx, gz: nz, cy, side })
            }
          }
        }
      }
    }
  }
  out.sealedMass = out.leaks === 0
  return out
}
