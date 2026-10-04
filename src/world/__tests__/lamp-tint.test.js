import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { generateChunk } from '../generate.js'
import { worldConfigForFamily } from '../mapFamily.js'
import { CELL, CHUNK, CHUNK_WORLD, layerY } from '../constants.js'
import { applyLampRecordTint } from '../lampCharacter.js'
import { buildChunkMeshes } from '../mesh.js'
import { LightGrid } from '../lightGrid/LightGrid.js'
import { texelIndex } from '../lightGrid/gridSpec.js'
import { EditorMap } from '../../editor/EditorMap.js'
import { createGeometries, disposeGeometries } from '../../render/geometries.js'
import { LightField, makeLampUniforms } from '../../render/LightField.js'
import { panelLights } from '../../render/pathtrace/proxyScene.js'

// Authored per-lamp colour (lamp record `tint`, 0xRRGGBB): every path that
// turns a lamp into colour — the emissive panel instance, LightField's cast
// light, the light grid's lamp texels (and so its lists and bounce), the
// path-tracer proxy lights — multiplies it in. Absent or white must be
// bit-for-bit the untinted build; red must touch only the tinted lamp.

const SEED = 12
const config = worldConfigForFamily('office')

// The first chunk near the origin with a few lit fixtures (deterministic).
const HOME = (() => {
  for (let cz = -2; cz <= 2; cz++) {
    for (let cx = -2; cx <= 2; cx++) {
      const d = generateChunk(SEED, cx, 0, cz, config)
      if (d.lamps.filter((l) => l.lit).length >= 3) return { cx, cz }
    }
  }
  throw new Error('no lit chunk near the origin')
})()

const RED = 0xff0000

// Build the home chunk afresh and run it through every colour path.
// `tintOf(l, i)` gives the record's tint for lit lamp i (undefined = none).
function computeColours(tintOf = () => undefined) {
  const d = generateChunk(SEED, HOME.cx, 0, HOME.cz, config)
  const lit = d.lamps.filter((l) => l.lit)
  lit.forEach((l, i) => {
    const t = tintOf(l, i)
    if (t !== undefined) l.tint = t
  })
  const ox = d.cx * CHUNK_WORLD
  const oz = d.cz * CHUNK_WORLD
  const geometry = createGeometries()
  const material = new THREE.MeshBasicMaterial()
  const materials = new Proxy({}, { get: () => material })
  const mesh = buildChunkMeshes(d, geometry, materials, ox, layerY(d.cy), oz)

  const panels = Float32Array.from(mesh.parts.litPanels.instanceColor.array)

  const grid = new LightGrid()
  grid.addChunk(d)
  grid.setPlayerFloor(d.cy)
  grid.flush()

  // LightField's uploaded character, keyed by the lamp's cell.
  const u = makeLampUniforms()
  const field = new LightField(u)
  const cm = {
    collectLampsNear(_px, _pz, out) {
      out.length = 0
      out.push(...mesh.lamps)
      return out
    },
  }
  field.update(0.25, ox + CHUNK_WORLD / 2, oz + CHUNK_WORLD / 2, d.cy, cm)
  const cast = new Map()
  for (let i = 0; i < u.uLampCount.value; i++) {
    const p = u.uLampPos.value[i]
    const c = u.uLampChar.value[i]
    cast.set(cellKey(p.x, p.z), [c.x, c.y, c.z])
  }

  const eye = new THREE.Vector3(ox + CHUNK_WORLD / 2, layerY(d.cy) + 1.6, oz + CHUNK_WORLD / 2)
  const traced = new Map()
  for (const light of panelLights({ eye, floor: d.cy, lamps: mesh.lamps, lightRadius: 1e4, maxLights: 1e4 }).lights) {
    traced.set(cellKey(light.position[0], light.position[2]), light.color)
  }

  const out = {
    d,
    lit,
    panels,
    gridLamp: Uint8Array.from(grid.lamp),
    gridList: Uint32Array.from(grid.list),
    gridGi: Uint16Array.from(grid.gi),
    cast,
    traced,
  }
  mesh.dispose()
  disposeGeometries(geometry)
  return out
}

const cellKey = (x, z) => `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`
const lampCell = (d, l) => `${d.cx * CHUNK + l.lx},${d.cz * CHUNK + l.lz}`
const lampTexel = (d, l) => texelIndex(d.cx * CHUNK + l.lx, d.cz * CHUNK + l.lz, d.cy) * 4

// Exact element-wise equality without a giant diff on failure.
function firstMismatch(a, b) {
  if (a.length !== b.length) return -2
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return i
  return -1
}

describe('per-lamp tint', () => {
  const base = computeColours()

  it('applyLampRecordTint: absent is untouched, white is identity, channels are linear /255', () => {
    const v = [1.07, 0.93, 1.21]
    expect(applyLampRecordTint([...v], undefined)).toEqual(v)
    expect(applyLampRecordTint([...v], null)).toEqual(v)
    expect(applyLampRecordTint([...v], 0xffffff)).toEqual(v)
    const t = applyLampRecordTint([...v], 0x80ff00)
    expect(t[0]).toBe(v[0] * (0x80 / 255))
    expect(t[1]).toBe(v[1])
    expect(t[2]).toBe(0)
  })

  it('tint 0xffffff builds bit-for-bit the untinted colours in every path', () => {
    const white = computeColours(() => 0xffffff)
    expect(base.lit.length).toBeGreaterThanOrEqual(3)
    expect(firstMismatch(white.panels, base.panels)).toBe(-1)
    expect(firstMismatch(white.gridLamp, base.gridLamp)).toBe(-1)
    expect(firstMismatch(white.gridList, base.gridList)).toBe(-1)
    expect(firstMismatch(white.gridGi, base.gridGi)).toBe(-1)
    expect(base.cast.size).toBe(base.lit.length)
    expect(white.cast).toEqual(base.cast)
    expect(base.traced.size).toBe(base.lit.length)
    expect(white.traced).toEqual(base.traced)
  })

  it('a red tint changes only the tinted lamp, in every path', () => {
    const k = 1
    const red = computeColours((_l, i) => (i === k ? RED : undefined))
    const d = base.d
    const target = lampCell(d, base.lit[k])

    // Emissive panel instance colour: red keeps R, zeroes G and B.
    for (let i = 0; i < base.lit.length; i++) {
      const a = base.panels.subarray(i * 3, i * 3 + 3)
      const b = red.panels.subarray(i * 3, i * 3 + 3)
      if (i === k) {
        expect(b[0]).toBe(a[0])
        expect(a[1]).toBeGreaterThan(0)
        expect([b[1], b[2]]).toEqual([0, 0])
      } else {
        expect(Array.from(b)).toEqual(Array.from(a))
      }
    }

    // Light grid lamp texels: only the tinted fixture's RGB moves; its
    // flicker byte and every other texel stay put.
    const e = lampTexel(d, base.lit[k])
    for (let i = 0; i < base.gridLamp.length; i++) {
      if (i === e + 1 || i === e + 2) continue
      if (base.gridLamp[i] !== red.gridLamp[i]) throw new Error(`grid lamp byte ${i} changed`)
    }
    expect(base.gridLamp[e + 1]).toBeGreaterThan(0)
    expect([red.gridLamp[e + 1], red.gridLamp[e + 2]]).toEqual([0, 0])

    // LightField cast light and path-tracer proxy lights.
    for (const [cells, tinted] of [[base.cast, red.cast], [base.traced, red.traced]]) {
      expect(tinted.size).toBe(cells.size)
      for (const [key, c] of cells) {
        const t = tinted.get(key)
        if (key === target) {
          expect(t[0]).toBe(c[0])
          expect(c[1]).toBeGreaterThan(0)
          expect([t[1], t[2]]).toEqual([0, 0])
        } else {
          expect(t).toEqual(c)
        }
      }
    }
  })

  // The editor's look-mode preview feeds document chunks straight to the
  // light grid (Preview3D: game.grid.addChunk(d)); a tinted record there
  // reaches the GPU lamp texels the same way.
  it('an editor document lamp carries its tint into the light grid', () => {
    const texel = (tint) => {
      const map = new EditorMap()
      map.mutate(() => map.setLamp(4, 0, 4, true))
      const d = map.chunks.values().next().value
      const l = d.lamps[0]
      if (tint !== undefined) l.tint = tint
      const grid = new LightGrid()
      grid.addChunk(d)
      const e = lampTexel(d, l)
      return Array.from(grid.lamp.subarray(e, e + 4))
    }
    const plain = texel(undefined)
    expect(plain[0]).toBeGreaterThan(0)
    expect(texel(0xffffff)).toEqual(plain)
    expect(texel(RED)).toEqual([plain[0], 0, 0, plain[3]])
  })
})
