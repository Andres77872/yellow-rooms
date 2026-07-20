// Dressing palettes — albedo multipliers on the shared white prop material
// (linear-ish 0..1), and the emissive sign tints. Signs glow (and bloom) but
// cast no light: beacons, not lamps.
export const PROP_TINT = {
  threshold: [0.5, 0.42, 0.26], // worn brass
  vent: [0.3, 0.29, 0.26], // dark grille
  ventSlat: [0.17, 0.16, 0.14], // grille slats
  clock: [0.95, 0.93, 0.85], // cream face
  clockRim: [0.2, 0.2, 0.19], // dark case + hands
  board: [0.66, 0.54, 0.36], // cork
  boardFrame: [0.3, 0.24, 0.17], // wood frame
  paper: [0.93, 0.91, 0.82], // pinned notices
  extinguisher: [0.62, 0.14, 0.1], // safety red
  glassPale: [0.78, 0.86, 0.88], // cabinet glazing
  radiator: [0.82, 0.8, 0.72], // painted enamel
  pipe: [0.35, 0.34, 0.32], // plumbing metal
  caution: [0.85, 0.7, 0.15], // server-room warning plate
}
export const SIGN_TINT = {
  exit: [0.45, 1.0, 0.62], // emergency green
  blade: [1.0, 0.82, 0.45], // warm wayfinding amber
  frame: [0.2, 0.2, 0.18], // sign housings (dark even while emissive)
}
