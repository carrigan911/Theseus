// Talking state: EchoStatus speak.ps1 keeps state\speaking_<pid>.flag (content = playback start, Unix ms) while the voice
// plays, next to speaking_<pid>.env.json (loudness 0..1 every `step` ms). Flags older than 2 min are stale. speaking_<pid>.txt = the line (caption).
// Without an envelope (older speak.ps1, manual flag) the core just stays lit while the flag exists.
const fs = require('fs');
const path = require('path');
const P = require('./paths');
let DIR = '';   // the voice state folder (EchoStatus state, or the built-in voice's), checked again each second

function current() {
  try {
    const now = Date.now(), flags = [];
    for (const f of fs.readdirSync(DIR)) {
      if (!/^speaking.*\.flag$/.test(f)) continue;
      try { const t = fs.statSync(path.join(DIR, f)).mtimeMs; if (now - t < 120000) flags.push({ f, t }); } catch {}   // a flag removed since the listing is just gone
    }
    const f = flags.sort((a, b) => b.t - a.t)[0];
    if (!f) return null;
    let start = 0;
    try { start = Number(fs.readFileSync(path.join(DIR, f.f), 'utf8').trim()); } catch { return null; }
    start = start || f.t;
    let env = null, step = 20;
    try { const e = JSON.parse(fs.readFileSync(path.join(DIR, f.f.replace(/\.flag$/, '.env.json')), 'utf8')); env = e.env; step = e.step || 20; } catch {}
    let text = '';   // the spoken line for the caption (speak.ps1 writes it before the flag)
    try { text = fs.readFileSync(path.join(DIR, f.f.replace(/\.flag$/, '.txt')), 'utf8').trim().slice(0, 400); } catch {}
    return { key: f.f + ':' + f.t + ':' + (env ? 1 : 0), start, step, env, text };   // the envelope can land after the flag: the key changes then
  } catch { return null; }
}

// calls cb({ on, start, step, env }) on every change; fs.watch on the folder reacts at once, a 1 s poll catches the rest (stale flags, a missing folder)
function watch(cb) {
  let last = '', w = null, t;
  const check = () => {
    const c = current(), k = c ? c.key : '';
    if (k !== last) { last = k; cb(c ? { on: true, start: c.start, step: c.step, env: c.env, text: c.text } : { on: false }); }
  };
  const arm = () => {
    const d = P.voiceState();
    if (w && d !== DIR) { try { w.close(); } catch {} w = null; }
    DIR = d;
    if (w || !DIR) return;
    try {
      w = fs.watch(DIR, (_ev, name) => { if (!name || /^speaking/.test(String(name))) { clearTimeout(t); t = setTimeout(check, 30); } });
      w.on('error', () => { try { w.close(); } catch {} w = null; });
    } catch { w = null; }
  };
  arm(); check();
  setInterval(() => { arm(); check(); }, 1000);
}

module.exports = { watch };
