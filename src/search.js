// Search across sessions (SessionConsole_Stage5 step 6): which conversations contain a text, with a short snippet per hit.
// Each transcript is read in 1 MB chunks (the main process yields between chunks, so the sphere keeps drawing); a raw-text
// check picks the lines worth parsing, and only your messages and Claude's replies count (not tool input or output).
// At most 3 hits per session (the newest) and 50 in all; the whole search stops after 3 s. A newer search cancels this one.
const fs = require('fs');
const { parse } = require('./transcript');

const CHUNK = 1 << 20, PER = 3, ALL = 50, TIME = 3000;
let gen = 0;

const flat = t => String(t).replace(/\s+/g, ' ').trim();
// [before, match, after] around the match, about 50 characters before and 90 after
function snippet(text, at, len) {
  const t = String(text), a = Math.max(0, at - 50), b = Math.min(t.length, at + len + 90), sp = s => s.replace(/\s+/g, ' ');
  return [(a > 0 ? '…' : '') + sp(t.slice(a, at)).trimStart(), sp(t.slice(at, at + len)), sp(t.slice(at + len, b)).trimEnd() + (b < t.length ? '…' : '')];
}

// opts (new ideas 3): who 'user' | 'assistant' (one side only), since (ms: messages from then on); both checked before the caps
// sessions: [{ sessionId, title, file }] -> { ok, hits: [{ sessionId, title, uuid, role, ts, off, snippet: [before, match, after] }], done, ms }
// (off = the byte where the hit's transcript line starts)
async function search(sessions, query, opts = {}) {
  const my = ++gen, t0 = Date.now(), q = flat(query).toLowerCase();
  if (q.length < 2) return { ok: false, why: 'type at least 2 characters' };
  // the longest piece with nothing JSON escapes: the raw-text check (the match itself is checked on the parsed text)
  const probe = q.split(/["\\]/).sort((a, b) => b.length - a.length)[0].split(' ').sort((a, b) => b.length - a.length)[0];
  // ASCII: a lower-cased latin1 view of the bytes (one character per byte, so offsets stay byte offsets); else the lower-cased
  // UTF-8 text, with byte offsets counted up to each hit
  const wide = /[^\x00-\x7f]/.test(probe);
  if (!probe) return { ok: false, why: 'nothing to look for' };
  const list = sessions.map(s => { let m = 0; try { m = fs.statSync(s.file).mtimeMs; } catch { m = -1; } return { ...s, m }; }).filter(s => s.m >= 0 && !(opts.since && s.m < opts.since)).sort((a, b) => b.m - a.m);
  const hits = []; let done = true;
  outer: for (const s of list) {
    let fd; try { fd = fs.openSync(s.file, 'r'); } catch { continue; }
    try {
      const size = fs.fstatSync(fd).size, mine = [];
      let pos = 0, carry = Buffer.alloc(0), carryAt = 0;
      while (pos < size) {
        if (my !== gen) return { ok: false, why: 'cancelled' };
        if (Date.now() - t0 > TIME) { done = false; break outer; }
        const b = Buffer.alloc(Math.min(CHUNK, size - pos)), n = fs.readSync(fd, b, 0, b.length, pos);
        if (n <= 0) break;
        const buf = carry.length ? Buffer.concat([carry, b.subarray(0, n)]) : b.subarray(0, n), base = carry.length ? carryAt : pos;
        pos += n;
        const cut = pos < size ? buf.lastIndexOf(10) : buf.length;
        if (cut < 0) { carry = buf; carryAt = base; continue; }
        carry = Buffer.from(buf.subarray(cut + 1)); carryAt = base + cut + 1;
        const body = buf.subarray(0, cut), raw = wide ? body.toString('utf8') : null, low = wide ? raw.replace(/İ/g, 'I').toLowerCase() : body.toString('latin1').toLowerCase();   // İ is the one letter whose lower case is longer: kept one unit, so indices match raw
        let i = low.indexOf(probe), bAt = 0, bOff = 0;   // wide: bytes up to character bAt
        while (i >= 0) {
          const ls = low.lastIndexOf('\n', i) + 1, le = low.indexOf('\n', i), end = le < 0 ? low.length : le;
          const line = wide ? raw.slice(ls, end) : body.subarray(ls, end).toString('utf8');
          if (wide) { bOff += Buffer.byteLength(raw.slice(bAt, ls)); bAt = ls; }
          const lineAt = base + (wide ? bOff : ls);
          if (line.startsWith('{"') || line.startsWith('{ "')) for (const m of parse(line, { keepSide: false })) {
            if (m.role !== 'user' && m.role !== 'assistant') continue;
            if (opts.who && m.role !== opts.who) continue;
            if (opts.since) { const t = typeof m.ts === 'number' ? m.ts : Date.parse(m.ts); if (!(t >= opts.since)) continue; }
            const ft = flat(m.text), at = ft.toLowerCase().indexOf(q); if (at < 0) continue;
            mine.push({ sessionId: s.sessionId, title: s.title, uuid: m.uuid, role: m.role, ts: m.ts, off: lineAt, snippet: snippet(ft, at, q.length) });
            if (mine.length > PER) mine.shift();   // keep the newest
            break;
          }
          i = low.indexOf(probe, end + 1);
        }
        await new Promise(r => setImmediate(r));
      }
      hits.push(...mine.reverse());
      if (hits.length >= ALL) { hits.length = ALL; done = false; break; }
    } finally { try { fs.closeSync(fd); } catch {} }
  }
  return { ok: true, hits, done, ms: Date.now() - t0 };
}

// the messages around byte `off` of a transcript (a hit older than what the console holds): ~96 KB before, ~160 KB after
function around(file, off) {
  const size = fs.statSync(file).size; off = Math.max(0, Math.min(size, Math.floor(off)));
  const a = Math.max(0, off - (96 << 10)), b = Math.min(size, off + (160 << 10));
  const fd = fs.openSync(file, 'r'), buf = Buffer.alloc(b - a);
  try { fs.readSync(fd, buf, 0, buf.length, a); } finally { fs.closeSync(fd); }
  let s = buf.toString('utf8');
  if (a > 0) s = s.slice(s.indexOf('\n') + 1);       // starts mid-line
  if (b < size) s = s.slice(0, s.lastIndexOf('\n'));  // ends mid-line
  return parse(s);
}

module.exports = { search, around, cancel: () => { gen++; } };
