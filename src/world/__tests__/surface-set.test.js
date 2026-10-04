import { describe, it, expect } from 'vitest'
import {
  SURFACE_LAYER_COUNT,
  SURFACE_SLOTS,
  SPACE_CIRC,
  SPACE_HALL,
  SPACE_ROOM,
  ZONE_CIRC,
  ZONE_EDGE_E,
  ZONE_EDGE_W,
  ZONE_HALL,
  ZONE_LAYER_MASK,
  ZONE_MAP_SIZE,
  ZONE_SERVICE,
  ZONE_SOFT,
  ZONE_WET,
  ZONE_WORK,
  buildSurfaceZoneMap,
  recipeLuma,
  roomCategory,
  spaceAt,
  worldSurfaceSet,
  zoneCategory,
} from '../surfaceSet.js'
import { familyPalette } from '../familyPalette.js'
import { MAP_FAMILY_ORDER } from '../mapFamily.js'
import { familiesWith } from '../families/registry.js'
import { ChunkData } from '../ChunkData.js'
import { CHUNK, cIdx } from '../constants.js'
import {
  CELL_ATRIUM,
  CELL_CORRIDOR,
  CELL_LOBBY,
  CELL_ROOM,
  CELL_STAIR,
  MAP_FAMILY_HOTEL,
  MAP_FAMILY_OFFICE,
  SPACE_CLASS_CIRCULATION,
  SPACE_CLASS_ROOM,
  SPACE_ROLE_BATHROOM,
  SPACE_ROLE_NONE,
  SPACE_ROLE_SERVER,
} from '../mapTypes.js'

const SEEDS = Array.from({ length: 40 }, (_, i) => i * 7919 + 3)
const styles = (set, pkg) => SURFACE_SLOTS.map((slot) => set[slot][pkg[slot]].style)

describe('world surface sets', () => {
  // Per-world variety and the room-category taste rules hold for the building
  // families. The liminal families paint one mono catalogue (layer 0 = the
  // family palette, spec §5.1), so they are checked by the registry-wide
  // layer-0 and package tests below, which iterate MAP_FAMILY_ORDER.
  it('are pure in (family, world seed) and differ between worlds', () => {
    for (const family of MAP_FAMILY_ORDER) {
      const a = worldSurfaceSet(family, 1234)
      expect(worldSurfaceSet(family, 1234), family).toBe(a)
    }
    for (const family of familiesWith('buildingMatrices')) {
      const a = worldSurfaceSet(family, 1234)
      expect(worldSurfaceSet(family, 1234)).toBe(a)
      const fingerprint = (set) => JSON.stringify(SURFACE_SLOTS.map((slot) => set[slot].map((l) => [l.style, l.base])))
      const others = [1, 2, 3, 4, 5].map((seed) => fingerprint(worldSurfaceSet(family, seed)))
      expect(new Set([fingerprint(a), ...others]).size, family).toBeGreaterThan(1)
    }
  })

  it('keep the family palette surface as layer 0 and stay inside the layer budget', () => {
    for (const family of MAP_FAMILY_ORDER) {
      for (const seed of SEEDS.slice(0, 8)) {
        const set = worldSurfaceSet(family, seed)
        const pal = familyPalette(family)
        for (const slot of SURFACE_SLOTS) {
          expect(set[slot].length).toBeGreaterThanOrEqual(1)
          expect(set[slot].length).toBeLessThanOrEqual(SURFACE_LAYER_COUNT[slot])
          expect(set[slot][0].style).toBe(pal[slot].style)
          expect(set[slot][0].base).toBe(pal[slot].base)
          set[slot].forEach((layer, i) => expect(layer.layer).toBe(i))
        }
      }
    }
  })

  it('give every category two coordinated packages that point at real layers', () => {
    for (const family of MAP_FAMILY_ORDER) {
      for (const seed of SEEDS) {
        const set = worldSurfaceSet(family, seed)
        for (const category of [ZONE_CIRC, ZONE_WORK, ZONE_WET, ZONE_SERVICE, ZONE_SOFT, ZONE_HALL]) {
          const pkgs = set.packages[category]
          expect(pkgs, `${family} ${seed} ${category}`).toHaveLength(2)
          for (const pkg of pkgs) for (const slot of SURFACE_SLOTS) expect(pkg[slot]).toBeLessThan(set[slot].length)
          // A sibling is a variation of its primary: the ceiling stays.
          expect(pkgs[1].ceiling).toBe(pkgs[0].ceiling)
        }
      }
    }
  })

  it('never carpet or paper a bathroom, and keep plant rooms hard-wearing', () => {
    const SOFT_FLOORS = ['carpet', 'carpetPattern', 'carpetTile', 'parquet', 'planks']
    const SOFT_WALLS = ['wallpaper', 'stripe', 'damask', 'woodPanel', 'wainscot']
    for (const family of familiesWith('buildingMatrices')) {
      for (const seed of SEEDS) {
        const set = worldSurfaceSet(family, seed)
        for (const pkg of set.packages[ZONE_WET]) {
          const [floor, wall, ceiling] = styles(set, pkg)
          expect(SOFT_FLOORS, `${family} ${seed} wet floor`).not.toContain(floor)
          expect(SOFT_WALLS, `${family} ${seed} wet wall`).not.toContain(wall)
          expect(['slats', 'acoustic'], `${family} ${seed} wet ceiling`).not.toContain(ceiling)
        }
        for (const pkg of set.packages[ZONE_SERVICE]) {
          const [floor, wall] = styles(set, pkg)
          expect(['carpet', 'carpetPattern', 'parquet', 'planks', 'mosaic', 'checker']).not.toContain(floor)
          expect(['wallpaper', 'stripe', 'damask', 'woodPanel', 'wainscot']).not.toContain(wall)
        }
        for (const pkg of set.packages[ZONE_CIRC]) {
          expect(['checker', 'mosaic']).not.toContain(styles(set, pkg)[0])
        }
      }
    }
  })

  it('keep light-coloured families in the ceiling > wall > floor reflectance order', () => {
    let ordered = 0
    let total = 0
    for (const family of [MAP_FAMILY_OFFICE, MAP_FAMILY_HOTEL, 'tower']) {
      for (const seed of SEEDS) {
        const set = worldSurfaceSet(family, seed)
        for (const pkgs of Object.values(set.packages)) {
          for (const pkg of pkgs) {
            const [f, w] = SURFACE_SLOTS.map((slot) => recipeLuma(set[slot][pkg[slot]]))
            total++
            if (w >= f - 0.02) ordered++
          }
        }
      }
    }
    expect(ordered / total).toBeGreaterThan(0.9)
  })

  it('classify rooms by role, with a family default for unnamed rooms', () => {
    expect(roomCategory(MAP_FAMILY_OFFICE, SPACE_ROLE_NONE)).toBe(ZONE_WORK)
    expect(roomCategory(MAP_FAMILY_HOTEL, SPACE_ROLE_NONE)).toBe(ZONE_SOFT)
    expect(roomCategory(MAP_FAMILY_OFFICE, SPACE_ROLE_BATHROOM)).toBe(ZONE_WET)
    expect(roomCategory(MAP_FAMILY_HOTEL, SPACE_ROLE_SERVER)).toBe(ZONE_SERVICE)
    expect(zoneCategory(CELL_CORRIDOR, 0)).toBe(ZONE_CIRC)
    expect(zoneCategory(CELL_LOBBY, 0)).toBe(ZONE_CIRC)
    expect(zoneCategory(CELL_STAIR, 0)).toBe(ZONE_CIRC)
    expect(zoneCategory(CELL_ATRIUM, 0)).toBe(ZONE_HALL)
  })
})

describe('space resolution', () => {
  const chunk = () => new ChunkData(2, 1, 5, 0)

  it('treats every cell of a circulation network as one corridor, lobby nodes and stairs included', () => {
    const d = chunk()
    const cells = [[0, 0, CELL_CORRIDOR], [1, 0, CELL_LOBBY], [2, 0, CELL_STAIR]]
    for (const [lx, lz, kind] of cells) {
      const i = cIdx(lx, lz)
      d.cellKind[i] = kind
      d.spaceId[i] = 77
      d.spaceClass[i] = SPACE_CLASS_CIRCULATION
    }
    const resolved = cells.map(([lx, lz]) => spaceAt(d, lx, lz))
    for (const s of resolved) expect(s).toEqual(resolved[0])
    expect(resolved[0].cls).toBe(SPACE_CIRC)
  })

  it('keeps a room a room when a later stamp relabels its edge cells as lobby', () => {
    const d = chunk()
    for (const [lx, kind] of [[0, CELL_ROOM], [1, CELL_LOBBY]]) {
      const i = cIdx(lx, 3)
      d.cellKind[i] = kind
      d.spaceId[i] = 91
      d.spaceClass[i] = SPACE_CLASS_ROOM
    }
    expect(spaceAt(d, 1, 3)).toEqual(spaceAt(d, 0, 3))
    expect(spaceAt(d, 1, 3).cls).toBe(SPACE_ROOM)
  })

  it('gives unplanned fabric one finish per storey instead of 4 x 4 blocks', () => {
    const d = chunk()
    const keys = new Set()
    for (let lz = 0; lz < CHUNK; lz++) for (let lx = 0; lx < CHUNK; lx++) keys.add(spaceAt(d, lx, lz).key)
    expect(keys.size).toBe(1)
    const other = new ChunkData(40, 1, -9, 0)
    expect(spaceAt(other, 3, 3).key).toBe(spaceAt(d, 0, 0).key)
  })

  it('keys a tall structure without its storey', () => {
    const a = chunk()
    const b = new ChunkData(2, 4, 5, 0)
    for (const d of [a, b]) {
      d.cellKind[cIdx(4, 4)] = CELL_ATRIUM
      d.spaceId[cIdx(4, 4)] = 555
    }
    expect(spaceAt(a, 4, 4)).toEqual(spaceAt(b, 4, 4))
    expect(spaceAt(a, 4, 4).cls).toBe(SPACE_HALL)
  })
})

describe('chunk zone maps', () => {
  const room = () => {
    const d = new ChunkData(3, 0, -2, 0)
    for (let lz = 0; lz < CHUNK; lz++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        const i = cIdx(lx, lz)
        d.cellKind[i] = CELL_ROOM
        d.spaceId[i] = lx < 7 ? 11 : 12
        d.spaceClass[i] = SPACE_CLASS_ROOM
        d.spaceRole[i] = lx < 7 ? SPACE_ROLE_NONE : SPACE_ROLE_BATHROOM
      }
    }
    d.lamps.push({ lx: 2, lz: 2, lit: true })
    return d
  }
  const texelOf = (map) => (lx, lz) => [...map.subarray(((lz + 1) * ZONE_MAP_SIZE + lx + 1) * 4, ((lz + 1) * ZONE_MAP_SIZE + lx + 2) * 4)]

  it('writes one texel per cell plus a halo, cells of a room agreeing', () => {
    const d = room()
    const set = worldSurfaceSet('office', 5)
    const map = buildSurfaceZoneMap(d, set)
    expect(map).toHaveLength(ZONE_MAP_SIZE * ZONE_MAP_SIZE * 4)
    const texel = texelOf(map)
    const finish = (lx, lz) => [texel(lx, lz)[0] & ZONE_LAYER_MASK, texel(lx, lz)[1], texel(lx, lz)[2]]
    expect(finish(0, 0)).toEqual(finish(6, 13))
    expect(finish(7, 0)).toEqual(finish(13, 9))
    // The lamp cell carries the fixture bit; its neighbour does not.
    expect(texel(2, 2)[3] & 128).toBe(128)
    expect(texel(3, 2)[3] & 128).toBe(0)
    // Without a neighbour the halo repeats the nearest own cell.
    expect(texel(-1, 4)).toEqual(texel(0, 4))
    expect(texel(CHUNK, 4).slice(1)).toEqual(texel(CHUNK - 1, 4).slice(1))
  })

  it('flags a floor change on both sides of the edge, and nowhere else', () => {
    const d = room()
    const set = worldSurfaceSet('office', 5)
    const texel = texelOf(buildSurfaceZoneMap(d, set))
    const floorOf = (lx) => texel(lx, 4)[0] & ZONE_LAYER_MASK
    expect(floorOf(6)).not.toBe(floorOf(7)) // an office next to a bathroom
    expect(texel(6, 4)[0] & ZONE_EDGE_E).toBe(ZONE_EDGE_E)
    expect(texel(7, 4)[0] & ZONE_EDGE_W).toBe(ZONE_EDGE_W)
    expect(texel(3, 4)[0] & ~ZONE_LAYER_MASK).toBe(0)
    expect(texel(10, 4)[0] & ~ZONE_LAYER_MASK).toBe(0)
  })

  it('reads the halo from the neighbouring chunk once it streams in', () => {
    const d = room()
    const east = new ChunkData(4, 0, -2, 0)
    for (let i = 0; i < CHUNK * CHUNK; i++) {
      east.cellKind[i] = CELL_CORRIDOR
      east.spaceId[i] = 99
      east.spaceClass[i] = SPACE_CLASS_CIRCULATION
    }
    const set = worldSurfaceSet('office', 5)
    const alone = buildSurfaceZoneMap(d, set)
    const joined = buildSurfaceZoneMap(d, set, (dx, dz) => (dx === 1 && dz === 0 ? east : null))
    const at = (map, tx, tz) => [...map.subarray((tz * ZONE_MAP_SIZE + tx) * 4, (tz * ZONE_MAP_SIZE + tx + 1) * 4)]
    const eastOwn = buildSurfaceZoneMap(east, set)
    const plain = (t) => [t[0] & ZONE_LAYER_MASK, ...t.slice(1)]
    expect(plain(at(joined, ZONE_MAP_SIZE - 1, 5))).toEqual(plain(at(eastOwn, 1, 5)))
    // Interior texels away from the border never depend on the neighbour.
    expect(at(joined, 5, 5)).toEqual(at(alone, 5, 5))
  })
})
