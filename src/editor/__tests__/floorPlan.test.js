import { describe, expect, it } from 'vitest'
import { EditorMap } from '../EditorMap.js'
import {
  CELL,
  CELL_CORRIDOR,
  CELL_LOBBY,
  CHUNK,
  FACING,
  FloorPlan,
  MIRROR_UNSAFE,
  PASSAGE_DOOR,
  PASSAGE_WALL,
  SPACE_ROLE_OFFICE,
  WALL_PLAIN,
  WALL_RAIL,
  WALL_WINDOW,
  featureEdge,
  labelFloor,
} from '../kinds/floorPlan.js'
import { PROTOTYPE_KINDS, buildKind, generatePrototype } from '../prototypes.js'
import { expectKindClean, judgeMap } from './kindJudge.js'
import { FURN_CABINET, FURN_DESK } from '../../world/rooms/catalog.js'
import {
  PROP_CORNER_SHELF,
  PROP_KINDS,
  PROP_LECTERN,
  PROP_LIFEGUARD_CHAIR,
  PROP_PROXIES,
  PROP_STANDPIPE,
  PROP_TICKET_GATE,
} from '../../world/props/index.js'
import { listPacks, readPackManifest } from '../../render/__tests__/packManifest.js'

const worldX = (map, gx, rec) => map.cellChunk(gx) * CHUNK * CELL + rec.x
const worldZ = (map, gz, rec) => map.cellChunk(gz) * CHUNK * CELL + rec.z

describe('FloorPlan features', () => {
  it('compiles windows and rails as walled edges and marks the owning chunk', () => {
    const map = new EditorMap()
    const plan = new FloorPlan({ x0: 0, z0: 0, x1: 27, z1: 13 })
    plan.rect({ x0: 1, z0: 2, x1: 26, z1: 4 })
    plan.window('h', 3, 2) // row 1 is mass: an outer window
    plan.rail('v', 14, 3) // between two plan cells, on chunk 1's West line
    plan.edge('h', 5, 5, 1, PASSAGE_WALL, WALL_PLAIN)
    map.mutate(() => plan.compile(map, 0))
    expect(map.wallHAt(3, 0, 2)).toEqual({ wall: 1, passage: PASSAGE_WALL, feature: WALL_WINDOW })
    expect(map.wallVAt(14, 0, 3)).toEqual({ wall: 1, passage: PASSAGE_WALL, feature: WALL_RAIL })
    expect(map.chunkAt(0, 0, 0).authoredFeatures).toBe(true)
    expect(map.chunkAt(1, 0, 0).authoredFeatures).toBe(true)
  })

  it('leaves chunks without a placed feature unmarked', () => {
    const map = new EditorMap()
    const plan = new FloorPlan({ x0: 0, z0: 0, x1: 27, z1: 13 })
    plan.rect({ x0: 1, z0: 2, x1: 26, z1: 4 })
    plan.window('h', 3, 2)
    // A feature on an open edge does not stick (ChunkData.setH), so it marks nothing.
    plan.edge('v', 20, 3, 0, PASSAGE_DOOR, WALL_WINDOW)
    map.mutate(() => plan.compile(map, 0))
    expect(map.chunkAt(0, 0, 0).authoredFeatures).toBe(true)
    expect(map.chunkAt(1, 0, 0).authoredFeatures).toBe(false)
    expect(map.wallVAt(20, 0, 3).feature).toBe(WALL_PLAIN)
  })

  it('featureEdge writes a window after the stamps and undoes as one step', () => {
    const map = new EditorMap()
    const plan = new FloorPlan({ x0: 0, z0: 0, x1: 13, z1: 13 })
    plan.rect({ x0: 1, z0: 1, x1: 12, z1: 3 })
    map.mutate(() => plan.compile(map, 0))
    expect(map.chunkAt(0, 0, 0).authoredFeatures).toBe(false)
    map.mutate(() => featureEdge(map, 'h', 4, 0, 4, WALL_RAIL))
    expect(map.wallHAt(4, 0, 4)).toEqual({ wall: 1, passage: PASSAGE_WALL, feature: WALL_RAIL })
    expect(map.chunkAt(0, 0, 0).authoredFeatures).toBe(true)
    map.undo()
    expect(map.chunkAt(0, 0, 0).authoredFeatures).toBe(false)
    expect(map.wallHAt(4, 0, 4).feature).toBe(WALL_PLAIN)
    map.redo()
    expect(map.chunkAt(0, 0, 0).authoredFeatures).toBe(true)
  })
})

describe('FloorPlan lamps', () => {
  it('passes a tint to the lamp record and keeps untinted records unchanged', () => {
    const map = new EditorMap()
    const plan = new FloorPlan({ x0: 0, z0: 0, x1: 13, z1: 13 })
    plan.rect({ x0: 1, z0: 1, x1: 12, z1: 3 })
    plan.lamp(2, 2)
    plan.lamp(5, 2, false, 0xff8040)
    map.mutate(() => plan.compile(map, 0))
    expect(map.lampAt(2, 0, 2).rec).toEqual({ lx: 2, lz: 2, lit: true })
    expect(map.lampAt(5, 0, 2).rec).toEqual({ lx: 5, lz: 2, lit: false, tint: 0xff8040 })
  })

  it('setLamp: undefined keeps a tint, null removes it, a number sets it', () => {
    const map = new EditorMap()
    map.setLamp(1, 0, 1, true, 0x80ff80)
    map.setLamp(1, 0, 1, false)
    expect(map.lampAt(1, 0, 1).rec).toEqual({ lx: 1, lz: 1, lit: false, tint: 0x80ff80 })
    map.setLamp(1, 0, 1, true, 0x112233)
    expect(map.lampAt(1, 0, 1).rec.tint).toBe(0x112233)
    map.setLamp(1, 0, 1, true, null)
    expect(map.lampAt(1, 0, 1).rec).toEqual({ lx: 1, lz: 1, lit: true })
    map.setLamp(1, 0, 1, null)
    expect(map.lampAt(1, 0, 1)).toBeNull()
  })

  it('a lamp tint survives undo and redo', () => {
    const map = new EditorMap()
    map.mutate(() => map.setLamp(3, 0, 3, true))
    map.mutate(() => map.setLamp(3, 0, 3, true, 0x4060ff))
    map.undo()
    expect(map.lampAt(3, 0, 3).rec.tint).toBeUndefined()
    map.redo()
    expect(map.lampAt(3, 0, 3).rec.tint).toBe(0x4060ff)
  })
})

describe('labelFloor', () => {
  const twoFloors = () => {
    const map = new EditorMap()
    const plan = new FloorPlan({ x0: 0, z0: 0, x1: 27, z1: 13 })
    plan.rect({ x0: 1, z0: 1, x1: 26, z1: 3 })
    map.mutate(() => {
      plan.compile(map, 0)
      plan.compile(map, 1)
    })
    return map
  }

  it('labels every chunk of one storey, or one chunk column', () => {
    const map = twoFloors()
    expect(map.mutate(() => labelFloor(map, 1, 'P1'))).toBe(2)
    expect(map.chunkAt(0, 1, 0).levelLabel).toBe('P1')
    expect(map.chunkAt(1, 1, 0).levelLabel).toBe('P1')
    expect(map.chunkAt(0, 0, 0).levelLabel).toBeNull()
    expect(map.mutate(() => labelFloor(map, 0, 'L', { cx: 1, cz: 0 }))).toBe(1)
    expect(map.chunkAt(1, 0, 0).levelLabel).toBe('L')
    expect(map.chunkAt(0, 0, 0).levelLabel).toBeNull()
  })

  it('is undoable and rejects labels the plates cannot print', () => {
    const map = twoFloors()
    map.mutate(() => labelFloor(map, 0, 'b-2'))
    map.undo()
    expect(map.chunkAt(0, 0, 0).levelLabel).toBeNull()
    map.redo()
    expect(map.chunkAt(0, 0, 0).levelLabel).toBe('b-2')
    expect(() => labelFloor(map, 0, 'LOBBY')).toThrow(/plate glyphs/)
    expect(() => labelFloor(map, 0, 'X')).toThrow(/plate glyphs/)
    expect(() => labelFloor(map, 0, 7)).toThrow(/plate glyphs/)
    map.mutate(() => labelFloor(map, 0, null))
    expect(map.chunkAt(0, 0, 0).levelLabel).toBeNull()
  })
})

describe('FloorPlan.mirror', () => {
  // An asymmetric west half: a room with a door and a window, a corridor, a
  // column, wall-hugging and centred pieces, lit / dead / tinted lamps.
  const westHalf = () => {
    const plan = new FloorPlan({ x0: 0, z0: 0, x1: 13, z1: 13 })
    plan.rect({ x0: 1, z0: 6, x1: 6, z1: 7 }, CELL_CORRIDOR)
    plan.rect({ x0: 4, z0: 1, x1: 6, z1: 5 }, CELL_LOBBY)
    plan.room({ x0: 1, z0: 1, x1: 3, z1: 4 }, { spaceId: 100, role: SPACE_ROLE_OFFICE, doors: [{ axis: 'v', gx: 4, gz: 2 }], lamp: true })
    plan.window('v', 1, 2)
    plan.rail('h', 4, 8)
    plan.rect({ x0: 2, z0: 8, x1: 6, z1: 11 }, CELL_CORRIDOR)
    plan.column(4, 10)
    plan.piece(1, 3, FURN_CABINET, { wall: 'W' })
    plan.piece(3, 1, FURN_DESK, { wall: 'N' })
    plan.piece(5, 9, FURN_DESK, { facing: FACING.E })
    plan.lamp(5, 7, false)
    plan.lamp(3, 9, true, 0xffa060)
    return plan
  }

  it('across x: the compiled plan is the exact reflection', () => {
    const plan = westHalf()
    const line = 7
    expect(plan.mirror({ axis: 'x', line, from: { x0: 1, z0: 1, x1: 6, z1: 12 }, spaceOffset: 50 })).toBe(plan.cells.size / 2)
    const map = new EditorMap()
    map.mutate(() => plan.compile(map, 0))
    const mx = (gx) => 2 * line - 1 - gx
    for (let gz = 0; gz < 14; gz++) {
      for (let gx = 0; gx < 7; gx++) {
        const a = map.cellAt(gx, 0, gz)
        const b = map.cellAt(mx(gx), 0, gz)
        expect([b.kind, b.role, b.col, b.spaceId], `cell ${gx},${gz}`).toEqual([a.kind, a.role, a.col, a.spaceId ? a.spaceId + 50 : 0])
        expect(map.wallHAt(mx(gx), 0, gz), `h ${gx},${gz}`).toEqual(map.wallHAt(gx, 0, gz))
        const lamp = map.lampAt(gx, 0, gz)?.rec
        const twin = map.lampAt(mx(gx), 0, gz)?.rec
        expect(twin && { lit: twin.lit, tint: twin.tint }, `lamp ${gx},${gz}`).toEqual(lamp && { lit: lamp.lit, tint: lamp.tint })
        const piece = map.furnitureAt(gx, 0, gz)?.rec
        const flip = map.furnitureAt(mx(gx), 0, gz)?.rec
        if (!piece) {
          expect(flip, `piece ${gx},${gz}`).toBeUndefined()
          continue
        }
        const facing = { [FACING.E]: FACING.W, [FACING.W]: FACING.E }[piece.facing] ?? piece.facing
        expect([flip.kind, flip.facing, flip.w, flip.d]).toEqual([piece.kind, facing, piece.w, piece.d])
        expect(worldX(map, mx(gx), flip)).toBeCloseTo(2 * line * CELL - worldX(map, gx, piece), 6)
        expect(worldZ(map, gz, flip)).toBeCloseTo(worldZ(map, gz, piece), 6)
      }
      for (let gx = 0; gx <= 14; gx++) {
        expect(map.wallVAt(2 * line - gx, 0, gz), `v ${gx},${gz}`).toEqual(map.wallVAt(gx, 0, gz))
      }
    }
    // The features were mirrored too, and the plan stays one walkable floor.
    expect(map.wallVAt(13, 0, 2).feature).toBe(WALL_WINDOW)
    expect(map.wallHAt(9, 0, 8).feature).toBe(WALL_RAIL)
    const { floors, bad } = judgeMap(map)
    expect(floors).toEqual([[expect.any(String)]])
    expect(bad).toEqual([])
  })

  it('across z: rows and H-lines reflect, N/S fronts and walls swap', () => {
    const plan = new FloorPlan({ x0: 0, z0: 0, x1: 13, z1: 13 })
    plan.rect({ x0: 2, z0: 1, x1: 5, z1: 6 }, CELL_CORRIDOR)
    plan.edge('h', 3, 3, 1, PASSAGE_WALL, WALL_WINDOW)
    plan.edge('v', 4, 2, 1, PASSAGE_WALL)
    plan.piece(2, 1, FURN_CABINET, { wall: 'N' })
    plan.piece(5, 2, FURN_DESK, { facing: FACING.S })
    plan.lamp(3, 5, true, 0x00ff00)
    plan.mirror({ axis: 'z', line: 7, from: { x0: 2, z0: 1, x1: 5, z1: 6 } })
    expect(plan.has(2, 12)).toBe(true)
    expect(plan.edges.get('h:3,11')).toEqual({ wall: 1, passage: PASSAGE_WALL, feature: WALL_WINDOW })
    expect(plan.edges.get('v:4,11')).toEqual({ wall: 1, passage: PASSAGE_WALL, feature: WALL_PLAIN })
    expect(plan.pieces.slice(2)).toEqual([
      { gx: 2, gz: 12, kind: FURN_CABINET, front: FACING.N, wall: 'S' },
      { gx: 5, gz: 11, kind: FURN_DESK, front: FACING.N, wall: null },
    ])
    expect(plan.lamps[1]).toEqual({ gx: 3, gz: 8, lit: true, tint: 0x00ff00 })
  })

  it('reflects a chiral corner shelf into the mirrored corner', () => {
    // objects/furniture/frame.js: local (u, v) -> world offset per facing.
    const ox = (f, u, v) => [[u, v], [-u, -v], [v, -u], [-v, u]][f & 3]
    const byRect = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]
    // A piece's shadow proxies as world-space [x0, x1, z0, z1] rects, sorted.
    const rects = (p) => {
      const cx = (p.gx + 0.5) * CELL
      const cz = (p.gz + 0.5) * CELL
      return PROP_PROXIES[p.kind]
        .map((b) => {
          const [ax, az] = ox(p.front, b.u0, b.v0)
          const [bx, bz] = ox(p.front, b.u1, b.v1)
          return [cx + Math.min(ax, bx), cx + Math.max(ax, bx), cz + Math.min(az, bz), cz + Math.max(az, bz)]
        })
        .map((r) => r.map((n) => Math.round(n * 1000) / 1000))
        .sort(byRect)
    }
    const line = 4
    const L = line * CELL
    const reflect = {
      x: ([x0, x1, z0, z1]) => [2 * L - x1, 2 * L - x0, z0, z1],
      z: ([x0, x1, z0, z1]) => [x0, x1, 2 * L - z1, 2 * L - z0],
    }
    for (const axis of ['x', 'z']) {
      for (const facing of [FACING.S, FACING.N, FACING.E, FACING.W]) {
        const plan = new FloorPlan({ x0: 0, z0: 0, x1: 13, z1: 13 })
        plan.piece(1, 2, PROP_CORNER_SHELF, { facing })
        plan.mirror({ axis, line, from: { x0: 0, z0: 0, x1: 3, z1: 3 } })
        const [orig, copy] = plan.pieces
        const want = rects(orig)
          .map(reflect[axis])
          .map((r) => r.map((n) => Math.round(n * 1000) / 1000))
          .sort(byRect)
        expect(rects(copy), `${axis} facing ${facing}`).toEqual(want)
      }
    }
  })

  it('rejects an unknown axis', () => {
    expect(() => new FloorPlan({ x0: 0, z0: 0, x1: 13, z1: 13 }).mirror({ axis: 'y', line: 3, from: { x0: 0, z0: 0, x1: 1, z1: 1 } })).toThrow(/axis/)
  })

  it('refuses a left-right asymmetric prop inside `from`, writing nothing', () => {
    for (const [kind, key] of [
      [PROP_STANDPIPE, 'PROP_STANDPIPE'],
      [PROP_TICKET_GATE, 'PROP_TICKET_GATE'],
      [PROP_LIFEGUARD_CHAIR, 'PROP_LIFEGUARD_CHAIR'],
    ]) {
      const plan = new FloorPlan({ x0: 0, z0: 0, x1: 13, z1: 13 })
      plan.rect({ x0: 1, z0: 1, x1: 6, z1: 4 }, CELL_CORRIDOR)
      plan.piece(2, 1, PROP_LECTERN, { wall: 'N' })
      plan.piece(4, 1, kind, { wall: 'N' })
      plan.lamp(3, 3)
      const from = { x0: 1, z0: 1, x1: 6, z1: 4 }
      expect(() => plan.mirror({ axis: 'x', line: 7, from }), key).toThrow(new RegExp(`${key} .* at 4,1 is left-right asymmetric`))
      expect(() => plan.mirror({ axis: 'z', line: 7, from }), key).toThrow(/asymmetric/)
      expect([plan.cells.size, plan.pieces.length, plan.lamps.length], key).toEqual([24, 2, 1])
      // Outside `from` it does not block the mirror (the lectern is symmetric).
      plan.mirror({ axis: 'x', line: 7, from: { x0: 1, z0: 1, x1: 3, z1: 4 } })
      expect(plan.pieces.map((p) => [p.gx, p.kind]), key).toEqual([[2, PROP_LECTERN], [4, kind], [11, PROP_LECTERN]])
    }
  })

  it('lists every prop whose shadow proxies sit off its axis as mirror-unsafe', () => {
    // A proxy box more than 5 cm off the model's u axis is a one-sided
    // structure; the chiral corner shelf has its own reflection table.
    const offAxis = PROP_KINDS.filter((k) => PROP_PROXIES[k.id].some((b) => Math.abs(b.u0 + b.u1) / 2 > 0.05))
    for (const k of offAxis) {
      if (k.id !== PROP_CORNER_SHELF) expect(MIRROR_UNSAFE.has(k.id), k.key).toBe(true)
    }
    expect(offAxis.length).toBeGreaterThanOrEqual(4)
    expect(MIRROR_UNSAFE.has(PROP_CORNER_SHELF)).toBe(false)
  })

  it('lists every prop whose model bounds sit off its axis as mirror-unsafe', () => {
    // The proxies miss model-only parts (the lifeguard chair's ring buoy), so
    // the built GLB's bounds are checked too: a left-right span more than
    // 5 cm off centre (|min.x + max.x| > 0.05) is a one-sided part.
    const propKeys = new Set(PROP_KINDS.map((k) => k.key))
    const offAxis = listPacks()
      .flatMap((pack) => readPackManifest(pack).kinds)
      .filter((m) => propKeys.has(m.kindKey) && Math.abs(m.bounds.min[0] + m.bounds.max[0]) > 0.05)
      .map((m) => m.kindKey)
    const unsafeKeys = PROP_KINDS.filter((k) => MIRROR_UNSAFE.has(k.id)).map((k) => k.key)
    for (const key of offAxis) {
      if (key !== 'PROP_CORNER_SHELF') expect(unsafeKeys, key).toContain(key)
    }
    expect(offAxis).toContain('PROP_LIFEGUARD_CHAIR')
  })
})

// A scratch kind (not registered): one ground floor whose corridor has an
// outer window bay and a rail across a light well — features only a kind
// places, so only its authoredFeatures opt-in keeps the audit clean.
const SCRATCH_GLAZED = {
  id: 'glazedScratch',
  label: 'glazed corridor (test)',
  family: 'office',
  floors: 1,
  palette: null,
  build(map) {
    const plan = new FloorPlan({ x0: 0, z0: 0, x1: 27, z1: 13 })
    plan.rect({ x0: 1, z0: 2, x1: 26, z1: 4 })
    plan.rect({ x0: 10, z0: 5, x1: 12, z1: 8 }, CELL_LOBBY)
    for (let gx = 2; gx <= 24; gx += 2) plan.window('h', gx, 2)
    plan.rail('h', 11, 5)
    plan.rail('v', 14, 3)
    plan.lamp(4, 3)
    plan.compile(map, 0)
    return { spawn: { gx: 2, gz: 3, cy: 0 } }
  },
}

describe('kinds with authored features', () => {
  it('a ground-floor window / rail kind audits clean through authoredFeatures', () => {
    expectKindClean(expect, SCRATCH_GLAZED, ['proto', 'liminal-1'])
  })

  it('the same chunks without the opt-in are stray features', () => {
    const map = new EditorMap()
    expect(buildKind(map, SCRATCH_GLAZED, { seed: 'proto' }).ok).toBe(true)
    for (const d of map.chunks.values()) d.authoredFeatures = false
    expect(judgeMap(map).audit.details.strayWallFeatures).toHaveLength(2)
  })
})

describe('generatePrototype document state', () => {
  it('restarts room numbering and sets the kind palette, both undoable', () => {
    const map = new EditorMap()
    map.nextRoomId = 9
    const paletted = { ...SCRATCH_GLAZED, palette: 'nightLot' }
    buildKind(map, paletted, { seed: 'a' })
    expect(map.nextRoomId).toBe(1)
    expect(map.meta.palette).toBe('nightLot')
    generatePrototype(map, 'school', { seed: 'a' })
    expect(map.meta.palette).toBeNull()
    map.undo()
    expect(map.meta.palette).toBe('nightLot')
    map.undo()
    expect(map.meta.palette).toBeNull()
    expect(map.nextRoomId).toBe(9)
    map.redo()
    expect(map.meta.palette).toBe('nightLot')
  })

  it('a palette-only change is its own undo step', () => {
    const map = new EditorMap({ palette: 'poolTile' })
    expect(map.meta.palette).toBe('poolTile')
    map.mutate(() => {
      map.meta.palette = 'metroTile'
    })
    map.undo()
    expect(map.meta.palette).toBe('poolTile')
  })
})

describe('existing kinds over several seeds', () => {
  for (const kind of PROTOTYPE_KINDS.slice(0, 5)) {
    it(`${kind.id}: clean, connected and deterministic`, () => {
      expectKindClean(expect, kind.id, ['lobby', 'liminal-2', 'liminal-6'])
    })
  }
})
