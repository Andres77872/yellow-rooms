// Furniture palette — per-part tints applied over a white base material
// (see gbufferMaterials.js). Design language: the same bold flat shapes as
// the joinery — readable silhouettes first (desktop line, chair back,
// cabinet doors, copier lid, bottle neck, leaf cross), panel gaps and
// handles as thin proud slabs that catch the ink outline.
export const FURN_TINT = {
  laminate: [0.74, 0.68, 0.58], // desk/table tops
  legMetal: [0.32, 0.31, 0.3],
  panel: [0.62, 0.58, 0.5], // modesty panels, drawer cases
  drawerFace: [0.7, 0.64, 0.54],
  screen: [0.1, 0.11, 0.13],
  keyDark: [0.16, 0.16, 0.17],
  fabric: [0.3, 0.34, 0.42], // chair upholstery
  cabinetPaint: [0.66, 0.67, 0.63],
  copierBody: [0.78, 0.79, 0.75],
  slotDark: [0.14, 0.14, 0.15],
  coolerWhite: [0.88, 0.9, 0.88],
  bottleBlue: [0.55, 0.75, 0.9],
  potClay: [0.52, 0.34, 0.24],
  soil: [0.2, 0.15, 0.1],
  leafGreen: [0.28, 0.48, 0.28],
  rackDark: [0.16, 0.17, 0.19], // server rack body
  rackFace: [0.22, 0.23, 0.26], // rack front panel
  ledGreen: [0.4, 1.0, 0.55], // status LEDs
  paperWhite: [0.9, 0.88, 0.8], // paper stacks, flat files
  sofa: [0.4, 0.32, 0.26], // lobby couch body
  sofaCushion: [0.47, 0.38, 0.31], // loose cushions
  shelfWood: [0.5, 0.4, 0.28], // bookshelf carcass
  bookRed: [0.55, 0.2, 0.16],
  bookBlue: [0.2, 0.3, 0.5],
  bookTan: [0.62, 0.52, 0.36],
  boardWhite: [0.92, 0.93, 0.94], // whiteboard enamel
}
