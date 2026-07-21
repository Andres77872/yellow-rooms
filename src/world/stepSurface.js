import { familyPalette } from './familyPalette.js'
import {
  CELL_BRIDGE,
  CELL_OPEN,
  CELL_STAIR,
  SPACE_ROLE_BATHROOM,
  SPACE_ROLE_BREAK,
  SPACE_ROLE_KITCHEN,
  SPACE_ROLE_LAUNDRY,
  SPACE_ROLE_NONE,
  SPACE_ROLE_SERVER,
} from './mapTypes.js'

// Audible floor material under a cell — what a footstep on it should sound
// like. The vocabulary is exactly the four palette floor styles, so every
// family maps onto it without a translation table and a new family gets a
// sensible footstep the moment it declares its floor art.
export const SURFACE_CARPET = 'carpet'
export const SURFACE_CONCRETE = 'concrete'
export const SURFACE_TILE = 'tile'
export const SURFACE_DECK = 'deck'

// Wet/service rooms are hard-floored even in carpeted families: you hear the
// bathroom before the wallpaper changes.
const TILE_ROLES = new Set([
  SPACE_ROLE_BATHROOM,
  SPACE_ROLE_KITCHEN,
  SPACE_ROLE_LAUNDRY,
  SPACE_ROLE_BREAK,
])

// Semantic overrides beat the family base; the family base is the palette's
// floor style (familyPalette already falls back to Office for unknowns).
export function resolveStepSurface({
  family,
  cellKind = CELL_OPEN,
  spaceRole = SPACE_ROLE_NONE,
} = {}) {
  const base = familyPalette(family).floor.style
  // Stair treads are bare structure — carpet stops at the flight.
  if (cellKind === CELL_STAIR) {
    return base === SURFACE_CARPET ? SURFACE_CONCRETE : base
  }
  // Atrium bridges are narrow retained decks; they ring hollow everywhere.
  if (cellKind === CELL_BRIDGE) return SURFACE_DECK
  if (TILE_ROLES.has(spaceRole)) return SURFACE_TILE
  // Server rooms stand on raised access floor — hollow metal underfoot.
  if (spaceRole === SPACE_ROLE_SERVER) return SURFACE_DECK
  return base
}
