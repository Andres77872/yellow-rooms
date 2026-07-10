import { CHUNK, ZONE_OFFICE } from './constants.js'
import { ChunkData } from './ChunkData.js'
import { RNG } from './core/rng.js'
import { ZONES } from './zones/index.js'
import { selectZone } from './regions.js'
import { vBorderContract, hBorderContract } from './border.js'
import { placeLights } from './lamps.js'
import { DEFAULT_WORLD_CONFIG } from './config.js'
import { PASSAGE_OPEN } from './mapTypes.js'
import { repairChunkTopology } from './topology.js'
import { normalizeDoorPassages } from './doors.js'

const TOPOLOGY_SALT = 0x74a1

// The layered generation pipeline. Pure function of (seed, cx, cz, config) ->
// ChunkData. No THREE: runs headless and is tested directly.
//
//   seed     : uint32 root seed (from hashStr of the seed text)
//   cx, cz   : chunk coordinates
//   exitCell : {lx, lz} | null — host chunk for the level exit (carves a clearing)
//   clearings: [{lx, lz, r?}] | null — extra forced-open clearings (e.g. spawn)
export function buildChunk(seed, cx, cz, config = DEFAULT_WORLD_CONFIG, exitCell = null, clearings = null) {
  // L1 — zone select
  const zone = selectZone(cx, cz, seed, config)
  const data = new ChunkData(cx, cz, zone, config.version)

  // L2 — border contracts. This chunk OWNS its West line (lx=0) and North line
  // (lz=0); East/South borders are owned by the neighbours (their line 0).
  const cW = vBorderContract(cx - 1, cz, seed, config)
  const cN = hBorderContract(cx, cz - 1, seed, config)
  for (let z = 0; z < CHUNK; z++) data.setPassageV(0, z, cW.passages[z])
  for (let x = 0; x < CHUNK; x++) data.setPassageH(x, 0, cN.passages[x])

  // L3 — interior layout (conditioned on the four border wall contracts).
  const borders = {
    wW: cW.walls,
    wN: cN.walls,
    wE: vBorderContract(cx, cz, seed, config).walls,
    wS: hBorderContract(cx, cz, seed, config).walls,
  }
  const borderZones = {
    w: selectZone(cx - 1, cz, seed, config),
    n: selectZone(cx, cz - 1, seed, config),
    e: selectZone(cx + 1, cz, seed, config),
    s: selectZone(cx, cz + 1, seed, config),
  }
  const rng = RNG.fromHash(seed, cx, cz)
  ZONES[zone].generate(data, { seed, cx, cz, zone, rng, config, borders, borderZones })

  // L4 — open-zone safety repair. Office topology is validated and scored on
  // the authoritative district plan; mutating an office after slicing would
  // reintroduce chunk-local layout decisions.
  if (zone !== ZONE_OFFICE) {
    data.repairs = repairChunkTopology(
      data,
      RNG.fromHash(seed, cx, cz, TOPOLOGY_SALT),
      PASSAGE_OPEN
    )
  }

  // L5 — lights (independent stream, global module grid).
  placeLights(data, { seed, cx, cz, zone, config })

  // L6 — anomaly: carve clearings for the exit and/or spawn, if this is the host.
  if (exitCell) {
    data.exit = { lx: exitCell.lx, lz: exitCell.lz }
    data.carveClearing(exitCell.lx, exitCell.lz, config.exit.clearRadius)
  }
  if (clearings) {
    for (const c of clearings) data.carveClearing(c.lx, c.lz, c.r ?? config.exit.clearRadius)
  }

  // Anomalies and transition thresholds are monotone topology edits, but they
  // can turn a framed doorway into an unsupported opening.
  normalizeDoorPassages(data)

  return data
}
