import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Engine } from '../Engine.js'
import { GameState, Phase } from '../GameState.js'
import { groundHeightAt } from '../../player/ground.js'
import { DEFAULT_WORLD_CONFIG } from '../../world/config.js'
import { CELL, WORLD_GEN_VERSION, layerY } from '../../world/constants.js'

vi.mock('three', () => {
  class WebGLRenderer {
    constructor() {
      this.domElement = {}
      this.info = {
        render: { calls: 0, triangles: 0 },
        memory: { geometries: 0, textures: 0 },
        programs: [],
      }
    }

    setPixelRatio() {}
    setSize() {}
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
      this.teleport = vi.fn((x, z, floor, yaw) => {
        this.pos = { x, y: layerY(floor), z }
        this.floor = floor
        this.yaw = yaw
      })
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
      this.update = vi.fn()
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
      this.visible = false
      this.setVisible = vi.fn((visible) => {
        this.visible = visible
      })
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

vi.mock('../exitPlacement.js', () => ({
  createExitPlacement: (_seedText, level) => ({
    cx: 2,
    cy: level % 2 === 0 ? 1 : -1,
    cz: -2,
    lx: 6,
    lz: 7,
    x: 90,
    y: 4.95,
    z: -81,
  }),
  evaluateExit: () => ({
    info: { dist: Infinity, relAngle: 0, floorDelta: 0 },
    reached: false,
  }),
}))

const VOID_ID = 0x5a17
const VOID_CELL = Object.freeze({ lx: 5, lz: 8, deathYmm: -7200 })

function createEngine(family = 'tower') {
  const engine = new Engine({ appendChild: vi.fn() })
  engine.state.seedText = 'same-level-void'
  engine.state.level = 7
  engine.state.mapFamily = family
  engine.state.phase = Phase.PLAYING
  engine.cm.config = structuredClone(DEFAULT_WORLD_CONFIG)
  engine.cm.config.mapFamily.selected = family
  engine.cm.config.mapFamily.normalizedProfile = {
    family,
    profileIdentity: `${family}-core`,
  }
  engine._setupLevel()
  return engine
}

function engineBaseline(engine) {
  return {
    version: engine.cm.config.version,
    seedText: engine.state.seedText,
    level: engine.state.level,
    mapFamily: engine.state.mapFamily,
    selectedProfile: structuredClone(engine.cm.config.mapFamily),
    initialDigest: engine.cm.initialDigest,
  }
}


beforeEach(() => {
  vi.stubGlobal('devicePixelRatio', 1)
  vi.stubGlobal('innerWidth', 1280)
  vi.stubGlobal('innerHeight', 720)
  vi.stubGlobal('addEventListener', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Engine authored-void hard death (R18-S01..S03; D08/D09)', () => {
  it.each(['tower', 'lattice'])(
    'wires a validated %s void plane to hard death with reason void',
    (family) => {
      const engine = createEngine(family)
      const event = { id: VOID_ID, family, deathYmm: VOID_CELL.deathYmm }

      expect(
        engine.controller.onVoidDeath,
        'Controller.onVoidDeath must be wired by Engine, not synthesized by the test'
      ).toBeTypeOf('function')
      engine.controller.onVoidDeath({ id: event.id, family: event.family })

      expect(engine.state.phase).toBe(Phase.DEAD)
      expect(engine.state.deathReason).toBe('void')
      expect(engine.ui.showDeath).toHaveBeenCalledWith('void', engine.state)
    }
  )

  it('handles repeated callbacks for one matched plane exactly once', () => {
    const engine = createEngine('tower')
    const event = { id: VOID_ID, family: 'tower' }
    engine.ui.showDeath.mockClear()
    engine.controller.unlock.mockClear()
    engine.audio.setTension.mockClear()

    expect(engine.controller.onVoidDeath).toBeTypeOf('function')
    engine.controller.onVoidDeath(event)
    engine.controller.onVoidDeath(event)

    expect(engine.state.phase).toBe(Phase.DEAD)
    expect(engine.state.deathReason).toBe('void')
    expect(engine.ui.showDeath).toHaveBeenCalledTimes(1)
    expect(engine.controller.unlock).toHaveBeenCalledTimes(1)
    expect(engine.audio.setTension).toHaveBeenCalledTimes(1)
  })

  it('stops gameplay on the physics substep that crosses an authored void plane', () => {
    const engine = createEngine('tower')
    engine.controller.step.mockImplementationOnce(() => engine.controller.onVoidDeath())
    engine.state.flashlightOn = true
    engine.state.battery = 0.5
    engine.cm.update.mockClear()

    engine._tick(0.05)

    expect(engine.state.phase).toBe(Phase.DEAD)
    expect(engine.state.deathReason).toBe('void')
    expect(engine.controller.step).toHaveBeenCalledOnce()
    expect(engine.controller.applyFrame).not.toHaveBeenCalled()
    expect(engine.cm.update).not.toHaveBeenCalled()
    expect(engine.stalker.update).not.toHaveBeenCalled()
    expect(engine.pursuer.update).not.toHaveBeenCalled()
    expect(engine.husk.update).not.toHaveBeenCalled()
    expect(engine.audio.update).not.toHaveBeenCalled()
    expect(engine.audio.setTension).toHaveBeenLastCalledWith(0)
    expect(engine.ui.updateHud).not.toHaveBeenCalled()
    expect(engine.state.battery).toBe(0.5)
  })

  it('renders an explicit void-death overlay message', async () => {
    const { UI: ActualUI } = await vi.importActual('../../ui/overlays.js')
    const ui = Object.create(ActualUI.prototype)
    ui.el = {
      deadTitle: { textContent: '' },
      deadJp: { textContent: '' },
      deadSub: { textContent: '' },
      deadRun: { textContent: '' },
    }
    ui._showOnly = vi.fn()

    ui.showDeath('void', { level: 7, seedText: 'same-level-void' })

    expect(ui.el.deadTitle.textContent).toBe('FALLEN')
    expect(ui.el.deadJp.textContent).toBe('「虚無」')
    expect(ui.el.deadSub.textContent).toBe('the void swallowed you whole.')
    expect(ui.el.deadRun.textContent).toBe('LEVEL 7 · SEED same-level-void')
    expect(ui._showOnly).toHaveBeenCalledWith(Phase.DEAD)
  })

  it('keeps an ordinary office atrium on the established 15-floor rescue path', () => {
    const engine = createEngine('office')
    const officeAtrium = {
      stairAt: () => null,
      floorHoleAt: (_gx, _gz, floor) => floor >= 1 && floor <= 14,
    }
    engine.cm.updateVisibility.mockClear()

    expect(groundHeightAt(officeAtrium, CELL / 2, CELL / 2, 14)).toBe(layerY(0))
    engine.controller.onFloorChange(0)

    expect(engine.state.phase).toBe(Phase.PLAYING)
    expect(engine.state.deathReason).toBe('')
    expect(engine.ui.showDeath).not.toHaveBeenCalled()
    expect(engine.cm.updateVisibility).toHaveBeenCalledWith(0, null)
  })
})

describe('same-level deterministic void retry (R19-S01..S03; D09)', () => {
  it('clears a stale void reason as part of level reset', () => {
    const state = new GameState()
    state.phase = Phase.DEAD
    state.seedText = 'same-level-void'
    state.level = 7
    state.mapFamily = 'sewer'
    state.stamina = 0.2
    state.battery = 0.3
    state.sanity = 0.4
    state.exposure = 5
    state.stareCharge = 0.8
    state.flashlightOn = true
    state.deadAmount = 1
    state.deathReason = 'void'

    state.resetLevel()

    expect(state).toMatchObject({
      phase: Phase.DEAD,
      seedText: 'same-level-void',
      level: 7,
      mapFamily: 'sewer',
      stamina: 1,
      battery: 1,
      sanity: 1,
      exposure: 0,
      stareCharge: 0,
      flashlightOn: false,
      deadAmount: 0,
    })
    expect(state.deathReason).toBe('')
  })

  it.each(['tower', 'lattice'])(
    'retries the current %s level without changing version, seed, level, profile, or digest',
    (family) => {
      const engine = createEngine(family)
      const before = engineBaseline(engine)
      const setup = vi.spyOn(engine, '_setupLevel')
      engine._transitStair = { stale: true }
      engine.die('void')

      expect(
        engine.retryCurrentLevel,
        'same-level void retry is not implemented'
      ).toBeTypeOf('function')
      engine.retryCurrentLevel()

      expect(engineBaseline(engine)).toEqual(before)
      expect(engine.state.phase).toBe(Phase.PLAYING)
      expect(engine.state.deathReason).toBe('')
      expect(engine.deferred.grade.dead.value).toBe(0)
      expect(engine._transitStair).toBeNull()
      expect(setup).toHaveBeenCalledTimes(1)
      expect(engine.cm.config.version).toBe(WORLD_GEN_VERSION)
      expect(engine.cm.config.mapFamily.profiles.sewer.enabled).toBe(true)
      expect(engine.cm.config.mapFamily.profiles.tower.enabled).toBe(true)
      expect(engine.cm.config.mapFamily.profiles.lattice.enabled).toBe(true)
      expect(engine.ui.showHud).toHaveBeenCalled()
      expect(engine.controller.lock).toHaveBeenCalled()
    }
  )

  it('produces identical initial state across repeated death/retry sequences', () => {
    const engine = createEngine('tower')
    const initial = engineBaseline(engine)
    const resets = []

    expect(engine.retryCurrentLevel).toBeTypeOf('function')
    for (let attempt = 0; attempt < 2; attempt++) {
      engine.die('void')
      engine.retryCurrentLevel()
      resets.push(engineBaseline(engine))
    }

    expect(resets).toEqual([initial, initial])
  })

  it('routes only void death through same-level retry and preserves existing restart-run behavior', () => {
    const engine = createEngine('tower')
    const retry = vi.spyOn(engine, 'retryCurrentLevel').mockReturnValue(true)
    const restart = vi.spyOn(engine, 'startRun').mockImplementation(() => {})

    engine.state.phase = Phase.DEAD
    engine.state.deathReason = 'void'
    engine.ui.onRestart()

    expect(retry).toHaveBeenCalledTimes(1)
    expect(restart).not.toHaveBeenCalled()

    engine.state.deathReason = 'caught'
    engine.ui.onRestart()

    expect(retry).toHaveBeenCalledTimes(1)
    expect(restart).toHaveBeenCalledWith('same-level-void')
  })

  it('never enters PLAYING when rebuilding the same baseline fails', () => {
    const engine = createEngine('lattice')
    const before = engineBaseline(engine)
    engine.die('void')
    engine.ui.showHud.mockClear()
    engine._setupLevel = vi.fn(() => {
      throw new Error('synthetic reset failure')
    })

    expect(engine.retryCurrentLevel).toBeTypeOf('function')
    try {
      engine.retryCurrentLevel()
    } catch {
      // Either propagation or internal reporting is valid; PLAYING is not.
    }

    expect(engine.state.phase).not.toBe(Phase.PLAYING)
    expect(engine.state.seedText).toBe(before.seedText)
    expect(engine.state.level).toBe(before.level)
    expect(engine.state.mapFamily).toBe(before.mapFamily)
    expect(engine.cm.config.version).toBe(before.version)
    expect(engine.ui.showHud).not.toHaveBeenCalled()
  })
})
