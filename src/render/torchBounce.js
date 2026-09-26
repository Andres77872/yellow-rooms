import { FLASH_RANGE } from '../world/constants.js'
import { FLASH_HAND_OFFSET } from './flashFrame.js'

// The flashlight's bounce light (engine-improvement chapter 14 P16).
//
// v1 placed a virtual point light (VPL) per PIXEL from five screen-centre
// depth taps: averaging positions across a depth edge made the light float
// and pop, and nothing occluded it. The hit is now found ONCE per frame on
// the CPU: a 2.5D ray walk through the light grid (walls, jambs, lintels,
// sills, floors, ceilings, columns, furniture proxies — LightGrid.raycast)
// plus the enemy capsules. The VPL sits 0.25 m off the hit surface, coloured
// by the hit class's family albedo, and a critically damped filter (~60 ms)
// smooths position and colour so sweeping the beam across a jamb glides
// instead of popping. The lighting pass traces walls and capsules toward it
// on high tiers. THREE-free (plain {x, y, z} vectors).

const TAU = 0.06 // s
const OFFSET = 0.25 // m off the hit surface
const ENEMY_ALBEDO = [0.16, 0.15, 0.14]
const FURNITURE_ALBEDO = [0.34, 0.31, 0.27]

const vec = (x = 0, y = 0, z = 0) => ({ x, y, z })
const lerpTo = (a, b, k) => {
  a.x += (b.x - a.x) * k
  a.y += (b.y - a.y) * k
  a.z += (b.z - a.z) * k
}
const normalize = (a) => {
  const l = Math.hypot(a.x, a.y, a.z) || 1
  a.x /= l
  a.y /= l
  a.z /= l
  return a
}

export class TorchBounce {
  constructor() {
    this.active = false
    this.pos = vec()
    this.normal = vec(0, 1, 0)
    this.color = vec() // albedo x falloff (the renderer adds the torch colour)
    this.kind = null
    this.albedo = { floor: [0.4, 0.4, 0.4], wall: [0.5, 0.5, 0.5], ceiling: [0.5, 0.5, 0.5] }
    this._tPos = vec()
    this._tN = vec()
    this._tCol = vec()
    this._hit = {}
  }

  // Family albedos (linear rgb triples), e.g. from the palette the GI uses.
  setAlbedo({ floor, wall, ceiling }) {
    this.albedo = { floor, wall, ceiling }
  }

  // caps: flat [ax, ay, az, r, bx, by, bz, owner] x capCount (enemies).
  update(dt, grid, camera, flashOn, caps = null, capCount = 0) {
    const m = camera?.matrixWorld?.elements
    if (!flashOn || typeof grid?.raycast !== 'function' || !m) {
      this.active = false
      return false
    }
    // Hand position and beam axis from the camera's world matrix.
    const [hx0, hy0, hz0] = FLASH_HAND_OFFSET
    const o = vec(
      m[0] * hx0 + m[4] * hy0 + m[8] * hz0 + m[12],
      m[1] * hx0 + m[5] * hy0 + m[9] * hz0 + m[13],
      m[2] * hx0 + m[6] * hy0 + m[10] * hz0 + m[14]
    )
    const d = normalize(vec(-m[8], -m[9], -m[10]))
    const h = grid.raycast(o.x, o.y, o.z, d.x, d.y, d.z, FLASH_RANGE, this._hit)
    let t = h ? h.t : Infinity
    let kind = h ? h.kind : null
    const n = this._tN
    n.x = h?.nx ?? 0
    n.y = h?.ny ?? 1
    n.z = h?.nz ?? 0
    // Enemy capsules (the beam aimed at the Stalker lights its chest, not
    // the wall behind it).
    for (let i = 0; i < capCount; i++) {
      const c = i * 8
      const r = caps[c + 3]
      if (!(r > 0)) continue
      const tc = rayCapsule(o, d, caps, c, r, t)
      if (tc < t) {
        t = tc
        kind = 'enemy'
        const px = o.x + d.x * t
        const py = o.y + d.y * t
        const pz = o.z + d.z * t
        const ax = caps[c + 4] - caps[c]
        const ay = caps[c + 5] - caps[c + 1]
        const az = caps[c + 6] - caps[c + 2]
        const s = Math.max(0, Math.min(1,
          ((px - caps[c]) * ax + (py - caps[c + 1]) * ay + (pz - caps[c + 2]) * az) /
            Math.max(ax * ax + ay * ay + az * az, 1e-6)))
        n.x = px - caps[c] - ax * s
        n.y = py - caps[c + 1] - ay * s
        n.z = pz - caps[c + 2] - az * s
        normalize(n)
      }
    }
    if (!Number.isFinite(t)) {
      // Beam into the void: the bounce fades out.
      const k = Math.exp(-dt / TAU)
      this.color.x *= k
      this.color.y *= k
      this.color.z *= k
      if (this.color.x + this.color.y + this.color.z < 1e-5) this.active = false
      return this.active
    }
    const a =
      kind === 'floor' ? this.albedo.floor
        : kind === 'ceiling' ? this.albedo.ceiling
          : kind === 'wall' || kind === 'column' ? this.albedo.wall
            : kind === 'enemy' ? ENEMY_ALBEDO
              : FURNITURE_ALBEDO
    // Glazing and see-through proxies crossed before the hit dim the beam
    // (an enemy in front of the first such crossing sees the full beam).
    const through = h && (kind !== 'enemy' || t > h.tTrans) ? h.trans ?? 1 : 1
    const fx = Math.max(0, 1 - t / FLASH_RANGE)
    const fall = fx * fx * 0.35 * through
    const tp = this._tPos
    tp.x = o.x + d.x * t + n.x * OFFSET
    tp.y = o.y + d.y * t + n.y * OFFSET
    tp.z = o.z + d.z * t + n.z * OFFSET
    const tc = this._tCol
    tc.x = a[0] * fall
    tc.y = a[1] * fall
    tc.z = a[2] * fall
    if (!this.active) {
      Object.assign(this.pos, tp)
      Object.assign(this.normal, n)
      Object.assign(this.color, tc)
    } else {
      const k = 1 - Math.exp(-dt / TAU)
      lerpTo(this.pos, tp, k)
      lerpTo(this.normal, n, k)
      normalize(this.normal)
      lerpTo(this.color, tc, k)
    }
    this.kind = kind
    this.active = true
    return true
  }
}

// Entry distance of the ray o + d t into capsule c of the flat array (axis
// a-b, radius r), or Infinity. Approximate (closest approach, then back off
// along the ray), which is plenty for placing a bounce light.
function rayCapsule(o, d, caps, c, r, tMax) {
  const ax = caps[c]
  const ay = caps[c + 1]
  const az = caps[c + 2]
  const ux = caps[c + 4] - ax
  const uy = caps[c + 5] - ay
  const uz = caps[c + 6] - az
  const wx = o.x - ax
  const wy = o.y - ay
  const wz = o.z - az
  const b = d.x * ux + d.y * uy + d.z * uz
  const cc = ux * ux + uy * uy + uz * uz
  const dd = d.x * wx + d.y * wy + d.z * wz
  const e = ux * wx + uy * wy + uz * wz
  const den = cc - b * b
  let s = den > 1e-9 ? (b * e - cc * dd) / den : 0
  s = Math.max(0, Math.min(Number.isFinite(tMax) ? tMax : FLASH_RANGE, s))
  let q = cc > 1e-9 ? (e + b * s) / cc : 0
  q = Math.max(0, Math.min(1, q))
  const px = o.x + d.x * s - (ax + ux * q)
  const py = o.y + d.y * s - (ay + uy * q)
  const pz = o.z + d.z * s - (az + uz * q)
  const dist2 = px * px + py * py + pz * pz
  if (dist2 > r * r) return Infinity
  return Math.max(0, s - Math.sqrt(r * r - dist2))
}
