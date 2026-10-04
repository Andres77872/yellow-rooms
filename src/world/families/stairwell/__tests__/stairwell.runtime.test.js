import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { Chunk } from '../../../Chunk.js'
import { createGeometries } from '../../../../render/geometries.js'
import { createExitPlacement } from '../../../../core/exitPlacement.js'
import { isSolidMassChunk } from '../../../tiles/solidChunk.js'
import { forcedFamilyConfig } from '../../forced.js'
import { familySpawn } from '../../hooks.js'
import { DISTRICT, districtLayout, exitStorey, footprint } from '../geometry.js'

// The stairwell in the runtime (spec §12.1 "playable"): the real pipeline's
// chunks build into render chunks (meshes, stair cells, lamps, plates), solid
// chunks take the mass fast path, and the engine's exit placement lands on
// shaft B's landing at storey G.

const geom = createGeometries()
const material = new THREE.MeshBasicMaterial()
const materials = new Proxy({}, { get: () => material })
const config = forcedFamilyConfig('stairwell')

const instancesOf = (group) => {
  let n = 0
  group.traverse((o) => { if (o.isInstancedMesh) n += o.count })
  return n
}

describe('stairwell runtime', () => {
  it('district (0,0) around the spawn builds: shaft chunks mesh with stair cells and a plate, solid chunks are fast-path mass', () => {
    const seed = 0x5eed
    const L = districtLayout(seed, 0, 0)
    for (let cy = -3; cy <= 1; cy++) {
      for (let cz = 0; cz < DISTRICT; cz++) {
        for (let cx = 0; cx < DISTRICT; cx++) {
          const c = new Chunk(cx, cy, cz, seed, materials, geom, null, config, null)
          expect(c.data.mapFamily).toBe('stairwell')
          if (footprint(seed, cx, cy, cz) === 'solid') {
            expect(isSolidMassChunk(c.data), `${cx},${cy},${cz}`).toBe(true)
            expect(instancesOf(c.group)).toBe(0)
          } else {
            // A kept chunk a share or a rung reaches but the storey left
            // all mass (about 1 in 100) takes the mass fast path too.
            if (isSolidMassChunk(c.data)) expect(instancesOf(c.group), `${cx},${cy},${cz}`).toBe(0)
            else expect(instancesOf(c.group), `${cx},${cy},${cz}`).toBeGreaterThan(0)
            if (L.shafts.some((S) => S.ix === cx && S.iz === cz)) {
              expect(instancesOf(c.group), `${cx},${cy},${cz}`).toBeGreaterThan(0)
              expect(c.stairCells.size, `stair cells ${cx},${cy},${cz}`).toBeGreaterThan(0)
              expect(typeof c.data.levelLabel).toBe('string')
              expect(c.lamps.length + c.data.lamps.length).toBeGreaterThan(0)
            }
          }
          c.dispose()
        }
      }
    }
  }, 60_000)

  it('the engine exit placement takes the hook: shaft B, storey G; the spawn is on storey 0 inside shaft A', () => {
    for (const seedText of ['stairs', 'down']) {
      const worldSeed = 0x1234 + seedText.length
      const ex = createExitPlacement(seedText, 1, worldSeed, config)
      const L = districtLayout(worldSeed, 0, 0)
      expect([ex.cx, ex.cy, ex.cz]).toEqual([L.B.ix, exitStorey(worldSeed), L.B.iz])
      expect(Number.isFinite(ex.x) && Number.isFinite(ex.y) && Number.isFinite(ex.z)).toBe(true)
      const sp = familySpawn(config, worldSeed)
      expect([sp.cx, sp.cz]).toEqual([L.A.ix, L.A.iz])
    }
  })
})
