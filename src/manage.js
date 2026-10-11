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
  fresh: cp => `You are the fresh session after a swap; the swap is done, so do not reply SWAP-READY. Read your checkpoint first: ${cp}, then continue the task.`,
  park: cp => `Park: commit, update your checkpoint (${cp}), then stop.`,
  clear: (cp, f) => `Clear-swap: bring your checkpoint up to date (${cp}) and commit. Add anything the fresh you needs (running jobs, result files) to ${f}. If Remote Control is on for you, turn it off (set_remote_control self false) and add the line "Turn Remote Control back on: set_remote_control self true" to ${f}. Then clear_session self and end your turn. If you can't clear yourself, reply NO-CLEAR instead.`,
  clearRetry: f => `Clear-swap retry: the clear did not happen. Turn Remote Control off if it is on, then clear_session self and end your turn (${f} is ready).`,
  reprompt: f => `Fresh clear-swap: read and follow ${f}`,
};
const KEY = 'Fresh clear-swap: read and follow';   // the reprompt's start as written in a transcript line
const IDLE_MS = 45000, LAND_MS = 2 * 60000;   // the clear lands within ~20 s of the turn's end (tested 10-9)
const baseTitle = t => String(t || '').replace(/\s*\(old\b[^)]*\)\s*$/i, '');
const slug = t => baseTitle(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'task';
const hm = s => { const m = /^(\d\d):(\d\d)$/.exec(s || ''); return m ? +m[1] * 60 + +m[2] : null; };

function create(api) {
  const DRY = !!process.env.SPHERE_MANAGE_DRY;
  const ONLY = process.env.SPHERE_MANAGE_ONLY ? new RegExp(process.env.SPHERE_MANAGE_ONLY, "i") : null;   // live tests: act only on sessions whose title matches
  const mine = s => !!s && (!ONLY || ONLY.test(String(s.title || "")));
  const now = () => process.env.SPHERE_CLOCK ? Date.parse(process.env.SPHERE_CLOCK) + (Date.now() - t0) : Date.now();
  const t0 = Date.now();
  const S = () => api.settings();
  const file = path.join(api.dir, 'manage.json'), logFile = path.join(api.dir, 'manage.log');
  let st = { groups: {}, alias: {}, moved: {}, renewed: {}, fresh: {}, queue: [], swaps: {}, skips: {}, resumed: {}, mode: 'normal', sched: null, warned: {} };
  try { st = { ...st, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  for (const [id, m] of Object.entries(st.moved || {})) {   // clear-swapped sessions read their new conversation after a restart too
    if (m && m.file && Date.now() - m.at < 7 * 864e5 && fs.existsSync(m.file)) api.setMoved(id, m.file); else delete st.moved[id];
  }
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
  const full = p => typeof p === 'string' && /^([A-Za-z]:[\\/]|\\\\)/.test(p);
  const home = s => full(s.cwd) ? s.cwd : full(s.folder) ? s.folder : null;   // the session's full working folder
  function cpOf(s) {
    if (cpCache.has(s.sessionId)) return cpCache.get(s.sessionId);
    let cp = null;
    const f = api.transcriptOf(s.sessionId);
    if (f) try {
      const txt = readFrom(f, 0, 65536, true).replace(/\\\\/g, '\\');
      const abs = /[A-Za-z]:[\\/][^"\n<>|*?:]*?[\\/]\.claude[\\/]checkpoints[\\/][\w.-]+\.md/.exec(txt);   // spaces allowed, no second drive
      const rel = !abs && /\.claude[\\/]checkpoints[\\/]([\w.-]+\.md)/.exec(txt);
      if (abs) cp = path.normalize(abs[0]); else if (rel && home(s)) cp = path.join(home(s), '.claude', 'checkpoints', rel[1]);
    } catch {}
    if (!cp && home(s)) cp = path.join(home(s), '.claude', 'checkpoints', slug(s.title) + '.md');
    if (!cp) return `.claude/checkpoints/${slug(s.title)}.md in your project folder`;   // no full path known (yet): not cached
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
    // Cleared: the old transcript of a clear-swapped session (built-in reader); a reprompted conversation not yet taken over
    // (the reader names it after the reprompt) stays hidden, so it gets the old tile's seat instead of one of its own
    const pending = Object.values(st.swaps).filter(w => w.stage === 'resent' && w.dir && w.askWall && w.file);
    const unclaimed = s => {   // born in a clearing session's folder since its ask, opening with its reprompt
      if (!pending.length || !s.reader || st.alias[s.sessionId]) return false;
      const tf = api.transcriptOf(s.sessionId); if (!tf) return false;   // (the built feed leaves the paths out)
      let b; try { b = fs.statSync(tf).birthtimeMs; } catch { return false; }
      return pending.some(w => !same(tf, w.old) && same(path.dirname(tf), w.dir) && b >= w.askWall - 2000 && opensWith(tf, path.basename(w.file)));
    };
    const sessions = f.sessions.filter(s => st.groups[s.sessionId] !== 'Cleared' && !unclaimed(s)).map(s => {
      const g = st.groups[s.sessionId] || (s.group === 'Session Manager' ? s.group : null);
      const o = { ...s, swapAt: line, pct: s.tokens != null ? Math.min(1, Math.max(0, s.tokens / line)) : s.pct };
      // a clear-swap: the tile plays the swap effect (renewedAt), from the wear it had (renewedPct); the reader's new
      // conversation takes the old one's seat (parentId)
      const rn = st.renewed[s.sessionId];
      if (rn) { o.renewedAt = rn.at; o.renewedPct = rn.pct; if (rn.from !== s.sessionId) o.parentId = rn.from; }
      if (g) o.group = g;
      if (st.alias[s.sessionId]) o.title = st.alias[s.sessionId];   // its new transcript would be named after the reprompt
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
    const tok = s.tokens || 0, age = ageLim > 0 ? ageMin(s) : 0;   // the age costs file stats: only when there is an age limit
    if (sk && tok < sk.tokens && (!ageLim || age < sk.age)) return false;
    return tok >= line || (ageLim > 0 && age >= ageLim);
  }
  const unwarn = id => { for (const k of Object.keys(st.warned)) if (k.endsWith(':' + id)) delete st.warned[k]; };
  const unlinkQ = f => { if (f) try { fs.unlinkSync(f); } catch {} };
  // give the swap up: a caption and a spoken line, and its line waits for the next skip mark
  function drop(s, w, key, text) { delete st.swaps[s.sessionId]; skip(s); unlinkQ(w.file); save(); warn(key + ':' + s.sessionId, text); }
  // an ask that has not got through: keep trying, but not past READY_MS from the first failure (a locked screen all night)
  function sendFailed(s, w, what, r) {
    if (w.sendWhy !== r.why) log(`swap "${w.title}": ${what} failed (${r.why}), trying again`); w.sendWhy = r.why;
    if (!w.failAt) { w.failAt = now(); save(); }
    if (now() - w.failAt > READY_MS) drop(s, w, 'send', `Could not ask ${w.title} to swap for 15 minutes: ${r.why}. Swap it by hand.`);
  }
  const gotThrough = r => r.ok || /^sent\b/.test(r.why || '');   // "sent, but it has not shown up yet" = typed, so never type it again
  // one App control call while the swap is marked as sending, so a cancel cannot slip in between the ask and its stage
  async function sending(w, kind, ...a) { w.sending = true; try { const r = await act(kind, ...a); if (gotThrough(r)) delete w.failAt; return r; } finally { w.sending = false; } }
  let busy = false;
  async function swapStep(s) {
    const id = s.sessionId, w = st.swaps[id], t = now();
    if (!w) {
      if (!due(s) || !idle(s)) return;
      // just swapped and already at the line (the line is below what a fresh session holds: tools and rules): swapping again
      // would loop, so it waits for its next mark and says why once
      const fr = st.fresh[id];
      if (fr && Date.now() - fr < 30 * 60000 && (s.tokens || 0) >= (S().swapTokens || 200000)) {
        skip(s); save(); warn('fresh:' + id, `${baseTitle(s.title)} is over its swap line right after a swap (${Math.round((s.tokens || 0) / 1000)}k tokens). Raise the line in Settings.`);
        return;
      }
      if (!appCtl()) { warn('line:' + id, `${s.title} is at its swap line. Swap it by hand (App control is off).`); return; }
      const method = S().swapMethod === 'new' ? 'new' : 'clear', verb = method === 'clear' ? 'Clear-swapping' : 'Swapping';
      unwarn(id);
      st.swaps[id] = { stage: 'cancel', at: t, since: t, method, title: baseTitle(s.title), folder: s.folder, model: s.model || null, cp: cpOf(s) }; save();
      log(`swap "${s.title}": due (${s.tokens || 0} tokens${S().swapAgeMin ? `, ${Math.round(ageMin(s))} min` : ''}; ${method}); 30 s to cancel`);
      api.cap(`${verb} ${baseTitle(s.title)} in 30 s. Say or click cancel to stop.`); api.say(`${verb} ${baseTitle(s.title)}. Say cancel to stop.`);
      return;
    }
    if (w.stage === 'cancel' && w.method === 'clear') {   // ClearSwap_Spec: the session clears itself, then gets the reprompt
      if (t - w.at < CANCEL_MS || !idle(s)) return;
      const f = api.transcriptOf(id); if (!f) { toNew(w, 'no transcript'); return; }
      w.file = path.join(api.dir, 'clear_swaps', slug(w.title) + '.txt'); w.old = f; w.dir = path.dirname(f); w.from = sizeOf(f);
      try { fs.mkdirSync(path.dirname(w.file), { recursive: true }); fs.writeFileSync(w.file, MSG.fresh(w.cp) + '\n'); } catch (e) { toNew(w, 'could not write ' + w.file); return; }
      w.askWall = Date.now();   // file birth times are real time (the test clock only moves the schedule)
      const r = await sending(w, 'send', id, MSG.clear(w.cp, w.file));
      if (!gotThrough(r)) { sendFailed(s, w, 'clear ask', r); return; }
      w.stage = 'casked'; w.at = t; w.idleAt = 0; save(); log(`swap "${w.title}": asked to clear itself`);
      return;
    }
    if (w.stage === 'casked') {
      if (said(w.old, w.from, 'NO-CLEAR')) { toNew(w, 'it replied NO-CLEAR'); return; }
      if (t - w.at > READY_MS) { drop(s, w, 'clear', `${w.title} did not clear itself within 15 minutes. Swap it by hand.`); return; }
      const size = sizeOf(w.old);
      if (!idle(s) || size <= w.from) { w.idleAt = 0; return; }   // its turn has not ended yet
      if (!w.idleAt) { w.idleAt = t; save(); return; }
      if (t - w.idleAt < IDLE_MS) return;   // the clear lands after the turn ends; typing before it drops the clear
      w.sent = size;
      const r = await sending(w, 'send', id, MSG.reprompt(w.file));
      if (!gotThrough(r)) { log(`swap "${w.title}": reprompt failed (${r.why}), trying again`); return; }
      w.stage = 'resent'; w.at = t; save(); log(`swap "${w.title}": reprompt sent`);
      return;
    }
    if (w.stage === 'resent') {
      const nf = newIn(w.dir, w.askWall - 2000, w.old, [KEY, path.basename(w.file)]);
      if (nf) { landedNew(s, w, nf); return; }
      if (said(w.old, w.sent, KEY, 'user')) {   // the clear was dropped: the reprompt went into the old conversation
        if (w.retried) { toNew(w, 'the clear was dropped twice'); return; }
        w.from = sizeOf(w.old);
        const r = await sending(w, 'send', id, MSG.clearRetry(w.file));
        log(`swap "${w.title}": clear dropped; retry ask ${gotThrough(r) ? 'sent' : 'failed: ' + r.why}`);
        w.retried = true; w.stage = 'casked'; w.at = t; w.idleAt = 0; save();
        return;
      }
      if (t - w.at > LAND_MS) drop(s, w, 'clear', `${w.title}: the clear-swap reprompt was not found. Check the session.`);
      return;
    }
    if (w.stage === 'cancel') {
      if (t - w.at < CANCEL_MS || !idle(s)) return;
      const f = api.transcriptOf(id); w.from = f ? sizeOf(f) : 0;
      const r = await sending(w, 'send', id, MSG.swap(w.cp));
      if (!gotThrough(r)) { sendFailed(s, w, 'ask', r); return; }
      w.stage = 'asked'; w.at = t; save(); log(`swap "${w.title}": asked for SWAP-READY`);
      return;
    }
    if (w.stage === 'asked') {
      if (readyIn(id, w.from)) { w.stage = 'ready'; w.at = t; save(); log(`swap "${w.title}": SWAP-READY`); return; }
      if (t - w.at > READY_MS) drop(s, w, 'ready', `${w.title} did not reply SWAP-READY within 15 minutes. Swap it by hand.`);
      return;
    }
    if (w.stage === 'ready') {
      if (!idle(s)) return;
      const rn = await act('manage', id, 'rename', w.title + ' (old)');
      if (!rn.ok) { log(`swap "${w.title}": rename to (old) failed (${rn.why}), trying again`); if (t - w.at > READY_MS) drop(s, w, 'start', `Could not rename ${w.title} for its swap: ${rn.why}.`); return; }
      const r = await act('new', w.folder, w.model, MSG.fresh(w.cp));
      if (!r.ok) {
        log(`swap "${w.title}": start failed (${r.why})`);
        await act('manage', id, 'rename', w.title);
        drop(s, w, 'start', `Could not start a fresh ${w.title}: ${r.why}.`);
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
      st.groups[id] = 'Archived'; delete st.swaps[id]; unwarn(id); unlinkQ(w.file);
      const nid = String(w.newId || '').replace(/^new:/, ''); if (nid) st.fresh[nid] = Date.now();
      save();
      api.cap(`${w.title} swapped to a fresh session.`);
    }
  }
  // bytes of transcript `f` after `from` (at most the last 4 MB), '' when none or gone; the file is always closed
  function readFrom(f, from, max = 4 << 20, head) {
    let fd; try {
      fd = fs.openSync(f, 'r'); const size = fs.fstatSync(fd).size; if (size <= from) return '';
      const len = Math.min(size - from, max), b = Buffer.alloc(len), n = fs.readSync(fd, b, 0, len, head ? from : size - len);
      return b.toString('utf8', 0, n);
    } catch { return ''; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  }
  const sizeOf = f => { try { return fs.statSync(f).size; } catch { return 0; } };
  // SWAP-READY in an assistant line written since byte `from`
  const readyIn = (id, from) => said(api.transcriptOf(id), from, 'SWAP-READY');
  // did `role` say `word` in transcript `f` since byte `from`? An assistant's text block with the word on a line of its own (or
  // starting / ending one), a user message starting with it; thinking, tool inputs and quoted prose do not count
  const bare = x => String(x).replace(/[*_`"'.!]+/g, '').trim();
  function said(f, from, word, role = 'assistant') {
    if (!f) return false;
    // the word starts or ends the line ("SWAP-READY: committed", "Done, SWAP-READY"); words are plain (letters and '-')
    const at = new RegExp(`^${word}(?![\\w-])|(?<![\\w-])${word}$`);
    for (const l of readFrom(f, from).split('\n')) {
      if (!l.includes(word) || !l.includes(`"${role}"`)) continue;
      let j; try { j = JSON.parse(l); } catch { continue; }
      const m = j && j.message; if (!m || m.role !== role) continue;
      const c = m.content, texts = typeof c === 'string' ? [c] : Array.isArray(c) ? c.filter(x => x && x.type === 'text').map(x => String(x.text || '')) : [];
      for (const x of texts) {
        if (role === 'user' ? x.trim().startsWith(word) : x.split('\n').some(ln => { const b = bare(ln); return at.test(bare(ln)); })) return true;
      }
    }
    return false;
  }
  // a transcript in `dir` born after `at` (not `old`), whose first 1 MB holds every string in `keys` -> its path
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  // does transcript `f` open with `key` (its first 64 KB)? A full head never changes, so a yes or a full head's no is kept
  const heads = new Map();
  function opensWith(f, key) {
    const k = f + '|' + key; if (heads.has(k)) return heads.get(k);
    const t = readFrom(f, 0, 64 << 10, true); if (!t) return false;   // not written yet: ask again later
    const r = t.includes(key); if (r || t.length >= 60 << 10) heads.set(k, r); if (heads.size > 200) heads.delete(heads.keys().next().value);
    return r;
  }
  function newIn(dir, at, old, keys) {
    let names = []; try { names = fs.readdirSync(dir).filter(n => n.endsWith('.jsonl')); } catch { return null; }
    for (const n of names) {
      const p = path.join(dir, n); if (same(p, old)) continue;
      let fst; try { fst = fs.statSync(p); } catch { continue; }
      if (fst.birthtimeMs < at) continue;
      const txt = readFrom(p, 0, 1 << 20, true); if (keys.every(k => txt.includes(k))) return p;
    }
    return null;
  }
  // the reprompt landed in a new transcript: the session goes on there (same app session, same title and group)
  function landedNew(s, w, nf) {
    const id = s.sessionId, nid = path.basename(nf, '.jsonl');
    api.setMoved(id, nf); st.moved[id] = { file: nf, at: Date.now() };   // kept, so a restart still reads the new conversation
    for (const [k, v] of Object.entries(st.renewed)) if (!v || Date.now() - v.at > 864e5) delete st.renewed[k];
    st.renewed[s.reader ? nid : id] = { at: Date.now(), from: id, pct: s.pct != null ? s.pct : null };
    for (const [k, v] of Object.entries(st.fresh)) if (Date.now() - v > 864e5) delete st.fresh[k];
    st.fresh[s.reader ? nid : id] = Date.now();
    if (s.reader) {   // the built-in reader names sessions by transcript: the new one takes over the tile
      st.groups[nid] = st.groups[id] || 'Active'; st.alias[nid] = w.title; st.groups[id] = 'Cleared';
      cpCache.set(nid, w.cp); delete st.skips[nid];
    }
    unlinkQ(w.file);
    delete st.swaps[id]; delete st.skips[id]; unwarn(id); save();   // the fresh conversation starts with no skip mark
    log(`swap "${w.title}": cleared, continues in ${path.basename(nf)}`);
    api.cap(`${w.title} swapped (cleared).`);
  }
  // fall back to a fresh-session swap (ClearSwap_Spec): asks for SWAP-READY first, so the checkpoint is committed
  function toNew(w, why) {
    unlinkQ(w.file); delete w.file;
    w.method = 'new'; w.stage = 'cancel'; w.at = 0; w.since = now(); delete w.failAt; save();
    log(`swap "${w.title}": ${why}; swapping to a new session instead`);
  }
  // swaps whose session left the feed (archived, renamed away, out of the reader's list) end after READY_MS
  function dropGone() {
    const t = now();
    for (const [id, w] of Object.entries(st.swaps)) {
      if (sess(id)) { if (w.goneAt) { delete w.goneAt; save(); } continue; }
      if (!w.goneAt) { w.goneAt = t; save(); }
      else if (t - w.goneAt > READY_MS) { delete st.swaps[id]; unlinkQ(w.file); save(); log(`swap "${w.title}": its session left the list; swap dropped`); }
    }
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
    for (const s of feed.sessions) if (s.group === 'Active' && s.title && mine(s)) {
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
      if (!mine(sess(k))) continue;
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
      if (swapsOn()) dropGone();
      if (swapsOn()) for (const s of feed.sessions) if (mine(s) && (s.group === 'Active' || st.swaps[s.sessionId])) { if (!api.blocked()) await swapStep(s); }
      if (!api.blocked()) await fill();
      for (const k of Object.keys(st.warned)) if (k.startsWith('line:') && !st.swaps[k.slice(5)]) { const s = sess(k.slice(5)); if (!s || !due(s)) { delete st.warned[k]; save(); } }
    } catch (e) { log('error: ' + (e && e.message)); }
    finally { busy = false; }
  }
  setInterval(tick, 20000);

  // ---- voice / menu entry points ----
  function cancel() {
    const w = Object.entries(st.swaps).find(([k, x]) => x.stage === 'cancel' && !x.sending && sess(k)); if (!w) return false;
    const s = sess(w[0]); delete st.swaps[w[0]]; if (s) skip(s); save();
    log(`swap "${w[1].title}": cancelled`); api.cap(`Swap of ${w[1].title} cancelled.`); return true;
  }
  function swapNow(id, method) {   // method 'new': "Swap to a new session" on the Queue chip
    const s = sess(id); if (!s) return { ok: false, why: 'unknown session' };
    if (!appCtl()) return { ok: false, why: 'App control is off' };
    const w0 = st.swaps[s.sessionId]; if (w0 && (w0.stage !== 'cancel' || w0.sending)) return { ok: false, why: 'a swap is already under way' };
    const m = method === 'new' || S().swapMethod === 'new' ? 'new' : 'clear';
    st.swaps[s.sessionId] = { stage: 'cancel', at: 0, method: m, title: baseTitle(s.title), folder: s.folder, model: s.model || null, cp: cpOf(s) }; save();
    log(`swap "${s.title}": asked by hand (${m})`); setTimeout(tick, 50); return { ok: true };
  }
  function noSwap(id) {   // also the click-cancel (tile bar); too late once the fresh session is starting
    const s = sess(id); if (!s) return { ok: false, why: 'unknown session' };
    const w = st.swaps[s.sessionId]; if (w && (w.sending || (w.stage !== 'cancel' && w.stage !== 'asked'))) return { ok: false, why: 'the swap is already under way' };
    delete st.swaps[s.sessionId]; skip(s); save(); log(`swap "${s.title}": skipped until its next line`); return { ok: true }; }

  return {
    apply, tick, cancel, swapNow, noSwap, park, resume, order, logLines, cpOf,
    moved: (id, f) => { if (st.moved[id]) { st.moved[id] = { file: f, at: Date.now() }; save(); } },   // a later move (a rewind) replaces the saved one
    mode: () => st.mode, setMode: m => setMode(m, 'picked'), on, outside: () => outside,
    state: () => ({ on: on(), mode: st.mode, queue: st.queue.slice(), swaps: Object.fromEntries(Object.entries(st.swaps).map(([k, v]) => [k, v.stage])), outside }),
    canceling: () => Object.values(st.swaps).some(x => x.stage === 'cancel' && now() - x.at < CANCEL_MS),
    _schedOf: schedOf,
  };
}
module.exports = { create, MODES, slug };
