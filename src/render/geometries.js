import * as THREE from 'three'
import { CHUNK, CHUNK_WORLD } from '../world/constants.js'

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

  // Unit cube for the thin-wall model: scaled per instance (thin on one axis for
  // wall slabs, square for columns) via the instance matrix.
  const wallUnit = new THREE.BoxGeometry(1, 1, 1)

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

  return { floor, ceiling, wallUnit, panel, exit, entity, pursuer }
}

export function disposeGeometries(geom) {
  for (const g of Object.values(geom)) g.dispose()
}
