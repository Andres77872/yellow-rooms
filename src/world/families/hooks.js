import { CELL, CHUNK_WORLD, HUB_CELL, SPAWN_WORLD } from '../constants.js'
import { generateChunk } from '../generate.js'
import { resolveMapFamily } from '../mapFamily.js'
import {
  MAP_FAMILY_STAIRWELL,
  MAP_FAMILY_NIGHTLOT,
  MAP_FAMILY_SHOWROOM,
  MAP_FAMILY_POOLROOMS,
  MAP_FAMILY_BABEL,
  MAP_FAMILY_SUBURB,
  MAP_FAMILY_TERMINAL,
  MAP_FAMILY_THEATER,
  MAP_FAMILY_PLAYPLACE,
  MAP_FAMILY_TRAIN,
  MAP_FAMILY_HOUSE,
  MAP_FAMILY_FUNHOUSE,
} from './ids.js'
import * as stairwell from './stairwell/hooks.js'
import * as nightlot from './nightlot/hooks.js'
import * as showroom from './showroom/hooks.js'
import * as poolrooms from './poolrooms/hooks.js'
import * as babel from './babel/hooks.js'
import * as suburb from './suburb/hooks.js'
import * as terminal from './terminal/hooks.js'
import * as theater from './theater/hooks.js'
import * as playplace from './playplace/hooks.js'
import * as train from './train/hooks.js'
import * as house from './house/hooks.js'
import * as funhouse from './funhouse/hooks.js'

// Registration list of the per-family spawn/exit hooks (spec §3.1, §8).
//
// It imports generate.js, so NOTHING under tiles/ may import this module
// (generate → pipeline → familyChunk cycle; import-boundary.test).
const HOOKS = Object.freeze({
  [MAP_FAMILY_STAIRWELL]: stairwell,
  [MAP_FAMILY_NIGHTLOT]: nightlot,
  [MAP_FAMILY_SHOWROOM]: showroom,
  [MAP_FAMILY_POOLROOMS]: poolrooms,
  [MAP_FAMILY_BABEL]: babel,
  [MAP_FAMILY_SUBURB]: suburb,
  [MAP_FAMILY_TERMINAL]: terminal,
  [MAP_FAMILY_THEATER]: theater,
  [MAP_FAMILY_PLAYPLACE]: playplace,
  [MAP_FAMILY_TRAIN]: train,
  [MAP_FAMILY_HOUSE]: house,
  [MAP_FAMILY_FUNHOUSE]: funhouse,
})

// The family's hooks module ({ spawn, exit, exitBounds, proofBox, exitAnchor }),
// or null for the legacy 5 and unknown ids.
export function hookOf(id) {
  return typeof id === 'string' && Object.hasOwn(HOOKS, id) ? HOOKS[id] : null
}

// Today's spawn for the legacy 5: the hub cell of chunk (0,0) on storey 0,
// with the hub clearing ChunkManager has always carved (r = 1).
export const LEGACY_SPAWN = Object.freeze({
  cx: 0,
  cz: 0,
  lx: HUB_CELL,
  lz: HUB_CELL,
  yaw: null,
  x: SPAWN_WORLD,
  z: SPAWN_WORLD,
  clearings: Object.freeze([Object.freeze({ cx: 0, cy: 0, cz: 0, lx: HUB_CELL, lz: HUB_CELL, r: 1 })]),
})

const NO_CLEARINGS = Object.freeze([])

const selectedFamily = (config) => config?.mapFamily?.selected ?? 'office'

// Spawn of the world `config` selects (§8.1). Legacy (and unknown)
// families → LEGACY_SPAWN. A liminal hook returns a cell and chunk on
// storey 0 only (I7); the result adds world x/z and no clearings.
export function familySpawn(config, worldSeed) {
  const hook = hookOf(selectedFamily(config))?.spawn
  if (!hook) return LEGACY_SPAWN
  const seed = worldSeed >>> 0
  const s = hook({
    worldSeed: seed,
    config,
    profile: resolveMapFamily(config),
    generate: (cx, cy, cz) => generateChunk(seed, cx, cy, cz, config),
  })
  return Object.freeze({
    ...s,
    x: s.cx * CHUNK_WORLD + (s.lx + 0.5) * CELL,
    z: s.cz * CHUNK_WORLD + (s.lz + 0.5) * CELL,
    clearings: NO_CLEARINGS,
  })
}

// The exit hook of the world `config` selects (§8.2), or null for the legacy
// 5 (createExitPlacement then runs its legacy body unchanged). Called as
// hook({ worldSeed, level, config, profile, generate }) → {cx, cy, cz, lx, lz}.
export function familyExitHook(config) {
  return hookOf(selectedFamily(config))?.exit ?? null
}
