// Working rules installer (SessionManagement_Spec part 4): a marked block in ~/.claude/CLAUDE.md, autoCompactWindow in
// ~/.claude/settings.json and a SessionStart (compact) hook with the checkpoint reminder. Each file is backed up first;
// remove() restores the backup when the file is unchanged since the install, else takes out exactly what was added.
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
const read = f => { try { return fs.readFileSync(f); } catch { return null; } };

function create(o) {
  // o: { claudeDir(), dir (Theseus user data), log(line) }
  const md = () => path.join(o.claudeDir(), 'CLAUDE.md'), js = () => path.join(o.claudeDir(), 'settings.json');
  const recFile = path.join(o.dir, 'rules.json'), bak = path.join(o.dir, 'rules-backup');
  const rec = () => { try { return JSON.parse(fs.readFileSync(recFile, 'utf8')); } catch { return null; } };

  // what install() would write: { md: { before, after }, js: { before, after } } as strings (null = no file)
  function plan(window) {
    const m0 = read(md()), j0 = read(js());
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
    return { md: { file: md(), before: m0 ? mText : null, after: mAfter }, js: { file: js(), before: j0 ? j0.toString('utf8') : null, after: JSON.stringify(ja, null, 2) + '\n', window } };
  }

  function install(window) {
    const p = plan(window); if (p.err) return { ok: false, why: p.err };
    try {
      fs.mkdirSync(bak, { recursive: true }); fs.mkdirSync(o.claudeDir(), { recursive: true });
      const r = { at: new Date().toISOString(), window, hadWindow: null, files: {} };
      try { const j = JSON.parse(p.js.before || '{}'); if ('autoCompactWindow' in j) r.hadWindow = j.autoCompactWindow; } catch {}
      for (const k of ['md', 'js']) {
        const x = p[k], prev = rec() && rec().files && rec().files[k];
        // a re-install keeps the first backup (the user's own file from before Theseus)
        const b = path.join(bak, path.basename(x.file));
        if (!prev) { if (x.before != null) fs.writeFileSync(b, x.before); else try { fs.unlinkSync(b); } catch {} }
        fs.writeFileSync(x.file + '.tmp', x.after); fs.renameSync(x.file + '.tmp', x.file);
        r.files[k] = { existed: prev ? prev.existed : x.before != null, after: sha(Buffer.from(x.after)) };
      }
      if (rec() && rec().hadWindow !== undefined) r.hadWindow = rec().hadWindow;
      fs.writeFileSync(recFile, JSON.stringify(r, null, 1));
      o.log(`rules installed (autoCompactWindow ${window})`);
      return { ok: true };
    } catch (e) { return { ok: false, why: e.message }; }
  }

  function remove() {
    const r = rec(); if (!r) return { ok: false, why: 'not installed' };
    try {
      for (const k of ['md', 'js']) {
        const f = k === 'md' ? md() : js(), cur = read(f), info = r.files[k], b = path.join(bak, path.basename(f));
        if (!cur) continue;
        if (sha(cur) === info.after) {            // untouched since the install: the file exactly as it was
          if (info.existed) fs.copyFileSync(b, f); else fs.unlinkSync(f);
          continue;
        }
        if (k === 'md') {
          const t = cur.toString('utf8').replace(new RegExp('\\n*' + START + '[\\s\\S]*?' + END + '\\n?'), '\n');
          fs.writeFileSync(f, t.replace(/\n{3,}$/, '\n'));
        } else {
          const j = JSON.parse(cur.toString('utf8').replace(/^﻿/, ''));
          if (r.hadWindow == null) delete j.autoCompactWindow; else j.autoCompactWindow = r.hadWindow;
          if (j.hooks && Array.isArray(j.hooks.SessionStart)) {
            j.hooks.SessionStart = j.hooks.SessionStart.map(e => e && Array.isArray(e.hooks) ? { ...e, hooks: e.hooks.filter(h => !(h && h.command === HOOK_CMD)) } : e).filter(e => !(e && Array.isArray(e.hooks) && !e.hooks.length));
            if (!j.hooks.SessionStart.length) delete j.hooks.SessionStart;
            if (!Object.keys(j.hooks).length) delete j.hooks;
          }
          fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
        }
      }
      fs.unlinkSync(recFile);
      o.log('rules removed');
      return { ok: true };
    } catch (e) { return { ok: false, why: e.message }; }
  }

  const status = () => { const r = rec(); return { installed: !!r, at: r ? r.at : null, window: r ? r.window : null, dir: o.claudeDir() }; };
  return { plan, install, remove, status, BLOCK };
}
module.exports = { create };
