// Device-tier detection. Touch mode keys off the PRIMARY pointer (pointer:
// coarse) so hybrid laptops with touchscreens stay in desktop mode; ?touch=1 /
// ?touch=0 overrides for debugging and for hybrids that want the touch UI.
// Guarded so node (vitest) can import anything that imports this module.
const hasDOM = typeof window !== 'undefined' && typeof matchMedia === 'function'
const override = hasDOM ? new URLSearchParams(location.search).get('touch') : null

export const IS_TOUCH = override != null
  ? override !== '0'
  : hasDOM && matchMedia('(pointer: coarse)').matches

// Phones ship DPR 3; clamping to 1.5 cuts fill-rate ~4x vs native there.
export const MAX_DPR = IS_TOUCH ? 1.5 : 2

// Shader step/sample counts are no longer a compile-time device tier: they are
// runtime uniforms driven by the graphics settings (core/graphics.js), which
// picks its DEFAULT_PRESET off IS_TOUCH instead.

// Best-effort fullscreen + landscape lock. Must be called synchronously inside
// a user gesture (alongside the WebAudio unlock — neither may be awaited
// first). Android Chrome grants both; iOS Safari has neither API on iPhone, so
// the portrait "rotate device" overlay is the enforcement path there.
export function enterImmersive() {
  const el = document.documentElement
  let fs
  try {
    fs = el.requestFullscreen?.({ navigationUI: 'hide' })
  } catch {
    /* ignore (older engines throw instead of rejecting) */
  }
  if (fs?.then) {
    fs.then(() => screen.orientation?.lock?.('landscape')).catch(() => {})
  }
}
