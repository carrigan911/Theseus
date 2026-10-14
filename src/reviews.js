// Land review verdicts on tiles (Docs/Specs/ReviewVerdicts_Spec.md): Titans' land_review.ps1 writes
// <repo>\Reports\LandReview\land-<branch>-<yyyyMMdd-HHmmss>.md ending in "VERDICT: PASS" or "VERDICT: FAIL". A FAIL becomes a
// card on the tile of the session working in that branch's worktree; a later PASS for the branch, or Dismiss, clears it.
//   const rv = require('./reviews').create({ dir: () => folder, stateFile, log, onChange, onFail });
//   rv.cards() -> [{ branch, file, text, advisory, counts }]; rv.dismiss(branch); rv.stop()
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const NAME = /^land-(.+)-(\d{8}-\d{6})\.md$/i;
const ADVISORY_LANDS = 10;   // land_review.ps1's AdvisoryLands: a FAIL in the first 10 reviewed lands only warns

// report file name + text -> { branch, stamp, verdict: 'PASS' | 'FAIL' | null, counts: { blocker, major, minor } } or null (not a report)
function parse(name, text) {
  const m = NAME.exec(path.basename(String(name || ''))); if (!m) return null;
  const v = [...String(text || '').matchAll(/VERDICT:\s*(PASS|FAIL)/gi)].pop();
  // findings are graded in free text, two ways: a heading of its own ("**Minor**", "## Majors (2)") over list items, each counting
  // once; or a line that starts (after list marks, a heading or bold) with its grade ("- **Blocker:** ..."). "Blockers: none" counts 0
  const counts = { blocker: 0, major: 0, minor: 0 };
  const DECO = String.raw`(?:[-*+>#|]+\s*|\d+[.)]\s*)*(?:\*\*|__|\[|\x60|\()?\s*`;
  const HEAD = new RegExp(String.raw`^\s*(?:#+\s*)?(?:\*\*|__)?\s*(blocker|major|minor)s?(?:\s+findings?)?\s*(?:\(\d+\))?\s*:?\s*(?:\*\*|__)?\s*:?\s*$`, 'i');
  const NONE = new RegExp(String.raw`^\s*` + DECO + String.raw`(blocker|major|minor)s?\b[^a-z0-9]*(?:none|0|n/a|no\b)`, 'i');
  const LEAD = new RegExp(String.raw`^\s*` + DECO + String.raw`(blocker|major|minor)\b`, 'i');
  let sec = null;
  for (const l of String(text || '').replace(/^﻿/, '').split(/\r?\n/)) {
    let g;
    if ((g = HEAD.exec(l))) { sec = g[1].toLowerCase(); continue; }
    if (NONE.test(l)) { sec = null; continue; }
    if ((g = LEAD.exec(l))) { counts[g[1].toLowerCase()]++; sec = null; continue; }
    if (sec && /^ ?(?:\d+[.)]|[-*+])\s/.test(l)) { counts[sec]++; continue; }   // a top-level item under the heading
    if (/^\s*#|^\s*(?:\*\*|__)[^*_]+(?:\*\*|__)\s*:?\s*$|^VERDICT:/i.test(l)) sec = null;   // another heading ends the section
  }
  return { branch: m[1], stamp: m[2], verdict: v ? v[1].toUpperCase() : null, counts };
}
// the card's line: "Land review failed: 2 blocker, 1 major (advisory: it landed anyway)"
function cardText(c) {
  const n = [c.counts && c.counts.blocker && `${c.counts.blocker} blocker`, c.counts && c.counts.major && `${c.counts.major} major`].filter(Boolean).join(', ');
  return `Land review failed${n ? ': ' + n : ''}${c.advisory ? ' (advisory: it landed anyway)' : ''}`;
}

function create(o) {
  const log = o.log || (() => {}), onChange = o.onChange || (() => {}), onFail = o.onFail || (() => {});
  let st = { seenUpTo: '', reviewed: 0, last: {} };
  try { const j = JSON.parse(fs.readFileSync(o.stateFile, 'utf8')); if (j && typeof j === 'object' && j.last && typeof j.last === 'object') st = { seenUpTo: String(j.seenUpTo || ''), reviewed: Number(j.reviewed) || 0, last: j.last }; } catch {}
  const fresh = !st.seenUpTo;   // the first run: reports already there are taken in silently (no card, no spoken line for old news)
  const save = () => { try { fs.writeFileSync(o.stateFile + '.tmp', JSON.stringify(st)); fs.renameSync(o.stateFile + '.tmp', o.stateFile); } catch {} };
  // Titans keeps its own count of reviewed lands next to land.ps1 (<repo>\Tools\Git\land_review_state.json): it decides "advisory"
  const titansCount = dir => { try { const n = Number(JSON.parse(fs.readFileSync(path.join(dir, '..', '..', 'Tools', 'Git', 'land_review_state.json'), 'utf8').replace(/^﻿/, '')).reviewed); return n > 0 ? n : null; } catch { return null; } };

  let w = null, armed = '', t = null, stopped = false, iv = null;
  function scan(quiet) {
    const dir = o.dir(); if (!dir) return;
    let names; try { names = fs.readdirSync(dir).filter(n => NAME.test(n)); } catch { return; }
    const todo = names.map(n => ({ n, s: NAME.exec(n)[2] })).filter(x => x.s > st.seenUpTo).sort((a, b) => a.s < b.s ? -1 : a.s > b.s ? 1 : 0);
    if (!todo.length) return;
    let changed = false;
    for (const { n, s } of todo) {
      let text = ''; try { text = fs.readFileSync(path.join(dir, n), 'utf8'); } catch { continue; }   // (still being written: the next event reads it)
      st.seenUpTo = s;
      const r = parse(n, text); if (!r) continue;
      if (!r.verdict) { log(`land review: no verdict in ${n} (a tool error)`); continue; }
      st.reviewed++;
      const count = titansCount(dir) || st.reviewed, advisory = r.verdict === 'FAIL' && count <= ADVISORY_LANDS;
      const prev = st.last[r.branch];
      st.last[r.branch] = { verdict: r.verdict, advisory, counts: r.counts, file: path.join(dir, n), at: s, dismissed: false };
      log(`land review: ${r.branch} ${r.verdict}${advisory ? ' (advisory)' : ''} ${n}`);
      if (r.verdict === 'FAIL' && !quiet) onFail({ branch: r.branch, ...st.last[r.branch], text: cardText(st.last[r.branch]) });
      if (r.verdict === 'FAIL' || (prev && prev.verdict === 'FAIL' && !prev.dismissed)) changed = true;
    }
    save(); if (changed) onChange();
  }
  const soon = () => { clearTimeout(t); t = setTimeout(() => scan(false), 1500); };   // (Titans writes its count just after the report)
  function arm() {
    const dir = o.dir();
    if (w && armed !== dir) { try { w.close(); } catch {} w = null; }
    if (stopped || w || !dir) return;
    armed = dir;
    try { w = fs.watch(dir, (_e, n) => { if (!n || NAME.test(String(n))) soon(); }); w.on('error', () => { try { w.close(); } catch {} w = null; }); } catch { w = null; }
  }
  scan(fresh); arm();
  iv = setInterval(() => { arm(); scan(false); }, 60000);   // a missed watch event, or the folder made later
  if (iv.unref) iv.unref();
  return {
    cards: () => Object.entries(st.last).filter(([, c]) => c.verdict === 'FAIL' && !c.dismissed).map(([branch, c]) => ({ branch, ...c, text: cardText(c) })),
    dismiss(branch) { const c = st.last[branch]; if (!c || c.dismissed) return false; c.dismissed = true; save(); onChange(); return true; },
    file: branch => (st.last[branch] && st.last[branch].file) || null,
    rescan: () => { arm(); scan(false); },
    stop() { stopped = true; clearTimeout(t); clearInterval(iv); if (w) try { w.close(); } catch {} },
  };
}

// the worktree that holds a branch (report names turn / and \ into -): git worktree list in the reports folder's repo -> path or ''
function worktreeOf(dir, branch) {
  return new Promise(res => {
    execFile('git', ['-c', 'safe.directory=*', 'worktree', 'list', '--porcelain'], { cwd: path.join(dir, '..', '..'), windowsHide: true, timeout: 10000 }, (e, out) => {
      if (e) return res('');
      let wt = '';
      for (const l of String(out).split(/\r?\n/)) {
        if (l.startsWith('worktree ')) wt = l.slice(9).trim();
        else if (l.startsWith('branch ') && l.slice(7).trim().replace(/^refs\/heads\//, '').replace(/[\\/]/g, '-') === branch) return res(path.normalize(wt));
      }
      res('');
    });
  });
}
// a session folder inside the worktree (case-insensitive, either slash)
const within = (dir, wt) => { if (!dir || !wt) return false; const a = path.normalize(dir).toLowerCase(), b = path.normalize(wt).toLowerCase().replace(/[\\/]+$/, ''); return a === b || a.startsWith(b + path.sep); };

module.exports = { create, parse, cardText, worktreeOf, within, ADVISORY_LANDS };
