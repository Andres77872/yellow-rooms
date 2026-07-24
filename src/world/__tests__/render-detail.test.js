import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { Chunk } from '../Chunk.js'
import { ChunkData } from '../ChunkData.js'
import { ChunkManager } from '../ChunkManager.js'
import { buildChunkMeshes } from '../mesh.js'
import {
  COLUMN_STANDARD,
  MAP_FAMILY_LATTICE,
  MAP_FAMILY_OFFICE,
} from '../mapTypes.js'
import {
  createGeometries,
  disposeGeometries,
} from '../../render/geometries.js'
import {
  DEFAULT_RENDER_DETAIL_PROFILE,
  RENDER_DETAIL_FULL,
  RENDER_DETAIL_PROFILES,
  RENDER_DETAIL_REDUCED,
  RENDER_DETAIL_SHELL,
  normalizeRenderDetailLevel,
  normalizeRenderDetailProfile,
  renderDetailForChunk,
  renderDetailForRing,
} from '../renderDetail.js'

function partSet() {
  return Object.fromEntries([
    'floor',
    'ceiling',
    'walls',
    'frames',
    'leaves',
    'props',
    'signs',
    'furniture',
    'litPanels',
    'deadPanels',
    'exit',
  ].map((name) => [name, { name, visible: true }]))
}

function detailChunk(family = MAP_FAMILY_OFFICE, groupVisible = true) {
  return Object.assign(Object.create(Chunk.prototype), {
    data: { mapFamily: family },
    group: { visible: groupVisible },
    renderParts: partSet(),
    renderDetail: RENDER_DETAIL_FULL,
  })
}

describe('render-detail ring policy', () => {
  it.each([
    ['low', [RENDER_DETAIL_FULL, RENDER_DETAIL_FULL, RENDER_DETAIL_REDUCED, RENDER_DETAIL_REDUCED, RENDER_DETAIL_SHELL]],
    ['medium', [RENDER_DETAIL_FULL, RENDER_DETAIL_FULL, RENDER_DETAIL_FULL, RENDER_DETAIL_REDUCED, RENDER_DETAIL_SHELL]],
    ['high', [RENDER_DETAIL_FULL, RENDER_DETAIL_FULL, RENDER_DETAIL_FULL, RENDER_DETAIL_REDUCED, RENDER_DETAIL_SHELL]],
    ['ultra', [RENDER_DETAIL_FULL, RENDER_DETAIL_FULL, RENDER_DETAIL_FULL, RENDER_DETAIL_FULL, RENDER_DETAIL_REDUCED]],
  ])('%s resolves rings 0..4 exactly', (profile, expected) => {
    expect(RENDER_DETAIL_PROFILES[profile]).toBeDefined()
    expect(expected.map((_, ring) => renderDetailForRing(ring, profile))).toEqual(expected)
  })

  it('uses Chebyshev chunk distance and falls back safely on hostile values', () => {
    expect(renderDetailForChunk(4, -2, 7, -5, 'high')).toBe(RENDER_DETAIL_REDUCED)
    expect(renderDetailForChunk(4, -2, 8, -2, 'high')).toBe(RENDER_DETAIL_SHELL)
    expect(normalizeRenderDetailProfile('broken')).toBe(DEFAULT_RENDER_DETAIL_PROFILE)
    expect(normalizeRenderDetailLevel('broken')).toBe(RENDER_DETAIL_FULL)
    expect(renderDetailForRing(Number.NaN, 'broken')).toBe(RENDER_DETAIL_FULL)
    expect(renderDetailForRing(Number.POSITIVE_INFINITY, 'high')).toBe(RENDER_DETAIL_SHELL)
    expect(renderDetailForRing(Number.POSITIVE_INFINITY, 'ultra')).toBe(RENDER_DETAIL_REDUCED)
  })
})

describe('Chunk child render detail', () => {
  it('receives stable semantic references from the real chunk mesh builder', () => {
    const geometry = createGeometries()
    const material = new THREE.MeshBasicMaterial()
    const materials = Object.fromEntries([
      'carpet',
      'ceiling',
      'wallpaper',
      'doorFrame',
      'doorLeaf',
      'prop',
      'signGlow',
      'furniture',
      'panel',
      'panelDead',
      'exit',
    ].map((name) => [name, material]))
    const data = new ChunkData(0, 0, 0, 0)
    data.setCol(2, 2, COLUMN_STANDARD)
    data.lamps.push({ lx: 4, lz: 4, lit: true })
    data.lamps.push({ lx: 8, lz: 8, lit: false })
    data.exit = { lx: 7, lz: 7 }
    const mesh = buildChunkMeshes(data, geometry, materials, 0, 0, 0)

    expect(Object.keys(mesh.parts)).toEqual([
      'floor',
      'ceiling',
      'walls',
      'frames',
      'leaves',
      'props',
      'signs',
      'furniture',
      'litPanels',
      'deadPanels',
      'exit',
    ])
    for (const part of Object.values(mesh.parts)) {
      if (part) expect(mesh.group.children).toContain(part)
    }
    expect(mesh.parts.walls).not.toBeNull()
    expect(mesh.parts.frames).not.toBeNull()
    expect(mesh.parts.litPanels).not.toBeNull()
    expect(mesh.parts.deadPanels).not.toBeNull()
    expect(mesh.parts.exit).not.toBeNull()

    mesh.dispose()
    disposeGeometries(geometry)
    material.dispose()
  })

  it('drops only decorative batches at reduced and silhouettes at shell', () => {
    const chunk = detailChunk(MAP_FAMILY_OFFICE, false)
    const p = chunk.renderParts

    expect(chunk.setRenderDetail(RENDER_DETAIL_REDUCED)).toBe(true)
    expect(p.frames.visible).toBe(false)
    expect(p.props.visible).toBe(false)
    expect(p.deadPanels.visible).toBe(false)
    expect(p.leaves.visible).toBe(true)
    expect(p.furniture.visible).toBe(true)
    for (const key of ['floor', 'ceiling', 'walls', 'signs', 'litPanels', 'exit']) {
      expect(p[key].visible, key).toBe(true)
    }
    expect(chunk.group.visible).toBe(false)

    expect(chunk.setRenderDetail(RENDER_DETAIL_REDUCED)).toBe(false)
    expect(chunk.setRenderDetail(RENDER_DETAIL_SHELL)).toBe(true)
    expect(p.leaves.visible).toBe(false)
    expect(p.furniture.visible).toBe(false)
    for (const key of ['floor', 'ceiling', 'walls', 'signs', 'litPanels', 'exit']) {
      expect(p[key].visible, key).toBe(true)
    }

    expect(chunk.setRenderDetail(RENDER_DETAIL_FULL)).toBe(true)
    for (const part of Object.values(p)) expect(part.visible, part.name).toBe(true)
    expect(chunk.group.visible).toBe(false)
  })

  it('retains Lattice rail-bearing frames at reduced but not shell', () => {
    const chunk = detailChunk(MAP_FAMILY_LATTICE)
    expect(chunk.setRenderDetail(RENDER_DETAIL_REDUCED)).toBe(true)
    expect(chunk.renderParts.frames.visible).toBe(true)
    expect(chunk.renderParts.props.visible).toBe(false)

    expect(chunk.setRenderDetail(RENDER_DETAIL_SHELL)).toBe(true)
    expect(chunk.renderParts.frames.visible).toBe(false)
  })

  it('tolerates absent optional batches', () => {
    const chunk = detailChunk()
    for (const key of ['frames', 'leaves', 'props', 'signs', 'furniture', 'litPanels', 'deadPanels', 'exit']) {
      chunk.renderParts[key] = null
    }
    expect(() => chunk.setRenderDetail(RENDER_DETAIL_SHELL)).not.toThrow()
    expect(chunk.renderParts.floor.visible).toBe(true)
    expect(chunk.renderParts.ceiling.visible).toBe(true)
    expect(chunk.renderParts.walls.visible).toBe(true)
  })
})

describe('ChunkManager render-detail cadence', () => {
  const resident = (cx, cz) => ({
    cx,
    cz,
    setRenderDetail: vi.fn(() => true),
  })

  it('rewalks only after an origin, profile, or family change', () => {
    const cm = new ChunkManager(new THREE.Scene(), 1, null, null)
    cm.config = { mapFamily: { selected: MAP_FAMILY_OFFICE } }
    const near = resident(0, 0)
    const ring2 = resident(2, 0)
    const ring3 = resident(3, 0)
    const ring4 = resident(4, 0)
    cm.chunks.set('near', near)
    cm.chunks.set('ring2', ring2)
    cm.chunks.set('ring3', ring3)
    cm.chunks.set('ring4', ring4)

    expect(cm._syncRenderDetail(0, 0)).toBe(true)
    expect(near.setRenderDetail).toHaveBeenLastCalledWith(RENDER_DETAIL_FULL)
    expect(ring2.setRenderDetail).toHaveBeenLastCalledWith(RENDER_DETAIL_FULL)
    expect(ring3.setRenderDetail).toHaveBeenLastCalledWith(RENDER_DETAIL_REDUCED)
    expect(ring4.setRenderDetail).toHaveBeenLastCalledWith(RENDER_DETAIL_SHELL)

    expect(cm._syncRenderDetail(0, 0)).toBe(false)
    for (const chunk of [near, ring2, ring3, ring4]) {
      expect(chunk.setRenderDetail).toHaveBeenCalledTimes(1)
    }

    expect(cm.setRenderDetailProfile('low')).toBe(true)
    expect(ring2.setRenderDetail).toHaveBeenLastCalledWith(RENDER_DETAIL_REDUCED)
    for (const chunk of [near, ring2, ring3, ring4]) {
      expect(chunk.setRenderDetail).toHaveBeenCalledTimes(2)
    }
    expect(cm.setRenderDetailProfile('low')).toBe(false)

    cm.config.mapFamily.selected = 'sewer'
    expect(cm._syncRenderDetail(0, 0)).toBe(true)
    for (const chunk of [near, ring2, ring3, ring4]) {
      expect(chunk.setRenderDetail).toHaveBeenCalledTimes(3)
    }

    expect(cm._syncRenderDetail(1, 0)).toBe(true)
    for (const chunk of [near, ring2, ring3, ring4]) {
      expect(chunk.setRenderDetail).toHaveBeenCalledTimes(4)
    }
  })

  it('applies the cached profile to a newly resident chunk without rewalking peers', () => {
    const cm = new ChunkManager(new THREE.Scene(), 1, null, null)
    const peer = resident(0, 0)
    cm.chunks.set('peer', peer)
    cm._syncRenderDetail(0, 0)
    expect(peer.setRenderDetail).toHaveBeenCalledTimes(1)

    const late = resident(4, 1)
    expect(cm._applyRenderDetail(late)).toBe(true)
    expect(late.setRenderDetail).toHaveBeenCalledOnce()
    expect(late.setRenderDetail).toHaveBeenLastCalledWith(RENDER_DETAIL_SHELL)
    expect(peer.setRenderDetail).toHaveBeenCalledTimes(1)
  })

  it('keeps the selected profile across reset while invalidating its origin cache', () => {
    const cm = new ChunkManager(new THREE.Scene(), 1, null, null)
    cm.setRenderDetailProfile('low')
    cm._syncRenderDetail(2, -3)
    cm.reset()

    expect(cm._renderDetailProfile).toBe('low')
    expect(cm._detailPcx).toBeNull()
    expect(cm._detailPcz).toBeNull()
    expect(cm._detailFamily).toBeNull()
    expect(cm._detailAppliedProfile).toBeNull()
  })
})
