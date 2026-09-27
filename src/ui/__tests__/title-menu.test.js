import { describe, expect, it, vi } from 'vitest'
import { FAMILY_NOTES, TITLE_HTML, familyNote, stepMenuIndex } from '../titleMenu.js'
import { UI } from '../overlays.js'
import { Phase } from '../../core/GameState.js'
import { MAP_FAMILY_ORDER } from '../../world/mapFamily.js'

// Node-env tests (the repo has no jsdom): the title markup is checked as a
// string, and the UI lifecycle through UI.prototype on hand-built fakes — the
// same pattern overlays-family.test.js uses.

describe('stepMenuIndex', () => {
  it('wraps ArrowDown / ArrowUp at both ends', () => {
    expect(stepMenuIndex(0, 3, 'ArrowDown')).toBe(1)
    expect(stepMenuIndex(2, 3, 'ArrowDown')).toBe(0)
    expect(stepMenuIndex(1, 3, 'ArrowUp')).toBe(0)
    expect(stepMenuIndex(0, 3, 'ArrowUp')).toBe(2)
  })

  it('leaves the index alone for other keys and empty menus', () => {
    expect(stepMenuIndex(1, 3, 'Enter')).toBe(1)
    expect(stepMenuIndex(1, 3, 'ArrowLeft')).toBe(1)
    expect(stepMenuIndex(0, 0, 'ArrowDown')).toBe(0)
  })
})

describe('familyNote', () => {
  it('has a one-line note for every shipped family', () => {
    for (const f of MAP_FAMILY_ORDER) {
      expect(familyNote(f)).toMatch(/\S/)
      expect(familyNote(f)).not.toMatch(/\n/)
    }
    expect(Object.keys(FAMILY_NOTES).sort()).toEqual([...MAP_FAMILY_ORDER].sort())
  })

  it('returns an empty note for unknown and prototype keys', () => {
    expect(familyNote('bogus')).toBe('')
    expect(familyNote('toString')).toBe('')
    expect(familyNote(undefined)).toBe('')
  })
})

describe('TITLE_HTML', () => {
  it('keeps every id the UI cache reads', () => {
    for (const id of [
      'p-title',
      'title-menu',
      'btn-start',
      'seed-input',
      'family-select',
      'family-note',
      'btn-settings',
      'btn-settings-close',
      'btn-editor',
      'title-settings',
    ]) {
      expect(TITLE_HTML).toContain(`id="${id}"`)
    }
  })

  it('offers exactly one MAP option per shipped family, in order', () => {
    const select = TITLE_HTML.match(/<select id="family-select"[^>]*>(.*?)<\/select>/s)[1]
    const values = [...select.matchAll(/<option value="([^"]+)">/g)].map((m) => m[1])
    expect(values).toEqual([...MAP_FAMILY_ORDER])
  })

  it('hosts one settings block, inside the side sheet', () => {
    expect(TITLE_HTML.match(/class="settings"/g)).toHaveLength(1)
    expect(TITLE_HTML.indexOf('class="settings"')).toBeGreaterThan(
      TITLE_HTML.indexOf('id="title-settings"')
    )
  })

  it('gives the per-letter wordmark one accessible name', () => {
    expect(TITLE_HTML).toContain('<h1 class="logo" aria-label="The Yellow Rooms">')
    const letters = [...TITLE_HTML.matchAll(/<span class="lt[^"]*" style="--i:(\d+)">(.)<\/span>/g)]
    expect(letters.map((m) => m[2]).join('')).toBe('YELLOWROOMS')
    expect(letters.map((m) => Number(m[1]))).toEqual([...Array(11).keys()])
    expect(TITLE_HTML.match(/class="lt fail"/g)).toHaveLength(1)
  })

  it('only arrow-navigates the menu buttons, never the text/select fields', () => {
    const navIds = [...TITLE_HTML.matchAll(/<button id="([^"]+)"[^>]*\bdata-nav\b/g)].map((m) => m[1])
    expect(navIds).toEqual(['btn-start', 'btn-settings', 'btn-editor'])
  })
})

// classList fake with real toggle/contains semantics.
function fakeEl() {
  const classes = new Set()
  return {
    textContent: '',
    attrs: {},
    classList: {
      toggle(c, force) {
        const on = force ?? !classes.has(c)
        if (on) classes.add(c)
        else classes.delete(c)
        return on
      },
      contains: (c) => classes.has(c),
    },
    setAttribute(k, v) {
      this.attrs[k] = v
    },
    focus: vi.fn(),
  }
}

function titleUI() {
  const ui = Object.create(UI.prototype)
  ui._showOnly = vi.fn()
  const titleSettings = fakeEl()
  titleSettings.classList.toggle('hidden', true)
  ui.el = {
    title: fakeEl(),
    titleSettings,
    btnSettings: fakeEl(),
    btnSettingsClose: fakeEl(),
    familyNote: fakeEl(),
    familySelect: { value: 'office' },
  }
  return ui
}

describe('title settings sheet', () => {
  it('opens into the sheet and marks the menu', () => {
    const ui = titleUI()
    ui._setTitleSettingsOpen(true)
    expect(ui.el.titleSettings.classList.contains('hidden')).toBe(false)
    expect(ui.el.title.classList.contains('sheet-open')).toBe(true)
    expect(ui.el.btnSettings.attrs['aria-expanded']).toBe('true')
    expect(ui.el.btnSettingsClose.focus).toHaveBeenCalled()
  })

  it('hands focus back to SETTINGS only when asked', () => {
    const ui = titleUI()
    ui._setTitleSettingsOpen(true)
    ui._setTitleSettingsOpen(false)
    expect(ui.el.titleSettings.classList.contains('hidden')).toBe(true)
    expect(ui.el.title.classList.contains('sheet-open')).toBe(false)
    expect(ui.el.btnSettings.attrs['aria-expanded']).toBe('false')
    expect(ui.el.btnSettings.focus).not.toHaveBeenCalled()

    ui._setTitleSettingsOpen(true)
    ui._setTitleSettingsOpen(false, { restoreFocus: true })
    expect(ui.el.btnSettings.focus).toHaveBeenCalledTimes(1)
  })

  it('showTitle always lands on the bare menu with a current family note', () => {
    const ui = titleUI()
    ui._setTitleSettingsOpen(true)
    ui.el.familySelect.value = 'hotel'
    ui.showTitle()
    expect(ui.el.titleSettings.classList.contains('hidden')).toBe(true)
    expect(ui.el.familyNote.textContent).toBe(familyNote('hotel'))
    expect(ui._showOnly).toHaveBeenCalledWith(Phase.TITLE)
  })

  it('setFamilyInput refreshes the family note', () => {
    const ui = titleUI()
    ui.setFamilyInput('sewer')
    expect(ui.el.familyNote.textContent).toBe(familyNote('sewer'))
  })
})
