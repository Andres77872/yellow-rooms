import { CHUNK } from '../../constants.js'
import { hash2i } from '../../core/hash.js'
import { GROUND_STREET, SPAWN_CELLS, TILE, TILE_D, TILE_W, footprint, ports, exitAnchor, suburbPlan } from './geometry.js'
import { TINT_MOON, buildSuburbTile } from './tile.js'

// The suburb generator (spec §6.5, §12.6). Backend 'band': one bake draws a
// 5×3-chunk tile over storeys 0..1 (streets and houses, then the two-storey
// houses' attics), composed by the tile's own street grammar
// (geometry.suburbPlan) and drawn by tile.js; the attic stairs are
// switchback cores stamped through kit.stairwell.
export { TILE, footprint, ports, exitAnchor }

// Fill light (tiles/fillLight.js, I-playfix): fixtures over the cells the
// tile's own lamps leave dark, and one over the spawn.
//   - Rooms: only the rooms a house already lights, in that room's own tint
//     (sleeping houses stay dark, the anchor house keeps its amber).
//   - Outside (doc §8: "moonlight gives silhouettes only; houses supply
//     almost all the light"): no carpet of fixtures over the streets. The
//     pass may only hang a dim, cold moon fixture (tile.TINT_MOON) over a
//     MOON CELL — one hashed cell per 16×16-cell block of the world, kept
//     only on a street — and only where no porch, window, TV or burning
//     streetlight already reaches it. Lawns, yards and vacant lots get none
//     (every street-level chunk already keeps three lights of its own:
//     tile.js lightFloor).
const MOON_BLOCK = 16
const SALT_MOON = 0x5b10a
export function isMoonCell(worldSeed, gx, gz) {
  const bx = Math.floor(gx / MOON_BLOCK)
  const bz = Math.floor(gz / MOON_BLOCK)
  const h = hash2i(((worldSeed >>> 0) ^ SALT_MOON) | 0, bx, bz) >>> 0
  return gx - bx * MOON_BLOCK === h % MOON_BLOCK && gz - bz * MOON_BLOCK === (h >>> 8) % MOON_BLOCK
}
const FILL_LIGHT = (ctx) => {
  const k = ctx.key
  const plan = k ? suburbPlan(ctx.worldSeed, k.tx, k.tz) : null
  const ox = k ? k.tx * TILE_W : 0
  const oz = k ? k.tz * TILE_D : 0
  const seed = ctx.worldSeed >>> 0
  return {
    spawn: () => SPAWN_CELLS,
    rooms: 'lit',
    roomTint: true,
    // A sleeping house's dead porch lamp darkens its own porch and path, not
    // the whole street in front of it.
    deadReach: 2,
    tint: (d, lx, lz) => (d.spaceId[lz * CHUNK + lx] ? null : TINT_MOON),
    where: (d, lx, lz, gx, gz, cy) => {
      if (d.spaceId[lz * CHUNK + lx] !== 0) return true
      if (cy !== 0 || !plan) return false
      const g = plan.ground[(gz - oz) * TILE_W + (gx - ox)]
      return g === GROUND_STREET && isMoonCell(seed, gx, gz)
    },
  }
}

export default Object.freeze({
  family: 'suburb',
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
    return buildSuburbTile(canvas, ctx.tileSeed, ctx)
  },
})
