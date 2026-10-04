import { CHUNK } from '../../constants.js'
import { SPACE_ROLE_STORAGE } from '../../mapTypes.js'
import { MAP_FAMILY_STAIRWELL } from '../ids.js'
import { SPAN, TILE, darkCells, exitAnchor, footprint, ports, spawnCell } from './geometry.js'
import { WORLD_PARAMS, buildStairwellTile } from './tile.js'

// The stairwell generator (spec §6.5, §12.1): backend 'storey', one bake per
// (district, storey). The tile program is the kind body (tile.js) run with
// the world kit; footprint, ports and the exit anchor are pure (geometry.js).
export { TILE, footprint, ports, exitAnchor }

// Fill light (tiles/fillLight.js, I-playfix): plain fixtures over the cells
// the tile's own lamps leave dark, and one over the spawn — never inside a
// locked store (the fragments' leaves stay dark behind their doors, which
// also keeps the pass cheap on a storey of hundreds of rooms), with a lit cap
// per chunk-storey (the §11.1 60 u budget on dense floors): 8. Rooms are
// filled only when the tile already lit them (rooms 'lit'): a room the tile
// left dark stays dark. Authored darkness is never filled (geometry.js
// darkCells): a dark fragment (doc §4.3 "Dark floor: everything, no lit
// lamp") and a landing whose tubes are dead (§8 breaker segments) keep no
// lit fixture, corridors and circulation included.
const FILL_LIGHT = (ctx) => {
  const ox = ctx.key.tx * SPAN
  const oz = ctx.key.tz * SPAN
  const dark = darkCells(ctx.worldSeed, ctx.key.tx, ctx.key.tz, ctx.cy0)
  return {
    spawn: () => [spawnCell(ctx.worldSeed)],
    cap: 8,
    rooms: 'lit',
    where: (d, lx, lz, gx, gz) => {
      if (d.spaceRole[lz * CHUNK + lx] === SPACE_ROLE_STORAGE) return false
      if (!dark) return true
      const x = gx - ox
      const z = gz - oz
      return x < 0 || z < 0 || x >= SPAN || z >= SPAN || dark[z * SPAN + x] === 0
    },
  }
}

export default Object.freeze({
  family: MAP_FAMILY_STAIRWELL,
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
    return buildStairwellTile(canvas, ctx.tileSeed, ctx)
  },
})
