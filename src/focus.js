// Focus (Docs/Specs/Focus_Spec.md; the Titans FocusMode_Spec owns the format): one flag file shared with the Session manager,
// <data dir>/focus_state.json = { on, until (ISO or null), level (night|weekend|worker|custom), setBy, at }, read the way
// Titans' focus.ps1 -Status and TitansMod (logic.ts focusLevel) read it: the newer of this file and editor_limits.json (the
// mode) wins. A newer mode = its preset (night / weekend / worker on, day modes off); a newer file = its on / off, and once
// its until has passed the mode's preset again. Theseus writes the file from its button only and reads it back every 2 s.
// The outbox (FocusMode_Spec part 1): <data dir>/theseus_outbox/<sessionId>.json = { text, remoteControl } is a re-prompt
// a clear-swap finisher hands to Theseus; Theseus sends it to that session and writes <sessionId>.done = { ok, why, at }.
'use strict';
const fs = require('fs');
const path = require('path');
const PP = require('./privpaths');

const LEVELS = ['night', 'weekend', 'worker', 'custom'];
const RC_LINE = 'Turn Remote Control back on: set_remote_control self true';
const pad = n => String(n).padStart(2, '0');
// local time with its offset, as focus.ps1 writes it (2026-10-13T22:00:00-07:00)
function localIso(ms) { const d = new Date(ms), o = -d.getTimezoneOffset(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${o >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(o) / 60))}:${pad(Math.abs(o) % 60)}`; }

function create(api) {
  const FILE = api.file || process.env.SPHERE_FOCUS_FILE || PP.data + '/focus_state.json';
  const now = () => api.now ? api.now() : Date.now();
  let cur = null, curText = '';

  function read() {
    let t = ''; try { t = fs.readFileSync(FILE, 'utf8').replace(/^\uFEFF/, ''); } catch { return { raw: null, text: '' }; }
    try { return { raw: JSON.parse(t), text: t }; } catch { return { raw: cur, text: curText }; }   // half-written: keep the last
  }
  const untilMs = j => j && j.until ? Date.parse(j.until) : NaN;
  const OUTBOX = api.outbox || process.env.SPHERE_OUTBOX || PP.data + '/theseus_outbox';
  const LIMITS = path.join(path.dirname(FILE), 'editor_limits.json');
  const mtime = f => { try { return fs.statSync(f).mtimeMs; } catch { return null; } };
  function preset() {   // the mode's focus preset (focus.ps1): night -> night / weekend, worker -> worker, else none
    let m = null; try { m = JSON.parse(fs.readFileSync(LIMITS, 'utf8').replace(/^\uFEFF/, '')); } catch {}
    const mode = (m && m.mode) || 'normal';
    return mode === 'night' ? (m.weekend ? 'weekend' : 'night') : mode === 'worker' ? 'worker' : null;
  }
  // what the UI shows: { on, until, level, setBy } (setBy 'mode' when the mode's preset decides)
  function state() {
    const p = preset(), fT = cur ? mtime(FILE) : null, mT = mtime(LIMITS);
    const byMode = { on: !!p, until: null, level: p, setBy: p ? 'mode' : null };
    if (!cur || fT == null || (mT != null && fT < mT)) return byMode;
    if (!cur.on) return { on: false, until: null, level: null, setBy: cur.setBy || null };
    if (untilMs(cur) <= now()) return byMode;
    return { on: true, until: cur.until || null, level: cur.level || p || 'custom', setBy: cur.setBy || null };
  }
  const isOn = () => state().on;
  function write(j) {
    const t = JSON.stringify(j, null, 2);
    try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE + '.tmp', t); fs.renameSync(FILE + '.tmp', FILE); }
    catch (e) { api.log('focus: could not write ' + FILE + ': ' + (e && e.message)); return false; }
    cur = j; curText = t; return true;
  }
  // set Focus: on with an until (ms, ISO or null = until off) and a level, or off; unknown fields of the file are kept
  function set(on, opt = {}) {
    const u = opt.until == null ? null : typeof opt.until === 'number' ? localIso(opt.until) : String(opt.until);
    const lv = LEVELS.includes(opt.level) ? opt.level : 'custom';
    const j = { ...(cur || {}), on: !!on, until: on ? u : null, level: lv, setBy: opt.setBy || 'user', at: localIso(now()).slice(0, 19) };   // at: local time, no offset (focus.ps1)
    if (!write(j)) return state();
    api.log(`focus ${on ? 'on' + (u ? ' until ' + u : '') + ` (${lv})` : 'off'} by ${j.setBy}`);
    api.changed(state(), null);
    return state();
  }
  function extend(ms) { const s = state(); if (!s.on || !s.until) return set(true, { until: now() + ms, level: s.level }); return set(true, { until: Math.max(Date.parse(s.until), now()) + ms, level: s.level }); }
  // (modes need no write: a mode change is a newer editor_limits.json, whose preset wins)
  let last = null, endedFor = null;
  function poll() {
    const r = read(); if (r.text !== curText) { cur = r.raw; curText = r.text; }
    const s = state(), k = JSON.stringify(s); if (k === last) return;
    const prev = last ? JSON.parse(last) : null; last = k;
    // its until-time passed: say so once (the file stays; the mode's preset takes over, as focus.ps1 reads it)
    const ended = prev && prev.on && prev.until && cur && cur.until === prev.until && untilMs(cur) <= now() && endedFor !== cur.until;
    if (ended) { endedFor = cur.until; api.log('focus: its until-time passed'); }
    api.changed(s, ended ? 'ended' : null);
  }

  // ---- the outbox ----
  const inFlight = new Set(), tries = {};
  async function outbox() {
    let names = []; try { names = fs.readdirSync(OUTBOX).filter(n => /\.json$/i.test(n)); } catch { return; }
    for (const n of names) {
      const id = n.replace(/\.json$/i, ''), f = path.join(OUTBOX, n), done = path.join(OUTBOX, id + '.done');
      if (inFlight.has(id)) continue;
      let j; try { j = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { continue; }   // still being written
      const finish = (ok, why) => {
        try { fs.writeFileSync(done, JSON.stringify({ ok, why: why || null, at: new Date().toISOString() })); fs.unlinkSync(f); } catch {}
        delete tries[id]; api.log(`outbox ${id}: ${ok ? 'sent' : 'failed: ' + why}`);
      };
      const text = String((j && j.text) || '').trim();
      if (!text) { finish(false, 'no text'); continue; }
      // Theseus cannot flip Remote Control itself: the re-prompt asks the session to (as the clear-swap hand-offs do)
      const body = j.remoteControl && !text.includes(RC_LINE) ? text + '\n' + RC_LINE : text;
      inFlight.add(id);
      try {
        const r = await api.send(id, body) || { ok: false, why: 'no answer' };
        if (r.ok || /^sent\b/.test(r.why || '')) finish(true, r.ok ? null : r.why);
        else if ((tries[id] = (tries[id] || 0) + 1) >= 3) finish(false, r.why);
        else api.log(`outbox ${id}: ${r.why}; trying again`);
      } catch (e) { if ((tries[id] = (tries[id] || 0) + 1) >= 3) finish(false, (e && e.message) || 'send threw'); }
      finally { inFlight.delete(id); }
    }
  }

  const r0 = read(); cur = r0.raw; curText = r0.text;
  let t1 = 0, t2 = 0, obBusy = false;
  const start = () => {
    setTimeout(poll, 0); t1 = setInterval(poll, 2000);
    t2 = setInterval(async () => { if (obBusy) return; obBusy = true; try { await outbox(); } finally { obBusy = false; } }, 2000);
  };
  const stop = () => { clearInterval(t1); clearInterval(t2); };
  return { state, active: isOn, set, extend, poll, outbox, start, stop, FILE, OUTBOX };
}
module.exports = { create, localIso, RC_LINE };
