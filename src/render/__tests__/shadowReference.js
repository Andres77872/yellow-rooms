import { CELL, WALL_H } from '../../world/constants.js'

// Brute-force / Monte Carlo oracles for the analytic shadow maths in
// ../shadowMath.js (engine-improvement chapter 14, P1 item 7).
//
// Contract:
//   * Deterministic: stratified sample grids, and a seeded PRNG (makeRng)
//     wherever jitter is used — never Math.random — so a failing assertion
//     reproduces bit for bit.
//   * Independent of the twins: every oracle traces the actual geometry
//     (ray-box slabs, segment-capsule distance, ray-plane hits, sampled
//     doorway crossings) with its own code, so a shared bug cannot cancel out.
//   * Unoccluded configurations return exactly 1 (visibility) / 0 (occlusion),
//     and fully covered ones exactly the opposite.
//   * THREE-free; positions are [x, y, z] arrays in metres.

// mulberry32: small, fast, well-distributed 32-bit PRNG. Returns [0, 1).
export function makeRng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// --- Geometry primitives --------------------------------------------------------

// Slab test of the segment P -> Q against the AABB [lo, hi].
export function segmentHitsBox(P, Q, lo, hi) {
  let t0 = 0
  let t1 = 1
  for (let a = 0; a < 3; a++) {
    const d = Q[a] - P[a]
    if (Math.abs(d) < 1e-12) {
      if (P[a] < lo[a] || P[a] > hi[a]) return false
      continue
    }
    let ta = (lo[a] - P[a]) / d
    let tb = (hi[a] - P[a]) / d
    if (ta > tb) [ta, tb] = [tb, ta]
    t0 = Math.max(t0, ta)
    t1 = Math.min(t1, tb)
    if (t0 > t1) return false
  }
  return true
}

// Entry distance of the ray P + t dir (t >= 0) into the AABB, or Infinity.
export function rayBoxDistance(P, dir, lo, hi) {
  let t0 = 0
  let t1 = Infinity
  for (let a = 0; a < 3; a++) {
    if (Math.abs(dir[a]) < 1e-12) {
      if (P[a] < lo[a] || P[a] > hi[a]) return Infinity
      continue
    }
    let ta = (lo[a] - P[a]) / dir[a]
    let tb = (hi[a] - P[a]) / dir[a]
    if (ta > tb) [ta, tb] = [tb, ta]
    t0 = Math.max(t0, ta)
    t1 = Math.min(t1, tb)
    if (t0 > t1) return Infinity
  }
  return t0
}

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

// Distance from point X to segment a -> b.
function pointSegmentDistance(X, a, b) {
  const ab = sub3(b, a)
  const l2 = dot3(ab, ab)
  const t = l2 > 0 ? Math.min(Math.max(dot3(sub3(X, a), ab) / l2, 0), 1) : 0
  return dist3(X, lerp3(a, b, t))
}

// Minimum distance between segments p1 -> q1 and p2 -> q2. Written as the
// minimum over candidates (the interior stationary point when it exists, and
// the four endpoint-to-segment distances) — deliberately a different method
// from shadowMath.segSegClosest.
export function segmentSegmentDistance(p1, q1, p2, q2) {
  let best = Math.min(
    pointSegmentDistance(p1, p2, q2),
    pointSegmentDistance(q1, p2, q2),
    pointSegmentDistance(p2, p1, q1),
    pointSegmentDistance(q2, p1, q1),
  )
  const d1 = sub3(q1, p1)
  const d2 = sub3(q2, p2)
  const r = sub3(p1, p2)
  const a = dot3(d1, d1)
  const e = dot3(d2, d2)
  const b = dot3(d1, d2)
  const c = dot3(d1, r)
  const f = dot3(d2, r)
  const den = a * e - b * b
  if (den > 1e-12 * a * e) {
    const s = (b * f - c * e) / den
    const t = (a * f - b * c) / den
    if (s >= 0 && s <= 1 && t >= 0 && t <= 1) best = Math.min(best, dist3(lerp3(p1, q1, s), lerp3(p2, q2, t)))
  }
  return best
}

// Does the segment P -> Q pass through the capsule {a, b, r}?
export const segmentHitsCapsule = (P, Q, cap) => segmentSegmentDistance(P, Q, cap.a, cap.b) < cap.r

// Does the XZ segment p -> q ([x, z]) cross the square |x - c.x|, |z - c.z| <= half?
export function segmentHitsSquare(p, q, ctr, half) {
  let t0 = 0
  let t1 = 1
  for (let a = 0; a < 2; a++) {
    const d = q[a] - p[a]
    const lo = ctr[a] - half
    const hi = ctr[a] + half
    if (Math.abs(d) < 1e-12) {
      if (p[a] < lo || p[a] > hi) return false
      continue
    }
    let ta = (lo - p[a]) / d
    let tb = (hi - p[a]) / d
    if (ta > tb) [ta, tb] = [tb, ta]
    t0 = Math.max(t0, ta)
    t1 = Math.min(t1, tb)
    if (t0 > t1) return false
  }
  return true
}

// --- Area-light visibility -----------------------------------------------------

// Visibility of a horizontal rectangular emitter (centre L, half extents
// H = [hx, hz] along world X/Z, at height L.y) from P: the mean over an
// n x n stratified grid of samples Q of 1 - occludes(Q). occludes(Q) tests
// the segment P -> Q and returns true/1 (blocked), false/0 (open) or a
// fraction (partial transmission, e.g. glazing). To trace the world grid,
// pass Q => 1 - grid.segment(P[0], P[1], P[2], Q[0], Q[1], Q[2]).
// Without a seed the samples are the cell centres. With a seed each sample is
// jittered inside its cell: box and wall edges project to axis-aligned lines
// on the emitter, where centre sampling errs systematically by up to 0.5/n
// per edge, while jitter turns that into zero-mean noise ~n^-1.5.
export function areaLightMC(P, L, H, occludes, n, seed = null) {
  const rng = seed === null ? null : makeRng(seed)
  let vis = 0
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const ji = rng ? rng() : 0.5
      const jj = rng ? rng() : 0.5
      const Q = [L[0] - H[0] + (2 * H[0] * (i + ji)) / n, L[1], L[2] - H[1] + (2 * H[1] * (j + jj)) / n]
      vis += 1 - Number(occludes(Q))
    }
  }
  return vis / (n * n)
}

// Occluded fraction of the emitter by one AABB (the boxCover oracle).
export const boxCoverMC = (P, L, H, lo, hi, n, seed = null) =>
  1 - areaLightMC(P, L, H, (Q) => segmentHitsBox(P, Q, lo, hi), n, seed)

// Visibility through a column (full-height square) of an area light: the
// column is vertical and spans the storey, so the 3D segment is blocked iff
// its XZ projection crosses the square.
export const columnAreaMC = (P, L, H, ctr, half, n, seed = null) =>
  areaLightMC(P, L, H, (Q) => segmentHitsSquare([P[0], P[2]], [Q[0], Q[2]], ctr, half), n, seed)

// --- Cap / capsule oracles --------------------------------------------------------

// Fraction of a light cap (half-angle aL around +z) covered by an occluder cap
// (half-angle aO, axis tilted by beta in the xz plane), uniform over the light
// cap's solid angle. n samples are stratified in (cos theta, phi) with seeded
// jitter.
export function capOcclusionMC(aL, aO, beta, n, seed) {
  const rng = makeRng(seed)
  const m = Math.max(1, Math.floor(Math.sqrt(n)))
  const ox = Math.sin(beta)
  const oz = Math.cos(beta)
  const cosO = Math.cos(aO)
  const cosL = Math.cos(aL)
  let hit = 0
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < m; j++) {
      const cz = 1 - ((i + rng()) / m) * (1 - cosL)
      const ph = ((j + rng()) / m) * 2 * Math.PI
      const sz = Math.sqrt(Math.max(0, 1 - cz * cz))
      if (sz * Math.cos(ph) * ox + cz * oz >= cosO) hit++
    }
  }
  return hit / (m * m)
}

// Visibility of a disk light of radius lightR centred at Lp from P, through
// capsules {a, b, r}. The disk faces P by default (the silhouette of a sphere
// light, whose angular radius atan(lightR / |Lp - P|) is exactly the cap the
// analytic model uses); pass `normal` (e.g. [0, -1, 0]) for a fixed disk.
// n x n stratified polar samples (equal-area rings).
export function capsuleVisibilityMC(P, Lp, lightR, caps, n, normal = null) {
  let nz = normal ?? sub3(P, Lp)
  const nl = Math.hypot(nz[0], nz[1], nz[2])
  nz = [nz[0] / nl, nz[1] / nl, nz[2] / nl]
  const ref = Math.abs(nz[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
  let tx = [ref[1] * nz[2] - ref[2] * nz[1], ref[2] * nz[0] - ref[0] * nz[2], ref[0] * nz[1] - ref[1] * nz[0]]
  const tl = Math.hypot(tx[0], tx[1], tx[2])
  tx = [tx[0] / tl, tx[1] / tl, tx[2] / tl]
  const ty = [nz[1] * tx[2] - nz[2] * tx[1], nz[2] * tx[0] - nz[0] * tx[2], nz[0] * tx[1] - nz[1] * tx[0]]
  let vis = 0
  for (let i = 0; i < n; i++) {
    const r = lightR * Math.sqrt((i + 0.5) / n)
    for (let j = 0; j < n; j++) {
      const ph = (2 * Math.PI * (j + 0.5 * (i & 1) + 0.5)) / n
      const x = r * Math.cos(ph)
      const y = r * Math.sin(ph)
      const Q = [Lp[0] + tx[0] * x + ty[0] * y, Lp[1] + tx[1] * x + ty[1] * y, Lp[2] + tx[2] * x + ty[2] * y]
      let blocked = false
      for (let k = 0; k < caps.length && !blocked; k++) blocked = segmentHitsCapsule(P, Q, caps[k])
      if (!blocked) vis++
    }
  }
  return vis / (n * n)
}

// --- Cosine-weighted AO oracle ------------------------------------------------------

// Finite-radius cosine-weighted occlusion of receiver (P, N): the fraction of
// cosine-weighted directions whose first hit, occluderTest(P, dir) -> distance
// (Infinity for a miss), lies within R (Infinity = unbounded radius). Directions come from Malley's method
// over an m x m jittered grid on the unit disk (m = floor(sqrt(n))), so the
// estimate of the covered disk area converges far faster than plain MC.
export function cosineAO_MC(P, N, occluderTest, R, n, seed) {
  const rng = makeRng(seed)
  const m = Math.max(1, Math.floor(Math.sqrt(n)))
  const ref = Math.abs(N[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
  let t = [N[1] * ref[2] - N[2] * ref[1], N[2] * ref[0] - N[0] * ref[2], N[0] * ref[1] - N[1] * ref[0]]
  const tl = Math.hypot(t[0], t[1], t[2])
  t = [t[0] / tl, t[1] / tl, t[2] / tl]
  const b = [N[1] * t[2] - N[2] * t[1], N[2] * t[0] - N[0] * t[2], N[0] * t[1] - N[1] * t[0]]
  let occ = 0
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < m; j++) {
      const rho = Math.sqrt((i + rng()) / m)
      const ph = ((j + rng()) / m) * 2 * Math.PI
      const x = rho * Math.cos(ph)
      const y = rho * Math.sin(ph)
      const z = Math.sqrt(Math.max(0, 1 - rho * rho))
      const dir = [t[0] * x + b[0] * y + N[0] * z, t[1] * x + b[1] * y + N[1] * z, t[2] * x + b[2] * y + N[2] * z]
      const hit = occluderTest(P, dir)
      if (Number.isFinite(hit) && hit <= R) occ++ // R may be Infinity (unbounded AO)
    }
  }
  return occ / (m * m)
}

// Occluder tests for cosineAO_MC. Each returns the nearest hit distance along
// the ray P + t dir, or Infinity.

// AABBs [{lo, hi}].
export const boxOccluder = (boxes) => (P, dir) => {
  let best = Infinity
  for (const bx of boxes) best = Math.min(best, rayBoxDistance(P, dir, bx.lo, bx.hi))
  return best
}

// Axis-aligned rectangles [{axis, pos, lo: [x,y,z], hi: [x,y,z]}]: the plane
// coord[axis] = pos, bounded by lo/hi on the two other axes (the axis
// component of lo/hi is ignored). Use +-1e6 for an unbounded direction.
export const rectOccluder = (rects) => (P, dir) => {
  let best = Infinity
  for (const r of rects) {
    const d = dir[r.axis]
    if (Math.abs(d) < 1e-12) continue
    const t = (r.pos - P[r.axis]) / d
    if (t <= 0 || t >= best) continue
    let inside = true
    for (let a = 0; a < 3 && inside; a++) {
      if (a === r.axis) continue
      const x = P[a] + dir[a] * t
      inside = x >= r.lo[a] && x <= r.hi[a]
    }
    if (inside) best = t
  }
  return best
}

// Spheres / capsules [{a, b, r}] (a === b for a sphere): nearest entry
// distance, found analytically on the infinite cylinder and the end spheres.
export const capsuleOccluder = (caps) => (P, dir) => {
  let best = Infinity
  for (const c of caps) best = Math.min(best, rayCapsuleDistance(P, dir, c))
  return best
}

function raySphereDistance(P, dir, C, r) {
  const oc = sub3(P, C)
  const b = dot3(oc, dir)
  const c = dot3(oc, oc) - r * r
  if (c <= 0) return 0
  const disc = b * b - c
  if (disc < 0) return Infinity
  const t = -b - Math.sqrt(disc)
  return t >= 0 ? t : Infinity
}

function rayCapsuleDistance(P, dir, cap) {
  let best = Math.min(raySphereDistance(P, dir, cap.a, cap.r), raySphereDistance(P, dir, cap.b, cap.r))
  const ab = sub3(cap.b, cap.a)
  const l2 = dot3(ab, ab)
  if (l2 < 1e-12) return best
  // cylinder: |(X - a) - ((X - a).ab / l2) ab| = r, with the foot inside [0, 1]
  const ao = sub3(P, cap.a)
  const abd = dot3(ab, dir)
  const abo = dot3(ab, ao)
  const A = l2 - abd * abd
  const B = l2 * dot3(ao, dir) - abo * abd
  const C = l2 * dot3(ao, ao) - abo * abo - cap.r * cap.r * l2
  if (A > 1e-12) {
    const disc = B * B - A * C
    if (disc >= 0) {
      const t = (-B - Math.sqrt(disc)) / A
      const foot = (abo + t * abd) / l2
      if (t >= 0 && foot >= 0 && foot <= 1) best = Math.min(best, t)
    }
  }
  return best
}

// --- Doorway oracle ------------------------------------------------------------------

// Brute-force visibility of the emitter (L, H) from P through ONE wall line —
// axis 0: the line x = line (along = z); axis 1: z = line (along = x) — whose
// cells are described by codeAt(alongCentre) -> [yLo, yHi, t, jambInset] | null
// (shadowMath.EDGE_INTERVALS shape; a missing jambInset reads as 0). Every
// emitter sample is traced as a straight segment; where it crosses the line,
// the crossing's cell, floor-local height and (with jambs) its position
// inside the cell decide whether it passes. Samples that do not cross the
// line pass. Heights are floor-local.
export function doorwayMC(P, L, H, axis, line, codeAt, n, jambs, seed = null) {
  const c = axis === 0 ? 0 : 2
  const al = axis === 0 ? 2 : 0
  return areaLightMC(
    P,
    L,
    H,
    (Q) => {
      const s = (line - P[c]) / (Q[c] - P[c])
      if (!(s > 0 && s < 1)) return false
      const along = P[al] + (Q[al] - P[al]) * s
      const y = P[1] + (Q[1] - P[1]) * s
      if (y < 0 || y > WALL_H) return true
      const cell = Math.floor(along / CELL)
      const o = codeAt((cell + 0.5) * CELL)
      if (o === null) return true
      if (jambs) {
        const local = along - cell * CELL
        const inset = o[3] ?? 0
        if (local < inset || local > CELL - inset) return true
      }
      return y >= o[0] && y <= o[1] ? 1 - o[2] : true
    },
    n,
    seed,
  )
}
