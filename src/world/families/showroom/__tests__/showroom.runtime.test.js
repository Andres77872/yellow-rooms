import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { Chunk } from '../../../Chunk.js'
import { CHUNK } from '../../../constants.js'
import { createGeometries } from '../../../../render/geometries.js'
import { createExitPlacement } from '../../../../core/exitPlacement.js'
import { isSolidMassChunk } from '../../../tiles/solidChunk.js'
import { forcedFamilyConfig } from '../../forced.js'
import { familySpawn } from '../../hooks.js'
import { exitTileOf, footprint, isStairChunk, spawnCellsOf } from '../geometry.js'
import { hallExitOf } from '../layout.js'

// The showroom in the runtime (spec §12.3 "playable"): the real pipeline's
// chunks build into render chunks (meshes, furniture and prop instances,
// stair cells, lamps, plates), the storeys above and below take the mass
// fast path, and the engine's exit placement lands on the hall's fire exit
// of the exit tile.

const geom = createGeometries()
const material = new THREE.MeshBasicMaterial()
const materials = new Proxy({}, { get: () => material })
const config = forcedFamilyConfig('showroom')

const instancesOf = (group) => {
  let n = 0
  group.traverse((o) => { if (o.isInstancedMesh) n += o.count })
  return n
}

describe('showroom runtime', () => {
  it('tiles (0,0) and (1,0) build: both storeys mesh, the plan\'s stair chunks carry stair cells, every chunk a plate, the storeys beyond are fast-path mass', () => {
    const seed = 0x5eed
    for (let cy = -2; cy <= 1; cy++) {
      for (let cz = 0; cz < 2; cz++) {
        for (let cx = 0; cx < 4; cx++) {
          const c = new Chunk(cx, cy, cz, seed, materials, geom, null, config, null)
          expect(c.data.mapFamily).toBe('showroom')
          if (footprint(seed, cx, cy, cz) === 'solid') {
            expect(isSolidMassChunk(c.data), `${cx},${cy},${cz}`).toBe(true)
            expect(instancesOf(c.group)).toBe(0)
          } else {
            expect(instancesOf(c.group), `${cx},${cy},${cz}`).toBeGreaterThan(0)
            expect(typeof c.data.levelLabel, `plate ${cx},${cy},${cz}`).toBe('string')
            expect(c.data.furniture.length, `furniture ${cx},${cy},${cz}`).toBeGreaterThan(0)
            if (isStairChunk(seed, cx, cz)) expect(c.stairCells.size, `stair cells ${cx},${cy},${cz}`).toBeGreaterThan(0)
          }
          c.dispose()
        }
      }
    }
  }, 60_000)

  it('the engine exit placement takes the hook: the fire exit on cy −1 of tile (2 + hash % 3, 0); the spawn is tile (0,0)\'s route entrance', () => {
    for (const seedText of ['ikea', 'closing', 'aisle']) {
      const worldSeed = 0x3008 + seedText.length
      const ex = createExitPlacement(seedText, 1, worldSeed, config)
      const t = exitTileOf(worldSeed)
      const fire = hallExitOf(worldSeed, t.tx, t.tz)
      expect([ex.cx * CHUNK + ex.lx, ex.cy, ex.cz * CHUNK + ex.lz]).toEqual([t.tx * 2 * CHUNK + fire.gx, -1, fire.gz])
      expect(Number.isFinite(ex.x) && Number.isFinite(ex.y) && Number.isFinite(ex.z)).toBe(true)
      const sp = familySpawn(config, worldSeed)
      const entrance = spawnCellsOf(worldSeed)[0]
      expect([sp.cx * CHUNK + sp.lx, sp.cz * CHUNK + sp.lz]).toEqual([entrance.gx, entrance.gz])
    }
  })
})
