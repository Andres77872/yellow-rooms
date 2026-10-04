import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import {
  DECAL_CELLS,
  DECAL_KINDS,
  SAFETY_NOTICES,
  SEWER_LARGE_PLATES,
  SEWER_SMALL_PLATES,
  SIGN_PLATES,
  WAYFINDING,
  decalAspect,
  decalCell,
  decalCellAt,
  decalKindOf,
  safetyCell,
  signCell,
  signCellFor,
  signPlateAt,
  wayfindingCell,
} from '../decalKinds.js'
import { MAP_FAMILY_HOTEL, SPACE_ROLE_BATHROOM, SPACE_ROLE_BEDROOM, SPACE_ROLE_NONE, SPACE_ROLE_SERVER } from '../mapTypes.js'
import { collectInteriorDressing, PROP_TINT } from '../objects/index.js'
import { buildChunkMeshes } from '../mesh.js'
import { createGeometries, disposeGeometries } from '../../render/geometries.js'
import { generateChunk } from '../generate.js'
import { worldConfigForFamily } from '../mapFamily.js'
import { DEFAULT_WORLD_CONFIG } from '../config.js'
import { CELL, THICK, EXT_T } from '../constants.js'
import { familiesWith } from '../families/registry.js'

// Office-semantics matrix: only the building families (spec §11.4). The
// liminal families have their own per-family suites.
const BUILDING_FAMILIES = familiesWith('buildingMatrices')

describe('decal vocabulary', () => {
  it('tiles the atlas with non-overlapping kind runs', () => {
    const owner = new Array(DECAL_CELLS).fill(null)
    for (const [kind, [first, count]] of Object.entries(DECAL_KINDS)) {
      for (let c = first; c < first + count; c++) {
        expect(owner[c], `cell ${c}`).toBeNull()
        owner[c] = kind
      }
    }
    expect(owner.every(Boolean)).toBe(true)
  })

  it('picks cells inside the kind for any roll or key', () => {
    for (const kind of Object.keys(DECAL_KINDS)) {
      for (const roll of [0, 0.2, 0.5, 0.999, 1, -1]) expect(decalKindOf(decalCell(kind, roll))).toBe(kind)
      for (const key of [0, 5, -3, 0xffffffff, 2 ** 31 + 7]) expect(decalKindOf(decalCellAt(kind, key))).toBe(kind)
      expect(decalAspect(kind)).toBeGreaterThan(0)
    }
  })

  it('gives every signage cell one fixed meaning', () => {
    expect(SAFETY_NOTICES).toHaveLength(DECAL_KINDS.safety[1])
    expect(new Set(SAFETY_NOTICES).size).toBe(SAFETY_NOTICES.length)
    for (const id of SAFETY_NOTICES) expect(decalKindOf(safetyCell(id))).toBe('safety')
    expect(WAYFINDING).toHaveLength(DECAL_KINDS.wayfinding[1])
    for (const { label, dir } of WAYFINDING) expect(decalKindOf(wayfindingCell(label, dir))).toBe('wayfinding')
    expect(wayfindingCell('EXIT', -1)).not.toBe(wayfindingCell('EXIT', 1))
    for (const [family, plates] of Object.entries(SIGN_PLATES)) {
      expect(plates, family).toHaveLength(DECAL_KINDS.sign[1])
      expect(new Set(plates.map((p) => p.id)).size, family).toBe(plates.length)
      for (const p of plates) expect(signPlateAt(signCell(p.id, family), family)).toBe(p)
      expect(signPlateAt(signCell('level', family), family).numbered, family).toBe(true)
    }
    for (const id of [...SEWER_LARGE_PLATES, ...SEWER_SMALL_PLATES]) expect(signCell(id, 'sewer')).toBeGreaterThanOrEqual(0)
  })

  it('names a room by its role, the same in every world', () => {
    expect(signCellFor(SPACE_ROLE_SERVER, 'office')).toBe(signCell('electrical', 'office'))
    expect(signCellFor(SPACE_ROLE_BATHROOM, 'office')).toBe(signCell('restroom', 'office'))
    expect(signCellFor(SPACE_ROLE_NONE, 'office')).toBe(signCell('room', 'office'))
    expect(signPlateAt(signCellFor(SPACE_ROLE_SERVER, 'tower'), 'tower').text).toBe('COMMS')
    // A hotel's guest rooms carry their number on the door, not a sign.
    expect(signCellFor(SPACE_ROLE_NONE, MAP_FAMILY_HOTEL)).toBe(-1)
    expect(signCellFor(SPACE_ROLE_BEDROOM, MAP_FAMILY_HOTEL)).toBe(-1)
    expect(decalKindOf(signCellFor(SPACE_ROLE_BATHROOM, MAP_FAMILY_HOTEL))).toBe('sign')
  })
})

describe('decal dressing', () => {
  const chunks = (family) => {
    const config = worldConfigForFamily?.(family) ?? DEFAULT_WORLD_CONFIG
    const out = []
    for (let cx = 0; cx < 4; cx++) for (let cz = 0; cz < 4; cz++) out.push(generateChunk(4242, cx, 0, cz, config))
    return out
  }

  it('is deterministic and hangs printed matter in every family', () => {
    for (const family of BUILDING_FAMILIES) {
      let total = 0
      for (const d of chunks(family)) {
        const a = collectInteriorDressing(d).decals ?? []
        expect(collectInteriorDressing(d).decals ?? []).toEqual(a)
        total += a.length
      }
      expect(total, family).toBeGreaterThan(0)
    }
  })

  it('keeps every plate thin, on a wall plane and no prouder than the wall props', () => {
    for (const family of BUILDING_FAMILIES) {
      for (const d of chunks(family)) {
        for (const p of collectInteriorDressing(d).decals ?? []) {
          expect(p.cell).toBeGreaterThanOrEqual(0)
          expect(p.cell).toBeLessThan(DECAL_CELLS)
          const thinX = p.sx < p.sz
          const t = thinX ? p.sx : p.sz
          expect(t).toBeLessThanOrEqual(0.012 + 1e-9)
          const c = thinX ? p.px : p.pz
          const plane = Math.round(c / CELL) * CELL
          const reach = Math.abs(c - plane) + t / 2
          expect(reach).toBeGreaterThanOrEqual(THICK / 2 - 1e-9)
          expect(reach).toBeLessThanOrEqual(THICK / 2 + EXT_T + 0.02 + 1e-9)
          expect(p.py - p.sy / 2).toBeGreaterThan(0.3)
          expect(p.py + p.sy / 2).toBeLessThan(3.0)
        }
      }
    }
  })

  it('raises numerals only on a drawn plate: a build without the decal batch drops them', () => {
    const geometry = createGeometries()
    const material = new THREE.MeshBasicMaterial()
    const names = ['carpet', 'ceiling', 'wallpaper', 'doorFrame', 'doorLeaf', 'prop', 'signGlow', 'furniture', 'panel', 'panelDead', 'exit']
    const preview = Object.fromEntries(names.map((name) => [name, material])) // the editor's geometry preview
    const game = { ...preview, decal: material }
    const ink = PROP_TINT.signInk
    const strokesOf = (mesh) => {
      const props = mesh.parts.props
      const c = new THREE.Color()
      let n = 0
      for (let i = 0; props && i < props.count; i++) {
        props.getColorAt(i, c)
        if (Math.abs(c.r - ink[0]) + Math.abs(c.g - ink[1]) + Math.abs(c.b - ink[2]) < 1e-6) n++
      }
      return n
    }
    let numerals = 0
    for (const family of ['office', 'lattice']) {
      for (const d of chunks(family)) {
        const { props, decals } = collectInteriorDressing(d)
        // Every flagged stroke stands just proud of a numbered plate's face.
        const strokes = props.filter((p) => p.numeral)
        for (const s of strokes) {
          expect(s.tint).toBe(ink)
          const plate = decals.find((p) => {
            if (p.number == null) return false
            const thinX = p.sx < p.sz
            const off = thinX ? s.px - p.px : s.pz - p.pz
            return Math.abs(off) < 0.02 && Math.abs(s.py - p.py) < p.sy / 2 &&
              Math.abs(thinX ? s.pz - p.pz : s.px - p.px) < (thinX ? p.sz : p.sx) / 2
          })
          expect(plate, `${family} numeral off its plate`).toBeDefined()
        }
        numerals += strokes.length
        const bare = buildChunkMeshes(d, geometry, preview, 0, 0, 0)
        expect(bare.parts.decals).toBeNull()
        expect(strokesOf(bare), `${family} numerals with no plate drawn`).toBe(0)
        bare.dispose()
        const drawn = buildChunkMeshes(d, geometry, game, 0, 0, 0)
        if (strokes.length) expect(strokesOf(drawn), `${family} numerals on drawn plates`).toBeGreaterThan(0)
        drawn.dispose()
      }
    }
    expect(numerals).toBeGreaterThan(0)
    disposeGeometries(geometry)
    material.dispose()
  })
})
