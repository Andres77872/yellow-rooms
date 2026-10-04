import { wallFeatureSeesThrough } from '../../mapTypes.js'
import { cellWalkable } from '../../tiles/holeMasks.js'

// The playplace's lamp cover (doc 10 §8: the brightest map after the
// Showroom, under the world's lamp density, §11.1). A greedy set cover over
// one storey of one module, in the judge's own light model
// (tiles/simulate.js lightField: a lit tube reaches the cells within six
// cells that it sees, (1 − d/6)² each, summed; a cell under DARK is dark):
// every round hangs the tube that lifts the most still-dark target cells
// over TARGET (ties: the most light added below it, then scan order), until
// no tube lifts one or every chunk-storey it could use is at its cap.
//
// Sight is read from the module's own chunks as they stand when the cover
// runs (walls, see-through rails and windows, every column a full block;
// nothing past the module's edge), so it never claims light the judge will
// not find: the judge also sees the neighbours' tubes and the slimmer piers.
// It costs a few milliseconds per storey (cell-unit DDA on typed arrays), a
// fraction of the generic fill (tiles/fillLight.js) it replaces here.

const RADIUS = 6
const R2 = RADIUS * RADIUS
// tiles/simulate.js DARK_LEVEL is 0.12; the cover aims a margin over it.
export const COVER_TARGET = 0.14

// The storey's sight grid over a W×D-cell region at kind-local (x0, z0):
// opaque vertical lines (W+1 per row), horizontal lines (D+1 per column) and
// blocking cells.
function sightGrid(map, cy, x0, z0, W, D) {
  const opV = new Uint8Array((W + 1) * D).fill(1)
  const opH = new Uint8Array(W * (D + 1)).fill(1)
  const block = new Uint8Array(W * D).fill(1)
  const chunkOf = (gx, gz) => map.chunkAt(map.cellChunk(gx), cy, map.cellChunk(gz))
  for (let z = 0; z < D; z++) {
    for (let x = 0; x <= W; x++) {
      const gx = x0 + x
      const gz = z0 + z
      const d = chunkOf(gx, gz)
      if (!d) continue
      const lx = map.cellLocal(gx)
      const lz = map.cellLocal(gz)
      if (x < W) block[z * W + x] = d.colAt(lx, lz) !== 0 ? 1 : 0
      opV[z * (W + 1) + x] = d.vAt(lx, lz) === 1 && !wallFeatureSeesThrough(d.wallFeatureVAt(lx, lz)) ? 1 : 0
    }
  }
  for (let z = 0; z <= D; z++) {
    for (let x = 0; x < W; x++) {
      const gx = x0 + x
      const gz = z0 + z
      const d = chunkOf(gx, gz)
      if (!d) continue
      const lx = map.cellLocal(gx)
      const lz = map.cellLocal(gz)
      opH[z * W + x] = d.hAt(lx, lz) === 1 && !wallFeatureSeesThrough(d.wallFeatureHAt(lx, lz)) ? 1 : 0
    }
  }
  // A line on the region's outer edge is opaque (nothing past it is read).
  for (let z = 0; z < D; z++) {
    opV[z * (W + 1)] = 1
    opV[z * (W + 1) + W] = 1
  }
  for (let x = 0; x < W; x++) {
    opH[x] = 1
    opH[D * W + x] = 1
  }
  // Cell-centre to cell-centre, the same traversal as player/collision.js
  // gridLineClear (ties step along z; the end cells are not tested).
  const sees = (ax, az, bx, bz) => {
    if (ax === bx && az === bz) return true
    const dx = bx - ax
    const dz = bz - az
    const sx = Math.sign(dx)
    const sz = Math.sign(dz)
    const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity
    const tdz = dz !== 0 ? Math.abs(1 / dz) : Infinity
    let tmx = dx !== 0 ? 0.5 / Math.abs(dx) : Infinity
    let tmz = dz !== 0 ? 0.5 / Math.abs(dz) : Infinity
    let x = ax
    let z = az
    let first = true
    for (let guard = 0; (x !== bx || z !== bz) && guard < 64; guard++) {
      if (!first && block[z * W + x]) return false
      first = false
      if (tmx < tmz) {
        const line = sx > 0 ? x + 1 : x
        if (opV[z * (W + 1) + line]) return false
        x += sx
        tmx += tdx
      } else {
        const line = sz > 0 ? z + 1 : z
        if (opH[line * W + x]) return false
        z += sz
        tmz += tdz
      }
    }
    return true
  }
  return { sees }
}

// Cover the dark cells `isTarget(gx, gz)` (kind-local) of storey cy over the
// region { x0, z0, W, D } with lit tubes on cells `canHang(gx, gz)` allows.
// `capOf(chunk)` bounds the lit tubes per chunk-storey (the chunk's own lit
// tubes count); `tintAt(gx, gz)` gives a tube's tint (null: plain). Returns
// the number of tubes hung.
export function coverStorey(map, cy, region, { isTarget, canHang = isTarget, capOf, tintAt = () => null, target = COVER_TARGET }) {
  const { x0, z0, W, D } = region
  const level = new Float32Array(W * D)
  const tgt = new Uint8Array(W * D)
  const lamp = new Uint8Array(W * D)
  const chunks = new Map()
  const chunkAt = (gx, gz) => map.chunkAt(map.cellChunk(gx), cy, map.cellChunk(gz))
  let any = false
  for (let z = 0; z < D; z++) {
    for (let x = 0; x < W; x++) {
      const gx = x0 + x
      const gz = z0 + z
      const d = chunkAt(gx, gz)
      if (!d || !cellWalkable(d, map.cellLocal(gx), map.cellLocal(gz)) || !isTarget(gx, gz)) continue
      tgt[z * W + x] = 1
      any = true
    }
  }
  if (!any) return 0
  const { sees } = sightGrid(map, cy, x0, z0, W, D)
  const shine = (ax, az, add) => {
    for (let z = Math.max(0, az - RADIUS); z <= Math.min(D - 1, az + RADIUS); z++) {
      for (let x = Math.max(0, ax - RADIUS); x <= Math.min(W - 1, ax + RADIUS); x++) {
        const q = (x - ax) ** 2 + (z - az) ** 2
        if (q > R2) continue
        const i = z * W + x
        if (add && !tgt[i]) continue
        if (!sees(ax, az, x, z)) continue
        const t = 1 - Math.sqrt(q) / RADIUS
        level[i] = Math.min(1.5, level[i] + t * t)
      }
    }
  }
  // The lit tubes already hung (this storey, inside the region).
  const litIn = new Map()
  for (let z = 0; z < D; z++) {
    for (let x = 0; x < W; x++) {
      const d = chunkAt(x0 + x, z0 + z)
      if (!d) continue
      if (!chunks.has(d)) chunks.set(d, d.lamps.filter((l) => l.lit).length)
      const l = map.lampAt(x0 + x, cy, z0 + z)
      if (!l) continue
      lamp[z * W + x] = 1
      if (l.rec.lit) litIn.set(z * W + x, true)
    }
  }
  for (const i of litIn.keys()) shine(i % W, (i - (i % W)) / W, false)

  // Candidates: their reach over the target cells still dark.
  const near = (x, z) => {
    for (let zz = Math.max(0, z - 1); zz <= Math.min(D - 1, z + 1); zz++) {
      for (let xx = Math.max(0, x - 1); xx <= Math.min(W - 1, x + 1); xx++) if (lamp[zz * W + xx]) return true
    }
    return false
  }
  const cands = []
  for (let z = 0; z < D; z++) {
    for (let x = 0; x < W; x++) {
      const gx = x0 + x
      const gz = z0 + z
      const d = chunkAt(gx, gz)
      if (!d) continue
      const lx = map.cellLocal(gx)
      const lz = map.cellLocal(gz)
      if (!cellWalkable(d, lx, lz) || d.hasCeilHole(lx, lz) || d.hasFloorHole(lx, lz) || lamp[z * W + x] || near(x, z)) continue
      if (!canHang(gx, gz)) continue
      const ks = []
      const vs = []
      for (let zz = Math.max(0, z - RADIUS); zz <= Math.min(D - 1, z + RADIUS); zz++) {
        for (let xx = Math.max(0, x - RADIUS); xx <= Math.min(W - 1, x + RADIUS); xx++) {
          const i = zz * W + xx
          if (!tgt[i] || level[i] >= target) continue
          const q = (xx - x) ** 2 + (zz - z) ** 2
          if (q > R2 || !sees(x, z, xx, zz)) continue
          const t = 1 - Math.sqrt(q) / RADIUS
          ks.push(i)
          vs.push(t * t)
        }
      }
      if (ks.length) cands.push({ x, z, d, ks, vs, live: true })
    }
  }
  let hung = 0
  for (;;) {
    let best = null
    let bestN = 0
    let bestSum = 0
    for (const c of cands) {
      if (!c.live) continue
      if (chunks.get(c.d) >= capOf(c.d)) {
        c.live = false
        continue
      }
      let n = 0
      let sum = 0
      for (let j = 0; j < c.ks.length; j++) {
        const lv = level[c.ks[j]]
        if (lv >= target) continue
        if (lv + c.vs[j] >= target) n++
        sum += Math.min(c.vs[j], target - lv)
      }
      if (n === 0) {
        if (sum === 0) c.live = false
        continue
      }
      if (n > bestN || (n === bestN && sum > bestSum)) {
        best = c
        bestN = n
        bestSum = sum
      }
    }
    if (!best) break
    best.live = false
    const gx = x0 + best.x
    const gz = z0 + best.z
    const tint = tintAt(gx, gz)
    map.setLamp(gx, cy, gz, true, tint ?? undefined)
    chunks.set(best.d, chunks.get(best.d) + 1)
    lamp[best.z * W + best.x] = 1
    for (let j = 0; j < best.ks.length; j++) level[best.ks[j]] = Math.min(1.5, level[best.ks[j]] + best.vs[j])
    for (const c of cands) if (c.live && Math.max(Math.abs(c.x - best.x), Math.abs(c.z - best.z)) <= 1) c.live = false
    hung++
  }
  return hung
}
