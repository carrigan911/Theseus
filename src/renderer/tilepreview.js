// Tile previews for the settings window (Theseus > Tiles): real tiles (the sphere's own material and swap timeline, swapfx.js) in
// one small three.js renderer. makeThumbs draws the six swap pictures once and frees the renderer; startPreview loops the wear
// sweep and / or the chosen swap (two tiles side by side when both are on) until stopped. Nothing here runs unless asked for.
import * as THREE from '../../node_modules/three/build/three.module.js';
import { makePanelMaterial, setPanelState, setPanelWear, SHADER_VER, GLOW, ENERGY, TIME, SPREAD } from './panel.js';
import { swapDrive, swapMesh, SWAP_LEN, SWAP_THUMB_T, SWAP_GLSL } from './swapfx.js';
const SWAP_GLSL_VER = SWAP_GLSL.length.toString(36);
import { tileGeometry, cellSet, labelTexture } from './sphere.js';

const OLD_PCT = 0.6, NEW_PCT = 0.03;   // the swap tile wears the chosen style at about 60 %; the fresh tile starts clean
const OLD = { title: 'Hand solver', model: 'Sonnet 5.5', effort: 'high' }, NEW = { title: 'Hand solver', model: 'Sonnet 5.5', effort: 'fresh' };
const WEAR_SECONDS = 8;                 // 0 -> 100 % -> 0

// count: 1 or 2 tiles side by side (the first shows the wear sweep, the second the swap; with count 1 the lone tile is centred)
function rig(canvas, w, h, glowHex, count) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(dpr); renderer.setSize(w, h, false); renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(30, w / h, 0.05, 20);
  // the same small studio as the sphere's, so the steel reflects the same way
  const envScene = new THREE.Scene(); envScene.background = new THREE.Color(0x1a1d22);
  for (const [x, y, z, bw, bh, i] of [[0, 5, 2, 8, 1, 6], [-6, 1, 2, 1, 5, 4], [6, 0, 3, 1, 4, 3], [0, -4, 3, 7, 1, 1.5]]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, 0.2), new THREE.MeshBasicMaterial({ color: new THREE.Color(i, i, i) })); m.position.set(x, y, z); envScene.add(m);
  }
  const pmrem = new THREE.PMREMGenerator(renderer); scene.environment = pmrem.fromScene(envScene, 0.04).texture; pmrem.dispose();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x333344, 0.6));
  const sun = new THREE.DirectionalLight(0xffffff, 2); sun.position.set(2, 3, 4); scene.add(sun);
  const c = new THREE.Color(glowHex); ENERGY.value.copy(c); GLOW.value.copy(c).multiplyScalar(0.6 * 0.3); SPREAD.value = 0;
  scene.add(new THREE.PointLight(c, 1.2, 0, 0));                       // the core
  // one hexagon cell, facing the camera
  const cells = cellSet(42), cell = cells.filter(x => x.poly.length === 6).reduce((b, x) => (x.c.z > b.c.z ? x : b));
  const geo = tileGeometry(cell), d = geo.userData, C = d.cc.clone(), n = C.clone().normalize();
  const labels = { old: labelTexture(OLD, 512), neu: labelTexture(NEW, 512) };
  const tiles = [...Array(count)].map(() => {
    const mat = makePanelMaterial(3.7), mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false; scene.add(mesh); setPanelState(mat, { pct: OLD_PCT });
    mat.userData.u.uLabel.value = labels.old; mat.userData.u.uHasLabel.value = 1;
    return { mat, mesh, u: mat.userData.u };
  });
  const sep = d.circR * 1.25, tan = Math.tan(THREE.MathUtils.degToRad(15));
  const halfH = Math.max(d.circR * 1.2, ((count > 1 ? sep : 0) + d.circR * 1.2) / (w / h));
  camera.position.copy(C).addScaledVector(n, halfH / tan); camera.lookAt(C);
  const level = (u, p) => { u.uLevel.value = p; u.uHeat.value = Math.max(0, Math.min(1, (p - 0.9) / 0.1)); };
  const place = (i, P, sc) => { const t = tiles[i]; swapMesh(t.mesh, P, sc, C, n); if (count > 1) t.mesh.position.x += (i ? sep : -sep); };
  // wear sweep: tile i at p (0..1)
  function wear(i, p) { const t = tiles[i]; swapDrive(t.u, 0, 0); level(t.u, p); t.u.uLabel.value = labels.old; t.u.uHasLabel.value = 1; place(i, { ang: 0, sink: 0 }, 1); }
  // swap: tile i; mode 0 / e < 0: the old tile at rest; e >= length: the fresh one at rest; else the swap at e seconds
  function swap(i, mode, e) {
    const t = tiles[i], len = SWAP_LEN[mode] || 0;
    if (!mode || e < 0 || e >= len) {
      const fresh = mode && e >= len;
      swapDrive(t.u, 0, 0); level(t.u, fresh ? NEW_PCT : OLD_PCT); t.u.uLabel.value = fresh ? labels.neu : labels.old; t.u.uHasLabel.value = 1;
      place(i, { ang: 0, sink: 0 }, 1);
    } else {
      const P = swapDrive(t.u, mode, e);
      level(t.u, P.layer ? NEW_PCT : OLD_PCT); t.u.uLabel.value = P.layer ? labels.neu : labels.old; t.u.uHasLabel.value = P.labelK;
      place(i, P, P.sc);
    }
  }
  const render = () => { TIME.value = performance.now() / 1000; renderer.render(scene, camera); };
  function dispose() {
    labels.old.dispose(); labels.neu.dispose(); geo.dispose(); for (const t of tiles) t.mat.dispose(); scene.environment?.dispose(); renderer.dispose(); renderer.forceContextLoss();
  }
  const compile = () => renderer.compileAsync ? renderer.compileAsync(scene, camera) : Promise.resolve();   // parallel compile where the GPU allows
  return { wear, swap, render, dispose, compile };
}

// pictures are kept in localStorage (one set per kind) until the colour, wear or the shaders change. A cold draw makes one
// picture per animation frame (shaders compiled async where the GPU allows) and hands each over as it is done, so the card
// stays usable. onEach(id, dataURL) is called for every picture, at once for a cached set.
const nextFrame = () => new Promise(r => requestAnimationFrame(() => r()));
let queue = Promise.resolve();   // one picture set at a time: they share the wear setting
const serial = f => { const p = queue.then(f); queue = p.catch(() => { }); return p; };
async function cached(kind, key, make, onEach) {
  key = key + '|' + SHADER_VER + '|' + (SWAP_GLSL_VER);
  try { const c = JSON.parse(localStorage.getItem('tp:' + kind) || 'null'); if (c && c.key === key) { for (const k in c.data) onEach(k, c.data[k]); return c.data; } } catch {}
  const data = await serial(() => make(onEach));
  try { localStorage.setItem('tp:' + kind, JSON.stringify({ key, data })); } catch {}
  return data;
}
// the six swap pictures at their most telling moment; the renderer is gone again afterwards
export function makeThumbs(wear, glowHex, onEach, w = 150, h = 130) { return cached('swap', [wear, glowHex, w, h].join(), e => drawThumbs(wear, glowHex, w, h, e), onEach); }
async function drawThumbs(wear, glowHex, w, h, onEach) {
  setPanelWear(wear | 0);
  const cv = document.createElement('canvas'), r = rig(cv, w, h, glowHex, 1), out = {};
  try {
    await r.compile();
    for (const m of [1, 2, 3, 4, 5, 6]) { await nextFrame(); setPanelWear(wear | 0); r.swap(0, m, SWAP_THUMB_T[m]); r.render(); onEach(m, out[m] = cv.toDataURL('image/png')); }
  } finally { r.dispose(); }
  return out;
}

// the 13 wear pictures, one tile each at `pct` (most styles show clearly by then); ends on `wear` again
export function makeWearThumbs(wear, glowHex, onEach, w = 150, h = 130, pct = 0.8) { return cached('wear', [glowHex, w, h, pct].join(), e => drawWearThumbs(wear, glowHex, w, h, pct, e), onEach); }
async function drawWearThumbs(wear, glowHex, w, h, pct, onEach) {
  const cv = document.createElement('canvas'), r = rig(cv, w, h, glowHex, 1), out = {};
  try {
    for (let k = 0; k <= 12; k++) { await nextFrame(); setPanelWear(k); r.wear(0, pct); await r.compile(); r.render(); onEach(k, out[k] = cv.toDataURL('image/png')); }
  } finally { setPanelWear(wear | 0); r.dispose(); }
  return out;
}

// One renderer for both previews. set({ wearOn, swapOn, mode, wear, glow }): the wear tile sweeps 0 -> 100 % -> 0 over 8 s with the chosen
// wear; the swap tile loops 0.8 s old tile, the swap, 1.2 s fresh tile. Both off: no renderer at all. stop() frees everything.
export function startPreview(host) {   // host: a sized element; each set of tiles gets a fresh canvas (a lost context cannot be reused)
  let r = null, raf = 0, last = 0, t0 = performance.now(), cur = { wearOn: false, swapOn: false, mode: 6, wear: 0, glow: '#3da5ff' }, key = '';
  const HOLD0 = 0.8, HOLD1 = 1.2;
  function frame(now) {
    if (!r) return;
    raf = requestAnimationFrame(frame);
    if (document.hidden || now - last < 30) return;                      // about 30 fps, nothing while the window is hidden
    last = now;
    const el = (now - t0) / 1000;
    let i = 0;
    if (cur.wearOn) { const f = (el / WEAR_SECONDS) % 1; r.wear(i++, 1 - Math.abs(2 * f - 1)); }
    if (cur.swapOn) { const len = SWAP_LEN[cur.mode] || 2.2; r.swap(i, cur.mode, el % (HOLD0 + len + HOLD1) - HOLD0); }
    r.render();
  }
  function stop() { cancelAnimationFrame(raf); r?.dispose(); r = null; key = ''; host.replaceChildren(); }
  return {
    set(next) {
      const prevMode = cur.mode; cur = { ...cur, ...next };
      const count = (cur.wearOn ? 1 : 0) + (cur.swapOn ? 1 : 0);
      if (!count) { stop(); return; }
      const k = [count, cur.wear, cur.glow, host.clientWidth, host.clientHeight].join('|');
      if (k !== key || !r) {                                              // a new set of tiles / wear (the shader recompiles) / colour / size
        r?.dispose(); r = null; host.replaceChildren(); cancelAnimationFrame(raf); key = k; setPanelWear(cur.wear | 0);   // (a failed rig is tried again next time)
        const cv = document.createElement('canvas'); cv.style.cssText = 'width:100%;height:100%;display:block'; host.replaceChildren(cv);
        r = rig(cv, host.clientWidth || 300, host.clientHeight || 190, cur.glow, count); t0 = performance.now(); raf = requestAnimationFrame(frame);
      } else if (cur.mode !== prevMode) t0 = performance.now();
    },
    stop,
  };
}
