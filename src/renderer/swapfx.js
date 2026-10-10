// Swap animations for the tiles (Docs/Specs/TileStyles_Spec.md; the look follows Docs/Previews/tile_wear_previews.html).
// Modes as on the page: 1 Today, 2 Polished, 3 Shatter & rebuild, 4 Dissolve swap, 5 Card flip, 6 Power down.
// swapPose(mode, e) is the timeline (e = seconds since the swap began): sphere.js moves the mesh with it (scale, sink toward
// the core, flip, hidden) and feeds the shader below (uSwapMode / uSwapT / uSwapNew / uSwapA). Mode 1 is the old flare + regrow
// (no shader part). The sphere and the settings preview (tilepreview.js) both run on swapPose / swapDrive / swapMesh.
import * as THREE from '../../node_modules/three/build/three.module.js';
const clamp01 = x => Math.max(0, Math.min(1, x));
const ease = x => 1 - Math.pow(1 - clamp01(x), 3);
const easeIO = x => { x = clamp01(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
const backOut = x => { x = clamp01(x); const c = 1.9; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); };
const sstep = (a, b, x) => { x = clamp01((x - a) / (b - a)); return x * x * (3 - 2 * x); };

// length of each swap (s)
export const SWAP_LEN = { 1: 2.2, 2: 2.5, 3: 2.4, 4: 2.35, 5: 1.8, 6: 3.4 };
export const SWAP_NAMES = { 1: 'Flare', 2: 'Polished', 3: 'Shatter', 4: 'Dissolve', 5: 'Card Flip', 6: 'Power Down' };
// the most telling moment of each swap (the settings pictures)
export const SWAP_THUMB_T = { 1: 0.5, 2: 0.95, 3: 0.85, 4: 0.65, 5: 0.5, 6: 2.6 };

// -> sc: scale about the tile centre; fl: plate flare (uFlare); ang: turn about the tile's own vertical axis; sink: distance moved
// toward the core / away from the viewer in the rows (root units); alpha: screen-door fade; vis: false while the slot is empty;
// layer: 0 = the old tile, 1 = the fresh one (label, wear level swap over at that moment); labelK: label fade-in
export function swapPose(mode, e) {
  const P = { sc: 1, fl: 0, ang: 0, sink: 0, alpha: 1, vis: true, layer: 0, labelK: 1 };
  if (mode === 1) {                                   // Today: flare, then the plate regrows from half size
    if (e < 0.6) { P.fl = ease(e / 0.6); P.sc = 1 + 0.08 * P.fl; }
    else { P.layer = 1; const g = ease((e - 0.6) / 1.6); P.sc = 0.5 + 0.5 * g; P.fl = 0.5 * (1 - g); }
  } else if (mode === 2) {                                   // flare, then the clean plate springs back (overshoot), ring + sheen in the shader
    if (e < 0.6) { P.fl = ease(e / 0.6); P.sc = 1 + 0.08 * P.fl; }
    else { P.layer = 1; P.sc = 0.35 + 0.65 * backOut((e - 0.6) / 1.1); P.fl = 0.5 * (1 - ease((e - 0.6) / 1.6)); }
  } else if (mode === 3) {                            // cracks + shards (old) -> rebuild from the rim inward (fresh)
    P.layer = e >= 1.3 ? 1 : 0; if (P.layer) P.labelK = sstep(1.9, 2.4, e);
  } else if (mode === 4) {                            // burns away -> materialises
    P.layer = e >= 1.1 ? 1 : 0; if (P.layer) P.labelK = sstep(1.7, 2.3, e);
  } else if (mode === 5) {                            // card flip: the fresh plate is on the back; past edge-on it is shown from the front
    const a = Math.PI * easeIO(e / 1.2);
    P.sc = 1 + 0.12 * Math.sin(a); P.layer = a >= Math.PI / 2 ? 1 : 0; P.ang = P.layer ? a - Math.PI : a;
  } else if (mode === 6) {                            // dark by 1.0 s, sinks into the core by 1.5 s, empty until 1.85 s, rises dark by 2.25 s, relights
    P.layer = e >= 1.5 ? 1 : 0;
    if (e >= 1.0 && e < 1.5) { const k = ease((e - 1.0) / 0.5); P.sc = 1 - 0.9 * k; P.sink = 0.85 * k; P.alpha = 1 - k; }
    else if (e >= 1.5 && e < 1.85) P.vis = false;
    else if (e >= 1.85) { const k = ease((e - 1.85) / 0.4); P.sc = 0.8 + 0.2 * k; P.sink = 0.5 * (1 - k); P.alpha = k; P.labelK = sstep(2.8, 3.2, e); }
  }
  return P;
}

// feed a tile material's uniforms (u = material.userData.u) for the swap at e seconds; returns the pose
export function swapDrive(u, mode, e) {
  const P = swapPose(mode, e);
  u.uSwapMode.value = mode; u.uSwapT.value = e; u.uSwapNew.value = P.layer; u.uSwapA.value = P.alpha; u.uFlare.value = P.fl;
  return P;
}
// move a tile mesh by a pose: scale sc about its centre C, turn about its own vertical axis, sink along its outward normal n
const _q = new THREE.Vector3(), _a = new THREE.Vector3();
export function swapMesh(mesh, P, sc, C, n) {
  mesh.visible = P.vis !== false && sc > 0.001; mesh.scale.setScalar(sc);
  if (P.ang) {
    _a.set(0, 1, 0).addScaledVector(n, -n.y);
    if (_a.lengthSq() < 0.04) _a.set(1, 0, 0).addScaledVector(n, -n.x);
    mesh.quaternion.setFromAxisAngle(_a.normalize(), P.ang);
  } else mesh.quaternion.identity();
  mesh.position.copy(C).sub(_q.copy(C).multiplyScalar(sc).applyQuaternion(mesh.quaternion));
  if (P.sink) mesh.position.addScaledVector(n, -P.sink);
}

export const swapUniforms = () => ({ uSwapMode: { value: 0 }, uSwapT: { value: 0 }, uSwapNew: { value: 0 }, uSwapA: { value: 1 } });

// global scope of the tile fragment shader (before the noise helpers: these are self-contained)
export const SWAP_DECL = /* glsl */`
uniform float uSwapMode, uSwapT, uSwapNew, uSwapA;
float swHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float swNoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(swHash(i), swHash(i + vec2(1.0, 0.0)), f.x), mix(swHash(i + vec2(0.0, 1.0)), swHash(i + vec2(1.0, 1.0)), f.x), f.y); }
float swFbm(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * swNoise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; } return s / 0.9375; }
vec3 swVoronoi(vec2 x) { vec2 n = floor(x), f = fract(x); float f1 = 8.0, f2 = 8.0, id = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) { vec2 g = vec2(float(i), float(j)), r = g + vec2(swHash(n + g), swHash(n + g + 19.7)) - f; float d = dot(r, r);
    if (d < f1) { f2 = f1; f1 = d; id = swHash(n + g + 3.1); } else if (d < f2) f2 = d; }
  return vec3(sqrt(f1), sqrt(f2), id); }
float swSheen(vec2 sp, float sw) { return exp(-pow(sp.x + sp.y * 0.6 - mix(-1.8, 1.8, sw), 2.0) * 14.0) * step(0.001, sw) * (1.0 - sw); }
`;

// end of the SURFACE block: sp = plate coordinates (hexagon corners at radius ~1, the same on the side walls' rim),
// sd = 0 at the centre .. 1 at the rim (walls 1), layer = old / fresh tile
export const SWAP_GLSL = /* glsl */`
  vec3 swE0 = gEmit;
  if (uSwapMode > 1.5) {
    vec2 sp = (vPUv - 0.5) * 2.0;
    float sd = vSide > 0.5 ? 1.0 : 1.0 - vEdge, st = uSwapT, top = 1.0 - vSide;
    bool nw = uSwapNew > 0.5;
    vec3 hot = mix(uEnergy, vec3(1.0), 0.6);
    if (uSwapA < 0.999 && swHash(gl_FragCoord.xy) > uSwapA) discard;       // fading in / out (screen-door)
    if (uSwapMode < 4.5 && uSwapMode > 3.5) {                              // 4 Dissolve: burns away with glowing edges, the fresh one materialises in the core colour
      float nn = swFbm(sp * 2.2 + 4.0);
      if (!nw) {
        float b = (st - 0.1) / 1.1 * 1.25 - 0.1;
        if (nn < b) discard;
        float ed = (1.0 - smoothstep(0.0, 0.07, nn - b)) * step(-0.09, b);
        alb *= 1.0 - 0.8 * ed; gEmit = mix(gEmit, vec3(1.0, 0.5, 0.15) * 3.0, ed);
      } else {
        float f = (st - 1.1) / 1.2 * 1.25 - 0.1;
        if (nn > f) discard;
        gEmit += hot * 2.5 * (1.0 - smoothstep(0.0, 0.07, f - nn)) * (1.0 - smoothstep(0.95, 1.15, f));
      }
    } else if (uSwapMode < 3.5 && uSwapMode > 2.5) {                       // 3 Shatter: seams glow, shards shrink away; the fresh plate builds from the rim inward
      if (!nw) {
        vec3 vv = swVoronoi(sp * 3.2 + uSeed);
        float ss = clamp((st - 0.3 - vv.z * 0.3 - (1.0 - sd) * 0.12) / 0.55, 0.0, 1.0); ss *= ss;
        float cp = smoothstep(0.0, 0.3, st), crack = 1.0 - smoothstep(0.0, 0.05 + 0.1 * ss, vv.y - vv.x);
        if (vv.x > 1.25 * (1.0 - ss) || ss > 0.97) discard;
        gH -= crack * 0.25 * top; alb *= 1.0 - 0.75 * ss; gEmit *= 1.0 - 0.75 * ss;
        gEmit += vec3(1.0, 0.55, 0.2) * crack * cp * 2.5 * (1.0 - ss);
      } else {
        float rv = clamp((st - 1.3) / 1.1, 0.0, 1.0), front = 1.0 - rv * 1.08;
        if (sd < front) discard;
        gEmit += hot * 2.2 * (1.0 - smoothstep(0.0, 0.06, sd - front)) * (1.0 - rv * 0.4);
      }
    } else if (uSwapMode < 2.5) {                                           // 2 Polished: shockwave ring across the plate, sheen on the clean plate
      float rk = clamp((st - 0.6) / 0.7, 0.0, 1.0), rr = (1.0 - pow(1.0 - rk, 3.0)) * 1.15;
      gEmit += hot * exp(-pow((sd - rr) * 7.0, 2.0)) * (1.0 - rk) * step(0.001, rk) * (1.6 + 3.0 * groove) * top;
      gEmit += vec3(0.9) * swSheen(sp, clamp((st - 1.9) / 0.6, 0.0, 1.0)) * top;
    } else if (uSwapMode < 5.5) {                                           // 5 Card flip: sheen runs across the new face as it settles
      if (nw) gEmit += vec3(0.9) * swSheen(sp, clamp((st - 1.2) / 0.6, 0.0, 1.0)) * top;
    } else {                                                                // 6 Power down: flickers out and goes dark; the fresh tile comes up dark, the ring lights, then it brightens from the centre
      if (!nw) {
        float dk = smoothstep(0.25, 1.0, st), fk = st > 0.0 && st < 0.7 ? 0.2 + 0.8 * step(0.4, swHash(vec2(floor(st * 22.0), 1.0))) : 1.0;
        alb *= mix(1.0, 0.08, dk); gEmit *= (1.0 - dk) * fk; gRough = mix(gRough, 0.75, dk);
      } else {
        float br = clamp((st - 2.4) / 0.6, 0.0, 1.0), lit = 1.0 - smoothstep(br * 1.15 - 0.1, br * 1.15, sd);
        alb *= mix(0.08, 1.0, lit); gEmit *= lit; gRough = mix(0.75, gRough, lit);
        float ig = clamp((st - 2.05) / 0.5, 0.0, 1.0), ua = fract(atan(sp.x, sp.y) / 6.28318 + 1.0);
        gEmit += hot * groove * (step(ua, ig) * step(0.001, ig) * 1.4 + exp(-pow((ua - ig) * 30.0, 2.0)) * 3.0 * step(0.001, ig) * step(ig, 0.999)) * (1.0 - smoothstep(2.7, 3.3, st));
      }
    }
  }
  gEmit = swE0 + (gEmit - swE0) * mix(1.0, 0.18, uParked);   // parked tiles: a dim swap
`;
export const SWAP_POST = '';    // after shading (dithering_fragment): may change gl_FragColor
