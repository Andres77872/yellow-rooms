import { describe, expect, it } from 'vitest'
import { SPACE_ROLE_BREAK } from '../../world/mapTypes.js'
import { EditorMap } from '../EditorMap.js'
import { createRoom } from '../roomBuilder.js'
import { decodeMapFile, deserializeMap, encodeMapFile, serializeMap } from '../format/yrmap.js'

const RASTERS = [
  'wallV', 'wallH', 'passageV', 'passageH',
  'wallFeatureV', 'wallFeatureH', 'cols', 'cellKind', 'spaceId', 'spaceRole',
]

function expectSameMap(a, b) {
  expect(b.meta).toEqual(a.meta)
  expect(b.nextRoomId).toBe(a.nextRoomId)
  expect(b.rooms).toEqual(a.rooms)
  expect([...b.chunks.keys()].sort()).toEqual([...a.chunks.keys()].sort())
  for (const [key, da] of a.chunks) {
    const db = b.chunks.get(key)
    for (const f of RASTERS) {
      expect(db[f], `${key}.${f}`).toEqual(da[f])
    }
    expect(db.lamps).toEqual(da.lamps)
    expect(db.furniture.length).toBe(da.furniture.length)
    da.furniture.forEach((fa, i) => {
      const fb = db.furniture[i]
      expect(fb.kind).toBe(fa.kind)
      expect(fb.lx).toBe(fa.lx)
      expect(fb.lz).toBe(fa.lz)
      expect(fb.facing).toBe(fa.facing)
      // f32 round-trip loses double precision; compare at f32 tolerance.
      expect(fb.x).toBeCloseTo(fa.x, 5)
      expect(fb.z).toBeCloseTo(fa.z, 5)
      expect(fb.w).toBeCloseTo(fa.w, 5)
      expect(fb.d).toBeCloseTo(fa.d, 5)
    })
    expect(db.exit).toEqual(da.exit)
    expect(db.zone).toBe(da.zone)
    expect(JSON.stringify(db.stairUp)).toBe(JSON.stringify(da.stairUp))
    expect(JSON.stringify(db.stairDown)).toBe(JSON.stringify(da.stairDown))
    expect(JSON.stringify(db.structure)).toBe(JSON.stringify(da.structure))
    expect(JSON.stringify(db.structureUp)).toBe(JSON.stringify(da.structureUp))
    expect(JSON.stringify(db.structureDown)).toBe(JSON.stringify(da.structureDown))
  }
}

describe('yrmap payload round-trip', () => {
  it('round-trips an authored map with rooms', () => {
    const map = new EditorMap({ name: 'test map', seed: 42 })
    createRoom(map, { cy: 0, x0: 2, z0: 2, x1: 9, z1: 8, role: SPACE_ROLE_BREAK })
    createRoom(map, { cy: 1, x0: -6, z0: -3, x1: -1, z1: 3 }) // ordinary, negative coords, floor 1
    const restored = deserializeMap(serializeMap(map))
    expectSameMap(map, restored)
  })

  it('round-trips a baked procedural map byte-for-byte, including descriptors', () => {
    const map = new EditorMap({ name: 'baked' })
    map.bakeProcedural({ seedText: 'lobby', family: 'office', radius: 1, floors: [0] })
    expect(map.chunks.size).toBeGreaterThan(0)
    const restored = deserializeMap(serializeMap(map))
    expectSameMap(map, restored)
  })

  it('restores shared descriptor identity from the dedup table', () => {
    const map = new EditorMap({ name: 'towers' })
    map.bakeProcedural({ seedText: 'lobby', family: 'tower', radius: 2, floors: [0] })
    const restored = deserializeMap(serializeMap(map))
    expectSameMap(map, restored)
    // Chunks of one structure share a frozen descriptor in-memory; the dedup
    // table must restore that sharing (same object, not just equal JSON).
    const withStructure = [...restored.chunks.values()].filter((d) => d.structure)
    const groups = new Map()
    for (const d of withStructure) {
      const key = JSON.stringify(d.structure)
      if (groups.has(key)) expect(d.structure).toBe(groups.get(key))
      else groups.set(key, d.structure)
    }
  })

  it('skips pristine chunks', () => {
    const map = new EditorMap()
    map.ensureChunk(5, 0, 5) // untouched fabric
    map.mutate(() => map.setWallV(2, 0, 2, 1))
    const restored = deserializeMap(serializeMap(map))
    expect(restored.chunks.size).toBe(1)
    expect(restored.chunkAt(0, 0, 0)).toBeTruthy()
  })
})

describe('yrmap container', () => {
  it('encodes and decodes with compression', async () => {
    const map = new EditorMap({ name: 'container' })
    map.bakeProcedural({ seedText: 'lobby', family: 'office', radius: 1, floors: [0] })
    const file = await encodeMapFile(map)
    expect(String.fromCharCode(...file.subarray(0, 4))).toBe('YRM1')
    const restored = await decodeMapFile(file)
    expectSameMap(map, restored)
    // Compression should beat the raw payload on a real map.
    const raw = serializeMap(map)
    if (typeof CompressionStream !== 'undefined') {
      expect(file.length).toBeLessThan(raw.length)
    }
  })

  it('stays compact: a 9-chunk office floor fits in a few KB', async () => {
    const map = new EditorMap({ name: 'size' })
    map.bakeProcedural({ seedText: 'lobby', family: 'office', radius: 1, floors: [0] })
    const file = await encodeMapFile(map)
    // 9 chunks × 10 rasters × 196 cells ≈ 17 KB naive; format should crush it.
    expect(file.length).toBeLessThan(12 * 1024)
  })

  it('rejects bad magic, bad version and truncated payloads', async () => {
    await expect(decodeMapFile(new Uint8Array([1, 2, 3, 4, 5, 6, 7]))).rejects.toThrow(/magic/)
    const map = new EditorMap()
    map.mutate(() => map.setWallV(2, 0, 2, 1))
    const file = await encodeMapFile(map, { compress: false })
    const badVersion = file.slice()
    badVersion[4] = 99
    await expect(decodeMapFile(badVersion)).rejects.toThrow(/version/)
    await expect(decodeMapFile(file.subarray(0, file.length - 3))).rejects.toThrow()
  })

  it('decodes uncompressed containers', async () => {
    const map = new EditorMap({ name: 'raw' })
    createRoom(map, { cy: 0, x0: 0, z0: 0, x1: 4, z1: 4, role: SPACE_ROLE_BREAK })
    const file = await encodeMapFile(map, { compress: false })
    expectSameMap(map, await decodeMapFile(file))
  })
})

describe('format efficiency', () => {
  it('RLE keeps a single-room map tiny', () => {
    const map = new EditorMap()
    createRoom(map, { cy: 0, x0: 2, z0: 2, x1: 7, z1: 6, role: SPACE_ROLE_BREAK })
    const raw = serializeMap(map)
    // One chunk of hand-authored content should be well under a raw dump
    // (10 rasters × 196 bytes ≈ 2 KB before records).
    expect(raw.length).toBeLessThan(1024)
  })
})
