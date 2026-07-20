import {
  SPACE_ROLE_ARCHIVE,
  SPACE_ROLE_BREAK,
  SPACE_ROLE_COPY,
  SPACE_ROLE_MEETING,
  SPACE_ROLE_SERVER,
  SPACE_ROLE_STORAGE,
} from '../../mapTypes.js'

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

// Sewer gallery hardware — greened metals and wet concrete, no office cream.
export const SEWER_TINT = {
  pipe: [0.3, 0.32, 0.3], // main cast-iron run
  pipeOld: [0.4, 0.31, 0.24], // rusted secondary run
  bracket: [0.2, 0.21, 0.2], // pipe saddles
  rib: [0.34, 0.35, 0.3], // cast vault rib
  gutter: [0.13, 0.16, 0.14], // center drain channel
  grate: [0.09, 0.1, 0.09], // drain grates
  valve: [0.55, 0.16, 0.12], // painted valve wheel
  stem: [0.28, 0.29, 0.27], // valve stem / riser pipe
  stain: [0.16, 0.2, 0.16], // seep stain plate behind hardware
  rung: [0.36, 0.37, 0.34], // ladder rungs
  hazard: [0.66, 0.55, 0.14], // painted hazard band at risers
}
export const SEWER_SIGN = {
  arrow: [1.0, 0.72, 0.3], // riser way-out marker (GS-12: signed risers)
}

// Lattice steelwork — the exposed-span language: posts, kick plates, seams.
export const LATTICE_TINT = {
  post: [0.24, 0.26, 0.3], // rail posts
  kick: [0.18, 0.2, 0.23], // kick plate at deck edges
  seam: [0.12, 0.13, 0.15], // deck seam strips (the 8-cell boundary cue)
  hazard: [0.85, 0.62, 0.1], // kick plates near the deep-exposure pier
  cap: [0.3, 0.33, 0.38], // pier cap trim
}

// Role wainscot bands: a painted wall band per semantic room role, so a
// meeting room or server room reads from its architecture before its
// furniture does (roles used to be furniture-only).
export const ROLE_BAND = {
  [SPACE_ROLE_MEETING]: [0.6, 0.66, 0.78], // slate blue
  [SPACE_ROLE_BREAK]: [0.84, 0.6, 0.4], // terracotta
  [SPACE_ROLE_COPY]: [0.62, 0.62, 0.56], // neutral grey-green
  [SPACE_ROLE_ARCHIVE]: [0.62, 0.52, 0.36], // ochre
  [SPACE_ROLE_SERVER]: [0.42, 0.62, 0.58], // machine teal
  [SPACE_ROLE_STORAGE]: [0.5, 0.47, 0.42], // putty
}

// Landmark accent cycle: one high-salience colour per pier/floor so every
// chamber and level reads as a distinct place (Vinson's landmark rule).
export const ACCENT_CYCLE = [
  [1.0, 0.5, 0.38], // signal orange
  [0.42, 0.78, 1.0], // cyan
  [1.0, 0.85, 0.4], // amber
  [0.55, 1.0, 0.62], // green
  [0.82, 0.55, 1.0], // violet
  [1.0, 0.6, 0.82], // magenta
]
