// Surface descriptors (engine-improvement ADR-001 §2, G-buffer v2).
//
// Renderer-independent material identity. A surface is described by physical
// quantities — perceptual roughness, metalness, material occlusion, a normal
// detail strength — instead of by one renderer's uniforms, so the deferred
// G-buffer materials, the editor preview and the debug standard-material
// reference can all be built from the same records.
//
// Two vocabularies feed it:
//   * architectural STYLES (familyPalette floor/wall/ceiling `style`) drive the
//     procedural detail maps (textures.js surfaceDetailTexture) and the tiled
//     world materials;
//   * glTF MATERIAL NAMES from the Blender exports (scripts/blender/*.py name
//     every material `yr_*`). The exporter writes only coarse factors (0.78
//     rough dielectric, or 0.32/0.85 "metal"), so the name is the identity and
//     the factors are the fallback. bakeFurnitureGeometry() resolves each
//     primitive through resolveGltfSurface() and preserves the result as a
//     per-vertex `surface` attribute instead of discarding it.
//
// Values are art calibration, not measurements: they encode the intended
// relationships (carpet never glares, chrome has no diffuse, porcelain is
// smoother than laminate) under the semi-realistic look profile.

export const SURFACE_SCHEMA_VERSION = 1

// Lowest perceptual roughness the deferred BRDF evaluates. GGX at roughness
// ~0 turns a lamp into a sub-pixel spike that aliases under head-bob long
// before any temporal filter exists (chapter 12 §4.5.3).
export const MIN_ROUGHNESS = 0.045

const style = (roughness, metalness, extra = {}) =>
  Object.freeze({
    roughness,
    metalness,
    roughnessVar: 0.06, // +- detail-map variation around `roughness`
    lowRoughness: 0, // extra roughness in the low (grout/seam) parts of the height field
    normalStrength: 1.5, // height-to-normal gain of the procedural detail map
    cavity: 0.35, // how much the height field darkens material AO in crevices
    ...extra,
  })

// Architectural surfaces by palette style. Floors, walls and ceilings of the
// five families all resolve through this table (familyPalette.js `style`).
export const SURFACE_STYLES = Object.freeze({
  // Office floor: dense loop-pile carpet. Very rough, subdued fibre relief.
  carpet: style(0.93, 0, { roughnessVar: 0.04, normalStrength: 1.1, cavity: 0.25 }),
  // Sewer walkway: poured concrete with damp patches (low areas smoother).
  concrete: style(0.84, 0, { roughnessVar: 0.1, normalStrength: 2.4, cavity: 0.45 }),
  // Tower/office glazed tile: smooth faces, rough cementitious grout.
  tile: style(0.24, 0, { roughnessVar: 0.05, lowRoughness: 0.62, normalStrength: 2.6, cavity: 0.4 }),
  // Lattice deck plate: painted steel (a dielectric paint layer, chapter 03
  // §3) worn toward bare metal along the treads — mostly paint.
  deck: style(0.46, 0.22, { roughnessVar: 0.12, normalStrength: 2.2, cavity: 0.4 }),
  // Office walls: paper wallpaper over plaster.
  wallpaper: style(0.74, 0, { roughnessVar: 0.05, normalStrength: 0.9, cavity: 0.2 }),
  // Sewer walls: fired brick courses with sunken mortar.
  brick: style(0.86, 0, { roughnessVar: 0.07, lowRoughness: 0.08, normalStrength: 3.2, cavity: 0.55 }),
  // Tower walls: lacquered interior panels with crisp joints.
  panel: style(0.42, 0, { roughnessVar: 0.05, lowRoughness: 0.3, normalStrength: 1.8, cavity: 0.3 }),
  // Lattice walls: riveted steel plate under old paint; the paint is the
  // surface light sees, with a little exposed metal at the rivets and seams.
  steel: style(0.44, 0.15, { roughnessVar: 0.1, normalStrength: 2.4, cavity: 0.4 }),
  // Sewer ceiling: board-formed concrete soffit.
  vault: style(0.9, 0, { roughnessVar: 0.05, normalStrength: 2.0, cavity: 0.4 }),
})

const DEFAULT_STYLE = SURFACE_STYLES.wallpaper

export function surfaceStyle(name) {
  return SURFACE_STYLES[name] ?? DEFAULT_STYLE
}

const gltf = (roughness, metalness = 0) => Object.freeze({ roughness, metalness })

// Blender material vocabulary (scripts/blender/yr_shading.py MATERIALS and
// build_enemies.py). Exposed metal is metallic; painted or enamelled metal is
// a dielectric paint layer until it wears through (chapter 03 §3).
export const GLTF_SURFACES = Object.freeze({
  // Bare and plated metals.
  yr_chrome: gltf(0.16, 1),
  yr_mirror: gltf(0.05, 1),
  yr_legMetal: gltf(0.34, 0.92),
  yr_applianceSteel: gltf(0.3, 0.9),
  yr_burner: gltf(0.55, 0.6),
  yr_rackFace: gltf(0.42, 0.55),
  yr_rackDark: gltf(0.55, 0.3),
  // Glazed / enamelled / glassy dielectrics.
  yr_porcelain: gltf(0.12),
  yr_screen: gltf(0.1),
  yr_tvBlack: gltf(0.18),
  yr_bottleBlue: gltf(0.08),
  yr_boardWhite: gltf(0.16),
  yr_ledGreen: gltf(0.25),
  yr_applianceWhite: gltf(0.3),
  yr_coolerWhite: gltf(0.34),
  // Painted and laminated surfaces.
  yr_cabinetPaint: gltf(0.46),
  yr_laminate: gltf(0.44),
  yr_counterTop: gltf(0.36),
  yr_drawerFace: gltf(0.5),
  yr_copierBody: gltf(0.52),
  yr_panel: gltf(0.55),
  yr_slotDark: gltf(0.7),
  yr_keyDark: gltf(0.58),
  // Wood.
  yr_woodDark: gltf(0.52),
  yr_woodMid: gltf(0.58),
  yr_shelfWood: gltf(0.62),
  yr_bedFrame: gltf(0.56),
  // Fabric, paper, organics.
  yr_fabric: gltf(0.95),
  yr_sofa: gltf(0.92),
  yr_sofaCushion: gltf(0.93),
  yr_rug: gltf(0.97),
  yr_mattress: gltf(0.9),
  yr_pillow: gltf(0.9),
  yr_blanket: gltf(0.94),
  yr_towel: gltf(0.96),
  yr_shade: gltf(0.82),
  yr_paperWhite: gltf(0.86),
  yr_bookRed: gltf(0.78),
  yr_bookBlue: gltf(0.78),
  yr_bookTan: gltf(0.8),
  yr_potClay: gltf(0.84),
  yr_soil: gltf(1),
  yr_leafGreen: gltf(0.6),
  // Enemies: a faint wet sheen on the ink/blood masses reads as "alive" under
  // a tube; bone and ash stay dry.
  yr_enemy_inkBody: gltf(0.42),
  yr_enemy_inkCloth: gltf(0.8),
  yr_enemy_shirtGrey: gltf(0.85),
  yr_enemy_bonePale: gltf(0.6),
  yr_enemy_bloodBody: gltf(0.36),
  yr_enemy_bloodRidge: gltf(0.45),
  yr_enemy_bloodLimb: gltf(0.4),
  yr_enemy_toothPale: gltf(0.3),
  yr_enemy_eyePale: gltf(0.18),
  yr_enemy_ashBody: gltf(0.88),
  yr_enemy_ashRidge: gltf(0.9),
  yr_enemy_voidFace: gltf(0.7),
})

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

// Resolve a loaded glTF material (a Three material or any object carrying
// name/roughness/metalness) to a surface. Named vocabulary wins; otherwise the
// exported factors are preserved (clamped to the BRDF's supported range).
// Returns a fresh plain object; `known` reports whether the name was mapped.
export function resolveGltfSurface(material) {
  const named = material?.name ? GLTF_SURFACES[material.name] : null
  if (named) return { roughness: named.roughness, metalness: named.metalness, known: true }
  const roughness = Number.isFinite(material?.roughness) ? material.roughness : 1
  const metalness = Number.isFinite(material?.metalness) ? material.metalness : 0
  return {
    roughness: Math.max(MIN_ROUGHNESS, clamp01(roughness)),
    metalness: clamp01(metalness),
    known: false,
  }
}
