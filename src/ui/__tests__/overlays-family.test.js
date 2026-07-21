import { describe, expect, it, vi } from 'vitest'
import { UI } from '../overlays.js'
import { Phase } from '../../core/GameState.js'

// Node-env tests via UI.prototype on hand-built element fakes — the same
// pattern engine-void-death.test.js uses for the void overlay. Full DOM
// wiring is covered by the browser smoke, not vitest (repo has no jsdom).

const fakeEl = () => ({
  textContent: '',
  style: {},
  classList: { toggle: vi.fn(), add: vi.fn(), remove: vi.fn() },
  setAttribute: vi.fn(),
})

// Mimics <select> semantics: assigning a value with no matching option blanks.
function fakeSelect(options) {
  let value = options[0]
  return {
    get value() {
      return value
    },
    set value(v) {
      value = options.includes(v) ? v : ''
    },
  }
}

function bareUI() {
  const ui = Object.create(UI.prototype)
  ui._showOnly = vi.fn()
  return ui
}

describe('_runSummary', () => {
  it('keeps the historical office string and appends non-office families', () => {
    const ui = bareUI()
    expect(ui._runSummary({ level: 7, seedText: 'same-level-void', mapFamily: 'office' }))
      .toBe('LEVEL 7 · SEED same-level-void')
    expect(ui._runSummary({ level: 3, seedText: 's', mapFamily: 'lattice' }))
      .toBe('LEVEL 3 · SEED s · LATTICE')
    expect(ui._runSummary({ level: 2, seedText: '', mapFamily: 'tower' }))
      .toBe('LEVEL 2 · TOWER')
    expect(ui._runSummary(null)).toBe('')
  })
})

describe('showDeath / showPause run summaries', () => {
  it('renders the family suffix on the death card', () => {
    const ui = bareUI()
    ui.el = {
      deadTitle: fakeEl(),
      deadJp: fakeEl(),
      deadSub: fakeEl(),
      deadRun: fakeEl(),
    }
    ui.showDeath('void', { level: 7, seedText: 'same-level-void', mapFamily: 'lattice' })
    expect(ui.el.deadRun.textContent).toBe('LEVEL 7 · SEED same-level-void · LATTICE')
    expect(ui._showOnly).toHaveBeenCalledWith(Phase.DEAD)
  })

  it('fills and toggles the pause run chip', () => {
    const ui = bareUI()
    ui.el = { pauseRun: fakeEl() }
    ui.showPause({ level: 4, seedText: 'abc', mapFamily: 'sewer' })
    expect(ui.el.pauseRun.textContent).toBe('LEVEL 4 · SEED abc · SEWER')
    expect(ui.el.pauseRun.classList.toggle).toHaveBeenCalledWith('hidden', false)
    expect(ui._showOnly).toHaveBeenCalledWith(Phase.PAUSED)

    ui.showPause()
    expect(ui.el.pauseRun.textContent).toBe('')
    expect(ui.el.pauseRun.classList.toggle).toHaveBeenLastCalledWith('hidden', true)
  })
})

describe('setFamilyInput', () => {
  it('round-trips known families and lands unknown values on office', () => {
    const ui = bareUI()
    ui.el = { familySelect: fakeSelect(['office', 'sewer', 'tower', 'lattice', 'hotel']) }
    ui.setFamilyInput('tower')
    expect(ui.el.familySelect.value).toBe('tower')
    ui.setFamilyInput('bogus')
    expect(ui.el.familySelect.value).toBe('office')
  })
})

describe('updateHud family chip', () => {
  function hudUI() {
    const ui = bareUI()
    ui._hudCache = {}
    ui.el = {
      level: fakeEl(),
      seed: fakeEl(),
      fam: fakeEl(),
      stam: fakeEl(),
      batt: fakeEl(),
      san: fakeEl(),
      expo: fakeEl(),
      expoBar: fakeEl(),
      fl: fakeEl(),
      compass: fakeEl(),
      compassArrow: fakeEl(),
      dist: fakeEl(),
    }
    return ui
  }

  const state = (mapFamily) => ({
    level: 1,
    seedText: 'abc',
    mapFamily,
    stamina: 1,
    battery: 1,
    sanity: 1,
    stareCharge: 0,
    flashlightOn: false,
  })

  it('shows FAMILY <NAME> for non-office and hides for office', () => {
    const ui = hudUI()
    ui.updateHud(state('tower'), null)
    expect(ui.el.fam.textContent).toBe('FAMILY TOWER')
    expect(ui.el.fam.classList.toggle).toHaveBeenCalledWith('hidden', false)

    ui.updateHud(state('office'), null)
    expect(ui.el.fam.textContent).toBe('')
    expect(ui.el.fam.classList.toggle).toHaveBeenLastCalledWith('hidden', true)
  })
})
