import { describe, expect, it } from 'vitest'
import { CHUNK, ZONE_OFFICE, cIdx, vIdx } from '../../constants.js'
import { ChunkData } from '../../ChunkData.js'
import { COLUMN_STANDARD, PASSAGE_WALL } from '../../mapTypes.js'
import {
  analyzeCatalogDescriptor,
  assembleCatalogDescriptor,
  linkHalo,
} from '../../structures/catalog/engine.js'
import { stampCatalogStructure } from '../../structures/catalog/stamp.js'
import { atriumDescriptor, stairwellPlan, stampAtrium, stampStairwell } from '../../structures/authored.js'
import { deepFreeze } from '../../mapFamily.js'
import { EditorMap } from '../../../editor/EditorMap.js'
import { TileCanvas } from '../TileCanvas.js'
import {
  EDITOR_KIT,
  finiteCtx,
  localView,
  makeWorldKit,
  markExit,
  markSpawn,
  remassStampRing,
  stampStairsChecked,
} from '../kit.js'
import { exitCellClear, spawnCellOk } from '../cells.js'

// The structure kit (spec §6.3): finite mode reproduces the kinds' inline
// code; tile mode looks volumes up by slot, proves the kind's plan matches the
// planner's global descriptor, stamps the tile's storeys and returns the
// kind-local view.

const ORIGIN = Object.freeze({ cx: 3, cy: 5, cz: -2 })
const shiftRect = (r, dx, dz) => ({ x0: r.x0 + dx, z0: r.z0 + dz, x1: r.x1 + dx, z1: r.z1 + dz })

// A two-chunk tower volume in kind-local cells (poolrooms' plan shape).
const LOCAL_PLAN = Object.freeze({
  label: 'test hall',
  bounds: { x0: 2, z0: 2, x1: 24, z1: 11 },
  levels: [{ voids: [] }, { voids: [{ x0: 5, z0: 5, x1: 9, z1: 8 }] }, { voids: [{ x0: 17, z0: 4, x1: 21, z1: 7 }], bridges: [] }],
  columns: [{ gx: 20, gz: 9 }],
  piers: [],
  core: null,
  links: 'auto',
  glazing: 'rail',
})
const META = Object.freeze({
  id: 0x80001234, family: 'tower', type: 'testHall', sizeClass: 'small',
  district: { x: 0, z: 0, size: 4 }, bandIndex: 0, slot: 7, baseCy: 0,
})
const pickOf = (seed) => {
  let k = 0
  return (n) => (seed * 31 + 7 * k++) % n
}

function globalPlan(plan, o) {
  const dx = o.cx * CHUNK
  const dz = o.cz * CHUNK
  return {
    ...plan,
    bounds: shiftRect(plan.bounds, dx, dz),
    levels: plan.levels.map((l) => ({ voids: (l.voids ?? []).map((r) => shiftRect(r, dx, dz)), bridges: (l.bridges ?? []).map((r) => shiftRect(r, dx, dz)) })),
    columns: plan.columns.map((c) => ({ gx: c.gx + dx, gz: c.gz + dz })),
    piers: plan.piers.map((c) => ({ gx: c.gx + dx, gz: c.gz + dz })),
  }
}

// The planner's descriptor at true global coordinates.
const globalDesc = (seed = 1, o = ORIGIN) =>
  assembleCatalogDescriptor(globalPlan(LOCAL_PLAN, o), { ...META, baseCy: META.baseCy + o.cy }, pickOf(seed))

function tileCtx(canvas, structures, extra = {}) {
  return { mode: 'tile', family: 'tower', origin: canvas.origin, cy0: ORIGIN.cy, cy1: ORIGIN.cy + 2, structures, exits: [], spawns: [], notes: [], ...extra }
}

const rasters = (d) => ({
  cols: Array.from(d.cols),
  cellKind: Array.from(d.cellKind),
  spaceId: Array.from(d.spaceId),
  wallV: Array.from(d.wallV),
  wallH: Array.from(d.wallH),
  passageV: Array.from(d.passageV),
  passageH: Array.from(d.passageH),
  wallFeatureV: Array.from(d.wallFeatureV),
  wallFeatureH: Array.from(d.wallFeatureH),
  stairUp: JSON.stringify(d.stairUp),
  stairDown: JSON.stringify(d.stairDown),
})

describe('localView', () => {
  const desc = deepFreeze({
    id: 0x80000001,
    slot: 2,
    baseCy: 4,
    bottomCy: 4,
    topCy: 6,
    anchor: { cx: 5, cz: 7 },
    participants: [{ cx: 5, cz: 7 }, { cx: 6, cz: 7 }],
    participantChunks: [{ cx: 5, cz: 7 }, { cx: 6, cz: 7 }],
    globalBounds: { x0: 71, z0: 99, x1: 92, z1: 108 },
    levels: [
      { levelCy: 4, voids: [], bridges: [] },
      { levelCy: 5, voids: [{ x0: 74, z0: 101, x1: 78, z1: 104 }], bridges: [{ x0: 74, z0: 102, x1: 78, z1: 102 }] },
      { levelCy: 6, voids: [], bridges: [] },
    ],
    columns: [{ gx: 80, gz: 100 }],
    piers: [{ gx: 81, gz: 101 }],
    core: { gx: 86, gz: 102, dir: 1, side: 1, well: false, enclosed: false, doorSide: 'near', rect: { x0: 85, z0: 101, x1: 90, z1: 104 } },
    verticalLinks: [
      { lowerCy: 4, cx: 5, cz: 7, stair: { dir: 1, landing: { lx: 3, lz: 4 }, run: [{ lx: 4, lz: 4 }, { lx: 5, lz: 4 }], exit: { lx: 6, lz: 4 } } },
      { lowerCy: 5, cx: 6, cz: 7, stair: { dir: 3, landing: { lx: 9, lz: 9 }, run: [{ lx: 8, lz: 9 }, { lx: 7, lz: 9 }], exit: { lx: 6, lz: 9 } } },
    ],
  })
  const o = { cx: 5, cy: 4, cz: 7 }

  it('translates chunk, cell and storey fields by the origin', () => {
    const v = localView(desc, o)
    expect(Object.isFrozen(v)).toBe(false)
    expect(Object.isFrozen(v.levels[1])).toBe(false)
    expect(v.anchor).toEqual({ cx: 0, cz: 0 })
    expect(v.participants).toEqual([{ cx: 0, cz: 0 }, { cx: 1, cz: 0 }])
    expect(v.participantChunks).toEqual([{ cx: 0, cz: 0 }, { cx: 1, cz: 0 }])
    expect(v.globalBounds).toEqual({ x0: 1, z0: 1, x1: 22, z1: 10 })
    expect([v.baseCy, v.bottomCy, v.topCy]).toEqual([0, 0, 2])
    expect(v.levels.map((l) => l.levelCy)).toEqual([0, 1, 2])
    expect(v.levels[1].voids).toEqual([{ x0: 4, z0: 3, x1: 8, z1: 6 }])
    expect(v.levels[1].bridges).toEqual([{ x0: 4, z0: 4, x1: 8, z1: 4 }])
    expect(v.columns).toEqual([{ gx: 10, gz: 2 }])
    expect(v.piers).toEqual([{ gx: 11, gz: 3 }])
    expect(v.core).toMatchObject({ gx: 16, gz: 4, dir: 1, rect: { x0: 15, z0: 3, x1: 20, z1: 6 } })
    expect(v.verticalLinks.map((l) => [l.lowerCy, l.cx, l.cz])).toEqual([[0, 0, 0], [1, 1, 0]])
    // Chunk-local stair cells are unchanged.
    expect(v.verticalLinks.map((l) => l.stair)).toEqual(desc.verticalLinks.map((l) => l.stair))
    // Untouched fields survive; the source stays as it was.
    expect([v.id, v.slot]).toEqual([desc.id, desc.slot])
    expect(desc.globalBounds).toEqual({ x0: 71, z0: 99, x1: 92, z1: 108 })
  })

  it('linkHalo on the view yields kind-local cells', () => {
    const v = localView(desc, o)
    for (let i = 0; i < desc.verticalLinks.length; i++) {
      expect(linkHalo(v.verticalLinks[i])).toEqual(shiftRect(linkHalo(desc.verticalLinks[i]), -o.cx * CHUNK, -o.cz * CHUNK))
    }
  })

  it('is an identity copy at origin 0 and null for null', () => {
    expect(localView(desc, { cx: 0, cy: 0, cz: 0 })).toEqual(JSON.parse(JSON.stringify(desc)))
    expect(localView(null, o)).toBe(null)
  })
})

describe('EDITOR_KIT reproduces the kinds\' inline code', () => {
  const snapAll = (map) => [...map.chunks.entries()].map(([k, d]) => [k, rasters(d)])

  it('catalog: assemble, fail closed, stamp every participant storey', () => {
    const inline = new EditorMap()
    let why = null
    const desc = assembleCatalogDescriptor(LOCAL_PLAN, META, pickOf(3), (r) => { why = r })
    for (const p of desc.participants) {
      for (let cy = desc.baseCy; cy <= desc.topCy; cy++) {
        const d = inline._touch(p.cx, cy, p.cz)
        d._protV.clear()
        d._protH.clear()
        stampCatalogStructure(d, desc)
      }
    }
    const viaKit = new EditorMap()
    const got = EDITOR_KIT.catalog(viaKit, LOCAL_PLAN, META, pickOf(3), (r) => { why = r })
    expect(why).toBe(null)
    expect(Object.isFrozen(got)).toBe(true)
    expect(got).toEqual(desc)
    expect(snapAll(viaKit)).toEqual(snapAll(inline))
    // A rejected plan returns null and reports why.
    const bad = { ...LOCAL_PLAN, levels: [{ voids: [] }, { voids: [{ x0: 2, z0: 2, x1: 24, z1: 11 }] }] }
    let reasons = null
    expect(EDITOR_KIT.catalog(new EditorMap(), bad, META, pickOf(3), (r) => { reasons = r })).toBe(null)
    expect(reasons?.length).toBeGreaterThan(0)
  })

  it('customCatalog: analyse, freeze, stamp; errors carry the reasons', () => {
    const draft = () => structuredClone(assembleCatalogDescriptor(LOCAL_PLAN, META, pickOf(5)))
    const inline = new EditorMap()
    const d0 = draft()
    expect(analyzeCatalogDescriptor(d0).ok).toBe(true)
    const frozen = deepFreeze(d0)
    for (const p of frozen.participants) {
      for (let cy = frozen.baseCy; cy <= frozen.topCy; cy++) {
        const d = inline._touch(p.cx, cy, p.cz)
        d._protV.clear()
        d._protH.clear()
        stampCatalogStructure(d, frozen)
      }
    }
    const viaKit = new EditorMap()
    const res = EDITOR_KIT.customCatalog(viaKit, draft())
    expect(Object.isFrozen(res.desc)).toBe(true)
    expect(snapAll(viaKit)).toEqual(snapAll(inline))
    const broken = draft()
    broken.verticalLinks = []
    const err = EDITOR_KIT.customCatalog(new EditorMap(), broken)
    expect(err.error).toBe(err.reasons.join(', '))
    expect(err.reasons.length).toBeGreaterThan(0)
  })

  it('atrium, stairwell and raw stairs', () => {
    const spec = { x0: 2, z0: 2, x1: 10, z1: 9, baseCy: 0, levels: 3, kind: 'openVoid' }
    const inline = new EditorMap()
    const a = atriumDescriptor(spec)
    stampAtrium((cx, cy, cz) => inline._touch(cx, cy, cz), a.descriptor)
    const plan = stairwellPlan({ gx: CHUNK + 4, gz: 4, baseCy: 0, topCy: 2 })
    stampStairwell((cx, cy, cz) => inline._touch(cx, cy, cz), plan, { enclosed: true })

    const viaKit = new EditorMap()
    expect(EDITOR_KIT.atrium(viaKit, spec)).toEqual({ descriptor: a.descriptor })
    expect(EDITOR_KIT.stairwell(viaKit, plan, { enclosed: true })).toHaveLength(3)
    expect(snapAll(viaKit)).toEqual(snapAll(inline))
    expect(EDITOR_KIT.atrium(new EditorMap(), { ...spec, levels: 1 }).error).toMatch(/2 storeys/)

    const map = new EditorMap()
    const up = plan.flights[0].stair
    const d = EDITOR_KIT.stairs(map, { cx: 2, cy: 0, cz: 1, up })
    expect(d.stairUp).toBe(up)
    expect(d.stairDown).toBe(null)
    EDITOR_KIT.stairs(map, { cx: 2, cy: 0, cz: 1, up: null, down: up })
    expect([d.stairUp, d.stairDown]).toEqual([null, up])
  })

  it('finiteCtx is the finite-mode ctx', () => {
    const ctx = finiteCtx({ floors: 3 })
    expect(ctx).toEqual({ mode: 'finite', kit: EDITOR_KIT, params: { floors: 3 } })
    expect(Object.isFrozen(ctx.params)).toBe(true)
  })
})

describe('makeWorldKit', () => {
  const newCanvas = (extra = {}) => new TileCanvas({ family: 'poolrooms', base: 'tower', version: 28, worldSeed: 1, origin: ORIGIN, ...extra })

  it('stamps the planner\'s volume at true coordinates and returns the local view', () => {
    const desc = globalDesc(1)
    expect(desc).not.toBe(null)
    const canvas = newCanvas()
    const ctx = tileCtx(canvas, [desc])
    const kit = makeWorldKit(ctx, canvas)
    const view = kit.catalog(canvas, LOCAL_PLAN, META, () => { throw new Error('no picks in a bake') })
    expect(view).toEqual(localView(desc, ORIGIN))

    // The same volume assembled finite at origin 0 is the local view, and
    // its stamped chunks match the world's slice for slice.
    const map = new EditorMap()
    const finite = EDITOR_KIT.catalog(map, LOCAL_PLAN, META, pickOf(1))
    expect(JSON.parse(JSON.stringify(finite))).toEqual(view)
    for (const p of finite.participants) {
      for (let cy = 0; cy < LOCAL_PLAN.levels.length; cy++) {
        const w = canvas.chunkAt(p.cx, cy, p.cz)
        expect([w.cx, w.cy, w.cz]).toEqual([p.cx + ORIGIN.cx, cy + ORIGIN.cy, p.cz + ORIGIN.cz])
        expect(w.structure).toBe(desc)
        expect(rasters(w)).toEqual(rasters(map.chunkAt(p.cx, cy, p.cz)))
      }
    }
    // Stamped chunks are written: exported as they are, not as solid.
    expect(canvas.exportChunks().size).toBe(finite.participants.length * 3)
    expect(canvas.stats.untouchedKept).toBe(0)
  })

  it('stamps only the tile band [cy0, cy1]', () => {
    const desc = globalDesc(1)
    const canvas = newCanvas()
    const kit = makeWorldKit(tileCtx(canvas, [desc], { cy0: ORIGIN.cy + 1, cy1: ORIGIN.cy + 1 }), canvas)
    expect(kit.catalog(canvas, LOCAL_PLAN, META)).not.toBe(null)
    expect([...canvas.chunks.values()].map((d) => d.cy)).toEqual(desc.participants.map(() => ORIGIN.cy + 1))
  })

  it('throws kit:planner-mismatch on any plan field that differs', () => {
    const desc = globalDesc(1)
    const variants = [
      { ...LOCAL_PLAN, bounds: { ...LOCAL_PLAN.bounds, x1: 23 } },
      { ...LOCAL_PLAN, levels: [{ voids: [] }, { voids: [{ x0: 5, z0: 5, x1: 9, z1: 9 }] }, LOCAL_PLAN.levels[2]] },
      { ...LOCAL_PLAN, levels: [...LOCAL_PLAN.levels.slice(0, 2), { ...LOCAL_PLAN.levels[2], bridges: [{ x0: 17, z0: 5, x1: 21, z1: 5 }] }] },
      { ...LOCAL_PLAN, levels: LOCAL_PLAN.levels.slice(0, 2) },
      { ...LOCAL_PLAN, columns: [] },
      { ...LOCAL_PLAN, piers: [{ gx: 3, gz: 3 }] },
      { ...LOCAL_PLAN, core: { gx: 14, gz: 4, dir: 1 } },
    ]
    for (const plan of variants) {
      const canvas = newCanvas()
      const kit = makeWorldKit(tileCtx(canvas, [desc]), canvas)
      expect(() => kit.catalog(canvas, plan, META)).toThrow(/kit:planner-mismatch/)
    }
    const canvas = newCanvas()
    const kit = makeWorldKit(tileCtx(canvas, [desc]), canvas)
    expect(() => kit.catalog(canvas, LOCAL_PLAN, { ...META, baseCy: 1 })).toThrow(/kit:planner-mismatch \(tower slot 7: baseCy\)/)
  })

  it('a missing slot is the no-volume path (null, noted)', () => {
    const canvas = newCanvas()
    const ctx = tileCtx(canvas, [globalDesc(1)])
    const kit = makeWorldKit(ctx, canvas)
    expect(kit.catalog(canvas, LOCAL_PLAN, { ...META, slot: 8 })).toBe(null)
    expect(ctx.notes).toEqual(['kit:null-slot 8'])
    expect(canvas.chunks.size).toBe(0)
  })

  it('customCatalog checks links and level count too', () => {
    const desc = globalDesc(2)
    const draft = localView(desc, ORIGIN)
    const canvas = newCanvas()
    const kit = makeWorldKit(tileCtx(canvas, [desc]), canvas)
    expect(kit.customCatalog(canvas, draft)).toEqual({ desc: draft })
    const moved = structuredClone(draft)
    moved.verticalLinks[0].stair.landing.lx += 1
    const c2 = newCanvas()
    expect(() => makeWorldKit(tileCtx(c2, [desc]), c2).customCatalog(c2, moved)).toThrow(/verticalLinks/)
  })

  it('atrium goes through the family geometry\'s conversion', () => {
    const desc = globalDesc(1)
    const canvas = newCanvas()
    const atriumAsCatalog = (spec) => ({ plan: { ...LOCAL_PLAN, label: spec.label }, meta: META })
    const kit = makeWorldKit(tileCtx(canvas, [desc]), canvas, { atriumAsCatalog })
    expect(kit.atrium(canvas, { label: 'x' })).toEqual({ descriptor: localView(desc, ORIGIN) })
    expect(() => makeWorldKit(tileCtx(canvas, [desc]), canvas).atrium(canvas, {})).toThrow(/kit:no-atrium-conversion/)
    // The bake wires it as ctx.atriumAsCatalog (makeTileCtx, from the generator).
    const viaCtx = makeWorldKit({ ...tileCtx(newCanvas(), [desc]), atriumAsCatalog }, newCanvas())
    expect(viaCtx.atrium(canvas, { label: 'x' })).toEqual({ descriptor: localView(desc, ORIGIN) })
    // A slot the planner left empty: null (not { error }), with a note.
    const notes = []
    const empty = makeWorldKit({ ...tileCtx(newCanvas(), []), notes, atriumAsCatalog }, newCanvas())
    expect(empty.atrium(canvas, { label: 'x' })).toBe(null)
    expect(notes).toEqual([`kit:null-slot ${META.slot}`])
  })

  describe('stair slots are checked both ways', () => {
    const setup = () => {
      const desc = globalDesc(1)
      const canvas = newCanvas()
      const kit = makeWorldKit(tileCtx(canvas, [desc]), canvas)
      const link = desc.verticalLinks[0]
      const local = { cx: link.cx - ORIGIN.cx, cy: link.lowerCy - ORIGIN.cy, cz: link.cz - ORIGIN.cz }
      return { desc, canvas, kit, link, local }
    }

    it('a raw flight first, then the volume', () => {
      const { canvas, kit, link, local } = setup()
      kit.stairs(canvas, { ...local, up: link.stair })
      expect(() => kit.catalog(canvas, LOCAL_PLAN, META)).toThrow(/kit:stair-slot-taken/)
    })

    it("a raw flight's down half first, then the volume", () => {
      const { canvas, kit, link, local } = setup()
      kit.stairs(canvas, { ...local, cy: local.cy + 1, down: link.stair })
      expect(() => kit.catalog(canvas, LOCAL_PLAN, META)).toThrow(/kit:stair-slot-taken/)
    })

    it('the volume first, then a raw flight or a stairwell core', () => {
      const { canvas, kit, link, local } = setup()
      kit.catalog(canvas, LOCAL_PLAN, META)
      expect(() => kit.stairs(canvas, { ...local, up: link.stair })).toThrow(/kit:stair-slot-taken/)
      expect(() => kit.stairs(canvas, { ...local, cy: local.cy + 1, down: link.stair })).toThrow(/kit:stair-slot-taken/)
      const gx = local.cx * CHUNK + 4
      const plan = stairwellPlan({ gx, gz: local.cz * CHUNK + 4, baseCy: local.cy, topCy: local.cy + 1 })
      expect(plan.error).toBeUndefined()
      expect(() => kit.stairwell(canvas, plan, { enclosed: true })).toThrow(/kit:stair-slot-taken/)
    })

    it('stampStairsChecked refuses a set slot and assigns otherwise', () => {
      const d = new ChunkData(0, 0, 0, ZONE_OFFICE)
      const s = stairwellPlan({ gx: 4, gz: 4, baseCy: 0, topCy: 1 }).flights[0].stair
      stampStairsChecked(d, { up: s })
      expect(d.stairUp).toBe(s)
      expect(() => stampStairsChecked(d, { up: s })).toThrow(/kit:stair-slot-taken/)
      stampStairsChecked(d, { down: s })
      expect(() => stampStairsChecked(d, { down: s })).toThrow(/kit:stair-slot-taken/)
      // Null never clears a set slot (it would orphan the link's other half)…
      expect(() => stampStairsChecked(d, { up: null })).toThrow(/kit:stair-slot-taken/)
      expect(() => stampStairsChecked(d, { down: null })).toThrow(/kit:stair-slot-taken/)
      expect([d.stairUp, d.stairDown]).toEqual([s, s])
      // …and is a plain write on an empty one; undefined leaves a half alone.
      const e = new ChunkData(1, 0, 0, ZONE_OFFICE)
      expect(() => stampStairsChecked(e, { up: null, down: undefined })).not.toThrow()
      expect([e.stairUp, e.stairDown]).toEqual([null, null])
    })

    it('a raw null flight cannot delete half of a stamped catalog link', () => {
      const { canvas, kit, link, local } = setup()
      kit.catalog(canvas, LOCAL_PLAN, META)
      expect(() => kit.stairs(canvas, { ...local, up: null })).toThrow(/kit:stair-slot-taken/)
      expect(() => kit.stairs(canvas, { ...local, cy: local.cy + 1, down: null })).toThrow(/kit:stair-slot-taken/)
      expect(canvas.chunkAt(local.cx, local.cy, local.cz).stairUp).toEqual(link.stair)
      expect(canvas.chunkAt(local.cx, local.cy + 1, local.cz).stairDown).toBeTruthy()
    })

    it('a free stairwell stamps through the world kit', () => {
      const canvas = newCanvas()
      const kit = makeWorldKit(tileCtx(canvas, []), canvas)
      const plan = stairwellPlan({ gx: 4, gz: 4, baseCy: 0, topCy: 2 })
      expect(kit.stairwell(canvas, plan, { enclosed: true })).toHaveLength(3)
      expect(canvas.chunkAt(0, 0, 0).stairUp).toEqual(plan.flights[0].stair)
      expect(canvas.chunkAt(0, 0, 0).cy).toBe(ORIGIN.cy)
      expect(canvas.exportChunks().size).toBe(3)
      expect(canvas.stats.untouchedKept).toBe(0)
    })
  })
})

describe('remassStampRing', () => {
  // One chunk tile (window = chunk 0,0) on storeys 0..1, drawn as solid mass
  // (the kind's plan). The volume's ring column x 13 is the chunk's east
  // column, facing the foreign chunk 1,0.
  const PLAN = { label: 'ring', bounds: { x0: 2, z0: 2, x1: 12, z1: 11 }, levels: [{ voids: [] }, { voids: [{ x0: 4, z0: 4, x1: 7, z1: 7 }] }], columns: [], piers: [], core: null, links: 'auto' }
  const M = { ...META, baseCy: 0, slot: 1 }

  function run(portsAt = null) {
    const keep = (gcx, gcy, gcz) => gcx === 0 && gcz === 0 && gcy >= 0 && gcy <= 1
    const canvas = new TileCanvas({ family: 'poolrooms', base: 'tower', version: 28, keep })
    for (let cy = 0; cy <= 1; cy++) {
      for (let gz = 0; gz < CHUNK; gz++) for (let gx = 0; gx < CHUNK; gx++) canvas.setCell(gx, cy, gz, { col: COLUMN_STANDARD })
    }
    const desc = assembleCatalogDescriptor(PLAN, M, pickOf(1))
    expect(desc).not.toBe(null)
    const ctx = { mode: 'tile', family: 'tower', cy0: 0, cy1: 1, structures: [desc], window: { cx0: 0, cz0: 0, cx1: 0, cz1: 0 }, portsAt, notes: [] }
    makeWorldKit(ctx, canvas).catalog(canvas, PLAN, M)
    return canvas
  }
  const colAt = (canvas, cy, x, z) => canvas.chunkAt(0, cy, 0).cols[cIdx(x, z)]
  const wallV = (canvas, cy, x, z) => canvas.chunkAt(0, cy, 0).wallV[vIdx(x, z)]

  it('re-masses the ring column facing a foreign chunk and walls it off', () => {
    const canvas = run()
    for (let cy = 0; cy <= 1; cy++) {
      for (let z = 1; z <= 12; z++) {
        expect(colAt(canvas, cy, 13, z), `cy ${cy} z ${z}`).toBe(COLUMN_STANDARD)
        expect(canvas.chunkAt(0, cy, 0).spaceId[cIdx(13, z)]).toBe(0)
        // The walkable cell west of it gets a plain wall on line 13.
        expect(colAt(canvas, cy, 12, z)).toBe(0)
        expect(wallV(canvas, cy, 13, z)).toBe(1)
        expect(canvas.chunkAt(0, cy, 0).passageV[vIdx(13, z)]).toBe(PASSAGE_WALL)
      }
      // Ring cells facing nothing foreign stay walkable.
      expect(colAt(canvas, cy, 1, 5)).toBe(0)
      expect(colAt(canvas, cy, 5, 12)).toBe(0)
    }
  })

  it('keeps declared port cells open', () => {
    const canvas = run((side) => (side === 'east' ? [{ a0: 5, a1: 6 }] : []))
    for (let cy = 0; cy <= 1; cy++) {
      for (let z = 1; z <= 12; z++) expect(colAt(canvas, cy, 13, z) === 0, `z ${z}`).toBe(z === 5 || z === 6)
    }
  })

  it('leaves ring cells that were plan cells alone', () => {
    const canvas = new TileCanvas({ family: 'poolrooms', base: 'tower', version: 28, keep: (x, y, z) => x === 0 && z === 0 })
    const desc = assembleCatalogDescriptor(PLAN, M, pickOf(1))
    canvas.setCell(13, 0, 6, { col: 0 }) // a plan cell on the ring
    stampCatalogStructure(canvas.globalChunk(0, 0, 0), desc)
    const res = remassStampRing(canvas, desc, { cy0: 0, cy1: 0, window: { cx0: 0, cz0: 0, cx1: 0, cz1: 0 } }, { before: new Set(['13,5,0']) })
    expect(res.restored).toBe(1)
    expect(colAt(canvas, 0, 13, 5)).toBe(COLUMN_STANDARD)
    expect(colAt(canvas, 0, 13, 6)).toBe(0)
  })
})

describe('markers', () => {
  it('markExit writes the chunk exit in finite mode, a global candidate in tile mode', () => {
    const map = new EditorMap()
    map.setCell(CHUNK + 3, 1, 5, { col: 0 })
    expect(markExit(map, finiteCtx(), { gx: CHUNK + 3, gz: 5, cy: 1 })).toEqual({ lx: 3, lz: 5 })
    expect(map.chunkAt(1, 1, 0).exit).toEqual({ lx: 3, lz: 5 })

    const canvas = new TileCanvas({ family: 'stairwell', origin: ORIGIN })
    canvas.setCell(CHUNK + 3, 1, 5, { col: 0 })
    const ctx = { mode: 'tile', origin: ORIGIN, exits: [], spawns: [] }
    markExit(canvas, ctx, { gx: CHUNK + 3, gz: 5, cy: 1 })
    expect(ctx.exits).toEqual([{ gx: (ORIGIN.cx + 1) * CHUNK + 3, gz: ORIGIN.cz * CHUNK + 5, cy: ORIGIN.cy + 1 }])
    expect(canvas.chunkAt(1, 1, 0).exit).toBe(null)
  })

  it('markSpawn records a global cell in tile mode only', () => {
    expect(markSpawn(new EditorMap(), finiteCtx(), { gx: 1, gz: 2, cy: 0 })).toBe(null)
    const canvas = new TileCanvas({ family: 'stairwell', origin: ORIGIN })
    const ctx = { mode: 'tile', exits: [], spawns: [] }
    markSpawn(canvas, ctx, { gx: 1, gz: 2, cy: 0 })
    expect(ctx.spawns).toEqual([{ gx: ORIGIN.cx * CHUNK + 1, gz: ORIGIN.cz * CHUNK + 2, cy: ORIGIN.cy }])
  })
})

describe('cells', () => {
  it('exitCellClear: standable, no column, off the stair strips by margin', () => {
    const d = new ChunkData(0, 0, 0, ZONE_OFFICE)
    d.stairUp = stairwellPlan({ gx: 4, gz: 4, baseCy: 0, topCy: 1 }).flights[0].stair // strip x 4..7, z 4
    expect(exitCellClear(d, 4, 4)).toBe(false)
    expect(exitCellClear(d, 4, 5)).toBe(true)
    expect(exitCellClear(d, 4, 5, 1)).toBe(false)
    expect(exitCellClear(d, 4, 6, 1)).toBe(true)
    d.setCol(10, 10, COLUMN_STANDARD)
    expect(exitCellClear(d, 10, 10)).toBe(false)
  })

  it('spawnCellOk needs 3 walkable neighbours', () => {
    const d = new ChunkData(0, 0, 0, ZONE_OFFICE)
    d.cols.fill(COLUMN_STANDARD)
    d.setCol(6, 6, 0)
    d.setCol(7, 6, 0)
    d.setCol(5, 6, 0)
    expect(spawnCellOk(d, 6, 6)).toBe(false)
    d.setCol(6, 7, 0)
    expect(spawnCellOk(d, 6, 6)).toBe(true)
    expect(spawnCellOk(d, 0, 0)).toBe(false)
  })
})
