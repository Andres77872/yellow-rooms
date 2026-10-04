import { CHUNK } from '../../constants.js'
import { DEP, MEZ, TILE, atriumAsCatalog, exitAnchor, footprint, layoutOf, pierPartsOf, ports } from './geometry.js'
import { buildTerminalTile } from './tile.js'

// The terminal generator (spec §6.5, §12.7). Backend 'band': one bake draws
// a 4×4-chunk section of the endless concourse over storeys −1..1 (baggage,
// departures, mezzanine) in tile row 0, or the far parts of its long
// piers in an apron row (±1, ±2; departures only), composed by the tile
// grammar (geometry.layoutOf, tile.js); the spine atrium comes from the
// planner (structures.js) through the world kit, whose kit.atrium reads
// atriumAsCatalog (§7.4) from here (makeTileCtx).
export { TILE, footprint, ports, exitAnchor, atriumAsCatalog }

// Fill light (tiles/fillLight.js, I-playfix): plain fixtures over the
// circulation the tile's own lamps leave dark (rooms keep the tile's own
// lighting: half of them stand dark), and one over the spawn. A dead pier (the
// grammar's roll, or the 'dead' anomaly) stays dark: its body rows and the
// apron columns beside it on departures.
const CAP = 10
// The mezzanine is a dim lounge level: a chunk whose own lounge pendants
// already burn five takes no fill there.
const MEZ_CAP = 5
const FILL_LIGHT = (ctx) => {
  const l = layoutOf(ctx.worldSeed, ctx.key.tx)
  const isDead = (p) => p.i === l.deadPier || (l.anomaly === 'dead' && p.i === l.anomalyPier)
  // In an apron row's tile, the parts of the piers that run on there.
  const row0 = ctx.key.tz === 0
  const dead = (row0 ? l.piers : pierPartsOf(ctx.worldSeed, ctx.key.tx, ctx.key.tz)).filter(isDead)
  // A chunk-storey the tile already lit to the cap takes no fixture: its
  // cells are left out of the pass (counted once, on first sight).
  const full = new WeakMap()
  const capped = (d) => {
    let v = full.get(d)
    if (v === undefined) full.set(d, (v = d.lamps.reduce((n, x) => n + (x.lit ? 1 : 0), 0) >= (d.cy === MEZ - 1 ? MEZ_CAP : CAP)))
    return v
  }
  return {
    cap: CAP,
    spawn: () => (row0 ? l.spawnCells : []),
    where: (d, lx, lz, gx, gz, cy) => {
      if (d.spaceId[lz * CHUNK + lx] !== 0 || capped(d)) return false
      if (cy !== DEP - 1 || !dead.length) return true
      const x = gx - ctx.origin.cx * CHUNK
      const z = gz - ctx.origin.cz * CHUNK
      return !dead.some((p) => x >= p.x0 - 1 && x <= p.x0 + p.w && z >= p.rect.z0 && z <= p.rect.z1)
    },
  }
}

export default Object.freeze({
  family: 'terminal',
  ready: true,
  light: FILL_LIGHT,
  stub: false,
  tile: TILE,
  footprint,
  ports,
  exitAnchor,
  atriumAsCatalog,
  paramsFor() {
    return {}
  },
  bake(canvas, ctx) {
    return buildTerminalTile(canvas, ctx.tileSeed, ctx)
  },
})
