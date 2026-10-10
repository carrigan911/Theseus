// Talks to claudeui.ps1 (one long-lived PowerShell): Claude window state, button presses, overlay placement, z-order.
const { spawn } = require('child_process');
const path = require('path');
// create(): a helper of its own (its own queue), so quick checks never wait behind slow UI Automation reads.
// { lite: true } = no UI Automation (faster start); for the z-order and cover checks.
function create(opts = {}) {
let ps = null, buf = '', nextId = 1, fails = 0, startedAt = 0, retryAt = 0;
const waiting = new Map();   // id -> { res, timer }; replies are matched by id, a stray line is dropped

function done(id, r) { const w = waiting.get(id); if (!w) return; waiting.delete(id); clearTimeout(w.timer); w.res(r); }
// the helper is gone (exit, spawn error): fail what waits; quick deaths back off 1, 2, 4 ... 30 s before the next spawn
function gone(p) {
  if (ps !== p) return;
  ps = null; buf = '';
  fails = Date.now() - startedAt < 5000 ? fails + 1 : 0;
  if (fails) retryAt = Date.now() + Math.min(30000, 1000 * 2 ** (fails - 1));
  for (const id of [...waiting.keys()]) done(id, { ok: false, why: 'helper exited' });
}
function start() {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'claudeui.ps1')];
  if (opts.lite) args.push('-Lite');
  const p = spawn('powershell.exe', args, { windowsHide: true });
  ps = p; startedAt = Date.now();
  p.on('error', () => gone(p));
  p.on('exit', () => gone(p));
  p.stdin.on('error', () => {});               // EPIPE after the helper died: the exit handler fails the waiters
  p.stderr.on('data', () => {});               // drained, so a chatty helper can never block
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', d => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (!r || typeof r.id !== 'number') continue;
      fails = 0; done(r.id, r);
    }
  });
}

// send({cmd, ...}, timeoutMs) -> Promise of the reply (never rejects; {ok:false} on failure); commands run one at a time in order.
// They wait here and are written one at a time, so a command's time limit starts when the helper takes it (a quick poll
// queued behind a long console action no longer times out and kills the helper mid-action); the same command already
// waiting (a status / snap poll) is shared rather than queued again.
// A command that gets no reply in time means a hung call: the helper is killed and starts fresh on the next send.
const queue = []; let busy = false;
function pump() {
  if (busy || !queue.length) return;
  const w = queue.shift();
  if (stopped) { w.res({ ok: false, why: 'stopped' }); return pump(); }
  if (!ps) {
    if (Date.now() < retryAt) { w.res({ ok: false, why: 'helper down' }); return pump(); }
    try { start(); } catch { retryAt = Date.now() + 5000; w.res({ ok: false, why: 'spawn failed' }); return pump(); }
  }
  const p = ps, id = nextId++; busy = true;
  const res = r => { busy = false; watch(w.cmd, r); w.res(r); setImmediate(pump); };
  const timer = setTimeout(() => { done(id, { ok: false, why: 'timeout' }); try { p.kill(); } catch {} }, w.ms);
  waiting.set(id, { res, timer });
  try { p.stdin.write(JSON.stringify({ id, ...w.cmd }) + '\n'); } catch { done(id, { ok: false, why: 'write failed' }); }
}
function send(cmd, ms = 20000) {
  if (stopped) return Promise.resolve({ ok: false, why: 'stopped' });   // after quit's stop(): a late poll never spawns a new helper
  const key = Object.keys(cmd).length === 1 ? cmd.cmd : null, same = key && queue.find(w => w.key === key);   // only bare polls are shared
  if (same) return same.p;
  const w = { cmd, ms, key }; w.p = new Promise(r => { w.res = r; }); queue.push(w); pump();
  return w.p;
}
// the page-change log (Claude's page once drifted to other sessions, cause unknown): an action whose page after differs
// from the page before, and a page change seen by a snap, are logged with the last actions this helper ran
const recent = []; let seen = '', logTo = null;
function watch(cmd, r) {
  if (!logTo || !r) return;
  const what = c => `${c.cmd}${c.title ? ` "${c.title}"` : ''}${c.act || c.choice || c.what || c.name ? ' ' + (c.act || c.choice || c.what || c.name) : ''}`;
  if (Array.isArray(r.pages)) {
    recent.push({ at: Date.now(), what: what(cmd), ok: !!r.ok }); if (recent.length > 8) recent.shift();
    const [a, b] = r.pages; if (b) seen = b;
    if (a !== b) logTo(`[page] ${what(cmd)} (${r.ok ? 'ok' : 'failed: ' + r.why}) changed the page "${a}" -> "${b}"`);
  } else if (cmd.cmd === 'snap' && r.ok && typeof r.title === 'string') {
    if (seen && r.title !== seen) logTo(`[page] seen "${seen}" -> "${r.title}"; Sphere's last actions: ${recent.length ? recent.map(x => `${Math.round((Date.now() - x.at) / 1000)} s ago ${x.what}${x.ok ? '' : ' (failed)'}`).join('; ') : 'none'}`);
    seen = r.title;
  }
}
let stopped = false;
function stop() { stopped = true; const p = ps; if (p) { try { p.kill(); } catch {} gone(p); } for (const w of queue.splice(0)) w.res({ ok: false, why: 'stopped' }); }
return { send, stop, setLog: fn => { logTo = fn; } };
}
module.exports = { ...create(), create };
