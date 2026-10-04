import { hash2f, hash3f, hash3i } from './core/hash.js'
import {
  CELL,
  CHUNK,
  LAMP_FLICKER_AMP,
  LAMP_BAD_CHANCE,
  LAMP_BAD_LO,
  LAMP_BAD_RATE,
  LAMP_SAFE_BAD_LO,
  LAMP_SAFE_BAD_RATE,
  LAMP_SAFE_DIP,
  LAMP_SAFE_HUM_SCALE,
  LAMP_TINT_VAR,
} from './constants.js'
import {
  SPACE_ROLE_ARCHIVE,
  SPACE_ROLE_BATHROOM,
  SPACE_ROLE_BEDROOM,
  SPACE_ROLE_BREAK,
  SPACE_ROLE_COPY,
  SPACE_ROLE_DINING,
  SPACE_ROLE_KITCHEN,
  SPACE_ROLE_LAUNDRY,
  SPACE_ROLE_LIBRARY,
  SPACE_ROLE_LIVING,
  SPACE_ROLE_LOUNGE,
  SPACE_ROLE_MEETING,
  SPACE_ROLE_OFFICE,
  SPACE_ROLE_SERVER,
  SPACE_ROLE_STORAGE,
} from './mapTypes.js'
import { SPACE_ROOM, decayAt, spaceAt, worldSurfaceSet } from './surfaceSet.js'

// Per-fixture fluorescent identity, a pure function of the lamp's world
// position (cell-quantised, so float noise never reseats a fixture). Shared by
// the emissive panel meshes (instanceColor at chunk build) and the cast-light
// uniforms (LightField each frame), which is what keeps a fixture's glow, its
// floor pool and its volumetric shaft agreeing with each other.
//
// The old system moved every lamp in the world in lockstep off one global
// uniform — a screen-wide pulse no real building makes. Now each tube breathes
// on its own phase, drifts a little off the standard tube colour with age, and
// a rare one is a BAD tube: dim, strobing, and visibly browned at the fixture
// (the emissive tint is darkened to match, see mesh.js).
//
// Which tubes go bad is not uniform noise either: a dying tube is a symptom
// of the building around it (lampWear). The decision is made once per
// fixture at chunk build (lampIsBad) and travels with it — the panel tint,
// the lamp's `bad` tag for LightField and the light grid's flicker byte (the
// GPU twin) all read that one answer.

const SALT_BAD = 0xbad1
const SALT_PHASE = 0xf11c
const SALT_SPEED = 0x5eed
const SALT_BUZZ = 0xbb22
const SALT_TINT = 0x71e7

// Position key: cell coordinates + layer. Lamps sit at exact cell centres
// (x.5 multiples), so floor() is wobble-stable where round() would sit on its
// own .5 flip boundary.
const kx = (wx) => Math.floor(wx / CELL)
const kz = (wz) => Math.floor(wz / CELL)

// The tube's own die. Compared against the failure odds: with the flat
// LAMP_BAD_CHANCE and no world (debug rooms, tools, older callers) it is
// exactly the old position-only lottery. In a world the die is salted with
// the world seed, so a new world does not hang its bad tubes on the same
// cells around spawn as the last one.
const badRoll = (seed, x, z, layer) => hash3f(SALT_BAD ^ seed, x, z, layer)

export function isBadTube(wx, wz, cy, chance = LAMP_BAD_CHANCE) {
  return badRoll(0, kx(wx), kz(wz), cy | 0) < chance
}

// Failure odds follow the wear of the space the fixture lights — the same
// smooth decay field that ages its floor and walls (surfaceSet decayAt) — so
// a derelict wing buzzes and browns while a kept-up one is nearly steady.
// Tubes also fail together: each fixture hangs on a CIRCUIT (one per room,
// per ~24 m run of corridor or hall), and a failing ballast lifts the odds of
// every tube on it, so a bad room has several bad tubes, not a lone one per
// sweep. Ballasts fail where the building does: each circuit draws one
// endurance, and its ballast gives out where the wear passes it — a rare
// failing room in a kept-up wing, most rooms of a derelict one (a circuit
// that straddles a wear gradient fails from its worn end). Each tube still
// rolls its own die against those odds: some tubes in a failing room hold,
// and the odd tube in a kept-up office still buzzes — the deliberate anomaly.
const SALT_BALLAST = 0xba11
const SALT_CIRCUIT = 0xc1c0
// Wear -> per-tube odds multiplier, and wear -> share of failing ballasts,
// both piecewise linear in decay. Together (x4 on a failing ballast, x0.55 on
// a sound one) the mean odds run about x0.4 with no wear, x1.2 where the
// worn band starts (0.45), x4 where the derelict one does (0.8). Most lit
// fixtures of a world hang in lived-in space, so weighted by where tubes
// actually are it averages about 1: LAMP_BAD_CHANCE keeps meaning the
// world-wide share of bad tubes, now gathered where the building is failing.
const WEAR_ODDS = [
  [0, 0.55],
  [0.45, 1.1],
  [0.8, 1.7],
  [1, 2],
]
const BALLAST_FAIL = [
  [0, 0.06],
  [0.45, 0.15],
  [0.8, 0.55],
  [1, 0.7],
]
const BALLAST_HOT = 4 // odds multiplier for every tube on a failing ballast
const BALLAST_OK = 0.55 // ... and on a sound one
const CIRCUIT_CELLS = 8 // corridor / hall circuit run, in cells (24 m)
const BAD_MAX = 0.85 // even the worst circuit keeps a working tube or two

function curve(knots, x) {
  let i = 1
  while (i < knots.length - 1 && x > knots[i][0]) i++
  const [x0, y0] = knots[i - 1]
  const [x1, y1] = knots[i]
  const t = Math.min(1, Math.max(0, (x - x0) / (x1 - x0)))
  return y0 + (y1 - y0) * t
}

export const wearOdds = (decay) => curve(WEAR_ODDS, decay)
export const ballastFailShare = (decay) => curve(BALLAST_FAIL, decay)

// The circuit of the fixture over chunk cell (lx, lz): a room is one circuit;
// corridors and halls (one space key per corridor or volume) are cut into
// CIRCUIT_CELLS blocks on the global grid. Keyed on stable ids only, so every
// chunk a room or a run spans agrees.
export function lampCircuit(data, lx, lz, space = spaceAt(data, lx, lz)) {
  if (space.cls === SPACE_ROOM) return space.key
  const gx = data.cx * CHUNK + lx
  const gz = data.cz * CHUNK + lz
  const bx = Math.floor(gx / CIRCUIT_CELLS)
  const bz = Math.floor(gz / CIRCUIT_CELLS)
  return hash3i(SALT_CIRCUIT ^ space.key, bx, bz, data.cy | 0)
}

// Wear and circuit of the tube over chunk cell (lx, lz): { decay, circuit,
// failing (its ballast), odds (that the tube is bad) }. A pure function of
// the chunk's own ChunkData plus the world seed/family (never a neighbour),
// so the answer is the same however the world streams in.
export function lampWear(data, lx, lz, set = worldSurfaceSet(data.mapFamily, data.worldSeed)) {
  const space = spaceAt(data, lx, lz)
  const cy = data.cy | 0
  const decay = decayAt(set, data.cx * CHUNK + lx, data.cz * CHUNK + lz, cy, space)
  const circuit = lampCircuit(data, lx, lz, space)
  const failing = hash2f(SALT_BALLAST ^ set.seed, circuit, cy) < ballastFailShare(decay)
  const odds = Math.min(BAD_MAX, LAMP_BAD_CHANCE * wearOdds(decay) * (failing ? BALLAST_HOT : BALLAST_OK))
  return { decay, circuit, failing, odds }
}

export function tubeFailChance(data, lx, lz, set) {
  return lampWear(data, lx, lz, set).odds
}

// Is the tube over chunk cell (lx, lz) bad? The world's die at the fixture's
// global cell, against the space's odds.
export function lampIsBad(data, lx, lz, set = worldSurfaceSet(data.mapFamily, data.worldSeed)) {
  const roll = badRoll(set.seed, data.cx * CHUNK + lx, data.cz * CHUNK + lz, data.cy | 0)
  return roll < lampWear(data, lx, lz, set).odds
}

// How hard the lights may flicker. FULL is the authored look: bad tubes buzz
// at ~9 Hz between 20% and 100%, and the whole ceiling dips to 40% on a
// dead-tube event. SAFE (Settings 'reduceFlicker', the default) keeps every
// source under the WCAG 2.3.1 flash limits — see LAMP_SAFE_* in constants.js.
// badRate/badLo drive lampFlicker and the GPU twin (grid.js gFlicker, via the
// uBadStrobe uniform); humScale/dip drive tubeHum.
export const FLICKER_FULL = Object.freeze({
  badRate: LAMP_BAD_RATE,
  badLo: LAMP_BAD_LO,
  humScale: 1,
  dip: 0.4,
})
export const FLICKER_SAFE = Object.freeze({
  badRate: LAMP_SAFE_BAD_RATE,
  badLo: LAMP_SAFE_BAD_LO,
  humScale: LAMP_SAFE_HUM_SCALE,
  dip: LAMP_SAFE_DIP,
})
export const flickerProfile = (reduce) => (reduce ? FLICKER_SAFE : FLICKER_FULL)

// Cast-light brightness multiplier for this fixture at time t (seconds).
// Healthy tubes: a slow individual breathing ripple that only ever DIPS from
// full. Bad tubes: a stepped erratic buzz, biased toward the dim floor. The
// profile defaults to SAFE so a caller that forgets it cannot strobe. `bad`
// is the fixture's build-time answer (lampIsBad, the lamp's `bad` tag);
// without one the flat position-only lottery decides.
export function lampFlicker(wx, wz, cy, t, profile = FLICKER_SAFE, bad = isBadTube(wx, wz, cy)) {
  const x = kx(wx)
  const z = kz(wz)
  const layer = cy | 0
  if (bad) {
    const lo = profile.badLo
    const step = Math.floor(t * profile.badRate)
    const n = hash3f(SALT_BUZZ ^ (step | 0), x, z, layer)
    return lo + (1 - lo) * n * n
  }
  const phase = hash3f(SALT_PHASE, x, z, layer) * Math.PI * 2
  const speed = 13 + hash3f(SALT_SPEED, x, z, layer) * 11 // 13..24 rad/s, per tube
  return 1 - LAMP_FLICKER_AMP * (0.5 + 0.5 * Math.sin(t * speed + phase))
}

// The hum every lit panel shares (Engine._updateFlicker): a gentle ~2.9 Hz
// ripple plus a faint ~6.8 Hz buzz around 0.92, times the dead-tube dip while
// one runs. It is the tubes' emissive level and, as 0.6 + 0.4 * hum, the cast
// light's. FULL swings 0.85..0.99 and dips to 40%; SAFE halves the ripple
// (under a 10% swing) and turns the dip into an 8% sag.
export function tubeHum(t, dipping, profile = FLICKER_SAFE) {
  const f = 0.92 + (Math.sin(t * 18) * 0.05 + Math.sin(t * 43) * 0.02) * profile.humScale
  return dipping ? f * profile.dip : f
}

// Semantic room roles finally reach the lighting rhythm (the "natural next
// slice" the design review left open): a server room hums cool and green, a
// break room reads warmer than the corridor outside it, storage sits dimmer.
// Multipliers stay subtle — the mood register shifts, the family palette wins.
const ROLE_LIGHT = Object.freeze({
  [SPACE_ROLE_MEETING]: [1.05, 1.03, 0.98],
  [SPACE_ROLE_BREAK]: [1.08, 0.98, 0.86],
  [SPACE_ROLE_COPY]: [1.02, 1.0, 0.96],
  [SPACE_ROLE_ARCHIVE]: [0.94, 0.9, 0.82],
  [SPACE_ROLE_SERVER]: [0.85, 1.03, 1.14],
  [SPACE_ROLE_STORAGE]: [0.8, 0.78, 0.72],
  // v22 catalog roles: a library sits warm and low like a reading lamp, a
  // private office keeps a neutral task register, a lounge leans amber.
  [SPACE_ROLE_LIBRARY]: [0.98, 0.92, 0.8],
  [SPACE_ROLE_OFFICE]: [1.02, 1.01, 0.97],
  [SPACE_ROLE_LOUNGE]: [1.06, 0.96, 0.88],
  // Residential roles (hotel family): bedrooms glow like bedside lamps,
  // bathrooms go clinical cold porcelain, the kitchen keeps a bright task
  // register, living/dining sit in warm evening light, laundry hums neutral.
  [SPACE_ROLE_BEDROOM]: [1.06, 0.93, 0.8],
  [SPACE_ROLE_BATHROOM]: [0.94, 1.02, 1.1],
  [SPACE_ROLE_KITCHEN]: [1.08, 1.04, 0.94],
  [SPACE_ROLE_LIVING]: [1.05, 0.97, 0.87],
  [SPACE_ROLE_DINING]: [1.02, 0.93, 0.82],
  [SPACE_ROLE_LAUNDRY]: [0.94, 0.97, 1.02],
})

// Colour-temperature drift as a per-channel multiplier around 1 (applied on
// top of the shared warm PANEL_COLOR). Green/blue vary more than red, which is
// how real ageing fluorescents drift (greener, or pinker when the phosphor
// thins). Kept deliberately small so the mono-amber mood survives.
export function lampTint(wx, wz, cy, out, role = 0) {
  const x = kx(wx)
  const z = kz(wz)
  const layer = cy | 0
  out[0] = 1 + (hash3f(SALT_TINT ^ 0x11, x, z, layer) * 2 - 1) * LAMP_TINT_VAR * 0.6
  out[1] = 1 + (hash3f(SALT_TINT ^ 0x22, x, z, layer) * 2 - 1) * LAMP_TINT_VAR
  out[2] = 1 + (hash3f(SALT_TINT ^ 0x33, x, z, layer) * 2 - 1) * LAMP_TINT_VAR * 1.4
  const m = ROLE_LIGHT[role]
  if (m) {
    out[0] *= m[0]
    out[1] *= m[1]
    out[2] *= m[2]
  }
  return out
}

// Emissive-panel tint: the tube's colour drift, plus a hard dim+brown for bad
// tubes so the fixture LOOKS dying even while the mesh flicker stays global.
// `bad` as in lampFlicker: pass the fixture's lampIsBad answer.
export function lampPanelTint(wx, wz, cy, out, role = 0, bad = isBadTube(wx, wz, cy)) {
  lampTint(wx, wz, cy, out, role)
  if (bad) {
    out[0] *= 0.42
    out[1] *= 0.36
    out[2] *= 0.3
  }
  return out
}

// Authored per-lamp colour: the lamp record's optional `tint` (0xRRGGBB,
// set by map kinds; generated lamps never carry one). Each channel / 255 is
// a LINEAR multiplier on the tint above — no sRGB decode, so 0x808080 halves
// the light and 0xffffff is an exact identity. Every path that turns a lamp
// into colour (LightField, LightGrid's lamp texels, the path-tracer proxy
// lights, the panel instance colour) folds it in here, so they agree.
export function applyLampRecordTint(out, tint) {
  if (tint == null) return out
  out[0] *= ((tint >> 16) & 255) / 255
  out[1] *= ((tint >> 8) & 255) / 255
  out[2] *= (tint & 255) / 255
  return out
}
