// Objects — the project's organized section for every placeable object
// definition: collision-real furniture (furniture/), interior dressing
// props, and architectural joinery. World-generation, structure contracts,
// and map planning deliberately live elsewhere (world/, world/zones/);
// this section owns only what objects LOOK like (model builders, palettes,
// shared frames) plus their public push/collect APIs consumed by mesh.js.
export { pushFurnitureModel, FURN_TINT } from './furniture/index.js'
export { collectInteriorDressing, PROP_TINT, SIGN_TINT } from './dressing/index.js'
export { pushDoorFrame, pushDoorLeaves, pushWindowTrim } from './joinery/index.js'
