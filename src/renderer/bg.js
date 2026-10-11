// Background window (Backgrounds_Spec): one full-screen shader. Styles: black, space (still stars + nebula), moving (the
// same, drifting), gradient (an aurora-like wash in the mode colour), travel (stars streaming out from the centre, a nebula
// that keeps zooming, now and then a planet passing). Main sends { style, opacity, visible, tint, speed, paused }; the alpha
// fades toward opacity (or 0 when hidden). Moving styles draw at up to 30 fps and stop while paused (covered); still ones
// draw once per change.
'use strict';
const cv = document.getElementById('c');
const shader = makeBgShader(cv);   // bgshader.js
const MOVING = BG_MOVING;
const st = { style: 'none', opacity: 0.85, visible: false, tint: '#3da5ff', speed: 1, paused: false };

let alpha = 0, clock = 0, lastNow = 0, lastDraw = 0, raf = 0, dirty = true;
function size() {
  const k = MOVING.has(st.style) ? 0.75 : 1;   // moving styles draw at 3/4 resolution (the GPU cost of a full screen)
  const w = Math.round(innerWidth * devicePixelRatio * k), h = Math.round(innerHeight * devicePixelRatio * k);
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
}
function draw() {
  size();
  shader.draw(st.style, clock, st.tint, st.speed, alpha);
}
function frame(now) {
  raf = 0;
  const dt = lastNow ? Math.min(0.1, (now - lastNow) / 1000) : 0; lastNow = now;
  const target = st.visible && st.style !== 'none' ? st.opacity : 0, fading = Math.abs(alpha - target) > 0.003;
  alpha = fading ? alpha + (target - alpha) * Math.min(1, dt * 9) : target;
  const live = MOVING.has(st.style) && alpha > 0 && !st.paused;
  if (live) clock += dt * (st.style === 'travel' ? st.speed : 1);
  if (fading || dirty || (live && now - lastDraw >= 33)) { draw(); lastDraw = now; dirty = false; }
  if (fading || live) raf = requestAnimationFrame(frame); else lastNow = 0;
}
const kick = () => { if (!raf) raf = requestAnimationFrame(frame); };
window.sphere.onBg(s => { const was = st.style; Object.assign(st, s); if (st.style !== was) clock = 0; dirty = true; kick(); });
addEventListener('resize', () => { dirty = true; kick(); });
