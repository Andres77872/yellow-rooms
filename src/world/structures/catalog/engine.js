import { CHUNK } from '../../constants.js'
import { deepFreeze } from '../../mapFamily.js'

// Structure catalog engine (v26). A catalog structure is ONE immutable,
// plain-JSON descriptor that any participant chunk re-derives from the root
// seed (see ./index.js). It generalizes the office atrium slice model:
//
//   footprint  globalBounds (inclusive cells), inset one cell inside its
//              participant chunks so the one-cell walkable RING around it
//              never leaves them.
//   levels     one entry per storey baseCy..topCy. Level 0 is the ground
//              hall (no voids). Level k>0 lists `voids` (floor openings onto
//              level k-1) and `bridges` (walkable decks retained inside a
//              void), both as inclusive global rects.
//   columns    ground-storey piers (hypostyle halls, machinery blocks);
//   piers      piers rising through every storey (parking decks, colonnades).
//   links      verticalLinks — the canonical stair descriptor per slab, the
//              only vertical connector every walk audit understands.
//   core       optional aligned switchback core (same cells every storey),
//              optionally enclosed with one door per storey.
//
// Every level keeps all walkable cells connected to the ring, and the ring is
// carved open around the footprint, so a structure can never strand a pocket
// of its floor: paths the footprint interrupts re-route through the ring (the
// same monotone-carve argument as stair halos). Voids are always guarded
// (rails or glazing) and never lethal.

export const CATALOG_SIZE_CLASSES = Object.freeze(['small', 'medium', 'large'])

export const CATALOG_KINDS = Object.freeze({
  office: 'officeCatalog',
  hotel: 'hotelCatalog',
  sewer: 'sewerCatalog',
  tower: 'towerCatalog',
  lattice: 'latticeCatalog',
})
const CATALOG_KIND_SET = new Set(Object.values(CATALOG_KINDS))
export const isCatalogKind = (kind) => CATALOG_KIND_SET.has(kind)
export const isCatalogStructure = (structure) =>
  structure?.hasRoom === true && isCatalogKind(structure.kind)

// Stair directions mirror structures/slab.js (duplicated to keep this module
// free of the contract.js <-> slab.js import cycle).
export const DIR_N = 0
export const DIR_E = 1
export const DIR_S = 2
export const DIR_W = 3
const DX = [0, 1, 0, -1]
const DZ = [-1, 0, 1, 0]
const AXIS = {
  [DIR_E]: { a: [1, 0], p: [0, 1] },
  [DIR_W]: { a: [-1, 0], p: [0, 1] },
  [DIR_S]: { a: [0, 1], p: [1, 0] },
  [DIR_N]: { a: [0, -1], p: [1, 0] },
}
const OPPOSITE = { [DIR_E]: DIR_W, [DIR_W]: DIR_E, [DIR_S]: DIR_N, [DIR_N]: DIR_S }

// Cell classes of the per-level raster over the carve box (bounds ± 1).
export const CELL_CLASS_RING = 1
export const CELL_CLASS_SOLID = 2
export const CELL_CLASS_VOID = 3
export const CELL_CLASS_BRIDGE = 4
export const CELL_CLASS_COLUMN = 5

const floorDiv = (a, b) => Math.floor(a / b)
const local = (g) => ((g % CHUNK) + CHUNK) % CHUNK
export const rect = (x0, z0, x1, z1) => ({ x0, z0, x1, z1 })
export const inRect = (r, gx, gz) => gx >= r.x0 && gx <= r.x1 && gz >= r.z0 && gz <= r.z1
const rectValid = (r) =>
  r && [r.x0, r.z0, r.x1, r.z1].every(Number.isInteger) && r.x1 >= r.x0 && r.z1 >= r.z0
const rectInside = (inner, outer) =>
  inner.x0 >= outer.x0 && inner.z0 >= outer.z0 && inner.x1 <= outer.x1 && inner.z1 <= outer.z1
const grow = (r, n) => rect(r.x0 - n, r.z0 - n, r.x1 + n, r.z1 + n)

// Participants: every chunk the footprint (and therefore its ring) touches,
// in canonical (cz, cx) order.
export function participantsForBounds(bounds) {
  const out = []
  for (let cz = floorDiv(bounds.z0 - 1, CHUNK); cz <= floorDiv(bounds.z1 + 1, CHUNK); cz++) {
    for (let cx = floorDiv(bounds.x0 - 1, CHUNK); cx <= floorDiv(bounds.x1 + 1, CHUNK); cx++) {
      out.push({ cx, cz })
    }
  }
  return out
}

// The largest footprint a participant rectangle allows: one ring cell stays
// inside the outermost chunks on every side.
export function footprintBox(cx0, cz0, w, h) {
  return rect(cx0 * CHUNK + 1, cz0 * CHUNK + 1, (cx0 + w) * CHUNK - 2, (cz0 + h) * CHUNK - 2)
}

// A switchback core at global landing (gx, gz) climbing along `dir`: even
// flights on the landing row, odd flights back along the adjacent row on the
// `side` (±1) of the stair's perpendicular axis. The
// 6×4 core (flights plus halo) must sit inside one chunk, local [1..12].
export function switchbackCore(gx, gz, dir, side = 1) {
  const ax = AXIS[dir]
  const at = (along, across) => ({
    gx: gx + ax.a[0] * along + ax.p[0] * across * side,
    gz: gz + ax.a[1] * along + ax.p[1] * across * side,
  })
  const cells = []
  for (let along = -1; along <= 4; along++) {
    for (let across = -1; across <= 2; across++) cells.push(at(along, across))
  }
  const xs = cells.map((c) => c.gx)
  const zs = cells.map((c) => c.gz)
  return {
    rect: rect(Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)),
    even: { dir, cells: [at(0, 0), at(1, 0), at(2, 0), at(3, 0)] },
    odd: { dir: OPPOSITE[dir], cells: [at(3, 1), at(2, 1), at(1, 1), at(0, 1)] },
  }
}

// An open-well switchback: flights on rows 0 and 4 with a one-row well
// between their halos, joined by end landings (along -1 and 4). The core is
// 6×7 cells; the well row (along 0..3, across 2) is a void on upper storeys.
export function openWellCore(gx, gz, dir, side = 1) {
  const ax = AXIS[dir]
  const at = (along, across) => ({
    gx: gx + ax.a[0] * along + ax.p[0] * across * side,
    gz: gz + ax.a[1] * along + ax.p[1] * across * side,
  })
  const cells = []
  for (let along = -1; along <= 4; along++) {
    for (let across = -1; across <= 5; across++) cells.push(at(along, across))
  }
  const xs = cells.map((c) => c.gx)
  const zs = cells.map((c) => c.gz)
  const well = [at(0, 2), at(1, 2), at(2, 2), at(3, 2)]
  const wx = well.map((c) => c.gx)
  const wz = well.map((c) => c.gz)
  return {
    rect: rect(Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)),
    well: rect(Math.min(...wx), Math.min(...wz), Math.max(...wx), Math.max(...wz)),
    even: { dir, cells: [at(0, 0), at(1, 0), at(2, 0), at(3, 0)] },
    odd: { dir: OPPOSITE[dir], cells: [at(3, 4), at(2, 4), at(1, 4), at(0, 4)] },
  }
}

// Canonical stair descriptor from four GLOBAL cells in one chunk. Key order
// matters: the audits compare JSON.stringify of both slab halves.
function stairFromCells(dir, cells) {
  const cx = floorDiv(cells[0].gx, CHUNK)
  const cz = floorDiv(cells[0].gz, CHUNK)
  const l = cells.map((c) => ({ lx: c.gx - cx * CHUNK, lz: c.gz - cz * CHUNK }))
  return {
    cx,
    cz,
    stair: {
      dir,
      landing: { lx: l[0].lx, lz: l[0].lz },
      run: [{ lx: l[1].lx, lz: l[1].lz }, { lx: l[2].lx, lz: l[2].lz }],
      exit: { lx: l[3].lx, lz: l[3].lz },
    },
  }
}

export function coreFlights(core, baseCy, topCy) {
  const flights = []
  for (let lowerCy = baseCy; lowerCy < topCy; lowerCy++) {
    const f = (lowerCy - baseCy) % 2 === 0 ? core.even : core.odd
    const { cx, cz, stair } = stairFromCells(f.dir, f.cells)
    flights.push({ lowerCy, cx, cz, stair })
  }
  return flights
}

// Global strip cells + halo rect of a link.
export function linkCells(link) {
  const ox = link.cx * CHUNK
  const oz = link.cz * CHUNK
  const s = link.stair
  return [s.landing, s.run[0], s.run[1], s.exit].map((c) => ({ gx: ox + c.lx, gz: oz + c.lz }))
}
export function linkHalo(link) {
  const cells = linkCells(link)
  const xs = cells.map((c) => c.gx)
  const zs = cells.map((c) => c.gz)
  return rect(Math.min(...xs) - 1, Math.min(...zs) - 1, Math.max(...xs) + 1, Math.max(...zs) + 1)
}

// ---- per-level raster -------------------------------------------------------

const RASTERS = new WeakMap()

// Class of every cell of the carve box on level k (0 = base).
export function levelRaster(desc, k) {
  // Rasters depend only on bounds/levels/columns/piers, which never change
  // once a draft exists (links are added later), so drafts cache too.
  let byLevel = RASTERS.get(desc)
  if (!byLevel) {
    byLevel = new Map()
    RASTERS.set(desc, byLevel)
  }
  const hit = byLevel.get(k)
  if (hit) return hit
  const b = desc.globalBounds
  const box = grow(b, 1)
  const w = box.x1 - box.x0 + 1
  const h = box.z1 - box.z0 + 1
  const cls = new Uint8Array(w * h)
  const level = desc.levels[k]
  for (let gz = box.z0; gz <= box.z1; gz++) {
    for (let gx = box.x0; gx <= box.x1; gx++) {
      const i = (gz - box.z0) * w + (gx - box.x0)
      if (!inRect(b, gx, gz)) {
        cls[i] = CELL_CLASS_RING
        continue
      }
      let c = CELL_CLASS_SOLID
      if (desc.piers.some((p) => p.gx === gx && p.gz === gz)) c = CELL_CLASS_COLUMN
      else if (k > 0) {
        if (level.voids.some((r) => inRect(r, gx, gz))) c = CELL_CLASS_VOID
        if (c === CELL_CLASS_VOID && level.bridges.some((r) => inRect(r, gx, gz))) c = CELL_CLASS_BRIDGE
      } else if (desc.columns.some((p) => p.gx === gx && p.gz === gz)) {
        c = CELL_CLASS_COLUMN
      }
      cls[i] = c
    }
  }
  const safe = new Uint8Array(w * h)
  for (let i = 0; i < cls.length; i++) safe[i] = cls[i] === CELL_CLASS_RING || cls[i] === CELL_CLASS_SOLID ? 1 : 0
  const raster = { box, w, h, cls, safe, at: (gx, gz) => inRect(box, gx, gz) ? cls[(gz - box.z0) * w + (gx - box.x0)] : 0 }
  byLevel.set(k, raster)
  return raster
}

const walkableClass = (c) => c === CELL_CLASS_RING || c === CELL_CLASS_SOLID || c === CELL_CLASS_BRIDGE
const stairSafeClass = (c) => c === CELL_CLASS_RING || c === CELL_CLASS_SOLID

// ---- link planning ------------------------------------------------------------

// Automatic flight placement for one slab: every straight flight whose strip
// lies in [2..11]² of one participant chunk and whose halo is stair-safe
// (ring or solid footprint, no void/bridge/column/core) on BOTH storeys and
// does not overlap another flight's halo on either storey. `pick` chooses one
// candidate deterministically.
export function autoFlight(desc, lowerCy, placed, pick, { avoid = [], skipChunks = [] } = {}) {
  const k = lowerCy - desc.baseCy
  const lower = levelRaster(desc, k)
  const upper = levelRaster(desc, k + 1)
  const { box, w } = lower
  const touching = placed
    .filter((l) => l.lowerCy === lowerCy - 1 || l.lowerCy === lowerCy || l.lowerCy === lowerCy + 1)
    .map(linkHalo)
  const blocked = [...touching, ...avoid]
  const candidates = []
  for (const { cx, cz } of desc.participants) {
    if (skipChunks.some((c) => c.cx === cx && c.cz === cz)) continue
    const ox = cx * CHUNK
    const oz = cz * CHUNK
    for (let dir = 0; dir < 4; dir++) {
      for (let lz = 2; lz <= 11; lz++) {
        for (let lx = 2; lx <= 11; lx++) {
          const ex = lx + DX[dir] * 3
          const ez = lz + DZ[dir] * 3
          if (ex < 2 || ex > 11 || ez < 2 || ez > 11) continue
          const halo = rect(ox + Math.min(lx, ex) - 1, oz + Math.min(lz, ez) - 1, ox + Math.max(lx, ex) + 1, oz + Math.max(lz, ez) + 1)
          if (!rectInside(halo, box)) continue
          let ok = true
          for (let gz = halo.z0; gz <= halo.z1 && ok; gz++) {
            const row = (gz - box.z0) * w - box.x0
            for (let gx = halo.x0; gx <= halo.x1; gx++) {
              if (!lower.safe[row + gx] || !upper.safe[row + gx]) {
                ok = false
                break
              }
            }
          }
          if (!ok || blocked.some((r) => rectsOverlap(r, halo))) continue
          candidates.push({ cx, cz, lx, lz, dir })
        }
      }
    }
  }
  if (!candidates.length) return null
  const c = candidates[pick(candidates.length)]
  const cells = [0, 1, 2, 3].map((i) => ({
    gx: c.cx * CHUNK + c.lx + DX[c.dir] * i,
    gz: c.cz * CHUNK + c.lz + DZ[c.dir] * i,
  }))
  return { lowerCy, ...stairFromCells(c.dir, cells) }
}

const desc_participantsCount = (d) => d.participants.length
const rectsOverlap = (a, b) => a.x0 <= b.x1 && b.x0 <= a.x1 && a.z0 <= b.z1 && b.z0 <= a.z1

// ---- descriptor assembly -------------------------------------------------------

// Build the frozen canonical descriptor. `plan` comes from a recipe; see
// ./recipes.js. Returns null when the geometry cannot satisfy the invariants
// (the caller then leaves the slot empty — fail closed, never partial).
export function assembleCatalogDescriptor(plan, meta, pick, onReject = null) {
  const bounds = plan.bounds
  const participants = participantsForBounds(bounds)
  const levelCount = plan.levels.length
  const topCy = meta.baseCy + levelCount - 1
  const draft = {
    id: meta.id,
    hasRoom: true,
    family: meta.family,
    kind: CATALOG_KINDS[meta.family],
    type: meta.type,
    sizeClass: meta.sizeClass,
    label: plan.label,
    district: meta.district,
    bandIndex: meta.bandIndex,
    slot: meta.slot,
    baseCy: meta.baseCy,
    bottomCy: meta.baseCy,
    topCy,
    levelCount,
    height: levelCount,
    anchor: { ...participants[0] },
    participants,
    participantChunks: participants.map((p) => ({ ...p })),
    globalBounds: { ...bounds },
    bridgeAxis: plan.bridgeAxis ?? ((bounds.x1 - bounds.x0) >= (bounds.z1 - bounds.z0) ? 'x' : 'z'),
    glazing: plan.glazing ?? 'rail',
    levels: plan.levels.map((level, k) => ({
      levelCy: meta.baseCy + k,
      voids: (k === 0 ? [] : level.voids ?? []).map((r) => ({ ...r })),
      bridges: (k === 0 ? [] : level.bridges ?? []).map((r) => ({ ...r })),
    })),
    columns: (plan.columns ?? []).map((c) => ({ gx: c.gx, gz: c.gz })),
    piers: (plan.piers ?? []).map((c) => ({ gx: c.gx, gz: c.gz })),
    core: null,
    verticalLinks: [],
    deviation: plan.deviation ? { ...plan.deviation } : null,
  }

  let links = []
  if (plan.core) {
    const c = plan.core
    const side = c.side === -1 ? -1 : 1
    const core = c.well ? openWellCore(c.gx, c.gz, c.dir, side) : switchbackCore(c.gx, c.gz, c.dir, side)
    draft.core = {
      gx: c.gx,
      gz: c.gz,
      dir: c.dir,
      side,
      well: !!c.well,
      enclosed: !!c.enclosed,
      doorSide: c.doorSide === 'far' ? 'far' : 'near',
      rect: core.rect,
    }
    links = coreFlights(core, draft.baseCy, topCy)
  }
  if (plan.links === 'auto' || (!plan.core && plan.links !== 'none')) {
    const avoid = draft.core ? [grow(draft.core.rect, 1)] : []
    for (let lowerCy = draft.baseCy; lowerCy < topCy; lowerCy++) {
      if (links.some((l) => l.lowerCy === lowerCy)) continue
      const link = autoFlight(draft, lowerCy, links, pick, { avoid })
      if (!link) {
        onReject?.([`no-flight-${lowerCy - draft.baseCy}`])
        return null
      }
      links.push(link)
    }
  }
  // Redundant flights in other chunks (loops, not traps) — best effort.
  if (plan.extraFlights && desc_participantsCount(draft) > 1) {
    const avoid = draft.core ? [grow(draft.core.rect, 1)] : []
    for (let lowerCy = draft.baseCy; lowerCy < topCy; lowerCy++) {
      const here = links.filter((l) => l.lowerCy === lowerCy)
      const link = autoFlight(draft, lowerCy, links, pick, { avoid, skipChunks: here })
      if (link) links.push(link)
    }
  }
  links.sort((a, b) => a.lowerCy - b.lowerCy || a.cz - b.cz || a.cx - b.cx)
  draft.verticalLinks = links.map((l) => ({ lowerCy: l.lowerCy, cx: l.cx, cz: l.cz, stair: l.stair }))
  const analysis = analyzeCatalogDescriptor(draft)
  if (!analysis.ok) {
    onReject?.(analysis.reasons)
    return null
  }
  return deepFreeze(draft)
}

// ---- analysis (fail-closed gate + audit oracle) ------------------------------------

const onSeam = (line) => ((line % CHUNK) + CHUNK) % CHUNK === 0

export function analyzeCatalogDescriptor(desc) {
  const reasons = []
  const fail = (r) => reasons.push(r)
  if (!isCatalogKind(desc?.kind) || CATALOG_KINDS[desc.family] !== desc.kind) fail('kind')
  if (!Number.isInteger(desc?.id) || desc.id <= 0 || desc.id > 0xffffffff) fail('id')
  if (!CATALOG_SIZE_CLASSES.includes(desc?.sizeClass)) fail('size-class')
  const b = desc?.globalBounds
  if (!rectValid(b)) return { ok: false, reasons: [...reasons, 'bounds'] }
  const participants = participantsForBounds(b)
  if (JSON.stringify(participants) !== JSON.stringify(desc.participants)) fail('participants')
  if (participants.length > 4) fail('participant-count')
  // The ring stays inside the participants: local footprint in [1..12] at
  // the outer chunks (guaranteed by participantsForBounds), and a
  // participant's grid never exceeds 2 chunks per axis.
  const cxs = participants.map((p) => p.cx)
  const czs = participants.map((p) => p.cz)
  if (Math.max(...cxs) - Math.min(...cxs) > 1 || Math.max(...czs) - Math.min(...czs) > 1) fail('participant-span')
  if (local(b.x0) === 0 || local(b.z0) === 0 || local(b.x1) === CHUNK - 1 || local(b.z1) === CHUNK - 1) fail('ring-outside')
  if (!Number.isInteger(desc.baseCy) || desc.topCy !== desc.baseCy + desc.levels.length - 1 || desc.levels.length < 2) fail('band')
  if (desc.levelCount !== desc.levels.length) fail('band')
  if (reasons.length) return { ok: false, reasons }

  for (let k = 0; k < desc.levels.length; k++) {
    const level = desc.levels[k]
    if (level.levelCy !== desc.baseCy + k) fail(`level-${k}-cy`)
    if (k === 0 && (level.voids.length || level.bridges.length)) fail('base-voids')
    for (const v of level.voids) {
      if (!rectValid(v) || !rectInside(v, b)) fail(`level-${k}-void-bounds`)
      // A seam may cross a void only through its interior, so rails never
      // land on a chunk seam (seam edges inside the carve stay open).
      if (onSeam(v.x0) || onSeam(v.x1 + 1) || onSeam(v.z0) || onSeam(v.z1 + 1)) fail(`level-${k}-void-seam`)
    }
    for (const br of level.bridges) {
      const host = level.voids.find((v) => rectInside(br, v))
      if (!rectValid(br) || !host) {
        fail(`level-${k}-bridge-host`)
        continue
      }
      const alongX = br.z0 === br.z1
      const alongZ = br.x0 === br.x1
      if (!alongX && !alongZ) fail(`level-${k}-bridge-width`)
      // A bridge spans its void so both ends meet walkable floor.
      if (alongX && (br.x0 !== host.x0 || br.x1 !== host.x1)) fail(`level-${k}-bridge-span`)
      if (alongZ && !alongX && (br.z0 !== host.z0 || br.z1 !== host.z1)) fail(`level-${k}-bridge-span`)
      // Deck guards sit on the flank lines, which must not be seams.
      if (alongX && (onSeam(br.z0) || onSeam(br.z0 + 1))) fail(`level-${k}-bridge-seam`)
      if (alongZ && !alongX && (onSeam(br.x0) || onSeam(br.x0 + 1))) fail(`level-${k}-bridge-seam`)
    }
  }
  for (const c of [...desc.columns, ...desc.piers]) {
    if (!inRect(grow(b, -1), c.gx, c.gz)) fail('column-edge')
    // Never directly behind a chunk seam: open seams always lead onto floor.
    if (local(c.gx) === 0 || local(c.gx) === CHUNK - 1 || local(c.gz) === 0 || local(c.gz) === CHUNK - 1) fail('column-seam')
  }
  // Piers rise through every storey: never inside a void or deck.
  for (const p of desc.piers) {
    for (let k = 1; k < desc.levels.length; k++) {
      if (desc.levels[k].voids.some((r) => inRect(r, p.gx, p.gz))) fail(`pier-void-${k}`)
    }
  }

  // Core geometry: inside one chunk's [1..12]², stair-safe on every storey,
  // and the door (if enclosed) opens onto walkable floor.
  if (desc.core) {
    const r = desc.core.rect
    const cx = floorDiv(r.x0, CHUNK)
    const cz = floorDiv(r.z0, CHUNK)
    if (floorDiv(r.x1, CHUNK) !== cx || floorDiv(r.z1, CHUNK) !== cz ||
        local(r.x0) < 1 || local(r.z0) < 1 || local(r.x1) > CHUNK - 2 || local(r.z1) > CHUNK - 2) {
      fail('core-chunk')
    }
    if (!rectInside(r, grow(b, 1))) fail('core-bounds')
    for (let k = 0; k < desc.levels.length; k++) {
      const raster = levelRaster(desc, k)
      for (let gz = r.z0; gz <= r.z1; gz++) {
        for (let gx = r.x0; gx <= r.x1; gx++) {
          const c = raster.at(gx, gz)
          const inWell = desc.core.well && inRect(openWellCore(desc.core.gx, desc.core.gz, desc.core.dir, desc.core.side).well, gx, gz)
          if (inWell && k > 0 ? c !== CELL_CLASS_VOID : !stairSafeClass(c)) fail(`core-level-${k}`)
        }
      }
    }
    if (desc.core.enclosed) {
      const door = coreDoor(desc.core)
      for (let k = 0; k < desc.levels.length; k++) {
        if (!walkableClass(levelRaster(desc, k).at(door.outside.gx, door.outside.gz))) fail(`core-door-${k}`)
      }
    }
  }

  // Links: one per slab at least, canonical shape, strip in [2..11]², halo
  // stair-safe on both storeys, no two flights of one chunk sharing a cell,
  // and non-core flights never sharing a halo cell on a storey.
  const byLower = new Map()
  for (const link of desc.verticalLinks) {
    if (!Number.isInteger(link.lowerCy) || link.lowerCy < desc.baseCy || link.lowerCy >= desc.topCy) {
      fail('link-band')
      continue
    }
    if (!participants.some((p) => p.cx === link.cx && p.cz === link.cz)) fail('link-participant')
    const key = `${link.cx},${link.cz},${link.lowerCy}`
    if (byLower.has(key)) fail('link-duplicate')
    byLower.set(key, link)
    const s = link.stair
    const cells = [s.landing, s.run[0], s.run[1], s.exit]
    if (cells.some((c) => c.lx < 1 || c.lx > 12 || c.lz < 1 || c.lz > 12)) fail('link-strip')
    const d = s.dir
    for (let i = 1; i < 4; i++) {
      if (cells[i].lx - cells[i - 1].lx !== DX[d] || cells[i].lz - cells[i - 1].lz !== DZ[d]) fail('link-shape')
    }
    const k = link.lowerCy - desc.baseCy
    const halo = linkHalo(link)
    const lower = levelRaster(desc, k)
    const upper = levelRaster(desc, k + 1)
    for (let gz = halo.z0; gz <= halo.z1; gz++) {
      for (let gx = halo.x0; gx <= halo.x1; gx++) {
        if (!stairSafeClass(lower.at(gx, gz)) || !stairSafeClass(upper.at(gx, gz))) {
          fail('link-halo')
          gz = halo.z1 + 1
          break
        }
      }
    }
  }
  for (let lowerCy = desc.baseCy; lowerCy < desc.topCy; lowerCy++) {
    if (!desc.verticalLinks.some((l) => l.lowerCy === lowerCy)) fail(`link-missing-${lowerCy}`)
  }
  // Same storey, same chunk: strips disjoint (up-stair of this slab vs the
  // down-stair arriving from the slab below).
  for (const a of desc.verticalLinks) {
    for (const b2 of desc.verticalLinks) {
      if (b2.lowerCy !== a.lowerCy + 1 || a.cx !== b2.cx || a.cz !== b2.cz) continue
      const sa = new Set(linkCells(a).map((c) => `${c.gx},${c.gz}`))
      if (linkCells(b2).some((c) => sa.has(`${c.gx},${c.gz}`))) fail('link-overlap')
    }
  }

  // Per-storey connectivity of every walkable structure cell to the ring —
  // inside EACH participant chunk on its own (the world keeps every chunk
  // slice internally connected; a deck must not reach its gallery only
  // through the neighbouring chunk).
  for (let k = 0; k < desc.levels.length; k++) {
    for (const p of participants) {
      const stranded = strandedCells(desc, k, p)
      if (stranded) fail(`level-${k}-stranded-${p.cx},${p.cz}-${stranded}`)
    }
  }
  return { ok: reasons.length === 0, reasons }
}

export function coreDoor(core) {
  const r = core.rect
  const horizontal = core.dir === DIR_E || core.dir === DIR_W
  const far = core.doorSide === 'far'
  if (horizontal) {
    const gx = Math.floor((r.x0 + r.x1) / 2)
    return far
      ? { axis: 'h', gx, line: r.z1 + 1, inside: { gx, gz: r.z1 }, outside: { gx, gz: r.z1 + 1 } }
      : { axis: 'h', gx, line: r.z0, inside: { gx, gz: r.z0 }, outside: { gx, gz: r.z0 - 1 } }
  }
  const gz = Math.floor((r.z0 + r.z1) / 2)
  return far
    ? { axis: 'v', gz, line: r.x1 + 1, inside: { gx: r.x1, gz }, outside: { gx: r.x1 + 1, gz } }
    : { axis: 'v', gz, line: r.x0, inside: { gx: r.x0, gz }, outside: { gx: r.x0 - 1, gz } }
}

// Count walkable cells on storey k that cannot reach the ring (flood over
// walkable classes; strip cells excluded; an enclosed core is entered only
// through its door). 0 = connected.
function strandedCells(desc, k, chunk) {
  const raster = levelRaster(desc, k)
  const { w, h } = raster
  const full = raster.box
  const cbox = rect(chunk.cx * CHUNK, chunk.cz * CHUNK, chunk.cx * CHUNK + CHUNK - 1, chunk.cz * CHUNK + CHUNK - 1)
  const box = rect(Math.max(full.x0, cbox.x0), Math.max(full.z0, cbox.z0), Math.min(full.x1, cbox.x1), Math.min(full.z1, cbox.z1))
  const idx = (gx, gz) => (gz - full.z0) * w + (gx - full.x0)
  const blocked = new Uint8Array(w * h)
  for (const link of desc.verticalLinks) {
    const lk = link.lowerCy - desc.baseCy
    if (lk !== k && lk + 1 !== k) continue
    // Ramp cells are not floor on either storey; the landing (lower) and
    // exit (upper) stay walkable and join through the mouth / exit sides.
    const cells = linkCells(link)
    for (const c of cells.slice(1, 3)) {
      if (inRect(full, c.gx, c.gz)) blocked[idx(c.gx, c.gz)] = 1
    }
  }
  const core = desc.core?.enclosed ? desc.core.rect : null
  const door = core ? coreDoor(desc.core) : null
  const walk = (gx, gz) => inRect(box, gx, gz) && walkableClass(raster.at(gx, gz)) && !blocked[idx(gx, gz)]
  const crosses = (ax, az, bx, bz) => {
    if (!core) return false
    const ia = inRect(core, ax, az)
    const ib = inRect(core, bx, bz)
    if (ia === ib) return false
    const inside = ia ? { gx: ax, gz: az } : { gx: bx, gz: bz }
    const outside = ia ? { gx: bx, gz: bz } : { gx: ax, gz: az }
    return !(inside.gx === door.inside.gx && inside.gz === door.inside.gz &&
      outside.gx === door.outside.gx && outside.gz === door.outside.gz)
  }
  const seen = new Uint8Array(w * h)
  const queue = []
  for (let gz = box.z0; gz <= box.z1; gz++) {
    for (let gx = box.x0; gx <= box.x1; gx++) {
      if (raster.at(gx, gz) === CELL_CLASS_RING && walk(gx, gz)) {
        seen[idx(gx, gz)] = 1
        queue.push(gx, gz)
      }
    }
  }
  for (let q = 0; q < queue.length; q += 2) {
    const gx = queue[q]
    const gz = queue[q + 1]
    for (let d = 0; d < 4; d++) {
      const nx = gx + DX[d]
      const nz = gz + DZ[d]
      if (!walk(nx, nz) || seen[idx(nx, nz)] || crosses(gx, gz, nx, nz)) continue
      seen[idx(nx, nz)] = 1
      queue.push(nx, nz)
    }
  }
  let stranded = 0
  for (let gz = box.z0; gz <= box.z1; gz++) {
    for (let gx = box.x0; gx <= box.x1; gx++) {
      if (walk(gx, gz) && !seen[idx(gx, gz)]) {
        // Strip landings/exits are joined through their mouth/exit sides.
        const isStripEnd = desc.verticalLinks.some((l) => {
          const lk = l.lowerCy - desc.baseCy
          const c = linkCells(l)
          return (lk === k && c[0].gx === gx && c[0].gz === gz) || (lk + 1 === k && c[3].gx === gx && c[3].gz === gz)
        })
        if (!isStripEnd) stranded++
      }
    }
  }
  return stranded
}

// ---- slices -------------------------------------------------------------------------

const SLICES = new WeakMap()
const EMPTY = Object.freeze([])

function noSlice(lowerCy) {
  return Object.freeze({
    id: null,
    baseCy: null,
    topCy: null,
    lowerCy,
    levelCy: lowerCy + 1,
    kind: null,
    bridgeAxis: null,
    bounds: null,
    localBounds: null,
    globalBounds: null,
    bridgeLine: null,
    globalBridgeLine: null,
    voidCells: EMPTY,
    bridgeCells: EMPTY,
    hasRoom: false,
  })
}

// Merge the chunk's void cells into half-open local rects for the light/sight
// aperture registry (same format as rectilinearApertureRegions).
function apertureRects(voidCells) {
  const rows = new Map()
  for (const c of voidCells) {
    let row = rows.get(c.lz)
    if (!row) rows.set(c.lz, (row = []))
    row.push(c.lx)
  }
  const runs = []
  for (const [lz, xs] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
    xs.sort((a, b) => a - b)
    let start = xs[0]
    for (let i = 1; i <= xs.length; i++) {
      if (i === xs.length || xs[i] !== xs[i - 1] + 1) {
        runs.push({ x0: start, x1: xs[i - 1] + 1, z0: lz, z1: lz + 1 })
        start = xs[i]
      }
    }
  }
  // Vertical merge of identical consecutive runs.
  const out = []
  for (const r of runs) {
    const prev = out.find((o) => o.x0 === r.x0 && o.x1 === r.x1 && o.z1 === r.z0)
    if (prev) prev.z1 = r.z1
    else out.push({ ...r })
  }
  return out
}

// The slab lowerCy -> lowerCy+1 projected into one participant chunk. Both
// storeys derive it from the same descriptor with the same builder, so the
// halves are byte-identical. Void/bridge cells are those of the UPPER storey.
export function catalogStructureSlice(structure, cx, cz, lowerCy) {
  if (
    !isCatalogStructure(structure) ||
    !Number.isInteger(lowerCy) ||
    lowerCy < structure.baseCy ||
    lowerCy >= structure.topCy ||
    !structure.participants.some((p) => p.cx === cx && p.cz === cz)
  ) return noSlice(lowerCy)
  let cache = SLICES.get(structure)
  if (!cache) {
    cache = new Map()
    if (Object.isFrozen(structure)) SLICES.set(structure, cache)
  }
  const key = `${cx},${cz},${lowerCy}`
  const hit = cache.get(key)
  if (hit) return hit

  const b = structure.globalBounds
  const ox = cx * CHUNK
  const oz = cz * CHUNK
  const gx0 = Math.max(b.x0, ox)
  const gz0 = Math.max(b.z0, oz)
  const gx1 = Math.min(b.x1, ox + CHUNK - 1)
  const gz1 = Math.min(b.z1, oz + CHUNK - 1)
  const raster = levelRaster(structure, lowerCy + 1 - structure.baseCy)
  const voidCells = []
  const bridgeCells = []
  for (let gz = gz0; gz <= gz1; gz++) {
    for (let gx = gx0; gx <= gx1; gx++) {
      const c = raster.at(gx, gz)
      if (c === CELL_CLASS_VOID) voidCells.push({ lx: gx - ox, lz: gz - oz })
      else if (c === CELL_CLASS_BRIDGE) bridgeCells.push({ lx: gx - ox, lz: gz - oz })
    }
  }
  const localBounds = gx0 <= gx1 && gz0 <= gz1
    ? { x0: gx0 - ox, z0: gz0 - oz, x1: gx1 - ox, z1: gz1 - oz }
    : null
  const slice = deepFreeze({
    id: structure.id,
    baseCy: structure.baseCy,
    topCy: structure.topCy,
    lowerCy,
    levelCy: lowerCy + 1,
    kind: structure.kind,
    bridgeAxis: structure.bridgeAxis,
    bounds: localBounds,
    localBounds,
    globalBounds: { ...b },
    bridgeLine: null,
    globalBridgeLine: null,
    voidCells,
    bridgeCells,
    hasRoom: true,
    family: structure.family,
    type: structure.type,
    apertureRects: apertureRects(voidCells),
  })
  cache.set(key, slice)
  return slice
}

// Global void membership for renderers asking about a neighbour's cell.
export function catalogVoidAt(structure, levelCy, gx, gz) {
  if (!isCatalogStructure(structure)) return false
  const k = levelCy - structure.baseCy
  if (k <= 0 || k >= structure.levels.length) return false
  return levelRaster(structure, k).at(gx, gz) === CELL_CLASS_VOID
}

// Human-readable summary rows for editors and debug overlays.
export function describeCatalogStructure(s) {
  const b = s.globalBounds
  const lines = [
    `${s.label} · ${s.sizeClass} · ${s.family}`,
    `${b.x1 - b.x0 + 1}×${b.z1 - b.z0 + 1} cells · ${s.levelCount} storeys · ${s.participants.length} chunk${s.participants.length > 1 ? 's' : ''}`,
    `${s.verticalLinks.length} flights${s.core ? ` · ${s.core.enclosed ? 'enclosed' : 'open'} ${s.core.well ? 'open-well' : 'switchback'} core` : ''}${s.columns.length ? ` · ${s.columns.length} piers` : ''}`,
  ]
  if (s.deviation) lines.push(`deviation: ${s.deviation.kind} on cy ${s.deviation.levelCy}`)
  return lines
}
