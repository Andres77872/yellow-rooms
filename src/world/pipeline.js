import { CHUNK, ZONE_OFFICE } from './constants.js'
import { ChunkData } from './ChunkData.js'
import { RNG } from './core/rng.js'
import { ZONES } from './zones/index.js'
import { selectZone } from './zones/regions.js'
import { vBorderContract, hBorderContract } from './border.js'
import { placeLights } from './lamps.js'
import { stampStairs } from './structures/stairStamp.js'
import { stampMultilevelRooms, stampTowerStructure } from './structures/multilevelStamp.js'
import { stampLatticeStructure } from './structures/latticeStamp.js'
import { DEFAULT_WORLD_CONFIG } from './config.js'
import {
  MAP_FAMILY_OFFICE,
  MAP_FAMILY_LATTICE,
  MAP_FAMILY_SEWER,
  MAP_FAMILY_TOWER,
  PASSAGE_OPEN,
} from './mapTypes.js'
import { repairChunkTopology } from './topology.js'
import { normalizeDoorPassages } from './doors.js'
import { placeFurniture } from './furniture.js'
import { layerSeed } from './layerSeed.js'
import { resolveMapFamily } from './mapFamily.js'
import {
  isConnectedSewerCandidate,
  sewerCandidateSeeds,
  sewerStairConfig,
} from './zones/sewer.js'
import { structureAt } from './structures/contract.js'

const TOPOLOGY_SALT = 0x74a1

function installOwnedBorders(data, west, north) {
  for (let z = 0; z < CHUNK; z++) data.setPassageV(0, z, west.passages[z])
  for (let x = 0; x < CHUNK; x++) data.setPassageH(x, 0, north.passages[x])
}

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
  // Resolve before any downstream generation state is read or ChunkData is
  // constructed. Explicit invalid/disabled selections therefore fail closed
  // instead of producing a partially tagged office chunk.
  const profile = resolveMapFamily(config)
  const lseed = layerSeed(seed, cy)
  const layerCtx = { rootSeed: seed >>> 0, layerSeed: lseed, cy }

  // L1 — zone select
  const zone = selectZone(cx, cz, lseed, config)
  let data = new ChunkData(cx, cy, cz, zone, config.version, profile.family)

  // L2 — border contracts. This chunk OWNS its West line (lx=0) and North line
  // (lz=0); East/South borders are owned by the neighbours (their line 0).
  const cW = vBorderContract(cx - 1, cz, lseed, config, layerCtx)
  const cN = hBorderContract(cx, cz - 1, lseed, config, layerCtx)
  installOwnedBorders(data, cW, cN)

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
  const generateZone = (target, candidateSeed) => {
    ZONES[zone].generate(target, {
      seed: candidateSeed,
      rootSeed: seed >>> 0,
      layerSeed: candidateSeed,
      cx,
      cy,
      cz,
      zone,
      rng: RNG.fromHash(candidateSeed, cx, cz),
      config,
      // The one normalized/frozen profile resolved at the pipeline boundary is
      // carried forward; family stages must not infer identity from zone/kind.
      mapFamilyProfile: profile,
      borders,
      borderZones,
    })
  }
  const candidateSeeds = profile.family === MAP_FAMILY_SEWER
    ? sewerCandidateSeeds(lseed)
    : null
  generateZone(data, candidateSeeds?.[0] ?? lseed)

  // L4 — family topology policy. Sewer candidates are validated and retried
  // from a finite, separately salted set; they never enter the generic office
  // repair path. Every other current zone preserves the established behavior.
  if (profile.family === MAP_FAMILY_SEWER) {
    for (
      let attempt = 1;
      !isConnectedSewerCandidate(data) && attempt < candidateSeeds.length;
      attempt++
    ) {
      const candidateSeed = candidateSeeds[attempt]
      data = new ChunkData(cx, cy, cz, zone, config.version, profile.family)
      installOwnedBorders(data, cW, cN)
      generateZone(data, candidateSeed)
    }
    if (!isConnectedSewerCandidate(data)) {
      throw new Error('Unable to generate connected bounded sewer candidate')
    }
  } else if (zone !== ZONE_OFFICE) {
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
  if (profile.family === MAP_FAMILY_OFFICE) {
    stampStairs(data, seed, cx, cy, cz, config)

    // L4.6 — tall-structure stamp (v13). A root-seeded district/band contract is
    // sliced identically by both sides of every slab across a two-chunk, up-to-
    // 15-storey volume. The monotone hall/gallery carve explicitly opens its
    // owned chunk seam; protected windows, approaches and bridge guards survive
    // later anomalies. Lamps see the exact per-storey aperture/bridge mask.
    stampMultilevelRooms(data, structureAt(seed, cx, cz, cy, config))
  } else if (profile.family === MAP_FAMILY_SEWER) {
    // Every emitted manhole-up/down module gets a real canonical riser half.
    // Reusing root-seeded slab contracts keeps adjacent layers byte-identical;
    // the shared descriptor primitive preserves the existing guarded-halo path.
    stampStairs(data, seed, cx, cy, cz, sewerStairConfig(config))
  } else if (profile.family === MAP_FAMILY_TOWER) {
    // Tower reuses the canonical task-4.4 descriptor as its sole structure
    // carrier. Rooms/deck, exact vertical links, and descriptor-scoped lethal
    // halves all land before lights and anomalies; Tower remains release-disabled.
    stampTowerStructure(data, structureAt(seed, cx, cz, cy, config))
  } else if (profile.family === MAP_FAMILY_LATTICE) {
    // Lattice projects the immutable planner graph into sparse chamber/deck
    // geometry and the existing stair/lethal carriers at the same canonical
    // pre-light, pre-anomaly stage. No test envelope becomes runtime state.
    stampLatticeStructure(
      data,
      structureAt(seed, cx, cz, cy, config),
      profile
    )
  }

  // L5 — lights (independent stream, global module grid).
  placeLights(data, { seed: lseed, cx, cz, zone, config })

  // L5.5 — interior furniture (v15). Collision-real office pieces (desks,
  // chairs, conference tables, storage) stamped into room cells as
  // COLUMN_FURNITURE blockers with precise player-collision AABBs. Runs after
  // lamps so fixtures keep their grid (pieces skip lamp cells), before the
  // anomaly carves so a clearing can still evict a piece wholesale.
  if (profile.family === MAP_FAMILY_OFFICE) {
    placeFurniture(data, { zone, config })
  }

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
