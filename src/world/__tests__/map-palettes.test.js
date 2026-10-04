import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SURFACE_GLOSS } from '../../render/gbufferMaterials.js'
import { SURFACE_STYLES } from '../../render/surfaces.js'
import { paintSurfaceCanvas } from '../../render/textures.js'
import { CEILING_STYLES, FLOOR_STYLES, WALL_STYLES } from '../../render/textureStyles.js'
import { FAMILY_PALETTES, MAP_PALETTE_IDS, MAP_PALETTES, familyPalette } from '../familyPalette.js'
import { MAP_FAMILY_OFFICE } from '../mapTypes.js'

// Look palettes of the authored liminal maps (familyPalette.js MAP_PALETTES):
// family-palette shape, painted only by the painters that already exist.

const KIND_PALETTES = [
  'stairwellConcrete', 'nightLot', 'showroomWhite', 'poolTile', 'babelLibrary', 'suburbNight',
  'terminalTerrazzo', 'theaterDamask', 'playCarpet', 'metroTile', 'houseFaded', 'funhouseNeon',
]

// Styles each slot's dispatcher paints (textures.js paintFloor / paintWall /
// paintCeiling): its canonical styles, then the variant tables. Anything else
// silently falls back to the slot default, so it must never be named.
const SLOT_STYLES = {
  floor: new Set(['carpet', 'concrete', 'tile', 'deck', ...Object.keys(FLOOR_STYLES)]),
  wall: new Set(['wallpaper', 'brick', 'panel', 'steel', ...Object.keys(WALL_STYLES)]),
  ceiling: new Set(['tile', 'vault', 'deck', ...Object.keys(CEILING_STYLES)]),
}
const SLOTS = Object.keys(SLOT_STYLES)
const COLOR_KEYS = ['trim', 'leaf', 'panel', 'panelDead', 'fog', 'ambientSky', 'ambientGround', 'rim']

const HEX = /^#[0-9a-f]{6}$/i
const RGBA = /^rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(0|1|0?\.\d+)\s*\)$/
const isColor = (v) => typeof v === 'string' && (HEX.test(v) || RGBA.test(v))

// A recording 2D context: every paint is a real colour (or a gradient whose
// stops are), every coordinate finite. A painter reading a field the spec
// lacks paints `undefined` or NaN and fails here, where a browser would
// silently keep the previous colour.
function fakeCanvas(errors) {
  const check = (what, ok) => {
    if (!ok) errors.push(what)
  }
  const gradient = () => ({
    addColorStop(offset, color) {
      check(`stop ${offset}`, Number.isFinite(offset) && isColor(color))
    },
  })
  const state = { globalAlpha: 1, lineWidth: 1, fillStyle: '#000000', strokeStyle: '#000000' }
  const ctx = new Proxy(state, {
    get(target, key) {
      if (key in target) return target[key]
      if (key === 'createLinearGradient' || key === 'createRadialGradient') {
        return (...args) => {
          check(`${key} args`, args.every(Number.isFinite))
          return gradient()
        }
      }
      return (...args) => {
        check(`${String(key)} args ${args}`, args.every((a) => typeof a !== 'number' || Number.isFinite(a)))
      }
    },
    set(target, key, value) {
      if (key === 'fillStyle' || key === 'strokeStyle') {
        check(`${key} = ${value}`, isColor(value) || (value && typeof value.addColorStop === 'function'))
      } else if (key === 'globalAlpha' || key === 'lineWidth') {
        check(`${key} = ${value}`, Number.isFinite(value))
      }
      target[key] = value
      return true
    },
  })
  return { width: 0, height: 0, getContext: () => ctx }
}

let previousDocument
const paintErrors = []
beforeAll(() => {
  previousDocument = globalThis.document
  globalThis.document = { createElement: () => fakeCanvas(paintErrors) }
})
afterAll(() => {
  if (previousDocument === undefined) delete globalThis.document
  else globalThis.document = previousDocument
})

// Every leaf colour of a surface spec, by path.
function surfaceColors(spec) {
  const out = []
  for (const [key, value] of Object.entries(spec)) {
    if (typeof value === 'string' && key !== 'style' && (value.startsWith('#') || value.startsWith('rgba'))) out.push([key, value])
    if (Array.isArray(value) && typeof value[0] === 'string') for (const v of value) out.push([key, v])
  }
  return out
}

const channels = (hex) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255]

describe('map look palettes', () => {
  it('lists the twelve kind palettes in kind order', () => {
    expect(MAP_PALETTE_IDS).toEqual(KIND_PALETTES)
    expect(Object.keys(MAP_PALETTES)).toEqual(KIND_PALETTES)
    expect(Object.isFrozen(MAP_PALETTES)).toBe(true)
    expect(Object.isFrozen(MAP_PALETTES.poolTile.floor)).toBe(true)
    for (const id of KIND_PALETTES) expect(FAMILY_PALETTES[id], id).toBeUndefined()
  })

  it('resolves family ids, then map palette ids, then Office', () => {
    for (const [family, pal] of Object.entries(FAMILY_PALETTES)) expect(familyPalette(family)).toBe(pal)
    for (const id of KIND_PALETTES) expect(familyPalette(id), id).toBe(MAP_PALETTES[id])
    for (const unknown of [undefined, null, '', 'nope']) expect(familyPalette(unknown)).toBe(FAMILY_PALETTES[MAP_FAMILY_OFFICE])
  })

  it('shares the family palette shape', () => {
    const office = FAMILY_PALETTES[MAP_FAMILY_OFFICE]
    const officeKeys = Object.keys(office).sort()
    for (const id of KIND_PALETTES) {
      const pal = MAP_PALETTES[id]
      expect(Object.keys(pal).sort(), id).toEqual(officeKeys)
      for (const slot of SLOTS) {
        const spec = pal[slot]
        // The keys every family surface carries; the rest belong to the style.
        for (const key of ['style', 'base', 'flecks']) expect(spec, `${id}.${slot}`).toHaveProperty(key)
        expect(spec.base, `${id}.${slot}.base`).toMatch(HEX)
        expect(spec.flecks.length, `${id}.${slot}.flecks`).toBeGreaterThan(0)
        for (const [key, value] of surfaceColors(spec)) expect(isColor(value), `${id}.${slot}.${key} ${value}`).toBe(true)
      }
      for (const key of ['topLight', 'floorShade']) expect(pal.wall[key], `${id}.wall.${key}`).toMatch(RGBA)
      expect(pal.gradeTint, id).toHaveLength(office.gradeTint.length)
    }
  })

  it('names only existing painter styles, each with gloss and a physical surface', () => {
    for (const id of KIND_PALETTES) {
      for (const slot of SLOTS) {
        const style = MAP_PALETTES[id][slot].style
        expect(SLOT_STYLES[slot].has(style), `${id}.${slot}.style ${style}`).toBe(true)
        expect(SURFACE_GLOSS[style], `${id}.${slot} gloss`).toBeTypeOf('number')
        expect(SURFACE_STYLES[style], `${id}.${slot} surface`).toBeDefined()
      }
    }
  })

  it('keeps colours, grade, fog and exposure in a sane range', () => {
    const exposures = Object.values(FAMILY_PALETTES).map((p) => p.exposure)
    for (const id of KIND_PALETTES) {
      const pal = MAP_PALETTES[id]
      for (const key of COLOR_KEYS) {
        expect(Number.isInteger(pal[key]), `${id}.${key}`).toBe(true)
        expect(pal[key], `${id}.${key}`).toBeGreaterThanOrEqual(0)
        expect(pal[key], `${id}.${key}`).toBeLessThanOrEqual(0xffffff)
      }
      // Fog is the far-distance colour: never brighter than a mid tone, or
      // the corridors would fade to white instead of into the dark.
      expect(Math.max(...channels(pal.fog)), `${id}.fog`).toBeLessThanOrEqual(0x90)
      // A lit lamp outshines its dead tube.
      expect(Math.max(...channels(pal.panel)), `${id}.panel`).toBeGreaterThan(Math.max(...channels(pal.panelDead)))
      for (const t of pal.gradeTint) {
        expect(Number.isFinite(t), `${id}.gradeTint`).toBe(true)
        expect(t).toBeGreaterThanOrEqual(0.8)
        expect(t).toBeLessThanOrEqual(1.25)
      }
      expect(pal.gradeSat, `${id}.gradeSat`).toBeGreaterThanOrEqual(0.8)
      expect(pal.gradeSat, `${id}.gradeSat`).toBeLessThanOrEqual(1.4)
      // Within the span the families already ship, a little either side.
      expect(pal.exposure, `${id}.exposure`).toBeGreaterThanOrEqual(Math.min(...exposures) - 0.1)
      expect(pal.exposure, `${id}.exposure`).toBeLessThanOrEqual(Math.max(...exposures))
    }
  })

  it('paints every surface with real colours and finite strokes', () => {
    // The harness itself: the families' own palettes paint clean.
    for (const [family, pal] of Object.entries(FAMILY_PALETTES)) {
      for (const slot of SLOTS) paintSurfaceCanvas(slot, pal[slot])
      expect(paintErrors, family).toEqual([])
    }
    for (const id of KIND_PALETTES) {
      for (const slot of SLOTS) {
        expect(() => paintSurfaceCanvas(slot, MAP_PALETTES[id][slot]), `${id}.${slot}`).not.toThrow()
        expect(paintErrors, `${id}.${slot}`).toEqual([])
      }
    }
  })
})
