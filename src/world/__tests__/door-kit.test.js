import { describe, it, expect } from 'vitest'
import { pushDoorFrame, pushDoorLeaves, doorKit } from '../objects/joinery/index.js'
import { digitStrokes } from '../objects/joinery/doors.js'
import { DOOR_VOCAB, LITE_NONE, LEAF_PANEL, PLATE_NONE, PLATE_NUMBER, doorType, doorTypes } from '../objects/joinery/doorKit.js'
import { collectDoorways } from '../doors.js'
import { doorSchedule, leafShade, liteGlass } from '../doorSchedule.js'
import { DOOR_EGRESS, DOOR_GUEST, DOOR_INTERNAL, DOOR_ROOM, DOOR_SERVICE, DOOR_WET } from '../doorFunction.js'
import { ChunkData } from '../ChunkData.js'
import { CELL, THICK, DOOR_H, DOOR_LEAF_THICK, DOOR_DARK_CHANCE, vIdx } from '../constants.js'
import { PASSAGE_DOOR, SPACE_ROLE_LAUNDRY, SPACE_ROLE_LOUNGE } from '../mapTypes.js'
import { GLASS_CLEAR, GLASS_CRACKED, GLASS_DIRTY, GLASS_FROSTED, GLASS_TAPED, GLASS_WIRED } from '../glassKinds.js'
import { familiesWith } from '../families/registry.js'

// Office-semantics matrix: only the building families (spec §11.4). The
// liminal families have their own per-family suites.
const BUILDING_FAMILIES = familiesWith('buildingMatrices')

const xSpan = (b) => [b.px - b.sx / 2, b.px + b.sx / 2]
const ySpan = (b) => [b.py - b.sy / 2, b.py + b.sy / 2]
const zSpan = (b) => [b.pz - b.sz / 2, b.pz + b.sz / 2]
const overlap = ([a0, a1], [b0, b1]) => Math.min(a1, b1) - Math.max(a0, b0)

// A scheduled hotel number on every descriptor, the widest a storey below
// 10 or a basement reads (b1 + wing + index): the guest leaves plate it.
const base = { axis: 'v', line: 4, cell: 7, leaf: true, tone: 0.4, style: 0.3, variant: 0.3, number: 'b1207' }
const FNS = [DOOR_ROOM, DOOR_GUEST, DOOR_WET, DOOR_SERVICE, DOOR_EGRESS, DOOR_INTERNAL]
const ROLES = [0, SPACE_ROLE_LAUNDRY, SPACE_ROLE_LOUNGE]

// One schedule per standard the family's departments may specify.
const schedules = (family) =>
  DOOR_VOCAB[family].standard.map(([standard]) => ({ standard, species: DOOR_VOCAB[family].species[0][0], metal: DOOR_VOCAB[family].metal[0][0], panels: 3, style: 0.65 }))

// Every function under every standard of every family, both hinges and faces:
// between them they hang every door type a family has.
function* kitDoors() {
  for (const family of BUILDING_FAMILIES) {
    for (const schedule of schedules(family)) {
      for (const fn of FNS) {
        for (const role of ROLES) {
          for (const hinge of [-1, 1]) {
            for (const face of [-1, 1]) {
              const door = { ...base, fn, role, schedule, leaves: [{ hinge, face }] }
              door.kit = doorKit(family, door)
              yield { family, variant: `${fn}/${schedule.standard}/${role}`, hinge, face, door }
            }
          }
        }
      }
    }
  }
}

describe('doorKit', () => {
  it('is a pure function of family, function, schedule and room role', () => {
    for (const family of BUILDING_FAMILIES) {
      for (const schedule of schedules(family)) {
        for (const fn of FNS) {
          const a = doorKit(family, { fn, schedule, role: 0, variant: 0.1, tone: 0.3 })
          const b = doorKit(family, { fn, schedule, role: 0, variant: 0.9, tone: 0.7 })
          expect(a, `${family} ${fn}`).toEqual(b) // the per-door seeds no longer pick the type
          expect(a.type).toBe(doorType(family, { fn, schedule, role: 0 }))
        }
      }
    }
  })

  it('gives each family more than one door type, all of them reachable', () => {
    for (const family of BUILDING_FAMILIES) {
      const reached = new Set()
      for (const { family: f, door } of kitDoors()) if (f === family) reached.add(door.kit.type)
      expect(doorTypes(family).length, family).toBeGreaterThan(1)
      expect([...reached].sort(), family).toEqual([...doorTypes(family)].sort())
    }
  })

  it('routes doors by function: ordinary rooms take the district standard', () => {
    for (const family of BUILDING_FAMILIES) {
      for (const schedule of schedules(family)) {
        expect(doorType(family, { fn: DOOR_ROOM, schedule })).toBe(schedule.standard)
      }
      const s = schedules(family)[0]
      const wet = doorKit(family, { fn: DOOR_WET, schedule: s, role: 0 })
      expect(wet.lite, family).toBe(LITE_NONE)
      const service = doorKit(family, { fn: DOOR_SERVICE, schedule: s, role: 0 })
      expect(service.finish, family).toBe('paint')
      expect(service.lite, family).toBe(LITE_NONE)
      if (family !== 'hotel') expect(service.kick, family).toBe(true)
      const egress = doorKit(family, { fn: DOOR_EGRESS, schedule: s, role: 0 })
      expect(egress.closer, family).toBe(true)
    }
    // Hotel: louvered housekeeping doors only on service rooms and the laundry.
    const hs = schedules('hotel')[0]
    expect(doorKit('hotel', { fn: DOOR_GUEST, schedule: hs, role: 0 }).louvered).toBeFalsy()
    // The brass number only where the schedule numbered the room: a leaf
    // with no room seen behind it carries no plate, never an invented one.
    expect(doorKit('hotel', { fn: DOOR_GUEST, schedule: hs, role: 0, number: '2318' }).plate).toBe(PLATE_NUMBER)
    expect(doorKit('hotel', { fn: DOOR_GUEST, schedule: hs, role: 0 }).plate).toBe(PLATE_NONE)
    expect(doorKit('hotel', { fn: DOOR_ROOM, schedule: hs, role: 0, number: null }).plate).toBe(PLATE_NONE)
    expect(doorKit('hotel', { fn: DOOR_GUEST, schedule: hs, role: SPACE_ROLE_LOUNGE, number: '2318' }).plate).not.toBe(PLATE_NUMBER)
    expect(doorKit('hotel', { fn: DOOR_SERVICE, schedule: hs, role: 0 }).louvered).toBe(true)
    expect(doorKit('hotel', { fn: DOOR_WET, schedule: hs, role: SPACE_ROLE_LAUNDRY }).louvered).toBe(true)
    expect(doorKit('hotel', { fn: DOOR_WET, schedule: hs, role: 0 }).louvered).toBeFalsy()
  })

  it('collectDoorways seeds a door variant in [0, 1), stable across calls', () => {
    const data = new ChunkData(2, 0, -1, 0)
    data.wallV[vIdx(4, 6)] = 1
    data.wallV[vIdx(4, 8)] = 1
    data.setPassageV(4, 7, PASSAGE_DOOR)
    const [a] = collectDoorways(data, 1)
    const [b] = collectDoorways(data, 1)
    expect(a.variant).toBeGreaterThanOrEqual(0)
    expect(a.variant).toBeLessThan(1)
    expect(a.leaf).toBe(true)
    expect(a.variant).toBe(b.variant)
    // ...and carries its schedule for the kit.
    expect(FNS).toContain(a.fn)
    expect(a.schedule).toBe(b.schedule)
    expect(doorKit('office', a)).toEqual(doorKit('office', b))
  })
})

describe('doorSchedule', () => {
  it('is a pure, memoised function of seed, family and department', () => {
    for (const family of BUILDING_FAMILIES) {
      const a = doorSchedule(42, family, 7)
      expect(doorSchedule(42, family, 7)).toBe(a)
      expect(Object.isFrozen(a)).toBe(true)
      expect(DOOR_VOCAB[family].standard.map(([n]) => n)).toContain(a.standard)
      expect(a.style < 0.5).toBe(a.panels === 2)
    }
  })

  it('lets departments differ', () => {
    for (const family of ['office', 'tower', 'lattice', 'sewer']) {
      const standards = new Set()
      for (let k = 0; k < 64; k++) standards.add(doorSchedule(42, family, k).standard)
      expect(standards.size, family).toBeGreaterThan(1)
    }
  })

  it('maps the tone seed onto the leaf shade, dark below the stain band', () => {
    expect(leafShade(DOOR_DARK_CHANCE / 2)).toBeLessThan(0.5)
    expect(leafShade(0.5)).toBeGreaterThan(0.95)
    expect(leafShade(0.5)).toBeLessThan(1.05)
  })

  it('reads vision-lite glass off the wear field', () => {
    const at = (decay, extra = {}) => liteGlass({ decay, variant: 0.4, ...extra }, false).kind
    expect(at(0.1)).toBe(GLASS_CLEAR)
    expect(at(0.6)).toBe(GLASS_DIRTY)
    expect(liteGlass({ decay: 0.9, variant: 0.4 }, true).kind).toBe(GLASS_WIRED)
    expect(at(0.2, { privacy: true })).toBe(GLASS_FROSTED)
    // Derelict panes are mostly just filthy; a few are cracked or taped.
    const kinds = new Map()
    for (let i = 0; i < 400; i++) {
      const k = liteGlass({ decay: 0.9, variant: i / 400 }, false).kind
      kinds.set(k, (kinds.get(k) ?? 0) + 1)
    }
    const broken = (kinds.get(GLASS_CRACKED) ?? 0) + (kinds.get(GLASS_TAPED) ?? 0)
    expect(broken).toBeGreaterThan(0)
    expect(broken).toBeLessThan(400 * 0.4)
    expect(kinds.get(GLASS_DIRTY)).toBeGreaterThan(broken)
    for (let i = 0; i < 100; i++) {
      const k = liteGlass({ decay: 0.7, variant: i / 100 }, false).kind
      expect([GLASS_CRACKED, GLASS_TAPED]).not.toContain(k)
    }
  })
})

describe('kit-dressed leaves', () => {
  it('stay inside the leaf span, under the head and on the room side of the wall', () => {
    for (const { family, variant, hinge, face, door } of kitDoors()) {
      const out = []
      pushDoorLeaves(out, door, { glass: [] })
      const plane = 4 * CELL
      const n0 = (7 + hinge) * CELL
      const n1 = (7 + hinge + 1) * CELL
      for (const b of out) {
        const tag = `${family} ${variant} h${hinge} f${face} role ${b.role}`
        const [z0, z1] = zSpan(b)
        expect(z0, tag).toBeGreaterThanOrEqual(n0 - 1e-9)
        expect(z1, tag).toBeLessThanOrEqual(n1 + 1e-9)
        const [y0, y1] = ySpan(b)
        expect(y0, tag).toBeGreaterThanOrEqual(-1e-9)
        expect(y1, tag).toBeLessThanOrEqual(DOOR_H + 1e-9)
        const [x0, x1] = xSpan(b)
        if (face === 1) expect(x0, tag).toBeGreaterThanOrEqual(plane + THICK / 2 - 1e-9)
        else expect(x1, tag).toBeLessThanOrEqual(plane - THICK / 2 + 1e-9)
        // Nothing stands more than a panic bar's depth off the leaf.
        const reach = Math.max(Math.abs(x0 - plane), Math.abs(x1 - plane))
        expect(reach, tag).toBeLessThanOrEqual(THICK / 2 + DOOR_LEAF_THICK + 0.09)
      }
    }
  })

  it('never clips the casing', () => {
    const frame = []
    pushDoorFrame(frame, 'v', 4, 7)
    for (const { door } of kitDoors()) {
      const out = []
      pushDoorLeaves(out, door)
      for (const f of frame) {
        for (const l of out) {
          const depth = Math.min(overlap(xSpan(f), xSpan(l)), overlap(ySpan(f), ySpan(l)), overlap(zSpan(f), zSpan(l)))
          expect(depth).toBeLessThanOrEqual(1e-9)
        }
      }
    }
  })

  it('cuts a real opening for a vision lite and glazes it', () => {
    let lites = 0
    for (const { door, family } of kitDoors()) {
      const out = []
      const glass = []
      pushDoorLeaves(out, door, { glass })
      if (door.kit.lite === LITE_NONE) {
        expect(glass).toHaveLength(0)
        continue
      }
      lites++
      expect(glass, family).toHaveLength(1)
      const pane = glass[0]
      expect(pane.kind === GLASS_WIRED).toBe(door.kit.wired)
      // No finish part covers the pane's centre: the leaf is open there.
      for (const b of out.filter((p) => p.role === 0)) {
        const inside =
          overlap(ySpan(b), [pane.py - 1e-3, pane.py + 1e-3]) > 0 &&
          overlap(zSpan(b), [pane.pz - 1e-3, pane.pz + 1e-3]) > 0 &&
          overlap(xSpan(b), xSpan(pane)) > 0
        expect(inside, family).toBe(false)
      }
    }
    expect(lites).toBeGreaterThan(0)
  })

  it('tags veneer parts with their species tint and metal with an F0 tint', () => {
    for (const { door } of kitDoors()) {
      const out = []
      pushDoorLeaves(out, door)
      for (const b of out) {
        if (b.role === 2) expect(b.tint).toHaveLength(3)
        if (b.role === 0 && door.kit.finish === 'wood') {
          expect(b.wood).toBe(true)
          expect(b.tint).toHaveLength(3)
        }
      }
      if (door.kit.leaf === LEAF_PANEL) expect(out.some((b) => b.role === 0 && b.sy < DOOR_H)).toBe(true)
    }
  })

  it('writes hotel room numbers in seven-segment strokes', () => {
    expect(digitStrokes(8)).toHaveLength(7)
    expect(digitStrokes(1)).toHaveLength(2)
    expect(digitStrokes(0)).toHaveLength(6)
    expect(digitStrokes('7')).toEqual(digitStrokes(7))
    // The basement prefix: a lower-case b (c d e f g).
    expect(digitStrokes('b')).toHaveLength(5)
    const brassOf = (out) => out.find((b) => b.role === 2 && Math.abs(b.py - 1.62) < 1e-6 && Math.abs(b.sy - 0.07) < 1e-6)
    const strokesOf = (out) => out.filter((b) => b.role === 2 && b.sy <= 0.04 && b.py > 1.59 && b.py < 1.65 && b.tint[0] < 0.1)
    const plateOf = (number) => {
      const door = { ...base, number, fn: DOOR_GUEST, leaves: [{ hinge: 1, face: 1 }] }
      door.kit = doorKit('hotel', door)
      const out = []
      pushDoorLeaves(out, door)
      return out
    }
    // An unnumbered guest leaf (no room seen behind it) has no plate and no
    // numerals at all: nothing is made up from the doorway's hash.
    const bare = plateOf(null)
    expect(brassOf(bare)).toBeUndefined()
    expect(strokesOf(bare)).toHaveLength(0)
    // The scheduled number is what the plate shows — storey 2, wing 3, room
    // 18: 2 (5 strokes), 3 (5), 1 (2), 8 (7) — every stroke on the brass.
    // Basement b1 and a storey past 9 read five glyphs, which still fit at
    // the full pitch; a sixth closes the pitch up rather than run off.
    for (const [number, count] of [
      ['2318', 5 + 5 + 2 + 7],
      ['b1207', 5 + 2 + 5 + 6 + 3],
      ['10207', 2 + 6 + 5 + 6 + 3],
      ['b10207', 5 + 2 + 6 + 5 + 6 + 3],
    ]) {
      const plate = plateOf(number)
      const digits = strokesOf(plate)
      expect(digits, number).toHaveLength(count)
      const brass = brassOf(plate)
      for (const s of digits) {
        expect(Math.abs(s.pz - brass.pz) + s.sz / 2, number).toBeLessThanOrEqual(brass.sz / 2 + 1e-9)
      }
      // No two glyphs overlap: the bars across them (a, d, g) stand at least
      // a glyph's width (22 mm) apart.
      const centres = [...new Set(digits.filter((s) => s.sz > 0.01).map((s) => Math.round(s.pz * 1e6)))].sort((p, q) => p - q)
      for (let i = 1; i < centres.length; i++) expect(centres[i] - centres[i - 1], number).toBeGreaterThanOrEqual(22000 - 1)
    }
  })

  it('shades veneer with the batch tone and stains the wrong door dark', () => {
    const hotel = schedules('hotel')[0]
    const veneerOf = (tone) => {
      const door = { ...base, tone, fn: DOOR_GUEST, schedule: hotel, leaves: [{ hinge: 1, face: 1 }] }
      door.kit = doorKit('hotel', door)
      const out = []
      pushDoorLeaves(out, door)
      return out.find((b) => b.wood).tint
    }
    const a = veneerOf(0.45)
    const b = veneerOf(0.55)
    for (let i = 0; i < 3; i++) expect(Math.abs(a[i] / b[i] - 1)).toBeLessThan(0.06)
    const dark = veneerOf(DOOR_DARK_CHANCE / 2)
    expect(dark[0]).toBeLessThan(a[0] * 0.5)
  })

  it('glazes a lite by the door wear, frosting only private rooms', () => {
    const office = { ...schedules('office')[0], standard: 'veneer' }
    const paneOf = (decay, privacy = false) => {
      const door = { ...base, fn: DOOR_ROOM, schedule: office, decay, privacy, leaves: [{ hinge: 1, face: 1 }] }
      door.kit = doorKit('office', door)
      const glass = []
      pushDoorLeaves([], door, { glass })
      return glass[0].kind
    }
    expect(paneOf(0.1)).toBe(GLASS_CLEAR)
    expect(paneOf(0.6)).toBe(GLASS_DIRTY)
    expect(paneOf(0.1, true)).toBe(GLASS_FROSTED)
  })
})
