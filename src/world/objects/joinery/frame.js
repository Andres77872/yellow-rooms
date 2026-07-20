// Shared emit helper for the joinery builders: one axis-aligned box,
// mirrored across x/z by `vertical` (wall runs along z for a vertical grid
// line, along x for a horizontal one).
//
// Descriptor shape: { px, py, pz, sx, sy, sz, role } in CHUNK-LOCAL world
// units (the chunk group carries the world offset). `role` tags how the
// instance is coloured by the caller: 0 = painted surface (tinted per door),
// 1 = accent (knob metal). Frames/casings carry no role — they use the
// uniform trim paint.
export function box(out, vertical, along, y, across, sAlong, sY, sAcross, role) {
  if (vertical) out.push({ px: across, py: y, pz: along, sx: sAcross, sy: sY, sz: sAlong, role })
  else out.push({ px: along, py: y, pz: across, sx: sAlong, sy: sY, sz: sAcross, role })
}
