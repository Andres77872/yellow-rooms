const lerp = (a, b, t) => a + (b - a) * t

// Accumulates a bob phase only while moving on the ground; the offset is applied
// to the camera AFTER collision (never to the collider). Amplitude eases to 0
// when idle. A motion-sickness toggle can hold amp at 0.
export class HeadBob {
  constructor() {
    this.t = 0
    this.amp = 0
    this.enabled = true
    // CAMERA FX polish: reshaped bob curve + sway roll. Off must reproduce the
    // plain-sine bob exactly, so the fx branch never touches the base path.
    this.fx = true
  }

  update(dt, speed, moving) {
    if (moving) {
      // Phase always advances with the stride — footstep timing hangs off the
      // sign-crossing (Controller.applyFrame), so the motion-sickness toggle
      // must only zero the AMPLITUDE, never silence the footsteps.
      this.t += dt * (4 + speed * 0.9)
      this.amp = lerp(this.amp, this.enabled ? 1 : 0, dt * 8)
    } else {
      this.amp = lerp(this.amp, 0, dt * 8)
    }
  }

  get bobY() {
    // fx: a second harmonic softens the crest (+0.043) and deepens the trough
    // (-0.067) — same excursion as the plain sine, weight biased into the
    // down-step. Footstep timing reads `phase` (the plain sine), never bobY,
    // so reshaping the curve cannot shift the step cue.
    if (this.fx) return (Math.sin(this.t) + 0.22 * Math.cos(2 * this.t)) * 0.055 * this.amp
    return Math.sin(this.t) * 0.065 * this.amp
  }
  get bobX() {
    return Math.cos(this.t * 0.5) * 0.045 * this.amp
  }
  // Sway roll at half stride frequency, 90° out of phase with bobX so the tilt
  // peaks as the lateral sway passes center — reads as weight transfer. Scales
  // with amp, so the bob toggle silences it too.
  get bobRoll() {
    return this.fx ? Math.sin(this.t * 0.5) * 0.012 * this.amp : 0
  }
  // Sine phase, used to time footsteps on each downstep.
  get phase() {
    return Math.sin(this.t)
  }
}
