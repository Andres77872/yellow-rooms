import { describe, expect, it } from 'vitest'
import { CHUNK, chunkKey3 } from '../../constants.js'
import { CELL_ROOM, COLUMN_STANDARD, MAP_FAMILY_TOWER } from '../../mapTypes.js'
import { EditorMap, seedFromText } from '../../../editor/EditorMap.js'
import { LIMINAL_KINDS } from '../../../editor/kinds/index.js'
import { buildKind } from '../../../editor/prototypes.js'
import { walkGraph as editorWalkGraph } from '../../../editor/simulate.js'
import { TileCanvas, massChunk } from '../TileCanvas.js'
import { FloorPlan } from '../floorPlan.js'
import { graphComponents, lightField, nodeKey, packNodeKey, walkGraph } from '../simulate.js'

// Spec §6.1: a kind body draws the same chunks on a TileCanvas (origin 0,
// keep all) as on the editor document, so the world's tile programs can BE
// the kind bodies. Until a kind is ported this runs the unmodified kind
// module; after, its thin editor wrapper (kinds/<id>.js → build<Id>Tile with
// the finite ctx).

const SEEDS = ['proto', 'liminal-3']

// Every enumerable field of a chunk as plain JSON (rasters as arrays,
// descriptors and records deep), minus the stair stamp's transient edge
// protection. The seam ring is non-enumerable and never compared.
function chunkSnap(d, shift = { cx: 0, cy: 0, cz: 0 }) {
  const out = {}
  for (const [k, v] of Object.entries(d)) {
    if (k === '_protV' || k === '_protH') continue
    out[k] = ArrayBuffer.isView(v) ? Array.from(v) : v
  }
  out.cx -= shift.cx
  out.cy -= shift.cy
  out.cz -= shift.cz
  return JSON.parse(JSON.stringify(out))
}

function buildBoth(kind, seed, origin = { cx: 0, cy: 0, cz: 0 }) {
  const map = new EditorMap()
  const editorRes = buildKind(map, kind, { seed })
  const canvas = new TileCanvas({
    family: kind.family,
    base: kind.family,
    version: map.meta.worldGenVersion,
    worldSeed: seedFromText(seed),
    origin,
    name: `${kind.id}-${seed}`,
  })
  const canvasRes = kind.build(canvas, seedFromText(seed), {})
  return { map, editorRes, canvas, canvasRes }
}

function expectSameChunks(map, canvas, origin = { cx: 0, cy: 0, cz: 0 }) {
  const shiftKey = (d) => chunkKey3(d.cx - origin.cx, d.cy - origin.cy, d.cz - origin.cz)
  expect([...canvas.chunks.values()].map(shiftKey)).toEqual([...map.chunks.keys()])
  for (const d of canvas.chunks.values()) {
    const e = map.chunks.get(shiftKey(d))
    expect(chunkSnap(d, origin), `chunk ${shiftKey(d)}`).toEqual(chunkSnap(e))
  }
}

describe('canvas parity: every liminal kind on EditorMap vs TileCanvas (origin 0, keep all)', () => {
  for (const kind of LIMINAL_KINDS) {
    it(`${kind.id}: identical chunks, rooms and result`, () => {
      for (const seed of SEEDS) {
        const { map, editorRes, canvas, canvasRes } = buildBoth(kind, seed)
        expect(canvasRes?.error, `${kind.id}/${seed}`).toBeUndefined()
        expect(editorRes).toEqual({ ok: true, kind: kind.id, label: kind.label, ...canvasRes })
        expectSameChunks(map, canvas)
        expect(canvas.rooms).toEqual(map.rooms)
        expect(canvas.nextRoomId).toBe(map.nextRoomId)
        expect(canvas.bounds()).toEqual(map.bounds())
        // Keep-all: nothing is scratch.
        expect(canvas.stats.scratchWalkableWrites).toBe(0)
      }
    }, 60_000)
  }
})

// The three origin fixes (spec §6.4: labelFloor, furnishRoom, sourceCM.locate)
// make a kind draw the same content at any origin. The kinds without catalog
// or atrium stamps (whose descriptors are kind-local until the kit lands)
// cover labelFloor, createRoom/furnishRoom and the stairwell stamp.
describe('canvas parity at a non-zero origin (origin fixes)', () => {
  const ORIGIN = { cx: 7, cy: -3, cz: -5 }
  const PLAIN = ['stairwell', 'nightlot', 'showroom', 'suburb', 'train', 'funhouse']
  for (const id of PLAIN) {
    it(`${id}: the same chunks, shifted`, () => {
      const kind = LIMINAL_KINDS.find((k) => k.id === id)
      const { map, editorRes, canvas, canvasRes } = buildBoth(kind, 'proto', ORIGIN)
      expect(editorRes).toEqual({ ok: true, kind: kind.id, label: kind.label, ...canvasRes })
      expectSameChunks(map, canvas, ORIGIN)
      expect(canvas.rooms).toEqual(map.rooms)
      expect(canvas.bounds()).toEqual(map.bounds())
    }, 60_000)
  }

  it('lightField and walk graphs read a canvas through its local frame (sourceCM.locate)', () => {
    const kind = LIMINAL_KINDS.find((k) => k.id === 'stairwell')
    const { map, canvas } = buildBoth(kind, 'proto', ORIGIN)
    const box = map.bounds()
    for (const cy of [0, 1]) {
      const a = lightField(map, box, cy)
      const b = lightField(canvas, canvas.bounds(), cy)
      expect([...b.level]).toEqual([...a.level])
      expect(b.darkness).toBe(a.darkness)
    }
    const ga = graphComponents(editorWalkGraph(map, box))
    const gb = graphComponents(walkGraph(canvas, canvas.bounds()))
    expect(gb.map((c) => [c.size, c.floors])).toEqual(ga.map((c) => [c.size, c.floors]))
  }, 60_000)
})

describe('walk graph keys', () => {
  it('packed keys are integers, unique, and fall back to strings out of range', () => {
    const seen = new Set()
    for (const cy of [-512, -40, -1, 0, 1, 511]) {
      for (const gx of [-0x100000, -1, 0, 1, 0x2fffff]) {
        for (const gz of [-0x100000, -1, 0, 1, 0xfffff]) {
          const k = packNodeKey(gx, gz, cy)
          expect(Number.isSafeInteger(k)).toBe(true)
          seen.add(k)
        }
      }
    }
    expect(seen.size).toBe(6 * 5 * 5)
    expect(packNodeKey(0, 0, 512)).toBe(nodeKey(0, 0, 512))
    expect(packNodeKey(0x300000, 0, 0)).toBe(nodeKey(0x300000, 0, 0))
    expect(packNodeKey(0, 0x100000, 0)).toBe(nodeKey(0, 0x100000, 0))
  })

  it('packed and string graphs have the same components; the editor keeps string keys', () => {
    for (const id of ['stairwell', 'poolrooms', 'babel']) {
      const map = new EditorMap()
      buildKind(map, LIMINAL_KINDS.find((k) => k.id === id), { seed: 'proto' })
      const box = map.bounds()
      const packed = walkGraph(map, box)
      const strings = editorWalkGraph(map, box)
      expect([...strings.nodes.keys()].every((k) => typeof k === 'string')).toBe(true)
      expect([...packed.nodes.keys()].every((k) => typeof k === 'number')).toBe(true)
      expect(packed.nodes.size).toBe(strings.nodes.size)
      const shape = (g) => graphComponents(g).map((c) => [c.size, c.floors])
      expect(shape(packed)).toEqual(shape(strings))
      expect(walkGraph(map, box, { keys: 'string' }).nodes.size).toBe(strings.nodes.size)
    }
  }, 60_000)
})

describe('TileCanvas', () => {
  const ORIGIN = { cx: 4, cy: 2, cz: -4 }
  // Keep only the global chunks of tile column 4..5, storey 2.
  const keep = (gcx, gcy, gcz) => gcy === 2 && gcz === -4 && gcx >= 4 && gcx <= 5
  const make = (opts = {}) => new TileCanvas({ family: 'stairwell', base: MAP_FAMILY_TOWER, version: 28, worldSeed: 99, origin: ORIGIN, keep, district: { dx: 1, dz: -1 }, ...opts })

  it('maps local coordinates onto global chunks', () => {
    const c = make()
    expect(c.meta).toEqual({ family: MAP_FAMILY_TOWER, seed: 99, worldGenVersion: 28, name: '' })
    c.setCell(3, 0, 5, { kind: CELL_ROOM, spaceId: 7, col: 0 })
    const d = c.chunkAt(0, 0, 0)
    expect([d.cx, d.cy, d.cz]).toEqual([4, 2, -4])
    expect(c.chunks.has(chunkKey3(4, 2, -4))).toBe(true)
    expect(c.globalChunk(4, 2, -4, false)).toBe(d)
    expect(d.mapFamily).toBe('stairwell')
    expect(d.worldSeed).toBe(99)
    expect(d.district).toEqual({ dx: 1, dz: -1 })
    expect(c.cellAt(3, 0, 5)).toMatchObject({ kind: CELL_ROOM, spaceId: 7, col: 0, chunk: d })
    expect(c.isKeptLocal(0, 0, 0)).toBe(true)
    expect(c.isKeptLocal(1, 0, 0)).toBe(true)
    expect(c.isKeptLocal(2, 0, 0)).toBe(false)
    expect(c.isKeptLocal(0, 1, 0)).toBe(false)
    expect(c.stats.chunksCreated).toBe(1)
  })

  it('counts walkable scratch writes and drops scratch chunks at export', () => {
    const c = make()
    c.setCell(3, 0, 5, { col: 0 }) // kept
    c.setCell(2 * CHUNK + 1, 0, 1, { col: COLUMN_STANDARD }) // scratch, mass
    expect(c.stats.scratchWalkableWrites).toBe(0)
    c.setCell(2 * CHUNK + 2, 0, 1, { col: 0 }) // scratch, walkable
    c.setCell(1, 1, 1, { kind: CELL_ROOM }) // scratch storey, default col 0
    expect(c.stats.scratchWalkableWrites).toBe(2)
    const out = c.exportChunks()
    expect([...out.keys()]).toEqual([chunkKey3(4, 2, -4)])
  })

  it('exports an untouched kept chunk as solid mass', () => {
    const c = make()
    c.setWallV(1, 0, 1, 1)
    const touched = c._touch(1, 0, 0) // kept, created, never written
    touched.levelLabel = 'x'
    const out = c.exportChunks()
    expect(out.get(chunkKey3(4, 2, -4))).toBe(c.chunkAt(0, 0, 0))
    const solid = out.get(chunkKey3(5, 2, -4))
    expect(solid).not.toBe(touched)
    expect(solid.cols.every((v) => v === COLUMN_STANDARD)).toBe(true)
    expect(solid.levelLabel).toBe(null)
    expect([solid.cx, solid.cy, solid.cz, solid.mapFamily, solid.worldSeed]).toEqual([5, 2, -4, 'stairwell', 99])
    expect(solid.district).toEqual({ dx: 1, dz: -1 })
    expect(c.stats.untouchedKept).toBe(1)
    expect(chunkSnap(solid)).toEqual(chunkSnap(massChunk(5, 2, -4, { version: 28, family: 'stairwell', worldSeed: 99, district: { dx: 1, dz: -1 } })))

    // The bake's own solid chunk replaces the local helper.
    const calls = []
    const c2 = make({ solidChunk: (x, y, z) => (calls.push([x, y, z]), massChunk(x, y, z)) })
    c2._touch(1, 0, 0)
    c2.exportChunks()
    expect(calls).toEqual([[5, 2, -4]])
  })

  it('never exports default open fabric: uncovered cells of a written kept chunk are mass', () => {
    // A one-chunk plan whose corridor reaches the east column: compile writes
    // the east wall line, which the kept neighbour chunk owns.
    const c = make()
    const plan = new FloorPlan({ x0: 0, z0: 0, x1: CHUNK - 1, z1: CHUNK - 1 })
    plan.rect({ x0: 4, z0: 4, x1: CHUNK - 1, z1: 8 })
    plan.compile(c, 0)
    const own = c.chunkAt(0, 0, 0)
    const east = c.chunkAt(1, 0, 0)
    const ownCols = Array.from(own.cols)
    const eastWalls = Array.from(east.wallV)
    expect(eastWalls.some((v) => v)).toBe(true)
    const out = c.exportChunks()
    expect(out.get(chunkKey3(5, 2, -4))).toBe(east)
    expect(Array.from(east.cols).filter((v) => v === 0)).toEqual([])
    expect(Array.from(east.cols).every((v) => v === COLUMN_STANDARD)).toBe(true)
    expect(Array.from(east.wallV)).toEqual(eastWalls) // the wall line survives
    expect(Array.from(own.cols)).toEqual(ownCols) // every cell of it was compiled
    expect(c.stats).toMatchObject({ untouchedKept: 0, massFilledCells: CHUNK * CHUNK })

    // Partial coverage: set cells keep their values, the rest is mass;
    // furniture and lamps stay, the furniture cell counts as set.
    const p = make()
    p.setCell(1, 0, 1, { kind: CELL_ROOM, spaceId: 3, col: 0 })
    p.addFurniture(2, 0, 1, { kind: 'desk', x: 0, z: 0 })
    p.setLamp(5, 0, 5, true)
    const d = p.exportChunks().get(chunkKey3(4, 2, -4))
    expect(d.cols.filter((v) => v === 0).length).toBe(1)
    expect([d.cellKind[1 + CHUNK], d.spaceId[1 + CHUNK], d.cols[1 + CHUNK]]).toEqual([CELL_ROOM, 3, 0])
    expect(d.furniture).toHaveLength(1)
    expect(d.lamps).toHaveLength(1)
    expect(p.stats.massFilledCells).toBe(CHUNK * CHUNK - 2)

    // A whole-chunk kit stamp (markWritten) is authored as-is.
    const k = make()
    const stamped = k._touch(0, 0, 0)
    k.markWritten(stamped)
    k.exportChunks()
    expect(stamped.cols.every((v) => v === 0)).toBe(true)
    expect(k.stats.massFilledCells).toBe(0)

    // The fill comes from the bake's own solid chunk when it passes one.
    const calls = []
    const f = make({ solidChunk: (x, y, z) => (calls.push([x, y, z]), massChunk(x, y, z)) })
    f.setWallH(1, 0, 1, 1)
    f.exportChunks()
    expect(calls).toEqual([[4, 2, -4]])
  })

  it('bounds are the local bounds of the kept chunks', () => {
    const c = make()
    expect(c.bounds()).toBe(null)
    c.setCell(CHUNK + 1, 0, 1, { col: 0 })
    c.setCell(5 * CHUNK, 3, 1, { col: 0 }) // scratch
    expect(c.bounds()).toEqual({ x0: 1, z0: 0, x1: 1, z1: 0, y0: 0, y1: 0 })
  })
})
