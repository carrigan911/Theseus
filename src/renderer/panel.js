// Procedural Dyson-shell tile: thick bevelled hex/pentagon plate with a raised inner plate and trim groove, smudged steel,
// side walls lit from below by the star. Context use = "dimming energy": a fresh tile's trim and inner field glow in the
// core colour; the glow fades and the steel dulls as context fills. Parked tiles are much darker. Labels are painted from a
// canvas alpha mask.
// Geometry attributes: aEdge (1 at the tile centre, 0 at the rim), aSide (1 on side walls), aWall (0 top .. 1 bottom of a wall),
// aFlatP / aFlatN / aFlatUV (the tile in the flat rows; uSpread blends the shell form into it on the GPU).
import * as THREE from '../../node_modules/three/build/three.module.js';
import { swapUniforms, SWAP_DECL, SWAP_GLSL, SWAP_POST } from './swapfx.js';

// Shared by every tile: core light spilling over edges, energy colour (= chosen core colour), time for the shimmer.
export const GLOW = { value: new THREE.Color(0x3da5ff) };
export const ENERGY = { value: new THREE.Color(0x3da5ff) };
export const TIME = { value: 0 };
export const SPREAD = { value: 0 };   // 0 on the shell .. 1 in the flat rows

// value noise from a small tiling texture: G is R moved by (37, 17) per z step, so one bilinear fetch gives two z slices
// (the same smoothstep value noise as the old per-pixel hash, at one texture read per octave)
export const NOISE_TEX = (() => {
  const N = 256, d = new Uint8Array(N * N * 4); let r = 0x2f6b1d;
  const rnd = () => { r ^= r << 13; r ^= r >>> 17; r ^= r << 5; return r >>> 24; };
  for (let i = 0; i < N * N; i++) d[i * 4] = rnd();
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const i = (y * N + x) * 4; d[i + 1] = d[(((y - 17) & 255) * N + ((x - 37) & 255)) * 4]; d[i + 3] = 255; }
  const t = new THREE.DataTexture(d, N, N);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = t.minFilter = THREE.LinearFilter; t.generateMipmaps = false; t.needsUpdate = true;
  return t;
})();
export const NOISE_GLSL = /* glsl */`
uniform sampler2D uNoise;
float vnoise(vec3 x) {
  vec3 p = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  vec2 uv = mod(p.xy + vec2(37.0, 17.0) * p.z, 256.0) + f.xy;
  vec2 rg = texture2D(uNoise, (uv + 0.5) / 256.0).yx;
  return mix(rg.x, rg.y, f.z);
}`;

const COMMON = /* glsl */`
uniform float uLevel, uParked, uSeed, uHasLabel, uBump, uTime, uGold, uHover, uFlare, uRipple, uHeat, uWork, uWait, uIdle, uRing;
uniform vec3 uGlow, uEnergy;
uniform sampler2D uLabel;
${SWAP_DECL}
varying vec2 vPUv;
varying vec3 vObjPos;
varying float vEdge, vSide, vWall;
${NOISE_GLSL}
float fbm(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; } return s / 0.9375; }
vec3 perturbN(vec3 pos, vec3 n, vec2 dH, float faceDir) {
  vec3 sx = normalize(dFdx(pos)), sy = normalize(dFdy(pos));
  vec3 r1 = cross(sy, n), r2 = cross(n, sx);
  float det = dot(sx, r1) * faceDir;
  vec3 g = sign(det) * (dH.x * r1 + dH.y * r2);
  return normalize(abs(det) * n - g);
}
float gH, gRough, gMetal, gLbl;
vec3 gEmit;
#if WEAR != 0
// wear styles (Docs/Previews/tile_wear_previews.html): the page's 2-D plate helpers on the tile's upright label coordinates
float hsh(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float tI(float k) { return mod(floor(uTime * k), 97.0); }       // a time step that stays small, so the hash keeps its precision
float nz2(vec2 x) { return vnoise(vec3(x, 0.0)); }
float fbm2(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * nz2(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; } return s / 0.9375; }
vec3 voronoi(vec2 x) {
  vec2 n = floor(x), f = fract(x); float f1 = 8.0, f2 = 8.0, id = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j)), r = g + vec2(hsh(n + g), hsh(n + g + 19.7)) - f; float dd = dot(r, r);
    if (dd < f1) { f2 = f1; f1 = dd; id = hsh(n + g + 3.1); } else if (dd < f2) f2 = dd;
  }
  return vec3(sqrt(f1), sqrt(f2), id);
}
#endif
`;

// One wear style (the page's plate() branch for it). Names: pp = plate coords (circumradius 1, upright), q = pp scaled + seed,
// hd = rim distance (1 at the rim), pct = context use, heat = the last 10 %. Changes alb / gRough / gMetal / gH, adds to emit,
// scales glow (the core-colour groove light) and lblA (label alpha), and sets wallC / wallK (a darker take for the side walls).
const WEAR_BODY = /* glsl */`
  vec2 pp = (vPUv - 0.5) * 2.0;
  float sd = fract(uSeed * 0.137) * 20.0;
  float pct = clamp(uLevel, 0.0, 1.0), heat = uHeat;
  float hd = 1.0 - vEdge, rimb = 1.0 - smoothstep(0.0, 0.07, d);
#if WEAR == 10
  float gt = tI(9.0);
  { float band = floor(pp.y * 14.0);                         // glitch: horizontal tears move the pattern and the label
    if (hsh(vec2(band, gt)) < pct * 0.45) { float sh = (hsh(vec2(band, gt + 7.0)) - 0.5) * 0.35 * pct; pp.x += sh; lUv.x += sh * 0.15; } }
#endif
  vec2 q = pp * 1.7 + sd;
  float energy = pow(1.0 - pct, 1.3);
  float field = inner * (0.05 + 0.09 * fbm2(q * 4.0 + vec2(0.0, uTime * 0.08)));
  vec3 core = mix(uEnergy, vec3(dot(uEnergy, vec3(0.3333))), uParked);
  core = mix(core, vec3(1.0, 0.7, 0.25), uGold);
  vec3 amber = vec3(1.0, 0.62, 0.12), red = vec3(1.0, 0.14, 0.08);
  vec3 glc = core, emit = vec3(0.0); float glow = energy;
#if WEAR == 1 || WEAR == 2 || WEAR == 4 || WEAR == 6 || WEAR == 7 || WEAR == 8 || WEAR == 10 || WEAR == 12
  if (pct > 0.015)   // these are clean at 0 %: fresh tiles and energy cells skip the pattern work
#endif
#if WEAR == 1 || WEAR == 4
  {   // rust (1: runs to 100 %; 4: done by 80 %, then glowing seams)
#if WEAR == 1
    float a = pct;
#else
    float a = min(pct / 0.8, 1.0);
#endif
    float n = fbm2(q * 1.3 + 3.1), edge = 1.0 - smoothstep(0.0, 0.22, d);
    float st = fbm2(vec2(q.x * 4.0, q.y * 0.5) + 7.0) * smoothstep(0.3, 0.75, a) * (0.6 - pp.y * 0.45);
    float v = n + edge * 0.32 + st * 0.35, thr = 1.2 - a * 0.95;
    float m = smoothstep(thr, thr + 0.07, v) * step(0.02, a);
    vec3 rc = mix(vec3(0.01, 0.0045, 0.0025), vec3(0.055, 0.02, 0.008), fbm2(q * 5.0)) * mix(0.8, 1.08, nz2(q * 38.0));
    alb = mix(alb, rc, m); gRough = mix(gRough, 0.95, m); gMetal = mix(gMetal, 0.05, m); gH += m * (0.03 + 0.06 * nz2(q * 45.0));
    glow *= 1.0 - m * 0.85; lblA *= 1.0 - m * 0.7;
    if (a > 0.6) {
      vec3 vr = voronoi(q * 3.5 + 11.0);
      float fl = step(vr.z, (a - 0.6) * 1.4) * smoothstep(thr + 0.05, thr + 0.2, v), lip = 1.0 - smoothstep(0.0, 0.06, vr.y - vr.x);
      alb = mix(alb, vec3(0.07, 0.055, 0.05), fl * (1.0 - lip * 0.5)); gH -= 0.09 * fl; gRough = mix(gRough, 0.6, fl);
      alb = mix(alb, vec3(0.32, 0.14, 0.05), fl * lip * 0.6);
    }
    vec3 vc = voronoi(q * 2.6 + 5.0); float cl = 1.0 - smoothstep(0.0, 0.035, vc.y - vc.x);
#if WEAR == 1
    emit += heat * ember * flick * (cl * 2.2 * m + 1.4 * rimb);
#else
    float k = clamp((pct - 0.8) / 0.2, 0.0, 1.0);
    float reach = smoothstep(1.0 - k * 1.3, 1.0 - k * 1.3 + 0.1, hd + 0.15 * nz2(q * 6.0));
    float seam = (1.0 - smoothstep(0.0, 0.012 + 0.03 * k, vc.y - vc.x)) * reach * step(0.001, k);
    gH -= seam * 0.25; alb *= 1.0 - 0.8 * seam;
    emit += ember * seam * (1.2 + 1.6 * flick) * k * 1.5 + heat * ember * flick * rimb * 1.2;
#endif
    wallC = vec3(0.04, 0.017, 0.008); wallK = 0.85 * smoothstep(0.12, 0.7, a);
  }
#elif WEAR == 2
  {   // cracks + scorch
    float sc = clamp(smoothstep(0.05, 1.0, pct) * (0.45 + 0.55 * fbm2(q * 1.6 + 2.0)) * (0.55 + 0.9 * (0.5 - d)), 0.0, 1.0);
    alb = mix(alb, alb * vec3(0.32, 0.27, 0.24), sc); gRough += 0.3 * sc; gMetal = mix(gMetal, 0.55, sc);
    vec3 vc = voronoi(q * 2.4 + 5.0);
    float reach = smoothstep(1.0 - pct * 1.25, 1.0 - pct * 1.25 + 0.08, hd + 0.12 * nz2(q * 5.0));
    float w = 0.006 + 0.03 * smoothstep(0.2, 1.0, pct);
    float cr = (1.0 - smoothstep(w * 0.4, w, vc.y - vc.x)) * reach;
    vec3 v2 = voronoi(q * 6.0 + 9.0);
    float cr2 = (1.0 - smoothstep(0.003, 0.012, v2.y - v2.x)) * reach * smoothstep(0.45, 0.75, pct);
    float crk = max(cr, cr2 * 0.8);
    gH -= crk * 0.25; alb *= 1.0 - 0.85 * crk;
    float h2 = smoothstep(0.75, 1.0, pct);
    emit += ember * crk * h2 * (0.6 + 0.8 * flick) * 2.2 + heat * ember * flick * rimb * 0.8;
    glow *= 1.0 - sc * 0.6;
    lblA *= 1.0 - h2 * 0.7 * step(0.65, hsh(vec2(tI(11.0), sd)));
    wallC = vec3(0.05, 0.043, 0.04); wallK = 0.75 * smoothstep(0.05, 1.0, pct);
  }
#elif WEAR == 3
  {   // energy drain: the groove light goes core -> amber -> red and stutters at the end
    glc = pct < 0.5 ? mix(core, amber, pct / 0.5) : mix(amber, red, (pct - 0.5) / 0.5);
    float stut = mix(1.0, 0.25 + 0.75 * step(0.4, hsh(vec2(tI(13.0), sd))), heat);
    glow = stut * 1.05;
    alb *= mix(1.0, 0.72, pct); gRough += 0.28 * pct;
    emit += glc * rimb * 0.5 * pct * stut;
    wallHeat = red;
  }
#elif WEAR == 5
  {   // heat tint: temper colours, then red-hot from the rim
    float tp = clamp(pct * 0.95 + (1.0 - smoothstep(0.0, 0.3, d)) * 0.15 + (fbm2(q * 1.5 + 4.0) - 0.5) * 0.2 - 0.12, 0.0, 1.0);
    vec3 r1 = mix(vec3(0.55), vec3(0.85, 0.7, 0.4), smoothstep(0.05, 0.22, tp));
    r1 = mix(r1, vec3(0.62, 0.36, 0.18), smoothstep(0.22, 0.42, tp)); r1 = mix(r1, vec3(0.42, 0.2, 0.45), smoothstep(0.42, 0.62, tp));
    r1 = mix(r1, vec3(0.18, 0.3, 0.66), smoothstep(0.62, 0.82, tp)); r1 = mix(r1, vec3(0.42, 0.48, 0.55), smoothstep(0.86, 1.0, tp));
    alb = alb / 0.53 * r1; gRough += 0.1 * pct;
    emit += vec3(1.0, 0.24, 0.05) * 1.1 * heat * (1.0 - smoothstep(heat * 0.16, heat * 0.24 + 0.02, d)) * (0.75 + 0.25 * flick);
    wallC = r1 * 0.3; wallK = 0.8;
  }
#elif WEAR == 6
  {   // frost creeping in from the rim
    float v = (1.0 - d * 2.0) + (fbm2(q * 2.0 + 6.0) - 0.5) * 0.5, m = smoothstep(1.36 - pct * 1.22, 1.44 - pct * 1.22, v) * step(0.02, pct) * 0.88;
    vec3 vf = voronoi(q * 9.0 + 2.0); float fern = 1.0 - smoothstep(0.0, 0.05, vf.y - vf.x);
    alb = mix(alb, vec3(0.6, 0.7, 0.82) * (0.7 + 0.35 * fern + 0.15 * nz2(q * 50.0)), m);
    gRough = mix(gRough, 0.5 - 0.3 * fern, m); gMetal = mix(gMetal, 0.05, m); gH += m * (0.04 + 0.04 * fern);
    glow *= 1.0 - m * 0.75; lblA *= 1.0 - m * 0.6;
    vec3 vc = voronoi(q * 2.6 + 5.0); float cl = 1.0 - smoothstep(0.0, 0.03, vc.y - vc.x);
    emit += core * cl * heat * m * 2.4 * (0.7 + 0.3 * flick);
    wallC = vec3(0.32, 0.38, 0.46); wallK = 0.65 * smoothstep(0.1, 0.9, pct); wallHeat = core;
  }
#elif WEAR == 7
  {   // glassy crystals grow over the plate
    vec3 vc = voronoi(q * 4.0 + 8.0);
    float m = step(vc.z, pct * 1.15 + (1.0 - smoothstep(0.0, 0.3, d)) * 0.25 - 0.12) * step(0.02, pct);
    gH += m * (0.35 - vc.x * 0.9);
    alb = mix(alb, vec3(0.1, 0.14, 0.2), m); gRough = mix(gRough, 0.06, m); gMetal = mix(gMetal, 0.0, m);
    float edgeC = 1.0 - smoothstep(0.0, 0.035, vc.y - vc.x);
    emit += m * (core * (0.04 + 0.3 * pow(max(0.0, 1.0 - vc.x * 1.6), 3.0)) * (1.0 + heat * (1.5 + flick)) + mix(core, vec3(1.0), 0.6) * edgeC * 0.18);
    glow *= 1.0 - m * 0.7; lblA *= 1.0 - m * 0.8;
    wallC = vec3(0.06, 0.085, 0.13); wallK = 0.7 * smoothstep(0.05, 0.8, pct); wallHeat = core;
  }
#elif WEAR == 8
  {   // copper-green patina from the grooves and rim
    float gp = 1.0 - smoothstep(0.0, 0.09, abs(d - 0.13)), edge = 1.0 - smoothstep(0.0, 0.2, d);
    float v = fbm2(q * 1.8 + 1.0) * 0.8 + gp * 0.45 + edge * 0.3, thr = 1.3 - pct * 1.05;
    float m = smoothstep(thr, thr + 0.08, v) * step(0.02, pct);
    vec3 pc = mix(vec3(0.1, 0.27, 0.22), vec3(0.3, 0.6, 0.5), fbm2(q * 6.0)) * mix(0.85, 1.08, nz2(q * 40.0));
    alb = mix(alb, pc, m); gRough = mix(gRough, 0.85, m); gMetal = mix(gMetal, 0.1, m); gH += m * 0.03 * nz2(q * 30.0);
    glow *= 1.0 - m * 0.6; lblA *= 1.0 - m * 0.55;
    emit += heat * ember * flick * rimb * 1.2;
    wallC = vec3(0.07, 0.17, 0.14); wallK = 0.8 * smoothstep(0.08, 0.8, pct);
  }
#elif WEAR == 9
  {   // circuit traces burn out one by one
    vec2 gq = q * 5.0, cf = fract(gq), ci = floor(gq);
    float line = hsh(ci) < 0.5 ? abs(cf.y - 0.5) : abs(cf.x - 0.5);
    float tr = (1.0 - smoothstep(0.05, 0.08, line)) * inner, pad = (1.0 - smoothstep(0.1, 0.14, length(cf - 0.5))) * step(0.55, hsh(ci + 5.0)) * inner;
    float on = max(tr, pad), hc = hsh(ci + 2.0);
    float lit = step(pct, hc), dying = step(pct, hc + 0.06) * (1.0 - lit) * step(0.5, hsh(vec2(tI(15.0), hc * 50.0)));
    gH -= on * 0.03; alb = mix(alb, mix(vec3(0.06, 0.05, 0.05), vec3(0.2, 0.22, 0.25), lit), on * 0.85);
    emit += on * (core * 1.3 * lit + vec3(1.0, 0.7, 0.4) * 2.0 * dying);
    glow *= 0.4 + 0.6 * (1.0 - pct);
  }
#elif WEAR == 10
  {   // glitch: tears (above), dimmed light; blocks and scanlines go after shading
    alb *= mix(1.0, 0.8, pct); glow *= 1.0 - 0.4 * pct;
    lblA *= 1.0 - pct * 0.8 * step(0.6, hsh(vec2(gt, floor(pp.y * 10.0))));
  }
#elif WEAR == 11
  {   // fill gauge: a light level rises with the context (the level runs rim to rim of the upright plate)
    float L = -0.66 + 1.32 * pct + 0.03 * sin(pp.x * 6.0 + uTime * 2.0);
    vec3 gc = mix(mix(core, amber, smoothstep(0.62, 0.7, pct)), red, smoothstep(0.86, 0.93, pct));
    float below = 1.0 - smoothstep(L - 0.01, L + 0.01, pp.y), men = 1.0 - smoothstep(0.0, 0.025, abs(pp.y - L));
    emit += gc * inner * (below * (0.22 + 0.1 * fbm2(q * 3.0 + vec2(0.0, uTime * 0.3))) * (1.0 + heat * 0.8 * flick) + men * 1.6);
    glc = gc;
  }
#elif WEAR == 12
  {   // dust and grime settle and dull the plate
    float m = clamp(pct * (0.55 + 0.6 * fbm2(q * 5.0 + 3.0)) + groove * pct * 0.5 + (1.0 - bevel) * pct * 0.25, 0.0, 1.0);
    alb = mix(alb, vec3(0.4, 0.38, 0.34) * mix(0.75, 1.1, nz2(q * 90.0)), m * 0.85); gRough = mix(gRough, 0.95, m); gMetal = mix(gMetal, 0.15, m);
    glow *= 1.0 - m * 0.6; lblA *= 1.0 - m * 0.5;
    emit += heat * ember * flick * rimb * 0.8;
    wallC = vec3(0.2, 0.19, 0.17); wallK = 0.6 * smoothstep(0.05, 0.8, pct);
  }
#endif
  emit += glc * glow * (field + groove);
  gEmit = emit * mix(1.0, 0.18, uParked);
  gRough = clamp(gRough, 0.05, 1.0);
  alb = mix(alb, vec3(0.86, 0.64, 0.26), uGold * max(groove, wear * bevel) * 0.9);   // Session manager: gold trim stays on top
`;

const SURFACE = /* glsl */`
{
  float d = vEdge * 0.5;                                     // distance to the rim, ~0.5 at the centre
  float bevel = smoothstep(0.0, 0.06, d);
  float spill = 1.0 - smoothstep(0.0, 0.04, d);
  float groove = 1.0 - smoothstep(0.005, 0.013, abs(d - 0.13));
  float inner = smoothstep(0.14, 0.17, d);                   // raised inner plate inside the groove
  vec3 p = vObjPos * 1.7 + uSeed;
  float smudge = fbm(p * 3.0);
  gH = bevel - 0.45 * groove + 0.3 * inner + 0.025 * vnoise(p * 70.0);

  vec3 alb = vec3(0.5, 0.52, 0.55) * mix(0.62, 1.12, smudge);
  float wear = 1.0 - smoothstep(0.015, 0.06, d);
  alb = mix(alb, vec3(0.76, 0.78, 0.8), wear * bevel * 0.6);
  alb *= 1.0 - 0.65 * groove;
  alb *= mix(0.92, 1.0, inner);
#if WEAR == 0
  alb = mix(alb, vec3(0.86, 0.64, 0.26), uGold * max(groove, wear * bevel) * 0.9);   // Session manager: gold trim
#endif
  gRough = mix(0.18, 0.5, smudge) + 0.15 * groove;
  gMetal = 0.93;

  // near the swap line the tile heats up: ember trim and rim, slow uneven flicker
  float flick = 0.6 + 0.4 * sin(uTime * 2.3 + uSeed) * sin(uTime * 3.7 + uSeed * 1.7);
  vec3 ember = vec3(1.0, 0.36, 0.07);
  vec2 lUv = vPUv; float lblA = 1.0;                         // label uv / alpha (a wear style may tear or flicker the label)
  float wallK = 0.0; vec3 wallC = vec3(0.0), wallHeat = ember;   // side walls: a darker take of the wear
#if WEAR == 0
  float energy = pow(1.0 - clamp(uLevel, 0.0, 1.0), 1.3);
  alb *= mix(0.5, 1.0, energy);
  gRough = mix(gRough + 0.22, gRough, energy);
  float field = inner * (0.05 + 0.09 * fbm(p * 4.0 + vec3(0.0, uTime * 0.08, 0.0)));
  vec3 ecol = mix(uEnergy, vec3(dot(uEnergy, vec3(0.3333))), uParked);
  ecol = mix(ecol, vec3(1.0, 0.7, 0.25), uGold);
  gEmit = ecol * energy * (field + groove * 1.0) * mix(1.0, 0.18, uParked);
#else
${WEAR_BODY}
#endif

  gLbl = 0.0;
#if WEAR == 6 || WEAR == 7 || WEAR == 9 || WEAR == 10
  // busy wears (frost, crystals, burn-out, glitch): a soft dark halo under the text where the wear's pattern and light step back
  if (uHasLabel > 0.5 && vSide < 0.5 && max(abs(lUv.x - 0.5), abs(lUv.y - 0.5)) < 0.4) {   // only where text can be
    for (int i = 0; i < 8; i++) { float an = float(i) * 0.785398; gLbl = max(gLbl, texture2D(uLabel, lUv + vec2(cos(an), sin(an)) * 0.022).a); }
    alb = mix(alb, vec3(0.06, 0.065, 0.075), gLbl * 0.8); gEmit *= 1.0 - 0.85 * gLbl;
  }
  lblA = max(lblA, 0.9);
#endif
  float a = uHasLabel * texture2D(uLabel, lUv).a * lblA * (1.0 - vSide);
  alb = mix(alb, texture2D(uLabel, lUv).rgb * vec3(0.93, 0.95, 0.97), a);   // the text is white; a mark keeps its colour
  gRough = mix(gRough, 0.55, a); gMetal = mix(gMetal, 0.0, a);
  gEmit += a * vec3(mix(0.17, 0.05, uParked));

  float l = dot(alb, vec3(0.3, 0.59, 0.11));
  alb = mix(alb, vec3(l) * vec3(0.3, 0.31, 0.33), uParked);
  gEmit += uGlow * spill * 1.1 * (1.0 - vSide);
  // sitting idle: a little darker and greyer (WorkingTiles_Spec.md)
  alb = mix(alb, vec3(dot(alb, vec3(0.3, 0.59, 0.11))), 0.3 * uIdle) * (1.0 - 0.25 * uIdle); gEmit *= 1.0 - 0.3 * uIdle;
  // hovered in the flat rows: lit trim and a soft wash in the core colour
  vec3 hcol = mix(uEnergy, vec3(1.0), 0.35);
  // working: trim and rim pulse in the core colour (2 s); waiting on the user: the same in yellow
  float pulse = 0.5 + 0.5 * sin(uTime * 3.14159);
  vec3 acol = (uWork * hcol + uWait * vec3(0.96, 0.77, 0.26)) * (0.3 + 0.7 * pulse);
  gEmit += acol * (2.2 * groove + 1.8 * (1.0 - smoothstep(0.0, 0.07, d)) + 0.08 * inner);
  gEmit += uHover * hcol * (0.22 + 3.0 * groove + 2.5 * (1.0 - smoothstep(0.0, 0.06, d)));
  alb *= 1.0 + 0.6 * uHover;
#if WEAR == 0
  gEmit += uHeat * ember * flick * (2.4 * groove + 1.8 * (1.0 - smoothstep(0.0, 0.07, d)) + 0.12 * inner);
#endif
  // context grew: a ring runs from the centre to the rim
  if (uRipple >= 0.0) { float w = abs((1.0 - vEdge) - uRipple * 1.05); gEmit += hcol * (1.0 - smoothstep(0.0, 0.1, w)) * (1.0 - uRipple) * 1.8; }
  // context ring (setting): the rim band fills clockwise from the top with the context used (0 -> swap line);
  // core colour, amber from 75 %, red from 90 %; the rest of the band is a faint dark track. uRing < 0: off
  if (uRing >= 0.0 && vSide < 0.5) {
    float band = smoothstep(0.016, 0.026, d) * (1.0 - smoothstep(0.046, 0.056, d));
    vec2 q = vPUv - 0.5; float f = fract(atan(q.x, q.y) / 6.28318 + 1.0);
    vec3 rc = uRing >= 0.9 ? vec3(1.0, 0.24, 0.18) : uRing >= 0.75 ? vec3(1.0, 0.66, 0.18) : hcol;
    float on = uRing >= 0.999 ? 1.0 : 1.0 - smoothstep(uRing - 0.004, uRing + 0.004, f);
    alb = mix(alb, vec3(0.04), band * 0.55 * (1.0 - on));
    gEmit += rc * band * on * 1.7;
  }
  // rebirth: the whole plate flares
  gEmit += uFlare * mix(uEnergy, vec3(1.0), 0.6) * (0.9 + 2.0 * groove);

  // side walls: dark machined steel, lit by the star from below
  if (vSide > 0.5) {
    gH = 0.0;
    alb = vec3(0.16, 0.17, 0.19) * mix(1.0, 0.45, uParked);
#if WEAR != 0
    alb = mix(alb, wallC * mix(1.0, 0.45, uParked), clamp(wallK * (0.45 + 1.1 * vnoise(vObjPos * 60.0 + uSeed)), 0.0, 1.0));
#endif
    gRough = 0.45; gMetal = 0.85;
    gEmit = uGlow * (0.25 + 1.6 * vWall * vWall) + uHover * hcol * 0.6 + uHeat * wallHeat * flick * 0.7 + uFlare * mix(uEnergy, vec3(1.0), 0.6) + acol * 0.7;
  }
${SWAP_GLSL}
  diffuseColor.rgb = alb;
}
`;

// Glitch: broken pixel blocks and scanlines go on after shading (display colours), as on the page
const WEAR_POST = /* glsl */`
#if WEAR == 10
{
  vec2 pr = (vPUv - 0.5) * 2.0; float pc = clamp(uLevel, 0.0, 1.0), top = 1.0 - vSide, gtp = tI(9.0);
  vec2 bq = floor(pr * vec2(9.0, 12.0));
  float blk = step(hsh(bq + gtp * 1.37), pc * pc * 0.14) * top * (1.0 - gLbl);   // no blocks over the text
  vec3 bc = hsh(bq + 3.0) < 0.5 ? vec3(0.0) : vec3(0.6, 0.86, 0.83) * mix(1.0, 0.3, uParked);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, bc, 0.85 * blk);
  gl_FragColor.rgb *= 1.0 - 0.18 * pc * step(0.5, fract(pr.y * 40.0)) * top;
  gl_FragColor.r += 0.12 * pc * step(0.8, hsh(vec2(floor(pr.y * 30.0), gtp))) * top * (1.0 - 0.7 * uParked);
}
#endif
`;

// tile wear style 0-12 (TileStyles_Spec.md; 0 = Today, the look before wear styles). Compiled in as a #define.
let wearStyle = 0;
const tiles = new Set();   // WeakRefs to every tile material, so a change reaches them all

export function makePanelMaterial(seed = Math.random() * 100) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.92, roughness: 0.35 });
  const u = mat.userData.u = {
    uLevel: { value: 0 }, uParked: { value: 0 }, uGold: { value: 0 }, uSeed: { value: seed },
    uHasLabel: { value: 0 }, uLabel: { value: null }, uHover: { value: 0 }, uFlare: { value: 0 }, uRipple: { value: -1 }, uRing: { value: -1 }, uHeat: { value: 0 }, uWork: { value: 0 }, uWait: { value: 0 }, uIdle: { value: 0 }, uBump: { value: 1.8 }, uGlow: GLOW, uEnergy: ENERGY, uTime: TIME,
    uSpread: SPREAD, uNoise: { value: NOISE_TEX }, ...swapUniforms(),
  };
  mat.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aEdge, aSide, aWall;\nattribute vec3 aFlatP, aFlatN;\nattribute vec2 aFlatUV;\nuniform float uSpread;\nvarying vec2 vPUv;\nvarying vec3 vObjPos;\nvarying float vEdge, vSide, vWall;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvPUv = mix(uv, aFlatUV, uSpread);\nvEdge = aEdge; vSide = aSide; vWall = aWall;')
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nobjectNormal = mix(objectNormal, aFlatN, uSpread);')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed = mix(position, aFlatP, uSpread);\nvObjPos = transformed;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + COMMON)
      .replace('#include <map_fragment>', '#include <map_fragment>\n' + SURFACE)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = gRough;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = gMetal;')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = perturbN(-vViewPosition, normal, vec2(dFdx(gH), dFdy(gH)) * uBump, faceDirection);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += gEmit;')
      .replace('#include <dithering_fragment>', '#include <dithering_fragment>\n' + WEAR_POST + SWAP_POST);
    sh.fragmentShader = '#define WEAR ' + wearStyle + '\n' + sh.fragmentShader;   // only the chosen wear style is compiled
  };
  mat.customProgramCacheKey = () => 'sphere-tile-hex-v4-w' + wearStyle;
  if (tiles.size > 400) for (const w of tiles) if (!w.deref()) tiles.delete(w);   // rebuilds leave dead refs behind
  tiles.add(new WeakRef(mat));
  return mat;
}

// set the wear style for every tile (existing and new); each material recompiles once, on its next draw
// changes whenever the tile shaders change (settings-window picture cache key)
export const SHADER_VER = (COMMON.length + SURFACE.length * 7 + WEAR_BODY.length * 13 + WEAR_POST.length * 17).toString(36);

export function setPanelWear(n) {
  n = Math.max(0, Math.min(12, Math.round(Number(n)) || 0));
  if (n === wearStyle) return;
  wearStyle = n;
  for (const r of tiles) { const m = r.deref(); if (m) m.needsUpdate = true; else tiles.delete(r); }
}

export function setPanelHover(mat, on) { mat.userData.u.uHover.value = on ? 1 : 0; }

// pct 0..1 context use, parked bool, label CanvasTexture or null
export function setPanelState(mat, { pct = 0, parked = false, label = null, gold = false }) {
  const u = mat.userData.u;
  u.uLevel.value = Math.max(0, Math.min(1, pct));
  u.uParked.value = parked ? 1 : 0;
  u.uHeat.value = parked ? 0 : Math.max(0, Math.min(1, (pct - 0.9) / 0.1));   // last 10% before the swap line
  u.uGold.value = gold ? 1 : 0;
  if (u.uLabel.value && u.uLabel.value !== label) u.uLabel.value.dispose();
  u.uLabel.value = label; u.uHasLabel.value = label ? 1 : 0;
}
