import * as THREE from 'three'

// Skeletal animation for the rigged enemy GLBs (scripts/blender/build_enemies.py
// exports each figure with a skin and named in-place clips; render/enemyModels.js
// clones one rig per entity). The AI stays authoritative: entities move and
// turn exactly as before, and each frame the animator reads what the entity
// did — ground speed, AI state label, distance to the player — and blends its
// clips to match.
//
// Clip table (names mirror build_enemies.py CLIPS; the vitest export contract
// checks both sides agree):
//   stride   metres of ground one loop covers: a planted foot's travel over
//            its stance divided by the stance duty, measured from the rig.
//            Locomotion playback follows measured speed / stride, so feet
//            plant instead of skating; every gait clip shares one phase (left
//            heel strike at 0), so walk <-> run blends stay in step.
//   minRate / maxRate  loops-per-second clamp: a creeping entity still visibly
//            steps, and a sprinting one slides a little rather than blurring.
//   overlay  additive layer (authored as a delta from the rest pose) weighted
//            over whatever base clip is playing — the Stalker's rising arms.
export const ENEMY_CLIPS = Object.freeze({
  stalker: Object.freeze({
    idle: Object.freeze({}),
    walk: Object.freeze({ stride: 1.41, minRate: 0.35, maxRate: 1.9 }),
    run: Object.freeze({ stride: 3.0, minRate: 0.8, maxRate: 2.8 }),
    reach: Object.freeze({ overlay: true }),
  }),
  pursuer: Object.freeze({
    idle: Object.freeze({}),
    crawl: Object.freeze({ stride: 0.76, minRate: 0.6, maxRate: 4.5 }),
  }),
  husk: Object.freeze({
    idle: Object.freeze({}),
    cornered: Object.freeze({}),
  }),
})

const FADE_TAU = 0.12 // s: base-clip crossfade time constant (~0.35 s to settle)
const HOLD_TAU = 0.05 // s: how fast a beam-pinned entity locks into a statue
const SPEED_TAU = 0.12 // s: ground-speed smoothing (path steps, ramps)
const TELEPORT_DIST = 1.5 // u in one frame: a relocation, not motion
const MOVE_SPEED = 0.25 // u/s: below this an entity is standing
export const STALKER_RUN_ON = 3.3 // u/s: walk -> run
export const STALKER_RUN_OFF = 2.7 // u/s: run -> walk (hysteresis)
export const STALKER_REACH_FAR = 7 // u: arms start rising
export const STALKER_REACH_NEAR = 2.5 // u: arms fully raised

const smooth = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

// --- Clip policies: pure (state -> pose) so tests can pin the behaviour. ---
// state = { label, speed, dist, running }; pose = { base, speed, hold,
// overlays: { name: weight }, running }.

// Stalker: walk when stalking, run when the dark lets it sprint, and statue-
// freeze mid-stride while the flashlight pins it. As it closes in, its arms
// rise toward the player (additive over whatever the legs are doing).
export function stalkerPose({ label, speed, dist, running = false }) {
  const run = running ? speed > STALKER_RUN_OFF : speed > STALKER_RUN_ON
  const moving = speed > MOVE_SPEED
  const near = label !== 'spawning' && label !== 'despawn'
  return {
    base: moving ? (run ? 'run' : 'walk') : 'idle',
    running: moving && run,
    speed,
    hold: label === 'frozen',
    overlays: { reach: near ? smooth(STALKER_REACH_FAR, STALKER_REACH_NEAR, dist) : 0 },
  }
}

// Pursuer: it never stops while it has a route — skitter whenever it moves.
export function pursuerPose({ speed }) {
  return { base: speed > MOVE_SPEED ? 'crawl' : 'idle', speed, hold: false, overlays: {} }
}

// Husk: stands its ground; cowers and trembles while the player crowds it.
export function huskPose({ label }) {
  return { base: label === 'cornered' ? 'cornered' : 'idle', speed: 0, hold: false, overlays: {} }
}

export const ENEMY_POSE = Object.freeze({ stalker: stalkerPose, pursuer: pursuerPose, husk: huskPose })

// Additive overlays are authored as absolute glTF poses; re-express them as a
// delta from the REST pose (not from their own first frame), so weight 0 is
// exactly the base clip and weight 1 adds the full authored lift.
function additiveAgainstRest(clip, root) {
  const reference = []
  for (const track of clip.tracks) {
    const { nodeName, propertyName } = THREE.PropertyBinding.parseTrackName(track.name)
    const value = THREE.PropertyBinding.findNode(root, nodeName)?.[propertyName]
    if (!value?.toArray) continue
    reference.push(new track.constructor(track.name, [0], value.toArray()))
  }
  const rest = new THREE.AnimationClip(`${clip.name}:rest`, 0, reference)
  return THREE.AnimationUtils.makeClipAdditive(clip.clone(), 0, rest)
}

export class EnemyAnimator {
  // root: this entity's rig instance (a fresh clone, still in its rest pose).
  constructor(kind, root, clips) {
    this.kind = kind
    this.root = root
    this.mixer = new THREE.AnimationMixer(root)
    this.layers = new Map() // clip name -> { action, def, duration, weight, time }
    const spec = ENEMY_CLIPS[kind] ?? {}
    for (const clip of clips) {
      const def = spec[clip.name]
      if (!def) continue
      const source = def.overlay ? additiveAgainstRest(clip, root) : clip
      const action = this.mixer.clipAction(source)
      // Time is driven explicitly in update(): the mixer only evaluates.
      action.setEffectiveTimeScale(0)
      action.setEffectiveWeight(0)
      action.play()
      this.layers.set(clip.name, { action, def, duration: Math.max(source.duration, 1e-3), weight: 0, time: 0 })
    }
    this.base = this.layers.has('idle')
      ? 'idle'
      : [...this.layers].find(([, layer]) => !layer.def.overlay)?.[0] ?? null
    if (this.base) this.layers.get(this.base).weight = 1
    this.gait = 0 // shared locomotion phase, in loops [0, 1)
    this.flow = 1 // playback multiplier: eases to 0 while held
    this.speed = 0 // smoothed ground speed (u/s)
    this.running = false
    this._prev = new THREE.Vector3()
    this._hasPrev = false
    this.update(0, { base: this.base })
  }

  get clipNames() {
    return [...this.layers.keys()]
  }

  // Once per game frame, after the entity's AI update: measure what it did,
  // choose clips with the kind's policy, and pose the rig.
  drive(dt, entity, player) {
    if (!entity.mesh?.visible) {
      this._hasPrev = false // re-measure from wherever it reappears
      return
    }
    const p = entity.pos
    let speed = 0
    if (this._hasPrev && dt > 1e-4) {
      const moved = Math.hypot(p.x - this._prev.x, p.z - this._prev.z)
      if (moved > TELEPORT_DIST) this.speed = 0
      else speed = moved / dt
    }
    this._prev.copy(p)
    this._hasPrev = true
    this.speed += (speed - this.speed) * (1 - Math.exp(-dt / SPEED_TAU))
    const dist = player ? Math.hypot(player.x - p.x, (player.y || 0) - p.y, player.z - p.z) : Infinity
    const policy = ENEMY_POSE[this.kind] ?? huskPose
    const pose = policy({ label: entity.stateLabel, speed: this.speed, dist, running: this.running })
    this.running = !!pose.running
    this.update(dt, pose)
  }

  update(dt, pose) {
    dt = dt > 0 ? dt : 0
    this.flow += ((pose.hold ? 0 : 1) - this.flow) * (1 - Math.exp(-dt / HOLD_TAU))
    // A held (beam-pinned) entity freezes everything — clip time, gait and
    // even the crossfade — so it stands exactly as it was caught.
    const adt = dt * this.flow
    const k = 1 - Math.exp(-adt / FADE_TAU)
    const base = this.layers.get(pose.base) && !this.layers.get(pose.base).def.overlay ? pose.base : this.base
    this.base = base
    const gaitDef = base ? this.layers.get(base).def : null
    if (gaitDef?.stride) {
      const rate = THREE.MathUtils.clamp((pose.speed ?? 0) / gaitDef.stride, gaitDef.minRate ?? 0, gaitDef.maxRate ?? Infinity)
      this.gait = (this.gait + adt * rate) % 1
    }
    let total = 0
    for (const [name, layer] of this.layers) {
      if (layer.def.overlay) {
        layer.weight += ((pose.overlays?.[name] ?? 0) - layer.weight) * k
        layer.time = (layer.time + adt) % layer.duration
      } else {
        layer.weight += ((name === base ? 1 : 0) - layer.weight) * k
        layer.time = layer.def.stride ? this.gait * layer.duration : (layer.time + adt) % layer.duration
        total += layer.weight
      }
    }
    for (const layer of this.layers.values()) {
      // Base weights always sum to 1: a crossfade never sags toward the
      // bind pose; overlays add on top.
      const w = layer.def.overlay ? layer.weight : total > 0 ? layer.weight / total : 0
      layer.action.time = layer.time
      layer.action.setEffectiveWeight(w < 1e-4 ? 0 : w)
    }
    this.mixer.update(0)
  }

  weightOf(name) {
    const layer = this.layers.get(name)
    return layer ? layer.action.getEffectiveWeight() : 0
  }

  dispose() {
    this.mixer.stopAllAction()
    this.mixer.uncacheRoot(this.root)
    this.root.traverse((node) => {
      if (node.isSkinnedMesh) node.skeleton?.dispose()
    })
    this.layers.clear()
  }
}
