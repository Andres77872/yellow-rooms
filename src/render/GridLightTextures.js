import * as THREE from 'three'
import { GI_TEXELS, GRID_H, GRID_W } from '../world/lightGrid/gridSpec.js'

// GPU mirror of a headless LightGrid (world/lightGrid/LightGrid.js). The
// DataTextures wrap the grid's own typed arrays — no copies — and sync()
// turns the grid's dirty texel rectangles into per-row texSubImage2D ranges,
// so streaming a chunk uploads ~14 rows of 14 texels per texture instead of
// the whole 168 x 1008 window.
//
// Unbound state: every sampler still needs a texture of the right kind (an
// integer sampler with a float texture bound fails the draw even when the
// branch reading it never runs), so a 1x1 placeholder set is always present.

function dataTexture(data, width, height, format, type, internalFormat) {
  const tex = new THREE.DataTexture(data, width, height, format, type)
  if (internalFormat) tex.internalFormat = internalFormat
  tex.minFilter = THREE.NearestFilter
  tex.magFilter = THREE.NearestFilter
  tex.generateMipmaps = false
  tex.flipY = false
  tex.unpackAlignment = 1
  tex.needsUpdate = true
  return tex
}

export function createPlaceholderGridTextures() {
  return {
    list: dataTexture(new Uint32Array(4), 1, 1, THREE.RGBAIntegerFormat, THREE.UnsignedIntType, 'RGBA32UI'),
    edge: dataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType),
    lamp: dataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType),
    gi: dataTexture(new Uint16Array(4), 1, 1, THREE.RGBAFormat, THREE.HalfFloatType),
    occ: dataTexture(new Uint32Array(4), 1, 1, THREE.RGBAIntegerFormat, THREE.UnsignedIntType, 'RGBA32UI'),
  }
}

export class GridLightTextures {
  constructor(grid) {
    this.grid = grid
    this.textures = {
      list: dataTexture(grid.list, GRID_W, GRID_H, THREE.RGBAIntegerFormat, THREE.UnsignedIntType, 'RGBA32UI'),
      edge: dataTexture(grid.edge, GRID_W, GRID_H, THREE.RGBAFormat, THREE.UnsignedByteType),
      lamp: dataTexture(grid.lamp, GRID_W, GRID_H, THREE.RGBAFormat, THREE.UnsignedByteType),
      gi: dataTexture(grid.gi, GRID_W * GI_TEXELS, GRID_H, THREE.RGBAFormat, THREE.HalfFloatType),
      // Furniture occupancy (proxy boxes + ring masks). The owner table is
      // CPU-only now: shaders trust the edge texel's LOADED flag + floor tag.
      occ: dataTexture(grid.occ, GRID_W, GRID_H, THREE.RGBAIntegerFormat, THREE.UnsignedIntType, 'RGBA32UI'),
    }
    // The first upload is the full texture (needsUpdate with no ranges);
    // anything the grid queued before binding is covered by it.
    grid.takeDirty()
    this.uploads = 0
    this._whole = false
  }

  // After a GL context restore three reallocates every texture zero-filled
  // and uploads only the pending update ranges when there are any, which
  // would leave every row nobody dirtied since empty (cells lose their
  // lists, GI and LOADED flag). Drop the ranges now, for a bind that comes
  // before the next sync(), and have that sync() upload whole too, so rects
  // dirtied on the restore frame cannot make it partial again.
  restore() {
    this._whole = true
    for (const tex of Object.values(this.textures)) {
      tex.clearUpdateRanges()
      tex.needsUpdate = true
    }
  }

  // Push the grid's pending rectangles as update ranges. Returns the number
  // of texel rows scheduled (for the perf tools).
  sync() {
    const dirty = this.grid.takeDirty()
    let rows = 0
    if (this._whole) {
      // The whole arrays go up, so the drained rects are already covered.
      this._whole = false
      for (const tex of Object.values(this.textures)) {
        tex.clearUpdateRanges()
        tex.needsUpdate = true
        rows += tex.image.height
        this.uploads++
      }
      return rows
    }
    for (const [name, rects] of Object.entries(dirty)) {
      const tex = this.textures[name]
      if (!rects.length || !tex) continue
      const width = tex.image.width
      const height = tex.image.height
      let whole = false
      for (let i = 0; i < rects.length; i += 4) {
        const x = rects[i]
        const y = rects[i + 1]
        const w = rects[i + 2]
        const h = rects[i + 3]
        if (w >= width && h >= height) {
          whole = true
          break
        }
        for (let r = 0; r < h; r++) {
          tex.addUpdateRange(((y + r) * width + x) * 4, w * 4)
        }
        rows += h
      }
      if (whole) {
        tex.clearUpdateRanges()
        rows += height
      }
      tex.needsUpdate = true
      this.uploads++
    }
    return rows
  }

  dispose() {
    for (const tex of Object.values(this.textures)) tex.dispose()
  }
}
