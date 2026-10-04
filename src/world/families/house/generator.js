import { CHUNK, cIdx } from '../../constants.js'
import { CELL_ROOM, PASSAGE_DOOR, PASSAGE_WIDE } from '../../mapTypes.js'
import { SPAWN_CELLS, TILE, atriumAsCatalog, bandKey, exitAnchor, footprint, hallOf, ports } from './geometry.js'
import { LIT_CAP, buildWorldHouse, litCapOf } from './world.js'
import { WARM } from './tile.js'

// The house generator (spec §6.5, §12.11). Backend 'band': one bake draws a
// 3×2-chunk tile over storeys 0..2 (the upper storeys over the chunks the
// tile's frame keeps) with the tile program (world.js), which grows the
// tile's floor plans from the family grammar (layout.js); the Great Hall
// comes from the planner (structures.js) through the world kit's atrium,
// which converts the tile program's atrium spec with
// geometry.atriumAsCatalog (§7.4).
export { TILE, footprint, ports, exitAnchor, atriumAsCatalog }

// Fill light (tiles/fillLight.js, I-playfix): warm fixtures (the house's
// practicals) over the cells the tile's own lamps leave dark — hallways and
// the rooms whose pendant the chunk's light budget took down — and one over
// the spawn, up to LIT_CAP lit per chunk-storey (the 60 u gate counts them).
// A dead pendant (a room dark by design) keeps its darkness (deadReach). The
// Great Hall (and its ring) of a hall tile stays dark and unlit.
// A room's door cells (a doorway on one of its edges in its chunk): a
// fixture there lights the room and the hallway outside it.
const DOOR_CELLS = new WeakMap()
function doorMask(d) {
  let m = DOOR_CELLS.get(d)
  if (m) return m
  m = new Uint8Array(CHUNK * CHUNK)
  const door = (p) => p === PASSAGE_DOOR || p === PASSAGE_WIDE
  for (let lz = 0; lz < CHUNK; lz++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      if (d.cellKind[cIdx(lx, lz)] !== CELL_ROOM) continue
      if ((!d.vAt(lx, lz) && door(d.passageVAt(lx, lz))) || (lx + 1 < CHUNK && !d.vAt(lx + 1, lz) && door(d.passageVAt(lx + 1, lz))) ||
        (!d.hAt(lx, lz) && door(d.passageHAt(lx, lz))) || (lz + 1 < CHUNK && !d.hAt(lx, lz + 1) && door(d.passageHAt(lx, lz + 1)))) m[cIdx(lx, lz)] = 1
    }
  }
  DOOR_CELLS.set(d, m)
  return m
}

// A chunk-storey whose own lamps already spend the budget (lightStorey)
// takes no fixture: the pass skips its cells (and its cost).
// The check follows the pass's own fixtures (keyed by the lamp count), so a
// chunk of the middle column stops at its smaller budget (world.litCapOf).
const FULL = new WeakMap()
function full(d, origin) {
  const n = d.lamps.length
  let f = FULL.get(d)
  if (f === undefined || f.n !== n) {
    f = { n, full: d.lamps.filter((l) => l.lit).length >= litCapOf(d, origin) }
    FULL.set(d, f)
  }
  return f.full
}

const FILL_LIGHT = (ctx) => {
  const hall = hallOf(ctx.worldSeed, bandKey(ctx.key.tx, ctx.key.tz))
  const ring = hall?.geometry.ring ?? null
  return {
    cap: LIT_CAP,
    spawn: () => SPAWN_CELLS,
    tint: () => WARM,
    where: (d, lx, lz, gx, gz) => {
      if (full(d, ctx.origin)) return false
      if (d.cellKind[cIdx(lx, lz)] === CELL_ROOM && !doorMask(d)[cIdx(lx, lz)]) return false
      if (!ring) return true
      const x = gx - ctx.origin.cx * CHUNK
      const z = gz - ctx.origin.cz * CHUNK
      return x < ring.x0 || x > ring.x1 || z < ring.z0 || z > ring.z1
    },
  }
}

export default Object.freeze({
  family: 'house',
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
    return buildWorldHouse(canvas, ctx)
  },
})
