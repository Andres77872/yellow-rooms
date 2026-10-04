// A small LilyPond subset reader for the public-domain scores the game plays
// (audio/music/scores). It turns one `\relative` voice into absolute timed
// notes, so a score can be checked in as the editor's own text and still be
// rendered to a Standard MIDI File (scripts/build-music.mjs).
//
// Supported: notes with is/es accidentals, octave marks ' and , and dotted
// durations; rests r / R / s and pitched rests (`e4\rest`); chords `< >`;
// ties `~`; `{ }` sequences and `<< >>` simultaneous music; `\repeat volta n`
// with `\alternative`. Everything else (dynamics, slurs, overrides, markup,
// bar checks, staff changes) carries no pitch or time and is skipped.
//
// Relative octaves follow LilyPond: each pitch is the nearest of its letter
// (within a fourth) to the previous pitch, then shifted by its marks; a
// chord's first pitch is relative to the previous reference and the rest to
// the note before them, and the chord's FIRST pitch becomes the reference;
// pitched rests move the reference like notes. Pitches resolve in WRITTEN
// order (so an alternative follows the previous alternative), and repeats
// unfold afterwards.

const LETTERS = 'cdefgab'
const SEMITONE = [0, 2, 4, 5, 7, 9, 11]

// Diatonic step index of an absolute pitch: c (C3) is 21, c' (middle C,
// MIDI 60) is 28.
const stepOf = (letter, octaveMarks) => 21 + LETTERS.indexOf(letter) + 7 * octaveMarks
const marksOf = (text) => [...text].reduce((n, c) => n + (c === "'" ? 1 : c === ',' ? -1 : 0), 0)

function midiOf(step, alter) {
  const octave = Math.floor(step / 7)
  return 12 * (octave + 1) + SEMITONE[((step % 7) + 7) % 7] + alter
}

function alterOf(suffix) {
  let a = 0
  for (const m of suffix.matchAll(/is|es|s/g)) a += m[0] === 'is' ? 1 : -1
  return a
}

// Strip the constructs that carry no notes.
function clean(src) {
  return src
    .replace(/%\{[\s\S]*?%\}/g, ' ')
    .replace(/%.*$/gm, ' ')
    .replace(/[\^_-]?\\markup\s*\{[^{}]*\}/g, ' ')
    .replace(/(\\once\s*)?\\override\s+[\w.-]+\s*=\s*#+\S+/g, ' ')
    .replace(/\\barNumberCheck\s*#\d+/g, ' ')
    .replace(/\\bar\s*"[^"]*"/g, ' ')
    .replace(/\\change\s+Staff\s*=\s*"?\w+"?/g, ' ')
    .replace(/\\context\s+\w+(\s*=\s*"[^"]*")?/g, ' ')
    .replace(/\\key\s+[a-g]\w*\s*\\\w+/g, ' ')
    .replace(/\\time\s+\d+\/\d+/g, ' ')
    .replace(/\\clef\s+"?[\w^_]+"?/g, ' ')
}

// Commands that shape the music; every other `\command` is decoration.
const STRUCTURAL = new Set(['\\repeat', '\\alternative', '\\relative', '\\rest'])

// Commands first (so `\<` is a hairpin, not a chord), then notes and rests
// that are whole words, numbers, and any other word (skipped).
const TOKEN = /\\[a-zA-Z]+|\\[^a-zA-Z\s]|<<|>>|[{}<>~]|[a-g](?:isis|eses|is|es|s)?[',]*\d*\.*(?![a-zA-Z])|[rRs]\d*\.*(?![a-zA-Z])|\d+\.*|[a-zA-Z]+/g

// Whole-token shapes: a stray word that merely starts with a note letter or
// r/s (`shift` in an old `#'horizontal-shift` override) is not music.
const NOTE = /^[a-g](?:isis|eses|is|es|s)?[',]*\d*\.*$/
const REST = /^[rRs]\d*\.*$/

function tokenize(src) {
  return clean(src).match(TOKEN) ?? []
}

function durationOf(text, fallback) {
  const m = /(\d+)(\.*)$/.exec(text)
  if (!m) return fallback
  let d = 4 / Number(m[1])
  let add = d / 2
  for (let i = 0; i < m[2].length; i++) {
    d += add
    add /= 2
  }
  return d
}

// Parse `\relative <pitch> { music }` (or bare music with an absolute
// reference) into a tree with pitches resolved.
export function parseRelative(src) {
  const tokens = tokenize(src)
  let i = 0
  const peek = () => tokens[i]
  const next = () => tokens[i++]

  let ref = { step: stepOf('c', 2), letter: 'c' } // \relative c'' unless given
  let dur = 1 // quarter notes

  const resolve = (token, from) => {
    const m = /^([a-g])((?:isis|eses|is|es|s)?)([',]*)/.exec(token)
    const letter = m[1]
    let d = (LETTERS.indexOf(letter) - LETTERS.indexOf(from.letter) + 7) % 7
    if (d > 3) d -= 7
    const step = from.step + d + 7 * marksOf(m[3])
    return { step, letter, midi: midiOf(step, alterOf(m[2])) }
  }

  function parseMusic() {
    const t = peek()
    if (t === undefined) return null
    if (t === '{') {
      next()
      const items = []
      while (peek() !== undefined && peek() !== '}') {
        const m = parseMusic()
        if (m) items.push(m)
      }
      next()
      return { type: 'seq', items }
    }
    if (t === '<<') {
      next()
      const items = []
      while (peek() !== undefined && peek() !== '>>') {
        const m = parseMusic()
        if (m) items.push(m)
      }
      next()
      return { type: 'sim', items }
    }
    if (t === '\\repeat') {
      next()
      next() // volta / unfold
      const count = Number(next())
      const body = parseMusic()
      const alts = []
      if (peek() === '\\alternative') {
        next()
        const block = parseMusic()
        alts.push(...(block?.items ?? []))
      }
      return { type: 'repeat', count, body, alts }
    }
    if (t === '<') {
      next()
      const pitches = []
      let from = ref
      while (peek() !== undefined && peek() !== '>') {
        const tok = next()
        if (!NOTE.test(tok)) continue
        const p = resolve(tok, from)
        pitches.push(p)
        from = p
      }
      next()
      if (pitches.length) ref = pitches[0]
      if (peek() && /^\d/.test(peek())) dur = durationOf(next(), dur)
      return { type: 'chord', pitches: pitches.map((p) => p.midi), dur, tie: tieAhead() }
    }
    next()
    if (NOTE.test(t)) {
      const p = resolve(t, ref)
      ref = p
      dur = durationOf(t.slice(/^[a-g](?:isis|eses|is|es|s)?[',]*/.exec(t)[0].length), dur)
      if (peek() === '\\rest') {
        next()
        return { type: 'rest', dur }
      }
      return { type: 'note', pitches: [p.midi], dur, tie: tieAhead() }
    }
    if (REST.test(t)) {
      dur = durationOf(t.slice(1), dur)
      return { type: 'rest', dur }
    }
    if (t === '\\relative') {
      if (peek() && NOTE.test(peek())) {
        const m = /^([a-g])[^',]*([',]*)/.exec(next())
        ref = { step: stepOf(m[1], marksOf(m[2])), letter: m[1] }
      }
      return parseMusic()
    }
    return null // commands, ties without a note, stray numbers
  }

  // A tie may follow dynamics and other decoration (`fis2.\!) ~`).
  function tieAhead() {
    let j = i
    while (tokens[j]?.startsWith('\\') && !STRUCTURAL.has(tokens[j])) j++
    if (tokens[j] !== '~') return false
    i = j + 1
    return true
  }

  const items = []
  while (i < tokens.length) {
    const m = parseMusic()
    if (m) items.push(m)
  }
  return { type: 'seq', items }
}

// Unfold a parsed tree into timed notes { start, dur, pitch, tie } (beats =
// quarter notes). Returns { notes, length }.
export function unfold(tree) {
  const notes = []
  const walk = (m, t) => {
    switch (m.type) {
      case 'seq': {
        let at = t
        for (const it of m.items) at = walk(it, at)
        return at
      }
      case 'sim': {
        let end = t
        for (const it of m.items) end = Math.max(end, walk(it, t))
        return end
      }
      case 'repeat': {
        let at = t
        for (let k = 0; k < m.count; k++) {
          at = walk(m.body, at)
          const alt = m.alts.length ? m.alts[Math.min(k, m.alts.length - 1)] : null
          if (alt) at = walk(alt, at)
        }
        return at
      }
      case 'note':
      case 'chord':
        for (const pitch of m.pitches) notes.push({ start: t, dur: m.dur, pitch, tie: m.tie })
        return t + m.dur
      case 'rest':
        return t + m.dur
      default:
        return t
    }
  }
  const length = walk(tree, 0)
  return { notes: mergeTies(notes), length }
}

// A tied note continues into the next note of the same pitch that starts
// where it ends.
function mergeTies(notes) {
  const sorted = [...notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch)
  const out = []
  const open = new Map() // pitch -> note still tied forward
  for (const n of sorted) {
    const held = open.get(n.pitch)
    if (held && Math.abs(held.start + held.dur - n.start) < 1e-6) {
      held.dur += n.dur
      if (!n.tie) open.delete(n.pitch)
      continue
    }
    const note = { start: n.start, dur: n.dur, pitch: n.pitch }
    out.push(note)
    if (n.tie) open.set(n.pitch, note)
    else open.delete(n.pitch)
  }
  return out
}

export function lilyNotes(src) {
  return unfold(parseRelative(src))
}
