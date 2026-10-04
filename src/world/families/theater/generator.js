import { TILE, footprint, ports, exitAnchor } from './geometry.js'
import { buildTheaterTile } from './tile.js'

// The theater generator (spec §6.5, §12.8). Backend 'band': one bake draws a
// 3×3-chunk tile over storeys −1..3 (basement, ground, first floor, upper
// circle, loft) — one theatre of the endless chain, its own building rolled
// from the tile's seed (geometry.schemeOf) — with the kind body (tile.js) at
// the tile's origin; the house volume comes from the planner
// (structures.js) through the world kit.
export { TILE, footprint, ports, exitAnchor }

// Fill light (tiles/fillLight.js, I-playfix): off. The tile program lights
// its own band (layout.js bandLamps: a fitting at most three cells from every
// cell of every band room, hall and corridor, one circuit per room, some
// circuits dead) and leaves the house, the stage, the circles, the fly
// galleries and their ring to the ghost light and the fly floor's work
// lights. The pass's sight-line cover over a 3×3-chunk tile cost ~50 ms a
// bake for what the band's own fittings already light.
const FILL_LIGHT = Object.freeze({ off: true })

export default Object.freeze({
  family: 'theater',
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
    return buildTheaterTile(canvas, ctx.tileSeed, ctx)
  },
})
