import { CHUNK } from '../../constants.js'
import { BASIN, TILE, anomalyAt, exitAnchor, footprint, ports, tileVolumes } from './geometry.js'
import { spawnCells } from './grammar.js'
import { FILL_LEVEL, buildPoolroomsTile, poolFillTint, poolFillWhere } from './tile.js'

// The poolrooms generator (spec §6.5, §12.4). Backend 'band': one bake draws
// a 3×3-chunk tile over storeys −1..1 (basin, deck, gallery) from the tile
// grammar (tile.js over geometry.js and grammar.js); the pool volumes come
// from the planner (structures.js) through the world kit.
export { TILE, footprint, ports, exitAnchor }

// Fill light (tiles/fillLight.js, I-playfix): plain fixtures over the deck
// and gallery cells the tile's own lamps leave dark, and one over the spawn.
// The basin is the tile's own (tile.js lampBasin: its drained pool floors —
// the doc's dark deep ends — and its small dark refuge stay dark); the
// too-deep well (anomaly 'deep') has no light on the deck round it either.
// The spawn candidates are the world's, memoised per seed (every bake asks).
let spawnMemo = { seed: null, cells: null }
const spawnOf = (worldSeed) => {
  if (spawnMemo.seed !== worldSeed) spawnMemo = { seed: worldSeed, cells: Object.freeze(spawnCells(worldSeed)) }
  return spawnMemo.cells
}
const FILL_LIGHT = (ctx) => {
  const vols = tileVolumes(ctx.worldSeed, ctx.key.tx, ctx.key.tz)
  return {
    // 9 lit per chunk-storey, the tile program's own cap (tile.js LIT_CAP).
    cap: 9,
    level: FILL_LEVEL,
    spawn: () => spawnOf(ctx.worldSeed),
    where: poolFillWhere(vols, anomalyAt(ctx.worldSeed, ctx.key), ctx.origin.cx * CHUNK, ctx.origin.cz * CHUNK, ctx.origin.cy + BASIN),
    tint: poolFillTint(vols, ctx.origin.cx * CHUNK, ctx.origin.cz * CHUNK, ctx.origin.cy + BASIN),
  }
}

export default Object.freeze({
  family: 'poolrooms',
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
    return buildPoolroomsTile(canvas, ctx.tileSeed, ctx)
  },
})
