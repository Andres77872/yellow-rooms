import { CHUNK } from '../../constants.js'
import { MAP_FAMILY_SUBURB } from '../ids.js'
import { FAMILY_SALT, hashChain, tileKeyAt, tileKeyOf, tileSeed } from '../../tiles/tileKey.js'

// The suburb family's pure geometry (spec §3.3, §12.6) and its STREET
// GRAMMAR. Every 5×3-chunk tile is composed here from (worldSeed, tile): no
// tile copies a template. The editor kind's finite map (prototype.js) is only
// the parts catalogue — house models, room stamping, tints — and the doc's
// rules (03-sleeping-suburb.md §4): 5-cell streets, 9×9 cul-de-sac bulbs,
// lots of lawn + house + backyard fronting every street, two-storey houses
// with a stair core to an attic.
//
// suburbPlan(worldSeed, k) composes one tile:
//   1. seam ports, hashed per seam (pure in the seam key, so both tiles of a
//      seam agree): 1-2 street crossings on every x seam (rows), 1-2
//      collector crossings on every z seam (columns);
//   2. a spine street (horizontal or vertical, at a hashed position and
//      extent): every end port joins it through an L-shaped leg with a
//      hashed jog, every side port through a straight leg that stops at the
//      first street it meets (a T junction). In ~70% of tiles the spine
//      warps (doc §4.1's "gently curving warped parallels"): a hashed
//      profile steps it ±1 row every 6-13 cells, up to ±2, straight near
//      the seams;
//   3. sometimes a second parallel street (a hashed span, the same warp, so
//      the two curve together) tied to the spine by 1-2 connectors: a loop,
//      or a lollipop;
//   4. 0-3 cul-de-sac stems off the streets (each placed by scanning every
//      spot for the free depth there, length 4-14), each ending in a 9×9
//      bulb; free spine and parallel ends get bulbs too (dead ends);
//   5. lots: 1-4 two-storey houses first (each inside one chunk, so its
//      stair core and attic chunk are exact; a hashed model of the four in
//      TWO_STOREY_DEFS, one of its ground plans and an upstairs drawn for
//      the house by upstairsVariant), then a frontage walk along
//      every street line packs model houses in Levittown groups of 2-3
//      identical, alternately mirrored houses (the tile's model set: 4-5 of
//      the 5 models), with hashed lawn and yard depths; a gap the group's
//      model cannot take gets another model of the set; the lots grow into
//      the free land behind and beside them (yards to 9 rows, side yards to
//      6), and whatever land is left is open field (a vacant lot).
// Everything is a pure function of (worldSeed, global coordinates), memoised
// per tile, so the footprint, the planner's streaming hint, the hooks and the
// tile program (tile.js) agree without baking anything.
//
// Planner-chain module (§7.5): it may import only constants.js, core/hash.js,
// core/rng.js, mapTypes.js, mapFamily.js ({deepFreeze, MAP_FAMILY_CODES}),
// structures/catalog/engine.js, families/ids.js, tiles/tileKey.js and
// tiles/stubPlanner.js. Never tiles/stub.js, the canvas or the kit.
//
// Tile-local frame: cells gx 0..69, gz 0..41 of tile (tx, tz) are global
// (tx·70 + gx, tz·42 + gz); storey 0 is the street level, storey 1 the attics.
// The seam contract (§6.8) keeps a tile's EAST and SOUTH rim (gx 69, gz 41)
// mass except at the seam ports. The WEST and NORTH rim (gx 0, gz 0) lie on
// the lines the tile owns: the lots and the open field run out onto them and
// the seam line itself is walled there (FloorPlan.compile) — the backyards'
// rear privacy fence where two tiles' yards meet — so a seam reads as one
// fence beside a one-cell strip, not a two-cell wall of mass.

export const FAMILY = MAP_FAMILY_SUBURB

// The tile (§6.2): 5×3 chunks, backend 'band', one band of two storeys
// (0 street level, 1 attics). Salt = FAMILY_SALT.suburb (0x5a170000 + 10).
export const TILE = Object.freeze({ w: 5, d: 3, backend: 'band', H: 2, lo: 0, hi: 1, salt: FAMILY_SALT.suburb })
export const TILE_W = TILE.w * CHUNK // 70 cells
export const TILE_D = TILE.d * CHUNK // 42 cells
export const GROUND = 0
export const ATTIC = 1

export const STREET_W = 5 // doc §4.2: 5-cell right-of-way
export const BULB = 9 // doc §4.2: a 9×9 rounded plate
const STEM_CLEAR = 6 // a cul-de-sac stem's clearance along: one lot (the narrowest is 6 + a driveway)
const INNER = Object.freeze({ x0: 1, z0: 1, x1: TILE_W - 2, z1: TILE_D - 2 }) // the streets' land
const LOT_LAND = Object.freeze({ x0: 0, z0: 0, x1: TILE_W - 2, z1: TILE_D - 2 }) // the lots' and the field's land

// --- the house catalogue (shared with prototype.js, the kind) ----------------------

// House models in their own frame: row 0 is the street front, 'h' the hall
// (front door on its first front-row cell, back door on its first back-row
// cell), letters are rooms. `cycles` name room pairs that get a second,
// connecting door once furnished (prototype.js parses them).
export const MODEL_DEFS = Object.freeze([
  { name: 'ranch', rows: ['LLhKKDD', 'LLhKKDD', 'LLhhhhh', 'BBhRRUU', 'BBhRRUU'], cycles: ['KD', 'RU'] },
  { name: 'long hall', rows: ['LLLhKKKK', 'LLLhKKKK', 'LLLhhhhh', 'BBhhRRDD', 'BBhhRRDD'], cycles: ['RD', 'BL'] },
  { name: 'wide living', rows: ['LLLLhRRR', 'LLLLhRRR', 'KKKhhhhh', 'KKKhSSBB', 'KKKhSSBB'], cycles: ['LK', 'SB'] },
  { name: 'cape', rows: ['BBhLLLL', 'BBhLLLL', 'KKhRRRR', 'KKhRRRR', 'KKhDDDD'], cycles: ['LR', 'DR'] },
  { name: 'foyer', rows: ['KKhhLL', 'KKhhLL', 'RRhhBB', 'RRhhBB', 'RRhhBB'], cycles: ['KR', 'LB'] },
].map((d) => Object.freeze({ ...d, rows: Object.freeze(d.rows), cycles: Object.freeze(d.cycles) })))

// The two-storey houses (doc §5: "1 + attic" Cape Cods, plus the tract's
// other upstairs types), in their model frame like MODEL_DEFS: row 0 is the
// street front, 'h' the hall (front door on its first front-row cell, back
// door on its first back-row cell), 'S' the switchback core (the
// stairwellPlan's 6×4 cells with its halo, always 6 along the frontage and 4
// deep, its door at the middle of the long side that faces a hall row),
// letters the ground floor's rooms (prototype.ROLE_OF). `grounds` are the
// model's other ground plans: the same outline and front door, the stair
// core elsewhere (the other end of the house, behind a hall that wraps it).
// `attics` are hand-drawn UPSTAIRS plans over the same outline (storey 1):
// the same core, halls, '#' eaves (the knee walls under the roof slope:
// mass), and the attic letters (tile.ATTIC_ROLE: R/P/N bedrooms, B bath,
// T box room, U laundry, Y a bonus room). Every house draws its own
// upstairs (upstairsVariant, below); the hand-drawn plans are its fallback.
// The stair sits behind the front hall (cape cod), behind a cross hall at
// the back (colonial), along the street front (side hall) or at the back of
// a side hall (saltbox), or wherever a ground plan moves it; `flip` mirrors
// every one of them. A house's model, ground plan and upstairs are hashed
// per house.
export const TWO_STOREY_DEFS = Object.freeze([
  {
    name: 'cape cod',
    rows: ['hhhhhhhLLLL', 'SSSSSShLLLL', 'SSSSSShLLLL', 'SSSSSShKKKK', 'SSSSSShKKKK'],
    grounds: [
      ['hhhhhhhhhhh', 'LLLLhSSSSSS', 'LLLLhSSSSSS', 'KKKKhSSSSSS', 'KKKKhSSSSSS'],
      ['hSSSSSShLLL', 'hSSSSSShLLL', 'hSSSSSShKKK', 'hSSSSSShKKK', 'hhhhhhhhKKK'],
    ],
    attics: [
      ['hhhhhhhRRRR', 'SSSSSShRRRR', 'SSSSSShRRRR', 'SSSSSShTTTT', 'SSSSSShTTTT'],
      ['hhhhhhhRRRR', 'SSSSSShRRRR', 'SSSSSShPPPP', 'SSSSSShPPPP', 'SSSSSShTTTT'],
      ['hhhhhhhRRRR', 'SSSSSShRRRR', 'SSSSSShBBBB', 'SSSSSShTTTT', 'SSSSSSh####'],
      ['hhhhhhh####', 'SSSSSShRRRR', 'SSSSSShRRRR', 'SSSSSShRRRR', 'SSSSSShBBBB'],
    ],
  },
  {
    name: 'colonial',
    rows: ['LLLLLhKKKKK', 'LLLLLhKKKKK', 'hhhhhhhhhhh', 'SSSSSShDDDD', 'SSSSSShDDDD', 'SSSSSShUUUU', 'SSSSSShUUUU'],
    grounds: [
      ['KKKKKhLLLLL', 'KKKKKhLLLLL', 'hhhhhhhhhhh', 'DDDDhSSSSSS', 'DDDDhSSSSSS', 'UUUUhSSSSSS', 'UUUUhSSSSSS'],
    ],
    attics: [
      ['RRRRRRPPPPP', 'RRRRRRPPPPP', 'hhhhhhhhhhh', 'SSSSSShBBBB', 'SSSSSShBBBB', 'SSSSSShTTTT', 'SSSSSShTTTT'],
      ['RRRRBBBNNNN', 'RRRRBBBNNNN', 'hhhhhhhhhhh', 'SSSSSShPPPP', 'SSSSSShPPPP', 'SSSSSShPPPP', 'SSSSSSh####'],
      ['YYYYYYYRRRR', 'YYYYYYYRRRR', 'hhhhhhhhhhh', 'SSSSSShBBBB', 'SSSSSShBBBB', 'SSSSSShNNNN', 'SSSSSShNNNN'],
    ],
  },
  {
    name: 'side hall',
    rows: ['LLLhSSSSSS', 'LLLhSSSSSS', 'LLLhSSSSSS', 'LLLhSSSSSS', 'KKKhhhhhhh', 'KKKhDDDDDD', 'KKKhDDDDDD'],
    grounds: [
      ['LLLhDDDDDD', 'LLLhDDDDDD', 'LLLhhhhhhh', 'KKKhSSSSSS', 'KKKhSSSSSS', 'KKKhSSSSSS', 'KKKhSSSSSS'],
    ],
    attics: [
      ['RRRhSSSSSS', 'RRRhSSSSSS', 'RRRhSSSSSS', 'RRRhSSSSSS', 'BBBhhhhhhh', 'BBBhPPPPPP', 'BBBhPPPPPP'],
      ['RRRhSSSSSS', 'RRRhSSSSSS', 'RRRhSSSSSS', 'RRRhSSSSSS', 'TTThhhhhhh', 'TTThPPPNNN', 'TTThPPPNNN'],
      ['###hSSSSSS', '###hSSSSSS', 'RRRhSSSSSS', 'RRRhSSSSSS', 'BBBhhhhhhh', 'BBBhYYYYYY', 'BBBhYYYYYY'],
    ],
  },
  {
    name: 'saltbox',
    rows: ['LLLLhDDDDDD', 'LLLLhDDDDDD', 'LLLLhhhhhhh', 'KKKKhSSSSSS', 'KKKKhSSSSSS', 'KKKKhSSSSSS', 'KKKKhSSSSSS'],
    grounds: [
      ['LLLLhSSSSSS', 'LLLLhSSSSSS', 'LLLLhSSSSSS', 'LLLLhSSSSSS', 'KKKKhhhhhhh', 'KKKKhDDDDDD', 'KKKKhDDDDDD'],
    ],
    attics: [
      ['RRRRhPPPPPP', 'RRRRhPPPPPP', 'RRRRhhhhhhh', 'BBBBhSSSSSS', 'BBBBhSSSSSS', 'TTTThSSSSSS', 'TTTThSSSSSS'],
      ['RRRRhNNNPPP', 'RRRRhNNNPPP', 'RRRRhhhhhhh', '####hSSSSSS', 'BBBBhSSSSSS', 'BBBBhSSSSSS', '####hSSSSSS'],
      ['YYYYhRRRRRR', 'YYYYhRRRRRR', 'YYYYhhhhhhh', 'UUUUhSSSSSS', 'UUUUhSSSSSS', 'BBBBhSSSSSS', 'BBBBhSSSSSS'],
    ],
  },
].map((d) => Object.freeze({ ...d, rows: Object.freeze(d.rows), grounds: Object.freeze((d.grounds ?? []).map((g) => Object.freeze(g))), attics: Object.freeze(d.attics.map((a) => Object.freeze(a))) })))
export const TWO_STOREY = -1 // a lot's model index for a two-storey house (its def: lot.two)

// One plan grid (a ground floor or an upstairs) → { W, D, halls, rooms
// [{key, u0, v0, u1, v1, door: [room cell, hall cell]}], eaves, core }.
// Rooms are whole rectangles of one letter, at least 2×2 or 4×1, each with a
// hall neighbour (the door: the first room cell, row-major, with a hall cell
// N, W, E or S of it); 'S' is the core and '#' eaves.
const GRID_NEIGHBOURS = [[0, -1], [-1, 0], [1, 0], [0, 1]]
function parseGrid(rows, name) {
  const D = rows.length
  const W = rows[0].length
  const at = (u, v) => (u >= 0 && u < W && v >= 0 && v < D ? rows[v][u] : null)
  const halls = []
  const eaves = []
  const rects = new Map()
  for (let v = 0; v < D; v++) {
    if (rows[v].length !== W) throw new Error(`suburb ${name}: ragged row ${v}`)
    for (let u = 0; u < W; u++) {
      const c = at(u, v)
      if (c === 'h') halls.push(Object.freeze({ u, v }))
      else if (c === '#') eaves.push(Object.freeze({ u, v }))
      else {
        const r = rects.get(c) ?? { key: c, u0: u, v0: v, u1: u, v1: v }
        r.u0 = Math.min(r.u0, u)
        r.v0 = Math.min(r.v0, v)
        r.u1 = Math.max(r.u1, u)
        r.v1 = Math.max(r.v1, v)
        rects.set(c, r)
      }
    }
  }
  const core = rects.get('S')
  if (!core || core.u1 - core.u0 !== 5 || core.v1 - core.v0 !== 3) throw new Error(`suburb ${name}: the core must be 6×4`)
  rects.delete('S')
  const rooms = []
  for (const r of rects.values()) {
    for (let v = r.v0; v <= r.v1; v++) for (let u = r.u0; u <= r.u1; u++) if (at(u, v) !== r.key) throw new Error(`suburb ${name}: room ${r.key} is not a rectangle`)
    const w = r.u1 - r.u0 + 1
    const d = r.v1 - r.v0 + 1
    if (!((w >= 2 && d >= 2) || w >= 4 || d >= 4)) throw new Error(`suburb ${name}: room ${r.key} is too small`)
    search: for (let v = r.v0; v <= r.v1; v++) {
      for (let u = r.u0; u <= r.u1; u++) {
        for (const [du, dv] of GRID_NEIGHBOURS) {
          if (at(u + du, v + dv) === 'h') {
            r.door = Object.freeze([Object.freeze({ u, v }), Object.freeze({ u: u + du, v: v + dv })])
            break search
          }
        }
      }
    }
    if (!r.door) throw new Error(`suburb ${name}: room ${r.key} has no hall door`)
    rooms.push(Object.freeze(r))
  }
  return { W, D, halls: Object.freeze(halls), rooms: Object.freeze(rooms), eaves: Object.freeze(eaves), core: Object.freeze({ u0: core.u0, v0: core.v0, u1: core.u1, v1: core.v1 }) }
}

// One upstairs grid of a two-storey model, validated: the outline and the
// core of the ground floor, a hall on the stair door's cells (both flip
// columns) in one piece, every room a rectangle with a hall door. Adds the
// exit (the hall's far end from the stair door), the hook's fallbacks (the
// hall's cells, farthest first) and the hall lamp (half way along).
const hallAt = (g) => {
  const set = new Set(g.halls.map((c) => `${c.u},${c.v}`))
  return (u, v) => set.has(`${u},${v}`)
}
function parseUpstairs(kind, rows, label) {
  const { W, D, core, doorU, doorV } = kind
  const g = parseGrid(rows, label)
  if (g.W !== W || g.D !== D) throw new Error(`suburb ${label}: outline differs from the ground floor`)
  if (g.core.u0 !== core.u0 || g.core.v0 !== core.v0) throw new Error(`suburb ${label}: the core moved`)
  const up = hallAt(g)
  if (!doorU.every((u) => up(u, doorV))) throw new Error(`suburb ${label}: the stair door opens on no hall`)
  // Hall distances from the stair door (both flip columns), over hall cells.
  const dist = new Map()
  const queue = doorU.map((u) => ({ u, v: doorV }))
  for (const c of queue) dist.set(`${c.u},${c.v}`, 0)
  for (let q = 0; q < queue.length; q++) {
    const c = queue[q]
    for (const [du, dv] of GRID_NEIGHBOURS) {
      const n = { u: c.u + du, v: c.v + dv }
      const key = `${n.u},${n.v}`
      if (!up(n.u, n.v) || dist.has(key)) continue
      dist.set(key, dist.get(`${c.u},${c.v}`) + 1)
      queue.push(n)
    }
  }
  if (dist.size !== g.halls.length) throw new Error(`suburb ${label}: the upstairs hall is in pieces`)
  const byFar = [...g.halls].sort((a, b) => dist.get(`${b.u},${b.v}`) - dist.get(`${a.u},${a.v}`) || b.v - a.v || b.u - a.u)
  const far = dist.get(`${byFar[0].u},${byFar[0].v}`)
  const lamp = byFar.find((c) => dist.get(`${c.u},${c.v}`) <= Math.ceil(far / 2))
  return Object.freeze({ ...g, rows: Object.freeze([...rows]), exit: byFar[0], fallbacks: Object.freeze(byFar.slice(0, 7)), lamp })
}

// --- the upstairs grammar ------------------------------------------------------------
//
// Every two-storey house draws its own upstairs over its model's outline and
// core (doc §5: "an attic of two low rooms" for the cape cod, a full upper
// floor for the others), so no two houses of a tract share an upstairs by
// construction:
//   1. the hall: the ground floor's hall, trimmed back from its dead ends
//      (the front door's run is not needed upstairs) or grown by a short
//      stub into a deep block, always keeping the stair door's cells and
//      at least MIN_HALL cells in one piece;
//   2. the rooms: the land left beside the hall cut into the largest
//      rectangles (hashed ties), each then split once or twice across its
//      long side where both halves stay rooms with a hall door — bedrooms
//      split into a box room, a bath carved off a corner, two small
//      bedrooms side by side; a scrap no room can use is a linen closet
//      (mass);
//   3. the roof: one or both eaves (the front or back wall line) get knee
//      walls — a room deep enough loses its eave row to the slope (mass),
//      unless a DORMER keeps it full height (hashed per room);
//   4. the letters: the largest room is the main bedroom, the smallest the
//      bath, the rest bedrooms, a box room, a laundry or a bonus room with
//      the TV, by size and hash.
// The result is validated exactly like a hand-drawn plan (parseUpstairs);
// a draw that fails is redrawn, and after UPSTAIRS_TRIES the model's
// hand-drawn plans are the fallback.
const MIN_HALL = 4
const UPSTAIRS_TRIES = 16
const MAX_ROOMS = 7

// A drawn room: at least 2×2, or a 1-cell strip of 4-6 (a bath or a box
// room under the slope; strips never come from a split or an eave cut).
const validRoom = (w, d) => (w >= 2 && d >= 2) || (Math.min(w, d) === 1 && Math.max(w, d) >= 4 && Math.max(w, d) <= 6)
const fullRoom = (w, d) => w >= 2 && d >= 2

function drawUpstairs(kind, rand) {
  const { W, D, doorU, doorV } = kind
  const g = kind.rows.map((row) => [...row].map((c) => (c === 'S' || c === 'h' ? c : '.')))
  const at = (u, v) => (u >= 0 && u < W && v >= 0 && v < D ? g[v][u] : null)
  const isDoor = (u, v) => v === doorV && doorU.includes(u)
  const hallNeighbours = (u, v) => GRID_NEIGHBOURS.reduce((n, [du, dv]) => n + (at(u + du, v + dv) === 'h' ? 1 : 0), 0)
  // 1a. trim dead ends (a leaf of the hall graph, never a stair door cell).
  let hallCount = 0
  for (let v = 0; v < D; v++) for (let u = 0; u < W; u++) if (g[v][u] === 'h') hallCount++
  const trims = rand(5)
  for (let t = 0; t < trims && hallCount > MIN_HALL; t++) {
    const leaves = []
    for (let v = 0; v < D; v++) for (let u = 0; u < W; u++) if (g[v][u] === 'h' && !isDoor(u, v) && hallNeighbours(u, v) === 1) leaves.push([u, v])
    if (!leaves.length) break
    const [u, v] = leaves[rand(leaves.length)]
    g[v][u] = '.'
    hallCount--
  }
  // 1b. a stub: 1-2 cells from a hall cell straight into free land.
  if (rand(3) === 1) {
    const stubs = []
    for (let v = 0; v < D; v++) {
      for (let u = 0; u < W; u++) {
        if (g[v][u] !== 'h') continue
        for (const [du, dv] of GRID_NEIGHBOURS) {
          // Both sides of the stub keep free land (it splits a block).
          const side = du === 0 ? [[-1, 0], [1, 0]] : [[0, -1], [0, 1]]
          if (at(u + du, v + dv) === '.' && at(u + 2 * du, v + 2 * dv) === '.' && side.every(([su, sv]) => at(u + du + su, v + dv + sv) === '.')) stubs.push([u, v, du, dv])
        }
      }
    }
    if (stubs.length) {
      const [u, v, du, dv] = stubs[rand(stubs.length)]
      const len = 1 + rand(2)
      for (let i = 1; i <= len && at(u + i * du, v + i * dv) === '.' && at(u + (i + 1) * du, v + (i + 1) * dv) === '.'; i++) g[v + i * dv][u + i * du] = 'h'
    }
  }
  const touchesHall = (r) => {
    for (let v = r.v0; v <= r.v1; v++) {
      for (let u = r.u0; u <= r.u1; u++) {
        if (at(u - 1, v) === 'h' || at(u + 1, v) === 'h' || at(u, v - 1) === 'h' || at(u, v + 1) === 'h') return true
      }
    }
    return false
  }
  // 2a. the free land in largest rectangles (hashed among the equal best).
  const free = (u, v) => at(u, v) === '.'
  const rects = []
  for (;;) {
    let best = 0
    let pool = []
    for (let v0 = 0; v0 < D; v0++) {
      for (let u0 = 0; u0 < W; u0++) {
        if (!free(u0, v0)) continue
        let maxU = W - 1
        for (let v1 = v0; v1 < D && free(u0, v1); v1++) {
          let u1 = u0
          while (u1 + 1 <= maxU && free(u1 + 1, v1)) u1++
          maxU = u1
          const r = { u0, v0, u1, v1 }
          const area = (u1 - u0 + 1) * (v1 - v0 + 1)
          // Prefer rooms (valid size, a hall door) over scraps.
          const score = area * (validRoom(u1 - u0 + 1, v1 - v0 + 1) && touchesHall(r) ? 4 : 1)
          if (score > best) {
            best = score
            pool = [r]
          } else if (score === best) pool.push(r)
        }
      }
    }
    if (!pool.length) break
    const r = pool[rand(pool.length)]
    for (let v = r.v0; v <= r.v1; v++) for (let u = r.u0; u <= r.u1; u++) g[v][u] = 'x'
    rects.push(r)
  }
  // 2b. splits across the long side, both halves rooms with a hall door.
  const rooms = []
  const scrap = []
  const split = (r, depth) => {
    const w = r.u1 - r.u0 + 1
    const d = r.v1 - r.v0 + 1
    const area = w * d
    const want = depth < 2 && area >= 8 && rand(10) < (area >= 14 ? 8 : area >= 10 ? 6 : 4)
    if (want) {
      const cuts = []
      for (let u = r.u0 + 1; u <= r.u1; u++) cuts.push([{ ...r, u1: u - 1 }, { ...r, u0: u }])
      for (let v = r.v0 + 1; v <= r.v1; v++) cuts.push([{ ...r, v1: v - 1 }, { ...r, v0: v }])
      const ok = cuts.filter((pair) => pair.every((p) => fullRoom(p.u1 - p.u0 + 1, p.v1 - p.v0 + 1) && touchesHall(p)))
      if (ok.length) {
        const [a, b] = ok[rand(ok.length)]
        split(a, depth + 1)
        split(b, depth + 1)
        return
      }
    }
    rooms.push(r)
  }
  for (const r of rects) {
    if (validRoom(r.u1 - r.u0 + 1, r.v1 - r.v0 + 1) && touchesHall(r)) split(r, 0)
    else scrap.push(r)
  }
  if (rooms.length < 2 || rooms.length > MAX_ROOMS) return null
  // 3. knee walls under the eaves, dormers by hash.
  const eaves = [[0], [D - 1], [0, D - 1], []][rand(4)]
  for (const row of eaves) {
    for (const r of rooms) {
      if (r.v0 !== row && r.v1 !== row) continue
      if (rand(5) < 2) continue // a dormer: the room keeps its full height
      const cut = r.v0 === row ? { ...r, v0: r.v0 + 1 } : { ...r, v1: r.v1 - 1 }
      if (cut.v1 < cut.v0 || !fullRoom(cut.u1 - cut.u0 + 1, cut.v1 - cut.v0 + 1) || !touchesHall(cut)) continue
      scrap.push({ u0: r.u0, u1: r.u1, v0: row, v1: row })
      Object.assign(r, cut)
    }
  }
  // 4. letters by size: main bedroom, bath, then the rest.
  // A strip is never a bedroom: it ranks below every full room.
  const strip = (r) => r.u0 === r.u1 || r.v0 === r.v1
  const order = rooms.map((r, i) => ({ r, i, area: (r.u1 - r.u0 + 1) * (r.v1 - r.v0 + 1) - (strip(r) ? 100 : 0) })).sort((a, b) => b.area - a.area || a.i - b.i)
  if (strip(order[0].r)) return null
  const letters = new Map()
  letters.set(order[0].r, 'R')
  // Two rooms (the cape cod's "attic of two low rooms"): the second is a
  // bath, a second bedroom or a box room.
  letters.set(order[order.length - 1].r, rooms.length === 2 && !strip(order[1].r) ? ['B', 'P', 'T'][rand(3)] : 'B')
  const rest = ['P', 'N', 'Y', 'T', 'U']
  for (const { r, area } of order.slice(1, -1)) {
    // Strips and small rooms lean to a box room or a laundry, larger ones
    // to bedrooms or the bonus room (TV).
    const prefs = strip(r) ? ['T', 'U'] : area <= 6 ? ['T', 'U', 'N', 'P', 'Y'] : ['P', 'N', 'Y', 'T', 'U']
    const free = prefs.filter((c) => rest.includes(c))
    if (!free.length) return null
    const c = free[rand(10) < 6 ? 0 : rand(free.length)]
    rest.splice(rest.indexOf(c), 1)
    letters.set(r, c)
  }
  for (const r of scrap) for (let v = r.v0; v <= r.v1; v++) for (let u = r.u0; u <= r.u1; u++) g[v][u] = '#'
  for (const r of rooms) for (let v = r.v0; v <= r.v1; v++) for (let u = r.u0; u <= r.u1; u++) g[v][u] = letters.get(r)
  return g.map((row) => row.join(''))
}

// House `slot` of a tile: its upstairs, drawn from (tile hash, slot), never
// the rows of `taken` (another house of the same model on the tile).
export function upstairsVariant(kind, h, taken = []) {
  for (let attempt = 0; attempt < UPSTAIRS_TRIES; attempt++) {
    let n = 0
    const hk = hashChain(h | 0, kind.index * 8 + kind.variant, attempt)
    const rand = (m) => (m <= 1 ? 0 : hashChain(hk, n++) % m)
    const rows = drawUpstairs(kind, rand)
    if (!rows || taken.some((t) => t.join('|') === rows.join('|'))) continue
    try {
      return parseUpstairs(kind, rows, `${kind.name} drawn`)
    } catch {
      // redraw
    }
  }
  return kind.attics[(h >>> 0) % kind.attics.length]
}

// One ground plan of a two-storey model: its core, the side of the core its
// door opens on ('front': the hall row before it, 'back': the row behind
// it) and the stair door's cells (doorU × doorV).
function groundKind(rows, name, index, variant) {
  const ground = parseGrid(rows, name)
  const { core, W, D } = ground
  const isHall = hallAt(ground)
  // The stair door sits at the middle of a long side: u0 + 2 or u0 + 3 (the
  // flip picks), so both cells of that side's row must be hall, upstairs too.
  const doorU = Object.freeze([core.u0 + 2, core.u0 + 3])
  const side = doorU.every((u) => isHall(u, core.v0 - 1)) ? 'front' : doorU.every((u) => isHall(u, core.v1 + 1)) ? 'back' : null
  if (!side) throw new Error(`suburb ${name}: the core door opens on no hall`)
  const doorV = side === 'front' ? core.v0 - 1 : core.v1 + 1
  return {
    index,
    variant,
    name,
    rows,
    W,
    D,
    core,
    coreSide: side,
    doorU,
    doorV,
    shape: Object.freeze({ model: TWO_STOREY, W, D, front: ground.halls.find((c) => c.v === 0).u, back: (ground.halls.find((c) => c.v === D - 1) ?? { u: -1 }).u }),
  }
}

// The parsed catalogue: per model its ground plans (variant 0 the model's
// own rows, then its other GROUND plans — the same outline and front door,
// the stair core elsewhere: at the other end, behind a hall that wraps it),
// each with its fallback upstairs (variant 0: the hand-drawn plans; the
// others: their plain draw) and the anomaly's repeat. The kind's own fields
// are variant 0's (the lot grammar places a model by its outline only).
export const TWO_STOREY_KINDS = Object.freeze(TWO_STOREY_DEFS.map((def, index) => {
  const variants = [def.rows, ...def.grounds].map((rows, j) => {
    const name = j ? `${def.name} ${j}` : def.name
    const g = groundKind(rows, name, index, j)
    if (g.W !== TWO_STOREY_DEFS[index].rows[0].length || g.D !== def.rows.length) throw new Error(`suburb ${name}: outline differs`)
    const attics = j === 0
      ? def.attics.map((a, i) => parseUpstairs(g, a, `${def.name} upstairs ${i}`))
      : [parseUpstairs(g, drawUpstairs(g, () => 0), `${name} plain`)]
    return Object.freeze({
      ...g,
      attics: Object.freeze(attics),
      // Anomaly 'upstairs' (doc 10.9): the upstairs repeats the ground floor.
      repeat: parseUpstairs(g, rows, `${name} repeated`),
    })
  })
  if (variants.some((v) => v.shape.front !== variants[0].shape.front)) throw new Error(`suburb ${def.name}: a ground plan moved the front door`)
  return Object.freeze({ ...variants[0], variants: Object.freeze(variants) })
}))

// Model-frame facts the grammar needs: width, depth, front/back door columns.
const frontU = (rows) => rows[0].indexOf('h')
const backU = (rows) => rows[rows.length - 1].indexOf('h')
const SHAPES = Object.freeze([
  ...MODEL_DEFS.map((m, i) => Object.freeze({ model: i, W: m.rows[0].length, D: m.rows.length, front: frontU(m.rows), back: backU(m.rows) })),
])

// --- lot frame ------------------------------------------------------------------

// A lot faces the street on side `face` ('N': the street is at −z, 'S' +z,
// 'W' −x, 'E' +x). Its frame: s runs along the frontage from s0 (s = 0 is
// the driveway, s = 1..W the house), t is the depth from the kerb (t = 0 the
// lawn row on the street, t = −1 the street's kerb cell), f0 the front line.
export function lotCell(l, s, t) {
  switch (l.face) {
    case 'N': return { gx: l.s0 + s, gz: l.f0 + t }
    case 'S': return { gx: l.s0 + s, gz: l.f0 - t }
    case 'W': return { gx: l.f0 + t, gz: l.s0 + s }
    default: return { gx: l.f0 - t, gz: l.s0 + s }
  }
}

// The model frame (u along the frontage, v the depth, v = 0 the front row)
// → tile-local cell of house/lot `h`; `flip` mirrors the plan.
export function houseCellOf(h, u, v) {
  return lotCell(h, 1 + (h.flip ? h.W - 1 - u : u), h.lawn + v)
}

// The tile-local rect (inclusive) of model-frame rect {u0, v0, u1, v1}.
export function houseRectOf(h, r) {
  const a = houseCellOf(h, r.u0, r.v0)
  const b = houseCellOf(h, r.u1, r.v1)
  return { x0: Math.min(a.gx, b.gx), z0: Math.min(a.gz, b.gz), x1: Math.max(a.gx, b.gx), z1: Math.max(a.gz, b.gz) }
}

// The direction the street lies in from a lot (unit cell step).
export const FACE_STEP = Object.freeze({ N: [0, -1], S: [0, 1], W: [-1, 0], E: [1, 0] })

// --- seams ------------------------------------------------------------------------

const SALT_XSEAM = 0x5b1e0
const SALT_ZSEAM = 0x5b1c0
const SALT_EXIT = 0x5b1e7
const SALT_ANOMALY = 0x5b1a0
const SALT_LABEL = 0x5b1ab
const SALT_PLAN = 0x5b1b1
const SALT_ATTIC = 0x5b1a7

export const bandKey = (tx, tz) => tileKeyAt(TILE, tx, tz, 0)
export const planSeedOf = (worldSeed, k) => tileSeed(worldSeed >>> 0, TILE.salt, k)
// Per-tile variety that never repeats at the mirror tile (tileSeed ties
// about 6% of mirror pairs): the grammar and the tile program seed with it.
export const tileHashOf = (worldSeed, k) => hashChain(planSeedOf(worldSeed, k), k.tx, k.tz, k.band)

// The x seam on the WEST side of tile (tx, tz), shared with tile (tx − 1, tz):
// the first rows of its 1-2 street crossings (each STREET_W rows), pure in the
// seam. Two crossings (p 1/4) sit 17+ rows apart; every row stays in 3..38.
export function xSeamPorts(worldSeed, tx, tz) {
  const h = hashChain(((worldSeed >>> 0) ^ SALT_XSEAM) | 0, tx, tz)
  if ((h & 7) < 2) {
    const a = 3 + ((h >>> 3) % 9)
    return Object.freeze([a, a + 17 + ((h >>> 9) % (34 - a - 17 + 1))])
  }
  return Object.freeze([4 + ((h >>> 3) % 30)])
}

// The z seam on the NORTH side of tile (tx, tz), shared with tile (tx, tz − 1):
// the first columns of its 1-2 collector crossings (two: p 1/4, 22+ columns
// apart), columns in 3..66.
export function zSeamPorts(worldSeed, tx, tz) {
  const h = hashChain(((worldSeed >>> 0) ^ SALT_ZSEAM) | 0, tx, tz)
  if ((h & 7) < 2) {
    const a = 3 + ((h >>> 3) % 20)
    return Object.freeze([a, a + 22 + ((h >>> 9) % (62 - a - 22 + 1))])
  }
  return Object.freeze([4 + ((h >>> 3) % 58)])
}

// The four sides' ports of tile (tx, tz): W/E rows, N/S columns.
export function tilePorts(worldSeed, tx, tz) {
  return Object.freeze({
    W: xSeamPorts(worldSeed, tx, tz),
    E: xSeamPorts(worldSeed, tx + 1, tz),
    N: zSeamPorts(worldSeed, tx, tz),
    S: zSeamPorts(worldSeed, tx, tz + 1),
  })
}

// --- the street grammar -----------------------------------------------------------

// The spawn (§8.1, §12.6): tile (0,0) always lays its spine horizontally on
// rows 9..13 across the whole tile, and the spawn stands on its centre line
// (never a prop: the tile program blocks these cells), storey 0.
export const SPAWN_CELLS = Object.freeze([25, 24, 26, 23, 22, 21].map((gx) => Object.freeze({ gx, gz: 11 })))
const SPAWN_SPINE = 9

const idx = (gx, gz) => gz * TILE_W + gx
const inner = (gx, gz) => gx >= INNER.x0 && gx <= INNER.x1 && gz >= INNER.z0 && gz <= INNER.z1
const lotLand = (gx, gz) => gx >= LOT_LAND.x0 && gx <= LOT_LAND.x1 && gz >= LOT_LAND.z0 && gz <= LOT_LAND.z1
const onOwnedRim = (gx, gz) => gx === 0 || gz === 0

// A seeded dice over one plan attempt: r(n, a, b) ∈ [0, n).
const dice = (h) => (n, a, b = 0) => (n <= 1 ? 0 : hashChain(h, a, b) % n)
const span = (r, lo, hi, a, b) => (hi <= lo ? lo : lo + r(hi - lo + 1, a, b))

// Lay the streets of one attempt. Returns null when the attempt fails a
// check (the caller retries with the next attempt).
function layStreets(r, ports, spawnTile) {
  const street = new Uint8Array(TILE_W * TILE_D)
  const junctions = []
  const bulbs = []
  const fill = (x0, z0, x1, z1) => {
    const rx0 = Math.max(0, Math.min(x0, x1))
    const rx1 = Math.min(TILE_W - 1, Math.max(x0, x1))
    const rz0 = Math.max(0, Math.min(z0, z1))
    const rz1 = Math.min(TILE_D - 1, Math.max(z0, z1))
    for (let gz = rz0; gz <= rz1; gz++) {
      for (let gx = rx0; gx <= rx1; gx++) {
        // The rim opens only at a port (the legs that reach it are ports).
        if (!inner(gx, gz) && !portCell(gx, gz)) continue
        street[idx(gx, gz)] = 1
      }
    }
  }
  const portCell = (gx, gz) => {
    if (gx === 0) return ports.W.some((z) => gz >= z && gz < z + STREET_W)
    if (gx === TILE_W - 1) return ports.E.some((z) => gz >= z && gz < z + STREET_W)
    if (gz === 0) return ports.N.some((x) => gx >= x && gx < x + STREET_W)
    if (gz === TILE_D - 1) return ports.S.some((x) => gx >= x && gx < x + STREET_W)
    return false
  }

  // The spine's axis: 'x' runs east-west (end ports W/E, side ports N/S).
  const axis = spawnTile ? 'x' : r(100, 1) < 55 ? 'x' : 'z'
  const A = axis === 'x' ? TILE_W : TILE_D // along extent
  const C = axis === 'x' ? TILE_D : TILE_W // across extent
  const endLo = axis === 'x' ? ports.W : ports.N
  const endHi = axis === 'x' ? ports.E : ports.S
  const sideLo = axis === 'x' ? ports.N : ports.W
  const sideHi = axis === 'x' ? ports.S : ports.E
  // along/across → a cell rect.
  const rect = (a0, a1, c0, c1) => (axis === 'x' ? fill(a0, c0, a1, c1) : fill(c0, a0, c1, a1))
  // The warp (doc §4.1: "gently curving warped parallels"): one along
  // profile w[a] ∈ [−2, 2] shared by the spine and its parallel (so they
  // curve together and their gap stays constant), stepping ±1 every 6-13
  // cells, 0 within 9 cells of either end so seam legs meet a straight street.
  // p 0.7 per tile; never on the spawn tile (its spawn cells sit on rows 9..13).
  const warp = new Array(A).fill(0)
  if (!spawnTile && r(10, 60) < 7) {
    let w = 0
    let t = 0
    for (let a = 9 + r(5, 61); a < A - 10; t++) {
      let d = r(2, 62, t) ? 1 : -1
      if (Math.abs(w + d) > 2) d = -d
      // Head back to 0 when the straight end is near.
      if (w !== 0 && A - 10 - a < 8 * Math.abs(w)) d = w > 0 ? -1 : 1
      w += d
      const next = Math.min(A - 10, a + span(r, 6, 13, 63, t))
      for (let i = a; i < next; i++) warp[i] = w
      a = next
    }
  }
  const wAt = (a) => warp[Math.max(0, Math.min(A - 1, a))]
  const wMin = (a0, a1) => { let m = 2; for (let a = a0; a <= a1; a++) m = Math.min(m, wAt(a)); return m }
  const wMax = (a0, a1) => { let m = -2; for (let a = a0; a <= a1; a++) m = Math.max(m, wAt(a)); return m }
  const wLo = wMin(0, A - 1)
  const wHi = wMax(0, A - 1)
  // A warped street of width STREET_W on base row c along [a0, a1].
  const band = (a0, a1, c) => {
    for (let a = a0; a <= a1;) {
      let b = a
      while (b < a1 && wAt(b + 1) === wAt(a)) b++
      rect(a, b, c + wAt(a), c + wAt(a) + STREET_W - 1)
      a = b + 1
    }
  }
  const cell = (a, c) => (axis === 'x' ? { gx: a, gz: c } : { gx: c, gz: a })
  const isStreet = (a, c) => {
    const p = cell(a, c)
    return p.gx >= 0 && p.gx < TILE_W && p.gz >= 0 && p.gz < TILE_D && street[idx(p.gx, p.gz)] === 1
  }

  // 1. The spine: across row s, along [a0, a1].
  const s = spawnTile ? SPAWN_SPINE : span(r, 6, C - 11, 2)
  let a0 = spawnTile ? 1 : span(r, 1, Math.floor(A * 0.3), 3)
  let a1 = spawnTile ? A - 2 : span(r, Math.ceil(A * 0.7), A - 2, 4)
  // Jogs of the end legs (along positions), chosen first so the spine
  // reaches them.
  // A port a few rows off the spine jogs right at the seam (a long leg would
  // run beside the spine as one double-width street).
  const near = (p) => Math.abs(p - s) < 2 * STREET_W + 2
  const loJog = endLo.map((p, i) => (Math.abs(p - s) < STREET_W ? null : near(p) ? span(r, 1, 4, 10 + i) : span(r, 3, Math.floor(A * 0.35), 10 + i)))
  const hiJog = endHi.map((p, i) => (Math.abs(p - s) < STREET_W ? null : near(p) ? span(r, A - 5 - STREET_W, A - 2 - STREET_W, 20 + i) : span(r, Math.ceil(A * 0.65) - STREET_W, A - 2 - STREET_W, 20 + i)))
  for (const j of loJog) if (j !== null) a0 = Math.min(a0, j)
  for (const j of hiJog) if (j !== null) a1 = Math.max(a1, j + STREET_W - 1)
  // A port whose rows meet the spine's runs straight on: the spine reaches
  // that end.
  endLo.forEach((p, i) => { if (loJog[i] === null) a0 = 1 })
  endHi.forEach((p, i) => { if (hiJog[i] === null) a1 = A - 2 })
  for (const q of [...sideLo, ...sideHi]) {
    a0 = Math.min(a0, q)
    a1 = Math.max(a1, q + STREET_W - 1)
  }
  band(a0, a1, s)
  const spine = { a0, a1, s, warp: Object.freeze(warp) }

  // 2. End legs: along from the rim to the jog, then across to the spine.
  endLo.forEach((p, i) => {
    const j = loJog[i]
    if (j === null) {
      rect(0, a0, p, p + STREET_W - 1)
      return
    }
    rect(0, j + STREET_W - 1, p, p + STREET_W - 1)
    rect(j, j + STREET_W - 1, Math.min(p, s + wMin(j, j + STREET_W - 1)), Math.max(p, s + wMax(j, j + STREET_W - 1)) + STREET_W - 1)
    junctions.push(cell(j + 2, s + wAt(j + 2) + 2))
  })
  endHi.forEach((p, i) => {
    const j = hiJog[i]
    if (j === null) {
      rect(a1, A - 1, p, p + STREET_W - 1)
      return
    }
    rect(j, A - 1, p, p + STREET_W - 1)
    rect(j, j + STREET_W - 1, Math.min(p, s + wMin(j, j + STREET_W - 1)), Math.max(p, s + wMax(j, j + STREET_W - 1)) + STREET_W - 1)
    junctions.push(cell(j + 2, s + wAt(j + 2) + 2))
  })

  // 3. A second parallel street (p 0.5) on the roomier side, joined by 1-2
  // connectors: a loop or a lollipop.
  let parallel = null
  if (!spawnTile || r(2, 5) === 0) {
    const roomLo = s - 1 - 14
    const roomHi = C - 2 - (s + STREET_W - 1) - 14
    const side = roomLo >= roomHi ? -1 : 1
    const room = Math.max(roomLo, roomHi)
    // The parallel's base row keeps its warped rows inside the rim.
    const lo2 = side < 0 ? 2 - wLo : s + STREET_W - 1 + 15
    const hi2 = side < 0 ? s - 15 - STREET_W + 1 : C - 2 - STREET_W + 1 - wHi
    if (room >= STREET_W && hi2 >= lo2 && r(100, 6) < 55) {
      const s2 = span(r, lo2, hi2, 7)
      const b0 = span(r, 1, A - 26, 8)
      const b1 = span(r, b0 + 23, A - 2, 9)
      band(b0, b1, s2)
      parallel = { b0, b1, s: s2 }
      // Connectors inside both spans.
      const lo = Math.max(b0, a0)
      const hi = Math.min(b1, a1) - STREET_W + 1
      const n = hi - lo >= 16 && r(2, 11) ? 2 : 1
      const cs = []
      if (hi >= lo) {
        cs.push(span(r, lo, n === 2 ? lo + Math.floor((hi - lo) / 2) - 6 : hi, 12))
        if (n === 2) cs.push(span(r, cs[0] + 12, hi, 13))
      } else {
        // The spans miss each other: extend the spine under the parallel.
        const c = b0 < a0 ? b0 : b1 - STREET_W + 1
        band(Math.min(c, a0), Math.max(c + STREET_W - 1, a1), s)
        spine.a0 = Math.min(spine.a0, c)
        spine.a1 = Math.max(spine.a1, c + STREET_W - 1)
        cs.push(c)
      }
      for (const c of cs) {
        rect(c, c + STREET_W - 1, Math.min(s, s2) + wMin(c, c + STREET_W - 1), Math.max(s, s2) + wMax(c, c + STREET_W - 1) + STREET_W - 1)
        junctions.push(cell(c + 2, s + wAt(c + 2) + 2), cell(c + 2, s2 + wAt(c + 2) + 2))
      }
      parallel.connectors = cs
    }
  }

  // 4. Side legs: straight across from the rim until a street covers the
  // leg's whole width (a T junction).
  const sideLeg = (q, from, step) => {
    let c = from
    const covered = (cc) => {
      for (let a = q; a < q + STREET_W; a++) if (!isStreet(a, cc)) return false
      return true
    }
    while (c >= 0 && c < C && !covered(c)) c += step
    if (c !== from) rect(q, q + STREET_W - 1, Math.min(from, c - step), Math.max(from, c - step))
    if (c >= 0 && c < C) junctions.push(cell(q + 2, c))
  }
  for (const q of sideLo) sideLeg(q, 0, 1)
  for (const q of sideHi) sideLeg(q, C - 1, -1)

  // 5. Bulbs at the free ends of the spine and the parallel (dead ends), and
  // 0-3 cul-de-sac stems off the streets.
  const disc = (ca, cc) => {
    const c = cell(ca, cc)
    let cells = 0
    for (let j = -4; j <= 4; j++) {
      for (let i = -4; i <= 4; i++) {
        if (i * i + j * j > 20.25) continue
        const gx = c.gx + i
        const gz = c.gz + j
        if (!inner(gx, gz)) continue
        street[idx(gx, gz)] = 1
        cells++
      }
    }
    bulbs.push({ gx: c.gx, gz: c.gz })
    return cells
  }
  const endFree = (a, c0) => {
    // Free: nothing else continues past the end (no street just beyond it).
    for (let c = c0; c < c0 + STREET_W; c++) if (isStreet(a, c)) return false
    return true
  }
  const endAt = (a, a2, c) => endFree(a, c + wAt(a2)) && disc(a2, c + wAt(a2) + 2)
  if (spine.a0 > 1) endAt(spine.a0 - 1, spine.a0 + 2, s)
  if (spine.a1 < A - 2) endAt(spine.a1 + 1, spine.a1 - 2, s)
  if (parallel) {
    if (parallel.b0 > 1) endAt(parallel.b0 - 1, parallel.b0 + 2, parallel.s)
    if (parallel.b1 < A - 2) endAt(parallel.b1 + 1, parallel.b1 - 2, parallel.s)
  }
  // Stems: 0-3 by weight. Each one scans every spot (host street, along
  // position, side) for the free depth there, then takes a hashed spot that
  // fits: the stem (4-14 cells) and its bulb on free inner land, clear of
  // other streets by STEM_CLEAR cells along (room for a lot each side).
  const want = [0, 1, 1, 2, 2, 3][r(6, 30)]
  let stems = 0
  const hosts = parallel ? [[s, spine.a0, spine.a1], [parallel.s, parallel.b0, parallel.b1]] : [[s, spine.a0, spine.a1]]
  for (let t = 0; t < want; t++) {
    const spots = []
    for (const [base, h0, h1] of hosts) {
      for (let q = h0 + 2; q <= h1 - STREET_W - 2; q++) {
        const qa0 = q - STEM_CLEAR
        const qa1 = q + STREET_W - 1 + STEM_CLEAR
        for (const dir of [1, -1]) {
          // The first row past the host street over the whole clearance span.
          const from = dir > 0 ? base + wMax(qa0, qa1) + STREET_W : base + wMin(qa0, qa1) - 1
          let avail = 0
          for (let c = from; c >= 1 && c <= C - 2 && avail < 20; c += dir, avail++) {
            let free = true
            for (let a = Math.max(0, qa0); free && a <= Math.min(A - 1, qa1); a++) if (isStreet(a, c)) free = false
            if (!free) break
          }
          if (avail >= 10) spots.push({ base, q, dir, from, avail })
        }
      }
    }
    if (!spots.length) break
    const { base, q, dir, from, avail } = spots[r(spots.length, 32, t)]
    const len = Math.min(span(r, 6, 14, 34, t), avail - 6)
    const to = from + dir * (len - 1)
    // From the host's edge under the stem (the warp may leave a step there).
    const edge = dir > 0 ? base + wMin(q, q + STREET_W - 1) + STREET_W - 1 : base + wMax(q, q + STREET_W - 1)
    rect(q, q + STREET_W - 1, Math.min(edge, to), Math.max(edge, to))
    disc(q + 2, to + dir * 2)
    junctions.push(cell(q + 2, base + wAt(q + 2) + 2))
    stems++
  }

  // Every port's rim cells are street, and the streets are one piece.
  const sides = [
    ...ports.W.map((z) => [0, z, 0, 1]), ...ports.E.map((z) => [TILE_W - 1, z, 0, 1]),
    ...ports.N.map((x) => [x, 0, 1, 0]), ...ports.S.map((x) => [x, TILE_D - 1, 1, 0]),
  ]
  for (const [x, z, dx, dz] of sides) {
    for (let i = 0; i < STREET_W; i++) if (!street[idx(x + dx * i, z + dz * i)]) return null
  }
  if (!oneComponent(street)) return null
  return { street, axis, spine, parallel, junctions, bulbs, stems }
}

function oneComponent(mask) {
  let start = -1
  let total = 0
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue
    total++
    if (start < 0) start = i
  }
  if (start < 0) return false
  const seen = new Uint8Array(mask.length)
  const stack = [start]
  seen[start] = 1
  let n = 1
  while (stack.length) {
    const i = stack.pop()
    const gx = i % TILE_W
    const gz = (i - gx) / TILE_W
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = gx + dx
      const z = gz + dz
      if (x < 0 || z < 0 || x >= TILE_W || z >= TILE_D) continue
      const j = idx(x, z)
      if (!mask[j] || seen[j]) continue
      seen[j] = 1
      n++
      stack.push(j)
    }
  }
  return n === total
}

// --- lots -------------------------------------------------------------------------

const FACES = Object.freeze(['N', 'S', 'W', 'E'])
const LAND_FREE = 0
const LAND_STREET = 1
const LAND_LOT = 2

// Whether a lot of `shape` fits at (face, f0, s0) with `lawn` lawn rows: its
// driveway, house and lawn rows all on free inner land, the cell before the
// front door (t = −1) a street. Returns the yard depth it can take (≤ yardMax,
// whole rows only), or −1.
function lotFits(land, face, f0, s0, shape, lawn, flip, yardMax) {
  const l = { face, f0, s0 }
  const W = shape.W
  const door = 1 + (flip ? W - 1 - shape.front : shape.front)
  const kerb = lotCell(l, door, -1)
  if (kerb.gx < 0 || kerb.gz < 0 || kerb.gx >= TILE_W || kerb.gz >= TILE_D || land[idx(kerb.gx, kerb.gz)] !== LAND_STREET) return -1
  const depth = lawn + shape.D
  for (let t = 0; t < depth; t++) {
    for (let s = 0; s <= W; s++) {
      const c = lotCell(l, s, t)
      if (!lotLand(c.gx, c.gz) || land[idx(c.gx, c.gz)] !== LAND_FREE) return -1
    }
  }
  let yard = 0
  for (let t = depth; yard < yardMax; t++, yard++) {
    let rowOk = true
    for (let s = 0; s <= W && rowOk; s++) {
      const c = lotCell(l, s, t)
      if (!lotLand(c.gx, c.gz) || land[idx(c.gx, c.gz)] !== LAND_FREE) rowOk = false
    }
    if (!rowOk) break
  }
  return yard
}

function claim(land, lot) {
  for (let t = 0; t < lot.lawn + lot.D + lot.yard; t++) {
    for (let s = 0; s <= lot.W + (lot.side ?? 0); s++) {
      const c = lotCell(lot, s, t)
      land[idx(c.gx, c.gz)] = LAND_LOT
    }
  }
}

// The front lines of a face: every line (row for N/S, column for W/E) whose
// cells touch a street on that side, with the count of touching cells.
function frontLines(land, face) {
  const [dx, dz] = FACE_STEP[face]
  const ns = face === 'N' || face === 'S'
  const lines = []
  const n = ns ? TILE_D : TILE_W
  const m = ns ? TILE_W : TILE_D
  for (let f = 1; f < n - 1; f++) {
    let touch = 0
    for (let a = 1; a < m - 1; a++) {
      const gx = ns ? a : f
      const gz = ns ? f : a
      const x = gx + dx
      const z = gz + dz
      if (land[idx(gx, gz)] === LAND_FREE && x >= 0 && z >= 0 && x < TILE_W && z < TILE_D && land[idx(x, z)] === LAND_STREET) touch++
    }
    if (touch >= 3) lines.push({ face, f, touch })
  }
  return lines
}

// A front line's lot frame origin: for N/S faces the line is row f and s
// runs along x; for W/E the line is column f and s runs along z.
const lineLot = (face, f, s0) => ({ face, f0: f, s0 })

// The house of lot `l` (its model-frame rect) inside one chunk, with the
// stair core's halo strictly inside it: lx, lz ∈ 1..12 for every cell.
function inOneChunk(l) {
  const r = houseRectOf(l, { u0: 0, v0: 0, u1: l.W - 1, v1: l.D - 1 })
  const cx = Math.floor(r.x0 / CHUNK)
  const cz = Math.floor(r.z0 / CHUNK)
  if (Math.floor(r.x1 / CHUNK) !== cx || Math.floor(r.z1 / CHUNK) !== cz) return null
  const lx0 = r.x0 - cx * CHUNK
  const lz0 = r.z0 - cz * CHUNK
  const lx1 = r.x1 - cx * CHUNK
  const lz1 = r.z1 - cz * CHUNK
  return lx0 >= 1 && lz0 >= 1 && lx1 <= CHUNK - 2 && lz1 <= CHUNK - 2 ? { lcx: cx, lcz: cz } : null
}

// 1-4 two-storey houses (at least one), each in its own chunk. Every
// frontage position tries the models in a hashed order and keeps the first
// that stands there (the shallowest lawn that fits), so the narrower and
// shallower models fill the spots the wide ones miss.
function layTwoStorey(r, land, lines, spawnTile) {
  const cands = []
  const nKinds = TWO_STOREY_KINDS.length
  for (const ln of lines) {
    const ns = ln.face === 'N' || ln.face === 'S'
    const m = ns ? TILE_W : TILE_D
    for (let s0 = 1; s0 + 10 < m - 1; s0++) {
      for (const flip of [false, true]) {
        const key = hashChainKey(r, ln.face, ln.f, s0, 0, flip)
        let found = null
        for (let j = 0; j < nKinds && !found; j++) {
          const kind = TWO_STOREY_KINDS[(key + j) % nKinds]
          // The house (s0 + 1 .. s0 + W along the frontage) inside one chunk.
          const lx0 = (s0 + 1) % CHUNK
          if (lx0 < 1 || lx0 + kind.W > CHUNK - 1 || s0 + kind.W >= m - 1) continue
          for (let lawn = 1; lawn <= 3; lawn++) {
            const l = { ...lineLot(ln.face, ln.f, s0), W: kind.W, D: kind.D, lawn, flip }
            const up = inOneChunk(l)
            if (!up) continue
            const yard = lotFits(land, ln.face, ln.f, s0, kind.shape, lawn, flip, 2)
            if (yard < 0) continue
            found = { ...l, two: kind.index, yard, up, key }
            break // the shallowest lawn that fits
          }
        }
        if (found) cands.push(found)
      }
    }
  }
  if (!cands.length) return null
  cands.sort((a, b) => a.key - b.key || a.f0 - b.f0 || a.s0 - b.s0)
  const roll = r(100, 40)
  const want = roll < 30 ? 1 : roll < 65 ? 2 : roll < 90 ? 3 : 4
  const out = []
  const chunks = new Set()
  // Two passes: a model not yet on this tile first (the upstairs types mix),
  // then any.
  const used = new Set()
  for (const c of [...cands, ...cands]) {
    if (out.length >= want) break
    if (out.includes(c.lot)) continue
    const k = `${c.up.lcx},${c.up.lcz}`
    if (chunks.has(k)) continue
    if (used.has(c.two) && used.size < TWO_STOREY_KINDS.length && c.pass !== 2) {
      c.pass = 2
      continue
    }
    // Still free (an earlier pick may have claimed part of it).
    const yard = lotFits(land, c.face, c.f0, c.s0, TWO_STOREY_KINDS[c.two].shape, c.lawn, c.flip, 2)
    if (yard < 0) continue
    if (spawnTile && SPAWN_CELLS.some((sc) => lotHas({ ...c, yard }, sc.gx, sc.gz))) continue
    const lot = { face: c.face, f0: c.f0, s0: c.s0, W: c.W, D: c.D, lawn: c.lawn, yard, flip: c.flip, model: TWO_STOREY, two: c.two, up: c.up }
    claim(land, lot)
    chunks.add(k)
    used.add(c.two)
    c.lot = lot
    out.push(lot)
  }
  return out.length ? out : null
}

const hashChainKey = (r, face, f, s0, lawn, flip) => r(0x7fffffff, FACES.indexOf(face) * 64 + f, s0 * 8 + lawn * 2 + (flip ? 1 : 0))

function lotHas(lot, gx, gz) {
  for (let t = 0; t < lot.lawn + lot.D + lot.yard; t++) {
    for (let s = 0; s <= lot.W + (lot.side ?? 0); s++) {
      const c = lotCell(lot, s, t)
      if (c.gx === gx && c.gz === gz) return true
    }
  }
  return false
}

// The frontage walk: along every front line (most street contact first), a
// group of 2-3 identical houses at a time, alternately mirrored, each lot
// the house plus a driveway; a position where the current model cannot
// stand moves on one cell.
function layModelLots(r, land, lines) {
  // The tile's model set: 4 or 5 of the 5 models, dealt in a hashed order.
  const drop = r(6, 50)
  const set = SHAPES.filter((m) => drop >= SHAPES.length || m.model !== drop)
  const order = set.map((m, i) => [r(1 << 20, 51, i), m]).sort((a, b) => a[0] - b[0] || a[1].model - b[1].model).map(([, m]) => m)
  let turn = 0
  const lots = []
  const sorted = [...lines].sort((a, b) => b.touch - a.touch || r(1 << 20, 52, FACES.indexOf(a.face) * 64 + a.f) - r(1 << 20, 52, FACES.indexOf(b.face) * 64 + b.f))
  sorted.forEach((ln, li) => {
    const ns = ln.face === 'N' || ln.face === 'S'
    const m = ns ? TILE_W : TILE_D
    let shape = null
    let left = 0
    let flip = false
    let run = 0
    for (let s0 = 0; s0 < m - 2;) {
      if (!left) {
        shape = order[turn % order.length]
        turn++
        left = 2 + (r(4, 53, li * 128 + s0) === 0 ? 1 : 0)
        flip = r(2, 54, li * 128 + s0) === 1
        run++
      }
      const lawn = 1 + (r(5, 55, li * 128 + s0) === 0 ? 1 : 0)
      const yardMax = 1 + r(3, 56, li * 128 + s0)
      const tryPlace = (sh, lawns) => {
        for (const lw of lawns) {
          const yard = lotFits(land, ln.face, ln.f, s0, sh, lw, flip, yardMax)
          if (yard < 0) continue
          const lot = { face: ln.face, f0: ln.f, s0, W: sh.W, D: sh.D, lawn: lw, yard, flip, model: sh.model, run: `${li}:${run}` }
          claim(land, lot)
          lots.push(lot)
          return lot
        }
        return null
      }
      let placed = tryPlace(shape, lawn === 1 ? [1, 2] : [2, 1])
      if (placed) {
        s0 += shape.W + 1
        left--
        flip = !flip
      } else if ((placed = filler(tryPlace, order, shape))) {
        // A gap the group's model cannot take (a warped kerb, a short run
        // between two drives) takes another model of the tract, set back
        // as far as the kerb needs, so frontage is not left as field.
        s0 += placed.W + 1
        flip = !flip
      } else {
        s0++
        // A group broken by a gap starts afresh with the next model only
        // after a long gap.
        if (left < 2) left = 0
      }
    }
  })
  return lots
}

// The other models of the tract, narrowest first, at any lawn depth 1-3.
function filler(tryPlace, order, shape) {
  const others = order.filter((m) => m !== shape).sort((a, b) => a.W - b.W || a.D - b.D || a.model - b.model)
  for (const m of others) {
    const lot = tryPlace(m, [1, 2, 3])
    if (lot) return lot
  }
  return tryPlace(shape, [3])
}

// Leftover land behind and beside a lot joins it (doc §4.3.4: the lots take
// the block; what no lot can take stays field): whole free rows deepen the
// yard (to 6, or one more when that row is the owned rim, so a yard runs out
// to its seam fence instead of leaving a one-cell strip behind it), whole
// free columns past the house widen the side yard (to 4).
function growLots(land, lots) {
  const freeLine = (l, sFrom, sTo, tFrom, tTo) => {
    for (let t = tFrom; t <= tTo; t++) {
      for (let s = sFrom; s <= sTo; s++) {
        const c = lotCell(l, s, t)
        if (!lotLand(c.gx, c.gz) || land[idx(c.gx, c.gz)] !== LAND_FREE) return false
      }
    }
    return true
  }
  const rimRow = (l, t) => {
    for (let s = 0; s <= l.W; s++) {
      const c = lotCell(l, s, t)
      if (!onOwnedRim(c.gx, c.gz)) return false
    }
    return true
  }
  for (const l of lots) {
    l.side = 0
    const depth = () => l.lawn + l.D + l.yard
    while ((l.yard < 9 || rimRow(l, depth())) && freeLine(l, 0, l.W, depth(), depth())) {
      for (let s = 0; s <= l.W; s++) {
        const c = lotCell(l, s, depth())
        land[idx(c.gx, c.gz)] = LAND_LOT
      }
      l.yard++
    }
    while (l.side < 6 && freeLine(l, l.W + l.side + 1, l.W + l.side + 1, 0, depth() - 1)) {
      l.side++
      for (let t = 0; t < depth(); t++) {
        const c = lotCell(l, l.W + l.side, t)
        land[idx(c.gx, c.gz)] = LAND_LOT
      }
    }
  }
}

// --- the plan ----------------------------------------------------------------------

const PLAN_CACHE = new Map() // `${seed}|${tx},${tz}` → frozen plan (LRU)
const PLAN_CACHE_MAX = 512
const MAX_ATTEMPTS = 8

// The composed tile (tx, tz): { tx, tz, ports, axis, street (Uint8Array, 1 =
// street), land (Uint8Array: 0 field, 1 street, 2 lot), junctions, bulbs,
// stems, parallel, lots (two-storey first, slot order), forced (the
// two-storey lots: slot, core, up, exit, dir) }. Pure in (worldSeed, tile);
// memoised.
export function suburbPlan(worldSeed, tx, tz) {
  const seed = worldSeed >>> 0
  const key = `${seed}|${tx},${tz}`
  let plan = PLAN_CACHE.get(key)
  if (plan) {
    PLAN_CACHE.delete(key)
    PLAN_CACHE.set(key, plan)
    return plan
  }
  plan = composePlan(seed, tx, tz)
  PLAN_CACHE.set(key, plan)
  if (PLAN_CACHE.size > PLAN_CACHE_MAX) PLAN_CACHE.delete(PLAN_CACHE.keys().next().value)
  return plan
}

function composePlan(seed, tx, tz) {
  const k = bandKey(tx, tz)
  const h = tileHashOf(seed, k)
  const ports = tilePorts(seed, tx, tz)
  const spawnTile = tx === 0 && tz === 0
  for (let attempt = 0; attempt <= MAX_ATTEMPTS; attempt++) {
    // The last attempt is the spawn tile's layout (a full-width spine on rows
    // 9..13), which always takes a two-storey house.
    const last = attempt === MAX_ATTEMPTS
    const r = dice(hashChain((h ^ SALT_PLAN) | 0, attempt))
    const streets = layStreets(r, ports, spawnTile || last)
    if (!streets) continue
    const land = new Uint8Array(TILE_W * TILE_D)
    for (let i = 0; i < land.length; i++) land[i] = streets.street[i] ? LAND_STREET : LAND_FREE
    const lines = FACES.flatMap((f) => frontLines(land, f))
    const two = layTwoStorey(r, land, lines, spawnTile)
    if (!two) continue
    const lots = [...two, ...layModelLots(r, land, lines)]
    growLots(land, lots)
    return freezePlan({ tx, tz, h, ports, attempt, ...streets, land, lots }, seed)
  }
  throw new Error(`suburb: no plan for tile ${tx},${tz} (seed ${seed})`)
}

// The plan's ground use per cell: 0 field, 1 street, 2 a lot's front (lawn,
// driveway, side yard beside the house), 3 a house, 4 a backyard's first
// two rows, 5 the deep backyard beyond them (land a lot grew into).
export const GROUND_FIELD = 0
export const GROUND_STREET = 1
export const GROUND_FRONT = 2
export const GROUND_HOUSE = 3
export const GROUND_YARD = 4
export const GROUND_BACK = 5

function freezePlan(p, seed) {
  const ground = new Uint8Array(TILE_W * TILE_D)
  for (let i = 0; i < ground.length; i++) ground[i] = p.street[i] ? GROUND_STREET : GROUND_FIELD
  for (const l of p.lots) {
    for (let t = 0; t < l.lawn + l.D + l.yard; t++) {
      for (let s = 0; s <= l.W + l.side; s++) {
        const c = lotCell(l, s, t)
        const house = t >= l.lawn && t < l.lawn + l.D && s >= 1 && s <= l.W
        const back = t - l.lawn - l.D
        ground[idx(c.gx, c.gz)] = house ? GROUND_HOUSE : back >= 2 ? GROUND_BACK : back >= 0 ? GROUND_YARD : GROUND_FRONT
      }
    }
  }
  p.ground = ground
  const forced = []
  p.lots.forEach((l, i) => {
    l.index = i
    if (l.model !== TWO_STOREY) return
    const slot = forced.length
    l.slot = slot
    // The model's upstairs plan, hashed per house (anomaly 'upstairs': the
    // first house repeats its ground floor upstairs).
    // The house's ground plan (where its stair core stands) and its own
    // upstairs (upstairsVariant), hashed per house; two houses of one plan on
    // a tile never draw the same upstairs.
    const variants = TWO_STOREY_KINDS[l.two].variants
    const hh = hashChain((p.h ^ SALT_ATTIC) | 0, slot)
    l.ground = (hh >>> 9) % variants.length
    const kind = variants[l.ground]
    const repeat = slot === 0 && anomalyAt(seed, bandKey(p.tx, p.tz)) === 'upstairs'
    const taken = forced.filter((f) => f.two === l.two && f.ground === l.ground).map((f) => f.attic.rows)
    const attic = repeat ? kind.repeat : upstairsVariant(kind, hh, taken)
    l.attic = attic
    l.atticPlan = repeat ? -1 : hashChain(0x5b1a8, ...attic.rows.join('').split('').map((c) => c.charCodeAt(0))) & 0x7fffffff
    l.frontU = kind.shape.front
    l.core = houseRectOf(l, kind.core)
    l.coreSide = kind.coreSide
    l.exit = { ...houseCellOf(l, attic.exit.u, attic.exit.v), cy: ATTIC }
    l.fallbacks = attic.fallbacks
    // The stair climbs along the frontage: E/W for N/S-facing houses, S/N
    // for W/E-facing ones, by hash.
    const ns = l.face === 'N' || l.face === 'S'
    const flipDir = ((p.h >>> (20 + slot)) & 1) === 1
    l.dir = ns ? (flipDir ? 'W' : 'E') : flipDir ? 'N' : 'S'
    l.hx0 = houseRectOf(l, { u0: 0, v0: 0, u1: l.W - 1, v1: l.D - 1 }).x0
    l.hz0 = houseRectOf(l, { u0: 0, v0: 0, u1: l.W - 1, v1: l.D - 1 }).z0
    forced.push(l)
  })
  for (const l of p.lots) Object.freeze(l)
  return Object.freeze({ ...p, lots: Object.freeze(p.lots), forced: Object.freeze(forced) })
}

// The two-storey houses of tile k (§12.6: at least one per tile; finite
// mode has none): the plan's TWO_STOREY lots in slot order, each
//   { slot, face, f0, s0, W, D, lawn, yard, flip, two (TWO_STOREY_KINDS
//     index), atticPlan (its upstairs plan, -1 the repeated ground floor),
//     frontU, core (tile-local rect), coreSide, up: {lcx, lcz} (the
//     upstairs chunk, tile-local), exit (attic cell), fallbacks (the attic
//     hall's model cells, farthest first), dir ('E'|'W'|'N'|'S', the
//     stair's first flight), hx0, hz0 }.
export function forcedHouses(worldSeed, k) {
  return suburbPlan(worldSeed, k.tx, k.tz).forced
}

// Whether GLOBAL chunk (cx, cz) holds a two-storey house's attic (and so its
// stair core, which climbs from storey 0 to 1 in that chunk column).
export function isUpstairsChunk(worldSeed, cx, cz) {
  const k = tileKeyOf(TILE, cx, GROUND, cz)
  if (!k) return false
  const lcx = cx - k.origin.cx
  const lcz = cz - k.origin.cz
  return forcedHouses(worldSeed, k).some((s) => s.up.lcx === lcx && s.up.lcz === lcz)
}

// §6.5 footprint: storey 0 is all fifteen chunks; storey 1 only the chunks
// holding a two-storey house's attic. Everything else is solid mass.
export function footprint(worldSeed, cx, cy, cz) {
  const k = tileKeyOf(TILE, cx, cy, cz)
  if (!k) return 'solid'
  if (cy === GROUND) return 'tile'
  return isUpstairsChunk(worldSeed, cx, cz) ? 'tile' : 'solid'
}

// Ports (§6.5, §6.8), tile-local along-cells, inclusive, storey 0 only: the
// west side carries the x seam's street crossings, the north side the z
// seam's collector crossings.
const NO_PORTS = Object.freeze([])
export function ports(worldSeed, k, side, cy) {
  if (cy !== GROUND) return NO_PORTS
  if (side === 'west') return xSeamPorts(worldSeed, k.tx, k.tz).map((z) => ({ a0: z, a1: z + STREET_W - 1 }))
  if (side === 'north') return zSeamPorts(worldSeed, k.tx, k.tz).map((x) => ({ a0: x, a1: x + STREET_W - 1 }))
  return NO_PORTS
}

// --- spawn, exit, anomalies, labels -------------------------------------------------

// The 6 tiles at Chebyshev distance 2 from tile (0,0) with |tx| = 2 and
// |tz| ≤ 1: the exit chunk is then 7..13 chunks from the spawn chunk
// (exitBounds), and the proof box (the bounding rectangle of the spawn and
// exit tiles) is at most 3×2 tiles.
const EXIT_RING = Object.freeze((() => {
  const out = []
  for (const tx of [-2, 2]) for (let tz = -1; tz <= 1; tz++) out.push(Object.freeze({ tx, tz }))
  return out
})())

// The exit (anchor) tile: one of EXIT_RING, pure in the seed.
export function exitTileOf(worldSeed) {
  return EXIT_RING[hashChain(((worldSeed >>> 0) ^ SALT_EXIT) | 0, 0x0e) % EXIT_RING.length]
}

// The hook's deterministic fallback tiles: the rest of the ring, in order.
export function exitFallbackTiles(worldSeed) {
  const first = EXIT_RING.indexOf(exitTileOf(worldSeed))
  return Array.from({ length: EXIT_RING.length - 1 }, (_, i) => EXIT_RING[(first + 1 + i) % EXIT_RING.length])
}

export const isAnchorTile = (worldSeed, k) => {
  const t = exitTileOf(worldSeed)
  return t.tx === k.tx && t.tz === k.tz
}

// A tile-local cell of tile (tx, tz) → { cx, cy, cz, lx, lz } (GLOBAL).
export function globalCell(tx, tz, c) {
  const gx = tx * TILE_W + c.gx
  const gz = tz * TILE_D + c.gz
  const cx = Math.floor(gx / CHUNK)
  const cz = Math.floor(gz / CHUNK)
  return { cx, cy: c.cy ?? GROUND, cz, lx: gx - cx * CHUNK, lz: gz - cz * CHUNK }
}

// §8.2 exit anchor: the attic hall's far end of tile (tx, tz)'s first
// two-storey house (slot 0), on storey 1: the cell the tile program marks.
export function exitAnchorOfTile(worldSeed, tx, tz) {
  return globalCell(tx, tz, forcedHouses(worldSeed, bandKey(tx, tz))[0].exit)
}

export function exitAnchor(worldSeed) {
  const t = exitTileOf(worldSeed >>> 0)
  return exitAnchorOfTile(worldSeed >>> 0, t.tx, t.tz)
}

// A street cell of tile (tx, tz) (tile-local): the spawn tile's spawn cell,
// else the first street cell of the spine's centre line. Tests and tools
// start their walks here.
export function streetCellOf(worldSeed, tx, tz) {
  if (tx === 0 && tz === 0) return SPAWN_CELLS[0]
  const p = suburbPlan(worldSeed, tx, tz)
  for (let a = p.spine.a0; a <= p.spine.a1; a++) {
    const c = p.spine.s + p.spine.warp[a] + 2
    const cell = p.axis === 'x' ? { gx: a, gz: c } : { gx: c, gz: a }
    if (p.street[cell.gz * TILE_W + cell.gx]) return cell
  }
  return null
}

// Per-tile anomaly (§12.0; doc §10, doc 14: suburb 1 per 2 streets, a tile
// holds two, at most one per segment, never the same class twice in a row,
// never on the exit segment; the depth dial grows with distance). Hashed
// from each tile's planSeed (tileHashOf):
//   raw    present with p = min(0.9, 0.3 + 0.1·(|tx| + |tz|)) (the depth
//          dial: 0.5 on the first eligible ring, 0.9 from distance 6);
//          never within Chebyshev 1 of the spawn tile, never the exit
//          (anchor) tile; a preferred class from the next bits, a priority
//          from the rest;
//   rotate greedy in priority order: a tile takes its preferred class unless
//          an edge neighbour of higher priority holds it, else the next free
//          class. No two edge-adjacent tiles share a class. The recursion
//          climbs strictly rising priorities only, so the result is pure in
//          (worldSeed, tile) and order-independent.
//   'nine'     every house number in one chunk row reads 9 (doc 10.1,
//              Vivarium): that row's chunks carry the plate '9';
//   'door'     one house has no front door (doc 10.7, Skinamarink): its
//              yard gates stand open, its back door is the way in;
//   'upstairs' the stairs lead up to the same ground floor (doc 10.9): the
//              first two-storey house's attic repeats the living room and
//              the kitchen.
// None of them is ever on a route: houses are cul-de-sacs off the streets,
// and the exit house's tile carries none.
export const ANOMALY_CLASSES = Object.freeze(['nine', 'door', 'upstairs'])
const EDGE_NEIGHBOURS = Object.freeze([[1, 0], [-1, 0], [0, 1], [0, -1]])
export const anomalyChance = (tx, tz) => Math.min(0.9, 0.3 + 0.1 * (Math.abs(tx) + Math.abs(tz)))
const anomalyHash = (worldSeed, tx, tz) => hashChain((tileHashOf(worldSeed, bandKey(tx, tz)) ^ SALT_ANOMALY) | 0, 0x3a)

function rawAnomaly(worldSeed, tx, tz, ex) {
  if (Math.max(Math.abs(tx), Math.abs(tz)) <= 1) return null
  if (ex.tx === tx && ex.tz === tz) return null
  const h = anomalyHash(worldSeed, tx, tz)
  if ((h & 1023) / 1024 >= anomalyChance(tx, tz)) return null
  return { cls: ((h >>> 10) & 0xff) % ANOMALY_CLASSES.length, pri: h >>> 18, tx, tz }
}

// Strict total order on raw anomalies: priority, then (tx, tz).
const outranks = (a, b) => a.pri > b.pri || (a.pri === b.pri && (a.tx > b.tx || (a.tx === b.tx && a.tz > b.tz)))

function finalClass(worldSeed, me, ex, memo) {
  const key = `${me.tx},${me.tz}`
  const hit = memo.get(key)
  if (hit !== undefined) return hit
  const taken = new Set()
  for (const [dx, dz] of EDGE_NEIGHBOURS) {
    const n = rawAnomaly(worldSeed, me.tx + dx, me.tz + dz, ex)
    if (!n || !outranks(n, me)) continue
    const c = finalClass(worldSeed, n, ex, memo)
    if (c >= 0) taken.add(c)
  }
  let out = -1
  for (let i = 0; i < ANOMALY_CLASSES.length; i++) {
    const c = (me.cls + i) % ANOMALY_CLASSES.length
    if (!taken.has(c)) {
      out = c
      break
    }
  }
  memo.set(key, out)
  return out
}

export function anomalyAt(worldSeed, k) {
  const seed = worldSeed >>> 0
  const ex = exitTileOf(seed)
  const me = rawAnomaly(seed, k.tx, k.tz, ex)
  if (!me) return null
  const c = finalClass(seed, me, ex, new Map())
  return c < 0 ? null : ANOMALY_CLASSES[c]
}

// The chunk row (0..2) the 'nine' anomaly numbers.
export const nineRowOf = (worldSeed, k) => ((tileHashOf(worldSeed, bandKey(k.tx, k.tz)) >>> 7) & 0xff) % TILE.d

// Level plates (§12.0: pure in (worldSeed, tile, cy)). Storey 0: a house
// number per chunk, 10..99 (never a lone 9, the anomaly's number); the
// attics read 'UP'. Every glyph is a plate glyph (NUMERAL_GLYPHS).
export function plateOf(worldSeed, k, cy, lcx, lcz) {
  if (cy === ATTIC) return 'UP'
  const h = hashChain((tileHashOf(worldSeed, bandKey(k.tx, k.tz)) ^ SALT_LABEL) | 0, lcx, lcz)
  return String(10 + (h % 90))
}
