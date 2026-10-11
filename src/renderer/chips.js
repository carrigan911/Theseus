// Session settings on a tile (Docs/Specs/SessionConsole_Stage4_Spec.md, Q1): a right-click on a session tile opens a small bar
// at the tile with three chips, Model / Effort / Mode. A chip opens its menu (the Claude app's choices; fast mode is a switch in
// the model menu) and a pick changes that session in the app (consoleSet), then the chips show what the app reports.
// Esc, a click outside or a fold closes it. Values come from consoleSettings (feed + transcript), so opening it visits nothing.
export const MODELS = ['Opus 5.5', 'Fable 5.1', 'Sonnet 5.5', 'Haiku 5.5'];
export const EFFORTS = ['Low', 'Medium', 'High', 'Extra', 'Max', 'Ultracode'];
export const MODES = ['Auto', 'Manual', 'Accept edits', 'Plan', 'Bypass permissions'];
const el = (tag, cls, text) => { const d = document.createElement(tag); if (cls) d.className = cls; if (text != null) d.textContent = text; return d; };

// a menu of choices under (or over) an anchor element: items [{ label, on, sub }] or a 'switch' item; pick(label) -> Promise
// shared by the chip bar and the console header
export function dropMenu(anchor, items, pick) {
  closeMenus();
  const m = el('div', 'cmenu'); m.setAttribute('role', 'menu');
  for (const it of items) {
    const b = el('button', 'cmi' + (it.on ? ' on' : '') + (it.sw ? ' sw' : ''));
    b.append(el('span', 'cmc', it.sw ? (it.on ? '●' : '○') : it.on ? '✓' : ''), el('span', 'cml', it.label));
    if (it.sub) b.append(el('span', 'cms', it.sub));
    b.onclick = e => { e.stopPropagation(); closeMenus(); pick(it); };
    m.append(b);
  }
  m.addEventListener('click', e => e.stopPropagation());
  document.body.append(m);
  const r = anchor.getBoundingClientRect(), h = m.offsetHeight, w = m.offsetWidth;
  m.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left)) + 'px';
  m.style.top = (r.bottom + 4 + h < innerHeight - 8 ? r.bottom + 4 : Math.max(8, r.top - 4 - h)) + 'px';
  return m;
}
export function closeMenus() { document.querySelectorAll('.cmenu').forEach(m => m.remove()); }
export const menuOpen = () => !!document.querySelector('.cmenu');

export function createChips() {
  const bar = el('div'); bar.id = 'chips'; document.body.append(bar);
  let cur = null, val = null, tok = 0, busy = '';
  const note = el('span', 'chn');
  function chip(what, label) {
    const b = el('button', 'chip'); b.dataset.w = what;
    b.append(el('span', 'chk', label), el('span', 'chv', '…'), el('span', 'cha', '▾'));
    b.onclick = e => { e.stopPropagation(); if (val && !busy) menu(what, b); };
    return b;
  }
  const chips = [chip('model', 'Model'), chip('effort', 'Effort'), chip('mode', 'Mode')];
  const head = el('span', 'cht');
  // session management (SessionManagement_Spec): a Queue chip with park / resume / queue order / swap, shown while it is on
  let manageOn = false;
  const qChip = el('button', 'chip'); qChip.append(el('span', 'chk', 'Queue'), el('span', 'chv', ''), el('span', 'cha', '▾'));
  qChip.onclick = e => { e.stopPropagation(); if (cur) qMenu(qChip); };
  function qMenu(b) {
    const parked = cur.group === 'Parked', items = parked
      ? [{ label: 'Resume now', act: 'resume' }, { label: 'First in the queue', act: 'first' }, { label: 'Last in the queue', act: 'last' }]
      : [{ label: 'Park', act: 'park', sub: 'checkpoint, commit, stop' }, { label: 'Swap now', act: 'swap', sub: 'by the swap method in settings' }, { label: 'Swap to a new session', act: 'swapnew', sub: 'fresh session from the checkpoint' }, { label: "Don't swap", act: 'noswap', sub: 'until its next line' }];
    dropMenu(b, items, async it => {
      const t = tok; note.textContent = 'Working…'; note.className = 'chn';
      const r = await window.sphere.manage({ act: it.act, id: cur.sessionId }).catch(e => ({ ok: false, why: e.message }));
      if (t !== tok) return;
      note.textContent = r && r.ok ? 'Done' : (r && r.why) || 'not done'; note.className = r && r.ok ? 'chn' : 'chn bad';
    });
  }
  bar.append(head, ...chips, qChip, note);
  function show() {
    for (const b of chips) {
      const w = b.dataset.w, v = val ? val[w] || '?' : '…';
      b.querySelector('.chv').textContent = w === 'model' && val && val.fast ? v + ' ⚡' : v;
      b.classList.toggle('busy', busy === w);
    }
  }
  function menu(what, b) {
    const L = what === 'model' ? MODELS : what === 'effort' ? EFFORTS : MODES, now = val[what];
    const items = L.map(x => ({ label: x, value: x, what, on: now === x }));
    if (what === 'model') items.push({ label: 'Fast mode', what: 'fast', value: !val.fast, on: !!val.fast, sw: true });
    if (what === 'mode') items.forEach(it => { if (it.value === 'Bypass permissions') it.sub = 'no prompts at all'; });
    dropMenu(b, items, it => set(it.what, it.value));
  }
  async function set(what, value) {
    if (!cur || (what !== 'fast' && val[what] === value)) return;
    const id = cur.sessionId, t = tok; busy = what === 'fast' ? 'model' : what; note.textContent = 'Changing it in Claude…'; note.className = 'chn'; show();
    const r = await window.sphere.consoleSet(id, what, value).catch(e => ({ ok: false, why: e.message }));
    if (t !== tok) return;
    busy = '';
    if (r && r.ok) { val = r; note.textContent = ''; } else { note.textContent = (r && r.why) || 'not changed'; note.className = 'chn bad'; }
    show();
  }
  // s: the session (feed entry); x, y: where the right-click was (the bar sits just under it, kept on screen)
  async function open(s, x, y) {
    close(); cur = s; const t = ++tok; val = null; busy = ''; note.textContent = ''; note.className = 'chn';
    head.textContent = s.title || ''; head.title = s.title || '';
    qChip.style.display = manageOn ? '' : 'none'; qChip.querySelector('.chv').textContent = s.group || '';
    show(); bar.style.display = 'flex';
    const w = bar.offsetWidth, h = bar.offsetHeight;
    bar.style.left = Math.max(8, Math.min(innerWidth - w - 8, x - w / 2)) + 'px';
    bar.style.top = (y + 14 + h < innerHeight - 8 ? y + 14 : Math.max(8, y - 14 - h)) + 'px';
    const r = await window.sphere.consoleSettings(s.sessionId).catch(() => null);
    if (t !== tok) return;
    if (r && r.ok) val = r; else { val = { model: '', effort: '', mode: '' }; note.textContent = (r && r.why) || 'settings unknown'; note.className = 'chn bad'; }
    show();
  }
  function close() {
    if (!cur) return false;
    cur = null; val = null; tok++; closeMenus(); bar.style.display = 'none';
    return true;
  }
  bar.addEventListener('click', e => e.stopPropagation());
  bar.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); });
  return { open, close, setManage: v => { manageOn = !!v; }, get on() { return !!cur; }, contains: n => bar.contains(n) || !!(n.closest && n.closest('.cmenu')) };
}
