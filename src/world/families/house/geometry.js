import { CHUNK } from '../../constants.js'
import { RNG } from '../../core/rng.js'
import { MAP_FAMILY_HOUSE } from '../ids.js'
import { assembleCatalogDescriptor } from '../../structures/catalog/engine.js'
import { FAMILY_SALT, hashChain, planPick, structureId, tileKeyAt, tileKeyOf, tileSeed } from '../../tiles/tileKey.js'

// The house family's pure geometry (spec §3.3, §7.4, §12.11): the tile, its
// per-tile FRAME (the hashed seam ports, the stair cores, the Great Hall's
// chunk and shape, the storeys stacked over which chunks), the footprint, the
// Great Hall's catalog conversion and assembly, the per-tile anomaly, the
// storey labels and the exit anchor. Everything here is a pure function of
// (worldSeed, global coordinates), so the planner (structures.js), the tile
// program (tile.js, layout.js) and the hooks agree.
//
// The tile is no longer one floor plan copied: the frame is drawn per tile
// from the world seed, and layout.js grows the rooms and hallways round it
// (a corridor graph and a domestic room packing). Only ELEMENTS repeat (the
// P.T. L-hallway, the hall clock, the house's rooms and doors); the
// arrangement differs tile to tile.
//
// Planner-chain module (§7.5): it may import only constants.js, core/hash.js,
// core/rng.js, mapTypes.js, mapFamily.js ({deepFreeze, MAP_FAMILY_CODES}),
// structures/catalog/engine.js, families/ids.js, tiles/tileKey.js and
// tiles/stubPlanner.js. Never tiles/stub.js, the canvas or the kit.
//
// Tile-local frame: storeys 0..2, cells x 0..41 (3 chunks) × z 0..27 (2
// chunks); tile-local cell (gx, gz) of tile (tx, tz) is global
// (tx·42 + gx, tz·28 + gz), tile storey n is world storey n. Chunk index
// i = lx + 3·lz (lx 0..2, lz 0..1).

export const FAMILY = MAP_FAMILY_HOUSE

// The finite kind's dice salt (rng(seed, SALT) in tile.js).
export const SALT = 0x05a1

// The tile (§6.2): 3×2 chunks, backend 'band', one band of three storeys
// (0 ground, 1 first, 2 top). Salt = FAMILY_SALT.house (0x5a170000 + 15).
export const TILE = Object.freeze({ w: 3, d: 2, backend: 'band', H: 3, lo: 0, hi: 2, salt: FAMILY_SALT.house })
export const TILE_W = TILE.w * CHUNK // 42 cells
export const TILE_D = TILE.d * CHUNK // 28 cells
export const FLOORS = 3
export const CHUNKS = 6 // chunk index i = lx + 3·lz
export const ALL_CHUNKS = 0b111111

// §7.2: the planner's attempt budget per hall shape.
export const PICK_ATTEMPTS = 4
export const HALL_SLOT = 0

export const R = (x0, z0, x1, z1) => Object.freeze({ x0, z0, x1, z1 })
const inRect = (r, gx, gz) => gx >= r.x0 && gx <= r.x1 && gz >= r.z0 && gz <= r.z1
const overlaps = (a, b) => a.x0 <= b.x1 && b.x0 <= a.x1 && a.z0 <= b.z1 && b.z0 <= a.z1
const grow = (r, n) => R(r.x0 - n, r.z0 - n, r.x1 + n, r.z1 + n)
export const chunkIndex = (lx, lz) => lx + 3 * lz
export const chunkOf = (i) => ({ lx: i % 3, lz: Math.floor(i / 3) })
export const chunkRect = (i) => R((i % 3) * CHUNK, Math.floor(i / 3) * CHUNK, (i % 3) * CHUNK + CHUNK - 1, Math.floor(i / 3) * CHUNK + CHUNK - 1)

// --- keys and seeds ---------------------------------------------------------------------

export const bandKey = (tx, tz) => tileKeyAt(TILE, tx, tz, 0)
export const planSeedOf = (worldSeed, k) => tileSeed(worldSeed >>> 0, TILE.salt, k)
// Graph depth of a tile from the front door: the tiles join their four
// neighbours through one ground door per seam, so tile depth is Manhattan.
export const depthOf = (tx, tz) => Math.abs(tx) + Math.abs(tz)

// --- the shell (tile 0,0) -----------------------------------------------------------------

// The spawn tile keeps the façade on its hedged yard in its SW corner (the
// kind's shell, the spawn on the yard path). SHELL_ZONE is that corner, kept
// clear of every other part (the yard's hedges are mass); the shell's back
// door opens north onto cell (5, 16), where the house's hallways begin.
export const SHELL_ZONE = R(0, 17, 13, 27)
export const SHELL_BACK = Object.freeze({ gx: 5, gz: 16 })
export const SHELL_CHUNK = 3 // chunk (0, 1): nothing stands above the shell
export const SPAWN_CELLS = Object.freeze([[5, 25], [5, 24], [6, 25], [4, 25], [6, 24], [4, 24]].map(([gx, gz]) => Object.freeze({ gx, gz })))
const SPAWN_CHUNK = Object.freeze({ cx: 0, cz: Math.floor(25 / CHUNK) })

// --- ports (hashed per seam) ----------------------------------------------------------------

// One ground-storey door per seam (§6.5, §6.8), its position a pure function
// of the seam: the seam on the WEST line of tile (tx, tz) opens at row
// westPortRow(tx, tz), the seam on its NORTH line at column northPortCol(tx,
// tz). A tile reads its east port from its east neighbour's west seam and its
// south port from its south neighbour's north seam, so both sides agree.
// The spawn tile's yard corner (SHELL_ZONE) stays clear: its west seam opens
// above the yard and its south seam east of it.
export const PORT_ROWS = Object.freeze([2, 25])
export const PORT_COLS = Object.freeze([2, 39])
const portHash = (worldSeed, tx, tz, side) => hashChain((worldSeed ^ TILE.salt ^ 0x5ea3) | 0, tx, tz, side)
export function westPortRow(worldSeed, tx, tz) {
  const [a, b] = tx === 0 && tz === 0 ? [2, SHELL_ZONE.z0 - 3] : PORT_ROWS
  return a + (portHash(worldSeed >>> 0, tx, tz, 1) % (b - a + 1))
}
export function northPortCol(worldSeed, tx, tz) {
  const [a, b] = tx === 0 && tz === 1 ? [SHELL_ZONE.x1 + 3, PORT_COLS[1]] : PORT_COLS
  return a + (portHash(worldSeed >>> 0, tx, tz, 2) % (b - a + 1))
}
// The four port cells of tile (tx, tz), tile-local: w (x 0), e (x 41), n (z 0), s (z 27).
export function portsOfTile(worldSeed, tx, tz) {
  const seed = worldSeed >>> 0
  return Object.freeze({
    w: Object.freeze({ gx: 0, gz: westPortRow(seed, tx, tz), side: 'w' }),
    e: Object.freeze({ gx: TILE_W - 1, gz: westPortRow(seed, tx + 1, tz), side: 'e' }),
    n: Object.freeze({ gx: northPortCol(seed, tx, tz), gz: 0, side: 'n' }),
    s: Object.freeze({ gx: northPortCol(seed, tx, tz + 1), gz: TILE_D - 1, side: 's' }),
  })
}
// The lane kept clear behind a port: the port cell and the cells inward.
export const PORT_LANE = 3
export function portLane(p) {
  if (p.side === 'w') return R(0, p.gz, PORT_LANE, p.gz)
  if (p.side === 'e') return R(TILE_W - 1 - PORT_LANE, p.gz, TILE_W - 1, p.gz)
  if (p.side === 'n') return R(p.gx, 0, p.gx, PORT_LANE)
  return R(p.gx, TILE_D - 1 - PORT_LANE, p.gx, TILE_D - 1)
}

const NO_PORTS = Object.freeze([])
export function ports(worldSeed, k, side, cy) {
  if (cy !== 0) return NO_PORTS
  if (side === 'west') {
    const a = westPortRow(worldSeed, k.tx, k.tz)
    return Object.freeze([Object.freeze({ a0: a, a1: a })])
  }
  if (side === 'north') {
    const a = northPortCol(worldSeed, k.tx, k.tz)
    return Object.freeze([Object.freeze({ a0: a, a1: a })])
  }
  return NO_PORTS
}

// --- spawn and exit tiles --------------------------------------------------------------------

// The exit tile candidates: depth 3..5 (§12.11) whose six chunks all lie
// 6..16 chunks (Chebyshev) from the spawn chunk (exitBounds), so the Great
// Hall may stand in any of them. Ring order.
export const EXIT_DEPTHS = Object.freeze([3, 5])
export const EXIT_CHUNKS = Object.freeze([6, 16])
export const EXIT_TILES = Object.freeze((() => {
  const out = []
  for (let tz = -EXIT_DEPTHS[1]; tz <= EXIT_DEPTHS[1]; tz++) {
    for (let tx = -EXIT_DEPTHS[1]; tx <= EXIT_DEPTHS[1]; tx++) {
      const d = depthOf(tx, tz)
      if (d < EXIT_DEPTHS[0] || d > EXIT_DEPTHS[1]) continue
      let ok = true
      for (let i = 0; i < CHUNKS && ok; i++) {
        const cx = tx * TILE.w + (i % 3)
        const cz = tz * TILE.d + Math.floor(i / 3)
        const dist = Math.max(Math.abs(cx - SPAWN_CHUNK.cx), Math.abs(cz - SPAWN_CHUNK.cz))
        ok = dist >= EXIT_CHUNKS[0] && dist <= EXIT_CHUNKS[1]
      }
      if (ok) out.push(Object.freeze({ tx, tz }))
    }
  }
  return out
})())

// The exit (anchor) tile: one of EXIT_TILES, pure in the seed.
export function exitTileOf(worldSeed) {
  return EXIT_TILES[hashChain((worldSeed ^ TILE.salt) | 0, 0x0e, 0x17) % EXIT_TILES.length]
}

// The hook's fallback tiles: the rest of the candidates, after the exit tile.
export function exitFallbackTiles(worldSeed) {
  const first = EXIT_TILES.indexOf(exitTileOf(worldSeed))
  return Array.from({ length: EXIT_TILES.length - 1 }, (_, i) => EXIT_TILES[(first + 1 + i) % EXIT_TILES.length])
}

// --- variants ------------------------------------------------------------------------------

// Every tile is one node of the house's interior graph (doc §4.1, §4.4):
//   'shell' tile (0,0): the façade, yard and front door, with a P.T. loop;
//   'rooms' room nodes only;
//   'loop'  room nodes round a P.T. loop of four L-hallways;
//   'hall'  the loop and the Great Hall (3 storeys).
// Weighted by depth (doc §4.1: ordinary rooms near the door, rewiring and
// repeats deeper, the hall at depth); the anchor (exit) tile is forced to
// the Great Hall. Percent weights [rooms, loop, hall] by depth. The variant
// says WHICH set pieces a tile holds; layout.js decides where and how big.
export const VARIANTS = Object.freeze(['rooms', 'loop', 'hall'])
export function variantWeights(depth) {
  if (depth <= 1) return [80, 20, 0]
  if (depth === 2) return [60, 35, 5]
  if (depth <= 4) return [40, 40, 20]
  if (depth <= 7) return [25, 40, 35]
  return [15, 40, 45]
}
const variantRoll = (worldSeed, tx, tz) => hashChain((worldSeed ^ TILE.salt ^ 0x7a71a) | 0, tx, tz) % 100

export function variantAt(worldSeed, tx, tz) {
  const seed = worldSeed >>> 0
  if (tx === 0 && tz === 0) return 'shell'
  const ex = exitTileOf(seed)
  if (tx === ex.tx && tz === ex.tz) return 'hall'
  const w = variantWeights(depthOf(tx, tz))
  let roll = variantRoll(seed, tx, tz)
  for (let i = 0; i < VARIANTS.length; i++) {
    if (roll < w[i]) return VARIANTS[i]
    roll -= w[i]
  }
  return VARIANTS[VARIANTS.length - 1]
}
export const hasHall = (variant) => variant === 'hall'
export const hasLoop = (variant) => variant !== 'rooms'

// --- stair cores ---------------------------------------------------------------------------

// The stairwell's flight directions (structures/slab.js STAIR_N/E/S/W; the
// family test cross-checks them).
export const DIR = Object.freeze({ N: 0, E: 1, S: 2, W: 3 })
const AXIS = Object.freeze({
  [DIR.E]: { a: [1, 0], p: [0, 1] },
  [DIR.W]: { a: [-1, 0], p: [0, 1] },
  [DIR.S]: { a: [0, 1], p: [1, 0] },
  [DIR.N]: { a: [0, -1], p: [1, 0] },
})

// The enclosed core of an authored stairwell at tile-local cell (gx, gz)
// flying `dir` (structures/authored.js stairwellPlan: the 6×4 cells round
// the flights, with the halo) and its one door (stairwellDoor: the middle of
// the near or far long side) with the cell outside it. Pure arithmetic: the
// family test checks it against stairwellPlan.
export function stairCore(gx, gz, dir, doorSide) {
  const ax = AXIS[dir]
  const xs = []
  const zs = []
  for (const along of [-1, 4]) {
    for (const across of [-1, 2]) {
      xs.push(gx + ax.a[0] * along + ax.p[0] * across)
      zs.push(gz + ax.a[1] * along + ax.p[1] * across)
    }
  }
  const core = R(Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs))
  const horizontal = dir === DIR.E || dir === DIR.W
  const far = doorSide === 'far'
  let door
  if (horizontal) {
    const x = Math.floor((core.x0 + core.x1) / 2)
    door = far ? { axis: 'h', gx: x, gz: core.z1 + 1, out: { gx: x, gz: core.z1 + 1 } } : { axis: 'h', gx: x, gz: core.z0, out: { gx: x, gz: core.z0 - 1 } }
  } else {
    const z = Math.floor((core.z0 + core.z1) / 2)
    door = far ? { axis: 'v', gx: core.x1 + 1, gz: z, out: { gx: core.x1 + 1, gz: z } } : { axis: 'v', gx: core.x0, gz: z, out: { gx: core.x0 - 1, gz: z } }
  }
  return { core, door }
}

// --- the Great Hall -----------------------------------------------------------------------

// A hall shape inside one chunk, chunk-local: the void (w × d), the gallery
// strip of 5 rows on side S, N or E (the automatic flights climb it), the
// bounds (void grown by 1, the gallery side by the gallery) and the ring
// (bounds grown by 1), which stays inside local 0..12. The table lists the
// shapes measured to assemble (SP/proc-house/hallcfg.mjs: every shape below
// assembles for 40/40 plan seeds); the gallery must be 5 rows (two stacked
// flights) and the strip must sit in [2..11]² of its chunk.
export const GALLERY = 5
export const HALL_SHAPES = Object.freeze((() => {
  const out = []
  for (let w = 5; w <= 9; w++) {
    for (const d of [4, 5]) {
      // S: ring x rx..rx+w+3, z rz..rz+d+7.
      for (let rx = 0; rx + w + 3 <= 12; rx++) for (let rz = 0; rz + d + 7 <= 12; rz++) out.push({ side: 'S', w, d, rx, rz })
      // N: the ring one row down (rz 1), d 4.
      if (d === 4) for (let rx = 0; rx + w + 3 <= 12; rx++) out.push({ side: 'N', w, d, rx, rz: 1 })
    }
  }
  // E: void 5 wide, ring x 0..12.
  for (let d = 4; d <= 7; d++) for (let rz = 0; rz + d + 3 <= 12; rz++) out.push({ side: 'E', w: 5, d, rx: 0, rz })
  return out.map((s) => Object.freeze(s))
})())

// The tile-local geometry of hall shape `s` in chunk i.
export function hallGeometry(s, i) {
  const o = chunkRect(i)
  const vx0 = o.x0 + s.rx + 2
  const vz0 = o.z0 + s.rz + 2 + (s.side === 'N' ? GALLERY - 1 : 0)
  const v = R(vx0, vz0, vx0 + s.w - 1, vz0 + s.d - 1)
  const b = { x0: v.x0 - 1, z0: v.z0 - 1, x1: v.x1 + 1, z1: v.z1 + 1 }
  if (s.side === 'S') b.z1 = v.z1 + GALLERY
  if (s.side === 'N') b.z0 = v.z0 - GALLERY
  if (s.side === 'E') b.x1 = v.x1 + GALLERY
  const bounds = R(b.x0, b.z0, b.x1, b.z1)
  const ring = grow(bounds, 1)
  // The overlook: the void's edge row/column on the gallery side (the rail).
  const overlook = s.side === 'S' ? v.z1 + 1 : s.side === 'N' ? v.z0 - 1 : v.x1 + 1
  // The exit: under the void, its corner farthest from the gallery; the
  // fallbacks walk the rest of the void floor in a fixed order.
  const exit = s.side === 'S' ? { gx: v.x1, gz: v.z0 + 1 } : s.side === 'N' ? { gx: v.x1, gz: v.z1 - 1 } : { gx: v.x0 + 1, gz: v.z1 }
  const fallbacks = []
  for (let gz = v.z0; gz <= v.z1; gz++) for (let gx = v.x0; gx <= v.x1; gx++) if (gx !== exit.gx || gz !== exit.gz) fallbacks.push({ gx, gz })
  return Object.freeze({ chunk: i, shape: s, side: s.side, void: v, bounds, ring, overlook, exit: Object.freeze(exit), fallbacks: Object.freeze(fallbacks) })
}

// §7.4: an atrium spec (the void rect, its storeys, its gallery strip and
// side) as a catalog volume — bounds = the void grown by 1, the gallery side
// by the gallery rows instead; the void on every storey above the base,
// automatic flights, rails. Returns { plan, meta } with meta.slot and
// meta.baseCy local.
export function atriumAsCatalog(spec) {
  const v = R(spec.x0, spec.z0, spec.x1, spec.z1)
  const gallery = Math.max(1, spec.gallery ?? 0)
  const side = spec.gallerySide ?? 'S'
  const b = { x0: v.x0 - 1, z0: v.z0 - 1, x1: v.x1 + 1, z1: v.z1 + 1 }
  if (side === 'S') b.z1 = v.z1 + gallery
  if (side === 'N') b.z0 = v.z0 - gallery
  if (side === 'E') b.x1 = v.x1 + gallery
  if (side === 'W') b.x0 = v.x0 - gallery
  const levels = Array.from({ length: spec.levels }, (_, k) => (k === 0 ? { voids: [] } : { voids: [{ ...v }] }))
  return {
    plan: { label: 'great hall', bounds: b, levels, columns: [], piers: [], core: null, links: 'auto', glazing: 'rail' },
    meta: { slot: spec.slot ?? HALL_SLOT, baseCy: spec.baseCy, type: 'greatHall', sizeClass: 'medium' },
  }
}

// The kit.atrium spec of a hall geometry (tile-local cells).
export const hallSpec = (h) => Object.freeze({
  ...h.void, baseCy: 0, levels: FLOORS, kind: 'openVoid', gallery: GALLERY, gallerySide: h.side, slot: HALL_SLOT,
})

// --- the frame -------------------------------------------------------------------------------

const N4 = Object.freeze([[1, 0], [-1, 0], [0, 1], [0, -1]])
const chunkNeighbours = (i) => {
  const { lx, lz } = chunkOf(i)
  const out = []
  for (const [dx, dz] of N4) {
    const x = lx + dx
    const z = lz + dz
    if (x >= 0 && x < 3 && z >= 0 && z < 2) out.push(chunkIndex(x, z))
  }
  return out
}
const bitsOf = (mask) => Array.from({ length: CHUNKS }, (_, i) => i).filter((i) => (mask >> i) & 1)

// A connected chunk set inside `allowed` holding every `need` chunk, grown
// at random to `size` chunks (or as far as `allowed` reaches).
function connectedMask(rnd, need, allowed, size) {
  let mask = 0
  for (const i of need) mask |= 1 << i
  // Join the needed chunks: BFS from the set to each other needed chunk.
  const joined = () => {
    const seen = new Set([need[0]])
    const q = [need[0]]
    while (q.length) {
      const i = q.shift()
      for (const j of chunkNeighbours(i)) if (((mask >> j) & 1) && !seen.has(j)) { seen.add(j); q.push(j) }
    }
    return need.every((i) => seen.has(i))
  }
  for (let guard = 0; !joined() && guard < 6; guard++) {
    // Add the allowed chunk adjacent to the set that is nearest the first
    // unjoined chunk (ties by index).
    const seen = new Set([need[0]])
    const q = [need[0]]
    while (q.length) {
      const i = q.shift()
      for (const j of chunkNeighbours(i)) if (((mask >> j) & 1) && !seen.has(j)) { seen.add(j); q.push(j) }
    }
    const target = need.find((i) => !seen.has(i))
    const t = chunkOf(target)
    let best = -1
    let bestD = Infinity
    for (const i of seen) {
      for (const j of chunkNeighbours(i)) {
        if ((mask >> j) & 1 || !((allowed >> j) & 1)) continue
        const c = chunkOf(j)
        const dd = Math.abs(c.lx - t.lx) + Math.abs(c.lz - t.lz)
        if (dd < bestD) [bestD, best] = [dd, j]
      }
    }
    if (best < 0) break
    mask |= 1 << best
  }
  while (bitsOf(mask).length < size) {
    const opts = []
    for (const i of bitsOf(mask)) for (const j of chunkNeighbours(i)) if (!((mask >> j) & 1) && ((allowed >> j) & 1) && !opts.includes(j)) opts.push(j)
    if (!opts.length) break
    opts.sort((a, b) => a - b)
    mask |= 1 << opts[rnd.int(0, opts.length - 1)]
  }
  return mask
}

// A stair core in chunk i clear of `avoid` (rects): its 6×4 core, the
// halo round it and its door's outside cell all inside the chunk's local
// 1..12 (stairwellPlan: strictly inside one chunk, the halo too).
function placeStair(rnd, i, avoid) {
  const o = chunkRect(i)
  for (let attempt = 0; attempt < 64; attempt++) {
    const dir = rnd.int(0, 3)
    const doorSide = rnd.chance(0.5) ? 'far' : 'near'
    const gx = o.x0 + rnd.int(1, 12)
    const gz = o.z0 + rnd.int(1, 12)
    const { core, door } = stairCore(gx, gz, dir, doorSide)
    const halo = grow(core, 1)
    const inner = R(o.x0 + 1, o.z0 + 1, o.x1 - 1, o.z1 - 1)
    if (!inRect(inner, halo.x0, halo.z0) || !inRect(inner, halo.x1, halo.z1)) continue
    if (!inRect(inner, door.out.gx, door.out.gz)) continue
    const keep = R(Math.min(halo.x0, door.out.gx), Math.min(halo.z0, door.out.gz), Math.max(halo.x1, door.out.gx), Math.max(halo.z1, door.out.gz))
    if (avoid.some((r) => overlaps(r, keep))) continue
    return { gx, gz, dir, doorSide, core, door, chunk: i }
  }
  return null
}

// The frame of tile (tx, tz): pure in (worldSeed, tx, tz), memoised.
//   variant  geometry.variantAt
//   ports    { w, e, n, s } port cells (hashed per seam)
//   stairs   1..2 enclosed stair cores { gx, gz, dir, doorSide, core, door,
//            chunk, top } (the first climbs 0..2, a second 0..1 or 0..2)
//   hallChunk  the Great Hall's chunk (hall tiles) or -1; hallShapes the
//            hall shapes to try, in order (structures.js assembles the first
//            that holds; hallOf below)
//   up       [mask cy 0, mask cy 1, mask cy 2]: the chunks each storey keeps
//            (storey 0 all six; the upper storeys a connected set holding
//            the stair cores and the hall — every tile stacks differently)
const FRAMES = new Map()
const FRAME_MAX = 2048
export function frameOf(worldSeed, tx, tz) {
  const seed = worldSeed >>> 0
  const key = `${seed}|${tx},${tz}`
  let f = FRAMES.get(key)
  if (f) return f
  f = buildFrame(seed, tx, tz)
  FRAMES.set(key, f)
  if (FRAMES.size > FRAME_MAX) FRAMES.delete(FRAMES.keys().next().value)
  return f
}

function buildFrame(seed, tx, tz) {
  const rnd = new RNG(hashChain((seed ^ TILE.salt ^ 0xf4a3e) | 0, tx, tz))
  const variant = variantAt(seed, tx, tz)
  const shell = variant === 'shell'
  const portCells = portsOfTile(seed, tx, tz)
  const avoid = [portLane(portCells.w), portLane(portCells.e), portLane(portCells.n), portLane(portCells.s)]
  if (shell) avoid.push(grow(SHELL_ZONE, 1), R(SHELL_BACK.gx - 1, SHELL_BACK.gz - 1, SHELL_BACK.gx + 1, SHELL_BACK.gz))
  const upAllowed = shell ? ALL_CHUNKS & ~(1 << SHELL_CHUNK) : ALL_CHUNKS
  const order = rnd.shuffle([0, 1, 2, 3, 4, 5])

  // The Great Hall's chunk and its shapes (hashed order, clear of the lanes).
  let hallChunk = -1
  let hallShapes = []
  if (hasHall(variant)) {
    for (const i of order) {
      const shapes = rnd.shuffle(HALL_SHAPES.filter((s) => {
        const g = hallGeometry(s, i)
        return !avoid.some((r) => overlaps(r, g.ring))
      }))
      if (shapes.length) {
        hallChunk = i
        hallShapes = shapes.slice(0, 8)
        break
      }
    }
  }
  const hallRing = hallChunk >= 0 ? chunkRect(hallChunk) : null

  // The main stair core (storeys 0..2), then perhaps a second (0..1 or 0..2)
  // in another chunk: a back stair, a loop between the storeys.
  const stairs = []
  for (const i of order) {
    if (i === hallChunk || !((upAllowed >> i) & 1)) continue
    const s = placeStair(rnd, i, [...avoid, ...(hallRing ? [hallRing] : [])])
    if (s) {
      stairs.push({ ...s, top: 2 })
      break
    }
  }
  if (rnd.chance(0.4)) {
    for (const i of rnd.shuffle([0, 1, 2, 3, 4, 5])) {
      if (i === hallChunk || i === stairs[0]?.chunk || !((upAllowed >> i) & 1)) continue
      const s = placeStair(rnd, i, avoid)
      if (s) {
        stairs.push({ ...s, top: rnd.chance(0.5) ? 2 : 1 })
        break
      }
    }
  }

  // The storeys' chunk sets (vertical stacking).
  const need1 = [...stairs.map((s) => s.chunk), ...(hallChunk >= 0 ? [hallChunk] : [])]
  const need2 = [...stairs.filter((s) => s.top >= 2).map((s) => s.chunk), ...(hallChunk >= 0 ? [hallChunk] : [])]
  const n1 = [5, 6, 6][rnd.int(0, 2)]
  const up1 = connectedMask(rnd, need1, upAllowed, n1)
  // The top storey keeps all of the first storey's chunks or all but one (at
  // least 5): a smaller top left too few masks, so tiles repeated the same
  // footprint-solid mass up there (the variety gate).
  const n2 = Math.max(5, need2.length, bitsOf(up1).length - rnd.int(0, 2))
  const up2 = connectedMask(rnd, need2, up1, n2)
  return Object.freeze({
    tx, tz, variant,
    ports: portCells,
    stairs: Object.freeze(stairs.map((s) => Object.freeze(s))),
    hallChunk,
    hallShapes: Object.freeze(hallShapes),
    up: Object.freeze([ALL_CHUNKS, up1, up2]),
  })
}

// §6.5 footprint: storey 0 is all six chunks; storeys 1..2 the frame's
// chunk sets (a connected set holding the stair cores and the Great Hall).
// Everything else is solid mass, never baked.
export function footprint(worldSeed, cx, cy, cz) {
  const k = tileKeyOf(TILE, cx, cy, cz)
  if (!k) return 'solid'
  if (cy === 0) return 'tile'
  const f = frameOf(worldSeed, k.tx, k.tz)
  return (f.up[cy] >> chunkIndex(cx - k.origin.cx, cz - k.origin.cz)) & 1 ? 'tile' : 'solid'
}

// Stair slots of a tile (§7.2, the streaming hint): every stair core's chunk
// holds a flight up on each storey below its top.
export function stairSlots(worldSeed, tx, tz) {
  const out = []
  for (const s of frameOf(worldSeed, tx, tz).stairs) {
    for (let cy = 0; cy < s.top; cy++) out.push(Object.freeze({ ...chunkOf(s.chunk), lowerCy: cy }))
  }
  return Object.freeze(out)
}

// --- the Great Hall volume (assembled at TRUE GLOBAL coordinates) ---------------------------

const shiftRect = (r, dx, dz) => ({ x0: r.x0 + dx, z0: r.z0 + dz, x1: r.x1 + dx, z1: r.z1 + dz })
function translatePlan(plan, origin) {
  const dx = origin.cx * CHUNK
  const dz = origin.cz * CHUNK
  return {
    ...plan,
    bounds: shiftRect(plan.bounds, dx, dz),
    levels: plan.levels.map((l) => ({ voids: (l.voids ?? []).map((r) => shiftRect(r, dx, dz)) })),
  }
}

// The hall of tile k: { geometry (tile-local), desc (the frozen descriptor)
// } or null (no hall). The frame's shapes are tried in order, each with
// PICK_ATTEMPTS flight picks; the first that assembles is the hall. Memoised.
const HALLS = new Map()
const HALL_MAX = 512
export function hallOf(worldSeed, k) {
  const seed = worldSeed >>> 0
  const key = `${seed}|${k.tx},${k.tz},${k.band}`
  if (HALLS.has(key)) {
    const hit = HALLS.get(key)
    HALLS.delete(key)
    HALLS.set(key, hit)
    return hit
  }
  const out = assembleHall(seed, k)
  HALLS.set(key, out)
  if (HALLS.size > HALL_MAX) HALLS.delete(HALLS.keys().next().value)
  return out
}

function assembleHall(seed, k) {
  const f = frameOf(seed, k.tx, k.tz)
  if (f.hallChunk < 0) return null
  const planSeed = planSeedOf(seed, k)
  const meta = {
    id: structureId(seed, FAMILY, k, HALL_SLOT),
    family: FAMILY,
    type: 'greatHall',
    sizeClass: 'medium',
    district: { x: k.tx, z: k.tz, size: TILE.w },
    bandIndex: k.band,
    slot: HALL_SLOT,
    baseCy: k.origin.cy,
  }
  // The measured shapes first, then the whole table as a last resort.
  const shapes = [...f.hallShapes, ...HALL_SHAPES]
  for (const s of shapes) {
    const g = hallGeometry(s, f.hallChunk)
    const { plan } = atriumAsCatalog(hallSpec(g))
    const world = translatePlan(plan, k.origin)
    for (let attempt = 0; attempt < PICK_ATTEMPTS; attempt++) {
      const desc = assembleCatalogDescriptor(world, meta, planPick(planSeed, HALL_SLOT, attempt))
      if (desc) return Object.freeze({ geometry: g, desc })
    }
  }
  return null
}

// --- anomalies -----------------------------------------------------------------------------

// Per-tile anomaly (§12.0, §12.11; doc 14: House, 1 per 3 room nodes,
// scaled with depth; a tile is one node of the world's house graph). Hashed
// per tile (hashChain, mirror-free):
//   present with p(depth) = ANOMALY_RATE_OF_16(depth) / 16 (≈ 1 per 3 at
//           depth 2, rising to 7 of 8 deep), never within Chebyshev 1 of the
//           spawn tile (spawn storey ±1 near spawn), never on the exit tile;
//   class   'loop' (one L of the P.T. loop mutated, LOOP_ANOMALIES, needs a
//           loop), 'red' (the red hallway: the tile's longest hallway burns
//           red) or 'copy' (the copied room: a room again, next door);
//   rotate  greedy in priority order (poolrooms' anomalyAt): a tile takes its
//           preferred class unless an edge neighbour of higher priority
//           holds it, else the next allowed class, else none; no two
//           edge-adjacent tiles share a class. Pure and order-independent.
export const ANOMALY_CLASSES = Object.freeze(['loop', 'red', 'copy'])
export const LOOP_ANOMALIES = Object.freeze(['dark', 'red', 'turned', 'noClock', 'missingDoor', 'extraDoor'])
export const EXIT_Q = 3 // the SE closet is also the way on
export function anomalyRateOf16(depth) {
  if (depth <= 2) return 6
  if (depth <= 4) return 9
  if (depth <= 7) return 12
  return 14
}
const anomalyHash = (worldSeed, tx, tz) => hashChain((worldSeed ^ TILE.salt ^ 0x0a40a1) | 0, tx, tz, 0x3a)
const EDGE_NEIGHBOURS = Object.freeze([[1, 0], [-1, 0], [0, 1], [0, -1]])

function rawAnomaly(worldSeed, tx, tz, ex) {
  if (Math.max(Math.abs(tx), Math.abs(tz)) <= 1) return null
  if (ex.tx === tx && ex.tz === tz) return null
  const h = anomalyHash(worldSeed, tx, tz)
  if ((h & 15) >= anomalyRateOf16(depthOf(tx, tz))) return null
  const allowed = hasLoop(variantAt(worldSeed, tx, tz)) ? [0, 1, 2] : [1, 2]
  return { pref: allowed[((h >>> 4) & 0xff) % allowed.length], allowed, pri: h >>> 12, tx, tz }
}

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
  const start = me.allowed.indexOf(me.pref)
  for (let i = 0; i < me.allowed.length; i++) {
    const c = me.allowed[(start + i) % me.allowed.length]
    if (!taken.has(c)) {
      out = c
      break
    }
  }
  memo.set(key, out)
  return out
}

// The tile's anomaly: null, or { cls, loop?: { anomaly, q } } where a loop
// anomaly names the mutated L (q ∈ 1..3; 'missingDoor' never takes the exit
// closet's L) and its LOOP_ANOMALIES class.
export function anomalyAt(worldSeed, k) {
  const seed = worldSeed >>> 0
  const ex = exitTileOf(seed)
  const me = rawAnomaly(seed, k.tx, k.tz, ex)
  if (!me) return null
  const c = finalClass(seed, me, ex, new Map())
  if (c < 0) return null
  const cls = ANOMALY_CLASSES[c]
  if (cls !== 'loop') return { cls }
  const h = hashChain(anomalyHash(seed, k.tx, k.tz) ^ 0x100b, k.tx, k.tz)
  const anomaly = LOOP_ANOMALIES[h % LOOP_ANOMALIES.length]
  let q = 1 + ((h >>> 8) % 3)
  if (anomaly === 'missingDoor' && q === EXIT_Q) q = 1
  return { cls, loop: { anomaly, q } }
}

// --- labels --------------------------------------------------------------------------------

// Storey plates (§12.0: pure in (worldSeed, tile, cy); ≤ 4 NUMERAL_GLYPHS).
// The house counts its floors honestly by the door; deeper in, the top
// storey's plate reads a floor the roof cannot hold ("a stair that climbs on
// past the roof line"): 3F + up to depth − 2 more.
export function labelOf(worldSeed, k, cy) {
  if (cy < 2) return `${cy + 1}F`
  const d = depthOf(k.tx, k.tz)
  if (d < 3) return '3F'
  const extra = hashChain((worldSeed ^ TILE.salt ^ 0x1abe1) | 0, k.tx, k.tz) % (d - 1)
  return `${Math.min(99, 3 + extra)}F`
}

// --- exit anchor ---------------------------------------------------------------------------

// §8.2 exit anchor: the Great Hall floor's exit cell of tile (tx, tz) (cy 0),
// or (no hall) the tile's first stair door outside cell.
export function exitCellsOfTile(worldSeed, tx, tz) {
  const h = hallOf(worldSeed, bandKey(tx, tz))
  if (!h) return []
  return [h.geometry.exit, ...h.geometry.fallbacks]
}

export function exitAnchorOfTile(worldSeed, tx, tz) {
  const cells = exitCellsOfTile(worldSeed, tx, tz)
  const c = cells[0] ?? frameOf(worldSeed, tx, tz).stairs[0].door.out
  const gx = tx * TILE_W + c.gx
  const gz = tz * TILE_D + c.gz
  const cx = Math.floor(gx / CHUNK)
  const cz = Math.floor(gz / CHUNK)
  return { cx, cy: 0, cz, lx: gx - cx * CHUNK, lz: gz - cz * CHUNK }
}

export function exitAnchor(worldSeed) {
  const t = exitTileOf(worldSeed >>> 0)
  return exitAnchorOfTile(worldSeed >>> 0, t.tx, t.tz)
}
