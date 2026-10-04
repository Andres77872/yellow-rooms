import { describe, it, expect } from 'vitest'
import { generateChunk } from '../generate.js'
import { worldConfigForFamily } from '../mapFamily.js'
import { CHUNK, DOOR_DARK_CHANCE, DOOR_LEAF_FRACTION } from '../constants.js'
import { collectDoorways } from '../doors.js'
import { leafShade } from '../doorSchedule.js'
import { DOOR_EGRESS, DOOR_GUEST, DOOR_INTERNAL, DOOR_ROOM, DOOR_SERVICE, DOOR_WET } from '../doorFunction.js'
import { LITE_NONE, PLATE_SIGN, doorKit, doorType } from '../objects/joinery/doorKit.js'
import { pushDoorLeaves } from '../objects/joinery/doors.js'
import { storeyNumber } from '../objects/dressing/notices.js'
import { GLASS_CRACKED, GLASS_DIRTY, GLASS_FROSTED, GLASS_TAPED } from '../glassKinds.js'
import { SPACE_ROOM, districtKeyOf, roomContext, worldSurfaceSet } from '../surfaceSet.js'
import { familiesWith } from '../families/registry.js'

// Office-semantics matrix: only the building families (spec §11.4). The
// liminal families have their own per-family suites.
const BUILDING_FAMILIES = familiesWith('buildingMatrices')

// World-scale coherence of the door schedule, measured on generated blocks
// of every family: one corridor hangs one kind of door, a doorway's type
// follows what it is for, hotel numbers climb along their corridor, and the
// odd one out is a rare, deliberate anomaly rather than uniform noise.
const WORLDS = [
  [4242, 0],
  [77, 1],
]
// The hotel's numbering is checked on two basement storeys as well, which
// number their rooms b1..., b2... as the LEVEL plates read them.
const HOTEL_WORLDS = [...WORLDS, [4242, -1], [77, -2]]
const N = 6 // chunks per side

function block(family, seed, cy) {
  const config = worldConfigForFamily(family)
  const chunks = new Map()
  for (let cz = 0; cz < N; cz++) for (let cx = 0; cx < N; cx++) chunks.set(`${cx},${cz}`, generateChunk(seed, cx, cy, cz, config))
  const set = worldSurfaceSet(family, seed)
  // Full knowledge of a cell, neighbours included — the test may look across
  // seams, the meshing code never does.
  const at = (gx, gz) => {
    const cx = Math.floor(gx / CHUNK)
    const cz = Math.floor(gz / CHUNK)
    const d = chunks.get(`${cx},${cz}`)
    return d ? roomContext(d, gx - cx * CHUNK, gz - cz * CHUNK, set) : null
  }
  const doors = []
  for (const d of chunks.values()) {
    const hung = collectDoorways(d, DOOR_LEAF_FRACTION)
    collectDoorways(d, 1).forEach((door, i) => {
      const v = door.axis === 'v'
      const line = (v ? d.cx : d.cz) * CHUNK + door.line // global grid line
      const along = (v ? d.cz : d.cx) * CHUNK + door.cell // global cell along it
      const lo = v ? at(line - 1, along) : at(along, line - 1)
      const hi = v ? at(line, along) : at(along, line)
      // The corridor and room sides of a corridor -> room door, seen whole.
      let corridor = null
      let room = null
      let roomSide = 0
      if (lo && hi && (lo.cls === SPACE_ROOM) !== (hi.cls === SPACE_ROOM)) {
        corridor = lo.cls === SPACE_ROOM ? hi : lo
        room = lo.cls === SPACE_ROOM ? lo : hi
        roomSide = lo.cls === SPACE_ROOM ? -1 : 1
      }
      doors.push({ d, door, kit: doorKit(family, door), line, along, corridor, room, roomSide, hung: hung[i].leaf })
    })
  }
  return doors
}

const blocks = new Map()
const doorsOf = (family, seed, cy) => {
  const k = `${family}:${seed}:${cy}`
  if (!blocks.has(k)) blocks.set(k, block(family, seed, cy))
  return blocks.get(k)
}
const allDoors = (family) => WORLDS.flatMap(([seed, cy]) => doorsOf(family, seed, cy))

// One corridor seen whole. A circulation key is hashed from the planner's
// space id, which repeats between districts, so the district joins it:
// corridors never leave their district.
const corridorOf = (x) => `${x.corridor.key}|${x.corridor.district}`
const roomOf = (x) => `${x.room.key}|${x.room.district}`

describe('door schedule on generated worlds', () => {
  it('hangs one door type along a corridor', () => {
    let corridors = 0
    for (const family of BUILDING_FAMILIES) {
      for (const [seed, cy] of WORLDS) {
        const byCorridor = new Map()
        for (const x of doorsOf(family, seed, cy)) {
          if (!x.corridor || (x.door.fn !== DOOR_ROOM && x.door.fn !== DOOR_GUEST)) continue
          const k = corridorOf(x)
          if (!byCorridor.has(k)) byCorridor.set(k, new Set())
          byCorridor.get(k).add(x.kit.type)
        }
        for (const [key, types] of byCorridor) {
          expect([...types], `${family} ${seed} corridor ${key}`).toHaveLength(1)
          corridors++
        }
      }
    }
    expect(corridors).toBeGreaterThan(20)
  })

  it('hangs one sewer standard per department, not one per world', () => {
    // Sewer doors are the bulkheads on chunk seams between galleries — the
    // escape route, never a room door — so the corridor check above never
    // sees them: their department (surfaceSet's 3x3-chunk block) is what
    // they agree on.
    const keys = new Set()
    for (const [seed, cy] of WORLDS) {
      const byDept = new Map()
      for (const x of doorsOf('sewer', seed, cy)) {
        expect(x.door.fn, `sewer ${seed} door`).toBe(DOOR_EGRESS)
        const k = `${cy}|${districtKeyOf(x.d)}`
        keys.add(x.door.schedule.key)
        if (!byDept.has(k)) byDept.set(k, new Set())
        byDept.get(k).add(x.kit.type)
      }
      for (const [k, types] of byDept) expect([...types], `sewer ${seed} department ${k}`).toHaveLength(1)
    }
    expect(keys.size).toBeGreaterThan(2)
  })

  it('gives one department and function one door type', () => {
    for (const family of BUILDING_FAMILIES) {
      const groups = new Map()
      for (const x of allDoors(family)) {
        const k = `${x.d.cy}|${districtKeyOf(x.d)}|${x.door.fn}`
        if (!groups.has(k)) groups.set(k, new Map())
        const m = groups.get(k)
        m.set(x.kit.type, (m.get(x.kit.type) ?? 0) + 1)
      }
      let total = 0
      let major = 0
      for (const m of groups.values()) {
        const counts = [...m.values()]
        total += counts.reduce((a, b) => a + b, 0)
        major += Math.max(...counts)
      }
      expect(major / total, family).toBeGreaterThanOrEqual(0.95)
    }
  })

  it('types a doorway by what it is for', () => {
    const seen = { [DOOR_WET]: 0, [DOOR_SERVICE]: 0, [DOOR_EGRESS]: 0 }
    for (const family of BUILDING_FAMILIES) {
      const fire = doorType(family, { fn: DOOR_EGRESS })
      for (const x of allDoors(family)) {
        const { fn } = x.door
        const tag = `${family} ${fn} ${x.kit.type}`
        if (fn in seen) seen[fn]++
        // Washrooms: no vision lite at all.
        if (fn === DOOR_WET) expect(x.kit.lite, tag).toBe(LITE_NONE)
        // Plant and store rooms: a painted leaf without glass, never veneer.
        if (fn === DOOR_SERVICE) {
          expect(x.kit.finish, tag).toBe('paint')
          expect(x.kit.lite, tag).toBe(LITE_NONE)
          if (family !== 'hotel') expect(x.kit.kick, tag).toBe(true)
          else expect(x.kit.louvered, tag).toBe(true)
        }
        // The escape route hangs the family's fire door.
        if (fn === DOOR_EGRESS) expect(x.kit.type, tag).toBe(fire)
        // Housekeeping's louvered door never fronts a guest room.
        if (fn === DOOR_GUEST) expect(x.kit.louvered, tag).toBeFalsy()
      }
    }
    for (const fn of Object.keys(seen)) expect(seen[fn], fn).toBeGreaterThan(0)
  })

  it('numbers hotel rooms along their corridor: storey, wing, odd and even sides', () => {
    // Tallied over every hotel world: one 6x6 block holds a few hundred
    // numbered doors, too few to bound the rare repeats one world at a time.
    let doors = 0
    let repeats = 0
    let near = 0
    let plates = 0
    let seenInside = 0
    let seenAcross = 0
    let long = 0
    const at = (x) => (x.door.axis === 'v' ? [x.line, x.along + 0.5] : [x.along + 0.5, x.line])
    const districtOf = (x) => `${x.d.district.dx},${x.d.district.dz}`
    for (const [seed, cy] of HOTEL_WORLDS) {
      const storey = storeyNumber(cy)
      const sides = new Map()
      const walls = new Map()
      const corridors = new Map()
      const shown = []
      let numbered = 0
      for (const x of doorsOf('hotel', seed, cy)) {
        if (!x.door.number) continue
        numbered++
        // The LEVEL plates' storey (b1, b2... below ground), one wing digit,
        // then the two-digit index.
        expect(x.door.number.startsWith(storey), x.door.number).toBe(true)
        expect(x.door.number).toHaveLength(storey.length + 3)
        // Odd on the right hand walking toward +z (v doors) or +x (h doors).
        const odd = x.door.axis === 'v' ? x.door.roomSide < 0 : x.door.roomSide > 0
        expect(Number(x.door.number.slice(-2)) % 2, x.door.number).toBe(odd ? 1 : 0)
        if (!x.corridor) continue
        expect(x.door.roomSide).toBe(x.roomSide)
        const side = `${corridorOf(x)}|${x.door.axis}|${x.line}|${x.roomSide}`
        if (!sides.has(side)) sides.set(side, [])
        sides.get(side).push(x)
        const wall = `${roomOf(x)}|${x.door.axis}|${x.line}|${x.roomSide}`
        if (!walls.has(wall)) walls.set(wall, new Set())
        walls.get(wall).add(x.door.number)
        if (!corridors.has(corridorOf(x))) corridors.set(corridorOf(x), [])
        corridors.get(corridorOf(x)).push(x)
        // A public room shows its name instead; every other numbered door
        // shows its number, on the leaf or, with the leaf gone, the header.
        if (x.kit.plate !== PLATE_SIGN) shown.push(x)
      }
      expect(numbered).toBeGreaterThan(100)
      for (const [k, side] of sides) {
        side.sort((a, b) => a.along - b.along)
        // One wing digit down the whole wall.
        expect(new Set(side.map((x) => x.door.number.slice(-3, -2))).size, k).toBe(1)
        // Room by room, the index climbs strictly: rooms of a wall are
        // disjoint runs, and two of them never share a slot.
        const rooms = []
        for (const x of side) if (!rooms.length || roomOf(rooms[rooms.length - 1]) !== roomOf(x)) rooms.push(x)
        for (let i = 1; i < rooms.length; i++) {
          expect(Number(rooms[i].door.number.slice(-2)), k).toBeGreaterThan(Number(rooms[i - 1].door.number.slice(-2)))
        }
        if (rooms.length >= 4) long++
      }
      // Every door of one room onto one wall reads that room's one number.
      for (const [k, numbers] of walls) expect([...numbers], k).toHaveLength(1)
      // Across a whole corridor network — parallel wings, the lobbies and
      // halls that join them, corners — a number names one room. The rare
      // repeat is a wall of the same axis ten rows on, or round a corner
      // well off the crossing; never the next wing, lobby or return hall.
      for (const list of corridors.values()) {
        const seen = new Map()
        for (const x of list) {
          doors++
          const twin = seen.get(x.door.number)
          if (!twin) {
            seen.set(x.door.number, x)
            continue
          }
          if (roomOf(twin) === roomOf(x)) continue
          repeats++
          const [ax, az] = at(twin)
          const [bx, bz] = at(x)
          if (twin.door.axis === x.door.axis) expect(Math.abs(twin.line - x.line), `${seed} ${x.door.number}`).toBeGreaterThanOrEqual(9)
          else expect(Math.abs(ax - bx) + Math.abs(az - bz), `${seed} ${x.door.number}`).toBeGreaterThanOrEqual(4)
          if (Math.hypot(ax - bx, az - bz) < 10) near++
        }
      }
      // What a guest could see together: two rooms showing one number less
      // than 30 m apart, inside a district or across its edge. The wing
      // digit counts global rows, so walls of one axis repeat only ten rows
      // apart — or a whole district apart along the line, where the index
      // restarts — whichever district they stand in.
      plates += shown.length
      for (let i = 0; i < shown.length; i++) {
        for (let j = i + 1; j < shown.length; j++) {
          const a = shown[i]
          const b = shown[j]
          if (a.door.number !== b.door.number || roomOf(a) === roomOf(b)) continue
          const tag = `${seed} ${a.door.number}`
          if (a.door.axis === b.door.axis && Math.abs(a.line - b.line) < 9) expect(Math.abs(a.along - b.along), tag).toBeGreaterThan(2 * CHUNK)
          const [ax, az] = at(a)
          const [bx, bz] = at(b)
          if (Math.hypot(ax - bx, az - bz) >= 10) continue
          expect(a.door.axis, tag).not.toBe(b.door.axis)
          if (districtOf(a) === districtOf(b)) seenInside++
          else seenAcross++
        }
      }
    }
    expect(long).toBeGreaterThan(20)
    // Ten wing digits over a 56-row district cannot keep every number
    // unique, so far repeats stay (6.1 % of corridor doors over 84 storeys
    // of twelve seeds); the ones within 30 m are corner pairs (0.27 % of
    // 157 000 shown plates over ten seeds, storeys b6..13), and seen
    // together across a district edge they are rarer still (14 pairs in
    // 96 000 doors, against 73 when the wing counted district rows). These
    // four worlds hold a handful of corner pairs, so the bound leaves room
    // for one or two either way — the old 1-7 wing bands ran near 2 %.
    expect(repeats / doors).toBeLessThan(0.08)
    expect(near / doors).toBeLessThan(0.008)
    expect(seenInside / plates).toBeLessThan(0.006)
    expect(seenAcross / plates).toBeLessThan(0.001)
  })

  it('numbers a room once per wall, and corridors across a district edge apart', () => {
    const hotel = worldConfigForFamily('hotel')
    const numberAt = (seed, cx, cy, cz, axis, line, cell) =>
      collectDoorways(generateChunk(seed, cx, cy, cz, hotel), 1).find((x) => x.axis === axis && x.line === line && x.cell === cell).number
    // A one-cell room on a shared slot's first cell (8) and the next room
    // starting on its second (9): the second room takes the slot after, so
    // the two neighbours never read one number.
    for (const [seed, cy, cx, cz, axis, line, a, b] of [
      [271828, -6, -10, -9, 'v', 3, 8, 10],
      [314159, 2, 2, -1, 'h', 7, 8, 11],
      [8675309, -6, -6, -9, 'h', 9, 8, 11],
      [23, 0, -6, -8, 'h', 9, 8, 10],
      [9, -3, -1, -4, 'h', 0, 8, 10],
      [9, 0, -6, -6, 'v', 13, 8, 11],
    ]) {
      const first = numberAt(seed, cx, cy, cz, axis, line, a)
      const next = numberAt(seed, cx, cy, cz, axis, line, b)
      expect(Number(next.slice(-2)), `${seed} ${cy} ${first} ${next}`).toBeGreaterThan(Number(first.slice(-2)))
    }
    // Two doors of one guest room onto one corridor wall (seed 4242,
    // storey 2): numbered by the room, not the doorway.
    expect(numberAt(4242, -1, 1, -3, 'v', 0, 10)).toBe(numberAt(4242, -1, 1, -3, 'v', 0, 12))
    // Two corridors six rows apart either side of a district edge (seed 77,
    // second basement) once both read 0732: now b2, each with its own wing
    // digit.
    const a = numberAt(77, -5, -2, -3, 'h', 10, 4)
    const b = numberAt(77, -5, -2, -2, 'h', 2, 4)
    expect(a.startsWith('b2') && b.startsWith('b2')).toBe(true)
    expect(a).not.toBe(b)
  })

  it('paints one batch per corridor, within a few percent', () => {
    let corridors = 0
    for (const family of BUILDING_FAMILIES) {
      const drift = new Set()
      for (const [seed, cy] of WORLDS) {
        // Grouped by the corridor seen whole, across seams: a door whose
        // corridor lies in the next chunk must still match its neighbours.
        const tones = new Map()
        for (const x of doorsOf(family, seed, cy)) {
          if (x.door.wrong) continue
          const shade = leafShade(x.door.tone)
          expect(Math.abs(shade - 1), family).toBeLessThanOrEqual(0.0301)
          drift.add(x.door.tone)
          if (!x.corridor) continue
          const k = corridorOf(x)
          if (!tones.has(k)) {
            tones.set(k, x.door.tone)
            corridors++
          } else expect(x.door.tone, `${family} ${seed} corridor ${k}`).toBe(tones.get(k))
        }
      }
      // Departments and storeys order their own batches.
      expect(drift.size, family).toBeGreaterThan(1)
    }
    expect(corridors).toBeGreaterThan(20)
  })

  it('keeps the dark wrong door rare and puts it in worn wings', () => {
    let n = 0
    let wrong = 0
    const worn = [0, 0]
    const lived = [0, 0]
    for (const family of BUILDING_FAMILIES) {
      for (const { door } of allDoors(family)) {
        n++
        expect(door.tone < DOOR_DARK_CHANCE).toBe(door.wrong)
        if (door.wrong) wrong++
        const bucket = door.decay >= 0.6 ? worn : door.decay < 0.45 ? lived : null
        if (bucket) {
          bucket[1]++
          if (door.wrong) bucket[0]++
        }
      }
    }
    expect(wrong / n).toBeGreaterThan(0.01)
    expect(wrong / n).toBeLessThanOrEqual(0.06)
    expect(worn[0] / worn[1]).toBeGreaterThan(lived[0] / lived[1])
  })

  it('takes the leaf style from the department', () => {
    for (const family of BUILDING_FAMILIES) {
      const styles = new Map()
      for (const { d, door } of allDoors(family)) {
        expect(door.style).toBe(door.schedule.style)
        const k = `${d.cy}|${door.schedule.key}`
        if (!styles.has(k)) styles.set(k, door.style)
        else expect(door.style, family).toBe(styles.get(k))
      }
    }
  })

  it('glazes vision lites by wear: clear when lived in, broken only when derelict', () => {
    let lites = 0
    for (const family of BUILDING_FAMILIES) {
      for (const x of allDoors(family)) {
        if (x.kit.lite === LITE_NONE) continue
        const glass = []
        pushDoorLeaves([], { ...x.door, kit: x.kit, leaves: [{ hinge: 1, face: 1 }] }, { glass })
        const { kind } = glass[0]
        lites++
        const tag = `${family} ${x.door.fn} decay ${x.door.decay.toFixed(2)}`
        if (x.door.decay < 0.45) expect([GLASS_DIRTY, GLASS_CRACKED, GLASS_TAPED], tag).not.toContain(kind)
        if (x.door.decay < 0.8) expect([GLASS_CRACKED, GLASS_TAPED], tag).not.toContain(kind)
        if (kind === GLASS_FROSTED) expect(x.door.privacy, tag).toBe(true)
      }
    }
    expect(lites).toBeGreaterThan(50)
  })

  it('hangs the doors a building cannot do without', () => {
    // Per family: fire, wash, store and guest doors are hung (k = 24 gives
    // ~97%), ordinary room doors about half the time, suite doors less. A
    // numbered hotel room door is a guest door whatever its function says.
    const MIN_SAMPLE = 20
    for (const family of BUILDING_FAMILIES) {
      const tally = new Map()
      for (const x of allDoors(family)) {
        const cls = x.door.number ? DOOR_GUEST : x.door.fn
        const t = tally.get(cls) ?? { shown: 0, total: 0 }
        t.total++
        if (x.hung) t.shown++
        tally.set(cls, t)
      }
      const rate = (fn) => {
        const t = tally.get(fn)
        return t && t.total >= MIN_SAMPLE ? t.shown / t.total : null
      }
      let must = 0
      for (const fn of [DOOR_GUEST, DOOR_WET, DOOR_SERVICE, DOOR_EGRESS]) {
        if (rate(fn) === null) continue
        must++
        expect(rate(fn), `${family} ${fn}`).toBeGreaterThanOrEqual(0.9)
      }
      expect(must, family).toBeGreaterThan(0)
      if (rate(DOOR_ROOM) !== null) expect(rate(DOOR_ROOM), `${family} room`).toBeLessThan(0.65)
      if (rate(DOOR_INTERNAL) !== null) {
        expect(rate(DOOR_INTERNAL), `${family} internal`).toBeLessThan(0.45)
        if (rate(DOOR_ROOM) !== null) expect(rate(DOOR_INTERNAL), family).toBeLessThan(rate(DOOR_ROOM))
      }
    }
  })

  it('resolves every doorway the same on every load', () => {
    for (const family of BUILDING_FAMILIES) {
      const config = worldConfigForFamily(family)
      for (const [cx, cz] of [
        [0, 0],
        [3, 2],
        [5, 5],
      ]) {
        const a = collectDoorways(generateChunk(4242, cx, 0, cz, config), DOOR_LEAF_FRACTION)
        const b = collectDoorways(generateChunk(4242, cx, 0, cz, config), DOOR_LEAF_FRACTION)
        expect(b, `${family} ${cx},${cz}`).toEqual(a)
        expect(b.map((door) => doorKit(family, door))).toEqual(a.map((door) => doorKit(family, door)))
      }
    }
  })
})
