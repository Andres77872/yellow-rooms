// Binary primitives for the .yrmap format: a growable little-endian writer,
// its mirror reader, and a byte-run RLE codec for tile layers.
//
// Varints are unsigned LEB128; signed values go through zigzag so small
// negative coordinates stay short.

export class ByteWriter {
  constructor(initial = 1024) {
    this._buf = new Uint8Array(initial)
    this._view = new DataView(this._buf.buffer)
    this.length = 0
  }

  _ensure(extra) {
    if (this.length + extra <= this._buf.length) return
    let size = this._buf.length * 2
    while (size < this.length + extra) size *= 2
    const next = new Uint8Array(size)
    next.set(this._buf.subarray(0, this.length))
    this._buf = next
    this._view = new DataView(next.buffer)
  }

  u8(v) { this._ensure(1); this._buf[this.length++] = v & 0xff; return this }
  u16(v) { this._ensure(2); this._view.setUint16(this.length, v, true); this.length += 2; return this }
  u32(v) { this._ensure(4); this._view.setUint32(this.length, v >>> 0, true); this.length += 4; return this }
  f32(v) { this._ensure(4); this._view.setFloat32(this.length, v, true); this.length += 4; return this }
  f64(v) { this._ensure(8); this._view.setFloat64(this.length, v, true); this.length += 8; return this }

  varint(v) {
    if (!Number.isSafeInteger(v) || v < 0) throw new Error(`varint expects a non-negative safe integer, got ${v}`)
    this._ensure(10)
    while (v > 0x7fffffff) { // stay in float math above 2^31, bit math below
      this._buf[this.length++] = (v % 128) | 0x80
      v = Math.floor(v / 128)
    }
    while (v >= 0x80) {
      this._buf[this.length++] = (v & 0x7f) | 0x80
      v >>>= 7
    }
    this._buf[this.length++] = v
    return this
  }

  svarint(v) {
    return this.varint(v < 0 ? -v * 2 - 1 : v * 2)
  }

  bytes(arr) {
    this._ensure(arr.length)
    this._buf.set(arr, this.length)
    this.length += arr.length
    return this
  }

  string(s) {
    const enc = new TextEncoder().encode(s)
    this.varint(enc.length)
    return this.bytes(enc)
  }

  finish() {
    return this._buf.slice(0, this.length)
  }
}

export class ByteReader {
  constructor(buf) {
    this._buf = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
    this._view = new DataView(this._buf.buffer, this._buf.byteOffset, this._buf.byteLength)
    this.offset = 0
  }

  get remaining() { return this._buf.length - this.offset }

  _need(n) {
    if (this.offset + n > this._buf.length) throw new Error('yrmap: truncated data')
  }

  u8() { this._need(1); return this._buf[this.offset++] }
  u16() { this._need(2); const v = this._view.getUint16(this.offset, true); this.offset += 2; return v }
  u32() { this._need(4); const v = this._view.getUint32(this.offset, true); this.offset += 4; return v }
  f32() { this._need(4); const v = this._view.getFloat32(this.offset, true); this.offset += 4; return v }
  f64() { this._need(8); const v = this._view.getFloat64(this.offset, true); this.offset += 8; return v }

  varint() {
    let v = 0
    let shift = 1
    for (let i = 0; i < 8; i++) {
      const b = this.u8()
      v += (b & 0x7f) * shift
      if ((b & 0x80) === 0) {
        if (!Number.isSafeInteger(v)) throw new Error('yrmap: varint overflow')
        return v
      }
      shift *= 128
    }
    throw new Error('yrmap: varint too long')
  }

  svarint() {
    const v = this.varint()
    return v % 2 === 0 ? v / 2 : -(v + 1) / 2
  }

  bytes(n) {
    this._need(n)
    const out = this._buf.subarray(this.offset, this.offset + n)
    this.offset += n
    return out
  }

  string() {
    const len = this.varint()
    return new TextDecoder().decode(this.bytes(len))
  }
}

// Run-length codec for Uint8Array tile layers: (runLength varint, value u8)
// pairs. Tile grids are dominated by long solid/empty runs, so this typically
// shrinks a 24×24 layer to a handful of bytes.
export function writeRLE8(writer, arr) {
  writer.varint(arr.length)
  let i = 0
  while (i < arr.length) {
    const v = arr[i]
    let j = i + 1
    while (j < arr.length && arr[j] === v) j++
    writer.varint(j - i)
    writer.u8(v)
    i = j
  }
}

export function readRLE8(reader, ExpectedLength = null) {
  const length = reader.varint()
  if (ExpectedLength !== null && length !== ExpectedLength) {
    throw new Error(`yrmap: RLE layer length ${length}, expected ${ExpectedLength}`)
  }
  const out = new Uint8Array(length)
  let i = 0
  while (i < length) {
    const run = reader.varint()
    const v = reader.u8()
    if (i + run > length) throw new Error('yrmap: RLE run overflow')
    out.fill(v, i, i + run)
    i += run
  }
  return out
}

// Varint-valued variant for wide layers (e.g. the Uint32 space-id raster,
// whose values are sparse but unbounded).
export function writeRLEV(writer, arr) {
  writer.varint(arr.length)
  let i = 0
  while (i < arr.length) {
    const v = arr[i]
    let j = i + 1
    while (j < arr.length && arr[j] === v) j++
    writer.varint(j - i)
    writer.varint(v)
    i = j
  }
}

export function readRLEV(reader, ExpectedLength = null, Ctor = Uint32Array) {
  const length = reader.varint()
  if (ExpectedLength !== null && length !== ExpectedLength) {
    throw new Error(`yrmap: RLE layer length ${length}, expected ${ExpectedLength}`)
  }
  const out = new Ctor(length)
  let i = 0
  while (i < length) {
    const run = reader.varint()
    const v = reader.varint()
    if (i + run > length) throw new Error('yrmap: RLE run overflow')
    out.fill(v, i, i + run)
    i += run
  }
  return out
}

// 16-bit variant for layers that need more than 256 states (e.g. space ids).
export function writeRLE16(writer, arr) {
  writer.varint(arr.length)
  let i = 0
  while (i < arr.length) {
    const v = arr[i]
    let j = i + 1
    while (j < arr.length && arr[j] === v) j++
    writer.varint(j - i)
    writer.u16(v)
    i = j
  }
}

export function readRLE16(reader, ExpectedLength = null) {
  const length = reader.varint()
  if (ExpectedLength !== null && length !== ExpectedLength) {
    throw new Error(`yrmap: RLE layer length ${length}, expected ${ExpectedLength}`)
  }
  const out = new Uint16Array(length)
  let i = 0
  while (i < length) {
    const run = reader.varint()
    const v = reader.u16()
    if (i + run > length) throw new Error('yrmap: RLE run overflow')
    out.fill(v, i, i + run)
    i += run
  }
  return out
}
