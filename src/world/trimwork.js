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
  WINDOW_SILL_H,
  WINDOW_HEAD_Y,
  WINDOW_TRIM_W,
  WINDOW_MULLION_W,
  WINDOW_STOOL_H,
  WINDOW_STOOL_DEPTH,
  WINDOW_APRON_H,
  WINDOW_BLIND_SLATS,
  WINDOW_BLIND_SLAT_H,
  WINDOW_BLIND_DEPTH,
  WINDOW_BLIND_RAIL_H,
} from './constants.js'

// Architectural trimwork builders — pure functions turning doorway / window
// metadata into unit-box instance descriptors, so the design language lives in
// ONE place and is testable headless (mesh.js only batches what it gets back).
//
// Descriptor shape: { px, py, pz, sx, sy, sz, role } in CHUNK-LOCAL world units
// (the chunk group carries the world offset). `role` tags how the instance is
// coloured by the caller: 0 = painted surface (tinted per door), 1 = accent
// (knob metal). Frames/casings carry no role — they use the uniform trim paint.
//
// Design language (anime background-art): a few bold flat shapes with crisp
// stepped silhouettes, identical vocabulary on doors and windows — casing,
// back-band, plinth, cap, corner blocks, stool, apron — so the ink outline and
// cel ramp read them as drawn line-art rather than photographed mouldings.
// Every element stands a different depth proud of the wall, so each layer
// catches its own cel step and outline.
//
// Hard contract (unchanged from the old inline builders): nothing may intrude
// into the passage opening. Collision and LOS read the edge bytes; these boxes
// are purely visual, so the leaf assembly stays flat against the NEIGHBOUR
// wall cell and every frame box overlaps solid wall or the header zone.

const DOOR_H = WALL_H - HEADER_H // clear opening height (lintel fills above)
const JAMB_OFF = CELL / 2 - FRAME_W / 2 // jamb centre offset from the gap centre
const OPENING_W = CELL - 2 * FRAME_W // clear span between the jambs
const LEAF_W = OPENING_W / 2 // each leaf of the pair: half the framed opening

// Emit one axis-aligned box, mirrored across x/z by `vertical` (wall runs
// along z for a vertical grid line, along x for a horizontal one).
function box(out, vertical, along, y, across, sAlong, sY, sAcross, role) {
  if (vertical) out.push({ px: across, py: y, pz: along, sx: sAcross, sy: sY, sz: sAlong, role })
  else out.push({ px: along, py: y, pz: across, sx: sAlong, sy: sY, sz: sAcross, role })
}

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
  // Corner blocks: square bosses at the head corners, the proudest element —
  // they carry the "designed" read where the jamb meets the lintel.
  box(out, vertical, centre - JAMB_OFF, DOOR_H - FRAME_CORNER / 2, plane, FRAME_CORNER, FRAME_CORNER, FRAME_CORNER_DEPTH)
  box(out, vertical, centre + JAMB_OFF, DOOR_H - FRAME_CORNER / 2, plane, FRAME_CORNER, FRAME_CORNER, FRAME_CORNER_DEPTH)
  // Plinth blocks: slightly wider and prouder than the jambs they carry.
  box(out, vertical, centre - JAMB_OFF, DOOR_PLINTH_H / 2, plane, DOOR_PLINTH_W, DOOR_PLINTH_H, FRAME_DEPTH + 0.02)
  box(out, vertical, centre + JAMB_OFF, DOOR_PLINTH_H / 2, plane, DOOR_PLINTH_W, DOOR_PLINTH_H, FRAME_DEPTH + 0.02)
  // Head cap: a thin ledge running the full casing width at the top of the
  // opening, standing a touch prouder than the lintel face.
  box(out, vertical, centre, DOOR_H + DOOR_CAP_H / 2, plane, CELL, DOOR_CAP_H, FRAME_DEPTH + 0.03)
  return out
}

// The door itself, swung open flat against the neighbour wall. door.leaves
// lists one entry per panel (doors.js): a full pair puts one leaf on EACH face
// of the wall — hinged at opposite jambs, mirrored through the opening — so
// the doorway reads as a door from both rooms. Each leaf hugs its hinge jamb
// (a small gap clears the plinth toe) and is dressed per door.style:
//   two-panel   (default): raised upper + lower moldings;
//   three-panel : adds a mid rail molding between them;
//   louvered    : slatted upper half over the lower panel — utility closet.
// Every leaf also gets a metal kick plate at the foot and a knob plate at the
// leading edge. (The wall-side face is coplanar with the wall and can never be
// seen, so it gets no molding.) Every part is role-tagged so mesh.js can tint
// the paint and the metal independently per door.
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

// Gallery observation window: casing + a projecting stool ledge + an apron
// board under it, then one of three deterministic glazing treatments inside
// the aperture (selected by `tone`, a per-window hash stream from mesh.js):
//   tone < 0.45 : the classic four-pane cross;
//   tone < 0.8  : a single vertical bar (taller, quieter read);
//   else        : venetian blinds — head rail, slats, bottom rail.
// The collision-solid sill/header wall boxes are NOT emitted here (mesh.js
// adds them as wallpaper instances) — this is the joinery that makes the
// aperture read as a window and not a hole.
export function pushWindowTrim(out, axis, line, cell, tone = 0) {
  const vertical = axis === 'v'
  const plane = line * CELL
  const centre = (cell + 0.5) * CELL
  const edge0 = cell * CELL
  const edge1 = (cell + 1) * CELL
  const openingH = WINDOW_HEAD_Y - WINDOW_SILL_H
  const openingY = (WINDOW_SILL_H + WINDOW_HEAD_Y) / 2

  // Side + head casings (proud of both wall faces, like the door casing).
  box(out, vertical, edge0 + WINDOW_TRIM_W / 2, openingY, plane, WINDOW_TRIM_W, openingH, FRAME_DEPTH)
  box(out, vertical, edge1 - WINDOW_TRIM_W / 2, openingY, plane, WINDOW_TRIM_W, openingH, FRAME_DEPTH)
  box(out, vertical, centre, WINDOW_HEAD_Y, plane, CELL, WINDOW_TRIM_W, FRAME_DEPTH)
  // Stool: a ledge whose top sits flush with the sill, deeper than the casing.
  box(out, vertical, centre, WINDOW_SILL_H - WINDOW_STOOL_H / 2, plane, CELL, WINDOW_STOOL_H, WINDOW_STOOL_DEPTH)
  // Apron: the flat board under the stool that anchors it to the wall.
  box(out, vertical, centre, WINDOW_SILL_H - WINDOW_STOOL_H - WINDOW_APRON_H / 2, plane, CELL, WINDOW_APRON_H, FRAME_DEPTH)

  const glassW = CELL - 2 * WINDOW_TRIM_W
  if (tone >= 0.8) {
    // Venetian blinds inside the aperture: a head rail, evenly spaced slats
    // with a slight overlap, and a bottom rail — shallower than the casings.
    const railW = glassW
    box(out, vertical, centre, WINDOW_HEAD_Y - WINDOW_TRIM_W - WINDOW_BLIND_RAIL_H / 2, plane, railW, WINDOW_BLIND_RAIL_H, WINDOW_BLIND_DEPTH)
    box(out, vertical, centre, WINDOW_SILL_H + WINDOW_BLIND_RAIL_H / 2, plane, railW, WINDOW_BLIND_RAIL_H, WINDOW_BLIND_DEPTH)
    const lo = WINDOW_SILL_H + WINDOW_BLIND_RAIL_H + WINDOW_BLIND_SLAT_H / 2
    const hi = WINDOW_HEAD_Y - WINDOW_TRIM_W - WINDOW_BLIND_RAIL_H - WINDOW_BLIND_SLAT_H / 2
    const pitch = WINDOW_BLIND_SLATS > 1 ? (hi - lo) / (WINDOW_BLIND_SLATS - 1) : 0
    for (let i = 0; i < WINDOW_BLIND_SLATS; i++) {
      box(out, vertical, centre, lo + i * pitch, plane, glassW, WINDOW_BLIND_SLAT_H, WINDOW_BLIND_DEPTH)
    }
  } else {
    // Glazing bars: slimmer and shallower than the casings, so they sit
    // visually INSIDE the aperture. The cross adds the horizontal bar.
    box(out, vertical, centre, openingY, plane, WINDOW_MULLION_W, openingH, WINDOW_MULLION_W)
    if (tone < 0.45) {
      box(out, vertical, centre, openingY, plane, glassW, WINDOW_MULLION_W, WINDOW_MULLION_W)
    }
  }
  return out
}
