import { describe, expect, it } from 'vitest'
import { ByteReader, ByteWriter, readRLE8, readRLE16, writeRLE8, writeRLE16 } from '../format/bytes.js'

describe('ByteWriter/ByteReader', () => {
  it('round-trips scalar fields', () => {
    const w = new ByteWriter(4) // force growth
    w.u8(0xab).u16(0x1234).u32(0xdeadbeef).f32(1.5).f64(Math.PI)
    const r = new ByteReader(w.finish())
    expect(r.u8()).toBe(0xab)
    expect(r.u16()).toBe(0x1234)
    expect(r.u32()).toBe(0xdeadbeef)
    expect(r.f32()).toBe(1.5)
    expect(r.f64()).toBe(Math.PI)
    expect(r.remaining).toBe(0)
  })

  it('round-trips varints across the whole safe range', () => {
    const values = [0, 1, 127, 128, 300, 0x7fffffff, 2 ** 31, 2 ** 40 + 17, Number.MAX_SAFE_INTEGER]
    const w = new ByteWriter()
    for (const v of values) w.varint(v)
    const r = new ByteReader(w.finish())
    for (const v of values) expect(r.varint()).toBe(v)
  })

  it('round-trips signed varints via zigzag', () => {
    const values = [0, -1, 1, -64, 64, -100000, 100000, -(2 ** 40)]
    const w = new ByteWriter()
    for (const v of values) w.svarint(v)
    const r = new ByteReader(w.finish())
    for (const v of values) expect(r.svarint()).toBe(v)
  })

  it('rejects invalid varint inputs', () => {
    const w = new ByteWriter()
    expect(() => w.varint(-1)).toThrow()
    expect(() => w.varint(1.5)).toThrow()
    expect(() => w.varint(Number.MAX_SAFE_INTEGER + 2)).toThrow()
  })

  it('round-trips strings with multibyte characters', () => {
    const w = new ByteWriter()
    w.string('yellow — 黄色い部屋 🚪')
    w.string('')
    const r = new ByteReader(w.finish())
    expect(r.string()).toBe('yellow — 黄色い部屋 🚪')
    expect(r.string()).toBe('')
  })

  it('reader throws on truncated data instead of reading garbage', () => {
    const w = new ByteWriter()
    w.u32(42)
    const buf = w.finish().subarray(0, 2)
    const r = new ByteReader(buf)
    expect(() => r.u32()).toThrow(/truncated/)
  })

  it('reader works on a subarray with a nonzero byteOffset', () => {
    const w = new ByteWriter()
    w.u8(0xff).u32(0x01020304)
    const padded = new Uint8Array(w.length + 3)
    padded.set(w.finish(), 3)
    const r = new ByteReader(padded.subarray(3))
    expect(r.u8()).toBe(0xff)
    expect(r.u32()).toBe(0x01020304)
  })
})

describe('RLE codecs', () => {
  it('round-trips u8 layers and compresses runs', () => {
    const layer = new Uint8Array(24 * 24)
    layer.fill(3, 100, 400)
    layer[0] = 7
    const w = new ByteWriter()
    writeRLE8(w, layer)
    const encoded = w.finish()
    expect(encoded.length).toBeLessThan(32)
    const out = readRLE8(new ByteReader(encoded), layer.length)
    expect(out).toEqual(layer)
  })

  it('round-trips worst-case alternating u8 data', () => {
    const layer = new Uint8Array(97).map((_, i) => i % 2 ? 200 : 13)
    const w = new ByteWriter()
    writeRLE8(w, layer)
    expect(readRLE8(new ByteReader(w.finish()))).toEqual(layer)
  })

  it('round-trips u16 layers', () => {
    const layer = new Uint16Array(24 * 24)
    layer.fill(999, 10, 500)
    layer[576 - 1] = 40000
    const w = new ByteWriter()
    writeRLE16(w, layer)
    expect(readRLE16(new ByteReader(w.finish()), layer.length)).toEqual(layer)
  })

  it('rejects a length mismatch and run overflow', () => {
    const w = new ByteWriter()
    writeRLE8(w, new Uint8Array(10))
    expect(() => readRLE8(new ByteReader(w.finish()), 11)).toThrow(/length/)

    const bad = new ByteWriter()
    bad.varint(4) // claims 4 cells
    bad.varint(9) // but a run of 9
    bad.u8(1)
    expect(() => readRLE8(new ByteReader(bad.finish()))).toThrow(/overflow/)
  })

  it('handles empty layers', () => {
    const w = new ByteWriter()
    writeRLE8(w, new Uint8Array(0))
    expect(readRLE8(new ByteReader(w.finish()))).toEqual(new Uint8Array(0))
  })
})
