// The Mailer (Titans Docs/Specs/McpSends_Spec.md): a small Claude session that sends background messages with the app's own
// send_message, so no automatic send drives the Claude window. A request is MCP_OUTBOX/<to>-<stamp>.json
// { to, text, remoteControl, from, at }; the Mailer answers <same>.done { ok, why, at }. Its watcher touches mailer.alive every
// few seconds, so a fresh file = up. Not up or no answer in time -> the caller falls back to the UI send (and logs it).
'use strict';
const fs = require('fs');
const path = require('path');
const PP = require('./privpaths');

function create(opt = {}) {
  const DIR = opt.dir || process.env.SPHERE_MCP_OUTBOX || PP.data + '/mcp_outbox';
  const maxAge = opt.maxAgeMs || 300e3, wait = opt.waitMs || 180e3, step = opt.stepMs || 1000;
  const now = () => opt.now ? opt.now() : Date.now();
  let n = 0;
  function alive() {
    try { const age = now() - fs.statSync(path.join(DIR, 'mailer.alive')).mtimeMs; return age <= maxAge ? null : `mailer.alive is ${Math.round(age / 1000)} s old`; }
    catch { return 'no mailer.alive'; }
  }
  // -> { ok } | { ok: false, why, down } (down: never handed over, so the UI send is safe)
  async function send(to, text, remoteControl) {
    const no = alive(); if (no) return { ok: false, why: no, down: true };
    const name = `${to}-${now()}-${n++}`, req = path.join(DIR, name + '.json'), done = path.join(DIR, name + '.done');
    try { fs.writeFileSync(req + '.tmp', JSON.stringify({ to, text, remoteControl: !!remoteControl, from: 'theseus', at: new Date(now()).toISOString() })); fs.renameSync(req + '.tmp', req); }
    catch (e) { return { ok: false, why: 'write: ' + (e && e.message), down: true }; }
    for (let t = 0; t < wait; t += step) {
      await new Promise(r => setTimeout(r, step));
      const at = fs.existsSync(done) ? done : req + '.done';   // the Mailer has written x.json.done (10-14)
      let d; try { d = JSON.parse(fs.readFileSync(at, 'utf8').replace(/^\uFEFF/, '')); } catch { continue; }
      try { fs.unlinkSync(at); } catch {}
      return d.ok ? { ok: true } : { ok: false, why: String(d.why || 'failed') };
    }
    try { fs.unlinkSync(req); return { ok: false, why: `no answer in ${Math.round(wait / 1000)} s (withdrawn)`, down: true }; }
    catch { return { ok: false, why: `no answer in ${Math.round(wait / 1000)} s (taken, may still arrive)` }; }
  }
  return { alive, send, DIR };
}
module.exports = { create };
