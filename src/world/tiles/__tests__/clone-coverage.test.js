import { describe, expect, it } from 'vitest'
import { ZONE_OFFICE } from '../../constants.js'
import { ChunkData } from '../../ChunkData.js'
import { generateChunk } from '../../generate.js'
import { worldConfigForFamilyOrOffice } from '../../mapFamily.js'
import {
  CHUNK_DESCRIPTORS as EDITOR_DESCRIPTORS,
  EditorMap,
  cloneChunkData as editorClone,
} from '../../../editor/EditorMap.js'
import { PROTOTYPE_KINDS, generatePrototype } from '../../../editor/prototypes.js'
import { CHUNK_DESCRIPTORS, SPACE_ID_RECORD_FIELDS, cloneChunkData } from '../cloneChunk.js'

// tiles/cloneChunk.js is a copy of the editor's chunk clone (the world may not
// import src/editor). These tests pin it to every ChunkData field, so a new
// field fails here until both clones carry it, and pin the record fields that
// hold a spaceId (the tile bake's id remap, spec §6.6).

// Every enumerable ChunkData field and what a clone does with it.
const FIELDS = Object.freeze({
  version: 'copy', cx: 'copy', cy: 'copy', cz: 'copy', mapFamily: 'copy', zone: 'copy',
  wallV: 'copy', wallH: 'copy', passageV: 'copy', passageH: 'copy', wallFeatureV: 'copy', wallFeatureH: 'copy',
  cols: 'copy', cellKind: 'copy', spaceId: 'copy', spaceRole: 'copy', spaceClass: 'copy',
  district: 'copy', worldSeed: 'copy', levelLabel: 'copy', authoredFeatures: 'copy', repairs: 'copy',
  lamps: 'copy', furniture: 'copy', exit: 'copy',
  stairUp: 'share', stairDown: 'share', sewerDescriptor: 'share', structure: 'share',
  structureUp: 'share', structureDown: 'share', lethalVoidUp: 'share', lethalVoidDown: 'share',
  _protV: 'fresh', _protH: 'fresh', // the stair stamp's per-build edge protection
})

// A chunk with every field moved off its default.
function sentinelChunk() {
  const d = new ChunkData(3, -2, 5, ZONE_OFFICE + 1, 27, 'hotel')
  let n = 1
  for (const [k, v] of Object.entries(d)) {
    if (ArrayBuffer.isView(v)) v.fill(k === 'spaceId' ? 0x80000003 : 3)
  }
  d.district = { dx: 2, dz: -1 }
  d.worldSeed = 0xdeadbeef
  d.levelLabel = 'b2'
  d.authoredFeatures = true
  d.repairs = { connectivity: 1, navigation: 2, columns: 3 }
  d.lamps = [{ lx: 1, lz: 2, lit: true, tint: 0xff0000 }]
  d.furniture = [{ kind: 4, lx: 3, lz: 4, x: 1.5, z: 2.5, w: 1, d: 1, facing: 2 }]
  d.exit = { lx: 6, lz: 7 }
  for (const f of CHUNK_DESCRIPTORS) d[f] = Object.freeze({ id: n++, field: f })
  d._protV.add(5)
  d._protH.add(6)
  return d
}

const plain = (v) => (ArrayBuffer.isView(v) ? Array.from(v) : JSON.parse(JSON.stringify(v ?? null)))

describe('clone coverage', () => {
  it('pins every enumerable ChunkData field', () => {
    expect(Object.keys(new ChunkData(0, 0, 0, ZONE_OFFICE)).sort()).toEqual(Object.keys(FIELDS).sort())
    expect(CHUNK_DESCRIPTORS).toEqual(Object.keys(FIELDS).filter((k) => FIELDS[k] === 'share'))
    expect(CHUNK_DESCRIPTORS).toEqual(EDITOR_DESCRIPTORS)
  })

  it('copies, shares or resets every field as pinned', () => {
    const d = sentinelChunk()
    const c = cloneChunkData(d)
    for (const [k, rule] of Object.entries(FIELDS)) {
      if (rule === 'fresh') {
        expect(c[k].size, k).toBe(0)
        continue
      }
      if (rule === 'share') {
        expect(c[k], k).toBe(d[k])
        continue
      }
      expect(plain(c[k]), k).toEqual(plain(d[k]))
      if (d[k] !== null && typeof d[k] === 'object') expect(c[k], `${k} is a copy`).not.toBe(d[k])
    }
    for (let i = 0; i < d.lamps.length; i++) expect(c.lamps[i]).not.toBe(d.lamps[i])
    for (let i = 0; i < d.furniture.length; i++) expect(c.furniture[i]).not.toBe(d.furniture[i])
  })

  it('matches the editor clone field for field', () => {
    const chunks = [sentinelChunk()]
    for (const fam of ['office', 'hotel', 'tower']) {
      const { config } = worldConfigForFamilyOrOffice(fam)
      chunks.push(generateChunk(11, 1, 0, -1, config), generateChunk(11, 0, 1, 0, config))
    }
    for (const d of chunks) {
      const a = cloneChunkData(d)
      const b = editorClone(d)
      for (const k of Object.keys(FIELDS)) {
        if (FIELDS[k] === 'fresh') continue
        if (FIELDS[k] === 'share') expect(a[k]).toBe(b[k])
        else expect(plain(a[k]), k).toEqual(plain(b[k]))
      }
    }
  })

  it('pins the record fields that hold a spaceId', () => {
    expect(SPACE_ID_RECORD_FIELDS).toEqual({ furniture: [], lamps: [], rooms: ['id'] })
    // Every record key the kinds and the legacy generators write, so a new
    // field (possibly a space id) fails here until it is classified.
    const FURNITURE_KEYS = ['kind', 'lx', 'lz', 'x', 'z', 'w', 'd', 'facing']
    const LAMP_KEYS = ['lx', 'lz', 'lit', 'tint']
    const ROOM_KEYS = ['id', 'cy', 'x0', 'z0', 'x1', 'z1', 'role', 'salt', 'door', 'baked']
    const furniture = new Set()
    const lamps = new Set()
    const rooms = new Set()
    const collect = (d) => {
      for (const f of d.furniture) for (const k of Object.keys(f)) furniture.add(k)
      for (const l of d.lamps) for (const k of Object.keys(l)) lamps.add(k)
    }
    for (const kind of PROTOTYPE_KINDS) {
      const map = new EditorMap()
      generatePrototype(map, kind.id, { seed: 'proto' })
      for (const d of map.chunks.values()) collect(d)
      for (const r of map.rooms) for (const k of Object.keys(r)) rooms.add(k)
    }
    for (const fam of ['office', 'hotel', 'tower', 'sewer', 'lattice']) {
      const { config } = worldConfigForFamilyOrOffice(fam)
      for (const [cx, cz] of [[0, 0], [1, -1], [-1, 1]]) collect(generateChunk(5, cx, 0, cz, config))
    }
    for (const k of furniture) expect(FURNITURE_KEYS, `furniture.${k}`).toContain(k)
    for (const k of lamps) expect(LAMP_KEYS, `lamps.${k}`).toContain(k)
    for (const k of rooms) expect(ROOM_KEYS, `rooms.${k}`).toContain(k)
  }, 60_000)
})
