import { afterEach, describe, expect, it, vi } from 'vitest'
import { Minimap } from '../Minimap.js'
import { CELL } from '../../world/constants.js'
import { CELL_BRIDGE, WALL_RAIL, WALL_WINDOW } from '../../world/mapTypes.js'

function recordingContext() {
  let path = []
  const state = []
  const calls = []
  const ctx = {
    calls,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    setTransform() {},
    clearRect() {},
    fillRect(...args) {
      calls.push({ op: 'fillRect', style: this.fillStyle, args })
    },
    beginPath() {
      path = []
    },
    moveTo(...args) {
      path.push({ op: 'moveTo', args })
    },
    lineTo(...args) {
      path.push({ op: 'lineTo', args })
    },
    arc(...args) {
      path.push({ op: 'arc', args })
    },
    closePath() {},
    stroke() {
      calls.push({
        op: 'stroke',
        style: this.strokeStyle,
        lineWidth: this.lineWidth,
        path: path.map((entry) => ({ ...entry, args: [...entry.args] })),
      })
    },
    fill() {},
    save() {
      state.push({ fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, lineWidth: this.lineWidth })
    },
    restore() {
      Object.assign(this, state.pop())
    },
    createRadialGradient() {
      return { addColorStop() {} }
    },
    fillText() {},
  }
  return ctx
}

function makeCanvas(ctx) {
  return {
    style: {},
    getContext: () => ctx,
  }
}

function callsWithStyle(ctx, op, style) {
  return ctx.calls.filter((call) => call.op === op && call.style === style)
}

afterEach(() => vi.unstubAllGlobals())

describe('Minimap multilevel atrium rendering', () => {
  it('distinguishes the solid bottom, upper void, bridge, windows, and rails across 15 storeys', () => {
    vi.stubGlobal('window', { devicePixelRatio: 1 })
    const ctx = recordingContext()
    const minimap = new Minimap(makeCanvas(ctx))
    minimap.visible = true

    const target = (gx, gz) => gx === 0 && gz === 0
    const store = {
      chunks: new Map(),
      isRevealed: target,
      floorHoleAt: (gx, gz, floor) => target(gx, gz) && floor === 14,
      cellKindAt: (gx, gz, floor) =>
        target(gx, gz) && floor === 13 ? CELL_BRIDGE : 0,
      wallVAt: (gx, gz, floor) => gx === 0 && gz === 0 && floor === 13,
      wallHAt: (gx, gz, floor) => gx === 0 && gz === 1 && floor === 13,
      wallFeatureVAt: (gx, gz, floor) =>
        gx === 0 && gz === 0 && floor === 13 ? WALL_WINDOW : 0,
      wallFeatureHAt: (gx, gz, floor) =>
        gx === 0 && gz === 1 && floor === 13 ? WALL_RAIL : 0,
      columnAt: () => false,
      stairAt: () => null,
    }
    const input = {
      controller: { pos: { x: CELL / 2, z: CELL / 2 }, yaw: 0 },
      exit: null,
      exitRevealed: false,
      store,
    }

    const renderFloor = (floor) => {
      ctx.calls.length = 0
      minimap.update({ ...input, floor })
      return [...ctx.calls]
    }

    renderFloor(0)
    expect(callsWithStyle(ctx, 'fillRect', 'rgba(244,233,200,.07)')).toEqual([
      { op: 'fillRect', style: 'rgba(244,233,200,.07)', args: [69, 69, 13, 13] },
    ])
    expect(callsWithStyle(ctx, 'fillRect', 'rgba(159,208,192,.22)')).toHaveLength(0)

    renderFloor(14)
    expect(callsWithStyle(ctx, 'fillRect', 'rgba(244,233,200,.07)')).toHaveLength(0)
    expect(callsWithStyle(ctx, 'fillRect', 'rgba(159,208,192,.22)')).toHaveLength(0)

    renderFloor(13)
    expect(callsWithStyle(ctx, 'fillRect', 'rgba(244,233,200,.07)')).toHaveLength(1)
    expect(callsWithStyle(ctx, 'fillRect', 'rgba(159,208,192,.22)')).toEqual([
      { op: 'fillRect', style: 'rgba(159,208,192,.22)', args: [69, 69, 13, 13] },
    ])

    expect(callsWithStyle(ctx, 'stroke', '#9fd0c0')).toEqual([
      {
        op: 'stroke',
        style: '#9fd0c0',
        lineWidth: 1.8,
        path: [
          { op: 'moveTo', args: [69, 69] },
          { op: 'lineTo', args: [69, 81] },
        ],
      },
    ])
    expect(callsWithStyle(ctx, 'stroke', '#c0a95a')).toEqual([
      {
        op: 'stroke',
        style: '#c0a95a',
        lineWidth: 1.4,
        path: [
          { op: 'moveTo', args: [69, 81] },
          { op: 'lineTo', args: [81, 81] },
        ],
      },
    ])
  })
})
