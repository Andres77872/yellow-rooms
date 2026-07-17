import { CHUNK, ZONE_OFFICE } from './constants.js'
import { ChunkData } from './ChunkData.js'
import { RNG } from './core/rng.js'
import { ZONES } from './zones/index.js'
import { selectZone } from './regions.js'
import { vBorderContract, hBorderContract } from './border.js'
import { placeLights } from './lamps.js'
import { stampStairs } from './stairStamp.js'
import { stampMultilevelRooms } from './multilevelStamp.js'
import { DEFAULT_WORLD_CONFIG } from './config.js'
import { PASSAGE_OPEN } from './mapTypes.js'
import { repairChunkTopology } from './topology.js'
import { normalizeDoorPassages } from './doors.js'
import { layerSeed } from './layerSeed.js'

const TOPOLOGY_SALT = 0x74a1

// Per-layer seed (v8): every 2D stage below is keyed by this instead of the
// root seed, so each floor gets its own zone geography, office district plans,
// warehouse structure, and lamp pattern — with ZERO internal signature changes
// to those stages. Identity at cy=0 keeps layer 0 byte-compatible with v7
// (except where stair stamps land). Slab contracts (stairStamp/slab.js) use
// the ROOT seed: they belong to the slab BETWEEN two layers, not to either.
export { layerSeed } from './layerSeed.js'

// The layered generation pipeline. Pure function of (seed, cx, cy, cz, config)
// -> ChunkData. No THREE: runs headless and is tested directly.
//
//   seed     : uint32 root seed (from hashStr of the seed text)
//   cx,cy,cz : chunk coordinates (cy = floor index, any integer)
//   exitCell : {lx, lz} | null — host chunk for the level exit (carves a clearing)
//   clearings: [{lx, lz, r?}] | null — extra forced-open clearings (e.g. spawn)
export function buildChunk(seed, cx, cy, cz, config = DEFAULT_WORLD_CONFIG, exitCell = null, clearings = null) {
  const lseed = layerSeed(seed, cy)
  const layerCtx = { rootSeed: seed >>> 0, layerSeed: lseed, cy }

  // L1 — zone select
  const zone = selectZone(cx, cz, lseed, config)
  const data = new ChunkData(cx, cy, cz, zone, config.version)

  // L2 — border contracts. This chunk OWNS its West line (lx=0) and North line
  // (lz=0); East/South borders are owned by the neighbours (their line 0).
  const cW = vBorderContract(cx - 1, cz, lseed, config, layerCtx)
  const cN = hBorderContract(cx, cz - 1, lseed, config, layerCtx)
  for (let z = 0; z < CHUNK; z++) data.setPassageV(0, z, cW.passages[z])
  for (let x = 0; x < CHUNK; x++) data.setPassageH(x, 0, cN.passages[x])

  // L3 — interior layout (conditioned on the four border wall contracts).
  const borders = {
    wW: cW.walls,
    wN: cN.walls,
    wE: vBorderContract(cx, cz, lseed, config, layerCtx).walls,
    wS: hBorderContract(cx, cz, lseed, config, layerCtx).walls,
  }
  const borderZones = {
    w: selectZone(cx - 1, cz, lseed, config),
    n: selectZone(cx, cz - 1, lseed, config),
    e: selectZone(cx + 1, cz, lseed, config),
    s: selectZone(cx, cz + 1, lseed, config),
  }
  const rng = RNG.fromHash(lseed, cx, cz)
  ZONES[zone].generate(data, {
    seed: lseed,
    rootSeed: seed >>> 0,
    layerSeed: lseed,
    cx,
    cy,
    cz,
    zone,
    rng,
    config,
    borders,
    borderZones,
  })

  // L4 — open-zone safety repair. Office topology is validated and scored on
  // the authoritative district plan; mutating an office after slicing would
  // reintroduce chunk-local layout decisions.
  if (zone !== ZONE_OFFICE) {
    data.repairs = repairChunkTopology(
      data,
      RNG.fromHash(lseed, cx, cz, TOPOLOGY_SALT),
      PASSAGE_OPEN
    )
  }

  // L4.5 — stair stamps (v9). Realize this layer's halves of the two slab
  // contracts (halo carve, then guard walls; connectivity-safe by construction
  // — see stairStamp.js). Office districts already reserve these halos as
  // routed lobbies; open zones receive the same semantic label here. Run after
  // repair so nothing re-walls the halo, before lamps so fixtures see holes,
  // and before L6 so anomaly carves respect protected guard edges.
  stampStairs(data, seed, cx, cy, cz, config)

  // L4.6 — tall-structure stamp (v13). A root-seeded district/band contract is
  // sliced identically by both sides of every slab across a two-chunk, up-to-
  // 15-storey volume. The monotone hall/gallery carve explicitly opens its
  // owned chunk seam; protected windows, approaches and bridge guards survive
  // later anomalies. Lamps see the exact per-storey aperture/bridge mask.
  stampMultilevelRooms(data, seed, cx, cy, cz, config)

  // L5 — lights (independent stream, global module grid).
  placeLights(data, { seed: lseed, cx, cz, zone, config })

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
