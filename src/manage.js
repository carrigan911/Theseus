// Session management (Docs/Specs/SessionManagement_Spec.md): Theseus itself swaps a session at its swap line (fresh session from
// the checkpoint, the old one renamed "(old)" and archived), keeps the mode and its Night / Weekend schedule, and parks / resumes
// sessions with a running cap and a queue. Off by default: then apply() passes the feed through and tick() does nothing.
// Actions go through App control (api.send / api.manage / api.newSession); without it a swap line only warns.
// Tests: SPHERE_MANAGE_DRY=1 logs the App control calls instead of making them; SPHERE_CLOCK=<iso> sets the clock.
'use strict';
const fs = require('fs');
const path = require('path');
const PP = require('./privpaths');

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
// sessions the Titans Session manager swaps itself (clear_swap_finish.ps1): their folders, and its hand-off folder
const MGR_ROOTS = (process.env.SPHERE_MGR_ROOTS || PP.mgrRoots).split(';').filter(x => x);
const MGR_SWAPS = process.env.SPHERE_MGR_SWAPS || PP.data + '/clear_swaps';
// one swap lock per session id, shared by every Theseus (the test build too), so only one handler swaps a session
// the Titans Session manager's own swap (swap_self -> swap_me at night, when its chip swap cannot see the app): Theseus
// clear-swaps it and re-prompts it with this file's text
const MGR_START = process.env.SPHERE_MGR_START || PP.data + '/manager_start_prompt.txt';
// a reprompt's search key: its first line up to any quote or backslash (a transcript stores those escaped)
const keyOf = t => String(t).split('\n')[0].replace(/["\\].*$/, '').trim().slice(0, 60);
const LOCKS = process.env.SPHERE_SWAP_LOCKS || path.join(require('os').tmpdir(), 'theseus-swap-locks');
const LOCK_MS = 5 * 60000;   // a lock not refreshed for 5 min (its Theseus quit or hung) is free
const norm = p => path.resolve(String(p)).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const hm = s => { const m = /^(\d\d):(\d\d)$/.exec(s || ''); return m ? +m[1] * 60 + +m[2] : null; };

function create(api) {
  const DRY = !!process.env.SPHERE_MANAGE_DRY;
  const ONLY = process.env.SPHERE_MANAGE_ONLY ? new RegExp(process.env.SPHERE_MANAGE_ONLY, "i") : null;   // live tests: act only on sessions whose title matches
  const mine = s => !!s && (!ONLY || ONLY.test(String(s.title || "")));
  const now = () => process.env.SPHERE_CLOCK ? Date.parse(process.env.SPHERE_CLOCK) + (Date.now() - t0) : Date.now();
  const t0 = Date.now();
  const S = () => api.settings();
  const file = path.join(api.dir, 'manage.json'), logFile = path.join(api.dir, 'manage.log');
  let st = { groups: {}, alias: {}, moved: {}, renewed: {}, fresh: {}, queue: [], swaps: {}, skips: {}, resumed: {}, mode: 'normal', sched: null, warned: {}, wtext: {} };
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

  // ---- swap locks: <LOCKS>/<id>.lock = {pid, dir, at}; ours while this process and userData wrote it ----
  const held = new Set(), lockSaid = {};
  const lockOf = id => path.join(LOCKS, String(id).replace(/[^\w-]/g, '_') + '.lock');
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  function lock(id) {
    const f = lockOf(id);
    try {
      const o = JSON.parse(fs.readFileSync(f, 'utf8')), ours = o.pid === process.pid && o.dir === api.dir;
      if (!ours && Date.now() - fs.statSync(f).mtimeMs < LOCK_MS && alive(o.pid)) {
        if (!lockSaid[id]) { lockSaid[id] = 1; log(`swap ${id}: another handler holds its lock (pid ${o.pid}); left to it`); }
        return false;
      }
    } catch {}
    try { fs.mkdirSync(LOCKS, { recursive: true }); fs.writeFileSync(f, JSON.stringify({ pid: process.pid, dir: api.dir, at: Date.now() })); } catch { return false; }
    held.add(id); delete lockSaid[id]; return true;
  }
  function unlockDone() { for (const id of [...held]) if (!st.swaps[id]) { held.delete(id); try { const o = JSON.parse(fs.readFileSync(lockOf(id), 'utf8')); if (o.pid === process.pid && o.dir === api.dir) fs.unlinkSync(lockOf(id)); } catch {} } }
  // the Titans Session manager swaps these itself: a folder it runs, or its own hand-off file for the session
  function mgrOwned(s) {
    const h = home(s);
    if (h) { const n = norm(h); if (MGR_ROOTS.some(r => { const m = norm(r); return n === m || n.startsWith(m + '/'); })) return 'its folder is run by the Session manager'; }
    const cp = cpCache.get(s.sessionId), names = [slug(s.title)]; if (cp && /\.md$/.test(cp)) names.push(path.basename(cp, '.md'));
    for (const n of names) if (fs.existsSync(path.join(MGR_SWAPS, n + '.txt'))) return `the Session manager's hand-off ${n}.txt exists`;
    // its own clear-swap (clear_swap_auto / clear_swap_finish, which Theseus never runs) logs to auto/<id>.log: a log written in
    // the last 5 min = that swap is running. 10-14 9:35 and 10:17 AM: the hand-off name did not match the cached checkpoint, so
    // Theseus asked the freshly cleared session to clear again (NO-CLEAR, then a new-session swap)
    try { if (Date.now() - fs.statSync(path.join(MGR_SWAPS, 'auto', s.sessionId + '.log')).mtimeMs < 5 * 60000) return 'its own clear-swap is running (auto log)'; } catch {}
    return null;
  }

  // ---- sessions ----
  const sess = id => (feed.sessions || []).find(s => s.sessionId === id || 'new:' + s.sessionId === id || s.sessionId === 'new:' + id);
  const idle = s => s && s.activity === 'idle' && !api.awaiting(s.sessionId);
  const working = s => s && s.activity === 'working';
  // kind of a session (ContextLimits_Spec): the feed's Session Manager; a worker (any other session the manager feed lists);
  // other (found by Theseus's own reader, outside the feed). Each kind has its own swap line.
  const kindOf = s => !s ? 'other' : (s.group === 'Session Manager' || st.groups[s.sessionId] === 'Session Manager') ? 'manager' : s.reader ? 'other' : 'worker';
  const lineOf = s => { const L = S().swapLines || {}; return L[kindOf(s)] || S().swapTokens || 200000; };
  // the checkpoint: one named in the session's first lines (…/.claude/checkpoints/x.md), else <folder>/.claude/checkpoints/<slug>.md
  const cpCache = new Map();
  const full = p => typeof p === 'string' && /^([A-Za-z]:[\\/]|\\\\)/.test(p);
  const home = s => full(s.cwd) ? s.cwd : full(s.folder) ? s.folder : null;   // the session's full working folder
  // Only a file that exists counts (10-14: "Other: Swap Mechanic" got .claude/checkpoints/other-swap-mechanic.md, a title slug
  // that was never its file; a cleared session's transcript opens with the reprompt, so its checkpoint is in the hand-off file,
  // and Theseus's own earlier wrong ask in the transcript must not be taken as the answer).
  const ABS_CP = /[A-Za-z]:[\\/][^"\n<>|*?:]*?[\\/]\.claude[\\/]checkpoints[\\/][\w.-]+\.md/g;   // spaces allowed, no second drive
  const REL_CP = /\.claude[\\/]checkpoints[\\/]([\w.-]+\.md)/g;
  const HANDOFF = /[A-Za-z]:[\\/][^"\n<>|*?:]*?[\\/]clear_swaps[\\/]([\w.-]+)\.txt/g;
  const exists = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };
  function cpOf(s) {
    if (cpCache.has(s.sessionId)) return cpCache.get(s.sessionId);
    const dir = home(s) && path.join(home(s), '.claude', 'checkpoints');
    const cands = [];
    const scan = txt => {
      for (const m of txt.matchAll(ABS_CP)) cands.push(path.normalize(m[0]));
      if (dir) for (const m of txt.matchAll(REL_CP)) cands.push(path.join(dir, m[1]));
    };
    const f = api.transcriptOf(s.sessionId);
    if (f) try {
      const txt = readFrom(f, 0, 65536, true).replace(/\\\\/g, '\\');
      for (const m of txt.matchAll(HANDOFF)) {   // a clear-swap hand-off names the checkpoint; its own name is the checkpoint's slug
        try { scan(fs.readFileSync(path.normalize(m[0]), 'utf8')); } catch {}
        if (dir) cands.push(path.join(dir, m[1] + '.md'));
      }
      scan(txt);
    } catch {}
    const t = slug(s.title), bare = slug(baseTitle(s.title).replace(/^[^:]{1,30}:\s*/, ''));   // "Other: Swap Mechanic" -> swap-mechanic
    if (dir) cands.push(path.join(dir, t + '.md'), path.join(dir, bare + '.md'));
    let cp = cands.find(exists) || null;
    if (!cp && dir) try {   // newest checkpoint named after the title (swap-mechanic-improvement-passes.md), archives left out
      const hit = fs.readdirSync(dir).filter(n => n.endsWith('.md') && !n.endsWith('.archive.md') && (n.startsWith(bare + '-') || n.startsWith(t + '-')))
        .map(n => path.join(dir, n)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
      if (hit) cp = hit;
    } catch {}
    if (!cp) return dir ? path.join(dir, t + '.md') : `.claude/checkpoints/${t}.md in your project folder`;   // none found yet: not cached
    cpCache.set(s.sessionId, cp);
    return cp;
  }
  const ageMin = s => { const b = api.bornOf(s.sessionId); return b > 0 ? (Date.now() - b) / 60000 : 0; };   // real time (the test clock is for the schedule)

  // ---- groups: kept here while on; the feed's guess (or an outside manager's group) otherwise ----
  function apply(f) {
    if (!f || !Array.isArray(f.sessions)) return f;
    outside = f.sessions.some(s => s.group === 'Session Manager');
    if (!on()) { feed = f; return f; }
    // Cleared: the old transcript of a clear-swapped session (built-in reader); a reprompted conversation not yet taken over
    // (the reader names it after the reprompt) stays hidden, so it gets the old tile's seat instead of one of its own
    const pending = Object.values(st.swaps).filter(w => w.stage === 'resent' && w.dir && w.askWall && w.file);
    const unclaimed = s => {   // born in a clearing session's folder since its ask, opening with its reprompt
      if (!pending.length || !s.reader || st.alias[s.sessionId]) return false;
      const tf = api.transcriptOf(s.sessionId); if (!tf) return false;   // (the built feed leaves the paths out)
      let b; try { b = fs.statSync(tf).birthtimeMs; } catch { return false; }
      return pending.some(w => !same(tf, w.old) && same(path.dirname(tf), w.dir) && b >= w.askWall - 2000 && opensWith(tf, w.mgrSelf ? w.key : path.basename(w.file)));
    };
    const sessions = f.sessions.filter(s => st.groups[s.sessionId] !== 'Cleared' && !unclaimed(s)).map(s => {
      const g = st.groups[s.sessionId] || (s.group === 'Session Manager' ? s.group : null);
      const line = lineOf(s), o = { ...s, swapAt: line, pct: s.tokens != null ? Math.min(1, Math.max(0, s.tokens / line)) : s.pct };
      // a clear-swap: the tile plays the swap effect (renewedAt), from the wear it had (renewedPct); the reader's new
      // conversation takes the old one's seat (parentId)
      const rn = st.renewed[s.sessionId];
      if (rn) { o.renewedAt = rn.at; o.renewedPct = rn.pct; if (rn.from !== s.sessionId) o.parentId = rn.from; }
      if (g) o.group = g;
      if (st.alias[s.sessionId]) o.title = st.alias[s.sessionId];   // its new transcript would be named after the reprompt
      const card = swapCard(s.sessionId); if (card) o.swapCard = card;
      return o;
    });
    feed = { ...f, sessions };
    return feed;
  }
  // the swap card over the tile (SwapCard_Spec): the 30 s countdown, the swap's step while it runs, or why it needs you
  const STEP = { asked: 'Updating its checkpoint…', ready: 'Starting the new session…', naming: 'Starting the new session…', casked: 'Updating its checkpoint, then clearing…', resent: 'Starting fresh…' };
  function swapCard(id) {
    if (!swapsOn()) return null;
    const w = st.swaps[id];
    const quiet = S().swapQuiet !== false;   // quiet swaps: no card while a swap runs on its own, only when it needs you
    if (w && !quiet && w.stage === 'cancel' && w.at > 0 && !w.sending) return { kind: 'countdown', text: w.method === 'clear' ? 'Clear-swapping' : 'Swapping', endsAt: Date.now() + Math.max(0, CANCEL_MS - (now() - w.at)) };
    if (w && !quiet) return { kind: 'swapping', text: STEP[w.stage] || 'Starting the swap…' };
    const k = Object.keys(st.wtext).filter(x => x.endsWith(':' + id)).sort((a, b) => (st.warned[b] || 0) - (st.warned[a] || 0))[0];
    return k ? { kind: 'needs', text: st.wtext[k] } : null;
  }
  function setGroup(id, g) { const s = sess(id); st.groups[s ? s.sessionId : id.replace(/^new:/, '')] = g; save(); }

  // ---- warnings: a caption + a spoken line, once per key until it clears ----
  function warn(key, text) {
    if (st.warned[key]) return;
    st.warned[key] = now(); st.wtext[key] = text; (st.wwall = st.wwall || {})[key] = Date.now();
    const s0 = sess(key.slice(key.indexOf(':') + 1)); (st.wtok = st.wtok || {})[key] = s0 && s0.tokens != null ? s0.tokens : null; save();   // (its context then)   // (the text: the swap card over the tile, SwapCard_Spec)
    log('warn: ' + text); api.cap(text); api.say(text);
  }

  // ---- swaps ----
  const NOSWAP = new Set(['Parked', 'Archived', 'Cleared']);
  const selfOn = () => on() && S().manageSwaps !== false;   // the manager's own swap runs even while an outside manager holds swaps
  const swapsOn = () => on() && S().manageSwaps !== false && (!outside || S().manageOutsideOk);
  // the age limit is for the working seats only (Active, the Session manager): an idle Done / Waiting / reader session is left alone
  const ageOf = s => (s.group === 'Active' || kindOf(s) === 'manager') && !s.reader ? S().swapAgeMin || 0 : 0;
  function due(s) {
    // service sessions are never swapped (the Mailer would have to deliver its own re-prompt, McpSends 10-14)
    if ((S().noSwapTitles || ['Other: Mailer']).includes(s.title)) return false;
    const line = lineOf(s), ageLim = ageOf(s), sk = st.skips[s.sessionId];
    const tok = s.tokens || 0, age = ageLim > 0 ? ageMin(s) : 0;   // the age costs file stats: only when there is an age limit
    if (sk && tok < sk.tokens && (!ageLim || age < sk.age)) return false;
    return tok >= line || (ageLim > 0 && age >= ageLim);
  }
  // over its line now, skip marks aside: a session the app compacted or cleared (or swapped by hand) has dropped below it
  const over = s => (s.tokens || 0) >= lineOf(s) || (ageOf(s) > 0 && ageMin(s) >= ageOf(s));
  const unwarn = id => { for (const k of Object.keys(st.warned)) if (k.endsWith(':' + id)) { delete st.warned[k]; delete st.wtext[k]; if (st.wwall) delete st.wwall[k]; if (st.wtok) delete st.wtok[k]; if (st.wold) delete st.wold[k]; } };
  // a session swapped or cleared outside Theseus (by hand in the app, or by itself) writes a newer transcript than the
  // warning: its card no longer applies
  function unwarnMoved() {
    for (const k of Object.keys(st.warned)) {
      const i = k.indexOf(':'); if (i < 0) continue;
      const id = k.slice(i + 1); if (st.swaps[id]) continue;
      const f = api.transcriptOf(id); let b = -1; try { b = fs.statSync(f).birthtimeMs; } catch {}
      // (+2 s: file times and Date.now() may differ by a little)
      if (f && b > ((st.wwall && st.wwall[k]) || st.warned[k]) + 2000) { log(`warning cleared: ${st.wtext[k]} (now in ${path.basename(f)})`); unwarn(id); save(); }
      // a swap card whose swap landed after all (it writes a transcript other than the one the swap left; or, for a card from
      // before that was kept, a clear card whose session now writes a new re-prompted transcript): 10-14 'reprompt not found'
      // came back at every start because its card time was the warning's (10:21), later than the new transcript (10:19)
      else if (f && st.wold && st.wold[k] ? !same(f, st.wold[k]) : (k.startsWith('clear:') && f && b >= ((st.wwall && st.wwall[k]) || Date.now()) - READY_MS && readFrom(f, 0, 64 << 10, true).includes(KEY))) { log(`warning cleared: ${st.wtext[k]} (the swap landed in ${path.basename(f)})`); unwarn(id); save(); }
    }
  }
  // the Session manager's files stay (its start prompt; its hand-offs, which clear_swap_finish.ps1 tidies)
  const unlinkQ = f => { if (f && norm(f) !== norm(MGR_START) && !norm(f).startsWith(norm(MGR_SWAPS) + '/')) try { fs.unlinkSync(f); } catch {} };
  // give the swap up: a caption and a spoken line, and its line waits for the next skip mark
  function drop(s, w, key, text) {
    delete st.swaps[s.sessionId]; skip(s); unlinkQ(w.file); save(); warn(key + ':' + s.sessionId, text);
    // the card's checks (unwarnMoved, the context drop) measure from the swap's start, not the card's: a swap done by hand
    // while Theseus was still asking closes it (10-14: Swap Mechanic was cleared ~9:37 AM, its card came at ~10:02 and stayed)
    const k = key + ':' + s.sessionId;
    if (st.warned[k] && w.old) { (st.wold = st.wold || {})[k] = w.old; save(); }   // (unwarnMoved: a newer transcript than this = it swapped)
    if (st.warned[k] && w.wall) { st.wwall[k] = Math.min(st.wwall[k] || Infinity, w.wall); if (w.tok != null) st.wtok[k] = Math.max(st.wtok[k] || 0, w.tok); save(); }
  }
  // an ask that has not got through: keep trying, but not past READY_MS from the first failure (a locked screen all night)
  function sendFailed(s, w, what, r) {
    if (w.sendWhy !== r.why) log(`swap "${w.title}": ${what} failed (${r.why}), trying again`); w.sendWhy = r.why;
    if (!w.failAt) { w.failAt = now(); save(); }
    if (now() - w.failAt > READY_MS) {
      // already cleared: the hand-off file is all it has left, so it stays and the card says to paste it
      if (what === 'reprompt') { delete st.swaps[s.sessionId]; skip(s); save(); return warn('send:' + s.sessionId, `${w.title} cleared itself but could not be re-prompted for 15 minutes: ${r.why}. Paste ${w.file} into it.`); }
      return drop(s, w, 'send', `Could not ask ${w.title} to swap for 15 minutes: ${r.why}. Swap it by hand.`);
    }
    // a draft in the reply box stays until the user sends or clears it, and each try turns the Claude app to that session:
    // say so once and try again after 1, 2, 4 min (not every tick)
    if (/draft/.test(r.why || '')) {
      w.draftN = (w.draftN || 0) + 1; w.nextTry = now() + Math.min(4, 2 ** (w.draftN - 1)) * 60000; save();
      warn('draft:' + s.sessionId, `${w.title} has unsent text in its reply box. Send or clear it so it can swap.`);
    } else if (/not found|in use/.test(r.why || '')) {
      // 10-14: a renamed session (not found) opened the sidebar on every 20 s tick; Claude in front (in use) waits for the user to
      // leave it. 1, 2, 4 min apart, no card (the 15-minute limit still warns)
      w.missN = (w.missN || 0) + 1; w.nextTry = now() + Math.min(4, 2 ** (w.missN - 1)) * 60000; save();
    }
  }
  const gotThrough = r => r.ok || /^sent\b/.test(r.why || '');   // "sent, but it has not shown up yet" = typed, so never type it again
  // one App control call while the swap is marked as sending, so a cancel cannot slip in between the ask and its stage
  async function sending(w, kind, ...a) { w.sending = true; try { const r = await act(kind, ...a); if (gotThrough(r)) { delete w.failAt; delete w.nextTry; delete w.draftN; delete w.missN; const k = 'draft:' + a[0]; if (kind === 'send' && st.warned[k]) { delete st.warned[k]; delete st.wtext[k]; if (st.wwall) delete st.wwall[k]; if (st.wtok) delete st.wtok[k]; save(); } } return r; } finally { w.sending = false; } }
  let busy = false;
  async function swapStep(s) {
    const id = s.sessionId, w = st.swaps[id], t = now();
    // nothing sent yet and no longer over its line (the app compacted or swapped it meanwhile): the swap and its card go
    if (w && w.stage === 'cancel' && !w.sending && !w.own && w.at > 0 && s.tokens != null && !over(s)) {
      delete st.swaps[id]; unwarn(id); save(); log(`swap "${w.title}": no longer needed (${s.tokens || 0} tokens); dropped`); return;
    }
    const mo = (!w || !w.sending) && !(w && w.own) && mgrOwned(s);   // a session that asked (swap_me) is swapped whoever owns it
    if (mo) {   // never swap what the Session manager swaps (it once got a reprompt to a file Theseus never wrote)
      if (w) { delete st.swaps[id]; save(); log(`swap "${w.title}": dropped, ${mo}`); }
      return;
    }
    if (w && !lock(id)) return;   // another Theseus is swapping it
    if (w && w.nextTry && t < w.nextTry) return;   // waiting out a draft (sendFailed)
    if (!w) {
      if (!due(s) || !idle(s)) return;
      // just swapped and already at the line (the line is below what a fresh session holds: tools and rules): swapping again
      // would loop, so it waits for its next mark and says why once
      const fr = st.fresh[id];
      if (fr && Date.now() - fr < 30 * 60000 && (s.tokens || 0) >= lineOf(s)) {
        skip(s); save(); warn('fresh:' + id, `${baseTitle(s.title)} is over its swap line right after a swap (${Math.round((s.tokens || 0) / 1000)}k tokens). Raise the line in Settings.`);
        return;
      }
      if (!appCtl()) { warn('line:' + id, `${s.title} is at its swap line. Swap it by hand (App control is off).`); return; }
      if (!lock(id)) return;
      const method = S().swapMethod === 'new' ? 'new' : 'clear', verb = method === 'clear' ? 'Clear-swapping' : 'Swapping';
      unwarn(id);
      st.swaps[id] = { stage: 'cancel', at: t, since: t, wall: Date.now(), tok: s.tokens != null ? s.tokens : null, method, title: baseTitle(s.title), folder: s.folder, model: s.model || null, cp: cpOf(s) }; save();
      log(`swap "${s.title}": due (${s.tokens || 0} tokens${ageOf(s) ? `, ${Math.round(ageMin(s))} min` : ''}; ${method}); 30 s to cancel`);
      api.cap(`${verb} ${baseTitle(s.title)} in 30 s. ${S().swapQuiet !== false ? 'Say cancel to stop.' : 'Say or click cancel to stop.'}`); api.say(`${verb} ${baseTitle(s.title)}. Say cancel to stop.`);
      return;
    }
    if (w.stage === 'cancel' && w.method === 'clear') {   // ClearSwap_Spec: the session clears itself, then gets the reprompt
      if (t - w.at < CANCEL_MS || !idle(s)) return;
      const f = api.transcriptOf(id); if (!f) { toNew(w, 'no transcript'); return; }
      // a session's own swap (swap_me) uses its own hand-off file if it wrote one (<mode folder>/clear_swaps/<checkpoint slug>.txt)
      // (a Titans session's hand-off is in the Session manager's folder: <data dir>/clear_swaps/<slug>.txt)
      const names = [...new Set([w.cp && /\.md$/.test(w.cp) ? path.basename(w.cp, '.md') : null, slug(w.title)].filter(x => x))];
      const own = !w.own ? null : [S().modeDir && path.join(S().modeDir, 'clear_swaps'), MGR_SWAPS].filter(x => x)
        .flatMap(d => names.map(n => path.join(d, n + '.txt'))).find(x => fs.existsSync(x)) || null;
      const mine = !!own;
      if (w.mgrSelf && !fs.existsSync(MGR_START)) { drop(s, w, 'clear', `${w.title} asked to swap, but ${MGR_START} is missing. Swap it by hand.`); return; }
      w.file = w.mgrSelf ? MGR_START : mine ? own : path.join(api.dir, 'clear_swaps', slug(w.title) + '.txt'); w.old = f; w.dir = path.dirname(f); w.from = sizeOf(f);
      if (!mine && !w.mgrSelf) try { fs.mkdirSync(path.dirname(w.file), { recursive: true }); fs.writeFileSync(w.file, MSG.fresh(w.cp) + '\n'); } catch (e) { toNew(w, 'could not write ' + w.file); return; }
      w.askWall = Date.now();   // file birth times are real time (the test clock only moves the schedule)
      const r = await sending(w, 'send', id, MSG.clear(w.cp, w.file));
      if (!gotThrough(r)) { sendFailed(s, w, 'clear ask', r); return; }
      w.stage = 'casked'; w.at = t; w.idleAt = 0; save(); log(`swap "${w.title}": asked to clear itself`);
      return;
    }
    if (w.stage === 'casked') {
      followAsk(id, w);
      if (said(w.old, w.from, 'NO-CLEAR')) { toNew(w, 'it replied NO-CLEAR'); return; }
      if (t - w.at > READY_MS && !w.failAt) { drop(s, w, 'clear', `${w.title} did not clear itself within 15 minutes. Swap it by hand.`); return; }
      const size = sizeOf(w.old);
      // still waiting 3 min after the ask: say once why, so a stall shows its cause in the log (Swap Mechanic idea 10-13)
      if (t - w.at > 3 * 60000 && w.waitLog !== w.at) {
        const why = api.awaiting(id) ? 'awaiting (a prompt or approval is open)'
          : size <= w.from ? 'no reply in its transcript yet' : (!idle(s) && !clearQuiet(w)) ? `its turn is still running (${s.activity || 'unknown'})` : 'waiting for the clear after its turn';
        w.waitLog = w.at; save(); log(`swap "${w.title}": waiting: ${why}`);
      }
      if ((!idle(s) && !clearQuiet(w)) || size <= w.from) { w.idleAt = 0; return; }   // its turn has not ended yet
      if (!w.idleAt) { w.idleAt = t; save(); return; }
      if (t - w.idleAt < IDLE_MS) return;   // the clear lands after the turn ends; typing before it drops the clear
      // it swapped itself too (its own self_swap reprompt landed first, 10-14): a second reprompt would name a deleted file
      const cur = api.transcriptOf(id);
      if (cur && !same(cur, w.old) && readFrom(cur, 0, 1 << 20, true).includes(KEY)) { log(`swap "${w.title}": already re-prompted by its own swap; no second reprompt`); landedNew(s, w, cur); return; }
      // never point it at a file that is not there: it would read nothing and stop
      if (!fs.existsSync(w.file)) { delete st.swaps[id]; skip(s); save(); log(`swap "${w.title}": hand-off ${w.file} is gone; no reprompt`); return warn('send:' + id, `${w.title} cleared itself but its hand-off file is gone. Tell it to read its checkpoint: ${w.cp}`); }
      w.sent = size;
      let text = MSG.reprompt(w.file);
      if (w.mgrSelf) { try { text = fs.readFileSync(w.file, 'utf8').trim(); } catch { text = ''; } if (!text) { delete st.swaps[id]; skip(s); save(); log(`swap "${w.title}": ${w.file} is empty; no reprompt`); return warn('send:' + id, `${w.title} cleared itself but ${w.file} is empty. Paste its start prompt into it.`); } }
      w.key = w.mgrSelf ? keyOf(text) : KEY;
      const r = await sending(w, 'send', id, text);
      if (!gotThrough(r)) { sendFailed(s, w, 'reprompt', r); return; }
      w.stage = 'resent'; w.at = t; save(); log(`swap "${w.title}": reprompt sent`);
      return;
    }
    if (w.stage === 'resent') {
      const nf = newIn(w.dir, w.askWall - 2000, w.old, w.mgrSelf ? [w.key] : [KEY, path.basename(w.file)]);
      if (nf) { landedNew(s, w, nf); return; }
      if (said(w.old, w.sent, w.key || KEY, 'user')) {   // the clear was dropped: the reprompt went into the old conversation
        if (w.retried) { toNew(w, 'the clear was dropped twice'); return; }
        w.from = sizeOf(w.old);
        const r = await sending(w, 'send', id, MSG.clearRetry(w.file));
        if (!gotThrough(r)) { sendFailed(s, w, 'clear retry ask', r); return; }
        log(`swap "${w.title}": clear dropped; retry ask sent`);
        w.retried = true; w.stage = 'casked'; w.at = t; w.idleAt = 0; save();
        return;
      }
      if (t - w.at > LAND_MS) drop(s, w, 'clear', `${w.title}: the clear-swap reprompt was not found. Check the session.`);
      return;
    }
    if (w.stage === 'cancel') {
      if (t - w.at < CANCEL_MS || !idle(s)) return;
      const f = api.transcriptOf(id); w.from = f ? sizeOf(f) : 0; w.tf = f || null;
      const r = await sending(w, 'send', id, MSG.swap(w.cp));
      if (!gotThrough(r)) { sendFailed(s, w, 'ask', r); return; }
      w.stage = 'asked'; w.at = t; save(); log(`swap "${w.title}": asked for SWAP-READY`);
      return;
    }
    if (w.stage === 'asked') {
      const tf = api.transcriptOf(id);   // (a new transcript since the ask: read it from its start)
      if (readyIn(id, w.tf && tf && !same(tf, w.tf) ? 0 : w.from)) { w.stage = 'ready'; w.at = t; save(); log(`swap "${w.title}": SWAP-READY`); return; }
      if (t - w.at > READY_MS) drop(s, w, 'ready', `${w.title} did not reply SWAP-READY within 15 minutes. Swap it by hand.`);
      return;
    }
    if (w.stage === 'ready') {
      if (!idle(s)) { if (t - w.at > READY_MS) drop(s, w, 'ready', `${w.title} replied SWAP-READY but did not go idle within 15 minutes. Swap it by hand.`); return; }
      let rn; try { rn = await act('manage', id, 'rename', w.title + ' (old)'); } catch (e) { rn = { ok: false, why: (e && e.message) || 'the rename threw' }; }
      if (!rn.ok) { log(`swap "${w.title}": rename to (old) failed (${rn.why}), trying again`); if (t - w.at > READY_MS) drop(s, w, 'start', `Could not rename ${w.title} for its swap: ${rn.why}.`); return; }
      // a start that throws (a UI error, the app restarting) is a failed start too: never a rename + start again every tick
      let r; try { r = await act('new', w.folder, w.model, MSG.fresh(w.cp)); } catch (e) { r = { ok: false, why: (e && e.message) || 'the start threw' }; }
      if (!r.ok) {
        log(`swap "${w.title}": start failed (${r.why})`);
        // "started, but ..." = the app made the session: no rename back (that would leave two of it at work)
        if (/^started\b/.test(r.why || '')) { drop(s, w, 'start', `A fresh ${w.title} was started but not found (${r.why}). Check it, then archive "${w.title} (old)".`); return; }
        let back; try { back = await act('manage', id, 'rename', w.title); } catch (e) { back = { ok: false, why: e && e.message }; }
        drop(s, w, 'start', `Could not start a fresh ${w.title}: ${r.why}.` + (back && back.ok ? '' : ` It is still titled "${w.title} (old)": rename it back.`));
        return;
      }
      w.stage = 'naming'; w.newId = r.sessionId; w.at = t; save();
      st.groups[r.sessionId.replace(/^new:/, '')] = st.groups[id] || (sess(id) || {}).group || 'Active';   // (a feed group, e.g. Session Manager, too)
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
      api.cap(`${w.title} swapped to a fresh session.`); if (api.swapped) api.swapped(w.title);
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
  // the clear_session result is in the old transcript and nothing was written for CLEAR_QUIET_MS: the clear landed even when the
  // tail looks busy (10-13 Theseus App: a task notification started a turn 4 s after the clearing turn; the clear cut it mid-tool,
  // so the tail read "working" for 15 min and the reprompt never went). File times are real time.
  const CLEAR_MARK = 'conversation will be cleared when this turn ends', CLEAR_QUIET_MS = 90000;
  function clearQuiet(w) {
    let m; try { m = fs.statSync(w.old).mtimeMs; } catch { return false; }
    if (Date.now() - m < CLEAR_QUIET_MS) return false;
    return readFrom(w.old, w.from).split('\n').some(l => l.includes(CLEAR_MARK) && l.includes('"tool_result"') && l.includes('"user"'));
  }
  // SWAP-READY in an assistant line written since byte `from`
  const readyIn = (id, from) => said(api.transcriptOf(id), from, 'SWAP-READY');
  // did `role` say `word` in transcript `f` since byte `from`? An assistant's text block with the word on a line of its own (or
  // starting / ending one), a user message starting with it; thinking, tool inputs and quoted prose do not count
  const bare = x => String(x).replace(/[*_`"'.!]+/g, '').trim();
  function said(f, from, word, role = 'assistant') {
    if (!f) return false;
    // the word starts or ends the line ("SWAP-READY: committed", "Done, SWAP-READY"); words are plain (letters and '-')
    const e = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), at = new RegExp(`^${e}(?![\\w-])|(?<![\\w-])${e}$`);
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
  // the app may carry on a conversation in a new transcript that opens with the clear ask itself (seen 10-11): its reply and
  // turn end are written there, so the swap follows it (a file holding the reprompt is the cleared conversation: not this)
  function followAsk(id, w) {
    const f = api.transcriptOf(id);
    if (!f || !w.old || same(f, w.old)) return;
    let b = -1; try { b = fs.statSync(f).birthtimeMs; } catch {}
    if (b < (w.askWall || 0) - 2000) return;
    const head = readFrom(f, 0, 1 << 20, true);
    if (head.includes(KEY) || (w.key && head.includes(w.key)) || !head.includes('Clear-swap: bring your checkpoint')) return;
    log(`swap "${w.title}": the ask went on in ${path.basename(f)}; following it`);
    w.old = f; w.dir = path.dirname(f); w.from = 0; w.idleAt = 0; save();
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
      st.groups[nid] = st.groups[id] || s.group || 'Active'; st.alias[nid] = w.title; st.groups[id] = 'Cleared';
      cpCache.set(nid, w.cp); delete st.skips[nid];
    }
    { const f = w.file; setTimeout(() => unlinkQ(f), 10 * 60 * 1000).unref(); }   // the fresh session reads the hand-off after it lands: keep it
    delete st.swaps[id]; delete st.skips[id]; unwarn(id); save();   // the fresh conversation starts with no skip mark
    log(`swap "${w.title}": cleared, continues in ${path.basename(nf)}`);
    api.cap(`${w.title} swapped (cleared).`); if (api.swapped) api.swapped(w.title);
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
    if (api.focus && api.focus()) { log(`mode message held: focus`); return; }   // Focus: Theseus sends only swaps
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
  // the mode's cap, moved by usage pacing (autonomy.js capAdj: -1 / +1, -99 = hold until the reset)
  function capNow() { return Math.max(0, (Number((S().caps || {})[st.mode]) || 0) + (api.capAdj ? Number(api.capAdj()) || 0 : 0)); }
  // room for a backlog start (Autonomy part 3): the cap less the sessions working in any group but the manager's and Parked, and
  // less the parked sessions the queue will resume first; nothing while management is off or another manager holds the queue
  function room() {
    if (!on() || (outside && !S().manageOutsideOk)) return { free: 0, mode: st.mode };
    const n = feed.sessions.filter(s => s.group !== 'Session Manager' && s.group !== 'Parked' && (working(s) || st.resumed[s.sessionId])).length;
    const q = queueOn() ? st.queue.filter(k => mine(sess(k))).length : 0;
    return { free: Math.max(0, capNow() - n - q), mode: st.mode };
  }
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
      if ((!outside || S().manageOutsideOk) && st.warned.outside) { delete st.warned.outside; delete st.wtext.outside; save(); }
      if (outside && !S().manageOutsideOk) warn('outside', 'Another session manager is running. Theseus holds its swaps and queue until you confirm in Session Management.');
      if (swapsOn()) dropGone();
      // every kind swaps at its own line (ContextLimits_Spec): the manager, workers and other sessions; parked ones stay put
      if (swapsOn()) { for (const s of feed.sessions) if (mine(s) && (!NOSWAP.has(s.group) || st.swaps[s.sessionId])) { if (!api.blocked()) await swapStep(s); } }
      else if (selfOn()) for (const s of feed.sessions) { const w = st.swaps[s.sessionId]; if (w && w.own && !api.blocked()) await swapStep(s); }   // swaps held: only swaps the sessions asked for (swap_me)
      unlockDone();
      if (!api.blocked()) await fill();
      unwarnMoved();
      // a "needs you" card whose session's context has since dropped (20k+) to under its line: the app compacted or swapped it
      for (const k of Object.keys(st.warned)) { const i = k.indexOf(':'), id = i < 0 ? '' : k.slice(i + 1), s = id && !st.swaps[id] && sess(id), was = st.wtok && st.wtok[k];
        if (s && s.tokens != null && was != null && s.tokens < was - 20000 && !over(s)) { log(`warning cleared: ${st.wtext[k]} (context dropped)`); unwarn(id); save(); } }
      for (const k of Object.keys(st.warned)) if (k.startsWith('line:') && !st.swaps[k.slice(5)]) { const s = sess(k.slice(5)); if (!s || !due(s)) { delete st.warned[k]; delete st.wtext[k]; save(); } }
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
  function swapNow(id, method, own) {   // method 'new': "Swap to a new session" on the Queue chip; own: the session asked (swap_me)
    const s = sess(id); if (!s) return { ok: false, why: 'unknown session' };
    // a session asking for its own swap (swap_me; the Titans Session manager's swap_self at night, its workers when the chip
    // swap fails): Theseus clear-swaps it, swaps held or not; the manager is re-prompted with its start prompt file
    const self = !!own, mself = self && kindOf(s) === 'manager';
    if (self && !selfOn()) return { ok: false, why: on() ? 'swaps are off in Session Management' : 'session management is off (Theseus settings)' };
    if (!self && !swapsOn()) return { ok: false, why: on() ? 'swaps are held (another session manager, or swaps off in Session Management)' : 'session management is off (Theseus settings)' };   // the tick would never run it
    if (!appCtl()) return { ok: false, why: 'App control is off' };
    const mo = !self && mgrOwned(s); if (mo) return { ok: false, why: `the Session manager swaps it (${mo})` };
    if (!lock(s.sessionId)) return { ok: false, why: 'another Theseus is swapping it' };
    const w0 = st.swaps[s.sessionId]; if (w0 && (w0.stage !== 'cancel' || w0.sending)) return { ok: false, why: 'a swap is already under way' };
    const m = !self && (method === 'new' || S().swapMethod === 'new') ? 'new' : 'clear';
    st.swaps[s.sessionId] = { stage: 'cancel', at: 0, wall: Date.now(), tok: s.tokens != null ? s.tokens : null, method: m, title: baseTitle(s.title), folder: s.folder, model: s.model || null, cp: cpOf(s), own: !!own, mgrSelf: mself }; save();
    log(`swap "${s.title}": asked ${own ? 'by the session' : 'by hand'} (${m})`); setTimeout(tick, 50); return { ok: true };
  }
  function noSwap(id) {   // also the click-cancel (tile bar); too late once the fresh session is starting
    const s = sess(id); if (!s) return { ok: false, why: 'unknown session' };
    const w = st.swaps[s.sessionId]; if (w && (w.sending || (w.stage !== 'cancel' && w.stage !== 'asked'))) return { ok: false, why: 'the swap is already under way' };
    delete st.swaps[s.sessionId]; skip(s); unwarn(s.sessionId); save(); log(`swap "${s.title}": skipped until its next line`); return { ok: true }; }

  return {
    apply, tick, cancel, swapNow, noSwap, park, resume, order, logLines, cpOf, room,
    moved: (id, f) => { if (st.moved[id]) { st.moved[id] = { file: f, at: Date.now() }; save(); } },   // a later move (a rewind) replaces the saved one
    mode: () => st.mode, setMode: m => setMode(m, 'picked'), on, outside: () => outside,
    state: () => ({ on: on(), mode: st.mode, queue: st.queue.slice(), swaps: Object.fromEntries(Object.entries(st.swaps).map(([k, v]) => [k, v.stage])), outside }),
    canceling: () => Object.values(st.swaps).some(x => x.stage === 'cancel' && now() - x.at < CANCEL_MS),
    _schedOf: schedOf,
  };
}
module.exports = { create, MODES, slug };
