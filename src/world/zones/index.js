import { ZONE_OFFICE, ZONE_PILLARS, ZONE_SEWER, ZONE_WAREHOUSE } from '../constants.js'
import * as office from './office.js'
import * as pillars from './pillars.js'
import * as sewer from './sewer.js'
import * as warehouse from './warehouse.js'

// Zone registry: id -> generator module ({ id, generate(data, ctx) }).
export const ZONES = {
  [ZONE_OFFICE]: office,
  [ZONE_PILLARS]: pillars,
  [ZONE_WAREHOUSE]: warehouse,
  [ZONE_SEWER]: sewer,
}

export {
  regionLandmark,
  regionLandmarkAt,
  regionLandmarkContains,
  roomDominanceConfig,
  sampleRegionValue,
  selectRawZone,
  selectZone,
} from './regions.js'
