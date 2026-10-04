import { MAP_FAMILY_FUNHOUSE } from '../ids.js'
import { CHUNK } from '../../constants.js'
import { SPACE_ROLE_STORAGE } from '../../mapTypes.js'
import { F_FIELD, GROUND, SPAWN_CELLS, TILE, TILE_CELLS_X, exitAnchor, fieldTintOf, footprint, globalCell, ports, skeletonOf } from './geometry.js'
import { BULB, buildFunhouseTile } from './tile.js'

// The funhouse generator (spec §6.5, §12.12). Backend 'band': one bake draws
// one pavilion of the chain (3×2 chunks × storeys 0..1, row tz = 0) with the
// kind body (tile.js) at the tile's origin; the stair cores go through the
// world kit (kit.stairwell). Footprint, ports and the exit anchor are pure
// (geometry.js).
export { TILE, footprint, ports, exitAnchor }

// Fill light (tiles/fillLight.js, I-playfix): plain fixtures over the cells
// the tile's own lamps leave dark, and one over the spawn. The maze's
// one-cell runs see little of each fixture, so they hang closer (gap 1) and
// up to the §11.1 cap (the pavilions stay far under 72 within 60 u). The
// mirror maze (6 × 4..6, its size in the note) keeps its own two lamps (its lamp lie must show): the bake
// notes where the tile program put it. Dead bulbs along the strings and the
// ride are dressing, not dark zones: they shut only their own neighbours.
// The booths and the ride's backstage warrens (SPACE_ROLE_STORAGE) keep the
// tile's own light: dead stalls and service passages with a few work lights.
// A chunk-storey the tile already lights to the cap takes no fill fixture
// (the pass could not hang one there), so its cells are not scanned: the
// lit count is read once, before the pass hangs anything.
const FILL_CAP = 12
const UV_FILL = 0xb070ff // the ride's black light (tile.js UV)
const litAtFill = new WeakMap()
const underCap = (d) => {
  let n = litAtFill.get(d)
  if (n === undefined) {
    n = 0
    for (const l of d.lamps) if (l.lit) n++
    litAtFill.set(d, n)
  }
  return n < FILL_CAP
}
const MIRROR_NOTE = /^mirror maze at (-?\d+),(-?\d+) \((\d+)x(\d+)/
const FILL_LIGHT = (ctx) => {
  const m = ctx.notes.map((n) => MIRROR_NOTE.exec(n)).find(Boolean)
  const mx = m ? Number(m[1]) : null
  const mz = m ? Number(m[2]) : null
  const mw = m ? Number(m[3]) : 0
  const md = m ? Number(m[4]) : 0
  return {
    cap: FILL_CAP,
    gap: 1,
    deadReach: 1,
    spawn: () => SPAWN_CELLS.map((c) => globalCell(0, { ...c, cy: GROUND })),
    // The fixtures take the pavilion's colours: the maze's own tint over the
    // field, the bulb string's over the midway, booths and lobby, and the
    // black light's over the dark ride.
    tint: (d, lx, lz, gx, gz, cy) => {
      if (cy !== GROUND) return UV_FILL
      const tx = ctx.key?.tx ?? 0
      const x = gx - tx * TILE_CELLS_X
      const f = x >= 0 && x < TILE_CELLS_X && gz >= 0 && gz < TILE.d * CHUNK ? skeletonOf(ctx.worldSeed, tx).frame[gz * TILE_CELLS_X + x] : -1
      return f === F_FIELD ? fieldTintOf(ctx.worldSeed, tx) : BULB
    },
    where: (d, lx, lz, gx, gz, cy) => {
      // Booths and the ride's backstage (storage) stay as dark as they were left.
      if (d.spaceRole[lz * CHUNK + lx] === SPACE_ROLE_STORAGE || !underCap(d)) return false
      if (mx === null || cy !== GROUND) return true
      const x = gx - ctx.origin.cx * CHUNK - mx
      const z = gz - ctx.origin.cz * CHUNK - mz
      return x < 0 || x >= mw || z < 0 || z >= md
    },
  }
}

export default Object.freeze({
  family: MAP_FAMILY_FUNHOUSE,
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
    return buildFunhouseTile(canvas, ctx.tileSeed, ctx)
  },
})
