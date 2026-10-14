// Built-in voice: talks to speech.ps1 (one long-lived PowerShell, System.Speech). Used when the External voice add-on is off.
//   const sp = require('./speech').create({ state: dir });  sp.say(text, { speed, voice }) -> Promise (after it played)
//   sp.voices() -> Promise<[name]>;  sp.dispose()
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

function create(opts = {}) {
  let ps = null, buf = '', id = 0, disposed = false, startedAt = 0, downUntil = 0;
  const wait = new Map();   // id -> resolve
  const fail = () => { for (const r of wait.values()) r({ ok: false, why: 'voice helper stopped' }); wait.clear(); };
  function start() {
    if (ps || disposed) return !!ps;
    if (Date.now() < downUntil) return false;   // it died right after starting (no audio device?): not again for 30 s
    startedAt = Date.now();
    try { ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'speech.ps1'), '-State', opts.state || ''], { windowsHide: true }); }
    catch { ps = null; return false; }
    const p = ps; buf = '';
    p.on('error', () => { if (ps === p) { ps = null; fail(); downUntil = Date.now() + 30000; } });
    p.on('exit', () => { if (ps === p) { ps = null; fail(); if (Date.now() - startedAt < 5000) downUntil = Date.now() + 30000; } });
    p.stdin.on('error', () => {});
    p.stderr.on('data', () => {});
    p.stdout.setEncoding('utf8');   // a character split between chunks stays whole
    p.stdout.on('data', d => {
      if (ps !== p) return;
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id != null && wait.has(m.id)) { const r = wait.get(m.id); wait.delete(m.id); r(m); }
      }
    });
    return true;
  }
  // a helper that is stuck (a hung SAPI call) is killed, so the next line starts a fresh one instead of queueing behind it
  function kill() {
    if (!ps) return;
    const pid = ps.pid; try { ps.kill(); } catch {} ps = null;
    if (opts.state && pid) for (const x of ['flag', 'txt']) fs.unlink(path.join(opts.state, `speaking_${pid}.${x}`), () => {});
    fail();
  }
  function send(cmd, ms, killOnTimeout) {
    if (!start()) return Promise.resolve({ ok: false, why: 'no voice helper' });
    const n = ++id;
    return new Promise(res => {
      // only the oldest line waiting can be the stuck one: a line queued behind long ones has not started playing yet
      const t = setTimeout(() => { const oldest = n === Math.min(...wait.keys()); if (wait.delete(n)) { res({ ok: false, why: 'timeout' }); if (killOnTimeout && oldest) kill(); } }, ms);
      wait.set(n, r => { clearTimeout(t); res(r); });
      try { ps.stdin.write(JSON.stringify({ id: n, ...cmd }) + '\n'); } catch { wait.delete(n); clearTimeout(t); res({ ok: false, why: 'write failed' }); }
    });
  }
  return {
    // speed 0.6..1.6 (the Speed setting) -> SAPI rate -10..10
    say: (text, o = {}) => send({ cmd: 'say', text: String(text || '').slice(0, 2000), rate: Math.round(((Number(o.speed) || 1) - 1) * 10), voice: o.voice || '' }, 120000, true),
    voices: () => send({ cmd: 'voices' }, 15000).then(r => (r && r.voices) || []),
    dispose() {   // killed mid-line its finally never runs: its talking flag files go here
      disposed = true; kill(); fail();
    },
  };
}
module.exports = { create };
