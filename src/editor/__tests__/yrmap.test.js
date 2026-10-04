import { describe, expect, it } from 'vitest'
import { CHUNK, DOOR_LEAF_FRACTION } from '../../world/constants.js'
import { collectDoorways } from '../../world/doors.js'
import { SPACE_ROLE_BREAK } from '../../world/mapTypes.js'
import { roomContext } from '../../world/surfaceSet.js'
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
    // The finish context the room finishes and door schedule key off.
    expect(db.spaceClass, `${key}.spaceClass`).toEqual(da.spaceClass)
    expect(db.district).toEqual(da.district)
    expect(db.worldSeed).toBe(da.worldSeed)
    expect(db.mapFamily).toBe(da.mapFamily)
  }
}

// Everything the finishes and the door dressing resolve for a document.
function dressing(map) {
  const out = {}
  for (const [key, d] of map.chunks) {
    const cells = []
    for (let lz = 0; lz < CHUNK; lz++) for (let lx = 0; lx < CHUNK; lx++) cells.push(roomContext(d, lx, lz))
    out[key] = { cells, doors: collectDoorways(d, DOOR_LEAF_FRACTION) }
  }
  return out
}

// A two-chunk office document written by the serializer before the finish
// section existed: a bake of chunk 0,0,0 from seed 4242 and a room drawn on
// storey 1 (gzip container).
const OLD_OFFICE_FILE = [
  'WVJNMQEBH4sIAAAAAAAAA51UTWhcVRT+vnPuve9nJokJjwhB2vJWWWQ3/uBAOvNcuXWniAs1HRkIKVRNa0JBxChCuxGppLgV',
  'XIgb3Wmh2HGjM1ioRrqSuAhduChiuqog976XmTdqiro475z7ne+ec+99937p2fW1U2d7vf7LZ1zp3n8IeEQao51PP5gDEDkH',
  '4q1rh3vEAlQA4u73f3yjWALiCMSHd94bEQtOrc/tvXvr2xRxqhqDuH7lzg9zwKylr7J787dbc0AWKUH8cumTK024zNDPO/h6',
  '9zDBQmZC7vLn199ULGWAz1GMMb61xE2+tJ2v9c/l7dZKvv7ixlp/45W8vZ2vX8jbT6zk61t5u3VxJT/3+kbefr6EHx/D5fix',
  'o/ELK/mZC/3XjqY/eoRfFN92QDKCUCFjLyATCA1IDVZitoq1ws04Lrk+z6rGJCZnwTDf1OpLlffzoik/YEzCch6WDWhgEaSD',
  'MgmzlBkcF0PsKvOxGXOjagUK5aLfIyIKlDL2EnpQqljK1VBZz4ZYg/e/ZzIKXkoOq4qT2HNnqrWYWj+pGKZaz8QPGINiMU+L',
  'Rjgzga/vqEjK3sjosBhiF07D5ylmzKW6ahVKxSIHHBDV5wSoGagPw++QKqBaiCqoDVBTiC7VcqEa6C+3nij/iM6QEtNpTFE1',
  'VB97rG7W8yT+Gzpg7CwYlV916V++xpnY1rxzMuVnoXThvDTcIGKmslA7vGL+fGNvaEx4wwxv9zhcA+4ejIf3/mDcBNwELeB/',
  'zLqgGfK/srMB0aAzNuhLxQnqwqAqZVZDVkJccmzgxP8CmQfYBK3QKGMlDNQwMmwaxhFNzGZMSegSpgnjBptNzmtqgfsF8HYx',
  'Gja7o+GlDhqJnty5XQDLxWg4XO31DjqijQaQPuWtxktL3v0Jj9b6WqvpG8XV3dudq7vPdfy12N/6sgA+KvzY4xpF9un9r0Jf',
  'AB1vSpMCzxYnd36fzDVRup1dCz16vYPTrdarHTUi95bTArjbrWHOj7ezjws/9jiNunvL7dB3zFNpeN70PiS9cdic2ocaG21n',
  'lwvgi3rfuOzxY71H7M9pCoMXNwaBQvmWg1rGx/jNwLFsVZrT9+NKHeNj/CY9x6IVtETQn1KPU5VKzEL1HVblk5qdLzFJanb+',
  'H3n+Llkn2mp91/UbXU1/Ou1NEiP+Z+1v3eyOhsMO0O1AjfGYt/HhijW/PrN5hHW8qajJPntyCpOjMyP+BA41uKn8BwAA',
].join('')

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

  it('keeps every room finish and doorway of a baked document', async () => {
    const map = new EditorMap({ name: 'finishes' })
    map.bakeChunks({ seed: 4242, family: 'hotel', coords: [0, 1, 2].flatMap((cz) => [0, 1, 2].map((cx) => ({ cx, cy: 0, cz }))) })
    // A second bake in another family and world: those chunks keep theirs.
    map.bakeChunks({ seed: 77, family: 'tower', coords: [{ cx: 3, cy: 1, cz: 0 }, { cx: 4, cy: 1, cz: 0 }] })
    expect(map.meta.family).toBe('tower')
    expect(map.chunkAt(0, 0, 0).district).toBeTruthy()
    const restored = await decodeMapFile(await encodeMapFile(map))
    expectSameMap(map, restored)
    expect(restored.chunkAt(1, 0, 1).mapFamily).toBe('hotel')
    expect(restored.chunkAt(1, 0, 1).worldSeed).toBe(4242)
    expect(restored.chunkAt(3, 1, 0).worldSeed).toBe(77)
    expect(dressing(restored)).toEqual(dressing(map))
  })

  it('loads a file written before the finish section', async () => {
    const map = await decodeMapFile(Uint8Array.from(atob(OLD_OFFICE_FILE), (c) => c.charCodeAt(0)))
    expect(map.meta).toMatchObject({ name: 'old office', family: 'office', seed: 4242 })
    expect(map.chunks.size).toBe(2)
    expect(map.rooms.length).toBeGreaterThan(1)
    const baked = map.chunkAt(0, 0, 0)
    expect(baked.spaceId.some(Boolean)).toBe(true)
    for (const d of map.chunks.values()) {
      // The bake's world, from the document seed; no district to key by.
      expect(d.worldSeed).toBe(4242)
      expect(d.district).toBeNull()
      expect(d.spaceClass.every((c) => c === 0)).toBe(true)
    }
    expect(() => dressing(map)).not.toThrow()
    // Saved again, it carries the finish section and round-trips exactly.
    const again = deserializeMap(serializeMap(map))
    expectSameMap(map, again)
    expect(dressing(again)).toEqual(dressing(map))
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
