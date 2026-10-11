// Built-in session reader (PublicVersion_Spec): Claude Code's own session files (transcriptsRoot/<project>/<id>.jsonl) as a
// feed-shaped object, used when there is no manager feed. Only each file's head and tail are read, cached by mtime + size.
//   scan({ days, max }) -> { sessions: [{ sessionId, title, model, group, folder, transcript, reader: true }], reader: true }
const fs = require('fs');
const path = require('path');
const P = require('./paths');

const HEAD = 65536, TAIL = 262144;
const cache = new Map();   // file -> { m, size, info }

function chunk(fd, pos, len) { const b = Buffer.alloc(len); const n = fs.readSync(fd, b, 0, len, pos); return b.toString('utf8', 0, n); }
const lines = t => t.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const modelName = id => { const m = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(id || ''); return m ? m[1][0].toUpperCase() + m[1].slice(1) + ' ' + m[2] + '.' + m[3] : (id || ''); };
const folderOf = cwd => cwd ? path.basename(String(cwd).replace(/[\\/]\.claude[\\/]worktrees[\\/].*$/i, '').replace(/[\\/]+$/, '')) : '';
function firstText(j) {
  const c = j && j.message && j.message.content;
  const t = typeof c === 'string' ? c : Array.isArray(c) ? ((c.find(x => x && x.type === 'text') || {}).text || '') : '';
  return t.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// one transcript -> { cwd, title, model } from its head (cwd, first prompt) and tail (latest custom title / summary, model)
function info(file, st) {
  const c = cache.get(file);
  if (c && c.m === st.mtimeMs && c.size === st.size) return c.info;
  let fd, head = [], tail = [];
  try {
    fd = fs.openSync(file, 'r');
    head = lines(chunk(fd, 0, Math.min(HEAD, st.size)));
    if (st.size > HEAD) tail = lines(chunk(fd, Math.max(HEAD, st.size - TAIL), Math.min(TAIL, st.size - HEAD)));
  } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  const all = head.concat(tail);
  let cwd = '', title = '', summary = '', prompt = '', model = '';
  for (const j of all) {
    if (!cwd && j.cwd) cwd = j.cwd;
    if (j.type === 'custom-title' && j.customTitle) title = String(j.customTitle);
    if (j.type === 'summary' && j.summary) summary = String(j.summary);
    if (!prompt && j.type === 'user' && !j.isMeta) { const t = firstText(j); if (t && !t.startsWith('[Request interrupted')) prompt = t; }
    if (j.type === 'assistant' && j.message && j.message.model && j.message.model !== '<synthetic>') model = j.message.model;
  }
  const out = { cwd, title: title || summary || (prompt.length > 60 ? prompt.slice(0, 57) + '…' : prompt) || path.basename(file, '.jsonl').slice(0, 8), model: modelName(model) };
  cache.set(file, { m: st.mtimeMs, size: st.size, info: out });
  return out;
}

function scan(o = {}) {
  const days = o.days || 7, max = o.max || 60, root = P.transcripts(), since = Date.now() - days * 864e5, found = [];
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { return { sessions: [], reader: true }; }
  for (const d of dirs) {
    let files = [];
    try { files = fs.readdirSync(path.join(root, d.name)).filter(f => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const file = path.join(root, d.name, f);
      let st; try { st = fs.statSync(file); } catch { continue; }
      if (st.mtimeMs >= since && st.size > 0) found.push({ file, st });
    }
  }
  found.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  const sessions = [];
  for (const { file, st } of found.slice(0, max)) {
    const i = info(file, st); if (!i) continue;
    sessions.push({ sessionId: path.basename(file, '.jsonl'), title: i.title, model: i.model, folder: folderOf(i.cwd) || null, cwd: i.cwd || null, transcript: file, reader: true,
      group: Date.now() - st.mtimeMs < 864e5 ? 'Active' : 'Ungrouped' });   // touched in the last day = Active
  }
  for (const k of cache.keys()) if (!found.some(x => x.file === k)) cache.delete(k);
  return { sessions, reader: true };
}
module.exports = { scan };
