import { describe, it, expect, vi } from 'vitest'
import { lilyNotes } from '../music/lily.js'
import { readMidi, writeMidi } from '../music/smf.js'
import { songFromScore } from '../music/song.js'
import gymnopedie from '../music/scores/gymnopedie1.js'
import { MusicPlayer } from '../music/MusicPlayer.js'
import { SCORES } from '../music/scores/index.js'
import { MAP_FAMILY_OFFICE, MAP_FAMILY_SEWER } from '../../world/mapTypes.js'

const voice = (role) => lilyNotes(gymnopedie.voices.find((v) => v.role === role).ly)
const at = (notes, start) => notes.filter((n) => Math.abs(n.start - start) < 1e-9).map((n) => n.pitch).sort((a, b) => a - b)

describe('LilyPond relative reader', () => {
  it('resolves relative octaves, accidentals, chords and dotted durations', () => {
    const { notes, length } = lilyNotes(String.raw`\relative c' { c4 e g c | b,2. | <fis' d b>2 r4 | c'8 c, }`)
    // c' e' g' c'' | b (nearest b to c'' is b', the comma drops it) | the
    // chord written top-down | c' (a fourth below fis'') raised, then back.
    expect(notes.map((n) => n.pitch)).toEqual([60, 64, 67, 72, 59, 59, 62, 66, 72, 60])
    expect(notes[4].dur).toBe(3)
    expect(at(notes, 7)).toEqual([59, 62, 66])
    expect(notes.at(-1)).toEqual({ start: 10.5, dur: 0.5, pitch: 60 })
    expect(length).toBe(11)
  })

  it('merges ties and unfolds volta repeats with alternatives', () => {
    const { notes, length } = lilyNotes(String.raw`\relative c' { \repeat volta 2 { c2 ~ c4 } \alternative { { d4 } { e4 } } }`)
    expect(notes.map((n) => [n.start, n.dur, n.pitch])).toEqual([
      [0, 3, 60],
      [3, 1, 62],
      [4, 3, 60],
      [7, 1, 64],
    ])
    expect(length).toBe(8)
  })

  it('skips dynamics, hairpins, overrides and markup', () => {
    const { notes } = lilyNotes(String.raw`\relative c'' { R2.^\markup{"Lent"} | s4 fis( \pp \< a | \once\override Hairpin.Y-offset = #7 g\! }`)
    expect(notes.map((n) => n.pitch)).toEqual([78, 81, 79])
  })
})

describe('Gymnopédie No. 1 transcription', () => {
  it('opens on the G / D bass and the Gmaj7 / Dmaj7 accompaniment', () => {
    const bass = voice('bass').notes
    const chords = voice('chords').notes
    expect(at(bass, 0)).toEqual([43]) // G2
    expect(at(bass, 3)).toEqual([38]) // D2
    expect(at(chords, 1)).toEqual([59, 62, 66]) // B3 D4 F#4
    expect(at(chords, 4)).toEqual([57, 61, 66]) // A3 C#4 F#4
  })

  it('enters with the famous melody in bar 5', () => {
    const melody = voice('melody').notes
    const first = melody.slice(0, 10).map((n) => [n.start, n.pitch])
    expect(first).toEqual([
      [13, 78], [14, 81], [15, 79], [16, 78], [17, 73], [18, 71], [19, 73], [20, 74], [21, 69], [24, 66],
    ])
    expect(melody[9].dur).toBe(12) // F#4 tied over four bars
  })

  it('plays the volta twice: 39 bars per pass, every voice the same length', () => {
    const lengths = gymnopedie.voices.map((v) => lilyNotes(v.ly).length)
    for (const l of lengths) expect(l).toBe((31 + 8) * 2 * 3)
    for (const v of gymnopedie.voices) {
      for (const n of lilyNotes(v.ly).notes) {
        expect(n.pitch).toBeGreaterThanOrEqual(26)
        expect(n.pitch).toBeLessThanOrEqual(90)
      }
    }
  })
})

describe('Standard MIDI files', () => {
  it('round-trips a score through writeMidi / readMidi with its tempo', () => {
    const song = songFromScore(gymnopedie)
    const bytes = writeMidi(song)
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('MThd')
    const midi = readMidi(bytes)
    const total = song.tracks.reduce((n, t) => n + t.notes.length, 0)
    expect(midi.notes).toHaveLength(total)
    expect(midi.title).toBe(song.title)
    const beat = 60 / gymnopedie.tempo
    const melody = midi.notes.filter((n) => n.track === 1)
    expect(melody[0].time).toBeCloseTo(13 * beat, 4)
    expect(melody[0].pitch).toBe(78)
    expect(midi.duration).toBeCloseTo(234 * beat, 3)
  })
})

function fakeBus() {
  const param = () => ({ value: 0, setValueAtTime: vi.fn(), setTargetAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() })
  const created = []
  const node = (extra = {}) => {
    const n = { connect: vi.fn(), disconnect: vi.fn(), gain: param(), frequency: param(), Q: param(), delayTime: param(), ...extra }
    created.push(n)
    return n
  }
  const source = () => node({ start: vi.fn(), stop: vi.fn() })
  const ctx = {
    currentTime: 0,
    state: 'running',
    createGain: () => node(),
    createBiquadFilter: () => node(),
    createDelay: () => node(),
    createWaveShaper: () => node(),
    createOscillator: source,
  }
  const nodes = new Set()
  return { ctx, created, _nodes: nodes, _node: (n) => (nodes.add(n), n), master: {}, convolver: {} }
}

describe('PA music player', () => {
  const song = { title: 't', duration: 3, notes: [
    { time: 0, dur: 1, pitch: 60, vel: 64 },
    { time: 0.5, dur: 1, pitch: 64, vel: 64 },
    { time: 2, dur: 1, pitch: 67, vel: 64 },
  ] }

  it('builds nothing until a song is loaded and its gap has passed', () => {
    const bus = fakeBus()
    const music = new MusicPlayer(bus)
    music.update(100)
    expect(bus.created).toHaveLength(0)
    music.songs = [song]
    music.update(0.016)
    expect(music.playing).toBe(false)
    music.update(60)
    expect(music.playing).toBe(true)
    expect(bus.created.length).toBeGreaterThan(0)
  })

  it('schedules notes inside the lookahead window, drops late ones and rests between plays', () => {
    const bus = fakeBus()
    const music = new MusicPlayer(bus)
    music.songs = [song]
    music._gap = 0
    music.update(0.016)
    expect(music.voices).toBe(2) // t0 = 0.1: notes at 0.1 and 0.6 fall inside 0.6 s
    bus.ctx.currentTime = 5 // a long stall: the 2.1 s note is stale
    music.update(0.016)
    expect(music.voices).toBe(2)
    bus.ctx.currentTime = 6
    music.update(0.016)
    expect(music.playing).toBe(false)
    expect(music._gap).toBeGreaterThan(30)
    // Ended voices release their budget slot and leave the node registry.
    const ends = bus.created.filter((n) => n.onended)
    for (const n of ends) n.onended()
    expect(music.voices).toBe(0)
  })

  it('ducks under tension, follows the family and stays silent at zero volume', () => {
    const bus = fakeBus()
    const music = new MusicPlayer(bus)
    music.songs = [song]
    music._gap = 0
    music.update(0.016)
    const level = music._graph.level.gain.setTargetAtTime
    music.setTension(0)
    const calm = level.mock.calls.at(-1)[0]
    music.setTension(1)
    expect(level.mock.calls.at(-1)[0]).toBeLessThan(calm * 0.2)
    music.setFamily(MAP_FAMILY_SEWER)
    const sewerLp = music._graph.lp.frequency.setTargetAtTime.mock.calls.at(-1)[0]
    music.setFamily(MAP_FAMILY_OFFICE)
    expect(music._graph.lp.frequency.setTargetAtTime.mock.calls.at(-1)[0]).toBeGreaterThan(sewerLp)
    music.setVolume(0)
    expect(level.mock.calls.at(-1)[0]).toBe(0)
  })
})

describe('every bundled score', () => {
  it('parses into aligned voices in a playable range', () => {
    for (const score of SCORES) {
      const voices = score.voices.map((v) => lilyNotes(v.ly))
      const length = Math.max(...voices.map((v) => v.length))
      const bar = score.meter[0]
      expect(length % bar, score.id).toBe(0)
      for (const v of voices) {
        expect(v.notes.length, score.id).toBeGreaterThan(20)
        // A voice may stop early (a trailing spacer) but never runs over or
        // drifts off the beat grid.
        expect(v.length).toBeLessThanOrEqual(length)
        for (const n of v.notes) {
          expect(n.pitch).toBeGreaterThanOrEqual(24)
          expect(n.pitch).toBeLessThanOrEqual(96)
          expect(Number.isInteger(n.start * 2), `${score.id} ${n.start}`).toBe(true)
        }
      }
      const chords = voices[score.voices.findIndex((v) => v.role === 'chords')]
      // The accompaniment never strikes on the downbeat (the bass owns it).
      for (const n of chords.notes) expect(n.start % bar, score.id).toBeGreaterThanOrEqual(1)
    }
  })

  it('ignores stray words that start like notes or rests', () => {
    const { notes, length } = lilyNotes(String.raw`\relative c'' { \override NoteColumn #'horizontal-shift = #1 r4 a2 }`)
    expect(notes).toEqual([{ start: 1, dur: 2, pitch: 69 }])
    expect(length).toBe(3)
  })
})
