// Thin public entry point for chunk generation. The layered pipeline lives in
// pipeline.js (+ zones/, border.js, lamps.js, stairStamp.js); this file is the
// stable import surface used by Chunk.js and the debug tools.
//
// generateChunk is a pure function of (seed, cx, cy, cz, config) -> ChunkData
// and never touches THREE, so the whole generator runs headless under Vitest.

import { buildChunk } from './pipeline.js'
import { DEFAULT_WORLD_CONFIG } from './config.js'

export { DEFAULT_WORLD_CONFIG }

export function generateChunk(
  seed,
  cx,
  cy,
  cz,
  config = DEFAULT_WORLD_CONFIG,
  exitCell = null,
  clearings = null
) {
  return buildChunk(seed, cx, cy, cz, config, exitCell, clearings)
}
