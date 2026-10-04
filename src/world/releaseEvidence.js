// Release evidence for the active legacy families, moved verbatim from
// config.js (which re-exports it). scripts/repin-world.mjs rewrites these
// literals when WORLD_GEN_VERSION changes; never edit the digests by hand.
import {
  MAP_FAMILY_HOTEL,
  MAP_FAMILY_LATTICE,
  MAP_FAMILY_SEWER,
  MAP_FAMILY_TOWER,
} from './mapTypes.js'

// Atomic active-family release evidence. These values are deliberately pinned
// rather than derived from the current constants so a later version/config/
// corpus change fails closed until every namespace is regenerated together.
export const SEWER_RELEASE_EVIDENCE = Object.freeze({
  family: MAP_FAMILY_SEWER,
  byteImpact: 'changed-output',
  previousVersion: 27,
  previousFamilyRepresentativeDigest: '6e2e3bac0a2dded2243cc2044221172ec63cd5a9ff1681239428301bb64a6315',
  previousFamilyCorpusDigest: '9c3f6e36daa2e30646087f70036e00b5d3ac6ae59ffb902f831c4b9cd4834aef',
  generatorVersion: 28,
  globalGoldenDigest: '5a338f0057c3ff0fb5a6641d8070958d2adc25ed115b5209609217f4445531e4',
  maximumHeightGoldenDigest: 'f0477d8b560db3b69854bfdba52cf1d1567aea3522f6d3b13834d98fae78a186',
  familyRepresentativeDigest: '68a6455eb4406db3d110390f42ec54c8a542efd4cc40c78e53249dc893985447',
  familyCorpusDigest: 'e45d88b1530f1453319accbf62245455bdad4b22ba1e8661552db10e146233a8',
  profileIdentity: 'sewer-forced-audit:loops-2:right-0.65:lamp-2-0.35',
  seedDerivation: 'hashStr("audit-sewer-N#1")',
  affectsMaximumHeight: false,
})

export const TOWER_RELEASE_EVIDENCE = Object.freeze({
  family: MAP_FAMILY_TOWER,
  byteImpact: 'changed-output',
  previousVersion: 27,
  previousFamilyRepresentativeDigest: '669f3426b980c13b954bb845fe5a790c75f8b22bcc1c251307c0837186a22dbc',
  previousFamilyCorpusDigest: '76115f7d329fdf91ef91d41a33ca6369bf8428dc07424f1d80b48fe32c9e3c17',
  generatorVersion: 28,
  globalGoldenDigest: '5a338f0057c3ff0fb5a6641d8070958d2adc25ed115b5209609217f4445531e4',
  maximumHeightGoldenDigest: 'f0477d8b560db3b69854bfdba52cf1d1567aea3522f6d3b13834d98fae78a186',
  familyRepresentativeDigest: '69555093b65e5a05d3877c59f6c10006807712e0a021ead04eda1cca4edb5950',
  familyCorpusDigest: '3e4355b4b3393268a82284ec865072b6a8c871f9e2438384c595997d7811a947',
  profileIdentity: 'tower-forced-audit:levels-3:participants-2:skybridge-1',
  seedDerivation: 'fixed-root-seeds(0x5a17,0x7157,0xc0ffee)',
  affectsMaximumHeight: true,
})

export const LATTICE_RELEASE_EVIDENCE = Object.freeze({
  family: MAP_FAMILY_LATTICE,
  byteImpact: 'changed-output',
  previousVersion: 27,
  previousFamilyRepresentativeDigest: '225647f28578a06ccb689b723de46802c21e9f1551f14bfb9c92ed87720e2e1e',
  previousFamilyCorpusDigest: '364edf0d0165c7fd3045263213dffb83e9389f73303a1e385b13187bc03539e5',
  generatorVersion: 28,
  globalGoldenDigest: '5a338f0057c3ff0fb5a6641d8070958d2adc25ed115b5209609217f4445531e4',
  maximumHeightGoldenDigest: 'f0477d8b560db3b69854bfdba52cf1d1567aea3522f6d3b13834d98fae78a186',
  familyRepresentativeDigest: '44b221dbc17d009993a106c9046c5faad2661303795a85ba1cbfcc4122e13266',
  familyCorpusDigest: 'e848c8d1f0521fcf4ee67c8fc61710bd81074a9f75eb4f64349f3c1ece355a18',
  profileIdentity: 'lattice-forced-audit:levels-5:district-4:anchors-8:cycles-0.12-0.25:exposure-5-20:cues-8',
  seedDerivation: 'hashStr("audit-lattice-N#1"), N=0..2',
  affectsMaximumHeight: true,
})

export const HOTEL_RELEASE_EVIDENCE = Object.freeze({
  family: MAP_FAMILY_HOTEL,
  byteImpact: 'changed-output',
  previousVersion: 27,
  previousFamilyRepresentativeDigest: '8a4ee645d544e44003095773bd35d0eb6f6657a2cefeac16527632b04393dfac',
  previousFamilyCorpusDigest: '9a674f7124457c8e2b941b62c18e1dc393ffccce3f3ae94e15c63a6a243b5391',
  generatorVersion: 28,
  globalGoldenDigest: '5a338f0057c3ff0fb5a6641d8070958d2adc25ed115b5209609217f4445531e4',
  maximumHeightGoldenDigest: 'f0477d8b560db3b69854bfdba52cf1d1567aea3522f6d3b13834d98fae78a186',
  familyRepresentativeDigest: 'a4e2cf5f62892c3b2b0e742a48eea94dd8639e5d549248f644b3411ec778a9a6',
  familyCorpusDigest: '7500e2cca321bd9880ae00f28c6f09587d32160750f999ed3ee24e9290f0a493',
  profileIdentity: 'hotel-forced-audit',
  seedDerivation: 'hashStr("audit-hotel-N#1")',
  affectsMaximumHeight: false,
})

// First-emission evidence of the liminal families, keyed by family id.
// Empty until the release re-pin (scripts/repin-world.mjs --to <v>, step C)
// writes one row per liminal family.
export const LIMINAL_RELEASE_EVIDENCE = Object.freeze({})
