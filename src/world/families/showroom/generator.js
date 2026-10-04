import { MAP_FAMILY_SHOWROOM } from '../ids.js'
import { TILE, UP, footprint, globalCell, ports, spawnCellsOf } from './geometry.js'
import { exitAnchor } from './layout.js'
import { WORLD_PARAMS, buildShowroomDistrict } from './district.js'

// The showroom generator (spec §6.5, §12.3). Backend 'band': one bake draws a
// 2×2-chunk district over storeys −1..0 (the hall storey and the route),
// composed by the district grammar (geometry.districtPlan → layout.js →
// district.js): every tile's serpentine, rooms, shortcuts and departments are
// its own. Stairs A and B go through the world kit.
export { TILE, footprint, ports, exitAnchor }

// Fill light (tiles/fillLight.js, I-playfix): plain fixtures over the cells
// the tile's own lamps leave dark, and one over the spawn.
const FILL_LIGHT = Object.freeze({
  cap: 9, // the fill pass tops a chunk-storey up to the lamp plan's budget, not past it
  spawn: (ctx) => spawnCellsOf(ctx.worldSeed).map((c) => globalCell(0, 0, { ...c, cy: UP })),
})

export default Object.freeze({
  family: MAP_FAMILY_SHOWROOM,
  ready: true,
  light: FILL_LIGHT,
  stub: false,
  tile: TILE,
  footprint,
  ports,
  exitAnchor,
  paramsFor() {
    return WORLD_PARAMS
  },
  bake(canvas, ctx) {
    return buildShowroomDistrict(canvas, ctx)
  },
})
