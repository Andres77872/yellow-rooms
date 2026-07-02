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

// Per-tier shader loop sizes, baked into GLSL as #defines at import time.
// Desktop values MUST mirror world/constants.js so desktop shaders compile to
// the exact same source as before this tier existed.
export const QUALITY = IS_TOUCH
  ? { aoSamples: 8, shadowSteps: 12, volSteps: 16 }
  : { aoSamples: 16, shadowSteps: 20, volSteps: 32 }

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
