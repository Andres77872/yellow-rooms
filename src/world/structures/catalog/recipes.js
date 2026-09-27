import { CHUNK } from '../../constants.js'
import { DIR_E, DIR_N, DIR_S, DIR_W, openWellCore } from './engine.js'

// Per-family structure catalog. Every recipe is drawn once in a FRAME —
// 14×14 (small, one chunk), 28×14 (medium, an adjacent pair, long along x)
// or 28×28 (large, a 2×2 block) — in frame cell coordinates, and then placed
// through one of the frame's symmetries (rotations/mirrors; a z-long pair is
// the transposed frame). A design returns:
//
//   fp        footprint rect (inside [1 .. S-2] so the ring stays in-frame)
//   levels(k) {voids, bridges} for storey k (0 = ground hall)
//   columns   ground-storey piers; piers: full-height piers
//   core      {x, z, dir, side?, enclosed?, doorSide?, well?} aligned switchback
//   links     'auto' (default when no core) | 'none'
//   extraFlights  add best-effort redundant flights in other chunks
//   glazing   'rail' | 'window'; deviation {kind, level}; label
//
// Frame rules the engine re-checks (and fails closed on): void rect edges
// never lie on a chunk seam (frame lines 14), deck rows/columns never touch
// a seam (13/14), the core sits inside one chunk's [1..12]², and every storey
// keeps its walkable cells connected to the ring. Research basis and the
// per-type references: docs/liminal-horror-design.md (structure catalog).

const R = (x0, z0, x1, z1) => ({ x0, z0, x1, z1 })

// ---- frame transforms ----------------------------------------------------------

const DIR_VEC = { [DIR_N]: [0, -1], [DIR_E]: [1, 0], [DIR_S]: [0, 1], [DIR_W]: [-1, 0] }
const vecDir = (dx, dz) => (dz < 0 ? DIR_N : dx > 0 ? DIR_E : dz > 0 ? DIR_S : DIR_W)
const PERP = { [DIR_E]: [0, 1], [DIR_W]: [0, 1], [DIR_S]: [1, 0], [DIR_N]: [1, 0] }
const horizontal = (d) => d === DIR_E || d === DIR_W

function makeTransform(frameW, frameH, { transpose, mx, mz }) {
  const W = transpose ? frameH : frameW
  const H = transpose ? frameW : frameH
  const vec = ([dx, dz]) => {
    let [x, z] = transpose ? [dz, dx] : [dx, dz]
    if (mx) x = -x
    if (mz) z = -z
    return [x, z]
  }
  const point = (x, z) => {
    let [px, pz] = transpose ? [z, x] : [x, z]
    if (mx) px = W - 1 - px
    if (mz) pz = H - 1 - pz
    return [px, pz]
  }
  const rect = (r) => {
    const [ax, az] = point(r.x0, r.z0)
    const [bx, bz] = point(r.x1, r.z1)
    return R(Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz))
  }
  return { W, H, vec, point, rect }
}

const FRAME_SIZE = { small: [CHUNK, CHUNK], medium: [2 * CHUNK, CHUNK], large: [2 * CHUNK, 2 * CHUNK] }

// Choose a symmetry for this slot and map the frame design into global cells.
function place(ctx, design) {
  const [fw, fh] = FRAME_SIZE[ctx.sizeClass]
  const square = fw === fh
  const transpose = square ? ctx.chance(0.5, 0x71) : ctx.d > ctx.w
  const t = makeTransform(fw, fh, { transpose, mx: ctx.chance(0.5, 0x72), mz: ctx.chance(0.5, 0x73) })
  if (t.W !== ctx.w * CHUNK || t.H !== ctx.d * CHUNK) return null
  const ox = ctx.cx0 * CHUNK
  const oz = ctx.cz0 * CHUNK
  const g = (r) => {
    const m = t.rect(r)
    return R(m.x0 + ox, m.z0 + oz, m.x1 + ox, m.z1 + oz)
  }
  const gp = (p) => {
    const [x, z] = t.point(p.x, p.z)
    return { gx: x + ox, gz: z + oz }
  }
  const levels = []
  for (let k = 0; k < ctx.levels; k++) {
    const level = k === 0 ? { voids: [], bridges: [] } : design.levels(k)
    levels.push({ voids: (level.voids ?? []).map(g), bridges: (level.bridges ?? []).map(g) })
  }
  let core = null
  if (design.core) {
    const c = design.core
    const dir = vecDir(...t.vec(DIR_VEC[c.dir]))
    const across = t.vec(PERP[c.dir].map((v) => v * (c.side ?? 1)))
    const perp = PERP[dir]
    const side = across[0] * perp[0] + across[1] * perp[1] > 0 ? 1 : -1
    const normal = horizontal(c.dir)
      ? [0, c.doorSide === 'far' ? 1 : -1]
      : [c.doorSide === 'far' ? 1 : -1, 0]
    const n = t.vec(normal)
    const doorSide = horizontal(dir) ? (n[1] < 0 ? 'near' : 'far') : (n[0] < 0 ? 'near' : 'far')
    const [lx, lz] = t.point(c.x, c.z)
    core = { gx: lx + ox, gz: lz + oz, dir, side, enclosed: !!c.enclosed, doorSide, well: !!c.well }
  }
  const deviation = design.deviation
    ? { kind: design.deviation.kind, levelCy: ctx.baseCy + design.deviation.level }
    : null
  return {
    label: design.label,
    bounds: g(design.fp),
    levels,
    columns: (design.columns ?? []).map(gp),
    piers: (design.piers ?? []).map(gp),
    core,
    links: design.links ?? (core ? 'core' : 'auto'),
    extraFlights: !!design.extraFlights,
    glazing: design.glazing ?? 'rail',
    bridgeAxis: design.bridgeAxis ? (t.vec(design.bridgeAxis === 'x' ? [1, 0] : [0, 1])[0] !== 0 ? 'x' : 'z') : undefined,
    deviation,
  }
}

const wellCore = (x, z, dir, side = 1) => openWellCore(x, z, dir, side)
const grid = (xs, zs) => xs.flatMap((x) => zs.map((z) => ({ x, z })))
const levelsWith = (fn) => (k) => fn(k)

// ---- OFFICE: corporate interiors ---------------------------------------------------

const OFFICE = [
  {
    type: 'stairHall', sizeClass: 'small', levels: [2, 4], weight: 3,
    // Compression → release: a switchback visible from a tall, empty hall.
    design: () => ({
      label: 'compression stair hall',
      fp: R(1, 1, 12, 12),
      core: { x: 3, z: 2, dir: DIR_E },
      levels: () => ({ voids: [R(2, 7, 11, 11)] }),
    }),
  },
  {
    type: 'lightWell', sizeClass: 'small', levels: [3, 6], weight: 3,
    // A glazed shaft through the floor plates; one storey's well is offset.
    design: (c) => {
      const odd = c.int(1, c.levels - 1, 1)
      return {
        label: 'glazed light well',
        fp: R(2, 2, 11, 11),
        glazing: 'window',
        levels: (k) => ({ voids: [k === odd ? R(6, 5, 9, 8) : R(5, 5, 8, 8)] }),
        deviation: c.levels > 2 ? { kind: 'offset well', level: odd } : null,
      }
    },
  },
  {
    type: 'sunkenBullpen', sizeClass: 'small', levels: [2, 2], weight: 2,
    // Prospect-refuge: a railed U-gallery overlooking a cubicle pit.
    design: () => ({
      label: 'sunken bullpen',
      fp: R(1, 1, 12, 12),
      columns: grid([4, 6, 8], [5, 7]),
      levels: () => ({ voids: [R(3, 3, 10, 9)] }),
    }),
  },
  {
    type: 'lightCourt', sizeClass: 'medium', levels: [4, 6], weight: 3,
    // Larkin / Bradbury skylit court ringed by galleries; one storey keeps a
    // lone bridge (the single deviation).
    design: (c) => {
      const lone = c.int(1, c.levels - 1, 2)
      return {
        label: 'galleried light court',
        fp: R(1, 1, 26, 12),
        core: { x: 2, z: 3, dir: DIR_S },
        extraFlights: true,
        levels: (k) => ({
          voids: [R(6, 4, 21, 9)],
          bridges: k === lone ? [R(c.chance(0.5, 3) ? 11 : 16, 4, c.chance(0.5, 3) ? 11 : 16, 9)] : [],
        }),
        deviation: { kind: 'lone bridge', level: lone },
      }
    },
  },
  {
    type: 'twinVoid', sizeClass: 'medium', levels: [3, 5], weight: 2,
    // Two offset voids either side of an aligned core; decks alternate.
    design: () => ({
      label: 'twin-void atrium',
      fp: R(1, 1, 26, 12),
      core: { x: 10, z: 3, dir: DIR_S },
      levels: (k) => ({
        voids: [R(2, 2, 8, 6), R(19, 7, 25, 11)],
        bridges: k % 2 === 1 ? [R(5, 2, 5, 6)] : [R(22, 7, 22, 11)],
      }),
    }),
  },
  {
    type: 'plantMezzanine', sizeClass: 'medium', levels: [2, 3], weight: 2,
    // Back-of-house machinery hall with a single catwalk above the blocks.
    design: () => ({
      label: 'plant-room mezzanine',
      fp: R(1, 1, 26, 12),
      columns: [...grid([4, 5], [5, 6, 7]), ...grid([9, 10], [5, 6, 7]), ...grid([17, 18], [5, 6, 7]), ...grid([22, 23], [5, 6, 7])],
      levels: () => ({ voids: [R(3, 4, 24, 9)], bridges: [R(3, 6, 24, 6)] }),
    }),
  },
  {
    type: 'bureauHall', sizeClass: 'large', levels: [5, 8], weight: 2,
    // Oldest-House great hall: galleries step back so the void widens upward;
    // bridges every third storey, one of them missing.
    design: (c) => {
      const missing = c.int(1, 3, 4) * 3
      return {
        label: 'bureau great hall',
        fp: R(1, 1, 26, 26),
        core: { x: 2, z: 2, dir: DIR_E },
        extraFlights: true,
        levels: (k) => {
          const s = Math.min(k - 1, 2)
          const v = R(7 - s, 7 - s, 20 + s, 20 + s)
          const bridges = k % 3 === 0 && k !== missing
            ? [(k / 3) % 2 === 1 ? R(v.x0, 12, v.x1, 12) : R(15, v.z0, 15, v.z1)]
            : []
          return { voids: [v], bridges }
        },
        deviation: missing < c.levels ? { kind: 'missing bridge', level: missing } : null,
      }
    },
  },
  {
    type: 'carceriAtrium', sizeClass: 'large', levels: [6, 10], weight: 1,
    // Piranesi office: every storey crosses the void on a different deck.
    design: () => ({
      label: 'carceri atrium',
      fp: R(1, 1, 26, 26),
      core: { x: 2, z: 2, dir: DIR_E },
      extraFlights: true,
      levels: (k) => ({
        voids: [R(8, 8, 19, 19)],
        bridges: [k % 4 === 1 ? R(8, 12, 19, 12) : k % 4 === 2 ? R(15, 8, 15, 19) : k % 4 === 3 ? R(8, 15, 19, 15) : R(12, 8, 12, 19)],
      }),
    }),
  },
]

// ---- HOTEL: endless residence ------------------------------------------------------------

const HOTEL = [
  {
    type: 'openWellStair', sizeClass: 'small', levels: [3, 6], weight: 3,
    // Chelsea-style open-well switchback; look down the well to the lobby.
    design: () => {
      const well = wellCore(4, 3, DIR_E)
      return {
        label: 'open-well grand stair',
        fp: R(2, 1, 10, 10),
        core: { x: 4, z: 3, dir: DIR_E, well: true },
        levels: () => ({ voids: [well.well] }),
      }
    },
  },
  {
    type: 'serviceCore', sizeClass: 'small', levels: [3, 6], weight: 2,
    // Back-of-house stair behind a staff door, with a glazed linen chute.
    design: (c) => ({
      label: 'service stair and linen chute',
      fp: R(2, 3, 10, 8),
      core: { x: 4, z: 5, dir: DIR_E, enclosed: true, doorSide: c.chance(0.5, 5) ? 'far' : 'near' },
      glazing: 'window',
      levels: () => ({ voids: [R(10, 5, 10, 6)] }),
    }),
  },
  {
    type: 'ballroomMezzanine', sizeClass: 'small', levels: [2, 3], weight: 2,
    // A narrow foyer opening into a double-height ballroom with a gallery.
    design: () => ({
      label: 'mezzanine ballroom',
      fp: R(1, 1, 12, 12),
      columns: [{ x: 3, z: 3 }, { x: 10, z: 3 }, { x: 3, z: 8 }, { x: 10, z: 8 }],
      levels: () => ({ voids: [R(4, 3, 9, 8)] }),
    }),
  },
  {
    type: 'portmanAtrium', sizeClass: 'medium', levels: [5, 11], weight: 3,
    // Portman atrium: single-loaded galleries facing a tall void; one storey
    // has a narrower gallery.
    design: (c) => {
      const narrow = c.int(1, c.levels - 1, 6)
      return {
        label: 'Portman atrium',
        fp: R(1, 1, 26, 12),
        core: { x: 2, z: 3, dir: DIR_S },
        extraFlights: true,
        levels: (k) => ({ voids: [k === narrow ? R(6, 4, 22, 10) : R(6, 4, 22, 9)] }),
        deviation: { kind: 'narrow gallery', level: narrow },
      }
    },
  },
  {
    type: 'motelCourt', sizeClass: 'medium', levels: [2, 3], weight: 2,
    // A motel's interior court: railed galleries round an empty yard.
    design: () => ({
      label: 'motel court',
      fp: R(1, 1, 26, 12),
      columns: grid([6, 10, 17, 21], [6]),
      levels: () => ({ voids: [R(4, 1, 23, 8)] }),
    }),
  },
  {
    type: 'grandAtrium', sizeClass: 'large', levels: [6, 12], weight: 2,
    // The atrium hotel: a 16×16 void, bridges every third storey (one gone).
    design: (c) => {
      const missing = c.int(1, 3, 7) * 3
      return {
        label: 'grand atrium',
        fp: R(1, 1, 26, 26),
        core: { x: 2, z: 2, dir: DIR_E },
        extraFlights: true,
        levels: (k) => ({
          voids: [R(6, 6, 21, 21)],
          bridges: k % 3 === 0 && k !== missing ? [(k / 3) % 2 === 1 ? R(6, 12, 21, 12) : R(15, 6, 15, 21)] : [],
        }),
        deviation: missing < c.levels ? { kind: 'missing bridge', level: missing } : null,
      }
    },
  },
  {
    type: 'ribcageAtrium', sizeClass: 'large', levels: [8, 12], weight: 1,
    // Marriott-Marquis twin chambers split by a spine; gallery depth breathes
    // storey by storey (the rib silhouette).
    design: () => ({
      label: 'ribcage double atrium',
      fp: R(1, 1, 26, 26),
      core: { x: 10, z: 3, dir: DIR_S },
      extraFlights: true,
      levels: (k) => ({
        voids: [R(k % 2 ? 3 : 4, 4, 8, 23), R(19, 4, k % 2 ? 24 : 23, 23)],
        bridges: k % 3 === 0 ? [R(k % 2 ? 3 : 4, 12, 8, 12), R(19, 15, k % 2 ? 24 : 23, 15)] : [],
      }),
    }),
  },
]

// ---- SEWER: bounded dry drains ---------------------------------------------------------------

const SEWER = [
  {
    type: 'dropShaft', sizeClass: 'small', levels: [3, 5], weight: 3,
    // Vortex drop shaft: a rounded shaft wrapped by landings.
    design: () => ({
      label: 'vortex drop shaft',
      fp: R(2, 2, 11, 11),
      levels: () => ({ voids: [R(5, 6, 8, 7), R(6, 5, 7, 8)] }),
    }),
  },
  {
    type: 'weirChamber', sizeClass: 'small', levels: [2, 2], weight: 2,
    // Overflow weir: a channel ending at a railed lip above the chamber.
    design: () => ({
      label: 'overflow weir chamber',
      fp: R(1, 1, 12, 12),
      columns: [{ x: 4, z: 8 }, { x: 9, z: 8 }],
      levels: () => ({ voids: [R(2, 5, 11, 11)] }),
    }),
  },
  {
    type: 'maintenanceStair', sizeClass: 'small', levels: [3, 5], weight: 2,
    // An enclosed maintenance stair between tunnel levels.
    design: (c) => ({
      label: 'maintenance stair',
      fp: R(3, 3, 10, 8),
      core: { x: 5, z: 5, dir: DIR_E, enclosed: true, doorSide: c.chance(0.5, 8) ? 'far' : 'near' },
      levels: () => ({ voids: [] }),
    }),
  },
  {
    type: 'cistern', sizeClass: 'medium', levels: [2, 3], weight: 3,
    // Yerebatan: a hypostyle of piers under a gallery and one boardwalk;
    // exactly one pier stands out of line.
    design: (c) => {
      const piers = grid([4, 6, 8, 10, 12, 15, 17, 19, 21, 23], [5, 7])
      const odd = c.int(0, piers.length - 1, 9)
      piers[odd] = { x: piers[odd].x, z: 8 }
      return {
        label: 'cistern hypostyle',
        fp: R(1, 1, 26, 12),
        columns: piers,
        levels: () => ({ voids: [R(3, 4, 24, 9)], bridges: [R(3, 6, 24, 6)] }),
        deviation: { kind: 'pier out of line', level: 0 },
      }
    },
  },
  {
    type: 'surgeChamber', sizeClass: 'medium', levels: [3, 5], weight: 2,
    // A riser shaft beside an enclosed stair; catwalks every other storey.
    design: (c) => ({
      label: 'surge chamber',
      fp: R(1, 1, 26, 12),
      core: { x: 17, z: 5, dir: DIR_E, enclosed: true, doorSide: c.chance(0.5, 10) ? 'far' : 'near' },
      levels: (k) => ({ voids: [R(3, 3, 10, 10)], bridges: k % 2 ? [R(3, 6, 10, 6)] : [] }),
    }),
  },
  {
    type: 'pumpOctagon', sizeClass: 'large', levels: [3, 3], weight: 1,
    // Crossness-style octagon of galleries around the engine blocks.
    design: () => ({
      label: 'pump-hall octagon',
      fp: R(1, 1, 26, 26),
      core: { x: 2, z: 2, dir: DIR_E },
      extraFlights: true,
      columns: grid([11, 12, 15, 16], [11, 12, 15, 16]),
      levels: () => ({ voids: [R(10, 8, 17, 19), R(8, 10, 19, 17)] }),
    }),
  },
  {
    type: 'pressureTank', sizeClass: 'large', levels: [3, 5], weight: 1,
    // G-Cans: a temple of piers under a perimeter gallery and one causeway.
    design: () => ({
      label: 'pressure-control tank',
      fp: R(1, 1, 26, 26),
      core: { x: 2, z: 2, dir: DIR_E },
      extraFlights: true,
      columns: grid([7, 11, 16, 20], [7, 11, 16, 20]),
      levels: () => ({ voids: [R(5, 5, 22, 22)], bridges: [R(5, 12, 22, 12)] }),
    }),
  },
  {
    type: 'stepwell', sizeClass: 'large', levels: [4, 6], weight: 2,
    // Chand Baori: terraces narrow toward the bottom; flights zig-zag down.
    design: (c) => ({
      label: 'stepwell cistern',
      fp: R(1, 1, 26, 26),
      extraFlights: true,
      levels: (k) => {
        const inset = 4 + 2 * (c.levels - 1 - k)
        return { voids: [R(inset, inset, 27 - inset, 27 - inset)] }
      },
    }),
  },
]

// ---- TOWER: brutalist megastructure --------------------------------------------------------------

const TOWER = [
  {
    type: 'serviceShaft', sizeClass: 'small', levels: [4, 8], weight: 3,
    design: (c) => {
      const cross = c.int(1, c.levels - 1, 11)
      return {
        label: 'service shaft',
        fp: R(2, 2, 11, 11),
        levels: (k) => ({ voids: [R(5, 4, 8, 9)], bridges: k === cross ? [R(5, 6, 8, 6)] : [] }),
        deviation: { kind: 'single catwalk', level: cross },
      }
    },
  },
  {
    type: 'stairCore', sizeClass: 'small', levels: [4, 8], weight: 3,
    // Trellick-style detached service core (vertical circulation).
    design: (c) => ({
      label: 'concrete stair core',
      fp: R(3, 4, 10, 9),
      core: { x: 5, z: 6, dir: DIR_E, enclosed: true, doorSide: c.chance(0.5, 12) ? 'far' : 'near' },
      levels: () => ({ voids: [] }),
    }),
  },
  {
    type: 'dropGallery', sizeClass: 'small', levels: [3, 4], weight: 2,
    design: () => ({
      label: 'drop gallery',
      fp: R(1, 1, 12, 12),
      core: { x: 3, z: 2, dir: DIR_E },
      levels: () => ({ voids: [R(2, 8, 11, 11), R(9, 2, 11, 7)] }),
    }),
  },
  {
    type: 'carceriNave', sizeClass: 'medium', levels: [3, 5], weight: 3,
    // Carceri nave: every storey crosses on a deck at a different station.
    design: () => ({
      label: 'carceri nave',
      fp: R(1, 1, 26, 12),
      extraFlights: true,
      levels: (k) => ({ voids: [R(3, 4, 24, 9)], bridges: [R([6, 11, 17, 21][k % 4], 4, [6, 11, 17, 21][k % 4], 9)] }),
    }),
  },
  {
    type: 'splitParking', sizeClass: 'medium', levels: [4, 5], weight: 2,
    // Car-park decks around a light slot; piers on every level.
    design: () => ({
      label: 'split-level car park',
      fp: R(1, 1, 26, 12),
      piers: grid([4, 7, 10, 17, 20, 23], [2, 11]),
      extraFlights: true,
      levels: () => ({ voids: [R(3, 6, 24, 7)] }),
    }),
  },
  {
    type: 'highwalkPodium', sizeClass: 'large', levels: [3, 3], weight: 2,
    // Barbican highwalk: courts at podium level, highwalks over the gap.
    design: () => ({
      label: 'highwalk podium',
      fp: R(1, 1, 26, 26),
      core: { x: 2, z: 2, dir: DIR_E },
      extraFlights: true,
      levels: (k) => (k === 1
        ? { voids: [R(3, 8, 10, 12), R(17, 17, 24, 24)] }
        : { voids: [R(3, 15, 24, 19)], bridges: [R(7, 15, 7, 19), R(20, 15, 20, 19)] }),
    }),
  },
  {
    type: 'panopticWell', sizeClass: 'large', levels: [5, 9], weight: 2,
    // Presidio Modelo: a watchtower island in an annular void. Every storey
    // reaches it by a pinwheel of four radial bridges (one per chunk, so each
    // chunk's quarter of the tower keeps its own way back to the gallery).
    design: (c) => {
      const dark = c.int(1, c.levels - 1, 16)
      return {
        label: 'panoptic well',
        fp: R(1, 1, 26, 26),
        core: { x: 2, z: 2, dir: DIR_E },
        extraFlights: true,
        levels: (k) => ({
          voids: [R(5, 5, 22, 10), R(5, 17, 22, 22), R(5, 11, 10, 16), R(17, 11, 22, 16)],
          bridges: [R(12, 5, 12, 10), R(17, 12, 22, 12), R(15, 17, 15, 22), R(5, 15, 10, 15)]
            .map((b, i) => (k === dark && i === 0 ? R(11, 5, 11, 10) : b)),
        }),
        deviation: { kind: 'shifted bridge', level: dark },
      }
    },
  },
  {
    type: 'megaWell', sizeClass: 'large', levels: [6, 10], weight: 2,
    // A cooling-tower void crossed by alternating decks.
    design: () => ({
      label: 'megastructure well',
      fp: R(1, 1, 26, 26),
      core: { x: 2, z: 2, dir: DIR_E },
      extraFlights: true,
      levels: (k) => ({ voids: [R(6, 6, 21, 21)], bridges: k % 2 ? [R(6, 12, 21, 12)] : [R(15, 6, 15, 21)] }),
    }),
  },
]

// ---- LATTICE: catwalk city ---------------------------------------------------------------------

const LATTICE = [
  {
    type: 'stairPylon', sizeClass: 'small', levels: [3, 6], weight: 3,
    design: (c) => ({
      label: 'stair pylon',
      fp: R(3, 4, 10, 9),
      core: { x: 5, z: 6, dir: DIR_E, enclosed: true, doorSide: c.chance(0.5, 13) ? 'far' : 'near' },
      levels: () => ({ voids: [] }),
    }),
  },
  {
    type: 'gantryCrossing', sizeClass: 'small', levels: [2, 3], weight: 3,
    // Two crossing catwalks over a gap (Otherworld grating).
    design: () => ({
      label: 'gantry crossing',
      fp: R(1, 1, 12, 12),
      levels: () => ({ voids: [R(4, 4, 11, 11)], bridges: [R(4, 7, 11, 7), R(8, 4, 8, 11)] }),
    }),
  },
  {
    type: 'terraceStep', sizeClass: 'small', levels: [3, 3], weight: 2,
    design: () => ({
      label: 'terrace step-down',
      fp: R(1, 1, 12, 12),
      levels: (k) => ({ voids: [k === 1 ? R(8, 2, 11, 11) : R(2, 8, 11, 11)] }),
    }),
  },
  {
    type: 'escalatorSpine', sizeClass: 'medium', levels: [3, 5], weight: 3,
    // Mid-Levels escalator: a roofed spine between two drops.
    design: () => ({
      label: 'escalator spine',
      fp: R(1, 1, 26, 12),
      extraFlights: true,
      levels: () => ({ voids: [R(2, 1, 25, 3), R(2, 10, 25, 12)] }),
    }),
  },
  {
    type: 'hangingDecks', sizeClass: 'medium', levels: [3, 5], weight: 2,
    design: () => ({
      label: 'hanging decks',
      fp: R(1, 1, 26, 12),
      extraFlights: true,
      levels: (k) => ({ voids: [R(3, 4, 24, 9)], bridges: [k % 2 ? R(3, 5, 24, 5) : R(3, 8, 24, 8)] }),
    }),
  },
  {
    type: 'rooftopNetwork', sizeClass: 'large', levels: [3, 4], weight: 2,
    // Kowloon rooftops: alleys between blocks, improvised bridges above.
    design: (c) => ({
      label: 'rooftop network',
      fp: R(1, 1, 26, 26),
      core: { x: 2, z: 2, dir: DIR_E },
      extraFlights: true,
      levels: (k) => ({
        voids: [R(3, 8, 24, 9), R(3, 18, 24, 19)],
        bridges: [R([6, 11, 16, 21][(k + c.int(0, 3, 14)) % 4], 8, [6, 11, 16, 21][(k + c.int(0, 3, 14)) % 4], 9),
          R([21, 16, 11, 6][k % 4], 18, [21, 16, 11, 6][k % 4], 19)],
      }),
    }),
  },
  {
    type: 'moduleHill', sizeClass: 'large', levels: [4, 5], weight: 2,
    // Habitat 67: stacked modules; each storey's roof is the terrace above.
    design: () => ({
      label: 'stacked-module hill',
      fp: R(1, 1, 26, 26),
      core: { x: 2, z: 2, dir: DIR_E },
      extraFlights: true,
      levels: (k) => ({ voids: [R(27 - 5 * k, 27 - 5 * k, 25, 25)] }),
    }),
  },
  {
    type: 'abyss', sizeClass: 'large', levels: [4, 6], weight: 1,
    // Blame!-scale abyss: a perimeter gallery and one processional bridge.
    design: (c) => {
      const walk = c.int(1, c.levels - 1, 15)
      return {
        label: 'megastructure abyss',
        fp: R(1, 1, 26, 26),
        core: { x: 2, z: 2, dir: DIR_E },
        extraFlights: true,
        levels: (k) => ({ voids: [R(5, 5, 22, 22)], bridges: k === walk ? [R(5, 15, 22, 15)] : [] }),
        deviation: { kind: 'processional bridge', level: walk },
      }
    },
  },
]


// Browser/tooltip text per type: [what the player meets, real-world reference].
export const CATALOG_ABOUT = Object.freeze({
  stairHall: ['A switchback climbs beside a tall empty hall — compression, then release.', 'Frank Lloyd Wright compression and release'],
  lightWell: ['A glazed shaft through every floor plate; one storey’s well sits off-axis.', 'Office light wells; Exit 8 single deviation'],
  sunkenBullpen: ['A railed U-gallery overlooking a pit of cubicle columns.', 'Prospect–refuge (Appleton)'],
  lightCourt: ['A skylit court ringed by galleries on every floor; one storey keeps a lone bridge.', 'Larkin Administration Building; Bradbury Building'],
  twinVoid: ['Two offset voids either side of an aligned stair core; decks alternate by storey.', 'Double atria; aligned-core wayfinding (Hölscher)'],
  plantMezzanine: ['A machinery hall of sealed blocks under a single steel catwalk.', 'Back-of-house plant rooms; Control’s mail room'],
  bureauHall: ['A great hall whose galleries step back upward; a bridge every third storey, one missing.', 'Control’s Oldest House; 33 Thomas St'],
  carceriAtrium: ['Every storey crosses a central void on a different deck.', 'Piranesi, Carceri d’invenzione'],
  openWellStair: ['An open-well switchback: look straight down the well to the lobby.', 'Hotel Chelsea stair'],
  serviceCore: ['A staff stair behind a door, beside a glazed linen chute.', 'Back-of-house hotel service cores'],
  ballroomMezzanine: ['A double-height ballroom behind a narrow foyer, with a gallery on three sides.', 'Grand-hotel ballrooms'],
  portmanAtrium: ['Single-loaded galleries facing a tall void; one storey’s gallery is narrower.', 'John Portman, Hyatt Regency Atlanta'],
  motelCourt: ['Railed exterior-style galleries around an empty interior yard.', 'Motel courts; Augé’s non-places'],
  grandAtrium: ['A 16×16 atrium with bridges every third storey — one of them gone.', 'Atrium hotels (Portman)'],
  ribcageAtrium: ['Twin chambers split by a spine; gallery depth breathes storey by storey.', 'Atlanta Marriott Marquis'],
  dropShaft: ['A rounded shaft wrapped by landings, descending into dark.', 'Vortex drop shafts (Thames Tideway)'],
  weirChamber: ['A channel ends at a railed weir lip above the lower chamber.', 'Storm-overflow weir chambers'],
  maintenanceStair: ['An enclosed maintenance stair linking tunnel levels.', 'Sewer access shafts'],
  cistern: ['A hypostyle of piers under a gallery and a single boardwalk; one pier out of line.', 'Basilica (Yerebatan) Cistern'],
  surgeChamber: ['A riser shaft beside an enclosed stair, crossed by catwalks every other storey.', 'Gallery-type surge tanks'],
  pumpOctagon: ['An octagon of galleries around sealed engine blocks.', 'Crossness Pumping Station'],
  pressureTank: ['A temple of piers under a perimeter gallery and one causeway.', 'G-Cans (Metropolitan Outer Underground Discharge Channel)'],
  stepwell: ['Terraces narrow toward the bottom; flights zig-zag down the well.', 'Chand Baori stepwell'],
  serviceShaft: ['A tall service shaft; exactly one storey crosses it on a catwalk.', 'Brutalist service cores'],
  stairCore: ['A detached concrete stair core, the tower’s vertical spine.', 'Trellick Tower service tower'],
  dropGallery: ['An L-shaped drop around an open switchback.', 'Brutalist galleries'],
  carceriNave: ['A nave crossed by a deck at a different station on every storey.', 'Piranesi, Carceri d’invenzione'],
  splitParking: ['Car-park decks around a light slot, piers on every level.', 'Split-level (d’Humy) car parks'],
  highwalkPodium: ['Courts at podium level and highwalks over the gap: which floor is ground?', 'Barbican highwalks; Chongqing'],
  panopticWell: ['A watchtower island in an annular void, reached by four radial bridges.', 'Presidio Modelo; Bentham’s panopticon'],
  megaWell: ['A cooling-tower void crossed by decks that alternate axis every storey.', 'Megastructures; Blame!'],
  stairPylon: ['An enclosed stair pylon standing among the catwalks.', 'Kowloon stairways; Habitat 67 cores'],
  gantryCrossing: ['Two catwalks cross over a railed gap.', 'Silent Hill Otherworld gratings'],
  terraceStep: ['Platforms stepping down diagonally, joined by flights.', 'Chand Baori at miniature scale'],
  escalatorSpine: ['A roofed spine between two drops, climbing chunk by chunk.', 'Central–Mid-Levels escalator'],
  hangingDecks: ['Stacked decks hung over a void, alternating lines each storey.', 'Industrial catwalk mezzanines'],
  rooftopNetwork: ['Rooftop blocks between alleys, joined by improvised bridges.', 'Kowloon Walled City'],
  moduleHill: ['Stacked modules: each storey’s roof becomes the terrace above.', 'Habitat 67'],
  abyss: ['A perimeter gallery around an abyss; one storey carries a processional bridge.', 'Blame!; Piranesi'],
})

const CHUNKS = { small: [[1, 1]], medium: [[2, 1], [1, 2]], large: [[2, 2]] }

function register(family, list) {
  return Object.freeze(list.map((r) => Object.freeze({
    family,
    type: r.type,
    sizeClass: r.sizeClass,
    levels: r.levels,
    weight: r.weight ?? 1,
    chunks: CHUNKS[r.sizeClass],
    about: CATALOG_ABOUT[r.type]?.[0] ?? '',
    reference: CATALOG_ABOUT[r.type]?.[1] ?? '',
    build: (ctx) => {
      const design = r.design(ctx)
      if (!design) return null
      const plan = place(ctx, { ...design, levels: levelsWith(design.levels) })
      return plan
    },
  })))
}

export const CATALOG_RECIPES = Object.freeze({
  office: register('office', OFFICE),
  hotel: register('hotel', HOTEL),
  sewer: register('sewer', SEWER),
  tower: register('tower', TOWER),
  lattice: register('lattice', LATTICE),
})

export function recipesFor(family) {
  return CATALOG_RECIPES[family] ?? []
}

// Labels for editors (type -> human label), filled lazily from a dry design.
export const CATALOG_TYPE_INFO = Object.freeze(Object.fromEntries(
  Object.entries({ office: OFFICE, hotel: HOTEL, sewer: SEWER, tower: TOWER, lattice: LATTICE }).flatMap(([family, list]) =>
    list.map((r) => [`${family}:${r.type}`, Object.freeze({ family, type: r.type, sizeClass: r.sizeClass, levels: r.levels })])
  )
))

