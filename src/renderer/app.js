// Renderer: Dyson sphere of session tiles. The shell turns slowly; hovering stops it and spreads every tile into flat rows.
// The sphere grows/shrinks with the number of sessions; the core is barely lit when idle, bright when hovered or talking.
// Frame rate, render scale, label resolution, colour, timings and the talking glow come from the settings window.
import * as THREE from '../../node_modules/three/build/three.module.js';
import { createSphere, tileGroup } from './sphere.js';
import { TIME, setPanelHover, setPanelWear } from './panel.js';
import { createConsole } from './console.js';
import { createChips } from './chips.js';

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
camera.position.z = 6;
// small procedural studio environment so the metal has something to reflect (no image files)
const envScene = new THREE.Scene(); envScene.background = new THREE.Color(0x1a1d22);
for (const [x, y, z, w, h, i] of [[0, 5, 2, 8, 1, 6], [-6, 1, 2, 1, 5, 4], [6, 0, 3, 1, 4, 3], [0, -4, 3, 7, 1, 1.5]]) { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.2), new THREE.MeshBasicMaterial({ color: new THREE.Color(i, i, i) })); m.position.set(x, y, z); envScene.add(m); }
// the WebGL renderer; a lost context (driver reset, GPU process restart) gets a fresh renderer, since the reflections
// are a render target that a restored context would have lost. MSAA only below 1.5x render scale (supersampling covers it)
let renderer = null, aaOn = true, lostT = 0;
function makeRenderer(aa) {
  clearTimeout(lostT);
  if (renderer) { const old = renderer; renderer = null; old.domElement.remove(); old.dispose(); old.forceContextLoss(); }
  try { renderer = new THREE.WebGLRenderer({ alpha: true, antialias: aa }); } catch (e) { console.error('WebGL', e); renderer = null; lostT = setTimeout(() => makeRenderer(aa), 3000); return; }
  aaOn = aa; renderer.setClearColor(0x000000, 0);
  document.body.prepend(renderer.domElement);
  const pmrem = new THREE.PMREMGenerator(renderer); scene.environment?.dispose(); scene.environment = pmrem.fromScene(envScene, 0.04).texture; pmrem.dispose();
  const cv = renderer.domElement;
  cv.addEventListener('webglcontextlost', () => { if (renderer && renderer.domElement === cv) { console.warn('WebGL context lost'); lostT = setTimeout(() => makeRenderer(aaOn), 2000); } });
  cv.addEventListener('webglcontextrestored', () => { if (renderer && renderer.domElement === cv) makeRenderer(aaOn); });
  if (pxPerUnit) resize();
}
scene.add(new THREE.HemisphereLight(0xffffff, 0x333344, 0.6));
const sun = new THREE.DirectionalLight(0xffffff, 2); sun.position.set(2, 3, 4); scene.add(sun);
const sphere = createSphere(scene);

// Claude-app panel behind the flat rows (and behind the core, so the core still glows in front of it)
const PANEL_Z = -2;
const panelMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false,
  uniforms: { uSize: { value: new THREE.Vector2(1, 1) }, uR: { value: 0.1 }, uOpacity: { value: 0 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform vec2 uSize; uniform float uR, uOpacity; varying vec2 vUv;
  void main() {
    vec2 p = (vUv - 0.5) * uSize, q = abs(p) - uSize * 0.5 + uR;
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uR;           // rounded-rect distance (world units)
    float aa = fwidth(d), inside = 1.0 - smoothstep(-aa, aa, d);
    float border = 1.0 - smoothstep(0.0, aa * 1.5, abs(d + 0.012));
    vec3 col = mix(vec3(0.071, 0.071, 0.067), vec3(0.17, 0.165, 0.155), border);  // darker Claude grey #121211, border #2b2a28
    gl_FragColor = vec4(col, inside * uOpacity);
  }`,
});
const panel = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), panelMat);
panel.position.z = PANEL_Z; panel.renderOrder = -2; panel.visible = false; scene.add(panel);
function placePanel() {
  const r = sphere.flatRect(), m = 0.1;                                      // root units, margin around the rows
  const k = scale * (6 - PANEL_Z) / (6 - 1.15 * scale);                    // root units at the rows -> world at the panel depth
  // full window height (corners past the screen edges), as wide as the rows
  const w = (r.x1 - r.x0 + 2 * m) * k, h = 2.2 * Math.tan(THREE.MathUtils.degToRad(15)) * (6 - PANEL_Z);
  panel.scale.set(w, h, 1); panel.position.x = ((r.x0 + r.x1) / 2) * k; panel.position.y = 0;
  panelMat.uniforms.uSize.value.set(w, h); panelMat.uniforms.uR.value = Math.min(w, h) * 0.04;
}

// size by session count: radius ~ sqrt(N) keeps tiles about the same size (fraction of the window's half-height)
// sphere size setting: small / medium (as before) / large / extra large scales that
const SIZE_K = { small: 0.7, medium: 1, large: 1.25, xlarge: 1.55 };
let sizeK = 1, sizeName = 'medium', growth = true;
// growth off: the sphere keeps one size; its cells are fixed for that size (spare ones hold empty energy cells); more sessions
// than cells: more, smaller cells at the same size
const FIXED = { small: { scale: 0.45, cells: 32 }, medium: { scale: 0.62, cells: 42 }, large: { scale: 0.8, cells: 92 }, xlarge: { scale: 1, cells: 122 } };
const sizeFor = n => !growth ? FIXED[sizeName].scale : Math.min(sizeK > 1.3 ? 1 : sizeK > 1 ? 0.95 : 0.88, Math.max(0.3 * sizeK, sizeK * (0.12 + 0.11 * Math.sqrt(Math.max(1, n)))));
let scale = 0.5, scaleTarget = 0.5;
const worldHalfH = Math.tan(THREE.MathUtils.degToRad(15)) * 6;
let pxPerUnit = 0, cx = 0, cy = 0, renderScale = 1.5, ready = false;   // ready: the whole module has run
// render scale x display scale, clamped so the drawing buffer stays within ~20 MP and the GPU's size limit
const MAX_PX = 20e6;
function resize() {
  const w = innerWidth, h = innerHeight;
  if (renderer) {
    const cap = Math.min(Math.sqrt(MAX_PX / Math.max(1, w * h)), renderer.capabilities.maxTextureSize / Math.max(1, w, h));
    renderer.setPixelRatio(Math.min(devicePixelRatio * renderScale, cap)); renderer.setSize(w, h);
  }
  camera.aspect = w / h; camera.updateProjectionMatrix();
  pxPerUnit = h / (2 * worldHalfH); cx = w / 2; cy = h / 2;
  labelScale();
}

let autoFold = true, keepCardsOpen = true, CLOSE_MS = 3000, FRAME_MS = 33, IDLE = 0.3, SPIN = (2 * Math.PI) / 120, glowOnSpeech = true;
let onTop = false, closeAt = 0, over = false, spreadOn = false, spread = 0, talking = false, level = 0.06, last = 0, spin = 1, keysOn = false;
let captionOn = true, capOff = 0, askCap = null, askPulse = false;   // speech caption, Voice Ask caption + thinking pulse (below)
const cap = document.body.appendChild(document.createElement('div')); cap.id = 'cap';
const persp = () => 6 / (6 - 1.15 * scale);      // flat rows sit nearer the camera than the sphere centre
function inside(x, y) {
  if (!spreadOn) return Math.hypot(x - cx, y - cy) <= scale * pxPerUnit;
  const r = sphere.flatRect(), k = scale * pxPerUnit * persp();
  const m = 0.1 * k;                                                       // the dark panel counts as the rows
  return x >= cx + r.x0 * k - m && x <= cx + r.x1 * k + m;              // the panel runs the full height
}
function startSpread() {
  spreadOn = true; spin = 0;
  layoutRows();
  refreshClaude(); wake();
}
// the rows fit between Claude's top strip and the bottom bar at the sphere's final size; whenever one of those changes
// while the panel is open (the strip redraws a moment after opening, a feed change resizes the sphere) they are laid out again
let layoutKey = '', feedDirty = false;
// a size / growth / Show tiles / empty spots change while spread: the rows fold into the sphere, it eases to its new size, and they spread again
let respread = null;   // null, or { rebuild } while folding; the rebuild waits until the rows are folded
const rowsKey = () => [topH(), scaleTarget, innerWidth, innerHeight].join('|');
function rowsArea(sc) {
  const ps = 6 / (6 - 1.15 * sc), px = sc * pxPerUnit * ps;               // pixels per root unit at the rows
  return { px, W: (2 * worldHalfH * camera.aspect * 0.94) / sc / ps, H: (innerHeight - BAR_PX - topH()) * 0.94 / px };
}
function layoutRows() {
  scale = scaleTarget; feedDirty = false; layoutKey = rowsKey();
  const { px, W, H } = rowsArea(scale);
  labelScale();
  sphere.prepareFlat(W, H, ((BAR_PX - topH()) / 2) / px);
}
// label textures follow the tiles' size on screen (device pixels; the resolution setting stays the ceiling)
function labelScale() {
  if (!ready || !pxPerUnit) return;
  const { px, W, H } = rowsArea(scaleTarget);
  sphere.setLabelScale(W, H, px * (renderer ? renderer.getPixelRatio() : devicePixelRatio * renderScale));
}
// the sphere sits under other windows, which still pass it the pointer: it opens only if nothing covers it there
// (one check in flight, at most every 200 ms; the answer is for the pointer's latest place)
let coverAt = 0, coverBusy = false, px = -1, py = -1;
function pointer(x, y) {
  px = x; py = y;
  const o = inside(x, y) || overChips(x, y);
  if (o && !spreadOn && !coverBusy && performance.now() - coverAt > 200) {
    coverAt = performance.now(); coverBusy = true;
    window.sphere.covered().then(c => { coverBusy = false; if (!c && !spreadOn && inside(px, py)) startSpread(); }, () => { coverBusy = false; });
  }
  closeAt = !o && spreadOn && !busy() && autoFold ? closeAt || performance.now() + CLOSE_MS : 0;  // off the rows: fold back after a few seconds
  if (o !== over) { over = o; window.sphere.hit(o); wake(); }
}
addEventListener('mousemove', e => { pointer(e.clientX, e.clientY); hoverTile(e.clientX, e.clientY); });
// a click-through window gets no events once the pointer has left it, so ask main where the pointer is while open;
// the fold runs here too, so it happens even when the frame loop is throttled
setInterval(() => { syncFold(performance.now()); if (spreadOn) window.sphere.cursor().then(p => pointer(p.x, p.y)); }, 250);
addEventListener('mouseleave', () => { if (spreadOn && !closeAt && !busy() && autoFold) closeAt = performance.now() + CLOSE_MS; if (over) { over = false; window.sphere.hit(false); } });

// flat rows: the tile under the pointer lights up and lifts; a click opens that session in the Claude window, which sits
// over the middle of the background until a click lands outside it (then it goes back and the rows fold in)
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
function tileAt(x, y) {
  ndc.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObjects(sphere.meshes(), false)[0];
  return hit ? hit.object : null;
}
let hovered = null;
function hoverTile(x, y) {
  if (hovered && !hovered.parent) hovered = null;                       // its tile was rebuilt
  setHover(spreadOn && spread > 0.9 ? tileAt(x, y) : null);
}
function setHover(m) {
  if (m === hovered) return;
  if (hovered) { setPanelHover(hovered.material, false); sphere.lift(hovered); }
  hovered = m;
  if (m) { setPanelHover(m.material, true); const a = -sphere.shell.rotation.y; sphere.lift(m, 0.15 * Math.sin(a), 0.15 * Math.cos(a)); }
  document.body.style.cursor = m ? 'pointer' : '';
}
// right-click on a session tile: its settings chip bar (SessionConsole_Stage4 Q1); anywhere else closes it
const chipBar = createChips();
// the chip bar, and any open drop menu (a console's mode or ⋯ menu can reach past the card): the window takes the pointer there
function overChips(x, y) {
  return [...(chipBar.on ? [document.getElementById('chips')] : []), ...document.querySelectorAll('.cmenu')].some(n => { const r = n.getBoundingClientRect(); return x >= r.left - 6 && x <= r.right + 6 && y >= r.top - 6 && y <= r.bottom + 6; });
}
// where the event went when it was sent (a handler may have removed the target since: a console line redrawn, a hit list closed)
const within = (e, sel) => e.composedPath().some(n => n instanceof Element && n.matches(sel));
addEventListener('contextmenu', e => {
  e.preventDefault();
  if (within(e, '#bar, #top, #sres, #rlist, #con, #chips, .cmenu')) return;
  const m = spreadOn && spread > 0.9 ? tileAt(e.clientX, e.clientY) : null, s = m && m.userData.session;
  if (s && s.link && !s.newTile && !s.press && !overlayOn) chipBar.open(s, e.clientX, e.clientY); else chipBar.close();
});
addEventListener('click', e => {
  if (chipBar.on) { if (!chipBar.contains(e.target)) chipBar.close(); return; }   // a click outside only closes the bar
  if (within(e, '#bar button, #bar .dd, #top button, #top .srow, #top .sfrow, #sres, #rlist, #con')) return;   // the rows' empty space counts as outside
  const m = spreadOn && spread > 0.9 ? tileAt(e.clientX, e.clientY) : null;
  const s = m && m.userData.session;
  const hd = !s && spreadOn && spread > 0.9 ? headerAt(e.clientX, e.clientY) : null;
  if (openTile(s || hd && hd.userData.session, !!hd, e.shiftKey)) return;
  if (overlayOn) closeCard();
  else if (view && !m) leaveView();             // empty space in a view: back to the session rows
});
// a tile's press (view plate / header) opens its card; a session opens its conversation in the wide card (Session Console), or with
// Shift its chat in the Claude window; false when it has neither
function openTile(s, header, shift) {
  if (s && s.newTile && !header) { openConsole(null); return true; }
  if (s && s.press) { if (con.close()) keysOff(); openPress(s.press, s.routine && !header ? 'detail' : 'wide'); return true; }
  if (s && (s.link || s.reader) && !shift && !header) { openConsole(s); return true; }
  if (s && s.link) { if (con.close()) keysOff(); overlayOn = true; barCard = ''; cardKind = 'narrow'; window.sphere.overlayOpen(overlayRect(), s.link).then(() => setTimeout(refreshClaude, 800)); return true; }
  return false;
}
function headerAt(x, y) {
  ndc.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObjects(sphere.headerMeshes(), false)[0];
  return hit ? hit.object : null;
}
// a click beside the card or Esc goes back one level: card -> spread-out panel (the panel folds when the pointer leaves it)
addEventListener('keydown', e => {
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT' || within(e, '#sres')) return;   // the console's reply box, the search box and its hits
  if (e.key === 'Escape' && chipBar.close()) return;
  if (e.key === 'Escape') { if (overlayOn) closeCard(); else if (view) leaveView(); else if (spreadOn) fold(); }
  else if (keysOn && KEY_DIR[e.key]) { e.preventDefault(); stepTile(...KEY_DIR[e.key]); }
  else if (keysOn && e.key === 'Enter' && hovered && hovered.parent) { e.preventDefault(); openTile(hovered.userData.session, false, e.shiftKey); }
});
// keyboard (Win+Alt+Space): the rows spread and the window takes focus; arrows pick the nearest tile that way in the rows,
// Enter opens it, Esc goes back one level. The hotkey again folds; focus lost (a click elsewhere, a chat opened) ends key mode
const KEY_DIR = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
// the console turns key mode on for its reply box (needKeys); leaving it for another card ends it there, since a Claude card
// keeps the focus here (no blur) and key mode left on would keep the rows from folding (busy)
function keysOff() { if (!keysOn) return; keysOn = false; window.sphere.keyFocus(false); }
window.sphere.onKeys?.(() => {
  if (keysOn) { keysOff(); fold(); return; }
  keysOn = true; window.sphere.keyFocus(true); closeAt = 0;
  if (!spreadOn) startSpread();
});
addEventListener('blur', keysOff);
const keyV = new THREE.Vector3();
function tileScreen(m) {   // the plate's middle in the rows, in window pixels
  m.localToWorld(keyV.copy(m.geometry.userData.fc)).project(camera);
  return { x: (keyV.x + 1) / 2 * innerWidth, y: (1 - keyV.y) / 2 * innerHeight };
}
function stepTile(dx, dy) {
  if (!spreadOn || spread < 0.9) return;
  const ms = sphere.meshes().filter(m => m.visible && m.userData.session && (m.userData.session.link || m.userData.session.reader || m.userData.session.press || m.userData.session.newTile) && m.geometry.userData.fc);
  if (!ms.length) return;
  const pts = ms.map(m => ({ m, p: tileScreen(m) }));
  const cur = hovered && hovered.parent && pts.find(q => q.m === hovered);
  if (!cur) { pts.sort((a, b) => a.p.y - b.p.y || a.p.x - b.p.x); setHover(pts[0].m); return; }   // first key: the top-left tile
  let best = null, bd = Infinity;
  for (const q of pts) {
    if (q === cur) continue;
    const ex = q.p.x - cur.p.x, ey = q.p.y - cur.p.y, along = ex * dx + ey * dy, side = Math.abs(ex * dy - ey * dx);
    if (along < 4 || side > along * 1.8) continue;   // only tiles that way (within about 60 degrees)
    const d = along + side * 1.2;                     // nearest that way; the offset rows count as below / above
    if (d < bd) { bd = d; best = q.m; }
  }
  if (best) setHover(best);
}
function closeCard() { overlayOn = false; barCard = ''; rlist.style.display = 'none'; rlist.classList.remove('edit'); if (rEditing) { rEditing = false; keysOff(); } if (con.close()) keysOff(); window.sphere.overlayClose(); }
// the console takes the wide card's place (no Claude window); the reply box needs the keyboard, so the window takes focus
function openConsole(s, hit, folder) {   // s null: the New session form alone (folder picked there); hit: a search hit to show
  if (overlayOn && !con.on) window.sphere.overlayClose();
  overlayOn = true; barCard = ''; cardKind = 'wide'; rlist.style.display = 'none'; prevFor = null; prev.style.display = 'none'; if (s) { con.open(s, hit); con.feed(realFeed); } else con.openNew(folder);
}
function openPress(name, kind) {
  if (con.close()) keysOff(); overlayOn = true; barCard = ''; cardKind = kind;
  if (kind === 'detail') { rlist.classList.remove('edit'); showRoutineList(name); }
  window.sphere.claudePress(overlayRect(), name).then(() => setTimeout(refreshClaude, 500));
}

// the fold-back timer and the window's place in front / behind (also run from a timer: rAF can be throttled)
function syncFold(now) {
  if (closeAt && now >= closeAt) { closeAt = 0; if (!busy()) spreadOn = false; }
  if (spreadOn !== onTop) { onTop = spreadOn; window.sphere.front(onTop); if (spreadOn) cap.classList.remove('on'); else { hoverTile(-1, -1); searchClose(); keysOff(); if (overlayOn) closeCard(); } }
}
// frame pacing: the frame-rate setting; folded and idle at most 30 fps; folded and covered by other windows about 2 fps
// (the clocks keep going, frames are only drawn less often)
let occluded = false, timer = 0, lastT = 0;
window.sphere.onOccluded?.(v => { occluded = !!v; if (!occluded) wake(); });
const restful = () => !askPulse && !spreadOn && spread === 0 && !over && !closeAt && !(talking && talking.on) && Math.abs(level - IDLE) < 0.01 && Math.abs(scaleTarget - scale) < 1e-3;
function paceMs() {
  if (!restful()) return FRAME_MS;
  if (occluded) return 500;
  const m = modeMotion();
  return m.spikes || m.lava || sphere.busy() ? FRAME_MS : Math.max(FRAME_MS, 1000 / 30);
}
function schedule(ms) { if (ms > 20) timer = setTimeout(() => { timer = 0; requestAnimationFrame(frame); }, ms - 12); else requestAnimationFrame(frame); }
function wake() { if (timer) { clearTimeout(timer); timer = 0; requestAnimationFrame(frame); } }
function frame(t) {
  const ms = paceMs();
  if (t - last < ms - 2) { schedule(ms - (t - last)); return; }
  last = t - last > ms * 1.5 ? t : last + ms;                       // keep the beat: 24 fps on 60 Hz stays 24, not 20
  schedule(ms);
  const dt = Math.min(Math.max(0.1, ms * 1.5 / 1000), (t - lastT) / 1000); lastT = t;
  syncFold(t);
  if (!spreadOn) { spin += (1 - spin) * Math.min(1, dt * 2); if (respread && spread === 0) { if (respread.rebuild) { onFeed(realFeed); feedDirty = true; } respread = null; } }   // folded meanwhile: rebuild once fully folded (no pop mid-fold)
  else if (respread) {
    if (spread === 0 && respread.rebuild) { respread.rebuild = false; onFeed(realFeed); }
    if (spread === 0 && Math.abs(scaleTarget - scale) < 0.02) { respread = null; layoutRows(); }   // near enough: the last bit snaps while folded
  }
  else if (feedDirty || rowsKey() !== layoutKey) layoutRows();
  sphere.shell.rotation.y += SPIN * spin * dt;
  const spreadTo = spreadOn && !respread ? 1 : 0;
  spread += (spreadTo - spread) * Math.min(1, dt * 7);
  if (Math.abs(spread - spreadTo) < 0.002) spread = spreadTo;
  sphere.setSpread(spread);
  if (view && !spreadOn && spread === 0) leaveView(true);           // a view ends once the panel has folded
  panel.visible = spread > 0.01; panelMat.uniforms.uOpacity.value = spread;
  if (panel.visible) placePanel();
  placeBar();
  scale += (scaleTarget - scale) * Math.min(1, dt * (respread ? 4 : 2));   // quicker while the rows wait to spread again
  sphere.root.scale.setScalar(scale); reportArea();
  // speaking: the core follows the voice's loudness (pauses fall back to the idle glow); hover / open rows: full
  let voice = 0;
  if (talking && talking.on && glowOnSpeech) voice = talking.env ? talking.env[Math.floor((Date.now() - talking.start) / talking.step)] || 0 : 1;
  const think = askPulse && !(talking && talking.on) ? 0.3 * (0.5 - 0.5 * Math.cos(t / 1000 * Math.PI)) : 0;   // Voice Ask thinking: a slow breath
  const target = over || spreadOn ? 1 : IDLE + (1 - IDLE) * Math.max(voice, think);
  level += (target - level) * Math.min(1, dt * (target > level ? 25 : talking && talking.on ? 9 : 4));
  sphere.setMotion(modeMotion(), dt);
  sphere.setGlow(null, level);
  TIME.value = t / 1000;
  if (renderer) renderer.render(scene, camera);
}
// the folded sphere's circle in window DIPs, for main's cover check (sent when it moves by a few pixels or settles)
let area = null;
function reportArea() {
  const a = { x: Math.round(cx), y: Math.round(cy), r: Math.round(scale * pxPerUnit) };
  if (area && a.x === area.x && a.y === area.y && (a.r === area.r || Math.abs(a.r - area.r) < 4 && Math.abs(scaleTarget - scale) > 1e-3)) return;
  area = a; window.sphere.sphereArea?.(a); if (cap.classList.contains('on')) placeCaption();
}
addEventListener('resize', () => { resize(); wake(); });
setTimeout(() => { if (!renderer) makeRenderer(true); }, 3000);  // normally made once the settings arrive (MSAA by render scale)
resize();
requestAnimationFrame(frame);

// the rows are laid out again only when the tiles were rebuilt or regrouped (the sphere's size is in the layout key)
// Show tiles: the sphere's feed holds the archived sessions only when a place shows them; the sphere is sized by the tiles on it
const shows = (where, g) => { const t = S && S[where]; return t ? t[g] !== false : g !== 'archived'; };
// the "+ New session" tile (SessionConsole_Stage3 Q4): after the active sessions, in the next empty spot; it opens the New session form
const NEW_TILE = { sessionId: 'new:tile', title: '+ New session', group: 'Active', newTile: true, pct: 0, tokens: null, activity: null, link: null };
function sphereFeed(f) {
  const arch = Array.isArray(f.archived) && (shows('tilesSphere', 'archived') || shows('tilesRows', 'archived')) ? f.archived : [];
  return { ...f, sessions: [...f.sessions, ...(S && S.appControl ? [NEW_TILE] : []), ...arch] };
}
const onSphere = f => f.sessions.filter(s => shows('tilesSphere', tileGroup(s))).length;
function onFeed(f) {
  if (!f || !Array.isArray(f.sessions)) return;                    // a broken read: keep what is shown
  realFeed = f; updateWaiting(f); con.feed(f); const sf = sphereFeed(f); scaleTarget = sizeFor(onSphere(sf)); wake(); labelScale();
  if (!view) { if (sphere.setFeed(sf)) feedDirty = true; } else if (view === 'projects') showView('projects');
}
// ---- bottom bar on the dark panel: Claude app settings | General settings | mode + Theseus settings (mode, core, voice) ----
const BAR_PX = 96;
// mode colours come from the settings (normal = the core colour)
const MODES = [['normal', 'Normal', '#3da5ff'], ['worker', 'Worker', '#e67e22'], ['night', 'Night', '#3c60be'], ['weekend', 'Weekend', '#8c50b9'], ['performance', 'Max perf', '#dc3c3c'], ['efficiency', 'Max efficiency', '#2ecc71']];
let curMode = { mode: 'normal', pending: null }, S = null;
function modeColours(s) {
  for (const m of MODES) m[2] = m[0] === 'normal' ? s.glow : (s.modeColors[m[0]] || m[2]);
  for (const o of ddList.children) o.querySelector('.dot').style.background = MODES.find(m => m[0] === o.dataset.mode)[2];
}
// the core shows the mode it is in (not a pending switch) when "core follows mode" is on
// the mode the core is in (not a pending switch) sets its speed and brightness; Max perf throws spikes, Max efficiency breathes,
// Night shows a moon crescent, Weekend lava-lamp blobs
function modeMotion() {
  const m = curMode.mode || 'normal';
  if (!S || !S.modeMotion || m === 'normal') return { speed: 1, bright: 1, spikes: 0, breathe: 0, moon: 0, lava: 0 };
  return { speed: S.modeSpeed[m] || 1, bright: S.modeBright[m] || 1, spikes: m === 'performance' ? S.spikeStrength : 0, breathe: m === 'efficiency' ? 1 : 0,
    moon: m === 'night' ? 1 : 0, lava: m === 'weekend' ? 1 : 0 };   // Night = moon, Weekend = lava lamp
}
function coreColour() {
  if (!S) return;
  const m = MODES.find(x => x[0] === curMode.mode);
  sphere.setGlow(S.coreFollowsMode && m ? m[2] : S.glow, level);
}
const bar = document.createElement('div'); bar.id = 'bar';
bar.innerHTML = `<button class="b" id="bClaude"><span class="i">✳</span>Claude settings</button>
  <button class="b" id="bGeneral"><span class="i">⬡</span>General settings</button>
  <button class="b" id="bWait" style="display:none" title="Open the next session waiting on you"><span class="i">●</span><span class="n"></span></button>
  <div class="r"><div class="dd" id="mode"><div class="cur"><span class="dot"></span><span class="t">Mode</span><span class="car">▾</span></div><div class="list"></div></div>
  <button class="b" id="bTheseus"><span class="i">⚙</span>Theseus settings</button></div>`;
document.body.appendChild(bar);
const ddList = bar.querySelector('.list'), dd = bar.querySelector('#mode');
// waiting chip: sessions waiting on your answer (their tiles pulse yellow); a click opens the next one in turn
const bWait = bar.querySelector('#bWait'); let waitList = [], waitAt = 0;
function updateWaiting(f) {
  waitList = (f && Array.isArray(f.sessions) ? f.sessions : []).filter(s => s.activity === 'waiting' && (s.link || s.reader) && s.group !== 'Parked' && shows('tilesRows', tileGroup(s)));
  bWait.style.display = waitList.length ? '' : 'none';
  bWait.querySelector('.n').textContent = waitList.length + ' waiting';
}
bWait.onclick = () => {
  if (!waitList.length) return;
  const s = waitList[waitAt++ % waitList.length];
  if (!s.link) { openConsole(s); return; }   // a reader session: no place in the Claude app
  if (con.close()) keysOff(); overlayOn = true; barCard = ''; cardKind = 'narrow'; window.sphere.overlayOpen(overlayRect(), s.link).then(() => setTimeout(refreshClaude, 800));
};
for (const [id, name, col] of MODES) {
  const o = document.createElement('div'); o.className = 'opt'; o.dataset.mode = id; o.innerHTML = `<span class="dot" style="background:${col}"></span>${name}`;
  o.onclick = e => { e.stopPropagation(); dd.classList.remove('open'); window.sphere.setMode(id).then(showMode); };
  ddList.appendChild(o);
}
function showMode(m) {
  curMode = m; coreColour();
  const cur = MODES.find(x => x[0] === (m.pending || m.mode)) || MODES[0];
  dd.querySelector('.cur .dot').style.background = cur[2];
  dd.querySelector('.cur .t').textContent = cur[1] + ' mode' + (m.pending && m.pending !== m.mode ? ' (switching…)' : '');
}
dd.querySelector('.cur').onclick = e => { e.stopPropagation(); dd.classList.toggle('open'); if (dd.classList.contains('open')) window.sphere.mode().then(showMode); };
addEventListener('click', e => { if (!e.target.closest?.('#mode')) dd.classList.remove('open'); });
// a card or menu open keeps the tile rows up (setting "Keep cards open"); otherwise they fold back after the delay
function busy() { return overlayOn || keysOn || chipBar.on || sRes.style.display === 'block' || keepCardsOpen && (dd.classList.contains('open') || rlist.style.display === 'block'); }
function fold() { spreadOn = false; closeAt = 0; dd.classList.remove('open'); chipBar.close(); }   // a view ends once the panel has folded (frame)

// ---- views: Artifacts / Projects / Routines turn the panel's tiles into their own plates (spec: SessionSphere_Views_Spec.md) ----
let view = null, realFeed = { sessions: [] }, lastSnap = {};
const VIEW_OF = { Artifacts: 'artifacts', 'Projects Beta': 'projects', Projects: 'projects', Routines: 'routines' };
const ROUTINE = /^(Idle|Unread response|Running|Failed|Error|Paused) (.+)$/;
// a view opened (or refreshed) while another opened or the panel left wins; a late picture load never re-opens a closed view
let viewTok = 0;
async function showView(kind) {
  const s = lastSnap, tok = ++viewTok, refresh = view === kind;
  let vf;
  if (kind === 'artifacts') {
    const pinned = s.pinned || [], rest = (s.artifacts || []).filter(n => !pinned.includes(n));
    const pics = await Promise.all([...pinned, ...rest].map(n => window.sphere.thumb(n).catch(() => null)));
    if (tok !== viewTok || refresh && view !== kind) return;
    const item = (n, i, group) => ({ sessionId: 'a:' + n, title: n, group, press: n, face: true, pic: pics[i], sub: 'Not opened yet' });
    vf = { view: 'artifacts', groups: ['Pinned', 'Artifacts'], headerPress: 'Artifacts',
      sessions: [...pinned.map((n, i) => item(n, i, 'Pinned')), ...rest.map((n, i) => item(n, pinned.length + i, 'Artifacts'))] };
  } else if (kind === 'projects') {
    // sessions grouped by working folder, biggest folder first; the titles open Claude's Projects page
    const by = new Map();
    for (const x of realFeed.sessions) { const f = x.folder || 'Other'; if (!by.has(f)) by.set(f, []); by.get(f).push({ ...x, group: f }); }
    const groups = [...by.keys()].sort((a, b) => (a === 'Other') - (b === 'Other') || by.get(b).length - by.get(a).length);
    vf = { view: 'projects', groups, headerPress: 'Projects Beta', sessions: groups.flatMap(g => by.get(g)) };
  } else {
    // routines: a ring round the core; the state shows under the name, unread ones get the gold trim
    vf = { view: 'routines', groups: ['Routines'], layout: 'ring', sessions: (s.routines || []).map(n => {
      const m = ROUTINE.exec(n), st = m ? m[1] : '';
      return { sessionId: 'r:' + n, title: m ? m[2] : n, model: st, group: 'Routines', press: n, routine: true, gold: /^Unread/.test(st), dim: st === 'Idle' };
    }) };
  }
  if (!vf.sessions.length) return;
  view = kind; const changed = sphere.setFeed(vf); markView();
  if (!refresh) startSpread(); else if (changed) feedDirty = true;   // a refresh (new pictures, a feed) keeps the rows unless they changed
}
function leaveView(quiet) {
  viewTok++; view = null; rlist.style.display = 'none'; sphere.setFeed(sphereFeed(realFeed)); markView();
  if (!quiet) startSpread();
}
function markView() { for (const b of top.querySelectorAll('.row [data-press]')) b.classList.toggle('on', !!view && VIEW_OF[b.dataset.press] === view); }
// routines open as list + detail: the routine list on the left of the card, its page in the card
const rlist = document.createElement('div'); rlist.id = 'rlist'; document.body.appendChild(rlist);
// Session Console view (console.js): a session's conversation + reply box in the wide card
const needKeys = () => { if (!keysOn) { keysOn = true; window.sphere.keyFocus(true); closeAt = 0; } };
const con = createConsole({ needKeys, close: closeCard, openClaude: s => { keysOff(); overlayOn = true; barCard = ''; cardKind = 'narrow'; window.sphere.overlayOpen(overlayRect(), s.link).then(() => setTimeout(refreshClaude, 800)); } });
// a routine row gets Edit prompt when a local prompt (~/.claude/scheduled-tasks/<id>/SKILL.md) matches its name;
// local prompts no row matches are listed under the routines
const slug = t => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
let rCur = '', rLocal = [], rEditing = false;
function showRoutineList(cur) {
  if (rEditing) { rEditing = false; keysOff(); }
  rCur = cur; const used = new Set();
  const ed = id => id ? `<button class="ed" data-ed="${esc(id)}" title="Edit prompt">Edit</button>` : '';
  rlist.innerHTML = '<div class="h">Routines</div>' + (lastSnap.routines || []).map(n => {
    const m = ROUTINE.exec(n), st = m ? m[1].split(' ')[0].toLowerCase() : 'idle', lb = m ? m[2] : n, s = slug(lb);
    const loc = rLocal.find(r => !used.has(r.id) && (s === r.id || s.startsWith(r.id + '-') || slug(r.name) === s)); if (loc) used.add(loc.id);
    return `<div class="rw"><button class="it${n === cur ? ' on' : ''}" data-r="${esc(n)}"><span class="st ${st}"></span><span class="lb">${esc(lb)}</span></button>${ed(loc && loc.id)}</div>`;
  }).join('') + (rLocal.some(r => !used.has(r.id)) ? '<div class="h">Local prompts</div>' + rLocal.filter(r => !used.has(r.id)).map(r =>
    `<div class="rw"><span class="it lp" title="${esc(r.description)}"><span class="lb">${esc(r.name)}</span></span>${ed(r.id)}</div>`).join('') : '');
  placeRlist(RLIST_W); refreshLocal();
}
function placeRlist(w) {
  const f = overlayRect();
  Object.assign(rlist.style, { display: 'block', left: f.x - w - 12 + 'px', top: f.y - TITLE_PX + 'px', width: w + 'px', height: f.h + TITLE_PX + 'px' });
}
const refreshLocal = () => window.sphere.routinePrompts('list').then(r => {
  const k = JSON.stringify(r && r.items || []); if (k === JSON.stringify(rLocal)) return;
  rLocal = r && r.items || []; if (rlist.style.display === 'block' && !rEditing) showRoutineList(rCur);
}).catch(() => {});
// the editor takes the whole card: the Claude window steps aside while it is open and comes back on Save / Cancel
async function editPrompt(id) {
  const r = await window.sphere.routinePrompts('read', id); if (!r || !r.ok) return;
  const f = overlayRect(), x0 = cardKind === 'detail' ? f.x - RLIST_W - 12 : f.x;
  rEditing = true; needKeys(); rlist.classList.add('edit'); window.sphere.overlayClose();
  rlist.innerHTML = `<div class="h">Edit prompt: ${esc(id)}</div><textarea class="rta" spellcheck="false"></textarea>` +
    '<div class="rbar"><span class="rwhy"></span><button class="rb" data-x="cancel">Cancel</button><button class="rb go" data-x="save">Save</button></div>';
  const ta = rlist.querySelector('.rta'); ta.value = r.text; ta._id = id;
  Object.assign(rlist.style, { display: 'flex', left: x0 + 'px', top: f.y - TITLE_PX + 'px', width: f.x + f.w - x0 + 'px', height: f.h + TITLE_PX + 'px' }); ta.focus();
}
function editDone() {
  rEditing = false; keysOff(); rlist.classList.remove('edit');
  if (rCur) openPress(rCur, 'detail'); else closeCard();
}
rlist.addEventListener('click', async e => {
  const b = e.target.closest('[data-r], [data-ed], [data-x]'); if (!b) return;
  if (b.dataset.r) return openPress(b.dataset.r, 'detail');
  if (b.dataset.ed) return editPrompt(b.dataset.ed);
  const ta = rlist.querySelector('.rta');
  if (b.dataset.x === 'save' && ta) {
    const r = await window.sphere.routinePrompts('save', ta._id, ta.value);
    if (!r || !r.ok) { rlist.querySelector('.rwhy').textContent = 'Not saved: ' + (r && r.why || 'error'); return; }
  }
  editDone();
});
rlist.addEventListener('keydown', e => { if (e.key === 'Escape' && rEditing) { e.stopPropagation(); editDone(); } });
const RLIST_W = 240;
// the three settings buttons open in the card like a chat: Claude's settings in the wide card, the sphere's in the narrow one
// a second click on the button whose card is open closes it
let barCard = '';
function barButton(id, kind, open) {
  bar.querySelector('#' + id).onclick = () => {
    if (overlayOn && barCard === id) { closeCard(); return; }
    if (con.close()) keysOff(); overlayOn = true; cardKind = kind; barCard = id; open();
  };
}
barButton('bClaude', 'wide', () => window.sphere.claudeSettings(overlayRect()).then(() => setTimeout(refreshClaude, 800)));
barButton('bGeneral', 'narrow', () => window.sphere.openSettings('general', overlayRect()));
barButton('bTheseus', 'narrow', () => window.sphere.openSettings('theseus', overlayRect()));
let barO = -1;
function placeBar() {
  const o = Math.max(0, Math.min(1, (spread - 0.5) / 0.4));
  if (!o && !barO) return;                                           // folded: nothing to move
  barO = o;
  for (const el of [bar, top]) { el.style.opacity = o; el.style.pointerEvents = o > 0.9 ? 'auto' : 'none'; }
  frameEl.style.display = overlayOn && !con.on && o > 0.9 ? 'block' : 'none';
  if (!o) { dd.classList.remove('open'); return; }
  const r = sphere.flatRect(), k = scale * pxPerUnit * persp();
  const L = Math.max(8, cx + (r.x0 - 0.1) * k + 16) + 'px', R = Math.max(8, innerWidth - (cx + (r.x1 + 0.1) * k) + 16) + 'px';
  bar.style.left = top.style.left = L; bar.style.right = top.style.right = R;
  if (con.on) { const f = overlayRect(); con.place(f.x, f.y - TITLE_PX, f.w, f.h + TITLE_PX); }
  else if (overlayOn) { const f = overlayRect(); Object.assign(frameEl.style, { left: f.x - 1 + 'px', top: f.y - 1 + 'px', width: f.w + 2 + 'px', height: f.h + 2 + 'px' }); }
}

// ---- top groups on the dark panel: Claude's title-bar controls, then rows New/Projects/..., Routines, Pinned ----
// They mirror the Claude window (read through UI Automation); a click presses the same button there, with the window
// shown over the background.
let overlayOn = false, csKey = '', cardKind = 'narrow';   // card: 'narrow' for chats, 'wide' for list and gallery pages
const top = document.createElement('div'); top.id = 'top';
document.body.appendChild(top);
const topA = document.createElement('div'), srow = document.createElement('div'), topB = document.createElement('div');   // strip | search row | nav rows
const sfrow = document.createElement('div');   // the search filter chips (new ideas 3), under the box
srow.className = 'row srow'; sfrow.className = 'row sfrow'; top.append(topA, srow, sfrow, topB);
const TITLE_PX = 36;
let topPx = 0; new ResizeObserver(() => { topPx = top.offsetHeight; }).observe(top);   // no layout read per frame
const topH = () => (topPx || 150) + 24;                          // room the rows leave at the top of the panel
// soft shadow behind the chat card (the mask window draws its rounded corners and border)
const frameEl = document.createElement('div'); frameEl.id = 'frame';
document.body.appendChild(frameEl);
const svg = d => `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const IC = {
  Menu: svg('<path d="M2.5 4h11M2.5 8h11M2.5 12h11"/>'), Sidebar: svg('<rect x="2" y="2.5" width="12" height="11" rx="2"/><path d="M6 2.5v11"/>'),
  Back: svg('<path d="M10 3 5 8l5 5"/>'), Forward: svg('<path d="m6 3 5 5-5 5"/>'),
  Claude: svg('<path d="M3 3.5h10v7H7l-3 2.5v-2.5H3z"/>'), Code: svg('<path d="m5.5 4.5-3 3.5 3 3.5M10.5 4.5l3 3.5-3 3.5"/>'),
  Terminal: svg('<path d="m3 4.5 3 3-3 3M8 11.5h5"/>'), Changes: svg('<path d="M8 2.5v6M5 5.5h6M5 12.5h6"/>'),
  Browser: svg('<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c2 2 2 9 0 11M8 2.5c-2 2-2 9 0 11"/>'),
  Files: svg('<path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/>'),
  'View options': svg('<circle cx="8" cy="3.5" r=".6"/><circle cx="8" cy="8" r=".6"/><circle cx="8" cy="12.5" r=".6"/>'),
  Search: svg('<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/>'), New: svg('<path d="M8 3v10M3 8h10"/>'),
  Projects: svg('<path d="M2.5 5h11v8h-11zM4 5V3h8v2"/>'), Artifacts: svg('<path d="M8 2.5 13 5.5 8 8.5 3 5.5zM3 8.5l5 3 5-3M3 11l5 3 5-3"/>'),
  Routines: svg('<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.5"/>'), Customize: svg('<rect x="2.5" y="5" width="11" height="8" rx="1.5"/><path d="M6 5V3.5h4V5"/>'),
  Pin: svg('<rect x="3" y="3" width="10" height="10" rx="2"/><path d="M6 10V7.5M8 10V6M10 10V8"/>'),
};
const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ib = (name, icon, extra = '') => `<button class="ib${extra}" data-press="${esc(name)}" title="${esc(name)}">${icon}</button>`;
const item = (name, label, icon, extra = '') => `<button class="it" data-press="${esc(name)}"><span class="ic">${icon}</span><span class="lb">${esc(label)}</span>${extra}</button>`;
function renderTop(s) {
  const k = JSON.stringify([s.title, s.project, s.mode, s.sidebar, s.nav, s.routines, s.pinned]);
  claudeProject = s.project || '';
  if (k === csKey) return; csKey = k;
  // the search row (srow, stage 5 step 6) stays put between the strip and the nav rows, so typing survives a redraw;
  // Claude's own search moved to a small button at its end
  srow.querySelector('.sc').style.display = (s.nav || []).includes('Search') ? '' : 'none';
  const nav =(s.nav || []).filter(n => n !== 'Search').map(n => { const base = n.replace(/ Beta$/, ''); return item(n, base, IC[base] || IC.New, n.endsWith(' Beta') ? '<span class="beta">Beta</span>' : ''); }).join('');
  // routine buttons are named "<state> <name>" (Idle / Unread response / Running ...)
  const rt = (s.routines || []).map(n => {
    const m = /^(Idle|Unread response|Running|Failed|Error|Paused) (.+)$/.exec(n), st = m ? m[1].split(' ')[0].toLowerCase() : 'idle';
    return item(n, m ? m[2] : n, `<span class="st ${st}"></span>`);
  }).join('');
  const pin = (s.pinned || []).map(n => item(n, n, IC.Pin)).join('');
  topA.innerHTML = `<div class="strip">${ib('Menu', IC.Menu)}${ib(s.sidebar ? 'Hide sidebar' : 'Show sidebar', IC.Sidebar)}${ib('Back', IC.Back)}${ib('Forward', IC.Forward)}
    <div class="seg">${ib('Claude', IC.Claude, s.mode === 'Claude' ? ' on' : '')}${ib('Code', IC.Code, s.mode === 'Code' ? ' on' : '')}</div>
    <span class="title">${esc(s.title || '')}</span>${s.project ? `<span class="proj">${esc(s.project)}</span>` : ''}<span class="sp"></span>
    ${['Terminal', 'Changes', 'Browser', 'Files', 'View options'].map(n => ib(n, IC[n])).join('')}</div>`;
  // Routines and Pinned stay one line each and scroll sideways (the mouse wheel too); a redraw keeps where they were scrolled
  const was = [...topB.querySelectorAll('.rs')].map(r => r.scrollLeft);
  topB.innerHTML = `<div class="row"><span class="h"></span>${nav}</div><div class="row"><span class="h">Routines</span><div class="rs">${rt}</div></div><div class="row pins"><span class="h">Pinned</span><div class="rs">${pin}</div></div>`;
  topB.querySelectorAll('.rs').forEach((r, i) => { r.scrollLeft = was[i] || 0; rsEdge(r); });
}
const rsEdge = r => { r.classList.toggle('fl', r.scrollLeft > 1); r.classList.toggle('fr', r.scrollLeft + r.clientWidth < r.scrollWidth - 1); };   // fade the side with more
topB.addEventListener('wheel', e => {
  const r = e.target.closest('.rs'); if (!r || r.scrollWidth <= r.clientWidth) return;
  e.preventDefault(); r.scrollLeft += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
}, { passive: false });
topB.addEventListener('scroll', e => { if (e.target.classList && e.target.classList.contains('rs')) rsEdge(e.target); }, true);
addEventListener('resize', () => topB.querySelectorAll('.rs').forEach(rsEdge));
top.addEventListener('click', e => {
  const b = e.target.closest('[data-press]'); if (!b) return;
  const v = b.closest('.row') && VIEW_OF[b.dataset.press];
  if (v) { if (overlayOn) closeCard(); if (view === v) leaveView(); else showView(v); return; }
  if (con.close()) keysOff(); overlayOn = true; barCard = ''; cardKind = kindFor(b); prevFor = null; prev.style.display = 'none';
  window.sphere.claudePress(overlayRect(), b.dataset.press).then(() => setTimeout(refreshClaude, 500));
});
// chats (New, Search) keep the narrow card; nav pages, routines and pinned items get the wide one; title-bar buttons keep it
function kindFor(b) { if (b.closest('.strip')) return cardKind; return /^(New|Search)$/.test(b.dataset.press) ? 'narrow' : 'wide'; }
// Pinned hover preview: after 0.4 s, the page's last picture under the item (none yet = nothing; hidden while a card is open,
// since Claude's window would sit on top of it)
const prev = document.createElement('div'); prev.id = 'preview'; document.body.appendChild(prev);
let prevT = 0, prevFor = null;
top.addEventListener('mouseover', e => {
  const b = e.target.closest('.pins .it'); if (b === prevFor) return;
  prevFor = b; clearTimeout(prevT); prev.style.display = 'none'; if (!b || overlayOn) return;
  prevT = setTimeout(() => window.sphere.thumb(b.dataset.press).then(url => {
    if (!url || prevFor !== b || overlayOn) return;
    const r = b.getBoundingClientRect(), w = 340;
    prev.innerHTML = `<img src="${url}"><div>${esc(b.dataset.press)}</div>`;
    Object.assign(prev.style, { display: 'block', top: r.bottom + 8 + 'px', left: Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + 'px', width: w + 'px' });
  }), 400);
});
top.addEventListener('mouseleave', () => { prevFor = null; clearTimeout(prevT); prev.style.display = 'none'; });

// ---- search (SessionConsole_Stage5 step 6): the box over the session rows finds a text in every session's conversation
// (your messages and Claude's replies; main reads the transcripts, at most 3 s); a hit opens that session's console at the
// message. The window takes the keyboard while the box is used (as in key mode); Esc clears, then leaves the box.
srow.innerHTML = `<span class="h"></span><label class="sb">${IC.Search}<input type="text" placeholder="Search conversations" spellcheck="false" aria-label="Search conversations"><button class="sx" title="Clear" aria-label="Clear search">×</button></label><button class="ib sc" data-press="Search" title="Search in the Claude app">${IC.Claude}</button>`;
const sIn = srow.querySelector('input'), sRes = document.createElement('div'); sRes.id = 'sres'; sRes.setAttribute('role', 'listbox'); document.body.appendChild(sRes);
let sTok = 0, sT = 0;
const searchOpen = () => sRes.style.display === 'block';
function searchClose() { sTok++; clearTimeout(sT); sRes.style.display = 'none'; sRes.replaceChildren(); }
function searchRun() {
  clearTimeout(sT);
  const t = sIn.value.trim(); if (t.length < 2) { searchClose(); return; }
  const o = filterOpts(); if (o.why) { searchShow([], o.why); return; }
  const my = ++sTok; searchShow([], 'Searching…');
  window.sphere.search(t, o).then(r => {
    if (my !== sTok || (r && r.why === 'cancelled')) return;
    if (!r || !r.ok) searchShow([], (r && r.why) || 'Search failed');
    else searchShow(r.hits, r.hits.length ? (r.done ? '' : 'The first hits only (the search stopped early)') : 'No conversation has this' + (filtersOn() ? ' (with these filters)' : ''));
  }, () => {});
}
function searchShow(hits, note) {
  const b = sIn.closest('.sb').getBoundingClientRect();
  Object.assign(sRes.style, { display: 'block', left: b.left + 'px', top: b.bottom + 6 + 'px', width: Math.min(innerWidth - b.left - 16, Math.max(b.width, 520)) + 'px', maxHeight: Math.max(160, innerHeight - b.bottom - 140) + 'px' });
  const out = []; let last = '';
  for (const h of hits) {
    if (h.sessionId !== last) { last = h.sessionId; const t = document.createElement('div'); t.className = 'stt'; t.textContent = h.title || 'Untitled session'; out.push(t); }
    const d = document.createElement('button'); d.className = 'sh'; d._h = h; d.setAttribute('role', 'option');
    const who = document.createElement('span'); who.className = 'sw'; who.textContent = h.role === 'user' ? 'You' : 'Claude';
    const sn = document.createElement('span'), m = document.createElement('mark'); sn.className = 'sn'; m.textContent = h.snippet[1]; sn.append(h.snippet[0], m, h.snippet[2]);
    d.append(who, sn); if (h.ts) d.title = new Date(h.ts).toLocaleString(); out.push(d);
  }
  if (note) { const n = document.createElement('div'); n.className = 'sm'; n.textContent = note; out.push(n); }
  sRes.replaceChildren(...out);
}
// filter chips (new ideas 3): You / Claude (one side only; both or neither = both), This folder (the open console's session's
// folder, else the Claude app's current project), and a date chip that cycles Any time / Today / 7 days / 30 days.
// A change reruns the search; the chips keep their state until the app closes
const DATES = ['Any time', 'Today', '7 days', '30 days'], sf = { you: false, claude: false, folder: false, date: 0 };
let claudeProject = '';
sfrow.innerHTML = `<span class="h"></span><button class="fc" data-f="you">You</button><button class="fc" data-f="claude">Claude</button><button class="fc" data-f="folder">This folder</button><button class="fc" data-f="date">Any time</button>`;
const filtersOn = () => sf.you !== sf.claude || sf.folder || sf.date > 0;
const curFolder = () => (con.on && con.session && con.session.folder) || claudeProject || null;
function filterOpts() {
  const o = {};
  if (sf.you !== sf.claude) o.who = sf.you ? 'user' : 'assistant';
  if (sf.folder) { o.folder = curFolder(); if (!o.folder) return { why: 'No folder to filter by: open a session first, or turn This folder off' }; }
  if (sf.date === 1) { const d = new Date(); d.setHours(0, 0, 0, 0); o.since = d.getTime(); }
  else if (sf.date > 1) o.since = Date.now() - (sf.date === 2 ? 7 : 30) * 864e5;
  return o;
}
function drawChips() {
  for (const b of sfrow.querySelectorAll('.fc')) {
    const f = b.dataset.f, on = f === 'date' ? sf.date > 0 : sf[f];
    b.classList.toggle('on', on); b.setAttribute('aria-pressed', on);
    if (f === 'date') b.textContent = DATES[sf.date];
    if (f === 'folder') b.title = sf.folder ? 'Only sessions in ' + (curFolder() || '(no folder yet)') : "Only sessions in the open session's folder";
  }
}
sfrow.addEventListener('mousedown', e => { if (e.target.closest('.fc')) e.preventDefault(); });   // the box keeps the keyboard
sfrow.addEventListener('click', e => {
  const b = e.target.closest('.fc'); if (!b) return; e.stopPropagation();
  const f = b.dataset.f; if (f === 'date') sf.date = (sf.date + 1) % DATES.length; else sf[f] = !sf[f];
  drawChips(); if (sIn.value.trim().length >= 2) searchRun();
});
drawChips();
srow.querySelector('.sb').addEventListener('mousedown', () => { needKeys(); setTimeout(() => sIn.focus(), 60); });   // the box's icon and edge too
sIn.addEventListener('input', () => { clearTimeout(sT); sT = setTimeout(searchRun, 350); });
sIn.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); searchRun(); }
  else if (e.key === 'Escape') { if (sIn.value || searchOpen()) { sIn.value = ''; searchClose(); } else sIn.blur(); }
  else if (e.key === 'ArrowDown') { const f = sRes.querySelector('.sh'); if (f) { e.preventDefault(); f.focus(); } }
});
sRes.addEventListener('keydown', e => {
  const all = [...sRes.querySelectorAll('.sh')], i = all.indexOf(document.activeElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const j = i + (e.key === 'ArrowDown' ? 1 : -1); if (j < 0) sIn.focus(); else if (all[j]) all[j].focus(); }
  else if (e.key === 'Escape') { e.preventDefault(); sIn.focus(); }
});
srow.querySelector('.sx').addEventListener('click', e => { e.preventDefault(); sIn.value = ''; searchClose(); needKeys(); sIn.focus(); });
sRes.addEventListener('click', e => {
  e.stopPropagation();   // the hit is gone once the list closes: the window's click handler would take it for a click outside
  const b = e.target.closest('.sh'); if (!b) return;
  const h = b._h, s = realFeed.sessions.find(x => String(x.sessionId) === h.sessionId);
  searchClose();
  if (s) openConsole(s, h);
});
function refreshClaude() { window.sphere.claudeSnap().then(s => { lastSnap = s; renderTop(s); markView(); }); }
setInterval(() => { if (spreadOn) refreshClaude(); }, 4000);
window.sphere.onOverlayClosed(() => { if (rEditing) return; overlayOn = con.on; barCard = ''; rlist.style.display = 'none'; if (view === 'artifacts') showView('artifacts'); });   // fresh pictures
// the Claude window's place over the background: centred on the panel (wide: across it), between the top groups and the bottom bar
function overlayRect() {
  const r = sphere.flatRect(), k = scale * pxPerUnit * persp();
  // wide: across the panel with room on both sides to click back; narrow (chats, sphere settings): centred
  const L = cx + (r.x0 - 0.1) * k, R = cx + (r.x1 + 0.1) * k, pw = R - L, side = Math.max(70, pw * 0.06);
  const w = cardKind === 'wide' ? pw - 2 * side : cardKind === 'detail' ? pw - 2 * side - RLIST_W - 12 : Math.min(pw - 2 * side, Math.max(720, pw * 0.6));
  const y0 = top.offsetTop + top.offsetHeight + 14 + TITLE_PX, y1 = bar.offsetTop - 14;   // Claude's title bar hides above the card
  return { x: cardKind === 'detail' ? L + side + RLIST_W + 12 : (L + R) / 2 - w / 2, y: y0, w, h: y1 - y0 };
}
window.sphere.mode().then(showMode);
setInterval(() => window.sphere.mode().then(showMode), 3000);

let rebuild0 = false;
function applySettings(s) {
  const bT = document.getElementById('bTheseus'); if (bT) bT.lastChild.textContent = (s.name || 'Theseus') + ' settings';
  con.setAppControl(s.appControl);
  const md = document.getElementById('mode'); if (md) md.style.display = s.live && s.live.modes && !s.live.modes.on ? 'none' : '';   // the Modes add-on
  FRAME_MS = s.fps > 0 ? 1000 / s.fps : 0;
  const rs0 = renderScale; renderScale = s.renderScale > 0 ? s.renderScale : 1;
  if (!renderer || aaOn !== renderScale < 1.5) makeRenderer(renderScale < 1.5); else if (renderScale !== rs0) resize();   // a slider echo never resets the canvas
  wake();
  const lr = sphere.setLabelRes(s.labelRes), fsh = sphere.setFlatShape(s.flatShape);
  const tf = sphere.setFilters({ sphere: s.tilesSphere, rows: s.tilesRows }) || lr || fsh;   // label size and flat shape rebuild the tiles too (folded first when spread)
  if (S && S.tileAlign !== s.tileAlign) { sphere.setAlign(s.tileAlign); if (spreadOn) startSpread(); } else sphere.setAlign(s.tileAlign);
  if (S && !!S.appControl !== !!s.appControl) rebuild0 = true;   // the New session tile comes or goes
  S = s; modeColours(s); showMode(curMode);
  CLOSE_MS = s.closeDelay * 1000; IDLE = s.idleGlow; SPIN = s.spinMinutes > 0 ? (2 * Math.PI) / (s.spinMinutes * 60) : 0;
  glowOnSpeech = s.glowOnSpeech; autoFold = s.autoFold !== false; keepCardsOpen = s.keepCardsOpen !== false; sphere.setActivity(s.tileActivity !== false); sphere.setRing(s.contextRing); captionOn = s.speechCaption !== false; if (!captionOn) cap.classList.remove('on');
  setPanelWear(s.tileWear | 0); sphere.setSwap(s.tileSwap);
  let rebuild = tf || rebuild0; rebuild0 = false;
  if (sphere.setOpenSpots(s.emptySpots === 'open')) rebuild = true;
  const nm = SIZE_K[s.sphereSize] ? s.sphereSize : 'medium', g = s.sphereGrowth !== false;
  const rowSized = sphere.setRowSize(s.rowTileSize);
  const resized = nm !== sizeName || g !== growth;
  if (resized) {
    sizeName = nm; sizeK = SIZE_K[nm]; growth = g;
    if (sphere.setMinCells(growth ? 0 : FIXED[nm].cells)) rebuild = true;
    scaleTarget = sizeFor(onSphere(sphereFeed(realFeed))); wake(); labelScale();
  }
  // Show tiles, empty spots, size / growth: one rebuild for all of them (spread: fold, resize, spread again)
  if (rowSized && !rebuild && !resized) feedDirty = true;   // folded: the next spread lays the rows out anew
  // (a row size change redraws the labels at their new size: a rebuild, done while folded)
  if ((rebuild || resized || rowSized) && spreadOn && !view && feedIn) respread = { rebuild: rebuild || rowSized || !!(respread && respread.rebuild) };
  else if (rebuild && feedIn) { onFeed(realFeed); if (!view) feedDirty = true; }
  else if (rowSized) labelScale();
  // the first settings: the feed that waited for them builds the tiles once, at the chosen size (no grow from medium)
  if (!settingsIn) { settingsIn = true; if (firstFeed) startFeed(); }
}
// the tiles are first built once both the settings and the feed are in (not once with defaults, then again)
let settingsIn = false, feedIn = false, firstFeed = null;
function startFeed() { const f = firstFeed; firstFeed = null; onFeed(f); scale = scaleTarget; feedIn = true; }
window.sphere.settings().then(applySettings);
window.sphere.onSettings(applySettings);
window.sphere.feed().then(f => { firstFeed = firstFeed || f; if (settingsIn) startFeed(); });
window.sphere.onFeed(f => { if (feedIn) onFeed(f); else firstFeed = f; });
setTimeout(() => { if (!settingsIn && firstFeed) startFeed(); }, 5000);   // settings never came: show the feed anyway
// speech caption: the spoken line shows under the sphere (above it when the bar leaves no room), fading 4 s after the voice ends;
// hidden while the rows are spread (setting "Speech caption")
function placeCaption() {
  const r = scale * pxPerUnit, h = cap.offsetHeight || 30, below = cy + r + 12;
  cap.style.left = cx + 'px';
  cap.style.top = (below + h <= innerHeight - BAR_PX ? below : Math.max(4, cy - r - 12 - h)) + 'px';
}
function caption(t) {
  clearTimeout(capOff);
  if (askCap) {   // a Voice Ask caption stays up while it is answered ("One moment." and the answer's voice do not replace it)
    if (!(t && t.on) && askCap.state !== 'thinking') capOff = setTimeout(() => { cap.classList.remove('on'); askCap = null; }, 4000);
    return;
  }
  if (t && t.on && t.text && captionOn) { cap.textContent = t.text; placeCaption(); cap.classList.toggle('on', !spreadOn); }
  else if (cap.classList.contains('on')) capOff = setTimeout(() => cap.classList.remove('on'), 4000);
}
// Voice Ask: "You: <question>" while Claude thinks (the core breathes slowly), then the whole answer (the voice reads the first
// sentences); it fades 4 s after the voice ends, or after 12 s when it is not spoken (errors: 6 s)
// a voice "open <title>": as a press on that tile
window.sphere.onVoiceOpen?.(a => {
  if (!a) return;
  if (a.sessionId == null) { openConsole(null, null, a.folder); return; }
  const s = (realFeed.sessions || []).find(x => x.sessionId === a.sessionId); if (s) openTile(s, false, false);
});
window.sphere.onAsk?.(a => {
  if (!a) return;
  clearTimeout(capOff);
  askCap = a; askPulse = a.state === 'thinking';
  cap.replaceChildren();
  if (a.q) { const q = document.createElement('div'); q.className = 'q'; q.textContent = 'You: ' + a.q; cap.append(q); }
  const x = document.createElement('div'); x.className = 'a'; x.textContent = a.state === 'thinking' ? '…' : a.text || ''; cap.append(x);
  placeCaption(); cap.classList.toggle('on', !spreadOn);
  if (a.state === 'error' || a.state === 'answer' && !a.spoken) capOff = setTimeout(() => { cap.classList.remove('on'); askCap = null; }, a.state === 'error' ? 6000 : 12000);
  if (a.state === 'answer' && a.spoken) setTimeout(() => { if (askCap === a && !(talking && talking.on)) { cap.classList.remove('on'); askCap = null; } }, 30000);   // the voice never came
  wake();
});
window.sphere.onTalking(t => { talking = t; caption(t); wake(); });
ready = true; labelScale();
// test hook (SPHERE_CONSOLE=<sessionId>): spread the rows and open that session's view once the feed is in
window.sphere.consoleAuto?.().then(id => {
  if (!id) return;
  const ch = /^chips:/.test(id); if (ch) id = id.slice(6);   // chips:<sessionId>: that session's chip bar in the middle of the rows
  const t = setInterval(() => { const s = feedIn && (id === NEW_TILE.sessionId ? NEW_TILE : realFeed.sessions.find(x => x.sessionId === id)); if (!s) return; clearInterval(t); startSpread(); setTimeout(() => ch ? chipBar.open(s, innerWidth / 2, innerHeight / 2) : openTile(s, false, false), 1500); }, 500);   // new:tile: the New session form
});
