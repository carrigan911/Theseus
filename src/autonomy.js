// Autonomy (Docs/Specs/Autonomy_Spec.md). Part 1, stall recovery: a session that stopped partway gets a nudge. An API error
// gets "continue" after a minute, a tool-error loop gets a step-back message, and a session Theseus asked to keep going that
// went quiet gets its checkpoint again. At most 2 nudges per session an hour; then it is marked stuck and Theseus says so.
// Part 4a, done check: a session whose finished turn says it is done gets one reminder when its work is not committed or its
// checkpoint is older than its last commit; otherwise its tile gets a green tick (doneTick) until it writes again.
// Part 2, usage pacing: the Claude app's Usage button names the binding plan window and its reset. 5-hour: near the limit the
// running cap drops by one. Weekly: the cap follows a line to ~95% at the reset (over it -1, well under it +1). At the limit,
// or on a rate_limit error, every working session is parked until the reset; the queue then resumes them.
// Part 3, the backlog: tasks (a project folder + text) wait in order and start as new sessions, one at a time, while there is
// room under the mode's cap; they show as dim queued tiles in a Backlog group; one that passes the done check is marked done.
// Part 4b, away alerts and the digest: after 10 min with no input, a session that waits on the user or is stuck becomes an away
// alert (a list the phone app reads); at the end of Night mode (or on "what happened") a digest of commits per project, swaps,
// backlog tasks, stalls, limit hits and what still waits is shown on a card and spoken short.
// Off by default (settings.autoStall / autoDone / autoPace / autoBacklog / autoDigest, under Session management); without App control it only warns.
// Tests: SPHERE_MANAGE_DRY=1 logs the sends instead of making them; SPHERE_MANAGE_ONLY=<regex> acts only on matching titles.
'use strict';
const fs = require('fs');
const path = require('path');

const HOUR = 3600e3, ERR_WAIT = 60e3, MAX_NUDGES = 2, EXPECT_MS = 6 * HOUR;
const MSG = {
  err: 'Continue from where you stopped.',
  loop: e => `The same error came back 3 times: ${e.replace(/\s+/g, ' ').slice(0, 160)}. Step back, read your checkpoint, try another way.`,
  quiet: cp => `Continue the task. Read your checkpoint first: ${cp}`,
  done: cp => `Before you stop: commit your work and update your checkpoint (${cp}).`,
  task: (text, slug) => `${text}\n\nWrite a checkpoint at \`.claude/checkpoints/${slug}.md\` in this project as you go, and commit after each step.`,
};
// part 3, the backlog: a task's checkpoint name and its tile / session title
const slugOf = t => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'task';
const titleOf = t => { const w = String(t).replace(/\s+/g, ' ').trim().split(' '), s = w.slice(0, 6).join(' '); return (s.length > 48 ? s.slice(0, 48) : s) + (w.length > 6 || s.length > 48 ? '…' : ''); };
const START_GAP = 90e3, RETRY_MS = 10 * 60e3, KEEP_DONE = 7 * 24 * HOUR;
const USAGE_MS = 5 * 60e3, WEEK = 7 * 24 * HOUR;
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
// "Usage: Context 216.8k / 300k (72%), Weekly · all models: 86%, Resets Mon 2:00 PM" -> { kind, label, pct, resetsAt } or null
function parseUsage(text, now = Date.now()) {
  const m = /((?:5-hour|weekly)[^:,]*):\s*(\d+(?:\.\d+)?)%(?:,\s*resets\s+([^,]+))?/i.exec(String(text || ''));
  if (!m) return null;
  return { kind: /^5-hour/i.test(m[1]) ? '5h' : 'week', label: m[1].trim(), pct: Number(m[2]), resetsAt: m[3] ? parseReset(m[3], now) : 0 };
}
// "Mon 2:00 PM" / "3:40 PM" / "14:00" -> the next such moment (local time), or 0
function parseReset(t, now = Date.now()) {
  const m = /^(?:(sun|mon|tue|wed|thu|fri|sat)\w*\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(String(t).trim()); if (!m) return 0;
  let h = Number(m[2]) % 12 + (/pm/i.test(m[4] || '') ? 12 : 0); if (!m[4]) h = Number(m[2]);
  const d = new Date(now); d.setHours(h, Number(m[3] || 0), 0, 0);
  if (m[1]) { const want = DAYS.indexOf(m[1].toLowerCase()); let add = (want - d.getDay() + 7) % 7; if (add === 0 && d.getTime() <= now) add = 7; d.setDate(d.getDate() + add); }
  else if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}
const DONE_WORDS = /\b(done|finished|complete[d]?|all set)\b/i, CP_STALE = 30 * 60e3;
const FINISHED = /\b(done|finished|complete[d]?|all set|SWAP-READY)\b/i;
// error classes a nudge cannot fix: the user signs in again, or the session needs a swap (Autonomy part 2 owns rate_limit)
const NO_NUDGE = { authentication_failed: 'needs you to sign in again', rate_limit: null, billing_error: 'is out of usage credits' };

function create(api) {
  const DRY = !!process.env.SPHERE_MANAGE_DRY;
  const ONLY = process.env.SPHERE_MANAGE_ONLY ? new RegExp(process.env.SPHERE_MANAGE_ONLY, 'i') : null;
  const mine = s => !!s && (!ONLY || ONLY.test(String(s.title || '')));
  const S = () => api.settings();
  const file = path.join(api.dir, 'autonomy.json');
  let st = { nudges: {}, done: {}, stuck: {}, expect: {}, warned: {}, left: {}, fin: {}, tick: {}, usage: null, hold: 0, backlog: [], lastStart: 0, events: [], alerts: [], away: {}, nightFrom: 0, lastDigest: null };
  try { st = { ...st, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  let saveT = 0;
  const save = () => { clearTimeout(saveT); saveT = setTimeout(() => { try { fs.writeFileSync(file + '.tmp', JSON.stringify(st, null, 1)); fs.renameSync(file + '.tmp', file); } catch {} if (api.changed) api.changed(); }, 300); };
  const log = line => api.log('auto: ' + line);
  const stallOn = () => !!S().manageOn && !!S().autoStall;
  const paceOn = () => !!S().manageOn && !!S().autoPace;
  const doneOn = () => !!S().manageOn && !!S().autoDone;
  const backlogOn = () => !!S().manageOn && !!S().autoBacklog;
  const digestOn = () => !!S().manageOn && !!S().autoDigest;
  // part 4b: what happened, for the digest (kept 14 days whatever the switches)
  function note(kind, text, extra) { st.events.push({ at: Date.now(), kind, text: String(text || ''), ...extra }); if (st.events.length > 500) st.events.splice(0, st.events.length - 500); save(); }
  const quietMs = () => Math.max(1, Number(S().autoQuietMin) || 10) * 60e3;

  function warn(key, text) {
    if (st.warned[key]) return;
    st.warned[key] = Date.now(); save();
    log('warn: ' + text); api.cap(text); api.say(text);
  }
  async function send(s, text, why) {
    const recent = (st.nudges[s.sessionId] || []).filter(t => Date.now() - t < HOUR);
    if (recent.length >= MAX_NUDGES) {
      if (!st.stuck[s.sessionId]) { st.stuck[s.sessionId] = Date.now(); save(); log(`"${s.title}" stuck (${why})`); note('stuck', s.title); }
      warn('stuck:' + s.sessionId, `${s.title} is stuck.`);
      return false;
    }
    if (api.focus && api.focus()) { log(`nudge "${s.title}" held: focus (${why})`); return false; }   // Focus: no nudges
    if (!S().appControl) { warn(why + ':' + s.sessionId, `${s.title} has stopped (${why}). App control is off, so Theseus did not nudge it.`); return false; }
    let r;
    if (DRY) { log(`dry send ${JSON.stringify(s.sessionId)} ${JSON.stringify(text)}`); r = { ok: true }; }
    else r = await api.send(s.sessionId, text) || { ok: false, why: 'no answer' };
    if (!r.ok) { log(`nudge "${s.title}" failed: ${r.why || '?'}`); return false; }
    st.nudges[s.sessionId] = [...recent, Date.now()]; save();
    log(`nudge "${s.title}" (${why})`); note('nudge', s.title, { why });
    return true;
  }

  // what to do about one session now: null, or { key, why, text } (key: the stall it answers, so each is nudged once)
  function stallOf(s, sig, mtime) {
    if (sig.err) {
      const k = sig.err.kind;
      if (k in NO_NUDGE) return NO_NUDGE[k] ? { warnOnly: `${s.title} ${NO_NUDGE[k]}.`, key: 'err:' + sig.err.at } : null;
      if (k === 'invalid_request' && /prompt is too long|thrashing/i.test(sig.err.text)) return { warnOnly: `${s.title} has run out of context and needs a swap.`, key: 'err:' + sig.err.at, swap: true };
      if (Date.now() - (sig.err.at || mtime) < ERR_WAIT) return null;
      return { key: 'err:' + sig.err.at, why: 'API error', text: MSG.err };
    }
    if (sig.loop) return { key: 'loop:' + mtime, why: 'error loop', text: MSG.loop(sig.loop) };
    const ex = st.expect[s.sessionId];
    if (ex && Date.now() - ex < EXPECT_MS && mtime > ex && Date.now() - mtime > quietMs() && !(sig.end && FINISHED.test(sig.end)))
      return { key: 'quiet:' + mtime, why: 'quiet', text: MSG.quiet(api.cpOf(s)) };
    return null;
  }

  async function stallTick(sessions) {
    for (const s of sessions) {
      if (!mine(s) || s.activity !== 'idle' || api.awaiting(s.sessionId) || st.left[s.sessionId]) continue;
      const f = api.transcriptOf(s.sessionId); if (!f) continue;
      const sig = api.signals(f); if (!sig) continue;
      let mtime; try { mtime = fs.statSync(f).mtimeMs; } catch { continue; }
      // stuck clears once the session writes again on its own (a later turn with no stall)
      if (st.stuck[s.sessionId] && mtime > st.stuck[s.sessionId] + 5000 && !sig.err && !sig.loop) { delete st.stuck[s.sessionId]; delete st.warned['stuck:' + s.sessionId]; save(); }
      const d = stallOf(s, sig, mtime); if (!d) continue;
      const done = st.done[s.sessionId] || [];
      if (done.includes(d.key)) continue;
      if (d.warnOnly) {
        warn(d.key + ':' + s.sessionId, d.warnOnly);
        if (d.swap && api.swapNow) api.swapNow(s.sessionId);
      } else if (!(await send(s, d.text, d.why))) continue;
      st.done[s.sessionId] = [...done, d.key].slice(-10); save();
    }
  }

  // part 4a: one finished turn is checked once (key: the transcript's mtime then)
  async function doneTick(sessions) {
    for (const s of sessions) {
      if (!mine(s) || s.activity !== 'idle' || api.awaiting(s.sessionId)) continue;
      const f = api.transcriptOf(s.sessionId); if (!f) continue;
      let mtime; try { mtime = fs.statSync(f).mtimeMs; } catch { continue; }
      const tk = st.tick[s.sessionId]; if (tk && tk !== mtime) { delete st.tick[s.sessionId]; save(); }   // it wrote again: the tick goes
      if (st.fin[s.sessionId] === mtime || Date.now() - mtime < 30e3) continue;
      const sig = api.signals(f); if (!sig || sig.err || !sig.end || !DONE_WORDS.test(sig.end) || /SWAP-READY/.test(sig.end)) continue;
      st.fin[s.sessionId] = mtime; save();
      const dir = s.cwd || s.folder; if (!dir || !/^([A-Za-z]:[\\/]|\\\\)/.test(dir)) continue;
      const c = await api.git.changes(dir); if (!c || !c.ok) continue;   // not a git folder: nothing to check
      const dirty = (c.files || []).filter(x => !x.untracked).length;
      const cp = api.cpOf(s); let cpAt = 0; try { cpAt = fs.statSync(cp).mtimeMs; } catch {}
      const last = cpAt ? await api.git.lastCommit(dir) : 0, stale = cpAt && last && cpAt < last - CP_STALE;
      if (dirty || stale) { log(`done check "${s.title}": ${dirty ? dirty + ' uncommitted' : ''}${dirty && stale ? ', ' : ''}${stale ? 'checkpoint behind' : ''}`); if (await send(s, MSG.done(cp), 'done check')) { delete st.expect[s.sessionId]; save(); } }   // (its short reply after committing is no quiet stall)
      else { st.tick[s.sessionId] = mtime; taskDone(s, f); save(); log(`done "${s.title}"`); note('done', s.title); }
    }
  }

  // part 2: the running-cap adjustment manage.js adds to the mode's cap (-99: hold, nothing runs)
  function capAdj(now = Date.now()) {
    if (!paceOn()) return 0;
    if (st.hold && now < st.hold) return -99;
    const u = st.usage; if (!u || now - u.at > 6 * USAGE_MS) return 0;   // no fresh reading: leave the cap alone
    if (u.kind === '5h') return u.pct >= (Number(S().autoWarnPct) || 80) ? -1 : 0;
    if (!u.resetsAt) return 0;
    const target = Number(S().autoWeekTarget) || 95, frac = Math.min(1, Math.max(0, 1 - (u.resetsAt - now) / WEEK)), line = target * frac;
    return u.pct >= target || u.pct > line + 5 ? -1 : u.pct < line - 10 ? 1 : 0;   // at the target: one fewer even when nothing is parked
  }
  let usageAt = 0;
  async function paceTick(sessions) {
    const now = Date.now();
    if (st.hold && now >= st.hold) { st.hold = 0; save(); log('usage hold over: the queue resumes'); api.cap('Usage limit reset: parked sessions resume.'); }
    if (now - usageAt > USAGE_MS) {
      usageAt = now;
      const r = await api.usage(); const u = r && r.ok ? parseUsage(r.text, now) : null;
      if (u) { u.at = now; if (!st.usage || st.usage.pct !== u.pct || st.usage.kind !== u.kind) log(`usage ${u.label} ${u.pct}%${u.resetsAt ? ', resets ' + new Date(u.resetsAt).toLocaleString() : ''}`); st.usage = u; save(); }
    }
    if (st.hold) return;
    const u = st.usage, fresh = u && now - u.at < 6 * USAGE_MS;
    const limitErr = sessions.map(s => { const f = api.transcriptOf(s.sessionId), g = f && api.signals(f); return g && g.err && g.err.kind === 'rate_limit' && now - g.err.at < HOUR ? g.err : null; }).find(Boolean);
    const atLimit = fresh && (u.kind === '5h' ? u.pct >= 98 : u.pct >= (Number(S().autoWeekTarget) || 95));
    if (!(atLimit || limitErr) || S().autoParkAtLimit === false) return;
    st.hold = fresh && u.resetsAt ? u.resetsAt : now + HOUR; save();
    const until = new Date(st.hold).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    log(`usage hold until ${new Date(st.hold).toLocaleString()} (${limitErr ? 'rate limit: ' + limitErr.text.slice(0, 60) : u.label + ' ' + u.pct + '%'})`);
    note('limit', `${limitErr ? 'rate limit' : u.label + ' ' + u.pct + '%'}, held until ${until}`);
    let n = 0;
    for (const s of sessions) if (mine(s) && s.group === 'Active' && s.activity === 'working' && !api.awaiting(s.sessionId)) { const r = await api.park(s.sessionId); if (r && r.ok) n++; }
    warn('hold:' + st.hold, `Usage limit: ${n ? n + ' session' + (n > 1 ? 's' : '') + ' parked' : 'nothing new starts'} until ${until}.`);
  }

  // ---- part 3: the backlog. Tasks wait in order (first in, first out) and start one at a time while there is room under the
  // mode's cap (manage.room), pacing is not holding back, and the queue of parked sessions is empty ----
  const sameFile = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  function taskDone(s, f) {   // a backlog task's session passed the done check
    const t = st.backlog.find(x => x.state === 'started' && (x.sessionId === s.sessionId || sameFile(x.file, f)));
    if (t) { t.state = 'done'; t.doneAt = Date.now(); log(`backlog done: "${titleOf(t.text)}"`); note('task-done', titleOf(t.text), { folder: t.folder }); }
  }
  function add(o) {
    const text = String((o && o.text) || '').trim(), folder = String((o && o.folder) || '').trim();
    if (!text || text.length > 2000) return { ok: false, why: 'the task needs a text (up to 2000 characters)' };
    if (!folder || folder.length > 400) return { ok: false, why: 'the task needs a project folder' };
    const t = { id: require('crypto').randomBytes(4).toString('hex'), folder, text, nightOnly: !!o.nightOnly, at: Date.now(), state: 'waiting' };
    st.backlog.push(t); save(); log(`backlog add "${titleOf(text)}" in ${folder}${t.nightOnly ? ' (night only)' : ''}`);
    return { ok: true, task: { ...t, title: titleOf(text) } };
  }
  const find = id => st.backlog.find(t => t.id === id);
  function remove(id) { const t = find(id); if (!t) return { ok: false, why: 'no such task' }; st.backlog = st.backlog.filter(x => x !== t); save(); log(`backlog drop "${titleOf(t.text)}"`); return { ok: true }; }
  function move(id, where) {
    const t = find(id); if (!t || t.state !== 'waiting') return { ok: false, why: 'no such waiting task' };
    const w = st.backlog.filter(x => x.state === 'waiting'), i = w.indexOf(t);
    const j = where === 'first' ? 0 : where === 'last' ? w.length - 1 : where === 'up' ? Math.max(0, i - 1) : where === 'down' ? Math.min(w.length - 1, i + 1) : i;
    w.splice(i, 1); w.splice(j, 0, t);
    st.backlog = [...st.backlog.filter(x => x.state !== 'waiting'), ...w]; save();
    return { ok: true };
  }
  async function start(t, why) {
    const title = titleOf(t.text);
    if (!S().appControl) { warn('backlog:' + t.id, `Backlog task "${title}" is ready to start, but App control is off.`); return { ok: false, why: 'App control is off' }; }
    let r;
    if (DRY) { log(`dry start in ${t.folder}: ${JSON.stringify(t.text)}`); r = { ok: true, sessionId: 'dry:' + t.id }; }
    else r = await api.newSession(t.folder, MSG.task(t.text, slugOf(t.text))) || { ok: false, why: 'no answer' };
    st.lastStart = Date.now();
    if (!r.ok) { t.retryAt = Date.now() + RETRY_MS; t.fails = (t.fails || 0) + 1; save(); log(`backlog start "${title}" failed: ${r.why}`); return r; }
    Object.assign(t, { state: 'started', sessionId: r.sessionId, startedAt: Date.now(), file: (api.transcriptOf && api.transcriptOf(r.sessionId)) || null });
    delete t.retryAt; st.expect[r.sessionId] = st.expect[String(r.sessionId).replace(/^new:/, '')] = Date.now(); save();   // (the feed names it by its transcript id)
    log(`backlog start "${title}" in ${t.folder} (${why})`); note('task-start', title, { folder: t.folder });
    if (api.rename && !DRY) api.rename(r.sessionId, title).catch(() => {});
    api.cap(`Started backlog task: ${title}.`);
    return { ok: true, sessionId: r.sessionId, title };
  }
  async function startNow(id) { const t = find(id); if (!t || t.state !== 'waiting') return { ok: false, why: 'no such waiting task' }; return start(t, 'asked'); }
  async function backlogTick() {
    const now = Date.now();
    st.backlog = st.backlog.filter(t => t.state !== 'done' || now - (t.doneAt || 0) < KEEP_DONE);
    if (now - st.lastStart < START_GAP || (paceOn() && capAdj(now) < 0)) return;   // near the limit (or held), new starts wait
    const r = api.room ? api.room() : { free: 0 }; if (!r || r.free < 1) return;
    const night = r.mode === 'night' || r.mode === 'weekend';
    const t = st.backlog.find(x => x.state === 'waiting' && !(x.retryAt > now) && (x.nightOnly ? night : !night || S().queueAtNight));
    if (t) await start(t, 'room under the cap');
  }
  // the queued tiles: waiting tasks as dim pseudo-sessions in a Backlog group (the renderer opens the backlog card on them)
  const tiles = () => !backlogOn() ? [] : st.backlog.filter(t => t.state === 'waiting').map(t => ({ sessionId: 'backlog:' + t.id, backlog: t.id, title: titleOf(t.text),
    group: 'Backlog', activity: 'queued', dim: true, folder: t.folder, model: t.nightOnly ? 'night only' : 'queued' }));
  const list = () => st.backlog.map(t => ({ id: t.id, folder: t.folder, text: t.text, title: titleOf(t.text), nightOnly: !!t.nightOnly, state: t.state, at: t.at, startedAt: t.startedAt || 0, doneAt: t.doneAt || 0, retryAt: t.retryAt || 0 }));

  // ---- part 4b: away alerts and the digest ----
  const AWAY_MS = 10 * 60e3, BACK_MS = 60e3, KEEP_ALERTS = 2 * 24 * HOUR, KEEP_EV = 14 * 24 * HOUR;
  function awayTick(sessions) {
    const idle = api.idleMs ? api.idleMs() : 0, now = Date.now();
    if (idle < BACK_MS) { if (Object.keys(st.away).length) { st.away = {}; save(); } return; }   // the user is back: a later wait is a new alert
    if (idle < AWAY_MS) return;
    for (const s of sessions) {
      if (!mine(s) || !s.title || s.group === 'Parked' || s.group === 'Archived') continue;
      const why = st.stuck[s.sessionId] ? 'stuck' : api.awaiting(s.sessionId) ? 'waits on you' : null; if (!why) continue;
      const key = s.sessionId + ':' + why; if (st.away[key]) continue;
      st.away[key] = now;
      st.alerts.push({ id: require('crypto').randomBytes(4).toString('hex'), at: now, sessionId: s.sessionId, title: s.title, why });
      log(`away alert: "${s.title}" ${why}`); note('away', s.title, { why });
    }
    st.alerts = st.alerts.filter(a => now - a.at < KEEP_ALERTS).slice(-50); save();
  }
  // the digest since a time: commits per project (git log of every session folder, one per repository), and the events
  async function digest(since, sessions) {
    const now = Date.now(), ev = st.events.filter(e => e.at >= since), of = k => ev.filter(e => e.kind === k);
    const dirs = [...new Set((sessions || []).map(s => s.cwd).filter(d => d && /^([A-Za-z]:[\\/]|\\\\)/.test(d)))];
    const seen = new Set(), projects = [];
    for (const d of dirs) {
      const r = api.git && api.git.log ? await api.git.log(d, since).catch(() => null) : null;
      if (!r || !r.ok || seen.has(r.repo)) continue; seen.add(r.repo);
      if (r.subjects.length) projects.push({ name: r.name, commits: r.subjects });
    }
    const live = (sessions || []).filter(s => s.title && s.group !== 'Parked' && s.group !== 'Archived' && s.group !== 'Backlog');
    return { since, until: now, projects, swaps: of('swap').map(e => e.text), nudges: of('nudge').length, stuck: of('stuck').map(e => e.text),
      limits: of('limit').map(e => e.text), tasksStarted: of('task-start').map(e => e.text), tasksDone: of('task-done').map(e => e.text), done: of('done').map(e => e.text),
      alerts: st.alerts.filter(a => a.at >= since).map(a => ({ title: a.title, why: a.why, at: a.at })),
      waiting: live.filter(s => api.awaiting(s.sessionId)).map(s => s.title), stuckNow: live.filter(s => st.stuck[s.sessionId]).map(s => s.title) };
  }
  // the spoken short form
  function digestLine(d) {
    const n = d.projects.reduce((a, p) => a + p.commits.length, 0), pl = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`, parts = [];
    parts.push(n ? `${pl(n, 'commit')} in ${pl(d.projects.length, 'project')}` : 'no commits');
    if (d.swaps.length) parts.push(pl(d.swaps.length, 'swap'));
    if (d.tasksDone.length) parts.push(`${pl(d.tasksDone.length, 'backlog task')} done`);
    if (d.limits.length) parts.push(pl(d.limits.length, 'limit hit'));
    const w = d.waiting.length + d.stuckNow.length;
    return parts.join(', ') + '.' + (w ? ` ${pl(w, 'session')} ${w === 1 ? 'needs' : 'need'} you.` : '');
  }
  // the text form (Ask's "what happened")
  function digestText(d) {
    const L = [`Since ${new Date(d.since).toLocaleString()}: ${digestLine(d)}`];
    for (const p of d.projects) L.push(`${p.name}: ${p.commits.slice(0, 8).join('; ')}${p.commits.length > 8 ? ` (+${p.commits.length - 8} more)` : ''}`);
    if (d.swaps.length) L.push('Swapped: ' + d.swaps.join(', '));
    if (d.tasksStarted.length) L.push('Backlog started: ' + d.tasksStarted.join(', '));
    if (d.tasksDone.length) L.push('Backlog done: ' + d.tasksDone.join(', '));
    if (d.nudges || d.stuck.length) L.push(`Stalls: ${d.nudges} nudge${d.nudges === 1 ? '' : 's'}${d.stuck.length ? '; stuck: ' + d.stuck.join(', ') : ''}`);
    if (d.limits.length) L.push('Limits: ' + d.limits.join('; '));
    if (d.alerts.length) L.push('Away alerts: ' + d.alerts.map(a => `${a.title} (${a.why})`).join(', '));
    if (d.waiting.length) L.push('Waiting on you now: ' + d.waiting.join(', '));
    if (d.stuckNow.length) L.push('Stuck now: ' + d.stuckNow.join(', '));
    return L.join('\n');
  }
  // the end of Night (or Weekend) mode after at least an hour: the morning digest
  async function nightTick(sessions) {
    const r = api.room ? api.room() : null; if (!r || !r.mode) return;
    const night = r.mode === 'night' || r.mode === 'weekend', now = Date.now();
    if (night) { if (!st.nightFrom) { st.nightFrom = now; save(); } return; }
    if (!st.nightFrom) return;
    const from = st.nightFrom; st.nightFrom = 0; save();
    if (now - from < HOUR) return;
    const d = await digest(from, sessions); st.lastDigest = d; save();
    log('digest: ' + digestLine(d)); if (api.digest) api.digest({ ...d, line: digestLine(d) }); api.say('Good morning. ' + digestLine(d));
  }

  let busy = false;
  async function tick(feed) {
    if (busy || !feed || !Array.isArray(feed.sessions)) return;
    busy = true;
    try {
      if (process.env.SPHERE_AUTO_DEBUG) for (const s of feed.sessions) if (ONLY && mine(s)) log(`debug "${s.title}" id=${s.sessionId} group=${s.group} activity=${s.activity} file=${api.transcriptOf(s.sessionId) || '-'} awaiting=${api.awaiting(s.sessionId)}`);
      if (stallOn() && !api.blocked()) await stallTick(feed.sessions);
      if (doneOn() && !api.blocked()) await doneTick(feed.sessions);
      if (paceOn() && !api.blocked()) await paceTick(feed.sessions);
      if (backlogOn() && !api.blocked()) await backlogTick();
      if (digestOn()) { awayTick(feed.sessions); await nightTick(feed.sessions); }
      if (st.events.length && Date.now() - st.events[0].at > KEEP_EV) { st.events = st.events.filter(e => Date.now() - e.at < KEEP_EV); save(); }
      const live = new Set(feed.sessions.map(s => s.sessionId));   // forget sessions that have gone
      for (const k of ['nudges', 'done', 'stuck', 'expect', 'left', 'fin', 'tick']) for (const id of Object.keys(st[k])) if (!live.has(id) && Date.now() - ([].concat(st[k][id]).pop() || 0) > 7 * 24 * HOUR) delete st[k][id];
    } catch (e) { log('error: ' + (e && e.message)); }
    finally { busy = false; }
  }

  // the feed as the tiles see it: a stuck session carries stuck: true (the amber tile)
  function apply(f) {
    if (!f || !Array.isArray(f.sessions) || !(stallOn() || doneOn())) return f;
    return { ...f, sessions: f.sessions.map(s => st.stuck[s.sessionId] && stallOn() ? { ...s, stuck: true } : st.tick[s.sessionId] && doneOn() ? { ...s, doneTick: true } : s) };
  }

  return {
    tick, apply, capAdj,
    usage: () => st.usage && { ...st.usage, hold: st.hold || 0 },
    expect: (id, at) => { st.expect[String(id)] = at || Date.now(); save(); },   // Theseus asked the session to keep going (swap, resume, backlog)
    leave: id => { st.left[String(id)] = Date.now(); delete st.stuck[id]; save(); return { ok: true }; },
    unleave: id => { delete st.left[String(id)]; save(); },
    stuck: () => Object.keys(st.stuck),
    backlog: { add, remove, move, startNow, list, tiles, on: backlogOn },
    // part 4b: note('swap', title) from manage.js; the alerts list (the phone app); a digest on demand (hours back, or since the last night)
    note, alerts: () => st.alerts.slice(), digestOn,
    digest: async (sessions, hours) => { const d = await digest(hours ? Date.now() - hours * HOUR : st.lastDigest ? st.lastDigest.since : Date.now() - 12 * HOUR, sessions); return { ...d, line: digestLine(d), text: digestText(d) }; },
    lastDigest: () => st.lastDigest && { ...st.lastDigest, line: digestLine(st.lastDigest), text: digestText(st.lastDigest) },
    _stallOf: stallOf,
  };
}
module.exports = { create, MSG, parseUsage, parseReset, slugOf, titleOf };
