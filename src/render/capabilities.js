import * as THREE from 'three'

// Startup capability probe for the deferred pipeline (engine-improvement S0,
// chapter 12 §3.5). Three.js requests EXT_color_buffer_float on its own, but
// nothing verified that the G-buffer's mixed-format MRT is actually complete:
// a device without float colour attachments rendered a black frame instead of
// reaching the fatal panel. This builds the real attachment layout at 4x4,
// binds it, and asks the driver.
//
// Returns a plain report so the debug tools and the evidence records
// (chapter 07) can log what the device offered. `ok: false` means the game
// cannot render; Engine turns it into a DeferredUnsupportedError.

export const GBUFFER_ATTACHMENTS = 3 // G-buffer v2: color+class, normal+roughness, material

export class DeferredUnsupportedError extends Error {
  constructor(report) {
    super(`Deferred renderer unsupported: ${report.reasons.join('; ')}`)
    this.name = 'DeferredUnsupportedError'
    this.report = report
  }
}

function extension(gl, name) {
  try {
    return !!gl.getExtension(name)
  } catch {
    return false
  }
}

export function probeDeferredSupport(renderer) {
  const gl = typeof renderer?.getContext === 'function' ? renderer.getContext() : null
  // Headless tests and mocked renderers have no context to interrogate.
  if (!gl || typeof gl.getParameter !== 'function') {
    return { ok: true, skipped: true, reasons: [] }
  }
  const reasons = []
  const report = {
    ok: true,
    skipped: false,
    reasons,
    maxDrawBuffers: gl.getParameter(gl.MAX_DRAW_BUFFERS),
    maxColorAttachments: gl.getParameter(gl.MAX_COLOR_ATTACHMENTS),
    maxTextureUnits: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS),
    maxFragmentUniformVectors: gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS),
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    colorBufferFloat: extension(gl, 'EXT_color_buffer_float'),
    floatBlend: extension(gl, 'EXT_float_blend'),
    timerQuery: extension(gl, 'EXT_disjoint_timer_query_webgl2'),
    parallelCompile: extension(gl, 'KHR_parallel_shader_compile'),
    framebufferStatus: null,
  }
  if (report.maxDrawBuffers < GBUFFER_ATTACHMENTS || report.maxColorAttachments < GBUFFER_ATTACHMENTS) {
    reasons.push(`needs ${GBUFFER_ATTACHMENTS} draw buffers (device: ${report.maxDrawBuffers})`)
  }
  if (!report.colorBufferFloat) reasons.push('EXT_color_buffer_float unavailable')
  if (report.maxTextureUnits < 16) reasons.push(`needs 16 fragment texture units (device: ${report.maxTextureUnits})`)

  if (!reasons.length) {
    // Same descriptor as DeferredRenderer._initGBuffer: RGBA16F + RGBA8 + RGBA8
    // plus a 32-bit depth texture.
    const depthTexture = new THREE.DepthTexture(4, 4)
    depthTexture.type = THREE.UnsignedIntType
    const rt = new THREE.WebGLRenderTarget(4, 4, {
      count: GBUFFER_ATTACHMENTS,
      type: THREE.HalfFloatType,
      depthBuffer: true,
      depthTexture,
    })
    rt.textures[1].type = THREE.UnsignedByteType
    rt.textures[2].type = THREE.UnsignedByteType
    const previous = renderer.getRenderTarget?.() ?? null
    try {
      renderer.setRenderTarget(rt)
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
      report.framebufferStatus = status
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        reasons.push(`G-buffer framebuffer incomplete (0x${status.toString(16)})`)
      }
    } catch (err) {
      reasons.push(`G-buffer allocation failed: ${err?.message ?? err}`)
    } finally {
      renderer.setRenderTarget(previous)
      rt.dispose()
      depthTexture.dispose()
    }
  }
  report.ok = reasons.length === 0
  return report
}
