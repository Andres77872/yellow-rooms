import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { Chunk } from '../../../Chunk.js'
import { createGeometries } from '../../../../render/geometries.js'
import { createExitPlacement } from '../../../../core/exitPlacement.js'
import { isSolidMassChunk } from '../../../tiles/solidChunk.js'
import { forcedFamilyConfig } from '../../forced.js'
import { familySpawn } from '../../hooks.js'
import { SPAWN_CELLS, exitAnchor, exitTileOf, footprint, stairChunkAt } from '../geometry.js'

// The funhouse in the runtime (spec §12.12 "playable"): the real pipeline's
// chunks of the spawn pavilion and its neighbours build into render chunks
// (meshes, stair cells, lamps, plates), the rows off the chain and the
// storeys above and below take the mass fast path, and the engine's exit
// placement lands on the exit pavilion's unload walkway on storey 1.

const geom = createGeometries()
const material = new THREE.MeshBasicMaterial()
const materials = new Proxy({}, { get: () => material })
const config = forcedFamilyConfig('funhouse')

const instancesOf = (group) => {
  let n = 0
  group.traverse((o) => { if (o.isInstancedMesh) n += o.count })
  return n
}

describe('funhouse runtime', () => {
  it('pavilions −1..1 build: every pavilion chunk meshes, stair chunks (from the skeleton) carry stair cells and plates, the rest is fast-path mass', () => {
    const seed = 0x5eed
    for (let cy = -1; cy <= 2; cy++) {
      for (let cz = -1; cz <= 2; cz++) {
        for (let cx = -3; cx <= 5; cx++) {
          const c = new Chunk(cx, cy, cz, seed, materials, geom, null, config, null)
          expect(c.data.mapFamily).toBe('funhouse')
          if (footprint(seed, cx, cy, cz) === 'solid') {
            expect(isSolidMassChunk(c.data), `${cx},${cy},${cz}`).toBe(true)
            expect(instancesOf(c.group)).toBe(0)
          } else {
            expect(instancesOf(c.group), `${cx},${cy},${cz}`).toBeGreaterThan(0)
            expect(c.data.levelLabel).toBe(cy === 0 ? 'FUn' : 'nUF')
            if (stairChunkAt(seed, cx, cz, 0)) expect(c.stairCells.size, `stair cells ${cx},${cy},${cz}`).toBeGreaterThan(0)
          }
          c.dispose()
        }
      }
    }
  }, 60_000)

  it('the engine exit placement takes the hook: the unload walkway of pavilion 2..4 on storey 1; the spawn is pavilion 0\'s midway', () => {
    for (const seedText of ['fun', 'house', 'mirror']) {
      const worldSeed = 0x2468 + seedText.length * 7
      const ex = createExitPlacement(seedText, 1, worldSeed, config)
      const a = exitAnchor(worldSeed)
      expect([ex.cx, ex.cy, ex.cz]).toEqual([a.cx, 1, a.cz])
      expect(Math.floor(ex.cx / 3)).toBe(exitTileOf(worldSeed))
      expect(Number.isFinite(ex.x) && Number.isFinite(ex.y) && Number.isFinite(ex.z)).toBe(true)
      const sp = familySpawn(config, worldSeed)
      expect([sp.cx, sp.cz, sp.lx, sp.lz]).toEqual([0, 0, SPAWN_CELLS[0].gx, SPAWN_CELLS[0].gz])
    }
  })
})
