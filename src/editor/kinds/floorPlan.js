// The kind lab's floor-plan compiler lives in world/tiles/floorPlan.js, so
// the world's tile programs and the editor kinds share one implementation
// (no runtime module imports src/editor). Kinds keep importing their whole
// vocabulary from here.
export * from '../../world/tiles/floorPlan.js'
