// Render the public-domain scores in src/audio/music/scores to Standard MIDI
// Files under public/music, plus the index.json manifest the in-game player
// reads (src/audio/music/MusicPlayer.js). Usage: npm run build:music
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SCORES } from '../src/audio/music/scores/index.js'
import { songFromScore } from '../src/audio/music/song.js'
import { readMidi, writeMidi } from '../src/audio/music/smf.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'public', 'music')
mkdirSync(out, { recursive: true })

const manifest = []
for (const score of SCORES) {
  const song = songFromScore(score)
  const bytes = writeMidi(song)
  const file = `${score.id}.mid`
  writeFileSync(join(out, file), bytes)
  const check = readMidi(bytes)
  manifest.push({
    id: score.id,
    file,
    title: score.title,
    composer: score.composer,
    year: score.year,
    license: score.license,
    source: score.source,
  })
  console.log(
    `${file}: ${check.notes.length} notes, ${song.tracks.length} tracks, ${check.duration.toFixed(1)} s, ${bytes.length} bytes`,
  )
}
writeFileSync(join(out, 'index.json'), JSON.stringify({ songs: manifest }, null, 2) + '\n')
console.log(`wrote ${manifest.length} song(s) to public/music`)
