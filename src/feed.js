// Reads the feed file written by the Session manager, adds live context from transcripts, notifies on change.
// No feed file (none set, or gone for 2 reads): the built-in reader (sessions.js) stands in, same shape.
const fs = require('fs');
const path = require('path');
const { contextTokens, activity } = require('./transcripts');
const P = require('./paths');
const reader = () => require('./sessions').scan({ days: P.readerDays() });
const FEED = () => P.feed();   // the feed file setting (SPHERE_FEED in tests); empty = no feed
const DEFAULT_SWAP = { 'Session Manager': 250000 }; // everything else 200000

const str = (v, d = '') => typeof v === 'string' ? v : d;
const num = v => { const n = typeof v === 'string' && v.trim() ? Number(v) : v; return typeof n === 'number' && isFinite(n) ? n : null; };

// the file as parsed JSON, or why not: 'absent' (no file) / 'bad' (empty, half-written, not JSON)
function load() {
  if (!FEED()) return { raw: reader() };
  try { return { raw: JSON.parse(fs.readFileSync(FEED(), 'utf8').replace(/^\uFEFF/, '')) }; }
  catch (e) { return { err: e.code === 'ENOENT' ? 'absent' : 'bad' }; }
}

// parsed feed -> { sessions, voice, updated }; null when it is not a feed at all (null, no sessions array)
function build(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.sessions)) return null;
  const sessions = raw.sessions.filter(s => s && typeof s === 'object' && s.archived !== true && ((typeof s.sessionId === 'string' && s.sessionId) || typeof s.sessionId === 'number')).map(s => {
    const id = String(s.sessionId), group = str(s.group) || 'Ungrouped';
    const swapAt = num(s.swapAt) > 0 ? num(s.swapAt) : DEFAULT_SWAP[group] || 200000;
    let tokens = num(s.contextTokens), act = null;   // act: working / waiting / idle (null = unknown)
    // Parked sessions stay frozen at the feed value; others get live numbers when a transcript is known.
    if (group !== 'Parked' && typeof s.transcript === 'string' && s.transcript) { const t = contextTokens(s.transcript); if (t != null) tokens = t; act = activity(s.transcript); }
    const pct = tokens != null ? Math.min(1, Math.max(0, tokens / swapAt)) : Math.min(1, Math.max(0, (num(s.contextPct) || 0) / 100));
    return { sessionId: id, title: str(s.title) || '?', model: str(s.model), effort: str(s.effort), group,
             parentId: str(s.parentId) || null, folder: str(s.folder) || null, link: s.reader ? '' : str(s.link) || `claude://claude.ai/epitaxy/${id}`, tokens, swapAt, pct, activity: act,
             ...(s.reader ? { reader: true } : {}) };   // a reader session has no app link: it opens in the console only
  });
  // a swap leaves "X (old ...)" beside the fresh "X": the fresh one takes over (parentId -> same seat) and the old one goes
  const base = t => t.replace(/\s*\(old\b[^)]*\)\s*$/i, '');
  const shown = sessions.filter(s => {
    if (base(s.title) === s.title) return true;
    const next = sessions.find(x => x !== s && x.title === base(s.title));
    if (!next) return true;
    if (!next.parentId) next.parentId = s.sessionId;
    return false;
  });
  return { sessions: shown, archived: archivedOf(raw.sessions, new Set(shown.map(s => s.sessionId))), voice: str(raw.managerVoice) || null, updated: raw.updated || null };
}

// sessions archived in the Claude app (the Session manager flags them "archived": true with "archivedAt"): the last 7 days,
// newest first, at most 20, group 'Archived'. No transcript reads. Kept apart from feed.sessions so nothing else sees them.
const ARCHIVE_DAYS = 7, ARCHIVE_MAX = 20;
function archivedOf(list, taken, now = Date.now()) {
  const seen = new Set(taken);
  return list.filter(s => s && typeof s === 'object' && s.archived === true && ((typeof s.sessionId === 'string' && s.sessionId) || typeof s.sessionId === 'number'))
    .map(s => ({ s, at: Date.parse(s.archivedAt) })).filter(x => isFinite(x.at) && now - x.at <= ARCHIVE_DAYS * 864e5)
    .sort((a, b) => b.at - a.at)
    .filter(({ s }) => { const id = String(s.sessionId); if (seen.has(id)) return false; seen.add(id); return true; }).slice(0, ARCHIVE_MAX)
    .map(({ s, at }) => { const id = String(s.sessionId), tokens = num(s.contextTokens), swapAt = num(s.swapAt) > 0 ? num(s.swapAt) : 200000;
      return { sessionId: id, title: str(s.title) || '?', model: str(s.model), effort: str(s.effort), group: 'Archived', parentId: null, folder: str(s.folder) || null,
               link: str(s.link) || `claude://claude.ai/epitaxy/${id}`, tokens, swapAt, pct: tokens != null ? Math.min(1, Math.max(0, tokens / swapAt)) : Math.min(1, Math.max(0, (num(s.contextPct) || 0) / 100)), activity: null, archivedAt: at };
    });
}

function readFeed() {
  const r = load();
  return (r.raw !== undefined && build(r.raw)) || (r.err === 'absent' && build(rawNow = reader())) || { sessions: [], missing: true };
}

// onChange(feed) fires when the visible result changes; polls every 15 s plus fs.watch for instant feed edits.
// A read that fails (half-written, bad JSON) keeps the last good feed and is retried soon; {sessions: [], missing: true} comes
// only when the file is really absent for 2 reads in a row (or never was readable).
function watch(onChange) {
  let prev = '', good = false, absent = 0, bad = 0, w = null, stopped = false, tickT, armT, lastRaw = null;
  let emit = f => { const j = JSON.stringify({ ...f, updated: null }); if (j !== prev) { prev = j; onChange(f); } };   // a rewrite that only moves the time stamp is no change
  const tick = () => {
    clearTimeout(tickT);
    if (stopped) return;
    try {
      const r = load(), f = r.raw !== undefined ? build(r.raw) : null;
      if (f) { good = true; absent = bad = 0; lastRaw = r.raw; rawNow = r.raw; return emit(f); }
      if (r.err === 'absent') { absent++; bad = 0; } else { bad++; absent = 0; }
      if (absent >= 2) { const raw = reader(); lastRaw = rawNow = raw; return emit(build(raw)); }   // the feed file is gone: the reader
      if (!good && bad >= 2) emit({ sessions: [], missing: true });
      if (absent < 2 && bad < 10) tickT = setTimeout(tick, r.err === 'absent' ? 1000 : 500);
    } catch (e) { if (process.env.SPHERE_DEBUG) console.log('feed', e.message); }
  };
  let armed = '', base = '';
  const arm = () => {                  // the folder is watched (a missing file or an atomic replace is still seen); re-armed after an error or a new path
    if (w && armed !== FEED()) { try { w.close(); } catch {} w = null; }
    if (stopped || w || !FEED()) return;
    armed = FEED(); base = path.basename(armed).toLowerCase();
    try {
      w = fs.watch(path.dirname(armed), (_ev, name) => { if (!name || String(name).toLowerCase() === base) { clearTimeout(tickT); tickT = setTimeout(tick, 300); } });
      w.on('error', () => { try { w.close(); } catch {} w = null; armT = setTimeout(arm, 5000); });
    } catch { w = null; armT = setTimeout(arm, 5000); }
  };
  // every 3 s: a stat per transcript (cached reads); any session's working / waiting / idle flip re-reads the feed at once
  let lastFeed = null;
  const onEmit = emit; emit = f => { lastFeed = f; onEmit(f); };
  const actCheck = () => {
    if (stopped || !lastFeed || !lastRaw) return;
    const files = new Map(lastRaw.sessions.filter(s => s && typeof s.transcript === 'string' && s.transcript).map(s => [String(s.sessionId), s.transcript]));
    if (lastFeed.sessions.some(s => files.has(s.sessionId) && s.group !== 'Parked' && activity(files.get(s.sessionId)) !== s.activity)) tick();
  };
  tick(); arm();
  const iv = setInterval(() => { arm(); tick(); }, 15000), ia = setInterval(actCheck, 3000);
  return () => { stopped = true; clearInterval(iv); clearInterval(ia); clearTimeout(tickT); clearTimeout(armT); if (w) try { w.close(); } catch {} };
}
// sessionId -> transcript path, from the last good feed read (the built feed leaves the paths out)
let rawNow = null;
function transcriptFiles() {
  return new Map(rawNow && Array.isArray(rawNow.sessions) ? rawNow.sessions.filter(s => s && typeof s.transcript === 'string' && s.transcript && s.archived !== true).map(s => [String(s.sessionId), s.transcript]) : []);
}
// the raw sessions of the last good read while the built-in reader stands in (null when a feed file is used)
const readerSessions = () => (rawNow && rawNow.reader ? rawNow.sessions : null);
module.exports = { readFeed, watch, FEED, transcriptFiles, readerSessions };   // FEED(): the feed file now
