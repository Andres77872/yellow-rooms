import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Import boundaries of the family framework, computed over the static import
// graph (spec §0.1 I8/I9, §4.4, §7.5):
//   I8  no runtime module reaches src/editor;
//   I9  no ES-module cycle through contract.js, mapFamily.js or generate.js;
//   §7.5 the planner chain (contract → planners → <id>/structures →
//        <id>/geometry) imports only its allowlist, and contract's closure
//        never reaches ChunkData, the tile canvas or the stub generator;
//   §4.4 the registry layer imports data only and never reaches mapFamily.
// Rules over files that do not exist yet hold vacuously and tighten as the
// framework tasks add them.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const rel = (p) => relative(ROOT, p).split('\\').join('/')
const abs = (p) => resolve(ROOT, p)

const RUNTIME_DIRS = ['src/world', 'src/core', 'src/render', 'src/ui', 'src/audio', 'src/player', 'src/entities']

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name !== '__tests__' && name !== 'node_modules') walk(p, out)
    } else if (/\.(m?js)$/.test(name)) out.push(p)
  }
  return out
}

// A dependency-free import scanner (no parser package: the test must not
// lean on a transitive dependency). Static: an `import`/`export … from`
// statement starting a line, its clause limited to bindings (identifiers,
// `*`, braces, commas), so `export const x = …` never matches; side-effect
// `import '…'` too. Dynamic: `import('literal')` outside a comment line.
// Checked against es-module-lexer over all of src/ and scripts/ (528 files,
// identical static and dynamic specifier lists) when it was written.
const STATIC_IMPORT = /^[ \t]*(import|export)\b(?:\s*([\w$*\s{},]*?)\s*from)?\s*(['"])([^'"\n]+)\3/gm
const DYNAMIC_IMPORT = /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g
function scanImports(src) {
  const statics = []
  for (const m of src.matchAll(STATIC_IMPORT)) {
    if (m[1] === 'export' && m[2] === undefined) continue // `export '…'` is not a statement
    statics.push({ specifier: m[4], stmt: m[0] })
  }
  const dynamics = []
  for (const m of src.matchAll(DYNAMIC_IMPORT)) {
    const line = src.slice(src.lastIndexOf('\n', m.index) + 1, m.index).trim()
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue
    dynamics.push(m[2])
  }
  return { statics, dynamics }
}

// Static (and, separately, dynamic) relative imports of a file, resolved,
// with the named bindings of each static import.
const IMPORTS = new Map()
function importsOf(file) {
  let hit = IMPORTS.get(file)
  if (hit) return hit
  const { statics, dynamics } = scanImports(readFileSync(file, 'utf8'))
  hit = { static: [], dynamic: [] }
  for (const { specifier, stmt } of statics) {
    if (!specifier.startsWith('.')) continue // packages
    const target = resolve(dirname(file), specifier)
    const braces = /^\s*(?:import|export)\s*(?:type\s+)?\{([^}]*)\}/.exec(stmt)
    const names = braces ? braces[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean) : null
    const kind = /^\s*export\s*\*/.test(stmt) ? 'star' : braces ? 'named' : /^\s*import\s*['"]/.test(stmt) ? 'side' : 'other'
    hit.static.push({ target, names, kind })
  }
  for (const specifier of dynamics) {
    if (specifier.startsWith('.')) hit.dynamic.push({ target: resolve(dirname(file), specifier) })
  }
  IMPORTS.set(file, hit)
  return hit
}

// Static closure of a file (itself included); missing targets are kept, not read.
function closure(file) {
  const seen = new Set()
  const stack = [file]
  while (stack.length) {
    const f = stack.pop()
    if (seen.has(f)) continue
    seen.add(f)
    if (!existsSync(f)) continue
    for (const { target } of importsOf(f).static) stack.push(target)
  }
  return seen
}

// A shortest static import chain from `from` to any file matching `hit`.
function chain(from, hit) {
  const prev = new Map([[from, null]])
  const queue = [from]
  for (let i = 0; i < queue.length; i++) {
    const f = queue[i]
    if (hit(f)) {
      const path = []
      for (let p = f; p; p = prev.get(p)) path.unshift(rel(p))
      return path
    }
    if (!existsSync(f)) continue
    for (const { target } of importsOf(f).static) {
      if (prev.has(target)) continue
      prev.set(target, f)
      queue.push(target)
    }
  }
  return null
}

const FAMILY_IDS = ['stairwell', 'nightlot', 'showroom', 'poolrooms', 'babel', 'suburb', 'terminal', 'theater', 'playplace', 'train', 'house', 'funhouse']
const existing = (paths) => paths.map(abs).filter(existsSync)
const isEditor = (f) => rel(f).startsWith('src/editor/')

describe('import boundaries', () => {
  it('the import scanner reads static, side-effect, re-export and dynamic imports', () => {
    const src = [
      "import { a, b as c } from './a.js'",
      'import {',
      '  d,',
      '  e,',
      "} from \"./d.js\"",
      "import * as ns from './ns.js'",
      "import def, { f } from './def.js'",
      "import './side.js'",
      "export * from './star.js'",
      "export * as star2 from './star2.js'",
      "export { g } from './g.js'",
      "export const from = 'x' // not an import",
      "export default from",
      "const s = 'import x from \"./str.js\"'",
      "// import('./commented.js')",
      "const lazy = () => import('./lazy.js')",
      "import pkg from 'vitest'",
    ].join('\n')
    const { statics, dynamics } = scanImports(src)
    expect(statics.map((s) => s.specifier)).toEqual([
      './a.js', './d.js', './ns.js', './def.js', './side.js', './star.js', './star2.js', './g.js', 'vitest',
    ])
    expect(dynamics).toEqual(['./lazy.js'])
  })

  it('I8: no runtime module reaches src/editor (static closure; direct dynamic imports too)', () => {
    const files = RUNTIME_DIRS.flatMap((d) => walk(abs(d)))
    expect(files.length).toBeGreaterThan(100)
    // Memoised "reaches the editor" over the static graph.
    const reaches = new Map()
    const visit = (f, stack = new Set()) => {
      if (reaches.has(f)) return reaches.get(f)
      if (isEditor(f)) return true
      if (!existsSync(f) || stack.has(f)) return false
      stack.add(f)
      let r = false
      for (const { target } of importsOf(f).static) if (visit(target, stack)) { r = true; break }
      stack.delete(f)
      reaches.set(f, r)
      return r
    }
    const bad = []
    for (const f of files) {
      if (visit(f)) bad.push(chain(f, isEditor).join(' -> '))
      for (const { target } of importsOf(f).dynamic) if (isEditor(target)) bad.push(`${rel(f)} -> import(${rel(target)})`)
    }
    expect(bad).toEqual([])
  })

  it('I9: no import cycle through contract.js, mapFamily.js or generate.js', () => {
    for (const p of ['src/world/structures/contract.js', 'src/world/mapFamily.js', 'src/world/generate.js']) {
      const self = abs(p)
      for (const { target } of importsOf(self).static) {
        const back = chain(target, (f) => f === self)
        expect(back, `${p} cycle`).toBe(null)
      }
    }
  })

  it('§7.5: the planner chain imports only its allowlist', () => {
    const SHARED = [
      'src/world/constants.js', 'src/world/core/hash.js', 'src/world/core/rng.js', 'src/world/mapTypes.js',
      'src/world/mapFamily.js', 'src/world/structures/catalog/engine.js',
      'src/world/families/ids.js', 'src/world/tiles/tileKey.js', 'src/world/tiles/stubPlanner.js',
    ]
    const MAP_FAMILY_NAMES = new Set(['deepFreeze', 'MAP_FAMILY_CODES'])
    const check = (file, allowed) => {
      const bad = []
      for (const im of importsOf(file).static) {
        const t = rel(im.target)
        if (!allowed.includes(t)) bad.push(`${rel(file)} imports ${t}`)
        else if (t === 'src/world/mapFamily.js' && (im.kind !== 'named' || im.names.some((n) => !MAP_FAMILY_NAMES.has(n)))) {
          bad.push(`${rel(file)} imports mapFamily.js names ${im.names ?? im.kind}`)
        }
      }
      return bad
    }
    const bad = []
    const planners = abs('src/world/families/planners.js')
    if (existsSync(planners)) {
      bad.push(...check(planners, [...SHARED, ...FAMILY_IDS.map((id) => `src/world/families/${id}/structures.js`)]))
    }
    for (const id of FAMILY_IDS) {
      const own = `src/world/families/${id}/geometry.js`
      for (const f of existing([`src/world/families/${id}/structures.js`, own])) bad.push(...check(f, [...SHARED, own]))
    }
    const tileKey = abs('src/world/tiles/tileKey.js')
    if (existsSync(tileKey)) bad.push(...check(tileKey, ['src/world/constants.js', 'src/world/core/hash.js', 'src/world/core/rng.js']))
    const stubPlanner = abs('src/world/tiles/stubPlanner.js')
    if (existsSync(stubPlanner)) bad.push(...check(stubPlanner, []))
    expect(bad).toEqual([])
  })

  // families/registry.js and records.js are NOT forbidden here: §4.4 lets
  // mapFamily.js import registry.js and config.js import records.js, and
  // contract.js imports both mapFamily.js and config.js. The planner-chain
  // modules themselves may not import them (allowlist test above), and the
  // registry layer never reaches mapFamily/config (§4.4 test below).
  it('§7.5: contract.js never reaches ChunkData, the tile canvas or the stub generator', () => {
    const c = closure(abs('src/world/structures/contract.js'))
    const FORBIDDEN = [
      'src/world/ChunkData.js', 'src/world/tiles/TileCanvas.js', 'src/world/tiles/stub.js',
      'src/world/tiles/floorPlan.js', 'src/world/tiles/kit.js', 'src/world/tiles/familyChunk.js',
      'src/world/tiles/cells.js', 'src/world/tiles/seams.js', 'src/world/tiles/solidChunk.js',
      'src/world/pipeline.js', 'src/world/generate.js',
      'src/world/families/generators.js', 'src/world/families/hooks.js',
      'src/world/families/select.js', 'src/world/families/forced.js',
    ]
    const hits = FORBIDDEN.filter((p) => c.has(abs(p)))
    expect(hits.map((p) => chain(abs('src/world/structures/contract.js'), (f) => f === abs(p)).join(' -> '))).toEqual([])
  })

  it('nothing under tiles/ reaches families/hooks.js (generate → pipeline → familyChunk cycle)', () => {
    const hooks = abs('src/world/families/hooks.js')
    const bad = walk(abs('src/world/tiles'))
      .filter((f) => closure(f).has(hooks))
      .map((f) => chain(f, (g) => g === hooks).join(' -> '))
    expect(bad).toEqual([])
  })

  it('§4.4: the registry layer imports data only and never reaches mapFamily.js', () => {
    const allow = {
      'src/world/families/ids.js': [],
      'src/world/families/legacy.js': ['src/world/mapTypes.js', 'src/world/families/ids.js'],
      'src/world/families/records.js': ['src/world/families/legacy.js', ...FAMILY_IDS.map((id) => `src/world/families/${id}/record.js`)],
      'src/world/families/registry.js': ['src/world/families/ids.js', 'src/world/families/legacy.js', 'src/world/families/records.js', 'src/world/mapTypes.js'],
      // select.js and forced.js sit above mapFamily.js (§4.4); mapFamily.js never imports them (checked below).
      'src/world/families/select.js': ['src/world/mapFamily.js', 'src/world/families/registry.js'],
      'src/world/families/forced.js': ['src/world/config.js', 'src/world/mapFamily.js'],
      ...Object.fromEntries(FAMILY_IDS.map((id) => [`src/world/families/${id}/record.js`, ['src/world/families/ids.js', 'src/world/mapTypes.js']])),
    }
    const bad = []
    for (const [file, allowed] of Object.entries(allow)) {
      if (!existsSync(abs(file))) continue
      for (const { target } of importsOf(abs(file)).static) if (!allowed.includes(rel(target))) bad.push(`${file} imports ${rel(target)}`)
    }
    for (const file of ['src/world/families/registry.js', 'src/world/families/records.js']) {
      if (!existsSync(abs(file))) continue
      const c = closure(abs(file))
      for (const p of ['src/world/mapFamily.js', 'src/world/config.js', 'src/world/familyPalette.js']) {
        if (c.has(abs(p))) bad.push(`${file} reaches ${p}`)
      }
    }
    // mapFamily.js may import the registry, never select.js or forced.js.
    const mf = closure(abs('src/world/mapFamily.js'))
    for (const p of ['src/world/families/select.js', 'src/world/families/forced.js']) if (mf.has(abs(p))) bad.push(`mapFamily.js reaches ${p}`)
    expect(bad).toEqual([])
  })

  it('the moved editor helpers are re-exports of src/world/tiles', () => {
    const REEXPORTS = {
      'src/editor/kinds/floorPlan.js': 'src/world/tiles/floorPlan.js',
      'src/editor/roomBuilder.js': 'src/world/tiles/roomOps.js',
      'src/editor/holeMasks.js': 'src/world/tiles/holeMasks.js',
    }
    for (const [editor, world] of Object.entries(REEXPORTS)) {
      expect(importsOf(abs(editor)).static.map((im) => [rel(im.target), im.kind])).toEqual([[world, 'star']])
    }
    expect(importsOf(abs('src/editor/simulate.js')).static.map((im) => rel(im.target))).toContain('src/world/tiles/simulate.js')
  })
})
