import { describe, it, expect } from 'vitest'
import { ChunkData } from '../ChunkData.js'
import { collectDoorways, normalizeDoorPassages } from '../doors.js'
import { CHUNK, ZONE_OFFICE } from '../constants.js'
import { PASSAGE_DOOR, PASSAGE_WIDE } from '../mapTypes.js'

// Lay a full wall down a vertical grid line (every row is a wall slab).
function wallLineV(data, lx) {
  for (let z = 0; z < CHUNK; z++) data.setV(lx, z, 1)
}

describe('collectDoorways', () => {
  it('finds a single-cell gap punched through a wall line', () => {
    const data = new ChunkData(0, 0, 0, ZONE_OFFICE)
    wallLineV(data, 5)
    data.setPassageV(5, 7, PASSAGE_DOOR)
    const doors = collectDoorways(data, 1)
    expect(doors.length).toBe(1)
    expect(doors[0]).toMatchObject({ axis: 'v', line: 5, cell: 7, leaf: true })
  })

  it('ignores wide gaps (transition mouths) and fully open lines', () => {
    const data = new ChunkData(0, 0, 0, ZONE_OFFICE)
    wallLineV(data, 5)
    data.setPassageV(5, 6, PASSAGE_WIDE)
    data.setPassageV(5, 7, PASSAGE_WIDE)
    data.setPassageV(5, 8, PASSAGE_WIDE)
    expect(collectDoorways(data, 1).length).toBe(0)
    // A chunk with no interior walls at all -> nothing to frame.
    expect(collectDoorways(new ChunkData(0, 0, 0, ZONE_OFFICE), 1).length).toBe(0)
  })

  it('detects horizontal doorways too', () => {
    const data = new ChunkData(0, 0, 0, ZONE_OFFICE)
    for (let x = 0; x < CHUNK; x++) data.setH(x, 4, 1)
    data.setPassageH(3, 4, PASSAGE_DOOR)
    const doors = collectDoorways(data, 1)
    expect(doors.length).toBe(1)
    expect(doors[0]).toMatchObject({ axis: 'h', line: 4, cell: 3 })
  })

  it('is deterministic, gates leaves on the fraction, and hinges into a real wall', () => {
    const data = new ChunkData(2, 0, -3, ZONE_OFFICE)
    wallLineV(data, 5)
    data.setPassageV(5, 7, PASSAGE_DOOR)
    const a = collectDoorways(data, 1)
    const b = collectDoorways(data, 1)
    expect(a).toEqual(b) // same data -> identical descriptors
    expect(collectDoorways(data, 0)[0].leaf).toBe(false) // fraction 0 -> never a leaf
    // The open leaf must lie against an in-range wall neighbour, never off-chunk.
    expect(Math.abs(a[0].hinge)).toBe(1)
    expect(a[0].cell + a[0].hinge).toBeGreaterThanOrEqual(0)
    expect(a[0].cell + a[0].hinge).toBeLessThan(CHUNK)
  })

  it('does not infer a semantic door from an arbitrary raster gap', () => {
    const data = new ChunkData(0, 0, 0, ZONE_OFFICE)
    wallLineV(data, 5)
    data.setV(5, 7, 0)
    expect(collectDoorways(data, 1)).toEqual([])
  })

  it('turns an unsupported frame into a wide threshold after late carving', () => {
    const data = new ChunkData(0, 0, 0, ZONE_OFFICE)
    data.setPassageV(5, 7, PASSAGE_DOOR)
    expect(normalizeDoorPassages(data)).toBe(1)
    expect(data.passageVAt(5, 7)).toBe(PASSAGE_WIDE)
    expect(collectDoorways(data, 1)).toEqual([])
  })
})
