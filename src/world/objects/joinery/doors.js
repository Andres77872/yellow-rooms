import {
  CELL,
  THICK,
  HEADER_H,
  DOOR_H,
  DOOR_LEAF_W,
  FRAME_W,
  FRAME_DEPTH,
  FRAME_BAND_W,
  FRAME_BAND_DEPTH,
  FRAME_CORNER,
  FRAME_CORNER_DEPTH,
  DOOR_LEAF_THICK,
  DOOR_LEAF_GAP,
  DOOR_PLINTH_H,
  DOOR_PLINTH_W,
  DOOR_CAP_H,
  DOOR_PANEL_PROUD,
  DOOR_PANEL_MARGIN,
  DOOR_PANEL_TOP_Y,
  DOOR_PANEL_TOP_H,
  DOOR_PANEL_BOT_Y,
  DOOR_PANEL_BOT_H,
  DOOR_PANEL_MID_Y,
  DOOR_PANEL_MID_H,
  DOOR_LOUVER_COUNT,
  DOOR_LOUVER_H,
  DOOR_LOUVER_LO,
  DOOR_LOUVER_HI,
  DOOR_KICK_Y,
  DOOR_KICK_H,
  DOOR_KNOB_Y,
  DOOR_KNOB_W,
  DOOR_KNOB_H,
} from '../../constants.js'
import { leafShade, liteGlass } from '../../doorSchedule.js'
import { box } from './frame.js'
import {
  HANDLE_BAR,
  HANDLE_KNOB,
  HANDLE_LEVER,
  HANDLE_PULL,
  LEAF_PANEL,
  LITE_NARROW,
  LITE_NONE,
  LITE_SQUARE,
  METAL_BLACK,
  METAL_SATIN,
  PLATE_NUMBER,
  PLATE_SIGN,
} from './doorKit.js'

// Door joinery: the casing around a doorway and the swung-open leaf pair.
//
// Design language (anime background-art): a few bold flat shapes with crisp
// stepped silhouettes — casing, back-band, plinth, cap, corner blocks — so
// the ink outline and cel ramp read them as drawn line-art rather than
// photographed mouldings. Every element stands a different depth proud of
// the wall, so each layer catches its own cel step and outline.
//
// Hard contract: nothing may intrude into the passage opening. Collision and
// LOS read the edge bytes; these boxes are purely visual, so the leaf
// assembly stays flat against the NEIGHBOUR wall cell and every frame box
// overlaps solid wall or the header zone.

// All sizes come from the constants.js door SIZE CONTRACT: DOOR_H clear
// opening, DOOR_LEAF_W leaves (half the DOOR_OPENING_W span between jambs).
const JAMB_OFF = CELL / 2 - FRAME_W / 2 // jamb centre offset from the gap centre
const LEAF_W = DOOR_LEAF_W // each leaf of the pair: half the framed opening

// Door casing around a single-cell doorway: the structural jamb + header
// casing dressed as a real architrave — a wider, shallower back-band behind
// each jamb, proud corner blocks at the head corners, plinth blocks at the
// feet and a cap ledge at the head. `plane` is the wall plane coordinate
// (line*CELL), `centre` the gap centre along it.
export function pushDoorFrame(out, axis, line, cell) {
  const vertical = axis === 'v'
  const plane = line * CELL
  const centre = (cell + 0.5) * CELL

  // Jambs + header (the structural casing; overlaps the solid wall either side).
  box(out, vertical, centre - JAMB_OFF, DOOR_H / 2, plane, FRAME_W, DOOR_H, FRAME_DEPTH)
  box(out, vertical, centre + JAMB_OFF, DOOR_H / 2, plane, FRAME_W, DOOR_H, FRAME_DEPTH)
  box(out, vertical, centre, DOOR_H + HEADER_H / 2, plane, CELL, HEADER_H, FRAME_DEPTH)
  // Back-bands: wider and shallower than the jambs they flank, so the casing
  // reads as a stepped architrave instead of three bare boards.
  box(out, vertical, centre - JAMB_OFF, DOOR_H / 2, plane, FRAME_BAND_W, DOOR_H, FRAME_BAND_DEPTH)
  box(out, vertical, centre + JAMB_OFF, DOOR_H / 2, plane, FRAME_BAND_W, DOOR_H, FRAME_BAND_DEPTH)
  // Corner blocks: square bosses in the HEADER zone where jamb meets lintel —
  // the proudest element, carrying the "designed" read. Rosettes sit above
  // the opening line, so they never narrow the clear span nor clip the open
  // leaf slab (which reaches exactly DOOR_H at the flanking wall).
  box(out, vertical, centre - JAMB_OFF, DOOR_H + FRAME_CORNER / 2, plane, FRAME_CORNER, FRAME_CORNER, FRAME_CORNER_DEPTH)
  box(out, vertical, centre + JAMB_OFF, DOOR_H + FRAME_CORNER / 2, plane, FRAME_CORNER, FRAME_CORNER, FRAME_CORNER_DEPTH)
  // Plinth blocks: slightly wider and prouder than the jambs they carry.
  box(out, vertical, centre - JAMB_OFF, DOOR_PLINTH_H / 2, plane, DOOR_PLINTH_W, DOOR_PLINTH_H, FRAME_DEPTH + 0.02)
  box(out, vertical, centre + JAMB_OFF, DOOR_PLINTH_H / 2, plane, DOOR_PLINTH_W, DOOR_PLINTH_H, FRAME_DEPTH + 0.02)
  // Head cap: a thin ledge running the full casing width at the top of the
  // opening, standing a touch prouder than the lintel face.
  box(out, vertical, centre, DOOR_H + DOOR_CAP_H / 2, plane, CELL, DOOR_CAP_H, FRAME_DEPTH + 0.03)
  return out
}

// The door itself, swung open flat against the neighbour wall. door.leaves
// lists one entry per panel (world/doors.js): a full pair puts one leaf on
// EACH face of the wall — hinged at opposite jambs, mirrored through the
// opening — so the doorway reads as a door from both rooms. Each leaf hugs
// its hinge jamb (a small gap clears the plinth toe) and is dressed per
// door.style:
//   two-panel   (default): raised upper + lower moldings;
//   three-panel : adds a mid rail molding between them;
//   louvered    : slatted upper half over the lower panel — utility closet.
// Every leaf also gets a metal kick plate at the foot and a knob plate at the
// leading edge. (The wall-side face is coplanar with the wall and can never
// be seen, so it gets no molding.) Every part is role-tagged so mesh.js can
// tint the paint and the metal independently per door.
export function pushDoorLeaves(out, door, sinks = null) {
  if (door.kit) {
    for (const leaf of door.leaves) pushKitLeaf(out, door, leaf, sinks)
    return out
  }
  const vertical = door.axis === 'v'
  const plane = door.line * CELL
  const style = door.style ?? 0
  for (const { hinge, face } of door.leaves) {
    const jambEdge = (door.cell + (hinge + 1) / 2) * CELL // cell boundary at the hinge jamb
    const zl = jambEdge + hinge * (DOOR_LEAF_GAP + LEAF_W / 2) // leaf centre, inside the neighbour cell
    const across = plane + face * (THICK / 2 + DOOR_LEAF_THICK / 2) // just off the wall face

    // The slab itself.
    box(out, vertical, zl, DOOR_H / 2, across, LEAF_W, DOOR_H, DOOR_LEAF_THICK, 0)

    // Raised panels / louvers, proud of the room-side leaf face.
    const panelW = LEAF_W - 2 * DOOR_PANEL_MARGIN
    const faceOff = across + face * (DOOR_LEAF_THICK / 2 + DOOR_PANEL_PROUD / 2)
    if (style >= 0.85) {
      // Louvered upper half: stepped slats over the lower panel.
      const pitch = DOOR_LOUVER_COUNT > 1 ? (DOOR_LOUVER_HI - DOOR_LOUVER_LO) / (DOOR_LOUVER_COUNT - 1) : 0
      for (let i = 0; i < DOOR_LOUVER_COUNT; i++) {
        box(out, vertical, zl, DOOR_LOUVER_LO + i * pitch, faceOff, panelW, DOOR_LOUVER_H, DOOR_PANEL_PROUD, 0)
      }
      box(out, vertical, zl, DOOR_PANEL_BOT_Y, faceOff, panelW, DOOR_PANEL_BOT_H, DOOR_PANEL_PROUD, 0)
    } else {
      box(out, vertical, zl, DOOR_PANEL_TOP_Y, faceOff, panelW, DOOR_PANEL_TOP_H, DOOR_PANEL_PROUD, 0)
      if (style >= 0.5) {
        box(out, vertical, zl, DOOR_PANEL_MID_Y, faceOff, panelW, DOOR_PANEL_MID_H, DOOR_PANEL_PROUD, 0)
      }
      box(out, vertical, zl, DOOR_PANEL_BOT_Y, faceOff, panelW, DOOR_PANEL_BOT_H, DOOR_PANEL_PROUD, 0)
    }

    // Kick plate at the foot, then the knob plate near the leading edge (the
    // edge AWAY from the hinge/doorway). The knob is offset outward so its
    // inner face stays flush with the wall face — deeper than the leaf but
    // never buried in the wall slab.
    box(out, vertical, zl, DOOR_KICK_Y, faceOff, panelW, DOOR_KICK_H, DOOR_PANEL_PROUD, 1)
    const leading = jambEdge + hinge * (DOOR_LEAF_GAP + LEAF_W - DOOR_KNOB_W)
    const knobAcross = across + face * 0.02
    box(out, vertical, leading, DOOR_KNOB_Y, knobAcross, DOOR_KNOB_W, DOOR_KNOB_H, DOOR_LEAF_THICK + 0.04, 1)
  }
  return out
}

// --- Kit-dressed leaves (doorKit.js) --------------------------------------
// The same swung-flat slab, dressed as the family's door type. Parts carry
// role 0 (the leaf finish: part.wood marks veneer, with part.tint its colour),
// 2 (metal hardware, part.tint its F0) or 3 (a dark recess behind a grille).
// A vision lite splits the slab around its opening and hands the pane to
// sinks.glass in the window-pane descriptor format; what the pane shows is
// the wall the open leaf lies against, which is exactly what you would see.
// Everything stays inside the leaf's span along the wall and on the room
// side of the wall face, like the panelled builder above.
const HINGE_W = 0.028
const HINGE_H = 0.11
const LEVER_Y = DOOR_KNOB_Y
const LITES = {
  [LITE_NARROW]: { w: 0.13, h: 0.8, y: 1.48, u: (W) => W / 2 - 0.27 },
  [LITE_SQUARE]: { w: 0.32, h: 0.32, y: 1.56, u: (W) => W / 4 - 0.04 },
}
// Seven-segment numerals for the hotel number plates: segment boxes
// (u0, u1, y0, y1) in a 22 x 40 mm cell, stroke 4 mm, on a 170 mm brass
// plate. Five glyphs (a basement's b1 + three digits, or storey 10 and up)
// fill it at the full 34 mm pitch with 6 mm to spare each side; a longer
// number closes the pitch up rather than run off the brass.
const SEG = 0.004
const DIGIT_W = 0.022
const DIGIT_H = 0.04
const DIGIT_PITCH = 0.034
const NUMBER_PLATE_W = 0.17
const NUMBER_MARGIN = 0.006
const SEGMENTS = {
  a: [-DIGIT_W / 2, DIGIT_W / 2, DIGIT_H - SEG, DIGIT_H],
  b: [DIGIT_W / 2 - SEG, DIGIT_W / 2, DIGIT_H / 2, DIGIT_H - SEG],
  c: [DIGIT_W / 2 - SEG, DIGIT_W / 2, SEG, DIGIT_H / 2],
  d: [-DIGIT_W / 2, DIGIT_W / 2, 0, SEG],
  e: [-DIGIT_W / 2, -DIGIT_W / 2 + SEG, SEG, DIGIT_H / 2],
  f: [-DIGIT_W / 2, -DIGIT_W / 2 + SEG, DIGIT_H / 2, DIGIT_H - SEG],
  g: [-DIGIT_W / 2 + SEG, DIGIT_W / 2 - SEG, DIGIT_H / 2 - SEG / 2, DIGIT_H / 2 + SEG / 2],
}
// Digits, and the 'b' that prefixes a basement storey (b1, b2... as the
// LEVEL plates read them).
const GLYPHS = Object.freeze({
  0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg',
  b: 'cdefg',
})
// Strokes of one glyph: a digit (number or character) or 'b'.
export function digitStrokes(glyph) {
  return [...(GLYPHS[glyph] ?? '')].map((c) => SEGMENTS[c])
}

const BEAD_W = 0.026
const BEAD_PROUD = 0.012
const SKIN = 0.012

function pushKitLeaf(out, door, { hinge, face }, sinks) {
  const k = door.kit
  const vertical = door.axis === 'v'
  const plane = door.line * CELL
  const W = LEAF_W
  const H = DOOR_H
  const jambEdge = (door.cell + (hinge + 1) / 2) * CELL
  const zl = jambEdge + hinge * (DOOR_LEAF_GAP + W / 2)
  const across = plane + face * (THICK / 2 + DOOR_LEAF_THICK / 2)
  const front = across + face * (DOOR_LEAF_THICK / 2) // the room-side leaf face
  const tone = door.tone ?? 0.5
  // Veneer takes the same shade as painted leaves (mesh.js leafTint): the
  // department's paint batch, or the dark stain of a "wrong door".
  const shade = leafShade(tone)
  const woodTint = k.finish === 'wood' && k.wood ? k.wood.map((c) => c * shade) : null

  // u runs along the leaf from its centre, + toward the leading edge.
  const at = (u) => zl + hinge * u
  // Finish part spanning u0..u1, y0..y1, `from`..`to` off the front face
  // (negative reaches back into the slab).
  const finish = (u0, u1, y0, y1, from, to) => {
    box(out, vertical, at((u0 + u1) / 2), (y0 + y1) / 2, front + face * ((from + to) / 2), u1 - u0, y1 - y0, to - from, 0)
    const part = out[out.length - 1]
    if (woodTint) {
      part.wood = true
      part.tint = woodTint
    }
  }
  const metal = (u0, u1, y0, y1, from, to, tint = k.metal) => {
    box(out, vertical, at((u0 + u1) / 2), (y0 + y1) / 2, front + face * ((from + to) / 2), u1 - u0, y1 - y0, to - from, 2)
    out[out.length - 1].tint = tint
  }
  const recess = (u0, u1, y0, y1, from, to) => {
    box(out, vertical, at((u0 + u1) / 2), (y0 + y1) / 2, front + face * ((from + to) / 2), u1 - u0, y1 - y0, to - from, 3)
  }

  // Slab, split around the vision lite as a thin face skin over the core:
  // the bevel radius follows a box's smallest dimension, so the skin's
  // joints close to hairlines instead of the core's 2 cm V-grooves.
  const lite = k.lite !== LITE_NONE ? LITES[k.lite] : null
  const slab = (u0, u1, y0, y1) => {
    finish(u0, u1, y0, y1, -DOOR_LEAF_THICK, -SKIN)
    finish(u0, u1, y0, y1, -SKIN, 0)
  }
  if (lite) {
    const lu = lite.u(W)
    const u0 = lu - lite.w / 2
    const u1 = lu + lite.w / 2
    const y0 = lite.y - lite.h / 2
    const y1 = lite.y + lite.h / 2
    // Full-height stiles either side, rails above and below the opening:
    // every joint runs with the grain, where a veneered or welded leaf has
    // its seams anyway.
    slab(-W / 2, u0, 0, H)
    slab(u1, W / 2, 0, H)
    slab(u0, u1, 0, y0)
    slab(u0, u1, y1, H)
    // Glazing bead round the opening, proud of the face.
    finish(u0 - BEAD_W, u1 + BEAD_W, y1, y1 + BEAD_W, 0, BEAD_PROUD)
    finish(u0 - BEAD_W, u1 + BEAD_W, y0 - BEAD_W, y0, 0, BEAD_PROUD)
    finish(u0 - BEAD_W, u0, y0, y1, 0, BEAD_PROUD)
    finish(u1, u1 + BEAD_W, y0, y1, 0, BEAD_PROUD)
    if (sinks?.glass) {
      // The pane's condition follows the wear of the room it serves
      // (doorSchedule.js liteGlass); the grime pattern seed is per leaf.
      const { kind, dirt } = liteGlass(door, k.wired)
      const seed = ((door.variant ?? 0.5) * 13.7 + (hinge + 1) * 0.31 + (face + 1) * 0.17) % 1
      const t = 0.008
      box(sinks.glass, vertical, at(lu), lite.y, across, lite.w, lite.h, t)
      Object.assign(sinks.glass[sinks.glass.length - 1], { kind, seed, dirt })
    }
  } else {
    finish(-W / 2, W / 2, 0, H, -DOOR_LEAF_THICK, 0)
  }

  // Raised panels (or louvers) on the panelled leaf types.
  if (k.leaf === LEAF_PANEL) {
    const m = DOOR_PANEL_MARGIN
    const panel = (y, h) => finish(-W / 2 + m, W / 2 - m, y - h / 2, y + h / 2, 0, DOOR_PANEL_PROUD)
    if (k.louvered) {
      const pitch = (DOOR_LOUVER_HI - DOOR_LOUVER_LO) / (DOOR_LOUVER_COUNT - 1)
      for (let i = 0; i < DOOR_LOUVER_COUNT; i++) panel(DOOR_LOUVER_LO + i * pitch, DOOR_LOUVER_H)
    } else {
      panel(DOOR_PANEL_TOP_Y, DOOR_PANEL_TOP_H)
      if ((door.style ?? 0) >= 0.5) panel(DOOR_PANEL_MID_Y, DOOR_PANEL_MID_H)
    }
    panel(DOOR_PANEL_BOT_Y, DOOR_PANEL_BOT_H)
  }

  // Low transfer grille: a dark throat behind proud slats.
  if (k.grille) {
    const gy0 = 0.26
    const gy1 = 0.62
    recess(-0.3, 0.3, gy0, gy1, 0, 0.002)
    for (let i = 0; i < 6; i++) {
      const y = gy0 + 0.03 + i * ((gy1 - gy0 - 0.06) / 5)
      finish(-0.3, 0.3, y - 0.014, y + 0.014, 0.002, 0.014)
    }
    finish(-0.32, 0.32, gy1, gy1 + 0.02, 0, 0.016)
    finish(-0.32, 0.32, gy0 - 0.02, gy0, 0, 0.016)
  }

  // Butt hinges on the hinge edge, from the wall face to just proud.
  for (const y of [0.28, H / 2 + 0.12, H - 0.28]) {
    metal(-W / 2, -W / 2 + HINGE_W, y - HINGE_H / 2, y + HINGE_H / 2, -DOOR_LEAF_THICK, 0.008)
  }

  if (k.kick) metal(-W / 2 + 0.04, W / 2 - 0.04, 0.02, 0.22, 0, 0.003)

  // Handle at the leading edge.
  const hu = W / 2 - 0.075
  if (k.handle === HANDLE_LEVER) {
    metal(hu - 0.028, hu + 0.028, LEVER_Y - 0.028, LEVER_Y + 0.028, 0, 0.01)
    metal(hu - 0.011, hu + 0.011, LEVER_Y - 0.011, LEVER_Y + 0.011, 0.01, 0.05)
    metal(hu - 0.135, hu + 0.012, LEVER_Y - 0.011, LEVER_Y + 0.011, 0.045, 0.068)
    // Key cylinder under the lever.
    metal(hu - 0.012, hu + 0.012, LEVER_Y - 0.13, LEVER_Y - 0.09, 0, 0.008)
  } else if (k.handle === HANDLE_KNOB) {
    metal(hu - 0.032, hu + 0.032, LEVER_Y - 0.032, LEVER_Y + 0.032, 0, 0.008)
    metal(hu - 0.012, hu + 0.012, LEVER_Y - 0.012, LEVER_Y + 0.012, 0.008, 0.03)
    metal(hu - 0.029, hu + 0.029, LEVER_Y - 0.029, LEVER_Y + 0.029, 0.03, 0.075)
  } else if (k.handle === HANDLE_PULL) {
    const pu = W / 2 - 0.1
    metal(pu - 0.013, pu + 0.013, LEVER_Y - 0.17, LEVER_Y + 0.17, 0.035, 0.06)
    for (const dy of [-0.13, 0.13]) metal(pu - 0.01, pu + 0.01, LEVER_Y + dy - 0.01, LEVER_Y + dy + 0.01, 0, 0.035)
  } else if (k.handle === HANDLE_BAR) {
    const by = 0.98
    metal(W / 2 - 0.2, W / 2 - 0.04, by - 0.06, by + 0.06, 0, 0.085)
    metal(-W / 2 + 0.08, -W / 2 + 0.17, by - 0.045, by + 0.045, 0, 0.075)
    metal(-W / 2 + 0.17, W / 2 - 0.2, by - 0.02, by + 0.02, 0.035, 0.07)
  }

  // Overhead closer on the top rail, its folded arm reaching for the head.
  if (k.closer) {
    const body = [0.45, 0.45, 0.44]
    metal(-W / 2 + 0.1, -W / 2 + 0.42, H - 0.135, H - 0.065, 0, 0.055, body)
    metal(-W / 2 + 0.3, -W / 2 + 0.72, H - 0.045, H - 0.025, 0.03, 0.046, body)
  }

  // Hotel brass numerals and spy-hole; office/tower name plaque. On a
  // panelled leaf they sit on the raised top panel, not buried in it.
  const p0 = k.leaf === LEAF_PANEL ? DOOR_PANEL_PROUD : 0
  if (k.plate === PLATE_NUMBER) {
    metal(-NUMBER_PLATE_W / 2, NUMBER_PLATE_W / 2, 1.585, 1.655, p0, p0 + 0.006)
    // Room number in seven-segment strokes, read left to right from the
    // corridor whichever way the leaf hangs: the schedule's number (storey,
    // wing, then the index along the corridor) and nothing else — the kit
    // only plates a numbered door. `right` is the u direction to the
    // viewer's right, facing the leaf.
    const right = hinge * face * (vertical ? -1 : 1)
    const room = door.number ?? ''
    const pitch = Math.min(DIGIT_PITCH, (NUMBER_PLATE_W - 2 * NUMBER_MARGIN - DIGIT_W) / Math.max(1, room.length - 1))
    for (let i = 0; i < room.length; i++) {
      const u = (i - (room.length - 1) / 2) * pitch * right
      for (const [su0, su1, sy0, sy1] of digitStrokes(room[i])) {
        const a = u + su0 * right
        const b = u + su1 * right
        metal(Math.min(a, b), Math.max(a, b), 1.6 + sy0, 1.6 + sy1, p0 + 0.006, p0 + 0.009, METAL_BLACK)
      }
    }
    metal(-0.014, 0.014, 1.456, 1.484, p0, p0 + 0.016)
  } else if (k.plate === PLATE_SIGN) {
    metal(-0.13, 0.13, 1.53, 1.63, p0, p0 + 0.005, METAL_BLACK)
    const len = 0.12 + 0.1 * (((door.variant ?? 0.5) * 17) % 1)
    metal(-len / 2, len / 2, 1.588, 1.606, p0 + 0.005, p0 + 0.0065, METAL_SATIN)
    metal(-0.07, 0.07, 1.556, 1.568, p0 + 0.005, p0 + 0.0065, METAL_SATIN)
  }
}
