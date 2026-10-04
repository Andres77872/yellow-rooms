import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { Chunk } from '../../../Chunk.js'
import { createGeometries } from '../../../../render/geometries.js'
import { createExitPlacement } from '../../../../core/exitPlacement.js'
import { isSolidMassChunk } from '../../../tiles/solidChunk.js'
import { forcedFamilyConfig } from '../../forced.js'
import { familySpawn } from '../../hooks.js'
import { exitAnchor, exitTileOf, footprint, hallsOf, spawnCells } from '../geometry.js'

// The playplace in the runtime (spec §12.9 "playable"): the real pipeline's
// chunks build into render chunks (meshes, the halls' climbs as stair cells,
// lamps, plates), footprint-solid chunks take the mass fast path, and the
// engine's exit placement lands on the anchor module's far tube pod on the
// deck.

const geom = createGeometries()
const material = new THREE.MeshBasicMaterial()
const materials = new Proxy({}, { get: () => material })
const config = forcedFamilyConfig('playplace')

const instancesOf = (group) => {
  let n = 0
  group.traverse((o) => { if (o.isInstancedMesh) n += o.count })
  return n
}

describe('playplace runtime', () => {
  it('the spawn module and its east neighbour build: kept chunks mesh, the hall chunks carry their climbs, solid chunks are fast-path mass', () => {
    const seed = 1
    let climbs = 0
    let solid = 0
    for (const tx of [0, 1]) {
      const hallChunks = new Set(hallsOf(seed, tx, 0).flatMap((h) => h.desc.participants.map((p) => `${p.cx},${p.cz}`)))
      for (let cy = 0; cy <= 2; cy++) {
        for (let cz = 0; cz < 2; cz++) {
          for (let cx = tx * 2; cx < tx * 2 + 2; cx++) {
            const c = new Chunk(cx, cy, cz, seed, materials, geom, null, config, null)
            expect(c.data.mapFamily).toBe('playplace')
            if (footprint(seed, cx, cy, cz) === 'solid') {
              solid++
              expect(isSolidMassChunk(c.data), `${cx},${cy},${cz}`).toBe(true)
              expect(instancesOf(c.group)).toBe(0)
            } else {
              expect(instancesOf(c.group), `${cx},${cy},${cz}`).toBeGreaterThan(0)
              expect(typeof c.data.levelLabel).toBe('string')
              expect(c.data.lamps.some((l) => l.lit), `lit lamps ${cx},${cy},${cz}`).toBe(true)
              if (cy < 2 && hallChunks.has(`${cx},${cz}`)) climbs += c.stairCells.size
            }
            c.dispose()
          }
        }
      }
    }
    expect(climbs).toBeGreaterThan(0)
    expect(solid).toBeGreaterThan(0)
  }, 60_000)

  it('the engine exit placement takes the hook: the anchor module\'s far tube pod on the deck; the spawn is by module (0,0)\'s main gate', () => {
    for (const seedText of ['soft', 'play']) {
      const worldSeed = 0x2468 + seedText.charCodeAt(0)
      const ex = createExitPlacement(seedText, 1, worldSeed, config)
      const a = exitAnchor(worldSeed)
      expect([ex.cx, ex.cy, ex.cz, ex.lx, ex.lz]).toEqual([a.cx, 1, a.cz, a.lx, a.lz])
      const t = exitTileOf(worldSeed)
      expect([Math.floor(ex.cx / 2), Math.floor(ex.cz / 2)]).toEqual([t.tx, t.tz])
      expect(Number.isFinite(ex.x) && Number.isFinite(ex.y) && Number.isFinite(ex.z)).toBe(true)
      const sp = familySpawn(config, worldSeed)
      expect(spawnCells(worldSeed).map((c) => `${c.gx},${c.gz}`)).toContain(`${sp.cx * 14 + sp.lx},${sp.cz * 14 + sp.lz}`)
    }
  })
})
