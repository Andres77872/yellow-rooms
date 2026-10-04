import {
  CELL_BRIDGE,
  CELL_CORRIDOR,
  CELL_LOBBY,
  CELL_OPEN,
  CELL_ROOM,
  CELL_STAIR,
  CELL_VOID,
  COLUMN_STANDARD,
  FACING,
  FloorPlan,
  PASSAGE_DOOR,
  PASSAGE_OPEN,
  PASSAGE_WALL,
  PASSAGE_WIDE,
  SPACE_ROLE_BATHROOM,
  SPACE_ROLE_NONE,
  SPACE_ROLE_STORAGE,
  WALL_PLAIN,
  WALL_RAIL,
  WALL_TO_FRONT,
  WALL_WINDOW,
  addPiece,
  featureEdge,
  labelFloor,
  rng,
} from '../../tiles/floorPlan.js'
import { FURN_CABINET, FURN_COOLER, FURN_PLANT, FURN_RACK, FURN_SINK, FURN_WARDROBE } from '../../rooms/catalog.js'
import {
  PROP_BANDAI,
  PROP_KICKBOARD,
  PROP_LIFEGUARD_CHAIR,
  PROP_LOST_BIN,
  PROP_LOUNGER,
  PROP_STARTING_BLOCK,
} from '../../props/index.js'
import { finiteCtx, markExit, markSpawn } from '../../tiles/kit.js'
import { stairwellPlan } from '../../structures/authored.js'
import { STAIR_E, STAIR_N, STAIR_S, STAIR_W } from '../../structures/slab.js'
import { createRoom } from '../../tiles/roomOps.js'
import { CHUNK, chunkKey3, hIdx, vIdx } from '../../constants.js'
import { FILL_DEFAULTS, fillDarkCells } from '../../tiles/fillLight.js'
import { STAIR_DOWN_RUN, STAIR_UP_RUN, holeMasks } from '../../tiles/holeMasks.js'
import { openOwnedSeam } from '../../tiles/seams.js'
import { planPick } from '../../tiles/tileKey.js'
import {
  BASIN,
  DECK,
  FAMILY,
  GALLERY,
  LAST,
  R,
  SALT,
  TILE,
  anomalyAllowed,
  anomalyAt,
  grow,
  inRect,
  pitExitCell,
  pitOf,
  poolPlan,
  ropeSiteOf,
  tilePorts,
  tileVolumes,
  volumesOf,
} from './geometry.js'
import { chamberAnomalies, darkRefuge, spawnCandidates, tileGrammar } from './grammar.js'

// 01 Poolrooms (docs/liminal_maps/01-poolrooms.md) — white tile chambers and
// drained basins. There is no water and no floor offset yet (S1/S2), so a
// basin is a whole storey deep: the deck (cy 1) has railed voids over the
// basin floor (cy 0), each pool a catalog volume whose own flights are the
// stairs down into the pit; a natatio vault rises one more storey to a
// glass-fronted balcony on the upper gallery (cy 2), which an enclosed stair
// core joins to the deck in every tile.
//
//   cy 2  gallery    the upper level: sun terraces, colonnaded walks, viewing
//                    rooms and dark lofts round the natatio's balcony (cyan
//                    troffers over the vault) and the stair core's lobby
//   cy 1  deck       pool halls, tiled chambers, channels, a lazy river, a sentō
//   cy 0  basin      drained pool floors (walled pits), service tunnels, plant rooms
//
// THE tile program of the poolrooms family (spec §3.3, §12.4). It is a
// GRAMMAR, not a template: per tile, geometry.volumesOf rolls which basins
// exist and where (planner-shared, true global coordinates in tile mode) and
// grammar.js partitions the deck, the basin and the gallery round them and
// round the tile's stair core (chambers, channels, modules, mouths, loops,
// dead ends). This program compiles that
// abstract layout into FloorPlans, stamps the volumes through ctx.kit,
// restores the halls' walls the stamp opened, walls the drained pools, lights
// and dresses everything from the pool pack, and marks the exit (the pit
// floor) and, in tile (0,0), the spawn.
//
// Finite mode (the editor kind, src/editor/kinds/poolrooms.js) draws ONE
// sample tile from the kind seed with no seam ports and a natatio always
// present (so the kind keeps its three storeys); the editor kit assembles
// the volumes itself with the same first picks the planner would use.

export const POOL_TINT = 0xa8f0ff // pool light: the cyan tint over every basin
const DAYLIGHT_TINT = 0xe6f2ff // the gallery terraces' cool daylight

// The kind lab's finite ctx.
export const FINITE_CTX_POOLROOMS = finiteCtx({})

const PASSAGES = Object.freeze({ wall: PASSAGE_WALL, wide: PASSAGE_WIDE, door: PASSAGE_DOOR, open: PASSAGE_OPEN })
const FEATURES = Object.freeze({ plain: WALL_PLAIN, window: WALL_WINDOW, rail: WALL_RAIL })
const SPACE_BASE = Object.freeze({ deck: 200, basin: 700, gallery: 1200 })
const STAIR_DIR = Object.freeze({ E: STAIR_E, W: STAIR_W, S: STAIR_S, N: STAIR_N })
const FULL = R(0, 0, LAST, LAST)
const OPPOSITE = Object.freeze({ E: 'W', W: 'E', N: 'S', S: 'N' })

export function buildPoolroomsTile(map, seed, ctx = FINITE_CTX_POOLROOMS) {
  const tile = ctx.mode === 'tile'
  // Every roll is pure per tile: the planSeed in tile mode (the planner, the
  // grammar and every bake attempt agree), the kind seed in finite mode.
  const planSeed = tile ? ctx.planSeed >>> 0 : seed >>> 0
  const anomaly = tile ? anomalyAt(ctx.worldSeed, ctx.key) : null
  const vols = tile ? tileVolumes(ctx.worldSeed, ctx.key.tx, ctx.key.tz) : volumesOf(planSeed, null, { force: true })
  const ports = tile ? tilePorts(ctx.worldSeed, ctx.key.tx, ctx.key.tz) : null
  const g = tileGrammar(planSeed, vols, ports)
  const r = rng(planSeed, SALT)
  const notes = []

  // --- plans (every storey compiled before any stamp) -------------------------
  const basin = new FloorPlan(FULL)
  const deck = new FloorPlan(FULL)
  emit(basin, g.basin, SPACE_BASE.basin)
  emit(deck, g.deck, SPACE_BASE.deck)
  const nat = vols.find((v) => v.levels > 2) ?? null
  // The upper gallery: its own grammar storey round the vault's balcony and
  // the stair core (all rock where the tile has neither).
  const gallery = new FloorPlan(FULL)
  if (g.gallery) emit(gallery, g.gallery, SPACE_BASE.gallery)
  const calm = tile ? Math.max(Math.abs(ctx.key.tx), Math.abs(ctx.key.tz)) : DEEP_REACH.length - 1
  const deepReach = DEEP_REACH[Math.min(calm, DEEP_REACH.length - 1)]
  const darkChamber = lampDeck(deck, g.deck, vols, r, anomaly, deepReach)
  // The gallery's back rooms are darker: unlit lofts, about a fifth of its
  // floor.
  if (g.gallery) lampDeck(gallery, g.gallery, vols, r, anomaly, deepReach, false, 0, GALLERY_DARK)
  if (g.gallery && nat) lampGallery(gallery, nat)
  basin.compile(map, BASIN)
  deck.compile(map, DECK)
  gallery.compile(map, GALLERY)
  if (tile) {
    // §6.8 rule 3: open the owned West/North lines at the declared ports.
    for (const cy of [BASIN, DECK, GALLERY]) {
      openOwnedSeam(map, ctx, cy, 'west')
      openOwnedSeam(map, ctx, cy, 'north')
    }
  }

  // --- catalog volumes: the pools ---------------------------------------------------
  for (const v of vols) {
    let why = null
    const desc = ctx.kit.catalog(
      map,
      poolPlan(v),
      {
        id: 0x01a10001 + v.slot, family: tile ? FAMILY : 'tower', type: v.type, sizeClass: v.sizeClass,
        district: { x: 0, z: 0, size: TILE.w }, bandIndex: 0, slot: tile ? v.slot : -1, baseCy: BASIN,
      },
      planPick(planSeed, v.slot, 0),
      (reasons) => { why = reasons },
    )
    if (!desc) return { error: `poolrooms: ${v.type} volume rejected (${(why ?? ['planner null slot']).join(', ')})` }
  }

  // --- touch-ups ---------------------------------------------------------------------
  // The stamp opened every carve box's outer edges: put back the grammar's
  // walls, mouths and glass there (plain walls where the outside is mass).
  for (const v of vols) {
    restoreRim(map, BASIN, v.box, g.basin)
    restoreRim(map, DECK, v.box, g.deck)
    if (v.levels > 2) restoreRim(map, GALLERY, v.box, g.gallery)
  }
  // The stair core: one enclosed switchback from the deck up to the gallery.
  const stair = g.stair
  if (stair) {
    const sp = stairwellPlan({ gx: stair.gx, gz: stair.gz, baseCy: DECK, topCy: GALLERY, dir: STAIR_DIR[stair.dir], doorSide: stair.doorSide })
    if (sp.error) return { error: `poolrooms: stair core (${sp.error})` }
    ctx.kit.stairwell(map, sp, { enclosed: true })
  }
  // Drained pools: each pool rect is walled off on the basin floor, with
  // steps (openings) at its shallow end only (the pit: one, on a rolled side).
  for (const v of vols) {
    const shallow = v.deepSide ? OPPOSITE[v.deepSide] : ['W', 'N', 'E', 'S'][r(7, v.slot) % 4]
    const steps = v.type === 'pitRoom' ? 1 : 2
    if (!basinWalls(map, v.pool, shallow, steps)) return { error: `poolrooms: ${v.type} basin has no step` }
  }
  // Whatever the stamps carved through grammar rock (the catalog's approach
  // corridor, a flight's landing) gets a wall face against the rock round it.
  for (const cy of [BASIN, DECK, GALLERY]) sealMass(map, cy)
  // Lamps under the pools' openings would hang in mid-air.
  for (const d of map.chunks.values()) d.lamps = d.lamps.filter((l) => !d.hasCeilHole(l.lx, l.lz))
  // Depth plates that lie: the basin floor counts past any real pool, the
  // gallery above a two-storey drop reads "3 FT".
  const depths = ['12Ft', '40Ft', '300F']
  const turn = r(8) % 3
  for (let cx = 0; cx < TILE.w; cx++) labelFloor(map, BASIN, depths[(cx + turn) % 3], { cx })
  labelFloor(map, GALLERY, '3 Ft')
  const pit = pitOf(vols)
  // Anomaly 'deep': the too-deep well's own plate counts past them all.
  const pitChunk = { cx: Math.floor((pit.pool.x0 + pit.pool.x1) / 2 / 14), cz: Math.floor((pit.pool.z0 + pit.pool.z1) / 2 / 14) }
  if (anomaly === 'deep') labelFloor(map, BASIN, '999F', pitChunk)
  // Anomaly 'rope': a lane rope across a chamber mouth whose loss keeps the
  // deck whole; which one is hashed from the planSeed. Then the chamber
  // anomalies (grammar.js chamberAnomalies: about 1 per 6 chambers, ropes
  // and lone loungers), strung after it so every rope keeps the deck whole.
  let rope = null
  let tileRope = null
  if (anomaly === 'rope' && g.deck.ropeSites.length) {
    const i = ropeSiteOf(planSeed, g.deck.ropeSites.length)
    rope = g.deck.ropeSites[i]
    tileRope = g.deck.ropeLinks[i]
  }
  const chamberAnoms = tile && anomalyAllowed(ctx.worldSeed, ctx.key.tx, ctx.key.tz) ? chamberAnomalies(planSeed, g.deck, tileRope) : []
  const ropes = chamberAnoms.filter((a) => a.cls === 'rope').map((a) => a.link.edges.map((e) => ({ axis: e.axis, gx: e.gx, gz: e.gz })))
  for (const site of ropes) for (const e of site) featureEdge(map, e.axis, e.gx, DECK, e.gz, WALL_RAIL)
  // The exit is at the bottom of the unlit pit.
  const exit = pitExitCell(planSeed, pit.pool)
  markExit(map, ctx, exit)
  // The world's spawn: the deck of tile (0,0), off the basin rims (the
  // finite kind's spawn likewise).
  const home = !tile || (ctx.key.tx === 0 && ctx.key.tz === 0)
  const spawns = home ? spawnCandidates(g.deck) : []
  if (tile && home && spawns.length) markSpawn(map, ctx, { ...spawns[0], cy: DECK })

  // --- furniture ------------------------------------------------------------------------
  // The sentō's bathing room through the furnishing grammar (tub, sink,
  // toilet anchors); its one door is the curtain from the changing room.
  const bath = g.deck.regions.find((x) => x.type === 'bath' && !x.mass)
  if (bath) {
    const curtain = g.deck.links.find((l) => l.kind === 'curtain').edges[0]
    createRoom(map, {
      cy: DECK, ...bath.rect, role: SPACE_ROLE_BATHROOM, salt: r(11) % 997,
      door: { axis: curtain.axis, gx: curtain.gx, gz: curtain.gz }, lamp: true,
    })
  }
  const halos = new Set()
  for (const v of vols) {
    for (const h of v.halos) {
      for (let gz = h.rect.z0; gz <= h.rect.z1; gz++) for (let gx = h.rect.x0; gx <= h.rect.x1; gx++) halos.add(`${h.cy},${gx},${gz}`)
    }
  }
  // Nothing stands on the exit cell or the spawn candidates.
  halos.add(`${exit.cy},${exit.gx},${exit.gz}`)
  for (const c of spawns) halos.add(`${DECK},${c.gx},${c.gz}`)
  // Nor on a seam port or the cell inside it (the deck's way to the next tile).
  for (const [side, list] of Object.entries(ports ?? {})) {
    for (const pr of list) {
      for (let a = pr.a0; a <= pr.a1; a++) {
        for (const t of side === 'west' || side === 'north' ? [0, 1] : [LAST, LAST - 1]) {
          const [gx, gz] = side === 'west' || side === 'east' ? [t, a] : [a, t]
          halos.add(`${DECK},${gx},${gz}`)
        }
      }
    }
  }
  // Nor in the stair core or the lobby ring round it (its door's landing).
  if (stair) {
    for (const cy of [DECK, GALLERY]) {
      for (let gz = stair.box.z0; gz <= stair.box.z1; gz++) for (let gx = stair.box.x0; gx <= stair.box.x1; gx++) halos.add(`${cy},${gx},${gz}`)
    }
  }
  // Nor in a rope's mouth (the rails are the anomaly, not a blocked cell).
  for (const e of ropes.flat()) for (const [dx, dz] of [[0, 0], [e.axis === 'v' ? -1 : 0, e.axis === 'h' ? -1 : 0]]) halos.add(`${DECK},${e.gx + dx},${e.gz + dz}`)
  const put = (cy, gx, gz, kind, opts) => placeSafe(map, halos, cy, gx, gz, kind, opts)
  // Is there a wall (plain or glass) on side N/E/S/W of cell (gx, gz) of
  // storey cy?
  const wallOn = (gx, gz, side, cy) => {
    const h = side === 'N' || side === 'S'
    const x = side === 'E' ? gx + 1 : gx
    const z = side === 'S' ? gz + 1 : gz
    const d = map.chunkAt(map.cellChunk(x), cy, map.cellChunk(z))
    if (!d) return false
    const lx = map.cellLocal(x)
    const lz = map.cellLocal(z)
    return (h ? d.wallH[hIdx(lx, lz)] : d.wallV[vIdx(lx, lz)]) > 0
  }
  // The chamber anomaly 'towel': a lone lounger in the middle of the
  // chamber, facing its nearest wall (placed before the rooms' dressing).
  for (const a of chamberAnoms) {
    if (a.cls !== 'towel') continue
    const { x0, z0, x1, z1 } = g.deck.regions[a.region].rect
    const mx = Math.floor((x0 + x1) / 2)
    const mz = Math.floor((z0 + z1) / 2)
    const toWall = [[mz - z0, FACING.N], [x1 - mx, FACING.E], [z1 - mz, FACING.S], [mx - x0, FACING.W]].sort((p, q) => p[0] - q[0])[0][1]
    for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [-1, 0], [0, -1]]) {
      if (put(DECK, mx + dx, mz + dz, PROP_LOUNGER, { facing: toWall })) {
        a.placed = true
        break
      }
    }
  }
  const placed = furnishPools(put, r, vols, exit)
  furnishRooms(put, r, g, vols, wallOn, new Set(chamberAnoms.map((a) => a.region)))
  // The lamp cap: ≤ 9 of the tile's own tubes lit per chunk-storey (the
  // fill-light pass stops at 9 too, generator.js; the world gates are 12 per
  // chunk-storey and 72 within 60 u, and a whole deck at 10 per chunk can
  // pass 72): the surplus tubes of a crowded chunk are dead, picked by the
  // dice.
  pruneLamps(map, DECK, LIT_CAP, 3)
  pruneLamps(map, GALLERY, LIT_CAP, LIT_CAP)
  capLitLamps(map, r, LIT_CAP)
  const refuge = darkRefuge(g.basin)?.rect ?? null
  lampBasin(map, vols, anomaly, refuge)
  // The finite kind gets the world bake's fill light (generator.js runs the
  // same spec in finishBake), so the kind lab measures what a player sees.
  if (!tile) kindFill(map, vols, anomaly)

  const s = g.deck.stats
  notes.push(
    `program: ${vols.map((v) => `${v.type} ${v.pool.x1 - v.pool.x0 + 1}×${v.pool.z1 - v.pool.z0 + 1} at ${v.box.x0},${v.box.z0}`).join('; ')}`,
    `deck: ${s.chambers} chambers, ${s.channels} channels, ${s.mouths} mouths, ${s.loops} loops, ${s.deadEnds} dead ends` +
      `, ${s.walks} walks, ${s.arcades} arcades${g.deck.regions.some((x) => x.type === 'river') ? ', a lazy-river ring' : ''}${bath ? ', a sentō' : ''}; chamber ${darkChamber} dark`,
    `basin: ${g.basin.stats.chambers} service rooms, ${g.basin.stats.channels} tunnels, ${g.basin.stats.loops} loops`,
    `pit room: a ${pit.pool.x1 - pit.pool.x0 + 1}×${pit.pool.z1 - pit.pool.z0 + 1} well with no light; the exit is at its bottom`,
    `furniture: ${placed.blocks} starting blocks, ${placed.loungers} loungers, ${placed.chairs} lifeguard chairs`,
    'stand-ins: no water or floor offsets (S1/S2), so basins are storey-deep drained pits; cyan troffers stand for skylights and pool lights (S4); the dry 1-cell tunnels under the deck stand for submerged passages',
  )
  if (tile) {
    ctx.notes.push(...notes)
    if (anomaly) ctx.notes.push(`anomaly: ${anomaly}${anomaly === 'rope' && !rope ? ' (no site)' : ''}`)
    for (const a of chamberAnoms) if (!a.tile) ctx.notes.push(`anomaly: chamber ${a.region} ${a.cls}${a.cls === 'towel' && !a.placed ? ' (no site)' : ''}`)
  }
  return { spawn: spawns[0] ? { ...spawns[0], cy: DECK } : null, exit, notes }
}

// --- the grammar into a plan ----------------------------------------------------------------

// Region type → [cell kind, a space of its own]. The pool halls, the walks,
// the court and the stair lobby are rooms (their own spaceId: a hall is one
// tiled room round its basin), drawn as lobby floor; channels and ports are
// the circulation between them.
const CELL_OF = Object.freeze({
  hall: [CELL_LOBBY, true], lobby: [CELL_LOBBY, true], walk: [CELL_LOBBY, true], court: [CELL_LOBBY, true], chan: [CELL_CORRIDOR, false], port: [CELL_CORRIDOR, false], river: [CELL_CORRIDOR, false],
  chamber: [CELL_ROOM, true], changing: [CELL_ROOM, true], bath: [CELL_ROOM, true],
  plant: [CELL_ROOM, true], tank: [CELL_ROOM, true], sump: [CELL_ROOM, true],
})

function emit(p, gs, spaceBase) {
  for (const reg of gs.regions) {
    if (reg.mass) continue
    const [kind, room] = CELL_OF[reg.type]
    const role = reg.type === 'plant' || reg.type === 'tank' ? SPACE_ROLE_STORAGE : SPACE_ROLE_NONE
    const spaceId = room ? spaceBase + reg.id : 0
    const { x0, z0, x1, z1 } = reg.rect
    for (let gz = z0; gz <= z1; gz++) for (let gx = x0; gx <= x1; gx++) if (gs.regionAt(gx, gz) === reg) p.open(gx, gz, kind, spaceId, role)
  }
  for (const e of gs.edges) p.edge(e.axis, e.gx, e.gz, e.wall, PASSAGES[e.passage], FEATURES[e.feature])
  for (const c of gs.cols) p.column(c.gx, c.gz)
}

// --- lamps -----------------------------------------------------------------------------------

// A pool's frame: u along its long axis, w across; `at(u, w)` → [gx, gz].
function frame(v) {
  const p = v.pool
  if (v.alongX) {
    return { u0: p.x0, u1: p.x1, w0: p.z0, w1: p.z1, at: (u, w) => [u, w], deepHi: v.deepSide === 'E', face: { uLo: FACING.E, uHi: FACING.W, wLo: FACING.S, wHi: FACING.N } }
  }
  return { u0: p.z0, u1: p.z1, w0: p.x0, w1: p.x1, at: (u, w) => [w, u], deepHi: v.deepSide === 'S', face: { uLo: FACING.S, uHi: FACING.N, wLo: FACING.E, wHi: FACING.W } }
}

// Is u at the pool's deep end (the last third of its length)?
const deepAt = (f, u) => {
  const third = Math.max(1, Math.floor((f.u1 - f.u0 + 1) / 3))
  return f.deepHi ? u > f.u1 - third : u < f.u0 + third
}

// Lamps round a pool on one storey: a tube every 3 cells along the deck edge
// one cell off the water (`edgeLit(u) → lit`), and (`over`) cyan troffers
// over the water on the volume's top storey, dead over the deep end.
function poolLamps(p, v, { over, edgeLit, tint = null, bare = false, step = 3 }) {
  const f = frame(v)
  for (let u = f.u0 - 1; u <= f.u1 + 1; u += step) {
    for (const w of [f.w0 - 1, f.w1 + 1]) if (!bare || edgeLit(u)) p.lamp(...f.at(u, w), edgeLit(u), tint)
  }
  if (!over) return
  // The troffers over the water: rows 2 cells apart along the pool, 3 across.
  for (let u = f.u0 + 1; u <= f.u1; u += 2) {
    for (let w = f.w0 + 1; w <= f.w1; w += 3) p.lamp(...f.at(u, w), !deepAt(f, u), POOL_TINT)
  }
}

// The deck's light: troffers by module; a chamber in eight (at least one)
// and one channel run wholly dark ("passages with none"), and the deck within
// 7 cells of a deep end. Returns the first dark chamber's region id.
function lampDeck(p, gs, vols, r, anomaly, deepReach, pools = true, darkPer = 8, darkShare = 0) {
  const chambers = gs.regions.filter((x) => x.type === 'chamber' && !x.mass)
  const chans = gs.regions.filter((x) => x.type === 'chan' && !x.mass)
  // One dark chamber per `darkPer` (at least one) and one dark channel; on
  // the gallery (no pools) every other service passage is unlit too, and
  // its chambers go dark by area instead (`darkShare`): in a hashed order
  // until they hold that share of the storey's floor (its big rooms are
  // few, so a count would leave one gallery all lit and the next half dark).
  const darks = new Set()
  if (!darkShare) for (let i = 0; i < Math.max(1, Math.floor(chambers.length / darkPer)) && chambers.length; i++) darks.add(chambers[r(6, i + (pools ? 0 : 64)) % chambers.length].id)
  else {
    const area = (x) => (x.rect.x1 - x.rect.x0 + 1) * (x.rect.z1 - x.rect.z0 + 1)
    const total = gs.regions.reduce((a, x) => a + (x.mass || x.type === 'port' ? 0 : area(x)), 0)
    let dark = chambers.reduce((a, x) => a + (darks.has(x.id) ? area(x) : 0), 0)
    const order = chambers.map((x) => ({ x, k: r(7, x.id + 64) })).sort((a, b) => a.k - b.k || a.x.id - b.x.id)
    for (const { x } of order) {
      if (dark >= darkShare * total) break
      if (darks.has(x.id)) continue
      darks.add(x.id)
      dark += area(x)
    }
  }
  const dark = chambers.length ? chambers[r(6, 0) % chambers.length].id : -1
  const darkChan = chans.length ? chans[r(54) % chans.length].id : -1
  for (const reg of gs.regions) {
    if (reg.mass) continue
    const { x0, z0, x1, z1 } = reg.rect
    const own = (gx, gz) => gs.regionAt(gx, gz) === reg && !gs.colSet.has(gz * 42 + gx)
    if (reg.type === 'chamber' || reg.type === 'court' || reg.type === 'lobby') {
      // A 3-grid of tubes; a dark room's dead tubes on a 4-grid (sparser
      // dead fittings, the same unlit floor: the fill keeps 4 cells off a
      // dead one).
      const ox = r(40, reg.id) % 2
      const oz = r(41, reg.id) % 2
      const dead = darks.has(reg.id)
      const step = dead ? 4 : 3
      // The gallery's sun terraces burn cool daylight (doc §8: 5500–6500 K).
      const tint = !pools && reg.type === 'court' ? DAYLIGHT_TINT : null
      for (let gz = z0 + ox; gz <= z1; gz += step) {
        for (let gx = x0 + oz; gx <= x1; gx += step) if (own(gx, gz)) p.lamp(gx, gz, !dead && r(gx, gz) % 8 !== 0, tint)
      }
    } else if (reg.type === 'changing') {
      p.lamp(Math.floor((x0 + x1) / 2), z0 + 1, true)
      p.lamp(Math.floor((x0 + x1) / 2), z1 - 1, true)
    } else if (reg.type === 'river') {
      for (let gz = z0; gz <= z1; gz++) {
        for (let gx = x0; gx <= x1; gx++) if (own(gx, gz) && (gx + gz) % 4 === 0 && (gx - x0 === 0 || gz - z0 === 0 || x1 - gx === 0 || z1 - gz === 0)) p.lamp(gx, gz, r(gx, gz + 60) % 4 !== 0, POOL_TINT)
      }
    } else if (reg.type === 'chan' || reg.type === 'walk') {
      // Down the middle of a channel or a walk, every third cell.
      const alongX = x1 - x0 >= z1 - z0
      const n = alongX ? x1 - x0 + 1 : z1 - z0 + 1
      for (let i = 1 + (r(50, reg.id) % 2); i < n; i += 3) {
        const gx = alongX ? x0 + i : Math.floor((x0 + x1) / 2)
        const gz = alongX ? Math.floor((z0 + z1) / 2) : z0 + i
        if (own(gx, gz)) p.lamp(gx, gz, reg.id !== darkChan && (pools || reg.type !== 'chan' || r(55, reg.id) % 2 !== 0) && r(gx, gz + 52) % 6 !== 0)
      }
    } else if (reg.type === 'hall') {
      // The hall's margin beyond the box: plain tubes on a 3-grid, dead
      // within `deepReach` cells (DEEP_REACH, 2–7) of the basin's deep end
      // (the doc's dark deep ends; the dry deck further off stays lit).
      const v = vols[reg.vol]
      const f = frame(v)
      const third = Math.max(1, Math.floor((f.u1 - f.u0 + 1) / 3))
      // Near the spawn (deepReach under the full DEEP_REACH) the dark round
      // the pit's well reaches PIT_REACH at most: the well and the deck round
      // it unlit, the hall's walls lit (Pike: hide the floor and the far
      // end, never the walls). Further out the whole pit room is dark.
      const reach = v.type === 'pitRoom' && deepReach < DEEP_REACH[DEEP_REACH.length - 1] ? Math.min(deepReach, PIT_REACH) : deepReach
      const deepEnd = (gx, gz) => {
        const [u, w] = v.alongX ? [gx, gz] : [gz, gx]
        const near = u >= f.u0 - reach && u <= f.u1 + reach && w >= f.w0 - reach && w <= f.w1 + reach
        return near && (v.type === 'pitRoom' || (f.deepHi ? u > f.u1 - third : u < f.u0 + third))
      }
      for (let gz = z0 + 1; gz <= z1; gz += 3) for (let gx = x0 + 1; gx <= x1; gx += 3) if (!inRect(v.box, gx, gz)) p.lamp(gx, gz, !deepEnd(gx, gz))
    }
  }
  for (const v of pools ? vols : []) {
    const f = frame(v)
    if (v.type === 'pitRoom') {
      // One dead cyan tube over the well; the deck round it half dead (all
      // dead round a too-deep well).
      p.lamp(v.pool.x0, v.pool.z0, false, POOL_TINT)
      poolLamps(p, v, { over: false, edgeLit: (u) => anomaly !== 'deep' && u > f.u1 - 1 })
    } else {
      poolLamps(p, v, { over: v.levels === 2, edgeLit: (u) => !deepAt(f, u) })
    }
  }
  return dark
}

// The natatio gallery: cyan troffers over the vault (the skylight stand-in)
// that die over the deep end; the gallery ring's corners lit.
function lampGallery(p, v) {
  const f = frame(v)
  poolLamps(p, v, { over: true, edgeLit: (u) => !deepAt(f, u) || u > f.u1 })
}

// --- stamps and touch-ups ---------------------------------------------------------------

// Every edge on carve box `box`'s outline on storey cy, back to what the
// grammar `gs` drew there (null: the plan held only the box, so a wall
// wherever one side is mass). A side is walkable when its chunk exists and
// holds no mass column; one walkable side → a plain wall; two → the
// grammar's edge (a wall with glass or not, a mouth, or open).
function restoreRim(map, cy, box, gs) {
  const model = new Map()
  for (const e of gs?.edges ?? []) model.set(`${e.axis}:${e.gx},${e.gz}`, e)
  const walk = (gx, gz) => {
    const c = map.cellAt(gx, cy, gz)
    return !!c.chunk && !c.col
  }
  const set = (axis, gx, gz, ax, az, bx, bz) => {
    if (!map.chunkAt(map.cellChunk(gx), cy, map.cellChunk(gz))) return
    const a = walk(ax, az)
    const b = walk(bx, bz)
    if (!a && !b) return
    if (a !== b) {
      if (axis === 'v') map.setWallV(gx, cy, gz, 1, PASSAGE_WALL)
      else map.setWallH(gx, cy, gz, 1, PASSAGE_WALL)
      return
    }
    const e = model.get(`${axis}:${gx},${gz}`)
    if (!e) return // one region (hall margin) or two open channels: the stamp left it open
    if (e.wall) featureEdge(map, axis, gx, cy, gz, FEATURES[e.feature])
    else if (axis === 'v') map.setWallV(gx, cy, gz, 0, PASSAGES[e.passage])
    else map.setWallH(gx, cy, gz, 0, PASSAGES[e.passage])
  }
  for (let gz = box.z0; gz <= box.z1; gz++) {
    set('v', box.x0, gz, box.x0 - 1, gz, box.x0, gz)
    set('v', box.x1 + 1, gz, box.x1, gz, box.x1 + 1, gz)
  }
  for (let gx = box.x0; gx <= box.x1; gx++) {
    set('h', gx, box.z0, gx, box.z0 - 1, gx, box.z0)
    set('h', gx, box.z1 + 1, gx, box.z1, gx, box.z1 + 1)
  }
}

// Every open edge inside the tile between a walkable cell and rock (a mass
// cell with a mass neighbour: the audit's "massy") becomes a plain wall. The
// grammar's own plan never leaves one (FloorPlan walls its mass boundary);
// the catalog stamp can, when its approach corridor (structures/catalog
// stamp step 7) runs through a region the grammar left unexcavated. Lines 0
// and 42 (the seams) are not touched: openOwnedSeam and the neighbour own them.
function sealMass(map, cy) {
  const N = LAST + 1
  const grid = storeyGrid(map, cy)
  if (!grid) return
  const { walk, mass, has, wv, wh } = grid
  // A mass cell with a mass neighbour (any chunk of the storey, off the
  // tile's edge counting as not mass).
  const massy = (gx, gz) => {
    const i = gz * N + gx
    if (!mass[i]) return false
    return (gx + 1 < N && mass[i + 1]) || (gx > 0 && mass[i - 1]) || (gz + 1 < N && mass[i + N]) || (gz > 0 && mass[i - N])
  }
  for (let gz = 0; gz < N; gz++) {
    for (let gx = 0; gx < N; gx++) {
      const i = gz * N + gx
      if (!has[i]) continue
      const wa = walk[i]
      // East neighbour (the V line at gx + 1), then south (the H line at gz + 1).
      if (gx + 1 < N && has[i + 1] && wa !== walk[i + 1] && !wv[i + 1] && (wa ? massy(gx + 1, gz) : massy(gx, gz))) {
        map.setWallV(gx + 1, cy, gz, 1, PASSAGE_WALL)
      }
      if (gz + 1 < N && has[i + N] && wa !== walk[i + N] && !wh[i + N] && (wa ? massy(gx, gz + 1) : massy(gx, gz))) {
        map.setWallH(gx, cy, gz + 1, 1, PASSAGE_WALL)
      }
    }
  }
}

// Wall the pool rect off on the basin floor, then open `steps` openings at
// its shallow side: that short side first, then the long sides nearest it,
// on edges whose outside cell is plain walkable floor. Returns the steps made.
function basinWalls(map, pool, shallow, steps) {
  const cy = BASIN
  const edges = []
  const rank = (side, along) => {
    if (side === shallow) return 0
    if (side === OPPOSITE[shallow]) return 99
    // A long side: nearer the shallow end ranks first.
    if (shallow === 'W') return 1 + (along - pool.x0)
    if (shallow === 'E') return 1 + (pool.x1 - along)
    if (shallow === 'N') return 1 + (along - pool.z0)
    return 1 + (pool.z1 - along)
  }
  for (let gz = pool.z0; gz <= pool.z1; gz++) {
    edges.push({ axis: 'v', gx: pool.x0, gz, out: [pool.x0 - 1, gz], rank: rank('W', gz) })
    edges.push({ axis: 'v', gx: pool.x1 + 1, gz, out: [pool.x1 + 1, gz], rank: rank('E', gz) })
  }
  for (let gx = pool.x0; gx <= pool.x1; gx++) {
    edges.push({ axis: 'h', gx, gz: pool.z0, out: [gx, pool.z0 - 1], rank: rank('N', gx) })
    edges.push({ axis: 'h', gx, gz: pool.z1 + 1, out: [gx, pool.z1 + 1], rank: rank('S', gx) })
  }
  for (const e of edges) {
    if (e.axis === 'v') map.setWallV(e.gx, cy, e.gz, 1, PASSAGE_WALL)
    else map.setWallH(e.gx, cy, e.gz, 1, PASSAGE_WALL)
  }
  const mid = (a, b) => (a + b) / 2
  const centre = (e) => (e.axis === 'v' ? Math.abs(e.gz - mid(pool.z0, pool.z1)) : Math.abs(e.gx - mid(pool.x0, pool.x1)))
  const order = [...edges].sort((a, b) => a.rank - b.rank || centre(a) - centre(b) || a.gx - b.gx || a.gz - b.gz)
  let made = 0
  for (const e of order) {
    if (made >= steps) break
    const c = map.cellAt(e.out[0], cy, e.out[1])
    if (!c.chunk || c.col || c.kind === CELL_STAIR) continue
    if (e.axis === 'v') map.setWallV(e.gx, cy, e.gz, 0, PASSAGE_WIDE)
    else map.setWallH(e.gx, cy, e.gz, 0, PASSAGE_WIDE)
    made++
  }
  return made
}

// --- furniture --------------------------------------------------------------------------

// The pools' dressing (doc §6): starting blocks on every other lane at the
// deep head, a lifeguard chair mid-pool, lounger rows behind it, loungers on
// the gallery facing the vault, and the traces of absent swimmers on the dry
// floors (kickboards, one lone lounger at the bottom of a deep end).
function furnishPools(put, r, vols, exit) {
  const n = { blocks: 0, loungers: 0, chairs: 0 }
  for (const v of vols) {
    const f = frame(v)
    const at = (u, w) => f.at(u, w)
    const sideHi = r(80, v.slot) % 2 === 0 // which long side holds the chair
    const wSide = sideHi ? f.w1 + 1 : f.w0 - 1
    const wFace = sideHi ? f.face.wHi : f.face.wLo
    const wBack = sideHi ? 1 : -1
    if (v.type === 'lapHall' || v.type === 'natatio') {
      // Every other lane, centred (5 lanes: 3 blocks; 8 lanes: 4), at the
      // deep end's head; the shallow head when a flight's landing holds the
      // deep one.
      const w0 = f.w0 + ((f.w1 - f.w0 + 1) % 2 ? 0 : 1)
      for (const hi of [f.deepHi, !f.deepHi]) {
        const uHead = hi ? f.u1 + 1 : f.u0 - 1
        let k = 0
        for (let w = w0; w <= f.w1; w += 2) if (put(DECK, ...at(uHead, w), PROP_STARTING_BLOCK, { facing: hi ? f.face.uHi : f.face.uLo })) k++
        n.blocks += k
        if (k >= 3) break
      }
    }
    if (v.type !== 'pitRoom') {
      const mid = Math.floor((f.u0 + f.u1) / 2)
      let chairU = null
      for (const u of [mid, mid - 2, mid + 2, mid - 4, mid + 4]) {
        if (put(DECK, ...at(u, wSide), PROP_LIFEGUARD_CHAIR, { facing: wFace })) {
          chairU = u
          n.chairs++
          break
        }
      }
      for (let u = f.u0 + 1; u <= f.u1 - 1; u += 2) {
        if (u === chairU) continue
        if (put(DECK, ...at(u, wSide + wBack), PROP_LOUNGER, { facing: wFace })) n.loungers++
      }
      // The far side: loungers two off the water facing it, a palm at
      // either end of the row; the volume box's corners potted.
      const oSide = sideHi ? f.w0 - 2 : f.w1 + 2
      const oFace = sideHi ? f.face.wLo : f.face.wHi
      for (let u = f.u0 + (r(81, v.slot) % 2); u <= f.u1; u += 2) {
        if (put(DECK, ...at(u, oSide), PROP_LOUNGER, { facing: oFace })) n.loungers++
      }
      for (const u of [f.u0 - 1, f.u1 + 1]) put(DECK, ...at(u, oSide), FURN_PLANT, { facing: oFace })
      const b = v.box
      for (const [gx, gz] of [[b.x0, b.z0], [b.x1, b.z0], [b.x0, b.z1], [b.x1, b.z1]]) put(DECK, gx, gz, FURN_PLANT, { facing: r(82, gx + gz) % 4 })
      // The kickboard stack and the lost-property bin by the shallow head.
      const uShallow = f.deepHi ? f.u0 - 2 : f.u1 + 2
      put(DECK, ...at(uShallow, f.w0), PROP_KICKBOARD, { facing: f.deepHi ? f.face.uLo : f.face.uHi })
      put(DECK, ...at(uShallow, f.w1), PROP_LOST_BIN, { facing: f.deepHi ? f.face.uLo : f.face.uHi })
      // A kickboard left on the dry pool floor.
      put(BASIN, ...at(f.u0 + r(64, v.slot) % (f.u1 - f.u0 + 1), f.w0 + r(65, v.slot) % (f.w1 - f.w0 + 1)), PROP_KICKBOARD, { facing: r(66, v.slot) % 4 })
    }
    if (v.levels > 2) {
      // The gallery's loungers face the vault; the lone lounger lies at the
      // bottom of the deep end.
      for (let u = f.u0 + 1; u <= f.u1 - 1; u += 4) if (put(GALLERY, ...at(u, wSide), PROP_LOUNGER, { facing: wFace })) n.loungers++
      const uDeep = f.deepHi ? f.u1 - 1 : f.u0 + 1
      if (put(BASIN, ...at(uDeep, f.w0 + 1 + (r(60, v.slot) % Math.max(1, f.w1 - f.w0 - 1))), PROP_LOUNGER, { facing: f.deepHi ? f.face.uLo : f.face.uHi })) n.loungers++
    }
    if (v.type === 'pitRoom') {
      // The pit room's deck: a kickboard or two left at the well's rim, a
      // lost-property bin in a corner of the box and, one pit in two, a
      // lifeguard chair two cells back watching the well (doc §9's
      // Lifeguard).
      const mid = Math.floor((f.u0 + f.u1) / 2)
      if (r(83, v.slot) % 2 === 0) for (const u of [mid, mid + 1, mid - 1]) if (put(DECK, ...at(u, wSide + wBack), PROP_LIFEGUARD_CHAIR, { facing: wFace })) {
        n.chairs++
        break
      }
      const rim = [[f.u0 - 1, f.w0 - 1], [f.u1 + 1, f.w1 + 1], [f.u1 + 1, f.w0 - 1], [f.u0 - 1, f.w1 + 1]]
      for (let i = 0, k = 0; i < rim.length && k < 2; i++) if (put(DECK, ...at(...rim[(i + r(84, v.slot)) % 4]), PROP_KICKBOARD, { facing: r(85, v.slot + i) % 4 })) k++
      const b = v.box
      const bc = [[b.x0, b.z0], [b.x1, b.z1], [b.x1, b.z0], [b.x0, b.z1]]
      for (let i = 0; i < 4; i++) if (put(DECK, ...bc[(i + r(86, v.slot)) % 4], PROP_LOST_BIN, { facing: r(87, v.slot) % 4 })) break
      // The pit's kickboard keeps off the exit cell.
      for (const [gx, gz] of [[v.pool.x0, v.pool.z0], [v.pool.x1, v.pool.z1], [v.pool.x1, v.pool.z0]]) {
        if (gx === exit.gx && gz === exit.gz) continue
        if (put(BASIN, gx, gz, PROP_KICKBOARD, { facing: r(67) % 4 })) break
      }
    }
  }
  return n
}

// The rooms' dressing: the sentō's lockers, bandai seat and lost-property bin;
// each deck chamber one program of the rotation (lockers, washing rows,
// kickboard heaps, lost-and-found, palm gardens, a lounge, the odd lifeguard
// chair watching an empty room); the stair lobbies' locker runs; the
// gallery's sun terraces (lounger rows across the open floor); shelving in
// the plant rooms.
// The deck chambers' rotation (dressRoom programs): lockers come twice, the
// lounge once — loungers belong by the water and on the terraces.
const CHAMBER_PROGRAMS = Object.freeze([1, 9, 10, 3, 4, 0, 1, 2])
const GALLERY_PROGRAMS = Object.freeze([0, 4, 3, 9, 2, 4, 12])
function furnishRooms(put, r, g, vols, wallOn, anomalous = new Set()) {
  let watched = 0
  const lobbyBox = g.stair?.box ?? null
  for (const reg of g.deck.regions) {
    if (reg.mass) continue
    const { x0, z0, x1, z1 } = reg.rect
    const k = reg.id
    if (reg.type === 'changing') {
      const alongX = x1 - x0 >= z1 - z0
      // The bandai seat and the lost-property bin in two corners, then
      // lockers down both long walls (placeSafe keeps every mouth clear).
      const corners = [[x1, z1, 'E'], [x0, z1, 'W'], [x1, z0, 'E'], [x0, z0, 'W']]
      const seat = corners.findIndex(([gx, gz, wall]) => put(DECK, gx, gz, PROP_BANDAI, { wall }))
      corners.some(([gx, gz, wall], i) => i !== seat && put(DECK, gx, gz, PROP_LOST_BIN, { wall }))
      if (alongX) {
        for (let gx = x0; gx <= x1; gx++) put(DECK, gx, z0, gx % 2 ? FURN_CABINET : FURN_WARDROBE, { wall: 'N' })
        for (let gx = x0; gx <= x1; gx++) put(DECK, gx, z1, gx % 2 ? FURN_WARDROBE : FURN_CABINET, { wall: 'S' })
      } else {
        for (let gz = z0; gz <= z1; gz++) put(DECK, x0, gz, gz % 2 ? FURN_CABINET : FURN_WARDROBE, { wall: 'W' })
        for (let gz = z0; gz <= z1; gz++) put(DECK, x1, gz, gz % 2 ? FURN_WARDROBE : FURN_CABINET, { wall: 'E' })
      }
      // And the wall away from the bath.
      const bath = g.deck.regions.find((x) => x.type === 'bath' && x.changing === reg.id)
      if (bath) {
        const b = bath.rect
        if (b.x0 > x1) for (let gz = z0 + 1; gz <= z1 - 1; gz++) put(DECK, x0, gz, FURN_CABINET, { wall: 'W' })
        else if (b.x1 < x0) for (let gz = z0 + 1; gz <= z1 - 1; gz++) put(DECK, x1, gz, FURN_CABINET, { wall: 'E' })
        else if (b.z0 > z1) for (let gx = x0 + 1; gx <= x1 - 1; gx++) put(DECK, gx, z0, FURN_CABINET, { wall: 'N' })
        else for (let gx = x0 + 1; gx <= x1 - 1; gx++) put(DECK, gx, z1, FURN_CABINET, { wall: 'S' })
      }
    } else if (reg.type === 'chamber' && !anomalous.has(reg.id)) {
      const kind = CHAMBER_PROGRAMS[r(90, k) % CHAMBER_PROGRAMS.length]
      if (kind === 2 && watched >= 2) dressRoom(put, r, reg, g.deck, wallOn, 1, DECK)
      else if (dressRoom(put, r, reg, g.deck, wallOn, kind, DECK) && kind === 2) watched++
    } else if (reg.type === 'court') {
      dressRoom(put, r, reg, g.deck, wallOn, 5, DECK)
    } else if (reg.type === 'walk') {
      dressRoom(put, r, reg, g.deck, wallOn, 6, DECK)
    } else if (reg.type === 'hall') {
      const v = vols[reg.vol]
      dressRoom(put, r, reg, g.deck, wallOn, v?.type === 'pitRoom' ? 8 : 7, DECK, v?.box ?? null)
    } else if (reg.type === 'lobby') {
      dressRoom(put, r, reg, g.deck, wallOn, 11, DECK, lobbyBox)
    } else if (reg.type === 'chan' && r(94, k) % 4 === 0) {
      put(DECK, x0, z0, r(95, k) % 2 ? PROP_KICKBOARD : FURN_PLANT, { facing: r(95, k) % 4 })
    }
  }
  // The upper gallery: sun terraces (lounger rows across the open floor),
  // viewing rooms, gardens, lost-and-found corners, the stair lobby; the
  // vault's balcony hall with its lounger rows facing the water.
  for (const reg of g.gallery?.regions ?? []) {
    if (reg.mass) continue
    const k = reg.id + 4096
    if (reg.type === 'court') {
      dressRoom(put, r, reg, g.gallery, wallOn, 12, GALLERY)
    } else if (reg.type === 'chamber') {
      const w = reg.rect.x1 - reg.rect.x0 + 1
      const h = reg.rect.z1 - reg.rect.z0 + 1
      let kind = GALLERY_PROGRAMS[r(96, k) % GALLERY_PROGRAMS.length]
      if (kind === 12 && (w < 7 || h < 7)) kind = 4
      if (kind === 2 && watched >= 3) dressRoom(put, r, reg, g.gallery, wallOn, 4, GALLERY)
      else if (dressRoom(put, r, reg, g.gallery, wallOn, kind, GALLERY) && kind === 2) watched++
    } else if (reg.type === 'walk') {
      dressRoom(put, r, reg, g.gallery, wallOn, 6, GALLERY)
    } else if (reg.type === 'hall') {
      dressRoom(put, r, reg, g.gallery, wallOn, 7, GALLERY, vols[reg.vol]?.box ?? null)
    } else if (reg.type === 'lobby') {
      // The stair comes up onto a terrace: lounger rows round the core.
      dressRoom(put, r, reg, g.gallery, wallOn, 12, GALLERY, lobbyBox)
    }
  }
  // The plant level: shelving down the west wall of the plant and tank
  // rooms, control cabinets down the east one (doc §5: pumps, pipes, the
  // balance tank; the pump blocks are the grammar's columns).
  for (const reg of g.basin.regions) {
    if (reg.mass || (reg.type !== 'plant' && reg.type !== 'tank')) continue
    const { x0, z0, x1, z1 } = reg.rect
    for (let gz = z0 + 1; gz <= z1 - 1; gz += 3) put(BASIN, x0, gz, FURN_RACK, { wall: 'W' })
    for (let gz = z0 + 2; gz <= z1 - 1; gz += 4) if (wallOn(x1, gz, 'E', BASIN)) put(BASIN, x1, gz, FURN_CABINET, { wall: 'E' })
  }
}

// A room's dressing by program (doc §6: the traces of absent swimmers):
//   0 lounge   three loungers down its longest walled side, palms in two
//              corners, a lost-property bin
//   1 lockers  a locker run down one wall, a lounger as the bench opposite,
//              a bin and a dropped kickboard
//   2 watch    a lifeguard chair mid-wall watching the empty room, a
//              kickboard or two on the tile, palms in two corners
//   3 lost     lost-property bins, kickboards strewn on the tile, a cooler
//   4 garden   potted palms in every corner and down one wall, a cooler
//   5 court    the deck's dry court: palms in the corners, one short lounger
//              row, a cooler, a bin
//   6 walk     palms and coolers down one wall, a few loungers on the other
//   7 hall     the pool hall's margin (outside the volume box; the lounger
//              rows stand by the water, furnishPools): palms and coolers
//              down its longest wall, four loungers on the opposite one,
//              bins on a third, a short locker bank on the fourth
//   8 pit      the pit room's margin: bare tile, a bin, two palms, a cooler,
//              kickboards
//   9 washing  the sentō's washing row (taps and basins down one wall), a
//              bin, a kickboard
//  10 heap     kickboards heaped on the tile, two bins, a short locker run
//  11 lobby    the stair lobby: a locker bank, a cooler, palms, a bin,
//              kickboards
//  12 terrace  the gallery's sun terrace: rows of loungers across the open
//              floor all facing one way, palms in the corners, a cooler
// Pieces stand against real walls (wallOn) inside the room's own cells,
// through placeSafe (never cutting the floor). Returns whether the
// program's centrepiece stood.
function dressRoom(put, r, reg, gs, wallOn, program, cy, box = null) {
  const { x0, z0, x1, z1 } = reg.rect
  const k = reg.id + (cy === GALLERY ? 4096 : 0)
  const own = (gx, gz) => gs.regionAt(gx, gz) === reg && !(box && inRect(box, gx, gz))
  // The inner cells along side `side`, in order, that stand against a wall.
  const run = (side) => {
    const out = []
    if (side === 'N' || side === 'S') {
      const gz = side === 'N' ? z0 : z1
      for (let gx = x0; gx <= x1; gx++) if (own(gx, gz) && wallOn(gx, gz, side, cy)) out.push([gx, gz])
    } else {
      const gx = side === 'W' ? x0 : x1
      for (let gz = z0; gz <= z1; gz++) if (own(gx, gz) && wallOn(gx, gz, side, cy)) out.push([gx, gz])
    }
    return out
  }
  const sides = ['N', 'E', 'S', 'W']
  const runs = Object.fromEntries(sides.map((sd) => [sd, run(sd)]))
  const OPP = { N: 'S', S: 'N', E: 'W', W: 'E' }
  // The longest walled side (ties by the dice), and its opposite.
  const order = [...sides].sort((a, b) => runs[b].length - runs[a].length || (r(201, k + sides.indexOf(a)) % 7) - (r(201, k + sides.indexOf(b)) % 7))
  const main = order[0]
  const back = OPP[main]
  const third = order[1] === back ? order[2] : order[1]
  const corners = [[x0, z0, 'N', 'W'], [x1, z0, 'N', 'E'], [x1, z1, 'S', 'E'], [x0, z1, 'S', 'W']]
    .filter(([gx, gz]) => own(gx, gz))
    .map(([gx, gz, a, b]) => [gx, gz, wallOn(gx, gz, a, cy) ? a : wallOn(gx, gz, b, cy) ? b : null])
  const corner = (i, kind) => {
    const [gx, gz, wall] = corners[i % Math.max(1, corners.length)] ?? []
    return gx !== undefined && put(cy, gx, gz, kind, wall ? { wall } : { facing: r(202, k + i) % 4 })
  }
  // Pieces of `kind` (alternating with `alt`) every `step` cells down side
  // `side`, from cell `from`, at most `max`.
  const row = (side, kind, step, from = 0, alt = null, max = Infinity) => {
    let n = 0
    const cells = runs[side]
    for (let i = from; i < cells.length && n < max; i += step) {
      const [gx, gz] = cells[i]
      if (put(cy, gx, gz, alt && (i / step) % 2 ? alt : kind, { wall: side })) n++
    }
    return n
  }
  const midOf = (side, kind) => {
    const cells = runs[side]
    if (!cells.length) return false
    const m = Math.floor(cells.length / 2)
    for (const i of [m, m - 1, m + 1]) if (cells[i] && put(cy, ...cells[i], kind, { wall: side })) return true
    return false
  }
  const scatter = (kind, n, salt) => {
    let placed = 0
    for (let t = 0; t < n * 3 && placed < n; t++) {
      const gx = x0 + (r(salt, k * 16 + t) % (x1 - x0 + 1))
      const gz = z0 + (r(salt + 1, k * 16 + t) % (z1 - z0 + 1))
      if (own(gx, gz) && put(cy, gx, gz, kind, { facing: r(salt + 2, k * 16 + t) % 4 })) placed++
    }
    return placed
  }
  const c0 = r(203, k) % 4
  switch (program) {
    case 0: {
      const n = row(main, PROP_LOUNGER, 2, r(204, k) % 2, null, 3)
      corner(c0 + 2, FURN_PLANT)
      corner(c0 + 3, FURN_PLANT)
      corner(c0, PROP_LOST_BIN)
      midOf(back, FURN_COOLER)
      return n > 0
    }
    case 1: {
      const n = row(main, FURN_CABINET, 1, 0, FURN_WARDROBE)
      midOf(back, PROP_LOUNGER)
      corner(c0 + 1, PROP_LOST_BIN)
      scatter(PROP_KICKBOARD, 1, 210)
      return n > 0
    }
    case 2: {
      const ok = midOf(main, PROP_LIFEGUARD_CHAIR)
      scatter(PROP_KICKBOARD, 2, 230)
      corner(c0, FURN_PLANT)
      corner(c0 + 2, FURN_PLANT)
      corner(c0 + 1, PROP_LOST_BIN)
      return ok
    }
    case 3: {
      corner(c0, PROP_LOST_BIN)
      corner(c0 + 1, PROP_LOST_BIN)
      midOf(main, FURN_COOLER)
      row(back, FURN_CABINET, 2, 1, null, 3)
      return scatter(PROP_KICKBOARD, 2, 220) > 0
    }
    case 4: {
      for (let i = 0; i < 4; i++) corner(c0 + i, FURN_PLANT)
      midOf(back, FURN_COOLER)
      return row(main, FURN_PLANT, 2, 1, null, 4) > 0
    }
    case 5: {
      for (let i = 0; i < 4; i++) corner(c0 + i, FURN_PLANT)
      const n = row(main, PROP_LOUNGER, 3, 1, null, 4)
      midOf(third, FURN_COOLER)
      row(back, PROP_LOST_BIN, 5, 2, PROP_KICKBOARD, 3)
      return n > 0
    }
    case 6:
      return row(main, PROP_LOUNGER, 4, 1, null, 3) + row(back, FURN_PLANT, 3, 1, FURN_COOLER) > 0
    case 7: {
      // Round the hall's walls: palms and coolers down the longest, four
      // loungers facing the water on the opposite one, bins and a
      // kickboard on a third, a short locker bank on the fourth.
      const fourth = OPP[third]
      corner(c0, FURN_PLANT)
      corner(c0 + 2, FURN_PLANT)
      corner(c0 + 1, PROP_LOST_BIN)
      const n = row(main, FURN_PLANT, 4, 1, FURN_COOLER)
      row(back, PROP_LOUNGER, 3, 1 + (r(205, k) % 2), null, 4)
      row(third, PROP_LOST_BIN, 6, 2, PROP_KICKBOARD, 2)
      row(fourth, FURN_CABINET, 1, 2, FURN_WARDROBE, 4)
      return n > 0
    }
    case 8:
      // The pit room's hall: bare tile round the well, a bin, two palms, a
      // cooler and kickboards left on the tile.
      return corner(c0, PROP_LOST_BIN) + corner(c0 + 1, FURN_PLANT) + corner(c0 + 3, FURN_PLANT) + midOf(main, FURN_COOLER) +
        scatter(PROP_KICKBOARD, 3, 240) > 0
    case 9: {
      // The washing row: a basin every cell down the wall (the sentō's low
      // stations), a bin and a kickboard.
      const n = row(main, FURN_SINK, 1, r(251, k) % 2, null, 7)
      corner(c0 + 2, PROP_LOST_BIN)
      scatter(PROP_KICKBOARD, 1, 250)
      return n > 0
    }
    case 10: {
      const n = scatter(PROP_KICKBOARD, 4, 260)
      corner(c0, PROP_LOST_BIN)
      corner(c0 + 2, PROP_LOST_BIN)
      row(back, FURN_CABINET, 1, 1, FURN_WARDROBE, 3)
      return n > 0
    }
    case 11: {
      // The stair lobby: a locker bank down its longest wall, a cooler and
      // palms on the others, a bin, a kickboard or two.
      const n = row(main, FURN_CABINET, 1, 0, FURN_WARDROBE, 10)
      midOf(back, FURN_COOLER)
      row(third, FURN_PLANT, 4, 1, null, 3)
      corner(c0 + 2, FURN_PLANT)
      corner(c0 + 3, PROP_LOST_BIN)
      scatter(PROP_KICKBOARD, 2, 280)
      return n > 0
    }
    case 12: {
      // The sun terrace: rows across the open floor, 3 cells apart and
      // inset 2 from the walls, all facing one way; down a row, pairs of
      // loungers side by side with a gap, then a potted palm and a gap
      // (period 5, at most 16 loungers); the corners potted, a cooler on
      // a side wall.
      const alongX = x1 - x0 >= z1 - z0
      const face = alongX ? (r(270, k) % 2 ? FACING.N : FACING.S) : (r(270, k) % 2 ? FACING.W : FACING.E)
      let n = 0
      const [a0, a1, b0, b1] = alongX ? [x0, x1, z0, z1] : [z0, z1, x0, x1]
      for (let b = b0 + 2 + (r(271, k) % 2), j = 0; b <= b1 - 2 && n < 16; b += 3, j++) {
        const start = a0 + 2 + (r(272, k + b) % 3)
        for (let a = start; a <= a1 - 2 && n < 16; a++) {
          const phase = (a - start) % 5
          const [gx, gz] = alongX ? [a, b] : [b, a]
          if (!own(gx, gz)) continue
          if (phase < 2) {
            if (put(cy, gx, gz, PROP_LOUNGER, { facing: face })) n++
          } else if (phase === 3 && j % 2 === 0) put(cy, gx, gz, FURN_PLANT, { facing: face })
        }
      }
      for (let i = 0; i < 4; i++) corner(c0 + i, FURN_PLANT)
      midOf(third, FURN_COOLER)
      return n > 0
    }
  }
  return false
}

// The fill light's cells (tiles/fillLight.js `where`, kind-local cells of
// the tile whose basin storey is `basinCy`): the deck and the gallery, but
// never the too-deep well's box (anomaly 'deep') on the deck round it; never
// the basin, which the tile lights itself (lampBasin). Shared by
// generator.js (the world bake) and kindFill (the finite kind).
export function poolFillTint(vols, ox, oz, basinCy) {
  const rings = vols.filter((v) => v.type !== 'pitRoom').map((v) => grow(v.pool, 2))
  return (d, lx, lz, gx, gz, cy) => (cy === basinCy && rings.some((g) => inRect(g, gx - ox, gz - oz)) ? POOL_TINT : null)
}

// Per tile cell: bit 1 = a drained pool floor (basin), bit 2 = the deep
// well's box (anomaly 'deep': basin and deck), bit 4 = the basin's dark
// refuge (grammar.js darkRefuge).
function basinMask(vols, anomaly, refuge) {
  const N = LAST + 1
  const deep = anomaly === 'deep' ? pitOf(vols).box : null
  const mask = new Uint8Array(N * N)
  for (const v of vols) for (let z = v.pool.z0; z <= v.pool.z1; z++) for (let x = v.pool.x0; x <= v.pool.x1; x++) mask[z * N + x] |= 1
  if (deep) for (let z = deep.z0; z <= deep.z1; z++) for (let x = deep.x0; x <= deep.x1; x++) mask[z * N + x] |= 2
  if (refuge) for (let z = refuge.z0; z <= refuge.z1; z++) for (let x = refuge.x0; x <= refuge.x1; x++) mask[z * N + x] |= 4
  return mask
}

export function poolFillWhere(vols, anomaly, ox, oz, basinCy) {
  const N = LAST + 1
  const mask = basinMask(vols, anomaly, null)
  // A chunk-storey the tile already lit to the cap takes no fixture, and
  // the pass skips its cells (pruneLamps spent its budget on them).
  const full = new WeakMap()
  const capped = (d) => {
    let f = full.get(d)
    if (f === undefined) full.set(d, (f = d.lamps.reduce((n, l) => n + (l.lit ? 1 : 0), 0) >= LIT_CAP))
    return f
  }
  return (d, lx, lz, gx, gz, cy) => {
    if (cy === basinCy || capped(d)) return false
    const x = gx - ox
    const z = gz - oz
    if (x < 0 || z < 0 || x >= N || z >= N) return true
    return !(mask[z * N + x] & 2) || cy > basinCy + 1
  }
}

// One storey of the tile as flat N×N arrays (kind-local cells): walk (the
// cell is walkable), mass (seams.js isMassCell), has (its chunk exists), wv /
// wh (a wall, plain or glass, on the cell's west / north line). Null when the
// storey has no chunk.
function storeyGrid(map, cy) {
  const N = LAST + 1
  const side = N / TILE.w
  const walk = new Uint8Array(N * N)
  const mass = new Uint8Array(N * N)
  const has = new Uint8Array(N * N)
  const wv = new Uint8Array(N * N)
  const wh = new Uint8Array(N * N)
  let any = false
  for (let cz = 0; cz < TILE.d; cz++) {
    for (let cx = 0; cx < TILE.w; cx++) {
      const d = map.chunkAt(cx, cy, cz)
      if (!d) continue
      any = true
      // cellWalkable and isMassCell inlined (one holeMasks look-up a chunk).
      const m = holeMasks(d)
      for (let lz = 0; lz < side; lz++) {
        for (let lx = 0; lx < side; lx++) {
          const i = (cz * side + lz) * N + cx * side + lx
          const c = lz * CHUNK + lx
          has[i] = 1
          walk[i] = d.cols[c] === 0 && m.floor[c] === 0 && (m.stair[c] & (STAIR_UP_RUN | STAIR_DOWN_RUN)) === 0 ? 1 : 0
          mass[i] = d.cols[c] === COLUMN_STANDARD && d.cellKind[c] === CELL_OPEN && d.spaceId[c] === 0 ? 1 : 0
          wv[i] = d.wallV[vIdx(lx, lz)] > 0 ? 1 : 0
          wh[i] = d.wallH[hIdx(lx, lz)] > 0 ? 1 : 0
        }
      }
    }
  }
  return any ? { walk, mass, has, wv, wh } : null
}

// The basin's light: the tile's own tubes, nine a chunk at most, hung by a
// greedy cover — each round the tube that lifts the most still-unlit cells
// (a cell within √8 cells of a tube, in its sight, is lit past FILL_LEVEL,
// tiles/fillLight.js's own window) — two cells apart in sight, never over
// a drained pool floor, the too-deep well or the dark refuge, so the dark
// basin cells are mostly the deep ends (doc §12: ≥ 0.7 of them deep). Cyan
// within two cells of a drained pool (the under-deck rings), plain
// elsewhere. The world's fill pass skips the basin (poolFillWhere): the
// walled plant level is too costly to cover by its sight lines.
// The 7×7 window round a tube: [dx, dz, weight, path], the path being the
// cell steps of the sight line from the tube's cell centre to the cell's
// (x, z, nx, nz flat, relative to the tube; a corner step passes when either
// way round is open); weight 0 past the tube's reach (COVER_R2).
const COVER_R2 = 10
const COVER = (() => {
  const out = []
  for (let dz = -3; dz <= 3; dz++) {
    for (let dx = -3; dx <= 3; dx++) {
      const path = []
      const steps = 4 * Math.max(Math.abs(dx), Math.abs(dz))
      let x = 0
      let z = 0
      for (let t = 1; t <= steps; t++) {
        const nx = Math.floor(0.5 + (dx * t) / steps)
        const nz = Math.floor(0.5 + (dz * t) / steps)
        if (nx === x && nz === z) continue
        path.push(x, z, nx, nz)
        x = nx
        z = nz
      }
      out.push([dx, dz, dx * dx + dz * dz <= COVER_R2 ? 1 / (1 + dx * dx + dz * dz) : 0, Int8Array.from(path)])
    }
  }
  return out
})()
const coverAt = (dx, dz) => COVER[(dz + 3) * 7 + dx + 3]
function lampBasin(map, vols, anomaly, refuge) {
  const N = LAST + 1
  const mask = basinMask(vols, anomaly, refuge)
  const rings = vols.filter((v) => v.type !== 'pitRoom').map((v) => grow(v.pool, 2))
  const chunk = (gx, gz) => map.chunkAt(map.cellChunk(gx), BASIN, map.cellChunk(gz))
  const grid = storeyGrid(map, BASIN)
  if (!grid) return 0
  const { walk, wv, wh } = grid
  const target = new Uint8Array(N * N) // a cell the basin lights
  const fixture = new Uint8Array(N * N)
  const lit = new Uint8Array(N * N) // lifted past FILL_LEVEL
  for (let i = 0; i < N * N; i++) target[i] = walk[i] && !mask[i] ? 1 : 0
  // A sight line from cell (ax, az) along a COVER path: through walkable
  // cells only, no opaque wall crossed (wv / wh: the wall on a cell's west /
  // north edge).
  const sees = (ax, az, path) => {
    for (let j = 0; j < path.length; j += 4) {
      const cx = ax + path[j]
      const cz = az + path[j + 1]
      const ex = ax + path[j + 2]
      const ez = az + path[j + 3]
      if (ex < 0 || ez < 0 || ex >= N || ez >= N || !walk[ez * N + ex]) return false
      const xe = Math.max(cx, ex)
      const ze = Math.max(cz, ez)
      if (ex !== cx && ez !== cz) {
        // Round the corner by (ex, cz) or by (cx, ez).
        const a = walk[cz * N + ex] && !wv[cz * N + xe] && !wh[ze * N + ex]
        if (!a && !(walk[ez * N + cx] && !wh[ze * N + cx] && !wv[ez * N + xe])) return false
      } else if (ex !== cx ? wv[cz * N + xe] : wh[ze * N + cx]) return false
    }
    return true
  }
  // The basin chunks by their local chunk coordinates (a tile canvas keys
  // its chunks globally).
  const side = N / TILE.w
  const basinChunks = []
  for (let cz = 0; cz < TILE.d; cz++) for (let cx = 0; cx < TILE.w; cx++) if (map.chunkAt(cx, BASIN, cz)) basinChunks.push([cx, cz, map.chunkAt(cx, BASIN, cz)])
  const litOf = new Map()
  for (const [, , d] of basinChunks) litOf.set(d, d.lamps.filter((l) => l.lit).length)
  const shine = (ax, az) => {
    for (const [dx, dz, w, path] of COVER) {
      const x = ax + dx
      const z = az + dz
      if (w > 0 && x >= 0 && z >= 0 && x < N && z < N && sees(ax, az, path)) lit[z * N + x] = 1
    }
  }
  for (const [cx, cz, d] of basinChunks) {
    for (const l of d.lamps) {
      const gx = cx * side + l.lx
      const gz = cz * side + l.lz
      fixture[gz * N + gx] = 1
      if (l.lit) shine(gx, gz)
    }
  }
  // A candidate within two cells of a fixture, in its sight, is crowded.
  const crowd = (c) => {
    for (let z = Math.max(0, c.gz - 2); z <= Math.min(LAST, c.gz + 2); z++) {
      for (let x = Math.max(0, c.gx - 2); x <= Math.min(LAST, c.gx + 2); x++) if (fixture[z * N + x] && sees(x, z, coverAt(c.gx - x, c.gz - z)[3])) return true
    }
    return false
  }
  const cands = []
  for (let gz = 0; gz < N; gz++) {
    for (let gx = 0; gx < N; gx++) {
      const i = gz * N + gx
      const d = chunk(gx, gz)
      if (!target[i] || fixture[i] || d.hasCeilHole(map.cellLocal(gx), map.cellLocal(gz)) || crowd({ gx, gz })) continue
      const ks = []
      const vs = []
      let spill = 0
      for (let e = 0; e < COVER.length; e++) {
        const ent = COVER[e]
        const dx = ent[0]
        const dz = ent[1]
        const v = ent[2]
        const x = gx + dx
        const z = gz + dz
        if (x < 0 || z < 0 || x >= N || z >= N) continue
        const k = z * N + x
        if (v ? !target[k] && !(mask[k] & 1) : !(mask[k] & 1) || dx * dx + dz * dz > 15) continue
        if (!sees(gx, gz, ent[3])) continue
        if (mask[k] & 1) spill++
        else {
          ks.push(k)
          vs.push(v)
        }
      }
      cands.push({ gx, gz, d, ks, vs, spill, live: true })
    }
  }
  // The cells a candidate lifts, less the drained pool floor it would light
  // (the deep ends stay dark).
  const gain = (c) => {
    let n = -c.spill
    let sum = 0
    for (let j = 0; j < c.ks.length; j++) {
      if (lit[c.ks[j]]) continue
      n++
      sum += c.vs[j]
    }
    c.n = n
    c.sum = sum
  }
  // Each round hangs the live candidate with the most cells lifted (ties: the
  // most light, then scan order). Gains only fall as cells are lit, so a
  // lazy greedy over a max-heap of stale gains picks exactly that one.
  const before = (a, b) => a.n > b.n || (a.n === b.n && (a.sum > b.sum || (a.sum === b.sum && a.i < b.i)))
  const heap = new LazyHeap(before)
  cands.forEach((c, i) => {
    c.i = i
    if (!c.live) return
    gain(c)
    if (c.n > 0) heap.push(c)
  })
  let hung = 0
  for (;;) {
    let best = null
    while (heap.size) {
      const c = heap.pop()
      if (!c.live) continue
      if (litOf.get(c.d) >= LIT_CAP) {
        c.live = false
        continue
      }
      gain(c)
      if (c.n <= 0) continue
      if (!heap.size || !before(heap.peek(), c)) {
        best = c
        break
      }
      heap.push(c)
    }
    if (!best) break
    const { gx, gz, d } = best
    const rec = { lx: map.cellLocal(gx), lz: map.cellLocal(gz), lit: true }
    if (rings.some((g) => inRect(g, gx, gz))) rec.tint = POOL_TINT
    d.lamps.push(rec)
    litOf.set(d, litOf.get(d) + 1)
    fixture[gz * N + gx] = 1
    for (let j = 0; j < best.ks.length; j++) lit[best.ks[j]] = 1
    best.live = false
    for (const c of cands) if (c.live && Math.max(Math.abs(c.gx - gx), Math.abs(c.gz - gz)) <= 2 && sees(gx, gz, coverAt(c.gx - gx, c.gz - gz)[3])) c.live = false
    hung++
  }
  return hung
}

// The fill's target light (tiles/fillLight.js `level`): 0.01, a fixture
// within about 2.9 cells in sight (the default 0.05 reaches 2.3): dim pool
// rooms whose fixtures, nine a chunk-storey, spread over the walled service
// tunnels too.
export const FILL_LEVEL = 0.02

function kindFill(map, vols, anomaly) {
  const chunks = new Map()
  for (const d of map.chunks.values()) chunks.set(chunkKey3(d.cx, d.cy, d.cz), d)
  return fillDarkCells(chunks, {
    ...FILL_DEFAULTS, level: FILL_LEVEL, cap: LIT_CAP, spawn: [],
    where: poolFillWhere(vols, anomaly, 0, 0, BASIN), tint: poolFillTint(vols, 0, 0, BASIN),
  })
}

// The deck's and the gallery's authored tubes, thinned to the ones that
// light the floor (the fill-light model's own test: a walkable cell within
// √7 cells of a burning tube, in its sight, is past 0.02). The cyan troffers over the water come
// first (`cyanKeep` a chunk-storey: the pools stay lit from above; the vault's
// skylight troffers on the gallery keep more), then a
// greedy pick, each round the tube that lights the most walkable cells no
// tube picked so far lights, at most `cap` a chunk-storey, while a tube adds
// at least PRUNE_GAIN cells. The rest are taken down (a removed tube is not
// a dead one: dead tubes are authored darkness and stay), so the world fill
// (generator.js) spends the chunk's remaining budget where the grid left
// holes. The authored 3-grid, capped by crowding alone, left about half the
// deck round the spawn below 0.02 (fill-light.test.js).
const PRUNE_GAIN = 5
const PRUNE_R2 = 7
function pruneLamps(map, cy, cap, cyanKeep) {
  const N = LAST + 1
  const side = N / TILE.w
  const grid = storeyGrid(map, cy)
  if (!grid) return
  const { walk, wv, wh } = grid
  // Light passes over a void (a pool) but not through a wall.
  const sees = (ax, az, path) => {
    for (let j = 0; j < path.length; j += 4) {
      const cx = ax + path[j]
      const cz = az + path[j + 1]
      const ex = ax + path[j + 2]
      const ez = az + path[j + 3]
      if (ex < 0 || ez < 0 || ex >= N || ez >= N) return false
      const xe = Math.max(cx, ex)
      const ze = Math.max(cz, ez)
      if (ex !== cx && ez !== cz) {
        const a = !wv[cz * N + xe] && !wh[ze * N + ex]
        if (!a && (wh[ze * N + cx] || wv[ez * N + xe])) return false
      } else if (ex !== cx ? wv[cz * N + xe] : wh[ze * N + cx]) return false
    }
    return true
  }
  const tubes = []
  for (let cz = 0; cz < TILE.d; cz++) {
    for (let cx = 0; cx < TILE.w; cx++) {
      const d = map.chunkAt(cx, cy, cz)
      if (!d) continue
      for (const l of d.lamps) {
        if (!l.lit) continue
        const gx = cx * side + l.lx
        const gz = cz * side + l.lz
        const ks = []
        for (let e = 0; e < COVER.length; e++) {
          const ent = COVER[e]
          const x = gx + ent[0]
          const z = gz + ent[1]
          if (ent[0] * ent[0] + ent[1] * ent[1] > PRUNE_R2 || x < 0 || z < 0 || x >= N || z >= N || !walk[z * N + x]) continue
          if (sees(gx, gz, ent[3])) ks.push(z * N + x)
        }
        tubes.push({ d, l, ks, bonus: l.tint === POOL_TINT && d.hasFloorHole(l.lx, l.lz) ? 1 : 0 })
      }
    }
  }
  const lit = new Uint8Array(N * N)
  const count = new Map()
  const keep = new Set()
  const take = (t) => {
    keep.add(t.l)
    count.set(t.d, (count.get(t.d) ?? 0) + 1)
    for (const k of t.ks) lit[k] = 1
  }
  // The pools' own cyan over the water first, `cyanKeep` a chunk-storey
  // (spread: every other one in the authored order).
  const cyan = new Map()
  for (const pass of [0, 1]) {
    tubes.forEach((t, i) => {
      if (!t.bonus || keep.has(t.l) || i % 2 !== pass || (cyan.get(t.d) ?? 0) >= cyanKeep) return
      cyan.set(t.d, (cyan.get(t.d) ?? 0) + 1)
      take(t)
    })
  }
  // Each round takes the tube lighting the most cells still dark (ties: the
  // first in order). Gains only fall as cells are lit, so a lazy greedy over
  // a max-heap of stale gains picks exactly that one.
  const gainOf = (t) => {
    let n = 0
    for (const k of t.ks) if (!lit[k]) n++
    return n
  }
  const heap = new LazyHeap((a, b) => a.n > b.n || (a.n === b.n && a.i < b.i))
  tubes.forEach((t, i) => {
    t.i = i
    if (keep.has(t.l)) return
    t.n = gainOf(t)
    if (t.n >= PRUNE_GAIN) heap.push(t)
  })
  while (heap.size) {
    const t = heap.pop()
    if ((count.get(t.d) ?? 0) >= cap) continue
    t.n = gainOf(t)
    if (t.n < PRUNE_GAIN) continue
    if (heap.size && (heap.peek().n > t.n || (heap.peek().n === t.n && heap.peek().i < t.i))) {
      heap.push(t)
      continue
    }
    take(t)
  }
  for (const t of tubes) if (!keep.has(t.l)) t.d.lamps = t.d.lamps.filter((l) => l !== t.l)
}

// At most `cap` lit lamps per chunk-storey (spec §11.1 item 9). A chunk over
// the cap takes down its most crowded plain tubes one by one (the lit tube
// whose nearest lit neighbour is closest, Chebyshev; ties by the dice), so
// the survivors stay spread and no surplus tube is left hanging dead (a dead
// tube is authored darkness: the fill light keeps away from it). The pool
// lights (tinted) go last.
const LIT_CAP = 9
// How far round a deep end the deck's tubes are dead (cells), by the tile's
// Chebyshev distance from the spawn tile (0,0): doc §3 "calm that turns" —
// the first pool halls are bright and calm, the deep ends alone dark; a tile
// further out hides its whole deep-end margin (the kind: the full reach).
const DEEP_REACH = Object.freeze([2, 5, 7])
// The gallery's unlit lofts: chambers dark until they hold this share of its
// floor (lampDeck darkShare).
const GALLERY_DARK = 0.15
const PIT_REACH = 3
function capLitLamps(map, r, cap) {
  for (const d of map.chunks.values()) {
    let lit = d.lamps.filter((l) => l.lit)
    if (lit.length <= cap) continue
    const rank = (l) => r(1000 + d.cy * 256 + l.lx * 16 + l.lz, d.cx * 64 + d.cz)
    const gone = new Set()
    while (lit.length > cap) {
      let worst = null
      let key = null
      for (const l of lit) {
        let near = Infinity
        for (const o of lit) if (o !== l) near = Math.min(near, Math.max(Math.abs(o.lx - l.lx), Math.abs(o.lz - l.lz)))
        const k = [l.tint === POOL_TINT ? 1 : 0, near, rank(l)]
        if (!key || k[0] < key[0] || (k[0] === key[0] && (k[1] < key[1] || (k[1] === key[1] && k[2] < key[2])))) {
          worst = l
          key = k
        }
      }
      gone.add(worst)
      lit = lit.filter((l) => l !== worst)
    }
    d.lamps = d.lamps.filter((l) => !gone.has(l))
  }
}

// Place a piece only where it cannot cut the floor: a plain walkable cell,
// outside every stair halo, whose open neighbours stay joined around it
// within the 3×3 block (a local test, so it is conservative).
function placeSafe(map, halos, cy, gx, gz, kind, { wall = null, facing = FACING.S } = {}) {
  if (halos.has(`${cy},${gx},${gz}`)) return false
  // The 3×3 block round the cell: walk[j] (j = (dz + 1)·3 + dx + 1), and
  // whether the wall line between two block cells is open.
  const walk = new Uint8Array(9)
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = gx + dx
      const z = gz + dz
      const d = map.chunkAt(map.cellChunk(x), cy, map.cellChunk(z))
      if (!d) continue
      const lx = map.cellLocal(x)
      const lz = map.cellLocal(z)
      const i = lz * CHUNK + lx
      const k = d.cellKind[i]
      walk[(dz + 1) * 3 + dx + 1] = !d.cols[i] && k !== CELL_STAIR && k !== CELL_VOID && k !== CELL_BRIDGE && !d.hasFloorHole(lx, lz) ? 1 : 0
    }
  }
  if (!walk[4]) return false
  const wallAt = (axis, x, z) => {
    const d = map.chunkAt(map.cellChunk(x), cy, map.cellChunk(z))
    if (!d) return false
    return (axis === 'v' ? d.wallV[vIdx(map.cellLocal(x), map.cellLocal(z))] : d.wallH[hIdx(map.cellLocal(x), map.cellLocal(z))]) > 0
  }
  // Block cells a (j) and b (j + 1 east, or j + 3 south) joined?
  const open = (j, east) => {
    const dx = (j % 3) - 1
    const dz = Math.floor(j / 3) - 1
    return east ? !wallAt('v', gx + dx + 1, gz + dz) : !wallAt('h', gx + dx, gz + dz + 1)
  }
  const join = (a, b) => walk[a] && walk[b] && (b === a + 1 ? open(a, true) : b === a - 1 ? open(b, true) : b === a + 3 ? open(a, false) : open(b, false))
  const nbrs = [1, 5, 7, 3].filter((j) => join(4, j))
  if (nbrs.length > 1) {
    let seen = 1 << nbrs[0]
    const queue = [nbrs[0]]
    while (queue.length) {
      const j = queue.pop()
      const x = j % 3
      for (const q of [x < 2 ? j + 1 : -1, x > 0 ? j - 1 : -1, j + 3 < 9 ? j + 3 : -1, j - 3 >= 0 ? j - 3 : -1]) {
        if (q < 0 || q === 4 || seen & (1 << q) || !join(j, q)) continue
        seen |= 1 << q
        queue.push(q)
      }
    }
    if (!nbrs.every((j) => seen & (1 << j))) return false
  }
  addPiece(map, cy, { gx, gz, kind, front: wall ? WALL_TO_FRONT[wall] : facing, wall })
  return true
}

// A binary max-heap under `before(a, b)` (a pops first).
class LazyHeap {
  constructor(before) {
    this.before = before
    this.a = []
  }

  get size() {
    return this.a.length
  }

  peek() {
    return this.a[0]
  }

  push(x) {
    const a = this.a
    a.push(x)
    let i = a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (!this.before(a[i], a[p])) break
      ;[a[i], a[p]] = [a[p], a[i]]
      i = p
    }
  }

  pop() {
    const a = this.a
    const top = a[0]
    const last = a.pop()
    if (a.length) {
      a[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < a.length && this.before(a[l], a[m])) m = l
        if (r < a.length && this.before(a[r], a[m])) m = r
        if (m === i) break
        ;[a[i], a[m]] = [a[m], a[i]]
        i = m
      }
    }
    return top
  }
}
