// Pure virtual-joystick math (no DOM) so it stays unit-testable in node.

// Map a drag offset from the stick base (screen px, +y down) to a movement
// vector in the controller's input space: x = strafe (+right), z = forward
// (+forward, i.e. screen-up), both in [-1, 1] with the pair clamped to the
// unit circle. `mag` is the post-clamp deflection (0..1), used for the sprint
// gate and for positioning the nub.
export function stickVector(dx, dy, radius, deadzone = 0.15) {
  let x = dx / radius
  let z = -dy / radius // screen up = forward
  const len = Math.hypot(x, z)
  if (len <= deadzone) return { x: 0, z: 0, mag: 0 }
  if (len > 1) {
    x /= len
    z /= len
    return { x, z, mag: 1 }
  }
  return { x, z, mag: len }
}

// Sprint engages when the stick is pushed to the rim and releases only after
// pulling clearly back — hysteresis stops jitter right at the threshold.
export function sprintGate(prevSprint, mag, engage = 0.95, release = 0.85) {
  if (prevSprint) return mag >= release
  return mag >= engage
}
