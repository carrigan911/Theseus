// Bridge_Spec: the native side of the last Claude-only steps. A terminal in the session's folder, the session's local preview
// addresses, a file in your editor, the MCP servers Claude Code loads for a folder (and the project's on / off lists), and
// the local routines' prompts. Paths come from main (the session's folder), never from a page; nothing here runs a shell.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const P = require('./paths');

const start = (exe, args, cwd) => new Promise(res => {
  let p; try { p = spawn(exe, args, { cwd, detached: true, stdio: 'ignore', windowsHide: false }); } catch (e) { return res({ ok: false, why: e.message }); }
  p.once('error', e => res({ ok: false, why: e.code === 'ENOENT' ? `${path.basename(exe)} was not found` : e.message }));
  p.once('spawn', () => { p.unref(); res({ ok: true }); });
});
const isDir = d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } };

// ---- Terminal: a Windows Terminal tab in the folder (wt is an app alias in WindowsApps), else PowerShell in its own window
async function terminal(dir) {
  if (!isDir(dir)) return { ok: false, why: 'the session folder was not found' };
  const wt = [P.onPath('wt.exe'), process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'wt.exe')].find(f => f && fs.existsSync(f));
  if (wt) { const r = await start(wt, ['-w', '0', 'nt', '-d', dir], dir); if (r.ok) return { ok: true, out: 'Windows Terminal' }; }
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const r = await start(ps, ['-NoExit', '-NoLogo'], dir);
  return r.ok ? { ok: true, out: 'PowerShell' } : r;
}

// ---- Preview: local addresses the session's commands printed (newest first), and .claude/launch.json configurations
const LOCAL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::\d{2,5})?(?:\/[^\s"'<>)\]\\`]*)?/gi;
const isLocal = u => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) && ['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(x.hostname); } catch { return false; } };
async function previews(file, dir) {
  const seen = new Map();
  try {   // the last 2 MB of the transcript: tool results and the session's own lines
    const fh = await fs.promises.open(file, 'r');
    try {
      const { size } = await fh.stat(), n = Math.min(size, 2 << 20), buf = Buffer.alloc(n);
      await fh.read(buf, 0, n, size - n);
      const t = buf.toString('utf8').replace(/\\n/g, ' ').replace(/\\u001b\[[0-9;]*m/g, '');
      for (const m of t.matchAll(LOCAL)) { const u = m[0].replace(/0\.0\.0\.0/, 'localhost').replace(/[.,;:]+$/, ''); seen.delete(u); seen.set(u, 1); }
    } finally { await fh.close(); }
  } catch {}
  const items = [...seen.keys()].reverse().slice(0, 8).map(u => ({ label: u, url: u, from: 'session' }));
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'launch.json'), 'utf8'));
    for (const c of (j && j.configurations) || []) {
      const port = Number(c && c.port); if (!(port > 0 && port < 65536)) continue;
      const url = `http://localhost:${port}/`;
      if (!items.some(x => x.url.replace(/\/$/, '') === url.replace(/\/$/, ''))) items.push({ label: `${String(c.name || 'launch').slice(0, 60)} (port ${port})`, url, from: 'launch.json' });
    }
  } catch {}
  return { ok: true, items };
}

// ---- Files: open in the editor setting (system default, VS Code at the line, or a command with {file} and {line})
function splitCmd(s) {   // "C:\x y\e.exe" -n{line} "{file}" -> [exe, ...args]
  const out = []; let cur = '', q = false, any = false;
  for (const ch of String(s || '')) {
    if (ch === '"') { q = !q; any = true; continue; }
    if (!q && /\s/.test(ch)) { if (cur || any) out.push(cur); cur = ''; any = false; continue; }
    cur += ch;
  }
  if (cur || any) out.push(cur);
  return out;
}
function vscode() {
  const c = [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft VS Code', 'Code.exe')];
  return c.find(f => f && fs.existsSync(f)) || '';
}
async function openFile(root, rel, line, how, cmd, shell) {
  const f = inside(root, rel); if (!f) return { ok: false, why: 'bad path' };
  if (!fs.existsSync(f)) return { ok: false, why: 'the file was not found' };
  const ln = Math.max(1, Math.floor(Number(line) || 1));
  if (how === 'vscode') { const c = vscode(); if (c) return start(c, ['-g', `${f}:${ln}`], root); }
  if (how === 'custom' && cmd) {
    const [exe, ...args] = splitCmd(cmd); if (!exe || !path.isAbsolute(exe)) return { ok: false, why: 'the editor command needs the full path of its program' };
    return start(exe, args.length ? args.map(a => a.replace(/\{file\}/g, f).replace(/\{line\}/g, String(ln))) : [f], root);
  }
  const e = await shell.openPath(f); return e ? { ok: false, why: e } : { ok: true };
}
// a path inside the folder (no climbing out, no absolute paths), or null
function inside(root, rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 1000 || /^[\\/]|^[a-z]:/i.test(rel)) return null;
  const f = path.resolve(root, rel), r = path.resolve(root);
  return f === r || f.toLowerCase().startsWith(r.toLowerCase() + path.sep) ? f : null;
}

// ---- MCP: what Claude Code loads in this folder. User and local scope come from ~/.claude.json (read only); project scope
// from .mcp.json, switched on / off per project by .claude/settings(.local).json's enabled / disabled lists
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };
const kindOf = c => !c || typeof c !== 'object' ? '' : c.type || (c.url ? 'http' : c.command ? 'stdio' : '');
function mcpList(dir) {
  const home = readJson(path.join(os.homedir(), '.claude.json')) || {}, out = [];
  const proj = home.projects && (home.projects[dir] || home.projects[dir.replace(/\\/g, '/')] || Object.entries(home.projects).find(([k]) => path.resolve(k).toLowerCase() === path.resolve(dir).toLowerCase())?.[1]);
  for (const [n, c] of Object.entries(home.mcpServers || {})) out.push({ name: n, scope: 'user', kind: kindOf(c), on: true, fixed: true });
  for (const [n, c] of Object.entries((proj && proj.mcpServers) || {})) out.push({ name: n, scope: 'local', kind: kindOf(c), on: true, fixed: true });
  const mj = readJson(path.join(dir, '.mcp.json')), sh = readJson(path.join(dir, '.claude', 'settings.json')) || {}, lo = readJson(path.join(dir, '.claude', 'settings.local.json')) || {};
  const en = new Set([...(sh.enabledMcpjsonServers || []), ...(lo.enabledMcpjsonServers || [])]), dis = new Set([...(sh.disabledMcpjsonServers || []), ...(lo.disabledMcpjsonServers || [])]);
  const all = lo.enableAllProjectMcpServers ?? sh.enableAllProjectMcpServers;
  for (const [n, c] of Object.entries((mj && mj.mcpServers) || {})) out.push({ name: n, scope: 'project', kind: kindOf(c), on: !dis.has(n) && (all === true || en.has(n)), asked: !dis.has(n) && !en.has(n) && all !== true, fixed: false });
  return { ok: true, items: out, note: 'A change applies to the next session started in this folder.' };
}
// switch one .mcp.json server for this project in .claude/settings.local.json (re-read just before writing; other keys kept)
function mcpSet(dir, name, on) {
  const mj = readJson(path.join(dir, '.mcp.json'));
  if (!mj || !mj.mcpServers || !Object.prototype.hasOwnProperty.call(mj.mcpServers, name)) return { ok: false, why: 'not a project server' };
  const f = path.join(dir, '.claude', 'settings.local.json');
  let j = {};
  if (fs.existsSync(f)) { j = readJson(f); if (!j || typeof j !== 'object' || Array.isArray(j)) return { ok: false, why: 'settings.local.json could not be read' }; }
  const add = (k, v) => { j[k] = [...new Set([...(Array.isArray(j[k]) ? j[k] : []), v])]; }, del = (k, v) => { if (Array.isArray(j[k])) j[k] = j[k].filter(x => x !== v); };
  if (on) { add('enabledMcpjsonServers', name); del('disabledMcpjsonServers', name); } else { add('disabledMcpjsonServers', name); del('enabledMcpjsonServers', name); }
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.sphere-tmp'; fs.writeFileSync(tmp, JSON.stringify(j, null, 2) + '\n'); fs.renameSync(tmp, f);
  return { ok: true };
}

// ---- Routines: the local prompts, ~/.claude/scheduled-tasks/<name>/SKILL.md
const TASKS = () => path.join(os.homedir(), '.claude', 'scheduled-tasks');
const taskFile = n => typeof n === 'string' && /^[\w.-]{1,100}$/.test(n) && !/^\.+$/.test(n) ? path.join(TASKS(), n, 'SKILL.md') : null;
function routines() {
  const out = [];
  try {
    for (const d of fs.readdirSync(TASKS(), { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const f = taskFile(d.name); if (!f) continue;
      let t = ''; try { t = fs.readFileSync(f, 'utf8'); } catch { continue; }
      const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(t), get = k => fm && (new RegExp('^' + k + ':\\s*(.*)$', 'm').exec(fm[1]) || [])[1];
      out.push({ id: d.name, name: (get('name') || d.name).trim(), description: (get('description') || '').trim() });
    }
  } catch {}
  return { ok: true, items: out };
}
function routineRead(id) { const f = taskFile(id); if (!f) return { ok: false, why: 'bad name' }; try { return { ok: true, text: fs.readFileSync(f, 'utf8') }; } catch { return { ok: false, why: 'not found' }; } }
function routineSave(id, text) {
  const f = taskFile(id); if (!f || !fs.existsSync(f)) return { ok: false, why: 'not found' };
  if (typeof text !== 'string' || !text.trim() || text.length > 200000) return { ok: false, why: 'empty' };
  const tmp = f + '.sphere-tmp'; fs.writeFileSync(tmp, text); fs.renameSync(tmp, f);
  return { ok: true };
}

module.exports = { terminal, previews, isLocal, openFile, inside, mcpList, mcpSet, routines, routineRead, routineSave, splitCmd };
