// Tuning export for the debug light tab: serialize the live uniform values
// into a plain "label: value" text block so a tuned look can travel back into
// world/constants.js (or a bug report) via the clipboard. formatTuning is pure
// and unit-tested; copyText is the tiny DOM shim with a legacy fallback.

// entries: [{ label: string, value: number | string }]
export function formatTuning(entries) {
  return entries
    .map(({ label, value }) => {
      // Trim float noise (0.30000000000000004 -> 0.3), keep 4 decimals max.
      const v = typeof value === 'number' ? +value.toFixed(4) : value
      return `${label}: ${v}`
    })
    .join('\n')
}

// Returns true when the text landed on the clipboard.
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Non-secure context / denied permission: hidden-textarea fallback.
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;'
    document.body.appendChild(ta)
    ta.select()
    let ok = false
    try {
      ok = document.execCommand('copy')
    } catch {
      ok = false
    }
    ta.remove()
    return ok
  }
}
