// The backlog card (Autonomy part 3): the waiting tasks in order with Start now / up / down / Remove, and a form to add one
// (project folder, task text, night only). Opened from a Backlog tile or Settings' "Open the backlog"; Esc or a click beside it closes.
const esc = t => String(t ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export function createBacklog({ needKeys, rect, close }) {
  const el = document.createElement('div'); el.id = 'blog'; el.className = 'bcard'; document.body.appendChild(el);
  let on = false, data = null, why = '', pick = null;
  const act = a => window.sphere.manage(a);
  async function load() { data = await act({ act: 'backlog-list' }).catch(() => null); draw(); }
  function draw() {
    if (!on) return;
    const d = data || { tasks: [], folders: [] }, ts = (d.tasks || []).filter(t => t.state !== 'done');
    const keep = el.querySelector('.bt') && { folder: el.querySelector('.bf').value, text: el.querySelector('.bt').value, night: el.querySelector('.bn').checked };
    const row = (t, i) => `<div class="bi${t.state === 'started' ? ' st' : ''}${t.id === pick ? ' on' : ''}" data-id="${esc(t.id)}"><div class="bx"><span class="bl">${esc(t.text)}</span>` +
      `<small>${esc(t.folder)}${t.nightOnly ? ' · night only' : ''}${t.state === 'started' ? ' · started' : ''}${t.retryAt > Date.now() ? ' · retry after a failed start' : ''}</small></div>` +
      (t.state === 'waiting' ? `<button data-a="start" title="Start it now, whatever the cap">Start now</button><button data-a="up" title="Up"${i ? '' : ' disabled'}>↑</button><button data-a="down" title="Down">↓</button>` : '') +
      `<button data-a="drop" title="Remove">✕</button></div>`;
    el.innerHTML = `<div class="h">Backlog</div>` +
      (d.on ? '' : '<div class="bw">The backlog is off (Settings &gt; Session Management &gt; Task backlog): tasks wait here but do not start by themselves.</div>') +
      (d.on && !d.appControl ? '<div class="bw">App control is off: nothing can be started.</div>' : '') +
      `<div class="bs">${ts.length ? ts.map(row).join('') : '<div class="be">No tasks. Add one below, or tell Theseus "later: in &lt;project&gt;, &lt;task&gt;".</div>'}</div>` +
      `<div class="ba"><select class="bf">${(d.folders || []).map(f => `<option>${esc(f)}</option>`).join('')}</select>` +
      `<textarea class="bt" rows="3" placeholder="The task, as its first message" spellcheck="false"></textarea>` +
      `<div class="bb"><label><input type="checkbox" class="bn"> Night only</label><span class="by">${esc(why)}</span><button class="go" data-a="add">Add</button></div></div>`;
    if (keep) { el.querySelector('.bf').value = keep.folder; el.querySelector('.bt').value = keep.text; el.querySelector('.bn').checked = keep.night; }
    place();
  }
  function place() {
    if (!on) return;
    const f = rect(); Object.assign(el.style, { display: 'flex', left: f.x + 'px', top: f.y - 36 + 'px', width: f.w + 'px', height: f.h + 36 + 'px' });
  }
  el.addEventListener('click', async e => {
    const b = e.target.closest('button[data-a]'); if (!b) return;
    const a = b.dataset.a, id = b.closest('.bi')?.dataset.id; why = '';
    let r;
    if (a === 'add') {
      const text = el.querySelector('.bt').value.trim(), folder = el.querySelector('.bf').value;
      if (!text) { why = 'Type the task first.'; draw(); return; }
      r = await act({ act: 'backlog-add', folder, text, nightOnly: el.querySelector('.bn').checked });
      if (r && r.ok) el.querySelector('.bt').value = '';
    } else if (a === 'start') { b.disabled = true; r = await act({ act: 'backlog-start', task: id }); }
    else if (a === 'up' || a === 'down') { pick = id; r = await act({ act: 'backlog-move', task: id, where: a }); }
    else if (a === 'drop') r = await act({ act: 'backlog-drop', task: id });
    if (r && !r.ok) why = r.why || 'Failed'; else if (a === 'start' && r) why = `Started: ${r.title || ''}`;
    load();
  });
  el.addEventListener('pointerdown', e => { if (e.target.matches('textarea, select')) needKeys(); });   // typing needs the window's focus
  el.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); close(); return; } if (e.key === 'Enter' && e.ctrlKey && e.target.matches('.bt')) el.querySelector('[data-a="add"]').click(); });
  return {
    get on() { return on; },
    open(id) { on = true; pick = id || null; why = ''; el.innerHTML = ''; load(); },
    close() { if (!on) return false; on = false; el.style.display = 'none'; return true; },
    refresh() { if (on) load(); },   // a feed tick (a task started or was added by voice)
    place,
  };
}
