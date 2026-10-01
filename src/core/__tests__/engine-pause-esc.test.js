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
      this.lightGrid = {}
      this.enableSightCulling = vi.fn()
      this.config = {
        version: WORLD_GEN_VERSION,
        mapFamily: { selected: 'office' },
      }
      this.loadedCount = 0
      this.exit = null
      this.setSeed = vi.fn()
      this.setExit = vi.fn()
      this.reset = vi.fn()
      this.setRenderDetailProfile = vi.fn()
      this.updateVisibility = vi.fn()
      this.update = vi.fn()
      this.stairAt = vi.fn(() => null)
      this.surfaceAt = vi.fn(() => 'carpet')
      this.lightAt = vi.fn(() => 0.1)
      this.prewarmTitleBackdrop = vi.fn()
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
      this.setRelockVisible = vi.fn()
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
  // No DOM in this env; the Engine's focus guard reads it optionally.
  vi.stubGlobal('document', { activeElement: null })
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

  it('does not resume when Esc keyup lands on a focused menu control (select, input)', () => {
    const engine = pausedEngine()
    engine._pauseT = performance.now() - 1000

    for (const tagName of ['SELECT', 'INPUT', 'TEXTAREA']) {
      document.activeElement = { tagName }
      fire('keyup', { code: 'Escape' })
      expect(engine.state.phase).toBe(Phase.PAUSED)
    }

    // Focus back on the page body: the same keyup resumes.
    document.activeElement = { tagName: 'BODY' }
    fire('keyup', { code: 'Escape' })
    expect(engine.state.phase).toBe(Phase.PLAYING)
    expect(engine.controller.lock).toHaveBeenCalled()
  })

  it('surfaces a rejected re-lock: PLAYING + pointerlockerror shows the hint, keeps the phase', () => {
    const engine = createEngine()
    engine.state.phase = Phase.PLAYING

    engine._onLockError()

    expect(engine.state.phase).toBe(Phase.PLAYING)
    expect(engine._awaitingRelock).toBe(true)
    expect(engine.ui.setRelockVisible).toHaveBeenCalledWith(true)
  })

  it('clears the relock hint once the pointer locks again', () => {
    const engine = createEngine()
    engine.state.phase = Phase.PLAYING
    engine._onLockError()
    engine.ui.setRelockVisible.mockClear()

    engine._onLock(true)

    expect(engine._awaitingRelock).toBe(false)
    expect(engine.ui.setRelockVisible).toHaveBeenCalledWith(false)
  })

  it('ignores lock errors outside live play (pause menu owns the cursor)', () => {
    const engine = pausedEngine()

    engine._onLockError()

    expect(engine._awaitingRelock).toBeFalsy()
    expect(engine.ui.setRelockVisible).not.toHaveBeenCalled()
  })

  it('resuming a pause taken during TRANSITION returns to TRANSITION, not PLAYING', () => {
    const engine = createEngine()
    engine.state.phase = Phase.TRANSITION
    engine.state.level = 2
    engine.pause()
    expect(engine.state.phase).toBe(Phase.PAUSED)

    engine.resume()

    expect(engine.state.phase).toBe(Phase.TRANSITION)
    expect(engine.ui.showTransition).toHaveBeenCalledWith(3)
    expect(engine.ui.showHud).not.toHaveBeenCalled()
  })
})

// Menu entries into a level (ENTER / TRY AGAIN / RESTART) put the loading card
// up and build once it has been presented, instead of freezing the clicked
// button for the whole synchronous prewarm. The click itself still claims the
// audio unlock and pointer lock, which need its user activation.
describe('loading card before a level build', () => {
  let frames
  const flushFrames = () => {
    while (frames.length) frames.shift()()
  }
  const loadingEngine = () => {
    const engine = createEngine()
    engine.ui.showLoading = vi.fn()
    return engine
  }

  beforeEach(() => {
    frames = []
    vi.stubGlobal('requestAnimationFrame', (cb) => frames.push(cb))
    vi.stubGlobal('document', { activeElement: null, hidden: false, hasFocus: () => true })
  })

  it('claims the gesture in the click and builds after the card is presented', () => {
    const engine = loadingEngine()
    const startRun = vi.spyOn(engine, 'startRun')

    engine.ui.onStart('abc', 'sewer')

    expect(engine.audio.start).toHaveBeenCalled()
    expect(engine.controller.lock).toHaveBeenCalledTimes(1)
    expect(engine.ui.showLoading).toHaveBeenCalledWith(1, expect.any(String))
    expect(startRun).not.toHaveBeenCalled()
    expect(engine.cm.prewarm).not.toHaveBeenCalled()
    expect(engine.state.phase).toBe(Phase.TITLE)

    flushFrames()

    expect(startRun).toHaveBeenCalledWith('abc', 'sewer')
    expect(engine.cm.prewarm).toHaveBeenCalledOnce()
    expect(engine.state.phase).toBe(Phase.PLAYING)
    expect(engine.ui.showHud).toHaveBeenCalled()
  })

  it('builds once however often the button is pressed while loading', () => {
    const engine = loadingEngine()
    const startRun = vi.spyOn(engine, 'startRun')

    engine.ui.onStart('abc', 'office')
    engine.ui.onStart('abc', 'office')
    flushFrames()

    expect(startRun).toHaveBeenCalledOnce()
    expect(engine.ui.showLoading).toHaveBeenCalledOnce()
  })

  it('keeps the pointer lock the click was granted instead of racing a second request', () => {
    const engine = loadingEngine()

    engine.ui.onStart('abc', 'office')
    engine.controller.isLocked = true // the async grant landed under the card
    flushFrames()

    expect(engine.state.phase).toBe(Phase.PLAYING)
    expect(engine.controller.lock).toHaveBeenCalledTimes(1)
  })

  it('cannot be resumed by Escape while a pause-menu RESTART is building', () => {
    const engine = pausedEngine()
    engine.ui.showLoading = vi.fn()
    engine._pauseT = performance.now() - 1000
    const startRun = vi.spyOn(engine, 'startRun')

    engine.ui.onRestart()
    fire('keyup', { code: 'Escape' })

    expect(engine.state.phase).toBe(Phase.PAUSED)
    expect(engine.ui.showHud).not.toHaveBeenCalled()
    expect(engine.ui.showLoading).toHaveBeenCalledWith(1, expect.any(String))

    flushFrames()

    expect(startRun).toHaveBeenCalledOnce()
    expect(engine.state.phase).toBe(Phase.PLAYING)
  })

  it('retries a void death at its own level behind the card', () => {
    const engine = loadingEngine()
    engine.state.phase = Phase.PLAYING
    engine.state.level = 4
    engine.die('void')
    const retry = vi.spyOn(engine, 'retryCurrentLevel')

    engine.ui.onRestart()
    expect(engine.ui.showLoading).toHaveBeenCalledWith(4, expect.any(String))
    expect(retry).not.toHaveBeenCalled()

    flushFrames()
    expect(retry).toHaveBeenCalledOnce()
    expect(engine.state.phase).toBe(Phase.PLAYING)
  })

  it('pauses a run that finished building after the page lost focus', () => {
    const engine = loadingEngine()
    engine.ui.onStart('abc', 'office')
    document.hasFocus = () => false

    flushFrames()

    expect(engine.state.phase).toBe(Phase.PAUSED)
    expect(engine.ui.showPause).toHaveBeenCalled()
  })

  it('puts the menu back when the build fails', () => {
    const engine = loadingEngine()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(engine, 'startRun').mockImplementation(() => {
      throw new Error('synthetic build failure')
    })

    engine.ui.onStart('abc', 'office')
    flushFrames()
    error.mockRestore()

    expect(engine.state.phase).toBe(Phase.TITLE)
    expect(engine.ui.showTitle).toHaveBeenCalled()
    expect(engine.controller.unlock).toHaveBeenCalled()
    expect(engine._loading).toBe(false)
  })
})
