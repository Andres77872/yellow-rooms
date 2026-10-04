import { CHUNK, WINDOW_SALT } from './constants.js'
import { hash2i, hash3i } from './core/hash.js'
import { edgeContext } from './doorFunction.js'
import { GLASS_CLEAR, GLASS_CRACKED, GLASS_DIRTY, GLASS_FROSTED, GLASS_TAPED } from './glassKinds.js'
import { SPACE_ROLE_BATHROOM, SPACE_ROLE_BEDROOM } from './mapTypes.js'
import { SPACE_HALL, SPACE_ROOM, ZONE_WET, worldSurfaceSet } from './surfaceSet.js'

// Gallery glazing, specified like the rest of the building instead of rolled
// per pane. Every window used to hash its own pane kind and its own glazing
// bars from its global edge, so one continuous screen flipped between cross
// bars, a single mullion and venetian blinds — clear, filthy, frosted, taped
// — from one pane to the next: noise, not a building.
//
// A SCREEN is now the glazing between the same two spaces (a landmark's:
// all of its glazing facing the same way), a RUN its window edges on one
// line. Top down:
//   * the GLAZING SYSTEM (cross bars / single mullion / venetian blinds) is
//     one choice for the whole screen — a landmark's by the structure and
//     what it faces (one system around every elevation and up every
//     storey), else by the pair of spaces it divides. Never by the line's
//     axis: a gallery turning a corner keeps its bars. A room looking onto
//     a gallery usually has its blinds; frosted screens never need them;
//   * PRIVACY is the function of the space behind: a screen into a wet room,
//     bathroom or bedroom is frosted along its whole length, a public
//     gallery never is;
//   * CONDITION follows the wear field of the worse side (surfaceSet.js
//     decayAt): lived-in (< 0.45) panes are clear with a faint even dust,
//     worn (< 0.8) ones dirty, and only derelict wings break glass — in
//     stretches a few panes long (1D value noise along the line), cracked
//     or, where somebody still cared, taped up, one policy per run line;
//   * the anomaly is deliberate and rare: a worn screen braced with tape
//     crosses end to end.
// Per pane only the texture detail varies (crack star, wipe arcs, handprint
// placement, a little grime), from the pane's own global edge hash — axis
// included, so the two panes meeting in a corner never repeat each other.
//
// Seam limitation: an edge on chunk line 0 sees only its in-chunk side (the
// far cell belongs to the neighbour, which mesh time never reads). A
// landmark side still keys the run by its structure, so it agrees with the
// rest of that screen; otherwise the run keys on the in-chunk space plus the
// global line, its facing and privacy come from that side alone, and its
// condition from that side's wear. Every chunk the run spans sees the same
// side, so the run itself stays consistent — but it may not match a
// same-pair screen elsewhere. (Measured worlds put no window on a seam:
// structure stamps keep their glazing chunk-local.)
//
// THREE-free: mesh.js consumes it, tests run it headless.

// pushWindowTrim (objects/joinery/windows.js) reads its `tone` as
// < 0.45 cross, < 0.8 single bar, else venetian blinds.
export const GLAZING_CROSS = 0.2
export const GLAZING_BAR = 0.6
export const GLAZING_BLIND = 0.9

export const GLASS_LIVED_IN = 0.45 // below: clear panes
export const GLASS_DERELICT = 0.8 // at or above: broken stretches allowed
const DAMAGE_PERIOD = 6 // cells per value-noise lattice step along a line
const DAMAGE_LEVEL = 0.65 // noise above this is a broken stretch (~30% of a derelict line)
const TAPED_RUN = 0.35 // derelict runs whose broken panes were taped up
const BRACED_RUN = 0.05 // worn runs taped end to end (the anomaly)

const SALT_RUN = 0x91a2
const SALT_SYSTEM = 0x5b1d
const SALT_DAMAGE = 0xda4a
const SALT_POLICY = 0x7a9e

// Facing of a run: what the gallery side looks into.
const FACE_PUBLIC = 0
const FACE_ROOM = 1
const FACE_PRIVATE = 2

const unit = (h) => h / 4294967296

const isPrivate = (c) =>
  !!c && c.cls === SPACE_ROOM && (c.category === ZONE_WET || c.role === SPACE_ROLE_BATHROOM || c.role === SPACE_ROLE_BEDROOM)

function facingOf(lo, hi) {
  if (isPrivate(lo) || isPrivate(hi)) return FACE_PRIVATE
  if (lo?.cls === SPACE_ROOM || hi?.cls === SPACE_ROOM) return FACE_ROOM
  return FACE_PUBLIC
}

// Stable uint32 key of the screen an edge belongs to (see the header). Only
// the seam key needs the axis: there the global line stands in for the
// unseen side.
function runKey(seed, lo, hi, axis, gline, facing) {
  const hall = lo?.cls === SPACE_HALL ? lo : hi?.cls === SPACE_HALL ? hi : null
  if (hall) return hash3i(seed ^ SALT_RUN, hall.key, facing, 0x4a11)
  if (lo && hi) {
    const a = Math.min(lo.key, hi.key)
    const b = Math.max(lo.key, hi.key)
    return hash3i(seed ^ SALT_RUN, a, b, facing)
  }
  const ax = axis === 'v' ? 1 : 2
  return hash3i(seed ^ SALT_RUN ^ 0x5ea3, (lo ?? hi).key, gline, ax * 4 + facing)
}

// The run's glazing system: the trim tone pushWindowTrim selects bars from.
function systemOf(key, facing) {
  const r = unit(hash2i(key, SALT_SYSTEM, 1))
  if (facing === FACE_PRIVATE) return r < 0.5 ? GLAZING_BAR : GLAZING_CROSS
  if (facing === FACE_ROOM) return r < 0.6 ? GLAZING_BLIND : r < 0.85 ? GLAZING_BAR : GLAZING_CROSS
  return r < 0.55 ? GLAZING_CROSS : r < 0.9 ? GLAZING_BAR : GLAZING_BLIND
}

// 1D value noise in [0, 1], one lattice step per unit of `t`.
function stretchNoise(key, t) {
  const i = Math.floor(t)
  const f = t - i
  const s = f * f * (3 - 2 * f)
  const a = unit(hash2i(key, i, 0x5a))
  const b = unit(hash2i(key, i + 1, 0x5a))
  return a + (b - a) * s
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

// { tone, kind, seed, dirt, run, decay } for the window on edge (axis, line,
// cell) of `data`: `tone` feeds pushWindowTrim, kind / seed / dirt the pane's
// instance colour (glassMaterial.js), `run` the stable run key and `decay`
// the worse side's wear the condition came from. Pure in the chunk's own
// data plus the world seed.
export function windowGlazing(data, axis, line, cell, set = worldSurfaceSet(data.mapFamily, data.worldSeed)) {
  const { lo, hi } = edgeContext(data, axis, line, cell, set)
  const v = axis === 'v'
  const gline = (v ? data.cx : data.cz) * CHUNK + line
  const along = (v ? data.cz : data.cx) * CHUNK + cell
  const facing = facingOf(lo, hi)
  const run = runKey(set.seed, lo, hi, axis, gline, facing)
  const tone = systemOf(run, facing)

  // Per-pane texture detail: crack star / wipe arcs / prints, and a little
  // grime jitter, from the pane's own global edge (cell + axis: a cell's
  // west and north panes are different glass).
  const h = hash3i(WINDOW_SALT ^ 0x6a55, v ? gline : along, v ? along : gline, v ? 1 : 2)
  const seed = ((h >>> 10) & 1023) / 1024
  const jitter = ((h >>> 20) & 1023) / 1024 - 0.5

  const decay = Math.max(lo?.decay ?? 0, hi?.decay ?? 0)
  const worn = clamp01((decay - GLASS_LIVED_IN) / (1 - GLASS_LIVED_IN))
  const grimy = clamp01(0.62 + 0.35 * worn + jitter * 0.1)
  // The line (axis and position) and its storey key the stretches, so a
  // landmark's elevations and storeys do not break in the same columns.
  const lineKey = hash3i(run ^ SALT_DAMAGE, gline * 2 + (v ? 1 : 0), data.cy | 0)
  let kind
  let dirt
  if (facing === FACE_PRIVATE) {
    kind = GLASS_FROSTED
    dirt = clamp01(0.15 + 0.4 * decay + jitter * 0.06)
  } else if (decay < GLASS_LIVED_IN) {
    kind = GLASS_CLEAR
    dirt = clamp01(0.12 + 0.3 * (decay / GLASS_LIVED_IN) + jitter * 0.08)
  } else if (unit(hash2i(lineKey, SALT_POLICY, 2)) < BRACED_RUN) {
    kind = GLASS_TAPED
    dirt = grimy
  } else if (decay >= GLASS_DERELICT && stretchNoise(lineKey, along / DAMAGE_PERIOD) > DAMAGE_LEVEL) {
    kind = unit(hash2i(lineKey, SALT_POLICY, 1)) < TAPED_RUN ? GLASS_TAPED : GLASS_CRACKED
    dirt = grimy
  } else {
    kind = GLASS_DIRTY
    dirt = grimy
  }
  return { tone, kind, seed, dirt, run, decay }
}
