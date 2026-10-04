import { fmix32, hash2i, hash3i } from '../core/hash.js'
import { RNG } from '../core/rng.js'

// Tile keys, seeds and ids of the liminal families (spec §6.2).
//
// PLANNER-CHAIN MODULE (§7.5): contract.js → families/planners.js →
// <id>/structures.js → <id>/geometry.js may import this file, so it imports
// ONLY constants.js, core/hash.js and core/rng.js (import-boundary.test).
// Everything here is a pure function of its arguments.
//
// TILE = { w, d, backend: 'storey'|'band', H = 1, lo = -Infinity,
//          hi = Infinity, phase?: (tx, tz) => int, rows?: int[], salt }
//
// A tile key is { tx, tz, band, origin: {cx, cy, cz}, cy0, cy1 }: the tile's
// chunk window is cx ∈ [tx·w, tx·w + w − 1], cz ∈ [tz·d, tz·d + d − 1], its
// storeys are [cy0, cy1] (GLOBAL), and `origin` is the kind-local (0, 0, 0)
// of the tile program (origin.cy = the band's first storey, before clamping).

export const floorDiv = (a, b) => Math.floor(a / b)

// TILE with its defaults applied: { H, lo, hi } (H = 1, lo = −∞, hi = ∞),
// and `anchor`, the storey band 0 starts from (lo when finite, else 0).
// Throws on a malformed TILE (H not a positive integer, lo/hi not numbers or
// lo > hi) so a family agent gets a clear error instead of NaN keys and a
// silently all-solid family.
export function tileShape(tile) {
  const H = tile.H ?? 1
  const lo = tile.lo ?? -Infinity
  const hi = tile.hi ?? Infinity
  if (!Number.isInteger(H) || H < 1) throw new Error(`tileKey: TILE.H must be a positive integer (got ${tile.H})`)
  if (typeof lo !== 'number' || Number.isNaN(lo) || typeof hi !== 'number' || Number.isNaN(hi) || lo > hi) {
    throw new Error(`tileKey: TILE.lo/hi must be numbers with lo <= hi (got ${tile.lo}, ${tile.hi})`)
  }
  return { H, lo, hi, anchor: Number.isFinite(lo) ? lo : 0 }
}

// The key of the tile owning chunk (cx, cy, cz), or null when the chunk lies
// outside the family's storeys [lo, hi] or outside its tile rows.
//   backend 'storey': one bake per (tx, tz, cy), band = cy.
//   backend 'band':   one bake per (tx, tz, band) covering H storeys,
//                     band = floor((cy − lo − phase(tx, tz)) / H).
export function tileKeyOf(tile, cx, cy, cz) {
  const { H, lo, hi, anchor } = tileShape(tile)
  if (cy < lo || cy > hi) return null
  const tx = floorDiv(cx, tile.w)
  const tz = floorDiv(cz, tile.d)
  if (tile.rows && !tile.rows.includes(tz)) return null
  if (tile.backend === 'storey') {
    return { tx, tz, band: cy, origin: { cx: tx * tile.w, cy, cz: tz * tile.d }, cy0: cy, cy1: cy }
  }
  const phase = tile.phase ? tile.phase(tx, tz) : 0
  const band = floorDiv(cy - anchor - phase, H)
  const cy0 = anchor + phase + band * H
  return {
    tx,
    tz,
    band,
    origin: { cx: tx * tile.w, cy: cy0, cz: tz * tile.d },
    cy0: Math.max(cy0, lo),
    cy1: Math.min(cy0 + H - 1, hi),
  }
}

// The full key of tile (tx, tz, band) — the inverse of tileKeyOf for a key
// given only by its {tx, tz, band} (bakeExitsAt, harness windows). Null when
// the tile has no storey inside [lo, hi] or lies outside the tile rows.
export function tileKeyAt(tile, tx, tz, band) {
  const { H, lo, hi, anchor } = tileShape(tile)
  if (tile.rows && !tile.rows.includes(tz)) return null
  if (tile.backend === 'storey') return tileKeyOf(tile, tx * tile.w, band, tz * tile.d)
  const phase = tile.phase ? tile.phase(tx, tz) : 0
  const cy0 = anchor + phase + band * H
  const first = Math.max(cy0, lo)
  const last = Math.min(cy0 + H - 1, hi)
  if (!(first <= last)) return null
  return tileKeyOf(tile, tx * tile.w, first, tz * tile.d)
}

// The tile window of key k in GLOBAL chunks: { cx0, cz0, cx1, cz1 }.
export const tileWindow = (tile, k) => ({
  cx0: k.tx * tile.w,
  cz0: k.tz * tile.d,
  cx1: k.tx * tile.w + tile.w - 1,
  cz1: k.tz * tile.d + tile.d - 1,
})

// Mirror-free coordinate hash (P-fix): one hash2i link per value, so it is
// injective in each value and has no point symmetry. hash2i(s, x, z),
// hash3i(s, x, 0, z) and tileSeed all satisfy f(−x, −z) === f(x, z) for a
// sizeable share of (s, x, z) (≈13% for hash2i/hash3i, ≈6% for tileSeed's
// mirror tile pairs), which repeats layouts at mirrored tiles/districts.
// Use hashChain(seed, a, b, …) for any roll keyed by GLOBAL coordinates
// (tx, tz, dx, dz, cx, cz, band, cy); e.g. a per-tile variety seed that
// also breaks tileSeed's mirror ties: hashChain(planSeed, k.tx, k.tz, k.band).
// Pure; returns a uint32. Planner-chain safe (lives in tileKey.js).
export function hashChain(seed, ...values) {
  let h = seed | 0
  for (let i = 0; i < values.length; i++) h = hash2i(h, values[i] | 0, 0x2f6b + i) | 0
  return h >>> 0
}

// Per-tile seed. Bakes use it as the FIXED plan seed (attempt 0) and derive
// per-attempt seeds from it; nothing that must agree across tiles reads it.
export const tileSeed = (worldSeed, salt, k) => hash3i((worldSeed ^ salt) | 0, k.tx, k.band, k.tz) >>> 0

// Space ids: [1, 0x7fffffff]. Structure ids: [0x80000000, 0xffffffff].
// Disjoint by construction.
//
// A tile program writes LOCAL space ids in [1, LOCAL_SPACE_MASK]; the bake
// remaps them to spaceIdOf(k, local). spaceSlot is unique among the tiles of
// any 32×32-tile window and both band parities, so neighbouring tiles (and
// the bands above and below) never share a space id.
export const LOCAL_SPACE_MASK = 0xfffff
export const spaceSlot = (k) => (k.tx & 31) | ((k.tz & 31) << 5) | ((k.band & 1) << 10) // 0..2047
export const spaceIdOf = (k, local) => spaceSlot(k) * 0x100000 + local // local ∈ [1, 0xfffff]
export const STRUCTURE_ID_BIT = 0x80000000

// FAMILY_SALT[id] = 0x5a170000 + MAP_FAMILY_CODES[id] (codes 5..16, I4).
// Literal: this module may not import mapFamily.js or families/ids.js
// (§7.5); backend.test pins it against MAP_FAMILY_CODES.
export const FAMILY_SALT = Object.freeze({
  stairwell: 0x5a170000 + 5,
  nightlot: 0x5a170000 + 6,
  showroom: 0x5a170000 + 7,
  poolrooms: 0x5a170000 + 8,
  babel: 0x5a170000 + 9,
  suburb: 0x5a170000 + 10,
  terminal: 0x5a170000 + 11,
  theater: 0x5a170000 + 12,
  playplace: 0x5a170000 + 13,
  train: 0x5a170000 + 14,
  house: 0x5a170000 + 15,
  funhouse: 0x5a170000 + 16,
})

const saltOf = (family) => {
  const salt = Object.hasOwn(FAMILY_SALT, family) ? FAMILY_SALT[family] : undefined
  if (salt === undefined) throw new Error(`tileKey: no FAMILY_SALT for family ${family}`)
  return salt
}

// The structure id of volume `slot` in tile k: bit 31 always set, so it can
// never collide with a remapped space id. Pure in (worldSeed, family, k, slot).
//
// UNIQUE BY CONSTRUCTION (P-fix; the spec §6.2 one-line hash collided: about
// 17% of ids over an 81×81-tile, 3-band, 4-slot window, many of them mirror
// pairs (tx, tz) / (−tx, −tz)). The low 19 bits are a bijection
// of (tx mod 32, tz mod 32, band mod 8, slot mod 64), so ids never repeat
// within any 32×32-tile, 8-band, 64-slot window — the harness's 9×9 window
// and any streaming radius sit well inside it. The top 12 bits hash the
// coarse cell (tx >> 5, tz >> 5, band >> 3, slot >> 6) with the seed and the
// family salt; the low field is keyed by the same hash, so ids vary per seed
// and family, and two coarse cells whose top bits agree share only a sliver
// of their ids instead of the whole block.
const ID_LOW_BITS = 19
const ID_LOW_MASK = (1 << ID_LOW_BITS) - 1
// A bijection of [0, 2^19): odd multiplies and xor-shifts, all mod 2^19.
const mixLow = (v) => {
  v = Math.imul(v, 0x2c1b3c6d) & ID_LOW_MASK
  v ^= v >>> 9
  v = Math.imul(v, 0x297a2d39) & ID_LOW_MASK
  v ^= v >>> 10
  return v
}
export const structureId = (worldSeed, family, k, slot) => {
  const fs = (worldSeed ^ saltOf(family)) | 0
  const s = slot | 0
  const low = (k.tx & 31) | ((k.tz & 31) << 5) | ((k.band & 7) << 10) | ((s & 63) << 13)
  // Chained hash2i, one coordinate per link: each link is injective in its
  // coordinate, and the chain has no hash3i mirror (hash3i(s, x, y, z) ==
  // hash3i(s, −x, y, −z) for about 6% of (s, x, z), e.g. s even, x, z odd).
  let h = hash2i(fs, s >> 6, 0x51)
  h = hash2i(h | 0, k.tx >> 5, 0x5a)
  h = hash2i(h | 0, k.tz >> 5, 0x5b)
  h = hash2i(h | 0, k.band >> 3, 0x5c)
  const key = fmix32(h ^ 0x1d51) & ID_LOW_MASK
  const high = h >>> (32 - (31 - ID_LOW_BITS))
  return (STRUCTURE_ID_BIT | (high << ID_LOW_BITS) | mixLow(low ^ key)) >>> 0
}

// The planner's pick function for volume `slot`, attempt `attempt`: pick(n)
// → an integer in [0, n). Pure in (seed, slot, attempt).
export const planPick = (seed, slot, attempt) => {
  const r = RNG.fromHash(hash3i(seed | 0, slot, attempt))
  return (n) => Math.floor(r.next() * n)
}

// The tile cache key: family, world seed, config signature and tile.
export const keyString = (family, seed, sig, k) => `${family}|${seed >>> 0}|${sig}|${k.tx},${k.tz},${k.band}`
