// Theseus tools, pure helpers (no electron import, so tests can run them under plain node):
// the system readout, red-limit alerts, the strip position clamp and a hotkey registrar that retries.
const MODE_NAMES = { normal: 'Normal', worker: 'Worker', night: 'Night', weekend: 'Weekend', performance: 'Max perf', efficiency: 'Max efficiency' };

// system_status.json (written by SystemMonitor, may start with a BOM): parse, or null
function parseStatus(text) {
  try { const d = JSON.parse(String(text).replace(/^﻿/, '')); return d && typeof d === 'object' ? d : null; } catch { return null; }
}
const num = v => typeof v === 'number' && isFinite(v) ? v : null;
const f1 = v => v == null ? '?' : (Math.round(v * 10) / 10).toString();
// the readout in numbers and as text: line (strip), say (spoken), worst ('ok' | 'yellow' | 'red' | ...)
function summary(st) {
  if (!st) return null;
  const gpu = st.gpu && st.gpu.ok !== false ? st.gpu : {}, ram = st.ram || {};
  const o = { cpu: num(st.cpu), ramFree: num(ram.freeGB), ramTotal: num(ram.totalGB), vram: num(gpu.vramGB), vramTotal: num(gpu.vramTotalGB), gpuTemp: num(gpu.tempC),
    worst: typeof st.worst === 'string' ? st.worst : 'ok', time: typeof st.time === 'string' ? st.time : '', reds: redLimits(st) };
  const bits = [];
  if (o.cpu != null) bits.push(`CPU ${Math.round(o.cpu)}%`);
  if (o.ramFree != null) bits.push(`RAM ${f1(o.ramFree)} GB free`);
  if (o.vram != null) bits.push(`VRAM ${f1(o.vram)} GB`);
  if (o.gpuTemp != null) bits.push(`GPU ${Math.round(o.gpuTemp)}°C`);
  o.line = bits.join(' · ');
  const say = [];
  if (o.cpu != null) say.push(`CPU ${Math.round(o.cpu)} percent.`);
  if (o.ramFree != null) say.push(`${f1(o.ramFree)} gigabytes of RAM free.`);
  if (o.vram != null) say.push(`VRAM ${f1(o.vram)} gigabytes used.`);
  if (o.gpuTemp != null) say.push(`GPU ${Math.round(o.gpuTemp)} degrees.`);
  o.say = say.join(' ') || 'No readout available.';
  return o;
}
// limits whose level is red: [{ key, label, text }]
function redLimits(st) {
  const out = [];
  const lim = st && st.limits && typeof st.limits === 'object' ? st.limits : {};
  for (const k of Object.keys(lim)) {
    const l = lim[k];
    if (!l || l.level !== 'red') continue;
    const val = l.value == null ? '' : ` ${f1(l.value)}${l.unit ? (/^[%]$/.test(l.unit) ? l.unit : ' ' + l.unit) : ''}`;
    out.push({ key: k, label: String(l.label || k), text: `${l.label || k}${val}` });
  }
  return out;
}
// alert when a limit newly turns red: the new red ones (prevKeys = a Set of keys that were red; null = first read, no alert)
function newReds(prevKeys, st) {
  const reds = redLimits(st);
  if (!prevKeys) return { reds, fresh: [] };
  return { reds, fresh: reds.filter(r => !prevKeys.has(r.key)) };
}

// strip window position: top-left {x, y}, size {w, h}, displays = [{ x, y, width, height }] (bounds); the window is moved fully onto the display with
// the most overlap, or else the nearest. No position -> top centre of displays[primary]
function clampPos(pos, size, displays, primary = 0) {
  const d0 = displays[Math.min(primary, displays.length - 1)] || { x: 0, y: 0, width: 1920, height: 1080 };
  if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') return { x: d0.x + Math.round((d0.width - size.w) / 2), y: d0.y + 2 };
  let best = null, bestA = -1, near = null, nearD = Infinity;
  for (const d of displays) {
    const ox = Math.max(0, Math.min(pos.x + size.w, d.x + d.width) - Math.max(pos.x, d.x));
    const oy = Math.max(0, Math.min(pos.y + size.h, d.y + d.height) - Math.max(pos.y, d.y));
    if (ox * oy > bestA) { bestA = ox * oy; best = d; }
    const dx = Math.max(d.x - pos.x, 0, pos.x - (d.x + d.width)), dy = Math.max(d.y - pos.y, 0, pos.y - (d.y + d.height)), dist = dx * dx + dy * dy;
    if (dist < nearD) { nearD = dist; near = d; }
  }
  const d = bestA > 0 ? best : near || d0;
  return { x: Math.round(Math.min(Math.max(pos.x, d.x), d.x + Math.max(0, d.width - size.w))), y: Math.round(Math.min(Math.max(pos.y, d.y), d.y + Math.max(0, d.height - size.h))) };
}

// the hotkeys: table = [{ acc, fn, name }]; register() tries every key not yet held, failures are logged and retried every `retryMs`
function hotkeys(globalShortcut, table, log, retryMs = 30000) {
  const held = new Set(); let timer = null, wanted = false, lastFail = '';
  function register() {
    wanted = true;
    const failed = [];
    for (const h of table) {
      if (held.has(h.acc)) continue;
      let ok = false;
      try { ok = globalShortcut.register(h.acc, () => { try { h.fn(); } catch (e) { log(`hotkey ${h.acc} error: ${e && e.message}`); } }); } catch (e) { log(`hotkey ${h.acc} threw: ${e && e.message}`); }
      if (ok) { held.add(h.acc); log(`hotkey ${h.acc} registered (${h.name})`); } else failed.push(h.acc);
    }
    if (failed.length && failed.join() !== lastFail) log(`hotkeys not registered (held by another program?): ${failed.join(', ')} - retrying every ${retryMs / 1000} s`);   // said once, not every retry
    lastFail = failed.join();
    clearTimeout(timer); timer = null;
    if (failed.length && wanted) { timer = setTimeout(register, retryMs); if (timer.unref) timer.unref(); }
    return failed;
  }
  function unregister() {
    wanted = false; clearTimeout(timer); timer = null;
    for (const acc of held) { try { globalShortcut.unregister(acc); } catch {} }
    held.clear();
  }
  return { register, unregister, held: () => [...held], failed: () => wanted ? table.map(h => h.acc).filter(a => !held.has(a)) : [] };   // hotkeys off: none "held by another program"
}

module.exports = { MODE_NAMES, parseStatus, summary, redLimits, newReds, clampPos, hotkeys };
