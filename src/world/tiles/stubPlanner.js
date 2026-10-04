// The stub world's pure half (spec §3.1, §12.0): the planner every liminal
// family re-exports from its structures.js until its agent writes a real one,
// and the stub tile geometry its geometry.js re-exports.
//
// LEAF MODULE: no imports. It sits on the §7.5 planner-chain allowlist
// (contract.js → families/planners.js → <id>/structures.js → <id>/geometry.js
// may import it), so it must never import anything that could reach
// ChunkData, the tile canvas, the stub generator (tiles/stub.js) or
// generate.js. Everything here is a pure function of its arguments.

const EMPTY = Object.freeze([])

// §7.2 planner contract, stub world: no structures anywhere.
//   structuresInTile(worldSeed, k, profile, config) → frozen, slot-sorted list
//   structureAt(worldSeed, cx, cz, cy, profile, config) → descriptor | null
//   verticalOpeningAt(worldSeed, cx, cz, lowerCy, profile, config) → boolean
export const STUB_PLANNER = Object.freeze({
  stub: true,
  structuresInTile() {
    return EMPTY
  },
  structureAt() {
    return null
  },
  verticalOpeningAt() {
    return false
  },
})

export default STUB_PLANNER

// --- stub tile geometry (§12.0) ------------------------------------------------
//
// Backend 'band', one 1×1-chunk tile per chunk, storey 0 only:
// TILE {w:1, d:1, H:1, lo:0, hi:0}. Every other storey is solid (tileKeyOf
// returns null outside [lo, hi], and footprint() says 'solid'). Each tile is a
// room over cells 1..12 × 1..12 with ports on rows/columns 6..7 of all four
// sides, so storey 0 is an endless grid of connected rooms.

// Port range on every side, tile-local along-cells, INCLUSIVE (a0..a1).
export const STUB_PORT_A0 = 6
export const STUB_PORT_A1 = 7
const STUB_PORTS = Object.freeze([Object.freeze({ a0: STUB_PORT_A0, a1: STUB_PORT_A1 })])

// Exit anchor of the stub world: chunk (6, 0) on storey 0, cell (6, 6).
export const STUB_EXIT_ANCHOR = Object.freeze({ cx: 6, cy: 0, cz: 0, lx: 6, lz: 6 })

// The four geometry exports of a stub family (§3.3 geometry.js, §6.5):
//   TILE       {w, d, backend, H, lo, hi, salt}
//   footprint  (worldSeed, cx, cy, cz, profile) → 'tile' | 'solid'   (pure, no bake)
//   ports      (worldSeed, {tx, tz}, side, cy) → [{a0, a1}]  side 'west'|'north';
//              pure and band-independent (the east view of tile tx is
//              ports(seed, {tx: tx + 1, tz}, 'west', cy))
//   exitAnchor (worldSeed, profile) → {cx, cy, cz, lx, lz}   (pure)
// `salt` is the family's tile salt (FAMILY_SALT[id] = 0x5a170000 + code, §6.2).
export function stubGeometry(salt = 0) {
  const TILE = Object.freeze({ w: 1, d: 1, backend: 'band', H: 1, lo: 0, hi: 0, salt: salt >>> 0 })
  return Object.freeze({
    TILE,
    footprint(worldSeed, cx, cy) {
      return cy === 0 ? 'tile' : 'solid'
    },
    ports(worldSeed, k, side, cy) {
      return cy === 0 ? STUB_PORTS : EMPTY
    },
    exitAnchor() {
      return STUB_EXIT_ANCHOR
    },
  })
}
