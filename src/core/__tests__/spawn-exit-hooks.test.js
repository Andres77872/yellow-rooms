import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Engine } from '../Engine.js'
import { Phase } from '../GameState.js'
import { createExitPlacement, finishExit } from '../exitPlacement.js'
import { WORLD_GEN_VERSION } from '../../world/constants.js'
import { generateChunk } from '../../world/generate.js'
import { digestChunk } from '../../world/__tests__/support/chunkDigest.js'
import { hashStr } from '../../world/core/hash.js'
import { familyExitHook, familySpawn, LEGACY_SPAWN } from '../../world/families/hooks.js'
import { forcedFamilyConfig } from '../../world/families/forced.js'
import { LIMINAL_FAMILY_IDS } from '../../world/families/ids.js'
import { LEGACY_FAMILIES, displayNameOf, propPacksOf } from '../../world/families/registry.js'
import { resolveMapFamily, worldConfigForFamily } from '../../world/mapFamily.js'
import { loadPropModels } from '../../render/furnitureModels.js'

// Spawn/exit hooks (spec §8.1, §8.2), the DEV forced family (§8.4) and the
// lazy prop packs threaded through Engine._loadRun (§9.1).

const FORCED = 'stairwell'
const packGate = vi.hoisted(() => ({ hold: false, pending: [] }))

// Transparent spy on the exit hooks: records the arguments every importer
// (createExitPlacement included) hands the real family hook.
const exitHookSpy = vi.hoisted(() => ({ calls: [], original: null }))
vi.mock('../../world/families/hooks.js', async (importOriginal) => {
  const mod = await importOriginal()
  exitHookSpy.original = mod.familyExitHook
  return {
    ...mod,
    familyExitHook(config) {
      const hook = mod.familyExitHook(config)
      if (!hook) return hook
      return (args) => {
        exitHookSpy.calls.push(args)
        return hook(args)
      }
    },
  }
})

vi.mock('../../render/furnitureModels.js', () => ({
  createFurnitureModelLibrary: () => ({ geometries: new Map(), loaded: false }),
  loadFurnitureModels: () => new Promise(() => {}),
  loadPropModels: vi.fn((library) => {
    if (!packGate.hold) return Promise.resolve(library)
    return new Promise((resolve) => packGate.pending.push(() => resolve(library)))
  }),
  disposeFurnitureModels: vi.fn(),
}))

vi.mock('../../render/enemyModels.js', () => ({
  createEnemyModelLibrary: () => ({ geometries: new Map(), loaded: false }),
  loadEnemyModels: () => new Promise(() => {}),
  disposeEnemyModels: vi.fn(),
  upgradeEnemyModels: vi.fn(),
}))

vi.mock('three', () => {
  class WebGLRenderer {
    constructor() {
      const render = { calls: 0, triangles: 0, points: 0, lines: 0 }
      this.domElement = {}
      this.info = {
        render,
        memory: { geometries: 0, textures: 0 },
        programs: [],
        autoReset: true,
        reset: vi.fn(() => {
          render.calls = 0
          render.triangles = 0
          render.points = 0
          render.lines = 0
        }),
      }
    }

    setPixelRatio = vi.fn()
    setSize = vi.fn()
    setClearColor() {}
    dispose() {}
  }

  class Scene {
    add() {}
  }

  class PerspectiveCamera {
    constructor() {
      this.rotation = { order: 'YXZ', set: vi.fn() }
      this.position = { set: vi.fn() }
      this.matrixWorld = {}
      this.matrixWorldInverse = {
        copy: vi.fn(() => this.matrixWorldInverse),
        invert: vi.fn(() => this.matrixWorldInverse),
      }
    }

    updateMatrixWorld() {}
    updateProjectionMatrix() {}
  }

  class Vector3 {
    constructor() {
      this.set(0, 0, 0)
    }

    set(x, y, z) {
      this.x = x
      this.y = y
      this.z = z
      return this
    }
  }

  return {
    ColorManagement: { enabled: false },
    WebGLRenderer,
    Scene,
    PerspectiveCamera,
    Vector3,
    NoToneMapping: 0,
    MathUtils: {
      lerp: (a, b, t) => a + (b - a) * t,
    },
  }
})

vi.mock('../../render/gbufferMaterials.js', () => ({
  createGBufferMaterials: () => ({
    panel: { uniforms: { uIntensity: { value: 0 } } },
  }),
  applyFamilyMaterials: () => ({ fog: 0x000000 }),
  disposeGBufferMaterials: vi.fn(),
}))

vi.mock('../../render/geometries.js', () => ({
  createGeometries: () => ({}),
  disposeGeometries: vi.fn(),
}))

vi.mock('../../world/ChunkManager.js', () => ({
  ChunkManager: class {
    constructor(_scene, seed) {
      this.seed = seed
      this.lightGrid = {}
      this.enableSightCulling = vi.fn()
      this.config = {
        version: WORLD_GEN_VERSION,
        mapFamily: { selected: 'office' },
      }
      this.loadedCount = 0
      this.exit = null
      this.setSeed = vi.fn((nextSeed) => {
        this.seed = nextSeed
      })
      this.setExit = vi.fn((cx, cy, cz, lx, lz) => {
        this.exit = { cx, cy, cz, lx, lz }
      })
      this.reset = vi.fn()
      this.setSpawn = vi.fn()
      this.upgradeFurnitureModels = vi.fn()
      this.setRenderDetailProfile = vi.fn()
      this.updateVisibility = vi.fn()
      this.update = vi.fn()
      this.stairAt = vi.fn(() => null)
      this.surfaceAt = vi.fn(() => 'carpet')
      this.lightAt = vi.fn(() => 0.1)
      const recordPrewarm = (x, z) => {
        this.initialDigest = JSON.stringify({
          version: this.config.version,
          seed: this.seed,
          family: this.config.mapFamily?.selected,
          x,
          z,
        })
        return this.initialDigest
      }
      this.prewarmTitleBackdrop = vi.fn(recordPrewarm)
      this.prewarm = vi.fn(recordPrewarm)
    }
  },
}))

vi.mock('../../player/Controller.js', () => ({
  Controller: class {
    constructor(camera) {
      this.camera = camera
      this.pos = { x: 0, y: 0, z: 0 }
      this.floor = 0
      this.yaw = 0
      this.teleport = vi.fn()
      this.lock = vi.fn()
      this.unlock = vi.fn()
      this.setBobEnabled = vi.fn()
      this.setCameraFxEnabled = vi.fn()
      this.resetCameraFx = vi.fn()
      this.setMove = vi.fn()
      this.lookDelta = vi.fn()
      this.toggleFlashlight = vi.fn()
      this.step = vi.fn()
      this.applyFrame = vi.fn()
    }
  },
}))

vi.mock('../../audio/AudioBus.js', () => ({
  AudioBus: class {
    constructor() {
      this.setVolume = vi.fn()
      this.silence = vi.fn()
      this.resetLevel = vi.fn()
      this.start = vi.fn()
      this.setTension = vi.fn()
      this.footstep = vi.fn()
      this.flickerDrop = vi.fn()
      this.entityThump = vi.fn()
      this.setHumProximity = vi.fn()
      this.setFamily = vi.fn()
      this.land = vi.fn()
      this.flashlightClick = vi.fn()
      this.deathStinger = vi.fn()
      this.exitStinger = vi.fn()
      this.update = vi.fn()
    }
  },
}))

function mockEnemyClass() {
  return class {
    constructor() {
      this.active = false
      this.cy = 0
      this.reset = vi.fn()
      this.update = vi.fn(() => ({
        dist: Infinity,
        seen: false,
        inBeam: false,
        tension: 0,
        caught: false,
      }))
    }
  }
}

vi.mock('../../entities/Stalker.js', () => ({ Stalker: mockEnemyClass() }))
vi.mock('../../entities/Pursuer.js', () => ({ Pursuer: mockEnemyClass() }))
vi.mock('../../entities/Husk.js', () => ({ Husk: mockEnemyClass() }))

vi.mock('../../render/DeferredRenderer.js', () => ({
  DeferredRenderer: class {
    constructor() {
      this.lamps = []
      this.grade = {
        dead: { value: 0 },
        vignette: { value: 0 },
        grain: { value: 0 },
        aberration: { value: 0 },
      }
      this.lightUniforms = {
        uFlashOn: { value: 0 },
        uLampFlicker: { value: 0 },
      }
      this.setOutline = vi.fn()
      this.setSize = vi.fn()
      this.render = vi.fn()
      this.dispose = vi.fn()
      this.applyPalette = vi.fn()
      this.applyQuality = vi.fn()
      this.setTiming = vi.fn()
      this.setLook = vi.fn()
      this.bindLightGrid = vi.fn()
      this.setOccluders = vi.fn()
      this.setVpl = vi.fn()
      this.familyAlbedo = () => ({ floor: [0.4, 0.4, 0.4], wall: [0.5, 0.5, 0.5], ceiling: [0.5, 0.5, 0.5] })
      this.panelGlow = 1
      this.resetAdaptation = vi.fn()
    }
  },
}))

vi.mock('../../render/LightField.js', () => ({
  LightField: class {
    constructor() {
      this.reset = vi.fn()
      this.update = vi.fn()
    }
  },
}))

vi.mock('../DebugOverlay.js', () => ({
  DebugOverlay: class {
    constructor() {
      this.visible = false
      this.update = vi.fn()
      this.setMode = vi.fn()
      this.dispose = vi.fn()
    }
  },
}))

vi.mock('../../ui/overlays.js', () => ({
  UI: class {
    constructor() {
      this.el = { hud: {}, minimap: {} }
      this.showDeath = vi.fn()
      this.showHud = vi.fn()
      this.showPause = vi.fn()
      this.showTitle = vi.fn()
      this.showTransition = vi.fn()
      this.setSeedInput = vi.fn()
      this.setFamilyInput = vi.fn()
      this.setRotateVisible = vi.fn()
      this.refreshSettings = vi.fn()
      this.updateHud = vi.fn()
      this.showLoading = vi.fn()
      this.addFamilyOption = vi.fn()
      this.removeFamilyOption = vi.fn()
    }
  },
}))

vi.mock('../../ui/TouchControls.js', () => ({
  TouchControls: class {},
}))

vi.mock('../../ui/Minimap.js', () => ({
  MINIMAP_SIZE: 150,
  Minimap: class {
    constructor() {
      this.setVisible = vi.fn()
      this.update = vi.fn()
      this.resize = vi.fn()
    }
  },
}))

vi.mock('../../world/ExploredMap.js', () => ({
  ExploredMap: class {
    constructor() {
      this.reset = vi.fn()
      this.update = vi.fn()
      this.isRevealed = vi.fn(() => false)
    }
  },
}))

vi.mock('../../debug/DebugMode.js', () => ({
  DebugMode: class {
    constructor() {
      this.active = false
      this.freeze = false
      this.invincible = false
      this.update = vi.fn()
      this.preRender = vi.fn()
      this.postRender = vi.fn()
      this.resize = vi.fn()
      this.dispose = vi.fn()
    }
  },
}))

const fakeLocation = { search: '' }
let frames

beforeEach(() => {
  packGate.hold = false
  packGate.pending.length = 0
  loadPropModels.mockClear()
  frames = []
  vi.stubGlobal('devicePixelRatio', 1)
  vi.stubGlobal('innerWidth', 1280)
  vi.stubGlobal('innerHeight', 720)
  vi.stubGlobal('addEventListener', vi.fn())
  vi.stubGlobal('removeEventListener', vi.fn())
  vi.stubGlobal('requestAnimationFrame', (cb) => frames.push(cb))
  vi.stubGlobal('document', { activeElement: null, hidden: false, hasFocus: () => true })
  fakeLocation.search = ''
  vi.stubGlobal('location', fakeLocation)
  vi.stubGlobal('history', {
    replaceState: vi.fn((_state, _title, url) => {
      fakeLocation.search = url
    }),
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

const createEngine = (search = '') => {
  fakeLocation.search = search
  return new Engine({ appendChild: vi.fn() })
}
const flushFrames = () => {
  while (frames.length) frames.shift()()
}
// Let the pack promise chain and settleWithin's .then settle.
const flushAsync = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}
const forcedUrl = `?family=${FORCED}&forceFamily=1`

describe('spawn and exit hooks', () => {
  it('legacy families spawn on the hub cell and keep the legacy exit body', () => {
    for (const family of LEGACY_FAMILIES) {
      const config = worldConfigForFamily(family)
      expect(familySpawn(config, 1234)).toBe(LEGACY_SPAWN)
      expect(familyExitHook(config)).toBeNull()
    }
  })

  it('every liminal family spawns on storey 0 at its hook cell, with no clearings', () => {
    for (const id of LIMINAL_FAMILY_IDS) {
      const sp = familySpawn(forcedFamilyConfig(id), 77)
      expect(sp.cy, id).toBeUndefined() // a cell and chunk only, never a storey (I7)
      expect(sp.clearings, id).toEqual([])
      expect(Number.isFinite(sp.x) && Number.isFinite(sp.z), id).toBe(true)
    }
  })

  it('createExitPlacement takes the family exit hook first and finishes it like the legacy tail', () => {
    for (const id of LIMINAL_FAMILY_IDS) {
      const config = forcedFamilyConfig(id)
      for (const worldSeed of [99, -1]) {
        exitHookSpy.calls.length = 0
        const exit = createExitPlacement('seed', 2, worldSeed, config)
        // Called exactly once, with the documented hook context (§8.2).
        expect(exitHookSpy.calls, id).toHaveLength(1)
        const [args] = exitHookSpy.calls
        expect(args.worldSeed, id).toBe(worldSeed >>> 0)
        expect(args.level, id).toBe(2)
        expect(args.config, id).toBe(config)
        expect(args.profile, id).toEqual(resolveMapFamily(config))
        // generate() is the real raster of this world, not a stand-in.
        for (const [cx, cy, cz] of [[0, 0, 0], [6, 0, 0]]) {
          const got = args.generate(cx, cy, cz)
          expect(got.worldSeed, id).toBe(worldSeed >>> 0)
          expect(got.mapFamily, id).toBe(id)
          expect(digestChunk(got), `${id} ${cx},${cy},${cz}`)
            .toBe(digestChunk(generateChunk(worldSeed >>> 0, cx, cy, cz, config)))
        }
        // The result is the real hook's cell, finished like the legacy tail.
        expect(exit, id).toEqual(finishExit(exitHookSpy.original(config)(args)))
        expect(Object.keys(exit)).toEqual(['cx', 'cy', 'cz', 'lx', 'lz', 'x', 'y', 'z'])
      }
    }
  })
})

describe('DEV forced family', () => {
  it('boots the forced liminal family with its option, spawn and backdrop', () => {
    const engine = createEngine(forcedUrl)
    expect(engine.state.mapFamily).toBe(FORCED)
    expect(engine.cm.config.mapFamily.selected).toBe(FORCED)
    expect(engine.cm.config).toEqual(forcedFamilyConfig(FORCED))
    expect(engine.ui.addFamilyOption).toHaveBeenCalledWith(FORCED, displayNameOf(FORCED), 'LIMINAL (dev)')
    const sp = familySpawn(engine.cm.config, engine.cm.seed)
    expect(engine._spawn).toEqual(sp)
    expect(engine.cm.setSpawn).toHaveBeenCalledWith(engine._spawn)
    expect(engine.cm.prewarmTitleBackdrop).toHaveBeenCalledWith(sp.x, sp.z)
  })

  it('falls back to office without the flag, for a legacy id, and in production', () => {
    for (const search of [`?family=${FORCED}`, `?family=${FORCED}&forceFamily=0`, '?family=sewer&forceFamily=1']) {
      const engine = createEngine(search)
      expect(engine.state.mapFamily, search).toBe(search.includes('sewer') ? 'sewer' : 'office')
      expect(engine.ui.addFamilyOption, search).not.toHaveBeenCalled()
      engine.startRun('abc', FORCED)
      expect(engine.state.mapFamily, search).toBe('office')
      expect(engine.cm.setSpawn).toHaveBeenLastCalledWith(LEGACY_SPAWN)
    }
    vi.stubEnv('DEV', false)
    const prod = createEngine(forcedUrl)
    expect(prod.state.mapFamily).toBe('office')
    expect(prod.ui.addFamilyOption).not.toHaveBeenCalled()
  })

  it('startRun, restart and retry keep the forced config; the player spawns on the hook cell', () => {
    const engine = createEngine(forcedUrl)
    const config = engine.cm.config
    engine.startRun('abc', FORCED)
    expect(engine.cm.config).toBe(config)
    expect(engine.state.mapFamily).toBe(FORCED)
    expect(fakeLocation.search).toContain(`family=${FORCED}`)
    expect(fakeLocation.search).toContain('forceFamily=1')

    const seed = hashStr('abc#1')
    const sp = familySpawn(config, seed)
    const exit = createExitPlacement('abc', 1, seed, config)
    expect(engine.cm.setSpawn).toHaveBeenLastCalledWith(sp)
    expect(engine.cm.setExit).toHaveBeenLastCalledWith(exit.cx, exit.cy, exit.cz, exit.lx, exit.lz)
    const yaw = sp.yaw ?? Math.atan2(-(exit.x - sp.x), -(exit.z - sp.z))
    expect(engine.controller.teleport).toHaveBeenLastCalledWith(sp.x, sp.z, 0, yaw)
    expect(engine.cm.prewarm).toHaveBeenLastCalledWith(sp.x, sp.z)

    // RESTART from the pause menu.
    engine.pause()
    engine.ui.onRestart()
    flushFrames()
    return flushAsync().then(() => {
      expect(engine.state.phase).toBe(Phase.PLAYING)
      expect(engine.cm.config).toBe(config)
      expect(engine.state.mapFamily).toBe(FORCED)
      // Void death: TRY AGAIN retries the same level and config.
      engine.die('void')
      engine.ui.onRestart()
      flushFrames()
      return flushAsync()
    }).then(() => {
      expect(engine.state.phase).toBe(Phase.PLAYING)
      expect(engine.cm.config).toBe(config)
      expect(engine.state.mapFamily).toBe(FORCED)
      // The packs were fetched once (boot) for the whole session.
      expect(loadPropModels).toHaveBeenCalledOnce()
      expect(loadPropModels.mock.calls[0][1]).toEqual({ packs: [...propPacksOf(FORCED)] })
    })
  })
})

describe('EXPERIMENTAL MAPS setting', () => {
  const EXP = 'poolrooms'
  const storedSetting = (on) =>
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ experimentalMaps: on }), setItem: vi.fn() })
  const expectListed = (ui) => {
    for (const id of LIMINAL_FAMILY_IDS) {
      expect(ui.addFamilyOption, id).toHaveBeenCalledWith(id, displayNameOf(id), 'EXPERIMENTAL')
    }
  }

  it('off by default: nothing is listed and a liminal pick or link plays office', () => {
    const engine = createEngine(`?family=${EXP}`)
    expect(engine.state.mapFamily).toBe('office')
    expect(engine.ui.addFamilyOption).not.toHaveBeenCalled()
    engine.startRun('abc', EXP)
    expect(engine.state.mapFamily).toBe('office')
    expect(engine.cm.setSpawn).toHaveBeenLastCalledWith(LEGACY_SPAWN)
  })

  it('on, in a production build: lists all 12 under EXPERIMENTAL and plays the pick', () => {
    vi.stubEnv('DEV', false)
    storedSetting(true)
    const engine = createEngine()
    expect(engine.state.mapFamily).toBe('office')
    expectListed(engine.ui)
    engine.startRun('abc', EXP)
    const config = engine.cm.config
    expect(engine.state.mapFamily).toBe(EXP)
    expect(config).toEqual(forcedFamilyConfig(EXP))
    expect(fakeLocation.search).toContain(`family=${EXP}`)
    expect(engine.cm.setSpawn).toHaveBeenLastCalledWith(familySpawn(config, hashStr('abc#1')))
    // A same-family restart keeps the config object (void-death baselines).
    engine.startRun('def', EXP)
    expect(engine.cm.config).toBe(config)
  })

  it('on: a shared ?family= link boots that world behind the title', () => {
    vi.stubEnv('DEV', false)
    storedSetting(true)
    const engine = createEngine(`?family=${EXP}`)
    expect(engine.state.mapFamily).toBe(EXP)
    expect(engine.cm.config.mapFamily.selected).toBe(EXP)
    const sp = familySpawn(engine.cm.config, engine.cm.seed)
    expect(engine.cm.prewarmTitleBackdrop).toHaveBeenCalledWith(sp.x, sp.z)
  })

  it('off mid-run: unlisted, the running world keeps its family, a new liminal pick plays office', () => {
    storedSetting(true)
    const engine = createEngine()
    engine.startRun('abc', EXP)
    const config = engine.cm.config
    engine._applySetting('experimentalMaps', false)
    expect(engine.settings.get('experimentalMaps')).toBe(false)
    for (const id of LIMINAL_FAMILY_IDS) {
      expect(engine.ui.removeFamilyOption, id).toHaveBeenCalledWith(id, 'EXPERIMENTAL')
    }
    engine.startRun('abc', EXP) // RESTART of the running world
    expect(engine.cm.config).toBe(config)
    expect(engine.state.mapFamily).toBe(EXP)
    engine.startRun('abc', 'theater')
    expect(engine.state.mapFamily).toBe('office')
    engine.ui.addFamilyOption.mockClear()
    engine._applySetting('experimentalMaps', true)
    expectListed(engine.ui)
    engine.startRun('abc', EXP)
    expect(engine.cm.config).toBe(config) // memoised for the session
  })

  it('off then on mid-run puts the title picker back on the running world; at the title it is left alone', () => {
    storedSetting(true)
    const engine = createEngine()
    engine.ui.setFamilyInput.mockClear()
    engine._applySetting('experimentalMaps', false)
    engine._applySetting('experimentalMaps', true)
    expect(engine.state.phase).toBe(Phase.TITLE)
    expect(engine.ui.setFamilyInput).not.toHaveBeenCalled()
    engine.startRun('abc', EXP)
    engine.pause()
    engine._applySetting('experimentalMaps', false)
    engine.ui.setFamilyInput.mockClear()
    engine._applySetting('experimentalMaps', true)
    expect(engine.ui.setFamilyInput).toHaveBeenLastCalledWith(EXP)
  })

  it('on: an unknown family in a link or a pick still plays office, never throws', () => {
    storedSetting(true)
    const engine = createEngine('?family=bogus')
    expect(engine.state.mapFamily).toBe('office')
    engine.startRun('abc', 'nope')
    expect(engine.state.mapFamily).toBe('office')
    expect(engine.cm.setSpawn).toHaveBeenLastCalledWith(LEGACY_SPAWN)
  })

  it('DEV ?forceFamily=all lists them the same way without saving the setting', () => {
    const engine = createEngine(`?family=${EXP}&forceFamily=all`)
    expect(engine.state.mapFamily).toBe(EXP)
    expectListed(engine.ui)
    expect(engine.ui.addFamilyOption).not.toHaveBeenCalledWith(EXP, displayNameOf(EXP), 'LIMINAL (dev)')
    expect(engine.settings.get('experimentalMaps')).toBe(false)
    vi.stubEnv('DEV', false)
    const prod = createEngine(`?family=${EXP}&forceFamily=all`)
    expect(prod.state.mapFamily).toBe('office')
    expect(prod.ui.addFamilyOption).not.toHaveBeenCalled()
  })
})

describe('_loadRun family threading and lazy packs', () => {
  it('legacy families build inside the paint callback and fetch no packs', () => {
    const engine = createEngine()
    const startRun = vi.spyOn(engine, 'startRun')
    engine.ui.onStart('abc', 'sewer')
    flushFrames()
    expect(startRun).toHaveBeenCalledWith('abc', 'sewer')
    expect(loadPropModels).not.toHaveBeenCalled()
  })

  it('a liminal build waits for its packs behind the card, then runs with the family', async () => {
    const engine = createEngine(forcedUrl)
    packGate.hold = true
    engine._packLoads = Object.create(null) // forget the boot load
    const startRun = vi.spyOn(engine, 'startRun')
    engine.ui.onStart('abc', FORCED)
    flushFrames()
    await flushAsync()
    expect(startRun).not.toHaveBeenCalled()
    expect(engine._loading).toBe(true)
    packGate.pending.splice(0).forEach((go) => go())
    await flushAsync()
    expect(startRun).toHaveBeenCalledWith('abc', FORCED)
    expect(engine._loading).toBe(false)
    expect(engine.cm.upgradeFurnitureModels).toHaveBeenCalled()
    expect(engine.state.mapFamily).toBe(FORCED)
  })

  it('builds anyway after 1.5 s when the packs hang', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const engine = createEngine(forcedUrl)
    packGate.hold = true
    engine._packLoads = Object.create(null)
    const startRun = vi.spyOn(engine, 'startRun')
    engine.ui.onStart('abc', FORCED)
    flushFrames()
    await vi.advanceTimersByTimeAsync(1499)
    expect(startRun).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2)
    expect(startRun).toHaveBeenCalledWith('abc', FORCED)
  })

  it('a title MAP change prefetches the packs once', () => {
    const engine = createEngine(forcedUrl)
    loadPropModels.mockClear()
    engine._packLoads = Object.create(null)
    engine.ui.onFamilyChange(FORCED)
    engine.ui.onFamilyChange(FORCED)
    engine.ui.onFamilyChange('office')
    expect(loadPropModels).toHaveBeenCalledOnce()
  })

  it('never rejects when a pack load fails', async () => {
    const engine = createEngine(forcedUrl)
    engine._packLoads = Object.create(null)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    loadPropModels.mockImplementationOnce(() => Promise.reject(new Error('synthetic')))
    await expect(engine.ensureFamilyAssets(FORCED)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('mock sanity', () => {
  it('runs at the pinned world version', () => {
    expect(createEngine().cm.config.version).toBe(WORLD_GEN_VERSION)
  })
})
