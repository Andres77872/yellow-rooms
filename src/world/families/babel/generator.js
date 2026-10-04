import { SPAWN_CELLS, TILE, darkRooms, exitAnchor, footprint, ports } from './geometry.js'
import { buildBabelTile } from './tile.js'

// The babel generator (spec §6.5, §12.5). Backend 'band': one bake draws one
// 2×2-chunk block over its band's five storeys (phase (tx + 2tz) mod 5) with
// the tile program (tile.js) at the block's origin, from the block-band's
// procedural layout (geometry.layoutOf); the block's shaft volume comes from
// the planner (structures.js) through the world kit.
export { TILE, footprint, ports, exitAnchor }

// Fill light (tiles/fillLight.js, I-playfix): plain fixtures over the cells
// the tile's own lamps leave dark, and one over the spawn. A gallery's fill
// takes its globes' tint (the Crimson Hexagon stays red); a 'dark' anomaly
// room stays dark however large it is.
const FILL_LIGHT = (ctx) => {
  const spec = {
    roomTint: true,
    // SPAWN_CELLS are chunk (0,0)-local cells (hooks.spawn).
    spawn: () => SPAWN_CELLS.map((c) => ({ gx: c.lx, gz: c.lz })),
  }
  const k = ctx.key && ctx.origin ? { ...ctx.key, origin: ctx.origin, cy0: ctx.cy0, cy1: ctx.cy1 } : null
  const dark = k ? darkRooms(ctx.worldSeed >>> 0, k) : []
  if (dark.length) spec.where = (d, lx, lz, gx, gz, cy) => !dark.some((r) => r.cy === cy && gx >= r.x0 && gx <= r.x1 && gz >= r.z0 && gz <= r.z1)
  return spec
}

export default Object.freeze({
  family: 'babel',
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
    return buildBabelTile(canvas, ctx.tileSeed, ctx)
  },
})
