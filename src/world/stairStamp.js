import { cIdx, CHUNK } from './constants.js'
import { PASSAGE_WALL, PASSAGE_WIDE, CELL_STAIR } from './mapTypes.js'
import { chunkStairs, stairStrip, STAIR_DX, STAIR_DZ, STAIR_E, STAIR_W } from './slab.js'

// Stair stamps (v8) — pipeline stage L4.5, after topology repair, before lamps.
//
// The HALO STAMP is connectivity-safe by construction, in every zone: first
// monotone-carve a fully-open 1-cell halo pocket around each stair strip (the
// same proven mechanics as the exit/spawn clearings — it reconnects anything
// the guard walls are about to cut, because any path that previously crossed
// the strip re-routes around it through the halo), THEN place the guard walls
// on the strip boundary, leaving the mouth open into the (connected) halo. No
// re-repair is needed afterwards, and office district plans stay unmutated
// pre-slice — this is the same class of post-slice edit as the accepted exit
// and spawn clearings; it reads in-game as a stair lobby.
//
// Both contracts (slab above = stairUp, slab below = stairDown) are carved
// FIRST and walled SECOND, so one stamp's carve can never erase the other's
// walls. Their cell/edge sets are disjoint by the slab parity scheme, and all
// stamped edges land on interior lines [3..11] — never on owned border lines,
// neighbour seams, or transition mouths (see slab.js).
//
// Lower half (up contract), dir = ascent:      Upper half (down contract):
//   ═════════════   flanks: landing+runs         ═══════   flanks: holes only
//   M  L  R0 R1 ‖W                             ══╗ H0 H1  (descend edge open)
//   ═════════════   W = far-end wall              ═══════   ╗ = back wall
// The lower-layer cell past W (under the upper exit) is ordinary open floor —
// the space under the upper landing; solid slab above it.

const horizontal = (dir) => dir === STAIR_E || dir === STAIR_W

// The wall line between two cells adjacent along the strip axis.
function edgeBetween(a, b, horiz) {
  return horiz
    ? { v: true, lx: Math.max(a.lx, b.lx), lz: a.lz }
    : { v: false, lx: a.lx, lz: Math.max(a.lz, b.lz) }
}

function setEdge(data, e, wall, passage) {
  if (e.v) {
    data.setV(e.lx, e.lz, wall, passage)
    data.protectV(e.lx, e.lz)
  } else {
    data.setH(e.lx, e.lz, wall, passage)
    data.protectH(e.lx, e.lz)
  }
}

// Both flank edges of a strip cell (perpendicular to the ascent axis).
function flankEdges(cell, horiz) {
  return horiz
    ? [
        { v: false, lx: cell.lx, lz: cell.lz },
        { v: false, lx: cell.lx, lz: cell.lz + 1 },
      ]
    : [
        { v: true, lx: cell.lx, lz: cell.lz },
        { v: true, lx: cell.lx + 1, lz: cell.lz },
      ]
}

function carveHalo(data, contract) {
  const cells = stairStrip(contract)
  let x0 = CHUNK, z0 = CHUNK, x1 = -1, z1 = -1
  for (const c of cells) {
    x0 = Math.min(x0, c.lx)
    z0 = Math.min(z0, c.lz)
    x1 = Math.max(x1, c.lx)
    z1 = Math.max(z1, c.lz)
  }
  data.carveRect(x0 - 1, z0 - 1, x1 + 1, z1 + 1)
}

// Lower half: landing + ramp under this chunk's ceiling holes.
function stampLower(data, c) {
  const horiz = horizontal(c.dir)
  const walk = [c.landing, c.run[0], c.run[1]]
  for (const cell of walk) {
    for (const e of flankEdges(cell, horiz)) setEdge(data, e, 1, PASSAGE_WALL)
    data.cellKind[cIdx(cell.lx, cell.lz)] = CELL_STAIR
  }
  // Far-end wall between the ramp top and the ordinary floor under the exit.
  setEdge(data, edgeBetween(c.run[1], c.exit, horiz), 1, PASSAGE_WALL)
  // Mouth: the landing's outer edge stays open into the halo.
  const outer = { lx: c.landing.lx - STAIR_DX[c.dir], lz: c.landing.lz - STAIR_DZ[c.dir] }
  setEdge(data, edgeBetween(outer, c.landing, horiz), 0, PASSAGE_WIDE)
  data.stairUp = { dir: c.dir, landing: { ...c.landing }, run: [{ ...c.run[0] }, { ...c.run[1] }], exit: { ...c.exit } }
}

// Upper half: floor holes + exit landing of the stair coming up from below.
function stampUpper(data, c) {
  const horiz = horizontal(c.dir)
  for (const cell of c.run) {
    for (const e of flankEdges(cell, horiz)) setEdge(data, e, 1, PASSAGE_WALL)
    data.cellKind[cIdx(cell.lx, cell.lz)] = CELL_STAIR
  }
  // Back wall between the ordinary floor above the lower landing and the hole.
  setEdge(data, edgeBetween(c.landing, c.run[0], horiz), 1, PASSAGE_WALL)
  // Descend edge: hole -> exit cell stays open (the way onto the stair).
  setEdge(data, edgeBetween(c.run[1], c.exit, horiz), 0, PASSAGE_WIDE)
  data.stairDown = { dir: c.dir, landing: { ...c.landing }, run: [{ ...c.run[0] }, { ...c.run[1] }], exit: { ...c.exit } }
}

export function stampStairs(data, seed, cx, cy, cz, config) {
  const { up, down } = chunkStairs(seed, cx, cz, cy, config)
  if (up.hasStair) carveHalo(data, up)
  if (down.hasStair) carveHalo(data, down)
  if (up.hasStair) stampLower(data, up)
  if (down.hasStair) stampUpper(data, down)
}
