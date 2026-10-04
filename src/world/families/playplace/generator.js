import { TILE, TILE_CELLS, TUBE, exitAnchor, footprint, hallsOf, inRect, moduleLayout, ports, spawnCells } from './geometry.js'
import { WORLD_FILL_CAP, buildPlayplaceTile } from './tile.js'

// The playplace generator (spec §6.5, §12.9). Backend 'band': one bake draws
// a 2×2-chunk module over storeys 0..2 (floor, deck, top deck) with the kind
// body (tile.js) at the module's origin. Every module is composed by
// geometry.js's grammar from its planSeed (halls, seams, crawl tubes,
// corridors, rooms); the halls come from the planner (structures.js) through
// the world kit.
export { TILE, footprint, ports, exitAnchor }

// Fill light (tiles/fillLight.js, I-playfix): plain fixtures over the cells
// the tile's own lamps leave dark, and one over the spawn.
// The tile lights itself under its own caps (tile.js: the halls' covers up
// to 10 per chunk-storey, the rest up to 9) and covers its hall boxes
// itself; the pass fills only the chunk-storeys the tile left under
// WORLD_FILL_CAP, outside the hall boxes and off the crawl tubes, so a
// capped chunk costs it nothing (`where` reads each chunk's lit count once,
// when the pass first asks: pure per bake).
const litAtFill = new WeakMap()
const underCap = (d) => {
  let n = litAtFill.get(d)
  if (n === undefined) {
    n = 0
    for (const l of d.lamps) if (l.lit) n++
    litAtFill.set(d, n)
  }
  return n < WORLD_FILL_CAP
}
const fillLight = (ctx) => {
  const { tx, tz } = ctx.key
  const halls = hallsOf(ctx.worldSeed, tx, tz)
  const lay = moduleLayout(ctx.worldSeed, tx, tz)
  const ox = tx * TILE_CELLS
  const oz = tz * TILE_CELLS
  const cy0 = ctx.key.origin?.cy ?? 0
  const inHall = (gx, gz, cy) => halls.some((h) => cy - cy0 < h.L && inRect(h.box, gx - ox, gz - oz))
  const tube = (gx, gz, cy) => lay.storeys[cy - cy0]?.cells[(gz - oz) * TILE_CELLS + (gx - ox)] === TUBE
  return {
    cap: WORLD_FILL_CAP,
    spawn: (c) => spawnCells(c.worldSeed),
    where: (d, lx, lz, gx, gz, cy) => underCap(d) && !inHall(gx, gz, cy) && !tube(gx, gz, cy),
  }
}

export default Object.freeze({
  family: 'playplace',
  ready: true,
  light: fillLight,
  stub: false,
  tile: TILE,
  footprint,
  ports,
  exitAnchor,
  paramsFor() {
    return {}
  },
  bake(canvas, ctx) {
    return buildPlayplaceTile(canvas, ctx.tileSeed, ctx)
  },
})
