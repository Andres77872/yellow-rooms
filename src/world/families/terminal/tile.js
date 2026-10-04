import { CHUNK, cIdx, hIdx, vIdx } from '../../constants.js'
import { hashChain } from '../../tiles/tileKey.js'
import { RNG } from '../../core/rng.js'
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
  SPACE_ROLE_BREAK,
  SPACE_ROLE_KITCHEN,
  SPACE_ROLE_LOUNGE,
  SPACE_ROLE_OFFICE,
  SPACE_ROLE_SERVER,
  SPACE_ROLE_STORAGE,
  STAIR_E,
  STAIR_S,
  WALL_PLAIN,
  WALL_RAIL,
  WALL_TO_FRONT,
  addPiece,
  featureEdge,
  labelFloor,
} from '../../tiles/floorPlan.js'
import { FURN_ARMCHAIR, FURN_CABINET, FURN_CHAIR, FURN_COUNTER, FURN_DESK, FURN_PLANT, FURN_RACK, FURN_SINK, FURN_SOFA, FURN_TABLE, FURN_TOILET } from '../../rooms/catalog.js'
import { PROP_BEAM_SEAT, PROP_FIDS, PROP_GATE_PODIUM } from '../../props/index.js'
import { stairwellPlan } from '../../structures/authored.js'
import { linkHalo } from '../../structures/catalog/engine.js'
import { markExit, markSpawn } from '../../tiles/kit.js'
import { openOwnedSeam } from '../../tiles/seams.js'
import { BAG, DEP, LAST_X, LAST_Z, MEZ, R, SALT, TILE_CELLS_X, TILE_CELLS_Z, layoutOf, pierPartsOf } from './geometry.js'
import { FINITE_CTX_TERMINAL, GATE_TINT, LOUNGE_TINT, buildTerminalKind } from './kind.js'

// 08 — The Terminal (docs/liminal_maps/08-terminal.md): THE tile program of
// the terminal family (spec §3.3, §12.7). In finite mode (the editor kind)
// it is the kind's own map (kind.js, byte-identical). In tile mode it draws
// one 4×4-chunk section of an endless concourse at ctx.origin (kind storeys
// 0..2 = world −1..1), COMPOSED, never copied: geometry.layoutOf decides the
// skeleton (the spine's rows, one to three piers with their sides, x,
// widths, lengths and stair cores, the atrium's span and bridges, the
// checkpoint's x, the baggage tunnel's jog and hall, the mezzanine's depth),
// and this program grows the rest from the terminal's parts catalogue (the
// modules below) with seeded dice:
//   departures  the spine (seam to seam; FIDS banks at the pier mouths, seat
//               runs against the curtain glass, a twin travelator (open
//               belt lanes between balustrades) in runs of 16..26, high-bay
//               circuits); each pier: restrooms at its root,
//               holdroom runs (5..9 long, per band) with wide fronts, a gate
//               door and a glass or steel jet bridge whose length is what the
//               apron leaves, seats facing the glass or the aisle, the
//               apron's floodlight through the glass in bars, the tip
//               lounge with up to three gates (a pier that runs on through
//               the tile-row seam goes on in the apron rows' tiles,
//               buildPierTile, to its tip far out); 3..5 blind side concourses off
//               the spine; along the spine, the check-in hall and the side
//               concourses, the frontage modules (duty-free, cafés,
//               restrooms, food courts with kiosks, remote gate lounges with
//               their own jet bridges, club lounges, duty-free halls) and
//               apron gaps; the rest is the apron (mass), and every wall onto
//               it from the circulation or a lounge is curtain glass; the
//               serpentine (tile 0 after the check-in hall, checkpoint bays);
//   baggage     the service tunnel (seam to seam, with its jog), the reclaim
//               hall beside it (14+ deep, 2..4 carousels across it, FIDS at
//               their heads) and often a second reclaim or greeting hall on
//               the tunnel's other run, the arrivals frontage round them
//               (baggage services, lost luggage, car hire, café,
//               restrooms), the arrivals door (the
//               world's exit), the tug-road lattice across the tunnel (the
//               only loops the doc allows), corridors from each pier's stair,
//               blind belt tunnels and tug spurs, and the service modules
//               along all of them (make-up halls with belt blocks, sorting
//               halls, plant, cages, lost luggage, staff rooms, the
//               inter-terminal train platform in one tile in two);
//   mezzanine   only over departures' concourse and halls (never over the
//               apron or a jet bridge): the walkway (seam to seam) with the
//               railed atrium voids (one or two stamps) in it, the corridor
//               to its stair, wings out along the piers to a head lounge
//               over each tip, glazed sky bridges between heads across the
//               apron, upper decks over the jet bridges, and along it the
//               airline lounges, food balconies, observation decks, quiet
//               rooms, cafés and restrooms (big halls zoned by glass
//               screens), the leftovers joined to their neighbours.
// Liminal sameness is in the ELEMENTS (identical holdrooms, gate plates,
// seat rows, FIDS stands, lounges), never in the arrangement.

export { FINITE_CTX_TERMINAL, GATE_TINT, LOUNGE_TINT }
export const BOARD_TINT = 0xff8f7a // anomaly 'board': the gate glow gone error-red
// The apron's pole floodlights thrown in through the curtain glass (doc §8,
// §9: long bars of light across the holdrooms, the Stalker's stripes): cold,
// and burning over a dead pier too (they are not its circuits).
export const FLOOD_TINT = 0xbfd0e8
const FLOOD_EVERY = 6

// Plate labels: a gate number per pier. The seed picks how the numbers lie
// (doc §10.4: gate numbers skip, repeat or count down).
const GATE_SCHEMES = Object.freeze([
  Object.freeze(['C12', 'C14', 'C12']), // repeat (every tile)
  Object.freeze(['C40', 'C38', 'C36']), // countdown
  Object.freeze(['C2', 'C9', 'C23']), // skip
])
const BOARD_ERROR = 'Err'

const TURN_ROUND = Object.freeze({ [FACING.S]: FACING.N, [FACING.N]: FACING.S, [FACING.E]: FACING.W, [FACING.W]: FACING.E })

// The world's lamp cap (spec §11.1 item 9: ≤ 12 lit per chunk-storey, ≤ 72
// within 60 u): the tile keeps 10 per chunk-storey.
const LIT_CAP = 10

// Occupancy codes of the placement grids (one per storey, tile-local cells).
const FREE = 0 // nothing yet: compiles to mass
const CIRC = 1 // circulation (spine, corridors, halls, galleries)
const ROOM = 2 // a room
const RESV = 3 // a stair core (the stamp carves it)
const BUF = 4 // apron that must stay mass (round a jet bridge)
const BLOCK = 5 // out of bounds for this storey

class Grid {
  constructor() {
    this.a = new Uint8Array(TILE_CELLS_X * TILE_CELLS_Z)
  }
  in(x, z) {
    return x >= 0 && z >= 0 && x < TILE_CELLS_X && z < TILE_CELLS_Z
  }
  get(x, z) {
    return this.in(x, z) ? this.a[z * TILE_CELLS_X + x] : BLOCK
  }
  set(x, z, v) {
    if (this.in(x, z)) this.a[z * TILE_CELLS_X + x] = v
  }
  rect(r, v) {
    for (let z = r.z0; z <= r.z1; z++) for (let x = r.x0; x <= r.x1; x++) this.set(x, z, v)
  }
  all(r, ok) {
    for (let z = r.z0; z <= r.z1; z++) for (let x = r.x0; x <= r.x1; x++) if (!ok(this.get(x, z))) return false
    return true
  }
}

const hLineBetween = (zA, zB) => Math.max(zA, zB)

// --- entry -------------------------------------------------------------------------

export function buildTerminalTile(map, seed, ctx = FINITE_CTX_TERMINAL) {
  if (ctx.mode !== 'tile') return buildTerminalKind(map, seed, ctx)
  return buildGrammarTile(map, ctx)
}

function buildGrammarTile(map, ctx) {
  if (ctx.key.tz !== 0) return buildPierTile(map, ctx)
  const L = layoutOf(ctx.worldSeed, ctx.key.tx)
  const T = tileState(map, ctx, L)
  departures(T)
  baggage(T)
  mezzanine(T)
  T.dep.compile(map, DEP)
  T.bag.compile(map, BAG)
  T.mez.compile(map, MEZ)
  // §6.8 rule 3: open the owned West lines at the declared ports, and the
  // North line where the north piers run on into the apron row.
  for (const cy of [BAG, DEP, MEZ]) openOwnedSeam(map, ctx, cy, 'west')
  openOwnedSeam(map, ctx, DEP, 'north')
  return finishGrammarTile(map, ctx, T)
}

// The bake's working state: the three storeys' plans and placement grids,
// the pieces and glass candidates, and the shared helpers.
function tileState(map, ctx, L) {
  const dice = (tag) => new RNG(hashChain((L.vs ^ SALT) | 0, tag))
  const T = {
    map,
    ctx,
    L,
    dice,
    dep: new FloorPlan(R(0, 0, LAST_X, LAST_Z)),
    bag: new FloorPlan(R(0, 0, LAST_X, LAST_Z)),
    mez: new FloorPlan(R(0, 0, LAST_X, LAST_Z)),
    gDep: new Grid(),
    gBag: new Grid(),
    gMez: new Grid(),
    pieces: [], // [cy, piece]: placed after every stamp
    windows: [], // DEP glass candidates {axis, line, along}: kept where the sight line is safe
    spaceId: 1,
    gates: 0,
    deadPiers: new Set(L.piers.filter((p) => p.i === L.deadPier || (L.anomaly === 'dead' && p.i === L.anomalyPier)).map((p) => p.i)),
    boardPier: L.anomaly === 'board' ? L.anomalyPier : -1,
    noSeat: new Set(), // DEP spine cells kept clear (doors, mouths, the serpentine)
    sats: [], // the satellites (departures), which the mezzanine repeats above
    open: new Set(), // DEP cells of the open-plan halls (piers, open-fronted halls): no threshold between them
    belts: new Set(), // DEP travelator lane cells (open floor between balustrades): nothing stands on them
    tubes: new Set(), // DEP jet-bridge tubes and their closets (no mezzanine floor over them but the bridges' upper decks)
    bridges: [], // DEP jet bridges {gx, gz, dx, dz, len, glass}: the mezzanine's upper decks follow them
    tips: new Map(), // pier index → its tip lounge rect (DEP)
    mezHalls: [], // the mezzanine's lounges and food courts (rects), which sky bridges may leave from
  }
  T.put = (cy, gx, gz, kind, { wall = null, facing = FACING.S } = {}) => {
    T.pieces.push([cy, { gx, gz, kind, front: wall ? WALL_TO_FRONT[wall] : facing, wall }])
  }
  T.fids = (gx, gz, { wall = null, facing = FACING.S }, pier) => {
    const front = wall ? WALL_TO_FRONT[wall] : facing
    T.pieces.push([DEP, { gx, gz, kind: PROP_FIDS, front: pier === T.boardPier ? TURN_ROUND[front] : front, wall }])
  }
  T.tint = (pier) => (pier === T.boardPier ? BOARD_TINT : GATE_TINT)
  T.plateOf = (p) => (p.i === T.boardPier ? BOARD_ERROR : GATE_SCHEMES[L.scheme][p.i])
  return T
}

// An apron row's tile (tz ±1): the far parts of the piers of the terminal
// tile beside it that run on through the seam, on departures only (the
// chunks round them are the tile's footprint; baggage and the mezzanine are
// solid there). Each part continues its pier: the travelator down the
// concourse, holdroom runs along the curtain glass with their gates and jet
// bridges, and the tip lounge at its dead end, far out on the apron (doc
// §4.1: piers are long and end in a dead end).
function buildPierTile(map, ctx) {
  const L = layoutOf(ctx.worldSeed, ctx.key.tx)
  const parts = pierPartsOf(ctx.worldSeed, ctx.key.tx, ctx.key.tz)
  if (!parts.length) return { spawn: null, exit: null, notes: ctx.notes }
  const T = tileState(map, ctx, L)
  // The plan covers only the chunks the parts keep (compile writes every
  // chunk its region touches).
  const kc = parts.flatMap((p) => p.chunks)
  const cw = TILE_CELLS_X / CHUNK
  T.dep = new FloorPlan(R(Math.min(...kc.map((c) => c % cw)) * CHUNK, Math.min(...kc.map((c) => Math.floor(c / cw))) * CHUNK, Math.max(...kc.map((c) => c % cw)) * CHUNK + CHUNK - 1, Math.max(...kc.map((c) => Math.floor(c / cw))) * CHUNK + CHUNK - 1))
  const { dep, gDep } = T
  // Only the parts' envelopes are this tile's floor: the rest is out of
  // bounds (its chunks are solid), and the parts' bodies are claimed before
  // any jet bridge looks for room.
  gDep.rect(R(0, 0, LAST_X, LAST_Z), BLOCK)
  for (const p of parts) gDep.rect(R(Math.max(1, p.env.x0), Math.max(1, p.env.z0), Math.min(LAST_X - 1, p.env.x1), Math.min(LAST_Z - 1, p.env.z1)), FREE)
  // §6.8 rule 1: a kept chunk's east column and south row facing a chunk
  // the tile does not keep stay mass.
  const keptChunk = new Set(parts.flatMap((p) => p.chunks))
  const keeps = (x, z) => x >= 0 && z >= 0 && x <= LAST_X && z <= LAST_Z && keptChunk.has(Math.floor(z / CHUNK) * (TILE_CELLS_X / CHUNK) + Math.floor(x / CHUNK))
  for (let z = 0; z <= LAST_Z; z++) for (let x = 0; x <= LAST_X; x++) if (gDep.get(x, z) === FREE && (!keeps(x + 1, z) || !keeps(x, z + 1))) gDep.set(x, z, BLOCK)
  for (const p of parts) gDep.rect(p.rect, ROOM)
  for (const p of parts) pierHall(T, p)
  for (const p of parts) apron(T, p)
  const solid = solidChunksOf(gDep)
  for (const w of T.windows) if (glassOk(gDep, solid, w)) dep.window(w.axis, ...(w.axis === 'v' ? [w.line, w.along] : [w.along, w.line]))
  T.windows = []
  dep.compile(map, DEP)
  openOwnedSeam(map, ctx, DEP, 'north')
  // The gate number on every chunk of the pier.
  for (const p of parts) {
    for (let cz = Math.floor(p.rect.z0 / CHUNK); cz <= Math.floor(p.rect.z1 / CHUNK); cz++) {
      for (let cx = Math.floor(p.x0 / CHUNK); cx <= Math.floor((p.x0 + p.w - 1) / CHUNK); cx++) labelFloor(map, DEP, T.plateOf(p), { cx, cz })
    }
  }
  const seam = ctx.key.tz < 0 ? LAST_Z : 0
  const kept = T.pieces.filter(([cy, piece]) => cy === DEP && keepPiece(map, T, cy, piece, null, null))
  const dropped = unseal(map, kept, { [DEP]: { row: seam, all: true } })
  for (const [i, [cy, piece]] of kept.entries()) if (!dropped.has(i)) addPiece(map, cy, piece)
  for (const d of map.chunks.values()) d.lamps = d.lamps.filter((l) => d.cols[cIdx(l.lx, l.lz)] !== COLUMN_STANDARD)
  capLitLamps(map, L.vs, LIT_CAP)
  ctx.notes.push(`apron row ${ctx.key.tz}: ${parts.map((p) => `pier ${p.i} ${p.side}${p.x0} +${p.len} (tip ${p.tip})${T.deadPiers.has(p.i) ? ' dead' : ''}`).join(', ')}; ${T.gates} jet bridges`)
  return { spawn: null, exit: null, notes: ctx.notes }
}

function finishGrammarTile(map, ctx, T) {
  const { L } = T
  // --- stamps: the atrium, then the stairs ------------------------------------------
  const halo = new Set() // the atrium flight's halo cells (both storeys), kind-local 'gx,gz'
  for (const spec of L.atria) {
    const atrium = ctx.kit.atrium(map, spec)
    if (atrium?.error) return { error: `terminal atrium: ${atrium.error}` }
    if (atrium) {
      for (const link of atrium.descriptor.verticalLinks) {
        const h = linkHalo(link)
        for (let gz = h.z0; gz <= h.z1; gz++) for (let gx = h.x0; gx <= h.x1; gx++) halo.add(`${gx},${gz}`)
      }
      // The catalog stamp carves its ring box open, and its box IS the spine's
      // rows (and the mezzanine gallery), so only the box's perimeter edges
      // need the plans back (shop fronts, pier mouths, unit doors, mass).
      restoreBoxEdges(map, T.dep, DEP, spec.box)
      restoreBoxEdges(map, T.mez, MEZ, spec.box)
      restoreBoxRails(map, T.dep, DEP, spec.box, halo)
    }
  }
  for (const p of L.piers) {
    const sp = stairwellPlan({ gx: p.core.gx, gz: p.core.gz, dir: STAIR_S, doorSide: p.core.doorSide, baseCy: BAG, topCy: DEP })
    if (sp.error) return { error: `terminal pier stair: ${sp.error}` }
    ctx.kit.stairwell(map, sp, { enclosed: true })
    // The plate wall at the stair top: a plain face the dressing names.
    featureEdge(map, 'v', p.core.plate.line, DEP, p.core.plate.gz, WALL_PLAIN)
  }
  const mc = L.mezCore
  const ms = stairwellPlan({ gx: mc.gx, gz: mc.gz, dir: STAIR_E, doorSide: mc.doorSide, baseCy: DEP, topCy: MEZ })
  if (ms.error) return { error: `terminal mezzanine stair: ${ms.error}` }
  ctx.kit.stairwell(map, ms, { enclosed: true })
  featureEdge(map, 'h', mc.plate.gx, MEZ, mc.plate.line, WALL_PLAIN)

  // --- touch-ups: plates, the exit, the spawn -----------------------------------------
  labelFloor(map, BAG, 'Arr')
  labelFloor(map, DEP, 'dEP')
  labelFloor(map, MEZ, 'CLUb')
  const plateOf = T.plateOf
  // Gate numbers on the pier's outer chunk row, its stair chunk last.
  for (const p of L.piers) {
    const cz = p.core.cz
    for (let cx = Math.floor(p.x0 / CHUNK); cx <= Math.floor((p.x0 + p.w - 1) / CHUNK); cx++) {
      if (L.piers.some((o) => o !== p && o.core.cx === cx && o.core.cz === cz)) continue
      labelFloor(map, DEP, plateOf(p), { cx, cz })
    }
  }
  for (const p of L.piers) labelFloor(map, DEP, plateOf(p), { cx: p.core.cx, cz: p.core.cz })
  const a = L.bag.arrivals
  const exit = { gx: a.gx, gz: a.gz, cy: BAG }
  markExit(map, ctx, exit)
  const spawn = L.landside ? { ...L.spawnCells[0], cy: DEP } : null
  if (spawn) markSpawn(map, ctx, spawn)

  // --- furniture last ----------------------------------------------------------------
  const kept = T.pieces.filter(([cy, piece]) => !((cy === DEP || cy === MEZ) && halo.has(`${piece.gx},${piece.gz}`)) && keepPiece(map, T, cy, piece, exit, spawn))
  const dropped = unseal(map, kept, {
    [BAG]: { row: L.bag.pw },
    [DEP]: { row: (L.spine.z0 + L.spine.z1) >> 1 },
    [MEZ]: { row: L.ports.mez.a0 },
  })
  for (const [i, [cy, piece]] of kept.entries()) if (!dropped.has(i)) addPiece(map, cy, piece)
  // Lamps under the atrium's and the stairs' openings would hang in mid-air;
  // nor over mass.
  for (const d of map.chunks.values()) d.lamps = d.lamps.filter((l) => !d.hasCeilHole(l.lx, l.lz) && d.cols[cIdx(l.lx, l.lz)] !== COLUMN_STANDARD)
  capLitLamps(map, L.vs, LIT_CAP)

  const pierNote = L.piers.map((p) => `${p.side}${p.x0}×${p.len}${p.loaded === 'both' ? '' : '/' + p.loaded}${T.deadPiers.has(p.i) ? ' dead' : ''}`).join(', ')
  ctx.notes.push(
    `departures: spine z ${L.spine.z0}..${L.spine.z1}${L.landside ? ', landside check-in + serpentine' : L.checkpoint ? `, checkpoint serpentine at x ${L.serpentine.x0}` : ''}; piers ${pierNote}; ${T.gates} jet bridges`,
    `atria: ${L.atria.length ? L.atria.map((a) => `x ${a.box.x0}..${a.box.x1}, ${a.style}`).join('; ') : 'none'}; mezzanine stair ${mc.side} x ${mc.rect.x0}`,
    `baggage: hall x ${L.bag.hall.x0}..${L.bag.hall.x1} z ${L.bag.hall.z0}..${L.bag.hall.z1}, tunnel jog x ${L.bag.jog}; the exit is the arrivals door`,
  )
  ctx.notes.push(`furniture: ${kept.length - dropped.size} pieces (${dropped.size} left out so no cell is sealed off)`)
  if (L.anomaly) ctx.notes.push(`anomaly: ${L.anomaly} (pier ${L.anomalyPier})`)
  return { spawn, exit, notes: ctx.notes }
}

// Furniture: nothing on a void or deck, a stair, a travelator belt, the
// tile-row seam, the exit or the spawn, nor on a threshold (a cell with an opening, an unwalled edge,
// to a cell of another space or kind: a door's either side, a street's
// mouth), so no piece shuts a way through.
function keepPiece(map, T, cy, { gx, gz }, exit, spawn) {
  if (exit && cy === exit.cy && gx === exit.gx && gz === exit.gz) return false
  if (spawn && cy === DEP && Math.abs(gx - spawn.gx) <= 1 && Math.abs(gz - spawn.gz) <= 1) return false
  if (cy === DEP && T.belts.has(`${gx},${gz}`)) return false
  // A pier's row on the tile-row seam is a port: walkable both sides.
  if (cy === DEP && (gz === 0 || gz === LAST_Z)) return false
  const c = map.cellAt(gx, cy, gz)
  if (c.kind === CELL_VOID || c.kind === CELL_BRIDGE || c.kind === CELL_STAIR || c.col === COLUMN_STANDARD) return false
  for (const [dx, dz] of DIRS4) {
    const n = map.cellAt(gx + dx, cy, gz + dz)
    if (n.col === COLUMN_STANDARD || (n.spaceId === c.spaceId && n.kind === c.kind)) continue
    if (cy === DEP && T.open.has(`${gx},${gz}`) && T.open.has(`${gx + dx},${gz + dz}`)) continue
    const e = dx ? map.wallVAt(Math.max(gx, gx + dx), cy, gz) : map.wallHAt(gx, cy, Math.max(gz, gz + dz))
    if (!e.wall) return false
  }
  return true
}

// --- furniture never seals a cell off ---------------------------------------------
//
// Per storey, the walkable cells its circulation reaches with no pieces but
// not with them (a seat row closing an aisle, a board in a lane's mouth) get
// the pieces in their way taken out, the ones that open onto the reached
// side first, until no such pocket is left. Returns the indices dropped.
// `from` names, per storey, the row its circulation is reached from: the
// first open cell on it, or (`all`) every open cell on it (the apron rows'
// piers, each reached from its own seam).
function unseal(map, list, from) {
  const W = TILE_CELLS_X
  const H = TILE_CELLS_Z
  const N = W * H
  const dropped = new Set()
  for (const cy of [BAG, DEP, MEZ]) {
    if (!from[cy]) continue
    const pieceAt = new Map()
    const blocked = new Uint8Array(N)
    for (const [i, [pcy, p]] of list.entries()) {
      if (pcy !== cy) continue
      const k = p.gz * W + p.gx
      if (!pieceAt.has(k)) pieceAt.set(k, [])
      pieceAt.get(k).push(i)
      blocked[k] = 1
    }
    if (!pieceAt.size) continue
    // Walkable cells, and the open edges east (bit 1) and south (bit 2) of
    // each, read once.
    const walk = new Uint8Array(N)
    const open = new Uint8Array(N)
    const CW = W / CHUNK
    const CH = H / CHUNK
    const ch = []
    for (let cz = 0; cz < CH; cz++) for (let cx = 0; cx < CW; cx++) ch.push(map.chunkAt(cx, cy, cz))
    for (let z = 0; z < H; z++) {
      const cz = (z / CHUNK) | 0
      const lz = z - cz * CHUNK
      for (let x = 0; x < W; x++) {
        const cx = (x / CHUNK) | 0
        const lx = x - cx * CHUNK
        const d = ch[cz * CW + cx]
        const k = z * W + x
        if (!d) continue
        const i = lz * CHUNK + lx
        walk[k] = d.cols[i] === 0 && d.cellKind[i] !== CELL_VOID ? 1 : 0
        // The east line of the cell is the next chunk's line 0 at a seam.
        if (x + 1 < W) {
          const e = lx + 1 < CHUNK ? d : ch[cz * CW + cx + 1]
          if (e && !e.wallV[lz * CHUNK + ((lx + 1) % CHUNK)]) open[k] |= 1
        }
        if (z + 1 < H) {
          const sd = lz + 1 < CHUNK ? d : ch[(cz + 1) * CW + cx]
          if (sd && !sd.wallH[((lz + 1) % CHUNK) * CHUNK + lx]) open[k] |= 2
        }
      }
    }
    const step = (k, d) => {
      // d: 0 east, 1 west, 2 south, 3 north → the neighbour, or −1.
      const x = k % W
      if (d === 0) return x + 1 < W && open[k] & 1 ? k + 1 : -1
      if (d === 1) return x > 0 && open[k - 1] & 1 ? k - 1 : -1
      if (d === 2) return k + W < N && open[k] & 2 ? k + W : -1
      return k - W >= 0 && open[k - W] & 2 ? k - W : -1
    }
    const z0 = from[cy].row
    const seeds = []
    for (let x = 1; x < W - 1 && (from[cy].all || !seeds.length); x++) if (walk[z0 * W + x] && !blocked[z0 * W + x]) seeds.push(z0 * W + x)
    if (!seeds.length) continue
    // Flood from the queue's cells (already marked in `seen`), over walkable
    // cells, through pieces or not.
    const q = new Int32Array(N)
    const flood = (seen, n, block) => {
      for (let h = 0; h < n; h++) {
        const k = q[h]
        const x = k % W
        const o = open[k]
        for (let d = 0; d < 4; d++) {
          let m = -1
          if (d === 0) m = x + 1 < W && o & 1 ? k + 1 : -1
          else if (d === 1) m = x > 0 && open[k - 1] & 1 ? k - 1 : -1
          else if (d === 2) m = k + W < N && o & 2 ? k + W : -1
          else m = k - W >= 0 && open[k - W] & 2 ? k - W : -1
          if (m < 0 || seen[m] || !walk[m] || (block && blocked[m])) continue
          seen[m] = 1
          q[n++] = m
        }
      }
    }
    const A = new Uint8Array(N)
    const B = new Uint8Array(N)
    for (const [j, k] of seeds.entries()) {
      q[j] = k
      A[k] = 1
    }
    flood(A, seeds.length, false)
    for (const [j, k] of seeds.entries()) {
      q[j] = k
      B[k] = 1
    }
    flood(B, seeds.length, true)
    // Unblocking only adds cells, so B (reached with the pieces) grows from
    // the freed cells that touch it: no full re-flood per round.
    for (let iter = 0; iter < 16; iter++) {
      const cand = []
      for (let k = 0; k < N; k++) {
        if (!A[k] || B[k] || blocked[k]) continue
        for (let d = 0; d < 4; d++) {
          const m = step(k, d)
          if (m < 0 || !blocked[m]) continue
          let touches = false
          for (let e = 0; e < 4 && !touches; e++) {
            const o = step(m, e)
            touches = o >= 0 && B[o] === 1
          }
          cand.push([touches ? 0 : 1, m])
        }
      }
      if (!cand.length) break
      cand.sort((a, b) => a[0] - b[0] || a[1] - b[1])
      let n = 0
      for (const [t, m] of cand) {
        if (t !== cand[0][0]) break
        if (!blocked[m]) continue
        for (const i of pieceAt.get(m)) dropped.add(i)
        blocked[m] = 0
        let touches = false
        for (let e = 0; e < 4 && !touches; e++) {
          const o = step(m, e)
          touches = o >= 0 && B[o] === 1
        }
        if (touches && walk[m] && !B[m]) {
          B[m] = 1
          q[n++] = m
        }
      }
      flood(B, n, true)
    }
  }
  return dropped
}

// --- departures ------------------------------------------------------------------------
//
// Departures is a terminal's halls, not a warren: the spine (a 27–33 m
// concourse), the piers as single glazed halls (concourse, holdroom zones and
// tip lounge are one open floor; only seats, podiums, boards and the
// travelator divide it), and along the spine big open-fronted halls (gate
// lounges with rows of seats facing the glass, food courts, walk-through
// duty-free) between short runs of shop units and stretches of bare curtain
// glass onto the apron. Back-of-house is a thin band of restrooms and a club
// lounge. Everything left is the apron: mass behind glass.

function departures(T) {
  const { L, dep, gDep } = T
  const s = L.spine
  // Bounds: rows 0 and 55, columns 0 and 55 stay mass (the spine crosses at
  // its ports, a pier that runs on at its full width).
  for (let i = 0; i < TILE_CELLS_X; i++) {
    gDep.set(i, 0, BLOCK)
    gDep.set(i, LAST_Z, BLOCK)
    gDep.set(0, i, BLOCK)
    gDep.set(LAST_X, i, BLOCK)
  }
  // The spine: seam to seam (the east column only at the east port).
  dep.rect(R(0, s.z0, LAST_X - 1, s.z1), CELL_LOBBY)
  gDep.rect(R(0, s.z0, LAST_X - 1, s.z1), CIRC)
  for (let z = L.ports.depE.a0; z <= L.ports.depE.a1; z++) {
    dep.open(LAST_X, z, CELL_LOBBY)
    gDep.set(LAST_X, z, CIRC)
  }
  // Tile 0: the check-in hall at the west end, open to the west seam.
  if (L.hall) checkInHall(T)
  if (L.serpentine) serpentine(T, L.serpentine)
  // The stair cores are reserved before anything else claims the apron.
  for (const p of L.piers) gDep.rect(p.core.rect, RESV)
  gDep.rect(L.mezCore.rect, RESV)
  T.noSeat.add(`${L.mezCore.door.gx},${L.mezCore.side === 'N' ? s.z0 : s.z1}`)
  for (const p of L.piers) pierHall(T, p)
  for (const p of L.piers) apron(T, p)
  // The frontage: the catalogue's halls and units straight off the spine
  // (and the check-in hall); what they leave is the apron, glazed where it
  // meets the circulation.
  const rnd = T.dice(0xd15)
  satellites(T, T.dice(0x5a7))
  const mask = new Uint8Array(TILE_CELLS_X * TILE_CELLS_Z)
  for (let z = s.z0; z <= s.z1; z++) for (let x = 0; x < TILE_CELLS_X; x++) mask[z * TILE_CELLS_X + x] = 1
  // Units and halls line the satellites' walkways too (a connector with
  // holdrooms along it).
  for (const st of T.sats) for (let z = st.link.z0; z <= st.link.z1; z++) for (let x = st.link.x0; x <= st.link.x1; x++) mask[z * TILE_CELLS_X + x] = 1
  if (L.hall) for (let z = L.hall.z0; z <= L.hall.z1; z++) for (let x = L.hall.x0; x <= L.hall.x1; x++) mask[z * TILE_CELLS_X + x] = 1
  frontage(T, gDep, dep, DEP, rnd, DEP_FRONT, { glass: true, mask, exhaust: true })
  // The atrium's ring box: a chunk of it the frontage left unjoined gets a
  // one-cell alcove (the catalog stamp would carve an unwalled one).
  for (const a of L.atria) joinRing(gDep, dep, a.box, rnd)
  // Every wall of the spine and the hall that still faces the apron is
  // curtain glass (doc §4.3 step 5).
  for (let z = 1; z < LAST_Z; z++) {
    for (let x = 1; x < LAST_X; x++) {
      if (!mask[z * TILE_CELLS_X + x] || gDep.get(x, z) !== CIRC) continue
      for (const [dx, dz] of DIRS4) {
        const n = gDep.get(x + dx, z + dz)
        if (n !== FREE && n !== BUF) continue
        if (dx) T.windows.push({ axis: 'v', line: Math.max(x, x + dx), along: z, outer: true })
        else T.windows.push({ axis: 'h', line: Math.max(z, z + dz), along: x, outer: true })
      }
    }
  }
  spineDressing(T)
  // Glass where the sight line through it is safe (≥ 4 mass cells, or a
  // walkable cell, before anything that may be a whole-solid chunk).
  const solidChunk = solidChunksOf(gDep)
  for (const w of T.windows) if (glassOk(gDep, solidChunk, w)) dep.window(w.axis, ...(w.axis === 'v' ? [w.line, w.along] : [w.along, w.line]))
}

// Satellite gate lounges: up to two a tile, out on the apron in the far
// chunk row, each reached from the spine by its own glazed walkway (2 wide,
// straight across the apron, glass both sides). A satellite is a gate
// lounge: rows of seats facing its far glass, gates and jet bridges out of
// its far or side walls. Placed before the frontage, which lines up round
// the walkway's mouth.
function satellites(T, rnd) {
  const { L, dep, gDep } = T
  const s = L.spine
  const want = rnd.int(2, 4)
  const okCell = (x, z) => gDep.get(x, z) === FREE
  const okMargin = (x, z) => {
    const c = gDep.get(x, z)
    return c === FREE || c === BUF || c === BLOCK
  }
  let placed = 0
  for (let tries = 0; tries < 60 && placed < want; tries++) {
    const north = rnd.chance(0.5)
    const W = rnd.int(10, 22)
    const D = rnd.int(6, 10)
    const x0 = rnd.int(2, LAST_X - 1 - W)
    const far = north ? rnd.int(1, 5) : LAST_Z - rnd.int(1, 5)
    const r = north ? R(x0, far, x0 + W - 1, far + D - 1) : R(x0, far - D + 1, x0 + W - 1, far)
    const lx = rnd.int(x0 + 2, x0 + W - 4)
    const link = north ? R(lx, r.z1 + 1, lx + 1, s.z0 - 1) : R(lx, s.z1 + 1, lx + 1, r.z0 - 1)
    if (link.z1 - link.z0 + 1 < 3) continue
    let ok = true
    for (let z = r.z0 - 1; z <= r.z1 + 1 && ok; z++) {
      for (let x = r.x0 - 1; x <= r.x1 + 1 && ok; x++) {
        const inner = x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1
        if (inner ? !okCell(x, z) : !okMargin(x, z) && !(x >= lx && x <= lx + 1)) ok = false
      }
    }
    for (let z = link.z0; z <= link.z1 && ok; z++) {
      if (!okCell(lx, z) || !okCell(lx + 1, z) || !okMargin(lx - 1, z) || !okMargin(lx + 2, z)) ok = false
    }
    // The walkway's mouth on the spine: never a stair door, a pier mouth or
    // the serpentine.
    const mz = north ? s.z0 : s.z1
    for (let x = lx - 1; x <= lx + 2 && ok; x++) if (T.noSeat.has(`${x},${mz}`)) ok = false
    if (!ok) continue
    dep.rect(link, CELL_CORRIDOR)
    gDep.rect(link, CIRC)
    for (let z = link.z0; z <= link.z1; z++) {
      T.windows.push({ axis: 'v', line: lx, along: z, outer: true }, { axis: 'v', line: lx + 2, along: z, outer: true })
      if ((z - link.z0) % 4 === 1) dep.lamp(lx + (z & 1), z, rnd.int(0, 2) !== 0)
    }
    for (let x = lx - 1; x <= lx + 2; x++) T.noSeat.add(`${x},${mz}`)
    // The lounge: the walkway enters its near wall.
    const seg = north ? { axis: 'x', line: r.z1 + 1, side: -1 } : { axis: 'x', line: r.z0 - 1, side: 1 }
    const f = frameOf(seg, r.x0, W, D)
    const id = T.spaceId++
    dep.rect(r, CELL_ROOM, id, SPACE_ROLE_LOUNGE)
    gDep.rect(r, ROOM)
    const half = R(r.x0 + (W >> 1), r.z0, r.x1, r.z1)
    dep.rect(half, CELL_ROOM, T.spaceId++, SPACE_ROLE_LOUNGE)
    for (let z = r.z0; z <= r.z1; z++) for (let x = r.x0; x <= r.x1; x++) T.open.add(`${x},${z}`)
    const m = { plan: dep, g: gDep, rnd, gateEdges: [], sideGates: true }
    roomLamps(T, dep, DEP, f, rnd, GATE_TINT, 0.7)
    dressGateLounge(T, DEP, f, m)
    const isGate = (e) => m.gateEdges.some((q) => e.axis === q.axis && e.gx === q.gx && e.gz === q.gz)
    const push = (e) => {
      if (isGate(e)) return
      T.windows.push(e.axis === 'v' ? { axis: 'v', line: e.gx, along: e.gz, outer: true } : { axis: 'h', line: e.gz, along: e.gx, outer: true })
    }
    for (let u = 0; u < W; u++) {
      push(f.outEdge(u, D - 1))
      if (r.x0 + u < lx || r.x0 + u > lx + 1) {
        const [x, z] = f.at(u, 0)
        T.windows.push({ axis: 'h', line: north ? z + 1 : z, along: x, outer: true })
      }
    }
    for (let v = 0; v < D; v++) for (const sg of [-1, 1]) push(f.sideEdge(sg, v))
    T.sats.push({ r, lx, north, link })
    placed++
  }
}

// Tile 0's landside check-in hall: two long check-in islands (desks back to
// back) down its length with queue lanes railed off in front of them, the
// spawn in the aisle between them, boards on the west wall.
function checkInHall(T) {
  const { L, dep, gDep } = T
  const h = L.hall
  const rnd = T.dice(0x11a)
  dep.rect(h, CELL_LOBBY)
  gDep.rect(h, CIRC)
  const mid = L.spawnCells[0].gz
  const islands = [2, h.x1 - 3]
  for (const c of islands) {
    for (const [za, zb] of [[h.z0 + 2, mid - 3], [mid + 3, h.z1 - 2]]) {
      if (zb - za < 2) continue
      for (let z = za; z <= zb; z++) {
        T.put(DEP, c, z, FURN_COUNTER, { facing: FACING.W })
        T.put(DEP, c + 1, z, FURN_COUNTER, { facing: FACING.E })
      }
      // Queue lanes: rails one cell off each face, open at both ends.
      for (let z = za + 1; z <= zb - 1; z++) {
        if (c - 1 >= 1) dep.rail('v', c - 1, z)
        if (c + 3 <= h.x1) dep.rail('v', c + 3, z)
      }
      for (let z = za; z <= zb; z += 3) dep.lamp(c, z, rnd.int(0, 3) !== 0)
      // The departures boards at the island's inner end, facing the aisle
      // the spawn stands in.
      const inner = za > mid ? za - 1 : zb + 1
      for (const x of [c, c + 1]) T.put(DEP, x, inner, PROP_FIDS, { facing: za > mid ? FACING.N : FACING.S })
    }
  }
  for (let x = 1; x <= h.x1; x += 3) {
    T.put(DEP, x, h.z0, PROP_BEAM_SEAT, { wall: 'N' })
    T.put(DEP, x, h.z1, PROP_BEAM_SEAT, { wall: 'S' })
  }
  for (let x = 2; x <= h.x1; x += 4) dep.lamp(x, mid, rnd.int(0, 2) !== 0)
  dep.lamp(L.spawnCells[0].gx, L.spawnCells[0].gz, true)
}

// Security: `lanes` stanchion lanes across the spine joined at alternating
// ends by gaps in the rails, a serpentine nobody queues in; two arches
// (doors) out of the last lane.
function serpentine(T, { x0, lanes }) {
  const { L, dep } = T
  const s = L.spine
  const flip = T.dice(0x5e9).int(0, 1)
  dep.rect(R(x0, s.z0, x0 + lanes - 1, s.z1), CELL_CORRIDOR)
  for (let k = 0; k < lanes; k++) {
    const line = x0 + k
    const gap = (k + flip) % 2 === 0 ? s.z1 : s.z0
    for (let z = s.z0; z <= s.z1; z++) if (z !== gap) dep.rail('v', line, z)
  }
  const lastGap = (lanes - 1 + flip) % 2 === 0 ? s.z1 : s.z0
  for (let z = s.z0; z <= s.z1; z++) dep.edge('v', x0 + lanes, z, 1, PASSAGE_WALL)
  const arch = lastGap === s.z0 ? [s.z1 - 1, s.z1] : [s.z0, s.z0 + 1]
  for (const z of arch) dep.edge('v', x0 + lanes, z, 0, PASSAGE_DOOR)
  dep.lamp(x0 + (lanes >> 1), (s.z0 + s.z1) >> 1, true)
  for (let x = x0 - 1; x <= x0 + lanes + 1; x++) for (let z = s.z0; z <= s.z1; z++) T.noSeat.add(`${x},${z}`)
}

// The bands of a pier: its holdroom bands (outer, mid and front columns).
function bandsOf(p) {
  const out = []
  if (p.hasW) out.push({ side: 'W', x0: p.x0, x1: p.x0 + 2, outerCol: p.x0, midCol: p.x0 + 1, frontCol: p.x0 + 2, outer: p.x0, dx: -1, runs: p.runsW })
  if (p.hasE) out.push({ side: 'E', x0: p.conc.x1 + 1, x1: p.conc.x1 + 3, outerCol: p.conc.x1 + 3, midCol: p.conc.x1 + 2, frontCol: p.conc.x1 + 1, outer: p.conc.x1 + 4, dx: 1, runs: p.runsE })
  return out
}

const pierRow = (p, v) => p.e0 + p.sgn * v
const pierRows = (p, va, vb) => [Math.min(pierRow(p, va), pierRow(p, vb)), Math.max(pierRow(p, va), pierRow(p, vb))]

// A jet bridge out of a gate door: tube cells (gx, gz) + i·(dx, dz) for
// i < len, the closet at i = len; every cell free apron, the flanks free (or
// another bridge's buffer), inside rows/columns 1..54. Returns the longest
// feasible length (≤ cap), or 0.
function bridgeReach(g, { gx, gz, dx, dz }, cap) {
  let best = 0
  for (let len = 1; len <= cap; len++) {
    let ok = true
    for (let i = 0; i <= len && ok; i++) {
      const x = gx + dx * i
      const z = gz + dz * i
      if (x < 1 || z < 1 || x > LAST_X - 1 || z > LAST_Z - 1 || g.get(x, z) !== FREE) ok = false
      for (const s of [-1, 1]) {
        const v = g.get(x + dz * s, z + dx * s)
        if (v !== FREE && v !== BUF && v !== BLOCK) ok = false
      }
    }
    const bx = gx + dx * (len + 1)
    const bz = gz + dz * (len + 1)
    const beyond = g.get(bx, bz)
    if (beyond !== FREE && beyond !== BUF && beyond !== BLOCK) ok = false
    if (!ok) break
    best = len
  }
  return best
}

// Build a bridge of `len` from the gate's outer cell: tube, closet, buffer.
function jetBridge(T, { gx, gz, dx, dz }, len, pier, glass) {
  const { dep, gDep } = T
  for (let i = 0; i < len; i++) {
    const x = gx + dx * i
    const z = gz + dz * i
    dep.open(x, z, CELL_CORRIDOR)
    gDep.set(x, z, CIRC)
    T.tubes.add(z * TILE_CELLS_X + x)
    for (const s of [-1, 1]) if (gDep.get(x + dz * s, z + dx * s) === FREE) gDep.set(x + dz * s, z + dx * s, BUF)
    if (!glass) continue
    if (dx) {
      T.windows.push({ axis: 'h', line: z, along: x }, { axis: 'h', line: z + 1, along: x })
    } else {
      T.windows.push({ axis: 'v', line: x, along: z }, { axis: 'v', line: x + 1, along: z })
    }
  }
  const cx = gx + dx * len
  const cz = gz + dz * len
  const door = dx ? { axis: 'v', gx: dx > 0 ? cx : cx + 1, gz: cz } : { axis: 'h', gx: cx, gz: dz > 0 ? cz : cz + 1 }
  dep.room(R(cx, cz, cx, cz), { spaceId: T.spaceId++, role: SPACE_ROLE_STORAGE, doors: [door] })
  gDep.set(cx, cz, ROOM)
  T.tubes.add(cz * TILE_CELLS_X + cx)
  const bx = cx + dx
  const bz = cz + dz
  if (gDep.get(bx, bz) === FREE) gDep.set(bx, bz, BUF)
  T.gates++
  T.bridges.push({ gx, gz, dx, dz, len, glass })
  return { pier, closet: { gx: cx, gz: cz } }
}

// The upper decks of the jet bridges' fixed links (the arrivals deck of a
// two-level link): on the mezzanine, over a departures tube whose gate
// opens from floor the mezzanine has above it, the same glazed one-cell
// tube out to the same dead end (a closet door at the end, nothing behind
// it). Laid last, over cells nothing else took.
function upperDecks(T, rnd) {
  const { mez, gMez } = T
  for (const b of T.bridges) {
    const ix = b.gx - b.dx
    const iz = b.gz - b.dz
    const inner = gMez.get(ix, iz)
    if ((inner !== ROOM && inner !== CIRC) || !rnd.chance(0.85)) continue
    let ok = true
    for (let i = 0; i <= b.len && ok; i++) {
      const x = b.gx + b.dx * i
      const z = b.gz + b.dz * i
      if (gMez.get(x, z) !== BUF) ok = false
      for (const sg of [-1, 1]) {
        const c = gMez.get(x + b.dz * sg, z + b.dx * sg)
        if (c !== BUF && c !== BLOCK && c !== FREE) ok = false
      }
    }
    if (!ok) continue
    for (let i = 0; i < b.len; i++) {
      const x = b.gx + b.dx * i
      const z = b.gz + b.dz * i
      mez.open(x, z, CELL_CORRIDOR)
      gMez.set(x, z, CIRC)
      if (b.dx) T.windows.push({ axis: 'h', line: z, along: x, outer: true }, { axis: 'h', line: z + 1, along: x, outer: true })
      else T.windows.push({ axis: 'v', line: x, along: z, outer: true }, { axis: 'v', line: x + 1, along: z, outer: true })
    }
    // The gate onto the deck: a door in the floor's wall.
    const gate = b.dx ? { axis: 'v', gx: b.dx > 0 ? b.gx : b.gx + 1, gz: b.gz } : { axis: 'h', gx: b.gx, gz: b.dz > 0 ? b.gz : b.gz + 1 }
    mez.edge(gate.axis, gate.gx, gate.gz, 0, PASSAGE_DOOR)
    const cx = b.gx + b.dx * b.len
    const cz = b.gz + b.dz * b.len
    const door = b.dx ? { axis: 'v', gx: b.dx > 0 ? cx : cx + 1, gz: cz } : { axis: 'h', gx: cx, gz: b.dz > 0 ? cz : cz + 1 }
    mez.room(R(cx, cz, cx, cz), { spaceId: T.spaceId++, role: SPACE_ROLE_STORAGE, doors: [door] })
    gMez.set(cx, cz, ROOM)
  }
}

// A pier: ONE glazed hall (doc §4.2: 3 holdroom + 5 concourse + 3 holdroom,
// the tip lounge at its dead end). The concourse runs the travelator (an
// open belt lane between two balustrades) down its centre; the holdrooms are open zones along the curtain glass (a space
// each, carpet, gate light), each with its gate door and jet bridge, a
// podium beside the door and rows of beam seats facing the glass; the tip
// lounge is the widest room of all, glazed on three sides, up to three
// gates, rows of seats facing the far glass. No wall stands inside it.
function pierHall(T, p) {
  const { dep, gDep } = T
  const rnd = T.dice(0x9e0 + p.i)
  const dead = T.deadPiers.has(p.i)
  const tint = T.tint(p.i)
  const bodyV1 = p.len - p.tip - 1
  const bridgeCap = rnd.int(4, 7)
  const glassy = rnd.int(0, 4) !== 0 // most piers glaze their tubes; some are steel
  const seatStyle = rnd.int(0, 2) // 0: two rows facing the glass, 1: one row facing the glass, 2: back to back
  const [cz0, cz1] = pierRows(p, 0, bodyV1)
  // The concourse, and the mouth (the root rows across the full width).
  dep.rect(R(p.conc.x0, cz0, p.conc.x1, cz1), CELL_LOBBY)
  gDep.rect(R(p.conc.x0, cz0, p.conc.x1, cz1), CIRC)
  if (p.root > 0) {
    const [r0, r1] = pierRows(p, 0, p.root - 1)
    for (const b of bandsOf(p)) {
      dep.rect(R(b.x0, r0, b.x1, r1), CELL_LOBBY)
      gDep.rect(R(b.x0, r0, b.x1, r1), CIRC)
    }
  }
  const [t0, t1] = p.tip ? pierRows(p, p.len - p.tip, p.len - 1) : [cz0, cz1]
  for (let z = Math.min(cz0, t0); z <= Math.max(cz1, t1); z++) for (let x = p.x0; x < p.x0 + p.w; x++) T.open.add(`${x},${z}`)
  // The travelator: a one-cell belt lane between two balustrades down the
  // concourse's centre (open floor, nothing stands on it), with a crossing
  // gap every 9..14 cells; lamps over it.
  const mid = p.conc.x0 + 2
  const every = rnd.int(9, 14)
  for (let v = p.root + 1; v <= bodyV1 - 1; v++) {
    if ((v - p.root) % every === 0) continue
    dep.rail('v', mid, pierRow(p, v))
    dep.rail('v', mid + 1, pierRow(p, v))
    T.belts.add(`${mid},${pierRow(p, v)}`)
  }
  for (let v = 1; v <= bodyV1; v += 3) dep.lamp(mid + (v % 2 ? -2 : 2), pierRow(p, v), !dead && rnd.int(0, 3) !== 0)
  // The pier mouth stays clear on the spine (no seats against it).
  if (p.core) for (let x = p.x0 - 1; x <= p.x0 + p.w; x++) T.noSeat.add(`${x},${p.sgn < 0 ? T.L.spine.z0 : T.L.spine.z1}`)
  const coreAt = (line, z) => !!p.core && p.core.door.line === line && p.core.door.gz === z
  // Holdroom zones.
  for (const b of bandsOf(p)) {
    let v = p.root
    for (const n of b.runs) {
      const vFirst = v
      const [z0, z1] = pierRows(p, v, v + n - 1)
      v += n
      const zone = R(b.x0, z0, b.x1, z1)
      dep.rect(zone, CELL_ROOM, T.spaceId++, SPACE_ROLE_LOUNGE)
      gDep.rect(zone, ROOM)
      const coreRow = p.core && p.core.side === b.side && p.core.door.gz >= z0 && p.core.door.gz <= z1 ? p.core.door.gz : null
      // The gate: an interior row (in dice order) whose bridge fits.
      const rows = []
      for (let z = z0 + 1; z <= z1 - 1; z++) if (z !== coreRow) rows.push(z)
      rnd.shuffle(rows)
      let gate = null
      for (const z of rows) {
        const at = { gx: b.outer + (b.dx < 0 ? -1 : 0), gz: z, dx: b.dx, dz: 0 }
        const reach = bridgeReach(gDep, at, bridgeCap)
        if (reach >= 4) {
          gate = { z, at, len: rnd.int(4, reach) }
          break
        }
      }
      if (gate) {
        dep.edge('v', b.outer, gate.z, 0, PASSAGE_DOOR)
        jetBridge(T, gate.at, gate.len, p.i, glassy)
        // The gate's own glow over its door (doc §8: gates are lit by sign
        // glow and the boards).
        dep.lamp(b.outerCol, gate.z, !dead, dead ? null : tint)
      }
      // Seats: rows parallel to the glass, facing it; the zone's first row
      // (from the root), the gate row and the stair door's row stay aisles
      // from the concourse to the glass.
      const aisle = (z) => z === pierRow(p, vFirst) || z === gate?.z || z === coreRow
      const out = b.side === 'W' ? FACING.W : FACING.E
      const back = b.side === 'W' ? FACING.E : FACING.W
      const podiumZ = gate ? gate.z + (gate.z + 1 <= z1 ? 1 : -1) : null
      for (let z = z0; z <= z1; z++) {
        if (aisle(z)) continue
        if (z !== podiumZ && seatStyle !== 1) T.put(DEP, b.outerCol, z, PROP_BEAM_SEAT, { facing: out })
        T.put(DEP, b.midCol, z, PROP_BEAM_SEAT, { facing: seatStyle === 2 ? back : out })
      }
      if (gate && podiumZ !== coreRow) T.put(DEP, b.outerCol, podiumZ, PROP_GATE_PODIUM, { wall: b.side })
      // The boarding lane: stanchion rails either side of the gate's aisle.
      if (gate) for (const line of [gate.z, gate.z + 1]) dep.rail('h', b.midCol, line)
      // A glass screen between this holdroom and the last (the front column
      // stays open along the concourse).
      if (vFirst > p.root) {
        const line = hLineBetween(pierRow(p, vFirst - 1), pierRow(p, vFirst))
        for (const x of [b.outerCol, b.midCol]) dep.window('h', x, line)
      }
      // The gate's board at the zone's front corner, facing the concourse.
      if (gate) T.fids(b.frontCol, pierRow(p, vFirst), { facing: b.side === 'W' ? FACING.E : FACING.W }, p.i)
      dep.lamp(b.midCol, (z0 + z1) >> 1, !dead, dead ? null : tint)
      if (n >= 7) dep.lamp(b.frontCol, z0 + 1, !dead && rnd.chance(0.5), dead ? null : tint)
    }
  }
  // The apron floodlight's bars along the glass, every FLOOD_EVERY rows.
  for (const b of bandsOf(p)) {
    for (let v = p.root; v <= bodyV1; v++) {
      const z = pierRow(p, v)
      if (((z % FLOOD_EVERY) + FLOOD_EVERY) % FLOOD_EVERY === 3) dep.lamp(b.outerCol, z, true, FLOOD_TINT)
    }
  }
  // The curtain walls down both outer lines (holdrooms, an unloaded side,
  // the mouth), but the gate doors and the stair door.
  for (const line of [p.x0, p.x0 + p.w]) {
    for (let z = Math.min(cz0, cz1); z <= Math.max(cz0, cz1); z++) {
      if (coreAt(line, z) || dep.edges.get(`v:${line},${z}`)?.wall === 0) continue
      T.windows.push({ axis: 'v', line, along: z })
    }
  }
  // A pier that runs on through the seam has its tip in the next row's tile.
  if (p.tip > 0) tipLounge(T, p, { rnd, dead, tint, mid, bridgeCap, glassy, t0, t1 })
}

// The tip lounge: the dead end, glass on three sides, up to three gates.
function tipLounge(T, p, { rnd, dead, tint, mid, bridgeCap, glassy, t0, t1 }) {
  const { dep, gDep } = T
  // The pier head (doc §5: 14 × 10): the tip lounge widens past the body by
  // up to three cells a side where the apron is free (one more cell free
  // beyond, so its glass looks onto mass).
  const clear = (xa, xb, marginX) => {
    for (let z = t0 - 1; z <= t1 + 1; z++) {
      for (let x = xa; x <= xb; x++) {
        const c = gDep.get(x, z)
        const margin = x === marginX || z < t0 || z > t1
        if (c !== FREE && !(margin && (c === BUF || c === BLOCK))) return false
      }
    }
    return true
  }
  let tx0 = p.x0
  let tx1 = p.x0 + p.w - 1
  const grow = rnd.int(0, 3)
  for (let e = grow; e >= 1; e--) if (p.x0 - e - 1 >= 1 && clear(p.x0 - e - 1, p.x0 - 1, p.x0 - e - 1)) { tx0 = p.x0 - e; break }
  for (let e = grow; e >= 1; e--) if (tx1 + e + 1 <= LAST_X - 1 && clear(p.x0 + p.w, p.x0 + p.w + e, p.x0 + p.w + e)) { tx1 = p.x0 + p.w - 1 + e; break }
  const tip = R(tx0, t0, tx1, t1)
  T.tips.set(p.i, tip)
  for (let z = t0; z <= t1; z++) for (let x = tx0; x <= tx1; x++) T.open.add(`${x},${z}`)
  const farLine = p.sgn < 0 ? t0 : t1 + 1
  const tipGates = []
  const tryGate = (axis, line, along, at) => {
    const reach = bridgeReach(gDep, at, bridgeCap)
    if (reach < 4) return false
    const g = { axis, line, along, at, len: rnd.int(4, reach), claimed: [] }
    // Claim it now so the next gate keeps off.
    for (let i = 0; i <= g.len; i++) g.claimed.push([at.gx + at.dx * i, at.gz + at.dz * i])
    for (const [x, z] of g.claimed) gDep.set(x, z, CIRC)
    tipGates.push(g)
    return true
  }
  // The head's rows are claimed first, so no gate's bridge runs through it.
  gDep.rect(tip, ROOM)
  const sideRows = []
  for (let z = t0 + 1; z <= t1 - 1; z++) sideRows.push(z)
  rnd.shuffle(sideRows)
  for (const [line, dx, at0] of [[tx0, -1, tx0 - 1], [tx1 + 1, 1, tx1 + 1]]) {
    for (const z of sideRows.slice(0, 3)) if (tryGate('v', line, z, { gx: at0, gz: z, dx, dz: 0 })) break
  }
  const farCols = []
  for (let x = tx0 + 2; x <= tx1 - 2; x++) farCols.push(x)
  rnd.shuffle(farCols)
  const farWant = tx1 - tx0 >= 13 ? 2 : 1
  for (const x of farCols) {
    if (tipGates.filter((g) => g.axis === 'h').length >= farWant) break
    if (tipGates.some((g) => g.axis === 'h' && Math.abs(g.along - x) < 4)) continue
    tryGate('h', farLine, x, { gx: x, gz: p.sgn < 0 ? t0 - 1 : t1 + 1, dx: 0, dz: p.sgn })
  }
  dep.rect(tip, CELL_ROOM, T.spaceId++, SPACE_ROLE_LOUNGE)
  for (const g of tipGates) {
    for (const [x, z] of g.claimed) gDep.set(x, z, FREE)
    dep.edge(g.axis, g.axis === 'v' ? g.line : g.along, g.axis === 'v' ? g.along : g.line, 0, PASSAGE_DOOR)
  }
  for (const g of tipGates) jetBridge(T, g.at, g.len, p.i, glassy)
  const isGate = (axis, line, along) => tipGates.some((g) => g.axis === axis && g.line === line && g.along === along)
  // Glass on every edge of the head that meets the apron.
  for (let z = t0; z <= t1; z++) {
    for (const [line, nx] of [[tx0, tx0 - 1], [tx1 + 1, tx1 + 1]]) {
      const c = gDep.get(nx, z)
      if (!isGate('v', line, z) && (c === FREE || c === BUF)) T.windows.push({ axis: 'v', line, along: z })
    }
  }
  const nearLine = p.sgn < 0 ? t1 + 1 : t0
  for (let x = tx0; x <= tx1; x++) {
    if (!isGate('h', farLine, x)) T.windows.push({ axis: 'h', line: farLine, along: x })
    const c = gDep.get(x, p.sgn < 0 ? t1 + 1 : t0 - 1)
    if (c === FREE || c === BUF) T.windows.push({ axis: 'h', line: nearLine, along: x })
  }
  // Rows of seats across the lounge facing the far glass: the near row, the
  // far row and both side columns are aisles, and the centre column too.
  const face = p.sgn < 0 ? FACING.N : FACING.S
  for (let k = 1; k <= p.tip - 2; k++) {
    const z = pierRow(p, p.len - p.tip + k)
    for (let x = tx0 + 1; x <= tx1 - 1; x++) if (x !== mid && !(k === 1 && x === mid - 1)) T.put(DEP, x, z, PROP_BEAM_SEAT, { facing: face })
  }
  const farRow = p.sgn < 0 ? t0 : t1
  for (const x of [tx0, tx1]) if (!tipGates.some((g) => g.axis === 'v' && Math.abs(g.along - farRow) <= 1)) T.put(DEP, x, farRow, FURN_PLANT, { wall: p.sgn < 0 ? 'N' : 'S' })
  T.fids(mid - 1, pierRow(p, p.len - p.tip + 1), { facing: p.sgn < 0 ? FACING.S : FACING.N }, p.i)
  dep.lamp(tx0 + 2, (t0 + t1) >> 1, !dead, dead ? null : tint)
  dep.lamp(tx1 - 2, (t0 + t1) >> 1, !dead && rnd.int(0, 1) === 0, dead ? null : tint)
  dep.lamp(mid, farRow, !dead, dead ? null : tint)
}

// The spine's dressing: FIDS banks facing each pier mouth and down the middle,
// seat runs against the curtain glass (never at an opening), a twin
// travelator with crossing gaps outside the serpentine and the check-in hall,
// seating islands between the belts, high-bay lamp circuits.
function spineDressing(T) {
  const { L, dep, gDep } = T
  const s = L.spine
  const rnd = T.dice(0x5d1)
  // An edge cell of the spine against a plain wall (mass or a room wall).
  const walled = (x, z, outZ) => {
    const c = gDep.get(x, outZ)
    if (c === CIRC || c === RESV) return false
    if (c !== ROOM) return true
    const e = dep.edges.get(`h:${x},${hLineBetween(z, outZ)}`)
    return !e || e.wall === 1
  }
  const free = (x, z) => !T.noSeat.has(`${x},${z}`) && !(L.hall && x <= L.hall.x1)
  // FIDS across the spine from each pier mouth.
  for (const p of L.piers) {
    const z = p.sgn < 0 ? s.z1 : s.z0
    const outZ = z + (p.sgn < 0 ? 1 : -1)
    for (let x = p.conc.x0 + 1; x <= p.conc.x1 - 1; x++) {
      if (free(x, z) && walled(x, z, outZ)) {
        T.fids(x, z, { wall: p.sgn < 0 ? 'S' : 'N' }, p.i)
        T.noSeat.add(`${x},${z}`)
      }
    }
  }
  // Seat runs along the curtain glass (the apron side of each wall: rows of
  // empty seats against the black glass), in runs with gaps.
  const glazed = (x, outZ) => {
    const c = gDep.get(x, outZ)
    return c === FREE || c === BUF
  }
  for (const [z, outZ, wall] of [[s.z0, s.z0 - 1, 'N'], [s.z1, s.z1 + 1, 'S']]) {
    const runLen = rnd.int(4, 9)
    for (let x = 1; x <= LAST_X - 2; x++) {
      if ((x % (runLen + 2)) >= runLen) continue
      if (!free(x, z) || !free(x - 1, z) || !free(x + 1, z) || !glazed(x, outZ)) continue
      if (!glazed(x - 1, outZ) || !glazed(x + 1, outZ)) continue
      T.put(DEP, x, z, PROP_BEAM_SEAT, { wall })
    }
  }
  // The twin travelator: two belt lanes 2..3 rows in from the walls (along
  // the galleries' edges), runs of 16..26 (doc §4.3: 20–40) with crossing
  // gaps.
  const inset = [rnd.int(2, 3), rnd.int(2, 3)]
  const lines = [s.z0 + inset[0], s.z1 - inset[1]]
  const every = rnd.int(18, 28)
  const skip = (x) => (L.serpentine && x >= L.serpentine.x0 - 2 && x <= L.serpentine.x0 + L.serpentine.lanes + 2) || (L.hall && x <= L.hall.x1 + 1)
  const gaps = [new Set(), new Set()]
  if (lines[1] - lines[0] >= 2) {
    for (const [i, z] of lines.entries()) {
      const phase = rnd.int(0, every - 1)
      for (let x = 3; x <= LAST_X - 4; x++) {
        if (skip(x)) continue
        if ((x + phase) % every < 2) {
          gaps[i].add(x)
          continue
        }
        // The belt itself is open floor (doc §6: a travelator has no
        // collision): a one-cell lane between its two balustrades, entered
        // at the crossing gaps. Inside an atrium's box the stamp carves the
        // rails away; restoreBoxRails puts them back after it.
        dep.rail('h', x, z)
        dep.rail('h', x, z + 1)
        T.belts.add(`${x},${z}`)
      }
    }
  }
  // Seating islands between the belts (back to back, facing out to the
  // belts), with planters at their ends and a board between islands; the
  // crossing gaps stay clear.
  const rows = []
  for (let z = lines[0] + 2; z <= lines[1] - 2; z++) rows.push(z)
  if (rows.length) {
    const isl = rnd.int(4, 7)
    const between = rnd.int(3, 5)
    const phase = rnd.int(0, isl + between - 1)
    for (let x = 3; x <= LAST_X - 4; x++) {
      if (skip(x) || gaps[0].has(x) || gaps[1].has(x) || gaps[0].has(x - 1) || gaps[1].has(x - 1) || gaps[0].has(x + 1) || gaps[1].has(x + 1)) continue
      const k = (x + phase) % (isl + between)
      if (k >= isl) {
        if (k === isl + (between >> 1)) T.fids(x, rows[0], { facing: FACING.N }, null)
        continue
      }
      for (const [j, z] of rows.entries()) {
        const kind = k === 0 || k === isl - 1 ? FURN_PLANT : PROP_BEAM_SEAT
        T.put(DEP, x, z, kind, { facing: rows.length === 1 ? (x % 2 ? FACING.N : FACING.S) : j < rows.length / 2 ? FACING.N : FACING.S })
      }
    }
  }
  // High-bay rows: whole 8-cell circuits fail together.
  // Landside (tile 0) the circuits still run: the hall the run starts in is lit.
  const circuit = (x) => (L.landside && x < 32) || hashChain(L.vs ^ 0x4b3, x >> 3) % 5 < 3
  for (let x = 2; x <= LAST_X - 2; x += 4) dep.lamp(x, x % 8 === 2 ? s.z0 + 1 : s.z1 - 1, circuit(x))
}

// --- the parts catalogue: modules --------------------------------------------------------
//
// Every room the grammar places is a MODULE of the terminal's catalogue (doc
// 08 §4.2, §5, §6), lined up along a piece of circulation by `lineUp`: a
// module takes a width along the access line and a depth away from it from
// its own ranges, shrinking until its cells are free; a GAP module leaves
// the cells free (the apron: mass behind glass). Its dress lays the pieces
// out in its own frame: u along the access line (0..W−1), v from the access
// row (0) to the back wall (D−1); rows of seats, racks and belts always stop
// one cell short of both side walls (the aisles), and nothing stands on the
// door row, so no piece shuts a cell off.
//
//   departures frontage (the spine and its side concourses): duty-free
//     shops behind grilles, cafés, restrooms, food courts (kiosks along the
//     back, tables), remote gate lounges (seat rows facing the glass, a
//     podium, a gate door and a jet bridge into the apron), club lounges
//     and duty-free halls; glass on every outer wall that faces the apron;
//   baggage (the tunnel, the tug roads, the belt tunnels, the hall): make-up
//     halls (belt blocks), sorting halls (belt lines), plant rooms, cages,
//     lost luggage, staff rooms, the inter-terminal train platform;
//   mezzanine (the lane, the gallery, its spurs): club lounges, food-court
//     units, restrooms.

const DIRS4 = Object.freeze([[1, 0], [-1, 0], [0, 1], [0, -1]])

// The module's frame: cell (u, v), the back wall's name, the outward step.
function frameOf(seg, a, W, D) {
  const { axis, line, side } = seg
  const at = axis === 'x' ? (u, v) => [a + u, line + side * (v + 1)] : (u, v) => [line + side * (v + 1), a + u]
  const back = axis === 'x' ? (side > 0 ? 'S' : 'N') : side > 0 ? 'E' : 'W'
  const out = axis === 'x' ? [0, side] : [side, 0]
  const [xa, za] = at(0, 0)
  const [xb, zb] = at(W - 1, D - 1)
  const r = R(Math.min(xa, xb), Math.min(za, zb), Math.max(xa, xb), Math.max(za, zb))
  // The edge between cell (u, v) and its neighbour one step outward
  // (v → v + 1), and the edges of side wall s (−1: u = −1 | 0, +1: u = W−1 | W).
  const outEdge = (u, v) => {
    const [x, z] = at(u, v)
    return axis === 'x' ? { axis: 'h', gx: x, gz: side > 0 ? z + 1 : z } : { axis: 'v', gx: side > 0 ? x + 1 : x, gz: z }
  }
  const sideEdge = (s, v) => {
    const [x, z] = at(s < 0 ? 0 : W - 1, v)
    return axis === 'x' ? { axis: 'v', gx: s < 0 ? x : x + 1, gz: z } : { axis: 'h', gx: x, gz: s < 0 ? z : z + 1 }
  }
  // Facings along +u / −u (a chair turned toward the next cell along).
  const alongPos = axis === 'x' ? FACING.E : FACING.S
  const alongNeg = axis === 'x' ? FACING.W : FACING.N
  return { axis, at, back, out, r, W, D, outEdge, sideEdge, alongPos, alongNeg }
}

// Lamps over a room: one per ~5×5 cells, on a grid.
function roomLamps(T, plan, cy, f, rnd, tint, share = 0.5) {
  // Half the tubes are dead (doc §8: many circuits dead; darkness 0.3–0.5);
  // the gate halls keep more of theirs (gates are lit).
  // Landside (tile 0) the halls round the spawn keep most of theirs.
  const p = T.L.landside ? Math.max(share, 0.85) : share
  const lit = () => rnd.chance(p)
  if (f.W * f.D < 6) return
  const nu = Math.max(1, Math.round(f.W / 5))
  const nv = Math.max(1, Math.round(f.D / 5))
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const [x, z] = f.at(Math.floor(((i + 0.5) * f.W) / nu), Math.floor(((j + 0.5) * f.D) / nv))
      plan.lamp(x, z, lit(), tint)
    }
  }
}

// A row of pieces across the room at depth v, u = 1..W−2 (the end aisles),
// every `step` cells.
function rowAt(T, cy, f, v, kind, { facing = null, step = 1, skip = null } = {}) {
  for (let u = 1; u <= f.W - 2; u += step) {
    if (skip && skip(u)) continue
    const [x, z] = f.at(u, v)
    T.put(cy, x, z, kind, { facing: facing ?? FACING.S })
  }
}
const backRow = (T, cy, f, kind, step = 1) => {
  if (f.D < 3) return
  for (let u = 1; u <= f.W - 2; u += step) {
    const [x, z] = f.at(u, f.D - 1)
    T.put(cy, x, z, kind, { wall: f.back })
  }
}
const FACE_OF = Object.freeze({ N: FACING.N, S: FACING.S, E: FACING.E, W: FACING.W })
const OPP = Object.freeze({ N: 'S', S: 'N', E: 'W', W: 'E' })

// --- dresses ------------------------------------------------------------------------------

const dressShop = (T, cy, f) => backRow(T, cy, f, FURN_RACK)
// Restrooms: a row of WCs against the back wall, basins down one side.
const dressRestroom = (T, cy, f) => {
  for (let u = 0; u < f.W; u++) {
    const [x, z] = f.at(u, f.D - 1)
    T.put(cy, x, z, FURN_TOILET, { wall: f.back })
  }
  for (let v = 1; v <= f.D - 3; v++) {
    const [x, z] = f.at(0, v)
    T.put(cy, x, z, FURN_SINK, { facing: f.alongPos })
  }
}
const dressCafe = (T, cy, f) => {
  backRow(T, cy, f, FURN_COUNTER)
  if (f.D >= 5 && f.W >= 5) rowAt(T, cy, f, 2, FURN_TABLE, { step: 3 })
}
const dressClub = (T, cy, f) => {
  backRow(T, cy, f, FURN_SOFA, 2)
  if (f.D >= 6) rowAt(T, cy, f, f.D - 4, FURN_TABLE, { step: 3 })
  const [x, z] = f.at(0, f.D - 1)
  T.put(cy, x, z, FURN_PLANT, { wall: f.back })
}
const dressOffice = (T, cy, f) => {
  const [x0, z0] = f.at(1, f.D - 1)
  T.put(cy, x0, z0, FURN_DESK, { wall: f.back })
  if (f.W >= 4) {
    const [x1, z1] = f.at(f.W - 2, f.D - 1)
    T.put(cy, x1, z1, FURN_CABINET, { wall: f.back })
  }
}
const dressStaff = (T, cy, f) => {
  backRow(T, cy, f, FURN_SOFA, 3)
  if (f.D >= 4 && f.W >= 4) {
    const [x, z] = f.at(f.W >> 1, f.D >> 1)
    T.put(cy, x, z, FURN_TABLE, { facing: FACING.S })
  }
}
const dressCage = (T, cy, f) => backRow(T, cy, f, FURN_RACK, 2)
const dressPlant = (T, cy, f) => {
  backRow(T, cy, f, FURN_CABINET)
  if (f.D >= 6) rowAt(T, cy, f, f.D - 4, FURN_RACK, { step: 2 })
}
// Make-up hall: belt blocks (two rows of counters) with aisles round them.
const dressMakeup = (T, cy, f) => {
  for (let v = 2; v + 1 <= f.D - 2; v += 4) {
    rowAt(T, cy, f, v, FURN_COUNTER, { facing: FACE_OF[OPP[f.back]], skip: (u) => u < 2 || u > f.W - 3 })
    rowAt(T, cy, f, v + 1, FURN_COUNTER, { facing: FACE_OF[f.back], skip: (u) => u < 2 || u > f.W - 3 })
  }
}
// Sorting hall: single belt lines.
const dressSorting = (T, cy, f) => {
  for (let v = 2; v <= f.D - 2; v += 3) rowAt(T, cy, f, v, FURN_COUNTER, { facing: FACE_OF[f.back] })
}
// The inter-terminal platform: beam seats against the track wall, a board.
const dressPlatform = (T, cy, f) => {
  for (let u = 1; u <= f.W - 2; u++) {
    if (u % 5 === 0) continue
    const [x, z] = f.at(u, f.D - 1)
    T.put(cy, x, z, PROP_BEAM_SEAT, { wall: f.back })
  }
}
// Food court: kiosks (3 deep, 3..4 wide, each its own unit with a counter
// front) along the back, then tables with a chair either side in rows
// across the hall.
function dressFoodCourt(T, cy, f, m) {
  const { plan, g, rnd } = m
  let back = 0
  if (f.D >= 7 && f.W >= 6) {
    back = 3
    let u = 0
    while (u <= f.W - 3) {
      const w = Math.min(rnd.int(3, 4), f.W - u)
      if (w < 3) break
      const [xa, za] = f.at(u, f.D - 3)
      const [xb, zb] = f.at(u + w - 1, f.D - 1)
      const r = R(Math.min(xa, xb), Math.min(za, zb), Math.max(xa, xb), Math.max(za, zb))
      const door = f.outEdge(u + (w >> 1), f.D - 4)
      plan.room(r, { spaceId: T.spaceId++, role: SPACE_ROLE_KITCHEN, doors: [{ ...door, passage: PASSAGE_WIDE }] })
      g.rect(r, ROOM)
      for (let k = u; k < u + w; k++) {
        if (k === u + (w >> 1)) continue
        const [x, z] = f.at(k, f.D - 1)
        T.put(cy, x, z, FURN_COUNTER, { wall: f.back })
      }
      const [lx, lz] = f.at(u + (w >> 1), f.D - 2)
      plan.lamp(lx, lz, rnd.chance(0.6), LOUNGE_TINT)
      u += w
    }
  } else {
    backRow(T, cy, f, FURN_COUNTER)
  }
  for (let v = 2; v <= f.D - back - 3; v += 2) {
    for (let u = 2; u + 1 <= f.W - 2; u += 4) {
      const put = (uu, kind, facing) => {
        const [x, z] = f.at(uu, v)
        T.put(cy, x, z, kind, { facing })
      }
      put(u, FURN_TABLE, FACING.S)
      put(u - 1, FURN_CHAIR, f.alongPos)
      put(u + 1, FURN_CHAIR, f.alongNeg)
    }
  }
}
// Gate lounge (a holdroom hall off the spine): one or two gate doors on the
// back wall (the curtain glass), each with a jet bridge into the apron
// (where it reaches 4) and a podium beside it; rows of beam seats facing the
// glass, two rows then a cross aisle, a centre aisle and an aisle down to
// each gate; boards at the front corners.
function dressGateLounge(T, cy, f, m) {
  const { plan, g, rnd } = m
  const us = []
  for (let u = 1; u <= f.W - 2; u++) us.push(u)
  rnd.shuffle(us)
  const gates = []
  const want = f.W >= 16 ? 3 : f.W >= 11 ? 2 : 1
  const [dx, dz] = f.out
  const glassy = rnd.int(0, 3) !== 0
  m.gateEdges = []
  for (const u of us) {
    if (gates.length >= want) break
    if (gates.some((o) => Math.abs(o.u - u) < 4)) continue
    const [x, z] = f.at(u, f.D)
    const at = { gx: x, gz: z, dx, dz }
    const reach = bridgeReach(g, at, rnd.int(6, 11))
    if (reach < 4) continue
    const gate = { u, at, len: rnd.int(4, reach) }
    gates.push(gate)
    const e = f.outEdge(gate.u, f.D - 1)
    plan.edge(e.axis, e.gx, e.gz, 0, PASSAGE_DOOR)
    m.gateEdges.push(e)
    jetBridge(T, gate.at, gate.len, -1, glassy)
  }
  // Too little apron behind it (a satellite out by the tile's edge): the
  // gates go out of its side walls instead.
  const sideGates = []
  const sideWant = m.sideGates ? 2 : Math.min(2, want - gates.length)
  if (sideWant > 0) {
    for (const sgn of rnd.chance(0.5) ? [-1, 1] : [1, -1]) {
      if (sideGates.length >= sideWant) break
      const vs = []
      for (let v = 2; v <= f.D - 2; v++) vs.push(v)
      rnd.shuffle(vs)
      for (const v of vs) {
        const [x, z] = f.at(sgn < 0 ? -1 : f.W, v)
        const at = f.axis === 'x' ? { gx: x, gz: z, dx: sgn, dz: 0 } : { gx: x, gz: z, dx: 0, dz: sgn }
        const reach = bridgeReach(g, at, rnd.int(6, 11))
        if (reach < 4) continue
        const e = f.sideEdge(sgn, v)
        plan.edge(e.axis, e.gx, e.gz, 0, PASSAGE_DOOR)
        m.gateEdges.push(e)
        jetBridge(T, at, rnd.int(4, reach), -1, glassy)
        sideGates.push({ sgn, v })
        const [px, pz] = f.at(sgn < 0 ? 0 : f.W - 1, v + (v + 1 <= f.D - 2 ? 1 : -1))
        T.put(cy, px, pz, PROP_GATE_PODIUM, { facing: sgn < 0 ? f.alongPos : f.alongNeg })
        break
      }
    }
  }
  for (const gate of gates) {
    const pu = gate.u + (gate.u + 1 <= f.W - 2 ? 1 : -1)
    if (!gates.some((o) => o.u === pu)) {
      const [px, pz] = f.at(pu, f.D - 1)
      T.put(cy, px, pz, PROP_GATE_PODIUM, { wall: f.back })
    }
  }
  const face = FACE_OF[f.back]
  const centre = f.W >= 10 ? f.W >> 1 : -1
  for (let v = 2; v <= f.D - 3; v++) {
    if ((v - 2) % 3 === 2) continue
    if (sideGates.some((o) => Math.abs(o.v - v) <= 1)) {
      rowAt(T, cy, f, v, PROP_BEAM_SEAT, { facing: face, skip: (u) => u <= 1 || u >= f.W - 2 || u === centre || gates.some((o) => o.u === u) })
      continue
    }
    rowAt(T, cy, f, v, PROP_BEAM_SEAT, { facing: face, skip: (u) => u === centre || gates.some((o) => o.u === u) })
  }
  const toFront = FACE_OF[OPP[f.back]]
  for (const u of [0, f.W - 1]) {
    const [bx, bz] = f.at(u, 1)
    T.fids(bx, bz, { facing: toFront }, null)
  }
}
// Airline lounge (the CLUb level): a bar along one side wall, rows of
// armchairs facing the far glass with low tables between, sofas against the
// other side wall, plants in the corners.
function dressAirlineLounge(T, cy, f) {
  // The bar down one side wall's front half, sofas down its back half.
  for (let v = 2; v <= f.D - 2; v++) {
    const [x, z] = f.at(0, v)
    T.put(cy, x, z, v <= f.D >> 1 ? FURN_COUNTER : FURN_SOFA, { facing: f.alongPos })
  }
  // The reception desk beside the entrance.
  const [rx, rz] = f.at((f.W >> 1) + 2, 1)
  T.put(cy, rx, rz, FURN_COUNTER, { facing: FACE_OF[OPP[f.back]] })
  const face = FACE_OF[f.back]
  // Pairs of armchairs either side of a low table, scattered on a loose
  // grid (every other group skips a beat), facing the far glass.
  for (let v = 2, row = 0; v <= f.D - 3; v += 2, row++) {
    for (let u = 3 + (row % 2) * 3; u + 2 <= f.W - 3; u += 6) {
      for (const [du, kind] of [[0, FURN_ARMCHAIR], [1, FURN_TABLE], [2, FURN_ARMCHAIR]]) {
        const [x, z] = f.at(u + du, v)
        T.put(cy, x, z, kind, { facing: face })
      }
    }
  }
  for (let v = 2; v <= f.D - 2; v += 2) {
    const [x, z] = f.at(f.W - 1, v)
    T.put(cy, x, z, FURN_SOFA, { facing: f.alongNeg })
  }
  // Sofas along the far glass, a plant at each end.
  for (let u = 2; u <= f.W - 3; u++) {
    const [x, z] = f.at(u, f.D - 1)
    T.put(cy, x, z, u === 2 || u === f.W - 3 ? FURN_PLANT : FURN_SOFA, { wall: f.back })
  }
}
// Observation deck: rows of beam seats facing the far glass (the apron, the
// tower), every third row an aisle, a centre aisle.
function dressObservation(T, cy, f) {
  const face = FACE_OF[f.back]
  const centre = f.W >> 1
  // Rows at the glass, two then an aisle, over the far half; the near half
  // stays open floor with a few planters.
  for (let v = f.D - 2, k = 0; v >= Math.max(2, f.D >> 2); v--, k++) {
    if (k % 3 === 2) continue
    rowAt(T, cy, f, v, PROP_BEAM_SEAT, { facing: face, skip: (u) => u === centre })
  }
  for (let u = 2; u <= f.W - 3; u += 5) {
    const [x, z] = f.at(u, 2)
    T.put(cy, x, z, FURN_PLANT, { facing: face })
  }
  for (const u of [0, f.W - 1]) {
    const [x, z] = f.at(u, f.D - 1)
    T.put(cy, x, z, FURN_PLANT, { wall: f.back })
  }
}
const dressQuiet = (T, cy, f) => {
  for (let v = 1; v <= f.D - 2; v += 2) rowAt(T, cy, f, v, v % 4 === 1 ? FURN_SOFA : FURN_ARMCHAIR, { facing: FACE_OF[f.back], step: 2 })
  backRow(T, cy, f, FURN_PLANT, 3)
}
// Walk-through duty-free: an open hall of rack aisles running back from the
// spine (a cross aisle half way), racks along the back wall, a till counter
// at each front corner.
function dressWalkThrough(T, cy, f) {
  const cross = f.D >> 1
  for (let u = 2; u <= f.W - 3; u += 3) {
    for (let v = 2; v <= f.D - 2; v++) {
      if (v === cross) continue
      const [x, z] = f.at(u, v)
      T.put(cy, x, z, FURN_RACK, { facing: f.alongPos })
    }
  }
  backRow(T, cy, f, FURN_RACK)
  for (const u of [1, f.W - 2]) {
    const [x, z] = f.at(u, 1)
    T.put(cy, x, z, FURN_COUNTER, { facing: FACE_OF[OPP[f.back]] })
  }
}

// --- catalogues -----------------------------------------------------------------------------

// [name, weight, w, d, role, front passage, doors, glass, tint, dress]
const mod = (name, weight, w, d, role, passage, doors, glass, tint, dress) => Object.freeze({ name, weight, w, d, role, passage, doors, glass, tint, dress })
// An open-fronted hall: its whole front onto the circulation is one wide
// opening (no leaves, a threshold strip where the floor changes) but for a
// wall stub at each end; glazed wherever it meets the apron; `zones` halls
// of 12+ cells split into two spaces along the front (no wall).
// `entry`: a lounge behind a glazed front with one two-cell entrance in its
// middle (an airline club) rather than an open front.
const hallMod = (name, weight, w, d, role, tint, dress, { zones = false, lit = 0.5, entry = false } = {}) =>
  Object.freeze({ name, weight, w, d, role, passage: PASSAGE_WIDE, doors: 0, open: true, entry, zones, lit, glass: true, tint, dress })
const gap = (weight, w) => Object.freeze({ name: 'apron', gap: true, weight, w })
// Departures' lights (doc §8): gates are lit by their glow, duty-free and
// the cafés glow behind their grilles, the rest of the halls keep about
// half their circuits.
const litMod = (m, lit) => Object.freeze({ ...m, lit })
const DEP_FRONT = Object.freeze([
  gap(1, [3, 6]),
  hallMod('gate lounge', 8, [10, 26], [8, 21], SPACE_ROLE_LOUNGE, GATE_TINT, dressGateLounge, { zones: true, lit: 0.8 }),
  hallMod('food court', 4, [12, 24], [8, 19], SPACE_ROLE_KITCHEN, LOUNGE_TINT, dressFoodCourt, { lit: 0.6 }),
  hallMod('duty-free', 3, [10, 20], [7, 16], SPACE_ROLE_STORAGE, LOUNGE_TINT, dressWalkThrough, { zones: true, lit: 0.75 }),
  litMod(mod('shop', 2, [3, 6], [3, 5], SPACE_ROLE_STORAGE, PASSAGE_WIDE, 1, true, LOUNGE_TINT, dressShop), 0.75),
  litMod(mod('café', 1, [4, 6], [3, 5], SPACE_ROLE_KITCHEN, PASSAGE_WIDE, 1, true, LOUNGE_TINT, dressCafe), 0.75),
  mod('club lounge', 1, [8, 12], [6, 10], SPACE_ROLE_LOUNGE, PASSAGE_DOOR, 1, true, LOUNGE_TINT, dressClub),
  mod('restrooms', 1, [3, 4], [4, 5], SPACE_ROLE_BATHROOM, PASSAGE_DOOR, 1, false, null, dressRestroom),
])
const BAG_SERVICE = Object.freeze([
  gap(2, [2, 4]),
  mod('make-up hall', 6, [10, 20], [8, 18], SPACE_ROLE_STORAGE, PASSAGE_WIDE, 1, false, null, dressMakeup),
  mod('sorting hall', 3, [8, 14], [6, 14], SPACE_ROLE_STORAGE, PASSAGE_WIDE, 1, false, null, dressSorting),
  mod('plant', 2, [5, 10], [4, 9], SPACE_ROLE_SERVER, PASSAGE_DOOR, 1, false, null, dressPlant),
  mod('cages', 1, [4, 8], [4, 7], SPACE_ROLE_STORAGE, PASSAGE_DOOR, 1, false, null, dressCage),
  mod('staff', 1, [4, 6], [3, 5], SPACE_ROLE_BREAK, PASSAGE_DOOR, 1, false, null, dressStaff),
])
// Round the baggage halls: the arrivals side's units.
const dressDesks = (T, cy, f) => {
  for (let u = 1; u <= f.W - 2; u++) {
    const [x, z] = f.at(u, 1)
    if (u % 3 !== 0) T.put(cy, x, z, FURN_COUNTER, { facing: FACE_OF[OPP[f.back]] })
  }
  backRow(T, cy, f, FURN_CABINET, 2)
}
const ARR_FRONT = Object.freeze([
  gap(3, [3, 6]),
  mod('baggage services', 2, [5, 9], [3, 5], SPACE_ROLE_OFFICE, PASSAGE_WIDE, 1, false, GATE_TINT, dressDesks),
  mod('lost luggage', 2, [4, 7], [3, 5], SPACE_ROLE_OFFICE, PASSAGE_DOOR, 1, false, GATE_TINT, dressOffice),
  mod('car hire', 1, [6, 10], [3, 4], SPACE_ROLE_OFFICE, PASSAGE_WIDE, 1, false, LOUNGE_TINT, dressDesks),
  mod('café', 1, [4, 6], [3, 5], SPACE_ROLE_KITCHEN, PASSAGE_WIDE, 1, false, LOUNGE_TINT, dressCafe),
  mod('restrooms', 2, [3, 4], [4, 5], SPACE_ROLE_BATHROOM, PASSAGE_DOOR, 1, false, null, dressRestroom),
])
const BAG_PLATFORM = mod('platform', 0, [12, 20], [3, 4], SPACE_ROLE_LOUNGE, PASSAGE_WIDE, 2, false, LOUNGE_TINT, dressPlatform)
// A balcony lounge over a pier's holdrooms: armchairs in pairs against the
// outer glass, facing out.
const dressBalcony = (T, cy, f) => {
  for (let u = 1; u + 1 <= f.W - 2; u += 3) {
    for (const du of [0, 1]) {
      const [x, z] = f.at(u + du, f.D - 1)
      T.put(cy, x, z, FURN_ARMCHAIR, { facing: FACE_OF[f.back] })
    }
    if (f.D >= 4) {
      const [x, z] = f.at(u, f.D - 2)
      T.put(cy, x, z, FURN_TABLE, { facing: FACE_OF[f.back] })
    }
  }
}
const MEZ_FRONT = Object.freeze([
  gap(1, [2, 5]),
  mod('balcony lounge', 3, [4, 9], [3, 4], SPACE_ROLE_LOUNGE, PASSAGE_WIDE, 1, true, LOUNGE_TINT, dressBalcony),
  hallMod('airline lounge', 6, [8, 16], [6, 23], SPACE_ROLE_LOUNGE, LOUNGE_TINT, dressAirlineLounge, { zones: true, lit: 0.6, entry: true }),
  hallMod('food balcony', 4, [8, 16], [6, 16], SPACE_ROLE_KITCHEN, LOUNGE_TINT, dressFoodCourt, { zones: true }),
  hallMod('observation deck', 3, [8, 14], [6, 22], SPACE_ROLE_LOUNGE, null, dressObservation, { zones: true }),
  mod('quiet room', 2, [5, 8], [4, 7], SPACE_ROLE_LOUNGE, PASSAGE_DOOR, 1, true, LOUNGE_TINT, dressQuiet),
  mod('café', 3, [4, 7], [3, 5], SPACE_ROLE_KITCHEN, PASSAGE_WIDE, 1, true, LOUNGE_TINT, dressCafe),
  mod('restrooms', 1, [3, 4], [4, 5], SPACE_ROLE_BATHROOM, PASSAGE_DOOR, 1, false, null, dressRestroom),
])
// The mezzanine reads its land for halls a little shallower and narrower
// than departures (it sits over the halls below, cut by the walkway).
const MEZ_HALL = Object.freeze({ d: 6, w: 8 })

// Departures: the depth (cells of free apron) a hall needs, and its least
// width.
const HALL_D = 8
const HALL_W = 10

const pickMod = (rnd, kinds) => {
  let total = 0
  for (const k of kinds) total += k.weight
  let n = rnd.int(0, total - 1)
  for (const k of kinds) {
    n -= k.weight
    if (n < 0) return k
  }
  return kinds[0]
}

// Line modules up along one access segment (see segmentsOf). Returns the
// number of rooms placed.
function lineUp(T, g, plan, cy, seg, rnd, kinds, { glass = false, once = null, exhaust = false, hall = null } = {}) {
  const hallD = hall?.d ?? HALL_D
  const hallW = hall?.w ?? HALL_W
  const { axis, a0, a1, line, side } = seg
  const cellAt = (a, k) => (axis === 'x' ? [a, line + side * k] : [line + side * k, a])
  const maxD = kinds.reduce((m, k) => Math.max(m, k.d ? k.d[1] : 0), 0)
  const reach = new Map()
  const depthAt = (b) => {
    let v = reach.get(b)
    if (v === undefined) {
      v = 0
      while (v < maxD && g.get(...cellAt(b, v + 1)) === FREE) v++
      reach.set(b, v)
    }
    return v
  }
  const fits = (b, w, d) => {
    for (let i = 0; i < w; i++) if (b + i > a1 || depthAt(b + i) < d) return false
    return true
  }
  const minD = kinds.reduce((m, k) => Math.min(m, k.d ? k.d[0] : 99), 99)
  let a = a0
  let placed = 0
  let lastGap = true // never open a run, nor follow a gap, with a gap
  while (a <= a1) {
    if (g.get(...cellAt(a, 0)) !== CIRC || depthAt(a) < minD) {
      a++
      continue
    }
    let k = null
    let wCap = 99
    if (exhaust) {
      // Departures reads the land first: a run of deep apron (≥ HALL_D)
      // wide enough takes a hall sized to it; shallow land (or a deep run
      // too narrow for a hall) takes units no wider than itself, or glass.
      let run = 0
      while (a + run <= a1 && depthAt(a + run) >= hallD && g.get(...cellAt(a + run, 0)) === CIRC) run++
      if (run >= hallW) {
        k = pickMod(rnd, kinds.filter((q) => q.open))
        wCap = run <= k.w[1] ? run : run - hallW >= k.w[0] ? rnd.int(k.w[0], Math.min(k.w[1], run - hallW)) : k.w[1]
      } else {
        let sh = run
        if (!run) while (a + sh <= a1 && depthAt(a + sh) < hallD && g.get(...cellAt(a + sh, 0)) === CIRC) sh++
        const units = kinds.filter((q) => !q.open && !q.gap && q.w[0] <= sh && q.d[0] <= depthAt(a))
        if (!units.length || (!lastGap && rnd.chance(0.15))) {
          lastGap = true
          const n = Math.max(1, Math.min(sh, rnd.int(3, 6)))
          if (glass) {
            for (let i = 0; i < n && a + i <= a1; i++) {
              const [x, z] = cellAt(a + i, 0)
              if (axis === 'x') T.windows.push({ axis: 'h', line: side > 0 ? z + 1 : z, along: x, outer: true })
              else T.windows.push({ axis: 'v', line: side > 0 ? x + 1 : x, along: z, outer: true })
            }
          }
          a += n
          continue
        }
        k = pickMod(rnd, units)
        wCap = sh
      }
      lastGap = false
    } else {
      k = once && once.left > 0 && rnd.chance(once.p) ? once.mod : pickMod(rnd, lastGap ? kinds.filter((q) => !q.gap) : kinds)
      lastGap = !!k.gap
    }
    if (k.gap) {
      const n = rnd.int(k.w[0], k.w[1])
      // The apron reaches the circulation here: glass the access wall.
      if (glass) {
        for (let i = 0; i < n && a + i <= a1; i++) {
          const [x, z] = cellAt(a + i, 0)
          if (axis === 'x') T.windows.push({ axis: 'h', line: side > 0 ? z + 1 : z, along: x, outer: true })
          else T.windows.push({ axis: 'v', line: side > 0 ? x + 1 : x, along: z, outer: true })
        }
      }
      a += n
      continue
    }
    let room = null
    const tryKind = (q) => {
      const w0 = Math.min(wCap, rnd.int(q.w[0], q.w[1]))
      // Halls lean deep (out to the apron's far edge); units take any depth.
      const d0 = rnd.int(q.d[1] >= 8 ? (q.d[0] + q.d[1]) >> 1 : q.d[0], q.d[1])
      for (let w = exhaust && q.open ? Math.min(wCap, q.w[1]) : w0; w >= q.w[0]; w--) {
        for (let d = d0; d >= q.d[0]; d--) if (fits(a, w, d)) return { w, d }
      }
      return null
    }
    for (let tries = 0; tries < 3 && !room; tries++) {
      if (tries && !exhaust) k = pickMod(rnd, kinds.filter((q) => !q.gap))
      room = tryKind(k)
    }
    // `exhaust`: then every other kind, the heaviest first (the halls), so a
    // stretch the dice missed still takes the biggest module that fits.
    if (!room && exhaust) {
      for (const q of kinds.filter((q) => !q.gap && q.w[0] <= wCap).sort((x, y) => y.weight - x.weight)) {
        room = tryKind(q)
        if (room) {
          k = q
          break
        }
      }
    }
    if (!room) {
      lastGap = true
      a++
      continue
    }
    if (k === once?.mod) once.left--
    const f = frameOf(seg, a, room.w, room.d)
    // Doors on the access row, spread over the width.
    const cands = []
    for (let u = 0; u < room.w; u++) if (g.get(...cellAt(a + u, 0)) === CIRC) cands.push(u)
    const doorUs = []
    if (k.entry) {
      const mid = cands.length >> 1
      for (const i of [mid - 1, mid]) if (i >= 0 && i < cands.length) doorUs.push(cands[i])
    } else if (k.open) {
      for (const u of cands) if ((u > 0 && u < room.w - 1) || room.w <= 2) doorUs.push(u)
    } else {
      const n = Math.min(k.doors, cands.length)
      for (let i = 0; i < n; i++) doorUs.push(cands[Math.floor(((i + 0.5) * cands.length) / n)])
    }
    const doors = doorUs.map((u) => {
      const [x, z] = cellAt(a + u, 0)
      return axis === 'x' ? { axis: 'h', gx: x, gz: side > 0 ? z + 1 : z, passage: k.passage } : { axis: 'v', gx: side > 0 ? x + 1 : x, gz: z, passage: k.passage }
    })
    plan.room(f.r, { spaceId: T.spaceId++, role: k.role, doors })
    g.rect(f.r, ROOM)
    if (cy === MEZ && k.open) T.mezHalls.push(f.r)
    if (k.zones && room.w >= (cy === MEZ ? 10 : 12)) {
      // The far half is a second space (no wall between them); up on the
      // mezzanine a glass screen parts the two (a club's inner room), open
      // for two cells at the front and two half way back.
      const [xa, za] = f.at(room.w >> 1, 0)
      const [xb, zb] = f.at(room.w - 1, room.d - 1)
      plan.rect(R(Math.min(xa, xb), Math.min(za, zb), Math.max(xa, xb), Math.max(za, zb)), CELL_ROOM, T.spaceId++, k.role)
      if (cy === MEZ) {
        const u = room.w >> 1
        const gapV = room.d >> 1
        // A food balcony's kiosk band (its back three rows, dressFoodCourt)
        // is kiosks with their own walls: the screen stops short of it, so
        // it never cuts a kiosk in two.
        const vEnd = k.dress === dressFoodCourt && room.d >= 7 && room.w >= 6 ? room.d - 3 : room.d
        for (let v = 0; v < vEnd; v++) {
          if (v <= 1 || v === gapV || v === gapV + 1) continue
          const [ex, ez] = f.at(u, v)
          if (f.axis === 'x') plan.window('v', ex, ez)
          else plan.window('h', ex, ez)
        }
        // A deep hall's back half behind a second screen (the inner room),
        // open at both ends and in the middle.
        if (room.d >= 10) {
          const v = room.d >> 1
          for (let uu = 1; uu < room.w - 1; uu++) {
            if (Math.abs(uu - u) <= 1) continue
            const e = f.outEdge(uu, v - 1)
            plan.window(e.axis, e.gx, e.gz)
          }
        }
      }
    }
    if (k.open && cy === DEP) for (let z = f.r.z0; z <= f.r.z1; z++) for (let x = f.r.x0; x <= f.r.x1; x++) T.open.add(`${x},${z}`)
    roomLamps(T, plan, cy, f, rnd, k.tint, k.lit ?? 0.5)
    const m = { plan, g, rnd, gateEdges: [] }
    if (k.dress) k.dress(T, cy, f, m)
    if (glass && k.glass) {
      const isGate = (e) => m.gateEdges.some((q) => e.axis === q.axis && e.gx === q.gx && e.gz === q.gz)
      const push = (e) => {
        if (isGate(e)) return
        T.windows.push(e.axis === 'v' ? { axis: 'v', line: e.gx, along: e.gz, outer: true } : { axis: 'h', line: e.gz, along: e.gx, outer: true })
      }
      for (let u = 0; u < f.W; u++) push(f.outEdge(u, f.D - 1))
      for (let v = 0; v < f.D; v++) for (const s of [-1, 1]) push(f.sideEdge(s, v))
      // The front onto the concourse is a glazed shopfront either side of
      // the door (a partition: walkable both sides).
      for (let u = 0; u < f.W; u++) {
        if (doorUs.includes(u) || g.get(...cellAt(a + u, 0)) !== CIRC) continue
        const [x, z] = cellAt(a + u, 0)
        if (axis === 'x') T.windows.push({ axis: 'h', line: side > 0 ? z + 1 : z, along: x })
        else T.windows.push({ axis: 'v', line: side > 0 ? x + 1 : x, along: z })
      }
    }
    if (cy === DEP) {
      for (const u of doorUs) {
        const [x, z] = cellAt(a + u, 0)
        T.noSeat.add(`${x},${z}`)
      }
    }
    placed++
    a += room.w
    // A hall's dress may have run jet bridges out into the land ahead.
    reach.clear()
  }
  return placed
}

// Access segments: maximal straight runs of circulation cells whose
// neighbour on one side is free (and, with `mask`, inside it).
function segmentsOf(g, mask = null) {
  const out = []
  const ok = (x, z, nx, nz) => g.get(x, z) === CIRC && g.get(nx, nz) === FREE && (!mask || mask[z * TILE_CELLS_X + x])
  for (const side of [-1, 1]) {
    for (let z = 1; z < LAST_Z; z++) {
      let a0 = -1
      for (let x = 0; x <= TILE_CELLS_X; x++) {
        const on = x < TILE_CELLS_X && ok(x, z, x, z + side)
        if (on && a0 < 0) a0 = x
        if (!on && a0 >= 0) {
          out.push({ axis: 'x', a0, a1: x - 1, line: z, side })
          a0 = -1
        }
      }
    }
    for (let x = 1; x < LAST_X; x++) {
      let a0 = -1
      for (let z = 0; z <= TILE_CELLS_Z; z++) {
        const on = z < TILE_CELLS_Z && ok(x, z, x + side, z)
        if (on && a0 < 0) a0 = z
        if (!on && a0 >= 0) {
          out.push({ axis: 'z', a0, a1: z - 1, line: x, side })
          a0 = -1
        }
      }
    }
  }
  return out
}

// Up to n spurs (side concourses, tug roads, lanes): from a circulation cell
// (`from` filters the origin and direction) straight into free land, `width`
// cells wide, stopping where the cells ahead are not free or other
// circulation comes within `gap` cells to the side; at least `minLen` long.
// A spur never reaches other circulation, so it ends blind (the comb).
function spurs(T, g, plan, cy, rnd, n, { width = [2, 2], gap = [5, 8], minLen = 6, kind = CELL_CORRIDOR, from = null, mask = null }) {
  const cands = []
  const offer = (x, z) => {
    for (let k = 0; k < 4; k++) {
      const [dx, dz] = DIRS4[k]
      if (from && !from(x, z, dx, dz)) continue
      if (g.get(x + dx, z + dz) === FREE && g.get(x + 2 * dx, z + 2 * dz) === FREE) cands.push([x, z, k])
    }
  }
  for (let z = 1; z < LAST_Z; z++) for (let x = 1; x < LAST_X; x++) if (g.get(x, z) === CIRC) offer(x, z)
  let placed = 0
  while (placed < n && cands.length) {
    const i = rnd.int(0, cands.length - 1)
    const [ox, oz, k] = cands[i]
    cands[i] = cands[cands.length - 1]
    cands.pop()
    const [dx, dz] = DIRS4[k]
    const px = -dz
    const pz = dx
    const wd = rnd.int(width[0], width[1])
    // The lanes sit on the origin's row and the next wd−1 rows to one side,
    // all of them on circulation at the origin.
    const shift = rnd.chance(0.5) ? 0 : -(wd - 1)
    const lanes = []
    for (let l = shift; l < shift + wd; l++) lanes.push(l)
    if (!lanes.every((l) => g.get(ox + px * l, oz + pz * l) === CIRC)) continue
    const lo = lanes[0]
    const hi = lanes[lanes.length - 1]
    const clear = rnd.int(gap[0], gap[1])
    const cells = []
    for (let s = 1; ; s++) {
      const row = lanes.map((l) => [ox + dx * s + px * l, oz + dz * s + pz * l])
      if (!row.every(([x, z]) => g.get(x, z) === FREE && x > 0 && z > 0 && x < LAST_X && z < LAST_Z)) break
      // Never run up to circulation ahead (two cells' margin: a blind end).
      const [hx, hz] = [ox + dx * (s + 2), oz + dz * (s + 2)]
      if (g.get(hx, hz) === CIRC) break
      let near = false
      for (const sgn of [-1, 1]) {
        const edge = sgn > 0 ? hi : lo
        for (let d = 1; d <= clear && !near; d++) {
          const c = g.get(ox + dx * s + px * (edge + sgn * d), oz + dz * s + pz * (edge + sgn * d))
          if (c === CIRC || c === RESV) near = true
          if (c === ROOM || c === BLOCK || c === BUF) break
        }
      }
      if (near) break
      cells.push(...row)
    }
    const len = cells.length / lanes.length
    if (len < minLen) continue
    const keep = rnd.chance(0.25) ? rnd.int(minLen, len) : len
    const kept = cells.slice(0, keep * lanes.length)
    for (const [x, z] of kept) {
      plan.open(x, z, kind)
      g.set(x, z, CIRC)
      if (mask) mask[z * TILE_CELLS_X + x] = 1
    }
    for (let s = 2; s <= keep; s += 4) plan.lamp(ox + dx * s + px * lo, oz + dz * s + pz * lo, true)
    placed++
  }
  return placed
}

// Line the catalogue up along every (masked) segment, in dice order.
function frontage(T, g, plan, cy, rnd, kinds, opts = {}) {
  const segs = segmentsOf(g, opts.mask ?? null)
  rnd.shuffle(segs)
  let n = 0
  for (const seg of segs) n += lineUp(T, g, plan, cy, seg, rnd, kinds, opts)
  return n
}

// The apron: free cells within 2..4 of a pier's glass stay mass (BUF), so
// the holdrooms look out over something.
function apron(T, p) {
  const m = T.dice(0xa9 + p.i).int(1, 3)
  const [z0, z1] = pierRows(p, p.root, p.len - 1 + m)
  for (let z = z0; z <= z1; z++) {
    for (let x = p.x0 - m; x <= p.x0 + p.w - 1 + m; x++) if (T.gDep.get(x, z) === FREE) T.gDep.set(x, z, BUF)
  }
}

// --- glass ---------------------------------------------------------------------------

// The chunks (tile-local cx, cz) whose plan is all mass: they may export as
// whole-solid chunks, which draw no posts (§9.6a).
function solidChunksOf(g) {
  const out = new Set()
  for (let cz = 0; cz < TILE_CELLS_Z / CHUNK; cz++) {
    for (let cx = 0; cx < TILE_CELLS_X / CHUNK; cx++) {
      let solid = true
      for (let z = cz * CHUNK; z < cz * CHUNK + CHUNK && solid; z++) {
        for (let x = cx * CHUNK; x < cx * CHUNK + CHUNK && solid; x++) {
          const c = g.get(x, z)
          if (c === CIRC || c === ROOM || c === RESV) solid = false
        }
      }
      if (solid) out.add(`${cx},${cz}`)
    }
  }
  return out
}

// A window on edge (axis, line, along) is safe when, from each walkable side,
// the straight line through it crosses a walkable cell, or 4 mass cells,
// before leaving the tile or entering a chunk that may be whole solid.
function glassOk(g, solid, { axis, line, along, outer = false }) {
  const a = axis === 'v' ? [line - 1, along] : [along, line - 1]
  const b = axis === 'v' ? [line, along] : [along, line]
  const walk = (c) => c === CIRC || c === ROOM || c === RESV
  const look = (from, dx, dz) => {
    let x = from[0]
    let z = from[1]
    for (let n = 0; n < 4; n++) {
      if (!g.in(x, z) || x === 0 || x === LAST_X) return false
      if (solid.has(`${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`)) return false
      if (walk(g.get(x, z))) return true
      x += dx
      z += dz
    }
    return true
  }
  const [dx, dz] = axis === 'v' ? [1, 0] : [0, 1]
  const wa = walk(g.get(...a))
  const wb = walk(g.get(...b))
  if (!wa && !wb) return false
  // An outer wall's glass looks onto the apron, never into another room.
  if (outer && wa && wb) return false
  if (wa && !look(b, dx, dz)) return false
  if (wb && !look(a, -dx, -dz)) return false
  return true
}

// --- baggage ---------------------------------------------------------------------------

function baggage(T) {
  const { L, bag, gBag } = T
  const B = L.bag
  const rnd = T.dice(0xba6)
  for (let i = 0; i < TILE_CELLS_X; i++) {
    gBag.set(i, 0, BLOCK)
    gBag.set(i, LAST_Z, BLOCK)
    gBag.set(0, i, BLOCK)
    gBag.set(LAST_X, i, BLOCK)
  }
  for (const p of L.piers) gBag.rect(p.core.rect, RESV)
  // The service tunnel: west run, jog, east run (the east column only at the
  // east port).
  const jx = B.jog
  const runs = [
    R(0, B.pw, jx + 1, B.pw + 1),
    R(jx, Math.min(B.pw, B.pe), jx + 1, Math.max(B.pw, B.pe) + 1),
    R(jx, B.pe, LAST_X - 1, B.pe + 1),
  ]
  for (const r of runs) {
    bag.rect(r, CELL_CORRIDOR)
    gBag.rect(r, CIRC)
  }
  for (let z = B.pe; z <= B.pe + 1; z++) {
    bag.open(LAST_X, z, CELL_CORRIDOR)
    gBag.set(LAST_X, z, CIRC)
  }
  for (let x = 2; x <= LAST_X - 2; x += 4) bag.lamp(x, x <= jx ? B.pw : B.pe, rnd.int(0, 5) !== 0)
  // The baggage halls on their runs (the tunnel's rows cross them as open
  // floor), the arrivals door off the reclaim hall.
  const tzOf = (west) => (west ? B.pw : B.pe)
  const halls = [B.hall]
  reclaimHall(T, B.hall, tzOf(B.host === 'W'), rnd)
  if (B.hall2) {
    halls.push(B.hall2.r)
    if (B.hall2.kind === 'reclaim') reclaimHall(T, B.hall2.r, tzOf(B.host !== 'W'), rnd)
    else greetingHall(T, B.hall2.r, tzOf(B.host !== 'W'), rnd)
  }
  const a = B.arrivals
  bag.room(R(a.gx, a.gz, a.gx, a.gz), {
    spaceId: T.spaceId++, role: SPACE_ROLE_STORAGE, doors: [{ axis: 'h', gx: a.gx, gz: a.side === 'N' ? a.gz + 1 : a.gz, passage: PASSAGE_WIDE }],
  })
  gBag.set(a.gx, a.gz, ROOM)
  bag.lamp(a.gx, a.gz, true, GATE_TINT)
  tugRoads(T, rnd, runs)
  // Each pier's stair door, routed to the tunnel (or the hall).
  for (const p of L.piers) {
    const d = { x: p.core.side === 'W' ? p.core.door.line : p.core.door.line - 1, z: p.core.door.gz }
    const path = route(gBag, d, rnd)
    if (!path) continue
    for (const [x, z] of path) {
      bag.open(x, z, CELL_CORRIDOR)
      gBag.set(x, z, CIRC)
    }
    bag.lamp(d.x, d.z, true)
  }
  // Blind belt tunnels off the runs: dead ends.
  const belts = rnd.int(1, 3)
  for (let i = 0; i < belts; i++) {
    const run = rnd.chance(0.5) ? runs[0] : runs[2]
    if (run.x1 - run.x0 < 6) continue
    const x = rnd.int(run.x0 + 2, run.x1 - 3)
    const dz = rnd.chance(0.5) ? -1 : 1
    const z0 = dz < 0 ? run.z0 - 1 : run.z1 + 1
    const len = rnd.int(4, 12)
    const cells = []
    for (let k = 0; k < len; k++) {
      const z = z0 + dz * k
      if (gBag.get(x, z) !== FREE || gBag.get(x + 1, z) !== FREE || gBag.get(x, z + dz) === BLOCK) break
      cells.push([x, z], [x + 1, z])
    }
    if (cells.length < 6) continue
    for (const [cx, cz] of cells) {
      bag.open(cx, cz, CELL_CORRIDOR)
      gBag.set(cx, cz, CIRC)
    }
    bag.lamp(x, cells[cells.length - 1][1], false)
  }
  // Blind tug spurs (2..3 wide) off the lattice, then the
  // service modules along everything (one tile in two has the
  // inter-terminal train platform).
  spurs(T, gBag, bag, BAG, rnd, rnd.int(1, 3), { width: [2, 3], gap: [4, 8], minLen: 6 })
  // The halls' walls first: the arrivals units (baggage services, lost
  // luggage, car hire, restrooms, a café); then back-of-house along the rest.
  const mask = new Uint8Array(TILE_CELLS_X * TILE_CELLS_Z)
  for (const h of halls) for (let z = h.z0; z <= h.z1; z++) for (let x = h.x0; x <= h.x1; x++) mask[z * TILE_CELLS_X + x] = 1
  frontage(T, gBag, bag, BAG, rnd, ARR_FRONT, { mask })
  frontage(T, gBag, bag, BAG, rnd, BAG_SERVICE, { once: { mod: BAG_PLATFORM, left: rnd.chance(0.5) ? 1 : 0, p: 0.25 } })
}

// A reclaim hall (doc §4.2, §6): the tunnel's rows cross it 2..4 rows in
// from one long wall; the deep floor beyond holds 2..4 carousels side by
// side, each 2..3 wide and as long as the floor allows (6..10), running
// back from the tunnel with a belt board at its head and aisles round it;
// beam seats along the far wall; the shallow side keeps a few seats and
// planters along its wall. High lamps on a grid.
function reclaimHall(T, h, tz, rnd) {
  const { bag, gBag } = T
  bag.rect(h, CELL_OPEN)
  gBag.rect(h, CIRC)
  const north = tz - h.z0 >= h.z1 - (tz + 1)
  // The deep side: rows from the tunnel outward (k = 0 next to the tunnel).
  const D = north ? tz - h.z0 : h.z1 - (tz + 1)
  const row = (k) => (north ? tz - 1 - k : tz + 2 + k)
  const away = north ? FACING.N : FACING.S
  const toward = north ? FACING.S : FACING.N
  const W = h.x1 - h.x0 + 1
  const cw = rnd.int(2, 3)
  const gap = rnd.int(3, 5)
  let n = Math.min(4, Math.floor((W - 4 + gap) / (cw + gap)))
  if (n < 2) n = Math.max(1, Math.floor((W - 2) / (cw + 2)))
  const len = Math.max(4, Math.min(10, D - 4))
  const k0 = 1 + Math.max(0, (D - 4 - len) >> 1)
  const span = n * cw + (n - 1) * gap
  const x0 = h.x0 + ((W - span) >> 1)
  for (let i = 0; i < n; i++) {
    const cx = x0 + i * (cw + gap)
    for (let k = k0; k < k0 + len; k++) {
      for (let u = 0; u < cw; u++) T.put(BAG, cx + u, row(k), FURN_COUNTER, { facing: u === 0 ? FACING.W : u === cw - 1 ? FACING.E : toward })
    }
    // The belt board at the carousel's head, facing the tunnel.
    T.put(BAG, cx + (cw >> 1), row(k0 - 1), PROP_FIDS, { facing: toward })
    bag.lamp(cx + (cw >> 1), row(k0 + (len >> 1)), rnd.chance(0.7))
  }
  // Seats along the far wall, facing the belts, in runs.
  const far = row(D - 1)
  for (let x = h.x0 + 1; x <= h.x1 - 1; x++) if ((x - h.x0) % 6 !== 0) T.put(BAG, x, far, PROP_BEAM_SEAT, { facing: toward })
  // The shallow side: seats in short runs against its wall, planters.
  const S = north ? h.z1 - (tz + 1) : tz - h.z0
  if (S >= 2) {
    const wallRow = north ? h.z1 : h.z0
    for (let x = h.x0 + 2; x <= h.x1 - 2; x++) {
      const k = (x - h.x0) % 7
      if (k === 0) T.put(BAG, x, wallRow, FURN_PLANT, { facing: away })
      else if (k < 4) T.put(BAG, x, wallRow, PROP_BEAM_SEAT, { facing: away })
    }
  }
  for (let x = h.x0 + 2; x <= h.x1 - 2; x += 5) {
    bag.lamp(x, row(Math.min(D - 2, k0 + len)), rnd.chance(0.6))
    bag.lamp(x, north ? tz + 1 : tz, rnd.chance(0.5))
  }
}

// The arrivals greeting hall: where the doors from the reclaim side open;
// rows of beam seats facing the tunnel's crossing (the doors), a board bank
// in the middle, a kiosk counter along the far wall, planters.
function greetingHall(T, h, tz, rnd) {
  const { bag, gBag } = T
  bag.rect(h, CELL_OPEN)
  gBag.rect(h, CIRC)
  const north = tz - h.z0 >= h.z1 - (tz + 1)
  const D = north ? tz - h.z0 : h.z1 - (tz + 1)
  const row = (k) => (north ? tz - 1 - k : tz + 2 + k)
  const toward = north ? FACING.S : FACING.N
  const centre = (h.x0 + h.x1) >> 1
  for (let k = 2; k <= D - 3; k++) {
    if ((k - 2) % 3 === 2) continue
    for (let x = h.x0 + 2; x <= h.x1 - 2; x++) if (Math.abs(x - centre) > 1) T.put(BAG, x, row(k), PROP_BEAM_SEAT, { facing: toward })
  }
  T.put(BAG, centre, row(1), PROP_FIDS, { facing: toward })
  for (let x = h.x0 + 2; x <= h.x1 - 2; x++) {
    const far = row(D - 1)
    if ((x - h.x0) % 5 === 0) T.put(BAG, x, far, FURN_PLANT, { facing: toward })
    else if (Math.abs(x - centre) <= 3) T.put(BAG, x, far, FURN_COUNTER, { facing: toward })
  }
  for (let x = h.x0 + 2; x <= h.x1 - 2; x += 5) for (let k = 1; k < D; k += 5) bag.lamp(x, row(k), rnd.chance(0.65), LOUNGE_TINT)
}

// The tug roads: 3..5 north–south service roads (2..3 wide) across the
// tunnel, each arm running out toward rows 2..10 / 45..53 until a stair
// core, the vestibule or the bounds stops it, then east–west links between
// neighbouring arms in the outer bands. The service level's lattice: its
// loops are the only ones the doc allows (§4.1, through the lower level),
// and its blocks are what the halls fill.
function tugRoads(T, rnd, runs) {
  const { gBag, bag, L } = T
  const B = L.bag
  const n = rnd.int(2, 4)
  const roads = []
  for (let tries = 0; tries < 40 && roads.length < n; tries++) {
    const x = rnd.int(3, LAST_X - 5)
    const w = rnd.int(2, 3)
    if (roads.some((o) => x <= o.x + o.w + 7 && o.x <= x + w + 7)) continue
    roads.push({ x, w })
  }
  roads.sort((a, b) => a.x - b.x)
  const can = (x, z) => {
    const v = gBag.get(x, z)
    return (v === FREE || v === CIRC) && z >= 2 && z <= LAST_Z - 2
  }
  const lay = (x, z) => {
    if (gBag.get(x, z) !== FREE) return
    bag.open(x, z, CELL_CORRIDOR)
    gBag.set(x, z, CIRC)
  }
  const rowsOf = (r) => {
    const all = []
    for (let i = 0; i < r.w; i++) all.push(r.x + i)
    return all
  }
  for (const r of roads) {
    const tz = r.x + r.w - 1 <= B.jog ? runs[0].z0 : r.x > B.jog + 1 ? runs[2].z0 : null
    if (tz === null) continue
    const xs = rowsOf(r)
    const zA = rnd.int(2, 6)
    const zB = rnd.int(49, LAST_Z - 2)
    r.n = tz
    for (let z = tz - 1; z >= zA && xs.every((x) => can(x, z)); z--) {
      for (const x of xs) lay(x, z)
      r.n = z
    }
    r.s = tz + 1
    for (let z = tz + 2; z <= zB && xs.every((x) => can(x, z)); z++) {
      for (const x of xs) lay(x, z)
      r.s = z
    }
    for (let z = r.n + 1; z <= r.s - 1; z += 4) bag.lamp(r.x, z, rnd.int(0, 5) !== 0)
  }
  // Links: a 2-row road between neighbouring arms, in the north or south band.
  for (let i = 0; i + 1 < roads.length; i++) {
    const a = roads[i]
    const b = roads[i + 1]
    if (a.n === undefined || b.n === undefined) continue
    for (const band of ['N', 'S']) {
      if (!rnd.chance(0.45)) continue
      // Out in the band, toward the arms' far ends (the outer service road).
      const far = band === 'N' ? Math.max(a.n, b.n) : Math.min(a.s, b.s) - 1
      const lo = band === 'N' ? far : Math.max(Math.max(B.pw, B.pe) + 4, far - 8)
      const hi = band === 'N' ? Math.min(Math.min(B.pw, B.pe) - 4, far + 8) : far
      if (hi < lo) continue
      const z = rnd.int(lo, hi)
      let ok = true
      for (let x = a.x + a.w; x < b.x && ok; x++) if (!can(x, z) || !can(x, z + 1)) ok = false
      if (!ok) continue
      for (let x = a.x + a.w; x < b.x; x++) {
        lay(x, z)
        lay(x, z + 1)
      }
      for (let x = a.x + a.w + 1; x < b.x; x += 4) bag.lamp(x, z, true)
    }
  }
}

// Route a corridor from stair-door cell d to the nearest circulation cell:
// Dijkstra over free cells, a turn costs 4, cells next to another stair core
// cost 6. Returns the path's free cells (d first), or null.
function route(g, d, rnd) {
  const W = TILE_CELLS_X
  const N = W * TILE_CELLS_Z
  const INF = 1 << 30
  const cost = new Int32Array(N * 4).fill(INF)
  const prev = new Int32Array(N * 4).fill(-1)
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  const nearCore = (x, z) => DIRS.some(([dx, dz]) => g.get(x + dx, z + dz) === RESV)
  const start = d.z * W + d.x
  if (g.get(d.x, d.z) === CIRC) return []
  if (g.get(d.x, d.z) !== FREE) return null
  // A small binary heap of [cost, state].
  const heap = []
  const push = (c, st) => {
    heap.push([c, st])
    let i = heap.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (heap[p][0] <= heap[i][0]) break
      ;[heap[p], heap[i]] = [heap[i], heap[p]]
      i = p
    }
  }
  const pop = () => {
    const top = heap[0]
    const last = heap.pop()
    if (heap.length) {
      heap[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r
        if (m === i) break
        ;[heap[m], heap[i]] = [heap[i], heap[m]]
        i = m
      }
    }
    return top
  }
  const bias = rnd.int(0, 3)
  for (let k = 0; k < 4; k++) {
    cost[start * 4 + k] = 0
    push(0, start * 4 + k)
  }
  let goal = -1
  while (heap.length) {
    const [c, st] = pop()
    if (c > cost[st]) continue
    const cell = st >> 2
    const dir = st & 3
    const x = cell % W
    const z = (cell / W) | 0
    if (g.get(x, z) === CIRC) {
      goal = st
      break
    }
    for (let k0 = 0; k0 < 4; k0++) {
      const k = (k0 + bias) & 3
      const nx = x + DIRS[k][0]
      const nz = z + DIRS[k][1]
      const v = g.get(nx, nz)
      if (v !== FREE && v !== CIRC) continue
      if (nx < 1 || nz < 1 || nx > LAST_X - 1 || nz > LAST_Z - 1) continue
      const nc = c + 1 + (k === dir || cell === start ? 0 : 4) + (v === FREE && nearCore(nx, nz) ? 6 : 0)
      const ns = (nz * W + nx) * 4 + k
      if (nc < cost[ns]) {
        cost[ns] = nc
        prev[ns] = st
        push(nc, ns)
      }
    }
  }
  if (goal < 0) return null
  const path = []
  for (let st = prev[goal]; st >= 0; st = prev[st]) {
    const cell = st >> 2
    path.push([cell % W, (cell / W) | 0])
    if (cell === start) break
  }
  return path.reverse()
}

// --- mezzanine -----------------------------------------------------------------------

function mezzanine(T) {
  const { L, mez, gMez, gDep } = T
  const s = L.spine
  const rnd = T.dice(0x3e2)
  // The mezzanine stands only over the departures floor (doc §4.1: lounges
  // and food courts overlooking the spine): over the concourse, the halls
  // and units along it, the piers and the satellites; never over the apron,
  // a jet bridge or a stair core. Everything else on this storey is mass.
  for (let z = 0; z < TILE_CELLS_Z; z++) {
    for (let x = 0; x < TILE_CELLS_X; x++) {
      const c = gDep.get(x, z)
      const over = (c === CIRC || c === ROOM) && !T.tubes.has(z * TILE_CELLS_X + x)
      gMez.set(x, z, over ? FREE : BUF)
    }
  }
  for (let i = 0; i < TILE_CELLS_X; i++) {
    gMez.set(i, 0, BLOCK)
    gMez.set(i, LAST_Z, BLOCK)
    gMez.set(0, i, BLOCK)
    gMez.set(LAST_X, i, BLOCK)
  }
  gMez.rect(L.mezCore.rect, RESV)
  // The gallery: a walkway along the spine (its rows cover both seams'
  // ports; 3..7 rows), opening out to the spine's full width round each
  // atrium's void (the stamp carves its box). The rest of the spine's rows,
  // and the halls below beyond them, take the lounges and food courts
  // (frontage below), glazed onto the walkway: the overlook.
  const qw = L.ports.mez
  const qe = L.ports.mezE
  let wz0 = Math.min(qw.a0, qe.a0)
  let wz1 = Math.max(qw.a1, qe.a1)
  const want = rnd.int(3, 4)
  while (wz1 - wz0 + 1 < want) {
    if ((rnd.chance(0.5) || wz1 >= s.z1) && wz0 > s.z0) wz0--
    else wz1++
  }
  const walk = R(0, wz0, LAST_X - 1, wz1)
  mez.rect(walk, CELL_LOBBY)
  gMez.rect(walk, CIRC)
  for (const a of L.atria) {
    mez.rect(a.box, CELL_LOBBY)
    gMez.rect(a.box, CIRC)
  }
  for (let z = qe.a0; z <= qe.a1; z++) {
    mez.open(LAST_X, z, CELL_LOBBY)
    gMez.set(LAST_X, z, CIRC)
  }
  // The mezzanine stair's door: on the spine's edge row; a short corridor
  // to the walkway when units would stand between.
  const mc = L.mezCore
  const dz = mc.side === 'N' ? s.z0 : s.z1
  const [c0, c1] = mc.side === 'N' ? [dz, wz0 - 1] : [wz1 + 1, dz]
  for (let z = c0; z <= c1; z++) {
    if (gMez.get(mc.door.gx, z) === CIRC) continue
    mez.open(mc.door.gx, z, CELL_CORRIDOR)
    gMez.set(mc.door.gx, z, CIRC)
  }
  mez.lamp(mc.door.gx, dz, true, LOUNGE_TINT)
  const inBox = (x) => L.atria.some(({ box }) => x >= box.x0 - 1 && x <= box.x1 + 1)
  // Walkway lamps: a row of pendants, a circuit in three dark.
  const circuit = (x) => hashChain(L.vs ^ 0x3e7, x >> 3) % 3 !== 0
  const lampZ = (wz0 + wz1) >> 1
  for (let x = 2; x <= LAST_X - 2; x += 4) if (!inBox(x)) mez.lamp(x, lampZ, circuit(x), LOUNGE_TINT)
  for (const { box } of L.atria) {
    for (let x = box.x0 + 1; x <= box.x1 - 1; x += 4) {
      mez.lamp(x, box.z0, circuit(x), LOUNGE_TINT)
      mez.lamp(x + 2, box.z1, circuit(x + 2), LOUNGE_TINT)
    }
  }
  // A wide walkway's middle: benches and planters in short islands, a
  // board at each island's end.
  if (wz1 - wz0 + 1 >= 4) {
    const midZ = (wz0 + wz1) >> 1
    const isl = rnd.int(3, 5)
    const step = isl + rnd.int(4, 7)
    const phase = rnd.int(0, step - 1)
    for (let x = 3; x <= LAST_X - 4; x++) {
      const k = (x + phase) % step
      if (k >= isl || inBox(x - 1) || inBox(x + 1)) continue
      const kind = k === 0 ? PROP_FIDS : k === isl - 1 ? FURN_PLANT : PROP_BEAM_SEAT
      T.put(MEZ, x, midZ, kind, { facing: kind === PROP_FIDS ? FACING.W : x % 2 ? FACING.N : FACING.S })
    }
  }
  T.windows = []
  const heads = [] // the wings' lounges (pier heads, satellites), for the sky bridges
  // Over each pier: the upper pier, a glazed corridor down its middle from
  // the gallery to a lounge over the pier head (a dead end like the pier
  // below it); the corridor's sides (over the holdrooms) take lounges.
  for (const p of L.piers) {
    const tip = T.tips.get(p.i)
    // The arrivals corridor: two cells wide, over one side of the concourse.
    const cx0 = p.conc.x0 + (rnd.chance(0.5) ? 1 : 2)
    if (tip && mezWing(T, tip, cx0, cx0 + 1, p.sgn, rnd)) heads.push({ r: tip, north: p.sgn < 0 })
  }
  // Over each satellite, its upper lounge, the same way over its walkway.
  for (const st of T.sats) if (mezWing(T, st.r, st.lx, st.lx + 1, st.north ? -1 : 1, rnd)) heads.push({ r: st.r, north: st.north })
  // The frontage: lounges, food balconies, observation decks and units over
  // the halls below, off the gallery and the corridors, glazed fronts onto
  // the gallery (the overlook) and glass onto the apron.
  const mask = new Uint8Array(TILE_CELLS_X * TILE_CELLS_Z)
  for (let z = 0; z < TILE_CELLS_Z; z++) for (let x = 0; x < TILE_CELLS_X; x++) if (gMez.get(x, z) === CIRC) mask[z * TILE_CELLS_X + x] = 1
  frontage(T, gMez, mez, MEZ, rnd, MEZ_FRONT, { glass: true, mask, exhaust: true, hall: MEZ_HALL })
  fillLeftovers(T, gMez, mez, MEZ, rnd)
  // Out in the apron rows, the halls' far ends may send a bridge too.
  const far = T.mezHalls.filter((r) => r.z1 < s.z0 - 6 || r.z0 > s.z1 + 6).map((r) => ({ r }))
  skyBridges(T, [...heads, ...far], rnd)
  upperDecks(T, rnd)
  for (const a of L.atria) joinRing(gMez, mez, a.box, rnd)
  const walledH = (x, z, nz) => {
    const c = gMez.get(x, nz)
    if (c === BUF || c === FREE || c === BLOCK) return true
    if (c !== ROOM) return false
    const e = mez.edges.get(`h:${x},${Math.max(z, nz)}`)
    return !!e && e.wall === 1
  }
  // The overlook: benches on the gallery strips facing the void (against
  // its rails), planters between them; seat runs against the walkway's
  // curtain glass.
  for (const a of L.atria) {
    for (const [z, face] of [[a.z0 - 1, FACING.S], [a.z1 + 1, FACING.N]]) {
      if (z <= a.box.z0 || z >= a.box.z1) continue
      for (let x = a.x0; x <= a.x1; x++) {
        const k = (x - a.x0) % 5
        if (k === 4) continue
        T.put(MEZ, x, z, k === 0 ? FURN_PLANT : PROP_BEAM_SEAT, { facing: face })
      }
    }
    // Planters against the gallery's back walls, between the lounges' doors.
    for (const [z, nz, wall] of [[a.box.z0, a.box.z0 - 1, 'N'], [a.box.z1, a.box.z1 + 1, 'S']]) {
      for (let x = a.box.x0 + 1; x <= a.box.x1 - 1; x += 3) if (walledH(x, z, nz)) T.put(MEZ, x, z, FURN_PLANT, { wall })
    }
  }
  // (and against the lounges' glazed fronts, between their entrances).
  for (const [z, nz, wall] of [[wz0, wz0 - 1, 'N'], [wz1, wz1 + 1, 'S']]) {
    for (let x = 2; x <= LAST_X - 3; x++) {
      if (inBox(x) || (x % 6) >= 5) continue
      if (![x - 1, x, x + 1].every((xx) => walledH(xx, z, nz))) continue
      T.put(MEZ, x, z, PROP_BEAM_SEAT, { wall })
    }
  }
  // Every edge of the gallery and the corridors still onto mass is curtain
  // glass.
  for (let z = 1; z < LAST_Z; z++) {
    for (let x = 1; x < LAST_X; x++) {
      if (gMez.get(x, z) !== CIRC) continue
      for (const [dx, dz] of DIRS4) {
        const n = gMez.get(x + dx, z + dz)
        if (n !== FREE && n !== BUF) continue
        if (dx) T.windows.push({ axis: 'v', line: Math.max(x, x + dx), along: z, outer: true })
        else T.windows.push({ axis: 'h', line: Math.max(z, z + dz), along: x, outer: true })
      }
    }
  }
  const solid = solidChunksOf(gMez)
  for (const w of T.windows) if (glassOk(gMez, solid, w)) mez.window(w.axis, ...(w.axis === 'v' ? [w.line, w.along] : [w.along, w.line]))
  T.windows = []
}

// The floor the catalogue could not fit (a strip too narrow for a unit,
// a corner behind two lounges) joins the room it touches (the first one in
// dice order; a lounge grows an annexe round the corner) or, touching only
// circulation, the circulation (an alcove); a piece of floor touching
// neither stays mass. The annexe keeps armchairs on a loose lattice.
function fillLeftovers(T, g, plan, cy, rnd) {
  const W = TILE_CELLS_X
  const seen = new Uint8Array(W * TILE_CELLS_Z)
  for (let z0 = 1; z0 < LAST_Z; z0++) {
    for (let x0 = 1; x0 < LAST_X; x0++) {
      if (seen[z0 * W + x0] || g.get(x0, z0) !== FREE) continue
      const comp = []
      const stack = [[x0, z0]]
      seen[z0 * W + x0] = 1
      while (stack.length) {
        const [x, z] = stack.pop()
        comp.push([x, z])
        for (const [dx, dz] of DIRS4) {
          const nx = x + dx
          const nz = z + dz
          if (!g.in(nx, nz) || seen[nz * W + nx] || g.get(nx, nz) !== FREE) continue
          seen[nz * W + nx] = 1
          stack.push([nx, nz])
        }
      }
      const rooms = []
      let circ = false
      for (const [x, z] of comp) {
        for (const [dx, dz] of DIRS4) {
          const v = g.get(x + dx, z + dz)
          if (v === CIRC) circ = true
          if (v !== ROOM) continue
          const c = plan.cells.get(`${x + dx},${z + dz}`)
          if (c && c.kind === CELL_ROOM && c.spaceId && !rooms.some((r) => r.spaceId === c.spaceId)) rooms.push(c)
        }
      }
      if (!rooms.length && !circ) continue
      const host = rooms.length ? rooms[rnd.int(0, rooms.length - 1)] : null
      const inComp = new Set(comp.map(([x, z]) => `${x},${z}`))
      for (const [x, z] of comp) {
        if (host) plan.open(x, z, CELL_ROOM, host.spaceId, host.role)
        else plan.open(x, z, CELL_LOBBY)
        g.set(x, z, host ? ROOM : CIRC)
      }
      for (const [x, z] of comp) {
        for (const [dx, dz] of DIRS4) {
          const nx = x + dx
          const nz = z + dz
          if (inComp.has(`${nx},${nz}`) || !plan.has(nx, nz)) continue
          const key = dx ? `v:${Math.max(x, nx)},${z}` : `h:${x},${Math.max(z, nz)}`
          const n = plan.cells.get(`${nx},${nz}`)
          const same = host ? n.kind === CELL_ROOM && n.spaceId === host.spaceId : g.get(nx, nz) === CIRC
          if (same) plan.edges.delete(key)
          else if (!plan.edges.has(key)) plan.edges.set(key, { wall: 1, passage: PASSAGE_WALL, feature: WALL_PLAIN })
        }
      }
      if (!host) continue
      for (const [x, z] of comp) if (x % 3 === 1 && z % 2 === 1) T.put(cy, x, z, (x + z) % 3 ? FURN_ARMCHAIR : FURN_PLANT, { facing: FACING.S })
    }
  }
}

// Sky bridges (doc §4.1: the comb's only loops run through the upper and
// lower levels): from a wing's lounge (a pier head, a satellite) a glazed
// walkway two cells wide straight out across the apron, east or west, to
// the next mezzanine floor on those rows (another wing's lounge, a lounge
// over a hall), where nothing but apron lies between (one cell of apron
// either side, so the bridge stands free).
function skyBridges(T, heads, rnd) {
  const { mez, gMez } = T
  const mass = (x, z) => {
    const c = gMez.get(x, z)
    return c === BUF || c === FREE || c === BLOCK
  }
  const floor = (x, z) => {
    const c = gMez.get(x, z)
    return c === CIRC || c === ROOM
  }
  const done = new Set() // 'head:dir' already bridged from the other end
  for (const [hi, h] of heads.entries()) {
    const A = h.r
    for (const dir of rnd.chance(0.5) ? [-1, 1] : [1, -1]) {
      if (!rnd.chance(0.7) || done.has(`${hi}:${dir}`)) continue
      const rows = []
      for (let z = A.z0 + 1; z + 1 <= A.z1 - 1; z++) rows.push(z)
      rnd.shuffle(rows)
      for (const z of rows) {
        const x0 = dir > 0 ? A.x1 + 1 : A.x0 - 1
        let x = x0
        let ok = true
        while (x >= 1 && x <= LAST_X - 1 && mass(x, z) && mass(x, z + 1)) {
          if (!mass(x, z - 1) || !mass(x, z + 2)) {
            ok = false
            break
          }
          x += dir
        }
        const len = Math.abs(x - x0)
        if (!ok || len < 3 || len > 30 || !floor(x, z) || !floor(x, z + 1)) continue
        for (let k = 0; k < len; k++) {
          const bx = x0 + dir * k
          for (const zz of [z, z + 1]) {
            mez.open(bx, zz, CELL_CORRIDOR)
            gMez.set(bx, zz, CIRC)
          }
          // Walled flanks (glazed where the sight line allows, below).
          mez.edge('h', bx, z, 1, PASSAGE_WALL)
          mez.edge('h', bx, z + 2, 1, PASSAGE_WALL)
          T.windows.push({ axis: 'h', line: z, along: bx, outer: true }, { axis: 'h', line: z + 2, along: bx, outer: true })
          if (k % 5 === 2) mez.lamp(bx, z, rnd.chance(0.6))
        }
        // The far end opens into the floor it meets (a door pair).
        const line = dir > 0 ? x : x + 1
        for (const zz of [z, z + 1]) mez.edge('v', line, zz, 0, PASSAGE_WIDE)
        const hit = heads.find((o) => x >= o.r.x0 && x <= o.r.x1 && z >= o.r.z0 && z <= o.r.z1)
        if (hit) done.add(`${heads.indexOf(hit)}:${-dir}`)
        break
      }
    }
  }
}

// A wing of the mezzanine over a pier or a satellite: a glazed corridor
// (`x0..x1`, straight toward the spine from the near edge of `head`) until
// it meets the gallery, and the lounge `head` at its end (glazed all round
// but where the corridor enters). `sgn` −1: the wing runs north. Only over
// free (departures) floor.
function mezWing(T, head, x0, x1, sgn, rnd) {
  const { mez, gMez } = T
  const near = sgn < 0 ? head.z1 + 1 : head.z0 - 1
  const cells = []
  let joined = false
  for (let z = near; z >= 1 && z <= LAST_Z - 1; z -= sgn) {
    const row = []
    for (let x = x0; x <= x1; x++) row.push(gMez.get(x, z))
    if (row.some((c) => c === CIRC)) {
      joined = row.every((c) => c === CIRC || c === FREE)
      break
    }
    if (row.some((c) => c !== FREE)) break
    cells.push(z)
  }
  if (!joined || !gMez.all(head, (c) => c === FREE)) return false
  for (const z of cells) {
    for (let x = x0; x <= x1; x++) {
      mez.open(x, z, CELL_CORRIDOR)
      gMez.set(x, z, CIRC)
    }
  }
  for (let i = 1; i < cells.length; i += 4) mez.lamp(x0 + ((x1 - x0) >> 1), cells[i], rnd.int(0, 2) !== 0)
  // Benches down one side of the corridor, a gap every fourth cell.
  {
    const bx = rnd.chance(0.5) ? x0 : x1
    for (let i = 1; i < cells.length - 1; i++) if (i % 4 !== 0) T.put(MEZ, bx, cells[i], PROP_BEAM_SEAT, { wall: bx === x0 ? 'W' : 'E' })
  }
  // The lounge: armchairs in pairs round low tables, facing the far glass.
  mez.rect(head, CELL_ROOM, T.spaceId++, SPACE_ROLE_LOUNGE)
  gMez.rect(head, ROOM)
  const farLine = sgn < 0 ? head.z0 : head.z1 + 1
  const nearLine = sgn < 0 ? head.z1 + 1 : head.z0
  for (let z = head.z0; z <= head.z1; z++) T.windows.push({ axis: 'v', line: head.x0, along: z, outer: true }, { axis: 'v', line: head.x1 + 1, along: z, outer: true })
  for (let x = head.x0; x <= head.x1; x++) {
    T.windows.push({ axis: 'h', line: farLine, along: x, outer: true })
    if (x < x0 || x > x1) T.windows.push({ axis: 'h', line: nearLine, along: x, outer: true })
  }
  const face = sgn < 0 ? FACING.N : FACING.S
  const D = head.z1 - head.z0 + 1
  const farRow = sgn < 0 ? head.z0 : head.z1
  for (let k = 1; k <= D - 2; k += 2) {
    const z = farRow - sgn * k
    for (let x = head.x0 + 1 + (k % 4 === 3 ? 2 : 0); x + 2 <= head.x1 - 1; x += 4) {
      if (x + 2 >= x0 && x <= x1) continue
      T.put(MEZ, x, z, FURN_ARMCHAIR, { facing: face })
      T.put(MEZ, x + 1, z, FURN_TABLE, { facing: face })
      T.put(MEZ, x + 2, z, FURN_ARMCHAIR, { facing: face })
    }
  }
  T.put(MEZ, head.x0, farRow, FURN_PLANT, { wall: sgn < 0 ? 'N' : 'S' })
  T.put(MEZ, head.x1, farRow, FURN_PLANT, { wall: sgn < 0 ? 'N' : 'S' })
  for (let x = head.x0 + 2; x <= head.x1 - 2; x += 5) mez.lamp(x, (head.z0 + head.z1) >> 1, rnd.chance(0.6), LOUNGE_TINT)
  return true
}

// --- the atrium's ring box ------------------------------------------------------------

// The catalog stamp joins its ring to the fabric chunk by chunk: a chunk
// whose part of the ring box has no open edge to walkable cells outside the
// box (inside the same chunk) gets a corridor carved through the mass, after
// the plan compiled, with no walls of its own. So before the frontage, every
// such chunk gets a one-cell alcove off the box on a free side (the plan
// walls it); the frontage then lines up along it like any circulation.
function joinRing(g, plan, box, rnd) {
  for (let cz = Math.floor(box.z0 / CHUNK); cz <= Math.floor(box.z1 / CHUNK); cz++) {
    for (let cx = Math.floor(box.x0 / CHUNK); cx <= Math.floor(box.x1 / CHUNK); cx++) {
      const x0 = Math.max(box.x0, cx * CHUNK)
      const x1 = Math.min(box.x1, cx * CHUNK + CHUNK - 1)
      const z0 = Math.max(box.z0, cz * CHUNK)
      const z1 = Math.min(box.z1, cz * CHUNK + CHUNK - 1)
      const cands = []
      let joined = false
      const look = (x, z, nx, nz, axis) => {
        if (Math.floor(nx / CHUNK) !== cx || Math.floor(nz / CHUNK) !== cz) return
        const v = g.get(nx, nz)
        const key = axis === 'v' ? `v:${Math.max(x, nx)},${z}` : `h:${x},${Math.max(z, nz)}`
        const e = plan.edges.get(key)
        if ((v === CIRC || v === ROOM) && plan.has(nx, nz) && (!e || e.wall === 0)) joined = true
        else if (v === FREE) cands.push([nx, nz])
      }
      for (let z = z0; z <= z1; z++) {
        if (x0 === box.x0) look(x0, z, x0 - 1, z, 'v')
        if (x1 === box.x1) look(x1, z, x1 + 1, z, 'v')
      }
      for (let x = x0; x <= x1; x++) {
        if (z0 === box.z0) look(x, z0, x, z0 - 1, 'h')
        if (z1 === box.z1) look(x, z1, x, z1 + 1, 'h')
      }
      if (joined || !cands.length) continue
      const [nx, nz] = cands[rnd.int(0, cands.length - 1)]
      plan.open(nx, nz, CELL_CORRIDOR)
      g.set(nx, nz, CIRC)
    }
  }
}

// After the catalog stamp: the box's perimeter edges get the plan back
// (walls, doors, open joins, mass) unless the stamp protected them.
function restoreBoxEdges(map, plan, cy, b) {
  const write = (axis, gx, gz, a, c) => {
    const cx = map.cellChunk(gx)
    const cz = map.cellChunk(gz)
    const d = map.chunkAt(cx, cy, cz)
    if (!d) return
    const lx = map.cellLocal(gx)
    const lz = map.cellLocal(gz)
    if (axis === 'v' ? d._protV.has(vIdx(lx, lz)) : d._protH.has(hIdx(lx, lz))) return
    const hasA = plan.has(...a)
    const hasC = plan.has(...c)
    const e = plan.edges.get(`${axis}:${gx},${gz}`)
    let wall
    let passage
    let feature = WALL_PLAIN
    if ((hasA || hasC) && e) ({ wall, passage, feature } = e)
    else if (hasA && hasC) [wall, passage] = [0, PASSAGE_OPEN]
    else if (hasA || hasC) [wall, passage] = [1, PASSAGE_WALL]
    else [wall, passage] = [0, PASSAGE_OPEN]
    if (axis === 'v') map.setWallV(gx, cy, gz, wall, passage, feature)
    else map.setWallH(gx, cy, gz, wall, passage, feature)
    if (wall && feature !== WALL_PLAIN) d.authoredFeatures = true
  }
  for (let z = b.z0; z <= b.z1; z++) {
    write('v', b.x0, z, [b.x0 - 1, z], [b.x0, z])
    write('v', b.x1 + 1, z, [b.x1, z], [b.x1 + 1, z])
  }
  for (let x = b.x0; x <= b.x1; x++) {
    write('h', x, b.z0, [x, b.z0 - 1], [x, b.z0])
    write('h', x, b.z1 + 1, [x, b.z1], [x, b.z1 + 1])
  }
}

// After the catalog stamp: the plan's rails inside the box (the
// travelators' balustrades on the spine's floor under the void) come back,
// but never on an edge of the atrium flight's halo or one the stamp
// protected. Level 0 of the volume is a plain hall, so its slice holds no
// edge of its own there.
function restoreBoxRails(map, plan, cy, b, halo) {
  for (const [key, e] of plan.edges) {
    if (e.feature !== WALL_RAIL || !e.wall) continue
    const axis = key[0]
    const [gx, gz] = key.slice(2).split(',').map(Number)
    const inside = axis === 'v' ? gx > b.x0 && gx <= b.x1 && gz >= b.z0 && gz <= b.z1 : gx >= b.x0 && gx <= b.x1 && gz > b.z0 && gz <= b.z1
    if (!inside) continue
    const other = axis === 'v' ? `${gx - 1},${gz}` : `${gx},${gz - 1}`
    if (halo.has(`${gx},${gz}`) || halo.has(other)) continue
    const d = map.chunkAt(map.cellChunk(gx), cy, map.cellChunk(gz))
    if (!d) continue
    const lx = map.cellLocal(gx)
    const lz = map.cellLocal(gz)
    if (axis === 'v' ? d._protV.has(vIdx(lx, lz)) : d._protH.has(hIdx(lx, lz))) continue
    if (axis === 'v') map.setWallV(gx, cy, gz, 1, PASSAGE_WALL, WALL_RAIL)
    else map.setWallH(gx, cy, gz, 1, PASSAGE_WALL, WALL_RAIL)
    d.authoredFeatures = true
  }
}

// Tile mode: at most `cap` lit lamps per chunk-storey (spec §11.1 item 9).
// A chunk over the cap keeps its circulation lamps first, then the tinted
// rooms' (gates, lounges), then the rest, in dice order, and takes the
// surplus down (a dead tube
// is authored darkness: the dead circuits and piers, never the cap's).
function capLitLamps(map, vs, cap) {
  for (const d of map.chunks.values()) {
    const lit = d.lamps.filter((l) => l.lit)
    if (lit.length <= cap) continue
    const rank = (l) => hashChain(vs ^ 0x1a3, d.cy * 256 + l.lx * 16 + l.lz, d.cx * 64 + d.cz)
    const tier = (l) => (d.spaceId[cIdx(l.lx, l.lz)] === 0 ? 0 : l.tint != null ? 1 : 2)
    lit.sort((a, b) => tier(a) - tier(b) || rank(a) - rank(b) || a.lx - b.lx || a.lz - b.lz)
    const drop = new Set(lit.slice(cap))
    d.lamps = d.lamps.filter((l) => !drop.has(l))
  }
}
