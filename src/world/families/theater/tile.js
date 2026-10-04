import { CHUNK, cIdx } from '../../constants.js'
import {
  CELL_OPEN,
  COLUMN_STANDARD,
  FACING,
  SPACE_ROLE_NONE,
  WALL_TO_FRONT,
  addPiece,
  labelFloor,
} from '../../tiles/floorPlan.js'
import { stairwellPlan } from '../../structures/authored.js'
import { finiteCtx, markExit, markSpawn } from '../../tiles/kit.js'
import { openOwnedSeam } from '../../tiles/seams.js'
import {
  ANOMALY_CLASSES,
  BAND_TOP,
  BASE,
  FLOORS,
  GROUND,
  HOUSES,
  N,
  anomalyAt,
  finiteScheme,
  housePlan,
  inRect,
  keptLocal,
  participantChunk,
  roll,
  schemeOf,
} from './geometry.js'
import {
  BULB,
  CLS_BRIDGE,
  CLS_CORE,
  CLS_NONE,
  CLS_PIER,
  CLS_PILLAR,
  CLS_STAIR,
  CLS_VOID,
  MIRROR,
  WORK,
  planTheatre,
} from './layout.js'

// 11 — The Empty Theater (docs/liminal_maps/11-empty-theater.md): one
// theatre per 3×3-chunk world tile, dark, every seat facing one bulb on a
// stand — and no two theatres alike.
//
// The scheme (geometry.js, the grammar) rolls the building: the house
// volume's class, storeys, chunks, bounds, orientation, stage, opening,
// pit, gangways, fly tower, circles and boxes, its stair core, and the band
// around it (strips, corridor lanes, stair slots). The infill (layout.js)
// rolls each storey's rooms, doors, halls, seats, props and lamps into a
// raster. This module only draws: it writes the rasters into the kept
// chunks, stamps the house (ctx.kit.catalog: the planner's 'theaterCatalog'
// volume, slot 0, at true global coordinates in the world) and the band's
// stairwells (ctx.kit.stairwell), redraws the rasters over what the stamps
// carved (never their voids, decks, piers, cores, rails or core walls),
// opens the owned seams at the ports, then hangs lamps, plates and
// furniture.
//
// Storeys (kind-local; world = kind − 1): 0 basement (trap room, understalls,
// cellars), 1 ground (stalls, stage, lobby, dressing rooms), 2 first (dress
// circle, fly floor, foyer), 3 second (upper circle, fly gallery), 4 loft
// (grid). Above the first floor only the house volume stands.

export { BULB, MIRROR, WORK }

const ANOMALY_NOTES = Object.freeze({
  upstage: 'the ghost light has moved upstage',
  missing: 'one seat row is missing from the stalls',
  turned: 'one stalls row faces the back of the house',
  plates: 'every level plate reads 5tAL (stalls)',
})
const PLATES = Object.freeze(['trAP', '5tAL', 'dC', 'UC', 'LoFt'])

// The world's lamp cap (spec §11.1 item 9): at most 12 lit lamps per
// chunk-storey.
const LIT_CAP = 12
// §11.1: at most 14 prop kinds per chunk; the furniture pass stops adding
// new kinds to a chunk at this many.
const KIND_CAP = 12

// The kind lab's finite ctx.
export const FINITE_CTX_THEATER = finiteCtx({})

// The chunk of kind-local (lcx, s, lcz), touched once and marked written
// whole (every cell of a kept chunk is drawn here; the canvas does not
// mass-fill it again at export).
function chunkFor(map, lcx, s, lcz) {
  const d = map._touch(lcx, s, lcz)
  map.markWritten?.(d)
  return d
}

// Write kind-local chunk (lcx, lcz) of storey `st` into chunk data `d`: its
// cells (`cellOk(i)` false keeps a cell as drawn) and its owned lines — V
// lines lx 0..13, H lines lz 0..13 (never the line the next chunk owns);
// `skip(gx, gz)` cells keep their edges as the stamps drew them.
function writeChunk(d, st, lcx, lcz, { cellOk = null, skip = null } = {}) {
  const x0 = lcx * CHUNK
  const z0 = lcz * CHUNK
  for (let lz = 0; lz < CHUNK; lz++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      const i = (z0 + lz) * N + x0 + lx
      if (cellOk && !cellOk(i)) continue
      const c = cIdx(lx, lz)
      const id = st.reg[i]
      if (!id) {
        d.cellKind[c] = CELL_OPEN
        d.spaceRole[c] = SPACE_ROLE_NONE
        d.spaceId[c] = 0
        d.setCol(lx, lz, COLUMN_STANDARD)
        continue
      }
      const r = st.regions[id]
      d.cellKind[c] = r.kind
      d.spaceRole[c] = r.role
      d.spaceId[c] = r.space
      d.setCol(lx, lz, st.cls[i] === CLS_PILLAR ? COLUMN_STANDARD : 0)
    }
  }
  for (let lz = 0; lz < CHUNK; lz++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      const gx = x0 + lx
      const gz = z0 + lz
      if (!skip || !(skip(gx - 1, gz) || skip(gx, gz))) {
        const e = st.edgeState(gx - 1, gz, gx, gz)
        d.setV(lx, lz, e.wall, e.passage, e.feature)
      }
      if (!skip || !(skip(gx, gz - 1) || skip(gx, gz))) {
        const e = st.edgeState(gx, gz - 1, gx, gz)
        d.setH(lx, lz, e.wall, e.passage, e.feature)
      }
    }
  }
}

function keptChunks(sc, s) {
  const out = []
  for (let lcz = 0; lcz < 3; lcz++) for (let lcx = 0; lcx < 3; lcx++) if (keptLocal(sc, lcx, s, lcz)) out.push([lcx, lcz])
  return out
}

// The world's lamp cap: the surplus lit lamps of a crowded chunk-storey go
// dead, picked by the dice (tile mode only).
function capLitLamps(map, seed, cap) {
  for (const d of map.chunks.values()) {
    const lit = d.lamps.filter((l) => l.lit)
    if (lit.length <= cap) continue
    const rank = (l) => roll(seed, 1000 + (d.cy & 7) * 256 + l.lx * 16 + l.lz, d.cx * 64 + d.cz)
    lit.sort((a, b) => rank(a) - rank(b) || a.lx - b.lx || a.lz - b.lz)
    for (const l of lit.slice(cap)) l.lit = false
  }
}

// THE tile program of the theater family (spec §3.3, §12.8). In the kind lab
// (finite ctx) it draws a sample theatre of the seed (always five storeys);
// in tile mode the theatre of tile ctx.key at ctx.origin (kind storeys 0..4 =
// world −1..3).
export function buildTheaterTile(map, seed, ctx = FINITE_CTX_THEATER) {
  const tile = ctx.mode === 'tile'
  const sc = tile ? schemeOf(ctx.worldSeed, ctx.key) : finiteScheme(seed)
  const anomaly = tile ? anomalyAt(ctx.worldSeed, ctx.key) : ANOMALY_CLASSES[roll(seed, 1) % ANOMALY_CLASSES.length]
  const oy = map.origin?.cy ?? 0
  const portsOf = tile ? (side, s) => ctx.portsAt?.(side, s + oy) ?? [] : null
  const { storeys, info } = planTheatre(sc, { tile, anomaly, portsOf })

  // --- 1. every storey's raster into its kept chunks ---------------------------------
  for (let s = 0; s < FLOORS; s++) {
    const st = storeys[s]
    if (!st) continue
    for (const [lcx, lcz] of keptChunks(sc, s)) writeChunk(chunkFor(map, lcx, s, lcz), st, lcx, lcz)
  }

  // --- 2. the house volume -------------------------------------------------------------
  let k = 0
  let why = null
  const h = HOUSES[sc.house]
  const desc = ctx.kit.catalog(
    map,
    housePlan(sc),
    {
      id: 0x0ba10001, family: tile ? 'theater' : 'hotel', type: h.type, sizeClass: h.sizeClass,
      district: { x: 0, z: 0, size: 3 }, bandIndex: 0, slot: tile ? 0 : -1, baseCy: BASE,
    },
    (n) => roll(seed, 50 + k++, n) % n,
    (reasons) => { why = reasons },
  )
  if (!desc) return { error: `theater: house volume rejected (${(why ?? (tile ? ['planner null slot'] : [])).join(', ')})` }

  // --- 3. the band's stairwells (basement → first floor) ------------------------------
  for (const t of sc.skeleton.stairs) {
    const sp = stairwellPlan({ ...t.plan, baseCy: BASE, topCy: BAND_TOP })
    if (sp.error) return { error: `theater stair: ${sp.error}` }
    ctx.kit.stairwell(map, sp, { enclosed: true })
  }

  // --- 4. redraw the rasters over the stamped participant chunks -----------------------
  const keepStamp = (st) => (gx, gz) => {
    if (gx < 0 || gz < 0 || gx >= N || gz >= N) return false
    const c = st.cls[gz * N + gx]
    return c === CLS_VOID || c === CLS_BRIDGE || c === CLS_CORE || c === CLS_PIER || c === CLS_STAIR
  }
  const box = { x0: sc.bounds.x0 - 1, z0: sc.bounds.z0 - 1, x1: sc.bounds.x1 + 1, z1: sc.bounds.z1 + 1 }
  for (let s = 0; s < sc.NL; s++) {
    const st = storeys[s]
    const skip = keepStamp(st)
    for (const [lcx, lcz] of keptChunks(sc, s)) {
      if (!participantChunk(sc, lcx, lcz)) continue
      // Inside the carve box the stamp's labels stand on walkable cells
      // (ring lobby, the volume's floor) and on its voids, decks, piers and
      // core; everything else is drawn again (mass sealed, rooms, the band
      // an approach corridor may have cut through).
      const cellOk = (i) => {
        if (st.cls[i] !== CLS_NONE && st.cls[i] !== CLS_PILLAR) return false
        return !(st.reg[i] && inRect(box, i % N, Math.floor(i / N)))
      }
      writeChunk(chunkFor(map, lcx, s, lcz), st, lcx, lcz, { cellOk, skip })
    }
  }
  if (tile) {
    // §6.8 rule 3: open the owned West/North lines at the declared ports.
    for (let s = 0; s <= BAND_TOP; s++) {
      openOwnedSeam(map, ctx, s, 'west')
      openOwnedSeam(map, ctx, s, 'north')
    }
  }

  // --- 5. lamps -------------------------------------------------------------------------
  for (let s = 0; s < FLOORS; s++) {
    const st = storeys[s]
    if (!st) continue
    for (const l of st.lamps) {
      const lcx = Math.floor(l.gx / CHUNK)
      const lcz = Math.floor(l.gz / CHUNK)
      if (!keptLocal(sc, lcx, s, lcz)) continue
      const d = map.chunkAt(lcx, s, lcz)
      // A lamp under a slab opening would hang in mid-air (a void BELOW is fine).
      if (d && !d.hasCeilHole(l.gx - lcx * CHUNK, l.gz - lcz * CHUNK)) map.setLamp(l.gx, s, l.gz, l.lit, l.tint)
    }
  }

  // --- 6. plates, exit, spawn -------------------------------------------------------------
  const plates = anomaly === 'plates' ? Array(FLOORS).fill('5tAL') : PLATES
  for (let s = 0; s < FLOORS; s++) if (storeys[s]) labelFloor(map, s, plates[s])
  const trap = storeys[BASE]
  const exit = sc.exitCells.find((c) => trap.walk(c.gx, c.gz) && trap.cls[c.gz * N + c.gx] === CLS_NONE) ?? sc.exitCells[0]
  markExit(map, ctx, { gx: exit.gx, gz: exit.gz, cy: BASE })
  const spawnTile = tile && ctx.key.tx === 0 && ctx.key.tz === 0
  const ground = storeys[GROUND]
  const spawn = sc.spawnCells.find((c) => ground.walk(c.gx, c.gz)) ?? sc.spawnCells[0]
  if (spawnTile) markSpawn(map, ctx, { ...spawn, cy: GROUND })

  // --- 7. furniture last ------------------------------------------------------------------
  const blocked = new Set([`${BASE},${exit.gx},${exit.gz}`])
  for (const c of sc.spawnCells) blocked.add(`${GROUND},${c.gx},${c.gz}`)
  const kinds = new Map()
  for (let s = 0; s < FLOORS; s++) {
    const st = storeys[s]
    if (!st) continue
    const pieces = [...st.furn.values()].sort((a, b) => a.gz - b.gz || a.gx - b.gx)
    for (const p of pieces) {
      const lcx = Math.floor(p.gx / CHUNK)
      const lcz = Math.floor(p.gz / CHUNK)
      if (!keptLocal(sc, lcx, s, lcz) || blocked.has(`${s},${p.gx},${p.gz}`)) continue
      const d = map.chunkAt(lcx, s, lcz)
      if (!d || d.cols[cIdx(p.gx - lcx * CHUNK, p.gz - lcz * CHUNK)] !== 0) continue
      if (d.hasFloorHole?.(p.gx - lcx * CHUNK, p.gz - lcz * CHUNK)) continue
      const key = `${lcx},${s},${lcz}`
      let set = kinds.get(key)
      if (!set) kinds.set(key, (set = new Set()))
      if (!set.has(p.kind) && set.size >= KIND_CAP) continue
      set.add(p.kind)
      addPiece(map, s, { gx: p.gx, gz: p.gz, kind: p.kind, front: p.wall ? WALL_TO_FRONT[p.wall] : p.facing ?? FACING.S, wall: p.wall })
    }
  }
  if (tile) capLitLamps(map, seed, LIT_CAP)

  const boxes = sc.circles >= 1 ? (sc.boxes ? 'boxes' : 'open side galleries') : 'no circle'
  const notes = [
    `theatre: ${h.label}, ${sc.NL} storeys, ${sc.circles} circle(s), ${boxes}; stage ${sc.S} deep, a ${sc.Ow}-cell proscenium${sc.pit ? ', a railed pit' : ''}`,
    `stalls: ${info.seats.stalls} seat rows in ${sc.blocks.length} blocks; dress circle ${info.seats.dress} + ${info.seats.boxes} box seats; upper circle ${info.seats.upper}`,
    `look at: the ghost light ${anomaly === 'upstage' ? 'UPSTAGE (moved)' : 'downstage centre'} — the only lit lamp in house and stage`,
    `band: ${sc.skeleton.strips.length} wings, ${info.rooms} rooms (${info.halls} halls, ${info.dressing} dressing rooms), ${sc.skeleton.stairs.length} stairwell(s)`,
    `anomaly: ${anomaly ? ANOMALY_NOTES[anomaly] : 'none'}`,
    'stand-ins: no rake, stage height or traps (S1) — the stalls and stage are flat on one storey; seats are box seat rows, one row per 3 m cell; pit and fly voids are railed, not lethal',
  ]
  if (tile) ctx.notes.push(...notes)
  return {
    spawn: { gx: spawn.gx, gz: spawn.gz, cy: GROUND },
    exit: { gx: exit.gx, gz: exit.gz, cy: BASE },
    notes,
  }
}
