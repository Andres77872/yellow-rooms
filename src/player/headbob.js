const lerp = (a, b, t) => a + (b - a) * t

// Accumulates a bob phase only while moving on the ground; the offset is applied
// to the camera AFTER collision (never to the collider). Amplitude eases to 0
// when idle. A motion-sickness toggle can hold amp at 0.
export class HeadBob {
  constructor() {
    this.t = 0
    this.amp = 0
    this.enabled = true
  }

  update(dt, speed, moving) {
    if (moving && this.enabled) {
      this.t += dt * (4 + speed * 0.9)
      this.amp = lerp(this.amp, 1, dt * 8)
    } else {
      this.amp = lerp(this.amp, 0, dt * 8)
    }
  }

  get bobY() {
    return Math.sin(this.t) * 0.065 * this.amp
  }
  get bobX() {
    return Math.cos(this.t * 0.5) * 0.045 * this.amp
  }
  // Sine phase, used to time footsteps on each downstep.
  get phase() {
    return Math.sin(this.t)
  }
}
