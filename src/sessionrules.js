// Session rules installer (SessionRules_Spec): the Theseus mod (mod/ in this repo) is copied to <userData>/mod and its
// path added to env.CLAUDE_CODE_PLUGIN_DIRS in ~/.claude/settings.json, beside any other mod there (TitansMod). The mod
// reads <userData>/mod/state.json, which writeState() keeps in step with Theseus (mode, quiet hours, manager, switches).
// settings.json is backed up first; remove() restores the backup when the file is unchanged since the install, else takes
// out exactly the path that was added.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VAR = 'CLAUDE_CODE_PLUGIN_DIRS', SEP = ';';
// one line per rule for the settings card; `def` is the switch's default (all of them wait on Install)
const LIST = [
  ['staging', 'Stage only your own files: no git add -A / . or commit -a', true],
  ['encoding', 'PowerShell 5.1 file writes need -Encoding utf8', true],
  ['waits', 'No long foreground waits or sleeps: run long jobs in the background', true],
  ['stateFiles', "Theseus's own files are written only by Theseus", true],
  ['searchAgents', 'No general-purpose or Explore subagents for searching', false],
  ['msgSize', 'Messages to other sessions: at most 12 lines or 2000 characters', true],
  ['msgVia', 'Messages to other sessions go through Theseus', true],
  ['recFirst', 'Pop-ups put the recommended option first', true],
  ['noSchedMode', 'Scheduled jobs never start a mode', true],
  ['modeSkills', 'Mode changes go through Theseus, not mode skills', true],
  ['modeGate', 'Worker holds notifications; Night and Weekend hold pop-ups in quiet hours', true],
  ['ckptNotes', 'Checkpoint notes: ## Now missing or over 6 lines, file too big', true],
  ['compactNow', 'After a compaction, the checkpoint\'s ## Now block is given back', true],
  ['precompactCommit', 'Before a compaction, changed checkpoints are committed', true],
  ['bigOutput', 'A note when a tool returns a very large output', true],
  ['emptyTurn', 'No empty reply at the end of a turn', true],
  ['clock12', 'Times in replies on a 12-hour clock', false],
];
const DEFAULTS = Object.fromEntries(LIST.map(([k, , d]) => [k, d]));
const sha = b => crypto.createHash('sha1').update(b).digest('hex');
// null = no file; any other error (a lock, no access) throws: a file that is there is never taken for a missing one
const read = f => { try { return fs.readFileSync(f); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const writeA = (f, data) => { fs.writeFileSync(f + '.tmp', data); fs.renameSync(f + '.tmp', f); };   // never a half-written file

// every file under a folder, relative paths, sorted (state.json and generated types left out)
function files(dir, rel = '') {
  let out = [];
  for (const d of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? rel + '/' + d.name : d.name;
    if (r === 'state.json' || r === '.claude-plugin/types' || d.name === 'node_modules') continue;
    if (d.isDirectory()) out = out.concat(files(dir, r)); else out.push(r);
  }
  return out.sort();
}

function create(o) {
  // o: { claudeDir(), dir (Theseus user data), src (the mod folder shipped with the app), log(line) }
  const js = () => path.join(o.claudeDir(), 'settings.json');
  const modDir = path.join(o.dir, 'mod'), stateFile = path.join(modDir, 'state.json');
  const recFile = path.join(o.dir, 'sessionrules.json'), bak = path.join(o.dir, 'sessionrules-backup');
  const rec = () => { try { return JSON.parse(fs.readFileSync(recFile, 'utf8')); } catch { return null; } };
  const split = v => typeof v === 'string' ? v.split(SEP).map(x => x.trim()).filter(Boolean) : [];
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

  // the shipped mod's fingerprint: a copy is refreshed when it differs (an app update, or a dev edit)
  function stamp() { const h = crypto.createHash('sha1'); for (const f of files(o.src)) h.update(f + '\0').update(fs.readFileSync(path.join(o.src, f))); return h.digest('hex'); }
  function copy() {
    const s = stamp(), mark = path.join(modDir, '.theseus-stamp');
    if (String(read(mark) || '') === s) return false;
    const keep = read(stateFile);
    try { fs.rmSync(modDir, { recursive: true, force: true }); } catch {}
    for (const f of files(o.src)) { const d = path.join(modDir, f); fs.mkdirSync(path.dirname(d), { recursive: true }); fs.writeFileSync(d, fs.readFileSync(path.join(o.src, f))); }
    if (keep) fs.writeFileSync(stateFile, keep);
    fs.writeFileSync(mark, s);
    o.log('session rules: mod copied to ' + modDir);
    return true;
  }

  let lastState = null;
  // st: { rules {id: on}, mode, quietStart, quietEnd, managerId, critical[], stateFiles[] }; written only when it changed
  function writeState(st) {
    const rules = {}; for (const [k] of LIST) rules[k] = !!(st.rules && k in st.rules ? st.rules[k] : DEFAULTS[k]);
    const j = JSON.stringify({ v: 1, rules, mode: st.mode || 'normal', quietStart: st.quietStart || null, quietEnd: st.quietEnd || null,
      managerId: st.managerId || '', critical: st.critical || [], stateFiles: st.stateFiles || [], msgLines: 12, msgChars: 2000, modeSince: st.modeSince || null }, null, 1);
    if (j === lastState) return false;
    try { fs.mkdirSync(modDir, { recursive: true }); fs.writeFileSync(stateFile + '.tmp', j); fs.renameSync(stateFile + '.tmp', stateFile); lastState = j; return true; }
    catch (e) { o.log('session rules: state not written: ' + e.message); return false; }
  }

  // what install() would write to settings.json: { file, before, after, others } (null before = no file)
  function plan() {
    let j0; try { j0 = read(js()); } catch (e) { return { err: 'could not read settings.json: ' + e.message }; }
    let j = {}; if (j0) { try { j = JSON.parse(j0.toString('utf8').replace(/^﻿/, '')); } catch { return { err: 'settings.json is not valid JSON: fix it first' }; } }
    if (!j || typeof j !== 'object' || Array.isArray(j)) return { err: 'settings.json is not an object' };
    const ja = JSON.parse(JSON.stringify(j));
    ja.env = ja.env && typeof ja.env === 'object' && !Array.isArray(ja.env) ? ja.env : {};
    const dirs = split(ja.env[VAR]);
    if (!dirs.some(d => same(d, modDir))) dirs.push(modDir);
    ja.env[VAR] = dirs.join(SEP);
    return { file: js(), before: j0 ? j0.toString('utf8') : null, after: JSON.stringify(ja, null, 2) + '\n', others: dirs.filter(d => !same(d, modDir)) };
  }

  function install(st) {
    const p = plan(); if (p.err) return { ok: false, why: p.err };
    try {
      copy(); lastState = null; writeState(st);
      fs.mkdirSync(bak, { recursive: true }); fs.mkdirSync(o.claudeDir(), { recursive: true });
      const prev = rec(), b = path.join(bak, 'settings.json');
      // a re-install keeps the first backup (the user's own file from before Theseus)
      if (!prev) { if (p.before != null) fs.writeFileSync(b, p.before); else try { fs.unlinkSync(b); } catch {} }
      fs.writeFileSync(p.file + '.tmp', p.after); fs.renameSync(p.file + '.tmp', p.file);
      // edited since the last install: the first backup is out of date, so remove takes out only what was added
      const surgical = !!prev && (prev.surgical || (p.before != null && sha(Buffer.from(p.before)) !== prev.after));
      fs.writeFileSync(recFile, JSON.stringify({ at: new Date().toISOString(), dir: modDir, existed: prev ? prev.existed : p.before != null, after: sha(Buffer.from(p.after)), ...(surgical ? { surgical } : {}) }, null, 1));
      o.log('session rules installed: ' + modDir);
      // TitansMod defines the same rules until it skips the ones state.json lists as on (plan step 6)
      const titans = p.others.find(d => /titansmod/i.test(d));
      return { ok: true, warn: titans ? 'TitansMod is loaded too and may still run the same rules: ' + titans : null };
    } catch (e) { return { ok: false, why: e.message }; }
  }

  function remove() {
    const r = rec(); if (!r) return { ok: false, why: 'not installed' };
    try {
      const f = js(), cur = read(f), b = path.join(bak, 'settings.json');
      if (cur && sha(cur) === r.after && !r.surgical) { if (r.existed) writeA(f, fs.readFileSync(b)); else fs.unlinkSync(f); }   // untouched: the file exactly as it was
      else if (cur) {
        const j = JSON.parse(cur.toString('utf8').replace(/^﻿/, ''));
        if (j.env && typeof j.env === 'object') {
          const dirs = split(j.env[VAR]).filter(d => !same(d, r.dir || modDir));
          if (dirs.length) j.env[VAR] = dirs.join(SEP); else delete j.env[VAR];
          if (!Object.keys(j.env).length) delete j.env;
        }
        writeA(f, JSON.stringify(j, null, 2) + '\n');
      }
      fs.unlinkSync(recFile);
      o.log('session rules removed');
      return { ok: true };
    } catch (e) { return { ok: false, why: e.message }; }
  }

  // at start: an installed mod is refreshed when the shipped one changed
  function sync() { if (rec()) try { copy(); } catch (e) { o.log('session rules: copy failed: ' + e.message); } }
  const status = () => { const r = rec(); return { installed: !!r, at: r ? r.at : null, dir: modDir, file: js(), list: LIST.map(([id, text]) => ({ id, text })) }; };
  return { plan, install, remove, status, sync, writeState, installed: () => !!rec() };
}
module.exports = { create, DEFAULTS, LIST };
