import { auditLayeredPatch } from '../../world/audit.js'
import { EditorMap } from '../EditorMap.js'
import { serializeMap } from '../format/yrmap.js'
import { PROTOTYPE_KINDS, buildKind } from '../prototypes.js'
import { graphComponents, walkGraph } from '../simulate.js'

// Shared judge for kind-lab prototypes (prototypes.test.js's contract, for
// every kind test): the layered audit over the document's chunk bounds, the
// planar components of each floor and the components of the whole volume.

export const KIND_SEEDS = Object.freeze([
  'proto', 'lobby', 'same',
  'liminal-0', 'liminal-1', 'liminal-2', 'liminal-3', 'liminal-4', 'liminal-5', 'liminal-6', 'liminal-7',
])

// `bad` lists every non-empty audit detail ("key: first two entries"),
// `floors` each storey's components as "size@gx,gz", `volume` the component
// count across floors (stairs joining them).
export function judgeMap(map) {
  const b = map.bounds()
  const box = { x0: b.x0, x1: b.x1, z0: b.z0, z1: b.z1, y0: b.y0, y1: b.y1 }
  const audit = auditLayeredPatch(
    (cx, cy, cz) => map.chunkAt(cx, cy, cz),
    b.x0, b.y0, b.z0, b.x1 - b.x0 + 1, b.y1 - b.y0 + 1, b.z1 - b.z0 + 1
  )
  const bad = Object.entries(audit.details).filter(([, v]) => v.length).map(([k, v]) => `${k}: ${JSON.stringify(v.slice(0, 2))}`)
  const floors = []
  for (let cy = b.y0; cy <= b.y1; cy++) {
    const comps = graphComponents(walkGraph(map, { ...box, y0: cy, y1: cy }, { vertical: false }))
    floors.push(comps.map((c) => `${c.size}@${c.sample.gx},${c.sample.gz}`))
  }
  const volume = graphComponents(walkGraph(map, box)).length
  return { audit, bad, floors, volume, box }
}

// Assert kind `kindId` builds a clean, connected, deterministic map for every
// seed (each floor one planar component unless the kind declares
// floorPockets). `kindId` is a registered id or an unregistered kind object (a
// scratch kind in a test).
export function expectKindClean(expect, kindId, seeds = KIND_SEEDS) {
  const kind = typeof kindId === 'string' ? PROTOTYPE_KINDS.find((k) => k.id === kindId) : kindId
  expect(kind, `unknown kind ${kindId}`).toBeTruthy()
  const build = (seed) => {
    const map = new EditorMap()
    const res = buildKind(map, kind, { seed })
    return { map, res }
  }
  for (const seed of seeds) {
    const { map, res } = build(seed)
    const at = `${kind.id} seed ${seed}`
    expect(res.error, at).toBeUndefined()
    expect(res.ok, at).toBe(true)
    const { bad, floors, volume, audit } = judgeMap(map)
    expect(bad, at).toEqual([])
    // A kind with floorPockets (a ladder of shafts joined on a few storeys)
    // may split a storey into planar pockets; the volume must still be one.
    const planar = kind.floorPockets ? floors.every((f) => f.length >= 1) : floors.every((f) => f.length === 1)
    expect(planar, `${at}: ${JSON.stringify(floors)}`).toBe(true)
    expect(floors, at).toHaveLength(kind.floors)
    expect(volume, at).toBe(1)
    expect(audit.canonicalLinks, at).toBeGreaterThanOrEqual(kind.floors - 1)
    const again = build(seed).map
    expect(Buffer.from(serializeMap(again)).equals(Buffer.from(serializeMap(map))), `${at}: bytes differ`).toBe(true)
  }
}
