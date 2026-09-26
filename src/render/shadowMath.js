import { CELL, COL_HALF, FRAME_W, MONUMENTAL_COL_HALF, WALL_H } from '../world/constants.js'
import {
  EDGE_DOOR,
  EDGE_OPENINGS,
  EDGE_WALL,
  FLAG_COLUMN,
  FLAG_PIER,
  OCC_UNIT_XZ,
  OCC_UNIT_Y,
} from '../world/lightGrid/gridSpec.js'

// Analytic shadow and occlusion maths: the JS twins of the GLSL written for
// engine-improvement chapter 14 (P5 grid penumbra, P7 capsules, P9 furniture
// boxes, P10 crease AO, P13 box AO).
//
// Contract:
//   * Every exported function mirrors the shader function of the same name
//     with a leading 'g' (boxCover <-> gBoxCover, posLin <-> gPosLin,
//     clampLenInt <-> gClampLenInt, overlap <-> gOverlap, edgeFF <-> gEdgeFF,
//     quadFF <-> gQuadFF, boxFF <-> gBoxFF, ...). Where the shader uses
//     another name the pair is:
//       shaders/grid.js      creaseWedge <-> gWedge, openingWindow <->
//                            gOpening, cellOpen <-> gCellSpan * gOpening,
//                            lineOpen <-> gLineOpen, footprintOpen <-> one
//                            crossing of gTraceRay, footprintOpenSub <->
//                            gridTrace's sub-ray loop, columnVisibility <->
//                            gColumnSq, columnFaces <-> gColumnFaces,
//                            creaseCornerColumns <-> the column block of
//                            gCreaseCorner, boxFormFactorAxis <-> gBoxFF
//                            with N = sign * e_axis, boxBeside <->
//                            gBoxBeside;
//       shaders/lighting.js  capOccluded <-> capOccluded, capsuleVisibility
//                            <-> capsuleShadow (its inner capsule loop; the
//                            bound-sphere cull and the entity-pixel skips are
//                            shader-only), segSegClosest <-> the closest-
//                            point block inside it, capsuleAO <-> capsuleAO.
//     A change on either side is mirrored on the other and re-validated
//     against the oracles in __tests__/shadowReference.js by
//     __tests__/shadow-math.test.js.
//   * THREE-free and pure: numbers and plain [x, y, z] / [x, z] arrays in,
//     numbers out. The wall-line functions take codeAt(alongCentre) -> an
//     EDGE_INTERVALS entry, the stand-in for the shader's edge-texel fetch.
//   * The mirrored functions are line-for-line portable to GLSL ES 3.00: no
//     recursion, no closures, no array methods, only small fixed-trip loops,
//     and the same early-outs and branch structure. Array indexing ([0], [1],
//     [2]) maps to .x/.y/.z; capsule/plane lists map to uniform arrays or
//     fetched cells.
//   * World units are metres. The wall-line functions work in floor-local
//     heights (0 = the storey's floor surface), like gOpening/gLineOpen.

const clamp = (x, a, b) => Math.min(Math.max(x, a), b)
const sat = (x) => clamp(x, 0, 1)
const smoothstep = (e0, e1, x) => {
  const t = sat((x - e0) / (e1 - e0))
  return t * t * (3 - 2 * t)
}

// --- P9: furniture boxes vs the fixture panel (gBoxCover) --------------------

// Integral of max(0, f) over an interval of length `len` on which f is linear
// with end values fa, fb. A sign change is handled by the zero crossing, so
// the result is exact for any linear f.
export function posLin(fa, fb, len) {
  if (len <= 0) return 0
  if (fa >= 0 && fb >= 0) return 0.5 * (fa + fb) * len
  if (fa <= 0 && fb <= 0) return 0
  const m = Math.max(fa, fb)
  return (len * m * m) / (2 * Math.abs(fa - fb))
}

// Length of the clamped interval [max(c + e0 u, lo), min(c + e1 u, hi)] at u
// (may be negative: posLin keeps only the positive part).
export function clampLenAt(c, e0, e1, lo, hi, u) {
  return Math.min(c + e1 * u, hi) - Math.max(c + e0 * u, lo)
}

// Integral over u in [ua, ub] of max(0, min(c + e1 u, hi) - max(c + e0 u, lo)).
// The integrand is piecewise linear with kinks only where either clamp
// engages, so splitting there and integrating each linear piece with posLin
// is exact. `c` is shared by both bounds: the two rays through the receiver
// start at the same point, which is what makes the GLSL signature compact.
export function clampLenInt(c, e0, e1, lo, hi, ua, ub) {
  if (ub <= ua) return 0
  const k0 = clamp(Math.abs(e0) > 1e-9 ? (lo - c) / e0 : ua, ua, ub)
  const k1 = clamp(Math.abs(e1) > 1e-9 ? (hi - c) / e1 : ua, ua, ub)
  const a = Math.min(k0, k1)
  const b = Math.max(k0, k1)
  const fA = clampLenAt(c, e0, e1, lo, hi, ua)
  const f0 = clampLenAt(c, e0, e1, lo, hi, a)
  const f1 = clampLenAt(c, e0, e1, lo, hi, b)
  const fB = clampLenAt(c, e0, e1, lo, hi, ub)
  return posLin(fA, f0, a - ua) + posLin(f0, f1, b - a) + posLin(f1, fB, ub - b)
}

// Overlap length of [a0, a1] and [b0, b1] (a0 <= a1, b0 <= b1).
export function overlap(a0, a1, b0, b1) {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))
}

// Occluded fraction of a horizontal rectangular emitter (centre L, half
// extents H = [hx, hz] along world X/Z, facing down at height L.y) seen from
// receiver P, by the AABB [lo, hi]. The box's central projection from P onto
// the emitter plane is tiled exactly by the images of the faces that face P:
// the bottom face (clipped 1 mm above P, so a receiver beside the box sees the
// part above it) plus at most one x face and one z face. The bottom face
// projects to an axis-aligned rectangle; each vertical face is integrated in
// closed form with u = (emitter height above P) / (face height above P).
// Floors and walls beside or under a proxy never skip it (lighting.js; only
// furniture pixels skip their own), so this must hold right down to a face:
// k is non-zero by the strict tests below, the integration limits are
// clamped to [s1, s0], and only the strip of face within the clip above P is
// lost (rays toward a far lamp that meet it: receivers within about
// 1 mm x run / rise of the face). The clip was 5 mm, which left a
// half-covered band up to 1.3 cm wide at the foot of a proxy's shadowed
// side; s0 stays below ~3000, well inside fp32. A receiver inside the box is
// fully covered, as inside a solid proxy it is.
export function boxCover(P, L, H, lo, hi) {
  const dy = L[1] - P[1]
  // A box whose top is within the 1 mm clip above P hides nothing: the clipped
  // box is empty (the plan's `P.y >= hi.y` early-out would still count its
  // inverted bottom face).
  if (dy < 0.05 || P[1] >= hi[1] - 0.001) return 0
  const y0 = Math.max(lo[1], P[1] + 0.001)
  const s0 = dy / (y0 - P[1]) // scale of the bottom face (largest)
  const s1 = dy / (hi[1] - P[1]) // scale of the top edge (smallest)
  const cx = P[0]
  const cz = P[2]
  const px0 = L[0] - H[0]
  const pz0 = L[2] - H[1]
  const px1 = L[0] + H[0]
  const pz1 = L[2] + H[1]
  let A =
    overlap(cx + (lo[0] - cx) * s0, cx + (hi[0] - cx) * s0, px0, px1) *
    overlap(cz + (lo[2] - cz) * s0, cz + (hi[2] - cz) * s0, pz0, pz1)
  if (P[0] < lo[0] || P[0] > hi[0]) {
    // x face: X = cx + k u, Z spans [cz + (lo.z - cz) u, cz + (hi.z - cz) u]
    const k = (P[0] < lo[0] ? lo[0] : hi[0]) - cx
    const uA = (px0 - cx) / k
    const uB = (px1 - cx) / k
    const ua = Math.max(s1, Math.min(uA, uB))
    const ub = Math.min(s0, Math.max(uA, uB))
    A += Math.abs(k) * clampLenInt(cz, lo[2] - cz, hi[2] - cz, pz0, pz1, ua, ub)
  }
  if (P[2] < lo[2] || P[2] > hi[2]) {
    // z face: the same with the roles of x and z swapped
    const k = (P[2] < lo[2] ? lo[2] : hi[2]) - cz
    const uA = (pz0 - cz) / k
    const uB = (pz1 - cz) / k
    const ua = Math.max(s1, Math.min(uA, uB))
    const ub = Math.min(s0, Math.max(uA, uB))
    A += Math.abs(k) * clampLenInt(cx, lo[0] - cx, hi[0] - cx, px0, px1, ua, ub)
  }
  return clamp(A / (4 * H[0] * H[1]), 0, 1)
}

// --- P7: capsule soft shadows and capsule AO -----------------------------------

// Share of the light cap (half-angle aL) that a cap of half-angle aO can cover
// at most: the solid-angle ratio (1 - cos min(aL, aO)) / (1 - cos aL), written
// as sin^2(aO/2) / sin^2(aL/2) (1 - cos x = 2 sin^2(x/2)) and clamped to 1.
// The 1 - cos form cancels catastrophically for small caps — in fp32 for
// aL < ~1e-3 rad, and its 1e-6 floor in any precision — so a torch of radius
// 2 cm seen from 20 m (aL = 1e-3) had half its shadow vanish and a point light
// (aL = 0) none at all. This form is exact down to aL = 0.
export function capRatio(aL, aO) {
  const sO = Math.sin(0.5 * aO)
  const sL = Math.sin(0.5 * aL)
  return Math.min(1, (sO * sO) / Math.max(sL * sL, 1e-12))
}

// Oat & Sander cap-cap intersection, smoothstep form: the fraction of a light
// cap (half-angle aL) covered by an occluder cap (half-angle aO) whose axis is
// beta away. Exact at full overlap and full separation; the smoothstep stands
// in for the lens-area integral in between.
export function capOccluded(aL, aO, beta) {
  const dA = Math.abs(aL - aO)
  const t = 1 - clamp((beta - dA) / Math.max(aL + aO - dA, 1e-4), 0, 1)
  return capRatio(aL, aO) * smoothstep(0, 1, t)
}

// Drop-in refinement of capOccluded (same inputs, one acos + sqrt more).
// With x = (beta - |aL - aO|) / (aL + aO - |aL - aO|) the smoothstep is the
// right profile for caps of very different sizes (a small disc crossing a big
// one's edge: the circular-segment curve), but equal caps overlap as a lens,
// (2/pi)(acos x - x sqrt(1 - x^2)), where the smoothstep is 0.15 too high.
// Blending the two by the size ratio min/max cuts the error against
// capOcclusionMC about 5x (mean 0.004, p90 0.013, max 0.036). Recommended for
// true sphere/cone caps (e.g. the ultra directional capsule term) and, with
// the three-sphere capsuleVisibility, for capsules too (its `lens` switch).
export function capOccludedLens(aL, aO, beta) {
  const m = Math.min(aL, aO)
  const dA = Math.abs(aL - aO)
  const x = clamp((beta - dA) / Math.max(aL + aO - dA, 1e-4), 0, 1)
  const t = 1 - x
  const seg = t * t * (3 - 2 * t)
  const lens = (2 / Math.PI) * (Math.acos(x) - x * Math.sqrt(1 - x * x))
  const f = seg + (lens - seg) * (m / Math.max(aL, aO, 1e-6))
  return capRatio(aL, aO) * f
}

// Closest points between segments p1 -> q1 and p2 -> q2 (Ericson, Real-Time
// Collision Detection 5.1.9), written as the block inside lighting.js
// capsuleShadow. Returns [s, t]: the parameters on the first and second
// segment. |q1 - p1| must be > 0 (capsuleVisibility returns before that). A
// zero-length second segment (a sphere) needs no branch: e is floored at
// 1e-6, which leaves t = 0 and s = the sphere centre's projection. The
// near-parallel test is RELATIVE (sin^2 of the angle < 1e-6, i.e. < 1 mrad):
// an absolute `den > 1e-6` switches branch with the segments' lengths, and
// anything below ~1e-7 a e is fp32 cancellation noise. That branch takes
// s = 0 and lets the clamps below pick the matching t, which is exact for
// parallel segments.
export function segSegClosest(p1, q1, p2, q2) {
  const d1x = q1[0] - p1[0]
  const d1y = q1[1] - p1[1]
  const d1z = q1[2] - p1[2]
  const d2x = q2[0] - p2[0]
  const d2y = q2[1] - p2[1]
  const d2z = q2[2] - p2[2]
  const rx = p1[0] - p2[0]
  const ry = p1[1] - p2[1]
  const rz = p1[2] - p2[2]
  const a = d1x * d1x + d1y * d1y + d1z * d1z
  const e = Math.max(d2x * d2x + d2y * d2y + d2z * d2z, 1e-6)
  const f = d2x * rx + d2y * ry + d2z * rz
  const c = d1x * rx + d1y * ry + d1z * rz
  const b = d1x * d2x + d1y * d2y + d1z * d2z
  const den = a * e - b * b
  let s = den > 1e-6 * a * e ? clamp((b * f - c * e) / den, 0, 1) : 0
  let t = (b * s + f) / e
  if (t < 0) {
    t = 0
    s = clamp(-c / a, 0, 1)
  } else if (t > 1) {
    t = 1
    s = clamp((b - c) / a, 0, 1)
  }
  return [s, t]
}

// Occlusion of the light cap (half-angle aL around the unit direction Ld, the
// light len away) by the sphere of radius r whose centre is at v relative to
// the receiver; 0 when the centre lies within 5 cm of, or beyond, the light
// along the ray (the light is inside or in front of it). `lens` picks
// capOccludedLens over capOccluded (a compile-time switch in GLSL).
export function sphereCapOccluded(vx, vy, vz, ldx, ldy, ldz, len, aL, r, lens) {
  const along = vx * ldx + vy * ldy + vz * ldz
  if (along > len - 0.05) return 0
  const dist = Math.max(Math.hypot(vx, vy, vz), 1e-4)
  const aO = Math.asin(Math.min(r / dist, 1))
  const beta = Math.acos(clamp(along / dist, -1, 1))
  return lens ? capOccludedLens(aL, aO, beta) : capOccluded(aL, aO, beta)
}

// Soft shadow of capsules {a: [x,y,z], b: [x,y,z], r} on receiver P from a
// light of radius lightR at Lp (a sphere/disk facing P: the light cap has
// half-angle atan(lightR / len)). Each capsule is stood in for by three of
// its inscribed spheres (radius r on the axis), and the one that covers the
// most of the light cap counts:
//   (a) the sphere at the axis point closest to the P -> Lp segment (the
//       plan's choice: right for a capsule crossing the ray);
//   (b), (c) the spheres at the two ends. (a) alone fails when the lamp is
//       overhead or near the capsule: inside the disc whose diameter runs
//       from the lamp's foot to the capsule axis, the axis projects behind
//       P, s clamps to 0 and (a) picks the foot beside the ray — no shadow
//       (1.0 where the disk MC reads 0.82) and a 0.2 step across the lamp's
//       foot — while the sphere that covers the light is the FAR end. And
//       (a) is discontinuous by nature: for a ray parallel to the axis every
//       axis point is equally close, and the choice flips from one end to
//       the other as the ray tilts through parallel (a 0.1 seam through
//       every lamp's foot on the shipped tables). With both ends always in
//       the candidate set the flip changes nothing: max() of the candidates
//       is continuous.
// The sphere at the axis point angularly closest to Ld, the other natural
// candidate, adds nothing once the ends are in: never more than 0.01 of
// occlusion over 20000 random capsules. All candidates lie inside the
// capsule, so the largest occlusion is still a lower bound up to the cap
// formula's own bias. K scales the darkening (uCapsuleK). `lens` (default
// false: the plan's smoothstep, as lighting.js has it) evaluates the caps
// with capOccludedLens: with several spheres the smoothstep's over-estimate
// offsets less, and on the shipped enemy tables the lens blend cuts the mean
// error by 25-40 % and the worst case by 20-50 % (see the test) for one
// acos + sqrt more per sphere. Capsules are combined as a product, which
// counts the overlap of overlapping capsules twice (over-darkening where
// torso and legs overlap in the light cap). There is deliberately no "near
// the feet" guard: the candidate spheres tend to the contact solution as P
// approaches the capsule, which grounds an enemy (the old `along < r + 0.15`
// cut left a gap there).
export function capsuleVisibility(P, Lp, lightR, caps, K, lens = false) {
  const dx = Lp[0] - P[0]
  const dy = Lp[1] - P[1]
  const dz = Lp[2] - P[2]
  const len = Math.hypot(dx, dy, dz)
  if (len < 1e-4) return 1
  const ldx = dx / len
  const ldy = dy / len
  const ldz = dz / len
  const aL = Math.atan(lightR / Math.max(len, 1e-3))
  let vis = 1
  for (let i = 0; i < caps.length; i++) {
    const cap = caps[i]
    const wx = cap.a[0] - P[0]
    const wy = cap.a[1] - P[1]
    const wz = cap.a[2] - P[2]
    const Dx = cap.b[0] - cap.a[0]
    const Dy = cap.b[1] - cap.a[1]
    const Dz = cap.b[2] - cap.a[2]
    const t = segSegClosest(P, Lp, cap.a, cap.b)[1]
    let occ = sphereCapOccluded(wx + Dx * t, wy + Dy * t, wz + Dz * t, ldx, ldy, ldz, len, aL, cap.r, lens)
    occ = Math.max(occ, sphereCapOccluded(wx, wy, wz, ldx, ldy, ldz, len, aL, cap.r, lens))
    occ = Math.max(occ, sphereCapOccluded(wx + Dx, wy + Dy, wz + Dz, ldx, ldy, ldz, len, aL, cap.r, lens))
    vis *= 1 - K * occ
  }
  return vis
}

// Capsule ambient occlusion (Quilez sphere occlusion along the axis): the
// sphere of radius r at the axis point closest to P, cosine weighted, faded
// out between 3r and 6r. Exact form factor for a sphere wholly above P's
// horizon (a sphere touching P along N gives exactly 1). Each term is capped
// at 1 — not in the plan's formula, and the same cap as lighting.js
// capsuleAO — so a receiver inside a capsule (possible for skinned limbs)
// never drives the product negative; inside, occlusion then reaches 1 at
// cos(N, v) >= d^2 / r^2, as a receiver buried in the body should.
// Returns visibility: max(mix(1, prod(1 - occ), K), minVis).
export function capsuleAO(P, N, caps, K, minVis) {
  let ao = 1
  for (let i = 0; i < caps.length; i++) {
    const cap = caps[i]
    const abx = cap.b[0] - cap.a[0]
    const aby = cap.b[1] - cap.a[1]
    const abz = cap.b[2] - cap.a[2]
    const t = clamp(
      ((P[0] - cap.a[0]) * abx + (P[1] - cap.a[1]) * aby + (P[2] - cap.a[2]) * abz) /
        Math.max(abx * abx + aby * aby + abz * abz, 1e-6),
      0,
      1,
    )
    const vx = cap.a[0] + abx * t - P[0]
    const vy = cap.a[1] + aby * t - P[1]
    const vz = cap.a[2] + abz * t - P[2]
    const d = Math.max(Math.hypot(vx, vy, vz), 1e-4)
    const r = cap.r
    const occ = ((sat((N[0] * vx + N[1] * vy + N[2] * vz) / d) * r * r) / (d * d)) * (1 - smoothstep(3 * r, 6 * r, d))
    ao *= 1 - Math.min(occ, 1)
  }
  return Math.max(1 + (ao - 1) * K, minVis)
}

// --- P10: architectural crease AO -------------------------------------------------

// Cosine-weighted occlusion of a receiver by one perpendicular plane (Malley's
// method): cosine-weighted directions map uniformly onto the unit disk of the
// receiver's tangent plane, and the directions that reach the plane at
// distance d within the AO radius R, inside its extent [s0, s1] along the
// other tangent axis, form the wedge |phi| <= acos(d/R), rho >= d/(R cos phi).
// Its area over pi is 0.5 [phi - a^2 tan(phi)] / pi with a = d/R. Written in
// tan(phi) so neither tan() nor acos() is evaluated: tan(p0) = max(s0/d, -tl)
// with tl = tan(acos(a)) = sqrt(1 - a^2)/a, which is exact because tan is
// monotonic on the wedge. d is clamped to 1 mm: a receiver touching the plane
// is the half-disk limit (0.5 for an infinite plane), reached continuously.
export function creaseWedge(d, s0, s1, R) {
  const dd = Math.max(d, 1e-3)
  const a = dd / R
  if (a >= 1) return 0
  const tl = Math.sqrt(1 - a * a) / a
  const t0 = Math.max(s0 / dd, -tl)
  const t1 = Math.min(s1 / dd, tl)
  if (t1 <= t0) return 0
  return (0.5 * (Math.atan(t1) - a * a * t1 - (Math.atan(t0) - a * a * t0))) / Math.PI
}

// Index of the dominant component of N (0 x, 1 y, 2 z).
export function dominantAxis(N) {
  const ax = Math.abs(N[0])
  const ay = Math.abs(N[1])
  const az = Math.abs(N[2])
  return ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2
}

// Crease occlusion of an axis-aligned receiver (P, N) by perpendicular finite
// planes, summed and clamped to 1. Returns OCCLUSION (0 = open); the shader's
// gCreaseAO turns it into 1 - uCreaseK * weight * occ.
//
// Frame convention. Let n = dominantAxis(N); the receiver's tangent frame is
// the two remaining WORLD axes. Each plane is { axis, pos, lo, hi }:
//   axis    one of the two tangent axes: the plane is coord[axis] = pos
//           (a plane with axis === n is parallel to the receiver: ignored);
//   lo, hi  its extent along the other tangent axis t = 3 - n - axis, world
//           coordinates;
//   and it is unbounded along N from the receiver's surface outward (walls
//   rise from the floor and drop from the ceiling; a door header counts for a
//   ceiling receiver because it is at least R deep).
// So the wedge sees d = |pos - P[axis]|, s = [lo, hi] - P[t]. The sum is exact
// when the planes' direction sets are disjoint: clip wall segments at shared
// corners (a room corner is two segments that end at the corner), as the
// grid's cell-edge segments naturally are, and give a column only the faces
// that face P.
export function creaseAO(P, N, planes, R) {
  const n = dominantAxis(N)
  let occ = 0
  for (let i = 0; i < planes.length; i++) {
    const pl = planes[i]
    if (pl.axis === n) continue
    const t = 3 - n - pl.axis
    occ += creaseWedge(Math.abs(pl.pos - P[pl.axis]), pl.lo - P[t], pl.hi - P[t], R)
  }
  return Math.min(occ, 1)
}

// Faces of the column / pier of cell c = [cx, cz] (flag byte `flags`), seen
// from the floor or ceiling point p = [x, z]: at most two faces face p.
export function columnFaces(c, flags, p, R) {
  if ((flags & (FLAG_COLUMN | FLAG_PIER)) === 0) return 0
  const h = (flags & FLAG_PIER) !== 0 ? MONUMENTAL_COL_HALF : COL_HALF
  const rx = p[0] - (c[0] + 0.5) * CELL
  const rz = p[1] - (c[1] + 0.5) * CELL
  let occ = 0
  if (Math.abs(rx) > h) occ += creaseWedge(Math.abs(rx) - h, -h - rz, h - rz, R)
  if (Math.abs(rz) > h) occ += creaseWedge(Math.abs(rz) - h, -h - rx, h - rx, R)
  return occ
}

// Column block of gCreaseCorner: the columns of the four cells around the
// cell corner nearest p (world [x, z]). flagsAt(cx, cz) returns a cell's flag
// byte; closed = { xLo, xHi, zLo, zHi } are the four edge halves meeting at
// the corner, closed at the receiver's height (x-line below / above the
// corner in z, z-line below / above it in x), as gCreaseCorner reads them.
// P's own cell always counts; a neighbour only through an open edge path.
export function creaseCornerColumns(p, R, flagsAt, closed) {
  const kx = Math.floor(p[0] / CELL + 0.5)
  const kz = Math.floor(p[1] / CELL + 0.5)
  const loX = p[0] - kx * CELL < 0
  const loZ = p[1] - kz * CELL < 0
  const xNear = loZ ? closed.xLo : closed.xHi
  const xFar = loZ ? closed.xHi : closed.xLo
  const zNear = loX ? closed.zLo : closed.zHi
  const zFar = loX ? closed.zHi : closed.zLo
  const cell = (dx, dz) => [kx - dx, kz - dz]
  const at = (c) => flagsAt(c[0], c[1])
  const own = cell(loX ? 1 : 0, loZ ? 1 : 0)
  const nX = cell(loX ? 0 : 1, loZ ? 1 : 0)
  const nZ = cell(loX ? 1 : 0, loZ ? 0 : 1)
  const nD = cell(loX ? 0 : 1, loZ ? 0 : 1)
  let occ = columnFaces(own, at(own), p, R)
  if (!xNear) occ += columnFaces(nX, at(nX), p, R)
  if (!zNear) occ += columnFaces(nZ, at(nZ), p, R)
  if ((!xNear && !zFar) || (!zNear && !xFar)) occ += columnFaces(nD, at(nD), p, R)
  return occ
}

// --- P13: analytic box AO (Lambert polygon form factor) -------------------------

// One edge of Lambert's polygon formula: angle(a, b) * N . normalize(a x b),
// for unit vectors a, b ([x, y, z]) from the receiver. atan(|a x b|, a . b)
// instead of gEdgeFF's acos(a . b): the same angle, but accurate for the
// short edges of distant boxes in fp32 (acos loses them near a . b = 1).
export function edgeFF(a, b, N) {
  const cx = a[1] * b[2] - a[2] * b[1]
  const cy = a[2] * b[0] - a[0] * b[2]
  const cz = a[0] * b[1] - a[1] * b[0]
  const cl = Math.hypot(cx, cy, cz)
  if (cl < 1e-7) return 0
  return (Math.atan2(cl, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) * (N[0] * cx + N[1] * cy + N[2] * cz)) / cl
}

const unitFrom = (P, q) => {
  const x = q[0] - P[0]
  const y = q[1] - P[1]
  const z = q[2] - P[2]
  const il = 1 / Math.hypot(x, y, z)
  return [x * il, y * il, z * il]
}

// Signed Lambert integral (2 pi x the form factor) of the quad q0 q1 q2 q3
// seen from P. Only the corner order sets the sign (reversing it negates the
// result), so callers take abs() per face.
export function quadFF(P, N, q0, q1, q2, q3) {
  const a = unitFrom(P, q0)
  const b = unitFrom(P, q1)
  const c = unitFrom(P, q2)
  const d = unitFrom(P, q3)
  return edgeFF(a, b, N) + edgeFF(b, c, N) + edgeFF(c, d, N) + edgeFF(d, a, N)
}

// Cosine-weighted occlusion (unbounded radius) of the AABB [lo, hi] for an
// AXIS-ALIGNED receiver normal N. The box is first clipped to the receiver's
// positive half-space (still an AABB), so every corner is above the horizon
// and Lambert's formula applies without a horizon clamp; then the faces that
// face P (at most three) are summed. Each face term is taken in abs(): a
// convex face wholly above the horizon has a positive form factor, and only
// its winding decides the sign. Summing signed terms and taking abs() of the
// total (gBoxFF as first written, whose six corner lists do not share one
// orientation) cancels faces against each other: 0.027 instead of 0.408 for
// P = (0.46, 0.572, 1.767), N = -z, box (0.599, 0, 0.414)-(2.423, 1.507,
// 1.575). The unclipped horizon-clamp variant is wrong by up to 1.0 on
// straddling boxes and must not ship either.
export function boxFF(P, N, lo, hi) {
  const l = [lo[0], lo[1], lo[2]]
  const h = [hi[0], hi[1], hi[2]]
  if (Math.abs(N[0]) > 0.5) {
    if (N[0] > 0) l[0] = Math.max(l[0], P[0] + 1e-4)
    else h[0] = Math.min(h[0], P[0] - 1e-4)
  } else if (Math.abs(N[1]) > 0.5) {
    if (N[1] > 0) l[1] = Math.max(l[1], P[1] + 1e-4)
    else h[1] = Math.min(h[1], P[1] - 1e-4)
  } else if (N[2] > 0) l[2] = Math.max(l[2], P[2] + 1e-4)
  else h[2] = Math.min(h[2], P[2] - 1e-4)
  if (l[0] >= h[0] || l[1] >= h[1] || l[2] >= h[2]) return 0
  // corners as [x, y, z]; lx = l[0], hy = h[1], ...
  const lx = l[0]
  const ly = l[1]
  const lz = l[2]
  const hx = h[0]
  const hy = h[1]
  const hz = h[2]
  let F = 0
  if (P[0] < lx) F += Math.abs(quadFF(P, N, [lx, ly, lz], [lx, ly, hz], [lx, hy, hz], [lx, hy, lz]))
  if (P[0] > hx) F += Math.abs(quadFF(P, N, [hx, ly, lz], [hx, hy, lz], [hx, hy, hz], [hx, ly, hz]))
  if (P[1] < ly) F += Math.abs(quadFF(P, N, [lx, ly, lz], [hx, ly, lz], [hx, ly, hz], [lx, ly, hz]))
  if (P[1] > hy) F += Math.abs(quadFF(P, N, [lx, hy, lz], [lx, hy, hz], [hx, hy, hz], [hx, hy, lz]))
  if (P[2] < lz) F += Math.abs(quadFF(P, N, [lx, ly, lz], [lx, hy, lz], [hx, hy, lz], [hx, ly, lz]))
  if (P[2] > hz) F += Math.abs(quadFF(P, N, [lx, ly, hz], [hx, ly, hz], [hx, hy, hz], [lx, hy, hz]))
  return Math.min(F / (2 * Math.PI), 1)
}

// boxFF for the receiver normal sign * e_axis (the task's signature).
export function boxFormFactorAxis(P, axis, sign, lo, hi) {
  const N = [0, 0, 0]
  N[axis] = sign > 0 ? 1 : -1
  return boxFF(P, N, lo, hi)
}

// Proxies are quantised outward, up to one OCC_UNIT step per face (gridSpec
// packOccBox), so an architecture receiver right beside a rendered face can
// lie just inside its proxy, where boxCover and boxFF read full cover on
// every side of the piece: a hard dark line at the foot of each piece and on
// the wall beside wall-backed ones. When P is inside [lo, hi] by less than a
// step (plus 2 mm) through a face on one of its two tangent axes, the
// shallowest such face (depth over its axis's step) is moved 1 mm past P, so the receiver is shaded as the point beside the
// face it really is. Faces across the receiver's normal are left alone: the
// trace point sits a fixed offset off the surface along N (and a floor
// receiver always lies on or just above a floor-standing box's bottom), so
// depth along N says nothing about quantisation. A receiver deeper inside
// (the floor of a desk's knee hole) keeps the box whole. Returns [lo, hi]
// (new arrays; the shader's gBoxBeside edits them in place).
export function boxBeside(P, N, lo, hi) {
  const l = [lo[0], lo[1], lo[2]]
  const h = [hi[0], hi[1], hi[2]]
  if (P[0] < l[0] || P[1] < l[1] || P[2] < l[2] || P[0] > h[0] || P[1] > h[1] || P[2] > h[2]) return [l, h]
  // depth over the step, per face; the normal's axis never qualifies (added,
  // not scaled: P can lie exactly on a face across the normal)
  const k = [1 / (OCC_UNIT_XZ + 0.002), 1 / (OCC_UNIT_Y + 0.002), 1 / (OCC_UNIT_XZ + 0.002)]
  const e = [0, 0, 0]
  e[dominantAxis(N)] = 1e6
  const rl = [(P[0] - l[0]) * k[0] + e[0], (P[1] - l[1]) * k[1] + e[1], (P[2] - l[2]) * k[2] + e[2]]
  const rh = [(h[0] - P[0]) * k[0] + e[0], (h[1] - P[1]) * k[1] + e[1], (h[2] - P[2]) * k[2] + e[2]]
  // Only the shallowest face moves: within a step of two faces (the square at
  // a vertical edge) the proxy cannot tell which one P is really beside, and
  // moving both would cut the corner off.
  const m = Math.min(Math.min(Math.min(rl[0], rl[1]), rl[2]), Math.min(Math.min(rh[0], rh[1]), rh[2]))
  if (m >= 1) return [l, h]
  if (m === rl[0]) l[0] = P[0] + 0.001
  else if (m === rh[0]) h[0] = P[0] - 0.001
  else if (m === rl[1]) l[1] = P[1] + 0.001
  else if (m === rh[1]) h[1] = P[1] - 0.001
  else if (m === rl[2]) l[2] = P[2] + 0.001
  else h[2] = P[2] - 0.001
  return [l, h]
}

// --- P5: gridTrace v2 wall-line footprint -----------------------------------------

// Opening interval of each gridSpec edge code as [yLo, yHi, transmission,
// jambInset] (floor-local metres), or null for a solid wall. Only doors carry
// a jamb inset: the casing narrows the clear span to DOOR_OPENING_W. This is
// the shape the codeAt() callbacks below return (a 3-element [yLo, yHi, t]
// is accepted too: its inset reads as 0); the shader derives the same
// numbers from the edge code.
export const EDGE_INTERVALS = Object.freeze(
  EDGE_OPENINGS.map((o, code) =>
    code === EDGE_WALL ? null : Object.freeze([o.lo, o.hi, o.t, code === EDGE_DOOR ? FRAME_W : 0]),
  ),
)
export const edgeOpening = (code) => EDGE_INTERVALS[code] ?? null

// gOpening v2: fraction of the vertical window [y - wv/2, y + wv/2], clamped
// to the storey [0, WALL_H], that falls inside the opening, times its
// transmission. The clamp matters: the part of the window below the floor or
// above the ceiling cannot carry light either way, and counting it as blocked
// dimmed doorway spill by 30-40 %.
export function openingWindow(o, y, wv) {
  const lo = Math.max(y - 0.5 * wv, 0)
  const hi = Math.min(y + 0.5 * wv, WALL_H)
  return o[2] * clamp((Math.min(hi, o[1]) - Math.max(lo, o[0])) / Math.max(hi - lo, 1e-3), 0, 1)
}

// Share of the along-interval [a, b] (inside cell c of the line) that is open,
// times the vertical opening. With jambs, a door's clear span is the cell
// minus its jamb inset at each end (GPU only; the CPU bake keeps full cells).
export function cellOpen(o, c, a, b, y, wv, jambs) {
  if (o === null) return 0
  const inset = jambs ? (o[3] ?? 0) : 0
  const span = Math.max(0, Math.min(b, (c + 1) * CELL - inset) - Math.max(a, c * CELL + inset))
  return span * openingWindow(o, y, wv)
}

// gLineOpen v2: box-filtered openness of a wall line around a crossing at
// `along` (the coordinate along the line) and floor-local height y, over the
// footprint wA x wv. wA <= 0.9 CELL, so the footprint touches at most two
// cells, exactly like the shader's two edge fetches. codeAt(alongCentre)
// returns the opening interval of the cell whose centre is alongCentre
// (EDGE_INTERVALS shape, or null for a wall).
export function lineOpen(along, y, wA, wv, codeAt, jambs) {
  const s0 = along - 0.5 * wA
  const s1 = along + 0.5 * wA
  const c0 = Math.floor(s0 / CELL)
  const c1 = Math.floor(s1 / CELL)
  if (c1 === c0) return cellOpen(codeAt((c0 + 0.5) * CELL), c0, s0, s1, y, wv, jambs) / wA
  const split = c1 * CELL
  return (
    (cellOpen(codeAt((c0 + 0.5) * CELL), c0, s0, split, y, wv, jambs) +
      cellOpen(codeAt((c1 + 0.5) * CELL), c1, split, s1, y, wv, jambs)) /
    wA
  )
}

// Transmission of one wall-line crossing of the segment P -> Lp under the
// gridTrace v2 footprint model. The emitter (half extents H = [hx, hz] along
// world X/Z) is mapped to the occluder plane: with d = Lp - P and crossing
// parameter s, its footprint there is
//   along:    2 s (h_along + h_across |d_along| / max(|d_across|, 0.1))
//   vertical: 2 s h_across |d.y| / max(|d_across|, 0.1)
// (the across-line extent of the emitter shifts the crossing point along the
// line and up/down it). axis 0 is the line x = line (along = z), axis 1 the
// line z = line (along = x); heights are floor-local. Returns 1 when the
// segment does not cross the line.
export function footprintOpen(P, Lp, H, axis, line, codeAt, minW, jambs) {
  const dx = Lp[0] - P[0]
  const dy = Lp[1] - P[1]
  const dz = Lp[2] - P[2]
  const dC = axis === 0 ? dx : dz
  const dA = axis === 0 ? dz : dx
  if (Math.abs(dC) < 1e-6) return 1
  const s = (line - (axis === 0 ? P[0] : P[2])) / dC
  if (s <= 0 || s >= 1) return 1
  const along = (axis === 0 ? P[2] : P[0]) + dA * s
  const y = P[1] + dy * s
  const hA = axis === 0 ? H[1] : H[0]
  const hC = axis === 0 ? H[0] : H[1]
  const run = Math.max(Math.abs(dC), 0.1)
  const wA = clamp(2 * s * (hA + (hC * Math.abs(dA)) / run), minW, 0.9 * CELL)
  const wv = clamp((2 * s * hC * Math.abs(dy)) / run, 0.02, 1.2)
  return lineOpen(along, y, wA, wv, codeAt, jambs)
}

// gridTrace v2 on ultra (uTraceSubRays): the emitter is split along its long
// (world X) axis into `subRays` narrower emitters, each traced with its own
// footprint, and the transmissions averaged. Two sub-rays resolve a doorway's
// partial view of the tube much better than one wide box filter.
export function footprintOpenSub(P, Lp, H, axis, line, codeAt, minW, jambs, subRays) {
  const n = Math.max(1, subRays)
  const Hs = [H[0] / n, H[1]]
  let T = 0
  for (let sr = 0; sr < n; sr++) {
    const L = [Lp[0] + H[0] * (((sr + 0.5) * 2) / n - 1), Lp[1], Lp[2]]
    T += footprintOpen(P, L, Hs, axis, line, codeAt, minW, jambs)
  }
  return T / n
}

// Recommended replacement for the separable footprint (footprintOpen) at the
// same cost class as two gLineOpen evaluations and no second DDA walk.
//
// Linearised about the emitter centre, an emitter point offset by e_across
// (across the line: world X for axis 0) and e_along crosses the line at
//   along = along_c + s e_along - s e_across dA / dC
//   y     = y_c                 - s e_across dy / dC
// so the footprint is a PARALLELOGRAM: a box of half-width a = s h_along
// along the wall, slid along the segment (kA, kV) e, e in [-1, 1], that the
// across-line extent traces. The separable model replaces it by its bounding
// box, which is wrong where a jamb meets the lintel (the along and vertical
// shifts are correlated). Here, per cell, the vertical opening turns into an
// interval of e (the height is exact along the slide), and the along overlap
// of the sliding box is integrated over that interval in closed form
// (slideOverlapInt: piecewise linear, split at its kinks, like clampLenInt).
// The only approximations left are the linearisation and the 0.45 CELL cap
// that keeps the footprint within two cells.

// Along overlap of a box of half-width a centred at x0 + k u with [lo, hi].
export function slideLenAt(x0, k, a, lo, hi, u) {
  return Math.min(x0 + k * u + a, hi) - Math.max(x0 + k * u - a, lo)
}

// Integral over u in [ua, ub] of max(0, slideLenAt(x0, k, a, lo, hi, u)):
// kinks where either box end meets the interval, zero crossings in posLin.
export function slideOverlapInt(x0, k, a, lo, hi, ua, ub) {
  if (ub <= ua) return 0
  const k0 = clamp(Math.abs(k) > 1e-9 ? (hi - a - x0) / k : ua, ua, ub)
  const k1 = clamp(Math.abs(k) > 1e-9 ? (lo + a - x0) / k : ua, ua, ub)
  const p = Math.min(k0, k1)
  const q = Math.max(k0, k1)
  const fA = slideLenAt(x0, k, a, lo, hi, ua)
  const f0 = slideLenAt(x0, k, a, lo, hi, p)
  const f1 = slideLenAt(x0, k, a, lo, hi, q)
  const fB = slideLenAt(x0, k, a, lo, hi, ub)
  return posLin(fA, f0, p - ua) + posLin(f0, f1, q - p) + posLin(f1, fB, ub - q)
}

// Open share of the parallelogram footprint falling on cell c of the line
// (normalised by the whole footprint's area 2a x 2).
export function cellOpenPara(o, c, along, kA, a, y, kV, jambs) {
  if (o === null) return 0
  const inset = jambs ? (o[3] ?? 0) : 0
  let eLo = -1
  let eHi = 1
  if (Math.abs(kV) > 1e-5) {
    const e0 = (o[0] - y) / kV
    const e1 = (o[1] - y) / kV
    eLo = Math.max(-1, Math.min(e0, e1))
    eHi = Math.min(1, Math.max(e0, e1))
  } else if (y < o[0] || y > o[1]) return 0
  if (eHi <= eLo) return 0
  return (o[2] * slideOverlapInt(along, kA, a, c * CELL + inset, (c + 1) * CELL - inset, eLo, eHi)) / (4 * a)
}

// Parallelogram-footprint transmission of one wall-line crossing; same
// arguments and conventions as footprintOpen.
export function footprintOpenPara(P, Lp, H, axis, line, codeAt, minW, jambs) {
  const dx = Lp[0] - P[0]
  const dy = Lp[1] - P[1]
  const dz = Lp[2] - P[2]
  const dC = axis === 0 ? dx : dz
  const dA = axis === 0 ? dz : dx
  if (Math.abs(dC) < 1e-6) return 1
  const s = (line - (axis === 0 ? P[0] : P[2])) / dC
  if (s <= 0 || s >= 1) return 1
  const along = (axis === 0 ? P[2] : P[0]) + dA * s
  const y = P[1] + dy * s
  const hA = axis === 0 ? H[1] : H[0]
  const hC = axis === 0 ? H[0] : H[1]
  const run = Math.max(Math.abs(dC), 0.1)
  let a = Math.max(s * hA, 0.5 * minW)
  let kA = (s * hC * Math.abs(dA)) / run
  // the vertical slide runs with the along slide; its sign follows dA
  const kV = ((s * hC * dy) / run) * (dA >= 0 ? 1 : -1)
  const sc = Math.min(1, (0.45 * CELL) / (a + kA)) // stay within two cells
  a *= sc
  kA *= sc
  const c0 = Math.floor((along - a - kA) / CELL)
  const c1 = Math.floor((along + a + kA) / CELL)
  let T = cellOpenPara(codeAt((c0 + 0.5) * CELL), c0, along, kA, a, y, kV, jambs)
  if (c1 !== c0) T += cellOpenPara(codeAt((c1 + 0.5) * CELL), c1, along, kA, a, y, kV, jambs)
  return T
}

// --- P5: square columns -------------------------------------------------------------

// Soft occlusion of the XZ segment a (receiver) -> b (light) by a square
// column (centre ctr, half-width `half`), the plan's grid-penumbra (e) test as
// gColumnSq implements it: the emitter footprint at the column's
// along-position t (width w across the ray) is overlapped with the square's
// exact support across the ray, he = half (|u.x| + |u.y|). Matches the CPU
// square test for a point light at any angle (the v1 round test left a 41 %
// sliver at 45 deg).
// The t gate is not in the plan's formula but is required: q is measured to
// the INFINITE line, so without it a column behind the receiver (t clamped to
// 0) blocks, and every receiver on or in front of a column's lit side reads
// black (17 % of point-light rays near a column misclassified). With the gate
// only grazing rays beside a face, whose column centre projects behind P,
// remain wrong (~0.1 %); columnVisibilityClipped is exact.
// [tLo, tHi] is the traced window of the ray (gTraceWin): a cross-floor path
// walks the full ray on each storey over the part inside it, and a column
// outside that part stands in the other storey.
export function columnVisibility(a, b, ctr, half, hx, hz, minW, tLo = 0, tHi = 1) {
  const abx = b[0] - a[0]
  const abz = b[1] - a[1]
  const l2 = abx * abx + abz * abz
  if (l2 < 1e-8) return 1
  const cx = ctr[0] - a[0]
  const cz = ctr[1] - a[1]
  const t = (cx * abx + cz * abz) / l2
  if (t <= tLo || t >= tHi) return 1 // the column is not between P and the light
  const il = 1 / Math.sqrt(l2)
  const ux = abx * il
  const uz = abz * il
  const q = Math.abs(ux * cz - uz * cx)
  const he = half * (Math.abs(ux) + Math.abs(uz))
  const w = Math.max(2 * t * (hx * Math.abs(uz) + hz * Math.abs(ux)), minW)
  return 1 - clamp((Math.min(q + 0.5 * w, he) - Math.max(q - 0.5 * w, -he)) / w, 0, 1)
}

// Exact variant of columnVisibility: instead of the t gate, the square is
// clipped to the strip of the segment (0 <= along <= |ab|) and the footprint
// is overlapped with the across-ray extent of what remains. For a point light
// this is the exact segment-square test (a convex set is crossed by the line
// iff the line's offset lies in the set's projection), including grazing rays
// beside a face whose column centre projects behind P, and the result has no
// step where the gate flips. Cost: the 4 corners and 4 edges of the square.
export function columnVisibilityClipped(a, b, ctr, half, hx, hz, minW) {
  const abx = b[0] - a[0]
  const abz = b[1] - a[1]
  const l2 = Math.max(abx * abx + abz * abz, 1e-12)
  const len = Math.sqrt(l2)
  const ux = abx / len
  const uz = abz / len
  const cx = ctr[0] - a[0]
  const cz = ctr[1] - a[1]
  const t = clamp((cx * abx + cz * abz) / l2, 0, 1)
  // corner k of the square in the ray frame (al along, pp across); the corners
  // go round the square so k -> k+1 is an edge
  let pMin = 1e9
  let pMax = -1e9
  let prevAl = 0
  let prevPp = 0
  for (let k = 0; k < 5; k++) {
    const kk = k % 4
    const ox = (kk === 1 || kk === 2 ? half : -half) + cx
    const oz = (kk >= 2 ? half : -half) + cz
    const al = ox * ux + oz * uz
    const pp = ux * oz - uz * ox
    if (k < 4 && al >= 0 && al <= len) {
      pMin = Math.min(pMin, pp)
      pMax = Math.max(pMax, pp)
    }
    if (k > 0) {
      // where the edge prev -> this crosses along = 0 and along = len
      const da = al - prevAl
      if ((prevAl < 0) !== (al < 0)) {
        const p0 = prevPp + ((pp - prevPp) * (0 - prevAl)) / da
        pMin = Math.min(pMin, p0)
        pMax = Math.max(pMax, p0)
      }
      if ((prevAl < len) !== (al < len)) {
        const p1 = prevPp + ((pp - prevPp) * (len - prevAl)) / da
        pMin = Math.min(pMin, p1)
        pMax = Math.max(pMax, p1)
      }
    }
    prevAl = al
    prevPp = pp
  }
  if (pMax < pMin) return 1
  const w = Math.max(2 * t * (hx * Math.abs(uz) + hz * Math.abs(ux)), minW)
  return 1 - clamp((Math.min(0.5 * w, pMax) - Math.max(-0.5 * w, pMin)) / w, 0, 1)
}
