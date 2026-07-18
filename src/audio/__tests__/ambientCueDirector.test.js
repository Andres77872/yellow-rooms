import { describe, expect, it } from 'vitest'
import { AmbientCueDirector } from '../ambientCueDirector.js'

const simulate = (seed) => {
  const director = new AmbientCueDirector(seed)
  const events = []
  for (let frame = 0; frame < 1200; frame++) {
    const threat = frame >= 240 && frame < 280
    const vertical = frame >= 700 && frame < 716
    const event = director.update(0.1, {
      tension: threat ? 0.8 : 0,
      seen: threat,
      realVerticalCue: vertical,
    })
    if (event) events.push([frame, event])
  }
  return events
}

describe('ambient cue director', () => {
  it('replays the same paced cue opportunities for the same level seed', () => {
    const first = simulate(0x51a7)
    expect(first.length).toBeGreaterThan(0)
    expect(simulate(0x51a7)).toEqual(first)
    expect(simulate(0x51a8)).not.toEqual(first)
  })

  it('suppresses fake-outs throughout sustained threat', () => {
    const director = new AmbientCueDirector(7, {
      recoverySeconds: 0,
      initialWait: [0, 0],
      interval: [0.1, 0.1],
      abstainChance: 0,
    })
    for (let i = 0; i < 100; i++) {
      expect(director.update(0.1, { tension: 0.8, seen: true })).toBeNull()
    }
  })

  it('requires uninterrupted recovery after threat or a real vertical cue', () => {
    const options = {
      recoverySeconds: 6,
      initialWait: [0, 0],
      interval: [20, 20],
      abstainChance: 0,
    }
    for (const blocked of [
      { seen: true },
      { tension: 0.8 },
      { realVerticalCue: true },
    ]) {
      const director = new AmbientCueDirector(9, options)
      expect(director.update(1, blocked)).toBeNull()
      for (let second = 0; second < 5; second++) {
        expect(director.update(1)).toBeNull()
      }
      expect(director.update(0.99)).toBeNull()
      expect(director.update(0.01)).toBe('distant')
    }
  })

  it('obeys its minimum interval and reproduces after reset', () => {
    const options = {
      recoverySeconds: 0,
      initialWait: [2, 2],
      interval: [3, 3],
      abstainChance: 0,
    }
    const director = new AmbientCueDirector(11, options)
    const collect = () => {
      const events = []
      let time = 0
      for (let i = 0; i < 80; i++) {
        time += 0.25
        if (director.update(0.25) === 'distant') events.push(time)
      }
      return events
    }
    const first = collect()
    for (let i = 1; i < first.length; i++) {
      expect(first[i] - first[i - 1]).toBeGreaterThanOrEqual(3)
    }
    director.reset(11)
    expect(collect()).toEqual(first)
  })

  it('can abstain instead of making every opportunity audible', () => {
    const alwaysAbstain = new AmbientCueDirector(13, {
      recoverySeconds: 0,
      initialWait: [0, 0],
      interval: [1, 1],
      abstainChance: 1,
    })
    expect(alwaysAbstain.update(0.1)).toBe('abstain')
    expect(alwaysAbstain.update(1)).toBe('abstain')

    const neverAbstain = new AmbientCueDirector(13, {
      recoverySeconds: 0,
      initialWait: [0, 0],
      interval: [1, 1],
      abstainChance: 0,
    })
    expect(neverAbstain.update(0.1)).toBe('distant')
  })
})
