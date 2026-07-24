import * as THREE from 'three'
import {
  CHUNK,
  CHUNK_WORLD,
  CELL,
  HUB_CELL,
  COL_HALF,
  MONUMENTAL_COL_HALF,
  MAX_COL_HALF,
  LOAD_RADIUS,
  UNLOAD_RADIUS,
  LOAD_RADIUS_Y,
  UNLOAD_RADIUS_Y,
  APERTURE_VIS_CHUNKS,
  LIGHT_SPILL_R,
  MAX_BUILDS_PER_FRAME,
  STREAM_BUILD_BUDGET_MS,
  LAMP_QUERY_R,
  LIGHT_RANGE,
  LAYER_H,
  STALKER_AMBIENT,
  PLAYER_R,
  chunkKey3,
  cIdx,
  layerY,
  worldToChunk,
  worldToCell,
} from './constants.js'
import { DEFAULT_WORLD_CONFIG } from './config.js'
import {
  DEFAULT_RENDER_DETAIL_PROFILE,
  normalizeRenderDetailProfile,
  renderDetailForChunk,
} from './renderDetail.js'
import { slabContract } from './structures/slab.js'
import { chunkMultilevelRooms } from './structures/multilevel.js'
import { Chunk } from './Chunk.js'
import {
  COLUMN_FURNITURE,
  COLUMN_MONUMENTAL,
  MAP_FAMILY_LATTICE,
  MAP_FAMILY_OFFICE,
  MAP_FAMILY_TOWER,
  wallFeatureSeesThrough,
} from './mapTypes.js'
import { validatedRuntimeStructure } from './structures/contract.js'
import { resolveStepSurface } from './stepSurface.js'

const UINT32_MAX = 0xffffffff
const HARD_VOID_PLANE_KEYS = Object.freeze(['deathYmm', 'family', 'id'])
const TITLE_BACKDROP_RADIUS = 2

function exactHardVoidPlane(plane) {
  if (plane === null || typeof plane !== 'object' || Array.isArray(plane)) {
    return false
  }
  const keys = Object.keys(plane).sort()
  return keys.length === HARD_VOID_PLANE_KEYS.length &&
    keys.every((key, index) => key === HARD_VOID_PLANE_KEYS[index]) &&
    Number.isInteger(plane.id) &&
    plane.id >= 0 &&
    plane.id <= UINT32_MAX &&
    (plane.family === MAP_FAMILY_TOWER || plane.family === MAP_FAMILY_LATTICE) &&
    Number.isInteger(plane.deathYmm)
}

function structureSpansFloor(structure, cy) {
  return cy >= structure.baseCy && cy <= structure.topCy
}

function structureHasParticipant(participants, cx, cz) {
  return participants.some(
    (participant) => participant?.cx === cx && participant?.cz === cz
  )
}

function chunkStructure(chunk) {
  return chunk?.structure ?? chunk?.data?.structure ?? null
}

// Cross-floor lamp assignment does not widen residency or chunk visibility.
// Keep its established descriptor-local office filter unchanged in this slice;
// canonical adapter evidence gates the ownership-authorizing surfaces below.
function chunkHasLampContinuity(chunk, cy) {
  const structure = chunkStructure(chunk)
  const participants = structure?.participants ?? structure?.participantChunks
  return !!(
    structure &&
    structure.hasRoom !== false &&
    (Number.isInteger(structure.id) ||
      (typeof structure.id === 'string' && structure.id.length > 0)) &&
    Number.isInteger(structure.baseCy) &&
    Number.isInteger(structure.topCy) &&
    structure.topCy >= structure.baseCy &&
    cy >= structure.baseCy &&
    cy <= structure.topCy &&
    chunk.cy >= structure.baseCy &&
    chunk.cy <= structure.topCy &&
    Array.isArray(participants) &&
    participants.some(
      (participant) =>
        participant?.cx === chunk.cx && participant?.cz === chunk.cz
    )
  )
}

function tagStructureRequest(request, structure) {
  request.structureRequest = true
  request.structure = structure
  return request
}

function clearStructureRequest(request) {
  delete request.structureRequest
  delete request.structure
  return request
}

function apertureRegistryKey(cx, cy, cz, aperture) {
  const lowerCy = Number.isInteger(aperture.lowerCy) ? aperture.lowerCy : cy
  // Tall structures reuse one id on every slab and in both participant chunks;
  // both coordinates and the owning slab therefore belong to the identity.
  return `${aperture.kind}:${aperture.id}:${cx},${lowerCy},${cz}`
}

// Streaming priority is intentionally a tuple rather than relying on loop /
// stable-sort insertion order. Close chunks build first; at equal effective
// distance the player's floor wins, followed by an adjacent floor that is
// actually visible/reachable through this chunk column (stair or multilevel
// opening). Unconnected off-floor chunks retain the historical +2 penalty.
function prioritizeRequest(request, seed, config, pcx, pcy, pcz) {
  const dx = Math.abs(request.cx - pcx)
  const dz = Math.abs(request.cz - pcz)
  const dy = Math.abs(request.cy - pcy)
  const xzDistance = Math.max(dx, dz)
  const lowerCy = Math.min(request.cy, pcy)
  const verticalOpening = dy === 1 && (
    slabContract(seed, request.cx, request.cz, lowerCy, config).hasStair ||
    chunkMultilevelRooms(seed, request.cx, request.cz, lowerCy, config).up.hasRoom
  )

  request.d = xzDistance + (dy !== 0 && !verticalOpening ? 2 : 0)
  request.floorPriority = dy === 0 ? 0 : verticalOpening ? 1 : 2
  request.xzTie = dx + dz
  return request
}

function compareRequests(a, b) {
  return (
    a.d - b.d ||
    a.floorPriority - b.floorPriority ||
    a.xzTie - b.xzTie ||
    a.cy - b.cy ||
    a.cz - b.cz ||
    a.cx - b.cx
  )
}

export class ChunkManager {
  constructor(scene, seed, materials, geom) {
    this.root = new THREE.Group()
    scene.add(this.root)
    this.seed = seed
    this.materials = materials
    this.geom = geom
    this.chunks = new Map() // chunkKey3 -> Chunk
    this.queue = [] // pending keys
    this.queued = new Set()
    this.exit = null // {cx, cy, cz, lx, lz}
    this.config = DEFAULT_WORLD_CONFIG
    // Forced-open clearings applied at generation. The spawn cell (chunk 0,0
    // layer 0 hub) is always cleared so the player never spawns boxed in.
    this.clearings = [{ cx: 0, cy: 0, cz: 0, lx: HUB_CELL, lz: HUB_CELL, r: 1 }]
    // Vertical openings of loaded chunks (stairs and multilevel rooms). Keys
    // include feature identity so one column/slab can never overwrite another.
    // Bounds feed cross-floor light/sight; chunk coords feed visibility gating.
    this.apertures = new Map()
    // Last visibility inputs (re-applied to newly built chunks).
    this._visCy = 0
    this._visStair = null
    // Current streaming origin. _buildNext() uses this while prewarm drains
    // transitively-added tall-structure work.
    this._streamPcx = null
    this._streamPcy = null
    this._streamPcz = null
    // The load box is discrete: while the player stays in the same chunk and
    // floor, its desired requests and unload bounds cannot change. Keep the
    // last planned generation inputs separate from the live origin so update()
    // can keep draining builds without rediscovering the whole box every frame.
    this._streamPlanSeed = null
    this._streamPlanConfig = null
    this._streamPlanChunkCount = null
    // Child-mesh LOD is horizontal and chunk-ring based. Cache the complete
    // classification tuple so the per-frame streaming update only re-walks
    // residents after a chunk transition, quality change or family swap.
    this._renderDetailProfile = DEFAULT_RENDER_DETAIL_PROFILE
    this._detailPcx = null
    this._detailPcz = null
    this._detailFamily = null
    this._detailAppliedProfile = null
  }

  setSeed(seed) {
    this.seed = seed
  }

  setExit(cx, cy, cz, lx, lz) {
    this.exit = { cx, cy, cz, lx, lz }
  }

  // Replace the forced-open clearing list (each {cx,cy,cz,lx,lz,r?}). Keeps the
  // spawn clearing unless the caller overrides it.
  setClearings(list) {
    this.clearings = list
  }

  setRenderDetailProfile(profile) {
    const next = normalizeRenderDetailProfile(profile)
    if (next === this._renderDetailProfile) return false
    this._renderDetailProfile = next

    const pcx = Number.isInteger(this._detailPcx)
      ? this._detailPcx
      : this._streamPcx
    const pcz = Number.isInteger(this._detailPcz)
      ? this._detailPcz
      : this._streamPcz
    if (Number.isInteger(pcx) && Number.isInteger(pcz)) {
      this._syncRenderDetail(pcx, pcz)
    }
    return true
  }

  reset() {
    for (const c of this.chunks.values()) c.dispose()
    this.chunks.clear()
    this.apertures.clear()
    this.queue.length = 0
    this.queued.clear()
    // Visibility inputs must not survive a level reset: every reset() caller
    // respawns on floor 0, and prewarm gates each fresh chunk against these.
    // A stale _visCy from dying on another floor would hide chunks of the
    // spawn floor (void holes with invisible-but-solid walls) until the next
    // floor change.
    this._visCy = 0
    this._visStair = null
    this._streamPcx = null
    this._streamPcy = null
    this._streamPcz = null
    this._streamPlanSeed = null
    this._streamPlanConfig = null
    this._streamPlanChunkCount = null
    this._detailPcx = null
    this._detailPcz = null
    this._detailFamily = null
    this._detailAppliedProfile = null
  }

  _applyRenderDetail(chunk) {
    if (!Number.isInteger(this._detailPcx) || !Number.isInteger(this._detailPcz)) {
      return false
    }
    const detail = renderDetailForChunk(
      this._detailPcx,
      this._detailPcz,
      chunk.cx,
      chunk.cz,
      this._renderDetailProfile
    )
    return chunk.setRenderDetail?.(detail) ?? false
  }

  _syncRenderDetail(pcx, pcz) {
    const family = this.config?.mapFamily?.selected ?? MAP_FAMILY_OFFICE
    if (
      pcx === this._detailPcx &&
      pcz === this._detailPcz &&
      family === this._detailFamily &&
      this._renderDetailProfile === this._detailAppliedProfile
    ) return false

    this._detailPcx = pcx
    this._detailPcz = pcz
    this._detailFamily = family
    this._detailAppliedProfile = this._renderDetailProfile
    for (const chunk of this.chunks.values()) this._applyRenderDetail(chunk)
    return true
  }

  _normalRequestRelevant(request, pcx, pcy, pcz) {
    return (
      Math.abs(request.cx - pcx) <= LOAD_RADIUS &&
      Math.abs(request.cz - pcz) <= LOAD_RADIUS &&
      Math.abs(request.cy - pcy) <= LOAD_RADIUS_Y
    )
  }

  _validatedStructure(structure, levelCy) {
    return validatedRuntimeStructure(
      this.seed,
      this.config,
      structure,
      levelCy
    )
  }

  _chunkSharesStructure(chunk, levelCy) {
    const structure = chunkStructure(chunk)
    const validated = this._validatedStructure(structure, levelCy)
    return !!(
      validated &&
      structureSpansFloor(structure, levelCy) &&
      chunk.cy >= structure.baseCy &&
      chunk.cy <= structure.topCy &&
      structureHasParticipant(validated.participants, chunk.cx, chunk.cz)
    )
  }

  // A structure tag widens only the vertical load radius, plus the one-chunk
  // XZ hysteresis needed when the second participant lies just outside the
  // normal load box. It is never trusted without matching the immutable
  // descriptor's range and participant list.
  _structureRequestRelevant(request, pcx, pcy, pcz) {
    const structure = request.structure
    const validated = this._validatedStructure(structure, pcy)
    return !!(
      request.structureRequest === true &&
      validated &&
      structureSpansFloor(structure, pcy) &&
      request.cy >= structure.baseCy &&
      request.cy <= structure.topCy &&
      structureHasParticipant(validated.participants, request.cx, request.cz) &&
      Math.abs(request.cx - pcx) <= UNLOAD_RADIUS &&
      Math.abs(request.cz - pcz) <= UNLOAD_RADIUS
    )
  }

  _reconcileQueue(pcx, pcy, pcz) {
    const retained = new Map()
    for (const request of this.queue) {
      if (
        !request ||
        !Number.isInteger(request.cx) ||
        !Number.isInteger(request.cy) ||
        !Number.isInteger(request.cz)
      ) continue
      request.key = chunkKey3(request.cx, request.cy, request.cz)
      if (this.chunks.has(request.key)) continue
      const normal = this._normalRequestRelevant(request, pcx, pcy, pcz)
      const structure = this._structureRequestRelevant(request, pcx, pcy, pcz)
      if (request.structureRequest && !structure) clearStructureRequest(request)
      if (!normal && !structure) continue

      const prior = retained.get(request.key)
      if (prior) {
        // Defensively merge a relevant structure tag before collapsing a
        // duplicate. This preserves the stronger lifetime regardless of the
        // stale queue's insertion order.
        if (structure) tagStructureRequest(prior, request.structure)
        continue
      }
      retained.set(
        request.key,
        prioritizeRequest(request, this.seed, this.config, pcx, pcy, pcz)
      )
    }
    this.queue = [...retained.values()]
    this.queued = new Set(retained.keys())
  }

  _enqueueStructureRequests(structure) {
    const pcx = this._streamPcx
    const pcy = this._streamPcy
    const pcz = this._streamPcz
    if (
      !Number.isInteger(pcx) ||
      !Number.isInteger(pcy) ||
      !Number.isInteger(pcz)
    ) return 0

    const validated = this._validatedStructure(structure, pcy)
    if (!validated || !structureSpansFloor(structure, pcy)) return 0
    // expectedParticipants already supplies the canonical frozen (cz,cx)
    // order. Do not create a second runtime ordering policy here.
    const participants = validated.participants
    let added = 0
    for (let cy = structure.baseCy; cy <= structure.topCy; cy++) {
      for (const participant of participants) {
        const { cx, cz } = participant
        const key = chunkKey3(cx, cy, cz)
        if (this.chunks.has(key)) continue

        const existing = this.queue.find((request) => request.key === key)
        if (existing) {
          tagStructureRequest(existing, structure)
          prioritizeRequest(existing, this.seed, this.config, pcx, pcy, pcz)
          this.queued.add(key)
          continue
        }

        const request = tagStructureRequest({ cx, cy, cz, key }, structure)
        if (!this._structureRequestRelevant(request, pcx, pcy, pcz)) continue
        this.queue.push(prioritizeRequest(
          request,
          this.seed,
          this.config,
          pcx,
          pcy,
          pcz
        ))
        this.queued.add(key)
        added++
      }
    }
    this.queue.sort(compareRequests)
    return added
  }

  _discoverStructureRequests(pcy) {
    const seen = new Set()
    for (const chunk of this.chunks.values()) {
      const structure = chunkStructure(chunk)
      const validated = this._validatedStructure(structure, pcy)
      if (!validated || !structureSpansFloor(structure, pcy)) continue
      const participantKey = validated.participants
        .map(({ cx, cz }) => `${cx},${cz}`)
        .join(';')
      const key = `${structure.id}:${structure.baseCy}:${structure.topCy}:${participantKey}`
      if (seen.has(key)) continue
      seen.add(key)
      this._enqueueStructureRequests(structure)
    }
  }

  _planStreamingRequests(pcx, pcy, pcz) {
    // A request may wait across many frames. Reconcile the queue with the
    // CURRENT load box before adding work: teleports and floor handoffs must
    // not spend the build budget on the old location. Rebuilding `queued`
    // from the retained array also repairs stale membership and defensively
    // collapses duplicate requests.
    this._reconcileQueue(pcx, pcy, pcz)

    // Resident structure chunks rediscover their complete vertical volume
    // when the origin changes. This re-tags ordinary overlaps and makes floor
    // changes inside a retained structure self-healing without globally
    // widening Y. Builds also discover structures in _buildNext(), so pending
    // work remains self-expanding while an unchanged origin drains the queue.
    this._discoverStructureRequests(pcy)

    this._enqueueMissingChunks(pcx, pcy, pcz, LOAD_RADIUS, LOAD_RADIUS_Y)
    this.queue.sort(compareRequests)
  }

  _enqueueMissingChunks(pcx, pcy, pcz, xzRadius, yRadius) {
    // Queue missing chunks nearest-first. The player's floor wins ties;
    // off-floor chunks only jump the penalty queue when a vertical opening
    // connects them to that floor, because those are the only ones visible
    // through the slab.
    for (let dcy = -yRadius; dcy <= yRadius; dcy++) {
      const cy = pcy + dcy
      for (let dz = -xzRadius; dz <= xzRadius; dz++) {
        for (let dx = -xzRadius; dx <= xzRadius; dx++) {
          const cx = pcx + dx
          const cz = pcz + dz
          const key = chunkKey3(cx, cy, cz)
          if (this.chunks.has(key) || this.queued.has(key)) continue
          this.queue.push(
            prioritizeRequest({ cx, cy, cz, key }, this.seed, this.config, pcx, pcy, pcz)
          )
          this.queued.add(key)
        }
      }
    }
  }

  _unloadOutsideStreamingBounds(pcx, pcy, pcz) {
    let aperturesChanged = false
    for (const [key, c] of this.chunks) {
      const outsideXZ =
        Math.abs(c.cx - pcx) > UNLOAD_RADIUS ||
        Math.abs(c.cz - pcz) > UNLOAD_RADIUS
      const outsideY = Math.abs(c.cy - pcy) > UNLOAD_RADIUS_Y
      const retainedStructure = !outsideXZ && this._chunkSharesStructure(c, pcy)
      if (outsideXZ || (outsideY && !retainedStructure)) {
        for (const a of c.apertures) {
          this.apertures.delete(a.key)
          aperturesChanged = true
        }
        c.dispose()
        this.chunks.delete(key)
      }
    }
    // The aperture registry feeds the cross-floor gating: a stairwell leaving
    // the registry can strand off-floor chunks visible (or a ring stale), so
    // re-gate. (Additions re-gate in _buildNext.)
    if (aperturesChanged) this.updateVisibility(this._visCy, this._visStair)
  }

  // Per-frame streaming around the player. `pcy` is the player's floor index;
  // layers within LOAD_RADIUS_Y stream alongside the XZ ring.
  update(px, pz, pcy = 0) {
    const pcx = worldToChunk(px)
    const pcz = worldToChunk(pz)
    const planDirty =
      pcx !== this._streamPcx ||
      pcy !== this._streamPcy ||
      pcz !== this._streamPcz ||
      this.seed !== this._streamPlanSeed ||
      this.config !== this._streamPlanConfig ||
      this.chunks.size !== this._streamPlanChunkCount

    this._streamPcx = pcx
    this._streamPcy = pcy
    this._streamPcz = pcz
    this._syncRenderDetail(pcx, pcz)

    if (planDirty) {
      this._planStreamingRequests(pcx, pcy, pcz)
      this._streamPlanSeed = this.seed
      this._streamPlanConfig = this.config
    }

    // Queue planning is discrete, but construction stays amortized: unchanged
    // frames keep consuming pending requests, including structure requests
    // appended and re-sorted by _buildNext(). A chunk build is indivisible, so
    // check elapsed time after each one; a slow slice then stands alone instead
    // of being followed by up to three more stalls.
    const buildStart = performance.now()
    for (let i = 0; i < MAX_BUILDS_PER_FRAME && this.queue.length; i++) {
      this._buildNext()
      if (performance.now() - buildStart >= STREAM_BUILD_BUDGET_MS) break
    }

    if (planDirty) this._unloadOutsideStreamingBounds(pcx, pcy, pcz)
    this._streamPlanChunkCount = this.chunks.size
  }

  _buildNext() {
    const { cx, cy, cz, key } = this.queue.shift()
    this.queued.delete(key)
    if (this.chunks.has(key)) return
    const exitCell =
      this.exit && this.exit.cx === cx && this.exit.cy === cy && this.exit.cz === cz
        ? { lx: this.exit.lx, lz: this.exit.lz }
        : null
    const clearings = this.clearings.filter(
      (c) => c.cx === cx && (c.cy ?? 0) === cy && c.cz === cz
    )
    const chunk = new Chunk(
      cx,
      cy,
      cz,
      this.seed,
      this.materials,
      this.geom,
      exitCell,
      this.config,
      clearings.length ? clearings : null
    )
    chunk.mount(this.root)
    this.chunks.set(key, chunk)
    this._applyRenderDetail(chunk)
    // Discovery is intentionally build-driven: ordinary streaming stays at
    // LOAD_RADIUS_Y, but encountering a structure that contains the current
    // player floor schedules its whole participant volume. Sorting inside the
    // helper keeps both steady-state builds and synchronous prewarm stable.
    this._enqueueStructureRequests(chunkStructure(chunk))
    for (const a of chunk.apertures) {
      const apertureKey = apertureRegistryKey(cx, cy, cz, a)
      a.key = apertureKey
      this.apertures.set(apertureKey, { cx, cz, ...a })
    }
    this._applyVisibility(chunk)
    // A NEW aperture can make already-loaded off-floor neighbours visible
    // (they were gated before this stairwell streamed in) — re-gate them.
    if (chunk.apertures.length) this.updateVisibility(this._visCy, this._visStair)
  }

  // The title world is disposable and fog-heavy, so first paint only needs a
  // near, current-floor seed. Canonical structures discovered by those builds
  // still expand through _enqueueStructureRequests and are drained in full.
  // The normal load-box plan remains deliberately invalid: the first title RAF
  // calls update(), schedules the full 9x9x3 box, and resumes amortised builds.
  prewarmTitleBackdrop(px, pz, pcy = 0) {
    const pcx = worldToChunk(px)
    const pcz = worldToChunk(pz)
    this._streamPcx = pcx
    this._streamPcy = pcy
    this._streamPcz = pcz
    this._syncRenderDetail(pcx, pcz)

    // This entry point is for a fresh disposable backdrop. Drop any pending
    // plan so it cannot accidentally turn the bounded seed into a full prewarm;
    // update() reconstructs all missing normal work on the next RAF.
    this.queue.length = 0
    this.queued.clear()
    this._enqueueMissingChunks(
      pcx,
      pcy,
      pcz,
      TITLE_BACKDROP_RADIUS,
      0
    )
    this.queue.sort(compareRequests)
    while (this.queue.length) this._buildNext()

    this._streamPlanSeed = null
    this._streamPlanConfig = null
    this._streamPlanChunkCount = null
  }

  // Build EVERYTHING the streaming radius wants, synchronously. Called behind
  // level-transition overlays so the world never visibly assembles in front of
  // the player (MAX_BUILDS_PER_FRAME only amortises steady-state walking; a
  // fresh level otherwise streams ~240 chunks over ~1s of gameplay).
  prewarm(px, pz, pcy = 0) {
    this.update(px, pz, pcy)
    while (this.queue.length) this._buildNext()
    // prewarm drains outside update()'s per-frame budget; seal the resulting
    // resident set so the first gameplay frame remains a steady-state update.
    this._streamPlanChunkCount = this.chunks.size
  }

  // --- Cross-floor visibility (v8) ---
  // Floors are mutually invisible except through registered vertical openings, so chunks on
  // other floors render only when they could actually be seen: within a small
  // ring of an aperture column connecting to the player's floor — plus the
  // whole adjacent floor while the player is inside a stair footprint (the
  // handoff flips mid-ramp; by the time the eye crosses the slab plane the far
  // floor is already drawn). Everything else keeps rendering cost flat.
  updateVisibility(pcy, transitStair = null) {
    this._visCy = pcy
    this._visStair = transitStair
    for (const c of this.chunks.values()) this._applyVisibility(c)
  }

  _applyVisibility(c) {
    c.group.visible = this._chunkVisible(c)
  }

  _chunkVisible(c) {
    const pcy = this._visCy
    if (c.cy === pcy) return true
    const st = this._visStair
    if (st && (c.cy === st.baseCy || c.cy === st.baseCy + 1)) return true
    // Every streamed slice of the same continuous atrium/shaft must render:
    // looking up or down the void can expose walls and bridges many storeys
    // away. Descriptor validation keeps unrelated far floors gated.
    if (this._chunkSharesStructure(c, pcy)) return true
    if (Math.abs(c.cy - pcy) !== 1) return false
    const lowerCy = Math.min(c.cy, pcy)
    for (const a of this.apertures.values()) {
      if (a.lowerCy !== lowerCy) continue
      if (
        Math.abs(a.cx - c.cx) <= APERTURE_VIS_CHUNKS &&
        Math.abs(a.cz - c.cz) <= APERTURE_VIS_CHUNKS
      ) {
        return true
      }
    }
    return false
  }

  // --- Queries (thin-wall model) ---
  // Walls live on cell edges; a chunk owns its West/North lines and all interior
  // lines (the East/South borders belong to the neighbours). Global line/cell
  // coords resolve to the owning chunk by floor-division. Unloaded -> open.

  _chunkAt(gx, gz, cy) {
    return this.chunks.get(
      chunkKey3(Math.floor(gx / CHUNK), cy, Math.floor(gz / CHUNK))
    )
  }

  wallVAt(gx, gz, cy = 0) {
    const c = this._chunkAt(gx, gz, cy)
    if (!c) return false
    return c.data.vAt(gx - c.cx * CHUNK, gz - c.cz * CHUNK) === 1
  }

  wallHAt(gx, gz, cy = 0) {
    const c = this._chunkAt(gx, gz, cy)
    if (!c) return false
    return c.data.hAt(gx - c.cx * CHUNK, gz - c.cz * CHUNK) === 1
  }

  // Sight opacity is intentionally separate from collision. Observation
  // windows and bridge guards keep wall=1 (movement/pathfinding cannot cross)
  // while their edge feature lets the LOS DDA see into the multilevel room.
  opaqueVAt(gx, gz, cy = 0) {
    const c = this._chunkAt(gx, gz, cy)
    if (!c) return false
    const lx = gx - c.cx * CHUNK
    const lz = gz - c.cz * CHUNK
    return c.data.vAt(lx, lz) === 1 && !wallFeatureSeesThrough(c.data.wallFeatureVAt(lx, lz))
  }

  opaqueHAt(gx, gz, cy = 0) {
    const c = this._chunkAt(gx, gz, cy)
    if (!c) return false
    const lx = gx - c.cx * CHUNK
    const lz = gz - c.cz * CHUNK
    return c.data.hAt(lx, lz) === 1 && !wallFeatureSeesThrough(c.data.wallFeatureHAt(lx, lz))
  }

  columnAt(gx, gz, cy = 0) {
    const c = this._chunkAt(gx, gz, cy)
    if (!c) return false
    return c.data.colAt(gx - c.cx * CHUNK, gz - c.cz * CHUNK) > 0
  }

  columnHalfAt(gx, gz, cy = 0) {
    const c = this._chunkAt(gx, gz, cy)
    if (!c) return 0
    const kind = c.data.colAt(gx - c.cx * CHUNK, gz - c.cz * CHUNK)
    if (!kind) return 0
    // Furniture carries no square column half: swept collision resolves the
    // precise piece AABB (furnitureAt below), and eye-height sight lines pass
    // over the low pieces.
    if (kind === COLUMN_FURNITURE) return 0
    return kind === COLUMN_MONUMENTAL ? MONUMENTAL_COL_HALF : COL_HALF
  }

  // Furniture records anchored at a cell, with chunk-local centres promoted to
  // world coordinates for the swept collision pass. Returns null when empty so
  // the hot loops skip allocation. At most a couple of records share a cell by
  // construction (one piece per cell), but the array keeps the query total.
  furnitureAt(gx, gz, cy = 0) {
    const c = this._chunkAt(gx, gz, cy)
    if (!c) return null
    const lx = gx - c.cx * CHUNK
    const lz = gz - c.cz * CHUNK
    const list = c.data.furniture
    if (!list.length) return null
    let out = null
    for (const f of list) {
      if (f.lx !== lx || f.lz !== lz) continue
      ;(out ??= []).push({ wx: c.cx * CHUNK_WORLD + f.x, wz: c.cz * CHUNK_WORLD + f.z, w: f.w, d: f.d })
    }
    return out
  }

  // Canonical stair descriptor for a cell, or null (see Chunk.buildStairCells).
  stairAt(gx, gz, cy = 0) {
    const c = this._chunkAt(gx, gz, cy)
    if (!c) return null
    return c.stairCells.get(cIdx(gx - c.cx * CHUNK, gz - c.cz * CHUNK)) || null
  }

  // Audible floor material at a cell (see stepSurface.js): the family's floor
  // style refined by the cell's semantics (stair treads, bridges, wet rooms,
  // server rooms). An unloaded chunk resolves to the configured family's base
  // so a footstep can never pop to a different material mid-stream.
  surfaceAt(gx, gz, cy = 0) {
    const c = this._chunkAt(gx, gz, cy)
    const family = c?.data.mapFamily ?? this.config?.mapFamily?.selected
    if (!c) return resolveStepSurface({ family })
    const i = cIdx(gx - c.cx * CHUNK, gz - c.cz * CHUNK)
    return resolveStepSurface({
      family,
      cellKind: c.data.cellKind[i],
      spaceRole: c.data.spaceRole[i],
    })
  }

  // Is this floor slab holed at the cell? A stair hole exposes the ramp from
  // cy-1; a multilevel void exposes the lower atrium hall and is not walkable.
  floorHoleAt(gx, gz, cy = 0) {
    const c = this._chunkAt(gx, gz, cy)
    if (!c) return false
    return c.data.hasFloorHole(gx - c.cx * CHUNK, gz - c.cz * CHUNK)
  }

  // Explicit authored lethal-plane lookup. A loaded raster is not sufficient:
  // the descriptor must still resolve to the canonical structure ownership for
  // every declared participant before its family adapter may authorize death.
  hardVoidAt(gx, gz, cy = 0) {
    if (!Number.isInteger(gx) || !Number.isInteger(gz) || !Number.isInteger(cy)) {
      return null
    }
    const cx = Math.floor(gx / CHUNK)
    const cz = Math.floor(gz / CHUNK)
    const chunk = this._chunkAt(gx, gz, cy)
    const data = chunk?.data
    if (
      !data ||
      chunk.cx !== cx ||
      chunk.cy !== cy ||
      chunk.cz !== cz ||
      data.cx !== cx ||
      data.cy !== cy ||
      data.cz !== cz
    ) return null

    const structure = data.structure
    const validated = this._validatedStructure(structure, cy)
    const adapter = validated?.adapter
    if (
      !validated ||
      (adapter.family !== MAP_FAMILY_TOWER && adapter.family !== MAP_FAMILY_LATTICE) ||
      !structureHasParticipant(validated.participants, cx, cz)
    ) return null

    let plane
    try {
      plane = adapter.hardVoidAt(data, gx - cx * CHUNK, gz - cz * CHUNK)
    } catch {
      return null
    }
    if (
      !exactHardVoidPlane(plane) ||
      plane.id !== structure.id ||
      plane.family !== adapter.family
    ) return null
    return {
      id: plane.id,
      family: plane.family,
      deathYmm: plane.deathYmm,
    }
  }

  // May anything spawn/stand at this world point on layer cy? Unlike the wall
  // queries (unloaded -> open, collision no-ops), placement must FAIL CLOSED:
  // an unloaded chunk is blocked, as are floor holes, stair ramps (an entity
  // placed on a run cell at flat floor height would hover inside the flight)
  // and column interiors — the same walkability rule the pathfinder uses.
  isBlocked(wx, wz, cy = 0) {
    const gx = worldToCell(wx)
    const gz = worldToCell(wz)
    const c = this._chunkAt(gx, gz, cy)
    if (!c) return true
    const lx = gx - c.cx * CHUNK
    const lz = gz - c.cz * CHUNK
    if (c.data.hasFloorHole(lx, lz)) return true
    const s = c.stairCells.get(cIdx(lx, lz))
    if (s && s.part === 'run') return true
    // Placement checks body clearance, not only whether the point lies inside
    // the rendered solid. Monumental clearance is 1.6u from the pier centre,
    // just beyond a 3u cell's edge, so inspect neighbouring cells as well as
    // the point's owner.
    const scanReach = PLAYER_R + MAX_COL_HALF
    for (let colZ = worldToCell(wz - scanReach); colZ <= worldToCell(wz + scanReach); colZ++) {
      for (let colX = worldToCell(wx - scanReach); colX <= worldToCell(wx + scanReach); colX++) {
        const owner = this._chunkAt(colX, colZ, cy)
        if (!owner) continue
        const kind = owner.data.colAt(
          colX - owner.cx * CHUNK,
          colZ - owner.cz * CHUNK
        )
        if (!kind) continue
        const half = (kind === COLUMN_MONUMENTAL ? MONUMENTAL_COL_HALF : COL_HALF) + PLAYER_R
        const ccx = (colX + 0.5) * CELL
        const ccz = (colZ + 0.5) * CELL
        if (Math.abs(wx - ccx) < half && Math.abs(wz - ccz) < half) return true
      }
    }
    return false
  }

  // Cell centre at the FLOOR height of layer cy.
  cellCenter(gx, gz, cy, target) {
    return target.set((gx + 0.5) * CELL, layerY(cy), (gz + 0.5) * CELL)
  }

  _appendChunkLampsNear(c, px, pz, pcy, r2, out) {
    const lamps = c.lamps
    if (!lamps || !lamps.length) return
    const floorDelta = pcy === null ? 0 : Math.abs(c.cy - pcy)
    const structureCandidate = pcy !== null && floorDelta !== 0 &&
      chunkHasLampContinuity(c, pcy) &&
      Math.abs(layerY(c.cy) - layerY(pcy)) <= LIGHT_RANGE
    if (pcy !== null && floorDelta > 1 && !structureCandidate) return

    // Retain the exact AABB rejection after the keyed query. The coordinate
    // bounds below are a conservative square around the circle, while this
    // check removes its corner chunks before their lamp arrays are touched.
    const minX = c.cx * CHUNK_WORLD
    const minZ = c.cz * CHUNK_WORLD
    const ndx = px < minX ? minX - px : px > minX + CHUNK_WORLD ? px - (minX + CHUNK_WORLD) : 0
    const ndz = pz < minZ ? minZ - pz : pz > minZ + CHUNK_WORLD ? pz - (minZ + CHUNK_WORLD) : 0
    if (ndx * ndx + ndz * ndz > r2) return

    const offFloor = pcy !== null && c.cy !== pcy
    for (let i = 0; i < lamps.length; i++) {
      const v = lamps[i]
      const dx = v.x - px
      const dz = v.z - pz
      if (dx * dx + dz * dz > r2) continue
      const adjacentSpill = floorDelta === 1 &&
        this._lampSpills(v, Math.min(v.cy, pcy))
      const structureSpill = structureCandidate &&
        this._lampSpillsThroughStructure(v, c, pcy)
      if (offFloor && !structureSpill && !adjacentSpill) continue
      out.push(v)
    }
  }

  // Lit-lamp world positions within LAMP_QUERY_R of (px,pz). Reuses `out`
  // (cleared in place) to avoid per-refresh allocation.
  //
  // `pcy` (null = legacy unfiltered) applies the cross-floor policy: lamps on
  // the player's floor always qualify; adjacent lamps retain the aperture
  // proximity rule; farther lamps qualify only in a continuous tall structure
  // containing pcy, and only while their layer separation is within the real
  // light range. The shader/lightAt still apply authoritative true-3D falloff.
  collectLampsNear(px, pz, out, pcy = null) {
    out.length = 0
    const r2 = LAMP_QUERY_R * LAMP_QUERY_R

    // Compatibility calls without a concrete floor retain the historical
    // unfiltered scan. Every runtime caller supplies an integer floor, which
    // lets the hot path address only chunks that can possibly contribute.
    if (!Number.isInteger(pcy)) {
      for (const c of this.chunks.values()) {
        this._appendChunkLampsNear(c, px, pz, pcy, r2, out)
      }
      return out
    }

    // Include every chunk AABB that intersects the query circle. Using
    // ceil(...)-1 for the lower edge preserves the exact boundary case where
    // the circle touches the preceding chunk's maximum edge.
    const minCx = Math.ceil((px - LAMP_QUERY_R) / CHUNK_WORLD) - 1
    const maxCx = Math.floor((px + LAMP_QUERY_R) / CHUNK_WORLD)
    const minCz = Math.ceil((pz - LAMP_QUERY_R) / CHUNK_WORLD) - 1
    const maxCz = Math.floor((pz + LAMP_QUERY_R) / CHUNK_WORLD)

    // Same-floor and adjacent-floor spill require at least one neighbour on
    // either side. A farther floor can contribute only while its actual layer
    // separation is within LIGHT_RANGE, so no other floor can pass the
    // unchanged structure-continuity predicate in _appendChunkLampsNear().
    const floorReach = Math.max(1, Math.floor(LIGHT_RANGE / LAYER_H))
    for (let cy = pcy - floorReach; cy <= pcy + floorReach; cy++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        for (let cx = minCx; cx <= maxCx; cx++) {
          const c = this.chunks.get(chunkKey3(cx, cy, cz))
          if (c) this._appendChunkLampsNear(c, px, pz, pcy, r2, out)
        }
      }
    }
    return out
  }

  // Does an off-floor lamp sit close enough to a stair aperture between the
  // two floors to spill through it? (A lamp beyond LIGHT_RANGE of the hole
  // couldn't reach through it anyway, so LIGHT_SPILL_R = LIGHT_RANGE is exact.)
  _lampSpills(v, lowerCy) {
    const r2 = LIGHT_SPILL_R * LIGHT_SPILL_R
    for (const a of this.apertures.values()) {
      if (a.lowerCy !== lowerCy) continue
      const regions = a.regions || [a]
      for (const region of regions) {
        const nearestX = Math.max(region.minX ?? a.centerX, Math.min(region.maxX ?? a.centerX, v.x))
        const nearestZ = Math.max(region.minZ ?? a.centerZ, Math.min(region.maxZ ?? a.centerZ, v.z))
        const dx = v.x - nearestX
        const dz = v.z - nearestZ
        if (dx * dx + dz * dz <= r2) return true
      }
    }
    return false
  }

  // Tall-structure membership proves vertical continuity, but not that a lamp
  // is actually near the void: a participant chunk is much wider than the
  // footprint. Gate each lamp against the canonical global cell bounds, just
  // as adjacent stair spill gates against its aperture region.
  _lampSpillsThroughStructure(v, chunk, pcy) {
    if (!chunkHasLampContinuity(chunk, pcy)) return false
    const lampCy = Number.isInteger(v.cy) ? v.cy : chunk.cy
    if (Math.abs(layerY(lampCy) - layerY(pcy)) > LIGHT_RANGE) return false
    const structure = chunkStructure(chunk)
    const bounds = structure.globalBounds ?? structure.bounds
    if (
      !bounds ||
      !Number.isFinite(bounds.x0) ||
      !Number.isFinite(bounds.z0) ||
      !Number.isFinite(bounds.x1) ||
      !Number.isFinite(bounds.z1) ||
      bounds.x1 < bounds.x0 ||
      bounds.z1 < bounds.z0
    ) return false

    const minX = bounds.x0 * CELL
    const maxX = (bounds.x1 + 1) * CELL
    const minZ = bounds.z0 * CELL
    const maxZ = (bounds.z1 + 1) * CELL
    const nearestX = Math.max(minX, Math.min(maxX, v.x))
    const nearestZ = Math.max(minZ, Math.min(maxZ, v.z))
    const dx = v.x - nearestX
    const dz = v.z - nearestZ
    return dx * dx + dz * dz <= LIGHT_SPILL_R * LIGHT_SPILL_R
  }

  // Scalar light level (0..1) at a world XZ point on layer `cy`, summed from
  // nearby LIT lamps with the same windowed falloff the lighting shader uses
  // (the cubic lampAtt window in render/shaders/common.js). Used by the entity
  // AI to move faster in the dark and crawl under lamps — kept curve-identical
  // for same-floor lamps so the AI's light sense tracks the pools the player
  // actually sees; spill lamps from other floors use true 3D distance (the
  // pool at the bottom of a stairwell or tall void is dimmer, as rendered).
  // Uses a private scratch so it never clobbers the LightField's candidate buffer.
  lightAt(wx, wz, cy = null) {
    const lamps = this.collectLampsNear(wx, wz, (this._litScratch ||= []), cy)
    let acc = STALKER_AMBIENT
    const wy = cy === null ? null : layerY(cy)
    for (let i = 0; i < lamps.length; i++) {
      const v = lamps[i]
      let d
      if (wy !== null && v.cy !== cy) {
        d = Math.hypot(v.x - wx, v.y - wy, v.z - wz)
      } else {
        d = Math.hypot(v.x - wx, v.z - wz)
      }
      if (d >= LIGHT_RANGE) continue
      const f = 1 - d / LIGHT_RANGE
      acc += f * f * f
    }
    return acc < 1 ? acc : 1
  }

  // The exit's world position, if its chunk is currently loaded.
  exitWorld() {
    if (!this.exit) return null
    const c = this.chunks.get(chunkKey3(this.exit.cx, this.exit.cy, this.exit.cz))
    return c?.exitWorld || null
  }

  get loadedCount() {
    return this.chunks.size
  }
}
