import { cIdx } from '../constants.js'
import { PASSAGE_WALL, PASSAGE_WIDE, CELL_LOBBY, CELL_STAIR, SPACE_ROLE_NONE } from '../mapTypes.js'
import {
  chunkStairs,
  stairHaloRect,
  STAIR_DX,
  STAIR_DZ,
  STAIR_E,
  STAIR_W,
} from './slab.js'

// Stair stamps (v9) — pipeline stage L4.5, after topology repair, before lamps.
//
// The HALO STAMP is connectivity-safe by construction, in every zone: first
// monotone-carve a fully-open 1-cell halo pocket around each stair strip (the
// same proven mechanics as the exit/spawn clearings — it reconnects anything
// the guard walls are about to cut, because any path that previously crossed
// the strip re-routes around it through the halo), THEN place the guard walls
// on the strip boundary, leaving the mouth open into the (connected) halo. No
// re-repair is needed afterwards. In v9 office district plans reserve and route
// this same halo before room allocation; the carve is therefore idempotent for
// office topology and remains the open-zone realization path.
//
// Both contracts (slab above = stairUp, slab below = stairDown) are carved
// FIRST and walled SECOND, so one stamp's carve can never erase the other's
// walls. Office and family-owned slab contracts share the parity scheme and
// land on interior lines [3..11] (see slab.js), so neither path can claim an
// owned border line, neighbour seam, or transition mouth.
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
  if (e.v) data.setProtectedV(e.lx, e.lz, wall, passage)
  else data.setProtectedH(e.lx, e.lz, wall, passage)
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
  const { x0, z0, x1, z1 } = stairHaloRect(contract)
  // Open the halo's interior only. The layout already reaches the halo (the
  // strip cells were part of the connected chunk), so the ring edges it
  // reached them through stay open and the rest of the ring keeps the walls
  // of the rooms around it — opening the ring too would cut each neighbour's
  // bordering side down to dangling blade ends.
  data.carveRect(x0, z0, x1, z1, { ring: false })
  // Office plans reserve this exact rect before room allocation. Open zones do
  // not have a macro plan, so applying the same semantic label here keeps
  // lighting/debug/gameplay consumers aligned with the carved geometry. Any
  // role byte on a relabelled cell dies with it — the halo is circulation,
  // and SPACE_ROLE_* may only ride CELL_ROOM.
  for (let z = z0; z <= z1; z++) {
    for (let x = x0; x <= x1; x++) {
      data.cellKind[cIdx(x, z)] = CELL_LOBBY
      data.spaceRole[cIdx(x, z)] = SPACE_ROLE_NONE
    }
  }
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

// Shared descriptor-stamping primitive. Carve every participating halo before
// placing either half so overlapping family-owned clearings cannot erase a
// guard written by the other half. Existing office slab contracts and bounded
// family risers therefore use exactly the same raster/protection semantics.
export function stampStairDescriptors(data, { up = null, down = null }) {
  if (up) carveHalo(data, up)
  if (down) carveHalo(data, down)
  if (up) stampLower(data, up)
  if (down) stampUpper(data, down)
}

// Project the canonical structure's floor-ordered vertical links onto this
// chunk slice without inventing another link representation. Each side reuses
// the exact existing stair descriptor nested on the canonical structure.
export function stampStructureVerticalLinks(data, structure) {
  const linkAt = (lowerCy) => structure?.verticalLinks?.find(
    (link) =>
      link.lowerCy === lowerCy &&
      link.cx === data.cx &&
      link.cz === data.cz
  )?.stair ?? null
  stampStairDescriptors(data, {
    up: linkAt(data.cy),
    down: linkAt(data.cy - 1),
  })
}

export function stampStairs(data, seed, cx, cy, cz, config) {
  const contracts = chunkStairs(seed, cx, cz, cy, config)
  stampStairDescriptors(data, {
    up: contracts.up.hasStair ? contracts.up : null,
    down: contracts.down.hasStair ? contracts.down : null,
  })
}
