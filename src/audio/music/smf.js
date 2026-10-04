// Standard MIDI File (SMF) writing and reading, dependency-free.
//
// writeMidi() builds a format-1 file from timed notes (scripts/build-music.mjs
// renders the public-domain scores to public/music/*.mid); readMidi() parses
// any format-0/1 file back into notes in SECONDS through its tempo map, which
// is what the in-game player schedules (audio/music/MusicPlayer.js). Any
// public-domain .mid dropped into public/music plays the same way.

export const PPQ = 480

function vlq(n) {
  const bytes = [n & 0x7f]
  n >>>= 7
  while (n > 0) {
    bytes.unshift((n & 0x7f) | 0x80)
    n >>>= 7
  }
  return bytes
}

const ascii = (s) => [...new TextEncoder().encode(s)]
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const u16 = (n) => [(n >>> 8) & 255, n & 255]

function chunk(id, body) {
  return [...ascii(id), ...u32(body.length), ...body]
}

function meta(type, data) {
  return [0xff, type, ...vlq(data.length), ...data]
}

// Encode absolute-tick events [{ tick, bytes }] into a track chunk.
function track(events) {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order)
  const body = []
  let last = 0
  for (const e of events) {
    body.push(...vlq(e.tick - last), ...e.bytes)
    last = e.tick
  }
  body.push(0, 0xff, 0x2f, 0) // end of track
  return chunk('MTrk', body)
}

// song: { title, text: [strings], tempo (quarter bpm), meter: [n, d],
//         tracks: [{ name, channel, program, notes: [{ start, dur, pitch, vel }] }] }
// Note times are in quarter-note beats.
export function writeMidi(song) {
  const usPerQuarter = Math.round(60e6 / song.tempo)
  const [num, den] = song.meter ?? [4, 4]
  const conductor = [
    { tick: 0, order: 0, bytes: meta(0x03, ascii(song.title ?? '')) },
    ...(song.text ?? []).map((t, i) => ({ tick: 0, order: 1 + i, bytes: meta(0x01, ascii(t)) })),
    { tick: 0, order: 50, bytes: meta(0x51, [(usPerQuarter >>> 16) & 255, (usPerQuarter >>> 8) & 255, usPerQuarter & 255]) },
    { tick: 0, order: 51, bytes: meta(0x58, [num, Math.log2(den), 24, 8]) },
  ]
  const chunks = [track(conductor)]
  for (const t of song.tracks) {
    const ch = t.channel & 15
    const events = [
      { tick: 0, order: 0, bytes: meta(0x03, ascii(t.name ?? '')) },
      { tick: 0, order: 1, bytes: [0xc0 | ch, t.program & 127] },
    ]
    for (const n of t.notes) {
      const on = Math.round(n.start * PPQ)
      const off = Math.max(on + 1, Math.round((n.start + n.dur) * PPQ))
      // Offs sort before ons at the same tick, so a repeated pitch restrikes.
      events.push({ tick: on, order: 3, bytes: [0x90 | ch, n.pitch & 127, Math.max(1, Math.min(127, n.vel ?? 64))] })
      events.push({ tick: off, order: 2, bytes: [0x80 | ch, n.pitch & 127, 0] })
    }
    chunks.push(track(events))
  }
  const header = chunk('MThd', [...u16(1), ...u16(chunks.length), ...u16(PPQ)])
  return new Uint8Array([...header, ...chunks.flat()])
}

// Parse an SMF into { notes: [{ time, dur, pitch, vel, channel, track }],
// duration, title, tracks: [names] } with times in seconds.
export function readMidi(buffer) {
  const d = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  let p = 0
  const str = (n) => String.fromCharCode(...d.subarray(p, (p += n)))
  const u32r = () => ((d[p++] << 24) | (d[p++] << 16) | (d[p++] << 8) | d[p++]) >>> 0
  const u16r = () => (d[p++] << 8) | d[p++]
  const vlqr = () => {
    let n = 0
    let b
    do {
      b = d[p++]
      n = (n << 7) | (b & 0x7f)
    } while (b & 0x80)
    return n
  }
  if (str(4) !== 'MThd') throw new Error('not a MIDI file')
  const hlen = u32r()
  const hstart = p
  u16r() // format
  const ntracks = u16r()
  const division = u16r()
  p = hstart + hlen
  if (division & 0x8000) throw new Error('SMPTE time division is not supported')

  const tempos = [{ tick: 0, us: 500000 }]
  const raw = [] // { tick, type: 'on'|'off', pitch, vel, channel, track }
  const names = []
  let title = ''
  for (let t = 0; t < ntracks && p < d.length; t++) {
    const id = str(4)
    const len = u32r()
    const end = p + len
    if (id !== 'MTrk') {
      p = end
      continue
    }
    let tick = 0
    let status = 0
    while (p < end) {
      tick += vlqr()
      let b = d[p]
      if (b & 0x80) {
        status = b
        p++
      } else b = status // running status
      const type = status & 0xf0
      if (status === 0xff) {
        const mt = d[p++]
        const ml = vlqr()
        const data = d.subarray(p, p + ml)
        p += ml
        if (mt === 0x51) tempos.push({ tick, us: (data[0] << 16) | (data[1] << 8) | data[2] })
        if (mt === 0x03) {
          const name = new TextDecoder().decode(data)
          if (t === 0 && !title) title = name
          names[t] = name
        }
        if (mt === 0x2f) break
      } else if (status === 0xf0 || status === 0xf7) {
        p += vlqr()
      } else if (type === 0x90 || type === 0x80) {
        const pitch = d[p++]
        const vel = d[p++]
        raw.push({ tick, type: type === 0x90 && vel > 0 ? 'on' : 'off', pitch, vel, channel: status & 15, track: t })
      } else if (type === 0xc0 || type === 0xd0) {
        p += 1
      } else {
        p += 2 // aftertouch, controllers, pitch bend
      }
    }
    p = end
  }

  // Tempo map: ticks -> seconds.
  tempos.sort((a, b) => a.tick - b.tick)
  const seconds = (tick) => {
    let s = 0
    let at = 0
    let us = tempos[0].us
    for (const tp of tempos) {
      if (tp.tick >= tick) break
      s += ((tp.tick - at) * us) / 1e6 / division
      at = tp.tick
      us = tp.us
    }
    return s + ((tick - at) * us) / 1e6 / division
  }

  raw.sort((a, b) => a.tick - b.tick || (a.type === 'off' ? -1 : 1))
  const open = new Map()
  const notes = []
  for (const e of raw) {
    const key = (e.track << 16) | (e.channel << 8) | e.pitch
    if (e.type === 'on') {
      if (open.has(key)) {
        const n = open.get(key)
        n.dur = seconds(e.tick) - n.time
      }
      const n = { time: seconds(e.tick), dur: 0, pitch: e.pitch, vel: e.vel, channel: e.channel, track: e.track }
      open.set(key, n)
      notes.push(n)
    } else if (open.has(key)) {
      const n = open.get(key)
      n.dur = seconds(e.tick) - n.time
      open.delete(key)
    }
  }
  notes.sort((a, b) => a.time - b.time || a.pitch - b.pitch)
  const duration = notes.reduce((m, n) => Math.max(m, n.time + n.dur), 0)
  return { notes, duration, title, tracks: names }
}
