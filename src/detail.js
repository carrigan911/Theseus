// Session Console stage 5 (Docs/Specs/SessionConsole_Stage5_Plan.md, step 1): one block of a transcript, read only when
// the console opens it: a tool's output, a turn's thinking, a subagent's steps, a pasted image. Lines are found by
// scanning the file backwards for short needles ("tool_use_id":"…" or "uuid":"…"), so a big transcript is never read whole.
// The scans read 1 MB at a time and let the main process run between reads (a 300 MB transcript never freezes the sphere).
const fs = require('fs');
const path = require('path');

const CHUNK = 1 << 20, MAX_LINE = 32 << 20, HEAD = 80, WIDE = 300, ALL = 2 << 20;
const breathe = () => new Promise(r => setImmediate(r));

// the lines holding each of `needles`, newest first, in one backward pass -> Map needle -> parsed object | 'big' (a line
// over 32 MB); needles not found are missing from the map
async function findLines(file, needles) {
  const fh = await fs.promises.open(file, 'r'), found = new Map(), left = new Set(needles);
  try {
    const size = (await fh.stat()).size, pad = Math.max(...needles.map(n => Buffer.byteLength(n))), buf = Buffer.alloc(CHUNK + pad);
    for (let end = size; end > 0 && left.size;) {
      const start = Math.max(0, end - CHUNK), want = Math.min(size, end + pad) - start;
      const { bytesRead: len } = await fh.read(buf, 0, want, start), view = buf.subarray(0, len);
      for (const n of [...left]) {
        const at = view.lastIndexOf(Buffer.from(n)); if (at < 0) continue;
        left.delete(n); const j = await lineAt(fh, size, start + at); if (j !== null) found.set(n, j);
      }
      end = start; await breathe();
    }
    return found;
  } finally { await fh.close(); }
}
const findLine = async (file, needle) => (await findLines(file, [needle])).get(needle) || null;
// the line around byte `off`: back to the newline before it, on to the one after it -> parsed, 'big', or null
async function lineAt(fh, size, off) {
  const step = 1 << 16, b = Buffer.alloc(step);
  let a = off;
  while (a > 0) { const s = Math.max(0, a - step), { bytesRead: n } = await fh.read(b, 0, a - s, s); const k = b.subarray(0, n).lastIndexOf(10); if (k >= 0) { a = s + k + 1; break; } a = s; if (off - a > MAX_LINE) return 'big'; }
  let z = off;
  while (z < size) { const { bytesRead: n } = await fh.read(b, 0, Math.min(step, size - z), z); if (!n) break; const k = b.subarray(0, n).indexOf(10); if (k >= 0) { z += k; break; } z += n; if (z - a > MAX_LINE) return 'big'; }
  const out = Buffer.alloc(z - a), { bytesRead } = await fh.read(out, 0, out.length, a);
  try { return JSON.parse(out.toString('utf8', 0, bytesRead)); } catch { return null; }
}
// the same backward search, synchronous, for one needle near the end (compose.cwdOf: the newest "cwd")
function findLineSync(file, needle) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, nb = Buffer.from(needle), buf = Buffer.alloc(CHUNK + nb.length);
    for (let end = size, n = 0; end > 0 && n < 8; n++) {   // the last 8 MB at most
      const start = Math.max(0, end - CHUNK), len = fs.readSync(fd, buf, 0, Math.min(size, end + nb.length) - start, start);
      const at = buf.subarray(0, len).lastIndexOf(nb);
      if (at >= 0) {
        let a = buf.subarray(0, at).lastIndexOf(10) + 1, z = buf.subarray(0, len).indexOf(10, at); if (z < 0) z = len;
        if (a === 0 && start > 0) return null;   // the line starts in an earlier chunk: too long for this quick look
        try { return JSON.parse(buf.toString('utf8', a, z)); } catch { return null; }
      }
      end = start;
    }
    return null;
  } finally { fs.closeSync(fd); }
}
const blocks = j => (j && j.message && Array.isArray(j.message.content) ? j.message.content : []);
const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => x && x.type === 'text' ? x.text : x && x.type === 'image' ? '[image]' : '').filter(Boolean).join('\n') : '';
// the session's own folder next to its transcript (subagents/, tool-results/)
const dirOf = file => file.replace(/\.jsonl$/i, '');

// a tool's output -> { ok, lines, err, more, total } (first HEAD lines unless all; WIDE characters a line)
async function output(file, toolId, all) {
  const j = await findLine(file, `"tool_use_id":"${toolId}"`);
  if (j === 'big') return { ok: false, why: 'the output is too large to show (over 32 MB)' };
  const b = blocks(j).find(x => x && x.type === 'tool_result' && x.tool_use_id === toolId);
  if (!b) return { ok: false, why: 'no result yet' };
  let text = textOf(b.content);
  const saved = /Full output saved to: (.+?\.txt)\s/.exec(text + '\n');
  if (all && saved) {   // the full output the app kept on disk (only inside this session's tool-results; its first 2 MB)
    const p = path.resolve(saved[1].trim()), dir = path.resolve(dirOf(file), 'tool-results') + path.sep;
    if (p.toLowerCase().startsWith(dir.toLowerCase())) try {
      const fh = await fs.promises.open(p, 'r'), buf = Buffer.alloc(ALL);
      try { const { bytesRead } = await fh.read(buf, 0, ALL, 0); text = buf.toString('utf8', 0, bytesRead); } finally { await fh.close(); }
    } catch {}
  }
  let L = text.replace(/\r\n?/g, '\n').split('\n');
  const total = L.length, more = !all && (total > HEAD || !!saved);
  if (!all) L = L.slice(0, HEAD); else L = L.slice(0, 20000);
  return { ok: true, err: !!b.is_error, more, total, lines: L.map(x => x.length > WIDE ? x.slice(0, WIDE) + '…' : x) };
}

// a turn's thinking: refs [{ line, k }] -> { ok, text } (all refs in one pass)
async function thinking(file, refs) {
  const rs = (refs || []).slice(0, 20), got = await findLines(file, [...new Set(rs.map(r => `"uuid":"${r.line}"`))]), parts = [];
  for (const r of rs) {
    const b = blocks(got.get(`"uuid":"${r.line}"`))[r.k];
    if (b && b.type === 'thinking' && b.thinking) parts.push(String(b.thinking).trim());
  }
  const text = parts.join('\n\n').slice(0, 60000);
  return text ? { ok: true, text } : { ok: false, why: 'no thinking text' };
}

// a subagent's steps: the Agent tool_use id -> { ok, msgs } (its own transcript, parsed like the session's)
async function agent(file, toolId) {
  const dir = path.join(dirOf(file), 'subagents');
  let names = []; try { names = (await fs.promises.readdir(dir)).filter(f => f.endsWith('.meta.json')); } catch { return { ok: false, why: 'no subagent transcripts' }; }
  for (const m of names) {
    let meta; try { meta = JSON.parse(await fs.promises.readFile(path.join(dir, m), 'utf8')); } catch { continue; }
    if (!meta || meta.toolUseId !== toolId) continue;
    const f = path.join(dir, m.replace(/\.meta\.json$/, '.jsonl'));
    let t; try { const st = await fs.promises.stat(f); if (st.size > 64 << 20) return { ok: false, why: 'too large' }; t = await fs.promises.readFile(f, 'utf8'); } catch { return { ok: false, why: 'unreadable' }; }
    const msgs = require('./transcript').parse(t, { sidechain: true }).filter(x => x.role !== 'user').slice(-200);
    return { ok: true, type: String(meta.agentType || ''), msgs: msgs.map(x => ({ role: x.role, text: x.text })) };
  }
  return { ok: false, why: 'its transcript was not found' };
}

// a pasted image: { line, k } -> { ok, mime, data (base64) }
async function image(file, line, k) {
  const b = blocks(await findLine(file, `"uuid":"${line}"`))[k];
  const s = b && b.type === 'image' && b.source;
  if (!s || s.type !== 'base64' || typeof s.data !== 'string' || s.data.length > 20 << 20) return { ok: false, why: 'no image' };
  if (!/^image\/(png|jpeg|gif|webp)$/.test(s.media_type)) return { ok: false, why: 'unknown image type' };
  return { ok: true, mime: s.media_type, data: s.data };
}

module.exports = { output, thinking, agent, image, findLine, findLines, findLineSync };
