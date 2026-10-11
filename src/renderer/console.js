// Session Console view (Docs/Specs/SessionConsole_Plan.md, step 2): one session's conversation in the wide card.
// Title bar, a scrolling list (last 20 messages, 20 more each time you scroll to the top, from what the reader holds), a reply box
// (Enter sends, Shift+Enter is a new line, Esc closes) with Send / Stop, and the reason a send or stop failed under the box.
// Stage 2 (plan steps 8-9): a pending pop-up question or permission request shows as a card above the reply box (answers go back
// through consoleAnswer / consolePermit), and "New session" swaps the conversation for a small form (folder, model, first message).
// The transcript reader lives in main (transcript.js); batches arrive as 'console-msg'. Nothing runs while the view is closed
// (the one timer is the permission card's, set only while a tool call is pending).
// host: { needKeys() (the window takes keyboard focus), close() (leave the card), openClaude(session) (today's overlay path) }
import { dropMenu, closeMenus, menuOpen, MODES } from './chips.js';
import { md } from './md.js';
const PAGE = 20, HOLD = 600, DRAWN = 150, WAIT = 6000;   // DRAWN: rows kept drawn while you follow the end (older ones come back as you scroll up); WAIT: a tool call this old (ms) with no result gets the permission card
const MODELS = ['Opus 5.5', 'Fable 5.1', 'Sonnet 5.5', 'Haiku 5.5'];
// the "/" list: names come from the app (main.js commandsOf); the app shows only the highlighted one's description, so ours live here
const CMD_DESC = { 'add-dir': 'Add a working folder', btw: 'Ask a side question without interrupting', cd: 'Change the working folder', compact: 'Compact the conversation',
  diff: 'Show the changes', effort: 'Set the effort level', fast: 'Turn fast mode on or off', feedback: 'Send feedback', fork: 'Fork this session',
  mcp: 'Manage MCP servers', model: 'Switch the model', 'output-style': 'Set the output style', permissions: 'Manage permissions', plan: 'Plan mode',
  plugin: 'Manage plugins', rename: 'Rename this session', rewind: 'Rewind the conversation', schedule: 'Create a routine (on demand or on an interval)',
  skills: 'List skills', status: 'Session status', tasks: 'Background tasks', ultrareview: 'Multi-agent cloud review (billed)', usage: 'Plan usage',
  'usage-credits': 'Usage credits', workflows: 'Workflows' };
const el = (tag, cls, text) => { const d = document.createElement(tag); if (cls) d.className = cls; if (text != null) d.textContent = text; return d; };

export function createConsole(host) {
  const root = document.createElement('div'); root.id = 'con';
  root.innerHTML = `<div class="ch"><span class="ct"></span><input class="cti" maxlength="200" spellcheck="false" aria-label="Session name"><button class="cb cmo" data-a="mode" title="Permission mode of this session (changes it in Claude)">…</button><div class="ctabs" role="tablist"><button data-tab="chat" class="on">Chat</button><button data-tab="changes">Changes</button><button data-tab="files">Files</button><button data-tab="pr">PR</button><button data-tab="tasks">Tasks</button><button data-tab="artifacts">Artifacts</button></div><button class="cb" data-a="term" title="Open a terminal in this session’s folder">Terminal</button><button class="cb" data-a="prev" title="Open the session’s local app in your browser">Preview ▾</button><button class="cb" data-a="new" title="Start a new session in Claude">New session</button><button class="cb" data-a="claude" title="Show this session in the Claude window (Shift+click on the tile does the same)">Open in Claude</button><button class="cb cx" data-a="more" title="Rename, fork, archive or delete this session">⋯</button><button class="cb cx" data-a="close" title="Close (Esc)">✕</button></div>
    <div class="cdel"><span class="cdt"></span><button class="cb cs" data-a="delyes">Yes, delete</button><button class="cb" data-a="delno">No</button></div>
    <div class="cl"></div>
    <div class="cpane"></div>
    <div class="cq"></div>
    <div class="cn"><div class="nh">New session</div>
      <label>Folder<select class="nf"></select></label>
      <label>Model<select class="nm">${MODELS.map(m => `<option>${m}</option>`).join('')}</select></label>
      <label class="nwt"><input type="checkbox" class="nwk"> In a new worktree <span>(the Claude app makes a worktree of the folder's git repository)</span></label>
      <label>First message<textarea class="nt" rows="5" placeholder="What should it work on?  (Enter starts, Shift+Enter is a new line)" spellcheck="false"></textarea></label>
      <div class="nr"><button class="cb cs" data-a="start">Start</button><button class="cb" data-a="cancel" title="Back to the conversation (Esc)">Cancel</button><span class="nmsg"></span></div></div>
    <div class="ca"></div>
    <div class="cf"><div class="cpop" role="listbox" aria-label="Suggestions"></div><textarea rows="1" placeholder="Reply to this session…  (Enter sends, Shift+Enter is a new line; paste or drop files to attach)" spellcheck="false"></textarea><button class="cb cs" data-a="send">Send</button><button class="cb cp" data-a="stop" title="Interrupt the session">Stop</button></div>
    <div class="cnoapp">Read only. To reply, answer, and start or rename sessions from here, turn on <b>App control</b> in General settings.</div>
    <div class="cw"></div>`;
  document.body.appendChild(root);
  const q = s => root.querySelector(s), list = q('.cl'), ta = q('.cf textarea'), why = q('.cw'), title = q('.ct'), cq = q('.cq'), nf = q('.nf'), nm = q('.nm'), nt = q('.nt'), nwk = q('.nwk'), nmsg = q('.nmsg'), startB = q('[data-a=start]');
  let cur = null, held = [], at = new Map(), from = 0, key = '';   // held: messages; at: uuid -> index; from: first one drawn

  // Claude's text as Markdown (md.js escapes first). A tool line opens what it did (stage 4 Q4, stage 5 behaviour 1-3): an edit
  // its red / green diff, a command its output (first 80 lines, then Show all), an agent its own steps, a Thinking line the
  // thinking. Details are read from the transcript only when opened, and kept (det) while the console runs; failures are not kept.
  // At most 300 kept and about 50 MB of text and image data in all (the oldest go first; a re-read one moves to the end).
  const det = new Map(), detSize = new Map(), DET_MAX = 50 << 20; let detBytes = 0;
  const detDrop = k => { det.delete(k); detBytes -= detSize.get(k) || 0; detSize.delete(k); };
  function getDet(kind, a, b) {
    const s = cur, k = s.sessionId + '|' + kind + '|' + JSON.stringify(a) + '|' + (b === undefined ? '' : b);
    if (det.has(k)) { const p = det.get(k); det.delete(k); det.set(k, p); return p; }
    const p = window.sphere.consoleDetail(s.sessionId, kind, a, b).catch(e => ({ ok: false, why: e.message })).then(r => {
      if (det.get(k) !== p) return r;   // dropped meanwhile
      if (!r || !r.ok) { detDrop(k); return r; }
      const n = (r.data ? r.data.length : 0) + (r.text ? r.text.length * 2 : 0) + (r.lines ? JSON.stringify(r.lines).length : 0) + (r.msgs ? JSON.stringify(r.msgs).length : 0);
      detSize.set(k, n); detBytes += n;
      for (const o of det.keys()) { if (detBytes <= DET_MAX || o === k) break; detDrop(o); }
      return r;
    });
    det.set(k, p);
    if (det.size > 300) detDrop(det.keys().next().value);
    return p;
  }
  const opens = m => m.role === 'tool' && !!((m.diffs && m.diffs.length) || (m.tools && m.tools.length) || (m.think && m.refs));
  const fill = (d, m) => {
    d._m = m;
    if (m.role === 'assistant') { d.innerHTML = md(m.text); return; }
    d.textContent = m.text;
    if (m.role === 'user' && m.att) d.append(attRow(m));
    if (m.role === 'user' && m.text) { const b = el('button', 'uact', '⋯'); b.title = 'Copy, edit, fork or rewind from this message'; b.setAttribute('aria-label', 'Message actions'); d.append(b); }
    if (!opens(m)) return;
    d.classList.add('dl'); d.classList.toggle('er', !!m.err);
    d.append(el('span', 'dla', d._open ? ' ▾' : ' ▸'));
    if (d._open) d.append(m.diffs && m.diffs.length ? diffBox(m) : detBox(m));   // the box sits inside the line, so the list keeps one element per message
  };
  function detBox(m) {
    const box = el('div', 'df');
    if (m.think) {
      const t = el('div', 'dft', 'Reading…'); box.append(t);
      getDet('thinking', m.refs).then(r => { t.textContent = r && r.ok ? r.text : 'Not found: ' + ((r && r.why) || 'no answer'); });
      return box;
    }
    for (const t of m.tools.slice(0, 12)) {
      if (m.tools.length > 1) box.append(el('div', 'dfh' + (t.err ? ' bad' : ''), t.text));
      const body = el('div', 'dfo', 'Reading…'); box.append(body);
      if (t.agent) getDet('agent', t.id).then(r => agentInto(body, r)); else outInto(body, t.id, false);
    }
    if (m.tools.length > 12) box.append(el('div', 'dfh', `${m.tools.length - 12} more calls not shown.`));
    return box;
  }
  function outInto(body, id, all) {
    getDet('output', id, all).then(r => {
      body.replaceChildren();
      if (!r || !r.ok) { body.textContent = r && r.why === 'no result yet' ? 'Still running…' : 'No output: ' + ((r && r.why) || 'no answer'); return; }
      body.append(el('pre', 'dfb' + (r.err ? ' bad' : ''), r.lines.join('\n').trim() || '(no output)'));
      if (r.more) { const b = el('button', 'cb dfm', 'Show all'); b.onclick = e => { e.stopPropagation(); body.textContent = 'Reading…'; outInto(body, id, true); }; body.append(b); }
    });
  }
  function agentInto(body, r) {
    body.replaceChildren();
    if (!r || !r.ok) { body.textContent = 'No steps: ' + ((r && r.why) || 'no answer'); return; }
    if (!r.msgs.length) body.textContent = '(no steps yet)';
    for (const x of r.msgs) {
      if (x.role === 'assistant') { const a = el('div', 'dfa'); a.innerHTML = md(x.text); body.append(a); } else body.append(el('div', 'dfs', x.text));
    }
  }
  // your message's attachments as chips: a pasted image as a thumbnail (a click shows it large), a file by name
  function attRow(m) {
    const row = el('div', 'uat');
    for (const a of m.att) {
      const c = el('span', 'uac' + (a.kind === 'image' ? ' img' : '')); c.title = a.path || a.name;
      if (a.kind === 'image') {
        const im = el('img'); c.append(im);
        getDet('image', a.line, a.k).then(r => { if (r && r.ok) im.src = `data:${r.mime};base64,${r.data}`; else c.append(el('span', 'can', 'image')); });
        c.onclick = e => { e.stopPropagation(); if (im.src) big(im.src); };
      } else c.append(el('span', 'can', '📄 ' + a.name));
      row.append(c);
    }
    return row;
  }
  const lb = el('div', 'clb'); lb.append(el('img')); lb.onclick = () => lb.classList.remove('on'); root.append(lb);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && lb.classList.contains('on')) { e.preventDefault(); e.stopPropagation(); lb.classList.remove('on'); } }, true);
  function big(src) { lb.firstChild.src = src; lb.classList.add('on'); }
  function diffBox(m) {
    const box = el('div', 'df');
    for (const f of m.diffs) {
      box.append(el('div', 'dfh', `${f.file}  +${f.add} -${f.del}`));
      const pre = el('pre', 'dfb');
      for (const [k, x] of f.lines) pre.append(el('span', k === '+' ? 'da' : k === '-' ? 'dd' : 'dc', (k === ' ' ? '  ' : k + ' ') + x + '\n'));
      box.append(pre);
    }
    if (m.cut) box.append(el('div', 'dfh', 'More changes than shown (first 400 lines).'));
    return box;
  }
  // stage 5 step 5: your message's ⋯ -> Copy (here), Edit (rewind, its text back in the reply box), Fork from here, Rewind to here.
  // Rewind and Edit ask first; after one the messages from that one on leave the list (dropped), with Undo until the next send
  let dropped = new Set(), rwNote = null;
  function msgMenu(b, m) {
    const back = held.filter((x, i) => i > at.get(m.uuid) && x.role === 'user' && x.text === m.text).length;   // identical newer ones
    dropMenu(b, [{ label: 'Copy' }, ...(appOn ? [{ label: 'Edit', sub: 'rewind, text back here' }, { label: 'Fork from here' }, { label: 'Rewind to here' }] : [])], it => {
      if (it.label === 'Copy') { navigator.clipboard.writeText(m.text).then(() => { why.textContent = 'Copied.'; }, () => { why.textContent = 'Copy failed.'; }); return; }
      if (it.label === 'Fork from here') return act('Fork', s => window.sphere.consoleMsgAct(s.sessionId, 'fork', m.text, back), r => { why.textContent = `Forked: "${r.title || 'the fork'}" is in Claude, with this message in its reply box.`; });
      const edit = it.label === 'Edit', n = preview(m.uuid);
      askYes(`${edit ? 'Edit' : 'Rewind to'} this message? This removes ${n} message${n === 1 ? '' : 's'} (yours and Claude's, greyed out); Undo is offered until you send again.`, edit ? 'Yes, edit' : 'Yes, rewind', () =>
        act(edit ? 'Edit' : 'Rewind', s => window.sphere.consoleMsgAct(s.sessionId, 'rewind', m.text, back), r => { cutFrom(m.uuid); if (edit) { ta.value = r.draft || m.text; grow(); ta.focus(); draftSoon(); } }));
    });
  }
  // the rewind preview (new ideas 2): the rows that would leave turn grey while the question shows -> how many messages go
  function preview(uuid) {
    const i = at.get(uuid); if (i == null) return 0;
    for (const d of list.children) if (d._m && at.get(d._m.uuid) >= i) d.classList.add('rwp');
    return held.slice(i).filter(x => x.role === 'user' || x.role === 'assistant').length;
  }
  const unpreview = () => { for (const d of list.querySelectorAll('.rwp')) d.classList.remove('rwp'); };
  function cutFrom(uuid) {
    const i = at.get(uuid); if (i == null) return;
    for (const x of held.slice(i)) dropped.add(x.uuid);
    held = held.slice(0, i); reindex(); draw();
    rwNote = el('div', 'rwn'); rwNote.append(el('span', '', 'Rewound here. Your next message continues from this point. '), Object.assign(el('button', 'cb', 'Undo'), { onclick: undoRewind }));
    list.append(rwNote); list.scrollTop = list.scrollHeight;
  }
  function undoRewind() {
    act('Undo', s => window.sphere.consoleMsgAct(s.sessionId, 'undo'), (r, s) => { dropped = new Set(); rwNote = null; open(s); });
  }
  list.addEventListener('click', e => {
    const ub = e.target.closest('.uact'); if (ub) { e.stopPropagation(); const d = ub.closest('.m'); if (d && d._m && cur && !acting) msgMenu(ub, d._m); return; }
    const a = e.target.closest('a[data-href]'); if (a) { e.preventDefault(); window.sphere.openUrl(a.dataset.href); return; }
    const t = e.target.closest('.m.dl'); if (!t || !t._m || e.target.closest('.df')) return;
    t._open = !t._open; fill(t, t._m);
  });
  const mk = m => { const d = document.createElement('div'); d.className = 'm ' + m.role; fill(d, m); if (m.ts) d.title = new Date(m.ts).toLocaleString(); return d; };
  const near = () => list.scrollHeight - list.scrollTop - list.clientHeight < 90;
  const bottom = () => { list.scrollTop = list.scrollHeight; };
  function draw() {
    from = Math.max(0, held.length - PAGE);
    list.replaceChildren(...held.slice(from).map(mk));
    if (!held.length) { const e = document.createElement('div'); e.className = 'empty'; e.textContent = 'No messages yet'; list.append(e); }
    for (let g = 6; g-- && from > 0 && list.scrollHeight <= list.clientHeight + 1;) { const n = Math.min(PAGE, from); from -= n; list.prepend(...held.slice(from, from + n).map(mk)); }   // 20 do not fill the card: more, so it can scroll
    bottom();
  }
  function reindex() { at = new Map(held.map((m, i) => [m.uuid, i])); }
  // a search hit (stage 5 step 6): drawn, scrolled to the middle and marked for a moment. One older than what the console
  // holds is read from the transcript (the messages around it) and put before the rest, with a "later messages" line between
  let goAt = null;   // { uuid, off } until the first messages arrive
  function showAt(uuid) {
    const i = at.get(uuid); if (i == null) return false;
    if (i < from) { list.prepend(...held.slice(i, from).map(mk)); from = i; }
    const d = [...list.children].find(c => c._m && c._m.uuid === uuid); if (!d) return false;
    d.scrollIntoView({ block: 'center' }); d.classList.add('hit'); setTimeout(() => d.classList.remove('hit'), 2500);
    return true;
  }
  async function jump(s, g) {
    if (showAt(g.uuid)) return;
    const r = await window.sphere.consoleAround(s.sessionId, g.off).catch(() => null);
    if (cur !== s) return;
    if (!r || !r.ok || !Array.isArray(r.msgs) || !r.msgs.some(m => m.uuid === g.uuid)) { why.textContent = 'That message is no longer in this conversation.'; return; }
    if (showAt(g.uuid)) return;   // arrived meanwhile
    const old = r.msgs.filter(m => !at.has(m.uuid)), joined = old.length < r.msgs.length;
    const gap = held.length && !joined ? [{ role: 'tool', text: '⋯ later messages ⋯', ts: 0, uuid: 'gap:' + g.uuid }] : [];
    held = [...old, ...gap, ...held]; reindex(); draw(); showAt(g.uuid);
  }
  function add(msgs, init) {
    if (init) { dropped = new Set(); rwNote = null; held = msgs.slice(-HOLD); reindex(); draw(); if (goAt) { const g = goAt; goAt = null; jump(cur, g); } return; }
    if (dropped.size) msgs = msgs.filter(m => !dropped.has(m.uuid));   // a rewound message's line growing in the old transcript
    if (!msgs.length) return;
    if (rwNote) { rwNote.remove(); rwNote = null; }
    const stick = near(); let grew = false;
    for (const m of msgs) {
      const i = at.get(m.uuid);
      if (i != null) { held[i] = m; if (i >= from) { const d = [...list.children].find(c => c._m && c._m.uuid === m.uuid); if (d) fill(d, m); } continue; }   // a merged tool line grew
      if (!held.length) list.replaceChildren();
      held.push(m); at.set(m.uuid, held.length - 1); list.append(mk(m)); grew = true;
    }
    if (held.length > HOLD) { const cut = held.length - HOLD; held = held.slice(cut); from = Math.max(0, from - cut); reindex();
      // drawn lines no longer held go from the top; a note line (not a message) goes with the lines around it, never counts as one
      const keep = new Set(held.slice(from).map(m => m.uuid));
      while (list.firstChild && !(list.firstChild._m && keep.has(list.firstChild._m.uuid))) list.firstChild.remove(); }
    // following the end: the oldest drawn rows go once more than DRAWN are drawn (scrolling up draws them again)
    if (grew && stick && held.length - from > DRAWN + PAGE) { from = held.length - DRAWN;
      const keep = new Set(held.slice(from).map(m => m.uuid));
      while (list.firstChild && !(list.firstChild._m && keep.has(list.firstChild._m.uuid))) list.firstChild.remove(); }
    if (grew && stick) bottom();
  }
  window.sphere.onConsoleMsg?.(b => { if (cur && b && b.sessionId === cur.sessionId && Array.isArray(b.msgs)) { add(b.msgs, !!b.init); if (b.pending !== undefined) setPending(b.pending); } });   // pending undefined = unchanged

  // scrolled to the top: show 20 more of what is held, keeping the view where it is
  list.addEventListener('scroll', () => {
    if (list.scrollTop > 50 || from <= 0) return;
    const n = Math.min(PAGE, from), h = list.scrollHeight, t = list.scrollTop;
    from -= n; list.prepend(...held.slice(from, from + n).map(mk));
    list.scrollTop = t + list.scrollHeight - h;
  });

  // pending: null, { kind: 'ask', id, questions }, { kind: 'plan', id, plan } or { kind: 'tool', id, name, summary, since }; drawn once per id (typed text survives batches)
  let pend = null, pk = '', pt = 0, st = [], busy = false, aw = null;   // aw: the app's sidebar says the session asks (true), runs a slow tool (false), or unknown (null)   // pk: key of the drawn card, pt: permission-card timer, st: per-question { pick (Set of option indexes), other }
  const qs = () => (pend && pend.kind === 'ask' ? pend.questions : []);
  function setPending(p) {
    const k = p && (p.kind === 'ask' || p.kind === 'plan' || p.kind === 'tool') ? p.kind + ':' + p.id : '';
    if (k === pk) return;
    if (pk.startsWith('plan:')) closeMenus();   // its More… menu goes with the card
    const stick = near(); clearTimeout(pt); pt = 0; pk = k; busy = false; pend = k ? p : null; cq.replaceChildren(); cq.style.display = 'none';
    if (k && p.kind === 'ask') drawAsk(p);
    else if (k && p.kind === 'plan') drawPlan(p);
    else if (k) schedTool();
    if (stick) bottom();
  }
  // the permission card: at once when the app shows 'Awaiting input', never while it shows 'Running', else after WAIT
  function schedTool() {
    const p = pend, k = pk; if (!p || p.kind !== 'tool') return;
    clearTimeout(pt); pt = 0;
    const shown = !!cq.querySelector('.qp'), want = aw === true ? 0 : aw === false ? -1 : Math.max(0, (+p.since || 0) + WAIT - Date.now());
    if (want < 0) { if (shown && !busy) { cq.replaceChildren(); cq.style.display = 'none'; } return; }
    if (shown) { if (!busy) { cq.replaceChildren(); drawTool(p); } return; }   // redrawn: the wording follows aw
    const draw = () => { pt = 0; if (pk !== k) return; const s = near(); drawTool(p); if (s) bottom(); };
    if (want === 0) draw(); else pt = setTimeout(draw, want);
  }
  window.sphere.onConsoleAwait?.(b => { if (cur && b && b.sessionId === cur.sessionId && aw !== b.awaiting) { aw = b.awaiting === true || b.awaiting === false ? b.awaiting : null; schedTool(); } });
  function drawAsk(p) {
    const ql = Array.isArray(p.questions) ? p.questions.filter(x => x && typeof x.question === 'string') : []; p.questions = ql;
    if (!ql.length) { pk = ''; pend = null; return; }
    st = ql.map(() => ({ pick: new Set(), other: '' }));
    const card = el('div', 'qc');
    ql.forEach((x, i) => {
      const b = el('div', 'qq'); b.dataset.i = i;
      if (x.header) b.append(el('div', 'qh', x.header));
      b.append(el('div', 'qt', x.question));
      const o = el('div', 'qo'); x.options = (Array.isArray(x.options) ? x.options : []).filter(op => op && typeof op.label === 'string');
      x.options.forEach((op, j) => {
        const bt = el('button', 'qb'); bt.type = 'button'; bt.dataset.j = j; bt.setAttribute('aria-pressed', 'false');
        bt.append(el('b', '', op.label)); if (op.description) { bt.append(el('small', '', op.description)); bt.title = op.description; }
        o.append(bt);
      });
      const ot = el('input', 'qother'); ot.type = 'text'; ot.placeholder = 'Other…'; ot.spellcheck = false; ot.setAttribute('aria-label', 'Other answer'); o.append(ot);
      b.append(o); card.append(b);
    });
    const f = el('div', 'qf'), sb = el('button', 'cb cs qsub', 'Submit'); sb.type = 'button'; sb.dataset.a = 'submit'; sb.disabled = true;
    f.append(sb, el('span', 'qs')); card.append(f); cq.append(card); cq.style.display = 'block';
  }
  function drawTool(p) {
    const card = el('div', 'qc qp'), t = el('div', 'qt'); t.append(aw === true ? 'Asking for permission: ' : 'Waiting for permission? ', el('b', '', String(p.name || 'A tool')), p.summary ? ': ' + String(p.summary).replace(/^Ran: /, '') : '');
    const f = el('div', 'qf');
    for (const c of ['Allow once', 'Always allow', 'Deny']) { const b = el('button', 'cb qpb' + (c === 'Deny' ? ' qd' : ''), c); b.type = 'button'; b.dataset.a = 'permit'; b.dataset.c = c; f.append(b); }
    f.append(el('span', 'qs'));
    const n = el('div', 'qn', 'A slow tool looks the same, so press these only if Claude is asking for permission.'); if (aw === true) n.style.display = 'none';
    card.append(t, f, n); cq.append(card); cq.style.display = 'block';
  }
  // plan approval: the plan text (Markdown), then Accept / Accept + auto mode / More… (allow edits, bypass) / Revise (feedback box) / Reject
  function drawPlan(p) {
    const card = el('div', 'qc qpn'), pl = el('div', 'qpl'); pl.innerHTML = md(String(p.plan || '(no plan text)'));
    card.append(el('div', 'qt', 'Claude proposed a plan'), pl);
    const f = el('div', 'qf qpf');
    for (const [c, t] of [['accept', 'Accept'], ['auto', 'Accept + auto mode'], ['more', 'More…'], ['revise', 'Revise…'], ['reject', 'Reject']]) {
      const b = el('button', 'cb qpb' + (c === 'accept' ? ' cs' : c === 'reject' ? ' qd' : ''), t); b.type = 'button'; b.dataset.a = c === 'revise' ? 'revopen' : c === 'more' ? 'planmore' : 'plan'; b.dataset.c = c; f.append(b);
    }
    f.append(el('span', 'qs'));
    const rv = el('div', 'qrv'), rt = el('textarea', 'qrt'); rt.rows = 3; rt.placeholder = 'What should change?'; rt.spellcheck = false; rt.setAttribute('aria-label', 'Plan feedback');
    const rf = el('div', 'qf'), bk = el('button', 'cb qpb', 'Back'), go = el('button', 'cb cs qpb', 'Send'); bk.type = go.type = 'button'; bk.dataset.a = 'revback'; go.dataset.a = 'plan'; go.dataset.c = 'revise';
    rf.append(go, bk, el('span', 'qs')); rv.append(rt, rf); rv.style.display = 'none';
    card.append(f, rv); cq.append(card); cq.style.display = 'block';
  }
  function revise(on) {
    const f = cq.querySelector('.qpf'), rv = cq.querySelector('.qrv'); if (!f || !rv || busy) return;
    f.style.display = on ? 'none' : ''; rv.style.display = on ? '' : 'none';
    if (on) cq.querySelector('.qrt').focus();
  }
  async function plan(c) {
    const s = cur, key = pk, bs = cq.querySelectorAll('.qpb'); if (!s || busy) return;
    const rv = c === 'revise', sub = cq.querySelector(rv ? '.qrv .qs' : '.qpf .qs'), text = rv ? cq.querySelector('.qrt').value.trim() : '';
    if (rv && !text) { sub.textContent = 'Say what should change.'; return; }
    busy = true; bs.forEach(b => { b.disabled = true; }); sub.textContent = 'Sending…';
    const r = await window.sphere.consolePlan(s.sessionId, c, text).catch(() => null);
    if (cur !== s || pk !== key) return;
    busy = false; bs.forEach(b => { b.disabled = false; });
    sub.textContent = r && r.ok ? 'Sent. Waiting for the session…' : 'Not sent: ' + ((r && r.why) || 'no answer');
  }
  const qdone = i => st[i].pick.size > 0 || st[i].other.trim() !== '';
  function syncAsk() {
    cq.querySelectorAll('.qq').forEach(b => { const i = +b.dataset.i; b.querySelectorAll('.qb').forEach(bt => { const on = st[i].pick.has(+bt.dataset.j); bt.classList.toggle('on', on); bt.setAttribute('aria-pressed', on); }); });
    const sb = cq.querySelector('.qsub'), ql = qs(); if (sb) sb.disabled = busy || !ql.length || !ql.every((_, i) => qdone(i));
  }
  function pickOpt(i, j) {
    const x = qs()[i], s = st[i]; if (!x || !s) return;
    if (x.multiSelect) { if (!s.pick.delete(j)) s.pick.add(j); }
    else { s.pick = new Set([j]); s.other = ''; const ot = cq.querySelector(`.qq[data-i="${i}"] .qother`); if (ot) ot.value = ''; }
    cq.querySelector('.qs').textContent = ''; syncAsk();
  }
  function typeOther(i, v) {
    const x = qs()[i], s = st[i]; if (!x || !s) return;
    s.other = v; if (!x.multiSelect && v.trim()) s.pick = new Set();   // single choice: Other replaces the pick
    syncAsk();
  }
  async function submit() {
    const s = cur, ql = qs(), key = pk; if (!s || busy || !ql.length || !ql.every((_, i) => qdone(i))) return;
    const sub = cq.querySelector('.qs');
    busy = true; sub.textContent = 'Answering…'; syncAsk();
    const answers = ql.map((x, i) => ({ picks: [...st[i].pick].sort((a, b) => a - b).map(j => x.options[j].label), other: st[i].other.trim() }));
    const r = await window.sphere.consoleAnswer(s.sessionId, answers).catch(() => null);
    if (cur !== s || pk !== key) return;
    busy = false; sub.textContent = r && r.ok ? 'Answered. Waiting for the session…' : 'Not answered: ' + ((r && r.why) || 'no answer'); syncAsk();
  }
  async function permit(c) {
    const s = cur, key = pk, sub = cq.querySelector('.qs'), bs = cq.querySelectorAll('.qpb'); if (!s || busy) return;
    busy = true; bs.forEach(b => { b.disabled = true; }); sub.textContent = 'Sending…';
    const r = await window.sphere.consolePermit(s.sessionId, c, pend && pend.kind === 'tool' ? pend.id : undefined).catch(() => null);
    if (cur !== s || pk !== key) return;
    busy = false; bs.forEach(b => { b.disabled = false; });
    sub.textContent = r && r.ok ? 'Sent. Waiting for the session…' : 'Not sent: ' + ((r && r.why) || 'no answer');
  }
  // a press anywhere but a menu or the button that opened it closes the open menu
  document.addEventListener('pointerdown', e => { if (menuOpen() && !e.target.closest('.cmenu, [data-a=mode], [data-a=more], [data-a=planmore]')) closeMenus(); }, true);
  cq.addEventListener('click', e => {
    const lk = e.target.closest('a[data-href]'); if (lk) { e.preventDefault(); window.sphere.openUrl(lk.dataset.href); return; }   // a link in a plan or question text
    const o = e.target.closest('.qb'), a = e.target.closest('[data-a]');
    if (o) pickOpt(+o.closest('.qq').dataset.i, +o.dataset.j);
    else if (a && a.dataset.a === 'submit') submit();
    else if (a && a.dataset.a === 'permit') permit(a.dataset.c);
    else if (a && a.dataset.a === 'plan') plan(a.dataset.c);
    else if (a && a.dataset.a === 'planmore' && !busy) dropMenu(a, [{ label: 'Accept + allow edits', c: 'edits' }, { label: 'Accept + bypass permissions', c: 'bypass', sub: 'no prompts at all' }], it => plan(it.c));
    else if (a && a.dataset.a === 'revopen') revise(true);
    else if (a && a.dataset.a === 'revback') revise(false);
  });
  cq.addEventListener('input', e => { if (e.target.classList.contains('qother')) typeOther(+e.target.closest('.qq').dataset.i, e.target.value); });

  // New session form: replaces the conversation until Start or Cancel
  let formOn = false, formTok = 0, starting = false;
  async function openForm(folder) {
    if (!cur) return;
    if (formOn) return closeForm(true);
    formOn = true; starting = false; const tok = ++formTok; root.classList.add('nw'); nt.value = ''; nwk.checked = false; nmsg.textContent = 'Loading folders…'; nf.replaceChildren(); startB.disabled = true;
    setTimeout(() => formOn && nt.focus(), 50);
    const f = await window.sphere.consoleFolders().catch(() => null);
    if (tok !== formTok) return;
    const fl = Array.isArray(f) ? f : f && f.folders, ml = f && Array.isArray(f.models) ? f.models.filter(x => typeof x === 'string' && x) : [];   // main sends { folders, models }; a bare array works too
    const names = Array.isArray(fl) ? fl.filter(x => typeof x === 'string' && x) : [];
    if (ml.length) { const v = nm.value; nm.replaceChildren(...ml.map(n => Object.assign(el('option'), { textContent: n, value: n }))); nm.value = ml.includes(v) ? v : ml[0]; }
    nf.replaceChildren(...names.map(n => Object.assign(el('option'), { textContent: n, value: n })));
    if (names.length) { nf.selectedIndex = 0; if (typeof folder === 'string' && names.includes(folder)) nf.value = folder; nmsg.textContent = ''; startB.disabled = false; } else nmsg.textContent = 'No folders found.';
  }
  function closeForm(focus) {
    if (!formOn) return; formOn = false; formTok++; starting = false; root.classList.remove('nw');
    if (cur && cur.blank) { host.close(); return; }   // nothing behind the form: leave the card
    if (focus && cur) ta.focus();
  }
  async function start() {
    if (!formOn || starting) return;
    const text = nt.value.trim();
    if (!nf.value) { nmsg.textContent = 'Pick a folder.'; return; }
    if (!text) { nmsg.textContent = 'Write the first message.'; nt.focus(); return; }
    const tok = formTok; starting = true; startB.disabled = true; nmsg.textContent = 'Starting… (this can take about 10 seconds)';
    const r = await window.sphere.consoleNew(nf.value, nm.value, text, nwk.checked).catch(() => null);
    if (tok !== formTok) return;
    starting = false; startB.disabled = false;
    if (r && r.ok && r.sessionId) { formOn = false; root.classList.remove('nw', 'blank'); open({ sessionId: r.sessionId, title: r.title || '' }); }
    else nmsg.textContent = 'Not started: ' + ((r && r.why) || 'no answer');
  }

  // ---- header (SessionConsole_Stage4 Q2 + behaviour 2): the permission mode as a dropdown, and the "⋯" housekeeping menu ----
  const modeB = q('.cmo'), moreB = q('[data-a=more]'), cti = q('.cti'), cdel = q('.cdel');
  let acting = false;
  const showMode = m => { modeB.textContent = (m || 'Mode') + ' ▾'; modeB.dataset.m = m || ''; };
  function loadMode(s) {
    showMode('');
    window.sphere.consoleSettings(s.sessionId).then(r => { if (cur === s && r && r.ok) showMode(r.mode); }).catch(() => {});
  }
  async function act(label, fn, after) {
    const s = cur; if (!s || acting) return;
    acting = true; why.textContent = label + '…';
    const r = await fn(s).catch(e => ({ ok: false, why: e.message }));
    acting = false;
    if (cur !== s) return;
    if (r && r.ok) { why.textContent = ''; after(r, s); } else why.textContent = label + ' failed: ' + ((r && r.why) || 'no answer');
  }
  function modeMenu() {
    const now = modeB.dataset.m;
    dropMenu(modeB, MODES.map(m => ({ label: m, on: m === now, sub: m === 'Bypass permissions' ? 'no prompts at all' : '' })), it => {
      if (it.label === now) return;
      act('Mode change', s => window.sphere.consoleSet(s.sessionId, 'mode', it.label), r => showMode(r.mode));
    });
  }
  // Bridge_Spec: Worktrees and MCP open as pane views; Remote Control, Move to cloud and Connectors live only in the Claude app,
  // so those bring the app to this session for you to click there
  const APP_PLACES = ['Remote Control…', 'Move to cloud…', 'Connectors…'];
  function moreMenu() {
    dropMenu(moreB, [{ label: 'Worktrees' }, { label: 'MCP servers' }, ...(cur && cur.link ? APP_PLACES.map(l => ({ label: l, sub: 'in Claude' })) : []), ...(appOn ? [{ label: 'Rename' }, { label: 'Fork' }, { label: 'Archive' }, { label: 'Delete' }] : [])], it => {
      if (it.label === 'Worktrees') setTab('worktrees');
      else if (it.label === 'MCP servers') setTab('mcp');
      else if (APP_PLACES.includes(it.label)) { const s = cur; close(); host.openClaude(s); }
      else if (it.label === 'Rename') rename(true);
      else if (it.label === 'Fork') act('Fork', s => window.sphere.consoleManage(s.sessionId, 'fork'), r => { why.textContent = `Forked: "${r.title || 'the fork'}" is in Claude.`; });
      else if (it.label === 'Archive') act('Archive', s => window.sphere.consoleManage(s.sessionId, 'archive'), () => host.close());
      else askYes(`Delete "${cur.title}"? This can't be undone.`, 'Yes, delete', () => act('Delete', s => window.sphere.consoleManage(s.sessionId, 'delete'), () => host.close()));
    });
  }
  // the Yes / No strip under the header (Delete, Rewind, Edit)
  new MutationObserver(() => { if (!cdel.classList.contains('on')) unpreview(); }).observe(cdel, { attributes: true, attributeFilter: ['class'] });   // the question closed: Yes, No, Esc or the console closed
  let yesDo = null, yesFor = null;   // the strip answers only for the session it was opened in
  function askYes(text, yes, fn) {
    yesDo = fn; yesFor = cur; cdel.querySelector('.cdt').textContent = text; cdel.querySelector('[data-a=delyes]').textContent = yes;
    cdel.classList.add('on'); cdel.querySelector('[data-a=delno]').focus();
  }
  function rename(on) {
    if (on && !appOn) return;
    if (on) { cti.value = cur.title || ''; root.classList.add('rn'); cti.focus(); cti.select(); return; }
    root.classList.remove('rn'); ta.focus();
  }
  cti.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); rename(false); }
    else if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault(); const nm = cti.value.trim(); rename(false);
      if (nm && nm !== cur.title) act('Rename', s => window.sphere.consoleManage(s.sessionId, 'rename', nm), (r, s) => { s.title = r.title || nm; title.textContent = s.title; });
    }
  });
  cti.addEventListener('blur', () => { if (root.classList.contains('rn')) root.classList.remove('rn'); });
  window.sphere.onConsoleNote?.(b => { if (cur && b && b.sessionId === cur.sessionId) { const d = el('div', 'm note', b.text); list.append(d); if (near()) bottom(); } });

  // ---- attachments (SessionConsole_Stage4 Q3): a pasted image or dropped files show as chips over the reply box (✕ drops one)
  // and go with the reply through the app's "Add files or photos" dialog (consoleAttach) ----
  const ca = q('.ca'), MAXATT = 8;
  let atts = [];   // { name, path } (a file on disk) or { name, png: Uint8Array, url } (a pasted image)
  function drawAtts() {
    ca.replaceChildren(...atts.map((a, i) => {
      const c = el('span', 'cac'); c.title = a.path || a.name;
      if (a.url) { const im = el('img'); im.src = a.url; c.append(im); }
      c.append(el('span', 'can', a.name));
      const x = el('button', 'cax', '✕'); x.title = 'Remove'; x.onclick = e => { e.stopPropagation(); dropAtt(i); ta.focus(); }; c.append(x);
      return c;
    }));
    ca.style.display = atts.length ? 'flex' : 'none';
  }
  function dropAtt(i) { const [a] = atts.splice(i, 1); if (a && a.url) URL.revokeObjectURL(a.url); drawAtts(); draftSoon(); }
  function clearAtts() { atts.forEach(a => a.url && URL.revokeObjectURL(a.url)); atts = []; drawAtts(); }
  // a File -> PNG bytes (other image types are redrawn as PNG)
  async function pngOf(f) {
    if (f.type === 'image/png') return new Uint8Array(await f.arrayBuffer());
    const bm = await createImageBitmap(f), cv = document.createElement('canvas'); cv.width = bm.width; cv.height = bm.height;
    cv.getContext('2d').drawImage(bm, 0, 0); const b = await new Promise(r => cv.toBlob(r, 'image/png'));
    return new Uint8Array(await b.arrayBuffer());
  }
  async function addFiles(files) {
    const s = cur;
    for (const f of files) {
      if (cur !== s) return;   // another session opened while an image was read
      if (atts.length >= MAXATT) { why.textContent = `At most ${MAXATT} files with one reply.`; break; }
      const p = window.sphere.pathOf(f);
      if (p) atts.push({ name: f.name || p.split(/[\\/]/).pop(), path: p });
      else if (/^image\//.test(f.type)) {
        if (f.size > 20 << 20) { why.textContent = 'That image is over 20 MB.'; continue; }
        try { const png = await pngOf(f); if (cur !== s) return; atts.push({ name: f.name && f.name !== 'image.png' ? f.name : `pasted image ${atts.length + 1}.png`, png, url: URL.createObjectURL(new Blob([png], { type: 'image/png' })) }); } catch { why.textContent = 'That image could not be read.'; }
      } else why.textContent = `"${f.name}" can't be attached (not a file on disk).`;
    }
    drawAtts(); draftSoon();
  }
  ta.addEventListener('paste', e => {
    const fs = [...(e.clipboardData ? e.clipboardData.files : [])];
    // text on the clipboard as well (cells copied from a spreadsheet come with a picture of them): the text is pasted, no file
    if (!fs.length || !cur || cur.blank || (e.clipboardData.getData('text/plain') || '').trim()) return;
    e.preventDefault(); addFiles(fs);
  });
  root.addEventListener('dragover', e => { if (cur && !cur.blank && !formOn) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; root.classList.add('dropon'); } });
  root.addEventListener('dragleave', e => { if (!root.contains(e.relatedTarget)) root.classList.remove('dropon'); });
  root.addEventListener('drop', e => {
    e.preventDefault(); root.classList.remove('dropon');
    if (cur && !cur.blank && !formOn && e.dataTransfer.files.length) { addFiles([...e.dataTransfer.files]); ta.focus(); }
  });
  // anywhere else a dropped file would replace the page
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => e.preventDefault());

  const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'; };
  ta.addEventListener('input', grow);
  // ---- drafts (new ideas 1): the reply and its attachments are kept per session (main saves them, a pasted picture as a PNG
  // in the app's data folder) until sent or emptied; saved 0.8 s after a change and when another session opens or the card closes
  let dSave = 0, dBusy = null;
  function draftSoon() { clearTimeout(dSave); const s = cur; dSave = setTimeout(() => { if (cur === s) draftNow(s); }, 800); }
  async function draftNow(s) {
    clearTimeout(dSave);
    if (!s || s.blank || !s.sessionId) return;
    const text = ta.value, all = atts.slice();   // read now: the box is emptied when the card closes
    while (dBusy) await dBusy;                    // one save at a time (a picture saved by the last one has its path by now)
    const pend = all.filter(a => a.png && !a.path);
    dBusy = window.sphere.draftSet(s.sessionId, text, all.filter(a => a.path).map(a => ({ name: a.name, path: a.path, img: !!a.img })), pend.map(a => ({ name: a.name, png: a.png }))).catch(() => null);
    const r = await dBusy; dBusy = null;
    if (r && r.ok && pend.length) { const got = r.atts.slice(r.atts.length - pend.length); if (got.length === pend.length) pend.forEach((a, i) => { a.path = got[i].path; a.img = true; delete a.png; }); }   // sent from its file from now on
  }
  function draftLoad(s) {
    window.sphere.draftGet(s.sessionId).then(d => {
      if (cur !== s || !d || ta.value || atts.length) return;
      ta.value = d.text || ''; grow();
      const gone = d.atts.filter(a => a.gone);
      atts = d.atts.filter(a => !a.gone).map(a => a.img && a.png ? { name: a.name, path: a.path, img: true, url: URL.createObjectURL(new Blob([a.png], { type: 'image/png' })) } : { name: a.name, path: a.path, img: !!a.img });
      drawAtts();
      if (gone.length) { why.textContent = `Not found any more, so left out of the draft: ${gone.map(a => a.name).join(', ')}`; draftSoon(); }
    }, () => {});
  }
  ta.addEventListener('input', draftSoon);
  // stage 5 tabs: Chat | Changes | PR | Tasks | Artifacts. A tab other than Chat swaps the conversation for its pane (the reply
  // box and any question card stay); each pane is read when its tab opens, and again on Refresh. Nothing polls
  const pane = q('.cpane'), tabs = q('.ctabs');
  let tab = 'chat', paneTok = 0;
  // Bridge_Spec pane state: the commit / PR forms, the Files tree's open folders and filter, and this session's activity (from the feed)
  let commitOn = false, prOn = false, fFilter = '', paneRedraw = null, paneRoot = '', curAct = '';
  const fOpen = new Set(), unticked = new Set();
  const pb = (label, a, extra) => { const b = el('button', 'cb', label); b.dataset.p = a; if (extra) Object.assign(b.dataset, extra); return b; };
  const suggest = files => {
    const names = files.slice(0, 3).map(f => f.file.split('/').pop()), more = files.length > 3 ? ` and ${files.length - 3} more` : '';
    return (files.every(f => f.untracked) ? 'Add ' : 'Update ') + names.join(', ') + more;
  };
  const ACT_PANE = { files: 'files', worktrees: 'worktrees', mcp: 'mcp' };
  const ago = t => { const m = Math.round((Date.now() - t) / 60000); return !t ? '' : m < 1 ? 'now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago'; };
  let chatGap = 0;   // the chat's distance from the bottom when a pane hid it (a hidden list loses its scroll place)
  function setTab(t) {
    if (tab === 'chat' && t !== 'chat') chatGap = near() ? 0 : list.scrollHeight - list.scrollTop;
    const back = tab !== 'chat' && t === 'chat';
    if (t !== tab) { commitOn = prOn = false; unticked.clear(); }
    tab = t; paneTok++;
    for (const b of tabs.children) { b.classList.toggle('on', b.dataset.tab === t); b.setAttribute('aria-selected', b.dataset.tab === t); }
    root.classList.toggle('pane', t !== 'chat'); pane.replaceChildren();
    if (t !== 'chat') loadPane();
    else if (back) list.scrollTop = chatGap ? list.scrollHeight - chatGap : list.scrollHeight;
  }
  async function loadPane() {
    const s = cur, t = tab, tok = ++paneTok; if (!s || s.blank) return;
    pane.replaceChildren(el('div', 'empty', 'Reading…'));
    const r = await (ACT_PANE[t] ? window.sphere.consoleAct(s.sessionId, ACT_PANE[t]) : window.sphere.consolePane(s.sessionId, t)).catch(() => null);
    if (tok !== paneTok || cur !== s) return;
    const bar = el('div', 'pbar'), sum = el('span', 'pbs'), rf = el('button', 'cb', 'Refresh'); rf.dataset.a = 'refresh'; bar.append(sum, rf);
    pane.replaceChildren(bar);
    if (!r || !r.ok) { sum.textContent = (r && r.why) || 'No answer'; return; }
    const rows = el('div', 'prows'); pane.append(rows);
    const row = (cls, ...parts) => { const d = el('div', 'prow ' + cls); for (const p of parts) if (p) d.append(p); rows.append(d); return d; };
    if (t === 'changes') {
      sum.textContent = r.files.length ? `${r.branch} · ${r.files.length}${r.more ? '+' : ''} changed file${r.files.length > 1 ? 's' : ''} · ${r.dir}` : `${r.branch} · no changes · ${r.dir}`;
      if (r.worktree) sum.prepend(el('span', 'pnew', 'worktree'), ' ');
      if (r.files.length && !commitOn) bar.insertBefore(pb('Commit…', 'commit'), rf);
      bar.insertBefore(pb('Push', 'push'), rf);
      if (r.files.length) bar.insertBefore(pb('Ask session to commit', 'askcommit'), rf);
      if (commitOn && r.files.length) {
        const form = el('div', 'pform'), msg = el('textarea', 'pmsg'), fb = el('div', 'pfb'), go = pb('Commit ticked files', 'commitgo');
        msg.rows = 2; msg.spellcheck = false; msg.value = suggest(r.files); go.classList.add('cs');
        fb.append(go, pb('Cancel', 'commitno')); form.append(msg, fb); pane.insertBefore(form, rows);
        msg.addEventListener('keydown', e => e.stopPropagation()); setTimeout(() => { msg.focus(); msg.select(); }, 0);
      }
      for (const f of r.files) {
        const d = row('pfile', el('span', 'pn', f.file), f.untracked ? el('span', 'pnew', 'new') : f.bin ? el('span', 'pnew', 'binary') : null,
          !f.untracked && !f.bin ? el('span', 'pa', '+' + f.add) : null, !f.untracked && !f.bin ? el('span', 'pd', '−' + f.del) : null);
        d._file = f.file; d.title = 'Show this file’s changes';
        if (commitOn) { const c = el('input', 'pck'); c.type = 'checkbox'; c.checked = !unticked.has(f.file); c.title = 'Commit this file'; d.prepend(c); }
      }
    } else if (t === 'pr') {
      sum.textContent = 'Branch ' + r.branch;
      if (!r.pr) {
        row('pnote', el('span', '', r.why || 'No pull request'));
        if (r.why && /no git remote/i.test(r.why)) return;
        if (!prOn) { bar.insertBefore(pb('Create PR…', 'pr'), rf); return; }
        const d = await window.sphere.consoleAct(s.sessionId, 'prdraft').catch(() => null);
        if (tok !== paneTok || cur !== s) return;
        if (!d || !d.ok) { row('pnote', el('span', 'bad', 'Can’t create one: ' + ((d && d.why) || 'no answer'))); return; }
        const form = el('div', 'pform'), ti = el('input', 'pti'), bo = el('textarea', 'pbo'), ba = el('input', 'pba'), fb = el('div', 'pfb'), go = pb('Create pull request', 'prgo');
        ti.type = ba.type = 'text'; ti.value = d.title; bo.value = d.body; bo.rows = 6; ba.value = d.base; ti.spellcheck = bo.spellcheck = ba.spellcheck = false;
        ti.placeholder = 'Title'; ba.title = 'Base branch'; go.classList.add('cs');
        const lab = (t, x) => { const l = el('label', 'plab', t); l.append(x); return l; };
        for (const x of [ti, bo, ba]) x.addEventListener('keydown', e => e.stopPropagation());
        fb.append(go, pb('Cancel', 'prno')); form.append(lab('Title', ti), lab('Description', bo), lab(`Into (from ${d.branch})`, ba), fb); rows.append(form);
        return;
      }
      const p = r.pr, h = row('plink', el('b', '', `#${p.number} ${p.title}`), el('span', 'pst ' + p.state.split(' ')[0], p.state)); h._url = p.url; h.title = p.url;
      if (!p.checks.length) row('pnote', el('span', '', 'No checks'));
      for (const c of p.checks) { const d = row('pcheck', el('span', 'pst ' + c.state, c.state || '…'), el('span', 'pn', c.name)); if (c.url) { d._url = c.url; d.classList.add('plink'); } }
    } else if (t === 'tasks') {
      const n = r.tasks.filter(x => x.state === 'running').length;
      sum.textContent = r.tasks.length ? `${r.tasks.length} background task${r.tasks.length > 1 ? 's' : ''}${n ? ` · ${n} running` : ''}` : 'No background commands or agents';
      for (const x of r.tasks) row('ptask', el('span', 'pst ' + x.state, x.state), el('span', 'pk', x.kind), el('span', 'pn', x.text), el('span', 'pt', ago(x.at)));
    } else if (t === 'artifacts') {
      sum.textContent = r.items.length ? `${r.items.length} artifact${r.items.length > 1 ? 's' : ''}` : 'No artifacts published in this session';
      for (const x of r.items) { const d = row('plink', el('span', 'pn', x.title), el('span', 'pu', x.url), el('span', 'pt', ago(x.at))); d._url = x.url; d.title = 'Open in the browser'; }
    } else if (t === 'files') {
      paneRoot = r.root;
      sum.textContent = `${r.branch ? r.branch + ' · ' : ''}${r.changed.length ? r.changed.length + ' changed · ' : ''}${r.root}`;
      if (r.worktree) sum.prepend(el('span', 'pnew', 'worktree'), ' ');
      const flt = el('input', 'pflt'); flt.type = 'text'; flt.placeholder = 'Filter by name'; flt.value = fFilter; flt.spellcheck = false; bar.insertBefore(flt, rf);
      flt.addEventListener('keydown', e => e.stopPropagation());
      const chg = new Map(r.changed.map(c => [c.p, c])), kids = new Map(), hot = new Set();
      for (const x of r.entries) { const i = x.p.lastIndexOf('/'), par = i < 0 ? '' : x.p.slice(0, i); if (!kids.has(par)) kids.set(par, []); kids.get(par).push(x); }
      for (const c of r.changed) { let q2 = c.p; while (q2.includes('/')) { q2 = q2.slice(0, q2.lastIndexOf('/')); hot.add(q2); } }
      const fileRow = (p, depth, full) => {
        const c = chg.get(p), d = row('ffile' + (c ? ' chg' : ''), el('span', 'pn', full ? p : p.split('/').pop()),
          c ? (c.untracked ? el('span', 'pnew', 'new') : el('span', 'pa', '+' + c.add)) : null, c && !c.untracked ? el('span', 'pd', '−' + c.del) : null);
        d.style.paddingLeft = 9 + depth * 14 + 'px'; d._path = p; d.title = 'Open in your editor (right-click for more)';
      };
      const draw = () => {
        rows.replaceChildren(); const f = fFilter.trim().toLowerCase();
        if (f) { const hits = r.entries.filter(x => !x.d && x.p.toLowerCase().includes(f)); hits.slice(0, 300).forEach(x => fileRow(x.p, 0, true)); if (!hits.length) row('pnote', el('span', '', 'No file matches')); return; }
        if (r.changed.length) { row('pgh', el('span', '', 'Changed')); r.changed.slice(0, 100).forEach(c => fileRow(c.p, 0, true)); row('pgh', el('span', '', 'All files')); }
        const walk = (par, depth) => {
          for (const x of kids.get(par) || []) {
            if (!x.d) { fileRow(x.p, depth, false); continue; }
            const open = fOpen.has(x.p), d = row('fdir' + (hot.has(x.p) ? ' hot' : ''), el('span', 'fi', open ? '▾' : '▸'), el('span', 'pn', x.p.split('/').pop()));
            d.style.paddingLeft = 9 + depth * 14 + 'px'; d._dir = x.p; d._path = x.p;
            if (open) walk(x.p, depth + 1);
          }
        };
        walk('', 0);
      };
      flt.addEventListener('input', () => { fFilter = flt.value; draw(); });
      paneRedraw = draw; draw();
    } else if (t === 'worktrees') {
      sum.textContent = `Worktrees of this repository (${r.list.length})`;
      for (const w of r.list) {
        const here = w.path.toLowerCase() === String(r.here || '').toLowerCase();
        const d = row('pwtr', el('span', 'pn', w.branch || '(no branch)'), w.main ? el('span', 'pnew', 'main') : null, here ? el('span', 'pnew', 'this session') : null,
          el('span', 'pu', w.path), el('span', 'pt', w.changed == null ? (w.prunable ? 'missing' : '') : w.changed ? `${w.changed} changed` : 'clean'));
        if (!w.main && !w.changed && !here) d.append(pb('Remove', 'wtrm', { path: w.path }));
      }
    } else if (t === 'mcp') {
      sum.textContent = r.note;
      if (!r.items.length) row('pnote', el('span', '', 'No MCP servers set up for this folder'));
      for (const m of r.items) {
        const d = row('pmcp', el('span', 'pn', m.name), el('span', 'pk', m.scope), el('span', 'pt', m.kind));
        if (m.fixed) d.append(el('span', 'pt', 'on (from your ' + (m.scope === 'user' ? 'user' : 'local') + ' config)'));
        else { const b = pb(m.on ? 'On' : m.asked ? 'Asks first' : 'Off', 'mcpt', { name: m.name, on: m.on ? '0' : '1' }); if (m.on) b.classList.add('cs'); b.title = m.on ? 'Switch off for this project' : 'Switch on for this project'; d.append(b); }
      }
      row('pnote', el('span', '', 'Connectors are switched per session in the Claude app: ⋯ → Connectors…'));
    }
  }
  // Bridge_Spec actions from the panes
  async function paneAct(a, b) {
    const s = cur; if (!s || acting) return;
    const call = (act2, arg) => window.sphere.consoleAct(s.sessionId, act2, arg);
    const busy = curAct === 'working';
    if (a === 'commit') { commitOn = true; return loadPane(); }
    if (a === 'commitno') { commitOn = false; unticked.clear(); return loadPane(); }
    if (a === 'commitgo') {
      const msg = (pane.querySelector('.pmsg') || {}).value || '', files = [...pane.querySelectorAll('.pfile')].filter(d => d.querySelector('.pck') && d.querySelector('.pck').checked).map(d => d._file);
      const go = () => act('Commit', () => call('commit', { files, msg }), r => { commitOn = false; unticked.clear(); why.textContent = r.out || 'Committed'; if (tab === 'changes') loadPane(); });
      return busy ? askYes('The session is still working: its next edits may land half-done. Commit now?', 'Yes, commit', go) : go();
    }
    if (a === 'push') {
      const i = await call('pushinfo').catch(() => null); if (cur !== s) return;
      if (!i || !i.ok) { why.textContent = 'Push: ' + ((i && i.why) || 'no answer'); return; }
      const go = () => act('Push', () => call('push'), r => { why.textContent = r.out || 'Pushed'; if (tab === 'changes' || tab === 'pr') loadPane(); });
      const warn = [i.main && i.branch === i.main ? `This pushes straight to ${i.main}.` : '', busy ? 'The session is still working.' : ''].filter(Boolean);
      return warn.length ? askYes(warn.join(' ') + ' Push now?', 'Yes, push', go) : go();
    }
    if (a === 'askcommit') return act('Asking', () => window.sphere.consoleSend(s.sessionId, 'Please commit your changes with a clear message.'), () => { why.textContent = 'Asked the session to commit.'; });
    if (a === 'pr') { prOn = true; return loadPane(); }
    if (a === 'prno') { prOn = false; return loadPane(); }
    if (a === 'prgo') {
      const v = c => (pane.querySelector(c) || {}).value || '';
      return act('Create PR', () => call('prcreate', { title: v('.pti'), body: v('.pbo'), base: v('.pba') }), r => { prOn = false; why.textContent = r.out || 'Pull request created'; if (tab === 'pr') loadPane(); });
    }
    if (a === 'wtrm') { const pth = b.dataset.path; return askYes(`Remove the worktree ${pth}? Its folder is deleted (it has no changes).`, 'Yes, remove', () => act('Remove', () => call('wtremove', { path: pth }), () => { if (tab === 'worktrees') loadPane(); })); }
    if (a === 'mcpt') return act('MCP', () => call('mcpset', { name: b.dataset.name, on: b.dataset.on === '1' }), () => { if (tab === 'mcp') loadPane(); });
  }
  function fileMenu(rowEl) {
    const p = rowEl._path, isDir = !!rowEl._dir, s = cur;
    dropMenu(rowEl, [...(isDir ? [] : [{ label: 'Open in editor' }]), { label: 'Reveal in Explorer' }, { label: 'Copy path' }], it => {
      if (cur !== s) return;
      if (it.label === 'Open in editor') act('Open', () => window.sphere.consoleAct(s.sessionId, 'open', { file: p }), () => {});
      else if (it.label === 'Reveal in Explorer') act('Reveal', () => window.sphere.consoleAct(s.sessionId, 'reveal', { file: p }), () => {});
      else navigator.clipboard.writeText(paneRoot.replace(/[\\/]$/, '') + '\\' + p.replace(/\//g, '\\')).then(() => { why.textContent = 'Path copied'; }, () => { why.textContent = 'Copy failed'; });
    });
  }
  pane.addEventListener('contextmenu', e => { const r = e.target.closest('.ffile, .fdir'); if (!r) return; e.preventDefault(); fileMenu(r); });
  function previewMenu() {
    const s = cur, b = q('[data-a=prev]');
    act('Preview', () => window.sphere.consoleAct(s.sessionId, 'previews'), r => {
      if (!r.items.length) { why.textContent = 'No local addresses in this session yet (start its dev server, or add .claude/launch.json).'; return; }
      dropMenu(b, r.items.map(x => ({ label: x.label, sub: x.from === 'launch.json' ? 'launch.json' : '', url: x.url })), it => act('Preview', () => window.sphere.consoleAct(s.sessionId, 'preview', { url: it.url }), () => {}));
    });
  }
  tabs.addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b && cur && !cur.blank) { setTab(b.dataset.tab); ta.focus(); } });   // the reply box keeps the keyboard
  pane.addEventListener('click', async e => {
    if (e.target.closest('[data-a=refresh]')) return loadPane();
    const pbt = e.target.closest('[data-p]'); if (pbt) return paneAct(pbt.dataset.p, pbt);
    if (e.target.matches('.pck')) { const d = e.target.closest('.pfile'); if (d) { if (e.target.checked) unticked.delete(d._file); else unticked.add(d._file); } return; }
    const fd = e.target.closest('.fdir'); if (fd) { if (fOpen.has(fd._dir)) fOpen.delete(fd._dir); else fOpen.add(fd._dir); if (paneRedraw) paneRedraw(); return; }
    const ff = e.target.closest('.ffile'); if (ff && cur) { const s = cur; return act('Open', () => window.sphere.consoleAct(s.sessionId, 'open', { file: ff._path }), () => {}); }
    const l = e.target.closest('.plink'); if (l && l._url) return window.sphere.openUrl(l._url);
    const f = e.target.closest('.pfile'); if (!f || e.target.closest('.df')) return;
    if (f.nextSibling && f.nextSibling._diff) { f.nextSibling.remove(); return; }
    const box = el('div', 'df'); box._diff = true; box.append(el('div', 'dfh', 'Reading…')); f.after(box);
    const s = cur, r = await window.sphere.consolePane(s.sessionId, 'diff', f._file).catch(() => null);
    if (cur !== s) return;
    if (!r || !r.ok) { box.replaceChildren(el('div', 'dfh bad', 'Not shown: ' + ((r && r.why) || 'no answer'))); return; }
    const pre = el('pre', 'dfb');
    for (const [k, x] of r.lines) pre.append(el('span', k === '+' ? 'da' : k === '-' ? 'dd' : k === '@' ? 'dh' : 'dc', k === '@' ? x + '\n' : (k === ' ' ? '  ' : k + ' ') + x + '\n'));
    box.replaceChildren(pre); if (r.cut) box.append(el('div', 'dfh', 'Longer than shown (first 3000 lines).'));
  });

  // stage 5 composer: "/" at the start lists the app's commands (read from the app once a day, main keeps them), "@" lists
  // the session folder's files and folders (read from disk; picking a folder lists its own entries). ↑ / ↓ move, Tab or
  // Enter insert, Esc closes the list; typing filters it
  const pop = q('.cpop');
  let popOn = null, popSel = 0, popItems = [], cmds = null, files = null;   // popOn: { kind: '/' | '@', from, to, query }; files: { sid, at, p }
  const settle = p => { p.then(v => { p.val = v; p.done = true; }, () => { p.done = true; }); return p; };
  function getCmds() {
    if (!cmds) cmds = settle(window.sphere.consoleCommands(cur.sessionId).catch(() => null).then(r => { if (!(r && r.ok && r.names.length)) setTimeout(() => { cmds = null; }, 60000); return r; }));
    return cmds;
  }
  function getFiles() {
    const sid = cur.sessionId;
    if (!files || files.sid !== sid || Date.now() - files.at > 10000) files = { sid, at: Date.now(), p: settle(window.sphere.consoleFiles(sid).catch(() => null)) };
    return files.p;
  }
  // the "/" or "@" word the caret is in, or null
  function tokenAt() {
    const c = ta.selectionStart; if (c !== ta.selectionEnd) return null;
    const b = ta.value.slice(0, c);
    let m = /^\/([\w:.-]*)$/.exec(b); if (m) return { kind: '/', from: 0, to: c, query: m[1].toLowerCase() };
    m = /(^|\s)@([^\s@"]*)$/.exec(b); if (m) return { kind: '@', from: c - m[2].length - 1, to: c, query: m[2].toLowerCase().replace(/\\/g, '/') };
    return null;
  }
  function popClose() { popOn = null; popItems = []; pop.classList.remove('on'); pop.replaceChildren(); }
  function popUpdate() {
    const t = cur && !cur.blank && tokenAt(); if (!t) return popClose();
    if (!popOn || popOn.kind !== t.kind || popOn.query !== t.query) popSel = 0;
    popOn = t; pop.classList.add('on');
    const p = t.kind === '/' ? getCmds() : getFiles();
    if (!p.done) { pop.replaceChildren(el('div', 'cpn', t.kind === '/' ? 'Reading the app’s commands…' : 'Reading the session folder…')); p.then(() => { if (popOn === t) popUpdate(); }); return; }
    const r = p.val, qy = t.query;
    if (t.kind === '/') {
      const have = r && r.ok && r.names.length, names = have ? r.names : Object.keys(CMD_DESC);
      popItems = names.filter(n => n.toLowerCase().includes(qy)).sort((a, b) => b.toLowerCase().startsWith(qy) - a.toLowerCase().startsWith(qy))
        .map(n => ({ ins: '/' + n + ' ', label: '/' + n, sub: CMD_DESC[n] || '' }));
      if (!have) popItems.push({ note: 'Built-in list: ' + ((r && r.why) || 'the app’s list could not be read') });
    } else if (!(r && r.ok)) popItems = [{ note: 'No files: ' + ((r && r.why) || 'no answer') }];
    else {
      const dir = qy.endsWith('/') ? qy : null;   // "src/" lists that folder's own entries
      const rank = e => {
        const lp = e.p.toLowerCase(), bn = lp.slice(lp.lastIndexOf('/') + 1);
        if (dir) return lp.startsWith(dir) && !lp.slice(dir.length).includes('/') ? 0 : 9;
        return !qy || bn.startsWith(qy) ? 0 : lp.startsWith(qy) ? 1 : bn.includes(qy) ? 2 : lp.includes(qy) ? 3 : 9;
      };
      popItems = r.entries.map(e => ({ e, k: rank(e) })).filter(x => x.k < 9).sort((a, b) => a.k - b.k || a.e.p.split('/').length - b.e.p.split('/').length).slice(0, 60)
        .map(({ e }) => ({ ins: '@' + (/\s/.test(e.p) ? `"${e.p}"` : e.p) + (e.d ? (/\s/.test(e.p) ? ' ' : '/') : ' '), label: e.p + (e.d ? '/' : ''), sub: '', dir: e.d && !/\s/.test(e.p) }));
    }
    if (!popItems.some(x => !x.note)) popItems.unshift({ note: t.kind === '/' ? 'No command matches' : 'No file matches' });
    popSel = Math.min(popSel, Math.max(0, popItems.filter(x => !x.note).length - 1));
    drawPop();
  }
  function drawPop() {
    let i = 0;
    pop.replaceChildren(...popItems.map(x => {
      if (x.note) return el('div', 'cpn', x.note);
      const d = el('div', 'cpi' + (i === popSel ? ' sel' : '')); d.dataset.i = i++; d.setAttribute('role', 'option');
      d.append(el('b', '', x.label)); if (x.sub) d.append(el('span', '', x.sub));
      return d;
    }));
    const s_ = pop.querySelector('.cpi.sel'); if (s_) s_.scrollIntoView({ block: 'nearest' });
  }
  function popPick(i) {
    const x = popItems.filter(y => !y.note)[i], t = popOn; if (!x || !t) return;
    const v = ta.value; ta.value = v.slice(0, t.from) + x.ins + v.slice(t.to);
    const c = t.from + x.ins.length; ta.setSelectionRange(c, c); grow(); ta.focus();
    if (x.dir) popUpdate(); else popClose();
  }
  ta.addEventListener('input', () => popUpdate());
  ta.addEventListener('click', () => popUpdate());
  ta.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== ta) popClose(); }, 150));
  pop.addEventListener('mousedown', e => { e.preventDefault(); const d = e.target.closest('.cpi'); if (d) popPick(+d.dataset.i); });
  // a key in the reply box while the list is open -> true when the list used it
  function popKey(e) {
    if (!popOn) return false;
    const n = popItems.filter(x => !x.note).length;
    if (e.key === 'Escape') { popClose(); return true; }
    if (!n) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { popSel = (popSel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n; drawPop(); return true; }
    if ((e.key === 'Tab' && !e.shiftKey) || (e.key === 'Enter' && !e.shiftKey && !e.isComposing)) { popPick(popSel); return true; }
    return false;
  }
  let sending = false;
  async function send() {
    const s = cur, t = ta.value.trim(), with_ = atts.slice(); if (!s || (!t && !with_.length) || sending) return;
    popClose(); sending = true; why.textContent = with_.length ? `Sending with ${with_.length} file${with_.length > 1 ? 's' : ''}…` : 'Sending…';
    const r = await (with_.length
      ? window.sphere.consoleAttach(s.sessionId, with_.filter(a => a.path).map(a => a.path), with_.filter(a => a.png).map(a => a.png), t)
      : window.sphere.consoleSend(s.sessionId, t)).catch(() => null);
    sending = false;
    if (cur !== s) return;
    if (r && r.ok) {
      why.textContent = ''; if (ta.value.trim() === t) { ta.value = ''; grow(); }
      if (with_.length) { atts = atts.filter(a => !with_.includes(a)); with_.forEach(a => a.url && URL.revokeObjectURL(a.url)); drawAtts(); }
      draftNow(s);   // sent: what is left (usually nothing) is the draft
    } else why.textContent = 'Not sent: ' + ((r && r.why) || 'no answer');
  }
  async function stop() {
    const s = cur; if (!s) return;
    why.textContent = '';
    const r = await window.sphere.consoleStop(s.sessionId).catch(() => null);
    if (cur === s && !(r && r.ok)) why.textContent = 'Not stopped: ' + ((r && r.why) || 'no answer');
  }
  // keys in the cards and the form: kept off the sphere; Esc closes the form, or takes the focus from a card back to the reply box
  root.addEventListener('keydown', e => {
    if (e.target === ta) return;
    e.stopPropagation();
    const enter = e.key === 'Enter' && !e.isComposing;
    if (e.key === 'Escape' && (menuOpen() || cdel.classList.contains('on'))) { e.preventDefault(); closeMenus(); cdel.classList.remove('on'); ta.focus(); return; }
    if (e.key === 'Escape') { e.preventDefault(); if (formOn) closeForm(true); else if (e.target.classList.contains('qrt')) { revise(false); ta.focus(); } else if (e.target.closest('.cq')) ta.focus(); else host.close(); }
    else if (enter && e.target === nt && !e.shiftKey) { e.preventDefault(); start(); }
    else if (enter && e.target.classList.contains('qother')) { e.preventDefault(); submit(); }
    else if (enter && !e.shiftKey && e.target.classList.contains('qrt')) { e.preventDefault(); plan('revise'); }
  });
  ta.addEventListener('keydown', e => {
    e.stopPropagation();   // the sphere's arrow / Enter keys stay out of the box
    if (popKey(e)) { e.preventDefault(); return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    else if (e.key === 'Escape') { e.preventDefault(); if (menuOpen()) closeMenus(); else if (cdel.classList.contains('on')) cdel.classList.remove('on'); else host.close(); }
  });
  root.addEventListener('mousedown', e => { host.needKeys(); if (document.activeElement !== ta && !formOn && !e.target.closest('.cq, .cti, .cdel')) setTimeout(() => cur && ta.focus(), 100); });   // a focus lost to another app comes back with a click
  root.addEventListener('click', e => {
    const a = e.target.closest('[data-a]') && e.target.closest('[data-a]').dataset.a;
    if (a === 'close') host.close(); else if (a === 'send') { send(); ta.focus(); } else if (a === 'stop') { stop(); ta.focus(); } else if (a === 'new') openForm(); else if (a === 'start') start(); else if (a === 'cancel') closeForm(true);
    else if (a === 'claude' && cur) { const s = cur; close(); host.openClaude(s); }
    else if (a === 'mode' && cur && !acting) modeMenu();
    else if (a === 'more' && cur && !acting) moreMenu();
    else if (a === 'term' && cur && !acting) act('Terminal', s => window.sphere.consoleAct(s.sessionId, 'terminal'), r => { why.textContent = 'Opened ' + (r.out || 'a terminal') + ' in the session’s folder'; });
    else if (a === 'prev' && cur && !acting) previewMenu();
    else if (a === 'delno') { cdel.classList.remove('on'); ta.focus(); }
    else if (a === 'delyes') { cdel.classList.remove('on'); const f = yesDo; yesDo = null; if (f && yesFor === cur) f(); }
  });
  addEventListener('focus', () => { if (cur && !formOn && document.activeElement === document.body) ta.focus(); });

  function open(s, hit) {   // hit: a search hit { uuid, off } to show
    if (cur && !cur.blank) draftNow(cur);   // opened over another (or the same) session: its draft is kept
    if (formOn) { formOn = false; formTok++; starting = false; }   // closeForm would close the card when the form stood alone
    root.classList.remove('nw', 'blank', 'rn'); cdel.classList.remove('on'); yesDo = null; closeMenus();
    root.classList.toggle('nolink', !(s && s.link));   // a built-in reader session: no place in the Claude app to open
    cur = s; held = []; at = new Map(); from = 0; key = ''; aw = null; goAt = hit && typeof hit.uuid === 'string' ? { uuid: hit.uuid, off: +hit.off || 0 } : null; setPending(null);
    title.textContent = s.title || ''; why.textContent = ''; ta.value = ''; grow(); loadMode(s); clearAtts(); draftLoad(s); popClose(); files = null; setTab('chat');
    list.replaceChildren(Object.assign(document.createElement('div'), { className: 'empty', textContent: 'Loading…' }));
    root.style.display = 'flex';
    host.needKeys(); setTimeout(() => cur === s && ta.focus(), 150);
    window.sphere.consoleOpen(s.sessionId).then(r => { if (cur !== s) return; if (r && r.ok) { if (r.awaiting === true || r.awaiting === false) { aw = r.awaiting; schedTool(); } if (r.title && !s.title) title.textContent = s.title = r.title; if (r.link && !s.link) s.link = r.link; } if (!r || !r.ok) list.replaceChildren(Object.assign(document.createElement('div'), { className: 'empty', textContent: (r && r.why) || 'Could not open this session' })); }, () => {});
  }
  // the New session form with no conversation behind it (the "+ New session" tile); Cancel / Esc close the card
  function openNew(folder) {   // folder: picked in the form when it is there
    if (cur) close();
    cur = { sessionId: '', title: 'New session', blank: true }; held = []; at = new Map(); from = 0; key = ''; aw = null; setPending(null);
    title.textContent = 'New session'; why.textContent = ''; list.replaceChildren(); root.classList.add('blank'); root.style.display = 'flex';
    host.needKeys(); openForm(typeof folder === 'string' ? folder : '');
  }
  function close() {
    if (!cur) return false;
    if (!cur.blank) draftNow(cur);
    const wasBlank = !!cur.blank; root.classList.remove('blank');
    if (wasBlank) { formOn = false; formTok++; root.classList.remove('nw'); }   // closeForm would close the card again
    closeForm(); setPending(null); popClose(); setTab('chat'); cur = null; goAt = null; root.style.display = 'none'; closeMenus(); det.clear(); detSize.clear(); detBytes = 0; lb.classList.remove('on'); clearAtts(); cdel.classList.remove('on'); root.classList.remove('rn'); acting = false; list.replaceChildren(); held = []; at = new Map();
    if (!wasBlank) window.sphere.consoleClose().catch(() => {});
    return true;
  }
  // x, y, w, h in window pixels; set only when they change
  function place(x, y, w, h) {
    const k = [x, y, w, h].map(Math.round).join('|'); if (k === key) return; key = k;
    Object.assign(root.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
  }
  // a feed (new ideas 4): the Tasks tab shows a dot while this session has background tasks running
  function feed(f) {
    const s = cur && f.sessions.find(x => String(x.sessionId) === cur.sessionId), n = (s && s.bg) || 0, b = q('[data-tab=tasks]');
    curAct = (s && s.activity) || '';
    b.classList.toggle('bgon', n > 0); b.title = n ? `${n} background task${n > 1 ? 's' : ''} running` : '';
  }
  // App control off: read-only (no reply box, questions, new session, mode, rename / fork / rewind)
  let appOn = true;
  function setAppControl(on) { appOn = !!on; root.classList.toggle('noapp', !appOn); }
  return { open, openNew, close, place, feed, setAppControl, get on() { return !!cur; }, get session() { return cur; } };
}
