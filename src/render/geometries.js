import * as THREE from 'three'
import { BEVEL_DETAIL, BEVEL_STAIR, BEVEL_WALL, CHUNK, CHUNK_WORLD } from '../world/constants.js'
import { createBevelBoxGeometry, createBevelPrismGeometry } from './bevel.js'

// Shared geometries reused by every chunk (positioned via mesh transforms /
// instance matrices). Created once, disposed once at teardown.

function scaleUV(geo, n) {
  const uv = geo.attributes.uv
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * n, uv.getY(i) * n)
  uv.needsUpdate = true
  return geo
}

export function createGeometries() {
  // Floor: faces up (+y), carpet tiles ~ once per cell.
  const floor = new THREE.PlaneGeometry(CHUNK_WORLD, CHUNK_WORLD)
  floor.rotateX(-Math.PI / 2)
  scaleUV(floor, CHUNK)

  // Ceiling: faces down (-y).
  const ceiling = new THREE.PlaneGeometry(CHUNK_WORLD, CHUNK_WORLD)
  ceiling.rotateX(Math.PI / 2)
  scaleUV(ceiling, CHUNK)

  // Unit cubes for the thin-wall model, scaled per instance (thin on one axis
  // for wall runs, square for columns and posts) via the instance matrix.
  // All are bevelled at a constant world radius (render/bevel.js): the wall
  // shell rounds its vertical edges only (feet and heads meet the slabs);
  // the stair and detail cubes — treads; trim, props, signs, leaves and
  // fallback furniture — round all twelve.
  const wallUnit = createBevelPrismGeometry(BEVEL_WALL)
  const stairUnit = createBevelBoxGeometry(BEVEL_STAIR)
  const detailUnit = createBevelBoxGeometry(BEVEL_DETAIL)
  // A detail bevel is a couple of centimetres, sub-pixel beyond the player's
  // neighbourhood: farther chunks swap their detail batches to this plain
  // 12-triangle cube (Chunk.setBevelDetail) instead of the 44-triangle one.
  const detailUnitSharp = new THREE.BoxGeometry(1, 1, 1)

  // Recessed fluorescent panel, faces down just below the ceiling.
  const panel = new THREE.PlaneGeometry(1.7, 1.0)
  panel.rotateX(Math.PI / 2)

  // Glitchy noclip exit doorway.
  const exit = new THREE.BoxGeometry(2.0, 2.6, 0.35)

  // Simple anime entity silhouette (tall, narrow) — the Stalker.
  const entity = new THREE.CapsuleGeometry(0.42, 1.5, 4, 10)

  // Pursuer silhouette: low, broad and hunched — reads as a different threat
  // from the tall thin Stalker even at a glance.
  const pursuer = new THREE.CapsuleGeometry(0.6, 1.2, 4, 10)

  // Husk silhouette: smaller and frailer than either hunter — a person-shaped
  // remnant that just stands there.
  const husk = new THREE.CapsuleGeometry(0.38, 1.2, 4, 10)

  return { floor, ceiling, wallUnit, stairUnit, detailUnit, detailUnitSharp, panel, exit, entity, pursuer, husk }
}

export function disposeGeometries(geom) {
  for (const g of Object.values(geom)) g.dispose()
}
