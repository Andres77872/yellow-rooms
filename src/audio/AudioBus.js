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
// autoplay policy. Master chain ends in a limiter so summed sources never clip.
//
// Every one-shot draws from a shared voice budget; a saturated frame silently
// drops the extra layers instead of stacking toward the limiter.
const MAX_VOICES = 24

// Per-family acoustics. `decay`/`wet`/`tone` shape the convolution reverb the
// SFX bus feeds (office is a dry carpeted room, the sewer a long wet tunnel);
// `oneShot` names the family's texture sound, fired every `interval` seconds.
// These are atmosphere only — threat pacing stays with the cue director.
const FAMILY_SPACES = Object.freeze({
  [MAP_FAMILY_OFFICE]: { decay: 0.5, wet: 0.09, tone: 2600, oneShot: null },
  [MAP_FAMILY_HOTEL]: { decay: 0.6, wet: 0.1, tone: 2200, oneShot: null },
  [MAP_FAMILY_TOWER]: { decay: 1.3, wet: 0.2, tone: 3400, oneShot: 'wind', interval: [16, 34] },
  [MAP_FAMILY_SEWER]: { decay: 2.3, wet: 0.28, tone: 1400, oneShot: 'drip', interval: [3, 10] },
  [MAP_FAMILY_LATTICE]: { decay: 1.5, wet: 0.18, tone: 2400, oneShot: 'creak', interval: [14, 32] },
})

export class AudioBus {
  constructor(camera) {
    this.listener = new THREE.AudioListener()
    camera.add(this.listener)
    this.ctx = this.listener.context
    this.started = false
    this.voices = 0
    this.tension = 0
    this._heartT = 0
    this._ambT = Infinity
    this.ambientCues = new AmbientCueDirector()
    this.volume = 0.9
    this.family = MAP_FAMILY_OFFICE

    const ctx = this.ctx
    this.master = ctx.createGain()
    this.master.gain.value = 0
    // Sub-rumble/DC guard ahead of the limiter: the brown bed and the low
    // stingers otherwise eat headroom below anything a speaker reproduces.
    this.masterHP = ctx.createBiquadFilter()
    this.masterHP.type = 'highpass'
    this.masterHP.frequency.value = 28
    this.limiter = ctx.createDynamicsCompressor()
    this.limiter.threshold.value = -6
    this.limiter.ratio.value = 12
    this.limiter.attack.value = 0.003
    this.limiter.release.value = 0.25
    this.master.connect(this.masterHP)
    this.masterHP.connect(this.limiter)
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

    // Convolution reverb on the SFX bus only (footsteps, thumps, stingers,
    // distant events). The beds are already "the room"; sending them too would
    // wash the mix. The impulse is regenerated per family — see _applySpace.
    this.convolver = ctx.createConvolver()
    this.revTone = ctx.createBiquadFilter()
    this.revTone.type = 'lowpass'
    this.revTone.frequency.value = 2600
    this.revWet = ctx.createGain()
    this.revWet.gain.value = 0
    this.sfxGain.connect(this.convolver)
    this.convolver.connect(this.revTone)
    this.revTone.connect(this.revWet)
    this.revWet.connect(this.master)
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

  // Stereo exponentially-decaying noise (−60 dB at `seconds`): the whole
  // impulse response. Decorrelated channels give the tail its width.
  _impulse(seconds) {
    const ctx = this.ctx
    const len = Math.max(1, Math.floor(ctx.sampleRate * seconds))
    const buf = ctx.createBuffer(2, len, ctx.sampleRate)
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch)
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.exp((-6.9 * i) / len)
      }
    }
    return buf
  }

  get _space() {
    return FAMILY_SPACES[this.family] ?? FAMILY_SPACES[MAP_FAMILY_OFFICE]
  }

  _applySpace() {
    const s = this._space
    this.convolver.buffer = this._impulse(s.decay)
    this.revTone.frequency.value = s.tone
    this.revWet.gain.setTargetAtTime(s.wet, this.ctx.currentTime, 0.2)
  }

  _scheduleAmbient() {
    const s = this._space
    this._ambT = s.oneShot
      ? s.interval[0] + Math.random() * (s.interval[1] - s.interval[0])
      : Infinity
  }

  async start() {
    if (this.started) return
    // Flag first: a second tap during the resume() await must not double-build
    // the oscillator banks (they'd sum, permanently doubling the hum).
    this.started = true
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

    this._applySpace()
    this._scheduleAmbient()
    this.master.gain.setValueAtTime(0, ctx.currentTime)
    this.master.gain.linearRampToValueAtTime(this.volume, ctx.currentTime + 1.5)
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

  resetLevel(worldSeed, family = this.family) {
    this.ambientCues.reset(worldSeed)
    this._heartT = 0
    this.setFamily(family)
  }

  // Retarget the acoustic space + texture one-shots to a map family. Cheap
  // (one impulse buffer), so it simply runs at every level boundary.
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

  // Voice-budget bookkeeping shared by the one-shot helpers: one budget slot
  // per voice; when the primary source ends, the whole node chain detaches.
  _retire(primary, nodes) {
    this.voices++
    primary.onended = () => {
      this.voices--
      for (const n of nodes) n.disconnect()
    }
  }

  // One enveloped white-noise voice through a filter chain into the SFX bus.
  // `filters`: [{type, freq, q}]; `at` delays the start; `pan` needs
  // StereoPannerNode (skipped where unsupported). Silently drops when the
  // voice budget is spent — layers degrade before the mix does.
  _noiseVoice({ vol, dur, attack = 0.004, rate = 1, filters = [], pan = 0, at = 0 }) {
    if (!this.started || !this.whiteBuf || this.voices >= MAX_VOICES || vol <= 0) return
    const ctx = this.ctx
    const src = ctx.createBufferSource()
    src.buffer = this.whiteBuf
    src.loop = true
    src.playbackRate.value = rate
    const nodes = [src]
    let head = src
    for (const f of filters) {
      const biq = ctx.createBiquadFilter()
      biq.type = f.type
      biq.frequency.value = f.freq
      if (f.q !== undefined) biq.Q.value = f.q
      head.connect(biq)
      head = biq
      nodes.push(biq)
    }
    const g = ctx.createGain()
    head.connect(g)
    head = g
    nodes.push(g)
    if (pan && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner()
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
    src.start(t)
    src.stop(t + attack + dur + 0.03)
    this._retire(src, nodes)
  }

  // Decaying oscillator partials — the modal ring of hard surfaces (ceramic
  // ping, catwalk clang) and the tonal stingers. `glide` multiplies each
  // frequency across `dur`; an optional `filter` shapes the summed output.
  _ringVoice({ freqs, vols, dur, type = 'sine', attack = 0.003, glide = 0, filter = null, pan = 0, at = 0 }) {
    if (!this.started || this.voices >= MAX_VOICES) return
    const ctx = this.ctx
    const t = ctx.currentTime + at
    const sum = ctx.createGain()
    sum.gain.value = 1
    const nodes = [sum]
    let head = sum
    if (filter) {
      const biq = ctx.createBiquadFilter()
      biq.type = filter.type
      biq.frequency.value = filter.freq
      if (filter.q !== undefined) biq.Q.value = filter.q
      head.connect(biq)
      head = biq
      nodes.push(biq)
    }
    if (pan && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner()
      p.pan.value = Math.max(-1, Math.min(1, pan))
      head.connect(p)
      head = p
      nodes.push(p)
    }
    head.connect(this.sfxGain)
    let primary = null
    freqs.forEach((f, i) => {
      const o = ctx.createOscillator()
      o.type = type
      o.frequency.setValueAtTime(f, t)
      if (glide) o.frequency.exponentialRampToValueAtTime(Math.max(1, f * glide), t + attack + dur)
      const g = ctx.createGain()
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
  // own procedural recipe — a soft filtered-noise scuff on carpet, gaining a
  // click transient, body knock and modal ring as the floor hardens. Every
  // layer is jittered so a walk never repeats the same grain twice.
  footstep(speed = 0, surface = SURFACE_CARPET) {
    if (!this.started) return
    const loud = Math.min(1.5, 0.7 + speed * 0.05)
    const r = Math.random
    if (surface === SURFACE_TILE) {
      // Hard ceramic: sharp heel click + short body knock + faint ping.
      this._noiseVoice({
        vol: 0.05 * loud, dur: 0.03, attack: 0.002,
        filters: [{ type: 'highpass', freq: 3600 + r() * 900 }],
      })
      this._noiseVoice({
        vol: 0.065 * loud, dur: 0.06,
        filters: [{ type: 'bandpass', freq: 1250 + r() * 400, q: 1.4 }],
      })
      this._ringVoice({ freqs: [2300 + r() * 600], vols: [0.012 * loud], dur: 0.16 })
    } else if (surface === SURFACE_CONCRETE) {
      // Dense slab: dull mid thud with a dry scuff tail, no ring.
      this._noiseVoice({
        vol: 0.085 * loud, dur: 0.08,
        filters: [{ type: 'bandpass', freq: 340 + r() * 140, q: 0.9 }],
      })
      this._noiseVoice({
        vol: 0.032 * loud, dur: 0.13, rate: 1.1,
        filters: [{ type: 'bandpass', freq: 1800 + r() * 600, q: 0.8 }],
      })
    } else if (surface === SURFACE_DECK) {
      // Raised metal: low hollow boom + clank + inharmonic catwalk ring.
      this._noiseVoice({
        vol: 0.095 * loud, dur: 0.14, rate: 0.5 + r() * 0.1,
        filters: [{ type: 'lowpass', freq: 240, q: 0.7 }],
      })
      this._noiseVoice({
        vol: 0.045 * loud, dur: 0.05,
        filters: [{ type: 'bandpass', freq: 850 + r() * 300, q: 2 }],
      })
      const det = 0.94 + r() * 0.12
      this._ringVoice({
        freqs: [327 * det, 512 * det, 739 * det],
        vols: [0.02 * loud, 0.013 * loud, 0.009 * loud],
        dur: 0.28,
      })
    } else {
      // Carpet (default): the original soft muffled scuff.
      this._noiseVoice({
        vol: 0.1 * loud, dur: 0.115, attack: 0.005, rate: 0.8 + r() * 0.3,
        filters: [{ type: 'bandpass', freq: 850 + r() * 300, q: 0.7 }],
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
      vol: 0.08 + 0.16 * w, dur: 0.2, attack: 0.006, rate: 0.5,
      filters: [{ type: 'lowpass', freq: 210, q: 0.8 }],
    })
    this.footstep(4 + impact, surface)
  }

  // Physical thumb-switch: a tick plus a small latch tone (higher when it
  // lands ON). Also fires when the battery dies — the light does click off.
  flashlightClick(on) {
    if (!this.started) return
    this._noiseVoice({
      vol: 0.05, dur: 0.016, attack: 0.001,
      filters: [{ type: 'highpass', freq: 2600 }],
    })
    this._ringVoice({ freqs: [on ? 740 : 520], vols: [0.03], dur: 0.05, type: 'triangle' })
  }

  // Death punctuation, matched to the death you got: the void swallows you in
  // a pitch-collapsing boom + air rush; being caught/losing your mind sags a
  // dissonant low cluster into the screen static.
  deathStinger(reason = 'caught') {
    if (!this.started) return
    if (reason === 'void') {
      this._ringVoice({ freqs: [64], vols: [0.28], dur: 1.4, attack: 0.01, glide: 0.35 })
      this._noiseVoice({
        vol: 0.12, dur: 1.1, attack: 0.02,
        filters: [{ type: 'lowpass', freq: 500, q: 0.5 }],
      })
    } else {
      this._ringVoice({
        freqs: [55, 58.3, 110.5], vols: [0.11, 0.1, 0.06],
        dur: 1.7, type: 'sawtooth', attack: 0.04, glide: 0.72,
        filter: { type: 'lowpass', freq: 640, q: 0.7 },
      })
      this._noiseVoice({
        vol: 0.06, dur: 1.2, attack: 0.3,
        filters: [{ type: 'bandpass', freq: 3000, q: 0.5 }],
      })
    }
  }

  // Level complete: a brief consonant lift with a soft shimmer — deliberately
  // the only "safe"-coded sound in the game.
  exitStinger() {
    if (!this.started) return
    this._ringVoice({ freqs: [220, 331], vols: [0.055, 0.04], dur: 1.3, attack: 0.25, glide: 1.06 })
    this._noiseVoice({
      vol: 0.014, dur: 1.0, attack: 0.3,
      filters: [{ type: 'highpass', freq: 5800 }],
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
        vol: 0.06, dur: 0.55, attack: 0.05,
        filters: [{ type: 'lowpass', freq: 380 }], pan,
      })
    } else if (pick < 0.8) {
      // A door slammed somewhere: double thud, the reverb supplies the room.
      this._noiseVoice({
        vol: 0.05, dur: 0.07,
        filters: [{ type: 'bandpass', freq: 210, q: 1.2 }], pan,
      })
      this._noiseVoice({
        vol: 0.035, dur: 0.05, at: 0.09,
        filters: [{ type: 'bandpass', freq: 260, q: 1.2 }], pan,
      })
    } else {
      // Metal groan: a slow sagging tone through a narrow band.
      this._ringVoice({
        freqs: [92], vols: [0.022], dur: 1.3, type: 'sawtooth',
        attack: 0.3, glide: 0.82,
        filter: { type: 'bandpass', freq: 300, q: 5 }, pan,
      })
    }
  }

  // Family texture one-shot (never a threat cue, so plain Math.random pacing
  // is fine): sewer drips, lattice steel settling, tower wind.
  _familyOneShot() {
    const kind = this._space.oneShot
    const pan = (Math.random() * 2 - 1) * 0.8
    if (kind === 'drip') {
      // A fast downward chirp; the long sewer reverb supplies the plink tail.
      this._ringVoice({
        freqs: [2100 + Math.random() * 900], vols: [0.035],
        dur: 0.05, glide: 0.25, pan,
      })
    } else if (kind === 'creak') {
      // Cooling steel: either a low settle groan or a pair of dry ticks.
      if (Math.random() < 0.5) {
        this._ringVoice({
          freqs: [70 + Math.random() * 40], vols: [0.016],
          dur: 0.7, type: 'sawtooth', attack: 0.2, glide: 0.88,
          filter: { type: 'bandpass', freq: 260, q: 4 }, pan,
        })
      } else {
        this._noiseVoice({
          vol: 0.02, dur: 0.02,
          filters: [{ type: 'bandpass', freq: 3200, q: 6 }], pan,
        })
        this._noiseVoice({
          vol: 0.014, dur: 0.02, at: 0.14 + Math.random() * 0.2,
          filters: [{ type: 'bandpass', freq: 2700, q: 6 }], pan,
        })
      }
    } else if (kind === 'wind') {
      // A slow breath of wind across the tower shafts.
      this._noiseVoice({
        vol: 0.022, dur: 2.6, attack: 1.2,
        filters: [{ type: 'bandpass', freq: 420 + Math.random() * 220, q: 2.5 }], pan,
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
        vol: vol * 0.7, dur: 0.17, attack: 0.008, rate,
        filters: [{ type: 'lowpass', freq: 260 + Math.random() * 80, q: 0.5 }],
      })
    } else {
      this._noiseVoice({
        vol, dur: 0.17, attack: 0.008, rate,
        filters: [{ type: 'bandpass', freq: 480 + Math.random() * 160, q: 0.8 }],
      })
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
    // Family texture (drips/creaks/wind) runs on its own clock; it is scenery,
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
