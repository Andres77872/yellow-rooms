import { CHUNK, fmod } from './constants.js'
import { hash2i } from './core/hash.js'
import { CELL_CORRIDOR, CELL_LOBBY } from './mapTypes.js'

// Fluorescent ceiling lamps on a GLOBAL module grid (every `step` cells in world
// space), so the grid is perfectly regular AND continuous across chunk seams
// (the old per-chunk stepping jumped at boundaries). Seeded from an independent
// stream so lamp layout never perturbs the wall grid. Lit lamps drive the
// dynamic light pool; some are dead/dark so the world has unlit zones.
//
// The grid's PHASE is per-zone (config.lamps.phase): the pillars column lattice
// (spacing 2, phase 0) occupies every point of the phase-0 step-4 grid, so
// without an offset nearly every pillars lamp candidate lands inside a column
// and is rejected — pillar halls went near pitch-black. Phase is still a pure
// function of the chunk's zone, so the grid stays global and seam-continuous
// wherever neighbouring chunks share a zone.
export function placeLights(data, ctx) {
  const { seed, cx, cz, zone, config } = ctx
  const {
    step,
    salt,
    deadSalt = 0x47d3,
    deadChance,
    corridorStep = step,
    corridorSalt = 0x2f61,
    corridorChance = 1,
  } = config.lamps
  const chance = config.lamps.chance[zone] ?? 0.7
  const phase = config.lamps.phase?.[zone] ?? 0
  data.lamps.length = 0
  if (chance <= 0) return
  for (let z = 0; z < CHUNK; z++) {
    for (let x = 0; x < CHUNK; x++) {
      const gx = cx * CHUNK + x
      const gz = cz * CHUNK + z
      const cellKind = data.cellKind[z * CHUNK + x]
      const circulation = cellKind === CELL_CORRIDOR || cellKind === CELL_LOBBY
      let fixtureSalt = salt
      let fixtureChance = chance
      if (circulation) {
        const corridorPhase = hash2i((seed ^ corridorSalt) | 0, 0x43, 0) % corridorStep
        if (fmod(gx + gz - corridorPhase, corridorStep) !== 0) continue
        fixtureSalt = corridorSalt
        fixtureChance = corridorChance
      } else if (fmod(gx - phase, step) !== 0 || fmod(gz - phase, step) !== 0) {
        continue
      }
      if (data.colAt(x, z)) continue // no lamp inside a column
      if (data.hasCeilHole(x, z)) continue // no ceiling to mount on (stair hole)
      const h = hash2i((seed ^ fixtureSalt) | 0, gx, gz)
      if (h / 4294967296 >= fixtureChance) continue
      // A separately salted coordinate hash keeps fixture presence and failure
      // statistically independent. Slicing different bits from one hash made
      // the conditional dead rate depend on each zone's presence threshold.
      const dead = hash2i((seed ^ fixtureSalt ^ deadSalt) | 0, gx, gz) / 4294967296
      const lit = dead >= deadChance
      data.lamps.push({ lx: x, lz: z, lit })
    }
  }
}
