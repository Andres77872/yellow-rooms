import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AudioBus } from '../AudioBus.js'

const shared = vi.hoisted(() => ({ context: null, listener: null }))

vi.mock('three', () => ({
  AudioListener: class {
    constructor() {
      this.context = shared.context
      this.gain = { disconnect: vi.fn() }
      this.removeFromParent = vi.fn()
      shared.listener = this
    }
  },
}))

function audioContext() {
  const param = () => ({
    value: 0,
    setValueAtTime: vi.fn(),
    setTargetAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
  })
  const nodes = []
  const node = (source = false) => {
    const n = {
      connect: vi.fn(), disconnect: vi.fn(),
      gain: param(), frequency: param(), detune: param(), Q: param(),
      threshold: param(), ratio: param(), attack: param(), release: param(),
      playbackRate: param(), pan: param(),
    }
    if (source) {
      n.start = vi.fn()
      n.stop = vi.fn()
    }
    nodes.push(n)
    return n
  }
  return {
    nodes,
    currentTime: 0,
    sampleRate: 1000,
    destination: {},
    resume: vi.fn().mockResolvedValue(),
    close: vi.fn(),
    createGain: () => node(),
    createBiquadFilter: () => node(),
    createDynamicsCompressor: () => node(),
    createConvolver: () => node(),
    createStereoPanner: () => node(),
    createOscillator: () => node(true),
    createBufferSource: () => node(true),
    createBuffer: (channels, length) => {
      const data = Array.from({ length: channels }, () => new Float32Array(length))
      return { getChannelData: (channel) => data[channel] }
    },
  }
}

beforeEach(() => {
  shared.context = audioContext()
})

describe('AudioBus lifetime', () => {
  it('stops every permanent loop and disconnects the graph without closing the shared context', async () => {
    const bus = new AudioBus({ add: vi.fn() })
    await bus.start()
    const sources = shared.context.nodes.filter((node) => node.start)
    expect(sources).toHaveLength(11)
    expect(sources.every((node) => node.start.mock.calls.length === 1)).toBe(true)

    bus.dispose()
    bus.dispose()
    await bus.start()

    expect(sources.every((node) => node.stop.mock.calls.length === 1)).toBe(true)
    expect(shared.context.nodes.every((node) => node.disconnect.mock.calls.length === 1)).toBe(true)
    expect(shared.context.close).not.toHaveBeenCalled()
    expect(shared.context.resume).toHaveBeenCalledOnce()
    expect(shared.listener.gain.disconnect).toHaveBeenCalledOnce()
    expect(shared.listener.removeFromParent).toHaveBeenCalledOnce()
    expect(bus.started).toBe(false)
    expect(bus.whiteBuf).toBeNull()
    expect(bus.convolver.buffer).toBeNull()
  })

  it('cannot create oscillator banks after disposal while context resume is pending', async () => {
    let resume
    shared.context.resume.mockImplementation(() => new Promise((resolve) => { resume = resolve }))
    const bus = new AudioBus({ add: vi.fn() })
    const starting = bus.start()
    bus.dispose()
    resume()
    await starting

    expect(shared.context.nodes.some((node) => node.start)).toBe(false)
    expect(bus.started).toBe(false)
    expect(shared.context.close).not.toHaveBeenCalled()
  })

  it('retires completed one-shot nodes and cancels still-scheduled voices at teardown', async () => {
    const bus = new AudioBus({ add: vi.fn() })
    await bus.start()
    const permanentCount = bus._nodes.size

    bus._noiseVoice({ vol: 0.1, dur: 0.2 })
    const completed = shared.context.nodes.find((node) => node.onended)
    expect(bus.voices).toBe(1)
    completed.onended()
    expect(bus.voices).toBe(0)
    expect(bus._nodes.size).toBe(permanentCount)

    bus._ringVoice({ freqs: [80, 120], vols: [0.1], dur: 0.2, at: 1 })
    bus._heartbeat()
    const pending = [...bus._nodes].filter((node) => node.start && node.onended)
    expect(pending.length).toBeGreaterThan(1)
    bus.dispose()

    expect(bus.voices).toBe(0)
    expect(bus._nodes.size).toBe(0)
    expect(pending.every((node) => node.onended === null)).toBe(true)
    expect(completed.disconnect).toHaveBeenCalledOnce()
  })
})
