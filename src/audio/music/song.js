// Score module -> song: the voices of a public-domain score (audio/music/
// scores) resolved to timed notes with a General MIDI program and a role
// velocity each, ready for writeMidi() (scripts/build-music.mjs).

import { lilyNotes } from './lily.js'

// GM program 5 (index 4) is Electric Piano 1, the closest General MIDI patch
// to the in-game FM voice. The accompaniment sits under the melody.
const ROLES = {
  melody: { program: 4, vel: 66 },
  chords: { program: 4, vel: 42 },
  bass: { program: 4, vel: 54 },
}

export function songFromScore(score) {
  const [beatsPerBar] = score.meter ?? [4, 4]
  const tracks = score.voices.map((v, i) => {
    const role = ROLES[v.role] ?? ROLES.melody
    const { notes, length } = lilyNotes(v.ly)
    return {
      name: v.name,
      role: v.role,
      channel: i,
      program: role.program,
      length,
      // A light downbeat accent keeps the sequencer from sounding flat.
      notes: notes.map((n) => ({ ...n, vel: role.vel + (n.start % beatsPerBar === 0 ? 5 : 0) })),
    }
  })
  return {
    title: score.title,
    text: [`${score.composer} (${score.year})`, score.license, `Source: ${score.source}`],
    tempo: score.tempo,
    meter: score.meter,
    length: Math.max(...tracks.map((t) => t.length)),
    tracks,
  }
}
