// Working rules installer (SessionManagement_Spec part 4): a marked block in ~/.claude/CLAUDE.md, autoCompactWindow in
// ~/.claude/settings.json and a SessionStart (compact) hook with the checkpoint reminder. Each file is backed up first;
// remove() restores the backup when the file is unchanged since the install, else takes out exactly what was added.
// ContextLimits_Spec: the window has three kinds; Other goes in ~/.claude/settings.json, Manager and Worker in
// <folder>/.claude/settings.local.json of the manager's folder and of each worker folder (the same backup / restore rules).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const START = '<!-- theseus-rules:start -->', END = '<!-- theseus-rules:end -->';
const HOOK_CMD = 'echo Theseus rule: after compaction, read the checkpoint file of this task, project/.claude/checkpoints/task-slug.md, before continuing.';   // no quotes or brackets: runs the same in cmd and bash
const BLOCK = [
  START,
  '# Working rules (added by Theseus session management)',
  '- One checkpoint file per task: `<project>/.claude/checkpoints/<task-slug>.md`. It opens with a `## Now` block of at most',
  '  6 lines (state, next step, blocker, updated time + commit), then the goal, plan steps, decisions and exact paths. Rewrite',
  '  it in place; it is a snapshot, not a log.',
  '- After every major step: commit that step\'s files (in a git repo) and update the checkpoint.',
  '- After a compaction: read the checkpoint before continuing.',
  '- When a message says "Swap: ...", bring the checkpoint up to date, commit, then reply with the single word SWAP-READY and',
  '  stop. A fresh session continues from the checkpoint.',
  '- When a message says "Park: ...", commit, update the checkpoint and stop.',
  END,
].join('\n');
const sha = b => crypto.createHash('sha1').update(b).digest('hex');
// null = no file; any other error (a lock, no access) throws: a file that is there is never taken for a missing one
const read = f => { try { return fs.readFileSync(f); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const writeA = (f, data) => { fs.writeFileSync(f + '.tmp', data); fs.renameSync(f + '.tmp', f); };   // never a half-written file

function create(o) {
  // o: { claudeDir(), dir (Theseus user data), log(line) }
  const md = () => path.join(o.claudeDir(), 'CLAUDE.md'), js = () => path.join(o.claudeDir(), 'settings.json');
  const recFile = path.join(o.dir, 'rules.json'), bak = path.join(o.dir, 'rules-backup');
  const rec = () => { try { return JSON.parse(fs.readFileSync(recFile, 'utf8')); } catch { return null; } };

  const W = w => typeof w === 'number' ? { other: w, manager: 0, worker: 0 } : { other: 0, manager: 0, worker: 0, ...(w || {}) };
  const bakOf = f => path.join(bak, 'local-' + sha(path.resolve(f).toLowerCase()).slice(0, 12) + '.json');
  const parse = b => JSON.parse(b.toString('utf8').replace(/^﻿/, ''));
  // the per-folder files: [{ kind, file, window, before, hadWindow, after }] (the manager's first; one file once); a file that
  // is not JSON is left alone and named in skipped
  function planLocal(w, folders) {
    const local = [], skipped = [], seen = new Set();
    for (const kind of ['manager', 'worker']) for (const d of (folders && folders[kind]) || []) {
      if (!(w[kind] > 0) || typeof d !== 'string' || !path.isAbsolute(d)) continue;
      const file = path.join(d, '.claude', 'settings.local.json'), key = path.resolve(file).toLowerCase();
      if (seen.has(key)) continue; seen.add(key);
      let b, j = {}; try { b = read(file); if (b) j = parse(b); } catch (e) { skipped.push(`${file}: ${e instanceof SyntaxError ? 'not valid JSON' : e.message}`); continue; }
      if (!j || typeof j !== 'object' || Array.isArray(j)) { skipped.push(`${file}: not an object`); continue; }
      local.push({ kind, file, window: w[kind], before: b ? b.toString('utf8') : null, hadWindow: 'autoCompactWindow' in j ? j.autoCompactWindow : null, after: JSON.stringify({ ...j, autoCompactWindow: w[kind] }, null, 2) + '\n' });
    }
    return { local, skipped };
  }
  // a per-folder file back as it was: the backup when untouched since the install, else only the window taken out
  function revertLocal(f, info) {
    const cur = read(f), b = bakOf(f);
    if (cur) {
      if (sha(cur) === info.after && !info.surgical) { if (info.existed) writeA(f, fs.readFileSync(b)); else fs.unlinkSync(f); }
      else {
        const j = parse(cur);
        if (j && j.autoCompactWindow === info.window) { if (info.hadWindow == null) delete j.autoCompactWindow; else j.autoCompactWindow = info.hadWindow; writeA(f, JSON.stringify(j, null, 2) + '\n'); }
      }
    }
    try { fs.unlinkSync(b); } catch {}
  }

  // what install() would write: { md: { before, after }, js: { before, after }, local: [...], skipped } as strings (null = no
  // file). windows: { other, manager, worker } (a number = other only); folders: { manager: [dir], worker: [dir] }
  function plan(windows, folders) {
    const w = W(windows), window = w.other;
    let m0, j0; try { m0 = read(md()); j0 = read(js()); } catch (e) { return { err: 'could not read the Claude Code files: ' + e.message }; }
    const mText = m0 ? m0.toString('utf8') : '';
    const mAfter = mText.includes(START) ? mText.replace(new RegExp(START + '[\\s\\S]*?' + END), BLOCK) : (mText ? mText.replace(/\s*$/, '\n\n') : '') + BLOCK + '\n';
    let j = {}; if (j0) { try { j = JSON.parse(j0.toString('utf8').replace(/^﻿/, '')); } catch { return { err: 'settings.json is not valid JSON: fix it first' }; } }
    if (!j || typeof j !== 'object' || Array.isArray(j)) return { err: 'settings.json is not an object' };
    const ja = JSON.parse(JSON.stringify(j));
    if (window > 0) ja.autoCompactWindow = window;
    ja.hooks = ja.hooks && typeof ja.hooks === 'object' ? ja.hooks : {};
    const ss = Array.isArray(ja.hooks.SessionStart) ? ja.hooks.SessionStart : [];
    if (!ss.some(e => e && Array.isArray(e.hooks) && e.hooks.some(h => h && h.command === HOOK_CMD))) ss.push({ matcher: 'compact', hooks: [{ type: 'command', command: HOOK_CMD }] });
    ja.hooks.SessionStart = ss;
    return { md: { file: md(), before: m0 ? mText : null, after: mAfter }, js: { file: js(), before: j0 ? j0.toString('utf8') : null, after: JSON.stringify(ja, null, 2) + '\n', window }, ...planLocal(w, folders) };
  }

  function install(windows, folders) {
    const p = plan(windows, folders); if (p.err) return { ok: false, why: p.err };
    const window = p.js.window;
    try {
      fs.mkdirSync(bak, { recursive: true }); fs.mkdirSync(o.claudeDir(), { recursive: true });
      const r = { at: new Date().toISOString(), window, hadWindow: null, files: {}, local: {}, skipped: p.skipped };
      try { const j = JSON.parse(p.js.before || '{}'); if ('autoCompactWindow' in j) r.hadWindow = j.autoCompactWindow; } catch {}
      for (const k of ['md', 'js']) {
        const x = p[k], prev = rec() && rec().files && rec().files[k];
        // a re-install keeps the first backup (the user's own file from before Theseus)
        const b = path.join(bak, path.basename(x.file));
        if (!prev) { if (x.before != null) fs.writeFileSync(b, x.before); else try { fs.unlinkSync(b); } catch {} }
        fs.writeFileSync(x.file + '.tmp', x.after); fs.renameSync(x.file + '.tmp', x.file);
        // edited since the last install: the first backup is out of date, so remove takes out only what was added
        const stale = !!prev && x.before != null && sha(Buffer.from(x.before)) !== prev.after;
        r.files[k] = { existed: prev ? prev.existed : x.before != null, after: sha(Buffer.from(x.after)), ...((prev && prev.surgical) || stale ? { surgical: true } : {}) };
      }
      if (rec() && rec().hadWindow !== undefined) r.hadWindow = rec().hadWindow;
      const was = (rec() && rec().local) || {};
      for (const x of p.local) {
        const prev = was[x.file], b = bakOf(x.file);
        if (!prev) { if (x.before != null) fs.writeFileSync(b, x.before); else try { fs.unlinkSync(b); } catch {} }
        fs.mkdirSync(path.dirname(x.file), { recursive: true }); writeA(x.file, x.after);
        const stale = !!prev && x.before != null && sha(Buffer.from(x.before)) !== prev.after;
        r.local[x.file] = { kind: x.kind, window: x.window, existed: prev ? prev.existed : x.before != null, hadWindow: prev ? prev.hadWindow : x.hadWindow,
          after: sha(Buffer.from(x.after)), ...((prev && prev.surgical) || stale ? { surgical: true } : {}) };
      }
      // a folder no longer listed, or its kind now 0: back as it was
      for (const f of Object.keys(was)) if (!r.local[f]) try { revertLocal(f, was[f]); } catch (e) { o.log(`rules: ${f} not restored: ${e.message}`); }
      fs.writeFileSync(recFile, JSON.stringify(r, null, 1));
      o.log(`rules installed (autoCompactWindow ${window}; ${p.local.length} folder file(s)${p.skipped.length ? '; skipped ' + p.skipped.join('; ') : ''})`);
      return { ok: true };
    } catch (e) { return { ok: false, why: e.message }; }
  }

  function remove() {
    const r = rec(); if (!r) return { ok: false, why: 'not installed' };
    try {
      for (const k of ['md', 'js']) {
        const f = k === 'md' ? md() : js(), cur = read(f), info = r.files[k], b = path.join(bak, path.basename(f));
        if (!cur) continue;
        if (sha(cur) === info.after && !info.surgical) {            // untouched since the install: the file exactly as it was
          if (info.existed) writeA(f, fs.readFileSync(b)); else fs.unlinkSync(f);
          continue;
        }
        if (k === 'md') {
          const t = cur.toString('utf8').replace(new RegExp('\\n*' + START + '[\\s\\S]*?' + END + '\\n?'), '\n');
          writeA(f, t.replace(/\n{3,}$/, '\n'));
        } else {
          const j = JSON.parse(cur.toString('utf8').replace(/^﻿/, ''));
          if (j.autoCompactWindow === r.window) { if (r.hadWindow == null) delete j.autoCompactWindow; else j.autoCompactWindow = r.hadWindow; }   // (a window the user set since stays)
          if (j.hooks && Array.isArray(j.hooks.SessionStart)) {
            j.hooks.SessionStart = j.hooks.SessionStart.map(e => e && Array.isArray(e.hooks) ? { ...e, hooks: e.hooks.filter(h => !(h && h.command === HOOK_CMD)) } : e).filter(e => !(e && Array.isArray(e.hooks) && !e.hooks.length));
            if (!j.hooks.SessionStart.length) delete j.hooks.SessionStart;
            if (!Object.keys(j.hooks).length) delete j.hooks;
          }
          writeA(f, JSON.stringify(j, null, 2) + '\n');
        }
      }
      for (const [f, info] of Object.entries(r.local || {})) revertLocal(f, info);
      fs.unlinkSync(recFile);
      o.log('rules removed');
      return { ok: true };
    } catch (e) { return { ok: false, why: e.message }; }
  }

  const status = () => { const r = rec(); return { installed: !!r, at: r ? r.at : null, window: r ? r.window : null, dir: o.claudeDir(),
    local: r && r.local ? Object.entries(r.local).map(([file, x]) => ({ file, kind: x.kind, window: x.window })) : [], skipped: (r && r.skipped) || [] }; };
  return { plan, install, remove, status, BLOCK };
}
module.exports = { create };
