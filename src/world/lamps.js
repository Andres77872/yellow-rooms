import { CHUNK, fmod } from './constants.js'
import { hash2i } from './core/hash.js'
import {
  CELL_BRIDGE,
  CELL_CORRIDOR,
  CELL_LOBBY,
  SEWER_MODULE_CHAMBER_LARGE,
  SEWER_MODULE_CHAMBER_SMALL,
} from './mapTypes.js'

// Sewer galleries light like infrastructure, not like an office grid: the
// trunk keeps a tight cadence (the readable spine — you can always see the
// next stretch), service branches go long and dark (the pacing the design
// dossier asks for: GS-5 trunk 1/6-8 cells, branch sparser), and every
// chamber holds at least one live tube so landmarks are never swallowed.
const SEWER_TRUNK_STEP = 7
const SEWER_BRANCH_STEP = 5

function placeSewerLights(data, ctx) {
  const { seed, cx, cz, zone, config } = ctx
  const descriptor = data.sewerDescriptor
  const { deadSalt = 0x47d3, deadChance, salt } = config.lamps
  const chance = config.lamps.chance[zone] ?? 0.35
  const phase = config.lamps.phase?.[zone] ?? 0
  data.lamps.length = 0

  const isChamber = (kind) =>
    kind === SEWER_MODULE_CHAMBER_LARGE || kind === SEWER_MODULE_CHAMBER_SMALL
  const anchors = new Set(
    (descriptor.chambers ?? []).map((c) => `${c.anchor.lx},${c.anchor.lz}`)
  )

  let anyLit = false
  let firstAnchor = -1
  for (let index = 0; index < descriptor.modules.length; index++) {
    const m = descriptor.modules[index]
    if (data.colAt(m.lx, m.lz)) continue
    if (data.hasCeilHole(m.lx, m.lz)) continue
    const gx = cx * CHUNK + m.lx
    const gz = cz * CHUNK + m.lz
    const anchor = anchors.has(`${m.lx},${m.lz}`)
    let wants
    if (anchor || isChamber(m.kind)) {
      // Chambers: the anchor tube always exists; other chamber cells rarely.
      wants = anchor || hash2i((seed ^ salt) | 0, gx, gz) / 4294967296 < 0.15
    } else if (index < descriptor.trunkCount) {
      wants = fmod(gx + gz - phase, SEWER_TRUNK_STEP) === 0
    } else {
      wants = fmod(gx + gz - phase, SEWER_BRANCH_STEP) === 0 &&
        hash2i((seed ^ salt) | 0, gx, gz) / 4294967296 < chance
    }
    if (!wants) continue
    const dead = hash2i((seed ^ salt ^ deadSalt) | 0, gx, gz) / 4294967296
    const lit = dead >= deadChance
    if (anchor && firstAnchor < 0) firstAnchor = data.lamps.length
    data.lamps.push({ lx: m.lx, lz: m.lz, lit })
    anyLit ||= lit
  }
  // A chunk with fixtures but no live tube would sink its landmarks into full
  // darkness — force the first chamber anchor alight instead.
  if (!anyLit && firstAnchor >= 0) data.lamps[firstAnchor].lit = true
}

// Fluorescent ceiling lamps on a GLOBAL module grid (every `step` cells in world
// space), so the grid is perfectly regular AND continuous across chunk seams
// (the old per-chunk stepping jumped at boundaries). Seeded from an independent
// stream so lamp layout never perturbs the wall grid. Lit lamps drive the
// dynamic light pool; some are dead/dark so the world has unlit zones.
//
// The grid's PHASE is per-zone: the pillar bay lattice shares the phase-0
// step-4 coordinates, so an offset keeps hall fixtures between supports rather
// than inside them. Phase remains a pure function of zone, preserving seam
// continuity within each bounded landmark.
export function placeLights(data, ctx) {
  if (data.sewerDescriptor) return placeSewerLights(data, ctx)
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
      const circulation =
        cellKind === CELL_CORRIDOR || cellKind === CELL_LOBBY || cellKind === CELL_BRIDGE
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
      if (data.hasCeilHole(x, z)) continue // no ceiling to mount on (stair/atrium hole)
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
