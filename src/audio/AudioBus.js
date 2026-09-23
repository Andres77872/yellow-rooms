import * as THREE from 'three'
import { AmbientCueDirector } from './ambientCueDirector.js'
import {
  MAP_FAMILY_HOTEL,
  MAP_FAMILY_LATTICE,
  MAP_FAMILY_OFFICE,
  MAP_FAMILY_SEWER,
  MAP_FAMILY_TOWER,
} from '../world/mapTypes.js'
import {
  SURFACE_CARPET,
  SURFACE_CONCRETE,
  SURFACE_DECK,
  SURFACE_TILE,
} from '../world/stepSurface.js'

// Entirely procedural audio — no asset files. One shared AudioContext (owned by
// the THREE.AudioListener), gated behind the Start button to satisfy the browser
// autoplay policy.
//
// Mix philosophy: the building should sound EMPTY, not loud. Everything is
// built from pink (−3 dB/oct) rather than white noise, so no layer carries the
// raw hiss that used to sit on top of the mix; the hum is sine harmonics, not a
// full-band sawtooth; and the master chain rolls off the top octave ahead of a
// high-threshold safety limiter.
//
// Every one-shot draws from a shared voice budget; a saturated frame silently
// drops the extra layers instead of stacking toward the limiter.
const MAX_VOICES = 20

// A suspended/interrupted context freezes currentTime, so scheduled one-shots
// never end and their budget slots never return. Skip new one-shots until the
// context runs again (start() re-resumes it from the next user gesture).
const STALLED_STATES = new Set(['suspended', 'interrupted', 'closed'])

// Resting level of the fluorescent-hum gain; flickerDrop dips from and returns
// to it (the flicker LFO rides on top).
const HUM_LEVEL = 0.5

// The stereo room-tone pair loops two pink buffers of different, non-integer
// lengths: the channels never re-align, so neither the loop period nor a
// centred phantom image is ever audible.
const ROOM_TONE_SECONDS = [4.3, 5.1]

// RMS of every pink buffer (white noise in [-1, 1] sits at 0.577).
const PINK_RMS = 0.25

// Seconds for the ambience to glide into a new family's space. Level
// boundaries already sit under a fade, so the crossfade is never exposed.
const FAMILY_GLIDE = 1.2

// Per-family acoustics and ambience.
//   decay/wet/tone/damp: convolution reverb on the SFX bus. `damp` darkens the
//     tail over time (0 = bright to the end, 1 = only lows survive) — carpet
//     and soft furnishings swallow highs fast, tunnels keep them longer.
//   hum: scale on the fluorescent hum under lamps (tungsten hotel lamps and
//     sodium cages buzz less than office tubes).
//   bed: continuous room tone — `rumble` (lowpassed HVAC/structure), `air`
//     (a band of moving air that slowly breathes), `wind` (tower shafts /
//     lattice voids), `water` (sewer flow).
//   pad: a barely-there tonal bed (three soft voices through a slow lowpass).
//     Open fifths for the "calm, wrong" liminal rooms, a close cluster for the
//     sewer, a tritone for the steel lattice. Tension thins it out.
//   oneShot/interval: the family's texture sound. Atmosphere only — threat
//     pacing stays with the cue director.
const FAMILY_SPACES = Object.freeze({
  [MAP_FAMILY_OFFICE]: {
    decay: 0.55, wet: 0.08, tone: 2400, damp: 0.75, hum: 1, oneShot: null,
    bed: { rumble: 0.12, rumbleLP: 240, air: 0.03, airF: 650, wind: 0, water: 0 },
    pad: { freqs: [110, 164.81, 246.94], gain: 0.016, lp: 520 },
  },
  [MAP_FAMILY_HOTEL]: {
    decay: 0.6, wet: 0.08, tone: 2000, damp: 0.85, hum: 0.55, oneShot: null,
    bed: { rumble: 0.1, rumbleLP: 200, air: 0.022, airF: 480, wind: 0, water: 0 },
    pad: { freqs: [98, 146.83, 233.08], gain: 0.017, lp: 460 },
  },
  [MAP_FAMILY_TOWER]: {
    decay: 1.3, wet: 0.16, tone: 3200, damp: 0.5, hum: 0.7, oneShot: 'wind', interval: [18, 38],
    bed: { rumble: 0.07, rumbleLP: 220, air: 0.018, airF: 900, wind: 0.06, water: 0 },
    pad: { freqs: [130.81, 196, 293.66], gain: 0.014, lp: 760 },
  },
  [MAP_FAMILY_SEWER]: {
    decay: 2.2, wet: 0.22, tone: 1500, damp: 0.6, hum: 0.8, oneShot: 'drip', interval: [3, 10],
    bed: { rumble: 0.13, rumbleLP: 170, air: 0.01, airF: 600, wind: 0, water: 0.04 },
    pad: { freqs: [73.42, 77.78, 110], gain: 0.018, lp: 340 },
  },
  [MAP_FAMILY_LATTICE]: {
    decay: 1.5, wet: 0.15, tone: 2300, damp: 0.55, hum: 0.6, oneShot: 'creak', interval: [14, 32],
    bed: { rumble: 0.11, rumbleLP: 190, air: 0.016, airF: 1100, wind: 0.03, water: 0 },
    pad: { freqs: [87.31, 123.47, 185], gain: 0.015, lp: 580 },
  },
})

// Relative level and detune depth (cents) of the three pad voices.
const PAD_VOICE_GAIN = [1, 0.7, 0.45]
const PAD_DETUNE_CENTS = [4, -3, 6]

export class AudioBus {
  constructor(camera) {
    this.listener = new THREE.AudioListener()
    camera.add(this.listener)
    this.ctx = this.listener.context
    this.started = false
    this._disposed = false
    this._nodes = new Set()
    this.voices = 0
    this.tension = 0
    this._heartT = 0
    this._ambT = Infinity
    this._stepSide = 1
    this.ambientCues = new AmbientCueDirector()
    this.volume = 0.9
    this._muted = false
    this.family = MAP_FAMILY_OFFICE
    this.whiteBuf = null
    this.pinkBuf = null
    this._padOsc = []

    const ctx = this.ctx
    const biquad = (type, freq, q) => {
      const f = this._node(ctx.createBiquadFilter())
      f.type = type
      f.frequency.value = freq
      if (q !== undefined) f.Q.value = q
      return f
    }
    const gain = (value) => {
      const g = this._node(ctx.createGain())
      g.gain.value = value
      return g
    }

    // Master: volume → sub/DC guard → top-octave shelf → safety limiter.
    this.master = gain(0)
    // Sub-rumble/DC guard: the room tone and low stingers otherwise eat
    // headroom below anything a speaker reproduces.
    this.masterHP = biquad('highpass', 28)
    // Nothing in a quiet building lives above ~7 kHz except hiss; a gentle
    // shelf there takes the fizz off every layer at once.
    this.airShelf = biquad('highshelf', 6500)
    this.airShelf.gain.value = -6
    // Safety limiter only. A DynamicsCompressorNode applies automatic makeup
    // gain of 0.6x its full-scale reduction, so a low threshold would LIFT the
    // whole quiet mix (the old -6 dB / 12:1 setting added ~3 dB to every room
    // tone). A high threshold keeps the makeup near 1 dB and only catches overs.
    this.limiter = this._node(ctx.createDynamicsCompressor())
    this.limiter.threshold.value = -2
    this.limiter.knee.value = 0
    this.limiter.ratio.value = 20
    this.limiter.attack.value = 0.002
    this.limiter.release.value = 0.2
    this.master.connect(this.masterHP)
    this.masterHP.connect(this.airShelf)
    this.airShelf.connect(this.limiter)
    this.limiter.connect(ctx.destination)

    // Continuous beds. Topology is static (built here); start() only attaches
    // the sources, and _applySpace retargets levels/filters per family.
    this.bedGain = gain(1)
    this.roomBus = gain(1) // the stereo pink pair lands here and fans out
    this.rumbleLP = biquad('lowpass', 240, 0.5)
    this.rumbleGain = gain(0)
    this.airBP = biquad('bandpass', 650, 0.6)
    this.airMod = gain(1) // breathing LFO rides this
    this.airGain = gain(0)
    this.windBP = biquad('bandpass', 480, 1.6)
    this.windMod = gain(1)
    this.windGain = gain(0)
    this.waterBP = biquad('bandpass', 1500, 0.9)
    this.waterGain = gain(0)
    this.roomBus.connect(this.rumbleLP)
    this.rumbleLP.connect(this.rumbleGain)
    this.rumbleGain.connect(this.bedGain)
    this.roomBus.connect(this.airBP)
    this.airBP.connect(this.airMod)
    this.airMod.connect(this.airGain)
    this.airGain.connect(this.bedGain)
    this.roomBus.connect(this.windBP)
    this.windBP.connect(this.windMod)
    this.windMod.connect(this.windGain)
    this.windGain.connect(this.bedGain)
    this.roomBus.connect(this.waterBP)
    this.waterBP.connect(this.waterGain)
    this.waterGain.connect(this.bedGain)
    this.bedGain.connect(this.master)

    this.humGain = gain(HUM_LEVEL)
    // The hum is the sound of the fluorescent lights, so it routes through a
    // proximity multiplier (silent until the player is near a lit lamp) before
    // reaching the master — see setHumProximity. The flicker LFO and
    // flickerDrop keep writing humGain directly; they're just scaled by this.
    this.humProx = gain(0)
    this.humGain.connect(this.humProx)
    this.humProx.connect(this.master)

    // Sub drone: only really present under tension. Lowpassed so its
    // oscillators never add upper partials to the room.
    this.droneGain = gain(0)
    this.droneLP = biquad('lowpass', 160, 0.5)
    this.droneGain.connect(this.droneLP)
    this.droneLP.connect(this.master)

    this.padLP = biquad('lowpass', 520, 0.4)
    this.padGain = gain(0)
    this.padLP.connect(this.padGain)
    this.padGain.connect(this.master)

    this.sfxGain = gain(1)
    this.sfxGain.connect(this.master)

    // Convolution reverb on the SFX bus only (footsteps, thumps, stingers,
    // distant events). The beds are already "the room"; sending them too would
    // wash the mix. The impulse is regenerated per family — see _applySpace.
    this.convolver = this._node(ctx.createConvolver())
    this.revTone = biquad('lowpass', 2400)
    this.revWet = gain(0)
    this.sfxGain.connect(this.convolver)
    this.convolver.connect(this.revTone)
    this.revTone.connect(this.revWet)
    this.revWet.connect(this.master)
  }

  _node(node) {
    this._nodes.add(node)
    return node
  }

  dispose() {
    if (this._disposed) return
    this._disposed = true
    this.started = false
    // Three shares its AudioContext across listeners. Stop only this bus's
    // sources; closing the context would break a replacement engine's audio.
    for (const node of this._nodes) {
      node.onended = null
      if (typeof node.stop === 'function') {
        try {
          node.stop()
        } catch {
          /* a scheduled one-shot may already have ended */
        }
      }
      node.disconnect()
    }
    this._nodes.clear()
    this._padOsc = []
    this.voices = 0
    this.whiteBuf = null
    this.pinkBuf = null
    this.convolver.buffer = null
    this.listener.gain.disconnect()
    this.listener.removeFromParent()
  }

  // Seamlessly looping mono noise. `type`: 'white', 'pink' (Kellet's
  // economy filter, −3 dB/oct) or 'brown'. The buffer's head is crossfaded
  // with a continuation of its tail, so the loop point has no step — a
  // correlated (pink/brown) loop otherwise clicks once per period.
  _noise(seconds, type) {
    const ctx = this.ctx
    const len = Math.max(2, Math.floor(ctx.sampleRate * seconds))
    const fade = Math.min(len >> 1, Math.floor(ctx.sampleRate * 0.05))
    const raw = new Float32Array(len + fade)
    if (type === 'pink') {
      let b0 = 0, b1 = 0, b2 = 0, energy = 0
      for (let i = 0; i < raw.length; i++) {
        const w = Math.random() * 2 - 1
        b0 = 0.99765 * b0 + w * 0.099046
        b1 = 0.963 * b1 + w * 0.2965164
        b2 = 0.57 * b2 + w * 1.0526913
        raw[i] = b0 + b1 + b2 + w * 0.1848
        energy += raw[i] * raw[i]
      }
      // Normalise to a fixed RMS so every pink layer's level is deterministic.
      const scale = PINK_RMS / Math.sqrt(energy / raw.length || 1)
      for (let i = 0; i < raw.length; i++) raw[i] *= scale
    } else if (type === 'brown') {
      let last = 0
      for (let i = 0; i < raw.length; i++) {
        last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02
        raw[i] = last * 3.2
      }
    } else {
      for (let i = 0; i < raw.length; i++) raw[i] = Math.random() * 2 - 1
    }
    const buf = ctx.createBuffer(1, len, ctx.sampleRate)
    const d = buf.getChannelData(0)
    for (let i = 0; i < len; i++) d[i] = raw[i]
    // Equal-power blend: sample len-1 is followed by raw[len] (its true
    // continuation), which fades back into the untouched head by `fade`.
    for (let i = 0; i < fade; i++) {
      const t = (i + 0.5) / fade
      d[i] = raw[len + i] * Math.cos(t * Math.PI * 0.5) + raw[i] * Math.sin(t * Math.PI * 0.5)
    }
    return buf
  }

  // Stereo impulse response: ~12 ms pre-delay, a few sparse early
  // reflections, then an exponentially decaying (−60 dB at `seconds`) noise
  // tail whose one-pole lowpass closes over time — highs die first, the way
  // air and soft surfaces absorb them. The old flat white tail was pure hiss.
  _impulse(seconds, damp = 0.7) {
    const ctx = this.ctx
    const sr = ctx.sampleRate
    const pre = Math.floor(sr * 0.012)
    const n = Math.max(1, Math.floor(sr * seconds))
    const buf = ctx.createBuffer(2, pre + n, sr)
    const aStart = 0.9
    const aEnd = Math.max(0.04, aStart - 0.86 * Math.min(1, Math.max(0, damp)))
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch)
      let lp = 0
      for (let i = 0; i < n; i++) {
        const k = i / n
        lp += (aStart + (aEnd - aStart) * k) * ((Math.random() * 2 - 1) - lp)
        d[pre + i] = lp * Math.exp(-6.9 * k)
      }
      // Early reflections: decorrelated per channel, inside the first ~45 ms.
      for (let r = 0; r < 6; r++) {
        const at = pre + Math.floor(sr * (0.004 + Math.random() * 0.04))
        if (at < d.length) d[at] += (ch === r % 2 ? 0.6 : -0.45) * (1 - r / 8)
      }
    }
    return buf
  }

  get _space() {
    return FAMILY_SPACES[this.family] ?? FAMILY_SPACES[MAP_FAMILY_OFFICE]
  }

  _applySpace() {
    const s = this._space
    const t = this.ctx.currentTime
    this.convolver.buffer = this._impulse(s.decay, s.damp)
    this.revTone.frequency.setTargetAtTime(s.tone, t, 0.2)
    this.revWet.gain.setTargetAtTime(s.wet, t, 0.2)
    const b = s.bed
    this.rumbleLP.frequency.setTargetAtTime(b.rumbleLP, t, FAMILY_GLIDE)
    this.rumbleGain.gain.setTargetAtTime(b.rumble, t, FAMILY_GLIDE)
    this.airBP.frequency.setTargetAtTime(b.airF, t, FAMILY_GLIDE)
    this.airGain.gain.setTargetAtTime(b.air, t, FAMILY_GLIDE)
    this.windGain.gain.setTargetAtTime(b.wind, t, FAMILY_GLIDE)
    this.waterGain.gain.setTargetAtTime(b.water, t, FAMILY_GLIDE)
    this._padOsc.forEach((o, i) => o.frequency.setTargetAtTime(s.pad.freqs[i], t, FAMILY_GLIDE))
    this._applyPad(FAMILY_GLIDE)
  }

  // The pad thins and darkens as tension rises: the calm "wrong" chord
  // recedes and the sub drone takes over.
  _applyPad(timeConstant) {
    const p = this._space.pad
    const t = this.ctx.currentTime
    this.padGain.gain.setTargetAtTime(p.gain * (1 - 0.7 * this.tension), t, timeConstant)
    this.padLP.frequency.setTargetAtTime(p.lp * (1 - 0.4 * this.tension), t, timeConstant)
  }

  _scheduleAmbient() {
    const s = this._space
    this._ambT = s.oneShot
      ? s.interval[0] + Math.random() * (s.interval[1] - s.interval[0])
      : Infinity
  }

  // A free-running LFO: `targets` pairs an AudioParam with its modulation
  // depth, so one oscillator can drive several params (opposite-signed
  // detunes, a filter sweep and its level) without extra sources.
  _lfo(freq, targets, type = 'sine') {
    const ctx = this.ctx
    const o = this._node(ctx.createOscillator())
    o.type = type
    o.frequency.value = freq
    for (const [param, depth] of targets) {
      const g = this._node(ctx.createGain())
      g.gain.value = depth
      o.connect(g)
      g.connect(param)
    }
    o.start()
    return o
  }

  // Safe to call from every gameplay entry gesture (start, resume, retry). The
  // first call builds the graph; later calls re-open a context the OS/browser
  // suspended (iOS call/app switch, autoplay throttling) — resume() must be
  // invoked synchronously inside the gesture, so it runs before any await —
  // and fade back in after a silence().
  async start() {
    if (this._disposed) return
    this._muted = false
    if (this.started) {
      if (this.ctx.state && this.ctx.state !== 'running') {
        this.ctx.resume?.()?.catch?.(() => {})
      }
      this._applyMaster(0.4)
      return
    }
    // Flag first: a second tap during the resume() await must not double-build
    // the oscillator banks (they'd sum, permanently doubling the hum).
    this.started = true
    const ctx = this.ctx
    try {
      await ctx.resume()
    } catch {
      /* ignore */
    }
    if (this._disposed) return
    this.whiteBuf = this._noise(1.0, 'white')
    this.pinkBuf = this._noise(1.3, 'pink')

    // Room tone: two decorrelated pink loops panned apart feed the rumble,
    // air, wind and water bands (per-family levels in _applySpace).
    ROOM_TONE_SECONDS.forEach((seconds, i) => {
      const src = this._node(ctx.createBufferSource())
      src.buffer = this._noise(seconds, 'pink')
      src.loop = true
      if (ctx.createStereoPanner) {
        const pan = this._node(ctx.createStereoPanner())
        pan.pan.value = i === 0 ? -0.6 : 0.6
        src.connect(pan)
        pan.connect(this.roomBus)
      } else {
        src.connect(this.roomBus)
      }
      src.start()
    })
    // The air band breathes like a distant air handler; wind gusts and
    // wanders in pitch. Periods are long and mutually prime-ish so the bed
    // never settles into an audible cycle.
    this._lfo(0.071, [[this.airMod.gain, 0.35]])
    this._lfo(0.043, [[this.windBP.frequency, 170]])
    this._lfo(0.093, [[this.windMod.gain, 0.6]], 'triangle')

    // Fluorescent hum: sine mains harmonics + a lowpassed triangle "ballast"
    // edge + a faint pink fizz, with a slow flicker LFO. The old sawtooth
    // carried every harmonic up to Nyquist — that rasp was most of the
    // "noisy" complaint, and it played under every lamp in the building.
    const humSum = this._node(ctx.createGain())
    humSum.gain.value = 0.085
    ;[[120, 0.55], [240, 0.2], [360, 0.08]].forEach(([f, a]) => {
      const o = this._node(ctx.createOscillator())
      o.type = 'sine'
      o.frequency.value = f
      const g = this._node(ctx.createGain())
      g.gain.value = a
      o.connect(g)
      g.connect(humSum)
      o.start()
    })
    const ballast = this._node(ctx.createOscillator())
    ballast.type = 'triangle'
    ballast.frequency.value = 120
    const ballastLP = this._node(ctx.createBiquadFilter())
    ballastLP.type = 'lowpass'
    ballastLP.frequency.value = 900
    const ballastG = this._node(ctx.createGain())
    ballastG.gain.value = 0.12
    ballast.connect(ballastLP)
    ballastLP.connect(ballastG)
    ballastG.connect(humSum)
    ballast.start()
    const fizzSrc = this._node(ctx.createBufferSource())
    fizzSrc.buffer = this.pinkBuf
    fizzSrc.loop = true
    const fizzBP = this._node(ctx.createBiquadFilter())
    fizzBP.type = 'bandpass'
    fizzBP.frequency.value = 3800
    fizzBP.Q.value = 1.2
    const fizzG = this._node(ctx.createGain())
    fizzG.gain.value = 0.02
    fizzSrc.connect(fizzBP)
    fizzBP.connect(fizzG)
    fizzG.connect(humSum)
    fizzSrc.start()
    this._lfo(0.15, [[this.humGain.gain, 0.03]])
    humSum.connect(this.humGain)

    // Sub drone: detuned low sines beating slowly against each other (one
    // LFO, opposite-signed detune), level driven by tension.
    const drones = [55, 82.4].map((f) => {
      const o = this._node(ctx.createOscillator())
      o.type = 'sine'
      o.frequency.value = f
      o.connect(this.droneGain)
      o.start()
      return o
    })
    this._lfo(0.05, [[drones[0].detune, 2], [drones[1].detune, -2.5]])

    // Tonal pad: three soft triangle voices through a slowly sweeping
    // lowpass. Frequencies retune per family (see FAMILY_SPACES.pad).
    this._padOsc = this._space.pad.freqs.map((f, i) => {
      const o = this._node(ctx.createOscillator())
      o.type = 'triangle'
      o.frequency.value = f
      const g = this._node(ctx.createGain())
      g.gain.value = PAD_VOICE_GAIN[i]
      o.connect(g)
      g.connect(this.padLP)
      o.start()
      return o
    })
    this._lfo(0.061, this._padOsc.map((o, i) => [o.detune, PAD_DETUNE_CENTS[i]]))
    this._lfo(0.027, [[this.padLP.frequency, 140]])

    this._applySpace()
    this.setTension(this.tension)
    this._scheduleAmbient()
    this.master.gain.setValueAtTime(0, ctx.currentTime)
    this.master.gain.linearRampToValueAtTime(this.volume, ctx.currentTime + 1.5)
  }

  setVolume(v) {
    this.volume = v
    if (this.started) this._applyMaster(0.1)
  }

  // Fade the whole mix out (title backdrop after quitting a run); the next
  // start() fades it back in at the current volume.
  silence() {
    this._muted = true
    if (this.started) this._applyMaster(0.3)
  }

  // Retarget the master gain from wherever it is now. Cancelling first matters
  // during start()'s 1.5s fade-in: a target inserted before that pending linear
  // ramp would otherwise be overridden by it, snapping back to the old volume.
  _applyMaster(timeConstant) {
    const g = this.master.gain
    const t = this.ctx.currentTime
    g.cancelScheduledValues(t)
    g.setValueAtTime(g.value, t)
    g.setTargetAtTime(this._muted ? 0 : this.volume, t, timeConstant)
  }

  _stalled() {
    return STALLED_STATES.has(this.ctx.state)
  }

  setTension(t) {
    this.tension = t
    if (!this.started) return
    // Calm rooms carry almost no sub; it swells only with real danger (the
    // old 0.12 floor + 0.5 swing was a constant rumble that pumped the limiter
    // and, at full tension, peaked above 0 dBFS).
    this.droneGain.gain.setTargetAtTime(0.015 + t * 0.2, this.ctx.currentTime, 0.5)
    this._applyPad(0.8)
  }

  resetLevel(worldSeed, family = this.family) {
    this.ambientCues.reset(worldSeed)
    this._heartT = 0
    this.setFamily(family)
  }

  // Retarget the acoustic space, ambience beds and texture one-shots to a map
  // family. Cheap (one impulse buffer + a few ramps), so it simply runs at
  // every level boundary.
  setFamily(family) {
    this.family = family
    if (this.started) this._applySpace()
    this._scheduleAmbient()
  }

  // Scales the fluorescent hum by how close the player is to a lit lamp:
  // 0 = far (hum silent), 1 = directly under a lamp. Ramped so walking past
  // lights fades smoothly without pops.
  setHumProximity(prox) {
    if (!this.started) return
    this.humProx.gain.setTargetAtTime(prox * this._space.hum, this.ctx.currentTime, 0.25)
  }

  // Brief hum sag synced to a visual dead-tube flicker. A sag, not a cut: the
  // old dip to 16% every few seconds read as a pumping artefact.
  flickerDrop() {
    if (!this.started) return
    const t = this.ctx.currentTime
    this.humGain.gain.cancelScheduledValues(t)
    this.humGain.gain.setValueAtTime(HUM_LEVEL, t)
    this.humGain.gain.linearRampToValueAtTime(HUM_LEVEL * 0.4, t + 0.04)
    this.humGain.gain.linearRampToValueAtTime(HUM_LEVEL, t + 0.26)
  }

  // Voice-budget bookkeeping shared by the one-shot helpers: one budget slot
  // per voice; when the primary source ends, the whole node chain detaches.
  _retire(primary, nodes) {
    this.voices++
    primary.onended = () => {
      this.voices--
      for (const n of nodes) {
        n.disconnect()
        this._nodes.delete(n)
      }
    }
  }

  // One enveloped noise voice through a filter chain into the SFX bus.
  // `noise`: 'pink' (default — soft, no hiss) or 'white' (only for genuinely
  // crisp transients). `filters`: [{type, freq, q}]; `at` delays the start;
  // `pan` needs StereoPannerNode (skipped where unsupported). Silently drops
  // when the voice budget is spent — layers degrade before the mix does.
  _noiseVoice({ vol, dur, attack = 0.004, rate = 1, filters = [], pan = 0, at = 0, noise = 'pink' }) {
    const buffer = noise === 'white' ? this.whiteBuf : this.pinkBuf
    if (!this.started || !buffer || this.voices >= MAX_VOICES || vol <= 0) return
    if (this._stalled()) return
    const ctx = this.ctx
    const src = this._node(ctx.createBufferSource())
    src.buffer = buffer
    src.loop = true
    src.playbackRate.value = rate
    const nodes = [src]
    let head = src
    for (const f of filters) {
      const biq = this._node(ctx.createBiquadFilter())
      biq.type = f.type
      biq.frequency.value = f.freq
      if (f.q !== undefined) biq.Q.value = f.q
      head.connect(biq)
      head = biq
      nodes.push(biq)
    }
    const g = this._node(ctx.createGain())
    head.connect(g)
    head = g
    nodes.push(g)
    if (pan && ctx.createStereoPanner) {
      const p = this._node(ctx.createStereoPanner())
      p.pan.value = Math.max(-1, Math.min(1, pan))
      head.connect(p)
      head = p
      nodes.push(p)
    }
    head.connect(this.sfxGain)
    const t = ctx.currentTime + at
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(vol, t + attack)
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + dur)
    // Random read offset: consecutive steps never replay the same grain.
    src.start(t, Math.random() * Math.max(0, (buffer.duration ?? 1) - 0.5))
    src.stop(t + attack + dur + 0.03)
    this._retire(src, nodes)
  }

  // Decaying oscillator partials — the modal ring of hard surfaces (ceramic
  // ping, catwalk clang) and the tonal stingers. `glide` multiplies each
  // frequency across `dur`; an optional `filter` shapes the summed output.
  _ringVoice({ freqs, vols, dur, type = 'sine', attack = 0.003, glide = 0, filter = null, pan = 0, at = 0 }) {
    if (!this.started || this.voices >= MAX_VOICES || this._stalled()) return
    const ctx = this.ctx
    const t = ctx.currentTime + at
    const sum = this._node(ctx.createGain())
    sum.gain.value = 1
    const nodes = [sum]
    let head = sum
    if (filter) {
      const biq = this._node(ctx.createBiquadFilter())
      biq.type = filter.type
      biq.frequency.value = filter.freq
      if (filter.q !== undefined) biq.Q.value = filter.q
      head.connect(biq)
      head = biq
      nodes.push(biq)
    }
    if (pan && ctx.createStereoPanner) {
      const p = this._node(ctx.createStereoPanner())
      p.pan.value = Math.max(-1, Math.min(1, pan))
      head.connect(p)
      head = p
      nodes.push(p)
    }
    head.connect(this.sfxGain)
    let primary = null
    freqs.forEach((f, i) => {
      const o = this._node(ctx.createOscillator())
      o.type = type
      o.frequency.setValueAtTime(f, t)
      if (glide) o.frequency.exponentialRampToValueAtTime(Math.max(1, f * glide), t + attack + dur)
      const g = this._node(ctx.createGain())
      const vol = vols[i] ?? vols[0]
      g.gain.setValueAtTime(0, t)
      g.gain.linearRampToValueAtTime(vol, t + attack)
      g.gain.exponentialRampToValueAtTime(0.0001, t + attack + dur)
      o.connect(g)
      g.connect(sum)
      o.start(t)
      o.stop(t + attack + dur + 0.05)
      nodes.push(o, g)
      if (!primary) primary = o
    })
    if (primary) this._retire(primary, nodes)
  }

  // Surface-aware footstep (see world/stepSurface.js): each material gets its
  // own procedural recipe — a soft filtered scuff on carpet, gaining a heel
  // tick, body knock and modal ring as the floor hardens. Every layer is
  // jittered, alternating feet sit a hair left/right, and the whole family is
  // pink-noise based and band-limited: footsteps are the most frequent sound
  // in the game, so they carry body, never hiss, and sit ~4 dB under the old
  // white-noise steps (against a room tone that dropped ~7 dB).
  footstep(speed = 0, surface = SURFACE_CARPET) {
    if (!this.started) return
    const loud = Math.min(1.25, 0.62 + speed * 0.04)
    const r = Math.random
    this._stepSide = -this._stepSide
    const pan = this._stepSide * 0.08
    if (surface === SURFACE_TILE) {
      // Hard ceramic: soft heel tick + short body knock + faint ping.
      this._noiseVoice({
        vol: 0.055 * loud, dur: 0.025, attack: 0.002, pan,
        filters: [{ type: 'highpass', freq: 2600 + r() * 700 }, { type: 'lowpass', freq: 7000 }],
      })
      this._noiseVoice({
        vol: 0.13 * loud, dur: 0.06, pan,
        filters: [{ type: 'bandpass', freq: 1050 + r() * 350, q: 1.3 }],
      })
      this._ringVoice({ freqs: [2200 + r() * 600], vols: [0.01 * loud], dur: 0.14, pan })
    } else if (surface === SURFACE_CONCRETE) {
      // Dense slab: dull mid thud with a dry grit tail, no ring.
      this._noiseVoice({
        vol: 0.15 * loud, dur: 0.08, pan,
        filters: [{ type: 'bandpass', freq: 300 + r() * 120, q: 0.9 }],
      })
      this._noiseVoice({
        vol: 0.045 * loud, dur: 0.12, rate: 1.1, pan,
        filters: [{ type: 'bandpass', freq: 1500 + r() * 500, q: 0.8 }, { type: 'lowpass', freq: 4000 }],
      })
    } else if (surface === SURFACE_DECK) {
      // Raised metal: low hollow boom + clank + inharmonic catwalk ring.
      this._noiseVoice({
        vol: 0.15 * loud, dur: 0.14, rate: 0.5 + r() * 0.1, pan,
        filters: [{ type: 'lowpass', freq: 230, q: 0.7 }],
      })
      this._noiseVoice({
        vol: 0.06 * loud, dur: 0.05, pan,
        filters: [{ type: 'bandpass', freq: 820 + r() * 300, q: 2 }],
      })
      const det = 0.94 + r() * 0.12
      this._ringVoice({
        freqs: [327 * det, 512 * det, 739 * det],
        vols: [0.016 * loud, 0.01 * loud, 0.0065 * loud],
        dur: 0.26, pan,
      })
    } else {
      // Carpet (default): a soft muffled scuff, all body and no edge.
      this._noiseVoice({
        vol: 0.19 * loud, dur: 0.1, attack: 0.006, rate: 0.8 + r() * 0.25, pan,
        filters: [{ type: 'bandpass', freq: 560 + r() * 180, q: 0.8 }, { type: 'lowpass', freq: 1800 }],
      })
    }
  }

  // Landing after genuine airborne time (drops through slab holes — stair
  // walking is glue-to-ground and never fires this): a weighted body thump
  // scaled by fall speed, layered over the surface's own step.
  land(impact = 0, surface = SURFACE_CARPET) {
    if (!this.started) return
    const w = Math.min(1, Math.max(0, (impact - 2.5) / 9))
    if (w <= 0) return
    this._noiseVoice({
      vol: 0.1 + 0.16 * w, dur: 0.2, attack: 0.006, rate: 0.5,
      filters: [{ type: 'lowpass', freq: 200, q: 0.8 }],
    })
    this.footstep(4 + impact, surface)
  }

  // Physical thumb-switch: a tick plus a small latch tone (higher when it
  // lands ON). Also fires when the battery dies — the light does click off.
  flashlightClick(on) {
    if (!this.started) return
    this._noiseVoice({
      vol: 0.03, dur: 0.014, attack: 0.001, noise: 'white',
      filters: [{ type: 'bandpass', freq: 3400, q: 1.1 }],
    })
    this._ringVoice({ freqs: [on ? 740 : 520], vols: [0.018], dur: 0.05, type: 'triangle' })
  }

  // Death punctuation, matched to the death you got: the void swallows you in
  // a pitch-collapsing boom + air rush; being caught/losing your mind sags a
  // dissonant low cluster into the screen static.
  deathStinger(reason = 'caught') {
    if (!this.started) return
    if (reason === 'void') {
      this._ringVoice({ freqs: [64], vols: [0.34], dur: 1.4, attack: 0.01, glide: 0.35 })
      this._noiseVoice({
        vol: 0.17, dur: 1.1, attack: 0.02,
        filters: [{ type: 'lowpass', freq: 500, q: 0.5 }],
      })
    } else {
      this._ringVoice({
        freqs: [55, 58.3, 110.5], vols: [0.14, 0.12, 0.07],
        dur: 1.7, type: 'sawtooth', attack: 0.04, glide: 0.72,
        filter: { type: 'lowpass', freq: 520, q: 0.7 },
      })
      this._noiseVoice({
        vol: 0.07, dur: 1.2, attack: 0.3,
        filters: [{ type: 'bandpass', freq: 2400, q: 0.6 }],
      })
    }
  }

  // Level complete: a brief consonant lift with a soft shimmer — deliberately
  // the only "safe"-coded sound in the game.
  exitStinger() {
    if (!this.started) return
    this._ringVoice({ freqs: [220, 331, 440], vols: [0.05, 0.035, 0.015], dur: 1.4, attack: 0.25, glide: 1.06 })
    this._noiseVoice({
      vol: 0.02, dur: 1.0, attack: 0.3,
      filters: [{ type: 'bandpass', freq: 5200, q: 0.7 }],
    })
  }

  // Ambient fake-out (paced by the cue director). Three flavors, all panned
  // off-center and mostly reverb tail, so "somewhere else in the building"
  // stays believable without ever meaning anything.
  _distantEvent() {
    if (!this.started) return
    const pick = Math.random()
    const pan = (Math.random() * 2 - 1) * 0.7
    if (pick < 0.45) {
      // Far low rumble (the original event).
      this._noiseVoice({
        vol: 0.07, dur: 0.6, attack: 0.06,
        filters: [{ type: 'lowpass', freq: 340 }], pan,
      })
    } else if (pick < 0.8) {
      // A door closing somewhere: double thud, the reverb supplies the room.
      this._noiseVoice({
        vol: 0.06, dur: 0.07,
        filters: [{ type: 'bandpass', freq: 200, q: 1.2 }], pan,
      })
      this._noiseVoice({
        vol: 0.04, dur: 0.05, at: 0.09,
        filters: [{ type: 'bandpass', freq: 250, q: 1.2 }], pan,
      })
    } else {
      // Metal groan: a slow sagging tone through a narrow band.
      this._ringVoice({
        freqs: [92], vols: [0.02], dur: 1.3, type: 'sawtooth',
        attack: 0.3, glide: 0.82,
        filter: { type: 'bandpass', freq: 280, q: 5 }, pan,
      })
    }
  }

  // Family texture one-shot (never a threat cue, so plain Math.random pacing
  // is fine): sewer drips, lattice steel settling, tower wind gusts.
  _familyOneShot() {
    const kind = this._space.oneShot
    const pan = (Math.random() * 2 - 1) * 0.8
    if (kind === 'drip') {
      // A fast downward chirp; the long sewer reverb supplies the plink tail.
      // Sometimes a second, smaller drop follows off the same ledge.
      const f = 1900 + Math.random() * 800
      this._ringVoice({ freqs: [f], vols: [0.028], dur: 0.05, glide: 0.3, pan })
      if (Math.random() < 0.35) {
        this._ringVoice({ freqs: [f * 1.18], vols: [0.014], dur: 0.04, glide: 0.3, pan, at: 0.18 + Math.random() * 0.3 })
      }
    } else if (kind === 'creak') {
      // Cooling steel: either a low settle groan or a pair of dry ticks.
      if (Math.random() < 0.5) {
        this._ringVoice({
          freqs: [70 + Math.random() * 40], vols: [0.015],
          dur: 0.7, type: 'sawtooth', attack: 0.2, glide: 0.88,
          filter: { type: 'bandpass', freq: 240, q: 4 }, pan,
        })
      } else {
        this._noiseVoice({
          vol: 0.022, dur: 0.02,
          filters: [{ type: 'bandpass', freq: 2800, q: 5 }], pan,
        })
        this._noiseVoice({
          vol: 0.015, dur: 0.02, at: 0.14 + Math.random() * 0.2,
          filters: [{ type: 'bandpass', freq: 2400, q: 5 }], pan,
        })
      }
    } else if (kind === 'wind') {
      // A slow gust across the tower shafts, over the continuous wind bed.
      this._noiseVoice({
        vol: 0.035, dur: 2.8, attack: 1.3,
        filters: [{ type: 'bandpass', freq: 380 + Math.random() * 220, q: 2.2 }], pan,
      })
    }
  }

  // A nearby entity's footfall (v8). `muffled` renders it through a slab —
  // lowpassed, heavier and softer: the "something is on the stairs above you"
  // cue when the Pursuer closes in from another floor.
  entityThump(vol = 0.06, muffled = false) {
    if (!this.started) return
    const rate = 0.35 + Math.random() * 0.15 // heavier than a footstep
    if (muffled) {
      this._noiseVoice({
        vol: vol * 0.8, dur: 0.17, attack: 0.008, rate,
        filters: [{ type: 'lowpass', freq: 240 + Math.random() * 80, q: 0.5 }],
      })
    } else {
      this._noiseVoice({
        vol, dur: 0.17, attack: 0.008, rate,
        filters: [{ type: 'bandpass', freq: 440 + Math.random() * 140, q: 0.8 }],
      })
    }
  }

  _heartbeat() {
    const ctx = this.ctx
    const t = ctx.currentTime
    // Each thump spends a voice-budget slot like every other one-shot.
    const thump = (at, f, level) => {
      if (this.voices >= MAX_VOICES || this._stalled()) return
      const o = this._node(ctx.createOscillator())
      o.type = 'sine'
      o.frequency.setValueAtTime(f * 1.25, at)
      o.frequency.exponentialRampToValueAtTime(f, at + 0.06) // chest "lub" pitch sag
      const g = this._node(ctx.createGain())
      o.connect(g)
      g.connect(this.sfxGain)
      g.gain.setValueAtTime(0.0001, at)
      g.gain.linearRampToValueAtTime(level * this.tension, at + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.18)
      o.start(at)
      o.stop(at + 0.2)
      this._retire(o, [o, g])
    }
    thump(t, 60, 0.13)
    thump(t + 0.16, 48, 0.1)
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
    // Family texture (drips/creaks/gusts) runs on its own clock; it is scenery,
    // so unlike the fake-outs it doesn't pause for danger.
    this._ambT -= dt
    if (this._ambT <= 0) {
      this._familyOneShot()
      this._scheduleAmbient()
    }
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
