import { FINITE_CTX_TERMINAL, GATE_TINT, LOUNGE_TINT, buildTerminalTile } from '../../world/families/terminal/tile.js'

// 08 — The Terminal (docs/liminal_maps/08-terminal.md): the kind lab's
// wrapper. The kind body moved to src/world/families/terminal/tile.js (spec
// §3.3, §10), the terminal family's tile program; the finite ctx reproduces
// this kind's map byte for byte (scripts/kinds-digest.mjs --check), the
// authored bridged atrium included (the editor kit stamps it as before).
//
// GATE_TINT is 0xd4e2ff, the family record's lampTint (registry.drift reads
// this file's and tile.js's tint constants); LOUNGE_TINT is 0xffe0b8.
export { GATE_TINT, LOUNGE_TINT }

export default {
  id: 'terminal',
  label: 'airport terminal',
  family: 'tower',
  floors: 3,
  palette: 'terminalTerrazzo',
  build: (map, seed) => buildTerminalTile(map, seed, FINITE_CTX_TERMINAL),
}
