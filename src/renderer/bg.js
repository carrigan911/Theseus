// Background window (Backgrounds_Spec): one full-screen shader. Styles: black, space (still stars + nebula), moving (the
// same, drifting), gradient (an aurora-like wash in the mode colour), travel (stars streaming out from the centre, a nebula
// that keeps zooming, now and then a planet passing). Main sends { style, opacity, visible, tint, speed, paused }; the alpha
// fades toward opacity (or 0 when hidden). Moving styles draw at up to 30 fps and stop while paused (covered); still ones
// draw once per change. While Lightfall plays (main sends fx { dir, beamX 0..1 } with the sphere's own start message, null
// to stop) it draws every frame, the space squeezed into the beam and shaken, on the same timeline (falltime.js).
'use strict';
const cv = document.getElementById('c');
const shader = makeBgShader(cv);   // bgshader.js
const MOVING = BG_MOVING;
const st = { style: 'none', opacity: 0.85, visible: false, tint: '#3da5ff', speed: 1, paused: false };

let alpha = 0, clock = 0, lastNow = 0, lastDraw = 0, raf = 0, dirty = true, fx = null;
function size() {
  const k = MOVING.has(st.style) ? 0.75 : 1;   // moving styles draw at 3/4 resolution (the GPU cost of a full screen)
  const w = Math.round(innerWidth * devicePixelRatio * k), h = Math.round(innerHeight * devicePixelRatio * k);
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
}
function draw() {
  size();
  let f = null;
  if (fx) {
    const len = fx.dir === 'out' ? FALL.OUT : FALL.IN, t = (performance.now() - fx.t0) / 1000, P = FALL.pose(fx.dir, Math.min(1, t / len));
    const [dx, dy] = FALL.shake(t, P), k = cv.width / innerWidth;
    f = { warp: P.warp, beam: fx.beamX * cv.width, sx: -dx * k, sy: dy * k };
    if (t >= len) fx = null;
  }
  shader.draw(st.style, clock, st.tint, st.speed, alpha, f);
}
function frame(now) {
  raf = 0;
  const dt = lastNow ? Math.min(0.1, (now - lastNow) / 1000) : 0; lastNow = now;
  const target = st.visible && st.style !== 'none' ? st.opacity : 0, fading = Math.abs(alpha - target) > 0.003;
  alpha = fading ? alpha + (target - alpha) * Math.min(1, dt * 9) : target;
  const live = MOVING.has(st.style) && alpha > 0 && !st.paused;
  if (live) clock += dt * (st.style === 'travel' ? st.speed : 1);
  const fxOn = !!fx;
  if (fxOn || fading || dirty || (live && now - lastDraw >= 33)) { draw(); lastDraw = now; dirty = false; }
  if (fxOn || fading || live) raf = requestAnimationFrame(frame); else lastNow = 0;
}
const kick = () => { if (!raf) raf = requestAnimationFrame(frame); };
window.sphere.onBg(s => { const was = st.style; Object.assign(st, s); if (st.style !== was) clock = 0; dirty = true; kick(); });
window.sphere.onFx?.(m => { fx = m ? { dir: m.dir, beamX: m.beamX, t0: performance.now() - (m.ago || 0) } : null; dirty = true; kick(); });
addEventListener('resize', () => { dirty = true; kick(); });
