// Background music: public-domain MIDI files (public/music, built by
// scripts/build-music.mjs) played through a "ceiling PA speaker" somewhere in
// the building. The music is diegetic: a mono, band-limited, slightly wobbly
// muzak tape that comes on now and then, sits in the room's own reverb, and
// shrinks away when something is wrong.
//
// Signal path (built lazily once a song has loaded, so a context that never
// fetches music never allocates a node):
//   FM electric-piano voices -> tape wow/flutter (modulated delay)
//     -> PA speaker (highpass, cone resonance, lowpass, soft clip)
//     -> level (music volume x family x tension duck) -> master
//                                                     -> the bus's reverb
import { readMidi } from './smf.js'
import {
  MAP_FAMILY_HOTEL,
  MAP_FAMILY_LATTICE,
  MAP_FAMILY_OFFICE,
  MAP_FAMILY_SEWER,
  MAP_FAMILY_TOWER,
} from '../../world/mapTypes.js'
import { byFamily, familyAudio } from '../../world/families/registry.js'

// Seconds of notes scheduled ahead of the context clock. update() runs every
// frame; a generous window survives a hitch without gaps.
const LOOKAHEAD = 0.6
// Notes older than this when their turn comes (a hidden tab, a long pause)
// are dropped instead of all firing at once.
const LATE = 0.15
// Seconds of silence before the first song and between plays.
const FIRST_GAP = [6, 14]
const GAP = [35, 90]
// Concurrent voices; the score never needs more than ~8.
const MAX_MUSIC_VOICES = 16
const OUTPUT_LEVEL = 0.42

// How the PA reaches the player in each family. `level` scales the music,
// `lp` is the speaker/wall lowpass, `send` the reverb share. The sewer hears
// it through a slab overhead; the hotel lobby speaker is the clearest.
export const FAMILY_PA = Object.freeze({
  [MAP_FAMILY_OFFICE]: { level: 1, lp: 3400, send: 0.5 },
  [MAP_FAMILY_HOTEL]: { level: 1.1, lp: 4200, send: 0.45 },
  [MAP_FAMILY_TOWER]: { level: 0.75, lp: 2600, send: 0.7 },
  [MAP_FAMILY_SEWER]: { level: 0.5, lp: 900, send: 0.9 },
  [MAP_FAMILY_LATTICE]: { level: 0.6, lp: 2000, send: 0.8 },
})

const rand = (lo, hi) => lo + Math.random() * (hi - lo)

export class MusicPlayer {
  // bus: the AudioBus (its context, node registry, master and reverb input).
  constructor(bus) {
    this.bus = bus
    this.ctx = bus.ctx
    this.volume = 0.5
    this.tension = 0
    this.family = MAP_FAMILY_OFFICE
    this.songs = []
    this.voices = 0
    this._song = null
    this._next = 0
    this._t0 = 0
    this._gap = rand(...FIRST_GAP)
    this._order = Math.floor(Math.random() * 64) // which song plays first
    this._loading = null
    this._graph = null
  }

  // Fetch the manifest and every listed song. Browser only; a missing folder
  // or a bad file just means no music.
  load(base = import.meta.env?.BASE_URL ?? '/') {
    if (this._loading || typeof fetch !== 'function' || typeof location === 'undefined') return this._loading
    const url = (path) => new URL(`${base}music/${path}`, location.href).href
    this._loading = fetch(url('index.json'))
      .then((r) => (r.ok ? r.json() : { songs: [] }))
      .then(({ songs = [] }) =>
        Promise.all(
          songs.map((meta) =>
            fetch(url(meta.file))
              .then((r) => (r.ok ? r.arrayBuffer() : null))
              .then((buf) => (buf ? { ...meta, ...readMidi(buf) } : null))
              .catch(() => null),
          ),
        ),
      )
      .then((loaded) => {
        this.songs = loaded.filter((s) => s && s.notes.length)
      })
      .catch(() => {})
    return this._loading
  }

  get playing() {
    return this._song !== null
  }

  setVolume(v) {
    this.volume = v
    this._applyLevel(0.1)
  }

  setTension(t) {
    this.tension = t
    this._applyLevel(1.2)
    // Under threat the tape drags: deeper, slower wow.
    if (this._graph) this._graph.wowDepth.gain.setTargetAtTime(0.0009 * (1 + 3 * t), this.ctx.currentTime, 1)
  }

  setFamily(family) {
    this.family = family
    if (!this._graph) return
    const pa = this._pa
    const t = this.ctx.currentTime
    this._graph.lp.frequency.setTargetAtTime(pa.lp, t, 1)
    this._graph.send.gain.setTargetAtTime(pa.send, t, 1)
    this._applyLevel(1)
  }

  get _pa() {
    // A liminal family's own record row first, then its base family's (§5.1).
    return familyAudio(this.family)?.pa ?? byFamily(FAMILY_PA, this.family)
  }

  _applyLevel(timeConstant) {
    if (!this._graph) return
    const level = OUTPUT_LEVEL * this.volume * this._pa.level * Math.max(0, 1 - 0.85 * this.tension)
    this._graph.level.gain.setTargetAtTime(level, this.ctx.currentTime, timeConstant)
  }

  _build() {
    const ctx = this.ctx
    const node = (n) => this.bus._node(n)
    const biquad = (type, freq, q, gainDb) => {
      const f = node(ctx.createBiquadFilter())
      f.type = type
      f.frequency.value = freq
      if (q !== undefined) f.Q.value = q
      if (gainDb !== undefined) f.gain.value = gainDb
      return f
    }
    const input = node(ctx.createGain())
    input.gain.value = 1
    // Tape transport: a short delay line whose time wanders slowly (wow) and
    // quickly (flutter) bends the pitch by a few cents, never in tune twice.
    const tape = node(ctx.createDelay(0.05))
    tape.delayTime.value = 0.012
    const wowDepth = node(ctx.createGain())
    wowDepth.gain.value = 0.0009
    const wow = node(ctx.createOscillator())
    wow.frequency.value = 0.55
    wow.connect(wowDepth)
    wowDepth.connect(tape.delayTime)
    const flutterDepth = node(ctx.createGain())
    flutterDepth.gain.value = 0.00012
    const flutter = node(ctx.createOscillator())
    flutter.frequency.value = 6.3
    flutter.connect(flutterDepth)
    flutterDepth.connect(tape.delayTime)
    // A small ceiling speaker: no lows, a honky cone resonance, no air.
    const hp = biquad('highpass', 330, 0.7)
    const cone = biquad('peaking', 1800, 0.9, 5)
    const lp = biquad('lowpass', this._pa.lp, 0.6)
    // Gentle saturation of an old amp; symmetric, so no DC.
    const clip = node(ctx.createWaveShaper())
    const curve = new Float32Array(1024)
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1
      curve[i] = Math.tanh(2.2 * x) / Math.tanh(2.2)
    }
    clip.curve = curve
    const level = node(ctx.createGain())
    level.gain.value = 0
    const send = node(ctx.createGain())
    send.gain.value = this._pa.send
    input.connect(tape)
    tape.connect(hp)
    hp.connect(cone)
    cone.connect(lp)
    lp.connect(clip)
    clip.connect(level)
    level.connect(this.bus.master)
    level.connect(send)
    send.connect(this.bus.convolver)
    wow.start()
    flutter.start()
    this._graph = { input, lp, level, send, wowDepth }
    this._applyLevel(0.5)
  }

  _begin(now) {
    if (!this.songs.length) return
    if (!this._graph) this._build()
    this._song = this.songs[this._order++ % this.songs.length]
    this._next = 0
    this._t0 = now + 0.1
  }

  // Call every frame. Starts a song after the current gap, schedules the
  // notes that fall inside the lookahead window, and opens the next gap.
  update(dt) {
    if (!this.songs.length || this.volume <= 0) return
    const now = this.ctx.currentTime
    if (!this._song) {
      this._gap -= dt
      if (this._gap <= 0) this._begin(now)
      if (!this._song) return
    }
    const notes = this._song.notes
    while (this._next < notes.length) {
      const n = notes[this._next]
      const at = this._t0 + n.time
      if (at > now + LOOKAHEAD) break
      this._next++
      if (at < now - LATE) continue
      this._voice(n.pitch, n.vel, Math.max(at, now), n.dur)
    }
    if (this._next >= notes.length && now > this._t0 + this._song.duration + 2) {
      this._song = null
      this._gap = rand(...GAP)
    }
  }

  // A two-operator FM electric piano: a sine carrier phase-modulated at the
  // same frequency, the modulation index falling fast after the strike (the
  // bright "tine" attack mellowing into a near-sine), plus a quick inharmonic
  // ping. Low notes ring longer than high ones.
  _voice(pitch, vel, at, dur) {
    if (this.voices >= MAX_MUSIC_VOICES) return
    const ctx = this.ctx
    const node = (n) => this.bus._node(n)
    const f = 440 * 2 ** ((pitch - 69) / 12)
    const v = vel / 127
    const amp = 0.2 * v ** 1.5
    const ring = Math.max(1.1, Math.min(4.5, 3.4 - (pitch - 48) * 0.05))
    const end = at + Math.max(0.12, dur)
    const stop = end + 0.6

    const carrier = node(ctx.createOscillator())
    carrier.frequency.value = f
    const mod = node(ctx.createOscillator())
    mod.frequency.value = f
    const index = node(ctx.createGain())
    index.gain.setValueAtTime(f * (0.9 + 1.6 * v), at)
    index.gain.setTargetAtTime(f * 0.18, at, 0.22)
    mod.connect(index)
    index.connect(carrier.frequency)
    const ping = node(ctx.createOscillator())
    ping.frequency.value = f * 7.02
    const pingIndex = node(ctx.createGain())
    pingIndex.gain.setValueAtTime(f * 0.9 * v, at)
    pingIndex.gain.setTargetAtTime(0, at, 0.03)
    ping.connect(pingIndex)
    pingIndex.connect(carrier.frequency)

    const env = node(ctx.createGain())
    env.gain.setValueAtTime(0, at)
    env.gain.linearRampToValueAtTime(amp, at + 0.005)
    env.gain.setTargetAtTime(amp * 0.05, at + 0.005, ring)
    env.gain.setTargetAtTime(0, end, 0.09)
    carrier.connect(env)
    env.connect(this._graph.input)

    for (const o of [carrier, mod, ping]) {
      o.start(at)
      o.stop(stop)
    }
    this.voices++
    const nodes = [carrier, mod, ping, index, pingIndex, env]
    carrier.onended = () => {
      this.voices--
      for (const n of nodes) {
        n.disconnect()
        this.bus._nodes.delete(n)
      }
    }
  }

  // Stop scheduling (the bus disposes the nodes it registered).
  dispose() {
    this.songs = []
    this._song = null
    this._graph = null
    this.voices = 0
  }
}
