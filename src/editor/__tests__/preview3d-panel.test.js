import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { Preview3D, applyPreviewPanelLook } from '../ui/Preview3D.js'
import { PANEL_GLOW } from '../../world/constants.js'
import { LOOK_ORDER, LOOK_PROFILES } from '../../render/lookProfile.js'

// The look preview has no frame loop, so the look's fixture brightness and
// troffer face (which the game sets every frame in Engine._updateFlicker)
// must reach the panel material whenever the look changes.
describe('editor look preview panel', () => {
  it('applies every look\'s panelGlow and troffer pattern', () => {
    for (const id of LOOK_ORDER) {
      const { panelGlow, panelPattern } = LOOK_PROFILES[id].lights
      const materials = { panel: { uniforms: { uIntensity: { value: 0 }, uPanelPattern: { value: 0 } } } }
      applyPreviewPanelLook(materials, { panelGlow, panelPattern })
      // 0.92: the mean of the game's fluorescent hum.
      expect(materials.panel.uniforms.uIntensity.value, id).toBeCloseTo(0.92 * PANEL_GLOW * panelGlow, 9)
      expect(materials.panel.uniforms.uPanelPattern.value, id).toBe(panelPattern)
    }
  })

  it('tolerates a panel material without the troffer face', () => {
    const materials = { panel: { uniforms: { uIntensity: { value: 0 } } } }
    applyPreviewPanelLook(materials, {})
    expect(materials.panel.uniforms.uIntensity.value).toBeCloseTo(0.92 * PANEL_GLOW, 9)
  })

  it('follows a look whose lighting build commits after setLook', () => {
    // DeferredRenderer.setLook only records the wanted look; a look with a
    // different lighting variant commits (and writes panelGlow/panelPattern)
    // inside a later render, once its programs compile.
    const [from, to] = LOOK_ORDER.filter(
      (id, i, all) => all.findIndex((o) => LOOK_PROFILES[o].lights.panelGlow === LOOK_PROFILES[id].lights.panelGlow) === i
    )
    const lights = (id) => LOOK_PROFILES[id].lights
    const deferred = {
      panelGlow: lights(from).panelGlow,
      panelPattern: lights(from).panelPattern,
      wanted: null,
      setLook(id) {
        this.wanted = id
      },
      render() {
        if (!this.wanted) return
        this.panelGlow = lights(this.wanted).panelGlow
        this.panelPattern = lights(this.wanted).panelPattern
        this.wanted = null
      },
    }
    const materials = { panel: { uniforms: { uIntensity: { value: 0 }, uPanelPattern: { value: 0 } } } }
    const p = Object.create(Preview3D.prototype)
    Object.assign(p, {
      mode: from,
      orbit: { tx: 0, ty: 0, tz: 0, radius: 60, theta: -0.7, phi: 1.0 },
      camera: new THREE.PerspectiveCamera(),
      game: { materials, deferred },
      sync: () => {},
    })
    p.setMode(to)
    p.render() // the frame that commits the new look
    p.render()
    expect(materials.panel.uniforms.uIntensity.value).toBeCloseTo(0.92 * PANEL_GLOW * lights(to).panelGlow, 9)
    expect(materials.panel.uniforms.uPanelPattern.value).toBe(lights(to).panelPattern)
  })
})
