import { describe, it, expect } from 'vitest'
import { ChunkData } from '../ChunkData.js'
import { collectInteriorDressing, PROP_TINT, SIGN_TINT } from '../props.js'
import {
  CELL,
  CHUNK,
  WALL_H,
  THICK,
  HEADER_H,
  ZONE_OFFICE,
  BASEBOARD_H,
  CROWN_H,
  THRESHOLD_H,
  COL_HALF,
  MONUMENTAL_COL_HALF,
  COL_BASE_WIDEN,
  COL_CAP_WIDEN,
  BLADE_SIGN_Y,
  BLADE_SIGN_H,
  VENT_H,
  EXT_T,
} from '../constants.js'
import {
  PASSAGE_DOOR,
  PASSAGE_OPEN,
  PASSAGE_WIDE,
  PASSAGE_WALL,
  WALL_RAIL,
  WALL_WINDOW,
  CELL_CORRIDOR,
  CELL_LOBBY,
  CELL_ROOM,
  COLUMN_STANDARD,
  COLUMN_MONUMENTAL,
  MAP_FAMILY_TOWER,
} from '../mapTypes.js'

const DOOR_H = WALL_H - HEADER_H
const isTint = (tint) => (b) => b.tint === tint

function walledChunk() {
  const data = new ChunkData(0, 0, 0, ZONE_OFFICE)
  for (let z = 0; z < CHUNK; z++) data.setV(5, z, 1)
  return data
}

describe('collectInteriorDressing', () => {
  it('is deterministic for the same chunk data', () => {
    const a = collectInteriorDressing(walledChunk())
    const b = collectInteriorDressing(walledChunk())
    expect(a).toEqual(b)
  })

  it('leaves an undressed open chunk to the ceiling layer only', () => {
    const { trim, props, signs } = collectInteriorDressing(
      new ChunkData(0, 0, 0, ZONE_OFFICE)
    )
    expect(trim).toEqual([])
    expect(signs).toEqual([])
    // No walls, doors or typed cells: the only possible props are ceiling vents.
    for (const p of props) {
      expect([PROP_TINT.vent, PROP_TINT.ventSlat]).toContainEqual(p.tint)
    }
  })

  it('dresses every full-height wall with a baseboard and a crown', () => {
    const { trim } = collectInteriorDressing(walledChunk())
    const boards = trim.filter((b) => b.sy === BASEBOARD_H)
    const crowns = trim.filter((b) => b.sy === CROWN_H)
    expect(boards).toHaveLength(CHUNK)
    expect(crowns).toHaveLength(CHUNK)
    for (const b of boards) expect(b.py - b.sy / 2).toBe(0) // sits on the floor
    for (const b of crowns) expect(b.py + b.sy / 2).toBeCloseTo(WALL_H, 10) // meets the ceiling
    // All centred on the wall plane, slightly proud of both faces.
    for (const b of trim) {
      expect(b.px).toBeCloseTo(5 * CELL, 10)
      expect(b.sx).toBeGreaterThan(THICK)
    }
  })

  it('skips baseboards and crowns on low bridge rails', () => {
    const data = new ChunkData(0, 0, 0, ZONE_OFFICE)
    for (let z = 0; z < CHUNK; z++) data.setV(6, z, 1, PASSAGE_WALL, WALL_RAIL)
    const { trim } = collectInteriorDressing(data)
    expect(trim).toEqual([])
  })

  it('lays threshold strips under doors and wide mouths only', () => {
    const data = walledChunk()
    data.setPassageV(5, 7, PASSAGE_DOOR)
    data.setPassageV(5, 8, PASSAGE_WIDE)
    data.setPassageV(5, 9, PASSAGE_OPEN)
    const { props } = collectInteriorDressing(data)
    const strips = props.filter(isTint(PROP_TINT.threshold))
    expect(strips).toHaveLength(2)
    for (const s of strips) {
      expect(s.sy).toBeLessThanOrEqual(THRESHOLD_H)
      expect(s.py - s.sy / 2).toBe(0)
    }
    expect(strips.map((s) => s.pz).sort((a, b) => a - b)).toEqual([7.5 * CELL, 8.5 * CELL])
  })

  it('hangs exit signs above the door head, in pairs, on a subset of doors', () => {
    const data = walledChunk()
    for (let z = 0; z < CHUNK; z++) data.setPassageV(5, z, PASSAGE_DOOR)
    const { signs } = collectInteriorDressing(data)
    const exits = signs.filter((s) => s.tint === SIGN_TINT.exit)
    expect(exits.length).toBeGreaterThan(0)
    expect(exits.length % 2).toBe(0) // one glowing face per wall face
    for (const s of exits) {
      expect(s.py - s.sy / 2).toBeGreaterThan(DOOR_H)
      expect(s.py + s.sy / 2).toBeLessThan(WALL_H)
      // The glowing face rides proud of its dark housing on the header.
      expect(Math.abs(Math.abs(s.px - 5 * CELL) - THICK / 2 - 0.04 - s.sx / 2)).toBeLessThan(1e-9)
    }
    // A wide mouth never gets an exit sign.
    const wide = walledChunk()
    for (let z = 0; z < CHUNK; z++) wide.setPassageV(5, z, PASSAGE_WIDE)
    expect(collectInteriorDressing(wide).signs.filter((s) => s.tint === SIGN_TINT.exit)).toEqual([])
  })

  it('puts a ribbed radiator under both faces of every window', () => {
    const data = walledChunk()
    data.setV(5, 7, 1, PASSAGE_WALL, WALL_WINDOW)
    const { props } = collectInteriorDressing(data)
    const radiators = props.filter(isTint(PROP_TINT.radiator))
    expect(radiators.length).toBeGreaterThanOrEqual(2)
    for (const r of radiators) {
      expect(r.py - r.sy / 2).toBeGreaterThanOrEqual(0)
      expect(r.py + r.sy / 2).toBeLessThan(0.9) // under the sill
      expect(Math.abs(r.px - 5 * CELL)).toBeLessThan(THICK / 2 + 0.2)
    }
  })

  it('sizes column bases and caps to the shaft, flush with floor and ceiling', () => {
    const data = new ChunkData(0, 0, 0, ZONE_OFFICE)
    data.setCol(3, 3, COLUMN_STANDARD)
    data.setCol(9, 9, COLUMN_MONUMENTAL)
    const { trim } = collectInteriorDressing(data)
    // Stepped base + neck, capital + abacus: four boxes per shaft.
    expect(trim).toHaveLength(8)
    const std = trim.filter((b) => b.px === 3.5 * CELL)
    const mon = trim.filter((b) => b.px === 9.5 * CELL)
    expect(std.map((b) => b.sx).sort((a, b) => a - b)).toEqual([
      (COL_HALF + 0.06) * 2,
      (COL_HALF + 0.08) * 2,
      (COL_HALF + COL_BASE_WIDEN) * 2,
      (COL_HALF + COL_CAP_WIDEN) * 2,
    ].sort((a, b) => a - b))
    for (const b of trim) {
      const nearFloor = Math.abs(b.py - b.sy / 2) < 0.25
      const nearCeil = Math.abs(b.py + b.sy / 2 - WALL_H) < 0.25
      expect(nearFloor || nearCeil).toBe(true)
    }
    expect(Math.max(...mon.map((b) => b.sx))).toBeGreaterThan(2 * MONUMENTAL_COL_HALF)
  })

  it('hangs blade signs above door-head height in corridors and lobbies only', () => {
    const data = new ChunkData(0, 0, 0, ZONE_OFFICE)
    data.cellKind.fill(CELL_CORRIDOR)
    const { signs } = collectInteriorDressing(data)
    const blades = signs.filter((s) => s.sy === BLADE_SIGN_H)
    expect(blades.length).toBeGreaterThan(0)
    for (const b of blades) {
      expect(b.tint).toBe(SIGN_TINT.blade)
      expect(b.py).toBe(BLADE_SIGN_Y)
      expect(b.py - b.sy / 2).toBeGreaterThan(DOOR_H - 0.2)
      // Two hanger rods reach the ceiling, offset from the panel centre.
      const rods = signs.filter(
        (h) => h !== b && h.sy > BLADE_SIGN_H && Math.abs(h.px - b.px) + Math.abs(h.pz - b.pz) > 0.1
      )
      expect(rods.length).toBeGreaterThanOrEqual(2)
      for (const rod of rods) expect(rod.py + rod.sy / 2).toBeCloseTo(WALL_H, 10)
    }
    // Open (untyped) cells get no signs at all.
    const bare = collectInteriorDressing(new ChunkData(0, 0, 0, ZONE_OFFICE))
    expect(bare.signs).toEqual([])
  })

  it('keeps vents off lamps, stair holes and void cells, flush with the ceiling', () => {
    const data = new ChunkData(0, 0, 0, ZONE_OFFICE)
    data.cellKind.fill(CELL_ROOM)
    data.lamps.push({ lx: 3, lz: 3, lit: true })
    data.stairUp = {
      dir: 0,
      landing: { lx: 8, lz: 8 },
      run: [{ lx: 9, lz: 8 }, { lx: 10, lz: 8 }],
      exit: { lx: 11, lz: 8 },
    }
    const { props } = collectInteriorDressing(data)
    const vents = props.filter(isTint(PROP_TINT.vent))
    expect(vents.length).toBeGreaterThan(0)
    for (const v of vents) {
      expect(v.py + v.sy / 2).toBeCloseTo(WALL_H, 10)
      expect(v.sy).toBe(VENT_H)
      // Not inside the lamp cell or the stair run cells.
      const cx = Math.floor(v.px / CELL)
      const cz = Math.floor(v.pz / CELL)
      expect(cx === 3 && cz === 3).toBe(false)
      expect(cz === 8 && cx >= 9 && cx <= 10).toBe(false)
    }
  })

  it('mounts wall props by adjacent cell kind, shallower than a door casing', () => {
    const data = new ChunkData(0, 0, 0, ZONE_OFFICE)
    for (const lx of [5, 8, 11]) {
      for (let z = 0; z < CHUNK; z++) data.setV(lx, z, 1)
      for (let z = 0; z < CHUNK; z++) {
        data.cellKind[z * CHUNK + lx] = CELL_CORRIDOR // east side
        data.cellKind[z * CHUNK + lx - 1] = CELL_LOBBY // west side
      }
    }
    const { props } = collectInteriorDressing(data)
    const wallProps = props.filter(
      (p) => p.tint !== PROP_TINT.vent && p.tint !== PROP_TINT.ventSlat
    )
    expect(wallProps.length).toBeGreaterThan(0)
    for (const p of wallProps) {
      // Extinguishers only on corridor (east) faces; clocks/boards only west.
      // Nothing may stand prouder than a casing plus a glazing pane.
      const plane = Math.round(p.px / CELL) * CELL
      const off = Math.abs(p.px - plane)
      expect(off).toBeLessThanOrEqual(THICK / 2 + EXT_T + 0.02 + 1e-9)
      if (
        p.tint === PROP_TINT.extinguisher ||
        p.tint === PROP_TINT.glassPale ||
        p.tint === PROP_TINT.pipe
      ) {
        expect(p.px).toBeGreaterThan(plane)
      } else {
        expect(p.px).toBeLessThan(plane)
      }
    }
  })

  it('[R26-S01..S04][D05] projects authored Tower sockets into existing prop and sign batches without mutating the descriptor', () => {
    const data = new ChunkData(0, 4, 0, ZONE_OFFICE, undefined, MAP_FAMILY_TOWER)
    data.setV(5, 4, 1, PASSAGE_WALL)
    data.setV(5, 6, 1, PASSAGE_WALL)
    data.setPassageV(5, 8, PASSAGE_WIDE)
    data.setPassageV(5, 10, PASSAGE_DOOR)
    data.lamps.push({ lx: 7, lz: 12, lit: true })
    data.multilevelStructure = Object.freeze({
      id: 17,
      family: MAP_FAMILY_TOWER,
      kind: 'towerSkybridge',
      landmarkSockets: Object.freeze([
        Object.freeze({ slot: 'anchorFloor', kind: 'signage', gx: 4, gz: 4, cy: 4, axis: 'x', side: 1, salt: 0x745101 }),
        Object.freeze({ slot: 'anchorFloor', kind: 'clock', gx: 4, gz: 6, cy: 4, axis: 'x', side: 1, salt: 0x745102 }),
        Object.freeze({ slot: 'bridgeApproach', kind: 'litAccent', gx: 4, gz: 8, cy: 4, axis: 'x', side: 1, salt: 0x745103 }),
        Object.freeze({ slot: 'bridgeApproach', kind: 'door', gx: 4, gz: 10, cy: 4, axis: 'x', side: 1, salt: 0x745104 }),
        Object.freeze({ slot: 'anchorFloor', kind: 'fixture', gx: 7, gz: 12, cy: 4, axis: 'z', side: 1, salt: 0x745105 }),
      ]),
    })
    const descriptorBefore = structuredClone(data.multilevelStructure)

    const first = collectInteriorDressing(data)
    const second = collectInteriorDressing(data)

    expect(second).toEqual(first)
    expect(data.multilevelStructure).toEqual(descriptorBefore)
    expect(first.signs.some(isTint(SIGN_TINT.blade))).toBe(true)
    expect(first.signs.some(isTint(SIGN_TINT.exit))).toBe(true)
    expect(first.props.some(isTint(PROP_TINT.clock))).toBe(true)
    expect(data.passageVAt(5, 10)).toBe(PASSAGE_DOOR)
    expect(data.lamps).toContainEqual({ lx: 7, lz: 12, lit: true })
    expect(data).not.toHaveProperty('towerLandmarks')
  })
})
