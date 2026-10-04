import { TILE, footprint, ports, exitAnchor, spawnCells } from './geometry.js'
import { SODIUM, buildNightLotTile } from './tile.js'

// The nightlot generator (spec §6.5, §12.2). Backend 'band': one bake draws a
// 4×4-chunk district over storeys −1..1 with the tile program (tile.js) from
// the district's pure blueprint (geometry.js): the lot on cy 0 (seam roads,
// parking lots and their lamp islands, apron poles, a garage's ground deck,
// strip malls, frontage blocks, a big box, outparcels, booths, the
// gas-station refuge, a kiosk), the undercroft on cy −1 (the garage's B1
// deck, under-lot decks, basement suites, the kiosk's service floor, service
// tunnels and underpasses to the neighbours) and the upper storey on cy 1
// over the garage (its roof deck) and the frontage blocks (motel rooms on a
// walkway, offices off a corridor); the storeys joined by stairwell cores
// stamped through the world kit.
export { TILE, footprint, ports, exitAnchor }

// Fill light (tiles/fillLight.js, I-playfix): the lot keeps its islands of
// light and the undercroft its tube runs (no fill anywhere: `where` is
// false), but the spawn (the refuge canopy) always stands in light. Only the
// home district (0,0) holds spawn candidates, so the pass runs there alone
// (elsewhere it could hang nothing).
const FILL_SPEC = Object.freeze({ where: () => false, tint: SODIUM, spawn: (ctx) => spawnCells(ctx.worldSeed) })
const FILL_LIGHT = (ctx) => (ctx?.key && (ctx.key.tx !== 0 || ctx.key.tz !== 0) ? null : FILL_SPEC)

export default Object.freeze({
  family: 'nightlot',
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
    return buildNightLotTile(canvas, ctx.tileSeed, ctx)
  },
})
