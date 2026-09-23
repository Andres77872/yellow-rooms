// Global game hotkeys (M, Esc-resume, backtick, F) must stay inert while the
// player is typing a seed or operating a settings control.
const EDITABLE_TAGS = /^(INPUT|TEXTAREA|SELECT)$/

export function isEditableFocused() {
  return EDITABLE_TAGS.test(globalThis.document?.activeElement?.tagName ?? '')
}
