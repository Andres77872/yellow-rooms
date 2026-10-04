import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { listPacks, packDir, readGlbChunks, readPackManifest } from './packManifest.js'

// Blender pack manifests (scripts/blender/build_pack.py, schema v1) vs the
// GLBs beside them. Every directory under public/models with a manifest is
// covered, so a new pack is checked as soon as it is built. A stale manifest
// (GLB rebuilt or edited without rebuilding the pack) fails the freshness
// checks; the class contracts mirror the build-time audits with the same
// tolerances the furniture contract test uses.

const TOL_XZ = 0.15 // footprint allowance past collision + overhang
const TOL_CENTER = 0.12
const TOL_H = 0.06
const OCC_MAX_H = 2.1 // occupancy texture height (lightGrid/gridSpec.js)
const REACH = 1.2 // player/collision.js scan reach past a piece's half-extent
const EPS = 1e-4 // manifest floats are rounded to 4 decimals
const CLASSES = ['B', 'C', 'D', 'E']

const PACKS = listPacks()

function glbStats(file) {
  const { bytes, json, bin } = readGlbChunks(file)
  const mn = [Infinity, Infinity, Infinity]
  const mx = [-Infinity, -Infinity, -Infinity]
  let tris = 0
  for (const mesh of json.meshes) {
    for (const prim of mesh.primitives) {
      const acc = json.accessors[prim.attributes.POSITION]
      for (let i = 0; i < 3; i++) {
        mn[i] = Math.min(mn[i], acc.min[i])
        mx[i] = Math.max(mx[i], acc.max[i])
      }
      tris += json.accessors[prim.indices].count / 3
    }
  }
  return { bytes, json, bin, mn, mx, tris }
}

// Painted COLOR_0 multiplier values ((r + g + b) / 3 per vertex) of every
// primitive: normalized UNSIGNED_BYTE VEC4, read straight from the BIN chunk.
function paintedValues({ json, bin }) {
  const values = []
  for (const mesh of json.meshes) {
    for (const prim of mesh.primitives) {
      const acc = json.accessors[prim.attributes.COLOR_0]
      const view = json.bufferViews[acc.bufferView]
      const stride = view.byteStride || 4
      const base = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0)
      for (let i = 0; i < acc.count; i++) {
        const o = base + i * stride
        values.push((bin[o] + bin[o + 1] + bin[o + 2]) / (3 * 255))
      }
    }
  }
  return values
}

const expectClose = (actual, expected, label) => {
  expect(Math.abs(actual - expected), `${label}: ${actual} vs ${expected}`).toBeLessThanOrEqual(EPS)
}

describe('Blender pack manifests', () => {
  it('finds the built packs (furniture at least)', () => {
    expect(PACKS).toContain('furniture')
  })
})

describe.each(PACKS)('pack %s', (pack) => {
  const manifest = readPackManifest(pack)
  const dir = packDir(pack)

  it('is a schema v1 manifest with its generator recorded', () => {
    expect(manifest.schema).toBe(1)
    expect(manifest.pack).toBe(pack)
    for (const key of ['blender', 'blenderHash', 'exporter', 'script']) {
      expect(typeof manifest.generator[key], key).toBe('string')
      expect(manifest.generator[key].length, key).toBeGreaterThan(0)
    }
    expect(manifest.kinds.length).toBeGreaterThan(0)
    const names = manifest.kinds.map((k) => k.kind)
    expect(new Set(names).size).toBe(names.length)
    for (const k of manifest.kinds) {
      expect(k.file).toBe(`${k.kind}.glb`)
      expect(CLASSES).toContain(k.class)
      if (k.kindKey !== null) expect(k.kindKey).toMatch(/^[A-Z][A-Z0-9_]*$/)
    }
  })

  it('lists exactly the GLBs in its directory', () => {
    const glbs = readdirSync(dir).filter((f) => f.endsWith('.glb')).sort()
    expect(manifest.kinds.map((k) => k.file).sort()).toEqual(glbs)
  })

  it('describes the GLBs as built (sha256, bytes, triangles, bounds)', () => {
    for (const k of manifest.kinds) {
      const st = glbStats(path.join(dir, k.file))
      expect(createHash('sha256').update(st.bytes).digest('hex'), k.kind).toBe(k.sha256)
      expect(st.bytes.byteLength, k.kind).toBe(k.bytes)
      expect(Number.isInteger(st.tris), k.kind).toBe(true)
      expect(st.tris, k.kind).toBe(k.tris)
      for (let i = 0; i < 3; i++) {
        expectClose(st.mn[i], k.bounds.min[i], `${k.kind} min[${i}]`)
        expectClose(st.mx[i], k.bounds.max[i], `${k.kind} max[${i}]`)
      }
      expect(st.json.materials.map((m) => m.name), k.kind).toEqual(k.materials)
    }
  })

  it('stays inside its per-kind and pack budgets', () => {
    let tris = 0, bytes = 0
    for (const k of manifest.kinds) {
      expect(k.tris, k.kind).toBeLessThanOrEqual(k.budget.tris)
      expect(k.bytes, k.kind).toBeLessThanOrEqual(k.budget.bytes)
      tris += k.tris
      bytes += k.bytes
    }
    expect(manifest.totals).toEqual({ tris, bytes })
    expect(tris).toBeLessThan(manifest.budget.tris)
    expect(bytes).toBeLessThan(manifest.budget.bytes)
  })

  it('holds every kind to its class contract', () => {
    for (const k of manifest.kinds) {
      const { mn, mx } = glbStats(path.join(dir, k.file))
      expect(mn[1], k.kind).toBeGreaterThanOrEqual(k.floorZ - 0.005)
      expect(mx[1], k.kind).toBeLessThanOrEqual(k.heightBudget + TOL_H)
      expect(mx[0] - mn[0], k.kind).toBeLessThanOrEqual(k.collision.w + k.overhang.w + TOL_XZ)
      expect(mx[2] - mn[2], k.kind).toBeLessThanOrEqual(k.collision.d + k.overhang.d + TOL_XZ)
      if (k.class === 'B') {
        expect(mn[1], k.kind).toBeGreaterThanOrEqual(-0.005) // origin sits ON the floor
        expect(k.heightBudget, k.kind).toBeLessThanOrEqual(OCC_MAX_H)
        expect(mx[1], k.kind).toBeLessThanOrEqual(OCC_MAX_H + TOL_H)
        expect(k.collision.w / 2, k.kind).toBeLessThan(REACH)
        expect(k.collision.d / 2, k.kind).toBeLessThan(REACH)
        if (k.anchor === 'center' && k.footprintCells.length === 1) {
          expect(Math.abs((mn[0] + mx[0]) / 2), k.kind).toBeLessThanOrEqual(TOL_CENTER)
          expect(Math.abs((mn[2] + mx[2]) / 2), k.kind).toBeLessThanOrEqual(TOL_CENTER)
        }
      }
      if (k.class === 'C') {
        expect(k.colliders.length, k.kind).toBeGreaterThan(0)
        expect(k.footprintCells.length, k.kind).toBeGreaterThan(0)
      }
      if (k.class === 'E') expect(k.sockets.length, k.kind).toBeGreaterThan(0)
      expect(k.proxies.length, k.kind).toBeLessThanOrEqual(2)
      for (const b of [...k.colliders, ...k.proxies]) {
        expect(b.u0 < b.u1 && b.v0 < b.v1 && b.y0 < b.y1, k.kind).toBe(true)
      }
      for (const b of k.proxies) {
        expect(Number.isInteger(b.t) && b.t >= 0 && b.t <= 7, k.kind).toBe(true)
        expect(b.y1, k.kind).toBeLessThanOrEqual(OCC_MAX_H)
      }
    }
  })

  it('exports every socket as a node with its manifest position and extras', () => {
    for (const k of manifest.kinds) {
      const { json } = readGlbChunks(path.join(dir, k.file))
      const sockets = json.nodes.filter((n) => n.name.startsWith('socket_'))
      expect(sockets.map((n) => n.name).sort(), k.kind).toEqual(k.sockets.map((s) => s.name).sort())
      for (const s of k.sockets) {
        expect(typeof s.yrSocket, `${k.kind} ${s.name}`).toBe('string')
        const node = sockets.find((n) => n.name === s.name)
        expect(node.extras?.yrSocket, `${k.kind} ${s.name}`).toBe(s.yrSocket)
        const t = node.translation ?? [0, 0, 0]
        for (let i = 0; i < 3; i++) expectClose(t[i], s.at[i], `${k.kind} ${s.name} at[${i}]`)
      }
    }
  })

  it('ships compact painted GLBs (normalized COLOR_0, no UVs, cameras or required extensions)', () => {
    for (const k of manifest.kinds) {
      const glb = readGlbChunks(path.join(dir, k.file))
      const { json } = glb
      expect(json.meshes.length, k.kind).toBeGreaterThan(0)
      for (const mesh of json.meshes) {
        for (const prim of mesh.primitives) {
          expect(prim.material, k.kind).toBeTypeOf('number')
          expect(prim.attributes.TEXCOORD_0, k.kind).toBeUndefined()
          const color = json.accessors[prim.attributes.COLOR_0]
          expect(color, k.kind).toMatchObject({ componentType: 5121, normalized: true, type: 'VEC4' })
        }
      }
      expect(json.cameras ?? [], k.kind).toHaveLength(0)
      expect(json.extensionsRequired ?? [], k.kind).toHaveLength(0)
      // The painted multiplier stays gentle: the game adds SSAO on top.
      const values = paintedValues(glb)
      expect(values.length, k.kind).toBeGreaterThan(0)
      expect(Math.min(...values), k.kind).toBeGreaterThanOrEqual(0.6)
      expect(values.reduce((a, b) => a + b, 0) / values.length, k.kind).toBeGreaterThan(0.72)
    }
  })
})
