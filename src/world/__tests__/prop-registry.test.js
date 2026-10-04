import { describe, it, expect } from 'vitest'
import * as PROPS from '../props/index.js'
import {
  PROP_PACKS,
  PROP_KINDS,
  PROP_BY_ID,
  PROP_DIMS,
  PROP_HEIGHTS,
  PROP_NAMES,
  PROP_PROXIES,
  PROP_MODEL_FILES,
} from '../props/index.js'
import * as FURNITURE from '../furniture.js'
import * as CATALOG from '../rooms/catalog.js'
import { PIECE_DIMS } from '../rooms/furnish.js'
import { FURN_TINT, pushFurnitureModel } from '../objects/furniture/index.js'
import { FURNITURE_PROXIES, furnitureProxyBoxes } from '../objects/furniture/proxies.js'
import { OCC_MAX_H as GRID_OCC_MAX_H } from '../lightGrid/gridSpec.js'
import { CELL, THICK } from '../constants.js'
import { FURN_NAMES } from '../../editor/ui/options.js'

// The liminal-map prop registry (world/props, option B of the furniture
// research): ids that share the furniture record's u8 kind space but stay out
// of world/furniture.js, the 23-kind GLB tables and every furnishing grammar.

// docs: the maps spec §6 table — id, key, pack, file stem, name, dims, height.
const SPEC = [
  [24, 'PROP_STANDPIPE', 'stairwell', 'standpipe', 'standpipe hose cabinet', 0.8, 0.3, 2.05],
  [25, 'PROP_DOORSTOP', 'stairwell', 'doorstop', 'rubber door wedge', 0.12, 0.2, 0.05],
  [28, 'PROP_CART', 'street', 'cart', 'shopping cart', 0.6, 1.0, 1.05],
  [29, 'PROP_WHEELIE_BIN', 'street', 'wheelie_bin', 'wheelie bin', 0.6, 0.75, 1.07],
  [30, 'PROP_DUMPSTER', 'street', 'dumpster', 'dumpster', 1.9, 1.1, 1.3],
  [31, 'PROP_BENCH', 'street', 'bench', 'park bench', 1.8, 0.65, 0.85],
  [36, 'PROP_BAG_BIN', 'showroom', 'bag_bin', 'yellow bag bin', 0.7, 0.5, 0.9],
  [37, 'PROP_FLATPACK', 'showroom', 'flatpack', 'flat-pack box stack', 1.2, 0.8, 0.6],
  [40, 'PROP_STARTING_BLOCK', 'pool', 'starting_block', 'starting block', 0.5, 0.75, 0.75],
  [41, 'PROP_LIFEGUARD_CHAIR', 'pool', 'lifeguard_chair', 'lifeguard chair', 0.9, 1.1, 2.05],
  [42, 'PROP_LOUNGER', 'pool', 'lounger', 'pool lounger', 0.7, 1.95, 0.45],
  [43, 'PROP_KICKBOARD', 'pool', 'kickboard', 'kickboard', 0.3, 0.45, 0.03],
  [44, 'PROP_LOST_BIN', 'pool', 'lost_bin', 'lost-property bin', 0.6, 0.45, 0.85],
  [45, 'PROP_BANDAI', 'pool', 'bandai', 'bandai attendant seat', 1.2, 0.9, 1.6],
  [48, 'PROP_CORNER_SHELF', 'babel', 'corner_shelf', 'slanted corner shelf', 1.15, 1.15, 1.85],
  [49, 'PROP_LECTERN', 'babel', 'lectern', 'reading lectern', 0.6, 0.5, 1.2],
  [50, 'PROP_MAILBOX', 'suburb', 'mailbox', 'mailbox on post', 0.35, 0.55, 1.2],
  [51, 'PROP_KIDS_BIKE', 'suburb', 'kids_bike', "kid's bike", 0.45, 1.2, 0.75],
  [52, 'PROP_GNOME', 'suburb', 'gnome', 'garden gnome', 0.3, 0.3, 0.45],
  [53, 'PROP_DOGHOUSE', 'suburb', 'doghouse', 'doghouse', 0.9, 1.1, 1.0],
  [56, 'PROP_GATE_PODIUM', 'terminal', 'gate_podium', 'gate podium', 1.8, 0.8, 1.1],
  [57, 'PROP_BEAM_SEAT', 'terminal', 'beam_seat', '3-seat beam seating', 1.95, 0.7, 0.85],
  [58, 'PROP_FIDS', 'terminal', 'fids', 'departures screen stand', 1.3, 0.45, 2.05],
  [60, 'PROP_GHOST_LIGHT', 'theater', 'ghost_light', 'ghost light', 0.5, 0.5, 1.9],
  [61, 'PROP_PROMPT_DESK', 'theater', 'prompt_desk', 'prompt desk', 1.1, 0.6, 1.25],
  [62, 'PROP_SEAT_ROW', 'theater', 'seat_row', '3-seat theatre row', 2.0, 0.75, 0.95],
  [63, 'PROP_ROAD_CASE', 'theater', 'road_case', 'road case', 1.2, 0.6, 1.0],
  [64, 'PROP_CHILD_TABLE', 'playplace', 'child_table', 'child table', 1.2, 0.8, 0.55],
  [65, 'PROP_CHILD_CHAIR', 'playplace', 'child_chair', 'child chair', 0.38, 0.38, 0.6],
  [66, 'PROP_ARCADE', 'playplace', 'arcade', 'arcade cabinet', 0.75, 0.85, 1.85],
  [67, 'PROP_PUNCH_BAG', 'playplace', 'punch_bag', 'foam punch bag', 0.8, 0.8, 1.6],
  [68, 'PROP_MASCOT', 'playplace', 'mascot', 'mascot statue', 0.8, 0.7, 1.9],
  [70, 'PROP_METRO_BENCH', 'train', 'metro_bench', 'metro bench', 2.1, 0.55, 0.9],
  [71, 'PROP_SEAT_PAIR', 'train', 'seat_pair', 'transverse seat pair', 1.0, 0.75, 1.1],
  [72, 'PROP_TICKET_GATE', 'train', 'ticket_gate', 'ticket gate', 0.3, 1.5, 1.05],
  [74, 'PROP_HALL_CLOCK', 'house', 'hall_clock', 'hall clock', 0.55, 0.35, 2.05],
  [75, 'PROP_RADIO', 'house', 'radio', 'radio on side table', 0.55, 0.4, 0.95],
  [78, 'PROP_CCTV', 'funhouse', 'cctv', 'CCTV monitor desk', 0.8, 0.55, 1.4],
  [79, 'PROP_BALL_TRACK', 'funhouse', 'ball_track', 'ball track', 1.0, 0.6, 1.2],
]
const PACK_ORDER = [
  'stairwell', 'street', 'showroom', 'pool', 'babel', 'suburb',
  'terminal', 'theater', 'playplace', 'train', 'house', 'funhouse',
]

const OVERHANG = 0.15 // the GLB contract's per-axis overhang past the footprint
const TOL_H = 0.06
const MAX_HALF = 1.2 // collision.js sweeps r + 1.2: every half-extent stays under it
const EPS = 1e-9

const furnIds = (mod) =>
  Object.entries(mod).filter(([k, v]) => k.startsWith('FURN_') && Number.isInteger(v)).map(([, v]) => v)

const opacityArea = (b) =>
  ((b.u1 - b.u0) * (b.v1 - b.v0) + (b.u1 - b.u0) * (b.y1 - b.y0) + (b.v1 - b.v0) * (b.y1 - b.y0)) *
  (1 - b.t / 8)

// Wall-hugging record as prototypes.js addPiece / furnish.js place pieces.
const DIR = [[0, 1], [0, -1], [1, 0], [-1, 0]]
const LX = 4
const LZ = 5
function placement(kind, facing) {
  const [w, d] = PROP_DIMS[kind]
  const [dx, dz] = DIR[facing]
  const off = -(CELL / 2 - THICK / 2 - d / 2 - 0.06)
  const alongX = dx !== 0
  return {
    kind, lx: LX, lz: LZ, facing,
    x: (LX + 0.5) * CELL + dx * off, z: (LZ + 0.5) * CELL + dz * off,
    w: alongX ? d : w, d: alongX ? w : d,
  }
}

describe('prop registry: ids and the spec table', () => {
  it('matches the spec table exactly, in pack order', () => {
    expect(PROP_PACKS.map((p) => p.pack)).toEqual(PACK_ORDER)
    expect(PROP_KINDS.map((k) => [k.id, k.key, k.pack, k.kind, k.name, ...k.dims, k.height])).toEqual(SPEC)
    for (const k of PROP_KINDS) expect(k.cls, k.key).toBe('B')
  })

  it('re-exports every PROP_* id constant from the pack modules', () => {
    const exported = Object.entries(PROPS).filter(([k, v]) => /^PROP_[A-Z_]+$/.test(k) && Number.isInteger(v))
    expect(Object.fromEntries(exported)).toEqual(Object.fromEntries(SPEC.map(([id, key]) => [key, id])))
  })

  it('keeps ids unique u8 kinds above and disjoint from every furniture kind', () => {
    const ids = PROP_KINDS.map((k) => k.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) {
      expect(Number.isInteger(id)).toBe(true)
      expect(id).toBeGreaterThanOrEqual(24)
      expect(id).toBeLessThanOrEqual(255) // .yrmap stores the kind as u8
    }
    const furn = new Set([...furnIds(FURNITURE), ...furnIds(CATALOG)])
    for (const id of ids) expect(furn.has(id), `id ${id}`).toBe(false)
  })

  it('stays out of world/furniture.js and the 23-kind furniture tables', () => {
    const ids = new Set(PROP_KINDS.map((k) => k.id))
    expect(Object.keys(FURNITURE).filter((k) => k.startsWith('PROP_'))).toEqual([])
    for (const v of Object.values(FURNITURE)) if (Number.isInteger(v)) expect(ids.has(v)).toBe(false)
    for (const id of Object.keys(FURNITURE_PROXIES)) expect(ids.has(Number(id))).toBe(false)
  })

  it('is never named by a furnishing grammar, whitelist or anchor', () => {
    const named = new Set()
    const visit = (node) => {
      if (Array.isArray(node)) return node.forEach(visit)
      if (!node || typeof node !== 'object') return
      for (const [k, v] of Object.entries(node)) {
        if ((k === 'kind' || k === 'anchor') && Number.isInteger(v)) named.add(v)
        if ((k === 'kinds' || k === 'whitelist') && Array.isArray(v)) v.forEach((x) => named.add(x))
        visit(v)
      }
    }
    for (const table of [
      CATALOG.ROOM_TYPES, CATALOG.ORDINARY_THEMES, CATALOG.HOTEL_ORDINARY_THEMES,
      CATALOG.FAMILY_ORDINARY_THEMES, CATALOG.FAMILY_ROOM_CATALOGS, CATALOG.SEWER_CHAMBER_CATALOG,
    ]) visit(table)
    expect(named.size).toBeGreaterThan(5) // the walk does reach the grammars
    for (const { id, key } of PROP_KINDS) expect(named.has(id), key).toBe(false)
  })

  it('freezes the aggregate tables', () => {
    for (const t of [PROP_PACKS, PROP_KINDS, PROP_BY_ID, PROP_DIMS, PROP_HEIGHTS, PROP_NAMES, PROP_PROXIES, PROP_MODEL_FILES]) {
      expect(Object.isFrozen(t)).toBe(true)
    }
    for (const files of Object.values(PROP_MODEL_FILES)) expect(Object.isFrozen(files)).toBe(true)
  })
})

describe('prop registry: per-kind data', () => {
  it('has dims, height, name, model file and lookups for every id', () => {
    for (const k of PROP_KINDS) {
      expect(PROP_BY_ID[k.id], k.key).toBe(k)
      expect(PROP_DIMS[k.id], k.key).toEqual(k.dims)
      expect(PROP_HEIGHTS[k.id], k.key).toBe(k.height)
      expect(PROP_NAMES[k.id], k.key).toBe(k.name)
      expect(PROP_MODEL_FILES[k.pack][k.id], k.key).toBe(k.kind)
      expect(k.kind, k.key).toBe(k.key.slice(5).toLowerCase()) // file stem convention
    }
    const files = Object.values(PROP_MODEL_FILES).flatMap((f) => Object.keys(f))
    expect(files.length).toBe(PROP_KINDS.length)
  })

  it('keeps footprints collision-safe and heights inside the occupancy budget', () => {
    for (const { key, dims: [w, d], height } of PROP_KINDS) {
      expect(w / 2, key).toBeLessThan(MAX_HALF)
      expect(d / 2, key).toBeLessThan(MAX_HALF)
      expect(w, key).toBeGreaterThan(0)
      expect(d, key).toBeGreaterThan(0)
      expect(height, key).toBeGreaterThan(0)
      expect(height, key).toBeLessThanOrEqual(GRID_OCC_MAX_H)
    }
  })

  it('describes a 2-6 box fallback inside the footprint, height and palette', () => {
    for (const { key, dims: [w, d], height, boxes } of PROP_KINDS) {
      expect(boxes.length, key).toBeGreaterThanOrEqual(1)
      expect(boxes.length, key).toBeLessThanOrEqual(6)
      for (const [u, y, v, su, sy, sv, tint] of boxes) {
        expect(su > 0 && sy > 0 && sv > 0, key).toBe(true)
        expect(Math.abs(u) + su / 2, key).toBeLessThanOrEqual(w / 2 + OVERHANG + EPS)
        expect(Math.abs(v) + sv / 2, key).toBeLessThanOrEqual(d / 2 + OVERHANG + EPS)
        expect(y - sy / 2, key).toBeGreaterThanOrEqual(-EPS)
        expect(y + sy / 2, key).toBeLessThanOrEqual(height + TOL_H)
        const rgb = typeof tint === 'string' ? FURN_TINT[tint] : tint
        expect(Array.isArray(rgb) && rgb.length === 3, `${key} tint ${tint}`).toBe(true)
        for (const c of rgb) expect(c >= 0 && c <= 1, `${key} tint ${tint}`).toBe(true)
      }
      // The pieces reach their declared height (the fallback reads true size).
      const top = Math.max(...boxes.map(([, y, , , sy]) => y + sy / 2))
      expect(top, key).toBeGreaterThan(height * 0.85)
    }
    // Most kinds read as an object, not a crate: at least two parts.
    expect(PROP_KINDS.filter((k) => k.boxes.length >= 2).length).toBeGreaterThan(PROP_KINDS.length * 0.8)
  })

  it('stands every fallback on the floor, plinth or legs included, like its GLB', () => {
    // Every pack model sits on the floor from y=0 (the train ones on a
    // slotDark toe-kick, the ball track on its table legs); a fallback that
    // leaves the bottom out hovers a few cm over a lit gap.
    for (const { key, boxes } of PROP_KINDS) {
      const bottom = Math.min(...boxes.map(([, y, , , sy]) => y - sy / 2))
      expect(bottom, key).toBeCloseTo(0, 6)
    }
  })

  it('declares 1-2 shadow proxies under the proxies.js contract', () => {
    for (const { id, key, dims: [w, d], height } of PROP_KINDS) {
      const boxes = PROP_PROXIES[id]
      expect(Object.isFrozen(boxes), key).toBe(true)
      expect(boxes.length, key).toBeGreaterThanOrEqual(1)
      expect(boxes.length, key).toBeLessThanOrEqual(2)
      for (const b of boxes) {
        expect(Object.isFrozen(b), key).toBe(true)
        expect(Object.keys(b), key).toEqual(['u0', 'u1', 'v0', 'v1', 'y0', 'y1', 't'])
        expect(b.u0 < b.u1 && b.v0 < b.v1 && b.y0 < b.y1, key).toBe(true)
        expect(b.y0, key).toBeGreaterThanOrEqual(0)
        expect(b.y1, key).toBeLessThanOrEqual(GRID_OCC_MAX_H)
        expect(b.y1, key).toBeLessThanOrEqual(height + TOL_H)
        expect(Number.isInteger(b.t) && b.t >= 0 && b.t <= 7, key).toBe(true)
        for (const c of [b.u0, b.u1]) expect(Math.abs(c), key).toBeLessThanOrEqual(Math.min(CELL / 2, w / 2 + OVERHANG))
        for (const c of [b.v0, b.v1]) expect(Math.abs(c), key).toBeLessThanOrEqual(Math.min(CELL / 2, d / 2 + OVERHANG))
      }
      if (boxes[1]) expect(opacityArea(boxes[0]), key).toBeGreaterThanOrEqual(opacityArea(boxes[1]))
    }
  })
})

describe('prop registry: runtime wiring', () => {
  it('feeds PIECE_DIMS and the editor names without touching the furniture entries', () => {
    for (const k of PROP_KINDS) {
      expect(PIECE_DIMS[k.id], k.key).toEqual(k.dims)
      expect(FURN_NAMES[k.id], k.key).toBe(k.name)
    }
    expect(FURN_NAMES[1]).toBe('desk')
    expect(FURN_NAMES[23]).toBe('washer')
  })

  it('builds every prop through the furniture box path at all four facings', () => {
    for (const k of PROP_KINDS) {
      for (let facing = 0; facing < 4; facing++) {
        const f = placement(k.id, facing)
        const parts = pushFurnitureModel([], f)
        expect(parts.length, k.key).toBe(k.boxes.length)
        for (const p of parts) {
          expect(Math.abs(p.px - f.x) + p.sx / 2, `${k.key} facing ${facing}`).toBeLessThanOrEqual(f.w / 2 + OVERHANG + EPS)
          expect(Math.abs(p.pz - f.z) + p.sz / 2, `${k.key} facing ${facing}`).toBeLessThanOrEqual(f.d / 2 + OVERHANG + EPS)
          expect(p.tint).toHaveLength(3)
        }
      }
    }
  })

  it('casts lamp-shadow proxies through furnitureProxyBoxes, inside the cell', () => {
    for (const k of PROP_KINDS) {
      for (let facing = 0; facing < 4; facing++) {
        const f = placement(k.id, facing)
        const out = []
        const n = furnitureProxyBoxes(f, out)
        expect(n, k.key).toBeGreaterThan(0)
        expect(n, k.key).toBeLessThanOrEqual(PROP_PROXIES[k.id].length)
        for (const b of out) {
          expect(b.x0, k.key).toBeGreaterThanOrEqual(LX * CELL)
          expect(b.x1, k.key).toBeLessThanOrEqual((LX + 1) * CELL)
          expect(b.z0, k.key).toBeGreaterThanOrEqual(LZ * CELL)
          expect(b.z1, k.key).toBeLessThanOrEqual((LZ + 1) * CELL)
        }
      }
    }
  })
})
