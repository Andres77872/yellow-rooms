import { CHUNK, cIdx } from '../constants.js'
import { deepFreeze } from '../mapFamily.js'
import {
  CELL_CLASS_RING,
  analyzeCatalogDescriptor,
  assembleCatalogDescriptor,
  levelRaster,
} from '../structures/catalog/engine.js'
import { stampCatalogStructure } from '../structures/catalog/stamp.js'
import { atriumDescriptor, stairwellConflicts, stampAtrium, stampStairwell } from '../structures/authored.js'
import { remassStampRing } from './seams.js'

// The structure kit (spec §6.3): the one seam where a kind body's structure,
// stair and exit writes differ between the finite kind lab and a world tile
// bake. A kind body takes `ctx.kit` and calls
//
//   catalog(map, plan, meta, pick, onReject)  → descriptor (local view) | null
//   customCatalog(map, draft)                 → { desc } | { error, reasons } | null
//   atrium(map, spec)                         → { descriptor } | { error } | null
//   stairwell(map, plan, opts)                → the stamped chunks
//   stairs(map, { cx, cy, cz, up, down })     → the chunk
//
// EDITOR_KIT reproduces the kinds' inline code exactly (kind digests stay
// byte-identical). makeWorldKit(ctx, canvas) never assembles during a bake: it
// looks the volume up by `meta.slot` among the planner's descriptors (true
// global coordinates), proves the kind's plan matches it, stamps it into the
// tile's storeys and hands the kind its local view.

const ZERO = Object.freeze({ cx: 0, cy: 0, cz: 0 })

const touchOf = (map) => (cx, cy, cz) => map._touch(cx, cy, cz)

// The kinds' catalog stamp loop: every participant × storey cy0..cy1, the
// stair stamp's edge protection cleared first (per-build scratch state).
function stampParticipants(touch, desc, cy0, cy1, onStamp = null) {
  for (const p of desc.participants) {
    for (let cy = cy0; cy <= cy1; cy++) {
      const d = touch(p.cx, cy, p.cz)
      // Edge protection is per-build scratch state; start each stamp clean.
      d._protV.clear()
      d._protH.clear()
      stampCatalogStructure(d, desc)
      onStamp?.(d)
    }
  }
}

// --- finite mode -------------------------------------------------------------------

export const EDITOR_KIT = Object.freeze({
  // poolrooms/theater/playplace: assemble, fail closed, stamp every storey.
  catalog(map, plan, meta, pick, onReject = null) {
    const desc = assembleCatalogDescriptor(plan, meta, pick, onReject)
    if (!desc) return null
    stampParticipants(touchOf(map), desc, desc.baseCy, desc.topCy)
    return desc
  },
  // babel: a hand-built draft (assembleCatalogDescriptor's shape), analysed,
  // frozen, stamped. The kind words its own error from `error`/`reasons`.
  customCatalog(map, draft) {
    const analysis = analyzeCatalogDescriptor(draft)
    if (!analysis.ok) return { error: analysis.reasons.join(', '), reasons: analysis.reasons }
    const desc = deepFreeze(draft)
    stampParticipants(touchOf(map), desc, desc.baseCy, desc.topCy)
    return { desc }
  },
  // terminal/house: an authored atrium.
  atrium(map, spec) {
    const a = atriumDescriptor(spec)
    if (a.error) return { error: a.error }
    stampAtrium(touchOf(map), a.descriptor)
    return { descriptor: a.descriptor }
  },
  stairwell(map, plan, opts) {
    return stampStairwell(touchOf(map), plan, opts)
  },
  // A raw flight pair: direct field assignment (undefined leaves a half).
  stairs(map, { cx, cy, cz, up, down }) {
    const d = map._touch(cx, cy, cz)
    if (up !== undefined) d.stairUp = up
    if (down !== undefined) d.stairDown = down
    return d
  },
})

// A kind's finite ctx: FINITE_CTX_<ID> = finiteCtx(KIND_DEFAULTS).
export const finiteCtx = (params = {}) => Object.freeze({ mode: 'finite', kit: EDITOR_KIT, params: Object.freeze({ ...params }) })

// --- stair slots ---------------------------------------------------------------------

const slotTaken = (why) => new Error(`kit:stair-slot-taken (${why})`)

// Raw stair halves into one chunk, refusing a slot already set (by a catalog
// link, a stairwell core or another raw flight): `up` is stairUp, `down` is
// stairDown; undefined leaves that half alone. Null on a set slot is refused
// too (it would orphan the other half of that link); null on an empty slot
// is a no-op write.
export function stampStairsChecked(data, { up, down } = {}) {
  if (up !== undefined && data.stairUp) throw slotTaken(`chunk ${data.cx},${data.cy},${data.cz} already has a stair up`)
  if (down !== undefined && data.stairDown) throw slotTaken(`chunk ${data.cx},${data.cy},${data.cz} already has a stair down`)
  if (up !== undefined) data.stairUp = up
  if (down !== undefined) data.stairDown = down
  return data
}

// --- local view --------------------------------------------------------------------

// A plain (unfrozen) copy of a global descriptor in kind-local coordinates:
// chunk fields by −origin, cell fields by −origin·CHUNK, storeys by −origin.cy.
// Chunk-local stair cells (lx/lz) are unchanged, so linkHalo(link) on the view
// yields kind-local cells.
export function localView(desc, origin = ZERO) {
  if (!desc) return null
  const o = origin ?? ZERO
  const dx = o.cx * CHUNK
  const dz = o.cz * CHUNK
  const v = structuredClone(desc)
  const cellRect = (r) => r && { ...r, x0: r.x0 - dx, z0: r.z0 - dz, x1: r.x1 - dx, z1: r.z1 - dz }
  const cell = (c) => c && { ...c, gx: c.gx - dx, gz: c.gz - dz }
  const chunk = (c) => c && { ...c, cx: c.cx - o.cx, cz: c.cz - o.cz }
  if (v.globalBounds) v.globalBounds = cellRect(v.globalBounds)
  if (v.bounds) v.bounds = cellRect(v.bounds)
  if (v.anchor) v.anchor = chunk(v.anchor)
  if (Array.isArray(v.participants)) v.participants = v.participants.map(chunk)
  if (Array.isArray(v.participantChunks)) v.participantChunks = v.participantChunks.map(chunk)
  for (const f of ['baseCy', 'bottomCy', 'topCy']) if (Number.isInteger(v[f])) v[f] -= o.cy
  if (Array.isArray(v.levels)) {
    v.levels = v.levels.map((l) => ({
      ...l,
      ...(Number.isInteger(l.levelCy) ? { levelCy: l.levelCy - o.cy } : {}),
      ...(l.voids ? { voids: l.voids.map(cellRect) } : {}),
      ...(l.bridges ? { bridges: l.bridges.map(cellRect) } : {}),
    }))
  }
  if (Array.isArray(v.columns)) v.columns = v.columns.map(cell)
  if (Array.isArray(v.piers)) v.piers = v.piers.map(cell)
  if (v.core) v.core = { ...cell(v.core), ...(v.core.rect ? { rect: cellRect(v.core.rect) } : {}) }
  if (Array.isArray(v.verticalLinks)) {
    v.verticalLinks = v.verticalLinks.map((l) => ({ ...l, lowerCy: l.lowerCy - o.cy, cx: l.cx - o.cx, cz: l.cz - o.cz }))
  }
  return v
}

// --- plan ↔ descriptor check -------------------------------------------------------

const rectKey = (r) => (r ? [r.x0, r.z0, r.x1, r.z1].join(',') : 'null')
const rectsKey = (rs) => (rs ?? []).map(rectKey).join(';')
const cellsKey = (cs) => (cs ?? []).map((c) => `${c.gx},${c.gz}`).join(';')
const shiftRect = (r, dx, dz) => r && { x0: r.x0 + dx, z0: r.z0 + dz, x1: r.x1 + dx, z1: r.z1 + dz }
const shiftCell = (c, dx, dz) => ({ gx: c.gx + dx, gz: c.gz + dz })
// assembleCatalogDescriptor's normalisation of a plan core (rect derives).
const coreKey = (c, dx = 0, dz = 0) => (c
  ? JSON.stringify([c.gx + dx, c.gz + dz, c.dir, c.side === -1 ? -1 : 1, !!c.well, !!c.enclosed, c.doorSide === 'far' ? 'far' : 'near'])
  : 'null')
const linksKey = (ls, o = ZERO) => JSON.stringify((ls ?? []).map((l) => [l.lowerCy + o.cy, l.cx + o.cx, l.cz + o.cz, l.stair]))

// Every field of the kind's (local) plan that shapes the volume must equal the
// planner's (global) descriptor: bounds, voids and bridges of every level
// k ≥ 1, columns, piers, core and base storey; for a custom draft also its
// links and level count. Throws kit:planner-mismatch naming the first field.
function checkPlan(desc, { bounds, levels, columns, piers, core, baseCy, links }, origin, label) {
  const dx = origin.cx * CHUNK
  const dz = origin.cz * CHUNK
  const fail = (field) => {
    throw new Error(`kit:planner-mismatch (${label} slot ${desc.slot}: ${field})`)
  }
  if (rectKey(shiftRect(bounds, dx, dz)) !== rectKey(desc.globalBounds)) fail('bounds')
  if (baseCy + origin.cy !== desc.baseCy) fail('baseCy')
  const n = Math.max(levels.length, desc.levels.length)
  for (let k = 1; k < n; k++) {
    const mine = levels[k]
    const theirs = desc.levels[k]
    if (!mine || !theirs) fail(`levels[${k}]`)
    if (rectsKey((mine.voids ?? []).map((r) => shiftRect(r, dx, dz))) !== rectsKey(theirs.voids)) fail(`levels[${k}].voids`)
    if (rectsKey((mine.bridges ?? []).map((r) => shiftRect(r, dx, dz))) !== rectsKey(theirs.bridges)) fail(`levels[${k}].bridges`)
  }
  if (cellsKey((columns ?? []).map((c) => shiftCell(c, dx, dz))) !== cellsKey(desc.columns)) fail('columns')
  if (cellsKey((piers ?? []).map((c) => shiftCell(c, dx, dz))) !== cellsKey(desc.piers)) fail('piers')
  if (coreKey(core, dx, dz) !== coreKey(desc.core)) fail('core')
  if (links !== undefined) {
    if (levels.length !== desc.levels.length) fail('levels.length')
    if (linksKey(links, origin) !== linksKey(desc.verticalLinks)) fail('verticalLinks')
  }
}

// --- seams -------------------------------------------------------------------------

// remassStampRing lives in tiles/seams.js (spec §6.8); re-exported here.
export { remassStampRing }

// Ring cells of `desc` on storeys cy0..cy1 that are not walkable plan cells
// yet (mass, or in a chunk the kind never drew): remassStampRing's `before`.
function ringOutsidePlan(canvas, desc, cy0, cy1) {
  const out = new Set()
  for (let cy = cy0; cy <= cy1; cy++) {
    const raster = levelRaster(desc, cy - desc.baseCy)
    const { box } = raster
    for (let gz = box.z0; gz <= box.z1; gz++) {
      for (let gx = box.x0; gx <= box.x1; gx++) {
        if (raster.at(gx, gz) !== CELL_CLASS_RING) continue
        const gcx = Math.floor(gx / CHUNK)
        const gcz = Math.floor(gz / CHUNK)
        const d = canvas.globalChunk(gcx, cy, gcz, false)
        if (!d || d.cols[cIdx(gx - gcx * CHUNK, gz - gcz * CHUNK)] !== 0) out.add(`${gx},${gz},${cy}`)
      }
    }
  }
  return out
}

// --- tile mode ---------------------------------------------------------------------

// The world kit for one bake. ctx: { family, origin, cy0, cy1, structures,
// window?, portsAt?, notes? } (spec §6.5); `atriumAsCatalog(spec) →
// { plan, meta }` is the family geometry's conversion (§7.4): the option, else
// ctx.atriumAsCatalog, which the bake (makeTileCtx) sets from the generator's
// re-exported geometry.atriumAsCatalog (house, terminal) or null. Only
// kit.atrium needs it; without one kit.atrium throws kit:no-atrium-conversion.
// In tile mode catalog/customCatalog/atrium return null (not { error }) for a
// slot the planner left empty.
export function makeWorldKit(ctx, canvas, { atriumAsCatalog = ctx.atriumAsCatalog ?? null } = {}) {
  const o = canvas.origin ?? ctx.origin ?? ZERO
  const label = ctx.family ?? canvas.family ?? 'family'
  const bySlot = (slot) => (ctx.structures ?? []).find((s) => s && s.slot === slot) ?? null
  const nullSlot = (slot) => {
    ctx.notes?.push?.(`kit:null-slot ${slot}`)
    return null
  }

  // Pre-stamp slot check, stamp into [cy0, cy1], ring re-mass.
  const stampWorld = (desc) => {
    const lo = Math.max(desc.baseCy, ctx.cy0 ?? -Infinity)
    const hi = Math.min(desc.topCy, ctx.cy1 ?? Infinity)
    for (const link of desc.verticalLinks ?? []) {
      const lower = link.lowerCy
      const upper = lower + 1
      if ((lower < lo || lower > hi) && (upper < lo || upper > hi)) continue
      if (canvas.globalChunk(link.cx, lower, link.cz, false)?.stairUp) {
        throw slotTaken(`${label} slot ${desc.slot}: chunk ${link.cx},${lower},${link.cz} already has a stair up`)
      }
      if (canvas.globalChunk(link.cx, upper, link.cz, false)?.stairDown) {
        throw slotTaken(`${label} slot ${desc.slot}: chunk ${link.cx},${upper},${link.cz} already has a stair down`)
      }
    }
    const before = ringOutsidePlan(canvas, desc, lo, hi)
    stampParticipants((cx, cy, cz) => canvas.globalChunk(cx, cy, cz), desc, lo, hi, (d) => canvas.markWritten(d))
    remassStampRing(canvas, desc, { ...ctx, cy0: lo, cy1: hi }, { before })
  }

  const catalogAt = (plan, meta) => {
    const desc = bySlot(meta.slot)
    if (!desc) return nullSlot(meta.slot)
    const { bounds, levels, columns, piers, core } = plan
    checkPlan(desc, { bounds, levels, columns, piers, core: core ?? null, baseCy: meta.baseCy }, o, label)
    stampWorld(desc)
    return localView(desc, o)
  }

  return Object.freeze({
    catalog(map, plan, meta) {
      return catalogAt(plan, meta)
    },
    customCatalog(map, draft) {
      const desc = bySlot(draft.slot)
      if (!desc) return nullSlot(draft.slot)
      checkPlan(desc, {
        bounds: draft.globalBounds,
        levels: draft.levels,
        columns: draft.columns,
        piers: draft.piers,
        core: draft.core,
        baseCy: draft.baseCy,
        links: draft.verticalLinks ?? [],
      }, o, label)
      stampWorld(desc)
      return { desc: localView(desc, o) }
    },
    atrium(map, spec) {
      if (!atriumAsCatalog) throw new Error(`kit:no-atrium-conversion (${label})`)
      const { plan, meta } = atriumAsCatalog(spec)
      const view = catalogAt(plan, meta)
      return view ? { descriptor: view } : null
    },
    stairwell(map, plan, opts) {
      const reasons = stairwellConflicts((cx, cy, cz) => canvas.chunkAt(cx, cy, cz), plan)
      if (reasons.length) throw slotTaken(`${label} stairwell: ${reasons.join('; ')}`)
      return stampStairwell((cx, cy, cz) => {
        const d = canvas._touch(cx, cy, cz)
        canvas.markWritten(d)
        return d
      }, plan, opts)
    },
    stairs(map, { cx, cy, cz, up, down }) {
      const d = canvas.ensureChunk(cx, cy, cz)
      stampStairsChecked(d, { up, down })
      canvas.markWritten(d)
      return d
    },
  })
}

// --- markers ---------------------------------------------------------------------

const originOf = (map, ctx) => map.origin ?? ctx?.origin ?? ZERO

// The kind's exit cell (kind-local gx, gz on storey cy). Finite mode writes
// the chunk's exit exactly as the kinds do; tile mode records the GLOBAL cell
// as an exit candidate (ctx.exits) and writes nothing.
export function markExit(map, ctx, { gx, gz, cy }) {
  if (ctx?.mode === 'tile') {
    const o = originOf(map, ctx)
    const cell = { gx: gx + o.cx * CHUNK, gz: gz + o.cz * CHUNK, cy: cy + o.cy }
    ctx.exits.push(cell)
    return cell
  }
  const d = map.chunkAt(map.cellChunk(gx), cy, map.cellChunk(gz))
  d.exit = { lx: map.cellLocal(gx), lz: map.cellLocal(gz) }
  return d.exit
}

// The kind's spawn cell: nothing in finite mode (the kind returns its own
// spawn); tile mode records the GLOBAL cell (ctx.spawns).
export function markSpawn(map, ctx, { gx, gz, cy }) {
  if (ctx?.mode !== 'tile') return null
  const o = originOf(map, ctx)
  const cell = { gx: gx + o.cx * CHUNK, gz: gz + o.cz * CHUNK, cy: cy + o.cy }
  ctx.spawns.push(cell)
  return cell
}
