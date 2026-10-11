// Session Console stage 5 (Docs/Specs/SessionConsole_Stage5_Plan.md, step 4): what the console's tabs show, read when a
// tab opens. Changes and a file's diff from git, the branch's pull request from gh, Tasks and Artifacts from the transcript.
// git and gh run with an argument list (no shell), in the session's folder, with a time cap.
// Each runs by its full path, found once on PATH's absolute folders: a bare name would be looked up in the session's folder
// first, so a git.exe left there would run. git takes no optional locks (it never blocks the session's own git) and runs
// no fsmonitor hook from the repository's config.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const exes = new Map();
function exe(name) {
  if (exes.has(name)) return exes.get(name);
  const dirs = (process.env.PATH || '').split(path.delimiter).map(d => d.trim().replace(/^"|"$/g, '')).filter(d => /^[a-z]:[\\/]/i.test(d));
  const pf = [process.env.ProgramFiles, process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean);
  dirs.push(...pf.map(d => path.join(d, name === 'git' ? 'Git\\cmd' : 'GitHub CLI')));
  let f = null;
  for (const d of dirs) { const p = path.join(d, name + '.exe'); try { if (fs.statSync(p).isFile()) { f = p; break; } } catch {} }
  exes.set(name, f); return f;
}
const run = (name, args, cwd, ms = 15000, env = null) => new Promise(res => {
  const f = exe(name); if (!f) return res({ ok: false, out: '', err: `spawn ${name} ENOENT` });
  if (name === 'git') args = ['-c', 'core.fsmonitor=false', ...args];
  execFile(f, args, { cwd, timeout: ms, maxBuffer: 16 << 20, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...env } }, (err, out, errOut) =>
    res({ ok: !err, out: String(out || ''), err: String(errOut || (err && err.message) || '') }));
});
const MAX_FILES = 400, MAX_DIFF = 3000;

// -> { ok, branch, files: [{ file, add, del, bin, untracked }] }
// a session folder since deleted or moved: said as such (a spawn in a missing folder fails with ENOENT, read as "no git")
const gone = dir => { try { return !fs.statSync(dir).isDirectory(); } catch { return true; } };
async function changes(dir) {
  const c = await changesRead(dir);
  recent.set(dir, { at: Date.now(), c }); if (recent.size > 40) recent.delete(recent.keys().next().value);
  return c;
}
async function changesRead(dir) {
  if (gone(dir)) return { ok: false, why: 'the session folder was not found' };
  const top = await run('git', ['rev-parse', '--show-toplevel'], dir);
  if (!top.ok) return { ok: false, why: /not a git repository/i.test(top.err) ? 'not a git repository' : /ENOENT/.test(top.err) ? 'git is not installed' : top.err.trim().split('\n')[0] || 'git did not run' };
  dir = top.out.trim() || dir;   // paths from the repository root
  const [br, ns0, un] = await Promise.all([run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], dir), run('git', ['diff', '--numstat', '-z', 'HEAD'], dir), run('git', ['ls-files', '--others', '--exclude-standard', '-z'], dir)]);
  // no commit yet (HEAD missing): what is staged, against the empty tree; any other git failure is said, not shown as no changes
  const ns = ns0.ok ? ns0 : await run('git', ['diff', '--numstat', '-z', '--cached'], dir);
  if (!ns.ok) return { ok: false, why: (ns0.err || ns.err).trim().split('\n')[0] || 'git diff failed' };
  if (!un.ok) return { ok: false, why: un.err.trim().split('\n')[0] || 'git ls-files failed' };
  const files = [];
  // -z numstat: "add\tdel\tpath\0" (a rename is "add\tdel\t\0old\0new\0")
  const parts = ns.out.split('\0');
  for (let i = 0; i < parts.length && files.length < MAX_FILES; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(parts[i]); if (!m) continue;
    let file = m[3]; if (!file) { file = parts[i + 2] || parts[i + 1] || ''; i += 2; }
    files.push({ file, add: m[1] === '-' ? 0 : +m[1], del: m[2] === '-' ? 0 : +m[2], bin: m[1] === '-' });
  }
  const unt = un.out.split('\0').filter(Boolean), room = Math.max(0, MAX_FILES - files.length);
  for (const f of unt.slice(0, room)) files.push({ file: f, add: 0, del: 0, untracked: true });
  return { ok: true, branch: br.out.trim(), files, more: unt.length > room, root: dir };
}

// one file's diff against HEAD -> { ok, lines: [[k, text]] } (k '+', '-', ' ', '@' for a hunk header); an untracked file is all '+'
// the list just shown is reused for a few seconds (opening a file's diff right after the list costs one git call, not four)
const recent = new Map();
async function changesSoon(dir) {
  const h = recent.get(dir); if (h && Date.now() - h.at < 5000) return h.c;
  return changes(dir);
}
async function fileDiff(dir, file) {
  const c = await changesSoon(dir); if (!c.ok) return c;
  const f = c.files.find(x => x.file === file); if (!f) return { ok: false, why: 'not among the changes' };
  if (f.untracked) {
    const p = path.join(c.root, file);
    let t; try { const st = fs.statSync(p); if (st.size > 4 << 20) return { ok: true, lines: [['@', 'New file, too large to show']] }; t = fs.readFileSync(p); } catch { return { ok: false, why: 'unreadable' }; }
    if (t.includes(0)) return { ok: true, lines: [['@', 'New binary file']] };
    const L = t.toString('utf8').replace(/\r\n?/g, '\n').split('\n'); if (L.length > 1 && L[L.length - 1] === '') L.pop();   // the last newline ends a line, it is not one
    return { ok: true, lines: L.slice(0, MAX_DIFF).map(x => ['+', x.slice(0, 400)]), cut: L.length > MAX_DIFF };
  }
  const r = await run('git', ['diff', '--no-color', '--no-ext-diff', 'HEAD', '--', file], c.root);
  if (!r.ok) return { ok: false, why: r.err.trim().split('\n')[0] || 'git diff failed' };
  const out = [];
  for (const l of r.out.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity|rename )/.test(l)) continue;
    if (l.startsWith('@@')) out.push(['@', l]); else if (l.startsWith('Binary files')) out.push(['@', 'Binary file changed']);
    else if (l[0] === '+' || l[0] === '-' || l[0] === ' ') out.push([l[0], l.slice(1, 401)]);
    if (out.length >= MAX_DIFF) break;
  }
  return { ok: true, lines: out, cut: out.length >= MAX_DIFF };
}

// the branch's pull request -> { ok, branch, pr: { number, title, state, url, checks: [{ name, state }] } | null, why }
async function pr(dir) {
  if (gone(dir)) return { ok: false, why: 'the session folder was not found' };
  const br = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], dir);
  if (!br.ok) return { ok: false, why: 'not a git repository' };
  const rem = await run('git', ['remote'], dir);
  if (!rem.out.trim()) return { ok: true, branch: br.out.trim(), pr: null, why: 'This folder has no git remote.' };
  const r = await run('gh', ['pr', 'view', '--json', 'number,title,state,url,isDraft,statusCheckRollup'], dir, 20000);
  if (!r.ok) {
    if (/no pull requests? found/i.test(r.err)) return { ok: true, branch: br.out.trim(), pr: null, why: 'No pull request for this branch.' };
    if (/gh auth login|not logged/i.test(r.err)) return { ok: false, why: 'gh is not signed in (run gh auth login).' };
    if (/ENOENT|not recognized/i.test(r.err)) return { ok: false, why: 'The gh CLI is not installed.' };
    return { ok: false, why: r.err.trim().split('\n')[0] || 'gh failed' };
  }
  let j; try { j = JSON.parse(r.out); } catch { return { ok: false, why: 'gh gave no answer' }; }
  const checks = (j.statusCheckRollup || []).slice(0, 60).map(c => ({ name: String(c.name || c.context || 'check'), state: String(c.conclusion || c.state || c.status || '').toLowerCase(), url: c.detailsUrl || c.targetUrl || '' }));
  return { ok: true, branch: br.out.trim(), pr: { number: j.number, title: String(j.title || ''), state: String(j.state || '').toLowerCase() + (j.isDraft ? ' (draft)' : ''), url: String(j.url || ''), checks } };
}

// every line of a transcript that contains one of `keys` (plain string test first, so most lines are never parsed); read
// 1 MB at a time with a pause between reads, so a big transcript never freezes the main process
async function scan(file, keys, each, want) {   // want(line): a last plain test before the line is parsed
  const fh = await fs.promises.open(file, 'r'), buf = Buffer.alloc(1 << 20), dec = new (require('string_decoder').StringDecoder)('utf8');   // a character split between reads stays whole
  let rest = '', pos = 0;
  try {
    for (;;) {
      const { bytesRead: n } = await fh.read(buf, 0, buf.length, pos); if (!n) break; pos += n;
      const t = rest + dec.write(buf.subarray(0, n)), ls = t.split('\n'); rest = ls.pop();
      for (const l of ls) if (keys.some(k => l.includes(k)) && (!want || want(l))) { let j; try { j = JSON.parse(l); } catch { continue; } each(j, l); }
      await new Promise(r => setImmediate(r));
    }
    rest += dec.end();
    if (rest && keys.some(k => rest.includes(k)) && (!want || want(rest))) { try { each(JSON.parse(rest), rest); } catch {} }
  } finally { await fh.close(); }
}
const blocks = j => (j && j.message && Array.isArray(j.message.content) ? j.message.content : []);
const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => (x && x.type === 'text' ? x.text : '')).join('\n') : '';
const short = (s, n = 160) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// background commands and agents -> { ok, tasks: [{ kind, text, at, state, id }] } newest first; the last answer per file is kept
// until the file changes (the Tasks tab and the tile marker ask for the same file)
const taskCache = new Map();
async function tasks(file) {
  let st; try { st = await fs.promises.stat(file); } catch { st = null; }
  const ck = st ? st.size + ':' + st.mtimeMs : '', hit = taskCache.get(file);
  if (hit && ck && hit.k === ck) return hit.r;
  const r = await tasksRead(file);
  if (ck) { taskCache.delete(file); taskCache.set(file, { k: ck, r }); if (taskCache.size > 40) taskCache.delete(taskCache.keys().next().value); }
  return r;
}
async function tasksRead(file) {
  const byUse = new Map(), byTask = new Map(), list = [];
  // a tool result is parsed only when it answers a task call (most lines of a transcript are tool results)
  const want = l => {
    if (!l.includes('"tool_result"') || l.includes('task-notification') || l.includes('run_in_background')) return true;
    const re = /"tool_use_id":"([^"]+)"/g; let m;
    while ((m = re.exec(l))) if (byUse.has(m[1])) return true;
    return false;
  };
  await scan(file, ['"run_in_background":true', '"name":"Agent"', '"name":"Task"', 'tool_result', 'task-notification', '"name":"TaskStop"'], j => {
    if (j.type === 'queue-operation' && typeof j.content === 'string') return note(j.content);
    if (j.type === 'attachment' && j.attachment && typeof j.attachment.prompt === 'string') return note(j.attachment.prompt);   // taken in mid-turn
    for (const b of blocks(j)) {
      if (b.type === 'tool_use' && b.input && ((/^(Bash|PowerShell)$/.test(b.name) && b.input.run_in_background === true) || b.name === 'Agent' || b.name === 'Task')) {
        const t = { kind: b.name === 'Agent' || b.name === 'Task' ? 'Agent' : 'Command', text: short(b.input.description || b.input.command || b.input.prompt), at: Date.parse(j.timestamp) || 0, state: 'running', id: b.id };
        byUse.set(b.id, t); list.push(t);
      } else if (b.type === 'tool_use' && b.name === 'TaskStop' && b.input) { const t = byTask.get(b.input.task_id || b.input.shell_id); if (t) t.state = 'stopped'; }
      else if (b.type === 'tool_result' && byUse.has(b.tool_use_id)) {
        // "Command running in background with ID: b…" / "Async agent launched successfully … agentId: a…": still running; any other result: done
        const t = byUse.get(b.tool_use_id), x = textOf(b.content).slice(0, 2000), m = /running in background with ID: (\w+)|^Async agent launched[\s\S]*?agentId: ?(\w+)/i.exec(x);
        if (m) byTask.set(m[1] || m[2], t);
        t.state = b.is_error ? 'failed' : m ? t.state : 'done';
      } else if (b.type === 'text' && b.text && b.text.includes('<task-notification>')) note(b.text);
    }
    if (j.type === 'user' && typeof (j.message && j.message.content) === 'string' && j.message.content.includes('<task-notification>')) note(j.message.content);
  }, want);
  function note(s) {
    const re = /<task-notification>([\s\S]*?)<\/task-notification>/g; let m;
    while ((m = re.exec(s))) {
      const g = k => { const r = new RegExp(`<${k}>([\\s\\S]*?)</${k}>`).exec(m[1]); return r ? r[1].trim() : ''; };
      const t = byUse.get(g('tool-use-id')) || byTask.get(g('task-id')); if (!t) continue;
      const st = g('status').toLowerCase(); t.state = st === 'completed' ? 'done' : st === 'killed' ? 'stopped' : st || t.state;
    }
  }
  return { ok: true, tasks: list.reverse().slice(0, 200) };
}

// published artifacts -> { ok, items: [{ title, url, at }] } newest first, one per URL
async function artifacts(file) {
  const uses = new Map(), seen = new Map();
  await scan(file, ['"name":"Artifact"', 'claude.ai/'], j => {
    for (const b of blocks(j)) {
      if (b.type === 'tool_use' && b.name === 'Artifact' && b.input && (!b.input.action || b.input.action === 'publish') && !b.input.asset) uses.set(b.id, { file: b.input.file_path || '', title: b.input.title || '', at: Date.parse(j.timestamp) || 0 });
      else if (b.type === 'tool_result' && uses.has(b.tool_use_id) && !b.is_error) {
        const u = uses.get(b.tool_use_id), x = textOf(b.content), m = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+/.exec(x); if (!m) continue;
        const tm = /<title>([^<]{1,120})<\/title>|title[":\s]+"?([^"\n]{1,120})/i.exec(x);
        seen.set(m[0], { url: m[0], title: short(u.title || (tm && (tm[1] || tm[2])) || path.basename(u.file).replace(/\.\w+$/, '') || 'Artifact', 100), at: u.at });
      }
    }
  });
  return { ok: true, items: [...seen.values()].sort((a, b) => b.at - a.at).slice(0, 100) };
}

// ---- Bridge_Spec actions: commit, push, pull request, worktrees. These write, so their time caps are longer; nothing
// prompts (a push that needs a password fails with git's message instead of hanging) ----
const NOPROMPT = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GH_PROMPT_DISABLED: '1' };
const why = r => (r.err || r.out).trim().split('\n').map(x => x.trim()).filter(Boolean).slice(-2).join(' · ') || 'git failed';
async function root(dir) { if (gone(dir)) return null; const t = await run('git', ['rev-parse', '--show-toplevel'], dir); return t.ok ? t.out.trim() : null; }
async function branchOf(dir) { const b = (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], dir)).out.trim(); return b && b !== 'HEAD' ? b : ''; }
// the repository's main branch: origin's HEAD, else a local main / master
async function defaultBranch(dir) {
  const r = await run('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], dir);
  if (r.ok && r.out.trim()) return r.out.trim().replace(/^origin\//, '');
  for (const b of ['main', 'master']) if ((await run('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/' + b], dir)).ok) return b;
  return '';
}
// the files go to git through a list file (no command-line length limit)
async function withList(files, fn) {
  const f = path.join(require('os').tmpdir(), `sphere-paths-${process.pid}-${Date.now()}.txt`);
  await fs.promises.writeFile(f, files.join('\0'));
  try { return await fn(f); } finally { fs.promises.unlink(f).catch(() => {}); }
}
// commit only `files` (paths from the repository root, each among the changes) with `msg` -> { ok, why, out }
async function commit(dir, files, msg) {
  const c = await changes(dir); if (!c.ok) return c;
  msg = String(msg || '').trim(); if (!msg) return { ok: false, why: 'Write a commit message first.' };
  const known = new Set(c.files.map(f => f.file)), pick = [...new Set((Array.isArray(files) ? files : []).filter(f => known.has(f)))];
  if (!pick.length) return { ok: false, why: 'Nothing ticked to commit.' };
  return withList(pick, async list => {
    const a = await run('git', ['add', '-A', '--pathspec-from-file=' + list, '--pathspec-file-nul'], c.root, 60000); if (!a.ok) return { ok: false, why: why(a) };
    const r = await run('git', ['commit', '-m', msg, '--pathspec-from-file=' + list, '--pathspec-file-nul'], c.root, 180000, NOPROMPT);
    return r.ok ? { ok: true, out: r.out.trim().split('\n')[0] } : { ok: false, why: why(r) };
  });
}
// what Push would do -> { ok, branch, main (the default branch), upstream, ahead }
async function pushInfo(dir) {
  const t = await root(dir); if (!t) return { ok: false, why: 'not a git repository' };
  const [branch, main, up] = await Promise.all([branchOf(t), defaultBranch(t), run('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], t)]);
  if (!branch) return { ok: false, why: 'Not on a branch (detached HEAD).' };
  const ahead = up.ok ? Number((await run('git', ['rev-list', '--count', '@{u}..HEAD'], t)).out.trim()) || 0 : null;
  return { ok: true, root: t, branch, main, upstream: up.ok ? up.out.trim() : '', ahead };
}
// git push (never forced); the first push of a branch sets its upstream on origin (or the only remote)
async function push(dir) {
  const i = await pushInfo(dir); if (!i.ok) return i;
  let args = ['push'];
  if (!i.upstream) {
    const rem = (await run('git', ['remote'], i.root)).out.split('\n').map(x => x.trim()).filter(Boolean);
    if (!rem.length) return { ok: false, why: 'This folder has no git remote.' };
    args = ['push', '-u', rem.includes('origin') ? 'origin' : rem[0], i.branch];
  }
  const r = await run('git', args, i.root, 180000, NOPROMPT);
  return r.ok ? { ok: true, out: `Pushed ${i.branch}` } : { ok: false, why: why(r) };
}
// a pull request's suggested title and body, from the branch's commits since the default branch
async function prDraft(dir) {
  const i = await pushInfo(dir); if (!i.ok) return i;
  if (!i.main) return { ok: false, why: 'No main branch found to open the pull request against.' };
  if (i.branch === i.main) return { ok: false, why: `You are on ${i.main}: make a branch first.` };
  const base = (await run('git', ['rev-parse', '--verify', '--quiet', 'origin/' + i.main], i.root)).ok ? 'origin/' + i.main : i.main;
  const log = await run('git', ['log', '--format=%s', `${base}..HEAD`], i.root);
  const subs = log.out.split('\n').map(x => x.trim()).filter(Boolean).slice(0, 50);
  if (!subs.length) return { ok: false, why: `No commits on ${i.branch} that ${i.main} lacks.` };
  const title = subs.length === 1 ? subs[0] : i.branch.replace(/^[\w-]+\//, '').replace(/[-_]+/g, ' ').replace(/^./, c => c.toUpperCase());
  return { ok: true, branch: i.branch, base: i.main, title, body: subs.map(x => '- ' + x).join('\n') };
}
// push if needed, then gh pr create -> { ok, url }
async function prCreate(dir, o) {
  const i = await pushInfo(dir); if (!i.ok) return i;
  const title = String((o && o.title) || '').trim(), body = String((o && o.body) || ''), base = String((o && o.base) || i.main || '').trim();
  if (!title) return { ok: false, why: 'Give the pull request a title.' };
  if (!/^[\w./-]{1,100}$/.test(base)) return { ok: false, why: 'Bad base branch.' };
  if (!i.upstream || i.ahead) { const p = await push(dir); if (!p.ok) return p; }
  const r = await run('gh', ['pr', 'create', '--title', title, '--body', body, '--base', base, '--head', i.branch], i.root, 60000, NOPROMPT);
  if (!r.ok) return { ok: false, why: /gh auth login|not logged/i.test(r.err) ? 'gh is not signed in (run gh auth login).' : /ENOENT/.test(r.err) ? 'The gh CLI is not installed.' : why(r) };
  return { ok: true, url: (r.out.match(/https?:\/\/\S+/) || [''])[0], out: 'Pull request created' };
}
// the repository's worktrees -> { ok, here (this folder's worktree), list: [{ path, branch, main, changed, locked, prunable }] }
async function worktrees(dir) {
  const t = await root(dir); if (!t) return { ok: false, why: 'not a git repository' };
  const r = await run('git', ['worktree', 'list', '--porcelain'], t); if (!r.ok) return { ok: false, why: why(r) };
  const list = [];
  for (const b of r.out.split(/\r?\n\r?\n/)) {
    const w = {}; for (const l of b.split(/\r?\n/)) { const m = /^(\w+)(?: (.*))?$/.exec(l.trim()); if (m) w[m[1]] = m[2] === undefined ? true : m[2]; }
    if (w.worktree) list.push({ path: path.normalize(w.worktree), branch: typeof w.branch === 'string' ? w.branch.replace(/^refs\/heads\//, '') : w.detached ? '(detached)' : '', main: !list.length, locked: !!w.locked, prunable: !!w.prunable });
  }
  await Promise.all(list.slice(0, 30).map(async w => { if (w.prunable || gone(w.path)) { w.changed = null; return; } const s = await run('git', ['status', '--porcelain'], w.path); w.changed = s.ok ? s.out.split('\n').filter(Boolean).length : null; }));
  return { ok: true, here: path.normalize(t), list };
}
// is this folder a linked worktree (its git dir differs from the shared one)?
async function isWorktree(dir) {
  const r = await run('git', ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], dir); if (!r.ok) return false;
  const [g, c] = r.out.trim().split(/\r?\n/).map(x => path.normalize(x.trim()).toLowerCase()); return !!g && !!c && g !== c;
}
// remove a worktree with no changes (never the main one) -> { ok, why }
async function worktreeRemove(dir, wt) {
  const w = await worktrees(dir); if (!w.ok) return w;
  const it = w.list.find(x => x.path.toLowerCase() === path.normalize(String(wt || '')).toLowerCase());
  if (!it) return { ok: false, why: 'Not a worktree of this repository.' };
  if (it.main) return { ok: false, why: 'The main worktree is not removed.' };
  if (it.changed) return { ok: false, why: `It has ${it.changed} changed file${it.changed > 1 ? 's' : ''}.` };
  const r = it.prunable ? await run('git', ['worktree', 'prune'], w.list[0].path) : await run('git', ['worktree', 'remove', it.path], w.list[0].path, 60000);
  return r.ok ? { ok: true, out: 'Worktree removed' } : { ok: false, why: why(r) };
}
module.exports = { changes, fileDiff, pr, tasks, artifacts, commit, pushInfo, push, prDraft, prCreate, worktrees, worktreeRemove, defaultBranch, isWorktree, exe };
