import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// Node-only readers for the Blender pack manifests (scripts/blender/
// build_pack.py writes public/models/<pack>/manifest.json, schema v1). No
// three.js: tests compare the manifest with the GLB bytes it describes.

export const MODELS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../public/models'
)

export const packDir = (pack) => path.join(MODELS_ROOT, pack)

export const readPackManifest = (pack) =>
  JSON.parse(readFileSync(path.join(packDir(pack), 'manifest.json'), 'utf8'))

// Every model directory that carries a manifest, sorted (new packs are picked
// up without touching the tests).
export const listPacks = () =>
  readdirSync(MODELS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(MODELS_ROOT, d.name, 'manifest.json')))
    .map((d) => d.name)
    .sort()

// { bytes, json, bin } of a GLB (glTF 2.0 binary: header, JSON chunk, BIN chunk).
export function readGlbChunks(file) {
  const bytes = readFileSync(file)
  if (bytes.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file}: not a GLB`)
  let json = null
  let bin = null
  for (let off = 12; off + 8 <= bytes.readUInt32LE(8);) {
    const len = bytes.readUInt32LE(off)
    const type = bytes.readUInt32LE(off + 4)
    const body = bytes.subarray(off + 8, off + 8 + len)
    if (type === 0x4e4f534a) json = JSON.parse(body.toString('utf8'))
    else if (type === 0x004e4942) bin = body
    off += 8 + len
  }
  return { bytes, json, bin }
}
