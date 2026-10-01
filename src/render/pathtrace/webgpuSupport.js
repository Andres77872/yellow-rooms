// WebGPU gate for the experimental path-traced view. This file stays in the
// game's boot graph (the settings panel reads it), so it must not import
// three.js or the tracer; PathTraceView.js does that, lazily.
//
// Two levels, both free while the option is off:
//   webgpuAvailability()  synchronous: is WebGPU exposed at all? Decides
//                         whether the settings toggle can be switched on.
//   requestTracerAdapter()  async, only on first use: a real adapter plus
//                         the device limits the tracer needs.

// The tracer's slot pool, queues and BVH buffers outgrow WebGPU's default
// 256 MiB / 128 MiB caps on large scenes; the upstream example requests the
// adapter's own maxima for exactly these two limits.
export const TRACER_DEVICE_LIMITS = ['maxBufferSize', 'maxStorageBufferBindingSize']

export function webgpuAvailability({
  nav = globalThis.navigator,
  secure = globalThis.isSecureContext,
  touch = false,
} = {}) {
  if (touch) return { ok: false, reason: 'Desktop only' }
  if (!nav?.gpu) return { ok: false, reason: 'WebGPU is not available in this browser' }
  // WebGPU is only exposed to secure contexts; some engines still define
  // navigator.gpu elsewhere and fail later, so say why up front.
  if (secure === false) return { ok: false, reason: 'WebGPU needs a secure (https) page' }
  return { ok: true, reason: '' }
}

export async function requestTracerAdapter(nav = globalThis.navigator) {
  const adapter = await nav?.gpu?.requestAdapter?.({ powerPreference: 'high-performance' })
  if (!adapter) throw new Error('No WebGPU adapter')
  const requiredLimits = {}
  for (const name of TRACER_DEVICE_LIMITS) {
    const value = adapter.limits?.[name]
    if (typeof value === 'number') requiredLimits[name] = value
  }
  const info = adapter.info ?? {}
  return {
    adapter,
    requiredLimits,
    info: {
      vendor: info.vendor ?? '',
      architecture: info.architecture ?? '',
      fallback: !!(adapter.isFallbackAdapter ?? info.isFallbackAdapter),
    },
  }
}
