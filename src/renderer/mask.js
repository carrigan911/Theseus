// Mask over the chat card: panel colour over Claude's title bar and outside the rounded corners, a 1 px rounded border,
// transparent inside. Takes the pointer only outside the rounded card (a click there = click outside the chat).
const c = document.getElementById('c'), g = c.getContext('2d');
let M = { pad: 2, th: 36, r: 14 }, over = false;
function card() { return { x: M.pad, y: M.pad + M.th, w: innerWidth - 2 * M.pad, h: innerHeight - 2 * M.pad - M.th }; }
function rr(x, y, w, h, r) { g.beginPath(); g.roundRect(x, y, w, h, r); }
function draw() {
  const d = devicePixelRatio; c.width = innerWidth * d; c.height = innerHeight * d; c.style.width = innerWidth + 'px'; c.style.height = innerHeight + 'px';
  g.setTransform(d, 0, 0, d, 0, 0); g.clearRect(0, 0, innerWidth, innerHeight);
  const k = card();
  g.fillStyle = '#121211'; g.fillRect(0, 0, innerWidth, innerHeight);           // panel colour (matches the sphere's panel)
  g.globalCompositeOperation = 'destination-out'; rr(k.x, k.y, k.w, k.h, M.r); g.fill();
  g.globalCompositeOperation = 'source-over'; rr(k.x + 0.5, k.y + 0.5, k.w - 1, k.h - 1, M.r); g.strokeStyle = '#2b2a28'; g.lineWidth = 1; g.stroke();
}
function inside(x, y) {
  const k = card(), r = M.r;
  if (x < k.x || y < k.y || x > k.x + k.w || y > k.y + k.h) return false;
  const cx = Math.min(Math.max(x, k.x + r), k.x + k.w - r), cy = Math.min(Math.max(y, k.y + r), k.y + k.h - r);
  return Math.hypot(x - cx, y - cy) <= r;
}
addEventListener('mousemove', e => { const o = !inside(e.clientX, e.clientY); if (o !== over) { over = o; window.sphere.maskHit(o); } });
addEventListener('mouseleave', () => { if (over) { over = false; window.sphere.maskHit(false); } });
addEventListener('click', e => { if (!inside(e.clientX, e.clientY)) window.sphere.maskClick(); });
addEventListener('resize', draw);
window.sphere.onMask(m => { M = m; draw(); });
draw();
