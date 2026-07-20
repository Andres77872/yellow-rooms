import {
  CELL,
  FRAME_DEPTH,
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
} from '../../constants.js'
import { box } from './frame.js'

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
