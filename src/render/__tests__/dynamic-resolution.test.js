import { describe, expect, it } from 'vitest'
import {
  DRS_UP_BLOCK_MAX_MS,
  DRS_UP_BLOCK_RAF_MS,
  DynamicResolution,
  drsCeiling,
} from '../DynamicResolution.js'

// Synthetic frame loop: the GPU cost model gets the current scale, the frame
// interval is the slower of GPU and CPU work rounded up to vsync (so a 20 ms
// frame on a 60 Hz panel is a 33 ms interval, like a real swap chain).
function simulate(drs, {
  seconds,
  start = 0,
  gpuMs,
  mode = 'gpu',
  displayHz = 60,
  cpuMs = 0,
  withInterval = true,
  tension = () => 0,
  flags = () => ({}),
}) {
  const vsync = 1000 / displayHz
  const events = []
  const scales = []
  let t = start
  let frame = 0
  while (t < start + seconds * 1000) {
    const g = gpuMs(drs.scale, t, frame)
    const interval = Math.max(1, Math.ceil(Math.max(g, cpuMs) / vsync - 1e-9)) * vsync
    t += interval
    const from = drs.scale
    const extra = flags(t, frame)
    const r = mode === 'gpu'
      ? drs.sample(extra.ms ?? g, { now: t, intervalMs: withInterval ? interval : undefined, tension: tension(t), ...extra })
      : drs.sample(extra.ms ?? interval, { now: t, gpu: false, tension: tension(t), ...extra })
    if (r !== null) events.push({ t, from, to: r, upBlock: drs.upBlockMs })
    scales.push(drs.scale)
    frame++
  }
  return { t, events, scales }
}

const onGrid = (s) => Math.abs(s * 20 - Math.round(s * 20)) < 1e-9
const ups = (events) => events.filter((e) => e.to > e.from)
const downs = (events) => events.filter((e) => e.to < e.from)

// Deterministic +-3% jitter so percentiles are not degenerate.
const jitter = (f) => 1 + 0.03 * Math.sin(f * 1.7)

describe('DynamicResolution bounds', () => {
  it('starts at the ceiling and derives the floor from native lines', () => {
    const drs = new DynamicResolution()
    expect(drs.scale).toBe(1)
    expect(drs.floor).toBe(0.6)
    expect(drs.budgetMs).toBeCloseTo(16.667, 3)
    expect(new DynamicResolution({ nativeLines: 720 }).floor).toBe(0.75)
    expect(new DynamicResolution({ nativeLines: 2160 }).floor).toBe(0.6)
    // 540/800 = 0.675 rounds UP onto the grid: never below 540 lines.
    expect(new DynamicResolution({ nativeLines: 800 }).floor).toBe(0.7)
    // A tiny window cannot drop below its own ceiling.
    expect(new DynamicResolution({ nativeLines: 400 }).floor).toBe(1)
    expect(new DynamicResolution({ ceiling: 0.5 }).floor).toBe(0.5)
    // The display caps the budget: 60 fps target on a 50 Hz panel = 20 ms.
    expect(new DynamicResolution({ displayHz: 50 }).budgetMs).toBe(20)
    expect(new DynamicResolution({ displayHz: 144, targetFps: 60 }).budgetMs).toBeCloseTo(16.667, 3)
  })

  it('configure clamps into the new bounds and reports the change', () => {
    const drs = new DynamicResolution({ ceiling: 0.9 })
    expect(drs.scale).toBe(0.9)
    expect(drs.configure({ ceiling: 0.8 })).toBe(0.8)
    expect(drs.configure({ ceiling: 1 })).toBeNull() // raised ceiling: climb, don't jump
    expect(drs.scale).toBe(0.8)
    const low = new DynamicResolution({ ceiling: 0.6 })
    low.configure({ ceiling: 1 })
    expect(low.configure({ nativeLines: 720 })).toBe(0.75) // floor rose above the scale
    expect(low.configure({ ceiling: Number.NaN, nativeLines: -1 })).toBeNull() // garbage ignored
    expect(low.reset(0, { toCeiling: true })).toBe(1)
  })

  it('heavy load never goes below the floor, light load never above the ceiling', () => {
    const heavy = new DynamicResolution({ nativeLines: 720 })
    const h = simulate(heavy, { seconds: 60, gpuMs: (s, t, f) => 60 * s * s * jitter(f) })
    expect(heavy.scale).toBe(0.75)
    expect(Math.min(...h.scales)).toBe(0.75)

    const light = new DynamicResolution({ ceiling: 0.9 })
    const l = simulate(light, { seconds: 60, gpuMs: () => 3 })
    expect(Math.max(...l.scales)).toBe(0.9)
    expect(l.events).toEqual([])
  })
})

describe('DynamicResolution traces', () => {
  it('steady over budget converges down and stops', () => {
    // 22 ms at native (1.3T): 0.8 costs 14.1 ms, inside 0.9T, outside the
    // 0.72T up-line — the controller must settle there and stay.
    const drs = new DynamicResolution()
    const { events, scales } = simulate(drs, { seconds: 90, gpuMs: (s, t, f) => 22 * s * s * jitter(f) })
    expect(drs.scale).toBe(0.8)
    expect(events.length).toBeLessThanOrEqual(3)
    expect(ups(events)).toEqual([])
    expect(events[events.length - 1].t).toBeLessThan(15000)
    expect(scales.every(onGrid)).toBe(true)
    // At most one steady-state change per 5 s.
    for (let i = 1; i < events.length; i++) expect(events[i].t - events[i - 1].t).toBeGreaterThanOrEqual(5000)
  })

  it('panics down ~10% per second under a sudden overload', () => {
    const drs = new DynamicResolution()
    const { events } = simulate(drs, { seconds: 20, gpuMs: (s) => 60 * s * s })
    expect(drs.scale).toBe(0.6)
    expect(events.map((e) => e.to)).toEqual([0.9, 0.8, 0.7, 0.65, 0.6])
    for (let i = 1; i < events.length; i++) {
      const gap = events[i].t - events[i - 1].t
      expect(gap).toBeGreaterThanOrEqual(1000) // never twice within 1 s
      expect(gap).toBeLessThan(5000) // but it does bypass the 5 s gate
    }
  })

  it('steady under budget climbs back to the ceiling slowly', () => {
    const drs = new DynamicResolution({ ceiling: 0.6 })
    drs.configure({ ceiling: 1 })
    const { events } = simulate(drs, { seconds: 80, gpuMs: (s, t, f) => 6 * s * s * jitter(f) })
    expect(drs.scale).toBe(1)
    expect(events.map((e) => e.to)).toEqual([0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1])
    expect(events[0].t).toBeGreaterThanOrEqual(5000)
    for (let i = 1; i < events.length; i++) expect(events[i].t - events[i - 1].t).toBeGreaterThanOrEqual(5000)
    // 8 steps from 0.6 take at least 40 s: slow on purpose.
    expect(events[events.length - 1].t).toBeGreaterThanOrEqual(40000)
  })

  // Light at 8 ms / heavy at 30 ms (1.8T) at native, [light s, heavy s]: the
  // scale that survives the light phase is over budget in the heavy one.
  // Before the 60 s probation, 4/1, 10/0.5 and 15/0.5 flipped every ~5 s
  // forever (85-120 changes per 600 s) with the back-off stuck at 5 s.
  it.each([
    [4, 1],
    [6, 0.5],
    [6, 2],
    [10, 0.5],
    [15, 0.5],
    [5, 2],
    [30, 2],
  ])('periodic gpu load %s s light / %s s heavy backs off instead of ping-ponging', (light, heavy) => {
    const period = (light + heavy) * 1000
    const drs = new DynamicResolution()
    const { events } = simulate(drs, {
      seconds: 600,
      gpuMs: (s, t) => (t % period < light * 1000 ? 8 : 30) * s * s,
    })
    for (let i = 1; i < events.length; i++) expect(events[i].t - events[i - 1].t).toBeGreaterThanOrEqual(1000)
    // The back-off engaged and saturated...
    expect(drs.upBlockMs).toBe(DRS_UP_BLOCK_MAX_MS)
    // ...so the second half is at most one up/down pair per 60 s block.
    const late = events.filter((e) => e.t > 300000)
    expect(late.length).toBeLessThanOrEqual(10)
    const lateUps = ups(late)
    for (let i = 1; i < lateUps.length; i++) expect(lateUps[i].t - lateUps[i - 1].t).toBeGreaterThanOrEqual(60000)
    // Every up-step waited the saturated upBlock after the previous change.
    for (const e of lateUps) {
      const prev = events[events.indexOf(e) - 1]
      expect(e.t - prev.t).toBeGreaterThanOrEqual(DRS_UP_BLOCK_MAX_MS)
    }
  })

  it('a load slower than the probation is still followed', () => {
    // 70 s light / 2 s heavy: real, long-lived load changes. Tracking them is
    // what DRS is for, so the back-off must not saturate here.
    const drs = new DynamicResolution()
    const { scales } = simulate(drs, { seconds: 600, gpuMs: (s, t) => (t % 72000 < 70000 ? 8 : 30) * s * s })
    expect(drs.upBlockMs).toBeLessThan(DRS_UP_BLOCK_MAX_MS)
    expect(scales.filter((s) => s === 1).length / scales.length).toBeGreaterThan(0.4)
  })

  it('a calm stretch relaxes the back-off after the fact', () => {
    // Saturate the back-off with a fast oscillation, then 5 calm minutes.
    const drs = new DynamicResolution()
    const osc = simulate(drs, { seconds: 300, gpuMs: (s, t) => (t % 5000 < 4000 ? 8 : 30) * s * s })
    expect(drs.upBlockMs).toBe(DRS_UP_BLOCK_MAX_MS)
    const low = drs.scale
    const calm = simulate(drs, { seconds: 300, start: osc.t, gpuMs: (s, t, f) => 6 * s * s * jitter(f) })
    expect(downs(calm.events)).toEqual([])
    expect(drs.scale).toBe(1)
    // Each step held a full 60 s probation, so the waits shrink: 60 s, then
    // 30 s, 15 s, ... instead of 60 s per step all the way up.
    const waits = calm.events.slice(1).map((e, i) => e.t - calm.events[i].t)
    expect(waits.length).toBe(Math.round((1 - low) / 0.05) - 1)
    expect(waits[waits.length - 1]).toBeLessThan(waits[0])
    expect(drs.upBlockMs).toBeLessThan(DRS_UP_BLOCK_MAX_MS)
  })

  it('rAF mode probes, reverts on missed frames and backs off to 60 s', () => {
    // Above 0.8 every 10th frame misses vsync (10% > 3%), never 3 in a row
    // (no panic), so every probe must be reverted after its 2 s window.
    const drs = new DynamicResolution({ ceiling: 0.8 })
    drs.configure({ ceiling: 1 })
    const { events } = simulate(drs, {
      seconds: 300,
      mode: 'raf',
      gpuMs: (s, t, f) => (s > 0.8 + 1e-9 && f % 10 === 0 ? 20 : 12),
    })
    const probes = ups(events)
    const reverts = downs(events)
    expect(probes.length).toBe(reverts.length)
    expect(probes[0].t).toBeGreaterThanOrEqual(DRS_UP_BLOCK_RAF_MS)
    probes.forEach((p, i) => {
      expect(reverts[i].to).toBe(p.from)
      expect(reverts[i].t - p.t).toBeGreaterThanOrEqual(2000)
      expect(reverts[i].t - p.t).toBeLessThan(2500)
    })
    // Wait between a revert and the next probe: 20 s, 40 s, then capped 60 s.
    const waits = probes.slice(1).map((p, i) => p.t - reverts[i].t)
    const expected = [20000, 40000, 60000, 60000, 60000]
    waits.forEach((w, i) => {
      expect(w).toBeGreaterThanOrEqual(expected[i])
      expect(w).toBeLessThan(expected[i] + 1000)
    })
    expect(drs.scale).toBe(0.8)
  })

  it('rAF mode settles below a hard edge: a failed probe returns to its start', () => {
    // 22 ms at native, 60 Hz: 0.85 costs 15.9 ms (holds vsync), 0.9 costs
    // 17.8 ms (every frame misses, so the probe hits the 1 s panic before its
    // 2 s verdict). That panic must revert to 0.85, not cut 10% to 0.8, and
    // every such failure must double the wait until it saturates at 60 s.
    const drs = new DynamicResolution()
    const { events, scales } = simulate(drs, { seconds: 600, mode: 'raf', gpuMs: (s) => 22 * s * s })
    const settled = events.findIndex((e) => e.to === 0.85)
    expect(settled).toBeGreaterThan(0)
    expect(events[settled].t).toBeLessThan(30000)
    for (const e of downs(events.slice(settled))) {
      expect(e.from).toBe(0.9)
      expect(e.to).toBe(0.85)
    }
    const after = scales.slice(scales.length - Math.floor(scales.length / 2))
    expect(Math.min(...after)).toBe(0.85)
    expect(after.filter((s) => s === 0.85).length / after.length).toBeGreaterThan(0.95)
    expect(drs.upBlockMs).toBe(DRS_UP_BLOCK_MAX_MS)
    // One probe + one revert per 60 s block at most, in the second half.
    expect(events.filter((e) => e.t > 300000).length).toBeLessThanOrEqual(10)
  })

  it('caps the back-off per mode, so one halving is visible in raf mode too', () => {
    // Saturate in gpu mode (5 s x 12), then run calm in raf mode (10 s base):
    // the factor must clamp to 6, so 60 s of held probes halves it to 30 s.
    const drs = new DynamicResolution()
    const osc = simulate(drs, { seconds: 300, gpuMs: (s, t) => (t % 5000 < 4000 ? 8 : 30) * s * s })
    expect(drs.upBlockMs).toBe(DRS_UP_BLOCK_MAX_MS)
    const blocks = new Set()
    simulate(drs, {
      seconds: 200,
      start: osc.t,
      mode: 'raf',
      gpuMs: () => 10,
      flags: () => {
        blocks.add(drs.upBlockMs)
        return {}
      },
    })
    expect(blocks.has(DRS_UP_BLOCK_MAX_MS)).toBe(true)
    expect(blocks.has(DRS_UP_BLOCK_MAX_MS / 2)).toBe(true)
  })

  it('rAF mode keeps a probe that holds and climbs every upBlock', () => {
    const drs = new DynamicResolution({ ceiling: 0.8 })
    drs.configure({ ceiling: 1 })
    const { events } = simulate(drs, { seconds: 60, mode: 'raf', gpuMs: () => 10 })
    expect(events.map((e) => e.to)).toEqual([0.85, 0.9, 0.95, 1])
    expect(downs(events)).toEqual([])
    for (let i = 1; i < events.length; i++) expect(events[i].t - events[i - 1].t).toBeGreaterThanOrEqual(10000)
  })

  it('a CPU-bound trace never lowers the scale', () => {
    // CPU takes 25 ms (interval > T) while the GPU idles at 8 ms with bursts
    // of 3 frames at 30 ms that would trigger a panic on their own. (The
    // guard needs a filled ring of evidence first; the 1 s boot window drops
    // frames 0-29, so the first burst is at frame 60.)
    const gpuMs = (s, t, f) => (f >= 60 && f % 60 < 3 ? 30 : 8)
    const drs = new DynamicResolution()
    const { events } = simulate(drs, { seconds: 60, gpuMs, cpuMs: 25 })
    expect(events.filter((e) => e.to < e.from)).toEqual([])
    expect(drs.scale).toBe(1)
    expect(drs.cpuBound).toBe(true)

    // Control: the same GPU trace without the interval evidence does panic.
    const blind = new DynamicResolution()
    const b = simulate(blind, { seconds: 60, gpuMs, cpuMs: 25, withInterval: false })
    expect(downs(b.events).length).toBeGreaterThan(0)
  })

  it('ignores stalls, paused frames and hitch-flagged frames', () => {
    const drs = new DynamicResolution()
    const { events } = simulate(drs, {
      seconds: 60,
      gpuMs: () => 8,
      flags: (t, f) => {
        const k = f % 120
        if (k < 3) return { ms: 400 } // > 250 ms: tab switch / compile stall
        if (k < 6) return { ms: 40, hitch: true } // chunk streaming spike
        if (k < 9) return { ms: 40, paused: true }
        return {}
      },
    })
    expect(events).toEqual([])
    expect(drs.scale).toBe(1)
    expect(drs.dropped).toBeGreaterThan(200)

    // Garbage never counts either.
    const g = new DynamicResolution()
    for (const bad of [Number.NaN, -1, Infinity, undefined]) expect(g.sample(bad, { now: 10 })).toBeNull()
    expect(g.dropped).toBe(4)
  })

  it('tension blocks increases', () => {
    const drs = new DynamicResolution({ ceiling: 0.6 })
    drs.configure({ ceiling: 1 })
    const tense = simulate(drs, { seconds: 60, gpuMs: () => 4, tension: () => 0.8 })
    expect(tense.events).toEqual([])
    expect(drs.scale).toBe(0.6)
    const calm = simulate(drs, { seconds: 20, start: tense.t, gpuMs: () => 4, tension: () => 0.3 })
    expect(calm.events.length).toBeGreaterThan(0)
    expect(drs.scale).toBeGreaterThan(0.6)
  })

  it('ignores the first second of boot frames even without reset()', () => {
    // Shader compiles and uploads (< 250 ms each) must not cost a step: a
    // 20 ms trace changed scale 0.53 s after construction before this.
    const drs = new DynamicResolution()
    const boot = simulate(drs, { seconds: 1, gpuMs: () => 60 })
    expect(boot.events).toEqual([])
    expect(drs.dropped).toBe(boot.scales.length)
    // Up-steps count their wait from the first sample too.
    const up = new DynamicResolution({ ceiling: 0.6 })
    up.configure({ ceiling: 1 })
    const { events } = simulate(up, { seconds: 10, start: 30000, gpuMs: () => 4 })
    expect(events[0].t).toBeGreaterThanOrEqual(30000 + 5000)
  })

  it('reset drops samples and ignores the next second', () => {
    const drs = new DynamicResolution()
    drs.sample(8, { now: 0 }) // opens the boot window until 1000
    expect(drs.sample(60, { now: 1100 })).toBeNull()
    expect(drs.sample(60, { now: 1116 })).toBeNull() // a streak of 2...
    drs.reset(1200)
    // Inside the 1 s window: even a panic-level streak is ignored.
    for (let t = 1300; t < 2200; t += 100) expect(drs.sample(60, { now: t })).toBeNull()
    expect(drs.scale).toBe(1)
    // After it, one heavy frame does not complete the pre-reset streak...
    expect(drs.sample(60, { now: 2216 })).toBeNull()
    expect(drs.sample(60, { now: 2232 })).toBeNull()
    // ...but three fresh ones panic.
    expect(drs.sample(60, { now: 2248 })).toBe(0.9)
  })

  it('switching measurement mode never mixes GPU ms with rAF intervals', () => {
    const drs = new DynamicResolution()
    drs.reset(-1000) // start past the boot window
    drs.sample(60, { now: 0 })
    drs.sample(60, { now: 16 })
    expect(drs.sample(60, { now: 32, gpu: false })).toBeNull()
    expect(drs.mode).toBe('raf')
    expect(drs.sample(60, { now: 48, gpu: false })).toBeNull()
    expect(drs.sample(60, { now: 64, gpu: false })).toBe(0.9)
  })

  it('gpu frames without a timer result are skipped, not guessed', () => {
    // Engine contract: ms = null when the query has no result. One frame in
    // eight without a result must not move an idle GPU (substituting the
    // 16.7 ms rAF interval there walked it to the floor).
    const drs = new DynamicResolution()
    const { events } = simulate(drs, {
      seconds: 120,
      gpuMs: (s, t, f) => 6 * s * s * jitter(f),
      flags: (t, f) => (f % 8 === 0 ? { ms: null } : {}),
    })
    expect(events).toEqual([])
    expect(drs.scale).toBe(1)
  })

  it('keeps every scale on the 0.05 grid', () => {
    const drs = new DynamicResolution({ ceiling: 0.95, nativeLines: 1440 })
    const { scales } = simulate(drs, {
      seconds: 120,
      gpuMs: (s, t, f) => (t % 20000 < 10000 ? 26 : 5) * s * s * jitter(f),
    })
    expect(scales.every(onGrid)).toBe(true)
    expect(Math.min(...scales)).toBeGreaterThanOrEqual(drs.floor)
    expect(Math.max(...scales)).toBeLessThanOrEqual(0.95)
  })
})

describe('DynamicResolution ceiling and starvation', () => {
  it('drsCeiling puts the preset render scale in native terms', () => {
    // 1080p, DPR 1: the budget clamp does not bind, 0.75 stays 0.75.
    expect(drsCeiling(0.75, 1)).toBe(0.75)
    expect(drsCeiling(1, 1)).toBe(1)
    // 2560x1440 at DPR 2: the fixed path renders 'low' at the clamped native
    // 1.5 anyway, so its DRS ceiling is 1, not 0.75 of native.
    expect(drsCeiling(1.5, 1.5)).toBe(1)
    // Off-grid ratios round UP (never below the fixed path), capped at 1.
    expect(drsCeiling(1.2, 1.5)).toBe(0.8)
    expect(drsCeiling(1.21, 1.5)).toBe(0.85)
    expect(drsCeiling(2, 1.5)).toBe(1)
    expect(drsCeiling(Number.NaN, 1)).toBe(1)
    expect(drsCeiling(1, 0)).toBe(1)
  })

  it('an idle GPU is never starved where the floor equals the ceiling', () => {
    // 540 native lines (a phone in landscape): floor = ceiling = 1, so the
    // scale "sits at the floor" from the first frame with no load at all.
    const drs = new DynamicResolution({ nativeLines: 540 })
    expect(drs.floor).toBe(drs.ceiling)
    let starved = 0
    simulate(drs, { seconds: 30, gpuMs: () => 6, flags: () => (drs.starved ? (starved++, {}) : {}) })
    expect(starved).toBe(0)
    expect(drs.starved).toBe(false)
  })

  it('a real overload at the floor is starved, also where floor equals ceiling', () => {
    const phone = new DynamicResolution({ nativeLines: 540 })
    simulate(phone, { seconds: 8, gpuMs: (s, t, f) => 30 * jitter(f) })
    expect(phone.scale).toBe(1)
    expect(phone.starved).toBe(true)

    // Above the floor an overload steps down instead; starved only once the
    // floor is reached and the frames are still over budget.
    const desk = new DynamicResolution()
    const trace = []
    simulate(desk, { seconds: 30, gpuMs: (s, t, f) => 80 * s * s * jitter(f), flags: () => (trace.push([desk.scale, desk.starved]), {}) })
    expect(trace.every(([s, st]) => !st || s === desk.floor)).toBe(true)
    expect(desk.scale).toBe(0.6)
    expect(desk.starved).toBe(true)
    // Any reset or reconfiguration drops the verdict.
    desk.reset(1e6)
    expect(desk.starved).toBe(false)
  })

  it('a CPU-bound frame at the floor is not starved', () => {
    const drs = new DynamicResolution({ nativeLines: 540 })
    simulate(drs, { seconds: 30, gpuMs: () => 8, cpuMs: 30 })
    expect(drs.cpuBound).toBe(true)
    expect(drs.starved).toBe(false)
  })

  it('recovering under budget clears starvation', () => {
    const drs = new DynamicResolution({ nativeLines: 540 })
    simulate(drs, { seconds: 8, gpuMs: () => 30 })
    expect(drs.starved).toBe(true)
    simulate(drs, { seconds: 8, start: 8000, gpuMs: () => 6 })
    expect(drs.starved).toBe(false)
    simulate(drs, { seconds: 8, start: 16000, gpuMs: () => 30 })
    expect(drs.starved).toBe(true)
    drs.configure({ displayHz: 30 })
    expect(drs.starved).toBe(false)
  })
})
