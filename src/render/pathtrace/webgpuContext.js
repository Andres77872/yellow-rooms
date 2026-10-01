import * as THREE from 'three/webgpu'
import { requestTracerAdapter } from './webgpuSupport.js'

// One WebGPURenderer for the path tracer (the viewer on the page, or the
// realtime tracer's worker on an OffscreenCanvas), with the device limits
// the tracer needs and every way the device can fail wired to
// `onLost(message)`. Lazy-loaded, never at boot.
export async function createTracerRenderer({ onLost, canvas = undefined }) {
  const { requiredLimits, info } = await requestTracerAdapter()
  const renderer = new THREE.WebGPURenderer({ antialias: false, requiredLimits, canvas })
  try {
    await renderer.init()
    // WebGPURenderer silently falls back to WebGL 2; the tracer's compute
    // kernels cannot run there.
    if (!renderer.backend?.isWebGPUBackend) throw new Error('WebGPU backend unavailable')
  } catch (err) {
    renderer.dispose()
    throw err
  }
  renderer.onDeviceLost = (lost) => onLost(lost?.message || 'WebGPU device lost')
  renderer.backend.device?.addEventListener?.('uncapturederror', (event) => {
    onLost(event?.error?.message || 'WebGPU error')
  })
  renderer.setPixelRatio(1)
  // No sky: escaped rays and the NEE environment term see black.
  renderer.setClearColor(0x000000, 1)
  return { renderer, info }
}

// 0.0.25's dispose() dereferences the BVH data setScene() creates, so it
// throws when the tracer never had a scene. The renderer's own dispose
// releases the device either way.
export function disposeTracer(tracer) {
  try {
    tracer?.dispose()
  } catch {
    /* never had a scene */
  }
}

export function disposeRenderer(renderer) {
  if (!renderer) return
  renderer.onDeviceLost = () => {}
  // An OffscreenCanvas has no place in the DOM.
  renderer.domElement?.remove?.()
  renderer.dispose()
}
