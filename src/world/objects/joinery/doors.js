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
import { box } from './frame.js'

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
export function pushDoorLeaves(out, door) {
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
