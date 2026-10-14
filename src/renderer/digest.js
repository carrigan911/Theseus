// The digest card (Autonomy part 4b): what happened since a time (the night, or "what happened"): commits per project, swaps,
// backlog tasks, stalls, limit hits, away alerts, and what waits on the user now. Esc or a click beside it closes.
const esc = t => String(t ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const when = t => new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
export function createDigest({ rect, close }) {
  const el = document.createElement('div'); el.id = 'dig'; el.className = 'bcard'; el.tabIndex = -1; document.body.appendChild(el);
  let on = false;
  const sec = (h, items) => items.length ? `<div class="dh">${esc(h)}</div><div class="dl">${items.map(x => `<div>${x}</div>`).join('')}</div>` : '';
  function show(d) {
    on = true;
    const proj = (d.projects || []).map(p => `<b>${esc(p.name)}</b> <small>${p.commits.length}</small><ul>${p.commits.slice(0, 8).map(c => `<li>${esc(c)}</li>`).join('')}${p.commits.length > 8 ? `<li class="mo">+${p.commits.length - 8} more</li>` : ''}</ul>`);
    const now = [...(d.waiting || []).map(t => `${esc(t)} <small>waits on you</small>`), ...(d.stuckNow || []).map(t => `${esc(t)} <small>stuck</small>`)];
    el.innerHTML = `<div class="h">Digest <small>since ${esc(when(d.since))}</small></div><div class="dline">${esc(d.line || '')}</div><div class="bs">` +
      sec('Needs you now', now) + sec('While you were away', (d.alerts || []).map(a => `${esc(a.title)} <small>${esc(a.why)}, ${esc(when(a.at))}</small>`)) + sec('Swaps', (d.swaps || []).map(esc)) +
      sec('Backlog', [...(d.tasksDone || []).map(t => `${esc(t)} <small>done</small>`), ...(d.tasksStarted || []).filter(t => !(d.tasksDone || []).includes(t)).map(t => `${esc(t)} <small>started</small>`)]) +
      sec('Stalls', [...(d.nudges ? [`${d.nudges} nudge${d.nudges === 1 ? '' : 's'}`] : []), ...(d.stuck || []).map(t => `${esc(t)} <small>stuck</small>`)]) +
      sec('Limits', (d.limits || []).map(esc)) + sec('Commits', proj) +
      `</div>`;
    place();
  }
  function place() {
    if (!on) return;
    const f = rect(); Object.assign(el.style, { display: 'flex', left: f.x + 'px', top: f.y - 36 + 'px', width: f.w + 'px', height: f.h + 36 + 'px' });
  }
  el.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  return {
    get on() { return on; }, show, place,
    close() { if (!on) return false; on = false; el.style.display = 'none'; return true; },
  };
}
