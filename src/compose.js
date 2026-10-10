// Session Console stage 5 (Docs/Specs/SessionConsole_Stage5_Plan.md, step 3): what the composer's "@" list offers.
// The session's folder (see cwdOf) listed from disk, shallow entries first, to depth 4 and at most
// 2000 entries, skipping .git, node_modules and what the root .gitignore names; cached for 10 s per folder. A folder is read
// entry by entry (opendir), at most 5000 a folder, so a folder of 100k files never stalls the main process.
const fs = require('fs');
const path = require('path');

const DEPTH = 4, MAX = 2000, PER_DIR = 5000, TTL = 10000, SKIP = new Set(['.git', 'node_modules', '.vs', '.idea', '__pycache__']);
const cache = new Map();   // folder -> { at, entries }

// the folder a session works in: the transcript's project folder name encodes it ("D:\\A\\B" -> "D--A-B"), so of the
// "cwd"s the transcript holds (its first MB and its last line) the one that encodes to that name wins; else the latest
const enc = d => d.replace(/[^a-zA-Z0-9]/g, '-');
function cwdOf(file) {
  const want = path.basename(path.dirname(file)), seen = [];
  try {
    const fd = fs.openSync(file, 'r'), b = Buffer.alloc(1 << 20); let n = 0;
    try { n = fs.readSync(fd, b, 0, b.length, 0); } finally { fs.closeSync(fd); }
    const re = /"cwd":("(?:[^"\\]|\\.)*")/g, t = b.toString('utf8', 0, n); let m;
    while ((m = re.exec(t))) { try { const d = JSON.parse(m[1]); if (!seen.includes(d)) seen.push(d); } catch {} }
  } catch {}
  const j = require('./detail').findLineSync(file, '"cwd":"'); if (j && typeof j.cwd === 'string') seen.push(j.cwd);
  const ok = d => { try { return !!d && path.isAbsolute(d) && fs.statSync(d).isDirectory(); } catch { return false; } };
  return seen.find(d => enc(d) === want && ok(d)) || [...seen].reverse().find(ok) || '';
}

// simple .gitignore lines (no negation) -> a test on a path relative to the root (a line ending in / names folders only)
function ignored(root) {
  let t = ''; try { t = fs.readFileSync(path.join(root, '.gitignore'), 'utf8'); } catch { return () => false; }
  const res = [];
  for (let l of t.split(/\r?\n/)) {
    l = l.trim(); if (!l || l[0] === '#' || l[0] === '!') continue;
    const dirOnly = /\/$/.test(l), anchored = l.replace(/\/$/, '').includes('/');
    l = l.replace(/^\//, '').replace(/\/\*{0,2}$/, '');
    if (!l || /[\[\]]/.test(l)) continue;
    const rx = l.split('/').map(p => p === '**' ? '.*' : p.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')).join('/');
    res.push({ dirOnly, re: new RegExp(anchored ? `^${rx}$` : `(^|/)${rx}$`, 'i') });
  }
  return (rel, dir) => res.some(r => (dir || !r.dirOnly) && r.re.test(rel));
}

// -> [{ p: 'src/main.js', d: false }] (forward slashes, folders with d: true)
async function list(root) {
  const c = cache.get(root); if (c && Date.now() - c.at < TTL) return c.entries;
  const ign = ignored(root), out = [], q = [['', 0]];
  while (q.length && out.length < MAX) {
    const [rel, depth] = q.shift();
    const ents = [];
    try { const dh = await fs.promises.opendir(rel ? path.join(root, rel) : root); for await (const e of dh) { ents.push(e); if (ents.length >= PER_DIR) break; } } catch { continue; }   // breaking out closes the folder
    ents.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of ents) {
      if (out.length >= MAX) break;
      const p = rel ? rel + '/' + e.name : e.name, d = e.isDirectory();
      if ((d && SKIP.has(e.name)) || ign(p, d)) continue;
      out.push({ p, d });
      if (d && depth + 1 < DEPTH) q.push([p, depth + 1]);
    }
  }
  cache.set(root, { at: Date.now(), entries: out });
  if (cache.size > 20) cache.delete(cache.keys().next().value);
  return out;
}

module.exports = { cwdOf, list };
