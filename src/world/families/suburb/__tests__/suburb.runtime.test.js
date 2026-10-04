import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { Chunk } from '../../../Chunk.js'
import { createGeometries } from '../../../../render/geometries.js'
import { createExitPlacement } from '../../../../core/exitPlacement.js'
import { isSolidMassChunk } from '../../../tiles/solidChunk.js'
import { forcedFamilyConfig } from '../../forced.js'
import { familySpawn } from '../../hooks.js'
import { SPAWN_CELLS, TILE, bandKey, exitAnchor, footprint, forcedHouses } from '../geometry.js'

// The suburb in the runtime (spec §12.6 "playable"): the real pipeline's
// chunks build into render chunks (meshes, the attic stair's cells, lamps,
// plates), the attic storey's solid chunks take the mass fast path, and the
// engine's exit placement takes the hook: the anchor house's attic, storey 1.

const geom = createGeometries()
const material = new THREE.MeshBasicMaterial()
const materials = new Proxy({}, { get: () => material })
const config = forcedFamilyConfig('suburb')

const instancesOf = (group) => {
  let n = 0
  group.traverse((o) => { if (o.isInstancedMesh) n += o.count })
  return n
}

describe('suburb runtime', () => {
  it('tile (0,0) builds: street-level chunks mesh with plates, attic chunks carry the stair, the rest of storey 1 is fast-path mass', () => {
    const seed = 0x5eed
    const ups = new Set(forcedHouses(seed, bandKey(0, 0)).map((h) => `${h.up.lcx},${h.up.lcz}`))
    for (let cy = 0; cy <= 1; cy++) {
      for (let cz = 0; cz < TILE.d; cz++) {
        for (let cx = 0; cx < TILE.w; cx++) {
          const c = new Chunk(cx, cy, cz, seed, materials, geom, null, config, null)
          expect(c.data.mapFamily).toBe('suburb')
          if (footprint(seed, cx, cy, cz) === 'solid') {
            expect(isSolidMassChunk(c.data), `${cx},${cy},${cz}`).toBe(true)
            expect(instancesOf(c.group)).toBe(0)
          } else {
            expect(instancesOf(c.group), `${cx},${cy},${cz}`).toBeGreaterThan(0)
            expect(typeof c.data.levelLabel).toBe('string')
            if (ups.has(`${cx},${cz}`)) {
              expect(c.stairCells.size, `stair cells ${cx},${cy},${cz}`).toBeGreaterThan(0)
              expect(c.data.lamps.length).toBeGreaterThan(0)
            }
          }
          c.dispose()
        }
      }
    }
  }, 60_000)

  it('the engine exit placement takes the hook: the anchor attic on storey 1; the spawn is on S1 of tile (0,0)', () => {
    for (const seedText of ['night', 'loop']) {
      const worldSeed = 0x2468 + seedText.length
      const ex = createExitPlacement(seedText, 1, worldSeed, config)
      const a = exitAnchor(worldSeed)
      expect([ex.cx, ex.cy, ex.cz, ex.lx, ex.lz]).toEqual([a.cx, 1, a.cz, a.lx, a.lz])
      expect(Number.isFinite(ex.x) && Number.isFinite(ex.y) && Number.isFinite(ex.z)).toBe(true)
      const sp = familySpawn(config, worldSeed)
      expect([sp.cx, sp.cz, sp.lx, sp.lz]).toEqual([1, 0, SPAWN_CELLS[0].gx - 14, SPAWN_CELLS[0].gz])
    }
  })
})
