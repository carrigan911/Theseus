// Session Console reader: tails a session's transcript .jsonl and turns it into chat messages
// { role: 'user' | 'assistant' | 'tool', text, ts (ms), uuid } (Docs/Specs/SessionConsole_Plan.md, step 1).
// open(file, onMsgs) -> { close() }: reads the last ~256 KB (more if that holds under 30 messages), then follows appended bytes (fs.watch + a 1 s size poll).
// onMsgs(msgs, init, pending): init is true for the first batch; pending = what the session waits on (see pendingOf), sent again when it changes. A message with a uuid already sent replaces it (merged tool lines grow).
// Unknown or broken lines are skipped, never thrown.
const fs = require('fs');
const path = require('path');

const TAIL = 256 * 1024, MAX_JUMP = 1024 * 1024, MAX_TEXT = 40000, KEEP = 400;
// injected text that is not something the user typed
const SKIP_USER = /^\s*(<system-reminder>|<command-|<local-command|<task-notification|<user-prompt-submit-hook|<artifact-content|<agent-message|<project_claude_message|<wake\b|\[rule hook\])/;
const LEAD_SR = /^\s*(<system-reminder>[\s\S]*?<\/system-reminder>\s*)+/;   // reminders before the prompt in one string
// a message from another Claude session: one line naming the sender, not a bubble of yours
const PEER = /^\s*<cross-session-message\b[^>]*?\bname="([^"]*)"/;
function userText(t, ts, id) {
  const p = PEER.exec(t); if (p) return { role: 'tool', text: 'Message from ' + (p[1] || 'another session'), ts, uuid: id };
  if (/^\s*<cross-session-message\b/.test(t)) return { role: 'tool', text: 'Message from another session', ts, uuid: id };
  return null;
}
// a message's text, cut at MAX_TEXT with an ellipsis that says so
const cut = s => s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + '…' : s;
const clip = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const base = p => path.basename(String(p || '').replace(/\\/g, '/')) || '?';

// tool_use block -> { kind, text, one, many }: kind groups lines that merge; many(n) is the merged wording
function toolLine(b) {
  const i = b.input && typeof b.input === 'object' ? b.input : {}, n = String(b.name || 'tool');
  if (n === 'Edit' || n === 'MultiEdit' || n === 'NotebookEdit') return { kind: 'edit', text: 'Edited ' + base(i.file_path || i.notebook_path), many: c => `Edited ${c} files` };
  if (n === 'Write') return { kind: 'write', text: 'Wrote ' + base(i.file_path), many: c => `Wrote ${c} files` };
  if (n === 'Read') return { kind: 'read', text: 'Read ' + base(i.file_path), many: c => `Read ${c} files` };
  if (n === 'Bash' || n === 'PowerShell') return { kind: 'run', text: 'Ran: ' + clip(i.command, 60), many: c => `Ran ${c} commands` };
  if (n === 'Grep' || n === 'Glob') return { kind: 'search', text: 'Searched: ' + clip(i.pattern, 60), many: c => `Searched ${c} times` };
  if (n === 'Agent' || n === 'Task') return { kind: 'agent', text: 'Agent: ' + clip(i.description || i.subagent_type, 60), many: c => `Agent: ${c} tasks` };
  const short = n.replace(/^mcp__.*__/, '');
  return { kind: 'x:' + n, text: short, many: c => `${short} x${c}` };
}

// file edits (SessionConsole_Stage4 Q4): tool_use -> [{ file, add, del, lines: [[' ' | '-' | '+', text]] }] or null.
// An edit is its removed lines then its added ones, with up to 2 shared lines either side as context; a Write is all added.
const DIFF_MAX = 400, DLINE = 300;
function diffOf(file, a, b) {
  const A = a ? String(a).split('\n') : [], B = b ? String(b).split('\n') : [];
  let p = 0; while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let s = 0; while (s < A.length - p && s < B.length - p && A[A.length - 1 - s] === B[B.length - 1 - s]) s++;
  const lines = [], put = (k, x) => lines.push([k, x.length > DLINE ? x.slice(0, DLINE) + '…' : x]);
  A.slice(Math.max(0, p - 2), p).forEach(x => put(' ', x));
  A.slice(p, A.length - s).forEach(x => put('-', x));
  B.slice(p, B.length - s).forEach(x => put('+', x));
  A.slice(A.length - s, A.length - s + 2).forEach(x => put(' ', x));
  return { file, add: B.length - s - p, del: A.length - s - p, lines };
}
function diffsOf(b) {
  const n = String(b.name || ''), i = b.input && typeof b.input === 'object' ? b.input : {}, f = base(i.file_path || i.notebook_path);
  if (n === 'Edit') return [diffOf(f, i.old_string, i.new_string)];
  if (n === 'MultiEdit' && Array.isArray(i.edits)) return i.edits.map(e => diffOf(f, e && e.old_string, e && e.new_string));
  if (n === 'Write') return [diffOf(f, '', i.content)];
  if (n === 'NotebookEdit') return [diffOf(f, '', i.new_source)];
  return null;
}
// add an edit's diffs to a tool line: totals in its text, at most DIFF_MAX lines kept (cut: true when some were left out)
function addDiffs(msg, ds, label) {
  msg.diffs = msg.diffs || []; msg.add = (msg.add || 0); msg.del = (msg.del || 0);
  let room = DIFF_MAX - msg.diffs.reduce((n, d) => n + d.lines.length, 0);
  for (const d of ds) {
    msg.add += d.add; msg.del += d.del;
    if (room <= 0) { msg.cut = true; continue; }
    if (d.lines.length > room) { d.lines = d.lines.slice(0, room); msg.cut = true; }
    room -= d.lines.length; msg.diffs.push(d);
  }
  msg.text = `${label} +${msg.add} -${msg.del}`;
}

// state carries the merge run across batches: { last: the open tool line, side: the open "Agent working…" line }
// open: tool calls with no result yet (tool_use id -> { name, input, ts }), for the pop-up question / permission card
// tool: tool_use id -> its line, until the result comes (a failed one marks the line: err); keepSide: a subagent's own transcript
const newState = o => ({ last: null, side: null, open: new Map(), tool: new Map(), keepSide: !!(o && o.sidechain) });
const TOOLS = 40;   // tool calls kept on one merged line (stage 5: each one's output opens from it)
// your message's attachments: pasted images (read when drawn: { line, k }) and @"path" files -> [{ kind, name, line, k, path }]
const ATFILE = /@"([^"\n]{1,400})"/g;
function attsOf(content, line, text) {
  const att = [];
  if (Array.isArray(content)) content.forEach((b, k) => { if (b && b.type === 'image' && att.length < 12) att.push({ kind: 'image', name: 'image', line, k }); });
  for (const m of String(text || '').matchAll(ATFILE)) if (att.length < 12) att.push({ kind: 'file', name: base(m[1]), path: m[1] });
  return att;
}
// -> null | { kind: 'ask', id, questions } (an AskUserQuestion pop-up) | { kind: 'plan', id, plan } (ExitPlanMode: waits for plan approval)
// | { kind: 'tool', id, name, summary, since } (no result yet:
// a permission request or just a slow tool; the transcript can't tell)
function pendingOf(st) {
  let last = null; for (const [id, t] of st.open) last = { id, ...t };
  if (!last) return null;
  if (last.name === 'AskUserQuestion') {
    const qs = Array.isArray(last.input.questions) ? last.input.questions : [];
    return { kind: 'ask', id: last.id, questions: qs.map(q => ({ question: String(q && q.question || ''), header: String(q && q.header || ''), multiSelect: !!(q && q.multiSelect),
      options: (Array.isArray(q && q.options) ? q.options : []).map(o => ({ label: String(o && o.label || ''), description: String(o && o.description || '') })) })) };
  }
  if (last.name === 'ExitPlanMode') return { kind: 'plan', id: last.id, plan: String(last.input && last.input.plan || '').slice(0, 20000) };
  return { kind: 'tool', id: last.id, name: last.name.replace(/^mcp__.*__/, ''), summary: toolLine({ name: last.name, input: last.input }).text, since: last.ts };
}

// one transcript line (a string) -> messages; changed ones come back again with the same uuid
function lineMsgs(line, st) {
  line = line.trim();
  if (line.charCodeAt(0) !== 123) return [];
  let j; try { j = JSON.parse(line); } catch { return []; }
  // a message sent while the session worked: taken in mid-turn as a queued_command attachment
  if (j && j.type === 'attachment' && !j.isSidechain && j.attachment && j.attachment.type === 'queued_command' && typeof j.attachment.prompt === 'string' && j.attachment.prompt.trim()) {
    const pt = j.attachment.prompt, qts = Date.parse(j.timestamp) || 0, qid = String(j.uuid || j.timestamp), peer = userText(pt, qts, qid);
    if (!peer && SKIP_USER.test(pt)) return [];   // a task notification, a hook's text ... taken in mid-turn
    st.last = st.side = null;
    return [peer || { role: 'user', text: cut(pt.trim()), ts: qts, uuid: qid }];
  }
  if (!j || typeof j !== 'object' || (j.type !== 'user' && j.type !== 'assistant')) return [];
  const ts = Date.parse(j.timestamp) || 0, id = String(j.uuid || ts), m = j.message || {};
  if (j.isSidechain && !st.keepSide) {   // an agent's own lines: one "Agent working…" line per run
    st.last = null;
    if (st.side) return [];
    return [st.side = { role: 'tool', text: 'Agent working…', ts, uuid: id + ':side' }];
  }
  st.side = null;
  if (j.isMeta || j.isCompactSummary || j.isVisibleInTranscriptOnly) return [];
  const out = [];
  if (j.type === 'user') {
    let t = m.content;
    const again = [];   // tool lines whose call failed: sent again, now marked
    if (Array.isArray(t)) for (const b of t) if (b && b.type === 'tool_result') {
      const tid = String(b.tool_use_id), line = st.tool.get(tid); st.open.delete(tid); st.tool.delete(tid);
      if (line && b.is_error) { line.err = (line.err || 0) + 1; const x = line.tools && line.tools.find(y => y.id === tid); if (x) x.err = true; again.push(line); }
    }
    if (Array.isArray(t) && t.some(b => b && b.type === 'tool_result')) return again;   // tool results: nothing new
    // pasted pictures + text: the text; injected blocks (a system reminder before your prompt ...) left out one by one
    const said = Array.isArray(t) ? t.filter(b => b && b.type === 'text' && typeof b.text === 'string' && !SKIP_USER.test(b.text)).map(b => b.text).join('\n') : typeof t === 'string' ? t.replace(LEAD_SR, '') : t;
    const att = attsOf(t, String(j.uuid || ''), said); t = said;
    const peer = typeof t === 'string' && userText(t, ts, id); if (peer) { st.last = null; return [peer]; }
    if (typeof t !== 'string' || SKIP_USER.test(t) || (!t.trim() && !att.length)) return [];
    st.last = null; st.open.clear();   // you wrote again: nothing older is still waiting
    if (/^\[Request interrupted/.test(t)) return [{ role: 'tool', text: 'Interrupted', ts, uuid: id }];
    const msg = { role: 'user', text: cut((att.some(a => a.kind === 'file') ? t.replace(ATFILE, '') : t).trim()), ts, uuid: id };
    if (att.length) msg.att = att;   // the pictures and files show as chips
    return [msg];
  }
  const c = Array.isArray(m.content) ? m.content : typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : [];
  c.forEach((b, k) => {
    if (!b || typeof b !== 'object') return;
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
      st.last = null; out.push({ role: 'assistant', text: cut(b.text.trim()), ts, uuid: id + ':' + k });
    } else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) {
      // a turn's thinking: one "Thinking" line per run; its text is read when it is opened (refs to the transcript lines)
      const ref = { line: String(j.uuid || ''), k };
      if (st.last && st.last.kind === 'think') { if (st.last.msg.refs.length < 20) st.last.msg.refs.push(ref); out.push(st.last.msg); }
      else { const msg = { role: 'tool', think: true, text: 'Thinking', refs: [ref], ts, uuid: id + ':' + k }; st.last = { kind: 'think', n: 1, msg }; out.push(msg); }
    } else if (b.type === 'tool_use') {
      if (b.id) st.open.set(String(b.id), { name: String(b.name || 'tool'), input: b.input && typeof b.input === 'object' ? b.input : {}, ts });
      const t = toolLine(b), ds = diffsOf(b), one = { id: String(b.id || ''), text: t.text, agent: t.kind === 'agent' };
      let msg;
      if (st.last && st.last.kind === t.kind) { msg = st.last.msg; st.last.n++; msg.text = t.many(st.last.n); if (ds) addDiffs(msg, ds, msg.text); }
      else { msg = { role: 'tool', text: t.text, ts, uuid: id + ':' + k }; if (ds) addDiffs(msg, ds, t.text); st.last = { kind: t.kind, n: 1, msg }; }
      if (one.id) {   // each call's output opens from the line (stage 5)
        msg.tools = msg.tools || []; if (msg.tools.length < TOOLS) msg.tools.push(one);
        st.tool.set(one.id, msg); if (st.tool.size > 500) st.tool.delete(st.tool.keys().next().value);
      }
      out.push(msg);
    }
  });
  return out;
}

// text of whole lines -> messages (a merged tool line appears once, in its final form)
function run(lines, st) {
  const by = new Map();
  for (const l of lines) for (const m of lineMsgs(l, st)) by.set(m.uuid, { ...m });
  return [...by.values()];
}
function parse(text, o) { return run(String(text).split('\n'), newState(o)); }

function open(file, onMsgs) {
  const st = newState();
  let pos = 0, carry = Buffer.alloc(0), watcher = null, timer = null, closed = false, busy = false, again = false, sent = false, pkey = 'none';
  const emit = msgs => {
    if (closed) return;
    const p = pendingOf(st), k = p ? p.id : 'none', moved = k !== pkey; pkey = k;
    if (!msgs.length && sent && !moved) return;
    const init = !sent; sent = true; try { onMsgs(msgs, init, p); } catch {}
  };

  // bytes [from, size) -> complete lines; the unfinished last line waits in carry (bytes, so a split UTF-8 character is safe)
  const feedBytes = (buf, dropFirst) => {
    let b = carry.length ? Buffer.concat([carry, buf]) : buf;
    const cut = b.lastIndexOf(10);
    carry = cut < 0 ? b : Buffer.from(b.subarray(cut + 1));
    if (cut < 0) return [];
    let body = b.subarray(0, cut);
    if (dropFirst) { const nl = body.indexOf(10); body = nl < 0 ? Buffer.alloc(0) : body.subarray(nl + 1); }   // the window starts mid-line
    return body.toString('utf8').split('\n');
  };
  const readFrom = (start, size) => {
    const fd = fs.openSync(file, 'r');
    try { const b = Buffer.alloc(size - start); const n = fs.readSync(fd, b, 0, b.length, start); return n < b.length ? b.subarray(0, n) : b; }
    finally { fs.closeSync(fd); }
  };
  // the last ~256 KB; a session with big tool results has few messages per KB, so the window grows (1 MB, 4 MB) until it holds 30
  const initial = () => {
    const size = fs.statSync(file).size;
    let msgs;
    for (const w of [TAIL, 4 * TAIL, 16 * TAIL]) {
      const start = Math.max(0, size - w);
      carry = Buffer.alloc(0); st.last = st.side = null; st.open.clear(); st.tool.clear();
      msgs = run(feedBytes(readFrom(start, size), start > 0), st);
      if (start === 0 || msgs.length >= 30) break;
    }
    pos = size;
    emit(msgs.slice(-KEEP));
  };
  // a burst bigger than MAX_JUMP: only its last TAIL is read, after a gap line. What waited before it (a question, a permission)
  // still waits unless its result is among the skipped bytes (searched as raw bytes, 1 MB at a time, up to 64 MB; past that
  // it is let go, the next lines tell)
  const jump = size => {
    const start = size - TAIL, ids = [...st.open.keys()];
    if (ids.length) {
      if (start - pos > 64 << 20) st.open.clear();
      else {
        const fd = fs.openSync(file, 'r'), b = Buffer.alloc((1 << 20) + 200);
        try {
          for (let at = pos; at < start && ids.length; at += 1 << 20) {
            const n = fs.readSync(fd, b, 0, Math.min(b.length, start - at), at), s = b.subarray(0, n);
            for (let i = ids.length - 1; i >= 0; i--) if (s.includes(`"tool_use_id":"${ids[i]}"`)) { st.open.delete(ids[i]); ids.splice(i, 1); }
          }
        } finally { fs.closeSync(fd); }
      }
    }
    carry = Buffer.alloc(0); st.last = st.side = null;
    const msgs = run(feedBytes(readFrom(start, size), true), st), mb = Math.max(1, Math.round((start - pos) / (1 << 20)));
    pos = size;
    const gap = { role: 'tool', gap: true, text: `Earlier messages skipped (about ${mb} MB written at once)`, ts: msgs.length ? msgs[0].ts : Date.now(), uuid: 'gap:' + start };
    emit([gap, ...msgs.slice(-KEEP)]);
  };
  const poll = () => {
    if (closed) return;
    if (busy) { again = true; return; }
    busy = true;
    try {
      const size = fs.statSync(file).size;
      if (size < pos) initial();   // truncated / rewritten: start over
      else if (size - pos > MAX_JUMP) jump(size);
      else if (size > pos) { const buf = readFrom(pos, size); pos = size; emit(run(feedBytes(buf, false), st)); }
    } catch {}   // file gone or busy: try again at the next tick
    busy = false;
    if (again) { again = false; setTimeout(poll, 50); }
  };

  try { initial(); } catch { emit([]); }
  try { watcher = fs.watch(file, () => poll()); watcher.on('error', () => { try { watcher.close(); } catch {} watcher = null; }); } catch {}
  timer = setInterval(poll, 1000);   // fs.watch can miss appends on Windows (coalesced / dropped events); one stat a second is cheap
  return { close() { closed = true; clearInterval(timer); if (watcher) try { watcher.close(); } catch {} watcher = null; } };
}

// whole text -> what it waits on (tests)
function pending(text) { const st = newState(); run(String(text).split('\n'), st); return pendingOf(st); }
module.exports = { open, parse, pending };
