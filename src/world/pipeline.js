import { CHUNK } from './constants.js'
import { ChunkData } from './ChunkData.js'
import { RNG } from './core/rng.js'
import { selectZone, ZONES } from './zones/index.js'
import { vBorder, hBorder } from './border.js'
import { placeLights } from './lamps.js'
import { DEFAULT_WORLD_CONFIG } from './config.js'

// The layered generation pipeline. Pure function of (seed, cx, cz, config) ->
// ChunkData. No THREE: runs headless. This is what generate.js will wrap at the
// stage-C flip; tests target it directly.
//
//   seed     : uint32 root seed (from hashStr of the seed text)
//   cx, cz   : chunk coordinates
//   exitCell : {lx, lz} | null — host chunk for the level exit (carves a clearing)
//   clearings: [{lx, lz, r?}] | null — extra forced-open clearings (e.g. spawn)
export function buildChunk(seed, cx, cz, config = DEFAULT_WORLD_CONFIG, exitCell = null, clearings = null) {
  // L1 — zone select
  const zone = selectZone(cx, cz, seed, config)
  const data = new ChunkData(cx, cz, zone)

  // L2 — border doorways. This chunk OWNS its West line (lx=0) and North line
  // (lz=0); East/South borders are owned by the neighbours (their line 0).
  const wW = vBorder(cx - 1, cz, seed, config) // between (cx-1,cz)|(cx,cz)
  const wN = hBorder(cx, cz - 1, seed, config) // between (cx,cz-1)|(cx,cz)
  for (let z = 0; z < CHUNK; z++) data.setV(0, z, wW[z])
  for (let x = 0; x < CHUNK; x++) data.setH(x, 0, wN[x])

  // L3 — interior layout (conditioned on the four border doorways).
  const borders = {
    wW,
    wN,
    wE: vBorder(cx, cz, seed, config),
    wS: hBorder(cx, cz, seed, config),
  }
  const borderZones = {
    w: selectZone(cx - 1, cz, seed, config),
    n: selectZone(cx, cz - 1, seed, config),
    e: selectZone(cx + 1, cz, seed, config),
    s: selectZone(cx, cz + 1, seed, config),
  }
  const rng = RNG.fromHash(seed, cx, cz)
  ZONES[zone].generate(data, { seed, cx, cz, zone, rng, config, borders, borderZones })

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

  return data
}
