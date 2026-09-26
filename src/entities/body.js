// Model-swap plumbing shared by the three entities (Stalker, Pursuer, Husk).
// Every entity starts as a procedural capsule (render/geometries.js) whose
// geometry is origin-centred (meshYOffset > 0). The Blender GLBs are
// feet-origin, so both upgrades drop the offset and keep the placement the AI
// already chose: position, facing and visibility carry over unchanged.

// Static model: same Mesh, new geometry + the shared entityModel material.
export function upgradeEntityModel(entity, geometry, material) {
  entity.mesh.geometry = geometry
  entity.mesh.material = material
  entity.mesh.scale.set(1, 1, 1)
  entity.meshYOffset = 0
  entity.mesh.position.copy(entity.pos)
  // The shadow capsules follow the silhouette actually shown
  // (render/enemyOccluders.js capsuleSet).
  entity.modelState = 'glb'
}

// Rigged model: the rig instance (bones + SkinnedMesh) REPLACES the capsule
// object in the scene graph, and the entity keeps driving `mesh` exactly as
// before; `anim` (render/enemyAnimator.js) poses it after each AI update.
export function upgradeEntityRig(entity, object, animator) {
  const old = entity.mesh
  object.position.copy(entity.pos)
  object.rotation.copy(old.rotation)
  object.visible = old.visible
  object.scale.set(1, 1, 1)
  if (old.parent) {
    old.parent.add(object)
    old.removeFromParent()
  }
  entity.anim?.dispose()
  entity.mesh = object
  entity.meshYOffset = 0
  entity.anim = animator
  entity.modelState = 'glb'
}
