import { describe, expect, it, vi } from 'vitest'
import { UI } from '../overlays.js'
import { exitDistText } from '../hud.js'
import { familyNote } from '../titleMenu.js'
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

describe('exit compass distance chip', () => {
  it('counts storeys for every family but the stairwell, which says only below / above (doc 04 §4.5)', () => {
    expect(exitDistText(12.4, 0, 'office')).toBe('12m')
    expect(exitDistText(12.4, -2, 'office')).toBe('12m ▼2')
    expect(exitDistText(7, 3, 'hotel')).toBe('7m ▲3')
    expect(exitDistText(7, -1, 'train')).toBe('7m ▼1')
    expect(exitDistText(12.4, 0, 'stairwell')).toBe('12m')
    expect(exitDistText(12.4, -5, 'stairwell')).toBe('12m below')
    expect(exitDistText(12.4, 2, 'stairwell')).toBe('12m above')
  })
})

// Just enough of a <select>/<optgroup>/<option> tree for add/removeFamilyOption,
// with the HTML selectedness rules: every option keeps its own `selected`
// flag, even while detached. After any change to the list, a select with no
// selected option selects its first, and of several selected options only
// the last in tree order stays selected. An unknown value assignment blanks.
const descendants = (n) => n.children.flatMap((c) => [c, ...descendants(c)])
const selectOf = (n) => {
  while (n && n.tagName !== 'SELECT') n = n.parentNode
  return n
}
function domNode(tagName, props) {
  const n = { tagName, children: [], parentNode: null, ...props }
  n.appendChild = (c) => {
    c.remove()
    c.parentNode = n
    n.children.push(c)
    selectOf(n)?.reselect()
    return c
  }
  n.append = (...cs) => cs.forEach((c) => n.appendChild(c))
  n.remove = () => {
    const parent = n.parentNode
    if (!parent) return
    parent.children.splice(parent.children.indexOf(n), 1)
    n.parentNode = null
    selectOf(parent)?.reselect()
  }
  n.querySelectorAll = (sel) => descendants(n).filter((c) => c.tagName === sel.toUpperCase())
  n.querySelector = (sel) => n.querySelectorAll(sel)[0] ?? null
  return n
}
function selectTree(values) {
  const doc = {
    createElement: (tag) =>
      domNode(tag.toUpperCase(), tag === 'optgroup' ? { label: '' } : { value: '', selected: false }),
  }
  const select = domNode('SELECT', { ownerDocument: doc })
  select.reselect = () => {
    const opts = select.options
    const on = opts.filter((o) => o.selected)
    if (!on.length && opts.length) opts[0].selected = true
    for (const o of on.slice(0, -1)) o.selected = false
  }
  Object.defineProperty(select, 'options', { get: () => select.querySelectorAll('option') })
  Object.defineProperty(select, 'value', {
    get: () => select.options.find((o) => o.selected)?.value ?? '',
    set: (v) => {
      for (const o of select.options) o.selected = o.value === v
    },
  })
  for (const value of values) select.appendChild(doc.createElement('option')).value = value
  return select
}
const layout = (select) =>
  select.children.map((c) => (c.tagName === 'OPTGROUP' ? { [c.label]: c.children.map((o) => o.value) } : c.value))

const LEGACY = ['office', 'sewer', 'tower', 'lattice', 'hotel']

function menuUI(select = selectTree(LEGACY)) {
  const ui = bareUI()
  ui.el = { familySelect: select, familyNote: fakeEl() }
  return ui
}

describe('experimental MAP options', () => {
  it('adding splits the plain list into BUILDINGS + the group and keeps the pick', () => {
    const ui = menuUI()
    ui.setFamilyInput('hotel')
    ui.addFamilyOption('poolrooms', 'POOLROOMS', 'EXPERIMENTAL')
    ui.addFamilyOption('nightlot', 'NIGHT LOT', 'EXPERIMENTAL')
    ui.addFamilyOption('nightlot', 'NIGHT LOT', 'EXPERIMENTAL') // already listed: no-op
    expect(layout(ui.el.familySelect)).toEqual([{ BUILDINGS: LEGACY }, { EXPERIMENTAL: ['poolrooms', 'nightlot'] }])
    expect(ui.el.familySelect.value).toBe('hotel')
    ui.setFamilyInput('nightlot')
    expect(ui.el.familySelect.value).toBe('nightlot')
  })

  it('keeps an office pick through the split (moving options re-picks in a real select)', () => {
    const ui = menuUI()
    ui.setFamilyInput('office')
    ui.addFamilyOption('poolrooms', 'POOLROOMS', 'EXPERIMENTAL')
    expect(ui.el.familySelect.value).toBe('office')
    expect(ui.el.familySelect.options.filter((o) => o.selected).map((o) => o.value)).toEqual(['office'])
  })

  it('removing every entry restores the plain list and keeps a surviving pick', () => {
    const ui = menuUI()
    ui.addFamilyOption('poolrooms', 'POOLROOMS', 'EXPERIMENTAL')
    ui.addFamilyOption('nightlot', 'NIGHT LOT', 'EXPERIMENTAL')
    ui.setFamilyInput('sewer')
    ui.removeFamilyOption('poolrooms', 'EXPERIMENTAL')
    expect(layout(ui.el.familySelect)).toEqual([{ BUILDINGS: LEGACY }, { EXPERIMENTAL: ['nightlot'] }])
    ui.removeFamilyOption('nightlot', 'EXPERIMENTAL')
    expect(layout(ui.el.familySelect)).toEqual(LEGACY)
    expect(ui.el.familySelect.value).toBe('sewer')
  })

  it('a removed pick lands on office and the note follows', () => {
    const ui = menuUI()
    ui.addFamilyOption('poolrooms', 'POOLROOMS', 'EXPERIMENTAL')
    ui.setFamilyInput('poolrooms')
    expect(ui.el.familyNote.textContent).toBe(familyNote('poolrooms'))
    ui.removeFamilyOption('poolrooms', 'EXPERIMENTAL')
    expect(ui.el.familySelect.value).toBe('office')
    expect(ui.el.familyNote.textContent).toBe(familyNote('office'))
  })

  it('never removes an option listed under another group', () => {
    const select = selectTree([])
    const doc = select.ownerDocument
    for (const [label, values] of [['BUILDINGS', LEGACY], ['LIMINAL', ['poolrooms']]]) {
      const group = doc.createElement('optgroup')
      group.label = label
      for (const value of values) group.appendChild(doc.createElement('option')).value = value
      select.appendChild(group)
    }
    const ui = menuUI(select)
    ui.setFamilyInput('poolrooms')
    ui.removeFamilyOption('poolrooms', 'EXPERIMENTAL')
    ui.removeFamilyOption('bogus', 'EXPERIMENTAL')
    expect(layout(select)).toEqual([{ BUILDINGS: LEGACY }, { LIMINAL: ['poolrooms'] }])
    expect(select.value).toBe('poolrooms')
  })
})
