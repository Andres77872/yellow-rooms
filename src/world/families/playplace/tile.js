import {
  CELL,
  CELL_BRIDGE,
  CELL_CORRIDOR,
  CELL_LOBBY,
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
  SPACE_ROLE_DINING,
  SPACE_ROLE_LOUNGE,
  SPACE_ROLE_MEETING,
  SPACE_ROLE_NONE,
  SPACE_ROLE_STORAGE,
  WALL_RAIL,
  WALL_TO_FRONT,
  WALL_WINDOW,
  addPiece,
  featureEdge,
  labelFloor,
  rng,
} from '../../tiles/floorPlan.js'
import { CHUNK, chunkKey3 } from '../../constants.js'
import { CELL_OPEN, COLUMN_FURNITURE } from '../../mapTypes.js'
import { FURN_PLANT, FURN_SOFA, FURN_TABLE } from '../../rooms/catalog.js'
import { PIECE_DIMS } from '../../rooms/furnish.js'
import {
  PROP_ARCADE,
  PROP_BENCH,
  PROP_CHILD_CHAIR,
  PROP_CHILD_TABLE,
  PROP_MASCOT,
  PROP_PUNCH_BAG,
} from '../../props/index.js'
import { linkHalo } from '../../structures/catalog/engine.js'
import { finiteCtx, markExit, markSpawn } from '../../tiles/kit.js'
import { FILL_DEFAULTS, fillDarkCells } from '../../tiles/fillLight.js'
import { coverStorey } from './light.js'
import { createRoom, furnishRoom as furnishByRole } from '../../tiles/roomOps.js'
import { openOwnedSeam } from '../../tiles/seams.js'
import { planPick } from '../../tiles/tileKey.js'
import {
  CORR,
  DECK,
  FLOOR,
  HALL,
  MASS,
  PLAY_THEMES,
  POD,
  R,
  ROOM,
  SALT,
  TILE_CELLS,
  TOP,
  TUBE,
  anomalyAt,
  codeAt,
  edgeRule,
  exitPodOfLayout,
  grow,
  hallPlan,
  inRect,
  kindLayout,
  kindMetaOf,
  moduleLayout,
  spawnCellsOfLayout,
  walkableCode,
} from './geometry.js'

// 10 Playplace (docs/liminal_maps/10-playplace.md) — a soft-play centre after
// closing, GENERATED per module. geometry.js composes the module from its
// planSeed (halls, ports, crawl tubes, corridors, rooms: see its header); this
// file is the parts catalogue that builds what the plan names:
//
//   cy 2  top deck   the tall hall's upper gallery (its well, a net bridge)
//   cy 1  deck       the halls' first decks round their pits; the crawl-tube
//                    block (pods, tubes through padding, bubble windows onto
//                    the hall, mouths onto the deck and the mezzanine); the
//                    mezzanine's corridors, party rooms, café, toilets, staff
//                    office and store rooms
//   cy 0  floor      the halls' floors (ball pits behind nets, entered under
//                    the net bridges, padded panels, parents' benches, punch bags,
//                    the mascot at the main gate); the service floor's
//                    corridors, party rooms, arcade, lounge, toilets, staff room
//
// The halls are catalog volumes (frame, ball-pit hall, food court or
// fortress) through ctx.kit.catalog — the planner's descriptors at true
// global coordinates in tile mode, assembled here in finite mode. Crawl
// clearance, deck tiers, slides and balls (S1/S2/S5/S9) do not exist, so the
// terraced frame is built at storey scale and the tubes are 1-wide
// full-height corridors through padding mass.
//
// Light (light.js): the pits' tubes under their bridges and the identity
// rooms' own (party, arcade, lounge, café) first; then a sight-aware greedy
// cover of the hall boxes in the hall's tint (the bright heart), the pods,
// and a second cover over every corridor, room and pod outside the halls
// (one tube on a door lights a room and its corridor both). Both covers aim
// at the judge's own light model and stop at the world's lamp density, so a
// module's floor and deck are ≈ 9% dark (the halls ≈ 3%), not the doc's 0.
//
// THE tile program of the playplace family (spec §3.3, §12.9). The editor
// kind (src/editor/kinds/playplace.js) wraps it with FINITE_CTX_PLAYPLACE: a
// procedural sample module from the kind seed (geometry.kindLayout), with no
// seams and always a tall hall (three storeys).

export { PLAY_THEMES }
export const RED_PIT_TINT = 0xff8c80 // anomaly 1: the pit whose balls are all red
const ARCADE_TINT = 0xe6c4ff // attract screens: the arcade glows violet

// The kind lab's finite ctx.
export const FINITE_CTX_PLAYPLACE = finiteCtx({})

const N = TILE_CELLS
const MODULE = R(0, 0, N - 1, N - 1)
const STOREY_LABEL = ['PLAy', 'FUn', 'yAy']

export function buildPlayplaceTile(map, seed, ctx = FINITE_CTX_PLAYPLACE) {
  const tile = ctx.mode === 'tile'
  const r = rng(seed, SALT)
  const lay = tile ? moduleLayout(ctx.worldSeed, ctx.key.tx, ctx.key.tz) : kindLayout(seed)
  if (lay.halls.some((h) => !h)) return { error: 'playplace: a hall slot is null' }
  const halls = lay.halls
  const anomaly = tile ? anomalyAt(ctx.worldSeed, ctx.key) : r(2) % 3 === 0 ? 'redPit' : null
  const storeys = lay.tall ? [FLOOR, DECK, TOP] : [FLOOR, DECK]

  // --- plans (every storey compiled before any stamp) -------------------------
  for (const cy of storeys) compileStorey(map, lay, cy)
  // §6.8 rule 3: open the owned West/North lines at the declared ports.
  if (tile) {
    for (const cy of [FLOOR, DECK]) {
      openOwnedSeam(map, ctx, cy, 'west')
      openOwnedSeam(map, ctx, cy, 'north')
    }
  }

  // --- the halls ----------------------------------------------------------------------
  const descs = []
  for (const h of halls) {
    const res = stampHall(map, ctx, lay, h)
    if (res.error) return res
    descs.push(res.desc)
  }
  // The stamps carve their boxes and open the boxes' outer edges: the plan
  // is restored outside the boxes, then every box edge takes the plan's rule
  // (a door, a bubble window, a padded wall).
  for (const cy of storeys) restoreOutside(map, lay.storeys[cy], cy, halls)
  for (const h of halls) for (let cy = FLOOR; cy < h.L; cy++) boxEdges(map, lay.storeys[cy], cy, h)

  // --- rooms ------------------------------------------------------------------------
  // Shells first (parent before child, so every door is cut), then the
  // role grammar's furniture, which keeps every door cell free.
  const made = []
  for (const cy of [FLOOR, DECK]) {
    for (const rm of lay.storeys[cy].rooms) made.push({ cy, rm, room: makeRoom(map, cy, rm, r) })
  }
  // (a 1-wide sliver stays bare: the grammar would only plug it).
  const roomy = (rm) => Math.min(rm.x1 - rm.x0, rm.z1 - rm.z0) >= 1 && (rm.x1 - rm.x0 + 1) * (rm.z1 - rm.z0 + 1) >= 6
  for (const { rm, room } of made) if (ROOM_SPEC[rm.role].furnish && roomy(rm)) furnishByRole(map, room)

  // --- hall interiors ----------------------------------------------------------------
  const halos = new Set()
  const halo = (cy, gx, gz) => halos.add(`${cy},${gx},${gz}`)
  for (const desc of descs) {
    for (const link of desc.verticalLinks) {
      const hl = linkHalo(link)
      for (const cy of [link.lowerCy, link.lowerCy + 1]) {
        for (let gz = hl.z0; gz <= hl.z1; gz++) for (let gx = hl.x0; gx <= hl.x1; gx++) halo(cy, gx, gz)
      }
    }
  }
  // Doors stay clear on both sides (hall gates, tube mouths, room doors).
  const doorCells = (cy, dd) => {
    const [ax, az, bx, bz] = dd.axis === 'v' ? [dd.gx - 1, dd.gz, dd.gx, dd.gz] : [dd.gx, dd.gz - 1, dd.gx, dd.gz]
    halo(cy, ax, az)
    halo(cy, bx, bz)
  }
  for (const cy of storeys) {
    for (const dd of lay.storeys[cy].doors.values()) doorCells(cy, dd)
    for (const rm of lay.storeys[cy].rooms) doorCells(cy, rm.door)
  }
  const spawnCells = tile ? (ctx.key.tx === 0 && ctx.key.tz === 0 ? spawnCellsOfLayout(lay) : []) : spawnCellsOfLayout(lay)
  // The first few spawn candidates stay clear of furniture (the hook takes
  // the first that passes in the baked chunk; geometry.spawnCellsOfLayout).
  for (const c of spawnCells.slice(0, 4)) halo(FLOOR, c.gx, c.gz)
  const exitPod = exitPodOfLayout(lay)
  halo(exitPod.cy, exitPod.gx, exitPod.gz)

  let panels = 0
  const pitLamps = []
  const redHall = halls.find((h) => h.type !== 'court' && h.levels[1].voids.length) ?? halls[0]
  for (const h of halls) {
    const pits = h.levels[1].voids
    if (h.type === 'frame' || h.type === 'pitHall') for (const v of pits) pitWalls(map, h, v, r)
    if (h.type === 'frame' || h.type === 'fortress') {
      for (let cy = FLOOR; cy < h.L; cy++) {
        const rects = [...(h.levels[cy]?.voids ?? []), ...(h.levels[cy + 1]?.voids ?? [])]
        for (const [i, v] of rects.entries()) panels += baffles(map, cy, v, h.box, halos, (n) => r(60 + cy * 8 + i + h.slot * 40, n))
      }
      for (let k = 1; k < h.L; k++) for (const v of h.levels[k].voids) padWell(map, k, v, k === h.L - 1 && h.L === 3 ? null : h.netSide)
    }
    // The pit's lamp on the floor: under a net bridge, else on a roofed cell
    // beside the pit (red on the red-pit anomaly).
    if (pits.length) {
      const red = anomaly === 'redPit' && h === redHall
      const tint = red ? RED_PIT_TINT : h.theme.tint
      const at = pitLampCell(map, h, pits[0])
      if (at) {
        map.setLamp(at[0], FLOOR, at[1], true, tint)
        pitLamps.push([at[0], at[1]])
      }
      // More tubes under the net bridges (the pit's only ceiling), three
      // cells apart, so the pit floor is lit across its width.
      for (const br of h.levels[1].bridges) {
        const along = br.z0 === br.z1
        const n = along ? br.x1 - br.x0 + 1 : br.z1 - br.z0 + 1
        for (let t = 1; t < n - 1; t += 3) {
          const gx = along ? br.x0 + t : br.x0
          const gz = along ? br.z0 : br.z0 + t
          if (!pits.some((v) => inRect(v, gx, gz)) || map.lampAt(gx, FLOOR, gz)) continue
          if (pitLamps.some(([x, z]) => Math.max(Math.abs(x - gx), Math.abs(z - gz)) < 2)) continue
          map.setLamp(gx, FLOOR, gz, true, tint)
          pitLamps.push([gx, gz])
        }
      }
    }
  }
  // No tube hangs over a hole.
  for (const d of map.chunks.values()) d.lamps = d.lamps.filter((l) => !d.hasCeilHole(l.lx, l.lz) && !d.hasFloorHole(l.lx, l.lz))

  // --- light -----------------------------------------------------------------------------
  const st0 = lay.storeys[FLOOR]
  const st1 = lay.storeys[DECK]
  // The halls first (the brightest rooms, doc §8: a sight-aware cover in
  // the hall's tint, up to HALL_COVER_CAP per chunk-storey), then the pods,
  // then the corridors and rooms (a cover up to PLAIN_CAP).
  const hallAt = (cy, gx, gz) => halls.find((h) => cy < h.L && inRect(h.box, gx, gz)) ?? null
  // The plan compiler's plain tubes go (the covers place every plain tube);
  // the pits' tubes and the identity rooms' own (party, arcade, lounge,
  // café) stay.
  const own = new Set()
  for (const { cy, rm } of made) {
    if (!ROOM_SPEC[rm.role].lamp) continue
    for (let gz = rm.z0; gz <= rm.z1; gz++) for (let gx = rm.x0; gx <= rm.x1; gx++) own.add(`${cy},${gx},${gz}`)
  }
  const o = map.origin ?? { cx: 0, cy: 0, cz: 0 }
  for (const d of map.chunks.values()) {
    d.lamps = d.lamps.filter((l) => l.tint != null || own.has(`${d.cy - o.cy},${(d.cx - o.cx) * CHUNK + l.lx},${(d.cz - o.cz) * CHUNK + l.lz}`))
  }
  for (const cy of storeys) {
    coverStorey(map, cy, REGION, {
      isTarget: (gx, gz) => !!hallAt(cy, gx, gz),
      capOf: () => HALL_COVER_CAP,
      tintAt: (gx, gz) => hallAt(cy, gx, gz)?.theme.tint ?? null,
    })
  }
  const podLamps = []
  for (const tb of st1.tubeBlocks) {
    for (const p of tb.pods) {
      if (p.degree >= 3 || (p.gx === tb.exitPod.gx && p.gz === tb.exitPod.gz)) {
        map.setLamp(p.gx, DECK, p.gz, true)
        podLamps.push([p.gx, p.gz])
      }
    }
  }
  for (const st of [st0, st1]) {
    const cy = st.cy
    coverStorey(map, cy, REGION, {
      isTarget: (gx, gz) => {
        const c = st.cells[gz * N + gx]
        return (c === CORR || c === ROOM || c === POD) && !hallAt(cy, gx, gz)
      },
      capOf: () => PLAIN_CAP,
    })
  }

  // --- furniture ---------------------------------------------------------------------------
  const put = (cy, gx, gz, kind, opts) => placeSafe(map, halos, cy, gx, gz, kind, opts)
  const placed = { parties: 0, arcade: 0, booths: 0, benches: 0, bags: 0, mascot: null }
  for (const { cy, rm } of made) furnishRoom(map, put, cy, rm, anomaly, placed, r)
  for (const h of halls) furnishHall(put, h, r, placed)
  for (const cy of [FLOOR, DECK]) placed.benches += corridorBenches(map, put, lay.storeys[cy], (i) => r(980 + cy, i))
  // The mascot by the first hall's main gate, facing whoever comes in; on
  // the 'mascot' anomaly it has moved up to the highest deck.
  const gate = st0.gates[0]
  const mascotHall = anomaly === 'mascot' ? (lay.tall ?? halls.reduce((a, b) => (b.L > a.L ? b : a))) : null
  if (mascotHall) placed.mascot = placeOnDeck(put, mascotHall, mascotHall.L - 1, PROP_MASCOT, r)
  else if (gate) placed.mascot = placeNear(put, FLOOR, gate.inside, halls[gate.slot].bounds, PROP_MASCOT, r)

  // The grammars test their pieces one chunk (or one 3×3 block) at a time:
  // a run of pieces across a chunk seam can still close a passage. Every
  // storey's walk is re-joined here by lifting the fewest pieces.
  for (const cy of storeys) unplugFurniture(map, cy)

  // --- plates, markers, the lamp budget -------------------------------------------------
  for (const cy of storeys) labelFloor(map, cy, STOREY_LABEL[cy])
  if (tile) {
    markExit(map, ctx, exitPod)
    if (ctx.key.tx === 0 && ctx.key.tz === 0 && spawnCells.length) markSpawn(map, ctx, { ...spawnCells[0], cy: FLOOR })
  }
  const keep = new Set()
  for (const [gx, gz] of pitLamps) keep.add(map.lampAt(gx, FLOOR, gz)?.rec)
  for (const [gx, gz] of podLamps) keep.add(map.lampAt(gx, DECK, gz)?.rec)
  keep.delete(undefined)
  const inHall = (d, l) => {
    const o = map.origin ?? { cx: 0, cy: 0, cz: 0 }
    const cy = d.cy - o.cy
    const gx = (d.cx - o.cx) * CHUNK + l.lx
    const gz = (d.cz - o.cz) * CHUNK + l.lz
    return halls.some((h) => cy < h.L && inRect(h.box, gx, gz))
  }
  capLitLamps(map, (d) => capOf(map, halls, d), keep, inHall)
  // The kind lab never reaches the bake's fill pass (generator.js): the
  // sample takes the same plain fill here, so it reads as the world does.
  if (!tile) kindFill(map, halls, lay)

  // What stands after the unplug pass (it may lift a piece or two).
  const kinds = (kind) => {
    let n = 0
    for (const d of map.chunks.values()) for (const f of d.furniture) if (f.kind === kind) n++
    return n
  }
  const notes = [
    `module: ${halls.map((h) => `${h.type} ${h.bounds.x1 - h.bounds.x0 + 1}×${h.bounds.z1 - h.bounds.z0 + 1} (${h.L} storeys, ${h.theme.name})`).join(', ')}; ${panels} padded panels`,
    `floor: ${st0.stats.corridor} corridor cells, ${st0.stats.loops} loop corridors, ${st0.rooms.length} rooms (${roleCount(st0, 'party')} party rooms, arcade ${roleCount(st0, 'arcade')}, lounge ${roleCount(st0, 'lounge')})`,
    `deck: ${st1.stats.corridor} corridor cells, ${st1.rooms.length} rooms; crawl blocks ${st1.tubeBlocks.length ? st1.tubeBlocks.map((b) => `${b.nx}×${b.nz} pods, ${b.tubes} tubes, ${b.loops} crawl-only loops, ${b.mouths.length} mouths, ${b.windows.length} bubble windows`).join('; ') : 'none'}`,
    `look for: ${kinds(PROP_CHILD_TABLE)} party tables, ${kinds(PROP_ARCADE)} arcade cabinets, ${placed.booths} booths, ${kinds(PROP_PUNCH_BAG)} punch bags, ${kinds(PROP_BENCH)} empty parents' benches`,
    'stand-ins: no crawl clearance, deck tiers or slides (S1/S5/S9), so tiers are whole storeys (3.6 m), crawl tubes are full-height 1-wide corridors and the catalog flights are the climbs; the pits have no balls (S2); hall themes are lamp tints; no lights-out (S13), mascot behaviour (S12) or dead acoustics (S17)',
  ]
  if (tile) {
    ctx.notes.push(...notes)
    if (anomaly) ctx.notes.push(`anomaly: ${anomaly}`)
  }
  const sp = spawnCells[0] ?? { gx: 1, gz: 1 }
  return { spawn: { gx: sp.gx, gz: sp.gz, cy: FLOOR }, notes }
}

const roleCount = (st, role) => st.rooms.filter((rm) => rm.role === role).length

// --- plans ---------------------------------------------------------------------------------

const KIND_OF = { [CORR]: CELL_CORRIDOR, [ROOM]: CELL_ROOM, [HALL]: CELL_LOBBY, [TUBE]: CELL_CORRIDOR, [POD]: CELL_CORRIDOR }

// The chunk rectangle (module-local cells) of a box.
const chunkRectOf = (box) => {
  const cx0 = Math.floor(box.x0 / 14)
  const cz0 = Math.floor(box.z0 / 14)
  const cx1 = Math.floor(box.x1 / 14)
  const cz1 = Math.floor(box.z1 / 14)
  return R(cx0 * 14, cz0 * 14, cx1 * 14 + 13, cz1 * 14 + 13)
}

function compileStorey(map, lay, cy) {
  const st = lay.storeys[cy]
  const region = cy === TOP ? chunkRectOf(lay.tall.box) : MODULE
  const p = new FloorPlan(region)
  for (let gz = region.z0; gz <= region.z1; gz++) {
    for (let gx = region.x0; gx <= region.x1; gx++) {
      const c = codeAt(st, gx, gz)
      if (!walkableCode(c)) continue
      p.open(gx, gz, KIND_OF[c], c === ROOM ? 300 + st.roomNo[gz * N + gx] : 0, SPACE_ROLE_NONE)
    }
  }
  for (let gz = region.z0; gz <= region.z1; gz++) {
    for (let gx = region.x0; gx <= region.x1; gx++) {
      if (!walkableCode(codeAt(st, gx, gz))) continue
      for (const [nx, nz] of [[gx + 1, gz], [gx, gz + 1]]) {
        if (!inRect(region, nx, nz) || !walkableCode(codeAt(st, nx, nz))) continue
        const axis = nx !== gx ? 'v' : 'h'
        applyRule(p, axis, nx, nz, edgeRule(st, gx, gz, nx, nz))
      }
    }
  }
  p.compile(map, cy)
}

function applyRule(p, axis, gx, gz, rule) {
  if (rule === 'open') return
  if (rule === 'wall') p.edge(axis, gx, gz, 1, PASSAGE_WALL)
  else if (rule === 'window') p.window(axis, gx, gz)
  else p.edge(axis, gx, gz, 0, rule.passage === 'wide' ? PASSAGE_WIDE : PASSAGE_DOOR)
}

// The hall volume through the kit: finite mode assembles it here (office
// family, the kind's fixed ids) with the pick geometry validated; tile mode
// looks the planner's volume up by slot (true global coordinates, kind
// 'playplaceCatalog') and gets its local view.
function stampHall(map, ctx, lay, h) {
  let why = null
  const desc = ctx.kit.catalog(
    map,
    hallPlan(h),
    kindMetaOf(h.slot, h),
    planPick(lay.planSeed, h.slot, h.attempt),
    (reasons) => { why = reasons },
  )
  if (!desc) return { error: `playplace: hall ${h.slot} rejected (${(why ?? ['planner null slot']).join(', ')})` }
  return { desc }
}

// Outside every box, put each cell back as the plan has it (a stamp's
// approach carve can cut through mass when a ring finds no floor in its
// chunk): mass where the plan has mass, walled against its walkable
// neighbours.
function restoreOutside(map, st, cy, halls) {
  const boxes = halls.filter((h) => h.L > cy).map((h) => h.box)
  const inBox = (gx, gz) => boxes.some((b) => inRect(b, gx, gz))
  for (let gz = 0; gz < N; gz++) {
    for (let gx = 0; gx < N; gx++) {
      if (inBox(gx, gz) || walkableCode(codeAt(st, gx, gz))) continue
      const c = map.cellAt(gx, cy, gz)
      if (!c.chunk || c.col) continue
      map.setCell(gx, cy, gz, { kind: CELL_OPEN, spaceId: 0, role: SPACE_ROLE_NONE, col: COLUMN_STANDARD })
      for (const [nx, nz] of [[gx - 1, gz], [gx + 1, gz], [gx, gz - 1], [gx, gz + 1]]) {
        const n = map.cellAt(nx, cy, nz)
        const walk = n.chunk && !n.col
        const set = (wall) => (nx !== gx
          ? map.setWallV(Math.max(gx, nx), cy, gz, wall, wall ? PASSAGE_WALL : PASSAGE_OPEN)
          : map.setWallH(gx, cy, Math.max(gz, nz), wall, wall ? PASSAGE_WALL : PASSAGE_OPEN))
        if (!map.chunkAt(map.cellChunk(Math.max(gx, nx)), cy, map.cellChunk(Math.max(gz, nz)))) continue
        set(walk ? 1 : 0)
      }
    }
  }
}

// Every edge of hall h's box on storey cy takes the plan's rule: a door (a
// gate, a deck door, a tube mouth), a bubble window, else a padded wall.
function boxEdges(map, st, cy, h) {
  const b = h.box
  const apply = (axis, gx, gz, ix, iz, ox, oz) => {
    let rule = 'wall'
    if (walkableCode(codeAt(st, ox, oz)) && codeAt(st, ox, oz) !== HALL) rule = edgeRule(st, ix, iz, ox, oz)
    const set = (wall, passage) => (axis === 'v' ? map.setWallV(gx, cy, gz, wall, passage) : map.setWallH(gx, cy, gz, wall, passage))
    if (rule === 'window') featureEdge(map, axis, gx, cy, gz, WALL_WINDOW)
    else if (rule === 'wall' || rule === 'open') set(1, PASSAGE_WALL)
    else set(0, rule.passage === 'wide' ? PASSAGE_WIDE : PASSAGE_DOOR)
  }
  for (let gx = b.x0; gx <= b.x1; gx++) {
    apply('h', gx, b.z0, gx, b.z0, gx, b.z0 - 1)
    apply('h', gx, b.z1 + 1, gx, b.z1, gx, b.z1 + 1)
  }
  for (let gz = b.z0; gz <= b.z1; gz++) {
    apply('v', b.x0, gz, b.x0, gz, b.x0 - 1, gz)
    apply('v', b.x1 + 1, gz, b.x1, gz, b.x1 + 1, gz)
  }
}

// --- rooms ---------------------------------------------------------------------------------

const ROOM_SPEC = {
  party: { role: SPACE_ROLE_DINING, furnish: false, lamp: true },
  arcade: { role: SPACE_ROLE_NONE, furnish: false, lamp: true },
  lounge: { role: SPACE_ROLE_LOUNGE, furnish: false, lamp: true },
  cafe: { role: SPACE_ROLE_LOUNGE, furnish: false, lamp: true },
  toilets: { role: SPACE_ROLE_BATHROOM, furnish: true, lamp: false },
  staff: { role: SPACE_ROLE_MEETING, furnish: true, lamp: false },
  store: { role: SPACE_ROLE_STORAGE, furnish: true, lamp: false },
}
// The service rooms take their tubes from the plain cover (light.js), often
// one on the door that lights the corridor too; the identity rooms hang
// their own.

function makeRoom(map, cy, rm, r) {
  const spec = ROOM_SPEC[rm.role]
  const room = createRoom(map, {
    cy, x0: rm.x0, z0: rm.z0, x1: rm.x1, z1: rm.z1, role: spec.role, salt: r(500 + cy * 100 + rm.no) % 997,
    door: rm.door, lamp: spec.lamp, furnish: false,
  })
  if (rm.role === 'arcade') {
    const l = map.lampAt(Math.floor((rm.x0 + rm.x1) / 2), cy, Math.floor((rm.z0 + rm.z1) / 2))
    if (l) map.setLamp(Math.floor((rm.x0 + rm.x1) / 2), cy, Math.floor((rm.z0 + rm.z1) / 2), true, ARCADE_TINT)
  }
  return room
}

// The ring of 8 cells round a party table, clockwise from north.
const RING8 = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]]
const FACE_TABLE = (dx, dz) => (Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? FACING.W : FACING.E) : dz > 0 ? FACING.N : FACING.S)

// A child table in the 3×3 room's centre with four chairs on the arc of the
// ring farthest from every door cell (its own and its en-suite children's;
// a shorter arc where the doors leave no four free in a row): the rest of
// the ring stays one walk. One record per cell.
function partyTable(map, cy, rm) {
  const tx = rm.x0 + 1
  const tz = rm.z0 + 1
  const doorCells = [rm.inside, ...rm.childDoors]
  let best = -1
  let bestScore = -1
  let len = 4
  // Four chairs on a free arc; a room with doors on many sides seats fewer.
  for (; len >= 0 && best < 0; len--) {
    const span = [0, 1, 2, 3].slice(0, len)
    for (let s = 0; s < 8; s++) {
      const arc = span.map((k) => RING8[(s + k) % 8])
      if (arc.some(([dx, dz]) => doorCells.some(([x, z]) => x === tx + dx && z === tz + dz))) continue
      const score = arc.reduce((n, [dx, dz]) => n + Math.min(...doorCells.map(([x, z]) => Math.abs(x - tx - dx) + Math.abs(z - tz - dz))), 0)
      if (score > bestScore) {
        bestScore = score
        best = s
      }
    }
  }
  if (best < 0) return false
  const arc = [0, 1, 2, 3].slice(0, len + 1).map((k) => RING8[(best + k) % 8])
  const cells = [[tx, tz], ...arc.map(([dx, dz]) => [tx + dx, tz + dz])]
  if (cells.some(([x, z]) => map.cellAt(x, cy, z).col)) return false
  const centre = (x, z) => [(map.cellLocal(x) + 0.5) * CELL, (map.cellLocal(z) + 0.5) * CELL]
  const [tw, td] = PIECE_DIMS[PROP_CHILD_TABLE]
  const [cw, cd] = PIECE_DIMS[PROP_CHILD_CHAIR]
  const [x0, z0] = centre(tx, tz)
  map.addFurniture(tx, cy, tz, { kind: PROP_CHILD_TABLE, x: x0, z: z0, w: tw, d: td, facing: FACING.S })
  const pull = CELL / 2 - cd / 2 - 0.06
  for (const [dx, dz] of arc) {
    const [x, z] = centre(tx + dx, tz + dz)
    map.addFurniture(tx + dx, cy, tz + dz, {
      kind: PROP_CHILD_CHAIR, x: x - Math.sign(dx) * pull, z: z - Math.sign(dz) * pull, w: cw, d: cd, facing: FACE_TABLE(dx, dz),
    })
  }
  return true
}

function furnishRoom(map, put, cy, rm, anomaly, placed, r) {
  const w = rm.x1 - rm.x0 + 1
  const d = rm.z1 - rm.z0 + 1
  if (rm.role === 'party') {
    if (partyTable(map, cy, rm)) placed.parties++
    return
  }
  if (rm.role === 'arcade') {
    // Cabinets along both long walls, screens into the aisle; on the
    // 'arcade' anomaly every cabinet faces the door, in sync.
    const turned = anomaly === 'arcade'
    const [dx, dz] = [rm.inside[0], rm.inside[1]]
    const towards = (gx, gz) => FACE_TABLE(dx - gx, dz - gz)
    const along = w >= d
    for (let t = along ? rm.x0 : rm.z0; t <= (along ? rm.x1 : rm.z1); t++) {
      const pair = along ? [[t, rm.z0, 'N'], [t, rm.z1, 'S']] : [[rm.x0, t, 'W'], [rm.x1, t, 'E']]
      for (const [gx, gz, wall] of pair) {
        if (put(cy, gx, gz, PROP_ARCADE, turned ? { facing: towards(gx, gz) } : { wall })) placed.arcade++
      }
    }
    return
  }
  if (rm.role === 'lounge' || rm.role === 'cafe') {
    // Booths: a sofa against the long walls with a table in front.
    const along = w >= d
    for (let t = (along ? rm.x0 : rm.z0) + 1; t <= (along ? rm.x1 : rm.z1) - 1; t += 2) {
      const sets = along
        ? [[t, rm.z0, 'N', t, rm.z0 + 1], [t, rm.z1, 'S', t, rm.z1 - 1]]
        : [[rm.x0, t, 'W', rm.x0 + 1, t], [rm.x1, t, 'E', rm.x1 - 1, t]]
      for (const [sx, sz, wall, tx, tz] of sets) {
        if (put(cy, sx, sz, FURN_SOFA, { wall })) {
          placed.booths++
          put(cy, tx, tz, FURN_TABLE)
        }
      }
    }
    put(cy, rm.x1, rm.z0, FURN_PLANT, { wall: 'E' })
    return
  }
  if (rm.role === 'store' && w >= 2 && d >= 2 && r(800 + cy * 100 + rm.no) % 2 === 0) {
    // A spare foam punch bag in a store room.
    if (put(cy, rm.x0 + (r(810 + rm.no) % w), rm.z0 + (r(811 + rm.no) % d), PROP_PUNCH_BAG, { facing: r(812 + rm.no) % 4 })) placed.bags++
  }
}

// Parents' benches on the hall floor's lane (against the box walls, always
// empty) and foam punch bags on every storey of the hall.
function furnishHall(put, h, r, placed) {
  const b = h.box
  const lane = []
  for (let gx = b.x0 + 1; gx < b.x1; gx++) lane.push([gx, b.z0, 'N'], [gx, b.z1, 'S'])
  for (let gz = b.z0 + 1; gz < b.z1; gz++) lane.push([b.x0, gz, 'W'], [b.x1, gz, 'E'])
  const order = lane.map((c, i) => ({ c, k: r(900 + h.slot, i) })).sort((a, b2) => a.k - b2.k)
  const wantBenches = 2 + (r(905 + h.slot) % 3)
  const benches = []
  for (const { c: [gx, gz, wall] } of order) {
    if (benches.length === wantBenches) break
    if (benches.some(([x, z]) => Math.abs(x - gx) + Math.abs(z - gz) < 3)) continue
    if (put(FLOOR, gx, gz, PROP_BENCH, { wall })) benches.push([gx, gz])
  }
  placed.benches += benches.length
  // A food court's floor: fast-food tables on a hashed lattice two cells
  // apart, chairs drawn up on hashed sides.
  if (h.type === 'court') {
    const ox = r(940 + h.slot) % 2
    const oz = r(941 + h.slot) % 2
    for (let gz = h.bounds.z0 + oz; gz <= h.bounds.z1; gz += 2) {
      for (let gx = h.bounds.x0 + ox; gx <= h.bounds.x1; gx += 2) {
        if (r(942 + h.slot, gz * 64 + gx) % 4 === 0) continue
        if (!put(FLOOR, gx, gz, FURN_TABLE)) continue
        placed.booths++
      }
    }
  }
  const spots = []
  for (let gz = h.bounds.z0; gz <= h.bounds.z1; gz++) for (let gx = h.bounds.x0; gx <= h.bounds.x1; gx++) spots.push([gx, gz])
  for (let cy = FLOOR; cy < h.L; cy++) {
    const want = cy === FLOOR ? 3 + (r(910 + h.slot) % 3) : 2 + (r(911 + h.slot, cy) % 2)
    const pits = (h.levels[1]?.voids ?? []).map((v) => grow(v, 1))
    const ord = spots.filter(([x, z]) => !pits.some((v) => inRect(v, x, z))).map((s, i) => ({ s, k: r(920 + h.slot * 4 + cy, i) })).sort((a, b2) => a.k - b2.k)
    let got = 0
    for (const [i, { s: [gx, gz] }] of ord.entries()) {
      if (got === want) break
      if (put(cy, gx, gz, PROP_PUNCH_BAG, { facing: r(930 + cy, i) % 4 })) got++
    }
    placed.bags += got
  }
}

// Parents' benches along the corridors, always empty: against a wall where
// the corridor is two cells wide (the cell across is corridor), at least four
// cells apart, about one spot in five.
function corridorBenches(map, put, st, roll) {
  const cy = st.cy
  const is = (x, z) => codeAt(st, x, z) === CORR
  const spots = []
  for (let gz = 1; gz < N - 1; gz++) {
    for (let gx = 1; gx < N - 1; gx++) {
      if (!is(gx, gz)) continue
      const sides = [['N', gx, gz - 1, gx, gz + 1], ['S', gx, gz + 1, gx, gz - 1], ['W', gx - 1, gz, gx + 1, gz], ['E', gx + 1, gz, gx - 1, gz]]
      for (const [wall, wx, wz, ox, oz] of sides) {
        if (is(wx, wz) || !is(ox, oz)) continue
        spots.push({ gx, gz, wall, k: roll(gz * N + gx) })
        break
      }
    }
  }
  spots.sort((a, b) => a.k - b.k)
  const done = []
  for (const sp of spots) {
    if (sp.k % 5 !== 0) continue
    if (done.some(([x, z]) => Math.abs(x - sp.gx) + Math.abs(z - sp.gz) < 4)) continue
    if (put(cy, sp.gx, sp.gz, PROP_BENCH, { wall: sp.wall })) done.push([sp.gx, sp.gz])
  }
  return done.length
}

// A piece on deck k of hall h (the first cell of the box lane, then the
// bounds, that placeSafe accepts), facing into the hall.
function placeOnDeck(put, h, cy, kind, r) {
  const cells = []
  for (let gz = h.box.z0; gz <= h.box.z1; gz++) for (let gx = h.box.x0; gx <= h.box.x1; gx++) cells.push([gx, gz])
  const ord = cells.map((c, i) => ({ c, k: r(950 + cy, i) })).sort((a, b) => a.k - b.k)
  const mx = (h.box.x0 + h.box.x1) / 2
  const mz = (h.box.z0 + h.box.z1) / 2
  for (const { c: [gx, gz] } of ord) if (put(cy, gx, gz, kind, { facing: FACE_TABLE(mx - gx, mz - gz) })) return { cy, gx, gz }
  return null
}

// A piece within 3 cells of (gx, gz) inside rect `bounds`, nearest first.
function placeNear(put, cy, [gx0, gz0], bounds, kind, r) {
  const cells = []
  for (let gz = bounds.z0; gz <= bounds.z1; gz++) {
    for (let gx = bounds.x0; gx <= bounds.x1; gx++) {
      const dist = Math.abs(gx - gx0) + Math.abs(gz - gz0)
      if (dist >= 1 && dist <= 4) cells.push({ gx, gz, dist, k: r(960, gx * 64 + gz) })
    }
  }
  cells.sort((a, b) => a.dist - b.dist || a.k - b.k)
  for (const c of cells) if (put(cy, c.gx, c.gz, kind, { facing: FACE_TABLE(gx0 - c.gx, gz0 - c.gz) })) return { cy, gx: c.gx, gz: c.gz }
  return null
}

// --- hall touch-ups ---------------------------------------------------------------------------

// The ball pit on the hall floor: walls round the void's footprint, entered
// under a net bridge from both ends (or, with no bridge, at two hashed gaps).
function pitWalls(map, h, pit, r) {
  const gaps = new Set()
  const br = h.levels[1].bridges.find((b) => inRect(pit, b.x0, b.z0))
  if (br && br.z0 === br.z1) gaps.add(`v:${pit.x0},${br.z0}`).add(`v:${pit.x1 + 1},${br.z0}`)
  else if (br) gaps.add(`h:${br.x0},${pit.z0}`).add(`h:${br.x0},${pit.z1 + 1}`)
  else {
    gaps.add(`v:${pit.x0},${pit.z0 + (r(970 + h.slot) % (pit.z1 - pit.z0 + 1))}`)
    gaps.add(`v:${pit.x1 + 1},${pit.z0 + (r(971 + h.slot) % (pit.z1 - pit.z0 + 1))}`)
  }
  for (let gz = pit.z0; gz <= pit.z1; gz++) {
    for (const gx of [pit.x0, pit.x1 + 1]) {
      if (gaps.has(`v:${gx},${gz}`)) map.setWallV(gx, FLOOR, gz, 0, PASSAGE_WIDE)
      else featureEdge(map, 'v', gx, FLOOR, gz, WALL_RAIL)
    }
  }
  for (let gx = pit.x0; gx <= pit.x1; gx++) {
    for (const gz of [pit.z0, pit.z1 + 1]) {
      if (gaps.has(`h:${gx},${gz}`)) map.setWallH(gx, FLOOR, gz, 0, PASSAGE_WIDE)
      else featureEdge(map, 'h', gx, FLOOR, gz, WALL_RAIL)
    }
  }
}

// The pit lamp's cell on the floor: under a net bridge (the pit's only
// ceiling), else the roofed hall cell beside the pit nearest its middle.
function pitLampCell(map, h, pit) {
  const roofed = (gx, gz) => {
    const c = map.cellAt(gx, FLOOR, gz)
    if (!c.chunk || c.col) return false
    const lx = map.cellLocal(gx)
    const lz = map.cellLocal(gz)
    return !c.chunk.hasCeilHole(lx, lz) && !c.chunk.hasFloorHole(lx, lz) && !map.lampAt(gx, FLOOR, gz)
  }
  const mx = Math.floor((pit.x0 + pit.x1) / 2)
  const mz = Math.floor((pit.z0 + pit.z1) / 2)
  const cells = []
  for (let gz = pit.z0 - 1; gz <= pit.z1 + 1; gz++) for (let gx = pit.x0 - 1; gx <= pit.x1 + 1; gx++) if (inRect(h.bounds, gx, gz)) cells.push([gx, gz])
  // Under a bridge (a roofed cell inside the pit) first, nearest the middle.
  const inside = (c) => (inRect(pit, c[0], c[1]) ? 0 : 1)
  cells.sort((a, b) => inside(a) - inside(b) || (Math.abs(a[0] - mx) + Math.abs(a[1] - mz)) - (Math.abs(b[0] - mx) + Math.abs(b[1] - mz)) || a[1] - b[1] || a[0] - b[0])
  return cells.find(([gx, gz]) => roofed(gx, gz)) ?? null
}

// Panels on the four lines of `rect` (a pit, a well, a hole) carried out to
// the hall's box walls: each run keeps one seeded gap, and a panel is skipped
// where it would touch a flight's halo or cut the hall (the two cells it
// separates must stay joined inside the box). Returns the panels placed.
function baffles(map, cy, rect, box, halos, roll) {
  const mx = Math.floor((rect.x0 + rect.x1 + 1) / 2)
  const mz = Math.floor((rect.z0 + rect.z1 + 1) / 2)
  const runs = [
    ['v', rect.x0, box.z0, rect.z0 - 1], ['v', rect.x0, rect.z1 + 1, box.z1],
    ['v', rect.x1 + 1, box.z0, rect.z0 - 1], ['v', rect.x1 + 1, rect.z1 + 1, box.z1],
    ['h', rect.z0, box.x0, rect.x0 - 1], ['h', rect.z0, rect.x1 + 1, box.x1],
    ['h', rect.z1 + 1, box.x0, rect.x0 - 1], ['h', rect.z1 + 1, rect.x1 + 1, box.x1],
    ['v', mx, box.z0, rect.z0 - 1], ['v', mx, rect.z1 + 1, box.z1],
    ['h', mz, box.x0, rect.x0 - 1], ['h', mz, rect.x1 + 1, box.x1],
  ]
  let placed = 0
  for (const [i, [axis, line, a, b]] of runs.entries()) {
    if (b < a) continue
    // A panel on the box's own outer line is no panel.
    if ((axis === 'v' && (line <= box.x0 || line > box.x1)) || (axis === 'h' && (line <= box.z0 || line > box.z1))) continue
    const lane = a === box.z0 || a === box.x0 ? a : b
    const free = b > a ? b - a : 1
    const lo = b > a && lane === a ? a + 1 : a
    const sides = (t) => (axis === 'v' ? [line - 1, t, line, t] : [t, line - 1, t, line])
    const crossing = (t) => {
      const [ax, az, bx, bz] = sides(t)
      return walkableIn(map, box, cy, ax, az) && walkableIn(map, box, cy, bx, bz)
    }
    let gap = b > a ? lo + (roll(i) % free) : a
    for (let k = 0; k < free && !crossing(gap); k++) gap = lo + ((gap - lo + 1) % free)
    for (let t = a; t <= b; t++) {
      if (t === gap) continue
      const [ax, az, bx, bz] = sides(t)
      if (halos.has(`${cy},${ax},${az}`) || halos.has(`${cy},${bx},${bz}`)) continue
      const edge = axis === 'v' ? map.wallVAt(line, cy, t) : map.wallHAt(t, cy, line)
      if (edge.wall) continue
      const set = (wall, passage, feature) => (axis === 'v'
        ? map.setWallV(line, cy, t, wall, passage, feature)
        : map.setWallH(t, cy, line, wall, passage, feature))
      set(1, PASSAGE_WALL)
      if (joined(map, box, cy, ax, az, bx, bz)) placed++
      else set(edge.wall, edge.passage, edge.feature)
    }
  }
  return placed
}

// Turn every rail between a void cell of `rect` and plain deck on storey cy
// into a padded wall (still a guard for the catalog audit, but opaque),
// except on side `nets` ('N' | 'E' | 'S' | 'W'), which keeps its rails.
function padWell(map, cy, rect, nets = null) {
  const deck = (gx, gz) => {
    const c = map.cellAt(gx, cy, gz)
    return !!c.chunk && c.kind !== CELL_VOID && c.kind !== CELL_BRIDGE
  }
  for (let gz = rect.z0; gz <= rect.z1; gz++) {
    for (let gx = rect.x0; gx <= rect.x1; gx++) {
      if (map.cellAt(gx, cy, gz).kind !== CELL_VOID) continue
      const pad = (side, nx, nz) => side !== nets && deck(nx, nz)
      if (pad('W', gx - 1, gz) && map.wallVAt(gx, cy, gz).feature === WALL_RAIL) map.setWallV(gx, cy, gz, 1, PASSAGE_WALL)
      if (pad('E', gx + 1, gz) && map.wallVAt(gx + 1, cy, gz).feature === WALL_RAIL) map.setWallV(gx + 1, cy, gz, 1, PASSAGE_WALL)
      if (pad('N', gx, gz - 1) && map.wallHAt(gx, cy, gz).feature === WALL_RAIL) map.setWallH(gx, cy, gz, 1, PASSAGE_WALL)
      if (pad('S', gx, gz + 1) && map.wallHAt(gx, cy, gz + 1).feature === WALL_RAIL) map.setWallH(gx, cy, gz + 1, 1, PASSAGE_WALL)
    }
  }
}

function walkableIn(map, box, cy, x, z) {
  if (!inRect(box, x, z)) return false
  const c = map.cellAt(x, cy, z)
  return !!c.chunk && !c.col && !c.chunk.hasFloorHole(map.cellLocal(x), map.cellLocal(z))
}

function joined(map, box, cy, ax, az, bx, bz) {
  const walk = (x, z) => walkableIn(map, box, cy, x, z)
  if (!walk(ax, az) || !walk(bx, bz)) return true
  const seen = new Set([`${ax},${az}`])
  const queue = [[ax, az]]
  for (let q = 0; q < queue.length; q++) {
    const [x, z] = queue[q]
    if (x === bx && z === bz) return true
    const steps = [[x, z - 1, map.wallHAt(x, cy, z)], [x + 1, z, map.wallVAt(x + 1, cy, z)], [x, z + 1, map.wallHAt(x, cy, z + 1)], [x - 1, z, map.wallVAt(x, cy, z)]]
    for (const [nx, nz, e] of steps) {
      if (e.wall || seen.has(`${nx},${nz}`) || !walk(nx, nz)) continue
      seen.add(`${nx},${nz}`)
      queue.push([nx, nz])
    }
  }
  return false
}

// --- light ---------------------------------------------------------------------------------

// The lit tubes per chunk-storey the covers may reach (light.js): the
// halls' own, then everything else's (the world's lamp density, §11.1:
// at most 12 per chunk-storey and 72 within 60 u).
const HALL_COVER_CAP = 6
const PLAIN_CAP = 9
const REGION = Object.freeze({ x0: 0, z0: 0, W: N, D: N })

// The world's lamp cap per chunk-storey: LIT_CAP, raised towards
// HALL_LIT_CAP by the share of the chunk the hall boxes cover (full at
// HALL_FULL cells; the halls are the map's brightest rooms, doc §8); the fill-light pass (generator.js) tops the rest
// up to its own cap. The harness gates 12 per chunk-storey and 72 within 60 u.
const HALL_LIT_CAP = 10
const LIT_CAP = 9
const HALL_FULL = 120
function capOf(map, halls, d) {
  const o = map.origin ?? { cx: 0, cy: 0, cz: 0 }
  const cx = d.cx - o.cx
  const cz = d.cz - o.cz
  const cy = d.cy - o.cy
  const chunk = R(cx * 14, cz * 14, cx * 14 + 13, cz * 14 + 13)
  let area = 0
  for (const h of halls) {
    if (h.L <= cy) continue
    const w = Math.min(h.box.x1, chunk.x1) - Math.max(h.box.x0, chunk.x0) + 1
    const d = Math.min(h.box.z1, chunk.z1) - Math.max(h.box.z0, chunk.z0) + 1
    if (w > 0 && d > 0) area += w * d
  }
  return LIT_CAP + Math.round((HALL_LIT_CAP - LIT_CAP) * Math.min(1, area / HALL_FULL))
}

// The world bake's fill pass (generator.js) tops up only the chunk-storeys
// the tile left under WORLD_FILL_CAP lit tubes, outside the hall boxes and
// off the crawl tubes (lit only at their pods).
export const WORLD_FILL_CAP = 7

// generator.js's fill for the finite kind: the same pass over the sample.
function kindFill(map, halls, lay) {
  const chunks = new Map()
  const start = new Map()
  for (const d of map.chunks.values()) {
    chunks.set(chunkKey3(d.cx, d.cy, d.cz), d)
    start.set(d, d.lamps.filter((l) => l.lit).length)
  }
  const inHall = (gx, gz, cy) => halls.some((h) => cy < h.L && inRect(h.box, gx, gz))
  const tube = (gx, gz, cy) => lay.storeys[cy]?.cells[gz * N + gx] === TUBE
  return fillDarkCells(chunks, {
    ...FILL_DEFAULTS,
    cap: WORLD_FILL_CAP,
    spawn: [],
    where: (d, lx, lz, gx, gz, cy) => start.get(d) < WORLD_FILL_CAP && !inHall(gx, gz, cy) && !tube(gx, gz, cy),
  })
}

// At most capOf(chunk) lit lamps per chunk-storey: repeatedly drop the lit
// tube with the nearest other lit tube (Chebyshev, ties in the chunk's lamp
// order), so the survivors stay spread; a tube `late` marks (the halls'
// own) goes only after the rest, and a tube with a near neighbour in its own
// room before a room's only tube. Lamps in `keep` are never dropped.
function capLitLamps(map, capFor, keep = new Set(), late = () => false) {
  for (const d of map.chunks.values()) {
    const cap = capFor(d)
    const lit = d.lamps.filter((l) => l.lit)
    if (lit.length <= cap) continue
    const drop = new Set()
    const lateOf = new Set(lit.filter((l) => late(d, l)))
    const space = (l) => d.spaceId[l.lz * CHUNK + l.lx]
    const cheb = (a, b) => Math.max(Math.abs(a.lx - b.lx), Math.abs(a.lz - b.lz))
    while (lit.length - drop.size > cap) {
      // The drop order: outside the halls first; there, a tube sharing its
      // room with a near tube (the room stays lit); then the most crowded.
      let best = null
      let bestKey = null
      for (const l of lit) {
        if (drop.has(l) || keep.has(l)) continue
        let same = Infinity
        let near = Infinity
        for (const m of lit) {
          if (m === l || drop.has(m)) continue
          const c = cheb(l, m)
          near = Math.min(near, c)
          if (space(m) === space(l) && space(l) !== 0) same = Math.min(same, c)
        }
        const key = [lateOf.has(l) ? 1 : 0, same, near]
        if (!bestKey || key[0] < bestKey[0] || (key[0] === bestKey[0] && (key[1] < bestKey[1] || (key[1] === bestKey[1] && key[2] < bestKey[2])))) {
          bestKey = key
          best = l
        }
      }
      if (!best) break
      drop.add(best)
    }
    d.lamps = d.lamps.filter((l) => !drop.has(l))
  }
}

// --- placement ---------------------------------------------------------------------------

// Re-join storey cy's walk where furniture split it: the open cells (no
// column, no hole, no flight run) fall into parts with every piece a wall;
// from the largest part a 0-1 search (a piece costs 1) reaches each other
// part through the fewest pieces, and those pieces are lifted. Parts the
// pieces never touched (joined only by a flight or a seam) cost nothing.
function unplugFurniture(map, cy) {
  const N = TILE_CELLS
  const state = new Int8Array(N * N) // 0 blocked, 1 open, 2 furniture
  for (let gz = 0; gz < N; gz++) {
    for (let gx = 0; gx < N; gx++) {
      const c = map.cellAt(gx, cy, gz)
      if (!c.chunk || c.kind === CELL_VOID || c.kind === CELL_STAIR) continue
      if (c.chunk.hasFloorHole(map.cellLocal(gx), map.cellLocal(gz))) continue
      state[gz * N + gx] = c.col === COLUMN_FURNITURE ? 2 : c.col ? 0 : 1
    }
  }
  const pass = (i, j) => {
    const ax = i % N
    const az = (i / N) | 0
    const bx = j % N
    const bz = (j / N) | 0
    return bx !== ax ? !map.wallVAt(Math.max(ax, bx), cy, az).wall : !map.wallHAt(ax, cy, Math.max(az, bz)).wall
  }
  const nbrs = (i) => {
    const x = i % N
    const out = []
    if (x > 0) out.push(i - 1)
    if (x < N - 1) out.push(i + 1)
    if (i >= N) out.push(i - N)
    if (i < N * N - N) out.push(i + N)
    return out
  }
  // Parts of the open cells.
  const part = new Int32Array(N * N).fill(-1)
  const sizes = []
  for (let s = 0; s < N * N; s++) {
    if (state[s] !== 1 || part[s] >= 0) continue
    const id = sizes.length
    const q = [s]
    part[s] = id
    for (let k = 0; k < q.length; k++) {
      for (const j of nbrs(q[k])) {
        if (state[j] === 1 && part[j] < 0 && pass(q[k], j)) {
          part[j] = id
          q.push(j)
        }
      }
    }
    sizes.push(q.length)
  }
  if (sizes.length < 2) return 0
  const joined = new Uint8Array(sizes.length)
  const root = sizes.indexOf(Math.max(...sizes))
  joined[root] = 1
  let lifted = 0
  for (;;) {
    // 0-1 search from every joined part; stop at the first unjoined open cell.
    const dist = new Int32Array(N * N).fill(1 << 30)
    const prev = new Int32Array(N * N).fill(-1)
    const dq = []
    let head = 0
    for (let i = 0; i < N * N; i++) {
      if (state[i] === 1 && joined[part[i]]) {
        dist[i] = 0
        dq.push(i)
      }
    }
    // A two-ended queue as two arrays: zero-cost steps go to the front list.
    const front = []
    let hit = -1
    while (front.length || head < dq.length) {
      const i = front.length ? front.pop() : dq[head++]
      if (state[i] === 1 && !joined[part[i]]) {
        hit = i
        break
      }
      for (const j of nbrs(i)) {
        if (!state[j] || !pass(i, j)) continue
        const w = state[j] === 2 ? 1 : 0
        if (dist[i] + w >= dist[j]) continue
        dist[j] = dist[i] + w
        prev[j] = i
        if (w) dq.push(j)
        else front.push(j)
      }
    }
    if (hit < 0) break
    for (let i = hit; i >= 0 && dist[i] > 0; i = prev[i]) {
      if (state[i] === 2) {
        map.removeFurniture(i % N, cy, (i / N) | 0)
        state[i] = 1
        part[i] = root
        lifted++
      }
    }
    joined[part[hit]] = 1
  }
  return lifted
}

// Place a piece only where it cannot cut the floor: a plain walkable cell,
// outside every halo (flights, doors, spawn, exit), whose open neighbours
// stay joined around it within the 3×3 block (a local test, so it is
// conservative). Net bridges and flights count as walkable neighbours (a
// piece at a bridge's mouth would plug it), though a piece never stands on one.
function placeSafe(map, halos, cy, gx, gz, kind, { wall = null, facing = FACING.S } = {}) {
  if (halos.has(`${cy},${gx},${gz}`)) return false
  const walk = (x, z) => {
    const c = map.cellAt(x, cy, z)
    if (!c.chunk || c.col || c.kind === CELL_VOID) return false
    return !c.chunk.hasFloorHole(map.cellLocal(x), map.cellLocal(z))
  }
  const open = (ax, az, bx, bz) => (bx !== ax
    ? !map.wallVAt(Math.max(ax, bx), cy, az).wall
    : !map.wallHAt(ax, cy, Math.max(az, bz)).wall)
  const here = map.cellAt(gx, cy, gz)
  if (here.kind === CELL_STAIR || here.kind === CELL_BRIDGE || !walk(gx, gz)) return false
  for (const [x, z] of [[gx, gz - 1], [gx + 1, gz], [gx, gz + 1], [gx - 1, gz]]) {
    const c = map.cellAt(x, cy, z)
    if (c.kind === CELL_BRIDGE && open(gx, gz, x, z)) return false
  }
  const nbrs = [[gx, gz - 1], [gx + 1, gz], [gx, gz + 1], [gx - 1, gz]].filter(([x, z]) => walk(x, z) && open(gx, gz, x, z))
  if (nbrs.length > 1) {
    const key = (x, z) => `${x},${z}`
    const seen = new Set([key(...nbrs[0])])
    const queue = [nbrs[0]]
    for (let q = 0; q < queue.length; q++) {
      const [x, z] = queue[q]
      for (const [nx, nz] of [[x, z - 1], [x + 1, z], [x, z + 1], [x - 1, z]]) {
        if (Math.abs(nx - gx) > 1 || Math.abs(nz - gz) > 1 || (nx === gx && nz === gz)) continue
        if (seen.has(key(nx, nz)) || !walk(nx, nz) || !open(x, z, nx, nz)) continue
        seen.add(key(nx, nz))
        queue.push([nx, nz])
      }
    }
    if (!nbrs.every(([x, z]) => seen.has(key(x, z)))) return false
  }
  addPiece(map, cy, { gx, gz, kind, front: wall ? WALL_TO_FRONT[wall] : facing, wall })
  return true
}

// Exported for the tests: the module-local codes.
export { MASS }
