import { CHUNK, cIdx } from '../../constants.js'
import { hash3i } from '../../core/hash.js'
import { worldConfigForFamily } from '../../mapFamily.js'
import { MAP_FAMILY_SEWER } from '../../mapTypes.js'
import { SPACE_ROOM, SURFACE_THEMES, decayAt, mixHex, roomContext, worldSurfaceSet } from '../../surfaceSet.js'

// Furniture palette — per-part tints applied over a white base material
// (see gbufferMaterials.js). Design language: the same bold flat shapes as
// the joinery — readable silhouettes first (desktop line, chair back,
// cabinet doors, copier lid, bottle neck, leaf cross), panel gaps and
// handles as thin proud slabs that catch the ink outline. These are the
// catalogue colours; furnitureTint() below is the batch a building bought.
export const FURN_TINT = {
  laminate: [0.74, 0.68, 0.58], // desk/table tops
  legMetal: [0.32, 0.31, 0.3],
  panel: [0.62, 0.58, 0.5], // modesty panels, drawer cases
  drawerFace: [0.7, 0.64, 0.54],
  screen: [0.1, 0.11, 0.13],
  keyDark: [0.16, 0.16, 0.17],
  fabric: [0.3, 0.34, 0.42], // chair upholstery
  cabinetPaint: [0.66, 0.67, 0.63],
  copierBody: [0.78, 0.79, 0.75],
  slotDark: [0.14, 0.14, 0.15],
  coolerWhite: [0.88, 0.9, 0.88],
  bottleBlue: [0.55, 0.75, 0.9],
  potClay: [0.52, 0.34, 0.24],
  soil: [0.2, 0.15, 0.1],
  leafGreen: [0.28, 0.48, 0.28],
  rackDark: [0.16, 0.17, 0.19], // server rack body
  rackFace: [0.22, 0.23, 0.26], // rack front panel
  ledGreen: [0.4, 1.0, 0.55], // status LEDs
  paperWhite: [0.9, 0.88, 0.8], // paper stacks, flat files
  sofa: [0.4, 0.32, 0.26], // lobby couch body
  sofaCushion: [0.47, 0.38, 0.31], // loose cushions
  shelfWood: [0.5, 0.4, 0.28], // bookshelf carcass
  bookRed: [0.55, 0.2, 0.16],
  bookBlue: [0.2, 0.3, 0.5],
  bookTan: [0.62, 0.52, 0.36],
  boardWhite: [0.92, 0.93, 0.94], // whiteboard enamel
  // Residential set (hotel family) — warm domestic woods, porcelain,
  // appliance enamel. Same flat-shape language as the office pieces.
  bedFrame: [0.45, 0.34, 0.24], // bed frame + headboard wood
  mattress: [0.88, 0.86, 0.78], // mattress + box spring
  blanket: [0.5, 0.3, 0.3], // folded blanket band
  pillow: [0.93, 0.92, 0.86], // pillows
  shade: [0.9, 0.85, 0.7], // lamp shades (warm parchment)
  woodDark: [0.38, 0.29, 0.2], // nightstand/wardrobe carcass
  woodMid: [0.55, 0.43, 0.3], // drawer/door fronts
  porcelain: [0.92, 0.93, 0.92], // toilet, tub, basin
  chrome: [0.75, 0.78, 0.8], // taps, towel bars
  mirror: [0.68, 0.78, 0.82], // vanity mirror glass
  towel: [0.55, 0.68, 0.72], // hung towel accent
  applianceWhite: [0.9, 0.91, 0.89], // fridge/washer/stove enamel
  applianceSteel: [0.6, 0.62, 0.64], // range hob plate, washer trim
  burner: [0.12, 0.12, 0.13], // stove burners, oven window
  counterTop: [0.78, 0.76, 0.7], // kitchen worktop
  tvBlack: [0.07, 0.08, 0.09], // TV panel
  rug: [0.42, 0.28, 0.26], // armchair seat blanket accent
}

// --- Batch tint -------------------------------------------------------------
// Furniture is bought, not rolled. The per-instance multiplier over the
// catalogue colours (GLB vertex colours, or the FURN_TINT parts of the box
// fallback) used to drift per CELL, so one room's chairs came from different
// batches and the palette ignored the building around them. Now, top down:
//   * the world's refit theme (surfaceSet.js) leans every piece a little
//     toward its accent — the decade the building was last furnished in;
//   * the department (planner district) buys each kind in one batch: a
//     small brightness / warm-cool drift per (district, kind);
//   * every room of it keeps its own lot: a smaller drift per (room, kind),
//     so all chairs of a room match exactly and the next room's barely differ;
//   * wear follows the room's decay (the same field its floor ages with; a
//     room reaching past its chunk reads its department's, see wearAnchor):
//     derelict wings get slightly darker, dustier, flatter pieces.
// Every channel stays within about +-8% of 1 so the modelled colours survive.
// Keyed on roomContext's stable space key and the district, never the cell:
// the chunks a room spans agree, and a reload never re-rolls it.

const SALT_FURN = 0xf0b7
const unit = (h) => h / 4294967296
const smooth01 = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

// Theme lean per channel: the theme's accent (with a little of its wood)
// normalised to unit luma, scaled to at most +-2.2%. Near-neutral themes
// (clinic, corporate) barely tint at all.
const themeLeans = new Map()
function themeLean(id) {
  let lean = themeLeans.get(id)
  if (lean) return lean
  const theme = SURFACE_THEMES.find((t) => t.id === id)
  lean = [0, 0, 0]
  if (theme) {
    const n = parseInt(mixHex(theme.accent, theme.wood, 0.35).slice(1), 16)
    const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    const luma = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
    const dev = c.map((v) => v / Math.max(1, luma) - 1)
    const peak = Math.max(...dev.map(Math.abs))
    const k = peak > 0 ? Math.min(0.12, 0.022 / peak) : 0
    lean = dev.map((v) => v * k)
  }
  themeLeans.set(id, lean)
  return lean
}

// District lattice of the family's planner (zones/officePlan.js
// officeDistrictCoords: district dx spans chunks dx*n - off .. +n-1).
const lattices = new Map()
function districtLattice(family) {
  let l = lattices.get(family)
  if (l) return l
  let office = {}
  try {
    office = worldConfigForFamily(family).office ?? {}
  } catch {
    // Unknown family (editor maps): the planner defaults.
  }
  const int = (v, fallback, min) => Math.max(min, Math.floor(Number.isFinite(v) ? v : fallback))
  const n = int(office.districtChunks, 3, 2)
  l = { n, off: int(office.districtOffset, 0, 0) % n }
  lattices.set(family, l)
  return l
}

// Nominal centre (global cells) of the chunk's department: the planner
// district, else surfaceSet's 3x3-chunk block. A room never straddles two
// districts (planner space ids are per district), so every chunk of it
// samples the same point.
function departmentCentre(data) {
  const d = data.district
  if (d) {
    const { n, off } = districtLattice(data.mapFamily)
    return [(d.dx * n - off + n / 2) * CHUNK, (d.dz * n - off + n / 2) * CHUNK]
  }
  return [(Math.floor(data.cx / 3) * 3 + 1.5) * CHUNK, (Math.floor(data.cz / 3) * 3 + 1.5) * CHUNK]
}

// Where a lot reads its wear (global cells). A space whose cells in this
// chunk keep off the chunk border lies wholly inside it (a sewer chamber's
// key is per chunk anyway): its own centroid, so the pieces age with the
// floor they stand on. One touching the border may run on next door, and
// that chunk must reach the same answer without reading this one: the
// department's nominal centre, coarser but shared by every chunk of it.
function wearAnchor(data, lx, lz, ctx) {
  const id = data.spaceId[cIdx(lx, lz)]
  if (!id) return departmentCentre(data)
  const chunkKeyed = ctx.cls === SPACE_ROOM && data.mapFamily === MAP_FAMILY_SEWER
  const last = CHUNK - 1
  let sx = 0
  let sz = 0
  let n = 0
  for (let z = 0; z < CHUNK; z++) {
    for (let x = 0; x < CHUNK; x++) {
      if (data.spaceId[cIdx(x, z)] !== id) continue
      if (!chunkKeyed && (x === 0 || z === 0 || x === last || z === last)) return departmentCentre(data)
      sx += x
      sz += z
      n++
    }
  }
  return [data.cx * CHUNK + sx / n, data.cz * CHUNK + sz / n]
}

// The wear (0..1, surfaceSet.js decayAt) furniture record `f`'s lot shows:
// one value for every piece of its room.
export function furnitureWear(data, f, set = worldSurfaceSet(data.mapFamily, data.worldSeed), ctx = roomContext(data, f.lx, f.lz, set)) {
  const [ax, az] = wearAnchor(data, f.lx, f.lz, ctx)
  return decayAt(set, ax, az, data.cy | 0, ctx)
}

// [r, g, b] multiplier for furniture record `f` of `data` (written into `out`).
export function furnitureTint(data, f, set = worldSurfaceSet(data.mapFamily, data.worldSeed), out = [1, 1, 1]) {
  const ctx = roomContext(data, f.lx, f.lz, set)
  const w = smooth01(0.45, 1, furnitureWear(data, f, set, ctx))
  const s = set.seed ^ SALT_FURN
  const dept = hash3i(s, ctx.district, f.kind, 1)
  const lot = hash3i(s, ctx.key, f.kind, 2)
  const b = (1 + (unit(dept) - 0.5) * 0.036 + (unit(lot) - 0.5) * 0.02) * (1 - 0.03 * w)
  // Wear flattens the batch's lean and the theme toward a dusty neutral.
  const keep = 1 - 0.6 * w
  const lean = (unit(hash3i(s, ctx.district, f.kind, 3)) - 0.5) * 0.016 * keep
  const t = themeLean(set.theme)
  out[0] = b * (1 + lean + t[0] * keep + 0.012 * w)
  out[1] = b * (1 + t[1] * keep + 0.004 * w)
  out[2] = b * (1 - lean + t[2] * keep - 0.012 * w)
  return out
}
