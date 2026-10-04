import { finiteCtx } from '../../tiles/kit.js'
import { STATIONS } from './geometry.js'

// 07 — The Endless Train: the family's tile program entry (spec §3.3, §10,
// §12.10 Option A). The program itself is two modules:
//   - world.js: the world tile (tile mode), a grammar that composes every
//     4×1-chunk tile around its pure skeleton (geometry.js): car sequences
//     on a snaking path, station layouts, lineside walkways and rooms, the
//     upper works (sealed storey-1 pockets over the stairs);
//   - kind.js: the kind lab's static grey-box (finite mode), the family's
//     parts catalogue; src/editor/kinds/train.js wraps it with
//     FINITE_CTX_TRAIN (the kind's map, byte-identical).
// The tints are stated here, once (the registry's lampTint is TRAIN_TINT).

export const TRAIN_TINT = 0xe4fff0 // fluorescent green-white
export const KIOSK_TINT = 0xffe2b8
export const EMERGENCY_TINT = 0xff9a7a // tunnel walkway emergency lamps
export { STATIONS }

// The kind lab's finite ctx (the editor kind's map, byte-identical).
export const FINITE_CTX_TRAIN = finiteCtx({})
