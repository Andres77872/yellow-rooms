import { describe, expect, it, vi } from 'vitest'
import { AudioBus, FAMILY_SPACES } from '../../audio/AudioBus.js'
import { FAMILY_PA, MusicPlayer } from '../../audio/music/MusicPlayer.js'
import { structureFamilyColor, STRUCTURE_FAMILY_COLORS } from '../../debug/mapInspect.js'
import { paintDecalAtlas } from '../../render/decalAtlas.js'
import { LEAF_FINISH } from '../../render/gbufferMaterials.js'
import { CELL_STAIR, MAP_FAMILY_HOTEL, MAP_FAMILY_OFFICE, SPACE_ROLE_BEDROOM, SPACE_ROLE_NONE } from '../mapTypes.js'
import { signIdFor, signPlates } from '../decalKinds.js'
import { doorSchedule } from '../doorSchedule.js'
import { FAMILY_PALETTES, MAP_PALETTES, familyPalette } from '../familyPalette.js'
import { forcedFamilyConfig } from '../families/forced.js'
import { LIMINAL_FAMILY_IDS } from '../families/ids.js'
import {
  LEGACY_FAMILIES,
  STYLE_TO_STEP,
  baseFamilyOf,
  byFamily,
  dressingOf,
  familyRecord,
  paletteIdOf,
} from '../families/registry.js'
import { generateChunk } from '../generate.js'
import { worldConfigForFamily } from '../mapFamily.js'
import { collectInteriorDressing } from '../objects/dressing/index.js'
import { DOOR_VOCAB, doorType, doorTypes } from '../objects/joinery/doorKit.js'
import { roomCatalogFor } from '../rooms/catalog.js'
import { resolveStepSurface } from '../stepSurface.js'
import { ZONE_SOFT, ZONE_WORK, roomCategory, worldSurfaceSet } from '../surfaceSet.js'

// The in-game identity of the liminal families (spec §5.1, §9.2-§9.4): their
// palette alias, the mono surface catalogue, footstep classes, the dressing
// layer and every table lookup that inherits from the base family.

const STEP_CLASSES = ['carpet', 'concrete', 'tile', 'deck']
const SLOTS = ['floor', 'wall', 'ceiling']
const getter = (cls, name) => Object.getOwnPropertyDescriptor(cls.prototype, name).get

// Recording 2D context (the snapshot script's): the atlas paint becomes a log.
function recordingCanvas(log) {
  const gradient = () => ({ addColorStop: (...args) => log.push(['stop', ...args]) })
  const target = {
    createLinearGradient: (...args) => { log.push(['lin', ...args]); return gradient() },
    createRadialGradient: (...args) => { log.push(['rad', ...args]); return gradient() },
    measureText: (text) => { log.push(['measure', text]); return { width: String(text).length * 7 } },
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
  }
  const ctx = new Proxy(target, {
    get(obj, key) {
      if (key in obj) return obj[key]
      if (typeof key !== 'string') return undefined
      return (...args) => log.push([key, ...args.map((a) => (a && typeof a === 'object' ? '[obj]' : a))])
    },
    set(obj, key, value) {
      log.push(['=', key, value && typeof value === 'object' ? '[obj]' : value])
      return true
    },
  })
  return { width: 0, height: 0, getContext: () => ctx }
}
function atlasLog(family) {
  const log = []
  vi.stubGlobal('document', { createElement: () => recordingCanvas(log) })
  try {
    paintDecalAtlas(family, 12345, 64)
  } finally {
    vi.unstubAllGlobals()
  }
  return JSON.stringify(log)
}

describe('liminal look', () => {
  it('each family resolves its own MAP_PALETTES palette, never office', () => {
    for (const id of LIMINAL_FAMILY_IDS) {
      expect(familyPalette(id), id).toBe(MAP_PALETTES[paletteIdOf(id)])
      expect(familyPalette(id), id).not.toBe(FAMILY_PALETTES[MAP_FAMILY_OFFICE])
    }
    // Unknown ids still fall back to office.
    expect(familyPalette('hospital')).toBe(FAMILY_PALETTES[MAP_FAMILY_OFFICE])
  })

  it('paints one mono surface set: every layer and package is the family palette', () => {
    for (const id of LIMINAL_FAMILY_IDS) {
      for (const seed of [0, 1, 12345]) {
        const set = worldSurfaceSet(id, seed)
        const pal = familyPalette(id)
        expect(set.family, id).toBe(id)
        for (const slot of SLOTS) {
          expect(set[slot], `${id} ${slot}`).toHaveLength(1)
          expect(set[slot][0].style).toBe(pal[slot].style)
        }
        for (const pkgs of Object.values(set.packages)) {
          expect(pkgs).toHaveLength(2)
          for (const pkg of pkgs) expect(pkg).toEqual({ floor: 0, wall: 0, ceiling: 0 })
        }
      }
    }
  })

  it('maps every floor (and stair) of every family onto one of the four footstep classes', () => {
    for (const id of LIMINAL_FAMILY_IDS) {
      expect(STEP_CLASSES, id).toContain(resolveStepSurface({ family: id }))
      expect(STEP_CLASSES, id).toContain(resolveStepSurface({ family: id, cellKind: CELL_STAIR }))
    }
    // The floor class comes from data, not the step function: the record's own
    // step override for its palette floor style, else the registry default.
    for (const id of LIMINAL_FAMILY_IDS) {
      const style = familyPalette(id).floor.style
      const override = familyRecord(id).step?.[style]
      const expected = override ?? STYLE_TO_STEP[style]
      expect(STEP_CLASSES, `${id} ${style}`).toContain(expected)
      expect(resolveStepSurface({ family: id }), `${id} ${style}`).toBe(expected)
      expect(resolveStepSurface({ family: id, cellKind: CELL_STAIR }), id)
        .toBe(expected === 'carpet' ? 'concrete' : expected)
    }
  })

  it('dresses a chunk with its record layer without throwing; "none" is bare', () => {
    const coords = [[0, 0, 0], [1, 0, -1], [-2, 0, 3], [0, 1, 0]]
    const report = {}
    for (const id of LIMINAL_FAMILY_IDS) {
      const config = forcedFamilyConfig(id)
      let props = 0
      for (const [cx, cy, cz] of coords) {
        // A real chunk of the forced family world, not a relabelled office one.
        const data = generateChunk(4242, cx, cy, cz, config)
        expect(data.mapFamily, `${id} ${cx},${cy},${cz}`).toBe(id)
        const d = collectInteriorDressing(data)
        for (const k of ['trim', 'props', 'signs', 'decals']) expect(Array.isArray(d[k]), `${id} ${k}`).toBe(true)
        if (dressingOf(id) === 'none') {
          expect(d, id).toEqual({ trim: [], props: [], signs: [], decals: [] })
        }
        props += d.props.length
      }
      report[id] = props
    }
    expect(Object.keys(report)).toEqual([...LIMINAL_FAMILY_IDS])
  })

  it('table lookups fall through the base family, then office (byFamily)', () => {
    for (const id of LIMINAL_FAMILY_IDS) {
      const base = baseFamilyOf(id)
      expect(byFamily(DOOR_VOCAB, id), id).toBe(DOOR_VOCAB[base] ?? DOOR_VOCAB[MAP_FAMILY_OFFICE])
      expect(doorTypes(id), id).toEqual(doorTypes(base))
      // The train words its own plates (CAR / STATION) and the terminal its
      // storey plate (GATE; decalKinds.js); every other family reads its
      // base's.
      const OWN_WORDS = { train: ['CAR', 'STATION'], terminal: ['ROOM', 'GATE'] }
      if (Object.hasOwn(OWN_WORDS, id)) {
        expect(signPlates(id).map((p) => p.id), id).toEqual(signPlates(base).map((p) => p.id))
        expect(signPlates(id).filter((p) => p.numbered).map((p) => p.text), id).toEqual(OWN_WORDS[id])
        expect(signPlates(id).filter((p) => !p.numbered), id).toEqual(signPlates(base).filter((p) => !p.numbered))
      }
      else expect(signPlates(id), id).toBe(signPlates(base))
      expect(byFamily(LEAF_FINISH, id, 'default'), id).toBe(LEAF_FINISH[base] ?? LEAF_FINISH.default)
      expect(roomCatalogFor(forcedFamilyConfig(id)), id).toBe(roomCatalogFor(worldConfigForFamily(base)))
      expect(structureFamilyColor(id), id).toBe(STRUCTURE_FAMILY_COLORS[base])
      expect(doorSchedule(9, id, 3).standard, id).toBeTruthy()
    }
  })

  it('hotel-based families get the hotel rules (guest rooms, plates, atlas)', () => {
    const hotelBased = LIMINAL_FAMILY_IDS.filter((id) => baseFamilyOf(id) === MAP_FAMILY_HOTEL)
    expect(hotelBased).toEqual(['babel', 'suburb', 'theater', 'house'])
    // The hotel atlas paints its own plate ground ('#2a1d14', decalAtlas.js).
    const HOTEL_PLATE = '"#2a1d14"'
    expect(atlasLog(MAP_FAMILY_HOTEL)).toContain(HOTEL_PLATE)
    expect(atlasLog(MAP_FAMILY_OFFICE)).not.toContain(HOTEL_PLATE)
    for (const id of LIMINAL_FAMILY_IDS) {
      const hotel = baseFamilyOf(id) === MAP_FAMILY_HOTEL
      expect(roomCategory(id, SPACE_ROLE_NONE), id).toBe(hotel ? ZONE_SOFT : ZONE_WORK)
      expect(signIdFor(SPACE_ROLE_BEDROOM, id), id).toBe(signIdFor(SPACE_ROLE_BEDROOM, baseFamilyOf(id)))
      expect(doorType(id, { fn: 'wet', role: 0 }), id).toBe(doorType(baseFamilyOf(id), { fn: 'wet', role: 0 }))
      expect(atlasLog(id).includes(HOTEL_PLATE), id).toBe(hotel)
    }
  })

  it('audio reads the record rows, then the base family rows', () => {
    const space = getter(AudioBus, '_space')
    const pa = getter(MusicPlayer, '_pa')
    for (const id of LIMINAL_FAMILY_IDS) {
      const { audio } = familyRecord(id)
      const base = baseFamilyOf(id)
      // The record's own row object when it has audio, else the base row.
      expect(space.call({ family: id }), id).toBe(audio ? audio.space : FAMILY_SPACES[base])
      expect(pa.call({ family: id }), id).toBe(audio ? audio.pa : FAMILY_PA[base])
      for (const key of ['decay', 'wet', 'tone', 'damp']) {
        expect(Number.isFinite(space.call({ family: id })[key]), `${id} space.${key}`).toBe(true)
      }
      expect(pa.call({ family: id }), id).toBeTruthy()
    }
    // Legacy families (no record audio) read their own rows; unknown → office.
    for (const family of LEGACY_FAMILIES) {
      expect(space.call({ family }), family).toBe(FAMILY_SPACES[family])
      expect(pa.call({ family }), family).toBe(FAMILY_PA[family])
    }
    expect(space.call({ family: 'hospital' })).toBe(FAMILY_SPACES[MAP_FAMILY_OFFICE])
    expect(pa.call({ family: 'hospital' })).toBe(FAMILY_PA[MAP_FAMILY_OFFICE])
  })
})
