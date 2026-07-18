#!/usr/bin/env node

import { buildChunk } from '../src/world/pipeline.js'
import { DEFAULT_WORLD_CONFIG as CONFIG } from '../src/world/config.js'
import {
  WORLD_GEN_VERSION,
  ZONE_OFFICE,
  ZONE_PILLARS,
  ZONE_WAREHOUSE,
} from '../src/world/constants.js'
import { hashStr } from '../src/world/core/hash.js'
import { regionLandmark, roomDominanceConfig, selectZone } from '../src/world/regions.js'
import {
  CELL_ATRIUM,
  CELL_BRIDGE,
  CELL_CORRIDOR,
  CELL_LOBBY,
  CELL_OPEN,
  CELL_ROOM,
  CELL_STAIR,
  CELL_VOID,
} from '../src/world/mapTypes.js'

const readPositiveInt = (name, fallback) => {
  const index = process.argv.indexOf(name)
  if (index < 0) return fallback
  const value = Number(process.argv[index + 1])
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} requires a positive integer`)
  }
  return value
}

const seedCount = readPositiveInt('--seeds', 10000)
const radius = readPositiveInt('--radius', 4)
const wideSeeds = readPositiveInt('--wide-seeds', 32)
const wideRadius = readPositiveInt('--wide-radius', 80)
const level = readPositiveInt('--level', 1)
const dominance = roomDominanceConfig(CONFIG)
const maxSpan = Math.max(dominance.maxSpanChunks, dominance.heroMaxSpanChunks)

const zoneLabel = {
  [ZONE_OFFICE]: 'office',
  [ZONE_PILLARS]: 'pillars',
  [ZONE_WAREHOUSE]: 'warehouse',
}
const zoneGlyph = {
  [ZONE_OFFICE]: 'O',
  [ZONE_PILLARS]: 'P',
  [ZONE_WAREHOUSE]: 'W',
}
const cellLabel = {
  [CELL_OPEN]: 'open',
  [CELL_ROOM]: 'room',
  [CELL_CORRIDOR]: 'corridor',
  [CELL_LOBBY]: 'lobby',
  [CELL_STAIR]: 'stair',
  [CELL_ATRIUM]: 'atrium',
  [CELL_VOID]: 'void',
  [CELL_BRIDGE]: 'bridge',
}

const worldSeed = (index) => hashStr(`audit-${index}#${level}`)

function scanZones(seed, sampleRadius) {
  const size = sampleRadius * 2 + 1
  const zones = new Uint8Array(size * size)
  const counts = { office: 0, pillars: 0, warehouse: 0 }
  let spawnOffice = true
  for (let z = -sampleRadius; z <= sampleRadius; z++) {
    for (let x = -sampleRadius; x <= sampleRadius; x++) {
      const zone = selectZone(x, z, seed, CONFIG)
      zones[(z + sampleRadius) * size + x + sampleRadius] = zone
      counts[zoneLabel[zone]]++
      if (Math.abs(x) <= dominance.spawnOfficeRadius &&
          Math.abs(z) <= dominance.spawnOfficeRadius && zone !== ZONE_OFFICE) {
        spawnOffice = false
      }
    }
  }

  let maxOpenRun = 0
  for (let z = 0; z < size; z++) {
    let run = 0
    for (let x = 0; x < size; x++) {
      run = zones[z * size + x] === ZONE_OFFICE ? 0 : run + 1
      maxOpenRun = Math.max(maxOpenRun, run)
    }
  }
  for (let x = 0; x < size; x++) {
    let run = 0
    for (let z = 0; z < size; z++) {
      run = zones[z * size + x] === ZONE_OFFICE ? 0 : run + 1
      maxOpenRun = Math.max(maxOpenRun, run)
    }
  }

  const seen = new Uint8Array(zones.length)
  let largestOpenComponent = 0
  for (let start = 0; start < zones.length; start++) {
    if (zones[start] === ZONE_OFFICE || seen[start]) continue
    const stack = [start]
    seen[start] = 1
    let component = 0
    while (stack.length > 0) {
      const current = stack.pop()
      component++
      const x = current % size
      const z = Math.floor(current / size)
      for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nx = x + dx
        const nz = z + dz
        if (nx < 0 || nx >= size || nz < 0 || nz >= size) continue
        const next = nz * size + nx
        if (zones[next] === ZONE_OFFICE || seen[next]) continue
        seen[next] = 1
        stack.push(next)
      }
    }
    largestOpenComponent = Math.max(largestOpenComponent, component)
  }

  return { size, zones, counts, spawnOffice, maxOpenRun, largestOpenComponent }
}

const quantile = (sorted, p) => sorted[Math.floor((sorted.length - 1) * p)]
const spawnSamples = []
let worstOffice = null
let worstWarehouse = null
let worstComponent = null
let worstRun = null
let allSpawnOffice = true
const totals = { office: 0, pillars: 0, warehouse: 0 }

for (let index = 0; index < seedCount; index++) {
  const seed = worldSeed(index)
  const scan = scanZones(seed, radius)
  const sample = {
    index,
    seedText: `audit-${index}`,
    seed,
    ...scan,
  }
  spawnSamples.push(sample)
  for (const key of Object.keys(totals)) totals[key] += scan.counts[key]
  allSpawnOffice &&= scan.spawnOffice
  if (!worstOffice || scan.counts.office < worstOffice.counts.office) worstOffice = sample
  if (!worstWarehouse || scan.counts.warehouse > worstWarehouse.counts.warehouse) worstWarehouse = sample
  if (!worstComponent || scan.largestOpenComponent > worstComponent.largestOpenComponent) {
    worstComponent = sample
  }
  if (!worstRun || scan.maxOpenRun > worstRun.maxOpenRun) worstRun = sample
}

let wideMaxComponent = null
let wideMaxRun = null
let wideMinOfficeShare = null
for (let index = 0; index < wideSeeds; index++) {
  const scan = scanZones(worldSeed(index), wideRadius)
  const chunks = scan.size * scan.size
  const officeShare = scan.counts.office / chunks
  if (!wideMaxComponent || scan.largestOpenComponent > wideMaxComponent.value) {
    wideMaxComponent = { seedText: `audit-${index}`, value: scan.largestOpenComponent }
  }
  if (!wideMaxRun || scan.maxOpenRun > wideMaxRun.value) {
    wideMaxRun = { seedText: `audit-${index}`, value: scan.maxOpenRun }
  }
  if (!wideMinOfficeShare || officeShare < wideMinOfficeShare.value) {
    wideMinOfficeShare = { seedText: `audit-${index}`, value: officeShare }
  }
}

const districtRadius = Math.ceil(wideRadius / dominance.districtChunks) + 1
const landmarks = {
  districts: 0,
  active: 0,
  ordinary: 0,
  hero: 0,
  warehouseCourt: 0,
  adjacentViolations: 0,
  spanViolations: 0,
  signatures: {
    monumentalGrid: 0,
    processionalAisle: 0,
    brokenBay: 0,
    courtColonnade: 0,
  },
}
for (let index = 0; index < wideSeeds; index++) {
  const seed = worldSeed(index)
  for (let dz = -districtRadius; dz <= districtRadius; dz++) {
    for (let dx = -districtRadius; dx <= districtRadius; dx++) {
      landmarks.districts++
      const landmark = regionLandmark(seed, dx, dz, CONFIG)
      if (!landmark.active) continue
      landmarks.active++
      landmarks[landmark.hero ? 'hero' : 'ordinary']++
      landmarks.signatures[landmark.pierPattern]++
      if (landmark.kind === 'warehouseCourt') landmarks.warehouseCourt++
      const min = landmark.hero ? dominance.heroMinSpanChunks : dominance.minSpanChunks
      const max = landmark.hero ? dominance.heroMaxSpanChunks : dominance.maxSpanChunks
      if (landmark.width < min || landmark.width > max ||
          landmark.height < min || landmark.height > max) {
        landmarks.spanViolations++
      }
      if (regionLandmark(seed, dx + 1, dz, CONFIG).active ||
          regionLandmark(seed, dx, dz + 1, CONFIG).active) {
        landmarks.adjacentViolations++
      }
    }
  }
}

const cellCounts = {}
for (const name of Object.values(cellLabel)) cellCounts[name] = 0
for (let cz = -radius; cz <= radius; cz++) {
  for (let cx = -radius; cx <= radius; cx++) {
    const data = buildChunk(worstOffice.seed, cx, 0, cz, CONFIG)
    for (const kind of data.cellKind) cellCounts[cellLabel[kind]]++
  }
}
const sampledCells = Object.values(cellCounts).reduce((sum, count) => sum + count, 0)
const cellShares = Object.fromEntries(
  Object.entries(cellCounts).map(([key, count]) => [key, count / sampledCells])
)
const officeCounts = spawnSamples.map((sample) => sample.counts.office).sort((a, b) => a - b)
const totalChunks = Object.values(totals).reduce((sum, count) => sum + count, 0)
const majorityFloor = Math.floor((worstOffice.size * worstOffice.size) / 2) + 1
const verdict = {
  spawnReservation: allSpawnOffice,
  spawnRoomMajority: worstOffice.counts.office >= majorityFloor,
  boundedCorpusRuns: worstRun.maxOpenRun <= maxSpan,
  boundedCorpusComponents: worstComponent.largestOpenComponent <= maxSpan * maxSpan,
  boundedWideRuns: wideMaxRun.value <= maxSpan,
  boundedWideComponents: wideMaxComponent.value <= maxSpan * maxSpan,
  wideRoomDominance: wideMinOfficeShare.value >= dominance.minOfficeShare,
  nonAdjacentLandmarks: landmarks.adjacentViolations === 0,
  validLandmarkSpans: landmarks.spanViolations === 0,
  landmarkSignatureCoverage: Object.values(landmarks.signatures)
    .every((count) => count > 0),
}
verdict.ok = Object.values(verdict).every(Boolean)

const compactSample = (sample) => ({
  seedText: sample.seedText,
  worldSeed: sample.seed,
  counts: sample.counts,
  largestOpenComponent: sample.largestOpenComponent,
  maxOpenRun: sample.maxOpenRun,
})
const zoneMap = []
for (let z = 0; z < worstOffice.size; z++) {
  let row = ''
  for (let x = 0; x < worstOffice.size; x++) {
    row += zoneGlyph[worstOffice.zones[z * worstOffice.size + x]]
  }
  zoneMap.push(row)
}

const report = {
  generatorVersion: WORLD_GEN_VERSION,
  seedDerivation: `hashStr("audit-N#${level}")`,
  profile: {
    seeds: seedCount,
    spawnWindow: `${worstOffice.size}x${worstOffice.size}`,
    wideSeeds,
    wideWindow: `${wideRadius * 2 + 1}x${wideRadius * 2 + 1}`,
    ordinarySpanChunks: [dominance.minSpanChunks, dominance.maxSpanChunks],
    heroSpanChunks: [dominance.heroMinSpanChunks, dominance.heroMaxSpanChunks],
    minimumLargePatchOfficeShare: dominance.minOfficeShare,
  },
  spawnCorpus: {
    zoneShares: Object.fromEntries(
      Object.entries(totals).map(([key, count]) => [key, count / totalChunks])
    ),
    officeChunks: {
      minimum: officeCounts[0],
      p01: quantile(officeCounts, 0.01),
      median: quantile(officeCounts, 0.5),
      p99: quantile(officeCounts, 0.99),
      maximum: officeCounts.at(-1),
    },
    worstOffice: compactSample(worstOffice),
    worstWarehouse: compactSample(worstWarehouse),
    worstOpenComponent: compactSample(worstComponent),
    worstOpenRun: compactSample(worstRun),
  },
  wideProbe: {
    maximumOpenComponent: wideMaxComponent,
    maximumOpenRun: wideMaxRun,
    minimumOfficeShare: wideMinOfficeShare,
  },
  landmarks: {
    ...landmarks,
    activeShare: landmarks.active / landmarks.districts,
    heroShareOfActive: landmarks.hero / landmarks.active,
  },
  worstOfficeExactCells: {
    seedText: worstOffice.seedText,
    shares: cellShares,
    zoneMap,
  },
  verdict,
}

console.log(JSON.stringify(report, null, 2))
if (!verdict.ok) process.exitCode = 1
