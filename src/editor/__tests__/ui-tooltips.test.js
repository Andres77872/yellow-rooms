import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  COMMANDS,
  FILL_MODES,
  LAYER_META,
  SCOPE_LABEL,
  TABS,
  TOOL_KEYS,
  TOOL_META,
  chordOf,
  commandById,
  commandForChord,
  formatChord,
  fuzzyRank,
  commandState,
  helpRows,
  isSingleCharChord,
  isTextField,
  paletteCommands,
  scopeActive,
} from '../ui/keymap.js'
import { createTools } from '../ui/tools.js'
import { EditorApp } from '../EditorApp.js'
import { ICONS } from '../ui/icons.js'

// The editor UI has no DOM in vitest (environment: node, no jsdom), so the
// coverage checks are static: the keymap registry (single source of truth
// for keys, help, palette and tooltip chips) is checked directly, and every
// interactive-control builder call in src/editor/ui is required to pass a
// tooltip (`tip`, `tips` or a keymap `cmd`).

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui')
const uiFiles = readdirSync(UI_DIR).filter((f) => f.endsWith('.js'))
const source = (f) => readFileSync(join(UI_DIR, f), 'utf8')

// Arguments of every call `name(` in `text` (balanced parentheses, strings
// and template literals skipped), excluding definitions and imports.
function callArgs(text, name) {
  const out = []
  const re = new RegExp(`(^|[^\\w.$])${name}\\(`, 'g')
  let m
  while ((m = re.exec(text))) {
    const start = m.index + m[0].length
    const before = text.slice(Math.max(0, m.index - 12), m.index + m[1].length)
    if (/function\s*$/.test(before)) continue
    let depth = 1
    let i = start
    let quote = null
    for (; i < text.length && depth > 0; i++) {
      const ch = text[i]
      if (quote) {
        if (ch === '\\') i++
        else if (ch === quote) quote = null
        continue
      }
      if (ch === "'" || ch === '"' || ch === '`') quote = ch
      else if (ch === '(') depth++
      else if (ch === ')') depth--
    }
    const line = text.slice(0, m.index).split('\n').length
    out.push({ args: text.slice(start, i - 1), line })
  }
  return out
}

const TIP = /\btips?\s*[:,}]|\bcmd\s*:|sectionOpts\(|tip\b/

describe('keymap registry', () => {
  it('has unique command ids and a label + hint for each', () => {
    const ids = COMMANDS.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const c of COMMANDS) {
      expect(c.label, c.id).toBeTruthy()
      expect(c.hint?.length, c.id).toBeGreaterThan(10)
      expect(typeof c.run, c.id).toBe('function')
      if (c.icon) expect(ICONS[c.icon], `${c.id} icon ${c.icon}`).toBeTruthy()
    }
  })

  it('never binds one chord twice in overlapping scopes', () => {
    const byChord = new Map()
    for (const c of COMMANDS) {
      for (const k of c.keys ?? []) {
        const list = byChord.get(k) ?? []
        list.push(c)
        byChord.set(k, list)
      }
    }
    const exclusive = (a, b) => a && b && (a === `!${b}` || b === `!${a}`)
    for (const [chord, list] of byChord) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          expect(exclusive(list[i].when, list[j].when), `${chord}: ${list[i].id} vs ${list[j].id}`).toBe(true)
        }
      }
    }
  })

  it('resolves scoped chords by the active tool (R, X, F, Home)', () => {
    const app = (tool, preview = false) => ({ tool: { id: tool }, preview: preview ? {} : null })
    expect(commandForChord('R', app('select')).id).toBe('edit.rotate')
    expect(commandForChord('R', app('object')).id).toBe('object.turn')
    expect(commandForChord('F', app('section')).id).toBe('section.follow')
    expect(commandForChord('F', app('wall')).id).toBe('view.fit')
    expect(commandForChord('X', app('wall'))).toBe(null)
    expect(commandForChord('X', app('section')).id).toBe('section.swap')
    expect(commandForChord('Home', app('select', true)).id).toBe('view.reset3d')
    expect(commandForChord('Home', app('select')).id).toBe('view.fitHome')
    expect(commandForChord('Mod+Shift+Z', app('select')).id).toBe('edit.redo')
    expect(commandForChord('Mod+Y', app('select')).id).toBe('edit.redo')
    expect(commandForChord('Backspace', app('select')).id).toBe('edit.delete')
    expect(commandForChord('Escape', app('select')).id).toBe('ui.escape')
    expect(commandForChord('Mod+K', app('select')).id).toBe('ui.palette')
    expect(commandForChord('?', app('select')).id).toBe('ui.help')
    expect(commandForChord('Mod+S', app('select')).id).toBe('file.export')
    expect(scopeActive('!preview', app('x', true))).toBe(false)
  })

  it('labels every scope used by a command', () => {
    for (const c of COMMANDS) if (c.when) expect(SCOPE_LABEL[c.when], c.id).toBeTruthy()
  })

  it('has one command per tool, in rail order, with digits 1–9 then 0', () => {
    const tools = createTools({})
    expect(TOOL_META.map((t) => t.id)).toEqual(tools.map((t) => t.id))
    tools.forEach((t, i) => {
      const cmd = commandById(`tool.${t.id}`)
      expect(cmd, t.id).toBeTruthy()
      expect(cmd.keys).toEqual([TOOL_KEYS[i]])
    })
  })

  it('makes every shortcut reachable from the help sheet and every command from the palette', () => {
    const helpIds = new Set(helpRows().flatMap((g) => g.rows.map((r) => r.id)))
    const paletteIds = new Set(paletteCommands().map((c) => c.id))
    for (const c of COMMANDS) {
      if (c.keys?.length) expect(helpIds.has(c.id), `help: ${c.id}`).toBe(true)
      // Palette-hidden commands are key aliases; their action is in the palette.
      if (c.palette === false) expect(c.keys?.length, `${c.id} hidden from the palette needs a key`).toBeGreaterThan(0)
      else expect(paletteIds.has(c.id), `palette: ${c.id}`).toBe(true)
    }
    for (const t of TABS) expect(paletteIds.has(`tab.${t.id}`)).toBe(true)
    for (const l of LAYER_META) expect(paletteIds.has(`layer.${l.id}`)).toBe(true)
    for (const f of FILL_MODES) expect(paletteIds.has(`fill.${f.id}`)).toBe(true)
  })

  it('only calls EditorApp methods that exist (and ui methods the shell defines)', () => {
    const calls = new Set()
    const uiCalls = new Set()
    const make = (path) => new Proxy(function () {}, {
      get: (_, key) => {
        if (key === Symbol.toPrimitive) return () => 0
        if (typeof key === 'symbol') return undefined
        return make([...path, key])
      },
      set: () => true,
      apply: () => {
        if (path.length === 1) calls.add(path[0])
        if (path.length === 2 && path[0] === 'ui') uiCalls.add(path[1])
        return make([...path, '()'])
      },
    })
    const app = make([])
    for (const c of COMMANDS) {
      c.run(app)
      c.enabled?.(app)
      c.checked?.(app)
    }
    for (const name of calls) expect(typeof EditorApp.prototype[name], `app.${name}`).toBe('function')
    const shell = source('panel.js')
    for (const name of uiCalls) expect(new RegExp(`ui\\.${name}\\s*=`).test(shell), `app.ui.${name}`).toBe(true)
  })
})

describe('chords and search', () => {
  it('normalizes key events', () => {
    expect(chordOf({ key: 'z', ctrlKey: true })).toBe('Mod+Z')
    expect(chordOf({ key: 'Z', metaKey: true, shiftKey: true })).toBe('Mod+Shift+Z')
    expect(chordOf({ key: '?', shiftKey: true })).toBe('?')
    expect(chordOf({ key: '+', shiftKey: true })).toBe('+')
    expect(chordOf({ key: 'PageUp' })).toBe('PageUp')
    expect(chordOf({ key: 'Esc' })).toBe('Escape')
    expect(chordOf({ key: 'r' })).toBe('R')
    // Shift alone does not change a letter shortcut (Shift+V is V, Caps Lock).
    expect(chordOf({ key: 'V', shiftKey: true })).toBe('V')
    expect(chordOf({ key: 'E', shiftKey: true })).toBe('E')
    expect(chordOf({ key: 'Tab', shiftKey: true })).toBe('Shift+Tab')
  })

  it('treats only text-like controls as fields', () => {
    expect(isTextField({ tagName: 'INPUT', type: 'text' })).toBe(true)
    expect(isTextField({ tagName: 'INPUT', type: 'number' })).toBe(true)
    expect(isTextField({ tagName: 'INPUT', type: 'checkbox' })).toBe(false)
    expect(isTextField({ tagName: 'INPUT', type: 'range' })).toBe(false)
    expect(isTextField({ tagName: 'SELECT' })).toBe(true)
    expect(isTextField({ tagName: 'TEXTAREA' })).toBe(true)
    expect(isTextField({ tagName: 'DIV', isContentEditable: true })).toBe(true)
    expect(isTextField({ tagName: 'BUTTON' })).toBe(false)
    expect(isTextField(null)).toBe(false)
  })

  it('classifies character-key shortcuts (WCAG 2.1.4)', () => {
    for (const c of ['R', '1', '?', '=', '-']) expect(isSingleCharChord(c)).toBe(true)
    for (const c of ['Mod+Z', 'PageUp', 'F1', 'Escape', 'Tab']) expect(isSingleCharChord(c)).toBe(false)
  })

  it('gives the right reasons for unavailable commands', () => {
    const exploring = { readOnly: true, canUndo: () => false, canRedo: () => false }
    expect(commandState(commandById('edit.undo'), exploring).reason).toMatch(/Read-only while exploring/)
    expect(commandState(commandById('edit.redo'), exploring).reason).toMatch(/Read-only while exploring/)
    expect(commandState(commandById('edit.undo'), { readOnly: false, canUndo: () => false }).reason).toBe('Nothing to undo')
    expect(commandState(commandById('view.zoomIn'), { preview: {} }).enabled).toBe(false)
    expect(commandState(commandById('view.zoomOut'), { preview: null }).enabled).toBe(true)
    const world = { sameWorld: (s, f) => s === 'lobby' && f === 'office' }
    expect(commandState(commandById('world.reopen'), { mode: 'document', world: { seedText: 'x', family: 'office' }, explorer: world }).enabled).toBe(false)
    expect(commandState(commandById('world.reopen'), { mode: 'explore', world: { seedText: 'lobby', family: 'office' }, explorer: world }).enabled).toBe(false)
    expect(commandState(commandById('world.reopen'), { mode: 'explore', world: { seedText: 'new', family: 'office' }, explorer: world }).enabled).toBe(true)
  })

  it('formats chords for both platforms', () => {
    expect(formatChord('Mod+Shift+Z')).toBe('Ctrl+Shift+Z')
    expect(formatChord('Mod+Shift+Z', { mac: true })).toBe('⌘⇧Z')
    expect(formatChord('Delete')).toBe('Del')
    expect(formatChord('+')).toBe('+')
  })

  it('ranks fuzzy matches by relevance', () => {
    const labels = COMMANDS.map((c) => c.label)
    expect(fuzzyRank('undo', labels)[0]).toBe('Undo')
    expect(fuzzyRank('3d', labels)[0]).toBe('3D preview')
    expect(fuzzyRank('scan', labels)[0]).toMatch(/^Scan structure atlas/)
    expect(fuzzyRank('zzqx', labels)).toEqual([])
    expect(fuzzyRank('', ['b', 'a'])).toEqual(['b', 'a'])
  })
})

describe('tooltip coverage (static)', () => {
  const BUILDERS = ['button', 'toggle', 'slider', 'segmented', 'iconButton', 'listRow', 'section', 'readout']
  const skip = new Set(['dom.js', 'keymap.js'])

  for (const name of BUILDERS) {
    it(`every ${name}() call passes a tooltip`, () => {
      let n = 0
      for (const f of uiFiles) {
        if (skip.has(f)) continue
        for (const { args, line } of callArgs(source(f), name)) {
          if (name === 'section' && !args.trim()) continue
          n++
          expect(TIP.test(args), `${f}:${line} ${name}(${args.slice(0, 80)}…)`).toBe(true)
        }
      }
      if (name !== 'readout') expect(n).toBeGreaterThan(0)
    })
  }

  it('every selectInput() / textInput() passes tooltip options', () => {
    let n = 0
    for (const f of uiFiles) {
      if (f === 'options.js') continue
      for (const fn of ['selectInput', 'textInput']) {
        for (const { args, line } of callArgs(source(f), fn)) {
          n++
          expect(/\btip\s*:/.test(args), `${f}:${line} ${fn}`).toBe(true)
        }
      }
    }
    expect(n).toBeGreaterThan(5)
  })

  it('every raw <button> built with h() carries a tip or a keymap command', () => {
    let n = 0
    for (const f of uiFiles) {
      if (f === 'dom.js') continue
      for (const { args, line } of callArgs(source(f), 'h')) {
        if (!/^\s*'button'/.test(args)) continue
        n++
        expect(/\btip\b|cmd\s*:/.test(args), `${f}:${line}`).toBe(true)
      }
    }
    expect(n).toBeGreaterThan(10)
  })

  it('section dock buttons are bound to keymap commands', () => {
    const text = source('SectionView.js')
    for (const id of ['section.swap', 'section.follow', 'view.section']) {
      expect(text.includes(`'${id}'`), id).toBe(true)
      expect(commandById(id), id).toBeTruthy()
    }
  })

  it('reports coverage', () => {
    let total = 0
    let tipped = 0
    for (const f of uiFiles) {
      if (skip.has(f)) continue
      const text = source(f)
      for (const name of [...BUILDERS.filter((b) => b !== 'readout' && b !== 'section'), 'selectInput', 'textInput']) {
        for (const { args } of callArgs(text, name)) {
          total++
          if (TIP.test(args)) tipped++
        }
      }
      for (const { args } of callArgs(text, 'h')) {
        if (!/^\s*'button'/.test(args)) continue
        total++
        if (/\btip\b|cmd\s*:/.test(args)) tipped++
      }
    }
    expect(tipped).toBe(total)
  })
})
