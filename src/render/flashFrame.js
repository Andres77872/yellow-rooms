// Flashlight emitter frame, shared by the shadow map (FlashlightShadow.js),
// the bounce-light raycast (torchBounce.js) and anything else that needs
// the hand position without pulling in three.js.
//
// The emitter sits in the hand, a little right of and below the eye, in
// VIEW space. The offset stays shorter than the player's collision
// clearance (PLAYER_R 0.5 minus the 0.08 wall half-thickness), so it can
// never end up behind a wall the eye is standing against.
export const FLASH_HAND_OFFSET = Object.freeze([0.2, -0.16, 0])
// Shadow-map near plane: the emitter is always >= 0.3 m from any wall.
export const FLASH_NEAR = 0.2
