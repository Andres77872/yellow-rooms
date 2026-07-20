import { describe, it, expect } from 'vitest'
import { pushDoorFrame, pushDoorLeaves, pushWindowTrim } from '../objects/joinery/index.js'
import {
  CELL,
  WALL_H,
  THICK,
  HEADER_H,
  FRAME_W,
  FRAME_DEPTH,
  FRAME_BAND_W,
  FRAME_BAND_DEPTH,
  FRAME_CORNER,
  FRAME_CORNER_DEPTH,
  DOOR_H as DOOR_H_CONST,
  DOOR_OPENING_W,
  DOOR_LEAF_W,
  DOOR_PLINTH_W,
  DOOR_LEAF_THICK,
  DOOR_LEAF_GAP,
  DOOR_PANEL_PROUD,
  DOOR_PANEL_MID_Y,
  DOOR_LOUVER_COUNT,
  DOOR_KICK_H,
  DOOR_KNOB_W,
  WINDOW_SILL_H,
  WINDOW_HEAD_Y,
  WINDOW_TRIM_W,
  WINDOW_MULLION_W,
  WINDOW_STOOL_H,
  WINDOW_APRON_H,
  WINDOW_BLIND_SLATS,
} from '../constants.js'

// Re-derived independently of constants.js so a drifted export is caught.
const DOOR_H = WALL_H - HEADER_H
const OPENING_W = CELL - 2 * FRAME_W // clear span between the jambs
const LEAF_W = OPENING_W / 2 // each leaf of the pair

// Extent helpers over {px,py,pz,sx,sy,sz} descriptors.
const xSpan = (b) => [b.px - b.sx / 2, b.px + b.sx / 2]
const ySpan = (b) => [b.py - b.sy / 2, b.py + b.sy / 2]
const zSpan = (b) => [b.pz - b.sz / 2, b.pz + b.sz / 2]
const overlap = (a, b) => Math.min(a[1], b[1]) - Math.max(a[0], b[0])

describe('door size contract (constants.js)', () => {
  it('exports the derived opening / leaf sizes consistently', () => {
    expect(DOOR_H_CONST).toBeCloseTo(DOOR_H, 12)
    expect(DOOR_OPENING_W).toBeCloseTo(OPENING_W, 12)
    expect(DOOR_LEAF_W).toBeCloseTo(LEAF_W, 12)
    expect(2 * DOOR_LEAF_W).toBeCloseTo(DOOR_OPENING_W, 12)
  })

  it('staggers every casing depth strictly proud of the wall', () => {
    // THICK < band < jamb < plinth < cap < corner: each layer catches its own
    // cel step, and no casing face is ever coplanar with a wall face.
    const plinthDepth = FRAME_DEPTH + 0.02
    const capDepth = FRAME_DEPTH + 0.03
    expect(FRAME_BAND_DEPTH).toBeGreaterThan(THICK)
    expect(FRAME_DEPTH).toBeGreaterThan(FRAME_BAND_DEPTH)
    expect(plinthDepth).toBeGreaterThan(FRAME_DEPTH)
    expect(capDepth).toBeGreaterThan(plinthDepth)
    expect(FRAME_CORNER_DEPTH).toBeGreaterThan(capDepth)
  })

  it('gives the swung leaf clearance over the plinth toe at its hinge', () => {
    expect((DOOR_PLINTH_W - FRAME_W) / 2).toBeLessThan(DOOR_LEAF_GAP)
    expect(DOOR_LEAF_GAP).toBeCloseTo((FRAME_BAND_W - FRAME_W) / 2, 12)
  })
})

describe('pushDoorFrame', () => {
  it('dresses a vertical doorway with a symmetric 10-box architrave casing', () => {
    const out = []
    pushDoorFrame(out, 'v', 4, 7)
    expect(out).toHaveLength(10)
    const plane = 4 * CELL
    const centre = (7 + 0.5) * CELL
    for (const b of out) {
      expect(b.px).toBeCloseTo(plane, 10) // every box centred on the wall plane
      expect(b.sx).toBeGreaterThan(THICK) // strictly proud of the wall — never coplanar
    }
    // Symmetry about the gap centre: offset boxes come in mirrored pairs.
    const offCentre = out.filter((b) => Math.abs(b.pz - centre) > 1e-9)
    expect(offCentre).toHaveLength(8) // 2 jambs + 2 bands + 2 corners + 2 plinths
    for (const b of offCentre) {
      const mirror = out.find(
        (m) =>
          m !== b &&
          Math.abs(m.pz - (2 * centre - b.pz)) < 1e-9 &&
          Math.abs(m.py - b.py) < 1e-9 &&
          Math.abs(m.sy - b.sy) < 1e-9
      )
      expect(mirror, `mirror of box at z=${b.pz}`).toBeTruthy()
    }
    // The lintel closes exactly to the ceiling line.
    const lintel = out.find((b) => Math.abs(b.py - (DOOR_H + HEADER_H / 2)) < 1e-9)
    expect(lintel).toBeTruthy()
    expect(ySpan(lintel)[1]).toBeCloseTo(WALL_H, 10)
  })

  it('steps the profile: band < jamb < plinth < cap < corner in proudness', () => {
    const out = []
    pushDoorFrame(out, 'h', 3, 5)
    const depths = out.map((b) => b.sz).sort((a, b) => a - b)
    // Distinct stepped depths, from the shallow back-band to the proud corner.
    expect(Math.min(...depths)).toBeCloseTo(FRAME_BAND_DEPTH, 10) // back-bands
    expect(Math.max(...depths)).toBeCloseTo(FRAME_CORNER_DEPTH, 10) // corner blocks
  })

  it('lifts the corner blocks into the header zone, above the opening', () => {
    const out = []
    pushDoorFrame(out, 'v', 4, 7)
    const corners = out.filter((b) => b.sy === FRAME_CORNER && b.sx === FRAME_CORNER_DEPTH)
    expect(corners).toHaveLength(2)
    for (const c of corners) {
      expect(ySpan(c)[0]).toBeGreaterThanOrEqual(DOOR_H - 1e-9) // clear of the opening
      expect(ySpan(c)[1]).toBeLessThanOrEqual(WALL_H + 1e-9) // inside the header band
    }
  })

  it('keeps the walkable opening clear (bar real-trim ankle intrusion)', () => {
    for (const axis of ['v', 'h']) {
      const out = []
      pushDoorFrame(out, axis, 3, 5)
      const plane = 3 * CELL
      const centre = (5 + 0.5) * CELL
      const clear = [centre - OPENING_W / 2, centre + OPENING_W / 2]
      for (const b of out) {
        const along = axis === 'v' ? zSpan(b) : xSpan(b)
        const across = axis === 'v' ? xSpan(b) : zSpan(b)
        const y = ySpan(b)
        if (y[0] >= DOOR_H) continue // header zone is allowed to fill
        // Trim may stand proud ACROSS the plane (it frames the mouth) but may
        // not narrow the clear span along it beyond the back-band's 4cm toe.
        const into = overlap(along, clear)
        expect(into).toBeLessThanOrEqual((FRAME_BAND_W - FRAME_W) / 2 + 1e-9)
        expect(overlap(across, [plane - THICK / 2, plane + THICK / 2])).toBeGreaterThan(0)
      }
    }
  })
})

describe('pushDoorLeaves', () => {
  const base = { axis: 'v', line: 4, cell: 7, leaf: true, leaves: [{ hinge: 1, face: 1 }], tone: 0.5, style: 0 }

  it('builds a 5-part two-panel door per leaf (slab, 2 moldings, kick, knob)', () => {
    const out = []
    pushDoorLeaves(out, base)
    expect(out).toHaveLength(5)
    expect(out.filter((b) => b.role === 0)).toHaveLength(3) // paint
    expect(out.filter((b) => b.role === 1)).toHaveLength(2) // kick + knob metal
    // A pair doubles the parts.
    const pair = []
    pushDoorLeaves(pair, { ...base, leaves: [{ hinge: -1, face: 1 }, { hinge: 1, face: -1 }] })
    expect(pair).toHaveLength(10)
  })

  it('adds a mid rail molding for the three-panel style', () => {
    const out = []
    pushDoorLeaves(out, { ...base, style: 0.6 })
    expect(out).toHaveLength(6)
    const mid = out.find((b) => Math.abs(b.py - DOOR_PANEL_MID_Y) < 1e-9)
    expect(mid).toBeTruthy()
    expect(mid.role).toBe(0)
  })

  it('slatts the upper half for the louvered style', () => {
    const out = []
    pushDoorLeaves(out, { ...base, style: 0.9 })
    // slab + lower panel + N louvers + kick + knob
    expect(out).toHaveLength(4 + DOOR_LOUVER_COUNT)
    const louvers = out.filter((b) => b.role === 0 && b.py > 1.3 && b.sy < 0.1)
    expect(louvers).toHaveLength(DOOR_LOUVER_COUNT)
  })

  it('fits the framed opening: two leaves are each half the clear span', () => {
    const out = []
    pushDoorLeaves(out, base)
    const slab = out.find((b) => b.role === 0 && b.sy === DOOR_H)
    expect(slab.sz).toBeCloseTo(LEAF_W, 10)
    expect(2 * LEAF_W).toBeCloseTo(OPENING_W, 10)
  })

  it('stays flat against the neighbour cell and off the passage mouth', () => {
    for (const style of [0, 0.6, 0.95]) {
      for (const hinge of [-1, 1]) {
        for (const face of [-1, 1]) {
          const out = []
          pushDoorLeaves(out, { ...base, style, leaves: [{ hinge, face }] })
          const plane = 4 * CELL
          const n0 = (7 + hinge) * CELL
          const n1 = (7 + hinge + 1) * CELL
          for (const b of out) {
            // Whole part inside the neighbour cell span (never over the opening).
            const [z0, z1] = zSpan(b)
            expect(z0).toBeGreaterThanOrEqual(n0 - 1e-9)
            expect(z1).toBeLessThanOrEqual(n1 + 1e-9)
            // Whole part on the room side of the wall face (never in the wall
            // slab or the doorway throat).
            const [x0, x1] = xSpan(b)
            if (face === 1) expect(x0).toBeGreaterThanOrEqual(plane + THICK / 2 - 1e-9)
            else expect(x1).toBeLessThanOrEqual(plane - THICK / 2 + 1e-9)
            // Nothing prouder than leaf + panel off the wall face (the knob
            // excepted — a knob legitimately stands past the moldings).
            if (b.role !== 1) {
              const reach = Math.max(Math.abs(x0 - plane), Math.abs(x1 - plane))
              expect(reach).toBeLessThanOrEqual(
                THICK / 2 + DOOR_LEAF_THICK + DOOR_PANEL_PROUD + 1e-9
              )
            }
          }
        }
      }
    }
  })

  it('puts the knob at the leading edge, away from the hinge side', () => {
    const out = []
    pushDoorLeaves(out, base)
    const knobs = out.filter((b) => b.role === 1 && b.sy > DOOR_KICK_H)
    expect(knobs).toHaveLength(1)
    const zl = 8 * CELL + DOOR_LEAF_GAP + LEAF_W / 2 // hinge 1 -> leaf centre in cell 8
    expect(knobs[0].pz).toBeGreaterThan(zl) // leading edge on the +z side
    expect(Math.abs(knobs[0].pz - (zl + LEAF_W / 2 - DOOR_KNOB_W))).toBeLessThan(1e-9)
  })

  it('mirrors a pair across the wall: one leaf per flanking cell, one per face', () => {
    const out = []
    pushDoorLeaves(out, {
      ...base,
      leaves: [{ hinge: -1, face: 1 }, { hinge: 1, face: -1 }],
    })
    const plane = 4 * CELL
    const slabs = out.filter((b) => b.role === 0 && b.sy === DOOR_H)
    expect(slabs).toHaveLength(2)
    const [low, high] = [...slabs].sort((a, b) => a.pz - b.pz)
    expect(low.pz).toBeLessThan(7 * CELL) // inside the low neighbour cell
    expect(low.px).toBeGreaterThan(plane + THICK / 2) // on the +face side
    expect(high.pz).toBeGreaterThan(8 * CELL) // inside the high neighbour cell
    expect(high.px).toBeLessThan(plane - THICK / 2) // on the -face side
  })

  it('never interpenetrates the casing: frame and leaf boxes may only touch', () => {
    // The two assemblies dress the same doorway from either side of the cell
    // boundary; a box of one poking into a box of the other reads as clipped
    // geometry. Touching faces (zero-depth contact) are fine — the leaf's
    // hinge edge deliberately kisses the back-band toe.
    for (const style of [0, 0.6, 0.95]) {
      for (const hinge of [-1, 1]) {
        for (const face of [-1, 1]) {
          const frame = []
          pushDoorFrame(frame, 'v', 4, 7)
          const leaves = []
          pushDoorLeaves(leaves, { ...base, style, leaves: [{ hinge, face }] })
          for (const f of frame) {
            for (const l of leaves) {
              const depth = Math.min(
                overlap(xSpan(f), xSpan(l)),
                overlap(ySpan(f), ySpan(l)),
                overlap(zSpan(f), zSpan(l))
              )
              expect(depth, `frame box at (${f.py.toFixed(2)},${f.pz.toFixed(2)}) vs leaf part`)
                .toBeLessThanOrEqual(1e-9)
            }
          }
        }
      }
    }
  })
})

describe('pushWindowTrim', () => {
  it('frames the aperture with casing, stool, apron and a glazing cross', () => {
    const out = []
    pushWindowTrim(out, 'h', 2, 9, 0)
    expect(out).toHaveLength(7)
    const plane = 2 * CELL
    const centre = (9 + 0.5) * CELL
    for (const b of out) expect(b.pz).toBeCloseTo(plane, 10)

    // Stool top sits flush with the sill line.
    const stool = out.find((b) => Math.abs(ySpan(b)[1] - WINDOW_SILL_H) < 1e-9)
    expect(stool).toBeTruthy()
    expect(stool.sy).toBeCloseTo(WINDOW_STOOL_H, 10)

    // Apron board directly under the stool.
    const apron = out.find((b) => Math.abs(b.sy - WINDOW_APRON_H) < 1e-9)
    expect(apron).toBeTruthy()
    expect(ySpan(apron)[1]).toBeCloseTo(WINDOW_SILL_H - WINDOW_STOOL_H, 10)

    // Glazing cross: two slim bars through the opening centre, clearly slimmer
    // than the casings so they read as joinery, not trim.
    const bars = out.filter((b) => b.sx === WINDOW_MULLION_W || b.sy === WINDOW_MULLION_W)
    expect(bars).toHaveLength(2)
    for (const bar of bars) {
      expect(bar.px).toBeCloseTo(centre, 10)
      expect(bar.py).toBeCloseTo((WINDOW_SILL_H + WINDOW_HEAD_Y) / 2, 10)
    }
    expect(WINDOW_MULLION_W).toBeLessThan(WINDOW_TRIM_W)

    // Nothing escapes the cell span.
    for (const b of out) {
      const [x0, x1] = xSpan(b)
      expect(x0).toBeGreaterThanOrEqual(9 * CELL - 1e-9)
      expect(x1).toBeLessThanOrEqual(10 * CELL + 1e-9)
    }
  })

  it('drops the horizontal bar for the single-bar variant', () => {
    const out = []
    pushWindowTrim(out, 'v', 3, 4, 0.6)
    expect(out).toHaveLength(6)
    const bars = out.filter((b) => b.sx === WINDOW_MULLION_W || b.sy === WINDOW_MULLION_W)
    expect(bars).toHaveLength(1) // vertical bar only
  })

  it('hangs venetian blinds for the blind variant, all inside the aperture', () => {
    const out = []
    pushWindowTrim(out, 'h', 2, 9, 0.9)
    // 3 casings + stool + apron + 2 rails + N slats
    expect(out).toHaveLength(7 + WINDOW_BLIND_SLATS)
    const slats = out.filter((b) => b.sy < 0.13 && b.sz < WINDOW_TRIM_W && b.py > WINDOW_SILL_H && b.py < WINDOW_HEAD_Y)
    expect(slats.length).toBeGreaterThanOrEqual(WINDOW_BLIND_SLATS)
    for (const b of out) {
      const [x0, x1] = xSpan(b)
      expect(x0).toBeGreaterThanOrEqual(9 * CELL - 1e-9)
      expect(x1).toBeLessThanOrEqual(10 * CELL + 1e-9)
      const [y0, y1] = ySpan(b)
      expect(y0).toBeGreaterThanOrEqual(0)
      expect(y1).toBeLessThanOrEqual(WINDOW_HEAD_Y + WINDOW_TRIM_W / 2 + 1e-9)
    }
  })

  it('is deterministic per tone and defaults to the cross', () => {
    const a = []
    const b = []
    pushWindowTrim(a, 'v', 1, 1, 0.3)
    pushWindowTrim(b, 'v', 1, 1, 0.3)
    expect(a).toEqual(b)
    const def = []
    pushWindowTrim(def, 'v', 1, 1)
    expect(def).toHaveLength(7) // tone 0 -> cross
  })
})
