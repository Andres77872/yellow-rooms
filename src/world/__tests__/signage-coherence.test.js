import { describe, it, expect } from 'vitest'
import { generateChunk } from '../generate.js'
import { worldConfigForFamily } from '../mapFamily.js'
import { BLADE_SIGN_H, CELL, CHUNK, DOOR_LEAF_FRACTION, EXIT_SIGN_Y, EXT_STEP, THICK, WALL_H, cIdx, hIdx, vIdx } from '../constants.js'
import {
  CELL_ATRIUM,
  CELL_CORRIDOR,
  CELL_LOBBY,
  CELL_STAIR,
  CELL_VOID,
  MAP_FAMILY_HOTEL,
  MAP_FAMILY_LATTICE,
  MAP_FAMILY_OFFICE,
  MAP_FAMILY_SEWER,
  MAP_FAMILY_TOWER,
  PASSAGE_DOOR,
  SPACE_ROLE_DINING,
  SPACE_ROLE_LIBRARY,
  SPACE_ROLE_LOUNGE,
  SPACE_ROLE_MEETING,
  SPACE_ROLE_SERVER,
  WALL_PLAIN,
} from '../mapTypes.js'
import {
  DECAL_KINDS,
  SAFETY_NOTICES,
  SEWER_LARGE_PLATES,
  SEWER_SMALL_PLATES,
  WAYFINDING,
  decalKindOf,
  signCell,
  signCellFor,
  signIdFor,
  signPlateAt,
} from '../decalKinds.js'
import { DOOR_EGRESS, DOOR_GUEST, DOOR_INTERNAL, DOOR_ROOM, edgeCells, edgeContext } from '../doorFunction.js'
import { collectDoorways, doorwayAt } from '../doors.js'
import { SPACE_ROOM, ZONE_SOFT, ZONE_WET, roomContext, worldSurfaceSet } from '../surfaceSet.js'
import { collectInteriorDressing, PROP_TINT, SIGN_TINT } from '../objects/dressing/index.js'
import { DERELICT, NUMERAL_GLYPHS, doorNumber, signagePlan, storeyNumber } from '../objects/dressing/notices.js'
import { ACCENT_CYCLE } from '../objects/dressing/palette.js'
import { dressTowerLandmarkSockets } from '../objects/dressing/towerSockets.js'
import { structureAt } from '../structures/contract.js'
import { familiesWith } from '../families/registry.js'

// Office-semantics matrix: only the building families (spec §11.4). The
// liminal families have their own per-family suites.
const BUILDING_FAMILIES = familiesWith('buildingMatrices')

// World-scale coherence of the signage, measured on generated blocks of
// every family: a sign says what the space it names IS, it hangs where a
// building would hang it, and the odd ones out live in the derelict wings.
const SEEDS = [4242, 77]
const N = 6 // chunks per side
const OFFICE_LAYER = [MAP_FAMILY_OFFICE, MAP_FAMILY_TOWER, MAP_FAMILY_HOTEL]

const mod = (v, n) => ((v % n) + n) % n

// Where a wall plate (or a wall-hugging box) hangs: its wall edge, the face
// it shows on, and the chunk-local cell that face looks into.
function faceOf(p) {
  const vertical = p.sx < p.sz
  const across = vertical ? p.px : p.pz
  const line = Math.round(across / CELL)
  const side = across > line * CELL ? 1 : -1
  const cell = Math.floor((vertical ? p.pz : p.px) / CELL)
  const lx = vertical ? line + (side > 0 ? 0 : -1) : cell
  const lz = vertical ? cell : line + (side > 0 ? 0 : -1)
  const inside = lx >= 0 && lx < CHUNK && lz >= 0 && lz < CHUNK
  return { axis: vertical ? 'v' : 'h', vertical, line, cell, side, lx, lz, inside }
}

const passageAt = (d, axis, line, cell) => (axis === 'v' ? d.passageV[vIdx(line, cell)] : d.passageH[hIdx(cell, line)])
const wallAt = (d, axis, line, cell) => (axis === 'v' ? d.wallV[vIdx(line, cell)] : d.wallH[hIdx(cell, line)])
const edgeKey = (axis, line, cell) => `${axis}${line},${cell}`

function block(family, seed, cy = 0, n = N) {
  const config = worldConfigForFamily(family)
  const set = worldSurfaceSet(family, seed)
  const chunks = []
  for (let cz = 0; cz < n; cz++) {
    for (let cx = 0; cx < n; cx++) {
      const d = generateChunk(seed, cx, cy, cz, config)
      chunks.push({ d, out: collectInteriorDressing(d), plan: signagePlan(d, set) })
    }
  }
  return { family, seed, set, chunks, at: (cx, cz) => (cx >= 0 && cx < n && cz >= 0 && cz < n ? chunks[cz * n + cx].d : null) }
}

const blocks = new Map()
const worldOf = (family, seed) => {
  const key = `${family}|${seed}`
  if (!blocks.has(key)) blocks.set(key, block(family, seed))
  return blocks.get(key)
}
const eachWorld = (fn, families = BUILDING_FAMILIES) => {
  for (const family of families) for (const seed of SEEDS) fn(worldOf(family, seed))
}

// Every doorway of a chunk with its class, and the header signs on it.
function doorsOf({ d, out }) {
  const signs = new Map()
  for (const p of out.decals) {
    if (decalKindOf(p.cell) !== 'sign' || Math.abs(p.py - EXIT_SIGN_Y) > 1e-9) continue
    const f = faceOf(p)
    const key = edgeKey(f.axis, f.line, f.cell)
    if (!signs.has(key)) signs.set(key, [])
    signs.get(key).push({ p, f })
  }
  const doors = []
  for (const axis of ['v', 'h']) {
    for (let line = 0; line < CHUNK; line++) {
      for (let cell = 0; cell < CHUNK; cell++) {
        if (wallAt(d, axis, line, cell) === 1 || passageAt(d, axis, line, cell) !== PASSAGE_DOOR) continue
        doors.push({ axis, line, cell, ctx: edgeContext(d, axis, line, cell), signs: signs.get(edgeKey(axis, line, cell)) ?? [] })
      }
    }
  }
  return { doors, signs }
}

// Is the face at (axis, line, c) a free plain wall face, where a plate or a
// cabinet can hang (no doorway beside it, where an open leaf lies flat)?
function freeWall(d, axis, line, c) {
  if (c < 0 || c >= CHUNK || wallAt(d, axis, line, c) !== 1) return false
  const feature = axis === 'v' ? d.wallFeatureV[vIdx(line, c)] : d.wallFeatureH[hIdx(c, line)]
  const door = (k) => k >= 0 && k < CHUNK && passageAt(d, axis, line, k) === PASSAGE_DOOR
  return feature === WALL_PLAIN && !door(c - 1) && !door(c + 1)
}

const inChunk = (lx, lz) => lx >= 0 && lx < CHUNK && lz >= 0 && lz < CHUNK
const openStep = (d, lx, lz, dx, dz) => inChunk(lx + dx, lz + dz) &&
  (dx ? d.wallV[vIdx(Math.max(lx, lx + dx), lz)] : d.wallH[hIdx(lx, Math.max(lz, lz + dz))]) !== 1

// The storey's stair ends, read straight from the chunk: the up stair's
// landing and the down stair's exit (any stair cell when it has neither).
function stairEndsOf(d) {
  const ends = []
  if (d.stairUp?.landing) ends.push({ ...d.stairUp.landing, up: true })
  if (d.stairDown?.exit) ends.push({ ...d.stairDown.exit, up: false })
  if (ends.length) return ends
  for (let lz = 0; lz < CHUNK; lz++) {
    for (let lx = 0; lx < CHUNK; lx++) if (d.cellKind[cIdx(lx, lz)] === CELL_STAIR) ends.push({ lx, lz, up: null })
  }
  return ends
}

// Walking distance from every cell to each stair end, by breadth-first
// search through open edges (never over a slab opening or up the flight).
function stairRoutes(d) {
  const flight = new Set((d.stairUp?.run ?? []).map((c) => cIdx(c.lx, c.lz)))
  const walk = (x, z) => {
    const k = d.cellKind[cIdx(x, z)]
    return k !== CELL_ATRIUM && k !== CELL_VOID && !d.hasFloorHole(x, z) && !flight.has(cIdx(x, z))
  }
  return stairEndsOf(d).filter((e) => inChunk(e.lx, e.lz)).map((end) => {
    const dist = new Int16Array(CHUNK * CHUNK).fill(-1)
    dist[cIdx(end.lx, end.lz)] = 0
    const queue = [[end.lx, end.lz]]
    while (queue.length) {
      const [x, z] = queue.shift()
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (!openStep(d, x, z, dx, dz) || dist[cIdx(x + dx, z + dz)] >= 0 || !walk(x + dx, z + dz)) continue
        dist[cIdx(x + dx, z + dz)] = dist[cIdx(x, z)] + 1
        queue.push([x + dx, z + dz])
      }
    }
    return { end, dist }
  })
}

const sameTint = (a, b) => Boolean(a && b) && a.length === b.length && a.every((v, i) => v === b[i])

// The exit-sign rules on one chunk: emergency green only over the escape
// route's doors and hung at the mouths of the stair flights, every such door
// and stair end lit — in every family that signs its escape route (the
// lattice's fire doors and stair ends included); the sewer lights none.
// `at` reads a neighbour from the same block, for the seam-door rules.
function checkExits(family, d, out, at = () => null) {
  if (family === MAP_FAMILY_SEWER) {
    for (const list of [out.signs, out.props, out.trim]) {
      expect(list.filter((b) => sameTint(b.tint, SIGN_TINT.exit)), 'sewer exit sign').toEqual([])
    }
    return
  }
  const lit = new Map()
  const hung = new Set()
  for (const b of out.signs) {
    if (!sameTint(b.tint, SIGN_TINT.exit)) continue
    const f = faceOf(b)
    const key = edgeKey(f.axis, f.line, f.cell)
    if (Math.abs((f.vertical ? b.px : b.pz) - f.line * CELL) > 0.25) {
      // Hung at the mouth of a stair flight, over the stair end.
      const end = stairEndsOf(d).find((e) => e.lx === f.lx && e.lz === f.lz)
      expect(end, `${family} exit sign hung off the stairs`).toBeDefined()
      const run = end.up ? d.stairUp.run : d.stairDown.run
      const [nx, nz] = f.vertical ? [f.lx - f.side, f.lz] : [f.lx, f.lz - f.side]
      expect(run.some((c) => c.lx === nx && c.lz === nz), `${family} exit sign off the flight`).toBe(true)
      hung.add(`${f.lx},${f.lz}`)
      continue
    }
    lit.set(key, (lit.get(key) ?? 0) + 1)
    expect(passageAt(d, f.axis, f.line, f.cell), `${family} exit sign off a doorway`).toBe(PASSAGE_DOOR)
    const ctx = edgeContext(d, f.axis, f.line, f.cell)
    expect(ctx.fn, `${family} exit sign`).toBe(DOOR_EGRESS)
    if (!ctx.partial) continue
    // A seam door: a district portal (the next district's routed corridor
    // meets this one), else lit only for a stair on its own side — and never
    // over a door whose far side (generated beside it) is a room.
    const { lo, hi } = edgeCells(f.axis, f.line, f.cell)
    const own = lo ?? hi
    if (!ctx.portal) expect(d.cellKind[cIdx(own.lx, own.lz)], `${family} seam exit`).not.toBe(CELL_LOBBY)
    const far = f.vertical ? at(d.cx - 1, d.cz) : at(d.cx, d.cz - 1)
    if (far && !lo) {
      const [fx, fz] = f.vertical ? [CHUNK - 1, f.cell] : [f.cell, CHUNK - 1]
      expect(roomContext(far, fx, fz).cls, `${family} exit into a room`).not.toBe(SPACE_ROOM)
    }
  }
  for (const door of doorsOf({ d, out }).doors) {
    if (door.ctx.fn !== DOOR_EGRESS) continue
    const { lo, hi } = edgeCells(door.axis, door.line, door.cell)
    if ([lo, hi].some((c) => c && d.hasFloorHole(c.lx, c.lz))) continue
    if (door.ctx.partial && !door.ctx.portal && d.cellKind[cIdx((lo ?? hi).lx, (lo ?? hi).lz)] === CELL_LOBBY) continue
    expect(lit.get(edgeKey(door.axis, door.line, door.cell)) ?? 0, `${family} unlit fire door`).toBeGreaterThanOrEqual(2)
  }
  // Every stair end lights the mouth of its flight, unless a doorway across
  // the mouth carries the sign or there is no ceiling to hang it from.
  for (const end of stairEndsOf(d)) {
    if (end.up === null || !inChunk(end.lx, end.lz) || d.hasCeilHole(end.lx, end.lz)) continue
    const run = end.up ? d.stairUp.run : d.stairDown.run
    const next = run.find((c) => Math.abs(c.lx - end.lx) + Math.abs(c.lz - end.lz) === 1)
    if (!next) continue
    const vertical = next.lx !== end.lx
    const line = vertical ? Math.max(next.lx, end.lx) : Math.max(next.lz, end.lz)
    if (passageAt(d, vertical ? 'v' : 'h', line, vertical ? end.lz : end.lx) === PASSAGE_DOOR) continue
    expect(hung.has(`${end.lx},${end.lz}`), `${family} dark stair end`).toBe(true)
  }
}

const WALL_ITEMS = new Set(['clock', 'calendar', 'poster', 'chart', 'photo', 'art', 'safety'])

describe('signage coherence on generated worlds', () => {
  it('names a door after the room it serves, once, on the corridor face', () => {
    eachWorld(({ family, chunks }) => {
      let signed = 0
      for (const chunk of chunks) {
        const { doors, signs } = doorsOf(chunk)
        let onDoors = 0
        for (const door of doors) {
          expect(door.signs.length, `${family} signs on one door`).toBeLessThanOrEqual(1)
          if (!door.signs.length) continue
          const { p, f } = door.signs[0]
          const { ctx } = door
          expect([DOOR_EGRESS, DOOR_INTERNAL], family).not.toContain(ctx.fn)
          expect(ctx.room).not.toBeNull()
          expect(f.side, `${family} sign on the room face`).toBe(-ctx.roomSide)
          if (ctx.fn === DOOR_GUEST && !signIdFor(ctx.room.role, family)) {
            // A guest room whose door is not hung shows its number over it.
            const way = doorwayAt(chunk.d, door.axis, door.line, door.cell, DOOR_LEAF_FRACTION)
            expect(way.leaf, `${family} guest plate over a hung door`).toBe(false)
            expect(p.cell).toBe(signCell('room', family))
            expect(p.number).toBe(way.number)
          } else {
            expect(p.cell, `${family} sign over a role ${ctx.room.role} room`).toBe(signCellFor(ctx.room.role, family))
            if (signPlateAt(p.cell, family).numbered) expect(p.number).toBe(doorNumber(chunk.d, door.axis, door.line, door.cell, ctx.roomSide))
          }
          onDoors++
          signed++
        }
        // No header plate anywhere but on a doorway.
        expect(onDoors, family).toBe([...signs.values()].length)
      }
      expect(signed, family).toBeGreaterThan(0)
    }, OFFICE_LAYER)
  })

  it('signs every named room a corridor door serves, hotel public rooms included', () => {
    const publicRooms = new Set([SPACE_ROLE_LOUNGE, SPACE_ROLE_DINING, SPACE_ROLE_MEETING, SPACE_ROLE_LIBRARY])
    let hotelPublic = 0
    eachWorld(({ family, chunks }) => {
      for (const chunk of chunks) {
        for (const door of doorsOf(chunk).doors) {
          const { ctx } = door
          if (!ctx.room || ctx.partial || ctx.fn === DOOR_INTERNAL || ctx.fn === DOOR_EGRESS) continue
          // A hotel suite's own bathroom or closet is private.
          const outside = ctx.roomSide > 0 ? ctx.lo : ctx.hi
          if (family === MAP_FAMILY_HOTEL && outside.cls === SPACE_ROOM && outside.category === ZONE_SOFT) continue
          const id = signIdFor(ctx.room.role, family)
          // Ordinary rooms follow their department's numbering; a derelict
          // wing has lost some plates.
          if (!id || id === 'room' || ctx.room.decay >= DERELICT) continue
          const { lo, hi } = edgeCells(door.axis, door.line, door.cell)
          if ((lo && chunk.d.hasFloorHole(lo.lx, lo.lz)) || chunk.d.hasFloorHole(hi.lx, hi.lz)) continue
          expect(door.signs.map(({ p }) => p.cell), `${family} unsigned role ${ctx.room.role} door`).toEqual([signCellFor(ctx.room.role, family)])
          if (family === MAP_FAMILY_HOTEL && publicRooms.has(ctx.room.role)) hotelPublic++
        }
      }
    }, OFFICE_LAYER)
    expect(hotelPublic).toBeGreaterThan(0)
  })

  it('numbers every hotel guest room, on its door or, with the leaf gone, over it', () => {
    let leaves = 0
    let headers = 0
    eachWorld(({ chunks }) => {
      for (const chunk of chunks) {
        const ways = new Map(collectDoorways(chunk.d, DOOR_LEAF_FRACTION).map((w) => [edgeKey(w.axis, w.line, w.cell), w]))
        for (const door of doorsOf(chunk).doors) {
          const way = ways.get(edgeKey(door.axis, door.line, door.cell))
          // Named rooms (lounge, dining, staff) carry their name instead.
          if (door.ctx.fn !== DOOR_GUEST || !way.number || signIdFor(door.ctx.room.role, MAP_FAMILY_HOTEL)) continue
          if (way.leaf) {
            // The brass number is on the leaf: no second plate over it.
            expect(door.signs, `hotel ${way.number} numbered twice`).toEqual([])
            leaves++
            continue
          }
          if (door.ctx.room.decay >= DERELICT) continue // derelict wings lose plates
          expect(door.signs.map(({ p }) => p.number), `hotel ${way.number} unnumbered`).toEqual([way.number])
          headers++
        }
      }
    }, [MAP_FAMILY_HOTEL])
    expect(leaves).toBeGreaterThan(300)
    expect(headers).toBeGreaterThan(10)
  })

  it('numbers doors by where they open, a department all or none, never twice close by', () => {
    eachWorld(({ family, chunks }) => {
      const plates = []
      const policy = new Map() // district -> signed? for its ordinary doors
      for (const chunk of chunks) {
        const { d } = chunk
        for (const door of doorsOf(chunk).doors) {
          const { ctx } = door
          const p = door.signs[0]?.p
          if (p?.number) {
            const gx = d.cx * CHUNK + (door.axis === 'v' ? door.line : door.cell)
            const gz = d.cz * CHUNK + (door.axis === 'v' ? door.cell : door.line)
            plates.push({ number: p.number, key: ctx.room.key, gx, gz })
          }
          const ordinary = ctx.fn === DOOR_ROOM && !ctx.partial && ctx.room && signIdFor(ctx.room.role, family) === 'room'
          if (!ordinary || ctx.room.decay >= DERELICT) continue
          if (!policy.has(ctx.room.district)) policy.set(ctx.room.district, new Set())
          policy.get(ctx.room.district).add(Boolean(p))
        }
      }
      for (const [district, set] of policy) expect(set.size, `${family} department ${district}`).toBe(1)
      expect(plates.length, family).toBeGreaterThan(20)
      // Two different rooms never show one number within 30 m of each other.
      for (let a = 0; a < plates.length; a++) {
        for (let b = a + 1; b < plates.length; b++) {
          const [A, B] = [plates[a], plates[b]]
          if (A.number !== B.number || A.key === B.key) continue
          expect(Math.hypot(A.gx - B.gx, A.gz - B.gz) * CELL, `${family} ROOM ${A.number} twice`).toBeGreaterThanOrEqual(30)
        }
      }
    }, [MAP_FAMILY_OFFICE, MAP_FAMILY_TOWER])
  })

  it('numbers climb along a corridor, odd on one hand and even on the other', () => {
    const d = generateChunk(SEEDS[0], 1, 0, 1, worldConfigForFamily(MAP_FAMILY_OFFICE))
    const index = (n) => Number(n.slice(-2))
    // v doors at one line: climbing toward +z, the room on -x reads odd.
    expect(index(doorNumber(d, 'v', 5, 3, -1)) % 2).toBe(1)
    expect(index(doorNumber(d, 'v', 5, 3, 1)) % 2).toBe(0)
    expect(index(doorNumber(d, 'v', 5, 4, -1))).toBe(index(doorNumber(d, 'v', 5, 3, -1)) + 2)
    expect(index(doorNumber(d, 'h', 5, 3, 1)) % 2).toBe(1)
    // The two corridor axes never share a band digit.
    expect(Number(doorNumber(d, 'v', 5, 3, 1)[1])).toBeLessThanOrEqual(5)
    expect(Number(doorNumber(d, 'h', 5, 3, 1)[1])).toBeGreaterThanOrEqual(6)
    expect(doorNumber(d, 'v', 5, 3, 1)[0]).toBe(storeyNumber(0))
  })

  it('lights exit signs over the escape route and nowhere else', () => {
    eachWorld(({ family, chunks, at }) => {
      for (const { d, out } of chunks) checkExits(family, d, out, at)
    })
  })

  it('keeps every landmark colour well clear of exit green', () => {
    // Accents, floor markers and lattice bollards cycle through these; exit
    // green marks the escape route only, so none of them may pass for it.
    for (const tint of ACCENT_CYCLE) expect(Math.hypot(...tint.map((c, k) => c - SIGN_TINT.exit[k])), String(tint)).toBeGreaterThan(0.3)
  })

  it('lights the tower\'s bridge approaches in the storey colour, held up by a wall or the ceiling', () => {
    const config = worldConfigForFamily(MAP_FAMILY_TOWER)
    let hung = 0
    let mounted = 0
    for (const seed of [...SEEDS, 5, 1]) {
      // The authored sockets, read off the tower descriptors: the chunks
      // that hold an accent are few and far between on a generated block.
      const sockets = new Map()
      for (let cy = -2; cy <= 8; cy++) {
        for (let cz = -4; cz <= 4; cz++) {
          for (let cx = -4; cx <= 4; cx++) {
            for (const k of structureAt(seed, cx, cz, cy, config)?.landmarkSockets ?? []) {
              if (k.kind === 'litAccent') sockets.set(`${k.gx},${k.gz},${k.cy}`, k)
            }
          }
        }
      }
      for (const socket of sockets.values()) {
        const d = generateChunk(seed, Math.floor(socket.gx / CHUNK), socket.cy, Math.floor(socket.gz / CHUNK), config)
        // The chunk around it keeps every exit-sign rule.
        checkExits(MAP_FAMILY_TOWER, d, collectInteriorDressing(d))
        const own = Object.create(d, { structure: { value: { ...d.structure, landmarkSockets: [socket] } } })
        const signs = []
        dressTowerLandmarkSockets(own, [], signs)
        const where = `seed ${seed} accent ${socket.gx},${socket.gz} cy ${socket.cy}`
        expect(signs.some((b) => sameTint(b.tint, SIGN_TINT.exit)), `${where} in exit green`).toBe(false)
        const faces = signs.filter((b) => b.tint !== SIGN_TINT.frame)
        expect(faces, where).toHaveLength(1)
        const [face] = faces
        expect(face.tint, `${where} colour`).toBe(ACCENT_CYCLE[mod(d.cy, ACCENT_CYCLE.length)])
        // ...and no landmark colour can pass for exit green.
        expect(Math.hypot(...face.tint.map((c, k) => c - SIGN_TINT.exit[k])), `${where} near exit green`).toBeGreaterThan(0.3)
        // What holds it up: a plain wall or a door header behind it, else
        // two rods up to a ceiling that is there.
        const lx = socket.gx - d.cx * CHUNK
        const lz = socket.gz - d.cz * CHUNK
        const axis = socket.axis === 'x' ? 'v' : 'h'
        const line = (axis === 'v' ? lx : lz) + (socket.side > 0 ? 1 : 0)
        const cell = axis === 'v' ? lz : lx
        const across = axis === 'v' ? face.px : face.pz
        const depth = axis === 'v' ? face.sx : face.sz
        const feature = axis === 'v' ? d.wallFeatureV[vIdx(line, cell)] : d.wallFeatureH[hIdx(cell, line)]
        if ((wallAt(d, axis, line, cell) === 1 && feature === WALL_PLAIN) || passageAt(d, axis, line, cell) === PASSAGE_DOOR) {
          expect(Math.abs(Math.abs(across - line * CELL) - THICK / 2 - 0.04 - depth / 2), `${where} off its wall`).toBeLessThan(1e-9)
          mounted++
          continue
        }
        const rods = signs.filter((b) => b.tint === SIGN_TINT.frame && Math.abs(b.py + b.sy / 2 - WALL_H) < 1e-9)
        expect(rods, `${where} floating`).toHaveLength(2)
        for (const rod of rods) expect(axis === 'v' ? rod.px : rod.pz).toBe(across)
        const k = Math.floor(across / CELL)
        const [hx, hz] = axis === 'v' ? [k, cell] : [cell, k]
        expect(inChunk(hx, hz) && !d.hasCeilHole(hx, hz), `${where} hung from no ceiling`).toBe(true)
        hung++
      }
    }
    expect(hung + mounted, 'accents checked').toBeGreaterThan(10)
  })

  it('posts safety notices by the space they are posted in', () => {
    const first = DECAL_KINDS.safety[0]
    eachWorld(({ family, set, chunks }) => {
      for (const { d, out, plan } of chunks) {
        for (const p of out.decals) {
          if (decalKindOf(p.cell) !== 'safety') continue
          const f = faceOf(p)
          if (!f.inside) continue
          const id = SAFETY_NOTICES[p.cell - first]
          const ctx = roomContext(d, f.lx, f.lz, set)
          const server = ctx.cls === SPACE_ROOM && ctx.role === SPACE_ROLE_SERVER
          if (server) expect(['highVoltage', 'authorized'], family).toContain(id)
          if (id === 'wetFloor' || id === 'washHands') {
            expect(ctx.cls, `${family} ${id}`).toBe(SPACE_ROOM)
            expect(ctx.category, `${family} ${id}`).toBe(ZONE_WET)
          }
          if (id === 'highVoltage') expect(server, `${family} high voltage`).toBe(true)
          if (id === 'fireDoor') expect(plan.nearEgress(f.lx, f.lz), `${family} fire door notice`).toBe(true)
          if (id === 'confinedSpace') expect(family).toBe(MAP_FAMILY_SEWER)
          if (id === 'fallHazard') expect(family).toBe(MAP_FAMILY_LATTICE)
        }
      }
    })
  })

  it('keeps notes that should not be there to the derelict wings', () => {
    let notes = 0
    eachWorld(({ family, set, chunks }) => {
      for (const { d, out } of chunks) {
        for (const p of out.decals) {
          if (decalKindOf(p.cell) !== 'liminal') continue
          const f = faceOf(p)
          expect(f.inside).toBe(true)
          expect(roomContext(d, f.lx, f.lz, set).decay, family).toBeGreaterThanOrEqual(DERELICT)
          notes++
        }
      }
    })
    expect(notes).toBeGreaterThan(0)
  })

  it('points every arrow along the walk to the stairs, wrong only in a derelict wing', () => {
    const first = DECAL_KINDS.wayfinding[0]
    let arrows = 0
    let wrong = 0
    eachWorld(({ family, set, chunks }) => {
      for (const { d, out } of chunks) {
        const routes = stairRoutes(d)
        const distAt = (x, z) => Math.min(...routes.map((r) => r.dist[cIdx(x, z)]).filter((v) => v >= 0))
        for (const p of out.decals) {
          if (decalKindOf(p.cell) !== 'wayfinding') continue
          const f = faceOf(p)
          const here = distAt(f.lx, f.lz)
          expect(Number.isFinite(here), `${family} arrow off the route`).toBe(true)
          const { label, dir } = WAYFINDING[p.cell - first]
          // The reader faces the wall: their right hand runs -z on a +x
          // face, +x on a +z face.
          const right = f.vertical ? -f.side : f.side
          const [dx, dz] = f.vertical ? [0, dir * right] : [dir * right, 0]
          const there = openStep(d, f.lx, f.lz, dx, dz) ? distAt(f.lx + dx, f.lz + dz) : Infinity
          if (!(there < here)) {
            expect(roomContext(d, f.lx, f.lz, set).decay, `${family} wrong arrow`).toBeGreaterThanOrEqual(DERELICT)
            wrong++
          }
          // Ground storey: no stair leads further out.
          expect(label).toBe('STAIRS')
          arrows++
        }
      }
    })
    expect(arrows).toBeGreaterThan(0)
    expect(wrong / arrows).toBeLessThan(0.1)
  })

  it('labels an arrow EXIT only when its stair leads toward the ground floor', () => {
    const first = DECAL_KINDS.wayfinding[0]
    const labels = { EXIT: 0, STAIRS: 0 }
    for (const family of [MAP_FAMILY_OFFICE, MAP_FAMILY_HOTEL]) {
      for (const cy of [-1, 2]) {
        for (const { d, out } of block(family, SEEDS[0], cy, 4).chunks) {
          const routes = stairRoutes(d)
          for (const p of out.decals) {
            if (decalKindOf(p.cell) !== 'wayfinding') continue
            const f = faceOf(p)
            const here = Math.min(...routes.map((r) => r.dist[cIdx(f.lx, f.lz)]).filter((v) => v >= 0))
            // The label of one of the stair ends nearest along the walk.
            const nearest = routes.filter((r) => r.dist[cIdx(f.lx, f.lz)] === here).map(({ end }) =>
              (cy > 0 && end.up === false) || (cy < 0 && end.up === true) ? 'EXIT' : 'STAIRS')
            const { label } = WAYFINDING[p.cell - first]
            expect(nearest, `${family} cy ${cy}`).toContain(label)
            labels[label]++
          }
        }
      }
    }
    expect(labels.EXIT).toBeGreaterThan(0)
  })

  it('fits a department out as one: one clock dial, one calendar month, one poster series', () => {
    eachWorld(({ family, set, chunks }) => {
      const depts = new Map()
      for (const { d, out } of chunks) {
        for (const p of out.decals) {
          const kind = decalKindOf(p.cell)
          if (!['clock', 'calendar', 'chart', 'poster', 'art'].includes(kind)) continue
          const f = faceOf(p)
          if (!f.inside) continue
          const { district } = roomContext(d, f.lx, f.lz, set)
          if (!depts.has(district)) depts.set(district, { clock: new Set(), calendar: new Set(), chart: new Set(), poster: new Set(), art: new Set() })
          depts.get(district)[kind].add(p.cell)
        }
      }
      for (const [district, k] of depts) {
        expect(k.clock.size, `${family} ${district} clocks`).toBeLessThanOrEqual(1)
        expect(k.calendar.size, `${family} ${district} calendars`).toBeLessThanOrEqual(1)
        expect(k.chart.size, `${family} ${district} charts`).toBeLessThanOrEqual(1)
        expect(k.poster.size, `${family} ${district} posters`).toBeLessThanOrEqual(3)
        expect(k.art.size, `${family} ${district} prints`).toBeLessThanOrEqual(3)
      }
    }, OFFICE_LAYER)
  })

  it('keeps wet rooms to hygiene notices: no boards, posters or prints', () => {
    eachWorld(({ family, set, chunks }) => {
      for (const { d, out } of chunks) {
        const items = [
          ...out.decals.filter((p) => ['poster', 'memo', 'chart', 'art', 'photo'].includes(decalKindOf(p.cell))),
          ...out.props.filter((p) => p.tint === PROP_TINT.board),
        ]
        for (const p of items) {
          const f = faceOf(p)
          if (!f.inside) continue
          const ctx = roomContext(d, f.lx, f.lz, set)
          expect(ctx.cls === SPACE_ROOM && ctx.category === ZONE_WET, `${family} paper in a wet room`).toBe(false)
        }
      }
    }, OFFICE_LAYER)
  })

  it('composes a room\'s walls: nothing side by side, one clock per stretch of wall', () => {
    eachWorld(({ family, set, chunks }) => {
      let items = 0
      for (const { d, out } of chunks) {
        // Wall items (decals and boards) per room, wall line and face.
        const walls = new Map()
        const add = (p, kind) => {
          const f = faceOf(p)
          if (!f.inside) return
          const ctx = roomContext(d, f.lx, f.lz, set)
          const key = `${ctx.key}|${f.axis}${f.line}|${f.side}`
          if (!walls.has(key)) walls.set(key, new Map())
          const along = walls.get(key)
          if (!along.has(f.cell)) along.set(f.cell, new Set())
          along.get(f.cell).add(kind)
        }
        for (const p of out.decals) {
          const kind = decalKindOf(p.cell)
          if (!WALL_ITEMS.has(kind) || Math.abs(p.py - EXIT_SIGN_Y) < 1e-9) continue
          const ctx = faceOf(p).inside ? roomContext(d, faceOf(p).lx, faceOf(p).lz, set) : null
          if (ctx?.cls === SPACE_ROOM) add(p, kind === 'safety' ? `safety${p.cell}` : `${kind}${p.cell}`)
        }
        for (const p of out.props) if (p.tint === PROP_TINT.board) add(p, 'board')
        for (const [key, along] of walls) {
          for (const [cell, kinds] of along) {
            items++
            // Never two things on neighbouring wall cells of one room.
            expect(along.has(cell + 1), `${family} ${key} items side by side at ${cell}`).toBe(false)
            // One clock per 8-cell stretch of one wall.
            if ([...kinds].some((k) => k.startsWith('clock'))) {
              for (let c = cell + 1; c < cell + 8; c++) {
                expect([...(along.get(c) ?? [])].some((k) => k.startsWith('clock')), `${family} ${key} clocks`).toBe(false)
              }
            }
          }
        }
      }
      expect(items, family).toBeGreaterThan(0)
    }, OFFICE_LAYER)
  })

  it('keeps a room\'s dial, month and chart one across the room', () => {
    eachWorld(({ family, set, chunks }) => {
      const rooms = new Map()
      for (const { d, out } of chunks) {
        for (const p of out.decals) {
          const kind = decalKindOf(p.cell)
          if (!['clock', 'calendar', 'chart'].includes(kind)) continue
          const f = faceOf(p)
          if (!f.inside) continue
          const key = `${roomContext(d, f.lx, f.lz, set).key}|${kind}`
          if (!rooms.has(key)) rooms.set(key, new Set())
          rooms.get(key).add(p.cell)
        }
      }
      for (const [key, cells] of rooms) expect(cells.size, `${family} ${key}`).toBe(1)
    }, OFFICE_LAYER)
  })

  it('mounts lattice and sewer plates on real walls, clear of stair flights and door leaves', () => {
    let plates = 0
    for (const family of [MAP_FAMILY_LATTICE, MAP_FAMILY_SEWER]) {
      for (const seed of SEEDS) {
        for (const { d, out } of worldOf(family, seed).chunks) {
          const flight = new Set((d.stairUp?.run ?? []).map((c) => `${c.lx},${c.lz}`))
          for (const p of out.decals) {
            const f = faceOf(p)
            expect(f.line >= 0 && f.line < CHUNK && f.inside, `${family} plate on the far seam`).toBe(true)
            expect(wallAt(d, f.axis, f.line, f.cell), `${family} plate on an open edge`).toBe(1)
            expect(flight.has(`${f.lx},${f.lz}`), `${family} plate inside the steps`).toBe(false)
            // Chamber plates hang beside their hardware; the rest keep off
            // the wall beside a doorway, where an open leaf lies flat.
            if (decalKindOf(p.cell) !== 'sign' || family === MAP_FAMILY_LATTICE) {
              expect(freeWall(d, f.axis, f.line, f.cell), `${family} plate beside a door`).toBe(true)
            }
            plates++
          }
        }
      }
    }
    expect(plates).toBeGreaterThan(0)
  })

  it('hangs extinguishers on a fixed cadence down the corridors', () => {
    eachWorld(({ family, chunks }) => {
      let cabinets = 0
      let moved = 0
      for (const { d, out, plan } of chunks) {
        for (const p of out.props) {
          if (p.tint !== PROP_TINT.extinguisher) continue
          const f = faceOf(p)
          expect(d.cellKind[cIdx(f.lx, f.lz)]).toBe(CELL_CORRIDOR)
          // On its cadence slot, or moved on along the same wall past slot
          // faces a doorway or an open leaf has taken.
          const g = (f.vertical ? d.cz : d.cx) * CHUNK + f.cell
          const k = mod(g - (f.side > 0 ? 0 : EXT_STEP), EXT_STEP * 2)
          expect(k, family).toBeLessThanOrEqual(2)
          for (let j = f.cell - k; j < f.cell; j++) {
            const [lx, lz] = f.vertical ? [f.lx, j] : [j, f.lz]
            expect(j >= 0 && d.cellKind[cIdx(lx, lz)] === CELL_CORRIDOR, `${family} cabinet moved off its corridor`).toBe(true)
            const taken = !freeWall(d, f.axis, f.line, j) || plan.levelFaces.has(`${f.axis}${f.line},${j},${f.side}`)
            expect(taken, `${family} cabinet moved past a free face`).toBe(true)
          }
          if (k) moved++
          cabinets++
        }
      }
      expect(cabinets, family).toBeGreaterThan(0)
      expect(moved, family).toBeGreaterThan(0)
    }, OFFICE_LAYER)
  })

  it('hangs blade signs across the corridor, facing the walker', () => {
    eachWorld(({ family, chunks }) => {
      let checked = 0
      for (const { d, out } of chunks) {
        for (const b of out.signs) {
          if (b.tint !== SIGN_TINT.blade || b.sy !== BLADE_SIGN_H) continue
          const lx = Math.floor(b.px / CELL)
          const lz = Math.floor(b.pz / CELL)
          if (lx < 1 || lz < 1 || lx > CHUNK - 2 || lz > CHUNK - 2) continue
          const wallsX = Boolean(d.vAt(lx, lz) && d.vAt(lx + 1, lz)) // walled east and west: runs along z
          const wallsZ = Boolean(d.hAt(lx, lz) && d.hAt(lx, lz + 1))
          if (wallsX === wallsZ) continue
          expect(b.sx > b.sz, `${family} blade edge-on`).toBe(wallsX)
          checked++
        }
      }
      expect(checked, family).toBeGreaterThan(0)
    }, OFFICE_LAYER)
  })

  it('sets every LEVEL plate from its own storey, numerals included', () => {
    for (const family of [MAP_FAMILY_LATTICE, MAP_FAMILY_OFFICE, MAP_FAMILY_TOWER]) {
      const level = signCell('level', family)
      let plates = 0
      for (const cy of [-1, 0, 2]) {
        const { chunks } = block(family, SEEDS[0], cy, 3)
        for (const { out } of chunks) {
          const ink = out.props.filter((p) => p.tint === PROP_TINT.signInk)
          for (const p of out.decals) {
            if (p.cell !== level) continue
            expect(p.number, family).toBe(storeyNumber(cy))
            // The numerals sit in the plate's number field, one box per lit
            // segment.
            const f = faceOf(p)
            const strokes = ink.filter((s) => {
              const across = f.vertical ? s.px - p.px : s.pz - p.pz
              const along = f.vertical ? s.pz - p.pz : s.px - p.px
              return Math.sign(across) === f.side && Math.abs(across) < 0.02 &&
                Math.abs(along) < (f.vertical ? p.sz : p.sx) / 2 && Math.abs(s.py - p.py) < p.sy / 2
            })
            const segments = [...p.number].reduce((n, c) => n + NUMERAL_GLYPHS[c].length, 0)
            expect(strokes.length, family).toBe(segments)
            plates++
          }
          for (const p of out.decals) {
            if (decalKindOf(p.cell) === 'sign' && family === MAP_FAMILY_LATTICE) expect(p.cell).toBe(level)
          }
        }
      }
      expect(plates, family).toBeGreaterThan(0)
    }
  })

  it('names each sewer chamber once, inside the chamber, as plant', () => {
    const plant = new Set([...SEWER_LARGE_PLATES, ...SEWER_SMALL_PLATES].map((id) => signCell(id, MAP_FAMILY_SEWER)))
    for (const seed of SEEDS) {
      const { chunks } = worldOf(MAP_FAMILY_SEWER, seed)
      let plates = 0
      for (const { d, out } of chunks) {
        const named = new Map()
        for (const p of out.decals) {
          if (decalKindOf(p.cell) !== 'sign') continue
          const f = faceOf(p)
          const chamber = d.sewerDescriptor.chambers.find((c) => f.lx >= c.x0 && f.lx <= c.x1 && f.lz >= c.z0 && f.lz <= c.z1)
          expect(chamber, 'plant plate outside a chamber').toBeDefined()
          expect(plant.has(p.cell)).toBe(true)
          named.set(chamber, (named.get(chamber) ?? 0) + 1)
          plates++
        }
        for (const n of named.values()) expect(n).toBe(1)
      }
      expect(plates).toBeGreaterThan(0)
    }
  })

  it('dresses a chunk identically however the world streams in', () => {
    for (const family of BUILDING_FAMILIES) {
      const config = worldConfigForFamily(family)
      const alone = collectInteriorDressing(generateChunk(SEEDS[1], 2, 0, 2, config))
      for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) generateChunk(SEEDS[1], 2 + dx, 0, 2 + dz, config)
      const d = generateChunk(SEEDS[1], 2, 0, 2, config)
      expect(collectInteriorDressing(d), family).toEqual(alone)
      expect(collectInteriorDressing(d), family).toEqual(alone)
    }
  })
})
