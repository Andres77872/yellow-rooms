import { CHUNK, chunkKey3 } from '../../world/constants.js'
import { ChunkData } from '../../world/ChunkData.js'
import { ByteReader, ByteWriter, readRLE8, readRLEV, writeRLE8, writeRLEV } from './bytes.js'
import { EditorMap, isPristineChunk } from '../EditorMap.js'

// .yrmap — the editor's map container. Binary, little-endian, varint-heavy:
//
//   "YRM1" · u8 container version · u8 codec (0 raw, 1 gzip) · payload
//   payload := meta · rooms · descriptor table · chunks
//
// Tile rasters ride byte-run RLE (long solid/empty runs dominate); spaceId
// uses varint-valued RLE. Stair/structure descriptors are JSON-encoded once
// in a dedup table and referenced by index, so a district descriptor shared
// by many chunks is stored once and regains shared identity on load.
// Pristine chunks are never written.

const MAGIC = [0x59, 0x52, 0x4d, 0x31] // "YRM1"
const CONTAINER_VERSION = 1
const CODEC_RAW = 0
const CODEC_GZIP = 1

const CELLS = CHUNK * CHUNK

const RLE8_FIELDS = [
  'wallV', 'wallH', 'passageV', 'passageH',
  'wallFeatureV', 'wallFeatureH', 'cols', 'cellKind', 'spaceRole',
]

const DESCRIPTOR_FIELDS = [
  'stairUp', 'stairDown', 'sewerDescriptor',
  'structure', 'structureUp', 'structureDown', 'lethalVoidUp', 'lethalVoidDown',
]

// --- payload ----------------------------------------------------------------

export function serializeMap(map) {
  const w = new ByteWriter(64 * 1024)

  // meta
  w.string(map.meta.name)
  w.string(map.meta.family)
  w.u32(map.meta.seed)
  w.varint(map.meta.worldGenVersion)
  w.varint(map.nextRoomId)

  // rooms
  w.varint(map.rooms.length)
  for (const r of map.rooms) {
    w.varint(r.id)
    w.svarint(r.cy)
    w.svarint(r.x0)
    w.svarint(r.z0)
    w.varint(r.x1 - r.x0)
    w.varint(r.z1 - r.z0)
    w.u8(r.role)
    w.varint(r.salt)
    w.u8(r.baked ? 1 : 0)
    if (!r.door) w.u8(0)
    else {
      w.u8(r.door.axis === 'v' ? 1 : 2)
      w.svarint(r.door.gx)
      w.svarint(r.door.gz)
    }
  }

  // descriptor dedup table, discovered in chunk iteration order
  const chunks = [...map.chunks.values()].filter((d) => !isPristineChunk(d))
  chunks.sort((a, b) => a.cy - b.cy || a.cz - b.cz || a.cx - b.cx)
  const descIndex = new Map() // json -> index
  const descs = []
  const refOf = (value) => {
    if (!value) return -1
    const json = JSON.stringify(value)
    let i = descIndex.get(json)
    if (i === undefined) {
      i = descs.length
      descIndex.set(json, i)
      descs.push(json)
    }
    return i
  }
  const chunkRefs = chunks.map((d) => DESCRIPTOR_FIELDS.map((f) => refOf(d[f])))
  w.varint(descs.length)
  for (const json of descs) w.string(json)

  // chunks
  w.varint(chunks.length)
  chunks.forEach((d, n) => {
    w.svarint(d.cx)
    w.svarint(d.cy)
    w.svarint(d.cz)
    w.u8(d.zone)
    for (const f of RLE8_FIELDS) writeRLE8(w, d[f])
    writeRLEV(w, d.spaceId)
    w.varint(d.lamps.length)
    for (const l of d.lamps) {
      w.u8(l.lx)
      w.u8(l.lz)
      w.u8(l.lit ? 1 : 0)
    }
    w.varint(d.furniture.length)
    for (const f of d.furniture) {
      w.u8(f.kind)
      w.u8(f.lx)
      w.u8(f.lz)
      w.f32(f.x)
      w.f32(f.z)
      w.f32(f.w)
      w.f32(f.d)
      w.u8(f.facing)
    }
    if (d.exit) {
      w.u8(1)
      w.u8(d.exit.lx)
      w.u8(d.exit.lz)
    } else w.u8(0)
    for (const ref of chunkRefs[n]) w.svarint(ref)
  })

  return w.finish()
}

export function deserializeMap(payload) {
  const r = new ByteReader(payload)
  const map = new EditorMap({ name: r.string(), family: r.string(), seed: r.u32() })
  map.meta.worldGenVersion = r.varint()
  map.nextRoomId = r.varint()

  const roomCount = r.varint()
  for (let i = 0; i < roomCount; i++) {
    const room = {
      id: r.varint(),
      cy: r.svarint(),
      x0: r.svarint(),
      z0: r.svarint(),
      x1: 0,
      z1: 0,
      role: 0,
      salt: 0,
      door: null,
      baked: false,
    }
    room.x1 = room.x0 + r.varint()
    room.z1 = room.z0 + r.varint()
    room.role = r.u8()
    room.salt = r.varint()
    room.baked = r.u8() === 1
    const axis = r.u8()
    if (axis) room.door = { axis: axis === 1 ? 'v' : 'h', gx: r.svarint(), gz: r.svarint() }
    map.rooms.push(room)
  }

  const descCount = r.varint()
  const descs = []
  for (let i = 0; i < descCount; i++) descs.push(JSON.parse(r.string()))

  const chunkCount = r.varint()
  for (let i = 0; i < chunkCount; i++) {
    const cx = r.svarint()
    const cy = r.svarint()
    const cz = r.svarint()
    const zone = r.u8()
    const d = new ChunkData(cx, cy, cz, zone, map.meta.worldGenVersion, map.meta.family)
    for (const f of RLE8_FIELDS) d[f].set(readRLE8(r, CELLS))
    d.spaceId.set(readRLEV(r, CELLS))
    const lampCount = r.varint()
    for (let n = 0; n < lampCount; n++) {
      d.lamps.push({ lx: r.u8(), lz: r.u8(), lit: r.u8() === 1 })
    }
    const furnCount = r.varint()
    for (let n = 0; n < furnCount; n++) {
      d.furniture.push({
        kind: r.u8(), lx: r.u8(), lz: r.u8(),
        x: r.f32(), z: r.f32(), w: r.f32(), d: r.f32(),
        facing: r.u8(),
      })
    }
    if (r.u8()) d.exit = { lx: r.u8(), lz: r.u8() }
    for (const f of DESCRIPTOR_FIELDS) {
      const ref = r.svarint()
      if (ref >= 0) {
        if (ref >= descs.length) throw new Error('yrmap: descriptor reference out of range')
        d[f] = descs[ref]
      }
    }
    map.chunks.set(chunkKey3(cx, cy, cz), d)
  }
  return map
}

// --- container (compression + magic) ---------------------------------------

async function pipeThrough(bytes, Transform) {
  const stream = new Blob([bytes]).stream().pipeThrough(new Transform('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

const hasCompression = () =>
  typeof CompressionStream !== 'undefined' && typeof Response !== 'undefined' && typeof Blob !== 'undefined'

export async function encodeMapFile(map, { compress = true } = {}) {
  const payload = serializeMap(map)
  const useGzip = compress && hasCompression()
  const body = useGzip ? await pipeThrough(payload, CompressionStream) : payload
  const w = new ByteWriter(body.length + 8)
  for (const b of MAGIC) w.u8(b)
  w.u8(CONTAINER_VERSION)
  w.u8(useGzip ? CODEC_GZIP : CODEC_RAW)
  w.bytes(body)
  return w.finish()
}

export async function decodeMapFile(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (buf.length < 6 || MAGIC.some((b, i) => buf[i] !== b)) {
    throw new Error('Not a .yrmap file (bad magic)')
  }
  const version = buf[4]
  if (version !== CONTAINER_VERSION) {
    throw new Error(`Unsupported .yrmap container version ${version}`)
  }
  const codec = buf[5]
  let payload = buf.subarray(6)
  if (codec === CODEC_GZIP) {
    if (!hasCompression() || typeof DecompressionStream === 'undefined') {
      throw new Error('This environment cannot decompress gzip .yrmap files')
    }
    payload = await pipeThrough(payload, DecompressionStream)
  } else if (codec !== CODEC_RAW) {
    throw new Error(`Unknown .yrmap codec ${codec}`)
  }
  return deserializeMap(payload)
}
