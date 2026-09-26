import {
  CELL,
  CHUNK,
  COL_HALF,
  FRAME_W,
  LAYER_H,
  LIGHT_RANGE,
  MONUMENTAL_COL_HALF,
  STALKER_AMBIENT,
  WALL_H,
  cIdx,
  hIdx,
  layerY,
  vIdx,
} from '../constants.js'
import { hash3i } from '../core/hash.js'
import { isBadTube, lampTint } from '../lampCharacter.js'
import {
  COLUMN_MONUMENTAL,
  COLUMN_STANDARD,
  PASSAGE_DOOR,
  WALL_RAIL,
  WALL_WINDOW,
} from '../mapTypes.js'
import {
  EDGE_DOOR,
  EDGE_OPEN,
  EDGE_OPENINGS,
  EDGE_RAIL,
  EDGE_WALL,
  EDGE_WINDOW,
  FLAG_CEIL_HOLE,
  FLAG_COLUMN,
  FLAG_FLOOR_HOLE,
  FLAG_LAMP,
  FLAG_LOADED,
  FLAG_PIER,
  GI_EMIT_FLOOR,
  GI_SOURCE_Y,
  GI_TEXELS,
  GRID_H,
  GRID_W,
  LAMP_Y,
  LIST_MAX,
  LIST_UINTS,
  OCC_MASK_BITS,
  OCC_OFFSETS,
  OCC_RING,
  OCC_T_SHIFT_A,
  OCC_T_SHIFT_B,
  OWNER_H,
  OWNER_W,
  REF_EMPTY,
  REF_FLOOR_REACH,
  REF_REACH,
  SLAB_MID,
  TINT_SCALE,
  VIS_FULL,
  decodeOccBox,
  decodeRef,
  encodeFlicker,
  encodeRef,
  floorOfY,
  ownerIndex,
  ownerTag,
  packEntry,
  packOccBox,
  texelIndex,
  texelX,
  texelY,
} from './gridSpec.js'

// Headless world-grid light model (engine-improvement chapter 12 §4.1–4.2).
//
// Owns window-sized typed arrays that ARE the GPU textures' backing stores
// (render/GridLightTextures.js wraps them without copying):
//   edge   RGBA8   west code, north code, cell flags, reserved
//   lamp   RGBA8   fixture tint * TINT_SCALE, flicker identity (0 = none)
//   list   RGBA32UI up to 8 (lamp ref, visibility) entries per cell
//   gi     RGBA16F ambient cube, three texels per cell
//   occ    RGBA32UI furniture proxy boxes + ring mask (gridSpec OCC_*)
//   owner  RGBA8   resident chunk tag per (chunk column, floor slot); CPU
//                  bookkeeping only since grid schema v2
//
// Everything here is deterministic from ChunkData, so the same seed builds
// the same lists on every machine, in a worker, or under Vitest. The CPU
// gameplay light query (lightAt) reads the very lists the shader shades
// with, so the Stalker's sense of light matches the visible pools by
// construction — including the dark room behind a wall, which used to leak.

// Sampled visibility for fixtures that are neither provably clear nor
// provably blocked: five receiver points across the cell at a mid height,
// two points along the panel's long axis. The shader traces these fixtures
// per pixel anyway, so this fraction only has to rank the list and weight
// gameplay light and bounce.
const RECEIVER_XZ = Object.freeze([
  [1.5, 1.5],
  [0.45, 0.45],
  [2.55, 0.45],
  [0.45, 2.55],
  [2.55, 2.55],
])
const RECEIVER_Y = Object.freeze([0.7])
const LAMP_SAMPLES_X = Object.freeze([0])
// Local edge window used by same-floor visibility: the job's chunk plus a
// margin covering every fixture its cells can reference.
const LOCAL_PAD = REF_REACH + 1
const LOCAL_W = CHUNK + LOCAL_PAD * 2
const SAMPLE_COUNT = RECEIVER_XZ.length * RECEIVER_Y.length * LAMP_SAMPLES_X.length

// Attenuation used to RANK list entries and to feed the GI solve: inverse
// square with a smooth finite window (the semi-realistic fixture model). The
// shader applies the active look's own falloff per pixel.
export function physicalAttenuation(d, range = LIGHT_RANGE) {
  const x = d / range
  if (x >= 1) return 0
  const w = 1 - x * x * x * x
  return (w * w) / (d * d + 0.25)
}

// The legacy cubic pool window (render/shaders/common.js LAMP_ATT), kept for
// the gameplay light level so AI balance stays curve-identical in open rooms.
export function cubicAttenuation(d, range = LIGHT_RANGE) {
  if (d >= range) return 0
  const f = 1 - d / range
  return f * f * f
}

// float32 -> IEEE half (round-to-nearest), for the RGBA16F GI texels.
const _f32 = new Float32Array(1)
const _u32 = new Uint32Array(_f32.buffer)
export function toHalf(v) {
  _f32[0] = v
  const x = _u32[0]
  const sign = (x >>> 16) & 0x8000
  let exp = ((x >>> 23) & 0xff) - 112
  let mant = x & 0x7fffff
  if (exp <= 0) {
    if (exp < -10) return sign
    mant = (mant | 0x800000) >>> (1 - exp)
    return sign | ((mant + 0x1000) >>> 13)
  }
  if (exp >= 31) return sign | 0x7bff
  // Addition, not OR: a rounding carry out of the mantissa must bump the
  // exponent.
  return sign | Math.min(0x7bff, (exp << 10) + ((mant + 0x1000) >>> 13))
}

const _ref = { dx: 0, dz: 0, df: 0 }
const WALL_FACE_OFFSET = Object.freeze([0, 3, 12, 15]) // E offsets of the west/east/north/south walls
const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b

function edgeCode(wall, passage, feature) {
  if (wall === 1) {
    if (feature === WALL_WINDOW) return EDGE_WINDOW
    if (feature === WALL_RAIL) return EDGE_RAIL
    return EDGE_WALL
  }
  return passage === PASSAGE_DOOR ? EDGE_DOOR : EDGE_OPEN
}

const chunkKey = (cx, cy, cz) => `${cx},${cy},${cz}`

export class LightGrid {
  constructor() {
    const cells = GRID_W * GRID_H
    this.edge = new Uint8Array(cells * 4)
    this.lamp = new Uint8Array(cells * 4)
    this.list = new Uint32Array(cells * LIST_UINTS)
    this.gi = new Uint16Array(cells * GI_TEXELS * 4)
    this.occ = new Uint32Array(cells * 4)
    this.owner = new Uint8Array(OWNER_W * OWNER_H * 4)
    // CPU-only state.
    this._computed = new Uint8Array(cells) // 1 once a cell's list was built
    this._giM = new Float32Array(cells * 3) // mean cell radiosity (propagation state)
    this._records = new Map() // chunk key -> record
    this._slots = new Map() // owner index -> mapped record
    this._jobs = new Map() // chunk key -> { rect, gi } pending work
    this._dirty = { edge: [], lamp: [], list: [], gi: [], occ: [], owner: [] }
    this.revision = 0 // bumps whenever uploaded data changes
    this.playerCy = 0
    // GI parameters: linear albedos and fixture colour, set by the renderer
    // from the family palette. Until then a neutral mid-grey room is assumed.
    this.albedo = { floor: [0.4, 0.4, 0.4], wall: [0.5, 0.5, 0.5], ceiling: [0.5, 0.5, 0.5] }
    this._tint = [0, 0, 0]
    this._reachScratch = new Uint8Array((REF_REACH * 2 + 1) ** 2)
    this._local = new Uint8Array(LOCAL_W * LOCAL_W * 3)
    this._locX0 = 0
    this._locZ0 = 0
    this._locCy = null
    this._holeCache = new Map()
    this._jobLamps = []
    this._jobHoles = new Map()
    this._entries = []
    for (let i = 0; i < 64; i++) this._entries.push({ ref: 0, vis: 0, w: 0 })
    // Furniture proxy provider (world/objects/furniture/proxies.js
    // furnitureProxyBoxes): (record, out) -> count of chunk-local boxes.
    // Injected so this module stays independent of the furniture tables.
    this.proxyBoxes = null
    this._occBoxes = []
    this.stats = { listCells: 0, sampledPairs: 0, clearPairs: 0, blockedPairs: 0, giCells: 0, jobs: 0 }
  }

  // --- Residency --------------------------------------------------------

  reset() {
    this.edge.fill(0)
    this.lamp.fill(0)
    this.list.fill(0)
    this.gi.fill(0)
    this.occ.fill(0)
    this.owner.fill(0)
    this._computed.fill(0)
    this._giM.fill(0)
    this._records.clear()
    this._slots.clear()
    this._jobs.clear()
    for (const k of Object.keys(this._dirty)) this._dirty[k].length = 0
    this._markAllDirty()
  }

  // Family palette -> GI albedos (linear rgb triples). Changing them only
  // re-solves bounce; visibility and lists are unaffected.
  setAlbedo({ floor, wall, ceiling }) {
    const same = (a, b) => a && b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]
    if (same(floor, this.albedo.floor) && same(wall, this.albedo.wall) && same(ceiling, this.albedo.ceiling)) return
    this.albedo = { floor: [...floor], wall: [...wall], ceiling: [...ceiling] }
    for (const rec of this._slots.values()) this._queue(rec, [0, 0, CHUNK - 1, CHUNK - 1], false)
  }

  has(cx, cy, cz) {
    return this._records.has(chunkKey(cx, cy, cz))
  }

  isMapped(cx, cy, cz) {
    return this._slots.get(ownerIndex(cx, cy, cz))?.key === chunkKey(cx, cy, cz)
  }

  // Register a resident chunk's generation data. `data` is its ChunkData.
  addChunk(data) {
    const { cx, cy, cz } = data
    const key = chunkKey(cx, cy, cz)
    if (this._records.has(key)) return
    let holes = 0
    for (let lz = 0; lz < CHUNK; lz++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        if (data.hasCeilHole(lx, lz)) holes |= 1
        if (data.hasFloorHole(lx, lz)) holes |= 2
      }
    }
    const rec = { key, cx, cy, cz, data, holes, oi: ownerIndex(cx, cy, cz) }
    this._records.set(key, rec)
    const current = this._slots.get(rec.oi)
    if (!current || this._prefers(rec, current)) {
      if (current) this._unmap(current, false)
      this._map(rec)
    }
  }

  removeChunk(cx, cy, cz) {
    const key = chunkKey(cx, cy, cz)
    const rec = this._records.get(key)
    if (!rec) return
    this._records.delete(key)
    this._jobs.delete(key)
    if (this._slots.get(rec.oi) === rec) {
      this._unmap(rec, true)
      // Promote the best waiting chunk that aliases the same slot.
      let best = null
      for (const other of this._records.values()) {
        if (other.oi !== rec.oi) continue
        if (!best || this._prefers(other, best)) best = other
      }
      if (best) this._map(best)
    }
  }

  // Vertical aliasing is resolved in favour of the floors nearest the player.
  setPlayerFloor(cy) {
    if (cy === this.playerCy) return
    this.playerCy = cy
    for (const rec of this._records.values()) {
      const current = this._slots.get(rec.oi)
      if (current !== rec && current && this._prefers(rec, current)) {
        this._unmap(current, false)
        this._map(rec)
      }
    }
  }

  _prefers(a, b) {
    const da = Math.abs(a.cy - this.playerCy)
    const db = Math.abs(b.cy - this.playerCy)
    return da < db || (da === db && a.cy < b.cy)
  }

  _map(rec) {
    this._slots.set(rec.oi, rec)
    const o = rec.oi * 4
    this.owner[o] = ownerTag(rec.cx)
    this.owner[o + 1] = ownerTag(rec.cz)
    this.owner[o + 2] = ownerTag(rec.cy)
    this.owner[o + 3] = 255
    this._pushDirty('owner', rec.oi % OWNER_W, Math.floor(rec.oi / OWNER_W), 1, 1)
    this._writeCells(rec)
    this._invalidateAround(rec)
  }

  _unmap(rec, removed) {
    this._slots.delete(rec.oi)
    const o = rec.oi * 4
    this.owner.fill(0, o, o + 4)
    this._pushDirty('owner', rec.oi % OWNER_W, Math.floor(rec.oi / OWNER_W), 1, 1)
    this._clearCells(rec)
    this._remaskAround(rec)
    this._jobs.delete(rec.key)
    // Lists around a vanished chunk reference its fixtures and its walls.
    if (removed) this._invalidateAround(rec, true)
  }

  _chunkRect(rec) {
    return [rec.cx * CHUNK, rec.cz * CHUNK, rec.cx * CHUNK + CHUNK - 1, rec.cz * CHUNK + CHUNK - 1]
  }

  _writeCells(rec) {
    const { data, cx, cy, cz } = rec
    for (let lz = 0; lz < CHUNK; lz++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        const gx = cx * CHUNK + lx
        const gz = cz * CHUNK + lz
        const t = texelIndex(gx, gz, cy)
        const e = t * 4
        const vi = vIdx(lx, lz)
        const hi = hIdx(lx, lz)
        this.edge[e] = edgeCode(data.wallV[vi], data.passageV[vi], data.wallFeatureV[vi])
        this.edge[e + 1] = edgeCode(data.wallH[hi], data.passageH[hi], data.wallFeatureH[hi])
        let flags = FLAG_LOADED
        if (data.hasCeilHole(lx, lz)) flags |= FLAG_CEIL_HOLE
        if (data.hasFloorHole(lx, lz)) flags |= FLAG_FLOOR_HOLE
        const col = data.cols[cIdx(lx, lz)]
        if (col === COLUMN_STANDARD) flags |= FLAG_COLUMN
        else if (col === COLUMN_MONUMENTAL) flags |= FLAG_PIER
        this.edge[e + 2] = flags
        this.edge[e + 3] = ownerTag(cy)
        this.lamp.fill(0, e, e + 4)
        this._computed[t] = 0
        this.list.fill(0, t * LIST_UINTS, t * LIST_UINTS + LIST_UINTS)
      }
    }
    for (const l of data.lamps) {
      if (!l.lit) continue
      const gx = cx * CHUNK + l.lx
      const gz = cz * CHUNK + l.lz
      const wx = (gx + 0.5) * CELL
      const wz = (gz + 0.5) * CELL
      const role = data.spaceRole?.[cIdx(l.lx, l.lz)] ?? 0
      lampTint(wx, wz, cy, this._tint, role)
      const e = texelIndex(gx, gz, cy) * 4
      this.lamp[e] = Math.min(255, Math.round(this._tint[0] * TINT_SCALE * 255))
      this.lamp[e + 1] = Math.min(255, Math.round(this._tint[1] * TINT_SCALE * 255))
      this.lamp[e + 2] = Math.min(255, Math.round(this._tint[2] * TINT_SCALE * 255))
      this.lamp[e + 3] = encodeFlicker(isBadTube(wx, wz, cy), hash3i(0xf11c, gx, gz, cy) & 127)
      this.edge[e + 2] |= FLAG_LAMP
    }
    this._writeOcc(rec)
    const [x0, z0] = this._chunkRect(rec)
    this._pushCellDirty(['edge', 'lamp', 'list', 'gi', 'occ'], x0, z0, cy, CHUNK, CHUNK)
    this._remaskAround(rec)
  }

  // Furniture proxy boxes of the chunk (gridSpec OCC_*): each furnished cell
  // stores its piece's boxes; every cell stores the ring-ordered mask of the
  // furnished cells within ring 2. Generated maps keep furniture FURN_MARGIN
  // (2) cells off the chunk border, but the editor places pieces anywhere, so
  // masks read every owned cell in reach, across chunk seams, and the
  // neighbours' border strips are re-masked whenever a chunk is mapped or
  // unmapped (_remaskAround). Cosmetic only: lightAt and the lists ignore
  // furniture.
  _writeOcc(rec) {
    const { data, cx, cy, cz } = rec
    const x0 = cx * CHUNK
    const z0 = cz * CHUNK
    for (let lz = 0; lz < CHUNK; lz++) {
      for (let lx = 0; lx < CHUNK; lx++) this.occ.fill(0, texelIndex(x0 + lx, z0 + lz, cy) * 4, texelIndex(x0 + lx, z0 + lz, cy) * 4 + 4)
    }
    const pieces = data.furniture
    if (pieces?.length && this.proxyBoxes) {
      const boxes = this._occBoxes
      for (const f of pieces) {
        if (f.lx < 0 || f.lz < 0 || f.lx >= CHUNK || f.lz >= CHUNK) continue
        boxes.length = 0
        const n = this.proxyBoxes(f, boxes)
        if (!n) continue
        const t = texelIndex(x0 + f.lx, z0 + f.lz, cy) * 4
        // Boxes arrive chunk-local; store them relative to the cell corner.
        const ox = f.lx * CELL
        const oz = f.lz * CELL
        for (let i = 0; i < Math.min(2, n); i++) {
          const b = boxes[i]
          const p = packOccBox({ x0: b.x0 - ox, x1: b.x1 - ox, z0: b.z0 - oz, z1: b.z1 - oz, y0: b.y0, y1: b.y1, t: b.t })
          if (i === 0) {
            this.occ[t] = p.xz
            this.occ[t + 1] = (this.occ[t + 1] & 0xffff0000) | p.y
            this.occ[t + 3] = (this.occ[t + 3] & ~(7 << OCC_T_SHIFT_A)) | (p.t << OCC_T_SHIFT_A)
          } else {
            this.occ[t + 2] = p.xz
            this.occ[t + 1] = (this.occ[t + 1] & 0xffff) | (p.y << 16)
            this.occ[t + 3] = (this.occ[t + 3] & ~(7 << OCC_T_SHIFT_B)) | (p.t << OCC_T_SHIFT_B)
          }
        }
      }
    }
    this._maskOcc(x0, z0, x0 + CHUNK - 1, z0 + CHUNK - 1, cy)
  }

  // A cell holds furniture: box A present in its owned occupancy texel.
  _furnishedAt(gx, gz, cy) {
    const t = this._texel(gx, gz, cy)
    return t >= 0 && ((this.occ[t * 4 + 1] >>> 8) & 255) !== 0
  }

  // Rebuild the ring masks of the owned cells in a global cell rectangle.
  _maskOcc(gx0, gz0, gx1, gz1, cy) {
    for (let gz = gz0; gz <= gz1; gz++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const ti = this._texel(gx, gz, cy)
        if (ti < 0) continue
        let mask = 0
        for (let b = 0; b < OCC_OFFSETS.length; b++) {
          if (this._furnishedAt(gx + OCC_OFFSETS[b][0], gz + OCC_OFFSETS[b][1], cy)) mask |= 1 << b
        }
        const t = ti * 4 + 3
        this.occ[t] = ((this.occ[t] & ~OCC_MASK_BITS) | mask) >>> 0
      }
    }
  }

  // The same-floor neighbours' cells within ring 2 of this chunk: their masks
  // can reference its furniture, which just appeared or went away.
  _remaskAround(rec) {
    const { cx, cy, cz } = rec
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue
        const nb = this._slots.get(ownerIndex(cx + dx, cy, cz + dz))
        if (!nb || nb.cx !== cx + dx || nb.cz !== cz + dz || nb.cy !== cy) continue
        const gx0 = Math.max(nb.cx * CHUNK, cx * CHUNK - OCC_RING)
        const gx1 = Math.min(nb.cx * CHUNK + CHUNK - 1, cx * CHUNK + CHUNK - 1 + OCC_RING)
        const gz0 = Math.max(nb.cz * CHUNK, cz * CHUNK - OCC_RING)
        const gz1 = Math.min(nb.cz * CHUNK + CHUNK - 1, cz * CHUNK + CHUNK - 1 + OCC_RING)
        if (gx0 > gx1 || gz0 > gz1) continue
        this._maskOcc(gx0, gz0, gx1, gz1, cy)
        this._pushCellDirty(['occ'], gx0, gz0, cy, gx1 - gx0 + 1, gz1 - gz0 + 1)
      }
    }
  }

  _clearCells(rec) {
    const [x0, z0] = this._chunkRect(rec)
    for (let lz = 0; lz < CHUNK; lz++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        const t = texelIndex(x0 + lx, z0 + lz, rec.cy)
        this.edge.fill(0, t * 4, t * 4 + 4)
        this.lamp.fill(0, t * 4, t * 4 + 4)
        this.list.fill(0, t * LIST_UINTS, t * LIST_UINTS + LIST_UINTS)
        this.gi.fill(0, t * GI_TEXELS * 4, (t + 1) * GI_TEXELS * 4)
        this.occ.fill(0, t * 4, t * 4 + 4)
        this._giM.fill(0, t * 3, t * 3 + 3)
        this._computed[t] = 0
      }
    }
    this._pushCellDirty(['edge', 'lamp', 'list', 'gi', 'occ'], x0, z0, rec.cy, CHUNK, CHUNK)
  }

  // A chunk's arrival or departure changes the lists of every receiver that
  // can see (or lose) one of its fixtures or walls: its own cells, strips of
  // REF_REACH cells in the eight same-floor neighbours, and — where a slab is
  // holed — the neighbourhood on the floors light can reach through the void.
  _invalidateAround(rec, excludeSelf = false) {
    const { cx, cy, cz } = rec
    for (let df = -REF_FLOOR_REACH; df <= REF_FLOOR_REACH; df++) {
      const fy = cy + df
      if (df !== 0 && !this._holesBetween(cx, cz, cy, fy)) continue
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (excludeSelf && dx === 0 && dz === 0 && df === 0) continue
          const other = this._records.get(chunkKey(cx + dx, fy, cz + dz))
          if (!other || this._slots.get(other.oi) !== other) continue
          let rect
          if (dx === 0 && dz === 0) rect = [0, 0, CHUNK - 1, CHUNK - 1]
          else {
            const r = REF_REACH
            rect = [
              dx < 0 ? CHUNK - r : 0,
              dz < 0 ? CHUNK - r : 0,
              dx > 0 ? r - 1 : CHUNK - 1,
              dz > 0 ? r - 1 : CHUNK - 1,
            ]
          }
          this._queue(other, rect, true)
        }
      }
    }
  }

  // Does any holed slab lie between floors a and b around chunk column
  // (cx, cz)? Without one, fixtures on other floors cannot reach through.
  _holesBetween(cx, cz, a, b) {
    const key = `${cx},${cz},${a},${b}`
    const cached = this._holeCache.get(key)
    if (cached !== undefined) return cached
    const v = this._holesBetweenUncached(cx, cz, a, b)
    this._holeCache.set(key, v)
    return v
  }

  _holesBetweenUncached(cx, cz, a, b) {
    const lo = Math.min(a, b)
    const hi = Math.max(a, b)
    for (let f = lo; f < hi; f++) {
      let any = false
      for (let dz = -1; dz <= 1 && !any; dz++) {
        for (let dx = -1; dx <= 1 && !any; dx++) {
          const r = this._records.get(chunkKey(cx + dx, f, cz + dz))
          if (r && r.holes & 1) any = true
        }
      }
      if (!any) return false
    }
    return true
  }

  _queue(rec, rect, lists) {
    let job = this._jobs.get(rec.key)
    if (!job) {
      job = { rec, rect: rect.slice(), lists }
      this._jobs.set(rec.key, job)
      return
    }
    const grew =
      rect[0] < job.rect[0] || rect[1] < job.rect[1] || rect[2] > job.rect[2] || rect[3] > job.rect[3] ||
      (lists && !job.lists)
    job.rect[0] = Math.min(job.rect[0], rect[0])
    job.rect[1] = Math.min(job.rect[1], rect[1])
    job.rect[2] = Math.max(job.rect[2], rect[2])
    job.rect[3] = Math.max(job.rect[3], rect[3])
    job.lists ||= lists
    // A widened job restarts its row cursor (its inputs changed too).
    if (grew) job.row = null
  }

  get pending() {
    return this._jobs.size
  }

  // Process queued list/GI work, nearest-to-player floors first, within a
  // wall-clock budget. Returns the number of jobs completed.
  update(budgetMs = 3, now = () => performance.now()) {
    if (!this._jobs.size) return 0
    const deadline = now() + budgetMs
    let done = 0
    const order = [...this._jobs.values()].sort(
      (a, b) => Math.abs(a.rec.cy - this.playerCy) - Math.abs(b.rec.cy - this.playerCy)
    )
    for (const job of order) {
      if (this._slots.get(job.rec.oi) !== job.rec) {
        this._jobs.delete(job.rec.key)
        continue
      }
      // Jobs are resumable row by row, so one slow chunk never overruns the
      // streaming frame budget; an interrupted job keeps its cursor.
      if (this._runJob(job, deadline, now)) {
        this._jobs.delete(job.rec.key)
        done++
      }
      if (now() >= deadline) break
    }
    return done
  }

  // Drain everything (level prewarm, behind the transition overlay).
  flush() {
    let n = 0
    while (this._jobs.size) n += this.update(Infinity)
    return n
  }

  // Snapshot the job floor's edge codes and flags around the chunk into a
  // dense array: same-floor ray tests then run on plain integer offsets, with
  // no toroidal addressing or residency checks per edge crossing.
  _buildLocal(rec) {
    const x0 = rec.cx * CHUNK - LOCAL_PAD
    const z0 = rec.cz * CHUNK - LOCAL_PAD
    const loc = this._local
    for (let z = 0; z < LOCAL_W; z++) {
      for (let x = 0; x < LOCAL_W; x++) {
        const t = this._texel(x0 + x, z0 + z, rec.cy)
        const o = (z * LOCAL_W + x) * 3
        if (t < 0) {
          loc[o] = EDGE_OPEN
          loc[o + 1] = EDGE_OPEN
          loc[o + 2] = 0
        } else {
          loc[o] = this.edge[t * 4]
          loc[o + 1] = this.edge[t * 4 + 1]
          loc[o + 2] = this.edge[t * 4 + 2]
        }
      }
    }
    this._locX0 = x0
    this._locZ0 = z0
    this._locCy = rec.cy
  }

  // Same-floor segment transmission over the local window (see segment()).
  _segmentLocal(ax, ay, az, bx, by, bz, base) {
    const loc = this._local
    const X0 = this._locX0
    const Z0 = this._locZ0
    const dx = bx - ax
    const dz = bz - az
    let gx = Math.floor(ax / CELL)
    let gz = Math.floor(az / CELL)
    const tgx = Math.floor(bx / CELL)
    const tgz = Math.floor(bz / CELL)
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0
    const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0
    let tMaxX = stepX > 0 ? ((gx + 1) * CELL - ax) / dx : stepX < 0 ? (gx * CELL - ax) / dx : Infinity
    let tMaxZ = stepZ > 0 ? ((gz + 1) * CELL - az) / dz : stepZ < 0 ? (gz * CELL - az) / dz : Infinity
    const tDeltaX = stepX ? CELL / Math.abs(dx) : Infinity
    const tDeltaZ = stepZ ? CELL / Math.abs(dz) : Infinity
    let trans = 1
    let o = ((gz - Z0) * LOCAL_W + (gx - X0)) * 3
    if (loc[o + 2] & (FLAG_COLUMN | FLAG_PIER) && this._columnBlocks(gx, gz, this._locCy, ax, az, dx, dz)) return 0
    while (gx !== tgx || gz !== tgz) {
      let sParam
      let code
      if (tMaxX < tMaxZ) {
        sParam = tMaxX
        if (sParam > 1) break
        const ex = stepX > 0 ? gx + 1 : gx
        code = loc[((gz - Z0) * LOCAL_W + (ex - X0)) * 3]
        gx += stepX
        tMaxX += tDeltaX
      } else {
        sParam = tMaxZ
        if (sParam > 1) break
        const ez = stepZ > 0 ? gz + 1 : gz
        code = loc[((ez - Z0) * LOCAL_W + (gx - X0)) * 3 + 1]
        gz += stepZ
        tMaxZ += tDeltaZ
      }
      if (code !== EDGE_OPEN) {
        const yl = ay + (by - ay) * sParam - base
        const op = EDGE_OPENINGS[code]
        if (yl < op.lo || yl > op.hi) return 0
        trans *= op.t
      }
      o = ((gz - Z0) * LOCAL_W + (gx - X0)) * 3
      if (loc[o + 2] & (FLAG_COLUMN | FLAG_PIER) && this._columnBlocks(gx, gz, this._locCy, ax, az, dx, dz)) return 0
    }
    return trans
  }

  _runJob(job, deadline = Infinity, now = () => performance.now()) {
    // Residency may have changed since the last slice: hole answers are only
    // cached within one slice.
    this._holeCache.clear()
    this._buildLocal(job.rec)
    if (job.lists) this._gatherJobLamps(job.rec)
    const { rec, rect } = job
    const [lx0, lz0, lx1, lz1] = rect
    const gx0 = rec.cx * CHUNK
    const gz0 = rec.cz * CHUNK
    if (job.lists) {
      if (job.row == null) job.row = lz0
      while (job.row <= lz1) {
        const lz = job.row
        for (let lx = lx0; lx <= lx1; lx++) this._buildList(gx0 + lx, gz0 + lz, rec.cy)
        this._pushCellDirty(['list'], gx0 + lx0, gz0 + lz, rec.cy, lx1 - lx0 + 1, 1)
        job.row++
        if (job.row <= lz1 && now() >= deadline) return false
      }
    }
    this._solveGI(rec, rect)
    this.stats.jobs++
    this.revision++
    return true
  }

  // --- Queries over the window --------------------------------------------

  // Texel index of a resident, mapped cell, or -1. The edge texel carries the
  // LOADED flag and its floor tag, so no Map lookup is needed on the hot path
  // (horizontal aliasing is impossible inside the streaming window; vertical
  // aliasing is caught by the floor tag).
  _texel(gx, gz, cy) {
    const t = texelIndex(gx, gz, cy)
    const e = t * 4
    return this.edge[e + 2] & FLAG_LOADED && this.edge[e + 3] === ownerTag(cy) ? t : -1
  }

  // Resident record owning global cell (gx, gz) on floor cy, or null.
  _recordAt(gx, gz, cy) {
    const cx = Math.floor(gx / CHUNK)
    const cz = Math.floor(gz / CHUNK)
    const rec = this._slots.get(ownerIndex(cx, cy, cz))
    return rec && rec.cx === cx && rec.cz === cz && rec.cy === cy ? rec : null
  }

  _cellMapped(gx, gz, cy) {
    return this._texel(gx, gz, cy) >= 0
  }

  // Edge code of the west (axis 0) or north (axis 1) edge of a cell. Cells of
  // chunks that are not resident read as open, like ChunkManager queries.
  _edge(axis, gx, gz, cy) {
    const t = this._texel(gx, gz, cy)
    return t < 0 ? EDGE_OPEN : this.edge[t * 4 + axis]
  }

  _flags(gx, gz, cy) {
    const t = this._texel(gx, gz, cy)
    return t < 0 ? 0 : this.edge[t * 4 + 2]
  }

  // Necessary condition for ANY straight path between two cells of a floor:
  // a straight segment visits a monotone 4-connected chain of cells inside
  // their bounding box, crossing only that chain's edges. If every monotone
  // chain hits a solid wall edge the fixture is fully blocked, whatever the
  // sample points — decided in O(box area) without tracing a single ray.
  _monotoneReachable(ax, az, bx, bz, cy) {
    const local = cy === this._locCy
    const loc = this._local
    const X0 = this._locX0
    const Z0 = this._locZ0
    const code = (axis, x, z) =>
      local ? loc[((z - Z0) * LOCAL_W + (x - X0)) * 3 + axis] : this._edge(axis, x, z, cy)
    const sx = bx >= ax ? 1 : -1
    const sz = bz >= az ? 1 : -1
    const w = Math.abs(bx - ax) + 1
    const h = Math.abs(bz - az) + 1
    const reach = this._reachScratch
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const x = ax + i * sx
        const z = az + j * sz
        let ok = i === 0 && j === 0
        if (!ok && i > 0 && reach[j * w + i - 1]) {
          // crossing the vertical line between x - sx and x
          ok = code(0, sx > 0 ? x : x + 1, z) !== EDGE_WALL
        }
        if (!ok && j > 0 && reach[(j - 1) * w + i]) {
          ok = code(1, x, sz > 0 ? z : z + 1) !== EDGE_WALL
        }
        reach[j * w + i] = ok ? 1 : 0
      }
    }
    return reach[h * w - 1] === 1
  }

  // Transmission of the straight segment a -> b (world coordinates) through
  // walls, openings, columns and slabs. 2.5D: every edge crossing is tested
  // at the ray's actual height against that edge's opening, so a door lintel
  // or a window sill shadows exactly what it should.
  segment(ax, ay, az, bx, by, bz) {
    let trans = 1
    const fa = floorOfY(ay)
    const fb = floorOfY(by)
    if (fa !== fb) {
      const lo = Math.min(fa, fb)
      const hi = Math.max(fa, fb)
      for (let f = lo; f < hi; f++) {
        const s = (layerY(f) + SLAB_MID - ay) / (by - ay)
        if (s < 0 || s > 1) continue
        const gx = Math.floor((ax + (bx - ax) * s) / CELL)
        const gz = Math.floor((az + (bz - az) * s) / CELL)
        if (!(this._flags(gx, gz, f) & FLAG_CEIL_HOLE)) return 0
      }
    }
    const dx = bx - ax
    const dz = bz - az
    let gx = Math.floor(ax / CELL)
    let gz = Math.floor(az / CELL)
    const tgx = Math.floor(bx / CELL)
    const tgz = Math.floor(bz / CELL)
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0
    const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0
    let tMaxX = stepX > 0 ? ((gx + 1) * CELL - ax) / dx : stepX < 0 ? (gx * CELL - ax) / dx : Infinity
    let tMaxZ = stepZ > 0 ? ((gz + 1) * CELL - az) / dz : stepZ < 0 ? (gz * CELL - az) / dz : Infinity
    const tDeltaX = stepX ? CELL / Math.abs(dx) : Infinity
    const tDeltaZ = stepZ ? CELL / Math.abs(dz) : Infinity
    if (this._columnBlocks(gx, gz, floorOfY(ay), ax, az, dx, dz)) return 0
    let guard = 64
    while ((gx !== tgx || gz !== tgz) && guard-- > 0) {
      let s
      let axis
      if (tMaxX < tMaxZ) {
        s = tMaxX
        axis = 0
      } else {
        s = tMaxZ
        axis = 1
      }
      if (s > 1) break
      const y = ay + (by - ay) * s
      const f = floorOfY(y)
      const yl = y - layerY(f)
      let t
      if (axis === 0) {
        const ex = stepX > 0 ? gx + 1 : gx
        t = this._crossing(0, ex, gz, f, yl, ex - 1, gz)
        gx += stepX
        tMaxX += tDeltaX
      } else {
        const ez = stepZ > 0 ? gz + 1 : gz
        t = this._crossing(1, gx, ez, f, yl, gx, ez - 1)
        gz += stepZ
        tMaxZ += tDeltaZ
      }
      trans *= t
      if (trans <= 0) return 0
      if (this._columnBlocks(gx, gz, f, ax, az, dx, dz)) return 0
    }
    return trans
  }

  // First surface along a ray (world origin o, unit direction d, up to
  // maxDist): a 2.5D Amanatides–Woo walk that stops at storey floors and
  // ceilings, wall edges closed at the ray's height (lintels, window sills
  // and headers, rails; doorway JAMBS included, unlike the bake), columns
  // (exact squares) and opaque furniture proxy boxes. Slab holes (stairs,
  // atria, lethal voids) let it through into the next storey; open edges
  // pass; window glazing (GLASS_T) and see-through proxies (a table's leg
  // frame, a plant's canopy: box t in eighths) pass with partial
  // transmission. Used to place the flashlight's bounce light (chapter 14
  // P16). Writes { t, x, y, z, nx, ny, nz, kind, trans, tTrans } into `out`
  // and returns it, or null when nothing is hit. kind: 'floor' | 'ceiling'
  // | 'wall' | 'column' | 'furniture'. trans: product of the partial
  // crossings before the hit; tTrans: ray distance of the first one
  // (Infinity if none), so a closer occluder found elsewhere (an enemy
  // capsule) knows whether the attenuation applies to it.
  raycast(ox, oy, oz, dx, dy, dz, maxDist, out = {}) {
    // Vertical state: storey cy, or the slab band above it (inside a hole
    // between its ceiling and the next storey's floor). Unbiased floor: the
    // hand 1 cm under a slab top is in the band below, not the storey above
    // (floorOfY's +2 cm bias is for surfaces lying on a plane).
    let cy = Math.floor(oy / LAYER_H)
    let inBand = oy - layerY(cy) > WALL_H
    // Each storey or band costs one step of the vertical walk; a shaft can be
    // deeper than any fixed count, so the cap follows the ray's reach.
    const planeCap = 2 * Math.ceil(maxDist / LAYER_H) + 4
    let gx = Math.floor(ox / CELL)
    let gz = Math.floor(oz / CELL)
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0
    const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0
    let tMaxX = stepX > 0 ? ((gx + 1) * CELL - ox) / dx : stepX < 0 ? (gx * CELL - ox) / dx : Infinity
    let tMaxZ = stepZ > 0 ? ((gz + 1) * CELL - oz) / dz : stepZ < 0 ? (gz * CELL - oz) / dz : Infinity
    const tDeltaX = stepX ? CELL / Math.abs(dx) : Infinity
    const tDeltaZ = stepZ ? CELL / Math.abs(dz) : Infinity
    let tEnter = 0
    let trans = 1
    let tTrans = Infinity
    const partial = (t, k) => {
      trans *= k
      if (t < tTrans) tTrans = t
    }
    const hit = (t, nx, ny, nz, kind) => {
      out.t = t
      out.x = ox + dx * t
      out.y = oy + dy * t
      out.z = oz + dz * t
      out.nx = nx
      out.ny = ny
      out.nz = nz
      out.kind = kind
      out.trans = trans
      out.tTrans = tTrans
      return out
    }
    for (let guard = 0; guard < 96; guard++) {
      const tExit = Math.min(tMaxX, tMaxZ, maxDist)
      // The storeys and slab bands this cell span passes through, in ray
      // order: occluders inside each storey, then its floor or ceiling plane
      // (a hole lets the ray on into the band and the next storey).
      let tS = tEnter
      let k = 0
      for (; k < planeCap; k++) {
        const base = layerY(cy)
        let tP = Infinity
        if (dy < 0) tP = ((inBand ? base + WALL_H : base) - oy) / dy
        else if (dy > 0) tP = ((inBand ? layerY(cy + 1) : base + WALL_H) - oy) / dy
        if (!inBand) {
          const r = this._cellOccluder(gx, gz, cy, ox, oy, oz, dx, dy, dz, tS, Math.min(tP, tExit), partial)
          if (r) return hit(r.t, r.nx, r.ny, r.nz, r.kind)
        }
        if (tP > tExit) break
        if (inBand) {
          // Out of the hole's band into the storey below (its ceiling
          // opening) or above (its floor opening).
          if (dy > 0) cy += 1
          inBand = false
        } else if (dy < 0) {
          if (!this._slabOpen(gx, gz, cy - 1)) return hit(tP, 0, 1, 0, 'floor')
          cy -= 1
          inBand = true
        } else {
          if (!this._slabOpen(gx, gz, cy)) return hit(tP, 0, -1, 0, 'ceiling')
          inBand = true
        }
        tS = tP
      }
      if (k === planeCap) return null // never continue from a stale storey
      if (tExit >= maxDist) return null
      // Cross the next wall edge at the ray's height.
      const axis = tMaxX < tMaxZ ? 0 : 1
      const t = axis === 0 ? tMaxX : tMaxZ
      const nx = axis === 0 ? -stepX : 0
      const nz = axis === 0 ? 0 : -stepZ
      if (inBand) {
        // Inside a hole's slab band the neighbour must be part of the void
        // too; otherwise the ray meets the slab's cut face.
        const open = axis === 0 ? this._slabOpen(gx + stepX, gz, cy) : this._slabOpen(gx, gz + stepZ, cy)
        if (!open) return hit(t, nx, 0, nz, 'wall')
      } else {
        const yl = oy + dy * t - layerY(cy)
        let code
        let along
        if (axis === 0) {
          code = this._edge(0, stepX > 0 ? gx + 1 : gx, gz, cy)
          along = oz + dz * t - gz * CELL
        } else {
          code = this._edge(1, gx, stepZ > 0 ? gz + 1 : gz, cy)
          along = ox + dx * t - gx * CELL
        }
        const op = EDGE_OPENINGS[code] ?? EDGE_OPENINGS[EDGE_WALL]
        const jamb = code === EDGE_DOOR && (along < FRAME_W || along > CELL - FRAME_W)
        // A wall's opening is empty (lo = hi = 0); a window's sill and header
        // are solid and only its glazing passes.
        if (jamb || op.hi <= op.lo || yl < op.lo - 1e-6 || yl > op.hi + 1e-6) return hit(t, nx, 0, nz, 'wall')
        if (op.t < 1) partial(t, op.t)
      }
      tEnter = t
      if (axis === 0) {
        gx += stepX
        tMaxX += tDeltaX
      } else {
        gz += stepZ
        tMaxZ += tDeltaZ
      }
    }
    return null
  }

  // Is the slab between storeys f and f + 1 open at cell (gx, gz)? Either
  // side's flag decides, so a void reads open with only one storey resident.
  _slabOpen(gx, gz, f) {
    return (this._flags(gx, gz, f) & FLAG_CEIL_HOLE) !== 0 || (this._flags(gx, gz, f + 1) & FLAG_FLOOR_HOLE) !== 0
  }

  // Nearest column or opaque furniture proxy of cell (gx, gz) on storey cy
  // with ray distance in [t0, t1], or null. See-through proxies in front of
  // it report their crossing to partial(t, transmission).
  _cellOccluder(gx, gz, cy, ox, oy, oz, dx, dy, dz, t0, t1, partial) {
    const flags = this._flags(gx, gz, cy)
    let best = null
    if (flags & (FLAG_COLUMN | FLAG_PIER)) {
      const h = flags & FLAG_PIER ? MONUMENTAL_COL_HALF : COL_HALF
      const r = this._slab2(ox, oz, dx, dz, (gx + 0.5) * CELL - h, (gz + 0.5) * CELL - h, (gx + 0.5) * CELL + h, (gz + 0.5) * CELL + h)
      if (r && r.t >= t0 && r.t <= t1) best = { t: r.t, nx: r.nx, ny: 0, nz: r.nz, kind: 'column' }
    }
    const ti = this._texel(gx, gz, cy)
    if (ti < 0) return best
    const o = ti * 4
    const base = layerY(cy)
    let seeT = Infinity
    let seeK = 1
    let seeT2 = Infinity
    let seeK2 = 1
    for (let w = 0; w < 2; w++) {
      const xz = this.occ[o + (w ? 2 : 0)]
      const y16 = (this.occ[o + 1] >>> (w ? 16 : 0)) & 0xffff
      const eighths = (this.occ[o + 3] >>> (w ? OCC_T_SHIFT_B : OCC_T_SHIFT_A)) & 7
      const b = decodeOccBox(xz, y16, eighths)
      if (!b) continue
      const r = this._slab3(ox, oy, oz, dx, dy, dz,
        gx * CELL + b.x0, base + b.y0, gz * CELL + b.z0, gx * CELL + b.x1, base + b.y1, gz * CELL + b.z1)
      if (!r || r.t < t0 || r.t > t1) continue
      if (eighths > 0) {
        if (w === 0) {
          seeT = r.t
          seeK = eighths / 8
        } else {
          seeT2 = r.t
          seeK2 = eighths / 8
        }
      } else if (!best || r.t < best.t) {
        best = { t: r.t, nx: r.nx, ny: r.ny, nz: r.nz, kind: 'furniture' }
      }
    }
    const tBest = best ? best.t : Infinity
    if (seeT < tBest) partial(seeT, seeK)
    if (seeT2 < tBest) partial(seeT2, seeK2)
    return best
  }

  // Ray vs an XZ square (infinite in y); entry t and face normal.
  _slab2(ox, oz, dx, dz, x0, z0, x1, z1) {
    let t0 = -Infinity
    let t1 = Infinity
    let nx = 0
    let nz = 0
    if (Math.abs(dx) < 1e-9) {
      if (ox < x0 || ox > x1) return null
    } else {
      let a = (x0 - ox) / dx
      let b = (x1 - ox) / dx
      if (a > b) [a, b] = [b, a]
      if (a > t0) {
        t0 = a
        nx = dx > 0 ? -1 : 1
        nz = 0
      }
      t1 = Math.min(t1, b)
    }
    if (Math.abs(dz) < 1e-9) {
      if (oz < z0 || oz > z1) return null
    } else {
      let a = (z0 - oz) / dz
      let b = (z1 - oz) / dz
      if (a > b) [a, b] = [b, a]
      if (a > t0) {
        t0 = a
        nx = 0
        nz = dz > 0 ? -1 : 1
      }
      t1 = Math.min(t1, b)
    }
    if (t0 > t1 || t1 < 0 || t0 < 0) return null
    return { t: t0, nx, nz }
  }

  // Ray vs an AABB; entry t and face normal (null if missed or inside).
  _slab3(ox, oy, oz, dx, dy, dz, x0, y0, z0, x1, y1, z1) {
    const o = [ox, oy, oz]
    const d = [dx, dy, dz]
    const lo = [x0, y0, z0]
    const hi = [x1, y1, z1]
    let t0 = -Infinity
    let t1 = Infinity
    let axis = -1
    for (let a = 0; a < 3; a++) {
      if (Math.abs(d[a]) < 1e-9) {
        if (o[a] < lo[a] || o[a] > hi[a]) return null
        continue
      }
      let ta = (lo[a] - o[a]) / d[a]
      let tb = (hi[a] - o[a]) / d[a]
      if (ta > tb) [ta, tb] = [tb, ta]
      if (ta > t0) {
        t0 = ta
        axis = a
      }
      t1 = Math.min(t1, tb)
    }
    if (t0 > t1 || t1 < 0 || t0 < 0 || axis < 0) return null
    const n = [0, 0, 0]
    n[axis] = d[axis] > 0 ? -1 : 1
    return { t: t0, nx: n[0], ny: n[1], nz: n[2] }
  }

  // Crossing the west/north edge of cell (ex, ez) at floor-local height yl.
  // Inside the slab band a crossing is only possible within a void, which
  // must be open on both sides.
  _crossing(axis, ex, ez, f, yl, ox, oz) {
    if (yl > WALL_H) {
      const both =
        this._flags(ex, ez, f) & FLAG_CEIL_HOLE && this._flags(ox, oz, f) & FLAG_CEIL_HOLE
      return both ? 1 : 0
    }
    const code = this._edge(axis, ex, ez, f)
    const o = EDGE_OPENINGS[code] ?? EDGE_OPENINGS[EDGE_WALL]
    return yl >= o.lo && yl <= o.hi ? o.t : 0
  }

  // Liang–Barsky test of the XZ segment against a column's square footprint.
  _columnBlocks(gx, gz, f, ax, az, dx, dz) {
    const flags = this._flags(gx, gz, f)
    if (!(flags & (FLAG_COLUMN | FLAG_PIER))) return false
    const half = flags & FLAG_PIER ? MONUMENTAL_COL_HALF : COL_HALF
    const cxw = (gx + 0.5) * CELL
    const czw = (gz + 0.5) * CELL
    let t0 = 0
    let t1 = 1
    const clip = (p, q) => {
      if (p === 0) return q >= 0
      const r = q / p
      if (p < 0) {
        if (r > t1) return false
        if (r > t0) t0 = r
      } else {
        if (r < t0) return false
        if (r < t1) t1 = r
      }
      return true
    }
    return (
      clip(-dx, ax - (cxw - half)) &&
      clip(dx, cxw + half - ax) &&
      clip(-dz, az - (czw - half)) &&
      clip(dz, czw + half - az) &&
      t0 <= t1
    )
  }

  // Every straight path between two cells of one floor stays inside their
  // bounding box. If no edge strictly inside that box is anything but a
  // full-height opening, and no column stands in it, the fixture is fully
  // visible from anywhere in the receiver cell — no sampling needed.
  _boxClear(ax, az, bx, bz, cy) {
    const x0 = Math.min(ax, bx)
    const x1 = Math.max(ax, bx)
    const z0 = Math.min(az, bz)
    const z1 = Math.max(az, bz)
    const local = cy === this._locCy
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        let west
        let north
        let flags
        if (local) {
          const o = ((z - this._locZ0) * LOCAL_W + (x - this._locX0)) * 3
          west = this._local[o]
          north = this._local[o + 1]
          flags = this._local[o + 2]
        } else {
          const t = this._texel(x, z, cy)
          if (t < 0) continue
          west = this.edge[t * 4]
          north = this.edge[t * 4 + 1]
          flags = this.edge[t * 4 + 2]
        }
        if (x > x0 && west !== EDGE_OPEN) return false
        if (z > z0 && north !== EDGE_OPEN) return false
        if (flags & (FLAG_COLUMN | FLAG_PIER)) return false
      }
    }
    return true
  }

  // Every lit fixture that any cell of the job's chunk can reference: the
  // chunk plus a REF_REACH margin, on the floors light can reach from this
  // chunk column. Gathered once per job instead of once per receiver.
  _gatherJobLamps(rec) {
    const out = this._jobLamps
    out.length = 0
    // Holed cells of every slab light could cross from this chunk column,
    // keyed by the slab's lower floor: a cross-floor segment must cross each
    // intermediate slab inside one of them.
    this._jobHoles.clear()
    const hx0 = rec.cx * CHUNK - REF_REACH
    const hz0 = rec.cz * CHUNK - REF_REACH
    const hspan = CHUNK + REF_REACH * 2
    for (let f = rec.cy - REF_FLOOR_REACH; f < rec.cy + REF_FLOOR_REACH; f++) {
      const cells = []
      for (let z = 0; z < hspan; z++) {
        for (let x = 0; x < hspan; x++) {
          const t = this._texel(hx0 + x, hz0 + z, f)
          if (t >= 0 && this.edge[t * 4 + 2] & FLAG_CEIL_HOLE) cells.push(hx0 + x, hz0 + z)
        }
      }
      if (cells.length) this._jobHoles.set(f, cells)
    }
    const x0 = rec.cx * CHUNK - REF_REACH
    const z0 = rec.cz * CHUNK - REF_REACH
    const span = CHUNK + REF_REACH * 2
    for (let df = -REF_FLOOR_REACH; df <= REF_FLOOR_REACH; df++) {
      const ly = rec.cy + df
      if (df !== 0 && !this._holesBetween(rec.cx, rec.cz, rec.cy, ly)) continue
      const lampY = layerY(ly) + LAMP_Y
      for (let z = 0; z < span; z++) {
        for (let x = 0; x < span; x++) {
          const lx = x0 + x
          const lz = z0 + z
          const t = this._texel(lx, lz, ly)
          if (t < 0 || !(this.edge[t * 4 + 2] & FLAG_LAMP)) continue
          const le = t * 4
          out.push({
            lx,
            lz,
            ly,
            df,
            lxw: (lx + 0.5) * CELL,
            lzw: (lz + 0.5) * CELL,
            lampY,
            tint: (this.lamp[le] + this.lamp[le + 1] * 2.4 + this.lamp[le + 2] * 0.3) / (3.7 * 255 * TINT_SCALE),
          })
        }
      }
    }
    return out
  }

  // Build the ranked light list of one receiver cell (the job's fixtures
  // must have been gathered by _gatherJobLamps for this cell's chunk).
  _buildList(gx, gz, cy) {
    const t = texelIndex(gx, gz, cy)
    const base = layerY(cy)
    const cxw = (gx + 0.5) * CELL
    const czw = (gz + 0.5) * CELL
    const minX = gx * CELL
    const minZ = gz * CELL
    let n = 0
    for (const L of this._jobLamps) {
      const dx = L.lx - gx
      const dz = L.lz - gz
      if (dx < -REF_REACH || dx > REF_REACH || dz < -REF_REACH || dz > REF_REACH) continue
      // Nearest point of the receiver cell volume to the fixture.
      const nx = L.lxw < minX ? minX : L.lxw > minX + CELL ? minX + CELL : L.lxw
      const nz = L.lzw < minZ ? minZ : L.lzw > minZ + CELL ? minZ + CELL : L.lzw
      const ny = L.lampY < base ? base : L.lampY > base + WALL_H ? base + WALL_H : L.lampY
      const rx = L.lxw - nx
      const ry = L.lampY - ny
      const rz = L.lzw - nz
      if (rx * rx + ry * ry + rz * rz >= LIGHT_RANGE * LIGHT_RANGE) continue
      const vis = this._visibility(gx, gz, cy, L.lx, L.lz, L.ly, L.lxw, L.lampY, L.lzw)
      if (vis <= 0) continue
      const dC = Math.hypot(L.lxw - cxw, L.lampY - (base + 1.0), L.lzw - czw)
      if (n >= this._entries.length) this._entries.push({ ref: 0, vis: 0, w: 0 })
      const entry = this._entries[n++]
      entry.ref = encodeRef(dx, dz, L.df)
      entry.vis = vis
      entry.w = (vis / VIS_FULL) * physicalAttenuation(Math.max(dC, 0.5)) * L.tint
    }
    // Rank by contribution; keep the strongest LIST_MAX (partial selection
    // sort: n is small and only the head matters).
    const entries = this._entries
    const keep = Math.min(n, LIST_MAX)
    for (let i = 0; i < keep; i++) {
      let best = i
      for (let j = i + 1; j < n; j++) if (entries[j].w > entries[best].w) best = j
      if (best !== i) {
        const tmp = entries[i]
        entries[i] = entries[best]
        entries[best] = tmp
      }
    }
    const o = t * LIST_UINTS
    for (let i = 0; i < LIST_UINTS; i++) {
      const a = i * 2 < keep ? entries[i * 2] : null
      const b = i * 2 + 1 < keep ? entries[i * 2 + 1] : null
      const lo = a ? packEntry(a.ref, a.vis) : REF_EMPTY
      const hi = b ? packEntry(b.ref, b.vis) : REF_EMPTY
      this.list[o + i] = (lo | (hi << 16)) >>> 0
    }
    this._computed[t] = 1
    this.stats.listCells++
    return keep
  }

  // 6-bit visibility of fixture cell (lx, lz, ly) from receiver cell
  // (gx, gz, cy). VIS_FULL only when provably unobstructed (bounding box
  // clear); otherwise the sampled fraction, capped below VIS_FULL so the
  // shader traces those fixtures per pixel.
  // Cheap necessary condition for a cross-floor path: every slab between the
  // floors needs a holed cell inside the XZ bounding box of the receiver and
  // fixture cells (any straight segment crosses the slab inside that box).
  _slabsPassable(gx, gz, cy, lx, lz, ly) {
    const x0 = Math.min(gx, lx)
    const x1 = Math.max(gx, lx)
    const z0 = Math.min(gz, lz)
    const z1 = Math.max(gz, lz)
    for (let f = Math.min(cy, ly); f < Math.max(cy, ly); f++) {
      const cells = this._jobHoles.get(f)
      if (!cells) return false
      let any = false
      for (let i = 0; i < cells.length && !any; i += 2) {
        any = cells[i] >= x0 && cells[i] <= x1 && cells[i + 1] >= z0 && cells[i + 1] <= z1
      }
      if (!any) return false
    }
    return true
  }

  _visibility(gx, gz, cy, lx, lz, ly, lxw, lampY, lzw) {
    if (ly !== cy && !this._slabsPassable(gx, gz, cy, lx, lz, ly)) {
      this.stats.blockedPairs++
      return 0
    }
    if (ly === cy) {
      if (this._boxClear(gx, gz, lx, lz, cy)) {
        this.stats.clearPairs++
        return VIS_FULL
      }
      if (!this._monotoneReachable(gx, gz, lx, lz, cy)) {
        this.stats.blockedPairs++
        return 0
      }
    }
    this.stats.sampledPairs++
    const base = layerY(cy)
    const local = ly === cy && cy === this._locCy
    let sum = 0
    for (const [rx, rz] of RECEIVER_XZ) {
      const px = gx * CELL + rx
      const pz = gz * CELL + rz
      for (const ry of RECEIVER_Y) {
        const py = base + ry
        for (const sx of LAMP_SAMPLES_X) {
          sum += local
            ? this._segmentLocal(px, py, pz, lxw + sx, lampY, lzw, base)
            : this.segment(px, py, pz, lxw + sx, lampY, lzw)
        }
      }
    }
    if (sum <= 0) return 0
    const frac = sum / SAMPLE_COUNT
    return Math.max(1, Math.min(VIS_FULL - 1, Math.round(frac * VIS_FULL)))
  }

  // Decode one cell's list: calls fn(lampX, lampY, lampZ, lampCy, vis01, texelOfLamp).
  forEachLight(gx, gz, cy, fn) {
    if (!this._cellMapped(gx, gz, cy)) return false
    const t = texelIndex(gx, gz, cy)
    if (!this._computed[t]) return false
    const o = t * LIST_UINTS
    for (let i = 0; i < LIST_MAX; i++) {
      const word = this.list[o + (i >> 1)]
      const e = (i & 1 ? word >>> 16 : word) & 0xffff
      const vis = e >>> 10
      const ref = e & 1023
      if (!vis || ref === REF_EMPTY) break
      decodeRef(ref, _ref)
      const lx = gx + _ref.dx
      const lz = gz + _ref.dz
      const ly = cy + _ref.df
      fn((lx + 0.5) * CELL, layerY(ly) + LAMP_Y, (lz + 0.5) * CELL, ly, vis / VIS_FULL, texelIndex(lx, lz, ly))
    }
    return true
  }

  // Scalar light level (0..1) for the AI and the fluorescent hum — the
  // wall-aware successor of ChunkManager.lightAt's radius sum. Same-floor
  // fixtures keep the legacy 2D cubic window (so open-room balance is
  // unchanged) scaled by their visibility; other floors use 3D distance.
  // Returns null where the grid has no data yet (caller falls back).
  lightAt(wx, wz, cy) {
    const gx = Math.floor(wx / CELL)
    const gz = Math.floor(wz / CELL)
    let acc = STALKER_AMBIENT
    const wy = layerY(cy)
    const ok = this.forEachLight(gx, gz, cy, (lx, ly, lz, lcy, vis) => {
      const d = lcy === cy ? Math.hypot(lx - wx, lz - wz) : Math.hypot(lx - wx, ly - wy, lz - wz)
      acc += vis * cubicAttenuation(d)
    })
    if (!ok) return null
    return acc < 1 ? acc : 1
  }

  // --- Cell-graph GI (chapter 12 §4.2) --------------------------------------

  // Direct irradiance on the six axis-facing surfaces of a cell (rgb x 6,
  // order +X -X +Y -Y +Z -Z), from its light list, in unit fixture power.
  _directCube(gx, gz, cy, out) {
    out.fill(0)
    const px = (gx + 0.5) * CELL
    const pz = (gz + 0.5) * CELL
    const py = layerY(cy) + WALL_H * 0.5
    const lamp = this.lamp
    // The bounce sees fixtures the way the physically based looks shade
    // them (GI is theirs alone): from the visible emitter, with a downward
    // diffuser (GI_EMIT_FLOOR at grazing). lightAt keeps the legacy point.
    this.forEachLight(gx, gz, cy, (lx, ly, lz, lcy, vis, lt) => {
      const vx = lx - px
      const vy = layerY(lcy) + GI_SOURCE_Y - py
      const vz = lz - pz
      const d = Math.hypot(vx, vy, vz)
      const emit = GI_EMIT_FLOOR + (1 - GI_EMIT_FLOOR) * Math.max(vy / Math.max(d, 1e-4), 0)
      const k = vis * physicalAttenuation(Math.max(d, 0.5)) * emit
      if (k <= 0) return
      const ix = vx / d
      const iy = vy / d
      const iz = vz / d
      const r = (lamp[lt * 4] / 255 / TINT_SCALE) * k
      const g = (lamp[lt * 4 + 1] / 255 / TINT_SCALE) * k
      const b = (lamp[lt * 4 + 2] / 255 / TINT_SCALE) * k
      const faces = [Math.max(0, ix), Math.max(0, -ix), Math.max(0, iy), Math.max(0, -iy), Math.max(0, iz), Math.max(0, -iz)]
      for (let f = 0; f < 6; f++) {
        out[f * 3] += r * faces[f]
        out[f * 3 + 1] += g * faces[f]
        out[f * 3 + 2] += b * faces[f]
      }
    })
    return out
  }

  // Openness of the boundary between a cell and its neighbour in direction
  // side (0 west, 1 east, 2 north, 3 south): 1 open, 0 wall, fractional for
  // partial openings (door lintel, window glazing, rail).
  _sideOpen(gx, gz, cy, side) {
    let code
    if (side === 0) code = this._edge(0, gx, gz, cy)
    else if (side === 1) code = this._edge(0, gx + 1, gz, cy)
    else if (side === 2) code = this._edge(1, gx, gz, cy)
    else code = this._edge(1, gx, gz + 1, cy)
    const o = EDGE_OPENINGS[code] ?? EDGE_OPENINGS[EDGE_WALL]
    return (Math.max(0, o.hi - o.lo) / WALL_H) * o.t
  }

  _solveGI(rec, rect) {
    // Expand by one cell: propagation reads neighbours and the shader's
    // stencil interpolates across the rect border.
    const lx0 = Math.max(0, rect[0] - 1)
    const lz0 = Math.max(0, rect[1] - 1)
    const lx1 = Math.min(CHUNK - 1, rect[2] + 1)
    const lz1 = Math.min(CHUNK - 1, rect[3] + 1)
    const w = lx1 - lx0 + 1
    const h = lz1 - lz0 + 1
    const cells = w * h
    const cy = rec.cy
    const gx0 = rec.cx * CHUNK + lx0
    const gz0 = rec.cz * CHUNK + lz0
    const E = new Float32Array(cells * 18) // per face: floor/ceiling/wall emission terms
    const open = new Float32Array(cells * 4)
    const holes = new Uint8Array(cells)
    const D = new Float32Array(18)
    const aF = this.albedo.floor
    const aC = this.albedo.ceiling
    const aW = this.albedo.wall
    for (let z = 0; z < h; z++) {
      for (let x = 0; x < w; x++) {
        const i = z * w + x
        const gx = gx0 + x
        const gz = gz0 + z
        this._directCube(gx, gz, cy, D)
        const o = i * 18
        for (let c = 0; c < 3; c++) {
          E[o + c] = aW[c] * D[c] // west wall (faces +X)
          E[o + 3 + c] = aW[c] * D[1 * 3 + c] // east wall (faces -X)
          E[o + 6 + c] = aF[c] * D[2 * 3 + c] // floor (faces +Y)
          E[o + 9 + c] = aC[c] * D[3 * 3 + c] // ceiling (faces -Y)
          E[o + 12 + c] = aW[c] * D[4 * 3 + c] // north wall (faces +Z)
          E[o + 15 + c] = aW[c] * D[5 * 3 + c] // south wall (faces -Z)
        }
        for (let s = 0; s < 4; s++) open[i * 4 + s] = this._sideOpen(gx, gz, cy, s)
        holes[i] = this._flags(gx, gz, cy) & (FLAG_CEIL_HOLE | FLAG_FLOOR_HOLE)
      }
    }
    const M = this._giM
    const sideTerm = (i, gx, gz, side, c) => {
      const op = open[i * 4 + side]
      const wallE = E[i * 18 + WALL_FACE_OFFSET[side] + c]
      if (op <= 0) return wallE
      const nx = gx + (side === 0 ? -1 : side === 1 ? 1 : 0)
      const nz = gz + (side === 2 ? -1 : side === 3 ? 1 : 0)
      const nm = this._cellMapped(nx, nz, cy) ? M[texelIndex(nx, nz, cy) * 3 + c] : 0
      return op * nm + (1 - op) * wallE
    }
    const vertTerm = (i, gx, gz, up, c) => {
      const face = up ? E[i * 18 + 9 + c] : E[i * 18 + 6 + c]
      const bit = up ? FLAG_CEIL_HOLE : FLAG_FLOOR_HOLE
      if (!(holes[i] & bit)) return face
      const ny = cy + (up ? 1 : -1)
      return this._cellMapped(gx, gz, ny) ? M[texelIndex(gx, gz, ny) * 3 + c] : 0
    }
    // Jacobi relaxation of the mean cell radiosity across open edges only:
    // light cannot cross a wall because walls contribute their own reflection
    // instead of the neighbour's value.
    const next = new Float32Array(cells * 3)
    for (let iter = 0; iter < 3; iter++) {
      for (let z = 0; z < h; z++) {
        for (let x = 0; x < w; x++) {
          const i = z * w + x
          const gx = gx0 + x
          const gz = gz0 + z
          for (let c = 0; c < 3; c++) {
            let s = vertTerm(i, gx, gz, true, c) + vertTerm(i, gx, gz, false, c)
            for (let side = 0; side < 4; side++) s += sideTerm(i, gx, gz, side, c)
            next[i * 3 + c] = s / 6
          }
        }
      }
      for (let z = 0; z < h; z++) {
        for (let x = 0; x < w; x++) {
          const i = z * w + x
          const m = texelIndex(gx0 + x, gz0 + z, cy) * 3
          M[m] = next[i * 3]
          M[m + 1] = next[i * 3 + 1]
          M[m + 2] = next[i * 3 + 2]
        }
      }
    }
    // Ambient cube: irradiance arriving at surfaces facing each axis.
    const A = new Float32Array(18)
    for (let z = 0; z < h; z++) {
      for (let x = 0; x < w; x++) {
        const i = z * w + x
        const gx = gx0 + x
        const gz = gz0 + z
        for (let c = 0; c < 3; c++) {
          const west = sideTerm(i, gx, gz, 0, c)
          const east = sideTerm(i, gx, gz, 1, c)
          const north = sideTerm(i, gx, gz, 2, c)
          const south = sideTerm(i, gx, gz, 3, c)
          const ceil = vertTerm(i, gx, gz, true, c)
          const floor = vertTerm(i, gx, gz, false, c)
          const avgSide = (west + east + north + south) * 0.25
          const vert = (ceil + floor) * 0.25
          A[c] = 0.5 * east + vert + 0.1 * avgSide // +X facing sees the east
          A[1 * 3 + c] = 0.5 * west + vert + 0.1 * avgSide
          A[2 * 3 + c] = 0.6 * ceil + 0.4 * avgSide // up-facing sees the ceiling
          A[3 * 3 + c] = 0.6 * floor + 0.4 * avgSide
          A[4 * 3 + c] = 0.5 * south + vert + 0.1 * avgSide // +Z facing sees the south
          A[5 * 3 + c] = 0.5 * north + vert + 0.1 * avgSide
        }
        this._writeGI(texelIndex(gx, gz, cy), A)
        this.stats.giCells++
      }
    }
    this._pushCellDirty(['gi'], gx0, gz0, cy, w, h)
  }

  _writeGI(t, A) {
    const L = (f) => lum(A[f * 3], A[f * 3 + 1], A[f * 3 + 2])
    const lx = L(0)
    const lxn = L(1)
    const ly = L(2)
    const lyn = L(3)
    const lz = L(4)
    const lzn = L(5)
    // Hemisphere chroma (luminance-normalised colour): the upper half is
    // dominated by the ceiling face, the lower by the floor bounce.
    const side = [0, 1, 2].map((c) => (A[c] + A[3 + c] + A[12 + c] + A[15 + c]) * 0.125)
    const up = [0, 1, 2].map((c) => A[6 + c] + side[c])
    const dn = [0, 1, 2].map((c) => A[9 + c] + side[c])
    const upL = Math.max(lum(up[0], up[1], up[2]), 1e-6)
    const dnL = Math.max(lum(dn[0], dn[1], dn[2]), 1e-6)
    const o = t * GI_TEXELS * 4
    const g = this.gi
    g[o] = toHalf(lx)
    g[o + 1] = toHalf(lxn)
    g[o + 2] = toHalf(lz)
    g[o + 3] = toHalf(lzn)
    g[o + 4] = toHalf(ly)
    g[o + 5] = toHalf(lyn)
    g[o + 6] = toHalf(up[0] / upL)
    g[o + 7] = toHalf(up[1] / upL)
    g[o + 8] = toHalf(up[2] / upL)
    g[o + 9] = toHalf(dn[0] / dnL)
    g[o + 10] = toHalf(dn[1] / dnL)
    g[o + 11] = toHalf(dn[2] / dnL)
  }

  // --- Upload bookkeeping -----------------------------------------------------

  _pushDirty(tex, x, y, w, h) {
    this._dirty[tex].push(x, y, w, h)
    this.revision++
  }

  // A cell rectangle -> texel rectangles, split where the toroidal window
  // wraps. GI texels are GI_TEXELS wide per cell.
  _pushCellDirty(texes, gx0, gz0, cy, w, h) {
    const x0 = texelX(gx0)
    const y0 = texelY(gz0, cy)
    const spans = (start, len, size) =>
      start + len <= size ? [[start, len]] : [[start, size - start], [0, start + len - size]]
    const slotBase = Math.floor(y0 / GRID_W) * GRID_W
    for (const [sx, sw] of spans(x0, w, GRID_W)) {
      for (const [sy, sh] of spans(y0 - slotBase, h, GRID_W)) {
        for (const tex of texes) {
          const k = tex === 'gi' ? GI_TEXELS : 1
          this._pushDirty(tex, sx * k, slotBase + sy, sw * k, sh)
        }
      }
    }
  }

  _markAllDirty() {
    this._pushDirty('edge', 0, 0, GRID_W, GRID_H)
    this._pushDirty('lamp', 0, 0, GRID_W, GRID_H)
    this._pushDirty('list', 0, 0, GRID_W, GRID_H)
    this._pushDirty('gi', 0, 0, GRID_W * GI_TEXELS, GRID_H)
    this._pushDirty('occ', 0, 0, GRID_W, GRID_H)
    this._pushDirty('owner', 0, 0, OWNER_W, OWNER_H)
  }

  // Hand the accumulated texel rectangles to the uploader and forget them.
  // Each list is flat [x, y, w, h, ...].
  takeDirty() {
    const out = this._dirty
    this._dirty = { edge: [], lamp: [], list: [], gi: [], occ: [], owner: [] }
    return out
  }
}

