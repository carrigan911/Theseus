// Theseus strip (and, with ?toast=1, the small notice / readout card window shown when the strip is off)
const $ = id => document.getElementById(id);
const TOAST = new URLSearchParams(location.search).has('toast');
const NAMES = { normal: 'Normal', worker: 'Worker', night: 'Night', weekend: 'Weekend', performance: 'Max perf', efficiency: 'Max efficiency' };
let S = null, T = null, noteTimer = 0, tick = 0, lastW = 0, lastH = 0;
document.body.classList.toggle('toast', TOAST);

function reportSize() {
  const el = TOAST ? $('toast').firstElementChild : $('bar');
  if (!el) return;
  const r = el.getBoundingClientRect(), w = Math.ceil(r.width) + 2, h = Math.ceil(r.height) + 2;
  if (w !== lastW || h !== lastH || TOAST) { lastW = w; lastH = h; window.sphere.stripSize(w, h); }
}

function mmss(ms) { const s = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; }
function render() {
  if (TOAST || !S || !T) return;
  const m = (T.mode && T.mode.mode) || 'normal', pend = T.mode && T.mode.pending && T.mode.pending !== m ? T.mode.pending : null;
  const colour = m === 'normal' ? S.glow : (S.modeColors && S.modeColors[m]) || S.glow;
  $('modeDot').style.background = $('modeDot').style.color = colour;
  $('modeBtn').style.display = S.live && S.live.modes && !S.live.modes.on ? 'none' : '';   // the Modes add-on
  $('modeName').innerHTML = '';
  $('modeName').append(NAMES[m] || m);
  if (pend) { const p = document.createElement('span'); p.className = 'pend'; p.textContent = ` → ${NAMES[pend] || pend}`; $('modeName').append(p); }
  const a = T.audio;
  $('out').classList.toggle('unavail', !T.avail.audio); $('mic').classList.toggle('unavail', !T.avail.audio);
  $('outName').textContent = a && a.out ? a.out.name : T.avail.audio ? '...' : 'no audio';
  $('out').title = (a && a.out ? a.out.name + '\n' : '') + 'Click: next output, right-click: choose';
  const muted = !!(a && a.mic && a.mic.mute);
  $('mic').classList.toggle('muted', muted); $('mic').classList.toggle('listening', !!T.listening);
  $('mic').title = (a && a.mic ? a.mic.name + (muted ? ' (muted)' : '') + '\n' : '') + 'Click: mute / unmute, right-click: choose';
  const r = T.rec, on = !!(r && r.recording);
  $('rec').classList.toggle('on', on); $('rec').classList.toggle('unavail', !T.avail.rec); $('replay').classList.toggle('unavail', !T.avail.rec);
  $('timer').textContent = on && r.since ? mmss(Date.now() - r.since) : '';
  $('meters').classList.toggle('on', on && !!T.avail.rec); if (!on) levels(null);
  clearInterval(tick); if (on) tick = setInterval(() => { $('timer').textContent = mmss(Date.now() - r.since); }, 500);
  $('replay').classList.toggle('on', !!(r && r.replay));
  $('replay').title = `Replay buffer ${r && r.replay ? 'on' : 'off'} (${(r && r.replaySec) || S.replaySec} s). Click: on / off`;
  const sys = $('sys'), show = S.sysReadout && T.sys;
  sys.style.display = show ? '' : 'none';
  if (show) { sys.textContent = T.sys.line; sys.className = T.sys.worst === 'red' ? 'red' : T.sys.worst === 'yellow' ? 'yellow' : ''; }
  reportSize();
}

// recording level meters: v 0..1 (dB scaled), null = that stream is not recorded; no layout work, only a transform per bar
function meter(id, v) {
  const box = $(id), bar = box.firstElementChild, x = v == null ? 0 : Math.max(0, Math.min(1, v));
  box.classList.toggle('off', v == null);
  bar.style.transform = `scaleX(${x.toFixed(3)})`;
  bar.className = x > 0.95 ? 'clip' : x > 0.85 ? 'hot' : '';
}
function levels(l) { meter('mMic', l ? l.mic : 0); meter('mSys', l ? l.sys : 0); }

function notice(text, ms = 3000) {
  if (TOAST) return;
  $('note').textContent = text; $('bar').classList.add('noticing'); reportSize();
  clearTimeout(noteTimer); noteTimer = setTimeout(() => { $('bar').classList.remove('noticing'); reportSize(); }, ms);
}

// toast window: a notice pill or the readout card
function toast(p) {
  const box = $('toast'); box.innerHTML = '';
  const pill = document.createElement('div');
  if (p.card) {
    const c = p.card; pill.className = 'pill card';
    const head = document.createElement('div'); head.className = 'head';
    const lv = document.createElement('i'); lv.className = 'lvl ' + (c.worst || 'ok');
    const t = document.createElement('span'); t.append(lv, 'System');
    const ti = document.createElement('span'); ti.textContent = c.time ? c.time.slice(11, 19) : '';
    head.append(t, ti);
    const grid = document.createElement('div'); grid.className = 'grid';
    const row = (k, v) => { const b = document.createElement('b'), s = document.createElement('span'); b.textContent = k; s.textContent = v; grid.append(b, s); };
    const f1 = v => (Math.round(v * 10) / 10).toString();
    if (c.cpu != null) row('CPU', Math.round(c.cpu) + '%');
    if (c.ramFree != null) row('RAM free', f1(c.ramFree) + (c.ramTotal ? ' / ' + f1(c.ramTotal) : '') + ' GB');
    if (c.vram != null) row('VRAM', f1(c.vram) + (c.vramTotal ? ' / ' + f1(c.vramTotal) : '') + ' GB');
    if (c.gpuTemp != null) row('GPU', Math.round(c.gpuTemp) + '°C');
    pill.append(head, grid);
    if (c.reds && c.reds.length) { const rd = document.createElement('div'); rd.className = 'reds'; rd.textContent = 'Red: ' + c.reds.map(x => x.text).join(', '); pill.append(rd); }
    if (c.none) { grid.remove(); const n = document.createElement('div'); n.textContent = 'No readout available.'; pill.append(n); }
  } else { pill.className = 'pill notice'; pill.textContent = p.notice || ''; }
  box.append(pill);
  setTimeout(reportSize, 0);                                     // not rAF: the toast window starts hidden, where rAF never fires
}

if (TOAST) window.sphere.onToast(toast);
else {
  // drag: a press anywhere on the bar (buttons too) moves the strip once the pointer has gone 4 px; a press that does not
  // move stays a click. Main follows the cursor itself while the drag lasts, so a fast drag never outruns the window; the
  // pointer is captured, so the release is seen even off the strip
  let drag = null;
  document.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !e.target.closest('#bar')) return;
    drag = { id: e.pointerId, x: e.screenX, y: e.screenY, on: false };
    try { e.target.setPointerCapture(e.pointerId); } catch {}
  });
  document.addEventListener('pointermove', e => {
    if (!drag || drag.on || e.pointerId !== drag.id) return;
    if (Math.abs(e.screenX - drag.x) + Math.abs(e.screenY - drag.y) > 4) { drag.on = true; window.sphere.stripDrag('start', { dx: e.screenX - drag.x, dy: e.screenY - drag.y }); }
  });
  const endDrag = e => {
    if (!drag || (e && e.pointerId != null && e.pointerId !== drag.id)) return;
    const was = drag.on; drag = null;
    if (!was) return;
    window.sphere.stripDrag('end');
    // the click this release makes is the end of a move, not a press of the button under it
    const eat = ev => { ev.stopPropagation(); ev.preventDefault(); };
    addEventListener('click', eat, { capture: true, once: true }); setTimeout(() => removeEventListener('click', eat, { capture: true }), 300);
  };
  document.addEventListener('pointerup', endDrag); document.addEventListener('pointercancel', endDrag); document.addEventListener('lostpointercapture', endDrag); addEventListener('blur', () => endDrag());
  let over = null;
  document.addEventListener('mousemove', e => { if (drag && drag.on) return; const o = !!e.target.closest('#bar'); if (o !== over) { over = o; window.sphere.stripHit(o); } });
  const rect = id => { const r = $(id).getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.bottom + 2) }; };
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const a = b.dataset.act;
    if (a === 'mode') window.sphere.act('menu-mode', rect('modeBtn'));
    else if (a === 'out') window.sphere.act('nextOut');
    else if (a === 'mic') window.sphere.act('muteMic');
    else if (a === 'rec') window.sphere.act('recToggle');
    else if (a === 'replay') window.sphere.act('replayToggle');
  });
  document.addEventListener('contextmenu', e => {
    e.preventDefault();
    const b = e.target.closest('[data-act]'); if (!b) return;
    if (b.dataset.act === 'out') window.sphere.act('menu-out', rect('out'));
    else if (b.dataset.act === 'mic') window.sphere.act('menu-mic', rect('mic'));
    else if (b.dataset.act === 'mode') window.sphere.act('menu-mode', rect('modeBtn'));
    else if (b.dataset.act === 'rec') window.sphere.act('menu-rec', rect('rec'));
  });
  window.sphere.onNotice(notice);
  window.sphere.onLevels(l => { if (T && T.rec && T.rec.recording) levels(l); });
  new ResizeObserver(reportSize).observe($('bar'));
}
const named = s => { document.title = (s.name || 'Theseus') + ' strip'; const mb = document.getElementById('modeBtn'); if (mb) mb.title = (s.name || 'Theseus') + ' mode (click: change)'; };
window.sphere.onSettings(s => { S = s; named(s); render(); });
window.sphere.onTools(t => { T = t; render(); });
Promise.all([window.sphere.settings(), window.sphere.tools()]).then(([s, t]) => { S = s; T = t; named(s); render(); });
