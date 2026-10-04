import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { Chunk } from '../../../Chunk.js'
import { CHUNK } from '../../../constants.js'
import { createGeometries } from '../../../../render/geometries.js'
import { createExitPlacement } from '../../../../core/exitPlacement.js'
import { forcedFamilyConfig } from '../../forced.js'
import { familySpawn } from '../../hooks.js'
import { CRIMSON, SHELF_LABEL, SPAWN_CELLS, exitAnchorGallery, exitCellsOf, flightAt, keyAt } from '../geometry.js'

// The library in the runtime (spec §12.5 "playable"): the real pipeline's
// chunks build into render chunks (meshes, shelves, stair cells, lamps, the
// '----' plates) on a band's storeys and across a band boundary, and the
// engine's exit placement lands in the Crimson Hexagon.

const geom = createGeometries()
const material = new THREE.MeshBasicMaterial()
const materials = new Proxy({}, { get: () => material })
const config = forcedFamilyConfig('babel')

const instancesOf = (group) => {
  let n = 0
  group.traverse((o) => { if (o.isInstancedMesh) n += o.count })
  return n
}

describe('babel runtime', () => {
  it('block (0,0) builds on storeys 0, 1 and across its band boundary (4 → 5): meshes, shelves, plates, stair cells', () => {
    const seed = 1
    const cy1 = keyAt(0, 0, 0).cy1
    for (const cy of [0, 1, cy1, cy1 + 1]) {
      for (let cz = 0; cz < 2; cz++) {
        for (let cx = 0; cx < 2; cx++) {
          const c = new Chunk(cx, cy, cz, seed, materials, geom, null, config, null)
          expect(c.data.mapFamily).toBe('babel')
          expect(instancesOf(c.group), `${cx},${cy},${cz}`).toBeGreaterThan(0)
          expect(c.data.levelLabel, `plate ${cx},${cy},${cz}`).toBe(SHELF_LABEL)
          expect(c.data.furniture.length, `shelves ${cx},${cy},${cz}`).toBeGreaterThan(0)
          // Every chunk-storey is one end of a flight: up where the
          // checkerboard climbs from it, down where it climbs into it.
          const stairs = !!flightAt(seed, cx, cz, cy) || !!flightAt(seed, cx, cz, cy - 1)
          expect(stairs).toBe(true)
          expect(c.stairCells.size, `stair cells ${cx},${cy},${cz}`).toBeGreaterThan(0)
          c.dispose()
        }
      }
    }
  }, 60_000)

  it('the engine exit placement takes the hook: a walkway cell of the Crimson Hexagon; the spawn is block (0,0)\'s vestibule', () => {
    for (const seedText of ['hexagon', 'shelves', 'librarian']) {
      const worldSeed = 0xbabe1 + seedText.length
      const ex = createExitPlacement(seedText, 1, worldSeed, config)
      const g = exitAnchorGallery(worldSeed)
      const cells = exitCellsOf(g).map((c) => `${c.gx},${c.cy},${c.gz}`)
      expect(cells).toContain(`${ex.cx * CHUNK + ex.lx},${ex.cy},${ex.cz * CHUNK + ex.lz}`)
      expect(Number.isFinite(ex.x) && Number.isFinite(ex.y) && Number.isFinite(ex.z)).toBe(true)
      const c = new Chunk(ex.cx, ex.cy, ex.cz, worldSeed, materials, geom, null, config, null)
      expect(c.data.lamps.some((l) => l.lit && l.tint === CRIMSON)).toBe(true)
      c.dispose()
      const sp = familySpawn(config, worldSeed)
      expect([sp.cx, sp.cz, sp.lx, sp.lz]).toEqual([0, 0, SPAWN_CELLS[0].lx, SPAWN_CELLS[0].lz])
    }
  }, 60_000)
})
