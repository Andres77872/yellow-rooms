import * as THREE from 'three'
import { section, slider, toggle, button, readout, buttonRow } from './widgets.js'

// Tooltips for the stalker's live parameter scrubs, keyed by Stalker field.
// Values write straight onto the live entity; "apply level (reset)" and a
// reload restore the level-scaled defaults.
export const AI_PARAM_TIPS = {
  chaseSpeed: 'Base chase/pursuit speed in world units per second; the light multiplier (dark speed×) scales it at runtime.',
  interval: 'Seconds between hunt teleports while it cannot see you. Lower = relocates more often.',
  sightDist: 'Maximum distance in metres at which the sight gate can spot you (also gated by frustum and walls).',
  minRange: 'Nearest distance in metres a hunt teleport may land from you. Raising it past max range drags max range along.',
  maxRange: 'Farthest distance in metres a hunt teleport may land from you. Lowering it below min range drags min range along.',
  catchDist: 'Distance in metres at which it catches you (kills unless invincible is on).',
  despawnDelay: 'Seconds of lost sight before it gives up and vanishes.',
  respawnCooldown: 'Seconds it stays dormant after vanishing before it spawns again.',
  darkSpeedMul: 'Chase-speed multiplier in full darkness; lit cells blend toward the slower lit multiplier.',
}

// Stalker AI inspector: live state readout, active controls, and optional 3D
// gizmos (line-of-sight ray, teleport range rings, last target) drawn into the
// game scene. The 2D map (World tab) carries the richer overlay; this adds
// first-person gizmos + the control surface. Per-frame AI flags are computed
// once by DebugMode (against the PLAYER camera) and read here.
export class AiTool {
  constructor(engine, dbg) {
    this.engine = engine
    this.dbg = dbg
    this._build()
    this._buildGizmos()
  }

  _build() {
    const root = document.createElement('div')
    this.el = root
    const s = this.engine.stalker

    // --- Readout --------------------------------------------------------
    const rs = section('state')
    root.appendChild(rs.el)
    this._r = {
      state: readout('state'),
      timer: readout('timer'),
      dist: readout('dist'),
      flags: readout('seen/LOS/frust'),
      light: readout('light/beam'),
      tension: readout('tension'),
      level: readout('level'),
      params: readout('range/intvl/spd'),
    }
    for (const k of Object.keys(this._r)) rs.body.appendChild(this._r[k].el)

    // --- Controls -------------------------------------------------------
    const cs = section('controls')
    root.appendChild(cs.el)
    cs.body.appendChild(
      buttonRow('', [
        button({
          label: 'force teleport',
          tip: 'Activate the stalker and teleport it now to a hidden cell between min and max range of you (fails silently if no spot is found).',
          onClick: () => s.forceTeleport(this.engine.camera, this.engine.controller.pos, this.engine.controller.floor),
        }),
      ]).el
    )
    cs.body.appendChild(toggle({
        label: 'freeze AI',
        value: false,
        tip: 'Stop the stalker thinking and moving where it stands. Cleared when debug mode closes.',
        onChange: (v) => (s.frozen = v),
      }).el)
    this._invinc = toggle({
      label: 'invincible',
      value: this.dbg.invincible,
      tip: 'Nothing kills you (entity catches or sanity running out) while the debug panel is open. On by default each time debug mode opens.',
      onChange: (v) => (this.dbg.invincible = v),
    })
    cs.body.appendChild(this._invinc.el)
    cs.body.appendChild(
      toggle({
        label: 'always visible',
        value: false,
        tip: 'Keep the stalker model drawn even while dormant or despawned (debug only; reset when debug mode closes).',
        onChange: (v) => ((s.alwaysVisible = v), (s.mesh.visible = v || s.active)),
      }).el
    )
    this._observe = toggle({
      label: 'live observe (unfreeze)',
      value: !this.dbg.freeze,
      tip: { text: 'Let the simulation run so AI reacts live; off freezes the whole sim (same flag as F3 and the light tab freeze).', keys: 'F3' },
      onChange: (v) => this.dbg.setFreeze(!v),
    })
    cs.body.appendChild(this._observe.el)
    cs.body.appendChild(toggle({
        label: 'show map overlay',
        value: true,
        tip: 'Draw AI state (entities, sight, candidates, ranges) on the World tab map.',
        onChange: (v) => (this.dbg.aiOverlay = v),
      }).el)
    cs.body.appendChild(toggle({
        label: '3D gizmos',
        value: false,
        tip: 'In-world overlays: line-of-sight ray (green = seen), min/max teleport range rings around you, last teleport target box.',
        onChange: (v) => (this.gizmos.visible = v),
      }).el)
    // (Entity placement moved to the world map's click-mode control.)

    // Level stepper.
    const lvl = slider({
      label: 'level',
      min: 1,
      max: 20,
      step: 1,
      value: this.engine.state.level,
      fmt: 0,
      tip: 'Level (1-20) used by "apply level (reset)". Nothing changes until you press it.',
      onInput: (v) => (this._level = v),
    })
    this._level = this.engine.state.level
    cs.body.appendChild(lvl.el)
    cs.body.appendChild(
      buttonRow('', [
        button({
          label: 'apply level (reset)',
          tip: 'Reset the stalker with the chosen level’s scaled ranges, speeds and timers, discarding param-scrub edits (the scrub sliders keep their old positions; the state readout shows the new values).',
          onClick: () => s.reset(this._level, this.engine.controller.pos),
        }),
      ]).el
    )

    // --- Live param scrubs ---------------------------------------------
    const ps = section('params (live)')
    root.appendChild(ps.el)
    this._p = {}
    const add = (key, label, min, max, step, fmt = 1) => {
      const w = slider({
        label,
        min,
        max,
        step,
        value: s[key] ?? 0,
        fmt,
        tip: AI_PARAM_TIPS[key],
        onInput: (v) => this._setParam(key, v),
      })
      ps.body.appendChild(w.el)
      this._p[key] = w
    }
    add('chaseSpeed', 'chase speed', 0, 12, 0.1)
    add('interval', 'interval', 0.5, 10, 0.1)
    add('sightDist', 'sight dist', 5, 120, 1, 0)
    add('minRange', 'min range', 2, 40, 0.5)
    add('maxRange', 'max range', 4, 60, 0.5)
    add('catchDist', 'catch dist', 0.5, 5, 0.05, 2)
    add('despawnDelay', 'despawn delay', 0.5, 8, 0.1)
    add('respawnCooldown', 'respawn cd', 0.5, 12, 0.1)
    add('darkSpeedMul', 'dark speed×', 0.5, 2.5, 0.05, 2)

    // --- Pursuer (the Crawler) ------------------------------------------
    const pu = section('pursuer')
    root.appendChild(pu.el)
    const p = this.engine.pursuer
    this._pr = {
      state: readout('state'),
      dist: readout('dist'),
      floor: readout('floor'),
    }
    for (const k of Object.keys(this._pr)) pu.body.appendChild(this._pr[k].el)
    pu.body.appendChild(toggle({
        label: 'freeze pursuer',
        value: false,
        tip: 'Stop the Crawler (pursuer) moving and thinking. Cleared when debug mode closes.',
        onChange: (v) => (p.frozen = v),
      }).el)
    pu.body.appendChild(
      toggle({
        label: 'always visible',
        value: false,
        tip: 'Keep the Crawler model drawn even while inactive (debug only; reset when debug mode closes).',
        onChange: (v) => ((p.alwaysVisible = v), (p.mesh.visible = v || p.active)),
      }).el
    )
    pu.body.appendChild(
      slider({
        label: 'speed',
        min: 0,
        max: 12,
        step: 0.1,
        value: p.chaseSpeed,
        fmt: 1,
        tip: 'Crawler chase speed in m/s (0-12). Live; its level reset restores the scaled default.',
        onInput: (v) => (p.chaseSpeed = v),
      }).el
    )

    // --- Husk (the static one) ------------------------------------------
    const hu = section('husk')
    root.appendChild(hu.el)
    const h = this.engine.husk
    this._hr = {
      state: readout('state'),
      dist: readout('dist'),
      timers: readout('close/away'),
      kills: readout('kills'),
    }
    for (const k of Object.keys(this._hr)) hu.body.appendChild(this._hr[k].el)
    hu.body.appendChild(toggle({
        label: 'freeze husk',
        value: false,
        tip: 'Stop the husk’s close/away timers and behaviour. Cleared when debug mode closes.',
        onChange: (v) => (h.frozen = v),
      }).el)
    hu.body.appendChild(
      toggle({
        label: 'always visible',
        value: false,
        tip: 'Keep the husk model drawn even while inactive (debug only; reset when debug mode closes).',
        onChange: (v) => ((h.alwaysVisible = v), (h.mesh.visible = v || h.active)),
      }).el
    )
  }

  _setParam(key, v) {
    const s = this.engine.stalker
    s[key] = v
    if (key === 'minRange' && s.minRange > s.maxRange) s.maxRange = s.minRange
    if (key === 'maxRange' && s.maxRange < s.minRange) s.minRange = s.maxRange
  }

  _buildGizmos() {
    const g = new THREE.Group()
    g.visible = false
    // LOS ray.
    const losGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()])
    this._losMat = new THREE.LineBasicMaterial({ color: 0xff5a4a })
    this._los = new THREE.Line(losGeo, this._losMat)
    g.add(this._los)
    // Range rings (unit circle on XZ).
    const ring = (color) => {
      const pts = []
      for (let i = 0; i <= 48; i++) {
        const a = (i / 48) * Math.PI * 2
        pts.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)))
      }
      return new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color })
      )
    }
    this._minRing = ring(0xff7850)
    this._maxRing = ring(0xff5a4a)
    g.add(this._minRing, this._maxRing)
    // Last-target marker.
    this._target = new THREE.Mesh(
      new THREE.BoxGeometry(0.6, 0.6, 0.6),
      new THREE.MeshBasicMaterial({ color: 0x7fff7f, wireframe: true })
    )
    g.add(this._target)
    this.engine.scene.add(g)
    this.gizmos = g
  }

  // Cheap per-frame gizmo refresh (called every frame while debug is active).
  tickGizmos() {
    if (!this.gizmos.visible) return
    const s = this.engine.stalker
    const p = this.engine.controller.pos
    const y = 0.05
    const a = this._los.geometry.attributes.position
    a.setXYZ(0, p.x, y, p.z)
    a.setXYZ(1, s.pos.x, y, s.pos.z)
    a.needsUpdate = true
    this._losMat.color.setHex(this.dbg.aiSeen ? 0x7fff7f : 0xff5a4a)
    this._minRing.position.set(p.x, y, p.z)
    this._minRing.scale.set(s.minRange, 1, s.minRange)
    this._maxRing.position.set(p.x, y, p.z)
    this._maxRing.scale.set(s.maxRange, 1, s.maxRange)
    if (s._lastTarget) {
      this._target.visible = true
      this._target.position.set(s._lastTarget.x, 1, s._lastTarget.z)
    } else {
      this._target.visible = false
    }
  }

  update() {
    const s = this.engine.stalker
    const f = this.dbg.aiFlags
    this._r.state.set(s.stateLabel)
    this._r.timer.set(
      s.active
        ? `tp ${Math.max(0, s._timer).toFixed(1)}s · lost ${Math.max(0, s._lostTimer).toFixed(1)}s`
        : `spawn ${Math.max(0, s._spawnTimer).toFixed(1)}s`
    )
    this._r.dist.set(`${f.dist.toFixed(1)} m${f.dcy ? ` · Δcy ${f.dcy > 0 ? '+' : ''}${f.dcy}` : ''}`)
    this._r.flags.set(`${f.seen ? '●' : '○'} ${f.los ? '●' : '○'} ${f.inFrustum ? '●' : '○'}`)
    const light = this.engine.cm.lightAt(s.pos.x, s.pos.z, s.cy)
    this._r.light.set(`${light.toFixed(2)}${s.inBeam ? ' · BEAM' : ''}`)
    this._r.tension.set(f.tension.toFixed(2))
    this._r.level.set(`${s.level}  catch ${s.catchDist.toFixed(2)}`)
    this._r.params.set(`${s.minRange.toFixed(0)}-${s.maxRange.toFixed(0)} / ${s.interval.toFixed(1)} / ${s.chaseSpeed.toFixed(1)}`)

    // Shared-flag checkboxes track external changes (F3, light-tab freeze).
    this._observe.set(!this.dbg.freeze)
    this._invinc.set(this.dbg.invincible)

    // Pursuer readouts (computed here — only needed while this tab is viewed).
    const p = this.engine.pursuer
    const pl = this.engine.controller.pos
    const pd = Math.hypot(pl.x - p.pos.x, (pl.y || 0) - p.pos.y, pl.z - p.pos.z)
    const pdcy = p.cy - this.engine.controller.floor
    this._pr.state.set(p.stateLabel)
    this._pr.dist.set(p.active ? `${pd.toFixed(1)} m` : '—')
    this._pr.floor.set(`cy ${p.cy}${pdcy ? ` · Δ ${pdcy > 0 ? '+' : ''}${pdcy}` : ''}`)

    // Husk readouts.
    const h = this.engine.husk
    const hd = Math.hypot(pl.x - h.pos.x, (pl.y || 0) - h.pos.y, pl.z - h.pos.z)
    this._hr.state.set(h.stateLabel)
    this._hr.dist.set(h.active ? `${hd.toFixed(1)} m` : `spawn ${Math.max(0, h._spawnTimer).toFixed(1)}s`)
    this._hr.timers.set(`${h._closeT.toFixed(1)}s / ${h._awayT.toFixed(1)}s`)
    this._hr.kills.set(`${h.kills}`)
  }

  onShow() {}

  dispose() {
    this.engine.scene.remove(this.gizmos)
    this._los.geometry.dispose()
    this._losMat.dispose()
    this._minRing.geometry.dispose()
    this._minRing.material.dispose()
    this._maxRing.geometry.dispose()
    this._maxRing.material.dispose()
    this._target.geometry.dispose()
    this._target.material.dispose()
  }
}
