import {
  FURN_DESK,
  FURN_CHAIR,
  FURN_TABLE,
  FURN_CABINET,
  FURN_COPIER,
  FURN_COOLER,
  FURN_PLANT,
  FURN_RACK,
  FURN_SOFA,
  FURN_BOOKSHELF,
  FURN_WHITEBOARD,
  FURN_BED,
  FURN_NIGHTSTAND,
  FURN_WARDROBE,
  FURN_TOILET,
  FURN_SINK,
  FURN_TUB,
  FURN_COUNTER,
  FURN_STOVE,
  FURN_FRIDGE,
  FURN_TV,
  FURN_ARMCHAIR,
  FURN_WASHER,
} from '../../furniture.js'
import { desk } from './desk.js'
import { chair } from './chair.js'
import { table } from './table.js'
import { cabinet } from './cabinet.js'
import { copier } from './copier.js'
import { cooler } from './cooler.js'
import { plant } from './plant.js'
import { rack } from './rack.js'
import { sofa } from './sofa.js'
import { bookshelf } from './bookshelf.js'
import { whiteboard } from './whiteboard.js'
import { bed } from './bed.js'
import { nightstand } from './nightstand.js'
import { wardrobe } from './wardrobe.js'
import { toilet } from './toilet.js'
import { sink } from './sink.js'
import { tub } from './tub.js'
import { counter } from './counter.js'
import { stove } from './stove.js'
import { fridge } from './fridge.js'
import { tv } from './tv.js'
import { armchair } from './armchair.js'
import { washer } from './washer.js'

// Furniture model registry — the object-definition half of the furniture
// layer (placement lives in world/furniture.js). Each builder turns one
// ChunkData.furniture record into unit-box descriptors batched by mesh.js
// into a single instanced draw with per-instance tints (see palette.js and
// frame.js). THREE-free, like the dressing and joinery builders.
const BUILDERS = {
  [FURN_DESK]: desk,
  [FURN_CHAIR]: chair,
  [FURN_TABLE]: table,
  [FURN_CABINET]: cabinet,
  [FURN_COPIER]: copier,
  [FURN_COOLER]: cooler,
  [FURN_PLANT]: plant,
  [FURN_RACK]: rack,
  [FURN_SOFA]: sofa,
  [FURN_BOOKSHELF]: bookshelf,
  [FURN_WHITEBOARD]: whiteboard,
  [FURN_BED]: bed,
  [FURN_NIGHTSTAND]: nightstand,
  [FURN_WARDROBE]: wardrobe,
  [FURN_TOILET]: toilet,
  [FURN_SINK]: sink,
  [FURN_TUB]: tub,
  [FURN_COUNTER]: counter,
  [FURN_STOVE]: stove,
  [FURN_FRIDGE]: fridge,
  [FURN_TV]: tv,
  [FURN_ARMCHAIR]: armchair,
  [FURN_WASHER]: washer,
}

export function pushFurnitureModel(out, f) {
  BUILDERS[f.kind]?.(f, out)
  return out
}

export { FURN_TINT } from './palette.js'
