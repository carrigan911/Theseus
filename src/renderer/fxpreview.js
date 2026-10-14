// Settings: the start / close animation preview (Docs/Specs/FxPreview_Spec.md). A small sphere of real tiles plays the chosen
// start animation, holds, plays the chosen close animation and loops, on the sphere's own timeline (introfx.js). One small
// renderer, about 30 fps, nothing while the window is hidden; stop() frees it. This page has its own panel.js, so HOLO / IGLOW
// here never touch the sphere's.
import * as THREE from '../../node_modules/three/build/three.module.js';
import { makePanelMaterial, setPanelState, setPanelWear, GLOW, ENERGY, TIME, SPREAD, HOLO, IGLOW } from './panel.js';
import { swapMesh } from './swapfx.js';
import { cellSet, tileGeometry } from './sphere.js';
import { introPose, createBackdrop, KINDS, INTRO_LEN, OUTRO_LEN } from './introfx.js';

const HOLD = 0.8, EMPTY = 0.8, CAMZ = 10;
const NAMES = { worm: 'Wormhole', bh: 'Black hole', tp: 'Teleport', fly: 'Fly', ftl: 'FTL jump', beam: 'Beam', fall: 'Lightfall' };

function rig(canvas, w, h, glowHex, wear) {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1)); renderer.setSize(w, h, false); renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(30, w / h, 0.1, 60); camera.position.set(0, 0, CAMZ);
  // the sphere's small studio, so the steel reflects the same way
  const envScene = new THREE.Scene(); envScene.background = new THREE.Color(0x1a1d22);
  for (const [x, y, z, bw, bh, i] of [[0, 5, 2, 8, 1, 6], [-6, 1, 2, 1, 5, 4], [6, 0, 3, 1, 4, 3], [0, -4, 3, 7, 1, 1.5]]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, 0.2), new THREE.MeshBasicMaterial({ color: new THREE.Color(i, i, i) })); m.position.set(x, y, z); envScene.add(m);
  }
  const pmrem = new THREE.PMREMGenerator(renderer); scene.environment = pmrem.fromScene(envScene, 0.04).texture; pmrem.dispose();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x333344, 0.6));
  const sun = new THREE.DirectionalLight(0xffffff, 2); sun.position.set(2, 3, 4); scene.add(sun);
  const c = new THREE.Color(glowHex); ENERGY.value.copy(c); GLOW.value.copy(c).multiplyScalar(0.6 * 0.3); SPREAD.value = 0; setPanelWear(wear | 0);
  const backdrop = createBackdrop(-2.5); scene.add(backdrop.mesh);
  // the sphere: root (pose) > spin (a slow idle turn) > tiles and core
  const root = new THREE.Group(), spin = new THREE.Group(); root.add(spin); scene.add(root);
  const coreLight = new THREE.PointLight(c, 1.2, 0, 0); spin.add(coreLight);
  const core = new THREE.Mesh(new THREE.SphereGeometry(0.62, 32, 16), new THREE.MeshBasicMaterial({ color: c.clone().multiplyScalar(0.55) })); spin.add(core);
  const gc = document.createElement('canvas'); gc.width = gc.height = 64;
  { const x = gc.getContext('2d'), g = x.createRadialGradient(32, 32, 0, 32, 32, 32); g.addColorStop(0, `rgba(${c.r * 255 | 0},${c.g * 255 | 0},${c.b * 255 | 0},1)`); g.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = g; x.fillRect(0, 0, 64, 64); }
  const glowTex = new THREE.CanvasTexture(gc), glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  glow.scale.setScalar(2.6); spin.add(glow);
  const tiles = cellSet(42).map((cell, i) => {
    const geo = tileGeometry(cell), mat = makePanelMaterial(i * 1.7), mesh = new THREE.Mesh(geo, mat), C = geo.userData.cc.clone();
    setPanelState(mat, { pct: 0.15 + 0.5 * ((i * 37) % 11) / 10 }); mesh.frustumCulled = false; spin.add(mesh);
    return { mesh, geo, mat, C, n: C.clone().normalize() };
  });
  const tmp = new THREE.Vector3(), halfH = CAMZ * Math.tan(THREE.MathUtils.degToRad(15)), unit = halfH / 2.5;   // the sphere fills ~40 % of the height
  // one frame: kind k in direction dir at p (null = the sphere at rest), t = seconds
  function draw(k, dir, p, t, dt) {
    spin.rotation.y += dt * 0.25;
    const P = k ? introPose(k, dir, p, { sg: 1, halfW: halfH * camera.aspect / unit, streak: true }) : null;   // (no space here: Lightfall's light streaks)
    root.visible = !P || P.s > 0.002;
    if (P) {
      root.position.set(P.x * unit, P.y * unit, P.z * unit);
      root.scale.set(unit * Math.max(1e-4, P.s * P.sx), unit * Math.max(1e-4, P.s * P.sy), unit * Math.max(1e-4, P.s));
      root.rotation.set(0, P.ry, P.rz);
      const ys = unit * P.s * P.sy;
      HOLO.value.set(P.holoOp >= 0 ? P.holoOp : -1, P.y * unit + P.hy * ys, P.holoOp >= 0 ? Math.max(1e-3, 0.12 * ys) : 1, P.holoOp >= 0 ? P.band : 0);
      IGLOW.value = P.glow || 0;
      let trail = null;
      if (k === 'fly') { const e = 0.004, P2 = introPose(k, dir, Math.min(1, p + e), { sg: 1, halfW: halfH * camera.aspect / unit }); trail = { v: (P2.x - P.x) / (e * (dir === 'out' ? OUTRO_LEN : INTRO_LEN)) }; }
      backdrop.drive(k, P, unit, CAMZ, t, trail);
      const sh = k === 'fall' ? FALL.shake(t, P) : [0, 0], px = 2 * halfH / screen.height;   // Lightfall's shake, as big against the picture as on the screen
      camera.position.x = -sh[0] * px; camera.position.y = sh[1] * px;
    } else { root.position.set(0, 0, 0); root.scale.setScalar(unit); root.rotation.set(0, 0, 0); HOLO.value.set(-1, 0, 1, 0); IGLOW.value = 0; backdrop.hide(); camera.position.x = camera.position.y = 0; }
    const k2 = P ? Math.max(1e-4, Math.min(1, P.core)) : 1;
    core.scale.setScalar(k2); glow.material.opacity = 0.5 * Math.min(2.5, P ? P.core : 1); coreLight.intensity = 1.2 * Math.min(2, P ? P.core : 1);
    for (const tl of tiles) {
      let sc = 1, sink = 0;
      if (P && P.rev) { const iv = P.rev(tmp.copy(tl.n).applyQuaternion(spin.quaternion)); sc = iv[0]; sink = iv[1] || 0; }
      swapMesh(tl.mesh, { ang: 0, sink }, sc, tl.C, tl.n);
    }
    TIME.value = performance.now() / 1000; renderer.render(scene, camera);
  }
  function dispose() {
    for (const tl of tiles) { tl.geo.dispose(); tl.mat.dispose(); }
    glowTex.dispose(); scene.environment?.dispose(); renderer.dispose(); renderer.forceContextLoss();
  }
  function hide() { root.visible = false; backdrop.hide(); HOLO.value.set(-1, 0, 1, 0); IGLOW.value = 0; renderer.render(scene, camera); }
  return { draw, hide, dispose };
}

// set({ on, startFx, closeFx, glow, wear }): loops start, hold, close, empty. 'random' shows each kind in turn, 'off' skips
// that half. play(dir): that animation once, from its start, then the loop goes on. label(text): what is playing (or null).
export function startFxPreview(host, label = () => {}) {
  let r = null, raf = 0, last = 0, t0 = 0, cur = { on: false, startFx: 'off', closeFx: 'off', glow: '#3da5ff', wear: 0 }, key = '', turn = 0, only = null;
  const kindOf = (v, n) => v === 'random' ? KINDS[n % KINDS.length] : KINDS.includes(v) ? v : null;
  // the loop's parts for this turn: [kind, dir, length] (kind null: the sphere at rest, or nothing)
  function parts() {
    const a = kindOf(cur.startFx, turn), b = kindOf(cur.closeFx, turn + 3);
    if (only) return only === 'in' ? [[a, 'in', INTRO_LEN], [null, 'rest', HOLD * 2]] : [[null, 'rest', HOLD], [b, 'out', OUTRO_LEN], [null, 'gone', EMPTY]];
    return [[a, 'in', a ? INTRO_LEN : 0], [null, 'rest', HOLD], [b, 'out', b ? OUTRO_LEN : 0], [null, b ? 'gone' : 'rest', b ? EMPTY : 0]].filter(x => x[2] > 0);
  }
  let seq = [], lastName = '';
  function frame(now) {
    if (!r) return;
    raf = requestAnimationFrame(frame);
    if (document.hidden || now - last < 30) return;                       // about 30 fps, nothing while the window is hidden
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0; last = now;
    let e = (now - t0) / 1000, i = 0;
    while (i < seq.length && e >= seq[i][2]) e -= seq[i++][2];
    if (i >= seq.length) { turn++; only = null; seq = parts(); t0 = now; i = 0; e = 0; }
    const [k, dir, len] = seq[i] || [null, 'rest', 1];
    const name = k ? `${NAMES[k]} · ${dir === 'in' ? 'start' : 'close'}` : '';
    if (name !== lastName) { lastName = name; label(name || null); }
    if (dir === 'gone') { r.hide(); return; }   // the gap after a close: nothing on screen
    r.draw(k, dir, k ? Math.min(1, e / len) : 1, now / 1000, dt);
  }
  function stop() { cancelAnimationFrame(raf); r?.dispose(); r = null; key = ''; host.replaceChildren(); label(null); }
  function restart() { seq = parts(); t0 = performance.now(); lastName = '~'; }
  return {
    set(next) {
      const was = cur; cur = { ...cur, ...next };
      if (!cur.on) { stop(); return; }
      const k = [cur.wear, cur.glow, host.clientWidth, host.clientHeight].join('|');
      if (k !== key || !r) {                                              // a new wear (the shader recompiles) / colour / size
        r?.dispose(); r = null; cancelAnimationFrame(raf); key = k;
        const cv = document.createElement('canvas'); cv.style.cssText = 'width:100%;height:100%;display:block'; host.replaceChildren(cv);
        r = rig(cv, host.clientWidth || 300, host.clientHeight || 220, cur.glow, cur.wear); last = 0; restart(); raf = requestAnimationFrame(frame);
      } else if (cur.startFx !== was.startFx || cur.closeFx !== was.closeFx) { only = null; restart(); }
    },
    play(dir) { if (!r) return; only = dir === 'out' ? 'out' : 'in'; restart(); },
    stop,
  };
}
