import * as THREE from 'three'
import { paintSurfaceCanvas, surfaceDetailData } from './textures.js'
import { surfaceStyle } from './surfaces.js'
import { SURFACE_MAX_LAYERS, SURFACE_SLOTS } from '../world/surfaceSet.js'
import { CELL } from '../world/constants.js'

// GPU side of the world surface sets (world/surfaceSet.js): every recipe of
// a slot painted into one layer of a texture array, with the companion detail
// array (tangent normal, roughness, cavity) derived from the same pixels.
// The G-buffer surface materials pick a layer per fragment from the chunk
// zone map, so a whole world of distinct rooms costs three array binds and
// no extra draw calls.
//
// Texel rows are written bottom-up, matching the flipY canvas textures the
// family's single base surfaces use (layer 0 = that same painting).

function arrayTexture(data, size, layers, srgb, aniso) {
  const tex = new THREE.DataArrayTexture(data, size, size, layers)
  tex.format = THREE.RGBAFormat
  tex.type = THREE.UnsignedByteType
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.anisotropy = aniso
  tex.needsUpdate = true
  return tex
}

// Physical per-layer parameters the shader cannot read from the detail map.
// Tile pitch (m) of a tiled ceiling recipe — the grid missing tiles and
// stains follow — else 0 (plaster, vault, slats and decks have no tiles).
export function ceilingTilePitch(spec) {
  if (spec.style === 'acoustic') return CELL / (spec.tiles ?? 4)
  if (spec.style === 'tile') return CELL / (spec.tiles ?? 2)
  return 0
}

function layerParams(layers, glossOf) {
  const metal = new Float32Array(SURFACE_MAX_LAYERS)
  const gloss = new Float32Array(SURFACE_MAX_LAYERS)
  const tile = new Float32Array(SURFACE_MAX_LAYERS)
  layers.forEach((spec, i) => {
    metal[i] = surfaceStyle(spec.style).metalness
    gloss[i] = glossOf(spec)
    tile[i] = ceilingTilePitch(spec)
  })
  return { metal, gloss, tile }
}

// The detail pass blurs over ~2 design texels before it differentiates, so
// its relief carries no more than the 256 design resolution holds: larger
// albedo layers derive their detail from a 256 downsample (a quarter of the
// work for the same normals) and the detail array stays at 256.
const DETAIL_MAX = 256
let scratch = null

function detailSource(c, size) {
  if (size <= DETAIL_MAX) return { canvas: c, pixels: null }
  scratch ??= document.createElement('canvas')
  scratch.width = scratch.height = DETAIL_MAX
  const ctx = scratch.getContext('2d', { willReadFrequently: true })
  ctx.clearRect(0, 0, DETAIL_MAX, DETAIL_MAX)
  ctx.drawImage(c, 0, 0, DETAIL_MAX, DETAIL_MAX)
  return { canvas: scratch, pixels: ctx.getImageData(0, 0, DETAIL_MAX, DETAIL_MAX).data }
}

// Paint one slot. Returns { map, detail, metal, gloss, count, ms }.
export function buildSlotArray(slot, layers, { size = 256, aniso = 1, glossOf = () => 0 } = {}) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0
  const count = layers.length
  const texels = size * size * 4
  const detailSize = Math.min(size, DETAIL_MAX)
  const detailTexels = detailSize * detailSize * 4
  const albedo = new Uint8Array(texels * count)
  const detail = new Uint8Array(detailTexels * count)
  const row = size * 4
  layers.forEach((spec, layer) => {
    const c = paintSurfaceCanvas(slot, spec, size)
    const px = c.getContext('2d').getImageData(0, 0, size, size).data
    const base = layer * texels
    for (let y = 0; y < size; y++) {
      const from = (size - 1 - y) * row
      albedo.set(px.subarray(from, from + row), base + y * row)
    }
    const src = detailSource(c, size)
    const d = surfaceDetailData(src.canvas, spec, src.pixels ?? px)
    if (d) detail.set(d, layer * detailTexels)
  })
  return {
    map: arrayTexture(albedo, size, count, true, aniso),
    detail: arrayTexture(detail, detailSize, count, false, aniso),
    ...layerParams(layers, glossOf),
    count,
    ms: (typeof performance !== 'undefined' ? performance.now() : 0) - t0,
  }
}

export function buildSurfaceArrays(set, options = {}) {
  const out = { family: set.family, seed: set.seed, size: options.size ?? 256 }
  for (const slot of SURFACE_SLOTS) out[slot] = buildSlotArray(slot, set[slot], options)
  return out
}

export function disposeSurfaceArrays(arrays) {
  if (!arrays) return
  for (const slot of SURFACE_SLOTS) {
    arrays[slot]?.map?.dispose()
    arrays[slot]?.detail?.dispose()
  }
}
