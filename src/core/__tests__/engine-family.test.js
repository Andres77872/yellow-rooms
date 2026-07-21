import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Engine } from '../Engine.js'
import { WORLD_GEN_VERSION, ZONE_SEWER } from '../../world/constants.js'
import { hashStr } from '../../world/core/hash.js'

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
      this.setSeed = vi.fn((nextSeed) => {
        this.seed = nextSeed
      })
      this.setExit = vi.fn((cx, cy, cz, lx, lz) => {
        this.exit = { cx, cy, cz, lx, lz }
      })
      this.reset = vi.fn()
      this.updateVisibility = vi.fn()
      this.update = vi.fn()
      this.stairAt = vi.fn(() => null)
      this.surfaceAt = vi.fn(() => 'carpet')
      this.lightAt = vi.fn(() => 0.1)
      this.prewarm = vi.fn((x, z) => {
        this.initialDigest = JSON.stringify({
          version: this.config.version,
          seed: this.seed,
          family: this.config.mapFamily?.selected,
          x,
          z,
        })
        return this.initialDigest
      })
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

const fakeLocation = { search: '' }

beforeEach(() => {
  vi.stubGlobal('devicePixelRatio', 1)
  vi.stubGlobal('innerWidth', 1280)
  vi.stubGlobal('innerHeight', 720)
  vi.stubGlobal('addEventListener', vi.fn())
  fakeLocation.search = ''
  vi.stubGlobal('location', fakeLocation)
  vi.stubGlobal('history', {
    replaceState: vi.fn((_state, _title, url) => {
      fakeLocation.search = url
    }),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const createEngine = () => new Engine({ appendChild: vi.fn() })

describe('?family= boot selection', () => {
  it('applies a valid family before the title-backdrop prewarm', () => {
    fakeLocation.search = '?family=lattice'
    const engine = createEngine()

    expect(engine.cm.config.mapFamily.selected).toBe('lattice')
    expect(engine.state.mapFamily).toBe('lattice')
    // The prewarm digest recorded in the constructor already carries the
    // family — proof the config was applied before the backdrop generated.
    expect(JSON.parse(engine.cm.initialDigest).family).toBe('lattice')
  })

  it('normalizes case and whitespace', () => {
    fakeLocation.search = '?family=%20Sewer%20'
    const engine = createEngine()
    expect(engine.state.mapFamily).toBe('sewer')
    expect(engine.cm.config.zoneBands[0].id).toBe(ZONE_SEWER)
  })

  it.each(['?family=hospital', '?family=', ''])(
    'falls back to office without crashing for %j',
    (search) => {
      fakeLocation.search = search
      const engine = createEngine()
      expect(engine.state.mapFamily).toBe('office')
      expect(engine.cm.config.mapFamily.selected).toBe('office')
    }
  )
})

describe('startRun family plumbing', () => {
  it('builds the family config, hashes the seed, and writes both URL params', () => {
    const engine = createEngine()
    engine.startRun('abc', 'sewer')

    expect(engine.state.mapFamily).toBe('sewer')
    expect(engine.cm.config.mapFamily.selected).toBe('sewer')
    // Sewer projection is applied (zone bands force ZONE_SEWER everywhere).
    expect(engine.cm.config.zoneBands[0].id).toBe(ZONE_SEWER)
    expect(engine.cm.setSeed).toHaveBeenCalledWith(hashStr('abc#1'))
    const q = new URLSearchParams(fakeLocation.search)
    expect(q.get('seed')).toBe('abc')
    expect(q.get('family')).toBe('sewer')
    expect(engine.ui.setFamilyInput).toHaveBeenCalledWith('sewer')
  })

  it('keeps family and config identity across level advance and restarts', () => {
    const engine = createEngine()
    engine.startRun('abc', 'sewer')
    const config = engine.cm.config

    engine._advance()
    expect(engine.state.level).toBe(2)
    expect(engine.state.mapFamily).toBe('sewer')
    expect(engine.cm.config).toBe(config) // no rebuild between levels
    expect(engine.cm.setSeed).toHaveBeenLastCalledWith(hashStr('abc#2'))

    // Restart without an explicit family (death → TRY AGAIN path) keeps it.
    engine.startRun('abc')
    expect(engine.state.mapFamily).toBe('sewer')
    expect(engine.cm.config).toBe(config) // identity preserved, not recloned
  })

  it('removes the family param for office runs and accepts any case', () => {
    const engine = createEngine()
    engine.startRun('abc', 'TOWER')
    expect(engine.state.mapFamily).toBe('tower')
    expect(new URLSearchParams(fakeLocation.search).get('family')).toBe('tower')

    engine.startRun('abc', 'office')
    expect(engine.state.mapFamily).toBe('office')
    const q = new URLSearchParams(fakeLocation.search)
    expect(q.get('seed')).toBe('abc')
    expect(q.get('family')).toBeNull()
  })

  it('falls back to office for junk families passed to startRun', () => {
    const engine = createEngine()
    engine.startRun('abc', 'hospital')
    expect(engine.state.mapFamily).toBe('office')
    expect(engine.cm.config.mapFamily.selected).toBe('office')
  })
})
