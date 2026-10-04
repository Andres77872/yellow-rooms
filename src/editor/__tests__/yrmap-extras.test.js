import { describe, expect, it } from 'vitest'
import { EditorMap } from '../EditorMap.js'
import { decodeMapFile, deserializeMap, encodeMapFile, serializeMap } from '../format/yrmap.js'
import { CELL_CORRIDOR, FloorPlan, labelFloor } from '../kinds/floorPlan.js'
import { generatePrototype } from '../prototypes.js'

// The .yrmap extras section: meta.palette, chunk levelLabel /
// authoredFeatures and lamp tints. Absent from every document that does not
// use them, so those keep their bytes.

const same = (a, b) => Buffer.from(a).equals(Buffer.from(b))

// Two floors of a corridor with a window bay, a tinted and a plain lamp.
function kindDoc({ palette = null, label = null, window = false, tint = null } = {}) {
  const map = new EditorMap({ name: 'extras', family: 'tower', seed: 77, palette })
  const plan = new FloorPlan({ x0: 0, z0: 0, x1: 27, z1: 13 })
  plan.rect({ x0: 1, z0: 2, x1: 26, z1: 4 }, CELL_CORRIDOR)
  if (window) plan.window('h', 16, 2)
  plan.lamp(3, 3, true, tint)
  plan.lamp(20, 3, false)
  map.mutate(() => {
    plan.compile(map, 0)
    plan.compile(map, 1)
    if (label !== null) labelFloor(map, 1, label)
  })
  return map
}

// The document as a reader without the extras section sees it.
function stripExtras(map) {
  map.meta.palette = null
  for (const d of map.chunks.values()) {
    d.levelLabel = null
    d.authoredFeatures = false
    for (const l of d.lamps) delete l.tint
  }
  return map
}

const extrasOf = (map) => {
  const out = { palette: map.meta.palette, chunks: {} }
  for (const [key, d] of map.chunks) {
    out.chunks[key] = { label: d.levelLabel, features: d.authoredFeatures, tints: d.lamps.map((l) => l.tint ?? null) }
  }
  return out
}

describe('.yrmap extras section', () => {
  it('is absent when nothing uses it: such documents keep their bytes', () => {
    const plain = serializeMap(kindDoc())
    const map = deserializeMap(plain)
    expect(map.meta.palette).toBeNull()
    for (const d of map.chunks.values()) {
      expect(d.levelLabel).toBeNull()
      expect(d.authoredFeatures).toBe(false)
      for (const l of d.lamps) expect('tint' in l).toBe(false)
    }
    expect(same(serializeMap(map), plain)).toBe(true)
    // Each field alone adds a section after the same prefix.
    for (const opts of [{ palette: 'poolTile' }, { label: 'P2' }, { window: true }, { tint: 0xff8800 }]) {
      const map = kindDoc(opts)
      const bytes = serializeMap(map)
      const prefix = serializeMap(stripExtras(map))
      expect(bytes.length, JSON.stringify(opts)).toBeGreaterThan(prefix.length)
      expect(same(bytes.subarray(0, prefix.length), prefix), JSON.stringify(opts)).toBe(true)
    }
    expect(same(serializeMap(stripExtras(kindDoc({ palette: 'poolTile', label: 'P2', tint: 1 }))), plain)).toBe(true)
  })

  it('round-trips the palette, labels, authored features and lamp tints', () => {
    for (const opts of [
      { palette: 'poolTile' },
      { label: 'P2' },
      { label: '' },
      { window: true },
      { tint: 0xff8800 },
      { tint: 0 },
      { palette: 'babelLibrary', label: 'b-1', window: true, tint: 0x80c0ff },
    ]) {
      const map = kindDoc(opts)
      const bytes = serializeMap(map)
      const back = deserializeMap(bytes)
      expect(extrasOf(back), JSON.stringify(opts)).toEqual(extrasOf(map))
      expect(same(serializeMap(back), bytes), JSON.stringify(opts)).toBe(true)
    }
    const all = deserializeMap(serializeMap(kindDoc({ palette: 'nightLot', label: 'P1', window: true, tint: 0x123456 })))
    expect(all.meta.palette).toBe('nightLot')
    expect(all.chunkAt(1, 1, 0).levelLabel).toBe('P1')
    expect(all.chunkAt(1, 0, 0).authoredFeatures).toBe(true)
    expect(all.chunkAt(0, 0, 0).authoredFeatures).toBe(false)
    expect(all.lampAt(3, 0, 3).rec).toEqual({ lx: 3, lz: 3, lit: true, tint: 0x123456 })
    expect(all.lampAt(20, 0, 3).rec).toEqual({ lx: 6, lz: 3, lit: false })
  })

  it('a file that ends before the section loads with the defaults', () => {
    const map = kindDoc({ palette: 'nightLot', label: 'P1', window: true, tint: 0x123456 })
    const full = serializeMap(map)
    const plain = serializeMap(stripExtras(map))
    const cut = deserializeMap(full.subarray(0, plain.length))
    expect(cut.meta.palette).toBeNull()
    for (const d of cut.chunks.values()) {
      expect(d.levelLabel).toBeNull()
      expect(d.authoredFeatures).toBe(false)
      for (const l of d.lamps) expect(l.tint).toBeUndefined()
    }
    // Truncated inside the section: a damaged file, not a shorter one.
    expect(() => deserializeMap(full.subarray(0, full.length - 2))).toThrow()
  })

  it('follows undo and redo snapshots', () => {
    const map = kindDoc()
    const before = serializeMap(map)
    map.mutate(() => {
      labelFloor(map, 0, 'L')
      map.setLamp(3, 0, 3, true, 0x00ff00)
      map.meta.palette = 'metroTile'
    })
    const after = serializeMap(map)
    expect(after.length).toBeGreaterThan(before.length)
    map.undo()
    expect(same(serializeMap(map), before)).toBe(true)
    map.redo()
    expect(same(serializeMap(map), after)).toBe(true)
    const back = deserializeMap(after)
    expect(back.meta.palette).toBe('metroTile')
    expect(back.chunkAt(0, 0, 0).levelLabel).toBe('L')
    expect(back.lampAt(3, 0, 3).rec.tint).toBe(0x00ff00)
  })

  it('keeps a labelled chunk that is otherwise pristine', () => {
    const map = new EditorMap()
    map.mutate(() => {
      map.ensureChunk(2, 0, 2)
      labelFloor(map, 0, 'H')
    })
    const back = deserializeMap(serializeMap(map))
    expect(back.chunkAt(2, 0, 2)?.levelLabel).toBe('H')
  })

  it('survives the compressed container', async () => {
    const map = kindDoc({ palette: 'showroomWhite', label: '9', window: true, tint: 0xfff0e0 })
    const back = await decodeMapFile(await encodeMapFile(map))
    expect(extrasOf(back)).toEqual(extrasOf(map))
  })

  it('existing prototype kinds still write no extras', () => {
    const map = new EditorMap()
    generatePrototype(map, 'mall', { seed: 'proto' })
    const bytes = serializeMap(map)
    const back = deserializeMap(bytes)
    expect(back.meta.palette).toBeNull()
    expect([...back.chunks.values()].some((d) => d.authoredFeatures || d.levelLabel !== null)).toBe(false)
  })
})
