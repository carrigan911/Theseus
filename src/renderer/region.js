// Region picker page (src/recorder.js, pickRegion): drag a box on the dimmed screen. Esc, right-click or a tiny box cancels.
// Sends { x, y, w, h } in this window's CSS pixels (main converts to physical screen pixels), or null.
const { ipcRenderer } = require('electron');
const inst = new URLSearchParams(location.search).get('i');
const box = document.getElementById('box'), hint = document.getElementById('hint');
let from = null, cur = null;
const rect = () => ({ x: Math.min(from.x, cur.x), y: Math.min(from.y, cur.y), w: Math.abs(cur.x - from.x), h: Math.abs(cur.y - from.y) });
const send = r => ipcRenderer.send(`rec${inst}:region`, r);
addEventListener('keydown', e => { if (e.key === 'Escape') send(null); });
addEventListener('contextmenu', e => { e.preventDefault(); send(null); });
addEventListener('mousedown', e => {
  if (e.button !== 0) return send(null);
  from = cur = { x: e.clientX, y: e.clientY };
});
addEventListener('mousemove', e => {
  if (!from) return;
  cur = { x: e.clientX, y: e.clientY };
  const r = rect();
  Object.assign(box.style, { display: 'block', left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
  hint.textContent = `Drag a box to record  -  Esc cancels   ${r.w} x ${r.h}`;
});
addEventListener('mouseup', e => {
  if (!from) return;
  const r = rect(); from = null;
  send(r.w >= 32 && r.h >= 32 ? r : null);
});
