import { describe, expect, it } from 'vitest'
import { buildCeilingSlab } from '../mesh.js'
import { CELL, CHUNK, LAYER_H, WALL_BEVEL, WALL_H } from '../constants.js'

// A hole mask with every corner the nosing has to mitre: a 3x2 block with a
// notch bitten out of it (convex and reflex corners), a lone cell touching
// the block diagonally (a checkerboard vertex), and a hole on the chunk edge.
const MASK = ['5,5', '6,5', '7,5', '5,6', '6,6', '8,7', '0,9', '0,10']
const holes = new Set(MASK)
const isHole = (x, z) => holes.has(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`)

function triangles(geo) {
  const p = geo.attributes.position.array
  const n = geo.attributes.normal.array
  const out = []
  for (let i = 0; i < p.length; i += 9) {
    const v = [0, 3, 6].map((k) => [p[i + k], p[i + k + 1], p[i + k + 2]])
    const e1 = v[1].map((c, k) => c - v[0][k])
    const e2 = v[2].map((c, k) => c - v[0][k])
    const face = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]
    out.push({ v, face, normal: [n[i], n[i + 1], n[i + 2]] })
  }
  return out
}

// Does the xz projection of triangle v contain (x, z)?
function covers(v, x, z) {
  const side = (a, b) => (b[0] - a[0]) * (z - a[2]) - (b[2] - a[2]) * (x - a[0])
  const d = [side(v[0], v[1]), side(v[1], v[2]), side(v[2], v[0])]
  return d.every((s) => s >= 0) || d.every((s) => s <= 0)
}

describe('ceiling slab nosing', () => {
  const geo = buildCeilingSlab(holes)
  const tris = triangles(geo)
  const underside = tris.filter((t) => t.face[1] < -1e-12)

  it('covers every solid point exactly once from below and no hole point', () => {
    // Bucket the underside by metre so the dense lattice stays cheap.
    const buckets = new Map()
    for (const t of underside) {
      const xs = t.v.map((p) => p[0])
      const zs = t.v.map((p) => p[2])
      for (let bx = Math.floor(Math.min(...xs)); bx <= Math.floor(Math.max(...xs)); bx++) {
        for (let bz = Math.floor(Math.min(...zs)); bz <= Math.floor(Math.max(...zs)); bz++) {
          const key = `${bx},${bz}`
          if (!buckets.has(key)) buckets.set(key, [])
          buckets.get(key).push(t)
        }
      }
    }
    const wrong = []
    // An off-grid lattice over the cells around the mask, finer than the
    // nosing band so every strip, mitre and notch square is sampled.
    for (let x = 0.0137; x < 10 * CELL; x += 0.0391) {
      for (let z = 4 * CELL + 0.0113; z < 11 * CELL; z += 0.0397) {
        const near = buckets.get(`${Math.floor(x)},${Math.floor(z)}`) ?? []
        const hits = near.filter((t) => covers(t.v, x, z)).length
        if (hits !== (isHole(x, z) ? 0 : 1)) wrong.push(`${x.toFixed(3)},${z.toFixed(3)}: ${hits}`)
      }
    }
    expect(wrong).toEqual([])
  })

  it('rounds the lower edge into the skirt, keeping the full slab depth', () => {
    const ys = tris.flatMap((t) => t.v.map((p) => p[1]))
    expect(Math.min(...ys)).toBeCloseTo(WALL_H, 6)
    expect(Math.max(...ys)).toBeCloseTo(LAYER_H, 6)
    // Tilted faces exist only in the nosing band, between the underside and
    // WALL_BEVEL above it, and their shading normals turn outward and down.
    const tilted = tris.filter((t) => Math.abs(t.face[1]) > 1e-9 && Math.abs(Math.abs(t.face[1]) - Math.hypot(...t.face)) > 1e-9)
    expect(tilted.length).toBeGreaterThan(0)
    for (const t of tilted) {
      for (const p of t.v) expect(p[1]).toBeLessThanOrEqual(WALL_H + WALL_BEVEL + 1e-6)
      expect(t.normal[1]).toBeLessThanOrEqual(1e-9)
    }
    // Every shading normal agrees with its face (no inverted triangles).
    for (const t of tris) {
      const dot = t.face[0] * t.normal[0] + t.face[1] * t.normal[1] + t.face[2] * t.normal[2]
      expect(dot).toBeGreaterThan(0)
    }
  })

  it('lets a hole on the seam round into the neighbour, which cuts its own underside', () => {
    // The hole owner draws the skirt and nosing; the neighbour reads the same
    // void through outsideHole and gives up the band under it.
    const xs = tris.flatMap((t) => t.v.map((p) => p[0]))
    expect(Math.min(...xs)).toBeCloseTo(-WALL_BEVEL, 6)
    expect(Math.max(...xs)).toBeLessThanOrEqual(CHUNK * CELL + 1e-9)
    const neighbour = triangles(buildCeilingSlab(new Set(), (x, z) => x === CHUNK && (z === 9 || z === 10)))
      .filter((t) => t.face[1] < 0)
    for (let z = 9 * CELL + 0.01; z < 11 * CELL; z += 0.1) {
      const x = CHUNK * CELL - WALL_BEVEL / 2
      expect(neighbour.some((t) => covers(t.v, x, z))).toBe(false)
      expect(neighbour.some((t) => covers(t.v, x - WALL_BEVEL, z))).toBe(true)
    }
  })
})
