import { hash3f } from './core/hash.js'
import {
  CELL,
  LAMP_FLICKER_AMP,
  LAMP_BAD_CHANCE,
  LAMP_BAD_LO,
  LAMP_BAD_RATE,
  LAMP_TINT_VAR,
} from './constants.js'
import {
  SPACE_ROLE_ARCHIVE,
  SPACE_ROLE_BREAK,
  SPACE_ROLE_COPY,
  SPACE_ROLE_LIBRARY,
  SPACE_ROLE_LOUNGE,
  SPACE_ROLE_MEETING,
  SPACE_ROLE_OFFICE,
  SPACE_ROLE_SERVER,
  SPACE_ROLE_STORAGE,
} from './mapTypes.js'

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

export function isBadTube(wx, wz, cy) {
  return hash3f(SALT_BAD, kx(wx), kz(wz), cy | 0) < LAMP_BAD_CHANCE
}

// Cast-light brightness multiplier for this fixture at time t (seconds).
// Healthy tubes: a slow individual breathing ripple that only ever DIPS from
// full. Bad tubes: a stepped erratic buzz, biased toward the dim floor.
export function lampFlicker(wx, wz, cy, t) {
  const x = kx(wx)
  const z = kz(wz)
  const layer = cy | 0
  if (isBadTube(wx, wz, cy)) {
    const step = Math.floor(t * LAMP_BAD_RATE)
    const n = hash3f(SALT_BUZZ ^ (step | 0), x, z, layer)
    return LAMP_BAD_LO + (1 - LAMP_BAD_LO) * n * n
  }
  const phase = hash3f(SALT_PHASE, x, z, layer) * Math.PI * 2
  const speed = 13 + hash3f(SALT_SPEED, x, z, layer) * 11 // 13..24 rad/s, per tube
  return 1 - LAMP_FLICKER_AMP * (0.5 + 0.5 * Math.sin(t * speed + phase))
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
export function lampPanelTint(wx, wz, cy, out, role = 0) {
  lampTint(wx, wz, cy, out, role)
  if (isBadTube(wx, wz, cy)) {
    out[0] *= 0.42
    out[1] *= 0.36
    out[2] *= 0.3
  }
  return out
}
