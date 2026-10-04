import { MAP_FAMILY_TRAIN } from '../ids.js'
import { TILE, exitAnchor, footprint, ports, spawnCells } from './geometry.js'
import { buildTrainWorldTile } from './world.js'

// The train generator (spec §6.5, §12.10, Option A). Backend 'band': one bake
// draws a 4×1-chunk tile over storeys 0..1 with the train's grammar
// (world.js) around the tile's pure skeleton (geometry.js): the cars and
// their path, the station or the service stairs, the lineside and the
// upper works. Footprint, ports (hashed per seam) and the exit anchor are
// pure; the stair cores go through the world kit (kit.stairwell).
export { TILE, footprint, ports, exitAnchor }

// Fill light (tiles/fillLight.js, I-playfix): plain fixtures over the cells
// the tile's own lamps leave dark, and one over the spawn.
const FILL_LIGHT = Object.freeze({ spawn: (ctx) => spawnCells(ctx?.worldSeed ?? 0) })

export default Object.freeze({
  family: MAP_FAMILY_TRAIN,
  ready: true,
  light: FILL_LIGHT,
  stub: false,
  tile: TILE,
  footprint,
  ports,
  exitAnchor,
  paramsFor() {
    return {}
  },
  bake(canvas, ctx) {
    return buildTrainWorldTile(canvas, ctx)
  },
})
