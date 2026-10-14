// Project creator (Docs/Specs/ProjectCreator_Spec.md): a new project manager = config entry + folder + checkpoint + manager prompt.
// The config is shared with the Theseus scripts (project_managers.json): keep every other key, write atomically, UTF-8 without BOM.
'use strict';
const fs = require('fs');
const path = require('path');
const PP = require('./privpaths');
const cp = require('child_process');

const CONFIG = () => process.env.SPHERE_PM_CONFIG || PP.data + '/project_managers.json';
const PROMPT = () => process.env.SPHERE_PM_PROMPT || PP.mgr + '/project_manager_prompt.md';
const ID_DIR = () => path.dirname(CONFIG());
const BEAT_DIR = () => process.env.SPHERE_PM_BEATS || path.join(ID_DIR(), 'waiters');
const WAITER = () => process.env.SPHERE_PM_WAITER || PP.mgr + '/coordinator_wait.ps1';

function read() { return JSON.parse(fs.readFileSync(CONFIG(), 'utf8').replace(/^\uFEFF/, '')); }
function write(j) { const f = CONFIG(), t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(j, null, 2) + '\n', 'utf8'); fs.renameSync(t, f); }
const slugOf = n => String(n).toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24);
const clean = n => String(n || '').trim().replace(/\s+/g, ' ');

function list() { try { return read().projects || []; } catch { return []; } }

// the entry for `name` in `folder`; no disk writes
function entryOf(name, folder) {
  const s = slugOf(name), f = path.resolve(folder), proj = clean(name).replace(/\s+/g, '');
  return {
    project: clean(name).replace(/\s+/g, ''), managerTitle: `${clean(name)} manager`, cwd: f,
    sessionCwdFilter: [f + '*'], excludeTitles: [`${clean(name)} manager`], usageSharePct: 0, model: 'claude-sonnet-5-5',
    checkpoint: path.join(f, '.claude', 'checkpoints', `mgr-${s}.md`), idFile: path.join(ID_DIR(), `mgr_${s}_id.txt`),
    section: `${clean(name)} manager`, cutover: true,
    // per-project waiter (ManagerMcpTools_Spec Round 2): coordinator_wait.ps1 keeps <beatFile> fresh; waiter_watch.ps1 nudges the manager when it goes stale
    waiterState: path.join(ID_DIR(), `coordinator_state_${proj}.json`), beatFile: path.join(BEAT_DIR(), `coord_${proj}.beat`),
  };
}

// the exact command line the manager runs as its ONE background task
const waiterCmd = e => `powershell -NoProfile -ExecutionPolicy Bypass -File ${WAITER()} -Match "${path.basename(e.cwd)}" -State ${e.waiterState}`;

function checkpointFor(e) {
  return `## Now
- State: project created by the Theseus app; manager starting (cutover=true).
- Waiter: ${waiterCmd(e)} (ONE run_in_background task; heartbeat ${e.beatFile}, a dead waiter is nudged to you by waiter_watch: restart it, end the turn).
- Next: on COORD_DUE follow project_manager_prompt.md duty 2.
- Blocker: none. Id file: ${e.idFile}
- Queue: (none yet)

Project: ${e.project} (cwd ${e.cwd}). Config entry: "${e.project}" in project_managers.json. Share 0% until Theseus sets one.
Rules: keep ## Now at most 6 lines, rewritten in place; file under 15 KB; old detail to mgr-${slugOf(e.project)}.archive.md; commit this file after each change.
`;
}

// the first heartbeat: "exited" now, so waiter_watch gives the manager 15 minutes to start its waiter before nudging
function writeBeat(e) { fs.mkdirSync(path.dirname(e.beatFile), { recursive: true }); fs.writeFileSync(e.beatFile, JSON.stringify({ state: 'exited', at: new Date().toISOString().slice(0, 19), pid: 0 }), 'utf8'); }

// the manager's first message: the generic prompt with its placeholders filled in
function promptFor(e) {
  let t = fs.readFileSync(PROMPT(), 'utf8');
  const m = { MANAGER_TITLE: e.managerTitle, PROJECT: e.project, CWD: e.cwd, SECTION: e.section, ID_FILE: e.idFile, TRANSCRIPT_MATCH: path.basename(e.cwd) };
  for (const k of Object.keys(m)) t = t.split(`<${k}>`).join(m[k]);
  return t;
}

// idempotent: each piece is skipped when already there. Returns { ok, entry, made: [..], why }
// the claude-tools MCP (swap, wait, commit tools the swap hooks name first; SwapFixesIntoPrograms_Spec 10-14): a new project's
// .mcp.json gets the live entry from the Titans project (copied at creation, so it is always the current one); kept if there
const CT_SOURCE = () => process.env.SPHERE_CT_SOURCE || PP.ctSource;
function addClaudeTools(dir) {
  let src; try { src = JSON.parse(fs.readFileSync(CT_SOURCE(), 'utf8').replace(/^\uFEFF/, '')).mcpServers['claude-tools']; } catch { return false; }
  if (!src) return false;
  const f = path.join(dir, '.mcp.json'); let j = {};
  if (fs.existsSync(f)) { try { j = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return false; } }   // (never overwrite a file it cannot read)
  j.mcpServers = j.mcpServers || {};
  if (j.mcpServers['claude-tools']) return false;
  j.mcpServers['claude-tools'] = src; fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n', 'utf8'); return true;
}

function create(name, folder, resume) {
  name = clean(name);
  if (!/^[\w][\w .-]{0,40}$/.test(name)) return { ok: false, why: 'Name: letters, digits, space, dot, dash, underscore (41 characters at most).' };
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) return { ok: false, why: 'Pick a folder (a full path).' };
  const made = [], e = entryOf(name, folder);
  let j; try { j = read(); } catch (x) { return { ok: false, why: 'Cannot read project_managers.json: ' + x.message }; }
  const dup = (j.projects || []).find(p => p.project.toLowerCase() === e.project.toLowerCase() || p.managerTitle.toLowerCase() === e.managerTitle.toLowerCase() || path.resolve(p.cwd).toLowerCase() === e.cwd.toLowerCase());
  if (dup && resume && dup.project === e.project && path.resolve(dup.cwd).toLowerCase() === e.cwd.toLowerCase()) return { ok: true, entry: dup, made: [], resumed: true };   // a retry after the manager failed to start
  if (dup) return { ok: false, why: `A project "${dup.project}" already exists (${dup.cwd}).` };
  try {
    if (!fs.existsSync(e.cwd)) { fs.mkdirSync(e.cwd, { recursive: true }); made.push('folder'); }
    if (!fs.existsSync(path.join(e.cwd, '.git'))) { cp.execFileSync('git', ['init', '-q'], { cwd: e.cwd, windowsHide: true }); made.push('git repo'); }
    fs.mkdirSync(path.dirname(e.checkpoint), { recursive: true });
    if (!fs.existsSync(e.checkpoint)) {
      fs.writeFileSync(e.checkpoint, checkpointFor(e), 'utf8'); made.push('checkpoint');
    }
    if (!fs.existsSync(e.beatFile)) { writeBeat(e); made.push('beat file'); }
    if (addClaudeTools(e.cwd)) made.push('claude-tools MCP');
    (j.projects = j.projects || []).push(e); write(j); made.push('config entry');
  } catch (x) { return { ok: false, why: 'Not created: ' + x.message, made }; }
  return { ok: true, entry: e, made };
}

// undo a create whose manager never started (config entry only; the folder and checkpoint stay)
function remove(project) { const j = read(); const n = (j.projects || []).length; j.projects = (j.projects || []).filter(p => p.project !== project); if (j.projects.length !== n) write(j); return j.projects.length !== n; }

// which project a session's working folder belongs to (the config's sessionCwdFilter globs); the config is re-read every 10 s
let cache = { at: 0, ps: [] };
const ESC = /[.+^${}()|[\]\\]/g;
const rx = g => new RegExp('^' + String(g).toLowerCase().replace(ESC, m => '\\' + m).replace(/\*/g, '.*') + '$');
function projectOf(cwd) {
  if (!cwd) return null;
  if (Date.now() - cache.at > 10000) cache = { at: Date.now(), ps: list().map(p => ({ name: p.project, res: (p.sessionCwdFilter || []).map(rx) })) };
  const c = String(cwd).toLowerCase().replace(/[\\/]+$/, '');
  const hit = cache.ps.find(p => p.res.some(r => r.test(c)));
  return hit ? hit.name : null;
}

module.exports = { projectOf, waiterCmd, checkpointFor, list, create, remove, entryOf, promptFor, slugOf, addClaudeTools };
