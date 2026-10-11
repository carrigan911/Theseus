// Session management (Docs/Specs/SessionManagement_Spec.md): Theseus itself swaps a session at its swap line (fresh session from
// the checkpoint, the old one renamed "(old)" and archived), keeps the mode and its Night / Weekend schedule, and parks / resumes
// sessions with a running cap and a queue. Off by default: then apply() passes the feed through and tick() does nothing.
// Actions go through App control (api.send / api.manage / api.newSession); without it a swap line only warns.
// Tests: SPHERE_MANAGE_DRY=1 logs the App control calls instead of making them; SPHERE_CLOCK=<iso> sets the clock.
'use strict';
const fs = require('fs');
const path = require('path');

const MODES = ['normal', 'worker', 'night', 'weekend', 'performance', 'efficiency'];
const CANCEL_MS = 30000, READY_MS = 15 * 60000, RESUMED_MS = 3 * 60000;
const MSG = {
  swap: cp => `Swap: bring your checkpoint up to date (${cp}), commit, then reply SWAP-READY.`,
  cont: cp => `Continue the task. Read your checkpoint first: ${cp}`,
  park: cp => `Park: commit, update your checkpoint (${cp}), then stop.`,
};
const baseTitle = t => String(t || '').replace(/\s*\(old\b[^)]*\)\s*$/i, '');
const slug = t => baseTitle(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'task';
const hm = s => { const m = /^(\d\d):(\d\d)$/.exec(s || ''); return m ? +m[1] * 60 + +m[2] : null; };

function create(api) {
  const DRY = !!process.env.SPHERE_MANAGE_DRY;
  const now = () => process.env.SPHERE_CLOCK ? Date.parse(process.env.SPHERE_CLOCK) + (Date.now() - t0) : Date.now();
  const t0 = Date.now();
  const S = () => api.settings();
  const file = path.join(api.dir, 'manage.json'), logFile = path.join(api.dir, 'manage.log');
  let st = { groups: {}, queue: [], swaps: {}, skips: {}, resumed: {}, mode: 'normal', sched: null, warned: {} };
  try { st = { ...st, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  let saveT = 0;
  const save = () => { clearTimeout(saveT); saveT = setTimeout(() => { try { fs.writeFileSync(file + '.tmp', JSON.stringify(st, null, 1)); fs.renameSync(file + '.tmp', file); } catch {} if (api.changed) api.changed(); }, 300); };   // changed: main re-applies the groups
  function log(line) {
    api.log('manage: ' + line);
    try {
      fs.appendFileSync(logFile, new Date(now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 19).replace('T', ' ') + ' ' + line + '\n');
      if (fs.statSync(logFile).size > 200000) fs.writeFileSync(logFile, logLines(200).join('\n') + '\n');
    } catch {}
  }
  function logLines(n = 200) { try { return fs.readFileSync(logFile, 'utf8').split('\n').filter(x => x).slice(-n); } catch { return []; } }
  const on = () => !!S().manageOn;
  const appCtl = () => !!S().appControl;
  let feed = { sessions: [] }, outside = false;

  // ---- App control (or its dry stand-in) ----
  let dryN = 0;
  async function act(kind, ...a) {
    if (DRY) {
      log(`dry ${kind} ${a.map(x => JSON.stringify(x)).join(' ')}`);
      return kind === 'new' ? { ok: true, sessionId: 'new:dry-' + (++dryN), title: '' } : { ok: true };
    }
    const r = kind === 'send' ? await api.send(...a) : kind === 'manage' ? await api.manage(...a) : await api.newSession(...a);
    return r || { ok: false, why: 'no answer' };
  }

  // ---- sessions ----
  const sess = id => (feed.sessions || []).find(s => s.sessionId === id || 'new:' + s.sessionId === id || s.sessionId === 'new:' + id);
  const idle = s => s && s.activity === 'idle' && !api.awaiting(s.sessionId);
  const working = s => s && s.activity === 'working';
  // the checkpoint: one named in the session's first lines (…/.claude/checkpoints/x.md), else <folder>/.claude/checkpoints/<slug>.md
  const cpCache = new Map();
  function cpOf(s) {
    if (cpCache.has(s.sessionId)) return cpCache.get(s.sessionId);
    let cp = null;
    const f = api.transcriptOf(s.sessionId);
    if (f) try {
      const fd = fs.openSync(f, 'r'), b = Buffer.alloc(65536), n = fs.readSync(fd, b, 0, b.length, 0); fs.closeSync(fd);
      const txt = b.toString('utf8', 0, n).replace(/\\\\/g, '\\');
      const abs = /[A-Za-z]:[\\/][^"\s<>|*?]*?[\\/]\.claude[\\/]checkpoints[\\/][\w.-]+\.md/.exec(txt);
      const rel = !abs && /\.claude[\\/]checkpoints[\\/]([\w.-]+\.md)/.exec(txt);
      if (abs) cp = path.normalize(abs[0]); else if (rel && s.folder) cp = path.join(s.folder, '.claude', 'checkpoints', rel[1]);
    } catch {}
    if (!cp) cp = path.join(s.folder || '.', '.claude', 'checkpoints', slug(s.title) + '.md');
    cpCache.set(s.sessionId, cp);
    return cp;
  }
  const ageMin = s => { const b = api.bornOf(s.sessionId); return b > 0 ? (Date.now() - b) / 60000 : 0; };   // real time (the test clock is for the schedule)

  // ---- groups: kept here while on; the feed's guess (or an outside manager's group) otherwise ----
  function apply(f) {
    if (!f || !Array.isArray(f.sessions)) return f;
    outside = f.sessions.some(s => s.group === 'Session Manager');
    if (!on()) { feed = f; return f; }
    const line = S().swapTokens || 200000;
    const sessions = f.sessions.map(s => {
      const g = st.groups[s.sessionId] || (s.group === 'Session Manager' ? s.group : null);
      const o = { ...s, swapAt: line, pct: s.tokens != null ? Math.min(1, Math.max(0, s.tokens / line)) : s.pct };
      if (g) o.group = g;
      return o;
    });
    feed = { ...f, sessions };
    return feed;
  }
  function setGroup(id, g) { const s = sess(id); st.groups[s ? s.sessionId : id.replace(/^new:/, '')] = g; save(); }

  // ---- warnings: a caption + a spoken line, once per key until it clears ----
  function warn(key, text) {
    if (st.warned[key]) return;
    st.warned[key] = now(); save();
    log('warn: ' + text); api.cap(text); api.say(text);
  }

  // ---- swaps ----
  const swapsOn = () => on() && S().manageSwaps !== false && (!outside || S().manageOutsideOk);
  function due(s) {
    const line = S().swapTokens || 200000, ageLim = S().swapAgeMin || 0, sk = st.skips[s.sessionId];
    const tok = s.tokens || 0, age = ageMin(s);
    if (sk && tok < sk.tokens && (!ageLim || age < sk.age)) return false;
    return tok >= line || (ageLim > 0 && age >= ageLim);
  }
  let busy = false;
  async function swapStep(s) {
    const id = s.sessionId, w = st.swaps[id], t = now();
    if (!w) {
      if (!due(s) || !idle(s)) return;
      if (!appCtl()) { warn('line:' + id, `${s.title} is at its swap line. Swap it by hand (App control is off).`); return; }
      st.swaps[id] = { stage: 'cancel', at: t, title: baseTitle(s.title), folder: s.folder, model: s.model || null, cp: cpOf(s) }; save();
      log(`swap "${s.title}": due (${s.tokens || 0} tokens, ${Math.round(ageMin(s))} min); 30 s to cancel`);
      api.cap(`Swapping ${baseTitle(s.title)} in 30 s. Say or click cancel to stop.`); api.say(`Swapping ${baseTitle(s.title)}. Say cancel to stop.`);
      return;
    }
    if (w.stage === 'cancel') {
      if (t - w.at < CANCEL_MS || !idle(s)) return;
      const f = api.transcriptOf(id); w.from = f ? fs.statSync(f).size : 0;
      const r = await act('send', id, MSG.swap(w.cp));
      if (!r.ok) { if (!w.sendWhy || w.sendWhy !== r.why) log(`swap "${w.title}": ask failed (${r.why}), trying again`); w.sendWhy = r.why; return; }
      w.stage = 'asked'; w.at = t; save(); log(`swap "${w.title}": asked for SWAP-READY`);
      return;
    }
    if (w.stage === 'asked') {
      if (readyIn(id, w.from)) { w.stage = 'ready'; w.at = t; save(); log(`swap "${w.title}": SWAP-READY`); return; }
      if (t - w.at > READY_MS) { delete st.swaps[id]; skip(s); save(); warn('ready:' + id, `${w.title} did not reply SWAP-READY within 15 minutes. Swap it by hand.`); }
      return;
    }
    if (w.stage === 'ready') {
      if (!idle(s)) return;
      const rn = await act('manage', id, 'rename', w.title + ' (old)');
      if (!rn.ok) { log(`swap "${w.title}": rename to (old) failed (${rn.why}), trying again`); return; }
      const r = await act('new', w.folder, w.model, MSG.cont(w.cp));
      if (!r.ok) {
        log(`swap "${w.title}": start failed (${r.why})`);
        await act('manage', id, 'rename', w.title);
        delete st.swaps[id]; skip(s); save();
        warn('start:' + id, `Could not start a fresh ${w.title}: ${r.why}.`);
        return;
      }
      w.stage = 'naming'; w.newId = r.sessionId; w.at = t; save();
      st.groups[r.sessionId.replace(/^new:/, '')] = st.groups[id] || 'Active';
      log(`swap "${w.title}": fresh session started (${r.sessionId})`);
      return;
    }
    if (w.stage === 'naming') {
      const n = await act('manage', w.newId, 'rename', w.title);
      if (!n.ok) { if (t - w.at > 5 * 60000) { log(`swap "${w.title}": naming the fresh one failed (${n.why}); archiving the old one anyway`); } else return; }
      const a = await act('manage', id, 'archive');
      log(`swap "${w.title}": old one archived: ${a.ok ? 'ok' : a.why}`);
      st.groups[id] = 'Archived'; delete st.swaps[id]; delete st.warned['line:' + id]; save();
      api.cap(`${w.title} swapped to a fresh session.`);
    }
  }
  // SWAP-READY in an assistant line written since byte `from`
  function readyIn(id, from) {
    const f = api.transcriptOf(id); if (!f) return false;
    try {
      const size = fs.statSync(f).size; if (size <= from) return false;
      const fd = fs.openSync(f, 'r'), b = Buffer.alloc(Math.min(size - from, 4 << 20)); fs.readSync(fd, b, 0, b.length, size - b.length); fs.closeSync(fd);
      return b.toString('utf8').split('\n').some(l => l.includes('"assistant"') && l.includes('SWAP-READY'));
    } catch { return false; }
  }
  function skip(s) { st.skips[s.sessionId] = { tokens: (s.tokens || 0) + 50000, age: ageMin(s) + 60 }; }

  // ---- modes and the schedule ----
  const modesOn = () => on() && S().manageModes !== false;
  function schedOf(t) {
    const d = new Date(t), day = d.getDay(), m = d.getHours() * 60 + d.getMinutes(), s = S();
    if (s.weekendOn !== false) {
      const from = hm(s.weekendFrom) ?? 1080, to = hm(s.weekendTo) ?? 390;
      if ((day === 5 && m >= from) || day === 6 || day === 0 || (day === 1 && m < to)) return 'weekend';
    }
    if (s.nightOn !== false) {
      const from = hm(s.nightFrom) ?? 1380, to = hm(s.nightTo) ?? 390;
      if (from > to ? m >= from || m < to : m >= from && m < to) return 'night';
    }
    return 'normal';
  }
  async function setMode(m, why, quiet) {   // quiet: no messages (management just turned on inside a Night / Weekend)
    if (!MODES.includes(m) || m === st.mode) return;
    st.mode = m; save(); log(`mode ${m} (${why})`); api.modeChanged(m);
    const msg = ((S().modeMsgs || {})[m] || '').trim();
    if (quiet || !msg || !appCtl()) return;
    for (const s of feed.sessions) if (s.group === 'Active' && s.title) {
      const r = await act('send', s.sessionId, msg); log(`mode message to "${s.title}": ${r.ok ? 'ok' : r.why}`);
    }
  }
  function schedTick() {
    if (!modesOn()) return;
    const cur = schedOf(now());
    if (st.sched !== cur) { const first = st.sched == null; st.sched = cur; save(); setMode(cur, first ? 'schedule, at start' : 'schedule', first); }
  }

  // ---- parking and the queue ----
  const queueOn = () => on() && S().manageQueue !== false && (!outside || S().manageOutsideOk);
  async function park(id) {
    const s = sess(id); if (!s) return { ok: false, why: 'unknown session' };
    let r = { ok: true };
    if (appCtl()) r = await act('send', s.sessionId, MSG.park(cpOf(s)));
    st.groups[s.sessionId] = 'Parked'; st.queue = [...st.queue.filter(x => x !== s.sessionId), s.sessionId]; save();
    log(`park "${s.title}"${appCtl() ? ': ' + (r.ok ? 'told to stop' : r.why) : ' (App control off: stop it yourself)'}`);
    return { ok: true, why: r.ok ? '' : r.why };
  }
  async function resume(id, why = 'by hand') {
    const s = sess(id); if (!s) return { ok: false, why: 'unknown session' };
    if (!appCtl()) return { ok: false, why: 'App control is off' };
    const r = await act('send', s.sessionId, MSG.cont(cpOf(s)));
    log(`resume "${s.title}" (${why}): ${r.ok ? 'ok' : r.why}`);
    if (!r.ok) return r;
    st.groups[s.sessionId] = 'Active'; st.queue = st.queue.filter(x => x !== s.sessionId); st.resumed[s.sessionId] = now(); save();
    return { ok: true };
  }
  function order(id, where) {
    const s = sess(id), k = s ? s.sessionId : id; if (!st.queue.includes(k)) return { ok: false, why: 'not in the queue' };
    st.queue = st.queue.filter(x => x !== k); if (where === 'first') st.queue.unshift(k); else st.queue.push(k); save();
    log(`queue: "${s ? s.title : k}" ${where}`); return { ok: true };
  }
  function capNow() { return Math.max(0, Number((S().caps || {})[st.mode]) || 0); }
  async function fill() {
    if (!queueOn() || !appCtl()) return;
    if ((st.mode === 'night' || st.mode === 'weekend') && !S().queueAtNight) return;
    const t = now();
    for (const [k, at] of Object.entries(st.resumed)) if (t - at > RESUMED_MS) delete st.resumed[k];
    let n = feed.sessions.filter(s => s.group === 'Active' && (working(s) || st.resumed[s.sessionId])).length;
    for (const k of [...st.queue]) {
      if (n >= capNow()) break;
      if (!sess(k)) continue;
      const r = await resume(k, 'queue'); if (r.ok) n++;
    }
  }

  // ---- the tick: every feed update and every 20 s ----
  async function tick() {
    if (!on() || busy) return;
    busy = true;
    try {
      schedTick();
      if (outside && !S().manageOutsideOk) warn('outside', 'Another session manager is running. Theseus holds its swaps and queue until you confirm in Theseus settings.');
      if (swapsOn()) for (const s of feed.sessions) if (s.group === 'Active' || st.swaps[s.sessionId]) { if (!api.blocked()) await swapStep(s); }
      if (!api.blocked()) await fill();
      for (const k of Object.keys(st.warned)) if (k.startsWith('line:') && !st.swaps[k.slice(5)]) { const s = sess(k.slice(5)); if (!s || !due(s)) { delete st.warned[k]; save(); } }
    } catch (e) { log('error: ' + (e && e.message)); }
    finally { busy = false; }
  }
  setInterval(tick, 20000);

  // ---- voice / menu entry points ----
  function cancel() {
    const w = Object.entries(st.swaps).find(([, x]) => x.stage === 'cancel'); if (!w) return false;
    const s = sess(w[0]); delete st.swaps[w[0]]; if (s) skip(s); save();
    log(`swap "${w[1].title}": cancelled`); api.cap(`Swap of ${w[1].title} cancelled.`); return true;
  }
  function swapNow(id) {
    const s = sess(id); if (!s) return { ok: false, why: 'unknown session' };
    if (!appCtl()) return { ok: false, why: 'App control is off' };
    st.swaps[s.sessionId] = { stage: 'cancel', at: 0, title: baseTitle(s.title), folder: s.folder, model: s.model || null, cp: cpOf(s) }; save();
    log(`swap "${s.title}": asked by hand`); setTimeout(tick, 50); return { ok: true };
  }
  function noSwap(id) {   // also the click-cancel (tile bar); too late once the fresh session is starting
    const s = sess(id); if (!s) return { ok: false, why: 'unknown session' };
    const w = st.swaps[s.sessionId]; if (w && (w.stage === 'ready' || w.stage === 'naming')) return { ok: false, why: 'the swap is already under way' };
    delete st.swaps[s.sessionId]; skip(s); save(); log(`swap "${s.title}": skipped until its next line`); return { ok: true }; }

  return {
    apply, tick, cancel, swapNow, noSwap, park, resume, order, logLines, cpOf,
    mode: () => st.mode, setMode: m => setMode(m, 'picked'), on, outside: () => outside,
    state: () => ({ on: on(), mode: st.mode, queue: st.queue.slice(), swaps: Object.fromEntries(Object.entries(st.swaps).map(([k, v]) => [k, v.stage])), outside }),
    canceling: () => Object.values(st.swaps).some(x => x.stage === 'cancel' && now() - x.at < CANCEL_MS),
    _schedOf: schedOf,
  };
}
module.exports = { create, MODES, slug };
