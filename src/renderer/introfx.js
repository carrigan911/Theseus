// Start and close animations (Docs/Specs/StartupFx_Spec.md; the looks follow Docs/Previews/startup_previews.html).
// Kinds: worm (Wormhole), bh (Black hole), tp (Teleport), fly (Fly in / out), ftl (FTL jump), beam (Beam-in / out; TeleportFx_Spec), fall (Lightfall; Lightfall_Spec,
// its timeline in falltime.js, shared with the background window). introPose(kind, dir, p, ctx) is the timeline
// (p 0..1; dir 'in' = start, 'out' = close, which plays the start backwards with extras), in sphere radii:
//   x, z: where the sphere is; s, sx, sy: its size; ry, rz: its turn; core: the core's size (and flash above 1);
//   R, S, F, A: the backdrop (aperture radius, scan line height, flash, strength); rev(dir) -> [tile size 0..1, sink] or null;
//   y: height; glow: tile light; ftl: pin, pinX (the pinpoint), wisp; beam: lineY, lineDir, W (the pillar), holoOp, hy, band (the hologram).
// The backdrop is one premultiplied plane behind the sphere, so it can darken (the disc, the tunnel's throat) and add light.
// It is drawn first (opaque pass, order -3, no depth), so the sphere always covers it.
import * as THREE from '../../node_modules/three/build/three.module.js';
import './falltime.js';   // globalThis.FALL
const clamp = x => Math.max(0, Math.min(1, x));
const ease = x => 1 - Math.pow(1 - clamp(x), 3);
const easeIO = x => { x = clamp(x); return x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
const backOut = x => { x = clamp(x); const c = 1.9; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); };
const sstep = (a, b, x) => { x = clamp((x - a) / (b - a)); return x * x * (3 - 2 * x); };
const gauss = (x, w) => Math.exp(-(x / w) * (x / w));

export const KINDS = ['worm', 'bh', 'tp', 'fly', 'ftl', 'beam', 'fall'];
export const INTRO_LEN = 2.5, OUTRO_LEN = 1.5;
const K = 7 / 6;   // the preview's backdrop units (its plane sat 7/6 sphere radii per radius); the shader keeps its numbers

function inPose(k, p, ctx) {
  const P = { x: 0, y: 0, z: 0, s: 1, sx: 1, sy: 1, ry: 0, rz: 0, core: 1, A: 0, R: 0, S: 0, F: 0, rev: null, glow: 0, pin: 0, pinX: 0, wisp: 0, lineY: -9, lineDir: 1, W: 0, holoOp: -1, hy: 0, band: 0 };
  if (k === 'worm') {
    P.R = 1.6 * ease(sstep(0, .28, p)) * (1 - easeIO(sstep(.78, 1, p)));
    const e = ease(sstep(.18, .82, p));
    P.z = -16 * (1 - e); P.ry = (1 - e) * Math.PI * 3; P.rz = (1 - e) * .6; P.s = sstep(.1, .24, p);
    P.F = 1.2 * gauss(p - .8, .06); P.core = 1 + P.F;
  } else if (k === 'bh') {
    P.R = .62 * ease(sstep(0, .3, p)) * (1 - easeIO(sstep(.82, .98, p)));
    P.F = 1.4 * gauss(p - .86, .05);
    const q = sstep(.22, .8, p); P.s = backOut(q); P.ry = (1 - ease(q)) * Math.PI;
    P.rev = d => { const kk = (1 - d.z) / 2, v = sstep(.3 + kk * .35, .46 + kk * .35, p); return [v, .65 * (1 - v)]; };   // front first, out of the core
    P.core = P.s + P.F;
  } else if (k === 'tp') {
    P.A = sstep(0, .12, p) * (1 - sstep(.85, 1, p));
    const q = sstep(.12, .8, p), scan = 1.3 - 2.6 * q;
    P.S = scan; P.F = q > 0 && q < 1 ? 1 : 0;
    P.rev = d => [clamp((d.y - scan) / .22), 0];
    P.core = sstep(.35, .75, q);
  } else if (k === 'fly') {
    const X = ctx.halfW + 1.4, q = sstep(0, .72, p), w = Math.max(0, p - .66);
    P.x = ctx.sg * X * (1 - backOut(q));
    P.rz = -ctx.sg * .35 * (1 - ease(q)) + (p > .66 ? ctx.sg * .22 * Math.sin(w * 34) * Math.exp(-w * 14) : 0);
    P.ry = ctx.sg * (1 - ease(q)) * Math.PI * 2;
  } else if (k === 'ftl') {
    P.pinX = -ctx.sg * 1.7;                        // the pinpoint sits on the inner side, away from the screen edge
    P.pin = sstep(.06, .2, p) * (1 - sstep(.27, .3, p)) * (.6 + .4 * sstep(.18, .27, p));
    P.F = 1.7 * gauss(p - .29, .032) + .35 * gauss(p - .3, .1);
    const q = sstep(.27, .44, p), w = Math.max(0, p - .44);
    P.s = p > .27 ? 1 : 0; P.x = P.pinX * (1 - backOut(q));
    P.sx = 1 + 5 * (1 - ease(q)); P.sy = Math.max(.08, 1 - .85 * (1 - ease(q))) * (1 + .05 * Math.sin(w * 40) * Math.exp(-w * 12));
    P.wisp = sstep(.3, .36, p) * (1 - sstep(.55, .95, p));
    P.glow = 1.1 * gauss(p - .31, .05) + .15 * P.wisp; P.core = 1 + P.F;
  } else if (k === 'beam') {
    P.lineY = -9 + 18 * ease(sstep(0, .14, p));
    P.A = sstep(0, .03, p) * (1 - sstep(.62, .98, p));
    P.W = .012 + 1.3 * ease(sstep(.12, .32, p)) * (1 - .3 * sstep(.62, .98, p));
    P.F = .55 * gauss(p - .3, .06);
    const hop = sstep(.26, .45, p);
    P.s = hop > 0 ? .94 + .06 * ease(hop) : 0;
    P.hy = -1.25 + 2.5 * sstep(.5, .9, p);          // the tiles below this height (sphere radii) are solid, above it hologram
    P.holoOp = hop; P.band = sstep(.5, .55, p) * (1 - sstep(.86, .92, p)) * 1.6;
    P.core = clamp((P.hy + 1.25) / 2.5);
    if (p >= 1) P.holoOp = -1;                     // done: the plain tiles
  }
  return P;
}
export function introPose(k, dir, p, ctx) {
  if (k === 'fall') {   // its own close (a mirror, not the start backwards); the sphere is there or not, no growing
    const P = inPose('', 0, ctx), L = globalThis.FALL.pose(dir, p);
    Object.assign(P, { lineY: L.lineY, A: L.A, W: L.W, F: L.F, s: L.s, warp: L.warp, rumble: L.rumble, kick: L.kick, streak: ctx.streak ? 1 : 0 });
    P.core = 1 + L.F; P.glow = .9 * L.F * L.s;
    return P;
  }
  if (dir === 'in') return inPose(k, p, ctx);
  const P = inPose(k, 1 - p, ctx);
  if (k === 'bh') { const s = sstep(.2, .85, p); P.sy *= 1 + 1.3 * s; P.sx *= 1 - .55 * s; P.rz += p * p * 6; P.F += 1.6 * gauss(p - .95, .035); }
  if (k === 'ftl') { P.sx *= 1 - .12 * gauss(p - .6, .05); P.sy *= 1 + .1 * gauss(p - .6, .05); P.pin += 1.1 * gauss(p - .9, .014); }   // a gather before the stretch; the pinpoint winks
  if (k === 'beam') {   // the hologram is pulled up into the pillar; the line goes up, not down
    const u = sstep(.4, .85, p); P.y = 2.2 * u * u; P.sy *= 1 + 1.4 * u; P.sx *= 1 - .45 * u; P.holoOp = p > 0 ? P.holoOp * (1 - sstep(.6, .85, p)) : -1;
    P.lineY = -P.lineY; P.lineDir = -1;
  }
  return P;
}

const VS = 'varying vec2 vP; void main(){ vP = (modelMatrix * vec4(position, 1.0)).xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
const FS = `
uniform float uKind, uA, uR, uS, uF, uTime, uDirX, uLen, uU, uPin, uW, uWisp, uWarp, uStreak; uniform vec2 uC, uP; varying vec2 vP;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main(){
  vec2 d = (vP - uC) / uU; float r = length(d); float a = atan(d.y, d.x);
  vec3 add = vec3(0.0); float dark = 0.0;
  if (uKind < 0.5) {                       // wormhole
    float on = smoothstep(0.0, 0.03, uR); float x = r / max(uR, 1e-4);
    float inside = 1.0 - smoothstep(0.92, 1.02, x);
    float depth = 1.0 / max(x, 0.03);
    float arms = pow(0.5 + 0.5 * sin((a + depth * 0.7 - uTime * 1.3) * 4.0), 3.0);
    float rings = pow(0.5 + 0.5 * sin(depth * 3.0 - uTime * 7.0), 8.0);
    vec3 c = mix(vec3(0.34, 0.2, 0.95), vec3(0.25, 0.75, 1.0), arms);
    vec3 tun = c * (0.12 + 0.8 * arms + 0.6 * rings) * smoothstep(0.04, 0.6, x);
    float rim = exp(-pow((x - 1.0) * 9.0, 2.0));
    float halo = step(1.0, x) * exp(-(x - 1.0) * 3.0) * 0.35;
    add = (tun * inside + vec3(0.6, 0.68, 1.0) * rim * 1.5 + vec3(0.3, 0.35, 1.0) * halo) * on;
    dark = inside * 0.92 * on;
    add += vec3(0.75, 0.8, 1.0) * uF * exp(-r * 1.8);
  } else if (uKind < 1.5) {                // black hole
    float on = smoothstep(0.0, 0.03, uR); float x = r / max(uR, 1e-4);
    float disc = 1.0 - smoothstep(0.96, 1.0, x);
    float ring = exp(-pow((x - 1.07) * 16.0, 2.0)) * 1.6 + step(1.0, x) * exp(-(x - 1.0) * 4.0) * 0.25;
    vec2 e = d / max(uR, 1e-4); float er = length(vec2(e.x, e.y / 0.26));
    float band = smoothstep(1.2, 1.5, er) * (1.0 - smoothstep(1.9, 2.9, er));
    band *= (0.6 + 0.4 * sin(atan(e.y / 0.26, e.x) * 9.0 - uTime * 4.0 + er * 3.0)) * (1.0 + 0.7 * clamp(e.x / max(er, 1e-3), -1.0, 1.0));
    add = (vec3(1.0, 0.82, 0.6) * ring + vec3(1.0, 0.5, 0.18) * band * 1.2) * on * (1.0 - disc);
    dark = disc * on;
    add += vec3(1.0, 0.85, 0.7) * uF * exp(-r * 1.6);
  } else if (uKind < 2.5) {                // teleport
    float bx = abs(d.x); float vf = 1.0 - smoothstep(2.0, 3.2, abs(d.y));
    float beam = exp(-pow(bx / 1.3, 4.0)) * vf, core = exp(-pow(bx / 0.07, 2.0)) * vf;
    float scan = exp(-pow((d.y - uS) * 28.0, 2.0)) * (1.0 - smoothstep(1.2, 1.5, bx));
    float spark = step(0.986, hash(floor(d * 46.0) + floor(uTime * 14.0))) * beam;
    add = (vec3(0.25, 0.8, 1.0) * (beam * 0.22 + core * 0.5 + spark * 1.2) + vec3(0.8, 1.0, 1.0) * scan * 1.8 * uF) * uA;
  } else if (uKind < 3.5) {                // fly: a trail behind the sphere
    float bx = d.x * uDirX;
    float rnd = hash(vec2(floor(d.y * 16.0), 3.0));
    float tail = step(0.0, bx) * exp(-bx / max(uLen, 0.01)) * exp(-d.y * d.y);
    add = vec3(0.45, 0.7, 1.0) * tail * (0.25 + step(0.45, rnd) * (0.5 + 0.5 * rnd) * 0.9) * uA;
  } else if (uKind < 4.5) {                // ftl jump: pinpoint, sideways streak flash, electric wisps off the rim
    vec2 q = d - uP;                       // (each part only where it can show: the software renderer pays per pixel)
    float pin = 0.0;
    if (uPin > 0.001 && abs(q.y) < 0.12) pin = uPin * (0.8 + 0.2 * sin(uTime * 37.0)) * (exp(-dot(q, q) / 0.0016) * 2.2 + exp(-abs(q.y) / 0.01) * exp(-abs(q.x) / (0.25 + 0.3 * uPin)) * 0.7 + exp(-abs(q.x) / 0.008) * exp(-abs(q.y) / 0.08) * 0.25);
    add = vec3(0.72, 0.86, 1.0) * pin;
    if (uF > 0.004) {
      vec2 s = d - uP * 0.35;
      float streak = exp(-abs(s.y) / (0.02 + 0.13 * uF)) * exp(-abs(s.x) / (0.7 + 3.2 * uF));
      float bloom = exp(-length(s * vec2(0.4, 1.0)) * 1.5);
      add += (vec3(0.88, 0.95, 1.0) * streak * 1.5 + vec3(0.5, 0.72, 1.0) * bloom * 0.45) * uF;
    }
    float x = r / max(uR, 1e-4);
    if (uWisp > 0.001 && x > 0.9 && x < 2.0) {
    float trail = 0.25 + 0.75 * clamp(d.x * uDirX / max(r, 1e-3) + 0.3, 0.0, 1.0);
    float flick = step(0.35, hash(vec2(floor(uTime * 18.0), floor(a * 3.0))));
    float w1 = abs(sin(a * 6.0 + (x - 1.0) * 7.0 * uDirX * sign(d.y + 1e-4) + uTime * 2.3 + 2.2 * sin(a * 13.0 - uTime * 5.0)));
    float w2 = abs(sin(a * 9.0 - (x - 1.0) * 5.0 + uTime * 3.1 + 1.7 * sin(a * 17.0 + uTime * 7.0)));
    float fil = (pow(1.0 - w1, 22.0) + 0.6 * pow(1.0 - w2, 26.0)) * smoothstep(0.92, 1.02, x) * exp(-(x - 1.0) * 5.5) * step(0.4, hash(vec2(floor(a * 14.0), floor(uTime * 9.0))));
    add += vec3(0.35, 0.65, 1.0) * fil * trail * (0.5 + flick) * 2.2 * uWisp;
    add += vec3(0.3, 0.55, 1.0) * exp(-pow((x - 1.0) * 6.0, 2.0)) * 0.35 * uWisp;
    }
  } else if (uKind < 5.5) {                // beam: a line rises from below and swells into a pillar
    float bx = abs(d.x), w = max(uW, 0.012);
    if (bx < w * 2.2 + 0.12) {
    float yIn = uDirX > 0.0 ? 1.0 - smoothstep(uS - 0.05, uS + 0.05, d.y) : smoothstep(uS - 0.05, uS + 0.05, d.y);
    float b1 = bx / w, b2 = (bx - w * 0.92) / (0.03 + 0.05 * w), b3 = bx / (0.015 + 0.12 * w);
    float body = exp(-b1 * b1), edge = exp(-b2 * b2) * smoothstep(0.08, 0.3, w), core = exp(-b3 * b3);
    float rise = 0.5 + 0.5 * sin(d.y * 7.0 - uTime * 16.0 + hash(vec2(floor(d.x * 18.0), 1.0)) * 6.28);
    float spark = step(0.988, hash(floor(d * 40.0) + floor(uTime * 16.0))) * body;
    vec2 h = vec2(bx, d.y - uS) * vec2(1.0, 0.35); float tip = dot(h, h) < 0.06 && abs(uS) < 8.5 ? exp(-dot(h, h) / 0.01) : 0.0;
    add = (vec3(0.28, 0.58, 1.0) * body * (0.3 + 0.25 * rise) + vec3(0.88, 0.96, 1.0) * core * 1.3 + vec3(0.55, 0.82, 1.0) * edge * 0.6 + vec3(0.7, 0.9, 1.0) * spark) * yIn * uA;
    add += vec3(0.85, 0.95, 1.0) * tip * 2.0 * uA;
    }
    if (uF > 0.004) add += vec3(0.75, 0.88, 1.0) * uF * exp(-r * 1.3);
  } else {                                 // lightfall: one beam falls from the top; space (or, with no space behind, light) runs into it
    float bx = abs(d.x), w = max(uW, 0.01);
    if (bx < w * 14.0 + 0.1) {
      float yIn = smoothstep(uS - 0.08, uS + 0.08, d.y);
      float b1 = bx / w, b2 = bx / (w * 5.0 + 0.04);
      float flick = 0.9 + 0.1 * sin(uTime * 53.0 + d.y * 2.0);
      vec2 h = vec2(bx * 2.5, d.y - uS); float tip = abs(uS) < 8.5 ? exp(-dot(h, h) / 0.02) : 0.0;
      add = (vec3(0.94, 0.98, 1.0) * exp(-b1 * b1) * 1.6 + vec3(0.3, 0.62, 1.0) * exp(-b2 * b2) * 0.5) * yIn * flick * uA + vec3(0.85, 0.95, 1.0) * tip * 2.0 * uA;
    }
    float wp = clamp(uWarp, 0.0, 1.0);
    if (uStreak > 0.5 && wp > 0.01 && bx < 7.0) {   // light streaks in rows, running sideways into the beam
      float row = floor(d.y * 12.0), hr = hash(vec2(row, 7.0)), fy = (fract(d.y * 12.0) - 0.5) / 0.09;
      float u = (1.0 - fract(uTime * (0.9 + 1.6 * hr) + hr * 7.0)) * 6.0, L = 0.4 + 1.6 * wp;
      float seg = step(u, bx) * (1.0 - smoothstep(u, u + L, bx)) * step(0.45, hr);
      add += vec3(0.45, 0.75, 1.0) * seg * exp(-fy * fy) * wp * (0.5 + 0.8 * exp(-bx * 0.6));
    }
    if (uF > 0.004) add += (vec3(0.85, 0.93, 1.0) * exp(-r * 1.2) + vec3(0.7, 0.88, 1.0) * exp(-bx / 0.12) * 0.8) * uF;
  }
  add = min(add, vec3(1.0)); if (max(add.r, max(add.g, add.b)) < 0.012) add = vec3(0.0);   // no faint veil over the whole window
  gl_FragColor = vec4(add, max(dark, max(add.r, max(add.g, add.b))));   // light keeps its own alpha: a transparent window drops colour at alpha 0
}`;

// the backdrop plane, at world depth z; drive() places and feeds it each frame
export function createBackdrop(z) {
  const U = { uKind: { value: 0 }, uA: { value: 0 }, uR: { value: 0 }, uS: { value: 0 }, uF: { value: 0 }, uTime: { value: 0 }, uDirX: { value: 1 }, uLen: { value: 1 }, uU: { value: 1 }, uC: { value: new THREE.Vector2() },
    uP: { value: new THREE.Vector2() }, uPin: { value: 0 }, uW: { value: 0 }, uWisp: { value: 0 }, uWarp: { value: 0 }, uStreak: { value: 0 } };
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.ShaderMaterial({ uniforms: U, vertexShader: VS, fragmentShader: FS,
    depthTest: false, depthWrite: false, transparent: false,   // in the opaque pass with the lowest order: drawn before the sphere
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendEquation: THREE.AddEquation }));
  mesh.position.z = z; mesh.renderOrder = -3; mesh.frustumCulled = false; mesh.visible = false;
  // P: the pose; unit: one sphere radius in world units; camZ: the camera's distance; trail: { v } the fly speed (radii/s)
  function drive(k, P, unit, camZ, t, trail) {
    const f = (camZ - z) / (camZ - P.z * unit);               // the sphere's centre as seen on the plane
    U.uKind.value = KINDS.indexOf(k); U.uTime.value = t; U.uU.value = unit * (camZ - z) / camZ / K;
    U.uR.value = P.R * K; U.uS.value = P.S * K; U.uF.value = P.F; U.uA.value = P.A;
    U.uC.value.set(P.x * unit * f, 0);
    if (k === 'fly' && trail) { const v = trail.v; U.uA.value = clamp(Math.abs(v) / 12); U.uDirX.value = v >= 0 ? -1 : 1; U.uLen.value = .3 + clamp(Math.abs(v) / 10) * 2.6; }
    if (k === 'ftl') { U.uP.value.set((P.pinX - P.x) * K, 0); U.uPin.value = P.pin; U.uWisp.value = P.wisp; U.uR.value = 1.06 * P.s * K; U.uDirX.value = Math.sign(P.pinX) || 1; }
    if (k === 'beam') { U.uS.value = P.lineY; U.uDirX.value = P.lineDir; U.uW.value = P.W; }
    if (k === 'fall') { U.uS.value = P.lineY; U.uW.value = P.W; U.uWarp.value = P.warp; U.uStreak.value = P.streak; }
    mesh.visible = true;
  }
  return { mesh, drive, hide: () => { mesh.visible = false; } };
}
