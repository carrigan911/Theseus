// The Claude app's own record of each Code session (%APPDATA%\Claude\claude-code-sessions\<account>\<org>\local_<id>.json)
// names the transcript it writes now (cliSessionId). A clear or a fresh conversation moves a session to a new transcript
// that has no title line yet, so the feed's title match keeps the old file: live() corrects it from the app's record.
'use strict';
const fs = require('fs');
const path = require('path');
const P = require('./paths');

const ROOT = () => path.join(process.env.APPDATA || '', 'Claude', 'claude-code-sessions');
let index = new Map(), scanned = 0;              // sessionId -> its record file
const recs = new Map();                          // record file -> { m (mtime), cli, cwd }
function scan() {
  scanned = Date.now(); const m = new Map();
  try {
    for (const a of fs.readdirSync(ROOT())) for (const o of fs.readdirSync(path.join(ROOT(), a))) {
      let names = []; try { names = fs.readdirSync(path.join(ROOT(), a, o)); } catch { continue; }
      for (const n of names) if (/^local_[\w-]+\.json$/.test(n)) m.set(n.slice(0, -5), path.join(ROOT(), a, o, n));
    }
  } catch {}
  index = m;
}
function rec(id) {
  if (!index.has(id) && Date.now() - scanned > 30000) scan();
  const f = index.get(id); if (!f) return null;
  let m; try { m = fs.statSync(f).mtimeMs; } catch { index.delete(id); return null; }
  const c = recs.get(f); if (c && c.m === m) return c;
  try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); const r = { m, cli: typeof j.cliSessionId === 'string' ? j.cliSessionId : null, cwd: typeof j.cwd === 'string' ? j.cwd : null }; recs.set(f, r); return r; }
  catch { return c || null; }   // half-written: the last good read
}
// the transcript session `id` writes now, or `file` (the feed's) when the app has no record of it
function live(id, file) {
  if (process.env.SPHERE_FEED || typeof id !== 'string' || !id.startsWith('local_')) return file;
  const r = rec(id); if (!r || !r.cli || !/^[\w-]+$/.test(r.cli)) return file;
  if (typeof file === 'string' && path.basename(file, '.jsonl') === r.cli) return file;
  const dirs = [];
  if (typeof file === 'string' && file) dirs.push(path.dirname(file));
  if (r.cwd) dirs.push(path.join(P.transcripts(), r.cwd.replace(/[^A-Za-z0-9]/g, '-')));
  for (const d of dirs) { const f = path.join(d, r.cli + '.jsonl'); if (fs.existsSync(f)) return f; }
  return file;
}
module.exports = { live };
