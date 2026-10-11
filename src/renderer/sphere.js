// Dyson sphere: a geodesic shell (Goldberg hex/pentagon cells) of thick session tiles on a metal strut frame around a
// plasma star. Every tile is a session; cells without a session stay open so the star shows through (poles first).
// The Session manager tile sits at the front with a gold trim and turns with the shell.
// Hovering blends every tile from its place on the shell into flat rows: Session Manager / Active / Ungrouped / Parked.
import * as THREE from '../../node_modules/three/build/three.module.js';
import { makePanelMaterial, setPanelState, GLOW, ENERGY, TIME, SPREAD, NOISE_TEX, NOISE_GLSL } from './panel.js';
import { swapPose, swapDrive, swapMesh, SWAP_LEN } from './swapfx.js';

const V3 = THREE.Vector3;
// the Show tiles settings' group of a session: mgr / active / parked / ungrouped / archived
export const tileGroup = s => ({ 'Session Manager': 'mgr', Active: 'active', Parked: 'parked', Archived: 'archived' }[s.group] || 'ungrouped');
const FLAT_Z = 1.15;          // flat rows sit in front of the shell (root units)
const TILE_ASPECT = 1.15;     // hex tile width / height in the flat rows

// ---------- geodesic cell sets ----------
function icosahedron() {
  const t = (1 + Math.sqrt(5)) / 2;
  const v = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map(a => new V3(...a).normalize());
  const f = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  // a pentagon at the top pole so the shell turns symmetrically around Y
  const q = new THREE.Quaternion().setFromUnitVectors(v[5].clone(), new V3(0, 1, 0));
  v.forEach(p => p.applyQuaternion(q));
  return { verts: v, tris: f };
}
function subdivide(base, n) {
  const verts = [], key = new Map(), tris = [];
  const idx = p => { p.normalize(); const k = p.toArray().map(x => Math.round(x * 1e5)).join(','); if (!key.has(k)) { key.set(k, verts.length); verts.push(p); } return key.get(k); };
  for (const [a, b, c] of base.tris) {
    const A = base.verts[a], B = base.verts[b], C = base.verts[c], P = [];
    for (let i = 0; i <= n; i++) { P[i] = []; for (let j = 0; j <= n - i; j++) P[i][j] = idx(A.clone().multiplyScalar(n - i - j).addScaledVector(B, i).addScaledVector(C, j)); }
    for (let i = 0; i < n; i++) for (let j = 0; j < n - i; j++) {
      tris.push([P[i][j], P[i + 1][j], P[i][j + 1]]);
      if (i + j < n - 1) tris.push([P[i + 1][j], P[i + 1][j + 1], P[i][j + 1]]);
    }
  }
  return { verts, tris };
}
// sqrt(3) subdivision: add each triangle's centre, flip the old edges (12 -> 32 cells, 42 -> 122 cells)
function sqrt3(m) {
  const verts = m.verts.map(v => v.clone()), tris = [], edges = new Map();
  m.tris.forEach(t => {
    const ci = verts.push(m.verts[t[0]].clone().add(m.verts[t[1]]).add(m.verts[t[2]]).normalize()) - 1;
    for (let e = 0; e < 3; e++) { const a = t[e], b = t[(e + 1) % 3], k = Math.min(a, b) + ':' + Math.max(a, b); (edges.get(k) || edges.set(k, []).get(k)).push(ci); }
  });
  for (const [k, cs] of edges) { const [a, b] = k.split(':').map(Number); tris.push([a, cs[0], cs[1]], [b, cs[1], cs[0]]); }
  return { verts, tris };
}
// Goldberg cells = dual of the triangulation: each vertex becomes a cell whose corners are its triangles' centres.
function cellsOf(m) {
  const around = m.verts.map(() => []);
  for (const t of m.tris) { const cen = m.verts[t[0]].clone().add(m.verts[t[1]]).add(m.verts[t[2]]).normalize(); for (const i of t) around[i].push(cen.clone()); }
  return m.verts.map((c, i) => {
    const east = new V3(0, 1, 0).cross(c); if (east.lengthSq() < 1e-6) east.set(1, 0, 0); east.normalize();
    const north = c.clone().cross(east);
    const poly = around[i].sort((a, b) => Math.atan2(a.dot(north), a.dot(east)) - Math.atan2(b.dot(north), b.dot(east)));
    return { c: c.clone(), poly };
  });
}
const SETS = [
  [12, () => cellsOf(icosahedron())], [32, () => cellsOf(sqrt3(icosahedron()))], [42, () => cellsOf(subdivide(icosahedron(), 2))],
  [92, () => cellsOf(subdivide(icosahedron(), 3))], [122, () => cellsOf(sqrt3(subdivide(icosahedron(), 2)))], [162, () => cellsOf(subdivide(icosahedron(), 4))],
  [252, () => cellsOf(subdivide(icosahedron(), 5))], [362, () => cellsOf(subdivide(icosahedron(), 6))], [642, () => cellsOf(subdivide(icosahedron(), 8))],   // big views
];
const frontScore = c => c.c.z - 2 * Math.abs(c.c.y);
const cache = new Map();
export function cellSet(need) {
  const [n, make] = SETS.find(s => s[0] >= need) || SETS[SETS.length - 1];
  if (!cache.has(n)) {
    const cells = make();
    // turn the cell nearest the equator-front exactly to +Z (the manager's seat)
    const front = cells.reduce((b, c) => (frontScore(c) > frontScore(b) ? c : b));
    const q = new THREE.Quaternion().setFromAxisAngle(new V3(0, 1, 0), -Math.atan2(front.c.x, front.c.z));
    cells.forEach(c => { c.c.applyQuaternion(q); c.poly.forEach(p => p.applyQuaternion(q)); });
    cells.front = front;
    cache.set(n, cells);
  }
  return cache.get(n);
}

// ---------- tile geometry ----------
// Thick plate: curved top (fan of K rings per corner wedge) + side walls. Keeps its positions on the shell and in its
// own tangent frame so it can be blended into a flat row.
export function tileGeometry(cell, { inset = 0.8, top = 1 } = {}) {
  const K = cell.poly.length === 5 ? 6 : 4;   // a pentagon needs 6 steps per edge so its flat-hexagon form has vertices on all 6 corners
  const c = cell.c.clone().normalize();
  const east = new V3(0, 1, 0).cross(c); if (east.lengthSq() < 1e-6) east.set(1, 0, 0); east.normalize();
  const north = c.clone().cross(east);
  const ring = cell.poly.map(p => c.clone().add(p.clone().sub(c).multiplyScalar(inset)).normalize());
  const circR = Math.max(...ring.map(r => Math.hypot(r.dot(east), r.dot(north)))) * top;
  const apo = ring.reduce((a, r, i) => { const m = r.clone().add(ring[(i + 1) % ring.length]).multiplyScalar(0.5); return a + Math.hypot(m.dot(east), m.dot(north)); }, 0) / ring.length * top;
  const thick = 0.2 * apo;
  // flat rows: turn the tile (at most half a corner step) so its top edge is level
  const step = 2 * Math.PI / ring.length, m0 = ring[0].clone().add(ring[1]);
  let theta = Math.PI / 2 - Math.atan2(m0.dot(north), m0.dot(east));
  theta = ((theta % step) + step * 1.5) % step - step / 2;
  const P = [], N = [], UV = [], E = [], S = [], W = [], M = [];   // M: per vertex [corner wedge, ring fraction, along the edge, wall segment middle]
  let mw = 0, mu = 0, mv = 0, mm = 0;
  const push = (p, n, e, s, w) => {
    P.push(p.x, p.y, p.z); N.push(n.x, n.y, n.z); E.push(e); S.push(s); W.push(w); M.push(mw, mu, mv, mm);
    UV.push(p.dot(east) / (2 * circR) + 0.5, p.dot(north) / (2 * circR) + 0.5);   // walls too: the plate coordinate of their rim
  };
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const pt = (k, j) => { const d = c.clone(); if (k) d.add(a.clone().sub(c).add(b.clone().sub(a).multiplyScalar(j / k)).multiplyScalar(k / K)); return d.normalize().multiplyScalar(top); };
    const tv = (k, j) => { const p = pt(k, j); mw = i; mu = k / K; mv = k ? j / k : 0; push(p, p.clone().normalize(), 1 - k / K, 0, 0); };
    for (let k = 0; k < K; k++) for (let j = 0; j <= k; j++) {
      tv(k, j); tv(k + 1, j); tv(k + 1, j + 1);
      if (j < k) { tv(k, j); tv(k + 1, j + 1); tv(k, j + 1); }
    }
    // side wall in K strips (the flat-hexagon form bends a pentagon's edge round a corner)
    const n = b.clone().sub(a).cross(c).normalize(), ep = (t, r) => a.clone().lerp(b, t).normalize().multiplyScalar(r);
    mu = 1;
    for (let q = 0; q < K; q++) {
      const t0 = q / K, t1 = (q + 1) / K, qa = ep(t0, top), qb = ep(t1, top), ba = ep(t0, top - thick), bb = ep(t1, top - thick);
      mw = i; mm = (t0 + t1) / 2;
      mv = t0; push(qa, n, 0, 1, 0); push(ba, n, 0, 1, 1); mv = t1; push(bb, n, 0, 1, 1);
      mv = t0; push(qa, n, 0, 1, 0); mv = t1; push(bb, n, 0, 1, 1); push(qb, n, 0, 1, 0);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
  geo.setAttribute('aEdge', new THREE.Float32BufferAttribute(E, 1));
  geo.setAttribute('aSide', new THREE.Float32BufferAttribute(S, 1));
  geo.setAttribute('aWall', new THREE.Float32BufferAttribute(W, 1));
  const L = new Float32Array(P.length), NL = new Float32Array(P.length), tmp = new V3();
  for (let i = 0; i < P.length; i += 3) {
    tmp.set(P[i], P[i + 1], P[i + 2]); L[i] = tmp.dot(east); L[i + 1] = tmp.dot(north); L[i + 2] = tmp.dot(c) - top;
    tmp.set(N[i], N[i + 1], N[i + 2]); NL[i] = tmp.dot(east); NL[i + 1] = tmp.dot(north); NL[i + 2] = tmp.dot(c);
  }
  const cs = Math.cos(theta), sn = Math.sin(theta);
  for (let i = 0; i < L.length; i += 3) {
    let x = L[i], y = L[i + 1]; L[i] = x * cs - y * sn; L[i + 1] = x * sn + y * cs;
    x = NL[i]; y = NL[i + 1]; NL[i] = x * cs - y * sn; NL[i + 1] = x * sn + y * cs;
  }
  // flat rows: the geodesic cell is a little uneven, so its outline is laid on a regular polygon with a level top edge:
  // its own corner count ('regular') or always six ('hexagon'). Corners keep their order round the tile; the turn that
  // best matches the cell picks where corner 0 lands. Vertices follow by their place along the outline.
  const n = ring.length;
  const C = ring.map(r => { const x = r.dot(east), y = r.dot(north); return [x * cs - y * sn, x * sn + y * cs]; });
  const phi = C.map(([x, y]) => Math.atan2(y, x));
  const dir = C.reduce((a, p, i) => { const q = C[(i + 1) % n]; return a + p[0] * q[1] - p[1] * q[0]; }, 0) >= 0 ? 1 : -1;
  const wrap = d => Math.atan2(Math.sin(d), Math.cos(d));
  function outline(tn) {
    const st = 2 * Math.PI / tn, base = Math.PI / 2 + st / 2;
    const H = Array.from({ length: tn }, (_, m) => { const g = base + dir * m * st; return [Math.cos(g) * circR, Math.sin(g) * circR]; });
    const at = q => { const m = Math.floor(q), f = q - m, a = H[((m % tn) + tn) % tn], b = H[(((m + 1) % tn) + tn) % tn]; return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a, b]; };
    let s0 = 0, bestCost = Infinity;
    for (let sh = 0; sh < tn; sh++) {
      const cost = phi.reduce((a, f, i) => { const [x, y] = at(sh + i * tn / n); return a + wrap(f - Math.atan2(y, x)) ** 2; }, 0);
      if (cost < bestCost) { bestCost = cost; s0 = sh; }
    }
    const Lo = Float32Array.from(L), NLo = Float32Array.from(NL), uv = new Float32Array(UV.length);
    for (let v = 0; v < M.length / 4; v++) {
      const w = M[4 * v], u = M[4 * v + 1], t = M[4 * v + 2], [x, y] = at(s0 + (w + t) * tn / n);
      Lo[3 * v] = x * u; Lo[3 * v + 1] = y * u;
      if (S[v]) {                                                        // side wall: face straight out from its new edge
        const [, , a, b] = at(s0 + (w + M[4 * v + 3]) * tn / n);
        let nx = b[1] - a[1], ny = a[0] - b[0]; const l = Math.hypot(nx, ny) || 1;
        if (nx * (a[0] + b[0]) + ny * (a[1] + b[1]) < 0) { nx = -nx; ny = -ny; }
        NLo[3 * v] = nx / l; NLo[3 * v + 1] = ny / l; NLo[3 * v + 2] = 0;
      }
      uv[2 * v] = Lo[3 * v] / (2 * circR) + 0.5; uv[2 * v + 1] = Lo[3 * v + 1] / (2 * circR) + 0.5;   // walls too: their rim's plate coordinate (the swap effects use it)
    }
    return { L: Lo, NL: NLo, uv };
  }
  const shapes = { regular: outline(n) }; shapes.hexagon = n === 6 ? shapes.regular : outline(6);
  // the flat-row form (until prepareFlat lays it out: the shell form); picking in the rows uses a CPU copy of it
  geo.setAttribute('aFlatP', new THREE.Float32BufferAttribute(P, 3));
  geo.setAttribute('aFlatN', new THREE.Float32BufferAttribute(N, 3));
  geo.setAttribute('aFlatUV', new THREE.Float32BufferAttribute(UV, 2));
  const pick = new THREE.BufferGeometry(); pick.setAttribute('position', geo.attributes.aFlatP);
  geo.userData = { shapes, L: shapes.regular.L, NL: shapes.regular.NL, circR, pick };
  geo.computeBoundingSphere();
  geo.userData.cc = geo.boundingSphere.center.clone(); geo.userData.fc = geo.userData.cc.clone();   // tile centre on the shell / in the rows
  return geo;
}

// ---------- labels ----------
// square canvas mapped across the tile's circumscribed square; text stays inside the central ~62% (inside the hex)
let LABEL_RES = 1024;   // label canvas ceiling in pixels (settings: tile resolution); each label is sized to its tile on screen
export function labelTexture(s, res = LABEL_RES) {   // text is laid out in 512 units
  const w = 512, h = 512;
  const c = document.createElement('canvas'); c.width = c.height = res;
  const g = c.getContext('2d'); g.scale(res / 512, res / 512);
  g.fillStyle = '#fff'; g.textAlign = 'center';
  const font = 'Bahnschrift, Segoe UI, Arial';
  let big = 56, shown;
  for (;;) {
    g.font = `600 ${big}px ${font}`;
    const lines = []; let cur = '';
    for (const wd of String(s.title || '').split(' ')) { const t = cur ? cur + ' ' + wd : wd; if (g.measureText(t).width > w * 0.58 && cur) { lines.push(cur); cur = wd; } else cur = t; }
    lines.push(cur); shown = lines;
    if ((lines.length <= 3 && lines.every(l => g.measureText(l).width <= w * 0.6)) || big < 34) break;
    big -= 2;
  }
  // still too long at the smallest size: three lines at most, each cut with an ellipsis inside the hexagon
  const fit = txt => { while (txt.length > 1 && g.measureText(txt).width > w * 0.6) txt = txt.slice(0, -2).trimEnd() + '…'; return txt; };
  if (shown.length > 3) { shown = shown.slice(0, 3); shown[2] += '…'; }
  shown = shown.map(fit);
  // session name, then model, then effort level (one per line), centred as a block
  const small = [s.model, s.effort].filter(Boolean).map(String), sh = 40;
  let y = h / 2 - (shown.length * big * 1.1 + small.length * sh) / 2 + big * 0.85;
  for (const l of shown) { g.fillText(l, w / 2, y); y += big * 1.1; }
  g.font = `34px ${font}`; y += sh * 0.7 - big * 0.25;
  for (const l of small) { g.fillText(fit(l), w / 2, y); y += sh; }
  // marks over the name (new ideas): green = background tasks running (with the count past 1), violet = an unsent draft
  const marks = [s.bg ? ['#4fd18b', s.bg > 1 ? String(s.bg) : ''] : null, s.draft ? ['#b48cff', ''] : null].filter(Boolean);
  marks.forEach(([col, txt], i) => {
    const x = w / 2 + (i - (marks.length - 1) / 2) * 44, my = 112;
    g.fillStyle = col; g.beginPath(); g.arc(x, my, txt ? 17 : 12, 0, Math.PI * 2); g.fill();
    if (txt) { g.fillStyle = '#10241a'; g.font = `700 24px ${font}`; g.textBaseline = 'middle'; g.fillText(txt, x, my + 1); g.textBaseline = 'alphabetic'; }
  });
  const t = new THREE.CanvasTexture(c); t.anisotropy = 16; return t;
}
// view plates (artifacts): the page's last picture with its title below, or a title plate when there is no picture yet
function faceTexture(s) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 400;
  const g = c.getContext('2d'), t = new THREE.CanvasTexture(c); t.anisotropy = 8; t.colorSpace = THREE.SRGBColorSpace;
  const font = 'Bahnschrift, Segoe UI, Arial';
  const fit = (txt, max) => { while (txt.length > 3 && g.measureText(txt).width > max) txt = txt.slice(0, -2).trimEnd() + '…'; return txt; };
  const draw = img => {
    g.clearRect(0, 0, 512, 400);
    g.fillStyle = '#121211'; g.beginPath(); g.roundRect(0, 0, 512, 400, 26); g.fill();
    g.strokeStyle = '#2b2a28'; g.lineWidth = 3; g.stroke();
    g.fillStyle = '#ecebe6'; g.textAlign = 'center'; g.textBaseline = 'middle';
    if (img) {
      g.save(); g.beginPath(); g.roundRect(12, 12, 488, 304, 18); g.clip();
      const k = Math.max(488 / img.width, 304 / img.height); g.drawImage(img, 12 + (488 - img.width * k) / 2, 12, img.width * k, img.height * k);   // top of the page
      g.restore();
      g.font = '600 40px ' + font; g.fillText(fit(String(s.title || ''), 480), 256, 358);
    } else {
      g.font = '600 54px ' + font;
      const lines = []; let cur = '';
      for (const wd of String(s.title || '').split(' ')) { const x = cur ? cur + ' ' + wd : wd; if (g.measureText(x).width > 440 && cur) { lines.push(cur); cur = wd; } else cur = x; }
      lines.push(cur);
      const shown = lines.slice(0, 3); let y = 200 - (shown.length - 1) * 26;
      for (const l of shown) { g.fillText(fit(l, 470), 256, y); y += 52; }
      if (s.sub) { g.fillStyle = '#9a978f'; g.font = '34px ' + font; g.fillText(s.sub, 256, 350); }
    }
    t.needsUpdate = true;
  };
  draw(null);
  if (s.pic) { const im = new Image(); im.onload = () => draw(im); im.src = s.pic; }
  return t;
}
function headerTexture(text) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 64;
  const g = c.getContext('2d'); g.fillStyle = '#e8ecf0'; g.font = '600 40px Bahnschrift, Segoe UI, Arial'; g.textBaseline = 'middle';
  g.fillText(text.toUpperCase(), 4, 34);
  return new THREE.CanvasTexture(c);
}
function radialTexture(stops) {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d'), rg = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  for (const [o, col] of stops) rg.addColorStop(o, col);
  g.fillStyle = rg; g.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}

// ---------- star core ----------
// Max perf spikes: narrow cones at SPIKES fixed directions (xyz) that grow and retract on their own beat (w = phase);
// uSpike 0 = smooth orb
const SPIKES = 28;
const STAR_VS = `uniform float uSpike, uTime; uniform vec4 uDirs[${SPIKES}]; varying vec3 vN, vP, vV; varying float vSpike;
void main() {
  vec3 p = position, d = normalize(position); float s = 0.0;
  if (uSpike > 0.001) {
    for (int i = 0; i < ${SPIKES}; i++) {
      vec4 q = uDirs[i]; float c = dot(d, q.xyz);
      if (c < 0.9895) continue;                                 // outside this spike's base (~0.145 rad)
      float cone = max(0.0, 1.0 - sqrt(max(0.0, 2.0 * (1.0 - c))) / 0.145);
      float life = max(0.0, sin(uTime * (1.2 + q.w * 1.6) + q.w * 6.2832));
      s = max(s, cone * cone * life * (0.55 + 0.45 * fract(q.w * 7.0)));
    }
    p += d * s * uSpike * 0.85;
  }
  vSpike = uSpike > 0.001 ? s : 0.0; vP = position; vN = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(p, 1.0); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv;
}`;
const STAR_FS = `uniform vec3 uColor; uniform float uLevel, uTime, uGain, uMoon, uLava; varying vec3 vN, vP, vV; varying float vSpike;
${NOISE_GLSL}
float fbm(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * vnoise(p); p *= 2.07; a *= 0.5; } return s; }
// smooth glowing orb: white-hot centre fading to the core colour at the rim, slow soft swirl
void main() {
  float mu = clamp(dot(vN, vV), 0.0, 1.0);
  float n = fbm(vP * 2.2 + vec3(uTime * 0.06, uTime * 0.03, -uTime * 0.05));
  float body = 0.25 + 0.75 * pow(mu, 1.2) + 0.25 * (n - 0.45);
  vec3 col = mix(uColor * 0.55, mix(uColor, vec3(1.0), 0.6), pow(mu, 2.5));
  // Night: a moon, lit from the upper left so a crescent shows; Weekend: big slow lava-lamp blobs drifting over the orb
  float lit = smoothstep(-0.15, 0.55, dot(vN, normalize(vec3(-0.75, 0.45, 0.5))));
  body *= mix(1.0, 0.1 + 0.95 * lit, uMoon);
  float lava = smoothstep(0.42, 0.58, (vnoise(vP * 1.5 + vec3(sin(uTime * 0.21) * 1.5, uTime * 0.17, cos(uTime * 0.13) * 1.5)) + 0.6 * vnoise(vP * 2.3 - uTime * 0.11)) / 1.6);
  body *= mix(1.0, 0.25 + 1.1 * lava, uLava);
  col = mix(col, mix(uColor, vec3(1.0), 0.45), lava * uLava * 0.6);
  float on = smoothstep(0.0, 0.12, vSpike);                 // spikes glow on their own (the sphere's rim shading would darken them)
  vec3 sc = mix(uColor, vec3(1.0), 0.8 * vSpike * vSpike) * (0.45 + 0.5 * vSpike);   // mode colour, white-hot toward the tip
  col = max(col * body, sc * on); body = 1.0;                   // never darker than the orb under it (no spots face-on)
  gl_FragColor = vec4(col * body * (0.2 + 1.7 * uLevel) * uGain, 1.0);
}`;
// dark metal lattice (triangulation edges) of radius R, for the cages around the core
function cage(m, R, r, mat) {
  const edges = new Map();
  for (const t of m.tris) for (let e = 0; e < 3; e++) { const a = t[e], b = t[(e + 1) % 3]; edges.set(Math.min(a, b) + ':' + Math.max(a, b), [a, b]); }
  const g = new THREE.Group(), mx = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new V3(0, 1, 0);
  const struts = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 6, 1, true), mat, edges.size);
  let i = 0;
  for (const [a, b] of edges.values()) {
    const pa = m.verts[a].clone().multiplyScalar(R), pb = m.verts[b].clone().multiplyScalar(R), d = pb.clone().sub(pa);
    q.setFromUnitVectors(up, d.clone().normalize());
    mx.compose(pa.clone().add(pb).multiplyScalar(0.5), q, new V3(r, d.length(), r)); struts.setMatrixAt(i++, mx);
  }
  const nodes = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), mat, m.verts.length);
  m.verts.forEach((v, j) => { mx.compose(v.clone().multiplyScalar(R), q.identity(), new V3(r * 1.8, r * 1.8, r * 1.8)); nodes.setMatrixAt(j, mx); });
  g.add(struts, nodes);
  return g;
}

// the star: an even geodesic sphere (no crowded poles), as fine as the old 192-segment UV sphere at its equator,
// with about a third of the vertices
function starGeometry(r, n) {
  const m = subdivide(icosahedron(), n), P = new Float32Array(m.verts.length * 3), N = new Float32Array(m.verts.length * 3);
  m.verts.forEach((v, i) => { N[i * 3] = v.x; N[i * 3 + 1] = v.y; N[i * 3 + 2] = v.z; P[i * 3] = v.x * r; P[i * 3 + 1] = v.y * r; P[i * 3 + 2] = v.z * r; });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3)); g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  g.setIndex(m.tris.flat()); g.computeBoundingSphere();
  return g;
}
// tiles are drawn in their GPU blend of shell and rows; picking (only in the rows) tests the flat form
const meshRaycast = THREE.Mesh.prototype.raycast;
function pickRaycast(rc, out) { const g = this.geometry; this.geometry = g.userData.pick; meshRaycast.call(this, rc, out); this.geometry = g; }

export function createSphere(scene) {
  const root = new THREE.Group(); scene.add(root);
  const shell = new THREE.Group(); root.add(shell);
  const headers = new THREE.Group(); root.add(headers); headers.visible = false;

  const starMat = new THREE.ShaderMaterial({ vertexShader: STAR_VS, fragmentShader: STAR_FS, uniforms: { uColor: { value: new THREE.Color() }, uLevel: { value: 0.06 }, uTime: { value: 0 }, uSpike: { value: 0 }, uGain: { value: 1 }, uMoon: { value: 0 }, uLava: { value: 0 }, uNoise: { value: NOISE_TEX },
    uDirs: { value: Array.from({ length: SPIKES }, (_, i) => {                      // even spread (Fibonacci sphere), random beat
      const y = 1 - (2 * i + 1) / SPIKES, r = Math.sqrt(1 - y * y), a = i * 2.39996;
      return new THREE.Vector4(r * Math.cos(a), y, r * Math.sin(a), Math.random());
    }) } } });
  const star = new THREE.Mesh(starGeometry(0.6, 32), starMat); root.add(star);
  // core cages: a tight lattice on the orb and a wider one turning the other way, lit from inside by the core
  const cageMat = new THREE.MeshStandardMaterial({ color: 0x1a1d22, metalness: 0.85, roughness: 0.35 });
  const cageIn = cage(subdivide(icosahedron(), 3), 0.625, 0.006, cageMat), cageOut = cage(subdivide(icosahedron(), 2), 0.8, 0.009, cageMat);
  root.add(cageIn, cageOut);
  const coreLight = new THREE.PointLight(0x3da5ff, 1, 0, 0); root.add(coreLight);
  let glowTex = null, haloTex = null;
  const inner = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  inner.scale.setScalar(2.3); inner.renderOrder = 1; root.add(inner);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false }));
  halo.scale.setScalar(3.4); halo.position.z = -1.2; halo.renderOrder = -1; root.add(halo);

  const frameMat = new THREE.MeshStandardMaterial({ color: 0x2a2d32, metalness: 0.9, roughness: 0.38, transparent: true });
  let struts = null, nodes = null;

  let glowHex = 0x3da5ff, glowLevel = 0.06, spreadF = 0;
  // mode motion: the core runs on its own clock (speed x normal), eased so a mode change never jumps
  const motion = { speed: 1, bright: 1, spikes: 0, breathe: 0, moon: 0, lava: 0 }; let cageT = 0, coreT = 0, burst = 0, burstIn = 0;
  function setMotion(target, dt) {
    const k = 1 - Math.exp(-dt * 2.5);
    for (const n of ['speed', 'bright', 'spikes', 'breathe', 'moon', 'lava']) motion[n] += (target[n] - motion[n]) * k;
    tickFx();
    coreT += dt * motion.speed; cageT += dt * motion.speed * (1 - 0.85 * motion.moon);   // the moon's cages nearly still
    starMat.uniforms.uMoon.value = motion.moon; starMat.uniforms.uLava.value = motion.lava;
    burst *= Math.exp(-dt * 7);
    if (motion.spikes > 0.02 && (burstIn -= dt) <= 0) { burst = 1; burstIn = 0.35 + Math.random() * 1.1; }   // charged-star surges
    starMat.uniforms.uTime.value = coreT; star.rotation.y = coreT * 0.12;
    starMat.uniforms.uSpike.value = motion.spikes * (0.7 + 0.6 * burst);
  }
  function setGlow(hex, baseLevel = glowLevel) {
    glowLevel = baseLevel;
    const level = baseLevel + motion.spikes * burst * 0.45;
    const gain = motion.bright * (1 + 0.14 * motion.breathe * Math.sin(coreT * 1.3));   // mode brightness; efficiency breathes slowly
    if (hex != null && hex !== glowHex || !glowTex) {
      glowHex = hex ?? glowHex;
      const c = new THREE.Color(glowHex), rgb = `${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)}`;
      glowTex?.dispose(); haloTex?.dispose();
      glowTex = radialTexture([[0, 'rgba(255,255,255,0.9)'], [0.25, `rgba(${rgb},0.75)`], [0.5, `rgba(${rgb},0.25)`], [1, `rgba(${rgb},0)`]]);
      haloTex = radialTexture([[0.3, `rgba(${rgb},0.55)`], [0.55, `rgba(${rgb},0.16)`], [1, `rgba(${rgb},0)`]]);
      inner.material.map = glowTex; halo.material.map = haloTex; inner.material.needsUpdate = halo.material.needsUpdate = true;
    }
    const c = new THREE.Color(glowHex);
    ENERGY.value.copy(c);
    GLOW.value.copy(c).multiplyScalar(0.6 * level);
    starMat.uniforms.uColor.value.copy(c); starMat.uniforms.uLevel.value = Math.min(level, 1); starMat.uniforms.uGain.value = gain > 1 ? 1 + (gain - 1) * 0.35 : gain;   // brighter modes: the orb only a little (more washes it out white),
    halo.scale.setScalar(3.4 * Math.max(1, 1 + (gain - 1) * 0.6));            // the rest is a wider halo and a stronger core light   // bursts light the glow, not a white-out
    coreLight.color.copy(c); coreLight.intensity = (0.4 + 3 * level) * gain;
    cageIn.rotation.y = cageT * 0.04; cageOut.rotation.y = -cageT * 0.025; cageOut.rotation.x = 0.3;
    const fade = 1 - spreadF * 0.85;
    inner.material.opacity = Math.min(1, 0.9 * level * gain) * (1 - 0.65 * motion.moon - 0.6 * motion.lava) * fade;   // the centre glow would wash out crescent and blobs
    halo.material.opacity = Math.min(1, (0.05 + 0.8 * level) * gain) * fade;
  }

  // stable seat numbers: a session keeps its seat; a fresh session inherits its parent's seat
  let seats = {}; try { seats = JSON.parse(localStorage.getItem('seats') || '{}'); } catch {}
  let nextSeat = Object.values(seats).reduce((a, x) => Math.max(a, x + 1), 0);
  const seatOf = s => {
    if (s.newTile) return 1e9;   // the "+ New session" tile: always after the sessions
    if (seats[s.sessionId] == null) seats[s.sessionId] = s.parentId != null && seats[s.parentId] != null ? seats[s.parentId] : nextSeat++;
    return seats[s.sessionId];
  };

  let blankMat = null;
  let tiles = [], cells5 = [], key = '', cellCount = 12, groupsFor = [], flatRect = { x0: 0, y0: 0, x1: 0, y1: 0 }, align = 'center';

  const dropHeaders = () => { for (const h of [...headers.children]) { headers.remove(h); if (!h.userData.keepMap) h.material.map.dispose(); h.material.dispose(); h.geometry.dispose(); } };
  // keep: sessions whose labels, picture and rebirth carry over to the rebuilt tiles (the rest are disposed)
  function clear(keep = new Set()) {
    for (const t of tiles) {
      shell.remove(t.mesh); t.mesh.geometry.dispose(); t.mesh.material.userData.u.uLabel.value = null; t.mesh.material.dispose();
      if (!keep.has(t.s.sessionId)) { t.label?.dispose(); t.reborn?.label?.dispose(); t.faceTex?.dispose(); }
    }
    tiles = [];
    for (const t of cells5) { shell.remove(t.mesh); t.mesh.geometry.dispose(); if (t.mesh.material !== blankMat) t.mesh.material.dispose(); }
    cells5 = [];
    for (const m of [struts, nodes]) if (m) { shell.remove(m); m.geometry.dispose(); m.dispose(); }
    dropHeaders();
  }

  function buildFrame(cells) {
    const edges = new Map(), corners = new Map(), k = p => p.toArray().map(x => Math.round(x * 1e4)).join(',');
    for (const c of cells) c.poly.forEach((p, i) => {
      const q = c.poly[(i + 1) % c.poly.length], a = k(p), b = k(q);
      corners.set(a, p); edges.set(a < b ? a + '|' + b : b + '|' + a, [p, q]);
    });
    const R = 0.985, r = 0.02 * Math.sqrt(42 / cells.length);
    struts = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 6, 1, true), frameMat, edges.size);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new V3(0, 1, 0);
    let i = 0;
    for (const [a, b] of edges.values()) {
      const pa = a.clone().multiplyScalar(R), pb = b.clone().multiplyScalar(R), d = pb.clone().sub(pa);
      q.setFromUnitVectors(up, d.clone().normalize());
      m.compose(pa.clone().add(pb).multiplyScalar(0.5), q, new V3(r, d.length(), r)); struts.setMatrixAt(i++, m);
    }
    nodes = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), frameMat, corners.size);
    i = 0;
    for (const p of corners.values()) { m.compose(p.clone().multiplyScalar(R), q.identity(), new V3(r * 1.7, r * 1.7, r * 1.7)); nodes.setMatrixAt(i++, m); }
    shell.add(struts, nodes);
  }

  // the flat rows' groups; a group change alone (Active -> Parked) only regroups, the tiles keep their cells
  const GROUPS = ['Session Manager', 'Active', 'Parked', 'Archived'];
  function grouped(sess) {
    const bySeat = (a, b) => seatOf(a) - seatOf(b);
    return { mgr: sess.find(s => s.group === 'Session Manager'), active: sess.filter(s => s.group === 'Active').sort(bySeat),
      parked: sess.filter(s => s.group === 'Parked').sort(bySeat), ungrouped: sess.filter(s => !GROUPS.includes(s.group)).sort(bySeat),
      archived: sess.filter(s => s.group === 'Archived') };   // archived: newest first, as the feed lists them
  }
  function regroup(sess) {
    const custom = lastFeed && lastFeed.groups;
    if (custom) { groupsFor = custom.map(g => [g, sess.filter(s => s.group === g)]).filter(g => g[1].length); return; }
    const { mgr, active, ungrouped, parked, archived } = grouped(sess.filter(inRows));   // the rows hold only the groups ticked for them
    groupsFor = [['Session Manager', mgr ? [mgr] : []], ['Active', active], ['Ungrouped', ungrouped], ['Parked', parked], ['Archived', archived]].filter(g => g[1].length);
  }
  function build(sess) {
    const old = new Map(tiles.map(t => [t.s.sessionId, t]));
    clear(new Set(sess.map(s => s.sessionId)));
    const custom = lastFeed && lastFeed.groups;               // a view (artifacts, projects, routines) names its own groups
    const { mgr: m0, active, ungrouped, parked, archived } = grouped(sess), mgr = custom ? null : m0;
    const mgrSh = !!mgr && onShell(mgr), ns = custom ? sess.length : sess.filter(onShell).length, ro = sess.length - ns;   // ro: tiles only in the rows (they take spare cells)
    const n = ns;
    const hexOnly = flatShape === 'hexagon';                // 'All hexagons': sessions sit only in hexagon cells, the 12 pentagons hold energy cells
    const cells = cellSet(Math.max(custom ? 42 : 0, custom ? 0 : minCells, n + Math.max(Math.max(2, Math.ceil(n * 0.15)), ro) + (mgr && !mgrSh ? 1 : 0) + (hexOnly ? 12 : 0)));   // views: hex plates
    cellCount = cells.length;
    buildFrame(cells);
    // seats: manager at the front cell; then cells nearest the equator, spread around the shell (open cells end up at the poles)
    const vdc = i => { let r = 0, f = 0.5; for (; i; i >>= 1, f /= 2) if (i & 1) r += f; return r; };
    const spreadKey = new Map(Array.from({ length: 32 }, (_, i) => [Math.round(vdc(i) * 32), i]));
    const az = c => spreadKey.get(Math.round(((Math.atan2(c.c.x, c.c.z) / (2 * Math.PI)) + 1) % 1 * 32) % 32);
    const front = hexOnly && cells.front.poly.length !== 6 ? cells.filter(c => c.poly.length === 6).reduce((b, c) => (frontScore(c) > frontScore(b) ? c : b)) : cells.front;
    const order = cells.filter(c => c !== front && (!hexOnly || c.poly.length === 6)).sort((a, b) => Math.floor(Math.abs(a.c.y) * 3.2) - Math.floor(Math.abs(b.c.y) * 3.2) || az(a) - az(b));
    const used = new Set();
    const place = (s, cell, isMgr, rowsOnly = false) => {
      if (!rowsOnly) used.add(cell);                                          // a rows-only tile's spot still shows an empty tile / open spot on the sphere
      const mesh = new THREE.Mesh(tileGeometry(cell), makePanelMaterial()), t = { mesh, s, mgr: isMgr, rowsOnly, shellOnly: !custom && !rowsOnly && !inRows(s) }, o = old.get(s.sessionId);
      mesh.frustumCulled = false; mesh.raycast = pickRaycast;                // the GPU moves it off its shell bounds
      if (o) for (const k of ['label', 'lk', 'reborn', 'ripple', 'faceTex', 'faceKey']) t[k] = o[k];   // same session: keep its label and life state
      shell.add(mesh); tiles.push(t);
    };
    regroup(sess);
    if (custom) groupsFor.flatMap(g => g[1]).forEach((s, i) => { if (order[i]) place(s, order[i], false); });
    else {
      if (mgrSh) place(mgr, front, true);
      const shellList = [...active, ...ungrouped, ...parked, ...archived].filter(onShell), rowsList = [...(mgr && !mgrSh ? [mgr] : []), ...[...active, ...ungrouped, ...parked, ...archived].filter(s => !onShell(s))];
      shellList.forEach((s, i) => { if (order[i]) place(s, order[i], false); });
      rowsList.forEach((s, i) => { if (order[shellList.length + i]) place(s, order[shellList.length + i], s === mgr, true); });
      try { localStorage.setItem('seats', JSON.stringify(seats)); } catch {}
    }
    // every spot without a session (the 12 pentagons in 'All hexagons', spare cells) holds an energy cell: a shell plate,
    // not a session, that renews on its own timer
    // (setting 'Empty spots: Open': no plate at all, the core shows through)
    // They all share one material (one program and one uniform upload for the lot); a renewing cell borrows its own for the swap.
    if (!openSpots) for (const cell of cells.filter(c => !used.has(c))) {
      if (!blankMat) { blankMat = makePanelMaterial(); setPanelState(blankMat, {}); }
      const mesh = new THREE.Mesh(tileGeometry(cell), blankMat);
      mesh.frustumCulled = false; shell.add(mesh); cells5.push({ mesh, energy: true, left: 5 + Math.random() * 85 });
    }
    setSpread(spreadF);
  }

  // W, H: usable flat area in root units (the app passes the window size divided by the current sphere scale)
  // the fewest columns whose rows fit the height (views start at 6)
  // row tile size (setting): the fewest columns; more columns = smaller tiles (they still shrink further to fit the height)
  let minCols = 3;
  function setRowSize(sz) { const n = { large: 3, medium: 6, small: 9 }[sz] || 3; if (n === minCols) return false; minCols = n; return true; }
  function pickCols(W, H) {
    const groups = groupsFor, gap = W * 0.015, headH = Math.min(0.16, H * 0.03);
    let cols = 3, tw = 0, total = 0;
    for (let c = Math.max(minCols, groupsFor.length && lastFeed && lastFeed.groups ? 6 : 3); c <= 24; c++) {
      const w = (W - gap * (c - 1)) / c, h = w / TILE_ASPECT;
      const rows = groups.reduce((a, [name, l]) => a + (name === 'Session Manager' ? 1.3 : Math.ceil(l.length / c)), 0);
      cols = c; tw = w; total = groups.length * (headH + gap) + rows * (h + gap);
      if (total <= H) break;
    }
    return { cols, tw, total, gap, headH };
  }
  function layoutFlat(W, H, yOff = 0) {
    dropHeaders();
    const groups = groupsFor, { cols, tw, total, gap, headH } = pickCols(W, H);
    const th = tw / TILE_ASPECT;
    let y = total / 2 + yOff;
    const byId = new Map(tiles.map(t => [t.s.sessionId, t]));
    const fit = (t, x, yc, w, h) => { const R = t.mesh.geometry.userData.circR; t.flat = { x, y: yc, k: Math.min(w / (2 * R), h / (1.8 * R)) }; };
    const header = (name, x, yc) => {
      const hm = new THREE.Mesh(new THREE.PlaneGeometry(headH * 8, headH), new THREE.MeshBasicMaterial({ map: headerTexture(name), transparent: true, depthTest: false, opacity: 0 }));
      hm.position.set(x, yc, FLAT_Z); hm.renderOrder = 2; headers.add(hm);
      if (lastFeed && lastFeed.headerPress) hm.userData.session = { press: lastFeed.headerPress, title: name };   // a view's group title opens a Claude page
    };
    // routines: a ring of plates round the core
    if (lastFeed && lastFeed.layout === 'ring') {
      const n = tiles.length, R0 = Math.min(W, H) * 0.3, tw = Math.min(W * 0.15, (2 * Math.PI * R0 / Math.max(n, 5)) * 0.8), th = tw / TILE_ASPECT;
      if (groups[0]) header(groups[0][0], -W / 2 + headH * 4, H / 2 + yOff - headH / 2);
      tiles.forEach((t, i) => { const a = Math.PI / 2 - i * 2 * Math.PI / n; fit(t, Math.cos(a) * R0 * 1.25, Math.sin(a) * R0, tw, th); });
      flatRect = { x0: -W / 2, x1: W / 2, y0: yOff - H / 2, y1: yOff + H / 2 };
      addFaces(); return;
    }
    for (const [name, l] of groups) {
      header(name, -W / 2 + headH * 4, y - headH / 2);
      y -= headH + gap;
      if (name === 'Session Manager') {
        const t = byId.get(l[0].sessionId), mw = tw * 1.3;
        if (t) fit(t, align === 'left' ? -W / 2 + mw / 2 : align === 'right' ? W / 2 - mw / 2 : 0, y - th * 0.65, mw, th * 1.3);
        y -= th * 1.3 + gap;
      } else {
        l.forEach((s, i) => {
          const c = i % cols, r = Math.floor(i / cols), rowN = Math.min(cols, l.length - r * cols), t = byId.get(s.sessionId);
          // tile alignment setting: rows start at the left edge, sit centred, or end at the right edge
          const x = align === 'left' ? -W / 2 + tw / 2 + c * (tw + gap) : align === 'right' ? W / 2 - tw / 2 - (rowN - 1 - c) * (tw + gap) : (c - (rowN - 1) / 2) * (tw + gap);
          if (t) fit(t, x, y - r * (th + gap) - th / 2, tw, th);
        });
        y -= Math.ceil(l.length / cols) * (th + gap);
      }
    }
    flatRect = { x0: -W / 2, x1: W / 2, y0: y, y1: total / 2 + yOff };
    addFaces();
  }
  // picture plates in front of view tiles (they fade with the headers)
  function addFaces() {
    for (const t of tiles) {
      if (!t.s.face || !t.flat) continue;
      if (!t.faceTex || t.faceKey !== t.s.pic) { t.faceTex?.dispose(); t.faceTex = faceTexture(t.s); t.faceKey = t.s.pic; }
      const R = t.mesh.geometry.userData.circR, w = 1.42 * R * t.flat.k;
      const fm = new THREE.Mesh(new THREE.PlaneGeometry(w, w * 400 / 512), new THREE.MeshBasicMaterial({ map: t.faceTex, transparent: true, depthTest: false, opacity: 0 }));
      fm.position.set(t.flat.x, t.flat.y, FLAT_Z + 0.02); fm.renderOrder = 3; fm.userData.keepMap = true; headers.add(fm);
    }
  }

  // each tile's flat-row positions in shell space, undoing the shell's current turn
  // yOff: shift the rows up (root units) to leave room for the bottom bar
  function prepareFlat(W, H, yOff = 0) {
    layoutFlat(W, H, yOff);
    const ry = -shell.rotation.y, cs = Math.cos(ry), sn = Math.sin(ry);
    for (const t of tiles) {
      if (!t.flat) continue;
      const g = t.mesh.geometry, d = g.userData, { x, y, k } = t.flat, sh = d.shapes[flatShape] || d.shapes.regular;
      const fp = g.attributes.aFlatP, fn = g.attributes.aFlatN, P = fp.array, N = fn.array;
      d.L = sh.L; d.NL = sh.NL; g.attributes.aFlatUV.array.set(sh.uv);
      const cz = FLAT_Z - 0.1 * d.circR * k; d.fc.set(x * cs + cz * sn, y, -x * sn + cz * cs);   // the plate's middle in the rows
      for (let i = 0; i < d.L.length; i += 3) {
        const fx = x + d.L[i] * k, fy = y + d.L[i + 1] * k, fz = FLAT_Z + d.L[i + 2] * k;
        P[i] = fx * cs + fz * sn; P[i + 1] = fy; P[i + 2] = -fx * sn + fz * cs;
        const nx = d.NL[i], ny = d.NL[i + 1], nz = d.NL[i + 2];
        N[i] = nx * cs + nz * sn; N[i + 1] = ny; N[i + 2] = -nx * sn + nz * cs;
      }
      fp.needsUpdate = fn.needsUpdate = g.attributes.aFlatUV.needsUpdate = true; d.pick.boundingSphere = null;
    }
  }

  // the blend between shell and rows runs in the tiles' vertex shader: here only the uniform and the frame / headers
  function setSpread(f) {
    spreadF = f; SPREAD.value = f;
    frameMat.opacity = 1 - f; if (struts) struts.visible = nodes.visible = f < 0.97;
    headers.visible = f > 0.6;
    for (const h of headers.children) h.material.opacity = Math.max(0, (f - 0.6) / 0.4);
  }

  // ---- tile life: rebirth on a swap (flare, sparks into the core, re-form) and the growth ripple ----
  const SPARKS = 160, sparkPos = new Float32Array(SPARKS * 3), sparkCol = new Float32Array(SPARKS * 4), sparks = [];
  const sparkGeo = new THREE.BufferGeometry();   // colour + alpha: a fading spark fades its alpha too (else it leaves a dark dot over the desktop)
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(sparkPos, 3)); sparkGeo.setAttribute('color', new THREE.BufferAttribute(sparkCol, 4));
  const sparkCloud = new THREE.Points(sparkGeo, new THREE.PointsMaterial({ size: 0.05, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    map: radialTexture([[0, 'rgba(255,255,255,1)'], [0.35, 'rgba(255,255,255,0.5)'], [1, 'rgba(255,255,255,0)']]) }));
  sparkCloud.frustumCulled = false; sparkCloud.renderOrder = 4; sparkCloud.visible = false; shell.add(sparkCloud);
  const tmp = new V3(), tmp2 = new V3(), tmp3 = new V3();
  // the tile's centre now: on the shell, in the rows or on the way (cached per tile, no bounding-sphere work)
  const centreOf = (t, v = new V3()) => { const d = t.mesh.geometry.userData; return v.copy(d.cc).lerp(d.fc, spreadF); };
  // a swap (the chosen style, swapfx.js): old = the session this tile replaces (null: an energy cell renewing). The old plate keeps
  // the old session's wear level until the tile swaps over
  function startRebirth(t, old) {
    if (t.energy && t.mesh.material === blankMat) { t.mesh.material = makePanelMaterial(); setPanelState(t.mesh.material, {}); }   // its own material while it swaps
    const mode = swapMode, r = t.reborn = { at: performance.now(), label: old ? labelTexture(old, t.res) : null, burst: false, mode };
    if (mode > 1) {
      r.pct = old && old.pct != null ? old.pct : 0.93;
      if (t.energy) r.pct = 0.8 + 0.19 * Math.random();
      levelOf(t, r.pct);
    }
  }
  // sparks curve from the tile into the core (to = origin) or, for embers, away from it; at = ms after now
  function sparkBurst(t, { n = 70, col = new THREE.Color(glowHex), delay = 0, spread = 250, life = 900, up = 0 } = {}) {
    const c = centreOf(t), r = () => new V3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5), nrm = normalOf(t);
    for (let i = 0; i < n; i++) {
      const from = c.clone().add(r().multiplyScalar(0.18));
      const bend = up ? from.clone().addScaledVector(nrm, up * 0.45).add(r().multiplyScalar(0.12)) : from.clone().multiplyScalar(0.55).add(r().multiplyScalar(0.5));
      sparks.push({ from, bend, to: up ? from.clone().addScaledVector(nrm, up) : null, at: performance.now() + delay + Math.random() * spread, life: life + Math.random() * 500, col });
    }
    while (sparks.length > SPARKS) sparks.shift();
  }
  // outward normal of the tile now (shell form .. rows)
  function normalOf(t, v = new V3()) {
    const ry = -shell.rotation.y;
    return v.copy(t.mesh.geometry.userData.cc).normalize().multiplyScalar(1 - spreadF).add(tmp2.set(Math.sin(ry) * spreadF, 0, Math.cos(ry) * spreadF)).normalize();
  }
  // hover lift in the flat rows (shell space); the rebirth's scale about the tile centre goes on top of it
  function lift(mesh, x = 0, z = 0) { const l = mesh.userData.lift ||= new V3(); l.set(x, 0, z); if (mesh.scale.x === 1 && !mesh.userData.swapping) mesh.position.copy(l); }
  const ease = x => 1 - Math.pow(1 - Math.max(0, Math.min(1, x)), 3);
  // busy (full frame rate): a session's rebirth, ripple or sparks; energy-cell renewals are the shell's idle life (30 fps is enough)
  let fxAt = performance.now(), fxBusy = false, sparksUntil = 0, actOn = true;
  const ACT_U = [['uWork', 'working'], ['uWait', 'waiting'], ['uIdle', 'idle']];
  function setActivity(on) { actOn = !!on; }
  function fxTile(t, now, dt) {
    let u = t.mesh.material.userData.u; const rip = t.ripple && now - t.ripple < 1600;
    // working / waiting / idle look eases over ~0.4 s (Parked and switched off: none)
    const act = actOn && t.s && !t.energy && t.s.group !== 'Parked' && !t.s.dim ? t.s.activity : null, k = Math.min(1, dt * 6);
    if (!t.energy) {                                                   // (blank cells: never active, never ripple; their material is shared)
      for (const [n, st] of ACT_U) u[n].value += ((act === st ? 1 : 0) - u[n].value) * k;
      u.uRipple.value = rip ? (now - t.ripple) / 1600 : -1; if (rip) fxBusy = true;
    }
    // energy cells renew every 30-90 s on the core's clock (faster in Max performance, slower in Night / Max efficiency)
    if (t.energy && spreadF === 0 && (t.left -= dt * motion.speed) <= 0) { t.left = 30 + Math.random() * 60; if (!t.reborn) { startRebirth(t, null); u = t.mesh.material.userData.u; } }   // its own material now: never drive the shared one
    const part = t.shellOnly || t.rowsOnly;                              // a tile shown in only one of the two places
    if (!t.reborn && !t.energy && !part) return;
    // energy cells and sphere-only tiles shrink away as the tiles spread flat; rows-only tiles grow in at the end of the spread
    const hide = t.energy || t.shellOnly ? Math.max(0, 1 - spreadF / 0.4) : t.rowsOnly ? Math.max(0, Math.min(1, (spreadF - 0.6) / 0.4)) : 1;
    const r = t.reborn;
    if (!r && t.restHide === hide) return;                             // settled (no swap, same size as last frame): nothing to move
    t.restHide = r ? -1 : hide;
    let P = { sc: 1, fl: 0, ang: 0, sink: 0, vis: true };
    if (r) {
      if (!t.energy) fxBusy = true;
      const e = (now - r.at) / 1000;
      if (e >= SWAP_LEN[r.mode]) {                                     // done: back to the plain tile
        r.label?.dispose(); t.reborn = null; swapDrive(u, 0, 0);
        u.uHasLabel.value = t.label ? 1 : 0; u.uLabel.value = t.label || null; levelOf(t, t.s ? t.s.pct : 0);
        if (t.energy && blankMat && t.mesh.material !== blankMat) { t.mesh.material.dispose(); t.mesh.material = blankMat; }   // back to the shared one
      } else {
        P = swapDrive(u, r.mode, e);                                   // Today: 0-0.6 s flare (old label), burst, 0.6-2.2 s re-form (new label)
        if (!r.sparked) { r.sparked = true; swapSparks(t, r.mode, now); }
        if (P.layer && !r.burst) {                                     // swap over: the fresh session's label and wear level
          r.burst = true; u.uLabel.value = t.label || null;
          if (r.mode < 3) { sparkBurst(t, { n: r.mode === 2 ? 80 : 70 }); if (!t.energy) sparksUntil = now + 1700; }
          if (r.mode > 1) levelOf(t, t.s ? t.s.pct : 0);
        }
        u.uHasLabel.value = (r.burst ? t.label : r.label) ? P.labelK : 0;
      }
    }
    const sc = P.sc * hide;
    const C = centreOf(t, tmp), nrm = P.sink || P.ang ? normalOf(t, tmp3) : tmp3;
    swapMesh(t.mesh, P, sc, C, nrm);
    t.mesh.userData.swapping = !!(P.sink || P.ang);
    if (t.mesh.userData.lift) t.mesh.position.add(t.mesh.userData.lift);
  }
  // context ring (setting): the session's context use on the rim; none on parked / archived tiles, picture plates and views
  let ringOn = true;
  function ringOf(t) {
    const s = t.s, u = t.mesh.material.userData.u;
    u.uRing.value = ringOn && s && !t.energy && !s.face && !s.newTile && !(lastFeed && lastFeed.view) && s.group !== 'Parked' && s.group !== 'Archived' && !s.dim ? Math.max(0, Math.min(1, +s.pct || 0)) : -1;
  }
  function setRing(on) { on = on !== false; if (on === ringOn) return; ringOn = on; for (const t of tiles) ringOf(t); }
  // wear level of a tile (as setPanelState sets it)
  function levelOf(t, pct) { pct = +pct || 0; const u = t.mesh.material.userData.u; u.uLevel.value = Math.max(0, Math.min(1, pct)); u.uHeat.value = u.uParked.value ? 0 : Math.max(0, Math.min(1, (pct - 0.9) / 0.1)); }
  const SHARD = new THREE.Color(1, 0.63, 0.27);
  function swapSparks(t, mode, now) {
    if (mode === 3) { sparkBurst(t, { n: 60, col: SHARD, delay: 350, spread: 500, life: 900 }); if (!t.energy) sparksUntil = now + 2300; }   // shards fall into the core
    else if (mode === 4) { sparkBurst(t, { n: 50, col: SHARD, delay: 100, spread: 1100, life: 600, up: 0.4 }); if (!t.energy) sparksUntil = now + 2300; }   // embers rise
  }
  function tickFx() {
    const now = performance.now(), dt = Math.min(1, (now - fxAt) / 1000); fxAt = now; fxBusy = false;
    for (const t of tiles) fxTile(t, now, dt);
    for (const t of cells5) fxTile(t, now, dt);
    sparkCloud.visible = sparks.length > 0;
    if (now < sparksUntil) fxBusy = true;
    if (!sparks.length) return;
    let live = 0;
    for (let i = 0; i < SPARKS; i++) {
      const s = sparks[i], k = s ? (now - s.at) / s.life : -1;
      if (!s || k < 0 || k > 1) { sparkCol[i * 4 + 3] = 0; if (s && k < 0) live++; continue; }
      live++;
      const a = 1 - k, p = tmp.copy(s.from).multiplyScalar(a * a).addScaledVector(s.bend, 2 * a * k);   // quadratic curve into the core (origin) or, for embers, to s.to
      if (s.to) p.addScaledVector(s.to, k * k);
      sparkPos[i * 3] = p.x; sparkPos[i * 3 + 1] = p.y; sparkPos[i * 3 + 2] = p.z;
      const j = i * 4;
      sparkCol[j] = Math.min(1, (s.col.r + 0.3) * 1.6); sparkCol[j + 1] = Math.min(1, (s.col.g + 0.3) * 1.6); sparkCol[j + 2] = Math.min(1, (s.col.b + 0.3) * 1.6);
      sparkCol[j + 3] = Math.sin(Math.PI * k);
    }
    if (!live) sparks.length = 0;
    sparkGeo.attributes.position.needsUpdate = sparkGeo.attributes.color.needsUpdate = true;
  }
  let lastFeed = null, swapMode = 6;
  function setSwap(n) { swapMode = [1, 2, 3, 4, 5, 6].includes(n) ? n : 6; }
  function setAlign(a) { align = a === 'left' || a === 'right' ? a : 'center'; }
  let flatShape = 'regular';
  // Show tiles: which groups show on the sphere / in the spread rows (views are not filtered)
  let filters = { sphere: {}, rows: {} };
  const ALL_ON = { mgr: true, active: true, parked: true, ungrouped: true, archived: false };
  const isOn = (where, s) => { const f = filters[where]; return (f[tileGroup(s)] ?? ALL_ON[tileGroup(s)]) !== false; };
  const isView = () => !!(lastFeed && lastFeed.groups);
  const onShell = s => isView() || isOn("sphere", s), inRows = s => isView() || isOn("rows", s);
  // returns true when the filters changed (the app then feeds the tiles again: the sphere rebuilds)
  function setFilters(f) {
    const norm = o => Object.fromEntries(Object.keys(ALL_ON).map(k => [k, !!(o && o[k] !== undefined ? o[k] : ALL_ON[k])]));
    const next = { sphere: norm(f && f.sphere), rows: norm(f && f.rows) };
    if (JSON.stringify(next) === JSON.stringify({ sphere: norm(filters.sphere), rows: norm(filters.rows) })) { filters = next; return false; }
    filters = next; key = ''; return true;
  }
  // growth off (app): the real feed's sphere keeps at least this many cells; returns true when the tiles were rebuilt
  let minCells = 0, openSpots = false;
  // these mark the tiles for a rebuild (the next setFeed) and return true; the app feeds them once after all its settings
  function setOpenSpots(on) { on = !!on; if (on === openSpots) return false; openSpots = on; key = ''; return true; }   // a view rebuilds on its next feed
  function setMinCells(n) {
    if (n === minCells) return false;
    minCells = n; key = ''; return true;
  }
  function setFlatShape(f) {   // the sphere's seats change too: marks a rebuild like the setters above
    f = f === 'hexagon' ? 'hexagon' : 'regular';
    if (f === flatShape) return false; flatShape = f; key = ''; return true;
  }
  function setLabelRes(n) { if (n === LABEL_RES) return false; LABEL_RES = n; key = ''; return true; }
  // labels as sharp as their tile gets on screen: px = device pixels per root unit at the rows, W x H = the rows' area
  // (root units); the label square spans 2 circR on the shell and about one column width in the rows
  let labelPx = 0, rowsW = 0, rowsH = 0;
  let labelCols = 0;
  function setLabelScale(W, H, px) {
    if (px === labelPx && W === rowsW && H === rowsH && minCols === labelCols) return;   // the row tile size changes the label size too
    labelPx = px; rowsW = W; rowsH = H; labelCols = minCols; if (lastFeed) setFeed(lastFeed);
  }
  function labelResOf(t, rowTw) {
    if (!labelPx) return LABEL_RES;
    const px = Math.max(2 * t.mesh.geometry.userData.circR, rowTw * (t.mgr ? 1.3 : 1)) * labelPx;
    return Math.min(LABEL_RES, Math.max(256, 2 ** Math.ceil(Math.log2(px))));
  }
  // returns true when the flat rows need laying out again (tiles rebuilt or regrouped)
  let gkey = '';
  function setFeed(feed) {
    const seen = new Set(), list = feed && Array.isArray(feed.sessions) ? feed.sessions : [];
    const all = list.filter(s => s && s.sessionId != null && !seen.has(s.sessionId) && seen.add(s.sessionId));   // one tile per session id
    feed = lastFeed = { ...feed, sessions: all };
    const sess = feed.groups ? all : all.filter(s => onShell(s) || inRows(s));   // a group hidden both places gets no tile
    const where = s => feed.groups ? '' : (onShell(s) ? 's' : '') + (inRows(s) ? 'r' : '');
    // the real feed rebuilds only when sessions come or go (or the manager changes); a group change just regroups the rows
    const gk = sess.map(s => s.sessionId + ':' + s.group), mgr = feed.view ? '' : (sess.find(s => s.group === 'Session Manager') || {}).sessionId;
    const k = (feed.view || '') + '#' + mgr + '#' + (feed.view ? gk : sess.map(s => String(s.sessionId) + where(s)).sort()).join('|');
    const before = new Map(tiles.map(t => [t.s.sessionId, t.s]));
    const colW = () => rowsW ? Math.max(pickCols(rowsW, rowsH).tw, feed.layout === 'ring' ? rowsW * 0.15 : 0) : 0;
    let changed = false;
    if (k !== key) {
      key = k; gkey = gk.join('|'); build(sess); changed = true;
      // a session that took over from one that had a tile (a swap): rebirth in the old one's seat
      if (!feed.view) for (const t of tiles) if (!before.has(t.s.sessionId) && t.s.parentId && before.has(t.s.parentId)) { t.res = labelResOf(t, colW()); startRebirth(t, before.get(t.s.parentId)); }
    } else if (gk.join('|') !== gkey) { gkey = gk.join('|'); regroup(sess); changed = true; }
    const byId = new Map(sess.map(s => [s.sessionId, s]));
    const rowTw = colW();
    for (const t of tiles) {
      const s = byId.get(t.s.sessionId) || t.s; t.s = s; t.res = labelResOf(t, rowTw);
      const lk = [s.title, s.model, s.effort, t.res, s.bg || 0, !!s.draft].join('|');              // redraw a label only when its text or size changes (picture plates have none)
      if (!s.face && t.lk !== lk) { const old = t.label; t.lk = lk; t.label = labelTexture(s, t.res); if (old && old !== t.mesh.material.userData.u.uLabel.value) old.dispose(); }
      const was = before.get(s.sessionId);
      // a clear-swap keeps the session (and its tile): the swap effect plays in place, from the wear it had before the clear
      if (!feed.view && was && s.renewedAt && s.renewedAt !== was.renewedAt && Date.now() - s.renewedAt < 120000 && !t.reborn) startRebirth(t, { ...was, pct: s.renewedPct != null ? s.renewedPct : was.pct });
      if (!feed.view && was && was.tokens != null && s.tokens != null && s.tokens - was.tokens >= 1500) t.ripple = performance.now();   // a working turn
      // mid-rebirth the old label shows only until the burst; after it the new one (a feed then must not bring the old back)
      setPanelState(t.mesh.material, { pct: (t.reborn && t.reborn.mode > 1 && !t.reborn.burst ? t.reborn.pct : s.pct) || 0, parked: s.group === 'Parked' || s.group === 'Archived' || s.dim, gold: t.mgr || s.gold, label: s.face ? null : t.reborn && !t.reborn.burst ? t.reborn.label : t.label });
      t.mesh.userData.session = s;
      ringOf(t);
    }
    return changed;
  }

  return { root, shell, setFeed, setRing, setRowSize, setMinCells, setOpenSpots, setFilters, setLabelRes, setLabelScale, setAlign, setFlatShape, setGlow, setMotion, setActivity, setSwap, prepareFlat, setSpread, lift, busy: () => fxBusy, cellCount: () => cellCount, flatRect: () => flatRect,
  meshes: () => tiles.filter(t => !t.shellOnly).map(t => t.mesh),   // picking: sphere-only tiles are gone in the rows
  headerMeshes: () => headers.children.filter(h => h.userData.session) };
}
