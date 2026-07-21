import { describe, it, expect } from 'vitest'
import { ChunkData } from '../ChunkData.js'
import {
  placeFurniture,
  FURN_DESK,
  FURN_CHAIR,
  FURN_TABLE,
  FURN_CABINET,
  FURN_COPIER,
  FURN_COOLER,
  FURN_PLANT,
  FURN_SOFA,
  FURN_BOOKSHELF,
  FURN_WHITEBOARD,
  FURN_BED,
  FURN_NIGHTSTAND,
  FURN_WARDROBE,
  FURN_TOILET,
  FURN_SINK,
  FURN_TUB,
  FURN_COUNTER,
  FURN_STOVE,
  FURN_FRIDGE,
  FURN_TV,
  FURN_ARMCHAIR,
  FURN_WASHER,
} from '../furniture.js'
import { pushFurnitureModel, FURN_TINT } from '../objects/furniture/index.js'
import { buildChunk } from '../pipeline.js'
import { DEFAULT_WORLD_CONFIG } from '../config.js'
import { moveAndCollide, hasLineOfSight } from '../../player/collision.js'
import { countChunkComponents } from '../topology.js'
import {
  CELL,
  CHUNK,
  ZONE_OFFICE,
  FURN_MARGIN,
  PLAYER_R,
  COL_HALF,
  MONUMENTAL_COL_HALF,
} from '../constants.js'
import { CELL_ROOM, COLUMN_FURNITURE, COLUMN_MONUMENTAL, PASSAGE_DOOR } from '../mapTypes.js'

const ALL_KINDS = [
  FURN_DESK, FURN_CHAIR, FURN_TABLE, FURN_CABINET, FURN_COPIER, FURN_COOLER, FURN_PLANT, FURN_SOFA, FURN_BOOKSHELF, FURN_WHITEBOARD,
  // Residential set (hotel family).
  FURN_BED, FURN_NIGHTSTAND, FURN_WARDROBE, FURN_TOILET, FURN_SINK, FURN_TUB, FURN_COUNTER, FURN_STOVE, FURN_FRIDGE, FURN_TV, FURN_ARMCHAIR, FURN_WASHER,
]

// A walled 8x8 room with a west door, cells typed CELL_ROOM under space id 7.
function roomChunk(x0 = 3, z0 = 3, x1 = 10, z1 = 10) {
  const data = new ChunkData(0, 0, 0, ZONE_OFFICE)
  for (let x = x0; x <= x1; x++) {
    data.setH(x, z0, 1)
    data.setH(x, z1 + 1, 1)
  }
  for (let z = z0; z <= z1; z++) {
    data.setV(x0, z, 1)
    data.setV(x1 + 1, z, 1)
  }
  for (let z = z0; z <= z1; z++) {
    for (let x = x0; x <= x1; x++) {
      data.cellKind[z * CHUNK + x] = CELL_ROOM
      data.spaceId[z * CHUNK + x] = 7
    }
  }
  data.setPassageV(x0, (z0 + z1) >> 1, PASSAGE_DOOR)
  return data
}

const ctx = { zone: ZONE_OFFICE, config: structuredClone(DEFAULT_WORLD_CONFIG) }

describe('placeFurniture', () => {
  it('is deterministic and registers every piece in both representations', () => {
    const a = roomChunk()
    const b = roomChunk()
    placeFurniture(a, ctx)
    placeFurniture(b, ctx)
    expect(a.furniture).toEqual(b.furniture)
    expect(a.furniture.length).toBeGreaterThan(0)
    for (const f of a.furniture) {
      expect(a.colAt(f.lx, f.lz)).toBe(COLUMN_FURNITURE)
    }
  })

  it('keeps pieces inside the room, off the border margin and off door approaches', () => {
    const data = roomChunk()
    placeFurniture(data, ctx)
    const doorZ = (3 + 10) >> 1
    for (const f of data.furniture) {
      expect(f.lx).toBeGreaterThanOrEqual(FURN_MARGIN)
      expect(f.lx).toBeLessThan(CHUNK - FURN_MARGIN)
      expect(f.lz).toBeGreaterThanOrEqual(FURN_MARGIN)
      expect(f.lz).toBeLessThan(CHUNK - FURN_MARGIN)
      expect(data.cellKind[f.lz * CHUNK + f.lx]).toBe(CELL_ROOM)
      // The two cells flanking the door edge must stay clear.
      expect(f.lx === 3 && f.lz === doorZ).toBe(false)
      // The piece's AABB stays inside its own cell.
      const ccx = (f.lx + 0.5) * CELL
      const ccz = (f.lz + 0.5) * CELL
      expect(Math.abs(f.x - ccx) + f.w / 2).toBeLessThanOrEqual(CELL / 2 + 1e-9)
      expect(Math.abs(f.z - ccz) + f.d / 2).toBeLessThanOrEqual(CELL / 2 + 1e-9)
    }
  })

  it('never severs the room walk graph', () => {
    const data = roomChunk()
    const baseline = countChunkComponents(data, true)
    placeFurniture(data, ctx)
    expect(countChunkComponents(data, true)).toBe(baseline)
  })

  it('evicts the record when its cell is carved away', () => {
    const data = roomChunk()
    placeFurniture(data, ctx)
    expect(data.furniture.length).toBeGreaterThan(0)
    const f = data.furniture[0]
    data.setCol(f.lx, f.lz, 0)
    expect(data.furniture.find((o) => o.lx === f.lx && o.lz === f.lz)).toBeUndefined()
  })

  it('furnishes office chunks in the real pipeline without breaking navigation', () => {
    const off = structuredClone(DEFAULT_WORLD_CONFIG)
    off.furniture = { enabled: false }
    let total = 0
    for (let cx = -2; cx <= 2; cx++) {
      for (let cz = -2; cz <= 2; cz++) {
        const data = buildChunk('furn-test', cx, 0, cz, DEFAULT_WORLD_CONFIG)
        if (data.zone !== ZONE_OFFICE) continue
        total += data.furniture.length
        const lamps = new Set(data.lamps.map((l) => `${l.lx},${l.lz}`))
        for (const f of data.furniture) {
          expect(data.colAt(f.lx, f.lz)).toBe(COLUMN_FURNITURE)
          expect(lamps.has(`${f.lx},${f.lz}`)).toBe(false)
          expect(data.hasFloorHole(f.lx, f.lz)).toBe(false)
        }
        const bare = buildChunk('furn-test', cx, 0, cz, off)
        expect(countChunkComponents(data, true)).toBe(countChunkComponents(bare, true))
      }
    }
    expect(total).toBeGreaterThan(0)
  })
})

describe('pushFurnitureModel', () => {
  // Footprints matching the placement records, per kind and facing.
  const dims = (kind, facing) => {
    const alongX = facing === 2 || facing === 3
    switch (kind) {
      case FURN_DESK: return alongX ? [0.85, 1.7] : [1.7, 0.85]
      case FURN_CHAIR: return [0.55, 0.55]
      case FURN_TABLE: return alongX ? [1.1, 2.2] : [2.2, 1.1]
      case FURN_CABINET: return alongX ? [0.45, 0.95] : [0.95, 0.45]
      case FURN_COPIER: return alongX ? [0.7, 0.85] : [0.85, 0.7]
      case FURN_COOLER: return [0.42, 0.42]
      case FURN_SOFA: return alongX ? [0.75, 1.6] : [1.6, 0.75]
      case FURN_BOOKSHELF: return alongX ? [0.35, 1.15] : [1.15, 0.35]
      case FURN_WHITEBOARD: return alongX ? [0.1, 1.8] : [1.8, 0.1]
      case FURN_BED: return alongX ? [2.1, 1.5] : [1.5, 2.1]
      case FURN_NIGHTSTAND: return [0.5, 0.5]
      case FURN_WARDROBE: return alongX ? [0.62, 1.25] : [1.25, 0.62]
      case FURN_TOILET: return alongX ? [0.72, 0.45] : [0.45, 0.72]
      case FURN_SINK: return alongX ? [0.5, 0.75] : [0.75, 0.5]
      case FURN_TUB: return alongX ? [0.75, 1.65] : [1.65, 0.75]
      case FURN_COUNTER: return alongX ? [0.65, 1.25] : [1.25, 0.65]
      case FURN_STOVE: return [0.65, 0.65]
      case FURN_FRIDGE: return alongX ? [0.72, 0.75] : [0.75, 0.72]
      case FURN_TV: return alongX ? [0.45, 1.45] : [1.45, 0.45]
      case FURN_ARMCHAIR: return [0.85, 0.85]
      case FURN_WASHER: return [0.62, 0.62]
      default: return [0.5, 0.5]
    }
  }

  it('builds every kind inside its collision AABB (plus hardware overhang) and within the height contract', () => {
    for (const kind of ALL_KINDS) {
      for (const facing of [0, 1, 2, 3]) {
        const [w, d] = dims(kind, facing)
        const f = { kind, lx: 7, lz: 7, x: 22.5, z: 22.5, w, d, facing }
        const out = []
        pushFurnitureModel(out, f)
        expect(out.length).toBeGreaterThan(2) // every piece is a real assembly
        for (const p of out) {
          expect(Math.abs(p.px - f.x) + p.sx / 2).toBeLessThanOrEqual(f.w / 2 + 0.12)
          expect(Math.abs(p.pz - f.z) + p.sz / 2).toBeLessThanOrEqual(f.d / 2 + 0.12)
          expect(p.py - p.sy / 2).toBeGreaterThanOrEqual(-1e-9)
          // Wall-hugged storage may exceed eye height (rack 1.9, vanity
          // mirror 1.98) — furniture columns never occlude the sight DDA.
          // 2.05 fits the wardrobe, the tallest piece.
          expect(p.py + p.sy / 2).toBeLessThanOrEqual(2.05)
          expect(Object.values(FURN_TINT)).toContainEqual(p.tint)
        }
      }
    }
  })

  it('reads as the intended piece: desk has a screen, cooler a blue bottle', () => {
    const desk = []
    pushFurnitureModel(desk, { kind: FURN_DESK, lx: 7, lz: 7, x: 22.5, z: 22.5, w: 0.85, d: 1.7, facing: 0 })
    expect(desk.some((p) => p.tint === FURN_TINT.screen && p.py > 0.76)).toBe(true)
    expect(desk.some((p) => p.tint === FURN_TINT.keyDark)).toBe(true)
    const cooler = []
    pushFurnitureModel(cooler, { kind: FURN_COOLER, lx: 7, lz: 7, x: 22.5, z: 22.5, w: 0.42, d: 0.42, facing: 2 })
    expect(cooler.some((p) => p.tint === FURN_TINT.bottleBlue)).toBe(true)
  })

  it('reads as the intended piece: sofa cushions, bookshelf books, board writing', () => {
    const sofa = []
    pushFurnitureModel(sofa, { kind: FURN_SOFA, lx: 7, lz: 7, x: 22.5, z: 22.5, w: 1.6, d: 0.75, facing: 0 })
    expect(sofa.some((p) => p.tint === FURN_TINT.sofaCushion)).toBe(true)
    const shelf = []
    pushFurnitureModel(shelf, { kind: FURN_BOOKSHELF, lx: 7, lz: 7, x: 22.5, z: 22.5, w: 1.15, d: 0.35, facing: 0 })
    expect(shelf.some((p) => p.tint === FURN_TINT.shelfWood)).toBe(true)
    expect(shelf.some((p) => p.tint === FURN_TINT.bookRed)).toBe(true)
    const board = []
    pushFurnitureModel(board, { kind: FURN_WHITEBOARD, lx: 7, lz: 7, x: 22.5, z: 22.5, w: 1.8, d: 0.1, facing: 0 })
    expect(board.some((p) => p.tint === FURN_TINT.boardWhite)).toBe(true)
    expect(board.some((p) => p.tint === FURN_TINT.bookRed)).toBe(true) // red diagram
  })

  it('rotates asymmetric parts with facing', () => {
    const at = (facing) => {
      const out = []
      pushFurnitureModel(out, { kind: FURN_DESK, lx: 7, lz: 7, x: 22.5, z: 22.5, w: 0.85, d: 1.7, facing })
      // The modesty panel sits at the local back (v < 0).
      return out.find((p) => p.tint === FURN_TINT.panel && p.sy > 0.3 && p.sy < 0.5)
    }
    const south = at(0)
    const north = at(1)
    expect(south.pz).toBeLessThan(22.5)
    expect(north.pz).toBeGreaterThan(22.5)
  })
})

describe('furniture collision', () => {
  // Mock cm mirroring the ChunkManager contract: furniture cells carry no
  // square column half; precise AABBs come from furnitureAt (world coords).
  function mockCM(data) {
    const inRange = (gx, gz) => gx >= 0 && gx < CHUNK && gz >= 0 && gz < CHUNK
    return {
      wallVAt: (gx, gz) => inRange(gx, gz) && data.vAt(gx, gz) === 1,
      wallHAt: (gx, gz) => inRange(gx, gz) && data.hAt(gx, gz) === 1,
      columnAt: (gx, gz) => inRange(gx, gz) && data.colAt(gx, gz) > 0,
      columnHalfAt: (gx, gz) => {
        if (!inRange(gx, gz)) return 0
        const kind = data.colAt(gx, gz)
        if (!kind || kind === COLUMN_FURNITURE) return 0
        return kind === COLUMN_MONUMENTAL ? MONUMENTAL_COL_HALF : COL_HALF
      },
      furnitureAt: (gx, gz) => {
        if (!inRange(gx, gz)) return null
        const list = data.furniture.filter((f) => f.lx === gx && f.lz === gz)
        if (!list.length) return null
        return list.map((f) => ({ wx: f.x, wz: f.z, w: f.w, d: f.d }))
      },
    }
  }

  it('stops the player at the precise desk AABB, not the cell edge', () => {
    const data = new ChunkData(0, 0, 0, ZONE_OFFICE)
    // Desk centred at (22.5, 22.5), 0.85 along x, 1.7 along z.
    data.setCol(7, 7, COLUMN_FURNITURE)
    data.furniture.push({ kind: FURN_DESK, lx: 7, lz: 7, x: 22.5, z: 22.5, w: 0.85, d: 1.7, facing: 0 })
    const cm = mockCM(data)
    // The engine sub-steps movement, so drive in small increments like it does.
    const pos = { x: 20.5, z: 22.5 }
    let blocked = false
    for (let i = 0; i < 8; i++) {
      const hit = moveAndCollide(cm, pos, 0.5, 0)
      blocked = blocked || hit.x
    }
    expect(blocked).toBe(true)
    // Stops just shy of the desk face (22.5 - 0.425), not the cell edge (21).
    expect(pos.x).toBeCloseTo(22.5 - 0.425 - PLAYER_R - 0.001, 3)
  })

  it('lets the player slip past the narrow side of a piece', () => {
    const data = new ChunkData(0, 0, 0, ZONE_OFFICE)
    data.setCol(7, 7, COLUMN_FURNITURE)
    data.furniture.push({ kind: FURN_DESK, lx: 7, lz: 7, x: 22.5, z: 22.5, w: 0.85, d: 1.7, facing: 0 })
    const cm = mockCM(data)
    // Walking along z well past the desk's 0.425 x-half: only the coarse cell
    // is blocked to navigation, the player is free at the precise AABB level.
    const pos = { x: 21.5, z: 22.5 }
    const hit = moveAndCollide(cm, pos, 0, 1)
    expect(hit.z).toBe(false)
  })

  it('keeps sight lines over low furniture open', () => {
    const data = new ChunkData(0, 0, 0, ZONE_OFFICE)
    data.setCol(7, 7, COLUMN_FURNITURE)
    data.furniture.push({ kind: FURN_CABINET, lx: 7, lz: 7, x: 22.5, z: 22.5, w: 0.95, d: 0.45, facing: 0 })
    const cm = mockCM(data)
    expect(hasLineOfSight(cm, 10, 22.5, 35, 22.5)).toBe(true)
  })
})
