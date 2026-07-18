import * as THREE from 'three'
import { AmbientCueDirector } from './ambientCueDirector.js'

// Entirely procedural audio — no asset files. One shared AudioContext (owned by
// the THREE.AudioListener), gated behind the Start button to satisfy the browser
// autoplay policy. Master chain ends in a limiter so summed sources never clip.
export class AudioBus {
  constructor(camera) {
    this.listener = new THREE.AudioListener()
    camera.add(this.listener)
    this.ctx = this.listener.context
    this.started = false
    this.voices = 0
    this.tension = 0
    this._heartT = 0
    this.ambientCues = new AmbientCueDirector()
    this.volume = 0.9

    const ctx = this.ctx
    this.master = ctx.createGain()
    this.master.gain.value = 0
    this.limiter = ctx.createDynamicsCompressor()
    this.limiter.threshold.value = -6
    this.limiter.ratio.value = 12
    this.limiter.attack.value = 0.003
    this.limiter.release.value = 0.25
    this.master.connect(this.limiter)
    this.limiter.connect(ctx.destination)

    this.bedGain = ctx.createGain()
    this.humGain = ctx.createGain()
    this.droneGain = ctx.createGain()
    this.sfxGain = ctx.createGain()
    this.bedGain.gain.value = 0.2 // low HVAC background underlay
    this.humGain.gain.value = 0.5
    this.droneGain.gain.value = 0.0
    this.sfxGain.gain.value = 1.0
    // The hum is the sound of the fluorescent lights, so it routes through a
    // proximity multiplier (silent until the player is near a lit lamp) before
    // reaching the master — see setHumProximity. The flicker LFO and
    // flickerDrop keep writing humGain directly; they're just scaled by this.
    this.humProx = ctx.createGain()
    this.humProx.gain.value = 0
    this.humProx.connect(this.master)
    this.humGain.connect(this.humProx)
    for (const g of [this.bedGain, this.droneGain, this.sfxGain])
      g.connect(this.master)
  }

  _noise(seconds, type) {
    const ctx = this.ctx
    const len = Math.floor(ctx.sampleRate * seconds)
    const buf = ctx.createBuffer(1, len, ctx.sampleRate)
    const d = buf.getChannelData(0)
    if (type === 'brown') {
      let last = 0
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1
        last = (last + 0.02 * w) / 1.02
        d[i] = last * 3.2
      }
    } else {
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
    }
    return buf
  }

  async start() {
    if (this.started) return
    const ctx = this.ctx
    try {
      await ctx.resume()
    } catch {
      /* ignore */
    }
    this.whiteBuf = this._noise(1.0, 'white')

    // HVAC brown-noise rumble bed.
    const brown = this._noise(3.0, 'brown')
    const bedSrc = ctx.createBufferSource()
    bedSrc.buffer = brown
    bedSrc.loop = true
    const bedLP = ctx.createBiquadFilter()
    bedLP.type = 'lowpass'
    bedLP.frequency.value = 320
    bedSrc.connect(bedLP)
    bedLP.connect(this.bedGain)
    bedSrc.start()

    // Signature fluorescent hum: mains harmonics + filtered fizz + flicker LFO.
    const freqs = [120, 240, 360, 480]
    const amps = [0.5, 0.28, 0.16, 0.09]
    const humSum = ctx.createGain()
    humSum.gain.value = 0.12
    freqs.forEach((f, i) => {
      const o = ctx.createOscillator()
      o.type = i === 0 ? 'sawtooth' : 'sine'
      o.frequency.value = f
      const g = ctx.createGain()
      g.gain.value = amps[i]
      o.connect(g)
      g.connect(humSum)
      o.start()
    })
    const fizzSrc = ctx.createBufferSource()
    fizzSrc.buffer = this.whiteBuf
    fizzSrc.loop = true
    const fizzBP = ctx.createBiquadFilter()
    fizzBP.type = 'bandpass'
    fizzBP.frequency.value = 2600
    fizzBP.Q.value = 6
    const fizzG = ctx.createGain()
    fizzG.gain.value = 0.06
    fizzSrc.connect(fizzBP)
    fizzBP.connect(fizzG)
    fizzG.connect(humSum)
    fizzSrc.start()
    // flicker LFO on hum amplitude
    const lfo = ctx.createOscillator()
    lfo.frequency.value = 0.15
    const lfoG = ctx.createGain()
    lfoG.gain.value = 0.03
    lfo.connect(lfoG)
    lfoG.connect(this.humGain.gain)
    lfo.start()
    humSum.connect(this.humGain)

    // Liminal drone: detuned low sines + slow detune drift (rises with tension).
    const dronePair = [55, 82.4]
    dronePair.forEach((f) => {
      const o = ctx.createOscillator()
      o.type = 'sine'
      o.frequency.value = f
      const drift = ctx.createOscillator()
      drift.frequency.value = 0.05
      const driftG = ctx.createGain()
      driftG.gain.value = 1.5
      drift.connect(driftG)
      driftG.connect(o.detune)
      o.connect(this.droneGain)
      o.start()
      drift.start()
    })

    this.master.gain.setValueAtTime(0, ctx.currentTime)
    this.master.gain.linearRampToValueAtTime(this.volume, ctx.currentTime + 1.5)
    this.started = true
  }

  setVolume(v) {
    this.volume = v
    if (this.started) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.1)
  }

  setTension(t) {
    this.tension = t
    if (!this.started) return
    this.droneGain.gain.setTargetAtTime(0.12 + t * 0.5, this.ctx.currentTime, 0.4)
  }

  resetLevel(worldSeed) {
    this.ambientCues.reset(worldSeed)
    this._heartT = 0
  }

  // Scales the fluorescent hum by how close the player is to a lit lamp:
  // 0 = far (hum silent), 1 = directly under a lamp. Ramped so walking past
  // lights fades smoothly without pops.
  setHumProximity(prox) {
    if (!this.started) return
    this.humProx.gain.setTargetAtTime(prox, this.ctx.currentTime, 0.25)
  }

  // Brief hum dip synced to a visual dead-tube flicker.
  flickerDrop() {
    if (!this.started) return
    const t = this.ctx.currentTime
    this.humGain.gain.cancelScheduledValues(t)
    this.humGain.gain.setValueAtTime(0.5, t)
    this.humGain.gain.linearRampToValueAtTime(0.08, t + 0.03)
    this.humGain.gain.linearRampToValueAtTime(0.5, t + 0.22)
  }

  footstep(speed = 0) {
    if (!this.started || this.voices >= 14) return
    const ctx = this.ctx
    const src = ctx.createBufferSource()
    src.buffer = this.whiteBuf
    src.loop = true
    src.playbackRate.value = 0.8 + Math.random() * 0.3
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = 850 + Math.random() * 300
    bp.Q.value = 0.7
    const g = ctx.createGain()
    src.connect(bp)
    bp.connect(g)
    g.connect(this.sfxGain)
    const t = ctx.currentTime
    const vol = 0.1 * Math.min(1.5, 0.7 + speed * 0.05)
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(vol, t + 0.005)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12)
    src.start(t)
    src.stop(t + 0.15)
    this.voices++
    src.onended = () => {
      this.voices--
      src.disconnect()
      bp.disconnect()
      g.disconnect()
    }
  }

  // A nearby entity's footfall (v8). `muffled` renders it through a slab —
  // lowpassed, heavier and softer: the "something is on the stairs above you"
  // cue when the Pursuer closes in from another floor.
  entityThump(vol = 0.06, muffled = false) {
    if (!this.started || this.voices >= 14) return
    const ctx = this.ctx
    const src = ctx.createBufferSource()
    src.buffer = this.whiteBuf
    src.loop = true
    src.playbackRate.value = 0.35 + Math.random() * 0.15 // heavier than a footstep
    const f = ctx.createBiquadFilter()
    if (muffled) {
      f.type = 'lowpass'
      f.frequency.value = 260 + Math.random() * 80
      f.Q.value = 0.5
    } else {
      f.type = 'bandpass'
      f.frequency.value = 480 + Math.random() * 160
      f.Q.value = 0.8
    }
    const g = ctx.createGain()
    src.connect(f)
    f.connect(g)
    g.connect(this.sfxGain)
    const t = ctx.currentTime
    const v = muffled ? vol * 0.7 : vol
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(v, t + 0.008)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18)
    src.start(t)
    src.stop(t + 0.22)
    this.voices++
    src.onended = () => {
      this.voices--
      src.disconnect()
      f.disconnect()
      g.disconnect()
    }
  }

  _distantEvent() {
    if (!this.started) return
    const ctx = this.ctx
    const src = ctx.createBufferSource()
    src.buffer = this.whiteBuf
    src.loop = true
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 380
    const g = ctx.createGain()
    src.connect(lp)
    lp.connect(g)
    g.connect(this.sfxGain)
    const t = ctx.currentTime
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(0.06, t + 0.05)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6)
    src.start(t)
    src.stop(t + 0.7)
    src.onended = () => {
      src.disconnect()
      lp.disconnect()
      g.disconnect()
    }
  }

  _heartbeat() {
    const ctx = this.ctx
    const t = ctx.currentTime
    const thump = (at, f) => {
      const o = ctx.createOscillator()
      o.type = 'sine'
      o.frequency.value = f
      const g = ctx.createGain()
      o.connect(g)
      g.connect(this.sfxGain)
      g.gain.setValueAtTime(0.0001, at)
      g.gain.linearRampToValueAtTime(0.16 * this.tension, at + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.18)
      o.start(at)
      o.stop(at + 0.2)
      o.onended = () => {
        o.disconnect()
        g.disconnect()
      }
    }
    thump(t, 60)
    thump(t + 0.16, 48)
  }

  update(dt, context = {}) {
    if (!this.started) return
    // Ambient fake-outs are deterministic and calm-gated. Real danger and a
    // genuine cross-floor footfall get an uncluttered recovery window instead
    // of competing with an unrelated random noise.
    const cue = this.ambientCues.update(dt, {
      ...context,
      tension: this.tension,
    })
    if (cue === 'distant') this._distantEvent()
    // Heartbeat rate scales with tension
    if (this.tension > 0.25) {
      this._heartT -= dt
      if (this._heartT <= 0) {
        this._heartbeat()
        this._heartT = 1.1 - this.tension * 0.6
      }
    }
  }
}
