import { glslFloat } from './common.js'
import {
  BRIDGE_GUARD_H,
  CELL,
  COL_HALF,
  DOOR_H,
  FRAME_W,
  LAMP_FLICKER_AMP,
  LAYER_H,
  MONUMENTAL_COL_HALF,
  THICK,
  WALL_H,
  WINDOW_HEAD_Y,
  WINDOW_SILL_H,
} from '../../world/constants.js'
import {
  EDGE_DOOR,
  EDGE_OPEN,
  EDGE_RAIL,
  EDGE_WALL,
  EDGE_WINDOW,
  FLAG_CEIL_HOLE,
  FLAG_COLUMN,
  FLAG_FLOOR_HOLE,
  FLAG_LOADED,
  FLAG_PIER,
  GI_TEXELS,
  GLASS_T,
  GRID_FLOORS,
  GRID_W,
  LAMP_Y,
  LIST_MAX,
  OCC_CELLS,
  OCC_COL_RANGE,
  OCC_MASK_BITS,
  OCC_OFFSETS,
  OCC_ROW_RANGE,
  OCC_T_SHIFT_A,
  OCC_T_SHIFT_B,
  OCC_UNIT_XZ,
  OCC_UNIT_Y,
  PANEL_HALF_X,
  PANEL_HALF_Z,
  REF_FLOOR_REACH,
  REF_REACH,
  REF_SPAN,
  TINT_SCALE,
  VIS_FULL,
} from '../../world/lightGrid/gridSpec.js'

// GLSL side of the world-grid lighting contract (world/lightGrid/gridSpec.js).
// Every constant is interpolated from the JS spec so the decoders can never
// drift from the CPU encoder. Requires the including shader to declare
// GRID_UNIFORMS_GLSL. All positions here are WORLD space.
//
// Chapter 14 (shadows v2) changes, all GPU-only — the CPU bake, the baked
// list visibility and LightGrid.lightAt (the Stalker's light sense) keep
// their v1 model, so gameplay light is bit-identical:
//   * fixtures shade and shadow from uSourceY (the look's emitter height;
//     the physically based looks use the visible panel, Classic the legacy
//     virtual point 0.5 m below the ceiling);
//   * gridTrace filters each wall crossing with the emitter's FOOTPRINT at
//     that plane — a parallelogram whose along-wall and vertical slides are
//     correlated, integrated exactly against each edge cell's opening (v1's
//     isotropic box counted the part of the window below the floor as wall
//     and dimmed every doorway's spill by 30-40%) — doorways lose their
//     FRAME_W jambs, columns are exact squares, and ultra splits the
//     emitter into two sub-rays;
//   * ownership comes from the edge texel's LOADED flag + floor tag (the
//     owner texture is retired: its sampler now carries furniture occupancy).

const uintList = (a) => a.map((v) => `${v >>> 0}u`).join(', ')

export const GRID_UNIFORMS_GLSL = /* glsl */ `
  uniform highp usampler2D tGridList;
  uniform sampler2D tGridEdge;
  uniform sampler2D tGridLamp;
  uniform sampler2D tGridGI;
  uniform highp usampler2D tGridOcc;
  uniform float uTime;
  uniform vec2 uBadStrobe;       // bad-tube strobe: x = steps per second, y = brightness floor
  uniform float uSourceY;        // fixture light/shadow height above the storey floor
  uniform float uPenumbraScale;  // look: x panel size for every soft shadow
`

export const GRID_GLSL = /* glsl */ `
  #define G_W ${GRID_W}
  #define G_FLOORS ${GRID_FLOORS}
  #define G_CELL ${glslFloat(CELL)}
  #define G_LAYER_H ${glslFloat(LAYER_H)}
  #define G_WALL_H ${glslFloat(WALL_H)}
  #define G_LAMP_Y ${glslFloat(LAMP_Y)}
  #define G_LIST_MAX ${LIST_MAX}
  #define G_VIS_FULL ${VIS_FULL}u
  #define G_PANEL_HALF vec2(${glslFloat(PANEL_HALF_X)}, ${glslFloat(PANEL_HALF_Z)})
  #define G_HALF_THICK ${glslFloat(THICK * 0.5)}
  #define G_FRAME_W ${glslFloat(FRAME_W)}
  #define G_FRAME_BAND ${glslFloat(FRAME_W + 0.02)}
  #define G_INV_PI 0.31830989

  int gImod(int a, int n){ int m = a - n * (a / n); return m < 0 ? m + n : m; }
  int gFloorDiv(int a, int b){ return a >= 0 ? a / b : -((-a + b - 1) / b); }
  ivec2 gTexel(int gx, int gz, int cy){
    return ivec2(gImod(gx, G_W), gImod(gz, G_W) + gImod(cy, G_FLOORS) * G_W);
  }
  int gByte(float v){ return int(v * 255.0 + 0.5); }

  // Does the resident chunk mapped for this cell's slot really own it? The
  // edge texel carries FLAG_LOADED and the floor tag (exactly what
  // LightGrid._texel trusts): horizontal aliasing is impossible inside the
  // 12-chunk window, which spans more than twice the fog distance, and
  // vertical aliasing is caught by the tag.
  bool gridOwned(int gx, int gz, int cy){
    vec4 e = texelFetch(tGridEdge, gTexel(gx, gz, cy), 0);
    return (gByte(e.b) & ${FLAG_LOADED}) != 0 && gByte(e.a) == (cy & 255);
  }

  // Edge texel of a cell, or the "unloaded" texel (all open) when the slot
  // holds another floor's data.
  vec4 gEdge(int gx, int gz, int cy){
    vec4 e = texelFetch(tGridEdge, gTexel(gx, gz, cy), 0);
    bool mine = (gByte(e.b) & ${FLAG_LOADED}) != 0 && gByte(e.a) == (cy & 255);
    return mine ? e : vec4(0.0);
  }

  // Opening [lo, hi] (floor-local) and transmission of an edge code.
  vec3 gOpenSpan(int code){
    if (code == ${EDGE_OPEN}) return vec3(-1.0, 99.0, 1.0);
    if (code == ${EDGE_DOOR}) return vec3(0.0, ${glslFloat(DOOR_H)}, 1.0);
    if (code == ${EDGE_WINDOW}) return vec3(${glslFloat(WINDOW_SILL_H)}, ${glslFloat(WINDOW_HEAD_Y)}, ${glslFloat(GLASS_T)});
    if (code == ${EDGE_RAIL}) return vec3(${glslFloat(BRIDGE_GUARD_H)}, 99.0, 1.0);
    return vec3(0.0, 0.0, 0.0);
  }

  // Integral of max(0, f) over a span of length len, f linear with end values.
  float gPosLin(float fa, float fb, float len){
    if (len <= 0.0) return 0.0;
    if (fa >= 0.0 && fb >= 0.0) return 0.5 * (fa + fb) * len;
    if (fa <= 0.0 && fb <= 0.0) return 0.0;
    float m = max(fa, fb);
    return len * m * m / (2.0 * abs(fa - fb));
  }

  // Along overlap of a box of half-width a centred at x0 + k u with [lo, hi],
  // and its integral over u in [ua, ub] (piecewise linear: split at the two
  // kinks where a box end meets the interval; zero crossings via gPosLin).
  float gSlideLen(float x0, float k, float a, float lo, float hi, float u){
    return min(x0 + k * u + a, hi) - max(x0 + k * u - a, lo);
  }
  float gSlideInt(float x0, float k, float a, float lo, float hi, float ua, float ub){
    if (ub <= ua) return 0.0;
    float k0 = clamp(abs(k) > 1e-9 ? (hi - a - x0) / k : ua, ua, ub);
    float k1 = clamp(abs(k) > 1e-9 ? (lo + a - x0) / k : ua, ua, ub);
    float p = min(k0, k1);
    float q = max(k0, k1);
    float fA = gSlideLen(x0, k, a, lo, hi, ua);
    float f0 = gSlideLen(x0, k, a, lo, hi, p);
    float f1 = gSlideLen(x0, k, a, lo, hi, q);
    float fB = gSlideLen(x0, k, a, lo, hi, ub);
    return gPosLin(fA, f0, p - ua) + gPosLin(f0, f1, q - p) + gPosLin(f1, fB, ub - q);
  }

  // Open share of the emitter's PARALLELOGRAM footprint (chapter 14 P5,
  // render/shadowMath.js footprintOpenPara) that falls on edge cell c of a
  // wall line. Linearised about the emitter centre, an emitter point offset
  // across the line slides the crossing along the wall (kA) and vertically
  // (kV) together, while its along offset widens it by a: the footprint is a
  // box of half-width a slid along a segment, e in [-1, 1]. Per cell the
  // vertical opening becomes an interval of e (heights are exact along the
  // slide) and the along overlap is integrated over it in closed form. A
  // doorway loses its FRAME_W jamb casings. Normalised by the footprint's
  // area (2a x 2). The separable box it replaces missed the correlation
  // where a jamb meets the lintel (mean error 0.034 -> 0.006 on doorway
  // receivers against a brute-force area-light reference).
  float gCellOpenPara(int code, int c, float along, float kA, float a, float y, float kV){
    if (code == ${EDGE_WALL}) return 0.0;
    vec3 op = gOpenSpan(code);
    float inset = code == ${EDGE_DOOR} ? G_FRAME_W : 0.0;
    float eLo = -1.0;
    float eHi = 1.0;
    if (abs(kV) > 1e-5) {
      float e0 = (op.x - y) / kV;
      float e1 = (op.y - y) / kV;
      eLo = max(-1.0, min(e0, e1));
      eHi = min(1.0, max(e0, e1));
    } else if (y < op.x || y > op.y) return 0.0;
    if (eHi <= eLo) return 0.0;
    float lo = float(c) * G_CELL + inset;
    float hi = float(c + 1) * G_CELL - inset;
    return op.z * gSlideInt(along, kA, a, lo, hi, eLo, eHi) / (4.0 * a);
  }

  // Transmission of one wall-line crossing: axis 0 is the vertical line
  // x = line*CELL (along = z), axis 1 the horizontal line z = line*CELL
  // (along = x). The footprint spans at most two edge cells.
  float gLineOpen(int axis, int line, float along, float y, float a, float kA, float kV, int cy){
    int c0 = int(floor((along - a - kA) / G_CELL));
    int c1 = int(floor((along + a + kA) / G_CELL));
    vec4 e0 = axis == 0 ? gEdge(line, c0, cy) : gEdge(c0, line, cy);
    float T = gCellOpenPara(gByte(axis == 0 ? e0.r : e0.g), c0, along, kA, a, y, kV);
    if (c1 != c0) {
      vec4 e1 = axis == 0 ? gEdge(line, c1, cy) : gEdge(c1, line, cy);
      T += gCellOpenPara(gByte(axis == 0 ? e1.r : e1.g), c1, along, kA, a, y, kV);
    }
    return clamp(T, 0.0, 1.0);
  }

  // Soft occlusion of the XZ segment a->b by the square column standing in
  // cell c, evaluated at the column itself: the emitter's footprint width
  // there (w) against the square's support width across the ray (he). The
  // v1 disc test left a 41% sliver of light through piers seen diagonally.
  // Only a column inside the traced window [tLo, tHi] of the ray counts: past
  // it the ray is in another storey, where this storey's column is not.
  float gColumnSq(ivec2 c, int cy, vec2 a, vec2 b, vec2 H, float minW, float tLo, float tHi){
    int flags = gByte(gEdge(c.x, c.y, cy).b);
    if ((flags & ${FLAG_COLUMN | FLAG_PIER}) == 0) return 1.0;
    float half_ = (flags & ${FLAG_PIER}) != 0 ? ${glslFloat(MONUMENTAL_COL_HALF)} : ${glslFloat(COL_HALF)};
    vec2 ctr = (vec2(c) + 0.5) * G_CELL;
    vec2 ab = b - a;
    float l2 = dot(ab, ab);
    if (l2 < 1e-8) return 1.0;
    vec2 r = ctr - a;
    float t = dot(r, ab) / l2;
    if (t <= tLo || t >= tHi) return 1.0; // the column is not between P and the light
    vec2 u = ab * inversesqrt(l2);
    float q = abs(u.x * r.y - u.y * r.x);
    float he = half_ * (abs(u.x) + abs(u.y));
    float w = max(2.0 * t * (H.x * abs(u.y) + H.y * abs(u.x)), minW);
    return 1.0 - clamp((min(q + 0.5 * w, he) - max(q - 0.5 * w, -he)) / w, 0.0, 1.0);
  }

  // Segment P -> L against the AABB [lo, hi] (slab test).
  bool gSegHitsBox(vec3 P, vec3 L, vec3 lo, vec3 hi){
    vec3 d = L - P;
    vec3 inv = 1.0 / mix(d, vec3(1e-6), lessThan(abs(d), vec3(1e-6)));
    vec3 t0 = (lo - P) * inv;
    vec3 t1 = (hi - P) * inv;
    vec3 tn = min(t0, t1);
    vec3 tf = max(t0, t1);
    float a = max(max(tn.x, tn.y), max(tn.z, 0.0));
    float b = min(min(tf.x, tf.y), min(tf.z, 1.0));
    return a <= b;
  }

  // Furniture proxies of one visited cell against a near point source (the
  // analytic torch): a two-level soft edge (box grown and shrunk by delta)
  // gives an anti-aliased hard shadow.
  float gCellBoxes(ivec2 c, int cy, vec3 P, vec3 Lp){
    // The occupancy texel has no floor tag of its own: after vertical
    // aliasing it holds the boxes of the floor six storeys away.
    if (!gridOwned(c.x, c.y, cy)) return 1.0;
    uvec4 o = texelFetch(tGridOcc, gTexel(c.x, c.y, cy), 0);
    float T = 1.0;
    vec3 cb = vec3(float(c.x) * G_CELL, float(cy) * G_LAYER_H, float(c.y) * G_CELL);
    for (int w = 0; w < 2; w++){
      uint xz = w == 0 ? o.x : o.z;
      uint sh = w == 0 ? 0u : 16u;
      uint y1 = (o.y >> (sh + 8u)) & 255u;
      if (y1 == 0u) continue;
      vec3 lo = cb + vec3(float(xz & 255u) * ${glslFloat(OCC_UNIT_XZ)}, float((o.y >> sh) & 255u) * ${glslFloat(OCC_UNIT_Y)}, float((xz >> 16u) & 255u) * ${glslFloat(OCC_UNIT_XZ)});
      vec3 hi = cb + vec3(float((xz >> 8u) & 255u) * ${glslFloat(OCC_UNIT_XZ)}, float(y1) * ${glslFloat(OCC_UNIT_Y)}, float((xz >> 24u) & 255u) * ${glslFloat(OCC_UNIT_XZ)});
      float tr = float((o.w >> (w == 0 ? ${OCC_T_SHIFT_A}u : ${OCC_T_SHIFT_B}u)) & 7u) * 0.125;
      // A box holding the receiver (a seat, a basin, the floor of a desk's
      // knee hole; 5 mm covers the decode rounding) does not shadow it: the
      // torch is next to the eye, so what the camera sees the torch sees.
      float dB = length(max(max(lo - P, P - hi), 0.0));
      if (dB < 0.005) continue;
      // The soft edge grows at most half P's distance to the box, so the
      // grown box never swallows a receiver on or beside it (a desk top, the
      // floor at a cabinet's foot); a small light's penumbra closes there.
      float delta = min(0.01 + 0.004 * length(Lp - P), 0.5 * dB);
      float hits = (gSegHitsBox(P, Lp, lo - delta, hi + delta) ? 0.5 : 0.0)
                 + (gSegHitsBox(P, Lp, lo + delta, hi - delta) ? 0.5 : 0.0);
      T *= 1.0 - hits * (1.0 - tr);
    }
    return T;
  }

  // Parameter window [x, y] of the ray P -> Lp that gTraceRay walks (the
  // whole ray unless a caller narrows it). A cross-floor path traces the
  // SAME full ray once per storey, clipped to the part inside that storey,
  // so every crossing's s is the full ray's: the footprint, the column width
  // and the sub-ray offsets all scale as for an emitter of size H at s = 1,
  // not one standing at the slab. A global rather than a parameter, so the
  // shaft pass keeps its gridTrace call as it is.
  vec2 gTraceWin = vec2(0.0, 1.0);

  // One emitter (sub-)ray: an Amanatides–Woo walk over the cell edges from P
  // to the emitter point Lp on floor cy (only over gTraceWin), filtering
  // every wall crossing with the emitter footprint (half extents H) at that
  // plane. occBoxes also tests the furniture proxies of every visited cell
  // (the analytic torch: a point source only meets boxes in the cells its
  // ray crosses).
  float gTraceRay(vec3 P, vec3 Lp, int cy, vec2 H, float minW, int maxIter, bool occBoxes){
    float base = float(cy) * G_LAYER_H;
    vec3 d = Lp - P;
    float sLo = gTraceWin.x;
    float sHi = gTraceWin.y;
    vec2 a = P.xz + d.xz * sLo; // where the window starts and ends
    vec2 b = P.xz + d.xz * sHi;
    ivec2 c = ivec2(floor(a / G_CELL));
    ivec2 tc = ivec2(floor(b / G_CELL));
    ivec2 st = ivec2(d.x > 0.0 ? 1 : (d.x < 0.0 ? -1 : 0), d.z > 0.0 ? 1 : (d.z < 0.0 ? -1 : 0));
    vec2 tMax = vec2(
      st.x > 0 ? sLo + ((float(c.x) + 1.0) * G_CELL - a.x) / d.x : (st.x < 0 ? sLo + (float(c.x) * G_CELL - a.x) / d.x : 1e9),
      st.y > 0 ? sLo + ((float(c.y) + 1.0) * G_CELL - a.y) / d.z : (st.y < 0 ? sLo + (float(c.y) * G_CELL - a.y) / d.z : 1e9));
    vec2 tDelta = vec2(st.x != 0 ? G_CELL / abs(d.x) : 1e9, st.y != 0 ? G_CELL / abs(d.z) : 1e9);
    float T = gColumnSq(c, cy, P.xz, Lp.xz, H, minW, sLo, sHi);
    for (int i = 0; i < 24; i++){
      if (occBoxes) T *= gCellBoxes(c, cy, P, Lp);
      if (i >= maxIter || c == tc || T < 0.004) break;
      bool xs = tMax.x < tMax.y;
      float s = xs ? tMax.x : tMax.y;
      if (s > sHi) break;
      vec3 X = P + d * s;
      int axis = xs ? 0 : 1;
      int line = xs ? (st.x > 0 ? c.x + 1 : c.x) : (st.y > 0 ? c.y + 1 : c.y);
      // Emitter footprint at this wall plane: half-width a along the wall
      // from the along-extent, slid by the across-extent (kA along, kV up).
      float dC = xs ? d.x : d.z;
      float dA = xs ? d.z : d.x;
      float run = max(abs(dC), 0.1);
      float hA = xs ? H.y : H.x;
      float hC = xs ? H.x : H.y;
      float fa = max(s * hA, 0.5 * minW);
      float kA = s * hC * abs(dA) / run;
      float kV = s * hC * d.y / run * (dA >= 0.0 ? 1.0 : -1.0);
      float sc = min(1.0, 0.45 * G_CELL / (fa + kA));
      T *= gLineOpen(axis, line, xs ? X.z : X.x, X.y - base, fa * sc, kA * sc, kV, cy);
      if (xs) { c.x += st.x; tMax.x += tDelta.x; }
      else { c.y += st.y; tMax.y += tDelta.y; }
      T *= gColumnSq(c, cy, P.xz, Lp.xz, H, minW, sLo, sHi);
    }
    return T;
  }

  // Per-pixel 2.5D visibility of an extended emitter (half extents H,
  // centred at Lp) from P on floor cy. subRays 2 splits the emitter along
  // its long (x) axis: two narrower footprints resolve a doorway's partial
  // view of the tube far better than one wide box filter.
  float gridTrace(vec3 P, vec3 Lp, int cy, vec2 H, float minW, int maxIter, int subRays, bool occBoxes){
    float n = float(subRays);
    vec2 Hs = vec2(H.x / n, H.y);
    float T = 0.0;
    for (int sr = 0; sr < 2; sr++){
      if (sr >= subRays) break;
      vec3 L = Lp + vec3(H.x * ((float(sr) + 0.5) * 2.0 / n - 1.0), 0.0, 0.0);
      T += gTraceRay(P, L, cy, Hs, minW, maxIter, occBoxes);
    }
    return T / n;
  }

  // Area fraction of the rectangle [c - h, c + h] (world xz) that lies over
  // holed slab cells (FLAG_CEIL_HOLE) of floor f: how much of a fixture's
  // footprint at the slab plane passes a stair run / atrium void. The
  // footprint is capped at 1.4 m half extents, so at most 2 x 2 cells.
  float gHoleOpen(vec2 c, vec2 h, int f){
    h = min(h, vec2(1.4));
    vec2 lo = c - h;
    vec2 hi = c + h;
    ivec2 c0 = ivec2(floor(lo / G_CELL));
    ivec2 c1 = ivec2(floor(hi / G_CELL));
    float area = 0.0;
    for (int j = 0; j < 2; j++){
      for (int i = 0; i < 2; i++){
        ivec2 cc = c0 + ivec2(i, j);
        if (cc.x > c1.x || cc.y > c1.y) continue;
        if ((gByte(gEdge(cc.x, cc.y, f).b) & ${FLAG_CEIL_HOLE}) == 0) continue;
        vec2 a = max(lo, vec2(cc) * G_CELL);
        vec2 b = min(hi, vec2(cc + 1) * G_CELL);
        area += max(b.x - a.x, 0.0) * max(b.y - a.y, 0.0);
      }
    }
    return clamp(area / (4.0 * h.x * h.y), 0.0, 1.0);
  }

  // One decoded light-list entry. pos is the fixture's emitter point at the
  // look's source height; cell/df locate it for cross-floor and furniture.
  struct GridLight { vec3 pos; vec3 tint; float vis; bool partial; bool sameFloor; float flicker; int df; };

  uint gPcg(uint v){
    uint s = v * 747796405u + 2891336453u;
    uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
    return (w >> 22u) ^ w;
  }

  // GPU twin of lampCharacter.lampFlicker: the identity byte carries the
  // bad-tube bit and a phase id; speed and phase derive from it. The bad-tube
  // rate and floor are a uniform, not baked constants, so the reduceFlicker
  // setting (photosensitivity) retunes them without a shader rebuild.
  float gFlicker(int fb, ivec3 cell){
    float pid = float(fb & 127);
    if (fb >= 128){
      uint stepT = uint(floor(uTime * uBadStrobe.x));
      uint h = gPcg(uint(cell.x) * 73856093u ^ uint(cell.y) * 19349663u ^ uint(cell.z) * 83492791u ^ stepT * 2654435761u);
      float n = float(h & 65535u) / 65535.0;
      return uBadStrobe.y + (1.0 - uBadStrobe.y) * n * n;
    }
    float phase = pid / 127.0 * 6.2831853;
    float speed = 13.0 + fract(pid * 0.61803398875) * 11.0;
    return 1.0 - ${glslFloat(LAMP_FLICKER_AMP)} * (0.5 + 0.5 * sin(uTime * speed + phase));
  }

  // Number of valid entries in a list texel (entries are packed front to
  // back, so the first empty one ends the list).
  uint gWord(uvec4 L, int i){ return i == 0 ? L.x : (i == 1 ? L.y : (i == 2 ? L.z : L.w)); }
  uint gEntryBits(uvec4 L, int k){
    uint word = gWord(L, k >> 1);
    return ((k & 1) == 1 ? (word >> 16u) : word) & 65535u;
  }
  int gListCount(uvec4 L){
    int n = 0;
    for (int k = 0; k < G_LIST_MAX; k++){
      if ((gEntryBits(L, k) >> 10u) == 0u) break;
      n++;
    }
    return n;
  }
  // Relative reference (dx, dz, df) of entry k, from the 10-bit ref alone.
  ivec3 gEntryRef(uvec4 L, int k){
    int ref = int(gEntryBits(L, k) & 1023u);
    return ivec3(ref % ${REF_SPAN} - ${REF_REACH}, (ref / ${REF_SPAN}) % ${REF_SPAN} - ${REF_REACH},
      ref / ${REF_SPAN * REF_SPAN} - ${REF_FLOOR_REACH});
  }

  // Decode entry k of a list texel. Returns false past the end of the list.
  bool gridEntry(uvec4 L, int k, int gx, int gz, int cy, out GridLight gl){
    uint e = gEntryBits(L, k);
    uint vis = e >> 10u;
    if (vis == 0u) return false;
    ivec3 r = gEntryRef(L, k);
    int lx = gx + r.x;
    int lz = gz + r.y;
    int ly = cy + r.z;
    vec4 lt = texelFetch(tGridLamp, gTexel(lx, lz, ly), 0);
    int fb = gByte(lt.a);
    if (fb == 0) return false;
    gl.pos = vec3((float(lx) + 0.5) * G_CELL, float(ly) * G_LAYER_H + uSourceY, (float(lz) + 0.5) * G_CELL);
    gl.tint = lt.rgb * ${glslFloat(1 / TINT_SCALE)};
    gl.vis = float(vis) / float(G_VIS_FULL);
    gl.partial = vis < G_VIS_FULL;
    gl.sameFloor = r.z == 0;
    gl.df = r.z;
    gl.flicker = gFlicker(fb, ivec3(lx, lz, ly));
    return true;
  }

  // Cell-graph GI: ambient cube (luminance per axis face + hemisphere
  // chroma) evaluated for normal N.
  vec3 gCube(int gx, int gz, int cy, vec3 N){
    ivec2 t = gTexel(gx, gz, cy);
    t.x *= ${GI_TEXELS};
    vec4 a = texelFetch(tGridGI, t, 0);
    vec4 b = texelFetch(tGridGI, t + ivec2(1, 0), 0);
    vec4 c = texelFetch(tGridGI, t + ivec2(2, 0), 0);
    vec3 n2 = N * N;
    float l = n2.x * (N.x >= 0.0 ? a.x : a.y) + n2.y * (N.y >= 0.0 ? b.x : b.y) + n2.z * (N.z >= 0.0 ? a.z : a.w);
    vec3 up = vec3(b.z, b.w, c.x);
    vec3 dn = c.yzw;
    return l * mix(dn, up, clamp(N.y * 0.5 + 0.5, 0.0, 1.0));
  }

  // Can indirect light flow between two orthogonally adjacent cells? Doors
  // count as open, walls/windows/rails as closed (the interpolation stencil
  // must never reach across a partition).
  bool gPass(int code){ return code == ${EDGE_OPEN} || code == ${EDGE_DOOR}; }
  bool gLinkX(ivec2 a, int cy){ return gPass(gByte(gEdge(a.x + 1, a.y, cy).r)); } // a <-> a + (1,0)
  bool gLinkZ(ivec2 a, int cy){ return gPass(gByte(gEdge(a.x, a.y + 1, cy).g)); } // a <-> a + (0,1)

  // Wall-aware bilinear interpolation of the four nearest cell cubes around
  // Pl (a point pushed off the surface into the room it faces). A neighbour
  // behind a wall gets zero weight, so bounce never leaks through a thin
  // partition — the stencil respects the same edges as the walls. With
  // stencil false only the own cell's cube is read (low tiers).
  vec3 gridIndirect(vec3 Pl, vec3 N, int cy, bool stencil){
    ivec2 cb = ivec2(floor(Pl.xz / G_CELL));
    if (!stencil) return gCube(cb.x, cb.y, cy, N);
    vec2 q = Pl.xz / G_CELL - 0.5;
    ivec2 c0 = ivec2(floor(q));
    vec2 f = q - vec2(c0);
    // Links of the 2x2 stencil: bottom (c0 <-> c0+x), top (c0+z <-> c0+xz),
    // left (c0 <-> c0+z), right (c0+x <-> c0+xz).
    bool lb = gLinkX(c0, cy);
    bool lt = gLinkX(c0 + ivec2(0, 1), cy);
    bool ll = gLinkZ(c0, cy);
    bool lr = gLinkZ(c0 + ivec2(1, 0), cy);
    ivec2 o = cb - c0; // base cell corner within the stencil
    bool r00, r10, r01, r11;
    if (o == ivec2(0, 0)) { r00 = true; r10 = lb; r01 = ll; r11 = (lb && lr) || (ll && lt); }
    else if (o == ivec2(1, 0)) { r10 = true; r00 = lb; r11 = lr; r01 = (lb && ll) || (lr && lt); }
    else if (o == ivec2(0, 1)) { r01 = true; r11 = lt; r00 = ll; r10 = (lt && lr) || (ll && lb); }
    else { r11 = true; r01 = lt; r10 = lr; r00 = (lt && ll) || (lr && lb); }
    vec4 w = vec4((1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y), (1.0 - f.x) * f.y, f.x * f.y)
           * vec4(r00, r10, r01, r11);
    float ws = max(w.x + w.y + w.z + w.w, 1e-4);
    vec3 s = vec3(0.0);
    if (w.x > 0.0) s += w.x * gCube(c0.x, c0.y, cy, N);
    if (w.y > 0.0) s += w.y * gCube(c0.x + 1, c0.y, cy, N);
    if (w.z > 0.0) s += w.z * gCube(c0.x, c0.y + 1, cy, N);
    if (w.w > 0.0) s += w.w * gCube(c0.x + 1, c0.y + 1, cy, N);
    return s / ws;
  }

  // --- Architectural crease AO (chapter 14 P10) ------------------------------
  // Exact finite-radius, cosine-weighted occlusion by planes perpendicular to
  // an axis-aligned receiver (Malley: cosine directions map uniformly onto
  // the unit disk, so the occluded fraction is the covered disk area / pi).
  // A plane at distance d spanning [s0, s1] along the other tangent axis
  // covers a wedge of the disk; its area within radius R has a closed form.
  float gWedge(float d, float s0, float s1, float R){
    d = max(d, 1e-3);
    float a = d / R;
    if (a >= 1.0 || s1 <= s0) return 0.0;
    // In tan(phi): tan(acos a) = sqrt(1 - a^2) / a bounds the wedge, so no
    // tan() or acos() is evaluated (render/shadowMath.js creaseWedge).
    float tl = sqrt(1.0 - a * a) / a;
    float t0 = max(s0 / d, -tl);
    float t1 = min(s1 / d, tl);
    if (t1 <= t0) return 0.0;
    return 0.5 * ((atan(t1) - a * a * t1) - (atan(t0) - a * a * t0)) * G_INV_PI;
  }

  // Is the edge code closed (solid) at floor-local height y?
  bool gClosedAt(int code, float y){
    if (code == ${EDGE_OPEN}) return false;
    if (code == ${EDGE_WALL}) return true;
    vec3 op = gOpenSpan(code);
    return y < op.x || y > op.y;
  }

  // Is the surface point Pw (world, storey cy) architecture: a storey plane,
  // a closed wall face or a door jamb, or a column / pier square? The contact
  // march leaves hits on these to the analytic systems, and the lighting
  // pass never lets such a receiver skip a furniture box.
  bool gArchSurface(vec3 Pw, int cy){
    float yl = Pw.y - float(cy) * G_LAYER_H;
    if (yl < 0.02 || yl > G_WALL_H - 0.02) return true;
    vec2 q = Pw.xz / G_CELL;
    ivec2 c = ivec2(floor(q));
    float band = G_HALF_THICK + 0.02;
    // Wall line x = const nearest to the point.
    float lx = floor(q.x + 0.5);
    if (abs(Pw.x - lx * G_CELL) < band) {
      int code = gByte(gEdge(int(lx), c.y, cy).r);
      float along = Pw.z - float(c.y) * G_CELL;
      bool jamb = code == ${EDGE_DOOR} && (along < G_FRAME_BAND || along > G_CELL - G_FRAME_BAND);
      if (jamb || gClosedAt(code, yl)) return true;
    }
    float lz = floor(q.y + 0.5);
    if (abs(Pw.z - lz * G_CELL) < band) {
      int code = gByte(gEdge(c.x, int(lz), cy).g);
      float along = Pw.x - float(c.x) * G_CELL;
      bool jamb = code == ${EDGE_DOOR} && (along < G_FRAME_BAND || along > G_CELL - G_FRAME_BAND);
      if (jamb || gClosedAt(code, yl)) return true;
    }
    int flags = gByte(gEdge(c.x, c.y, cy).b);
    if ((flags & ${FLAG_COLUMN | FLAG_PIER}) != 0) {
      float h = (flags & ${FLAG_PIER}) != 0 ? ${glslFloat(MONUMENTAL_COL_HALF)} : ${glslFloat(COL_HALF)};
      vec2 r = abs(Pw.xz - (vec2(c) + 0.5) * G_CELL);
      if (max(r.x, r.y) < h + 0.02) return true;
    }
    return false;
  }

  // Faces of the column / pier standing in cell c (flag byte flags), seen
  // from the floor or ceiling point p (world xz). Convex: at most two faces
  // face p, and their wedges never overlap.
  float gColumnFaces(ivec2 c, int flags, vec2 p, float R){
    if ((flags & ${FLAG_COLUMN | FLAG_PIER}) == 0) return 0.0;
    float h = (flags & ${FLAG_PIER}) != 0 ? ${glslFloat(MONUMENTAL_COL_HALF)} : ${glslFloat(COL_HALF)};
    vec2 r = p - (vec2(c) + 0.5) * G_CELL;
    float occ = 0.0;
    // A face at distance |r.x| - h spans z in [-h, h] around the centre,
    // i.e. [-h - r.y, h - r.y] relative to p (the wedge is mirror-symmetric,
    // so the side the face lies on does not matter).
    if (abs(r.x) > h) occ += gWedge(abs(r.x) - h, -h - r.y, h - r.y, R);
    if (abs(r.y) > h) occ += gWedge(abs(r.y) - h, -h - r.x, h - r.x, R);
    return occ;
  }

  // Walls on the two grid lines through the cell corner nearest P, for a
  // floor or ceiling receiver (tangent plane xz), and the columns of the
  // four cells around that corner. Each line has a NEAR half (on P's side of
  // the corner) and a FAR half; a far half only counts when the other line's
  // near half is open, so the wedges stay disjoint (a ray reaching the far
  // half would otherwise have hit the near wall first).
  float gCreaseCorner(vec3 Pw, int cy, float yl, float R){
    ivec2 k = ivec2(floor(Pw.xz / G_CELL + 0.5)); // nearest corner
    vec2 K = vec2(k) * G_CELL;
    vec2 rel = Pw.xz - K;
    vec2 sg = vec2(rel.x < 0.0 ? -1.0 : 1.0, rel.y < 0.0 ? -1.0 : 1.0);
    // Line x = K.x: west edges of cells (k.x, k.y - 1) [z below K] and (k.x, k.y) [z above].
    // Line z = K.y: north edges of cells (k.x - 1, k.y) [x below K] and (k.x, k.y) [x above].
    vec4 eC = gEdge(k.x, k.y, cy);
    vec4 eZ = gEdge(k.x, k.y - 1, cy);
    vec4 eX = gEdge(k.x - 1, k.y, cy);
    bool xLo = gClosedAt(gByte(eZ.r), yl);  // x-line, z < K.y
    bool xHi = gClosedAt(gByte(eC.r), yl);  // x-line, z > K.y
    bool zLo = gClosedAt(gByte(eX.g), yl);  // z-line, x < K.x
    bool zHi = gClosedAt(gByte(eC.g), yl);  // z-line, x > K.x
    bool xNear = sg.y < 0.0 ? xLo : xHi;
    bool xFar = sg.y < 0.0 ? xHi : xLo;
    bool zNear = sg.x < 0.0 ? zLo : zHi;
    bool zFar = sg.x < 0.0 ? zHi : zLo;
    float dx = abs(rel.x) - G_HALF_THICK;
    float dz = abs(rel.y) - G_HALF_THICK;
    float az = abs(rel.y);
    float ax = abs(rel.x);
    float occ = 0.0;
    // Along coordinates are measured from P toward the corner (positive).
    if (xNear) occ += gWedge(dx, -G_CELL, az, R);
    if (xFar && !zNear) occ += gWedge(dx, az, az + G_CELL, R);
    if (zNear) occ += gWedge(dz, -G_CELL, ax, R);
    if (zFar && !xNear) occ += gWedge(dz, ax, ax + G_CELL, R);
    // Columns: the receiver's own cell, and a neighbour around the corner
    // when an open edge path at this height leads to it (behind a closed
    // edge the wall's wedge already holds every direction that reaches it).
    // A pier's faces are 0.4 m from its cell lines, inside the AO radius of
    // the next cell; a column in any cell outside these four is at least
    // CELL - MONUMENTAL_COL_HALF = 1.9 m away, beyond every radius.
    bool loX = sg.x < 0.0; // P's cell is the one below the corner in x
    bool loZ = sg.y < 0.0;
    int fLL = gByte(gEdge(k.x - 1, k.y - 1, cy).b);
    int fHL = gByte(eZ.b); // cell (k.x, k.y - 1)
    int fLH = gByte(eX.b); // cell (k.x - 1, k.y)
    int fHH = gByte(eC.b); // cell (k.x, k.y)
    int fOwn = loX ? (loZ ? fLL : fLH) : (loZ ? fHL : fHH);
    int fX = loX ? (loZ ? fHL : fHH) : (loZ ? fLL : fLH); // across the x-line
    int fZ = loX ? (loZ ? fLH : fLL) : (loZ ? fHH : fHL); // across the z-line
    int fD = loX ? (loZ ? fHH : fHL) : (loZ ? fLH : fLL); // diagonal
    ivec2 own = k - ivec2(loX ? 1 : 0, loZ ? 1 : 0);
    vec2 p = Pw.xz;
    occ += gColumnFaces(own, fOwn, p, R);
    if (!xNear) occ += gColumnFaces(k - ivec2(loX ? 0 : 1, loZ ? 1 : 0), fX, p, R);
    if (!zNear) occ += gColumnFaces(k - ivec2(loX ? 1 : 0, loZ ? 0 : 1), fZ, p, R);
    if ((!xNear && !zFar) || (!zNear && !xFar)) occ += gColumnFaces(k - ivec2(loX ? 0 : 1, loZ ? 0 : 1), fD, p, R);
    return occ;
  }

  // Crease occlusion (0 = open, 1 = fully occluded) of an axis-aligned
  // receiver at Pw with normal Nw on floor cy, AO radius R. Angled or curved
  // receivers fade out (screen-space AO covers them).
  float gCreaseAO(vec3 Pw, vec3 Nw, int cy, float R){
    vec3 an = abs(Nw);
    float m = max(an.x, max(an.y, an.z));
    float wgt = smoothstep(0.8, 0.9, m);
    if (wgt <= 0.0) return 0.0;
    float base = float(cy) * G_LAYER_H;
    float yl = Pw.y - base;
    float occ = 0.0;
    if (an.y >= m) {
      // Floor (up) or ceiling (down) receiver: the walls and columns around it.
      int flags = gByte(gEdge(int(floor(Pw.x / G_CELL)), int(floor(Pw.z / G_CELL)), cy).b);
      bool floorHole = Nw.y > 0.0 && (flags & ${FLAG_FLOOR_HOLE}) != 0;
      bool ceilHole = Nw.y < 0.0 && (flags & ${FLAG_CEIL_HOLE}) != 0;
      if (!floorHole && !ceilHole) {
        occ = gCreaseCorner(Pw, cy, Nw.y > 0.0 ? 0.05 : G_WALL_H - 0.05, R);
      }
    } else {
      // Wall receiver: the floor and ceiling planes, plus the wall line
      // crossing ours at the nearest corner (on the room side).
      bool xFace = an.x >= an.z;
      float along = xFace ? Pw.z : Pw.x;
      float kLine = floor(along / G_CELL + 0.5);
      float rel = along - kLine * G_CELL;
      float sgn = rel < 0.0 ? -1.0 : 1.0;
      // Room-side cell: one step off the wall along the normal.
      vec3 Pr = Pw + Nw * 0.3;
      ivec2 rc = ivec2(floor(Pr.xz / G_CELL));
      int rflags = gByte(gEdge(rc.x, rc.y, cy).b);
      // The crossing wall is the edge on line kLine inside the room cell:
      // x-face receivers (wall along z) meet z-lines (north edges, .g).
      int ck = int(kLine);
      vec4 e = xFace ? gEdge(rc.x, ck, cy) : gEdge(ck, rc.y, cy);
      int code = gByte(xFace ? e.g : e.r);
      float dW = abs(rel) - G_HALF_THICK;
      float dF = yl;
      float dC = G_WALL_H - yl;
      bool fl = (rflags & ${FLAG_FLOOR_HOLE}) == 0;
      bool ce = (rflags & ${FLAG_CEIL_HOLE}) == 0;
      // The crossing wall's closed vertical extent, relative to P (along y).
      vec3 op = gOpenSpan(code);
      bool wallAll = code == ${EDGE_WALL};
      bool openAll = code == ${EDGE_OPEN};
      float a = abs(rel);
      if (!openAll) {
        if (wallAll) occ += gWedge(dW, -yl, G_WALL_H - yl, R);
        else {
          // Solid below the opening and above it (door header, sill, rail base).
          occ += gWedge(dW, -yl, min(op.x, G_WALL_H) - yl, R);
          occ += gWedge(dW, max(op.y, 0.0) - yl, G_WALL_H - yl, R);
        }
      }
      // Floor / ceiling planes span along the wall; their far part (beyond
      // the crossing line) only counts where that wall is open at their level.
      bool openBottom = !gClosedAt(code, 0.05);
      bool openTop = !gClosedAt(code, G_WALL_H - 0.05);
      if (fl) occ += gWedge(dF, -G_CELL, openBottom ? a + G_CELL : a, R);
      if (ce) occ += gWedge(dC, -G_CELL, openTop ? a + G_CELL : a, R);
    }
    return clamp(occ, 0.0, 1.0) * wgt;
  }

  // --- Furniture occupancy (chapter 14 P8/P9, gridSpec OCC_*) ---------------
  #define G_OCC_CELLS ${OCC_CELLS}
  #define G_OCC_MASK ${OCC_MASK_BITS >>> 0}u
  const ivec2 G_OCC_OFF[${OCC_CELLS}] = ivec2[${OCC_CELLS}](${OCC_OFFSETS.map(([x, z]) => `ivec2(${x}, ${z})`).join(', ')});
  const uint G_OCC_COL[25] = uint[25](${uintList(OCC_COL_RANGE)});
  const uint G_OCC_ROW[25] = uint[25](${uintList(OCC_ROW_RANGE)});

  uvec4 gOcc(int gx, int gz, int cy){ return texelFetch(tGridOcc, gTexel(gx, gz, cy), 0); }

  // Box "which" (0 = A, 1 = B) of an occupancy texel as a world AABB and its
  // light transmission. False when the slot holds no box.
  bool gOccBox(uvec4 o, int which, int gx, int gz, int cy, out vec3 lo, out vec3 hi, out float T){
    uint xz = which == 0 ? o.x : o.z;
    uint sh = which == 0 ? 0u : 16u;
    uint y0 = (o.y >> sh) & 255u;
    uint y1 = (o.y >> (sh + 8u)) & 255u;
    if (y1 == 0u) return false;
    vec3 c = vec3(float(gx) * G_CELL, float(cy) * G_LAYER_H, float(gz) * G_CELL);
    lo = c + vec3(float(xz & 255u) * ${glslFloat(OCC_UNIT_XZ)}, float(y0) * ${glslFloat(OCC_UNIT_Y)}, float((xz >> 16u) & 255u) * ${glslFloat(OCC_UNIT_XZ)});
    hi = c + vec3(float((xz >> 8u) & 255u) * ${glslFloat(OCC_UNIT_XZ)}, float(y1) * ${glslFloat(OCC_UNIT_Y)}, float((xz >> 24u) & 255u) * ${glslFloat(OCC_UNIT_XZ)});
    T = float((o.w >> (which == 0 ? ${OCC_T_SHIFT_A}u : ${OCC_T_SHIFT_B}u)) & 7u) * 0.125;
    return true;
  }

  // Ring cells inside the XZ cell rectangle [lo, hi] (offsets from the
  // receiver cell, clamped to ring 2).
  uint gOccRect(ivec2 lo, ivec2 hi){
    lo = clamp(lo, -2, 2);
    hi = clamp(hi, -2, 2);
    return G_OCC_COL[(lo.x + 2) * 5 + hi.x + 2] & G_OCC_ROW[(lo.y + 2) * 5 + hi.y + 2];
  }

  float gOverlap(float a0, float a1, float b0, float b1){
    return max(0.0, min(max(a0, a1), b1) - max(min(a0, a1), b0));
  }
  // Integral over u in [ua, ub] of max(0, min(c + e1 u, hi) - max(c + e0 u, lo)),
  // split at the two clamp kinks so every piece is linear.
  float gClampLenInt(float c, float e0, float e1, float lo, float hi, float ua, float ub){
    if (ub <= ua) return 0.0;
    float k0 = clamp(abs(e0) > 1e-9 ? (lo - c) / e0 : ua, ua, ub);
    float k1 = clamp(abs(e1) > 1e-9 ? (hi - c) / e1 : ua, ua, ub);
    float a = min(k0, k1);
    float b = max(k0, k1);
    float fu = min(c + e1 * ua, hi) - max(c + e0 * ua, lo);
    float fa = min(c + e1 * a, hi) - max(c + e0 * a, lo);
    float fb = min(c + e1 * b, hi) - max(c + e0 * b, lo);
    float fv = min(c + e1 * ub, hi) - max(c + e0 * ub, lo);
    return gPosLin(fu, fa, a - ua) + gPosLin(fa, fb, b - a) + gPosLin(fb, fv, ub - b);
  }

  // Exact fraction of a horizontal, downward-facing rectangular emitter
  // (centre Lp, half extents H) hidden from receiver P by the AABB [lo, hi].
  // Seen from P, the box's shadow on the emitter plane is tiled exactly by
  // the faces that face P: the bottom face (clipped just above P) plus at
  // most two vertical faces, each integrated in closed form (mean error 6e-5
  // against Monte Carlo; see render/shadowMath.js).
  float gBoxCover(vec3 P, vec3 Lp, vec2 H, vec3 lo, vec3 hi){
    float dy = Lp.y - P.y;
    if (dy < 0.05 || P.y >= hi.y - 0.001) return 0.0;
    float y0 = max(lo.y, P.y + 0.001);
    float s0 = dy / (y0 - P.y);
    float s1 = dy / (hi.y - P.y);
    vec2 C = P.xz;
    vec4 pan = vec4(Lp.xz - H, Lp.xz + H);
    float A = gOverlap(C.x + (lo.x - C.x) * s0, C.x + (hi.x - C.x) * s0, pan.x, pan.z)
            * gOverlap(C.y + (lo.z - C.y) * s0, C.y + (hi.z - C.y) * s0, pan.y, pan.w);
    if (P.x < lo.x || P.x > hi.x) {
      float k = (P.x < lo.x ? lo.x : hi.x) - C.x;
      float uA = (pan.x - C.x) / k;
      float uB = (pan.z - C.x) / k;
      A += abs(k) * gClampLenInt(C.y, lo.z - C.y, hi.z - C.y, pan.y, pan.w,
        max(s1, min(uA, uB)), min(s0, max(uA, uB)));
    }
    if (P.z < lo.z || P.z > hi.z) {
      float k = (P.z < lo.z ? lo.z : hi.z) - C.y;
      float uA = (pan.y - C.y) / k;
      float uB = (pan.w - C.y) / k;
      A += abs(k) * gClampLenInt(C.x, lo.x - C.x, hi.x - C.x, pan.x, pan.z,
        max(s1, min(uA, uB)), min(s0, max(uA, uB)));
    }
    return clamp(A / (4.0 * H.x * H.y), 0.0, 1.0);
  }

  // Lambert's polygon form factor, one edge term (vi, vj unit vectors).
  float gEdgeFF(vec3 a, vec3 b, vec3 N){
    vec3 c = cross(a, b);
    float cl = length(c);
    if (cl < 1e-7) return 0.0;
    return atan(cl, dot(a, b)) * dot(N, c) / cl;
  }
  float gQuadFF(vec3 P, vec3 N, vec3 q0, vec3 q1, vec3 q2, vec3 q3){
    vec3 a = normalize(q0 - P);
    vec3 b = normalize(q1 - P);
    vec3 c = normalize(q2 - P);
    vec3 d = normalize(q3 - P);
    return gEdgeFF(a, b, N) + gEdgeFF(b, c, N) + gEdgeFF(c, d, N) + gEdgeFF(d, a, N);
  }
  // Cosine-weighted occlusion of an AABB for an AXIS-ALIGNED receiver
  // (normal = sign * axis): clip the box to the receiver's positive
  // half-space, then sum the form factors of the faces that face P.
  float gBoxFF(vec3 P, vec3 N, vec3 lo, vec3 hi){
    vec3 an = abs(N);
    if (an.x > 0.5) { if (N.x > 0.0) lo.x = max(lo.x, P.x + 1e-4); else hi.x = min(hi.x, P.x - 1e-4); }
    else if (an.y > 0.5) { if (N.y > 0.0) lo.y = max(lo.y, P.y + 1e-4); else hi.y = min(hi.y, P.y - 1e-4); }
    else { if (N.z > 0.0) lo.z = max(lo.z, P.z + 1e-4); else hi.z = min(hi.z, P.z - 1e-4); }
    if (any(greaterThanEqual(lo, hi))) return 0.0;
    // Each face that faces P contributes a positive form factor (its sign
    // from the winding is irrelevant): sum magnitudes, per face.
    float F = 0.0;
    if (P.x < lo.x) F += abs(gQuadFF(P, N, vec3(lo.x, lo.y, lo.z), vec3(lo.x, lo.y, hi.z), vec3(lo.x, hi.y, hi.z), vec3(lo.x, hi.y, lo.z)));
    if (P.x > hi.x) F += abs(gQuadFF(P, N, vec3(hi.x, lo.y, lo.z), vec3(hi.x, hi.y, lo.z), vec3(hi.x, hi.y, hi.z), vec3(hi.x, lo.y, hi.z)));
    if (P.y < lo.y) F += abs(gQuadFF(P, N, vec3(lo.x, lo.y, lo.z), vec3(hi.x, lo.y, lo.z), vec3(hi.x, lo.y, hi.z), vec3(lo.x, lo.y, hi.z)));
    if (P.y > hi.y) F += abs(gQuadFF(P, N, vec3(lo.x, hi.y, lo.z), vec3(lo.x, hi.y, hi.z), vec3(hi.x, hi.y, hi.z), vec3(hi.x, hi.y, lo.z)));
    if (P.z < lo.z) F += abs(gQuadFF(P, N, vec3(lo.x, lo.y, lo.z), vec3(lo.x, hi.y, lo.z), vec3(hi.x, hi.y, lo.z), vec3(hi.x, lo.y, lo.z)));
    if (P.z > hi.z) F += abs(gQuadFF(P, N, vec3(lo.x, lo.y, hi.z), vec3(hi.x, lo.y, hi.z), vec3(hi.x, hi.y, hi.z), vec3(lo.x, hi.y, hi.z)));
    return min(F * 0.15915494, 1.0);
  }

  // Proxies are quantised outward, up to one step per face, so an
  // architecture receiver right beside a rendered face can lie just inside
  // its proxy, where gBoxCover and gBoxFF read full cover on every side of
  // the piece. When P is inside by less than a step through a face on one of
  // its tangent axes, move that face 1 mm past P: the receiver is shaded as
  // the point beside the face it really is. Faces across the normal are left
  // alone (P sits a fixed offset off the surface along N), and a receiver
  // deeper inside, like the floor of a desk's knee hole, keeps the whole box.
  // JS twin: boxBeside.
  void gBoxBeside(vec3 P, vec3 N, inout vec3 lo, inout vec3 hi){
    if (any(lessThan(P, lo)) || any(greaterThan(P, hi))) return;
    vec3 an = abs(N);
    vec3 k = vec3(${glslFloat(1 / (OCC_UNIT_XZ + 0.002))}, ${glslFloat(1 / (OCC_UNIT_Y + 0.002))}, ${glslFloat(1 / (OCC_UNIT_XZ + 0.002))});
    // Added, not scaled: P can lie exactly on a face across the normal.
    vec3 e = vec3(0.0);
    if (an.x >= an.y && an.x >= an.z) e.x = 1e6; else if (an.y >= an.z) e.y = 1e6; else e.z = 1e6;
    vec3 rl = (P - lo) * k + e;
    vec3 rh = (hi - P) * k + e;
    // Only the shallowest face moves: within a step of two faces (the square
    // at a vertical edge) the proxy cannot tell which one P is really
    // beside, and moving both would cut the corner off.
    float m = min(min(min(rl.x, rl.y), rl.z), min(min(rh.x, rh.y), rh.z));
    if (m >= 1.0) return;
    if (m == rl.x) lo.x = P.x + 0.001;
    else if (m == rh.x) hi.x = P.x - 0.001;
    else if (m == rl.y) lo.y = P.y + 0.001;
    else if (m == rh.y) hi.y = P.y - 0.001;
    else if (m == rl.z) lo.z = P.z + 0.001;
    else hi.z = P.z - 0.001;
  }
`
