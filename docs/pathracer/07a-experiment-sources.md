# 07a — Experiment sources

Verbatim sources of the scripts behind [07-experiments.md](07-experiments.md).
They are kept here as documentation rather than under `scripts/`: they depend
on packages that are **not** project dependencies (`three-gpu-pathtracer`,
`three-mesh-bvh`, `playwright-core`, `esbuild`), and the repository lint
covers every JS file.

## Reproducing

```bash
# 1. a scratch workspace next to (not inside) the repo
mkdir pt-spike && cd pt-spike
echo '{ "name": "pt-spike", "private": true, "type": "module" }' > package.json
npm install three@0.185.0 three-gpu-pathtracer@0.0.24 three-mesh-bvh@0.9.15 esbuild playwright-core

# 2. the repo must have its own node_modules (npm ci) — the scripts import
#    the game's modules straight from /path/to/yellow-rooms/src
#    (edit the REPO constants below if your checkout lives elsewhere)

# E1 bundle sizes
npx esbuild entry-pt.js --bundle --minify --format=esm --external:three --external:xatlas-web --outfile=out-pt.js
gzip -9c out-pt.js | wc -c

# E2 noise metrics
node noise-experiment.mjs && node noise-edge.mjs

# E3 headless path trace (Chromium with SwiftShader; any Chromium works, the
#    GPU one is much faster)
/path/to/yellow-rooms/node_modules/.bin/vite --config page/vite.config.mjs &
node run-spike.mjs "spp=1024&ring=1&w=320&h=180&bounces=4&cp=16,64,256" shotA.png

# E4 GI reference, then the analysis
for a in "office review" "office atlas" "hotel review" "sewer review"; do node gi-reference.mjs $a 512 6 2; done
node gi-fit.mjs gi-rows-*.json
```

The E1 entry files are one-liners, for example
`import { WebGLPathTracer } from 'three-gpu-pathtracer'; export { WebGLPathTracer }`.

## `noise-experiment.mjs`

```js
// Compare the engine's screen-space noise sources with three-gpu-pathtracer's
// void-and-cluster blue noise. Pure Node; no GPU.
import { BlueNoiseGenerator } from 'three-gpu-pathtracer/src/textures/blueNoise/BlueNoiseGenerator.js'

const N = 256 // analysis tile (power of two for the FFT)

// Deterministic RNG (mulberry32) so the blue-noise tile is reproducible.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// --- generation cost -------------------------------------------------------
const bnTiles = {}
for (const size of [16, 32, 64, 128]) {
  const g = new BlueNoiseGenerator()
  g.random = mulberry32(1234)
  g.size = size
  const t0 = performance.now()
  const { data, maxValue } = g.generate()
  const ms = performance.now() - t0
  bnTiles[size] = Float64Array.from(data, (v) => (v + 0.5) / maxValue)
  console.log(`generate ${size}x${size}: ${ms.toFixed(1)} ms`)
}
// determinism: same seed twice -> identical ranks
{
  const a = new BlueNoiseGenerator(); a.random = mulberry32(99); a.size = 32
  const b = new BlueNoiseGenerator(); b.random = mulberry32(99); b.size = 32
  const da = a.generate().data, db = b.generate().data
  console.log('seeded determinism (32x32):', da.every((v, i) => v === db[i]))
}

// --- noise fields ----------------------------------------------------------
const fract = (x) => x - Math.floor(x)
const f32 = (x) => Math.fround(x)
// engine IGN (shaders/common.js), evaluated at gl_FragCoord = pixel + 0.5, fp32
const ign = (x, y) => {
  const px = x + 0.5, py = y + 0.5
  const d = f32(f32(px * 0.06711056) + f32(py * 0.00583715))
  return fract(f32(52.9829189 * fract(d)))
}
// engine GTAO/contact/volumetric Jimenez 4x4 interleaved (shaders/gtao.js)
const jim4 = (x, y) => ((((x + y) & 3) << 2) | (x & 3)) / 16 + 1 / 32
const rnd = mulberry32(7)
const white = new Float64Array(N * N).map(() => rnd())

const fields = {
  white: (x, y) => white[y * N + x],
  ign,
  'jimenez4x4': jim4,
  'bn32 (tiled)': (x, y) => bnTiles[32][(y & 31) * 32 + (x & 31)],
  'bn64 (tiled)': (x, y) => bnTiles[64][(y & 63) * 64 + (x & 63)],
  'bn128 (tiled)': (x, y) => bnTiles[128][(y & 127) * 128 + (x & 127)],
}

// --- metrics ---------------------------------------------------------------
function fft1d(re, im) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]] }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k), wi = Math.sin(ang * k)
        const ar = re[i + k + len / 2], ai = im[i + k + len / 2]
        const tr = ar * wr - ai * wi, ti = ar * wi + ai * wr
        re[i + k + len / 2] = re[i + k] - tr; im[i + k + len / 2] = im[i + k] - ti
        re[i + k] += tr; im[i + k] += ti
      }
    }
  }
}
function power2d(v) {
  const re = Float64Array.from(v), im = new Float64Array(N * N)
  const r = new Float64Array(N), i2 = new Float64Array(N)
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) { r[x] = re[y * N + x]; i2[x] = im[y * N + x] }
    fft1d(r, i2)
    for (let x = 0; x < N; x++) { re[y * N + x] = r[x]; im[y * N + x] = i2[x] }
  }
  for (let x = 0; x < N; x++) {
    for (let y = 0; y < N; y++) { r[y] = re[y * N + x]; i2[y] = im[y * N + x] }
    fft1d(r, i2)
    for (let y = 0; y < N; y++) { re[y * N + x] = r[y]; im[y * N + x] = i2[y] }
  }
  const p = new Float64Array(N * N)
  for (let k = 0; k < N * N; k++) p[k] = re[k] * re[k] + im[k] * im[k]
  return p
}
function boxResidual(v, r) {
  // RMS of the (2r+1)^2 box-filtered, zero-mean noise (a flat signal's
  // residual error after a spatial resolve of that footprint)
  let s = 0, n = 0
  for (let y = r; y < N - r; y++) for (let x = r; x < N - r; x++) {
    let a = 0
    for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) a += v[(y + j) * N + x + i] - 0.5
    a /= (2 * r + 1) ** 2
    s += a * a; n++
  }
  return Math.sqrt(s / n)
}
const rows = []
for (const [name, f] of Object.entries(fields)) {
  const v = new Float64Array(N * N)
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) v[y * N + x] = f(x, y)
  const mean = v.reduce((a, b) => a + b, 0) / v.length
  // distinct values (quantisation of the pattern)
  const distinct = new Set(Array.from(v, (t) => t.toFixed(6))).size
  // uniformity: KS distance to U(0,1)
  const sorted = Float64Array.from(v).sort()
  let ks = 0
  for (let k = 0; k < sorted.length; k++) ks = Math.max(ks, Math.abs(sorted[k] - (k + 0.5) / sorted.length))
  const p = power2d(Float64Array.from(v, (t) => t - mean))
  let low = 0, total = 0, peak = 0
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    if (!x && !y) continue
    const fx = (x < N / 2 ? x : x - N) / N, fy = (y < N / 2 ? y : y - N) / N
    const fr = Math.hypot(fx, fy)
    total += p[y * N + x]
    if (fr < 0.125) low += p[y * N + x]
    peak = Math.max(peak, p[y * N + x])
  }
  const meanP = total / (N * N - 1)
  rows.push({
    noise: name,
    distinct,
    ks: ks.toFixed(4),
    'lowFreq<0.125 %': ((100 * low) / total).toFixed(2),
    'peak/mean': (peak / meanP).toFixed(0),
    'rms 3x3': boxResidual(v, 1).toFixed(4),
    'rms 5x5': boxResidual(v, 2).toFixed(4),
  })
}
console.table(rows)
```

## `noise-edge.mjs`

```js
// Residual of a flat signal after a 5x5 resolve whose footprint is cut by a
// depth edge (the joint-bilateral rejects the far side): straight edges at
// several orientations/offsets, averaged over every pixel of a 256^2 tile.
import { BlueNoiseGenerator } from 'three-gpu-pathtracer/src/textures/blueNoise/BlueNoiseGenerator.js'
function mulberry32(a){return function(){a|=0;a=(a+0x6d2b79f5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296}}
const N=256, fract=(x)=>x-Math.floor(x), f32=Math.fround
const ign=(x,y)=>{const d=f32(f32((x+.5)*0.06711056)+f32((y+.5)*0.00583715));return fract(f32(52.9829189*fract(d)))}
const jim4=(x,y)=>((((x+y)&3)<<2)|(x&3))/16+1/32
const g=new BlueNoiseGenerator(); g.random=mulberry32(1234); g.size=64
const {data,maxValue}=g.generate(); const bn=Float64Array.from(data,v=>(v+.5)/maxValue)
const bn64=(x,y)=>bn[(y&63)*64+(x&63)]
const rnd=mulberry32(7); const W=new Float64Array(N*N).map(()=>rnd()); const white=(x,y)=>W[y*N+x]
const angles=[0,22.5,45,67.5,90,112.5,135,157.5]
for (const [name,f] of Object.entries({white,ign,jimenez4x4:jim4,bn64})) {
  let s=0,n=0
  for (const a of angles) {
    const nx=Math.cos(a*Math.PI/180), ny=Math.sin(a*Math.PI/180)
    for (const off of [-1.5,-0.5,0.5,1.5]) {
      for (let y=2;y<N-2;y+=3) for (let x=2;x<N-2;x+=3) {
        let acc=0,c=0
        for (let j=-2;j<=2;j++) for (let i=-2;i<=2;i++) {
          if (i*nx+j*ny > off) continue // rejected by the bilateral
          acc+=f(x+i,y+j)-0.5; c++
        }
        if (!c) continue
        const r=acc/c; s+=r*r; n++
      }
    }
  }
  console.log(name.padEnd(12), 'edge-cut 5x5 rms', Math.sqrt(s/n).toFixed(4))
}
```

## `page/vite.config.mjs`

```js
const REPO = '/home/user/yellow-rooms'
const SPIKE = '/path/to/pt-spike'
export default {
  root: SPIKE + '/page',
  logLevel: 'warn',
  resolve: {
    alias: [
      { find: /^three$/, replacement: REPO + '/node_modules/three/build/three.module.js' },
      { find: /^three\/(.*)$/, replacement: REPO + '/node_modules/three/$1' },
      { find: /^@yr\/(.*)$/, replacement: REPO + '/src/$1' },
    ],
  },
  server: { port: 5199, strictPort: true, fs: { allow: [REPO, SPIKE] } },
}
```

## `page/main.js`

```js
// Feasibility spike: path trace real Yellow Rooms chunks with three-gpu-pathtracer.
import * as THREE from 'three'
import { WebGLPathTracer } from 'three-gpu-pathtracer'
import { Chunk } from '@yr/world/Chunk.js'
import { createGBufferMaterials } from '@yr/render/gbufferMaterials.js'
import { createGeometries } from '@yr/render/geometries.js'
import { worldConfigForFamily } from '@yr/world/mapFamily.js'
import { hashStr } from '@yr/world/core/hash.js'
import { HUB_CELL, SPAWN_WORLD, EYE_H, WALL_H, PANEL_GLOW, LIGHT_INTENSITY } from '@yr/world/constants.js'

const q = new URLSearchParams(location.search)
const family = q.get('family') ?? 'office'
const W = +(q.get('w') ?? 320), H = +(q.get('h') ?? 180)
const ring = +(q.get('ring') ?? 1)
const lampPower = +(q.get('lamp') ?? 6)
const log = (window.__log = [])
const t = () => performance.now()

const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true })
renderer.setPixelRatio(1)
renderer.setSize(W, H)
renderer.toneMapping = THREE.ACESFilmicToneMapping
document.body.appendChild(renderer.domElement)

const config = worldConfigForFamily(family)
const seed = hashStr(`${q.get('seed') ?? 'review'}#1`)
const materials = createGBufferMaterials(renderer, family)
const geom = createGeometries()

// --- 1. build real chunks with the game's generator + mesher ---------------
let t0 = t()
const chunks = []
for (let cz = -ring; cz <= ring; cz++) for (let cx = -ring; cx <= ring; cx++) {
  const clear = cx === 0 && cz === 0 ? [{ cx: 0, cy: 0, cz: 0, lx: HUB_CELL, lz: HUB_CELL, r: 1 }] : null
  chunks.push(new Chunk(cx, 0, cz, seed, materials, geom, null, config, clear, null))
}
log.push(['generate+mesh chunks', chunks.length, (t() - t0).toFixed(0) + ' ms'])

// --- 2. mirror to MeshStandardMaterial (as debug/PbrReference.js does) ------
const white = new THREE.Color(1, 1, 1)
const matCache = new Map()
function mirror(src) {
  if (matCache.has(src)) return matCache.get(src)
  const u = src.uniforms ?? {}
  const color = (u.uColor?.value ?? white).clone()
  let m
  if ((u.uMatID?.value ?? 0) === 1) {
    m = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: color, emissiveIntensity: PANEL_GLOW })
  } else {
    m = new THREE.MeshStandardMaterial({
      color, map: u.map?.value ?? null,
      roughness: u.uRoughness?.value ?? 0.6, metalness: u.uMetalness?.value ?? 0,
      vertexColors: true,
    })
  }
  matCache.set(src, m)
  return m
}
// InstancedMesh is flattened as ONE mesh by the WebGL generator (instance
// matrices ignored), so expand every instance into baked world geometry,
// folding instanceColor into a vertex colour attribute.
t0 = t()
const scene = new THREE.Scene()
let tris = 0, instances = 0
const tmpM = new THREE.Matrix4(), tmpC = new THREE.Color()
const geomBuckets = new Map()
function pushGeom(mat, g) {
  if (!geomBuckets.has(mat)) geomBuckets.set(mat, [])
  geomBuckets.get(mat).push(g)
}
function prep(g, color) {
  g = g.index ? g.toNonIndexed() : g.clone()
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(k)) g.deleteAttribute(k)
  const n = g.attributes.position.count
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2))
  const col = new Float32Array(n * 3)
  const src = g.attributes.color
  for (let i = 0; i < n; i++) {
    const r = src ? src.getX(i) : 1, gg = src ? src.getY(i) : 1, b = src ? src.getZ(i) : 1
    col[i * 3] = r * color.r; col[i * 3 + 1] = gg * color.g; col[i * 3 + 2] = b * color.b
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3))
  return g
}
for (const c of chunks) {
  c.group.updateMatrixWorld(true)
  c.group.traverse((o) => {
    if (!o.isMesh || !o.visible) return
    const mat = mirror(o.material)
    if (o.isInstancedMesh) {
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, tmpM)
        tmpM.premultiply(o.matrixWorld)
        if (o.instanceColor) o.getColorAt(i, tmpC); else tmpC.set(1, 1, 1)
        const g = prep(o.geometry, tmpC)
        g.applyMatrix4(tmpM)
        pushGeom(mat, g)
        instances++
      }
    } else {
      const g = prep(o.geometry, white)
      g.applyMatrix4(o.matrixWorld)
      pushGeom(mat, g)
    }
  })
}
const { mergeGeometries } = await import('three/examples/jsm/utils/BufferGeometryUtils.js')
for (const [mat, list] of geomBuckets) {
  const g = mergeGeometries(list, false)
  tris += g.attributes.position.count / 3
  scene.add(new THREE.Mesh(g, mat))
}
log.push(['mirror+expand', `${instances} instances -> ${geomBuckets.size} merged meshes, ${tris} tris`, (t() - t0).toFixed(0) + ' ms'])

// --- 3. every lit panel becomes a downward RectAreaLight --------------------
let lamps = 0
for (const c of chunks) for (const p of c.lamps) {
  const l = new THREE.RectAreaLight(0xfff1d6, lampPower * LIGHT_INTENSITY, 1.7, 1.0)
  l.position.set(p.x, WALL_H - 0.02, p.z)
  l.lookAt(p.x, 0, p.z)
  scene.add(l)
  lamps++
}
log.push(['rect lights (lit panels)', lamps])
scene.background = new THREE.Color(0)

const camera = new THREE.PerspectiveCamera(70, W / H, 0.05, 200)
camera.position.set(SPAWN_WORLD, EYE_H, SPAWN_WORLD)
camera.rotation.set(0, +(q.get('yaw') ?? 0.6), 0, 'YXZ')
camera.updateMatrixWorld()

// --- 4. path trace -----------------------------------------------------------
const pt = new WebGLPathTracer(renderer)
pt.tiles.set(1, 1)
pt.renderDelay = 0
pt.fadeDuration = 0
pt.minSamples = 0
pt.bounces = +(q.get('bounces') ?? 4)
pt.textureSize.set(256, 256)
t0 = t()
pt.setScene(scene, camera)
log.push(['setScene (BVH + packing, sync)', (t() - t0).toFixed(0) + ' ms'])

const target = +(q.get('spp') ?? 16)
const checkpoints = (q.get('cp') ?? '16,64,256').split(',').map(Number)
const tick = () => new Promise((r) => setTimeout(r, 0))
function readHDR() {
  const tgt = pt.target
  const buf = new Float32Array(tgt.width * tgt.height * 4)
  renderer.readRenderTargetPixels(tgt, 0, 0, tgt.width, tgt.height, buf)
  return buf
}
function lum(buf) {
  const y = new Float32Array(buf.length / 4)
  for (let i = 0; i < y.length; i++) y[i] = 0.2126 * buf[i * 4] + 0.7152 * buf[i * 4 + 1] + 0.0722 * buf[i * 4 + 2]
  return y
}
window.__shots = {}
window.__run = async () => {
  const gl = renderer.getContext()
  t0 = t()
  while (pt.isCompiling || pt.samples === 0) {
    pt.renderSample(); gl.finish()
    await tick()
    if (t() - t0 > 20 * 60e3) { log.push(['gave up waiting for first sample']); return log }
  }
  log.push(['compile + first sample', (t() - t0).toFixed(0) + ' ms'])
  t0 = t()
  const s0 = pt.samples
  const snaps = {}
  let lastLog = t()
  while (pt.samples < target) {
    pt.renderSample(); gl.finish()
    const n = pt.samples
    if (checkpoints.includes(n) && !snaps[n]) {
      snaps[n] = lum(readHDR())
      window.__shots[n] = renderer.domElement.toDataURL('image/png')
    }
    if (t() - lastLog > 10000) { console.log('spp', n, ((t() - t0) / 1000).toFixed(0) + ' s'); lastLog = t() }
    await tick()
  }
  const per = (t() - t0) / Math.max(1, pt.samples - s0)
  log.push(['per full sample (SwiftShader, CPU)', per.toFixed(1) + ' ms', `${pt.samples} spp`, `total ${((t() - t0) / 1000).toFixed(1)} s`])
  const ref = lum(readHDR())
  window.__shots[pt.samples] = renderer.domElement.toDataURL('image/png')
  let mean = 0, nz = 0
  for (const v of ref) { mean += v; if (v > 1e-4) nz++ }
  mean /= ref.length
  log.push(['reference', `${pt.samples} spp`, 'mean Y ' + mean.toFixed(4), 'nonblack ' + ((100 * nz) / ref.length).toFixed(1) + '%'])
  for (const n of checkpoints) {
    const a = snaps[n]; if (!a || n >= pt.samples) continue
    let se = 0
    for (let i = 0; i < a.length; i++) se += (a[i] - ref[i]) ** 2
    log.push([`${n} spp`, 'relRMSE vs ref ' + (Math.sqrt(se / a.length) / mean).toFixed(3)])
  }
  return log
}
window.__ready = true
```

## `run-spike.mjs`

```js
import { chromium } from 'playwright-core'
const qs = process.argv[2] ?? ''
const out = process.argv[3] ?? 'shot.png'
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 640, height: 360 } })
const errors = []
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text().slice(0, 300)); else console.log('[page]', m.text().slice(0, 200)) })
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message))
await page.goto('http://localhost:5199/index.html?' + qs)
await page.waitForFunction(() => window.__ready || window.__log?.length > 99, null, { timeout: 600000 })
const log = await page.evaluate(() => window.__run())
for (const l of log) console.log(l.join(' | '))
const shots = await page.evaluate(() => window.__shots)
const { writeFileSync } = await import('node:fs')
for (const [n, url] of Object.entries(shots)) writeFileSync(out.replace('.png', `-${n}spp.png`), Buffer.from(url.split(',')[1], 'base64'))
console.log('errors/warnings:', errors.slice(0, 8))
await browser.close()
```

## `gi-reference.mjs`

```js
// E4 — Monte Carlo reference for the world-grid cell GI (LightGrid._solveGI).
//
// Builds real chunks with the game's generator + mesher (Node, no GPU), puts
// the GI-relevant surfaces (floor, ceiling, walls/columns/steps) into a
// three-mesh-bvh MeshBVH, and estimates the indirect irradiance on the six
// axis faces at every cell centre (mid height) of the central chunk with the
// SAME emitter model the grid uses (_directCube: point emitter at EMITTER_Y,
// GI_EMIT_FLOOR diffuser, physicalAttenuation window, lampTint) but exact
// visibility and true multi-bounce transport. Compares against the shipped
// ambient cube, then least-squares fits the ambient-cube weights.
//
// usage: node gi-reference.mjs [family] [seedText] [paths] [bounces] [ring]
import * as THREE from 'three'
import { MeshBVH } from 'three-mesh-bvh'

const REPO = '/home/user/yellow-rooms/src'
const { Chunk } = await import(`${REPO}/world/Chunk.js`)
const { createGeometries } = await import(`${REPO}/render/geometries.js`)
const { worldConfigForFamily } = await import(`${REPO}/world/mapFamily.js`)
const { hashStr } = await import(`${REPO}/world/core/hash.js`)
const C = await import(`${REPO}/world/constants.js`)
const GS = await import(`${REPO}/world/lightGrid/gridSpec.js`)
const { LightGrid, physicalAttenuation } = await import(`${REPO}/world/lightGrid/LightGrid.js`)
const { lampTint } = await import(`${REPO}/world/lampCharacter.js`)

const family = process.argv[2] ?? 'office'
const seedText = process.argv[3] ?? 'review'
const PATHS = +(process.argv[4] ?? 128)
const BOUNCES = +(process.argv[5] ?? 5)
const RING = +(process.argv[6] ?? 2)
const { CHUNK, CELL, WALL_H, LIGHT_RANGE, HUB_CELL, layerY, cIdx } = C
const { EMITTER_Y, GI_EMIT_FLOOR, FLAG_CEIL_HOLE, FLAG_FLOOR_HOLE, texelIndex, GI_TEXELS } = GS

// Deterministic RNG (mulberry32).
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b

// ---------------------------------------------------------------------------
// 1. Chunks (cy = 0) with semantic stub materials, like benchmark-render-scene.
const config = worldConfigForFamily(family)
const seed = hashStr(`${seedText}#1`)
const geom = createGeometries()
const mats = new Proxy({}, {
  get(target, key) {
    if (typeof key !== 'string') return undefined
    if (!target[key]) { target[key] = { name: key, isMaterial: true, dispose() {} } }
    return target[key]
  },
})
let t0 = performance.now()
const chunks = []
for (let cz = -RING; cz <= RING; cz++) for (let cx = -RING; cx <= RING; cx++) {
  const clear = cx === 0 && cz === 0 ? [{ cx: 0, cy: 0, cz: 0, lx: HUB_CELL, lz: HUB_CELL, r: 1 }] : null
  chunks.push(new Chunk(cx, 0, cz, seed, mats, geom, null, config, clear, null))
}
const tChunks = performance.now() - t0

// ---------------------------------------------------------------------------
// 2. GI-relevant surfaces -> one world-space BVH (floor, ceiling, walls batch).
const GI_SURFACES = new Set(['carpet', 'ceiling', 'wallpaper'])
const pos = []
const m4 = new THREE.Matrix4(), mi = new THREE.Matrix4(), v = new THREE.Vector3()
function pushMesh(g, matrix) {
  const p = g.attributes.position
  const idx = g.index
  const n = idx ? idx.count : p.count
  for (let k = 0; k < n; k++) {
    const i = idx ? idx.getX(k) : k
    v.set(p.getX(i), p.getY(i), p.getZ(i)).applyMatrix4(matrix)
    pos.push(v.x, v.y, v.z)
  }
}
t0 = performance.now()
for (const c of chunks) {
  c.group.updateMatrixWorld(true)
  c.group.traverse((o) => {
    if (!o.isMesh || !GI_SURFACES.has(o.material?.name)) return
    m4.fromArray(o.matrixWorld.elements)
    if (o.isInstancedMesh) {
      for (let i = 0; i < o.count; i++) {
        mi.fromArray(o.instanceMatrix.array, i * 16).premultiply(m4)
        pushMesh(o.geometry, mi)
      }
    } else pushMesh(o.geometry, m4)
  })
}
const bvhGeom = new THREE.BufferGeometry()
bvhGeom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
const bvh = new MeshBVH(bvhGeom)
const tBvh = performance.now() - t0
const tris = pos.length / 9

// ---------------------------------------------------------------------------
// 3. Shipped grid GI, instrumented to also record the six neighbour terms.
const WALL_FACE_OFFSET = [0, 3, 12, 15]
class InstrumentedGrid extends LightGrid {
  // _directCube with an explicit receiver height (verbatim otherwise).
  _directCubeAt(gx, gz, cy, py, out) {
    out.fill(0)
    const px = (gx + 0.5) * CELL, pz = (gz + 0.5) * CELL
    const lamp = this.lamp
    this.forEachLight(gx, gz, cy, (lx, ly, lz, lcy, vis, lt) => {
      const vx = lx - px, vy = layerY(lcy) + GS.GI_SOURCE_Y - py, vz = lz - pz
      const d = Math.hypot(vx, vy, vz)
      const emit = GI_EMIT_FLOOR + (1 - GI_EMIT_FLOOR) * Math.max(vy / Math.max(d, 1e-4), 0)
      const k = vis * physicalAttenuation(Math.max(d, 0.5)) * emit
      if (k <= 0) return
      const f = [Math.max(0, vx / d), Math.max(0, -vx / d), Math.max(0, vy / d), Math.max(0, -vy / d), Math.max(0, vz / d), Math.max(0, -vz / d)]
      for (let c = 0; c < 3; c++) {
        const t = (lamp[lt * 4 + c] / 255 / GS.TINT_SCALE) * k
        for (let q = 0; q < 6; q++) out[q * 3 + c] += t * f[q]
      }
    })
    return out
  }
  constructor(iterations = 3, floorAtFloor = false) {
    super()
    this.iterations = iterations
    this.floorAtFloor = floorAtFloor
    this.terms = new Map() // texel -> [west, east, north, south, ceil, floor] (luminance)
  }
  _solveGI(rec, rect) {
    // Verbatim copy of LightGrid._solveGI with a configurable iteration
    // count and term capture (luminance of the rgb terms).
    const lx0 = Math.max(0, rect[0] - 1), lz0 = Math.max(0, rect[1] - 1)
    const lx1 = Math.min(CHUNK - 1, rect[2] + 1), lz1 = Math.min(CHUNK - 1, rect[3] + 1)
    const w = lx1 - lx0 + 1, h = lz1 - lz0 + 1, cells = w * h, cy = rec.cy
    const gx0 = rec.cx * CHUNK + lx0, gz0 = rec.cz * CHUNK + lz0
    const E = new Float32Array(cells * 18), open = new Float32Array(cells * 4), holes = new Uint8Array(cells)
    const D = new Float32Array(18), D2 = new Float32Array(18)
    const aF = this.albedo.floor, aC = this.albedo.ceiling, aW = this.albedo.wall
    for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
      const i = z * w + x, gx = gx0 + x, gz = gz0 + z
      this._directCube(gx, gz, cy, D)
      if (this.floorAtFloor) {
        // variant: the floor's direct irradiance measured ON the floor
        // (2 cm above the slab) instead of at the cell centre's mid height
        this._directCubeAt(gx, gz, cy, layerY(cy) + 0.02, D2)
        D[6] = D2[6]; D[7] = D2[7]; D[8] = D2[8]
      }
      const o = i * 18
      for (let c = 0; c < 3; c++) {
        E[o + c] = aW[c] * D[c]; E[o + 3 + c] = aW[c] * D[3 + c]; E[o + 6 + c] = aF[c] * D[6 + c]
        E[o + 9 + c] = aC[c] * D[9 + c]; E[o + 12 + c] = aW[c] * D[12 + c]; E[o + 15 + c] = aW[c] * D[15 + c]
      }
      for (let s = 0; s < 4; s++) open[i * 4 + s] = this._sideOpen(gx, gz, cy, s)
      holes[i] = this._flags(gx, gz, cy) & (FLAG_CEIL_HOLE | FLAG_FLOOR_HOLE)
    }
    const M = this._giM
    const sideTerm = (i, gx, gz, side, c) => {
      const op = open[i * 4 + side], wallE = E[i * 18 + WALL_FACE_OFFSET[side] + c]
      if (op <= 0) return wallE
      const nx = gx + (side === 0 ? -1 : side === 1 ? 1 : 0), nz = gz + (side === 2 ? -1 : side === 3 ? 1 : 0)
      const nm = this._cellMapped(nx, nz, cy) ? M[texelIndex(nx, nz, cy) * 3 + c] : 0
      return op * nm + (1 - op) * wallE
    }
    const vertTerm = (i, gx, gz, up, c) => {
      const face = up ? E[i * 18 + 9 + c] : E[i * 18 + 6 + c]
      const bit = up ? FLAG_CEIL_HOLE : FLAG_FLOOR_HOLE
      if (!(holes[i] & bit)) return face
      const ny = cy + (up ? 1 : -1)
      return this._cellMapped(gx, gz, ny) ? M[texelIndex(gx, gz, ny) * 3 + c] : 0
    }
    const next = new Float32Array(cells * 3)
    for (let iter = 0; iter < this.iterations; iter++) {
      for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
        const i = z * w + x, gx = gx0 + x, gz = gz0 + z
        for (let c = 0; c < 3; c++) {
          let s = vertTerm(i, gx, gz, true, c) + vertTerm(i, gx, gz, false, c)
          for (let side = 0; side < 4; side++) s += sideTerm(i, gx, gz, side, c)
          next[i * 3 + c] = s / 6
        }
      }
      for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
        const i = z * w + x, m = texelIndex(gx0 + x, gz0 + z, cy) * 3
        M[m] = next[i * 3]; M[m + 1] = next[i * 3 + 1]; M[m + 2] = next[i * 3 + 2]
      }
    }
    const A = new Float32Array(18)
    for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
      const i = z * w + x, gx = gx0 + x, gz = gz0 + z
      const T = [0, 0, 0, 0, 0, 0]
      const rgb = []
      for (let c = 0; c < 3; c++) {
        const west = sideTerm(i, gx, gz, 0, c), east = sideTerm(i, gx, gz, 1, c)
        const north = sideTerm(i, gx, gz, 2, c), south = sideTerm(i, gx, gz, 3, c)
        const ceil = vertTerm(i, gx, gz, true, c), floor = vertTerm(i, gx, gz, false, c)
        rgb.push([west, east, north, south, ceil, floor])
        const avgSide = (west + east + north + south) * 0.25, vert = (ceil + floor) * 0.25
        A[c] = 0.5 * east + vert + 0.1 * avgSide
        A[3 + c] = 0.5 * west + vert + 0.1 * avgSide
        A[6 + c] = 0.6 * ceil + 0.4 * avgSide
        A[9 + c] = 0.6 * floor + 0.4 * avgSide
        A[12 + c] = 0.5 * south + vert + 0.1 * avgSide
        A[15 + c] = 0.5 * north + vert + 0.1 * avgSide
      }
      for (let k = 0; k < 6; k++) T[k] = lum(rgb[0][k], rgb[1][k], rgb[2][k])
      this.terms.set(texelIndex(gx, gz, cy), T)
      this._writeGI(texelIndex(gx, gz, cy), A)
      this.stats.giCells++
    }
    this._pushCellDirty(['gi'], gx0, gz0, cy, w, h)
  }
}
function buildGrid(iterations) {
  const g = new InstrumentedGrid(iterations)
  for (const c of chunks) g.addChunk(c.data)
  g.setPlayerFloor(0)
  g.flush()
  return g
}
const fromHalf = (h) => {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff
  if (e === 0) return s * 2 ** -14 * (f / 1024)
  if (e === 31) return f ? NaN : s * Infinity
  return s * 2 ** (e - 15) * (1 + f / 1024)
}
// Face order used below: +X, -X, +Y, -Y, +Z, -Z. _writeGI stores
// texel0 = (lx, lxn, lz, lzn), texel1 = (ly, lyn, up chroma...).
function gridCube(g, gx, gz) {
  const o = texelIndex(gx, gz, 0) * GI_TEXELS * 4
  const q = (k) => fromHalf(g.gi[o + k])
  return [q(0), q(1), q(4), q(5), q(2), q(3)]
}

// ---------------------------------------------------------------------------
// 4. Emitters: every lit lamp, tinted exactly like _writeCells (luminance).
const lamps = []
const tint = [0, 0, 0]
for (const c of chunks) {
  const d = c.data
  for (const l of d.lamps) {
    if (!l.lit) continue
    const gx = d.cx * CHUNK + l.lx, gz = d.cz * CHUNK + l.lz
    const wx = (gx + 0.5) * CELL, wz = (gz + 0.5) * CELL
    lampTint(wx, wz, 0, tint, d.spaceRole?.[cIdx(l.lx, l.lz)] ?? 0)
    // the grid quantises tint * TINT_SCALE to 8 bits; mirror it
    const q = (x) => Math.min(255, Math.round(x * GS.TINT_SCALE * 255)) / 255 / GS.TINT_SCALE
    lamps.push({ x: wx, y: layerY(0) + EMITTER_Y, z: wz, L: lum(q(tint[0]), q(tint[1]), q(tint[2])) })
  }
}
const ray = new THREE.Ray()
const EPS = 1e-3
function visible(px, py, pz, qx, qy, qz) {
  const dx = qx - px, dy = qy - py, dz = qz - pz
  const d = Math.hypot(dx, dy, dz)
  ray.origin.set(px, py, pz)
  ray.direction.set(dx / d, dy / d, dz / d)
  const hit = bvh.raycastFirst(ray, THREE.DoubleSide, EPS, d - EPS)
  return !hit
}
// Direct irradiance at x with normal n, grid emitter model, exact visibility.
function direct(px, py, pz, nx, ny, nz) {
  let E = 0
  for (const l of lamps) {
    const vx = l.x - px, vy = l.y - py, vz = l.z - pz
    const d = Math.hypot(vx, vy, vz)
    if (d >= LIGHT_RANGE) continue
    const cos = (vx * nx + vy * ny + vz * nz) / d
    if (cos <= 0) continue
    const emit = GI_EMIT_FLOOR + (1 - GI_EMIT_FLOOR) * Math.max(vy / Math.max(d, 1e-4), 0)
    const k = physicalAttenuation(Math.max(d, 0.5)) * emit * l.L
    if (k <= 0) continue
    if (!visible(px + nx * EPS, py + ny * EPS, pz + nz * EPS, l.x, l.y, l.z)) continue
    E += k * cos
  }
  return E
}
const ALB = { floor: lum(0.4, 0.4, 0.4), wall: lum(0.5, 0.5, 0.5), ceiling: lum(0.5, 0.5, 0.5) }
function cosineDir(nx, ny, nz, r1, r2) {
  // orthonormal basis around n: t1 = normalize(a x n), t2 = n x t1
  const ax = Math.abs(nx) > 0.9 ? 0 : 1, ay = Math.abs(nx) > 0.9 ? 1 : 0
  let t1x = ay * nz, t1y = -ax * nz, t1z = ax * ny - ay * nx
  const l = Math.hypot(t1x, t1y, t1z); t1x /= l; t1y /= l; t1z /= l
  const t1 = [t1x, t1y, t1z]
  const t2 = [ny * t1z - nz * t1y, nz * t1x - nx * t1z, nx * t1y - ny * t1x]
  const phi = 2 * Math.PI * r1, rr = Math.sqrt(r2)
  const u = rr * Math.cos(phi), w = rr * Math.sin(phi), h = Math.sqrt(Math.max(0, 1 - r2))
  return [t1[0] * u + nx * h + t2[0] * w, t1[1] * u + ny * h + t2[1] * w, t1[2] * u + nz * h + t2[2] * w]
}
const hitN = new THREE.Vector3()
// Indirect irradiance at p facing n: returns [1-bounce, multi-bounce]
function indirect(px, py, pz, nx, ny, nz, R) {
  let one = 0, multi = 0, half = 0
  for (let s = 0; s < PATHS; s++) {
    if (s === PATHS / 2) half = multi
    let ox = px, oy = py, oz = pz, onx = nx, ony = ny, onz = nz
    let thr = 1
    for (let b = 0; b < BOUNCES; b++) {
      const [dx, dy, dz] = cosineDir(onx, ony, onz, R(), R())
      ray.origin.set(ox + onx * EPS, oy + ony * EPS, oz + onz * EPS)
      ray.direction.set(dx, dy, dz)
      const hit = bvh.raycastFirst(ray, THREE.DoubleSide, EPS, 200)
      if (!hit) break
      hitN.copy(hit.face.normal)
      if (hitN.x * dx + hitN.y * dy + hitN.z * dz > 0) hitN.negate()
      const alb = hitN.y > 0.5 ? ALB.floor : hitN.y < -0.5 ? ALB.ceiling : ALB.wall
      ox = hit.point.x; oy = hit.point.y; oz = hit.point.z
      onx = hitN.x; ony = hitN.y; onz = hitN.z
      thr *= alb
      const e = thr * direct(ox, oy, oz, onx, ony, onz)
      if (b === 0) one += e
      multi += e
    }
  }
  return [one / PATHS, multi / PATHS, (2 * half) / PATHS, (2 * (multi - half)) / PATHS]
}

// ---------------------------------------------------------------------------
// 5. Evaluate the central chunk and dump per-cell rows.
t0 = performance.now()
const grids = { g3: buildGrid(3), g8: buildGrid(8) }
const gF = new InstrumentedGrid(3, true)
for (const c of chunks) gF.addChunk(c.data)
gF.setPlayerFloor(0); gF.flush()
const tGrid = performance.now() - t0
const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
const rows = []
t0 = performance.now()
const R = rng(0x9e3779b9 ^ hashStr(family + seedText))
for (let lz = 0; lz < CHUNK; lz++) for (let lx = 0; lx < CHUNK; lx++) {
  const gx = lx, gz = lz
  const flags = grids.g3._flags(gx, gz, 0)
  if (flags & (GS.FLAG_COLUMN | GS.FLAG_PIER | FLAG_CEIL_HOLE | FLAG_FLOOR_HOLE)) continue
  const px = (gx + 0.5) * CELL, py = layerY(0) + WALL_H * 0.5, pz = (gz + 0.5) * CELL
  const ref1 = [], refM = [], refA = [], refB = []
  for (const [nx, ny, nz] of FACES) {
    const [a, b, h1, h2] = indirect(px, py, pz, nx, ny, nz, R)
    ref1.push(a); refM.push(b); refA.push(h1); refB.push(h2)
  }
  const tex = texelIndex(gx, gz, 0)
  rows.push({
    gx, gz, ref1, refM, refA, refB,
    g3: gridCube(grids.g3, gx, gz), g8: gridCube(grids.g8, gx, gz), gF: gridCube(gF, gx, gz),
    terms: grids.g3.terms.get(tex), termsF: gF.terms.get(tex),
  })
}
const tMC = performance.now() - t0
const out = {
  family, seedText, paths: PATHS, bounces: BOUNCES, ring: RING,
  timing_ms: { chunks: +tChunks.toFixed(0), bvh: +tBvh.toFixed(0), grids: +tGrid.toFixed(0), monteCarlo: +tMC.toFixed(0) },
  scene: { chunks: chunks.length, giTriangles: tris, lamps: lamps.length, cellsEvaluated: rows.length },
  rows,
}
const { writeFileSync } = await import('node:fs')
const file = `gi-rows-${family}-${seedText}.json`
writeFileSync(file, JSON.stringify(out))
console.log(JSON.stringify({ ...out, rows: undefined, file }))
```

## `gi-fit.mjs`

```js
// E4 analysis: noise floor, shipped model, variants and cross-validated refits.
// usage: node gi-fit.mjs gi-rows-a.json gi-rows-b.json ...
import { readFileSync } from 'node:fs'

const sets = process.argv.slice(2).map((f) => {
  const d = JSON.parse(readFileSync(f, 'utf8'))
  return { name: `${d.family}/${d.seedText}`, rows: d.rows, meta: d }
})
const SIDE = [0, 1, 4, 5]
const nearOf = { 0: 1, 1: 0, 4: 3, 5: 2 } // +X sees east(1), -X west(0), +Z south(3), -Z north(2)
const CLASS = { side: SIDE, up: [2], down: [3], all: [0, 1, 2, 3, 4, 5] }

function metrics(pred, ref) {
  const n = ref.length
  const mr = ref.reduce((a, b) => a + b, 0) / n, mp = pred.reduce((a, b) => a + b, 0) / n
  let sxy = 0, sxx = 0, syy = 0, se = 0
  for (let i = 0; i < n; i++) {
    sxy += (pred[i] - mp) * (ref[i] - mr); sxx += (pred[i] - mp) ** 2; syy += (ref[i] - mr) ** 2
    se += (pred[i] - ref[i]) ** 2
  }
  return {
    bias: +((mp / mr - 1) * 100).toFixed(1), // % (pred vs ref)
    corr: +(sxy / Math.sqrt(sxx * syy)).toFixed(3),
    relRMSE: +(Math.sqrt(se / n) / mr).toFixed(3),
  }
}
function collect(rows, key, faces) {
  return rows.flatMap((r) => faces.map((f) => (typeof key === 'function' ? key(r, f) : r[key][f])))
}
function noise(rows) {
  // split-half estimate of the full reference's own error (relative RMSE)
  const a = collect(rows, 'refA', CLASS.all), b = collect(rows, 'refB', CLASS.all), m = collect(rows, 'refM', CLASS.all)
  const mean = m.reduce((x, y) => x + y, 0) / m.length
  let se = 0
  for (let i = 0; i < a.length; i++) se += (a[i] - b[i]) ** 2
  return +(Math.sqrt(se / a.length) / 2 / mean).toFixed(3)
}

// Feature builders on a term vector T = [west, east, north, south, ceil, floor]
const avgS = (T) => (T[0] + T[1] + T[2] + T[3]) / 4
const FORMS = {
  // the shipped form (weights refit)
  shippedForm: {
    side: (T, f) => [T[nearOf[f]], T[4] + T[5], avgS(T)],
    up: (T) => [T[4], avgS(T)],
    down: (T) => [T[5], avgS(T)],
  },
  // + second bounce: the floor's radiosity feeds up-facing surfaces too
  withFloorBounce: {
    side: (T, f) => [T[nearOf[f]], T[4] + T[5], avgS(T)],
    up: (T) => [T[5], avgS(T)],
    down: (T) => [T[5], avgS(T)],
  },
}
function lstsq(X, y) {
  const p = X[0].length
  const A = Array.from({ length: p }, () => new Float64Array(p)), b = new Float64Array(p)
  for (let i = 0; i < X.length; i++) for (let j = 0; j < p; j++) {
    b[j] += X[i][j] * y[i]
    for (let k = 0; k < p; k++) A[j][k] += X[i][j] * X[i][k]
  }
  let tr = 0
  for (let j = 0; j < p; j++) tr += A[j][j]
  for (let j = 0; j < p; j++) A[j][j] += 1e-9 * (tr / p) + 1e-30
  for (let c = 0; c < p; c++) {
    let piv = c
    for (let r = c + 1; r < p; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r
    ;[A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]]
    for (let r = 0; r < p; r++) {
      if (r === c) continue
      const f = A[r][c] / A[c][c]
      for (let k = c; k < p; k++) A[r][k] -= f * A[c][k]
      b[r] -= f * b[c]
    }
  }
  return Array.from(b, (x, i) => x / A[i][i])
}
function fit(rows, termsKey, form) {
  const W = {}
  for (const cls of ['side', 'up', 'down']) {
    const X = [], y = []
    for (const r of rows) for (const f of CLASS[cls]) { X.push(form[cls](r[termsKey], f)); y.push(r.refM[f]) }
    W[cls] = lstsq(X, y)
  }
  return W
}
function predict(rows, termsKey, form, W) {
  return (r, f) => {
    const cls = f === 2 ? 'up' : f === 3 ? 'down' : 'side'
    const x = form[cls](r[termsKey], f)
    return x.reduce((a, v, i) => a + v * W[cls][i], 0)
  }
}
function report(rows, predFn) {
  const out = {}
  for (const [cls, faces] of Object.entries(CLASS)) out[cls] = metrics(collect(rows, predFn, faces), collect(rows, 'refM', faces))
  return out
}

const all = sets.flatMap((s) => s.rows)
console.log('# datasets')
for (const s of sets) {
  console.log(`${s.name}: cells ${s.rows.length}, lamps ${s.meta.scene.lamps}, tris ${s.meta.scene.giTriangles}, MC ${(s.meta.timing_ms.monteCarlo / 1000).toFixed(0)} s, reference noise (relRMSE) ${noise(s.rows)}`)
}
console.log('\n# fixed models vs multi-bounce reference (per dataset)')
for (const s of sets) {
  console.log(`\n## ${s.name}`)
  console.log('shipped (3 it, mid-height floor)  ', JSON.stringify(report(s.rows, 'g3')))
  console.log('8 iterations                      ', JSON.stringify(report(s.rows, 'g8')))
  console.log('floor irradiance on the floor     ', JSON.stringify(report(s.rows, 'gF')))
  console.log('one-bounce ref vs shipped (all)   ', JSON.stringify(metrics(collect(s.rows, 'g3', CLASS.all), collect(s.rows, 'ref1', CLASS.all))))
}

console.log('\n# refits (leave-one-dataset-out: fit on the others, test on this one)')
for (const [formName, form] of Object.entries(FORMS)) {
  for (const termsKey of ['terms', 'termsF']) {
    const label = `${formName} / ${termsKey === 'terms' ? 'mid-height floor' : 'floor on floor'}`
    const tests = []
    for (const s of sets) {
      const train = sets.filter((o) => o !== s).flatMap((o) => o.rows)
      if (!train.length) continue
      const W = fit(train, termsKey, form)
      tests.push({ name: s.name, r: report(s.rows, predict(s.rows, termsKey, form, W)) })
    }
    const Wall = fit(all, termsKey, form)
    console.log(`\n## ${label}`)
    console.log('weights (fit on all):', JSON.stringify(Object.fromEntries(Object.entries(Wall).map(([k, v]) => [k, v.map((x) => +x.toFixed(3))]))))
    for (const t of tests) console.log(`  held-out ${t.name}:`, JSON.stringify(t.r))
  }
}
```

## `compose.mjs`

```js
// Compose labelled PNG snapshots into one strip (no PIL in the container).
// usage: node compose.mjs out.png "label1=file1.png" "label2=file2.png" ...
import { chromium } from 'playwright-core'
import { readFileSync, writeFileSync } from 'node:fs'

const [out, ...items] = process.argv.slice(2)
const imgs = items.map((s) => {
  const i = s.indexOf('=')
  return { label: s.slice(0, i), url: 'data:image/png;base64,' + readFileSync(s.slice(i + 1)).toString('base64') }
})
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
const page = await browser.newPage()
const data = await page.evaluate(async (imgs) => {
  const loaded = await Promise.all(imgs.map((m) => new Promise((res) => {
    const im = new Image(); im.onload = () => res({ im, label: m.label }); im.src = m.url
  })))
  const w = loaded[0].im.width, h = loaded[0].im.height, pad = 4, bar = 18
  const c = document.createElement('canvas')
  c.width = loaded.length * w + (loaded.length - 1) * pad
  c.height = h + bar
  const g = c.getContext('2d')
  g.fillStyle = '#111'; g.fillRect(0, 0, c.width, c.height)
  loaded.forEach(({ im, label }, i) => {
    const x = i * (w + pad)
    g.drawImage(im, x, bar)
    g.fillStyle = '#eee'; g.font = '12px monospace'; g.fillText(label, x + 4, 13)
  })
  return c.toDataURL('image/png')
}, imgs)
writeFileSync(out, Buffer.from(data.split(',')[1], 'base64'))
await browser.close()
console.log('wrote', out)
```

