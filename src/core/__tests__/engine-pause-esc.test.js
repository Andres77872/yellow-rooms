import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Engine } from '../Engine.js'
import { Phase } from '../GameState.js'
import { WORLD_GEN_VERSION } from '../../world/constants.js'

// Desktop pause-flow wiring: Esc resumes on KEYUP (never keydown — the held
// exit gesture would instantly re-break the re-engaged pointer lock and the
// pause menu would flicker closed -> open), and any click re-locks if the
// browser refused a re-lock. The global addEventListener is a vi.fn() here,
// so the suite invokes the captured handlers directly.

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
      this.config = {
        version: WORLD_GEN_VERSION,
        mapFamily: { selected: 'office' },
      }
      this.loadedCount = 0
      this.exit = null
      this.setSeed = vi.fn()
      this.setExit = vi.fn()
      this.reset = vi.fn()
      this.updateVisibility = vi.fn()
      this.update = vi.fn()
      this.stairAt = vi.fn(() => null)
      this.surfaceAt = vi.fn(() => 'carpet')
      this.lightAt = vi.fn(() => 0.1)
      this.prewarm = vi.fn()
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
      this.isLocked = false
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

vi.mock('../exitPlacement.js', () => ({
  createExitPlacement: () => ({
    cx: 2,
    cy: 1,
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

beforeEach(() => {
  vi.stubGlobal('devicePixelRatio', 1)
  vi.stubGlobal('innerWidth', 1280)
  vi.stubGlobal('innerHeight', 720)
  vi.stubGlobal('addEventListener', vi.fn())
  vi.stubGlobal('location', { search: '' })
  vi.stubGlobal('history', { replaceState: vi.fn() })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const createEngine = () => new Engine({ appendChild: vi.fn() })

const listenersOf = (type) =>
  addEventListener.mock.calls.filter(([t]) => t === type).map(([, fn]) => fn)

const fire = (type, event) => {
  for (const fn of listenersOf(type)) fn(event)
}

const pausedEngine = () => {
  const engine = createEngine()
  engine.state.phase = Phase.PLAYING
  engine.pause()
  expect(engine.state.phase).toBe(Phase.PAUSED)
  return engine
}

describe('desktop pause Esc flow', () => {
  it('resumes on Escape KEYUP and re-locks the pointer', () => {
    const engine = pausedEngine()
    engine._pauseT = performance.now() - 1000 // past the same-press window
    engine.controller.lock.mockClear()

    fire('keyup', { code: 'Escape' })

    expect(engine.state.phase).toBe(Phase.PLAYING)
    expect(engine.ui.showHud).toHaveBeenCalled()
    expect(engine.controller.lock).toHaveBeenCalledTimes(1)
  })

  it('never resumes on Escape KEYDOWN (the held exit gesture re-breaks a fresh lock)', () => {
    const engine = pausedEngine()
    engine._pauseT = performance.now() - 1000

    fire('keydown', { code: 'Escape' })

    expect(engine.state.phase).toBe(Phase.PAUSED)
    expect(engine.controller.lock).not.toHaveBeenCalled()
  })

  it('ignores an Escape keyup inside the same-press window', () => {
    const engine = pausedEngine() // _pauseT stamped just now by pause()

    fire('keyup', { code: 'Escape' })

    expect(engine.state.phase).toBe(Phase.PAUSED)
    expect(engine.controller.lock).not.toHaveBeenCalled()
  })

  it('ignores Escape keyup outside the pause menu', () => {
    const engine = createEngine()
    engine.state.phase = Phase.PLAYING
    engine._pauseT = performance.now() - 1000

    fire('keyup', { code: 'Escape' })

    expect(engine.state.phase).toBe(Phase.PLAYING)
    expect(engine.controller.lock).not.toHaveBeenCalled()
  })

  it('re-locks on click only while PLAYING and unlocked', () => {
    const engine = pausedEngine()
    engine.state.phase = Phase.PLAYING
    engine.controller.isLocked = false
    engine.controller.lock.mockClear()

    fire('click', {})
    expect(engine.controller.lock).toHaveBeenCalledTimes(1)

    engine.controller.isLocked = true
    engine.controller.lock.mockClear()
    fire('click', {})
    expect(engine.controller.lock).not.toHaveBeenCalled()

    // Menu clicks never grab the pointer.
    engine.state.phase = Phase.PAUSED
    engine.controller.isLocked = false
    fire('click', {})
    expect(engine.controller.lock).not.toHaveBeenCalled()
  })
})
