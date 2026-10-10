// Live state of a session from the tail of its transcript .jsonl: context size (last assistant "usage" line) and activity
// (working / waiting on the user / idle, Docs/Specs/WorkingTiles_Spec.md).
// Cached by mtime + size, so an unchanged transcript costs one stat; the tail starts small and grows only when it holds no answer.
const fs = require('fs');
const RX = /"input_tokens":(\d+),"cache_creation_input_tokens":(\d+),"cache_read_input_tokens":(\d+)/g;
const TAILS = [65536, 1048576];
const STALE_MS = 15 * 60000;                 // working with no write for this long = stopped, interrupted or crashed
const ASK = new Set(['AskUserQuestion', 'ExitPlanMode']);
const cache = new Map();   // file -> { m, size, tokens, act, tool } (tool: the last line is a tool call with no result yet)

// the activity a transcript line decides, or undefined when the line says nothing (attachments, meta, bookkeeping)
function lineAct(line) {
  if (!line.startsWith('{"') && !line.startsWith('{')) return undefined;
  let j; try { j = JSON.parse(line); } catch { return undefined; }
  if (j.isMeta || (j.type !== 'user' && j.type !== 'assistant')) return undefined;
  const m = j.message || {}, c = Array.isArray(m.content) ? m.content : [{ type: 'text', text: typeof m.content === 'string' ? m.content : '' }];
  if (j.type === 'user') {
    const t = c.find(x => x && x.type === 'text');
    return t && /^\[Request interrupted/.test(t.text || '') ? 'idle' : 'working';
  }
  if (c.some(x => x && x.type === 'tool_use' && ASK.has(x.name))) return 'waiting';
  if (c.some(x => x && x.type === 'tool_use')) return 'tool';   // read() keeps it as working + tool
  if (m.stop_reason === 'end_turn' || m.stop_reason === 'stop_sequence' || m.stop_reason === 'max_tokens') {
    const t = c.filter(x => x && x.type === 'text').pop(), last = t ? String(t.text).trim().split('\n').pop().trim() : '';
    return /\?\W{0,3}$/.test(last) ? 'waiting' : 'idle';
  }
  return 'working';
}

function read(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const st = fs.fstatSync(fd), c = cache.get(file);
    if (c && c.m === st.mtimeMs && c.size === st.size) return c;
    let tokens, act;
    for (const cap of TAILS) {
      const len = Math.min(st.size, cap);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      const s = buf.toString('utf8');
      if (tokens === undefined) {
        const rx = new RegExp(RX.source, 'g'); let m, last = null;
        while ((m = rx.exec(s))) last = m;
        if (last) tokens = Number(last[1]) + Number(last[2]) + Number(last[3]);
      }
      if (act === undefined) {
        const lines = s.split('\n'); if (len < st.size) lines.shift();          // the first line of a partial tail is cut
        for (let i = lines.length - 1; i >= 0 && act === undefined; i--) act = lineAct(lines[i].trim());
      }
      if ((tokens !== undefined && act !== undefined) || len >= st.size) break;
    }
    // nothing readable in the last window: the newest line is bigger than it (a large tool result), so the model is working on it
    if (act === undefined && st.size > TAILS[TAILS.length - 1]) act = 'working';
    const e = { m: st.mtimeMs, size: st.size, tokens: tokens === undefined ? null : tokens, act: act === 'tool' ? 'working' : act || 'idle', tool: act === 'tool' };
    cache.set(file, e);
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    return e;
  } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

function contextTokens(file) { const e = read(file); return e ? e.tokens : null; }
// 'working' | 'waiting' | 'idle', or null when the transcript cannot be read
function activity(file) {
  const e = read(file); if (!e) return null;
  return e.act === 'working' && Date.now() - e.m > STALE_MS ? 'idle' : e.act;
}
// a tool call open for over 2 s with nothing written since: a permission request or a slow tool (the sidebar tells which)
function toolWait(file) {
  const e = read(file); if (!e || !e.tool) return false;
  const age = Date.now() - e.m; return age > 2000 && age < STALE_MS;
}
module.exports = { contextTokens, activity, toolWait };
